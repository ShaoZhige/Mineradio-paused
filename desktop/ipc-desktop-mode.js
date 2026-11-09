'use strict';

// 桌面模式渲染进程 IPC：图标盾、图标显隐、控制器区域、软件锁、键盘焦点、指针路由。

function registerDesktopModeIpc(deps) {
  const {
    ipcMain,
    isTrustedMainWindowIpc,
    fullDesktopModeRuntime,
    normalizeDesktopControllerZone,
    setDesktopControllerZone,
    syncDesktopControllerPointerPoll,
    getSenderWindow,
  } = deps;

  const ordinaryWindowImeFocusRepairs = new WeakMap();

  ipcMain.on('mineradio-full-desktop-icon-shields', (event, payload = {}) => {
    if (!isTrustedMainWindowIpc(event)) return;
    const rects = payload && payload.enabled === true && payload.interactive === true
      ? payload.rects
      : [];
    fullDesktopModeRuntime.updateIconShields(
      Array.isArray(rects) ? rects : [],
      payload && payload.viewport && typeof payload.viewport === 'object' ? payload.viewport : {}
    );
  });

  ipcMain.handle('mineradio-full-desktop-set-icons-visible', async (event, visible) => {
    if (!isTrustedMainWindowIpc(event)) return { ok: false, error: 'DESKTOP_MODE_UNTRUSTED_SENDER' };
    return fullDesktopModeRuntime.setDesktopIconsVisible(visible !== false, 'renderer-icons-visible');
  });

  ipcMain.on('mineradio-full-desktop-controller-zone', (event, payload = {}) => {
    if (!isTrustedMainWindowIpc(event)) return;
    setDesktopControllerZone(normalizeDesktopControllerZone(payload));
    syncDesktopControllerPointerPoll();
  });

  ipcMain.handle('mineradio-full-desktop-set-software-lock', async (event, locked) => {
    if (!isTrustedMainWindowIpc(event)) return { ok: false, error: 'DESKTOP_MODE_UNTRUSTED_SENDER' };
    const result = await fullDesktopModeRuntime.setSoftwareInteractionLocked(locked === true, 'renderer-software-lock');
    syncDesktopControllerPointerPoll();
    return result;
  });

  ipcMain.handle('mineradio-full-desktop-request-keyboard-focus', async (event, reason) => {
    if (!isTrustedMainWindowIpc(event)) return { ok: false, error: 'UNTRUSTED_KEYBOARD_FOCUS_REQUEST' };
    const focusResult = fullDesktopModeRuntime.requestKeyboardFocus(
      `renderer-${String(reason || 'pointerdown').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 64)}`
    );
    if (focusResult && focusResult.ok) return focusResult;
    const desktopStatus = fullDesktopModeRuntime.getStatus('renderer-keyboard-focus-fallback');
    if (desktopStatus && desktopStatus.enabled) {
      return { ok: false, focused: false, error: 'DESKTOP_KEYBOARD_FOCUS_INACTIVE', status: desktopStatus };
    }
    const win = getSenderWindow(event);
    const webContents = win && !win.isDestroyed() ? win.webContents : null;
    if (!webContents || webContents.isDestroyed() || typeof webContents.focus !== 'function') {
      return { ok: false, focused: false, error: 'KEYBOARD_FOCUS_WINDOW_UNAVAILABLE' };
    }
    const pendingRepair = ordinaryWindowImeFocusRepairs.get(webContents);
    if (pendingRepair) return pendingRepair;
    // Native confirm/logout can leave Chromium's editable surface unfocused in the
    // ordinary top-level window while isFocused() still reports true. Rebuild the
    // renderer focus boundary once so Windows TSF/IME attaches to the next focused
    // input. This branch is forbidden while the HWND is attached to Explorer.
    const repair = (async () => {
      if (typeof webContents.blur === 'function') webContents.blur();
      if (typeof win.setFocusable === 'function') win.setFocusable(true);
      if (typeof win.restore === 'function' && typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
      if (typeof win.focus === 'function') win.focus();
      await new Promise(resolve => setTimeout(resolve, 0));
      webContents.focus();
      return {
        ok: true,
        focused: typeof webContents.isFocused !== 'function' || webContents.isFocused(),
        mode: 'ordinary-window-ime-refresh',
      };
    })();
    ordinaryWindowImeFocusRepairs.set(webContents, repair);
    try {
      return await repair;
    } finally {
      ordinaryWindowImeFocusRepairs.delete(webContents);
    }
  });

  ipcMain.on('mineradio-full-desktop-pointer-route', (event, payload = {}) => {
    if (!isTrustedMainWindowIpc(event)) return;
    fullDesktopModeRuntime.updatePointerRoute({
      overSoftwareUi: payload && payload.overSoftwareUi === true,
      overDesktopControls: payload && payload.overDesktopControls === true,
    }, 'renderer-pointer-route');
  });
}

module.exports = { registerDesktopModeIpc };
