'use strict';

// Spotify 客户端通道日志：格式、去噪与"未配置即空操作"。
// Offline: the log format, the noise rules, and the no-op default.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('../desktop/spotify-client-log');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-spotify-log-'));
const file = path.join(dir, log.LOG_FILE_NAME);

try {
  // ── 1. 未配置时什么都不写 ──────────────────────────────────────────────────
  assert.strictEqual(log.logSpotifyClientPath(), '', 'nothing is configured by default');
  assert.strictEqual(log.spotifyClientLog('launch', { port: 1 }), false, 'an unconfigured log is a no-op');
  assert.strictEqual(fs.existsSync(file), false, 'no file may appear before configure()');

  // ── 2. 一行一条，字段以两个空格分隔 ────────────────────────────────────────
  assert.strictEqual(log.configure({ dir }), file, 'configure returns the file it will write');
  assert.strictEqual(log.spotifyClientLog('launch', { port: 51234, pid: 88 }), true);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.strictEqual(lines.length, 1, 'one call is one line');
  assert.ok(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z {2}launch {2}port=51234 {2}pid=88$/.test(lines[0]), 'unexpected record format: ' + lines[0]);

  // ── 3. 空值被跳过，换行被压平，长串被截断 ─────────────────────────────────
  log.spotifyClientLog('channel-miss', { port: 1, error: 'line1\r\nline2\ttab', empty: '', nil: null, undef: undefined });
  log.spotifyClientLog('command-failed', { name: 'Pause', error: 'x'.repeat(400) });
  const records = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const miss = records[1];
  assert.ok(/channel-miss {2}port=1 {2}error=line1 line2 tab$/.test(miss), 'newlines and tabs must be flattened: ' + miss);
  assert.ok(miss.indexOf('empty=') === -1 && miss.indexOf('nil=') === -1, 'empty fields are dropped');
  const failed = records[2];
  assert.ok(failed.length < 320, 'a long error must be capped, got ' + failed.length + ' chars');
  assert.ok(failed.indexOf('…') !== -1, 'a truncated value is marked');

  // ── 4. 没事件名就整条丢掉，不写半行 ────────────────────────────────────────
  const before = fs.readFileSync(file, 'utf8').length;
  assert.strictEqual(log.spotifyClientLog('', { port: 1 }), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8').length, before, 'a nameless record must not reach the file');

  console.log('spotify-client-log: all assertions passed');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
}
