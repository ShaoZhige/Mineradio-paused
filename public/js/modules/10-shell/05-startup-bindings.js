applyDiyMode(diyPlayerMode, { save: false });
bindCustomSourceManager();
bindFxPanel();
applySavedLyricPaletteState();
bindQualityControl();
bindAudioOutputControls();
bindVolumeControls();
initControlGlassSurface();
bindPlayerControlAnimations();
scheduleUiWarmTask(function () {
  updateControlGlassDisplacementMap();
  updateSearchBoxGlassDisplacementMap();
  updateSearchPillGlassDisplacementMap();
  try {
    if (renderer && renderer.compile && scene && camera) renderer.compile(scene, camera);
  } catch (e) { }
}, 900);
applyUserCapsuleAutoHideState();
applyFxFabAutoHideState();
initializeDesktopCloseBehavior();
applyStartupAutoplayUi();
applySpotifyRemotePrefsUi();
applyPreferredSourceUi();
applyControlsAutoHidePreference();
applyDesktopLyricsState(false);
applyWallpaperModeState(false);
setShelfMode(fx.shelf);
if (fx.shelf === 'side') setShelfPinnedOpen(!!fx.shelfPinnedOpen, true, false);
var restoredPlaybackAtStartup = restoreLastPlaybackSnapshot();
// 曲库文件夹监视的订阅要在恢复之后挂上：早于恢复的话，第一次变化会和正在进行的恢复抢同一份
// 列表。订阅本身不改变任何状态，只是接住主进程的通知。
// Subscribe to the library folder watch after the restore: earlier than that and the first change
// would race the restore for the same list. The subscription itself changes nothing, it only
// receives the main-process signal.
if (typeof bindPersistentLocalLibraryWatch === 'function') bindPersistentLocalLibraryWatch();
var persistedLocalLibraryRestorePromise = Promise.resolve(restorePersistedLocalLibrary()).then(function (restored) {
  if (restored) restoredPlaybackAtStartup = true;
  else if (!restoredLastPlaybackSnapshot) restoredPlaybackAtStartup = false;
  return restored;
}, function () { return false; });
var builtInPlaylistRestorePromise = typeof refreshBuiltInPlaylists === 'function'
  ? Promise.resolve(refreshBuiltInPlaylists(false))
  : Promise.resolve(false);
applyStartupStarfieldPreset();
switchPlaylistTab(queueViewTab, { save: false, animate: false, refresh: false });
applyPlaylistPanelPinState(false);
if (fx.floatLayer) createFloatLayer();
if (fx.particleLyrics) createLyricsParticles();
if (fx.backCover) createBackCoverLayer();
initIdleGuideCanvas();
// Spotify 必须和网易云/QQ/酷狗/汽水一起查：它的状态不在本地文件里，只有一次 /api/spotify/status
// 才能确认。以前这里没带上它，于是进播放器时 SP 永远是"未登录"，要等用户点开登录面板或切到左栏
// 才补上——用户看到的就是"SP 一开始没状态，过一会儿才连上"。
// Spotify has to be queried alongside the cookie-based providers: its session is not in a local
// file, so only /api/spotify/status can confirm it. Leaving it out here is what made SP read as
// signed out until the user happened to open the login panel or the left shelf.
var startupLoginStatusPromise = Promise.all([refreshLoginStatus(), refreshQQLoginStatus({ forceVip: true, reason: 'startup' }), refreshKugouLoginStatus(), refreshQishuiLoginStatus(), refreshSpotifyLoginStatus(), persistedLocalLibraryRestorePromise, builtInPlaylistRestorePromise]);
startQQLoginStatusAutoRefresh();
startKugouLoginStatusAutoRefresh();
startQishuiLoginStatusAutoRefresh();
// 这个定时器此前只定义、从未启动：SP 的会话过期后界面再也不会自己发现，必须手动刷新。
// This timer used to be defined and never started, so an expired Spotify session went unnoticed
// until something else happened to refresh it.
startSpotifyLoginStatusAutoRefresh();
// Apple Music 的会话在 WebView2 companion 里，冷启动读一次账号要 12~25 秒，而 companion 的
// 请求是**串行**的：启动阶段任何一次 accountStatus 都会把歌单列表、曲目数、播放全堵在后面。
// 所以这里只做一件事：缓存说"上次登着"时在后台补验一次，失败就算了（用户真的打开歌单或
// 登录面板时会再验）。不预热、不重试、不额外发请求。
// Exactly one background re-check, only when the cache said "signed in": the companion serialises
// requests, so an early probe would stall the playlist list, the counts and playback.
if (typeof refreshAppleMusicLoginStatus === 'function'
    && typeof appleMusicLoginStatus !== 'undefined' && appleMusicLoginStatus.loggedIn && appleMusicLoginStatus.fromCache) {
  // 排到首屏之后（有 requestIdleCallback 就用它）：WebView2 冷启动要抢一两秒 CPU，
  // 和首屏渲染/歌单请求撞在一起时，用户感知到的就是"软件拉起来很慢"。
  var runAppleMusicStartupProbe = function () {
    Promise.resolve(refreshAppleMusicLoginStatus()).then(function () {
      // 补验成功但歌单是空的（上一次可能被误清过）：把 Apple 歌单拉回来，别让面板停在"未载入"。
      if (appleMusicLoginStatus && appleMusicLoginStatus.loggedIn
          && !appleMusicLoginStatus.fromCache
          && !(appleMusicPlaylists && appleMusicPlaylists.length)
          && typeof refreshUserPlaylists === 'function') {
        refreshUserPlaylists(true);
        return;
      }
      if (appleMusicLoginStatus && !appleMusicLoginStatus.loggedIn) {
        appleMusicPlaylists = [];
        userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'applemusic'; });
        playlistCatalogRevision += 1;
        if (typeof safeShelfRebuild === 'function') safeShelfRebuild('applemusic-cache-expired');
      }
      // 账号确认之后顺手把歌单第一页拉进服务端缓存（120s）：这里页面已经热了，
      // 多这一次往返很便宜，但用户打开歌单栏时就是秒开。
      if (appleMusicLoginStatus && appleMusicLoginStatus.loggedIn
          && typeof apiJson === 'function' && !(appleMusicPlaylists && appleMusicPlaylists.length)) {
        apiJson('/api/apple-music/playlists?limit=25&offset=0', { timeoutMs: 15000 }).catch(function () { });
      }
      if (typeof renderUserBtn === 'function') renderUserBtn();
    }, function () { });
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(runAppleMusicStartupProbe, { timeout: 6000 });
  } else {
    window.setTimeout(runAppleMusicStartupProbe, 6000);
  }
}
if (typeof setupFullscreenToolsLayoutTracking === 'function') setupFullscreenToolsLayoutTracking();
if (startupLoginStatusPromise && startupLoginStatusPromise.then) {
  startupLoginStatusPromise.then(function () {
    if (hasAnyPlatformLogin()) {
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
    }
    if (restoredPlaybackAtStartup) queueStartupAutoplayAfterHomeReveal('login-status');
    if (document.body.classList.contains('splash-active')) return;
    var homeShown = updateEmptyHomeVisibility({ forceLoad: hasAnyPlatformLogin() });
    if (!hasAnyPlatformLogin()) maybeRunStartupLoginGuide('status');
    else if (!homeShown) maybeRunStartupLoginGuide('status');
  }, function () {
    if (restoredPlaybackAtStartup) queueStartupAutoplayAfterHomeReveal('login-status');
  });
} else if (restoredPlaybackAtStartup) {
  queueStartupAutoplayAfterHomeReveal('startup');
}
var collectNameInput = document.getElementById('collect-new-name');
if (collectNameInput) {
  collectNameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      createPlaylistFromCollect();
    }
  });
}
var customLyricInput = document.getElementById('custom-lyric-input');
if (customLyricInput) {
  customLyricInput.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveCustomLyricForCurrent();
    }
  });
}
safeRenderQueuePanel('startup');
if (!restoredPlaybackAtStartup) {
  restoredPlaybackAtStartup = restoreLastPlaybackSnapshot();
  if (restoredPlaybackAtStartup) queueStartupAutoplayAfterHomeReveal('startup-restore');
}
safeRenderQueuePanel('startup-restore');
updateCustomCoverButton();
updateCustomLyricControls();
updateLikeButtons();
setTimeout(initUpdatePreview, 9000);
window.addEventListener('beforeunload', function () {
  saveLastPlaybackSnapshot(true, 'beforeunload');
});

// ============================================================
//  主循环
