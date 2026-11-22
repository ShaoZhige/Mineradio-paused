'use strict';

// 冷启动回归：启动 MR 后第一首就是 Apple Music 时，伴生进程的父通道还在握手，
// 以前 `request()` 看到 `child.connected === false` 会**立刻**回 runtime-unavailable
// （不重试），于是首曲永远放不出来；同时 `start()` 每被调用一次就又 spawn 一个伴生实例。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createCompanionClient } = require('../desktop/apple-music/companionClient.cjs');

// 一个"握手会慢一点"的假通道：spawn 后 240ms 才 connected。
// createNativeChannel(options) 必须**返回** spawn 函数本身。
function slowChannel(state) {
  return () => ((nativeExecutablePath, args) => {
    state.spawned += 1;
    const bridge = new EventEmitter();
    bridge.connected = false;
    bridge.disconnect = () => { bridge.connected = false; bridge.emit('disconnect'); };
    bridge.send = (request, done) => {
      setTimeout(() => {
        if (!bridge.connected) { done?.(new Error('disconnected')); return; }
        bridge.emit('message', { id: request.id, ok: true, data: { isPlaying: false } });
        done?.();
      }, 8);
    };
    setTimeout(() => { bridge.connected = true; }, 240);
    return bridge;
  });
}

function makeClient(state) {
  return createCompanionClient({
    // Windows 下 path.isAbsolute 需要盘符路径；这里用 posix 绝对路径也能通过校验。
    nativeExecutablePath: path.resolve('/tmp/mr-companion.exe'),
    profilePath: path.resolve('/tmp/mr-profile'),
    spawnProcess: () => ({}),
    createNativeChannel: slowChannel(state),
    timeoutMs: 5000,
  });
}

test('冷启动时第一个请求要等通道握手，不能直接判失败', async () => {
  const state = { spawned: 0 };
  const client = makeClient(state);
  const started = Date.now();
  const result = await client.request('playbackStatus', {});
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true, `第一个请求失败了: ${JSON.stringify(result)}`);
  assert.ok(elapsed >= 200, `应当等待握手完成，实际只用了 ${elapsed}ms`);
  assert.equal(state.spawned, 1, '握手期间不许重复 spawn 伴生进程');
  client.close();
});

test('握手完成后连续请求复用同一个伴生实例', async () => {
  const state = { spawned: 0 };
  const client = makeClient(state);
  await client.request('playbackStatus', {});
  await client.request('playbackStatus', {});
  await client.request('pause', {});
  assert.equal(state.spawned, 1, `重复 spawn 了 ${state.spawned} 次`);
  client.close();
});

// 冷启动预热只做"唤醒"：warm 必须是一个合法且不需要参数的操作，并且在页面还没配好时
// 也要立刻答 ok（否则调用方又会重试，把串行通道占住）。
test('warm 是合法操作，且不等 MusicKit 就答 ok', () => {
  const fs = require('node:fs');
  const { validateRequest } = require('../desktop/apple-music/companionRequests.cjs');
  const validated = validateRequest({ id: 'request_1', operation: 'warm' });
  assert.ok(validated, 'warm 必须通过校验');
  assert.deepEqual(validated.params, {}, 'warm 不接受参数');

  const src = fs.readFileSync(
    require('node:path').join(__dirname, '..', 'desktop/apple-music/companionRequests.cjs'), 'utf8');
  const warmAt = src.indexOf("if (request.operation === 'warm')");
  const gateAt = src.indexOf("if (!call) return { ok: false, error: 'not-ready' };");
  assert.ok(warmAt > 0 && gateAt > 0);
  assert.ok(warmAt < gateAt, 'warm 必须在 !call 门禁之前返回，否则页面没配好就变成 not-ready');
});

// 我上一版把 start() 改成"只要有 child 就复用"，但没给时限：一个进程还活着、通道却永远握不上
// 手的实例会让每个请求都熬满 25 秒超时 —— 界面表现就是"加载奇慢"。现在超过预算就换掉重来。
test('握不上手的伴生实例要被换掉，而不是让每个请求干等超时', async () => {
  const { EventEmitter } = require('node:events');
  const path = require('node:path');
  const state = { spawned: 0 };
  const client = createCompanionClient({
    nativeExecutablePath: path.resolve('/tmp/mr-companion.exe'),
    profilePath: path.resolve('/tmp/mr-profile'),
    spawnProcess: () => ({}),
    // 这个通道永远不 connected：模拟"进程在、通道死"。
    createNativeChannel: () => () => {
      state.spawned += 1;
      const bridge = new EventEmitter();
      bridge.connected = false;
      bridge.send = () => { };
      bridge.disconnect = () => { bridge.emit('disconnect'); };
      return bridge;
    },
    timeoutMs: 1200,
    handshakeTimeoutMs: 200,
  });
  const started = Date.now();
  const result = await client.request('playbackStatus', {});
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 2500, `不该熬满超时，实际 ${elapsed}ms`);
  assert.ok(state.spawned >= 2, `握不上手要重开一个，实际 spawn ${state.spawned} 次`);
  client.close();
});

// 用户复现：刚启动（宿主没起来）直接播 AM 歌会失败。现在起播前先 warm 把宿主/页面拉起来，
// 并且对"页面刚加载、MusicKit 还没配好"的 playback-failed 再试一次。
test('冷启动先 warm 再 playSong，两步都成功且只 spawn 一次', async () => {
  const { EventEmitter } = require('node:events');
  const path = require('node:path');
  const state = { spawned: 0, sent: [] };
  const client = createCompanionClient({
    nativeExecutablePath: path.resolve('/tmp/mr-companion.exe'),
    profilePath: path.resolve('/tmp/mr-profile'),
    spawnProcess: () => ({}),
    createNativeChannel: () => () => {
      state.spawned += 1;
      const bridge = new EventEmitter();
      bridge.connected = false;
      bridge.disconnect = () => { };
      bridge.send = (request, done) => {
        state.sent.push(request.operation);
        setTimeout(() => { bridge.emit('message', { id: request.id, ok: true, data: {} }); done?.(); }, 5);
      };
      setTimeout(() => { bridge.connected = true; }, 180);
      return bridge;
    },
    timeoutMs: 4000,
  });
  const warm = await client.request('warm', {});
  assert.equal(warm.ok, true, 'warm 要先成功（它负责把页面拉起来）');
  const play = await client.request('playSong', { catalogId: '123' });
  assert.equal(play.ok, true, 'warm 之后 playSong 必须成功');
  assert.deepEqual(state.sent, ['warm', 'playSong']);
  assert.equal(state.spawned, 1, '两步共用一个宿主');
  client.close();
});

test('起播路径：warm 在 playSong 之前，且 playback-failed 会重试一次', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/08-account/tribute-to-steve-jobs.js'), 'utf8');
  const at = src.indexOf('async function startExternalAppleMusicPlayback(');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\nasync function ', at + 30));
  const warmAt = body.indexOf("externalAppleMusicRequest('warm'");
  const playAt = body.indexOf("externalAppleMusicRequest('playSong'");
  assert.ok(warmAt > 0, '起播前必须先 warm');
  assert.ok(warmAt < playAt, 'warm 必须在 playSong 之前');
  assert.match(body, /result\.error === 'playback-failed'/, '页面临时没就绪要能识别');
  assert.ok((body.match(/externalAppleMusicRequest\('playSong'/g) || []).length >= 2,
    'playback-failed 之后要再发一次 playSong');
  assert.match(body, /var hadLiveCompanion = !!\(previous && previous\.provider === 'applemusic'\)/,
    '要在清空状态之前判断宿主是否还活着');
  assert.match(body, /if \(!hadLiveCompanion\) \{/, '会话内切歌不必重复 warm');
});

// 库内歌曲只有 i.xxx 这种 id，MusicKit 的 setQueue 只认 catalog id（Apple 官方论坛有明确案例：
// 传 i.xxx 静默不播）。所以起播前要先换算，并把"换不到"的情况记进日志。
test('库 id 先换成 catalogId 再起播，换不到要留痕', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { validateRequest } = require('../desktop/apple-music/companionRequests.cjs');

  assert.ok(validateRequest({ id: 'request_1', operation: 'resolveSong', params: { songId: 'i.abc123' } }),
    'resolveSong 必须是合法操作');
  assert.equal(validateRequest({ id: 'request_1', operation: 'resolveSong', params: { songId: '123' } }), null,
    '只接受库 id，别的形状一律拒绝');

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/08-account/tribute-to-steve-jobs.js'), 'utf8');
  const at = src.indexOf('async function resolveAppleMusicCatalogId(');
  assert.ok(at > 0, '缺少库 id 换算函数');
  assert.match(src, /externalAppleMusicRequest\('resolveSong', \{ songId: catalogId \}\)/);
  assert.match(src, /appleMusicCatalogIdCache\.set\(catalogId, catalog\)/, '换算结果要缓存');

  const startAt = src.indexOf('async function startExternalAppleMusicPlayback(');
  const body = src.slice(startAt, src.indexOf('stopExternalPlaybackPolling();', startAt));
  assert.match(body, /catalogId = await resolveAppleMusicCatalogId\(catalogId\);/, '前置校验失败前必须先换算');
  assert.match(body, /logEvent\('playback', 'am-start-rejected'/, '换不到 catalogId 必须留痕（以前完全没日志）');
});

// 2026-11-22 事故：用户点歌后"没有任何报错，但也永远不播"。
// 真实链路是：页面里 `await mk.setQueue(...)` 永不 settle（曲目在当前 storefront 不可用 /
// DRM 授权卡住时都会这样），宿主串行处理请求 → 之后连轻量的 `warm` 都排在它后面等 20 秒超时，
// 通道还"连着"，所以不会自我恢复。修法两层：
//   1. 页面侧给 setQueue / controlQueue 加硬上限，超时返回 playback-timeout（不是静默挂死）；
//   2. 父进程收到 timeout / playback-timeout 就断开通道，让下一次请求重新 spawn 干净宿主。
test('页面侧给 setQueue 加硬上限，超时报 playback-timeout 而不是挂死', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'desktop/apple-music/companionRequests.cjs'), 'utf8');

  assert.match(src, /const withMusickitDeadline = \(promise, stage, budgetMs = 12000\)/, '缺少硬上限包装');
  assert.match(src, /withMusickitDeadline\(\s*mk\.setQueue\(/, 'setQueue 必须带上限');
  assert.match(src, /withMusickitDeadline\(controlQueue\(/, 'controlQueue 也必须带上限');
  assert.match(src, /error: timedOut \? 'playback-timeout' : 'playback-failed'/,
    '超时与普通拒绝必须用不同错误码，否则上层会盲目重建宿主');
  // 这个函数是被 toString() 注入页面的：模块作用域的辅助函数在页面里不存在，
  // 放外面会让每个请求都抛 ReferenceError（表现为"点歌没反应"）。
  const bodyStart = src.indexOf('async function readFromPage(');
  const helperAt = src.indexOf('const withMusickitDeadline = (promise, stage');
  assert.ok(bodyStart > 0 && helperAt > bodyStart,
    '超时包装必须定义在 readFromPage 内部，否则注入页面后会不生效');
});

test('宿主不回话时父进程要断开通道，下一次请求重开一个干净实例', async () => {
  const { EventEmitter } = require('node:events');
  const path = require('node:path');
  const state = { spawned: 0 };

  // 通道秒连上，但 send 永远不回调 —— 复现"页面卡住、请求石沉大海"。
  const hangingChannel = () => ((nativeExecutablePath, args) => {
    state.spawned += 1;
    const bridge = new EventEmitter();
    bridge.connected = true;
    bridge.disconnect = () => { bridge.connected = false; bridge.emit('disconnect'); };
    bridge.send = () => { /* 故意不回 */ };
    return bridge;
  });

  const client = createCompanionClient({
    nativeExecutablePath: path.resolve('/tmp/mr-companion.exe'),
    profilePath: path.resolve('/tmp/mr-profile'),
    spawnProcess: () => ({}),
    createNativeChannel: hangingChannel,
    timeoutMs: 300,
  });

  const first = await client.request('playbackStatus', {});
  assert.equal(first.ok, false);
  assert.equal(first.error, 'timeout', `应当先超时，实际 ${JSON.stringify(first)}`);

  const second = await client.request('playbackStatus', {});
  assert.equal(second.ok, false);
  assert.equal(state.spawned, 2, '超时后必须换一个宿主，否则会一直堵在旧队列后面');

  client.close();
});
