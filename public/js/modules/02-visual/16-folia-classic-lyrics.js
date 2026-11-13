// Folia-classic lyric style, implemented independently for Mineradio.
// Clean-room: no Folia code, shaders, fonts or assets were copied; the visual
// behaviour (a loose per-word line, randomised poses, a sung word blooming and
// drifting after it passes) was reproduced from watching the effect.
//
// The regular stage lyrics are WebGL meshes. While this style is selected we
// hide `stageLyrics.group` and draw the line as DOM text above the canvas,
// which keeps the text crisp and cheap on low-end machines.
(function () {
  'use strict';

  var STYLE_ID = 'classic';
  var ROOT_ID = 'folia-classic-lyrics';
  var root = null;
  var floatNode = null;
  var lineNode = null;
  var translationNode = null;
  var wordNodes = [];
  var wordTimes = [];
  var lastLineKey = '';
  var renderedLine = null;
  var renderedNextLine = null;
  var lineTiming = { renderEnd: 0, revealMode: 'normal', lookahead: 0.15 };
  var lastPaletteKey = '';
  var lastGlowBeatStep = null;
  var lastSettingsKey = '';
  var lastTrackToken = null;
  var trackSwitchQuietUntil = 0;
  var groupWasHiddenByUs = false;

  function foliaStyleOn() {
    return typeof fx !== 'undefined' && fx && fx.lyricStyle === STYLE_ID;
  }

  function foliaLyricsUsable() {
    return foliaStyleOn()
      && typeof lyricsLines !== 'undefined'
      && Array.isArray(lyricsLines)
      && lyricsLines.length > 0
      && (!fx || fx.particleLyrics !== false)
      && (!document.body || !document.body.classList.contains('empty-home-active'))
      && (!document.body || !document.body.classList.contains('splash-active'));
  }

  function ensureRoot() {
    if (root && root.isConnected) return;
    var host = document.getElementById('canvas-container') || document.body;
    root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.setAttribute('aria-hidden', 'true');
      host.appendChild(root);
    }
    root.innerHTML = '';
    floatNode = document.createElement('div');
    floatNode.className = 'folia-classic-float';
    translationNode = document.createElement('div');
    translationNode.className = 'folia-classic-translation';
    root.appendChild(floatNode);
    root.appendChild(translationNode);
    lineNode = null;
    wordNodes = [];
    wordTimes = [];
    lastLineKey = '';
    lastPaletteKey = '';
    lastGlowBeatStep = null;
    lastSettingsKey = '';
  }

  function lyricNowSeconds() {
    var seconds = typeof getPlaybackCurrentSeconds === 'function'
      ? getPlaybackCurrentSeconds()
      : (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime) ? audio.currentTime : 0);
    if (typeof getAdjustedLyricPlaybackTime === 'function') {
      var adjusted = getAdjustedLyricPlaybackTime(seconds);
      if (isFinite(adjusted)) seconds = adjusted;
    }
    return Math.max(0, seconds);
  }

  // Deterministic hash so a line always keeps the same poses; time only changes
  // the state of each word, never the layout.
  function hashUnit(seed) {
    var x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  // 每一行像被一台随机角度的摄影机拍到：整行绕中心做轻微旋转/横向压缩。
  // 换行时新句从上一句的机位平滑落到自己的机位，所以这里只描述"落点"，
  // 不再把整行从屏幕外甩进来。
  function linePose(seed) {
    var s = Math.max(0.01, Number(seed) || 0.01);
    var rx = (hashUnit(s * 3.13 + 0.7) - 0.5) * 28;
    var ry = (hashUnit(s * 5.71 + 1.3) - 0.5) * 44;
    var rz = (hashUnit(s * 7.37 + 2.1) - 0.5) * 20;
    var scale = 0.88 + hashUnit(s * 9.19 + 3.7) * 0.16;
    var scaleX = 0.92 + hashUnit(s * 17.41 + 7.3) * 0.16;
    return {
      rx: rx, ry: ry, rz: rz, scale: scale, scaleX: scaleX
    };
  }

  // 一行歌词实际只唱一小段，但 LRC 里「下一行的时间」还含着句尾气口甚至整段间奏。
  // 直接把它当演唱时长铺开，字就会一路慢慢亮：唱到第 6 个字时画面才亮到第 3 个，
  // 也就是「跟不上嘴」。这里按实测吐字速度（0.34s/汉字、0.35 权重的拉丁字母）
  // 估一个演唱时长，只在间隔明显超出它时才收束；间隔≈演唱时长的正常行不动。
  var SUNG_SEC_PER_CHAR = 0.34;
  var SUNG_SEC_PER_LATIN = 0.35;
  var SUNG_TAIL_SEC = 0.9;
  function sungSpanSeconds(text) {
    var raw = String(text || '');
    var weight = 0;
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) weight += 1;
      else if (/[A-Za-z0-9]/.test(ch)) weight += SUNG_SEC_PER_LATIN;
    }
    return weight > 0 ? weight * SUNG_SEC_PER_CHAR + SUNG_TAIL_SEC : 0;
  }

  // 「On My Love......」「He~he...he~he……」这类行本来就靠拖音把时间占满，
  // 收束会把它们剪成正常语速，反而让字跑在前面。带省略号/波浪号/长破折号的一律不动。
  function isSustainedVocalLine(text) {
    return /[~\uFF5E\u2026]|\.{3,}|[\u2014\u2015-]{3,}/.test(String(text || ''));
  }

  // Folia 对 LRC 行的收尾不是直接用下一行时间：如果中间隔了很久，会把这一行
  // 按演唱时长截断，剩下的空档交给间奏。否则长间奏会把整行歌词拖成慢动作。
  function lineSpanEnd(line, nextLine) {
    var start = Math.max(0, Number(line && line.t) || 0);
    var nextT = nextLine && Number(nextLine.t) > start ? Number(nextLine.t) : 0;
    var duration = nextT
      ? nextT - start
      : Math.max(0.6, Number(line && line.duration) || 5);
    var hasWords = Array.isArray(line && line.words) && line.words.length > 0;
    var sung = sungSpanSeconds(line && line.text);
    // 收束只作用于行级（LRC）歌词：逐词时间轴（YRC）已经带着真实词窗，不能动。
    if (!hasWords && nextT && sung > 0 && !isSustainedVocalLine(line && line.text) && duration > sung + 0.3) {
      duration = sung;
    }
    var end = start + Math.max(0.5, Math.min(duration, 12));
    if (hasWords) {
      for (var wi = 0; wi < line.words.length; wi++) {
        var w = line.words[wi];
        var wordEnd = Number(w && w.t) + Math.max(0, Number(w && w.d) || 0.24);
        if (isFinite(wordEnd)) end = Math.max(end, wordEnd);
      }
    }
    return end;
  }

  // 没有逐词时间轴时，单字切分只能当兜底：中文歌是一个词一个词唱出来的。
  // 分词统一交给 17-cjk-word-segmenter 的 splitWords()：它负责「词典优先 →
  // Intl.Segmenter 兜底 → 虚词/标点吸附」的完整规则。商籁用的是同一个入口，
  // 两个样式才不会把同一行歌词断在不同位置。
  function segmentFallbackWords(text) {
    if (window.cjkWordSegmenter && window.cjkWordSegmenter.splitWords) {
      return window.cjkWordSegmenter.splitWords(text);
    }
    // 分词器模块没加载时（不该发生，index-loader 保证它在前）至少别丢字。
    var raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return raw ? [raw] : [];
  }

  // 与 Folia 的行级时间估算对齐：汉字按字权重 1、标点权重 0、拉丁词权重
  // 1 + 长度*0.15；只把行时长的 90% 用来推进，最后 10% 留给尾音。
  function unitWeight(text) {
    var chars = Array.from(String(text || ''));
    var weight = 0;
    var latin = 0;
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (/[㐀-鿿぀-ヿ가-힯]/.test(ch)) {
        weight += /[，。！？、：；"')】》」』]/.test(ch) ? 0 : 1;
      } else if (/[A-Za-z0-9]/.test(ch)) {
        latin += 1;
      }
    }
    if (latin) weight += 1 + latin * 0.15;
    return weight;
  }

  // Folia builds LRC timing one grapheme at a time: CJK grapheme weight 1,
  // punctuation weight 0 (it still advances 0.05s), Latin run weight 1+len*0.15.
  // Only 90% of the line duration drives the sweep; the last 10% is tail.
  // Words then inherit first-grapheme start and last-grapheme end (sticky
  // punctuation included), which keeps the word rhythm identical to Folia's.
  function spreadUnits(units, start, end) {
    var subs = [];
    for (var wi = 0; wi < units.length; wi++) {
      var text = String(units[wi].text || '');
      var re = /[A-Za-z0-9]+|[^s]/gu;
      var m;
      while ((m = re.exec(text))) {
        var tok = m[0];
        var weight;
        if (/^[A-Za-z0-9]+$/.test(tok)) weight = 1 + tok.length * 0.15;
        else if (/[，。！？、：；"'）】》」』]/.test(tok)) weight = 0;
        else weight = 1;
        subs.push({ w: wi, weight: weight });
      }
    }
    if (!subs.length) {
      for (var u = 0; u < units.length; u++) {
        units[u].start = start;
        units[u].end = start + 0.05;
      }
      return;
    }
    var total = 0;
    for (var si = 0; si < subs.length; si++) total += subs[si].weight;
    if (total <= 0) total = 1;
    var active = Math.max(0.1, end - start) * 0.9;
    var perWeight = active / total;
    var cursor = start;
    for (var sj = 0; sj < subs.length; sj++) {
      var sub = subs[sj];
      var rawDuration = sub.weight > 0 ? sub.weight * perWeight : 0;
      var finalDuration = Math.max(rawDuration, 0.05);
      sub.start = cursor;
      sub.end = cursor + finalDuration;
      cursor += sub.weight > 0 ? rawDuration : 0.05;
    }
    var last = subs[subs.length - 1];
    if (last.end > end) {
      var scale = (end - start) / Math.max(0.1, last.end - start);
      for (var sk = 0; sk < subs.length; sk++) {
        subs[sk].start = start + (subs[sk].start - start) * scale;
        subs[sk].end = start + (subs[sk].end - start) * scale;
      }
    }
    var firstAt = [];
    var lastAt = [];
    for (var sm = 0; sm < subs.length; sm++) {
      var sub2 = subs[sm];
      // 必须是 == null 而不是取反：整行从 0 秒开始时 firstAt[0] 就是 0，
      // 取反会把第一个字的起点当成「还没赋值」，词要晚一个字才亮（商籁没有这个问题）。
      if (firstAt[sub2.w] == null) firstAt[sub2.w] = sub2.start;
      lastAt[sub2.w] = sub2.end;
    }
    for (var un = 0; un < units.length; un++) {
      if (firstAt[un] == null) {
        units[un].start = start;
        units[un].end = start + 0.05;
      } else {
        units[un].start = firstAt[un];
        units[un].end = lastAt[un];
      }
    }
  }

  function buildWords(line, nextLine) {
    var lineStart = Math.max(0, Number(line && line.t) || 0);
    var lineEnd = lineSpanEnd(line, nextLine);
    var words = Array.isArray(line && line.words) ? line.words : null;
    var units = [];
    var i;
    if (words && words.length) {
      for (i = 0; i < words.length; i++) {
        var w = words[i];
        var text = String(w && w.text || '').trim();
        if (!text) continue;
        var start = Math.max(lineStart, Number(w.t) || lineStart);
        // 有的源给了逐词起点却没有时长。拿整行平均值会把每个词拖得很长，
        // 和普通歌词的逐字进度完全对不上；优先用下一个词的起点，其次 0.24s。
        var nextWord = words[i + 1];
        var nextStart = nextWord && Number(nextWord.t) > start ? Number(nextWord.t) : 0;
        var duration = Number(w.d) > 0 ? Number(w.d) : (nextStart ? nextStart - start : 0);
        if (!(duration > 0)) duration = 0.24;
        duration = Math.max(0.08, duration);
        units.push({ text: text, start: start, end: start + duration });
      }
      if (units.length) {
        // 有些歌词源给了 words 但所有 t 都一样，结果仍是整行同亮；按行时长重新铺开。
        var minStart = Infinity;
        var maxStart = -Infinity;
        for (i = 0; i < units.length; i++) {
          minStart = Math.min(minStart, units[i].start);
          maxStart = Math.max(maxStart, units[i].start);
        }
        if (units.length > 1 && maxStart - minStart < 0.05) spreadUnits(units, lineStart, lineEnd);
        return units;
      }
    }
    var raw = String(line && line.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return units;
    var tokens = segmentFallbackWords(raw);
    for (i = 0; i < tokens.length; i++) units.push({ text: tokens[i], start: lineStart, end: lineEnd });
    spreadUnits(units, lineStart, lineEnd);
    return units;
  }

  // Follow the same palette the WebGL lyrics use, so the DIY colour controls
  // (cover colour / custom swatches / highlight / glow) apply to this style too.
  function syncPalette() {
    var pal = null;
    if (typeof stageLyrics !== 'undefined' && stageLyrics) {
      pal = stageLyrics.palette || stageLyrics.coverPalette || null;
    }
    if (!pal || !root) return;
    var glowOn = !(typeof fx !== 'undefined' && fx && fx.lyricGlow === false);
    var linked = !(typeof fx !== 'undefined' && fx && fx.lyricGlowLinked === false);
    var customGlow = (typeof fx !== 'undefined' && fx && fx.lyricGlowColor) ? fx.lyricGlowColor : '';
    var glowHex = (!linked && customGlow) ? customGlow : (pal.glowColor || pal.secondary || '#a9d4ff');
    var strength = (typeof fx !== 'undefined' && fx && isFinite(fx.lyricGlowStrength)) ? Number(fx.lyricGlowStrength) : 0.28;
    var beat = 0;
    if (glowOn && typeof fx !== 'undefined' && fx && fx.lyricGlowBeat && typeof stageLyrics !== 'undefined' && stageLyrics) {
      beat = Math.max(0, Math.min(1, Number(stageLyrics.beatGlow) || 0));
    }
    // 鼓点每帧都在变；按 0.2 量化后最多 5 次/秒写一次辉光。写入的是根节点
    // 的 CSS 变量，会让整棵歌词重新计算 text-shadow/圆环；5Hz 对柔和的辉光
    // 脉冲几乎不可见，却把这类重算次数从 10Hz 再减半。
    var beatStep = Math.round(beat * 5) / 5;
    var level = glowOn ? Math.max(0, Math.min(1.3, strength / 0.28)) * (1 + beatStep * 0.35) : 0;
    var rgb = hexRgb(glowHex);
    var key = [pal.primary, pal.highlight, pal.secondary, glowHex, glowOn, linked, strength.toFixed(2)].join('|');
    if (key !== lastPaletteKey) {
      lastPaletteKey = key;
      root.style.setProperty('--folia-ink', pal.primary || '#eaf3ff');
      root.style.setProperty('--folia-hi', pal.highlight || '#ffffff');
      root.style.setProperty('--folia-glow', glowHex);
      root.style.setProperty('--folia-glow-rgb', rgb);
      // 调色盘/强度变了，即使鼓点没动也要把新的亮度写进去。
      lastGlowBeatStep = null;
    }
    if (beatStep !== lastGlowBeatStep) {
      lastGlowBeatStep = beatStep;
      root.style.setProperty('--folia-glow-level', level.toFixed(3));
    }
  }

  function hexRgb(value) {
    var hex = String(value || '').trim().replace(/^#/, '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (!/^[0-9a-f]{6}$/i.test(hex)) return '169, 212, 255';
    return parseInt(hex.slice(0, 2), 16) + ', ' + parseInt(hex.slice(2, 4), 16) + ', ' + parseInt(hex.slice(4, 6), 16);
  }

  function makeWordNode(unit, index, lineSeed, lineFontSize) {
    var rnd = function (n) { return hashUnit(lineSeed + index * 7.13 + n * 1.71); };
    var scale = 1.1 + rnd(1) * 0.2;
    var rotate = (rnd(2) - 0.5) * 10;
    var passedRotate = (rnd(3) - 0.5) * 45;
    var offsetX = (rnd(4) - 0.5) * 26;
    var offsetY = (rnd(5) - 0.5) * 26;
    var bobX = (rnd(6) - 0.5) * 5;
    var bobY = (rnd(7) - 0.5) * 9;
    var bobR = (rnd(8) - 0.5) * 2.2;
    var bobDur = 3.4 + rnd(9) * 2.6;
    var bobDelay = -rnd(10) * bobDur;
    var node = document.createElement('span');
    node.className = 'folia-classic-word is-waiting';
    node.style.setProperty('--bob-x', bobX.toFixed(1) + 'px');
    node.style.setProperty('--bob-y', bobY.toFixed(1) + 'px');
    node.style.setProperty('--bob-r', bobR.toFixed(2) + 'deg');
    node.style.setProperty('--bob-dur', bobDur.toFixed(2) + 's');
    node.style.setProperty('--bob-delay', bobDelay.toFixed(2) + 's');
    node.style.setProperty('--w-x', offsetX.toFixed(1) + 'px');
    node.style.setProperty('--w-y', offsetY.toFixed(1) + 'px');
    node.style.setProperty('--w-wait-x', (offsetX + Math.sin(offsetY) * 100).toFixed(1) + 'px');
    node.style.setProperty('--w-wait-y', (offsetY + Math.cos(offsetX) * 50).toFixed(1) + 'px');
    node.style.setProperty('--w-rot', rotate.toFixed(2) + 'deg');
    node.style.setProperty('--w-passed-rot', passedRotate.toFixed(2) + 'deg');
    node.style.setProperty('--w-scale', scale.toFixed(3));
    node.style.setProperty('--w-dur', Math.max(0.18, unit.end - unit.start).toFixed(2) + 's');
    node.style.setProperty('--w-drift-x', ((rnd(6) - 0.5) * 30).toFixed(1) + 'px');
    node.style.setProperty('--w-drift-y', ((rnd(7) - 0.5) * 18).toFixed(1) + 'px');

    var glow = document.createElement('span');
    glow.className = 'folia-classic-glow';
    glow.setAttribute('aria-hidden', 'true');
    glow.textContent = unit.text;
    var body = document.createElement('span');
    body.className = 'folia-classic-body';
    body.textContent = unit.text;
    node.dataset.text = unit.text;
    node.appendChild(glow);
    node.appendChild(body);
    return node;
  }

  // The outgoing line keeps its own DOM node. Cloning it restarted every bob /
  // glow / word-spring animation and duplicated the four-layer text shadows at
  // the exact moment of the switch, which is where the visible stutter came
  // from. Keeping the live node means the exit is a compositor-only fade, and
  // its camera translate / pose stay exactly where the viewer last saw them.
  function retireLineNode(node) {
    if (!node || !node.parentNode) return { rotate: '', transform: '', cam: null };
    // Never let two ghosts stack: in a rapid section the previous exit may
    // still be fading when the next line starts. It is already almost
    // transparent by then, so dropping it reads as a clean cut, while keeping
    // it would put two texts on screen at once.
    if (floatNode) {
      var staleGhosts = floatNode.querySelectorAll('.folia-classic-line.is-out');
      for (var sg = 0; sg < staleGhosts.length; sg += 1) {
        if (staleGhosts[sg].parentNode) staleGhosts[sg].parentNode.removeChild(staleGhosts[sg]);
      }
    }
    var rotate = '';
    var transform = '';
    var opacity = '1';
    var cam = null;
    try {
      var cs = window.getComputedStyle(node);
      rotate = String(cs.rotate || '');
      transform = String(cs.transform || '');
      opacity = String(cs.opacity || '1');
      var liveTranslate = String(cs.translate || '');
      if (liveTranslate && liveTranslate !== 'none') {
        var liveCam = parseFloat(liveTranslate);
        if (isFinite(liveCam)) {
          cam = liveCam;
          node.style.translate = liveTranslate;
        }
      }
    } catch (_) {
      rotate = '';
      transform = '';
      opacity = '1';
      cam = null;
    }
    if (rotate === 'none' || rotate === 'normal') rotate = '';
    if (transform === 'none') transform = node.__foliaPoseTransform || '';
    // Freeze the current camera rotate and the current (possibly still
    // animating) pose before `is-in` is removed, otherwise the old line snaps
    // back to its rest pose at the exact frame the new line fades in.
    if (rotate) node.style.rotate = rotate;
    if (transform) node.style.transform = transform;
    // Freeze the layout box as well. The ghost is absolutely positioned inside
    // the float, so if the incoming line is taller the float grows and the
    // ghost re-centres, visibly dropping during the fade. offsetTop/Height are
    // untransformed, unlike getBoundingClientRect.
    if (node.offsetHeight > 0) {
      node.style.top = node.offsetTop + 'px';
      node.style.height = node.offsetHeight + 'px';
      node.style.bottom = 'auto';
      node.style.margin = '0 auto';
    }
    // A line can be retired while its fade-in is still running (very short
    // lines, dictionary rebuild). Start the exit from the current opacity so
    // it never flashes to full before fading.
    node.style.setProperty('--folia-exit-opacity', opacity);
    // A line retired in a fast/instant section must not linger for the full
    // normal exit: at <0.18s per line several ghosts would overlap and read as
    // double text. Match the exit to the mode that produced the line.
    var exitDuration = node.__foliaRevealMode === 'instant' ? 0.1 : node.__foliaRevealMode === 'fast' ? 0.14 : 0.22;
    node.style.animationDuration = exitDuration.toFixed(2) + 's';
    node.classList.remove('is-in', 'is-instant');
    node.classList.add('is-out');
    node.setAttribute('aria-hidden', 'true');
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 280);
    return { rotate: rotate, transform: transform, cam: cam };
  }

  function renderLine(line, nextLine, lineIndex) {
    ensureRoot();
    var key = lineIndex + '|' + String(line && line.text || '');
    if (key === lastLineKey) return;

    wordTimes = buildWords(line, nextLine);
    renderedLine = line || null;
    renderedNextLine = nextLine || null;
    var lineStart = Math.max(0, Number(line && line.t) || 0);
    var lineEnd = lineSpanEnd(line, nextLine);
    var rawDuration = Math.max(0.001, lineEnd - lineStart);
    // Folia picks a reveal mode from the line duration: <0.10s micro (instant),
    // <0.18s short (fast), otherwise normal.  The mode changes both lookahead
    // and when an active word is allowed to pass, so copy that instead of
    // running a separate smoothstep timeline.
    var revealMode = rawDuration < 0.10 ? 'instant' : rawDuration < 0.18 ? 'fast' : 'normal';
    lineTiming = {
      renderEnd: lineEnd + (revealMode === 'instant' ? 0.067 : revealMode === 'fast' ? 0.04 : 0.24),
      revealMode: revealMode,
      lookahead: revealMode === 'instant' ? 0.03 : revealMode === 'fast' ? 0.08 : 0.15
    };

    // Hand the outgoing line over to the exit animation. We deliberately keep
    // the existing DOM node (see retireLineNode) and start the incoming line
    // from the old line's exact transform/camera so there is no jump at the
    // seams.
    var previous = lineNode;
    var previousCam = 0;
    if (previous) {
      previousCam = Number(previous.__foliaCamPx);
      if (!isFinite(previousCam)) previousCam = parseFloat(previous.style.translate) || 0;
    }
    var retired = previous ? retireLineNode(previous) : null;
    if (retired && retired.cam !== null) previousCam = retired.cam;
    var previousRotate = retired ? retired.rotate : '';
    var previousPose = retired ? retired.transform : '';

    var next = document.createElement('div');
    next.className = 'folia-classic-line';
    lineNode = next;
    wordNodes = [];
    translationNode.textContent = line && line.translation ? String(line.translation) : '';

    var width = window.innerWidth || 1280;
    var fontScale = 1;
    if (typeof fx !== 'undefined' && fx && isFinite(fx.lyricFontScale)) {
      fontScale = Math.max(0.6, Math.min(1.8, Number(fx.lyricFontScale)));
    }
    var fontSize = Math.max(36, Math.min(72, width * 0.06)) * fontScale;
    next.style.fontSize = fontSize.toFixed(2) + 'px';
    if (typeof lyricFontStackForKey === 'function') {
      next.style.fontFamily = lyricFontStackForKey(fx && fx.lyricFont);
    }
    next.style.letterSpacing = clampNumber(fx && fx.lyricLetterSpacing, 0, -4, 12).toFixed(2) + 'px';

    var seed = Math.max(0.01, Number(line && line.t) || 0.01);
    var pose = linePose(seed);
    next.style.transformOrigin = '50% 50%';
    next.style.transform =
      'rotate(' + (pose.rz + pose.ry * 0.22).toFixed(2) + 'deg)'
      + ' scale(' + pose.scale.toFixed(3) + ', ' + (pose.scale * pose.scaleX).toFixed(3) + ')';
    next.style.setProperty('--pose-drift', ((hashUnit(seed * 19.73 + 8.1) - 0.5) * 4.4).toFixed(2) + 'deg');
    var justifyOptions = ['center'];
    var alignOptions = ['center', 'flex-start', 'flex-end'];
    next.style.justifyContent = justifyOptions[Math.floor(seed * 10) % justifyOptions.length];
    next.style.alignItems = alignOptions[Math.floor(seed * 20) % alignOptions.length];

    for (var i = 0; i < wordTimes.length; i++) {
      var node = makeWordNode(wordTimes[i], i, seed * 1000 + i, fontSize);
      node.style.setProperty('--word-i', String(i));
      next.appendChild(node);
      wordNodes.push(node);
    }
    floatNode.appendChild(next);
    attachLineRings(seed);

    // Measure the final layout once, while the new line is still unanimated.
    // The old code measured getBoundingClientRect() while every word was in the
    // waiting pose (translated/rotated/scaled), so the camera target was the
    // position of the drift, not the word.
    var lineWidth = next.clientWidth || 1;
    var lineCenter = lineWidth / 2;
    for (var wi = 0; wi < wordNodes.length; wi += 1) {
      var wnode = wordNodes[wi];
      var activeX = parseFloat(wnode.style.getPropertyValue('--w-x')) || 0;
      wnode.__foliaCenter = wnode.offsetLeft + wnode.offsetWidth / 2 + activeX - lineCenter;
    }

    if (previousPose) next.style.setProperty('--pose-prev-transform', previousPose);
    if (previousRotate) next.style.setProperty('--pose-prev-rotate', previousRotate);
    next.__foliaCamPx = previousCam;
    next.__foliaRevealMode = revealMode;
    next.style.translate = previousCam.toFixed(1) + 'px 0px';
    next.__foliaPoseTransform = next.style.transform;

    // Flush the starting camera position before `is-in` starts the animations
    // or paintStates moves the camera, so the .55s translate transition has a
    // real starting value instead of teleporting by up to 36px.
    void next.offsetWidth;
    var enterDuration = revealMode === 'instant' ? 0 : revealMode === 'fast' ? 0.08 : 0.18;
    lineNode.style.animationDuration = enterDuration.toFixed(2) + 's, 7.5s, ' + enterDuration.toFixed(2) + 's';
    next.classList.toggle('is-instant', revealMode === 'instant');
    if (revealMode === 'instant' && previousRotate) next.style.rotate = previousRotate;
    next.classList.add('is-in');
    lastLineKey = key;
  }

  function clampNumber(value, fallback, min, max) {
    var n = Number(value);
    if (!isFinite(n)) n = fallback;
    return Math.max(min, Math.min(max, n));
  }

  // Pull the live DIY layout/animation settings into the overlay so the classic
  // style obeys the same position, size, angle and motion controls as the WebGL lyrics.
  function applyVisualSettings() {
    if (!root) return;
    var motion = (typeof fx !== 'undefined' && fx && fx.lyricMotionStyle) ? String(fx.lyricMotionStyle) : 'float';
    if (motion !== 'float' && motion !== 'smooth' && motion !== 'glass' && motion !== 'shine' && motion !== 'glitch') motion = 'float';

    var stageScale = clampNumber(fx && fx.lyricScale, 1, 0.35, 1.65);
    var offsetX = clampNumber(fx && fx.lyricOffsetX, 0, -4, 4) * 6;
    var offsetY = clampNumber(fx && fx.lyricOffsetY, 0, -2.4, 2.7) * 6;
    var tiltX = clampNumber(fx && fx.lyricTiltX, 0, -84, 84);
    var tiltY = clampNumber(fx && fx.lyricTiltY, 0, -84, 84);
    var softness = clampNumber(fx && fx.lyricMotionSoftness, 0.72, 0, 1);
    var letterSpacing = clampNumber(fx && fx.lyricLetterSpacing, 0, -4, 12);

    // These values only change when the user drags a DIY slider. Writing the
    // root transform (and the live line's letter-spacing) on every animation
    // frame forces a style/layout pass for nothing, which is part of the
    // general jank while the glow is animating.
    var key = [motion, stageScale.toFixed(3), offsetX.toFixed(2), offsetY.toFixed(2),
      tiltX.toFixed(2), tiltY.toFixed(2), softness.toFixed(3), letterSpacing.toFixed(2)].join('|');
    if (key === lastSettingsKey) return;
    lastSettingsKey = key;

    root.dataset.motion = motion;
    root.style.transform = 'translate3d(' + offsetX.toFixed(2) + 'vw, ' + offsetY.toFixed(2) + 'vh, 0)'
      + ' perspective(1200px) rotateX(' + tiltX.toFixed(2) + 'deg) rotateY(' + tiltY.toFixed(2) + 'deg)'
      + ' scale(' + stageScale.toFixed(3) + ')';
    root.style.setProperty('--folia-soft', (0.55 + softness * 1.1).toFixed(3));
    if (lineNode) lineNode.style.letterSpacing = letterSpacing.toFixed(2) + 'px';
  }

  // One word per line owns a small halo cluster: 1-2 rings total, instead of
  // 1-3 rings on every word that becomes active.  The rings are built once at
  // render time (hidden until their host word is active) so a word transition
  // no longer creates/removes DOM and restarts four-layer shadows.  This is the
  // main fix for the "every word pops circles" frequency and the switch jank.
  function attachLineRings(seed) {
    if (!wordNodes.length) return;
    var hostIndex = Math.floor(hashUnit(seed * 7.93 + 2.17) * wordNodes.length);
    var host = wordNodes[hostIndex];
    if (!host) return;
    var chars = Array.from(String(host.dataset.text || ''));
    if (!chars.length) return;
    // Two rings only when the host word has at least two glyphs; otherwise a
    // single ring.  Roughly half the lines get two, so the average stays in the
    // requested 1-2 per line.
    var wanted = chars.length > 1 && hashUnit(seed * 11.3 + 4.7) > 0.5 ? 2 : 1;
    var start = Math.floor(hashUnit(seed * 3.17 + 9.41) * chars.length);
    var indices = [start];
    if (wanted === 2) {
      var second = (start + 1 + Math.floor(hashUnit(seed * 5.71 + 1.33) * (chars.length - 1))) % chars.length;
      indices.push(second);
      indices.sort(function (a, b) { return a - b; });
    }
    var layer = document.createElement('span');
    layer.className = 'folia-word-rings';
    for (var j = 0; j < indices.length; j += 1) {
      var idx = indices[j];
      var ring = document.createElement('span');
      ring.className = 'folia-word-ring';
      ring.style.setProperty('--ring-x', ((((idx + 0.5) / chars.length) * 100).toFixed(2)) + '%');
      ring.style.setProperty('--ring-y', '50%');
      var size = 1.45 + (indices.length > 1 ? (j / (indices.length - 1)) : 0) * 0.15;
      ring.style.setProperty('--ring-s', size.toFixed(2) + 'em');
      ring.style.setProperty('--ring-d', (j * 0.18).toFixed(2) + 's');
      layer.appendChild(ring);
    }
    host.appendChild(layer);
  }

  function paintStates(now) {
    // Folia's word state is decided by the word's own start/end and the line's
    // reveal profile: active starts lookahead seconds early; passed happens at
    // its active end (line-render end for micro/fast lines).
    var cameraTarget = 0;
    var activeIndex = -1;
    for (var i = 0; i < wordNodes.length; i++) {
      var node = wordNodes[i];
      var t = wordTimes[i];
      if (!node || !t) continue;
      var activeEnd = t.end;
      if (lineTiming.revealMode === 'instant') activeEnd = lineTiming.renderEnd;
      else if (lineTiming.revealMode === 'fast') activeEnd = Math.min(lineTiming.renderEnd, Math.max(t.end, t.start + 0.12));
      var state;
      if (now < t.start - lineTiming.lookahead) state = 'waiting';
      else if (now > activeEnd) state = 'passed';
      else state = 'active';
      if (state === 'active') activeIndex = i;
      if (node.__foliaState !== state) {
        node.__foliaState = state;
        node.classList.remove('is-waiting', 'is-active', 'is-passed');
        node.classList.add('is-' + state);
      }
    }
    if (lineNode) {
      if (activeIndex >= 0) {
        var activeNode = wordNodes[activeIndex];
        if (activeNode && typeof activeNode.__foliaCenter === 'number') {
          cameraTarget = Math.max(-36, Math.min(36, -(activeNode.__foliaCenter) * 0.08));
        }
      }
      var camPx = Math.round(cameraTarget * 10) / 10;
      if (lineNode.__foliaCamPx === undefined || Math.abs(lineNode.__foliaCamPx - camPx) >= 0.6) {
        lineNode.__foliaCamPx = camPx;
        lineNode.style.translate = camPx + 'px 0px';
      }
    }
  }
  function hideStageWebglLyrics(hidden) {
    var group = typeof stageLyrics !== 'undefined' && stageLyrics && stageLyrics.group;
    if (!group) return;
    if (hidden) {
      if (group.visible) {
        group.visible = false;
        groupWasHiddenByUs = true;
      }
    } else if (groupWasHiddenByUs) {
      group.visible = true;
      groupWasHiddenByUs = false;
    }
  }

  function clearOverlay() {
    if (!root) return;
    if (lineNode) {
      // Keep the float's height while the last line fades: making it absolute
      // with no in-flow sibling collapses the float and the ghost would visibly
      // drop by half its height.
      var keepHeight = lineNode.offsetHeight;
      if (floatNode && keepHeight > 0) {
        // border-box: min-height includes the float's vertical padding, so add
        // it back or the collapsed float is 4rem shorter and the ghost drops.
        var floatStyle = window.getComputedStyle(floatNode);
        var padY = (parseFloat(floatStyle.paddingTop) || 0) + (parseFloat(floatStyle.paddingBottom) || 0);
        floatNode.style.minHeight = (keepHeight + padY) + 'px';
        window.setTimeout(function () {
          if (floatNode) floatNode.style.minHeight = '';
        }, 300);
      }
      retireLineNode(lineNode);
      lineNode = null;
    }
    if (translationNode) translationNode.textContent = '';
    wordNodes = [];
    wordTimes = [];
    lastLineKey = '';
    root.classList.remove('show');
  }

  // QA/debug hook: the resolved per-word windows for the line on screen.
  window.__mineradioFoliaWords = function () {
    return wordTimes.map(function (t) { return { start: t.start, end: t.end }; });
  };

  function tick() {
    try {
      var active = foliaLyricsUsable();
      if (!active) {
        hideStageWebglLyrics(false);
        clearOverlay();
        return;
      }
      hideStageWebglLyrics(true);
      // 切歌瞬间封面纹理、边缘深度图和新的歌词会同时进来；叠层这时继续画
      // 只会把 GPU 峰值推高。等这一小段过去再恢复，视觉上只是一次淡出。
      var trackToken = (typeof trackSwitchToken !== 'undefined') ? trackSwitchToken : 0;
      if (trackToken !== lastTrackToken) {
        lastTrackToken = trackToken;
        trackSwitchQuietUntil = performance.now() + 600;
        clearOverlay();
        return;
      }
      if (performance.now() < trackSwitchQuietUntil) return;
      ensureRoot();
      syncPalette();
      applyVisualSettings();
      var now = lyricNowSeconds();
      var lines = lyricsLines;
      var lineIndex = typeof stageLyricIndexForSeconds === 'function' ? stageLyricIndexForSeconds(now) : -1;
      if (!isFinite(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
        clearOverlay();
        return;
      }
      var line = lines[lineIndex];
      if (!line || !line.text) {
        clearOverlay();
        return;
      }
      renderLine(line, lines[lineIndex + 1], lineIndex);
      paintStates(now);
      root.classList.add('show');
    } catch (err) {
      // A broken lyric payload must never take down the render loop.
      window.__foliaLastError = String(err && err.stack || err);
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    tick();
  }

  // When the dictionary finishes loading, force the current line to rebuild
  // with the better word split instead of waiting for the next lyric line.
  if (window.cjkWordSegmenter && window.cjkWordSegmenter.onReady) {
    window.cjkWordSegmenter.onReady(function () {
      if (fx && fx.lyricStyle === 'classic') lastLineKey = '';
    });
  }

  // QA hook: hidden Electron windows throttle requestAnimationFrame, so tests
  // can advance one frame synchronously after changing style or playback time.
  window.__mineradioFoliaTick = tick;
  if (window.__MINERADIO_TEST__) window.__mineradioFoliaBuildWords = buildWords;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(frame); }, { once: true });
  } else {
    requestAnimationFrame(frame);
  }
})();
