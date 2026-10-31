'use strict';

// 启用壁纸时的固定开销能不能被省掉，全看三件事有没有真的生效：
//   1. 跨启动复用的「引擎已就绪」结论（tasklist 快路，不再起两次 PowerShell）；
//   2. 常驻的窗口控制宿主（C# 只编译一次，isolate/embed/close 走同一个进程）；
//   3. 打开壁纸库时的预热（只做固定开销，绝不替用户拉起引擎）。
// 这三条任何一条悄悄失效，速度都会退回每次 7~11 秒，而功能看起来一切正常 —— 所以必须有
// 行为级断言，而不是只看源码里有没有那行字。
// Each of these can silently stop working while the feature still looks fine, and the cost goes
// straight back to 7-11 seconds per activation. Hence behavioural assertions.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { WallpaperEngineRuntime } = require('../desktop/wallpaper-engine-runtime');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-we-accel-'));
const fakeExecutable = path.join(tempRoot, 'wallpaper64.exe');
fs.writeFileSync(fakeExecutable, 'not really an engine');
const fakeStat = fs.statSync(fakeExecutable);
const fakeStamp = `${fakeStat.size}:${Math.round(fakeStat.mtimeMs)}`;

function sealSignatureCache(file) {
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    entries: { [path.resolve(fakeExecutable).toLowerCase()]: { stamp: fakeStamp, valid: true } },
  }) + '\n', 'utf8');
}

function createRuntime(overrides = {}) {
  const calls = { tasklist: 0, execFile: [], spawn: [] };
  const runtime = new WallpaperEngineRuntime({
    desktopCapturer: { getSources: async () => [] },
    nativeTempPath: path.join(tempRoot, 'native'),
    platform: 'win32',
    arch: 'x64',
    nativeExecFile: (command, args, options, callback) => {
      calls.execFile.push([command, ...(Array.isArray(args) ? args : [])]);
      const done = typeof options === 'function' ? options : callback;
      if (String(command).toLowerCase().startsWith('tasklist')) {
        calls.tasklist += 1;
        done(null, typeof overrides.tasklistOutput === 'string'
          ? overrides.tasklistOutput
          : '"wallpaper64.exe","4242","Console","1","100,000 K"\r\n"explorer.exe","8","Console","1","1 K"\r\n');
        return;
      }
      done(null, '');
    },
    ...overrides.options,
  });
  runtime.calls = calls;
  return runtime;
}

function createFakeHelper() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.unref = () => { };
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0);
  };
  return child;
}

async function makeResidentRuntime(extra = {}) {
  const spawned = [];
  const runtime = createRuntime({
    ...extra,
    options: {
      residentWindowController: true,
      windowControlSpawn: () => {
        const child = createFakeHelper();
        spawned.push(child);
        child.stdout.write('{"ready":true}\n');
        return child;
      },
      ...(extra.options || {}),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { runtime, spawned };
}

// ---------------------------------------------------------------------------
// 1. 常驻宿主：一个进程服务所有窗口控制动作
// ---------------------------------------------------------------------------

async function testResidentHostReusesOneProcess() {
  const { runtime, spawned } = await makeResidentRuntime();
  const commands = [];
  const originalSpawn = runtime.windowControlSpawn;
  runtime.windowControlSpawn = (...args) => {
    const child = originalSpawn(...args);
    child.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        commands.push(JSON.parse(line));
      }
      child.stdout.write(JSON.stringify({ id: commands.length, ok: true, embedded: true, aligned: true }) + '\n');
    });
    return child;
  };

  const embed = (sourceId) => runtime.windowController('embed', {
    sourceId,
    locationTitle: 'Mineradio Wallpaper probe',
    executable: fakeExecutable,
    hostWindowId: '1234',
    hostExecutable: fakeExecutable,
    cornerRadius: 12,
  });

  const first = await embed('window:11:0');
  const second = await embed('window:12:0');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(spawned.length, 1, '两个动作必须复用同一个宿主进程');
  assert.strictEqual(commands.length, 2);
  assert.deepStrictEqual(
    commands.map((entry) => entry.action),
    ['embed', 'embed']
  );
  assert.strictEqual(commands[0].cornerRadius, '12', '宿主收到的参数必须与单次脚本一致');
  assert.strictEqual(commands[0].hostWindowId, '1234');
  runtime._stopWindowControlHost('test');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(spawned[0].killed, true, '停止宿主必须真的结束进程');
}

async function testResidentHostIdleReap() {
  const { runtime, spawned } = await makeResidentRuntime({
    options: { windowControlHostIdleMs: 1000 },
  });
  runtime.windowControlSpawn = ((original) => (...args) => {
    const child = original(...args);
    child.stdin.on('data', () => child.stdout.write('{"id":1,"ok":true}\n'));
    return child;
  })(runtime.windowControlSpawn);
  await runtime.windowController('isolate', { sourceId: 'window:1:0', executable: fakeExecutable });
  assert.strictEqual(spawned.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.strictEqual(spawned[0].killed, true, '空闲超过阈值后宿主必须自己退出，不能常驻占内存');
  assert.strictEqual(runtime.windowControlHost, null);
}

async function testResidentHostTimeoutFailsOver() {
  const { runtime, spawned } = await makeResidentRuntime({
    options: { windowControlHostCommandTimeoutMs: 60 },
  });
  // 宿主不回应：整条调用必须在超时后失败，并且把宿主收掉，而不是永远等下去，
  // 也不该退回单次脚本把等待翻倍。
  await assert.rejects(
    () => runtime.windowController('embed', { sourceId: 'window:1:0', executable: fakeExecutable }),
    (error) => error.nativeStage === 'host-timeout' && /ISOLATION_FAILED/.test(error.code)
  );
  assert.strictEqual(runtime.windowControlHost, null);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(spawned[0].killed, true);
}

async function testResidentHostStartupFailureFallsBack() {
  const runtime = createRuntime({
    options: {
      residentWindowController: true,
      windowControlSpawn: () => {
        throw new Error('spawn failed');
      },
    },
  });
  runtime.nativeExecFile = (command, args, options, callback) => {
    runtime.calls.execFile.push([command, ...(Array.isArray(args) ? args : [])]);
    const done = typeof options === 'function' ? options : callback;
    done(null, '{"ok":true,"embedded":true,"aligned":true}\n');
  };
  const result = await runtime.windowController('embed', {
    sourceId: 'window:5:0',
    executable: fakeExecutable,
    hostWindowId: '999',
  });
  assert.strictEqual(result.ok, true, '宿主起不来时必须退回单次脚本，功能不能中断');
  const usedOneShot = runtime.calls.execFile.some(([command]) => /powershell/i.test(command));
  assert.strictEqual(usedOneShot, true, '退回路径必须真的调用了一次性 PowerShell 脚本');
}

// ---------------------------------------------------------------------------
// 2. 引擎就绪：跨启动复用结论，只在进程集合变化时重验
// ---------------------------------------------------------------------------

async function testFastEngineReadySkipsProbe() {
  const cachePath = path.join(tempRoot, 'engine-ready-ok.json');
  sealSignatureCache(path.join(tempRoot, 'signatures-ok.json'));
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    executable: fakeExecutable,
    pidsKey: '4242',
    verifiedAt: Date.now(),
  }) + '\n', 'utf8');

  let probed = 0;
  const runtime = createRuntime({
    options: {
      fastEngineProbe: true,
      engineReadyCachePath: cachePath,
      signatureCachePath: path.join(tempRoot, 'signatures-ok.json'),
      engineProcessProbe: async () => {
        probed += 1;
        return { ok: true, running: true, matching: true, executable: fakeExecutable, matchingPids: [4242] };
      },
      engineReadyProbe: async () => true,
    },
  });

  const effective = await runtime._ensureEngineReady(fakeExecutable, false);
  assert.strictEqual(path.resolve(effective), path.resolve(fakeExecutable));
  assert.strictEqual(probed, 0, '进程集合没变时不许再做 PowerShell 进程探测');
  assert.strictEqual(runtime.calls.tasklist, 1, '快路只应问一次 tasklist');
  assert.strictEqual(runtime.calls.execFile.filter(([command]) => /powershell/i.test(command)).length, 0);
}

async function testFastEngineReadyFallsBackOnNewPid() {
  const cachePath = path.join(tempRoot, 'engine-ready-stale.json');
  sealSignatureCache(path.join(tempRoot, 'signatures-stale.json'));
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    executable: fakeExecutable,
    pidsKey: '1111',
    verifiedAt: Date.now(),
  }) + '\n', 'utf8');

  let probed = 0;
  const runtime = createRuntime({
    options: {
      fastEngineProbe: true,
      engineReadyCachePath: cachePath,
      signatureCachePath: path.join(tempRoot, 'signatures-stale.json'),
      engineProcessProbe: async () => {
        probed += 1;
        return { ok: true, running: true, matching: true, executable: fakeExecutable, matchingPids: [4242] };
      },
      engineReadyProbe: async () => true,
    },
  });

  await runtime._ensureEngineReady(fakeExecutable, false);
  assert.ok(probed >= 1, '进程集合变了就必须回到完整校验');
  const persisted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.strictEqual(persisted.pidsKey, '4242', '完整校验通过后必须把新结论落盘');
}

async function testFastEngineReadyIgnoresStaleCache() {
  const cachePath = path.join(tempRoot, 'engine-ready-expired.json');
  sealSignatureCache(path.join(tempRoot, 'signatures-expired.json'));
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    executable: fakeExecutable,
    pidsKey: '4242',
    // 超过 12 小时：结论过期，必须重新验证。
    verifiedAt: Date.now() - 13 * 60 * 60 * 1000,
  }) + '\n', 'utf8');

  let probed = 0;
  const runtime = createRuntime({
    options: {
      fastEngineProbe: true,
      engineReadyCachePath: cachePath,
      signatureCachePath: path.join(tempRoot, 'signatures-expired.json'),
      engineProcessProbe: async () => {
        probed += 1;
        return { ok: true, running: true, matching: true, executable: fakeExecutable, matchingPids: [4242] };
      },
      engineReadyProbe: async () => true,
    },
  });

  await runtime._ensureEngineReady(fakeExecutable, false);
  assert.ok(probed >= 1, '过期的结论不许直接采信');
}

// ---------------------------------------------------------------------------
// 3. 签名结论落盘：同一个文件不再每次启动都问一遍 PowerShell
// ---------------------------------------------------------------------------

async function testSignatureCacheAvoidsPowerShell() {
  const signaturePath = path.join(tempRoot, 'signatures-reuse.json');
  sealSignatureCache(signaturePath);
  const runtime = createRuntime({ options: { signatureCachePath: signaturePath } });
  const valid = await runtime._verifyExecutableSignature(fakeExecutable, fakeStat);
  assert.strictEqual(valid, true);
  assert.strictEqual(
    runtime.calls.execFile.filter(([command]) => /powershell/i.test(command)).length,
    0,
    '签名结论命中缓存时不许再起 PowerShell'
  );
}

async function testSignatureCacheRejectsChangedFile() {
  const signaturePath = path.join(tempRoot, 'signatures-changed.json');
  sealSignatureCache(signaturePath);
  const runtime = createRuntime({ options: { signatureCachePath: signaturePath } });
  const verifyCalls = [];
  runtime.execFile = (file, args, options, callback) => {
    verifyCalls.push(file);
    callback(null, '{"status":"Valid","subject":"CN=Skutta Software GmbH"}');
  };
  const staleStat = { size: fakeStat.size + 1, mtimeMs: fakeStat.mtimeMs };
  const valid = await runtime._verifyExecutableSignature(fakeExecutable, staleStat);
  assert.strictEqual(verifyCalls.length, 1, '指纹变化后必须真的去验一次，不能沿用旧结论');
  assert.strictEqual(valid, true, '结论以这次新验的结果为准，而不是缓存里那条');
}

// ---------------------------------------------------------------------------
// 4. 预热：只做固定开销，不替用户拉起引擎
// ---------------------------------------------------------------------------

async function testWarmUpSkipsEngineWhenNotRunning() {
  const cachePath = path.join(tempRoot, 'engine-ready-warm.json');
  const signaturePath = path.join(tempRoot, 'signatures-warm.json');
  sealSignatureCache(signaturePath);
  let spawned = 0;
  const runtime = createRuntime({
    tasklistOutput: 'Info: no tasks are running which match the specified criteria.\r\n',
    options: {
      fastEngineProbe: true,
      engineReadyCachePath: cachePath,
      signatureCachePath: signaturePath,
      residentWindowController: true,
      engineProcessProbe: async () => {
        throw new Error('warm-up must not probe when the engine is not running');
      },
      windowControlSpawn: () => {
        spawned += 1;
        const child = createFakeHelper();
        child.stdout.write('{"ready":true}\n');
        return child;
      },
    },
  });
  runtime._discoverExecutable = async () => ({ available: true, executable: fakeExecutable, executableName: 'wallpaper64.exe' });
  const result = await runtime.warmUp();
  assert.strictEqual(result.engine, '', '引擎没在跑时预热不许把它拉起来');
  assert.strictEqual(result.helper, true, '预热要把窗口控制宿主编译好');
  assert.strictEqual(spawned, 1);
  runtime._stopWindowControlHost('test');
}

async function testWarmUpConfirmsRunningEngine() {
  const cachePath = path.join(tempRoot, 'engine-ready-warm2.json');
  const signaturePath = path.join(tempRoot, 'signatures-warm2.json');
  sealSignatureCache(signaturePath);
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    executable: fakeExecutable,
    pidsKey: '4242',
    verifiedAt: Date.now(),
  }) + '\n', 'utf8');
  const runtime = createRuntime({
    options: {
      fastEngineProbe: true,
      engineReadyCachePath: cachePath,
      signatureCachePath: signaturePath,
      engineProcessProbe: async () => {
        throw new Error('a warm cache must not trigger a PowerShell probe');
      },
      engineReadyProbe: async () => true,
    },
  });
  runtime._discoverExecutable = async () => ({ available: true, executable: fakeExecutable, executableName: 'wallpaper64.exe' });
  const result = await runtime.warmUp();
  assert.strictEqual(path.resolve(result.engine), path.resolve(fakeExecutable));
  assert.strictEqual(runtime.readyCount || 0, 0);
}

(async () => {
  const cases = [
    ['常驻宿主复用同一个进程', testResidentHostReusesOneProcess],
    ['宿主空闲自退', testResidentHostIdleReap],
    ['宿主超时后收掉进程', testResidentHostTimeoutFailsOver],
    ['宿主起不来退回单次脚本', testResidentHostStartupFailureFallsBack],
    ['快路跳过引擎探测', testFastEngineReadySkipsProbe],
    ['新进程回来时重新校验', testFastEngineReadyFallsBackOnNewPid],
    ['过期结论不采信', testFastEngineReadyIgnoresStaleCache],
    ['签名结论命中磁盘缓存', testSignatureCacheAvoidsPowerShell],
    ['文件指纹变化后重验', testSignatureCacheRejectsChangedFile],
    ['引擎未运行时预热不拉进程', testWarmUpSkipsEngineWhenNotRunning],
    ['引擎已运行时预热确认就绪', testWarmUpConfirmsRunningEngine],
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
