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
  // 服务端这次读状态走的是哪条通道：'api' = 注入桥可用（精确点播、毫秒级进度），
  // 'dom' = 只能点界面（慢且依赖界面语言）。只有 'api' 才允许"发出去就不等"的乐观交接。
  // Only the injected bridge can be trusted to accept a play request instantly.
  var spotifyRemoteApiMode = '';
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
  // 点播发出去、但客户端还没确认切过来的那一小段。切歌路径**不等**它（等一次确认要几百
  // 毫秒到 7 秒，混队列里每切一首都要交一遍这个过路费），而是先让本地静音时钟跑起来，
  // 由轮询发现"已经在这首上了"再解除守卫；超过 confirmMs 还没发现就当成切不过去。
  // The handover is optimistic: the timeline starts now, the poll confirms it, and a watchdog
  // gives up after confirmMs so a stuck client can never leave a silent clock running forever.
  var spotifyRemotePendingUri = '';
  var spotifyRemotePendingSince = 0;
  var spotifyRemoteConfirmMs = 4000;
  // 切歌后的密集轮询：确认一般不慢过两三次（约 400ms），比等 1 秒的常规节奏快得多。
  var spotifyRemoteBurstTimer = null;
  var spotifyRemoteBurstLeft = 0;
  var spotifyRemoteBurstMs = 180;
  // 确认后的一次延迟复校：客户端刚起播时进度可能还停在 0，1.2 秒后再对一次才稳。
  var spotifyRemoteConfirmCalibrateTimer = null;
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

  // ---- 交接加速：乐观接管 / 确认 / 看门狗 ---------------------------------------
  // 切歌时客户端要"搜索—点击—起播"，服务端原来还要再等它回执（最长 7 秒），整段时间
  // MR 的界面是停着的。现在改成：本地静音时钟立刻跑，点播发出去就不管回执，靠轮询确认。
  // Handover is optimistic: start the clock now, dispatch the play, let the poll confirm.

  // 切歌后的密集轮询。常规心跳是 1 秒一次，这里前 1.8 秒每 180ms 读一次，
  // 确认一般两三拍内就到（约 400ms），比等下一次心跳快得多。
  function spotifyRemoteBurstPoll(count) {
    var total = Math.max(1, Math.min(24, Number(count) || 1));
    spotifyRemoteBurstLeft = Math.max(spotifyRemoteBurstLeft, total);
    if (spotifyRemoteBurstTimer) return;
    function step() {
      spotifyRemoteBurstTimer = null;
      if (spotifyRemoteBurstLeft <= 0) return;
      spotifyRemoteBurstLeft -= 1;
      // 强制新鲜状态：服务端有 700ms 的读缓存，这里不能吃缓存，否则确认会白等一秒。
      spotifyRemotePoll(true);
      if (spotifyRemoteBurstLeft > 0) spotifyRemoteBurstTimer = setTimeout(step, spotifyRemoteBurstMs);
    }
    spotifyRemoteBurstTimer = setTimeout(step, spotifyRemoteBurstMs);
  }

  function spotifyRemoteStopBurst() {
    spotifyRemoteBurstLeft = 0;
    if (!spotifyRemoteBurstTimer) return;
    clearTimeout(spotifyRemoteBurstTimer);
    spotifyRemoteBurstTimer = null;
  }

  function spotifyRemoteClearPending() {
    spotifyRemotePendingUri = '';
    spotifyRemotePendingSince = 0;
    spotifyRemoteStopBurst();
    if (spotifyRemoteConfirmCalibrateTimer) {
      clearTimeout(spotifyRemoteConfirmCalibrateTimer);
      spotifyRemoteConfirmCalibrateTimer = null;
    }
  }

  // 客户端真的到这首了：解除守卫 → 立刻锚一次时间轴 → 1.2 秒后再复校一次。
  // 复校是必要的：客户端刚起播时进度可能还停在 0，只锚一次会把歌词顶在第一句。
  function spotifyRemoteConfirmHandover(state) {
    spotifyRemoteClearPending();
    spotifyRemoteSwitchingUntil = 0;
    spotifyRemoteSuppressUntil = Math.min(spotifyRemoteSuppressUntil || 0, Date.now() + 400);
    spotifyRemoteApplyingUntil = spotifyRemoteSuppressUntil;
    spotifyRemoteWatch.uri = String((state && state.uri) || '').trim();
    spotifyRemoteWatch.playing = !!(state && state.isPlaying);
    spotifyRemoteStartCalibration();
    spotifyRemoteCalibrate('switch-confirm');
    spotifyRemoteConfirmCalibrateTimer = setTimeout(function () {
      spotifyRemoteConfirmCalibrateTimer = null;
      if (spotifyRemoteActive && !spotifyRemotePendingUri) spotifyRemoteCalibrate('switch-recheck');
    }, 1200);
  }

  // 过了 confirmMs 还没确认：客户端切不过来。放开接管，让引擎按它原本的换源链路重跑这一首
  // —— 绝不把一段永远没声音的静音时钟留在那儿当"正在播放"。
  // A handover that never confirms is given back to the engine's normal fallback path.
  function spotifyRemoteAbortHandover(reason) {
    var song = spotifyRemoteCurrentSong();
    spotifyRemoteClearPending();
    spotifyRemoteSwitchingUntil = 0;
    spotifyRemoteDeactivate();
    if (!song || spotifyRemoteSongProvider(song) !== 'spotify') return false;
    // 上一次尝试留下的标记要清掉，否则换源链路会以为"这首已经交给客户端了"而直接返回成功。
    song.spotifyRemote = false;
    try {
      if (typeof playQueue !== 'undefined' && playQueue && playQueue[currentIdx]) playQueue[currentIdx].spotifyRemote = false;
    } catch (err) { /* 队列不在就只清手里的引用 */ }
    spotifyRemoteNotify('spotify_client_handover_failed', null, { reason: String(reason || '') });
    if (typeof playQueueAt !== 'function' || typeof currentIdx !== 'number') return false;
    var idx = currentIdx;
    setTimeout(function () {
      // 期间用户已经切歌就别再插手了。
      if (typeof currentIdx !== 'number' || currentIdx !== idx) return;
      if (spotifyRemoteCurrentSong() !== song) return;
      try { playQueueAt(idx, { spotifySkipTakeover: true }); } catch (err) { /* 换源自己会报错 */ }
    }, 0);
    return true;
  }

  function spotifyRemoteCheckHandoverDeadline() {
    if (!spotifyRemotePendingUri) return false;
    if (Date.now() - spotifyRemotePendingSince < spotifyRemoteConfirmMs) return false;
    return spotifyRemoteAbortHandover('unconfirmed');
  }

  function spotifyRemoteNoteMode(answer) {
    if (!answer) return;
    var mode = String(answer.mode || '');
    if (mode === 'api' || mode === 'dom') spotifyRemoteApiMode = mode;
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
      spotifyRemoteNoteMode(answer);
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
        // 静音 WAV 的 seek 是即时的，几百毫秒足够盖住它；窗口拉长只会让用户按键更容易被吞。
        spotifyRemoteApplyingUntil = Date.now() + 700;
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

  // 这个下标是不是"当前这首的紧邻上/下一首"（循环队列，队尾接队首）。
  // 只在顺序播放语义下成立：随机模式的分支顺序由 shuffle 维护，这里不做推断。
  // Whether the index is the immediate neighbour of the cursor in a looping queue.
  function spotifyRemoteQueueNeighbour(index) {
    try {
      if (typeof playQueue === 'undefined' || !playQueue || !playQueue.length) return false;
      var length = playQueue.length;
      if (index < 0 || index >= length) return false;
      if (typeof currentIdx !== 'number' || currentIdx < 0 || currentIdx >= length) return false;
      if (length <= 1) return true;
      return index === (currentIdx + 1) % length || index === (currentIdx - 1 + length) % length;
    } catch (err) {
      return false;
    }
  }

  // 队列里「上一首 / 当前 / 下一首」这三格。混队列（Spotify 歌与别家源混排）时，只要
  // 附近三格有 Spotify，客户端就必须一直被盯着：既不能在 MR 播别家源时继续出声，
  // 也不能等到真轮到了才临时找通道。队列不足四首时整个队列都算窗口 —— 那时"附近"没意义。
  // The three slots around the cursor. In a mixed queue any nearby Spotify track keeps the
  // client supervised; for very short queues the whole queue counts as "nearby".
  function spotifyRemoteQueueWindow() {
    try {
      if (typeof playQueue === 'undefined' || !playQueue || !playQueue.length) return [];
      var length = playQueue.length;
      var idx = (typeof currentIdx === 'number' && currentIdx >= 0) ? currentIdx : -1;
      if (idx < 0 || idx >= length) return [];
      if (length <= 3) return playQueue.slice(0, length);
      var offsets = [-1, 0, 1];
      var slots = [];
      for (var i = 0; i < offsets.length; i++) {
        slots.push(playQueue[(idx + offsets[i] + length) % length]);
      }
      return slots;
    } catch (err) {
      // 队列可能还没建好（首屏启动瞬间），当成"附近没有 Spotify"处理。
      return [];
    }
  }

  function spotifyRemoteQueueWindowHasSpotify() {
    var slots = spotifyRemoteQueueWindow();
    for (var i = 0; i < slots.length; i++) {
      if (spotifyRemoteSongProvider(slots[i]) === 'spotify') return true;
    }
    return false;
  }

  // 客户端正在放**队列里**的某首 Spotify，而 MR 当前这首不是它（已经切到别家源）：
  // 那是我们之前点播留下的残响，必须停掉 —— 否则 MR 播着网易云、客户端还在唱上一首，
  // 两个声音一起响，而且等下一首 Spotify 轮到时会发现它早已跑到别处。
  // 这条只处理"队列里的那首"：用户在 Spotify 里自由听别的歌时不打扰（原有边界，别扩大）。
  // A leftover client track from our own earlier takeover must be silenced; free listening is
  // left alone.
  function spotifyRemoteHoldStrayClient() {
    if (spotifyRemoteActive) return false;
    if (!spotifyRemoteAvailable || !spotifyRemoteState) return false;
    if (!spotifyRemoteState.isPlaying) return false;
    if (!spotifyRemoteQueueWindowHasSpotify()) return false;
    var uri = String(spotifyRemoteState.uri || '').trim();
    if (!uri) return false;
    if (spotifyRemoteFindQueuedIndex(uri) < 0) return false;
    // 刚发过暂停就别再发：deactivate 已经按过一次，这里只是兜住"它又自己响起来"的情况。
    if (spotifyRemoteCommandJustSent('Pause', 4000)) return false;
    spotifyRemoteCommand('Pause');
    return true;
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
    // 点播回执：客户端真的到我们请求的那首了 —— 立刻解除切歌守卫并锚一次时间轴。
    if (spotifyRemotePendingUri && uri && uri === spotifyRemotePendingUri) {
      spotifyRemoteConfirmHandover(state);
    }
    var trackedUri = watch.uri;
    watch.uri = uri;
    var wasPlaying = watch.playing;
    watch.playing = playing;

    // 只在客户端接管期间判断：没接管时那是用户在 Spotify 里自由听歌，不该被 MR 打断。
    if (!spotifyRemoteActive) return;

    // 1) 客户端自己换歌（有人点了下一首，也可能是这首自然播完后它跳去自己的队列）。
    //    MR 是主：只有跳到的正好是 MR 队列里**紧邻**的那一首，才算"和我们同步的操作"；
    //    其余一律不动 MR 的队列，只如实提示当前实际在放什么。否则客户端的随机列表会把
    //    混队列的播放顺序整个拽乱，MR 的静音时钟还会被换成另一首的进度。
    //    MR owns the queue: only a jump to an adjacent queued track counts as a synced action.
    if (uri && trackedUri && uri !== trackedUri && Date.now() > watch.followUntil) {
      var song = spotifyRemoteCurrentSong();
      var mine = song ? String(song.spotifyUri || song.uri || '').trim() : '';
      // 我们刚让客户端放的就是这首（点播回执），不算"客户端自己切"。
      if (uri !== mine) {
        var queued = spotifyRemoteFindQueuedIndex(uri);
        var label = String(state.title || '').trim() || uri;
        if (queued >= 0 && spotifyRemoteQueueNeighbour(queued) && typeof playQueueAt === 'function') {
          // 跟着客户端走：MR 换成同一首，歌词/封面/进度才对得上。
          watch.followUntil = Date.now() + 6000;
          spotifyRemoteNotify('spotify_client_followed', null, { title: label });
          try {
            playQueueAt(queued, { spotifyFollowClient: true, startupAutoplay: true });
          } catch (err) { /* 跳不过去就保持镜像，至少进度是真实的 */ }
        } else if (queued < 0) {
          // 对不上队列：不假装还能对上，明确告诉用户当前实际在放什么。
          spotifyRemoteNotify('spotify_client_foreign', null, { title: label });
        }
        // 队列里有、但不在相邻位置：客户端被别处拽走了。MR 不跟，也不提示 ——
        // 它既不是我们的下一首，也不是"队列外的歌"，等它自己放完或用户重新接管即可。
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
        spotifyRemoteApplyingUntil = Date.now() + 600;
        spotifyRemoteSuppressUntil = Date.now() + 600;
        media.pause();
      } catch (err) { /* 忽略 */ }
    }
    spotifyRemoteStopCalibration();
    spotifyRemoteNotify('spotify_client_disconnected', null);
  }

  // 让客户端播放这一首。走服务端的"搜索 + 点结果行"，不碰 spotify: 协议。
  // fast 只在"有 uri 且桥已可用"时才有意义：服务端把点播发出去就返回，不再等 7 秒回执。
  // Ask the local client to play this exact track; the server drives the search UI.
  function spotifyRemoteRequestTrack(song, fast) {
    if (!song) return Promise.resolve({ ok: false, error: 'no-song' });
    var query = 'title=' + encodeURIComponent(String(song.name || '')) +
      '&artist=' + encodeURIComponent(String(song.artist || '')) +
      '&uri=' + encodeURIComponent(String(song.spotifyUri || song.uri || '')) +
      (fast ? '&fast=1' : '');
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
  // ⚠️ 客户端此刻若不是这一首（混队列切歌的瞬间它可能还停在上一首），它的时长就毫无意义：
  //    拿错时长当静音时钟长度，`ended` 会在错误的时刻触发，队列节奏整个错开。
  // Prefer the freshly confirmed client duration: that is the version actually playing — but
  // only when the client really is on this track, otherwise the clock would end at the wrong time.
  function spotifyRemotePlaybackData(song) {
    var state = spotifyRemoteState || {};
    var fresh = state.receivedAt && (Date.now() - Number(state.receivedAt)) < 20000;
    var songMs = Math.round((Number(song && song.duration) || 0) * 1000);
    var sameTrack = spotifyRemoteClockMatches(song, state);
    var clientMs = sameTrack ? (Number(state.durationMs) || 0) : 0;
    var durationMs = Math.max(1000, (fresh && clientMs) || songMs || clientMs || 240000);
    return {
      provider: 'spotify',
      url: spotifyRemoteSilentWavUrl(durationMs),
      directUrl: true,
      remote: true,
      durationMs: durationMs,
      remoteTitle: sameTrack ? String(state.title || '') : '',
      remoteArtist: sameTrack ? String(state.artist || '') : '',
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
      // 1.2 秒足够（实测 300~600ms 就跟上了），拖完立刻能继续对表。
      spotifyRemoteUserSeekUntil = Date.now() + 1200;
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
    // 客户端放的已经不是这一首（有人在 Spotify 里滑走了、或它自己跳去别的歌）：
    // 绝不拿另一首歌的进度去改这个时钟，否则歌词、进度条、动画会一起错位。
    // 拿不到当前曲目时按"就是这一首"处理 —— 能走到这里说明 handleTrackStart 刚确认过接管。
    // Never map another track's position onto this clock.
    var currentSong = spotifyRemoteCurrentSong();
    var sameTrack = currentSong ? spotifyRemoteClockMatches(currentSong, state) : true;
    var targetSeconds = Math.max(0, Number(state.positionMs) || 0) / 1000;
    var drift = targetSeconds - (media.currentTime || 0);
    var applying = false;
    // 本地时钟被重置回开头（单曲循环的 loop、或用户重播），客户端却还停在曲尾：
    // 让它也从头开始。不这样的话位置纠偏会把本地时钟一次次拽回结尾，声音停在最后一句，
    // 而进度条还在转 —— 表现就是"这一首再也不动了"。
    // A clock reset to the top (single-repeat) must pull the client back to the top as well.
    if (sameTrack && !state.isPlaying && (media.currentTime || 0) < 1.5
      && Date.now() >= spotifyRemoteUserSeekUntil) {
      var tailGuardMs = (Number(state.durationMs) || 0) - 3000;
      if (tailGuardMs > 0 && (Number(state.positionMs) || 0) >= tailGuardMs
        && !spotifyRemoteCommandJustSent('Seek', 3000)) {
        spotifyRemoteCommand('Seek', { position: 0 });
        spotifyRemoteCommand('Play');
        spotifyRemoteState = Object.assign({}, state, { isPlaying: true, positionMs: 0 });
        // 客户端要几百毫秒才真正回到开头；这段时间里别拿那份旧位置再判一次。
        spotifyRemoteUserSeekUntil = Date.now() + 1200;
        return;
      }
    }
    // 刚拖完进度条的这两秒里，客户端报的还是旧位置（它要几百毫秒才跟上）。
    // 这期间只放行"跟着客户端停/放"，不做位置纠偏 —— 否则进度条会当着用户的面跳回去。
    // Right after a seek the client still reports the old position for a few hundred ms: mirror
    // play/pause as usual, but never correct the clock from that stale value.
    if (sameTrack
      && Date.now() >= spotifyRemoteUserSeekUntil
      && Math.abs(drift) > 1.25 && Number.isFinite(media.duration) && media.duration > 0) {
      applying = true;
      try { media.currentTime = Math.min(media.duration, targetSeconds); } catch (err) { applying = false; }
    }
    // 播放态：**MR 是主，客户端只负责出声**。
    //   · MR 正在播、客户端却停了（被系统/账号/别的设备暂停，或这首在客户端已经放完）：
    //     不能把 MR 的静音时钟一起停住 —— 它一停 audio.onended 就永远不触发，混队列的
    //     循环就断在这里（上一首网易云、下一首 Spotify 时最典型）。把它拉回来继续。
    //     唯一例外是它真的已经播到结尾：那就别叫它重播，让 MR 的时钟自己走完进下一首。
    //   · MR 暂停着、客户端却在放：只有 MR 自己也想播（切歌后本地还没起来）才让本地跟上；
    //     用户刚按的暂停绝不能被对表撤销，否则播放/暂停键会时灵时不灵。
    // Playback authority: MR owns play/pause, the client only provides sound. A client that
    // stops must never stop the silent clock, or `ended` never fires and the queue stalls.
    if (!state.isPlaying && !media.paused) {
      var endGuardMs = (Number(state.durationMs) || 0) - 1500;
      var clientAtEnd = endGuardMs > 0 && (Number(state.positionMs) || 0) >= endGuardMs;
      if (!clientAtEnd && !spotifyRemoteCommandJustSent('Play', 3000)) {
        spotifyRemoteCommand('Play');
      }
    } else if (state.isPlaying && media.paused) {
      // MR 的播放态是权威：用户刚按了暂停（`playing` 为 false）、客户端还没跟上，
      // 这时候把本地静音时钟 play 回来，等于用对表撤销用户的操作 —— 暂停键就失灵了。
      // 只有 MR 自己也想播（切歌后本地还没起来）才让本地跟上。
      // MR owns the play state: never undo a user pause just because the client lags behind.
      var mrWantsPlay = (typeof playing === 'undefined') ? true : !!playing;
      if (mrWantsPlay && !spotifyRemoteCommandJustSent('Pause', 3000)) {
        applying = true;
        try { var playingPromise = media.play(); if (playingPromise && playingPromise.catch) playingPromise.catch(function () { }); } catch (err) { /* 忽略 */ }
      }
    }
    if (applying) {
      spotifyRemoteApplyingUntil = Date.now() + 600;
      // 对表会引起 audio 的 play/pause，这些事件不能被当成"用户在操作"转发给客户端。
      if (spotifyRemoteSuppressUntil < Date.now() + 600) spotifyRemoteSuppressUntil = Date.now() + 600;
    }
  }

  function spotifyRemotePoll(force) {
    return spotifyRemoteApi('/api/spotify/client/state' + (force ? '?force=1' : '')).then(function (answer) {
      spotifyRemoteNoteMode(answer);
      spotifyRemoteAvailable = !!(answer && answer.available && answer.state);
      if (spotifyRemoteAvailable) {
        spotifyRemoteState = answer.state;
        spotifyRemoteLastOkAt = Date.now();
        // 每轮都过一遍观察器：换歌、意外停止都在这里被发现，不必等 12 秒的校准。
        spotifyRemoteNoteState(answer.state, force ? 'burst' : 'poll');
      } else if (spotifyRemoteActive) {
        // 通道读不到：连续两次就当成中断（进程退出、调试端口没了）。
        spotifyRemoteNoteChannelMiss();
      }
      // 交接超时：客户端一直没到那首就交还给换源链路，别让静音时钟空转。
      spotifyRemoteCheckHandoverDeadline();
      // 当前这首不是 Spotify、但队列前后有 Spotify：客户端要是还在放我们之前点播的那首，
      // 现在就按停它。这一步必须在 syncToAudio 之前 —— 那个函数只在接管期间才有意义。
      spotifyRemoteHoldStrayClient();
      spotifyRemoteSyncToAudio();
      return answer;
    }).catch(function () {
      spotifyRemoteAvailable = false;
      if (spotifyRemoteActive) spotifyRemoteNoteChannelMiss();
    });
  }

  // 通道没起来时，先请主进程用调试端口把客户端拉起来（已经在跑的实例绝不打断），
  // 再等它出现在那个每次随机的本地端口上（端口由主进程记着，前端不必知道）。
  // 这样用户第一次点 Spotify 歌就能直接进入远程模式，不必自己去改快捷方式。
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
      var deadline = Date.now() + 6000;
      function waitForChannel() {
        return spotifyRemoteApi('/api/spotify/client/state?force=1').then(function (state) {
          spotifyRemoteNoteMode(state);
          if (state && state.available && state.state) {
            spotifyRemoteAvailable = true;
            spotifyRemoteState = state.state;
            spotifyRemoteLastOkAt = Date.now();
            spotifyRemoteNoteState(state.state, 'channel');
            return true;
          }
          if (Date.now() > deadline) return false;
          // 刚拉起的客户端其实几百毫秒就可能就绪，250ms 一探比 600ms 一探少等一个身位。
          return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(waitForChannel);
        }).catch(function () { return false; });
      }
      return waitForChannel();
    }).catch(function () { return false; });
  }

  // 切歌时决定"这一首归谁管"。返回 Promise<boolean>，true 表示已由客户端接管，调用方不要再唤起一次。
  // 三条路径按"要等多久"排：已在目标曲目上（零等待）→ 通道在、要切歌（乐观，不等回执）
  // → 通道未知（必须等客户端被拉起，这条天然慢，改不了）。
  // Resolves to true only when this track is handed to the client, so the caller can keep its
  // original switch_source path when the client cannot comply.
  function spotifyRemoteHandleTrackStart(song) {
    // 用归一化后的平台判定，和播放引擎、观察器保持同一套规则：
    // 混队列里的歌可能只带 source / spotifyUri 而没有 provider。
    if (!song || spotifyRemoteSongProvider(song) !== 'spotify') {
      // 走同一条退出路径：切到别家源时要把客户端按停，否则它会继续唱上一首。
      spotifyRemoteClearPending();
      spotifyRemoteDeactivate();
      return Promise.resolve(false);
    }
    if (!spotifyRemoteAvailable || !spotifyRemoteState) {
      // 客户端可能压根没开：先试着用调试端口拉起来，拉不起来就交给上层换源。
      return spotifyRemoteEnsureChannel().then(function (ready) {
        return ready ? spotifyRemoteHandleTrackStart(song) : false;
      });
    }
    spotifyRemoteSongKey = String(song.name || '') + '|' + String(song.artist || '');
    var targetUri = String(song.spotifyUri || song.uri || '').trim();
    // 客户端就在这一首上：别再点播打断它。两种情形分开处理 ——
    //   正在播 = 用户本来就在听这首（启动时恢复上次播放），保留它的进度；
    //   停着   = 我们从它那里切走时按过暂停（或用户自己停的），队列轮到它要**从头**放。
    if (spotifyRemoteClockMatches(song, spotifyRemoteState)) {
      spotifyRemoteClearPending();
      spotifyRemoteActive = true;
      spotifyRemoteSwitchingUntil = 0;
      // 抑制窗口只负责盖住"我们自己的 seek / play"引起的 audio 事件，不需要 2.2 秒那么久；
      // 窗口越长，用户这段时间里按的暂停/播放越可能被当成噪声吞掉。
      spotifyRemoteSuppressUntil = Date.now() + 600;
      spotifyRemoteApplyingUntil = spotifyRemoteSuppressUntil;
      // 客户端停在这一首上（我们从它那里切走时按过暂停，或者上次退出就停在这）：
      // 队列轮到它时应该**从头**放，不能接着上次的进度。不 seek 的话 MR 的静音时钟
      // 会被拉到那个旧位置，歌从中间开始；客户端一直停着还会让本地时钟走不动。
      // A client parked on this track must restart from the top when the queue reaches it.
      if (!spotifyRemoteState.isPlaying) {
        var parkedMs = Number(spotifyRemoteState.positionMs) || 0;
        // 刚 seek 过，轮询里那份旧位置别再把时钟拽回去。
        if (parkedMs > 1000) spotifyRemoteUserSeekUntil = Date.now() + 1200;
        spotifyRemoteCommand('Seek', { position: 0 });
        spotifyRemoteCommand('Play');
        spotifyRemoteState = Object.assign({}, spotifyRemoteState, { isPlaying: true, positionMs: 0 });
      }
      // 观察器的基准同步到这一首，免得下一轮把"我们自己的接管"误判成客户端换歌。
      spotifyRemoteWatch.uri = String(spotifyRemoteState.uri || '').trim();
      spotifyRemoteWatch.playing = !!spotifyRemoteState.isPlaying;
      spotifyRemoteStartCalibration();
      return Promise.resolve(true);
    }
    // 客户端在别的歌上。先把本地时钟放走（下面立刻 return true），点播在后台发。
    spotifyRemoteActive = true;
    spotifyRemoteSuppressUntil = Date.now() + 700;
    spotifyRemoteApplyingUntil = spotifyRemoteSuppressUntil;
    spotifyRemoteStartCalibration();
    // 只有"精确点播（有 uri）且桥已可用"才能乐观：这两个条件不满足时，服务端要么走
    // 1~9 秒的搜索点击（DOM 兜底），要么第一次注入桥，都可能在秒级之后才出结果 ——
    // 那种情况仍然等结果，失败就交还换源，绝不拿一段可能永远没声音的静音时钟去赌。
    // Optimism needs a URI and a live bridge; otherwise the request is awaited as before.
    var useFast = !!targetUri && spotifyRemoteApiMode === 'api';
    if (!useFast) {
      // 切歌守卫要长（校准与对表都要等客户端到这首），但**事件抑制**不能跟着一起长：
      // 这期间引擎只是在等，没有我们自己造成的 audio 事件；2.5 秒足够盖住收尾，
      // 之后用户按的暂停/播放必须是有效的。
      spotifyRemoteSwitchingUntil = Date.now() + 12000;
      spotifyRemoteSuppressUntil = Date.now() + 2500;
      spotifyRemoteApplyingUntil = spotifyRemoteSuppressUntil;
      return spotifyRemoteRequestTrack(song, false).then(function (answer) {
        if (answer && answer.ok && answer.state) {
          spotifyRemoteState = answer.state;
          spotifyRemoteAvailable = true;
          spotifyRemoteLastOkAt = Date.now();
          spotifyRemoteSwitchingUntil = 0;
          spotifyRemoteSuppressUntil = Date.now() + 600;
          spotifyRemoteApplyingUntil = spotifyRemoteSuppressUntil;
          spotifyRemoteWatch.uri = String(answer.state.uri || '').trim();
          spotifyRemoteWatch.playing = !!answer.state.isPlaying;
          spotifyRemoteStartCalibration();
          return true;
        }
        spotifyRemoteDeactivate();
        return false;
      }).catch(function () {
        spotifyRemoteDeactivate();
        return false;
      });
    }
    // 有 URI：精确点播。发出去就返回，确认交给 burst 轮询（一般 400ms 内到），
    // confirmMs 还没到就由看门狗交还给换源。
    spotifyRemotePendingUri = targetUri;
    spotifyRemotePendingSince = Date.now();
    spotifyRemoteSwitchingUntil = spotifyRemotePendingSince + spotifyRemoteConfirmMs + 400;
    spotifyRemoteBurstPoll(10);
    spotifyRemoteRequestTrack(song, true).then(function (answer) {
      // 期间用户可能已经切走：只处理仍属于这次交接的回执。
      if (spotifyRemotePendingUri !== targetUri) return;
      spotifyRemoteNoteMode(answer);
      if (!answer || !answer.ok) {
        // fast 当场失败通常是"页面正在重载 / 桥还没注入"这类瞬时问题：别急着判死刑，
        // 交给慢路径（等页面就绪 + 搜索兜底）再试一次；4 秒内还没成，看门狗会收尾。
        // A fast rejection is usually transient (page reloading, bridge not injected yet):
        // retry once on the slow path instead of failing the handover outright.
        spotifyRemoteRequestTrack(song, false).then(function (slow) {
          if (spotifyRemotePendingUri !== targetUri) return;
          if (slow && slow.ok && slow.state) {
            spotifyRemoteState = slow.state;
            spotifyRemoteAvailable = true;
            spotifyRemoteLastOkAt = Date.now();
            spotifyRemoteNoteState(slow.state, 'play-track-retry');
            return;
          }
          spotifyRemoteAbortHandover(String((answer && answer.error) || (slow && slow.error) || 'rejected'));
        }).catch(function () {
          if (spotifyRemotePendingUri === targetUri) spotifyRemoteAbortHandover('network');
        });
        return;
      }
      if (answer.state) {
        // 服务端顺手回了一份新鲜状态（已在目标曲目 / 点播后马上读到的）：直接当确认。
        spotifyRemoteState = answer.state;
        spotifyRemoteAvailable = true;
        spotifyRemoteLastOkAt = Date.now();
        spotifyRemoteNoteState(answer.state, 'play-track');
      }
    }).catch(function () {
      if (spotifyRemotePendingUri === targetUri) spotifyRemoteAbortHandover('network');
    });
    return Promise.resolve(true);
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
    }, 120);
  }

  function spotifyRemoteDeactivate() {
    var wasActive = spotifyRemoteActive;
    spotifyRemoteActive = false;
    spotifyRemoteSongKey = '';
    spotifyRemoteSwitchingUntil = 0;
    // 交接状态一起作废：还在等确认的话，那些回执已经没有意义了。
    spotifyRemoteClearPending();
    // 观察器一起复位：换到别的源以后，客户端的任何动作都不再是"我们的播放状态"。
    spotifyRemoteWatch.uri = '';
    spotifyRemoteWatch.playing = false;
    spotifyRemoteWatch.misses = 0;
    spotifyRemoteWatch.interruptedAt = 0;
    // 一旦不再由客户端接管，校准必须立刻停 —— 它只服务于"MR 前端 + Spotify 源"这一种状态。
    spotifyRemoteStopCalibration();
    // 从 Spotify 源切到别家源：客户端刚才放的正是我们点播的那一首，MR 走了它还在唱，
    // 于是 MR 播网易云、客户端唱上一首 Spotify，两个声音一起响；而且等下一首 Spotify
    // 轮到时它已经停在上次的进度上（甚至早就放完了），接回来就是"停住不动"。
    // 主动按一次暂停，把声音交还给 MR。没接管过就不碰 —— 那是用户自己在 Spotify 里听歌。
    // Leaving Spotify: silence the client we started, or it keeps singing under the other source.
    if (wasActive) spotifyRemoteCommand('Pause');
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
      spotifyRemoteClearPending();
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
    // 混队列诊断：当前三格里有没有 Spotify、客户端有没有被我们按停。
    queueWindowHasSpotify: spotifyRemoteQueueWindowHasSpotify,
    holdStrayClient: spotifyRemoteHoldStrayClient,
    // 交接诊断：还在等哪一首确认、密集轮询剩几次、服务端走的是哪条通道。
    handover: function () {
      return {
        pendingUri: spotifyRemotePendingUri,
        pendingMs: spotifyRemotePendingUri ? (Date.now() - spotifyRemotePendingSince) : 0,
        confirmMs: spotifyRemoteConfirmMs,
        burstLeft: spotifyRemoteBurstLeft,
        apiMode: spotifyRemoteApiMode,
        switchingLeftMs: Math.max(0, spotifyRemoteSwitchingUntil - Date.now()),
      };
    },
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
