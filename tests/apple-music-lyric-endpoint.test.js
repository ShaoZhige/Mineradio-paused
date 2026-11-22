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

// 默认（3D）歌词的第二处硬伤：tickLyricsParticles 以前用"有没有 audio 在放"当门槛，
// 而 Apple Music 的音频在 WebView2 里，主页面 audio 没 src、全局 playing 也是 false。
// 结果每帧走 retire 分支 —— 屏幕上没有歌词，偶尔又被别处重建，看起来就是"闪"。
test('默认 3D 歌词在外部播放时也必须活着（用统一播放态，不读 audio）', () => {
  const stage = fs.readFileSync(
    path.join(ROOT, 'public/js/modules/02-visual/14-stage-lyrics-rendering.js'), 'utf8');
  const seek = fs.readFileSync(
    path.join(ROOT, 'public/js/modules/06-lyrics/04-progress-seek.js'), 'utf8');

  assert.match(seek, /function playbackIsPlayingNow\(\)/, '需要统一的播放态判定');
  assert.match(seek, /function playbackUsesExternalAudio\(\)/);

  const at = stage.indexOf('function tickLyricsParticles()');
  assert.ok(at > 0, '找不到 tickLyricsParticles');
  const body = stage.slice(at, stage.indexOf('\nfunction ', at + 30));
  assert.match(body, /playbackIsPlayingNow\(\)/, '必须用统一播放态，而不是全局 playing');
  assert.match(body, /playbackUsesExternalAudio\(\)/);
  assert.ok(!/if \(!playing && !previewingSeek\)/.test(body),
    '不能再用全局 playing 当门槛：外部播放时它恒 false，会把歌词每帧清掉');
  assert.ok(!/if \(!audio \|\| !lyricsLines\.length/.test(body),
    '不能因为主页面没有 audio src 就直接 retire');
});

// 进度条乱跳：轮询 750ms 一次，报告值带 RTT/取样抖动。这里把真实的 externalPlaybackCurrentSeconds
// 抽出来跑，钉住 Folia 那套"本地时钟 + 阈值纠正"的语义：
//   * 0.2s 以内不纠正（本地时钟照走）
//   * 小漂移缓动收敛，不产生台阶
//   * 大跳变要连续两次采样确认（MusicKit 重建播放器会瞬时吐 position=0）
test('外部播放的显示时钟：本地走 + 阈值纠正，不跟着轮询抖', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'public/js/modules/08-account/tribute-to-steve-jobs.js'), 'utf8');
  const at = src.indexOf('function externalPlaybackClock(');
  assert.ok(at > 0, '找不到 externalPlaybackClock');
  const stopAt = src.indexOf('function stopExternalPlaybackPolling', at);
  const fn = src.slice(at, stopAt < 0 ? src.length : stopAt);

  let now = 1_000_000;
  const sandbox = { Date: { now: () => now }, Number, Math, isFinite };
  vm.createContext(sandbox);
  for (const name of ['EXTERNAL_PLAYBACK_DRIFT_TOLERANCE_SEC',
    'EXTERNAL_PLAYBACK_JUMP_TOLERANCE_SEC', 'EXTERNAL_PLAYBACK_EASE_RATIO']) {
    const m = src.match(new RegExp('var ' + name + ' = ([\\d.]+);'));
    assert.ok(m, `找不到常量 ${name}`);
    vm.runInContext(`var ${name} = ${m[1]};`, sandbox);
  }
  vm.runInContext('var externalPlaybackState = null;', sandbox);
  vm.runInContext(fn, sandbox);

  const feed = (sec, atMs) => vm.runInContext(
    `externalPlaybackState.positionMs = ${sec * 1000};`
    + ` externalPlaybackState.sampleSeconds = ${sec};`
    + ` externalPlaybackState.sampleAt = ${atMs};`
    + ` externalPlaybackState.sampleValid = true;`, sandbox);
  const read = () => vm.runInContext('externalPlaybackCurrentSeconds()', sandbox);

  vm.runInContext('externalPlaybackState = { isPlaying: true, positionMs: 0, clockSeconds: 0, clockAt: Date.now() };', sandbox);
  assert.strictEqual(read(), 0);

  // 本地时钟自己走：1 秒
  now += 1000;
  assert.strictEqual(read(), 1);

  // 轮询报告 0.9s（比本地早 0.1s，在阈值内）：不许回退，也不许改
  feed(0.9, now);
  assert.strictEqual(read(), 1, '0.2s 以内的漂移必须忽略');

  // 继续走，不因为那次采样滞后
  now += 1000;
  assert.strictEqual(read(), 2, '本地时钟不该被 0.1s 的采样滞后拖慢');

  // MusicKit 瞬时吐 0：单次不认
  feed(0, now);
  assert.strictEqual(read(), 2, '单次 position=0 不许把进度拽回去');

  // 连续第二次仍是 0：确认为真 seek，吸附到 0
  now += 200;
  feed(0, now);
  assert.strictEqual(read(), 0, '连续两次一致才认 seek');

  // 向前大跳也要两次确认
  feed(30, now);
  assert.strictEqual(read(), 0, '单次向前大跳先记疑点');
  now += 200;
  feed(30.4, now);
  assert.ok(Math.abs(read() - 30.4) < 0.05, '确认后吸附到新位置');

  // 小漂移缓动：一次只吃 15%，不出现台阶
  const before = read();
  now += 750;
  feed(31.9 - 0.75, now); // 候选比显示落后约 0.5s
  const after = read();
  assert.ok(after < before + 1, '先按本地时钟前进');
  assert.ok(before - after < 0.2, `缓动单步不应超过 0.2s，实际 ${(before - after).toFixed(3)}`);
});

// 「下方控制台进度来回跳」的真凶：Apple Music 不创建 audio 元素，而 200ms 心跳在 !audio
// 分支里会拿**启动恢复快照**的旧时间画进度条，750ms 轮询又拿真实位置画 —— 两个来源交替写
// 同一个 #progress-fill。修了两处，这里都钉住。
test('实时外部播放时，心跳不许用恢复快照画进度条', () => {
  const seek = fs.readFileSync(
    path.join(ROOT, 'public/js/modules/06-lyrics/04-progress-seek.js'), 'utf8');
  const at = seek.indexOf('var progressUiHeartbeatTimer = setInterval');
  assert.ok(at > 0, '找不到心跳');
  const body = seek.slice(at, seek.indexOf('}, 200);', at));
  assert.match(body, /if \(!audio\) \{/);
  assert.match(body,
    /var livePlayback = \(typeof isExternalPlaybackActive === 'function' && isExternalPlaybackActive\(\)\);/,
    '心跳必须判断"是否有实时外部播放"');
  assert.match(body,
    /if \(!livePlayback && restoredLastPlaybackSnapshot && pendingPlaybackResumeAt > 0\)/,
    '只有没在实时播放时才可以用快照');
  assert.ok(!/^\s*if \(restoredLastPlaybackSnapshot && pendingPlaybackResumeAt > 0\) \{\s*$/m.test(body),
    '不能再用"无 audio 就画快照"的旧条件');
});

test('Apple Music 起播后必须清掉恢复标记（和本地播放一致）', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'public/js/modules/08-account/tribute-to-steve-jobs.js'), 'utf8');
  const at = src.indexOf('async function startExternalAppleMusicPlayback(');
  assert.ok(at > 0, '找不到 startExternalAppleMusicPlayback');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /pendingPlaybackResumeAt = 0;/,
    'AM 起播后不清标记，心跳就会一直拿快照画进度条');
});

// 三个歌词样式的"卡顿 + 回退跳动"来自同一处：轮询里对 isPlaying / 曲目 id 的处理太脆。
//   1. 单拍 isPlaying:false（MusicKit 常发）会立刻冻结显示时钟 → 歌词停半秒；
//   2. 用 itemId 判断"换曲"并重置锚点 → itemId 抖一下时钟就倒退一大截。
test('轮询抖动不许冻结或倒退歌词时钟', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'public/js/modules/08-account/tribute-to-steve-jobs.js'), 'utf8');
  const at = src.indexOf('function applyExternalPlaybackState(');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\nfunction pollExternalPlayback', at));

  // 暂停要连续两拍才算
  assert.match(body, /state\.pausedStreak = \(Number\(state\.pausedStreak\) \|\| 0\) \+ 1;/);
  assert.match(body, /state\.isPlaying = state\.pausedStreak >= 2;/,
    '单拍 isPlaying:false 直接照收会让时钟冻结');

  // itemId 分支里不许动时钟
  const itemBranch = body.slice(body.indexOf('if (itemId && state.durationItemId !== itemId)'));
  const itemBranchEnd = itemBranch.indexOf('} else if (!state.durationItemId');
  assert.ok(!/clockSeconds\s*=\s*-1/.test(itemBranch.slice(0, itemBranchEnd)),
    'itemId 抖动时重置时钟会让歌词倒退');

  // 真换曲按 catalogId 判定，并允许立刻重锚
  assert.match(body, /var polledCatalog = String\(data\.catalogId \|\| ''\);/);
  assert.match(body, /polledCatalog !== String\(state\.catalogId\)/);
  const catalogBlock = body.slice(body.indexOf('if (polledCatalog && state.catalogId'));
  assert.match(catalogBlock.slice(0, 260), /state\.clockSeconds = -1;/, '真换曲必须立刻重锚');
});
