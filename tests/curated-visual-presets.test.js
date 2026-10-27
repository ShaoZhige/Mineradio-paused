'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const core = read('public/js/modules/00-state/00-core-stores.js');
const data = read('public/js/modules/07-fx/00-preset-archive-data.js');
const shader = read('public/js/modules/02-visual/00-pointer-cover-particles.js');
const orbit = read('public/js/modules/01-scene/01-orbit-free-camera.js');
const grid = read('public/js/modules/07-fx/04-preset-grid-uniforms.js');
const css = read('public/css/index.css');
const mainLoop = read('public/js/modules/11-main-loop.js');

assert.match(core, /MAX_VISUAL_PRESET_INDEX = 13/);
assert.match(core, /SONIC_PRESET_INDEX = 7/);
assert.match(core, /SONIC_WORKSHOP_PRESET_INDEX = 8/);
assert.match(data, /presetDisplayOrder = \[0, 9, 10, 11, 12, 6, 7, 8, 13, 5, 4, 2, 1, 3\]/);
for (const [id, cn, en] of [
  [9, '月蚀圣环', 'ECLIPSE HALO'],
  [10, '雨幕霓虹', 'NEON DRIZZLE'],
  [11, '折光蝶群', 'PRISM FLOCK'],
  [12, '深海绽放', 'ABYSSAL BLOOM']
]) {
  assert.ok(data.includes(cn));
  assert.ok(data.includes(en));
  assert.match(orbit, new RegExp('p === ' + id));
  assert.match(shader, new RegExp('Number\\(fx\\.preset\\) === ' + id));
}
assert.match(shader, /else if \(uPreset < 8\.5\)/);
assert.match(shader, /Preset 9: ECLIPSE HALO/);
assert.match(shader, /Preset 10: NEON DRIZZLE/);
assert.match(shader, /Preset 11: PRISM FLOCK/);
assert.match(shader, /Preset 12: ABYSSAL BLOOM/);
assert.match(grid, /preset-card-premium/);
assert.match(css, /\.preset-card\.preset-card-premium/);
assert.match(mainLoop, /authoredParticles = fx\.preset >= 9 && fx\.preset <= 12/);
assert.doesNotMatch(shader + grid + data, /Mineradio WE Glass Refraction|#mineradio-control-glass-filter/);

// 13 是自绘场景预设，走自己的 IIFE 模块，不参与 shader 的 9~12 分支。
// 编号必须与 presetMeta 下标一致：写偏一位就会让老存档的 preset 落到别的画面上。
const loader = read('public/js/index-loader.js');
for (const [id, cn, en, file, globalName] of [
  [13, '无尽公路', 'HIGHWAY DRIVE', 'public/highway-drive-preset.js', 'MineradioHighwayDrive']
]) {
  assert.ok(data.includes(cn), 'presetMeta 缺少 ' + cn);
  assert.ok(data.includes(en), cn + ' 缺少英文副名');
  assert.ok(fs.existsSync(path.join(appRoot, file)), file + ' 不存在');
  const source = read(file);
  assert.ok(source.includes('var INDEX = ' + id + ';'), file + ' 的 INDEX 不是 ' + id);
  assert.ok(loader.includes("'" + path.basename(file) + "'"), 'index-loader 未登记 ' + path.basename(file));
  assert.ok(grid.includes(globalName + '.onPresetChange'), globalName + ' 未接入预设切换钩子');
  assert.ok(mainLoop.includes(globalName + '.update('), globalName + ' 未接入渲染循环');
  assert.ok(mainLoop.includes(globalName + '.isActive(fx)'), globalName + ' 未接入激活判定');
}
// 接管全屏画面的预设必须让歌单架整体让位，否则架体浮在路面上。
assert.ok(mainLoop.includes('setVisualSuppressed(highwayPresetActiveEarly)'));
assert.ok(read('public/js/modules/04-shelf/01-manager-core.js').includes('setVisualSuppressed: function'));
assert.ok(read('public/js/modules/04-shelf/01-manager-core.js').includes('!visualSuppressed'));
// 天体已经换成粒子光团，天体贴图目录不该再回来。
assert.ok(!fs.existsSync(path.join(appRoot, 'public/assets/highway-planets')), '天体贴图目录必须保持删除');

console.log('OK curated-visual-presets');
