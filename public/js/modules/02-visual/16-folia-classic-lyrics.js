// Folia-classic lyric style, implemented independently for Mineradio.
// Clean-room: no Folia code, shaders, fonts or assets were copied; only the
// visual behaviour (one centred line, sung character blooms, past characters
// keep an afterglow, upcoming characters wait blurred) was reproduced.
//
// The regular stage lyrics are WebGL meshes. While this style is selected we
// simply hide `stageLyrics.group` and draw the line as DOM text above the
// canvas, which keeps the text crisp and cheap on low-end machines.
(function () {
  'use strict';

  var STYLE_ID = 'classic';
  var ROOT_ID = 'folia-classic-lyrics';
  var root = null;
  var wrap = null;
  var lineNode = null;
  var charNodes = [];
  var charTimes = [];
  var lastLineKey = '';
  var lastFitWidth = 0;
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
    wrap = document.createElement('div');
    wrap.className = 'folia-classic-wrap';
    lineNode = document.createElement('div');
    lineNode.className = 'folia-classic-line';
    wrap.appendChild(lineNode);
    root.appendChild(wrap);
    charNodes = [];
    charTimes = [];
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

  function splitChars(text) {
    var raw = String(text || '').replace(/\s+/g, ' ').trim();
    var chars = [];
    for (var i = 0; i < raw.length; i++) chars.push(raw.charAt(i));
    return chars;
  }

  // Returns [{ ch, start, end }] in playback seconds. Native karaoke lines
  // already carry word-level timestamps; line-only lyrics get an even spread
  // across the line's own duration, which is what Folia's fallback does too.
  function buildCharTimes(line, nextLine) {
    var chars = splitChars(line && line.text);
    var times = [];
    var i;
    for (i = 0; i < chars.length; i++) times.push({ ch: chars[i], start: 0, end: 0, space: chars[i] === ' ' });
    if (!chars.length) return times;

    var lineStart = Math.max(0, Number(line.t) || 0);
    var lineEnd = lineStart + Math.max(0.45, Number(line.duration) || 3.2);
    if (nextLine && Number(nextLine.t) > lineStart + 0.05) {
      lineEnd = Math.min(lineEnd + 0.8, Number(nextLine.t));
    }

    var words = Array.isArray(line.words) ? line.words : null;
    var covered = {};
    if (words && words.length) {
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        var span = Math.max(0.08, Number(word.d) || 0.24);
        var start = Math.max(0, Number(word.t) || lineStart);
        var c0 = Math.max(0, Math.min(chars.length, Number(word.c0) || 0));
        var c1 = Math.max(c0, Math.min(chars.length, Number(word.c1) || c0));
        var count = Math.max(1, c1 - c0);
        for (var c = c0; c < c1; c++) {
          var local = (c - c0) / count;
          times[c].start = start + span * local;
          times[c].end = start + span * Math.min(1, local + 1 / count);
          covered[c] = true;
        }
      }
    }

    var open = [];
    for (i = 0; i < chars.length; i++) if (!covered[i]) open.push(i);
    if (open.length) {
      var spanAll = Math.max(0.6, lineEnd - lineStart);
      for (var o = 0; o < open.length; o++) {
        var idx = open[o];
        // Avoid overlapping the surrounding karaoke words: place the gap
        // characters in the free window between line start and line end.
        times[idx].start = lineStart + spanAll * (o / Math.max(1, open.length));
        times[idx].end = lineStart + spanAll * ((o + 1) / Math.max(1, open.length));
      }
    }
    return times;
  }

  function renderLine(line, nextLine, lineIndex) {
    ensureRoot();
    var key = lineIndex + '|' + String(line && line.text || '');
    if (key === lastLineKey) return;
    lastLineKey = key;
    if (typeof lyricFontStackForKey === 'function') {
      lineNode.style.fontFamily = lyricFontStackForKey(fx && fx.lyricFont);
    }

    charTimes = buildCharTimes(line, nextLine);
    lineNode.innerHTML = '';
    charNodes = [];
    for (var i = 0; i < charTimes.length; i++) {
      var t = charTimes[i];
      var span = document.createElement('span');
      if (t.space) {
        span.className = 'folia-classic-ch is-space';
        span.textContent = '\u00a0';
      } else {
        span.className = 'folia-classic-ch';
        span.textContent = t.ch;
        span.style.setProperty('--folia-rot', (((i * 37) % 13) - 6) + 'deg');
      }
      lineNode.appendChild(span);
      charNodes.push(span);
    }
    lineNode.classList.remove('is-in');
    // Force a reflow so the entrance animation restarts for every new line.
    void lineNode.offsetWidth;
    lineNode.classList.add('is-in');
    fitLine();
  }

  function fitLine() {
    if (!lineNode || !wrap) return;
    var width = wrap.clientWidth || 0;
    if (!width) return;
    lineNode.style.fontSize = '';
    var natural = lineNode.scrollWidth;
    if (natural > width) {
      var current = parseFloat(getComputedStyle(lineNode).fontSize) || 96;
      var next = Math.max(42, Math.floor(current * width / natural));
      lineNode.style.fontSize = next + 'px';
    }
    lastFitWidth = width;
  }

  function computeState(now, t) {
    if (now < t.start) return 'waiting';
    if (now >= t.end) return 'passed';
    return 'active';
  }

  function paintStates(now) {
    for (var i = 0; i < charNodes.length; i++) {
      var node = charNodes[i];
      if (!node || node.classList.contains('is-space')) continue;
      var state = computeState(now, charTimes[i]);
      if (node.__foliaState !== state) {
        node.__foliaState = state;
        node.classList.remove('is-waiting', 'is-active', 'is-passed');
        node.classList.add('is-' + state);
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
    if (lineNode) lineNode.innerHTML = '';
    charNodes = [];
    charTimes = [];
    lastLineKey = '';
    root.classList.remove('show');
  }

  function frame() {
    requestAnimationFrame(frame);
    try {
      var active = foliaLyricsUsable();
      if (!active) {
        hideStageWebglLyrics(false);
        clearOverlay();
        return;
      }
      hideStageWebglLyrics(true);
      ensureRoot();
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
      if (wrap && wrap.clientWidth !== lastFitWidth) fitLine();
    } catch (err) {
      // A broken lyric payload must never take down the render loop.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(frame); }, { once: true });
  } else {
    requestAnimationFrame(frame);
  }
})();
