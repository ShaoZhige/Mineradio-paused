'use strict';

// 原生实时壁纸"卡在项目预览"的回归测试。
// Regression cover for the native wallpaper scene getting stuck on its project preview.
//
// 背景：原生 Scene 的启动临界路径上会调用 _relaunchSessionWindow()——为了让 WE 弹出窗口和
// 宿主窗口像素对齐，先把上一个窗口关掉再重开。关窗失败会抛 WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED，
// 上层把它当成"实时运行彻底失败"，于是把 kind 改成 'preview'，画面变成工程目录封面图被
// object-fit: cover 拉伸铺满——看起来就是"壁纸超级模糊、而且和真实壁纸不符"。
//
// Background: launching the native scene runs _relaunchSessionWindow() on its critical path,
// which closes the previous Wallpaper Engine pop-out before reopening it at the corrected
// geometry. A close failure raises WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED, which the renderer
// treated as a fatal native failure and turned into a stretched cover-art fallback.
//
// 这组测试钉住四件事：
//  1. 关窗改成轮询等待（上限放宽到 6s）并回传实际等待时长；
//  2. 关窗的底层原因不再被丢掉，失败阶段一路带到渲染进程和 startup-error.log；
//  3. 瞬态关窗失败先自动补试一次，只有补试也用完才退回封面图；
//  4. 预览兜底的界面文案不再被"已显示原背景"分支抢先。
// Four things are pinned here: the close wait became a poll with a 6s ceiling and reports its
// duration; the underlying cause is no longer discarded; a transient close failure gets one
// automatic re-attempt before falling back to cover art; and the preview fallback label is no
// longer shadowed by the "original background" branch.

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
const libraryText = readSource('public/js/modules/07-fx/03-wallpaper-engine-library.js');
const quickCheckText = readSource('scripts/quick-check.js');
const runtimeCheckText = readSource('scripts/check-wallpaper-engine-runtime.js');

function extractFunction(source, signature) {
  // 签名必须以函数体的左花括号结尾：参数里可能有对象默认值，body 不在第一个 '{' 处。
  // The signature must end with the body brace; a parameter list may carry braces of its own.
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
  // 注释会让"不得出现某写法"这类断言误报（说明性文字里也会提到旧写法）。
  // Comments mention the old shapes too; strip them before negative assertions.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const layerFailedSource = extractFunction(libraryText, 'function wallpaperEngineLayerFailed(item, attemptedKind, token, failureError) {');
const layerFailedBody = stripComments(layerFailedSource);
const closeErrorSource = extractFunction(runtimeText, '  _windowCloseError(closeResult, closeError) {');
const entryUiSource = extractFunction(libraryText, 'function updateWallpaperEngineEntryUi(message) {');
const errorTextSource = extractFunction(libraryText, 'function wallpaperEngineRuntimeErrorText(error) {');

// ---------------------------------------------------------------------------
// 1. 原生关窗：硬等 1800ms → 轮询到 HWND 真正消失，并回传实际等待时长
// ---------------------------------------------------------------------------

const closeWaitMatch = runtimeText.match(/closeWait\.ElapsedMilliseconds < (\d+)\)\s*Thread\.Sleep\((\d+)\)/);
assert(closeWaitMatch, 'native close must poll IsWindow with a bounded wait');
const closeWaitCeilingMs = Number(closeWaitMatch[1]);
assert(
  closeWaitCeilingMs >= 6000,
  `native close ceiling must leave room for a slow teardown, got ${closeWaitCeilingMs}ms`
);
assert(
  !/< 1800\)/.test(runtimeText) && !runtimeText.includes('ElapsedMilliseconds < 1800'),
  'the legacy 1800ms hard cap must stay removed'
);
assert(
  runtimeText.includes('closeResult.closeWaitMs = closeWait.ElapsedMilliseconds;'),
  'native close must report how long it actually waited'
);
assert(
  /\n\s*public long closeWaitMs \{ get; set; \}/.test(runtimeText),
  'the native result DTO must carry the observed close wait'
);

// 外层窗口控制进程的预算必须比关窗轮询宽裕得多，否则慢机器会在轮询还在进行时被 execFile
// 杀掉，把"没等够"换个地方重新变成失败。
// The window-control process budget has to stay well clear of the close poll, otherwise a slow
// machine gets killed mid-poll and the same "not enough waiting" failure reappears elsewhere.
const windowControlTimeoutMatch = runtimeText.match(/timeout: (\d+),\n\s*maxBuffer: 128 \* 1024,/);
assert(windowControlTimeoutMatch, 'the window control process must declare an exec timeout');
const windowControlTimeoutMs = Number(windowControlTimeoutMatch[1]);
assert(
  windowControlTimeoutMs >= closeWaitCeilingMs + 10000,
  `the window control budget (${windowControlTimeoutMs}ms) must leave >= 10000ms of headroom over the close poll (${closeWaitCeilingMs}ms)`
);

// 两处守卫脚本各自钉了旧的 1800 常量，必须改为断言"轮询 + 上限下限"。
// Both guard scripts pinned the old constant; they must assert the shape and a floor instead.
assert(
  !/ElapsedMilliseconds < 1800/.test(quickCheckText + runtimeCheckText),
  'the static guards must not pin the old 1800ms cap'
);
assert(
  quickCheckText.includes('closeWaitCeilingMs < 6000'),
  'the static guard must fail when the close ceiling drops below 6000ms'
);
assert(
  runtimeCheckText.includes('closeWaitCeilingMs >= 6000'),
  'the runtime guard must fail when the close ceiling drops below 6000ms'
);
assert(
  runtimeCheckText.includes('closeResult.closeWaitMs = closeWait.ElapsedMilliseconds'),
  'the runtime guard must require the observed close wait to be reported'
);

// ---------------------------------------------------------------------------
// 2. 关窗原因不再被吞：阶段 + 原因挂到抛出的错误上
// ---------------------------------------------------------------------------

// 旧实现是空的 catch，底层原因（标题校验、进程校验、控制器起不来）全部消失。
// The old implementation swallowed everything in an empty catch block.
assert(
  /closeError = error;/.test(runtimeText) && /throw this\._windowCloseError\(closeResult, closeError\);/.test(runtimeText),
  '_relaunchSessionWindow must keep the close cause and throw it through _windowCloseError'
);
assert(
  !/_controlSessionWindow\('close', session, previousSourceId\);\s*\}\s*catch \(_\) \{ \}/.test(runtimeText),
  'the empty close catch must stay removed'
);
assert(
  /failure\.nativeStage = 'exec';/.test(runtimeText) && /failure\.nativeDetail = detail;/.test(runtimeText),
  'the native exec failure must carry its stderr detail'
);
assert(
  /failure\.nativeStage = 'parse';/.test(runtimeText),
  'an unparseable native result must be distinguishable from an exec failure'
);

const runtimeErrorFactory = 'function runtimeError(code) {\n  const error = new Error(code);\n  error.code = code;\n  return error;\n}';

function runCloseError(closeResult, closeError) {
  const context = vm.createContext({ console });
  // _windowCloseError 是类简写方法，必须包在类里才能脱离原文件求值。
  // _windowCloseError is a shorthand class method; it only parses inside a class body.
  vm.runInContext(
    `${runtimeErrorFactory}\nclass WindowCloseHost {\n${closeErrorSource}\n}`,
    context,
    { filename: 'wallpaper-engine-window-close-recovery.js' }
  );
  return vm.runInContext(
    `new WindowCloseHost()._windowCloseError(${JSON.stringify(closeResult)}, ${JSON.stringify(closeError)})`,
    context
  );
}

const timeoutFailure = runCloseError({ closeWaitMs: 6040, closed: false }, null);
assert.strictEqual(timeoutFailure.code, 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED');
assert.strictEqual(timeoutFailure.closeStage, 'timeout', 'a window that outlived the wait is a timeout stage');
assert.strictEqual(timeoutFailure.closeWaitMs, 6040, 'the timeout stage must carry the observed wait');
assert(
  timeoutFailure.closeReason.includes('6040'),
  'the timeout reason must quote the observed wait so the slow teardown is visible'
);

const controlFailure = runCloseError(null, {
  code: 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED',
  nativeDetail: 'Capture window title mismatch',
});
assert.strictEqual(controlFailure.closeStage, 'control', 'a controller throw is a control stage');
assert(
  controlFailure.closeReason.includes('Capture window title mismatch'),
  'the control stage must surface the native detail rather than a bare code'
);

const shapedFailure = runCloseError({ closeWaitMs: 6100 }, { closeReason: 'Window process mismatch' });
assert.strictEqual(
  shapedFailure.closeReason,
  'Window process mismatch',
  'an already-shaped controller reason must survive'
);
const codeOnlyFailure = runCloseError(null, { code: 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED' });
assert.strictEqual(codeOnlyFailure.closeReason, 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED', 'the code is the last resort');

// 失败阶段与原因必须一路带到渲染进程，并且落进 startup-error.log。
// The failing stage and reason must reach the renderer and land in startup-error.log.
assert(
  /writeStartupErrorLog\('Wallpaper Engine embed', embedCode, embeddingError\)/.test(mainText),
  'embed/align failures must be persisted with their native cause'
);
assert(
  /writeStartupErrorLog\('Wallpaper Engine start', startCode, error\)/.test(mainText),
  'pre-embed native failures must be persisted too'
);
assert(
  /errorStage: String\(embeddingError && embeddingError\.closeStage \|\| ''\)/.test(mainText),
  'the IPC result must forward the failing stage to the renderer'
);
assert(
  /startFailure\.closeStage = String\(result\.errorStage\)/.test(libraryText),
  'the renderer must carry the failing stage onto the thrown error'
);
assert(
  /errorDetail: String\(embeddingError && \(embeddingError\.closeReason \|\| embeddingError\.nativeDetail\) \|\| ''\)/.test(mainText),
  'the IPC result must forward the native detail for the log'
);

// ---------------------------------------------------------------------------
// 3. 瞬态关窗失败自动补试一次
// ---------------------------------------------------------------------------

// 自动补试必须在"退回封面图"之前发生，否则 kind 已经变成 'preview'，补试也无从谈起。
// The auto-retry has to run before the cover-art fallback flips `kind` to 'preview'.
const autoRetryIndex = layerFailedBody.indexOf('wallpaperEngineNativeAutoRetryUsed < 1');
const previewFallbackIndex = layerFailedBody.indexOf("wallpaperEngineSelection.kind = 'preview';");
assert(autoRetryIndex >= 0, 'wallpaperEngineLayerFailed must own the auto-retry decision');
assert(previewFallbackIndex > autoRetryIndex, 'the auto-retry must be evaluated before the preview fallback');
assert(
  /String\(failureError && failureError\.closeStage \|\| ''\) !== 'control'/.test(layerFailedBody),
  'a window the controller could never recognise must not burn the auto-retry budget'
);

function buildLayerFailedSandbox(options = {}) {
  const bridge = { __timers: [], __cleared: [], __toasts: [], __applied: [], __ui: [] };
  const context = vm.createContext(Object.assign({ console }, bridge));
  const selection = Object.assign(
    { active: true, kind: 'engine', id: 'abc', mediaType: 'video', title: 'Demo' },
    options.selection || {}
  );
  const prelude = [
    `var wallpaperEngineLayerToken = ${JSON.stringify(options.token === undefined ? 7 : options.token)};`,
    `var wallpaperEngineNativeSessionId = ${JSON.stringify(options.sessionId || '')};`,
    `var wallpaperEngineHostRecoveryInFlight = ${options.hostRecoveryInFlight === true ? 'true' : 'false'};`,
    'var wallpaperEngineHostRecoveryAttempt = 0;',
    'var WALLPAPER_ENGINE_HOST_RECOVERY_MAX_ATTEMPTS = 3;',
    'var wallpaperEngineHostRecoveryRetryTimer = 0;',
    'var wallpaperEngineHostBoundsPreparing = false;',
    `var wallpaperEngineSelection = ${JSON.stringify(selection)};`,
    `var wallpaperEngineRuntimeError = ${JSON.stringify(options.runtimeError || '')};`,
    `var wallpaperEngineNativeAutoRetryUsed = ${JSON.stringify(options.autoRetryUsed || 0)};`,
    'var wallpaperEngineNativeAutoRetryTimer = 0;',
    'var WALLPAPER_ENGINE_NATIVE_AUTO_RETRY_DELAY_MS = 1200;',
    'function cancelWallpaperEngineFirstFrameWait() { }',
    'function reportWallpaperEngineCaptureResult() { }',
    'function stopWallpaperEngineCaptureStream() { }',
    'function stopWallpaperEngineNativeSession() { return Promise.resolve({ ok: true }); }',
    'function wallpaperEngineDesktopHostIsVisible() { return true; }',
    'function cancelWallpaperEngineHostRecovery() { }',
    'function cancelWallpaperEngineNativeAutoRetry() { }',
    'function restartWallpaperEngineAfterHostBoundsChange() { }',
    'function updateWallpaperEngineEntryUi(message) { __ui.push(String(message || "")); }',
    'function applyWallpaperEngineBackground(item, quiet) { __applied.push({ id: item && item.id, quiet: quiet === true }); }',
    'function showToast(message) { __toasts.push(String(message)); }',
    'function restoreOriginalBackgroundAfterWallpaperEngine() { }',
    'function clearWallpaperEngineLayerMedia() { }',
    'function setTimeout(fn, delay) { __timers.push({ fn: fn, delay: delay }); return __timers.length; }',
    'function clearTimeout(id) { __cleared.push(id); }',
    layerFailedSource,
  ].join('\n');
  vm.runInContext(prelude, context, { filename: 'wallpaper-engine-window-close-recovery.js' });
  return context;
}

const closeFailure = (stage) => {
  const error = { code: 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED' };
  if (stage) error.closeStage = stage;
  return error;
};
const previewItem = { id: 'abc', title: 'Demo', hasPreview: true };

function failLayer(context, item, attemptedKind, failureError, token = 7) {
  context.__previewItem = item;
  context.__failure = failureError;
  vm.runInContext(
    'wallpaperEngineLayerFailed(__previewItem, ' + JSON.stringify(attemptedKind) + ', ' + token + ', __failure);',
    context,
    { filename: 'wallpaper-engine-window-close-recovery.js' }
  );
  return vm.runInContext('wallpaperEngineSelection.kind', context);
}

// 瞬态关窗失败：留在 engine，安排一次 1.2s 后的补试，不切预览。
// A transient close failure stays on the native path and schedules exactly one re-attempt.
const transientContext = buildLayerFailedSandbox();
const transientKind = failLayer(transientContext, previewItem, 'engine', closeFailure(''));
assert.strictEqual(transientKind, 'engine', 'a transient close failure must not fall back to the preview');
assert.strictEqual(transientContext.__timers.length, 1, 'exactly one re-attempt must be scheduled');
assert.strictEqual(transientContext.__timers[0].delay, 1200, 'the re-attempt must wait for the teardown to finish');
assert.strictEqual(transientContext.__applied.length, 0, 'the fallback must not run while a re-attempt is pending');
assert.strictEqual(transientContext.__toasts.length, 0, 'the user must not be told it already failed');
assert.strictEqual(
  vm.runInContext('wallpaperEngineNativeAutoRetryUsed', transientContext),
  1,
  'the single re-attempt budget must be consumed'
);
assert(
  String(transientContext.__ui.join(' ')).includes('自动重试'),
  'the entry row must say a re-attempt is in flight'
);

// 补试到点后必须真的重跑一次背景应用，并清掉上一次的错误文案。
// When the timer fires the background is genuinely re-applied and the stale error clears.
vm.runInContext('__timers[0].fn();', transientContext);
// 沙箱里创建的对象属于另一个 realm，原型不同，deepStrictEqual 会误报；序列化比较。
// Objects built inside the sandbox live in another realm, so compare their JSON shape.
assert.strictEqual(
  JSON.stringify(transientContext.__applied),
  JSON.stringify([{ id: 'abc', quiet: false }]),
  'the re-attempt must re-run the background application for the same project'
);
assert.strictEqual(
  vm.runInContext('wallpaperEngineRuntimeError', transientContext),
  '',
  'the re-attempt must clear the stale error before retrying'
);

// 补试期间用户换了项目或关掉了壁纸，回调必须放弃，不能把旧项目拉回来。
// If the selection moved on, the pending re-attempt must not resurrect the old project.
const staleContext = buildLayerFailedSandbox();
failLayer(staleContext, previewItem, 'engine', closeFailure(''));
vm.runInContext('wallpaperEngineLayerToken = 8;', staleContext);
vm.runInContext('__timers[0].fn();', staleContext);
assert.strictEqual(staleContext.__applied.length, 0, 'a superseded token must cancel the pending re-attempt');

const deactivatedContext = buildLayerFailedSandbox();
failLayer(deactivatedContext, previewItem, 'engine', closeFailure(''));
vm.runInContext('wallpaperEngineSelection.active = false;', deactivatedContext);
vm.runInContext('__timers[0].fn();', deactivatedContext);
assert.strictEqual(deactivatedContext.__applied.length, 0, 'deactivating the wallpaper must cancel the re-attempt');

// 控制器根本没认出窗口：重试再多次也没用，直接退回封面图，并且要如实说明。
// A window the controller could never recognise never recovers; fall back and say so.
const controlContext = buildLayerFailedSandbox();
const controlKind = failLayer(controlContext, previewItem, 'engine', closeFailure('control'));
assert.strictEqual(controlKind, 'preview', 'a control-stage close failure must fall back immediately');
assert.strictEqual(controlContext.__timers.length, 0, 'an unrecognisable window must not burn a re-attempt');
assert(
  String(controlContext.__toasts.join(' ')).includes('已切换到项目预览'),
  'the fallback must still tell the user what happened'
);

// 额度用完之后同样退回封面图，避免无限重启。
// Once the single re-attempt is spent the fallback takes over, so nothing loops.
const spentContext = buildLayerFailedSandbox({ autoRetryUsed: 1 });
assert.strictEqual(
  failLayer(spentContext, previewItem, 'engine', closeFailure('')),
  'preview',
  'the fallback must take over once the re-attempt budget is spent'
);
assert.strictEqual(spentContext.__timers.length, 0, 'no second re-attempt may be scheduled');

// 其它原生失败（超时、签名无效…）不受影响，仍然直接退回封面图。
// Unrelated native failures keep the original straight-to-preview behaviour.
const otherContext = buildLayerFailedSandbox();
assert.strictEqual(
  failLayer(otherContext, previewItem, 'engine', { code: 'WALLPAPER_ENGINE_WINDOW_TIMEOUT' }),
  'preview',
  'a non-close native failure must still fall back to the preview'
);
assert.strictEqual(otherContext.__timers.length, 0, 'only close failures are worth re-attempting');

// media 分支与 token 失效路径不受影响。
// The media branch and the stale-token guard keep their behaviour.
const mediaContext = buildLayerFailedSandbox();
assert.strictEqual(
  failLayer(mediaContext, previewItem, 'media', null),
  'preview',
  'a media decode failure must still fall back to the safe preview'
);
assert.strictEqual(mediaContext.__timers.length, 0, 'media failures must not schedule a native re-attempt');

const staleTokenContext = buildLayerFailedSandbox();
assert.strictEqual(
  failLayer(staleTokenContext, previewItem, 'engine', closeFailure(''), 99),
  'engine',
  'a stale token must make the failure handler a no-op'
);
assert.strictEqual(staleTokenContext.__timers.length, 0, 'a stale token must schedule nothing');

// 补试额度必须在"用户主动重试"和"原生真的跑起来"时归还，否则一次失败会把后续会话的
// 额度全部吃掉。
// The budget has to come back on an explicit retry and on a genuinely ready native scene.
const layerReadySource = extractFunction(libraryText, 'function wallpaperEngineLayerReady(kind, token) {');
const readyResetOffset = layerReadySource.indexOf('wallpaperEngineNativeAutoRetryUsed = 0;');
const readyGuardOffset = layerReadySource.indexOf("if (kind === 'dwm')");
assert(readyGuardOffset >= 0, 'the ready path must special-case the native DWM surface');
assert(
  readyResetOffset > readyGuardOffset && readyResetOffset - readyGuardOffset < 200,
  'the native ready path must return the auto-retry budget'
);

const activateSource = extractFunction(libraryText, 'function activateWallpaperEngineItem(id) {');
assert(
  activateSource.includes('wallpaperEngineNativeAutoRetryUsed = 0;')
  && activateSource.includes('cancelWallpaperEngineNativeAutoRetry();'),
  'an explicit activation must restore and cancel the auto-retry state'
);
const deactivateSource = extractFunction(libraryText, 'function deactivateWallpaperEngineBackground(quiet) {');
assert(
  deactivateSource.includes('wallpaperEngineNativeAutoRetryUsed = 0;')
  && deactivateSource.includes('cancelWallpaperEngineNativeAutoRetry();'),
  'deactivation must clear the pending re-attempt'
);

// ---------------------------------------------------------------------------
// 4. 预览兜底的文案不再被"已显示原背景"抢先
// ---------------------------------------------------------------------------

const entryUiBody = stripComments(entryUiSource);
const previewBranchIndex = entryUiBody.indexOf("wallpaperEngineSelection.kind === 'preview'");
const runtimeErrorBranchIndex = entryUiBody.indexOf("' · 已显示原背景'");
assert(previewBranchIndex >= 0, 'the entry row must know how to label a preview fallback');
assert(
  runtimeErrorBranchIndex > previewBranchIndex,
  'the preview branch must win over the runtime-error branch, otherwise the cover art is labelled as the original background'
);

function runEntryUi(selection, runtimeError, message, flags) {
  const bridge = {
    __value: { textContent: '' },
    __restore: { disabled: false },
    __retry: { disabled: false },
  };
  const context = vm.createContext(Object.assign({ console }, bridge));
  const passive = flags || {};
  const prelude = [
    `var wallpaperEngineSelection = ${JSON.stringify(selection)};`,
    `var wallpaperEngineRuntimeError = ${JSON.stringify(runtimeError || '')};`,
    `var wallpaperEngineDesktopPreviewActive = ${passive.desktopPreviewActive === true};`,
    `var wallpaperEngineDesktopPreviewUsesAsset = ${passive.desktopPreviewUsesAsset === true};`,
    'var document = { getElementById: function (id) { '
      + "if (id === 'wallpaper-engine-value') return __value; "
      + "if (id === 'wallpaper-engine-restore-btn') return __restore; "
      + "if (id === 'wallpaper-engine-retry-btn') return __retry; return null; } };",
    entryUiSource,
  ].join('\n');
  vm.runInContext(prelude, context, { filename: 'wallpaper-engine-window-close-recovery.js' });
  vm.runInContext(`updateWallpaperEngineEntryUi(${message ? JSON.stringify(message) : ''});`, context);
  return { text: context.__value.textContent, retryDisabled: context.__retry.disabled };
}

const previewUi = runEntryUi(
  { active: true, kind: 'preview', title: 'Minimalist Gengar' },
  '上一次 Mineradio 实时壁纸窗口仍在收尾，请稍后重试',
  ''
);
assert(
  previewUi.text.includes('项目预览（非动态壁纸）'),
  `a preview fallback must be labelled as a preview, got: ${previewUi.text}`
);
assert(
  !previewUi.text.includes('已显示原背景'),
  'a cover-art fallback must never claim the original background is on screen'
);
assert(
  previewUi.text.includes('请稍后重试'),
  'the preview label must still carry the retry hint so the user knows why'
);

// 桌面被动模式退回封面/原背景时 kind 仍是 'engine'。只看 kind 会把它当成"正在实时运行"，
// 于是屏幕上明明是封面图、重试入口却是灰的——用户没有任何可点的出路。
// Desktop passive mode keeps kind === 'engine' while showing cover art or the plain background.
// A kind-only test calls that "running" and leaves the retry entry greyed out with no way out.
const passiveCoverUi = runEntryUi(
  { active: true, kind: 'engine', title: 'Minimalist Gengar' },
  '',
  '',
  { desktopPreviewActive: true, desktopPreviewUsesAsset: true }
);
assert(
  passiveCoverUi.text.includes('桌面被动模式') && passiveCoverUi.text.includes('项目预览'),
  `a desktop-passive cover art must be labelled as such, got: ${passiveCoverUi.text}`
);
assert.strictEqual(
  passiveCoverUi.retryDisabled,
  false,
  'a desktop-passive cover-art fallback must keep the retry entry clickable'
);

const passiveBackgroundUi = runEntryUi(
  { active: true, kind: 'engine', title: 'Minimalist Gengar' },
  '',
  '',
  { desktopPreviewActive: true, desktopPreviewUsesAsset: false }
);
assert.strictEqual(
  passiveBackgroundUi.retryDisabled,
  false,
  'a desktop-passive plain-background fallback must also keep the retry entry clickable'
);

// 反过来：真的在实时运行、或正在播媒体、或压根没启用，都不该把重试入口常驻出来。
// The other direction: a running scene, a media wallpaper, or no selection at all must not
// leave a permanent retry button behind.
assert.strictEqual(
  runEntryUi({ active: true, kind: 'engine', title: 'Minimalist Gengar' }, '', '').retryDisabled,
  true,
  'a running native scene must keep the retry entry disabled'
);
assert.strictEqual(
  runEntryUi({ active: true, kind: 'media', title: 'Minimalist Gengar' }, '', '').retryDisabled,
  true,
  'a media wallpaper is not a failed native run and must not offer a retry'
);
assert.strictEqual(
  runEntryUi({ active: false, kind: 'preview', title: 'Minimalist Gengar' }, '', '').retryDisabled,
  true,
  'an inactive selection must not offer a retry'
);
assert.strictEqual(
  runEntryUi({ active: true, kind: 'engine', title: 'Minimalist Gengar' }, '运行失败', '').retryDisabled,
  false,
  'a recorded run error must still keep the retry entry clickable'
);
assert.strictEqual(previewUi.retryDisabled, false, 'the retry entry must stay reachable while on the preview');

const genuineErrorUi = runEntryUi(
  { active: true, kind: 'engine', title: 'Minimalist Gengar' },
  'WE 引擎运行失败',
  ''
);
assert(
  genuineErrorUi.text.includes('已显示原背景'),
  'a real native failure with no fallback must still say the original background is back'
);
const engineUi = runEntryUi({ active: true, kind: 'engine', title: 'Minimalist Gengar' }, '', '');
assert(engineUi.text.includes('WE 引擎实时运行'), 'a running native scene keeps its own label');
const idleUi = runEntryUi({ active: false, kind: 'preview', title: '' }, '', '');
assert.strictEqual(idleUi.text, '未启用 · 原背景保留', 'an inactive selection keeps the default label');

// 文案本身也要按失败阶段说话：窗口校验失败时不能叫用户"稍后重试"。
// The message itself must follow the stage: a window the controller cannot recognise is not
// something the user can retry away by waiting.
function runErrorText(error) {
  const context = vm.createContext({ console });
  vm.runInContext(errorTextSource, context, { filename: 'wallpaper-engine-window-close-recovery.js' });
  return vm.runInContext(`wallpaperEngineRuntimeErrorText(${JSON.stringify(error)})`, context);
}
const transientText = runErrorText({ code: 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED', closeStage: 'timeout' });
assert(transientText.includes('请稍后重试'), 'a teardown timeout is worth retrying and must say so');
const controlText = runErrorText({ code: 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED', closeStage: 'control' });
assert(
  !controlText.includes('请稍后重试'),
  `an unrecognisable window must not be advertised as retryable, got: ${controlText}`
);
assert(controlText.includes('窗口校验失败'), 'the control stage must name the real reason');

console.log('[OK] A close failure now polls for the real HWND teardown, keeps its native cause, '
  + 're-attempts a transient failure once, and labels the cover-art fallback honestly.');
