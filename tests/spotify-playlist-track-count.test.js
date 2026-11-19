'use strict';

// Spotify 歌单卡片上的「N 首」。曲目页（fetchPlaylist）与库列表（libraryV3）来自两条不同的
// 持久化查询：前者带 content.totalCount，后者来自网页端"资料库"那页，那页本来就不显示曲目数。
// 于是会出现"点开有歌、卡片写 0 首"。这里锁住三层保底：
//   1. playlistCard 认得多个可能的字段位置；
//   2. 整页都是 0 时用一次 Web API 补齐（按 id 贴，不按顺序）；
//   3. 渲染侧拿曲目页回来的真实总数纠正目录里的那一行。
// The card's track count can arrive from several places, or not at all. These tests pin all three
// layers: tolerant parsing, one-shot Web API fill, and the renderer correcting the catalog row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { createSpotifyPartner } = require('../server/spotify-partner');
const { extractFunction } = require('./helpers/module-source');

const PLAYLIST_ID = '4444444444444444444444';

function playlistPayload(extra) {
  return {
    data: {
      me: {
        libraryV3: {
          totalCount: 1,
          items: [{
            item: {
              data: Object.assign({
                __typename: 'Playlist',
                uri: 'spotify:playlist:' + PLAYLIST_ID,
                name: 'Morning Mix',
                images: { items: [] },
                ownerV2: { data: { name: 'Alice', username: 'alice' } },
                currentUserCapabilities: { canEditItems: true },
              }, extra || {}),
            },
          }],
        },
      },
    },
  };
}

function partnerFor(payload) {
  return createSpotifyPartner({
    requestJson: async () => payload,
    getAccessToken: async () => 'token',
  });
}

test('库列表的歌单卡片认得 tracksV2 / content / 顶层 totalCount', async () => {
  const viaTracksV2 = await partnerFor(playlistPayload({ tracksV2: { totalCount: 9 } })).libraryPlaylists(0, 20);
  assert.equal(viaTracksV2.playlists[0].trackCount, 9, 'tracksV2.totalCount 也是曲目数');

  const viaContent = await partnerFor(playlistPayload({ content: { totalCount: 7 } })).libraryPlaylists(0, 20);
  assert.equal(viaContent.playlists[0].trackCount, 7, '歌单页那套 content.totalCount 仍然有效');

  const viaTopLevel = await partnerFor(playlistPayload({ totalCount: 12 })).libraryPlaylists(0, 20);
  assert.equal(viaTopLevel.playlists[0].trackCount, 12);
});

test('查询完全没给曲目数时是 0，而不是 NaN 或 undefined', async () => {
  const page = await partnerFor(playlistPayload({})).libraryPlaylists(0, 20);
  assert.equal(page.playlists[0].trackCount, 0);
  assert.equal(typeof page.playlists[0].trackCount, 'number');
});

test('Web API 的曲目数按 id 贴回卡片，不按顺序', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-sp-count-'));
  process.env.SPOTIFY_CONFIG_FILE = path.join(root, '.spotify-credentials.json');
  process.env.SPOTIFY_TOKEN_FILE = path.join(root, '.spotify-token.json');
  process.env.SPOTIFY_CLIENT_ID = '0123456789abcdef0123456789abcdef';
  delete process.env.SPOTIFY_CLIENT_SECRET;
  const spotify = require('../server/spotify-api');
  const { spotifyPlaylistCountsMissing, applySpotifyPlaylistTrackCounts } = spotify._test;

  const cards = [
    { id: 'a', trackCount: 0 },
    { id: 'b', trackCount: 0 },
    { id: 'c', trackCount: 0 },
  ];
  assert.equal(spotifyPlaylistCountsMissing(cards), true, '整页 0 首才值得补一次');

  const filled = applySpotifyPlaylistTrackCounts(cards, [
    { id: 'b', tracks: { total: 31 } },
    { id: 'a', tracks: { total: 4 } },
  ]);
  assert.equal(filled, 2);
  assert.deepEqual(cards.map(card => card.trackCount), [4, 31, 0], '顺序不同也要按 id 对上');
});

test('已经有一张带数就不补，免得为真空歌单白打一次 Web API', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-sp-count-skip-'));
  process.env.SPOTIFY_CONFIG_FILE = path.join(root, '.spotify-credentials.json');
  process.env.SPOTIFY_TOKEN_FILE = path.join(root, '.spotify-token.json');
  const spotify = require('../server/spotify-api');
  const { spotifyPlaylistCountsMissing, applySpotifyPlaylistTrackCounts } = spotify._test;

  assert.equal(spotifyPlaylistCountsMissing([{ id: 'a', trackCount: 0 }, { id: 'b', trackCount: 5 }]), false);
  assert.equal(spotifyPlaylistCountsMissing([]), false);
  assert.equal(spotifyPlaylistCountsMissing(null), false);
  assert.equal(applySpotifyPlaylistTrackCounts([{ id: 'a', trackCount: 0 }], []), 0, '上游没给就一个都不改');
});

test('曲目页带回真实总数时，目录里的那一行会被纠正', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const sandbox = {
    spotifyPlaylists: [{ id: 'p1', trackCount: 0 }, { id: 'p2', trackCount: 3 }],
    playlistCatalogProviderArray(provider) {
      return provider === 'spotify' ? sandbox.spotifyPlaylists : null;
    },
  };
  vm.runInNewContext(extractFunction(source, 'syncPlaylistCatalogTrackCount') + '\nthis.run = syncPlaylistCatalogTrackCount;', sandbox);

  assert.equal(sandbox.run('spotify', 'p1', 42), true);
  assert.equal(sandbox.spotifyPlaylists[0].trackCount, 42, '0 首被曲目页的真实总数替换');
  assert.equal(sandbox.spotifyPlaylists[1].trackCount, 3, '别的歌单不受影响');
  assert.equal(sandbox.run('spotify', 'p1', 42), false, '已经一致就不算改动');
  assert.equal(sandbox.run('spotify', 'p1', 0), false, '总数是 0 时绝不覆盖已有值');
  assert.equal(sandbox.run('applemusic', 'p1', 42), false, '没有这一平台的目录时安全退出');
});

test('详情页每拉回一页都用它校正一次卡片计数', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  assert.match(source, /var responseTotal = Number\(r && \(r\.total \|\| \(r\.playlist && r\.playlist\.trackCount\)\)\) \|\| 0;/);
  assert.match(source, /syncPlaylistCatalogTrackCount\(provider, pid, responseTotal\)/);
});
