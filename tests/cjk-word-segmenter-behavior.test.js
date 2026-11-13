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

test('known single-character runs merge into one visual word', async () => {
  await ready();
  assert.deepEqual(Array.from(segmenter.segment('愿与愁')), ['愿与愁']);
  assert.deepEqual(Array.from(segmenter.segment('我爱你')), ['我爱你']);
});

test('empty and null input return an empty word list', async () => {
  await ready();
  assert.deepEqual(Array.from(segmenter.segment('')), []);
  assert.deepEqual(Array.from(segmenter.segment(null)), []);
});

// splitWords 是两个全屏歌词样式（流光 16 / 商籁 18）唯一的词边界来源。
// 它必须自己在两条路径上都跑同一套归一化，否则切样式时同一行会断在不同位置。
test('splitWords 在词典未就绪时用 Intl 兜底，并跑同一套归一化', () => {
  const fresh = loadSegmenter();
  assert.equal(fresh.isReady(), false);
  assert.deepEqual(
    Array.from(fresh.splitWords('晚风穿过城市的灯火，慢慢亮起')),
    ['晚风', '穿过', '城市的', '灯火，', '慢慢', '亮起'],
  );
});

test('splitWords 把虚词与标点并回前一个词', async () => {
  await ready();
  assert.deepEqual(
    Array.from(segmenter.splitWords('晚风穿过城市的灯火，慢慢亮起')),
    ['晚风', '穿过', '城市的', '灯火，', '慢慢', '亮起'],
  );
  assert.deepEqual(Array.from(segmenter.splitWords('不想长大的孩子')), ['不想', '长大的', '孩子']);
  assert.deepEqual(Array.from(segmenter.splitWords('播放 Lemon Tree 第2首')), ['播放', 'Lemon', 'Tree', '第', '2', '首']);
  assert.deepEqual(Array.from(segmenter.splitWords('')), []);
  assert.deepEqual(Array.from(segmenter.splitWords(null)), []);
});
