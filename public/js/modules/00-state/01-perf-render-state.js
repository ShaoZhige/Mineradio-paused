// 文案统一走 i18n：缺键返回键名（不返回空串），params 同时喂给词典与兜底模板。
// Copy goes through i18n; a missing key returns the key itself rather than an empty string.
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
// 某个平台首屏就一条没取到时，只在列表底部提示一次就走，不常驻 —— 平台自己出问题
// 不该让整张列表永远挂着一行红字。
// A platform that fails its very first page gets one short notice and no more: a single
// broken platform must not leave a permanent warning pinned under the whole list.
var PLAYLIST_CATALOG_NOTICE_MS = 9000;
var PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX = 760;
var playlistPanelRenderLimit = PLAYLIST_PANEL_BATCH_SIZE;
var playlistPanelLazyBound = false;
var PLAYLIST_DETAIL_INITIAL_RENDER = PLAYLIST_LAZY_BATCH_SIZE;
var PLAYLIST_DETAIL_BATCH_SIZE = PLAYLIST_LAZY_BATCH_SIZE;
// 左侧歌单展开详情的几何参数，必须与 CSS 实测一致：
// 行 = .pl-detail-row 高 56 + .pl-detail-list 的 gap 6 = 62（与队列行距同值）。
// 展开详情 2026-10-26 改成分页：摘要头整块删除（卡片上已有歌名/封面/曲目数），
// 所以「外壳」只剩按钮行与容器内边距，高度也从「视口推算」变成可精确预估的
// 「一页行数 × 行距 + 按钮行 + 分页条」。
// 这些值一旦与样式脱节，虚拟高度就会小于真实内容 —— 详情是 overflow:visible，
// 缺的高度不会裁切，而是直接压到下一个歌单卡片上（2026-10-25 用户报的重叠 bug）。
// The detail now pages, and its summary header is gone, so the outer chrome is just the action
// row plus container padding and the rows are a fixed page size.
// 实测（2026-10-26，810px 高的窗口）：面板上限 690，吸顶区 141，卡片 69，容器内边距 36，
// 留给详情的可用高度是 442。一页 5 行时详情 = 59 + 5×62 + 34 = 403，连分页条一起正好落在
// 可视区内；6 行是 465，分页条会被顶出面板底部 25px，等于又逼用户滚一下——那正是分页要省掉的。
// Measured at an 810px-tall window: 442px is available for the detail. Five rows fit together with
// the pager; six rows push the pager 25px past the panel bottom, which is the scroll the pager was
// meant to remove.
var PLAYLIST_DETAIL_ROW_STEP = 62;
var PLAYLIST_DETAIL_VIRTUAL_OVERSCAN = 7;
var PLAYLIST_DETAIL_PAGE_SIZE = 5;
var PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT = 59;
var PLAYLIST_DETAIL_OUTER_FOOTER_HEIGHT = 34;
var PLAYLIST_QUEUE_INITIAL_BATCH_SIZE = 96;
var PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE = 160;
var PLAYLIST_QUEUE_PLAYBACK_AHEAD_THRESHOLD = 96;
// failedProviders / authExpiredProviders / noticeUntil 都是**派生**字段：由各平台的分页结果
// 重算（refreshPlaylistCatalogErrorState），不是「一次失败记一辈子」的开关。
// failedProviders / authExpiredProviders / noticeUntil are derived from per-provider page
// results, never latched by a single failure.
var playlistCatalogSyncState = {
  token: 0, loading: false, timer: 0, providers: {}, error: '',
  failedProviders: [], authExpiredProviders: [], noticeUntil: 0, noticeTimer: 0
};
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
