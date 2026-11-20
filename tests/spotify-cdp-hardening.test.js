'use strict';

// Spotify 通道的两道加固，全部离线验证：随机调试端口 + 桥的 nonce。
// 不连 Spotify、不连 9222、不启动 Electron。
// The two hardening steps for the local Spotify channel, both verified offline: a randomised
// debug port and a nonce that every bridge method demands as its first argument.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { buildBridgeSource, BRIDGE_SOURCE } = require('../server/spotify-cdp-bridge');
const { createSpotifyCdp } = require('../server/spotify-cdp');
const probe = require('../desktop/spotify-client-probe');

(async () => {
  // ── 1. nonce 只能作为 IIFE 实参出现，绝不进函数体 ────────────────────────────
  const nonce = 'a1b2c3d4e5f60718';
  const source = buildBridgeSource(nonce);
  assert.ok(source.startsWith('(function (NONCE) {'), 'bridge must receive the nonce as its only parameter');
  assert.ok(
    source.trimEnd().endsWith('})(' + JSON.stringify(nonce) + ')'),
    'the nonce must be passed as the IIFE argument, not baked into the body'
  );
  // 只允许出现一次：就是最后那行实参。函数体里一律走标识符 NONCE。
  assert.strictEqual(
    source.split(nonce).length - 1,
    1,
    'the nonce value may appear exactly once — reading __MR__.cmd.toString() must not reveal it'
  );
  assert.ok(/token === NONCE/.test(source), 'the check must compare against the NONCE identifier');
  assert.ok(/token\.length === NONCE\.length/.test(source), 'a length check keeps the comparison cheap and uniform');

  // ── 2. 每个对外方法的首参必须是 token ────────────────────────────────────────
  for (const signature of [
    'function read(token)',
    'function cmd(token, name, payload)',
    'function play(token, uri)',
    'function volume(token)',
  ]) {
    assert.ok(source.includes(signature), 'bridge method signature is missing: ' + signature);
  }
  assert.ok(source.includes('function denied()'), 'a rejected call needs its own answer');
  assert.ok(source.includes('"E_TOKEN"'), 'rejection must be distinguishable from a missing bridge');
  assert.ok(source.includes('function verify(token)'), 'the injection step needs a way to ask an existing bridge whether it still matches');

  // ── 3. 桥版本必须抬上去，否则旧副本会被当成有效桥复用 ────────────────────────
  assert.ok(source.includes('window.__MR__.version === 2'), 'an existing bridge is only reused when it is version 2');
  assert.ok(source.includes('window.__MR__.verify(NONCE) === true'), 'reuse also requires the current nonce to be accepted');
  assert.ok(source.includes('version: 2'), 'the bridge registers itself as version 2');
  assert.ok(BRIDGE_SOURCE.includes('function cmd(token, name, payload)'), 'the exported sample must come from the same builder');

  // ── 4. 通道端口是可变的，而不是构造时钉死的常量 ─────────────────────────────
  const cdp = createSpotifyCdp({ initialPort: 51234 });
  assert.strictEqual(cdp.port, 51234, 'initialPort must seed the channel');
  assert.strictEqual(cdp.status().port, 51234, 'status() must report the live port');
  assert.strictEqual(cdp.setPort(51777), true, 'a legal port must be accepted');
  assert.strictEqual(cdp.port, 51777, 'the port getter must follow the closed-over value');
  assert.strictEqual(cdp.status().port, 51777, 'status() must follow the switch too');
  for (const bad of [0, -1, 65536, 'abc', null, undefined, 1.5, NaN]) {
    assert.strictEqual(cdp.setPort(bad), false, 'illegal port must be rejected: ' + String(bad));
  }
  assert.strictEqual(cdp.port, 51777, 'a rejected value must not clobber the current port');
  assert.strictEqual(cdp.resetPort(), true, 'an unanswered remembered port must be able to fall back');
  assert.strictEqual(cdp.port, 9222, 'resetPort goes back to the well-known port');
  assert.strictEqual(cdp.resetPort(), false, 'resetPort is a no-op when already at the default');
  const fallback = createSpotifyCdp({ initialPort: null });
  assert.strictEqual(fallback.port, 9222, 'without a remembered port the channel falls back to 9222');

  // ── 5. 端口范围：CEF 只吃 1024–65535，且不能落回人人都会扫的那几个 ──────────
  assert.strictEqual(probe.DEBUG_PORT_MIN, 1024, 'CEF rejects anything below 1024');
  assert.strictEqual(probe.DEBUG_PORT_MAX, 65535);
  assert.strictEqual(probe.isValidDebugPort(1024), true);
  assert.strictEqual(probe.isValidDebugPort(65535), true);
  assert.strictEqual(probe.isValidDebugPort(1023), false);
  assert.strictEqual(probe.isValidDebugPort(65536), false);
  assert.strictEqual(probe.isValidDebugPort('51234'), true, 'a numeric string from an HTTP query is acceptable');
  for (let i = 0; i < 6; i++) {
    const picked = await probe.pickDebugPort();
    assert.ok(
      picked === 0 || (picked >= 1024 && picked <= 65535),
      'picked port out of the CEF range: ' + picked
    );
    assert.notStrictEqual(picked, 9222, 'the well-known port must never be picked');
    assert.notStrictEqual(picked, 9229, 'chrome://inspect discovery ports must never be picked');
  }

  // ── 6. 端口要记在磁盘上：MR 退出后客户端不退出，下次得连回同一个实例 ────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-spotify-port-'));
  const portFile = path.join(dir, 'port.txt');
  process.env.MINERADIO_SPOTIFY_PORT_FILE = portFile;
  try {
    assert.strictEqual(probe.readSavedDebugPort(), null, 'no file means no remembered port');
    assert.strictEqual(probe.saveDebugPort(50001), true);
    assert.strictEqual(probe.readSavedDebugPort(), 50001, 'the remembered port must read back');
    assert.strictEqual(probe.saveDebugPort(80), false, 'an illegal port must not be written');
    assert.strictEqual(probe.readSavedDebugPort(), 50001, 'a rejected write must leave the old value alone');
    fs.writeFileSync(portFile, 'not-a-port', 'utf8');
    assert.strictEqual(probe.readSavedDebugPort(), null, 'a corrupted file reads as "nothing remembered"');
    // 记住的端口没人应答时必须被忘掉，否则下次启动又去敲一个死端口。
    fs.writeFileSync(portFile, '65000', 'utf8');
    assert.strictEqual(await probe.verifySavedDebugPort(200), null, 'an unanswered port must not be trusted');
    assert.strictEqual(fs.existsSync(portFile), false, 'the dead record must be removed');
    assert.strictEqual(probe.saveDebugPort(50002), true);
    assert.strictEqual(probe.forgetDebugPort(), true, 'the record must be removable');
    assert.strictEqual(probe.readSavedDebugPort(), null, 'forgetting must clear the record');
  } finally {
    delete process.env.MINERADIO_SPOTIFY_PORT_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 7. 接线：启动成功要把通道挪到新端口，启动时要读回旧端口 ──────────────────
  const serverText = read('server/server.js');
  assert.ok(
    /if \(answer && answer\.ok && answer\.port\) spotifyCdp\.setPort\(answer\.port\);/.test(serverText),
    'the launch route must move the channel onto the chosen port'
  );
  assert.ok(
    /initialPort:\s*spotifyClientProbe\.readSavedDebugPort\(\)/.test(serverText),
    'startup must resume from the remembered port'
  );
  assert.ok(
    /verifySavedDebugPort\(\)\.then\(saved => \{[\s\S]*?spotifyCdp\.resetPort\(\)/.test(serverText),
    'a remembered port that nobody answers must be dropped and replaced by the fallback'
  );

  // ── 8. 客户端命令行里不能再出现固定 9222 或 system-chosen 0 ──────────────────
  const probeText = read('desktop/spotify-client-probe.js');
  assert.ok(
    /'--remote-debugging-port=' \+ chosen/.test(probeText),
    'the client must be launched with the chosen port'
  );
  assert.ok(
    !/Number\(port\) \|\| 9222/.test(probeText),
    'the old hard-coded 9222 fallback on the command line must be gone'
  );
  assert.ok(/crypto\.randomInt\(/.test(probeText), 'port selection must use a uniform source');
  assert.ok(!/remote-debugging-port=0/.test(probeText), 'port 0 would only reach the dynamic range');

  // 渲染进程不知道端口，也不该猜。
  const remoteText = read('public/js/modules/08-account/pillager-spotify.js');
  assert.ok(!/127\.0\.0\.1:9222/.test(remoteText), 'the renderer must not assume a fixed port');

  console.log('spotify cdp hardening: all assertions passed');
})().catch(err => {
  console.error('spotify cdp hardening test failed:', err && err.stack);
  process.exit(1);
});
