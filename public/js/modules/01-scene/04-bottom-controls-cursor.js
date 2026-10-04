// 本模块界面文案统一走 i18n；词典是唯一文案来源，缺键时退回内置中文模板。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：xxxText('key') 缺键返回键名；xxxText('key', '兜底') 显式指定缺键时显示什么；
// xxxText('key', '含 {p} 的模板', {p: v}) 带插值，params 同时喂给 t() 与兜底模板。
// Two call shapes: key-only shows the bare key on a miss; an explicit fallback says what to
// show instead; params interpolate into both the dictionary hit and the fallback template.
function bottomControlsCursorText(key, fallback, params) {
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

function hasRestoredPlaybackCandidate() {
  if (!restoredLastPlaybackSnapshot) return false;
  if (currentLocalSong) return true;
  if (Array.isArray(playQueue) && currentIdx >= 0 && playQueue[currentIdx]) return true;
  return !!(restoredLastPlaybackSnapshot && pendingPlaybackResumeAt > 0 && restoredLastPlaybackSnapshot.current);
}

function hasPlaybackControlCandidate() {
  if (currentLocalSong) return true;
  if (Array.isArray(playQueue) && currentIdx >= 0 && playQueue[currentIdx]) return true;
  return hasRestoredPlaybackCandidate();
}

function hasActivePlaybackControls() {
  return !!(playing || (audio && !audio.paused) || hasPlaybackControlCandidate());
}

function desktopWallpaperKeepsPlayerConsoleVisible() {
  var body = document.body;
  if (!body
    || !body.classList.contains('desktop-wallpaper-mode')
    || !body.classList.contains('desktop-wallpaper-interactive')) return false;
  // Home and the 3D shelf are complete Mineradio surfaces of their own. In the
  // ordinary desktop stage, however, allowing the generic inactivity timer to
  // hide the only player console makes the renderer look as if it fell behind
  // the wallpaper/Explorer plane.
  if (body.classList.contains('empty-home-active')
    || body.classList.contains('home-controls-locked')) return false;
  try {
    return !isBottomControlsSuppressedForShelf();
  } catch (_) {
    return true;
  }
}

function shouldShowHomeForPausedStartupRestore() {
  return !!(startupRestoreHomePending
    && restoredLastPlaybackSnapshot
    && !playing
    && !(audio && !audio.paused)
    && !immersiveMode);
}

function setControlsHidden(hidden) {
  var bar = document.getElementById('bottom-bar');
  if (!bar) return;
  if (hidden && desktopWallpaperKeepsPlayerConsoleVisible()) hidden = false;
  if (hidden && controlsRevealHoldUntil > performance.now()) hidden = false;
  if (hidden && (controlsHovering || miniQueueOpen)) hidden = false;
  bar.classList.toggle('soft-hidden', !!hidden && controlsAutoHide && bar.classList.contains('visible'));
  if (hidden && typeof closeLyricTimingPopover === 'function') closeLyricTimingPopover(true);
  bar.style.pointerEvents = '';
  updateControlsChromeState();
}

function isBottomControlsSuppressedForShelf() {
  var shelfContentOpen = false;
  try {
    shelfContentOpen = !!(typeof shelfManager !== 'undefined' && shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent());
  } catch (e) { }
  return !!(shelfPinnedOpen || shelfContentOpen || (controlsShelfSuppressUntil && performance.now() < controlsShelfSuppressUntil));
}

function suppressBottomControlsForShelf(duration) {
  controlsShelfSuppressUntil = performance.now() + (duration == null ? 900 : duration);
  controlsHovering = false;
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  document.body.classList.remove('controls-handle-awake');
  if (miniQueueOpen) closeMiniQueue();
  var bar = document.getElementById('bottom-bar');
  if (bar) {
    bar.classList.remove('visible', 'soft-hidden');
    bar.style.pointerEvents = '';
  }
  updateControlsChromeState();
}

function restoreBottomControlsAfterShelfExit(reason) {
  controlsShelfSuppressUntil = 0;
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  if (isBottomControlsSuppressedForShelf()) return;
  if (!hasActivePlaybackControls() && controlsAutoHide) return;
  try {
    setHomeControlsLocked(false);
    var bar = document.getElementById('bottom-bar');
    if (bar) {
      bar.classList.add('visible');
      bar.classList.remove('soft-hidden');
      bar.style.pointerEvents = '';
    }
    wakeBottomHandle(controlsAutoHide ? 1400 : 2600);
    setControlsHidden(false);
    updateControlsChromeState();
    if (controlsAutoHide) scheduleControlsHide(900);
  } catch (e) {
    console.warn('[ShelfControlsRestore]', reason || 'shelf-exit', e);
  }
}

function scheduleControlsHide(delay) {
  if (controlsHideTimer) clearTimeout(controlsHideTimer);
  if (!controlsAutoHide) return;
  if (desktopWallpaperKeepsPlayerConsoleVisible()) {
    controlsHideTimer = null;
    setControlsHidden(false);
    return;
  }
  var requestedDelay = delay == null ? 480 : Math.max(0, Number(delay) || 0);
  var revealHoldRemaining = controlsRevealHoldUntil - performance.now();
  if (revealHoldRemaining > 0) requestedDelay = Math.max(requestedDelay, Math.ceil(revealHoldRemaining) + 32);
  controlsHideTimer = setTimeout(function () {
    controlsHideTimer = null;
    var remaining = controlsRevealHoldUntil - performance.now();
    if (remaining > 0) {
      scheduleControlsHide(Math.ceil(remaining) + 32);
      return;
    }
    if (!controlsHovering) setControlsHidden(true);
  }, requestedDelay);
}

function revealBottomControls(delay) {
  if (document.body.classList.contains('home-controls-locked')) return;
  var bar = document.getElementById('bottom-bar');
  if (isBottomControlsSuppressedForShelf()) return;
  if (bar) bar.classList.add('visible');
  wakeBottomHandle();
  setControlsHidden(false);
  if (controlsAutoHide) scheduleControlsHide(delay == null ? 520 : delay);
}

function holdBottomControlsVisible(duration) {
  var holdDuration = Math.max(900, Number(duration) || 0);
  controlsRevealHoldUntil = Math.max(controlsRevealHoldUntil, performance.now() + holdDuration);
  revealBottomControls(holdDuration + 32);
}

function showRestoredPlaybackControls(reason) {
  if (!hasActivePlaybackControls()) return;
  try {
    homeForcedOpen = false;
    setHomeControlsLocked(false);
    var bar = document.getElementById('bottom-bar');
    if (bar) {
      bar.classList.add('visible');
      bar.classList.remove('soft-hidden');
      bar.style.pointerEvents = '';
    }
    wakeBottomHandle(reason === 'startup-autoplay' ? 2600 : 3600);
    setControlsHidden(false);
    updateControlsChromeState();
    if (controlsHideTimer) {
      clearTimeout(controlsHideTimer);
      controlsHideTimer = null;
    }
    if (controlsAutoHide) scheduleControlsHide(reason === 'startup-autoplay' ? 2200 : 3600);
  } catch (e) {
    console.warn('[RestoredPlaybackControls]', e);
  }
}

function updateControlsChromeState() {
  var bar = document.getElementById('bottom-bar');
  var handle = document.getElementById('bottom-handle');
  var active = !!(bar && bar.classList.contains('visible') && !bar.classList.contains('soft-hidden'));
  document.body.classList.toggle('controls-visible', active);
  if (handle) handle.classList.toggle('active', active);
}

function wakeBottomHandle(duration) {
  document.body.classList.add('controls-handle-awake');
  if (controlsHandleDimTimer) clearTimeout(controlsHandleDimTimer);
  controlsHandleDimTimer = setTimeout(function () {
    controlsHandleDimTimer = null;
    document.body.classList.remove('controls-handle-awake');
  }, duration == null ? 2000 : duration);
}

function forcePlaybackControlsInteractive() {
  if (!hasActivePlaybackControls()) return;
  try {
    document.body.classList.remove('home-controls-locked');
    var bar = document.getElementById('bottom-bar');
    if (bar) {
      bar.style.pointerEvents = '';
      if (!controlsAutoHide) {
        bar.classList.add('visible');
        bar.classList.remove('soft-hidden');
      }
    }
    ['play-btn', 'prev-btn', 'next-btn', 'mini-queue-btn', 'heart-btn', 'play-mode-btn', 'collect-btn'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = false;
      btn.classList.remove('busy');
    });
    updateControlsChromeState();
    if (bar && bar.classList.contains('visible') && controlsAutoHide && !controlsHovering) scheduleControlsHide(220);
  } catch (e) {
    console.warn('[PlaybackControlsRestore]', e);
  }
}

function toggleBottomControlsFromHandle() {
  var bar = document.getElementById('bottom-bar');
  if (!bar || document.body.classList.contains('home-controls-locked')) return;
  if (isBottomControlsSuppressedForShelf()) return;
  revealBottomControls(900);
}

function updateControlsAutoHideFromPointer(x, y) {
  if (document.body.classList.contains('home-controls-locked')) return;
  if (isBottomControlsSuppressedForShelf()) return;
  var bar = document.getElementById('bottom-bar');
  if (!bar || !bar.classList.contains('visible')) return;
  if (!controlsAutoHide) { setControlsHidden(false); return; }
  if (diyPlayerMode) {
    var fxPanel = document.getElementById('fx-panel');
    var fxFab = document.getElementById('fx-fab');
    var fr = fxPanel ? fxPanel.getBoundingClientRect() : null;
    var br = fxFab ? fxFab.getBoundingClientRect() : null;
    var overFxPanel = fxPanel && (fxPanel.classList.contains('peek') || fxPanel.classList.contains('show')) && fr && x >= fr.left - 18 && x <= fr.right + 18 && y >= fr.top - 18 && y <= fr.bottom + 18;
    var overFxFab = br && x >= br.left - 18 && x <= br.right + 18 && y >= br.top - 18 && y <= br.bottom + 18;
    if (overFxPanel || overFxFab) {
      scheduleControlsHide(80);
      return;
    }
  }
  controlsLastMoveAt = performance.now();
  var rect = bar.getBoundingClientRect();
  var handle = document.getElementById('bottom-handle');
  var hr = handle ? handle.getBoundingClientRect() : null;
  var overHandle = hr && x >= hr.left - 18 && x <= hr.right + 18 && y >= hr.top - 12 && y <= hr.bottom + 14;
  var overBar = x >= rect.left - 18 && x <= rect.right + 18 && y >= rect.top - 18 && y <= rect.bottom + 14;
  var mini = document.getElementById('mini-queue-popover');
  var miniRect = mini ? mini.getBoundingClientRect() : null;
  var overMini = miniQueueOpen && miniRect && x >= miniRect.left - 16 && x <= miniRect.right + 16 && y >= miniRect.top - 16 && y <= miniRect.bottom + 16;
  if (overHandle) wakeBottomHandle();
  if (overBar || overMini || overHandle) revealBottomControls(overHandle ? 900 : 520);
  else scheduleControlsHide(70);
}

function toggleControlsAutoHide() {
  controlsAutoHide = !controlsAutoHide;
  saveBooleanPreference(CONTROLS_AUTO_HIDE_STORE_KEY, controlsAutoHide);
  var btn = document.getElementById('controls-hide-btn');
  if (btn) btn.classList.toggle('active', controlsAutoHide);
  setControlsHidden(false);
  if (controlsAutoHide) {
    scheduleControlsHide(520);
    showToast(bottomControlsCursorText('cursor_bar_autohide'));
  } else {
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
    showToast(bottomControlsCursorText('cursor_bar_keep'));
  }
}

function applyControlsAutoHidePreference() {
  var btn = document.getElementById('controls-hide-btn');
  if (btn) btn.classList.toggle('active', !!controlsAutoHide);
  if (!controlsAutoHide && controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  setControlsHidden(false);
}

(function initControlsAutoHide() {
  var bar = document.getElementById('bottom-bar');
  var handle = document.getElementById('bottom-handle');
  if (!bar) return;
  function enterControls() {
    controlsHovering = true;
    wakeBottomHandle();
    setControlsHidden(false);
    if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
  }
  function leaveControls() {
    controlsHovering = false;
    scheduleControlsHide(70);
    wakeBottomHandle(900);
  }
  bar.addEventListener('mouseenter', enterControls);
  bar.addEventListener('mouseleave', leaveControls);
  if (handle) {
    handle.addEventListener('mouseenter', function () {
      controlsHovering = true;
      revealBottomControls(900);
    });
    handle.addEventListener('mouseleave', leaveControls);
    handle.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleBottomControlsFromHandle(); });
  }
  updateControlsChromeState();
})();

function isCursorAutoHideMode() {
  return !document.hidden;
}

function clearCursorAutoHideTimer() {
  if (cursorHideTimer) {
    clearTimeout(cursorHideTimer);
    cursorHideTimer = null;
  }
}

function setCursorHidden(hidden) {
  document.body.classList.toggle('cursor-hidden', !!hidden && isCursorAutoHideMode());
}

function scheduleCursorHide(delay) {
  clearCursorAutoHideTimer();
  if (!isCursorAutoHideMode()) {
    setCursorHidden(false);
    return;
  }
  cursorHideTimer = setTimeout(function () {
    cursorHideTimer = null;
    setCursorHidden(true);
  }, delay == null ? CURSOR_HIDE_DELAY : delay);
}

function revealCursorForActivity() {
  if (!isCursorAutoHideMode()) {
    clearCursorAutoHideTimer();
    setCursorHidden(false);
    return;
  }
  setCursorHidden(false);
  scheduleCursorHide(CURSOR_HIDE_DELAY);
}

function syncCursorAutoHideMode() {
  if (isCursorAutoHideMode()) revealCursorForActivity();
  else {
    clearCursorAutoHideTimer();
    setCursorHidden(false);
  }
}

['mousemove', 'pointermove', 'mousedown', 'wheel', 'touchstart'].forEach(function (type) {
  window.addEventListener(type, revealCursorForActivity, { passive: true, capture: true });
});
syncCursorAutoHideMode();

// ============================================================
//  指针 / 拖拽控制
//   v7.1: 用 userOrbit 替代 targetOrbit; 加 drag 距离判断
