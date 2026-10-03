'use strict';

// 「Windows 游戏模式」开关的界面逻辑。
//
// 这一项是整活：它把本程序登记进 Windows 的 GameConfigStore，让系统游戏模式认出它（更好的电源
// 计划与调度优先级）。主进程侧 desktop/windows-game-mode.js 负责备份 / 写入 / 还原，本文件只管
// 交互与状态呈现：
//
//   - 默认关闭，只有用户点开才写注册表；
//   - 非 Windows 平台主进程返回 supported:false，开关置灰并说明原因，而不是点了才报错；
//   - 写入失败要把失败原因说出来，并且**把开关弹回原状态**——注册表没写成却显示已开启，比报错更糟；
//   - 每次打开面板都重新读一次注册表，这样用户在系统设置里手动改过、或换了 exe 路径（更新）之后，
//     界面显示依然跟真实状态一致。
//
// This switch is a joke feature: it registers the app in GameConfigStore so the system game mode
// recognises it. desktop/windows-game-mode.js owns backup / write / restore; this file handles only
// interaction and presentation. Off by default; greys out where unsupported; a failed write snaps the
// switch back because showing "on" for a registry that was never written is worse than an error; and
// the real registry state is re-read on every panel open so external changes stay visible.

var windowsGameModeState = {
  supported: null,   // null = 还没问过主进程
  registered: false,
  busy: false,
};

function windowsGameModeApi() {
  try {
    if (typeof getDesktopWindowApi === 'function') return getDesktopWindowApi();
    return window.desktopWindow || null;
  } catch (_) {
    return null;
  }
}

function windowsGameModeToggle() {
  return document.getElementById('t-windowsGameMode');
}

// 把状态画到开关上：置灰 / 开 / 关 / 忙
function applyWindowsGameModeState() {
  var toggle = windowsGameModeToggle();
  if (!toggle) return false;
  var s = windowsGameModeState;
  var unsupported = s.supported === false;
  toggle.classList.toggle('on', !unsupported && !!s.registered);
  toggle.classList.toggle('dev-locked', unsupported);
  if (unsupported) {
    toggle.classList.remove('on');
    toggle.setAttribute('aria-disabled', 'true');
    toggle.title = '仅 Windows 可用：这项功能依赖 Windows 的游戏模式注册';
    return true;
  }
  toggle.removeAttribute('aria-disabled');
  if (s.busy) {
    toggle.title = '正在写入注册表…';
    return true;
  }
  toggle.title = s.registered
    ? '已登记为 Windows 游戏，系统游戏模式会给出更好的电源计划与调度优先级（整活功能；关闭会按备份原样还原注册表）'
    : '把 Mineradio 登记为 Windows 游戏，系统游戏模式会给出更好的电源计划与调度优先级（整活功能，只写 HKCU 不需要管理员；关闭时按备份原样还原）';
  return true;
}

// 读真实状态。失败当作"不支持"处理更安全：置灰比让用户点了没反应好。
// Read the real state. A failure is treated as unsupported — greying out beats a dead switch.
async function refreshWindowsGameModeState() {
  var api = windowsGameModeApi();
  if (!api || typeof api.getWindowsGameModeStatus !== 'function') {
    windowsGameModeState.supported = false;
    windowsGameModeState.registered = false;
    applyWindowsGameModeState();
    return windowsGameModeState;
  }
  try {
    var result = await api.getWindowsGameModeStatus();
    windowsGameModeState.supported = result && result.supported !== false;
    windowsGameModeState.registered = !!(result && result.registered);
  } catch (_) {
    windowsGameModeState.supported = false;
    windowsGameModeState.registered = false;
  }
  applyWindowsGameModeState();
  return windowsGameModeState;
}

var WINDOWS_GAME_MODE_FAILURE_TEXT = {
  BACKUP_FAILED: '注册表备份失败，为安全起见没有改动',
  BACKUP_WRITE_FAILED: '注册表备份无法落盘，为安全起见没有改动',
  REGISTRY_WRITE_FAILED: '写入注册表失败',
  NO_EXE_PATH: '找不到本程序的可执行文件路径',
  UNSUPPORTED_PLATFORM: '仅 Windows 可用',
  UNEXPECTED: '操作失败',
};

async function toggleWindowsGameMode() {
  if (windowsGameModeState.busy) return false;
  var api = windowsGameModeApi();
  if (!api || typeof api.enableWindowsGameMode !== 'function' || typeof api.disableWindowsGameMode !== 'function') {
    windowsGameModeState.supported = false;
    applyWindowsGameModeState();
    return false;
  }
  if (windowsGameModeState.supported === null) await refreshWindowsGameModeState();
  if (windowsGameModeState.supported === false) { applyWindowsGameModeState(); return false; }

  var turningOn = !windowsGameModeState.registered;
  windowsGameModeState.busy = true;
  applyWindowsGameModeState();
  var result = null;
  try {
    result = turningOn ? await api.enableWindowsGameMode() : await api.disableWindowsGameMode();
  } catch (_) {
    result = null;
  }
  windowsGameModeState.busy = false;
  if (!result || result.ok !== true) {
    // 注册表没动，但界面必须弹回去 —— 否则会显示"已开启"而系统里其实没有。
    // 重新读一次真实状态来纠正显示，比盲目翻转更可靠（写入可能部分成功）。
    await refreshWindowsGameModeState();
    if (typeof showToast === 'function') {
      var reason = (result && result.reason) || 'UNEXPECTED';
      showToast(WINDOWS_GAME_MODE_FAILURE_TEXT[reason] || '操作失败，注册表未改动');
    }
    return false;
  }
  await refreshWindowsGameModeState();
  if (typeof showToast === 'function') {
    showToast(turningOn ? '已登记为 Windows 游戏（重启后系统游戏模式才会生效）' : '已还原注册表');
  }
  return true;
}
