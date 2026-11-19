'use strict';

// 启用壁纸这条链路上"每次都要付、又看不出来"的几笔开销，靠的是几个容易被无意改掉的行为：
//   1. 预热能不能按调用方的意思决定「只准备、不拉引擎」还是「连引擎一起热起来」；
//   2. 控制宿主在启动一开始就预热，而不是等第一个窗口动作；
//   3. 刚确认过的静音属性不再重复发（一次就是一条 WE 控制进程）；
//   4. 定时重发必须仍然真的发出去，不能被上面的复用短路掉；
//   5. 每个阶段的耗时真的落盘，否则下次优化又只能靠猜。
// 这些行为失效时功能完全看不出问题，只是慢回去了 —— 所以必须有断言。
// Every one of these can silently stop working with the feature still looking correct, and the
// only symptom is the old latency coming back. Hence behavioural assertions.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { WallpaperEngineRuntime } = require('../desktop/wallpaper-engine-runtime');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-we-pipeline-'));
const fakeExecutable = path.join(tempRoot, 'wallpaper64.exe');
fs.writeFileSync(fakeExecutable, 'not really an engine');

function createRuntime(overrides = {}) {
  const calls = { transient: [], spawned: [], hostSpawned: 0 };
  const runtime = new WallpaperEngineRuntime({
    platform: 'win32',
    arch: 'x64',
    nativeTempPath: path.join(tempRoot, 'native'),
    desktopCapturer: { getSources: async () => [] },
    discoverSteamLibraries: async () => [tempRoot],
    controlExecFile: (file, args, options, callback) => {
      calls.transient.push([file, ...(Array.isArray(args) ? args : [])]);
      const done = typeof options === 'function' ? options : callback;
      queueMicrotask(() => done(null, '', ''));
      return new EventEmitter();
    },
    spawn: (file, args) => {
      calls.spawned.push([file, ...(Array.isArray(args) ? args : [])]);
      const child = new EventEmitter();
      child.unref = () => { };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    ...overrides,
  });
  runtime.calls = calls;
  return runtime;
}

function createSession(runtime) {
  const session = {
    id: 'probe',
    sessionId: 'a'.repeat(24),
    locationTitle: 'Mineradio Wallpaper probe',
    executable: fakeExecutable,
    muteProperties: { volume: 0 },
    userProperties: {},
    muteReassertTimers: new Set(),
    audioMuted: false,
    stopping: false,
  };
  runtime.active = session;
  return session;
}

// ---------------------------------------------------------------------------
// 1. 预热：默认不拉引擎，明确要求时才拉
// ---------------------------------------------------------------------------

async function testWarmUpLeavesAStoppedEngineAlone() {
  const runtime = createRuntime();
  let bootstrapped = 0;
  runtime._discoverExecutable = async () => ({ available: true, executable: fakeExecutable });
  runtime._fastEnginePids = async () => [];
  runtime._ensureEngineReady = async () => {
    bootstrapped += 1;
    return fakeExecutable;
  };
  runtime.residentWindowController = false;
  const result = await runtime.warmUp();
  assert.strictEqual(bootstrapped, 0, '仅打开列表不许把引擎拉起来');
  assert.strictEqual(result.launched, false);
  assert.strictEqual(runtime.active, null);
  assert.strictEqual(runtime.pending, null);
}

async function testWarmUpLaunchesWhenAsked() {
  const runtime = createRuntime();
  const seen = [];
  runtime._discoverExecutable = async () => ({ available: true, executable: fakeExecutable });
  runtime._fastEnginePids = async () => [];
  runtime._ensureEngineReady = async (executable, silentWindows) => {
    seen.push([executable, silentWindows]);
    return fakeExecutable;
  };
  runtime.residentWindowController = true;
  runtime.windowControlSpawn = () => {
    runtime.calls.hostSpawned += 1;
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => true;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => { };
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => { };
    child.killed = false;
    child.unref = () => { };
    child.kill = () => { child.killed = true; child.emit('exit', 0); };
    queueMicrotask(() => setTimeout(() => child.stdout.emit('data', '{"ready":true}\n'), 0));
    return child;
  };
  const result = await runtime.warmUp({ engine: 'launch', silentWindows: false });
  assert.strictEqual(seen.length, 1, 'engine:launch 必须真的引导引擎');
  assert.strictEqual(seen[0][1], false, '静默设置必须透传，否则预热出的引擎行为与正式启动不一致');
  assert.strictEqual(result.launched, true);
  assert.strictEqual(result.helper, true, '预热必须顺带把窗口控制宿主编译好');
  assert.strictEqual(runtime.calls.hostSpawned, 1);
  runtime._stopWindowControlHost('test');
}

// ---------------------------------------------------------------------------
// 2. 控制宿主在启动一开始就预热，不等第一个窗口动作
// ---------------------------------------------------------------------------

function testControlHostWarmupIsFireAndForget() {
  const runtime = createRuntime();
  runtime.residentWindowController = true;
  let started = 0;
  runtime._ensureWindowControlHost = () => {
    started += 1;
    return Promise.resolve({ ready: true });
  };
  runtime._warmWindowControlHost();
  assert.strictEqual(started, 1, '启动一开始就要发起宿主预热');
  // 宿主起不来（没有 PowerShell、被杀）时不能把异常抛进启动流程。
  runtime._ensureWindowControlHost = () => {
    throw new Error('no powershell');
  };
  assert.doesNotThrow(() => runtime._warmWindowControlHost());
  runtime._ensureWindowControlHost = () => Promise.reject(new Error('no powershell'));
  assert.doesNotThrow(() => runtime._warmWindowControlHost());
}

// ---------------------------------------------------------------------------
// 3/4. 静音属性：刚确认过就复用，定时重发仍然强制
// ---------------------------------------------------------------------------

async function testAcknowledgedMuteIsNotResent() {
  const runtime = createRuntime();
  const session = createSession(runtime);
  assert.strictEqual(await runtime._applySessionMute(session), true);
  assert.strictEqual(runtime.calls.transient.length, 1);
  // 紧接着再要一次（`confirmCaptureReady` 就是这种时序）：窗口没重建，属性也没变。
  assert.strictEqual(await runtime._applySessionMute(session), true);
  assert.strictEqual(runtime.calls.transient.length, 1, '刚确认过的静音不许再起一个 WE 控制进程');
}

async function testReassertAlwaysSends() {
  const runtime = createRuntime();
  const session = createSession(runtime);
  await runtime._applySessionMute(session);
  await runtime._applySessionMute(session, { reassert: true });
  assert.strictEqual(runtime.calls.transient.length, 2, '定时重发必须真的发出去，它就是用来盖掉重建后被重置的属性');
  // 提权路径会把命令行编码进 PowerShell 参数（-EncodedCommand），所以这里只钉住"真的发出
  // 了两次命令调用"，不去匹配被编码后的载荷。
  // The elevated path base64-encodes the command line, so only the two real invocations are
  // pinned here; the encoded payload itself is not matchable.
  assert.ok(runtime.calls.transient.every((entry) => entry.length >= 2),
    '每次重发都必须是一次真实命令调用');
  assert.strictEqual(runtime.calls.transient[0][0], runtime.calls.transient[1][0],
    '两次重发必须用同一个可执行目标');
}

async function testChangedPayloadIsResent() {
  const runtime = createRuntime();
  const session = createSession(runtime);
  await runtime._applySessionMute(session);
  session.userProperties = { custom: 7 };
  await runtime._applySessionMute(session);
  assert.strictEqual(runtime.calls.transient.length, 2, '属性变了就必须重新下发');
}

// ---------------------------------------------------------------------------
// 5. 阶段耗时落盘
// ---------------------------------------------------------------------------

function testStartTimingIsPersisted() {
  const timingPath = path.join(tempRoot, 'timing.log');
  const runtime = createRuntime({ startTimingLogPath: timingPath });
  const startedAt = Date.now() - 4200;
  const marks = [
    ['discover-target', startedAt],
    ['ensure-engine-ready', startedAt + 120],
    ['open-initial-window', startedAt + 4000],
    ['find-initial-source', startedAt + 4100],
  ];
  runtime._logStartTiming({ id: 'abc' }, startedAt, marks, 'ok');
  const lines = fs.readFileSync(timingPath, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.ok(/total=4\d{3}/.test(lines[0]), '必须记总耗时');
  assert.ok(/discover-target=\d+/.test(lines[0]));
  // 阶段标记是「进入时刻」，所以每个数字是它和上一个标记之间的差值。
  assert.ok(/discover-target=0/.test(lines[0]), '第一个阶段从开始那一刻算起');
  assert.ok(/ensure-engine-ready=120/.test(lines[0]));
  assert.ok(/open-initial-window=3880/.test(lines[0]), '阶段耗时必须是相邻标记的差值');
  assert.ok(/post=\d+/.test(lines[0]), '最后一次标记到返回之间的收尾也要记');
  assert.ok(/id=abc/.test(lines[0]));
  // 没有配置路径时静默跳过，绝不因为写日志失败影响启动。
  const silent = createRuntime();
  assert.doesNotThrow(() => silent._logStartTiming({ id: 'x' }, startedAt, marks, 'ok'));
}

// ---------------------------------------------------------------------------
// 6. 引擎窗口监视器：目标没变就复用，不重启 PowerShell
// ---------------------------------------------------------------------------

function testEngineMonitorIsReusedForTheSameTargets() {
  const runtime = createRuntime();
  let spawned = 0;
  runtime.spawn = (file, args) => {
    spawned += 1;
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => true;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => { };
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => { };
    child.exitCode = null;
    child.unref = () => { };
    child.kill = () => { child.killed = true; child.emit('exit', 0); };
    return child;
  };
  runtime._startEngineWindowIsolationMonitor(['wallpaper64.exe']);
  runtime._startEngineWindowIsolationMonitor(['wallpaper64.exe']);
  assert.strictEqual(spawned, 1, '目标集合没变时不许再起一个监视器');
  runtime._startEngineWindowIsolationMonitor(['wallpaper64.exe', 'wallpaperui.exe']);
  assert.strictEqual(spawned, 2, '目标集合变了必须重建');
  runtime._stopEngineWindowIsolationMonitor();
}

// ---------------------------------------------------------------------------
// 7. 开窗命令不再阻塞窗口轮询
// ---------------------------------------------------------------------------

function testOpenCommandDoesNotBlockPolling() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'wallpaper-engine-runtime.js'), 'utf8');
  assert.ok(
    /initialOpenPromise = this\._openInitialSessionWindow\(session, generation\);/.test(source),
    '开窗命令必须与窗口轮询并行发起'
  );
  assert.ok(
    /checkAbort: \(\) => openFailure,/.test(source),
    '开窗命令失败必须中止轮询，否则一次"命令没送到"会报成 15 秒窗口超时'
  );
  assert.ok(
    /if \(initialOpenPromise\) await initialOpenPromise\.catch\(\(\) => \{\}\);/.test(source),
    '失败清理前必须等开窗命令落定，否则会把已开出来的窗口当成没开过'
  );
}

(async () => {
  const cases = [
    ['预热不动没在跑的引擎', testWarmUpLeavesAStoppedEngineAlone],
    ['预热按请求拉起引擎并透传静默设置', testWarmUpLaunchesWhenAsked],
    ['控制宿主预热是即发即忘', testControlHostWarmupIsFireAndForget],
    ['刚确认的静音不重发', testAcknowledgedMuteIsNotResent],
    ['定时重发强制发送', testReassertAlwaysSends],
    ['属性变化必须重发', testChangedPayloadIsResent],
    ['阶段耗时落盘', testStartTimingIsPersisted],
    ['引擎监视器复用同一目标', testEngineMonitorIsReusedForTheSameTargets],
    ['开窗命令不阻塞轮询', testOpenCommandDoesNotBlockPolling],
  ];
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      console.log('ok - ' + name);
    } catch (error) {
      failed += 1;
      console.log('not ok - ' + name);
      console.log(String(error && error.stack || error).split('\n').slice(0, 6).join('\n'));
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (failed) {
    console.log(failed + ' case(s) failed');
    process.exitCode = 1;
  }
})();
