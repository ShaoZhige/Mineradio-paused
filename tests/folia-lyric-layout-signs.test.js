'use strict';

// 「歌词布局」滑杆在三个样式之间必须同号。
//
// 默认样式是 WebGL：偏移加在相机基向量上（+Y 向上，rotateX(+θ) 让上边缘朝观察者）。
// 流光 / 商籁 是 DOM 覆盖层，最后落成 CSS transform —— CSS 的 y 轴朝下、rotateX 的手性
// 也相反，所以「垂直位置」和「上下角度」必须取反，而水平位移与左右角度不能跟着翻。
// 这里把两个模块的换算函数都拉进 vm 跑，钉住符号，也钉住两者彼此一致。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLASSIC = read('public/js/modules/02-visual/16-folia-classic-lyrics.js');
const SONNET = read('public/js/modules/02-visual/18-folia-sonnet-lyrics.js');
const STAGE = read('public/js/modules/02-visual/14-stage-lyrics-rendering.js');
const LAYOUT = read('public/js/modules/02-visual/02-lyrics-state-layout.js');
const CSS = read('public/css/lyrics.css');

function fakeDocument() {
  return {
    readyState: 'complete',
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    createElement() {
      return { style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, appendChild() {}, setAttribute() {} };
    },
    body: { classList: { contains() { return false; } }, appendChild() {} },
  };
}

function loadModule(source, filename) {
  const sandbox = {
    __MINERADIO_TEST__: true,
    document: fakeDocument(),
    requestAnimationFrame() {},
    addEventListener() {},
    performance: { now: () => 0 },
    fx: {},
    lyricsLines: [],
    stageLyrics: { group: { visible: true }, palette: null },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename });
  return sandbox;
}

const classicSandbox = loadModule(CLASSIC, '16-folia-classic-lyrics.js');
const sonnetSandbox = loadModule(SONNET, '18-folia-sonnet-lyrics.js');

const classicFrame = classicSandbox.__mineradioFoliaLayoutFrame;
const sonnetFrame = sonnetSandbox.__mineradioSonnetPure.layoutFrame;

test('两个样式都导出了布局换算函数', () => {
  assert.equal(typeof classicFrame, 'function', '流光没有导出 layoutFrame，符号无法被守卫');
  assert.equal(typeof sonnetFrame, 'function', '商籁没有导出 layoutFrame，符号无法被守卫');
});

test('垂直位置与默认样式同号：正值向上（CSS 的 y 轴朝下，所以取负）', () => {
  for (const [name, frame] of [['classic', classicFrame], ['sonnet', sonnetFrame]]) {
    const up = frame({ lyricOffsetY: 1 });
    const down = frame({ lyricOffsetY: -1 });
    assert.equal(up.offsetY, -6, `${name}: +1 应落到 -6vh`);
    assert.equal(down.offsetY, 6, `${name}: -1 应落到 +6vh`);
    assert.match(up.transform, /-6\.00vh/, `${name}: transform 也要带负号`);
  }
});

test('上下角度与默认样式同号：正值让上边缘朝观察者（CSS rotateX 取负）', () => {
  for (const [name, frame] of [['classic', classicFrame], ['sonnet', sonnetFrame]]) {
    const tiltUp = frame({ lyricTiltX: 30 });
    assert.equal(tiltUp.tiltX, -30, `${name}: 上下角度必须取反`);
    assert.match(tiltUp.transform, /rotateX\(-30\.00deg\)/, `${name}: transform 里的 rotateX 要取反`);
  }
});

test('水平位移与左右角度不跟着翻', () => {
  for (const [name, frame] of [['classic', classicFrame], ['sonnet', sonnetFrame]]) {
    const f = frame({ lyricOffsetX: 1, lyricTiltY: 30 });
    assert.equal(f.offsetX, 6, `${name}: 水平位移保持正号`);
    assert.equal(f.tiltY, 30, `${name}: 左右角度保持正号`);
    assert.match(f.transform, /6\.00vw[\s\S]*rotateY\(30\.00deg\)/);
  }
});

test('流光与商籁对同一份设置产出完全相同的 transform', () => {
  const settings = { lyricScale: 1.2, lyricOffsetX: -0.4, lyricOffsetY: 0.8, lyricTiltX: -18, lyricTiltY: 12 };
  assert.equal(classicFrame(settings).transform, sonnetFrame(settings).transform);
});

test('默认样式确实是「+Y 向上、rotateX 绕相机基向量」的参考坐标系', () => {
  // 这条是上面所有取反的依据：偏移加在相机 up 向量上，而不是屏幕坐标上。
  assert.match(LAYOUT, /function applyStageLyricLayoutOffset[\s\S]*?addScaledVector\(lyricCameraUp, y \|\| 0\)/);
  assert.match(STAGE, /applyStageLyricLayoutOffset\(lyricLayoutTarget, layoutX, layoutY, layoutZ\)/);
  assert.match(STAGE, /stageLyricTargetQuaternion\([^)]*layoutTiltX/);
});

test('商籁的位置层只包相机，角标与线稿不跟着动', () => {
  // DOM 结构：viewport > layout > camera > shot；canvas 与 frame 是 layout 的兄弟。
  assert.match(SONNET, /fs-viewport"><div class="fs-layout"><div class="fs-camera">/);
  assert.match(SONNET, /layoutNode = root\.querySelector\('\.fs-layout'\)/);
  assert.match(CSS, /\.fs-layout\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/);
});
