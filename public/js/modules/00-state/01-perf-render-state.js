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
function perfRenderStateText(key, fallback, params) {
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
function markAppPerf(name) {
  try {
    var value = performance.now();
    appPerfMarks.push({ name: name, value: Math.round(value) });
    if (performance && performance.mark) performance.mark('mineradio:' + name);
    if (appPerfMarks.length <= 16) console.debug('[MineradioPerf]', name, Math.round(value) + 'ms');
  } catch (e) { }
}
markAppPerf('script-start');
function installStartupLongTaskObserver() {
  try {
    if (!('PerformanceObserver' in window)) return;
    var observer = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.startTime > 15000) return;
        console.debug('[MineradioPerf] longtask', Math.round(entry.startTime) + 'ms', Math.round(entry.duration) + 'ms');
      });
    });
    observer.observe({ entryTypes: ['longtask'] });
    setTimeout(function () { try { observer.disconnect(); } catch (e) { } }, 16000);
  } catch (e) { }
}
installStartupLongTaskObserver();
var queueViewTab = readPlaylistPanelTabPreference(), playMode = 'loop', miniQueueOpen = false;
var miniQueueRenderSeq = 0, queueRenderSeq = 0, playlistRenderSeq = 0;
var queuePanelDirty = false;
var PLAYLIST_LAZY_BATCH_SIZE = 48;
var QUEUE_PANEL_BATCH_SIZE = PLAYLIST_LAZY_BATCH_SIZE;
var QUEUE_VIRTUAL_ROW_STEP = 62;
var QUEUE_VIRTUAL_OVERSCAN = 8;
var queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
var queuePanelRenderKey = '';
var queuePanelVirtualState = { start: -1, end: -1, miniStart: -1, miniEnd: -1, raf: 0 };
var miniQueueLazyBound = false;
var PLAYLIST_PANEL_BATCH_SIZE = PLAYLIST_LAZY_BATCH_SIZE;
var PLAYLIST_CATALOG_FIRST_PAGE_SIZE = PLAYLIST_LAZY_BATCH_SIZE;
var PLAYLIST_CATALOG_BACKGROUND_PAGE_SIZE = 200;
var PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX = 760;
var playlistPanelRenderLimit = PLAYLIST_PANEL_BATCH_SIZE;
var playlistPanelLazyBound = false;
var PLAYLIST_DETAIL_INITIAL_RENDER = PLAYLIST_LAZY_BATCH_SIZE;
var PLAYLIST_DETAIL_BATCH_SIZE = PLAYLIST_LAZY_BATCH_SIZE;
var PLAYLIST_DETAIL_ROW_STEP = 56;
var PLAYLIST_DETAIL_VIRTUAL_OVERSCAN = 7;
var PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT = 142;
var PLAYLIST_DETAIL_OUTER_FOOTER_HEIGHT = 44;
var PLAYLIST_QUEUE_INITIAL_BATCH_SIZE = 96;
var PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE = 160;
var PLAYLIST_QUEUE_PLAYBACK_AHEAD_THRESHOLD = 96;
var playlistCatalogSyncState = { token: 0, loading: false, timer: 0, providers: {}, error: '' };
var playlistCatalogRevision = 0;
var smoothWheelScrollBound = false;
var coverProcessToken = 0, aiDepthPipeline = null, aiDepthReady = false, aiDepthBusy = false, aiDepthFailUntil = 0;
var coverDepthCache = Object.create(null), coverDepthCacheKeys = [];
var aiDepthLastRunAt = 0, aiDepthMinGapMs = 18000;
// 文案不能在上面的对象字面量里直接求值：词典是异步加载的，顶层求值会把键名固化。
// 这里的 hero / notes 是**可变的运行时状态**（对象本身还有 visible/progress 等字段），
// 不能整体改成函数，所以把文案单独收进 updatePreviewTexts()，由 refreshUpdatePreviewText()
// 在词典就绪与语言切换时重贴。
// The copy must not be evaluated inside the object literal above: the dictionary loads
// asynchronously, so a top-level evaluation freezes the key names. These strings are part of
// mutable runtime state (the same object also carries visible/progress), so the object cannot
// simply become a function — the copy lives in updatePreviewTexts() and is re-stamped by
// refreshUpdatePreviewText() once the dictionary is ready and on every language switch.
function updatePreviewTexts() {
  return {
    hero: perfRenderStateText('already_latest', '当前版本已是最新。'),
    notes: [
      perfRenderStateText('perf_note_use_latest_link'),
      perfRenderStateText('perf_note_improve_api_playlists')
    ]
  };
}
function refreshUpdatePreviewText() {
  var t = updatePreviewTexts();
  updatePreviewState.hero = t.hero;
  updatePreviewState.notes = t.notes;
}
var updatePreviewState = {
  visible: false,
  open: false,
  status: 'idle',
  progress: 0,
  currentVersion: '2.2.0',
  version: '2.2.0',
  configured: false,
  preview: false,
  updateAvailable: false,
  releaseUrl: '',
  externalUrl: '',
  downloadPageUrl: '',
  downloadPages: [],
  selectedDownloadPageIndex: 0,
  errorReason: '',
  message: '',
  hero: '',
  notes: []
};
refreshUpdatePreviewText();
if (typeof window !== 'undefined' && window.MineradioI18n
  && typeof window.MineradioI18n.onLanguageChange === 'function') {
  window.MineradioI18n.onLanguageChange(function () { refreshUpdatePreviewText(); });
}
