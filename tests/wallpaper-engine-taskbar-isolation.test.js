'use strict';

// 「WE 窗口静默」必须"不管什么时候都静默"的回归测试。
// Regression cover for the taskbar isolation having to hold whenever a window appears.
//
// 背景：静默原本是"拉起 WE 之后按 0 / 900 / 2200 毫秒各试一次"，并且按**进程名**匹配窗口。
// 三个缺陷叠在一起：
//  1. 只覆盖启动后 2.2 秒——WE 之后弹出的对话框、更新提示、设置窗口会永久留在任务栏上，
//     这正是用户看到的"有时候任务栏会有展示"；
//  2. 每个进程只取 process.MainWindowHandle，而 WE 远不止一个顶层窗口，其余全部漏掉；
//  3. 按进程名匹配会把**用户自己开着的** WE 一起静默掉，与代码注释承诺的"只处理本次由本
//     进程拉起的实例"正好相反。
//
// Background: isolation used to be "try once at 0 / 900 / 2200ms after launch", matching windows
// by process name. Three defects stacked up: only the first 2.2s was covered, so any dialog or
// prompt WE raised later stayed on the taskbar for good; only process.MainWindowHandle was
// touched, and an engine has far more than one top-level window; and matching by process name
// also stole the taskbar entry of a user-owned engine, the exact opposite of what the feature
// promises.
//
// 现在改成：按"拉起前后 PID 差集"精确定位本次实例 + 常驻监视器每 1.5 秒枚举一次，
// 直到该实例退出。Four things are pinned below.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const runtimeText = fs.readFileSync(
  path.join(appRoot, 'desktop', 'wallpaper-engine-runtime.js'),
  'utf8'
).replace(/\r\n/g, '\n');

function extractFunction(source, signature) {
  const from = source.indexOf(signature);
  assert(from >= 0, `missing function: ${signature}`);
  const open = from + signature.length - 1;
  assert(source[open] === '{', `signature must end with the body brace: ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${signature}`);
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// ---------------------------------------------------------------------------
// 1. 原生脚本：按 PID 枚举全部窗口，默认循环
// ---------------------------------------------------------------------------

const isolationScript = extractFunction(runtimeText, 'function nativeProcessWindowIsolationScript() {');
const isolationBody = stripComments(isolationScript);

assert(
  /EnumWindows/.test(isolationBody) && /GetWindowThreadProcessId/.test(isolationBody),
  'isolation must enumerate every top-level window, not just process.MainWindowHandle'
);
assert(
  !/MainWindowHandle/.test(isolationBody),
  'a single MainWindowHandle per process leaves every other engine window on the taskbar'
);
assert(
  /targets\.Contains\(\(int\)owner\)/.test(isolationBody),
  'every window must be filtered against the resolved engine PIDs'
);
assert(
  /MINERADIO_WE_ISOLATE_PROCESSES/.test(isolationBody),
  'the process list must arrive through the environment rather than being interpolated into the script'
);

// PID 绑定是错的：WE 一重启，旧 PID 消失，绑死 PID 的监视器会判定"引擎已退出"并跟着退出，
// 之后任务栏就再没人管。每轮按名字重新解析才跟得上。
// Binding to PIDs is wrong: once the engine restarts its old PIDs vanish, a PID-bound monitor
// declares the engine gone and exits with them, and nothing guards the taskbar afterwards.
// Re-resolving by name on every pass is what keeps up.
assert(
  /public static int\[\] ResolvePids\(string\[\] processNames\)/.test(isolationBody),
  'the monitor must resolve engine PIDs from process names'
);
assert(
  /Process\.GetProcessesByName\(name\)/.test(isolationBody),
  'resolution must go through the live process list, not a captured snapshot'
);
assert(
  /\$targets = @\(\[MineradioWeProcessWindowIsolation\]::ResolvePids\(\$processNames\)\)/.test(isolationBody),
  'every pass must re-resolve so a restarted engine is still followed'
);
assert(
  /\$emptyPasses -ge \$EMPTY_PASS_LIMIT/.test(isolationBody),
  'a swapped engine instance is not an exit; only a run of empty passes may end the monitor'
);

// 循环 + 单次分支：固定次数的重试覆盖不到"之后弹出的窗口"。
// The loop plus a one-shot branch: a fixed number of retries cannot cover windows raised later.
assert(
  /while \(\$true\)/.test(isolationBody) && /Start-Sleep -Milliseconds 1500/.test(isolationBody),
  'isolation must keep polling instead of giving up after a few fixed delays'
);
assert(
  /MINERADIO_WE_ISOLATE_ONCE -eq '1'/.test(isolationBody) && /if \(\$once\) \{ break \}/.test(isolationBody),
  'a one-shot branch must remain available as the fallback when the monitor cannot start'
);
assert(
  !/\]::Alive\(\$targets\)/.test(isolationBody),
  'the monitor resolves names each pass; the old per-PID liveness probe is dead code'
);
assert(
  /reason=engine-exited/.test(isolationBody) && /\$emptyPasses -ge \$EMPTY_PASS_LIMIT/.test(isolationBody),
  'the monitor must still end by itself, but only after a run of passes with no engine at all'
);
assert(
  /AddMinutes\(30\)/.test(isolationBody),
  'the monitor needs a hard ceiling so a stuck engine cannot keep it alive forever'
);
// 静默动作本身仍然是标准的任务栏 + Alt+Tab 双保险，不能因为重排而丢掉其中一条。
// The isolation action itself is still the standard taskbar + Alt+Tab pair; a reshuffle must not
// quietly drop either half.
assert(/taskbar\.DeleteTab\(hWnd\)/.test(isolationBody), 'the taskbar entry must be deleted');
assert(
  /WS_EX_TOOLWINDOW[\s\S]{0,120}~WS_EX_APPWINDOW/.test(isolationBody) && /SWP_FRAMECHANGED/.test(isolationBody),
  'the Alt+Tab entry must be removed through the extended window style'
);

// ---------------------------------------------------------------------------
// 2. JS 侧：监视器接线、生命周期、以及"只静默本次拉起"
// ---------------------------------------------------------------------------

const monitorSource = extractFunction(runtimeText, '  _startEngineWindowIsolationMonitor(processNames) {');
const stopMonitorSource = extractFunction(runtimeText, '  _stopEngineWindowIsolationMonitor() {');
const onceSource = extractFunction(runtimeText, '  _isolateEngineWindowsOnce(processNames) {');

// 改动原因必须留在文件里：中英对照，且紧挨着被解释的那段实现。
// The reason for the change has to stay in the file as a bilingual note right next to the code it
// explains — extractFunction() only returns the body, so the lead comment is checked in place.
function leadCommentFor(needle) {
  const at = runtimeText.indexOf(needle);
  assert(at >= 0, `missing ${needle}`);
  return runtimeText.slice(Math.max(0, at - 1400), at);
}
for (const needle of [
  '  _startEngineWindowIsolationMonitor(processNames) {',
  '  _stopEngineWindowIsolationMonitor() {',
  '  _isolateEngineWindowsOnce(processNames) {',
]) {
  const lead = leadCommentFor(needle);
  const commentLines = lead.split('\n').filter((line) => /^\s*\/\//.test(line));
  assert(
    commentLines.some((line) => /[一-鿿]/.test(line)),
    `${needle.trim()} must explain the problem in Chinese right above it`
  );
  assert(
    commentLines.some((line) => /^\s*\/\/ [A-Z]/.test(line)),
    `${needle.trim()} must carry the English counterpart for readers who cannot read the Chinese`
  );
}

assert(
  /_stopEngineWindowIsolationMonitor\(\);\s*\n\s*const targets/.test(monitorSource),
  'starting a monitor must reap the previous one instead of leaking a second PowerShell'
);
assert(
  /this\.spawn\(this\.powerShellExecutable/.test(monitorSource),
  'the resident monitor must be a spawned long-lived process, not a one-shot execFile'
);
assert(
  /_powerShellHelperArgs\('window-monitor'/.test(monitorSource),
  'the monitor must launch from the hashed script file; it grows with every added window type'
);
assert(
  /MINERADIO_WE_ISOLATE_PROCESSES: targets\.join\(','\)/.test(monitorSource),
  'the monitor must be told which engine processes to follow'
);
assert(
  /stdio: \['ignore', 'pipe', 'pipe'\]/.test(monitorSource),
  'the monitor must keep stdout so its per-pass counters stay observable'
);
assert(
  /\.unref\(\)/.test(monitorSource),
  'the monitor must not hold the event loop open'
);
assert(
  /child\.on\('exit'/.test(monitorSource),
  'the monitor handle must be released when the process ends on its own'
);
assert(
  /catch \(error\) \{[\s\S]{0,400}_isolateEngineWindowsOnce\(targets\)/.test(monitorSource),
  'a monitor that cannot start must degrade to one immediate pass, never break wallpaper startup'
);
assert(
  /MINERADIO_WE_ISOLATE_ONCE: '1'/.test(onceSource),
  'the one-shot fallback must ask the shared script for the single-pass branch'
);

const stopBody = extractFunction(runtimeText, '  async stop(expectedSessionId = \'\') {');
assert(
  /if \(!this\.active && !this\.pending\) this\._stopEngineWindowIsolationMonitor\(\);/.test(stopBody),
  'with no session left the engine entry is no longer interference, so the monitor must be reaped'
);
const disposeBody = extractFunction(runtimeText, '  async dispose() {');
assert(
  /this\.disposed = true;[\s\S]{0,600}_stopEngineWindowIsolationMonitor\(\);/.test(disposeBody),
  'dispose owns a runtime-scoped process and must always reap it'
);

// 旧的固定三次延迟 + 按进程名匹配必须彻底消失。
// The old three-delay schedule and the process-name match must be gone for good.
assert(
  !/_scheduleEngineWindowIsolation/.test(runtimeText) && !/_isolateEngineMainWindow/.test(runtimeText),
  'the fixed-delay isolation path must stay removed'
);
// 静默范围：**壁纸核心**，且**放过管理器**。
// The silent set is the wallpaper CORE, and the manager is explicitly left alone.
assert.ok(
  /const ENGINE_WINDOW_ISOLATION_PROCESSES = \['wallpaper32', 'wallpaper64'\]/.test(runtimeText),
  'the silent set must be the wallpaper core processes'
);
assert.ok(
  !/ENGINE_WINDOW_ISOLATION_PROCESSES = \[[^\]]*wallpaperengine/.test(runtimeText),
  'the manager the user opens on purpose must stay reachable, not be silenced'
);
assert.ok(
  !/_startEngineWindowIsolationMonitor\(engineProcessPid/.test(runtimeText),
  'the monitor must not be bound to a PID snapshot'
);
assert.ok(
  !/function engineProcessPidDifference/.test(runtimeText),
  'the PID-difference helper is dead once the monitor follows process names'
);

// 复用已开着的 WE 时也必须挂监视器。这是"任务栏还是有 WE"的直接成因：那条分支根本不启动
// 监视器，壁纸窗口靠旧路径静默了，但它之后弹出的任何窗口都会直接落到任务栏上。
// A reused engine needs the monitor too. This is the direct cause of "WE is still on the taskbar":
// that branch never started one, so the wallpaper window was silenced by the older path while
// anything it raised later landed on the taskbar.
const reuseBranch = runtimeText.slice(
  runtimeText.indexOf('let effectiveExecutable = '),
  runtimeText.indexOf('const cacheAge = this.now()')
);
assert.ok(
  /if \(state\.matching\) \{[\s\S]{0,2400}_startEngineWindowIsolationMonitor\(ENGINE_WINDOW_ISOLATION_PROCESSES\)/.test(reuseBranch),
  'reusing a running engine must start the monitor as well'
);
assert.ok(
  /if \(silentWindows !== false\) \{\s*\n?\s*this\._startEngineWindowIsolationMonitor\(ENGINE_WINDOW_ISOLATION_PROCESSES\)/.test(reuseBranch),
  'the reuse branch must still honour the silentWindows setting'
);

// ---------------------------------------------------------------------------
// 3. 静默集合：只含壁纸核心，且按名字每轮重新解析
// ---------------------------------------------------------------------------

const silentSetMatch = /const ENGINE_WINDOW_ISOLATION_PROCESSES\s*=\s*(\[[^\]]*\])\s*;/.exec(runtimeText);
assert.ok(silentSetMatch, 'the silent set must be a literal so it stays reviewable in a glance');
const engineWindowIsolationProcesses = JSON.parse(silentSetMatch[1].replace(/'/g, '"'));
assert.strictEqual(
  JSON.stringify(engineWindowIsolationProcesses),
  JSON.stringify(['wallpaper32', 'wallpaper64']),
  'exactly the wallpaper core processes must be silenced'
);
assert.ok(
  engineWindowIsolationProcesses.indexOf('wallpaperengine') < 0,
  'the manager the user opens on purpose must stay visible and reachable'
);
assert.ok(
  engineWindowIsolationProcesses.indexOf('wallpaperservice32') < 0,
  'the background service is not a window host and must not be listed'
);

// 两个分支必须传同一份集合：复用与新拉起在"要静默哪些进程"上不该有差别，否则改一处忘一处。
// Both branches must pass the same set: reuse and a fresh launch must not differ on which processes
// get silenced, or a future edit will update one and forget the other.
const monitorCallSites = runtimeText.match(/_startEngineWindowIsolationMonitor\(ENGINE_WINDOW_ISOLATION_PROCESSES\)/g) || [];
assert.strictEqual(
  monitorCallSites.length,
  2,
  'both the reuse branch and the launch branch must start the monitor with the same set'
);

// ---------------------------------------------------------------------------
// 4. DWM 表面助手自己：它的窗口标题就叫 "Mineradio WE DWM Surface"，之前一直占着任务栏
// ---------------------------------------------------------------------------

const dwmScript = extractFunction(runtimeText, 'function nativeDwmThumbnailSurfaceScript() {');
// 负向断言必须对着剥掉注释的源码：这里正好要留着"以前是 ShowInTaskbar = true"的说明，
// 照原文匹配会把这句有用的历史记录当成代码。
// Negative assertions must run against comment-stripped source: the block deliberately documents
// that it used to be ShowInTaskbar = true, and matching the raw text would read that useful history
// as code.
const dwmCode = stripComments(dwmScript);

// 真正的 WE 窗口早就被静默了，用户看到的那个是本程序自己的 DWM 表面助手：它是一个常驻的
// shell 进程，窗口标题 "Mineradio WE DWM Surface"，看起来就像 WE 还活着。
// The real engine windows were silenced long ago. What the user kept seeing was this app's own DWM
// surface helper: a resident shell process whose window is titled "Mineradio WE DWM Surface", which
// reads exactly like Wallpaper Engine still being around.
assert.ok(
  /Mineradio WE DWM Surface/.test(dwmScript),
  'the DWM surface helper still exists and still carries that title'
);
assert.ok(
  /ShowInTaskbar = false/.test(dwmScript),
  'ShowInTaskbar must be false so WinForms builds the surface with WS_EX_TOOLWINDOW'
);
assert.ok(
  !/ShowInTaskbar = true/.test(dwmCode),
  'ShowInTaskbar = true is what put WS_EX_APPWINDOW on the surface and the taskbar entry with it'
);
// 修法刻意收敛成一行，没有再手动改扩展样式：项目契约明确禁止在这个块里出现 SetWindowLong
// （防的是用改样式做窗口停放或隐藏），而 ShowInTaskbar = false 已经让 WinForms 自己把
// WS_EX_APPWINDOW 换成 WS_EX_TOOLWINDOW。少写手工代码，也不去动契约。
// The fix collapses to one line and deliberately avoids restyling by hand: the project contract
// forbids SetWindowLong in this block (it guards against restyling for parking or hiding), and
// ShowInTaskbar = false already makes WinForms swap WS_EX_APPWINDOW for WS_EX_TOOLWINDOW itself.
assert.ok(
  !/IsolateFromShell/.test(dwmCode),
  'the surface must not carry a hand-rolled restyle; WinForms already applies WS_EX_TOOLWINDOW'
);
assert.ok(
  !/static void IsolateFromShell/.test(dwmScript),
  'no shell-isolation helper should have been added to the DWM surface class'
);

// ---------------------------------------------------------------------------
// 5. 监视器只静默壁纸窗口，别的一律不碰
// ---------------------------------------------------------------------------

// 监视器早先对引擎进程的**每一个**可见窗口都改样式 + SetWindowPos(SWP_FRAMECHANGED)。那会把
// Wallpaper Engine 自己的来源确认对话框一起 restyle —— 引擎很可能正靠那个窗口跟踪"用户还没回答"，
// 被反复改样式就让它认为对话框失效而重弹，表现为"每次启动壁纸都要点一次 OK"。用户主动打开的
// 设置窗口和商店界面同样不该被我们插手。
// The monitor used to restyle every visible window of the engine process, including its own
// origin-confirmation dialog. The engine most likely tracks that dialog to know the user has not
// answered yet, so restyling it repeatedly can make it raise another one — surfacing as "every
// wallpaper start asks me to press OK". Settings windows and the shop UI deserve the same restraint.
assert.ok(
  /String\.Equals\(Class\(hWnd\), "WPEOverlappedWallpaper"/.test(isolationBody),
  'the monitor must recognise the wallpaper playback window by its class'
);
assert.ok(
  /Title\(hWnd\)\.StartsWith\("Mineradio Wallpaper "/.test(isolationBody),
  'the title is the backstop for builds that rename that class; either match may silence a window'
);
assert.ok(
  /if \(!isWallpaperWindow\) return true;/.test(isolationBody),
  'a window that is not the wallpaper playback window must be left completely alone'
);
assert.ok(
  isolationBody.indexOf('if (!isWallpaperWindow) return true;') < isolationBody.indexOf('if (Isolate(hWnd)) isolated++;'),
  'the filter must run before anything is restyled, not after'
);
assert.ok(
  /GetClassNameW/.test(isolationBody) && /GetWindowTextW/.test(isolationBody),
  'reading the class and title needs both Unicode P/Invoke declarations'
);
assert.ok(
  /using System\.Text;/.test(isolationBody),
  'StringBuilder is required by those declarations; without the using the whole Add-Type fails'
);

console.log('[OK] Taskbar isolation follows the wallpaper core by process name, so a restarted '
  + 'engine is still tracked, and it keeps enumerating every 1.5s while leaving the wallpaper '
  + 'manager visible and reachable.');

module.exports = { engineWindowIsolationProcesses };
