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

  // ── 3. 真正下发的脚本：异步最小化、只碰 Spotify、纯 ASCII ────────────────────
  // 🔴 不再真的调 PowerShell：以前这一步会在 CI 上起一次宿主进程，Windows runner 冷启动
  // 慢到撞上预算就整条流水线红（2026-11-22）。现在注入一个 runner，脚本内容照样逐条断言。
  // The runner is injected so no host process is started; the script is still asserted line by line.
  let seenLines = null;
  const result = await probe.suppressClientWindow(300, (lines) => {
    seenLines = lines;
    return null; // 相当于"宿主工具没起来"：调用方必须能兜住
  });
  assert.ok(Array.isArray(seenLines) && seenLines.length, 'the guard must build a script through the shared helper');
  const script = seenLines.join('\r\n');
  assert.ok(/^[\x00-\x7F]*$/.test(script), 'the script must stay ASCII: PowerShell 5.1 mangles BOM-less UTF-8');
  assert.ok(script.indexOf('ShowWindowAsync') !== -1, 'minimising must use the async call');
  assert.ok(script.indexOf('ShowWindow(') === -1, 'the synchronous ShowWindow can block on a hung client');
  assert.ok(script.indexOf('ShowWindowAsync($target.MainWindowHandle, 6)') !== -1, 'nCmdShow must be SW_MINIMIZE');
  assert.ok(script.indexOf('Get-Process -Name Spotify') !== -1, 'only the Spotify client may be touched');
  assert.ok(/\$deadline = \(Get-Date\)\.AddMilliseconds\(\d+\)/.test(script), 'the loop must be bounded by a deadline');
  assert.ok(script.indexOf('Start-Sleep -Milliseconds $step') !== -1, 'the step must widen while no window is around');

  // ── 4. 宿主没答上来时的返回值形状必须齐全、非法入参被夹到下限 ────────────────
  assert.strictEqual(result.spanMs, 300, 'a too-small timeout is clamped to the 300ms floor');
  assert.strictEqual(result.minimized, 0, 'nothing to minimise when no client is running');
  assert.strictEqual(typeof result.sawWindow, 'boolean', 'the guard reports whether a window was ever seen');

  console.log('spotify-client-window-guard: all assertions passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
