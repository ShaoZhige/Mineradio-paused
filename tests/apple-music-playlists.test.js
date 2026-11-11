'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleAppleMusicPlaylists,
  handleAppleMusicPlaylistTracks,
  mapAppleMusicPlaylist,
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

test('playlist tracks forward the id and map songs', async () => {
  const calls = [];
  const result = await handleAppleMusicPlaylistTracks(async (operation, params) => {
    calls.push({ operation, params });
    return { ok: true, data: { items: [track()], hasMore: false, nextOffset: 1 } };
  }, 'p.abc123', 25, 0);
  assert.deepEqual(calls, [{ operation: 'playlistTracks', params: { playlistId: 'p.abc123', limit: 25, offset: 0 } }]);
  assert.equal(result.songs.length, 1);
  assert.equal(result.songs[0].provider, 'applemusic');
  assert.equal(result.songs[0].name, '晴天');
  assert.equal(result.songs[0].externalPlayback, true);
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
