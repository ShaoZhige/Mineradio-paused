'use strict';

// 窗口控制 IPC 的行为测试：验证桌面模式下窗口操作被接管，普通模式走原生路径。

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerWindowControlIpc } = require('../desktop/ipc-window-controls');

function makeHarness({ desktopEnabled = false } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: () => {} };
  const mainWindow = { isDestroyed: () => false, minimize: () => { mainWindow.minimized = true; }, isMinimized: () => false, isVisible: () => true, moveTop() {}, focus() {} };
  const calls = { interactive: [], minimizeIntent: [], clearIntent: [], toggle: 0, exit: 0, state: 0, sent: 0 };
  registerWindowControlIpc({
    ipcMain,
    getMainWindow: () => mainWindow,
    getSenderWindow: () => mainWindow,
    fullDesktopModeRuntime: { getStatus: () => ({ enabled: desktopEnabled }) },
    setFullDesktopModeInteractive: async (value, reason) => { calls.interactive.push([value, reason]); return { interactive: value }; },
    getWindowState: () => { calls.state += 1; return { state: 'ok' }; },
    sendWindowState: () => { calls.sent += 1; },
    armMainWindowMinimizeIntent: (_win, reason) => { calls.minimizeIntent.push(reason); },
    clearMainWindowMinimizeIntent: () => { calls.clearIntent.push(true); },
    toggleFullscreen: () => { calls.toggle += 1; },
    exitFullscreenToWindow: () => { calls.exit += 1; },
  });
  return { handlers, mainWindow, calls };
}

test('desktop mode intercepts minimize and restore', async () => {
  const { handlers, mainWindow, calls } = makeHarness({ desktopEnabled: true });
  await handlers.get('desktop-window-minimize')({});
  assert.deepEqual(calls.interactive, [[false, 'window-minimize']]);
  assert.equal(mainWindow.minimized, undefined, 'window should not minimize in desktop mode');
  await handlers.get('desktop-window-restore')({});
  assert.deepEqual(calls.interactive[1], [true, 'window-restore']);
});

test('normal mode minimizes, restores and reports state', async () => {
  const { handlers, mainWindow, calls } = makeHarness({ desktopEnabled: false });
  await handlers.get('desktop-window-minimize')({});
  assert.equal(mainWindow.minimized, true);
  assert.deepEqual(calls.minimizeIntent, ['renderer-window-control']);
  assert.equal(calls.state, 1);
  await handlers.get('desktop-window-restore')({});
  assert.equal(calls.clearIntent.length, 1);
  assert.equal(calls.sent, 1);
});

test('desktop mode blocks maximize/fullscreen toggles', () => {
  const { handlers, calls } = makeHarness({ desktopEnabled: true });
  handlers.get('desktop-window-toggle-maximize')({});
  handlers.get('desktop-window-toggle-fullscreen')({});
  handlers.get('desktop-window-exit-fullscreen-windowed')({});
  assert.equal(calls.toggle, 0);
  assert.equal(calls.exit, 0);
  assert.equal(calls.state, 3);
});

test('normal mode toggles maximize and exits fullscreen', () => {
  const { handlers, calls } = makeHarness({ desktopEnabled: false });
  handlers.get('desktop-window-toggle-maximize')({});
  handlers.get('desktop-window-toggle-fullscreen')({});
  handlers.get('desktop-window-exit-fullscreen-windowed')({});
  assert.equal(calls.toggle, 2);
  assert.equal(calls.exit, 1);
});
