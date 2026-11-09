'use strict';

// Phase 4: 分词行为测试。直接加载真实 jieba 词典，验证 DAG + 最大概率路径的输出，
// 而不是 grep 源码里有没有某个函数名。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const MODULE = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual', '17-cjk-word-segmenter.js');
const DICT_GZ = path.join(__dirname, '..', 'public', 'vendor', 'jieba-dict.txt.gz');

function loadSegmenter() {
  const window = {};
  const document = { visibilityState: 'hidden' };
  const gzip = fs.readFileSync(DICT_GZ);
  const context = {
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => new Response(gzip),
    DecompressionStream,
    Response,
    Map,
    Math,
    Date,
    Array,
    String,
    Number,
    parseInt,
    Infinity,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), context, { filename: MODULE });
  return window.cjkWordSegmenter;
}

const segmenter = loadSegmenter();

function ready() {
  return new Promise((resolve) => {
    if (segmenter.isReady()) return resolve();
    segmenter.onReady(resolve);
    segmenter.ensureLoaded();
  });
}

test('segmenter is not ready before the dictionary loads', () => {
  assert.equal(segmenter.isReady(), false);
  assert.deepEqual(Array.from(segmenter.segment('晚风穿过城市')), []);
});

test('dictionary segmentation keeps compounds together', async () => {
  await ready();
  assert.equal(segmenter.isReady(), true);
  assert.deepEqual(
    Array.from(segmenter.segment('晚风穿过城市灯火慢慢亮起')),
    ['晚风', '穿过', '城市', '灯火', '慢慢', '亮起'],
  );
});

test('segmentation keeps latin words and numbers intact between CJK runs', async () => {
  await ready();
  assert.deepEqual(Array.from(segmenter.segment('播放 Lemon Tree 第2首')), ['播放', 'Lemon', 'Tree', '第', '2', '首']);
});

test('unknown CJK characters fall back to single-character words', async () => {
  await ready();
  assert.deepEqual(Array.from(segmenter.segment('龘靐齉')), ['龘', '靐', '齉']);
});

test('empty and null input return an empty word list', async () => {
  await ready();
  assert.deepEqual(Array.from(segmenter.segment('')), []);
  assert.deepEqual(Array.from(segmenter.segment(null)), []);
});
