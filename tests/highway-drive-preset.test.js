'use strict';

// 无尽公路 Highway Drive：编号 13，自绘第一人称公路场景，八个频段驱动。
// 移植自上游 PR #434，编号按本仓库现状重排：上游用 9，本仓库 9~12 已被 premium 预设占用。
// 判据分四层：数值边界、确定性、音频映射、接线与资源。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const source = read('public', 'highway-drive-preset.js');
const loader = read('public', 'js', 'index-loader.js');
const core = read('public', 'js', 'modules', '00-state', '00-core-stores.js');
const presets = read('public', 'js', 'modules', '07-fx', '00-preset-archive-data.js');
const presetGrid = read('public', 'js', 'modules', '07-fx', '04-preset-grid-uniforms.js');
const mainLoop = read('public', 'js', 'modules', '11-main-loop.js');
const shelfManager = read('public', 'js', 'modules', '04-shelf', '01-manager-core.js');
const planetAssetDir = path.join(root, 'public', 'assets', 'highway-planets');
const planetAssetNames = ['moon.jpg', 'mars.jpg', 'jupiter.jpg', 'saturn.jpg', 'saturn-ring.png', 'neptune.jpg', 'venus.jpg', 'mercury.jpg'];

const context = { window: {} };
vm.runInNewContext(source, context, { filename: 'highway-drive-preset.js' });
const runtime = context.window.MineradioHighwayDrive;
assert(runtime, '无尽公路运行时必须注册到全局');
assert.strictEqual(runtime.INDEX, 13, '无尽公路必须占用预设 13，不能与 9~12 的 premium 预设撞号');

const api = runtime._test;

// 一、预算：所有几何与粒子池必须有上界，这个预设会在低端机上跑。
assert.strictEqual(api.constants.bandCount, 8, '路面必须吃满八个频段');
assert.strictEqual(api.constants.spectrumSampleCount, api.constants.segmentCount + 1, '频谱历史必须覆盖每一行深度且不无界增长');
assert(api.constants.segmentCount <= 128, '路面网格必须有上界');
assert((api.constants.segmentCount + 1) * api.constants.columnCount <= 2200, '路面顶点预算必须有上界');
assert(api.constants.lightPairCount <= 32, '路灯实例预算必须有上界');
assert(api.constants.terrainPointCount <= 20000, '地形粒子池必须有上界');
assert(api.constants.floraPointCount <= 800, '植被粒子池必须有上界');
assert(api.constants.moteCount <= 320, '浮尘粒子池必须有上界');
assert(api.constants.groundDustCount <= 8000, '地面尘埃粒子池必须有上界');
assert(api.constants.gatePointCount <= 280, '路标粒子池必须有上界');
assert(api.constants.precipitationCount <= 512, '雨雪必须共用一份有界粒子池');
assert(api.constants.maxCameraRoll <= 0.015, '相机侧倾必须低于晕动症阈值');
assert(api.constants.cameraRollResponse <= 1.5, '侧倾要缓入，不能跟着弯道瞬间甩');
assert.deepStrictEqual(Array.from(api.constants.biomeNames), ['mountains', 'river', 'hills', 'desert', 'beach', 'grassland'], '六种自然地貌必须齐全');
assert.deepStrictEqual(Array.from(api.constants.weatherNames), ['clear-day', 'golden-hour', 'rain', 'snow', 'starry-night', 'aurora'], '天空循环必须覆盖白天到极光');
assert.deepStrictEqual(Array.from(api.constants.celestialNames), ['moon', 'mars', 'jupiter', 'saturn', 'neptune', 'venus', 'mercury'], '夜空要轮换七颗可辨认天体');
assert(api.constants.landmarkNames.length >= 8 && api.constants.landmarkNames.length <= 10, '地标系列要有变化但有界');
assert(api.constants.landmarkNames.includes('Eiffel Tower') && api.constants.landmarkNames.includes('Taj Mahal'), '必须包含可辨认的地标');
assert.strictEqual(api.constants.trackLaneCount, 4, '节拍方块必须对齐四条车道');
assert.strictEqual(api.constants.trackMinEventGap, 0.12, '观测谱面必须使用硬模式最小间隔');
assert.strictEqual(api.constants.trackOnsetThreshold, 0.15, '观测谱面必须保留硬模式起音灵敏度');
assert.deepStrictEqual(Array.from(api.constants.trackLaneBands, bands => Array.from(bands)), [[0, 4], [2, 6], [3, 7], [1, 5]], '八个频段要分到四条空间分布的车道');

// 二、车道与频谱映射。
assert.strictEqual(api.roadTrackLaneForBand(0), 0, '超低频走最左车道');
assert.strictEqual(api.roadTrackLaneForBand(1), 3, '低频走最右车道');
assert.strictEqual(api.roadTrackLaneForBand(2), 1, '中低频占内侧车道');
assert.strictEqual(api.roadTrackLaneForBand(3), 2, '中频占另一条内侧车道');
assert(api.roadTrackLaneCenter(0) < -0.6 && api.roadTrackLaneCenter(3) > 0.6, '外侧车道要覆盖大部分路宽');
assert.strictEqual(api.roadTrackLaneForSide(-0.67), 0, '左侧路面必须解析到第一条车道');
assert.strictEqual(api.roadTrackLaneForSide(0.67), 3, '右侧路面必须解析到第四条车道');
assert.strictEqual(api.roadBandForSide(0), 0, '原始路面响应要保留中心低频');
assert.strictEqual(api.roadBandForSide(1), 7, '原始路面响应要保留两侧高频');
assert.strictEqual(api.spectrumHistorySlotForRow(api.constants.segmentCount, 27), 27, '最新频谱样本进地平线');
assert.strictEqual(api.spectrumHistorySlotForRow(api.constants.segmentCount - 1, 27), 26, '旧样本逐行推向相机');
assert(api.spectrumPulseForBand(0.82, 0.18, 6, 0, 0) > 0.95, '突兀的高频起音必须形成可见的波峰');
assert(api.spectrumPulseForBand(0.30, 0.30, 0, 0.9, 0.6) > api.spectrumPulseForBand(0.30, 0.30, 7, 0.9, 0.6), '鼓点要更偏向中心低频车道');

// 三、谱面生成：一次起音只出一个音符，不能整行刷满。
const isolatedOnset = api.rhythmTrackEventFrame([0.22, 0.24, 0.25, 0.28, 0.30, 0.31, 0.92, 0.24], [0.22, 0.24, 0.25, 0.28, 0.30, 0.31, 0.12, 0.24], [0, 0, 0, 0], 0.8, 0.9, 0, -1);
assert.strictEqual(isolatedOnset.eventLanes.length, 1, '一次普通节拍只出一个音符');
assert.strictEqual(isolatedOnset.pulses.filter(value => value > 0.68).length, 1, '一个音符只能有一个亮点');

let chartEventIndex = 0;
let chartLastLane = -1;
const visitedTapLanes = new Set();
for (let event = 0; event < 8; event += 1) {
  const frame = api.rhythmTrackEventFrame([0.34, 0.32, 0.30, 0.28, 0.26, 0.24, 0.22, 0.20], [0.34, 0.32, 0.30, 0.28, 0.26, 0.24, 0.22, 0.20], [0, 0, 0, 0], 1, 1, chartEventIndex, chartLastLane);
  assert(frame.eventLanes.length >= 1 && frame.eventLanes.length <= api.constants.trackMaxEventLanes, '自动谱面事件只能是一个音符或受限的双音');
  frame.eventLanes.forEach(lane => visitedTapLanes.add(lane));
  chartEventIndex = frame.nextEventIndex;
  chartLastLane = frame.lastLane;
}
assert.strictEqual(visitedTapLanes.size, 4, '自动音符要随时间走遍四条车道');

const sustainedTrail = api.rhythmTrackEventFrame([0, 0, 0, 0, 0, 0.58, 0, 0], [0, 0, 0, 0, 0, 0.58, 0, 0], [0, 0, 0, 0.90], 0, 0, 4, 3);
assert(sustainedTrail.pulses[3] > 0 && sustainedTrail.pulses[3] < 0.90, '持续音要在音头后面留一段衰减排块');
assert.strictEqual(sustainedTrail.eventLanes.length, 0, '尾音不得在没有新节拍时再出一个音符');

let cueAge = 0;
let cueCooldown = 0;
let previousCueBeat = 0;
let previousCueTrigger = 0;
let previousCueBands = [0, 0, 0, 0, 0, 0, 0, 0];
const steadyCueTimes = [];
for (let frame = 0; frame < 240; frame += 1) {
  const cueAudio = { bands: [0.42, 0.39, 0.36, 0.34, 0.31, 0.29, 0.26, 0.24], energy: 0.55, beat: 0.12, trigger: 0.08 };
  const cue = api.rhythmChartCueFrame(cueAudio, previousCueBands, previousCueBeat, previousCueTrigger, cueAge, cueCooldown, 1 / 60);
  cueAge = cue.cueAge;
  cueCooldown = cue.cooldown;
  previousCueBeat = cueAudio.beat;
  previousCueTrigger = cueAudio.trigger;
  previousCueBands = cueAudio.bands.slice();
  if (cue.emitted) steadyCueTimes.push(frame / 60);
}
assert(steadyCueTimes.length >= 7, '平稳音乐里兜底谱面也要继续出音符，不能只在开头响一次');
assert(steadyCueTimes.at(-1) > 3, '自动音符要延续到采样窗口后段');
for (let index = 1; index < steadyCueTimes.length; index += 1) {
  assert(steadyCueTimes[index] - steadyCueTimes[index - 1] >= api.constants.trackMinEventGap - 1 / 60, '密集兜底音符仍要守最小间隔');
}

// 四、确定性：同一个种子必须生成同一条路。
const seed = 314.159;
const firstRun = [];
const secondRun = [];
let leftTurns = 0;
let rightTurns = 0;
let last = api.roadCenterAt(0, seed);
let maxCurveStep = 0;
let maxCurveAcceleration = 0;
let previous = last;
for (let distance = 0; distance <= 1200; distance += 12) {
  const value = api.roadCenterAt(distance, seed);
  const repeated = api.roadCenterAt(distance, seed);
  assert(Number.isFinite(value), '路面曲线必须有限');
  maxCurveStep = Math.max(maxCurveStep, Math.abs(value - last));
  if (distance >= 24) maxCurveAcceleration = Math.max(maxCurveAcceleration, Math.abs(value - 2 * last + previous));
  if (value > last + 0.08) rightTurns += 1;
  if (value < last - 0.08) leftTurns += 1;
  firstRun.push(value);
  secondRun.push(repeated);
  previous = last;
  last = value;
}
assert.deepStrictEqual(firstRun, secondRun, '种子必须可复现');
assert(leftTurns > 8 && rightTurns > 8, '公路必须左右都弯');
assert(maxCurveStep < 3.2, '横向位移要宽缓');
assert(maxCurveAcceleration < 1.2, '方向变化不得来回抖');

// 五、地貌与天气推进。
for (let zone = 0; zone < api.constants.biomeNames.length; zone += 1) {
  assert.strictEqual(api.biomeIndexAtDistance(zone * api.constants.biomeZoneLength, 0), zone, '自然分区必须按序推进');
}
const biomeTransitionDistance = api.constants.biomeZoneLength * (1 + api.constants.weatherTransitionStart + 0.12);
const transitioningBiome = api.biomeStateAtDistance(biomeTransitionDistance, 0);
assert.strictEqual(transitioningBiome.name, 'river', '过渡期要保留当前地貌');
assert.strictEqual(transitioningBiome.nextName, 'hills', '过渡期要准备下一段地貌');
assert(transitioningBiome.blend > 0 && transitioningBiome.blend < 1, '地貌必须交叉淡入');
[{ zone: 0, name: 'snow' }, { zone: 1, name: 'rain' }, { zone: 2, name: 'clear-day' }, { zone: 3, name: 'golden-hour' }, { zone: 5, name: 'starry-night' }, { zone: 6, name: 'aurora' }].forEach(sample => {
  const weather = api.weatherStateAtDistance(sample.zone * api.constants.biomeZoneLength, 0);
  assert.strictEqual(weather.name, sample.name, '天气分区 ' + sample.zone + ' 必须是 ' + sample.name);
  assert.strictEqual(weather.blend, 0, '天气分区起始不得带残留过渡');
});
const transitioningWeather = api.weatherStateAtDistance(biomeTransitionDistance, 0);
const nextWeather = api.weatherStateAtDistance(api.constants.biomeZoneLength * 2, 0);
assert(transitioningWeather.blend > 0 && transitioningWeather.blend < 1, '天气也要交叉淡入');
assert.strictEqual(transitioningBiome.blend, transitioningWeather.blend, '地貌与天空过渡必须共用同一进度');
assert.strictEqual(transitioningWeather.nextName, nextWeather.name, '天气过渡必须连续接上下一段');
for (let landmark = 0; landmark < api.constants.landmarkNames.length; landmark += 1) {
  assert.strictEqual(api.landmarkIndexAtDistance(landmark * api.constants.landmarkSpacing), landmark, '地标必须按序推进');
}

// 六、夜空：七颗天体轮换，位置稳定且不挡视线中心。
const celestialNightZones = [5, 6, 11, 17, 18, 23, 29];
const celestialTour = celestialNightZones.map(zone => api.celestialIndexForZone(zone, 0));
assert.strictEqual(new Set(celestialTour).size, api.constants.celestialNames.length, '七个夜晚分区必须覆盖全部天体且不重复');
const celestialPositions = celestialNightZones.map(zone => api.celestialPositionForZone(zone, 0));
assert.strictEqual(new Set(celestialPositions.map(position => position.side)).size, 2, '天体要分布在左右两侧');
celestialPositions.forEach(position => {
  assert(Math.abs(position.x) >= 17.5 && Math.abs(position.x) <= 21, '天体横向位置要避开灭点与窄屏边缘');
  assert(position.y >= 17 && position.y <= 20.5, '天体高度要留在可见天空内');
  assert(position.z >= -80 && position.z <= -74, '天体景深要可辨认又不抢戏');
});
const repeatedCelestialPosition = api.celestialPositionForZone(11, 0);
assert.deepStrictEqual([repeatedCelestialPosition.x, repeatedCelestialPosition.y, repeatedCelestialPosition.z, repeatedCelestialPosition.side], [celestialPositions[2].x, celestialPositions[2].y, celestialPositions[2].z, celestialPositions[2].side], '同一夜晚分区内天体位置必须稳定');
const celestialTilts = celestialNightZones.map((zone, index) => api.celestialAxialTiltForZone(zone, celestialTour[index], 0));
celestialTilts.forEach(tilt => {
  assert(tilt.angle >= 0.025 && tilt.angle <= 0.62, '轴倾角要可信且可见');
  assert(tilt.azimuth >= 0 && tilt.azimuth <= Math.PI * 2, '自转轴方向要覆盖整圈');
  assert(Math.abs(Math.hypot(tilt.x, tilt.z) - tilt.angle) < 1e-9, '轴倾向量必须保持给定角度');
});
assert(new Set(celestialTilts.map(tilt => tilt.azimuth.toFixed(3))).size >= 5, '各行星自转轴不能全朝一边歪');
assert.strictEqual(api.constants.celestialNames[api.celestialIndexForZone(5, 0)], 'saturn', '第一个星空分区要出现带环的土星');

// 七、回收：路标必须在真正掠过相机后才循环。
const landmarkBeforePass = api.recycledWorldPlacement(0, api.constants.landmarkSpacing, api.constants.landmarkNames.length, 58, 69.9, api.constants.landmarkPassDistance);
const landmarkAfterPass = api.recycledWorldPlacement(0, api.constants.landmarkSpacing, api.constants.landmarkNames.length, 58, 70.1, api.constants.landmarkPassDistance);
assert(landmarkBeforePass.ahead < 0, '地标要先真正掠过相机');
assert.strictEqual(landmarkBeforePass.worldDistance, 58, '地标在路边时就被回收了');
assert(landmarkAfterPass.worldDistance > landmarkBeforePass.worldDistance, '地标必须过屏蔽距离后才回收');

// 八、音频映射与速度。
const detailed = api.readAudio({ sonicDetailed: true, subBass: 0.9, bass: 0.8, lowMid: 0.7, mid: 0.6, highMid: 0.5, presence: 0.4, brilliance: 0.3, air: 0.2, energy: 0.75, kickEnvelope: 0.82, triggerPulse: 0.94 });
assert.deepStrictEqual(Array.from(detailed.bands), [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2], '八个频段必须按序透传');
assert(detailed.trigger >= 0.94, '共享起音脉冲必须传到路面');
const idleSpeed = api.targetRoadSpeed({ energy: 0 }, { speed: 1 }, 0, 0, 0);
const beatSpeed = api.targetRoadSpeed({ energy: 0.8 }, { speed: 1 }, 0.85, 0.9, 0.9);
assert(beatSpeed > idleSpeed + 20, '强节拍必须带来可感知的提速');

// 九、接线：任何一处漏登记都不会报错，只会「什么都不发生」。
assert(loader.includes("'highway-drive-preset.js'"), 'index-loader 必须登记无尽公路');
assert(/MAX_VISUAL_PRESET_INDEX = 13/.test(core) && /HIGHWAY_PRESET_INDEX = 13/.test(core), '预设 13 必须能通过启动与存档夹取');
assert(presets.includes("name: '无尽公路'") && presets.includes('作者 <span class="pc-author-cyberforker">Cyberforker</span>'), '预设卡片必须署名 Cyberforker');
assert(/presetDisplayOrder = \[0, 9, 10, 11, 12, 6, 7, 8, 13, 5, 4, 2, 1, 3\]/.test(presets), '无尽公路卡片要排在音域回响之后');
assert(/MineradioHighwayDrive\.onPresetChange/.test(presetGrid), '切换预设必须通知无尽公路运行时');
assert(/MineradioHighwayDrive\.update/.test(mainLoop) && /visual\.highway-drive/.test(mainLoop), '主循环必须驱动并计量无尽公路');
assert(/audio: sonicAudioFrame \|\|/.test(mainLoop), '无尽公路必须收到共享实时频谱帧，而不是只有聚合能量');
assert(/!highwayPresetActiveEarly/.test(mainLoop), '无尽公路激活时基础封面粒子必须隐藏');
assert(/setVisualSuppressed\(highwayPresetActiveEarly\)/.test(mainLoop) && /setVisualSuppressed: function/.test(shelfManager), '无尽公路必须在不改动存档里的歌单架模式的前提下让架体让位');
assert(/syncShelfSuppression\(active\)/.test(source), '后续场景更新后仍要保持歌单架隐藏');

// 十、造型与资源边界：整场景只有点云和着色器，不允许任何低模实体。
assert(!/InstancedMesh|BoxGeometry|ConeGeometry|CylinderGeometry/.test(source), '场景不得再出现立方体、锥体、圆柱这类低模实体');
assert(/highway-particles-terrain/.test(source) && /highway-particles-flora/.test(source), '地形与植被必须是点云');
assert(/highway-particles-gate-/.test(source), '路标必须是粒子拱门而不是建筑模型');
assert(/gl_PointSize/.test(source) && /AdditiveBlending/.test(source), '粒子必须按深度衰减并叠加发光');
assert(/uFogNear/.test(source) && /uFogFar/.test(source), '粒子必须自带深度雾，远处不能硬切');
assert(/uPixelRatio/.test(source) && /renderer\.getPixelRatio/.test(source), '粒子尺寸必须跟随渲染像素比，高分屏才不会缩成一片');
assert(/highway-dynamic-sky/.test(source) && /new THREE\.Points/.test(source), '天气要用一份程序化天空与一份共享降水粒子');
assert(/syncBiomeTransition\(state\.travel \+ ROAD_LENGTH \* 0\.34\)/.test(source), '路边配色必须与天空使用同一份过渡进度');
assert(/aBandPulse/.test(source) && /advanceSpectrumHistory\(state\.speed \* dt\)/.test(source), '路面波纹必须把起音从地平线推向相机');
assert(/aTrackPulse/.test(source) && /trackPulseHistory/.test(source), '四车道音符要用独立历史，不能顶掉原始路面律动');
assert(/rhythmTrackEventFrame/.test(source) && /ROAD_TRACK_LANE_SEQUENCE/.test(source), '路面必须生成自动谱面而不是整行闪光');
assert(/laneBand=smoothstep\([^;]+laneDist\)/.test(source), '节拍光带要铺满车道并避开分隔线');
assert(!/crossGrid/.test(source), '路面不能再有横竖交叉的方格光网');
assert(/state\.spectrumDistance \/ ROAD_SPECTRUM_STEP/.test(source), '谱面事件必须在深度行之间插值，接近才连续');
assert(/new THREE\.SphereGeometry\(1, 48, 32\)/.test(source), '夜空天体必须是真 3D 球体而不是着色器圆盘');
assert(/new THREE\.RingGeometry\(1\.26, 2\.16, 96, 2\)/.test(source), '土星必须有独立 3D 环');
assert(/new THREE\.TextureLoader\(\)/.test(source) && /assets\/highway-planets\//.test(source), '行星必须用随包贴图，不得运行时联网取图');
assert(!/celestialBody\(vec2 uv,float body\)/.test(source), '旧的平面天体着色器必须保持删除');
assert(/celestialPositionForZone\(displayZone, state\.seed\)/.test(source), '3D 行星只在夜晚分区切换时重算位置');
assert(/applyCelestialAxialTilt\(displayZone, displayIndex\)/.test(source), '行星与土星环必须共用同一份稳定轴倾');

// 十一、贴图随包且预算可控。缺一张就是一颗纯色球，而且不会报错。
let planetAssetBytes = 0;
planetAssetNames.forEach(name => {
  const assetPath = path.join(planetAssetDir, name);
  assert(fs.existsSync(assetPath), '行星贴图缺失 ' + name);
  planetAssetBytes += fs.statSync(assetPath).size;
});
assert(planetAssetBytes < 1024 * 1024, '行星贴图总体积必须低于 1 MB');
assert(fs.readFileSync(path.join(planetAssetDir, 'LICENSE.txt'), 'utf8').includes('CC BY 4.0'), '贴图署名必须随资源分发');

console.log('[OK] 无尽公路以 13 号预设交付：六种地貌、七颗带贴图 3D 天体、有界降水、粒子点绘地形与拱门、八频段响应与节拍提速。');
