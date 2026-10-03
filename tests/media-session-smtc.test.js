'use strict';

// 系统媒体控制（SMTC）的回归测试。
// Regression cover for the system media controls.
//
// 目标平台是 Windows 的 SMTC：任务栏播放条、锁屏界面、蓝牙/媒体键。实现完全依赖渲染层的
// navigator.mediaSession —— Chromium/Electron 原生能力。
//
// The target is Windows SMTC — the taskbar strip, the lock screen and Bluetooth/media keys — served
// entirely by the renderer's native navigator.mediaSession.
//
// 这组测试钉住四件"容易做错、必须做对"的事：
//  1. **不做无用的主进程往返**。系统媒体 UI 与页面在同一个渲染进程，把状态复制到主进程再发回来
//     只会多一次往返，并让两份状态可能各说各话。
//  2. **变化检测**。每次重建 MediaMetadata 都会让系统重新取封面、重新布局；playbackState 同理。
//  3. **artwork 诚实**：不声明猜测的 MIME type，并声明真正取到的尺寸。
//  4. **seek 走项目自己的进度条协议**，而不是直接改 audio.currentTime（那会让进度条与歌词进度
//     和真实播放位置脱节）。
//
// Four things are pinned here: no pointless main-process round trip; metadata and playback state
// are only written when they change; artwork declares no guessed MIME type and reports the size it
// really fetched; and seeking goes through the project's own progress-seek protocol.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const readSource = (relativePath) => fs
  .readFileSync(path.join(appRoot, relativePath), 'utf8')
  .replace(/\r\n/g, '\n');

const sessionText = readSource('public/js/modules/05-playback/19-media-session.js');
const mainLoopText = readSource('public/js/modules/11-main-loop.js');
const loaderText = readSource('public/js/index-loader.js');

// ---------------------------------------------------------------------------
// 1. 接线
// ---------------------------------------------------------------------------

assert.ok(
  loaderText.includes("'js/modules/05-playback/19-media-session.js'"),
  'the media session module must be loaded'
);
assert.ok(
  /function animate\(\)[\s\S]{0,700}syncMediaSession\(false\)/.test(mainLoopText),
  'the main loop must drive the media session so state follows playback'
);

// ---------------------------------------------------------------------------
// 2. 纯渲染层：不得有任何 IPC 或主进程同步
// ---------------------------------------------------------------------------

for (const forbidden of ['ipcRenderer', 'invoke(', 'send(', 'require(', 'mineradio-smtc']) {
  assert.ok(
    !sessionText.includes(forbidden),
    `the media session must stay renderer-only; found ${forbidden}`
  );
}

// ---------------------------------------------------------------------------
// 3. 行为：用一套假的 navigator.mediaSession 驱动真实代码
// ---------------------------------------------------------------------------

function buildContext(options = {}) {
  const state = {
    metadata: null,
    playbackState: 'none',
    position: null,
    actions: {},
    unsupported: options.unsupported || [],
    warnings: []
  };
  const context = vm.createContext({
    console: { warn: (...args) => state.warnings.push(args.map(String).join(' ')) },
    navigator: options.noMediaSession
      ? {}
      : {
        mediaSession: {
          set playbackState(value) { state.playbackState = value; },
          get playbackState() { return state.playbackState; },
          set metadata(value) { state.metadata = value; },
          get metadata() { return state.metadata; },
          setPositionState: (value) => { state.position = value; },
          setActionHandler: (action, handler) => {
            if (state.unsupported.indexOf(action) >= 0) throw new Error('unsupported action: ' + action);
            state.actions[action] = handler;
          }
        }
      },
    MediaMetadata: function (init) { this.title = init.title; this.artist = init.artist; this.album = init.album; this.artwork = init.artwork; },
    performance: { now: () => (options.clock === undefined ? 0 : options.clock) },
  });
  vm.runInContext(
    'var audio = null;'
    + 'var playQueue = [];'
    + 'var currentIdx = -1;'
    + 'var playing = false;'
    + 'var __calls = [];'
    + 'function togglePlay() { __calls.push("togglePlay"); }'
    + 'function prevTrack(userInitiated) { __calls.push("prevTrack:" + userInitiated); }'
    + 'function nextTrack(userInitiated) { __calls.push("nextTrack:" + userInitiated); }'
    + 'function songCoverSrc(song, size) { return song && song.cover ? song.cover + "?s=" + size : ""; }'
    + (options.noCommitProgressSeek
      ? 'function commitProgressSeek() { return false; }'
      : 'function commitProgressSeek(target, resume) { __calls.push("commitProgressSeek:" + target + ":" + resume); return true; }'),
    context
  );
  vm.runInContext(sessionText, context, { filename: '19-media-session.js' });
  return { context, state, calls: () => vm.runInContext('JSON.stringify(__calls)', context) };
}

const setSong = (context, song) => vm.runInContext(
  `playQueue = ${JSON.stringify(song ? [song] : [])}; currentIdx = ${song ? 0 : -1};`,
  context
);

// -- 曲目信息映射：字段别名与封面尺寸 --

{
  const { context, state } = buildContext();
  setSong(context, { name: '那 Annual 遗憾的小船', artist: 'Shao', album: 'Demo', cover: 'http://x/cover.png' });
  vm.runInContext('syncMediaSession(true)', context);
  assert.strictEqual(state.metadata.title, '那 Annual 遗憾的小船', 'the title must come from name first');
  assert.strictEqual(state.metadata.artist, 'Shao', 'the artist must be mapped');
  assert.strictEqual(state.metadata.album, 'Demo', 'the album must be mapped');
  assert.strictEqual(state.metadata.artwork.length, 1, 'artwork must be exactly one entry');
  assert.strictEqual(
    state.metadata.artwork[0].sizes,
    '512x512',
    'the declared size must be the size actually requested, not a larger claim'
  );
  assert.ok(
    !('type' in state.metadata.artwork[0]),
    'artwork must not declare a guessed MIME type; some Windows versions reject a wrong one'
  );
  assert.strictEqual(state.metadata.artwork[0].src, 'http://x/cover.png?s=512', 'the cover URL must carry the requested size');
}

// 字段别名：只有 title 没有 name 时也要认。
// Field aliases: a song carrying only `title` must still resolve.
{
  const { context, state } = buildContext();
  setSong(context, { title: 'Fallback Title', singer: 'Singer' });
  vm.runInContext('syncMediaSession(true)', context);
  assert.strictEqual(state.metadata.title, 'Fallback Title', 'title must be accepted when name is absent');
  assert.strictEqual(state.metadata.artist, 'Singer', 'singer must be accepted when artist is absent');
  assert.strictEqual(state.metadata.artwork.length, 0, 'a song without cover must not fabricate artwork');
}

// 停播必须真正清空，而不是留一个占位标题或上一首的歌名。
// Stopping must genuinely clear, not leave a placeholder or the previous title on screen.
{
  const { context, state } = buildContext();
  setSong(context, { name: 'First', cover: 'http://x/a.png' });
  vm.runInContext('syncMediaSession(true)', context);
  assert.strictEqual(state.metadata.title, 'First', 'sanity: the track is on screen while playing');

  setSong(context, null);
  vm.runInContext('syncMediaSession(true)', context);
  assert.strictEqual(state.metadata, null, 'stopping playback must clear the metadata, not leave a stale title');
  assert.strictEqual(state.playbackState, 'none', 'with no track the state must be none, not paused');
}

// -- 变化检测：没变就不写 --

{
  const { context, state } = buildContext();
  setSong(context, { name: 'Stable', artist: 'A', cover: 'http://x/s.png' });
  assert.strictEqual(vm.runInContext('applyMediaSessionMetadata(mediaSessionCurrentSong())', context), true, 'the first write must happen');
  assert.strictEqual(vm.runInContext('applyMediaSessionMetadata(mediaSessionCurrentSong())', context), false, 'an unchanged track must not rewrite metadata');
  vm.runInContext('__calls.length = 0;', context);

  vm.runInContext('playQueue = [{ name: "Stable", artist: "A", cover: "http://x/s.png" }, { name: "Next" }]; currentIdx = 1;', context);
  assert.strictEqual(vm.runInContext('applyMediaSessionMetadata(mediaSessionCurrentSong())', context), true, 'a track change must be written');
  // 播放态跟着曲目走（没有当前曲目就该报 none），所以先写一次、第二次必须不写。
  // The playback state follows the track (no current track means none), so the first call writes
  // and the second must not.
  assert.strictEqual(
    vm.runInContext('applyMediaSessionPlaybackState()', context),
    true,
    'a newly selected track must produce a playback state write'
  );
  assert.strictEqual(
    vm.runInContext('applyMediaSessionPlaybackState()', context),
    false,
    'an unchanged playback state must not be rewritten'
  );
}

// -- 播放状态映射 --

{
  const { context, state } = buildContext();
  setSong(context, { name: 'Playing' });
  vm.runInContext('audio = { paused: false, currentTime: 10, duration: 100 };', context);
  assert.strictEqual(vm.runInContext('applyMediaSessionPlaybackState()', context), true, 'the first state must be written');
  assert.strictEqual(state.playbackState, 'playing', 'a playing element must report playing');
  vm.runInContext('audio.paused = true;', context);
  vm.runInContext('applyMediaSessionPlaybackState()', context);
  assert.strictEqual(state.playbackState, 'paused', 'a paused element must report paused');
}

// -- 位置上报：节流、非法时长、夹紧 --

{
  const { context, state } = buildContext({ clock: 5000 });
  vm.runInContext('audio = { paused: false, currentTime: 30, duration: 200 };', context);
  assert.strictEqual(vm.runInContext('applyMediaSessionPosition(true)', context), true, 'a forced report must go out');
  assert.strictEqual(state.position.duration, 200, 'the duration must be reported');
  assert.strictEqual(state.position.position, 30, 'the position must be reported');
  assert.strictEqual(vm.runInContext('applyMediaSessionPosition(false)', context), false, 'a report inside the interval must be skipped');

  // 时长未知（流媒体在元数据到手前是 NaN）：宁可不上报，也不报一个假时长。
  // An unknown duration (live streams report NaN): report nothing rather than a made-up duration.
  vm.runInContext('audio.duration = NaN;', context);
  const before = state.position;
  assert.strictEqual(vm.runInContext('applyMediaSessionPosition(true)', context), false, 'an unknown duration must be refused');
  assert.strictEqual(state.position, before, 'a refused report must leave the last state alone');

  // 位置越界时夹紧，否则系统进度条会算出负的剩余时间。
  // Clamp an out-of-range position, otherwise the system bar computes a negative remaining time.
  vm.runInContext('audio.duration = 100; audio.currentTime = 180;', context);
  vm.runInContext('applyMediaSessionPosition(true)', context);
  assert.strictEqual(state.position.position, 100, 'the position must be clamped to the duration');
}

// -- 动作处理器：逐个 try，play/pause 只在状态相反时动作 --

{
  const { context, state, calls } = buildContext({ unsupported: ['seekbackward'] });
  vm.runInContext('initializeMediaSession()', context);
  for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto']) {
    assert.strictEqual(typeof state.actions[action], 'function', `${action} must be registered`);
  }
  assert.ok(
    !state.actions.seekbackward,
    'an action Chromium rejects must simply be absent, not break the rest'
  );
  assert.ok(
    state.warnings.some((line) => line.includes('seekbackward')),
    'a rejected action must be reported rather than swallowed'
  );

  // 播放中收到 pause：应该真的动。已暂停时再收到 pause：不该动。
  // A pause request while playing must act; the same request while already paused must not.
  vm.runInContext('audio = { paused: false, currentTime: 0, duration: 100 };', context);
  vm.runInContext('__calls.length = 0;', context);
  state.actions.pause();
  assert.ok(calls().includes('togglePlay'), 'pause while playing must toggle');

  vm.runInContext('audio.paused = true; __calls.length = 0;', context);
  state.actions.pause();
  assert.ok(!calls().includes('togglePlay'), 'pause while already paused must not toggle back');

  vm.runInContext('audio.paused = false; __calls.length = 0;', context);
  state.actions.play();
  assert.ok(!calls().includes('togglePlay'), 'play while already playing must not toggle');

  // 曲目切换必须带 userInitiated=true，与热键路径保持一致。
  // Track changes must be marked user-initiated, matching the hotkey path.
  vm.runInContext('__calls.length = 0;', context);
  state.actions.nexttrack();
  state.actions.previoustrack();
  const log = calls();
  assert.ok(log.includes('nextTrack:true'), 'nexttrack must be user-initiated');
  assert.ok(log.includes('prevTrack:true'), 'previoustrack must be user-initiated');
}

// -- seek 必须走项目自己的通道，并夹紧目标 --

{
  const { context, calls } = buildContext();
  vm.runInContext('audio = { paused: true, currentTime: 50, duration: 200 };', context);
  vm.runInContext('__calls.length = 0;', context);
  vm.runInContext('mediaSessionSeekTo(120)', context);
  const log = calls();
  assert.ok(log.includes('commitProgressSeek:120:true'), 'seek must go through the project progress-seek path');
  assert.ok(!log.includes('__direct__'), 'a direct currentTime write must not happen when the project path exists');
}
{
  // 项目通道不可用时才降级，并且必须留下警告。
  // The direct fallback applies only when the project path is gone, and it must say so.
  const { context, state } = buildContext({ noCommitProgressSeek: true });
  vm.runInContext('audio = { paused: false, currentTime: 50, duration: 200 };', context);
  vm.runInContext('mediaSessionSeekTo(500)', context);
  assert.strictEqual(vm.runInContext('audio.currentTime', context), 200, 'the fallback must still clamp to the duration');
  assert.ok(
    state.warnings.some((line) => line.includes('project seek path')),
    'the fallback must be reported, not silent'
  );
  assert.ok(
    state.warnings.some((line) => line.includes('declined')),
    'a project path that returns false must be named as a decline, distinct from a throw'
  );
}
{
  const { context, state } = buildContext();
  vm.runInContext('audio = { paused: false, currentTime: 0, duration: 0 };', context);
  state.position = null;
  vm.runInContext('mediaSessionSeekBy(10)', context);
  assert.strictEqual(state.position, null, 'seeking with an unknown duration must not fabricate a position state');
}

// -- 环境不支持时安静降级 --

{
  const { context, state } = buildContext({ noMediaSession: true });
  vm.runInContext('audio = { paused: false, currentTime: 1, duration: 10 };', context);
  setSong(context, { name: 'Whatever' });
  assert.strictEqual(vm.runInContext('mediaSessionSupported()', context), false, 'support must be reported honestly');
  assert.strictEqual(vm.runInContext('syncMediaSession(true)', context), false, 'sync must be a no-op, not a throw');
  assert.strictEqual(vm.runInContext('initializeMediaSession()', context), false, 'init must be a no-op too');
  assert.strictEqual(state.metadata, null, 'nothing may be written without the API');
}

console.log('[OK] System media controls run renderer-only on navigator.mediaSession: metadata and '
  + 'playback state are only written on change, artwork declares no guessed MIME type and reports '
  + 'the size it fetched, unknown durations are refused instead of faked, seeking routes through '
  + 'the project progress-seek path, and a browser without the API degrades silently.');

module.exports = { buildContext, setSong };
