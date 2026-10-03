// Windows 系统媒体控制（SMTC）：任务栏播放条、锁屏界面、蓝牙/媒体键。
// System media controls: the taskbar strip, the lock screen, and Bluetooth/media keys.
//
// 完全跑在渲染层的 navigator.mediaSession 上——这是 Chromium/Electron 的原生能力，零依赖、
// 零 IPC、零主进程状态。系统媒体 UI 与页面在同一个渲染进程里，再把状态复制一份到主进程只会
// 多一次无用的往返，并且两边可能各说各话。
//
// This runs entirely on the renderer's navigator.mediaSession: a native Chromium/Electron
// capability with no dependency, no IPC and no main-process state. The system media UI lives in
// this same renderer, so mirroring the state into main would only add a round trip and a second
// copy that can disagree with the first.
//
// 三件容易被做错、这里刻意做对的事：
//  1. **变化检测**。MediaMetadata 和 playbackState 每次重建都会让系统媒体 UI 重新取一次封面、
//     重新布局一次。所以只在内容真的变了时才写，没变就一个字段都不碰。
//  2. **artwork 不写死 type**。type 只是提示，写错（把 png 标成 image/jpeg）在部分 Windows 版本
//     上会让系统直接取不到图；交给浏览器嗅探更稳。sizes 则必须写实——我们按 512 取的图，就只
//     声明 512，不谎报更大。
//  3. **seek 走本项目自己的通道**（commitProgressSeek）。直接改 audio.currentTime 会绕过进度条
//     的 URL 刷新与视觉就绪协议，可能让进度条和歌词进度与实际播放位置脱节。
//
// Three things this gets right on purpose: metadata and playback state are only written when they
// actually change, because rebuilding them makes the system UI refetch artwork and re-lay out;
// artwork carries no guessed MIME type, which some Windows versions reject, and declares the size
// it really requested instead of a larger one; and seeking goes through the project's own
// progress-seek protocol instead of poking audio.currentTime, which would desynchronise the
// progress bar and the lyrics from the real playback position.

// 位置回报节流。系统的进度条靠这个刷新，1 秒一次足够，也不会有 IPC 压力（本实现压根没有 IPC）。
// Position reporting interval. One per second is plenty for the system progress bar, and with no
// IPC in the picture there is no per-call cost to worry about either.
var MEDIA_SESSION_POSITION_INTERVAL_MS = 1000;

// seekbackward / seekforward 的步长，与 Windows 媒体键的默认行为一致。
// Step for seekbackward / seekforward, matching the Windows media-key default.
var MEDIA_SESSION_SEEK_STEP_SECONDS = 10;

var mediaSessionState = {
  initialized: false,
  metadataKey: '',
  playbackState: '',
  positionAt: 0
};

function mediaSessionSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaSession;
}

function mediaSessionMedia() {
  return typeof audio !== 'undefined' ? audio : null;
}

function mediaSessionCurrentSong() {
  if (typeof playQueue === 'undefined' || !Array.isArray(playQueue)) return null;
  var index = typeof currentIdx === 'number' ? currentIdx : -1;
  if (index < 0 || index >= playQueue.length) return null;
  return playQueue[index] || null;
}

function mediaSessionPlaybackIsPaused() {
  var media = mediaSessionMedia();
  if (media && typeof media.paused === 'boolean') return media.paused;
  return !(typeof playing !== 'undefined' && playing);
}

function mediaSessionPlaybackStateText() {
  // 没有当前曲目就不该报 paused：那会让系统显示一个"已暂停"的条目，而其实根本没有东西在播。
  // With no current track, reporting paused shows a paused entry for something that is not playing;
  // the spec has a state for exactly this case.
  if (!mediaSessionCurrentSong()) return 'none';
  return mediaSessionPlaybackIsPaused() ? 'paused' : 'playing';
}

// 没有当前曲目时返回 null，让调用方去**清空**元数据，而不是写一个占位标题：停在上一首的歌名
// 上比什么都不显示更糟，系统会因此一直以为还有歌在播。
// Returns null with no current track so the caller clears the metadata: leaving the previous title
// on screen is worse than showing nothing, because the system then believes something is playing.
function mediaSessionMetadataFor(song) {
  if (!song) return null;
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.artist || song.singer || '').trim();
  var album = String(song.album || '').trim();
  var artwork = '';
  try {
    if (typeof songCoverSrc === 'function') artwork = String(songCoverSrc(song, 512) || '');
  } catch (error) {
    // 封面解析失败不该让整条元数据链路断掉：没有封面照样能显示标题。
    // A failed cover lookup must not break metadata: the title still belongs on screen.
    artwork = '';
  }
  if (!artwork) artwork = String(song.cover || song.picUrl || '');
  return { title: title || '未知歌曲', artist: artist, album: album, artwork: artwork };
}

function applyMediaSessionMetadata(song) {
  if (!mediaSessionSupported()) return false;
  var info = mediaSessionMetadataFor(song);
  var key = info ? [info.title, info.artist, info.album, info.artwork].join('|') : '';
  if (key === mediaSessionState.metadataKey) return false;
  mediaSessionState.metadataKey = key;
  if (!info) {
    try {
      navigator.mediaSession.metadata = null;
    } catch (error) {
      console.warn('[MediaSession] metadata clear rejected:', error && (error.message || error) || error);
      return false;
    }
    return true;
  }
  // sizes 必须与实际取图尺寸一致，且不声明 type：类型交给浏览器嗅探，谎报会被部分系统拒绝。
  // The size must match what was really fetched, and no type is declared: the browser sniffs it,
  // while a wrong guess gets rejected outright on some systems.
  var artwork = info.artwork ? [{ src: info.artwork, sizes: '512x512' }] : [];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title,
      artist: info.artist,
      album: info.album,
      artwork: artwork
    });
    return true;
  } catch (error) {
    console.warn('[MediaSession] metadata rejected:', error && (error.message || error) || error);
    return false;
  }
}

function applyMediaSessionPlaybackState() {
  if (!mediaSessionSupported()) return false;
  var state = mediaSessionPlaybackStateText();
  if (state === mediaSessionState.playbackState) return false;
  mediaSessionState.playbackState = state;
  try {
    navigator.mediaSession.playbackState = state;
  } catch (error) {
    console.warn('[MediaSession] playbackState rejected:', error && (error.message || error) || error);
    return false;
  }
  return true;
}

function applyMediaSessionPosition(force) {
  if (!mediaSessionSupported()) return false;
  var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (!force && now - mediaSessionState.positionAt < MEDIA_SESSION_POSITION_INTERVAL_MS) return false;
  var media = mediaSessionMedia();
  // 规范要求 duration 是正的有限数，否则 setPositionState 直接抛 InvalidStateError；流媒体在
  // 元数据到手前是 NaN，那种情况下干脆不上报，而不是报一个假时长。
  // The spec demands a positive finite duration or setPositionState throws; live streams report NaN
  // before metadata arrives, and reporting a made-up duration is worse than reporting nothing.
  var duration = media && isFinite(media.duration) ? Number(media.duration) : 0;
  if (!(duration > 0)) return false;
  var position = media && isFinite(media.currentTime) ? Math.max(0, Number(media.currentTime)) : 0;
  mediaSessionState.positionAt = now;
  try {
    if (typeof navigator.mediaSession.setPositionState === 'function') {
      navigator.mediaSession.setPositionState({
        duration: duration,
        playbackRate: 1,
        position: Math.min(position, duration)
      });
    }
  } catch (error) {
    console.warn('[MediaSession] position rejected:', error && (error.message || error) || error);
    return false;
  }
  return true;
}

// 走项目自己的进度条 seek 通道；它不可用、抛错、或者**明确返回 false**（时长未知的早退路径）
// 才退回直接赋值，并且明确这是降级路径。只认异常会漏掉 return false 那条——那正是"不接这次
// seek"的正常信号，用户的按键不能就这么没反应。
// Route through the project's own progress-seek protocol, falling back to a direct assignment only
// when it is missing, throws, or explicitly returns false (its early-exit path for an unknown
// duration). Catching only the exception would miss the false return, which is exactly the normal
// "this seek is not accepted" signal — and a media key that silently does nothing is a bug.
function mediaSessionSeekTo(seconds) {
  var target = Number(seconds);
  if (!isFinite(target)) return false;
  var media = mediaSessionMedia();
  if (!media) return false;
  var duration = isFinite(media.duration) && media.duration > 0 ? Number(media.duration) : Infinity;
  var clamped = Math.max(0, Math.min(target, duration === Infinity ? target : duration));
  if (typeof commitProgressSeek === 'function') {
    var accepted = false;
    try {
      accepted = commitProgressSeek(clamped, mediaSessionPlaybackIsPaused()) !== false;
    } catch (error) {
      console.warn('[MediaSession] project seek path threw, falling back to currentTime:',
        error && (error.message || error) || error);
      accepted = false;
    }
    if (accepted) {
      applyMediaSessionPosition(true);
      return true;
    }
    console.warn('[MediaSession] project seek path declined, falling back to currentTime');
  }
  try {
    media.currentTime = clamped;
  } catch (error) {
    return false;
  }
  applyMediaSessionPosition(true);
  return true;
}

function mediaSessionSeekBy(deltaSeconds) {
  var media = mediaSessionMedia();
  if (!media || !isFinite(media.currentTime)) return false;
  return mediaSessionSeekTo(media.currentTime + deltaSeconds);
}

function initializeMediaSession() {
  if (!mediaSessionSupported()) return false;
  if (mediaSessionState.initialized) return true;
  mediaSessionState.initialized = true;
  var handlers = {
    // play / pause 分开注册：系统发来的动作带明确意图，用 togglePlay 固然能切状态，但只在当前
    // 状态与请求相反时才动，避免连按两次把状态又切回去。
    // play and pause are registered separately: the system states its intent, so only act when the
    // current state actually differs, instead of toggling blindly and undoing itself on a double press.
    play: function () {
      if (mediaSessionPlaybackIsPaused() && typeof togglePlay === 'function') togglePlay();
      applyMediaSessionPlaybackState();
    },
    pause: function () {
      if (!mediaSessionPlaybackIsPaused() && typeof togglePlay === 'function') togglePlay();
      applyMediaSessionPlaybackState();
    },
    previoustrack: function () {
      if (typeof prevTrack === 'function') prevTrack(true);
    },
    nexttrack: function () {
      if (typeof nextTrack === 'function') nextTrack(true);
    },
    seekbackward: function () { mediaSessionSeekBy(-MEDIA_SESSION_SEEK_STEP_SECONDS); },
    seekforward: function () { mediaSessionSeekBy(MEDIA_SESSION_SEEK_STEP_SECONDS); },
    seekto: function (details) {
      if (details && isFinite(details.seekTime)) mediaSessionSeekTo(details.seekTime);
    }
  };
  for (var action in handlers) {
    if (!Object.prototype.hasOwnProperty.call(handlers, action)) continue;
    // Chromium 对不支持的 action 直接抛异常（不是返回失败），所以逐个 try：注册不上一个
    // seekbackward 不该让 play / next 也一起没了。
    // Chromium throws (rather than returning false) for actions it does not support, so each one is
    // guarded: losing seekbackward must not also cost us play and next.
    try {
      navigator.mediaSession.setActionHandler(action, handlers[action]);
    } catch (error) {
      console.warn('[MediaSession] action unsupported:', action);
    }
  }
  return true;
}

function mediaSessionReady() {
  if (!mediaSessionSupported()) return false;
  if (!mediaSessionState.initialized && !initializeMediaSession()) return false;
  return true;
}

// 主循环每帧调用；内部按 1 秒节流，所以稳定状态下它只是几次比较。
// Called every frame; the internal 1s throttle makes a steady state cost a few comparisons.
function syncMediaSession(force) {
  if (!mediaSessionReady()) return false;
  applyMediaSessionMetadata(mediaSessionCurrentSong());
  applyMediaSessionPlaybackState();
  applyMediaSessionPosition(force === true);
  return true;
}
