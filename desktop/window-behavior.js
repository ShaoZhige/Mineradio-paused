'use strict';

// 窗口行为里与 Electron 本体无关的纯逻辑。先搬 closeBehavior 和托盘菜单模板，
// 这样 main.js 只保留「取状态、绑定回调」的壳，Phase 1 后续才能继续拆托盘与生命周期。

function normalizeCloseBehavior(value) {
  return value === 'tray' ? 'tray' : 'exit';
}

function buildTrayMenuTemplate(options) {
  const opts = options || {};
  const appName = String(opts.appName || 'Mineradio');
  return [
    { label: `显示 ${appName}`, click: opts.onShow },
    {
      label: '退出完整桌面模式',
      visible: opts.desktopModeEnabled === true,
      click: opts.onExitDesktopMode,
    },
    { type: 'separator' },
    {
      label: '退出',
      click: opts.onQuit,
    },
  ];
}

module.exports = { normalizeCloseBehavior, buildTrayMenuTemplate };
