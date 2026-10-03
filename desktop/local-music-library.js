const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const {
  LOCAL_LIBRARY_MAX_WATCHED_DIRECTORIES,
  LOCAL_LIBRARY_WATCH_DEBOUNCE_MS,
  collectWatchableDirectories,
  isSupportedAudioFile,
  normalizedDirectoryKey,
} = require('./local-library-watcher');

const LOCAL_MUSIC_SCHEME = 'mineradio-local';
const LOCAL_LIBRARY_VERSION = 1;
const LOCAL_LIBRARY_FILE = 'local-music-library.json';
const LOCAL_LIBRARY_DIRECTORY = 'local-music-library';
const LOCAL_COVER_DIRECTORY = 'covers';
const MAX_LIBRARY_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_LYRIC_BYTES = 512 * 1024;
const MAX_COVER_BYTES = 6 * 1024 * 1024;
const MAX_UNKNOWN_DIMENSION_COVER_BYTES = 1024 * 1024;
const MAX_COVER_DIMENSION = 4096;
const MAX_COVER_PIXELS = 12 * 1024 * 1024;
const MAX_IMPORT_FILES = 50000;
const METADATA_CONCURRENCY = 3;

const AUDIO_MIME = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.flac', 'audio/flac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.opus', 'audio/ogg'],
]);
const COVER_EXTENSION_BY_MIME = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/bmp', '.bmp'],
]);
const COVER_MIME_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
]);

let musicMetadataModulePromise = null;

function registerLocalMusicScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: LOCAL_MUSIC_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

function normalizedAbsoluteFilePath(value) {
  const input = String(value || '').trim();
  if (!input || /^[\\/]{2}/.test(input) || !path.isAbsolute(input)) return '';
  return path.resolve(input);
}

function normalizedPathIdentity(value) {
  const resolved = normalizedAbsoluteFilePath(value);
  if (!resolved) return '';
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function supportedAudioPath(value) {
  const resolved = normalizedAbsoluteFilePath(value);
  return resolved && AUDIO_MIME.has(path.extname(resolved).toLowerCase()) ? resolved : '';
}

// 判定记录指向的音频文件当前是否还在磁盘上。改名 / 移动 / 拔盘都会让记录变成孤儿，
// 这类记录不能进播放队列（协议层 stat 会失败并返回 404 打死播放），但也绝不能从索引里
// 删除：拔掉移动磁盘时删除会把该盘全部记录永久清掉，属于不可逆的数据丢失。
// 中英对照：Detect orphan records whose audio file is no longer on disk. They must stay out
// of the play queue (a 404 there aborts playback) but must never be pruned from the index —
// pruning would permanently drop every record of a temporarily detached drive.
function localRecordFileExists(record) {
  const filePath = record && record.audioPath;
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function cleanText(value, fallback, maxLength = 1000) {
  const text = String(value == null ? '' : value).replace(/\0/g, '').trim();
  return (text || String(fallback || '')).slice(0, maxLength);
}

function localFileId(filePath) {
  return crypto.createHash('sha256').update(normalizedPathIdentity(filePath)).digest('hex').slice(0, 24);
}

function audioRevision(stat) {
  return `${Math.max(0, Math.round(Number(stat && stat.mtimeMs) || 0)).toString(36)}-${Math.max(0, Number(stat && stat.size) || 0).toString(36)}`;
}

function localMediaUrl(kind, id, revision, capability) {
  const query = new URLSearchParams();
  if (revision) query.set('v', revision);
  if (capability) query.set('cap', capability);
  return `${LOCAL_MUSIC_SCHEME}://${kind}/${encodeURIComponent(id)}${query.size ? `?${query.toString()}` : ''}`;
}

function isPathInside(root, candidate) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(candidate);
  const relative = path.relative(rootPath, targetPath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function embeddedImageDimensions(data, mime) {
  if (!Buffer.isBuffer(data) || data.length < 10) return null;
  const normalizedMime = String(mime || '').toLowerCase();
  if (normalizedMime === 'image/png' && data.length >= 24 && data.toString('ascii', 1, 4) === 'PNG') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (normalizedMime === 'image/gif') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (normalizedMime === 'image/bmp' && data.length >= 26) {
    return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  }
  if ((normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg') && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      const marker = data[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  if (normalizedMime === 'image/webp' && data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    }
    if (kind === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function coverWithinBudget(data, mime) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_COVER_BYTES) return false;
  const dimensions = embeddedImageDimensions(data, mime);
  if (!dimensions) return data.length <= MAX_UNKNOWN_DIMENSION_COVER_BYTES;
  const width = Number(dimensions.width) || 0;
  const height = Number(dimensions.height) || 0;
  return width > 0
    && height > 0
    && width <= MAX_COVER_DIMENSION
    && height <= MAX_COVER_DIMENSION
    && width * height <= MAX_COVER_PIXELS;
}

function parseByteRange(value, size) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(text);
  if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - Math.floor(suffix));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
    start = Math.floor(start);
    end = Math.min(size - 1, Math.floor(end));
  }
  if (start < 0 || end < start || start >= size) return { invalid: true };
  return { start, end };
}

function decodeLyricBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (!buffer.length) return '';
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8').replace(/\0/g, '').trim();
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le').replace(/\0/g, '').trim();
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString('utf16le').replace(/\0/g, '').trim();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/\0/g, '').trim();
  } catch (_) {
    try {
      return new TextDecoder('gb18030').decode(buffer).replace(/\0/g, '').trim();
    } catch (_) {
      return buffer.toString('utf8').replace(/\0/g, '').trim();
    }
  }
}

function formatLrcTimestamp(timestamp) {
  const totalMs = Math.max(0, Math.round(Number(timestamp) || 0));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}]`;
}

function embeddedLyricText(common) {
  const lyrics = Array.isArray(common && common.lyrics) ? common.lyrics : [];
  for (const item of lyrics) {
    const syncText = Array.isArray(item && item.syncText) ? item.syncText : [];
    if (syncText.length) {
      const lines = syncText
        .filter((line) => line && String(line.text || '').trim())
        .map((line) => `${formatLrcTimestamp(line.timestamp)}${String(line.text || '').trim()}`);
      if (lines.length) return lines.join('\n').slice(0, MAX_LYRIC_BYTES);
    }
    const text = cleanText(item && item.text, '', MAX_LYRIC_BYTES);
    if (text) return text;
  }
  return '';
}

function normalizeImportEntries(input) {
  const entries = [];
  const seen = new Set();
  for (const item of Array.isArray(input) ? input.slice(0, MAX_IMPORT_FILES) : []) {
    const requestedPath = typeof item === 'string' ? item : item && item.path;
    const filePath = supportedAudioPath(requestedPath);
    const identity = normalizedPathIdentity(filePath);
    if (!filePath || !identity || seen.has(identity)) continue;
    seen.add(identity);
    entries.push({
      path: filePath,
      relativePath: cleanText(item && item.relativePath, path.basename(filePath), 2000),
    });
  }
  return entries;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(Math.max(1, limit), items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function defaultParseMetadata(filePath) {
  if (!musicMetadataModulePromise) musicMetadataModulePromise = import('music-metadata');
  const module = await musicMetadataModulePromise;
  return module.parseFile(filePath, { duration: true, skipCovers: false });
}

async function buildLrcSidecarIndex(entries) {
  const directories = Array.from(new Set(entries.map((entry) => path.dirname(entry.path))));
  const maps = new Map();
  await mapWithConcurrency(directories, METADATA_CONCURRENCY, async (directory) => {
    const lookup = new Map();
    try {
      const names = await fs.promises.readdir(directory);
      for (const name of names) {
        if (path.extname(name).toLowerCase() !== '.lrc') continue;
        lookup.set(path.basename(name, path.extname(name)).toLowerCase(), path.join(directory, name));
      }
    } catch (_) {}
    maps.set(normalizedPathIdentity(directory), lookup);
  });
  return maps;
}

class LocalMusicLibrary {
  constructor(options = {}) {
    this.userDataPath = path.resolve(String(options.userDataPath || process.cwd()));
    this.libraryDirectory = path.join(this.userDataPath, LOCAL_LIBRARY_DIRECTORY);
    this.coverDirectory = path.join(this.libraryDirectory, LOCAL_COVER_DIRECTORY);
    this.indexPath = path.join(this.userDataPath, LOCAL_LIBRARY_FILE);
    this.parseMetadata = typeof options.parseMetadata === 'function' ? options.parseMetadata : defaultParseMetadata;
    this.records = new Map();
    this.order = [];
    this.mediaToken = crypto.randomBytes(24).toString('hex');
    this.protocolInstalled = false;
    this.mutation = Promise.resolve();
    // 监视器状态。watchers 用 Map 存，键是折叠后的目录路径，这样重复注册同一个目录（大小写
    // 不同、软链、不同来源的曲目落在同一目录）不会开出第二个句柄。
    this.watchers = new Map();
    this.watchDirectories = new Map();
    this.watchDebounceTimers = new Map();
    this.watchRoots = [];
    this.watchSkippedDirectories = 0;
    this.onWatchChange = typeof options.onWatchChange === 'function' ? options.onWatchChange : null;
    this.loadIndex();
  }

  loadIndex() {
    try {
      const stat = fs.statSync(this.indexPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LIBRARY_INDEX_BYTES) return;
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      if (!parsed || parsed.version !== LOCAL_LIBRARY_VERSION || !Array.isArray(parsed.records)) return;
      if (/^[a-f0-9]{48}$/i.test(String(parsed.mediaToken || ''))) this.mediaToken = String(parsed.mediaToken).toLowerCase();
      const nextRecords = new Map();
      const nextOrder = [];
      for (const source of parsed.records.slice(0, MAX_IMPORT_FILES)) {
        const audioPath = supportedAudioPath(source && source.audioPath);
        const id = cleanText(source && source.id, '', 64).toLowerCase();
        if (!audioPath || !/^[a-f0-9]{24}$/.test(id) || id !== localFileId(audioPath) || nextRecords.has(id)) continue;
        let coverPath = normalizedAbsoluteFilePath(source.coverPath);
        if (!coverPath || !isPathInside(this.coverDirectory, coverPath)) coverPath = '';
        const record = {
          id,
          audioPath,
          relativePath: cleanText(source.relativePath, path.basename(audioPath), 2000),
          name: cleanText(source.name, path.basename(audioPath, path.extname(audioPath)), 1000),
          artist: cleanText(source.artist, '本地文件', 1000),
          album: cleanText(source.album, '', 1000),
          duration: Math.max(0, Number(source.duration) || 0),
          size: Math.max(0, Number(source.size) || 0),
          mtimeMs: Math.max(0, Number(source.mtimeMs) || 0),
          revision: cleanText(source.revision, '', 100),
          coverPath,
          coverMime: cleanText(source.coverMime, '', 100),
          lyric: cleanText(source.lyric, '', MAX_LYRIC_BYTES),
          lyricSource: source.lyricSource === 'sidecar' ? 'sidecar' : (source.lyricSource === 'embedded' ? 'embedded' : ''),
          importedAt: Math.max(0, Number(source.importedAt) || 0),
        };
        nextRecords.set(id, record);
        nextOrder.push(id);
      }
      this.records = nextRecords;
      this.order = nextOrder;
    } catch (_) {}
  }

  // fileExists 为 false 时不下发 localUrl / cover：失效记录的音源 URL 只会 404，
  // 交给播放器就只能得到"播放启动失败"，留空才会走前端可恢复的"本地文件已失效"分支。
  // 中英对照：Withhold localUrl and cover for records whose file is gone — a URL for a
  // missing file can only 404, which surfaces as an unrecoverable playback failure.
  serializeRecord(record, fileExists) {
    const available = fileExists !== false;
    const coverAvailable = available && !!record.coverPath;
    return {
      type: 'local',
      source: 'local',
      provider: 'local',
      id: `local:${record.id}`,
      localFileId: record.id,
      localKey: record.id,
      localUrl: available ? localMediaUrl('audio', record.id, record.revision, this.mediaToken) : '',
      localPath: record.relativePath || path.basename(record.audioPath),
      localMissing: !available,
      name: record.name,
      title: record.name,
      artist: record.artist || '本地文件',
      album: record.album || '',
      duration: Math.max(0, Number(record.duration) || 0),
      cover: coverAvailable ? localMediaUrl('cover', record.id, record.revision, this.mediaToken) : '',
      hasLyric: !!record.lyric,
      lyricSource: record.lyricSource || '',
    };
  }

  listTracksSync() {
    const tracks = [];
    let missing = 0;
    for (const id of this.order) {
      const record = this.records.get(id);
      if (!record) continue;
      const fileExists = localRecordFileExists(record);
      if (!fileExists) { missing += 1; continue; }
      tracks.push(this.serializeRecord(record, fileExists));
    }
    return { ok: true, version: LOCAL_LIBRARY_VERSION, count: tracks.length, missing, tracks };
  }

  async listTracks() {
    const tracks = [];
    let missing = 0;
    for (let index = 0; index < this.order.length; index += 1) {
      const record = this.records.get(this.order[index]);
      if (record) {
        const fileExists = localRecordFileExists(record);
        if (fileExists) tracks.push(this.serializeRecord(record, fileExists));
        else missing += 1;
      }
      if (index > 0 && index % 400 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    return { ok: true, version: LOCAL_LIBRARY_VERSION, count: tracks.length, missing, tracks };
  }

  // 按 localFileId 回查当前记录并重新生成音源 URL。内置歌单保存的是导入时刻的曲目快照，
  // 快照里的 localUrl 带着当时的 cap=<mediaToken>，媒体令牌一旦轮换（索引重建等）快照 URL
  // 就永久 404，即使文件仍在磁盘上。与列表不同，这里保留失效曲目（localUrl 置空），
  // 让内置歌单显示原有内容并在点击时给出可恢复的提示，而不是让它无声消失。
  // 中英对照：Re-resolve a track against the live index. Built-in playlists keep a snapshot
  // whose localUrl carries the media token captured at import time; a rotated token would make
  // those URLs 404 forever even though the file is still on disk. Unlike the list output this
  // keeps orphan entries (with an empty localUrl) so the playlist still shows what it curated.
  resolveTrack(value) {
    const id = cleanText(value, '', 64).replace(/^local:/, '').toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(id)) return null;
    const record = this.records.get(id);
    if (!record) return null;
    return this.serializeRecord(record, localRecordFileExists(record));
  }

  lyricForTrack(value) {
    const id = cleanText(value, '', 64).replace(/^local:/, '').toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(id)) return { ok: false, localFileId: '', lyric: '', lyricSource: '', error: 'LOCAL_TRACK_INVALID' };
    const record = this.records.get(id);
    if (!record) return { ok: false, localFileId: id, lyric: '', lyricSource: '', missing: true, error: 'LOCAL_TRACK_MISSING' };
    return {
      ok: true,
      localFileId: id,
      lyric: record.lyric || '',
      lyricSource: record.lyricSource || '',
    };
  }

  async stageSnapshot(order, records) {
    await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true });
    const payload = {
      version: LOCAL_LIBRARY_VERSION,
      updatedAt: Date.now(),
      mediaToken: this.mediaToken,
      records: order.map((id) => records.get(id)).filter(Boolean),
    };
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, 'utf8') > MAX_LIBRARY_INDEX_BYTES) {
      const error = new Error('LOCAL_LIBRARY_INDEX_TOO_LARGE');
      error.code = 'LOCAL_LIBRARY_INDEX_TOO_LARGE';
      throw error;
    }
    const temporary = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, text, 'utf8');
      return temporary;
    } catch (error) {
      safeUnlink(temporary);
      throw error;
    }
  }

  async persistSnapshot(order, records) {
    const temporary = await this.stageSnapshot(order, records);
    try {
      await fs.promises.rename(temporary, this.indexPath);
    } catch (error) {
      safeUnlink(temporary);
      throw error;
    }
  }

  async stageCover(id, picture, previous) {
    if (!picture) return { path: '', mime: '' };
    const mime = cleanText(picture && picture.format, '', 100).toLowerCase();
    const extension = COVER_EXTENSION_BY_MIME.get(mime);
    const data = picture && picture.data ? Buffer.from(picture.data) : null;
    if (!extension || !coverWithinBudget(data, mime)) {
      return {
        path: previous && previous.coverPath || '',
        mime: previous && previous.coverMime || '',
        rejected: !!(extension && data && data.length),
      };
    }
    await fs.promises.mkdir(this.coverDirectory, { recursive: true });
    const digest = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
    const target = path.join(this.coverDirectory, `${id}-${digest}${extension}`);
    if (fs.existsSync(target)) return { path: target, mime };
    const temporary = path.join(this.coverDirectory, `.${id}-${digest}.${process.pid}.${Date.now()}.stage`);
    await fs.promises.writeFile(temporary, data);
    return { path: target, mime, stagedPath: temporary };
  }

  async parseEntry(entry, sidecarDirectories) {
    const stat = await fs.promises.stat(entry.path);
    if (!stat.isFile()) {
      const error = new Error('LOCAL_AUDIO_NOT_FILE');
      error.code = 'LOCAL_AUDIO_NOT_FILE';
      throw error;
    }
    const id = localFileId(entry.path);
    const previous = this.records.get(id);
    let metadata = {};
    let metadataError = '';
    try {
      metadata = await this.parseMetadata(entry.path) || {};
    } catch (error) {
      metadataError = String(error && error.message || error || 'METADATA_PARSE_FAILED').slice(0, 500);
    }
    const common = metadata.common || {};
    const format = metadata.format || {};
    const fallbackTitle = path.basename(entry.path, path.extname(entry.path));
    const artists = Array.isArray(common.artists) ? common.artists.filter(Boolean).join(' / ') : '';
    const picture = Array.isArray(common.picture) && common.picture.length ? common.picture[0] : null;
    const cover = metadataError
      ? {
        path: previous && previous.coverPath || '',
        mime: previous && previous.coverMime || '',
      }
      : await this.stageCover(id, picture, previous);
    const directoryLookup = sidecarDirectories.get(normalizedPathIdentity(path.dirname(entry.path)));
    const sidecarPath = directoryLookup && directoryLookup.get(fallbackTitle.toLowerCase());
    let lyric = '';
    let lyricSource = '';
    if (sidecarPath) {
      try {
        const lyricStat = await fs.promises.stat(sidecarPath);
        if (lyricStat.isFile() && lyricStat.size > 0 && lyricStat.size <= MAX_LYRIC_BYTES) {
          lyric = decodeLyricBuffer(await fs.promises.readFile(sidecarPath)).slice(0, MAX_LYRIC_BYTES);
          if (lyric) lyricSource = 'sidecar';
        }
      } catch (_) {}
    }
    if (!lyric) {
      lyric = embeddedLyricText(common);
      if (lyric) lyricSource = 'embedded';
    }
    if (!lyric && metadataError && previous && previous.lyric) {
      lyric = previous.lyric;
      lyricSource = previous.lyricSource || '';
    }
    const relativeDirectory = path.dirname(entry.relativePath || '');
    const fallbackAlbum = relativeDirectory && relativeDirectory !== '.' ? relativeDirectory.split(/[\\/]/).join(' / ') : '';
    return {
      record: {
        id,
        audioPath: entry.path,
        relativePath: entry.relativePath || path.basename(entry.path),
        name: cleanText(common.title, metadataError && previous ? previous.name : fallbackTitle, 1000),
        artist: cleanText(common.artist || artists, metadataError && previous ? previous.artist : '本地文件', 1000),
        album: cleanText(common.album, metadataError && previous ? previous.album : fallbackAlbum, 1000),
        duration: Math.max(0, Number(format.duration) || (metadataError && previous ? Number(previous.duration) : 0) || 0),
        size: Math.max(0, Number(stat.size) || 0),
        mtimeMs: Math.max(0, Number(stat.mtimeMs) || 0),
        revision: audioRevision(stat),
        coverPath: cover.path,
        coverMime: cover.mime,
        lyric,
        lyricSource,
        importedAt: Date.now(),
      },
      metadataError,
      coverWarning: cover.rejected ? 'LOCAL_COVER_REJECTED_BY_BUDGET' : '',
      stagedCoverPath: cover.stagedPath || '',
      previousCoverPath: previous && previous.coverPath || '',
    };
  }

  importFiles(input, options = {}) {
    const entries = normalizeImportEntries(input);
    const replace = options.replace === true;
    const operation = async () => {
      if (!entries.length) return { ok: false, count: 0, tracks: [], failures: [], error: 'NO_SUPPORTED_LOCAL_AUDIO' };
      const sidecarDirectories = await buildLrcSidecarIndex(entries);
      const parsed = await mapWithConcurrency(entries, METADATA_CONCURRENCY, async (entry) => {
        try {
          return await this.parseEntry(entry, sidecarDirectories);
        } catch (error) {
          return {
            failure: {
              name: path.basename(entry.path),
              error: String(error && (error.code || error.message) || error || 'LOCAL_IMPORT_FAILED').slice(0, 500),
            },
          };
        }
      });
      const nextRecords = replace ? new Map() : new Map(this.records);
      const nextOrder = replace ? [] : this.order.slice();
      const failures = [];
      const metadataWarnings = [];
      const stagedCovers = [];
      const cleanupAfterCommit = new Set();
      for (const result of parsed) {
        if (!result || result.failure) {
          if (result && result.failure) failures.push(result.failure);
          continue;
        }
        const record = result.record;
        nextRecords.set(record.id, record);
        const previousIndex = nextOrder.indexOf(record.id);
        if (previousIndex >= 0) nextOrder.splice(previousIndex, 1);
        nextOrder.push(record.id);
        if (result.metadataError) metadataWarnings.push({ name: path.basename(record.audioPath), error: result.metadataError });
        if (result.coverWarning) metadataWarnings.push({ name: path.basename(record.audioPath), error: result.coverWarning });
        if (result.stagedCoverPath) {
          stagedCovers.push({ stagedPath: result.stagedCoverPath, targetPath: record.coverPath });
        }
        if (
          result.previousCoverPath
          && (!record.coverPath || path.resolve(result.previousCoverPath) !== path.resolve(record.coverPath))
        ) {
          cleanupAfterCommit.add(result.previousCoverPath);
        }
      }
      if (!nextOrder.length) {
        for (const cover of stagedCovers) safeUnlink(cover.stagedPath);
        return { ok: false, count: 0, tracks: [], failures, metadataWarnings, error: 'LOCAL_IMPORT_FAILED' };
      }
      const removedRecords = replace
        ? this.order.filter((id) => !nextRecords.has(id)).map((id) => this.records.get(id)).filter(Boolean)
        : [];
      for (const record of removedRecords) if (record.coverPath) cleanupAfterCommit.add(record.coverPath);
      let snapshotTemporary = '';
      const createdCoverTargets = [];
      try {
        snapshotTemporary = await this.stageSnapshot(nextOrder, nextRecords);
        for (const cover of stagedCovers) {
          if (fs.existsSync(cover.targetPath)) {
            safeUnlink(cover.stagedPath);
            continue;
          }
          await fs.promises.rename(cover.stagedPath, cover.targetPath);
          createdCoverTargets.push(cover.targetPath);
        }
        await fs.promises.rename(snapshotTemporary, this.indexPath);
        snapshotTemporary = '';
      } catch (error) {
        safeUnlink(snapshotTemporary);
        for (const cover of stagedCovers) safeUnlink(cover.stagedPath);
        for (const target of createdCoverTargets) safeUnlink(target);
        throw error;
      }
      this.records = nextRecords;
      this.order = nextOrder;
      for (const oldCoverPath of cleanupAfterCommit) safeUnlink(oldCoverPath);
      const snapshot = this.listTracksSync();
      return { ...snapshot, failures, metadataWarnings };
    };
    const pending = this.mutation.then(operation, operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  // 监视哪些根目录：从已有记录的 audioPath 反推它们的所在目录，并按目录归组。曲库是引用式的
  // （记录指向原路径），所以"用户加了新歌"就等于"某个被引用目录里多了文件"。
  // Which roots to watch: derived from the existing records' audioPath directories, grouped by
  // directory. The library is reference-based (records point at the original files), so "the user
  // added a song" simply means "a referenced directory gained a file".
  watchedRoots() {
    const byDirectory = new Map();
    for (const record of this.records.values()) {
      const audioPath = String(record && record.audioPath || '');
      if (!audioPath || !supportedAudioPath(audioPath)) continue;
      const directory = path.dirname(audioPath);
      const key = normalizedDirectoryKey(directory);
      if (!key) continue;
      const entry = byDirectory.get(key);
      if (entry) entry.directories.add(directory);
      else byDirectory.set(key, { root: directory, directories: new Set([directory]) });
    }
    return [...byDirectory.values()];
  }

  // 开启监视。返回实际登记的目录数与被截断的数量——界面必须能把"没监视到"和"没有新歌"分开，
  // 否则用户会以为功能坏了。
  // Start watching. Reports how many directories were registered and how many were cut off: the UI
  // has to tell "not being watched" apart from "no new songs", or the user thinks it is broken.
  startWatching(options = {}) {
    this.stopWatching();
    if (options.enabled === false) return { ok: true, watching: false, directories: 0, skipped: 0 };
    const cap = Math.max(1, Math.min(
      LOCAL_LIBRARY_MAX_WATCHED_DIRECTORIES,
      Math.round(Number(options.maxDirectories) || LOCAL_LIBRARY_MAX_WATCHED_DIRECTORIES)
    ));
    const roots = [];
    let skipped = 0;
    let registered = 0;
    for (const group of this.watchedRoots()) {
      const collected = collectWatchableDirectories(group.root, Math.max(1, cap - registered));
      skipped += collected.skipped;
      roots.push(group.root);
      for (const directory of collected.directories) {
        const key = normalizedDirectoryKey(directory);
        if (!key || this.watchers.has(key)) continue;
        try {
          const watcher = fs.watch(directory, { persistent: false }, (eventType, filename) => {
            // 只对"可能影响曲库"的事件响应：Windows 上改名会同时报 rename，内容变化报 change。
            // 至于有没有新歌，等防抖合并之后统一判断，不在这里猜。
            // Only react to events that can affect the library: Windows reports a rename twice
            // (delete + rename) and a content change as 'change'. Whether anything actually changed
            // is decided after the debounce, not guessed here.
            if (eventType !== 'rename' && eventType !== 'change') return;
            this._scheduleWatchSync(group.root);
          });
          watcher.on('error', () => {
            // 单个 watcher 出错（目录被删、句柄失效）只摘掉它自己，不能连带整个监视停摆。
            // One watcher failing (directory removed, handle invalidated) is dropped on its own
            // rather than taking the whole watch down with it.
            try { watcher.close(); } catch (error) { }
            this.watchers.delete(key);
            this.watchDirectories.delete(key);
          });
          this.watchers.set(key, watcher);
          this.watchDirectories.set(key, directory);
          registered += 1;
        } catch (error) {
          // 注册失败（目录不可读、句柄耗尽）就跳过这个目录，别的目录照常监视。
          // A directory that cannot be watched is skipped; the rest keep working.
          skipped += 1;
        }
      }
    }
    this.watchRoots = roots;
    this.watchSkippedDirectories = skipped;
    return { ok: true, watching: registered > 0, directories: registered, skipped };
  }

  _scheduleWatchSync(root) {
    if (this.watchDebounceTimers.has(root)) clearTimeout(this.watchDebounceTimers.get(root));
    const timer = setTimeout(() => {
      this.watchDebounceTimers.delete(root);
      this.syncWatchedFolders().catch((error) => {
        console.warn('[LocalLibrary] watched folder sync failed:', error && (error.code || error.message) || error);
      });
    }, LOCAL_LIBRARY_WATCH_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.watchDebounceTimers.set(root, timer);
  }

  // 增量同步：被监视目录里多出来的音频文件入库；记录指向的文件不见了、而它所在目录还在，则下架。
  // Incremental sync: audio files that appeared under a watched directory are imported, and records
  // whose file is gone are pruned only while the containing directory still exists.
  async syncWatchedFolders() {
    const known = new Set();
    for (const record of this.records.values()) {
      const audioPath = String(record && record.audioPath || '');
      if (audioPath) known.add(normalizedDirectoryKey(audioPath));
    }
    const discovered = [];
    const vanished = [];
    for (const [key, directory] of this.watchDirectories) {
      // 遍历期间 watcher 可能被 error 处理摘掉，所以每轮都要确认它还在。
      // A watcher can be dropped by its own error handler mid-iteration, so re-check each round.
      if (!this.watchers.has(key) || !directory) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !isSupportedAudioFile(entry.name)) continue;
        const candidate = path.join(directory, entry.name);
        if (known.has(normalizedDirectoryKey(candidate))) continue;
        known.add(normalizedDirectoryKey(candidate));
        discovered.push(candidate);
      }
    }
    for (const record of [...this.records.values()]) {
      const audioPath = String(record && record.audioPath || '');
      if (!audioPath || record.missing === true) continue;
      let present = true;
      try {
        present = fs.statSync(audioPath).isFile();
      } catch (error) {
        present = false;
      }
      if (present) continue;
      // 目录还在才敢下架：盘掉线、网络断开也会让文件"消失"，那时候删索引是不可逆的数据损失。
      // Prune only while the directory is still there: a dropped drive or a disconnected share also
      // makes files vanish, and wiping the index for that is irreversible data loss.
      let directoryAlive = false;
      try {
        directoryAlive = fs.statSync(path.dirname(audioPath)).isDirectory();
      } catch (error) {
        directoryAlive = false;
      }
      if (directoryAlive) vanished.push(record.id);
    }
    // importFiles 返回的是**整库快照**（count = 库里的总数），不是"这次新增了几首"。直接拿它的
    // count 当新增数，第二次同步就会报"新增 2"这种明显不对的数字。所以按库容量的差值算。
    // importFiles returns a snapshot of the WHOLE library (count = total tracks), not how many were
    // just added. Using its count would report nonsense such as "added 2" on a no-op sync, so the
    // number of additions is the change in library size.
    const beforeImport = this.records.size;
    let failures = [];
    if (discovered.length) {
      const imported = await this.importFiles(discovered, { replace: false });
      failures = (imported && Array.isArray(imported.failures)) ? imported.failures : [];
    }
    const added = Math.max(0, this.records.size - beforeImport);
    if (vanished.length) await this.removeTracks(vanished);
    const changed = added > 0 || vanished.length > 0;
    if (changed && typeof this.onWatchChange === 'function') {
      try {
        this.onWatchChange({ added, removed: vanished.length });
      } catch (error) {
        console.warn('[LocalLibrary] watch change notification failed:', error && (error.message || error) || error);
      }
    }
    return { ok: true, added, removed: vanished.length, discovered: discovered.length, failures };
  }

  // 关掉全部 watcher 与防抖定时器。fs.watch 的句柄是常驻的，不关进程就退不出去，所以这个方法
  // 必须在库被释放的路径上被调用。
  // Close every watcher and debounce timer. fs.watch handles are live and keep the process alive, so
  // this must run on every path that releases the library.
  stopWatching() {
    for (const timer of this.watchDebounceTimers.values()) clearTimeout(timer);
    this.watchDebounceTimers.clear();
    for (const watcher of this.watchers.values()) {
      try { watcher.close(); } catch (error) { }
    }
    this.watchers.clear();
    this.watchDirectories.clear();
    this.watchRoots = [];
    this.watchSkippedDirectories = 0;
    return true;
  }

  removeTracks(ids) {
    const requested = new Set((Array.isArray(ids) ? ids : [ids])
      .map((id) => cleanText(id, '', 64).replace(/^local:/, '').toLowerCase())
      .filter((id) => /^[a-f0-9]{24}$/.test(id)));
    const operation = async () => {
      if (!requested.size) return this.listTracksSync();
      const nextRecords = new Map(this.records);
      const removed = [];
      for (const id of requested) {
        const record = nextRecords.get(id);
        if (record) removed.push(record);
        nextRecords.delete(id);
      }
      const nextOrder = this.order.filter((id) => nextRecords.has(id));
      await this.persistSnapshot(nextOrder, nextRecords);
      this.records = nextRecords;
      this.order = nextOrder;
      for (const record of removed) safeUnlink(record.coverPath);
      return this.listTracksSync();
    };
    const pending = this.mutation.then(operation, operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  recordForRequest(requestUrl) {
    try {
      const url = new URL(requestUrl);
      const kind = url.hostname === 'audio' ? 'audio' : (url.hostname === 'cover' ? 'cover' : '');
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, '')).toLowerCase();
      if (!kind || !/^[a-f0-9]{24}$/.test(id) || url.searchParams.get('cap') !== this.mediaToken) return null;
      const record = this.records.get(id);
      if (!record) return null;
      const filePath = kind === 'audio' ? record.audioPath : record.coverPath;
      if (!filePath) return null;
      if (kind === 'audio' && !supportedAudioPath(filePath)) return null;
      if (kind === 'cover' && (!isPathInside(this.coverDirectory, filePath) || !COVER_MIME_BY_EXTENSION.has(path.extname(filePath).toLowerCase()))) return null;
      return { record, kind, filePath };
    } catch (_) {
      return null;
    }
  }

  async mediaResponse(request) {
    const method = String(request && request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const target = this.recordForRequest(request && request.url);
    if (!target) return new Response('Not found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
    let stat;
    try {
      stat = await fs.promises.stat(target.filePath);
      if (!stat.isFile()) throw new Error('NOT_FILE');
    } catch (_) {
      return new Response('Not found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
    }
    const size = Math.max(0, Number(stat.size) || 0);
    const rangeHeader = request.headers && request.headers.get ? request.headers.get('range') : '';
    const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
    if (range && range.invalid) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, size - 1);
    const extension = path.extname(target.filePath).toLowerCase();
    const contentType = target.kind === 'audio'
      ? (AUDIO_MIME.get(extension) || 'application/octet-stream')
      : (target.record.coverMime || COVER_MIME_BY_EXTENSION.get(extension) || 'application/octet-stream');
    const headers = {
      'Content-Type': contentType,
      'Content-Length': String(size ? end - start + 1 : 0),
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    };
    const origin = request.headers && request.headers.get ? String(request.headers.get('origin') || '') : '';
    if (/^http:\/\/127\.0\.0\.1:\d+$/i.test(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (method === 'HEAD' || !size) return new Response(null, { status: range ? 206 : 200, headers });
    const stream = fs.createReadStream(target.filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
  }

  async installProtocol(protocol) {
    if (this.protocolInstalled) return;
    await protocol.handle(LOCAL_MUSIC_SCHEME, (request) => this.mediaResponse(request));
    this.protocolInstalled = true;
  }
}

module.exports = {
  AUDIO_MIME,
  LOCAL_MUSIC_SCHEME,
  LocalMusicLibrary,
  coverWithinBudget,
  decodeLyricBuffer,
  embeddedImageDimensions,
  embeddedLyricText,
  localFileId,
  parseByteRange,
  registerLocalMusicScheme,
};
