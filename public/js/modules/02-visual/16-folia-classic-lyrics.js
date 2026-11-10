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
    lineNode = document.createElement('div');
    lineNode.className = 'folia-classic-line';
    floatNode.appendChild(lineNode);
    translationNode = document.createElement('div');
    translationNode.className = 'folia-classic-translation';
    root.appendChild(floatNode);
    root.appendChild(translationNode);
    wordNodes = [];
    wordTimes = [];
    lastLineKey = '';
  }

  function lyricNowSeconds() {
    var seconds = typeof audio !== 'undefined' && audio && isFinite(audio.currentTime) ? audio.currentTime : 0;
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

  // 每一行像被一台随机角度的摄影机拍到：整行绕中心做轻微旋转/横向压缩，并从
  // 不同方向进入；但词仍然按句子顺序留在同一行里，不单个乱蹦。
  function linePose(seed) {
    var s = Math.max(0.01, Number(seed) || 0.01);
    var rx = (hashUnit(s * 3.13 + 0.7) - 0.5) * 28;
    var ry = (hashUnit(s * 5.71 + 1.3) - 0.5) * 44;
    var rz = (hashUnit(s * 7.37 + 2.1) - 0.5) * 20;
    var scale = 0.88 + hashUnit(s * 9.19 + 3.7) * 0.16;
    var scaleX = 0.92 + hashUnit(s * 17.41 + 7.3) * 0.16;
    var fromX = (hashUnit(s * 11.31 + 4.9) - 0.5) * 240;
    var fromY = (hashUnit(s * 13.73 + 5.3) - 0.5) * 190;
    var fromR = (hashUnit(s * 15.17 + 6.1) - 0.5) * 9;
    return {
      rx: rx, ry: ry, rz: rz, scale: scale, scaleX: scaleX,
      fromX: fromX, fromY: fromY, fromR: fromR
    };
  }

  // Folia 对 LRC 行的收尾不是直接用下一行时间：如果中间隔了很久，会把这一行
  // 按阅读时长截断，剩下的空档交给间奏。否则长间奏会把整行歌词拖成慢动作。
  function lineSpanEnd(line, nextLine) {
    var start = Math.max(0, Number(line && line.t) || 0);
    var nextT = nextLine && Number(nextLine.t) > start ? Number(nextLine.t) : 0;
    var duration = nextT
      ? nextT - start
      : Math.max(0.6, Number(line && line.duration) || 5);
    var hasWords = Array.isArray(line && line.words) && line.words.length > 0;
    var reading = String(line && line.text || '').length * 0.5;
    // The reading-time clamp only applies to line-synced lyrics.  Word-timed
    // (YRC) lines already carry real word windows and must not be shortened.
    if (!hasWords && nextT && duration > reading + 2 && duration > 5) {
      duration = Math.min(duration, reading + 2);
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
  // 先走 Intl.Segmenter 的词级分词（和 Folia 的默认分词同一层），再把其中连续的
  // 单字按「两字一词」合并、把「的/了/在」这类虚词并回前一个词；只有运行时连
  // Segmenter 都没有时才退回逐字。
  // Word-level fallback: Intl.Segmenter first, then pair adjacent single Han
  // characters and glue function words to the previous unit.
  var CJK_SINGLE = /^[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]$/;
  var WORD_STOP = '的了着过们吗呢吧啊呀哦嗯在是不没就都也又还很太最更我你他她它这那哪谁什么怎和与或而但却把被给让对从向为以于之其个些点上下中里外来到会能要想说看听有无一二三四五六七八九十啦嘛喔诶唉嘿哈';
  function isWordStop(token) {
    return token.length === 1 && WORD_STOP.indexOf(token) >= 0;
  }
  function segmentFallbackWords(text) {
    // Prefer the dictionary segmenter once it is ready; it knows names and
    // compounds that Intl.Segmenter tends to break apart.  Keep Intl as the
    // immediate fallback while the dictionary loads in the background.
    if (window.cjkWordSegmenter) {
      if (window.cjkWordSegmenter.isReady()) {
        var dictWords = window.cjkWordSegmenter.segment(text);
        if (dictWords && dictWords.length) return dictWords;
      } else {
        window.cjkWordSegmenter.ensureLoaded();
      }
    }
    var parts = [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        var seg = new Intl.Segmenter(undefined, { granularity: 'word' });
        Array.from(seg.segment(text)).forEach(function (part) {
          if (part.segment) parts.push(part.segment);
        });
      } catch (e) { parts = []; }
    }
    if (!parts.length) {
      var re = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]|[A-Za-z0-9][A-Za-z0-9''’\-]*|[^\s]/g;
      var match;
      while ((match = re.exec(text))) parts.push(match[0]);
    }
    var units = [];
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i];
      if (!t) continue;
      if (/^\s+$/.test(t)) { if (units.length) units[units.length - 1] += ' '; continue; }
      if (/^[\p{P}\p{S}]+$/u.test(t)) { if (units.length) units[units.length - 1] += t; else units.push(t); continue; }
      var prev = units.length ? units[units.length - 1] : '';
      if (prev && CJK_SINGLE.test(t) && isWordStop(t) && CJK_SINGLE.test(prev.charAt(prev.length - 1))) {
        units[units.length - 1] += t;
        continue;
      }
      if (CJK_SINGLE.test(t) && i + 1 < parts.length && CJK_SINGLE.test(parts[i + 1]) && !isWordStop(t) && !isWordStop(parts[i + 1])) {
        units.push(t + parts[++i]);
        continue;
      }
      units.push(t);
    }
    return units.map(function (u) { return u.trim(); }).filter(Boolean);
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
      if (!firstAt[sub2.w]) firstAt[sub2.w] = sub2.start;
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
    var level = glowOn ? Math.max(0, Math.min(1.3, strength / 0.28)) * (1 + beat * 0.35) : 0;
    var rgb = hexRgb(glowHex);
    var key = [pal.primary, pal.highlight, pal.secondary, glowHex, glowOn, linked, strength.toFixed(2), (Math.round(beat * 20) / 20).toFixed(2)].join('|');
    if (key === lastPaletteKey) return;
    lastPaletteKey = key;
    root.style.setProperty('--folia-ink', pal.primary || '#eaf3ff');
    root.style.setProperty('--folia-hi', pal.highlight || '#ffffff');
    root.style.setProperty('--folia-glow', glowHex);
    root.style.setProperty('--folia-glow-rgb', rgb);
    root.style.setProperty('--folia-glow-level', level.toFixed(3));
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

  // Keep the previous line around long enough to fade out; the new line starts
  // immediately so playback never waits on an exit animation.
  function retireLineNode() {
    if (!lineNode || !lineNode.childElementCount || !floatNode) return;
    var ghosts = floatNode.querySelectorAll('.folia-classic-line.is-out');
    for (var g = 0; g < ghosts.length; g++) ghosts[g].parentNode.removeChild(ghosts[g]);
    var ghost = lineNode.cloneNode(true);
    ghost.classList.remove('is-in', 'is-instant');
    ghost.classList.add('is-out');
    ghost.setAttribute('aria-hidden', 'true');
    floatNode.appendChild(ghost);
    window.setTimeout(function () {
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }, 280);
  }

  function renderLine(line, nextLine, lineIndex) {
    ensureRoot();
    var key = lineIndex + '|' + String(line && line.text || '');
    if (key === lastLineKey) return;
    lastLineKey = key;

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
    retireLineNode();
    lineNode.innerHTML = '';
    wordNodes = [];
    translationNode.textContent = line && line.translation ? String(line.translation) : '';

    var width = window.innerWidth || 1280;
    var fontScale = 1;
    if (typeof fx !== 'undefined' && fx && isFinite(fx.lyricFontScale)) {
      fontScale = Math.max(0.6, Math.min(1.8, Number(fx.lyricFontScale)));
    }
    var fontSize = Math.max(36, Math.min(72, width * 0.06)) * fontScale;
    lineNode.style.fontSize = fontSize.toFixed(2) + 'px';
    if (typeof lyricFontStackForKey === 'function') {
      lineNode.style.fontFamily = lyricFontStackForKey(fx && fx.lyricFont);
    }

    var seed = Math.max(0.01, Number(line && line.t) || 0.01);
    var pose = linePose(seed);
    lineNode.style.transformOrigin = '50% 50%';
    lineNode.style.transform =
      'rotate(' + (pose.rz + pose.ry * 0.22).toFixed(2) + 'deg)'
      + ' scale(' + pose.scale.toFixed(3) + ', ' + (pose.scale * pose.scaleX).toFixed(3) + ')';
    lineNode.style.setProperty('--pose-rx', pose.rx.toFixed(2) + 'deg');
    lineNode.style.setProperty('--pose-ry', pose.ry.toFixed(2) + 'deg');
    lineNode.style.setProperty('--pose-rz', pose.rz.toFixed(2) + 'deg');
    lineNode.style.setProperty('--pose-from-x', pose.fromX.toFixed(1) + 'px');
    lineNode.style.setProperty('--pose-from-y', pose.fromY.toFixed(1) + 'px');
    lineNode.style.setProperty('--pose-from-r', pose.fromR.toFixed(2) + 'deg');
    lineNode.style.setProperty('--pose-drift', ((hashUnit(seed * 19.73 + 8.1) - 0.5) * 4.4).toFixed(2) + 'deg');
    var justifyOptions = ['center'];
    var alignOptions = ['center', 'flex-start', 'flex-end'];
    lineNode.style.justifyContent = justifyOptions[Math.floor(seed * 10) % justifyOptions.length];
    lineNode.style.alignItems = alignOptions[Math.floor(seed * 20) % alignOptions.length];

    for (var i = 0; i < wordTimes.length; i++) {
      var node = makeWordNode(wordTimes[i], i, seed * 1000 + i, fontSize);
      node.style.setProperty('--word-i', String(i));
      lineNode.appendChild(node);
      wordNodes.push(node);
    }
    lineNode.classList.remove('is-in');
    void lineNode.offsetWidth;
    var enterDuration = revealMode === 'instant' ? 0 : revealMode === 'fast' ? 0.08 : 0.18;
    lineNode.style.animationDuration = enterDuration.toFixed(2) + 's, 7.5s';
    lineNode.classList.toggle('is-instant', revealMode === 'instant');
    lineNode.classList.add('is-in');
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
    root.dataset.motion = motion;

    var stageScale = clampNumber(fx && fx.lyricScale, 1, 0.35, 1.65);
    var offsetX = clampNumber(fx && fx.lyricOffsetX, 0, -4, 4) * 6;
    var offsetY = clampNumber(fx && fx.lyricOffsetY, 0, -2.4, 2.7) * 6;
    var tiltX = clampNumber(fx && fx.lyricTiltX, 0, -84, 84);
    var tiltY = clampNumber(fx && fx.lyricTiltY, 0, -84, 84);
    var softness = clampNumber(fx && fx.lyricMotionSoftness, 0.72, 0, 1);
    root.style.transform = 'translate3d(' + offsetX.toFixed(2) + 'vw, ' + offsetY.toFixed(2) + 'vh, 0)'
      + ' perspective(1200px) rotateX(' + tiltX.toFixed(2) + 'deg) rotateY(' + tiltY.toFixed(2) + 'deg)'
      + ' scale(' + stageScale.toFixed(3) + ')';
    root.style.setProperty('--folia-soft', (0.55 + softness * 1.1).toFixed(3));
    if (lineNode) {
      lineNode.style.letterSpacing = clampNumber(fx && fx.lyricLetterSpacing, 0, -4, 12).toFixed(2) + 'px';
    }
  }

  // Draw two or three soft halos inside the active word.  They sit on the
  // character centres (left to right), shrink on the left and grow on the
  // right, and breathe with a small delay so the light appears to travel
  // along the word rather than sitting on one glyph.
  function syncWordRings(node, state) {
    var layer = node.querySelector('.folia-word-rings');
    if (state !== 'active') {
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      return;
    }
    var body = node.querySelector('.folia-classic-body');
    var text = String((body && body.textContent) || '').replace(/s+/g, '');
    var count = Math.min(3, Math.max(3, text.length));
    if (layer && Number(layer.dataset.count) === count) return;
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = document.createElement('span');
    layer.className = 'folia-word-rings';
    layer.dataset.count = String(count);
    // Random centres: sometimes on a glyph, sometimes drifting off it, but
    // always sorted left to right so the halos still grow in that direction.
    var spots = [];
    for (var j = 0; j < count; j += 1) {
      var pad = count === 2 ? 18 : 16;
      var baseX = pad + (j * (100 - pad * 2)) / Math.max(1, count - 1);
      var drift = (count === 2 ? 8 : 6) * (Math.random() - 0.5);
      var x = Math.max(10, Math.min(90, baseX + drift));
      var y = (j % 2 === 0) ? 74 + Math.random() * 12 : 14 + Math.random() * 12;
      spots.push({ x: x, y: y });
    }
    spots.sort(function (a, b) { return a.x - b.x; });
    for (var i = 0; i < count; i += 1) {
      var ring = document.createElement('span');
      ring.className = 'folia-word-ring';
      ring.style.setProperty('--ring-x', spots[i].x.toFixed(2) + '%');
      ring.style.setProperty('--ring-y', spots[i].y.toFixed(2) + '%');
      var size = 0.8 + (count > 1 ? (i / (count - 1)) : 0) * 0.75;
      ring.style.setProperty('--ring-s', size.toFixed(2) + 'em');
      ring.style.setProperty('--ring-d', (i * 0.2).toFixed(2) + 's');
      layer.appendChild(ring);
    }
    node.appendChild(layer);
  }

  function paintStates(now) {
    // Folia's word state is decided by the word's own start/end and the line's
    // reveal profile: active starts lookahead seconds early; passed happens at
    // its active end (line-render end for micro/fast lines).
    var cameraTarget = 0;
    var hasActive = false;
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
      if (state === 'active') hasActive = true;
      if (node.__foliaState !== state) {
        node.__foliaState = state;
        node.classList.remove('is-waiting', 'is-active', 'is-passed');
        node.classList.add('is-' + state);
        syncWordRings(node, state);
        if (state === 'active') {
          var glow = node.querySelector('.folia-classic-glow');
          if (glow) {
            glow.style.animation = 'none';
            void glow.offsetWidth;
            glow.style.animation = '';
          }
        }
      }
    }
    if (lineNode) {
      if (hasActive) {
        var lineRect = lineNode.getBoundingClientRect();
        var activeRect = null;
        for (var a = 0; a < wordNodes.length; a++) {
          if (wordNodes[a] && wordNodes[a].classList.contains('is-active')) {
            activeRect = wordNodes[a].getBoundingClientRect();
            break;
          }
        }
        if (activeRect && lineRect.width > 0) {
          var wordCenter = (activeRect.left + activeRect.right) / 2;
          var lineCenter = (lineRect.left + lineRect.right) / 2;
          cameraTarget = Math.max(-36, Math.min(36, -(wordCenter - lineCenter) * 0.08));
        }
      }
      var camPx = Math.round(cameraTarget * 10) / 10;
      if (lineNode.__foliaCamPx !== camPx) {
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
    if (floatNode) {
      var ghosts = floatNode.querySelectorAll('.folia-classic-line.is-out');
      for (var g = 0; g < ghosts.length; g++) ghosts[g].parentNode.removeChild(ghosts[g]);
    }
    if (lineNode) lineNode.innerHTML = '';
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
