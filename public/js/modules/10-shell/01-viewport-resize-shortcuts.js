// ============================================================
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
function viewportResizeShortcutsText(key, fallback, params) {
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
function refreshMainRendererViewport(reason) {
  if (typeof camera !== 'undefined' && camera) {
    camera.aspect = Math.max(1, innerWidth) / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
  }
  applyRendererPowerMode();
  if (typeof requestStageLyricCameraSnap === 'function' && (desktopRuntimeState.fullscreen || document.fullscreenElement)) {
    requestStageLyricCameraSnap(reason === 'resize' ? 4 : 10);
  }
}
function scheduleMainRendererViewportRefresh(reason) {
  refreshMainRendererViewport(reason || 'sync');
  [48, 140, 320].forEach(function (delay) {
    setTimeout(function () { refreshMainRendererViewport(reason || 'sync'); }, delay);
  });
}
window.addEventListener('resize', function () {
  scheduleMainRendererViewportRefresh('resize');
  if (isFullscreenNow()) layoutFullscreenToolsZone();
});
document.addEventListener('keydown', function (e) {
  if (isTypingTarget(e.target)) return;
  if (handleConfiguredLocalHotkey(e)) return;
  if (shouldSuppressDefaultConfiguredHotkey(e)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    e.stopPropagation();
    if (freeCamera && freeCamera.active) return;
    if (e.repeat) return;
    togglePlay();
  }
  else if (e.code === 'Home') { e.preventDefault(); goHome(); }
  else if (e.code === 'ArrowUp') { e.preventDefault(); adjustVolumeByKeyboard(0.05); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); adjustVolumeByKeyboard(-0.05); }
  else if (e.code === 'ArrowRight') nextTrack(true);
  else if (e.code === 'ArrowLeft') prevTrack(true);
  else if (e.code === 'Escape') {
    if (immersiveMode) {
      e.preventDefault();
      setImmersiveMode(false);
      return;
    }
    if (window.desktopWindow && window.desktopWindow.isDesktop && desktopFullscreenActive && !document.fullscreenElement && window.desktopWindow.exitFullscreenWindowed) {
      e.preventDefault();
      window.desktopWindow.exitFullscreenWindowed();
      return;
    }
    if (document.fullscreenElement) {
      e.preventDefault();
      document.exitFullscreen();
      return;
    }
    var localBeatModal = document.getElementById('local-beat-modal');
    if (localBeatModal && localBeatModal.classList.contains('show')) {
      e.preventDefault();
      if (localBeatAnalysis.active) cancelLocalBeatAnalysis();
      else closeLocalBeatModal();
      return;
    }
    var customLyricModal = document.getElementById('custom-lyric-modal');
    if (customLyricModal && customLyricModal.classList.contains('show')) {
      e.preventDefault();
      closeCustomLyricModal();
      return;
    }
    var trackDetailModal = document.getElementById('track-detail-modal');
    if (trackDetailModal && trackDetailModal.classList.contains('show')) {
      e.preventDefault();
      closeTrackDetailModal();
      return;
    }
    if (miniQueueOpen) { closeMiniQueue(); return; }
    if (shelfManager && shelfManager.hasOpenContent()) { safeShelfCloseContent('escape-key'); return; }
    closeLoginModal(); closeUserModal(); toggleFxPanel(false); togglePlaylistPanel(false);
  }
  else if (e.code === 'KeyL') { if (!immersiveMode) toggleLyricsPanel(); }
  else if (e.code === 'KeyP') {
    if (!immersiveMode && diyPlayerMode) toggleFxPanel();
    else if (!immersiveMode) showToast(viewportResizeShortcutsText('toast_diy_tip', '开启 DIY 玩家模式后可打开视觉控制台'));
  }
  else if (e.code === 'KeyI') toggleImmersiveMode();
  else if (e.code === 'KeyF') toggleFullscreen();
});

// ============================================================
//  UI 半隐藏 v8 — 三个面板的触发/隐藏体验完全统一
//   - 搜索栏 (顶部): y < 80 进入, y > 96 离开
//   - 控制台 (右侧): x > w-48 进入, x < w-380 离开
//   - 歌单 (左侧): x < 48 进入, x > 380 离开
//   - 进入立即显示, 离开延迟 500ms (统一)
