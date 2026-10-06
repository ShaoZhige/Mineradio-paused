// 本模块界面文案统一走 i18n；词典是唯一文案来源，缺键时退回内置中文模板。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：xxxText('key') 缺键返回键名；xxxText('key', '兜底') 显式指定缺键时显示什么；
// xxxText('key', '含 {p} 的模板', {p: v}) 带插值，params 同时喂给 t() 与兜底模板。
// Two call shapes: key-only shows the bare key on a miss; an explicit fallback says what to
// show instead; params interpolate into both the dictionary hit and the fallback template.
function packagedFxArchiveText(key, fallback, params) {
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

// 必须写成函数，不能是顶层常量：本模块在解析期求值，而词典是异步 fetch 的，
// 那时 packagedFxArchiveText() 缺键会返回键名本身，于是 preset_default_test 这个键名
// 会被写进存档名并持久化到 localStorage。含取词调用的顶层数据一律用函数。
// This must be a function, not a top-level constant: the module is evaluated during parse while
// the dictionary is still being fetched, so a missing key returns the key itself and the bare
// "preset_default_test" used to be persisted as the archive name.
function packagedDefaultUserFxArchiveName() {
  return packagedFxArchiveText('preset_default_test');
}
var PACKAGED_DEFAULT_USER_FX_ARCHIVE_EXPORTED_AT = 1784607916226;
var PACKAGED_DEFAULT_USER_FX_ARCHIVE_SAVED_AT = 1784607916226;
// Keep the packaged first-launch snapshot sourced from the runtime defaults so
// newly added settings cannot silently drift between the two default paths.
var PACKAGED_DEFAULT_FX_SNAPSHOT = Object.freeze(Object.assign({
  visualPresetSchema: VISUAL_PRESET_SCHEMA
}, fxDefaults));
function clonePackagedDefaultFxSnapshot() {
  return Object.assign({}, PACKAGED_DEFAULT_FX_SNAPSHOT);
}
function packagedDefaultLyricLayoutRaw() {
  return Object.assign({ desktopLyricsSchema: 'desktop-lyrics-v3' }, clonePackagedDefaultFxSnapshot(), {
    // 首次启动的 raw 直接带上本机判定结果，避免 Win10 从打包快照继承到开启态而画出捕获黄框。
    wallpaperEngineGlassSampler: wallpaperEngineBorderlessCaptureSupported()
  });
}
