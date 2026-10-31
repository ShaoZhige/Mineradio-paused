'use strict';

// 主窗口一不可见（最小化 / 托盘隐藏 / 退出），壁纸就必须整块退场：WE 播放窗口、DWM 表面、
// 指针中继全部收掉，后台只留音乐播放和桌面歌词。曾经为了让最小化恢复不黑屏，主进程在最小化
// 时把原生表面留成常驻（#406），代价是壁纸一直挂在桌面上——用户看不到「壁纸已经关了」。
//
// Whenever the host window is not visible the wallpaper must be gone entirely: only audio playback
// and the desktop-lyrics window keep running.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const LIBRARY = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js'),
  'utf8'
);

function functionSource(source, signature) {
  const from = source.indexOf(signature);
  assert.ok(from >= 0, '找不到 ' + signature);
  const open = from + signature.length - 1;
  assert.strictEqual(source[open], '{', signature + ' 后面应当紧跟函数体');
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error('花括号不平衡：' + signature);
}

test('最小化不再保留常驻原生表面，统一走完整停止', () => {
  const body = functionSource(MAIN, 'function suspendWallpaperEngineForHiddenHost(win, reason = \'hidden\') {');
  assert.match(body, /stopWallpaperEngineRuntimeForRenderer\(/, '不可见时必须真的停止 WE 会话');
  assert.doesNotMatch(body, /preserved/, '没有任何隐藏路径可以「保留现场」');
  assert.doesNotMatch(body, /phase: 'hold'/, '不再向渲染进程发送 hold');
  assert.doesNotMatch(body, /dwmSurfaceReady/, '最小化不再走 DWM 常驻快路径');
});

test('恢复路径只走整轮重启，不再有 resident 认领', () => {
  const body = functionSource(MAIN, 'function resumeWallpaperEngineForVisibleHost(win, reason = \'visible\') {');
  assert.match(body, /phase: 'restart'/, '重新可见时让渲染进程重建会话');
  assert.doesNotMatch(body, /phase: 'resident'/, 'resident 认领分支已删除');
  assert.doesNotMatch(body, /syncWallpaperEngineDesktopIconLayering\(`resident-/, 'resident 恢复的图标层同步已删除');
});

test('最小化、隐藏、托盘关闭都会挂起壁纸', () => {
  const minimize = MAIN.slice(MAIN.indexOf("win.on('minimize', () => {"));
  const minimizeBody = minimize.slice(0, minimize.indexOf("win.on('restore'"));
  assert.match(minimizeBody, /suspendWallpaperEngineForHiddenHost\(win, 'minimize'\)/);

  const hide = MAIN.slice(MAIN.indexOf("win.on('hide', () => {"));
  const hideBody = hide.slice(0, hide.indexOf("win.on('focus'"));
  assert.match(hideBody, /suspendWallpaperEngineForHiddenHost\(win, 'hide'\)/);
});

test('托盘关闭在 autosave 之前就开始收壁纸', () => {
  const close = MAIN.slice(MAIN.indexOf("win.on('close', (event) => {"));
  const closeBody = close.slice(0, close.indexOf("win.on('closed'"));
  const trayAt = closeBody.indexOf("closeBehavior === 'tray'");
  assert.ok(trayAt >= 0, '托盘关闭分支必须存在');
  const trayBranch = closeBody.slice(trayAt);
  const suspendAt = trayBranch.indexOf("suspendWallpaperEngineForHiddenHost(win, 'tray-hide')");
  const flushAt = trayBranch.indexOf("flushMainWindowFxAutosave('tray-hide')");
  assert.ok(suspendAt >= 0, '托盘关闭必须立即挂起壁纸');
  assert.ok(flushAt > suspendAt, '挂起壁纸要排在 autosave 与 hide() 之前');
});

test('退出时普通模式真的关掉壁纸，只让全桌面模式走停车', () => {
  const body = functionSource(MAIN, 'function hideVisibleSurfacesForQuit() {');
  assert.match(body, /setOpacity\(0\)/, '主窗口先透明化');
  assert.match(body, /stopWallpaperEngineRuntimeForRenderer\('quit-visible-surfaces'\)/, '普通模式退出要完整停止 WE');
  const parkAt = body.indexOf('parkActiveWindow()');
  const stopAt = body.indexOf("stopWallpaperEngineRuntimeForRenderer('quit-visible-surfaces')");
  assert.ok(parkAt >= 0 && stopAt > parkAt, '停车只能留在全桌面模式的早退分支里');
  assert.match(
    body.slice(0, stopAt),
    /desktopMode\.enabled === true[\s\S]{0,120}parkActiveWindow\(\)[\s\S]{0,40}return;/,
    '全桌面模式先停车，交给桌面模式 dispose 收尾'
  );
});

test('渲染进程隐藏即拆台，不再看 hold 标记', () => {
  assert.doesNotMatch(LIBRARY, /wallpaperEngineHostResidentHold/, 'hold 标记已删除');
  const listener = LIBRARY.slice(LIBRARY.indexOf("document.addEventListener('visibilitychange'"));
  const engineBranch = listener.slice(0, listener.indexOf("mediaType === 'video'"));
  assert.match(engineBranch, /__mineradioPrepareWallpaperEngineHostBoundsChange\(hiddenSessionId, 'document-hidden'\)/);
  assert.match(engineBranch, /stopWallpaperEngineNativeSession\(hiddenSessionId\)/, '隐藏时要停掉自己的会话');
});

test('渲染进程不再处理 hold / resident 阶段', () => {
  const body = functionSource(LIBRARY, 'function handleWallpaperEngineHostBoundsChange(payload) {');
  assert.doesNotMatch(body, /phase === 'hold'/);
  assert.doesNotMatch(body, /phase === 'resident'/);
  assert.match(body, /phase === 'restart'/);
  assert.match(body, /phase === 'prepare'/);
});
