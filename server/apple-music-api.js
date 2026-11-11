// Apple Music search bridge.
//
// The companion owns the signed-in WebView and the MusicKit calls. The local
// server only forwards an operation and normalises the page results into the
// SongResult shape every Mineradio provider already produces.
//
// Apple Music tracks are external-playback entries: they have no direct audio
// URL, but they are playable through the companion's playSong operation.

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

async function handleAppleMusicPlaylistTracks(requester, playlistId, limit, offset) {
  playlistId = String(playlistId || '');
  // Library playlist IDs are opaque strings (usually p.<id>); reject control
  // characters before forwarding them to the companion request validator.
  if (!playlistId || playlistId.length > 256 || !/^[A-Za-z0-9._-]+$/.test(playlistId)) {
    return { provider: 'applemusic', configured: !!requester, songs: [], error: 'invalid-playlist' };
  }
  limit = Math.max(1, Math.min(100, Number(limit) || 25));
  offset = Math.max(0, Number(offset) || 0);
  if (typeof requester !== 'function') {
    return {
      provider: 'applemusic',
      configured: false,
      songs: [],
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
      songs: [],
      error,
      message: error === 'auth-required' ? '请先在 Apple Music 中登录。' : 'Apple Music 歌单加载失败，请稍后再试。',
    };
  }
  const data = (result && result.data) || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const songs = items.map((item, index) => mapAppleMusicSong(item, index, '')).filter(Boolean);
  return {
    provider: 'applemusic',
    configured: true,
    songs,
    offset,
    limit,
    nextOffset: Number.isFinite(data.nextOffset) ? data.nextOffset : offset + items.length,
    hasMore: data.hasMore === true,
  };
}

module.exports = {
  handleAppleMusicSearch,
  handleAppleMusicPlaylists,
  handleAppleMusicPlaylistTracks,
  mapAppleMusicSong,
  mapAppleMusicPlaylist,
};
