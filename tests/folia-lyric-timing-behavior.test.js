'use strict';

// Phase 4: 流光逐词时序行为测试。直接调用 16-folia-classic-lyrics.js 里的 buildWords，
// 覆盖 YRC 逐词时长、缺失时长回退、全零起点铺开与 LRC 长间奏截断。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const MODULE = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '16-folia-classic-lyrics.js');
const SONNET_MODULE = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '18-folia-sonnet-lyrics.js');
const SEGMENTER = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '17-cjk-word-segmenter.js');

function loadFolia() {
  const window = { __MINERADIO_TEST__: true, setTimeout, clearTimeout };
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
    fx: { lyricStyle: 'default' },
    requestAnimationFrame: () => 0,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  // 分词的唯一实现在 17 号模块里，流光只委托它。沙箱没有 fetch，词典停在
  // 未就绪态，走 Intl.Segmenter + 同一套归一化——正是启动头几百毫秒的路径。
  vm.runInContext(fs.readFileSync(SEGMENTER, 'utf8'), context, { filename: SEGMENTER });
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), context, { filename: MODULE });
  return window.__mineradioFoliaBuildWords;
}

const buildWords = loadFolia();

// 商籁的沙箱和流光同构：先注入 17 号分词器，再注入 18 号，然后取它导出的纯函数。
function loadSonnet() {
  const window = { __MINERADIO_TEST__: true, setTimeout, clearTimeout };
  const document = {
    readyState: 'complete',
    visibilityState: 'hidden',
    body: { classList: { contains: () => false } },
    documentElement: { classList: { add: () => {} } },
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {}, setAttribute() {} }),
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
    fx: { lyricStyle: 'default' },
    lyricsLines: [],
    stageLyrics: { group: { visible: true }, palette: { primary: '#fff', highlight: '#fff', secondary: '#a9d4ff' } },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    setTimeout,
    clearTimeout,
    addEventListener: () => {},
  };
  context.globalThis = context;
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SEGMENTER, 'utf8'), context, { filename: SEGMENTER });
  vm.runInContext(fs.readFileSync(SONNET_MODULE, 'utf8'), context, { filename: SONNET_MODULE });
  assert.ok(window.__mineradioSonnetPure, 'sonnet pure helpers missing');
  return window.__mineradioSonnetPure;
}

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

// 首词起点必须真的落在行首：曾经用 !firstAt[w] 判断「还没赋值」，
// 整行从 0 秒开始时 0 是 falsy，第一个词会晚一个字才亮。
test('line starting at zero lights the first word from the line start', () => {
  const words = buildWords({ t: 0, text: '晚风穿过', duration: 4 }, { t: 4 });
  assert.deepEqual(Array.from(words, (w) => w.text), ['晚风', '穿过']);
  close(words[0].start, 0, 'first word start');
});

test('LRC 长间隔按吐字速度收束，不跟着下一行一路拖慢', () => {
  // 12 个字：演唱时长 ≈ 12*0.34+0.9 = 4.98s；行间隔 20s 里剩下的是间奏。
  const words = buildWords({ t: 0, text: '晚风穿过城市灯火慢慢亮起', duration: 20, words: [] }, { t: 20 });
  assert.ok(words.length > 1, 'fallback should split into words');
  close(words[0].start, 0, 'first word starts at the line start');
  const last = words[words.length - 1].end;
  assert.ok(last > 4 && last < 5.2, 'line must end near the sung estimate, got ' + last.toFixed(2));
});

test('间隔接近演唱时长的行保持原样', () => {
  // 9 个字：演唱时长 ≈ 3.96s；行间隔 3.8s 没超出，不应该被收束。
  const words = buildWords({ t: 10, text: '这是一个八字的句子', duration: 3.8 }, { t: 13.8 });
  const last = words[words.length - 1].end;
  assert.ok(Math.abs(last - (10 + 3.8 * 0.9)) < 0.15, 'near-sung lines must not be clamped, got ' + last.toFixed(2));
});

test('拖音行保留原本的时长', () => {
  // 省略号行是靠拖音把时间占满的，收束会把它剪成正常语速，字就跑到声音前面了。
  const words = buildWords({ t: 0, text: 'On My Love......', duration: 9 }, { t: 9 });
  const last = words[words.length - 1].end;
  assert.ok(last > 7.5, 'sustained vocal line must keep its span, got ' + last.toFixed(2));
});

test('word-timed lines are not shortened by the sung-span estimate', () => {
  const words = buildWords({
    t: 10,
    text: '晚风',
    words: [{ text: '晚风', t: 10, d: 0.4 }],
  }, { t: 26 });
  close(words[0].end, 10.4, 'word end is not clamped to the estimate');
});

// 收束口径必须两边一致：同一个字在两个样式里要点亮在同一时刻，否则切换样式会「跳一下」。
test('流光与商籁对同一行的收束结果一致', () => {
  const sonnet = loadSonnet();
  const cases = [
    [{ t: 0, text: '晚风穿过城市灯火慢慢亮起', duration: 20 }, { t: 20 }],
    [{ t: 5, text: '这是一个八字的句子', duration: 3.8 }, { t: 8.8 }],
    [{ t: 12, text: 'On My Love', duration: 9 }, { t: 21 }],
    [{ t: 30, text: '是谁在敲打我窗', duration: 3.2 }, { t: 33.2 }],
    [{ t: 40, text: '我爱你中国', duration: 6.5 }, { t: 46.5 }],
  ];
  for (const [line, next] of cases) {
    const a = buildWords(line, next);
    const b = sonnet.buildUnits(line, next);
    const aEnd = a[a.length - 1].end;
    const bEnd = b[b.length - 1].end;
    assert.ok(Math.abs(aEnd - bEnd) < 0.02, `span mismatch on 「${line.text}」: 16=${aEnd.toFixed(3)} 18=${bEnd.toFixed(3)}`);
  }
});
