const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LocalMusicLibrary,
  coverWithinBudget,
  decodeLyricBuffer,
  embeddedLyricText,
  localFileId,
} = require('../desktop/local-music-library');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function blockHeader(type, length, last) {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0) | type;
  header.writeUIntBE(length, 1, 3);
  return header;
}

function vorbisCommentBlock(comments) {
  const vendor = Buffer.from('Mineradio test', 'utf8');
  const parts = [];
  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendor.length);
  parts.push(vendorLength, vendor);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length);
  parts.push(count);
  for (const comment of comments) {
    const value = Buffer.from(comment, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(value.length);
    parts.push(length, value);
  }
  return Buffer.concat(parts);
}

function pictureBlock(data) {
  const mime = Buffer.from('image/png', 'ascii');
  const description = Buffer.from('front cover', 'utf8');
  const fields = [];
  function uint32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value);
    fields.push(buffer);
  }
  uint32(3);
  uint32(mime.length);
  fields.push(mime);
  uint32(description.length);
  fields.push(description);
  uint32(1);
  uint32(1);
  uint32(32);
  uint32(0);
  uint32(data.length);
  fields.push(data);
  return Buffer.concat(fields);
}

function minimalTaggedFlac() {
  const streamInfo = Buffer.alloc(34);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  const packed = (BigInt(44100) << 44n) | (15n << 36n) | 44100n;
  streamInfo.writeBigUInt64BE(packed, 10);
  const comments = vorbisCommentBlock([
    'TITLE=标签标题',
    'ARTIST=标签歌手',
    'ALBUM=标签专辑',
  ]);
  const picture = pictureBlock(ONE_PIXEL_PNG);
  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    blockHeader(0, streamInfo.length, false),
    streamInfo,
    blockHeader(4, comments.length, false),
    comments,
    blockHeader(6, picture.length, true),
    picture,
  ]);
}

test('FLAC tags, embedded cover and same-name LRC survive a full library reload', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const albumDirectory = path.join(root, 'music', 'Album');
  fs.mkdirSync(albumDirectory, { recursive: true });
  const audioPath = path.join(albumDirectory, 'Song.flac');
  const lyricPath = path.join(albumDirectory, 'Song.lrc');
  fs.writeFileSync(audioPath, minimalTaggedFlac());
  fs.writeFileSync(lyricPath, '\ufeff[00:01.000]第一句\n[00:02.500]第二句', 'utf8');

  const library = new LocalMusicLibrary({ userDataPath: path.join(root, 'profile') });
  const imported = await library.importFiles([{
    path: audioPath,
    relativePath: 'Album/Song.flac',
  }]);

  assert.equal(imported.ok, true);
  assert.equal(imported.count, 1);
  assert.equal(imported.tracks[0].name, '标签标题');
  assert.equal(imported.tracks[0].artist, '标签歌手');
  assert.equal(imported.tracks[0].album, '标签专辑');
  assert.match(imported.tracks[0].cover, /^mineradio-local:\/\/cover\/[a-f0-9]{24}/);
  assert.match(imported.tracks[0].localUrl, /^mineradio-local:\/\/audio\/[a-f0-9]{24}/);
  assert.equal(imported.tracks[0].hasLyric, true);
  assert.equal(imported.tracks[0].lyricSource, 'sidecar');
  assert.equal(Object.hasOwn(imported.tracks[0], 'lyric'), false);
  assert.match(library.lyricForTrack(imported.tracks[0].localFileId).lyric, /\[00:02\.500\]第二句/);

  const restored = new LocalMusicLibrary({
    userDataPath: path.join(root, 'profile'),
    parseMetadata: async () => { throw new Error('reload must use the persisted manifest'); },
  }).listTracksSync();
  assert.equal(restored.ok, true);
  assert.equal(restored.count, 1);
  assert.deepEqual(restored.tracks[0], imported.tracks[0]);

  const audioResponse = await library.mediaResponse(new Request(restored.tracks[0].localUrl, {
    headers: { Range: 'bytes=4-11', Origin: 'http://127.0.0.1:31381' },
  }));
  assert.equal(audioResponse.status, 206);
  assert.equal(audioResponse.headers.get('content-type'), 'audio/flac');
  assert.equal(audioResponse.headers.get('access-control-allow-origin'), 'http://127.0.0.1:31381');
  assert.equal(Buffer.from(await audioResponse.arrayBuffer()).length, 8);

  const coverResponse = await library.mediaResponse(new Request(restored.tracks[0].cover));
  assert.equal(coverResponse.status, 200);
  assert.equal(coverResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await coverResponse.arrayBuffer()), ONE_PIXEL_PNG);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'local-music-library.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.match(manifest.mediaToken, /^[a-f0-9]{48}$/);
  assert.equal(manifest.records[0].id, localFileId(audioPath));
  assert.equal(manifest.records[0].audioPath, audioPath);

  const unauthorizedUrl = new URL(restored.tracks[0].localUrl);
  unauthorizedUrl.searchParams.delete('cap');
  const unauthorizedResponse = await library.mediaResponse(new Request(unauthorizedUrl));
  assert.equal(unauthorizedResponse.status, 404);
});

test('subsequent imports append to the persistent library by default', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-library-append-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'First.flac');
  const second = path.join(root, 'Second.flac');
  fs.writeFileSync(first, Buffer.from('first'));
  fs.writeFileSync(second, Buffer.from('second'));
  const library = new LocalMusicLibrary({
    userDataPath: path.join(root, 'profile'),
    parseMetadata: async (filePath) => ({
      common: { title: path.basename(filePath, '.flac'), artist: 'Local Artist' },
      format: { duration: 1 },
    }),
  });
  assert.equal((await library.importFiles([{ path: first }])).count, 1);
  const appended = await library.importFiles([{ path: second }]);
  assert.equal(appended.count, 2);
  assert.deepEqual(appended.tracks.map((track) => track.name), ['First', 'Second']);
  assert.equal((await library.importFiles([{ path: '\\\\server\\share\\Blocked.flac' }])).error, 'NO_SUPPORTED_LOCAL_AUDIO');
});

test('GB18030 sidecar lyrics and synchronized embedded lyrics normalize to readable LRC', () => {
  const gb18030 = Buffer.concat([
    Buffer.from('[00:01.00]', 'ascii'),
    Buffer.from([0xca, 0xc0, 0xbd, 0xe7, 0xba, 0xcd, 0xc6, 0xbd]),
  ]);
  assert.equal(decodeLyricBuffer(gb18030), '[00:01.00]世界和平');
  assert.equal(embeddedLyricText({
    lyrics: [{
      syncText: [
        { timestamp: 1250, text: '第一句' },
        { timestamp: 62500, text: '第二句' },
      ],
    }],
  }), '[00:01.250]第一句\n[01:02.500]第二句');
});

test('metadata and manifest failures preserve the last committed cover and index', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-library-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const audioPath = path.join(root, 'Song.flac');
  fs.writeFileSync(audioPath, Buffer.from('audio'));
  const profile = path.join(root, 'profile');
  const library = new LocalMusicLibrary({
    userDataPath: profile,
    parseMetadata: async () => ({
      common: { title: 'Committed', picture: [{ format: 'image/png', data: ONE_PIXEL_PNG }] },
      format: { duration: 1 },
    }),
  });
  const committed = await library.importFiles([{ path: audioPath }]);
  const coverUrl = committed.tracks[0].cover;
  const committedRecord = library.records.get(committed.tracks[0].localFileId);
  const oldCoverPath = committedRecord.coverPath;
  const oldCover = fs.readFileSync(oldCoverPath);

  library.parseMetadata = async () => { throw new Error('metadata unavailable'); };
  const metadataFallback = await library.importFiles([{ path: audioPath }]);
  assert.equal(metadataFallback.tracks[0].cover, coverUrl);
  assert.equal(fs.existsSync(oldCoverPath), true);
  assert.deepEqual(fs.readFileSync(oldCoverPath), oldCover);
  const committedManifest = fs.readFileSync(path.join(profile, 'local-music-library.json'), 'utf8');

  const secondPng = Buffer.from(ONE_PIXEL_PNG);
  secondPng[secondPng.length - 1] ^= 1;
  library.parseMetadata = async () => ({
    common: { title: 'Uncommitted', picture: [{ format: 'image/png', data: secondPng }] },
    format: { duration: 2 },
  });
  library.stageSnapshot = async () => {
    const error = new Error('disk full');
    error.code = 'ENOSPC';
    throw error;
  };
  await assert.rejects(() => library.importFiles([{ path: audioPath }]), /disk full/);
  assert.equal(fs.existsSync(oldCoverPath), true);
  assert.deepEqual(fs.readFileSync(oldCoverPath), oldCover);
  assert.equal(fs.readFileSync(path.join(profile, 'local-music-library.json'), 'utf8'), committedManifest);
  assert.equal(library.records.get(committed.tracks[0].localFileId).coverPath, oldCoverPath);
  assert.equal(fs.readdirSync(path.dirname(oldCoverPath)).some((name) => name.endsWith('.stage')), false);
});

test('embedded cover budget rejects oversized pixel dimensions on low-spec devices', () => {
  const oversizedPng = Buffer.from(ONE_PIXEL_PNG);
  oversizedPng.writeUInt32BE(5000, 16);
  oversizedPng.writeUInt32BE(5000, 20);
  assert.equal(coverWithinBudget(ONE_PIXEL_PNG, 'image/png'), true);
  assert.equal(coverWithinBudget(oversizedPng, 'image/png'), false);
  assert.equal(coverWithinBudget(Buffer.alloc(1024 * 1024 + 1), 'image/webp'), false);
});

test('orphan records stay in the index but never reach the playable list', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-library-orphan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const audioPath = path.join(root, 'Song.flac');
  fs.writeFileSync(audioPath, Buffer.from('audio'));
  const profile = path.join(root, 'profile');
  const library = new LocalMusicLibrary({
    userDataPath: profile,
    parseMetadata: async () => ({ common: { title: 'Song' }, format: { duration: 1 } }),
  });

  const imported = await library.importFiles([{ path: audioPath }]);
  assert.equal(imported.count, 1);
  assert.equal(imported.missing, 0);
  assert.equal(imported.tracks[0].localMissing, false);
  const trackId = imported.tracks[0].localFileId;

  fs.rmSync(audioPath);
  const afterRemoval = library.listTracksSync();
  assert.equal(afterRemoval.ok, true);
  assert.equal(afterRemoval.count, 0);
  assert.equal(afterRemoval.missing, 1);
  assert.deepEqual(afterRemoval.tracks, []);

  // The index must keep the record: a detached drive is temporary, pruning would be data loss.
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'local-music-library.json'), 'utf8'));
  assert.equal(manifest.records.length, 1);
  assert.equal(manifest.records[0].audioPath, audioPath);

  // Single-track resolution keeps the entry but withholds a URL that could only 404.
  const orphan = library.resolveTrack(trackId);
  assert.equal(orphan.localKey, trackId);
  assert.equal(orphan.localMissing, true);
  assert.equal(orphan.localUrl, '');
  assert.equal(orphan.cover, '');
  assert.equal(library.resolveTrack('local:' + trackId).localMissing, true);
  assert.equal(library.resolveTrack('not-an-id'), null);

  // Reconnecting the drive restores the entries without any manual cleanup.
  fs.writeFileSync(audioPath, Buffer.from('audio'));
  const restored = await library.listTracks();
  assert.equal(restored.count, 1);
  assert.equal(restored.missing, 0);
  assert.equal(restored.tracks[0].localMissing, false);
  assert.match(restored.tracks[0].localUrl, /^mineradio-local:\/\/audio\/[a-f0-9]{24}/);
});

test('renderer and Electron wiring restore persistent tracks instead of blob-only missing records', () => {
  const appRoot = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const localLibrary = fs.readFileSync(path.join(appRoot, 'desktop', 'local-music-library.js'), 'utf8');
  const preload = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const upload = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '05-upload-dragdrop.js'), 'utf8');
  const startup = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '05-startup-bindings.js'), 'utf8');
  const playback = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const playerControls = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const coreState = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const homeLocal = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '04-home-empty-wallpaper.js'), 'utf8');
  const cover = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '05-cover-loading-crop.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));

  // 断言意图而不是字面形状：曲库必须用稳定用户目录构造，但现在还多带一个监视回调，
  // 把整个对象字面量钉死会让任何无害的增项都变成红灯。
  // Assert the intent, not the literal shape: the library must be built on the stable user data
  // path, but it now also carries a watch callback, and pinning the whole object literal would turn
  // any harmless addition into a red light.
  assert.match(main, /new LocalMusicLibrary\(\{[\s\S]{0,240}?userDataPath: STABLE_USER_DATA_PATH/);
  // 文件夹监视的接线必须完整：构造时给回调、导入后开启、退出前关闭，缺一环都会漏。
  // The folder watch wiring must be complete — a change callback, a start after import and a stop
  // before quit. A missing leg leaks either notifications or file handles.
  assert.match(main, /onWatchChange: \(change\) =>/);
  assert.match(main, /localMusicLibrary\.startWatching\(\)/);
  assert.match(main, /localMusicLibrary\.stopWatching\(\)/);
  assert.match(main, /mineradio-local-library-changed/);
  assert.match(preload, /onLocalMusicLibraryChanged/);
  assert.match(upload, /bindPersistentLocalLibraryWatch/);
  assert.match(upload, /refreshPersistentLocalLibraryTracks/);
  assert.match(startup, /bindPersistentLocalLibraryWatch/);
  assert.doesNotMatch(main, /mineradio-local-library-read-sync/);
  assert.match(main, /await localMusicLibrary\.listTracks\(\)/);
  assert.match(main, /mineradio-local-library-lyric/);
  assert.match(main, /mineradio-local-library-authorize/);
  assert.match(main, /localMusicImportCapabilities/);
  assert.match(main, /LOCAL_IMPORT_CAPABILITY_INVALID/);
  assert.doesNotMatch(main, /localMusicLibrary\.importFiles\(payload && payload\.files/);
  assert.match(main, /localMusicLibrary\.installProtocol\(protocol\)/);
  assert.match(preload, /webUtils\.getPathForFile/);
  assert.doesNotMatch(preload, /readLocalMusicLibrarySync/);
  assert.match(preload, /listLocalMusicLibrary/);
  assert.match(preload, /readLocalMusicLyric/);
  assert.doesNotMatch(preload, /getPathForLocalFile:/);
  assert.doesNotMatch(preload, /mineradio-local-library-remove/);
  assert.match(upload, /importPersistentLocalAudioFiles/);
  assert.match(upload, /copy\.localMissing = false/);
  assert.match(upload, /persistentLocalLibraryTracks = tracks\.map\(cloneSong\)/);
  assert.match(upload, /upload_lib_save_failed/);
  assert.match(coreState, /var persistentLocalLibraryTracks = \[\]/);
  assert.match(homeLocal, /loadPersistedLocalLibraryIntoQueue/);
  assert.doesNotMatch(playerControls, /forgetPersistentLocalTracks/);
  assert.match(startup, /persistedLocalLibraryRestorePromise/);
  assert.match(startup, /Promise\.all\([\s\S]*persistedLocalLibraryRestorePromise/);
  assert.match(upload, /async function restorePersistedLocalLibrary/);
  assert.match(upload, /return -1;/);
  assert.match(playback, /readLocalMusicLyric\(song\.localFileId\)/);
  assert.match(cover, /mineradio-local:\\\/\\\/cover/);
  assert.match(localLibrary, /function localRecordFileExists\(record\)/, 'orphan detection must stat the record file');
  assert.match(localLibrary, /if \(!fileExists\) \{ missing \+= 1; continue; \}/, 'records with a missing file must be filtered out of the list');
  assert.match(localLibrary, /localUrl: available \? localMediaUrl\('audio'/, 'orphan records must not expose a URL that can only 404');
  const loadIndexBlock = localLibrary.slice(
    localLibrary.indexOf('  loadIndex() {'),
    localLibrary.indexOf('  serializeRecord(record, fileExists) {')
  );
  assert.doesNotMatch(loadIndexBlock, /localRecordFileExists/, 'a detached drive must never be pruned at load time');
  assert.match(main, /resolveBuiltInPlaylistLocalTracks\(builtInPlaylistLibrary\.page\(id, options\)\)/, 'built-in playlist pages must re-resolve local tracks against the live library');
  assert.match(main, /localMusicLibrary\.resolveTrack\(track\.localFileId \|\| track\.localKey \|\| track\.id\)/, 'the re-resolution must look the track up by local id');
  assert.match(upload, /Number\(result\.missing\) > 0/, 'the renderer must surface how many local tracks were skipped');
  assert.equal(packageJson.dependencies['music-metadata'], '11.14.0');
});
