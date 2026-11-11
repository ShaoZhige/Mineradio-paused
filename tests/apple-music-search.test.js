'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleAppleMusicSearch, mapAppleMusicSong } = require('../server/apple-music-api');

function item(overrides) {
  return {
    id: '123',
    type: 'songs',
    attributes: {
      name: '夜曲',
      artistName: '周杰伦',
      albumName: '十一月的萧邦',
      durationInMillis: 227000,
      artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg' },
      playParams: { id: '123', kind: 'song', catalogId: '123' },
      catalogAlbums: [{ id: 'album-1', name: '十一月的萧邦' }],
      catalogArtists: [{ id: 'artist-1', name: '周杰伦' }],
      ...overrides,
    },
  };
}

test('maps an Apple Music song into the Mineradio SongResult shape', () => {
  const song = mapAppleMusicSong(item(), 0, '夜曲');
  assert.equal(song.provider, 'applemusic');
  assert.equal(song.id, '123');
  assert.equal(song.name, '夜曲');
  assert.equal(song.artist, '周杰伦');
  assert.equal(song.album, '十一月的萧邦');
  assert.equal(song.cover, 'https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg');
  assert.equal(song.duration, 227);
  assert.equal(song.playable, true);
  assert.equal(song.externalPlayback, true);
  assert.equal(song.playbackMode, 'external');
  assert.equal(song.companionOperation, 'playSong');
});

test('search forwards query/limit/offset and normalizes the page', async () => {
  const calls = [];
  const result = await handleAppleMusicSearch(async (operation, params) => {
    calls.push({ operation, params });
    return {
      ok: true,
      data: {
        items: [item(), item({ name: '' }), item({ name: '夜曲' })],
        hasMore: true,
        nextOffset: 2,
      },
    };
  }, '  夜曲  ', 2, 4);
  assert.deepEqual(calls, [{ operation: 'search', params: { query: '夜曲', limit: 2, offset: 4 } }]);
  assert.equal(result.provider, 'applemusic');
  assert.equal(result.songs.length, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.offset, 4);
});

test('search reports an auth-required companion failure without throwing', async () => {
  const result = await handleAppleMusicSearch(async () => ({ ok: false, error: 'auth-required' }), '夜曲', 8, 0);
  assert.equal(result.provider, 'applemusic');
  assert.equal(result.songs.length, 0);
  assert.equal(result.error, 'auth-required');
  assert.match(result.message, /登录/);
});

test('missing companion is a runtime-unavailable result, not a crash', async () => {
  const result = await handleAppleMusicSearch(null, '夜曲', 8, 0);
  assert.equal(result.configured, false);
  assert.equal(result.error, 'APPLE_MUSIC_RUNTIME_UNAVAILABLE');
  assert.deepEqual(result.songs, []);
});
