'use strict';

// Phase 4: 流光逐词时序行为测试。直接调用 16-folia-classic-lyrics.js 里的 buildWords，
// 覆盖 YRC 逐词时长、缺失时长回退、全零起点铺开与 LRC 长间奏截断。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const MODULE = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '16-folia-classic-lyrics.js');

function loadFolia() {
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
  return window.__mineradioFoliaBuildWords;
}

const buildWords = loadFolia();

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 0.001, `${message}: ${actual} !== ${expected}`);
}

test('YRC word timing keeps provider t/d windows', () => {
  const words = buildWords({
    t: 10,
    text: '晚风穿过',
    words: [
      { text: '晚风', t: 10, d: 0.5 },
      { text: '穿过', t: 10.5, d: 0.6 },
    ],
  }, { t: 20 });
  assert.deepEqual(Array.from(words, (w) => w.text), ['晚风', '穿过']);
  close(words[0].start, 10, 'first start');
  close(words[0].end, 10.5, 'first end');
  close(words[1].start, 10.5, 'second start');
  close(words[1].end, 11.1, 'second end');
});

test('missing word duration falls back to the next word start', () => {
  const words = buildWords({
    t: 10,
    text: '城市灯火',
    words: [
      { text: '城市', t: 10 },
      { text: '灯火', t: 10.8 },
    ],
  }, { t: 20 });
  close(words[0].start, 10, 'start');
  close(words[0].end, 10.8, 'next-start fallback');
  close(words[1].start, 10.8, 'last start');
  close(words[1].end, 11.04, 'last 0.24s fallback');
});

test('identical word starts are spread across the line span', () => {
  const words = buildWords({
    t: 10,
    text: '城市灯火',
    words: [
      { text: '城市', t: 10 },
      { text: '灯火', t: 10 },
    ],
  }, { t: 12 });
  assert.ok(words[0].start >= 10 && words[0].end > words[0].start, 'first word should start inside the line');
  assert.ok(words[1].start >= words[0].end || Math.abs(words[1].start - words[0].end) < 0.2, 'second word should follow the first');
  assert.ok(words[1].end <= 12, 'last word must end inside the line span');
});

test('LRC long gap is clamped by reading time', () => {
  const words = buildWords({ t: 0, text: '晚风穿过城市灯火慢慢亮起', duration: 20, words: [] }, { t: 20 });
  assert.ok(words.length > 1, 'fallback should split into words');
  assert.ok(words[0].start >= 0 && words[0].start < 1, 'first word starts near the line start');
  assert.ok(words[words.length - 1].end > 6.5 && words[words.length - 1].end <= 8, 'line ends after reading clamp');
});

test('word-timed lines are not shortened by the reading clamp', () => {
  const words = buildWords({
    t: 10,
    text: '晚风',
    words: [{ text: '晚风', t: 10, d: 0.4 }],
  }, { t: 26 });
  close(words[0].end, 10.4, 'word end is not clamped to reading time');
});
