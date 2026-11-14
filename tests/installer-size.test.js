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

test('打包清单剔除只服务浏览器或其它架构的死重', () => {
  const files = PKG.build.files;
  [
    // 安装包只出 win32-x64，另外两种架构的 HID 预编译件谁也用不到。
    '!node_modules/node-hid/prebuilds/HID-win32-arm64*/**',
    '!node_modules/node-hid/prebuilds/HID-win32-ia32*/**',
    // 下面几个包里 Node 侧走的是 lib/ 或 dist/node/，浏览器构建是纯体积。
    '!node_modules/pngjs/browser.js',
    '!node_modules/pngjs/coverage/**',
    '!node_modules/node-forge/dist/**',
    '!node_modules/source-map/dist/**',
    '!node_modules/axios/dist/esm/**',
    '!node_modules/axios/dist/browser/**',
    '!node_modules/**/*.h'
  ].forEach((rule) => assert.ok(files.includes(rule), 'packaging trim rule missing: ' + rule));
  assert.ok(files.includes('!node_modules/axios/dist/axios.js'), 'axios browser bundle must stay out');
  // 运行时只读 build/icon.ico（窗口与托盘图标）；安装器位图、NSIS 脚本、构建日志
  // 由 buildResources / extraFiles 单独取用，打进 app.asar 纯属白背体积。
  assert.ok(files.includes('build/icon.ico'), 'window icon must stay packaged');
  assert.ok(!files.includes('build/**/*'), 'installer-only build assets must not be packed');
  assert.equal(PKG.build.asarUnpack[0], 'build/icon.ico');
});
