'use strict';

// 重构前的“现状锁定”测试：在拆 desktop/main.js 之前，把托盘、关闭到托盘、
// 图标恢复、autosave 与退出清理这些容易回归的行为钉住。
//
// 这些断言只读源码切片，不启动 Electron；等 Phase 1 把实现搬到独立模块后，
// 再把切片目标换成新模块即可，行为语义不变。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const QUIT = fs.readFileSync(path.join(ROOT, 'desktop', 'quit.js'), 'utf8');
const WINDOW_BEHAVIOR = fs.readFileSync(path.join(ROOT, 'desktop', 'window-behavior.js'), 'utf8');
const TRAY = fs.readFileSync(path.join(ROOT, 'desktop', 'tray.js'), 'utf8');

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起点：${startMarker}`);
  const end = text.indexOf(endMarker, start);
  assert.ok(end > start, `找不到终点：${endMarker}`);
  return text.slice(start, end);
}

test('closeBehavior 只认 tray，其余一律 exit', () => {
  const body = slice(WINDOW_BEHAVIOR, 'function normalizeCloseBehavior(value)', '\n}\n');
  assert.match(body, /return value === 'tray' \? 'tray' : 'exit';/);
  assert.match(MAIN, /return windowBehavior\.normalizeCloseBehavior\(value\);/);
});

test('托盘菜单顺序固定，桌面模式项按状态显示，退出项会置 appQuitting', () => {
  const tpl = slice(WINDOW_BEHAVIOR, 'function buildTrayMenuTemplate', 'module.exports');
  assert.ok(tpl.indexOf('显示 ${appName}') < tpl.indexOf('退出完整桌面模式'));
  assert.ok(tpl.indexOf('退出完整桌面模式') < tpl.indexOf("label: '退出'"));
  assert.match(tpl, /visible: opts\.desktopModeEnabled === true/);

  const body = slice(MAIN, 'function getTrayController()', 'function trayIsAvailable()');
  assert.match(body, /createTrayController\(\{/);
  assert.match(body, /onQuit: \(\) => \{/);
  assert.match(body, /appQuitting = true;\s*\n\s*app\.quit\(\);/);

  assert.match(TRAY, /buildTrayMenuTemplate/);
  assert.match(TRAY, /tray\.on\('click', onShow\)/);
  assert.match(TRAY, /tray\.on\('double-click', onShow\)/);
});

test('focusMainWindow 在窗口被销毁后会重建，退出中则不重建', () => {
  const body = slice(MAIN, 'function focusMainWindow()', 'function disposeQishuiAuthForQuit()');
  assert.match(body, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{/);
  assert.match(body, /if \(appQuitting\) return false;/);
  assert.match(body, /createWindow\(\)\.then\(\(\) => \{/);
  assert.match(body, /focusMainWindow\(\);/);
  assert.match(body, /return true;/);
});

test('关闭到托盘只 hide，意外销毁会重建窗口', () => {
  const close = slice(MAIN, "if (!appQuitting && closeBehavior === 'tray')", 'if (!mainWindowCloseFlushArmed)');
  assert.match(close, /event\.preventDefault\(\);/);
  assert.match(close, /createOrUpdateTray\(\);/);
  assert.match(close, /flushMainWindowFxAutosave\('tray-hide'\)\.finally\(\(\) => \{/);
  assert.match(close, /win\.hide\(\);/);
  assert.match(close, /scheduleAppMemoryTrim\('tray-hide', 2200\)/);

  const closed = slice(MAIN, "win.on('closed', () => {", 'function createWindow()');
  assert.match(closed, /if \(!appQuitting && closeBehavior === 'tray'\) \{/);
  assert.match(closed, /createWindow\(\)\.catch\(\(error\) => \{/);
});

test('autosave 的路径、上限与原子写不变', () => {
  const autosave = fs.readFileSync(path.join(ROOT, 'desktop', 'fx-autosave.js'), 'utf8');
  assert.match(autosave, /const FILE = 'current-fx-autosave\.json';/);
  assert.match(autosave, /const MAX_BYTES = 12 \* 1024 \* 1024;/);
  const read = slice(autosave, 'function read(userDataDir)', 'function write(userDataDir, payload)');
  assert.match(read, /getPath\(userDataDir\)/);
  assert.match(read, /stat.size <= 0 || stat.size > MAX_BYTES/);
  assert.match(read, /!Array\.isArray\(payload\)/);

  const write = slice(autosave, 'function write(userDataDir, payload)', 'module.exports');
  assert.match(write, /Buffer\.byteLength\(text, 'utf8'\) > MAX_BYTES/);
  assert.match(write, /const tmp = `\$\{file\}\.tmp`;/);
  assert.match(write, /fs\.writeFileSync\(tmp, text, 'utf8'\);/);
  assert.match(write, /fs\.renameSync\(tmp, file\);/);

  assert.match(MAIN, /return fxAutosave\.getPath\(app\.getPath\('userData'\)\);/);
  assert.match(MAIN, /return fxAutosave\.read\(app\.getPath\('userData'\)\);/);
  assert.match(MAIN, /return fxAutosave\.write\(app\.getPath\('userData'\), payload\);/);

  assert.match(MAIN, /mineradio-current-fx-autosave-read-sync/);
  assert.match(MAIN, /mineradio-current-fx-autosave-save-sync/);
  assert.match(MAIN, /mineradio-current-fx-autosave-save/);
});

test('退出清理步骤顺序固定，且有 15s 与 3s 两级兜底', () => {
  const body = slice(QUIT, 'function beforeQuit(event) {', 'function willQuit()');
  assert.match(body, /setQuitting\(true\);/);
  assert.match(body, /if \(cleanupComplete\) return;/);
  assert.match(body, /event\.preventDefault\(\);/);
  assert.match(body, /if \(cleanupPromise\) return;/);

  const steps = [
    'hide-visible-surfaces',
    'clear-wallpaper-capture-grant',
    'wallpaper-engine-library-dispose',
    'stop-memory-timer',
    'unregister-desktop-escape',
    'unregister-global-hotkeys',
    'close-desktop-lyrics',
    'dispose-qishui-auth',
  ];
  let cursor = -1;
  for (const step of steps) {
    const at = body.indexOf("['" + step + "'");
    assert.ok(at > cursor, '退出步骤顺序错误：' + step);
    cursor = at;
  }

  assert.match(body, /\[Shutdown\] cleanup step failed:/);
  assert.match(body, /cleanupPromise = Promise\.race\(\[runtimeCleanup, timeoutCleanup\]\)\.finally\(\(\) => \{/);
  assert.match(body, /cleanupTimeout = setTimeout\(\(\) => \{/);
  assert.match(body, /15000\);/);
  assert.match(body, /cleanupComplete = true;\s*\n\s*app\.quit\(\);/);
  assert.match(body, /\[Shutdown\] quit still pending after cleanup; forcing application exit\./);
  assert.match(body, /app\.exit\(0\);/);
});

test('will-quit 再兜底销毁托盘', () => {
  assert.match(MAIN, /if \(quitController\) quitController\.willQuit\(\);/);
  assert.match(QUIT, /tray\.destroy\(\)/);
});
