// ============================================================================================
// Regarding the Spotify section, due to the strict policies and terms of the Spotify platform,
// I had to adopt this last resort, using a method similar to 'hijacking' to utilize the official
// player. This is solely a measure of necessity and not malicious intent. If it violates any
// terms, I will promptly remove the code.
// ============================================================================================

// PillagerSpotify —— 控制 Spotify 官方客户端的模块化部件 / the Spotify client control component.
//
// 代号来自上面的声明：这段代码"劫持"了官方播放器，Pillager（劫掠者）算是自嘲。它只干一件事：
// 把官方客户端的声音接进 Mineradio 的时间轴，并把用户的播控动作送回去。
//
// 边界刻意收得很窄：
//   · 只做"时间轴镜像 + 遥控器"：声音始终由官方客户端发，我们不出声、不碰 DRM、
//     不消耗任何 Spotify 接口配额，也不需要 Premium。
//   · 关键技巧：不给 <audio> 加载真实音频，而是加载一段**等长的静音 WAV**。这样
//     audio.currentTime / duration / timeupdate / ended / pause / play 全部照常工作，
//     现有歌词、进度条、动画、上一首下一首等 100 多处读 audio 的逻辑一行都不用改；
//     我们只要周期性把客户端的真实进度与播放态"对表"即可。
//   · 通道不可用时本部件完全不介入，播放引擎会照旧走换源/跳歌 —— 绝不把用户晾在无声界面上。
//
// 对外只有一个入口：`window.SpotifyRemote`（即 `PillagerSpotify()` 的返回值）。
// 状态、定时器、桥调用、校准、观察器全部关在这个函数的闭包里 —— 每个模块都是独立的
// classic <script>，顶层声明共享同一个 window，散着写就会被后加载的模块无声覆盖
// （这一轮真的踩过：两个同名顶层声明，点开关直接 TypeError，而所有静态守卫都绿）。
//
// 设置项只有两个（取代旧的"深链接唤起客户端"，那套已经删掉）：
//   · 后台开启 SP：通道不在时请主进程在后台把客户端带调试端口拉起来（默认开）
//   · SP 换源其他：客户端接管不了时换到别的平台播同首歌（默认开）
//
// 时间轴校准：只在前端 MR 播放 **Spotify 源**、且客户端正在接管时，每 12 秒做一次深度对表。
// 源一旦不是 Spotify（换源到其他平台、用户切走），校准立刻整段停用 —— 拿别的平台的进度
// 去校这个时钟，等于把歌词和动画一起带偏。
//
// A silent WAV of the same duration acts as a virtual clock so every existing consumer of
// `audio` keeps working unchanged; we only reconcile position/playing against the client.

'use strict';

// PillagerSpotify：控制 Spotify 官方客户端的模块化部件。
// 全模块只有这一个顶层声明，其余状态与函数都关在它的闭包里。
// The Spotify control component: one top-level declaration, everything else stays in its closure.
function PillagerSpotify() {

  var spotifyRemoteAvailable = false;
  var spotifyRemoteState = null;
  var spotifyRemoteLastOkAt = 0;
  var spotifyRemoteActive = false;
  var spotifyRemoteSongKey = '';
  var spotifyRemoteApplyingUntil = 0;
  var spotifyRemoteSuppressUntil = 0;
  var spotifyRemoteClockUrl = '';
  var spotifyRemoteHookedAudio = null;
  // API 通道下一次状态读取只要几毫秒，1 秒足够让歌词/进度紧跟客户端；
  // 早先的 2 秒会让切歌后的歌词慢一拍。
  var spotifyRemotePollMs = 1000;
  var spotifyRemotePollTimer = null;
  var spotifyRemoteVolumeTimer = null;
  var spotifyRemotePendingVolume = null;
  // 正在等客户端切歌：这期间绝不把旧曲目的进度映射到新曲目的时钟上。
  var spotifyRemoteSwitchingUntil = 0;
  // 用户刚在 MR 里拖过进度：客户端要几百毫秒才跟上，这期间别拿旧进度去"校准"。
  var spotifyRemoteUserSeekUntil = 0;
  // 我们最后一次转发给客户端的指令：用来区分"用户暂停"和"我们自己按的暂停"。
  var spotifyRemoteLastCommand = '';
  var spotifyRemoteLastCommandAt = 0;

  // 进度条拖动期间（06-lyrics/04-progress-seek.js 的 pointerdown → pointerup）播放引擎会
  // 先静音再 pause 本地那段静音 WAV，松手才 play() 回来。这两个动作是它为了对齐预览时间轴
  // 自己做的，**不是用户按了暂停**：转发出去就会把客户端的歌停掉（拖得越久停得越久）。
  // 真正的用户意图是"拉到某个位置"——那件事由 seeked 转发的 Seek 表达。
  // While the progress bar is being dragged the playback engine mutes and pauses our local
  // silent WAV (pointerdown) and plays it again on release. Those are not user pause/play
  // intents; forwarding them would pause the client for the whole drag. Only the Seek on
  // `seeked` is the real intent.
  function spotifyRemoteProgressSeekActive() {
    return typeof progressDragState !== 'undefined'
      && !!progressDragState
      && progressDragState.active === true;
  }

  // ---- 设置项 / preferences ----------------------------------------------------
  // 键名沿用仓库约定：mineradio-<用途>-v1。读不到一律按默认值（都开），
  // 因为 localStorage 在个别隐私模式下会抛异常，不能让它拖垮整个模块。
  var SPOTIFY_REMOTE_LAUNCH_STORE_KEY = 'mineradio-spotify-remote-launch-v1';
  var SPOTIFY_REMOTE_SWITCH_STORE_KEY = 'mineradio-spotify-remote-switch-source-v1';
  var spotifyRemotePrefs = {
    launch: spotifyRemoteReadPref(SPOTIFY_REMOTE_LAUNCH_STORE_KEY, true),
    switchSource: spotifyRemoteReadPref(SPOTIFY_REMOTE_SWITCH_STORE_KEY, true),
  };

  function spotifyRemoteReadPref(key, fallback) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return fallback;
      var raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return raw === '1';
    } catch (err) {
      return fallback;
    }
  }

  function spotifyRemoteSetPref(name, on) {
    if (name !== 'launch' && name !== 'switchSource') return false;
    var value = !!on;
    spotifyRemotePrefs[name] = value;
    try {
      localStorage.setItem(
        name === 'launch' ? SPOTIFY_REMOTE_LAUNCH_STORE_KEY : SPOTIFY_REMOTE_SWITCH_STORE_KEY,
        value ? '1' : '0'
      );
    } catch (err) { /* 存不下就只在本次运行生效，不影响播放 */ }
    return value;
  }

  function spotifyRemoteGetPref(name) {
    return !!spotifyRemotePrefs[name];
  }

  // ---- 时间轴校准 / timeline calibration ---------------------------------------
  // 静音时钟由浏览器自己推进，而客户端会因为缓冲、网络抖动、临时降码率"原地踏步"几秒；
  // 每秒一次的镜像对表只在偏差超过 1.25 秒时才补，小于这个量的漂移会累积成"歌词慢慢走偏"。
  // 所以再加一层独立的深度校准：强制读一次**绕过缓存**的新鲜状态，偏差超过 350ms 就把时钟拉回。
  var spotifyRemoteCalibrateMs = 12000;
  var spotifyRemoteCalibrateThresholdMs = 350;
  var spotifyRemoteCalibrateTimer = null;
  var spotifyRemoteCalibrateBusy = false;
  var spotifyRemoteCalibrationStats = {
    runs: 0, samples: 0, corrections: 0, skipped: 0, lastDriftMs: 0, lastAt: 0, lastReason: ''
  };

  function spotifyRemoteApi(path) {
    return fetch(path, { cache: 'no-store' }).then(function (response) {
      return response.json();
    });
  }

  function spotifyRemoteSwitching() {
    return Date.now() < spotifyRemoteSwitchingUntil;
  }

  function spotifyRemoteIsActive() {
    return spotifyRemoteActive;
  }

  function spotifyRemoteCommand(name, payload) {
    var query = 'name=' + encodeURIComponent(name);
    if (payload && payload.position != null) query += '&position=' + encodeURIComponent(payload.position);
    if (payload && payload.level != null) query += '&level=' + encodeURIComponent(payload.level);
    // 记下我们刚发过什么：客户端随后出现的"停止"是我们自己按的，不该报成意外中断。
    spotifyRemoteLastCommand = String(name || '');
    spotifyRemoteLastCommandAt = Date.now();
    return spotifyRemoteApi('/api/spotify/client/command?' + query).catch(function () {
      return { ok: false, error: 'network' };
    });
  }

  function spotifyRemoteCommandJustSent(name, withinMs) {
    if (!spotifyRemoteLastCommandAt) return false;
    if (String(name || '') !== spotifyRemoteLastCommand) return false;
    return (Date.now() - spotifyRemoteLastCommandAt) < Math.max(0, Number(withinMs) || 0);
  }

  // 取词：缺键返回键名（不返回空串），params 同时喂给词典与兜底模板。
  // Copy goes through i18n; a missing key returns the key itself rather than an empty string.
  function spotifyRemoteText(key, fallback, params) {
    var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
    var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
    if (text && text !== key) {
      if (params && typeof params === 'object') {
        Object.keys(params).forEach(function (field) {
          text = text.split('{' + field + '}').join(String(params[field]));
        });
      }
      return text;
    }
    if (fallback == null) return key;
    var out = String(fallback);
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(function (field) {
        out = out.split('{' + field + '}').join(String(params[field]));
      });
    }
    return out;
  }

  // 客户端现在放的是不是这一首。有 URI 就比 URI —— 那是唯一无歧义的判据，
  // 同名不同版（原版 / Live / Jazz Version）也能分清；URI 缺失时才退回标题比对。
  function spotifyRemoteClockMatches(song, state) {
    if (!song || !state) return false;
    var wantUri = String(song.spotifyUri || song.uri || '').trim();
    var actualUri = String(state.uri || '').trim();
    if (wantUri && actualUri) return wantUri === actualUri;
    var expected = String(song.name || '').trim();
    var actual = String(state.title || '').trim();
    return !!expected && !!actual && (actual === expected || actual.indexOf(expected) >= 0 || expected.indexOf(actual) >= 0);
  }

  // 当前播放的是哪一首。队列和游标是全局的，但用户可能在别的时机调用到，
  // 所以每一步都判类型；拿不到就返回 null，校准会因此直接跳过。
  function spotifyRemoteCurrentSong() {
    try {
      if (typeof playQueue === 'undefined' || !playQueue || !playQueue.length) return null;
      if (typeof currentIdx === 'undefined' || currentIdx < 0 || currentIdx >= playQueue.length) return null;
      return playQueue[currentIdx] || null;
    } catch (err) {
      return null;
    }
  }

  function spotifyRemoteSongProvider(song) {
    if (!song) return '';
    if (typeof songProviderKey === 'function') {
      try { return String(songProviderKey(song) || ''); } catch (err) { /* 退到字段判断 */ }
    }
    return String(song.provider || song.source || '');
  }

  // 返回空串 = 可以校准；否则是跳过原因（诊断里能直接看出为什么没跑）。
  // ⚠️ 这里就是"只在 MR 前端 + Spotify 源 + 客户端接管中"这条硬边界：
  //    任何一项不满足都不校准，宁可让时钟自己跑，也不能拿错的进度去改它。
  function spotifyRemoteCalibrationBlocker() {
    if (!spotifyRemoteActive) return 'inactive';
    if (!spotifyRemoteState) return 'no-state';
    if (!String(spotifyRemoteState.uri || spotifyRemoteState.title || '').trim()) return 'no-client-track';
    if (spotifyRemoteSwitching()) return 'switching';
    if (Date.now() < spotifyRemoteUserSeekUntil) return 'user-seek';
    var song = spotifyRemoteCurrentSong();
    if (!song) return 'no-song';
    // 源已经不是 Spotify（自动换源到别家 / 用户切到别的源）→ 一律不触发。
    if (spotifyRemoteSongProvider(song) !== 'spotify') return 'source-changed';
    // 客户端自己换了歌（有人在 Spotify 里点了下一首）：这时两边已经不是同一首，
    // 按它的进度校我们的时钟只会更错，等换源互斥把这一首处理掉。
    if (!spotifyRemoteClockMatches(song, spotifyRemoteState)) return 'track-changed';
    return '';
  }

  // 一次深度校准：强制新鲜状态 → 算偏差 → 超阈值就把静音时钟拉回客户端位置。
  // 返回 { ok, corrected, driftMs, skipped }，异步且不抛异常（调用方是定时器）。
  function spotifyRemoteCalibrate(reason) {
    var blocked = spotifyRemoteCalibrationBlocker();
    if (blocked) {
      spotifyRemoteCalibrationStats.skipped += 1;
      return Promise.resolve({ ok: false, skipped: blocked });
    }
    if (spotifyRemoteCalibrateBusy) return Promise.resolve({ ok: false, skipped: 'busy' });
    spotifyRemoteCalibrateBusy = true;
    var startedAt = Date.now();
    return spotifyRemoteApi('/api/spotify/client/state?force=1').then(function (answer) {
      spotifyRemoteCalibrateBusy = false;
      if (!answer || !answer.available || !answer.state) {
        spotifyRemoteCalibrationStats.skipped += 1;
        return { ok: false, skipped: 'unavailable' };
      }
      // 这次读到的就是最新的真值：先更新镜像，再按**新**状态重新判一遍闸门。
      spotifyRemoteState = answer.state;
      spotifyRemoteLastOkAt = Date.now();
      spotifyRemoteAvailable = true;
      // 顺手把"客户端换歌 / 意外停止"也过一遍 —— 校准拿到的本来就是最新状态。
      spotifyRemoteNoteState(answer.state, 'calibrate');
      var stillBlocked = spotifyRemoteCalibrationBlocker();
      if (stillBlocked) {
        spotifyRemoteCalibrationStats.skipped += 1;
        return { ok: false, skipped: stillBlocked };
      }
      var media = (typeof audio !== 'undefined') ? audio : null;
      if (!media) return { ok: false, skipped: 'no-audio' };
      var target = Math.max(0, Number(answer.state.positionMs) || 0) / 1000;
      var actual = Math.max(0, Number(media.currentTime) || 0);
      var driftMs = Math.round((target - actual) * 1000);
      var stats = spotifyRemoteCalibrationStats;
      stats.runs += 1;
      stats.lastDriftMs = driftMs;
      stats.lastAt = Date.now();
      stats.lastReason = String(reason || 'timer');
      if (Math.abs(driftMs) < spotifyRemoteCalibrateThresholdMs) {
        // 已经对齐：只记账，不动时钟（动一下反而会让画面抖）。
        stats.samples += 1;
        return { ok: true, corrected: false, driftMs: driftMs, elapsedMs: Date.now() - startedAt };
      }
      var applied = false;
      try {
        // 先立"这段是我们自己对表"，随之而来的 seeked 才不会被当成用户在拖进度转发给客户端。
        spotifyRemoteApplyingUntil = Date.now() + 1200;
        if (spotifyRemoteSuppressUntil < spotifyRemoteApplyingUntil) {
          spotifyRemoteSuppressUntil = spotifyRemoteApplyingUntil;
        }
        var ceiling = Number(media.duration);
        media.currentTime = ceiling > 0 ? Math.min(target, ceiling) : target;
        applied = true;
      } catch (err) {
        applied = false;
      }
      if (applied) stats.corrections += 1;
      return { ok: applied, corrected: applied, driftMs: driftMs, elapsedMs: Date.now() - startedAt };
    }).catch(function (err) {
      spotifyRemoteCalibrateBusy = false;
      spotifyRemoteCalibrationStats.skipped += 1;
      return { ok: false, skipped: 'error', error: String((err && err.message) || err) };
    });
  }

  function spotifyRemoteStartCalibration() {
    if (spotifyRemoteCalibrateTimer) return;
    spotifyRemoteCalibrateTimer = setInterval(function () {
      // 页面在后台时浏览器会节流定时器，本来也跑不准；回来时同步对表会立刻补上。
      if (typeof document !== 'undefined' && document.hidden) return;
      spotifyRemoteCalibrate('timer');
    }, spotifyRemoteCalibrateMs);
  }

  function spotifyRemoteStopCalibration() {
    if (!spotifyRemoteCalibrateTimer) return;
    clearInterval(spotifyRemoteCalibrateTimer);
    spotifyRemoteCalibrateTimer = null;
  }

  // ---- 客户端状态观察 / client state watcher -----------------------------------
  // 校准只回答"时间轴偏了多少"，这里回答"客户端到底还在不在放、放的是不是这一首"。
  // 三种变化必须如实反映到 MR，不能装作没发生：
  //   1. 客户端自己换歌（有人在 Spotify 里点了下一首 / 换了播放内容）
  //      → 队列里能对上就跟着跳过去，对不上就明确提示，绝不拿旧歌词继续演。
  //   2. 客户端停了（用户按暂停、播放出错、被其它设备接管）
  //      → 时钟跟着停，并提示一次原因。
  //   3. 通道断了（客户端退出 / 调试端口没了）
  //      → 连续两次读不到就当成中断：暂停并提示一次，不空转。
  var spotifyRemoteWatch = {
    uri: '', playing: false, misses: 0, interruptedAt: 0,
    lastNoticeAt: 0, followUntil: 0, lastSource: '',
  };

  function spotifyRemoteNotify(key, fallback, params) {
    if (typeof showToast !== 'function') return;
    var now = Date.now();
    // 同一类事件 5 秒内只提示一次：通道抖动时不该刷屏。
    if (now - spotifyRemoteWatch.lastNoticeAt < 5000) return;
    spotifyRemoteWatch.lastNoticeAt = now;
    try { showToast(spotifyRemoteText(key, fallback, params)); } catch (err) { /* 提示失败不影响播放 */ }
  }

  // 客户端换到的这首在不在 MR 的播放列表里。只在 Spotify 源之间比对 URI。
  function spotifyRemoteFindQueuedIndex(uri) {
    if (!uri) return -1;
    try {
      if (typeof playQueue === 'undefined' || !playQueue || !playQueue.length) return -1;
      for (var i = 0; i < playQueue.length; i++) {
        var item = playQueue[i];
        if (!item || spotifyRemoteSongProvider(item) !== 'spotify') continue;
        if (String(item.spotifyUri || item.uri || '').trim() === uri) return i;
      }
    } catch (err) { /* 队列还没建好 */ }
    return -1;
  }

  // 把一次读到的新鲜状态交给观察器。source 只用于诊断（poll / calibrate / channel）。
  function spotifyRemoteNoteState(state, source) {
    if (!state) return;
    var watch = spotifyRemoteWatch;
    watch.misses = 0;
    watch.lastSource = String(source || '');
    if (watch.interruptedAt) watch.interruptedAt = 0;

    var uri = String(state.uri || '').trim();
    var playing = !!state.isPlaying;
    var trackedUri = watch.uri;
    watch.uri = uri;
    var wasPlaying = watch.playing;
    watch.playing = playing;

    // 只在客户端接管期间判断：没接管时那是用户在 Spotify 里自由听歌，不该被 MR 打断。
    if (!spotifyRemoteActive) return;

    // 1) 客户端自己换歌
    if (uri && trackedUri && uri !== trackedUri && Date.now() > watch.followUntil) {
      var song = spotifyRemoteCurrentSong();
      var mine = song ? String(song.spotifyUri || song.uri || '').trim() : '';
      // 我们刚让客户端放的就是这首（点播回执），不算"客户端自己切"。
      if (uri !== mine) {
        var queued = spotifyRemoteFindQueuedIndex(uri);
        var label = String(state.title || '').trim() || uri;
        if (queued >= 0 && typeof playQueueAt === 'function') {
          // 跟着客户端走：MR 换成同一首，歌词/封面/进度才对得上。
          watch.followUntil = Date.now() + 6000;
          spotifyRemoteNotify('spotify_client_followed', null, { title: label });
          try {
            playQueueAt(queued, { spotifyFollowClient: true, startupAutoplay: true });
          } catch (err) { /* 跳不过去就保持镜像，至少进度是真实的 */ }
        } else {
          // 对不上队列：不假装还能对上，明确告诉用户当前实际在放什么。
          spotifyRemoteNotify('spotify_client_foreign', null, { title: label });
        }
      }
    }

    // 2) 客户端停了 —— 排除"是我们自己刚发的暂停"和"正在对表/切歌"的窗口。
    if (wasPlaying && !playing && Date.now() > spotifyRemoteApplyingUntil && Date.now() > spotifyRemoteSuppressUntil) {
      if (!spotifyRemoteCommandJustSent('Pause', 3000)) {
        spotifyRemoteNotify('spotify_client_stopped', null);
      }
    }
  }

  // 通道连续读不到：连续两次（约 2 秒）就当成意外中断，把时钟停下并提示一次。
  function spotifyRemoteNoteChannelMiss() {
    var watch = spotifyRemoteWatch;
    watch.misses += 1;
    if (!spotifyRemoteActive || watch.misses < 2) return;
    if (watch.interruptedAt && Date.now() - watch.interruptedAt < 6000) return;
    watch.interruptedAt = Date.now();
    watch.playing = false;
    var media = (typeof audio !== 'undefined') ? audio : null;
    if (media && !media.paused) {
      try {
        spotifyRemoteApplyingUntil = Date.now() + 1500;
        spotifyRemoteSuppressUntil = Date.now() + 1500;
        media.pause();
      } catch (err) { /* 忽略 */ }
    }
    spotifyRemoteStopCalibration();
    spotifyRemoteNotify('spotify_client_disconnected', null);
  }

  // 让客户端播放这一首。走服务端的"搜索 + 点结果行"，不碰 spotify: 协议。
  // Ask the local client to play this exact track; the server drives the search UI.
  function spotifyRemoteRequestTrack(song) {
    if (!song) return Promise.resolve({ ok: false, error: 'no-song' });
    var query = 'title=' + encodeURIComponent(String(song.name || '')) +
      '&artist=' + encodeURIComponent(String(song.artist || '')) +
      '&uri=' + encodeURIComponent(String(song.spotifyUri || song.uri || ''));
    return spotifyRemoteApi('/api/spotify/client/play-track?' + query).catch(function (err) {
      return { ok: false, error: String((err && err.message) || err) };
    });
  }

  // 一段 PCM 8-bit / 8 kHz 的静音：每秒只要 8 KB，一首 5 分钟的歌约 2.4 MB。
  // 8-bit PCM 要用 0x80 表示"零电平"，全填 0 会变成最大负幅度的噪声。
  function spotifyRemoteSilentWavUrl(durationMs) {
    var seconds = Math.min(3600, Math.max(1, Math.ceil((Number(durationMs) || 240000) / 1000)));
    var rate = 8000;
    var samples = seconds * rate;
    var buffer = new ArrayBuffer(44 + samples);
    var view = new DataView(buffer);
    function writeAscii(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + samples, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeAscii(36, 'data');
    view.setUint32(40, samples, true);
    new Uint8Array(buffer, 44).fill(128);
    if (spotifyRemoteClockUrl) {
      try { URL.revokeObjectURL(spotifyRemoteClockUrl); } catch (err) { /* 已经失效 */ }
    }
    spotifyRemoteClockUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    return spotifyRemoteClockUrl;
  }

  // 播放引擎拿到的 playbackData：url 是本地 blob，不能被 /api/audio 代理再包一层。
  // 时长优先取"刚刚确认过的客户端状态"——它才是真正在放的那个版本（可能是另一版录音）；
  // 没有新鲜状态时才退回歌曲元数据，最后兜底 4 分钟。
  // Prefer the freshly confirmed client duration: that is the version actually playing.
  function spotifyRemotePlaybackData(song) {
    var state = spotifyRemoteState || {};
    var fresh = state.receivedAt && (Date.now() - Number(state.receivedAt)) < 20000;
    var songMs = Math.round((Number(song && song.duration) || 0) * 1000);
    var clientMs = Number(state.durationMs) || 0;
    var durationMs = Math.max(1000, (fresh && clientMs) || songMs || clientMs || 240000);
    return {
      provider: 'spotify',
      url: spotifyRemoteSilentWavUrl(durationMs),
      directUrl: true,
      remote: true,
      durationMs: durationMs,
      remoteTitle: String(state.title || ''),
      remoteArtist: String(state.artist || ''),
    };
  }

  function spotifyRemoteEnsureAudioHooks() {
    var media = (typeof audio !== 'undefined') ? audio : null;
    if (!media || media === spotifyRemoteHookedAudio) return;
    spotifyRemoteHookedAudio = media;
    // 用户在 Mineradio 里点播放/暂停/拖进度，最终都作用在 <audio> 上；
    // 监听这些结果事件，就能把任何入口的操作转发给客户端，不必逐个改按钮。
    media.addEventListener('pause', function () {
      if (!spotifyRemoteIsActive() || Date.now() < spotifyRemoteApplyingUntil || Date.now() < spotifyRemoteSuppressUntil) return;
      if (spotifyRemoteProgressSeekActive()) return;
      spotifyRemoteCommand('Pause');
    });
    media.addEventListener('play', function () {
      if (!spotifyRemoteIsActive() || Date.now() < spotifyRemoteApplyingUntil || Date.now() < spotifyRemoteSuppressUntil) return;
      if (spotifyRemoteProgressSeekActive()) return;
      spotifyRemoteCommand('Play');
    });
    media.addEventListener('seeked', function () {
      if (!spotifyRemoteIsActive() || Date.now() < spotifyRemoteApplyingUntil || Date.now() < spotifyRemoteSuppressUntil) return;
      // 用户拖动进度条：客户端要几百毫秒才跟上，这段时间里别让校准拿旧进度把时钟拽回去。
      spotifyRemoteUserSeekUntil = Date.now() + 2200;
      spotifyRemoteCommand('Seek', { position: Math.round((media.currentTime || 0) * 1000) });
    });
  }

  function spotifyRemoteSyncToAudio() {
    if (!spotifyRemoteActive || !spotifyRemoteState) return;
    var media = (typeof audio !== 'undefined') ? audio : null;
    if (!media) return;
    spotifyRemoteEnsureAudioHooks();
    // 拖动中一律不对表：这段时间的时间轴由拖动预览接管，对表会把用户刚拉到的地方拽回去，
    // 还会顺手把被 pointerdown 暂停的静音 WAV 重新 play() 起来。
    // No resync during a drag: the preview clock owns the timeline, and resyncing would yank the
    // user's target back and restart the silent WAV the drag deliberately paused.
    if (spotifyRemoteProgressSeekActive()) return;
    // 客户端还没切到目标曲目：时钟停在 0，不许把上一首的进度灌进来。
    // 这里不查 suppressUntil —— 它只负责"别把切换期的 audio 事件当成用户操作转发出去"，
    // 对表本身越早开始越好，否则切歌后歌词会晚一拍。对表引起的 play/pause 事件正好被它吞掉。
    if (spotifyRemoteSwitching()) return;
    var state = spotifyRemoteState;
    var targetSeconds = Math.max(0, Number(state.positionMs) || 0) / 1000;
    var drift = targetSeconds - (media.currentTime || 0);
    var applying = false;
    // 刚拖完进度条的这两秒里，客户端报的还是旧位置（它要几百毫秒才跟上）。
    // 这期间只放行"跟着客户端停/放"，不做位置纠偏 —— 否则进度条会当着用户的面跳回去。
    // Right after a seek the client still reports the old position for a few hundred ms: mirror
    // play/pause as usual, but never correct the clock from that stale value.
    if (Date.now() >= spotifyRemoteUserSeekUntil
      && Math.abs(drift) > 1.25 && Number.isFinite(media.duration) && media.duration > 0) {
      applying = true;
      try { media.currentTime = Math.min(media.duration, targetSeconds); } catch (err) { applying = false; }
    }
    if (state.isPlaying && media.paused) {
      applying = true;
      try { var playing = media.play(); if (playing && playing.catch) playing.catch(function () { }); } catch (err) { /* 忽略 */ }
    } else if (!state.isPlaying && !media.paused) {
      applying = true;
      try { media.pause(); } catch (err) { /* 忽略 */ }
    }
    if (applying) {
      spotifyRemoteApplyingUntil = Date.now() + 900;
      // 对表会引起 audio 的 play/pause，这些事件不能被当成"用户在操作"转发给客户端。
      if (spotifyRemoteSuppressUntil < Date.now() + 900) spotifyRemoteSuppressUntil = Date.now() + 900;
    }
  }

  function spotifyRemotePoll() {
    return spotifyRemoteApi('/api/spotify/client/state').then(function (answer) {
      spotifyRemoteAvailable = !!(answer && answer.available && answer.state);
      if (spotifyRemoteAvailable) {
        spotifyRemoteState = answer.state;
        spotifyRemoteLastOkAt = Date.now();
        // 每轮都过一遍观察器：换歌、意外停止都在这里被发现，不必等 12 秒的校准。
        spotifyRemoteNoteState(answer.state, 'poll');
      } else if (spotifyRemoteActive) {
        // 通道读不到：连续两次就当成中断（进程退出、调试端口没了）。
        spotifyRemoteNoteChannelMiss();
      }
      spotifyRemoteSyncToAudio();
      return answer;
    }).catch(function () {
      spotifyRemoteAvailable = false;
      if (spotifyRemoteActive) spotifyRemoteNoteChannelMiss();
    });
  }

  // 通道没起来时，先请主进程用调试端口把客户端拉起来（已经在跑的实例绝不打断），
  // 再等它出现在 127.0.0.1:9222 上。这样用户第一次点 Spotify 歌就能直接进入远程模式，
  // 不必自己去改快捷方式。
  // 「后台开启 SP」关着时这里直接返回 false —— 不替用户开客户端，交给上层换源。
  // Ask the main process to start the client with its debug port, then wait for the channel.
  function spotifyRemoteEnsureChannel() {
    if (!spotifyRemotePrefs.launch) return Promise.resolve(false);
    return spotifyRemoteApi('/api/spotify/client/launch').then(function (answer) {
      if (!answer || !answer.ok) {
        // 拉不起来要如实说原因，否则用户会以为"后台开启 SP"这个开关没生效：
        //   already-running —— 客户端在跑但没带调试端口，MR 不会强杀它，只能提示重启接入；
        //   not-installed   —— 根本没装，交给换源开关决定下一步。
        var reason = String((answer && answer.reason) || '');
        if (reason === 'already-running') spotifyRemoteNotify('spotify_client_need_restart', null);
        else if (reason === 'not-installed') spotifyRemoteNotify('spotify_client_not_installed', null);
        return false;
      }
      var deadline = Date.now() + 9000;
      function waitForChannel() {
        return spotifyRemoteApi('/api/spotify/client/state?force=1').then(function (state) {
          if (state && state.available && state.state) {
            spotifyRemoteAvailable = true;
            spotifyRemoteState = state.state;
            spotifyRemoteLastOkAt = Date.now();
            spotifyRemoteNoteState(state.state, 'channel');
            return true;
          }
          if (Date.now() > deadline) return false;
          return new Promise(function (resolve) { setTimeout(resolve, 600); }).then(waitForChannel);
        }).catch(function () { return false; });
      }
      return waitForChannel();
    }).catch(function () { return false; });
  }

  // 切歌时决定"这一首归谁管"。返回 Promise<boolean>，true 表示已由客户端接管，调用方不要再唤起一次。
  // 客户端已经在放同一首就直接接管；不是同一首就先让它切过去 —— 切不过去就干脆不接管，
  // 让上层的换源/跳歌照旧工作，绝不拿一段静音时钟冒充播放。
  // Resolves to true only when the client really is playing this track, so the caller can keep
  // its original switch_source path when the client cannot comply.
  function spotifyRemoteHandleTrackStart(song) {
    if (!song || song.provider !== 'spotify') {
      spotifyRemoteActive = false;
      spotifyRemoteSongKey = '';
      spotifyRemoteSwitchingUntil = 0;
      spotifyRemoteStopCalibration();
      return Promise.resolve(false);
    }
    if (!spotifyRemoteAvailable || !spotifyRemoteState) {
      // 客户端可能压根没开：先试着用调试端口拉起来，拉不起来就交给上层换源。
      return spotifyRemoteEnsureChannel().then(function (ready) {
        return ready ? spotifyRemoteHandleTrackStart(song) : false;
      });
    }
    spotifyRemoteSongKey = String(song.name || '') + '|' + String(song.artist || '');
    // 客户端已经在放同一首（例如启动时恢复上次播放）就别再打断它。
    if (spotifyRemoteClockMatches(song, spotifyRemoteState)) {
      spotifyRemoteActive = true;
      spotifyRemoteSwitchingUntil = 0;
      spotifyRemoteSuppressUntil = Date.now() + 2200;
      spotifyRemoteApplyingUntil = spotifyRemoteSuppressUntil;
      // 观察器的基准同步到这一首，免得下一轮把"我们自己的接管"误判成客户端换歌。
      spotifyRemoteWatch.uri = String(spotifyRemoteState.uri || '').trim();
      spotifyRemoteWatch.playing = !!spotifyRemoteState.isPlaying;
      spotifyRemoteStartCalibration();
      return Promise.resolve(true);
    }
    spotifyRemoteActive = true;
    spotifyRemoteSwitchingUntil = Date.now() + 20000;
    spotifyRemoteSuppressUntil = spotifyRemoteSwitchingUntil;
    spotifyRemoteApplyingUntil = spotifyRemoteSwitchingUntil;
    return spotifyRemoteRequestTrack(song).then(function (answer) {
      if (answer && answer.ok && answer.state) {
        spotifyRemoteState = answer.state;
        spotifyRemoteAvailable = true;
        spotifyRemoteLastOkAt = Date.now();
        spotifyRemoteSwitchingUntil = 0;
        spotifyRemoteSuppressUntil = Date.now() + 1500;
        spotifyRemoteApplyingUntil = spotifyRemoteSuppressUntil;
        // 同上：把观察基准挪到刚点播的这一首。
        spotifyRemoteWatch.uri = String(answer.state.uri || '').trim();
        spotifyRemoteWatch.playing = !!answer.state.isPlaying;
        // 客户端确认切过来了才开始校准：切换期两边的曲目根本对不上。
        spotifyRemoteStartCalibration();
        return true;
      }
      spotifyRemoteActive = false;
      spotifyRemoteSongKey = '';
      spotifyRemoteSwitchingUntil = 0;
      spotifyRemoteStopCalibration();
      return false;
    }).catch(function () {
      spotifyRemoteActive = false;
      spotifyRemoteSongKey = '';
      spotifyRemoteSwitchingUntil = 0;
      spotifyRemoteStopCalibration();
      return false;
    });
  }

  // 音量从 setVolume() 这个唯一入口转发。淡入淡出每帧都会改 audio.volume，
  // 所以绝不能监听 volumechange —— 会把客户端音量刷成噪音。
  // Volume is forwarded from setVolume() only; fade frames change audio.volume constantly,
  // so listening to volumechange would spam the client.
  function spotifyRemoteForwardVolume(level) {
    if (!spotifyRemoteActive) return;
    spotifyRemotePendingVolume = Math.max(0, Math.min(1, Number(level) || 0));
    if (spotifyRemoteVolumeTimer) return;
    spotifyRemoteVolumeTimer = setTimeout(function () {
      spotifyRemoteVolumeTimer = null;
      if (spotifyRemotePendingVolume == null) return;
      spotifyRemoteCommand('SetVolume', { level: spotifyRemotePendingVolume });
      spotifyRemotePendingVolume = null;
    }, 250);
  }

  function spotifyRemoteDeactivate() {
    spotifyRemoteActive = false;
    spotifyRemoteSongKey = '';
    spotifyRemoteSwitchingUntil = 0;
    // 观察器一起复位：换到别的源以后，客户端的任何动作都不再是"我们的播放状态"。
    spotifyRemoteWatch.uri = '';
    spotifyRemoteWatch.playing = false;
    spotifyRemoteWatch.misses = 0;
    spotifyRemoteWatch.interruptedAt = 0;
    // 一旦不再由客户端接管，校准必须立刻停 —— 它只服务于"MR 前端 + Spotify 源"这一种状态。
    spotifyRemoteStopCalibration();
    if (spotifyRemoteClockUrl) {
      try { URL.revokeObjectURL(spotifyRemoteClockUrl); } catch (err) { /* 已经失效 */ }
      spotifyRemoteClockUrl = '';
    }
  }

  // 换源开关关着时，调用方要如实停下（弹出不可播放提示），而不是偷偷换成别家平台。
  function spotifyRemoteAllowSourceFallback() {
    return !!spotifyRemotePrefs.switchSource;
  }


  // 未接管时也保持低频探测：用户中途打开客户端，下一首就能自动接入。
  if (typeof window !== 'undefined') {
    spotifyRemotePollTimer = setInterval(function () {
      if (typeof document !== 'undefined' && document.hidden) return;
      spotifyRemotePoll();
    }, spotifyRemotePollMs);
    window.addEventListener('pagehide', function () {
      if (spotifyRemotePollTimer) clearInterval(spotifyRemotePollTimer);
      spotifyRemotePollTimer = null;
      spotifyRemoteStopCalibration();
      if (spotifyRemoteVolumeTimer) clearTimeout(spotifyRemoteVolumeTimer);
      spotifyRemoteVolumeTimer = null;
      if (spotifyRemoteClockUrl) {
        try { URL.revokeObjectURL(spotifyRemoteClockUrl); } catch (err) { /* 页面已经走了 */ }
        spotifyRemoteClockUrl = '';
      }
    });
  }
  spotifyRemotePoll();

  return {
    available: function () { return spotifyRemoteAvailable; },
    state: function () { return spotifyRemoteState; },
    isActive: spotifyRemoteIsActive,
    playbackData: spotifyRemotePlaybackData,
    handleTrackStart: spotifyRemoteHandleTrackStart,
    requestTrack: spotifyRemoteRequestTrack,
    switching: spotifyRemoteSwitching,
    deactivate: spotifyRemoteDeactivate,
    forwardVolume: spotifyRemoteForwardVolume,
    command: spotifyRemoteCommand,
    poll: spotifyRemotePoll,
    syncToAudio: spotifyRemoteSyncToAudio,
    prefs: function () { return { launch: !!spotifyRemotePrefs.launch, switchSource: !!spotifyRemotePrefs.switchSource }; },
    getPref: spotifyRemoteGetPref,
    setPref: spotifyRemoteSetPref,
    allowSourceFallback: spotifyRemoteAllowSourceFallback,
    calibrate: spotifyRemoteCalibrate,
    calibration: function () {
      return {
        running: !!spotifyRemoteCalibrateTimer,
        intervalMs: spotifyRemoteCalibrateMs,
        thresholdMs: spotifyRemoteCalibrateThresholdMs,
        blocker: spotifyRemoteCalibrationBlocker(),
        stats: Object.assign({}, spotifyRemoteCalibrationStats),
        watch: {
          uri: spotifyRemoteWatch.uri,
          playing: spotifyRemoteWatch.playing,
          misses: spotifyRemoteWatch.misses,
          interruptedAt: spotifyRemoteWatch.interruptedAt,
          lastSource: spotifyRemoteWatch.lastSource,
        },
      };
    },
  };
}

// 唯一出口：播放引擎 / 换源 / 音量 / 设置开关都只认 window.SpotifyRemote，名字保持不变。
// The single exit: every consumer keeps reading window.SpotifyRemote exactly as before.
if (typeof window !== 'undefined') {
  window.SpotifyRemote = PillagerSpotify();
}
