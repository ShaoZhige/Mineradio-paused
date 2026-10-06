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
var playlistPanelDetailState = { key: '', loading: false, loadingMore: false, playlist: null, tracks: [], token: 0, total: 0, nextOffset: 0, hasMore: false, scrollTop: 0, controller: null, warmTimer: 0, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER, error: '', message: '' };
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
function playlistPanelDetailRowsHtml(options) {
  options = options || {};
  var st = playlistPanelDetailState;
  var tracks = st.tracks || [];
  if (st.loading && !tracks.length) {
    return playlistDetailText('pl_first_batch_html');
  }
  if (!tracks.length) return playlistPanelNoticeHtml(st.message || st.error || '', !!st.error);
  var viewport = Math.max(280, Number(options.viewport) || Math.min(620, Math.round((window.innerHeight || 800) * 0.72)));
  var localScrollTop = Math.max(0, Number(options.scrollTop) || 0);
  var start = Math.max(0, Math.floor(localScrollTop / PLAYLIST_DETAIL_ROW_STEP) - PLAYLIST_DETAIL_VIRTUAL_OVERSCAN);
  var maxRows = Math.ceil(viewport / PLAYLIST_DETAIL_ROW_STEP) + PLAYLIST_DETAIL_VIRTUAL_OVERSCAN * 2;
  var end = Math.min(tracks.length, start + maxRows);
  start = Math.max(0, Math.min(start, Math.max(0, tracks.length - maxRows)));
  end = Math.min(tracks.length, Math.max(end, start + maxRows));
  // 多选态：行首插勾选框，并隐藏逐行移除按钮（此时点行只切换勾选，留着移除按钮是误导）。
  // In multi-select a checkbox is prefixed and the per-row remove button is hidden: a click then
  // only toggles the tick, so a visible remove button would be misleading.
  var msDetailActive = typeof playlistMultiActiveFor === 'function' && playlistMultiActiveFor('detail', st.key);
  var rows = '<div class="pl-detail-virtual-spacer" aria-hidden="true" style="height:' + (start * PLAYLIST_DETAIL_ROW_STEP) + 'px"></div>';
  rows += tracks.slice(start, end).map(function (song, localIndex) {
    var i = start + localIndex;
    var thumb = songCoverSrc(song, 60);
    var imgTag = thumb ? '<img src="' + escHtml(thumb) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:34px;height:34px;border-radius:7px;background:rgba(255,255,255,.06);flex:0 0 auto"></div>';
    var removeButton = !msDetailActive && normalizePlaylistProvider((st.key || '').split(':')[0]) === 'mineradio'
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
  rows += '<div class="pl-detail-virtual-spacer" aria-hidden="true" style="height:' + (Math.max(0, tracks.length - end) * PLAYLIST_DETAIL_ROW_STEP) + 'px"></div>';
  if (st.error) {
    rows += playlistDetailText('pl_more_failed_html');
  } else if (st.hasMore || st.loadingMore) {
    rows += '<div class="pl-detail-progress"><span class="queue-hydration-spinner' + (st.loadingMore ? ' spinning' : '') + '"></span><span>' +
      (st.loadingMore ? playlistDetailText('pl_preloading_more') : playlistDetailText('pl_scroll_more')) + tracks.length + (st.total ? '/' + st.total : '') + '</span></div>';
  } else if (tracks.length > PLAYLIST_DETAIL_INITIAL_RENDER) {
    rows += playlistDetailText('pl_loaded_all_prefix') + tracks.length + playlistDetailText('pl_tracks_suffix_html');
  }
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
  if (provider === 'mineradio') return builtInPlaylistTracksPage(id, params || {});
  return apiJson(playlistTracksEndpoint(provider, id, params), requestOptions || {});
}
function playlistPanelDetailHtml(pl, provider, detailWindow) {
  provider = normalizePlaylistProvider(provider);
  var key = playlistPanelKey(provider, pl && pl.id);
  if (playlistPanelDetailState.key !== key) return '';
  var tracks = playlistPanelDetailState.tracks || [];
  var loading = playlistPanelDetailState.loading;
  var cover = pl && pl.cover ? (provider === 'netease' ? (pl.cover + '?param=96y96') : pl.cover) : '';
  var img = cover ? '<img class="pl-detail-cover" src="' + escHtml(cover) + '" alt="" decoding="async" onerror="this.style.opacity=0.2">' : '<div class="pl-detail-cover"></div>';
  var expectedTotal = Math.max(tracks.length, Number(playlistPanelDetailState.total) || Number(pl.trackCount) || 0);
  var rows = playlistPanelDetailRowsHtml(detailWindow);
  var canUncollect = !!(pl && pl.subscribed && !pl.virtual && (provider === 'netease' || provider === 'qishui' || provider === 'spotify'));
  var collectionButton = canUncollect
    ? playlistDetailText('pl_uncollect_button')
    : '';
  var builtInActions = provider === 'mineradio'
    ? playlistDetailText('pl_rename_delete_buttons')
    : '';
  var topButton = provider === 'mineradio' ? '' : playlistDetailText('pl_top_button');
  var multiButton = '<button type="button" class="pl-detail-multi' + (typeof playlistMultiActiveFor === 'function' && playlistMultiActiveFor('detail', key) ? ' active' : '') + '" data-pl-detail-multi="' + escHtml(key) + '">' + escHtml(playlistDetailText('ms_select', '多选')) + '</button>';
  return '<div class="pl-inline-detail" data-pl-detail="' + escHtml(key) + '" style="height:' + playlistPanelDetailShellHeight() + 'px">' +
    '<div class="pl-detail-sticky">' +
    '<div class="pl-detail-head">' + img + '<div style="flex:1;min-width:0"><div class="pl-detail-title">' + escHtml(pl.name || playlistDetailText('pl_detail')) + '</div><div class="pl-detail-sub">' + escHtml((expectedTotal || tracks.length || 0) + playlistDetailText('pl_tracks_prefix') + (pl.creator || playlistProviderName(provider))) + '</div></div><div class="pl-detail-count">' + (loading && !tracks.length ? playlistDetailText('pl_loading') : (tracks.length + (expectedTotal > tracks.length ? '/' + expectedTotal : ''))) + '</div></div>' +
    '<div class="pl-detail-actions"><button class="pl-detail-play" type="button" data-pl-detail-play="' + escHtml(key) + playlistDetailText('pl_play_button_suffix') + collectionButton + builtInActions + topButton + multiButton + '</div>' +
    '</div>' +
    '<div class="pl-detail-list" data-pl-detail-scroll="' + escHtml(key) + '">' + rows + '</div>' +
    '</div>';
}
function renderPlaylistPanelDetailState() {
  renderUserPlaylistsList();
}
function scrollPlaylistPanelToTop() {
  var panel = document.getElementById('playlist-panel');
  if (!panel) return;
  try { panel.scrollTo({ top: 0, behavior: 'smooth' }); }
  catch (e) { panel.scrollTop = 0; }
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
  playlistPanelDetailState = { key: key, loading: true, loadingMore: false, playlist: pl, tracks: [], token: token, total: Number(pl.trackCount) || 0, nextOffset: 0, hasMore: true, scrollTop: 0, controller: null, warmTimer: 0, renderLimit: PLAYLIST_DETAIL_INITIAL_RENDER, error: '', message: '' };
  renderPlaylistPanelDetailState();
  scrollPlaylistPanelDetailIntoView(key);
  await loadMorePlaylistPanelDetailTracks('initial');
}
function playPlaylistPanelDetail() {
  var st = playlistPanelDetailState;
  if (!st || !st.key) return;
  var parts = st.key.split(':');
  var provider = normalizePlaylistProvider(parts[0]);
  var pid = parts.slice(1).join(':');
  loadPlaylistIntoQueueById(playlistPanelProviderId(provider, pid), true, st.playlist && st.playlist.name || '');
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
function growPlaylistPanelDetailRenderLimit(amount) {
  return loadMorePlaylistPanelDetailTracks('manual');
}
function maybeGrowPlaylistPanelDetailRenderLimit() {
  var panel = document.getElementById('playlist-panel');
  var detail = panel && panel.querySelector('.pl-inline-detail[data-pl-detail]');
  if (!panel || !detail || !playlistPanelDetailState.hasMore || playlistPanelDetailState.loadingMore) return;
  var panelRect = panel.getBoundingClientRect();
  var detailRect = detail.getBoundingClientRect();
  if (detailRect.bottom <= panelRect.bottom + PLAYLIST_DETAIL_ROW_STEP * 8) loadMorePlaylistPanelDetailTracks('scroll');
}
function resetPlaylistPanelRenderLimit() {
  playlistPanelRenderLimit = PLAYLIST_PANEL_BATCH_SIZE;
}
var playlistPanelVirtualCache = { revision: -1, detailKey: '', detailSig: '', entries: [], offsets: [0], totalHeight: 0, raf: 0 };
function playlistPanelDetailShellHeight() {
  var st = playlistPanelDetailState || {};
  var rows = Math.max(st.loading && !(st.tracks && st.tracks.length) ? 1 : 0, st.tracks && st.tracks.length || 0);
  var noticeHeight = rows ? 0 : 74;
  var footerHeight = st.error || st.hasMore || st.loadingMore || rows > PLAYLIST_DETAIL_INITIAL_RENDER ? PLAYLIST_DETAIL_OUTER_FOOTER_HEIGHT : 12;
  return PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT + rows * PLAYLIST_DETAIL_ROW_STEP + noticeHeight + footerHeight;
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
    playlistPanelDetailState.error || ''
  ].join('|');
  if (playlistPanelVirtualCache.revision === playlistCatalogRevision &&
      playlistPanelVirtualCache.detailKey === playlistPanelDetailState.key &&
      playlistPanelVirtualCache.detailSig === detailSig) return playlistPanelVirtualCache;
  var labels = { mineradio: playlistDetailText('pl_builtin'), netease: playlistDetailText('pl_netease_playlist'), qq: playlistDetailText('pl_qq_playlist'), kugou: playlistDetailText('pl_kugou_playlist'), qishui: playlistDetailText('pl_qishui_playlist'), spotify: playlistDetailText('pl_spotify_playlist') };
  var order = ['mineradio', 'netease', 'qq', 'kugou', 'qishui', 'spotify'];
  var groups = { mineradio: [], netease: [], qq: [], kugou: [], qishui: [], spotify: [] };
  userPlaylists.forEach(function (pl, sourceIndex) {
    var key = playlistPanelGroupKey(pl);
    if (!groups[key]) groups[key] = [];
    groups[key].push({ pl: pl, sourceIndex: sourceIndex });
  });
  var entries = [];
  order.forEach(function (key) {
    var items = (groups[key] || []).sort(function (a, b) {
      var priority = playlistCardPriority(a.pl) - playlistCardPriority(b.pl);
      return priority || (a.sourceIndex - b.sourceIndex);
    });
    if (!items.length) return;
    entries.push({ type: 'label', key: key, label: labels[key] || key, height: 31 });
    items.forEach(function (entry) {
      entries.push({ type: 'card', pl: entry.pl, sourceIndex: entry.sourceIndex, height: 69 });
      var cardKey = playlistPanelKey(normalizePlaylistProvider(entry.pl.provider), entry.pl.id);
      if (playlistPanelDetailState.key === cardKey) {
        entries.push({ type: 'detail', pl: entry.pl, provider: normalizePlaylistProvider(entry.pl.provider), height: playlistPanelDetailShellHeight() });
      }
    });
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
      maybeGrowPlaylistPanelDetailRenderLimit();
    }
  }, { passive: true });
}
function renderUserPlaylistsList(opts) {
  opts = opts || {};
  var $pl = document.getElementById('pl-list');
  var seq = ++playlistRenderSeq;
  if (!userPlaylists.length) {
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
    if (entry.type === 'label') html += '<div class="pl-section-label">' + entry.label + '</div>';
    else if (entry.type === 'card') html += playlistCardHtml(entry.pl, entry.sourceIndex);
    else if (entry.type === 'detail') {
      var entryTop = cache.offsets[entryIndex] || 0;
      var detailRowScrollTop = Math.max(0, visibleTop - entryTop - PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT);
      html += playlistPanelDetailHtml(entry.pl, entry.provider, { scrollTop: detailRowScrollTop, viewport: viewport });
    }
  }
  html += '<div class="playlist-virtual-spacer" aria-hidden="true" style="height:' + Math.round(bottomHeight) + 'px"></div>' + playlistCatalogFooterHtml();
  $pl.innerHTML = html;
  if (panel && opts.preserveScroll) panel.scrollTop = keepTop;
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
  var loadMore = e.target && e.target.closest ? e.target.closest('[data-pl-load-more]') : null;
  if (loadMore) {
    e.preventDefault();
    e.stopPropagation();
    growPlaylistPanelDetailRenderLimit('manual');
    return;
  }
  var detailLoadMore = e.target && e.target.closest ? e.target.closest('[data-pl-detail-load-more]') : null;
  if (detailLoadMore) {
    e.preventDefault();
    e.stopPropagation();
    growPlaylistPanelDetailRenderLimit();
    return;
  }
  var detailTop = e.target && e.target.closest ? e.target.closest('[data-pl-detail-top]') : null;
  if (detailTop) {
    e.preventDefault();
    e.stopPropagation();
    scrollPlaylistPanelToTop();
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
