'use strict';

// native 临时区残留脚本清扫回归测试
//
// 背景：图标层、Spotify 探针、内存工具都会写「每次唯一命名」的 .ps1 到 native 临时区，正常退出
// 才删。被强杀 / 崩溃时那一步跑不到，文件会永久留在 userdata\cache\native-helper-temp 里。
// 现在启动时按「名字形状 + 年龄」清一遍。
//
// 这个测试盯住的是「清扫不许误伤」——错删一个正在复用的缓存脚本，比不清理严重得多：
//   1. 唯一命名的老脚本要删
//   2. 唯一命名但很新的不删（可能正在跑）
//   3. 固定名的 scratch 文件不删（mineradio-desktop-icons-visibility.ps1 每次覆盖写）
//   4. 内容摘要命名的缓存不删（wallpaper-engine-*.ps1 有意复用）
//   5. 非 .ps1/.json 不删
//   6. 目录不存在不报错（首次启动）
//
// Background: the icon layer, Spotify probe and memory tools write uniquely named .ps1 helpers into
// the native temp area and delete them only on a clean exit, so a forced kill leaves them behind
// forever. Startup now prunes by name shape plus age. What matters here is that the prune never
// bites a deliberate cache — wrongly deleting one is far worse than leaving litter.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pruneStaleNativeTempScripts, isStaleHelperName, DEFAULT_MAX_AGE_MS } = require('../desktop/native-temp-cleanup');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-native-temp-'));
}

// 把文件 mtime 拨到指定年龄，模拟「上次启动留下的」/「刚刚还在跑」。
// Backdate a file so it looks like a leftover from an earlier launch, or like it is still running.
function ageFile(filePath, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, when, when);
}

function writeFile(dir, name, ageMs = 0) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, '# test\n', 'utf8');
  if (ageMs) ageFile(full, ageMs);
  return full;
}

test('唯一命名的旧脚本会被删掉', () => {
  const dir = tempDir();
  const stale = [
    'mineradio-native-icon-layer-20516-1763556000123-a1b2c3.ps1', // 图标层（带随机后缀）
    'mineradio-native-icon-layer-20516-1763556000123-.ps1',        // 随机后缀可能为空串
    'mineradio-spotify-probe-20516-1763556000123.ps1',             // Spotify 探针
    'mineradio-mem-purge-20516-1763556000123.ps1',                 // 内存工具
    'mineradio-mem-purge-elevated-20516-1763556000123.ps1',        // 标签里带连字符
    'mineradio-mem-result-20516-1763556000123.json',               // json 结果文件
  ];
  for (const name of stale) writeFile(dir, name, DEFAULT_MAX_AGE_MS + 60 * 1000);

  const result = pruneStaleNativeTempScripts(dir);
  assert.equal(result.removed.length, stale.length);
  for (const name of stale) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应该被删除`);
  }
  assert.deepEqual(result.failed, []);
});

test('刚写完的脚本不删（可能正在被其它实例执行）', () => {
  const dir = tempDir();
  const fresh = 'mineradio-spotify-probe-4242-1763556000123.ps1';
  writeFile(dir, fresh, 5 * 1000);

  const result = pruneStaleNativeTempScripts(dir);
  assert.equal(result.removed.length, 0);
  assert.equal(result.kept, 1);
  assert.equal(fs.existsSync(path.join(dir, fresh)), true);
});

test('固定名的 scratch 文件不删', () => {
  const dir = tempDir();
  // 桌面图标显隐脚本：固定文件名，每次覆盖写，删了也无害但没必要动它。
  const fixed = 'mineradio-desktop-icons-visibility.ps1';
  writeFile(dir, fixed, DEFAULT_MAX_AGE_MS * 10);

  const result = pruneStaleNativeTempScripts(dir);
  assert.equal(result.removed.length, 0);
  assert.equal(fs.existsSync(path.join(dir, fixed)), true);
});

test('按内容摘要命名的壁纸脚本不删（有意复用缓存）', () => {
  const dir = tempDir();
  const cached = [
    'wallpaper-engine-dwm-surface-3f2a1b.ps1',
    'wallpaper-engine-helper-9c8d7e.ps1',
  ];
  for (const name of cached) writeFile(dir, name, DEFAULT_MAX_AGE_MS * 10);

  const result = pruneStaleNativeTempScripts(dir);
  assert.equal(result.removed.length, 0);
  for (const name of cached) assert.equal(fs.existsSync(path.join(dir, name)), true);
});

test('非 ps1/json 与子目录都不动', () => {
  const dir = tempDir();
  writeFile(dir, 'mineradio-native-icon-layer-123-1763556000123-a1.flag', DEFAULT_MAX_AGE_MS * 10);
  writeFile(dir, 'mineradio-native-icon-layer-123-1763556000123-a1.log', DEFAULT_MAX_AGE_MS * 10);
  fs.mkdirSync(path.join(dir, 'mineradio-native-icon-layer-123-1763556000123-a1.ps1'), { recursive: true });

  const result = pruneStaleNativeTempScripts(dir);
  assert.equal(result.removed.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'mineradio-native-icon-layer-123-1763556000123-a1.flag')), true);
});

test('目录不存在时安静返回（首次启动）', () => {
  const missing = path.join(tempDir(), 'not-created-yet');
  const result = pruneStaleNativeTempScripts(missing);
  assert.deepEqual(result, { scanned: 0, removed: [], kept: 0, failed: [] });
  assert.equal(fs.existsSync(missing), false, '清扫不该顺手把目录建出来');
});

test('名字形状判据单独可用', () => {
  assert.equal(isStaleHelperName('mineradio-spotify-probe-20516-1763556000123.ps1'), true);
  assert.equal(isStaleHelperName('mineradio-native-icon-layer-20516-1763556000123-.ps1'), true);
  assert.equal(isStaleHelperName('mineradio-desktop-icons-visibility.ps1'), false);
  // 时间戳不足 13 位（手写文件 / 早期格式）不认
  assert.equal(isStaleHelperName('mineradio-foo-123-1763556000.ps1'), false);
  // pid 不足 3 位不认
  assert.equal(isStaleHelperName('mineradio-foo-1-1763556000123.ps1'), false);
  // 前缀不对不认
  assert.equal(isStaleHelperName('wallpaper-engine-helper-9c8d7e.ps1'), false);
});
