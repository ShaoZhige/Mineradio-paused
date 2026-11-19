'use strict';

// 全屏 ↔ 窗口化后圆角变直角的回归测试
//
// 主窗口是透明无边框的，圆角由 #desktop-window-shell 的 border-radius + clip-path 画在
// 一个独立 GPU 合成层上。窗口尺寸在切换全屏时一两帧内从整屏跳到小窗，Chromium 有时不会按
// 新尺寸重建裁剪掩码，四角就按旧的直角矩形裁出来，直到某次无关重绘才恢复。修复是在尺寸
// 落定后把裁剪值微调 0.1px 再交还样式表，逼合成器重建掩码。
//
// The main window is transparent and frameless; the rounded corners are painted by
// #desktop-window-shell's border-radius/clip-path on a GPU layer. When the bounds jump between
// fullscreen and windowed, Chromium sometimes keeps the previous rectangular mask and the corners
// render square. The fix nudges the clip value after the bounds settle so the mask is rebuilt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const shellSource = fs
  .readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const coreCss = fs
  .readFileSync(path.join(appRoot, 'public', 'css', 'core.css'), 'utf8')
  .replace(/\r\n/g, '\n');

function functionSource(name) {
  const start = shellSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = shellSource.indexOf('\n}', start);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return shellSource.slice(start, end);
}

test('the rounded corners really are a CSS clip on the window shell', () => {
  // 这条是前提：圆角由 CSS 画，不是 DWM 给的，所以浏览器侧的裁剪掩码才是失效点。
  assert.match(coreCss, /#desktop-window-shell\s*\{[^}]*border-radius:\s*34px/);
  assert.match(coreCss, /#desktop-window-shell\s*\{[^}]*clip-path:\s*inset\(0 round 34px\)/);
  // 全屏/最大化/桌面壁纸模式必须把圆角收成 0，否则整屏时四角会露出桌面。
  assert.match(
    coreCss,
    /body\.desktop-shell\.desktop-fullscreen #desktop-window-shell[^{]*\{[^}]*border-radius:\s*0 !important/
  );
});

test('the clip refresh nudges the value and forces a layout flush', () => {
  const refresh = functionSource('refreshDesktopWindowCornerClip');
  // 必须写一个「几乎一样但确实不同」的值：值不变则合成器会把它优化掉。
  assert.match(refresh, /inset\(0 round 33\.9px\)/);
  assert.match(refresh, /shell\.style\.clipPath = nudged/);
  // 中间读一次布局，否则两次写入会合并成一次，掩码根本不会重建。
  assert.match(refresh, /void shell\.offsetWidth/);
  assert.match(refresh, /removeProperty\('clip-path'\)/);
});

test('the refresh is debounced past the main-process bounds restore', () => {
  const schedule = functionSource('scheduleDesktopWindowCornerClipRefresh');
  const delay = Number((schedule.match(/setTimeout\(function \(\) \{[\s\S]*?\}, (\d+)\);/) || [])[1]);
  assert.ok(Number.isFinite(delay), 'schedule must use a numeric delay');
  // 主进程 leave-full-screen 后等 50 ms 才 setBounds 回窗口尺寸，早于它刷新还是在旧尺寸上算掩码。
  assert.ok(delay >= 60, `delay must outlast the 50 ms bounds restore, got ${delay}`);
  assert.match(schedule, /clearTimeout\(desktopWindowCornerClipTimer\)/);
});

test('fullscreen, maximize and desktop-wallpaper transitions all trigger the refresh', () => {
  const applyStateBlock = shellSource.slice(shellSource.indexOf('function applyState(state)'));
  const callSite = applyStateBlock.slice(0, applyStateBlock.indexOf('document.querySelectorAll("[data-window-action]"'));
  assert.match(callSite, /isFullScreen !== wasFullScreen/);
  assert.match(callSite, /isMaximized !== wasMaximized/);
  assert.match(callSite, /desktop-wallpaper-mode'\) !== wasWallpaperMode/);
  assert.match(callSite, /scheduleDesktopWindowCornerClipRefresh\(\)/);
});

test('window resizes also settle the clip', () => {
  // 拖拽改尺寸、最大化、DPI 跳变都走 resize，没有状态上报，得单独兜一层。
  assert.match(
    shellSource,
    /window\.addEventListener\('resize', scheduleDesktopWindowCornerClipRefresh, \{ passive: true \}\)/
  );
});
