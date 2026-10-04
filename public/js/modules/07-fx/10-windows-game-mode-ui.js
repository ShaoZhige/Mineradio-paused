'use strict';

// 本模块界面文案统一走 i18n；词典是唯一文案来源，缺键时退回内置中文模板。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：xxxText('key') 缺键返回键名；xxxText('key', '兜底') 显式指定缺键时显示什么；
// xxxText('key', '含 {p} 的模板', {p: v}) 带插值，params 同时喂给 t() 与兜底模板。
// Two call shapes: key-only shows the bare key on a miss; an explicit fallback says what to
// show instead; params interpolate into both the dictionary hit and the fallback template.
function windowsGameModeUiText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === "object") {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}



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
    toggle.title = windowsGameModeUiText('wgm_windows_only_detail');
    return true;
  }
  toggle.removeAttribute('aria-disabled');
  if (s.busy) {
    toggle.title = windowsGameModeUiText('wgm_writing');
    return true;
  }
  toggle.title = s.registered
    ? windowsGameModeUiText('wgm_registered')
    : windowsGameModeUiText('wgm_register_desc');
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

function windowsGameModeFailureText() {
  return {
  BACKUP_FAILED: windowsGameModeUiText('wgm_backup_failed'),
  BACKUP_WRITE_FAILED: windowsGameModeUiText('wgm_backup_failed_safe'),
  REGISTRY_WRITE_FAILED: windowsGameModeUiText('wgm_write_failed'),
  NO_EXE_PATH: windowsGameModeUiText('wgm_no_exe'),
  UNSUPPORTED_PLATFORM: windowsGameModeUiText('wgm_windows_only'),
  UNEXPECTED: windowsGameModeUiText('wgm_failed'),
  }
}

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
      showToast(windowsGameModeFailureText()[reason] || windowsGameModeUiText('wgm_failed_unchanged'));
    }
    return false;
  }
  await refreshWindowsGameModeState();
  if (typeof showToast === 'function') {
    showToast(turningOn ? windowsGameModeUiText('wgm_registered_reboot') : windowsGameModeUiText('wgm_restored'));
  }
  return true;
}
