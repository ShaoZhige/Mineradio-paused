'use strict';

// 最小化恢复后壁纸全黑 / 反复刷新的回归测试（#406）
//
// 症状：导入 WE 壁纸后最小化再打开，背景先变全黑，后台刷新一阵子壁纸才回来；有时永远不回来。
//
// 根因：最小化时主进程会刻意保留常驻原生 DWM 表面（resident），但渲染进程自己的
// visibilitychange 拆台会把本地会话状态清空（wallpaperEngineNativeSessionId / captureMode）
// 并把原生会话 stopWallpaperEngineScene 掉。于是恢复阶段 'resident' 里那条
// 「两个 session id 必须严格相等」的守卫永远不成立 → 图层保持空白（全黑）；同时
// wallpaperEngineHostBoundsPreparing 残留，让随后的 visibilitychange 触发整轮原生 Scene 重启
// （也就是用户看到的"后台一直刷新，卡一会儿才出图"）。
//
// Symptom: after minimizing, the background turns black and only comes back after a while (or never).
// While minimized, main keeps the native DWM surface resident, but the renderer's own
// visibilitychange teardown clears the local session state and stops the native session. The
// 'resident' restore guard then required the two session ids to be equal, which could never hold
// again, so the layer stayed blank and a stale preparing flag forced a full Scene restart.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const libraryPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js');
const librarySource = fs.readFileSync(libraryPath, 'utf8');
const mainSource = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');

const SESSION = 'a'.repeat(24);
const OTHER_SESSION = 'b'.repeat(24);

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} is missing`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

const calls = [];
const sandbox = {
  console: { warn() {}, info() {}, log() {} },
  RegExp,
  String,
  window: {},
  document: {},
  wallpaperEngineSelection: { active: false, kind: 'engine', id: '' },
  applyWallpaperEngineVisualSettings: () => calls.push('applyVisuals'),
  clearWallpaperEngineFreezeFrame: () => calls.push('clearFreeze'),
  scheduleWallpaperEngineGlassSamplerCapture: (sessionId) => calls.push('glass:' + sessionId),
  updateWallpaperEngineEntryUi: () => calls.push('entryUi'),
  restartWallpaperEngineAfterHostBoundsChange: () => calls.push('restart'),
};
vm.createContext(sandbox);
const varNames = [
  'wallpaperEngineNativeSessionId',
  'wallpaperEngineCaptureMode',
  'wallpaperEngineHostBoundsPreparing',
  'wallpaperEngineHostResidentHold',
  'wallpaperEngineLayerToken',
  'wallpaperEngineCaptureStream',
  'wallpaperEngineDesktopPreviewActive',
  'wallpaperEngineDesktopPreviewUsesAsset',
];
varNames.forEach((name) => {
  const declaration = librarySource.match(new RegExp(`^var ${name} = [^;]+;$`, 'm'));
  assert(declaration, `${name} declaration is missing`);
  vm.runInContext(declaration[0], sandbox);
});
vm.runInContext(extractFunction(librarySource, 'handleWallpaperEngineHostBoundsChange'), sandbox);

function reset(overrides) {
  calls.length = 0;
  sandbox.wallpaperEngineSelection = { active: true, kind: 'engine', id: 'wallpaper-1' };
  sandbox.wallpaperEngineNativeSessionId = '';
  sandbox.wallpaperEngineCaptureMode = '';
  sandbox.wallpaperEngineHostBoundsPreparing = false;
  sandbox.wallpaperEngineHostResidentHold = false;
  sandbox.wallpaperEngineLayerToken = 5;
  sandbox.wallpaperEngineCaptureStream = null;
  sandbox.wallpaperEngineDesktopPreviewActive = false;
  sandbox.wallpaperEngineDesktopPreviewUsesAsset = false;
  Object.assign(sandbox, overrides || {});
}

// 1. hold：主进程宣布本次隐藏不拆台，渲染进程只记标记、不做任何拆台动作。
reset();
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'hold', sessionId: SESSION, reason: 'minimize' });
assert.strictEqual(sandbox.wallpaperEngineHostResidentHold, true, 'a hold request must be remembered');
assert.strictEqual(sandbox.wallpaperEngineHostBoundsPreparing, false, 'a hold request must not leave the preparing flag set');
assert.deepStrictEqual(calls, [], 'a hold request must not touch the layer');

// 2. 正常恢复（本地会话仍在）：只恢复视觉，不重启原生 Scene。
reset({ wallpaperEngineNativeSessionId: SESSION, wallpaperEngineCaptureMode: 'dwm-thumbnail' });
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: SESSION, forceVisibleHost: true });
assert.strictEqual(calls.includes('restart'), false, 'a resident restore must never restart the native Scene');
assert.strictEqual(sandbox.wallpaperEngineNativeSessionId, SESSION, 'the resident session stays claimed');
assert.strictEqual(sandbox.wallpaperEngineCaptureMode, 'dwm-thumbnail', 'the capture mode stays authoritative');
assert.strictEqual(calls.filter((entry) => entry === 'applyVisuals').length, 1, 'the visuals are re-applied once');

// 3. 回归点：渲染进程已经自己拆过台（会话被清空 + preparing 残留）时，恢复必须重新认领。
reset({ wallpaperEngineHostBoundsPreparing: true });
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: SESSION, forceVisibleHost: true });
assert.strictEqual(
  sandbox.wallpaperEngineNativeSessionId,
  SESSION,
  'the resident session must be re-claimed after the renderer tore its own state down'
);
assert.strictEqual(sandbox.wallpaperEngineCaptureMode, 'dwm-thumbnail', 'the re-claim restores the capture mode');
assert.strictEqual(sandbox.wallpaperEngineHostBoundsPreparing, false, 'the stale preparing flag is cleared');
assert.strictEqual(
  calls.includes('glass:' + SESSION),
  true,
  'the glass sampler is re-acquired for the re-claimed session'
);
assert.strictEqual(calls.includes('restart'), false, 're-claiming must not fall back to a full Scene restart');

// 4. 真的换过壁纸/切过歌：本地持有的是另一个活会话，不能认领旧会话。
reset({ wallpaperEngineNativeSessionId: OTHER_SESSION, wallpaperEngineCaptureMode: 'dwm-thumbnail' });
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: SESSION, forceVisibleHost: true });
assert.strictEqual(sandbox.wallpaperEngineNativeSessionId, OTHER_SESSION, 'a stale resident session must not win');
assert.deepStrictEqual(calls, [], 'a stale resident session must not touch the layer');

// 5. 本地既没有会话、也没有拆台痕迹：与本次恢复无关。
reset();
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: SESSION, forceVisibleHost: true });
assert.deepStrictEqual(calls, [], 'an unrelated resident notice is ignored');

// 6. session id 不合法（主进程状态异常）时不得认领。
reset({ wallpaperEngineHostBoundsPreparing: true });
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: 'nonsense', forceVisibleHost: true });
assert.strictEqual(sandbox.wallpaperEngineNativeSessionId, '', 'an invalid session id is rejected');
assert.deepStrictEqual(calls, [], 'an invalid session id must not touch the layer');

// 7. 非 engine 壁纸与未启用状态不受影响。
reset({ wallpaperEngineSelection: { active: false, kind: 'engine', id: '' }, wallpaperEngineHostBoundsPreparing: true });
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: SESSION, forceVisibleHost: true });
assert.deepStrictEqual(calls, [], 'an inactive selection is ignored');

// 8. restart 阶段行为保持不变（prepare 标记 + 可见性检查）。
reset({ wallpaperEngineHostBoundsPreparing: true });
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'restart' });
assert.strictEqual(calls.includes('restart'), true, 'the restart phase keeps its existing behaviour');

// 9. prepare 阶段仍交给页面钩子。
reset({ wallpaperEngineHostBoundsPreparing: true });
sandbox.window.__mineradioPrepareWallpaperEngineHostBoundsChange = (sessionId, reason) => calls.push('prepare:' + sessionId + ':' + reason);
sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'prepare', sessionId: SESSION, reason: 'hide' });
assert.deepStrictEqual(calls, ['prepare:' + SESSION + ':hide'], 'the prepare phase stays delegated to the page hook');

// 10. 源码接线：主进程必须发出 hold，且渲染进程的拆台要带具体会话 id。
const residentBranch = mainSource.slice(
  mainSource.indexOf("if (/^minimi[sz]e(?:d)?$/.test(normalizedReason)"),
  mainSource.indexOf('wallpaperEngineHostVisibilityResidentMinimized = false;\n  wallpaperEngineHostVisibilityResidentMinimizedAt = 0;')
);
assert.match(residentBranch, /phase: 'hold'/, 'the resident minimize branch must announce a hold');
assert.match(residentBranch, /wallpaperEngineHostVisibilityResidentMinimizedAt = Date.now\(\)/, 'the resident hold must record when it started');
assert.match(
  mainSource,
  /wallpaperEngineHostVisibilityResidentMinimized === true[\s\S]{0,220}WALLPAPER_ENGINE_HOST_RESIDENT_STOP_HOLD_MS/,
  'the scoped stop-scene guard must be bounded by the resident hold window'
);
assert.match(
  mainSource,
  /const WALLPAPER_ENGINE_HOST_RESIDENT_STOP_HOLD_MS = \d+;/,
  'the resident stop hold window must be an explicit constant'
);
assert.match(
  librarySource,
  /stopWallpaperEngineNativeSession\(hiddenSessionId\)/,
  "the renderer's hidden teardown must scope the stop to its own session so main can tell it apart"
);
assert.match(
  librarySource,
  /var hiddenSessionId = String\(wallpaperEngineNativeSessionId \|\| ''\)/,
  'the session id must be captured before the prepare hook clears it'
);
assert.doesNotMatch(
  librarySource,
  /if \(phase === 'resident'\)[\s\S]{0,900}startWallpaperEngineNativeBackground/,
  'the resident restore must still avoid restarting the native Scene'
);

console.log('wallpaper engine resident minimize reclaim: 20 checks passed');
