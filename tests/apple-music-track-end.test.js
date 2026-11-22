'use strict';

// AM 播完之后必须自己往下走：切歌 / 单曲循环 / 列表循环都不许"停住"。
// 这条链路有三个历史坑：位置归零导致判不到结束、只调 nextTrack 忽略单曲循环、
// 结束分支前有副作用抛错把切歌吞掉。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/08-account/tribute-to-steve-jobs.js'), 'utf8');

// 实现已收进 TributeToSteveJobs 的闭包，函数都带缩进：切片必须容忍前导空白。
// The implementation lives inside the part's closure now, so slices must ignore indentation.
function block(from, to) {
  const start = SRC.indexOf(from);
  assert.ok(start > 0, '找不到 ' + from);
  const rest = SRC.indexOf(to.replace(/^\s+/, ''), start + from.length);
  return SRC.slice(start, rest < 0 ? SRC.length : rest);
}

test('播完判定用原始 isPlaying，并记住最远位置（MusicKit 会把位置归零）', () => {
  const body = block('function applyExternalPlaybackState(', '\nfunction finishExternalTrack(');
  assert.match(body, /state\.maxPositionMs = Math\.max\(Number\(state\.maxPositionMs\) \|\| 0, state\.positionMs\);/);
  assert.match(body, /Number\(state\.maxPositionMs\) >= state\.durationMs - 2500/, '位置归零后要靠最远位置认出播完');
  assert.match(body, /state\.ended = data\.isPlaying !== true && reachedEnd;/,
    '结束判定要用原始 isPlaying：平滑后的值会晚一拍，错过归零那一刻');
  assert.ok(!/state\.ended = !state\.isPlaying &&/.test(body), '不能再用平滑后的 isPlaying');
});

test('结束分支前的界面更新不许拦住切歌', () => {
  const body = block('function applyExternalPlaybackState(', '\nfunction finishExternalTrack(');
  const endedAt = body.indexOf('if (state.ended && !state.endHandled)');
  const before = body.slice(0, endedAt);
  assert.match(before, /try \{ if \(typeof setPlayIcon === 'function'\) setPlayIcon\(state\.isPlaying\); \} catch/);
  assert.match(before, /try \{ if \(typeof updatePlaybackProgressUi === 'function'\) updatePlaybackProgressUi\(\); \} catch/);
  assert.match(before, /try \{ if \(typeof syncMediaSession === 'function'\) syncMediaSession\(false\); \} catch/);
});

test('收尾和本地播放一致：上报会话 → 单曲循环 → 下一首', () => {
  const body = block('function finishExternalTrack(', '\nfunction scheduleExternalEndBackstop(');
  assert.match(body, /try \{ if \(typeof finalizeListenSession === 'function'\) finalizeListenSession\(true\); \} catch/,
    '上报失败不能拦住切歌');
  const singleAt = body.indexOf("playMode === 'single'");
  const nextAt = body.indexOf('nextTrack()');
  assert.ok(singleAt > 0, '必须处理单曲循环');
  assert.ok(nextAt > singleAt, '单曲循环优先于 nextTrack');
  assert.match(body, /playQueueAt\(currentIdx, \{ autoRepeat: true, suppressPlayFailureNotice: true \}\)/);
});

test('兜底时钟按曲目时长排一次，提前触发会自我重排', () => {
  const body = block('function scheduleExternalEndBackstop(', '\nfunction stopExternalPlaybackPolling(');
  assert.match(body, /state\.isPlaying && Number\(state\.positionMs\) < state\.durationMs - 4000/,
    '还没播到结尾就不许切歌');
  assert.match(body, /scheduleExternalEndBackstop\(token, state\.durationMs \/ 1000, state\.positionMs \/ 1000\);/,
    '时长/起点不准时要重排，而不是提前切');
  assert.match(body, /state\.endHandled = true;[\s\S]{0,80}finishExternalTrack\(token\);/);
});

test('起播成功后挂上兜底时钟，换曲时清空最远位置', () => {
  assert.match(SRC, /scheduleExternalEndBackstop\(token, playbackDurationFromSong\(song\) \|\| \(startSec \+ 240\), startSec\);/,
    '起播必须排兜底时钟');
  assert.match(SRC, /state\.maxPositionMs = state\.positionMs;[\s\S]{0,40}\}/,
    '换曲要把上一首的最远位置清掉，否则一开播就判成播完');
});

// 2026-11-22 事故：在 AM 里按下暂停后，MR 的播放图标和进度条**一直往前走**，
// 而 apple-music.log 里 `playbackStatus` 轮询在暂停后 33 秒一条都没有 —— 心跳断了，
// 但界面还在用旧的 isPlaying 假装播放。修法是三道闸，任何一道都不许被删掉：
//   1. 单次轮询占住 busy 太久要解闸（am-poll-unwedge），不能永远卡住；
//   2. 心跳没了要重建（poll 里发现 timer 为 0 就重新起定时器）；
//   3. 状态过期（6s 没刷新）时冻住时钟并翻回暂停图标（am-poll-stale）。
test('心跳卡死时界面不许继续假装播放', () => {
  const poll = block('async function pollExternalPlayback(', '\nfunction startExternalPlaybackPolling(');
  assert.match(poll, /if \(!externalPlaybackPollTimer\) startExternalPlaybackPolling\(\)/,
    '心跳丢了要重建定时器');
  assert.match(poll, /EXTERNAL_PLAYBACK_POLL_WATCHDOG_MS/, '必须有 busy 看门狗');
  assert.match(poll, /am-poll-unwedge/, '解闸要留日志，否则下次还是查不出所以然');
  assert.match(poll, /externalPlaybackPollBusySince = 0;/, 'finally 里必须清掉 busy 起点');

  const clock = block('function externalPlaybackCurrentSeconds(', '\n  var clock = externalPlaybackClock(state, now);');
  assert.match(clock, /externalPlaybackStateIsStale\(state, now\)/, '状态过期判定必须参与时钟计算');
  assert.match(clock, /state\.isPlaying = false;/);
  assert.match(clock, /am-poll-stale/, '冻结要留日志');
  assert.match(clock, /setPlayIcon\(false\)/, '过期时图标必须翻回暂停');
});

// 2026-11-22 事故二：暂停后按播放不放。日志里每次点击发出去的都是 `pause` —— 因为
// MusicKit 的 isPlaying 滞后，轮询把刚按下的暂停又翻回"正在播"，于是下一次点击继续暂停。
// 命令发出后的一小段时间内，与命令矛盾的采样不许采信。
test('刚按过暂停/播放时，滞后的采样不许把状态翻回去', () => {
  const apply = block('function applyExternalPlaybackState(', '\n  state.positionMs = Math.max');
  assert.match(apply, /EXTERNAL_COMMAND_GRACE_MS/, '必须用命令宽限期');
  assert.match(apply, /if \(samplePlaying !== commandedPlaying\) samplePlaying = commandedPlaying;/,
    '矛盾采样要被命令覆盖');
  assert.ok(/state\.isPlaying = state\.pausedStreak >= 2;/.test(apply), '暂停仍然要两拍确认');

  const toggle = block('async function toggleExternalAppleMusicPlayback(', '\nasync function seekExternalAppleMusic(');
  assert.match(toggle, /var operation = state\.isPlaying \? 'pause' : 'resume';/);
  assert.match(toggle, /state\.commandAt = Date\.now\(\);/, '必须记下命令时刻');
  assert.match(toggle, /state\.commandPlaying = state\.isPlaying;/, '必须记下命令方向');
});

// 2026-11-22 事故三：重载窗口后按播放弹「播放启动失败」。
// 队列快照的字段白名单里没有 `catalogId`，恢复出来的资料库歌曲只剩 `id: a.<数字>`，
// 于是被判成"没有 catalog id"。三处都必须能兜住这种行。
test('队列快照必须保留 Apple 的 catalogId，且 a.<数字> 不能被当成不可播', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const snapshotSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/05-playback/09-queue-snapshot-autoplay.js'), 'utf8');
  const whitelist = snapshotSrc.slice(
    snapshotSrc.indexOf('function playbackRestoreSongSnapshot('),
    snapshotSrc.indexOf('].forEach(function (key) {'));
  assert.match(whitelist, /'catalogId'/, '快照必须存 catalogId，否则重载后 AM 歌无法播放');
  assert.ok(/'appleMusicId'/.test(whitelist) && /'providerSongId'/.test(whitelist));
  assert.ok(snapshotSrc.includes('^a\\.'), 'a.<数字> 是资料库歌曲，不能当不可播丢掉');

  const playSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/08-account/tribute-to-steve-jobs.js'), 'utf8');
  const at = playSrc.indexOf('async function startExternalAppleMusicPlayback(');
  const body = playSrc.slice(at, playSrc.indexOf('stopExternalPlaybackPolling();', at));
  assert.ok(body.includes('appleMusicCatalogIdOf('), '起播前必须走统一的 id 归一化');
});

// id 归一化只允许有一个入口（00-state/16-provider-registry.js）。三套命名空间混用是
// 今晚四类 bug（歌单丢空、重载后不能播、歌词消失、快照还原失败）的共同根因。
test('appleMusicCatalogIdOf 是唯一入口，三套 id 都按预期归一', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/00-state/16-provider-registry.js'), 'utf8');
  const start = src.indexOf('function appleMusicCatalogIdOf(');
  assert.ok(start > 0, '缺少 appleMusicCatalogIdOf');
  const end = src.indexOf('\n}', start) + 2;
  const sandbox = {};
  vm.runInNewContext(src.slice(start, end) + '\nthis.pick = appleMusicCatalogIdOf;', sandbox);

  assert.equal(sandbox.pick({ catalogId: '6825256856' }), '6825256856', '纯数字直接用');
  assert.equal(sandbox.pick({ id: 'a.6825256856' }), '6825256856', 'a.<数字> 取数字部分');
  assert.equal(sandbox.pick({ id: 'a.6825256856', catalogId: '' }), '6825256856');
  assert.equal(sandbox.pick({ id: 'a.abc' }), '', '艺人条目不能当 catalog id');
  assert.equal(sandbox.pick({ id: 'i.xyz' }), '', 'i. 需要 resolveSong，不在这里猜');
  assert.equal(sandbox.pick(null), '');

  const lyric = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/06-lyrics/00-lyrics-fetch-parse.js'), 'utf8');
  assert.ok(lyric.includes('appleMusicCatalogIdOf('), '歌词接口也必须走同一个入口');
});

// P2：错误分类只有一张表。AM 今晚连着出过"宿主超时被当成用户退出登录"这种事，
// 根因就是同一个码在几个文件里各翻译一遍。
test('AM 错误码只有一张表，且只有 auth 算登出', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/08-account/tribute-to-steve-jobs.js'), 'utf8');
  const at = src.indexOf('var APPLE_MUSIC_ERROR_INFO = {');
  assert.ok(at > 0, '缺少错误分类表');
  const tableEnd = src.indexOf('};', at) + 2;
  const start = src.indexOf('function appleMusicErrorInfo(', tableEnd);
  assert.ok(start > tableEnd, '缺少 appleMusicErrorInfo');
  const end = src.indexOf('\n    }', start) + 6;
  const sandbox = {};
  vm.runInNewContext(
    src.slice(at, tableEnd) + '\n' + src.slice(start, end) + '\nthis.info = appleMusicErrorInfo;',
    sandbox);

  assert.equal(sandbox.info('auth-required').signedOut, true, '只有 Apple 明说没登录才算登出');
  for (const code of ['timeout', 'playback-timeout', 'disconnected', 'runtime-unavailable', 'busy', 'request-failed', 'storefront-unavailable']) {
    assert.equal(sandbox.info(code).signedOut, false, code + ' 绝不能算登出');
    assert.equal(sandbox.info(code).kind, 'transport', code + ' 属于传输层');
  }
  assert.equal(sandbox.info('playback-failed').kind, 'unplayable');
  assert.equal(sandbox.info('no-catalog-id').kind, 'unplayable');
  assert.equal(sandbox.info('something-new').kind, 'transport', '未知码按传输层处理，不登出');

  // 渲染层不许再自己维护一份码表。
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/08-account/03-login-modal-flows.js'), 'utf8');
  assert.ok(!/APPLE_MUSIC_TRANSPORT_ERRORS\s*=\s*\[/.test(renderer), '渲染层不要再抄一份错误码清单');
  assert.ok(renderer.includes('appleMusicErrorInfo('), '渲染层必须问那张表');
});

// P3/P4：宿主操作按读/写分层；AM 可以被指定为默认源（但 directFallback 必须保持 false）。
test('宿主操作分层 + AM 可作默认源', () => {
  const { operationKind, HOST_OPERATIONS, READ_OPERATIONS } = require('../desktop/apple-music/companionRequests.cjs');
  assert.equal(operationKind('playSong'), 'command');
  assert.equal(operationKind('lyrics'), 'read');
  assert.equal(operationKind('warm'), 'host');
  assert.ok(HOST_OPERATIONS.has('showWindow') && READ_OPERATIONS.has('playlistTracks'));

  const fs = require('node:fs');
  const path = require('node:path');
  const registry = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/00-state/16-provider-registry.js'), 'utf8');
  const amRow = registry.slice(registry.indexOf("key: 'applemusic'"), registry.indexOf("key: 'applemusic'") + 1600);
  assert.match(amRow, /preferred: true/, 'AM 必须能出现在「默认源」下拉里');
  assert.match(amRow, /directFallback: false/, '但没有直接音频地址，自动换源候选必须排除它');
});
