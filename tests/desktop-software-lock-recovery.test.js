'use strict';
const { readAllCss } = require('./helpers/css-source');

// 锁定软件操作后，右上角必须仍然是可点的「解锁岛」：
//   1) 锁定期间把手保持可见（不被自动隐藏带走）；
//   2) 窗口交互区域里始终保留右上角走廊，输入才能回到渲染层；
//   3) 主进程只在指针进入控制区时恢复原生输入。
// The top-right control has to stay usable while the software is locked:
//   1) the handle must survive auto-hide,
//   2) the corridor stays inside the window's interactive rects,
//   3) the main process restores native input only over the controller.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8');

const shell = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
const runtime = read('desktop/full-desktop-mode-runtime.js');
const css = readAllCss();

// 1) 锁定期间强制保持把手可见。
assert.match(shell, /if \(active && softwareLocked\) \{\s*setDesktopModeControlPeek\(true\);\s*cancelDesktopModeControlHide\(\);\s*cancelDesktopModeControlPeekHide\(\);/);

// 2) 锁定期间固定补一块右上角交互区。
assert.match(shell, /desktopWallpaperRuntimeState\.softwareInteractionLocked === true/);
assert.match(shell, /rects\.push\(\{\s*x: Math\.max\(0, viewportWidth - corridorSafeRight - 92\)[\s\S]{0,240}kind: 'desktop-controls'/);
assert.match(shell, /viewportWidth - corridorSafeRight - 92/);

// 3) 主进程：锁定 + 指针不在控制区才穿透；进入控制区立刻恢复输入。
assert.match(runtime, /const ignoreMouseEvents = this\.softwareInteractionLocked === true\s*&& this\.pointerRoute\.overDesktopControls !== true;/);
assert.match(runtime, /setIgnoreMouseEvents', null, true, \{ forward: true \}/);
assert.match(runtime, /setIgnoreMouseEvents', null, false\)/);

// 3b) 锁定时不能把窗口设成不可聚焦：那会停掉转发鼠标移动，恢复走廊彻底失联。
const lockStart = runtime.indexOf('this.softwareInteractionLocked = desired;');
assert.ok(lockStart >= 0, 'lock assignment not found');
const lockBlock = runtime.slice(lockStart, runtime.indexOf('applyInteractivePointerRoute(this.window, { force: true })', lockStart));
assert.ok(lockBlock.length > 0, 'lock block not found');
assert.doesNotMatch(lockBlock, /setFocusable/, 'locking must keep the window focusable so forwarded moves keep flowing');

// 3c) Esc 是锁定状态下保证可用的退路：先解锁，再退出。
const main = read('desktop/main.js');
assert.match(main, /status\.softwareInteractionLocked === true\) \{\s*fullDesktopModeRuntime\.setSoftwareInteractionLocked\(false, `\$\{reason\}-unlock`\)/);

// 4) 样式：锁定态把手高亮，且 peek/打开时 dock 才可点。
assert.match(css, /body\.desktop-software-locked #desktop-mode-control-handle/);
assert.match(css, /desktop-mode-control-peek #desktop-mode-control-dock/);
assert.match(css, /desktop-mode-control-peek #desktop-mode-control-dock,[\s\S]{0,240}pointer-events:\s*auto/);

console.log('OK desktop-software-lock-recovery');
