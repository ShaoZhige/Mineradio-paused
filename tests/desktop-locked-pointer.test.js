'use strict';

// 桌面模式锁定后的鼠标契约：除了右上角控制器，软件界面完全不参与鼠标命中；
// 控制器的悬停展开/移开收起由主进程轮询真实光标驱动，面板里的开关仍可点击。
// Mouse contract while the desktop is locked: apart from the top-right controller the UI takes
// no mouse at all; hover-expand / leave-collapse is driven by a main-process cursor poll, and
// the switches inside the open panel stay clickable.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8');

const css = read('public/css/index.css');
const main = read('desktop/main.js');
const preload = read('desktop/preload.js');
const nativeLayer = read('desktop/desktop-native-icon-layer-runtime.js');
const runtime = read('desktop/full-desktop-mode-runtime.js');
const shell = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
const parts = read('public/js/modules/02-visual/00-pointer-cover-particles.js');
const peek = read('public/js/modules/10-shell/02-peek-panels-upload.js');

// 1) 锁定后：整页退出命中，只有把手与「展开的」面板恢复 pointer-events；收起的面板不能点。
assert.match(css, /body\.desktop-software-locked \* \{\s*pointer-events:\s*none !important/);
assert.match(css, /body\.desktop-software-locked #desktop-mode-control-handle,/);
assert.match(css, /body\.desktop-software-locked #desktop-mode-control-dock\.is-open #desktop-mode-control-panel,/);
assert.match(css, /body\.desktop-software-locked #desktop-mode-control-dock\.is-open #desktop-mode-control-panel \*/);

// 2) 全局鼠标观察者在锁定期间直接退出，不能再带动界面。
assert.match(parts, /if \(typeof desktopSoftwarePointerIgnored === 'function' && desktopSoftwarePointerIgnored\(\)\) return;/);
assert.match(peek, /if \(typeof desktopSoftwarePointerIgnored === 'function' && desktopSoftwarePointerIgnored\(\)\) return;/);

// 3) 主进程：接收控制器矩形、轮询真实光标、每个 tick 重放可点击路由。
//    （真实鼠标验证：悬停展开后点击面板里的开关可以解锁；不靠 z 序调整，也不改图标层。）
assert.match(preload, /setDesktopControllerZone: \(zone\) => ipcRenderer\.send\('mineradio-full-desktop-controller-zone'/);
assert.match(preload, /onDesktopControllerHover: \(callback\) => \{/);
assert.match(preload, /ipcRenderer\.on\('mineradio-full-desktop-controller-hover', listener\)/);
assert.match(main, /ipcMain\.on\('mineradio-full-desktop-controller-zone'/);
assert.match(main, /function syncDesktopControllerPointerPoll\(\)/);
assert.match(main, /screen\.getCursorScreenPoint\(\)/);
assert.match(main, /sendDesktopControllerHover\(over\)/);
assert.match(main, /setInterval\(\(\) => \{[\s\S]{0,900}getCursorScreenPoint/);
// 每个 tick 都重放路由（锁定瞬间第一次上报可能还没生效，只按变化上报会永远停在 ignore=true）
assert.match(main, /fullDesktopModeRuntime\.updatePointerRoute\(\{ overSoftwareUi: false, overDesktopControls: over \}, 'desktop-controller-poll'\)/);
// 绝不能把主窗口抬到桌面图标层之上：图标 ListView 被盖住后 Explorer 的透明合成会失效，
// 整片桌面图标会包上黑底（实测回归）。轮询里只允许改指针路由。
// Never raise the main window above the icon layer: covering the ListView breaks Explorer's
// transparency compositing and gives every desktop icon a black box.
const pollBody = main.slice(
  main.indexOf('function syncDesktopControllerPointerPoll'),
  main.indexOf('let wallpaperEngineCaptureSourceId')
);
assert.ok(pollBody.length > 0, 'controller poll body not found');
assert.doesNotMatch(pollBody, /moveTop\(\)/);
assert.doesNotMatch(pollBody, /ensureIconLayerOrder/);
// 上次会话被强杀时会把图标 ListView 留在 layered 状态；启动时要检查并还原，否则图标整片黑底。
// A killed session can leave the icon ListView layered; startup must repair it or every icon is
// drawn on black.
assert.match(main, /function repairLeakedDesktopIconLayer\(\)/);
assert.match(main, /WS_EX_LAYERED|0x00080000/);
assert.match(main, /setTimeout\(\(\) => \{ repairLeakedDesktopIconLayer\(\)\.catch/);
// 状态广播会同步轮询
assert.match(main, /syncDesktopControllerPointerPoll\(\);\s*\n\}/, 'status broadcasts must keep the poll in sync');

// 4) 渲染进程：锁定期间可点击区域由主进程轮询决定（转发坐标不可靠），悬停事件负责展开/收起，
//    控制器矩形的上报有 250ms 心跳兜底。
assert.match(shell, /mode\.active && desktopPointerRouteReporter\.hasPointer && !softwareLocked/);
assert.ok(shell.includes('desktopWallpaperRuntimeState.overlayIconsAbove === true'), 'route report must also be skipped in icons-above mode');
assert.match(shell, /api\.onDesktopControllerHover\(function \(over\) \{/);
assert.match(shell, /scheduleDesktopModeControlOpen\(40, true\)/);
assert.match(shell, /if \(desktopPointerRouteReporter\.overControls\) return;/);
assert.match(shell, /if \(force !== true\) \{/);
assert.match(shell, /function syncDesktopControllerZoneTicker\(active\)/);
assert.match(shell, /setInterval\(reportDesktopControllerZone, 250\)/);
assert.match(shell, /syncDesktopControllerZoneTicker\(active && softwareLocked\)/);

// 5) 锁定期间把手是唯一解锁入口，不能被自动隐藏。
assert.ok(shell.includes('desktopWallpaperRuntimeState.overlayIconsAbove === true'), 'route report must also be skipped in icons-above mode');

console.log('OK desktop-locked-pointer');
