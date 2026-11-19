'use strict';

// 退出 MR 不该带走桌面壁纸，这条承诺只靠一个事实成立：wallpaper64.exe 不是 MR 的子进程。
//   1. 拉起引擎本体必须走 desktop-shell broker（父进程 = explorer），detached spawn 只是兜底；
//   2. 引擎已经不在了的时候，「关窗」不该被判定成失败，更不该让退出流程再重试一轮；
//   3. 被新请求替代（START_SUPERSEDED）不是失败，不许落进 startup-error.log。
// 这三条任何一条悄悄退回旧行为，用户看到的就是「关掉 Mineradio，桌面变回默认壁纸」和一堆假错误。
// Exiting Mineradio must never take the desktop wallpaper with it, and that holds only as long as
// wallpaper64.exe is not our child. Each assertion below pins one link of that chain.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { WallpaperEngineRuntime } = require('../desktop/wallpaper-engine-runtime');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-we-parent-'));
const fakeExecutable = path.join(tempRoot, 'wallpaper64.exe');
fs.writeFileSync(fakeExecutable, 'not really an engine');

function createRuntime(overrides = {}) {
  const calls = { spawn: [], control: [] };
  const runtime = new WallpaperEngineRuntime({
    desktopCapturer: { getSources: async () => [] },
    nativeTempPath: path.join(tempRoot, 'native'),
    platform: 'win32',
    arch: 'x64',
    controlCommandLogPath: path.join(tempRoot, `commands-${Math.random().toString(16).slice(2)}.log`),
    controlExecFile: (command, args, options, callback) => {
      calls.control.push({ command, args, options });
      const done = callback;
      if (overrides.controlError) done(new Error('broker failed'));
      else done(null, '', '');
    },
    spawn: (executable, args, options) => {
      calls.spawn.push({ executable, args, options });
      const child = new EventEmitter();
      child.unref = () => { };
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    ...overrides.options,
  });
  runtime.calls = calls;
  return runtime;
}

function commandLogLines(runtime) {
  const target = runtime.controlCommandLogPath;
  if (!target || !fs.existsSync(target)) return [];
  return fs.readFileSync(target, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

// ---------------------------------------------------------------------------
// 1. 引擎本体由 explorer 当父进程拉起
// ---------------------------------------------------------------------------

async function testEngineLaunchUsesExplorerParent() {
  const runtime = createRuntime();
  await runtime._launchEngineBody(fakeExecutable);

  assert.strictEqual(runtime.calls.spawn.length, 0,
    '引擎本体不该再用 spawn 直接挂到 MR 进程树上');
  assert.strictEqual(runtime.calls.control.length, 1, '必须走一次 desktop-shell broker');
  const call = runtime.calls.control[0];
  assert.strictEqual(String(call.command).toLowerCase(), 'powershell.exe');
  assert.ok(call.args.includes('-File'), 'broker 脚本应落盘后执行');
  const env = call.options && call.options.env || {};
  // 空参数 = "启动引擎本体"，命令必须是纯可执行路径，不能混入任何 -control 动作。
  const commandLine = String(env.MINERADIO_WE_CONTROL_COMMAND_LINE || '');
  assert.strictEqual(commandLine.replace(/^"|"$/g, ''), fakeExecutable,
    `引擎启动命令行必须只有可执行路径，实际是 ${commandLine}`);
  assert.ok(!/-control/.test(commandLine),
    '拉起引擎本体的命令里不该出现任何 -control 动作');
  assert.strictEqual(env.MINERADIO_WE_CONTROL_WAIT, '0',
    '引擎常驻，broker 不能在 CreateProcess 之后等它退出');
  assert.strictEqual(env.MINERADIO_WE_CONTROL_TARGET, fakeExecutable);

  const lines = commandLogLines(runtime);
  assert.strictEqual(lines.length, 1, '一次拉起只该记一行命令日志，不能重复记录');
  assert.ok(/\t$/.test(lines[0]), '日志里的命令行应为空（引擎本体，无参数）');
  runtime.dispose && await runtime.stop().catch(() => { });
}

async function testEngineLaunchFallsBackToDetachedSpawn() {
  const runtime = createRuntime({ controlError: true });
  await runtime._launchEngineBody(fakeExecutable);

  assert.strictEqual(runtime.calls.control.length, 1, 'broker 先试一次');
  assert.strictEqual(runtime.calls.spawn.length, 1, 'broker 不可用时必须退回 spawn，不能让壁纸打不开');
  const options = runtime.calls.spawn[0].options || {};
  assert.strictEqual(options.detached, true, '兜底路径同样要解绑');
  assert.deepStrictEqual(runtime.calls.spawn[0].args, [], '拉起的是引擎本体，不该带参数');
}

// ---------------------------------------------------------------------------
// 2. 引擎已消失 ≠ 关窗失败
// ---------------------------------------------------------------------------

async function testEngineProcessIsGoneOnlyOnAConfirmedProbe() {
  const gone = createRuntime({
    options: { engineProcessProbe: async () => ({ ok: true, running: false, matching: false }) },
  });
  assert.strictEqual(await gone._engineProcessIsGone(fakeExecutable), true);

  const otherInstall = createRuntime({
    options: { engineProcessProbe: async () => ({ ok: true, running: true, matching: false }) },
  });
  assert.strictEqual(await otherInstall._engineProcessIsGone(fakeExecutable), true,
    '跑着的是另一个安装的引擎，本会话所在进程同样已经没了');

  const alive = createRuntime({
    options: { engineProcessProbe: async () => ({ ok: true, running: true, matching: true }) },
  });
  assert.strictEqual(await alive._engineProcessIsGone(fakeExecutable), false);

  const probeFailed = createRuntime({
    options: { engineProcessProbe: async () => { throw new Error('tasklist unavailable'); } },
  });
  assert.strictEqual(await probeFailed._engineProcessIsGone(fakeExecutable), false,
    '探测失败绝不能被当成"引擎已退出"——那会把真实的关窗失败记成成功，窗口留在桌面上');
}

function makeSession() {
  return {
    sessionId: 'a'.repeat(24),
    executable: fakeExecutable,
    locationTitle: 'Mineradio Wallpaper sess',
    windowSourceId: '',
    sourceId: '',
    launched: true,
    initialOpenPromise: null,
    stagedProjectRoot: '',
    stagedProjectBaseRoot: '',
  };
}

async function testCloseSessionTreatsGoneEngineAsClosed() {
  const runtime = createRuntime({
    options: { engineProcessProbe: async () => ({ ok: true, running: false, matching: false }) },
  });
  runtime._spawnControl = async () => {
    const error = new Error('WALLPAPER_ENGINE_CONTROL_FAILED');
    error.code = 'WALLPAPER_ENGINE_CONTROL_FAILED';
    throw error;
  };
  const session = makeSession();
  const closed = await runtime._closeSession(session);
  assert.strictEqual(closed, true, '引擎没了，会话必须算作已关闭');
  assert.strictEqual(session.launched, false, '本地状态要跟着收干净');
  assert.ok(!session.closeNotes, '引擎消失不该被记成关窗失败原因');
}

async function testCloseSessionStillFailsOnUnconfirmedProbe() {
  const runtime = createRuntime({
    options: { engineProcessProbe: async () => { throw new Error('probe failed'); } },
  });
  runtime._spawnControl = async () => {
    const error = new Error('WALLPAPER_ENGINE_CONTROL_FAILED');
    error.code = 'WALLPAPER_ENGINE_CONTROL_FAILED';
    throw error;
  };
  const session = makeSession();
  const closed = await runtime._closeSession(session);
  assert.strictEqual(closed, false, '探测不可用时要如实报关窗失败，不能假成功');
  assert.ok(/we-control/.test(String(session.closeNotes || '')), '失败原因要留在会话上');
}

// ---------------------------------------------------------------------------
// 3. START_SUPERSEDED 不算失败
// ---------------------------------------------------------------------------

function testSupersededIsNotLoggedAsFailure() {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  const startBlock = mainSource.slice(
    mainSource.indexOf("const startCode = error.code || error.message || 'WALLPAPER_ENGINE_SCENE_START_FAILED';"),
    mainSource.indexOf("const startCode = error.code || error.message || 'WALLPAPER_ENGINE_SCENE_START_FAILED';") + 1200
  );
  assert.ok(startBlock.includes('WALLPAPER_ENGINE_START_SUPERSEDED'),
    'start 的失败分支必须认得 SUPERSEDED');
  assert.ok(/if \(!superseded\)\s*\{[\s\S]*writeStartupErrorLog\(/.test(startBlock),
    'SUPERSEDED 必须被排除在 writeStartupErrorLog 之外');

  const embedIndex = mainSource.indexOf("writeStartupErrorLog('Wallpaper Engine embed'");
  assert.ok(embedIndex > 0, 'embed 失败仍然要落盘');
  const guard = mainSource.slice(Math.max(0, embedIndex - 400), embedIndex);
  assert.ok(/WALLPAPER_ENGINE_START_SUPERSEDED/.test(guard),
    'embed 分支同样要用 SUPERSEDED 守卫，否则一次连点仍会写出假故障');
}

async function main() {
  await testEngineLaunchUsesExplorerParent();
  await testEngineLaunchFallsBackToDetachedSpawn();
  await testEngineProcessIsGoneOnlyOnAConfirmedProbe();
  await testCloseSessionTreatsGoneEngineAsClosed();
  await testCloseSessionStillFailsOnUnconfirmedProbe();
  testSupersededIsNotLoggedAsFailure();
  console.log('wallpaper-engine-engine-parent: all assertions passed');
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
