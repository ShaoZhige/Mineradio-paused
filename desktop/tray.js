'use strict';

// 托盘生命周期：创建/更新菜单/销毁。Electron 的 Tray/Menu 由调用方注入，
// 这样 main.js 只保留「状态查询 + 回调绑定」，也方便测试模板与顺序。

const { buildTrayMenuTemplate } = require('./window-behavior');

function createTrayController(options) {
  const opts = options || {};
  const {
    Tray,
    Menu,
    appName,
    iconPath,
    onShow,
    getDesktopModeEnabled,
    onExitDesktopMode,
    onQuit,
    warn,
  } = opts;
  let tray = null;

  function ensure() {
    if (tray) return tray;
    try {
      tray = new Tray(iconPath);
      tray.setToolTip(appName);
      tray.on('click', onShow);
      tray.on('double-click', onShow);
    } catch (e) {
      if (typeof warn === 'function') warn('Tray init failed:', e && e.message);
      tray = null;
    }
    return tray;
  }

  function update() {
    const instance = ensure();
    if (!instance) return false;
    const menu = Menu.buildFromTemplate(buildTrayMenuTemplate({
      appName,
      desktopModeEnabled: typeof getDesktopModeEnabled === 'function' && getDesktopModeEnabled() === true,
      onShow,
      onExitDesktopMode,
      onQuit,
    }));
    instance.setContextMenu(menu);
    return true;
  }

  function destroy() {
    if (!tray) return false;
    try { tray.destroy(); } catch (_) { }
    tray = null;
    return true;
  }

  function isAvailable() {
    return !!tray;
  }

  return { update, destroy, isAvailable };
}

module.exports = { createTrayController };
