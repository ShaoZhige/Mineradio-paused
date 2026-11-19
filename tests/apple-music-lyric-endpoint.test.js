'use strict';

// Apple Music 的歌词以前根本取不到：`lyricEndpointForSong` 没有 applemusic 分支，
// 于是 Apple 的 catalog id 被塞进了网易云的 `/api/lyric`，两边的 id 空间毫无关系。
// 这里把 06-lyrics/00 模块拉进 vm 跑，钉住两条：
//   1. applemusic 走 `/api/apple-music/lyric`，并且优先用 catalogId 而不是库内 `i.xxx`；
//   2. 歌词运行时缓存（桌面歌词 / 3D 歌词的"当前第几句"）在外部播放时也读同一个时钟 —— 
//      否则 Apple Music 播着歌，歌词却停在 0 秒。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/modules/06-lyrics/00-lyrics-fetch-parse.js'), 'utf8');

function fakeDocument() {
  return {
    readyState: 'complete',
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    createElement() {
      return { style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, appendChild() {}, setAttribute() {} };
    },
    body: { classList: { contains() { return false; } }, appendChild() {} },
  };
}

function loadModule() {
  const sandbox = {
    __MINERADIO_TEST__: true,
    document: fakeDocument(),
    requestAnimationFrame() {},
    addEventListener() {},
    performance: { now: () => 0 },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: '00-lyrics-fetch-parse.js' });
  // 模块末尾会自动挂一个 250ms 的歌词心跳；测试进程必须把它关掉，否则 node 永不退出，
  // 测试运行器只能超时杀掉整个文件。
  // The module starts a 250 ms lyric heartbeat at load time. Stop it, or the process never exits
  // and the runner has to kill the whole file.
  vm.runInContext('stopLyricRuntimeSync()', sandbox);
  // songProviderKey 在 05-playback/07-search.js 里，这里按它的真实判据做最简实现。
  vm.runInContext([
    'function songProviderKey(song) {',
    '  song = song || {};',
    "  if (song.provider === 'applemusic' || song.source === 'applemusic' || song.type === 'applemusic' || song.appleMusicId) return 'applemusic';",
    "  if (song.provider === 'spotify' || song.source === 'spotify' || song.spotifyId) return 'spotify';",
    "  return 'netease';",
    '}',
    'function playbackDurationFromSong(song) { return Number((song || {}).duration) || 0; }',
    // 这两个在别的模块里，占位文本与歌单面板都不参与本测试。
    'function currentLyricSong() { return null; }',
  ].join('\n'), sandbox);
  return sandbox;
}

const sandbox = loadModule();
const endpointOf = (song) => sandbox.lyricEndpointForSong(song);

test('apple music lyrics go to the Apple endpoint with the catalog id', () => {
  const url = endpointOf({
    provider: 'applemusic',
    id: 'i.eoD8V5gfMbAPzJG',
    catalogId: '6784560665',
    name: '晴天',
  });
  assert.equal(url, '/api/apple-music/lyric?id=6784560665');
  assert.ok(!url.includes('i.eoD8V5gfMbAPzJG'), 'a library id must never be sent as the lyric id');
});

test('a song without a catalog id still asks Apple instead of Netease', () => {
  // 没有 catalogId 时只能试一次 id；宁可 Apple 回 404，也不能拿 Apple 的 id 去查网易云。
  const url = endpointOf({ provider: 'applemusic', id: '1234567890' });
  assert.equal(url, '/api/apple-music/lyric?id=1234567890');
});

test('other providers keep their own lyric endpoints', () => {
  assert.equal(endpointOf({ provider: 'spotify', id: 'sp1' }), '/api/spotify/lyric?id=sp1');
  assert.equal(endpointOf({ provider: 'netease', id: 42 }), '/api/lyric?id=42');
});

test('the lyric runtime cache follows external playback instead of a frozen audio element', () => {
  sandbox.lyricsLines = [
    { t: 0, text: '第一句', duration: 2 },
    { t: 2, text: '第二句', duration: 2 },
    { t: 4, text: '第三句', duration: 2 },
  ];
  // Apple Music：音频在 WebView2 里，本页的 audio 元素永远是 0 秒。
  sandbox.audio = { currentTime: 0 };
  sandbox.playing = true;
  sandbox.getPlaybackCurrentSeconds = () => 2.5;
  vm.runInContext('syncLyricRuntimeState("test-external")', sandbox);
  const cache = sandbox.lyricRuntimeCache;
  assert.equal(cache.t, 2.5, 'the cache must read the playback clock, not audio.currentTime');
  assert.equal(cache.index, 1, `expected the second line, got index ${cache.index}`);

  sandbox.getPlaybackCurrentSeconds = () => 4.4;
  vm.runInContext('syncLyricRuntimeState("test-external-2")', sandbox);
  assert.equal(sandbox.lyricRuntimeCache.index, 2);
});
