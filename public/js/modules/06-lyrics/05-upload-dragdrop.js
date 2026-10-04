// 本模块界面文案统一走 i18n；词典是唯一文案来源，缺键时退回内置中文模板。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：xxxText('key') 缺键返回键名；xxxText('key', '兜底') 显式指定缺键时显示什么；
// xxxText('key', '含 {p} 的模板', {p: v}) 带插值，params 同时喂给 t() 与兜底模板。
// Two call shapes: key-only shows the bare key on a miss; an explicit fallback says what to
// show instead; params interpolate into both the dictionary hit and the fallback template.
function uploadDragdropText(key, fallback, params) {
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

// ============================================================
var AUDIO_UPLOAD_EXT_RE = /\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i;
var IMAGE_UPLOAD_EXT_RE = /\.(jpg|jpeg|png|webp)$/i;
function isAudioUploadFile(file) {
  if (!file) return false;
  return /^audio\//i.test(file.type || '') || AUDIO_UPLOAD_EXT_RE.test(file.name || '');
}
function isImageUploadFile(file) {
  if (!file) return false;
  return /^image\//i.test(file.type || '') || IMAGE_UPLOAD_EXT_RE.test(file.name || '');
}
function uploadFileSortKey(file) {
  return String((file && (file.webkitRelativePath || file.name)) || '').toLowerCase();
}
function sortedAudioUploadFiles(files) {
  return Array.prototype.slice.call(files || [])
    .filter(isAudioUploadFile)
    .sort(function (a, b) {
      return uploadFileSortKey(a).localeCompare(uploadFileSortKey(b), 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
}
function firstImageUploadFile(files) {
  var list = Array.prototype.slice.call(files || []);
  for (var i = 0; i < list.length; i++) if (isImageUploadFile(list[i])) return list[i];
  return null;
}
function localSongFromAudioFile(file) {
  var rel = String(file.webkitRelativePath || file.name || '');
  var filename = String(file.name || rel || uploadDragdropText('discover_local_music'));
  var title = filename.replace(/\.[^.]+$/, '');
  return hydrateCustomCover({
    type: 'local',
    source: 'local',
    provider: 'local',
    name: title || uploadDragdropText('discover_local_music'),
    artist: uploadDragdropText('track_local_file'),
    album: rel && rel !== filename ? rel.split(/[\\/]/).slice(0, -1).join(' / ') : '',
    localKey: [rel || filename, file.size || 0, file.lastModified || 0].join(':'),
    localUrl: URL.createObjectURL(file),
    localPath: rel,
    duration: 0
  });
}
function canUsePersistentLocalMusicLibrary() {
  return !!(
    window.desktopWindow &&
    typeof window.desktopWindow.importLocalMusicFiles === 'function'
  );
}
async function importPersistentLocalAudioFiles(files) {
  if (!canUsePersistentLocalMusicLibrary()) return null;
  var selectedFiles = Array.prototype.slice.call(files || []);
  if (!selectedFiles.length) return null;
  var result = await window.desktopWindow.importLocalMusicFiles(selectedFiles);
  if (!result || result.ok !== true || !Array.isArray(result.tracks) || !result.tracks.length) {
    throw new Error(result && result.error || 'LOCAL_LIBRARY_IMPORT_FAILED');
  }
  return result;
}
function isLocalPlaybackSnapshot(snapshot) {
  var song = snapshot && snapshot.current;
  return !!(song && (song.type === 'local' || song.source === 'local' || song.localKey || song.localFileId));
}
function restoredLocalTrackIndex(tracks, snapshot) {
  var current = snapshot && snapshot.current || {};
  var localId = String(current.localFileId || current.localKey || '').replace(/^local:/, '');
  if (localId) {
    for (var i = 0; i < tracks.length; i++) {
      var songId = String(tracks[i].localFileId || tracks[i].localKey || '').replace(/^local:/, '');
      if (songId === localId) return i;
    }
    return -1;
  }
  var fallback = Number(snapshot && snapshot.currentIdx);
  return isFinite(fallback) && fallback >= 0 && fallback < tracks.length ? Math.round(fallback) : 0;
}
// 监视到曲库增删后的轻量刷新：只更新列表并重绘，不碰播放状态。
// 启动恢复那条路会顺手恢复播放快照，监视触发时不能走它——那会把正在放的歌打断。
// A light refresh after a watched change: update the list and repaint, nothing else. The startup
// restore path also restores the playback snapshot, which must not run here — it would interrupt
// whatever happens to be playing.
async function refreshPersistentLocalLibraryTracks() {
  if (!window.desktopWindow || typeof window.desktopWindow.listLocalMusicLibrary !== 'function') return 0;
  var result;
  try { result = await window.desktopWindow.listLocalMusicLibrary(); } catch (e) { return 0; }
  if (!result || result.ok !== true || !Array.isArray(result.tracks)) return 0;
  var tracks = result.tracks.map(function (song) {
    var copy = hydrateCustomCover(Object.assign({}, song));
    copy.localMissing = false;
    return copy;
  }).filter(function (song) { return song && song.localUrl && song.localKey; });
  persistentLocalLibraryTracks = tracks.map(cloneSong);
  safeRenderQueuePanel('local-library-watch');
  return tracks.length;
}

function bindPersistentLocalLibraryWatch() {
  if (!window.desktopWindow || typeof window.desktopWindow.onLocalMusicLibraryChanged !== 'function') return false;
  window.desktopWindow.onLocalMusicLibraryChanged(function (change) {
    var added = Number(change && change.added) || 0;
    var removed = Number(change && change.removed) || 0;
    refreshPersistentLocalLibraryTracks().then(function (total) {
      if (added > 0) showToast(uploadDragdropText('upload_auto_added') + added + uploadDragdropText('upload_songs_current') + total + uploadDragdropText('upload_songs_close'));
      else if (removed > 0) showToast(uploadDragdropText('upload_auto_removed') + removed + uploadDragdropText('upload_moved_suffix'));
    });
  });
  return true;
}

async function restorePersistedLocalLibrary() {
  if (!window.desktopWindow || typeof window.desktopWindow.listLocalMusicLibrary !== 'function') return false;
  var snapshotAtRequest = restoredLastPlaybackSnapshot;
  var queueAtRequest = playQueue;
  var indexAtRequest = currentIdx;
  var localSongAtRequest = currentLocalSong;
  var result;
  try { result = await window.desktopWindow.listLocalMusicLibrary(); } catch (e) { return false; }
  if (!result || result.ok !== true || !Array.isArray(result.tracks)) return false;
  var tracks = result.tracks.map(function (song) {
    var copy = hydrateCustomCover(Object.assign({}, song));
    copy.localMissing = false;
    return copy;
  }).filter(function (song) { return song && song.localUrl && song.localKey; });
  // 主进程会把"文件已不存在"的记录（拔盘 / 改名 / 移动产生）从列表里过滤掉。
  // 这里把被跳过的数量透出给用户，避免曲目无声消失。
  // 中英对照：The main process filters out records whose file is gone; surface the skipped
  // count so tracks do not disappear without explanation.
  if (Number(result.missing) > 0) {
    showToast(uploadDragdropText('upload_has_prefix') + Number(result.missing) + uploadDragdropText('upload_skipped_unavailable'));
  }
  persistentLocalLibraryTracks = tracks.map(cloneSong);
  var snapshot = snapshotAtRequest;
  if (snapshot && !isLocalPlaybackSnapshot(snapshot)) return false;
  if (
    restoredLastPlaybackSnapshot !== snapshotAtRequest
    || playQueue !== queueAtRequest
    || currentIdx !== indexAtRequest
    || currentLocalSong !== localSongAtRequest
  ) return false;
  if (snapshot) {
    var restoredIndex = restoredLocalTrackIndex(tracks, snapshot);
    if (restoredIndex < 0 || !tracks[restoredIndex]) {
      playQueue = tracks;
      currentIdx = -1;
      currentLocalSong = null;
      pendingPlaybackResumeAt = 0;
      restoredLastPlaybackSnapshot = null;
      startupRestoreHomePending = false;
      try { localStorage.removeItem(LAST_PLAYBACK_STORE_KEY); } catch (e) { }
      applyRestoredPlaybackProgressUi({ currentTime: 0, duration: 0, current: null });
      safeRenderQueuePanel('local-library-missing');
      updateEmptyHomeVisibility({ forceLoad: false });
      return false;
    }
    currentIdx = restoredIndex;
  } else {
    currentIdx = -1;
  }
  playQueue = tracks;
  currentLocalSong = null;
  if (!snapshot) {
    safeRenderQueuePanel('local-library-restore');
    updateEmptyHomeVisibility({ forceLoad: false });
    return false;
  }
  var current = playQueue[currentIdx];
  if (!current) return false;
  snapshot.current = playbackRestoreSongSnapshot(current);
  snapshot.current.localMissing = false;
  updateControlTrackInfo(current);
  var titleEl = document.getElementById('thumb-title');
  var artistEl = document.getElementById('thumb-artist');
  if (titleEl) titleEl.textContent = current.name || current.title || uploadDragdropText('discover_local_music');
  if (artistEl) artistEl.textContent = current.artist || uploadDragdropText('track_local_file');
  var thumbWrap = document.getElementById('thumb-wrap');
  if (thumbWrap) thumbWrap.classList.add('visible');
  if (current.cover) {
    setTimeout(function () {
      if (!audio && currentIdx >= 0 && playQueue[currentIdx] && queueItemKey(playQueue[currentIdx]) === queueItemKey(current)) {
        loadCoverFromUrl(songCoverSrc(current, 400), { deferHeavy: true, delay: 120, timeout: 700 });
      }
    }, 180);
  }
  safeRenderQueuePanel('local-library-restore', { scrollCurrent: miniQueueOpen });
  updateEmptyHomeVisibility({ forceLoad: false });
  return true;
}
function loadPersistedLocalLibraryIntoQueue() {
  if (!Array.isArray(persistentLocalLibraryTracks) || !persistentLocalLibraryTracks.length) return false;
  return importLocalAudioSongs(persistentLocalLibraryTracks.map(cloneSong), { mode: 'persistent-library' });
}
var uploadFilePickerActiveUntil = 0;
var uploadFilePickerFocusArmed = false;
var uploadFilePickerFocusTimer = null;
function uploadImportNow() {
  return (window.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
}
function isUploadPanelOpen() {
  var panel = document.getElementById('upload-panel');
  return !!(panel && panel.classList.contains('show'));
}
function pinUploadSearchArea() {
  var area = document.getElementById('search-area');
  if (area && typeof setPeek === 'function') setPeek(area, true, 'search');
}
function keepUploadImportActive(ms) {
  uploadFilePickerActiveUntil = Math.max(uploadFilePickerActiveUntil, uploadImportNow() + (ms || 12000));
  pinUploadSearchArea();
}
function isUploadImportActive() {
  return isUploadPanelOpen() || uploadImportNow() < uploadFilePickerActiveUntil;
}
function clearUploadFilePickerFocusTimer() {
  if (uploadFilePickerFocusTimer) {
    clearTimeout(uploadFilePickerFocusTimer);
    uploadFilePickerFocusTimer = null;
  }
}
function disarmUploadFilePickerFocus() {
  if (!uploadFilePickerFocusArmed) return;
  uploadFilePickerFocusArmed = false;
  window.removeEventListener('focus', handleUploadFilePickerFocus);
}
function handleUploadFilePickerFocus() {
  disarmUploadFilePickerFocus();
  keepUploadImportActive(900);
  clearUploadFilePickerFocusTimer();
  uploadFilePickerFocusTimer = setTimeout(function () {
    uploadFilePickerFocusTimer = null;
    uploadFilePickerActiveUntil = 0;
    if (isUploadPanelOpen()) closeUploadPanel();
  }, 900);
}
function armUploadFilePickerFocus() {
  disarmUploadFilePickerFocus();
  uploadFilePickerFocusArmed = true;
  window.addEventListener('focus', handleUploadFilePickerFocus);
}
function finishUploadFilePicker(closePanel) {
  uploadFilePickerActiveUntil = 0;
  clearUploadFilePickerFocusTimer();
  disarmUploadFilePickerFocus();
  if (closePanel) closeUploadPanel({ keepPicker: true });
}
function openUploadPanel() {
  closeUploadTip(false);
  var actions = document.getElementById('upload-actions');
  var panel = document.getElementById('upload-panel');
  if (!panel) return;
  var hidden = !actions;
  if (!hidden) {
    try {
      var style = getComputedStyle(actions);
      hidden = style.display === 'none' || style.visibility === 'hidden' || actions.getClientRects().length === 0;
    } catch (e) { }
  }
  if (hidden) {
    triggerUploadInput('audio');
    return;
  }
  panel.classList.add('show');
  pinUploadSearchArea();
}
function closeUploadPanel(opts) {
  opts = opts || {};
  if (!opts.keepPicker) uploadFilePickerActiveUntil = 0;
  var panel = document.getElementById('upload-panel');
  if (panel) panel.classList.remove('show');
}
function toggleUploadPanel(event) {
  if (event) event.stopPropagation();
  var panel = document.getElementById('upload-panel');
  if (!panel) return;
  if (panel.classList.contains('show')) closeUploadPanel();
  else openUploadPanel();
}
function triggerUploadInput(kind) {
  var id = kind === 'cover' ? 'cover-input' : (kind === 'folder' ? 'folder-input' : 'file-input');
  var input = document.getElementById(id);
  if (!input) {
    closeUploadPanel();
    return;
  }
  keepUploadImportActive(kind === 'folder' ? 120000 : 45000);
  armUploadFilePickerFocus();
  try {
    input.click();
  } catch (e) {
    console.warn('[LocalImport] failed to open file picker', e);
    finishUploadFilePicker(false);
  }
}
function importLocalAudioSongs(songs, opts) {
  opts = opts || {};
  songs = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (!songs.length) return false;
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  playQueue = songs.map(cloneSong);
  currentIdx = 0;
  currentLocalSong = null;
  activeRadioContext = null;
  safeRenderQueuePanel('local-import', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('local-import', true);
  forcePlaybackControlsInteractive();
  updateEmptyHomeVisibility({ forceLoad: false });
  showToast(songs.length > 1 ? (uploadDragdropText('upload_imported') + songs.length + uploadDragdropText('upload_local_songs_suffix')) : uploadDragdropText('upload_playing_local'));
  Promise.resolve(playQueueAt(0, { manual: true })).then(function () {
    if (opts.coverFile && currentIdx === 0 && playQueue[0]) {
      loadCoverFromFile(opts.coverFile, { trackToken: trackSwitchToken, deferHeavy: false, delay: 0, timeout: 260 });
    }
  }).catch(function (e) { console.warn('[LocalImport]', e); });
  return true;
}
function handleCoverFiles(files) {
  finishUploadFilePicker(true);
  var imgFile = firstImageUploadFile(files);
  if (!imgFile) {
    showToast(uploadDragdropText('upload_no_cover'));
    return;
  }
  loadCoverFromFile(imgFile, null);
  updateCustomCoverButton();
}
async function handleFiles(files, opts) {
  finishUploadFilePicker(true);
  opts = opts || {};
  var audioFiles = sortedAudioUploadFiles(files);
  var imgFile = firstImageUploadFile(files);
  if (audioFiles.length) {
    var songs;
    var persistenceFailed = false;
    if (canUsePersistentLocalMusicLibrary()) {
      showToast(uploadDragdropText('upload_reading') + audioFiles.length + uploadDragdropText('upload_reading_tags'));
      try {
        var persisted = await importPersistentLocalAudioFiles(audioFiles);
        songs = persisted && persisted.tracks;
        if (!songs || !songs.length) throw new Error('LOCAL_LIBRARY_IMPORT_EMPTY');
        persistentLocalLibraryTracks = songs.map(cloneSong);
        if (persisted && Array.isArray(persisted.failures) && persisted.failures.length) {
          setTimeout(function () { showToast(uploadDragdropText('upload_has_prefix') + persisted.failures.length + uploadDragdropText('upload_files_unreadable')); }, 900);
        }
      } catch (e) {
        persistenceFailed = true;
        console.warn('[LocalImport] persistent library unavailable, using this session only', e);
      }
    }
    if (!songs || !songs.length) songs = audioFiles.map(localSongFromAudioFile);
    importLocalAudioSongs(songs, { coverFile: songs.length === 1 ? imgFile : null, mode: opts.mode || '' });
    if (persistenceFailed) {
      setTimeout(function () { showToast(uploadDragdropText('upload_lib_save_failed')); }, 260);
    }
    return;
  }
  if (imgFile) {
    handleCoverFiles([imgFile]);
    return;
  }
  showToast(uploadDragdropText('upload_none_found'));
}
var fileInput = document.getElementById('file-input');
if (fileInput) fileInput.addEventListener('change', function (e) { handleFiles(e.target.files, { mode: 'audio' }); e.target.value = ''; });
var coverInput = document.getElementById('cover-input');
if (coverInput) coverInput.addEventListener('change', function (e) { handleCoverFiles(e.target.files); e.target.value = ''; });
var folderInput = document.getElementById('folder-input');
if (folderInput) folderInput.addEventListener('change', function (e) { handleFiles(e.target.files, { mode: 'folder' }); e.target.value = ''; });
var lyricFontInput = document.getElementById('lyric-font-input');
if (lyricFontInput) lyricFontInput.addEventListener('change', function (e) { handleLyricFontFiles(e.target.files); e.target.value = ''; });
document.addEventListener('click', function (e) {
  var panel = document.getElementById('upload-panel');
  if (!panel || !panel.classList.contains('show')) return;
  if (e.target && e.target.closest && e.target.closest('#upload-actions')) return;
  closeUploadPanel();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeUploadPanel();
});
var dropOv = document.getElementById('drop-overlay'), dragCount = 0;
document.addEventListener('dragenter', function (e) { e.preventDefault(); dragCount++; dropOv.classList.add('show'); });
document.addEventListener('dragleave', function (e) { e.preventDefault(); dragCount--; if (dragCount <= 0) { dragCount = 0; dropOv.classList.remove('show'); } });
document.addEventListener('dragover', function (e) { e.preventDefault(); });
document.addEventListener('drop', function (e) {
  e.preventDefault(); dragCount = 0; dropOv.classList.remove('show');
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

// ============================================================
//  控制台 — 预设卡片 + 主滑块 + 开关 + 三态
