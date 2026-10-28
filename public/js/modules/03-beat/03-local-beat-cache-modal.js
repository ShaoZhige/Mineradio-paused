// 本模块界面文案统一走 i18n；缺键时退回内置中文模板，不会渲染空串或裸 key。
// UI copy in this module goes through i18n and falls back to the built-in Chinese
// template, so nothing ever renders an empty string or a raw key.
// params 既透传给 t()，也插值进兜底模板，缺词典时占位符仍会被替换掉。
// params goes to both t() and the fallback template so placeholders still resolve
// when the dictionary entry is missing.
// 本模块界面文案统一走 i18n，词典是唯一文案来源。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：
//   xxxText('key')            —— 推荐。词典缺键时返回键名本身，漏译一眼可见。
//   xxxText('key', '兜底')     —— 仅在「缺键时该显示什么」有明确要求时用。
//   xxxText('key', '含 {p} 的模板', {p: v}) —— 带插值。params 同时喂给 t() 与兜底模板。
// 缺键刻意返回键名而不是空串：空串会让漏译静默发生，键名在界面上是一眼能认出的错误。
// Two call shapes. A missing key returns the key itself on purpose: an empty string would
// make an untranslated string fail silently, while a bare key is self-identifying on screen.
// params 同时透传给 t() 并插值进兜底模板，缺词典时占位符仍会被替换掉。
// params goes to both t() and the fallback template so placeholders still resolve.
function localBeatCacheModalText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === "object") {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}
function showBeatChip(text) {
  document.getElementById('beat-text').textContent = text || localBeatCacheModalText('beat_analyzing', '分析节奏…');
  document.getElementById('beat-chip').classList.add('show');
  // 批量跑的时候状态行归进度用，别被「分析节奏…」这类瞬时文案顶掉。
  // During a batch the status line belongs to the progress readout, not to transient chip copy.
  if (localBeatAnalysis && localBeatAnalysis.active && !localBeatAnalysis.batch) {
    setLocalBeatStatus(text || localBeatCacheModalText('beatcache_analyzing'), 'warn');
  }
}
function hideBeatChip() {
  document.getElementById('beat-chip').classList.remove('show');
}

function localBeatRound(v, scale) {
  v = Number(v);
  if (!isFinite(v)) return 0;
  scale = scale || 1000;
  return Math.round(v * scale) / scale;
}
function packLocalBeatEvent(ev) {
  if (typeof ev === 'number') return [localBeatRound(ev, 1000), 0.42, 0.72, 0.42, 0.62, 0.22, 0.16, 0, 7, 0.62, 0.12, 0];
  ev = ev || {};
  var comboIdx = Math.max(0, LOCAL_BEAT_COMBOS.indexOf(ev.combo || ''));
  var flags = 0;
  if (ev.primary !== false) flags |= 1;
  if (ev.camera !== false) flags |= 2;
  if (ev.pulse !== false) flags |= 4;
  if (ev.dj) flags |= 8;
  if (ev.grid) flags |= 16;
  if (ev.kickOnly) flags |= 32;
  return [
    localBeatRound(ev.time, 1000),
    localBeatRound(ev.strength == null ? 0.42 : ev.strength, 1000),
    localBeatRound(ev.confidence == null ? 0.72 : ev.confidence, 1000),
    localBeatRound(ev.impact == null ? (ev.strength == null ? 0.42 : ev.strength) : ev.impact, 1000),
    localBeatRound(ev.low == null ? 0.62 : ev.low, 1000),
    localBeatRound(ev.body == null ? 0.22 : ev.body, 1000),
    localBeatRound(ev.snap == null ? 0.16 : ev.snap, 1000),
    comboIdx,
    flags,
    localBeatRound(ev.mass == null ? 0.62 : ev.mass, 1000),
    localBeatRound(ev.sharpness == null ? 0.12 : ev.sharpness, 1000),
    localBeatRound(ev.step || 0, 1000)
  ];
}
function packLocalBeatMap(map) {
  if (!map) return null;
  var camera = (map.cameraBeats || map.beats || map.kicks || []).map(packLocalBeatEvent);
  var pulse = (map.pulseBeats || map.kicks || []).map(packLocalBeatEvent);
  return {
    v: 1,
    duration: localBeatRound(map.duration || 0, 1000),
    gridStep: localBeatRound(map.gridStep || 0, 1000),
    sectionSteps: (map.sectionSteps || []).map(function (v) { return localBeatRound(v, 1000); }),
    tempoSource: map.tempoSource || 'local',
    visualBeatCount: map.visualBeatCount || camera.length,
    analyzedAt: map.analyzedAt || Date.now(),
    partial: !!map.partial,
    partialUntilSec: map.partialUntilSec || 0,
    cameraBeats: camera,
    pulseBeats: pulse
  };
}
function saveLocalBeatPrefs() {
  try { localStorage.setItem(LOCAL_BEAT_PREF_STORE_KEY, JSON.stringify(localBeatMapPrefs || {})); } catch (e) { }
}
function packLocalBeatCache(maxEntries) {
  var entries = Object.keys(localBeatMapCache || {}).map(function (key) {
    var entry = localBeatMapCache[key] || {};
    return { key: key, updatedAt: entry.updatedAt || 0, entry: entry };
  }).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  if (maxEntries) entries = entries.slice(0, maxEntries);
  var packed = {};
  entries.forEach(function (item) {
    packed[item.key] = { updatedAt: item.entry.updatedAt || Date.now() };
    if (item.entry.mr) packed[item.key].mr = packLocalBeatMap(item.entry.mr);
    if (item.entry.dj) packed[item.key].dj = packLocalBeatMap(item.entry.dj);
  });
  return packed;
}
function saveLocalBeatMapCache() {
  var attempts = [12, 8, 5, 3];
  for (var i = 0; i < attempts.length; i++) {
    try {
      localStorage.setItem(LOCAL_BEATMAP_STORE_KEY, JSON.stringify(packLocalBeatCache(attempts[i])));
      return true;
    } catch (e) { }
  }
  return false;
}
function getLocalBeatEntry(localKey, mode) {
  var entry = localKey && localBeatMapCache ? localBeatMapCache[localKey] : null;
  return entry && entry[mode] ? entry[mode] : null;
}
function storeLocalBeatEntry(localKey, mode, map, song, opts) {
  if (!localKey || !map) return;
  opts = opts || {};
  var entry = localBeatMapCache[localKey] || {};
  entry[mode] = map;
  entry.updatedAt = Date.now();
  localBeatMapCache[localKey] = entry;
  localBeatMapPrefs[localKey] = mode;
  saveLocalBeatPrefs();
  // 批量分析时先不落 localStorage：那一步要把 12 份地图整个序列化，逐首跑会卡出可见的顿挫。
  // 内存里已经攒全，收尾时一次写完就行。
  // During a batch the localStorage write is deferred: it serialises a dozen maps per call, which
  // shows up as visible jank when repeated per track. The in-memory copy is complete, so one
  // write at the end is enough.
  if (!opts.skipLocal) saveLocalBeatMapCache();
  if (!opts.skipDisk) writeBeatDiskCache(localBeatDiskKey(localKey, mode), map, song || { type: 'local', localKey: localKey }, mode);
}
function setLocalBeatStatus(text, tone) {
  var el = document.getElementById('local-beat-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('warn', tone === 'warn');
  el.classList.toggle('fail', tone === 'fail');
}

function localBeatVisualCount(map) {
  return map ? (map.visualBeatCount || (map.cameraBeats && map.cameraBeats.length) || (map.beats && map.beats.length) || 0) : 0;
}
function setLocalBeatPreference(localKey, mode) {
  if (!localKey) return;
  localBeatMapPrefs[localKey] = mode === 'dj' ? 'dj' : 'mr';
  saveLocalBeatPrefs();
}
function applyLocalBeatMap(song, mode, map, fromCache) {
  if (!song || !song.localKey || !map) return false;
  mode = mode === 'dj' ? 'dj' : 'mr';
  song.localBeatMode = mode;
  setLocalBeatPreference(song.localKey, mode);
  if (mode === 'dj') {
    setDjModeActive(true, song);
    currentBeatMap = null;
    beatMapNextIdx = 0;
    currentDjBeatMap = map;
    djBeatMapCache[djSongKey(song)] = map;
    applyPodcastDjProfileFromMap(map);
    syncPodcastDjMapCursor(audio ? audio.currentTime : 0, true);
    maybeAnnounceDjMode();
  } else {
    setDjModeActive(false, song);
    currentBeatMap = map;
    beatMapCache['local:' + song.localKey] = map;
    applyCinemaProfileFromBeatMap(map);
    syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0, true);
  }
  hideBeatChip();
  notifyDesktopLyricsBeatMapReady();
  if (fromCache) showToast((mode === 'dj' ? 'DJ' : 'MR') + localBeatCacheModalText('beatcache_loaded'));
  return true;
}
function prepareLocalBeatAnalysis(song, audioUrl) {
  if (!song || !song.localKey || !audioUrl) return;
  var preferred = localBeatMapPrefs[song.localKey] === 'dj' ? 'dj' : 'mr';
  var cached = getLocalBeatEntry(song.localKey, preferred) ||
    getLocalBeatEntry(song.localKey, preferred === 'dj' ? 'mr' : 'dj');
  if (cached) {
    applyLocalBeatMap(song, cached === getLocalBeatEntry(song.localKey, 'dj') ? 'dj' : 'mr', cached, true);
    return;
  }
  var diskToken = trackSwitchToken;
  (async function () {
    var firstMode = preferred;
    var secondMode = preferred === 'dj' ? 'mr' : 'dj';
    var firstMap = await readBeatDiskCache(localBeatDiskKey(song.localKey, firstMode));
    var mode = firstMap ? firstMode : secondMode;
    var map = firstMap || await readBeatDiskCache(localBeatDiskKey(song.localKey, secondMode));
    if (diskToken !== trackSwitchToken || !currentLocalSong || currentLocalSong.localKey !== song.localKey) return;
    if (map) {
      storeLocalBeatEntry(song.localKey, mode, map, song, { skipDisk: true });
      applyLocalBeatMap(song, mode, map, true);
      return;
    }
    openLocalBeatModal(song, audioUrl);
  })().catch(function () {
    if (diskToken === trackSwitchToken && currentLocalSong && currentLocalSong.localKey === song.localKey) openLocalBeatModal(song, audioUrl);
  });
}
function openLocalBeatModal(song, audioUrl) {
  if (immersiveMode) setImmersiveMode(false);
  // 批量分析进行中切到下一首未缓存的本地歌也会走到这里。这时不能重置会话：把 active 置 false
  // 会把整批踢掉，进度也会被抹成空白。只刷新一次界面，让弹窗继续显示批量进度。
  // An uncached local track switched to mid-batch also lands here. Resetting the session would
  // knock the batch out (active=false) and blank the progress, so it only repaints.
  if (!localBeatAnalysis.batch) {
    localBeatAnalysis.song = song || currentLocalSong;
    localBeatAnalysis.audioUrl = audioUrl || (audio && audio.src) || '';
    localBeatAnalysis.mode = (localBeatAnalysis.song && localBeatMapPrefs[localBeatAnalysis.song.localKey] === 'dj') ? 'dj' : 'mr';
    localBeatAnalysis.active = false;
    setLocalBeatStatus('', '');
  }
  updateLocalBeatModal();
  openGsapModal(document.getElementById('local-beat-modal'));
}
function closeLocalBeatModal() {
  if (localBeatAnalysis.active) return;
  closeGsapModal(document.getElementById('local-beat-modal'));
}
function selectLocalBeatMode(mode) {
  if (localBeatAnalysis.active) return;
  localBeatAnalysis.mode = mode === 'dj' ? 'dj' : 'mr';
  updateLocalBeatModal();
}
function updateLocalBeatModal() {
  var song = localBeatAnalysis.song || currentLocalSong || {};
  var mode = localBeatAnalysis.mode === 'dj' ? 'dj' : 'mr';
  var modal = document.querySelector('#local-beat-modal .local-beat-modal');
  if (modal) modal.classList.toggle('analyzing', !!localBeatAnalysis.active);
  var title = document.getElementById('local-beat-title');
  var sub = document.getElementById('local-beat-sub');
  if (title) title.textContent = song.name || localBeatCacheModalText('ba_local_song');
  if (sub) {
    var cachedBits = [];
    if (song.localKey && getLocalBeatEntry(song.localKey, 'mr')) cachedBits.push(localBeatCacheModalText('beatcache_mr_cached'));
    if (song.localKey && getLocalBeatEntry(song.localKey, 'dj')) cachedBits.push(localBeatCacheModalText('beatcache_dj_cached'));
    sub.textContent = cachedBits.length ? cachedBits.join(' / ') : localBeatCacheModalText('beatcache_choose_mode');
  }
  var mr = document.getElementById('local-beat-tab-mr');
  var dj = document.getElementById('local-beat-tab-dj');
  if (mr) mr.classList.toggle('active', mode === 'mr');
  if (dj) dj.classList.toggle('active', mode === 'dj');
  var desc = document.getElementById('local-beat-desc');
  if (desc) desc.textContent = mode === 'dj'
    ? localBeatCacheModalText('beatcache_dj_desc')
    : localBeatCacheModalText('beatcache_mr_desc');
  var start = document.getElementById('local-beat-start-btn');
  var cancel = document.getElementById('local-beat-cancel-btn');
  var later = document.getElementById('local-beat-later-btn');
  if (start) {
    start.disabled = !!localBeatAnalysis.active;
    start.textContent = getLocalBeatEntry(song.localKey, mode) ? localBeatCacheModalText('beatcache_use_cache') : localBeatCacheModalText('ba_start');
  }
  if (cancel) cancel.style.display = localBeatAnalysis.active ? '' : 'none';
  if (later) later.style.display = localBeatAnalysis.active ? 'none' : '';
  refreshLocalBeatBatchEntry();
}
function cancelLocalBeatAnalysis() {
  if (!localBeatAnalysis.active) {
    closeLocalBeatModal();
    return;
  }
  localBeatAnalysis.active = false;
  localBeatAnalysis.batch = null;
  localBeatAnalysis.token++;
  beatMapToken++;
  djBeatMapToken++;
  beatMapBusy = false;
  djBeatMapBusy = false;
  cancelBeatAnalysisTimer();
  cancelDjBeatAnalysisTimer();
  hideBeatChip();
  if (localBeatAnalysis.mode === 'dj') setDjModeActive(false, localBeatAnalysis.song || currentLocalSong);
  setLocalBeatStatus(localBeatCacheModalText('beatcache_cancelled'), 'fail');
  updateLocalBeatModal();
}
async function startLocalBeatAnalysis(mode) {
  var song = localBeatAnalysis.song || currentLocalSong;
  var audioUrl = localBeatAnalysis.audioUrl || (song && song.localUrl) || (audio && audio.src) || '';
  mode = mode || localBeatAnalysis.mode;
  mode = mode === 'dj' ? 'dj' : 'mr';
  if (!song || !song.localKey || !audioUrl || localBeatAnalysis.active) return;
  var cached = getLocalBeatEntry(song.localKey, mode);
  if (cached) {
    applyLocalBeatMap(song, mode, cached, true);
    closeGsapModal(document.getElementById('local-beat-modal'));
    return;
  }
  localBeatAnalysis.active = true;
  localBeatAnalysis.mode = mode;
  localBeatAnalysis.token++;
  var localToken = localBeatAnalysis.token;
  updateLocalBeatModal();
  setLocalBeatStatus((mode === 'dj' ? 'DJ' : 'MR') + localBeatCacheModalText('beatcache_preparing'), 'warn');
  try {
    var map = null;
    if (mode === 'dj') {
      setDjModeActive(true, song);
      djBeatMapToken++;
      resetDjBeatMapState();
      currentBeatMap = null;
      resetBeatCameraSync(audio ? audio.currentTime : 0);
      var djToken = djBeatMapToken;
      map = await analyzePodcastDjBeats(audioUrl, djToken, audio && isFinite(audio.duration) ? audio.duration : 0);
      if (localToken !== localBeatAnalysis.token || djToken !== djBeatMapToken) return;
      if (!map) throw new Error('DJ analysis returned empty map');
    } else {
      setDjModeActive(false, song);
      beatMapToken++;
      currentBeatMap = null;
      beatMapNextIdx = 0;
      resetBeatCameraSync(audio ? audio.currentTime : 0);
      var mrToken = beatMapToken;
      map = await analyzeAudioBeats(audioUrl, audio && isFinite(audio.duration) ? audio.duration : 0, mrToken, { background: false, song: song });
      if (localToken !== localBeatAnalysis.token || mrToken !== beatMapToken) return;
      if (!map) throw new Error('MR analysis returned empty map');
    }
    storeLocalBeatEntry(song.localKey, mode, map, song);
    applyLocalBeatMap(song, mode, map, false);
    localBeatAnalysis.active = false;
    setLocalBeatStatus((mode === 'dj' ? 'DJ' : 'MR') + localBeatCacheModalText('beatcache_done_prefix') + localBeatVisualCount(map) + localBeatCacheModalText('beatcache_main_beats'));
    updateLocalBeatModal();
    showToast((mode === 'dj' ? 'DJ' : 'MR') + localBeatCacheModalText('beatcache_done'));
    setTimeout(function () {
      if (!localBeatAnalysis.active) closeGsapModal(document.getElementById('local-beat-modal'));
    }, 900);
  } catch (err) {
    console.warn('local beat analysis failed:', err);
    localBeatAnalysis.active = false;
    hideBeatChip();
    if (mode === 'dj') setDjModeActive(false, song);
    setLocalBeatStatus(localBeatCacheModalText('beatcache_failed_retry'), 'fail');
    updateLocalBeatModal();
    showToast(localBeatCacheModalText('beatcache_failed'));
  }
}

// ── 队列内批量分析 ────────────────────────────────────────────────────────────
// 范围就是当前队列里的本地歌曲：用户要么从「本地音乐」歌单整单播下来（那就是整个本地库），
// 要么是刚拖进来的一批。两种情况下队列都已经是他此刻想处理的那批歌，不必再猜一遍。
// The scope is the local songs already in the queue: either the whole local library (started from
// the local playlist) or the batch just dropped in. The queue is the user's intent in both cases.
function localBeatBatchQueueSongs() {
  var seen = Object.create(null);
  var out = [];
  (playQueue || []).forEach(function (song) {
    if (!song || !song.localKey || !song.localUrl) return;
    if (!(song.type === 'local' || song.source === 'local' || song.provider === 'local')) return;
    if (seen[song.localKey]) return;
    seen[song.localKey] = 1;
    out.push(song);
  });
  return out;
}
function localBeatBatchActive(token) {
  return !!(localBeatAnalysis.batch && localBeatAnalysis.active && localBeatAnalysis.token === token);
}
function localBeatBatchDuration(song) {
  var d = Number(song && song.duration) || 0;
  if (d > 10000) d /= 1000;
  return isFinite(d) && d > 0 && d < 36000 ? d : 0;
}
function refreshLocalBeatBatchEntry() {
  var btn = document.getElementById('local-beat-batch-btn');
  if (!btn) return;
  var total = localBeatBatchQueueSongs().length;
  // DJ 模式下不提供批量：DJ 分析每一步都以「djMode.active 为真」为前置条件，整批预热会把
  // 播放硬拽进 DJ 视觉驱动。批量只做 MR，所以切到 DJ 页签时这个入口直接收起。
  // No batch under DJ: every step of the DJ analysis requires an active DJ session, so a bulk
  // pre-warm would drag playback into DJ visual driving. The batch is MR-only, hence hidden
  // while the DJ tab is selected.
  var visible = !localBeatAnalysis.batch && localBeatAnalysis.mode !== 'dj' && total > 0;
  btn.style.display = visible ? '' : 'none';
  btn.disabled = !!localBeatAnalysis.active;
  var count = document.getElementById('local-beat-batch-count');
  // 显示的是「队列里有几首本地歌」，不是「还差几首没分析」：后者要逐首查磁盘缓存，
  // 而弹窗每次重绘都跑一遍查询并不划算，显示一个不准的缺口更糟。
  // The number is how many local songs the queue holds, not how many are still missing: the
  // latter needs a disk probe per song on every repaint, and a wrong gap is worse than none.
  if (count) count.textContent = visible ? String(total) : '';
}
// 单首分析：途中换歌会让 beatMapToken 变化并中止这一次，此时换新 token 重试一次即可，
// 不要因为用户切了一首歌就把整批丢掉。
// One track: a mid-flight track change bumps beatMapToken and aborts this attempt. Retry once with
// the new token instead of throwing the whole batch away because the user skipped a song.
async function localBeatBatchAnalyzeSong(song, token) {
  for (var attempt = 0; attempt < 2; attempt++) {
    if (!localBeatBatchActive(token)) return null;
    while (beatMapBusy && localBeatBatchActive(token)) await yieldToIdle(80);
    if (!localBeatBatchActive(token)) return null;
    var startedWith = beatMapToken;
    var map = await analyzeAudioBeats(song.localUrl, localBeatBatchDuration(song), startedWith, { background: true, song: song });
    if (!localBeatBatchActive(token)) return null;
    if (map) return map;
    if (beatMapToken === startedWith) return null;
  }
  return null;
}
async function runLocalBeatBatch(songs, mode, token) {
  var batch = localBeatAnalysis.batch;
  try {
    for (var i = 0; i < songs.length; i++) {
      if (!localBeatBatchActive(token)) return;
      var song = songs[i];
      batch.index = i + 1;
      // 已缓存就跳过：内存优先，其次磁盘。磁盘命中的顺手回填内存，省掉播放时那一次 IPC。
      if (getLocalBeatEntry(song.localKey, mode)) {
        batch.skipped++;
        continue;
      }
      var diskMap = await readBeatDiskCache(localBeatDiskKey(song.localKey, mode));
      if (!localBeatBatchActive(token)) return;
      if (diskMap) {
        storeLocalBeatEntry(song.localKey, mode, diskMap, song, { skipDisk: true });
        batch.skipped++;
        continue;
      }
      setLocalBeatStatus(localBeatCacheModalText('beatcache_batch_progress', '正在分析 {i}/{n} · {name}', { i: batch.index, n: batch.total, name: song.name || song.localKey }), 'warn');
      var map = await localBeatBatchAnalyzeSong(song, token);
      if (!localBeatBatchActive(token)) return;
      if (map) {
        storeLocalBeatEntry(song.localKey, mode, map, song, { skipLocal: true });
        batch.done++;
      } else {
        batch.failed++;
      }
      // 让出一口气：前台的节奏分析按固定间隔重排，批量一首接一首会一直抢着 busy 标志把它饿死。
      // Let the foreground breathe: its scheduler retries on a timer, and a back-to-back batch
      // would keep re-taking the busy flag and starve it.
      await yieldToIdle(isHiddenForBackgroundOptimization() ? 80 : 780);
    }
  } catch (err) {
    console.warn('local beat batch analysis failed:', err);
    batch.failed++;
  } finally {
    if (localBeatAnalysis.token === token) {
      saveLocalBeatMapCache();
      localBeatAnalysis.batch = null;
      localBeatAnalysis.active = false;
      hideBeatChip();
      var tail = batch.failed > 0 ? localBeatCacheModalText('beatcache_batch_failed_tail', '，{fail} 首失败', { fail: batch.failed }) : '';
      setLocalBeatStatus(
        localBeatCacheModalText('beatcache_batch_done', '已完成 {done} 首，跳过 {skip} 首', { done: batch.done, skip: batch.skipped }) + tail,
        batch.failed > 0 ? 'warn' : ''
      );
      // 批量结束后回到单曲界面：当前这首如果仍然没有缓存，用户可以就地开始分析它。
      // Back to the single-track view when done: if the current song is still uncached the user can
      // start on it right here.
      var focusSong = currentLocalSong || songs[0];
      if (focusSong) localBeatAnalysis.song = focusSong;
      updateLocalBeatModal();
      showToast(localBeatCacheModalText('beatcache_batch_toast', '批量分析结束'));
    }
  }
}
async function startLocalBeatBatchAnalysis() {
  if (localBeatAnalysis.active) return;
  // 入口在 DJ 页签下已经收起，这里是兜底：批量恒按 MR 存，绝不能把 MR 结果标成 DJ 地图。
  // The entry is hidden on the DJ tab; this is the backstop. The batch always stores MR maps and
  // must never label one as a DJ map.
  if (localBeatAnalysis.mode === 'dj') return;
  var songs = localBeatBatchQueueSongs();
  if (!songs.length) {
    setLocalBeatStatus(localBeatCacheModalText('beatcache_batch_empty', '队列里没有可分析的本地歌曲'), 'fail');
    return;
  }
  var mode = 'mr';
  setLocalBeatStatus(localBeatCacheModalText('beatcache_batch_preparing', '正在检查节奏缓存…'), 'warn');
  // 整库结果只有磁盘缓存存得住：localStorage 那份按最近 12 首截断。磁盘不可用时先说清楚，
  // 否则跑完 30 首只有 12 首留下，等于骗人。
  // Only the disk cache can hold a whole library; the localStorage copy keeps the newest twelve.
  // Say so up front instead of finishing thirty tracks and silently keeping twelve.
  var disk = await ensureBeatDiskCacheStatus();
  if (!disk.enabled) {
    setLocalBeatStatus(localBeatCacheModalText('beatcache_batch_need_disk', '批量分析需要磁盘节奏缓存，当前不可用'), 'fail');
    return;
  }
  if (localBeatAnalysis.active) return;
  var token = ++localBeatAnalysis.token;
  // 不碰 beatMapToken：整批是后台预热，不该把正在播放那首已经生效的节奏图作废。
  // beatMapToken is left alone: the batch is background warming, and the map already applied to
  // the current track must survive it.
  localBeatAnalysis.batch = { mode: mode, total: songs.length, index: 0, done: 0, skipped: 0, failed: 0 };
  localBeatAnalysis.active = true;
  updateLocalBeatModal();
  runLocalBeatBatch(songs, mode, token);
}

