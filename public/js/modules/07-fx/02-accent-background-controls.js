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
function accentBackgroundControlsText(key, fallback, params) {
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
function applyHomeAccentColor() {
  var color = normalizeHexColor(fx.homeAccentColor || '#00f5d4');
  var rgb = hexToRgb(color);
  document.documentElement.style.setProperty('--home-accent', color);
  document.documentElement.style.setProperty('--home-accent-rgb', rgb.r + ',' + rgb.g + ',' + rgb.b);
}
function updateHomeAccentControls() {
  applyHomeAccentColor();
  var color = normalizeHexColor(fx.homeAccentColor || '#00f5d4');
  var picker = document.getElementById('home-accent-picker');
  var value = document.getElementById('home-accent-value');
  if (picker) picker.value = color;
  if (value) value.textContent = color.toUpperCase();
}
function setHomeAccentColor(color, silent) {
  fx.homeAccentColor = normalizeHexColor(color || '#00f5d4');
  updateHomeAccentControls();
  saveLyricLayout({ user: true, reason: 'homeAccentColor' });
  if (!silent) showToast(accentBackgroundControlsText('bind_home_fill_prefix') + fx.homeAccentColor.toUpperCase());
}
function resetHomeAccentColor() {
  setHomeAccentColor(fxDefaults.homeAccentColor || '#00f5d4');
}
function applyIconAccentColors() {
  var homeColor = normalizeHexColor(fx.homeIconColor || fxDefaults.homeIconColor || '#f4d28a', '#f4d28a');
  var visualColor = normalizeHexColor(fx.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  var homeRgb = hexToRgb(homeColor);
  var visualRgb = hexToRgb(visualColor);
  var root = document.documentElement;
  root.style.setProperty('--home-icon-color', homeColor);
  root.style.setProperty('--home-icon-rgb', homeRgb.r + ',' + homeRgb.g + ',' + homeRgb.b);
  root.style.setProperty('--visual-icon-color', visualColor);
  root.style.setProperty('--visual-icon-rgb', visualRgb.r + ',' + visualRgb.g + ',' + visualRgb.b);
}
function updateIconAccentControls() {
  applyIconAccentColors();
  var homeColor = normalizeHexColor(fx.homeIconColor || fxDefaults.homeIconColor || '#f4d28a', '#f4d28a');
  var visualColor = normalizeHexColor(fx.visualIconColor || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  var homePicker = document.getElementById('home-icon-picker');
  var homeValue = document.getElementById('home-icon-value');
  var visualPicker = document.getElementById('visual-icon-picker');
  var visualValue = document.getElementById('visual-icon-value');
  if (homePicker) homePicker.value = homeColor;
  if (homeValue) homeValue.textContent = homeColor.toUpperCase();
  if (visualPicker) visualPicker.value = visualColor;
  if (visualValue) visualValue.textContent = visualColor.toUpperCase();
}
function setHomeIconColor(color, silent) {
  fx.homeIconColor = normalizeHexColor(color || fxDefaults.homeIconColor || '#f4d28a', '#f4d28a');
  updateIconAccentControls();
  saveLyricLayout({ user: true, reason: 'homeIconColor' });
  if (!silent) showToast(accentBackgroundControlsText('bind_home_icon_prefix') + fx.homeIconColor.toUpperCase());
}
function resetHomeIconColor() {
  setHomeIconColor(fxDefaults.homeIconColor || '#f4d28a');
}
function setVisualIconColor(color, silent) {
  fx.visualIconColor = normalizeHexColor(color || fxDefaults.visualIconColor || '#7fd8ff', '#7fd8ff');
  updateIconAccentControls();
  saveLyricLayout({ user: true, reason: 'visualIconColor' });
  if (!silent) showToast(accentBackgroundControlsText('bind_visual_icon_prefix') + fx.visualIconColor.toUpperCase());
}
function resetVisualIconColor() {
  setVisualIconColor(fxDefaults.visualIconColor || '#7fd8ff');
}
function customBackgroundCropNumber(key, fallback, min, max) {
  var n = Number(fx && fx[key]);
  if (!isFinite(n)) n = Number(fallback);
  if (!isFinite(n)) n = min;
  return clampRange(n, min, max);
}
var customBackgroundCropModalState = null;
var customBackgroundCropModalBound = false;
var customBackgroundCropModalObjectUrl = '';
function customBackgroundAlbumCoverSource() {
  var src = '';
  try {
    if (typeof albumBackgroundCurrentSrc !== 'undefined' && albumBackgroundCurrentSrc) src = String(albumBackgroundCurrentSrc || '');
  } catch (e) { }
  if (!src) {
    try {
      if (typeof currentCoverSource !== 'undefined' && currentCoverSource && currentCoverSource.src) src = String(currentCoverSource.src || '');
    } catch (e2) { }
  }
  if (!src) {
    try {
      var thumb = document.getElementById('thumb-cover');
      src = thumb && (thumb.currentSrc || thumb.src || thumb.getAttribute('src')) || '';
    } catch (e3) { }
  }
  if (!src) {
    try {
      var song = typeof sonicWorkshopCurrentSong === 'function' ? sonicWorkshopCurrentSong() : null;
      if (!song) song = Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
      if (!song) song = Array.isArray(playlist) && currentIdx >= 0 && currentIdx < playlist.length ? playlist[currentIdx] : null;
      if (song) src = typeof songCoverSrc === 'function' ? songCoverSrc(song, 640) : (song.customCover || song.cover || '');
    } catch (e4) { }
  }
  if (src && /^https?:\/\//i.test(src) && typeof coverProxySrc === 'function') return coverProxySrc(src, false) || src;
  return src || '';
}
function customBackgroundActiveMedia() {
  var media = normalizeCustomBackgroundMedia(fx.backgroundMedia || fx.backgroundImage);
  if ((typeof customBackgroundUsesAlbumCover === 'function' && customBackgroundUsesAlbumCover()) || (media && media.type === 'album')) {
    var albumSrc = customBackgroundAlbumCoverSource();
    return albumSrc ? { type: 'image', src: albumSrc, album: true } : null;
  }
  return media;
}
function applyCustomBackgroundCropVars(root, layer) {
  var cropX = customBackgroundCropNumber('backgroundMediaCropX', fxDefaults.backgroundMediaCropX == null ? 50 : fxDefaults.backgroundMediaCropX, 0, 100);
  var cropY = customBackgroundCropNumber('backgroundMediaCropY', fxDefaults.backgroundMediaCropY == null ? 50 : fxDefaults.backgroundMediaCropY, 0, 100);
  var zoom = customBackgroundCropNumber('backgroundMediaZoom', fxDefaults.backgroundMediaZoom == null ? 1 : fxDefaults.backgroundMediaZoom, 1, 2.8);
  var vars = [
    ['--custom-bg-position-x', cropX.toFixed(1) + '%'],
    ['--custom-bg-position-y', cropY.toFixed(1) + '%'],
    ['--custom-bg-zoom', zoom.toFixed(3)]
  ];
  vars.forEach(function (item) {
    if (root) root.style.setProperty(item[0], item[1]);
    if (layer) layer.style.setProperty(item[0], item[1]);
  });
}
function applyCustomBackground() {
  var color = normalizeHexColor(fx.backgroundColor || '#000000', '#000000');
  var rgb = hexToRgb(color);
  var albumMode = typeof customBackgroundUsesAlbumCover === 'function' && customBackgroundUsesAlbumCover();
  var media = customBackgroundActiveMedia();
  var image = media && media.type === 'image' ? media.src : '';
  var hasVideo = !!(media && media.type === 'video');
  var opacity = clampRange(fx.backgroundOpacity == null ? 1 : Number(fx.backgroundOpacity), 0, 1);
  var windowOpacity = clampRange(fx.windowBackgroundOpacity == null ? fxDefaults.windowBackgroundOpacity : Number(fx.windowBackgroundOpacity), 0, 1);
  var glassOpacity = clampRange(fx.backgroundGlassOpacity == null ? fxDefaults.backgroundGlassOpacity : Number(fx.backgroundGlassOpacity), 0, 1);
  var glassActive = glassOpacity > 0.001;
  var overlayOpacity = Math.max((media || albumMode) ? 0.18 : 0, glassActive ? glassOpacity * 0.42 : 0);
  var glassBlur = glassActive ? glassOpacity * 32 : 0;
  var glassSaturate = 1 + glassOpacity * 0.55;
  var glassBrightness = 1 + glassOpacity * 0.08;
  var glassVeil = glassOpacity * 0.075;
  var customColor = fx.backgroundColorMode === 'custom' || !!fx.backgroundColorCustom;
  var override = albumMode || !!media || customColor || opacity < 1 || windowOpacity < 0.999 || glassActive;
  var root = document.documentElement;
  var layer = document.getElementById('custom-bg');
  var video = document.getElementById('custom-bg-video');
  root.style.setProperty('--custom-bg-color', color);
  root.style.setProperty('--custom-bg-color-rgb', rgb.r + ', ' + rgb.g + ', ' + rgb.b);
  root.style.setProperty('--custom-bg-album-opacity', albumMode ? opacity.toFixed(3) : '1');
  applyCustomBackgroundCropVars(root, layer);
  document.body.classList.toggle('custom-background-override', override);
  document.body.classList.toggle('custom-background-flat', override && !media);
  document.body.classList.toggle('custom-background-album-cover', albumMode);
  document.body.classList.toggle('custom-background-video', hasVideo);
  document.body.classList.toggle('custom-window-transparent', windowOpacity < 0.999);
  document.body.classList.toggle('custom-bg-glass-active', glassActive);
  if (layer) {
    layer.style.setProperty('--custom-bg-image', image ? 'url("' + cssImageUrl(image) + '")' : 'none');
    layer.style.setProperty('--custom-bg-image-opacity', image ? opacity.toFixed(3) : '0');
    layer.style.setProperty('--custom-bg-video-opacity', hasVideo ? opacity.toFixed(3) : '0');
    layer.style.setProperty('--custom-bg-base-opacity', windowOpacity.toFixed(3));
    layer.style.setProperty('--custom-bg-overlay-opacity', overlayOpacity.toFixed(3));
    layer.style.setProperty('--custom-bg-glass-opacity', glassOpacity.toFixed(3));
    layer.style.setProperty('--custom-bg-glass-blur', glassBlur.toFixed(1) + 'px');
    layer.style.setProperty('--custom-bg-glass-saturate', glassSaturate.toFixed(3));
    layer.style.setProperty('--custom-bg-glass-brightness', glassBrightness.toFixed(3));
    layer.style.setProperty('--custom-bg-glass-veil', glassVeil.toFixed(3));
  }
  var token = ++customBgApplyToken;
  if (!video) return;
  if (!hasVideo) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (customBgObjectUrl) { URL.revokeObjectURL(customBgObjectUrl); customBgObjectUrl = ''; }
    return;
  }
  var wallpaperEngineActive = document.body.classList.contains('wallpaper-engine-active');
  if (wallpaperEngineActive) {
    video.pause();
    return;
  }
  function setVideoSrc(src) {
    if (token !== customBgApplyToken || !src) return;
    if (document.body.classList.contains('wallpaper-engine-active')) {
      video.pause();
      return;
    }
    if (customBgObjectUrl && customBgObjectUrl !== src) { URL.revokeObjectURL(customBgObjectUrl); customBgObjectUrl = ''; }
    if (video.getAttribute('src') !== src) {
      video.setAttribute('src', src);
      video.load();
    }
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    var p = video.play();
    if (p && p.catch) p.catch(function () { });
  }
  if (media.src) {
    setVideoSrc(media.src);
  } else if (media.id) {
    getCustomBackgroundBlob(media.id).then(function (blob) {
      if (token !== customBgApplyToken || !blob) return;
      if (customBgObjectUrl) URL.revokeObjectURL(customBgObjectUrl);
      customBgObjectUrl = URL.createObjectURL(blob);
      setVideoSrc(customBgObjectUrl);
    }).catch(function (err) { console.warn('background video load failed:', err); });
  }
}
function updateCustomBackgroundMediaPreview(media) {
  var preview = document.getElementById('bg-media-preview');
  if (!preview) return;
  media = media || customBackgroundActiveMedia();
  preview.classList.toggle('empty', !media);
  preview.classList.toggle('video', !!(media && media.type === 'video'));
  preview.style.removeProperty('background-image');
  preview.dataset.kind = '';
  if (!media) return;
  if (media.type === 'image' && media.src) {
    preview.style.backgroundImage = 'url("' + cssImageUrl(media.src) + '")';
    preview.dataset.kind = media.album ? 'COV' : 'IMG';
  } else if (media.type === 'video') {
    preview.dataset.kind = 'VID';
  }
}
function updateCustomBackgroundControls() {
  applyCustomBackground();
  var activeMedia = customBackgroundActiveMedia();
  var color = normalizeHexColor(fx.backgroundColor || '#000000', '#000000');
  var picker = document.getElementById('bg-color-picker');
  var value = document.getElementById('bg-color-value');
  var imageValue = document.getElementById('bg-image-value');
  var albumBtn = document.getElementById('bg-album-toggle-btn');
  var cropBtn = document.getElementById('bg-media-crop-btn');
  var customColor = fx.backgroundColorMode === 'custom' || !!fx.backgroundColorCustom;
  if (picker) picker.value = color;
  if (value) value.textContent = customColor ? color.toUpperCase() : accentBackgroundControlsText('accent_cover_gradient');
  if (picker && picker.closest) {
    var row = picker.closest('.lyric-color-row');
    if (row) row.classList.toggle('bg-cover-mode', !customColor);
  }
  setRange('fx-bgopacity', fx.backgroundOpacity == null ? 1 : fx.backgroundOpacity);
  setRange('fx-windowbgopacity', fx.windowBackgroundOpacity == null ? fxDefaults.windowBackgroundOpacity : fx.windowBackgroundOpacity);
  setRange('fx-bgglassopacity', fx.backgroundGlassOpacity == null ? fxDefaults.backgroundGlassOpacity : fx.backgroundGlassOpacity);
  setRange('fx-bgcropx', customBackgroundCropNumber('backgroundMediaCropX', fxDefaults.backgroundMediaCropX == null ? 50 : fxDefaults.backgroundMediaCropX, 0, 100));
  setRange('fx-bgcropy', customBackgroundCropNumber('backgroundMediaCropY', fxDefaults.backgroundMediaCropY == null ? 50 : fxDefaults.backgroundMediaCropY, 0, 100));
  setRange('fx-bgzoom', customBackgroundCropNumber('backgroundMediaZoom', fxDefaults.backgroundMediaZoom == null ? 1 : fxDefaults.backgroundMediaZoom, 1, 2.8));
  if (imageValue) imageValue.textContent = customBackgroundMediaLabel(fx.backgroundMedia || fx.backgroundImage);
  if (albumBtn) {
    albumBtn.classList.toggle('active', typeof customBackgroundUsesAlbumCover === 'function' && customBackgroundUsesAlbumCover());
    albumBtn.setAttribute('aria-pressed', albumBtn.classList.contains('active') ? 'true' : 'false');
  }
  if (cropBtn) {
    cropBtn.disabled = !activeMedia;
    cropBtn.title = activeMedia ? accentBackgroundControlsText('accent_recrop_bg') : accentBackgroundControlsText('accent_pick_media_first');
  }
  updateCustomBackgroundMediaPreview(activeMedia);
  applyBackgroundMediaHint();
}
function setCustomBackgroundColor(color, silent, customFlag) {
  fx.backgroundColor = normalizeHexColor(color || '#000000', '#000000');
  fx.backgroundColorMode = customFlag === false ? 'cover' : 'custom';
  fx.backgroundColorCustom = customFlag !== false;
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundColor' });
  if (!silent) showToast(accentBackgroundControlsText('bind_bg_color_prefix') + fx.backgroundColor.toUpperCase());
}
function setCustomBackgroundCoverMode(silent) {
  fx.backgroundColorMode = 'cover';
  fx.backgroundColorCustom = false;
  fx.backgroundColor = normalizeHexColor(fx.backgroundColor || fxDefaults.backgroundColor || '#000000', '#000000');
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundColorCover' });
  if (!silent) showToast(accentBackgroundControlsText('accent_bg_cover_gradient'));
}
function resetCustomBackgroundColor() {
  setCustomBackgroundCoverMode(false);
}
function setCustomBackgroundOpacity(value, silent) {
  fx.backgroundOpacity = clampRange(Number(value), 0, 1);
  fx.backgroundColorMode = 'custom';
  fx.backgroundColorCustom = true;
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundOpacity' });
  if (!silent) showToast(accentBackgroundControlsText('accent_bg_opacity_prefix') + Math.round(fx.backgroundOpacity * 100) + '%');
}
function setWindowBackgroundOpacity(value, silent) {
  fx.windowBackgroundOpacity = clampRange(Number(value), 0, 1);
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'windowBackgroundOpacity' });
  if (!silent) showToast(accentBackgroundControlsText('accent_window_opacity_prefix') + Math.round(fx.windowBackgroundOpacity * 100) + '%');
}
function setBackgroundGlassOpacity(value, silent) {
  fx.backgroundGlassOpacity = clampRange(Number(value), 0, 1);
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundGlassOpacity' });
  if (!silent) showToast(accentBackgroundControlsText('accent_frosted_opacity_prefix') + Math.round(fx.backgroundGlassOpacity * 100) + '%');
}
function setCustomBackgroundAlbumCover(enabled, silent) {
  fx.backgroundAlbumCover = enabled === true;
  if (fx.backgroundAlbumCover) {
    fx.backgroundMedia = null;
    fx.backgroundImage = '';
  }
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundAlbumCover' });
  if (!silent) showToast(fx.backgroundAlbumCover ? accentBackgroundControlsText('accent_bg_media_cover_original') : accentBackgroundControlsText('accent_bg_media_cover_off'));
}
function toggleCustomBackgroundAlbumCover() {
  setCustomBackgroundAlbumCover(!(typeof customBackgroundUsesAlbumCover === 'function' && customBackgroundUsesAlbumCover()));
}
function setCustomBackgroundCrop(key, value, silent) {
  var allowed = {
    backgroundMediaCropX: [0, 100, 50],
    backgroundMediaCropY: [0, 100, 50],
    backgroundMediaZoom: [1, 2.8, 1]
  };
  if (!allowed[key]) return;
  var meta = allowed[key];
  var next = clampRange(Number(value), meta[0], meta[1]);
  fx[key] = isFinite(next) ? next : meta[2];
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundMediaCrop' });
  if (!silent) showToast(accentBackgroundControlsText('accent_bg_crop_updated'));
}
function resetCustomBackgroundCrop() {
  fx.backgroundMediaCropX = fxDefaults.backgroundMediaCropX == null ? 50 : fxDefaults.backgroundMediaCropX;
  fx.backgroundMediaCropY = fxDefaults.backgroundMediaCropY == null ? 50 : fxDefaults.backgroundMediaCropY;
  fx.backgroundMediaZoom = fxDefaults.backgroundMediaZoom == null ? 1 : fxDefaults.backgroundMediaZoom;
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundMediaCrop' });
  showToast(accentBackgroundControlsText('accent_bg_crop_reset'));
}
function customBackgroundCropSnapshot() {
  return {
    x: customBackgroundCropNumber('backgroundMediaCropX', fxDefaults.backgroundMediaCropX == null ? 50 : fxDefaults.backgroundMediaCropX, 0, 100),
    y: customBackgroundCropNumber('backgroundMediaCropY', fxDefaults.backgroundMediaCropY == null ? 50 : fxDefaults.backgroundMediaCropY, 0, 100),
    zoom: customBackgroundCropNumber('backgroundMediaZoom', fxDefaults.backgroundMediaZoom == null ? 1 : fxDefaults.backgroundMediaZoom, 1, 2.8)
  };
}
function applyCustomBackgroundCropSnapshot(snapshot) {
  if (!snapshot) return;
  fx.backgroundMediaCropX = clampRange(Number(snapshot.x), 0, 100);
  fx.backgroundMediaCropY = clampRange(Number(snapshot.y), 0, 100);
  fx.backgroundMediaZoom = clampRange(Number(snapshot.zoom), 1, 2.8);
  updateCustomBackgroundControls();
  updateCustomBackgroundCropModalView();
}
function customBackgroundCropMediaSrc(media) {
  if (!media) return '';
  if (media.type === 'image') return media.src || '';
  if (media.type === 'video') {
    var activeVideo = document.getElementById('custom-bg-video');
    var activeSrc = activeVideo && (activeVideo.currentSrc || activeVideo.getAttribute('src')) || '';
    return activeSrc || media.src || '';
  }
  return '';
}
function bindCustomBackgroundCropModal() {
  if (customBackgroundCropModalBound) return;
  customBackgroundCropModalBound = true;
  var stage = document.getElementById('background-crop-stage');
  var zoom = document.getElementById('background-crop-zoom');
  if (!stage || !zoom) return;
  stage.addEventListener('pointerdown', function (e) {
    if (!customBackgroundCropModalState) return;
    e.preventDefault();
    customBackgroundCropModalState.dragging = true;
    customBackgroundCropModalState.lastX = e.clientX;
    customBackgroundCropModalState.lastY = e.clientY;
    stage.classList.add('dragging');
    if (stage.setPointerCapture) {
      try { stage.setPointerCapture(e.pointerId); } catch (err) { }
    }
  });
  stage.addEventListener('pointermove', function (e) {
    if (!customBackgroundCropModalState || !customBackgroundCropModalState.dragging) return;
    e.preventDefault();
    var rect = stage.getBoundingClientRect();
    var dx = e.clientX - customBackgroundCropModalState.lastX;
    var dy = e.clientY - customBackgroundCropModalState.lastY;
    customBackgroundCropModalState.lastX = e.clientX;
    customBackgroundCropModalState.lastY = e.clientY;
    var zoomFactor = Math.max(1, Number(fx.backgroundMediaZoom) || 1);
    var nextX = (Number(fx.backgroundMediaCropX) || 50) - (dx / Math.max(1, rect.width)) * 100 / zoomFactor;
    var nextY = (Number(fx.backgroundMediaCropY) || 50) - (dy / Math.max(1, rect.height)) * 100 / zoomFactor;
    applyCustomBackgroundCropSnapshot({ x: nextX, y: nextY, zoom: zoomFactor });
  });
  function stopDrag() {
    if (!customBackgroundCropModalState) return;
    customBackgroundCropModalState.dragging = false;
    stage.classList.remove('dragging');
  }
  stage.addEventListener('pointerup', stopDrag);
  stage.addEventListener('pointercancel', stopDrag);
  stage.addEventListener('wheel', function (e) {
    if (!customBackgroundCropModalState) return;
    e.preventDefault();
    var current = customBackgroundCropSnapshot();
    current.zoom = clampRange(current.zoom + (e.deltaY < 0 ? 0.08 : -0.08), 1, 2.8);
    applyCustomBackgroundCropSnapshot(current);
  }, { passive: false });
  zoom.addEventListener('input', function () {
    if (!customBackgroundCropModalState) return;
    var current = customBackgroundCropSnapshot();
    current.zoom = clampRange(Number(zoom.value) || 1, 1, 2.8);
    applyCustomBackgroundCropSnapshot(current);
  });
}
function updateCustomBackgroundCropModalView() {
  var snapshot = customBackgroundCropSnapshot();
  var zoom = document.getElementById('background-crop-zoom');
  if (zoom) zoom.value = snapshot.zoom;
  ['background-crop-stage', 'background-crop-preview'].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.style.setProperty('--bg-crop-modal-x', snapshot.x.toFixed(1) + '%');
    el.style.setProperty('--bg-crop-modal-y', snapshot.y.toFixed(1) + '%');
    el.style.setProperty('--bg-crop-modal-zoom', snapshot.zoom.toFixed(3));
  });
}
function releaseCustomBackgroundCropModalObjectUrl() {
  if (customBackgroundCropModalObjectUrl) {
    URL.revokeObjectURL(customBackgroundCropModalObjectUrl);
    customBackgroundCropModalObjectUrl = '';
  }
}
function setCustomBackgroundCropModalSource(media, src) {
  var stage = document.getElementById('background-crop-stage');
  var preview = document.getElementById('background-crop-preview');
  var img = document.getElementById('background-crop-img');
  var video = document.getElementById('background-crop-video');
  var previewImg = document.getElementById('background-crop-preview-img');
  var previewVideo = document.getElementById('background-crop-preview-video');
  [stage, preview].forEach(function (el) {
    if (!el) return;
    el.classList.toggle('media-image', media && media.type === 'image');
    el.classList.toggle('media-video', media && media.type === 'video');
  });
  if (img) img.removeAttribute('src');
  if (previewImg) previewImg.removeAttribute('src');
  [video, previewVideo].forEach(function (el) {
    if (!el) return;
    el.pause();
    el.removeAttribute('src');
    el.load();
  });
  if (!src) return;
  if (media.type === 'image') {
    if (img) img.src = src;
    if (previewImg) previewImg.src = src;
  } else if (media.type === 'video') {
    [video, previewVideo].forEach(function (el) {
      if (!el) return;
      el.src = src;
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      var p = el.play();
      if (p && p.catch) p.catch(function () { });
    });
  }
}
function openCustomBackgroundCropModal() {
  var media = customBackgroundActiveMedia();
  if (!media) {
    showToast(accentBackgroundControlsText('accent_pick_media_first'));
    return;
  }
  bindCustomBackgroundCropModal();
  var modal = document.getElementById('background-crop-modal');
  if (!modal) return;
  releaseCustomBackgroundCropModalObjectUrl();
  customBackgroundCropModalState = {
    media: media,
    original: customBackgroundCropSnapshot(),
    dragging: false,
    lastX: 0,
    lastY: 0
  };
  var src = customBackgroundCropMediaSrc(media);
  if (media.type === 'video' && !src && media.id) {
    getCustomBackgroundBlob(media.id).then(function (blob) {
      if (!customBackgroundCropModalState || customBackgroundCropModalState.media !== media || !blob) return;
      releaseCustomBackgroundCropModalObjectUrl();
      customBackgroundCropModalObjectUrl = URL.createObjectURL(blob);
      setCustomBackgroundCropModalSource(media, customBackgroundCropModalObjectUrl);
    }).catch(function () { showToast(accentBackgroundControlsText('accent_bg_video_load_failed')); });
  } else {
    setCustomBackgroundCropModalSource(media, src);
  }
  updateCustomBackgroundCropModalView();
  openGsapModal(modal);
  var stage = document.getElementById('background-crop-stage');
  if (stage && window.gsap) window.gsap.fromTo(stage, { scale: 0.985 }, { scale: 1, duration: 0.72, ease: 'expo.out', overwrite: true });
}
function closeCustomBackgroundCropModal(restoreOriginal) {
  var modal = document.getElementById('background-crop-modal');
  var original = customBackgroundCropModalState && customBackgroundCropModalState.original;
  if (restoreOriginal && original) applyCustomBackgroundCropSnapshot(original);
  closeGsapModal(modal, function () {
    setCustomBackgroundCropModalSource({ type: 'image' }, '');
    releaseCustomBackgroundCropModalObjectUrl();
    customBackgroundCropModalState = null;
  });
}
function cancelCustomBackgroundCropModal() {
  closeCustomBackgroundCropModal(true);
}
function resetCustomBackgroundCropInModal() {
  applyCustomBackgroundCropSnapshot({
    x: fxDefaults.backgroundMediaCropX == null ? 50 : fxDefaults.backgroundMediaCropX,
    y: fxDefaults.backgroundMediaCropY == null ? 50 : fxDefaults.backgroundMediaCropY,
    zoom: fxDefaults.backgroundMediaZoom == null ? 1 : fxDefaults.backgroundMediaZoom
  });
}
function commitCustomBackgroundCropModal() {
  saveLyricLayout({ user: true, reason: 'backgroundMediaCrop' });
  showToast(accentBackgroundControlsText('accent_bg_crop_updated'));
  closeCustomBackgroundCropModal(false);
}
function openCustomBackgroundCropModalSoon() {
  setTimeout(function () {
    if (customBackgroundActiveMedia()) openCustomBackgroundCropModal();
  }, 80);
}
function setCustomBackgroundImage(src, silent) {
  var image = normalizeCustomBackgroundImage(src);
  fx.backgroundImage = image;
  fx.backgroundMedia = image ? { type: 'image', src: image } : null;
  fx.backgroundAlbumCover = false;
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundImage' });
  if (!silent) showToast(fx.backgroundImage ? accentBackgroundControlsText('accent_bg_image_applied') : accentBackgroundControlsText('accent_bg_image_cleared'));
}
function clearCustomBackgroundImage() {
  setCustomBackgroundImage('');
}
function setCustomBackgroundMedia(media, silent) {
  media = normalizeCustomBackgroundMedia(media);
  if (media && media.type === 'album') {
    setCustomBackgroundAlbumCover(true, silent);
    return;
  }
  fx.backgroundMedia = media;
  fx.backgroundImage = media && media.type === 'image' ? media.src : '';
  fx.backgroundAlbumCover = false;
  updateCustomBackgroundControls();
  saveLyricLayout({ user: true, reason: 'backgroundMedia' });
  if (!silent) showToast(media ? (media.type === 'video' ? accentBackgroundControlsText('accent_bg_video_applied') : accentBackgroundControlsText('accent_bg_image_applied')) : accentBackgroundControlsText('accent_bg_media_cleared'));
}
function readBackgroundImageFile(file) {
  if (!file || !/^image\//i.test(file.type || '')) {
    showToast(accentBackgroundControlsText('accent_pick_image'));
    return;
  }
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var maxSide = 2200;
      var iw = img.naturalWidth || img.width || 1;
      var ih = img.naturalHeight || img.height || 1;
      var scale = Math.min(1, maxSide / Math.max(iw, ih));
      var w = Math.max(1, Math.round(iw * scale));
      var h = Math.max(1, Math.round(ih * scale));
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0, w, h);
      var out = '';
      try { out = cv.toDataURL('image/webp', 0.84); } catch (err) { }
      if (!/^data:image\/webp/i.test(out)) {
        try { out = cv.toDataURL('image/jpeg', 0.86); } catch (err2) { out = String(e.target.result || ''); }
      }
      setCustomBackgroundImage(out);
      openCustomBackgroundCropModalSoon();
    };
    img.onerror = function () { showToast(accentBackgroundControlsText('accent_bg_image_load_failed')); };
    img.src = e.target.result;
  };
  reader.onerror = function () { showToast(accentBackgroundControlsText('accent_bg_image_load_failed')); };
  reader.readAsDataURL(file);
}
function readBackgroundVideoFile(file) {
  if (!file || !/^video\//i.test(file.type || '')) {
    showToast(accentBackgroundControlsText('accent_pick_video'));
    return;
  }
  var id = 'bg-video-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  putCustomBackgroundBlob(id, file, { name: file.name || '', mime: file.type || '', size: file.size || 0 }).then(function () {
    setCustomBackgroundMedia({ type: 'video', id: id, name: file.name || '', mime: file.type || '', size: file.size || 0 });
    openCustomBackgroundCropModalSoon();
  }).catch(function (err) {
    console.warn('background video store failed:', err);
    if ((file.size || 0) > 18 * 1024 * 1024) {
      showToast(accentBackgroundControlsText('accent_video_too_large'));
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      setCustomBackgroundMedia({ type: 'video', src: String(e.target.result || ''), name: file.name || '', mime: file.type || '', size: file.size || 0 });
      openCustomBackgroundCropModalSoon();
    };
    reader.onerror = function () { showToast(accentBackgroundControlsText('accent_bg_video_load_failed')); };
    reader.readAsDataURL(file);
  });
}
function readBackgroundMediaFile(file) {
  if (!file) return;
  if (/^image\//i.test(file.type || '')) readBackgroundImageFile(file);
  else if (/^video\//i.test(file.type || '')) readBackgroundVideoFile(file);
  else showToast(accentBackgroundControlsText('accent_pick_image_video'));
}
function defaultUiAccentColor() {
  return normalizeHexColor(fxDefaults.uiAccentColor || '#ffffff', '#ffffff');
}
function applyUiAccentColor() {
  var fallback = defaultUiAccentColor();
  var color = normalizeHexColor(fx.uiAccentColor || fallback, fallback);
  var rgb = hexToRgb(color);
  var root = document.documentElement;
  root.style.setProperty('--fc-accent', color);
  root.style.setProperty('--fc-accent-hov', color);
  root.style.setProperty('--fc-accent-rgb', rgb.r + ',' + rgb.g + ',' + rgb.b);
  root.style.setProperty('--glass-border', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.30)');
  root.style.setProperty('--glass-shadow-focus', '0 24px 72px rgba(0,0,0,.34),0 0 0 1px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.13),0 0 42px rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.075),inset 0 1px 0 rgba(255,255,255,.20)');
}
function updateUiAccentControls() {
  applyUiAccentColor();
  var fallback = defaultUiAccentColor();
  var color = normalizeHexColor(fx.uiAccentColor || fallback, fallback);
  var picker = document.getElementById('ui-accent-picker');
  var value = document.getElementById('ui-accent-value');
  if (picker) picker.value = color;
  if (value) value.textContent = color.toUpperCase();
}
function setUiAccentColor(color, silent) {
  var fallback = defaultUiAccentColor();
  fx.uiAccentColor = normalizeHexColor(color || fallback, fallback);
  updateUiAccentControls();
  if (shelfManager && shelfManager.refreshTheme) shelfManager.refreshTheme();
  saveLyricLayout({ user: true, reason: 'uiAccentColor' });
  if (!silent) showToast(accentBackgroundControlsText('bind_ui_highlight_prefix') + fx.uiAccentColor.toUpperCase());
}
function resetUiAccentColor() {
  setUiAccentColor(defaultUiAccentColor());
}
function updateVisualTintControls() {
  var picker = document.getElementById('visual-tint-picker');
  var value = document.getElementById('visual-tint-value');
  var autoBtn = document.getElementById('visual-tint-auto-btn');
  var color = normalizeHexColor(fx.visualTintColor || '#9db8cf');
  document.documentElement.style.setProperty('--visual-tint', color);
  if (picker) picker.value = color;
  if (value) value.textContent = fx.visualTintMode === 'custom' ? color.toUpperCase() : accentBackgroundControlsText('cover_pick_color', '封面取色');
  if (autoBtn) autoBtn.classList.toggle('active', fx.visualTintMode !== 'custom');
}
function setVisualTintAuto() {
  fx.visualTintMode = 'auto';
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout({ user: true, reason: 'visualTintAuto' });
  showToast(accentBackgroundControlsText('accent_primary_cover'));
}
function resetVisualTintColor() {
  fx.visualTintMode = 'auto';
  fx.visualTintColor = normalizeHexColor(fxDefaults.visualTintColor || '#9db8cf');
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout({ user: true, reason: 'visualTintReset' });
  showToast(accentBackgroundControlsText('accent_primary_restored'));
}
function setVisualTintCustom(color, silent) {
  fx.visualTintMode = 'custom';
  fx.visualTintColor = normalizeHexColor(color || '#9db8cf');
  updateVisualTintControls();
  syncFxUniforms();
  saveLyricLayout({ user: true, reason: 'visualTintColor' });
  if (!silent) showToast(accentBackgroundControlsText('bind_visual_primary_prefix') + fx.visualTintColor.toUpperCase());
}

function sonicGroundColorControls() {
  return [
  { key: 'sonicGroundBaseColor', picker: 'sonic-ground-base-picker', value: 'sonic-ground-base-value', label: accentBackgroundControlsText('fx_terrain_shadow') },
  { key: 'sonicGroundCoolColor', picker: 'sonic-ground-cool-picker', value: 'sonic-ground-cool-value', label: accentBackgroundControlsText('fx_cool_peak') },
  { key: 'sonicGroundWarmColor', picker: 'sonic-ground-warm-picker', value: 'sonic-ground-warm-value', label: accentBackgroundControlsText('fx_warm_peak') },
  { key: 'sonicGroundAccentColor', picker: 'sonic-ground-accent-picker', value: 'sonic-ground-accent-value', label: accentBackgroundControlsText('fx_ripple_highlight') }
  ];
}
function sonicGroundColorControl(key) {
  for (var i = 0; i < sonicGroundColorControls().length; i++) {
    if (sonicGroundColorControls()[i].key === key || sonicGroundColorControls()[i].picker === key) return sonicGroundColorControls()[i];
  }
  return null;
}
function sonicHexRgb(hex, fallback) {
  hex = normalizeHexColor(hex || fallback || '#ffffff', fallback || '#ffffff').slice(1);
  var n = parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function sonicMixHex(a, b, t) {
  var ca = sonicHexRgb(a, '#000000');
  var cb = sonicHexRgb(b, '#ffffff');
  t = clampRange(Number(t) || 0, 0, 1);
  return '#' + [ca.r + (cb.r - ca.r) * t, ca.g + (cb.g - ca.g) * t, ca.b + (cb.b - ca.b) * t].map(function (v) {
    return Math.round(clampRange(v, 0, 255)).toString(16).padStart(2, '0');
  }).join('');
}
function sonicPaletteHex(value, fallback, minLum) {
  if (typeof lyricPaletteColorToHex === 'function') return lyricPaletteColorToHex(value, fallback, minLum);
  return normalizeHexColor(value || fallback, fallback);
}
function sonicRawPaletteHex(value, fallback) {
  fallback = normalizeHexColor(fallback || '#ffffff', '#ffffff');
  value = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3,6}$/.test(value)) return normalizeHexColor(value, fallback);
  var m = value.match(/^rgba?\(\s*([.\d]+)\s*,\s*([.\d]+)\s*,\s*([.\d]+)/i);
  if (m) {
    return '#' + [m[1], m[2], m[3]].map(function (part) {
      var n = Math.round(clampRange(parseFloat(part) || 0, 0, 255));
      return n.toString(16).padStart(2, '0');
    }).join('');
  }
  return fallback;
}
function sonicGroundCoverPreviewColors() {
  var pal = stageLyrics && (stageLyrics.coverPalette || stageLyrics.palette) || {};
  var primary = sonicPaletteHex(pal.primary || pal.secondary || pal.highlight, '#33e6ff', 0.42);
  var secondary = sonicPaletteHex(pal.secondary || pal.primary || pal.highlight, '#7fd8ff', 0.40);
  var highlight = sonicPaletteHex(pal.highlight || pal.primary || pal.secondary, '#ffd070', 0.48);
  return {
    sonicGroundBaseColor: sonicMixHex('#05070c', primary, 0.12),
    sonicGroundCoolColor: primary,
    sonicGroundWarmColor: highlight,
    sonicGroundAccentColor: secondary
  };
}
function updateSonicGroundColorControls() {
  var customMode = fx.sonicGroundColorMode === 'custom';
  var coverPreview = customMode ? null : sonicGroundCoverPreviewColors();
  sonicGroundColorControls().forEach(function (item) {
    var fallback = fxDefaults[item.key] || '#33e6ff';
    var color = customMode ? normalizeHexColor(fx[item.key] || fallback, fallback) : normalizeHexColor(coverPreview[item.key] || fallback, fallback);
    var picker = document.getElementById(item.picker);
    var value = document.getElementById(item.value);
    if (picker) picker.value = color;
    if (value && !customMode) value.textContent = accentBackgroundControlsText('accent_cover_prefix') + color.toUpperCase();
    if (value) value.textContent = customMode ? color.toUpperCase() : accentBackgroundControlsText('cover_pick_color', '封面取色');
  });
  if (!customMode) {
    sonicGroundColorControls().forEach(function (item) {
      var fallback = fxDefaults[item.key] || '#33e6ff';
      var color = normalizeHexColor((coverPreview && coverPreview[item.key]) || fallback, fallback);
      var value = document.getElementById(item.value);
      if (value) value.textContent = accentBackgroundControlsText('accent_cover_prefix') + color.toUpperCase();
    });
  }
}
function setSonicGroundColor(key, color, silent) {
  var item = sonicGroundColorControl(key);
  if (!item) return;
  var fallback = fxDefaults[item.key] || '#33e6ff';
  fx.sonicGroundColorMode = 'custom';
  fx[item.key] = normalizeHexColor(color || fallback, fallback);
  updateSonicGroundColorControls();
  syncFxUniforms();
  saveLyricLayout({ user: true, reason: item.key });
  if (!silent) showToast(item.label + ': ' + fx[item.key].toUpperCase());
}
function resetSonicGroundColor(key) {
  var item = sonicGroundColorControl(key);
  if (!item) return;
  fx.sonicGroundColorMode = 'cover';
  sonicGroundColorControls().forEach(function (control) {
    fx[control.key] = normalizeHexColor(fxDefaults[control.key] || '#33e6ff', '#33e6ff');
  });
  updateSonicGroundColorControls();
  syncFxUniforms();
  saveLyricLayout({ user: true, reason: 'sonicGroundColorAuto' });
  showToast(accentBackgroundControlsText('accent_soundfield_cover'));
}
function setSonicGroundColorFromPicker(pickerId, color, silent) {
  var item = sonicGroundColorControl(pickerId);
  if (item) setSonicGroundColor(item.key, color, silent);
}

var SONIC_WORKSHOP_THEME_ALIASES = {
  'minimal-mono': 'minimal-monochrome',
  'arctic-blue': 'arctic-aurora',
  'emerald-forest': 'cyber-forest',
  crimson: 'crimson-sunset',
  aurora: 'arctic-aurora',
  'violet-dream': 'neon-tokyo'
};
function sonicWorkshopThemes() {
  return {
  'coral-mirage': { label: accentBackgroundControlsText('accent_coral'), color: '#cb6c89', base: '#16060f', warm: '#cb6c89', cool: '#99c4ff', ripple: '#f8d8ff', peak: '#99c4ff' },
  'ocean-deep': { label: accentBackgroundControlsText('accent_deep_sea'), color: '#1b6fb8', base: '#031025', warm: '#2e8ed4', cool: '#7fdcff', ripple: '#b7f5ff', peak: '#80b8ff' },
  'arctic-aurora': { label: accentBackgroundControlsText('accent_ice_blue'), color: '#79e1c4', base: '#05161d', warm: '#79e1c4', cool: '#99c4ff', ripple: '#e6fbff', peak: '#b7e6ff' },
  'cyber-forest': { label: accentBackgroundControlsText('accent_emerald'), color: '#3fc78a', base: '#04150d', warm: '#3fc78a', cool: '#74f5ff', ripple: '#b9ffd8', peak: '#d1ffe9' },
  'minimal-monochrome': { label: accentBackgroundControlsText('accent_minimal'), color: '#d9dde3', base: '#0b0c0e', warm: '#d9dde3', cool: '#ffffff', ripple: '#ffffff', peak: '#f2f5f8' },
  'neon-tokyo': { label: accentBackgroundControlsText('accent_neon'), color: '#ff4fb8', base: '#100018', warm: '#ff4fb8', cool: '#39d7ff', ripple: '#ffd6f2', peak: '#e8ff6e' },
  'golden-hour': { label: accentBackgroundControlsText('accent_gold'), color: '#e8b44c', base: '#160d02', warm: '#e8b44c', cool: '#89c8ff', ripple: '#fff0b8', peak: '#ffffff' },
  'ember-fire': { label: accentBackgroundControlsText('accent_fire'), color: '#f27a28', base: '#180603', warm: '#f27a28', cool: '#76c8ff', ripple: '#ffd2a1', peak: '#fff2cf' },
  'crimson-sunset': { label: accentBackgroundControlsText('accent_crimson'), color: '#d84252', base: '#180307', warm: '#d84252', cool: '#8ec7ff', ripple: '#ffd5df', peak: '#fff1f4' }
  }
}
function sonicWorkshopColorControls() {
  return [
  { id: 'theme', role: 'primary', modeKey: 'sonicWorkshopColorMode', colorKey: 'sonicWorkshopCustomColor', picker: 'sonic-workshop-cover-picker', value: 'sonic-workshop-theme-value', button: 'sonic-workshop-cover-btn', fallback: '#cb6c89', label: accentBackgroundControlsText('accent_theme_base') },
  { id: 'base', role: 'base', modeKey: 'sonicWorkshopBaseColorMode', colorKey: 'sonicWorkshopBaseColor', picker: 'sonic-workshop-base-picker', value: 'sonic-workshop-base-value', button: 'sonic-workshop-base-btn', fallback: '#16060f', label: accentBackgroundControlsText('fx_we_terrain_base') },
  { id: 'warm', role: 'warm', modeKey: 'sonicWorkshopWarmColorMode', colorKey: 'sonicWorkshopWarmColor', picker: 'sonic-workshop-warm-picker', value: 'sonic-workshop-warm-value', button: 'sonic-workshop-warm-btn', fallback: '#cb6c89', label: accentBackgroundControlsText('fx_we_warm_body') },
  { id: 'cool', role: 'cool', modeKey: 'sonicWorkshopCoolColorMode', colorKey: 'sonicWorkshopCoolColor', picker: 'sonic-workshop-cool-picker', value: 'sonic-workshop-cool-value', button: 'sonic-workshop-cool-btn', fallback: '#99c4ff', label: accentBackgroundControlsText('fx_we_upper_highlight') },
  { id: 'ripple', role: 'ripple', modeKey: 'sonicWorkshopRippleColorMode', colorKey: 'sonicWorkshopRippleColor', picker: 'sonic-workshop-ripple-picker', value: 'sonic-workshop-ripple-value', button: 'sonic-workshop-ripple-btn', fallback: '#f8d8ff', label: accentBackgroundControlsText('fx_we_ripple_bright') },
  { id: 'peak', role: 'peak', modeKey: 'sonicWorkshopPeakColorMode', colorKey: 'sonicWorkshopPeakColor', picker: 'sonic-workshop-peak-picker', value: 'sonic-workshop-peak-value', button: 'sonic-workshop-peak-btn', fallback: '#99c4ff', label: accentBackgroundControlsText('fx_we_peak_highlight') }
  ];
}
var sonicWorkshopCoverUiSample = {
  key: '',
  palette: null,
  loading: false,
  refreshing: false,
  token: 0
};
function normalizeSonicWorkshopTheme(theme) {
  theme = String(theme || '');
  theme = SONIC_WORKSHOP_THEME_ALIASES[theme] || theme;
  return sonicWorkshopThemes()[theme] ? theme : (fxDefaults.sonicWorkshopTheme || 'coral-mirage');
}
function sonicWorkshopRegionControl(id) {
  if (id && typeof id === 'object' && id.id) return id;
  for (var i = 0; i < sonicWorkshopColorControls().length; i++) {
    var item = sonicWorkshopColorControls()[i];
    if (item.id === id || item.role === id || item.picker === id || item.colorKey === id || item.modeKey === id) return item;
  }
  return null;
}
function sonicWorkshopCurrentSong() {
  if (Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length) return playQueue[currentIdx];
  if (Array.isArray(playlist) && currentIdx >= 0 && currentIdx < playlist.length) return playlist[currentIdx];
  return null;
}
function sonicWorkshopCurrentCoverKey() {
  try {
    var domSrc = sonicWorkshopCurrentCoverDomSource();
    if (domSrc) return String(domSrc);
    var song = sonicWorkshopCurrentSong();
    if (!song) return '';
    if (typeof songCoverSrc === 'function') return String(songCoverSrc(song, 400) || song.cover || song.id || '');
    return String(song.customCover || song.cover || song.id || song.name || '');
  } catch (e) {
    return '';
  }
}
function sonicWorkshopCurrentCoverDomSource() {
  try {
    if (typeof currentCoverSource !== 'undefined' && currentCoverSource && currentCoverSource.src) return String(currentCoverSource.src || '');
  } catch (e) { }
  try {
    var thumb = document.getElementById('thumb-cover');
    var thumbSrc = thumb && (thumb.currentSrc || thumb.src || thumb.getAttribute('src'));
    if (thumbSrc) return String(thumbSrc);
  } catch (e) { }
  try {
    var bg = document.getElementById('album-bg');
    var style = bg && window.getComputedStyle ? window.getComputedStyle(bg).backgroundImage : '';
    var m = style && style.match(/url\(["']?(.+?)["']?\)/i);
    if (m && m[1]) return m[1];
  } catch (e) { }
  return '';
}
function sonicWorkshopCurrentCoverSampleSrc() {
  var domSrc = sonicWorkshopCurrentCoverDomSource();
  if (domSrc) {
    if (/^data:image\//i.test(domSrc) || /^blob:/i.test(domSrc) || /^\/api\/cover\?/i.test(domSrc) || /^https?:\/\/[^/]+\/api\/cover\?/i.test(domSrc)) return domSrc;
    if (typeof coverProxySrc === 'function') return coverProxySrc(domSrc, false) || domSrc;
    return domSrc;
  }
  var song = sonicWorkshopCurrentSong();
  if (!song) return '';
  var src = '';
  try {
    src = typeof songCoverSrc === 'function' ? songCoverSrc(song, 256) : (song.customCover || song.cover || '');
  } catch (e) {
    src = song.customCover || song.cover || '';
  }
  if (!src) return '';
  if (/^data:image\//i.test(src) || /^blob:/i.test(src) || /^\/api\/cover\?/i.test(src)) return src;
  if (typeof coverProxySrc === 'function') return coverProxySrc(src, false) || src;
  return src;
}
function sonicWorkshopCssFromSample(sample, fallback) {
  if (!sample) return fallback || '#cb6c89';
  if (typeof lyricCoverSampleCss === 'function') return lyricCoverSampleCss(sample, fallback || '#cb6c89');
  return '#' + ['r', 'g', 'b'].map(function (key) {
    return Math.round(clampRange(Number(sample[key]) || 0, 0, 255)).toString(16).padStart(2, '0');
  }).join('');
}
function buildSonicWorkshopUiPaletteFromCanvas(canvas, key) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  try {
    var ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h).data;
    var buckets = {};
    var count = 0;
    var sumR = 0, sumG = 0, sumB = 0;
    var fallbackList = [];
    var step = Math.max(2, Math.floor(Math.max(w, h) / 96));
    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        var di = (y * w + x) * 4;
        var a = img[di + 3] / 255;
        if (a < 0.5) continue;
        var r = img[di], g = img[di + 1], b = img[di + 2];
        count++;
        sumR += r; sumG += g; sumB += b;
        if (typeof lyricCoverAddAreaBucket === 'function') lyricCoverAddAreaBucket(buckets, r, g, b);
        else fallbackList.push({ r: r, g: g, b: b, score: 1 });
      }
    }
    if (!count) return null;
    var areaPalette = typeof lyricCoverAreaPaletteFromBuckets === 'function'
      ? lyricCoverAreaPaletteFromBuckets(buckets)
      : null;
    if (!areaPalette) {
      fallbackList.sort(function (a, b) { return b.score - a.score; });
      areaPalette = {
        primary: fallbackList[0],
        base: fallbackList[0],
        warm: fallbackList[0],
        cool: fallbackList[0],
        light: fallbackList[0],
        accent: fallbackList[0],
        colors: []
      };
    }
    var avg = {
      r: Math.round(sumR / count),
      g: Math.round(sumG / count),
      b: Math.round(sumB / count),
      score: count
    };
    var palette = {
      rawAreaPrimary: sonicWorkshopCssFromSample(areaPalette.primary, '#cb6c89'),
      rawAreaBase: sonicWorkshopCssFromSample(areaPalette.base, '#16060f'),
      rawAreaWarm: sonicWorkshopCssFromSample(areaPalette.warm, '#cb6c89'),
      rawAreaCool: sonicWorkshopCssFromSample(areaPalette.cool, '#99c4ff'),
      rawAreaLight: sonicWorkshopCssFromSample(areaPalette.light, '#f8d8ff'),
      rawAreaAccent: sonicWorkshopCssFromSample(areaPalette.accent, '#99c4ff'),
      rawAverage: sonicWorkshopCssFromSample(avg, '#cb6c89'),
      sonicWorkshopColors: Array.isArray(areaPalette.colors) ? areaPalette.colors.slice(0, 10) : [],
      coverColors: [],
      coverSourceKey: key || '',
      sonicWorkshopCoverKey: key || ''
    };
    [
      palette.rawAreaPrimary,
      palette.rawAreaBase,
      palette.rawAreaWarm,
      palette.rawAreaCool,
      palette.rawAreaLight,
      palette.rawAreaAccent,
      palette.rawAverage
    ].forEach(function (color) {
      if (typeof lyricCoverPushUniqueColor === 'function') lyricCoverPushUniqueColor(palette.coverColors, color);
      else if (palette.coverColors.indexOf(color) < 0) palette.coverColors.push(color);
    });
    return palette;
  } catch (e) {
    return null;
  }
}
function sonicWorkshopPaletteLooksCurrent(pal, key) {
  if (!pal) return false;
  var hasArea = !!(pal.rawAreaPrimary || pal.rawPrimary || pal.sonicWorkshopColors && pal.sonicWorkshopColors.length);
  if (!hasArea) return false;
  var palKey = String(pal.sonicWorkshopCoverKey || pal.coverSourceKey || '');
  if (key && !palKey) return false;
  if (!key || !palKey) return true;
  return palKey === key;
}
function sonicWorkshopUiPaletteForKey(key) {
  var pal = sonicWorkshopCoverUiSample.palette;
  return sonicWorkshopPaletteLooksCurrent(pal, key || sonicWorkshopCurrentCoverKey()) ? pal : null;
}
function applySonicWorkshopCoverCanvasForUi(canvas, key) {
  if (!canvas) return false;
  if (sonicWorkshopCoverUiSample.refreshing) return false;
  sonicWorkshopCoverUiSample.refreshing = true;
  try {
    var uiPalette = buildSonicWorkshopUiPaletteFromCanvas(canvas, key);
    if (uiPalette) {
      sonicWorkshopCoverUiSample.palette = uiPalette;
      if (typeof stageLyrics !== 'undefined' && stageLyrics) {
        stageLyrics.coverPalette = Object.assign({}, stageLyrics.coverPalette || {}, uiPalette);
      }
    }
    if (typeof updateLyricPaletteFromCover === 'function') updateLyricPaletteFromCover(canvas);
    if (stageLyrics && stageLyrics.coverPalette) {
      if (uiPalette) stageLyrics.coverPalette = Object.assign({}, stageLyrics.coverPalette, uiPalette);
      stageLyrics.coverPalette.sonicWorkshopCoverKey = key || stageLyrics.coverPalette.sonicWorkshopCoverKey || '';
      stageLyrics.coverPalette.coverSourceKey = key || stageLyrics.coverPalette.coverSourceKey || '';
    }
    sonicWorkshopCoverUiSample.key = key || sonicWorkshopCoverUiSample.key || '';
    return !!uiPalette || !!(stageLyrics && stageLyrics.coverPalette);
  } catch (e) {
    console.warn('sonic workshop cover UI palette failed:', e);
    return false;
  } finally {
    sonicWorkshopCoverUiSample.refreshing = false;
  }
}
function ensureSonicWorkshopCoverPaletteForUi() {
  if (sonicWorkshopCoverUiSample.refreshing) return;
  var pal = stageLyrics && (stageLyrics.coverPalette || stageLyrics.palette) || {};
  var key = sonicWorkshopCurrentCoverKey();
  if (sonicWorkshopUiPaletteForKey(key)) return;
  if (sonicWorkshopPaletteLooksCurrent(pal, key)) return;
  if (typeof coverPickerCanvas !== 'undefined' && coverPickerCanvas) {
    if (applySonicWorkshopCoverCanvasForUi(coverPickerCanvas, key)) return;
  }
  var src = sonicWorkshopCurrentCoverSampleSrc();
  if (!src || sonicWorkshopCoverUiSample.loading && sonicWorkshopCoverUiSample.key === key) return;
  var token = ++sonicWorkshopCoverUiSample.token;
  sonicWorkshopCoverUiSample.loading = true;
  sonicWorkshopCoverUiSample.key = key;
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = function () {
    if (token !== sonicWorkshopCoverUiSample.token) return;
    sonicWorkshopCoverUiSample.loading = false;
    var size = 96;
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var cx = cv.getContext('2d');
    var iw = img.naturalWidth || img.width || size;
    var ih = img.naturalHeight || img.height || size;
    var crop = Math.min(iw, ih);
    try {
      cx.drawImage(img, (iw - crop) / 2, (ih - crop) / 2, crop, crop, 0, 0, size, size);
      applySonicWorkshopCoverCanvasForUi(cv, key);
      updateSonicWorkshopColorControls();
      if (window.MineradioSonicWorkshop && typeof MineradioSonicWorkshop.pushProperties === 'function') MineradioSonicWorkshop.pushProperties(true);
    } catch (e) {
      console.warn('sonic workshop cover UI sample failed:', e);
    }
  };
  img.onerror = function () {
    if (token !== sonicWorkshopCoverUiSample.token) return;
    sonicWorkshopCoverUiSample.loading = false;
  };
  img.src = src;
}
function sonicWorkshopPaletteForUi() {
  return sonicWorkshopUiPaletteForKey(sonicWorkshopCurrentCoverKey()) || stageLyrics && (stageLyrics.coverPalette || stageLyrics.palette) || {};
}
function sonicWorkshopCoverHex(role) {
  var pal = sonicWorkshopPaletteForUi();
  role = String(role || 'primary');
  var fallback = role === 'base' ? '#16060f' : (role === 'cool' || role === 'peak' ? '#99c4ff' : (role === 'ripple' ? '#f8d8ff' : '#cb6c89'));
  var value = pal.rawAreaPrimary || pal.rawPrimary || pal.primary || pal.highlight || pal.secondary;
  if (role === 'base') value = pal.rawAreaBase || pal.rawDark || pal.rawAverage || pal.secondary || pal.rawAreaPrimary || pal.rawPrimary || pal.primary;
  else if (role === 'warm') value = pal.rawAreaWarm || pal.rawAreaPrimary || pal.rawWarm || pal.rawPrimary || pal.secondary || pal.primary || pal.highlight;
  else if (role === 'cool') value = pal.rawAreaCool || pal.rawAreaLight || pal.rawCool || pal.rawLight || pal.highlight || pal.rawAreaPrimary || pal.rawPrimary || pal.primary;
  else if (role === 'ripple') value = pal.rawAreaLight || pal.rawAreaAccent || pal.rawLight || pal.rawAccent || pal.rawAreaCool || pal.rawCool || pal.highlight || pal.primary;
  else if (role === 'peak') value = pal.rawAreaAccent || pal.rawAreaCool || pal.rawAreaLight || pal.rawCool || pal.rawAccent || pal.rawLight || pal.highlight || pal.primary;
  return sonicRawPaletteHex(value, fallback);
}
function sonicWorkshopThemeForColor(hex) {
  var rgb = sonicHexRgb(hex, '#cb6c89');
  var hsl = typeof rgbToHsl === 'function' ? rgbToHsl(rgb.r, rgb.g, rgb.b) : { h: 0, s: 0.5, l: 0.5 };
  if (hsl.s < 0.08) return 'minimal-monochrome';
  if (hsl.h < 0.035 || hsl.h >= 0.94) return 'crimson-sunset';
  if (hsl.h < 0.10) return 'coral-mirage';
  if (hsl.h < 0.14) return 'ember-fire';
  if (hsl.h < 0.18) return 'golden-hour';
  if (hsl.h < 0.42) return 'cyber-forest';
  if (hsl.h < 0.66) return 'arctic-aurora';
  if (hsl.h < 0.74) return 'ocean-deep';
  return 'neon-tokyo';
}
function currentSonicWorkshopTheme() {
  if (fx.sonicWorkshopColorMode === 'custom') return normalizeSonicWorkshopTheme(fx.sonicWorkshopTheme);
  return sonicWorkshopThemeForColor(sonicWorkshopCoverHex('primary'));
}
function sonicWorkshopRegionHex(item) {
  item = sonicWorkshopRegionControl(item);
  if (!item) return '#cb6c89';
  var fallback = item.fallback || '#cb6c89';
  if (fx[item.modeKey] === 'custom') return normalizeHexColor(fx[item.colorKey] || fallback, fallback);
  return normalizeHexColor(sonicWorkshopCoverHex(item.role), fallback);
}
function updateSonicWorkshopColorControls() {
  ensureSonicWorkshopCoverPaletteForUi();
  var theme = currentSonicWorkshopTheme();
  var meta = sonicWorkshopThemes()[theme] || sonicWorkshopThemes()['coral-mirage'];
  sonicWorkshopColorControls().forEach(function (item) {
    var coverMode = fx[item.modeKey] !== 'custom';
    var hex = sonicWorkshopRegionHex(item);
    var picker = document.getElementById(item.picker);
    var value = document.getElementById(item.value);
    var coverBtn = document.getElementById(item.button);
    if (picker) picker.value = normalizeHexColor(hex, item.fallback);
    if (value) {
      value.textContent = coverMode
        ? (accentBackgroundControlsText('accent_cover_prefix') + hex.toUpperCase() + (item.id === 'theme' ? ' / ' + meta.label : ''))
        : (accentBackgroundControlsText('accent_fixed_prefix') + hex.toUpperCase() + (item.id === 'theme' ? ' / ' + meta.label : ''));
    }
    if (coverBtn) coverBtn.classList.toggle('active', coverMode);
  });
  document.querySelectorAll('#sonic-workshop-theme-seg [data-sonic-workshop-theme]').forEach(function (btn) {
    btn.classList.toggle('active', fx.sonicWorkshopColorMode === 'custom' && normalizeSonicWorkshopTheme(btn.getAttribute('data-sonic-workshop-theme')) === theme);
  });
}
function pushSonicWorkshopColorChange(reason) {
  updateSonicWorkshopColorControls();
  var workshop = window.MineradioSonicWorkshop;
  if (workshop && typeof workshop.pushProperties === 'function') workshop.pushProperties(true);
  if (typeof syncFxUniforms === 'function') syncFxUniforms();
  saveLyricLayout({ user: true, reason: reason || 'sonicWorkshopRegionColors' });
}
function setSonicWorkshopRegionColorMode(id, mode, silent) {
  var item = sonicWorkshopRegionControl(id);
  if (!item) return;
  fx[item.modeKey] = mode === 'custom' ? 'custom' : 'cover';
  pushSonicWorkshopColorChange(item.id === 'theme' ? 'sonicWorkshopColorMode' : item.colorKey);
  if (!silent) showToast(accentBackgroundControlsText('accent_soundfield_we_prefix') + item.label + ': ' + (fx[item.modeKey] === 'cover' ? '\u5c01\u9762\u53d6\u8272' : accentBackgroundControlsText('accent_fixed_color')));
}
function setSonicWorkshopColorMode(mode, silent) {
  setSonicWorkshopRegionColorMode('theme', mode, silent);
}
function setSonicWorkshopTheme(theme, silent) {
  theme = normalizeSonicWorkshopTheme(theme);
  var meta = sonicWorkshopThemes()[theme] || sonicWorkshopThemes()['coral-mirage'];
  fx.sonicWorkshopColorMode = 'custom';
  fx.sonicWorkshopTheme = theme;
  fx.sonicWorkshopCustomColor = normalizeHexColor(meta.color, '#cb6c89');
  sonicWorkshopColorControls().forEach(function (item) {
    if (item.id === 'theme') return;
    fx[item.modeKey] = 'custom';
    fx[item.colorKey] = normalizeHexColor(meta[item.id] || item.fallback, item.fallback);
  });
  pushSonicWorkshopColorChange('sonicWorkshopRegionColors');
  if (!silent) showToast(accentBackgroundControlsText('accent_soundfield_we_colon') + meta.label);
}
function setSonicWorkshopThemeFromPicker(color, silent) {
  var hex = normalizeHexColor(color || '#cb6c89', '#cb6c89');
  var theme = sonicWorkshopThemeForColor(hex);
  var meta = sonicWorkshopThemes()[theme] || sonicWorkshopThemes()['coral-mirage'];
  fx.sonicWorkshopColorMode = 'custom';
  fx.sonicWorkshopTheme = theme;
  fx.sonicWorkshopCustomColor = hex;
  sonicWorkshopColorControls().forEach(function (item) {
    if (item.id === 'theme') return;
    fx[item.modeKey] = 'custom';
    fx[item.colorKey] = normalizeHexColor(meta[item.id] || item.fallback, item.fallback);
  });
  pushSonicWorkshopColorChange('sonicWorkshopRegionColors');
  if (!silent) showToast(accentBackgroundControlsText('accent_soundfield_we_prefix') + sonicWorkshopColorControls()[0].label + ': ' + fx.sonicWorkshopCustomColor.toUpperCase());
}
function setSonicWorkshopRegionColorFromPicker(id, color, silent) {
  var item = sonicWorkshopRegionControl(id);
  if (!item) return;
  if (item.id === 'theme') {
    setSonicWorkshopThemeFromPicker(color, silent);
    return;
  }
  var hex = normalizeHexColor(color || item.fallback, item.fallback);
  fx[item.modeKey] = 'custom';
  fx[item.colorKey] = hex;
  pushSonicWorkshopColorChange(item.colorKey);
  if (!silent) showToast(accentBackgroundControlsText('accent_soundfield_we_prefix') + item.label + ': ' + hex.toUpperCase());
}
