'use strict';

// “乱舞”布局行为测试：同一行种子稳定、位置在安全框内、尺寸/角度有差异、
// 词与词之间不会完全重叠。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const MODULE = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '16-folia-classic-lyrics.js');

function loadScatterLayout() {
  const window = { __MINERADIO_TEST__: true, cjkWordSegmenter: null, setTimeout, clearTimeout };
  const document = {
    readyState: 'complete',
    visibilityState: 'hidden',
    body: { classList: { contains: () => false } },
    documentElement: { classList: { add: () => {} } },
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add: () => {} }, appendChild: () => {}, setAttribute: () => {} }),
    addEventListener: () => {},
  };
  const context = {
    window,
    document,
    console,
    Intl,
    Array,
    String,
    Number,
    Math,
    Date,
    isFinite,
    requestAnimationFrame: () => 0,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), context, { filename: MODULE });
  return window.__mineradioFoliaScatterLayout;
}

const scatterLayout = loadScatterLayout();

test('scatter layout is deterministic for the same line seed', () => {
  const a = scatterLayout(6, 123.45);
  const b = scatterLayout(6, 123.45);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('scatter positions stay inside the safe viewport box', () => {
  const poses = scatterLayout(8, 42);
  assert.equal(poses.length, 8);
  for (const pose of poses) {
    assert.ok(pose.x >= 12 && pose.x <= 88, `x out of bounds: ${pose.x}`);
    assert.ok(pose.y >= 17 && pose.y <= 83, `y out of bounds: ${pose.y}`);
  }
});

test('scatter sizes and rotations vary instead of one uniform line', () => {
  const poses = scatterLayout(7, 7.7);
  const sizes = poses.map((p) => p.size);
  const rotations = poses.map((p) => p.rot);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) > 0.35, 'sizes should differ');
  assert.ok(Math.max(...rotations) - Math.min(...rotations) > 8, 'rotations should differ');
  for (const pose of poses) {
    assert.ok(pose.size >= 0.75 && pose.size <= 2.05, `size out of range: ${pose.size}`);
    assert.ok(Math.abs(pose.rot) <= 26, `rotation out of range: ${pose.rot}`);
  }
});

test('scatter layout does not stack words on the same point', () => {
  const poses = scatterLayout(6, 99.1);
  for (let i = 0; i < poses.length; i++) {
    for (let j = i + 1; j < poses.length; j++) {
      const dx = (poses[i].x - poses[j].x) * 1.55;
      const dy = poses[i].y - poses[j].y;
      assert.ok(Math.hypot(dx, dy) > 8, `words ${i}/${j} too close`);
    }
  }
});

test('different lines get different scatter poses', () => {
  const a = scatterLayout(5, 1.1);
  const b = scatterLayout(5, 2.2);
  const moved = a.some((pose, i) => Math.abs(pose.x - b[i].x) > 1 || Math.abs(pose.y - b[i].y) > 1);
  assert.ok(moved, 'layout should reshuffle between lines');
});
