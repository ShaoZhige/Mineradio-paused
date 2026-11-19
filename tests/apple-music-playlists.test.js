'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  handleAppleMusicPlaylists,
  handleAppleMusicPlaylistTracks,
  mapAppleMusicPlaylist,
  mapAppleMusicSong,
} = require('../server/apple-music-api');

function playlist(overrides) {
  return {
    id: 'p.abc123',
    type: 'library-playlists',
    attributes: {
      name: '我的最爱',
      artistName: '我',
      trackCount: 12,
      canEdit: true,
      artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg' },
      ...overrides,
    },
  };
}

function track(overrides) {
  return {
    id: '456',
    type: 'library-songs',
    attributes: {
      name: '晴天',
      artistName: '周杰伦',
      albumName: '叶惠美',
      durationInMillis: 269000,
      artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg' },
      playParams: { id: '456', kind: 'song', catalogId: '456' },
      ...overrides,
    },
  };
}

test('maps an Apple Music library playlist into the card shape', () => {
  const row = mapAppleMusicPlaylist(playlist(), 0);
  assert.equal(row.provider, 'applemusic');
  assert.equal(row.source, 'applemusic');
  assert.equal(row.id, 'p.abc123');
  assert.equal(row.name, '我的最爱');
  assert.equal(row.creator, '我');
  assert.equal(row.trackCount, 12);
  assert.equal(row.cover, 'https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg');
});

test('playlists forwards paging and normalizes the page', async () => {
  const calls = [];
  const result = await handleAppleMusicPlaylists(async (operation, params) => {
    calls.push({ operation, params });
    return { ok: true, data: { items: [playlist(), playlist({ name: '' })], hasMore: true, nextOffset: 1 } };
  }, 2, 5);
  assert.deepEqual(calls, [{ operation: 'playlists', params: { limit: 2, offset: 5 } }]);
  assert.equal(result.provider, 'applemusic');
  assert.equal(result.playlists.length, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 1);
});

test('a card with no track count is filled from the one-row counting read', async () => {
  // 库歌单的属性里没有 trackCount，卡片否则一律显示「0 首」。计数接口是单独一次只读一行的请求。
  // Library playlists carry no trackCount attribute, so cards otherwise read "0 首"; the count comes
  // from a separate one-row read.
  const calls = [];
  const result = await handleAppleMusicPlaylists(async (operation, params) => {
    calls.push({ operation, params });
    if (operation === 'playlistTrackCount') return { ok: true, data: { total: 7 } };
    return { ok: true, data: { items: [playlist({ trackCount: undefined })], hasMore: false, nextOffset: 1 } };
  }, 25, 0);
  assert.equal(result.playlists[0].trackCount, 7);
  assert.deepEqual(
    calls.filter(call => call.operation === 'playlistTrackCount').map(call => call.params),
    [{ playlistId: 'p.abc123', limit: 1, offset: 0 }],
    'the count read asks for a single row and must not page'
  );
});

test('a failing count read leaves the card at zero instead of failing the page', async () => {
  const result = await handleAppleMusicPlaylists(async (operation) => {
    if (operation === 'playlistTrackCount') throw new Error('upstream-error');
    return { ok: true, data: { items: [playlist({ trackCount: undefined })], hasMore: false, nextOffset: 1 } };
  }, 25, 0);
  assert.equal(result.playlists.length, 1);
  assert.equal(result.playlists[0].trackCount, 0);
  assert.equal(result.error, undefined);
});

test('playlist tracks use the shared `tracks` envelope and map songs', async () => {
  const calls = [];
  const result = await handleAppleMusicPlaylistTracks(async (operation, params) => {
    calls.push({ operation, params });
    return { ok: true, data: { items: [track()], hasMore: false, nextOffset: 1 } };
  }, 'p.abc123', 25, 0);
  assert.deepEqual(calls, [{ operation: 'playlistTracks', params: { playlistId: 'p.abc123', limit: 25, offset: 0 } }]);
  // 🔴 左栏详情与队列续页读的都是 `tracks`（与其它平台一致）。改成 `songs` 会让歌单点开为空，
  // 卡片却仍有名字和封面 —— 这正是曾经的 bug，所以这条断言同时锁住名字。
  // Both the detail view and the queue hydration read `tracks`, like every other provider.
  // Answering `songs` left opened playlists empty while their cards still looked fine.
  assert.ok(Array.isArray(result.tracks), 'the page must be keyed `tracks`');
  assert.equal(result.songs, undefined, 'the page must not be keyed `songs`');
  assert.equal(result.provider, 'applemusic');
  assert.equal(result.playlist.id, 'p.abc123');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].provider, 'applemusic');
  assert.equal(result.tracks[0].name, '晴天');
  assert.equal(result.tracks[0].externalPlayback, true);
});

test('invalid playlist id never reaches the companion', async () => {
  let called = false;
  const result = await handleAppleMusicPlaylistTracks(async () => {
    called = true;
    return { ok: true, data: { items: [] } };
  }, 'p.abc\n<script>', 25, 0);
  assert.equal(called, false);
  assert.equal(result.error, 'invalid-playlist');
});

test('missing companion reports runtime-unavailable for playlists', async () => {
  const result = await handleAppleMusicPlaylists(null, 25, 0);
  assert.equal(result.configured, false);
  assert.equal(result.error, 'APPLE_MUSIC_RUNTIME_UNAVAILABLE');
  assert.deepEqual(result.playlists, []);
});

// ── 页面侧：曲目请求真的打到 /tracks，并带回可播放的数字 catalog id ──────────────
// Page side: the track request must hit /tracks and come back with a numeric catalog id, or the
// rows would render without being playable (playSong accepts digits only).
const REQUESTS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'apple-music', 'companionRequests.cjs'), 'utf8');

// 库内曲目：id 是 i.* 这种库内资源，可播放的 catalog id 只在 relationships.catalog 里。
// A library song: its own id is a library resource (i.*); the playable numeric id lives only in
// the catalog relationship.
function librarySong() {
  return {
    id: 'i.abc123',
    type: 'library-songs',
    attributes: {
      name: '晴天',
      artistName: '周杰伦',
      albumName: '叶惠美',
      durationInMillis: 269000,
      artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg' },
      playParams: { id: 'i.abc123', kind: 'song', isLibrary: true },
    },
    relationships: { catalog: { data: [{ id: '1234567890', type: 'songs' }] } },
  };
}

function loadPageReader(responder) {
  const start = REQUESTS_SOURCE.indexOf('async function readFromPage');
  const end = REQUESTS_SOURCE.indexOf('// Embed validated JSON only', start);
  assert.ok(start > 0 && end > start, 'readFromPage must be present in companionRequests.cjs');
  const calls = [];
  const noop = async () => ({ ok: true, data: {} });
  const sandbox = {
    window: {
      MusicKit: {
        getInstance: () => ({
          api: {
            v3: {
              music: (requestPath, options) => {
                calls.push({ path: requestPath, options });
                return Promise.resolve(responder(requestPath, options));
              },
            },
          },
        }),
      },
    },
    URL, JSON, Number, String, Array, Object, Promise, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${REQUESTS_SOURCE.slice(start, end)}\nthis.readFromPage = readFromPage;`, sandbox, { filename: 'apple-page-read.js' });
  return {
    calls,
    read: (request) => sandbox.readFromPage(request, noop, noop, noop, noop, noop),
  };
}

test('library playlist tracks must not ask for the catalog relationship', async () => {
  // 读曲目前页面会先确认账号区域（`v1/me/storefront`），所以第一跳不是 /tracks。
  // The page confirms the account region (`v1/me/storefront`) before a library read.
  const page = loadPageReader(requestPath => (
    requestPath === 'v1/me/storefront'
      ? { data: { data: [{ id: 'cn', type: 'storefronts' }] } }
      : { data: { data: [librarySong()] } }
  ));
  const result = await page.read({ id: 'r1', operation: 'playlistTracks', params: { playlistId: 'p.abc123', limit: 25, offset: 0 } });
  const trackCall = page.calls.find(call => call.path.indexOf('/tracks') > 0);
  assert.ok(trackCall, `the track page must be requested: ${JSON.stringify(page.calls.map(call => call.path))}`);
  assert.equal(trackCall.path, 'v1/me/library/playlists/p.abc123/tracks');
  // 🔴 `include: 'catalog'` 让 Apple 为每首歌额外装配目录关系：实测连只有 1 首歌的歌单都要
  // 20.0 秒，正好撞上 20 秒的请求超时，整页于是只剩「加载失败」。库内曲目的 catalogId
  // 本来就随 playParams 下发，所以这里必须保持不带 include。
  // 🔴 `include: 'catalog'` makes Apple assemble the catalog relationship for every row: measured
  // at 20.0 s even for a single-track playlist, exactly the request timeout, so the page only saw a
  // failure. Library tracks already carry catalogId in playParams, so include must stay off.
  assert.equal(trackCall.options.include, undefined, 'include: catalog times the whole request out');
  assert.equal(trackCall.options.limit, 25);
  assert.equal(result.ok, true);
  assert.equal(result.data.items.length, 1);
  const mapped = mapAppleMusicSong(result.data.items[0], 0, '');
  assert.equal(mapped.name, '晴天');
  assert.equal(mapped.catalogId, '1234567890');
  assert.match(mapped.catalogId, /^\d{1,40}$/, 'playSong accepts digits only');
  assert.equal(mapped.album, '叶惠美');
});
