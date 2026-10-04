// 本模块界面文案统一走 i18n；缺键时退回内置中文模板，不会渲染空串或裸 key。
// UI copy in this module goes through i18n and falls back to the built-in Chinese
// template, so nothing ever renders an empty string or a raw key.
// params 既透传给 t()，也插值进兜底模板，缺词典时占位符仍会被替换掉。
// params goes to both t() and the fallback template so placeholders still resolve
// when the dictionary entry is missing.
// 本模块界面文案统一走 i18n，词典是唯一文案来源。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：
//   xxxText('key')            —— 推荐。词典缺键时返回键名本身，漏译一眼可见。
//   xxxText('key', '兜底')     —— 仅在「缺键时该显示什么」有明确要求时用。
//   xxxText('key', '含 {p} 的模板', {p: v}) —— 带插值。params 同时喂给 t() 与兜底模板。
// 缺键刻意返回键名而不是空串：空串会让漏译静默发生，键名在界面上是一眼能认出的错误。
// Two call shapes. A missing key returns the key itself on purpose: an empty string would
// make an untranslated string fail silently, while a bare key is self-identifying on screen.
// params 同时透传给 t() 并插值进兜底模板，缺词典时占位符仍会被替换掉。
// params goes to both t() and the fallback template so placeholders still resolve.
function hotkeysText(key, fallback, params) {
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
function getHotkeyDefaults() {
  var defaults = { local: {}, global: {} };
  hotkeyActionsList().forEach(function (action) {
    defaults.local[action.key] = action.local || '';
    defaults.global[action.key] = action.global || '';
  });
  return defaults;
}
function readHotkeySettings() {
  var defaults = getHotkeyDefaults();
  try {
    var raw = JSON.parse(localStorage.getItem(HOTKEY_SETTINGS_STORE_KEY) || '{}') || {};
    return {
      local: Object.assign({}, defaults.local, raw.local || {}),
      global: Object.assign({}, defaults.global, raw.global || {})
    };
  } catch (e) {
    return defaults;
  }
}
function saveHotkeySettings() {
  try { localStorage.setItem(HOTKEY_SETTINGS_STORE_KEY, JSON.stringify(hotkeySettings || getHotkeyDefaults())); } catch (e) { }
}
function hotkeyActionMeta(actionKey) {
  for (var i = 0; i < hotkeyActionsList().length; i++) {
    if (hotkeyActionsList()[i].key === actionKey) return hotkeyActionsList()[i];
  }
  return null;
}
function isModifierKeyCode(code) {
  return /^(ControlLeft|ControlRight|ShiftLeft|ShiftRight|AltLeft|AltRight|MetaLeft|MetaRight)$/i.test(String(code || ''));
}
function normalizeHotkeyEvent(e) {
  if (!e || isModifierKeyCode(e.code)) return '';
  var mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  var code = e.code || '';
  if (!code && e.key) code = String(e.key).length === 1 ? 'Key' + String(e.key).toUpperCase() : String(e.key);
  if (!code) return '';
  return mods.concat([code]).join('+');
}
function hotkeyDisplayPart(part) {
  if (part === 'Ctrl') return 'Ctrl';
  if (part === 'Alt') return 'Alt';
  if (part === 'Shift') return 'Shift';
  if (part === 'Meta') return 'Win';
  if (part === 'Space') return 'Space';
  if (part === 'ArrowLeft') return 'Left';
  if (part === 'ArrowRight') return 'Right';
  if (part === 'ArrowUp') return 'Up';
  if (part === 'ArrowDown') return 'Down';
  if (/^Key[A-Z]$/.test(part)) return part.slice(3);
  if (/^Digit[0-9]$/.test(part)) return part.slice(5);
  if (/^Numpad[0-9]$/.test(part)) return 'Num' + part.slice(6);
  return part.replace(/^Equal$/, '=').replace(/^Minus$/, '-');
}
function formatHotkey(hotkey) {
  hotkey = String(hotkey || '').trim();
  if (!hotkey) return hotkeysText('bg_media_unset', '未设置');
  return hotkey.split('+').map(hotkeyDisplayPart).join(' + ');
}
function hotkeyToAccelerator(hotkey) {
  var parts = String(hotkey || '').split('+').filter(Boolean);
  if (!parts.length) return '';
  return parts.map(function (part) {
    if (part === 'Ctrl') return 'Control';
    if (part === 'Alt') return 'Alt';
    if (part === 'Shift') return 'Shift';
    if (part === 'Meta') return 'Super';
    if (part === 'Space') return 'Space';
    if (part === 'ArrowLeft') return 'Left';
    if (part === 'ArrowRight') return 'Right';
    if (part === 'ArrowUp') return 'Up';
    if (part === 'ArrowDown') return 'Down';
    if (/^Key[A-Z]$/.test(part)) return part.slice(3);
    if (/^Digit[0-9]$/.test(part)) return part.slice(5);
    return part;
  }).join('+');
}
function hotkeyDuplicateMap(scope) {
  var map = {};
  var source = (hotkeySettings && hotkeySettings[scope]) || {};
  Object.keys(source).forEach(function (action) {
    var key = String(source[action] || '').trim();
    if (!key) return;
    map[key] = (map[key] || 0) + 1;
  });
  return map;
}
function executeHotkeyAction(actionKey, source) {
  if (actionKey === 'togglePlay') return togglePlay();
  if (actionKey === 'prevTrack') return prevTrack(true);
  if (actionKey === 'nextTrack') return nextTrack(true);
  if (actionKey === 'volumeUp') return adjustVolumeByKeyboard(0.05);
  if (actionKey === 'volumeDown') return adjustVolumeByKeyboard(-0.05);
  if (actionKey === 'toggleFullscreen') return toggleFullscreen();
  if (actionKey === 'toggleDesktopInteraction') {
    var api = getDesktopWindowApi && getDesktopWindowApi();
    if (!api || typeof api.getState !== 'function') return;
    return api.getState().then(function (state) {
      if (state && state.isDesktopEmbedded) {
        fx.wallpaperMode = false;
        updateFxInputs();
        return applyWallpaperModeState(true).then(function (result) {
          if (result && result.ok === true) showToast(hotkeysText('hotkey_exited_fullscreen'));
          return result;
        });
      }
      fx.wallpaperMode = true;
      updateFxInputs();
      return applyWallpaperModeState(true).then(function (result) {
        if (result && result.ok === true) showToast(hotkeysText('bind_full_desktop_on') + desktopInteractionHotkeyHint());
        return result;
      });
    }).catch(function () { });
  }
  if (actionKey === 'toggleDesktopLyrics') return toggleFx('desktopLyrics');
}
function desktopInteractionHotkeyHint() {
  var binding = hotkeySettings && hotkeySettings.global && hotkeySettings.global.toggleDesktopInteraction;
  return binding ? (hotkeysText('hotkey_press') + formatHotkey(binding) + hotkeysText('hotkey_fullscreen_toggle')) : hotkeysText('hotkey_fullscreen_hint');
}
function handleConfiguredLocalHotkey(e) {
  if (!hotkeySettings || !hotkeySettings.local || isTypingTarget(e.target)) return false;
  if (hotkeyCaptureState || document.getElementById('hotkey-modal') && document.getElementById('hotkey-modal').classList.contains('show')) return false;
  if (freeCamera && freeCamera.active && /^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$/.test(e.code)) return false;
  var combo = normalizeHotkeyEvent(e);
  if (!combo) return false;
  var duplicate = hotkeyDuplicateMap('local');
  for (var i = 0; i < hotkeyActionsList().length; i++) {
    var action = hotkeyActionsList()[i];
    if (hotkeySettings.local[action.key] !== combo) continue;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && !/^volume/.test(action.key)) return true;
    if (duplicate[combo] > 1) return true;
    executeHotkeyAction(action.key, 'local');
    return true;
  }
  return false;
}
function shouldSuppressDefaultConfiguredHotkey(e) {
  if (!hotkeySettings || !hotkeySettings.local) return false;
  var combo = normalizeHotkeyEvent(e);
  if (!combo) return false;
  for (var i = 0; i < hotkeyActionsList().length; i++) {
    var action = hotkeyActionsList()[i];
    if (action.local === combo && hotkeySettings.local[action.key] !== combo) return true;
  }
  return false;
}
// 按钮本体已改为在 index.html 里静态声明（标题栏「?」与「DIY」之间），
// 这里只负责补上重贴订阅：词典异步加载，创建时常常还没就绪，
// hotkeysText() 会返回键名本身（按钮上显示 "hotkey_hotkey"）。它不在控制台的重建范围内，
// 必须单独订阅语言就绪/切换。
// The button itself is now declared statically in index.html (title bar, between "?" and
// "DIY"); this only keeps the relabel subscription. The dictionary loads asynchronously, so
// at creation time the key usually has not arrived and hotkeysText() would return the key
// itself. It sits outside the console rebuild, so it needs its own language subscription.
function ensureHotkeySettingsButton() {
  relabelHotkeySettingsButton();
  if (ensureHotkeySettingsButton._relabelBound) return;
  ensureHotkeySettingsButton._relabelBound = true;
  if (typeof window !== 'undefined' && window.MineradioI18n
    && typeof window.MineradioI18n.onLanguageChange === 'function') {
    window.MineradioI18n.onLanguageChange(function () { relabelHotkeySettingsButton(); });
  }
}
function relabelHotkeySettingsButton() {
  var btn = document.getElementById('hotkey-settings-btn');
  if (btn) btn.textContent = hotkeysText('hotkey_hotkey');
}
// 弹窗的结构文案（外壳/标题/关闭键/页签/提示）由 hotkeysText() 拼成，而词典是异步加载的。
// 这个函数只在 bindHotkeySettings() 里跑一次：词典没就绪时 hotkeysText() 返回键名，
// 键名会被固化进 innerHTML —— 后果是**关闭按钮（hotkey_close_btn）根本不渲染**
// （它本身是一段 HTML 字符串，缺键时只剩纯文本），弹窗只能靠 Esc 关。
// 修法：把结构抽成 hotkeyDialogShell()，每次打开都重建外壳并重新取词。
//
// The dialog shell is assembled from hotkeysText() output while the dictionary loads
// asynchronously, and this function used to run exactly once. With no dictionary the calls
// returned key names baked permanently into innerHTML — which meant hotkey_close_btn (an HTML
// string) never rendered, leaving no close button at all. Fix: keep the shell in a function and
// rebuild it on every open so the text is re-read.
function hotkeyDialogShell() {
  return hotkeysText('hotkey_dialog_open') +
    '<div class="hotkey-head">' +
    hotkeysText('hotkey_dialog_title') +
    hotkeysText('hotkey_close_btn') +
    '</div>' +
    '<div class="hotkey-toolbar">' +
    hotkeysText('hotkey_tabs') +
    hotkeysText('hotkey_note') +
    '</div>' +
    '<div id="hotkey-local-section" class="hotkey-section active"></div>' +
    '<div id="hotkey-global-section" class="hotkey-section"></div>' +
    hotkeysText('hotkey_capture_tip') +
    '</div>';
}

// 关闭键缺键时的兜底：即使词典永远拿不到热键文案，关闭按钮也必须存在，
// 不能让用户只能按 Esc。§hotkey_close_btn 就是这个按钮本身。
// Fallback for the close button: even if the dictionary never loads, the button must exist —
// the user must not be left with Esc as the only way out. The key is the button itself.
var HOTKEY_CLOSE_FALLBACK = '<button class="hotkey-close" type="button" data-hotkey-close aria-label="\u5173\u95ed">\u00d7</button>';

function ensureHotkeyModal() {
  var modal = document.getElementById('hotkey-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'hotkey-modal';
  modal.className = 'hotkey-modal';
  modal.innerHTML = hotkeyDialogShell();
  if (!modal.querySelector('[data-hotkey-close]')) {
    var head = modal.querySelector('.hotkey-head');
    if (head) head.insertAdjacentHTML('beforeend', HOTKEY_CLOSE_FALLBACK);
  }
  document.body.appendChild(modal);
  modal.addEventListener('click', function (e) {
    if (e.target === modal || e.target.closest('[data-hotkey-close]')) closeHotkeySettings();
    var scopeBtn = e.target.closest('[data-hotkey-scope]');
    if (scopeBtn) setHotkeyModalScope(scopeBtn.getAttribute('data-hotkey-scope'));
    var bindBtn = e.target.closest('[data-hotkey-bind]');
    if (bindBtn) startHotkeyCapture(bindBtn.getAttribute('data-hotkey-action'), bindBtn.getAttribute('data-hotkey-bind'));
    var resetBtn = e.target.closest('[data-hotkey-reset]');
    if (resetBtn) resetHotkeyBinding(resetBtn.getAttribute('data-hotkey-action'), resetBtn.getAttribute('data-hotkey-reset'));
  });
  return modal;
}

// 词典就绪 / 语言切换后重建外壳：键名固化的字段（标题、说明、页签）才能换成真实文案。
// Rebuild the shell once the dictionary is ready and on every language switch, so the text
// frozen into innerHTML gets replaced with real copy.
function refreshHotkeyModalShell() {
  var modal = document.getElementById('hotkey-modal');
  if (!modal) return;
  // 重建外壳后把当前 scope 记回 data 属性，页签才不会跳回"局内热键"。
  // Put the current scope back after rebuilding, or the tabs jump back to local.
  var scope = modal.getAttribute('data-scope') || 'local';
  modal.innerHTML = hotkeyDialogShell();
  if (!modal.querySelector('[data-hotkey-close]')) {
    var head = modal.querySelector('.hotkey-head');
    if (head) head.insertAdjacentHTML('beforeend', HOTKEY_CLOSE_FALLBACK);
  }
  modal.setAttribute('data-scope', scope);
  renderHotkeySettings();
  setHotkeyModalScope(scope);
}

function hotkeyStatusMarkup(scope, actionKey, binding, duplicate) {
  if (!binding) return hotkeysText('hotkey_unset');
  if (duplicate && duplicate[binding] > 1) return hotkeysText('hotkey_duplicate');
  if (scope === 'local') return hotkeysText('hotkey_status_available_html');
  var status = hotkeyGlobalStatus[actionKey];
  if (!status) return hotkeysText('hotkey_status_pending_html');
  if (status.ok) return hotkeysText('hotkey_status_available_html');
  var source = status.conflict && status.conflict.sourceName || hotkeysText('desktop_hotkey_source', '系统 / 其他软件');
  return '<span class="hotkey-status conflict"><span class="source-icon">!</span>' + escHtml(source) + '</span>';
}
function renderHotkeyScope(scope) {
  var wrap = document.getElementById(scope === 'global' ? 'hotkey-global-section' : 'hotkey-local-section');
  if (!wrap) return;
  var duplicate = hotkeyDuplicateMap(scope);
  var html = '';
  var groups = {};
  hotkeyActionsList().forEach(function (action) {
    (groups[action.category] = groups[action.category] || []).push(action);
  });
  Object.keys(groups).forEach(function (category) {
    html += '<div class="hotkey-group"><div class="hotkey-group-title">' + escHtml(category) + '</div>';
    groups[category].forEach(function (action) {
      var binding = (hotkeySettings[scope] && hotkeySettings[scope][action.key]) || '';
      html += '<div class="hotkey-row">' +
        '<div class="hotkey-name">' + escHtml(action.label) + '</div>' +
        '<button class="hotkey-key' + (hotkeyCaptureState && hotkeyCaptureState.scope === scope && hotkeyCaptureState.action === action.key ? ' capturing' : '') + '" type="button" data-hotkey-bind="' + scope + '" data-hotkey-action="' + action.key + '">' + escHtml(hotkeyCaptureState && hotkeyCaptureState.scope === scope && hotkeyCaptureState.action === action.key ? hotkeysText('hotkey_press_combo') : formatHotkey(binding)) + '</button>' +
        '<button class="hotkey-reset" type="button" data-hotkey-reset="' + scope + '" data-hotkey-action="' + action.key + hotkeysText('hotkey_default_btn_suffix') +
        hotkeyStatusMarkup(scope, action.key, binding, duplicate) +
        '</div>';
    });
    html += '</div>';
  });
  wrap.innerHTML = html;
}
function renderHotkeySettings() {
  var modal = ensureHotkeyModal();
  var active = modal.getAttribute('data-scope') || 'local';
  modal.classList.toggle('capturing', !!hotkeyCaptureState);
  modal.querySelectorAll('[data-hotkey-scope]').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-hotkey-scope') === active);
  });
  var local = document.getElementById('hotkey-local-section');
  var global = document.getElementById('hotkey-global-section');
  if (local) local.classList.toggle('active', active === 'local');
  if (global) global.classList.toggle('active', active === 'global');
  renderHotkeyScope('local');
  renderHotkeyScope('global');
}
function setHotkeyModalScope(scope) {
  var modal = ensureHotkeyModal();
  modal.setAttribute('data-scope', scope === 'global' ? 'global' : 'local');
  renderHotkeySettings();
}
function openHotkeySettings() {
  var modal = ensureHotkeyModal();
  // 每次打开都重建外壳：首次创建时词典可能还没就绪，键名已被固化进 innerHTML。
  // Rebuild the shell on every open: at first creation the dictionary may not be ready yet and
  // the key names are already baked into innerHTML.
  refreshHotkeyModalShell();
  modal.classList.add('show');
  modal.setAttribute('data-scope', modal.getAttribute('data-scope') || 'local');
  renderHotkeySettings();
  registerGlobalHotkeys();
}
function closeHotkeySettings() {
  hotkeyCaptureState = null;
  var modal = document.getElementById('hotkey-modal');
  if (modal) modal.classList.remove('show', 'capturing');
}
function startHotkeyCapture(action, scope) {
  hotkeyCaptureState = { action: action, scope: scope === 'global' ? 'global' : 'local' };
  var modal = ensureHotkeyModal();
  modal.setAttribute('data-scope', hotkeyCaptureState.scope);
  renderHotkeySettings();
}
function setHotkeyBinding(action, scope, value) {
  if (!hotkeySettings) hotkeySettings = getHotkeyDefaults();
  if (!hotkeySettings[scope]) hotkeySettings[scope] = {};
  hotkeySettings[scope][action] = value || '';
  saveHotkeySettings();
  renderHotkeySettings();
  if (scope === 'global') registerGlobalHotkeys();
}
function resetHotkeyBinding(action, scope) {
  var meta = hotkeyActionMeta(action);
  if (!meta) return;
  setHotkeyBinding(action, scope, scope === 'global' ? meta.global : meta.local);
}
function registerGlobalHotkeys() {
  var api = getDesktopWindowApi && getDesktopWindowApi();
  if (!api || typeof api.configureGlobalHotkeys !== 'function') {
    hotkeyGlobalStatus = {};
    renderHotkeySettings();
    return Promise.resolve();
  }
  var duplicate = hotkeyDuplicateMap('global');
  var bindings = [];
  hotkeyActionsList().forEach(function (action) {
    var key = hotkeySettings.global && hotkeySettings.global[action.key];
    if (!key || duplicate[key] > 1) return;
    var accelerator = hotkeyToAccelerator(key);
    if (accelerator) bindings.push({ action: action.key, accelerator: accelerator });
  });
  return api.configureGlobalHotkeys(bindings).then(function (res) {
    var next = {};
    (res && res.results || []).forEach(function (item) {
      next[item.action] = item;
    });
    hotkeyGlobalStatus = next;
    renderHotkeySettings();
  }).catch(function () {
    hotkeyGlobalStatus = {};
    renderHotkeySettings();
  });
}
var globalHotkeyListenerBound = false;
function bindHotkeySettings() {
  ensureHotkeySettingsButton();
  ensureHotkeyModal();
  // 语言切换时重贴：弹窗外壳的标题/说明/页签都是取词结果，切换后必须重建。
  // Repaint on language change: the dialog shell's title, note and tabs are all translated
  // output, so they have to be rebuilt.
  if (!bindHotkeySettings._relabelBound
    && typeof window !== 'undefined' && window.MineradioI18n
    && typeof window.MineradioI18n.onLanguageChange === 'function') {
    bindHotkeySettings._relabelBound = true;
    window.MineradioI18n.onLanguageChange(function () { refreshHotkeyModalShell(); });
  }
  if (!globalHotkeyListenerBound) {
    var api = getDesktopWindowApi && getDesktopWindowApi();
    if (api && typeof api.onGlobalHotkey === 'function') {
      globalHotkeyListenerBound = true;
      api.onGlobalHotkey(function (payload) {
        if (!payload || !payload.action) return;
        executeHotkeyAction(payload.action, 'global');
      });
    }
  }
  registerGlobalHotkeys();
}
document.addEventListener('keydown', function (e) {
  var hotkeyModal = document.getElementById('hotkey-modal');
  if (!hotkeyCaptureState) {
    if (hotkeyModal && hotkeyModal.classList.contains('show') && e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeHotkeySettings();
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') {
    hotkeyCaptureState = null;
    renderHotkeySettings();
    return;
  }
  if (e.code === 'Backspace' || e.code === 'Delete') {
    var clearTarget = hotkeyCaptureState;
    hotkeyCaptureState = null;
    setHotkeyBinding(clearTarget.action, clearTarget.scope, '');
    return;
  }
  var combo = normalizeHotkeyEvent(e);
  if (!combo) return;
  var target = hotkeyCaptureState;
  hotkeyCaptureState = null;
  setHotkeyBinding(target.action, target.scope, combo);
}, true);
