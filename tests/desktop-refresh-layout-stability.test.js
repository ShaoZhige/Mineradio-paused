'use strict';

// 桌面「刷新」只会重建图标层，界面本身没变。重绑期间的中间状态必须被丢掉，重复的窗口状态
// 也必须去重，否则安全区/类名会被反复重算，歌词行会闪到下一行。
// A desktop refresh only rebuilds the icon layer. Transient rebind statuses must be dropped and
// repeated window-state reports deduped, otherwise the safe area / body classes get recomputed
// and the lyric line visibly jumps.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8');

const shell = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
const runtime = read('desktop/full-desktop-mode-runtime.js');

// 1) 重绑中间态（recovering-icon-layer）只更新内存状态，不重排界面。
assert.match(shell, /var transientHostRecovery = String\(status\.phase \|\| ''\) === 'recovering-icon-layer';/);
assert.match(shell, /if \(transientHostRecovery\) return desktopWallpaperRuntimeState;/);
const applyStatus = shell.slice(
  shell.indexOf('function applyDesktopWallpaperRuntimeStatus'),
  shell.indexOf('function desktopWallpaperErrorLabel')
);
assert.ok(applyStatus.indexOf('syncDesktopWallpaperBodyClasses') > applyStatus.indexOf('if (transientHostRecovery) return'),
  'transient recovery status must return before body-class/safe-area sync');

// 2) 重复的窗口状态直接跳过（桌面刷新会重复上报同一份状态）。
assert.match(shell, /if \(stateKey === applyState\.lastKey\) return;/);
assert.match(shell, /applyState\.lastKey = stateKey;/);

// 3) 桌面刷新触发的重绑不隐藏窗口（hide/show 会让歌词重新加载）。
assert.match(runtime, /const keepVisible = \/desktop-icon-host-changed\/\.test\(String\(reason \|\| ''\)\);/);
assert.match(runtime, /if \(!keepVisible\) safeCall\(this\.window, 'hide', null\);/);

// 4) 桌面刷新不再打开恢复熔断（两次刷新就退出桌面模式的老问题）。
assert.match(runtime, /ICON_HOST_CHANGED_RECOVERY_CIRCUIT_LIMIT/);
assert.match(runtime, /const recoveryLimit = hostChanged\s*\?\s*ICON_HOST_CHANGED_RECOVERY_CIRCUIT_LIMIT/);

console.log('OK desktop-refresh-layout-stability');
