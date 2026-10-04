// 本模块界面文案统一走 i18n；词典是唯一文案来源，缺键时退回内置中文模板。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：xxxText('key') 缺键返回键名；xxxText('key', '兜底') 显式指定缺键时显示什么；
// xxxText('key', '含 {p} 的模板', {p: v}) 带插值，params 同时喂给 t() 与兜底模板。
// Two call shapes: key-only shows the bare key on a miss; an explicit fallback says what to
// show instead; params interpolate into both the dictionary hit and the fallback template.
function lyricsFontsTextureText(key, fallback, params) {
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

function builtinLyricFontKeyPattern() {
  return /^(sans|hei|song|bold-song|stone-song|kai-song|serif-en|gothic|editorial|humanist|round|mono|display)$/;
}
function customLyricFontKey(id) {
  id = String(id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  return id ? ('custom:' + id) : '';
}
function customLyricFontIdFromKey(key) {
  var match = /^custom:([a-z0-9_-]{1,32})$/i.exec(String(key || ''));
  return match ? match[1] : '';
}
function customLyricFontRecordForKey(key) {
  var id = customLyricFontIdFromKey(key);
  if (!id || !Array.isArray(customLyricFonts)) return null;
  for (var i = 0; i < customLyricFonts.length; i++) {
    if (customLyricFonts[i] && customLyricFonts[i].id === id) return customLyricFonts[i];
  }
  return null;
}
function normalizeCustomLyricFontName(name) {
  name = String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (name || lyricsFontsTextureText('lyfonts_custom')).slice(0, 18);
}
function normalizeCustomLyricFontRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var id = String(raw.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  var dataUrl = String(raw.dataUrl || '');
  if (!id || !/^data:(font\/(ttf|otf|woff2?|sfnt)|application\/(font-woff|x-font-ttf|x-font-otf|octet-stream)|application\/vnd\.ms-fontobject);base64,/i.test(dataUrl)) return null;
  return {
    id: id,
    name: normalizeCustomLyricFontName(raw.name),
    family: String(raw.family || ('MineradioCustomLyricFont-' + id)).replace(/["\\]/g, '').slice(0, 72) || ('MineradioCustomLyricFont-' + id),
    dataUrl: dataUrl,
    size: Math.max(0, Number(raw.size) || 0),
    savedAt: Math.max(0, Number(raw.savedAt) || Date.now())
  };
}
function readCustomLyricFonts() {
  try {
    var raw = JSON.parse(localStorage.getItem(CUSTOM_LYRIC_FONT_STORE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeCustomLyricFontRecord).filter(Boolean).slice(0, CUSTOM_LYRIC_FONT_MAX_COUNT);
  } catch (e) {
    return [];
  }
}
function saveCustomLyricFonts() {
  try {
    localStorage.setItem(CUSTOM_LYRIC_FONT_STORE_KEY, JSON.stringify(customLyricFonts || []));
    return true;
  } catch (e) {
    console.warn('[LyricFont] save failed', e);
    return false;
  }
}
function quotedCssFontFamily(name) {
  return '"' + String(name || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function registerCustomLyricFont(record) {
  var source = record;
  record = normalizeCustomLyricFontRecord(record);
  if (!record || typeof FontFace !== 'function' || !document.fonts) return Promise.resolve(false);
  if (source && source.loaded && source.id === record.id) return Promise.resolve(true);
  try {
    var face = new FontFace(record.family, 'url("' + record.dataUrl + '")');
    return face.load().then(function (loadedFace) {
      document.fonts.add(loadedFace);
      clearLyricTextMeasureCache();
      scheduleLyricTextMeasureWarmup(0);
      record.loaded = true;
      if (source && source.id === record.id) source.loaded = true;
      return true;
    }).catch(function (err) {
      console.warn('[LyricFont] load failed', err);
      return false;
    });
  } catch (e) {
    console.warn('[LyricFont] register failed', e);
    return Promise.resolve(false);
  }
}
function registerSavedCustomLyricFonts() {
  if (!Array.isArray(customLyricFonts) || !customLyricFonts.length) return;
  customLyricFonts.forEach(function (record) { registerCustomLyricFont(record); });
}
function normalizeLyricFontKey(value) {
  value = String(value || 'sans');
  if (builtinLyricFontKeyPattern().test(value)) return value;
  if (customLyricFontRecordForKey(value)) return value;
  return 'sans';
}
function lyricFontStackForKey(key) {
  key = normalizeLyricFontKey(key);
  var customFont = customLyricFontRecordForKey(key);
  if (customFont) return quotedCssFontFamily(customFont.family) + ',"Noto Sans SC","Microsoft YaHei","PingFang SC",sans-serif';
  if (key === 'hei') return '"Noto Sans SC","Microsoft YaHei",SimHei,"PingFang SC",sans-serif';
  if (key === 'song') return '"Noto Serif SC","Source Han Serif SC",SimSun,"Songti SC",serif';
  if (key === 'bold-song') return '"Source Han Serif SC Heavy","Source Han Serif SC","Noto Serif SC Black","Noto Serif SC","STZhongsong","SimSun",serif';
  if (key === 'stone-song') return '"FZYaSongS-B-GB","FZCuSong-B09S","Source Han Serif SC Heavy","Noto Serif SC Black","STZhongsong","SimSun",serif';
  if (key === 'kai-song') return '"Kaiti SC","STKaiti","KaiTi","Source Han Serif SC","Noto Serif SC",serif';
  if (key === 'serif-en') return 'Georgia,"Times New Roman","Noto Serif SC","Source Han Serif SC",serif';
  if (key === 'gothic') return '"UnifrakturCook","UnifrakturMaguntia","Old English Text MT","Blackletter","Cinzel Decorative","Noto Serif SC",serif';
  if (key === 'editorial') return '"Didot","Bodoni 72","Libre Baskerville",Georgia,"Noto Serif SC",serif';
  if (key === 'humanist') return '"Avenir Next","Segoe UI","Inter","Noto Sans SC","PingFang SC",sans-serif';
  if (key === 'round') return '"HarmonyOS Sans SC","Microsoft YaHei UI","PingFang SC","Noto Sans SC",sans-serif';
  if (key === 'mono') return '"JetBrains Mono",Consolas,"Noto Sans SC","Microsoft YaHei",monospace';
  if (key === 'display') return '"Alibaba PuHuiTi","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif';
  return 'Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",Arial,sans-serif';
}
function lyricFontWeightValue() {
  if (normalizeLyricFontKey(fx && fx.lyricFont) === 'stone-song') return 900;
  return Math.round(clampRange(Number(fx && fx.lyricWeight) || 900, 500, 900) / 50) * 50;
}
function lyricFontCss(fontSize, weight) {
  var w = weight == null ? lyricFontWeightValue() : Math.round(clampRange(Number(weight) || lyricFontWeightValue(), 500, 900) / 50) * 50;
  return w + ' ' + fontSize + 'px ' + lyricFontStackForKey(fx && fx.lyricFont);
}
function lyricLetterSpacingPx(fontSize) {
  return clampRange(Number(fx && fx.lyricLetterSpacing) || 0, -0.04, 0.18) * Math.max(1, fontSize || 1);
}
function lyricLineHeightFactor() {
  return clampRange(Number(fx && fx.lyricLineHeight) || 1, 0.72, 1.80);
}
// 行高的唯一来源。行数不参与计算：原先按"载荷里是否多于一行"再乘 0.98 与
// lyricContextSpread(默认 1.96)，使得单行载荷和多行载荷的行高相差近两倍，行距随歌曲里
// 恰好有几行而跳变，用户 DIY 的行距被这些系数盖掉。常量 0.98 保留多行分支原本的取值，
// 保证多行场景的观感不变，只是不再有第二套值。
// 中英对照：The single source of truth for line height. Line count must not take part: the
// former per-line-count 0.98 and lyricContextSpread (default 1.96) multipliers made one-line
// and multi-line payloads differ by nearly 2x, so spacing jumped from song to song and drowned
// out the user's own setting. The 0.98 constant preserves the multi-line look exactly.
const LYRIC_MASK_LINE_HEIGHT_BASE = 0.98;
function lyricMaskLineHeight(fontSize) {
  var size = Number(fontSize);
  if (!(size > 0)) size = 128;
  return size * LYRIC_MASK_LINE_HEIGHT_BASE * lyricLineHeightFactor() * lyricContextSpreadValue();
}
var lyricTextMeasureCache = { fonts: {}, order: [], maxFonts: 64, maxCharsPerFont: 512 };
function clearLyricTextMeasureCache() {
  lyricTextMeasureCache = { fonts: {}, order: [], maxFonts: 64, maxCharsPerFont: 512 };
}
function lyricTextMeasureFontCache(ctx) {
  var key = String(ctx && ctx.font || '');
  var cache = lyricTextMeasureCache.fonts[key];
  if (cache) return cache;
  while (lyricTextMeasureCache.order.length >= lyricTextMeasureCache.maxFonts) {
    delete lyricTextMeasureCache.fonts[lyricTextMeasureCache.order.shift()];
  }
  cache = { values: {}, order: [] };
  lyricTextMeasureCache.fonts[key] = cache;
  lyricTextMeasureCache.order.push(key);
  return cache;
}
function lyricMeasuredCharacterWidth(ctx, character) {
  character = String(character || '');
  var cache = lyricTextMeasureFontCache(ctx);
  if (Object.prototype.hasOwnProperty.call(cache.values, character)) return cache.values[character];
  while (cache.order.length >= lyricTextMeasureCache.maxCharsPerFont) delete cache.values[cache.order.shift()];
  var width = ctx.measureText(character).width;
  cache.values[character] = width;
  cache.order.push(character);
  return width;
}
var lyricTextMeasureWarmupTimer = 0;
function warmLyricTextMeasureCache() {
  lyricTextMeasureWarmupTimer = 0;
  if (typeof document === 'undefined') return;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.font = lyricFontCss(128);
  measureTextWithLetterSpacing(ctx, lyricsFontsTextureText('lyfonts_sample'), lyricLetterSpacingPx(128));
}
function scheduleLyricTextMeasureWarmup(delay) {
  if (lyricTextMeasureWarmupTimer) clearTimeout(lyricTextMeasureWarmupTimer);
  var run = warmLyricTextMeasureCache;
  delay = Math.max(0, Number(delay) || 0);
  lyricTextMeasureWarmupTimer = setTimeout(function () {
    lyricTextMeasureWarmupTimer = 0;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 800 });
    else run();
  }, delay);
}
if (typeof document !== 'undefined' && document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('loadingdone', function () {
    clearLyricTextMeasureCache();
    scheduleLyricTextMeasureWarmup(0);
  });
}
scheduleLyricTextMeasureWarmup(120);
function measureTextWithLetterSpacing(ctx, text, spacing) {
  text = String(text || '');
  spacing = Number(spacing) || 0;
  if (!spacing || text.length < 2) return ctx.measureText(text).width;
  var chars = Array.from(text);
  if ('fontKerning' in ctx && 'letterSpacing' in ctx) {
    var previousKerning = ctx.fontKerning;
    var previousLetterSpacing = ctx.letterSpacing;
    var probeSpacing = 0.001;
    try {
      ctx.fontKerning = 'none';
      ctx.letterSpacing = probeSpacing + 'px';
      var glyphWidth = ctx.measureText(text).width - probeSpacing * chars.length;
      if (isFinite(glyphWidth)) return Math.max(1, glyphWidth + spacing * (chars.length - 1));
    } finally {
      ctx.fontKerning = previousKerning;
      ctx.letterSpacing = previousLetterSpacing;
    }
  }
  var w = 0;
  for (var i = 0; i < chars.length; i++) {
    w += lyricMeasuredCharacterWidth(ctx, chars[i]);
    if (i < chars.length - 1) w += spacing;
  }
  return Math.max(1, w);
}
function lyricMeasureText(ctx, text, fontSize) {
  return measureTextWithLetterSpacing(ctx, text, lyricLetterSpacingPx(fontSize));
}
function lyricMeasureTextAtSize(ctx, text, fontSize, weight) {
  var prevFont = ctx.font;
  ctx.font = lyricFontCss(fontSize, weight);
  var width = lyricMeasureText(ctx, text, fontSize);
  ctx.font = prevFont;
  return width;
}
function drawTextWithLetterSpacing(ctx, text, x, y, spacing, stroke) {
  text = String(text || '');
  spacing = Number(spacing) || 0;
  if (!spacing || text.length < 2) {
    if (stroke) ctx.strokeText(text, x, y);
    else ctx.fillText(text, x, y);
    return;
  }
  var chars = Array.from(text);
  var align = ctx.textAlign || 'left';
  var width = measureTextWithLetterSpacing(ctx, text, spacing);
  var start = x;
  if (align === 'center') start = x - width / 2;
  else if (align === 'right' || align === 'end') start = x - width;
  ctx.textAlign = 'left';
  var cursor = start;
  for (var i = 0; i < chars.length; i++) {
    if (stroke) ctx.strokeText(chars[i], cursor, y);
    else ctx.fillText(chars[i], cursor, y);
    cursor += lyricMeasuredCharacterWidth(ctx, chars[i]) + (i < chars.length - 1 ? spacing : 0);
  }
  ctx.textAlign = align;
}
function lyricFillText(ctx, text, x, y, fontSize) {
  drawTextWithLetterSpacing(ctx, text, x, y, lyricLetterSpacingPx(fontSize), false);
}
function lyricStrokeText(ctx, text, x, y, fontSize) {
  drawTextWithLetterSpacing(ctx, text, x, y, lyricLetterSpacingPx(fontSize), true);
}
function applyStonePrintTexture(ctx, W, H, fontSize, randomFn) {
  if (normalizeLyricFontKey(fx && fx.lyricFont) !== 'stone-song') return;
  var random = typeof randomFn === 'function' ? randomFn : Math.random;
  var size = clampRange(fontSize || 128, 42, 180);
  var bandTop = H * 0.10;
  var bandH = H * 0.80;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';

  var noiseW = 300, noiseH = 110;
  var noise = document.createElement('canvas');
  noise.width = noiseW; noise.height = noiseH;
  var nctx = noise.getContext('2d');
  var img = nctx.createImageData(noiseW, noiseH);
  for (var p = 0; p < noiseW * noiseH; p++) {
    var x0 = p % noiseW;
    var y0 = Math.floor(p / noiseW);
    var vein = Math.sin(x0 * 0.19 + y0 * 0.043) * 0.10 + Math.sin(y0 * 0.31) * 0.06;
    var r = random() + vein;
    var a = 0;
    if (r > 0.82) a = 78 + random() * 92;
    else if (r > 0.62) a = 22 + random() * 54;
    else if (r > 0.48) a = 4 + random() * 24;
    img.data[p * 4] = 255;
    img.data[p * 4 + 1] = 255;
    img.data[p * 4 + 2] = 255;
    img.data[p * 4 + 3] = a;
  }
  nctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 0.34;
  ctx.drawImage(noise, 0, bandTop, W, bandH);

  var chips = Math.round(size * 7.2);
  for (var i = 0; i < chips; i++) {
    var x = random() * W;
    var y = bandTop + random() * bandH;
    var w = 0.7 + random() * (size * 0.052);
    var h = 0.45 + random() * (size * 0.026);
    ctx.globalAlpha = 0.16 + random() * 0.36;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((random() - 0.5) * 0.38);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  ctx.lineCap = 'round';
  for (var s = 0; s < 44; s++) {
    var sx = random() * W;
    var sy = bandTop + random() * bandH;
    ctx.globalAlpha = 0.09 + random() * 0.16;
    ctx.lineWidth = 0.45 + random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 10 + random() * 86, sy + (random() - 0.5) * 4.8);
    ctx.stroke();
  }

  for (var c = 0; c < 26; c++) {
    var cx = random() * W;
    var cy = bandTop + random() * bandH;
    var radius = 1.8 + random() * (size * 0.060);
    ctx.globalAlpha = 0.08 + random() * 0.18;
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius * (0.7 + random() * 1.4), radius * (0.25 + random() * 0.55), random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
function hexToRgb(hex) {
  hex = normalizeHexColor(hex).slice(1);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}
