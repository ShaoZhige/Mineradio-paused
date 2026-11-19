'use strict';

// 视频壁纸（mp4 / webm）走的是渲染层 <video>，而 Chromium 只带 H.264/VP9 一类解码器。
// MPEG-4 Part 2（mp4v）、HEVC 的项目在 video.onerror 里拿到 MEDIA_ERR_SRC_NOT_SUPPORTED，
// 旧逻辑直接把它降级成项目预览 —— 用户看到的就是"选了 mp4 壁纸，结果回退到一张封面图"。
// 本机 WE 引擎窗口能播这些编码（实测 mp4v 项目出画面），所以解码失败应先升级到引擎，
// 引擎也失败才回退预览，而且只升级一次，不能来回换播放器。
// Video wallpapers render through <video>, but Chromium only ships H.264/VP9-class decoders.
// MPEG-4 Part 2 and HEVC projects fail with MEDIA_ERR_SRC_NOT_SUPPORTED and used to drop
// straight to the project preview. The local engine window plays those codecs (measured with
// an mp4v project), so a decode failure upgrades to the engine once; only a second failure
// falls back to the preview.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js');
const rendererText = fs.readFileSync(rendererPath, 'utf8');

function extractFunction(source, name) {
  const syncStart = source.indexOf(`function ${name}(`);
  assert(syncStart >= 0, `missing function: ${name}`);
  const open = source.indexOf('{', syncStart);
  assert(open > syncStart, `missing body for: ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(syncStart, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${name}`);
}

function extractBlock(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `missing source block: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing block terminator: ${endNeedle}`);
  return source.slice(start, end);
}

function makeLayerFailedSandbox(selection, item) {
  const calls = { apply: [], toasts: [], stopped: 0 };
  const sandbox = {
    console,
    // 与模块里的状态同名同形态，函数体直接读写它们。
    wallpaperEngineLayerToken: 7,
    wallpaperEngineNativeSessionId: '',
    wallpaperEngineSelection: selection,
    wallpaperEngineRuntimeError: '',
    wallpaperEngineMediaNativeFallbackUsed: 0,
    wallpaperEngineNativeAutoRetryUsed: 0,
    wallpaperEngineHostRecoveryInFlight: false,
    wallpaperEngineHostRecoveryAttempt: 0,
    wallpaperEngineHostRecoveryRetryTimer: 0,
    wallpaperEngineHostBoundsPreparing: false,
    wallpaperEngineNativeAutoRetryTimer: 0,
    WALLPAPER_ENGINE_HOST_RECOVERY_MAX_ATTEMPTS: 3,
    WALLPAPER_ENGINE_NATIVE_AUTO_RETRY_DELAY_MS: 1200,
    cancelWallpaperEngineFirstFrameWait() { },
    cancelWallpaperEngineHostRecovery() { },
    cancelWallpaperEngineNativeAutoRetry() { },
    reportWallpaperEngineCaptureResult() { },
    stopWallpaperEngineCaptureStream() { },
    stopWallpaperEngineNativeSession() { calls.stopped += 1; return Promise.resolve({ ok: true }); },
    wallpaperEngineDesktopHostIsVisible() { return true; },
    restoreOriginalBackgroundAfterWallpaperEngine() { },
    clearWallpaperEngineLayerMedia() { },
    updateWallpaperEngineEntryUi() { },
    restartWallpaperEngineAfterHostBoundsChange() { },
    applyWallpaperEngineBackground(target, quiet) {
      calls.apply.push({ id: target && target.id, kind: selection.kind, quiet: quiet === true });
    },
    showToast(text) { calls.toasts.push(String(text)); },
    wallpaperEngineLibraryText(key, fallback) { return fallback == null ? key : fallback; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(rendererText, 'wallpaperEngineLayerFailed'), sandbox, { filename: 'layer-failed.js' });
  return { sandbox, calls, selection, item };
}

// ---------------------------------------------------------------------------
// ① mp4v / HEVC 解码失败 → 改交给本机引擎，而不是项目预览。
// A failed mp4/webm decode must hand the wallpaper to the engine, not the cover art.
// ---------------------------------------------------------------------------
{
  const selection = { active: true, id: 'b'.repeat(24), kind: 'media', mediaType: 'video' };
  const item = { id: 'b'.repeat(24), title: '雪夜街景', hasPreview: true, nativeVideoPlayable: true, mediaType: 'video' };
  const { sandbox, calls } = makeLayerFailedSandbox(selection, item);
  sandbox.wallpaperEngineLayerFailed(item, 'media', 7);

  assert.strictEqual(selection.kind, 'engine', 'a failed video decode must upgrade to the native engine');
  assert.strictEqual(sandbox.wallpaperEngineMediaNativeFallbackUsed, 1, 'the upgrade may only be spent once');
  assert.strictEqual(calls.apply.length, 1, 'the upgrade must re-apply the background exactly once');
  assert.strictEqual(calls.apply[0].kind, 'engine', 'the re-apply must run in engine mode, not media mode');
  assert.strictEqual(selection.mediaType, 'video', 'the media type must stay video');
  assert.ok(!calls.toasts.some((text) => /preview/i.test(text)), 'upgrading must not announce a preview fallback');
}

// ---------------------------------------------------------------------------
// ② 已经升级过一次（引擎也失败）→ 这时才回退项目预览，且不会再来回升级。
// Once the single upgrade is spent, an engine failure falls back to the preview.
// ---------------------------------------------------------------------------
{
  const selection = { active: true, id: 'c'.repeat(24), kind: 'engine', mediaType: 'video' };
  const item = { id: 'c'.repeat(24), title: '雪夜街景', hasPreview: true, nativeVideoPlayable: true, mediaType: 'video' };
  const { sandbox, calls } = makeLayerFailedSandbox(selection, item);
  sandbox.wallpaperEngineMediaNativeFallbackUsed = 1;
  sandbox.wallpaperEngineLayerFailed(item, 'engine', 7);

  assert.strictEqual(selection.kind, 'preview', 'a second failure must fall back to the project preview');
  assert.strictEqual(calls.apply.length, 1);
  assert.strictEqual(calls.apply[0].kind, 'preview');
}

// ---------------------------------------------------------------------------
// ③ 没有「引擎可播」标记的项目（web / application / 纯图片）行为不变。
// Projects without the flag keep the old behaviour.
// ---------------------------------------------------------------------------
{
  const selection = { active: true, id: 'd'.repeat(24), kind: 'media', mediaType: 'video' };
  const item = { id: 'd'.repeat(24), title: '普通视频', hasPreview: true, nativeVideoPlayable: false, mediaType: 'video' };
  const { sandbox, calls } = makeLayerFailedSandbox(selection, item);
  sandbox.wallpaperEngineLayerFailed(item, 'media', 7);

  assert.strictEqual(selection.kind, 'preview', 'a project the engine cannot play must keep the preview fallback');
  assert.strictEqual(sandbox.wallpaperEngineMediaNativeFallbackUsed, 0);
  assert.strictEqual(calls.apply[0].kind, 'preview');
}

// ---------------------------------------------------------------------------
// ④ 引擎模式的门槛要认这条新标记：只认 enginePlayable 的话，video 升到 engine 也会被
//    重新算回 media，形成死循环。
// The engine branch gate has to accept the new flag, otherwise a video upgrade would be
// recomputed back to media mode and loop.
// ---------------------------------------------------------------------------
const applyBlock = extractBlock(rendererText, 'function applyWallpaperEngineBackground(item, quiet) {', 'function activateWallpaperEngineItem(id, options) {');
assert.match(
  applyBlock,
  /var nativeReady = item\.enginePlayable \|\| item\.nativeVideoPlayable;/,
  'the engine branch must accept video projects the local engine can play'
);
assert.match(
  applyBlock,
  /wallpaperEngineSelection\.kind === 'engine' && nativeReady/,
  'engine mode must be gated by nativeReady, not by enginePlayable alone'
);

// ---------------------------------------------------------------------------
// ⑤ 手动重试要真的走引擎：普通激活对 video 仍然优先 <video>（更快、无额外窗口）。
// The retry entry must ask for the engine explicitly; normal activation still prefers <video>.
// ---------------------------------------------------------------------------
const activateBlock = extractBlock(rendererText, 'function activateWallpaperEngineItem(id, options) {', 'function retryWallpaperEngineNativeRun() {');
assert.match(
  activateBlock,
  /options && options\.forceEngine === true && item\.nativeVideoPlayable/,
  'only an explicit retry may force the engine for a video project'
);
assert.match(
  activateBlock,
  /kind: preferEngine \? 'engine' : \(item\.playable \? 'media' : 'preview'\)/,
  'video projects must keep playing through the built-in <video> unless the engine is forced'
);

// ---------------------------------------------------------------------------
// ⑥ 选择项归一化必须保留标记，否则重新载入快照后就丢了。
// The normalizer has to keep the flag or it disappears after a snapshot reload.
// ---------------------------------------------------------------------------
{
  const sandbox = { console, String, Number, Math, wallpaperEngineLibraryText: (key) => key };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(rendererText, 'normalizeWallpaperEngineProject'), sandbox, { filename: 'normalize.js' });
  const normalized = sandbox.normalizeWallpaperEngineProject({
    id: 'e'.repeat(24),
    title: '雪夜街景',
    projectType: 'video',
    mediaType: 'video',
    playable: true,
    nativeVideoPlayable: true,
    hasPreview: true,
  });
  assert.strictEqual(normalized.nativeVideoPlayable, true, 'the flag must survive normalization');
  const image = sandbox.normalizeWallpaperEngineProject({
    id: 'f'.repeat(24),
    title: '图片',
    projectType: 'image',
    mediaType: 'image',
    playable: true,
    nativeVideoPlayable: true,
    hasPreview: true,
  });
  assert.strictEqual(image.nativeVideoPlayable, false, 'only video media may claim the engine flag');
}

console.log('video native fallback: 6 checks passed');
