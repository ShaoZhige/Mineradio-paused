'use strict';

// 诊断日志轮转回归测试
//
// 背景：`wallpaper-engine-commands.log`、`startup-error.log`、`wallpaper-engine-start-timing.log`
// 都是纯 append，从来不删。命令日志每发一条控制命令多一行，实测已到 286 KB。
//
// 这个测试盯住三件事：
//   1. 没超上限时老实 append，不许平白轮转（否则会把有用的历史切碎）
//   2. 超了上限就把旧文件改名成 .1.log，新文件只留新写入的内容
//   3. 只保留一代归档 —— .1.log 会被下一次轮转覆盖，否则等于没设上限
//
// Background: three diagnostic logs are pure appends with no ceiling; the command log already
// reached 286 KB. This pins three things: no rotation below the limit, rename to .1.log once over
// it, and exactly one generation of history (a second rotation overwrites the first).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendLogLine,
  rotateLogFile,
  STAT_EVERY_BYTES,
  DEFAULT_MAX_BYTES,
} = require('../desktop/log-rotation');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-log-rotate-'));
}

// 大小检查是按写入量节流的（每 128 KB 才 stat 一次），所以想触发检查就得一次写够这么多。
// The size check is throttled by bytes written, so triggering it needs one write of that size.
const PULSE = 'y'.repeat(STAT_EVERY_BYTES);

test('没超上限时只 append，不轮转', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.log');
  fs.writeFileSync(file, 'first\n', 'utf8');

  appendLogLine(file, PULSE, { maxBytes: STAT_EVERY_BYTES * 8 });

  assert.equal(fs.existsSync(path.join(dir, 'a.1.log')), false, '不该轮转');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('first\n'), '旧内容还在');
  assert.equal(text.length, 6 + STAT_EVERY_BYTES);
});

test('超过上限时改名成 .1.log，新文件从下一条日志开始', () => {
  const dir = tempDir();
  const file = path.join(dir, 'commands.log');
  fs.writeFileSync(file, 'old-line\n', 'utf8');

  // 第一笔：pending 还是 0，不检查大小，直接写；写完后 pending 攒满一个脉冲。
  appendLogLine(file, PULSE, { maxBytes: 2000 });
  assert.equal(fs.existsSync(path.join(dir, 'commands.1.log')), false, '这一笔还不该轮转');

  // 第二笔：pending 到阈值了，先发现文件超限 → 归档，再写这一条。
  appendLogLine(file, 'tail\n', { maxBytes: 2000 });

  const archived = path.join(dir, 'commands.1.log');
  assert.equal(fs.existsSync(archived), true, '旧文件应该被归档');
  const archivedText = fs.readFileSync(archived, 'utf8');
  assert.ok(archivedText.startsWith('old-line\n'), '归档里是切分前的内容');
  assert.equal(fs.readFileSync(file, 'utf8'), 'tail\n', '新文件从切分后的第一条开始');
});

test('只保留一代归档，第二次轮转覆盖上一次的 .1.log', () => {
  const dir = tempDir();
  const file = path.join(dir, 'commands.log');
  fs.writeFileSync(file, 'FIRST-GENERATION\n', 'utf8');

  appendLogLine(file, PULSE, { maxBytes: 2000 });
  appendLogLine(file, 'second\n', { maxBytes: 2000 });
  assert.match(fs.readFileSync(path.join(dir, 'commands.1.log'), 'utf8'), /FIRST-GENERATION/);

  // 再撑爆一次：第一代归档被覆盖，不能越攒越多。
  appendLogLine(file, PULSE, { maxBytes: 2000 });
  appendLogLine(file, 'third\n', { maxBytes: 2000 });
  const archivedText = fs.readFileSync(path.join(dir, 'commands.1.log'), 'utf8');
  assert.doesNotMatch(archivedText, /FIRST-GENERATION/, '第一代归档应被覆盖');
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.log')).length, 2);
});

test('maxBytes 传 0 表示不设上限', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.log');
  fs.writeFileSync(file, 'x\n', 'utf8');

  appendLogLine(file, PULSE, { maxBytes: 0 });

  assert.equal(fs.existsSync(path.join(dir, 'a.1.log')), false);
  assert.equal(fs.statSync(file).size, 2 + STAT_EVERY_BYTES);
});

test('写不进去时返回 false 且不抛（日志失败不能影响主流程）', () => {
  const missing = path.join(tempDir(), 'no-such-dir', 'a.log');
  assert.equal(appendLogLine(missing, 'line\n'), false);
});

test('rotateLogFile 遇到不存在的文件不抛', () => {
  const dir = tempDir();
  const result = rotateLogFile(path.join(dir, 'nothing.log'));
  // 改名失败后退到 truncate，文件不存在也失败 —— 两种都只是返回 false，不许抛。
  assert.equal(typeof result, 'boolean');
});

test('默认上限是 4 MB', () => {
  assert.equal(DEFAULT_MAX_BYTES, 4 * 1024 * 1024);
});
