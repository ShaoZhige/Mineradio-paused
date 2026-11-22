'use strict';

// Spotify 客户端窗口守卫：MR 拉起的那个客户端只负责出声，窗口不该留在桌面上
// （issue #1 反馈的"多了一块黑色窗口，退出 Spotify 才消失"）。
// 全部离线验证：不启动客户端、不连调试端口，只检查脚本形状 + 一次空跑。
// The window guard for the client MR spawns. Verified offline: script shape plus one empty run.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const probeSource = fs.readFileSync(path.join(ROOT, 'desktop', 'spotify-client-probe.js'), 'utf8');
const probe = require('../desktop/spotify-client-probe');

(async () => {
  // ── 1. 守卫必须挂在"MR 自己拉起客户端"这条路上 ──────────────────────────────
  const launch = /async function launchClientWithDebugPort[\s\S]*?\n}/.exec(probeSource);
  assert.ok(launch, 'launchClientWithDebugPort must still exist');
  assert.ok(
    /spawn\(exe[\s\S]*suppressClientWindow\(\)/.test(launch[0]),
    'spawning the client must arm the window guard'
  );
  // 客户端已经在跑时 MR 直接返回，不碰别人的窗口：早退分支必须排在守卫之前。
  assert.ok(
    launch[0].indexOf("reason: 'already-running'") < launch[0].indexOf('suppressClientWindow()'),
    'a client the user started themselves must be left alone'
  );
  assert.ok(!/\btaskkill\b|\bStop-Process\b/i.test(probeSource), 'the guard never kills the client');

  // ── 2. 时间窗与步长必须是有限且自洽的 ───────────────────────────────────────
  const spanMs = probe.CLIENT_WINDOW_GUARD_MS;
  assert.ok(spanMs >= 10000 && spanMs <= 60000, 'the guard window must cover a slow client start but stay bounded');
  const stableTicks = Number((/CLIENT_WINDOW_GUARD_STABLE_TICKS = (\d+)/.exec(probeSource) || [])[1]);
  const stepMs = Number((/CLIENT_WINDOW_GUARD_STEP_MS = (\d+)/.exec(probeSource) || [])[1]);
  assert.ok(stableTicks >= 5, 'a single minimise is not enough: the client re-shows itself once at startup');
  assert.ok(stepMs <= 300, 'the poll step must be short enough to catch a window that pops up');
  assert.ok(stableTicks * stepMs >= 1000, 'stability must be judged over about a second, not one tick');

  // ── 3~4 只在 Windows 上跑：脚本下发与空跑都要真的调 PowerShell，Linux CI 上做不了。
  // Sections 3-4 need a real PowerShell; the source-shape checks above stay cross-platform.
  if (process.platform !== 'win32') {
    console.log('spotify-client-window-guard: 脚本下发与空跑在非 Windows 上跳过 / skipped on '
      + process.platform + ' (script shape already verified)');
    return;
  }

  // ── 3. 真正下发给 PowerShell 的脚本：异步最小化、只碰 Spotify、纯 ASCII ──────
  const captured = [];
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function patched(file, data, ...rest) {
    if (String(file).indexOf('mineradio-spotify-probe') !== -1) captured.push(String(data));
    return originalWrite.call(fs, file, data, ...rest);
  };
  let result;
  try {
    result = await probe.suppressClientWindow(300);
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.ok(captured.length >= 1, 'the guard must run through the shared PowerShell helper');
  const script = captured[captured.length - 1];
  assert.ok(/^[\x00-\x7F]*$/.test(script), 'the script must stay ASCII: PowerShell 5.1 mangles BOM-less UTF-8');
  assert.ok(script.indexOf('ShowWindowAsync') !== -1, 'minimising must use the async call');
  assert.ok(script.indexOf('ShowWindow(') === -1, 'the synchronous ShowWindow can block on a hung client');
  assert.ok(script.indexOf('ShowWindowAsync($target.MainWindowHandle, 6)') !== -1, 'nCmdShow must be SW_MINIMIZE');
  assert.ok(script.indexOf('Get-Process -Name Spotify') !== -1, 'only the Spotify client may be touched');
  assert.ok(/\$deadline = \(Get-Date\)\.AddMilliseconds\(\d+\)/.test(script), 'the loop must be bounded by a deadline');
  assert.ok(script.indexOf('Start-Sleep -Milliseconds $step') !== -1, 'the step must widen while no window is around');

  // ── 4. 空跑：没有客户端时不报错、不空转，非法入参被夹到下限 ────────────────
  assert.strictEqual(result.spanMs, 300, 'a too-small timeout is clamped to the 300ms floor');
  assert.strictEqual(result.minimized, 0, 'nothing to minimise when no client is running');
  assert.strictEqual(typeof result.sawWindow, 'boolean', 'the guard reports whether a window was ever seen');

  console.log('spotify-client-window-guard: all assertions passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
