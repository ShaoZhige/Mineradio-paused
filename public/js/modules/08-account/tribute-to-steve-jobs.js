'use strict';

// ── TributeToSteveJobs —— Apple Music 的远程播放部件 / the Apple Music part ─────────
//
// 对标 08-account/pillager-spotify.js 的 PillagerSpotify：**一个父函数拥有整套机制**，
// 外部只拿到 `AppleMusic` 这一个对象。搬进来之前，这套逻辑散在 05-playback/13 里，
// 于是同一类 bug（宿主卡死、暂停被采样翻回去、超时被当成未登录、id 三套命名空间）
// 换着形式反复出现 —— 每次修都在"哪一层该负责"上重新猜一遍。
//
// 为什么不叫 AppleMusicPart：这是给 Steve Jobs 的致敬 —— 这台机器上唯一还在认真放
// Apple Music 的东西，名字就别再叫 pillager 了。
//
// 对外契约（AppleMusic.*）：
//   isSong(song) / isActive()           判定
//   play(song, idx, token, opts)        起播
//   toggle() / seek(seconds)            暂停/继续、拖动
//   currentSeconds()                    进度条 / 歌词 / MediaSession 的唯一读数来源
//   stop(reason)                        收尾
//   request(op, params)                 原始通道（只在需要诊断时用）
//   errorInfo(code)                     错误分类：提示什么 / 算不算登出 / 能不能重试
//   openWindow()                        把宿主窗口调出来（登录用）
//
// 内部的轮询、心跳看门狗、单调时钟、命令宽限期、结束收尾、错误表全部**闭在闭包里**，
// 外部拿不到也就改不坏。老的那些全局函数名保留为转发器，调用点不用一次改完。

function TributeToSteveJobs() {
    var externalPlaybackPollTimer = 0;
    var externalPlaybackPollBusy = false;
    var externalPlaybackFailures = 0;
    // 心跳看门狗。/ Heartbeat watchdog.
    // 🔴 实测事故（2026-11-22）：AM 在窗口里暂停后，进度条和播放图标**一直往前走**，日志里
    // `playbackStatus` 轮询在暂停后 33 秒一条都没有。两种可能都会造成这个现象：某一次轮询
    // 的 Promise 没 settle（`externalPlaybackPollBusy` 永远卡在 true），或者定时器被意外清掉。
    // 两种都不该让界面假装还在播 —— 所以再加两道闸：
    //   1. 单次轮询最多占住 busy 这么久，超过就解闸并重建心跳（有日志可查）；
    //   2. 状态超过这么久没刷新，就把时钟冻住并翻回暂停图标（宁可停，也不许无中生有地往前跑）。
    // A wedged poll used to leave `busy` stuck and the UI pretending to play forever.
    // 1) un-wedge a poll that has held the flag too long and re-arm the heartbeat;
    // 2) freeze the clock and flip the icon back once the state is stale.
    var EXTERNAL_PLAYBACK_POLL_WATCHDOG_MS = 6000;
    var EXTERNAL_PLAYBACK_STALE_MS = 6000;
    var externalPlaybackPollBusySince = 0;
    // 用户按过播放/暂停之后，多久之内的矛盾采样不采信（MusicKit 的 isPlaying 有滞后）。
    // How long contradicting samples are ignored after an explicit play/pause command.
    var EXTERNAL_COMMAND_GRACE_MS = 3000;

    function externalAppleMusicRequest(operation, params) {
      var bridge = typeof window !== 'undefined' ? window.desktopWindow : null;
      if (!bridge || typeof bridge.appleMusicRequest !== 'function') {
        return Promise.resolve({ ok: false, error: 'runtime-unavailable' });
      }
      try {
        return Promise.resolve(bridge.appleMusicRequest(operation, params || {}));
      } catch (error) {
        return Promise.resolve({ ok: false, error: 'runtime-unavailable' });
      }
    }
    function isExternalAppleMusicSong(song) {
      return !!(song && (
        song.provider === 'applemusic' ||
        song.provider === 'appleMusic' ||
        song.source === 'applemusic' ||
        song.source === 'appleMusic' ||
        song.playbackMode === 'external' ||
        song.externalPlayback === true
      ) && (song.catalogId || song.appleMusicId || song.providerSongId || song.id));
    }
    function isExternalPlaybackActive() {
      return !!(typeof externalPlaybackState !== 'undefined' && externalPlaybackState && externalPlaybackState.provider === 'applemusic');
    }
    // 外部播放的显示时钟：本地自己走 + 轮询结果只做**有阈值的纠正**。
    //
    // 参考 Folia 的 `src/utils/nowPlayingClock.ts`：
    //   * 取回的 positionMs 属于"取样那一刻"，所以要补偿半个 RTT（`progressMs + rtt/2`）；
    //   * 只有候选值与当前显示的差超过 0.2s 才纠正，否则让本地时钟继续走。
    //
    // 之前的写法是每次轮询都拿报告值做 max()，等于把 RTT 抖动、采样偏早这些噪声**直接画到
    // 进度条上**——看着就是来回跳。现在小漂移用缓动收敛（每拍只吃掉 15%），大跳变才吸附，
    // 而且回退必须连续两次轮询确认（MusicKit 重建播放器时会瞬时吐出 position=0）。
    // Local clock + thresholded correction, following Folia's nowPlayingClock: compensate half the
    // RTT, and only correct when the candidate drifts more than 0.2s from what is displayed.
    var EXTERNAL_PLAYBACK_DRIFT_TOLERANCE_SEC = 0.2;
    var EXTERNAL_PLAYBACK_JUMP_TOLERANCE_SEC = 1.2;
    var EXTERNAL_PLAYBACK_EASE_RATIO = 0.15;
    function externalPlaybackClock(state, now) {
      var base = Number(state.clockSeconds);
      var baseAt = Number(state.clockAt);
      if (!isFinite(base) || base < 0) {
        base = Math.max(0, (Number(state.positionMs) || 0) / 1000);
        baseAt = now;
      }
      if (!state.isPlaying) baseAt = now; // 暂停时本地时钟不推进
      var display = base + (state.isPlaying ? Math.max(0, (now - baseAt) / 1000) : 0);
      return { base: base, baseAt: baseAt, display: display };
    }
    function externalPlaybackStateIsStale(state, now) {
      var updatedAt = Number(state && state.updatedAt);
      return !!(state && state.isPlaying && updatedAt > 0 && now - updatedAt > EXTERNAL_PLAYBACK_STALE_MS);
    }
    function externalPlaybackCurrentSeconds() {
      var state = externalPlaybackState;
      if (!state) return 0;
      var now = Date.now();
      // 🔴 心跳断了就不能再假装在播：AM 已经暂停（或在窗口里被暂停）时，界面以前会继续往前跑，
      // 因为 `isPlaying` 只有轮询会改。这里用"多久没刷新"当兜底：一旦判定失联，冻住时钟、
      // 翻回暂停图标，等心跳恢复再由真正的状态覆盖。只触发一次（updatedAt 清零）。
      // A dead heartbeat must not keep the UI pretending to play: freeze the clock and flip the icon
      // back, once, until a real sample arrives.
      if (externalPlaybackStateIsStale(state, now)) {
        state.isPlaying = false;
        state.pausedStreak = 0;
        state.updatedAt = 0;
        if (typeof logEvent === 'function') logEvent('playback', 'am-poll-stale', { frozenAtSec: Math.round(Number(state.positionMs) || 0) / 1000 }, 'warn');
        try { if (typeof playing !== 'undefined') playing = false; } catch (e) { }
        try { if (typeof setPlayIcon === 'function') setPlayIcon(false); } catch (e) { }
      }
      var clock = externalPlaybackClock(state, now);
      var base = clock.base;
      var baseAt = clock.baseAt;
      var display = clock.display;

      if (state.sampleValid) {
        state.sampleValid = false;
        var sampleSeconds = Math.max(0, Number(state.sampleSeconds) || 0);
        var sampleAt = Number(state.sampleAt) || now;
        // 候选值 = 取样位置 + 从取样时刻到现在的时长（取样时刻已含 RTT/2 补偿）。
        var candidate = state.isPlaying
          ? sampleSeconds + Math.max(0, (now - sampleAt) / 1000)
          : sampleSeconds;
        var drift = candidate - display;
        if (Math.abs(drift) > EXTERNAL_PLAYBACK_DRIFT_TOLERANCE_SEC) {
          if (Math.abs(drift) > EXTERNAL_PLAYBACK_JUMP_TOLERANCE_SEC) {
            var pending = Number(state.pendingJumpSeconds);
            if (isFinite(pending) && pending >= 0 && Math.abs(sampleSeconds - pending) <= 2) {
              // 连续两次都落在同一处 = 真的跳转/seek。
              state.pendingJumpSeconds = -1;
              base = sampleSeconds;
              baseAt = sampleAt;
              display = candidate;
            } else {
              state.pendingJumpSeconds = sampleSeconds;
              // 只记疑点，这一拍不动显示。
            }
          } else {
            // 小漂移：缓动收敛，肉眼看不到台阶。
            base = display + drift * EXTERNAL_PLAYBACK_EASE_RATIO;
            baseAt = now;
            display = base;
          }
        } else if (Math.abs(drift) > 0) {
          state.pendingJumpSeconds = -1;
        }
      }

      state.clockSeconds = base;
      state.clockAt = baseAt;
      return Math.max(0, display);
    }
    function stopExternalPlaybackPolling() {
      if (externalPlaybackPollTimer) {
        clearInterval(externalPlaybackPollTimer);
        externalPlaybackPollTimer = 0;
      }
      externalPlaybackPollBusy = false;
      externalPlaybackFailures = 0;
    }
    function stopExternalPlayback(reason) {
      stopExternalPlaybackPolling();
      var state = externalPlaybackState;
      externalPlaybackState = null;
      if (state && state.isPlaying) {
        void externalAppleMusicRequest('pause', {});
      }
      if (typeof playing !== 'undefined' && reason !== 'keep-ui') {
        playing = false;
        if (typeof setPlayIcon === 'function') setPlayIcon(false);
      }
      if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    }
    function applyExternalPlaybackState(result, timing) {
      var state = externalPlaybackState;
      if (!state || !result || result.ok !== true) return;
      var data = result.data || {};
      // 🔴 用户刚按过暂停/播放时，MusicKit 的 `isPlaying` 会**滞后几秒**才跟上（实测按暂停后
      // 连拍仍在报 playing）。照收的话本地状态会被打回"正在播"，于是下一次点播放又发一条
      // `pause` —— 用户看到的就是"暂停后按播放没反应"（日志里是同一个 pause 反复发出）。
      // 命令发出后的一小段时间内，与命令矛盾的采样一律不采信。
      // MusicKit's isPlaying lags behind an explicit pause/resume for a few seconds. Trusting it
      // reverted the local state, so the next click sent pause again ("play does nothing").
      var samplePlaying = data.isPlaying === true;
      var commandAt = Number(state.commandAt) || 0;
      if (commandAt && Date.now() - commandAt < EXTERNAL_COMMAND_GRACE_MS) {
        var commandedPlaying = state.commandPlaying === true;
        if (samplePlaying !== commandedPlaying) samplePlaying = commandedPlaying;
      } else if (commandAt) {
        state.commandAt = 0;
      }
      // 单拍 isPlaying:false 不能立刻冻结时钟：MusicKit 每隔几拍会瞬时吐一次暂停态，照收的话
      // 歌词/进度会停住半秒（用户看到的"卡顿"）。连续两拍都是暂停才算真的暂停。
      // A single paused sample is noise; only two in a row count as a real pause.
      if (samplePlaying) {
        state.pausedStreak = 0;
        state.isPlaying = true;
      } else {
        state.pausedStreak = (Number(state.pausedStreak) || 0) + 1;
        state.isPlaying = state.pausedStreak >= 2;
      }
      state.positionMs = Math.max(0, Number(data.positionMs) || 0);
      // 🔴 时长属于**曲目**，不属于这次轮询：它一变，`当前/总长` 的百分比就整体缩放，进度条
      // 看着就是"来回跳"。以前按"差值 >1s 才更新"糊弄，只要服务端在两个值之间摆动就会每轮
      // 缩放一次。现在按曲目 id 钉死：换曲才重新取时长。
      // Duration belongs to the track, not to the poll: keyed by item id, it can no longer wobble
      // within one track and rescale the progress bar on every tick.
      var itemId = String(data.itemId || data.catalogId || '');
      var reportedDurationMs = Math.max(0, Number(data.durationMs) || 0);
      if (itemId && state.durationItemId !== itemId) {
        state.durationItemId = itemId;
        if (reportedDurationMs > 0) state.durationMs = reportedDurationMs;
        // ⚠️ 这里**不重置**显示时钟。itemId 有可能在两次轮询之间抖动（itemId 为空时回落到
        // catalogId，两者不是同一个值域），一旦据此重置锚点，时钟就会倒退一大截——三个歌词样式
        // 的"回退跳动"正是这么来的。真换曲时位置会掉到 0，交给下面的跳变确认逻辑处理。
        // Do NOT re-anchor the clock here: itemId can flap between responses, and re-anchoring on
        // that made the lyric clock step backwards. Real track changes are handled by the jump logic.
      } else if (!state.durationItemId && reportedDurationMs > 0 && !state.durationMs) {
        state.durationMs = reportedDurationMs;
      }
      // 真换曲只认 catalogId（曲目身份，稳定）：这时才允许立刻重锚显示时钟，省掉"两次确认"
      // 的 1.5 秒滞后。itemId 可能为空或在两种 id 之间抖动，不能拿它判断换曲。
      // Only a catalogId change is a real track change, and only then do we re-anchor immediately.
      var polledCatalog = String(data.catalogId || '');
      if (polledCatalog && state.catalogId && polledCatalog !== String(state.catalogId)) {
        state.catalogId = polledCatalog;
        state.clockSeconds = -1;
        state.pendingJumpSeconds = -1;
        // 换曲了：上一首的"最远位置"不能留在新曲目上，否则刚起播就会被判成已播完。
        state.maxPositionMs = state.positionMs;
      }
      // 这次採样属于哪个瞬间：positionMs 是伴生进程处理请求那一刻的值，取 RTT 的中点最准
      // （Folia 的做法：progressMs + rtt/2）。绝对时间用收到时刻回推半个 RTT。
      var receivedAt = Number(timing && timing.receivedAt) || Date.now();
      var sentAt = Number(timing && timing.sentAt) || receivedAt;
      var rttMs = Math.max(0, receivedAt - sentAt);
      state.rttMs = rttMs;
      state.sampleSeconds = state.positionMs / 1000;
      state.sampleAt = receivedAt - rttMs / 2;
      state.sampleValid = true;
      state.updatedAt = receivedAt;
      state.starting = data.starting === true;
      // 🔴 结束判定不能只看"当前位置是否接近结尾"：MusicKit 播完后常把 currentPlaybackTime
      // 归零，位置一回去就永远判不到结束 —— 表现就是"播完停住，不切歌也不循环"。这里记住本首
      // 到达过的最远位置，位置被归零也能认出"刚才已经播到底了"。
      // Track completion cannot rely on the live position alone: MusicKit resets it to 0 at the end.
      state.maxPositionMs = Math.max(Number(state.maxPositionMs) || 0, state.positionMs);
      var reachedEnd = state.durationMs > 0
        && (state.positionMs >= state.durationMs - 1200 || Number(state.maxPositionMs) >= state.durationMs - 2500);
      // 结束判定用**原始** isPlaying，而不是上面平滑过的 state.isPlaying：平滑是为了别让图标
      // 和歌词因为一次噪声抖一下，但它会把"播完"这件事推迟一拍；播完那一拍位置可能已经归零，
      // 拖一拍再看就再也判不到了。
      // End detection uses the raw flag: the smoothed one is one poll late and hides completion.
      state.ended = data.isPlaying !== true && reachedEnd;
      playing = state.isPlaying;
      // 🔴 界面更新只能"尽力而为"：这里任何一处抛错（Media Session、进度条、图标）都不能拦住
      // 下面的结束判定 —— 否则表现就是"播完了、没有任何报错，但就是不切歌"，而且时灵时不灵。
      // UI updates must never block end detection; any throw here used to silently kill auto-advance.
      try { if (typeof setPlayIcon === 'function') setPlayIcon(state.isPlaying); } catch (e) { }
      try { if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi(); } catch (e) { }
      try { if (typeof syncMediaSession === 'function') syncMediaSession(false); } catch (e) { }
      if (state.ended && !state.endHandled) {
        state.endHandled = true;
        finishExternalTrack(state.token);
      }
    }

    // 收尾必须和本地播放完全一致（audio.onended 那一段）：记录听歌会话 → 单曲循环 → 下一首。
    // 以前这里只调 nextTrack()，于是 AM 的单曲循环根本不生效，列表循环也走不到引擎的收尾逻辑。
    // The tail has to match the local path exactly (see audio.onended): finalize the listen session,
    // honour repeat-one, then advance. Only calling nextTrack() broke repeat modes for Apple Music.
    function finishExternalTrack(endedToken) {
      setTimeout(function () {
        if (!isExternalPlaybackActive() || !externalPlaybackState || externalPlaybackState.token !== endedToken) return;
        // 上报听歌统计失败绝不能拦住切歌：AM 这条路上它可能因网络错误抛出来。
        try { if (typeof finalizeListenSession === 'function') finalizeListenSession(true); } catch (e) { }
        if (typeof playMode !== 'undefined' && playMode === 'single') {
          if (typeof playQueueAt === 'function') {
            setTimeout(function () { playQueueAt(currentIdx, { autoRepeat: true, suppressPlayFailureNotice: true }); }, 0);
          }
          return;
        }
        if (typeof nextTrack === 'function') nextTrack();
      }, 260);
    }

    // 兜底时钟：轮询可能错过结束那一拍（MusicKit 有时一直报 isPlaying，或者干脆不再更新）。
    // 按曲目时长排一次定时器，到点时再看一眼真实状态，只有确认"确实在结尾"才收尾。
    // Backstop clock: a duration-based timer, verified against the live state before acting.
    function scheduleExternalEndBackstop(token, durationSec, startSec) {
      var delayMs = Math.max(1500, ((Number(durationSec) || 0) - (Number(startSec) || 0)) * 1000 + 1500);
      if (!isFinite(delayMs) || delayMs <= 0) return;
      setTimeout(function () {
        var state = externalPlaybackState;
        if (!isExternalPlaybackActive() || !state || state.token !== token || state.endHandled) return;
        if (state.isPlaying && Number(state.positionMs) < state.durationMs - 4000) {
          // 还在放且离结尾很远：说明时长/起点不准，重新排一次，绝不提前切歌。
          scheduleExternalEndBackstop(token, state.durationMs / 1000, state.positionMs / 1000);
          return;
        }
        if (Number(state.positionMs) < state.durationMs - 4000 && !state.isPlaying) return;
        state.endHandled = true;
        finishExternalTrack(token);
      }, delayMs);
    }
    async function pollExternalPlayback() {
      if (!isExternalPlaybackActive()) return;
      // 心跳没了就重建：状态还在（说明用户还在放 AM）却没有定时器，多发生在被意外清掉之后。
      // Re-arm a heartbeat that went missing while the session is still live.
      if (!externalPlaybackPollTimer) startExternalPlaybackPolling();
      if (externalPlaybackPollBusy) {
        // 上一次轮询占住 busy 太久：认为那条请求不会回来了，解闸继续，并留一条可查的日志。
        // A poll that has held the flag too long is never coming back: release it and log.
        var busyFor = Date.now() - (Number(externalPlaybackPollBusySince) || 0);
        if (!externalPlaybackPollBusySince || busyFor <= EXTERNAL_PLAYBACK_POLL_WATCHDOG_MS) return;
        externalPlaybackPollBusy = false;
        externalPlaybackPollBusySince = 0;
        if (typeof logEvent === 'function') logEvent('playback', 'am-poll-unwedge', { busyFor: Math.round(busyFor) }, 'warn');
      }
      externalPlaybackPollBusy = true;
      externalPlaybackPollBusySince = Date.now();
      try {
        var sentAt = Date.now();
        var result = await externalAppleMusicRequest('playbackStatus', {});
        var receivedAt = Date.now();
        if (!result || result.ok !== true) {
          externalPlaybackFailures += 1;
          if (externalPlaybackFailures >= 3 && externalPlaybackState) {
            hideLoading();
            showToast(playbackStartAudioText('psa_start_failed', '播放启动失败，请重新选择歌曲'));
            stopExternalPlayback('failed');
          }
          return;
        }
        externalPlaybackFailures = 0;
        applyExternalPlaybackState(result, { sentAt: sentAt, receivedAt: receivedAt });
      } finally {
        externalPlaybackPollBusy = false;
        externalPlaybackPollBusySince = 0;
      }
    }
    function startExternalPlaybackPolling() {
      stopExternalPlaybackPolling();
      externalPlaybackPollTimer = setInterval(function () { void pollExternalPlayback(); }, 750);
      if (externalPlaybackPollTimer && typeof externalPlaybackPollTimer.unref === 'function') externalPlaybackPollTimer.unref();
    }
    // 库内歌曲的 id 是 `i.xxx`，MusicKit 的 setQueue 只可靠地吃 catalog id（拿 i.xxx 去 setQueue
    // 会静默不播）。这里把"库 id → catalogId"的换算缓存住，同一首不重复往返。
    var appleMusicCatalogIdCache = new Map();

    async function resolveAppleMusicCatalogId(catalogId) {
      if (/^\d{1,40}$/.test(catalogId)) return catalogId;
      if (!/^i\.[A-Za-z0-9._-]{1,198}$/.test(catalogId)) return '';
      var cached = appleMusicCatalogIdCache.get(catalogId);
      if (cached !== undefined) return cached;
      var answer = await externalAppleMusicRequest('resolveSong', { songId: catalogId });
      var catalog = answer && answer.ok === true && answer.data ? String(answer.data.catalogId || '') : '';
      if (/^\d{1,40}$/.test(catalog)) {
        appleMusicCatalogIdCache.set(catalogId, catalog);
        return catalog;
      }
      // 读不到就不缓存：会话恢复后还能再试一次。
      return '';
    }

    async function startExternalAppleMusicPlayback(song, idx, token, opts) {
      opts = opts || {};
      var catalogId = String(song.catalogId || song.appleMusicId || song.providerSongId || song.id || '').replace(/^applemusic:/i, '');
      // 统一走 appleMusicCatalogIdOf（00-state/16-provider-registry.js）：
      // 资料库歌曲的 id 是新版 `a.<数字>`，数字部分就是 catalog id；旧队列快照里可能只剩这种 id。
      // 只有拿到**纯数字**才替换，否则保留原值走下面的 `i.xxx` → resolveSong 换算。
      // One normalization point; only digits replace, so legacy `i.` ids survive for resolveSong.
      if (!/^\d{1,40}$/.test(catalogId) && typeof appleMusicCatalogIdOf === 'function') {
        var normalizedId = appleMusicCatalogIdOf(song);
        if (/^\d{1,40}$/.test(normalizedId)) catalogId = normalizedId;
      }
      if (!/^\d{1,40}$/.test(catalogId)) {
        var beforeResolve = catalogId;
        catalogId = await resolveAppleMusicCatalogId(catalogId);
        if (token !== trackSwitchToken) return false;
        if (!/^\d{1,40}$/.test(catalogId)) {
          // 这类失败以前完全没痕迹（连 companion 都没请求过），只能靠用户截图猜。
          if (typeof logEvent === 'function') {
            logEvent('playback', 'am-start-rejected', {
              songId: beforeResolve, libraryId: /^i\./.test(beforeResolve),
              provider: song.provider || '', reason: 'no-catalog-id',
            }, 'error');
          }
          showToast(playbackStartAudioText('psa_start_failed', '播放启动失败，请重新选择歌曲'));
          return false;
        }
      }
      stopExternalPlaybackPolling();
      var previous = externalPlaybackState;
      // 这个判断要在把状态清空之前做：清空之后 isExternalPlaybackActive() 永远是 false。
      var hadLiveCompanion = !!(previous && previous.provider === 'applemusic');
      externalPlaybackState = null;
      if (previous && previous.isPlaying) void externalAppleMusicRequest('pause', {});
      if (typeof pauseCurrentAudioForTrackSwitch === 'function') pauseCurrentAudioForTrackSwitch();
      showLoading({ trackSwitch: true, seamlessCover: true });
      var startSec = Math.max(0, Number(opts.resumeAt) || 0);
      var requestKey = 'am_' + String(token) + '_' + Date.now();
      // 🔴 播放 AM 是用户主动动作，**允许拉起宿主**：刚启动时 companion 还没起来（未登录不发探测），
      // 直接发 playSong 只会在页面加载完之前失败。这里先 warm 一次把 WebView2 和页面拉起来，
      // 再发播放；失败也不拦着，仍然让 playSong 自己再试。
      // Playing is an explicit action, so warming the host here is allowed: a cold start used to fail
      // because the companion was not up yet.
      // 只在"当前没有已知存活的宿主"时预热：会话内切歌时宿主一直在，多一次往返没有意义。
      if (!hadLiveCompanion) {
        var warmStartedAt = Date.now();
        var warm = await externalAppleMusicRequest('warm', {});
        if (typeof logEvent === 'function') {
          logEvent('playback', 'am-warm', {
            ok: !!(warm && warm.ok === true),
            elapsedMs: Date.now() - warmStartedAt,
          }, warm && warm.ok === true ? 'info' : 'warn');
        }
        if (token !== trackSwitchToken) return false;
      }
      var result = await externalAppleMusicRequest('playSong', { catalogId: catalogId, startSec: startSec, requestKey: requestKey });
      if (token !== trackSwitchToken) return false;
      // 宿主刚起来时 MusicKit 可能还没配置完，playSong 会答 playback-failed（页面已加载但播放器
      // 未就绪）。这种一次性的失败值得再试一次，而不是直接弹"播放失败"。
      // MusicKit may still be configuring right after the page loads; retry once for that case.
      if ((!result || result.ok !== true) && result && result.error === 'playback-failed' && token === trackSwitchToken) {
        if (typeof logEvent === 'function') {
          logEvent('playback', 'am-start-retry', { stage: result.playbackStage || '', catalogId: catalogId }, 'warn');
        }
        await new Promise(function (resolve) { setTimeout(resolve, 1200); });
        if (token !== trackSwitchToken) return false;
        result = await externalAppleMusicRequest('playSong', { catalogId: catalogId, startSec: startSec, requestKey: requestKey });
        if (token !== trackSwitchToken) return false;
      }
      if (!result || result.ok !== true) {
        hideLoading();
        // 起播失败必须留痕：错误码与 playbackStage 能直接区分"页面没就绪/队列解析失败/DRM 失败"。
        if (typeof logEvent === 'function') {
          var startFailure = appleMusicErrorInfo(result && result.error);
          logEvent('playback', 'am-start-failed', {
            catalogId: catalogId,
            error: startFailure.code || 'unknown',
            kind: startFailure.kind,
            stage: (result && result.playbackStage) || '',
            resumeAt: startSec,
          }, 'error');
        }
        if (typeof handlePlaybackUnavailable === 'function') handlePlaybackUnavailable(song, result || {});
        else showToast(playbackStartAudioText('psa_start_failed', '播放启动失败，请重新选择歌曲'));
        return false;
      }
      // 🔴 恢复标记必须在这里清掉（本地播放路径早就这么做了，AM 路径漏了）：
      // 只要它还 >0，「无 audio 元素 + 有恢复快照」就一直成立，200ms 心跳会拿**启动快照里的旧
      // 进度**去画进度条，而 750ms 轮询拿真实位置画 —— 两个来源交替写同一个 #progress-fill，
      // 用户看到的就是"下方控制台进度来回跳"。
      // The resume marker must be cleared here exactly like the local path does; otherwise the
      // heartbeat keeps painting the stale startup snapshot while the poll paints the real clock.
      pendingPlaybackResumeAt = 0;
      externalPlaybackState = {
        provider: 'applemusic',
        song: song,
        catalogId: catalogId,
        token: token,
        isPlaying: true,
        positionMs: startSec * 1000,
        // 单调显示时钟的锚点：换歌时从新起点重新开始，别继承上一首的进度。
        clockSeconds: Math.max(0, Number(startSec) || 0),
        clockAt: Date.now(),
        durationMs: playbackDurationFromSong(song) * 1000,
        // 记下当前时长属于哪首曲目：轮询只在曲目变化时才改时长，避免百分比反复缩放。
        durationItemId: String(catalogId || ''),
        updatedAt: Date.now(),
        starting: true,
        ended: false,
        endHandled: false,
        maxPositionMs: startSec * 1000
      };
      // 轮询之外再排一个"按时长到点"的兜底时钟（Spotify 那条路用的是本地静音时钟驱动队列，
      // AM 没有 audio 元素，只能用等价的办法：按曲目时长计时，到点校验后收尾）。
      scheduleExternalEndBackstop(token, playbackDurationFromSong(song) || (startSec + 240), startSec);
      hideLoading();
      playing = true;
      if (typeof setPlayIcon === 'function') setPlayIcon(true);
      if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
      if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
      if (typeof applyMediaSessionMetadata === 'function') applyMediaSessionMetadata(song);
      if (typeof applyMediaSessionPlaybackState === 'function') applyMediaSessionPlaybackState();
      if (typeof targetVolume !== 'undefined' && typeof externalAppleMusicRequest === 'function') {
        void externalAppleMusicRequest('setVolume', { volume: targetVolume });
      }
      startExternalPlaybackPolling();
      void pollExternalPlayback();
      return true;
    }
    async function toggleExternalAppleMusicPlayback() {
      if (!isExternalPlaybackActive()) return false;
      var state = externalPlaybackState;
      var operation = state.isPlaying ? 'pause' : 'resume';
      var result = await externalAppleMusicRequest(operation, {});
      if (!result || result.ok !== true) {
        // 命令可能已经到了页面、只是回包丢了（宿主卡顿/超时）。这时**不能**保持"还在播"的
        // 旧状态让界面继续走：立刻补一次状态查询，用真实播放态覆盖本地判断。
        // The command may have landed even though the reply was lost: ask for the real state now.
        var commandFailure = appleMusicErrorInfo(result && result.error);
        if (typeof logEvent === 'function') {
          logEvent('playback', 'am-command-failed', {
            operation: operation, error: commandFailure.code, kind: commandFailure.kind,
          }, 'warn');
        }
        showToast(playbackStartAudioText('psa_start_failed', '播放启动失败，请重新选择歌曲'));
        if (commandFailure.retryable) void pollExternalPlayback();
        return true;
      }
      state.isPlaying = operation === 'resume';
      // 记下"用户刚刚命令了什么"：下一次轮询如果还报着相反的状态（MusicKit 滞后），
      // 这段时间内以命令为准，否则会把状态翻回去、让下一次点击又发 pause。
      state.commandAt = Date.now();
      state.commandPlaying = state.isPlaying;
      state.updatedAt = Date.now();
      state.endHandled = false;
      playing = state.isPlaying;
      if (typeof setPlayIcon === 'function') setPlayIcon(state.isPlaying);
      if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
      if (typeof syncMediaSession === 'function') syncMediaSession(true);
      if (state.isPlaying) void pollExternalPlayback();
      return true;
    }
    async function seekExternalAppleMusic(seconds) {
      if (!isExternalPlaybackActive()) return false;
      var target = Math.max(0, Number(seconds) || 0);
      var result = await externalAppleMusicRequest('seek', { seconds: target });
      if (!result || result.ok !== true) return false;
      externalPlaybackState.positionMs = target * 1000;
      externalPlaybackState.updatedAt = Date.now();
      // 用户主动 seek：直接重置单调时钟的锚点，进度条当场跳到目标位置，不用等"两次确认"。
      // An explicit user seek re-anchors the monotonic clock immediately.
      // 用户主动 seek：直接把本地时钟锚到目标位置，不必等纠正阈值判定。
      externalPlaybackState.clockSeconds = target;
      externalPlaybackState.clockAt = Date.now();
      externalPlaybackState.sampleValid = false;
      externalPlaybackState.pendingJumpSeconds = -1;
      if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
      if (typeof syncMediaSession === 'function') syncMediaSession(true);
      return true;
    }

    // ── 错误分类（唯一入口）/ the only place that classifies AM failures ──────────────
    // 之前同一批错误码在四个文件里各翻译一遍，于是出现"宿主超时被当成用户退出登录"这种事。
    // 现在所有判断都走这张表：
    //   kind       transport = 我们没拿到答复（不是用户的错，绝不能当登出）
    //              auth      = Apple 明确说没登录（只有这个算登出）
    //              unplayable= 这首歌播不了（重试无意义，换源或跳过）
    //              host      = 宿主本身的问题（可以重建后再试）
    //   signedOut  只有 auth 为真。
    //   retryable  重建宿主/重试一次可能有意义。
    // Every AM failure code is classified here, once. Only `auth` counts as signed out.
    var APPLE_MUSIC_ERROR_INFO = {
      'timeout': { kind: 'transport', signedOut: false, retryable: true },
      'playback-timeout': { kind: 'transport', signedOut: false, retryable: true },
      'disconnected': { kind: 'transport', signedOut: false, retryable: true },
      'runtime-unavailable': { kind: 'transport', signedOut: false, retryable: true },
      'busy': { kind: 'transport', signedOut: false, retryable: true },
      'request-failed': { kind: 'transport', signedOut: false, retryable: true },
      'not-ready': { kind: 'transport', signedOut: false, retryable: true },
      'auth-required': { kind: 'auth', signedOut: true, retryable: false },
      'storefront-unavailable': { kind: 'transport', signedOut: false, retryable: true },
      'identity-unavailable': { kind: 'transport', signedOut: false, retryable: false },
      'playback-failed': { kind: 'unplayable', signedOut: false, retryable: false },
      'no-catalog-id': { kind: 'unplayable', signedOut: false, retryable: false },
      'unsupported': { kind: 'unplayable', signedOut: false, retryable: false },
      'invalid-request': { kind: 'unplayable', signedOut: false, retryable: false },
      'upstream-error': { kind: 'unplayable', signedOut: false, retryable: false },
      'lyrics-unavailable': { kind: 'unplayable', signedOut: false, retryable: false }
    };
    function appleMusicErrorInfo(code) {
      var key = String(code || '');
      var info = APPLE_MUSIC_ERROR_INFO[key];
      if (info) return Object.assign({ code: key }, info);
      // 认不出来的码按"传输层未知"处理：宁可提示一次、不重试，也不要据此判定登出。
      // Unknown codes are treated as an unnamed transport failure: never sign the user out for it.
      return { code: key, kind: 'transport', signedOut: false, retryable: false };
    }

    return {
        isSong: isExternalAppleMusicSong,
        isActive: isExternalPlaybackActive,
        play: startExternalAppleMusicPlayback,
        toggle: toggleExternalAppleMusicPlayback,
        seek: seekExternalAppleMusic,
        currentSeconds: externalPlaybackCurrentSeconds,
        stop: stopExternalPlayback,
        request: externalAppleMusicRequest,
        errorInfo: appleMusicErrorInfo,
        openWindow: function () { return externalAppleMusicRequest('showWindow', {}); }
    };
}

// 单实例：整个应用只有这一个 AM 控制器。
// One instance for the whole app.
var AppleMusic = TributeToSteveJobs();
if (typeof window !== 'undefined') window.AppleMusic = AppleMusic;

// ── 兼容转发：老调用点（及现有测试）继续用这些名字 ────────────────────────────────
// 新代码请直接用 AppleMusic.*，这里的转发只是为了不一次性改十几处调用。
function isExternalAppleMusicSong(song) { return AppleMusic.isSong(song); }
function isExternalPlaybackActive() { return AppleMusic.isActive(); }
function externalPlaybackCurrentSeconds() { return AppleMusic.currentSeconds(); }
function startExternalAppleMusicPlayback(song, idx, token, opts) { return AppleMusic.play(song, idx, token, opts); }
function toggleExternalAppleMusicPlayback() { return AppleMusic.toggle(); }
function seekExternalAppleMusic(seconds) { return AppleMusic.seek(seconds); }
function stopExternalPlayback(reason) { return AppleMusic.stop(reason); }
function externalAppleMusicRequest(operation, params) { return AppleMusic.request(operation, params); }
function appleMusicErrorInfo(code) { return AppleMusic.errorInfo(code); }
