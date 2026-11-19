// Apple Music search bridge.
//
// The companion owns the signed-in WebView and the MusicKit calls. The local
// server only forwards an operation and normalises the page results into the
// SongResult shape every Mineradio provider already produces.
//
// Apple Music tracks are external-playback entries: they have no direct audio
// URL, but they are playable through the companion's playSong operation.

const { convertAppleMusicTtmlToLyric } = require('./apple-music-lyrics.js');

function appleMusicText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit || 4096) : '';
}

function appleMusicArtwork(url) {
  const text = appleMusicText(url, 2048);
  if (!text) return '';
  // MusicKit gives a template such as .../{w}x{h}bb.jpg.
  return text.replace(/\{w\}x\{h\}/g, '600x600').replace(/\{w\}/g, '600').replace(/\{h\}/g, '600');
}

function mapAppleMusicSong(item, index, query) {
  const id = appleMusicText(item && item.id, 256);
  const a = (item && item.attributes) || {};
  const name = appleMusicText(a.name, 1024);
  if (!id || !name) return null;
  const playParams = a.playParams || {};
  const durationMs = Number.isFinite(a.durationInMillis) ? Math.max(0, a.durationInMillis) : 0;
  const albums = Array.isArray(a.catalogAlbums) ? a.catalogAlbums : [];
  const artists = Array.isArray(a.catalogArtists) ? a.catalogArtists : [];
  const album = albums[0] || {};
  const artist = appleMusicText(a.artistName, 1024)
    || artists.map((entry) => appleMusicText(entry && entry.name, 512)).filter(Boolean).join(' / ');
  return {
    provider: 'applemusic',
    source: 'applemusic',
    type: 'applemusic',
    id,
    providerSongId: id,
    appleMusicId: id,
    catalogId: appleMusicText(playParams.catalogId, 256) || id,
    name,
    artist,
    artists: (artists.length ? artists : (artist ? [{ name: artist }] : [])).map((entry) => ({
      id: appleMusicText(entry && entry.id, 256),
      name: appleMusicText(entry && entry.name, 1024),
    })).filter((entry) => entry.name),
    album: appleMusicText(a.albumName, 1024),
    albumId: appleMusicText(album.id, 256),
    cover: appleMusicArtwork(a.artwork && a.artwork.url),
    duration: Math.round(durationMs / 1000),
    durationMs,
    isrc: appleMusicText(a.isrc, 64),
    fee: 0,
    // No direct URL: the companion WebView is the player. The playback layer
    // must branch on externalPlayback instead of feeding this to <audio>.
    playable: true,
    externalPlayback: true,
    playbackMode: 'external',
    companionOperation: 'playSong',
    appleMusicIndex: index,
    appleMusicQuery: query || '',
  };
}

function mapAppleMusicPlaylist(item, index) {
  const id = appleMusicText(item && item.id, 256);
  const a = (item && item.attributes) || {};
  const name = appleMusicText(a.name, 1024);
  if (!id || !name) return null;
  const trackCount = Number.isSafeInteger(a.trackCount) && a.trackCount >= 0 ? a.trackCount : 0;
  return {
    id,
    provider: 'applemusic',
    source: 'applemusic',
    type: 'applemusic',
    name,
    // The library playlist's curator is the signed-in account or an editorial
    // name; keep it short because the card only has one subtitle line.
    creator: appleMusicText(a.artistName, 256),
    cover: appleMusicArtwork(a.artwork && a.artwork.url),
    trackCount,
    canEdit: a.canEdit === true,
    isFavoritePlaylist: a.isFavoritePlaylist === true,
    externalPlayback: true,
    appleMusicIndex: index,
  };
}

function dedupeAppleMusicSongs(songs) {
  const out = [];
  const seen = new Set();
  (songs || []).forEach((song) => {
    if (!song || !song.name) return;
    const key = `${song.id}|${String(song.name).toLowerCase()}|${String(song.artist).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(song);
  });
  return out;
}

async function handleAppleMusicSearch(requester, keywords, limit, offset) {
  keywords = String(keywords || '').trim().slice(0, 200);
  limit = Math.max(1, Math.min(20, Number(limit) || 8));
  offset = Math.max(0, Number(offset) || 0);
  if (!keywords) return { provider: 'applemusic', configured: !!requester, songs: [], message: '' };
  if (typeof requester !== 'function') {
    return {
      provider: 'applemusic',
      configured: false,
      songs: [],
      error: 'APPLE_MUSIC_RUNTIME_UNAVAILABLE',
      message: 'Apple Music 组件尚未就绪。',
    };
  }
  const result = await requester('search', { query: keywords, limit, offset });
  if (!result || result.ok !== true) {
    const error = (result && result.error) || 'request-failed';
    return {
      provider: 'applemusic',
      configured: true,
      songs: [],
      error,
      message: error === 'auth-required' ? '请先在 Apple Music 中登录。' : 'Apple Music 搜索失败，请稍后再试。',
    };
  }
  const data = (result && result.data) || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const songs = dedupeAppleMusicSongs(items.map((item, index) => mapAppleMusicSong(item, index, keywords)).filter(Boolean)).slice(0, limit);
  return {
    provider: 'applemusic',
    configured: true,
    songs,
    rawCount: items.length,
    offset,
    limit,
    nextOffset: Number.isFinite(data.nextOffset) ? data.nextOffset : offset + items.length,
    hasMore: data.hasMore === true,
    message: songs.length ? '' : 'Apple Music 没有返回匹配结果。',
  };
}

// 目录接口不带曲目数：library playlists 的属性里没有 trackCount，卡片于是一律显示「0 首」。
// Apple 另有一个只读一行的计数接口，Folia 补卡片的做法也一样。这里并发两路、总预算 2.5 秒，
// 读不到就保持 0 —— 计数是可选的，绝不能让它拖慢或拖垮整页目录。
// The catalog page carries no track count (library playlists have no trackCount attribute), so every
// card read "0 首". Apple has a one-row counting read, and Folia fills cards the same way. Two lanes,
// 2.5 s of total budget, and a missing count simply stays 0: the count is optional and must never
// slow the page down or fail it.
const APPLE_MUSIC_COUNT_BUDGET_MS = 2500;
const APPLE_MUSIC_COUNT_MAX = 10;
const APPLE_MUSIC_COUNT_ATTEMPT_MS = 1200;
async function fillAppleMusicPlaylistTrackCounts(requester, playlists) {
  const pending = playlists
    .filter((item) => item && item.id && !(item.trackCount > 0))
    .slice(0, APPLE_MUSIC_COUNT_MAX);
  if (!pending.length) return;
  const deadline = Date.now() + APPLE_MUSIC_COUNT_BUDGET_MS;
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length && Date.now() < deadline) {
      const item = pending[cursor++];
      const budget = Math.max(300, Math.min(APPLE_MUSIC_COUNT_ATTEMPT_MS, deadline - Date.now()));
      try {
        const answer = await Promise.race([
          requester('playlistTrackCount', { playlistId: item.id, limit: 1, offset: 0 }),
          new Promise((resolve) => { const timer = setTimeout(() => resolve(null), budget); if (timer.unref) timer.unref(); }),
        ]);
        const total = answer && answer.ok === true && answer.data ? answer.data.total : null;
        if (Number.isSafeInteger(total) && total >= 0) item.trackCount = total;
      } catch (_) { /* 读不到就保持 0 */ }
    }
  };
  await Promise.all([worker(), worker()]);
}

async function handleAppleMusicPlaylists(requester, limit, offset) {
  limit = Math.max(1, Math.min(100, Number(limit) || 25));
  offset = Math.max(0, Number(offset) || 0);
  if (typeof requester !== 'function') {
    return {
      provider: 'applemusic',
      configured: false,
      playlists: [],
      error: 'APPLE_MUSIC_RUNTIME_UNAVAILABLE',
      message: 'Apple Music 组件尚未就绪。',
    };
  }
  const result = await requester('playlists', { limit, offset });
  if (!result || result.ok !== true) {
    const error = (result && result.error) || 'request-failed';
    return {
      provider: 'applemusic',
      configured: true,
      playlists: [],
      error,
      message: error === 'auth-required' ? '请先在 Apple Music 中登录。' : 'Apple Music 歌单加载失败，请稍后再试。',
    };
  }
  const data = (result && result.data) || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const playlists = items.map(mapAppleMusicPlaylist).filter(Boolean).slice(0, limit);
  await fillAppleMusicPlaylistTrackCounts(requester, playlists);
  return {
    provider: 'applemusic',
    configured: true,
    playlists,
    offset,
    limit,
    nextOffset: Number.isFinite(data.nextOffset) ? data.nextOffset : offset + items.length,
    hasMore: data.hasMore === true,
    total: Number.isFinite(data.total) ? data.total : null,
  };
}

// 🔴 歌单曲目必须用 `tracks` 这个名字：左栏详情与队列续页（06-lyrics/02-playlist-detail.js
// 的 loadMorePlaylistPanelDetailTracks、03-podcast-playlist-loaders.js 的 loadPlaylistIntoQueueById）
// 读的都是 `r.tracks`，和网易云/QQ/酷狗/汽水/Spotify 一致。这里曾经叫 `songs`，
// 于是歌单卡片有名字有封面、点进去永远一首都没有。
// Playlist tracks must be keyed `tracks`: both the left-panel detail view and the queue hydration
// read `r.tracks`, like every other provider. This endpoint once answered `songs`, so playlist
// cards had a name and a cover while the opened list was always empty.
async function handleAppleMusicPlaylistTracks(requester, playlistId, limit, offset) {
  playlistId = String(playlistId || '');
  // Library playlist IDs are opaque strings (usually p.<id>); reject control
  // characters before forwarding them to the companion request validator.
  if (!playlistId || playlistId.length > 256 || !/^[A-Za-z0-9._-]+$/.test(playlistId)) {
    return { provider: 'applemusic', configured: !!requester, tracks: [], error: 'invalid-playlist' };
  }
  limit = Math.max(1, Math.min(100, Number(limit) || 25));
  offset = Math.max(0, Number(offset) || 0);
  if (typeof requester !== 'function') {
    return {
      provider: 'applemusic',
      configured: false,
      tracks: [],
      error: 'APPLE_MUSIC_RUNTIME_UNAVAILABLE',
      message: 'Apple Music 组件尚未就绪。',
    };
  }
  const result = await requester('playlistTracks', { playlistId, limit, offset });
  if (!result || result.ok !== true) {
    const error = (result && result.error) || 'request-failed';
    return {
      provider: 'applemusic',
      configured: true,
      tracks: [],
      error,
      message: error === 'auth-required' ? '请先在 Apple Music 中登录。' : 'Apple Music 歌单加载失败，请稍后再试。',
    };
  }
  const data = (result && result.data) || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const tracks = items.map((item, index) => mapAppleMusicSong(item, index, '')).filter(Boolean);
  return {
    provider: 'applemusic',
    configured: true,
    // 歌单归属由调用方的卡片自带（名称、封面、曲目数），这里只补曲目与翻页信息。
    // The card already carries the playlist identity; this page only adds tracks and paging.
    playlist: { id: playlistId, provider: 'applemusic', source: 'applemusic', type: 'applemusic' },
    tracks,
    offset,
    limit,
    nextOffset: Number.isFinite(data.nextOffset) ? data.nextOffset : offset + items.length,
    hasMore: data.hasMore === true,
  };
}

// ── 歌词 ────────────────────────────────────────────────────────────────────────
// companion 早就会读 Apple 的 syllable-lyrics（TTML），但上层一直没接：前端把 Apple 的
// `i.xxx` / catalog id 直接塞进了网易云的 `/api/lyric`，那里的 id 空间完全不同，于是
// Apple Music 播任何歌都只有「歌名 - 歌手」占位，既没有逐行也没有逐字。
// The companion has always been able to read Apple's syllable-lyrics TTML, but nothing above it
// called the operation: the renderer fed Apple's `i.xxx` / catalog id straight into Netease's
// `/api/lyric`, whose id space is unrelated, so every Apple track showed the title placeholder.
const APPLE_MUSIC_LYRIC_CACHE_TTL_MS = 30 * 60 * 1000;
const APPLE_MUSIC_LYRIC_CACHE_MAX = 200;
const appleMusicLyricCache = new Map();

function readAppleMusicLyricCache(songId) {
  const hit = appleMusicLyricCache.get(songId);
  if (!hit) return null;
  if (Date.now() - hit.at > APPLE_MUSIC_LYRIC_CACHE_TTL_MS) {
    appleMusicLyricCache.delete(songId);
    return null;
  }
  return hit.payload;
}

function writeAppleMusicLyricCache(songId, payload) {
  if (!songId || !payload) return;
  appleMusicLyricCache.set(songId, { at: Date.now(), payload });
  while (appleMusicLyricCache.size > APPLE_MUSIC_LYRIC_CACHE_MAX) {
    const oldest = appleMusicLyricCache.keys().next();
    if (oldest.done) break;
    appleMusicLyricCache.delete(oldest.value);
  }
}

// 空歌词也回一个 `lyric: ''` 的信封：前端看到空文本会退回占位文本，不会当成请求失败去重试。
// An empty answer still comes back as a `lyric: ''` envelope so the renderer falls back to the
// placeholder instead of treating it as a failed request and retrying.
async function handleAppleMusicLyric(requester, songId) {
  const id = String(songId || '').trim();
  const base = { provider: 'applemusic', id, lyric: '', tlyric: '', yrc: '', ytlrc: '', source: 'none' };
  // Apple 的歌词只认 catalog id（纯数字）。库内 `i.xxx` 走的也是同一个 catalog 资源，
  // 调用方必须先换成 catalogId。
  // Apple's lyric resource is catalog-only (digits); library `i.xxx` ids must be mapped to the
  // catalog id before the call.
  if (!/^\d{1,40}$/.test(id)) {
    return { ...base, error: 'invalid-song-id', message: 'Apple Music 歌词需要 catalog id。' };
  }
  const cached = readAppleMusicLyricCache(id);
  if (cached) return cached;
  if (typeof requester !== 'function') {
    return { ...base, configured: false, error: 'APPLE_MUSIC_RUNTIME_UNAVAILABLE', message: 'Apple Music 组件尚未就绪。' };
  }
  let result;
  try {
    result = await requester('lyrics', { songId: id });
  } catch (err) {
    return { ...base, configured: true, error: 'request-failed', message: String((err && err.message) || err).slice(0, 200) };
  }
  const ttml = result && result.ok === true && result.data ? result.data.ttml : '';
  const converted = convertAppleMusicTtmlToLyric(ttml);
  if (!converted) {
    // 纯音乐、Apple 没上歌词、或这一版只有行级文本拿不到：都算「没有」，不是错误。
    // Instrumentals, tracks Apple has no lyric for, and unusable payloads are all "none", not errors.
    const error = (result && result.error) || (ttml ? 'lyric-unusable' : 'lyrics-unavailable');
    const payload = { ...base, configured: true, error, message: 'Apple Music 没有这首的歌词。' };
    // `lyrics-unavailable` 会缓存：一首纯音乐反复切歌不必每次都打一趟 Apple。
    if (error === 'lyrics-unavailable') writeAppleMusicLyricCache(id, payload);
    return payload;
  }
  const payload = {
    ...base,
    configured: true,
    lyric: converted.lyric,
    yrc: converted.yrc,
    source: 'applemusic',
    timing: converted.timing,
    lineCount: converted.lineCount,
    message: '',
  };
  writeAppleMusicLyricCache(id, payload);
  return payload;
}

module.exports = {
  handleAppleMusicSearch,
  handleAppleMusicPlaylists,
  handleAppleMusicPlaylistTracks,
  handleAppleMusicLyric,
  mapAppleMusicSong,
  mapAppleMusicPlaylist,
};
