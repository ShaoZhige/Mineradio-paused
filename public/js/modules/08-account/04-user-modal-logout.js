// 词典是界面文案的唯一来源。缺键刻意返回键名而不是空串：空串会让漏译静默发生，
// 键名在界面上是一眼能认出的错误。params 同时喂给 t() 与兜底模板，缺词典时占位符仍会被替换。
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
  // 平台集合必须取自注册表的 login 能力：登出弹窗与 hasAnyPlatformLogin() 都认 Spotify，
  // 写死平台列表会让只用 Spotify 的会话算出 0，连带把下方的双账号模式判成关闭。
  return providerRegistryKeysWith('login').filter(function (key) { return hasPlatformLogin(key); }).length;
}
function openProviderLogin(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : (provider === 'spotify' ? 'spotify' : (provider === 'applemusic' ? 'applemusic' : 'netease'))));
  // AM 没有账号密码/扫码表单：它的"登录"就是把伴生窗口调出来。以前这里把它归一化成网易云，
  // 于是 AM 播不了时点"去登录"打开的是网易云登录框（2026-11-22 全平台清点发现）。
  // Apple Music has no form here; signing in means showing its own window.
  if (provider === 'applemusic' && typeof openAppleMusicLogin === 'function') {
    openAppleMusicLogin();
    return;
  }
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
  forgetAllCachedProviderLoginStatus();
  loginStatus = { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: accountPanelText('vip_none') };
  qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: accountPanelText('login_qq', 'QQ 音乐'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false };
  kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: accountPanelText('provider_kugou'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
  qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: accountPanelText('provider_qishui'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
  spotifyLoginStatus = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', avatar: '', product: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match', tokenConfigured: false, tokenFileExists: false, credentialsFileExists: false, localConfigMissing: false };
  appleMusicLoginStatus = { provider: 'applemusic', loggedIn: false, configured: false, nickname: 'Apple Music', avatar: '', storefront: '', error: '' };
  loginStatusChecked = true;
  loginStatusCheckFailed = false;
  neteasePlaylists = [];
  qqPlaylists = [];
  kugouPlaylists = [];
  qishuiPlaylists = [];
  spotifyPlaylists = [];
  appleMusicPlaylists = [];
  userPlaylists = withLocalLibraryPlaylist(builtInPlaylists);
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  dualAccountMode = false;
  activeAccountProvider = 'netease';
  playlistCatalogRevision += 1;
  if (typeof clearQQPlaybackVipEvidence === 'function') clearQQPlaybackVipEvidence();
  // 首页推荐状态、各平台 feed、仪表盘指纹一律由 resetHomeDiscoverAfterLogout 统一清理。
  if (typeof resetHomeDiscoverAfterLogout === 'function') resetHomeDiscoverAfterLogout('logout-all', { reload: false });
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

// 各平台的登出步骤不一样（清令牌的通道不同），收尾却是同一套：清掉该平台留在界面上的
// 残留、重建歌架、再把「当前展示的账号」指到还活着的那个。收尾抽成一份，登录弹窗的
// 平台节点按钮与账号面板的「退出登录」才能共用同一条路径。
// Each platform signs out differently (different token channels) but finishes identically:
// drop its UI leftovers, rebuild the shelf, then point the displayed account at a live one.
function finishProviderLogout(provider, toastText) {
  // 显示缓存必须跟着登出一起消失，否则下次启动会拿它把已退出的账号又画成"已连接"。
  // The display cache has to die with the logout, or the next launch paints the signed-out
  // account as connected again.
  forgetCachedProviderLoginStatus(provider);
  playlistCatalogRevision += 1;
  dualAccountMode = false;
  if (typeof resetHomeDiscoverAfterLogout === 'function') resetHomeDiscoverAfterLogout('logout-provider');
  activeAccountProvider = firstLoggedProvider();
  renderUserBtn();
  // 酷狗与 QQ 这条路径原先漏了歌架重建：退出后歌单架上还留着它们的条目，
  // 点进去才发现会话已经没了。收尾统一后这个漏洞一并补上。
  // Kugou and QQ used to skip the shelf rebuild here: their entries stayed on the shelf after
  // signing out and only failed once opened. The shared tail fixes that gap too.
  safeShelfRebuild(provider + '-logout');
  if (toastText) showToast(toastText);
}
async function logoutProviderAccount(provider) {
  // 先按注册表校验，再归一化：normalizeAccountProviderKey 会把认不出来的名字折回 netease，
  // 直接拿它当入口会静默退掉网易云。大小写先拉平，免得 'appleMusic' 被当成未知平台。
  // Validate against the registry before normalizing: normalizeAccountProviderKey folds unknown
  // names back to netease, so using it as the entry point could sign out the wrong platform.
  provider = String(provider || '').toLowerCase();
  if (ACCOUNT_PROVIDER_KEYS.indexOf(provider) < 0) return false;
  provider = normalizeAccountProviderKey(provider);
  if (!hasPlatformLogin(provider)) return false;
  if (provider === 'applemusic') {
    try {
      if (window.desktopWindow && typeof window.desktopWindow.appleMusicRequest === 'function') {
        await window.desktopWindow.appleMusicRequest('logout', {});
      }
    } catch (e) { }
    appleMusicLoginStatus = { provider: 'applemusic', loggedIn: false, configured: false, nickname: 'Apple Music', avatar: '', storefront: '', error: '' };
    appleMusicPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'applemusic'; });
    finishProviderLogout('applemusic', accountPanelText('logout_apple_music_cleared', '已退出 Apple Music'));
    return true;
  }
  // Spotify 没有登录窗口，令牌同时存在于后端文件与主进程缓存，两处都要清，
  // 否则下一次状态查询会把旧资料读回来。
  if (provider === 'spotify') {
    // 走 IPC 即可：它删令牌文件并清主进程缓存，与 /api/spotify/logout 等价，
    // 但不必为一次本地文件操作发 HTTP 请求。
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearSpotifyMusicLogin === 'function') {
        await window.desktopWindow.clearSpotifyMusicLogin();
      }
    } catch (e) { }
    spotifyLoginStatus = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', avatar: '', product: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match', tokenConfigured: false, tokenFileExists: false, credentialsFileExists: false, localConfigMissing: false };
    spotifyPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'spotify'; });
    finishProviderLogout('spotify', accountPanelText('logout_spotify_cleared'));
    return true;
  }
  if (provider === 'qishui') {
    try { await apiJson('/api/qishui/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearQishuiMusicLogin === 'function') {
        await window.desktopWindow.clearQishuiMusicLogin();
      }
    } catch (e) { }
    qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: accountPanelText('provider_qishui'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
    qishuiPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qishui'; });
    finishProviderLogout('qishui', accountPanelText('logout_qishui_cleared'));
    return true;
  }
  if (provider === 'kugou') {
    try { await apiJson('/api/kugou/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearKugouMusicLogin === 'function') {
        await window.desktopWindow.clearKugouMusicLogin();
      }
    } catch (e) { }
    kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: accountPanelText('provider_kugou'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
    kugouPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'kugou'; });
    finishProviderLogout('kugou', accountPanelText('logout_kugou_done'));
    return true;
  }
  if (provider === 'qq') {
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
    finishProviderLogout('qq', accountPanelText('logout_qq_done'));
    return true;
  }
  if (provider !== 'netease') return false;
  await doLogout();
  return true;
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
  userPlaylists = withLocalLibraryPlaylist(qqPlaylists.concat(kugouPlaylists || [], qishuiPlaylists || []));
  playlistCatalogRevision += 1;
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  if (typeof resetHomeDiscoverAfterLogout === 'function') resetHomeDiscoverAfterLogout('logout-netease');
  closeCollectModal();
  updateLikeButtons();
  safeRenderQueuePanel('logout', { scrollCurrent: miniQueueOpen });
  renderUserBtn();
  safeShelfRebuild('logout');
  showToast(accountPanelText('logged_out', '已退出登录'));
}
