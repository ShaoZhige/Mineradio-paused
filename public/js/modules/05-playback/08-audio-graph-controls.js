// 本模块界面文案统一走 i18n；词典是唯一文案来源，缺键时退回内置中文模板。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：xxxText('key') 缺键返回键名；xxxText('key', '兜底') 显式指定缺键时显示什么；
// xxxText('key', '含 {p} 的模板', {p: v}) 带插值，params 同时喂给 t() 与兜底模板。
// Two call shapes: key-only shows the bare key on a miss; an explicit fallback says what to
// show instead; params interpolate into both the dictionary hit and the fallback template.
function audioGraphControlsText(key, fallback, params) {
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

// ============================================================
function audioGraphHealthy() {
  return !!(audio && audioReady && audioCtx && audioCtx.state !== 'closed' && source && audioSourceMedia === audio && analyser && beatAnalyser && (gainNode || analysisSinkNode));
}
function disconnectAudioGraphNodes(keepSource) {
  // 断开前先给"正在被断开的 prepared graph"打失效标记：这一批节点马上就要失去连接，
  // 之后不得再被 resetPlaybackAudioGraphForSourceSwitch 采纳回来。
  // 中英对照：Mark the prepared graph as invalidated before detaching, so it can never
  // be adopted again after its nodes have lost their connections.
  var detachedPrepared = audio && audio.__mineradioPreparedAudioGraph;
  if (detachedPrepared && detachedPrepared.source && detachedPrepared.source === source) {
    detachedPrepared.invalidated = true;
  }
  [source, analyser, beatAnalyser, gainNode, analysisSinkNode].forEach(function (node) {
    if (!node) return;
    try { node.disconnect(); } catch (e) { }
  });
  if (!keepSource) {
    source = null;
    audioSourceMedia = null;
  }
  analyser = null;
  beatAnalyser = null;
  gainNode = null;
  analysisSinkNode = null;
  audioReady = false;
}
function restoreMediaTimeWhenReady(media, seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  if (!media || !seconds) return;
  function applyTime() {
    try {
      if (media.duration && isFinite(media.duration)) media.currentTime = Math.min(seconds, Math.max(0, media.duration - 0.25));
      else media.currentTime = seconds;
    } catch (e) { }
  }
  applyTime();
  media.addEventListener('loadedmetadata', applyTime, { once: true });
}
function replaceAudioElementForGraphRecovery(reason, opts) {
  if (!audio) return false;
  opts = opts || {};
  var preservePlayback = opts.preservePlayback !== false;
  var oldAudio = audio;
  var src = preservePlayback ? (oldAudio.currentSrc || oldAudio.src || '') : '';
  var seconds = preservePlayback && isFinite(oldAudio.currentTime) ? oldAudio.currentTime : 0;
  var wasPaused = oldAudio.paused;
  var rate = oldAudio.playbackRate || 1;
  var endedHandler = preservePlayback ? oldAudio.onended : null;
  var metadataHandler = preservePlayback ? oldAudio.onloadedmetadata : null;
  var queueItemKey = oldAudio.__mineradioQueueItemKey;
  try { oldAudio.pause(); } catch (e) { }
  disconnectAudioGraphNodes(false);
  try {
    if (audioCtx && audioCtx.state !== 'closed' && audioCtx.close) audioCtx.close().catch(function () { });
  } catch (e) { }
  audioCtx = null;
  audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = oldAudio.preload || 'auto';
  audio.loop = !!oldAudio.loop || (typeof playMode !== 'undefined' && playMode === 'single');
  audio.playbackRate = rate;
  audio.onended = endedHandler;
  audio.onloadedmetadata = metadataHandler;
  audio.__mineradioQueueItemKey = queueItemKey;
  bindPlaybackProgressEvents(audio);
  applyVolumeToAudio();
  if (src) {
    audio.src = src;
    restoreMediaTimeWhenReady(audio, seconds);
    if (!wasPaused) {
      try { audio.load(); } catch (e) { }
    }
  }
  applyAudioOutputDevice(audio);
  console.warn('audio graph recovery:', reason || 'unknown');
  return true;
}
function resetPlaybackAudioGraphForSourceSwitch(reason) {
  if (!audio) return;
  var preparedGraph = audio.__mineradioPreparedAudioGraph;
  var previousSourceMedia = audioSourceMedia;
  var sourceUsesCapture = !!(source && source.__mineradioUsesCapture);
  var mediaElementChanged = !!(source && previousSourceMedia && previousSourceMedia !== audio);
  // 可复用的 prepared graph 必须同时满足：尚未被采纳过、尚未因断开而失效、且它的
  // source 不是当前正在使用的这一批节点。后两条是必需的 —— 已被 Cuefield 交接采纳或
  // 正被使用的图会在下面被 disconnect，若仍把它取回来就会得到一条已断开的输出链：
  // 播放地址与 UI 正常，但无声且切歌无法恢复。
  // 中英对照：A reusable prepared graph must not be adopted yet, must not have been
  // invalidated by a disconnect, and must not be the graph currently in use.
  var canAdoptPrepared = !!(
    preparedGraph
    && !preparedGraph.adopted
    && !preparedGraph.invalidated
    && !(source && preparedGraph.source === source)
    && preparedGraph.context
    && preparedGraph.context.state !== 'closed'
    && preparedGraph.source
    && preparedGraph.analyser
    && preparedGraph.beatAnalyser
    && preparedGraph.gainNode
  );
  // Chromium can freeze the media clock when a lifetime-bound element (capture
  // or MediaElementSource) gets a new src. Replace it before the next track is
  // assigned, unless this is a prepared/gapless handoff that must keep the
  // already-playing element.
  if (!canAdoptPrepared && previousSourceMedia === audio && (sourceUsesCapture || audio.__mineradioMediaSourceBound)) {
    replaceAudioElementForGraphRecovery(reason || (sourceUsesCapture ? 'capture-track-switch' : 'bound-track-switch'), { preservePlayback: false });
    return;
  }
  disconnectAudioGraphNodes(!sourceUsesCapture && !mediaElementChanged);
  if (canAdoptPrepared) {
    audioCtx = preparedGraph.context;
    source = preparedGraph.source;
    analyser = preparedGraph.analyser;
    beatAnalyser = preparedGraph.beatAnalyser;
    gainNode = preparedGraph.gainNode;
    analysisSinkNode = null;
    audioSourceMedia = audio;
    audio.__mineradioMediaSourceBound = true;
    preparedGraph.adopted = true;
    audioReady = true;
  }
}
function initAudio() {
  if (!audio) return false;
  if (audioGraphHealthy()) return true;
  var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return false;
  if (audioCtx && audioCtx.state === 'closed') replaceAudioElementForGraphRecovery('closed-context');
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContextCtor();
  var keepSource = !!(source && audioSourceMedia === audio && source.context === audioCtx && audioCtx.state !== 'closed');
  var sourceUsesCapture = !!(keepSource && source.__mineradioUsesCapture);
  disconnectAudioGraphNodes(keepSource);
  if (!source) {
    var forceCapture = !!audio.__mineradioForceCaptureSource;
    // Once this Audio element has fallen back from its lifetime-bound
    // MediaElementSource, every later graph rebuild for the same element must
    // stay on captureStream. Keep this marker through failed/overlapping init
    // attempts; clearing it before capture has an audio track reopens the
    // forbidden MediaElementSource rebind path on the next retry.
    var mediaSource = null;
    if (!forceCapture && !audio.__mineradioMediaSourceBound && audioCtx.createMediaElementSource) {
      try {
        mediaSource = audioCtx.createMediaElementSource(audio);
      } catch (mediaErr) {
        mediaSource = null;
        audio.__mineradioMediaSourceBound = true;
        console.warn('media element source unavailable:', mediaErr && (mediaErr.message || mediaErr));
      }
    }
    if (!forceCapture && !mediaSource && audio.__mineradioMediaSourceBound) {
      replaceAudioElementForGraphRecovery('media-source-rebind');
      if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContextCtor();
      try {
        mediaSource = audioCtx.createMediaElementSource(audio);
      } catch (rebindingErr) {
        mediaSource = null;
        console.warn('media element source recovery failed:', rebindingErr && (rebindingErr.message || rebindingErr));
      }
    }
    var capturedStream = null;
    if (!mediaSource) {
      // Calling captureStream() while a freshly assigned src still has no
      // decoded media data can permanently leave Chromium with an empty audio
      // track and a frozen media clock. The track-switch retry path will call
      // initAudio() again after loadeddata/canplay, so wait instead of probing
      // an empty stream here.
      if (forceCapture && Number(audio.readyState) < 2) return false;
      try {
        if (audio && audio.captureStream && audioCtx.createMediaStreamSource) capturedStream = audio.captureStream();
      } catch (captureErr) {
        capturedStream = null;
        console.warn('capture stream source unavailable:', captureErr && (captureErr.message || captureErr));
      }
    }
    if (!mediaSource && !capturedStream) return false;
    try {
      source = mediaSource || audioCtx.createMediaStreamSource(capturedStream);
    } catch (captureSourceErr) {
      source = null;
      audioSourceMedia = null;
      console.warn('capture stream graph unavailable:', captureSourceErr && (captureSourceErr.message || captureSourceErr));
      return false;
    }
    source.__mineradioUsesCapture = !mediaSource;
    audioSourceMedia = audio;
    // This is a lifetime marker, not the type of the current graph source.
    // Never reset it merely because the active fallback happens to be capture.
    if (mediaSource) audio.__mineradioMediaSourceBound = true;
    sourceUsesCapture = !mediaSource;
  }
  analyser = audioCtx.createAnalyser();
  beatAnalyser = audioCtx.createAnalyser();
  gainNode = sourceUsesCapture ? null : audioCtx.createGain();
  analysisSinkNode = sourceUsesCapture ? audioCtx.createGain() : null;
  if (analysisSinkNode) analysisSinkNode.gain.value = 0;
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.58;
  beatAnalyser.fftSize = BEAT_FFT_SIZE;
  beatAnalyser.smoothingTimeConstant = 0.10;
  source.connect(analyser);
  source.connect(beatAnalyser);
  if (gainNode) {
    analyser.connect(gainNode);
    gainNode.connect(audioCtx.destination);
  } else if (analysisSinkNode) {
    analyser.connect(analysisSinkNode);
    analysisSinkNode.connect(audioCtx.destination);
  }
  applyVolumeToAudio();
  frequencyData.fill(0);
  beatFrequencyData.fill(0);
  beatTimeDomainData.fill(128);
  resetRealtimeBeatEngine();
  audioReady = true;
  applyAudioOutputDevice(audio);
  return true;
}
function readPlaybackAnalyserSignal() {
  if (!analyser) return 0;
  try {
    analyser.getByteTimeDomainData(timeDomainData);
    analyser.getByteFrequencyData(frequencyData);
    var timeSum = 0;
    var freqSum = 0;
    var step = Math.max(1, Math.floor(timeDomainData.length / 256));
    for (var i = 0; i < timeDomainData.length; i += step) timeSum += Math.abs(timeDomainData[i] - 128);
    var freqStep = Math.max(1, Math.floor(frequencyData.length / 256));
    for (var j = 0; j < frequencyData.length; j += freqStep) freqSum += frequencyData[j];
    return (timeSum / Math.max(1, Math.ceil(timeDomainData.length / step)) / 128) + (freqSum / Math.max(1, Math.ceil(frequencyData.length / freqStep)) / 255);
  } catch (e) {
    return 0;
  }
}
function rebuildPlaybackGraphWithCapture(reason) {
  if (!audio || !audio.captureStream || !audioCtx || !audioCtx.createMediaStreamSource) return false;
  // Chromium freezes playback if an element is moved from its lifetime-bound
  // MediaElementSource to captureStream. Reconnect the existing source node
  // instead; a silent analyser must never be repaired by sacrificing the media
  // clock. Fresh, never-bound elements may still use capture as a fallback.
  if (audio.__mineradioMediaSourceBound) {
    if (!source || source.__mineradioUsesCapture || audioSourceMedia !== audio) return false;
    disconnectAudioGraphNodes(true);
    var reused = initAudio();
    if (reused) console.warn('audio analyser reconnected with lifetime media source:', reason || 'silent-graph');
    return reused;
  }
  disconnectAudioGraphNodes(false);
  audio.__mineradioForceCaptureSource = true;
  var ok = initAudio();
  if (ok) console.warn('audio analyser recovered with capture stream:', reason || 'silent-graph');
  return ok;
}
var playbackAnalyserRecoverySerial = 0;
function schedulePlaybackAnalyserRecovery(reason) {
  var serial = ++playbackAnalyserRecoverySerial;
  var token = trackSwitchToken;
  var recoveryMedia = audio;
  var recoverySrc = recoveryMedia && (recoveryMedia.currentSrc || recoveryMedia.src || '');
  var previousMediaTime = recoveryMedia && isFinite(recoveryMedia.currentTime) ? recoveryMedia.currentTime : 0;
  var advancingSilentSamples = 0;
  [720, 1600, 2800].forEach(function (delay) {
    setTimeout(function () {
      if (serial !== playbackAnalyserRecoverySerial || token !== trackSwitchToken) return;
      if (!audio || audio !== recoveryMedia || audio.paused || audio.ended || !audio.src) return;
      if ((audio.currentSrc || audio.src || '') !== recoverySrc) return;
      if (!audioReady || !analyser || !source) {
        ensurePlaybackAudioGraph('analyser-health-missing-' + (reason || 'playback'));
        return;
      }
      var current = isFinite(audio.currentTime) ? audio.currentTime : 0;
      var mediaClockAdvanced = current >= previousMediaTime + 0.08;
      previousMediaTime = current;
      if (current < 0.45 || !mediaClockAdvanced) {
        advancingSilentSamples = 0;
        return;
      }
      var signal = readPlaybackAnalyserSignal();
      if (signal > 0.0025) {
        advancingSilentSamples = 0;
        return;
      }
      advancingSilentSamples++;
      // A single zero-energy sample during decoder startup is not enough to
      // rebuild the graph. Require the media clock to advance across samples;
      // a frozen clock is a media stall and must never be treated as a silent
      // analyser graph.
      if (advancingSilentSamples < 2) return;
      if (source && !source.__mineradioUsesCapture && audio.captureStream) {
        rebuildPlaybackGraphWithCapture(reason || 'silent-after-track-switch');
        ensurePlaybackAudioGraph('analyser-health-capture-' + (reason || 'playback'));
      }
    }, delay);
  });
}
function resumeAudioAnalysis() {
  if (audioCtx && audioCtx.state === 'closed') {
    replaceAudioElementForGraphRecovery('resume-closed-context');
    initAudio();
  }
  if (audioCtx && audioCtx.state === 'suspended') return audioCtx.resume().catch(function (e) { console.warn('audio context resume failed:', e); });
  return Promise.resolve();
}
async function ensurePlaybackAudioGraph(reason) {
  if (!audio) return false;
  if (!audioGraphHealthy()) initAudio();
  await resumeAudioAnalysis();
  if (!audioGraphHealthy()) initAudio();
  await resumeAudioAnalysis();
  if (!audioGraphHealthy()) console.warn('audio graph still unhealthy:', reason || 'playback');
  return audioGraphHealthy();
}

function ensureUiSfxContext() {
  var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!uiSfxCtx || uiSfxCtx.state === 'closed') uiSfxCtx = new AudioContextCtor();
  applyAudioOutputDevice(audio);
  if (uiSfxCtx.state === 'suspended' && uiSfxCtx.resume) uiSfxCtx.resume().catch(function () { });
  return uiSfxCtx;
}

function playShelfSelectTick(direction, variant) {
  var nowMs = performance.now();
  var minGap = variant === 'row' ? 36 : 42;
  if (nowMs - lastShelfSelectSfxAt < minGap) return;
  var ctx = ensureUiSfxContext();
  if (!ctx) return;
  lastShelfSelectSfxAt = nowMs;
  var dir = direction < 0 ? -1 : 1;
  var pitch = dir > 0 ? 1.035 : 0.965;
  var rowScale = variant === 'row' ? 0.74 : 1.0;
  var volumeScale = 0.38 + Math.max(0, Math.min(1, targetVolume == null ? 0.65 : targetVolume)) * 0.62;
  var t = ctx.currentTime + 0.002;
  var out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.linearRampToValueAtTime(0.058 * rowScale * volumeScale, t + 0.002);
  out.gain.exponentialRampToValueAtTime(0.0001, t + 0.082);
  out.connect(ctx.destination);

  var sampleRate = ctx.sampleRate || 44100;
  var len = Math.max(1, Math.floor(sampleRate * 0.034));
  var buf = ctx.createBuffer(1, len, sampleRate);
  var data = buf.getChannelData(0);
  for (var i = 0; i < len; i++) {
    var e = Math.pow(1 - i / len, 4.2);
    data[i] = (Math.random() * 2 - 1) * e;
  }
  var noise = ctx.createBufferSource();
  noise.buffer = buf;
  var hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(4200 * pitch, t);
  var bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(8400 * pitch, t);
  bp.Q.setValueAtTime(7.2, t);
  var ng = ctx.createGain();
  ng.gain.setValueAtTime(0.56, t);
  noise.connect(hp);
  hp.connect(bp);
  bp.connect(ng);
  ng.connect(out);
  noise.start(t);
  noise.stop(t + 0.040);

  function clickOsc(type, freq, delay, dur, gainValue, bend) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    var start = t + delay;
    var end = start + dur;
    osc.type = type;
    osc.frequency.setValueAtTime(freq * pitch, start);
    osc.frequency.exponentialRampToValueAtTime(freq * pitch * (bend || 0.72), end);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gainValue, start + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g);
    g.connect(out);
    osc.start(start);
    osc.stop(end + 0.004);
  }

  clickOsc('triangle', 720, 0.000, 0.030, 0.18, 0.70);
  clickOsc('square', 2180, 0.004, 0.022, 0.30, 0.86);
  clickOsc('triangle', 4200, 0.011, 0.018, 0.18, 0.94);
  clickOsc('square', 7100, 0.018, 0.012, 0.070, 0.98);
  setTimeout(function () {
    try { out.disconnect(); } catch (_) { }
  }, 160);
}

function clearAudioFadeTimers() {
  if (audioFadeTimer) {
    clearTimeout(audioFadeTimer);
    audioFadeTimer = null;
  }
  cancelAudioElementFadeFrame();
  clearAudioAudibilityRecoveryTimers();
}
function cancelAudioElementFadeFrame() {
  if (audioElementFadeFrame) {
    cancelAnimationFrame(audioElementFadeFrame);
    audioElementFadeFrame = 0;
  }
}
var audioAudibilityRecoveryTimers = [];
function clearAudioAudibilityRecoveryTimers() {
  if (!audioAudibilityRecoveryTimers || !audioAudibilityRecoveryTimers.length) return;
  audioAudibilityRecoveryTimers.forEach(function (timer) { clearTimeout(timer); });
  audioAudibilityRecoveryTimers = [];
}
function currentAudioOutputGain() {
  if (isFinite(audioFadeEnvelope)) return clampRange(targetVolume * audioFadeEnvelope, 0, 1);
  if (audio && isFinite(audio.volume)) return clampRange(Number(audio.volume), 0, 1);
  if (gainNode && gainNode.gain && isFinite(gainNode.gain.value)) return clampRange(Number(gainNode.gain.value), 0, 1);
  return clampRange(targetVolume, 0, 1);
}
function audioSilentFloor() {
  return targetVolume > 0.001 ? AUDIO_SILENCE_GAIN : 0;
}
function normalizeAudioFadeTarget(value) {
  value = clampRange(Number(value) || 0, 0, 1);
  return value <= 0.001 ? audioSilentFloor() : value;
}
function writeAudioOutputGain(value) {
  value = normalizeAudioFadeTarget(value);
  audioFadeEnvelope = targetVolume > 0.001 ? clampRange(value / targetVolume, 0, 1) : (value > 0.001 ? 1 : 0);
  var branchValue = (gainNode && audioCtx) ? Math.sqrt(value) : value;
  if (audio) {
    audio.muted = false;
    audio.volume = branchValue;
  }
  if (gainNode && audioCtx) {
    try {
      var now = audioCtx.currentTime || 0;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(branchValue, now);
    } catch (e) { }
  }
}
function holdAudioOutputGain(now) {
  var current = currentAudioOutputGain();
  if (!gainNode || !audioCtx || !gainNode.gain) return current;
  var param = gainNode.gain;
  try {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(now);
      return currentAudioOutputGain();
    }
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
  } catch (e) {
    try {
      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
    } catch (_) { }
  }
  return current;
}
function setAudioOutputGainImmediate(value) {
  value = normalizeAudioFadeTarget(value);
  clearAudioFadeTimers();
  writeAudioOutputGain(value);
}
function rampAudioOutputGain(value, durationMs) {
  value = normalizeAudioFadeTarget(value);
  durationMs = Math.max(0, Number(durationMs) || 0);
  clearAudioFadeTimers();
  var serial = audioFadeSerial;
  if (gainNode && audioCtx) holdAudioOutputGain(audioCtx.currentTime || 0);
  if (durationMs <= 0) {
    writeAudioOutputGain(value);
    return;
  }
  var from = currentAudioOutputGain();
  var started = performance.now();
  function tickAudioFade(nowMs) {
    if (serial !== audioFadeSerial) return;
    var t = durationMs ? clampRange((nowMs - started) / durationMs, 0, 1) : 1;
    var eased = 1 - Math.pow(1 - t, 3);
    writeAudioOutputGain(from + (value - from) * eased);
    if (t < 1) audioElementFadeFrame = requestAnimationFrame(tickAudioFade);
    else audioElementFadeFrame = 0;
  }
  audioElementFadeFrame = requestAnimationFrame(tickAudioFade);
}
function isBackgroundAudioFadeConstrained() {
  try {
    if (typeof isDeepBackgroundMode === 'function' && isDeepBackgroundMode()) return true;
  } catch (e) { }
  try {
    if (document && document.hidden) return true;
  } catch (e2) { }
  try {
    if (typeof desktopRuntimeState !== 'undefined' && (desktopRuntimeState.minimized || desktopRuntimeState.visible === false)) return true;
  } catch (e3) { }
  return false;
}
function ensureAudiblePlaybackGain(reason) {
  if (!audio || audio.paused || audio.ended || !audio.src) return false;
  if (targetVolume <= 0.001) return false;
  if (typeof cuefieldAutoMixExecuting !== 'undefined' && cuefieldAutoMixExecuting) return false;
  if (
    typeof albumGaplessState !== 'undefined'
    && albumGaplessState
    && albumGaplessState.preload
    && (albumGaplessState.preload.mixPending || albumGaplessState.preload.mixStarted)
  ) return false;
  if (
    typeof progressDragState !== 'undefined'
    && progressDragState
    && (progressDragState.active || progressDragState.previewHoldUntil > performance.now())
  ) return false;
  var current = currentAudioOutputGain();
  var floor = Math.max(0.004, targetVolume * 0.10);
  if (current > floor) return false;
  setAudioOutputGainImmediate(targetVolume);
  console.warn('[AudioFade] restored silent playback gain:', reason || 'playback');
  return true;
}
function scheduleAudioAudibilityRecovery(reason) {
  clearAudioAudibilityRecoveryTimers();
  if (targetVolume <= 0.001) return;
  var serial = audioFadeSerial;
  var token = trackSwitchToken;
  [520, 1400, 3200].forEach(function (delay) {
    var timer = setTimeout(function () {
      if (serial !== audioFadeSerial || token !== trackSwitchToken) return;
      ensureAudiblePlaybackGain(reason || 'track-switch');
    }, delay);
    audioAudibilityRecoveryTimers.push(timer);
  });
}
function preparePlaybackFadeIn() {
  audioFadeSerial++;
  setAudioOutputGainImmediate(0);
}
function startPlaybackFadeIn() {
  audioFadeSerial++;
  if (targetVolume <= 0.001) {
    setAudioOutputGainImmediate(0);
    return;
  }
  if (isBackgroundAudioFadeConstrained()) {
    setAudioOutputGainImmediate(targetVolume);
    return;
  }
  rampAudioOutputGain(targetVolume, AUDIO_FADE_IN_MS);
  scheduleAudioAudibilityRecovery('fade-in-watchdog');
}
function restorePlaybackGain() {
  audioFadeSerial++;
  setAudioOutputGainImmediate(targetVolume);
}
function fadeOutAndPauseAudio() {
  if (!audio || audio.paused) return Promise.resolve(false);
  var serial = ++audioFadeSerial;
  rampAudioOutputGain(0, AUDIO_FADE_OUT_MS);
  return new Promise(function (resolve) {
    audioFadeTimer = setTimeout(function () {
      audioFadeTimer = null;
      if (serial !== audioFadeSerial || !audio) {
        resolve(false);
        return;
      }
      try { audio.pause(); } catch (pauseErr) { console.warn('[TogglePlayPause]', pauseErr); }
      setAudioOutputGainImmediate(0);
      resolve(true);
    }, AUDIO_FADE_OUT_MS + 80);
  });
}

function applyVolumeToAudio(opts) {
  opts = opts || {};
  if (opts.restoreEnvelope && targetVolume > 0.001) audioFadeEnvelope = 1;
  writeAudioOutputGain(targetVolume * clampRange(audioFadeEnvelope, 0, 1));
}

function updateVolumeUi() {
  var slider = document.getElementById('volume-slider');
  var value = document.getElementById('volume-value');
  var icon = document.getElementById('volume-icon');
  var wrap = document.getElementById('volume-control');
  var pct = Math.round(targetVolume * 100);
  if (slider && Math.abs(parseFloat(slider.value) - targetVolume) > 0.001) slider.value = targetVolume;
  if (value) value.textContent = pct + '%';
  if (wrap) wrap.classList.toggle('muted', targetVolume <= 0.01);
  if (icon) {
    icon.innerHTML = targetVolume <= 0.01
      ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="17" y1="9" x2="22" y2="14"/><line x1="22" y1="9" x2="17" y2="14"/>'
      : targetVolume < 0.45
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15 10.5a2 2 0 0 1 0 3"/>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M18 7a7 7 0 0 1 0 10"/>';
  }
  updateAudioFadeUi();
}
function audioFadeSecondsLabel(ms) {
  ms = normalizeAudioFadeMs(ms, 0);
  return (ms / 1000).toFixed(ms % 1000 ? 2 : 1).replace(/0$/, '') + 's';
}
function updateAudioFadeUi() {
  var fadeInSlider = document.getElementById('fade-in-slider');
  var fadeOutSlider = document.getElementById('fade-out-slider');
  var fadeInValue = document.getElementById('fade-in-value');
  var fadeOutValue = document.getElementById('fade-out-value');
  var inSeconds = (AUDIO_FADE_IN_MS / 1000).toFixed(2);
  var outSeconds = (AUDIO_FADE_OUT_MS / 1000).toFixed(2);
  if (fadeInSlider && Math.abs(Number(fadeInSlider.value) - Number(inSeconds)) > 0.001) fadeInSlider.value = inSeconds;
  if (fadeOutSlider && Math.abs(Number(fadeOutSlider.value) - Number(outSeconds)) > 0.001) fadeOutSlider.value = outSeconds;
  if (fadeInValue) fadeInValue.textContent = audioFadeSecondsLabel(AUDIO_FADE_IN_MS);
  if (fadeOutValue) fadeOutValue.textContent = audioFadeSecondsLabel(AUDIO_FADE_OUT_MS);
}
function setAudioFadeSetting(kind, seconds, silent) {
  var ms = normalizeAudioFadeMs(Number(seconds) * 1000, kind === 'in' ? 460 : 420);
  if (kind === 'in') AUDIO_FADE_IN_MS = ms;
  else AUDIO_FADE_OUT_MS = ms;
  saveAudioFadePreference();
  updateAudioFadeUi();
  if (!silent) showToast((kind === 'in' ? audioGraphControlsText('agc_fade_in') : audioGraphControlsText('agc_fade_out')) + audioFadeSecondsLabel(ms));
}

function setVolume(value, silent) {
  var next = Math.max(0, Math.min(1, Number(value) || 0));
  var previous = targetVolume;
  var shouldRestoreAudibleEnvelope = next > 0.001 && !audioFadeTimer && (previous <= 0.001 || clampRange(audioFadeEnvelope, 0, 1) <= 0.0015);
  targetVolume = next;
  if (next > 0.01) lastNonZeroVolume = next;
  try { localStorage.setItem('apex-player-volume', String(next)); } catch (e) { }
  if (shouldRestoreAudibleEnvelope) cancelAudioElementFadeFrame();
  applyVolumeToAudio({ restoreEnvelope: shouldRestoreAudibleEnvelope });
  updateVolumeUi();
  if (!silent) showToast(audioGraphControlsText('gesture_volume') + Math.round(next * 100) + '%');
}
function adjustVolumeByKeyboard(delta) {
  var step = Number(delta) || 0;
  if (!step) return;
  setVolume(clampRange(targetVolume + step, 0, 1), false);
}
function adjustVolumeByWheel(e) {
  if (!e) return;
  e.preventDefault();
  e.stopPropagation();
  var step = 0.01;
  var direction = e.deltaY < 0 ? 1 : -1;
  var wrap = document.getElementById('volume-control');
  if (wrap) {
    wrap.classList.add('open');
    if (volumeCloseTimer) clearTimeout(volumeCloseTimer);
    volumeCloseTimer = setTimeout(function () {
      volumeCloseTimer = null;
      if (wrap && !wrap.matches(':hover')) wrap.classList.remove('open');
    }, 1200);
  }
  setVolume(clampRange(targetVolume + direction * step, 0, 1), false);
}

function toggleVolumePanel(e) {
  if (e) e.stopPropagation();
  var wrap = document.getElementById('volume-control');
  if (volumeCloseTimer) { clearTimeout(volumeCloseTimer); volumeCloseTimer = null; }
  if (wrap) wrap.classList.toggle('open');
}

function releaseVolumePanelFocus(wrap) {
  wrap = wrap || document.getElementById('volume-control');
  var active = document.activeElement;
  if (!wrap || !active || !wrap.contains(active) || typeof active.blur !== 'function') return;
  try { active.blur(); } catch (e) { }
}

function closeVolumePanel(force) {
  var wrap = document.getElementById('volume-control');
  if (volumeCloseTimer) {
    clearTimeout(volumeCloseTimer);
    volumeCloseTimer = null;
  }
  if (!wrap) return;
  wrap.classList.remove('open');
  releaseVolumePanelFocus(wrap);
  if (force) {
    wrap.classList.add('handoff-closing');
    setTimeout(function () {
      if (wrap && !wrap.classList.contains('sibling-suppressed')) wrap.classList.remove('handoff-closing');
    }, 220);
  } else {
    wrap.classList.remove('handoff-closing');
  }
}

function setVolumePanelSiblingSuppressed(suppressed) {
  var wrap = document.getElementById('volume-control');
  if (!wrap) return;
  if (suppressed) {
    wrap.classList.add('sibling-suppressed');
    closeVolumePanel(true);
  } else {
    wrap.classList.remove('sibling-suppressed', 'handoff-closing');
  }
}

function toggleMute() {
  setVolume(targetVolume > 0.01 ? 0 : (lastNonZeroVolume || 0.8));
}

function bindVolumeControls() {
  var slider = document.getElementById('volume-slider');
  var fadeInSlider = document.getElementById('fade-in-slider');
  var fadeOutSlider = document.getElementById('fade-out-slider');
  var btn = document.getElementById('volume-btn');
  var wrap = document.getElementById('volume-control');
  function keepVolumePanelOpen() {
    if (volumeCloseTimer) { clearTimeout(volumeCloseTimer); volumeCloseTimer = null; }
    if (wrap && !wrap.classList.contains('sibling-suppressed')) wrap.classList.add('open');
  }
  function closeVolumePanelSoon() {
    if (volumeCloseTimer) clearTimeout(volumeCloseTimer);
    volumeCloseTimer = setTimeout(function () {
      volumeCloseTimer = null;
      if (wrap) closeVolumePanel(false);
    }, 520);
  }
  if (wrap) {
    wrap.addEventListener('mouseenter', keepVolumePanelOpen);
    wrap.addEventListener('mouseleave', closeVolumePanelSoon);
  }
  if (slider) {
    slider.addEventListener('input', function () { setVolume(slider.value, true); });
    slider.addEventListener('focus', keepVolumePanelOpen);
    slider.addEventListener('blur', closeVolumePanelSoon);
    slider.addEventListener('change', function () { showToast(audioGraphControlsText('gesture_volume') + Math.round(targetVolume * 100) + '%'); });
  }
  if (fadeInSlider) {
    fadeInSlider.addEventListener('input', function () { setAudioFadeSetting('in', fadeInSlider.value, true); });
    fadeInSlider.addEventListener('focus', keepVolumePanelOpen);
    fadeInSlider.addEventListener('blur', closeVolumePanelSoon);
    fadeInSlider.addEventListener('change', function () { setAudioFadeSetting('in', fadeInSlider.value, false); });
  }
  if (fadeOutSlider) {
    fadeOutSlider.addEventListener('input', function () { setAudioFadeSetting('out', fadeOutSlider.value, true); });
    fadeOutSlider.addEventListener('focus', keepVolumePanelOpen);
    fadeOutSlider.addEventListener('blur', closeVolumePanelSoon);
    fadeOutSlider.addEventListener('change', function () { setAudioFadeSetting('out', fadeOutSlider.value, false); });
  }
  if (btn) {
    btn.addEventListener('dblclick', function (e) { e.stopPropagation(); toggleMute(); });
  }
  if (wrap && !wrap._wheelBound) {
    wrap._wheelBound = true;
    wrap.addEventListener('wheel', adjustVolumeByWheel, { passive: false });
  }
  document.addEventListener('click', function (e) {
    if (!wrap) return;
    if (!wrap.contains(e.target)) {
      closeVolumePanel(false);
    }
  });
  updateVolumeUi();
  updateAudioFadeUi();
  applyVolumeToAudio();
}

// ============================================================
//  播放队列
