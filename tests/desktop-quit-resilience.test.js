'use strict';

// 「关闭到托盘后托盘显示/退出没反应、进程杀不掉」的回归守卫（2026-11-06 用户报）。
//
// 根因：汽水音乐安全验证窗口是常驻隐藏窗口，close 里无条件 preventDefault()+hide()。
// Electron 的 app.quit() 只有在所有窗口都允许关闭后才会走到 will-quit；任意一个窗口
// 拒绝关闭，退出流程会永远停在 before-quit 之后，进程变成没有界面的僵尸。
// 因此退出清理必须主动销毁这个窗口，且在最后的 app.quit() 之后留一个强制退出的兜底。
//
// 托盘「显示」的第二个坑：主窗口被上一次退出尝试销毁后，focusMainWindow() 直接
// return false，用户点「显示」毫无反应。这里必须能重新建窗口。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(ROOT, 'server', 'qishui-auth-v6.js'), 'utf8');
const OVERLAY = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'),
  'utf8'
);

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `找不到切片：${startMarker}`);
  return text.slice(start, end);
}

test('before-quit 会销毁汽水音乐验证窗口，并在退不掉时强制退出', () => {
  const quit = slice(MAIN, "app.on('before-quit'", "app.on('will-quit'");
  assert.match(quit, /'dispose-qishui-auth',\s*\(\)\s*=>\s*disposeQishuiAuthForQuit\(\)/);
  assert.match(quit, /app\.exit\(0\)/);
  assert.match(quit, /quit still pending/);
});

test('disposeQishuiAuthForQuit 走 qishui-auth-v6 的 disposeForQuit', () => {
  const helper = slice(MAIN, 'function disposeQishuiAuthForQuit()', 'function createOrUpdateTray()');
  assert.match(helper, /require\('\.\.\/server\/qishui-auth-v6'\)/);
  assert.match(helper, /disposeForQuit/);
});

test('qishui-auth-v6 提供退出用的 disposeForQuit 并真正销毁窗口', () => {
  assert.match(AUTH, /function disposeForQuit\(\)/);
  assert.match(AUTH, /disposeForQuit,\s*\n\s*constants:/);
  const fn = slice(AUTH, 'function disposeForQuit()', 'module.exports');
  assert.match(fn, /current\.destroying = true/);
  assert.match(fn, /current\.window\.destroy\(\)/);
  assert.match(fn, /current\.assetServer\.close\(\)/);
});

test('托盘「显示」在主窗口已销毁时重建窗口', () => {
  const focus = slice(MAIN, 'function focusMainWindow()', 'function createOrUpdateTray()');
  assert.match(focus, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\)/);
  assert.match(focus, /createWindow\(\)/);
  assert.match(focus, /if \(appQuitting\) return false;/);
});

test('关闭到托盘时窗口被意外销毁会重建，而不是留下点不出来的托盘', () => {
  const closed = slice(MAIN, "win.on('closed'", "win.on('enter-full-screen'");
  assert.match(closed, /!appQuitting && closeBehavior === 'tray'/);
  assert.match(closed, /createWindow\(\)/);
});

test('标题栏关闭不再把可能过期的渲染层设置传给主进程', () => {
  assert.ok(OVERLAY.includes('api.close();'), '标题栏关闭应让主进程按当前 closeBehavior 决定');
  assert.ok(!OVERLAY.includes('api.close(closeBehaviorPreference)'), '不应再把渲染层缓存的关闭行为传给主进程');
});
