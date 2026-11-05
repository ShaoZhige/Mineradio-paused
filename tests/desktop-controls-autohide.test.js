'use strict';

// 完整桌面模式下的控制栏自动隐藏：用户显式打开自动隐藏时，桌面模式不能再把控制条钉住，
// 否则开关看起来完全失效。同时保证隐藏/唤回的链路仍然完整。
// Control-bar auto-hide in full desktop mode: an explicit preference must win over the
// desktop-mode pin, and the hide/reveal chain has to stay wired.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8');

const bottomControls = read('public/js/modules/01-scene/04-bottom-controls-cursor.js');
const pointerModule = read('public/js/modules/02-visual/00-pointer-cover-particles.js');

// 1) 桌面模式的钉住逻辑必须先看用户的自动隐藏偏好。
const pinStart = bottomControls.indexOf('function desktopWallpaperKeepsPlayerConsoleVisible()');
assert.ok(pinStart >= 0, 'desktop pin helper is missing');
const pinBlock = bottomControls.slice(pinStart, bottomControls.indexOf('function shouldShowHomeForPausedStartupRestore()', pinStart));
assert.match(pinBlock, /if \(controlsAutoHide\) return false;/, 'an explicit auto-hide preference must disable the desktop pin');
assert.match(pinBlock, /desktop-wallpaper-interactive/, 'the pin still applies to desktop mode only');

// 2) 隐藏与唤回链路保持完整：定时隐藏、指针移动更新、把手唤醒、把手点击切换。
assert.match(bottomControls, /function scheduleControlsHide\(delay\)/);
assert.match(bottomControls, /bar\.classList\.toggle\('soft-hidden'/);
assert.match(bottomControls, /function updateControlsAutoHideFromPointer\(x, y\)/);
assert.match(bottomControls, /if \(overHandle\) wakeBottomHandle\(\);/);
assert.match(bottomControls, /if \(overBar \|\| overMini \|\| overHandle\) revealBottomControls/);
assert.match(bottomControls, /function toggleControlsAutoHide\(\)/);
assert.match(pointerModule, /updateControlsAutoHideFromPointer\(e\.clientX, e\.clientY\)/);

// 2b) 320ms 健康检查不能在自动隐藏开启时再控制条显示（否则每次检查都会续期 900ms）。
const shell = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
assert.match(shell, /var autoHideOwnsVisibility = typeof controlsAutoHide !== 'undefined' && controlsAutoHide;/);
assert.match(shell, /if \(!autoHideOwnsVisibility\) \{[\s\S]{0,600}bar\.classList\.remove\('soft-hidden'\)/);
assert.match(shell, /ensureDesktopWallpaperFunctionalUi\('health-watch'\)/);
assert.match(shell, /ensureDesktopWallpaperFunctionalUi\('runtime-status'\)/);

// 2c) 桌面模式里窗口会被其它应用遮挡，Chromium 会降频定时器：进入桌面模式必须关掉
// 背景节流，退出时恢复，否则 70ms 的隐藏计时器会被拖到几十秒。
const main = read('desktop/main.js');
assert.match(main, /setMainWindowBackgroundThrottling\(win, false\);/);
assert.match(main, /releaseFullDesktopModeRecoveryTray\(\);[\s\S]{0,400}setMainWindowBackgroundThrottling\(mainWindow, MAIN_WINDOW_BACKGROUND_THROTTLING\);/);

// 3) 桌面模式下控制条的隐藏态不会被那条 .visible:not(.soft-hidden) 规则顶回来。
const css = read('public/css/index.css');
assert.match(css, /#bottom-bar\.soft-hidden\s*\{[\s\S]{0,120}opacity:\s*0/);
assert.match(css, /desktop-wallpaper-mode\.desktop-wallpaper-interactive:not\(\.empty-home-active\):not\(\.home-controls-locked\) #bottom-bar\.visible:not\(\.soft-hidden\)/);
assert.match(css, /body\.desktop-wallpaper-mode #bottom-handle/);

console.log('OK desktop-controls-autohide');
