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
function lyricColorControlsText(key, fallback, params) {
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
function buildLyricColorControls() {
  var grid = document.getElementById('lyric-color-grid');
  if (!grid) return;
  var html = lyricColorControlsText('lyriccolor_auto_btn',
    '<button class="lyric-swatch auto" type="button" data-auto="1" onclick="setLyricColorAuto()" title="封面取色">AUTO</button>');
  html += lyricColorPresets().map(function (p, i) {
    return '<button class="lyric-swatch" type="button" data-color="' + p.color + '" onclick="setLyricColorPreset(' + i + ')" title="' + escHtml(p.name) + '" style="--swatch:' + p.color + '"></button>';
  }).join('');
  grid.innerHTML = html;
}
function lyricControlPalette() {
  var source = fx.lyricColorMode === 'custom'
    ? lyricPaletteFromHex(fx.lyricColor)
    : ((stageLyrics && (stageLyrics.coverPalette || stageLyrics.palette)) || null);
  return typeof effectiveLyricPalette === 'function' ? effectiveLyricPalette(source) : (source || {});
}
function updateLyricColorControls() {
  var picker = document.getElementById('lyric-color-picker');
  var value = document.getElementById('lyric-color-value');
  var autoBtn = document.getElementById('lyric-auto-btn');
  var color = normalizeHexColor(fx.lyricColor);
  var pal = lyricControlPalette();
  var tone = fx.lyricColorMode === 'custom'
    ? color
    : lyricPaletteColorToHex(pal.primary || pal.secondary || color, '#a9b8c8', 0.38);
  if (picker) picker.value = tone;
  if (value) value.textContent = fx.lyricColorMode === 'custom' ? color.toUpperCase() : lyricColorControlsText('cover_pick_color', '封面取色');
  if (autoBtn) autoBtn.classList.toggle('active', fx.lyricColorMode !== 'custom');
  document.querySelectorAll('.lyric-swatch').forEach(function (btn) {
    var isAuto = btn.dataset.auto === '1';
    var isColor = normalizeHexColor(btn.dataset.color || '') === color;
    btn.classList.toggle('active', isAuto ? fx.lyricColorMode !== 'custom' : (fx.lyricColorMode === 'custom' && isColor));
  });
}
function updateLyricHighlightControls() {
  var picker = document.getElementById('lyric-highlight-picker');
  var value = document.getElementById('lyric-highlight-value');
  var autoBtn = document.getElementById('lyric-highlight-auto-btn');
  var color = normalizeHexColor(fx.lyricHighlightColor);
  var pal = lyricControlPalette();
  var tone = fx.lyricHighlightMode === 'custom'
    ? color
    : lyricPaletteColorToHex(pal.highlight || pal.primary || color, '#fff0b8', 0.48);
  if (picker) picker.value = tone;
  if (value) value.textContent = fx.lyricHighlightMode === 'custom' ? color.toUpperCase() : lyricColorControlsText('highlight_follow', '跟随歌词');
  if (autoBtn) autoBtn.classList.toggle('active', fx.lyricHighlightMode !== 'custom');
}
function lyricPaletteColorToHex(value, fallback, minLum) {
  if (typeof lyricThreeColor === 'function') {
    try {
      var c = lyricThreeColor(value, fallback || '#9db8cf', minLum == null ? 0.36 : minLum);
      if (c && c.getHexString) return '#' + c.getHexString();
    } catch (e) { }
  }
  return normalizeHexColor(value || fallback || '#9db8cf', fallback || '#9db8cf');
}
function lyricGlowControlTone() {
  var pal = lyricControlPalette();
  var glow = fx.lyricGlowLinked === false
    ? fx.lyricGlowColor
    : (pal.glowColor || pal.secondary || pal.highlight || pal.primary || fx.lyricGlowColor);
  return lyricPaletteColorToHex(glow, '#9db8cf', fx.lyricGlowLinked === false ? 0.36 : 0.40);
}
function updateLyricGlowControls() {
  var row = document.getElementById('lyric-glow-row');
  var picker = document.getElementById('lyric-glow-picker');
  var value = document.getElementById('lyric-glow-value');
  var linkBtn = document.getElementById('lyric-glow-link-btn');
  var glowEnableBtn = document.getElementById('lyric-glow-enable-btn');
  var glowBeatBtn = document.getElementById('lyric-glow-beat-btn');
  var linked = fx.lyricGlowLinked !== false;
  var color = normalizeHexColor(fx.lyricGlowColor || '#9db8cf');
  var tone = lyricGlowControlTone();
  if (picker) picker.value = linked ? tone : color;
  if (row) {
    row.classList.toggle('linked', linked);
    row.style.setProperty('--lyric-glow-color', tone);
  }
  if (picker) picker.style.setProperty('--lyric-glow-color', tone);
  if (value) {
    value.textContent = linked ? lyricColorControlsText('glow_follow_highlight', '跟随高亮') : color.toUpperCase();
    value.style.setProperty('--lyric-glow-color', tone);
  }
  if (linkBtn) {
    linkBtn.classList.toggle('active', linked);
    linkBtn.style.setProperty('--lyric-glow-color', tone);
    linkBtn.textContent = linked ? lyricColorControlsText('btn_link', '链接') : lyricColorControlsText('btn_independent', '独立');
    linkBtn.title = linked ? lyricColorControlsText('glow_set_independent', '点击后单独设置溢光颜色') : lyricColorControlsText('glow_follow_highlight_hint', '点击后让溢光跟随高亮');
  }
  [glowEnableBtn, glowBeatBtn].forEach(function (btn) {
    if (btn) btn.style.setProperty('--lyric-glow-color', tone);
  });
  if (glowEnableBtn) {
    glowEnableBtn.classList.toggle('active', !!fx.lyricGlow);
    glowEnableBtn.title = fx.lyricGlow ? lyricColorControlsText('lyriccolor_bloom_off', '关闭歌词背后的溢光层') : lyricColorControlsText('lyriccolor_bloom_on', '开启歌词背后的溢光层');
  }
  if (glowBeatBtn) {
    glowBeatBtn.classList.toggle('active', !!fx.lyricGlowBeat);
    glowBeatBtn.title = fx.lyricGlowBeat ? lyricColorControlsText('lyriccolor_bloom_following', '后层溢光正在跟随鼓点') : lyricColorControlsText('lyriccolor_bloom_follow', '让后层溢光跟随鼓点');
  }
}

// 词典异步加载完成时（首屏 init 会广播）及切换语言后重建色板，
// 保证 AUTO 等按钮的文案始终本地化，不会残留早加载阶段的裸 key。
// Rebuild the swatches once the dictionary is ready (the initial init() broadcasts)
// and after every language switch, so the AUTO button stays localized and never
// shows a raw key left over from the pre-load render.
if (typeof window !== 'undefined' && window.MineradioI18n && typeof window.MineradioI18n.onLanguageChange === 'function') {
  window.MineradioI18n.onLanguageChange(function () { buildLyricColorControls(); });
}
