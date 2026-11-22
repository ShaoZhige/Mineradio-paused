var presetTransition = { active: false, start: -10, duration: 0.92, from: 0, to: 0 };
var controlsAutoHide = readBooleanPreference(CONTROLS_AUTO_HIDE_STORE_KEY, false);
var controlsHovering = false;
var controlsHideTimer = null;
var controlsRevealHoldUntil = 0;
var controlsHandleDimTimer = null;
var controlsLastMoveAt = 0;
var controlsShelfSuppressUntil = 0;
var cursorHideTimer = null;
var CURSOR_HIDE_DELAY = 2500;
var fxPanelPinned = false;
var playlistPanelPinned = readBooleanPreference(PLAYLIST_PANEL_PIN_STORE_KEY, false);
var userCapsuleAutoHide = readBooleanPreference(USER_CAPSULE_AUTO_HIDE_STORE_KEY, false);
var fxFabAutoHide = readBooleanPreference(FX_FAB_AUTO_HIDE_STORE_KEY, false);
var fxFabAutoHideRevealArmed = true;
var closeBehaviorPreference = readCloseBehaviorPreference();
var startupAutoplayPreference = readBooleanPreference(STARTUP_AUTOPLAY_STORE_KEY, false);
var startupFastSkipPreference = readBooleanPreference(STARTUP_FAST_SKIP_STORE_KEY, false);
var startupResumeModePreference = readStartupResumeModePreference();
var startupAutoplayAttempted = false;
var startupAutoplayJobId = 0;
var startupAutoplayRetryTimer = null;
var startupAutoplayAttemptCount = 0;
var startupAutoplayHomeFallbackTried = false;
var startupAutoplayHomeQueuedReason = '';
var startupHomeRevealReady = false;
var startupRestoreHomePending = false;
var pendingPlaybackResumeAt = 0;
var restoredLastPlaybackSnapshot = null;
var lastPlaybackSnapshotSavedAt = 0;
// hotkeySettings 在 00b-local-readers.js 初始化（getHotkeyDefaults / readHotkeySettings 一起搬过去了）。
var immersiveMode = false;
var immersiveState = {
  shelfMode: null,
  shelfPinnedOpen: false,
  lyrics: true,
  controlsAutoHide: true,
  bottomVisible: false
};

// 侧架"钉住"状态。真正的 owner 在 04-shelf/00-layout-hover.js，但 01-scene / 02-visual 里
// 多个**更早加载**的模块会直接读它（`if (shelfPinnedOpen) return true;`）。经典脚本的顶层
// `var` 要等该脚本执行才有绑定，启动瞬间的 mousemove 就会炸 ReferenceError（实测日志：
// `shelfPinnedOpen is not defined` @ 01-scene/04-bottom-controls-cursor.js:91）。
// 所以在这里先声明；04-shelf 那边只做赋值，不再重复 var。
var shelfPinnedOpen = false;

// 鼠标 / 摄像头视差
var pointerParallax = { x: 0, y: 0 };
var pointerTarget = { x: 0, y: 0 };
var headParallax = { x: 0, y: 0, active: false };
var headNeutral = null;
