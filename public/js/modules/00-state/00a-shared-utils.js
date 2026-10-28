// 最底层的纯工具：不读全局状态、不碰 DOM，任何模块都可以在加载期直接调用。
// 这些函数原本沉在 02-visual/04 里，导致 00-state 层的状态初始化必须依赖“后面文件里的函数已经
// 被提升”这一拼接期特性 —— 拆成分文件加载时会直接炸。搬到这里之后，工具层再无后向引用。
// Lowest-level pure helpers: no global state, no DOM, safe to call during module evaluation.

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h, s: s, l: l };
}
function hslToRgb(h, s, l) {
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  var r, g, b;
  if (s === 0) r = g = b = l;
  else {
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}
function rgbCss(c, a) {
  if (a == null) return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
}
function clampRange(v, min, max) { return Math.max(min, Math.min(max, v)); }
function normalizeCoverResolution(v) {
  return clampRange(Number(v) || 1, 0.75, 1.55);
}

function layoutNumber(value, fallback, min, max) {
  var n = Number(value);
  if (!isFinite(n)) n = Number(fallback);
  if (!isFinite(n)) n = min;
  return clampRange(n, min, max);
}
function layoutInteger(value, fallback, min, max) {
  return Math.round(layoutNumber(value, fallback, min, max));
}
function coverParticleGridForResolution(v) {
  var grid = Math.round(118 * normalizeCoverResolution(v));
  grid = Math.max(88, Math.min(183, grid));
  return grid % 2 ? grid : grid + 1;
}

function normalizeHexColor(value, fallback) {
  var hex = String(value || '').trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    hex = '#' + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2) + hex.charAt(3) + hex.charAt(3);
  }
  fallback = /^#[0-9a-f]{6}$/i.test(String(fallback || '')) ? String(fallback).toLowerCase() : '#a9b8c8';
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : fallback;
}

// 音频淡入淡出的存储键与取值范围。它们原来在 00-core-stores.js 里，但
// 02-preferences 的 readAudioFadePreference() 要在 00-core 之前执行，就必须一起下沉。
// Fade storage key and clamp range, moved down so the preference reader can run before 00-core.
var AUDIO_FADE_STORE_KEY = 'mineradio-audio-fade-v1';
var AUDIO_FADE_MIN_MS = 0;
var AUDIO_FADE_MAX_MS = 3000;
