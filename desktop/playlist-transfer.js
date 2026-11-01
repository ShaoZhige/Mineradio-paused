// 歌单文件分享：把一个歌单（任何平台）序列化成可传输的 JSON，再读回来建成内置歌单。
//
// 为什么是文件而不是分享链接：链接分享要么依赖某个平台自己的分享接口（跨平台就没法用），
// 要么得让对方登录同一个账号；文件谁都能接、能自己看内容、也能手改。所以导出的是一份带
// provider + 曲目 id 的清单，导入方按 id 还原 —— 同平台同账号时直接可播，不同平台时至少
// 歌名歌手都在，能靠搜索重新找。
//
// Why a file instead of a share link: a link either depends on one platform's share endpoint
// (useless across providers) or forces the receiver onto the same account. A file travels
// anywhere, stays readable and hand-editable, and carries provider + track ids so the same
// platform can resolve them straight back to playable tracks.
const fs = require('fs');
const { sanitizeTrack } = require('./built-in-playlist-library');

const PLAYLIST_TRANSFER_FORMAT = 'mineradio-playlist';
const PLAYLIST_TRANSFER_VERSION = 1;
const PLAYLIST_TRANSFER_EXTENSION = '.mineradio.json';
const MAX_TRANSFER_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSFER_TRACKS = 5000;

// 文件名里不能出现的字符，外加前后空白与结尾的点（Windows 会悄悄去掉结尾的点/空格）。
// Characters Windows refuses in a file name, plus trailing dots and spaces it silently trims.
function sanitizeFileName(value, fallback = 'playlist') {
  const text = String(value == null ? '' : value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  return text || fallback;
}

function defaultExportFileName(name) {
  return sanitizeFileName(name, 'playlist') + PLAYLIST_TRANSFER_EXTENSION;
}

// 导入时接受手写的极简文件（只有 name + tracks），但格式标记写错时必须报出来，
// 否则一个别的 JSON 会被当成"空歌单"静默导入。
// A hand-written file with just name + tracks is accepted, but a wrong format stamp has to be
// reported — otherwise any unrelated JSON would import silently as an empty playlist.
function parseTransferPayload(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (_) {
    return { ok: false, error: 'PLAYLIST_TRANSFER_INVALID_JSON', tracks: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'PLAYLIST_TRANSFER_INVALID_JSON', tracks: [] };
  }
  if (parsed.format && parsed.format !== PLAYLIST_TRANSFER_FORMAT) {
    return { ok: false, error: 'PLAYLIST_TRANSFER_FOREIGN_FORMAT', tracks: [] };
  }
  if (!Array.isArray(parsed.tracks)) {
    return { ok: false, error: 'PLAYLIST_TRANSFER_NO_TRACKS', tracks: [] };
  }
  const tracks = [];
  const seen = new Set();
  let skippedInvalid = 0;
  let skippedLocal = 0;
  let skippedDuplicate = 0;
  for (const source of parsed.tracks.slice(0, MAX_TRANSFER_TRACKS)) {
    const track = sanitizeTrack(source);
    if (!track) { skippedInvalid += 1; continue; }
    // 本地曲目跨机器没有意义：localFileId / localUrl 绑的是导出方的曲库，导入方拿来只会得到
    // 一条点不响的灰色条目，所以直接丢掉，并在结果里说清楚丢了几首。
    // Local tracks carry ids into the exporter's own library; on another machine they only
    // produce grey unplayable rows, so they are dropped and counted.
    if (track.provider === 'local') { skippedLocal += 1; continue; }
    if (seen.has(track.builtInIdentity)) { skippedDuplicate += 1; continue; }
    seen.add(track.builtInIdentity);
    tracks.push(track);
  }
  const name = String(parsed.name == null ? '' : parsed.name).trim().slice(0, 80);
  return {
    ok: true,
    name,
    tracks,
    total: tracks.length,
    skippedInvalid,
    skippedLocal,
    skippedDuplicate,
    truncated: parsed.tracks.length > MAX_TRANSFER_TRACKS,
  };
}

function buildTransferPayload(source) {
  const input = source && typeof source === 'object' ? source : {};
  const tracks = [];
  const seen = new Set();
  let skippedInvalid = 0;
  let skippedDuplicate = 0;
  for (const item of Array.isArray(input.tracks) ? input.tracks.slice(0, MAX_TRANSFER_TRACKS) : []) {
    const track = sanitizeTrack(item);
    if (!track) { skippedInvalid += 1; continue; }
    if (seen.has(track.builtInIdentity)) { skippedDuplicate += 1; continue; }
    seen.add(track.builtInIdentity);
    tracks.push(track);
  }
  const payload = {
    format: PLAYLIST_TRANSFER_FORMAT,
    version: PLAYLIST_TRANSFER_VERSION,
    name: String(input.name == null ? '' : input.name).trim().slice(0, 80),
    exportedAt: Date.now(),
    count: tracks.length,
    tracks,
  };
  return { payload, total: tracks.length, skippedInvalid, skippedDuplicate };
}

function writeTransferFile(filePath, text) {
  const target = String(filePath || '');
  if (!target) throw Object.assign(new Error('PLAYLIST_TRANSFER_NO_PATH'), { code: 'PLAYLIST_TRANSFER_NO_PATH' });
  const body = String(text || '');
  if (Buffer.byteLength(body, 'utf8') > MAX_TRANSFER_FILE_BYTES) {
    throw Object.assign(new Error('PLAYLIST_TRANSFER_TOO_LARGE'), { code: 'PLAYLIST_TRANSFER_TOO_LARGE' });
  }
  fs.writeFileSync(target, body, 'utf8');
  return { filePath: target, bytes: Buffer.byteLength(body, 'utf8') };
}

function readTransferFile(filePath) {
  const target = String(filePath || '');
  if (!target) throw Object.assign(new Error('PLAYLIST_TRANSFER_NO_PATH'), { code: 'PLAYLIST_TRANSFER_NO_PATH' });
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw Object.assign(new Error('PLAYLIST_TRANSFER_NOT_A_FILE'), { code: 'PLAYLIST_TRANSFER_NOT_A_FILE' });
  if (stat.size > MAX_TRANSFER_FILE_BYTES) {
    throw Object.assign(new Error('PLAYLIST_TRANSFER_TOO_LARGE'), { code: 'PLAYLIST_TRANSFER_TOO_LARGE' });
  }
  return fs.readFileSync(target, 'utf8');
}

module.exports = {
  MAX_TRANSFER_FILE_BYTES,
  MAX_TRANSFER_TRACKS,
  PLAYLIST_TRANSFER_EXTENSION,
  PLAYLIST_TRANSFER_FORMAT,
  PLAYLIST_TRANSFER_VERSION,
  buildTransferPayload,
  defaultExportFileName,
  parseTransferPayload,
  readTransferFile,
  sanitizeFileName,
  writeTransferFile,
};
