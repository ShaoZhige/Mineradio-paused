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
function coreStoresText(key, fallback, params) {
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
'use strict';

// ============================================================
//  Global State
// ============================================================
var audio = null, audioCtx = null, source = null, audioSourceMedia = null, analyser = null, beatAnalyser = null, gainNode = null, analysisSinkNode = null, audioReady = false;
var uiSfxCtx = null, lastShelfSelectSfxAt = 0;
var FFT_SIZE = 2048;
var frequencyData = new Uint8Array(FFT_SIZE / 2);
var timeDomainData = new Uint8Array(FFT_SIZE);
var BEAT_FFT_SIZE = 2048;
var beatFrequencyData = new Uint8Array(BEAT_FFT_SIZE / 2);
var beatTimeDomainData = new Uint8Array(BEAT_FFT_SIZE);
var bass = 0, mid = 0, treble = 0, audioEnergy = 0, beatPulse = 0, prevEnergy = 0;
var lyricSunEnergy = 0, lyricSunTarget = 0, lyricSunHold = 0, lyricSunAvg = 0, lyricSunPeak = 0.55;
var smoothBass = 0, smoothMid = 0, smoothTreb = 0, smoothEnergy = 0;
var bassPeak = 0.12, midPeak = 0.10, treblePeak = 0.08, energyPeak = 0.10;
var beatOnsetFlag = false;        // beat 上升沿瞬时标志,每帧消费一次
var lastStrongDrop = 0;           // 用于 burst 预设的强 drop 时刻

var lyricsLines = [], lyricsTranslationLines = [], lyricsVisible = false, lyricsHasNativeKaraoke = false, lyricsTimingSource = 'none', lyricsTranslationSource = 'none';
var playlist = [], playQueue = [], currentIdx = -1, playing = false, playToggleBusy = false;
var searchMode = 'song', podcastResults = [], podcastPrograms = [], podcastCurrentRadio = null;
var loginStatus = { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: coreStoresText('vip_none') };
var qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: coreStoresText('login_qq', 'QQ 音乐'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false };
var kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: coreStoresText('provider_kugou'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
var qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, preview: false, nickname: coreStoresText('provider_qishui'), userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
var qqLoginAutoRefreshTimer = null;
var qqLoginStatusLastForcedAt = 0;
var kugouLoginAutoRefreshTimer = null;
var qishuiLoginAutoRefreshTimer = null;
var spotifyLoginStatus = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', avatar: '', product: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
var spotifyLoginAutoRefreshTimer = null;
var qqLoginWasLoggedIn = false;
var kugouLoginWasLoggedIn = false;
var qishuiLoginWasLoggedIn = false;
var spotifyLoginWasLoggedIn = false;
var loginProvider = 'netease';
var activeAccountProvider = 'netease';
var dualAccountMode = false;
var qqCookieBusy = false;
var kugouCookieBusy = false;
var qishuiTokenBusy = false;
var qishuiOAuthBusy = false;
var spotifyConfigBusy = false;
var spotifyOAuthBusy = false;
var neteaseWebLoginBusy = false;
var qqWebLoginBusy = false;
var kugouWebLoginBusy = false;
var neteaseManualCookieOpen = false;
var qqManualCookieOpen = false;
var kugouManualCookieOpen = false;
var qishuiManualCookieOpen = false;
var loginStatusChecked = false, loginStatusCheckFailed = false;
var qrPollTimer = null, qrKey = null;
var qishuiQrPollBusy = false, qishuiQrPollGeneration = 0;
var volumeTween = null, trackSwitchToken = 0;
var audioFadeTimer = null, audioElementFadeFrame = 0, audioFadeSerial = 0;
var playbackResumeRecovery = { serial: 0, pending: false, lastAttemptAt: 0, lastReason: '', pausedAt: 0, pausedSongKey: '', pausedSrc: '', pausedPosition: 0, timerIds: [] };
var albumGaplessState = { enabled: false, defaultEnabled: true, albumKey: '', disabledAlbumKey: '', context: null, preload: null, serial: 0, monitorTimer: 0, handoff: false };
var PLAYBACK_RESUME_STALL_DELAYS = [1600, 3600];
var PLAYBACK_RESUME_LONG_PAUSE_MS = 8 * 60 * 1000;
var PLAYBACK_RESUME_LONG_PAUSE_PROVIDER_MS = { qishui: 3 * 60 * 1000, qq: 8 * 60 * 1000, kugou: 8 * 60 * 1000, netease: 12 * 60 * 1000 };
var AUDIO_FADE_STORE_KEY = 'mineradio-audio-fade-v1';
var AUDIO_FADE_MIN_MS = 0;
var AUDIO_FADE_MAX_MS = 3000;
var audioFadePreference = readAudioFadePreference();
var AUDIO_FADE_IN_MS = audioFadePreference.fadeInMs;
var AUDIO_FADE_OUT_MS = audioFadePreference.fadeOutMs;
var AUDIO_SILENCE_GAIN = 0.0001;
var audioFadeEnvelope = 1;
var userPlaylists = [], builtInPlaylists = [], neteasePlaylists = [], qqPlaylists = [], kugouPlaylists = [], qishuiPlaylists = [], spotifyPlaylists = [], myPodcastCollections = [], myPodcastItems = {}, playlistCoverCache = {};
var builtInPlaylistLoadPromise = null;
var queueHydrationState = {
  token: 0,
  active: false,
  loading: false,
  provider: '',
  playlistId: '',
  sourceId: '',
  title: '',
  total: 0,
  nextOffset: 0,
  hasMore: false,
  loaded: 0,
  error: '',
  promise: null,
  timer: 0,
  queueRef: null,
  warmPagesRemaining: 0,
  pausedForBuffer: false
};
var CUSTOM_COVER_STORE_KEY = 'mineradio-custom-covers';
var CUSTOM_LYRIC_STORE_KEY = 'mineradio-custom-lyrics-v1';
var CUSTOM_LYRIC_PREF_STORE_KEY = 'mineradio-custom-lyric-prefs-v1';
var CUSTOM_LYRIC_FONT_STORE_KEY = 'mineradio-custom-lyric-fonts-v1';
var CUSTOM_LYRIC_FONT_MAX_COUNT = 6;
var CUSTOM_LYRIC_FONT_MAX_BYTES = 3.6 * 1024 * 1024;
var LYRIC_LAYOUT_STORE_KEY = 'mineradio-lyric-layout-v1';
var CURRENT_FX_AUTOSAVE_STORE_KEY = 'mineradio-current-fx-autosave-v1';
var CURRENT_FX_AUTOSAVE_SCHEMA = 'current-fx-autosave-v2';
var VISUAL_PRESET_SCHEMA = 'skull-preset-v2';
var MAX_VISUAL_PRESET_INDEX = 12;
var SONIC_PRESET_INDEX = 7;
var SONIC_WORKSHOP_PRESET_INDEX = 8;
var PLAYBACK_QUALITY_STORE_KEY = 'mineradio-playback-quality-v1';
var AUDIO_OUTPUT_DEVICE_STORE_KEY = 'mineradio-audio-output-device-v1';
var AUDIO_OUTPUT_MIRROR_STORE_KEY = 'mineradio-audio-output-mirror-v1';
var AUDIO_INPUT_BRIDGE_STORE_KEY = 'mineradio-audio-input-bridge-v1';
var PROVIDER_VIP_AUDIT_STORE_KEY = 'mineradio-provider-vip-audit-v1';
var QQ_PLAYBACK_VIP_EVIDENCE_STORE_KEY = 'mineradio-qq-playback-vip-evidence-v1';
var LOGIN_COOKIE_EXPORT_STORE_KEY = 'mineradio-login-cookie-export-v1';
var PLAYBACK_QUALITY_DEFAULTS = { netease: 'hires', qq: 'lossless', kugou: 'lossless', qishui: 'standard', spotify: 'standard' };
function playbackQualityOptionTable() {
  return {
  netease: [
    { key: 'jymaster', title: coreStoresText('quality_jymaster', '超清母带'), sub: coreStoresText('quality_sub_svip'), svip: true },
    { key: 'hires', title: coreStoresText('quality_hires', '高清臻音'), sub: coreStoresText('quality_sub_default_detail') },
    { key: 'lossless', title: coreStoresText('quality_lossless_sq'), sub: coreStoresText('quality_sub_flac_first') },
    { key: 'exhigh', title: coreStoresText('quality_exhigh_hq'), sub: '320kbps' },
    { key: 'standard', title: coreStoresText('quality_standard', '标准'), sub: '128kbps' }
  ],
  qq: [
    { key: 'hires', title: 'Hi-Res FLAC', sub: coreStoresText('quality_qq_hires_sub') },
    { key: 'lossless', title: coreStoresText('quality_lossless_flac', '无损 FLAC'), sub: coreStoresText('quality_qq_sq_sub') },
    { key: 'exhigh', title: '320k MP3', sub: coreStoresText('quality_qq_high') },
    { key: 'standard', title: '128k MP3', sub: coreStoresText('quality_sub_compat_first') }
  ],
  kugou: [
    { key: 'hires', title: coreStoresText('quality_kugou_hires'), sub: coreStoresText('quality_kugou_hires_sub') },
    { key: 'lossless', title: coreStoresText('quality_lossless_flac', '无损 FLAC'), sub: coreStoresText('quality_kugou_sq_sub') },
    { key: 'exhigh', title: '320k MP3', sub: coreStoresText('quality_kugou_high') },
    { key: 'standard', title: '128k MP3', sub: coreStoresText('quality_sub_compat_first') }
  ],
  qishui: [
    { key: 'standard', title: coreStoresText('quality_qishui_match'), sub: coreStoresText('quality_qishui_sub') }
  ],
  spotify: [
    { key: 'standard', title: coreStoresText('quality_spotify_match'), sub: coreStoresText('quality_spotify_sub') }
  ]
  }
}
var UPLOAD_TIP_STORE_KEY = 'mineradio-upload-tip-seen';
var DIY_MODE_STORE_KEY = 'mineradio-diy-player-mode-v1';
var PLAYLIST_PANEL_PIN_STORE_KEY = 'mineradio-playlist-panel-pinned-v1';
var PLAYLIST_PANEL_TAB_STORE_KEY = 'mineradio-playlist-panel-tab-v1';
var USER_CAPSULE_AUTO_HIDE_STORE_KEY = 'mineradio-user-capsule-auto-hide-v1';
var FX_FAB_AUTO_HIDE_STORE_KEY = 'mineradio-fx-fab-auto-hide-v1';
var CONTROLS_AUTO_HIDE_STORE_KEY = 'mineradio-controls-auto-hide-v1';
var FREE_CAMERA_STORE_KEY = 'mineradio-free-camera-v1';
var HOTKEY_SETTINGS_STORE_KEY = 'mineradio-hotkey-settings-v1';
var VISUAL_GUIDE_SEEN_STORE_KEY = 'mineradio-visual-guide-seen-v2';
// 关闭行为默认改为「托盘常驻」。v1 这个键被早期构建在首次启动时把默认值 'exit' 自动写回了
// localStorage（见 02-preferences-ui-modes.js 的 initializeDesktopCloseBehavior），导致升级后
// 原本隐含的托盘行为被锁死成退出。直接升到 v2 丢弃那个被错误持久化的 v1 值，让新默认值生效。
// Close behavior now defaults to tray. The v1 key was auto-persisted with 'exit' by an earlier
// build on first launch, locking the previously-implied tray behavior into a quit. Bumping to v2
// discards that wrongly-persisted value so the new default takes effect.
var CLOSE_BEHAVIOR_STORE_KEY = 'mineradio-close-behavior-v2';
var LAST_PLAYBACK_STORE_KEY = 'mineradio-last-playback-v1';
var STARTUP_AUTOPLAY_STORE_KEY = 'mineradio-startup-autoplay-v1';
var STARTUP_FAST_SKIP_STORE_KEY = 'mineradio-startup-fast-skip-v1';
var STARTUP_RESUME_MODE_STORE_KEY = 'mineradio-startup-resume-mode-v1';
var LOCAL_BEATMAP_STORE_KEY = 'mineradio-local-beatmaps-v1';
var LOCAL_BEAT_PREF_STORE_KEY = 'mineradio-local-beatmap-prefs-v1';
var LOCAL_BEAT_COMBOS = ['', 'downbeat', 'push', 'drop', 'rebound', 'accent'];
function hotkeyActionsList() {
  return [
  { key: 'togglePlay', label: coreStoresText('hotkey_play_pause'), category: coreStoresText('hotkey_cat_playback'), local: 'Space', global: 'Ctrl+Alt+Space' },
  { key: 'prevTrack', label: coreStoresText('hotkey_prev_track'), category: coreStoresText('hotkey_cat_playback'), local: 'ArrowLeft', global: 'Ctrl+Alt+ArrowLeft' },
  { key: 'nextTrack', label: coreStoresText('hotkey_next_track'), category: coreStoresText('hotkey_cat_playback'), local: 'ArrowRight', global: 'Ctrl+Alt+ArrowRight' },
  { key: 'volumeUp', label: coreStoresText('hotkey_volume_up'), category: coreStoresText('fx_volume'), local: 'ArrowUp', global: 'Ctrl+Alt+ArrowUp' },
  { key: 'volumeDown', label: coreStoresText('hotkey_volume_down'), category: coreStoresText('fx_volume'), local: 'ArrowDown', global: 'Ctrl+Alt+ArrowDown' },
  { key: 'toggleFullscreen', label: coreStoresText('btn_fullscreen', '全屏'), category: coreStoresText('hotkey_cat_window'), local: 'KeyF', global: 'Ctrl+Alt+KeyF' },
  { key: 'toggleDesktopInteraction', label: coreStoresText('hotkey_toggle_full_desktop'), category: coreStoresText('hotkey_cat_window'), local: '', global: 'Ctrl+Shift+KeyM' },
  { key: 'toggleDesktopLyrics', label: coreStoresText('toggle_desktop_lyrics', '桌面歌词'), category: coreStoresText('hotkey_cat_lyrics'), local: 'Alt+KeyL', global: 'Ctrl+Alt+KeyL' }
  ]
}
var hotkeyCaptureState = null;
var hotkeyGlobalStatus = {};
var diyPlayerMode = readDiyModePreference();
var customCoverMap = readCustomCoverMap();
var customLyricMap = readCustomLyricMap();
var customLyricPrefs = readCustomLyricPrefs();
var customLyricFonts = readCustomLyricFonts();
registerSavedCustomLyricFonts();
var localBeatMapCache = readLocalBeatMapCache();
var localBeatMapPrefs = readLocalBeatPrefs();
var playbackQualityPrefs = readPlaybackQualityPreference();
var playbackQuality = getProviderPlaybackQuality('netease');
var audioOutputDeviceId = readAudioOutputDevicePreference();
var audioOutputDevices = [];
var audioInputDevices = [];
var audioOutputMirrorDeviceIds = readAudioOutputMirrorPreference();
var audioInputBridgeState = readAudioInputBridgePreference();
var audioOutputMirrorElements = {};
var audioOutputMirrorRuntime = {};
var audioOutputMirrorSyncTimer = 0;
var playbackQualityRuntimeCaps = {};
var coverCropState = null, coverCropBound = false;
var currentLocalSong = null;
var persistentLocalLibraryTracks = [];
var lyricSourceMode = 'original';
var originalLyricsState = { lines: [], hasNativeKaraoke: false, timingSource: 'none', translationLines: [], translationSource: 'none' };
var localBeatAnalysis = { song: null, audioUrl: '', mode: 'mr', active: false, token: 0 };
var likedSongMap = {}, likeBusyMap = {}, likeStatusToken = 0;
var collectTargetSong = null, collectBusy = false;
var uploadTipTimer = null, uploadTipAttempts = 0;
var visualGuideActive = false, visualGuideStep = 0, visualGuideResizeBound = false;
var visualGuideState = { bottomWasVisible: false, searchWasPeek: false, manual: false };
var emptyHomeActive = false;
var homeForcedOpen = false;
var homeSuppressed = false;
var homeDiscoverState = { loading: false, loaded: false, loggedIn: false, mode: 'starter', songs: [], playlists: [], podcasts: [], error: '', updatedAt: 0 };
var homeDiscoverToken = 0;
var homeVisualPresetActive = false;
var homeVisualPrevPreset = 0;
var HOME_LISTEN_STATS_KEY = 'mineradio-listen-stats-v1';
var activeRadioContext = null;
var listenStatsState = loadListenStatsState();
var listenSession = null;
var appPerfMarks = [];
