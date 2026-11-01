// 歌单文件分享：把任何一个歌单（内置或平台）导成一份 JSON，别人拖进来就变成他自己的内置歌单。
//
// 为什么不做分享链接：链接要么绑平台自己的分享接口（跨平台立刻失效），要么要求对方登录同一个
// 账号；文件谁都能收、能自己打开看、也能手改。导出的每条曲目都带 provider + 平台 id，导入方
// 有同一个平台账号时能直接放；没有时歌名歌手仍在，靠搜索也能找回来。
//
// Why not a share link: a link is tied to one platform's share endpoint or to the same account.
// A file travels anywhere and stays readable. Each track keeps its provider + platform id, so the
// same platform resolves it straight back into something playable.
function playlistTransferText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === 'object') {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}

// 一次拉 200 首：太小会让长歌单发几十个请求，太大又会被平台接口截断。
// 200 per page: smaller floods a long playlist with requests, larger gets truncated upstream.
var PLAYLIST_TRANSFER_BATCH = 200;
var PLAYLIST_TRANSFER_MAX_TRACKS = 5000;
// 50 页是硬上限，防止某个平台的接口一直回 hasMore 把这里拖死。
// 50 pages is the hard stop in case an endpoint keeps answering hasMore.
var PLAYLIST_TRANSFER_MAX_PAGES = 50;
var playlistTransferBusy = false;

function playlistTransferApi() {
  var api = (typeof window !== 'undefined' && window.desktopWindow) || null;
  if (!api || typeof api.exportPlaylistFile !== 'function' || typeof api.importPlaylistFile !== 'function') return null;
  return api;
}

// 与 03-content-list-manager 里那串三元保持同一套地址；改任何一条都要两边一起改。
// Same endpoints as the triple nested ternary in 03-content-list-manager — change both.
function playlistTransferTracksUrl(provider, id, limit, offset) {
  var base = '';
  if (provider === 'qq') base = '/api/qq/playlist/tracks';
  else if (provider === 'kugou') base = '/api/kugou/playlist/tracks';
  else if (provider === 'qishui') base = '/api/qishui/playlist/tracks';
  else if (provider === 'spotify') base = '/api/spotify/playlist/tracks';
  else base = '/api/playlist/tracks';
  return base + '?id=' + encodeURIComponent(id)
    + '&limit=' + encodeURIComponent(limit)
    + '&offset=' + encodeURIComponent(offset);
}

async function playlistTransferFetchAllTracks(provider, id) {
  var collected = [];
  var offset = 0;
  for (var page = 0; page < PLAYLIST_TRANSFER_MAX_PAGES; page += 1) {
    var batch = null;
    if (provider === 'mineradio') {
      batch = await builtInPlaylistTracksPage(id, { limit: PLAYLIST_TRANSFER_BATCH, offset: offset });
      if (!batch || batch.ok !== true) {
        throw new Error((batch && batch.error) || 'PLAYLIST_TRANSFER_READ_FAILED');
      }
    } else {
      batch = await apiJson(playlistTransferTracksUrl(provider, id, PLAYLIST_TRANSFER_BATCH, offset), { timeoutMs: 15000 });
      if (!batch || batch.error) {
        throw new Error((batch && batch.error) || 'PLAYLIST_TRANSFER_READ_FAILED');
      }
    }
    var tracks = Array.isArray(batch.tracks) ? batch.tracks : [];
    if (!tracks.length) break;
    collected = collected.concat(tracks);
    if (!batch.hasMore || collected.length >= PLAYLIST_TRANSFER_MAX_TRACKS) break;
    var next = Number(batch.nextOffset);
    offset = Number.isFinite(next) && next > offset ? next : offset + tracks.length;
  }
  return collected.slice(0, PLAYLIST_TRANSFER_MAX_TRACKS);
}

function playlistTransferErrorMessage(result, fallback) {
  var code = String(result && result.error || '');
  if (code === 'PLAYLIST_TRANSFER_EMPTY') return playlistTransferText('pl_import_empty');
  if (code === 'PLAYLIST_TRANSFER_NOTHING_ADDED') return playlistTransferText('pl_import_all_dup');
  if (code === 'PLAYLIST_TRANSFER_INVALID_JSON'
    || code === 'PLAYLIST_TRANSFER_FOREIGN_FORMAT'
    || code === 'PLAYLIST_TRANSFER_NO_TRACKS') return playlistTransferText('pl_file_invalid');
  if (code === 'PLAYLIST_TRANSFER_TOO_LARGE') return playlistTransferText('pl_file_too_large');
  if (code === 'BUILT_IN_PLAYLIST_LIMIT_REACHED') return playlistTransferText('bpl_count_limit');
  if (code === 'BUILT_IN_PLAYLIST_INDEX_TOO_LARGE') return playlistTransferText('bpl_storage_full');
  if (code === 'BUILT_IN_PLAYLIST_TRACK_LIMIT_REACHED') return playlistTransferText('bpl_playlist_full');
  return fallback || playlistTransferText('pl_import_failed');
}

// 导出任意一个非虚拟歌单。虚拟歌单（本地曲库）不导出：它的曲目 id 绑的是本机文件，
// 换台机器只剩一堆点不响的灰条，导出去没有意义。
// Exports any non-virtual playlist. The virtual local library is excluded: its ids point at files
// on this machine and would arrive as unplayable grey rows elsewhere.
async function exportPlaylistToFile(provider, id, name) {
  var api = playlistTransferApi();
  if (!api) {
    if (typeof showToast === 'function') showToast(playlistTransferText('pl_export_failed'));
    return false;
  }
  if (playlistTransferBusy) return false;
  provider = typeof normalizePlaylistProvider === 'function' ? normalizePlaylistProvider(provider) : String(provider || 'netease');
  id = String(id || '');
  if (!id) return false;
  playlistTransferBusy = true;
  try {
    if (typeof showToast === 'function') showToast(playlistTransferText('pl_export_reading'));
    var tracks = await playlistTransferFetchAllTracks(provider, id);
    if (!tracks.length) {
      if (typeof showToast === 'function') showToast(playlistTransferText('pl_export_empty'));
      return false;
    }
    var result = await api.exportPlaylistFile({
      name: String(name || '').trim(),
      tracks: tracks,
    });
    if (!result || result.canceled) return false;
    if (result.ok !== true) {
      if (typeof showToast === 'function') showToast(playlistTransferErrorMessage(result, playlistTransferText('pl_export_failed')));
      return false;
    }
    if (typeof showToast === 'function') {
      showToast(playlistTransferText('pl_export_done', '已导出 {count} 首', { count: Number(result.count) || tracks.length }));
    }
    return true;
  } catch (error) {
    console.warn('[PlaylistTransfer] export failed:', error);
    if (typeof showToast === 'function') showToast(playlistTransferText('pl_export_failed'));
    return false;
  } finally {
    playlistTransferBusy = false;
  }
}

// 导入：文件选择、解析、建歌单、批量落曲目全在主进程一次做完，这里只负责把界面切回能看见它的
// 位置。不切页签的话，用户在「当前队列」里点导入会看到一条"已导入"却找不到歌单。
// Import does the whole read → parse → create → bulk-add in the main process; the renderer only
// switches the panel to where the new playlist lives. Without that switch the toast says "imported"
// while the user is staring at the queue tab and cannot find anything.
async function importPlaylistFromFile() {
  var api = playlistTransferApi();
  if (!api) {
    if (typeof showToast === 'function') showToast(playlistTransferText('pl_import_failed'));
    return false;
  }
  if (playlistTransferBusy) return false;
  playlistTransferBusy = true;
  try {
    var result = await api.importPlaylistFile();
    if (!result || result.canceled) return false;
    if (result.ok !== true) {
      if (typeof showToast === 'function') showToast(playlistTransferErrorMessage(result, playlistTransferText('pl_import_failed')));
      return false;
    }
    if (typeof switchPlaylistTab === 'function') switchPlaylistTab('playlists');
    if (typeof setPlaylistPanelActiveProvider === 'function') setPlaylistPanelActiveProvider('mineradio');
    if (typeof refreshBuiltInPlaylists === 'function') await refreshBuiltInPlaylists(true);
    if (typeof showToast === 'function') {
      showToast(playlistTransferText('pl_import_done', '已导入 {count} 首', { count: Number(result.added) || 0 }));
    }
    return true;
  } catch (error) {
    console.warn('[PlaylistTransfer] import failed:', error);
    if (typeof showToast === 'function') showToast(playlistTransferText('pl_import_failed'));
    return false;
  } finally {
    playlistTransferBusy = false;
  }
}

// 详情按钮行里的「导出」：key 是 playlistPanelKey(provider, id) 拼出来的 "provider:id"。
// The export button in the detail action row; `key` is the "provider:id" panel key.
function exportPlaylistByPanelKey(key, name) {
  var raw = String(key || '');
  var cut = raw.indexOf(':');
  if (cut <= 0) return Promise.resolve(false);
  return exportPlaylistToFile(raw.slice(0, cut), raw.slice(cut + 1), name);
}
