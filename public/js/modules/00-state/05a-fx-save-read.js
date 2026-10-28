// 存档读取层：把「读视觉存档 → 归一化成 fx 字段」放在所有需要它的人之前。
//
// 为什么单独一个文件：`fx` 在 06-fx-runtime-layout.js 里就要用完整真值初始化——01-scene/01
// 要用 preset 摆镜头基线、02-visual/00 要按 coverResolution 建粒子几何、10-shell/05 的整条启动
// 序列要读 shelf / floatLayer / particleLyrics / backCover。以前这些读取函数住在 02-visual/04，
// 位置比消费者还晚：整包拼接时靠跨文件函数提升侥幸能跑，拆成分文件就全是 ReferenceError。
// 本文件只做**读 + 归一化**，不含任何写回/持久化逻辑（那些仍留在 02-visual/04）。
//
// Why this file exists: `fx` must be fully initialised inside 06-fx-runtime-layout.js — 01-scene/01
// poses the camera baseline from `preset`, 02-visual/00 builds particle geometry from
// `coverResolution`, and the whole startup sequence in 10-shell/05 reads shelf / floatLayer /
// particleLyrics / backCover. Those readers used to live in 02-visual/04, i.e. AFTER their
// consumers; concatenation survived on cross-file function hoisting, split injection did not.
// This file is read + normalise only — every write/persist path stays in 02-visual/04.

function normalizePerformanceBackgroundMode(v, liveKeepFallback) {
  var value = String(v || '');
  if (value === 'keep' || liveKeepFallback === true) return 'keep';
  if (value === 'release') return 'release';
  return 'auto';
}
function normalizePerformanceQuality(v) {
  var value = String(v || '');
  return /^(eco|balanced|high|ultra)$/.test(value) ? value : fxDefaults.performanceQuality;
}
function normalizeLyricTextureClarity(v) {
  var value = Number(v);
  if (!isFinite(value)) value = Number(fxDefaults.lyricTextureClarity) || 1;
  // Compatibility with the short-lived 1 / 1.25 / 1.5 experiment.  New
  // archives store the user-facing raster multiplier directly as 1..4.
  if (Math.abs(value - 1.25) < 0.001) return 2;
  if (Math.abs(value - 1.5) < 0.001) return 4;
  return clampRange(Math.round(value), 1, 4);
}
// 标签必须显示**实际生效**的网格，而不是用户请求的那个：预算是从上面压下来的（请求 183x183、
// eco 档实际只画 163x163 就是这么来的），报一个没在画的数字会让用户以为自己已经调到位了。
// The label must show the grid that is actually in effect, not the one that was asked for: the budget
// pushes down from above (a requested 183x183 draws 163x163 on the eco tier), so reporting a number
// that is not being drawn makes the user think the setting already bottomed out.
function coverParticleCountLabel(v) {
  var requested = coverParticleGridForResolution(v);
  var grid = (typeof runtimeCoverParticleGridBudget === 'function')
    ? runtimeCoverParticleGridBudget(requested) : requested;
  return grid + 'x' + grid;
}
function coverTextureSizeForResolution(v) {
  v = normalizeCoverResolution(v);
  if (v >= 1.32) return 512;
  if (v >= 1.10) return 384;
  return 256;
}
var currentFxAutosaveDiskTimer = null;
var currentFxAutosaveDiskPayload = null;
var currentFxAutosaveBootAt = Date.now();
var currentFxAutosaveUserDirty = false;
var currentFxAutosaveLastUserReason = '';
function plainCurrentFxAutosavePayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function currentFxAutosaveTimestamp(raw) {
  raw = plainCurrentFxAutosavePayload(raw);
  if (!raw) return 0;
  var n = Number(raw.autosavedAt || raw.savedAt || 0);
  return isFinite(n) ? n : 0;
}
function parseCurrentFxAutosaveText(rawText) {
  if (!rawText) return null;
  try {
    return plainCurrentFxAutosavePayload(JSON.parse(rawText));
  } catch (e) {
    return null;
  }
}
function repairCurrentFxAutosaveLocalMirror(payload) {
  payload = plainCurrentFxAutosavePayload(payload);
  if (!payload) return;
  try {
    localStorage.setItem(CURRENT_FX_AUTOSAVE_STORE_KEY, JSON.stringify(payload));
    try { localStorage.removeItem(LYRIC_LAYOUT_STORE_KEY); } catch (cleanupError) { }
  } catch (e) { }
}
function readDesktopCurrentFxAutosaveRaw() {
  try {
    var bridge = window.desktopWindow;
    if (!bridge || typeof bridge.readCurrentFxAutosaveSync !== 'function') return null;
    var result = bridge.readCurrentFxAutosaveSync();
    return plainCurrentFxAutosavePayload(result && result.payload);
  } catch (e) {
    console.warn('[FxAutosave] desktop read failed:', e);
    return null;
  }
}
function chooseCurrentFxAutosaveRaw(localRaw, diskRaw) {
  if (localRaw && diskRaw) {
    var localHasUserVisual = currentFxAutosaveHasUserVisualState(localRaw);
    var diskHasUserVisual = currentFxAutosaveHasUserVisualState(diskRaw);
    if (diskHasUserVisual && !localHasUserVisual) {
      repairCurrentFxAutosaveLocalMirror(diskRaw);
      return diskRaw;
    }
    if (localHasUserVisual && !diskHasUserVisual) return localRaw;
    if (currentFxAutosaveTimestamp(diskRaw) >= currentFxAutosaveTimestamp(localRaw)) {
      repairCurrentFxAutosaveLocalMirror(diskRaw);
      return diskRaw;
    }
    return localRaw;
  }
  if (diskRaw) {
    repairCurrentFxAutosaveLocalMirror(diskRaw);
    return diskRaw;
  }
  return localRaw;
}
// 「这份存档里带不带用户主动改过的视觉状态」——用于在 localStorage 与磁盘两份存档之间挑一份。
// 它原本在 02-visual/04（写入半部），但读取半部要用它做选择，所以跟着读取一起前移。
// Which of two archives carries real user visual state — used to pick between the localStorage
// and disk copies. It used to live in 02-visual/04 with the write half; the read half needs it.
function currentFxAutosaveHasUserVisualState(raw) {
  raw = plainCurrentFxAutosavePayload(raw);
  if (!raw) return false;
  if (raw.autosaveUser === true) return true;
  if (raw.lyricColorMode === 'custom' || raw.lyricHighlightMode === 'custom') return true;
  if (raw.lyricGlowLinked === false) return true;
  if (normalizeHexColor(raw.lyricColor || fxDefaults.lyricColor, fxDefaults.lyricColor) !== normalizeHexColor(fxDefaults.lyricColor, '#a9b8c8')) return true;
  if (normalizeHexColor(raw.lyricHighlightColor || fxDefaults.lyricHighlightColor, fxDefaults.lyricHighlightColor) !== normalizeHexColor(fxDefaults.lyricHighlightColor, '#fac900')) return true;
  if (normalizeHexColor(raw.lyricGlowColor || fxDefaults.lyricGlowColor, fxDefaults.lyricGlowColor) !== normalizeHexColor(fxDefaults.lyricGlowColor, '#008aff')) return true;
  if (layoutNumber(raw.controlGlassChromaticOffset, fxDefaults.controlGlassChromaticOffset, 30, 140) !== layoutNumber(fxDefaults.controlGlassChromaticOffset, 90, 30, 140)) return true;
  return false;
}
function readCurrentFxAutosaveStorageRaw() {
  var localRaw = null;
  try {
    var rawText = localStorage.getItem(CURRENT_FX_AUTOSAVE_STORE_KEY);
    if (!rawText) rawText = localStorage.getItem(LYRIC_LAYOUT_STORE_KEY);
    localRaw = parseCurrentFxAutosaveText(rawText);
  } catch (e) { }
  var diskRaw = readDesktopCurrentFxAutosaveRaw();
  return chooseCurrentFxAutosaveRaw(localRaw, diskRaw);
}
function readCurrentFxAutosaveRaw() {
  var storedRaw = readCurrentFxAutosaveStorageRaw();
  if (storedRaw) return storedRaw;
  return packagedDefaultLyricLayoutRaw();
}
function normalizeSavedLyricDisplayMode(mode) {
  mode = String(mode || 'single');
  return /^(single|dual|triple|cinema|custom)$/.test(mode) ? mode : 'single';
}
function normalizeSavedLyricTranslationMode(mode) {
  mode = String(mode || 'off');
  return /^(off|current|dual|multi)$/.test(mode) ? mode : 'off';
}
function normalizeSavedLyricMotionStyle(style) {
  style = String(style || 'float');
  return /^(glass|smooth|float|quick|shine|glitch)$/.test(style) ? style : 'float';
}
function readSavedLyricLayoutCriticalFallback(raw, err) {
  raw = plainCurrentFxAutosavePayload(raw);
  if (err) {
    try {
      console.warn('[FxAutosave] startup layout read fallback:', err);
    } catch (logError) { }
  }
  if (!raw) return {};
  return {
    lyricColorMode: raw.lyricColorMode === 'custom' ? 'custom' : 'auto',
    lyricColor: normalizeHexColor(raw.lyricColor || fxDefaults.lyricColor || '#a9b8c8', fxDefaults.lyricColor || '#a9b8c8'),
    lyricHighlightMode: raw.lyricHighlightMode === 'custom' ? 'custom' : 'auto',
    lyricHighlightColor: normalizeHexColor(raw.lyricHighlightColor || fxDefaults.lyricHighlightColor || '#fac900', fxDefaults.lyricHighlightColor || '#fac900'),
    lyricGlowLinked: raw.lyricGlowLinked !== false,
    lyricGlowColor: normalizeHexColor(raw.lyricGlowColor || fxDefaults.lyricGlowColor || '#008aff', fxDefaults.lyricGlowColor || '#008aff'),
    lyricDisplayMode: normalizeSavedLyricDisplayMode(raw.lyricDisplayMode || fxDefaults.lyricDisplayMode),
    lyricTranslationMode: normalizeSavedLyricTranslationMode(raw.lyricTranslationMode || fxDefaults.lyricTranslationMode),
    lyricMotionStyle: normalizeSavedLyricMotionStyle(raw.lyricMotionStyle || fxDefaults.lyricMotionStyle),
    lyricVerticalFloat: raw.lyricVerticalFloat !== false,
    lyricCustomLineCount: layoutInteger(raw.lyricCustomLineCount, fxDefaults.lyricCustomLineCount, 1, 10),
    controlGlassChromaticOffset: layoutNumber(raw.controlGlassChromaticOffset, fxDefaults.controlGlassChromaticOffset, 30, 140)
  };
}
function readSavedLyricLayout() {
  var raw = null;
  try {
    raw = readCurrentFxAutosaveRaw();
    var savedPreset = clampRange(Number(raw.preset) || 0, 0, MAX_VISUAL_PRESET_INDEX);
    if (savedPreset === 3 && raw.visualPresetSchema !== VISUAL_PRESET_SCHEMA) {
      savedPreset = 5;
    }
    var savedBgColor = normalizeHexColor(raw.backgroundColor || '#000000', '#000000');
    var savedBgOpacity = clampRange(raw.backgroundOpacity == null ? fxDefaults.backgroundOpacity : Number(raw.backgroundOpacity), 0, 1);
    var savedWindowBgOpacity = clampRange(raw.windowBackgroundOpacity == null ? fxDefaults.windowBackgroundOpacity : Number(raw.windowBackgroundOpacity), 0, 1);
    var savedBgGlassOpacity = clampRange(raw.backgroundGlassOpacity == null ? fxDefaults.backgroundGlassOpacity : Number(raw.backgroundGlassOpacity), 0, 1);
    var savedBgCropX = layoutNumber(raw.backgroundMediaCropX, fxDefaults.backgroundMediaCropX, 0, 100);
    var savedBgCropY = layoutNumber(raw.backgroundMediaCropY, fxDefaults.backgroundMediaCropY, 0, 100);
    var savedBgZoom = layoutNumber(raw.backgroundMediaZoom, fxDefaults.backgroundMediaZoom, 1, 2.8);
    var savedGlassOffset = layoutNumber(raw.controlGlassChromaticOffset, fxDefaults.controlGlassChromaticOffset, 30, 140);
    var savedPlaylistPanelGlassBlur = clampRange(raw.playlistPanelGlassBlur == null ? fxDefaults.playlistPanelGlassBlur : Number(raw.playlistPanelGlassBlur), 14, 60);
    var savedPlaylistPanelGlassDensity = clampRange(raw.playlistPanelGlassDensity == null ? fxDefaults.playlistPanelGlassDensity : Number(raw.playlistPanelGlassDensity), 0.55, 1);
    var savedPlaylistPanelOpenDuration = clampRange(raw.playlistPanelOpenDuration == null ? fxDefaults.playlistPanelOpenDuration : Number(raw.playlistPanelOpenDuration), 0.08, 0.72);
    var savedPlaylistPanelCloseDuration = clampRange(raw.playlistPanelCloseDuration == null ? fxDefaults.playlistPanelCloseDuration : Number(raw.playlistPanelCloseDuration), 0.06, 0.48);
    var savedBgMode = /^(cover|custom)$/.test(String(raw.backgroundColorMode || '')) ? String(raw.backgroundColorMode) : '';
    var savedBgCustom = savedBgMode
      ? savedBgMode === 'custom'
      : (raw.backgroundColorCustom === true || (raw.backgroundColorCustom !== false && savedBgColor !== '#000000') || savedBgOpacity < 1);
    var savedBgMedia = normalizeCustomBackgroundMedia(raw.backgroundMedia || raw.backgroundImage);
    var savedBgAlbumCover = raw.backgroundAlbumCover === true || !!(savedBgMedia && savedBgMedia.type === 'album');
    var desktopLyricsSchemaReady = raw.desktopLyricsSchema === 'desktop-lyrics-v3';
    var savedShelfCameraMode = normalizeShelfCameraMode(raw.shelfCameraMode || fxDefaults.shelfCameraMode);
    var savedShelfAngleManual = raw.shelfAngleYManual === true;
    var savedShelfAngle = savedShelfAngleManual
      ? clampRange(raw.shelfAngleY == null ? shelfDefaultAngleForCameraMode(savedShelfCameraMode) : Number(raw.shelfAngleY), -30, 30)
      : shelfDefaultAngleForCameraMode(savedShelfCameraMode);
    var savedShelfMode = /^(off|side|stage)$/.test(String(raw.shelf || '')) ? raw.shelf : fxDefaults.shelf;
    var savedShelfPresence = savedShelfMode === 'off' ? 'auto' : normalizeShelfPresence(raw.shelfPresence || fxDefaults.shelfPresence);
    var savedShelfPinnedOpen = savedShelfMode === 'side' && savedShelfPresence === 'always' && raw.shelfPinnedOpen === true;
    return {
      preset: savedPreset,
      intensity: layoutNumber(raw.intensity, fxDefaults.intensity, 0.2, 1.6),
      cinemaShake: layoutNumber(raw.cinemaShake, fxDefaults.cinemaShake, 0, 1.8),
      depth: layoutNumber(raw.depth, fxDefaults.depth, 0.2, 1.8),
      point: layoutNumber(raw.point, fxDefaults.point, 0.5, 2.2),
      speed: layoutNumber(raw.speed, fxDefaults.speed, 0.2, 2.5),
      twist: layoutNumber(raw.twist, fxDefaults.twist, 0, 0.6),
      color: layoutNumber(raw.color, fxDefaults.color, 0.5, 2.0),
      scatter: layoutNumber(raw.scatter, fxDefaults.scatter, 0, 0.5),
      bgFade: layoutNumber(raw.bgFade, fxDefaults.bgFade, 0, 1.2),
      bloomStrength: layoutNumber(raw.bloomStrength, fxDefaults.bloomStrength, 0, 1.6),
      lyricGlowStrength: layoutNumber(raw.lyricGlowStrength, fxDefaults.lyricGlowStrength, 0, 0.85),
      lyricBackgroundAdapt: layoutNumber(raw.lyricBackgroundAdapt, fxDefaults.lyricBackgroundAdapt, 0, 1),
      lyricScale: layoutNumber(raw.lyricScale, 1, 0.35, 1.65),
      lyricOffsetX: layoutNumber(raw.lyricOffsetX, 0, -4.0, 4.0),
      lyricOffsetY: layoutNumber(raw.lyricOffsetY, 0, -2.4, 2.7),
      lyricOffsetZ: layoutNumber(raw.lyricOffsetZ, 0, -3.2, 3.2),
      lyricTiltX: layoutNumber(raw.lyricTiltX, 0, -84, 84),
      lyricTiltY: layoutNumber(raw.lyricTiltY, 0, -84, 84),
      lyricCameraLock: !!raw.lyricCameraLock,
      lyricColorMode: raw.lyricColorMode === 'custom' ? 'custom' : 'auto',
      lyricColor: normalizeHexColor(raw.lyricColor || '#a9b8c8'),
      lyricHighlightMode: raw.lyricHighlightMode === 'custom' ? 'custom' : 'auto',
      lyricHighlightColor: normalizeHexColor(raw.lyricHighlightColor || '#fff0b8'),
      lyricGlowLinked: raw.lyricGlowLinked !== false,
      lyricGlowColor: normalizeHexColor(raw.lyricGlowColor || '#9db8cf'),
      lyricDisplayMode: normalizeSavedLyricDisplayMode(raw.lyricDisplayMode || fxDefaults.lyricDisplayMode),
      lyricTranslationMode: normalizeSavedLyricTranslationMode(raw.lyricTranslationMode || fxDefaults.lyricTranslationMode),
      lyricMotionStyle: normalizeSavedLyricMotionStyle(raw.lyricMotionStyle || fxDefaults.lyricMotionStyle),
      lyricVerticalFloat: raw.lyricVerticalFloat !== false,
      lyricCustomLineCount: layoutInteger(raw.lyricCustomLineCount, fxDefaults.lyricCustomLineCount, 1, 10),
      lyricGlitchCameraBind: !!raw.lyricGlitchCameraBind,
      lyricGlitchIntensity: layoutNumber(raw.lyricGlitchIntensity, fxDefaults.lyricGlitchIntensity, 0, 1.5),
      lyricGlitchSlice: layoutNumber(raw.lyricGlitchSlice, fxDefaults.lyricGlitchSlice, 0, 1.4),
      lyricGlitchChroma: layoutNumber(raw.lyricGlitchChroma, fxDefaults.lyricGlitchChroma, 0, 1.6),
      lyricGlitchRate: layoutNumber(raw.lyricGlitchRate, fxDefaults.lyricGlitchRate, 0.45, 2.2),
      lyricGlitchJitter: layoutNumber(raw.lyricGlitchJitter, fxDefaults.lyricGlitchJitter, 0, 1.8),
      lyricContextOpacity: layoutNumber(raw.lyricContextOpacity, fxDefaults.lyricContextOpacity, 0.25, 1),
      lyricContextSpread: layoutNumber(raw.lyricContextSpread, fxDefaults.lyricContextSpread, 0.60, 2.40),
      lyricTranslationGap: layoutNumber(raw.lyricTranslationGap, fxDefaults.lyricTranslationGap, 0.28, 2.20),
      lyricTranslationScale: layoutNumber(raw.lyricTranslationScale, fxDefaults.lyricTranslationScale, 0.46, 1.12),
      lyricTranslationOpacity: layoutNumber(raw.lyricTranslationOpacity, fxDefaults.lyricTranslationOpacity, 0.20, 1),
      lyricEdgeFade: layoutNumber(raw.lyricEdgeFade, fxDefaults.lyricEdgeFade, 0, 1),
      lyricMotionSoftness: layoutNumber(raw.lyricMotionSoftness, fxDefaults.lyricMotionSoftness, 0.15, 1.2),
      lyricFont: normalizeLyricFontKey(raw.lyricFont),
      lyricLetterSpacing: layoutNumber(raw.lyricLetterSpacing, 0, -0.04, 0.18),
      lyricLineHeight: layoutNumber(raw.lyricLineHeight, 1, 0.72, 1.80),
      lyricWeight: layoutInteger(raw.lyricWeight, 900, 500, 900),
      lyricTextureClarity: normalizeLyricTextureClarity(raw.lyricTextureClarity),
      lyricGlow: raw.lyricGlow !== false,
      lyricGlowBeat: raw.lyricGlowBeat !== false,
      lyricGlowParticles: !!raw.lyricGlowParticles,
      lyricVerticalFloat: raw.lyricVerticalFloat !== false,
      backgroundStarRiver: raw.backgroundStarRiver !== false,
      lyricPauseHold: raw.lyricPauseHold !== false,
      floatLayer: raw.floatLayer === true,
      cinema: raw.cinema !== false,
      // 缺键按 04-fx-defaults.js 的当前默认处理：bloom 默认关（=== true），edge 默认开（!== false）。
      // 写成同一个方向会让旧存档静默地拿到与默认相反的值。
      // A missing key falls back to the default in 04-fx-defaults.js: bloom defaults off (=== true),
      // edge defaults on (!== false). Forcing one direction silently inverts old saves.
      bloom: raw.bloom === true,
      edge: raw.edge !== false,
      aiDepth: raw.aiDepth === true,
      particleLyrics: raw.particleLyrics !== false,
      backCover: raw.backCover === true,
      visualTintMode: raw.visualTintMode === 'custom' ? 'custom' : 'auto',
      visualTintColor: normalizeHexColor(raw.visualTintColor || '#9db8cf'),
      uiAccentColor: normalizeHexColor(
        raw.uiAccentColor || fxDefaults.uiAccentColor || '#ffffff',
        fxDefaults.uiAccentColor || '#ffffff'
      ),
      homeAccentColor: normalizeHexColor(raw.homeAccentColor || '#00f5d4'),
      homeIconColor: normalizeHexColor(raw.homeIconColor || fxDefaults.homeIconColor || '#f4d28a', '#f4d28a'),
      visualIconColor: normalizeHexColor(raw.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff'),
      backgroundColorMode: savedBgCustom ? 'custom' : 'cover',
      backgroundColor: savedBgColor,
      backgroundOpacity: savedBgOpacity,
      windowBackgroundOpacity: savedWindowBgOpacity,
      backgroundGlassOpacity: savedBgGlassOpacity,
      controlGlassChromaticOffset: savedGlassOffset,
      playlistPanelGlassBlur: savedPlaylistPanelGlassBlur,
      playlistPanelGlassDensity: savedPlaylistPanelGlassDensity,
      playlistPanelOpenDuration: savedPlaylistPanelOpenDuration,
      playlistPanelCloseDuration: savedPlaylistPanelCloseDuration,
      backgroundColorCustom: savedBgCustom,
      backgroundImage: savedBgAlbumCover ? '' : normalizeCustomBackgroundImage(raw.backgroundImage),
      backgroundMedia: savedBgAlbumCover ? null : savedBgMedia,
      backgroundAlbumCover: savedBgAlbumCover,
      backgroundMediaCropX: savedBgCropX,
      backgroundMediaCropY: savedBgCropY,
      backgroundMediaZoom: savedBgZoom,
      desktopLyrics: raw.desktopLyrics === true,
      desktopLyricsSize: clampRange(Number(raw.desktopLyricsSize) || fxDefaults.desktopLyricsSize, 0.72, 1.55),
      desktopLyricsOpacity: clampRange(raw.desktopLyricsOpacity == null ? fxDefaults.desktopLyricsOpacity : Number(raw.desktopLyricsOpacity), 0.28, 1),
      desktopLyricsY: clampRange(raw.desktopLyricsY == null ? fxDefaults.desktopLyricsY : Number(raw.desktopLyricsY), 0.08, 0.92),
      desktopLyricsClickThrough: desktopLyricsSchemaReady ? raw.desktopLyricsClickThrough === true : fxDefaults.desktopLyricsClickThrough,
      desktopLyricsCinema: desktopLyricsSchemaReady ? raw.desktopLyricsCinema !== false : fxDefaults.desktopLyricsCinema,
      desktopLyricsHighlight: desktopLyricsSchemaReady ? raw.desktopLyricsHighlight === true : fxDefaults.desktopLyricsHighlight,
      desktopLyricsFps: desktopLyricsSchemaReady ? normalizeDesktopLyricsFps(raw.desktopLyricsFps) : fxDefaults.desktopLyricsFps,
      performanceBackground: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true),
      performanceQuality: normalizePerformanceQuality(raw.performanceQuality),
      foregroundFpsMode: normalizeForegroundFpsMode(raw.foregroundFpsMode === 'adaptive' ? 'vsync' : raw.foregroundFpsMode),
      memoryAutoTrimApp: raw.memoryAutoTrimApp !== false,
      memoryAutoTrimOnBackground: raw.memoryAutoTrimOnBackground !== false,
      memoryAutoSystemTrim: raw.memoryAutoSystemTrim === true,
      memorySystemAutoElevate: raw.memorySystemAutoElevate === true,
      memorySystemIntervalMin: clampRange(Math.round(raw.memorySystemIntervalMin == null ? fxDefaults.memorySystemIntervalMin : Number(raw.memorySystemIntervalMin)), 5, 180),
      memorySystemThresholdPercent: clampRange(Math.round(raw.memorySystemThresholdPercent == null ? fxDefaults.memorySystemThresholdPercent : Number(raw.memorySystemThresholdPercent)), 50, 98),
      memorySystemMask: clampRange(Math.round(raw.memorySystemMask == null ? fxDefaults.memorySystemMask : Number(raw.memorySystemMask)), 1, 29),
      memorySafetyRevision: Number(raw.memorySafetyRevision) || 0,
      liveBackgroundKeep: normalizePerformanceBackgroundMode(raw.performanceBackground, raw.liveBackgroundKeep === true) === 'keep',
      // 只认显式 true：旧存档缺这个键时必须落回「关闭」。别顺手改成 `!== false`——
      // 那会让所有历史存档在升级后自动开启节奏分析。
      // Explicit true only: an older archive without this key must fall back to off. Do not
      // "fix" it to `!== false`; that would switch analysis on for every legacy archive.
      beatAnalysis: raw.beatAnalysis === true,
      sonicGroundAmplitude: clampRange(raw.sonicGroundAmplitude == null ? fxDefaults.sonicGroundAmplitude : Number(raw.sonicGroundAmplitude), 0, 100),
      sonicGroundMotionSpeed: clampRange(raw.sonicGroundMotionSpeed == null ? fxDefaults.sonicGroundMotionSpeed : Number(raw.sonicGroundMotionSpeed), 0, 100),
      sonicGroundDensity: clampRange(raw.sonicGroundDensity == null ? fxDefaults.sonicGroundDensity : Number(raw.sonicGroundDensity), 0, 100),
      sonicGroundRange: clampRange(raw.sonicGroundRange == null ? fxDefaults.sonicGroundRange : Number(raw.sonicGroundRange), 0, 100),
      sonicGroundLower: clampRange(raw.sonicGroundLower == null ? fxDefaults.sonicGroundLower : Number(raw.sonicGroundLower), 0, 100),
      sonicGroundDepth: clampRange(raw.sonicGroundDepth == null ? fxDefaults.sonicGroundDepth : Number(raw.sonicGroundDepth), 0, 100),
      sonicGroundAutoRotate: clampRange(raw.sonicGroundAutoRotate == null ? fxDefaults.sonicGroundAutoRotate : Number(raw.sonicGroundAutoRotate), 0, 100),
      sonicGroundColorMode: raw.sonicGroundColorMode === 'custom' ? 'custom' : 'cover',
      sonicGroundBaseColor: normalizeHexColor(raw.sonicGroundBaseColor || fxDefaults.sonicGroundBaseColor, fxDefaults.sonicGroundBaseColor),
      sonicGroundCoolColor: normalizeHexColor(raw.sonicGroundCoolColor || fxDefaults.sonicGroundCoolColor, fxDefaults.sonicGroundCoolColor),
      sonicGroundWarmColor: normalizeHexColor(raw.sonicGroundWarmColor || fxDefaults.sonicGroundWarmColor, fxDefaults.sonicGroundWarmColor),
      sonicGroundAccentColor: normalizeHexColor(raw.sonicGroundAccentColor || fxDefaults.sonicGroundAccentColor, fxDefaults.sonicGroundAccentColor),
      sonicGroundGlow: clampRange(raw.sonicGroundGlow == null ? fxDefaults.sonicGroundGlow : Number(raw.sonicGroundGlow), 0, 100),
      sonicGroundSubBass: clampRange(raw.sonicGroundSubBass == null ? fxDefaults.sonicGroundSubBass : Number(raw.sonicGroundSubBass), 0, 100),
      sonicGroundBass: clampRange(raw.sonicGroundBass == null ? fxDefaults.sonicGroundBass : Number(raw.sonicGroundBass), 0, 100),
      sonicGroundLowMid: clampRange(raw.sonicGroundLowMid == null ? fxDefaults.sonicGroundLowMid : Number(raw.sonicGroundLowMid), 0, 100),
      sonicGroundMid: clampRange(raw.sonicGroundMid == null ? fxDefaults.sonicGroundMid : Number(raw.sonicGroundMid), 0, 100),
      sonicGroundHighMid: clampRange(raw.sonicGroundHighMid == null ? fxDefaults.sonicGroundHighMid : Number(raw.sonicGroundHighMid), 0, 100),
      sonicGroundPresence: clampRange(raw.sonicGroundPresence == null ? fxDefaults.sonicGroundPresence : Number(raw.sonicGroundPresence), 0, 100),
      sonicGroundBrilliance: clampRange(raw.sonicGroundBrilliance == null ? fxDefaults.sonicGroundBrilliance : Number(raw.sonicGroundBrilliance), 0, 100),
      sonicGroundAir: clampRange(raw.sonicGroundAir == null ? fxDefaults.sonicGroundAir : Number(raw.sonicGroundAir), 0, 100),
      sonicGroundFloatingEnabled: raw.sonicGroundFloatingEnabled !== false,
      sonicGroundFloatingIntensity: clampRange(raw.sonicGroundFloatingIntensity == null ? fxDefaults.sonicGroundFloatingIntensity : Number(raw.sonicGroundFloatingIntensity), 0, 100),
      sonicGroundFloatingMinSize: clampRange(raw.sonicGroundFloatingMinSize == null ? fxDefaults.sonicGroundFloatingMinSize : Number(raw.sonicGroundFloatingMinSize), 0, 100),
      sonicGroundFloatingMaxSize: clampRange(raw.sonicGroundFloatingMaxSize == null ? fxDefaults.sonicGroundFloatingMaxSize : Number(raw.sonicGroundFloatingMaxSize), 0, 100),
      sonicGroundFloatingSpeed: clampRange(raw.sonicGroundFloatingSpeed == null ? fxDefaults.sonicGroundFloatingSpeed : Number(raw.sonicGroundFloatingSpeed), 0, 100),
      sonicGroundFloatingCount: clampRange(raw.sonicGroundFloatingCount == null ? fxDefaults.sonicGroundFloatingCount : Number(raw.sonicGroundFloatingCount), 0, 100),
      sonicAudioMonitorEnabled: raw.sonicAudioMonitorEnabled !== false,
      sonicAudioAutoTrack: raw.sonicAudioAutoTrack !== false,
      sonicAudioSensitivity: clampRange(raw.sonicAudioSensitivity == null ? fxDefaults.sonicAudioSensitivity : Number(raw.sonicAudioSensitivity), 0, 100),
      sonicAudioBandStart: clampRange(raw.sonicAudioBandStart == null ? fxDefaults.sonicAudioBandStart : Number(raw.sonicAudioBandStart), 0, 510),
      sonicAudioBandEnd: clampRange(raw.sonicAudioBandEnd == null ? fxDefaults.sonicAudioBandEnd : Number(raw.sonicAudioBandEnd), 2, 512),
      sonicAudioThreshold: clampRange(raw.sonicAudioThreshold == null ? fxDefaults.sonicAudioThreshold : Number(raw.sonicAudioThreshold), 0, 100),
      sonicAudioPulseStrength: clampRange(raw.sonicAudioPulseStrength == null ? fxDefaults.sonicAudioPulseStrength : Number(raw.sonicAudioPulseStrength), 0, 100),
      sonicWorkshopInputGain: clampRange(raw.sonicWorkshopInputGain == null ? fxDefaults.sonicWorkshopInputGain : Number(raw.sonicWorkshopInputGain), 40, 100),
      sonicWorkshopAudioIntensity: clampRange(raw.sonicWorkshopAudioIntensity == null ? fxDefaults.sonicWorkshopAudioIntensity : Number(raw.sonicWorkshopAudioIntensity), 0.3, 2.5),
      sonicWorkshopResponseRange: clampRange(raw.sonicWorkshopResponseRange == null ? fxDefaults.sonicWorkshopResponseRange : Number(raw.sonicWorkshopResponseRange), 0.3, 2),
      sonicWorkshopPeakIntensity: clampRange(raw.sonicWorkshopPeakIntensity == null ? fxDefaults.sonicWorkshopPeakIntensity : Number(raw.sonicWorkshopPeakIntensity), 0, 1.4),
      sonicWorkshopColorMode: raw.sonicWorkshopColorMode === 'custom' ? 'custom' : 'cover',
      sonicWorkshopTheme: /^(coral-mirage|ocean-deep|arctic-blue|arctic-aurora|emerald-forest|cyber-forest|minimal-mono|minimal-monochrome|neon-tokyo|golden-hour|ember-fire|crimson|crimson-sunset|aurora|violet-dream)$/.test(String(raw.sonicWorkshopTheme || '')) ? raw.sonicWorkshopTheme : fxDefaults.sonicWorkshopTheme,
      sonicWorkshopCustomColor: normalizeHexColor(raw.sonicWorkshopCustomColor || fxDefaults.sonicWorkshopCustomColor || '#cb6c89', fxDefaults.sonicWorkshopCustomColor || '#cb6c89'),
      sonicWorkshopBaseColorMode: raw.sonicWorkshopBaseColorMode === 'custom' ? 'custom' : 'cover',
      sonicWorkshopBaseColor: normalizeHexColor(raw.sonicWorkshopBaseColor || fxDefaults.sonicWorkshopBaseColor || '#16060f', fxDefaults.sonicWorkshopBaseColor || '#16060f'),
      sonicWorkshopWarmColorMode: raw.sonicWorkshopWarmColorMode === 'custom' ? 'custom' : 'cover',
      sonicWorkshopWarmColor: normalizeHexColor(raw.sonicWorkshopWarmColor || fxDefaults.sonicWorkshopWarmColor || '#cb6c89', fxDefaults.sonicWorkshopWarmColor || '#cb6c89'),
      sonicWorkshopCoolColorMode: raw.sonicWorkshopCoolColorMode === 'custom' ? 'custom' : 'cover',
      sonicWorkshopCoolColor: normalizeHexColor(raw.sonicWorkshopCoolColor || fxDefaults.sonicWorkshopCoolColor || '#99c4ff', fxDefaults.sonicWorkshopCoolColor || '#99c4ff'),
      sonicWorkshopRippleColorMode: raw.sonicWorkshopRippleColorMode === 'custom' ? 'custom' : 'cover',
      sonicWorkshopRippleColor: normalizeHexColor(raw.sonicWorkshopRippleColor || fxDefaults.sonicWorkshopRippleColor || '#f8d8ff', fxDefaults.sonicWorkshopRippleColor || '#f8d8ff'),
      sonicWorkshopPeakColorMode: raw.sonicWorkshopPeakColorMode === 'custom' ? 'custom' : 'cover',
      sonicWorkshopPeakColor: normalizeHexColor(raw.sonicWorkshopPeakColor || fxDefaults.sonicWorkshopPeakColor || '#99c4ff', fxDefaults.sonicWorkshopPeakColor || '#99c4ff'),
      wallpaperMode: false,
      wallpaperOpacity: clampRange(raw.wallpaperOpacity == null ? fxDefaults.wallpaperOpacity : Number(raw.wallpaperOpacity), 0.35, 1),
      wallpaperFps: normalizeWallpaperFps(raw.wallpaperFps),
      wallpaperEngineSilentWindows: raw.wallpaperEngineSilentWindows !== false,
      windowsGameMode: raw.windowsGameMode === true,
      wallpaperEngineGlassSampler: raw.wallpaperEngineGlassSampler == null
        ? wallpaperEngineBorderlessCaptureSupported() : raw.wallpaperEngineGlassSampler !== false,
      coverResolution: normalizeCoverResolution(raw.coverResolution),
      shelf: savedShelfMode,
      shelfPinnedOpen: savedShelfPinnedOpen,
      shelfCameraMode: savedShelfCameraMode,
      shelfPresence: savedShelfPresence,
      shelfShowPodcasts: raw.shelfShowPodcasts !== false,
      shelfMergeCollections: raw.shelfMergeCollections === true,
      shelfSize: clampRange(raw.shelfSize == null ? fxDefaults.shelfSize : Number(raw.shelfSize), 0.65, 1.45),
      shelfOffsetX: clampRange(raw.shelfOffsetX == null ? fxDefaults.shelfOffsetX : Number(raw.shelfOffsetX), -1.2, 1.2),
      shelfOffsetY: clampRange(raw.shelfOffsetY == null ? fxDefaults.shelfOffsetY : Number(raw.shelfOffsetY), -0.9, 0.9),
      shelfOffsetZ: clampRange(raw.shelfOffsetZ == null ? fxDefaults.shelfOffsetZ : Number(raw.shelfOffsetZ), -0.9, 0.9),
      shelfAngleY: savedShelfAngle,
      shelfAngleYManual: savedShelfAngleManual,
      shelfOpacity: clampRange(raw.shelfOpacity == null ? fxDefaults.shelfOpacity : Number(raw.shelfOpacity), 0.25, 1),
      shelfBgOpacity: clampRange(raw.shelfBgOpacity == null ? fxDefaults.shelfBgOpacity : Number(raw.shelfBgOpacity), 0.25, 0.98),
      shelfAccentColor: normalizeHexColor(raw.shelfAccentColor || fxDefaults.shelfAccentColor, fxDefaults.shelfAccentColor),
      shelfDetailOffsetX: clampRange(raw.shelfDetailOffsetX == null ? fxDefaults.shelfDetailOffsetX : Number(raw.shelfDetailOffsetX), -4.8, 4.8),
      shelfDetailOffsetY: clampRange(raw.shelfDetailOffsetY == null ? fxDefaults.shelfDetailOffsetY : Number(raw.shelfDetailOffsetY), -3.6, 3.6),
      shelfDetailOffsetZ: clampRange(raw.shelfDetailOffsetZ == null ? fxDefaults.shelfDetailOffsetZ : Number(raw.shelfDetailOffsetZ), -3.6, 3.6),
      shelfDetailScale: clampRange(raw.shelfDetailScale == null ? fxDefaults.shelfDetailScale : Number(raw.shelfDetailScale), 0.72, 1.35),
      shelfDetailAngleX: clampRange(raw.shelfDetailAngleX == null ? fxDefaults.shelfDetailAngleX : Number(raw.shelfDetailAngleX), -24, 24),
      shelfDetailAngleY: clampRange(raw.shelfDetailAngleY == null ? fxDefaults.shelfDetailAngleY : Number(raw.shelfDetailAngleY), -28, 28),
      shelfDetailRowGap: clampRange(raw.shelfDetailRowGap == null ? fxDefaults.shelfDetailRowGap : Number(raw.shelfDetailRowGap), 0.72, 1.32),
      shelfDetailOpenDuration: clampRange(raw.shelfDetailOpenDuration == null ? fxDefaults.shelfDetailOpenDuration : Number(raw.shelfDetailOpenDuration), 0.12, 1.2),
      shelfDetailCloseDuration: clampRange(raw.shelfDetailCloseDuration == null ? fxDefaults.shelfDetailCloseDuration : Number(raw.shelfDetailCloseDuration), 0.08, 0.8),
      shelfDetailRowDuration: clampRange(raw.shelfDetailRowDuration == null ? fxDefaults.shelfDetailRowDuration : Number(raw.shelfDetailRowDuration), 0.16, 1.6),
      shelfDetailIntroStrength: clampRange(raw.shelfDetailIntroStrength == null ? fxDefaults.shelfDetailIntroStrength : Number(raw.shelfDetailIntroStrength), 0, 1.8),
      shelfDetailParallax: clampRange(raw.shelfDetailParallax == null ? fxDefaults.shelfDetailParallax : Number(raw.shelfDetailParallax), 0, 1.8),
      shelfSummonOpenDuration: clampRange(raw.shelfSummonOpenDuration == null ? fxDefaults.shelfSummonOpenDuration : Number(raw.shelfSummonOpenDuration), 0.08, 2),
      shelfSummonCloseDuration: clampRange(raw.shelfSummonCloseDuration == null ? fxDefaults.shelfSummonCloseDuration : Number(raw.shelfSummonCloseDuration), 0.08, 1.6),
      shelfSummonSlide: clampRange(raw.shelfSummonSlide == null ? fxDefaults.shelfSummonSlide : Number(raw.shelfSummonSlide), 0, 4),
      shelfSummonStagger: clampRange(raw.shelfSummonStagger == null ? fxDefaults.shelfSummonStagger : Number(raw.shelfSummonStagger), 0, 3),
      shelfSummonScale: clampRange(raw.shelfSummonScale == null ? fxDefaults.shelfSummonScale : Number(raw.shelfSummonScale), 0, 3),
      shelfSummonParallax: clampRange(raw.shelfSummonParallax == null ? fxDefaults.shelfSummonParallax : Number(raw.shelfSummonParallax), 0, 2.5),
      shelfCameraEnterSpeed: clampRange(raw.shelfCameraEnterSpeed == null ? fxDefaults.shelfCameraEnterSpeed : Number(raw.shelfCameraEnterSpeed), 0.2, 1.5),
      shelfCameraExitSpeed: clampRange(raw.shelfCameraExitSpeed == null ? fxDefaults.shelfCameraExitSpeed : Number(raw.shelfCameraExitSpeed), 0.2, 1.5),
      cam: /^(off|gesture)$/.test(String(raw.cam || '')) ? raw.cam : fxDefaults.cam,
      gesturePlayerActions: raw.gesturePlayerActions !== false,
      gestureHandOverlay: raw.gestureHandOverlay !== false,
      gestureSensitivity: /^(steady|balanced|quick)$/.test(String(raw.gestureSensitivity || '')) ? raw.gestureSensitivity : fxDefaults.gestureSensitivity
    };
  } catch (e) {
    return readSavedLyricLayoutCriticalFallback(raw, e);
  }
}

// ── 以下归一化随读取层一起前移 ───────────────────────────────────────────────

// 它们原本分别在 02-visual/04（shelf / 桌面歌词）、02-visual/05（字体 key）、02-visual/06

// （自定义背景媒体）。共同点：纯函数、只依赖 fxDefaults 与已就绪的全局状态，没有任何运行时

// 依赖——所以可以安全地排在所有消费者之前。

// Moved down from 02-visual/04, /05 and /06: pure normalisers with no runtime dependency, which is

// what makes it safe to run them before every consumer.


function normalizeDesktopLyricsFps(value) {
  var n = Number(value);
  if (!isFinite(n) || n <= 0) return 0;
  if (n <= 26) return 24;
  if (n <= 45) return 30;
  if (n <= 90) return 60;
  return 120;
}
function normalizeShelfCameraMode(value) {
  return String(value || '') === 'static' ? 'static' : 'dynamic';
}
function shelfDefaultAngleForCameraMode(mode) {
  return normalizeShelfCameraMode(mode) === 'static' ? -15 : 0;
}

function normalizeShelfPresence(value) {
  return String(value || '') === 'always' ? 'always' : 'auto';
}

// 字体 key 归一化（原 02-visual/05）。customLyricFonts 由 00-core-stores 填好，所以这里读到的一定是最新表。

// Lyric font key normalisation (from 02-visual/05); customLyricFonts is already populated by 00-core-stores.
function builtinLyricFontKeyPattern() {
  return /^(sans|hei|song|bold-song|stone-song|kai-song|serif-en|gothic|editorial|humanist|round|mono|display)$/;
}

function customLyricFontIdFromKey(key) {
  var match = /^custom:([a-z0-9_-]{1,32})$/i.exec(String(key || ''));
  return match ? match[1] : '';
}
function customLyricFontRecordForKey(key) {
  var id = customLyricFontIdFromKey(key);
  if (!id || !Array.isArray(customLyricFonts)) return null;
  for (var i = 0; i < customLyricFonts.length; i++) {
    if (customLyricFonts[i] && customLyricFonts[i].id === id) return customLyricFonts[i];
  }
  return null;
}

function normalizeLyricFontKey(value) {
  value = String(value || 'sans');
  if (builtinLyricFontKeyPattern().test(value)) return value;
  if (customLyricFontRecordForKey(value)) return value;
  return 'sans';
}

// 自定义背景媒体归一化（原 02-visual/06）。纯正则，无外部依赖。

// Custom background media normalisation (from 02-visual/06): pure regex, no external dependency.
function normalizeCustomBackgroundImage(value) {
  var src = String(value || '').trim();
  if (!src) return '';
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(src)) return src;
  if (/^https?:\/\//i.test(src)) return src;
  return '';
}
function normalizeCustomBackgroundMedia(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    var img = normalizeCustomBackgroundImage(value);
    if (img) return { type: 'image', src: img };
    if (/^data:video\/(mp4|webm|quicktime);base64,/i.test(value) || /^https?:\/\//i.test(value)) return { type: 'video', src: String(value) };
    return null;
  }
  if (typeof value !== 'object') return null;
  if (value.type === 'album' || value.type === 'cover') return { type: 'album' };
  var type = value.type === 'video' ? 'video' : (value.type === 'image' ? 'image' : '');
  if (type === 'image') {
    var imageSrc = normalizeCustomBackgroundImage(value.src || value.url || '');
    return imageSrc ? { type: 'image', src: imageSrc } : null;
  }
  if (type === 'video') {
    var src = String(value.src || '').trim();
    var id = String(value.id || '').trim();
    if (!id && !/^data:video\/(mp4|webm|quicktime);base64,/i.test(src) && !/^https?:\/\//i.test(src)) return null;
    return {
      type: 'video',
      id: id,
      src: src,
      name: String(value.name || '').slice(0, 120),
      mime: String(value.mime || '').slice(0, 80),
      size: Math.max(0, Number(value.size) || 0)
    };
  }
  return null;
}
