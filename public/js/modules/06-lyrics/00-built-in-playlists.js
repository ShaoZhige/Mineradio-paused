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
function builtInPlaylistsText(key, fallback, params) {
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
function normalizeBuiltInPlaylistRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(function (playlist) {
    return Object.assign({}, playlist, {
      provider: 'mineradio',
      source: 'mineradio',
      builtin: true,
      creator: playlist.creator || 'Mineradio',
      shelfPane: 'mine',
      subscribed: false
    });
  }).filter(function (playlist) { return !!playlist.id; });
}

function applyBuiltInPlaylistSnapshot(result, opts) {
  opts = opts || {};
  if (!result || result.ok !== true) return false;
  builtInPlaylists = normalizeBuiltInPlaylistRows(result.playlists);
  if (typeof rebuildUserPlaylistsFromCatalog === 'function') {
    rebuildUserPlaylistsFromCatalog({
      animate: !!opts.animate,
      preserveScroll: opts.preserveScroll !== false,
      reason: opts.reason || 'built-in-playlists'
    });
  } else {
    userPlaylists = builtInPlaylists.concat(neteasePlaylists, qqPlaylists, kugouPlaylists, qishuiPlaylists, spotifyPlaylists);
    playlistCatalogRevision += 1;
  }
  return true;
}

function builtInPlaylistApiAvailable() {
  return !!(window.desktopWindow && typeof window.desktopWindow.listBuiltInPlaylists === 'function');
}

function builtInPlaylistErrorMessage(result, fallback) {
  var code = String(result && result.error || '');
  if (code === 'BUILT_IN_PLAYLIST_LIMIT_REACHED') return builtInPlaylistsText('bpl_count_limit');
  if (code === 'BUILT_IN_PLAYLIST_TRACK_LIMIT_REACHED') return builtInPlaylistsText('bpl_playlist_full');
  if (code === 'BUILT_IN_PLAYLIST_INDEX_TOO_LARGE') return builtInPlaylistsText('bpl_storage_full');
  if (code === 'BUILT_IN_PLAYLIST_TRACK_INVALID') return builtInPlaylistsText('bpl_no_source_id');
  if (code === 'BUILT_IN_PLAYLIST_NOT_FOUND') return builtInPlaylistsText('bpl_gone');
  return fallback || builtInPlaylistsText('bpl_op_failed');
}

function refreshBuiltInPlaylists(force) {
  if (!builtInPlaylistApiAvailable()) return Promise.resolve(false);
  if (builtInPlaylistLoadPromise && !force) return builtInPlaylistLoadPromise;
  var request = window.desktopWindow.listBuiltInPlaylists().then(function (result) {
    if (!result || result.ok !== true) throw new Error(result && result.error || 'BUILT_IN_PLAYLIST_READ_FAILED');
    applyBuiltInPlaylistSnapshot(result, { preserveScroll: true, reason: 'built-in-playlists-refresh' });
    return true;
  }).catch(function (error) {
    console.warn('[BuiltInPlaylists]', error);
    return false;
  }).finally(function () {
    if (builtInPlaylistLoadPromise === request) builtInPlaylistLoadPromise = null;
  });
  builtInPlaylistLoadPromise = request;
  return request;
}

async function builtInPlaylistTracksPage(id, options) {
  if (!builtInPlaylistApiAvailable() || typeof window.desktopWindow.readBuiltInPlaylist !== 'function') {
    return { ok: false, playlist: null, tracks: [], total: 0, hasMore: false, error: 'BUILT_IN_PLAYLIST_UNAVAILABLE' };
  }
  return window.desktopWindow.readBuiltInPlaylist(String(id || ''), options || {});
}

async function createBuiltInPlaylist(name, initialTrack) {
  name = String(name || '').trim();
  if (!name) {
    if (typeof showToast === 'function') showToast(builtInPlaylistsText('bpl_name_first'));
    return null;
  }
  if (!builtInPlaylistApiAvailable() || typeof window.desktopWindow.createBuiltInPlaylist !== 'function') {
    if (typeof showToast === 'function') showToast(builtInPlaylistsText('bpl_save_env_denied'));
    return null;
  }
  var result = await window.desktopWindow.createBuiltInPlaylist(name);
  if (!result || result.ok !== true || !result.playlist) {
    if (typeof showToast === 'function') showToast(builtInPlaylistErrorMessage(result, builtInPlaylistsText('track_builtin_create_failed')));
    return null;
  }
  applyBuiltInPlaylistSnapshot(result, { animate: true, reason: 'built-in-playlist-create' });
  if (initialTrack) {
    var added = await addTrackToBuiltInPlaylist(result.playlist.id, initialTrack, { silentSuccess: true });
    if (!added) return result.playlist;
  }
  if (typeof showToast === 'function') showToast(builtInPlaylistsText('bpl_created'));
  return result.playlist;
}

function promptCreateBuiltInPlaylist() {
  // Electron 渲染进程从未实现 window.prompt，调用即抛异常（原来的裸调用会直接冒到
  // window.onerror）。改用自绘输入弹层，取消时返回 null。
  // 中英对照：Electron's renderer never implemented window.prompt and throws when called, so
  // this flow uses the in-app dialog. Cancelling resolves null.
  if (typeof requestMineradioTextInput !== 'function') {
    if (typeof showToast === 'function') showToast(builtInPlaylistsText('bpl_create_env_denied'));
    return;
  }
  requestMineradioTextInput({
    title: builtInPlaylistsText('bpl_create_title'),
    value: builtInPlaylistsText('home_my_playlists', '我的歌单'),
    maxLength: 40,
    confirmText: builtInPlaylistsText('collect_create', '创建'),
    hint: builtInPlaylistsText('bpl_name_hint'),
    emptyMessage: builtInPlaylistsText('bpl_enter_name')
  }).then(function (name) {
    if (name == null) return null;
    return createBuiltInPlaylist(name).catch(function (error) {
      console.warn('[BuiltInPlaylistCreate]', error);
      if (typeof showToast === 'function') showToast(builtInPlaylistsText('track_builtin_create_failed'));
      return null;
    });
  }).catch(function (error) {
    console.warn('[BuiltInPlaylistCreate]', error);
    if (typeof showToast === 'function') showToast(builtInPlaylistsText('track_builtin_create_failed'));
  });
}

async function addTrackToBuiltInPlaylist(id, track, opts) {
  opts = opts || {};
  if (!builtInPlaylistApiAvailable() || typeof window.desktopWindow.addBuiltInPlaylistTrack !== 'function') return false;
  var result = await window.desktopWindow.addBuiltInPlaylistTrack(String(id || ''), track || {});
  if (!result || result.ok !== true) {
    if (typeof showToast === 'function') showToast(builtInPlaylistErrorMessage(result, builtInPlaylistsText('track_builtin_add_failed')));
    return false;
  }
  applyBuiltInPlaylistSnapshot(result, { preserveScroll: true, reason: 'built-in-playlist-add-track' });
  if (typeof showToast === 'function' && !opts.silentSuccess) showToast(result.duplicate ? builtInPlaylistsText('bpl_already_in') : builtInPlaylistsText('bpl_added'));
  return result.duplicate ? 'duplicate' : true;
}

async function removeTrackFromBuiltInPlaylist(id, index) {
  if (!builtInPlaylistApiAvailable() || typeof window.desktopWindow.removeBuiltInPlaylistTrack !== 'function') return false;
  var result = await window.desktopWindow.removeBuiltInPlaylistTrack(String(id || ''), Number(index));
  if (!result || result.ok !== true) {
    if (typeof showToast === 'function') showToast(builtInPlaylistErrorMessage(result, builtInPlaylistsText('bpl_remove_failed')));
    return false;
  }
  if (playlistPanelDetailState && playlistPanelDetailState.key === 'mineradio:' + String(id || '')) {
    playlistPanelDetailState.tracks.splice(Number(index), 1);
    playlistPanelDetailState.total = Math.max(0, playlistPanelDetailState.tracks.length);
    playlistPanelDetailState.nextOffset = playlistPanelDetailState.tracks.length;
    playlistPanelDetailState.hasMore = false;
  }
  applyBuiltInPlaylistSnapshot(result, { preserveScroll: true, reason: 'built-in-playlist-remove-track' });
  if (typeof showToast === 'function') showToast(builtInPlaylistsText('bpl_removed'));
  return true;
}

async function renameBuiltInPlaylist(id, currentName) {
  // 同上：window.prompt 不可用；这里必须 await，否则拿不到用户输入。
  // 中英对照：Same reason as above. The dialog must be awaited to obtain the new name.
  if (typeof requestMineradioTextInput !== 'function') {
    if (typeof showToast === 'function') showToast(builtInPlaylistsText('bpl_rename_cancelled'));
    return false;
  }
  var name = await requestMineradioTextInput({
    title: builtInPlaylistsText('bpl_rename_title'),
    value: String(currentName || ''),
    maxLength: 40,
    confirmText: builtInPlaylistsText('bpl_rename'),
    emptyMessage: builtInPlaylistsText('bpl_enter_new_name')
  });
  if (name == null || !String(name).trim()) return false;
  var result = await window.desktopWindow.renameBuiltInPlaylist(String(id || ''), String(name).trim());
  if (!result || result.ok !== true) {
    if (typeof showToast === 'function') showToast(builtInPlaylistErrorMessage(result, builtInPlaylistsText('bpl_rename_failed')));
    return false;
  }
  if (playlistPanelDetailState && playlistPanelDetailState.key === 'mineradio:' + String(id || '') && playlistPanelDetailState.playlist) {
    playlistPanelDetailState.playlist.name = String(name).trim();
  }
  applyBuiltInPlaylistSnapshot(result, { preserveScroll: true, reason: 'built-in-playlist-rename' });
  if (typeof showToast === 'function') showToast(builtInPlaylistsText('bpl_renamed'));
  return true;
}

async function deleteBuiltInPlaylist(id, currentName) {
  if (!window.confirm(builtInPlaylistsText('bpl_delete_confirm_prefix') + String(currentName || builtInPlaylistsText('bpl_unnamed')) + builtInPlaylistsText('bpl_delete_confirm_suffix'))) return false;
  var result = await window.desktopWindow.deleteBuiltInPlaylist(String(id || ''));
  if (!result || result.ok !== true) {
    if (typeof showToast === 'function') showToast(builtInPlaylistErrorMessage(result, builtInPlaylistsText('bpl_delete_failed')));
    return false;
  }
  if (playlistPanelDetailState && playlistPanelDetailState.key === 'mineradio:' + String(id || '')) {
    cancelPlaylistPanelDetailRequest();
    playlistPanelDetailState.key = '';
    playlistPanelDetailState.tracks = [];
    playlistPanelDetailState.playlist = null;
  }
  applyBuiltInPlaylistSnapshot(result, { preserveScroll: true, reason: 'built-in-playlist-delete' });
  if (typeof showToast === 'function') showToast(builtInPlaylistsText('bpl_deleted'));
  return true;
}
