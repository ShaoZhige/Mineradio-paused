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
// Apple Music 不走上面那条：它要拉起 WebView2 companion，冷启动读一次账号 12~25 秒。所以只在
// 缓存说"上次是登着的"时才在后台补验一次，从没用过 Apple 的人不必为它付这份内存。
// Apple Music is different: probing it spawns the WebView2 companion and a cold read takes
// 12–25 s. Only verify in the background when the cache says the account was signed in.
if (typeof refreshAppleMusicLoginStatus === 'function'
    && typeof appleMusicLoginStatus !== 'undefined' && appleMusicLoginStatus.loggedIn && appleMusicLoginStatus.fromCache) {
  window.setTimeout(function () {
    Promise.resolve(refreshAppleMusicLoginStatus()).then(function () {
      // 缓存过期了就要把残留的 Apple 歌单一起收掉，否则列表里会留下点不进去的条目。
      // 不弹 toast：用户什么都没做，启动时弹"已登出"只会像出错。
      // An expired cache has to drop the leftover Apple playlists too, or the shelf keeps entries
      // that fail to open. No toast: the user did nothing, and a logout notice at startup reads
      // like a failure.
      if (appleMusicLoginStatus && !appleMusicLoginStatus.loggedIn) {
        appleMusicPlaylists = [];
        userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'applemusic'; });
        playlistCatalogRevision += 1;
        if (typeof safeShelfRebuild === 'function') safeShelfRebuild('applemusic-cache-expired');
      }
      renderUserBtn();
    }, function () { });
  }, 2500);
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
