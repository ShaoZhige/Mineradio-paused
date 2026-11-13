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
    // Parsing the trimmed dictionary takes ~100-200ms; doing it in one go is
    // more reliable than idle slices, which never run in hidden/background
    // windows and left the segmenter stuck on single-character fallback.
    state.words = new Map();
    for (var index = 0; index < lines.length; index++) addDictionaryLine(lines[index]);
    finishLoading();
  }

  function ensureLoaded() {
    if (state.ready || state.loading || state.failed) return;
    // 非浏览器环境（单测的 vm 沙箱）没有 fetch，别让它抛在渲染循环里。
    if (typeof fetch !== 'function') {
      state.failed = true;
      console.warn('[CJK] fetch is unavailable; falling back to Intl.Segmenter');
      return;
    }
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
    return mergeKnownSingleRuns(out);
  }

  // Jieba's DAG prefers single characters when a title/phrase is not in the
  // dictionary (e.g. 愿与愁).  Three or more consecutive *known* single Han
  // characters read as one visual unit in the lyric styles, so merge them.
  // Unknown characters stay single (the test suite relies on that fallback).
  function mergeKnownSingleRuns(words) {
    var out = [];
    var i = 0;
    while (i < words.length) {
      var runStart = i;
      if (words[i].length === 1 && state.words.has(words[i])) {
        var j = i + 1;
        while (j < words.length && words[j].length === 1 && state.words.has(words[j])) j++;
        if (j - i >= 3) {
          out.push(words.slice(i, j).join(''));
          i = j;
          continue;
        }
      }
      out.push(words[i]);
      i++;
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

  // ---- 歌词分词统一入口 ---------------------------------------------------
  //
  // 流光（16）和商籁（18）必须拿到同一套词边界：两边的版面、镜头锚点、逐字
  // 时间窗都是按「词」算的，只要一边走词典、另一边走 Intl.Segmenter，切样式
  // 时同一行歌词就会断在不同位置，画面跟着跳。规则只在这里维护一次：
  //   1. 词典就绪 → 用词典；未就绪 → Intl.Segmenter；再不行逐字兜底。
  //   2. 两条路径都过同一个 normalizeUnits()：空格与标点吸附到前一个词、
  //      「的 / 了 / 在」这类虚词并回前一个词、相邻两个非虚词单字合成一个词。
  // 词典是同步 DFA，就绪后同样的输入永远给同样的输出，seek 到任何位置结果都不变；
  // 就绪那一刻由调用方各重建一次，之后不再变化。
  var CJK_SINGLE = /^[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]$/;
  var WORD_STOP = '的了着过们吗呢吧啊呀哦嗯在是不没就都也又还很太最更我你他她它这那哪谁什么怎和与或而但却把被给让对从向为以于之其个些点上下中里外来到会能要想说看听有无一二三四五六七八九十啦嘛喔诶唉嘿哈';
  var SPACE_ONLY_RE = /^\s+$/;
  var PUNCT_ONLY_RE = /^[\p{P}\p{S}]+$/u;

  function isWordStop(token) {
    return token.length === 1 && WORD_STOP.indexOf(token) >= 0;
  }

  function normalizeUnits(parts) {
    var units = [];
    for (var i = 0; i < parts.length; i++) {
      var token = parts[i];
      if (!token) continue;
      if (SPACE_ONLY_RE.test(token)) {
        // Keep a single visible space attached to the previous unit.
        if (units.length) units[units.length - 1] += ' ';
        continue;
      }
      if (PUNCT_ONLY_RE.test(token)) {
        if (units.length) units[units.length - 1] += token; else units.push(token);
        continue;
      }
      var prev = units.length ? units[units.length - 1] : '';
      if (prev && CJK_SINGLE.test(token) && isWordStop(token)
        && CJK_SINGLE.test(prev.charAt(prev.length - 1))) {
        units[units.length - 1] += token;
        continue;
      }
      if (CJK_SINGLE.test(token) && i + 1 < parts.length
        && CJK_SINGLE.test(parts[i + 1]) && !isWordStop(token) && !isWordStop(parts[i + 1])) {
        units.push(token + parts[++i]);
        continue;
      }
      units.push(token);
    }
    var out = [];
    for (var u = 0; u < units.length; u++) {
      var trimmed = units[u].trim();
      if (trimmed) out.push(trimmed);
    }
    return out;
  }

  function segmentWithIntl(raw) {
    var parts = [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        var seg = new Intl.Segmenter(undefined, { granularity: 'word' });
        Array.from(seg.segment(raw)).forEach(function (part) {
          if (part.segment) parts.push(part.segment);
        });
      } catch (err) { parts = []; }
    }
    if (!parts.length) {
      var re = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]|[A-Za-z0-9][A-Za-z0-9''’\-]*|[^\s]/g;
      var match;
      while ((match = re.exec(raw))) parts.push(match[0]);
    }
    return parts;
  }

  // 歌词分词唯一入口：两个全屏歌词样式都调它。
  function splitWords(text) {
    var raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!raw) return [];
    var parts = null;
    if (state.ready) {
      parts = segment(raw);
      if (!parts.length) parts = null;
    } else {
      ensureLoaded();
    }
    if (!parts) parts = segmentWithIntl(raw);
    return normalizeUnits(parts);
  }

  global.cjkWordSegmenter = {
    ensureLoaded: ensureLoaded,
    onReady: onReady,
    segment: segment,
    splitWords: splitWords,
    normalizeUnits: normalizeUnits,
    isReady: function () { return state.ready; },
    hasFailed: function () { return state.failed; }
  };
})(window);
