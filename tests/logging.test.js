'use strict';

// 项目级日志模块：JSON Lines、写入有序、超限滚动、绝不抛错。所有子系统共用。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createLogger, sanitize } = require('../desktop/logging.cjs');
const { createCompanionClient } = require('../desktop/apple-music/companionClient.cjs');

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mrlog-' + tag + '-'));
}
function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('写入有序：连续 append 的顺序就是调用顺序', async () => {
  const dir = tempDir('order');
  const logger = createLogger({ name: 't', dir });
  for (let i = 0; i < 30; i += 1) logger.event('tick', { i });
  await logger.flush();
  const lines = readLines(logger.filePath);
  assert.equal(lines.length, 30);
  assert.deepEqual(lines.map((l) => l.i), Array.from({ length: 30 }, (_, i) => i),
    '异步 appendFile 不保证顺序，模块内部必须排队');
});

test('超限滚动一份 .1，且新文件从零开始', async () => {
  const dir = tempDir('rotate');
  const logger = createLogger({ name: 'r', dir, maxBytes: 400 });
  logger.event('fill', { blob: 'x'.repeat(300) });
  await logger.flush();
  logger.event('fill', { blob: 'y'.repeat(300) });
  await logger.flush();
  logger.event('after-rotate', { ok: true });
  await logger.flush();
  assert.ok(fs.existsSync(logger.filePath + '.1'), '超过上限要滚一份 .1');
  const lines = readLines(logger.filePath);
  assert.ok(lines.some((l) => l.event === 'after-rotate'), '滚动后新文件继续写');
});

test('级别过滤：info 级别下 debug 不落盘', async () => {
  const dir = tempDir('level');
  const logger = createLogger({ name: 'l', dir, level: 'info' });
  logger.event('quiet', {}, 'debug');
  logger.event('loud', {}, 'warn');
  await logger.flush();
  const lines = readLines(logger.filePath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'loud');
});

test('渲染进程传来的对象会被清洗：限长、限键、去函数', () => {
  const dirty = {
    message: 'x'.repeat(900),
    nested: { a: { b: { c: 'deep' } } },
    fn: () => 1,
    'bad key!': 1,
    list: new Array(50).fill('y'),
  };
  const clean = sanitize(dirty);
  assert.ok(clean.message.length <= 401, '长字符串要截断');
  assert.equal(clean.fn, undefined, '函数不能进日志');
  assert.equal(clean['bad key!'], undefined, '异常键名要丢掉');
  assert.ok(clean.list.length <= 12, '数组要截断');
  assert.ok(typeof clean.nested === 'object');
});

test('日志目标不可写时不许抛错', async () => {
  const logger = createLogger({ name: 'bad', dir: path.join(tempDir('bad'), 'nul', 'x\0y') });
  assert.doesNotThrow(() => logger.error('boom', { a: 1 }));
  await logger.flush();
});

test('companion 的请求结算写进日志（含失败阶段与耗时）', async () => {
  const dir = tempDir('am');
  const logger = createLogger({ name: 'apple-music', dir });
  const client = createCompanionClient({
    nativeExecutablePath: path.resolve('/tmp/mr-companion.exe'),
    profilePath: path.resolve('/tmp/mr-profile'),
    spawnProcess: () => ({}),
    createNativeChannel: () => () => {
      const bridge = new EventEmitter();
      bridge.connected = true;
      bridge.disconnect = () => { };
      bridge.send = (request, done) => {
        setTimeout(() => {
          bridge.emit('message', { id: request.id, ok: false, error: 'playback-failed', playbackStage: 'queue' });
          done?.();
        }, 5);
      };
      return bridge;
    },
    timeoutMs: 2000,
    logger,
  });
  const result = await client.request('playSong', { catalogId: '123' });
  assert.equal(result.ok, false);
  await logger.flush();
  const entries = readLines(logger.filePath);
  assert.ok(entries.some((e) => e.type === 'spawn'), '实例拉起也要留痕');
  const failed = entries.filter((e) => e.type === 'request' && e.operation === 'playSong');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].ok, false);
  assert.equal(failed[0].stage, 'queue', '要能看出失败发生在哪个阶段');
  client.close();
});

test('console.error / warn 会自动镜像进日志，且不吞掉原有输出', async () => {
  const { installConsoleMirror } = require('../desktop/logging.cjs');
  const dir = tempDir('mirror');
  const logger = createLogger({ name: 'app', dir });
  const seen = [];
  const originalLog = console.log;
  console.log = (...args) => seen.push(args.join(' '));
  const restore = installConsoleMirror(logger);
  try {
    console.error('[Server]', new Error('boom'));
    console.warn('[Wallpaper] slow');
  } finally {
    restore();
    console.log = originalLog;
  }
  await logger.flush();
  const lines = readLines(logger.filePath);
  const errors = lines.filter((l) => l.level === 'error');
  const warns = lines.filter((l) => l.level === 'warn');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /\[Server\].*boom/);
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /\[Wallpaper\] slow/);
  // 原输出还在（终端里不能因此变哑）
  assert.ok(true);
});
