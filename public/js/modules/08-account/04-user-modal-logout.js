// 界面文案统一走 i18n；缺键时退回内置中文模板，界面不会出现空串或裸 key。
// All UI copy goes through i18n and falls back to the built-in Chinese template, so the
// UI never shows an empty string or a raw key.
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
function accountPanelText(key, fallback, params) {
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
function loggedProviderCount() {
  return ['netease', 'qq', 'kugou', 'qishui'].filter(function (key) { return hasPlatformLogin(key); }).length;
}
function updateUserModalUi() {
  activeAccountProvider = firstLoggedProvider();
  var st = platformStatus(activeAccountProvider);
  var meta = platformMeta(activeAccountProvider);
  var chip = document.getElementById('account-provider-chip');
  var avatar = document.getElementById('user-modal-avatar');
  var name = document.getElementById('user-modal-name');
  var vipEl = document.getElementById('user-modal-vip');
  var hint = document.getElementById('account-hint');
  var logoutBtn = document.getElementById('account-logout-btn');
  var addNetease = document.getElementById('account-add-netease');
  var addQQ = document.getElementById('account-add-qq');
  var addKugou = document.getElementById('account-add-kugou');
  var addQishui = document.getElementById('account-add-qishui');
  if (chip) {
    chip.className = 'account-provider-chip ' + activeAccountProvider;
    chip.innerHTML = '<span class="account-source-dot ' + meta.dot + '"></span><span>' + meta.label + '</span>';
  }
  if (avatar) avatar.src = providerAvatarSrc(activeAccountProvider, st);
  if (name) name.textContent = (st && st.nickname) || meta.label;
  if (vipEl) {
    if (activeAccountProvider === 'netease') {
      var neVipLevel = providerVipLevel('netease', st);
      var vipLabel = neVipLevel === 'svip' ? accountPanelText('logout_netease_svip') : (neVipLevel === 'vip' ? accountPanelText('logout_netease_vip') : accountPanelText('logout_free_user'));
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + vipLabel;
      vipEl.style.color = hasProviderVip('netease', st) ? 'rgba(244,210,138,0.86)' : 'rgba(255,255,255,0.5)';
    } else if (activeAccountProvider === 'kugou') {
      var kgVipLevel = providerVipLevel('kugou', st);
      var kgVipLabel = kgVipLevel === 'svip' ? accountPanelText('logout_kugou_svip') : (kgVipLevel === 'vip' ? accountPanelText('logout_kugou_vip') : accountPanelText('logout_kugou_session'));
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + kgVipLabel;
      vipEl.style.color = hasProviderVip('kugou', st) ? 'rgba(86,224,255,0.86)' : 'rgba(86,224,255,0.58)';
    } else if (activeAccountProvider === 'qishui') {
      var qishuiMode = st && st.webSession ? accountPanelText('logout_qishui_logged') : accountPanelText('logout_qishui_not_logged');
      var qishuiSync = st && st.webSession ? accountPanelText('logout_qishui_sync') : accountPanelText('logout_scan_douyin');
      vipEl.textContent = qishuiMode + '  /  ' + qishuiSync;
      vipEl.style.color = 'rgba(69,214,143,0.78)';
    } else if (activeAccountProvider === 'spotify') {
      var spProduct = st && st.product === 'premium' ? 'Spotify Premium' : (st && st.product ? ('Spotify ' + String(st.product).toUpperCase()) : accountPanelText('logout_spotify_unknown'));
      vipEl.textContent = 'ID: ' + ((st && st.userId) || '-') + '  /  ' + spProduct + accountPanelText('logout_spotify_sync');
      vipEl.style.color = hasProviderVip('spotify', st) ? 'rgba(30,215,96,0.86)' : 'rgba(30,215,96,0.60)';
    } else {
      var qqVipLevel = providerVipLevel('qq', st);
      var qqVipPending = qqLoginNeedsAuthorizationRefresh(st) || (typeof qqMembershipNeedsSync === 'function' && qqMembershipNeedsSync(st));
      var qqVipLabel = qqVipPending ? accountPanelText('logout_qq_pending') : (qqVipLevel === 'svip' ? accountPanelText('logout_qq_svip') : (qqVipLevel === 'vip' ? accountPanelText('logout_qq_vip') : accountPanelText('logout_qq_session')));
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + qqVipLabel;
      vipEl.style.color = qqVipPending ? 'rgba(255,232,174,0.86)' : (hasProviderVip('qq', st) ? 'rgba(0,245,212,0.82)' : 'rgba(0,245,212,0.58)');
    }
  }
  ['netease', 'qq', 'kugou', 'qishui', 'both'].forEach(function (key) {
    var btn = document.getElementById('user-provider-' + key);
    if (btn) btn.classList.toggle('active', key === 'both' ? dualAccountMode : (!dualAccountMode && activeAccountProvider === key));
  });
  if (addNetease) addNetease.style.display = hasPlatformLogin('netease') ? 'none' : '';
  if (addQQ) addQQ.textContent = hasPlatformLogin('qq') ? accountPanelText('logout_view_qq') : accountPanelText('login_add_qq', '补登 QQ 音乐');
  if (addKugou) addKugou.textContent = hasPlatformLogin('kugou') ? accountPanelText('logout_view_kugou') : accountPanelText('ar_kugou_add');
  if (addQishui) addQishui.textContent = hasPlatformLogin('qishui') ? accountPanelText('logout_relogin_qishui') : accountPanelText('ar_qishui_login');
  if (logoutBtn) logoutBtn.textContent =
    activeAccountProvider === 'qq' ? accountPanelText('logout_qq') :
    (activeAccountProvider === 'kugou' ? accountPanelText('logout_kugou') :
    (activeAccountProvider === 'qishui' ? accountPanelText('logout_clear_qishui') :
    (activeAccountProvider === 'spotify' ? accountPanelText('logout_spotify') : accountPanelText('logout_netease'))));
  if (hint) hint.textContent = dualAccountMode
    ? accountPanelText('account_switch_dual', '右上角已切换为双平台并排展示。')
    : accountPanelText('account_switch_hint', '可切换右上角展示的平台；“我两个都要”会并排放两个登录状态。');
}
function showUserModal() {
  if (!hasAnyPlatformLogin()) return showLoginModal();
  updateUserModalUi();
  openGsapModal(document.getElementById('user-modal'));
  if (qqLoginStatus && qqLoginStatus.loggedIn && typeof refreshQQVipStatusNow === 'function') {
    refreshQQVipStatusNow('account-modal')
      .then(updateUserModalUi)
      .catch(function (e) { console.warn('QQ VIP modal refresh failed:', e); });
  }
}
function closeUserModal() { closeGsapModal(document.getElementById('user-modal')); }
function setActiveAccountProvider(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : (provider === 'spotify' ? 'spotify' : 'netease')));
  if (!hasPlatformLogin(provider)) {
    openProviderLogin(provider);
    return;
  }
  activeAccountProvider = provider;
  dualAccountMode = false;
  renderUserBtn();
  updateUserModalUi();
}
function enableDualAccountView() {
  if (loggedProviderCount() < 2) {
    openProviderLogin(firstLoggedProvider() === 'netease' ? 'qq' : 'netease');
    return;
  }
  dualAccountMode = true;
  renderUserBtn();
  updateUserModalUi();
  showToast(accountPanelText('logout_multi_enabled'));
}
function requestDualLoginMode() {
  enableDualAccountView();
}
function openProviderLogin(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : (provider === 'spotify' ? 'spotify' : 'netease')));
  closeUserModal();
  loginProvider = provider;
  showLoginModal({ provider: provider });
}

var logoutAllAccountsResetBusy = false;
var logoutAllAccountsResetConfirmUntil = 0;
var logoutAllAccountsResetConfirmTimer = null;

function clearLogoutAllAccountsResetConfirmation() {
  logoutAllAccountsResetConfirmUntil = 0;
  if (logoutAllAccountsResetConfirmTimer) {
    window.clearTimeout(logoutAllAccountsResetConfirmTimer);
    logoutAllAccountsResetConfirmTimer = null;
  }
  var button = document.getElementById('login-reset-all-btn');
  if (button) {
    button.classList.remove('confirming');
    if (!logoutAllAccountsResetBusy) button.textContent = accountPanelText('logout_sign_out');
  }
}

function armLogoutAllAccountsResetConfirmation() {
  logoutAllAccountsResetConfirmUntil = Date.now() + 5000;
  var button = document.getElementById('login-reset-all-btn');
  if (button) {
    button.classList.add('confirming');
    button.textContent = accountPanelText('logout_click_again_confirm');
  }
  if (typeof showToast === 'function') showToast(accountPanelText('logout_click_again_cookie'));
  if (logoutAllAccountsResetConfirmTimer) window.clearTimeout(logoutAllAccountsResetConfirmTimer);
  logoutAllAccountsResetConfirmTimer = window.setTimeout(clearLogoutAllAccountsResetConfirmation, 5000);
}

function resetAllProviderRendererLoginState() {
  loginStatus = { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: accountPanelText('vip_none') };
  qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: accountPanelText('login_qq', 'QQ 音乐'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false };
  kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: accountPanelText('provider_kugou'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
  qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: accountPanelText('provider_qishui'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
  spotifyLoginStatus = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', avatar: '', product: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match', tokenConfigured: false, tokenFileExists: false, credentialsFileExists: false, localConfigMissing: false };
  loginStatusChecked = true;
  loginStatusCheckFailed = false;
  neteasePlaylists = [];
  qqPlaylists = [];
  kugouPlaylists = [];
  qishuiPlaylists = [];
  spotifyPlaylists = [];
  userPlaylists = (builtInPlaylists || []).slice();
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  dualAccountMode = false;
  activeAccountProvider = 'netease';
  playlistCatalogRevision += 1;
  if (typeof clearQQPlaybackVipEvidence === 'function') clearQQPlaybackVipEvidence();
  if (typeof homeDiscoverState !== 'undefined' && homeDiscoverState) {
    homeDiscoverState.loading = false;
    homeDiscoverState.loaded = true;
    homeDiscoverState.loggedIn = false;
    homeDiscoverState.mode = 'starter';
    homeDiscoverState.songs = [];
    homeDiscoverState.playlists = [];
    homeDiscoverState.podcasts = [];
  }
}

async function logoutAllAccountsAndResetEasterEgg() {
  if (logoutAllAccountsResetBusy) return;
  if (Date.now() > logoutAllAccountsResetConfirmUntil) {
    armLogoutAllAccountsResetConfirmation();
    return;
  }
  logoutAllAccountsResetBusy = true;
  var button = document.getElementById('login-reset-all-btn');
  clearLogoutAllAccountsResetConfirmation();
  if (button) {
    button.disabled = true;
    button.textContent = accountPanelText('logout_clearing');
  }
  try {
    await Promise.allSettled([
      apiJson('/api/logout'),
      apiJson('/api/qq/logout'),
      apiJson('/api/kugou/logout'),
      apiJson('/api/qishui/logout')
    ]);
    var result = await requestLoginEasterEggReplayReset();
    if (!result || !result.ok || result.unlocked || result.resetComplete === false) {
      throw new Error(result && (result.error || result.message) || 'LOGIN_EASTER_EGG_REPLAY_RESET_FAILED');
    }
    resetAllProviderRendererLoginState();
    resetLoginEasterEggUiForReplay();
    closeCollectModal();
    closeUserModal();
    closeLoginModal();
    updateLikeButtons();
    safeRenderQueuePanel('logout-all-reset', { scrollCurrent: miniQueueOpen });
    renderUserBtn();
    safeShelfRebuild('logout-all-reset');
    homeSuppressed = false;
    homeForcedOpen = true;
    if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(true);
    if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
    if (typeof renderHomeDashboard === 'function') renderHomeDashboard();
    showToast(accountPanelText('logout_all_done'));
  } catch (error) {
    console.warn('Logout all accounts and reset easter egg failed:', error);
    showToast(accountPanelText('logout_cleanup_incomplete'));
  } finally {
    logoutAllAccountsResetBusy = false;
    if (button) {
      button.disabled = false;
      button.classList.remove('confirming');
      button.textContent = accountPanelText('logout_sign_out');
    }
  }
}

async function logoutActiveAccount() {
  if (activeAccountProvider === 'qishui') {
    try { await apiJson('/api/qishui/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearQishuiMusicLogin === 'function') {
        await window.desktopWindow.clearQishuiMusicLogin();
      }
    } catch (e) { }
    qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: accountPanelText('provider_qishui'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
    qishuiPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qishui'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    safeShelfRebuild('qishui-logout');
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast(accountPanelText('logout_qishui_cleared'));
    return;
  }
  if (activeAccountProvider === 'kugou') {
    try { await apiJson('/api/kugou/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearKugouMusicLogin === 'function') {
        await window.desktopWindow.clearKugouMusicLogin();
      }
    } catch (e) { }
    kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: accountPanelText('provider_kugou'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
    kugouPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'kugou'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast(accountPanelText('logout_kugou_done'));
    return;
  }
  if (activeAccountProvider === 'qq') {
    try { await apiJson('/api/qq/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearQQMusicLogin === 'function') {
        await window.desktopWindow.clearQQMusicLogin();
      }
    } catch (e) { }
    if (typeof clearQQPlaybackVipEvidence === 'function') clearQQPlaybackVipEvidence();
    qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: accountPanelText('login_qq', 'QQ 音乐'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false };
    qqPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qq'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast(accountPanelText('logout_qq_done'));
    return;
  }
  doLogout();
}
async function doLogout() {
  await apiJson('/api/logout');
  try {
    if (window.desktopWindow && typeof window.desktopWindow.clearNeteaseMusicLogin === 'function') {
      await window.desktopWindow.clearNeteaseMusicLogin();
    }
  } catch (e) { }
  loginStatus = { loggedIn: false };
  neteasePlaylists = [];
  if (!hasPlatformLogin('netease') || loggedProviderCount() < 2) dualAccountMode = false;
  activeAccountProvider = firstLoggedProvider();
  userPlaylists = qqPlaylists.concat(kugouPlaylists || [], qishuiPlaylists || []);
  playlistCatalogRevision += 1;
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  closeCollectModal();
  updateLikeButtons();
  safeRenderQueuePanel('logout', { scrollCurrent: miniQueueOpen });
  renderUserBtn();
  safeShelfRebuild('logout');
  closeUserModal();
  showToast(accountPanelText('logged_out', '已退出登录'));
}
