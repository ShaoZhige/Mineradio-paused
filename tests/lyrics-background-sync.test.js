'use strict';

// 歌词「缓存」与「渲染」解耦的回归测试。
// 最小化 / 进托盘时 Chromium 会挂起 requestAnimationFrame，主循环随之停摆 —— 渲染停下是对的，
// 但「现在唱到第几句、这一句走到哪儿」属于缓存，必须继续推进，否则回到前台时歌词还停在切走
// 之前那一首。这里既验纯计算，也验四段接线：
//   1. 06-lyrics 里的运行时缓存由 audio 事件 + 250ms 心跳推进（与可见性无关）；
//   2. 10-shell 的桌面歌词优先读这份缓存；
//   3. 11-main-loop 回到前台时调用 resumeLyricsAfterBackground；
//   4. 02-visual 提供 clearStaleStageLyricWarmup，清掉后台期间挂在 rAF 上的过期预热。
//
// Regression for decoupling the lyric cache from rendering. Chromium suspends rAF for hidden
// windows and the main loop stalls with it — painting stopping is correct, but the "which line,
// how far in" cache has to keep advancing or the restore lands on the previous track. Pure
// computation plus the four wiring points are asserted here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const LYRICS = read('public/js/modules/06-lyrics/00-lyrics-fetch-parse.js');
const SHELL = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
const LOOP = read('public/js/modules/11-main-loop.js');
const STAGE = read('public/js/modules/02-visual/14-stage-lyrics-rendering.js');
const POWER = read('public/js/modules/00-state/08-desktop-render-power.js');
const ACTIONS = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');

function section(text, name) {
  const start = text.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, '缺少函数 ' + name);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error('花括号不配对: ' + name);
}

function buildCompute() {
  const context = vm.createContext({
    // 线性进度：第 0.5 秒的 3 秒行 = 0.1667，够用且不依赖渲染代码。
    getLyricLineProgress: (line, next, t) => {
      const start = Number(line && line.t) || 0;
      const span = Math.max(0.75, (Number(next && next.t) || start + Number(line && line.duration) || 3) - start);
      return Math.max(0, Math.min(1, (Number(t) - start) / span));
    },
  });
  vm.runInContext(section(LYRICS, 'computeLyricRuntimeState'), context, { filename: 'computeLyricRuntimeState' });
  return (lines, seconds, playing, fallback) => vm.runInContext(
    'computeLyricRuntimeState(__lines, __seconds, __playing, __fallback)',
    Object.assign(context, { __lines: lines, __seconds: seconds, __playing: playing, __fallback: fallback })
  );
}

const compute = buildCompute();
const LINES = [
  { t: 0, text: 'L0', duration: 3 },
  { t: 3, text: 'L1', duration: 3 },
  { t: 6, text: 'L2', duration: 4 },
];

test('缓存按播放时间选中当前句，并给出句内进度与跨度', () => {
  assert.deepEqual(
    [compute(LINES, 0.5, true, 'FB').index, compute(LINES, 0.5, true, 'FB').text],
    [0, 'L0'],
    '半秒时应该在第一句'
  );
  const second = compute(LINES, 3.2, true, 'FB');
  assert.equal(second.index, 1);
  assert.equal(second.text, 'L1');
  assert.equal(second.span, 3, '跨度应取下一句的起点差');
  assert.ok(second.progress > 0 && second.progress < 0.2, '3.2s 应刚进入第二句');
  const third = compute(LINES, 8.5, true, 'FB');
  assert.equal(third.index, 2);
  assert.equal(third.span, 4, '最后一句的跨度用自身 duration');
  assert.ok(third.progress > 0.5, '8.5s 应走到最后一句的后半段');
});

test('第一句之前给标题兜底，空歌词也不会崩', () => {
  const intro = compute([{ t: 4, text: 'X', duration: 3 }], 1.2, true, 'INTRO');
  assert.equal(intro.index, -1, '首句之前没有当前句');
  assert.equal(intro.text, 'INTRO', '首句之前用 fallback 文案（歌名）');
  const empty = compute([], 12, true, 'ONLY');
  assert.equal(empty.text, 'ONLY');
  assert.equal(empty.index, -1);
});

test('暂停时保留上一句但进度归零（不倒退到别的句子）', () => {
  const paused = compute(LINES, 3.2, false, 'FB');
  assert.equal(paused.index, 1);
  assert.equal(paused.text, 'L1');
  assert.equal(paused.progress, 0);
});

test('缓存由音频事件与 250ms 心跳推进，且能停止（不留下悬空定时器）', () => {
  assert.match(LYRICS, /function startLyricRuntimeSync\(\)/, '缺少运行时缓存的心跳启动函数');
  assert.match(LYRICS, /\['timeupdate', 'seeked', 'play', 'pause', 'ended', 'loadedmetadata', 'emptied'\]/, '缓存必须挂到 audio 自身的事件上');
  assert.match(LYRICS, /\}, 250\);/, '心跳间隔应为 250ms：后台会被节流但不该停');
  assert.match(LYRICS, /function stopLyricRuntimeSync\(\)/, '缺少停表函数');
  assert.match(section(LYRICS, 'stopLyricRuntimeSync'), /clearInterval\(/, '停表必须真的 clearInterval');
  assert.match(LYRICS, /function syncLyricRuntimeState\(/, '缺少缓存刷新函数');
  assert.match(section(LYRICS, 'syncLyricRuntimeState'), /getAdjustedLyricPlaybackTime/, '缓存必须用与渲染一致的时间轴');
});

test('桌面歌词优先读缓存，渲染停摆时也不会停在上一首', () => {
  const snapshot = section(SHELL, 'currentDesktopLyricSnapshot');
  assert.match(snapshot, /lyricRuntimeSnapshot\(/, '桌面歌词快照必须先读运行时缓存');
  const cacheRead = snapshot.indexOf('lyricRuntimeSnapshot(');
  const legacyCompute = snapshot.indexOf('getAdjustedLyricPlaybackTime');
  assert.ok(cacheRead >= 0 && cacheRead < legacyCompute, '缓存读取必须排在旧的现算逻辑前面');
  assert.match(SHELL, /function pushDesktopLyricsState\(/, '桌面歌词推送函数不见了');
});

test('切歌时立刻刷新缓存，不等下一帧', () => {
  assert.match(ACTIONS, /syncLyricRuntimeState\('lyrics-applied'\)/, '歌词应用后没有立刻刷新缓存');
  assert.match(section(LYRICS, 'resetLyricsForTrackSwitch'), /syncLyricRuntimeState\('track-switch-reset'\)/, '切歌重置时没有把缓存指向新歌');
});

test('回到前台时清掉后台挂死的预热，并把缓存对齐当前时间', () => {
  assert.match(LOOP, /resumeLyricsAfterBackground\('visibilitychange'\)/, 'visibilitychange 没有触发歌词恢复');
  assert.match(LOOP, /resumeLyricsAfterBackground\('focus'\)/, 'focus 没有触发歌词恢复');
  const resume = section(LYRICS, 'resumeLyricsAfterBackground');
  assert.match(resume, /syncLyricRuntimeState\(/, '恢复时必须先对齐缓存');
  assert.match(resume, /clearStaleStageLyricWarmup/, '恢复时必须清掉挂死的预热');
  const clear = section(STAGE, 'clearStaleStageLyricWarmup');
  assert.match(clear, /cancelAnimationFrame\(stageLyricPrewarm\.workRaf\)/, '必须取消挂在 rAF 上的预热');
  assert.match(clear, /stageLyricPrewarm\.workRaf = 0/, '取消后必须把句柄清零，否则预热永远算「未完成」');
  assert.match(clear, /clearStageLyricWarmup\(\)/, '必须清掉预热窗口');
  assert.match(clear, /currentPayload = null/, '必须让下一帧重建当前句');
});

test('页面已隐藏但原生状态滞后时也按后台处理', () => {
  // 实测：QA 隐藏窗口里 document.hidden=true，而 desktopRuntimeState 仍写着 visible=true，
  // 于是主循环挂着等一个永远不会来的 rAF，连后台兜底节奏都进不去。
  // Measured: with the window hidden, document.hidden is true while desktopRuntimeState still
  // says visible — the loop then waits on a rAF that never comes.
  const deep = section(POWER, 'isDeepBackgroundMode');
  assert.match(deep, /desktopRuntimeState\.minimized \|\| desktopRuntimeState\.visible === false \|\| document\.hidden/, '原生状态分支必须同时看 document.hidden');
  assert.match(deep, /return !!document\.hidden;/, '非桌面分支仍走 Page Visibility API');
});
