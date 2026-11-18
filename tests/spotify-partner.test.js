'use strict';

// Spotify 的 pathfinder 通道（server/spotify-partner.js）：按 Folia 的写法读 Spotify 自家
// 客户端用的那两个服务，而不是 public Web API。
// The pathfinder channel: reads through the two services Spotify's own clients use, the way
// Folia does, instead of the public Web API.

const assert = require('assert');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const TRACK_A = '1111111111111111111111';
const TRACK_B = '5555555555555555555555';
const TRACK_C = '6666666666666666666666';
const TRACK_D = '7777777777777777777777';
const ARTIST = '2222222222222222222222';
const ALBUM = '3333333333333333333333';
const PLAYLIST = '4444444444444444444444';

const track = (id, name, extra) => Object.assign({
  __typename: 'Track',
  uri: 'spotify:track:' + id,
  name,
  artists: { items: [{ uri: 'spotify:artist:' + ARTIST, profile: { name: 'Alice Cooper' } }] },
  albumOfTrack: {
    uri: 'spotify:album:' + ALBUM,
    name: 'Album One',
    coverArt: { sources: [{ url: 'https://img/cover-300.jpg', width: 300 }, { url: 'https://img/cover-64.jpg', width: 64 }] },
  },
  duration: { totalMilliseconds: 193000 },
}, extra || {});

// 每个 operationName 的固定答复，形状照 pathfinder 的真实返回裁剪。
const ANSWERS = {
  profileAttributes: {
    data: {
      me: {
        profile: {
          username: 'alice',
          name: 'Alice',
          avatar: { sources: [{ url: 'https://img/avatar-160.jpg', width: 160 }] },
        },
      },
    },
  },
  fetchLibraryTracks: (variables) => ({
    data: {
      me: {
        library: {
          tracks: {
            totalCount: 2,
            items: variables.limit === 1
              ? [{ track: { _uri: 'spotify:track:' + TRACK_A, data: track(TRACK_A, 'Liked One') } }]
              : [
                { track: { _uri: 'spotify:track:' + TRACK_A, data: track(TRACK_A, 'Liked One') } },
                { track: { _uri: 'spotify:track:' + TRACK_B, data: track(TRACK_B, 'Liked Two') } },
              ],
          },
        },
      },
    },
  }),
  libraryV3: () => ({
    data: {
      me: {
        libraryV3: {
          totalCount: 1,
          items: [{
            item: {
              data: {
                __typename: 'Playlist',
                uri: 'spotify:playlist:' + PLAYLIST,
                name: 'Morning Mix',
                description: '<b>slow</b> start',
                images: { items: [{ sources: [{ url: 'https://img/pl.jpg', width: 300 }] }] },
                ownerV2: { data: { name: 'Alice', username: 'alice' } },
                content: { totalCount: 7 },
                currentUserCapabilities: { canEditItems: true },
              },
            },
          }],
        },
      },
    },
  }),
  fetchPlaylist: (variables) => ({
    data: {
      playlistV2: {
        __typename: 'Playlist',
        uri: 'spotify:playlist:' + PLAYLIST,
        name: 'Morning Mix',
        images: { items: [{ sources: [{ url: 'https://img/pl.jpg', width: 300 }] }] },
        ownerV2: { data: { name: 'Alice', username: 'alice' } },
        currentUserCapabilities: { canEditItems: true },
        content: {
          totalCount: 1,
          items: [{ uid: 'row-1', itemV2: { data: track(TRACK_B, 'From Playlist') } }],
        },
      },
    },
  }),
  getAlbum: () => ({
    data: {
      albumUnion: {
        __typename: 'Album',
        uri: 'spotify:album:' + ALBUM,
        name: 'Album One',
        coverArt: { sources: [{ url: 'https://img/cover-300.jpg', width: 300 }] },
        artists: { items: [{ uri: 'spotify:artist:' + ARTIST, profile: { name: 'Alice Cooper' } }] },
        date: { isoString: '2020-03-01' },
        tracksV2: { totalCount: 1, items: [{ track: track(TRACK_C, 'From Album', { albumOfTrack: undefined }) }] },
      },
    },
  }),
  searchTracks: () => ({
    data: {
      searchV2: {
        tracksV2: {
          totalCount: 1,
          items: [{ item: { data: track(TRACK_D, 'Found Song') } }],
        },
      },
    },
  }),
  areEntitiesInLibrary: () => ({ data: { lookup: [{ data: { saved: true } }] } }),
  addToLibrary: () => ({ data: { addToLibrary: { __typename: 'AddToLibraryResponse' } } }),
  removeFromLibrary: () => ({ data: { removeFromLibrary: { __typename: 'RemoveFromLibraryResponse' } } }),
};

function withHttpsMock(handler, task) {
  const original = https.request;
  // pathfinder / spclient 走 fetch（undici），Web API 与 token 走裸 https：两条路都要桩住，
  // 否则测试会真的连到 Spotify，计数也就没意义了。
  // pathfinder/spclient use fetch while the Web API and token endpoint use bare https, so both
  // have to be stubbed or the test reaches Spotify for real and every count is meaningless.
  const originalFetch = globalThis.fetch;
  https.request = function mockedRequest(targetUrl, options, callback) {
    const request = new EventEmitter();
    const chunks = [];
    request.write = chunk => chunks.push(Buffer.from(String(chunk)));
    request.destroy = error => process.nextTick(() => request.emit('error', error || new Error('destroyed')));
    request.end = () => {
      Promise.resolve(handler({
        url: String(targetUrl),
        options: options || {},
        body: Buffer.concat(chunks).toString('utf8'),
      })).then((result) => {
        result = result || {};
        const response = new EventEmitter();
        response.statusCode = Number(result.statusCode || 200);
        response.headers = result.headers || {};
        callback(response);
        process.nextTick(() => {
          if (result.body != null) response.emit('data', Buffer.from(typeof result.body === 'string' ? result.body : JSON.stringify(result.body)));
          response.emit('end');
        });
      }).catch(error => request.emit('error', error));
    };
    return request;
  };
  globalThis.fetch = async (targetUrl, options) => {
    const init = options || {};
    const result = (await handler({
      url: String(targetUrl),
      options: { headers: init.headers || {} },
      body: init.body == null ? '' : String(init.body),
    })) || {};
    const status = Number(result.statusCode || 200);
    const headerMap = new Map(Object.keys(result.headers || {}).map(key => [String(key).toLowerCase(), String(result.headers[key])]));
    const text = result.body == null ? '' : (typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: name => (headerMap.has(String(name).toLowerCase()) ? headerMap.get(String(name).toLowerCase()) : null) },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return Promise.resolve().then(task).finally(() => {
    https.request = original;
    globalThis.fetch = originalFetch;
  });
}

// 一个把三家域名都分开记账的桩：pathfinder / spclient / Web API 各自计数。
function makeRouter(state) {
  return ({ url, body, options }) => {
    if (url.includes('accounts.spotify.com')) {
      state.tokenCalls += 1;
      return { body: { access_token: 'fresh-access', expires_in: 3600 } };
    }
    if (url.includes('api-partner.spotify.com')) {
      state.partnerCalls += 1;
      if (state.retirePartner) {
        return { statusCode: 400, body: { errors: [{ message: 'PersistedQueryNotFound' }] } };
      }
      const payload = JSON.parse(body || '{}');
      state.operations.push(payload.operationName);
      if (state.noDataFor === payload.operationName) {
        return { body: { errors: [{ message: 'That playlist has no items Spotify can read' }] } };
      }
      const answer = ANSWERS[payload.operationName];
      return { body: typeof answer === 'function' ? answer(payload.variables || {}) : (answer || { data: {} }) };
    }
    if (url.includes('spclient.wg.spotify.com')) {
      state.partnerCalls += 1;
      if (url.includes('/melody/v1/product_state')) return { body: { catalogue: 'premium', product: 'premium' } };
      if (url.includes('/color-lyrics/')) {
        return {
          body: {
            lyrics: {
              syncType: 'LINE_SYNCED',
              lines: [{ startTimeMs: '0', words: 'first line' }, { startTimeMs: '4200', words: 'second line' }],
            },
          },
        };
      }
      return { body: {} };
    }
    if (url.includes('api.spotify.com')) {
      state.webApiCalls += 1;
      if (state.webApiFails) return { statusCode: 429, body: { error: { status: 429, message: 'too many' } } };
      if (url.includes('/search')) {
        return { body: { tracks: { total: 1, next: null, items: [{ id: 'web00000000000000000000', name: 'Web Song', uri: 'spotify:track:web00000000000000000000', duration_ms: 1000, artists: [{ name: 'Web' }], album: { name: 'W', images: [] } }] } } };
      }
      if (url.includes('/me/tracks')) return { body: { total: 0, next: null, items: [] } };
      if (url.includes('/me/playlists')) return { body: { total: 0, next: null, items: [] } };
      return { body: { id: 'alice', display_name: 'Alice', product: 'premium' } };
    }
    return { statusCode: 404, body: {} };
  };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-spotify-partner-'));
  process.env.SPOTIFY_CONFIG_FILE = path.join(root, '.spotify-credentials.json');
  process.env.SPOTIFY_TOKEN_FILE = path.join(root, '.spotify-token.json');
  process.env.SPOTIFY_CLIENT_ID = '0123456789abcdef0123456789abcdef';
  delete process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.MINERADIO_SPOTIFY_CHANNEL;

  const spotify = require('../server/spotify-api');
  const runtime = spotify._test;

  runtime.resetSpotifyRuntimeStateForTests();
  spotify.saveSpotifyOAuthToken({ access_token: 'partner-access', expires_in: 3600, newAuthorization: true });

  // ── 1. 四步自检全程只碰 pathfinder / spclient，一次 /v1 都不打 ────────────────
  const state = { partnerCalls: 0, webApiCalls: 0, tokenCalls: 0, operations: [], retirePartner: false };
  await withHttpsMock(makeRouter(state), async () => {
    const diagnostics = await spotify.handleSpotifySetupDiagnostics();
    const byId = {};
    (diagnostics.checks || []).forEach((check) => { byId[check.id] = check; });
    assert.strictEqual(diagnostics.ready, true, 'diagnostics must be ready over pathfinder: ' + JSON.stringify(diagnostics.checks));
    assert.strictEqual(byId.profile.ok, true, 'account read must succeed');
    assert.strictEqual(byId.library.ok, true, 'liked songs must be reachable over fetchLibraryTracks');
    assert.strictEqual(byId.playlists.ok, true, 'playlists must be reachable over libraryV3');
    assert.strictEqual(diagnostics.channel, 'pathfinder');
    assert.strictEqual(diagnostics.nickname, 'Alice');
    assert.strictEqual(diagnostics.product, 'premium');
    assert.strictEqual(state.webApiCalls, 0, 'the setup checks must never touch api.spotify.com');
    assert.ok(state.operations.includes('profileAttributes'), 'account must be read with profileAttributes');
    assert.ok(state.operations.includes('libraryV3'), 'playlists must be read with libraryV3');
    assert.ok(state.operations.includes('fetchLibraryTracks'), 'liked songs must be read with fetchLibraryTracks');
  });

  // ── 2. 状态接口读缓存，不拿 /v1/me 当探针 ────────────────────────────────────
  const statusState = { partnerCalls: 0, webApiCalls: 0, tokenCalls: 0, operations: [], retirePartner: false };
  await withHttpsMock(makeRouter(statusState), async () => {
    const first = await spotify.handleSpotifyStatus();
    assert.strictEqual(first.loggedIn, true);
    assert.strictEqual(first.channel, 'pathfinder');
    const used = statusState.partnerCalls;
    for (let round = 0; round < 3; round += 1) {
      const again = await spotify.handleSpotifyStatus();
      assert.strictEqual(again.loggedIn, true);
      assert.strictEqual(again.nickname, 'Alice');
    }
    assert.strictEqual(statusState.partnerCalls, used, 'a warm account cache must mean zero further requests');
    assert.strictEqual(statusState.webApiCalls, 0);
  });

  // ── 3. 歌单列表 + 喜欢卡片 ───────────────────────────────────────────────────
  const playlistState = { partnerCalls: 0, webApiCalls: 0, tokenCalls: 0, operations: [], retirePartner: false };
  await withHttpsMock(makeRouter(playlistState), async () => {
    const page = await spotify.handleSpotifyUserPlaylists({ limit: 20 });
    assert.strictEqual(page.loggedIn, true);
    assert.strictEqual(page.playlists.length, 2, 'liked card plus one playlist');
    assert.strictEqual(page.playlists[0].id, spotify.SPOTIFY_LIKED_PLAYLIST_ID);
    assert.strictEqual(page.playlists[0].trackCount, 2);
    const mix = page.playlists[1];
    assert.strictEqual(mix.id, PLAYLIST);
    assert.strictEqual(mix.name, 'Morning Mix');
    assert.strictEqual(mix.trackCount, 7);
    assert.strictEqual(mix.shelfPane, 'mine', 'a playlist owned by the account belongs in "mine"');
    assert.strictEqual(mix.creator, 'Alice');
    assert.strictEqual(page.userId, 'alice');
    assert.strictEqual(playlistState.webApiCalls, 0, 'library listing must not touch the Web API');
  });

  // ── 4. 歌单内容、喜欢的歌、专辑、搜索 ────────────────────────────────────────
  const catalogState = { partnerCalls: 0, webApiCalls: 0, tokenCalls: 0, operations: [], retirePartner: false };
  await withHttpsMock(makeRouter(catalogState), async () => {
    const playlist = await spotify.handleSpotifyPlaylistTracks(PLAYLIST, { limit: 48, offset: 0 });
    assert.strictEqual(playlist.tracks.length, 1);
    assert.strictEqual(playlist.tracks[0].id, TRACK_B);
    assert.strictEqual(playlist.tracks[0].album, 'Album One');
    assert.strictEqual(playlist.playlist.name, 'Morning Mix');

    const liked = await spotify.handleSpotifyPlaylistTracks(spotify.SPOTIFY_LIKED_PLAYLIST_ID, { limit: 48, offset: 0 });
    assert.strictEqual(liked.tracks.length, 2);
    assert.strictEqual(liked.tracks[0].name, 'Liked One');

    const album = await spotify.handleSpotifyAlbumDetail(ALBUM, { limit: 80 });
    assert.strictEqual(album.album.name, 'Album One');
    assert.strictEqual(album.album.artist, 'Alice Cooper');
    assert.strictEqual(album.songs.length, 1);
    assert.strictEqual(album.songs[0].id, TRACK_C);
    assert.strictEqual(album.songs[0].album, 'Album One', 'album tracks inherit the album they were read from');

    const search = await spotify.handleSpotifySearch('found song', 5, 0);
    assert.strictEqual(search.songs.length, 1);
    assert.strictEqual(search.songs[0].id, TRACK_D);
    assert.strictEqual(search.songs[0].albumId, ALBUM);

    assert.strictEqual(catalogState.webApiCalls, 0, 'catalog reads must stay on pathfinder');
  });

  // ── 5. 收藏写入：pathfinder 的 change，不看 /v1 的 scope ─────────────────────
  const writeState = { partnerCalls: 0, webApiCalls: 0, tokenCalls: 0, operations: [], retirePartner: false };
  await withHttpsMock(makeRouter(writeState), async () => {
    const saved = await spotify.handleSpotifyLibrarySet('track', TRACK_A, true);
    assert.strictEqual(saved.success, true);
    assert.strictEqual(saved.saved, true);
    assert.ok(writeState.operations.includes('addToLibrary'), 'saving a song must use the addToLibrary change');
    const removed = await spotify.handleSpotifyLibrarySet('track', TRACK_A, false);
    assert.strictEqual(removed.saved, false);
    assert.ok(writeState.operations.includes('removeFromLibrary'));
    assert.strictEqual(writeState.webApiCalls, 0, 'library writes must not touch the Web API');
  });

  // ── 6. 歌词来自 spclient 的 color-lyrics ───────────────────────────────────
  const lyricState = { partnerCalls: 0, webApiCalls: 0, tokenCalls: 0, operations: [], retirePartner: false };
  await withHttpsMock(makeRouter(lyricState), async () => {
    const lyric = await spotify.handleSpotifyLyric(TRACK_A);
    assert.strictEqual(lyric.source, 'spotify');
    assert.match(lyric.lyric, /^\[00:00\.00\]first line/m);
    assert.match(lyric.lyric, /\[00:04\.20\]second line/);
  });

  // ── 7. 某条查询"没有数据"不等于哈希失效：通道不能被整体关掉 ────────────────
  runtime.resetSpotifyRuntimeStateForTests();
  spotify.saveSpotifyOAuthToken({ access_token: 'partner-access', expires_in: 3600, newAuthorization: true });
  const emptyState = { partnerCalls: 0, webApiCalls: 0, tokenCalls: 0, operations: [], retirePartner: false, noDataFor: 'libraryV3' };
  await withHttpsMock(makeRouter(emptyState), async () => {
    const page = await spotify.handleSpotifyUserPlaylists({ limit: 10 });
    assert.strictEqual(page.playlists.length, 1, 'a failed playlist page still returns the liked card');
    assert.strictEqual(runtime.spotifyPartnerUsable(), true, 'an empty answer must not disable the channel');
  });

  // ── 8. 哈希被 Spotify 换掉时自动降级到 Web API，并且不再每题都撞 400 ────────
  runtime.resetSpotifyRuntimeStateForTests();
  spotify.saveSpotifyOAuthToken({ access_token: 'partner-access', expires_in: 3600, newAuthorization: true });
  const retiredState = { partnerCalls: 0, webApiCalls: 0, tokenCalls: 0, operations: [], retirePartner: true };
  await withHttpsMock(makeRouter(retiredState), async () => {
    const search = await spotify.handleSpotifySearch('anything', 5, 0);
    assert.strictEqual(search.songs.length, 1, 'a retired persisted query must fall back to /v1/search');
    assert.strictEqual(search.songs[0].id, 'web00000000000000000000');
    assert.strictEqual(runtime.spotifyPartnerUsable(), false, 'a retired hash disables the partner channel for a while');
    const partnerCallsAfterRetire = retiredState.partnerCalls;
    const again = await spotify.handleSpotifySearch('anything else', 5, 0);
    assert.strictEqual(again.songs.length, 1);
    assert.strictEqual(retiredState.partnerCalls, partnerCallsAfterRetire, 'the disabled channel must not be tried again');
  });

  runtime.resetSpotifyRuntimeStateForTests();
  console.log('[OK] Spotify pathfinder channel reads accounts, library, playlists, albums, search and lyrics without the Web API, and falls back when a query is retired.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
