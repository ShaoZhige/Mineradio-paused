// Spotify 播放唤起隔离模块 / Isolated Spotify launch bridge.
// 仅负责：读取「播放 Spotify 源时是否唤起本机 Spotify 客户端」的开关，
// 以及在点播 Spotify 曲目时通过 window.open 触发主进程已注册的外部协议唤起。
// 不修改 server/spotify-api.js 与播放引擎，换源（switch_source）逻辑保持原样。
// Only owns the "launch Spotify client when playing a Spotify source" preference and
// fires window.open so the main process opens the spotify: URI. Playback fallback is untouched.
'use strict';

// localStorage 键名遵循仓库约定：mineradio-<用途>-v1 / key follows the mineradio-<purpose>-v1 convention.
var SPOTIFY_LAUNCH_CLIENT_STORE_KEY = 'mineradio-spotify-launch-client-v1';

// 默认开启：未写入任何值时视为开启 / default ON when the key is absent.
var spotifyLaunchClientEnabled = readSpotifyLaunchClientEnabled();
var lastLaunchedSpotifyId = '';
var lastLaunchedSpotifyAt = 0;
var SPOTIFY_LAUNCH_DEDUPE_MS = 2000;

// 去除 spotify:track: 前缀，统一成裸 track id / strip the spotify:track: prefix to a bare id.
function normalizeSpotifyTrackId(value) {
  var id = typeof value === 'string' ? value : '';
  id = id.replace(/^spotify:track:/i, '').replace(/^spotify:/i, '').trim();
  return id;
}

function readSpotifyLaunchClientEnabled() {
  try {
    var raw = localStorage.getItem(SPOTIFY_LAUNCH_CLIENT_STORE_KEY);
    if (raw == null) return true; // 缺省开启 / default enabled
    return raw === '1';
  } catch (e) {
    return true;
  }
}

function setSpotifyLaunchClientEnabled(on) {
  spotifyLaunchClientEnabled = !!on;
  try {
    localStorage.setItem(SPOTIFY_LAUNCH_CLIENT_STORE_KEY, spotifyLaunchClientEnabled ? '1' : '0');
  } catch (e) { }
}

function isSpotifyLaunchClientEnabled() {
  return spotifyLaunchClientEnabled;
}

// 点播 Spotify 曲目时尝试唤起本机 Spotify 客户端。
// Try to launch the local Spotify client when a Spotify-sourced track is played.
// 主进程 setWindowOpenHandler 会把 window.open 的外部 URL 交给 shell.openExternal，
// 因此这里只需 window.open('spotify:track:<id>')，无需新增 IPC。
// The main process already routes window.open external URLs to shell.openExternal,
// so no new IPC is required here.
function maybeLaunchSpotifyClient(song) {
  if (!spotifyLaunchClientEnabled) return false;
  if (!song || song.provider !== 'spotify') return false;
  var id = normalizeSpotifyTrackId(song.spotifyId || song.providerSongId || song.id);
  if (!id) return false;
  var now = Date.now();
  if (id === lastLaunchedSpotifyId && now - lastLaunchedSpotifyAt < SPOTIFY_LAUNCH_DEDUPE_MS) return false;
  lastLaunchedSpotifyId = id;
  lastLaunchedSpotifyAt = now;
  try {
    // 唤起失败（未安装客户端等）静默忽略，仍由既有换源逻辑兜底。
    // Failures (client not installed, etc.) are ignored silently; the existing
    // switch_source fallback still plays the matched domestic source.
    window.open('spotify:track:' + id, '_blank');
    return true;
  } catch (e) {
    return false;
  }
}

// 供其它模块按需调用，避免重复依赖 / exposed so other modules can call without re-implementing.
if (typeof window !== 'undefined') {
  window.SpotifyLaunchClient = {
    isEnabled: isSpotifyLaunchClientEnabled,
    setEnabled: setSpotifyLaunchClientEnabled,
    maybeLaunch: maybeLaunchSpotifyClient
  };
}
