/* Mineradio - dictionary based CJK word segmenter.
 *
 * The full-screen lyric styles look best when a line is split into words
 * instead of single characters.  The browser's Intl.Segmenter is a decent
 * fallback, but it tends to split names and compounds.  This module loads a
 * trimmed jieba dictionary (MIT, see NOTICE.md) lazily and segments with the
 * classic DAG + maximum-probability path algorithm.
 *
 * The dictionary is served from public/vendor/jieba-dict.txt.  Parsing happens
 * in small idle slices so enabling the lyric style never blocks the main loop;
 * when the page is hidden (QA windows) the browser clamps timers, so the parse
 * runs synchronously in that case.
 */
(function (global) {
  'use strict';

  var DICT_URL = 'vendor/jieba-dict.txt.gz';
  var DICT_PLAIN_URL = 'vendor/jieba-dict.txt';
  var HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  var HAN_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;

  var state = {
    ready: false,
    loading: false,
    failed: false,
    words: null,
    total: 0,
    maxLen: 1,
    callbacks: []
  };

  function isHanChar(ch) {
    return !!ch && HAN_RE.test(ch);
  }

  function notifyReady() {
    var callbacks = state.callbacks;
    state.callbacks = [];
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](); } catch (err) { /* a listener must not break the loader */ }
    }
  }

  function addDictionaryLine(line) {
    var space = line.indexOf(' ');
    if (space <= 0) return;
    var word = line.slice(0, space);
    if (!word) return;
    var freq = parseInt(line.slice(space + 1), 10) || 0;
    if (freq <= 0) return;
    state.words.set(word, freq);
    state.total += freq;
    var length = Array.from(word).length;
    if (length > state.maxLen) state.maxLen = Math.min(length, 16);
  }

  function finishLoading() {
    if (!state.words || !state.total) {
      state.loading = false;
      state.failed = true;
      console.warn('[CJK] dictionary was empty; falling back to Intl.Segmenter');
      return;
    }
    state.ready = true;
    state.loading = false;
    notifyReady();
  }

  function parseLines(lines) {
    state.words = new Map();
    var index = 0;

    // A visible window can afford to breathe between slices.  Hidden windows
    // throttle timers to ~1s, which would stretch this into a minute, so there
    // we parse in one go (the QA window is short-lived and invisible anyway).
    var hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden) {
      while (index < lines.length) addDictionaryLine(lines[index++]);
      finishLoading();
      return;
    }

    function slice() {
      var started = Date.now();
      while (index < lines.length && Date.now() - started < 8) addDictionaryLine(lines[index++]);
      if (index < lines.length) {
        if (global.requestIdleCallback) global.requestIdleCallback(slice, { timeout: 350 });
        else setTimeout(slice, 12);
      } else {
        finishLoading();
      }
    }
    if (global.requestIdleCallback) global.requestIdleCallback(slice, { timeout: 350 });
    else setTimeout(slice, 0);
  }

  function ensureLoaded() {
    if (state.ready || state.loading || state.failed) return;
    state.loading = true;
    var request;
    if (typeof DecompressionStream === 'function') {
      request = fetch(DICT_URL, { cache: 'force-cache' }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var stream = response.body.pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
      });
    } else {
      request = fetch(DICT_PLAIN_URL, { cache: 'force-cache' }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      });
    }
    request
      .then(function (text) {
        parseLines(text.split(/\r?\n/));
      })
      .catch(function (error) {
        state.loading = false;
        state.failed = true;
        console.warn('[CJK] dictionary load failed:', error && error.message);
      });
  }

  function onReady(callback) {
    if (typeof callback !== 'function') return;
    if (state.ready) { try { callback(); } catch (err) { /* ignore */ } return; }
    state.callbacks.push(callback);
  }

  function segmentHanRun(chars, start, end) {
    var n = end - start;
    var dag = new Array(n);
    for (var i = 0; i < n; i++) {
      var ends = [];
      var piece = chars[start + i];
      var max = Math.min(state.maxLen, n - i);
      for (var j = 1; j < max; j++) {
        piece += chars[start + i + j];
        if (state.words.has(piece)) ends.push(i + j + 1);
      }
      // Longest candidate first so ties prefer the longer word; the single
      // character is always available as the last resort.
      ends.sort(function (a, b) { return b - a; });
      ends.push(i + 1);
      dag[i] = ends;
    }

    var best = new Array(n + 1);
    var choice = new Array(n + 1);
    best[n] = 0;
    var total = state.total || 1;
    for (var p = n - 1; p >= 0; p--) {
      var bestScore = -Infinity;
      var bestEnd = p + 1;
      var candidates = dag[p];
      for (var k = 0; k < candidates.length; k++) {
        var next = candidates[k];
        var word = chars.slice(start + p, start + next).join('');
        var freq = state.words.get(word) || 1;
        var score = Math.log(freq / total) + best[next];
        if (score > bestScore) { bestScore = score; bestEnd = next; }
      }
      best[p] = bestScore;
      choice[p] = bestEnd;
    }

    var out = [];
    var cursor = 0;
    while (cursor < n) {
      var step = choice[cursor] || cursor + 1;
      out.push(chars.slice(start + cursor, start + step).join(''));
      cursor = step;
    }
    return out;
  }

  function segmentNonHan(text, out) {
    var tokens = text.match(/[A-Za-z0-9]+(?:['\u2019\-][A-Za-z0-9]+)*|[^\sA-Za-z0-9]+/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        // Keep a single visible space attached to the previous unit.
        if (out.length && token.length) out[out.length - 1] += ' ';
        continue;
      }
      out.push(token);
    }
  }

  function segment(text) {
    var source = String(text == null ? '' : text);
    if (!state.ready || !source) return [];
    var chars = Array.from(source);
    var out = [];
    var i = 0;
    while (i < chars.length) {
      if (isHanChar(chars[i])) {
        var runEnd = i + 1;
        while (runEnd < chars.length && isHanChar(chars[runEnd])) runEnd++;
        var words = segmentHanRun(chars, i, runEnd);
        for (var w = 0; w < words.length; w++) out.push(words[w]);
        i = runEnd;
      } else {
        var nonHanEnd = i + 1;
        while (nonHanEnd < chars.length && !isHanChar(chars[nonHanEnd])) nonHanEnd++;
        segmentNonHan(chars.slice(i, nonHanEnd).join(''), out);
        i = nonHanEnd;
      }
    }
    return out;
  }

  global.cjkWordSegmenter = {
    ensureLoaded: ensureLoaded,
    onReady: onReady,
    segment: segment,
    isReady: function () { return state.ready; },
    hasFailed: function () { return state.failed; }
  };
})(window);
