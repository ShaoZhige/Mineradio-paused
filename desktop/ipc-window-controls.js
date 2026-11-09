'use strict';

// 窗口控制类 IPC：最小化/还原/最大化/全屏/状态查询。
// 依赖由 main.js 注入，避免模块反过来抓 main 的全局状态。

function registerWindowControlIpc(deps) {
  const {
    ipcMain,
    getMainWindow,
    getSenderWindow,
    fullDesktopModeRuntime,
    setFullDesktopModeInteractive,
    getWindowState,
    sendWindowState,
    armMainWindowMinimizeIntent,
    clearMainWindowMinimizeIntent,
    toggleFullscreen,
    exitFullscreenToWindow,
  } = deps;

  const desktopStatus = (reason) => fullDesktopModeRuntime.getStatus(reason);

  ipcMain.handle('desktop-window-minimize', async (event) => {
    const win = getSenderWindow(event);
    if (win === getMainWindow() && desktopStatus('window-minimize').enabled === true) {
      return setFullDesktopModeInteractive(false, 'window-minimize');
    }
    if (win === getMainWindow()) armMainWindowMinimizeIntent(win, 'renderer-window-control');
    win?.minimize();
    return getWindowState(win);
  });

  ipcMain.handle('desktop-window-restore', async (event) => {
    const win = getSenderWindow(event);
    if (!win || win.isDestroyed()) return null;
    if (win === getMainWindow()) clearMainWindowMinimizeIntent(win);
    if (win === getMainWindow() && desktopStatus('window-restore').enabled === true) {
      await setFullDesktopModeInteractive(true, 'window-restore');
      return getWindowState(win);
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    try { win.moveTop(); } catch (_) { }
    try { win.focus(); } catch (_) { }
    sendWindowState(win);
    return getWindowState(win);
  });

  ipcMain.handle('desktop-window-toggle-maximize', (event) => {
    const win = getSenderWindow(event);
    if (win === getMainWindow() && desktopStatus('window-toggle-maximize').enabled === true) {
      return getWindowState(win);
    }
    toggleFullscreen(win);
    return getWindowState(win);
  });

  ipcMain.handle('desktop-window-toggle-fullscreen', (event) => {
    const win = getSenderWindow(event);
    if (win === getMainWindow() && desktopStatus('window-toggle-fullscreen').enabled === true) {
      return getWindowState(win);
    }
    toggleFullscreen(win);
    return getWindowState(win);
  });

  ipcMain.handle('desktop-window-exit-fullscreen-windowed', (event) => {
    const win = getSenderWindow(event);
    if (win === getMainWindow() && desktopStatus('window-exit-fullscreen').enabled === true) {
      return getWindowState(win);
    }
    exitFullscreenToWindow(win);
    return getWindowState(win);
  });

  ipcMain.handle('desktop-window-get-state', (event) => {
    return getWindowState(getSenderWindow(event));
  });
}

module.exports = { registerWindowControlIpc };
