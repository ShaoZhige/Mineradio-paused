'use strict';

// Desktop lyrics overlay window: creation, placement, click-through lock,
// middle-click unlock gesture, hot-zone reporting and state broadcast.
// Electron objects are injected so the module stays out of the main process
// bootstrap and can be exercised with fakes.

const boundsUtil = require('./desktop-lyrics-bounds');
const { createMiddleClickPoller } = require('./global-middle-click-poller');

function createDesktopLyricsController(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  const screen = options.screen;
  const spawn = options.spawn;
  const overlayUrl = options.overlayUrl;
  const preloadPath = options.preloadPath;
  const title = options.title || 'Mineradio 桌面歌词';
  const getMainWindow = typeof options.getMainWindow === 'function' ? options.getMainWindow : () => null;
  const warn = typeof options.warn === 'function' ? options.warn : () => {};

  let win = null;
  let state = {};
  let userBounds = null;
  let programmaticMove = false;
  let programmaticMoveTimer = null;
  let pointerCapture = false;
  let mouseIgnored = null;
  let hotBounds = null;
  let lastMiddleAt = 0;

  function mainWindow() {
    try {
      return getMainWindow();
    } catch (_) {
      return null;
    }
  }

  function sendState() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('mineradio-desktop-lyrics-state', state);
  }

  function broadcastEnabled(enabled) {
    const main = mainWindow();
    if (!main || main.isDestroyed()) return;
    main.webContents.send('mineradio-desktop-lyrics-enabled-state', { enabled: !!enabled });
  }

  function broadcastLockState() {
    const main = mainWindow();
    const locked = state.clickThrough !== false;
    if (main && !main.isDestroyed()) {
      main.webContents.send('mineradio-desktop-lyrics-lock-state', { locked });
    }
    sendState();
  }

  function setWindowBounds(nextBounds) {
    if (!win || win.isDestroyed()) return;
    const safe = boundsUtil.constrainBounds(screen, nextBounds);
    const current = win.getBounds();
    if (current.x === safe.x && current.y === safe.y
      && current.width === safe.width && current.height === safe.height) {
      return;
    }
    programmaticMove = true;
    win.setBounds(safe, false);
    if (programmaticMoveTimer) clearTimeout(programmaticMoveTimer);
    programmaticMoveTimer = setTimeout(() => {
      programmaticMove = false;
      programmaticMoveTimer = null;
    }, 120);
  }

  function rememberBounds() {
    if (!win || win.isDestroyed() || programmaticMove) return;
    userBounds = win.getBounds();
  }

  function applyMouseBehavior() {
    if (!win || win.isDestroyed()) return;
    const locked = state.clickThrough !== false;
    const shouldIgnore = locked || !pointerCapture;
    if (mouseIgnored === shouldIgnore) return;
    mouseIgnored = shouldIgnore;
    win.setIgnoreMouseEvents(shouldIgnore, { forward: true });
  }

  function hotBoundsOnScreen() {
    if (!win || win.isDestroyed()) return null;
    const winBounds = win.getBounds();
    const rel = hotBounds;
    if (!rel) return winBounds;
    return {
      x: winBounds.x + rel.left,
      y: winBounds.y + rel.top,
      width: Math.max(1, rel.right - rel.left),
      height: Math.max(1, rel.bottom - rel.top),
    };
  }

  function handleGlobalMiddleClick() {
    if (!win || win.isDestroyed()) return;
    if (!state.enabled) return;
    const now = Date.now();
    if (now - lastMiddleAt < 260) return;
    const point = screen.getCursorScreenPoint();
    if (!boundsUtil.pointInBounds(point, hotBoundsOnScreen())) return;
    lastMiddleAt = now;
    const nextLocked = state.clickThrough === false;
    state = { ...state, clickThrough: nextLocked };
    pointerCapture = !nextLocked;
    applyMouseBehavior();
    broadcastLockState();
  }

  const middleClickPoller = createMiddleClickPoller({
    spawn,
    platform: options.platform || process.platform,
    onMiddleClick: handleGlobalMiddleClick,
    warn,
  });

  function positionWindow(payload = state, positionOptions = {}) {
    if (!win || win.isDestroyed()) return;
    const useManual = userBounds && !positionOptions.force;
    setWindowBounds(useManual ? userBounds : boundsUtil.defaultBounds(screen, payload, userBounds));
    if (typeof win.setOpacity === 'function') {
      win.setOpacity(boundsUtil.clampNumber(payload.opacity, 0.28, 1, 0.92));
    }
  }

  function create(payload = {}) {
    const previousY = state.y;
    const previousOpacity = state.opacity;
    state = { ...state, ...payload, enabled: true };
    const hasY = Object.prototype.hasOwnProperty.call(payload || {}, 'y');
    const nextY = boundsUtil.clampNumber(state.y, 0.08, 0.92, 0.76);
    const yChanged = hasY && Number.isFinite(Number(previousY))
      && Math.abs(nextY - boundsUtil.clampNumber(previousY, 0.08, 0.92, 0.76)) > 0.001;
    const opacityChanged = Object.prototype.hasOwnProperty.call(payload || {}, 'opacity')
      && Math.abs(boundsUtil.clampNumber(state.opacity, 0.28, 1, 0.92)
        - boundsUtil.clampNumber(previousOpacity, 0.28, 1, 0.92)) > 0.001;
    if (yChanged) userBounds = null;
    if (win && !win.isDestroyed()) {
      if (yChanged) {
        positionWindow(state, { force: true });
      } else if (opacityChanged && typeof win.setOpacity === 'function') {
        win.setOpacity(boundsUtil.clampNumber(state.opacity, 0.28, 1, 0.92));
      }
      applyMouseBehavior();
      sendState();
      return win;
    }

    win = new BrowserWindow({
      width: 920,
      height: 190,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: true,
      focusable: false,
      skipTaskbar: true,
      show: false,
      title,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.__mineradioDesktopLyricsWindow = true;
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (error) {
      warn('Desktop lyrics topmost setup skipped:', error && error.message || error);
    }
    middleClickPoller.start();
    applyMouseBehavior();
    positionWindow(state, { force: yChanged || !userBounds });
    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      win.showInactive();
      sendState();
    });
    win.webContents.once('did-finish-load', sendState);
    win.on('closed', () => {
      win = null;
      mouseIgnored = null;
    });
    win.on('moved', rememberBounds);
    win.loadURL(overlayUrl('desktop-lyrics.html')).catch((error) => {
      warn('Desktop lyrics load failed:', error && error.message || error);
    });
    return win;
  }

  function close() {
    state = { ...state, enabled: false };
    pointerCapture = false;
    mouseIgnored = null;
    hotBounds = null;
    middleClickPoller.stop();
    if (win && !win.isDestroyed()) {
      sendState();
      win.close();
    }
    win = null;
    broadcastEnabled(false);
  }

  function update(payload = {}) {
    const nextState = { ...state, ...(payload || {}) };
    if (nextState.enabled) {
      create(payload || {});
    } else if (win && !win.isDestroyed()) {
      state = nextState;
      sendState();
    } else {
      state = nextState;
    }
    return state;
  }

  function setPointerCapture(active) {
    pointerCapture = !!active;
    applyMouseBehavior();
  }

  function setHotBounds(rel) {
    const left = boundsUtil.clampNumber(rel && rel.left, -2000, 4000, 0);
    const top = boundsUtil.clampNumber(rel && rel.top, -2000, 4000, 0);
    const right = boundsUtil.clampNumber(rel && rel.right, left + 1, 6000, left + 1);
    const bottom = boundsUtil.clampNumber(rel && rel.bottom, top + 1, 6000, top + 1);
    hotBounds = { left, top, right, bottom };
  }

  function setLockState(locked) {
    state = { ...state, clickThrough: !!locked };
    if (state.clickThrough !== false) pointerCapture = false;
    applyMouseBehavior();
    broadcastLockState();
    return { ok: true, locked: state.clickThrough !== false };
  }

  function moveBy(dx, dy) {
    if (!win || win.isDestroyed()) return { ok: false, error: 'NO_DESKTOP_LYRICS_WINDOW' };
    if (state.clickThrough !== false) return { ok: false, error: 'DESKTOP_LYRICS_LOCKED' };
    const current = win.getBounds();
    const next = {
      ...current,
      x: Math.round(current.x + boundsUtil.clampNumber(dx, -160, 160, 0)),
      y: Math.round(current.y + boundsUtil.clampNumber(dy, -160, 160, 0)),
    };
    win.setBounds(next, false);
    userBounds = win.getBounds();
    return { ok: true };
  }

  function reposition() {
    if (!win || win.isDestroyed()) return;
    positionWindow(state);
  }

  function getState() {
    return state;
  }

  function isOpen() {
    return !!(win && !win.isDestroyed());
  }

  function destroy() {
    middleClickPoller.stop();
    if (programmaticMoveTimer) {
      clearTimeout(programmaticMoveTimer);
      programmaticMoveTimer = null;
    }
  }

  return {
    create,
    close,
    update,
    setPointerCapture,
    setHotBounds,
    setLockState,
    moveBy,
    reposition,
    getState,
    isOpen,
    broadcastEnabled,
    destroy,
  };
}

module.exports = { createDesktopLyricsController };
