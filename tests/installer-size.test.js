'use strict';

// 安装包体积守卫。
//
// 体积主要来自 Electron 运行时，但应用侧仍有几处可控项：词典以 gzip 发布、
// 不把 WebGPU 的 DXIL 编译器打进安装包、只保留两种 Chromium UI 语言。
// 这些改动一旦被回退，安装包会悄悄胖回去，所以这里钉住。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PKG = JSON.parse(read('package.json'));
const AFTER_PACK = read('build/after-pack.js');
const SEGMENTER = read('public/js/modules/02-visual/17-cjk-word-segmenter.js');

test('安装包使用最高压缩，且不重复打包明文词典', () => {
  assert.equal(PKG.build.compression, 'maximum');
  assert.ok(PKG.build.files.includes('!public/vendor/jieba-dict.txt'), 'plain dictionary must stay out of the package');
});

test('词典以 gzip 发布，运行时用 DecompressionStream 解压', () => {
  const plain = fs.statSync(path.join(ROOT, 'public/vendor/jieba-dict.txt')).size;
  const gzPath = path.join(ROOT, 'public/vendor/jieba-dict.txt.gz');
  assert.ok(fs.existsSync(gzPath), 'gzip dictionary missing');
  const gz = fs.statSync(gzPath).size;
  assert.ok(gz > 1024 * 1024, 'gzip dictionary looks truncated');
  assert.ok(gz < plain * 0.6, 'gzip dictionary is not actually compressed');
  assert.match(SEGMENTER, /jieba-dict\.txt\.gz/);
  assert.match(SEGMENTER, /new DecompressionStream\('gzip'\)/);
});

test('afterPack 去掉 WebGPU 编译器并精简 Chromium 语言包', () => {
  assert.match(AFTER_PACK, /dxcompiler\.dll/);
  assert.match(AFTER_PACK, /rmSync\(target, \{ force: true \}\)/);
  assert.match(AFTER_PACK, /localesDir/);
  assert.match(AFTER_PACK, /en-US\.pak/);
  assert.match(AFTER_PACK, /zh-CN\.pak/);
});
