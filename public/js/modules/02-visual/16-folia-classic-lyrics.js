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
  var LOOKAHEAD = 0.12;
  var root = null;
  var floatNode = null;
  var lineNode = null;
  var translationNode = null;
  var wordNodes = [];
  var wordTimes = [];
  var lastLineKey = '';
  var lastPaletteKey = '';
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

  function buildWords(line) {
    var lineStart = Math.max(0, Number(line && line.t) || 0);
    var lineEnd = lineStart + Math.max(0.6, Number(line && line.duration) || 3.2);
    var words = Array.isArray(line && line.words) ? line.words : null;
    var units = [];
    var i;
    if (words && words.length) {
      for (i = 0; i < words.length; i++) {
        var w = words[i];
        var text = String(w && w.text || '').trim();
        if (!text) continue;
        var start = Math.max(lineStart, Number(w.t) || lineStart);
        var duration = Math.max(0.12, Number(w.d) || Math.max(0.2, (lineEnd - lineStart) / words.length));
        units.push({ text: text, start: start, end: start + duration });
      }
      if (units.length) return units;
    }
    var raw = String(line && line.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return units;
    var tokens = raw.split(' ');
    var span = Math.max(0.6, lineEnd - lineStart) / Math.max(1, tokens.length);
    for (i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!token) continue;
      var tokStart = lineStart + span * i;
      units.push({ text: token, start: tokStart, end: tokStart + span });
    }
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
    var key = [pal.primary, pal.highlight, pal.secondary, pal.glowColor, pal.glow].join('|');
    if (key === lastPaletteKey) return;
    lastPaletteKey = key;
    root.style.setProperty('--folia-ink', pal.primary || '#eaf3ff');
    root.style.setProperty('--folia-hi', pal.highlight || '#ffffff');
    root.style.setProperty('--folia-glow', pal.glowColor || pal.secondary || '#a9d4ff');
  }

  function makeWordNode(unit, index, lineSeed, lineFontSize) {
    var rnd = function (n) { return hashUnit(lineSeed + index * 7.13 + n * 1.71); };
    var scale = 1.1 + rnd(1) * 0.2;
    var rotate = (rnd(2) - 0.5) * 10;
    var passedRotate = (rnd(3) - 0.5) * 45;
    var offsetX = (rnd(4) - 0.5) * 26;
    var offsetY = (rnd(5) - 0.5) * 26;
    var node = document.createElement('span');
    node.className = 'folia-classic-word is-waiting';
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
    node.appendChild(glow);
    node.appendChild(body);
    return node;
  }

  function renderLine(line, nextLine, lineIndex) {
    ensureRoot();
    var key = lineIndex + '|' + String(line && line.text || '');
    if (key === lastLineKey) return;
    lastLineKey = key;

    wordTimes = buildWords(line);
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
    var justifyOptions = ['center'];
    var alignOptions = ['center', 'flex-start', 'flex-end'];
    lineNode.style.justifyContent = justifyOptions[Math.floor(seed * 10) % justifyOptions.length];
    lineNode.style.alignItems = alignOptions[Math.floor(seed * 20) % alignOptions.length];

    for (var i = 0; i < wordTimes.length; i++) {
      var node = makeWordNode(wordTimes[i], i, seed * 1000 + i, fontSize);
      lineNode.appendChild(node);
      wordNodes.push(node);
    }
    lineNode.classList.remove('is-in');
    void lineNode.offsetWidth;
    lineNode.classList.add('is-in');
  }

  function paintStates(now) {
    for (var i = 0; i < wordNodes.length; i++) {
      var node = wordNodes[i];
      var t = wordTimes[i];
      if (!node || !t) continue;
      var state;
      if (now < t.start - LOOKAHEAD) state = 'waiting';
      else if (now > t.end) state = 'passed';
      else state = 'active';
      if (node.__foliaState !== state) {
        node.__foliaState = state;
        node.classList.remove('is-waiting', 'is-active', 'is-passed');
        node.classList.add('is-' + state);
        // Restart the per-word halo ramp whenever a word turns active.
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
    if (translationNode) translationNode.textContent = '';
    wordNodes = [];
    wordTimes = [];
    lastLineKey = '';
    root.classList.remove('show');
  }

  function tick() {
    try {
      var active = foliaLyricsUsable();
      if (!active) {
        hideStageWebglLyrics(false);
        clearOverlay();
        return;
      }
      hideStageWebglLyrics(true);
      ensureRoot();
      syncPalette();
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

  // QA hook: hidden Electron windows throttle requestAnimationFrame, so tests
  // can advance one frame synchronously after changing style or playback time.
  window.__mineradioFoliaTick = tick;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(frame); }, { once: true });
  } else {
    requestAnimationFrame(frame);
  }
})();
