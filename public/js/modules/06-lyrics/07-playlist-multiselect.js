// ============================================================
//  歌单 / 队列多选 → 批量加入内置歌单
//  Multi-select over the queue and the playlist detail, with a bulk "add to built-in playlist".
//
//  为什么要有它：往内置歌单加歌原本只能一首一首地开收藏弹层，几十首就是几十次点击。
//  这里把「选歌」与「决定加到哪」拆开：先在列表里多选（可全选），再一次性选中目标内置歌单。
//  选中状态按下标记录 —— 队列与歌单详情都是虚拟滚动的，滚出视野再滚回来的行靠同一个下标
//  就能恢复勾选态，不需要把整批歌的引用常驻在内存里。
//  Why this exists: adding songs to a built-in playlist used to mean opening the collect dialog
//  once per song. Selection and destination are split: pick rows first (with select-all), then
//  pick the target playlist once. Selection is keyed by row index, which is what keeps it
//  correct across the virtualised lists — a row that scrolls away and back restores its
//  checkbox from the same index instead of holding a reference to every picked song.
//
//  界面文案统一走 i18n：词典缺键时退回兜底模板，兜底也没给时露出键名，漏译要吵不要静默。
//  UI copy goes through i18n: dictionary, then the fallback template, then the key itself.
// ============================================================
function playlistMultiText(key, fallback, params) {
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

// scope: 'queue' 对应当前队列；'detail' 对应展开中的歌单详情（key 用来钉住是哪一个歌单，
// 否则换一个歌单展开后旧的勾选会莫名继承过来）。
// scope is 'queue' or 'detail'; for 'detail' the key pins down which playlist is open, so
// opening another playlist does not silently inherit the previous selection.
var playlistMultiState = { active: false, scope: '', key: '', selected: Object.create(null) };
var playlistMultiPickerSongs = [];
var playlistMultiAddBusy = false;

function playlistMultiScopeSongs() {
  if (playlistMultiState.scope === 'queue') return (typeof playQueue !== 'undefined' && playQueue) || [];
  if (playlistMultiState.scope === 'detail') {
    return (typeof playlistPanelDetailState !== 'undefined' && playlistPanelDetailState && playlistPanelDetailState.tracks) || [];
  }
  return [];
}
function playlistMultiSelectedIndices() {
  return Object.keys(playlistMultiState.selected).filter(function (key) {
    return playlistMultiState.selected[key];
  }).map(Number).filter(function (index) {
    return isFinite(index) && index >= 0;
  }).sort(function (a, b) { return a - b; });
}
function playlistMultiSelectedSongs() {
  var songs = playlistMultiScopeSongs();
  return playlistMultiSelectedIndices().map(function (index) { return songs[index]; }).filter(Boolean);
}
function playlistMultiCount() {
  return playlistMultiSelectedIndices().length;
}
function playlistMultiRowSelected(index) {
  return !!playlistMultiState.selected[Number(index)];
}
function playlistMultiActiveFor(scope, key) {
  if (!playlistMultiState.active || playlistMultiState.scope !== scope) return false;
  if (scope === 'detail') return String(playlistMultiState.key || '') === String(key || '');
  return true;
}
// 勾选框：虚拟行会被整段重建，所以状态只能由 data 决定、不能在 DOM 上留存。
// The checkbox is rebuilt with its row, so its state is derived from data, never stored in the DOM.
function playlistMultiCheckboxHtml(index) {
  return '<span class="ms-check' + (playlistMultiRowSelected(index) ? ' on' : '') + '" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.6l5.1 5.1L20 6.4"/></svg></span>';
}
function playlistMultiRowClass(index) {
  return playlistMultiRowSelected(index) ? ' ms-selected' : '';
}
function playlistMultiBuiltInRows() {
  return (typeof builtInPlaylists !== 'undefined' && builtInPlaylists) || [];
}

function playlistMultiRefreshRow(index) {
  var selector = '';
  if (playlistMultiState.scope === 'queue') selector = '#queue-list .queue-item[data-queue-index="' + Number(index) + '"]';
  else if (playlistMultiState.scope === 'detail') selector = '.pl-inline-detail[data-pl-detail] .pl-detail-row[data-pl-detail-row="' + Number(index) + '"]';
  if (!selector) return;
  var row = document.querySelector(selector);
  if (!row) return;
  var on = playlistMultiRowSelected(index);
  row.classList.toggle('ms-selected', on);
  var box = row.querySelector('.ms-check');
  if (box) box.classList.toggle('on', on);
}
function playlistMultiRefreshList() {
  if (playlistMultiState.scope === 'queue') {
    if (typeof renderQueuePanel === 'function') renderQueuePanel({ animate: false });
  } else if (playlistMultiState.scope === 'detail') {
    if (typeof renderPlaylistPanelDetailRows === 'function') renderPlaylistPanelDetailRows();
  }
}
function playlistMultiSyncEntryButtons() {
  var queueBtn = document.getElementById('queue-multiselect-btn');
  if (queueBtn) queueBtn.classList.toggle('active', playlistMultiActiveFor('queue'));
  // 详情页的多选入口是随详情头一起渲染的，进/出多选只重绘了行、没重绘头部，所以这里自己把
  // 高亮补上 —— 否则按钮看起来是「未开启」，与已经出现勾选框的列表自相矛盾。
  // The detail entry button ships with the detail header, which is not re-rendered when multi-select
  // toggles (only the rows are), so the highlight is applied here; otherwise the button reads as "off"
  // while the list is already showing checkboxes.
  var detailBtns = document.querySelectorAll('[data-pl-detail-multi]');
  for (var i = 0; i < detailBtns.length; i++) {
    var btn = detailBtns[i];
    btn.classList.toggle('active', playlistMultiActiveFor('detail', btn.getAttribute('data-pl-detail-multi')));
  }
}

function playlistMultiToggleIndex(index) {
  index = Number(index);
  if (!isFinite(index) || index < 0) return;
  if (playlistMultiState.selected[index]) delete playlistMultiState.selected[index];
  else playlistMultiState.selected[index] = true;
  playlistMultiRefreshRow(index);
  playlistMultiRenderBar();
}
function playlistMultiToggleAll() {
  var songs = playlistMultiScopeSongs();
  var all = songs.length > 0 && playlistMultiCount() >= songs.length;
  playlistMultiState.selected = Object.create(null);
  if (!all) {
    for (var i = 0; i < songs.length; i++) playlistMultiState.selected[i] = true;
  }
  playlistMultiRefreshList();
  playlistMultiRenderBar();
}

function playlistMultiEnter(scope, key) {
  playlistMultiState = { active: true, scope: scope, key: String(key || ''), selected: Object.create(null) };
  document.body.classList.add('playlist-multiselect');
  playlistMultiRefreshList();
  playlistMultiSyncEntryButtons();
  playlistMultiRenderBar();
}
function playlistMultiExit() {
  if (!playlistMultiState.active) return;
  // 先记住 scope 再清空状态：重渲染要按 scope 决定刷哪个列表。
  // Read the scope before clearing the state: the re-render picks the list by scope.
  var scope = playlistMultiState.scope;
  playlistMultiState = { active: false, scope: '', key: '', selected: Object.create(null) };
  document.body.classList.remove('playlist-multiselect');
  if (scope === 'queue' && typeof renderQueuePanel === 'function') renderQueuePanel({ animate: false });
  else if (scope === 'detail' && typeof renderPlaylistPanelDetailRows === 'function') renderPlaylistPanelDetailRows();
  playlistMultiSyncEntryButtons();
  playlistMultiRenderBar();
}
function playlistMultiToggle(scope, key) {
  var sameTarget = playlistMultiState.active && playlistMultiState.scope === scope &&
    (scope !== 'detail' || String(playlistMultiState.key || '') === String(key || ''));
  if (sameTarget) playlistMultiExit();
  else playlistMultiEnter(scope, key || '');
}

function playlistMultiRenderBar() {
  var bar = document.getElementById('playlist-multiselect-bar');
  if (!bar) return;
  var visible = !!playlistMultiState.active;
  bar.classList.toggle('show', visible);
  if (!visible) return;
  var songs = playlistMultiScopeSongs();
  var count = playlistMultiCount();
  var allSelected = songs.length > 0 && count >= songs.length;
  var allBtn = document.getElementById('ms-select-all');
  if (allBtn) {
    allBtn.textContent = allSelected
      ? playlistMultiText('ms_clear_all', '取消全选')
      : playlistMultiText('ms_select_all', '全选');
  }
  var countEl = document.getElementById('ms-count');
  if (countEl) countEl.textContent = playlistMultiText('ms_selected_count', '已选 {n} 首', { n: count });
  var addBtn = document.getElementById('ms-add');
  if (addBtn) {
    addBtn.textContent = playlistMultiText('ms_add_to_playlist', '加入歌单');
    addBtn.disabled = count === 0;
  }
  var doneBtn = document.getElementById('ms-done');
  // 复用通用的「完成」键，而不是再建一个同义的 ms_done —— 两个键中文相同、四语也别无二致，
  // 那种孪生键既不能独立翻译，又会被同文本多键守卫拦下。
  // Reuse the generic "finish" key rather than adding a twin ms_done: two keys identical in every
  // language cannot be translated independently and the same-text guard rejects the pair.
  if (doneBtn) doneBtn.textContent = playlistMultiText('btn_finish', '完成');
}

function playlistMultiRenderPicker() {
  var list = document.getElementById('bulk-playlist-list');
  if (!list) return;
  var songs = playlistMultiPickerSongs || [];
  var current = document.getElementById('bulk-playlist-current');
  if (current) {
    var preview = songs.slice(0, 3).map(function (song) { return song && (song.name || ''); }).filter(Boolean).join(' · ');
    current.innerHTML = '<div class="cover-placeholder built-in">MR</div><div style="min-width:0">' +
      '<div class="collect-title">' + escHtml(playlistMultiText('ms_selected_count', '已选 {n} 首', { n: songs.length })) + '</div>' +
      '<div class="collect-sub">' + escHtml(preview) + '</div></div>';
  }
  var rows = playlistMultiBuiltInRows().map(function (pl) {
    var thumb = pl.cover ? coverUrlWithSize(pl.cover, 80) : '';
    return '<div class="collect-item" data-bulk-pid="' + escHtml(String(pl.id || '')) + '" onclick="playlistMultiAddToPlaylist(this.getAttribute(\'data-bulk-pid\'))">' +
      (thumb ? '<img src="' + thumb + '" alt="">' : '<div class="cover-placeholder built-in">MR</div>') +
      '<div style="min-width:0"><div class="collect-title">' + escHtml(pl.name || '') + '</div>' +
      '<div class="collect-sub">' + (pl.trackCount || 0) + '</div></div></div>';
  }).join('');
  list.innerHTML = rows || '<div class="collect-empty">' + escHtml(playlistMultiText('ms_no_builtin_target', '还没有内置歌单，请先新建一个')) + '</div>';
  if (window.gsap) animateListItems(list, '.collect-item', { x: 0, y: 6, stagger: 0.012, duration: 0.18, limit: 18 });
}
function playlistMultiOpenPicker() {
  var songs = playlistMultiSelectedSongs();
  if (!songs.length) {
    if (typeof showToast === 'function') showToast(playlistMultiText('ms_pick_songs_first', '请先选择要加入的歌曲'));
    return;
  }
  playlistMultiPickerSongs = songs;
  playlistMultiRenderPicker();
  var input = document.getElementById('bulk-playlist-new-name');
  if (input) input.value = '';
  var modal = document.getElementById('bulk-playlist-modal');
  if (modal && typeof openGsapModal === 'function') openGsapModal(modal);
}
function playlistMultiClosePicker() {
  var modal = document.getElementById('bulk-playlist-modal');
  if (!modal) return;
  function clearSongs() { playlistMultiPickerSongs = []; }
  if (typeof closeGsapModal === 'function') closeGsapModal(modal, clearSongs);
  else {
    modal.classList.remove('show');
    clearSongs();
  }
}
async function playlistMultiCreateAndAdd() {
  var input = document.getElementById('bulk-playlist-new-name');
  var name = input ? String(input.value || '').trim() : '';
  if (!name) {
    if (typeof showToast === 'function') showToast(playlistMultiText('bpl_name_first', '先输入内置歌单名称'));
    return;
  }
  if (typeof createBuiltInPlaylist !== 'function') return;
  var created = await createBuiltInPlaylist(name);
  if (!created || !created.id) return;
  if (input) input.value = '';
  await playlistMultiAddToPlaylist(created.id);
}
async function playlistMultiAddToPlaylist(pid) {
  pid = String(pid || '');
  if (!pid || playlistMultiAddBusy) return;
  var songs = (playlistMultiPickerSongs || []).slice();
  if (!songs.length) return;
  if (typeof addTracksToBuiltInPlaylist !== 'function') return;
  playlistMultiAddBusy = true;
  var list = document.getElementById('bulk-playlist-list');
  if (list) list.classList.add('busy');
  try {
    var result = await addTracksToBuiltInPlaylist(pid, songs, { silentSuccess: true });
    if (!result || result.ok !== true) return;
    var target = playlistMultiBuiltInRows().filter(function (pl) { return String(pl.id || '') === pid; })[0];
    var targetName = (target && target.name) || '';
    if (result.added > 0 && result.duplicate > 0) {
      if (typeof showToast === 'function') showToast(playlistMultiText('ms_batch_added_partial', '已加入 {n} 首，{dup} 首已在歌单中', { n: result.added, dup: result.duplicate }));
    } else if (result.added > 0) {
      if (typeof showToast === 'function') showToast(playlistMultiText('ms_batch_added', '已加入 {n} 首到「{name}」', { n: result.added, name: targetName }));
    } else {
      if (typeof showToast === 'function') showToast(playlistMultiText('ms_batch_dup_all', '所选歌曲都已在「{name}」中', { name: targetName }));
    }
    playlistMultiClosePicker();
    playlistMultiExit();
  } catch (error) {
    console.warn('[PlaylistMultiSelect]', error);
    if (typeof showToast === 'function') showToast(playlistMultiText('track_builtin_add_failed', '加入内置歌单失败'));
  } finally {
    playlistMultiAddBusy = false;
    if (list) list.classList.remove('busy');
  }
}

// ── 事件接线 ────────────────────────────────────────────────────────────────
// 列表容器是常驻节点（行才被反复重建），所以监听挂在容器上、用捕获阶段抢在行内联 onclick 之前。
// stopImmediatePropagation 会吃掉同一节点上的冒泡监听：多选态下点行只切换勾选，不播放、不跳转。
// The list containers persist while their rows are rebuilt, so the listener lives on the
// container and runs in the capture phase, ahead of the row's inline onclick.
// stopImmediatePropagation also swallows the bubble-phase listeners registered on the same
// node, so in multi-select a row click only toggles the checkbox — it never plays or navigates.
function playlistMultiBind() {
  var queueList = document.getElementById('queue-list');
  if (queueList && !queueList.__msBound) {
    queueList.__msBound = true;
    queueList.addEventListener('click', function (event) {
      if (!playlistMultiActiveFor('queue')) return;
      var row = event.target && event.target.closest ? event.target.closest('.queue-item[data-queue-index]') : null;
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      playlistMultiToggleIndex(Number(row.getAttribute('data-queue-index')));
    }, true);
  }
  var plList = document.getElementById('pl-list');
  if (plList && !plList.__msBound) {
    plList.__msBound = true;
    plList.addEventListener('click', function (event) {
      var target = event.target;
      var entry = target && target.closest ? target.closest('[data-pl-detail-multi]') : null;
      if (entry) {
        event.preventDefault();
        event.stopImmediatePropagation();
        playlistMultiToggle('detail', entry.getAttribute('data-pl-detail-multi'));
        return;
      }
      if (!playlistMultiState.active || playlistMultiState.scope !== 'detail') return;
      var detail = target && target.closest ? target.closest('.pl-inline-detail[data-pl-detail]') : null;
      if (!detail || !playlistMultiActiveFor('detail', detail.getAttribute('data-pl-detail'))) return;
      var row = target.closest('.pl-detail-row[data-pl-detail-row]');
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      playlistMultiToggleIndex(Number(row.getAttribute('data-pl-detail-row')));
    }, true);
  }
  var bulkModal = document.getElementById('bulk-playlist-modal');
  if (bulkModal && !bulkModal.__msBound) {
    bulkModal.__msBound = true;
    bulkModal.addEventListener('click', function (event) {
      if (event.target === bulkModal) playlistMultiClosePicker();
    });
  }
  var bar = document.getElementById('playlist-multiselect-bar');
  if (bar && !bar.__msBound) {
    bar.__msBound = true;
    // 工具条 sticky 在面板底部，点它本身不该冒泡到「点空白收起」之类的全局监听。
    // The bar is sticky inside the panel; clicks on it must not bubble into global dismiss handlers.
    bar.addEventListener('click', function (event) { event.stopPropagation(); });
  }
}
playlistMultiBind();

// 语言切换后工具条文案是 JS 写的，data-i18n 重扫够不到它，这里手动刷新。
// The bar's labels are written by JS, so the dictionary re-scan cannot reach them; refresh here.
if (window.MineradioI18n && typeof window.MineradioI18n.onLanguageChange === 'function') {
  window.MineradioI18n.onLanguageChange(function () {
    playlistMultiRenderBar();
    var modal = document.getElementById('bulk-playlist-modal');
    if (modal && modal.classList.contains('show')) playlistMultiRenderPicker();
  });
}
