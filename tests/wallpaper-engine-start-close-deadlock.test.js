'use strict';

//「上一个会话关不掉 → 永久卡在项目预览」的回归测试。
// Regression cover for the permanent cover-art deadlock caused by an uncloseable session.
//
// 背景：实测日志（`startup-error.log`，2.2.0 + 上一轮修复）显示失败**不在** embed 的
// `_relaunchSessionWindow` 上，而是：
//   1. `embedActiveWindow` 里原生 embed 脚本退出非零（`nativeStage='exec'`）→ 会话没建成；
//   2. 该会话**关不掉**（`_closeSession` 返回 false）→ `this.active` 永远非空；
//   3. 之后每次 `start()` 都在 `startStage='close-previous-window'` 抛
//      `WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED` → 界面永久停在项目预览。
//      重载渲染进程无效，因为状态在主进程里。
//
// Background: the captured log shows the failure is not in the embed relaunch at all. The embed
// script exits non-zero, the resulting session cannot be closed, `this.active` stays set, and
// every later start() dies at `close-previous-window` — so the UI is stuck on the cover art and
// reloading the renderer cannot help, because the state lives in the main process.
//
// 这组测试钉住三件事：
//  1. `_closeSession` 的「窗口还在不在」确认必须独立于 HWND 校验（不能只在没有 sourceId 时跑）；
//  2. 关窗失败的原因必须留下来（会话 → stop() → start() 抛出的错误 → startup-error.log）；
//  3. `start()` 关掉上一个会话**只能尝试一次**（既有契约，避免在桌面叠出多个 WE 窗口）。
// Pinned here: the closure confirmation must be independent of HWND validation; the close
// failure reason must survive all the way into the log; and closing the previous session in
// start() must stay a single attempt, so windows never stack up on the desktop.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const readSource = (relativePath) => fs
  .readFileSync(path.join(appRoot, relativePath), 'utf8')
  .replace(/\r\n/g, '\n');

const runtimeText = readSource('desktop/wallpaper-engine-runtime.js');
const mainText = readSource('desktop/main.js');

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

const closeSessionSource = extractFunction(runtimeText, '  async _closeSession(session) {');
const closeSessionBody = stripComments(closeSessionSource);
const startSource = extractFunction(runtimeText, '  async start(id, options = {}) {');
const startBody = stripComments(startSource);
const stopSource = extractFunction(runtimeText, '  async stop(expectedSessionId = \'\') {');

// ---------------------------------------------------------------------------
// 1. 关窗确认必须独立于 HWND 校验
// ---------------------------------------------------------------------------

const enumerationGate = closeSessionBody.match(
  /if \(!windowClosed && closeRequested([^)]*)\)/
);
assert(enumerationGate, 'the close path must keep a name-enumeration confirmation');
assert(
  !/!\s*sourceId/.test(enumerationGate[1]),
  'name enumeration must not be gated on a missing sourceId: the case that needs it most is a '
  + 'sourceId whose HWND validation failed (title/process mismatch)'
);
assert(
  /^[\s\S]*if \(sourceId\) \{/.test(closeSessionBody),
  'the HWND-based close must still run when a sourceId is known'
);

function runCloseSession(options = {}) {
  const context = vm.createContext({ console });
  const prelude = [
    'var __events = [];',
    closeSessionSource.replace('async _closeSession(session) {', 'async function closeSessionCall(session) {'),
  ].join('\n');
  vm.runInContext(prelude, context, { filename: 'wallpaper-engine-start-close-deadlock.js' });

  const host = {
    desktopCapturer: options.windowStillVisible === undefined
      ? null
      : {
        getSources: async () => (options.windowStillVisible
          ? [{ name: 'Mineradio Wallpaper abc' }, { name: 'Program Manager' }]
          : [{ name: 'Program Manager' }]),
      },
    _stopSessionPointerRelay: () => { context.__events.push('pointer-relay'); },
    _stopSessionDwmSurface: () => { context.__events.push('dwm-surface'); },
    _waitForSessionDwmSurfaceStop: async () => { context.__events.push('await-dwm'); },
    _clearSessionMuteReassertions: () => { context.__events.push('clear-mute'); },
    _cleanupStagedProject: async () => { context.__events.push('cleanup-staged'); },
    _spawnControl: async () => { context.__events.push('we-control'); },
    _controlSessionWindow: async () => {
      context.__events.push('hwnd-close');
      if (options.hwndCloseThrows === true) {
        const error = new Error('Capture window title mismatch');
        error.nativeDetail = 'Capture window title mismatch';
        throw error;
      }
      return options.hwndCloseResult || { closed: true };
    },
    nativeSleep: async () => { context.__events.push('sleep'); },
  };
  context.__host = host;

  return {
    events: () => context.__events.slice(),
    async close(session) {
      context.__session = session;
      const result = await vm.runInContext('closeSessionCall.call(__host, __session)', context);
      return { result, session };
    },
  };
}

const baseSession = () => ({
  sessionId: 'abc',
  locationTitle: 'Mineradio Wallpaper abc',
  executable: 'C:/steam/we.exe',
  launched: true,
  windowSourceId: 'window:4242:1',
  sourceId: 'window:4242:1',
});

// 关键回归：原生 HWND 关窗失败（标题/进程校验不通过），但按名枚举证明窗口已经没了
// → 之前因为 `!sourceId` 条件被跳过，判定"没关掉" → 永久卡死；现在必须确认已关闭。
// The core regression: the native HWND close fails, but name enumeration proves the window is
// gone. The old `!sourceId` gate skipped it, so the session was declared uncloseable forever.
(async () => {
  const recovered = runCloseSession({ hwndCloseThrows: true, windowStillVisible: false });
  const recoveredRun = await recovered.close(baseSession());
  assert.strictEqual(
    recoveredRun.result,
    true,
    'a window proven gone by name enumeration must be treated as closed, otherwise start() deadlocks forever'
  );
  assert.strictEqual(recoveredRun.session.launched, false, 'a confirmed close must reset the session');
  assert.ok(
    recovered.events().includes('hwnd-close') && recovered.events().includes('sleep'),
    'the HWND attempt must still happen before the enumeration fallback'
  );

  // 窗口确实还在 → 仍然必须判定失败，不能因为放宽了条件就误报成功。
  // If the window really is still there the close must still fail; relaxing the gate must not
  // turn into a false positive.
  const stillOpen = runCloseSession({ hwndCloseThrows: true, windowStillVisible: true });
  const stillOpenRun = await stillOpen.close(baseSession());
  assert.strictEqual(stillOpenRun.result, false, 'a window still present must not be reported as closed');
  assert.strictEqual(stillOpenRun.session.launched, true, 'a failed close must leave the session launched');

  // 原因必须留下来，而不是被 catch 吞掉。
  // The reason must survive instead of being swallowed by the catch.
  assert.match(
    String(stillOpenRun.session.closeNotes || ''),
    /Capture window title mismatch/,
    'the swallowed HWND close failure must be recorded on the session'
  );
  assert.ok(
    closeSessionBody.includes("closeNotes.push('hwnd-close:'"),
    'the close catch must record a note instead of being empty'
  );
  assert.ok(
    closeSessionBody.includes("closeNotes.push('we-control:'"),
    'the Wallpaper Engine control failure must be recorded too'
  );
  // 只针对关窗那两处：`_closeSession` 里还有一个空 catch 是有意的（等待 initialOpenPromise
  // 的失败无需处理，反正要关掉），不能一并要求清掉。
  // Only the two close-specific catches are checked here: the remaining empty catch is
  // intentional (a rejected initialOpenPromise is irrelevant when closing anyway).
  assert.ok(
    !/closeRequested = true;\s*\} catch \(_\) \{ \}/.test(closeSessionBody),
    'the closeWallpaper failure must not be swallowed'
  );
  assert.ok(
    !/fallback\.missing === true\)\);\s*\} catch \(_\) \{ \}/.test(closeSessionBody),
    'the HWND close failure must not be swallowed'
  );

  // 没有 desktopCapturer 时不能凭空宣布已关闭（保持原有严格性）。
  // Without a capturer there is nothing to verify with, so the strict result stays.
  const noCapturer = runCloseSession({ hwndCloseThrows: true });
  assert.strictEqual(
    (await noCapturer.close(baseSession())).result,
    false,
    'without an enumerator an unconfirmed close must stay unconfirmed'
  );

  // -------------------------------------------------------------------------
  // 2. 原因一路传到日志
  // -------------------------------------------------------------------------

  assert.ok(
    /closeNotes: allStopped \? '' : closeNotes\.join\(' \| '\)\.slice\(0, 400\)/.test(stopSource),
    'stop() must report why the window could not be closed'
  );
  assert.ok(
    startBody.includes('failure.closeNotes = String(stoppedPrevious && stoppedPrevious.closeNotes'),
    'start() must carry the close notes onto the thrown error'
  );
  assert.ok(
    /if \(error && typeof error === 'object' && error\.startStage === undefined\)/.test(runtimeText),
    'the failing start stage must be attached to the thrown error'
  );
  assert.ok(
    closeSessionBody.includes('session.closeNotes ='),
    'the session must expose its close notes'
  );

  // 诊断字段以前只挂在错误对象上，而日志只打印 message+stack，等于白挂。
  // The diagnostics used to hang off the error while the log printed only message+stack.
  const diagnosticsSource = extractFunction(
    mainText,
    'function startupErrorDiagnostics(error) {'
  );
  const diagContext = vm.createContext({ console });
  vm.runInContext(diagnosticsSource, diagContext, { filename: 'wallpaper-engine-start-close-deadlock.js' });
  const diagText = vm.runInContext(
    'startupErrorDiagnostics({ code: "X", startStage: "close-previous-window", '
    + 'closeNotes: "hwnd-close:Capture window title mismatch", nativeDetail: "boom", empty: "" })',
    diagContext
  );
  assert.match(diagText, /startStage=close-previous-window/, 'the failing start stage must be printable');
  assert.match(diagText, /closeNotes=hwnd-close:Capture window title mismatch/, 'the close notes must be printable');
  assert.match(diagText, /nativeDetail=boom/, 'the native detail must be printable');
  assert.strictEqual(
    diagText.includes('empty='),
    false,
    'empty diagnostics must not add noise to the log'
  );
  assert.strictEqual(
    vm.runInContext('startupErrorDiagnostics(null)', diagContext),
    '',
    'a missing error must not produce a diagnostics block'
  );
  assert.ok(
    mainText.includes("...(diagnostics ? ['', '[diagnostics]', diagnostics] : [])"),
    'writeStartupErrorLog must actually append the diagnostics block'
  );
  assert.ok(
    mainText.includes("'startStage',") && mainText.includes("'closeNotes',"),
    'the diagnostics field list must cover the start stage and the close notes'
  );

  // -------------------------------------------------------------------------
  // 3. 关掉上一个会话仍然只尝试一次
  // -------------------------------------------------------------------------

  const previousStopCalls = startBody.match(/this\.stop\(previous\.sessionId\)/g) || [];
  assert.strictEqual(
    previousStopCalls.length,
    1,
    'closing the previous session must stay a single attempt so Wallpaper Engine windows never stack up'
  );
  assert.ok(
    !/nativeSleep\(600\)/.test(startBody),
    'the rejected retry-the-close experiment must stay removed'
  );

  console.log('[OK] An uncloseable previous session is now confirmed closed by name enumeration '
    + 'instead of deadlocking start(), its cause reaches startup-error.log, and the single-attempt '
    + 'close contract is preserved.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
