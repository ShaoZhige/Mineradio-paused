const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BuiltInPlaylistLibrary } = require('../desktop/built-in-playlist-library');

test('built-in playlists persist mixed-provider songs without changing their source', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-built-in-playlists-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = new BuiltInPlaylistLibrary({ userDataPath: root });

  const created = await library.create('跨平台收藏');
  const id = created.playlist.id;
  assert.match(id, /^[a-f0-9]{24}$/);

  await library.addTrack(id, { provider: 'netease', id: 1001, name: '网易云歌曲', artist: 'A', cover: 'https://example.com/ne.jpg' });
  await library.addTrack(id, { provider: 'qq', id: 'qq-1', mid: '003QQMID', mediaMid: '004MEDIA', name: 'QQ 歌曲', artist: 'B' });
  await library.addTrack(id, { provider: 'kugou', id: 'kg-1', hash: 'ABCDEF', albumAudioId: '900', name: '酷狗歌曲', artist: 'C' });
  await library.addTrack(id, { provider: 'qishui', id: 'qs-1', providerSongId: 'qs-1', name: '汽水歌曲', artist: 'D' });
  await library.addTrack(id, { provider: 'local', id: 'local:0123456789abcdef01234567', localFileId: '0123456789abcdef01234567', localKey: '0123456789abcdef01234567', localUrl: 'mineradio-local://audio/0123456789abcdef01234567?cap=test', name: '本地歌曲', artist: 'E' });

  const duplicate = await library.addTrack(id, { provider: 'qq', mid: '003QQMID', name: '同一首 QQ 歌曲', artist: 'B' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.playlist.trackCount, 5);

  const firstPage = library.page(id, { offset: 0, limit: 3 });
  assert.deepEqual(firstPage.tracks.map((track) => track.provider), ['netease', 'qq', 'kugou']);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.total, 5);
  assert.equal(firstPage.tracks[1].mid, '003QQMID');
  assert.equal(firstPage.tracks[2].hash, 'ABCDEF');

  const restored = new BuiltInPlaylistLibrary({ userDataPath: root });
  const restoredPage = restored.page(id, { offset: 3, limit: 10 });
  assert.deepEqual(restoredPage.tracks.map((track) => track.provider), ['qishui', 'local']);
  assert.equal(restored.listSync().playlists[0].cover, 'https://example.com/ne.jpg');

  await restored.rename(id, '常听合集');
  await restored.reorderTrack(id, 4, 0);
  assert.equal(restored.page(id, { limit: 1 }).tracks[0].provider, 'local');
  await restored.removeTrack(id, 0);
  assert.equal(restored.page(id, { limit: 20 }).total, 4);

  const spotifyAdded = await restored.addTrack(id, {
    provider: 'spotify',
    spotifyId: '1a2b3c4d',
    id: '1a2b3c4d',
    providerSongId: '1a2b3c4d',
    name: 'Spotify 歌曲',
    artist: 'F',
    restriction: { action: 'switch_source', reason: 'spotify_metadata_only', category: 'provider_limited' },
  });
  assert.equal(spotifyAdded.ok, true);
  const spotifyPage = restored.page(id, { offset: 0, limit: 20 });
  assert.equal(spotifyPage.total, 5);
  assert.ok(spotifyPage.tracks.some((t) => t.provider === 'spotify' && t.spotifyId === '1a2b3c4d'));
  await restored.delete(id);
  assert.equal(restored.listSync().count, 0);
});

test('bulk addTracks appends a whole batch in a single write and reports what it skipped', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-built-in-playlists-bulk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = new BuiltInPlaylistLibrary({ userDataPath: root });
  const created = await library.create('批量收藏');
  const id = created.playlist.id;
  await library.addTrack(id, { provider: 'netease', id: 1001, name: '已有' });

  // 落盘次数必须与批量大小无关：每次 persist 都是一次全量重写（临时文件 + rename），
  // 所以「批量加入」若退化成循环调用 addTrack，二十首歌就会重写二十次索引。
  // The write count must not depend on the batch size: every persist rewrites the whole index
  // (temp file + rename), so a bulk add that looped over addTrack would rewrite it once per song.
  let writes = 0;
  const persist = library.persist.bind(library);
  library.persist = async (playlists) => { writes += 1; return persist(playlists); };

  const result = await library.addTracks(id, [
    { provider: 'netease', id: 1001, name: '已有（重复）' },
    { provider: 'qq', id: 'qq-1', mid: '003QQMID', name: '甲' },
    { provider: 'kugou', id: 'kg-1', hash: 'ABCDEF', name: '乙' },
    { provider: 'qq', id: 'qq-1', mid: '003QQMID', name: '甲（同批内重复）' },
    null,
    { name: '没有来源标识' },
  ]);

  assert.equal(writes, 1);
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.equal(result.duplicate, 2);
  assert.equal(result.invalid, 2);
  assert.equal(result.overflow, 0);
  assert.equal(result.playlist.trackCount, 3);
  const page = library.page(id, { limit: 20 });
  assert.deepEqual(page.tracks.map((track) => track.name), ['已有', '甲', '乙']);
  // 歌单不存在时不能静默成功：批量入口与单曲入口要给出同一个错误码。
  await assert.rejects(() => library.addTracks('0123456789abcdef01234567', [{ provider: 'qq', mid: 'M', name: '丙' }]),
    (error) => error.code === 'BUILT_IN_PLAYLIST_NOT_FOUND');
  // 空批（连一首能入库的都没有）不落盘。
  writes = 0;
  const empty = await library.addTracks(id, [{ name: '还是没有来源标识' }]);
  assert.equal(writes, 0);
  assert.equal(empty.added, 0);
  assert.equal(empty.invalid, 1);
  assert.equal(empty.playlist, null);
});

test('Electron and renderer wiring exposes built-in playlists in collection, panel, queue and shelf', () => {
  const appRoot = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const loader = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const builtInRenderer = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-built-in-playlists.js'), 'utf8');
  const panel = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const loaders = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');
  const collect = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js'), 'utf8');
  const shelf = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const shelfContent = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '03-content-list-manager.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');

  assert.match(main, /new BuiltInPlaylistLibrary\(\{ userDataPath: STABLE_USER_DATA_PATH \}\)/);
  assert.match(main, /mineradio-built-in-playlist-add-track/);
  assert.match(main, /mineradio-built-in-playlist-add-tracks/);
  assert.match(preload, /listBuiltInPlaylists/);
  assert.match(preload, /addBuiltInPlaylistTrack/);
  assert.match(preload, /addBuiltInPlaylistTracks/);
  assert.match(loader, /06-lyrics\/00-built-in-playlists\.js/);
  assert.match(builtInRenderer, /function addTrackToBuiltInPlaylist/);
  assert.match(builtInRenderer, /function addTracksToBuiltInPlaylist/);
  assert.match(panel, /pl_builtin/);
  assert.match(panel, /fetchPlaylistTracksPage/);
  assert.match(loaders, /mineradio:/);
  // 「可混合全部平台」提示已按取词键接入（track_count_mixable_html），源码不再内联中文。
  // The "mixable across all platforms" hint is now keyed (track_count_mixable_html).
  assert.match(collect, /track_count_mixable_html/);
  assert.doesNotMatch(collect, /function openCollectModal\(song\)[\s\S]{0,240}ensureLoggedInForAction/);
  assert.match(shelf, /provider === 'mineradio'/);
  assert.match(shelfContent, /builtInPlaylistTracksPage/);
  assert.match(indexHtml, /id="login-provider-spotify"/);
});
