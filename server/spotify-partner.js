'use strict';

// server/spotify-partner.js
// Spotify 的第二条通道：Spotify 自家客户端走的那两个服务，而不是 public Web API。
//
// 为什么要有它：公开的 api.spotify.com/v1 用的是"应用级"滚动配额，Mineradio 内置的这枚
// Client ID 是全体用户共享的，随便一刷新就 429，而且 429 之后越重试越出不来。Folia 的结论
// 更直接 —— 同一个 Client ID 下，Web API 从第一个请求就 429（他们 2026-10-08 实测），所以他
// 们根本不碰 /v1：
//
//   * 读数据 → api-partner.spotify.com/pathfinder/v2/query（持久化查询 + sha256 哈希）
//   * 写歌单、读方案、读歌词 → spclient.wg.spotify.com
//
// 这里照抄 Folia 的做法与本文件用到的查询哈希，让 Mineradio 的 Spotify 接入"独立成一套"，
// 与原来那条 /v1 的岔路并存：本模块可用就走它，不可用（哈希被换、网络失败）再由调用方退回
// Web API。哈希是 Spotify 随时可以换的私有接口，换掉时这里会抛 SPOTIFY_PARTNER_RETIRED，
// 上层据此临时降级并打印日志，不需要改代码结构。
//
// Every read below is a persisted query on Spotify's own query service, and every write goes to
// spclient, exactly the way Folia's electron/spotify/spotifyApiBridge.cjs does it. The hashes were
// read from that file (measured by Folia on 2026-10-08). Spotify can retire one at any time; this
// module reports that as SPOTIFY_PARTNER_RETIRED so the caller can fall back to the Web API.

const QUERY_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const SPCLIENT_URL = 'https://spclient.wg.spotify.com';

// pathfinder / spclient 是 Spotify 给自家 Web 播放器用的私有服务，风控按"像不像浏览器"判断。
// 用 `Mineradio/2.1.0 (Spotify Web API bridge)` 这类自造 UA 打过去，服务端会直接按异常客户端
// 限流（429，且带一个十几秒的 Retry-After），跟账号配额无关 —— 同一个令牌在 spclient 的歌词
// 接口上完全正常，说明被拒的是"客户端身份"而不是用户。Folia 走的是 Electron 的 fetch，
// 默认 UA 就是 Chromium，所以它们从没遇到这个。
// pathfinder and spclient are Spotify's private services for its own web player and police traffic
// by "does this look like a browser". A made-up UA like `Mineradio/2.1.0 (Spotify Web API bridge)`
// is throttled as an abnormal client (429 with a ten-something second Retry-After) regardless of
// the account quota: the same token works fine against spclient's lyrics endpoint, so it is the
// client identity that is rejected, not the user. Folia uses Electron's fetch, whose default UA is
// Chromium, which is why it never hits this.
const PARTNER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// 用到的持久化查询及其哈希（与 Folia 逐字一致）。
const QUERIES = Object.freeze({
  profileAttributes: '53bcb064f6cd18c23f752bc324a791194d20df612d8e1239c735144ab0399ced',
  libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
  fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
  fetchPlaylist: 'cd2275433b29f7316176e7b5b5e098ae7744724e1a52d63549c76636b3257749',
  getAlbum: 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10',
  searchTracks: 'bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428',
  getTrack: '612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294',
  areEntitiesInLibrary: '134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed',
});

// 对账号库和歌单的改动，同样带哈希。这些不由前端直接指定：前端只说"改成什么"。
const CHANGES = Object.freeze({
  addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
  removeFromLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
  addItemsToRootlist: 'bd9c5cae1ee80ebca05d7ed12fd394216f49a20ce72d9dc762868df0f14522ea',
  removeItemsFromRootlist: '3422f1866532820a1d8d0560f88542dbdbd35d0377ee5ecd49593590f5f1e86b',
  addToPlaylist: '47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990',
  removeFromPlaylist: '47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990',
});

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_NAME_LENGTH = 100;
const MAX_SONGS_A_CHANGE = 100;
// 去重读歌单时最多扫这么多行：只为判断"这首歌在不在里面"，没必要整张读完。
const DEDUPE_MAX_ROWS = 2000;
const DEDUPE_PAGE_ROWS = 200;
const TRACK_ID = /^[0-9A-Za-z]{22}$/;
const PLAYLIST_URI = /^spotify:playlist:[0-9A-Za-z]{22}$/;
const LIBRARY_URI = /^spotify:(track|album|playlist):[0-9A-Za-z]{22}$/;

function partnerError(code, message, detail) {
  const err = new Error(message || code);
  err.code = code;
  if (detail) err.detail = String(detail).slice(0, 400);
  return err;
}

function retiredError(name, cause, said) {
  const err = partnerError(
    'SPOTIFY_PARTNER_RETIRED',
    'Spotify 的持久化查询 ' + name + ' 已失效',
    said || (cause && (cause.body || cause.message)) || ''
  );
  err.partnerQuery = name;
  return err;
}

function pickPicture(sources) {
  if (!Array.isArray(sources)) return '';
  let best = '';
  let bestWidth = -1;
  sources.forEach((source) => {
    if (!source || typeof source.url !== 'string' || !source.url) return;
    const width = Number(source.width) || 0;
    if (width > bestWidth) {
      best = source.url;
      bestWidth = width;
    }
  });
  return best;
}

// spotify:track:<id>、老式 spotify:user:<name>:playlist:<id> 都要能取出 id。
function idFromUri(uri, kind) {
  if (typeof uri !== 'string') return '';
  const match = new RegExp('^spotify:(?:user:[^:]+:)?' + kind + ':([0-9A-Za-z]{22})$').exec(uri);
  return match ? match[1] : '';
}

// 歌单简介是一行 HTML：去掉标签、还原实体。
function plainText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#x27|#39);/g, (all, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', '#x27': '\'', '#39': '\'',
    }[name] || ''))
    .trim();
}

function artistRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && row.profile && row.profile.name)
    .map(row => ({ id: idFromUri(row.uri, 'artist'), name: String(row.profile.name), uri: String(row.uri || '') }));
}

// pathfinder 的曲目在每种查询里都叫同一个东西，只是各自少一部分字段：喜欢的歌把 uri 放在
// 行上，专辑里的曲目没有 albumOfTrack，艺人的热门曲目里专辑没有名字。
function songOf(track, beside) {
  beside = beside || {};
  if (!track || typeof track !== 'object') return null;
  if (typeof track.__typename === 'string' && track.__typename !== 'Track') return null;
  const uri = typeof track.uri === 'string' && track.uri ? track.uri : beside.uri;
  const id = idFromUri(uri, 'track');
  const name = typeof track.name === 'string' ? track.name : '';
  if (!id || !name) return null;
  const artists = artistRows(track.artists && track.artists.items);
  const albumOfTrack = track.albumOfTrack || {};
  const album = beside.album || {
    id: idFromUri(albumOfTrack.uri, 'album'),
    name: typeof albumOfTrack.name === 'string' ? albumOfTrack.name : '',
    uri: typeof albumOfTrack.uri === 'string' ? albumOfTrack.uri : '',
    cover: pickPicture(albumOfTrack.coverArt && albumOfTrack.coverArt.sources),
  };
  const durationMs = Math.max(0, Number(
    (track.duration && track.duration.totalMilliseconds) ||
    (track.trackDuration && track.trackDuration.totalMilliseconds)
  ) || 0);
  return {
    id,
    uri: 'spotify:track:' + id,
    name,
    artists,
    artist: artists.map(artist => artist.name).join(' / '),
    album: album.name || '',
    albumId: album.id || '',
    albumUri: album.uri || '',
    cover: album.cover || '',
    durationMs,
  };
}

// 曲目数在不同查询里挂在不同的地方：歌单页（fetchPlaylist）是 content.totalCount，
// 但库列表（libraryV3）的持久化查询来自网页端"资料库"那一页 —— 那页本来就不显示曲目数，
// 所以它很可能根本没求这个字段。全按 content.totalCount 读，库列表就会整页 0 首，
// 而点进歌单（走 fetchPlaylist）曲目却是全的。
// Track counts live in different places per query: the playlist page carries content.totalCount,
// but the library list comes from the web player's own persisted query, which does not render
// track counts there and may not request them at all.
const PLAYLIST_TRACK_COUNT_PATHS = [
  list => list.content && list.content.totalCount,
  list => list.tracksV2 && list.tracksV2.totalCount,
  list => list.tracks && list.tracks.totalCount,
  list => list.totalCount,
  list => list._content && list._content.totalCount,
];
function playlistTrackCount(list) {
  if (!list || typeof list !== 'object') return 0;
  for (const read of PLAYLIST_TRACK_COUNT_PATHS) {
    let value = null;
    try { value = read(list); } catch (_) { value = null; }
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return 0;
}

function playlistCard(list) {
  if (!list || typeof list !== 'object') return null;
  const id = idFromUri(list.uri, 'playlist');
  if (!id) return null;
  const images = list.images && Array.isArray(list.images.items) ? list.images.items : [];
  const owner = (list.ownerV2 && list.ownerV2.data) || {};
  return {
    id,
    uri: typeof list.uri === 'string' ? list.uri : 'spotify:playlist:' + id,
    name: typeof list.name === 'string' ? list.name : '',
    cover: images.length ? pickPicture(images[0] && images[0].sources) : '',
    description: plainText(list.description),
    ownerName: typeof owner.name === 'string' ? owner.name : '',
    ownerUsername: typeof owner.username === 'string' ? owner.username : '',
    trackCount: playlistTrackCount(list),
    following: list.following === true,
    canEdit: !!(list.currentUserCapabilities && list.currentUserCapabilities.canEditItems),
  };
}

function albumCard(union) {
  const id = idFromUri(union && union.uri, 'album');
  if (!id) return null;
  const artists = artistRows(union.artists && union.artists.items);
  return {
    id,
    uri: 'spotify:album:' + id,
    name: typeof union.name === 'string' ? union.name : '',
    cover: pickPicture(union.coverArt && union.coverArt.sources),
    artists,
    artist: artists.map(artist => artist.name).join(' / '),
    releaseDate: (union.date && (union.date.isoString || union.date.year)) || '',
    trackCount: Number((union.tracksV2 && union.tracksV2.totalCount) || (union.tracks && union.tracks.totalCount)) || 0,
  };
}

function libraryVariables(kind, limit, offset) {
  // 文件夹会被展开成它里面的歌单：flatten + includeFoldersWhenFlattening。
  return {
    filters: [kind],
    order: null,
    textFilter: '',
    features: [],
    limit,
    offset,
    flatten: true,
    expandedFolders: [],
    folderUri: null,
    includeFoldersWhenFlattening: true,
  };
}

// `requestJson(url, opts, body)` 由调用方注入（server/spotify-api.js 已经有一个 https 封装，
// 带 429 需要的 retry-after 与 body，重写一份没有意义）。
// `getAccessToken()` 返回可用的用户令牌；`refreshAccessToken()` 强制换一枚新的（401 时用）。
function createSpotifyPartner(options) {
  options = options || {};
  const requestJson = options.requestJson;
  const getAccessToken = options.getAccessToken;
  const refreshAccessToken = options.refreshAccessToken || (() => getAccessToken({ force: true }));
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const language = options.language || 'zh-CN';
  const log = options.log || (() => {});
  const warn = options.warn || (() => {});
  if (typeof requestJson !== 'function' || typeof getAccessToken !== 'function') {
    throw new Error('createSpotifyPartner needs requestJson and getAccessToken');
  }
  let ownUsername = '';

  async function call(url, init) {
    init = init || {};
    const body = init.body == null
      ? null
      : (typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
    const headers = Object.assign({
      Accept: 'application/json',
      'Accept-Language': language,
      'User-Agent': PARTNER_UA,
    }, init.headers || {});
    if (body != null) headers['Content-Type'] = 'application/json';
    const send = bearer => requestJson(url, {
      method: init.method || (body == null ? 'GET' : 'POST'),
      timeoutMs: init.timeoutMs || timeoutMs,
      headers: Object.assign({}, headers, { Authorization: 'Bearer ' + bearer }),
    }, body);
    const token = init.token || await getAccessToken();
    try {
      return await send(token);
    } catch (err) {
      // 令牌过期只有一种正确处理：换一枚再打一次。别的状态码都不该重试。
      if (Number(err && err.statusCode) === 401 && !init.token) {
        await refreshAccessToken();
        return send(await getAccessToken());
      }
      throw err;
    }
  }

  // 一个命名查询：返回它的 data，顺带把 Spotify 说的错误打出来。
  async function ask(name, variables, token) {
    const hash = QUERIES[name];
    if (!hash) throw partnerError('SPOTIFY_PARTNER_UNSUPPORTED', '未知的 Spotify 查询：' + name);
    let answer;
    try {
      answer = await call(QUERY_URL, {
        token,
        method: 'POST',
        body: {
          variables: variables || {},
          operationName: name,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        },
      });
    } catch (err) {
      // pathfinder 对"这枚哈希我不知道"的两种答法：400 带错误体，或 404。
      const status = Number(err && err.statusCode) || 0;
      if (status === 400 || status === 404) throw retiredError(name, err);
      throw err;
    }
    const errors = answer && Array.isArray(answer.errors) ? answer.errors : [];
    const said = errors.map(error => error && error.message).filter(Boolean).join(' | ').slice(0, 200);
    if (!answer || !answer.data) {
      // 只有"哈希不认识"才该整体降级。查询本身没数据（歌单不存在之类）是正常结果，
      // 把整条通道关掉五分钟只会让下一次请求白跑一趟 Web API。
      // Only an unknown hash should disable the whole channel. "No data for this query" (a missing
      // playlist, say) is an ordinary answer; disabling for five minutes would be wrong.
      if (/persisted|hash|document|not found/i.test(said || '') || !said) throw retiredError(name, null, said);
      throw partnerError('SPOTIFY_PARTNER_NO_DATA', 'Spotify 没有返回 ' + name + ' 的数据', said);
    }
    if (said) warn('[SpotifyPartner] ' + name + ' 只答了一部分：' + said);
    return answer.data;
  }

  // 一次改动只有在 Spotify 没报错、并且给出了结果时才算完成：被拒的改动是 200 + 空 data。
  async function change(name, variables) {
    const hash = CHANGES[name];
    if (!hash) throw partnerError('SPOTIFY_PARTNER_UNSUPPORTED', '未知的 Spotify 改动：' + name);
    let answer;
    try {
      answer = await call(QUERY_URL, {
        method: 'POST',
        body: {
          variables: variables || {},
          operationName: name,
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        },
      });
    } catch (err) {
      const status = Number(err && err.statusCode) || 0;
      if (status === 400 || status === 404) throw retiredError(name, err);
      throw err;
    }
    const errors = answer && Array.isArray(answer.errors) ? answer.errors : [];
    const said = errors.map(error => error && error.message).filter(Boolean).join(' | ').slice(0, 200);
    const results = answer && answer.data && typeof answer.data === 'object' ? Object.values(answer.data) : [];
    if (errors.length || !results.length || results.some(result => result === null)) {
      throw partnerError('SPOTIFY_PARTNER_CHANGE_REFUSED', 'Spotify 拒绝了这次改动', said || 'empty result');
    }
    return true;
  }

  // 谁登录着、是不是付费：付费与否决定 Spotify 给不给音频（与 Mineradio 的换源无关）。
  async function readAccount(token) {
    const [data, plan] = await Promise.all([
      ask('profileAttributes', {}, token),
      call(SPCLIENT_URL + '/melody/v1/product_state?market=from_token', { token }).catch((err) => {
        warn('[SpotifyPartner] 读不到账号方案：' + (err && err.message));
        return null;
      }),
    ]);
    const profile = data && data.me && data.me.profile;
    const username = profile && typeof profile.username === 'string' ? profile.username : '';
    if (!username) throw partnerError('SPOTIFY_PARTNER_NO_ACCOUNT', 'Spotify 没有给出账号信息');
    ownUsername = username;
    const pictures = profile.avatar && Array.isArray(profile.avatar.sources) ? profile.avatar.sources : [];
    const premium = plan ? (plan.catalogue === 'premium' || plan.product === 'premium') : undefined;
    return {
      id: username,
      username,
      nickname: String(profile.name || 'Spotify'),
      avatar: pickPicture(pictures),
      premium,
      product: premium === undefined ? 'unknown' : (premium ? 'premium' : 'free'),
    };
  }

  async function searchTracks(text, offset, limit) {
    const data = await ask('searchTracks', {
      searchTerm: text,
      offset,
      limit,
      includePreReleases: false,
      numberOfTopResults: 20,
      includeAudiobooks: true,
      includeAuthors: false,
    });
    const block = data && data.searchV2 && data.searchV2.tracksV2;
    const rows = block && Array.isArray(block.items) ? block.items : [];
    return {
      songs: rows.map(row => songOf(row && row.item && row.item.data)).filter(Boolean),
      rows: rows.length,
      total: Number(block && block.totalCount) || 0,
    };
  }

  async function likedTracks(offset, limit) {
    const data = await ask('fetchLibraryTracks', { offset, limit });
    const tracks = data && data.me && data.me.library && data.me.library.tracks;
    const rows = tracks && Array.isArray(tracks.items) ? tracks.items : [];
    return {
      songs: rows.map(row => songOf(row && row.track && row.track.data, {
        uri: row && row.track && row.track._uri,
      })).filter(Boolean),
      rows: rows.length,
      total: Number(tracks && tracks.totalCount) || 0,
    };
  }

  async function libraryPlaylists(offset, limit) {
    const data = await ask('libraryV3', libraryVariables('Playlists', limit, offset));
    const library = data && data.me && data.me.libraryV3;
    const rows = library && Array.isArray(library.items) ? library.items : [];
    return {
      playlists: rows.map(row => playlistCard(row && row.item && row.item.data)).filter(Boolean),
      rows: rows.length,
      total: Number(library && library.totalCount) || 0,
    };
  }

  async function playlistHead(playlistIdOrUri) {
    const uri = PLAYLIST_URI.test(playlistIdOrUri) ? playlistIdOrUri : 'spotify:playlist:' + playlistIdOrUri;
    const data = await ask('fetchPlaylist', { uri, offset: 0, limit: 1, enableWatchFeedEntrypoint: false });
    return playlistCard(data && data.playlistV2);
  }

  async function playlistTracks(playlistIdOrUri, offset, limit) {
    const uri = PLAYLIST_URI.test(playlistIdOrUri) ? playlistIdOrUri : 'spotify:playlist:' + playlistIdOrUri;
    const data = await ask('fetchPlaylist', { uri, offset, limit, enableWatchFeedEntrypoint: false });
    const list = data && data.playlistV2;
    if (!list) throw partnerError('SPOTIFY_PARTNER_NO_PLAYLIST', 'Spotify 没有返回这个歌单');
    const rows = list.content && Array.isArray(list.content.items) ? list.content.items : [];
    return {
      playlist: playlistCard(list),
      songs: rows.map(row => songOf(row && row.itemV2 && row.itemV2.data)).filter(Boolean),
      rows: rows.length,
      total: Number(list.content && list.content.totalCount) || 0,
    };
  }

  async function album(albumIdOrUri, offset, limit) {
    const uri = /^spotify:album:[0-9A-Za-z]{22}$/.test(albumIdOrUri)
      ? albumIdOrUri
      : 'spotify:album:' + albumIdOrUri;
    const data = await ask('getAlbum', { uri, locale: '', offset, limit });
    const union = data && data.albumUnion;
    const card = albumCard(union);
    if (!card) throw partnerError('SPOTIFY_PARTNER_NO_ALBUM', 'Spotify 没有返回这张专辑');
    const tracksV2 = union.tracksV2 || {};
    const rows = Array.isArray(tracksV2.items) ? tracksV2.items : [];
    return {
      album: card,
      songs: rows.map(row => songOf(row && row.track, { album: card })).filter(Boolean),
      rows: rows.length,
      total: Number(tracksV2.totalCount) || card.trackCount || 0,
    };
  }

  // 逐条回答"这张专辑/这首歌在不在库里"，顺序与传入的 uri 一一对应。
  async function libraryLookup(uris) {
    if (!Array.isArray(uris) || !uris.length) return {};
    const data = await ask('areEntitiesInLibrary', { uris });
    const rows = data && Array.isArray(data.lookup) ? data.lookup : [];
    const saved = {};
    uris.forEach((uri, index) => {
      const value = rows[index] && rows[index].data && rows[index].data.saved;
      saved[uri] = value === true;
    });
    return saved;
  }

  async function setLibrary(uri, saved) {
    const match = LIBRARY_URI.exec(String(uri || ''));
    if (!match) throw partnerError('SPOTIFY_PARTNER_INVALID_ITEM', '无法识别的 Spotify 条目：' + uri);
    if (match[1] === 'playlist') {
      // 自己的歌单不能"取消收藏"：那等于把它从库里删掉，Spotify 会照做。
      const head = await playlistHead(uri);
      if (head && ownUsername && head.ownerUsername && head.ownerUsername === ownUsername) {
        throw partnerError('SPOTIFY_PARTNER_OWN_PLAYLIST', '这是本账号自己的歌单，不能从收藏里移除');
      }
      await change(saved ? 'addItemsToRootlist' : 'removeItemsFromRootlist', { uris: [uri] });
      return true;
    }
    await change(saved ? 'addToLibrary' : 'removeFromLibrary', { libraryItemUris: [uri] });
    return true;
  }

  // 歌单里已经有的曲子不再放一次（Spotify 自己会放成两行）。只扫前 DEDUPE_MAX_ROWS 行。
  async function playlistHasSongs(uri, songs) {
    const found = new Set();
    let offset = 0;
    while (offset < DEDUPE_MAX_ROWS) {
      const page = await playlistTracks(uri, offset, DEDUPE_PAGE_ROWS);
      for (const song of page.songs) {
        if (songs.indexOf('spotify:track:' + song.id) >= 0) found.add(song.id);
      }
      offset += page.rows;
      if (!page.rows || offset >= page.total) break;
    }
    return found;
  }

  async function addToPlaylist(playlistIdOrUri, trackIds) {
    const uri = PLAYLIST_URI.test(playlistIdOrUri) ? playlistIdOrUri : 'spotify:playlist:' + playlistIdOrUri;
    if (!PLAYLIST_URI.test(uri)) throw partnerError('SPOTIFY_PARTNER_INVALID_PLAYLIST', '无法识别的 Spotify 歌单：' + playlistIdOrUri);
    const ids = Array.isArray(trackIds) ? [...new Set(trackIds)] : [];
    if (!ids.length || ids.length > MAX_SONGS_A_CHANGE || !ids.every(id => TRACK_ID.test(String(id)))) {
      throw partnerError('SPOTIFY_PARTNER_INVALID_TRACK', '无法识别的 Spotify 曲目');
    }
    const songs = ids.map(id => 'spotify:track:' + id);
    let existing = new Set();
    try {
      existing = await playlistHasSongs(uri, songs);
    } catch (err) {
      // 读不到歌单不代表不能写；去重是锦上添花，别让它挡了收藏这个动作。
      warn('[SpotifyPartner] 歌单去重读取失败，直接写入：' + (err && err.message));
    }
    const fresh = songs.filter(song => !existing.has(song.slice('spotify:track:'.length)));
    if (!fresh.length) return { added: 0, existing: songs.length };
    await change('addToPlaylist', {
      playlistItemUris: fresh,
      playlistUri: uri,
      newPosition: { moveType: 'BOTTOM_OF_PLAYLIST', fromUid: null },
    });
    return { added: fresh.length, existing: songs.length - fresh.length };
  }

  async function createPlaylist(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
      throw partnerError('SPOTIFY_PARTNER_INVALID_NAME', '歌单名字不合法');
    }
    // spclient 一次 ops 建空歌单，再把它放进账号库 —— 与 Folia 的两步一致。
    const made = await call(SPCLIENT_URL + '/playlist/v2/playlist?format=json', {
      method: 'POST',
      body: {
        ops: [{ kind: 'UPDATE_LIST_ATTRIBUTES', updateListAttributes: { newAttributes: { values: { name: trimmed } } } }],
      },
    });
    if (!made || typeof made.uri !== 'string' || !PLAYLIST_URI.test(made.uri)) {
      throw partnerError('SPOTIFY_PARTNER_NO_PLAYLIST', 'Spotify 没有给出新歌单的地址');
    }
    await change('addItemsToRootlist', { uris: [made.uri] });
    log('[SpotifyPartner] 新建歌单 ' + made.uri);
    return { id: made.uri.slice('spotify:playlist:'.length), uri: made.uri, name: trimmed };
  }

  // Spotify 自己的歌词，按行带时间戳。没有 app-platform 头时服务端回 400。
  async function lyrics(trackId) {
    if (!TRACK_ID.test(String(trackId || ''))) throw partnerError('SPOTIFY_PARTNER_INVALID_TRACK', '无法识别的 Spotify 曲目');
    let answer = null;
    try {
      answer = await call(
        SPCLIENT_URL + '/color-lyrics/v2/track/' + trackId + '?format=json&vocalRemoval=false&market=from_token',
        { headers: { 'app-platform': 'WebPlayer' } }
      );
    } catch (err) {
      if (Number(err && err.statusCode) === 404) return null;
      throw err;
    }
    const lines = answer && answer.lyrics && Array.isArray(answer.lyrics.lines) ? answer.lyrics.lines : [];
    if (!lines.length) return null;
    return {
      timed: !!(answer.lyrics && answer.lyrics.syncType === 'LINE_SYNCED'),
      lines: lines.map(line => ({
        startMs: Number(line && line.startTimeMs) || 0,
        words: String((line && line.words) || ''),
      })),
    };
  }

  return {
    channel: 'pathfinder',
    query: ask,
    change,
    readAccount,
    searchTracks,
    likedTracks,
    libraryPlaylists,
    playlistHead,
    playlistTracks,
    album,
    libraryLookup,
    setLibrary,
    addToPlaylist,
    createPlaylist,
    lyrics,
  };
}

module.exports = { createSpotifyPartner, QUERIES, CHANGES, QUERY_URL, SPCLIENT_URL };
