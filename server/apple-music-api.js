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
  // 🔴 Apple 的歌单里偶尔混进非歌曲条目（艺人 `a.xxx`、音乐视频等），它们的 id 不是可播的
  // catalog id。以前一律当歌映射，结果队列里出现 `catalogId: "a.6824409350"` 这种行，
  // 点播放必然失败（实测日志：am-start-rejected / reason=no-catalog-id）。
  // 但 `a.` 也是**新版资料库歌曲**的 id 空间：歌单曲目实测返回 `a.6825256856`，
  // `playParams.catalogId` 是有效的 `6825256856`。只按前缀拦会把整个歌单丢空
  // （用户看到的就是"98 首歌的歌单没有歌"）。所以判据换成：纯数字 / `i.` / 或
  // **带合法 catalogId 的 `a.`**，再加上 kind 必须是 song。
  // `a.` ids are also used by newer library songs; rejecting the prefix alone emptied whole
  // playlists. Accept it when playParams carries a real catalog id, and keep the song-kind gate.
  const catalogFromParams = appleMusicText(playParams.catalogId, 256);
  const catalogNumeric = /^\d{1,40}$/.test(catalogFromParams);
  const idPlayable = /^\d{1,40}$/.test(id)
    || /^i\.[A-Za-z0-9._-]{1,198}$/.test(id)
    || (/^a\.[A-Za-z0-9._-]{1,198}$/.test(id) && catalogNumeric);
  const kind = String(playParams.kind || '').toLowerCase();
  if (!idPlayable || (kind && kind !== 'song')) return null;
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
    // catalogId 只认数字；资料库条目退回自己的 `i.` id，交给渲染端 resolveSong 换算。
    // 带 catalogId 的 `a.` 资料库歌曲直接用那个数字。
    catalogId: catalogNumeric ? catalogFromParams
      : (/^\d{1,40}$/.test(id) ? id : (/^i\./.test(id) ? id : '')),
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
// 曲目数**不能**跟着歌单列表一起算：companion 是串行的，`playlistTrackCount` 冷的时候一次
// 要十几秒，而 Promise.race 超时只是放弃等待、并不会取消那次请求 —— 被放弃的请求继续占着
// 通道，于是"第一次加载成功、第二次打开歌单就排不进去"。现在改成独立接口：列表立刻返回，
// 前端在列表渲染完之后单独、一次一批地问。
// Track counts must not ride along with the list: the companion serialises requests, and an
// abandoned count call keeps occupying it (Promise.race does not cancel the underlying call).
// They now live behind their own endpoint, requested by the UI once the list is on screen.
const APPLE_MUSIC_COUNT_BUDGET_MS = 2000;
const APPLE_MUSIC_COUNT_MAX = 4;
const APPLE_MUSIC_COUNT_ATTEMPT_MS = 700;

async function handleAppleMusicPlaylistCounts(requester, ids) {
  const wanted = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id || ''))
    .filter((id) => /^p\.[A-Za-z0-9._-]{1,198}$/.test(id))
    .slice(0, APPLE_MUSIC_COUNT_MAX);
  if (typeof requester !== 'function' || !wanted.length) {
    return { provider: 'applemusic', counts: {}, error: wanted.length ? 'APPLE_MUSIC_RUNTIME_UNAVAILABLE' : '' };
  }
  const counts = {};
  const deadline = Date.now() + APPLE_MUSIC_COUNT_BUDGET_MS;
  // 严格串行：并发只会让更多请求在超时后被"放弃"，全都留在通道里。
  // Strictly sequential: concurrency only creates more abandoned-but-still-running calls.
  for (const id of wanted) {
    if (Date.now() >= deadline) break;
    const budget = Math.max(400, Math.min(APPLE_MUSIC_COUNT_ATTEMPT_MS, deadline - Date.now()));
    try {
      const answer = await Promise.race([
        requester('playlistTrackCount', { playlistId: id, limit: 1, offset: 0 }),
        new Promise((resolve) => { const timer = setTimeout(() => resolve(null), budget); if (timer.unref) timer.unref(); }),
      ]);
      const total = answer && answer.ok === true && answer.data ? answer.data.total : null;
      if (Number.isSafeInteger(total) && total >= 0) counts[id] = total;
    } catch (_) { /* 读不到就不写，前端保持原样 */ }
  }
  return { provider: 'applemusic', counts };
}

// Folia 的在线集合是"缓存优先"：曲目/歌单存在本地，键没变就直接渲染、后台再刷新
// （`onlineCollectionCache.service.ts`）。companion 的请求要串行过 WebView2，往返一次几百毫秒
// 到十几秒，反复开关歌单时这份往返完全没必要。这里做一层短 TTL 的进程内缓存：同一个
// requester + 同一页，20 秒内直接复用。requester 变了（换实例/测试）就整体作废。
// Folia renders online collections from a local cache first; the same idea here, in-process:
// a 20 s TTL for repeated opens of the same page.
const APPLE_MUSIC_PLAYLISTS_CACHE_TTL_MS = 120000;
let appleMusicPlaylistsCache = new Map();
let appleMusicPlaylistsCacheRequester = null;

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
  if (appleMusicPlaylistsCacheRequester !== requester) {
    appleMusicPlaylistsCache = new Map();
    appleMusicPlaylistsCacheRequester = requester;
  }
  const cacheKey = limit + '|' + offset;
  const cached = appleMusicPlaylistsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < APPLE_MUSIC_PLAYLISTS_CACHE_TTL_MS) return cached.payload;

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
  const payload = {
    provider: 'applemusic',
    configured: true,
    playlists,
    offset,
    limit,
    nextOffset: Number.isFinite(data.nextOffset) ? data.nextOffset : offset + items.length,
    hasMore: data.hasMore === true,
    total: Number.isFinite(data.total) ? data.total : null,
  };
  appleMusicPlaylistsCache.set(cacheKey, { at: Date.now(), payload });
  return payload;
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
  handleAppleMusicPlaylistCounts,
  handleAppleMusicLyric,
  mapAppleMusicSong,
  mapAppleMusicPlaylist,
};
