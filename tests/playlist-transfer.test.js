// 歌单文件分享的回归测试：序列化 / 解析 / 跨机器丢弃本地曲目 / 文件名清洗 / IPC 接线。
// Regression tests for playlist file sharing: payload round-trip, cross-machine local-track
// dropping, file-name sanitising and the two IPC handlers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PLAYLIST_TRANSFER_FORMAT,
  buildTransferPayload,
  defaultExportFileName,
  parseTransferPayload,
  readTransferFile,
  sanitizeFileName,
  writeTransferFile,
} = require('../desktop/playlist-transfer');

const ROOT = path.join(__dirname, '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.js'), 'utf8');
const RENDERER_SOURCE = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '06-lyrics', '08-playlist-transfer.js'),
  'utf8',
);
const LANGS = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];

const NETEASE_TRACK = { provider: 'netease', id: 186016, name: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269000 };
const QQ_TRACK = { provider: 'qq', mid: '0039MnYb0qxYhV', name: '稻香', artist: '周杰伦' };
const LOCAL_TRACK = { provider: 'local', localFileId: 'lf_abc', name: '本地文件', artist: '' };

test('导出的清单保留平台字段，并按 identity 去重', () => {
  const built = buildTransferPayload({
    name: '  我的歌单  ',
    tracks: [NETEASE_TRACK, { ...NETEASE_TRACK }, QQ_TRACK],
  });
  assert.strictEqual(built.payload.format, PLAYLIST_TRANSFER_FORMAT);
  assert.strictEqual(built.payload.version, 1);
  assert.strictEqual(built.payload.name, '我的歌单');
  assert.strictEqual(built.total, 2, 'the duplicate netease track must collapse');
  assert.strictEqual(built.skippedDuplicate, 1);
  // provider + 平台 id 是导入方唯一能还原成可播曲目的依据，必须原样留下。
  // provider + platform id is the only thing that can restore a playable track, so it must survive.
  assert.strictEqual(built.payload.tracks[0].provider, 'netease');
  assert.strictEqual(built.payload.tracks[0].id, 186016);
  assert.strictEqual(built.payload.tracks[1].provider, 'qq');
  assert.strictEqual(built.payload.tracks[1].mid, '0039MnYb0qxYhV');
  assert.strictEqual(built.payload.count, 2);
});

test('没有平台 id 的曲目在导出时被剔除并计数', () => {
  const built = buildTransferPayload({
    name: 'x',
    tracks: [{ name: '没有 id 的歌', artist: '谁' }, NETEASE_TRACK],
  });
  assert.strictEqual(built.total, 1);
  assert.strictEqual(built.skippedInvalid, 1);
});

test('导入时丢弃本地曲目：它们绑的是导出方的曲库', () => {
  const parsed = parseTransferPayload(JSON.stringify({
    format: PLAYLIST_TRANSFER_FORMAT,
    version: 1,
    name: '分享来的',
    tracks: [NETEASE_TRACK, LOCAL_TRACK, QQ_TRACK],
  }));
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.total, 2);
  assert.strictEqual(parsed.skippedLocal, 1);
  assert.ok(parsed.tracks.every((track) => track.provider !== 'local'));
});

test('坏文件与外来 JSON 都必须报错，不能静默当成空歌单', () => {
  assert.strictEqual(parseTransferPayload('not json').ok, false);
  assert.strictEqual(parseTransferPayload('null').error, 'PLAYLIST_TRANSFER_INVALID_JSON');
  assert.strictEqual(parseTransferPayload('[1,2,3]').error, 'PLAYLIST_TRANSFER_INVALID_JSON');
  const foreign = parseTransferPayload(JSON.stringify({ format: 'some-other-app', tracks: [] }));
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(foreign.error, 'PLAYLIST_TRANSFER_FOREIGN_FORMAT');
  const noTracks = parseTransferPayload(JSON.stringify({ format: PLAYLIST_TRANSFER_FORMAT, name: 'x' }));
  assert.strictEqual(noTracks.ok, false);
  assert.strictEqual(noTracks.error, 'PLAYLIST_TRANSFER_NO_TRACKS');
});

test('手写的极简文件（只有 name + tracks）也能导入', () => {
  const parsed = parseTransferPayload(JSON.stringify({ name: '手写的', tracks: [NETEASE_TRACK] }));
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.name, '手写的');
  assert.strictEqual(parsed.total, 1);
});

test('导出文件名要能落在 Windows 上', () => {
  assert.strictEqual(defaultExportFileName('a/b:c*?"<>|d'), 'a b c d.mineradio.json');
  // Windows 会悄悄吃掉结尾的点与空格，文件名必须在写入前就剪干净。
  // Windows silently trims trailing dots and spaces, so they are stripped up front.
  assert.strictEqual(sanitizeFileName('歌单...  '), '歌单');
  assert.strictEqual(defaultExportFileName(''), 'playlist.mineradio.json');
  assert.ok(defaultExportFileName('x'.repeat(200)).length <= 80 + '.mineradio.json'.length);
});

test('读写文件带大小上限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-playlist-'));
  try {
    const file = path.join(dir, 'list.mineradio.json');
    const text = JSON.stringify({ format: PLAYLIST_TRANSFER_FORMAT, version: 1, name: 'a', tracks: [NETEASE_TRACK] }, null, 2);
    writeTransferFile(file, text);
    assert.strictEqual(readTransferFile(file), text);
    assert.throws(() => writeTransferFile(file, 'x'.repeat(9 * 1024 * 1024)), /TOO_LARGE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('两个 IPC 通道都在主进程与 preload 里接好', () => {
  assert.ok(MAIN_SOURCE.includes("ipcMain.handle('mineradio-playlist-export-file'"), 'export handler must exist');
  assert.ok(MAIN_SOURCE.includes("ipcMain.handle('mineradio-playlist-import-file'"), 'import handler must exist');
  assert.ok(PRELOAD_SOURCE.includes("invoke('mineradio-playlist-export-file'"), 'preload must expose export');
  assert.ok(PRELOAD_SOURCE.includes("invoke('mineradio-playlist-import-file'"), 'preload must expose import');
});

test('导入失败不能留下空歌单', () => {
  // 建完歌单再批量加曲目，中间任何一步失败都要把这半个歌单收掉，否则用户会攒出一堆空壳。
  // Create-then-add can fail halfway, and the half-built playlist has to be removed, otherwise
  // the user accumulates empty shells.
  const start = MAIN_SOURCE.indexOf("ipcMain.handle('mineradio-playlist-import-file'");
  assert.ok(start > 0);
  const end = MAIN_SOURCE.indexOf('ipcMain.handle(', start + 10);
  const body = MAIN_SOURCE.slice(start, end > 0 ? end : undefined);
  assert.ok(/listSync|create\(/.test(body), 'the handler must create the playlist in-process');
  const rollbacks = body.match(/builtInPlaylistLibrary\.delete\(createdId\)/g) || [];
  assert.ok(rollbacks.length >= 2, `import must roll back in two places (empty batch + throw), got ${rollbacks.length}`);
  // 文件里没有名字时用文件名兜底，否则导入后会出现一堆同名「导入的歌单」。
  // Falls back to the file name, otherwise every nameless import lands with the same title.
  assert.ok(/const fallbackName = path\.basename\(filePath\)/.test(body), 'the import side derives a name from the file');
});

test('渲染层：导入后要切回「我的歌单」，导出要逐页拉全曲目', () => {
  assert.ok(RENDERER_SOURCE.includes('switchPlaylistTab'), 'import must switch the panel to the playlist tab');
  assert.ok(RENDERER_SOURCE.includes("setPlaylistPanelActiveProvider('mineradio')"), 'and to the built-in provider row');
  assert.ok(/PLAYLIST_TRANSFER_MAX_PAGES/.test(RENDERER_SOURCE), 'paging must be bounded');
  // 平台地址必须与 03-content-list-manager 完全一致，写在两处就必须一起改。
  // The endpoint set has to match 03-content-list-manager exactly.
  ['/api/qq/playlist/tracks', '/api/kugou/playlist/tracks', '/api/qishui/playlist/tracks',
    '/api/spotify/playlist/tracks', '/api/playlist/tracks'].forEach((endpoint) => {
    assert.ok(RENDERER_SOURCE.includes(endpoint), `missing endpoint ${endpoint}`);
  });
  // 虚拟本地曲库不导出：它的 id 换台机器就没有意义。
  const detailSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  assert.ok(/data-pl-detail-export/.test(detailSource), 'the detail row must carry the export button');
  assert.ok(/pl && pl\.virtual/.test(detailSource), 'the virtual local library must not offer export');
  const loader = fs.readFileSync(path.join(ROOT, 'public', 'js', 'index-loader.js'), 'utf8');
  assert.ok(loader.includes('06-lyrics/08-playlist-transfer.js'), 'the module must be registered in modulePaths');
});

test('四个语言都补齐了歌单分享文案', () => {
  const keys = ['pl_export_file', 'pl_import_file', 'pl_export_done', 'pl_export_empty', 'pl_export_failed',
    'pl_import_done', 'pl_import_empty', 'pl_import_all_dup', 'pl_import_failed', 'pl_file_invalid', 'pl_file_too_large'];
  LANGS.forEach((lang) => {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', `${lang}.json`), 'utf8'));
    keys.forEach((key) => assert.ok(dict[key], `${lang}: ${key} must exist`));
  });
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('data-i18n="pl_import_file"'), 'the import button must go through i18n');
  assert.ok(html.includes('onclick="importPlaylistFromFile()"'), 'the import button must call the renderer helper');
});
