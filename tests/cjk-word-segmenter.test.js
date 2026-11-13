'use strict';

// 中文词典分词器的静态守卫。
//
// 流光在没有逐词时间轴时用词典做词级切分，单字只作最后兜底。词典是本地
// vendor 文件，加载/解析/降级任何一环坏了都会悄悄退回 Intl.Segmenter，
// 所以这里把词典、加载顺序、算法和降级路径都钉住。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DICT_PATH = path.join(ROOT, 'public/vendor/jieba-dict.txt');
const SEGMENTER = read('public/js/modules/02-visual/17-cjk-word-segmenter.js');
const CLASSIC = read('public/js/modules/02-visual/16-folia-classic-lyrics.js');
const SONNET = read('public/js/modules/02-visual/18-folia-sonnet-lyrics.js');
const LOADER = read('public/js/index-loader.js');
const NOTICE = read('NOTICE.md');

test('中文词典文件存在且包含常用歌词词条', () => {
  assert.ok(fs.existsSync(DICT_PATH), 'public/vendor/jieba-dict.txt missing');
  const stat = fs.statSync(DICT_PATH);
  assert.ok(stat.size > 5 * 1024 * 1024, 'dictionary looks truncated: ' + stat.size);
  const text = fs.readFileSync(DICT_PATH, 'utf8');
  for (const word of ['晚风', '穿过', '城市', '灯火', '慢慢', '亮起']) {
    assert.match(text, new RegExp('^' + word + ' [0-9]+\\r?$', 'm'), word + ' missing from dictionary');
  }
  const firstLine = text.split(/\r?\n/)[0];
  assert.match(firstLine, /^\S+ [0-9]+\r?$/, 'dictionary should stay word/frequency pairs');
});

test('分词器使用 DAG + 最大概率路径，并同步解析词典', () => {
  assert.match(SEGMENTER, /function segmentHanRun\(/);
  assert.match(SEGMENTER, /state\.words\.set\(word, freq\)/);
  assert.match(SEGMENTER, /Math\.log\(freq \/ total\)/);
  assert.match(SEGMENTER, /function ensureLoaded\(/);
  assert.match(SEGMENTER, /function onReady\(/);
  assert.match(SEGMENTER, /global\.cjkWordSegmenter = \{/);
  // The dictionary is parsed synchronously: idle slices never run in a hidden
  // window, which used to leave the segmenter stuck in "loading" forever.
  assert.match(SEGMENTER, /function parseLines\(/);
  assert.doesNotMatch(SEGMENTER, /requestIdleCallback/);
  assert.match(SEGMENTER, /function mergeKnownSingleRuns\(/);
});

test('词典先于两个歌词样式加载，且两边共用同一个分词入口', () => {
  const segIdx = LOADER.indexOf('02-visual/17-cjk-word-segmenter.js');
  const classicIdx = LOADER.indexOf('02-visual/16-folia-classic-lyrics.js');
  const sonnetIdx = LOADER.indexOf('02-visual/18-folia-sonnet-lyrics.js');
  assert.ok(segIdx >= 0 && classicIdx >= 0 && sonnetIdx >= 0, 'loader entries missing');
  assert.ok(segIdx < classicIdx, 'segmenter must load before the classic lyric module');
  assert.ok(segIdx < sonnetIdx, 'segmenter must load before the sonnet lyric module');
  // 分词规则只维护在 17：两个样式都只调 splitWords()，谁也不许再自己切一遍，
  // 否则同一行歌词在两种样式里会断在不同位置。
  assert.match(CLASSIC, /cjkWordSegmenter\.splitWords\(text\)/);
  assert.match(CLASSIC, /cjkWordSegmenter\.onReady\(/);
  assert.match(SONNET, /cjkWordSegmenter\.splitWords\(text\)/);
  assert.match(SONNET, /cjkWordSegmenter\.onReady\(/);
  assert.doesNotMatch(CLASSIC, /new Intl\.Segmenter\(/);
  assert.doesNotMatch(SONNET, /new Intl\.Segmenter\(/);
  assert.match(SEGMENTER, /function splitWords\(/);
  assert.match(SEGMENTER, /function normalizeUnits\(/);
});

test('第三方声明注明 jieba 词典来源', () => {
  assert.match(NOTICE, /jieba/i);
  assert.match(NOTICE, /MIT/);
});
