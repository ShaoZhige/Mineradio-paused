'use strict';

// 把 Mineradio 的歌曲对象翻译成洛雪当前的 MusicInfo 结构。
// 适配器只做字段映射，不发网络请求、不决定播放策略——那是 manager 和前端的事。
// Translates a Mineradio song object into the LX MusicInfo shape. Field mapping only:
// no network access and no playback decisions live here.

// Mineradio 支持五个平台，但洛雪公开协议里只有 wy/tx 有对应的搜索来源，
// 其余平台在这里返回 null，由调用方交回内置接口处理。
// Mineradio ships five providers, but only wy/tx have a discoverable source in the public
// LX contract; everything else resolves to null and falls back to the built-in path.
function platformKey(song) {
  const provider = String(song?.provider || song?.source || '').toLowerCase();
  if (provider === 'qq' || provider === 'tx') return 'tx';
  if (provider === 'netease' || provider === 'wy') return 'wy';
  return null;
}

// 时长统一成 mm:ss。洛雪要求 mm:ss，而 Mineradio 各平台混用毫秒和秒，
// 所以大于 10000 的数值一律当成毫秒。
// Normalizes durations to mm:ss. Mineradio mixes milliseconds and seconds across
// providers, so anything above 10000 counts as milliseconds.
function formatInterval(raw) {
  let seconds = Number(raw) || 0;
  if (seconds > 10000) seconds /= 1000;
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function toLxMusicInfo(song) {
  const source = platformKey(song);
  if (!source) throw new Error('SOURCE_UNSUPPORTED: Unknown Mineradio provider');
  // QQ 的歌曲主键是 songmid，网易云是数值 id；缺少主键时不要发出注定失败的请求。
  // QQ is keyed by songmid, NetEase by a numeric id. Without a primary id the script
  // request would be doomed, so fail fast instead.
  const songId = source === 'tx' ? (song.mid || song.songmid || song.id) : song.id;
  if (songId == null || songId === '') throw new Error('SOURCE_UNSUPPORTED: Missing song id');
  const albumId = song.albumMid || song.albumId || '';
  const rawInterval = song.duration || song.dt || song.interval;
  const interval = source === 'wy' && (song.duration != null || song.dt != null)
    ? formatInterval(Number(song.duration ?? song.dt) / 1000)
    : formatInterval(rawInterval);
  const meta = {
    songId,
    albumName: String(song.album || ''),
    albumId,
    picUrl: song.cover || null,
    qualitys: [],
    _qualitys: {},
  };
  if (source === 'tx') {
    meta.strMediaMid = String(song.mediaMid || song.media_mid || song.strMediaMid || song.songId || songId);
    meta.id = Number(song.qqId || song.songId || 0) || undefined;
    meta.albumMid = String(song.albumMid || song.album_mid || albumId);
  }
  return {
    id: String(song.id ?? songId),
    name: String(song.name || song.title || ''),
    singer: String(song.artist || ''),
    source,
    interval,
    meta,
    // 兼容仍按旧文档读平铺字段的存量脚本；这些只读别名来自 meta，不改变嵌套结构。
    // Read-only aliases for scripts still written against the older flat documentation.
    // They mirror `meta` and never replace the current nested structure.
    songmid: songId,
    albumId,
    strMediaMid: meta.strMediaMid || '',
    copyrightId: '',
    hash: '',
  };
}

module.exports = { platformKey, formatInterval, toLxMusicInfo };
