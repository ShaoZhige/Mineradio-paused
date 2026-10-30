'use strict';

// 把 DJ 节奏分析挪进 utilityProcess 之后，有两件事必须钉住：
//   1. **降级不能改变行为**。没有 utilityProcess 的环境（npm test、CI、scripts 直跑
//      server.js）必须安静退回进程内调用，而不是抛错。播客锁拍如果只在打包后才坏，
//      代价是整块功能不可用，而这个改动的收益只是「主进程不那么忙」——收益远小于风险，
//      所以这条链必须被测试覆盖。
//   2. **IPC 边界不能信任输入**。主进程和子进程之间传的是普通对象，非法 fn 或非法 URL
//      必须在子进程侧就被拒绝，而不是让 undefined 一路传到解码器里。
// Two invariants after moving DJ beat analysis into a utilityProcess: first, the fallback
// must preserve behaviour exactly in environments without utilityProcess, since the only
// upside of the change is a less busy main thread; second, the IPC boundary validates its
// input rather than letting an unknown function name reach the decoder.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const host = require('../server/dj-analyzer-host');
const worker = require('../server/dj-worker');

function fakeAnalyzer() {
  const calls = [];
  return {
    calls: calls,
    analyzePodcastDjStream: async function (audioUrl, opts) {
      calls.push({ fn: 'stream', audioUrl: audioUrl, opts: opts });
      return { trace: 'stream' };
    },
    analyzePodcastDjIntro: async function (audioUrl, opts) {
      calls.push({ fn: 'intro', audioUrl: audioUrl, opts: opts });
      return { trace: 'intro' };
    },
  };
}

test('代理导出的三个函数与 dj-analyzer 同名同序，调用方无需改动', () => {
  assert.equal(typeof host.analyzePodcastDjStream, 'function');
  assert.equal(typeof host.analyzePodcastDjIntro, 'function');
  assert.equal(typeof host.buildBeatMapFromLowEnergy, 'function');
});

test('没有 utilityProcess 时不启用子进程', { skip: !!process.versions.electron }, () => {
  assert.equal(host.__isWorkerActive(), false);
});

test('非法 URL 会透传到实现层并抛出原始错误，而不是被代理吞掉', async () => {
  await assert.rejects(
    () => host.analyzePodcastDjStream('ftp://example.com/a.mp3', {}),
    /Invalid audio url/
  );
});

test('纯计算函数留在主进程，结果与直接调用一致', () => {
  const direct = require('../server/dj-analyzer');
  const low = new Array(30).fill(0.5);
  const hit = new Array(30).fill(0.5);
  const viaHost = host.buildBeatMapFromLowEnergy(low, hit, 0.01, 0.3);
  const viaDirect = direct.buildBeatMapFromLowEnergy(low, hit, 0.01, 0.3);
  assert.equal(viaHost.duration, viaDirect.duration);
  assert.equal(viaHost.visualBeatCount, viaDirect.visualBeatCount);
});

test('子进程入口只认识 stream / intro 两个动作', async () => {
  const analyzer = fakeAnalyzer();
  assert.deepEqual(Object.keys(worker.ANALYZE_FNS).sort(), ['intro', 'stream']);
  await assert.rejects(
    () => worker.runAnalyzeTask({ id: 1, fn: 'deleteEverything', audioUrl: 'http://x/a.mp3' }, analyzer),
    /Unknown analyze fn/
  );
  assert.equal(analyzer.calls.length, 0);
});

test('子进程入口拒绝非法 URL，不把请求交给解码器', async () => {
  const analyzer = fakeAnalyzer();
  await assert.rejects(
    () => worker.runAnalyzeTask({ id: 2, fn: 'stream', audioUrl: 'file:///tmp/a.mp3' }, analyzer),
    /Invalid audio url/
  );
  assert.equal(analyzer.calls.length, 0);
});

test('子进程入口按 fn 分发，opts 原样透传，回包带上请求 id', async () => {
  const analyzer = fakeAnalyzer();
  const streamReply = await worker.runAnalyzeTask(
    { id: 11, fn: 'stream', audioUrl: 'http://x/a.mp3', opts: { durationSec: 600, userAgent: 'UA' } },
    analyzer
  );
  assert.equal(streamReply.id, 11);
  assert.equal(streamReply.ok, true);
  assert.equal(streamReply.result.trace, 'stream');
  assert.deepEqual(analyzer.calls[0].opts, { durationSec: 600, userAgent: 'UA' });

  const introReply = await worker.runAnalyzeTask(
    { id: 12, fn: 'intro', audioUrl: 'http://x/b.mp3', opts: {} },
    analyzer
  );
  assert.equal(introReply.ok, true);
  assert.equal(introReply.result.trace, 'intro');
  assert.deepEqual(analyzer.calls.map(call => call.fn), ['stream', 'intro']);
});

test('opts 缺失时按空对象处理，不抛异常', async () => {
  const analyzer = fakeAnalyzer();
  const reply = await worker.runAnalyzeTask(
    { id: 13, fn: 'stream', audioUrl: 'http://x/c.mp3' },
    analyzer
  );
  assert.equal(reply.ok, true);
  assert.deepEqual(analyzer.calls[0].opts, {});
});

test('被 require 而不是被 fork 时不会启动消息监听', () => {
  // 测试进程里没有 parentPort，startWorker 必须返回 false 而不是挂上监听。
  assert.equal(process.parentPort, undefined);
  assert.equal(worker.startWorker(), false);
});

test('worker 入口文件与代理在同一目录，fork 路径能拼出来', () => {
  const entry = path.join(__dirname, '..', 'server', 'dj-worker.js');
  assert.equal(require('node:fs').existsSync(entry), true);
});
