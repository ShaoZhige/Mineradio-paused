'use strict';

// 网易云云盘歌曲歌词兜底回归测试（#457）
//
// 云盘上传的音频不是官方曲库条目，按云盘歌曲 id 查歌词只会拿到空结果。兜底逻辑用「歌名 + 歌手」
// 搜索候选，要求候选通过 sourceCandidateRejectReason 与 isSameTitleArtist 双重校验后，再用候选 id
// 取歌词；且只在当前没有可用歌词时执行。这里在 vm 沙箱里执行真实函数，验证每条守卫。
//
// Netease cloud-disk uploads are not official catalog entries, so a lyric lookup by the cloud
// song id returns nothing. The rescue searches by title + artist, requires the candidate to pass
// both sourceCandidateRejectReason and isSameTitleArtist, then fetches the lyric with the
// candidate id — and only ever runs when no usable lyric exists. These assertions execute the
// real functions in a vm sandbox to cover every guard.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} is missing`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

const stateVars = source.match(
  /var lyricPrimaryFallbackCache = \{\};[\s\S]*?var LYRIC_PRIMARY_FALLBACK_TIMEOUT_MS = [^;]+;/
);
assert(stateVars, 'lyric primary fallback state variables are missing');

const scheduledTimers = [];
const lyricRequests = [];
const persistedPayloads = [];
let candidateRequest = 0;
let nextCandidate = null;
let nextLyricResponse = {};
let adoptedCalls = [];
let appliedCount = 0;
let currentSong = null;

const sandbox = {
  console: { info() {}, warn() {}, log() {} },
  Math,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Promise,
  encodeURIComponent,
  setTimeout(fn) {
    scheduledTimers.push(fn);
    return scheduledTimers.length;
  },
  clearTimeout() {},
  songProviderKey(song) {
    const raw = String((song && (song.source || song.provider || song.type)) || 'netease').toLowerCase();
    if (raw === 'cloud' || raw === 'song') return 'netease';
    return raw;
  },
  isSameTitleArtist(a, b) {
    const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
    if (!a || !b) return false;
    if (norm(a.name || a.title) !== norm(b.name || b.title)) return false;
    const parts = (s) => String(s.artist || '').split(/\s*[/,、&]\s*/).map(norm).filter(Boolean);
    const pa = parts(a);
    const pb = parts(b);
    if (!pa.length || !pb.length) return false;
    return pa.some((name) => pb.indexOf(name) >= 0);
  },
  isNoLyricText(text) {
    const compact = String(text || '').replace(/\s+/g, '');
    return !compact || compact === '暂无歌词';
  },
  simpleSearchNorm(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\s\-_()（）[\]【】]/g, '');
  },
  mergeInlineLyricResponseForSong(song, response) {
    return Object.assign({}, response || {});
  },
  parseLyricResponseToOriginalState(song, response) {
    const lines = String((response && response.lyric) || '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean)
      .map((text, index) => ({ t: index, text }));
    return {
      lines,
      hasNativeKaraoke: false,
      timingSource: lines.length ? 'lrc-line' : 'fallback',
      translationLines: [],
      translationSource: 'none',
      usableLyric: lines.length > 0,
      cachedAt: Date.now(),
    };
  },
  findNeteaseLyricFallbackCandidate: async () => {
    candidateRequest += 1;
    return nextCandidate;
  },
  apiJson: async (url) => {
    lyricRequests.push(url);
    return nextLyricResponse;
  },
  cancelPendingTrackFallbackLyrics() {},
  setOriginalLyricsState(...args) {
    adoptedCalls.push(args);
    sandbox.originalLyricsState = {
      lines: args[0] || [],
      hasNativeKaraoke: !!args[1],
      timingSource: args[2],
      translationLines: args[3] || [],
      translationSource: args[4],
    };
  },
  applyPreferredLyricsForCurrent() {
    appliedCount += 1;
  },
  writePersistentLyricCache(song, payload) {
    persistedPayloads.push(payload);
  },
  currentLyricSong: () => currentSong,
  originalLyricsState: { lines: [] },
  trackSwitchToken: 7,
  window: {},
};
vm.createContext(sandbox);
vm.runInContext(stateVars[0], sandbox);
[
  'hasUsableLyricLines',
  'lyricTranslationTextFromAliases',
  'lyricTranslationFallbackKey',
  'lyricPrimaryFallbackKey',
  'shouldFetchNeteasePrimaryLyricFallback',
  'adoptNeteasePrimaryLyricFallback',
  'fetchNeteasePrimaryLyricFallback',
  'scheduleNeteasePrimaryLyricFallback',
].forEach((name) => {
  // 原文件里的 async 声明要在抽取时补回来，否则 await 会被判为语法错误。
  // The `async` keyword sits before `function`, so it has to be re-attached on extraction.
  const prefix = source.includes(`async function ${name}(`) ? 'async ' : '';
  vm.runInContext(prefix + extractFunction(name), sandbox);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function drainTimers() {
  while (scheduledTimers.length) {
    const timer = scheduledTimers.shift();
    timer();
    await flush();
  }
  await flush();
}
function reset() {
  sandbox.lyricPrimaryFallbackCache = {};
  sandbox.lyricPrimaryFallbackMissCache = {};
  sandbox.lyricPrimaryFallbackPending = {};
  sandbox.originalLyricsState = { lines: [] };
  sandbox.trackSwitchToken = 7;
  scheduledTimers.length = 0;
  lyricRequests.length = 0;
  persistedPayloads.length = 0;
  adoptedCalls = [];
  appliedCount = 0;
  candidateRequest = 0;
  nextCandidate = null;
  nextLyricResponse = {};
}

function cloudSong(overrides) {
  return Object.assign({ id: '1900000001', name: '云盘里的歌', artist: '歌手甲', source: 'netease' }, overrides || {});
}
function emptyState() {
  return sandbox.parseLyricResponseToOriginalState(cloudSong(), {});
}

(async function run() {
  // 1. 云盘歌曲（netease）拿到空歌词时会触发兜底。
  reset();
  currentSong = cloudSong();
  assert.strictEqual(
    sandbox.shouldFetchNeteasePrimaryLyricFallback(currentSong, emptyState()),
    true,
    'a netease track without any lyric must trigger the same title/artist rescue'
  );

  // 2. 已经有可用歌词时不触发，兜底只负责"从无到有"。
  assert.strictEqual(
    sandbox.shouldFetchNeteasePrimaryLyricFallback(currentSong, {
      lines: [{ t: 0, text: '真的歌词' }],
      usableLyric: true,
    }),
    false,
    'an existing usable lyric must suppress the rescue'
  );

  // 3. 非网易云来源不触发。
  assert.strictEqual(
    sandbox.shouldFetchNeteasePrimaryLyricFallback(cloudSong({ source: 'qq' }), emptyState()),
    false,
    'other providers keep their own lyric pipeline'
  );
  // 4. 本地文件与播客不触发（本地歌词走内嵌/同名 lrc 通道）。
  assert.strictEqual(
    sandbox.shouldFetchNeteasePrimaryLyricFallback(cloudSong({ source: 'local', localUrl: 'http://x' }), emptyState()),
    false,
    'local tracks must never be matched against the netease catalog'
  );
  assert.strictEqual(
    sandbox.shouldFetchNeteasePrimaryLyricFallback(cloudSong({ type: 'podcast' }), emptyState()),
    false,
    'podcast episodes must never be matched against the netease catalog'
  );
  // 5. 没有歌名的曲目无从搜索，不触发。
  assert.strictEqual(
    sandbox.shouldFetchNeteasePrimaryLyricFallback(cloudSong({ name: '', title: '' }), emptyState()),
    false,
    'a track without a title cannot be searched'
  );

  // 6. 完整的兜底链路：搜索 -> 校验 -> 取歌词 -> 替换状态 -> 写持久缓存。
  reset();
  currentSong = cloudSong();
  nextCandidate = { id: '2000000002', name: '云盘里的歌', artist: '歌手甲' };
  nextLyricResponse = { lyric: '[00:00.00]第一行\n[00:03.00]第二行', source: 'lyric' };
  sandbox.scheduleNeteasePrimaryLyricFallback(currentSong, 7, emptyState());
  assert.strictEqual(scheduledTimers.length, 1, 'the rescue is deferred so it cannot race the track switch');
  await drainTimers();
  assert.strictEqual(candidateRequest, 1, 'the rescue searches the netease catalog exactly once');
  assert.deepStrictEqual(
    lyricRequests,
    ['/api/lyric?id=2000000002'],
    'the lyric is fetched with the matched official id, not the cloud id'
  );
  assert.strictEqual(adoptedCalls.length, 1, 'the rescued lyric replaces the empty state');
  assert.strictEqual(adoptedCalls[0][0].length, 2, 'both rescued lines reach the lyric state');
  assert.strictEqual(appliedCount, 1, 'the rescued state is pushed to the renderer');
  assert.strictEqual(persistedPayloads.length, 1, 'the rescued lyric is cached for the next playback');
  assert.strictEqual(
    sandbox.lyricPrimaryFallbackKey(currentSong),
    'netease|1900000001|云盘里的歌|歌手甲|',
    'the rescue cache is keyed per track so two cloud uploads never share lyrics'
  );

  // 7. 第二次播放直接命中内存缓存，不再搜索。
  reset();
  currentSong = cloudSong();
  nextCandidate = { id: '2000000002', name: '云盘里的歌', artist: '歌手甲' };
  nextLyricResponse = { lyric: '[00:00.00]第一行' };
  await sandbox.fetchNeteasePrimaryLyricFallback(currentSong, 7, sandbox.lyricPrimaryFallbackKey(currentSong));
  assert.strictEqual(candidateRequest, 1, 'first playback performs the search');
  reset();
  currentSong = cloudSong();
  sandbox.lyricPrimaryFallbackCache[sandbox.lyricPrimaryFallbackKey(currentSong)] = { lyric: '[00:00.00]第一行' };
  sandbox.scheduleNeteasePrimaryLyricFallback(currentSong, 7, emptyState());
  await drainTimers();
  assert.strictEqual(candidateRequest, 0, 'a warm cache skips the catalog search entirely');
  assert.strictEqual(adoptedCalls.length, 1, 'the warm cache still restores the rescued lyric');

  // 8. 候选不是"同名同歌手"时拒绝采信，宁可保持无歌词。
  reset();
  currentSong = cloudSong();
  nextCandidate = { id: '3000000003', name: '云盘里的歌', artist: '完全不同的歌手' };
  nextLyricResponse = { lyric: '[00:00.00]别人的歌词' };
  await sandbox.fetchNeteasePrimaryLyricFallback(currentSong, 7, sandbox.lyricPrimaryFallbackKey(currentSong));
  assert.strictEqual(adoptedCalls.length, 0, 'a same-title cover by another artist must not be adopted');
  assert.strictEqual(lyricRequests.length, 0, 'a rejected candidate must not even be queried for lyrics');
  assert.strictEqual(
    sandbox.shouldFetchNeteasePrimaryLyricFallback(currentSong, emptyState()),
    false,
    'a rejected lookup is remembered so it is not retried on every frame'
  );

  // 9. 候选没有歌词时同样不采信，并记住这次未命中。
  reset();
  currentSong = cloudSong();
  nextCandidate = { id: '2000000002', name: '云盘里的歌', artist: '歌手甲' };
  nextLyricResponse = { lyric: '' };
  await sandbox.fetchNeteasePrimaryLyricFallback(currentSong, 7, sandbox.lyricPrimaryFallbackKey(currentSong));
  assert.strictEqual(adoptedCalls.length, 0, 'an empty candidate lyric leaves the placeholder in place');
  assert.strictEqual(
    sandbox.shouldFetchNeteasePrimaryLyricFallback(currentSong, emptyState()),
    false,
    'the miss is cached to avoid hammering the search endpoint'
  );

  // 10. 搜索抛错不影响播放，且进入未命中缓存。
  reset();
  currentSong = cloudSong();
  sandbox.findNeteaseLyricFallbackCandidate = async () => {
    throw new Error('search offline');
  };
  const rescued = await sandbox.fetchNeteasePrimaryLyricFallback(
    currentSong,
    7,
    sandbox.lyricPrimaryFallbackKey(currentSong)
  );
  assert.strictEqual(rescued, false, 'a failed search resolves to false instead of rejecting');
  assert.strictEqual(adoptedCalls.length, 0, 'no state change happens after a failed search');

  // 11. 切歌后迟到的兜底结果不得落到新歌上。
  reset();
  currentSong = cloudSong();
  nextCandidate = { id: '2000000002', name: '云盘里的歌', artist: '歌手甲' };
  nextLyricResponse = { lyric: '[00:00.00]第一行' };
  sandbox.trackSwitchToken = 7;
  const pending = sandbox.fetchNeteasePrimaryLyricFallback(currentSong, 7, sandbox.lyricPrimaryFallbackKey(currentSong));
  sandbox.trackSwitchToken = 8;
  await pending;
  assert.strictEqual(adoptedCalls.length, 0, 'a stale rescue must not overwrite the newly selected track');

  // 12. 已经拿到歌词后，迟到的兜底结果不得覆盖。
  reset();
  currentSong = cloudSong();
  sandbox.originalLyricsState = { lines: [{ t: 0, text: '用户先拿到了歌词' }] };
  const overwritten = sandbox.adoptNeteasePrimaryLyricFallback(
    currentSong,
    { lyric: '[00:00.00]兜底的歌词' },
    7,
    sandbox.lyricPrimaryFallbackKey(currentSong)
  );
  assert.strictEqual(overwritten, false, 'usable lyrics are never replaced by the rescue');

  // 13. 源码接线：兜底必须挂在 fetch 唯一出口上，且带齐守卫。
  const fetchBlock = source.slice(
    source.indexOf('function applyFetchedLyricResponse('),
    source.indexOf('function refreshPersistentLyricCache(')
  );
  assert(
    /scheduleNeteasePrimaryLyricFallback\(song, token, state\);/.test(fetchBlock),
    'the rescue must be scheduled from applyFetchedLyricResponse so cached and fresh responses both get it'
  );
  const rescueBlock = source.slice(
    source.indexOf('var lyricPrimaryFallbackCache = {};'),
    source.indexOf('function lyricFallbackTextForSong(')
  );
  assert(/if \(state\.usableLyric\) return false;/.test(rescueBlock), 'the rescue must refuse to run when a lyric exists');
  assert(/songProviderKey\(song\) !== 'netease'/.test(rescueBlock), 'the rescue is netease-only');
  assert(/sourceCandidateRejectReason|findNeteaseLyricFallbackCandidate/.test(rescueBlock), 'candidates reuse the shared reject-reason guard');
  assert(/isSameTitleArtist\(song, candidate\)/.test(rescueBlock), 'a candidate must be the same title and artist before adoption');
  assert(/writePersistentLyricCache\(song, merged\)/.test(rescueBlock), 'the rescued lyric is persisted so repeat playback is instant');
  assert(!/lyric_new/.test(rescueBlock), 'the rescue must not re-implement upstream lyric endpoints');

  console.log('netease cloud lyric fallback: 13 checks passed');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
