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
function coverLoadingCropText(key, fallback, params) {
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
var albumBackgroundSlot = 0;
var albumBackgroundClearTimer = 0;
var albumBackgroundCurrentSrc = '';

function showAIDepthChip(text) {
  document.getElementById('ai-depth-text').textContent = text || coverLoadingCropText('ai_depth_estimating', 'AI 深度估计…');
  document.getElementById('ai-depth-chip').classList.add('show');
}
function hideAIDepthChip() {
  document.getElementById('ai-depth-chip').classList.remove('show');
}

function loadCoverFromUrl(directUrl, opts) {
  opts = opts || {};
  var preserveOnSwitch = !!(opts.trackSwitch || opts.seamlessCover || opts.seamlessTrackSwitch);
  if (!directUrl || typeof directUrl !== 'string' || (!/^https?:\/\//i.test(directUrl) && !/^mineradio-local:\/\/cover\//i.test(directUrl))) {
    if (!coverApplyStillCurrent(opts)) return;
    if (preserveOnSwitch && uniforms.uHasCover.value > 0.5) {
      document.getElementById('thumb-cover').removeAttribute('src');
      setControlCoverSrc('');
      setAlbumBackground('', { preserve: true });
      return;
    }
    currentCoverSource = null;
    coverProcessToken++;
    uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
    resetFloatColorsToIdle();
    setAlbumBackground('');
    document.getElementById('thumb-cover').removeAttribute('src');
    setControlCoverSrc('');
    return;
  }
  var proxiedUrl = coverProxySrc(directUrl);
  if (!proxiedUrl) {
    if (preserveOnSwitch && uniforms.uHasCover.value > 0.5) return;
    uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
    resetFloatColorsToIdle();
    setAlbumBackground('');
    setControlCoverSrc('');
    return;
  }
  var img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
  img.onload = function () {
    if (!coverApplyStillCurrent(opts)) return;
    var size = coverTextureSizeForResolution(fx.coverResolution);
    var cv = document.createElement('canvas'); cv.width = cv.height = size;
    var cx = cv.getContext('2d');
    var iw = img.naturalWidth, ih = img.naturalHeight, s = Math.min(iw, ih);
    cx.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, size, size);
    setAlbumBackground(proxiedUrl || directUrl);
    applyCoverCanvas(cv, proxiedUrl || directUrl, Object.assign({}, opts, { coverKey: directUrl || proxiedUrl || '', coverSourceKind: 'url', coverSource: directUrl }));
  };
  img.onerror = function () {
    var img2 = new Image(); img2.crossOrigin = 'anonymous'; img2.decoding = 'async';
    img2.onload = function () {
      if (!coverApplyStillCurrent(opts)) return;
      var size = coverTextureSizeForResolution(fx.coverResolution);
      var cv = document.createElement('canvas'); cv.width = cv.height = size;
      cv.getContext('2d').drawImage(img2, 0, 0, size, size);
      setAlbumBackground(directUrl);
      applyCoverCanvas(cv, directUrl, Object.assign({}, opts, { coverKey: directUrl || '', coverSourceKind: 'url', coverSource: directUrl }));
    };
    img2.onerror = function () {
      if (!coverApplyStillCurrent(opts)) return;
      if (preserveOnSwitch && uniforms.uHasCover.value > 0.5) return;
      currentCoverSource = null;
      uniforms.uHasCover.value = 0; setCoverDepthState(0, 0, 1);
      resetFloatColorsToIdle();
      setAlbumBackground('');
      setControlCoverSrc('');
    };
    img2.src = directUrl;
  };
  img.src = proxiedUrl;
}

function cssBackgroundUrl(src) {
  return 'url("' + String(src || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '")';
}

function setAlbumBackground(src, opts) {
  opts = opts || {};
  var bg = document.getElementById('album-bg');
  var next = document.getElementById('album-bg-next');
  if (!bg) return;
  if (!src) {
    if (opts.preserve) return;
    albumBackgroundCurrentSrc = '';
    bg.classList.remove('visible');
    if (next) next.classList.remove('visible');
    bg.style.backgroundImage = '';
    if (next) next.style.backgroundImage = '';
    refreshCustomBackgroundAlbumMedia();
    return;
  }
  albumBackgroundCurrentSrc = src;
  if (!next) {
    bg.style.backgroundImage = cssBackgroundUrl(src);
    bg.classList.add('visible');
    refreshCustomBackgroundAlbumMedia();
    return;
  }
  var outgoing = albumBackgroundSlot === 0 ? bg : next;
  var incoming = albumBackgroundSlot === 0 ? next : bg;
  incoming.style.backgroundImage = cssBackgroundUrl(src);
  incoming.classList.add('visible');
  outgoing.classList.remove('visible');
  albumBackgroundSlot = albumBackgroundSlot === 0 ? 1 : 0;
  if (albumBackgroundClearTimer) clearTimeout(albumBackgroundClearTimer);
  albumBackgroundClearTimer = setTimeout(function () {
    albumBackgroundClearTimer = 0;
    if (!outgoing.classList.contains('visible')) outgoing.style.backgroundImage = '';
  }, 900);
  refreshCustomBackgroundAlbumMedia();
}

function refreshCustomBackgroundAlbumMedia() {
  if (typeof customBackgroundUsesAlbumCover !== 'function' || !customBackgroundUsesAlbumCover()) return;
  if (typeof updateCustomBackgroundControls === 'function') updateCustomBackgroundControls();
  else if (typeof applyCustomBackground === 'function') applyCustomBackground();
}

function makeSquareCoverCanvas(img, size, crop) {
  size = size || 512;
  var cv = document.createElement('canvas');
  cv.width = cv.height = size;
  var cx = cv.getContext('2d');
  cx.clearRect(0, 0, size, size);
  var iw = img.naturalWidth || img.width;
  var ih = img.naturalHeight || img.height;
  if (crop) {
    cx.drawImage(img, crop.sx, crop.sy, crop.sSize, crop.sSize, 0, 0, size, size);
  } else {
    var s = Math.min(iw, ih);
    cx.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, 0, 0, size, size);
  }
  return cv;
}

function coverCanvasToDataUrl(cv) {
  try {
    var webp = cv.toDataURL('image/webp', 0.88);
    if (/^data:image\/webp/i.test(webp)) return webp;
  } catch (e) { }
  return cv.toDataURL('image/jpeg', 0.88);
}

function applyCoverDataUrl(dataUrl, opts) {
  opts = opts || {};
  if (!dataUrl) return;
  var img = new Image();
  img.decoding = 'async';
  img.onload = function () {
    if (!coverApplyStillCurrent(opts)) return;
    var cv = makeSquareCoverCanvas(img, coverTextureSizeForResolution(fx.coverResolution));
    setAlbumBackground(dataUrl);
    applyCoverCanvas(cv, dataUrl, Object.assign({}, opts, { coverSourceKind: 'data', coverSource: dataUrl }));
  };
  img.src = dataUrl;
}

function commitCustomCoverCanvas(cv, opts) {
  var out = document.createElement('canvas');
  out.width = out.height = 512;
  out.getContext('2d').drawImage(cv, 0, 0, 512, 512);
  setCustomCoverForCurrent(coverCanvasToDataUrl(out), opts);
}

function loadCoverFromFile(file, opts) {
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var iw = img.naturalWidth || img.width;
      var ih = img.naturalHeight || img.height;
      if (Math.abs(iw - ih) <= 1) {
        commitCustomCoverCanvas(makeSquareCoverCanvas(img, 512), opts);
      } else {
        openCoverCropModal(img, e.target.result);
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function bindCoverCropModal() {
  if (coverCropBound) return;
  coverCropBound = true;
  var stage = document.getElementById('cover-crop-stage');
  var zoom = document.getElementById('cover-crop-zoom');
  if (!stage || !zoom) return;
  stage.addEventListener('pointerdown', function (e) {
    if (!coverCropState) return;
    e.preventDefault();
    coverCropState.dragging = true;
    coverCropState.lastX = e.clientX;
    coverCropState.lastY = e.clientY;
    stage.classList.add('dragging');
    if (stage.setPointerCapture) {
      try { stage.setPointerCapture(e.pointerId); } catch (err) { }
    }
  });
  stage.addEventListener('pointermove', function (e) {
    if (!coverCropState || !coverCropState.dragging) return;
    e.preventDefault();
    var dx = e.clientX - coverCropState.lastX;
    var dy = e.clientY - coverCropState.lastY;
    coverCropState.lastX = e.clientX;
    coverCropState.lastY = e.clientY;
    coverCropState.x += dx;
    coverCropState.y += dy;
    updateCoverCropTransform();
  });
  function stopDrag() {
    if (!coverCropState) return;
    coverCropState.dragging = false;
    stage.classList.remove('dragging');
  }
  stage.addEventListener('pointerup', stopDrag);
  stage.addEventListener('pointercancel', stopDrag);
  stage.addEventListener('wheel', function (e) {
    if (!coverCropState) return;
    e.preventDefault();
    var next = coverCropState.scaleFactor + (e.deltaY < 0 ? 0.10 : -0.10);
    coverCropState.scaleFactor = Math.max(1, Math.min(3.2, next));
    zoom.value = coverCropState.scaleFactor;
    updateCoverCropTransform();
  }, { passive: false });
  zoom.addEventListener('input', function () {
    if (!coverCropState) return;
    coverCropState.scaleFactor = Math.max(1, Math.min(3.2, parseFloat(zoom.value) || 1));
    updateCoverCropTransform();
  });
}

function openCoverCropModal(img, dataUrl) {
  bindCoverCropModal();
  var modal = document.getElementById('cover-crop-modal');
  var stage = document.getElementById('cover-crop-stage');
  var imgEl = document.getElementById('cover-crop-img');
  var zoom = document.getElementById('cover-crop-zoom');
  if (!modal || !stage || !imgEl || !zoom) return;
  imgEl.src = dataUrl;
  zoom.value = '1';
  coverCropState = {
    img: img,
    dataUrl: dataUrl,
    naturalW: img.naturalWidth || img.width,
    naturalH: img.naturalHeight || img.height,
    stageSize: 0,
    baseScale: 1,
    scaleFactor: 1,
    x: 0,
    y: 0,
    dragging: false,
    lastX: 0,
    lastY: 0
  };
  openGsapModal(modal);
  requestAnimationFrame(function () {
    initCoverCropGeometry();
    pulseCoverCropStage();
  });
}

function initCoverCropGeometry() {
  if (!coverCropState) return;
  var stage = document.getElementById('cover-crop-stage');
  var rect = stage ? stage.getBoundingClientRect() : null;
  var size = rect ? Math.max(220, Math.round(rect.width)) : 312;
  coverCropState.stageSize = size;
  coverCropState.baseScale = size / Math.min(coverCropState.naturalW, coverCropState.naturalH);
  coverCropState.x = 0;
  coverCropState.y = 0;
  updateCoverCropTransform();
}

function clampCoverCropPan() {
  if (!coverCropState) return;
  var s = coverCropState.baseScale * coverCropState.scaleFactor;
  var rw = coverCropState.naturalW * s;
  var rh = coverCropState.naturalH * s;
  var maxX = Math.max(0, (rw - coverCropState.stageSize) / 2);
  var maxY = Math.max(0, (rh - coverCropState.stageSize) / 2);
  coverCropState.x = Math.max(-maxX, Math.min(maxX, coverCropState.x));
  coverCropState.y = Math.max(-maxY, Math.min(maxY, coverCropState.y));
}

function updateCoverCropTransform() {
  if (!coverCropState) return;
  clampCoverCropPan();
  var imgEl = document.getElementById('cover-crop-img');
  if (!imgEl) return;
  var baseW = coverCropState.naturalW * coverCropState.baseScale;
  var baseH = coverCropState.naturalH * coverCropState.baseScale;
  imgEl.style.width = baseW + 'px';
  imgEl.style.height = baseH + 'px';
  imgEl.style.transform = 'translate(-50%, -50%) translate(' + coverCropState.x + 'px,' + coverCropState.y + 'px) scale(' + coverCropState.scaleFactor + ')';
  drawCoverCropPreview();
}

function currentCoverCropRect() {
  if (!coverCropState) return null;
  var s = coverCropState.baseScale * coverCropState.scaleFactor;
  var rw = coverCropState.naturalW * s;
  var rh = coverCropState.naturalH * s;
  var left = coverCropState.stageSize / 2 - rw / 2 + coverCropState.x;
  var top = coverCropState.stageSize / 2 - rh / 2 + coverCropState.y;
  var sx = (0 - left) / s;
  var sy = (0 - top) / s;
  var sSize = coverCropState.stageSize / s;
  sx = Math.max(0, Math.min(coverCropState.naturalW - sSize, sx));
  sy = Math.max(0, Math.min(coverCropState.naturalH - sSize, sy));
  return { sx: sx, sy: sy, sSize: sSize };
}

function drawCoverCropPreview() {
  if (!coverCropState) return;
  var preview = document.getElementById('cover-crop-preview');
  var crop = currentCoverCropRect();
  if (!preview || !crop) return;
  var ctx = preview.getContext('2d');
  ctx.clearRect(0, 0, preview.width, preview.height);
  ctx.drawImage(coverCropState.img, crop.sx, crop.sy, crop.sSize, crop.sSize, 0, 0, preview.width, preview.height);
}

function pulseCoverCropStage() {
  var stage = document.getElementById('cover-crop-stage');
  if (!stage || !window.gsap) return;
  window.gsap.fromTo(stage, { scale: 0.985 }, { scale: 1, duration: 0.72, ease: 'expo.out', overwrite: true });
}

function closeCoverCropModal() {
  var modal = document.getElementById('cover-crop-modal');
  closeGsapModal(modal, function () {
    var imgEl = document.getElementById('cover-crop-img');
    if (imgEl) imgEl.removeAttribute('src');
    coverCropState = null;
  });
}

function commitCoverCrop() {
  if (!coverCropState) return;
  var crop = currentCoverCropRect();
  if (!crop) return;
  var cv = makeSquareCoverCanvas(coverCropState.img, 512, crop);
  commitCustomCoverCanvas(cv);
  closeCoverCropModal();
}

// ============================================================
//  3D 歌单架 — 双模式 (off / side / stage)
//   - side:   现版本精修, 右侧 5 张卡微角度堆叠
//   - stage:  弧形排列, 居中, 有倒影, 当前卡片"呼吸+光环"
//             卡片间粒子穿梭, 切歌时飞出动画
