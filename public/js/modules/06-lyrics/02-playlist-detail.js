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
function playlistDetailText(key, fallback, params) {
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
var playlistPanelDetailState = { key: '', loading: false, loadingMore: false, playlist: null, tracks: [], token: 0, total: 0, nextOffset: 0, hasMore: false, page: 0, scrollTop: 0, controller: null, warmTimer: 0, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER, error: '', message: '' };
function queueVirtualSpacerHtml(height) {
  height = Math.max(0, Math.round(Number(height) || 0));
  return height ? '<div class="queue-virtual-spacer" aria-hidden="true" style="height:' + height + 'px"></div>' : '';
}
function queuePanelVirtualWindow(list, scroller, total, selfScroll, forceIndex) {
  total = Math.max(0, Number(total) || 0);
  if (!total) return { start: 0, end: 0, top: 0, bottom: 0 };
  var rowStep = QUEUE_VIRTUAL_ROW_STEP;
  var viewport = Math.max(rowStep * 4, Number(scroller && scroller.clientHeight) || rowStep * 9);
  var visibleRows = Math.max(4, Math.ceil(viewport / rowStep));
  var start = 0;
  if (forceIndex != null && forceIndex >= 0 && forceIndex < total) {
    start = Math.max(0, Math.floor(forceIndex - visibleRows * 0.42) - QUEUE_VIRTUAL_OVERSCAN);
  } else if (selfScroll) {
    start = Math.max(0, Math.floor((Number(scroller && scroller.scrollTop) || 0) / rowStep) - QUEUE_VIRTUAL_OVERSCAN);
  } else if (list && scroller && list.getBoundingClientRect && scroller.getBoundingClientRect) {
    var listRect = list.getBoundingClientRect();
    var scrollerRect = scroller.getBoundingClientRect();
    var visibleTop = Math.max(0, scrollerRect.top - listRect.top);
    start = Math.max(0, Math.floor(visibleTop / rowStep) - QUEUE_VIRTUAL_OVERSCAN);
  }
  var maxRows = visibleRows + QUEUE_VIRTUAL_OVERSCAN * 2;
  var end = Math.min(total, start + maxRows);
  start = Math.max(0, Math.min(start, Math.max(0, total - maxRows)));
  end = Math.min(total, Math.max(end, start + maxRows));
  return { start: start, end: end, top: start * rowStep, bottom: Math.max(0, total - end) * rowStep };
}
function scheduleQueuePanelVirtualRender() {
  if (queuePanelVirtualState.raf) return;
  queuePanelVirtualState.raf = requestAnimationFrame(function () {
    queuePanelVirtualState.raf = 0;
    if (miniQueueOpen) renderMiniQueuePanel({ animate: false, scrollCurrent: false });
    if (queueViewTab === 'queue' && isPlaylistPanelVisibleForRender()) {
      renderQueuePanel({ animate: false, scrollCurrent: false });
    }
  });
}
function maybeRequestPlaylistQueuePageFromScroller(scroller) {
  if (!scroller || typeof requestPlaylistQueueHydrationForBrowse !== 'function') return false;
  if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - QUEUE_VIRTUAL_ROW_STEP * 6) return false;
  return requestPlaylistQueueHydrationForBrowse();
}
function queuePanelItemKey(song, fallback) {
  try {
    if (typeof queueItemKey === 'function') return queueItemKey(song) || fallback;
  } catch (e) { }
  return song && (song.id || song.mid || song.localKey || song.name) || fallback;
}
function queuePanelListKey() {
  var total = playQueue && playQueue.length || 0;
  if (!total) return '0';
  return [
    total,
    queuePanelItemKey(playQueue[0], 'first'),
    queuePanelItemKey(playQueue[Math.max(0, total - 1)], 'last')
  ].join('|');
}
function resetQueuePanelRenderLimit() {
  queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
  queuePanelRenderKey = queuePanelListKey();
}
function queuePanelVisibleLimit(total) {
  total = Math.max(0, Number(total) || 0);
  if (!total) {
    queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
    queuePanelRenderKey = '0';
    return 0;
  }
  var key = queuePanelListKey();
  if (key !== queuePanelRenderKey) {
    queuePanelRenderKey = key;
    queuePanelRenderLimit = QUEUE_PANEL_BATCH_SIZE;
  }
  var base = Math.max(QUEUE_PANEL_BATCH_SIZE, queuePanelRenderLimit || QUEUE_PANEL_BATCH_SIZE);
  if (currentIdx >= 0 && currentIdx < total) {
    base = Math.max(base, Math.ceil((currentIdx + 1) / QUEUE_PANEL_BATCH_SIZE) * QUEUE_PANEL_BATCH_SIZE);
  }
  queuePanelRenderLimit = Math.min(total, base);
  return queuePanelRenderLimit;
}
function growQueuePanelRenderLimit(amount) {
  if (!playQueue.length) return false;
  var total = playQueue.length;
  var current = queuePanelVisibleLimit(total);
  var next = Math.min(total, current + (amount || QUEUE_PANEL_BATCH_SIZE));
  if (next <= current) return false;
  var panel = document.getElementById('playlist-panel');
  var keepTop = panel ? panel.scrollTop : 0;
  var miniList = document.getElementById('mini-queue-list');
  var keepMiniTop = miniList ? miniList.scrollTop : 0;
  queuePanelRenderLimit = next;
  renderQueuePanel({ animate: true, scrollCurrent: false });
  if (panel) panel.scrollTop = keepTop;
  if (miniList) {
    miniList = document.getElementById('mini-queue-list');
    if (miniList) miniList.scrollTop = keepMiniTop;
  }
  return true;
}
function maybeGrowQueuePanelRenderLimit() {
  var panel = document.getElementById('playlist-panel');
  if (!panel || queueViewTab !== 'queue' || !playQueue.length) return;
  if (queuePanelVisibleLimit(playQueue.length) >= playQueue.length) return;
  if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 220) growQueuePanelRenderLimit();
}
function bindMiniQueueLazyRender() {
  var list = document.getElementById('mini-queue-list');
  if (!list || miniQueueLazyBound) return;
  miniQueueLazyBound = true;
  list.addEventListener('scroll', function () {
    if (!miniQueueOpen) return;
    scheduleQueuePanelVirtualRender();
    maybeRequestPlaylistQueuePageFromScroller(list);
  }, { passive: true });
}
function normalizePlaylistProvider(provider) {
  if (provider === 'mineradio') return 'mineradio';
  if (provider === 'qq' || provider === 'kugou' || provider === 'qishui' || provider === 'spotify') return provider;
  return 'netease';
}
function playlistProviderLabel(provider) {
  provider = normalizePlaylistProvider(provider);
  if (provider === 'mineradio') return 'MR';
  return provider === 'qq' ? 'QQ' : (provider === 'kugou' ? 'KG' : (provider === 'qishui' ? 'QS' : (provider === 'spotify' ? 'SP' : 'NE')));
}
function playlistProviderName(provider) {
  provider = normalizePlaylistProvider(provider);
  if (provider === 'mineradio') return playlistDetailText('pl_builtin');
  if (provider === 'spotify') return 'Spotify';
  return provider === 'qq' ? playlistDetailText('login_qq', 'QQ 音乐') : (provider === 'kugou' ? playlistDetailText('provider_kugou') : (provider === 'qishui' ? playlistDetailText('provider_qishui') : playlistDetailText('track_netease_music')));
}
function playlistPanelKey(provider, id) {
  provider = normalizePlaylistProvider(provider);
  return provider + ':' + String(id || '');
}
function playlistPanelProviderId(provider, id) {
  provider = normalizePlaylistProvider(provider);
  if (provider === 'mineradio') return 'mineradio:' + id;
  if (provider === 'qq') return 'qq:' + id;
  if (provider === 'kugou') return 'kugou:' + id;
  if (provider === 'qishui') return 'qishui:' + id;
  if (provider === 'spotify') return 'spotify:' + id;
  return id;
}
function playlistCardPriority(pl) {
  if (!pl) return 10;
  if (pl.virtual || String(pl.id || '') === 'spotify-liked' || Number(pl.specialType || 0) === 5) return 0;
  return 1;
}
function prioritizePlaylistGroupItems(items) {
  return (items || []).map(function (pl, idx) {
    return { pl: pl, idx: idx, priority: playlistCardPriority(pl) };
  }).sort(function (a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.idx - b.idx;
  }).map(function (entry) { return entry.pl; });
}
function playlistPanelNoticeHtml(text, isError) {
  text = String(text || '').trim();
  if (!text) text = playlistDetailText('pl_no_playable');
  return '<div style="text-align:center;padding:14px 10px;color:' + (isError ? 'rgba(255,180,160,.82)' : 'rgba(255,255,255,.30)') + ';font-size:11.5px;line-height:1.55">' + escHtml(text) + '</div>';
}
// 分页取代了原来的内部滚动：一页固定 PLAYLIST_DETAIL_PAGE_SIZE 首，左右翻页（2026-10-26）。
// 页数按 total 算而不是按已加载条数算——列表是流式拉的，用已加载条数会让页数在拉取过程中跳变。
// Paging replaces the old inner scroll: a fixed page size and left/right paging. The page count
// follows total, not the loaded rows, or it would shift while batches stream in.
function playlistPanelDetailPageOf(st) {
  st = st || playlistPanelDetailState;
  var total = Math.max(0, Number(st.total) || 0, (st.tracks || []).length);
  var pages = Math.max(1, Math.ceil(total / PLAYLIST_DETAIL_PAGE_SIZE));
  var page = Math.min(Math.max(0, Number(st.page) || 0), pages - 1);
  return { page: page, pages: pages, total: total };
}
function playlistPanelDetailRowsHtml(options) {
  options = options || {};
  var st = playlistPanelDetailState;
  var tracks = st.tracks || [];
  if (st.loading && !tracks.length) {
    return playlistDetailText('pl_first_batch_html');
  }
  if (!tracks.length) return playlistPanelNoticeHtml(st.message || st.error || '', !!st.error);
  var pageInfo = playlistPanelDetailPageOf(st);
  var pageStart = pageInfo.page * PLAYLIST_DETAIL_PAGE_SIZE;
  var pageTracks = tracks.slice(pageStart, pageStart + PLAYLIST_DETAIL_PAGE_SIZE);
  // 翻到一页还没拉回来的位置：先给占位，补齐后由 loadMore 重绘。不做成空白，
  // 否则用户会以为这个歌单到这儿就没了。
  // A page whose rows are not fetched yet gets a placeholder rather than an empty box.
  if (!pageTracks.length && st.hasMore) {
    return '<div class="pl-detail-row pl-detail-loading-row"><span class="queue-hydration-spinner spinning"></span><div style="flex:1;min-width:0"><div class="pl-detail-row-title">' +
      escHtml(playlistDetailText('pl_preloading_more')) + '</div></div></div>';
  }
  // 多选态：行首插勾选框，并隐藏逐行移除按钮（此时点行只切换勾选，留着移除按钮是误导）。
  // In multi-select a checkbox is prefixed and the per-row remove button is hidden: a click then
  // only toggles the tick, so a visible remove button would be misleading.
  var msDetailActive = typeof playlistMultiActiveFor === 'function' && playlistMultiActiveFor('detail', st.key);
  var rows = pageTracks.map(function (song, localIndex) {
    var i = pageStart + localIndex;
    var thumb = songCoverSrc(song, 60);
    var imgTag = thumb ? '<img src="' + escHtml(thumb) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:34px;height:34px;border-radius:7px;background:rgba(255,255,255,.06);flex:0 0 auto"></div>';
    var removeButton = !msDetailActive && normalizePlaylistProvider((st.key || '').split(':')[0]) === 'mineradio'
      && !(st.playlist && st.playlist.virtual)
      ? '<button type="button" class="pl-detail-remove" data-pl-detail-remove="' + i + playlistDetailText('pl_remove_button_suffix')
      : '';
    var msCheck = msDetailActive && typeof playlistMultiCheckboxHtml === 'function' ? playlistMultiCheckboxHtml(i) : '';
    var msClass = msDetailActive && typeof playlistMultiRowClass === 'function' ? playlistMultiRowClass(i) : '';
    return '<div class="pl-detail-row' + msClass + '" data-pl-detail-row="' + i + '">' +
      msCheck + imgTag +
      '<div style="flex:1;min-width:0"><div class="pl-detail-row-title">' + escHtml(song.name || '') + '</div>' +
      '<button type="button" class="pl-detail-row-artist" data-pl-detail-artist="' + i + '">' + escHtml(song.artist || playlistDetailText('track_unknown_artist')) + '</button></div>' + removeButton +
      '</div>';
  }).join('');
  if (st.error) rows += playlistDetailText('pl_more_failed_html');
  return rows;
}
var PLAYLIST_REORDER_STORE_KEY = 'mineradio-playlist-reorder-v1';
function playlistReorderKey(pl) {
  if (!pl) return '';
  return playlistPanelKey(normalizePlaylistProvider(pl.provider), pl.id);
}
function readPlaylistReorderKeys() {
  try {
    var raw = localStorage.getItem(PLAYLIST_REORDER_STORE_KEY);
    var keys = raw ? JSON.parse(raw) : [];
    return Array.isArray(keys) ? keys.filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}
function savePlaylistReorderKeys() {
  try {
    localStorage.setItem(PLAYLIST_REORDER_STORE_KEY, JSON.stringify(userPlaylists.map(playlistReorderKey).filter(Boolean)));
  } catch (e) { }
}
function applyUserPlaylistOrder() {
  if (!userPlaylists || !userPlaylists.length) return false;
  var keys = readPlaylistReorderKeys();
  if (!keys.length) return false;
  var rank = {};
  keys.forEach(function (key, idx) {
    if (rank[key] == null) rank[key] = idx;
  });
  userPlaylists = userPlaylists.map(function (pl, idx) {
    return { pl: pl, idx: idx, rank: rank[playlistReorderKey(pl)] };
  }).sort(function (a, b) {
    var ar = a.rank;
    var br = b.rank;
    var ah = ar != null;
    var bh = br != null;
    if (ah && bh) return ar - br;
    if (ah) return -1;
    if (bh) return 1;
    return a.idx - b.idx;
  }).map(function (entry) { return entry.pl; });
  return true;
}
function moveUserPlaylistIndex(fromIdx, toIdx, opts) {
  opts = opts || {};
  fromIdx = Math.round(Number(fromIdx));
  toIdx = Math.round(Number(toIdx));
  if (!userPlaylists || !userPlaylists.length) return false;
  if (!isFinite(fromIdx) || !isFinite(toIdx)) return false;
  if (fromIdx < 0 || fromIdx >= userPlaylists.length) return false;
  toIdx = Math.max(0, Math.min(userPlaylists.length - 1, toIdx));
  if (fromIdx === toIdx) return false;
  var item = userPlaylists.splice(fromIdx, 1)[0];
  userPlaylists.splice(toIdx, 0, item);
  playlistCatalogRevision += 1;
  savePlaylistReorderKeys();
  if (opts.renderPanel !== false) renderUserPlaylistsList({ animate: false });
  if (opts.rebuildShelf !== false) safeShelfRebuild('playlist-reorder', true);
  return true;
}
function playlistTracksEndpoint(provider, id, params) {
  provider = normalizePlaylistProvider(provider);
  var query = 'id=' + encodeURIComponent(id);
  if (params) {
    Object.keys(params).forEach(function (key) {
      if (params[key] == null || params[key] === '') return;
      query += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    });
  }
  if (provider === 'qq') return '/api/qq/playlist/tracks?' + query;
  if (provider === 'kugou') return '/api/kugou/playlist/tracks?' + query;
  if (provider === 'qishui') return '/api/qishui/playlist/tracks?' + query;
  if (provider === 'spotify') return '/api/spotify/playlist/tracks?' + query;
  return '/api/playlist/tracks?' + query;
}
function fetchPlaylistTracksPage(provider, id, params, requestOptions) {
  provider = normalizePlaylistProvider(provider);
  if (provider === 'mineradio') {
    // 虚拟本地歌单的曲目直接从内存里的本地库分页，不走内置歌单的 IPC 与磁盘索引。
    if (isLocalLibraryPlaylist(provider, id)) return localLibraryTracksPage(params || {});
    return builtInPlaylistTracksPage(id, params || {});
  }
  return apiJson(playlistTracksEndpoint(provider, id, params), requestOptions || {});
}
// 分页条：只有一页时整条不渲染，因此它的高度也要参与台账估算（见 playlistPanelDetailShellHeight）。
// The pager is omitted entirely when a single page holds everything, so its height is part of the
// ledger estimate.
function playlistPanelDetailPagerHtml() {
  var info = playlistPanelDetailPageOf();
  if (info.pages <= 1) return '';
  var prevOff = info.page <= 0;
  var nextOff = info.page >= info.pages - 1;
  return '<div class="pl-detail-pager">' +
    '<button type="button" class="pl-pager-btn"' + (prevOff ? ' disabled' : '') + ' data-pl-page="prev" aria-label="' +
    escHtml(playlistDetailText('pl_page_prev')) + '" title="' + escHtml(playlistDetailText('pl_page_prev')) + '">‹</button>' +
    '<span class="pl-pager-indicator">' + (info.page + 1) + ' / ' + info.pages + '</span>' +
    '<button type="button" class="pl-pager-btn"' + (nextOff ? ' disabled' : '') + ' data-pl-page="next" aria-label="' +
    escHtml(playlistDetailText('pl_page_next')) + '" title="' + escHtml(playlistDetailText('pl_page_next')) + '">›</button>' +
    '</div>';
}
function playlistPanelDetailHtml(pl, provider, detailWindow) {
  provider = normalizePlaylistProvider(provider);
  var key = playlistPanelKey(provider, pl && pl.id);
  if (playlistPanelDetailState.key !== key) return '';
  var rows = playlistPanelDetailRowsHtml(detailWindow);
  var canUncollect = !!(pl && pl.subscribed && !pl.virtual && (provider === 'netease' || provider === 'qishui' || provider === 'spotify'));
  var collectionButton = canUncollect
    ? playlistDetailText('pl_uncollect_button')
    : '';
  // 虚拟本地歌单不能改名也不能删除——它就是本地库本身，所以不给这两个按钮。
  // The virtual local playlist cannot be renamed or deleted; it is the library itself.
  var builtInActions = provider === 'mineradio' && !(pl && pl.virtual)
    ? playlistDetailText('pl_rename_delete_buttons')
    : '';
  var multiButton = '<button type="button" class="pl-detail-multi' + (typeof playlistMultiActiveFor === 'function' && playlistMultiActiveFor('detail', key) ? ' active' : '') + '" data-pl-detail-multi="' + escHtml(key) + '">' + escHtml(playlistDetailText('ms_select', '多选')) + '</button>';
  // 摘要头（封面 / 歌单名 / 曲目数 / 已载入计数）整块去掉：这些在未展开的卡片上已经有了，
  // 展开后再重复一遍等于同一个信息说两次，还把「播放歌单」按钮挤到下面。
  // 现在详情从卡片下沿直接接按钮行，再跟曲目和分页条。
  // The summary block is gone: the collapsed card already carries cover, name and track count, so
  // repeating it pushed the actions down for nothing. The detail now starts with the action row.
  return '<div class="pl-inline-detail" data-pl-detail="' + escHtml(key) + '">' +
    '<div class="pl-detail-actions"><button class="pl-detail-play" type="button" data-pl-detail-play="' + escHtml(key) + playlistDetailText('pl_play_button_suffix') + collectionButton + builtInActions + multiButton + '</div>' +
    '<div class="pl-detail-list" data-pl-detail-scroll="' + escHtml(key) + '">' + rows + '</div>' +
    playlistPanelDetailPagerHtml() +
    '</div>';
}
function renderPlaylistPanelDetailState() {
  renderUserPlaylistsList();
}
function scrollPlaylistPanelDetailIntoView(key) {
  var panel = document.getElementById('playlist-panel');
  if (!panel || !key) return;
  requestAnimationFrame(function () {
    var detail = null;
    Array.prototype.some.call(panel.querySelectorAll('[data-pl-detail]'), function (node) {
      if (node.getAttribute('data-pl-detail') === key) {
        detail = node;
        return true;
      }
      return false;
    });
    if (!detail) return;
    var anchor = detail.previousElementSibling || detail;
    var toolbar = panel.querySelector('.queue-toolbar');
    var safeOffset = 126;
    if (toolbar) {
      var toolbarTop = 82;
      try { toolbarTop = parseFloat(getComputedStyle(toolbar).top) || toolbarTop; } catch (e) { }
      safeOffset = Math.max(safeOffset, toolbarTop + toolbar.offsetHeight + 12);
    }
    var top = Math.max(0, anchor.offsetTop - safeOffset);
    try { panel.scrollTo({ top: top, behavior: 'smooth' }); }
    catch (e) { panel.scrollTop = top; }
  });
}
function cancelPlaylistPanelDetailRequest() {
  if (playlistPanelDetailState.warmTimer) clearTimeout(playlistPanelDetailState.warmTimer);
  playlistPanelDetailState.warmTimer = 0;
  if (playlistPanelDetailState.controller) {
    try { playlistPanelDetailState.controller.abort(); } catch (e) { }
  }
  playlistPanelDetailState.controller = null;
}
function appendPlaylistPanelDetailTracks(target, incoming) {
  var seen = Object.create(null);
  (target || []).forEach(function (song, index) { seen[queuePanelItemKey(song, 'old:' + index)] = true; });
  var added = 0;
  (incoming || []).forEach(function (song, index) {
    var key = queuePanelItemKey(song, 'new:' + index);
    if (!song || seen[key]) return;
    seen[key] = true;
    target.push(song);
    added += 1;
  });
  return added;
}
function renderPlaylistPanelDetailRows() {
  if (!playlistPanelDetailState.key) return;
  renderUserPlaylistsList({ animate: false, preserveScroll: true });
}
function bindPlaylistPanelDetailScroller() {
  // 歌单详情与左栏共用 #playlist-panel 的单一滚动轴；行窗口由外层滚动位置驱动。
}
async function loadMorePlaylistPanelDetailTracks(reason) {
  var st = playlistPanelDetailState;
  if (!st.key || st.loadingMore || (reason !== 'initial' && !st.hasMore)) return false;
  var parts = st.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var pid = parts.slice(1).join(':');
  var offset = reason === 'initial' ? 0 : Math.max(0, Number(st.nextOffset) || st.tracks.length);
  var token = st.token;
  var controller = window.AbortController ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, 12000) : 0;
  st.controller = controller;
  st.loadingMore = reason !== 'initial';
  if (st.loadingMore) renderPlaylistPanelDetailRows();
  try {
    var r = await fetchPlaylistTracksPage(provider, pid, { limit: PLAYLIST_DETAIL_BATCH_SIZE, offset: offset }, controller ? { signal: controller.signal } : { timeoutMs: 12000 });
    if (playlistPanelDetailState.token !== token || playlistPanelDetailState.key !== st.key) return false;
    var rawTracks = r && r.tracks || [];
    if (r && r.error && !rawTracks.length) throw new Error(r.message || r.error);
    var mapped = rawTracks.map(cloneSong);
    var added = appendPlaylistPanelDetailTracks(st.tracks, mapped);
    var responseTotal = Number(r && (r.total || (r.playlist && r.playlist.trackCount))) || 0;
    st.total = Math.max(st.total || 0, responseTotal, st.tracks.length);
    st.nextOffset = Math.max(offset + rawTracks.length, Number(r && r.nextOffset) || 0);
    st.hasMore = !!(r && r.hasMore);
    if (!rawTracks.length || (!added && st.nextOffset <= offset)) st.hasMore = false;
    st.loading = false;
    st.loadingMore = false;
    st.error = (r && r.error) || '';
    st.message = (r && (r.message || r.warning)) || '';
    if (r && r.playlist) st.playlist = Object.assign({}, st.playlist || {}, r.playlist);
    if (reason === 'initial') {
      renderPlaylistPanelDetailState();
      scrollPlaylistPanelDetailIntoView(st.key);
      if (st.hasMore) {
        st.warmTimer = setTimeout(function () {
          st.warmTimer = 0;
          if (playlistPanelDetailState.token === token && playlistPanelDetailState.key === st.key) loadMorePlaylistPanelDetailTracks('warm');
        }, 320);
      }
    } else {
      renderPlaylistPanelDetailRows();
    }
    return added > 0;
  } catch (e) {
    if (playlistPanelDetailState.token !== token || (e && e.name === 'AbortError')) return false;
    console.warn('[PlaylistPanelDetailPage]', pid, reason, e);
    st.loading = false;
    st.loadingMore = false;
    st.hasMore = false;
    st.error = 'PLAYLIST_DETAIL_PAGE_FAILED';
    st.message = st.tracks.length ? playlistDetailText('pl_more_load_failed') : playlistDetailText('pl_detail_load_failed');
    if (reason === 'initial') renderPlaylistPanelDetailState();
    else renderPlaylistPanelDetailRows();
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (playlistPanelDetailState.token === token && playlistPanelDetailState.controller === controller) playlistPanelDetailState.controller = null;
  }
}
async function openPlaylistPanelDetail(provider, pid, title) {
  if (!pid) return;
  // 切到另一个歌单（或收起当前详情）时，之前那一批勾选已经不属于眼前的列表了。
  // Opening another playlist (or collapsing this one) leaves the old selection attached to a list
  // that is no longer on screen.
  if (typeof playlistMultiExit === 'function') playlistMultiExit();
  provider = normalizePlaylistProvider(provider);
  var key = playlistPanelKey(provider, pid);
  var pl = userPlaylists.find(function (item) { return playlistPanelKey(normalizePlaylistProvider(item.provider), item.id) === key; }) || { id: pid, provider: provider, name: title || playlistDetailText('pl_detail') };
  if (playlistPanelDetailState.key === key) {
    cancelPlaylistPanelDetailRequest();
    playlistPanelDetailState.key = '';
    playlistPanelDetailState.tracks = [];
    playlistPanelDetailState.playlist = null;
    playlistPanelDetailState.renderLimit = PLAYLIST_DETAIL_INITIAL_RENDER;
    playlistPanelDetailState.error = '';
    playlistPanelDetailState.message = '';
    renderPlaylistPanelDetailState();
    return;
  }
  cancelPlaylistPanelDetailRequest();
  var token = ++playlistPanelDetailState.token;
  playlistPanelDetailState = { key: key, loading: true, loadingMore: false, playlist: pl, tracks: [], token: token, total: Number(pl.trackCount) || 0, nextOffset: 0, hasMore: true, page: 0, scrollTop: 0, controller: null, warmTimer: 0, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER, error: '', message: '' };
  renderPlaylistPanelDetailState();
  scrollPlaylistPanelDetailIntoView(key);
  await loadMorePlaylistPanelDetailTracks('initial');
}
// 翻页：页内数据没拉回来时先把这一页补够再重绘，避免翻过去看到一行占位。
// Flipping to a page whose rows are still missing fetches them first, so the page never shows a
// placeholder that the user would read as "the playlist ends here".
async function gotoPlaylistPanelDetailPage(delta) {
  var st = playlistPanelDetailState;
  if (!st || !st.key) return false;
  var info = playlistPanelDetailPageOf(st);
  var next = Math.min(Math.max(0, info.page + (Number(delta) || 0)), info.pages - 1);
  if (next === info.page) return false;
  st.page = next;
  renderPlaylistPanelDetailRows();
  var need = Math.min(info.total, (next + 1) * PLAYLIST_DETAIL_PAGE_SIZE);
  var guard = 0;
  while (st.key && st.tracks.length < need && st.hasMore && !st.loadingMore && guard < 40) {
    guard += 1;
    var before = st.tracks.length;
    var grown = await loadMorePlaylistPanelDetailTracks('page');
    if (!grown || st.tracks.length <= before) break;
  }
  if (st.key) renderPlaylistPanelDetailRows();
  return true;
}
function playPlaylistPanelDetail() {
  var st = playlistPanelDetailState;
  if (!st || !st.key) return;
  var parts = st.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var pid = parts.slice(1).join(':');
  var title = st.playlist && st.playlist.name || '';
  // 虚拟本地歌单的曲目只在内存里，没有可查的内置歌单记录：把已加载的当种子传进去，
  // 否则整单播放会去问内置歌单 IPC 并失败。后续分页仍由本地库那一路继续补。
  // The virtual local playlist has no stored record: seed the queue with what is loaded, or the
  // whole-playlist path would ask the built-in playlist IPC and come back empty.
  if (isLocalLibraryPlaylist(provider, pid)) {
    loadPlaylistIntoQueueById(playlistPanelProviderId(provider, pid), true, title, {
      seedTracks: st.tracks,
      total: st.total,
      nextOffset: st.nextOffset,
      hasMore: st.hasMore,
      playlist: st.playlist,
      preserveHomeState: true
    });
    return;
  }
  loadPlaylistIntoQueueById(playlistPanelProviderId(provider, pid), true, title);
}
async function togglePlaylistPanelCollection(collected) {
  var state = playlistPanelDetailState;
  if (!state || !state.key || !state.playlist) return;
  var parts = state.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var id = parts.slice(1).join(':');
  var endpoint = provider === 'netease'
    ? '/api/playlist/subscribe'
    : (provider === 'qishui'
      ? '/api/qishui/playlist/collect'
      : (provider === 'spotify' ? '/api/spotify/playlist/collect' : ''));
  if (!endpoint) {
    showToast(playlistProviderName(provider) + playlistDetailText('pl_collect_unsupported'));
    return;
  }
  try {
    var result = await apiJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: id,
        playlistId: id,
        subscribed: !!collected,
        collected: !!collected,
        spotifyUri: state.playlist.spotifyUri || '',
      })
    });
    if (!result || result.error || result.success === false) throw new Error(result && (result.message || result.error) || 'PLAYLIST_COLLECTION_FAILED');
    showToast(collected ? playlistDetailText('pl_collected') : playlistDetailText('pl_uncollected'));
    cancelPlaylistPanelDetailRequest();
    playlistPanelDetailState.key = '';
    playlistPanelDetailState.tracks = [];
    playlistPanelDetailState.playlist = null;
    await refreshUserPlaylists(true);
    renderPlaylistPanelDetailState();
  } catch (err) {
    showToast(/SCOPE|PERMISSION/i.test(String(err && err.message || ''))
      ? playlistDetailText('pl_reauthorize_collect')
      : playlistDetailText('pl_collect_failed'));
  }
}
function playPlaylistPanelDetailTrack(index) {
  var tracks = playlistPanelDetailState.tracks || [];
  if (!tracks[index]) return;
  var parts = playlistPanelDetailState.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var pid = parts.slice(1).join(':');
  loadPlaylistIntoQueueById(playlistPanelProviderId(provider, pid), true, playlistPanelDetailState.playlist && playlistPanelDetailState.playlist.name || '', {
    seedTracks: tracks,
    startIndex: index,
    total: playlistPanelDetailState.total,
    nextOffset: playlistPanelDetailState.nextOffset,
    hasMore: playlistPanelDetailState.hasMore,
    preserveHomeState: true
  });
}
function openPlaylistPanelDetailArtist(index) {
  var song = playlistPanelDetailState.tracks && playlistPanelDetailState.tracks[index];
  if (song) openArtistDetailForSong(song);
}
function resetPlaylistPanelRenderLimit() {
  playlistPanelRenderLimit = PLAYLIST_PANEL_BATCH_SIZE;
}
// 平台切换器（2026-10-26）：不同平台的歌单不再纵向堆叠成多组，而是由顶部一行胶囊切换，
// 一次只渲染选中的那个平台。原先的「分组折叠」随之删除——切到某个平台只剩一组，折叠等于清空。
// 选中项持久化，重开面板保持上次看的平台。
// Providers are no longer stacked as vertical groups: a pill row at the top switches between them
// and only the selected provider is rendered. The old per-group collapse is gone with it.
var PLAYLIST_ACTIVE_PROVIDER_KEY = 'mineradio-playlist-active-provider-v1';
var playlistPanelActiveProvider = (function () {
  try {
    return (window.localStorage && window.localStorage.getItem(PLAYLIST_ACTIVE_PROVIDER_KEY)) || '';
  } catch (e) {
    return '';
  }
})();
// 平台展示顺序固定，不随登录状态变化，避免同一平台的位置跳来跳去。
// The order is fixed so a provider never jumps around as accounts log in and out.
var PLAYLIST_PROVIDER_ORDER = ['mineradio', 'netease', 'qq', 'kugou', 'qishui', 'spotify'];
function playlistPanelProviderBuckets() {
  var groups = {};
  PLAYLIST_PROVIDER_ORDER.forEach(function (key) { groups[key] = []; });
  var rows = Array.isArray(userPlaylists) ? userPlaylists : [];
  rows.forEach(function (pl, sourceIndex) {
    var key = normalizePlaylistProvider(pl && pl.provider);
    if (!groups[key]) groups[key] = [];
    groups[key].push({ pl: pl, sourceIndex: sourceIndex });
  });
  PLAYLIST_PROVIDER_ORDER.forEach(function (key) {
    groups[key].sort(function (a, b) {
      var priority = playlistCardPriority(a.pl) - playlistCardPriority(b.pl);
      return priority || (a.sourceIndex - b.sourceIndex);
    });
  });
  return groups;
}
// 只列出当前真有歌单的平台：空平台不占位置，也不给一个点了没反应的按钮。
// Only providers that actually hold playlists get a pill; an empty tab would just be a dead click.
function playlistPanelAvailableProviders(buckets) {
  buckets = buckets || playlistPanelProviderBuckets();
  return PLAYLIST_PROVIDER_ORDER.filter(function (key) {
    return (buckets[key] || []).length > 0;
  });
}
// 选中项一旦失效（退出登录、该平台歌单被清空）就落回第一个有内容的平台，
// 否则列表会整片空白。
// A stale selection falls back to the first non-empty provider, so the list is never blank.
function resolvePlaylistPanelActiveProvider(buckets, available) {
  buckets = buckets || playlistPanelProviderBuckets();
  available = available || playlistPanelAvailableProviders(buckets);
  if (!available.length) return '';
  if (available.indexOf(playlistPanelActiveProvider) >= 0) return playlistPanelActiveProvider;
  // 落回第一个非空平台时把结果写回内存态（不落盘）：否则全局值一直是空串，
  // 切换器高亮的其实是推算值，而点那个平台会被 setPlaylistPanelActiveProvider 当成
  // 「换了一个平台」再整表重绘一次。
  // Falling back also writes the result back in memory (not to storage): otherwise the global
  // stays empty while the switcher highlights a computed value, and clicking that very pill would
  // be treated as a switch and rebuild the whole ledger for nothing.
  playlistPanelActiveProvider = available[0];
  return playlistPanelActiveProvider;
}
function setPlaylistPanelActiveProvider(key) {
  if (!key || key === playlistPanelActiveProvider) return;
  playlistPanelActiveProvider = key;
  try {
    if (window.localStorage) window.localStorage.setItem(PLAYLIST_ACTIVE_PROVIDER_KEY, key);
  } catch (e) { }
  // 换平台等于换掉整份条目台账，必须让缓存失效后重排。
  playlistPanelVirtualCache.revision = -1;
  schedulePlaylistPanelVirtualRender();
}
var playlistPanelVirtualCache = { revision: -1, detailKey: '', detailSig: '', entries: [], offsets: [0], totalHeight: 0, raf: 0 };
// detailSig -> 实测高度。样式或语言变化都会让估算值漂移，实测值优先，
// 这样 offsets 不必依赖常量永远准确。
var playlistPanelDetailMeasure = {};
function playlistPanelMeasuredDetailHeight(sig) {
  var measured = Number(playlistPanelDetailMeasure[sig]);
  return measured > 0 ? Math.round(measured) : 0;
}
function syncPlaylistPanelMeasuredDetailHeight(sig) {
  if (!sig) return false;
  var node = document.querySelector('#pl-list .pl-inline-detail[data-pl-detail]');
  if (!node) return false;
  var measured = Math.round(node.getBoundingClientRect().height);
  if (!(measured > 0)) return false;
  if (Math.abs(measured - playlistPanelMeasuredDetailHeight(sig)) <= 4) return false;
  playlistPanelDetailMeasure[sig] = measured;
  // 让虚拟表在下一次构建时读到新高度（sig 不等就会重建）
  playlistPanelVirtualCache.detailSig = '';
  return true;
}
// 详情高度 = 按钮行（外壳）+ 当前页行数 × 行距 + 提示块 + 分页条。
// 分页之后高度变成可精确预估的量（一页最多 6 行），不再依赖「一屏多少行」这种视口推算；
// 实测值仍然优先，用于兜住最后一页行数不足时的收缩。
// The height is now computable: chrome + one page of rows + notice + pager.
function playlistPanelDetailShellHeight() {
  var st = playlistPanelDetailState || {};
  var info = playlistPanelDetailPageOf(st);
  var loaded = (st.tracks && st.tracks.length) || 0;
  var rows = st.loading && !loaded ? 1 : Math.min(PLAYLIST_DETAIL_PAGE_SIZE, Math.max(0, loaded - info.page * PLAYLIST_DETAIL_PAGE_SIZE));
  var noticeHeight = st.loading && !loaded ? 0 : (loaded ? 0 : 74);
  var pagerHeight = info.pages > 1 ? PLAYLIST_DETAIL_OUTER_FOOTER_HEIGHT : 0;
  return PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT + rows * PLAYLIST_DETAIL_ROW_STEP + noticeHeight + pagerHeight;
}
// 本地曲库在「我的歌单」里以一个虚拟歌单出现（#462）：不落存储、不占内置歌单名额与曲目上限，
// 内容永远等于本地库本身——导入、删除、重新扫描都不需要再同步一份。原来的「本地库」入口保持不变。
// The local library shows up as one virtual playlist: nothing is persisted, so it can never drift
// from the library itself and no sync pass is needed after import or delete.
var LOCAL_LIBRARY_PLAYLIST_ID = '__local-library__';
function isLocalLibraryPlaylist(provider, id) {
  return normalizePlaylistProvider(provider) === 'mineradio' && String(id || '') === LOCAL_LIBRARY_PLAYLIST_ID;
}
function localLibraryPlaylistEntry() {
  var tracks = (typeof persistentLocalLibraryTracks !== 'undefined' && Array.isArray(persistentLocalLibraryTracks)) ? persistentLocalLibraryTracks : [];
  if (!tracks.length) return null;
  var first = tracks[0] || {};
  return {
    provider: 'mineradio',
    source: 'mineradio',
    id: LOCAL_LIBRARY_PLAYLIST_ID,
    name: playlistDetailText('discover_local_music', '本地音乐'),
    cover: first.cover || first.picUrl || '',
    trackCount: tracks.length,
    creator: 'Mineradio',
    builtin: true,
    virtual: true,
    shelfPane: 'mine',
    subscribed: false
  };
}
function localLibraryTracksPage(params) {
  var all = (typeof persistentLocalLibraryTracks !== 'undefined' && Array.isArray(persistentLocalLibraryTracks)) ? persistentLocalLibraryTracks : [];
  var offset = Math.max(0, Number(params && params.offset) || 0);
  var limit = Math.max(1, Number(params && params.limit) || all.length || 1);
  var slice = all.slice(offset, offset + limit).map(cloneSong);
  return {
    ok: true,
    playlist: localLibraryPlaylistEntry() || {},
    tracks: slice,
    total: all.length,
    nextOffset: offset + slice.length,
    hasMore: offset + slice.length < all.length
  };
}
// 任何重建 userPlaylists 的地方都要过这一道：登录/退出/强制刷新都会用 builtInPlaylists 重置整个
// 数组，直接赋值会把虚拟本地歌单冲掉，于是「本地音乐」时隐时现。统一走这里就不会漏。
// Every place that rebuilds userPlaylists goes through this: login/logout/force-refresh reset the
// array from builtInPlaylists, and a plain assignment silently drops the virtual local playlist.
function withLocalLibraryPlaylist(list) {
  var rows = Array.isArray(list) ? list : [];
  var out = rows.filter(function (pl) {
    return !(pl && String(pl.id || '') === LOCAL_LIBRARY_PLAYLIST_ID);
  });
  var localEntry = localLibraryPlaylistEntry();
  if (localEntry) out.unshift(localEntry);
  return out;
}
function playlistPanelGroupKey(pl) {
  return normalizePlaylistProvider(pl && pl.provider);
}
function playlistPanelBuildVirtualEntries() {
  var detailSig = [
    playlistPanelDetailState.key || '',
    playlistPanelDetailState.loading ? 1 : 0,
    playlistPanelDetailState.loadingMore ? 1 : 0,
    playlistPanelDetailState.tracks && playlistPanelDetailState.tracks.length || 0,
    playlistPanelDetailState.total || 0,
    playlistPanelDetailState.hasMore ? 1 : 0,
    playlistPanelDetailState.error || '',
    playlistPanelDetailState.page || 0
  ].join('|');
  if (playlistPanelVirtualCache.revision === playlistCatalogRevision &&
      playlistPanelVirtualCache.detailKey === playlistPanelDetailState.key &&
      playlistPanelVirtualCache.detailSig === detailSig) return playlistPanelVirtualCache;
  var buckets = playlistPanelProviderBuckets();
  var available = playlistPanelAvailableProviders(buckets);
  var activeProvider = resolvePlaylistPanelActiveProvider(buckets, available);
  var items = buckets[activeProvider] || [];
  // 平台切换器已经表明当前看的是哪个平台，列表里不再需要分组标题，条目台账从
  // 「标题 + 卡片」简化为只有卡片（详情仍插在它自己那张卡片后面）。
  // The switcher already names the provider, so no group header enters the ledger anymore.
  var entries = [];
  items.forEach(function (entry) {
    entries.push({ type: 'card', pl: entry.pl, sourceIndex: entry.sourceIndex, height: 69 });
    var cardKey = playlistPanelKey(normalizePlaylistProvider(entry.pl.provider), entry.pl.id);
    if (playlistPanelDetailState.key === cardKey) {
      entries.push({ type: 'detail', pl: entry.pl, provider: normalizePlaylistProvider(entry.pl.provider), height: playlistPanelMeasuredDetailHeight(detailSig) || playlistPanelDetailShellHeight() });
    }
  });
  var offsets = [0];
  entries.forEach(function (entry) { offsets.push(offsets[offsets.length - 1] + entry.height); });
  playlistPanelVirtualCache = {
    revision: playlistCatalogRevision,
    detailKey: playlistPanelDetailState.key,
    detailSig: detailSig,
    entries: entries,
    offsets: offsets,
    totalHeight: offsets[offsets.length - 1] || 0,
    activeProvider: activeProvider,
    availableProviders: available,
    raf: playlistPanelVirtualCache.raf || 0
  };
  return playlistPanelVirtualCache;
}
function playlistPanelOffsetIndex(offsets, value) {
  var lo = 0, hi = Math.max(0, offsets.length - 1);
  while (lo < hi) {
    var mid = Math.floor((lo + hi + 1) / 2);
    if (offsets[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, Math.min(offsets.length - 2, lo));
}
function playlistCatalogFooterHtml() {
  var state = playlistCatalogSyncState || {};
  var providerStates = state.providers || {};
  var totals = Object.keys(providerStates).reduce(function (acc, key) {
    var item = providerStates[key] || {};
    acc.loaded += Number(item.loaded) || 0;
    acc.total += Math.max(Number(item.total) || 0, Number(item.loaded) || 0);
    if (item.hasMore || item.loading) acc.pending = true;
    return acc;
  }, { loaded: 0, total: 0, pending: !!state.loading });
  if (!totals.pending && !state.error) return '';
  var label = state.error
    ? (playlistDetailText('pl_partial_failed_prefix') + userPlaylists.length + playlistDetailText('pl_count_unit'))
    : (playlistDetailText('pl_loading_bg') + totals.loaded + (totals.total ? '/' + totals.total : ''));
  return '<div class="playlist-catalog-status"><span class="queue-hydration-spinner spinning"></span><span>' + label + '</span></div>';
}
function schedulePlaylistPanelVirtualRender() {
  if (playlistPanelVirtualCache.raf) return;
  playlistPanelVirtualCache.raf = requestAnimationFrame(function () {
    playlistPanelVirtualCache.raf = 0;
    if (queueViewTab !== 'playlists') return;
    renderUserPlaylistsList({ animate: false, preserveScroll: true });
  });
}
function bindPlaylistPanelLazyRender() {
  var panel = document.getElementById('playlist-panel');
  bindMiniQueueLazyRender();
  if (!panel || playlistPanelLazyBound) return;
  playlistPanelLazyBound = true;
  panel.addEventListener('scroll', function () {
    if (queueViewTab === 'queue') {
      scheduleQueuePanelVirtualRender();
      maybeRequestPlaylistQueuePageFromScroller(panel);
    }
    if (queueViewTab === 'playlists') {
      schedulePlaylistPanelVirtualRender();
    }
  }, { passive: true });
}
// 平台切换器只在真有两个以上平台有歌单时才出现：只有一个平台时它点了也不会有任何变化，
// 纯粹占掉面板本就紧张的高度。
// The switcher only shows with two or more non-empty providers; a single pill would do nothing but
// eat height the panel barely has.
// 切换器在 sticky 区里，不在 #pl-list 内部，所以 #pl-list 的事件委托收不到它，得单独绑一次。
// 每次重绘只换 innerHTML，宿主节点不变，绑定一次就够。
// The switcher lives in the sticky block, outside #pl-list, so the list delegation never sees it.
// Only the innerHTML is rebuilt, so one binding on the host is enough.
function bindPlaylistProviderTabs() {
  var host = document.getElementById('pl-provider-tabs');
  if (!host || host.getAttribute('data-pl-bound') === '1') return;
  host.setAttribute('data-pl-bound', '1');
  host.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-pl-provider]') : null;
    if (!btn) return;
    e.preventDefault();
    setPlaylistPanelActiveProvider(btn.getAttribute('data-pl-provider'));
  });
}
function renderPlaylistProviderTabs(cache) {
  var host = document.getElementById('pl-provider-tabs');
  if (!host) return;
  bindPlaylistProviderTabs();
  var onPlaylists = typeof queueViewTab === 'undefined' || queueViewTab === 'playlists';
  // 离开「我的歌单」页签时直接收起；回到这个页签时调用方可能没带 cache（switchPlaylistTab
  // 就是这种情况），现算一份即可。
  // Leaving the playlists tab hides it outright; coming back may arrive without a cache, in which
  // case one is built here.
  if (!onPlaylists) {
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }
  if (!cache) cache = playlistPanelBuildVirtualEntries();
  var available = cache.availableProviders || [];
  if (available.length < 2) {
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }
  var active = (cache && cache.activeProvider) || '';
  host.style.display = '';
  host.innerHTML = available.map(function (key) {
    var full = playlistProviderName(key);
    var isActive = key === active;
    return '<button type="button" class="pl-provider-tab' + (isActive ? ' active' : '') + '"'
      + ' data-pl-provider="' + escHtml(key) + '"'
      + ' aria-pressed="' + (isActive ? 'true' : 'false') + '"'
      + ' title="' + escHtml(full) + '" aria-label="' + escHtml(full) + '">'
      + escHtml(playlistProviderLabel(key)) + '</button>';
  }).join('');
}
function renderUserPlaylistsList(opts) {
  opts = opts || {};
  var $pl = document.getElementById('pl-list');
  var seq = ++playlistRenderSeq;
  if (!userPlaylists.length) {
    renderPlaylistProviderTabs(null);
    $pl.innerHTML = playlistCatalogSyncState && playlistCatalogSyncState.loading
      ? miniQueueSkeleton() + playlistCatalogFooterHtml()
      : playlistDetailText('pl_not_found_html');
    return;
  }
  var panel = document.getElementById('playlist-panel');
  var keepTop = panel ? panel.scrollTop : 0;
  function playlistCardHtml(pl, sourceIndex) {
    var provider = normalizePlaylistProvider(pl.provider);
    var providerLabel = playlistProviderLabel(provider);
    var thumb = pl.cover ? (provider === 'netease' ? (pl.cover + '?param=88y88') : pl.cover) : '';
    var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : (provider === 'mineradio' ? '<div class="pl-built-in-placeholder">MR</div>' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(255,255,255,.06);flex-shrink:0"></div>');
    var key = playlistPanelKey(provider, pl.id);
    var isExpanded = playlistPanelDetailState.key === key;
    var expanded = isExpanded ? ' expanded' : '';
    return '<div class="pl-card' + expanded + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '" data-playlist-provider="' + provider + '" data-playlist-id="' + escHtml(String(pl.id || '')) + '" data-playlist-title="' + escHtml(pl.name || '') + '" data-playlist-index="' + sourceIndex + '">' +
      imgTag +
      '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(pl.name) + '<span class="tag-source ' + provider + '" style="margin-left:6px;vertical-align:1px">' + providerLabel + '</span></div><div class="pl-sub">' + pl.trackCount + playlistDetailText('pl_tracks_prefix') + escHtml(pl.creator || '') + '</div></div>' +
      '</div>';
  }
  var cache = playlistPanelBuildVirtualEntries();
  renderPlaylistProviderTabs(cache);
  var listRect = $pl.getBoundingClientRect();
  var panelRect = panel && panel.getBoundingClientRect ? panel.getBoundingClientRect() : { top: 0 };
  var visibleTop = panel ? Math.max(0, panelRect.top - listRect.top) : 0;
  var viewport = Math.max(420, Number(panel && panel.clientHeight) || 620);
  var start = playlistPanelOffsetIndex(cache.offsets, Math.max(0, visibleTop - PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX));
  var end = Math.min(cache.entries.length, playlistPanelOffsetIndex(cache.offsets, visibleTop + viewport + PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX) + 1);
  var topHeight = cache.offsets[start] || 0;
  var bottomHeight = Math.max(0, cache.totalHeight - (cache.offsets[end] || cache.totalHeight));
  var html = '<div class="playlist-virtual-spacer" aria-hidden="true" style="height:' + Math.round(topHeight) + 'px"></div>';
  for (var entryIndex = start; entryIndex < end; entryIndex++) {
    var entry = cache.entries[entryIndex];
    if (entry.type === 'card') html += playlistCardHtml(entry.pl, entry.sourceIndex);
    else if (entry.type === 'detail') {
      html += playlistPanelDetailHtml(entry.pl, entry.provider);
    }
  }
  html += '<div class="playlist-virtual-spacer" aria-hidden="true" style="height:' + Math.round(bottomHeight) + 'px"></div>' + playlistCatalogFooterHtml();
  $pl.innerHTML = html;
  if (panel && opts.preserveScroll) panel.scrollTop = keepTop;
  // 详情高度最终以实际渲染结果为准：首次估算若与实测差超过 4px，记录后重排一次。
  if (playlistPanelDetailState.key && syncPlaylistPanelMeasuredDetailHeight(cache.detailSig)) {
    schedulePlaylistPanelVirtualRender();
  }
  bindPlaylistPanelDetailScroller();
  if (typeof requestNextPlaylistCatalogPage === 'function' && end >= cache.entries.length - 8) requestNextPlaylistCatalogPage('panel-near-end');
  if (opts.animate && seq === playlistRenderSeq) animateVisiblePanelList($pl, '.pl-card', document.getElementById('playlist-panel'));
}
function renderMyPodcastCollections(opts) {
  opts = opts || {};
  var $pod = document.getElementById('podcast-list');
  if (!$pod) return;
  if (!loginStatus.loggedIn) {
    $pod.innerHTML = playlistDetailText('pl_login_podcast_html');
    return;
  }
  var items = myPodcastCollections || [];
  if (!items.length) {
    $pod.innerHTML = playlistDetailText('pl_no_podcast_html');
    return;
  }
  $pod.innerHTML = items.map(function (pc) {
    var thumb = pc.cover ? coverUrlWithSize(pc.cover, 88) : '';
    var imgTag = thumb ? '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(0,245,212,.07);flex-shrink:0"></div>';
    return '<div class="pl-card podcast-card" data-podcast-key="' + escHtml(pc.key || '') + '" data-podcast-title="' + escHtml(pc.title || '') + '">' +
      imgTag +
      '<div style="flex:1;min-width:0"><div class="pl-name">' + escHtml(pc.title || '') + '</div><div class="pl-sub">' + (pc.count || 0) + playlistDetailText('pl_items_prefix') + escHtml(pc.sub || '') + '</div></div>' +
      '</div>';
  }).join('');
  if (opts.animate) animateVisiblePanelList($pod, '.pl-card', document.getElementById('playlist-panel'));
}
document.getElementById('pl-list').addEventListener('click', function (e) {
  var pagerBtn = e.target && e.target.closest ? e.target.closest('[data-pl-page]') : null;
  if (pagerBtn) {
    e.preventDefault();
    e.stopPropagation();
    if (!pagerBtn.disabled) gotoPlaylistPanelDetailPage(pagerBtn.getAttribute('data-pl-page') === 'next' ? 1 : -1);
    return;
  }
  var playDetail = e.target && e.target.closest ? e.target.closest('[data-pl-detail-play]') : null;
  if (playDetail) {
    e.preventDefault();
    e.stopPropagation();
    playPlaylistPanelDetail();
    return;
  }
  var collection = e.target && e.target.closest ? e.target.closest('[data-pl-detail-collection]') : null;
  if (collection) {
    e.preventDefault();
    e.stopPropagation();
    togglePlaylistPanelCollection(collection.getAttribute('data-pl-detail-collection') === '1');
    return;
  }
  var rename = e.target && e.target.closest ? e.target.closest('[data-pl-detail-rename]') : null;
  if (rename) {
    e.preventDefault();
    e.stopPropagation();
    if (playlistPanelDetailState.playlist) renameBuiltInPlaylist(playlistPanelDetailState.playlist.id, playlistPanelDetailState.playlist.name);
    return;
  }
  var removePlaylist = e.target && e.target.closest ? e.target.closest('[data-pl-detail-delete]') : null;
  if (removePlaylist) {
    e.preventDefault();
    e.stopPropagation();
    if (playlistPanelDetailState.playlist) deleteBuiltInPlaylist(playlistPanelDetailState.playlist.id, playlistPanelDetailState.playlist.name);
    return;
  }
  var removeTrack = e.target && e.target.closest ? e.target.closest('[data-pl-detail-remove]') : null;
  if (removeTrack) {
    e.preventDefault();
    e.stopPropagation();
    var detailParts = String(playlistPanelDetailState.key || '').split(':');
    if (normalizePlaylistProvider(detailParts[0]) === 'mineradio') removeTrackFromBuiltInPlaylist(detailParts.slice(1).join(':'), Number(removeTrack.getAttribute('data-pl-detail-remove')));
    return;
  }
  var artist = e.target && e.target.closest ? e.target.closest('[data-pl-detail-artist]') : null;
  if (artist) {
    e.preventDefault();
    e.stopPropagation();
    openPlaylistPanelDetailArtist(Number(artist.getAttribute('data-pl-detail-artist')));
    return;
  }
  var row = e.target && e.target.closest ? e.target.closest('[data-pl-detail-row]') : null;
  if (row) {
    e.preventDefault();
    e.stopPropagation();
    playPlaylistPanelDetailTrack(Number(row.getAttribute('data-pl-detail-row')));
    return;
  }
  var card = e.target && e.target.closest ? e.target.closest('.pl-card') : null;
  if (!card) return;
  var provider = card.getAttribute('data-playlist-provider') || 'netease';
  var pid = card.getAttribute('data-playlist-id') || '';
  openPlaylistPanelDetail(provider, pid, card.getAttribute('data-playlist-title') || '');
});
