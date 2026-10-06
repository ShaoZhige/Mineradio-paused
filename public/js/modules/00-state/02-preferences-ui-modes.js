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
function preferencesUiModesText(key, fallback, params) {
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
function readSavedVolume() {
  try {
    var v = parseFloat(localStorage.getItem('apex-player-volume'));
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1.0;
  } catch (e) {
    return 1.0;
  }
}
function normalizeAudioFadeMs(value, fallback) {
  var ms = Math.round(Number(value));
  if (!isFinite(ms)) ms = fallback;
  return Math.max(AUDIO_FADE_MIN_MS, Math.min(AUDIO_FADE_MAX_MS, ms));
}
function readAudioFadePreference() {
  var defaults = { fadeInMs: 460, fadeOutMs: 420 };
  try {
    var raw = JSON.parse(localStorage.getItem(AUDIO_FADE_STORE_KEY) || '{}') || {};
    return {
      fadeInMs: normalizeAudioFadeMs(raw.fadeInMs, defaults.fadeInMs),
      fadeOutMs: normalizeAudioFadeMs(raw.fadeOutMs, defaults.fadeOutMs)
    };
  } catch (e) {
    return defaults;
  }
}
function saveAudioFadePreference() {
  try {
    localStorage.setItem(AUDIO_FADE_STORE_KEY, JSON.stringify({
      fadeInMs: AUDIO_FADE_IN_MS,
      fadeOutMs: AUDIO_FADE_OUT_MS
    }));
  } catch (e) { }
}
function readDiyModePreference() {
  try { return localStorage.getItem(DIY_MODE_STORE_KEY) === '1'; } catch (e) { return false; }
}
function saveDiyModePreference(on) {
  try { localStorage.setItem(DIY_MODE_STORE_KEY, on ? '1' : '0'); } catch (e) { }
}
function readBooleanPreference(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (raw == null) return !!fallback;
    return raw === '1';
  } catch (e) {
    return !!fallback;
  }
}
function saveBooleanPreference(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) { }
}
function normalizePlaylistPanelTab(tab) {
  tab = String(tab || '').trim();
  return tab === 'podcasts' ? 'podcasts' : (tab === 'playlists' ? 'playlists' : 'queue');
}
function readPlaylistPanelTabPreference() {
  try { return normalizePlaylistPanelTab(localStorage.getItem(PLAYLIST_PANEL_TAB_STORE_KEY) || 'queue'); } catch (e) { return 'queue'; }
}
function savePlaylistPanelTabPreference(tab) {
  try { localStorage.setItem(PLAYLIST_PANEL_TAB_STORE_KEY, normalizePlaylistPanelTab(tab)); } catch (e) { }
}
function normalizeCloseBehavior(value) {
  return value === 'tray' ? 'tray' : 'exit';
}
function readCloseBehaviorPreference() {
  try { return normalizeCloseBehavior(localStorage.getItem(CLOSE_BEHAVIOR_STORE_KEY) || 'tray'); } catch (e) { return 'tray'; }
}
function saveCloseBehaviorPreference(value) {
  try { localStorage.setItem(CLOSE_BEHAVIOR_STORE_KEY, normalizeCloseBehavior(value)); } catch (e) { }
}
function syncCloseBehaviorUi() {
  document.querySelectorAll('#close-behavior-seg [data-close-behavior]').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-close-behavior') === closeBehaviorPreference);
  });
}
function setCloseBehaviorPreference(value, opts) {
  opts = opts || {};
  closeBehaviorPreference = normalizeCloseBehavior(value);
  saveCloseBehaviorPreference(closeBehaviorPreference);
  syncCloseBehaviorUi();
  if (window.desktopWindow && typeof window.desktopWindow.setCloseBehavior === 'function') {
    window.desktopWindow.setCloseBehavior(closeBehaviorPreference).catch(function (e) { console.warn('[CloseBehavior]', e); });
  }
  if (opts.toast) showToast(closeBehaviorPreference === 'tray' ? preferencesUiModesText('close_behavior_tray') : preferencesUiModesText('close_behavior_exit'));
}
function bindCloseBehaviorControls() {
  var seg = document.getElementById('close-behavior-seg');
  if (!seg || seg._bound) return;
  seg._bound = true;
  seg.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-close-behavior]') : null;
    if (!btn) return;
    setCloseBehaviorPreference(btn.getAttribute('data-close-behavior'), { toast: true });
  });
  syncCloseBehaviorUi();
}
function initializeDesktopCloseBehavior() {
  bindCloseBehaviorControls();
  setCloseBehaviorPreference(closeBehaviorPreference, { toast: false });
}
function normalizeStartupResumeMode(value) {
  return value === 'restart' ? 'restart' : 'resume';
}
function readStartupResumeModePreference() {
  try { return normalizeStartupResumeMode(localStorage.getItem(STARTUP_RESUME_MODE_STORE_KEY) || 'resume'); } catch (e) { return 'resume'; }
}
function saveStartupResumeModePreference(value) {
  try { localStorage.setItem(STARTUP_RESUME_MODE_STORE_KEY, normalizeStartupResumeMode(value)); } catch (e) { }
}
function startupResumeSecondsFromSnapshot(snapshot) {
  if (startupResumeModePreference === 'restart') return 0;
  return Math.max(0, Number(snapshot && snapshot.currentTime) || 0);
}
function applyStartupResumeModeToRestoredSnapshot() {
  if (!restoredLastPlaybackSnapshot || (audio && audio.src)) return;
  pendingPlaybackResumeAt = startupResumeSecondsFromSnapshot(restoredLastPlaybackSnapshot);
  applyRestoredPlaybackProgressUi(Object.assign({}, restoredLastPlaybackSnapshot, { currentTime: pendingPlaybackResumeAt }));
}
function syncStartupResumeModeUi() {
  document.querySelectorAll('#startup-resume-mode-seg [data-startup-resume-mode]').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-startup-resume-mode') === startupResumeModePreference);
  });
}
function setStartupResumeModePreference(value, opts) {
  opts = opts || {};
  startupResumeModePreference = normalizeStartupResumeMode(value);
  saveStartupResumeModePreference(startupResumeModePreference);
  syncStartupResumeModeUi();
  applyStartupResumeModeToRestoredSnapshot();
  if (opts.toast) showToast(startupResumeModePreference === 'restart' ? preferencesUiModesText('resume_restart_track') : preferencesUiModesText('resume_from_position'));
}
function bindStartupResumeModeControls() {
  var seg = document.getElementById('startup-resume-mode-seg');
  if (!seg || seg._bound) return;
  seg._bound = true;
  seg.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-startup-resume-mode]') : null;
    if (!btn) return;
    setStartupResumeModePreference(btn.getAttribute('data-startup-resume-mode'), { toast: true });
  });
  syncStartupResumeModeUi();
}
function applyStartupAutoplayUi() {
  var btn = document.getElementById('t-startupAutoplay');
  if (btn) btn.classList.toggle('on', !!startupAutoplayPreference);
  var skipBtn = document.getElementById('t-startupFastSkip');
  if (skipBtn) skipBtn.classList.toggle('on', !!startupFastSkipPreference);
  syncStartupResumeModeUi();
}
function toggleStartupAutoplay() {
  startupAutoplayPreference = !startupAutoplayPreference;
  saveBooleanPreference(STARTUP_AUTOPLAY_STORE_KEY, startupAutoplayPreference);
  applyStartupAutoplayUi();
  showToast(startupAutoplayPreference ? preferencesUiModesText('startup_autoplay_on') : preferencesUiModesText('startup_autoplay_off'));
  if (startupAutoplayPreference) {
    startupAutoplayAttempted = false;
    queueStartupAutoplayAfterHomeReveal('setting-toggle');
  } else {
    startupAutoplayHomeQueuedReason = '';
    startupAutoplayJobId += 1;
    clearStartupAutoplayRetryTimer();
  }
}
function toggleStartupFastSkip() {
  startupFastSkipPreference = !startupFastSkipPreference;
  saveBooleanPreference(STARTUP_FAST_SKIP_STORE_KEY, startupFastSkipPreference);
  applyStartupAutoplayUi();
  showToast(startupFastSkipPreference ? preferencesUiModesText('fast_skip_on') : preferencesUiModesText('fast_skip_off'));
}
window.toggleStartupAutoplay = toggleStartupAutoplay;
window.toggleStartupFastSkip = toggleStartupFastSkip;
function applySpotifyLaunchClientUi() {
  var btn = document.getElementById('t-spotifyLaunchClient');
  var enabled = !!(window.SpotifyLaunchClient && window.SpotifyLaunchClient.isEnabled());
  if (btn) btn.classList.toggle('on', enabled);
}
function toggleSpotifyLaunchClient() {
  if (typeof window.SpotifyLaunchClient === 'undefined' || !window.SpotifyLaunchClient) return;
  var next = !window.SpotifyLaunchClient.isEnabled();
  window.SpotifyLaunchClient.setEnabled(next);
  applySpotifyLaunchClientUi();
  showToast(next ? preferencesUiModesText('settings_spotify_launch_on') : preferencesUiModesText('settings_spotify_launch_off'));
}
window.toggleSpotifyLaunchClient = toggleSpotifyLaunchClient;
// 默认源选择器：选项由 provider 注册表派生（preferred 能力），**不写死平台清单** ——
// 以后新增可被指定的平台，这里自动多一项，不需要记得回来改。
// The preferred-source selector derives its options from the provider registry's preferred capability
// rather than a hardcoded list, so a newly registered platform shows up here on its own.
function applyPreferredSourceUi() {
  var select = document.getElementById('preferred-source-select');
  if (!select || typeof preferredSourceOptions !== 'function') return;
  var current = readPreferredSourcePreference();
  var options = preferredSourceOptions();
  // 语言切换后文案要跟着变，所以每次都按当前词典重建，而不是只在初始化时建一次。
  // Rebuilt on every call so the labels follow a language switch instead of freezing at init.
  select.innerHTML = '';
  options.forEach(function (option) {
    var node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  });
  select.value = options.some(function (option) { return option.value === current; })
    ? current
    : PREFERRED_SOURCE_AUTO;
}
function setPreferredSourceProvider(value) {
  if (!savePreferredSourcePreference(value)) return;
  applyPreferredSourceUi();
  // 调成「不指定」时不要报平台名，否则会显示成"已改为 不指定（保持原样）"这种读不通的话。
  // When switched to "none", name no platform — otherwise the toast reads as nonsense.
  var provider = preferredSourceProvider();
  showToast(provider
    ? preferencesUiModesText('settings_preferred_source_on', '默认源已设为 {provider}', { provider: providerRegistryLabel(provider) })
    : preferencesUiModesText('settings_preferred_source_off', '已改为不指定默认源'));
}
window.applyPreferredSourceUi = applyPreferredSourceUi;
window.setPreferredSourceProvider = setPreferredSourceProvider;
// 下拉项的文案是 JS 写的，`data-i18n` 重扫够不到它，所以切语言后要手动重建选项。
// The dropdown labels are written by JS, which the data-i18n re-scan cannot reach, so the options are
// rebuilt explicitly after a language switch.
if (typeof window !== 'undefined' && window.MineradioI18n && typeof window.MineradioI18n.onLanguageChange === 'function') {
  window.MineradioI18n.onLanguageChange(function () { applyPreferredSourceUi(); });
}
function applyUserCapsuleAutoHideState() {
  document.body.classList.toggle('user-capsule-auto-hide', !!userCapsuleAutoHide);
  var btn = document.getElementById('user-capsule-hide-btn');
  if (btn) {
    btn.classList.toggle('on', !!userCapsuleAutoHide);
    btn.textContent = userCapsuleAutoHide ? '›' : '‹';
    btn.title = userCapsuleAutoHide ? preferencesUiModesText('capsule_disable_autohide') : preferencesUiModesText('auto_hide_capsule', '自动隐藏账号胶囊');
  }
}
function toggleUserCapsuleAutoHide(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  userCapsuleAutoHide = !userCapsuleAutoHide;
  saveBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, userCapsuleAutoHide);
  applyUserCapsuleAutoHideState();
  showToast(userCapsuleAutoHide ? preferencesUiModesText('capsule_auto_hidden') : preferencesUiModesText('capsule_pinned'));
}
function updateUserCapsuleAutoHideFromPointer(x, y) {
  if (!userCapsuleAutoHide || immersiveMode) {
    document.body.classList.remove('user-capsule-peek');
    return;
  }
  var nearTopRight = x > innerWidth - 112 && y < 126;
  document.body.classList.toggle('user-capsule-peek', nearTopRight);
}
function applyFxFabAutoHideState(opts) {
  opts = opts || {};
  document.body.classList.toggle('fx-fab-auto-hide', !!fxFabAutoHide);
  if (!fxFabAutoHide) {
    document.body.classList.remove('fx-fab-peek');
    fxFabAutoHideRevealArmed = true;
  } else if (opts.forceHidden) {
    document.body.classList.remove('fx-fab-peek');
    fxFabAutoHideRevealArmed = false;
  }
  var btn = document.getElementById('fx-fab-hide-btn');
  if (btn) {
    btn.classList.toggle('on', !!fxFabAutoHide);
    btn.textContent = fxFabAutoHide ? '›' : '‹';
    btn.title = fxFabAutoHide ? preferencesUiModesText('console_fab_disable_autohide') : preferencesUiModesText('auto_hide_visual', '自动隐藏视觉控制台');
  }
}
function toggleFxFabAutoHide(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  fxFabAutoHide = !fxFabAutoHide;
  saveBooleanPreference(FX_FAB_AUTO_HIDE_STORE_KEY, fxFabAutoHide);
  applyFxFabAutoHideState({ forceHidden: fxFabAutoHide });
  showToast(fxFabAutoHide ? preferencesUiModesText('console_fab_auto_hidden') : preferencesUiModesText('console_fab_pinned'));
}
function updateFxFabAutoHideFromPointer(x, y) {
  if (!fxFabAutoHide || !diyPlayerMode || immersiveMode) {
    document.body.classList.remove('fx-fab-peek');
    fxFabAutoHideRevealArmed = true;
    return;
  }
  var panel = document.getElementById('fx-panel');
  var panelOpen = !!(panel && (panel.classList.contains('peek') || panel.classList.contains('show')));
  var nearBottomRight = x > innerWidth - 126 && y > innerHeight - 158;
  if (!nearBottomRight) fxFabAutoHideRevealArmed = true;
  document.body.classList.toggle('fx-fab-peek', panelOpen || (nearBottomRight && fxFabAutoHideRevealArmed));
}
var fullscreenToolsLayoutFrame = 0;
var fullscreenToolsLayoutResizeObserver = null;
var fullscreenToolsLayoutMutationObserver = null;
function visibleFullscreenToolsAccountRects() {
  var root = document.getElementById('top-right');
  if (!root) return [];
  var pills = Array.prototype.slice.call(root.querySelectorAll('.top-account-pill'));
  var nodes = pills.length ? pills : [document.getElementById('user-btn') || root];
  return nodes.map(function (node) {
    if (!node || !node.isConnected) return null;
    var style = window.getComputedStyle ? getComputedStyle(node) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return null;
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }).filter(Boolean);
}
function fullscreenToolsAccountBounds() {
  var rects = visibleFullscreenToolsAccountRects();
  if (!rects.length) {
    var fallback = document.getElementById('user-btn') || document.getElementById('top-right');
    return fallback ? fallback.getBoundingClientRect() : null;
  }
  return rects.reduce(function (bounds, rect) {
    bounds.left = Math.min(bounds.left, rect.left);
    bounds.right = Math.max(bounds.right, rect.right);
    bounds.top = Math.min(bounds.top, rect.top);
    bounds.bottom = Math.max(bounds.bottom, rect.bottom);
    return bounds;
  }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
}
function isFullscreenNow() {
  return !!(desktopRuntimeState.fullscreen || desktopFullscreenActive || document.fullscreenElement || document.body.classList.contains('desktop-fullscreen'));
}
// 全屏时搬进工具行的按钮，数组顺序 = 行内顺序（与标题栏从左到右一致）。
// Controls moved into the fullscreen tool row; array order is the on-screen order.
var FULLSCREEN_TOOL_SELECTORS = ['#visual-guide-btn', '.lang-switch', '#update-entry', '#hotkey-settings-btn', '#diy-mode-btn'];
// 全屏工具行：进入全屏把标题栏这排按钮**搬**进 #fullscreen-tools-zone，退出全屏再搬回去。
// 为什么搬而不是复制：语言菜单的开合、热键按钮的文案、更新入口的下载/可用状态都长在节点自己身上
// （更新入口还有个进度环要按 id 取），复制一份就得给每个控件再写一套同步逻辑；搬移顺带保证全局
// 只有一个实例，不会出现两份状态对不上。
// 为什么拦在入口而不是给每个按钮各配一个全屏镜像：标题栏以后再加工具按钮时，镜像写法会静默漏掉
// 新按钮（全屏下直接消失），而这里漏掉的是同一份名单 —— quick-check 有一条守卫专门盯这份名单。
// 还原点取「控件簇里的第一个窗口按钮」（最小化）：按数组顺序逐个 insertBefore 到它前面，顺序自然
// 与 HTML 里一致，不需要记住谁原来在谁后面，重复调用也是幂等的。
// Moving (not cloning) is deliberate: the language menu state, the hotkey label and the update entry's
// progress live on the nodes themselves, so clones would each need their own syncing. The restore
// anchor is the cluster's first window button: re-inserting in array order before it reproduces the
// original sequence with no captured state, and repeated calls are idempotent.
function syncFullscreenToolsRow(isFullscreen) {
  var zone = document.getElementById('fullscreen-tools-zone');
  var bar = document.querySelector('.desktop-window-controls');
  if (!zone || !bar) return;
  var anchor = bar.querySelector('[data-window-action="minimize"]') || null;
  for (var i = 0; i < FULLSCREEN_TOOL_SELECTORS.length; i++) {
    var node = document.querySelector(FULLSCREEN_TOOL_SELECTORS[i]);
    if (!node) continue;
    if (isFullscreen) {
      if (node.parentNode !== zone) zone.appendChild(node);
    } else if (node.parentNode !== bar) {
      bar.insertBefore(node, anchor);
    }
  }
  syncDiyModeButton();
  // 搬移会改变行宽（不同语言的按钮文案长度不同），而位置依赖行宽 —— 搬完必须重新量一次。
  // Moving changes the row width and the position depends on it, so re-measure right after.
  if (isFullscreen) layoutFullscreenToolsZone();
}
function layoutFullscreenToolsZone() {
  var zone = document.getElementById('fullscreen-tools-zone');
  if (!zone) return null;
  // 先读后写：行宽由内容决定（不写死，文案会随语言变长），读一次尺寸不会连带清掉后面的写。
  // Read before write: the row's width comes from its content, and reading it first keeps the
  // writes below from forcing an extra layout.
  var size = zone.getBoundingClientRect();
  var width = Math.max(0, Math.round(size.width));
  var height = Math.max(0, Math.round(size.height));
  var gap = innerWidth < 820 ? 8 : 12;
  // 兜底与 #top-right 的 right/top 对齐；拿不到账号胶囊（隐藏/尚未布局）时也不会跑到屏幕外。
  // Fallback matches #top-right's own right/top so a missing anchor never pushes the row off-screen.
  var right = 24;
  var top = 80;
  var anchor = fullscreenToolsAccountBounds();
  if (anchor && isFinite(anchor.right) && isFinite(anchor.bottom)
    && anchor.right > anchor.left && anchor.bottom > anchor.top) {
    right = innerWidth - anchor.right;
    top = anchor.bottom + gap;
  }
  right = Math.max(12, Math.min(innerWidth - 12, right));
  top = Math.max(8, Math.min(Math.max(8, innerHeight - height - 8), top));
  document.documentElement.style.setProperty('--fullscreen-tools-right', right.toFixed(1) + 'px');
  document.documentElement.style.setProperty('--fullscreen-tools-top', top.toFixed(1) + 'px');
  return { left: Math.max(0, innerWidth - right - width), top: top, width: width, height: height };
}
function scheduleFullscreenToolsLayout() {
  if (fullscreenToolsLayoutFrame) return;
  fullscreenToolsLayoutFrame = requestAnimationFrame(function () {
    fullscreenToolsLayoutFrame = 0;
    layoutFullscreenToolsZone();
  });
}
function setupFullscreenToolsLayoutTracking() {
  var root = document.getElementById('top-right');
  if (!root || root.__fullscreenToolsLayoutTracking) return;
  root.__fullscreenToolsLayoutTracking = true;
  window.addEventListener('resize', scheduleFullscreenToolsLayout, { passive: true });
  document.addEventListener('fullscreenchange', scheduleFullscreenToolsLayout);
  if (typeof ResizeObserver === 'function') {
    fullscreenToolsLayoutResizeObserver = new ResizeObserver(scheduleFullscreenToolsLayout);
    fullscreenToolsLayoutResizeObserver.observe(root);
  }
  if (typeof MutationObserver === 'function') {
    fullscreenToolsLayoutMutationObserver = new MutationObserver(scheduleFullscreenToolsLayout);
    fullscreenToolsLayoutMutationObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  }
  scheduleFullscreenToolsLayout();
}
// 语言菜单是点开后向下展开的下拉层，指针从按钮移到菜单项时会离开命中框 —— 菜单开着就当作仍在
// 命中范围内，否则鼠标一往下移，整行连菜单一起消失，菜单根本点不到。
// The language menu opens downward, so moving the pointer into a menu item leaves the hit box.
// While it is open the row counts as hovered, or it would vanish mid-click.
function fullscreenToolsMenuOpen() {
  var menu = document.getElementById('lang-menu');
  return !!(menu && !menu.hidden);
}
function shouldSuppressFullscreenToolsPeek() {
  var fxPanel = document.getElementById('fx-panel');
  var hotkeyModal = document.getElementById('hotkey-modal');
  var fxPanelOpen = !!(fxPanel && (fxPanel.classList.contains('peek') || fxPanel.classList.contains('show')));
  var hotkeyOpen = !!(hotkeyModal && hotkeyModal.classList.contains('show'));
  return !!(visualGuideActive || fxPanelOpen || hotkeyOpen);
}
function updateFullscreenToolsPeekFromPointer(x, y) {
  if (!isFullscreenNow() || immersiveMode || shouldSuppressFullscreenToolsPeek()) {
    document.body.classList.remove('fullscreen-tools-peek');
    return;
  }
  var rect = layoutFullscreenToolsZone();
  if (!rect) return;
  var anchorRect = fullscreenToolsAccountBounds() || rect;
  var hitLeft = Math.min(rect.left, anchorRect.left) - 26;
  var hitRight = Math.max(rect.left + rect.width, anchorRect.right) + 26;
  var hitTop = Math.min(rect.top, anchorRect.top) - 18;
  var hitBottom = Math.max(rect.top + rect.height, anchorRect.bottom) + 16;
  var active = x >= hitLeft && x <= hitRight && y >= hitTop && y <= hitBottom;
  if (!active && fullscreenToolsMenuOpen()) active = true;
  document.body.classList.toggle('fullscreen-tools-peek', active);
}
function isDiyMode() {
  return !!diyPlayerMode;
}
function syncDiyModeButton() {
  // 只有一个 DIY 按钮：窗口化时在标题栏，全屏时被 syncFullscreenToolsRow() 搬进工具行。
  // 以前全屏另有一个 #fullscreen-diy-btn 镜像，两处状态要同步；搬移之后镜像已删除。
  // One DIY button only: it lives in the title bar when windowed and is moved into the tool row in
  // fullscreen. The old #fullscreen-diy-btn mirror (and the state syncing it needed) is gone.
  var btn = document.getElementById('diy-mode-btn');
  if (!btn) return;
  btn.classList.toggle('on', diyPlayerMode);
  btn.setAttribute('aria-pressed', diyPlayerMode ? 'true' : 'false');
  btn.title = diyPlayerMode ? preferencesUiModesText('mode_diy_disable') : preferencesUiModesText('btn_diy_mode', '开启 DIY 玩家模式');
  btn.setAttribute('aria-label', btn.title);
}
function applyDiyMode(on, opts) {
  opts = opts || {};
  diyPlayerMode = !!on;
  document.documentElement.classList.toggle('diy-mode-preload', diyPlayerMode);
  document.documentElement.classList.toggle('simple-mode-preload', !diyPlayerMode);
  document.body.classList.toggle('diy-mode', diyPlayerMode);
  document.body.classList.toggle('simple-mode', !diyPlayerMode);
  syncDiyModeButton();
  if (opts.save) saveDiyModePreference(diyPlayerMode);
  if (!diyPlayerMode) {
    toggleFxPanel(false);
    togglePlaylistPanel(false);
    closeUploadTip(false);
    var quality = document.getElementById('quality-control');
    var volume = document.getElementById('volume-control');
    if (quality) quality.classList.remove('open');
    if (volume) volume.classList.remove('open');
  }
  if (opts.toast) showToast(diyPlayerMode ? preferencesUiModesText('mode_diy_enabled') : preferencesUiModesText('mode_switched_back_minimal'));
  if (opts.animate && window.gsap) {
    var diyBtn = document.getElementById('diy-mode-btn');
    if (diyBtn) window.gsap.fromTo(diyBtn, { scale: 0.94 }, { scale: 1, duration: 0.34, ease: 'back.out(1.8)', overwrite: true });
  }
}
function toggleDiyMode() {
  applyDiyMode(!diyPlayerMode, { save: true, toast: true, animate: true });
  if (visualGuideActive) {
    visualGuideState.mode = diyPlayerMode ? 'diy' : 'simple';
    showVisualGuideStep(0);
  }
}
