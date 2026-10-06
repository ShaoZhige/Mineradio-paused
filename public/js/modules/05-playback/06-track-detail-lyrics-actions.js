// 界面文案统一走 i18n；缺键时退回内置中文模板，界面不会出现空串或裸 key。
// All UI copy goes through i18n and falls back to the built-in Chinese template, so the
// UI never shows an empty string or a raw key.
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
function trackActionText(key, fallback, params) {
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
function currentCoverSong() {
  if (currentIdx >= 0 && playQueue[currentIdx]) return playQueue[currentIdx];
  return currentLocalSong || null;
}
function songDurationLabel(song) {
  var sec = playbackDurationFromSong(song);
  if (!sec && audio && isFinite(audio.duration) && audio.duration > 0) sec = audio.duration;
  if (!sec) return trackActionText('track_unknown');
  return formatProgramTime(sec);
}
function songSourceLabel(song) {
  if (!song) return trackActionText('track_unknown');
  if (song.provider === 'spotify' || song.source === 'spotify' || song.type === 'spotify' || song.spotifyId || song.spotifyUri) return 'Spotify';
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return trackActionText('login_qq', 'QQ 音乐');
  if (song.provider === 'qishui' || song.source === 'qishui' || song.type === 'qishui') return trackActionText('provider_qishui');
  if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash) return trackActionText('provider_kugou');
  if (song.type === 'local') return trackActionText('track_local_upload');
  if (song.type === 'podcast' || song.source === 'podcast') return trackActionText('track_netease_podcast');
  return trackActionText('track_netease_music');
}
function detailRow(label, value) {
  value = value == null || value === '' ? trackActionText('track_unknown') : value;
  return '<div class="detail-k">' + escHtml(label) + '</div><div class="detail-v">' + escHtml(String(value)) + '</div>';
}
function currentArtistNames(song) {
  var text = String((song && song.artist) || '').trim();
  if (!text) return [];
  return text.split(/\s*\/\s*|\s*,\s*|、/).map(function (s) { return s.trim(); }).filter(Boolean);
}
var trackDetailSeq = 0;
var detailArtistSongs = [];
var detailAlbumSongs = [];
var detailAlbumContext = null;
var detailAlbumGaplessEnabled = true;
var detailAlbumGaplessUserTouched = false;
var detailAlbumCollectionState = Object.create(null);
var detailCommentSong = null;
var detailCommentSubmitBusy = false;
function normalizeArtistNameForMatch(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s·・,，、/\\|&＋+_-]+/g, '')
    .replace(/[()（）\[\]【】"'“”‘’]/g, '');
}
function artistNameMatches(expectedNames, actualName) {
  var actual = normalizeArtistNameForMatch(actualName);
  if (!actual) return false;
  return (expectedNames || []).some(function (name) {
    var expected = normalizeArtistNameForMatch(name);
    return expected && (expected === actual || expected.indexOf(actual) >= 0 || actual.indexOf(expected) >= 0);
  });
}
function currentArtistId(song) {
  if (!song) return '';
  if (!isCloudSong(song)) return '';
  if (song.artistId) return String(song.artistId);
  var artists = song.artists || [];
  for (var i = 0; i < artists.length; i++) {
    if (artists[i] && artists[i].id) return String(artists[i].id);
  }
  return '';
}
function currentQQArtistMid(song) {
  if (!song || songProviderKey(song) !== 'qq') return '';
  if (song.artistMid) return String(song.artistMid);
  if (song.singerMid) return String(song.singerMid);
  if (song.artistId && !/^\d+$/.test(String(song.artistId))) return String(song.artistId);
  var artists = song.artists || [];
  for (var i = 0; i < artists.length; i++) {
    if (artists[i] && artists[i].mid) return String(artists[i].mid);
    if (artists[i] && artists[i].id && !/^\d+$/.test(String(artists[i].id))) return String(artists[i].id);
  }
  return '';
}
function currentAlbumKey(song) {
  if (!song) return '';
  var provider = songProviderKey(song);
  if (provider === 'qq') {
    var qqAlbumMid = song.albumMid || song.albummid || song.album_mid || '';
    return qqAlbumMid ? 'qq:' + qqAlbumMid : '';
  }
  if (provider === 'spotify') {
    var spotifyAlbumId = song.albumId || song.spotifyAlbumId || '';
    return spotifyAlbumId ? 'spotify:' + spotifyAlbumId : '';
  }
  if (provider === 'netease') {
    var albumId = song.albumId || song.album_id || '';
    return albumId ? 'netease:' + albumId : '';
  }
  if (provider === 'kugou') {
    var kugouAlbumId = song.albumId || song.album_id || '';
    return kugouAlbumId ? 'kugou:' + kugouAlbumId : '';
  }
  if (provider === 'qishui') {
    var qishuiAlbumId = song.albumId || song.album_id || '';
    return qishuiAlbumId ? 'qishui:' + qishuiAlbumId : '';
  }
  return '';
}
function albumDetailUrlForSong(song) {
  var provider = songProviderKey(song);
  if (provider === 'qq') {
    var qqAlbumMid = song && (song.albumMid || song.albummid || song.album_mid || '');
    return qqAlbumMid ? '/api/qq/album/detail?mid=' + encodeURIComponent(qqAlbumMid) + '&limit=120' : '';
  }
  if (provider === 'spotify') {
    var spotifyAlbumId = song && (song.albumId || song.spotifyAlbumId || '');
    return spotifyAlbumId ? '/api/spotify/album/detail?id=' + encodeURIComponent(spotifyAlbumId) + '&limit=100' : '';
  }
  if (provider === 'netease') {
    var albumId = song && (song.albumId || song.album_id || '');
    return albumId ? '/api/album/detail?id=' + encodeURIComponent(albumId) + '&limit=120' : '';
  }
  return '';
}
function albumDetailMissingText(song) {
  var provider = songProviderKey(song);
  if (provider === 'kugou') return trackActionText('track_kugou_album_unavailable');
  if (provider === 'qishui') return trackActionText('track_qishui_album_unavailable');
  return trackActionText('track_missing_album_id');
}
function albumCollectionConfig(song) {
  var provider = songProviderKey(song);
  var albumId = song && (song.albumId || song.album_id || song.spotifyAlbumId || '');
  if (!albumId) return null;
  if (provider === 'netease') return { provider: provider, id: String(albumId), endpoint: '/api/album/subscribe', field: 'subscribed', label: trackActionText('login_netease', '网易云') };
  if (provider === 'spotify') return { provider: provider, id: String(albumId), endpoint: '/api/spotify/album/like', field: 'like', label: 'Spotify' };
  if (provider === 'qishui') return { provider: provider, id: String(albumId), endpoint: '/api/qishui/album/collect', field: 'collected', label: trackActionText('provider_qishui') };
  return null;
}
function albumCollectionKey(song) {
  var config = albumCollectionConfig(song);
  return config ? (config.provider + ':' + config.id) : '';
}
function renderAlbumCollectionButton(song) {
  var config = albumCollectionConfig(song);
  if (!config) return '';
  var key = albumCollectionKey(song);
  var collected = !!detailAlbumCollectionState[key];
  return '<button id="album-collection-toggle" class="detail-action-toggle' + (collected ? ' on' : '') + '" type="button" onclick="toggleAlbumCollection()">' +
    (collected ? trackActionText('track_album_collected') : trackActionText('track_collect_album')) +
    '</button>';
}
function syncAlbumCollectionButton(song) {
  song = song || detailCommentSong || currentCoverSong();
  var btn = document.getElementById('album-collection-toggle');
  if (!btn) return;
  var collected = !!detailAlbumCollectionState[albumCollectionKey(song)];
  btn.classList.toggle('on', collected);
  btn.textContent = collected ? trackActionText('track_album_collected') : trackActionText('track_collect_album');
}
function syncAlbumCollectionState(song) {
  var config = albumCollectionConfig(song);
  if (!config || !isSongAccountLoggedIn(config.provider)) return;
  var url = '';
  var responseField = '';
  if (config.provider === 'netease') {
    url = '/api/album/subscribe/check?ids=' + encodeURIComponent(config.id);
    responseField = 'subscribed';
  } else if (config.provider === 'spotify') {
    url = '/api/spotify/album/like/check?ids=' + encodeURIComponent(config.id);
    responseField = 'liked';
  }
  if (!url) return;
  apiJson(url).then(function (result) {
    if (!result || result.error || !result[responseField]) return;
    detailAlbumCollectionState[albumCollectionKey(song)] = !!result[responseField][config.id];
    syncAlbumCollectionButton(song);
  }).catch(function () {});
}
async function toggleAlbumCollection() {
  var song = detailCommentSong || currentCoverSong();
  var config = albumCollectionConfig(song);
  if (!config) { showToast(trackActionText('track_album_collect_unsupported')); return; }
  if (!ensureLoggedInForAction(config.provider)) return;
  var key = albumCollectionKey(song);
  var next = !detailAlbumCollectionState[key];
  var payload = { id: config.id, albumId: config.id };
  payload[config.field] = next;
  var btn = document.getElementById('album-collection-toggle');
  if (btn) btn.classList.add('busy');
  try {
    var result = await apiJson(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!result || result.error || result.success === false) throw new Error(result && (result.message || result.error) || 'ALBUM_COLLECTION_FAILED');
    detailAlbumCollectionState[key] = next;
    syncAlbumCollectionButton(song);
    showToast(next ? trackActionText('track_album_collected_to') + config.label : trackActionText('track_album_uncollected'));
  } catch (err) {
    showToast(/SCOPE|PERMISSION/i.test(String(err && err.message || ''))
      ? trackActionText('track_album_collect_reauth')
      : trackActionText('track_album_collect_failed'));
  } finally {
    if (btn) btn.classList.remove('busy');
  }
}
function renderAlbumGaplessButton() {
  return '<button id="album-gapless-toggle" class="detail-action-toggle' + (detailAlbumGaplessEnabled ? ' on' : '') + '" type="button" onclick="toggleAlbumGaplessPlayback()">' +
    (detailAlbumGaplessEnabled ? trackActionText('track_gapless_on') : trackActionText('track_gapless_off')) +
    '</button>';
}
function syncAlbumGaplessButton() {
  var btn = document.getElementById('album-gapless-toggle');
  if (!btn) return;
  btn.classList.toggle('on', detailAlbumGaplessEnabled);
  btn.textContent = detailAlbumGaplessEnabled ? trackActionText('track_gapless_on') : trackActionText('track_gapless_off');
}
function toggleAlbumGaplessPlayback() {
  detailAlbumGaplessUserTouched = true;
  detailAlbumGaplessEnabled = !detailAlbumGaplessEnabled;
  if (typeof setAlbumGaplessPlaybackContext === 'function') {
    setAlbumGaplessPlaybackContext(detailAlbumGaplessEnabled, detailAlbumContext, { userToggle: true });
  }
  syncAlbumGaplessButton();
  showToast(detailAlbumGaplessEnabled ? trackActionText('track_album_gapless_on') : trackActionText('track_album_gapless_off'));
}
function tagAlbumSongsForGapless(songs, context) {
  var albumKey = context && context.albumKey || '';
  return (songs || []).map(function (song, i) {
    var copy = cloneSong(song);
    copy.__albumGaplessKey = albumKey;
    copy.__albumTrackIndex = i;
    return copy;
  });
}
function renderAlbumSongList(songs) {
  detailAlbumSongs = (songs || []).map(cloneSong);
  if (!detailAlbumSongs.length) return trackActionText('track_no_album_tracks_html');
  return '<div class="detail-scroll">' + detailAlbumSongs.map(function (s, i) {
    var cover = songCoverSrc(s, 80);
    var coverHtml = cover ? '<img class="artist-song-cover" src="' + escHtml(cover) + '" alt="" onerror="this.style.opacity=0.18">' : '<div class="artist-song-cover"></div>';
    var actionsHtml = '<div class="artist-song-actions">' +
      trackActionText('track_album_collect_btn_html') + i + ')">' + artistCollectTrayIconSvg() + '</button>' +
      '<button class="artist-song-action next" type="button" title="' + escHtml(trackActionText('next_play', '下一首播放')) + '" aria-label="' + escHtml(trackActionText('next_play', '下一首播放')) + '" onclick="event.stopPropagation();queueAlbumDetailSongNext(' + i + ')">' + artistNextPlusIconSvg() + '</button>' +
      '</div>';
    return '<div class="artist-song-item" onclick="playAlbumDetailSong(' + i + ')">' +
      '<div class="artist-song-rank">' + String(i + 1).padStart(2, '0') + '</div>' +
      coverHtml +
      '<div class="artist-song-main"><div class="artist-song-name">' + escHtml(s.name || '') + '</div>' +
      '<div class="artist-song-meta">' + escHtml((s.artist || trackActionText('track_unknown_artist')) + (s.duration ? (' · ' + songDurationLabel(s)) : '')) + '</div></div>' +
      actionsHtml +
      '</div>';
  }).join('') + '</div>';
}
function playAlbumDetailSong(i) {
  var song = detailAlbumSongs[i];
  if (!song) return;
  var taggedSongs = tagAlbumSongsForGapless(detailAlbumSongs, detailAlbumContext);
  playQueue = taggedSongs;
  currentIdx = i;
  if (typeof setAlbumGaplessPlaybackContext === 'function') {
    setAlbumGaplessPlaybackContext(detailAlbumGaplessEnabled, detailAlbumContext);
  }
  safeRenderQueuePanel('album-detail-play');
  safeShelfRebuild('album-detail-play', true);
  closeTrackDetailModal();
  playQueueAt(i, { skipShuffleOrder: true }).catch(function (e) { console.warn('[AlbumDetailPlay]', e); });
}
function collectAlbumDetailSong(i) {
  var song = detailAlbumSongs[i];
  if (!song) return;
  collectDetailSong(song);
}
function queueAlbumDetailSongNext(i) {
  var song = detailAlbumSongs[i];
  if (!song) return;
  queueDetailSongNext(song);
}
function commentTimeLabel(ms) {
  var t = Number(ms) || 0;
  if (!t) return '';
  try {
    // 评论日期跟随界面语言，不能写死 zh-CN；拿不到语言标签时交给系统默认。
    // The comment date follows the UI language rather than a hardcoded zh-CN, and falls back to
    // the system default when no tag is available.
    var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
    var locale = i18n && typeof i18n.htmlLang === 'function' ? i18n.htmlLang() : undefined;
    return new Date(t).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  } catch (e) {
    return '';
  }
}
function renderDetailComments(comments) {
  if (!comments || !comments.length) return trackActionText('track_no_comments_html');
  return '<div class="detail-scroll">' + comments.map(function (c) {
    var user = c.user || {};
    var avatar = user.avatar ? coverUrlWithSize(user.avatar, 64) : '';
    return '<div class="comment-item">' +
      (avatar ? '<img class="comment-avatar" src="' + avatar + '" alt="">' : '<div class="comment-avatar"></div>') +
      '<div class="comment-main"><div class="comment-meta">' + escHtml(user.nickname || trackActionText('track_music_user')) + (c.likedCount ? (' · ' + c.likedCount + trackActionText('track_likes_suffix')) : '') + (c.time ? (' · ' + escHtml(commentTimeLabel(c.time))) : '') + '</div>' +
      '<div class="comment-text">' + escHtml(c.content || '') + '</div></div>' +
      '</div>';
  }).join('') + '</div>';
}
function detailCommentsConfig(song) {
  var provider = songProviderKey(song);
  if (provider === 'qq') {
    var qqId = song.qqId || '';
    var qqMid = song.mid || song.songmid || song.id || '';
    return {
      provider: 'qq',
      title: trackActionText('track_qq_comments'),
      readUrl: '/api/qq/song/comments?id=' + encodeURIComponent(qqId) + '&mid=' + encodeURIComponent(qqMid) + '&limit=18',
      writeUrl: '',
      canWrite: false,
    };
  }
  if (provider === 'qishui') {
    var qishuiId = song.providerSongId || song.trackId || song.id || '';
    return qishuiId ? {
      provider: 'qishui',
      title: trackActionText('track_qishui_comments'),
      readUrl: '/api/qishui/song/comments?id=' + encodeURIComponent(qishuiId) + '&limit=18',
      writeUrl: '/api/qishui/song/comments?id=' + encodeURIComponent(qishuiId),
      canWrite: true,
      id: qishuiId,
    } : null;
  }
  if (provider === 'netease' && song.id) {
    return {
      provider: 'netease',
      title: trackActionText('track_netease_comments'),
      readUrl: '/api/song/comments?id=' + encodeURIComponent(song.id) + '&limit=18',
      writeUrl: '/api/song/comments?id=' + encodeURIComponent(song.id),
      canWrite: true,
      id: song.id,
    };
  }
  return null;
}
function renderDetailCommentComposer(config) {
  if (!config || !config.canWrite) return '';
  return '<div class="detail-comment-compose">' +
    trackActionText('track_comment_input_html') +
    trackActionText('track_comment_submit_btn_html') +
    '</div>';
}
function loadDetailComments(song, seq) {
  var config = detailCommentsConfig(song);
  var target = document.getElementById('song-comments');
  if (!config || !config.readUrl) {
    if (target) target.innerHTML = trackActionText('track_no_comment_api_html');
    return Promise.resolve();
  }
  if (target) target.innerHTML = trackActionText('track_loading_comments_html');
  return apiJson(config.readUrl).then(function (result) {
    if (seq !== trackDetailSeq) return;
    var nextTarget = document.getElementById('song-comments');
    if (nextTarget) nextTarget.innerHTML = result && !result.error
      ? renderDetailComments(result.comments || [])
      : trackActionText('track_comments_failed_html');
    bindTrackDetailScrollers();
  }).catch(function () {
    var nextTarget = document.getElementById('song-comments');
    if (seq === trackDetailSeq && nextTarget) nextTarget.innerHTML = trackActionText('track_comments_failed_html');
    bindTrackDetailScrollers();
  });
}
async function submitDetailComment() {
  if (detailCommentSubmitBusy || !detailCommentSong) return;
  var config = detailCommentsConfig(detailCommentSong);
  if (!config || !config.canWrite || !config.writeUrl) {
    showToast(trackActionText('track_comment_readonly'));
    return;
  }
  if (!ensureLoggedInForAction(config.provider)) return;
  var input = document.getElementById('detail-comment-input');
  var content = String(input && input.value || '').trim();
  if (!content) { showToast(trackActionText('track_enter_comment')); return; }
  detailCommentSubmitBusy = true;
  var button = document.getElementById('detail-comment-submit');
  if (button) { button.disabled = true; button.textContent = trackActionText('track_sending'); }
  try {
    var result = await apiJson(config.writeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: config.id, content: content })
    });
    if (!result || result.error || result.success === false || result.created === false) {
      throw new Error(result && (result.message || result.error) || 'COMMENT_CREATE_FAILED');
    }
    if (input) input.value = '';
    showToast(trackActionText('track_comment_published'));
    await loadDetailComments(detailCommentSong, trackDetailSeq);
  } catch (err) {
    showToast(trackActionText('track_comment_publish_failed') + (err && err.message ? ': ' + err.message : ''));
  } finally {
    detailCommentSubmitBusy = false;
    if (button) { button.disabled = false; button.textContent = trackActionText('track_send'); }
  }
}
function renderArtistSongList(songs) {
  detailArtistSongs = (songs || []).map(cloneSong);
  if (!detailArtistSongs.length) return trackActionText('track_no_hot_songs_html');
  return '<div class="detail-scroll">' + detailArtistSongs.map(function (s, i) {
    var cover = songCoverSrc(s, 80);
    var coverHtml = cover ? '<img class="artist-song-cover" src="' + escHtml(cover) + '" alt="" onerror="this.style.opacity=0.18">' : '<div class="artist-song-cover"></div>';
    var actionsHtml = '<div class="artist-song-actions">' +
      trackActionText('track_artist_collect_btn_html') + i + ')">' + artistCollectTrayIconSvg() + '</button>' +
      '<button class="artist-song-action next" type="button" title="' + escHtml(trackActionText('next_play', '下一首播放')) + '" aria-label="' + escHtml(trackActionText('next_play', '下一首播放')) + '" onclick="event.stopPropagation();queueArtistDetailSongNext(' + i + ')">' + artistNextPlusIconSvg() + '</button>' +
      '</div>';
    return '<div class="artist-song-item" onclick="playArtistDetailSong(' + i + ')">' +
      '<div class="artist-song-rank">' + String(i + 1).padStart(2, '0') + '</div>' +
      coverHtml +
      '<div class="artist-song-main"><div class="artist-song-name">' + escHtml(s.name || '') + '</div>' +
      '<div class="artist-song-meta">' + escHtml((s.album || trackActionText('track_unknown_album')) + (s.duration ? (' · ' + songDurationLabel(s)) : '')) + '</div></div>' +
      actionsHtml +
      '</div>';
  }).join('') + '</div>';
}
function playArtistDetailSong(i) {
  var song = detailArtistSongs[i];
  if (!song) return;
  playQueue = detailArtistSongs.map(cloneSong);
  currentIdx = i;
  safeRenderQueuePanel('artist-detail-play');
  safeShelfRebuild('artist-detail-play', true);
  closeTrackDetailModal();
  playQueueAt(i).catch(function (e) { console.warn('[ArtistDetailPlay]', e); });
}
function collectArtistDetailSong(i) {
  var song = detailArtistSongs[i];
  if (!song) return;
  collectDetailSong(song);
}
function queueArtistDetailSongNext(i) {
  var song = detailArtistSongs[i];
  if (!song) return;
  queueDetailSongNext(song);
}
function bindTrackDetailScrollers() {
  var body = document.getElementById('track-detail-body');
  bindSmoothWheelScroll(body);
  if (body) body.querySelectorAll('.detail-scroll').forEach(bindSmoothWheelScroll);
}
function closeTrackDetailModal() {
  closeGsapModal(document.getElementById('track-detail-modal'), function () {
    detailCommentSong = null;
    detailCommentSubmitBusy = false;
  });
}
function openTrackDetailModal(type, songOverride) {
  var song = songOverride || currentCoverSong();
  if (!song) { showToast(trackActionText('track_play_or_select_first')); return; }
  if (immersiveMode) setImmersiveMode(false);
  var heading = document.getElementById('track-detail-heading');
  var body = document.getElementById('track-detail-body');
  if (!heading || !body) return;
  var cover = songCoverSrc(song, 180);
  var coverHtml = cover ? '<img class="detail-cover" src="' + cover + '" alt="">' : '<div class="detail-cover"></div>';
  var title = song.name || trackActionText('track_current_song');
  var artists = currentArtistNames(song);
  var seq = ++trackDetailSeq;
  detailCommentSong = song;
  if (type === 'album') {
    var albumUrl = albumDetailUrlForSong(song);
    var albumTitle = song.album || (song.type === 'podcast' ? (song.radioName || 'Podcast') : trackActionText('track_unknown_album'));
    var albumKey = currentAlbumKey(song);
    detailAlbumGaplessUserTouched = false;
    detailAlbumGaplessEnabled = typeof albumGaplessDefaultEnabledForContext === 'function'
      ? albumGaplessDefaultEnabledForContext({ albumKey: albumKey })
      : true;
    detailAlbumSongs = [];
    detailAlbumContext = {
      provider: songProviderKey(song),
      albumKey: albumKey,
      album: { name: albumTitle, cover: cover, artist: song.artist || '', id: song.albumId || song.album_id || '', albumMid: song.albumMid || song.albummid || '' },
      songs: [],
    };
    heading.textContent = trackActionText('dt_album_title');
    body.innerHTML =
      '<div class="detail-hero">' + coverHtml +
      '<div style="min-width:0;flex:1"><div class="detail-title" id="album-detail-title">' + escHtml(albumTitle) + '</div>' +
      '<div class="detail-sub" id="album-detail-sub">' + escHtml(song.artist || trackActionText('track_unknown_artist')) + ' · ' + escHtml(songSourceLabel(song)) + '</div></div>' +
      '</div>' +
      '<div class="detail-grid">' +
      detailRow(trackActionText('track_current_song'), title) +
      detailRow(trackActionText('track_album'), albumTitle) +
      detailRow(trackActionText('track_artist'), song.artist || trackActionText('track_unknown_artist')) +
      detailRow(trackActionText('track_source'), songSourceLabel(song)) +
      '</div>' +
      '<div class="detail-chip-row">' +
      '<span class="detail-chip">' + escHtml(songSourceLabel(song)) + '</span>' +
      trackActionText('track_chip_album_order_html') +
      '</div>' +
      trackActionText('track_album_tracks_html') + renderAlbumCollectionButton(song) + renderAlbumGaplessButton() + '</div></div><div id="album-song-list">' +
      (albumUrl ? trackActionText('track_loading_album_tracks_html') : '<div class="detail-empty">' + escHtml(albumDetailMissingText(song)) + '</div>') +
      '</div></div>';
    syncAlbumCollectionState(song);
    if (albumUrl) {
      apiJson(albumUrl).then(function (r) {
        if (seq !== trackDetailSeq) return;
        var target = document.getElementById('album-song-list');
        if (!r || r.error) {
          if (target) target.innerHTML = trackActionText('track_album_detail_failed_html');
          bindTrackDetailScrollers();
          return;
        }
        var albumInfo = r.album || {};
        var songs = (r.songs || []).map(cloneSong);
        detailAlbumContext = {
          provider: r.provider || songProviderKey(song),
          albumKey: albumKey || currentAlbumKey(songs[0]) || currentAlbumKey(song),
          album: albumInfo,
          songs: songs,
        };
        if (!detailAlbumContext.albumKey && albumInfo) {
          detailAlbumContext.albumKey = (r.provider || songProviderKey(song)) + ':' + (albumInfo.albumId || albumInfo.id || albumInfo.albumMid || albumInfo.mid || albumTitle);
        }
        if (!detailAlbumGaplessUserTouched && typeof albumGaplessDefaultEnabledForContext === 'function') {
          detailAlbumGaplessEnabled = albumGaplessDefaultEnabledForContext(detailAlbumContext);
        }
        if (detailAlbumGaplessEnabled && typeof setAlbumGaplessPlaybackContext === 'function') {
          setAlbumGaplessPlaybackContext(true, detailAlbumContext);
        }
        var titleEl = document.getElementById('album-detail-title');
        var subEl = document.getElementById('album-detail-sub');
        if (titleEl && albumInfo.name) titleEl.textContent = albumInfo.name;
        if (subEl) subEl.textContent = (albumInfo.artist || song.artist || trackActionText('track_unknown_artist')) + ' · ' + songSourceLabel(song);
        var detailCover = body.querySelector('.detail-cover');
        var albumCover = albumInfo.cover || (songs[0] && songs[0].cover) || cover;
        if (detailCover && albumCover) {
          if (detailCover.tagName === 'IMG') detailCover.src = coverUrlWithSize(albumCover, 180);
          else {
            detailCover.style.backgroundImage = 'url("' + coverUrlWithSize(albumCover, 180).replace(/"/g, '\\"') + '")';
            detailCover.style.backgroundSize = 'cover';
            detailCover.style.backgroundPosition = 'center';
          }
        }
        if (target) target.innerHTML = renderAlbumSongList(songs);
        syncAlbumGaplessButton();
        bindTrackDetailScrollers();
      }).catch(function () {
        var target = document.getElementById('album-song-list');
        if (seq === trackDetailSeq && target) target.innerHTML = trackActionText('track_album_detail_failed_html');
        bindTrackDetailScrollers();
      });
    }
  } else if (type === 'artist') {
    var artistId = currentArtistId(song);
    var qqArtistMid = currentQQArtistMid(song);
    var artistDetailUrl = artistId
      ? ('/api/artist/detail?id=' + encodeURIComponent(artistId) + '&limit=36')
      : (qqArtistMid ? ('/api/qq/artist/detail?mid=' + encodeURIComponent(qqArtistMid) + '&limit=36') : '');
    var artistName = artists.join(' / ') || song.artist || trackActionText('track_unknown_artist');
    var artistNamesForMatch = artists.length ? artists : (song.artist ? [song.artist] : []);
    var artistInitial = artistName && artistName !== trackActionText('track_unknown_artist') ? artistName.slice(0, 1) : trackActionText('track_song');
    var artistCoverHtml = '<div id="artist-detail-cover" class="detail-cover detail-artist-avatar">' + escHtml(artistInitial) + '</div>';
    var artistEmptyText = songProviderKey(song) === 'qq'
      ? trackActionText('track_qq_missing_singermid')
      : trackActionText('track_no_usable_artist_page');
    var artistLoadingText = songProviderKey(song) === 'qq' ? trackActionText('track_loading_qq_artist') : trackActionText('track_loading_artist');
    heading.textContent = trackActionText('dt_artist_title');
    body.innerHTML =
      '<div class="detail-hero">' + artistCoverHtml +
      '<div style="min-width:0;flex:1"><div class="detail-title">' + escHtml(artistName) + '</div>' +
      trackActionText('track_from_playing_prefix_html') + escHtml(title) + '</div></div>' +
      '</div>' +
      '<div class="detail-grid">' +
      detailRow(trackActionText('track_current_song'), title) +
      detailRow(trackActionText('track_related_artist'), artistName) +
      detailRow(trackActionText('track_belongs_album'), song.album || (song.type === 'podcast' ? (song.radioName || 'Podcast') : trackActionText('track_unknown'))) +
      detailRow(trackActionText('track_source'), songSourceLabel(song)) +
      '</div>' +
      '<div class="detail-chip-row">' + (artists.length ? artists.map(function (name) { return '<span class="detail-chip">' + escHtml(name) + '</span>'; }).join('') : trackActionText('track_chip_unknown_artist_html')) + '</div>' +
      trackActionText('track_hot_songs_html') + (artistDetailUrl ? '<div class="detail-loading">' + escHtml(artistLoadingText) + '</div>' : '<div class="detail-empty">' + escHtml(artistEmptyText) + '</div>') + '</div></div>';
    if (artistDetailUrl) {
      apiJson(artistDetailUrl).then(function (r) {
        if (seq !== trackDetailSeq) return;
        var returnedName = r && r.artist && r.artist.name;
        var target = document.getElementById('artist-hot-songs');
        if (returnedName && artistNamesForMatch.length && !artistNameMatches(artistNamesForMatch, returnedName)) {
          if (target) target.innerHTML = trackActionText('track_artist_mismatch_html');
          bindTrackDetailScrollers();
          return;
        }
        if (returnedName) {
          var titleEl = body.querySelector('.detail-title');
          if (titleEl) titleEl.textContent = r.artist.name;
        }
        if (r && r.artist && r.artist.avatar) {
          var avatarEl = document.getElementById('artist-detail-cover');
          if (avatarEl) {
            avatarEl.textContent = '';
            avatarEl.style.backgroundImage = 'url("' + coverUrlWithSize(r.artist.avatar, 180).replace(/"/g, '\\"') + '")';
            avatarEl.style.backgroundSize = 'cover';
            avatarEl.style.backgroundPosition = 'center';
          }
        }
        if (target) target.innerHTML = r && !r.error ? renderArtistSongList(r.songs || []) : trackActionText('track_artist_page_failed_html');
        bindTrackDetailScrollers();
      }).catch(function () {
        var target = document.getElementById('artist-hot-songs');
        if (seq === trackDetailSeq && target) target.innerHTML = trackActionText('track_artist_page_failed_html');
        bindTrackDetailScrollers();
      });
    }
  } else {
    heading.textContent = trackActionText('sd_song_details');
    var commentConfig = detailCommentsConfig(song);
    var detailCommentTitle = commentConfig ? commentConfig.title : (songSourceLabel(song) + trackActionText('track_comments'));
    var detailCanLoadComments = !!(commentConfig && commentConfig.readUrl);
    var detailEmptyText = detailCanLoadComments ? trackActionText('track_no_comments') : trackActionText('track_no_comment_api');
    body.innerHTML =
      '<div class="detail-hero">' + coverHtml +
      '<div style="min-width:0;flex:1"><div class="detail-title">' + escHtml(title) + '</div>' +
      '<div class="detail-sub">' + escHtml(song.artist || (song.type === 'local' ? trackActionText('track_local_file') : trackActionText('track_unknown_artist'))) + '</div></div>' +
      '</div>' +
      '<div class="detail-grid">' +
      detailRow(trackActionText('track_song_title'), title) +
      detailRow(trackActionText('track_artist'), song.artist || trackActionText('track_unknown_artist')) +
      detailRow(trackActionText('track_album'), song.album || (song.type === 'podcast' ? (song.radioName || 'Podcast') : trackActionText('track_unknown'))) +
      detailRow(trackActionText('track_duration'), songDurationLabel(song)) +
      detailRow(trackActionText('track_source'), songSourceLabel(song)) +
      detailRow(trackActionText('lyric_source', '歌词源'), lyricSourceMode === 'custom' ? trackActionText('cl_custom_lyric') : (lyricsTimingSource === 'fallback' ? trackActionText('track_placeholder_lyrics') : trackActionText('lyric_source_original', '原词'))) +
      '</div>' +
      '<div class="detail-chip-row">' +
      '<span class="detail-chip">' + escHtml(songSourceLabel(song)) + '</span>' +
      (isSongLiked(song) ? trackActionText('track_chip_like_html') : '') +
      (getCustomCoverForSong(song) ? trackActionText('track_chip_custom_cover_html') : '') +
      (hasCustomLyricForSong(song) ? trackActionText('track_chip_custom_lyrics_html') : '') +
      '</div>' +
      '<div class="detail-section"><div class="detail-section-head"><div class="detail-section-title">' + detailCommentTitle + '</div></div>' +
      renderDetailCommentComposer(commentConfig) +
      '<div id="song-comments">' + (detailCanLoadComments ? trackActionText('track_loading_comments_html') : '<div class="detail-empty">' + detailEmptyText + '</div>') + '</div></div>';
    if (detailCanLoadComments) {
      loadDetailComments(song, seq);
    }
  }
  bindTrackDetailScrollers();
  openGsapModal(document.getElementById('track-detail-modal'));
}
function openArtistDetailForSong(song) {
  if (!song) { showToast(trackActionText('track_artist_not_found')); return; }
  if (currentArtistId(song) || currentQQArtistMid(song)) {
    openTrackDetailModal('artist', song);
    return;
  }
  var artist = String(song.artist || '').split(/\s*\/\s*|\s*,\s*|、|&| feat\.? | ft\.? /i).filter(Boolean)[0] || '';
  if (artist) {
    resolveArtistSongForDetail(song, artist).then(function (found) {
      openTrackDetailModal('artist', found || Object.assign({}, song, { artist: artist }));
    }).catch(function () {
      openTrackDetailModal('artist', Object.assign({}, song, { artist: artist }));
    });
    showToast(trackActionText('track_looking_artist_prefix') + artist);
  } else {
    showToast(trackActionText('track_missing_artist_page'));
  }
}
function resolveArtistSongForDetail(song, artist) {
  var provider = songProviderKey(song) === 'qq' ? 'qq' : 'netease';
  var url = provider === 'qq'
    ? '/api/qq/search?keywords=' + encodeURIComponent(artist) + '&limit=8'
    : '/api/search?keywords=' + encodeURIComponent(artist) + '&limit=10';
  return apiJson(url).then(function (r) {
    var songs = (r && r.songs) || [];
    for (var i = 0; i < songs.length; i++) {
      var candidate = songs[i];
      if (!candidate) continue;
      if (!artistNameMatches([artist], candidate.artist || '')) continue;
      if (currentArtistId(candidate) || currentQQArtistMid(candidate)) return candidate;
    }
    return null;
  });
}
function setCustomCoverForCurrent(dataUrl, opts) {
  if (!dataUrl) return;
  var song = currentCoverSong();
  var saved = false;
  var hasKey = false;
  if (song) {
    var key = songCustomCoverKey(song);
    song.customCover = dataUrl;
    if (key) {
      hasKey = true;
      customCoverMap[key] = dataUrl;
      saved = saveCustomCoverMap();
      for (var i = 0; i < playQueue.length; i++) {
        if (songCustomCoverKey(playQueue[i]) === key) playQueue[i].customCover = dataUrl;
      }
      if (currentLocalSong && songCustomCoverKey(currentLocalSong) === key) currentLocalSong.customCover = dataUrl;
    }
  }
  applyCoverDataUrl(dataUrl, opts);
  safeRenderQueuePanel('custom-cover-apply', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('custom-cover-apply');
  updateCustomCoverButton();
  showToast(song ? (!hasKey ? trackActionText('track_cover_applied') : (saved ? trackActionText('track_cover_saved') : trackActionText('track_cover_applied_low_storage'))) : trackActionText('track_temp_cover_applied'));
}
function updateCustomCoverButton() {
  var btn = document.getElementById('clear-cover-btn');
  var hasCover = !!getCustomCoverForSong(currentCoverSong());
  var area = document.getElementById('search-area');
  if (area) area.classList.toggle('has-cover-action', hasCover);
  if (!btn) return;
  btn.classList.toggle('has-cover', hasCover);
  btn.title = hasCover ? trackActionText('btn_clear_cover', '取消自定义封面') : trackActionText('track_no_custom_cover');
  btn.setAttribute('aria-label', btn.title);
}
function clearCustomCoverForCurrent() {
  var song = currentCoverSong();
  if (!song) {
    showToast(trackActionText('track_play_or_select_first'));
    updateCustomCoverButton();
    return;
  }
  var custom = getCustomCoverForSong(song);
  if (!custom) {
    showToast(trackActionText('track_no_custom_cover'));
    updateCustomCoverButton();
    return;
  }
  var key = songCustomCoverKey(song);
  if (key && customCoverMap[key]) {
    delete customCoverMap[key];
    saveCustomCoverMap();
  }
  delete playlistCoverCache[custom];
  delete song.customCover;
  if (key) {
    for (var i = 0; i < playQueue.length; i++) {
      if (songCustomCoverKey(playQueue[i]) === key) delete playQueue[i].customCover;
    }
  }
  if (key && currentLocalSong && songCustomCoverKey(currentLocalSong) === key) delete currentLocalSong.customCover;
  if (currentIdx >= 0 && playQueue[currentIdx] && playQueue[currentIdx].cover) loadCoverFromUrl(coverUrlWithSize(playQueue[currentIdx].cover, 400));
  else loadCoverFromUrl('');
  safeRenderQueuePanel('custom-cover-clear', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('custom-cover-clear');
  updateCustomCoverButton();
  showToast(trackActionText('track_cover_restored'));
}
function readCustomLyricMap() {
  try {
    var raw = JSON.parse(localStorage.getItem(CUSTOM_LYRIC_STORE_KEY) || '{}') || {};
    var out = {};
    Object.keys(raw).forEach(function (key) {
      var item = raw[key];
      if (typeof item === 'string') out[key] = { text: item, updatedAt: 0 };
      else if (item && typeof item.text === 'string') out[key] = { text: item.text, updatedAt: item.updatedAt || 0 };
    });
    return out;
  } catch (e) {
    return {};
  }
}
function saveCustomLyricMap() {
  try {
    localStorage.setItem(CUSTOM_LYRIC_STORE_KEY, JSON.stringify(customLyricMap || {}));
    return true;
  } catch (e) {
    console.warn('custom lyric save failed:', e);
    return false;
  }
}
function readCustomLyricPrefs() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_LYRIC_PREF_STORE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function saveCustomLyricPrefs() {
  try { localStorage.setItem(CUSTOM_LYRIC_PREF_STORE_KEY, JSON.stringify(customLyricPrefs || {})); } catch (e) { }
}
function songCustomLyricKey(song) {
  return songCustomCoverKey(song);
}
function currentLyricSong() {
  if (currentIdx >= 0 && playQueue[currentIdx]) return playQueue[currentIdx];
  return currentLocalSong || null;
}
function getCustomLyricEntry(song) {
  var key = songCustomLyricKey(song);
  return key && customLyricMap[key] ? customLyricMap[key] : null;
}
function hasCustomLyricForSong(song) {
  var entry = getCustomLyricEntry(song);
  return !!(entry && String(entry.text || '').trim());
}
function cloneLyricLine(line) {
  var copy = Object.assign({}, line || {});
  if (line && Array.isArray(line.words)) copy.words = line.words.map(function (w) { return Object.assign({}, w); });
  return copy;
}
function cloneLyricLines(lines) {
  return (Array.isArray(lines) ? lines : []).map(cloneLyricLine);
}
function lyricLineSignaturePart(line) {
  line = line || {};
  var words = Array.isArray(line.words) ? line.words : [];
  var firstWord = words[0] || {};
  var lastWord = words[words.length - 1] || {};
  return [
    Math.round((Number(line.t) || 0) * 1000),
    Math.round((Number(line.duration) || 0) * 1000),
    String(line.text || ''),
    line.fallback ? 1 : 0,
    String(line.source || ''),
    words.length,
    Math.round((Number(firstWord.t) || 0) * 1000),
    Math.round((Number(firstWord.d) || 0) * 1000),
    Math.round((Number(lastWord.t) || 0) * 1000),
    Math.round((Number(lastWord.d) || 0) * 1000),
    String(line.translation || '')
  ].join('\u001f');
}
function lyricLinesSignature(lines) {
  return (Array.isArray(lines) ? lines : []).map(lyricLineSignaturePart).join('\u001e');
}
function currentAppliedLyricRenderSignature() {
  var song = typeof currentLyricSong === 'function' ? currentLyricSong() : null;
  var songKey = songCustomLyricKey(song) || (song && (song.provider || song.source || '') + ':' + (song.id || song.mid || song.hash || song.name || '')) || '';
  return [
    songKey,
    lyricSourceMode || 'original',
    lyricsHasNativeKaraoke ? 1 : 0,
    lyricsTimingSource || '',
    lyricsTranslationSource || '',
    lyricLinesSignature(lyricsLines),
    lyricLinesSignature(lyricsTranslationLines)
  ].join('\u001d');
}
function preparedLyricStateForApply(lines, hasNativeKaraoke, timingSource, translationLines, translationSource) {
  var nextLines = Array.isArray(lines) ? lines : [];
  var nextTranslations = Array.isArray(translationLines) ? translationLines : [];
  var nextTiming = timingSource || 'fallback';
  var nextTranslationSource = translationSource || (nextTranslations.length ? 'translation' : 'none');
  if (!nextLines.length) nextLines = withLyricFallback([]);
  if (nextLines.length && nextLines[0].fallback) nextTiming = 'fallback';
  return {
    lines: nextLines,
    hasNativeKaraoke: !!hasNativeKaraoke,
    timingSource: nextTiming,
    translationLines: nextTranslations,
    translationSource: nextTranslationSource,
    signature: lyricStateRenderSignature(nextLines, hasNativeKaraoke, nextTiming, nextTranslations, nextTranslationSource)
  };
}
function lyricStateRenderSignature(lines, hasNativeKaraoke, timingSource, translationLines, translationSource) {
  var song = typeof currentLyricSong === 'function' ? currentLyricSong() : null;
  var songKey = songCustomLyricKey(song) || (song && (song.provider || song.source || '') + ':' + (song.id || song.mid || song.hash || song.name || '')) || '';
  return [
    songKey,
    lyricSourceMode || 'original',
    hasNativeKaraoke ? 1 : 0,
    timingSource || '',
    translationSource || '',
    lyricLinesSignature(lines),
    lyricLinesSignature(translationLines)
  ].join('\u001d');
}
function skipSameLyricStateRender(prepared, renderOptions, reason) {
  if (!renderOptions || !renderOptions.preserveSame || !prepared || !prepared.signature) return false;
  if (prepared.signature !== currentAppliedLyricRenderSignature()) return false;
  if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume(renderOptions.reason || reason || 'same-lyrics-state');
  return true;
}
function setOriginalLyricsState(lines, hasNativeKaraoke, timingSource, translationLines, translationSource) {
  originalLyricsState = {
    lines: cloneLyricLines(lines || []),
    hasNativeKaraoke: !!hasNativeKaraoke,
    timingSource: timingSource || 'fallback',
    translationLines: cloneLyricLines(translationLines || []),
    translationSource: translationSource || 'none'
  };
}
function applyLyricsState(lines, hasNativeKaraoke, timingSource, translationLines, translationSource, renderOptions) {
  var prepared = preparedLyricStateForApply(lines, hasNativeKaraoke, timingSource, translationLines, translationSource);
  if (skipSameLyricStateRender(prepared, renderOptions, 'applyLyricsState')) {
    updateCustomLyricControls();
    return;
  }
  lyricsHasNativeKaraoke = prepared.hasNativeKaraoke;
  lyricsTimingSource = prepared.timingSource;
  lyricsTranslationLines = cloneLyricLines(prepared.translationLines);
  lyricsTranslationSource = prepared.translationSource;
  lyricsLines = cloneLyricLines(prepared.lines);
  renderLyrics(renderOptions || {});
  updateCustomLyricControls();
}
function applyOriginalLyricsState(renderOptions) {
  lyricSourceMode = 'original';
  applyLyricsState(originalLyricsState.lines, originalLyricsState.hasNativeKaraoke, originalLyricsState.timingSource, originalLyricsState.translationLines, originalLyricsState.translationSource, renderOptions);
}
function parseCustomLyricText(text) {
  var raw = String(text || '').trim();
  if (!raw) return [];
  var lrcLines = parseLyricText(raw);
  if (lrcLines.length && !lrcLines.every(function (line) { return isNoLyricText(line.text); })) {
    return lrcLines.map(function (line) {
      var copy = cloneLyricLine(line);
      copy.source = 'custom-lrc';
      return copy;
    });
  }
  var rows = raw.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(function (line) { return line && !isNoLyricText(line); });
  if (!rows.length) return [];
  var duration = audio && isFinite(audio.duration) && audio.duration > 8 ? audio.duration : 0;
  var gap = duration ? Math.max(2.8, Math.min(7.2, duration / Math.max(1, rows.length))) : 4.8;
  return finalizeLyricLineDurations(rows.map(function (line, i) {
    return { t: i * gap, duration: gap, text: line, source: 'custom-text', charCount: Math.max(1, line.length) };
  }));
}
function applyCustomLyricState(song, silent, renderOptions) {
  song = song || currentLyricSong();
  var entry = getCustomLyricEntry(song);
  if (!entry || !String(entry.text || '').trim()) {
    if (!silent) openCustomLyricModal();
    updateCustomLyricControls();
    return false;
  }
  var lines = parseCustomLyricText(entry.text);
  if (!lines.length) {
    if (!silent) showToast(trackActionText('track_custom_lyrics_empty'));
    updateCustomLyricControls();
    return false;
  }
  lyricSourceMode = 'custom';
  var prepared = preparedLyricStateForApply(lines, false, lines[0] && lines[0].source === 'custom-lrc' ? 'custom-lrc' : 'custom-text', [], 'none');
  if (skipSameLyricStateRender(prepared, renderOptions, 'applyCustomLyricState')) {
    updateCustomLyricControls();
    return true;
  }
  lyricsHasNativeKaraoke = prepared.hasNativeKaraoke;
  lyricsTimingSource = prepared.timingSource;
  lyricsTranslationLines = cloneLyricLines(prepared.translationLines);
  lyricsTranslationSource = prepared.translationSource;
  lyricsLines = cloneLyricLines(prepared.lines);
  renderLyrics(renderOptions || {});
  updateCustomLyricControls();
  return true;
}
function preferredLyricSourceForSong(song) {
  var key = songCustomLyricKey(song);
  var hasCustom = hasCustomLyricForSong(song);
  if (!hasCustom) return 'original';
  var pref = key ? customLyricPrefs[key] : '';
  if (pref === 'custom') return 'custom';
  if (pref === 'original') return 'original';
  return originalLyricsState.timingSource === 'fallback' ? 'custom' : 'original';
}
function applyPreferredLyricsForCurrent(silent) {
  var song = currentLyricSong();
  var renderOptions = { preserveSame: true, reason: 'applyPreferredLyricsForCurrent' };
  if (preferredLyricSourceForSong(song) === 'custom' && applyCustomLyricState(song, true, renderOptions)) return;
  applyOriginalLyricsState(renderOptions);
  if (!silent) updateCustomLyricControls();
}
function setLyricSourceMode(mode, silent) {
  var song = currentLyricSong();
  var key = songCustomLyricKey(song);
  mode = mode === 'custom' ? 'custom' : 'original';
  if (mode === 'custom') {
    if (!applyCustomLyricState(song, true)) {
      if (!silent) openCustomLyricModal();
      return false;
    }
    if (!silent) openCustomLyricModal();
  } else {
    applyOriginalLyricsState();
  }
  if (key) {
    customLyricPrefs[key] = mode;
    saveCustomLyricPrefs();
  }
  if (!silent) showToast(mode === 'custom' ? trackActionText('track_switched_custom_lyrics') : trackActionText('track_switched_original_lyrics'));
  updateCustomLyricControls();
  return true;
}
function updateCustomLyricControls() {
  var song = currentLyricSong();
  var hasCustom = hasCustomLyricForSong(song);
  var originalBtn = document.getElementById('lyric-source-original');
  var customBtn = document.getElementById('lyric-source-custom');
  if (originalBtn) {
    originalBtn.classList.toggle('active', lyricSourceMode !== 'custom');
    originalBtn.title = trackActionText('track_use_netease_or_local_lyrics');
  }
  if (customBtn) {
    customBtn.classList.toggle('active', lyricSourceMode === 'custom');
    customBtn.classList.toggle('has-custom', hasCustom);
    customBtn.title = hasCustom ? trackActionText('track_edit_custom_lyrics') : trackActionText('track_add_custom_lyrics');
  }
}
// 这两个按钮的 title 是持久文案，而本函数平时只在事件里被调用；词典是异步 fetch 的、
// bindFxPanel() 却在解析期就跑，于是解析期固化的键名会一直留在悬停提示里没人改。
// 让词典就绪（init 会广播一次）与后续每次切换都重跑一遍。
// These two titles are persistent copy while this function otherwise only runs from events. The
// dictionary loads asynchronously, so the key name frozen during parse stayed on screen with
// nothing to refresh it. Repaint once the dictionary is ready and on every later switch.
if (typeof window !== 'undefined' && window.MineradioI18n && typeof window.MineradioI18n.onLanguageChange === 'function') {
  window.MineradioI18n.onLanguageChange(function () { updateCustomLyricControls(); });
}
function updateLyricDisplayModeControls() {
  var mode = normalizeLyricDisplayMode(fx && fx.lyricDisplayMode);
  document.querySelectorAll('#lyric-display-mode-seg button').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}
function updateLyricTranslationModeControls() {
  var mode = normalizeLyricTranslationMode(fx && fx.lyricTranslationMode);
  document.querySelectorAll('#lyric-translation-mode-seg button').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.translation === mode);
  });
}
function updateLyricMotionStyleControls() {
  var style = normalizeLyricMotionStyle(fx && fx.lyricMotionStyle);
  var seg = document.getElementById('lyric-motion-style-seg');
  if (seg) seg.classList.toggle('glitch-selected', style === 'glitch');
  document.querySelectorAll('#lyric-motion-style-seg button').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.motion === style);
  });
  updateLyricGlitchControls();
}
function updateLyricGlitchControls() {
  var style = normalizeLyricMotionStyle(fx && fx.lyricMotionStyle);
  var panel = document.getElementById('lyric-glitch-controls');
  if (panel) panel.classList.toggle('show', style === 'glitch');
  var bindBtn = document.getElementById('lyric-glitch-camera-bind');
  if (bindBtn) {
    bindBtn.classList.toggle('active', !!(fx && fx.lyricGlitchCameraBind));
    bindBtn.textContent = fx && fx.lyricGlitchCameraBind ? trackActionText('track_glitch_following_beat') : trackActionText('track_glitch_follow_beat');
  }
}
function toggleLyricGlitchCameraBind() {
  fx.lyricGlitchCameraBind = !fx.lyricGlitchCameraBind;
  updateLyricGlitchControls();
  refreshStageLyricDisplayMode();
  saveLyricLayout({ user: true, reason: 'lyricGlitchCameraBind' });
  showToast(fx.lyricGlitchCameraBind ? trackActionText('track_glitch_beat_on') : trackActionText('track_glitch_beat_off'));
}
function refreshStageLyricDisplayMode() {
  refreshCurrentLyricStyle();
}
function refreshStageLyricVisualOptions() {
  refreshStageLyricDisplayMode();
  pushDesktopLyricsState(true);
}
function setLyricDisplayMode(mode) {
  fx.lyricDisplayMode = normalizeLyricDisplayMode(mode);
  updateLyricDisplayModeControls();
  refreshStageLyricDisplayMode();
  saveLyricLayout({ user: true, reason: 'lyricDisplayMode' });
  showToast(trackActionText('track_lyrics_lines_toggled'));
}
function setLyricTranslationMode(mode) {
  fx.lyricTranslationMode = normalizeLyricTranslationMode(mode);
  updateLyricTranslationModeControls();
  refreshStageLyricDisplayMode();
  saveLyricLayout({ user: true, reason: 'lyricTranslationMode' });
  showToast(trackActionText('translation_switched', '双语翻译已切换'));
}
function setLyricMotionStyle(style) {
  fx.lyricMotionStyle = normalizeLyricMotionStyle(style);
  updateLyricMotionStyleControls();
  refreshStageLyricDisplayMode();
  saveLyricLayout({ user: true, reason: 'lyricMotionStyle' });
  showToast(trackActionText('track_lyrics_anim_toggled'));
}
function setCustomLyricStatus(text, tone) {
  var el = document.getElementById('custom-lyric-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('good', tone === 'good');
  el.classList.toggle('fail', tone === 'fail');
}
function openCustomLyricModal() {
  var song = currentLyricSong();
  if (!song) {
    showToast(trackActionText('track_play_or_select_first'));
    return;
  }
  if (immersiveMode) setImmersiveMode(false);
  var entry = getCustomLyricEntry(song);
  var title = document.getElementById('custom-lyric-title');
  var sub = document.getElementById('custom-lyric-sub');
  var input = document.getElementById('custom-lyric-input');
  if (title) title.textContent = song.name || trackActionText('track_current_song');
  if (sub) sub.textContent = (song.artist || (song.type === 'podcast' ? 'Podcast' : '')) + (entry ? trackActionText('track_lyrics_saved_hint') : trackActionText('track_lyrics_paste_hint'));
  if (input) input.value = entry ? (entry.text || '') : '';
  setCustomLyricStatus(entry ? trackActionText('track_local_lyrics_read') : trackActionText('track_lyrics_timestamp_hint'), entry ? 'good' : '');
  openGsapModal(document.getElementById('custom-lyric-modal'));
  setTimeout(function () { if (input) input.focus(); }, 120);
}
function closeCustomLyricModal() {
  closeGsapModal(document.getElementById('custom-lyric-modal'));
}
function saveCustomLyricForCurrent() {
  var song = currentLyricSong();
  var key = songCustomLyricKey(song);
  var input = document.getElementById('custom-lyric-input');
  var text = input ? String(input.value || '').trim() : '';
  if (!song || !key) {
    setCustomLyricStatus(trackActionText('track_please_play_or_select'), 'fail');
    showToast(trackActionText('track_play_or_select_first'));
    return;
  }
  if (!text) {
    setCustomLyricStatus(trackActionText('track_enter_lyrics'), 'fail');
    return;
  }
  var lines = parseCustomLyricText(text);
  if (!lines.length) {
    setCustomLyricStatus(trackActionText('track_no_lyrics_lines'), 'fail');
    return;
  }
  customLyricMap[key] = { text: text, updatedAt: Date.now() };
  customLyricPrefs[key] = 'custom';
  var saved = saveCustomLyricMap();
  saveCustomLyricPrefs();
  applyCustomLyricState(song, true);
  setCustomLyricStatus(saved ? (trackActionText('track_saved_prefix') + lines.length + trackActionText('track_lyrics_lines_switched')) : trackActionText('track_lyrics_applied_low_storage'), saved ? 'good' : 'fail');
  showToast(saved ? trackActionText('track_custom_lyrics_saved') : trackActionText('track_custom_lyrics_applied'));
  setTimeout(function () { closeCustomLyricModal(); }, 520);
}
function deleteCustomLyricForCurrent() {
  var song = currentLyricSong();
  var key = songCustomLyricKey(song);
  if (!song || !key) {
    setCustomLyricStatus(trackActionText('track_please_play_or_select'), 'fail');
    return;
  }
  if (!customLyricMap[key]) {
    setCustomLyricStatus(trackActionText('track_no_custom_lyrics'), 'fail');
    return;
  }
  delete customLyricMap[key];
  delete customLyricPrefs[key];
  saveCustomLyricMap();
  saveCustomLyricPrefs();
  applyOriginalLyricsState();
  var input = document.getElementById('custom-lyric-input');
  if (input) input.value = '';
  setCustomLyricStatus(trackActionText('track_lyrics_deleted_restored'), 'good');
  showToast(trackActionText('track_lyrics_restored'));
}
var QISHUI_LIKE_ACCOUNT_ACTIONS_ENABLED = true;
var QISHUI_PLAYLIST_WRITE_ACTIONS_ENABLED = true;
function songAccountActionAdapters() {
  return {
  netease: {
    provider: 'netease',
    label: trackActionText('track_netease_music'),
    like: true,
    collect: true,
    createPlaylist: true,
    likeCheckUrl: '/api/song/like/check',
    likeCheckParam: 'ids',
    likeUrl: '/api/song/like',
    playlistAddUrl: '/api/playlist/add-song',
    playlistCreateUrl: '/api/playlist/create',
    playlistTracksUrl: '/api/playlist/tracks'
  },
  kugou: {
    provider: 'kugou',
    label: trackActionText('provider_kugou'),
    like: true,
    collect: true,
    createPlaylist: false,
    likeCheckUrl: '/api/kugou/song/like/check',
    likeCheckParam: 'hashes',
    likeUrl: '/api/kugou/song/like',
    playlistAddUrl: '/api/kugou/playlist/add-song',
    playlistCreateUrl: '',
    playlistTracksUrl: '/api/kugou/playlist/tracks'
  },
  spotify: {
    provider: 'spotify',
    label: 'Spotify',
    like: true,
    collect: true,
    createPlaylist: true,
    likeCheckUrl: '/api/spotify/song/like/check',
    likeCheckParam: 'ids',
    likeUrl: '/api/spotify/song/like',
    playlistAddUrl: '/api/spotify/playlist/add-song',
    playlistCreateUrl: '/api/spotify/playlist/create',
    playlistTracksUrl: '/api/spotify/playlist/tracks'
  },
  qishui: {
    provider: 'qishui',
    label: trackActionText('provider_qishui'),
    like: QISHUI_LIKE_ACCOUNT_ACTIONS_ENABLED,
    collect: QISHUI_PLAYLIST_WRITE_ACTIONS_ENABLED,
    createPlaylist: false,
    likeCheckUrl: QISHUI_LIKE_ACCOUNT_ACTIONS_ENABLED ? '/api/qishui/song/like/check' : '',
    likeCheckParam: 'ids',
    likeUrl: QISHUI_LIKE_ACCOUNT_ACTIONS_ENABLED ? '/api/qishui/song/like' : '',
    playlistAddUrl: QISHUI_PLAYLIST_WRITE_ACTIONS_ENABLED ? '/api/qishui/playlist/add-song' : '',
    playlistCreateUrl: '',
    playlistTracksUrl: '/api/qishui/playlist/tracks'
  },
  qq: {
    provider: 'qq',
    label: trackActionText('login_qq', 'QQ 音乐'),
    like: false,
    collect: false,
    createPlaylist: false,
    readOnly: true
  }
  }
}
function songAccountProvider(song) {
  if (!song || song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') return 'local';
  if (typeof songProviderKey === 'function') return songProviderKey(song);
  if (song.provider === 'spotify' || song.source === 'spotify' || song.type === 'spotify' || song.spotifyId || song.spotifyUri) return 'spotify';
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq';
  if (song.provider === 'qishui' || song.source === 'qishui' || song.type === 'qishui') return 'qishui';
  if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash) return 'kugou';
  return 'netease';
}
function songAccountAdapter(songOrProvider) {
  var provider = typeof songOrProvider === 'string' ? songOrProvider : songAccountProvider(songOrProvider);
  return songAccountActionAdapters()[provider] || null;
}
function songAccountIdentityValues(song, provider) {
  song = song || {};
  provider = provider || songAccountProvider(song);
  var raw = [];
  if (provider === 'kugou') {
    raw = [song.hash, song.audioHash, song.fileHash, song.providerSongId, song.id];
  } else if (provider === 'spotify') {
    raw = [song.spotifyId, song.providerSongId, song.id];
    var uri = String(song.spotifyUri || song.uri || '');
    if (/^spotify:track:/i.test(uri)) raw.push(uri.split(':').pop());
  } else if (provider === 'qishui') {
    raw = [song.providerSongId, song.trackId, song.track_id, song.id];
  } else {
    raw = [song.id];
  }
  var seen = Object.create(null);
  return raw.map(function (value) {
    var normalized = String(value == null ? '' : value).trim();
    return provider === 'kugou' ? normalized.toLowerCase() : normalized;
  }).filter(function (value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}
function songAccountId(song, provider) {
  return songAccountIdentityValues(song, provider)[0] || '';
}
function songAccountStateKey(song) {
  var provider = songAccountProvider(song);
  var id = songAccountId(song, provider);
  return provider && id ? (provider + ':' + id) : '';
}
function playlistAccountProvider(playlist) {
  var provider = String(playlist && (playlist.provider || playlist.source) || '').toLowerCase();
  return /^(mineradio|netease|qq|kugou|qishui|spotify)$/.test(provider) ? provider : 'netease';
}
function songAccountLoginStatus(provider) {
  if (provider === 'spotify') return spotifyLoginStatus || {};
  if (provider === 'qishui') return qishuiLoginStatus || {};
  if (provider === 'kugou') return kugouLoginStatus || {};
  if (provider === 'qq') return qqLoginStatus || {};
  return loginStatus || {};
}
function isSongAccountLoggedIn(provider) {
  var status = songAccountLoginStatus(provider);
  if (provider === 'kugou') return !!(status.loggedIn && status.playbackKeyReady);
  if (provider === 'qishui') return !!(status.loggedIn && (status.webSession || status.cookieReady));
  return !!status.loggedIn;
}
function songAccountUnsupportedMessage(provider, action) {
  var adapter = songAccountAdapter(provider);
  if (adapter && adapter.readOnly) return adapter.label + trackActionText('track_readonly_collection');
  if (provider === 'qishui') return trackActionText('track_qishui_no_account_action');
  if (provider === 'local') {
    return action === 'collect'
      ? trackActionText('local_collect_unsupported', '本地文件暂不支持收藏到网易云歌单')
      : trackActionText('local_like_unsupported', '本地文件暂不支持红心同步');
  }
  return (adapter && adapter.label || trackActionText('track_current_platform')) + trackActionText('track_unsupported_action');
}
function isCloudSong(song) {
  return !!(song && song.id && songAccountProvider(song) === 'netease');
}
function isSongLiked(song) {
  var key = songAccountStateKey(song);
  return !!(key && likedSongMap[key]);
}
function ensureLoggedInForAction(provider) {
  provider = provider || 'netease';
  if (isSongAccountLoggedIn(provider)) return true;
  var adapter = songAccountAdapter(provider);
  showToast(trackActionText('login', '登录') + (adapter && adapter.label || trackActionText('track_corresponding_platform')) + trackActionText('track_then_sync_collection'));
  showLoginModal({ provider: provider });
  return false;
}
function updateLikeButtons(song) {
  song = song || currentCoverSong();
  var liked = isSongLiked(song);
  var stateKey = songAccountStateKey(song);
  var busy = !!(stateKey && likeBusyMap[stateKey]);
  var btn = document.getElementById('heart-btn');
  if (btn) {
    btn.classList.toggle('liked', liked);
    btn.classList.toggle('busy', busy);
    btn.title = liked ? trackActionText('track_unheart') : trackActionText('track_heart_like');
  }
  var collectBtn = document.getElementById('collect-btn');
  if (collectBtn) collectBtn.classList.toggle('busy', collectBusy);
}
function heartIconSvg() {
  return '<svg class="heart-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.45c-.32 0-.62-.12-.86-.34l-1.23-1.12C5.54 16.03 2.25 13.05 2.25 8.9 2.25 5.48 4.88 2.9 8.28 2.9c1.7 0 3.35.72 4.52 1.96C13.97 3.62 15.62 2.9 17.32 2.9c3.4 0 6.03 2.58 6.03 6 0 4.15-3.29 7.13-7.66 11.09l-1.23 1.12c-.24.22-.54.34-.86.34z"/></svg>';
}
function playlistPlusIconSvg() {
  return '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10"/><path d="M4 11h10"/><path d="M4 16h7"/><path d="M18 14v6"/><path d="M15 17h6"/></svg>';
}
function artistCollectTrayIconSvg() {
  return '<svg fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v9"/><path d="M7.5 9.5h9"/><path d="M4.5 12.5v6h15v-6"/></svg>';
}
function artistNextPlusIconSvg() {
  return '<svg fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13"/><path d="M5.5 12h13"/></svg>';
}
function songActionHtml(kind, source, index, song) {
  var liked = isSongLiked(song);
  if (kind === 'like') {
    return '<button class="song-action-btn' + (liked ? ' liked' : '') + '" title="' + (liked ? trackActionText('track_unheart') : trackActionText('track_heart_like')) + '" onclick="event.stopPropagation();toggleLike' + source + '(' + index + ')">' + heartIconSvg() + '</button>';
  }
  return trackActionText('track_collect_btn_prefix_html') + source + '(' + index + ')">' + playlistPlusIconSvg() + '</button>';
}
function syncLikeStatusForSongs(songs) {
  if (!songs || !songs.length) return;
  var groups = Object.create(null);
  songs.forEach(function (song) {
    var provider = songAccountProvider(song);
    var adapter = songAccountAdapter(provider);
    var id = songAccountId(song, provider);
    if (!adapter || !adapter.like || !adapter.likeCheckUrl || !id || !isSongAccountLoggedIn(provider)) return;
    if (!groups[provider]) groups[provider] = { adapter: adapter, ids: [], seen: Object.create(null) };
    if (groups[provider].seen[id]) return;
    groups[provider].seen[id] = true;
    groups[provider].ids.push(id);
  });
  var providers = Object.keys(groups);
  if (!providers.length) return;
  var token = ++likeStatusToken;
  var requests = [];
  providers.forEach(function (provider) {
    var group = groups[provider];
    var batchSize = provider === 'spotify' || provider === 'qishui' ? 40 : (provider === 'kugou' ? 50 : 200);
    for (var offset = 0; offset < group.ids.length; offset += batchSize) {
      (function (batchIds) {
        var url = group.adapter.likeCheckUrl + '?' + group.adapter.likeCheckParam + '=' + encodeURIComponent(batchIds.join(','));
        requests.push(apiJson(url).then(function (r) {
          if (token < likeStatusToken - 3 || !r || !r.liked) return;
          var responseLiked = r.liked || {};
          batchIds.forEach(function (id) {
            var responseId = provider === 'kugou' ? String(id).toLowerCase() : String(id);
            var liked = responseLiked[responseId];
            if (liked == null) liked = responseLiked[id];
            if (liked == null) return;
            if (provider === 'qishui' && r.complete === false && !liked) return;
            likedSongMap[provider + ':' + responseId] = !!liked;
          });
        }).catch(function (err) {
          console.warn(provider + ' like check failed:', err);
        }));
      })(group.ids.slice(offset, offset + batchSize));
    }
  });
  Promise.all(requests).then(function () {
    if (token < likeStatusToken - 3) return;
    safeRenderQueuePanel('like-status-sync', { scrollCurrent: miniQueueOpen });
    if ($results && $results.classList.contains('show')) refreshSearchResultActionStates();
    updateLikeButtons();
  });
}
function syncLikeStatusForSong(song) {
  var adapter = songAccountAdapter(song);
  if (!adapter || !adapter.like) { updateLikeButtons(song); return; }
  syncLikeStatusForSongs([song]);
}
function isLikedPlaylistContext(id, title, meta) {
  var rawId = String(id || '');
  var idParts = rawId.match(/^(netease|qq|kugou|qishui|spotify):(.*)$/);
  var provider = idParts ? idParts[1] : playlistAccountProvider(meta);
  var sid = idParts ? idParts[2] : rawId;
  var text = String(title || (meta && meta.name) || '').trim();
  var hit = userPlaylists.find(function (pl) {
    return playlistAccountProvider(pl) === provider && String(pl.id || '') === sid;
  });
  if (hit) {
    if (Number(hit.specialType || 0) === 5) return true;
    text = text || hit.name || '';
  }
  return /我喜欢|喜欢的音乐|liked/i.test(text);
}
function markSongsLiked(songs, liked) {
  (songs || []).forEach(function (song) {
    var key = songAccountStateKey(song);
    if (key) likedSongMap[key] = !!liked;
  });
}
function refreshSearchResultActionStates() {
  if (!playlist || !$results || !$results.children.length) return;
  Array.prototype.forEach.call($results.querySelectorAll('[data-like-index]'), function (btn) {
    var i = Number(btn.getAttribute('data-like-index'));
    var song = playlist[i];
    var liked = isSongLiked(song);
    btn.classList.toggle('liked', liked);
    btn.title = liked ? trackActionText('track_unheart') : trackActionText('track_heart_like');
  });
}
async function toggleLikeSong(song) {
  var provider = songAccountProvider(song);
  var adapter = songAccountAdapter(provider);
  if (!adapter || !adapter.like || !adapter.likeUrl) {
    showToast(songAccountUnsupportedMessage(provider, 'like'));
    return;
  }
  if (!ensureLoggedInForAction(provider)) return;
  var id = songAccountId(song, provider);
  var stateKey = songAccountStateKey(song);
  if (!id || !stateKey) {
    showToast(trackActionText('track_current_song_missing') + adapter.label + trackActionText('track_song_id'));
    return;
  }
  if (likeBusyMap[stateKey]) return;
  var next = !likedSongMap[stateKey];
  likeBusyMap[stateKey] = true;
  likedSongMap[stateKey] = next;
  updateLikeButtons(song);
  safeRenderQueuePanel('like-toggle-optimistic', { scrollCurrent: miniQueueOpen });
  refreshSearchResultActionStates();
  try {
    var r = await apiJson(adapter.likeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, like: next, song: song })
    });
    if (r && (r.error || r.success === false)) throw new Error(r.error || r.message || 'LIKE_FAILED');
    likedSongMap[stateKey] = r && r.liked != null ? !!r.liked : next;
    showToast(next ? trackActionText('track_hearted') : trackActionText('track_unhearted'));
  } catch (err) {
    likedSongMap[stateKey] = !next;
    var errorText = String(err && err.message || '');
    if (/SCOPE|PERMISSION/i.test(errorText)) {
      showToast(trackActionText('track_auth_no_write_permission'));
    } else if (/LOGIN_REQUIRED|AUTH_REQUIRED/i.test(errorText)) {
      showToast(adapter.label + trackActionText('track_login_expired'));
    } else {
      // errorText 可能是后端机器码，分类判断已经用完，显示前换成词典文案。
      // errorText may be a backend machine code; classification is done with it,
      // so swap it for dictionary copy before showing it.
      showToast(errorText ? (trackActionText('track_heart_failed_prefix') + backendCodeDisplay(errorText)) : trackActionText('track_heart_failed'));
    }
  } finally {
    delete likeBusyMap[stateKey];
    updateLikeButtons(song);
    safeRenderQueuePanel('like-toggle-final', { scrollCurrent: miniQueueOpen });
    refreshSearchResultActionStates();
  }
}
function toggleLikeCurrent() { toggleLikeSong(currentCoverSong()); }
function toggleLikeSearchResult(i) { if (playlist[i]) toggleLikeSong(playlist[i]); }
function toggleLikeQueueIndex(i) { if (playQueue[i]) toggleLikeSong(playQueue[i]); }
function toggleLikeDetailSong(song) { toggleLikeSong(song); }
function openCollectModal(song) {
  if (!song) return;
  collectTargetSong = song;
  renderCollectModal();
  openGsapModal(document.getElementById('collect-modal'));
  var provider = songAccountProvider(song);
  var refresh = isSongAccountLoggedIn(provider) && typeof refreshUserPlaylists === 'function'
    ? refreshUserPlaylists(true)
    : (typeof refreshBuiltInPlaylists === 'function' ? refreshBuiltInPlaylists(true) : Promise.resolve());
  Promise.resolve(refresh).then(function () { renderCollectModal(); }).catch(function () { renderCollectModal(); });
}
function openCollectModalForCurrent() { openCollectModal(currentCoverSong()); }
function collectSearchResult(i) { if (playlist[i]) openCollectModal(playlist[i]); }
function collectQueueIndex(i) { if (playQueue[i]) openCollectModal(playQueue[i]); }
function collectDetailSong(song) { openCollectModal(song); }
function closeCollectModal() {
  closeGsapModal(document.getElementById('collect-modal'), function () {
    collectTargetSong = null;
    var input = document.getElementById('collect-new-name');
    if (input) input.value = '';
  });
}
function renderCollectModal() {
  var current = document.getElementById('collect-current');
  var list = document.getElementById('collect-list');
  if (!current || !list) return;
  var song = collectTargetSong || {};
  var cover = songCoverSrc(song, 80);
  current.innerHTML = (cover ? '<img src="' + cover + '" alt="">' : '<div class="cover-placeholder"></div>') +
    '<div style="min-width:0"><div class="collect-title">' + escHtml(song.name || trackActionText('track_current_song')) + '</div><div class="collect-sub">' + escHtml(song.artist || '') + '</div></div>';
  var provider = songAccountProvider(song);
  var adapter = songAccountAdapter(provider);
  var localRows = (builtInPlaylists || []).map(function (pl) {
    var thumb = pl.cover ? coverUrlWithSize(pl.cover, 80) : '';
    return '<div class="collect-item" data-collect-key="builtin:' + escHtml(String(pl.id || '')) + '" onclick="addCollectTargetToBuiltInPlaylist(this.getAttribute(\'data-built-in-pid\'))" data-built-in-pid="' + escHtml(String(pl.id || '')) + '">' +
      (thumb ? '<img src="' + thumb + '" alt="">' : '<div class="cover-placeholder built-in">MR</div>') +
      '<div style="min-width:0"><div class="collect-title">' + escHtml(pl.name || '') + '</div><div class="collect-sub">' + (pl.trackCount || 0) + trackActionText('track_count_mixable_html') +
      '</div>';
  }).join('');
  var html = trackActionText('track_builtin_title_html') +
    (localRows || trackActionText('track_no_builtin_html'));
  var canWritePlatform = !!(adapter && adapter.collect && adapter.playlistAddUrl && isSongAccountLoggedIn(provider));
  if (canWritePlatform) {
    var mine = userPlaylists.filter(function (pl) {
      return playlistAccountProvider(pl) === provider && !pl.subscribed && !pl.virtual;
    });
    if (mine.length) {
      html += trackActionText('track_sync_to_prefix_html') + escHtml(adapter.label) + trackActionText('track_write_account_html') + mine.map(function (pl) {
        var thumb = pl.cover ? coverUrlWithSize(pl.cover, 80) : '';
        return '<div class="collect-item" data-collect-key="platform:' + escHtml(String(pl.id || '')) + '" data-collect-pid="' + escHtml(String(pl.id || '')) + '" onclick="addCollectTargetToPlaylist(this.getAttribute(\'data-collect-pid\'))">' +
          (thumb ? '<img src="' + thumb + '" alt="">' : '<div class="cover-placeholder"></div>') +
          '<div style="min-width:0"><div class="collect-title">' + escHtml(pl.name || '') + '</div><div class="collect-sub">' + (pl.trackCount || 0) + trackActionText('track_count_suffix_html') +
          '</div>';
      }).join('');
    }
  }
  list.innerHTML = html;
  if (window.gsap) animateListItems(list, '.collect-item', { x: 0, y: 6, stagger: 0.012, duration: 0.18, limit: 18 });
}
function setCollectBusyPid(pid, busy, kind) {
  var list = document.getElementById('collect-list');
  if (!list) return;
  var key = (kind || 'platform') + ':' + String(pid);
  list.querySelectorAll('.collect-item').forEach(function (item) {
    item.classList.toggle('busy', !!busy && item.getAttribute('data-collect-key') === key);
  });
}
async function createPlaylistFromCollect() {
  var input = document.getElementById('collect-new-name');
  var name = input ? input.value.trim() : '';
  if (!name) { showToast(trackActionText('track_enter_playlist_name')); return; }
  try {
    var created = await createBuiltInPlaylist(name, collectTargetSong);
    if (!created) return;
    if (input) input.value = '';
    closeCollectModal();
  } catch (err) {
    console.warn('[BuiltInPlaylistCreateCollect]', err);
    showToast(trackActionText('track_builtin_create_failed'));
  }
}
async function addCollectTargetToBuiltInPlaylist(pid) {
  if (collectBusy || !collectTargetSong || !pid) return;
  collectBusy = true;
  setCollectBusyPid(pid, true, 'builtin');
  try {
    var added = await addTrackToBuiltInPlaylist(pid, collectTargetSong);
    if (added) closeCollectModal();
  } catch (err) {
    console.warn('[BuiltInPlaylistCollect]', err);
    showToast(trackActionText('track_builtin_add_failed'));
  } finally {
    collectBusy = false;
    setCollectBusyPid(pid, false, 'builtin');
  }
}
function collectResultMessage(r) {
  if (!r) return trackActionText('track_collect_failed');
  var msg = r.error || r.message || r.msg || '';
  if (/LOGIN_REQUIRED|AUTH_REQUIRED/i.test(String(msg))) return trackActionText('login_sync_netease', '平台登录状态已失效，请重新登录');
  if (/SCOPE|PERMISSION/i.test(String(msg))) return trackActionText('track_auth_no_write_permission');
  if (/exist|重复|已存在|already/i.test(String(msg))) return trackActionText('track_already_in_playlist');
  return msg ? (trackActionText('track_collect_failed_prefix') + backendCodeDisplay(msg)) : trackActionText('track_collect_failed');
}
function playlistTracksPageUrl(adapter, pid, offset, limit) {
  var url = adapter.playlistTracksUrl + '?id=' + encodeURIComponent(pid);
  if (limit) url += '&limit=' + encodeURIComponent(String(limit));
  if (offset) url += '&offset=' + encodeURIComponent(String(offset));
  return url;
}
function playlistContainsAccountSong(tracks, song, provider) {
  var expected = songAccountIdentityValues(song, provider);
  if (!expected.length) return false;
  var expectedSet = Object.create(null);
  expected.forEach(function (id) { expectedSet[id] = true; });
  return (tracks || []).some(function (track) {
    return songAccountIdentityValues(track, provider).some(function (id) { return !!expectedSet[id]; });
  });
}
async function verifySongInPlaylist(pid, song) {
  var provider = songAccountProvider(song);
  var adapter = songAccountAdapter(provider);
  if (!pid || !adapter || !adapter.playlistTracksUrl || !songAccountId(song, provider)) return false;
  var pageLimit = provider === 'spotify' || provider === 'qishui' ? 50 : 200;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      await new Promise(function (resolve) { setTimeout(resolve, attempt === 1 ? 360 : 820); });
    }
    try {
      var detail = await apiJson(playlistTracksPageUrl(adapter, pid, 0, pageLimit));
      var tracks = (detail && detail.tracks) || [];
      if (playlistContainsAccountSong(tracks, song, provider)) return true;
      var total = Math.max(0, Number(detail && (detail.total || (detail.playlist && detail.playlist.trackCount))) || 0);
      var lastOffset = total > pageLimit ? Math.max(0, total - pageLimit) : 0;
      if (lastOffset) {
        var lastPage = await apiJson(playlistTracksPageUrl(adapter, pid, lastOffset, pageLimit));
        if (playlistContainsAccountSong((lastPage && lastPage.tracks) || [], song, provider)) return true;
      }
    } catch (e) {
      console.warn(provider + ' collect verify failed:', e);
    }
  }
  return false;
}
async function addCollectTargetToPlaylist(pid) {
  if (collectBusy || !collectTargetSong || !pid) return;
  var targetSong = collectTargetSong;
  var provider = songAccountProvider(targetSong);
  var adapter = songAccountAdapter(provider);
  if (!adapter || !adapter.collect || !adapter.playlistAddUrl) {
    showToast(songAccountUnsupportedMessage(provider, 'collect'));
    return;
  }
  if (!ensureLoggedInForAction(provider)) return;
  collectBusy = true;
  setCollectBusyPid(pid, true);
  updateLikeButtons();
  showToast(trackActionText('track_collecting_to_playlist'));
  try {
    var songId = songAccountId(targetSong, provider);
    if (!songId) throw new Error(trackActionText('track_current_song_missing') + adapter.label + trackActionText('track_song_id'));
    var r = await apiJson(adapter.playlistAddUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: pid, id: songId, song: targetSong })
    });
    if (!r || r.error || r.success === false) throw new Error(collectResultMessage(r));
    showToast(trackActionText('track_collected_to_playlist'));
    closeCollectModal();
    refreshUserPlaylists(true);
    setTimeout(function () {
      verifySongInPlaylist(pid, targetSong).then(function (ok) {
        if (!ok) console.warn(provider + ' collect submitted but verify did not find song yet:', pid, songId);
      });
    }, 900);
  } catch (err) {
    showToast(err && err.message ? err.message : trackActionText('track_collect_failed'));
  } finally {
    collectBusy = false;
    setCollectBusyPid(pid, false);
    updateLikeButtons();
  }
}
function cloneSong(song) { return hydrateCustomCover(Object.assign({}, song)); }
function avatarSrc(url) {
  if (!url) return '';
  return coverProxySrc(url, true);
}

// ============================================================
//  搜索
