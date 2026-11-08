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
const LOADER = read('public/js/index-loader.js');
const NOTICE = read('NOTICE.md');

test('中文词典文件存在且包含常用歌词词条', () => {
  assert.ok(fs.existsSync(DICT_PATH), 'public/vendor/jieba-dict.txt missing');
  const stat = fs.statSync(DICT_PATH);
  assert.ok(stat.size > 5 * 1024 * 1024, 'dictionary looks truncated: ' + stat.size);
  const text = fs.readFileSync(DICT_PATH, 'utf8');
  for (const word of ['晚风', '穿过', '城市', '灯火', '慢慢', '亮起']) {
    assert.match(text, new RegExp('^' + word + ' [0-9]+$', 'm'), word + ' missing from dictionary');
  }
  const firstLine = text.split('\n')[0];
  assert.match(firstLine, /^\S+ [0-9]+$/, 'dictionary should stay word/frequency pairs');
});

test('分词器使用 DAG + 最大概率路径，并在后台懒加载词典', () => {
  assert.match(SEGMENTER, /function segmentHanRun\(/);
  assert.match(SEGMENTER, /state\.words\.set\(word, freq\)/);
  assert.match(SEGMENTER, /Math\.log\(freq \/ total\)/);
  assert.match(SEGMENTER, /function ensureLoaded\(/);
  assert.match(SEGMENTER, /function onReady\(/);
  assert.match(SEGMENTER, /global\.cjkWordSegmenter = \{/);
  assert.match(SEGMENTER, /document\.visibilityState === 'hidden'/);
});

test('词典在经典歌词模块之前加载，并被 16 模块调用', () => {
  const segIdx = LOADER.indexOf('02-visual/17-cjk-word-segmenter.js');
  const classicIdx = LOADER.indexOf('02-visual/16-folia-classic-lyrics.js');
  assert.ok(segIdx >= 0 && classicIdx >= 0, 'loader entries missing');
  assert.ok(segIdx < classicIdx, 'segmenter must load before the classic lyric module');
  assert.match(CLASSIC, /cjkWordSegmenter\.isReady\(\)/);
  assert.match(CLASSIC, /cjkWordSegmenter\.segment\(text\)/);
  assert.match(CLASSIC, /cjkWordSegmenter\.ensureLoaded\(\)/);
  assert.match(CLASSIC, /cjkWordSegmenter\.onReady\(/);
});

test('第三方声明注明 jieba 词典来源', () => {
  assert.match(NOTICE, /jieba/i);
  assert.match(NOTICE, /MIT/);
});
