'use strict';

// 牛来 Dream Migration 预设：编号 14，自绘低多边形场景，八个频段驱动。
// 移植自上游 PR #434，编号按本仓库现状重排：上游用 10，本仓库 10 已被「雨幕霓虹」占用。
// 判据分三层：模块行为（VM 里真跑）、接线（加载器 / 预设表 / 主循环）、样式（作者署名）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const source = read('public', 'niulai-dream-preset.js');
const loader = read('public', 'js', 'index-loader.js');
const core = read('public', 'js', 'modules', '00-state', '00-core-stores.js');
const presets = read('public', 'js', 'modules', '07-fx', '00-preset-archive-data.js');
const presetGrid = read('public', 'js', 'modules', '07-fx', '04-preset-grid-uniforms.js');
const mainLoop = read('public', 'js', 'modules', '11-main-loop.js');
const css = read('public', 'css', 'index.css');

const context = { window: {} };
vm.runInNewContext(source, context, { filename: 'niulai-dream-preset.js' });
const runtime = context.window.MineradioNiuLaiDream;
assert(runtime, '牛来运行时必须注册到全局');
assert.strictEqual(runtime.INDEX, 14, '牛来必须占用预设 14，不能与 9~12 的 premium 预设撞号');

const api = runtime._test;
assert.strictEqual(api.constants.bandCount, 8, '场景必须吃满八个频段');
assert(api.constants.particleCount <= 192, '粒子池必须有上界');
assert(api.constants.mountainCount <= 20, '山体实例池必须有上界');
assert(api.constants.grassCount <= 64, '草地实例池必须有上界');
assert.strictEqual(api.constants.rippleCount, 8, '地面回声每个频段一个');
assert.strictEqual(api.constants.flyerCount, 2, '飞行池只保留两只手作模型');
assert(api.constants.flightEventMinGap >= 0.20, '飞行转向必须有冷却，否则画面会晕');
assert(api.constants.flightLoopPadding > 0, '飞出可视区后要有一段看不见的回环缓冲');
assert.deepStrictEqual(Array.from(api.constants.chapterNames), ['desert-lullaby', 'grassland-awakening', 'forest-stand', 'ink-dream']);

assert.strictEqual(api.chapterStateAtTime(0).index, 0, '开场是沙漠摇篮曲');
assert.strictEqual(api.chapterStateAtTime(api.constants.chapterDuration).index, 1, '第二段进入草原');
assert.strictEqual(api.chapterStateAtTime(api.constants.chapterDuration * 2).index, 2, '第三段进入林地');
assert.strictEqual(api.chapterStateAtTime(api.constants.chapterDuration * 3).index, 3, '第四段进入水墨梦境');
assert(api.chapterStateAtTime(api.constants.chapterDuration * 0.95).blend > 0.8, '章节之间要交叉淡入，不能硬切');

const detailed = api.readAudio({
  sonicDetailed: true,
  subBass: 0.91,
  bass: 0.82,
  lowMid: 0.73,
  mid: 0.64,
  highMid: 0.55,
  presence: 0.46,
  brilliance: 0.37,
  air: 0.28,
  energy: 0.74,
  kickEnvelope: 0.86,
  triggerPulse: 0.93
});
assert.deepStrictEqual(Array.from(detailed.bands), [0.91, 0.82, 0.73, 0.64, 0.55, 0.46, 0.37, 0.28], '八个频段必须按顺序透传');
assert(detailed.beat >= 0.93, '节拍要传到小牛的步频与地面回声');

const firstFlightCue = api.flightCueFrame([0.92, 0.12, 0.08, 0.05, 0.03, 0.02, 0.01, 0], [0, 0, 0, 0, 0, 0, 0, 0], 0.9, 0, 0, 0, 0, 0, 1 / 60);
assert(firstFlightCue.emitted && firstFlightCue.nextEventIndex === 1, '强起音加节拍必须触发一次飞行方向');
const cooledFlightCue = api.flightCueFrame([0.92, 0.12, 0.08, 0.05, 0.03, 0.02, 0.01, 0], [0.92, 0.12, 0.08, 0.05, 0.03, 0.02, 0.01, 0], 0.9, 0.9, firstFlightCue.cueAge, firstFlightCue.cooldown, firstFlightCue.nextEventIndex, firstFlightCue.lastDirection, 1 / 60);
assert(!cooledFlightCue.emitted, '冷却期内的连续起音不得再触发');
assert.strictEqual(api.flightDirectionForBand(0, 0, 0).x, -1, '第一条轨道提示必须选固定的横向');
assert.strictEqual(api.flightDirectionForBand(0, 1, -1).x, 1, '连续提示要避免同侧重复');

const cowBounds = api.constants.flightBounds.cow;
const cowLoop = api.flightLoopBounds(cowBounds);
const bounce = api.advanceFlyerMotion({ x: cowBounds.maxX - 0.01, y: 1 }, { x: 2, y: 0 }, 0.1, cowBounds, cowLoop);
assert(bounce.bouncedX && bounce.position.x === cowBounds.maxX && bounce.velocity.x < 0, '可见边界必须反射，不能让模型飞出画面');
const wrap = api.advanceFlyerMotion({ x: cowLoop.maxX - 0.01, y: 1 }, { x: 2, y: 0 }, 0.1, cowBounds, cowLoop);
assert(wrap.wrapped && wrap.position.x === cowLoop.minX, '飞出可见区后要走看不见的回环边界回收');

// 接线：少登记一处不会报错，只会「什么都不发生」，所以每条都要钉住。
assert(loader.includes("'niulai-dream-preset.js'"), 'index-loader 必须登记牛来');
assert(/MAX_VISUAL_PRESET_INDEX = 14/.test(core) && /NIULAI_PRESET_INDEX = 14/.test(core), '预设 14 必须能通过存档夹取');
assert(presets.includes("name: '牛来'") && presets.includes('作者 <span class="pc-author-cyberforker">Cyberforker</span>'), '预设卡片必须署名 Cyberforker');
assert(/presetDisplayOrder = \[0, 9, 10, 11, 12, 6, 7, 8, 13, 14, 5, 4, 2, 1, 3\]/.test(presets), '牛来卡片要跟无尽公路挨在一起');
assert(/\.pc-author-cyberforker[\s\S]{0,90}color:\s*#e55a4f/.test(css), 'Cyberforker 署名要有独立配色');
assert(/MineradioNiuLaiDream\.onPresetChange/.test(presetGrid), '切换预设必须通知牛来运行时');
assert(/MineradioNiuLaiDream\.update/.test(mainLoop) && /visual\.niulai-dream/.test(mainLoop), '主循环必须更新并计量牛来');
assert(/!niulaiPresetActiveEarly/.test(mainLoop), '牛来激活时基础封面粒子必须隐藏');
assert(/setVisualSuppressed\(highwayPresetActiveEarly \|\| niulaiPresetActiveEarly\)/.test(mainLoop), '牛来激活时歌单架必须让位，否则架体会压在画面上');

// 造型与资源边界：不许运行时去拉外部贴图或模型。
assert(/niulai-low-poly-calf/.test(source) && /new THREE\.SphereGeometry\(1, 10, 7\)/.test(source), '小牛必须是真实低多边形几何体');
assert(/niulai-red-cape/.test(source) && /createCape/.test(source), '小牛要保留飘动红披风');
assert(/niulai-low-poly-lark/.test(source) && /niulai-lark-wing-left/.test(source), '场景要包含飞鸟');
assert(/FLIGHT_FLYER_COUNT/.test(source) && /registerFlyer/.test(source) && /advanceFlyerMotion/.test(source), '飞行必须走有界的复用池');
assert(/child\.frustumCulled = true/.test(source) && /if \(!flyer\.active \|\| !flyer\.object\) return/.test(source), '飞行更新必须只处理活跃模型');
assert(/niulai-ink-dream-gate/.test(source) && /new THREE\.TorusGeometry/.test(source), '场景要包含独立的水墨门');
assert(/new THREE\.InstancedMesh/.test(source), '重复景物必须用实例化几何，不能逐个建网格');
assert(/frameOpacity != null && isFinite\(frameOpacity\)/.test(source), '静态模型材质不能把缺失的帧透明度当成 0');
assert(!/TextureLoader|GLTFLoader|fetch\(|XMLHttpRequest|https?:\/\//.test(source), '不得在运行时请求外部影视素材');

console.log('[OK] 牛来 Dream Migration 以 14 号预设交付：四段梦境、八个频段、有界飞行池，并署名 Cyberforker。');
