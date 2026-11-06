// 文案统一走 i18n：缺键返回键名（不返回空串），params 同时喂给词典与兜底模板。
// Copy goes through i18n; a missing key returns the key itself rather than an empty string.
function desktopOverlayFullscreenText(key, fallback, params) {
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
var desktopOverlayPushState = {
  lyricsAt: 0,
  wallpaperAt: 0,
  lastLyricsKey: '',
  lastLyricsBeatKey: '',
  lastLyricsCustomFontId: '',
  lastWallpaperKey: ''
};
var desktopWallpaperRuntimeState = {
  supported: true,
  active: false,
  enabled: false,
  attaching: false,
  generation: -1,
  lastError: ''
};
var desktopWallpaperStatusGeneration = -1;
var desktopWallpaperStatusUnsubscribe = null;
var desktopWallpaperRendererOperation = 0;
var desktopWallpaperUiActivationState = false;
var desktopWallpaperHudPrimeTimer = 0;
var desktopIconVisibilityOperation = 0;
var desktopIconVisibilityPending = false;
var desktopSoftwareLockOperation = 0;
var desktopSoftwareLockPending = false;
var desktopModeControlDockState = {
  open: false,
  hideTimer: 0,
  peek: false,
  peekTimer: 0,
  openTimer: 0,
  // 用户主动点关闭后，鼠标还停在把手上时不要立刻又悬停展开。
  // After an explicit click-to-close, hover must not immediately reopen while the pointer stays.
  hoverReopenBlocked: false
};
var desktopPointerRouteReporter = {
  timer: 0,
  x: 0,
  y: 0,
  hasPointer: false,
  lastKey: '',
  forcePending: false,
  overControls: false
};
var desktopIconShieldReporter = {
  timer: 0,
  forceEmptyPending: false,
  lastKey: '',
  mutationObserver: null,
  resizeObserver: null,
  shelfTimer: 0,
  observedElements: []
};
var DESKTOP_ICON_SHIELD_TARGETS = [
  { selector: '#bottom-bar', kind: 'player-control' },
  { selector: '#search-area', kind: 'search' },
  { selector: '#top-right', kind: 'account-actions' },
  { selector: '#desktop-mode-control-handle', kind: 'desktop-controls' },
  { selector: '#desktop-mode-control-panel', kind: 'desktop-controls' },
  { selector: '#desktop-tools-zone', kind: 'desktop-controls' },
  { selector: '#fx-panel', kind: 'fx-panel' },
  { selector: '#fx-fab', kind: 'fx-launcher' },
  { selector: '#fx-fab-hide-btn', kind: 'fx-launcher-toggle' },
  { selector: '#playlist-panel', kind: 'playlist-panel' },
  { selector: '#empty-home', kind: 'home' },
  { selector: '#desktop-titlebar', kind: 'window-controls' },
  // 全屏工具行里装的是标题栏搬过来的那排按钮，未浮现时用 visibility: hidden 隐藏，
  // 所以这里的可见性判定本来就够用 —— 不需要 ignoreAriaHidden。
  // The row hosts the title bar's tool buttons and hides itself with visibility: hidden when not
  // revealed, so the default visibility test is enough — no aria-hidden override needed.
  { selector: '#fullscreen-tools-zone', kind: 'fullscreen-tools' },
  { selector: '#upload-panel', kind: 'upload-panel' },
  { selector: '#upload-tip', kind: 'upload-tip' },
  { selector: '#bottom-handle', kind: 'player-handle' },
  { selector: '#mini-queue-popover', kind: 'mini-queue' },
  { selector: '#thumb-wrap', kind: 'cover-control' },
  { selector: '#trial-banner', kind: 'trial-banner' },
  { selector: '#source-fallback-notice', kind: 'source-notice' },
  { selector: '#ai-depth-chip', kind: 'depth-chip' },
  { selector: '#beat-chip', kind: 'beat-chip' },
  { selector: '#cover-color-pop', kind: 'cover-color' },
  { selector: '#color-lab-pop', kind: 'color-lab' },
  { selector: '.quality-popover', kind: 'quality-popover' },
  { selector: '.volume-popover', kind: 'volume-popover' },
  { selector: '#lyric-timing-popover', kind: 'lyric-timing-popover' },
  { selector: '#control-source-switcher', kind: 'source-switcher' },
  { selector: '#cuefield-feedback', kind: 'cuefield-feedback' },
  { selector: '#cookie-export-prompt', kind: 'cookie-export' },
  { selector: '.modal-mask', kind: 'modal', visual: true },
  { selector: '#toast', kind: 'toast', visual: true },
  { selector: '#visual-guide', kind: 'guide', visual: true },
  { selector: '#drop-overlay', kind: 'drop', visual: true },
  { selector: '#splash', kind: 'splash', visual: true }
];
var DESKTOP_ICON_SHIELD_SELECTOR = DESKTOP_ICON_SHIELD_TARGETS.map(function (target) {
  return target.selector;
}).join(',');
function getDesktopWindowApi() {
  return window.desktopWindow && window.desktopWindow.isDesktop ? window.desktopWindow : null;
}

function desktopIconShieldModeState() {
  var status = desktopWallpaperRuntimeState || {};
  var windowState = desktopWindowState || {};
  var body = document.body;
  var hasWindowEnabled = typeof windowState.isDesktopEmbedded === 'boolean';
  var hasWindowInteractive = typeof windowState.isDesktopInteractive === 'boolean';
  var hasStatusEnabled = typeof status.enabled === 'boolean' || typeof status.active === 'boolean';
  var hasStatusInteractive = typeof status.interactive === 'boolean';
  var enabled = hasWindowEnabled
    ? windowState.isDesktopEmbedded === true
    : (hasStatusEnabled
      ? (status.enabled === true || status.active === true)
      : !!(body && body.classList.contains('desktop-wallpaper-mode')));
  var interactive = hasWindowInteractive
    ? windowState.isDesktopInteractive === true
    : (hasStatusInteractive
      ? status.interactive === true
      : !!(body && body.classList.contains('desktop-wallpaper-interactive')));
  var visible = document.visibilityState !== 'hidden'
    && windowState.isVisible !== false
    && windowState.isMinimized !== true;
  return {
    enabled: !!enabled,
    interactive: !!interactive,
    active: !!(enabled && interactive && visible)
  };
}

function desktopIconShieldElementVisible(element, target) {
  if (!element || element.nodeType !== 1 || element.hidden) return false;
  if ((!target || target.ignoreAriaHidden !== true)
    && String(element.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return false;
  var style;
  try {
    style = window.getComputedStyle ? window.getComputedStyle(element) : element.currentStyle;
  } catch (_) {
    style = null;
  }
  if (style) {
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.contentVisibility === 'hidden') return false;
    var opacity = parseFloat(style.opacity);
    if (isFinite(opacity) && opacity <= 0.01) return false;
    if ((!target || target.visual !== true) && style.pointerEvents === 'none') return false;
  }
  if (!element.getClientRects || element.getClientRects().length < 1) return false;
  return true;
}

function desktopIconShieldClippedRect(rect, viewportWidth, viewportHeight, kind) {
  if (!rect) return null;
  var left = Math.max(0, Math.floor(Number(rect.left) || 0));
  var top = Math.max(0, Math.floor(Number(rect.top) || 0));
  var right = Math.min(viewportWidth, Math.ceil(Number(rect.right)));
  var bottom = Math.min(viewportHeight, Math.ceil(Number(rect.bottom)));
  if (!isFinite(right) || !isFinite(bottom) || right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    kind: kind || 'ui'
  };
}

function desktopIconShieldMeshRect(mesh, viewportWidth, viewportHeight, kind, pad) {
  if (!mesh || !mesh.geometry || typeof THREE === 'undefined' || typeof camera === 'undefined' || !camera) return null;
  var current = mesh;
  while (current) {
    if (current.visible === false) return null;
    current = current.parent;
  }
  var params = mesh.geometry.parameters || {};
  var halfWidth = Math.max(0.02, Number(params.width) || 0) / 2;
  var halfHeight = Math.max(0.02, Number(params.height) || 0) / 2;
  if (!isFinite(halfWidth) || !isFinite(halfHeight)) return null;
  var points = [
    new THREE.Vector3(-halfWidth, -halfHeight, 0),
    new THREE.Vector3(halfWidth, -halfHeight, 0),
    new THREE.Vector3(halfWidth, halfHeight, 0),
    new THREE.Vector3(-halfWidth, halfHeight, 0)
  ];
  var minX = Infinity;
  var minY = Infinity;
  var maxX = -Infinity;
  var maxY = -Infinity;
  try {
    mesh.updateMatrixWorld(true);
    for (var i = 0; i < points.length; i++) {
      points[i].applyMatrix4(mesh.matrixWorld).project(camera);
      var x = (points[i].x + 1) * viewportWidth / 2;
      var y = (1 - points[i].y) * viewportHeight / 2;
      if (!isFinite(x) || !isFinite(y)) return null;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  } catch (_) {
    return null;
  }
  var safePad = Math.max(12, Math.min(96, Number(pad) || 32));
  return desktopIconShieldClippedRect({
    left: minX - safePad,
    top: minY - safePad,
    right: maxX + safePad,
    bottom: maxY + safePad
  }, viewportWidth, viewportHeight, kind);
}

function desktopIconShieldUnionRects(rects, viewportWidth, viewportHeight, kind) {
  if (!rects || !rects.length) return null;
  var left = viewportWidth;
  var top = viewportHeight;
  var right = 0;
  var bottom = 0;
  for (var i = 0; i < rects.length; i++) {
    var rect = rects[i];
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return desktopIconShieldClippedRect({ left: left, top: top, right: right, bottom: bottom }, viewportWidth, viewportHeight, kind);
}

function desktopIconShieldShelfRects(viewportWidth, viewportHeight) {
  var pinned = typeof shelfPinnedOpen !== 'undefined' && shelfPinnedOpen === true;
  var contentOpen = false;
  var mode = 'off';
  var canInteract = false;
  var alwaysVisible = false;
  var previewVisible = false;
  try {
    contentOpen = !!(typeof shelfManager !== 'undefined' && shelfManager
      && shelfManager.hasOpenContent && shelfManager.hasOpenContent());
    mode = String(shelfManager && shelfManager.getMode && shelfManager.getMode() || 'off');
    canInteract = !!(shelfManager && shelfManager.canInteract && shelfManager.canInteract());
    alwaysVisible = typeof shelfAlwaysVisible === 'function' && shelfAlwaysVisible();
    previewVisible = typeof shelfPreviewIsVisible === 'function' && shelfPreviewIsVisible();
  } catch (_) {
    contentOpen = false;
  }
  var sideActive = mode === 'side' && canInteract && (pinned || contentOpen || alwaysVisible || previewVisible);
  var stageActive = mode === 'stage' && canInteract;
  if (!sideActive && !stageActive && !contentOpen) return [];

  var projected = [];
  try {
    var cards = shelfManager && shelfManager.getCards ? shelfManager.getCards() : [];
    for (var i = 0; i < cards.length && projected.length < 28; i++) {
      var cardRect = desktopIconShieldMeshRect(cards[i] && cards[i].mesh, viewportWidth, viewportHeight, 'shelf-card', 42);
      if (cardRect) projected.push(cardRect);
    }
    var content = shelfManager && shelfManager.getContentList ? shelfManager.getContentList() : null;
    var rows = contentOpen && content && content.getRows ? content.getRows() : [];
    for (var j = 0; j < rows.length && projected.length < 52; j++) {
      var rowRect = desktopIconShieldMeshRect(rows[j] && rows[j].mesh, viewportWidth, viewportHeight, 'shelf-detail-row', 28);
      if (rowRect) projected.push(rowRect);
    }
  } catch (_) {
    projected = [];
  }
  var union = desktopIconShieldUnionRects(projected, viewportWidth, viewportHeight,
    contentOpen ? 'shelf-detail' : (mode === 'stage' ? 'shelf-stage' : 'shelf-side'));
  if (union) return [union];

  if (mode === 'stage') {
    return [desktopIconShieldClippedRect({
      left: 0,
      top: Math.round(viewportHeight * 0.46),
      right: viewportWidth,
      bottom: viewportHeight
    }, viewportWidth, viewportHeight, 'shelf-stage-fallback')].filter(Boolean);
  }
  var width = contentOpen
    ? Math.min(viewportWidth, Math.max(560, Math.round(viewportWidth * 0.68)))
    : Math.min(viewportWidth, Math.max(390, Math.round(viewportWidth * 0.42)));
  return [desktopIconShieldClippedRect({
    left: viewportWidth - width,
    top: Math.max(56, Math.round(viewportHeight * 0.04)),
    right: viewportWidth,
    bottom: viewportHeight - Math.max(84, Math.round(viewportHeight * 0.08))
  }, viewportWidth, viewportHeight, contentOpen ? 'shelf-detail-fallback' : 'shelf-side-fallback')].filter(Boolean);
}

function desktopIconShieldShelfNeedsGeometryTracking() {
  try {
    if (typeof shelfManager === 'undefined' || !shelfManager || !shelfManager.getMode
      || !shelfManager.canInteract || !shelfManager.canInteract()) return false;
    var mode = String(shelfManager.getMode() || 'off');
    if (mode === 'stage') return true;
    if (mode !== 'side') return false;
    return (typeof shelfPinnedOpen !== 'undefined' && shelfPinnedOpen === true)
      || !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent())
      || (typeof shelfAlwaysVisible === 'function' && shelfAlwaysVisible())
      || (typeof shelfPreviewIsVisible === 'function' && shelfPreviewIsVisible());
  } catch (_) {
    return false;
  }
}

function collectDesktopIconShieldRects() {
  var viewportWidth = Math.max(0, Math.round(window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0));
  var viewportHeight = Math.max(0, Math.round(window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0));
  var rects = [];
  if (!viewportWidth || !viewportHeight) return { width: viewportWidth, height: viewportHeight, rects: rects };
  for (var i = 0; i < DESKTOP_ICON_SHIELD_TARGETS.length && rects.length < 64; i++) {
    var target = DESKTOP_ICON_SHIELD_TARGETS[i];
    var elements;
    try {
      elements = document.querySelectorAll(target.selector);
    } catch (_) {
      elements = [];
    }
    for (var j = 0; j < elements.length && rects.length < 64; j++) {
      var element = elements[j];
      if (!desktopIconShieldElementVisible(element, target)) continue;
      var clientRects = element.getClientRects ? element.getClientRects() : [];
      for (var k = 0; k < clientRects.length && rects.length < 64; k++) {
        var clipped = desktopIconShieldClippedRect(clientRects[k], viewportWidth, viewportHeight, target.kind);
        if (clipped) rects.push(clipped);
      }
    }
  }
  if (rects.length < 64) {
    var shelfRects = desktopIconShieldShelfRects(viewportWidth, viewportHeight);
    for (var shelfIndex = 0; shelfIndex < shelfRects.length && rects.length < 64; shelfIndex++) {
      if (shelfRects[shelfIndex]) rects.push(shelfRects[shelfIndex]);
    }
  }
  // 锁定软件操作时，右上角必须保留一小块可交互区域：它是唯一能把输入重新接回
  // Mineradio 的通道。把手本身可能处在自动隐藏的过渡里，所以这里按固定几何补一块，
  // 保证这条恢复走廊不会随把手一起从窗口区域里消失。
  // While the software is locked the top-right corner has to stay interactive: it is the only
  // way input can reach Mineradio again. The handle may still be mid auto-hide, so the corridor
  // is added from fixed geometry instead of relying on the handle being visible.
  if (rects.length < 64 && desktopIconShieldModeState().active
    && desktopWallpaperRuntimeState && desktopWallpaperRuntimeState.softwareInteractionLocked === true) {
    var corridorStyle = null;
    try { corridorStyle = window.getComputedStyle(document.documentElement); } catch (_) { }
    var corridorSafeTop = corridorStyle ? parseFloat(corridorStyle.getPropertyValue('--desktop-safe-top')) || 0 : 0;
    var corridorSafeRight = corridorStyle ? parseFloat(corridorStyle.getPropertyValue('--desktop-safe-right')) || 0 : 0;
    rects.push({
      x: Math.max(0, viewportWidth - corridorSafeRight - 92),
      y: Math.max(0, corridorSafeTop),
      width: Math.min(92, viewportWidth),
      height: Math.min(104, viewportHeight),
      kind: 'desktop-controls'
    });
  }
  return { width: viewportWidth, height: viewportHeight, rects: rects };
}

function desktopIconsAreVisible(status) {
  status = status || desktopWallpaperRuntimeState || {};
  return !Object.prototype.hasOwnProperty.call(status, 'desktopIconsVisible')
    || status.desktopIconsVisible !== false;
}

function desktopUsesLayeredExplorerColorkey(status) {
  return !!(status && status.iconLayerMode === 'explorer-layered-colorkey');
}

function clearDesktopIconRevealMask() {
  var shell = document.getElementById('desktop-window-shell');
  if (!shell) return;
  shell.style.removeProperty('-webkit-mask-image');
  shell.style.removeProperty('-webkit-mask-repeat');
  shell.style.removeProperty('-webkit-mask-position');
  shell.style.removeProperty('-webkit-mask-size');
  shell.style.removeProperty('mask-image');
  shell.style.removeProperty('mask-repeat');
  shell.style.removeProperty('mask-position');
  shell.style.removeProperty('mask-size');
}

function applyDesktopIconRevealMask(shieldRects) {
  document.body.classList.remove('desktop-icons-locked');
  clearDesktopIconRevealMask();
}

// 锁定期间把除控制器外的 body 子层逐个钉成 pointer-events:none（内联 !important），
// 因为桌面模式里有几条带 !important 的规则会把 #empty-home / #bottom-bar 强制设回 auto，
// 单靠一条通用 CSS 选择器压不住它们。
// While locked, pin every body child except the controller to pointer-events:none with an inline
// !important. Desktop mode has a few !important rules that force #empty-home / #bottom-bar back
// to auto, so a single generic CSS selector cannot win against them.
function syncDesktopSoftwareLockPointerShield(locked) {
  if (!document.body) return;
  var dock = document.getElementById('desktop-mode-control-dock');
  var roots = Array.prototype.slice.call(document.body.children);
  var shell = document.getElementById('desktop-window-shell');
  if (shell) roots = roots.concat(Array.prototype.slice.call(shell.children));
  for (var i = 0; i < roots.length; i++) {
    var node = roots[i];
    if (!node || node === dock || node.contains(dock)) continue;
    var tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') continue;
    if (locked) {
      if (!node.hasAttribute('data-lock-pointer-prev')) {
        node.setAttribute('data-lock-pointer-prev', node.style.getPropertyValue('pointer-events'));
        node.setAttribute('data-lock-pointer-prev-priority', node.style.getPropertyPriority('pointer-events'));
      }
      node.style.setProperty('pointer-events', 'none', 'important');
    } else if (node.hasAttribute('data-lock-pointer-prev')) {
      var previous = node.getAttribute('data-lock-pointer-prev');
      var priority = node.getAttribute('data-lock-pointer-prev-priority') || '';
      node.removeAttribute('data-lock-pointer-prev');
      node.removeAttribute('data-lock-pointer-prev-priority');
      if (previous) node.style.setProperty('pointer-events', previous, priority);
      else node.style.removeProperty('pointer-events');
    }
  }
}

function updateDesktopModeControl(status) {
  status = status || desktopWallpaperRuntimeState || {};
  var api = getDesktopWindowApi();
  var active = desktopIconShieldModeState().active;
  var softwareLocked = status.softwareInteractionLocked === true;
  var softwareLockButton = document.getElementById('desktop-software-lock-toggle');
  var softwareLockState = document.getElementById('desktop-software-lock-state');
  var iconsVisible = desktopIconsAreVisible(status);
  var iconsButton = document.getElementById('desktop-icons-visible-toggle');
  var iconsState = document.getElementById('desktop-icons-visible-state');
  if (softwareLockButton) {
    var softwareLockSupported = !!(api && typeof api.setDesktopSoftwareLocked === 'function');
    softwareLockButton.setAttribute('aria-checked', softwareLocked ? 'true' : 'false');
    softwareLockButton.setAttribute('aria-busy', desktopSoftwareLockPending ? 'true' : 'false');
    softwareLockButton.disabled = desktopSoftwareLockPending || !active || !softwareLockSupported;
    softwareLockButton.title = softwareLocked ? desktopOverlayFullscreenText('overlay_restore_controls') : desktopOverlayFullscreenText('overlay_give_desktop');
  }
  if (softwareLockState) softwareLockState.textContent = softwareLocked ? desktopOverlayFullscreenText('overlay_locked_unlock_here') : desktopOverlayFullscreenText('overlay_controls_normal');
  if (document.body) document.body.classList.toggle('desktop-software-locked', active && softwareLocked);
  syncDesktopSoftwareLockPointerShield(active && softwareLocked);
  syncDesktopControllerZoneTicker(active && softwareLocked);
  // 锁定软件操作后，这块把手就是唯一的解锁入口：它不能被自动隐藏带走，否则用户
  // 既看不到也点不到同一个开关。锁定期间强制保持可见，解锁后再交还给自动隐藏。
  // While the software is locked this handle is the only way back, so it must survive the
  // auto-hide: keep it visible until the lock is released.
  if (active && softwareLocked) {
    setDesktopModeControlPeek(true);
    cancelDesktopModeControlHide();
    cancelDesktopModeControlPeekHide();
  }
  if (iconsButton) {
    var iconsSupported = !!(api && typeof api.setDesktopIconsVisible === 'function');
    iconsButton.setAttribute('aria-checked', iconsVisible ? 'true' : 'false');
    iconsButton.setAttribute('aria-busy', desktopIconVisibilityPending ? 'true' : 'false');
    iconsButton.disabled = desktopIconVisibilityPending || !active || !iconsSupported;
    iconsButton.title = iconsVisible ? desktopOverlayFullscreenText('overlay_hide_icons') : desktopOverlayFullscreenText('overlay_show_icons');
  }
  if (iconsState) iconsState.textContent = iconsVisible ? desktopOverlayFullscreenText('overlay_icons_shown_short') : desktopOverlayFullscreenText('overlay_icons_hidden_short');
  // 控制器区域的屏幕矩形随锁定/展开/图标层状态变化，随时同步给主进程的光标轮询。
  // The controller's screen rect changes with the lock, the panel and the icon layer; keep the
  // main-process cursor poll fed.
  reportDesktopControllerZone();
}

function updateDesktopIconLockControl(status) {
  updateDesktopModeControl(status);
}

function consumeDesktopModeControlEvent(event) {
  if (!event) return;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  if (typeof event.stopPropagation === 'function') event.stopPropagation();
}

function setDesktopIconsVisibility(desired, event) {
  consumeDesktopModeControlEvent(event);
  var api = getDesktopWindowApi();
  var mode = desktopIconShieldModeState();
  if (!api || typeof api.setDesktopIconsVisible !== 'function' || !mode.active) {
    if (typeof showToast === 'function') showToast(desktopOverlayFullscreenText('overlay_icons_unavailable'));
    return Promise.resolve({ ok: false, error: 'DESKTOP_ICON_VISIBILITY_INACTIVE' });
  }
  if (desktopIconVisibilityPending) return Promise.resolve({ ok: false, error: 'DESKTOP_ICON_VISIBILITY_BUSY' });
  desired = desired !== false;
  var operation = ++desktopIconVisibilityOperation;
  desktopIconVisibilityPending = true;
  updateDesktopModeControl(desktopWallpaperRuntimeState);
  return Promise.resolve(api.setDesktopIconsVisible(desired)).then(function (result) {
    if (operation !== desktopIconVisibilityOperation) return result;
    result = result && typeof result === 'object' ? result : { ok: false, error: 'DESKTOP_ICON_VISIBILITY_RESULT_INVALID' };
    if (result.status) {
      applyDesktopWallpaperRuntimeStatus(result.status);
    } else if (result.ok === true) {
      desktopWallpaperRuntimeState.desktopIconsVisible = desired;
      updateDesktopModeControl(desktopWallpaperRuntimeState);
    }
    if (typeof showToast === 'function') {
      showToast(result.ok === true
        ? (desired ? desktopOverlayFullscreenText('overlay_icons_shown') : desktopOverlayFullscreenText('overlay_icons_hidden'))
        : (desired ? desktopOverlayFullscreenText('overlay_icons_show_failed') : desktopOverlayFullscreenText('overlay_icons_hide_failed')));
    }
    return result;
  }).catch(function (error) {
    if (operation !== desktopIconVisibilityOperation) return { ok: false, error: String(error && error.message || error) };
    if (typeof showToast === 'function') showToast(desired ? desktopOverlayFullscreenText('overlay_icons_show_failed') : desktopOverlayFullscreenText('overlay_icons_hide_failed'));
    return { ok: false, error: String(error && error.message || error) };
  }).then(function (result) {
    if (operation === desktopIconVisibilityOperation) {
      desktopIconVisibilityPending = false;
      updateDesktopModeControl(desktopWallpaperRuntimeState);
      scheduleDesktopIconShieldReport(false);
    }
    return result;
  });
}

function toggleDesktopIconsVisibility(event) {
  return setDesktopIconsVisibility(!desktopIconsAreVisible(desktopWallpaperRuntimeState), event);
}

function requestDesktopKeyboardFocus(reason) {
  var api = getDesktopWindowApi();
  var mode = desktopIconShieldModeState();
  if (!api || typeof api.requestDesktopKeyboardFocus !== 'function'
    || !mode.active
    || desktopWallpaperRuntimeState.softwareInteractionLocked === true) return false;
  try {
    Promise.resolve(api.requestDesktopKeyboardFocus(reason || 'renderer-pointerdown')).catch(function () {});
    return true;
  } catch (_) {
    return false;
  }
}

function setDesktopSoftwareInteractionLocked(desired, event) {
  var restoreKeyboardFocus = desired !== true && !!(event && event.isTrusted);
  consumeDesktopModeControlEvent(event);
  var api = getDesktopWindowApi();
  var mode = desktopIconShieldModeState();
  if (!api || typeof api.setDesktopSoftwareLocked !== 'function' || !mode.active) {
    if (typeof showToast === 'function') showToast(desktopOverlayFullscreenText('overlay_lock_unavailable'));
    return Promise.resolve({ ok: false, error: 'DESKTOP_SOFTWARE_LOCK_INACTIVE' });
  }
  if (desktopSoftwareLockPending) return Promise.resolve({ ok: false, error: 'DESKTOP_SOFTWARE_LOCK_BUSY' });
  desired = desired === true;
  var operation = ++desktopSoftwareLockOperation;
  desktopSoftwareLockPending = true;
  updateDesktopModeControl(desktopWallpaperRuntimeState);
  return Promise.resolve(api.setDesktopSoftwareLocked(desired)).then(function (result) {
    if (operation !== desktopSoftwareLockOperation) return result;
    result = result && typeof result === 'object' ? result : { ok: false, error: 'DESKTOP_SOFTWARE_LOCK_RESULT_INVALID' };
    if (result.status) {
      applyDesktopWallpaperRuntimeStatus(result.status);
    } else if (result.ok === true) {
      desktopWallpaperRuntimeState.softwareInteractionLocked = desired;
      updateDesktopModeControl(desktopWallpaperRuntimeState);
    }
    if (typeof showToast === 'function') {
      showToast(result.ok === true
        ? (desired ? desktopOverlayFullscreenText('overlay_controls_locked') : desktopOverlayFullscreenText('overlay_controls_restored'))
        : (desired ? desktopOverlayFullscreenText('overlay_lock_failed') : desktopOverlayFullscreenText('overlay_unlock_failed')));
    }
    if (result.ok === true && restoreKeyboardFocus) {
      requestDesktopKeyboardFocus('software-unlocked');
    }
    return result;
  }).catch(function (error) {
    if (operation !== desktopSoftwareLockOperation) return { ok: false, error: String(error && error.message || error) };
    if (typeof showToast === 'function') showToast(desired ? desktopOverlayFullscreenText('overlay_lock_failed') : desktopOverlayFullscreenText('overlay_unlock_failed'));
    return { ok: false, error: String(error && error.message || error) };
  }).then(function (result) {
    if (operation === desktopSoftwareLockOperation) {
      desktopSoftwareLockPending = false;
      updateDesktopModeControl(desktopWallpaperRuntimeState);
      scheduleDesktopPointerRouteReport(null, true);
    }
    return result;
  });
}

function toggleDesktopSoftwareInteractionLocked(event) {
  return setDesktopSoftwareInteractionLocked(!(desktopWallpaperRuntimeState
    && desktopWallpaperRuntimeState.softwareInteractionLocked === true), event);
}

function cancelDesktopModeControlHide() {
  if (!desktopModeControlDockState.hideTimer) return;
  clearTimeout(desktopModeControlDockState.hideTimer);
  desktopModeControlDockState.hideTimer = 0;
}

function cancelDesktopModeControlPeekHide() {
  if (!desktopModeControlDockState.peekTimer) return;
  clearTimeout(desktopModeControlDockState.peekTimer);
  desktopModeControlDockState.peekTimer = 0;
}

function cancelDesktopModeControlOpen() {
  if (!desktopModeControlDockState.openTimer) return;
  clearTimeout(desktopModeControlDockState.openTimer);
  desktopModeControlDockState.openTimer = 0;
}

// 鼠标停在把手上片刻即展开控制面板，移开就收起来；面板里两个开关（锁定/图标）随之可点。
// Hovering the handle for a moment expands the control panel, leaving collapses it; the two
// switches inside (software lock / desktop icons) are then clickable.
function scheduleDesktopModeControlOpen(delay, force) {
  cancelDesktopModeControlOpen();
  if (desktopModeControlDockState.open || desktopModeControlDockState.hoverReopenBlocked) return;
  desktopModeControlDockState.openTimer = setTimeout(function () {
    desktopModeControlDockState.openTimer = 0;
    if (desktopModeControlDockState.open || desktopModeControlDockState.hoverReopenBlocked) return;
    // 主进程轮询出来的悬停不需要再用转发坐标复核（锁定期间渲染进程根本收不到 mousemove）。
    // Hover reported by the main-process cursor poll cannot be re-checked against forwarded
    // coordinates: while locked the renderer receives no mousemove at all.
    if (force !== true) {
      if (!desktopPointerRouteReporter.hasPointer) return;
      var pointState = desktopControlPointState(desktopPointerRouteReporter.x, desktopPointerRouteReporter.y);
      if (!pointState.overHotspot && !pointState.overPanel && !pointState.overDock) return;
    }
    setDesktopModeControlsOpen(true);
  }, Math.max(60, Number(delay) || 160));
}

function setDesktopModeControlPeek(peek) {
  peek = peek === true && desktopIconShieldModeState().active;
  if (peek) cancelDesktopModeControlPeekHide();
  if (desktopModeControlDockState.peek === peek) return;
  desktopModeControlDockState.peek = peek;
  if (document.body) document.body.classList.toggle('desktop-mode-control-peek', peek);
  scheduleDesktopIconShieldReport(false);
  reportDesktopControllerZone();
}

function scheduleDesktopModeControlPeekHide(delay) {
  // 锁定软件操作时把手是唯一解锁入口，永远不自动隐藏。
  // While the software is locked this handle is the only way back, so it never hides itself.
  if (desktopWallpaperRuntimeState && desktopWallpaperRuntimeState.softwareInteractionLocked === true) {
    setDesktopModeControlPeek(true);
    return;
  }
  cancelDesktopModeControlPeekHide();
  desktopModeControlDockState.peekTimer = setTimeout(function () {
    desktopModeControlDockState.peekTimer = 0;
    var dock = document.getElementById('desktop-mode-control-dock');
    if (desktopModeControlDockState.open
      || (dock && (dock.matches(':hover') || dock.contains(document.activeElement)))) return;
    setDesktopModeControlPeek(false);
  }, Math.max(180, Number(delay) || 980));
}

function setDesktopModeControlsOpen(open) {
  open = open === true && desktopIconShieldModeState().active;
  cancelDesktopModeControlHide();
  cancelDesktopModeControlOpen();
  if (open) setDesktopModeControlPeek(true);
  if (desktopModeControlDockState.open === open) return;
  desktopModeControlDockState.open = open;
  var dock = document.getElementById('desktop-mode-control-dock');
  var handle = document.getElementById('desktop-mode-control-handle');
  var panel = document.getElementById('desktop-mode-control-panel');
  if (dock) dock.classList.toggle('is-open', open);
  if (handle) handle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (panel) {
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) panel.removeAttribute('inert');
    else panel.setAttribute('inert', '');
    panel.querySelectorAll('button').forEach(function (button) {
      button.tabIndex = open ? 0 : -1;
    });
  }
  document.body.classList.toggle('desktop-mode-controls-open', open);
  if (!open) scheduleDesktopModeControlPeekHide(900);
  scheduleDesktopIconShieldReport(false);
  // 锁定期间不能拿上一帧的坐标去重算路由（否则面板刚由悬停展开就被判成「鼠标已离开」）。
  // While locked, stale coordinates must not re-run the route right after hover opened the panel.
  if (!(desktopWallpaperRuntimeState && desktopWallpaperRuntimeState.softwareInteractionLocked === true)) {
    scheduleDesktopPointerRouteReport(null, true);
  }
  reportDesktopControllerZone();
}

function scheduleDesktopModeControlHide(delay) {
  cancelDesktopModeControlHide();
  desktopModeControlDockState.hideTimer = setTimeout(function () {
    desktopModeControlDockState.hideTimer = 0;
    var dock = document.getElementById('desktop-mode-control-dock');
    if (dock && (dock.matches(':hover') || dock.contains(document.activeElement))) return;
    setDesktopModeControlsOpen(false);
  }, Math.max(120, Number(delay) || 680));
}

function desktopPointInClientRect(x, y, rect) {
  return !!rect && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

// 锁定期间主进程要靠这个矩形判断光标是否落在控制器上；坐标换算成屏幕坐标（DIP）。
// The main process polls the real cursor against this rect while locked, so report it in screen
// (DIP) coordinates.
function desktopControllerScreenRect() {
  var mode = desktopIconShieldModeState();
  if (!mode.active) return null;
  var rects = [];
  function pushNode(node) {
    if (!node) return;
    var rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  // 控制器是本进程自己的元素，直接取矩形：锁定后界面整体退出命中，可见性辅助函数会把
  // pointer-events:none 的元素判成不可用，反而把它排除在轮询区之外。
  pushNode(document.getElementById('desktop-mode-control-handle'));
  if (desktopModeControlDockState.open) {
    pushNode(document.getElementById('desktop-mode-control-panel'));
    pushNode(document.getElementById('desktop-mode-control-dock'));
  }
  var rootStyle = null;
  try { rootStyle = window.getComputedStyle(document.documentElement); } catch (_) { }
  var safeTop = rootStyle ? parseFloat(rootStyle.getPropertyValue('--desktop-safe-top')) || 0 : 0;
  var safeRight = rootStyle ? parseFloat(rootStyle.getPropertyValue('--desktop-safe-right')) || 0 : 0;
  rects.push({
    left: Math.max(0, window.innerWidth - safeRight - 110),
    top: safeTop,
    right: Math.max(0, window.innerWidth - safeRight),
    bottom: safeTop + 190
  });
  var left = Infinity;
  var top = Infinity;
  var right = -Infinity;
  var bottom = -Infinity;
  for (var i = 0; i < rects.length; i += 1) {
    left = Math.min(left, rects[i].left);
    top = Math.min(top, rects[i].top);
    right = Math.max(right, rects[i].right);
    bottom = Math.max(bottom, rects[i].bottom);
  }
  if (!isFinite(left) || right <= left || bottom <= top) return null;
  var offsetX = Number(window.screenX) || 0;
  var offsetY = Number(window.screenY) || 0;
  return {
    x: Math.round(offsetX + left),
    y: Math.round(offsetY + top),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  };
}

function reportDesktopControllerZone() {
  var api = getDesktopWindowApi();
  if (!api || typeof api.setDesktopControllerZone !== 'function') return;
  var rect = desktopControllerScreenRect();
  try {
    api.setDesktopControllerZone(rect || { x: 0, y: 0, width: 0, height: 0 });
  } catch (_) { }
}

// 锁定期间面板会展开、尺寸会变，主进程的光标轮询必须拿到最新矩形；除了状态变化时同步，
// 再挂一个低频心跳兜底，避免漏报导致「面板看得见但点不到」。
// While locked the panel expands and changes size, and the main-process cursor poll needs the
// current rect; besides syncing on state changes, a low-frequency heartbeat makes sure a missed
// report cannot leave the panel visible but unclickable.
var desktopControllerZoneTicker = 0;
function syncDesktopControllerZoneTicker(active) {
  active = active === true;
  if (!active) {
    if (desktopControllerZoneTicker) {
      clearInterval(desktopControllerZoneTicker);
      desktopControllerZoneTicker = 0;
    }
    return;
  }
  if (desktopControllerZoneTicker) return;
  desktopControllerZoneTicker = setInterval(reportDesktopControllerZone, 250);
}

function desktopControlPointState(x, y) {
  var handle = document.getElementById('desktop-mode-control-handle');
  var panel = document.getElementById('desktop-mode-control-panel');
  var rootStyle = null;
  try { rootStyle = window.getComputedStyle(document.documentElement); } catch (_) { }
  var safeTop = rootStyle ? parseFloat(rootStyle.getPropertyValue('--desktop-safe-top')) || 0 : 0;
  var safeRight = rootStyle ? parseFloat(rootStyle.getPropertyValue('--desktop-safe-right')) || 0 : 0;
  var overRevealEdge = x >= Math.max(0, window.innerWidth - safeRight - 110)
    && x < Math.max(0, window.innerWidth - safeRight)
    && y >= safeTop && y < safeTop + 190;
  var overHotspot = !!(handle && desktopIconShieldElementVisible(handle, { ignoreAriaHidden: true })
    && desktopPointInClientRect(x, y, handle.getBoundingClientRect()));
  var overPanel = !!(desktopModeControlDockState.open && panel
    && desktopIconShieldElementVisible(panel, { ignoreAriaHidden: true })
    && desktopPointInClientRect(x, y, panel.getBoundingClientRect()));
  // 面板展开后，把手与面板之间有几像素空隙；算上整个 dock 才不会在移过去的中途被判定为「已离开」。
  // The gap between handle and panel is a few pixels; counting the whole dock keeps moving into
  // the panel from being read as "pointer left the controls".
  var dock = document.getElementById('desktop-mode-control-dock');
  var overDock = !!(desktopModeControlDockState.open && dock
    && desktopIconShieldElementVisible(dock, { ignoreAriaHidden: true })
    && desktopPointInClientRect(x, y, dock.getBoundingClientRect()));
  return {
    overRevealEdge: overRevealEdge,
    overHotspot: overHotspot,
    overPanel: overPanel,
    overDock: overDock,
    overControls: overRevealEdge || overHotspot || overPanel || overDock
  };
}

function desktopPointerOverSoftwareUi(x, y) {
  var collected = collectDesktopIconShieldRects();
  for (var i = 0; i < collected.rects.length; i++) {
    var rect = collected.rects[i];
    if (!rect || rect.kind === 'desktop-controls') continue;
    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) return true;
  }
  return false;
}

function flushDesktopPointerRouteReport(force) {
  if (desktopPointerRouteReporter.timer) {
    clearTimeout(desktopPointerRouteReporter.timer);
    desktopPointerRouteReporter.timer = 0;
  }
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateDesktopPointerRoute !== 'function') return;
  var mode = desktopIconShieldModeState();
  var softwareLocked = !!(desktopWallpaperRuntimeState
    && desktopWallpaperRuntimeState.softwareInteractionLocked === true);
  var overSoftwareUi = false;
  var overDesktopControls = false;
  // 锁定期间窗口是点击穿透的，转发坐标可能根本收不到；可点击区域交给主进程轮询。
  // While locked the window is click-through and forwarded coordinates may never arrive, so the
  // clickable route is driven by the main-process poll instead.
  if (mode.active && desktopPointerRouteReporter.hasPointer && !softwareLocked) {
    var pointState = desktopControlPointState(desktopPointerRouteReporter.x, desktopPointerRouteReporter.y);
    overDesktopControls = pointState.overControls;
    if (overDesktopControls) {
      setDesktopModeControlPeek(true);
      cancelDesktopModeControlHide();
      cancelDesktopModeControlPeekHide();
      // 鼠标停在把手上 → 展开；（点关闭后要等鼠标移开才允许再次悬停展开）
      // Hovering the handle expands the panel; after an explicit close it waits for the pointer
      // to leave before hover may reopen it.
      if (pointState.overHotspot || pointState.overPanel || pointState.overDock) {
        scheduleDesktopModeControlOpen(160);
      } else {
        cancelDesktopModeControlOpen();
      }
    }
    else {
      cancelDesktopModeControlOpen();
      desktopModeControlDockState.hoverReopenBlocked = false;
      if (desktopModeControlDockState.open) {
        scheduleDesktopModeControlHide(desktopWallpaperRuntimeState
          && desktopWallpaperRuntimeState.softwareInteractionLocked === true ? 220 : 680);
      } else scheduleDesktopModeControlPeekHide(980);
    }
    overSoftwareUi = desktopPointerOverSoftwareUi(desktopPointerRouteReporter.x, desktopPointerRouteReporter.y);
  }
  var key = (overSoftwareUi ? '1' : '0') + '|' + (overDesktopControls ? '1' : '0');
  if (!force && key === desktopPointerRouteReporter.lastKey) return;
  desktopPointerRouteReporter.lastKey = key;
  try {
    api.updateDesktopPointerRoute({
      overSoftwareUi: overSoftwareUi,
      overDesktopControls: overDesktopControls
    });
  } catch (_) { }
}

function scheduleDesktopPointerRouteReport(event, force) {
  if (event && isFinite(event.clientX) && isFinite(event.clientY)) {
    desktopPointerRouteReporter.x = Number(event.clientX);
    desktopPointerRouteReporter.y = Number(event.clientY);
    desktopPointerRouteReporter.hasPointer = true;
    var mode = desktopIconShieldModeState();
    var nextOverControls = mode.active
      && desktopControlPointState(desktopPointerRouteReporter.x, desktopPointerRouteReporter.y).overControls;
    if (nextOverControls !== desktopPointerRouteReporter.overControls) force = true;
    desktopPointerRouteReporter.overControls = nextOverControls;
  }
  if (force === true) desktopPointerRouteReporter.forcePending = true;
  if (desktopPointerRouteReporter.timer) {
    if (force !== true) return;
    clearTimeout(desktopPointerRouteReporter.timer);
    desktopPointerRouteReporter.timer = 0;
  }
  desktopPointerRouteReporter.timer = setTimeout(function () {
    var forcePending = desktopPointerRouteReporter.forcePending;
    desktopPointerRouteReporter.forcePending = false;
    flushDesktopPointerRouteReport(forcePending);
  }, force === true ? 0 : 48);
}

function initDesktopModeControls(api) {
  var dock = document.getElementById('desktop-mode-control-dock');
  var handle = document.getElementById('desktop-mode-control-handle');
  var panel = document.getElementById('desktop-mode-control-panel');
  var softwareLockButton = document.getElementById('desktop-software-lock-toggle');
  var iconsButton = document.getElementById('desktop-icons-visible-toggle');
  if (!dock || !handle || !panel) return;
  setDesktopModeControlsOpen(false);
  handle.addEventListener('click', function (event) {
    consumeDesktopModeControlEvent(event);
    var nextOpen = !desktopModeControlDockState.open;
    // 点关闭后鼠标通常还停在把手上，此时禁止悬停立即重开，等指针离开再恢复。
    // Clicking to close usually leaves the pointer on the handle; block hover-reopen until it leaves.
    desktopModeControlDockState.hoverReopenBlocked = !nextOpen;
    setDesktopModeControlsOpen(nextOpen);
  });
  handle.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') {
      consumeDesktopModeControlEvent(event);
      setDesktopModeControlsOpen(true);
      if (softwareLockButton) softwareLockButton.focus();
      else if (iconsButton) iconsButton.focus();
    }
  });
  dock.addEventListener('mouseenter', function () {
    setDesktopModeControlPeek(true);
    cancelDesktopModeControlHide();
    cancelDesktopModeControlPeekHide();
  });
  dock.addEventListener('mouseleave', function () {
    scheduleDesktopModeControlHide(680);
    scheduleDesktopModeControlPeekHide(980);
  });
  dock.addEventListener('focusin', function () {
    setDesktopModeControlPeek(true);
    cancelDesktopModeControlHide();
    cancelDesktopModeControlPeekHide();
  });
  dock.addEventListener('focusout', function () {
    scheduleDesktopModeControlHide(680);
    scheduleDesktopModeControlPeekHide(980);
  });
  dock.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    consumeDesktopModeControlEvent(event);
    setDesktopModeControlsOpen(false);
    handle.focus();
  });
  if (softwareLockButton) softwareLockButton.addEventListener('click', toggleDesktopSoftwareInteractionLocked);
  if (iconsButton) iconsButton.addEventListener('click', toggleDesktopIconsVisibility);
  document.addEventListener('pointerdown', function (event) {
    if (event && event.isTrusted) requestDesktopKeyboardFocus('pointerdown');
    if (!desktopModeControlDockState.open || dock.contains(event.target)) return;
    var focused = document.activeElement;
    if (focused && panel.contains(focused) && typeof focused.blur === 'function') focused.blur();
    setDesktopModeControlsOpen(false);
  }, true);
  document.addEventListener('mousemove', function (event) {
    scheduleDesktopPointerRouteReport(event, false);
  }, { passive: true });
  // 锁定期间渲染进程收不到任何鼠标事件，悬停/移开的判定改由主进程轮询真实光标后推送。
  // While locked the renderer receives no mouse events at all, so hover/leave is reported by the
  // main process after polling the real cursor.
  if (typeof api.onDesktopControllerHover === 'function') {
    api.onDesktopControllerHover(function (over) {
      if (over) {
        setDesktopModeControlPeek(true);
        cancelDesktopModeControlHide();
        cancelDesktopModeControlPeekHide();
        scheduleDesktopModeControlOpen(40, true);
        return;
      }
      cancelDesktopModeControlOpen();
      // 转发坐标仍认为指针在控制器上时，不要因为轮询的矩形偏差把面板收掉。
      // Do not close on a poll miss while forwarded coordinates still say the pointer is on the
      // controller.
      if (desktopPointerRouteReporter.overControls) return;
      setDesktopModeControlsOpen(false);
    });
  }
  window.addEventListener('resize', reportDesktopControllerZone);
  window.addEventListener('blur', function () {
    setDesktopModeControlsOpen(false);
    scheduleDesktopModeControlPeekHide(360);
  });
  window.addEventListener('pagehide', function () {
    cancelDesktopModeControlHide();
    cancelDesktopModeControlPeekHide();
    desktopPointerRouteReporter.hasPointer = false;
    desktopPointerRouteReporter.overControls = false;
    flushDesktopPointerRouteReport(true);
  }, { once: true });
  updateDesktopModeControl(desktopWallpaperRuntimeState);
  setDesktopModeControlPeek(false);
  scheduleDesktopPointerRouteReport(null, true);
}

function desktopIconShieldPayloadKey(payload) {
  var rectKey = [];
  var rects = payload.rects || [];
  for (var i = 0; i < rects.length; i++) {
    var rect = rects[i];
    rectKey.push([rect.x, rect.y, rect.width, rect.height, rect.kind || ''].join(','));
  }
  return [
    payload.enabled ? 1 : 0,
    payload.interactive ? 1 : 0,
    payload.viewport.width,
    payload.viewport.height,
    payload.viewport.scaleFactor,
    payload.runtimeGeneration,
    rectKey.join(';')
  ].join('|');
}

function flushDesktopIconShieldReport(forceEmpty) {
  if (desktopIconShieldReporter.timer) {
    clearTimeout(desktopIconShieldReporter.timer);
    desktopIconShieldReporter.timer = 0;
  }
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateDesktopIconShields !== 'function') return;
  var mode = desktopIconShieldModeState();
  var collected = mode.active && !forceEmpty
    ? collectDesktopIconShieldRects()
    : {
      width: Math.max(0, Math.round(window.innerWidth || 0)),
      height: Math.max(0, Math.round(window.innerHeight || 0)),
      rects: []
    };
  applyDesktopIconRevealMask(forceEmpty ? [] : collected.rects);
  var payload = {
    enabled: mode.enabled,
    interactive: mode.interactive,
    viewport: {
      width: collected.width,
      height: collected.height,
      scaleFactor: Math.max(0.25, Number(window.devicePixelRatio) || 1)
    },
    runtimeGeneration: Math.max(-1, Number(desktopWallpaperRuntimeState && desktopWallpaperRuntimeState.generation) || 0),
    rects: forceEmpty ? [] : collected.rects.slice(0, 64)
  };
  var key = desktopIconShieldPayloadKey(payload);
  if (key === desktopIconShieldReporter.lastKey) return;
  desktopIconShieldReporter.lastKey = key;
  try {
    api.updateDesktopIconShields(payload);
  } catch (_) { }
}

function scheduleDesktopIconShieldReport(forceEmpty) {
  desktopIconShieldReporter.forceEmptyPending = forceEmpty === true;
  if (desktopIconShieldReporter.timer) return;
  desktopIconShieldReporter.timer = setTimeout(function () {
    var pendingForceEmpty = desktopIconShieldReporter.forceEmptyPending;
    desktopIconShieldReporter.forceEmptyPending = false;
    flushDesktopIconShieldReport(pendingForceEmpty);
  }, 100);
}

function desktopIconShieldMutationRelevant(mutation) {
  if (!mutation) return false;
  var target = mutation.target && mutation.target.nodeType === 1 ? mutation.target : null;
  if (target === document.documentElement || target === document.body) return true;
  try {
    if (target && (target.matches(DESKTOP_ICON_SHIELD_SELECTOR) || target.closest(DESKTOP_ICON_SHIELD_SELECTOR))) return true;
  } catch (_) { }
  if (mutation.type !== 'childList') return false;
  var nodes = [];
  if (mutation.addedNodes) nodes = nodes.concat(Array.prototype.slice.call(mutation.addedNodes));
  if (mutation.removedNodes) nodes = nodes.concat(Array.prototype.slice.call(mutation.removedNodes));
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (!node || node.nodeType !== 1) continue;
    try {
      if (node.matches(DESKTOP_ICON_SHIELD_SELECTOR) || node.querySelector(DESKTOP_ICON_SHIELD_SELECTOR)) return true;
    } catch (_) { }
  }
  return false;
}

function refreshDesktopIconShieldResizeTargets() {
  var observer = desktopIconShieldReporter.resizeObserver;
  if (!observer) return;
  var next = [];
  for (var i = 0; i < DESKTOP_ICON_SHIELD_TARGETS.length; i++) {
    var elements;
    try {
      elements = document.querySelectorAll(DESKTOP_ICON_SHIELD_TARGETS[i].selector);
    } catch (_) {
      elements = [];
    }
    for (var j = 0; j < elements.length; j++) {
      if (next.indexOf(elements[j]) < 0) next.push(elements[j]);
    }
  }
  var previous = desktopIconShieldReporter.observedElements;
  for (var p = 0; p < previous.length; p++) {
    if (next.indexOf(previous[p]) < 0 && observer.unobserve) {
      try { observer.unobserve(previous[p]); } catch (_) { }
    }
  }
  for (var n = 0; n < next.length; n++) {
    if (previous.indexOf(next[n]) < 0) {
      try { observer.observe(next[n]); } catch (_) { }
    }
  }
  desktopIconShieldReporter.observedElements = next;
}

function initDesktopIconShieldReporter(api) {
  if (!api || typeof api.updateDesktopIconShields !== 'function') return;
  if (typeof window.ResizeObserver === 'function') {
    desktopIconShieldReporter.resizeObserver = new ResizeObserver(function () {
      scheduleDesktopIconShieldReport(false);
    });
    refreshDesktopIconShieldResizeTargets();
  }
  if (typeof window.MutationObserver === 'function') {
    desktopIconShieldReporter.mutationObserver = new MutationObserver(function (mutations) {
      var relevant = false;
      var refreshTargets = false;
      for (var i = 0; i < mutations.length; i++) {
        if (!desktopIconShieldMutationRelevant(mutations[i])) continue;
        relevant = true;
        if (mutations[i].type === 'childList') refreshTargets = true;
      }
      if (!relevant) return;
      if (refreshTargets) refreshDesktopIconShieldResizeTargets();
      scheduleDesktopIconShieldReport(false);
    });
    desktopIconShieldReporter.mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden']
    });
  }
  window.addEventListener('resize', function () { scheduleDesktopIconShieldReport(false); }, { passive: true });
  document.addEventListener('transitionend', function () { scheduleDesktopIconShieldReport(false); }, true);
  document.addEventListener('animationend', function () { scheduleDesktopIconShieldReport(false); }, true);
  document.addEventListener('click', function () { scheduleDesktopIconShieldReport(false); }, true);
  document.addEventListener('contextmenu', function () { scheduleDesktopIconShieldReport(false); }, true);
  document.addEventListener('input', function () { scheduleDesktopIconShieldReport(false); }, true);
  document.addEventListener('change', function () { scheduleDesktopIconShieldReport(false); }, true);
  document.addEventListener('visibilitychange', function () {
    scheduleDesktopIconShieldReport(document.visibilityState === 'hidden');
  });
  // Three.js shelf cards move without DOM mutations. A low-rate timer follows
  // only an actually interactive shelf; it is not a mouse loop or an rAF and
  // dedupe prevents IPC when the projected hit envelope has not changed.
  desktopIconShieldReporter.shelfTimer = setInterval(function () {
    if (!desktopIconShieldModeState().active || !desktopIconShieldShelfNeedsGeometryTracking()) return;
    scheduleDesktopIconShieldReport(false);
  }, 250);
  window.addEventListener('pagehide', function () {
    if (desktopIconShieldReporter.shelfTimer) clearInterval(desktopIconShieldReporter.shelfTimer);
    desktopIconShieldReporter.shelfTimer = 0;
    flushDesktopIconShieldReport(true);
  }, { once: true });
  scheduleDesktopIconShieldReport(false);
}
function currentDesktopSongMeta() {
  var song = playQueue && currentIdx >= 0 ? playQueue[currentIdx] : null;
  song = song || currentLyricSong && currentLyricSong() || {};
  return {
    title: song.name || song.title || 'Mineradio',
    artist: song.artist || song.ar || song.author || '',
    cover: (typeof songCoverSrc === 'function' && song) ? (songCoverSrc(song, 360) || song.cover || '') : (song.cover || '')
  };
}
function normalizeDesktopLyricText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
function currentDesktopLyricSnapshot() {
  // 先问运行时缓存：窗口隐藏时渲染循环会停，但缓存由音频事件 + 250ms 心跳推进，
  // 所以这里拿到的一定是当前这一首的当前句，而不是上一首留下的残影。
  // Ask the runtime cache first. The render loop stalls while the window is hidden, but the
  // cache keeps advancing on audio events and a heartbeat, so this never returns the line we
  // were on before the track changed.
  var cached = typeof lyricRuntimeSnapshot === 'function' ? lyricRuntimeSnapshot(900) : null;
  if (cached && cached.updatedAt) {
    var cachedText = normalizeDesktopLyricText(cached.text || '');
    if (cachedText) {
      return {
        text: cachedText,
        progress: clampRange(Number(cached.progress) || 0, 0, 1),
        progressSpan: Math.max(0.75, Number(cached.span) || 4.8)
      };
    }
  }
  var rawT = audio && isFinite(audio.currentTime) ? Number(audio.currentTime) : 0;
  var t = typeof getAdjustedLyricPlaybackTime === 'function' ? getAdjustedLyricPlaybackTime(rawT) : rawT;
  var lines = Array.isArray(lyricsLines) ? lyricsLines : [];
  if (playing && audio && lines.length) {
    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].t <= t + 0.05) idx = i;
      else break;
    }
    if (idx >= 0) {
      var curLine = lines[idx] || { t: t, text: '' };
      var nextLine = lines[idx + 1];
      var nextT = nextLine && nextLine.t > curLine.t ? nextLine.t : Math.min((audio && audio.duration) || t + 4, curLine.t + (curLine.duration || 4.8));
      var span = Math.max(0.75, nextT - curLine.t);
      return {
        text: normalizeDesktopLyricText(curLine.text || currentLyricFallbackText()),
        progress: getLyricLineProgress(curLine, nextLine, t),
        progressSpan: span
      };
    }
    var introText = normalizeDesktopLyricText(currentLyricFallbackText());
    if (introText) {
      var firstLine = lines[0];
      var introEnd = firstLine && firstLine.t > 0 ? firstLine.t : Math.min((audio && audio.duration) || 4.8, 4.8);
      return {
        text: introText,
        progress: getLyricLineProgress({ t: 0, text: introText, duration: Math.max(0.8, introEnd), charCount: Math.max(1, introText.length), fallback: true }, null, t),
        progressSpan: Math.max(0.8, introEnd)
      };
    }
  }
  if (stageLyrics && stageLyrics.currentText) {
    return {
      text: normalizeDesktopLyricText(stageLyrics.currentText),
      progress: stageLyrics.current && stageLyrics.current.userData ? clampRange(Number(stageLyrics.current.userData.lastLyricProgress) || 0, 0, 1) : 0,
      progressSpan: 4.8
    };
  }
  return { text: normalizeDesktopLyricText(currentDesktopSongMeta().title || 'Mineradio'), progress: 0, progressSpan: 4.8 };
}
function desktopOverlayColorValue(value, fallback) {
  var raw = String(value || '').trim();
  fallback = String(fallback || '#d6f8ff').trim();
  if (/^#[0-9a-f]{3}$/i.test(raw) || /^#[0-9a-f]{6}$/i.test(raw)) return normalizeHexColor(raw, fallback);
  if (/^rgba?\(/i.test(raw) || /^hsla?\(/i.test(raw)) return raw;
  return normalizeHexColor(raw, fallback);
}
function desktopOverlayColors() {
  var pal = stageLyrics && stageLyrics.palette || {};
  return {
    primary: desktopOverlayColorValue(pal.primary || fx.lyricColor || '#d6f8ff', '#d6f8ff'),
    secondary: desktopOverlayColorValue(pal.secondary || fx.visualTintColor || '#9cffdf', '#9cffdf'),
    highlight: desktopOverlayColorValue(pal.highlight || fx.lyricHighlightColor || '#fff0b8', '#fff0b8'),
    glow: desktopOverlayColorValue(pal.glowColor || pal.secondary || pal.primary || fx.lyricGlowColor || '#9cffdf', '#9cffdf')
  };
}
function desktopLyricsMotionPayload() {
  return {
    lyricGlow: !!fx.lyricGlow,
    lyricGlowBeat: !!fx.lyricGlowBeat,
    lyricGlowStrength: fx.lyricGlow ? clampRange(Number(fx.lyricGlowStrength) || 0, 0, 0.85) : 0,
    highBloom: stageLyrics && isFinite(stageLyrics.highBloom) ? clampRange(stageLyrics.highBloom, 0, 1.45) : 0,
    beatGlow: stageLyrics && isFinite(stageLyrics.beatGlow) ? clampRange(stageLyrics.beatGlow, 0, 1.7) : 0,
    beatPulse: isFinite(beatPulse) ? clampRange(beatPulse, 0, 1.4) : 0,
    bass: isFinite(bass) ? clampRange(bass, 0, 1.2) : 0
  };
}
function desktopLyricsPlaybackPayload() {
  var time = audio && isFinite(audio.currentTime) ? Number(audio.currentTime) : 0;
  var duration = audio && isFinite(audio.duration) ? Number(audio.duration) : 0;
  var rate = audio && isFinite(audio.playbackRate) && audio.playbackRate > 0 ? Number(audio.playbackRate) : 1;
  return {
    time: Math.max(0, time),
    duration: Math.max(0, duration),
    rate: clampRange(rate, 0.25, 4)
  };
}
function desktopLyricsActiveBeatMap() {
  var useDj = !!(djMode && djMode.active && currentDjBeatMap);
  return {
    source: useDj ? 'dj' : 'mr',
    map: useDj ? currentDjBeatMap : currentBeatMap
  };
}
function desktopLyricsBeatMapPayload(force) {
  var selected = desktopLyricsActiveBeatMap();
  var map = selected && selected.map;
  var source = selected && selected.source || 'mr';
  var cameraCount = map ? ((map.cameraBeats && map.cameraBeats.length) || (map.beats && map.beats.length) || (map.kicks && map.kicks.length) || 0) : 0;
  var pulseCount = map ? ((map.pulseBeats && map.pulseBeats.length) || (map.kicks && map.kicks.length) || 0) : 0;
  var duration = map && isFinite(map.duration) ? Number(map.duration) : 0;
  var partialUntil = map && isFinite(map.partialUntilSec) ? Number(map.partialUntilSec) : 0;
  var key = map
    ? [source, map.analyzedAt || 0, cameraCount, pulseCount, Math.round(duration * 10), Math.round(partialUntil * 10), map.tempoSource || 'local'].join('|')
    : 'none';
  var shouldSendMap = !!force || key !== desktopOverlayPushState.lastLyricsBeatKey;
  desktopOverlayPushState.lastLyricsBeatKey = key;
  var payload = { beatMapKey: key };
  if (shouldSendMap) payload.beatMap = map ? packLocalBeatMap(map) : null;
  return payload;
}
function notifyDesktopLyricsBeatMapReady() {
  try {
    if (fx && fx.desktopLyrics) pushDesktopLyricsState(true);
  } catch (e) { }
}
function desktopLyricsPushInterval() {
  var fps = normalizeDesktopLyricsFps(fx && fx.desktopLyricsFps);
  if (!fps) return 8;
  return Math.max(8, Math.min(42, 1000 / fps));
}
function desktopLyricsCurrentCustomFontId() {
  var font = customLyricFontRecordForKey(fx && fx.lyricFont);
  return font ? font.id : '';
}
function desktopLyricsCustomFontPayload(includeDataUrl) {
  var font = customLyricFontRecordForKey(fx && fx.lyricFont);
  if (!font) return null;
  var payload = {
    id: font.id,
    family: font.family,
    name: font.name
  };
  if (includeDataUrl !== false) payload.dataUrl = font.dataUrl;
  return payload;
}
function desktopLyricsPayload(forceBeatMap, includeCustomFontData) {
  var meta = currentDesktopSongMeta();
  var lyric = currentDesktopLyricSnapshot();
  var beatPayload = desktopLyricsBeatMapPayload(!!forceBeatMap);
  var payload = {
    enabled: !!fx.desktopLyrics && !isDevelopmentLockedFx('desktopLyrics'),
    text: lyric.text,
    progress: lyric.progress,
    progressSpan: lyric.progressSpan,
    title: meta.title,
    artist: meta.artist,
    playing: !!playing,
    size: clampRange(Number(fx.desktopLyricsSize) || fxDefaults.desktopLyricsSize, 0.72, 1.55),
    opacity: clampRange(fx.desktopLyricsOpacity == null ? fxDefaults.desktopLyricsOpacity : Number(fx.desktopLyricsOpacity), 0.28, 1),
    y: clampRange(fx.desktopLyricsY == null ? fxDefaults.desktopLyricsY : Number(fx.desktopLyricsY), 0.08, 0.92),
    clickThrough: isDevelopmentLockedFx('desktopLyricsClickThrough') ? true : fx.desktopLyricsClickThrough !== false,
    lyricGlowParticles: !!fx.lyricGlowParticles,
    cinema: fx.desktopLyricsCinema !== false,
    highlightFollow: fx.desktopLyricsHighlight === true,
    frameRate: normalizeDesktopLyricsFps(fx.desktopLyricsFps),
    fontFamily: lyricFontStackForKey(fx.lyricFont),
    customFont: desktopLyricsCustomFontPayload(includeCustomFontData),
    fontWeight: lyricFontWeightValue(),
    letterSpacing: clampRange(Number(fx.lyricLetterSpacing) || 0, -0.04, 0.18),
    lineHeight: lyricLineHeightFactor(),
    lyricScale: clampRange(Number(fx.lyricScale) || 1, 0.35, 1.65),
    feather: lyricsHasNativeKaraoke ? 0.030 : 0.055,
    motion: desktopLyricsMotionPayload(),
    playback: desktopLyricsPlaybackPayload(),
    beatMapKey: beatPayload.beatMapKey,
    colors: desktopOverlayColors()
  };
  if (Object.prototype.hasOwnProperty.call(beatPayload, 'beatMap')) payload.beatMap = beatPayload.beatMap;
  return payload;
}
function wallpaperPayload() {
  var meta = currentDesktopSongMeta();
  return {
    enabled: !!fx.wallpaperMode && !isDevelopmentLockedFx('wallpaperMode'),
    title: meta.title,
    artist: meta.artist,
    cover: meta.cover,
    playing: !!playing,
    preset: fx.preset,
    opacity: clampRange(fx.wallpaperOpacity == null ? fxDefaults.wallpaperOpacity : Number(fx.wallpaperOpacity), 0.35, 1),
    frameRate: normalizeWallpaperFps(fx.wallpaperFps),
    // 背景来源：desktop 让真实桌面壁纸透出（WE 桌面壁纸也在其中），mineradio 用自带视觉。
    // Backdrop source: desktop shows the real wallpaper through, mineradio keeps our visuals.
    backdrop: fx.desktopWallpaperBackdrop === false ? 'mineradio' : 'desktop',
    colors: desktopOverlayColors()
  };
}
function desktopBackdropUsesDesktopWallpaper() {
  return !!(fx && fx.wallpaperMode === true && fx.desktopWallpaperBackdrop !== false);
}
function maybeShowDesktopBackdropHint(result) {
  if (fx.desktopWallpaperBackdrop === false) return;
  var backdrop = result && result.backdrop;
  // 桌面壁纸本来就是 WE 提供的：什么都不用提示，用户已经看到了。
  // WE already owns the desktop wallpaper, so there is nothing to explain.
  if (backdrop && backdrop.weOwnsBackground === true) return;
  var selection = typeof wallpaperEngineSelection === 'object' && wallpaperEngineSelection ? wallpaperEngineSelection : null;
  if (!selection || selection.active !== true) return;
  var hintKey = 'mineradio.desktopBackdropHintShown';
  try { if (window.localStorage && localStorage.getItem(hintKey) === '1') return; } catch (_) { }
  try { if (window.localStorage) localStorage.setItem(hintKey, '1'); } catch (_) { }
  if (typeof showToast === 'function') showToast(desktopOverlayFullscreenText('fx_desktop_backdrop_hint'));
}
function resumeWallpaperEngineAfterDesktopMode() {
  var selection = typeof wallpaperEngineSelection === 'object' && wallpaperEngineSelection ? wallpaperEngineSelection : null;
  if (!selection || selection.active !== true || selection.kind !== 'engine') return;
  if (typeof restartWallpaperEngineAfterHostBoundsChange !== 'function') return;
  // 退出桌面模式时主进程刚解除挂起，第一次拉起可能撞上它自己的清理流程；失败就隔两秒
  // 再试，最多四次，直到会话真的活着。
  // Leaving desktop mode right after main clears its suspend latch can lose the first start to
  // in-flight cleanup, so retry up to four times until the session is actually alive.
  var attempts = 0;
  function attempt() {
    attempts += 1;
    try { restartWallpaperEngineAfterHostBoundsChange(); } catch (_) { }
    if (attempts >= 4) return;
    setTimeout(function () {
      if (fx.wallpaperMode === true) return;
      var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : null;
      if (!api || typeof api.getWallpaperEngineRuntimeStatus !== 'function') return;
      Promise.resolve(api.getWallpaperEngineRuntimeStatus({ force: false })).then(function (status) {
        if (status && status.active === true) return;
        attempt();
      }).catch(function () { });
    }, 2200);
  }
  attempt();
}
function suspendWallpaperEngineLayerForDesktopBackdrop() {
  // 主进程会停掉 WE 会话，但渲染层还留着上一帧的捕获画面（那正是压在界面上的矩形），
  // 必须在这里一起清掉，否则桌面模式里会看到一张冻结的壁纸残影。
  // The main process stops the session, but the renderer still holds the last captured frame —
  // exactly the rectangle seen over the UI — so tear the layer down here as well.
  if (typeof clearWallpaperEngineLayerMedia === 'function') {
    try { clearWallpaperEngineLayerMedia(0); } catch (_) { }
  }
  if (typeof restoreOriginalBackgroundAfterWallpaperEngine === 'function') {
    try { restoreOriginalBackgroundAfterWallpaperEngine(); } catch (_) { }
  }
}
function desktopWallpaperStatusPayload(payload) {
  if (payload && payload.status && typeof payload.status === 'object') return payload.status;
  return payload && typeof payload === 'object' ? payload : {};
}
function updateDesktopWallpaperRuntimeControls(status) {
  status = status || desktopWallpaperRuntimeState || {};
  var supported = status.supported !== false;
  var attaching = status.attaching === true;
  var toggle = document.getElementById('t-wallpaperMode');
  if (toggle) {
    toggle.classList.toggle('runtime-pending', attaching);
    toggle.classList.toggle('runtime-unavailable', !supported);
    toggle.classList.toggle('runtime-interactive', status.interactive === true);
    toggle.setAttribute('aria-busy', attaching ? 'true' : 'false');
    if (!supported) toggle.setAttribute('aria-disabled', 'true');
    else toggle.removeAttribute('aria-disabled');
    toggle.title = !supported
      ? desktopOverlayFullscreenText('overlay_full_unsupported')
      : (attaching ? desktopOverlayFullscreenText('overlay_switching') : desktopOverlayFullscreenText('overlay_enter_hint'));
  }
  var opacity = document.getElementById('fx-wallpaperopacity');
  if (opacity) opacity.disabled = !supported;
  document.querySelectorAll('#wallpaper-fps-seg [data-wallpaper-fps]').forEach(function (btn) {
    btn.disabled = !supported;
  });
}

function applyDesktopWallpaperSafeArea(status, enabled) {
  var root = document.documentElement;
  if (!root || !root.style) return;
  var insets = status && status.safeInsets && typeof status.safeInsets === 'object'
    ? status.safeInsets
    : null;
  if (!insets && status && status.bounds && status.workArea) {
    var bounds = status.bounds;
    var workArea = status.workArea;
    insets = {
      top: Math.max(0, Number(workArea.y) - Number(bounds.y)),
      right: Math.max(0, Number(bounds.x) + Number(bounds.width) - Number(workArea.x) - Number(workArea.width)),
      bottom: Math.max(0, Number(bounds.y) + Number(bounds.height) - Number(workArea.y) - Number(workArea.height)),
      left: Math.max(0, Number(workArea.x) - Number(bounds.x))
    };
  }
  var names = ['top', 'right', 'bottom', 'left'];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var value = enabled === true && insets ? Math.max(0, Number(insets[name]) || 0) : 0;
    root.style.setProperty('--desktop-safe-' + name, value + 'px');
  }
}

function syncDesktopWallpaperBodyClasses(status, enabled, interactive) {
  status = status || desktopWallpaperRuntimeState || {};
  enabled = enabled === true;
  interactive = enabled && interactive === true;
  var explorerLayeredColorkey = enabled && desktopUsesLayeredExplorerColorkey(status);
  var iconsHidden = enabled && !desktopIconsAreVisible(status);
  var desktopBackdrop = enabled && fx.desktopWallpaperBackdrop !== false;
  document.documentElement.classList.toggle('desktop-explorer-layered-colorkey-root', explorerLayeredColorkey);
  document.body.classList.toggle('desktop-wallpaper-mode', enabled);
  document.body.classList.toggle('desktop-backdrop-desktop', desktopBackdrop);
  document.body.classList.toggle('desktop-backdrop-mineradio', enabled && !desktopBackdrop);
  document.body.classList.toggle('desktop-wallpaper-interactive', interactive);
  document.body.classList.toggle('desktop-explorer-layered-colorkey', explorerLayeredColorkey);
  document.body.classList.toggle('desktop-software-locked', interactive && status.softwareInteractionLocked === true);
  document.body.classList.toggle('desktop-icons-hidden', iconsHidden);
  // 桌面模式会隐藏整条标题栏，标题栏里的工具按钮改停到 #desktop-tools-zone；
  // 退出来再搬回标题栏（或仍在全屏时搬回全屏工具行）。
  // Desktop mode hides the whole title bar, so its tool buttons dock in #desktop-tools-zone and
  // move back on exit (or to the fullscreen row if the window is still fullscreen).
  if (typeof syncFullscreenToolsRow === 'function') {
    syncFullscreenToolsRow(desktopFullscreenActive === true);
  }
  if (!interactive) {
    setDesktopModeControlsOpen(false);
    setDesktopModeControlPeek(false);
  }
}

function releaseDesktopWallpaperStartupVisibilityGate() {
  var root = document.documentElement;
  if (!root || !root.classList.contains('startup-fast-skip-preload')) return false;
  if (typeof releaseStartupFastSkipPreload === 'function') {
    try { releaseStartupFastSkipPreload(); } catch (_) { }
  }
  // Fail open even if the splash helper was interrupted. This class hides the
  // canvas, Home, search and bottom console, so it must never survive a native
  // desktop-mode activation.
  root.classList.remove('startup-fast-skip-preload');
  return true;
}

function ensureDesktopWallpaperFunctionalUi(reason) {
  var body = document.body;
  if (!body
    || !body.classList.contains('desktop-wallpaper-mode')
    || !body.classList.contains('desktop-wallpaper-interactive')) return false;

  releaseDesktopWallpaperStartupVisibilityGate();
  if (typeof immersiveMode !== 'undefined' && immersiveMode
    && typeof setImmersiveMode === 'function') {
    setImmersiveMode(false);
  }

  var homeActive = body.classList.contains('empty-home-active');
  if (homeActive) {
    if (typeof updateControlsChromeState === 'function') updateControlsChromeState();
    return true;
  }

  var shelfSuppressesConsole = false;
  try {
    shelfSuppressesConsole = typeof isBottomControlsSuppressedForShelf === 'function'
      && isBottomControlsSuppressedForShelf();
  } catch (_) { }
  if (shelfSuppressesConsole) return true;

  if (body.classList.contains('home-controls-locked')) {
    if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(false);
    else body.classList.remove('home-controls-locked');
  }
  // 这个函数被 320ms 的健康检查反复调用，作用是「原生切换后别把界面留在坏状态」。
  // 一旦用户开了控制栏自动隐藏，控制条显示与否就归自动隐藏逻辑管：这里再把它拉出来、
  // 并把 900ms 的展示保持时间续上，会形成「每次检查都续期 → 永远不隐藏」的死循环。
  // This runs on the 320ms health watch to recover from stuck native transitions. Once the
  // user enables console auto-hide, visibility belongs to that logic: re-revealing here and
  // extending the 900ms reveal hold each tick creates a loop where the console never hides.
  var bar = document.getElementById('bottom-bar');
  var autoHideOwnsVisibility = typeof controlsAutoHide !== 'undefined' && controlsAutoHide;
  if (!autoHideOwnsVisibility) {
    if (typeof controlsHideTimer !== 'undefined' && controlsHideTimer) {
      clearTimeout(controlsHideTimer);
      controlsHideTimer = null;
    }
    if (typeof controlsRevealHoldUntil !== 'undefined') {
      controlsRevealHoldUntil = Math.max(controlsRevealHoldUntil || 0, performance.now() + 900);
    }
    if (bar) {
      bar.classList.add('visible');
      bar.classList.remove('soft-hidden');
      bar.style.pointerEvents = '';
    }
    if (typeof setControlsHidden === 'function') setControlsHidden(false);
  }
  if (typeof updateControlsChromeState === 'function') updateControlsChromeState();
  return !!bar;
}

function revealDesktopWallpaperUiOnActivation(enabled, interactive) {
  var nextActive = enabled === true && interactive === true;
  var wasActive = desktopWallpaperUiActivationState === true;
  desktopWallpaperUiActivationState = nextActive;
  if (!nextActive) {
    if (desktopWallpaperHudPrimeTimer) {
      clearTimeout(desktopWallpaperHudPrimeTimer);
      desktopWallpaperHudPrimeTimer = 0;
    }
    if (document.body) document.body.classList.remove('desktop-wallpaper-hud-prime');
    if (typeof controlsRevealHoldUntil !== 'undefined') controlsRevealHoldUntil = 0;
    setDesktopModeControlsOpen(false);
    setDesktopModeControlPeek(false);
    return false;
  }
  // Status can arrive after the native HWND was hidden/reparented or after a
  // throttled first paint. Reassert the actual functional surface on every
  // active status, not only on the first false -> true edge.
  ensureDesktopWallpaperFunctionalUi('runtime-status');
  if (wasActive) return false;

  setDesktopModeControlPeek(true);
  scheduleDesktopModeControlPeekHide(1800);

  var body = document.body;
  if (body) body.classList.add('desktop-wallpaper-hud-prime');

  // Full desktop mode is the complete Mineradio workspace. Do not inherit the
  // ordinary stage's immersive chrome suppression, which otherwise leaves only
  // the desktop-mode hotspot visible after the native attach finishes.
  if (typeof immersiveMode !== 'undefined' && immersiveMode
    && typeof setImmersiveMode === 'function') {
    setImmersiveMode(false);
  }

  var homeActive = !!(body && body.classList.contains('empty-home-active'));
  if (homeActive) {
    if (typeof updateControlsChromeState === 'function') updateControlsChromeState();
  } else {
    // A Home transition can leave this lock behind while Home itself is no
    // longer visible. Clear only that stale combination; a real Home page keeps
    // its existing player-console policy.
    if (body && body.classList.contains('home-controls-locked')) {
      if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(false);
      else body.classList.remove('home-controls-locked');
    }
    if (typeof controlsHideTimer !== 'undefined' && controlsHideTimer) {
      clearTimeout(controlsHideTimer);
      controlsHideTimer = null;
    }
    if (typeof holdBottomControlsVisible === 'function') {
      holdBottomControlsVisible(4200);
    } else if (typeof revealBottomControls === 'function') {
      revealBottomControls(4200);
    } else {
      var bar = document.getElementById('bottom-bar');
      if (bar) {
        bar.classList.add('visible');
        bar.classList.remove('soft-hidden');
      }
      if (typeof updateControlsChromeState === 'function') updateControlsChromeState();
    }
  }

  // The HWND is briefly hidden/reparented below Explorer while this status is
  // applied. Commit the target HUD frame without relying on an opacity
  // transition that Chromium may leave at its transparent first sample.
  var activeSurface = document.getElementById(homeActive ? 'empty-home' : 'bottom-bar');
  if (activeSurface) {
    void activeSurface.offsetWidth;
    try { window.getComputedStyle(activeSurface).opacity; } catch (_) { }
  }
  if (desktopWallpaperHudPrimeTimer) clearTimeout(desktopWallpaperHudPrimeTimer);
  desktopWallpaperHudPrimeTimer = setTimeout(function () {
    desktopWallpaperHudPrimeTimer = 0;
    if (document.body) document.body.classList.remove('desktop-wallpaper-hud-prime');
  }, 900);
  return true;
}

function applyDesktopWallpaperRuntimeStatus(payload) {
  var status = desktopWallpaperStatusPayload(payload);
  var generation = Number(status.generation);
  if (isFinite(generation) && generation < desktopWallpaperStatusGeneration) return desktopWallpaperRuntimeState;
  if (isFinite(generation)) desktopWallpaperStatusGeneration = generation;
  desktopWallpaperRuntimeState = Object.assign({}, desktopWallpaperRuntimeState, status);
  // 桌面「刷新」触发的重绑会连发几条中间状态（queued / recovering-icon-layer）。这些状态只
  // 说明图标层正在重挂，界面本身没变；逐条重跑安全区、类名和 UI 浮现会让歌词行在下一行闪一下。
  // A desktop refresh emits several transient statuses while the icon layer rebinds. Nothing about
  // the layout changed, so re-running the safe area, body classes and reveal logic on each one
  // makes the lyric line flicker; keep the previous layout until the final status arrives.
  var transientHostRecovery = String(status.phase || '') === 'recovering-icon-layer';
  if (transientHostRecovery) return desktopWallpaperRuntimeState;
  var nextEnabled = status.enabled === true || status.active === true
    ? true
    : (status.attaching === true ? !!fx.wallpaperMode : false);
  if (fx.wallpaperMode !== nextEnabled) {
    fx.wallpaperMode = nextEnabled;
    updateFxInputs();
  }
  if (desktopWindowState && typeof desktopWindowState === 'object') {
    desktopWindowState.isDesktopEmbedded = nextEnabled;
    desktopWindowState.isDesktopInteractive = nextEnabled && status.interactive === true;
  }
  syncDesktopWallpaperBodyClasses(desktopWallpaperRuntimeState, nextEnabled, status.interactive === true);
  applyDesktopWallpaperSafeArea(desktopWallpaperRuntimeState, nextEnabled);
  revealDesktopWallpaperUiOnActivation(nextEnabled, status.interactive === true);
  if (!nextEnabled) {
    desktopIconVisibilityPending = false;
    desktopSoftwareLockPending = false;
  }
  updateDesktopModeControl(desktopWallpaperRuntimeState);
  applyDesktopIconRevealMask();
  updateDesktopWallpaperRuntimeControls(desktopWallpaperRuntimeState);
  scheduleDesktopIconShieldReport(!(nextEnabled && status.interactive === true));
  scheduleDesktopPointerRouteReport(null, true);
  return desktopWallpaperRuntimeState;
}
function desktopWallpaperErrorLabel(error) {
  var code = String(error || 'WALLPAPER_FAILED');
  if (code.indexOf('WALLPAPER_PLATFORM_UNSUPPORTED') >= 0) return desktopOverlayFullscreenText('overlay_unsupported');
  if (code.indexOf('WALLPAPER_WORKERW_NOT_FOUND') >= 0) return desktopOverlayFullscreenText('overlay_no_workerw');
  if (code.indexOf('WALLPAPER_PROGMAN_NOT_FOUND') >= 0) return desktopOverlayFullscreenText('overlay_no_host');
  if (code.indexOf('WALLPAPER_NATIVE_ATTACH_ABORTED') >= 0 || code.indexOf('WALLPAPER_START_SUPERSEDED') >= 0) return desktopOverlayFullscreenText('overlay_start_cancelled');
  if (code.indexOf('FULL_DESKTOP_RECOVERY_TRAY_UNAVAILABLE') >= 0) return desktopOverlayFullscreenText('overlay_no_recovery_entry');
  if (code.indexOf('FULL_DESKTOP_WALLPAPER_ENGINE_SUSPEND_FAILED') >= 0
    || code.indexOf('FULL_DESKTOP_WALLPAPER_ENGINE_HELPER_EXIT_TIMEOUT') >= 0
    || code.indexOf('WALLPAPER_ENGINE_DESKTOP_TRANSITION_BUSY') >= 0
    || code.indexOf('WALLPAPER_DESKTOP_PREVIEW') >= 0
    || code.indexOf('WALLPAPER_ENGINE_SESSION_MISMATCH') >= 0) return desktopOverlayFullscreenText('overlay_we_switch_failed');
  if (code.indexOf('DESKTOP_MODE_DETACH') >= 0 || code.indexOf('FULL_DESKTOP_DETACH') >= 0) return desktopOverlayFullscreenText('overlay_main_restore_failed');
  return desktopOverlayFullscreenText('overlay_cannot_enter');
}
function initDesktopWallpaperRuntimeBridge(api) {
  if (!api) return;
  if (typeof api.onWallpaperModeState === 'function' && !desktopWallpaperStatusUnsubscribe) {
    try {
      desktopWallpaperStatusUnsubscribe = api.onWallpaperModeState(applyDesktopWallpaperRuntimeStatus);
    } catch (_) {
      desktopWallpaperStatusUnsubscribe = null;
    }
  }
  if (typeof api.getWallpaperModeStatus === 'function') {
    Promise.resolve().then(function () {
      return api.getWallpaperModeStatus();
    }).then(applyDesktopWallpaperRuntimeStatus).catch(function () { });
  }
}
function pushDesktopLyricsState(force) {
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateDesktopLyrics !== 'function') return;
  var now = performance.now();
  if (!force && now - desktopOverlayPushState.lyricsAt < desktopLyricsPushInterval()) return;
  var currentCustomFontId = desktopLyricsCurrentCustomFontId();
  var includeCustomFontData = !!currentCustomFontId && currentCustomFontId !== desktopOverlayPushState.lastLyricsCustomFontId;
  var payload = desktopLyricsPayload(!!force, includeCustomFontData);
  var colors = payload.colors || {};
  var motion = payload.motion || {};
  var payloadCustomFontId = payload.customFont ? payload.customFont.id : '';
  var key = payload.enabled + '|' + payload.text + '|' + Math.round(payload.progress * 1000) + '|' + Math.round((payload.progressSpan || 0) * 100) + '|' + payload.playing + '|' + payload.size + '|' + payload.opacity + '|' + payload.y + '|' + payload.clickThrough + '|' + payload.cinema + '|' + payload.highlightFollow + '|' + payload.frameRate + '|' + payload.fontFamily + '|' + payloadCustomFontId + '|' + payload.fontWeight + '|' + payload.letterSpacing + '|' + payload.lineHeight + '|' + payload.lyricScale + '|' + payload.feather + '|' + payload.beatMapKey + '|' + colors.primary + '|' + colors.secondary + '|' + colors.highlight + '|' + colors.glow + '|' + motion.lyricGlow + '|' + motion.lyricGlowBeat + '|' + Math.round((motion.lyricGlowStrength || 0) * 100) + '|' + Math.round((motion.highBloom || 0) * 100) + '|' + Math.round((motion.beatGlow || 0) * 100) + '|' + Math.round((motion.beatPulse || 0) * 100) + '|' + Math.round((motion.bass || 0) * 100);
  if (!force && key === desktopOverlayPushState.lastLyricsKey && now - desktopOverlayPushState.lyricsAt < 900) return;
  desktopOverlayPushState.lyricsAt = now;
  desktopOverlayPushState.lastLyricsKey = key;
  desktopOverlayPushState.lastLyricsCustomFontId = payloadCustomFontId;
  api.updateDesktopLyrics(payload).catch(function (e) { console.warn('desktop lyrics update failed:', e); });
}
function applyDesktopLyricsState(force) {
  var api = getDesktopWindowApi();
  if (!api) return;
  normalizeDevelopmentLockedFxState();
  var payload = desktopLyricsPayload(true, true);
  var payloadCustomFontId = payload.customFont ? payload.customFont.id : '';
  if (typeof api.setDesktopLyricsEnabled === 'function') {
    desktopOverlayPushState.lastLyricsCustomFontId = payloadCustomFontId;
    api.setDesktopLyricsEnabled(!!payload.enabled, payload).catch(function (e) { console.warn('desktop lyrics state failed:', e); });
  } else {
    desktopOverlayPushState.lastLyricsCustomFontId = '';
  }
  pushDesktopLyricsState(!!force);
}
function pushWallpaperState(force) {
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateWallpaperMode !== 'function') return;
  if (!force) return;
  api.updateWallpaperMode(Object.assign(wallpaperPayload(), { reason: 'renderer-status-refresh' })).then(function (result) {
    if (result && result.status) applyDesktopWallpaperRuntimeStatus(result.status);
    if (result && result.ok === false) console.warn('wallpaper update failed:', result.error || 'WALLPAPER_UPDATE_FAILED');
  }).catch(function (e) { console.warn('wallpaper update failed:', e); });
}
function applyWallpaperModeState(force) {
  var api = getDesktopWindowApi();
  if (!api) {
    fx.wallpaperMode = false;
    updateFxInputs();
    return Promise.resolve({ ok: false, enabled: false, error: 'WALLPAPER_DESKTOP_API_UNAVAILABLE' });
  }
  normalizeDevelopmentLockedFxState();
  var payload = wallpaperPayload();
  if (typeof api.setWallpaperMode !== 'function') return Promise.resolve({ ok: false, enabled: false, error: 'WALLPAPER_DESKTOP_API_UNAVAILABLE' });
  var operation = ++desktopWallpaperRendererOperation;
  if (payload.enabled) {
    desktopWallpaperRuntimeState = Object.assign({}, desktopWallpaperRuntimeState, { attaching: true, enabled: true, lastError: '' });
    updateDesktopWallpaperRuntimeControls(desktopWallpaperRuntimeState);
  }
  return Promise.resolve().then(function () {
    return api.setWallpaperMode(!!payload.enabled, payload);
  }).then(function (result) {
    result = result && typeof result === 'object' ? result : { ok: false, enabled: false, error: 'WALLPAPER_RESULT_INVALID' };
    if (operation !== desktopWallpaperRendererOperation) return Object.assign({}, result, { rendererStale: true });
    if (result.status) applyDesktopWallpaperRuntimeStatus(result.status);
    else {
      fx.wallpaperMode = result.ok === true && result.enabled === true;
      updateFxInputs();
    }
    if (result.ok !== true) {
      var failedStatus = result.status && typeof result.status === 'object' ? result.status : {};
      fx.wallpaperMode = result.enabled === true || failedStatus.enabled === true || failedStatus.active === true;
      updateFxInputs();
    }
    if (payload.enabled) {
      if (result.ok === true && fx.desktopWallpaperBackdrop !== false) suspendWallpaperEngineLayerForDesktopBackdrop();
      maybeShowDesktopBackdropHint(result);
    } else if (result.ok === true) {
      // 退出桌面模式后把应用内 WE 会话按当前窗口尺寸重新拉起来。
      // After leaving desktop mode, restart the in-app WE scene at the current window size.
      setTimeout(resumeWallpaperEngineAfterDesktopMode, 420);
    }
    return result;
  }).catch(function (error) {
    if (operation !== desktopWallpaperRendererOperation) return { ok: false, enabled: false, rendererStale: true, error: String(error && error.message || error) };
    fx.wallpaperMode = false;
    desktopWallpaperRuntimeState = Object.assign({}, desktopWallpaperRuntimeState, { active: false, enabled: false, attaching: false, lastError: String(error && error.message || error) });
    updateFxInputs();
    updateDesktopWallpaperRuntimeControls(desktopWallpaperRuntimeState);
    return { ok: false, enabled: false, error: desktopWallpaperRuntimeState.lastError };
  });
}
function syncDesktopOverlayState() {
  if (fx.desktopLyrics) pushDesktopLyricsState(false);
}
setInterval(function () {
  if (fx && fx.desktopLyrics) syncDesktopOverlayState();
  if (fx && fx.wallpaperMode) ensureDesktopWallpaperFunctionalUi('health-watch');
}, 320);

// 全屏
var desktopFullscreenActive = false;
var documentFullscreenActive = false;
var desktopWindowState = {};
var desktopWindowMinimizeTimer = 0;
var desktopWindowRestoreTimer = 0;

function desktopWindowReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function clearDesktopWindowTransitionClasses() {
  document.body.classList.remove('desktop-window-minimizing');
  document.body.classList.remove('desktop-window-restoring');
}

function animateDesktopWindowMinimize(api, activationEvent) {
  if (!api || typeof api.minimize !== 'function') return;
  // A minimize request must originate from a real activation of the visible
  // title-bar control. This keeps stale timers or synthetic DOM clicks from
  // unexpectedly putting the player in the taskbar during playback.
  if (!activationEvent || activationEvent.isTrusted !== true) return;
  if (desktopWindowReducedMotion()) {
    api.minimize();
    return;
  }
  clearTimeout(desktopWindowMinimizeTimer);
  clearTimeout(desktopWindowRestoreTimer);
  document.body.classList.remove('desktop-window-restoring');
  document.body.classList.add('desktop-window-minimizing');
  desktopWindowMinimizeTimer = setTimeout(function () {
    document.body.classList.remove('desktop-window-minimizing');
    api.minimize();
  }, 150);
}

function animateDesktopWindowRestore() {
  if (desktopWindowReducedMotion()) {
    clearDesktopWindowTransitionClasses();
    return;
  }
  clearTimeout(desktopWindowMinimizeTimer);
  clearTimeout(desktopWindowRestoreTimer);
  document.body.classList.remove('desktop-window-minimizing');
  document.body.classList.add('desktop-window-restoring');
  desktopWindowRestoreTimer = setTimeout(function () {
    document.body.classList.remove('desktop-window-restoring');
  }, 280);
}

function toggleFullscreen() {
  var api = window.desktopWindow;
  if (api && api.isDesktop && typeof api.toggleFullscreen === 'function') {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () { });
      scheduleMainRendererViewportRefresh('document-fullscreen-exit');
      return;
    }
    api.toggleFullscreen();
    scheduleMainRendererViewportRefresh('desktop-fullscreen-toggle');
    return;
  }
  if (api && api.isDesktop && desktopFullscreenActive && !document.fullscreenElement && typeof api.exitFullscreenWindowed === 'function') {
    api.exitFullscreenWindowed();
    scheduleMainRendererViewportRefresh('desktop-fullscreen-exit');
    return;
  }
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(function () {
      if (api && api.isDesktop && typeof api.toggleFullscreen === 'function') api.toggleFullscreen();
      else showToast(desktopOverlayFullscreenText('fullscreen_rejected', '全屏被浏览器拒绝'));
    });
  } else {
    document.exitFullscreen();
    scheduleMainRendererViewportRefresh('document-fullscreen-exit');
  }
}

(function initDesktopWindowShell() {
  var api = window.desktopWindow;
  if (!api || !api.isDesktop) return;

  document.documentElement.classList.add('desktop-shell-root');
  document.body.classList.add('desktop-shell');
  document.body.classList.remove('desktop-fullscreen');
  desktopFullscreenActive = false;
  syncCursorAutoHideMode();

  var maxBtn = document.querySelector('[data-window-action="maximize"]');
  var maxIcon = maxBtn && maxBtn.querySelector('.icon-maximize');
  var restoreIcon = maxBtn && maxBtn.querySelector('.icon-restore');
  function applyState(state) {
    // 主进程会重复上报同一份窗口状态（例如桌面刷新后重新确认嵌入状态）。内容没变时不要再
    // 重跑安全区、类名和图标报告，否则歌词和界面会被无意义地重排一次。
    // The main process repeats the same window state (for example after a desktop refresh
    // re-confirms the embedding). Re-running the safe area, classes and icon report for an
    // unchanged state needlessly reflows the lyrics and UI.
    var stateKey = JSON.stringify(state || {});
    if (stateKey === applyState.lastKey) return;
    applyState.lastKey = stateKey;
    var wasHidden = !!desktopWindowState.isMinimized || desktopWindowState.isVisible === false;
    desktopWindowState = Object.assign(desktopWindowState, state || {});
    var isHidden = !!desktopWindowState.isMinimized || desktopWindowState.isVisible === false;
    if (wasHidden && !isHidden) animateDesktopWindowRestore();
    var isMaximized = !!desktopWindowState.isMaximized;
    var isFullScreen = !!desktopWindowState.isFullScreen || !!desktopWindowState.isNativeFullScreen || !!desktopWindowState.isHtmlFullScreen || !!desktopWindowState.isWindowFullScreen || !!document.fullscreenElement;
    var wasFullScreen = desktopFullscreenActive;
    desktopFullscreenActive = isFullScreen;
    document.body.classList.toggle('desktop-maximized', isMaximized);
    document.body.classList.toggle('desktop-fullscreen', isFullScreen);
    syncDesktopWallpaperBodyClasses(
      desktopWallpaperRuntimeState,
      desktopWindowState.isDesktopEmbedded === true,
      desktopWindowState.isDesktopInteractive === true
    );
    applyDesktopWallpaperSafeArea(desktopWallpaperRuntimeState, desktopWindowState.isDesktopEmbedded === true);
    scheduleDesktopIconShieldReport(!(desktopWindowState.isDesktopEmbedded === true && desktopWindowState.isDesktopInteractive === true));
    updateDesktopModeControl(desktopWallpaperRuntimeState);
    scheduleDesktopPointerRouteReport(null, true);
    desktopRuntimeState.fullscreen = isFullScreen;
    // 进/退全屏都要搬：全屏把标题栏那排工具按钮搬进 #fullscreen-tools-zone，退出搬回标题栏。
    // 每次状态变化都调（不只是 true→false 那一跳）：主进程状态可能重复上报，搬移是幂等的。
    // Move on both directions: into the fullscreen tool row on enter, back into the title bar on
    // exit. Called on every state report, not only on the transition — the move is idempotent.
    syncFullscreenToolsRow(isFullScreen);
    if (isFullScreen !== wasFullScreen) {
      scheduleMainRendererViewportRefresh('desktop-shell-state');
      if (!isFullScreen) {
        document.body.classList.remove('fullscreen-tools-peek');
        document.body.classList.remove('fullscreen-tools-guided');
        setTimeout(function () { clearPlayerControlFocusState('desktop-fullscreen-exit'); }, 80);
      }
    }
    syncCursorAutoHideMode();
    if (maxBtn) {
      maxBtn.title = isFullScreen ? desktopOverlayFullscreenText('btn_exit_fullscreen', '退出全屏') : desktopOverlayFullscreenText('btn_fullscreen', '全屏');
      maxBtn.setAttribute('aria-label', maxBtn.title);
    }
    if (maxIcon) maxIcon.style.display = isFullScreen ? 'none' : '';
    if (restoreIcon) restoreIcon.style.display = isFullScreen ? '' : 'none';
  }

  document.querySelectorAll('[data-window-action]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var action = btn.getAttribute('data-window-action');
      if (action === 'minimize') animateDesktopWindowMinimize(api, e);
      if (action === 'maximize') toggleFullscreen();
      if (action === 'close') {
        saveLastPlaybackSnapshot(true, 'window-close');
        api.close(closeBehaviorPreference);
      }
    });
  });

  if (typeof api.onDesktopLyricsLockState === 'function') {
    api.onDesktopLyricsLockState(function (payload) {
      var locked = !payload || payload.locked !== false;
      if (fx.desktopLyricsClickThrough === locked) return;
      fx.desktopLyricsClickThrough = locked;
      updateFxInputs();
      saveLyricLayout({ user: true, reason: 'desktopLyricsClickThrough' });
      pushDesktopLyricsState(true);
      showToast(locked ? desktopOverlayFullscreenText('desktop_lyrics_locked', '桌面歌词已锁定') : desktopOverlayFullscreenText('desktop_lyrics_unlocked', '桌面歌词可移动'));
    });
  }
  if (typeof api.onDesktopLyricsEnabledState === 'function') {
    api.onDesktopLyricsEnabledState(function (payload) {
      var enabled = !!(payload && payload.enabled);
      if (fx.desktopLyrics === enabled) return;
      fx.desktopLyrics = enabled;
      updateFxInputs();
      saveLyricLayout({ user: true, reason: 'desktopLyrics' });
      showToast(enabled ? desktopOverlayFullscreenText('desktop_lyrics_on', '桌面歌词已开启') : desktopOverlayFullscreenText('desktop_lyrics_off', '桌面歌词已关闭'));
    });
  }

  initDesktopModeControls(api);
  initDesktopIconShieldReporter(api);
  initDesktopWallpaperRuntimeBridge(api);
  api.onStateChange(applyState);
  if (typeof api.getState === 'function') {
    api.getState().then(applyState).catch(function () { applyState({}); });
  } else {
    applyState({});
  }
  document.addEventListener('fullscreenchange', function () {
    var wasDocumentFullscreen = documentFullscreenActive;
    documentFullscreenActive = !!document.fullscreenElement;
    desktopWindowState.isHtmlFullScreen = documentFullscreenActive;
    if (wasDocumentFullscreen && !documentFullscreenActive && typeof api.exitFullscreenWindowed === 'function') {
      api.exitFullscreenWindowed();
    }
    applyState({});
  });
})();

// ============================================================
//  启动
// ============================================================
