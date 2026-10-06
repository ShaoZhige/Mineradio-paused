var DEVELOPMENT_LOCKED_FX = {};
function isDevelopmentLockedFx(key) {
  return !!DEVELOPMENT_LOCKED_FX[key];
}
function normalizeDevelopmentLockedFxState() {
  if (!fx) return;
  Object.keys(DEVELOPMENT_LOCKED_FX).forEach(function (key) {
    if (DEVELOPMENT_LOCKED_FX[key]) fx[key] = false;
  });
}
function readSavedPlaybackVisualPreset() {
  try {
    var raw = readCurrentFxAutosaveRaw();
    if (!Object.prototype.hasOwnProperty.call(raw, 'preset')) return fxDefaults.preset;
    var savedPreset = clampRange(Number(raw.preset) || 0, 0, MAX_VISUAL_PRESET_INDEX);
    if (savedPreset === 3 && raw.visualPresetSchema !== VISUAL_PRESET_SCHEMA) savedPreset = 5;
    return savedPreset;
  } catch (e) {
    return fxDefaults.preset;
  }
}
var playbackVisualPreset = readSavedPlaybackVisualPreset();
var startupVisualPreviewActive = false;
var fx = Object.assign({}, fxDefaults, readSavedLyricLayout());
normalizeDevelopmentLockedFxState();
// 自动节奏分析的总开关（设置项见 fxDefaults.beatAnalysis）。判据只认显式 true：读旧存档或别人
// 的分享码时这个键可能不存在，缺键必须落回「关闭」——写成 `!== false` 会让缺键变成开启，
// 「默认关闭」就名存实亡。放在这里是因为它读的 fx 就在上面，且本模块早于 03-beat 加载。
// The master predicate for automatic beat analysis. Only an explicit true counts: the key can be
// absent when loading an older archive or someone else's share code, and a missing key must fall
// back to off — `!== false` would silently turn the default off-switch into an on-switch. It lives
// here because fx is declared above and this module loads before 03-beat.
function beatAnalysisEnabled() {
  return !!(typeof fx !== 'undefined' && fx && fx.beatAnalysis === true);
}
function clampPlaylistPanelFxSettings() {
  if (!fx) return;
  fx.playlistPanelGlassBlur = Math.round(clampRange(fx.playlistPanelGlassBlur == null ? fxDefaults.playlistPanelGlassBlur : Number(fx.playlistPanelGlassBlur), 14, 60));
  fx.playlistPanelGlassDensity = clampRange(fx.playlistPanelGlassDensity == null ? fxDefaults.playlistPanelGlassDensity : Number(fx.playlistPanelGlassDensity), 0.55, 1);
  fx.playlistPanelOpenDuration = clampRange(fx.playlistPanelOpenDuration == null ? fxDefaults.playlistPanelOpenDuration : Number(fx.playlistPanelOpenDuration), 0.08, 0.72);
  fx.playlistPanelCloseDuration = clampRange(fx.playlistPanelCloseDuration == null ? fxDefaults.playlistPanelCloseDuration : Number(fx.playlistPanelCloseDuration), 0.06, 0.48);
}
function playlistPanelAlphaVars(density) {
  density = clampRange(Number(density) || fxDefaults.playlistPanelGlassDensity, 0.55, 1);
  return {
    sticky1: clampRange(0.52 + density * 0.46, 0.55, 0.98),
    sticky2: clampRange(0.46 + density * 0.48, 0.50, 0.94),
    sticky3: clampRange(0.28 + density * 0.56, 0.36, 0.84),
    toolbar1: clampRange(0.48 + density * 0.46, 0.52, 0.94),
    toolbar2: clampRange(0.42 + density * 0.46, 0.46, 0.88),
    toolbar3: clampRange(0.24 + density * 0.48, 0.30, 0.74)
  };
}
function setPlaylistPanelCssVar(name, value) {
  document.documentElement.style.setProperty(name, value);
  var panel = document.getElementById('playlist-panel');
  if (panel) panel.style.setProperty(name, value);
}
function applyPlaylistPanelFxSettings() {
  clampPlaylistPanelFxSettings();
  var blur = fx && isFinite(fx.playlistPanelGlassBlur) ? fx.playlistPanelGlassBlur : fxDefaults.playlistPanelGlassBlur;
  var density = fx && isFinite(fx.playlistPanelGlassDensity) ? fx.playlistPanelGlassDensity : fxDefaults.playlistPanelGlassDensity;
  var openMs = Math.round((fx && isFinite(fx.playlistPanelOpenDuration) ? fx.playlistPanelOpenDuration : fxDefaults.playlistPanelOpenDuration) * 1000);
  var closeMs = Math.round((fx && isFinite(fx.playlistPanelCloseDuration) ? fx.playlistPanelCloseDuration : fxDefaults.playlistPanelCloseDuration) * 1000);
  var alphas = playlistPanelAlphaVars(density);
  setPlaylistPanelCssVar('--mineradio-playlist-panel-open-ms', openMs + 'ms');
  setPlaylistPanelCssVar('--mineradio-playlist-panel-close-ms', closeMs + 'ms');
  setPlaylistPanelCssVar('--playlist-panel-open-ms', openMs + 'ms');
  setPlaylistPanelCssVar('--playlist-panel-close-ms', closeMs + 'ms');
  setPlaylistPanelCssVar('--playlist-sticky-blur', blur + 'px');
  setPlaylistPanelCssVar('--playlist-toolbar-blur', Math.round(clampRange(blur * 0.74, 12, 46)) + 'px');
  setPlaylistPanelCssVar('--playlist-sticky-a1', alphas.sticky1.toFixed(3));
  setPlaylistPanelCssVar('--playlist-sticky-a2', alphas.sticky2.toFixed(3));
  setPlaylistPanelCssVar('--playlist-sticky-a3', alphas.sticky3.toFixed(3));
  setPlaylistPanelCssVar('--playlist-toolbar-a1', alphas.toolbar1.toFixed(3));
  setPlaylistPanelCssVar('--playlist-toolbar-a2', alphas.toolbar2.toFixed(3));
  setPlaylistPanelCssVar('--playlist-toolbar-a3', alphas.toolbar3.toFixed(3));
}
applyPlaylistPanelFxSettings();
