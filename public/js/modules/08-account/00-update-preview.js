// ============================================================
// Update preview: external download page only.
// Mineradio no longer downloads installers or applies resource patches.
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
function updatePreviewText(key, fallback, params) {
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
function isSafeUpdatePageUrl(value) {
  var raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return false;
  try {
    return new URL(raw).protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function normalizeUpdateDownloadPages(values) {
  var source = Array.isArray(values) ? values : [];
  var seen = Object.create(null);
  var pages = [];
  source.forEach(function (value, index) {
    var item = value && typeof value === 'object' ? value : { url: value };
    var url = String(item.url || item.href || item.downloadPageUrl || item.externalUrl || '').trim();
    if (!isSafeUpdatePageUrl(url) || seen[url]) return;
    var label = String(item.label || item.name || (updatePreviewText('upd_line') + (index + 1)))
      .replace(/[<>|]/g, '')
      .trim()
      .slice(0, 24) || (updatePreviewText('upd_line') + (index + 1));
    seen[url] = true;
    pages.push({ label: label, url: url });
  });
  return pages.slice(0, 6);
}

function currentUpdateDownloadPages() {
  return normalizeUpdateDownloadPages(updatePreviewState.downloadPages);
}

function currentUpdatePageUrl(preferredIndex) {
  var pages = currentUpdateDownloadPages();
  var index = Number.isInteger(preferredIndex)
    ? preferredIndex
    : Number(updatePreviewState.selectedDownloadPageIndex || 0);
  if (pages[index] && isSafeUpdatePageUrl(pages[index].url)) return pages[index].url;
  if (pages[0] && isSafeUpdatePageUrl(pages[0].url)) return pages[0].url;
  var candidates = [
    updatePreviewState.downloadPageUrl,
    updatePreviewState.externalUrl,
    updatePreviewState.releaseUrl
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (isSafeUpdatePageUrl(candidates[i])) return String(candidates[i]).trim();
  }
  return '';
}

function initUpdatePreview() {
  renderUpdatePreviewPanel();
  setUpdatePreviewVisible(false);
  checkLatestUpdate();
}

function setUpdatePreviewVisible(visible) {
  updatePreviewState.visible = !!visible;
  var entry = document.getElementById('update-entry');
  if (!entry) return;
  entry.classList.toggle('available', updatePreviewState.visible);
  if (!updatePreviewState.visible && window.gsap) {
    window.gsap.killTweensOf(entry);
    window.gsap.set(entry, { autoAlpha: 0, y: 0, clearProps: 'boxShadow,filter,scale' });
    return;
  }
  if (updatePreviewState.visible && window.gsap) {
    window.gsap.fromTo(entry,
      { autoAlpha: 0, y: -6, scale: 0.92, filter: 'blur(6px)' },
      { autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: 0.62, delay: 0.18, ease: 'expo.out', overwrite: true }
    );
    setTimeout(startUpdateIconBreathing, 760);
  }
}

async function checkLatestUpdate() {
  try {
    var data = await apiJson('/api/update/latest?t=' + Date.now());
    applyLatestUpdateInfo(data);
  } catch (e) {
    updatePreviewState.preview = false;
    updatePreviewState.updateAvailable = false;
    updatePreviewState.hero = updatePreviewText('upd_check_unavailable');
    updatePreviewState.message = (e && e.message) || 'UPDATE_CHECK_FAILED';
    renderUpdatePreviewPanel();
    setUpdatePreviewVisible(false);
  }
}

function applyLatestUpdateInfo(data) {
  data = data || {};
  var release = data.release || {};
  updatePreviewState.currentVersion = data.currentVersion || updatePreviewState.currentVersion;
  updatePreviewState.version = data.latestVersion || release.version || updatePreviewState.currentVersion;
  updatePreviewState.configured = !!data.configured;
  updatePreviewState.preview = !!data.preview;
  updatePreviewState.updateAvailable = !!data.updateAvailable;
  updatePreviewState.releaseUrl = release.htmlUrl || data.htmlUrl || '';
  var legacyExternalUrl = release.externalUrl || data.externalUrl || '';
  var explicitPages = Array.isArray(release.downloadPages)
    ? release.downloadPages
    : (Array.isArray(data.downloadPages) ? data.downloadPages : null);
  updatePreviewState.downloadPages = normalizeUpdateDownloadPages(explicitPages || []);
  if (
    explicitPages === null
    && isSafeUpdatePageUrl(legacyExternalUrl)
  ) {
    updatePreviewState.downloadPages.unshift({
      label: updatePreviewText('upd_drive_download'),
      url: legacyExternalUrl
    });
  }
  updatePreviewState.externalUrl = updatePreviewState.downloadPages.length
    ? updatePreviewState.downloadPages[0].url
    : '';
  if (updatePreviewState.selectedDownloadPageIndex >= updatePreviewState.downloadPages.length) {
    updatePreviewState.selectedDownloadPageIndex = 0;
  }
  updatePreviewState.downloadPageUrl = explicitPages !== null
    ? (updatePreviewState.externalUrl || updatePreviewState.releaseUrl || '')
    : (release.downloadPageUrl || data.downloadPageUrl || updatePreviewState.externalUrl || updatePreviewState.releaseUrl || '');
  updatePreviewState.status = 'idle';
  updatePreviewState.errorReason = '';
  updatePreviewState.hero = release.summary
    || (updatePreviewState.updateAvailable ? updatePreviewText('server_update_available', '发现新版本，建议更新。') : updatePreviewText('already_latest', '当前版本已是最新。'));
  updatePreviewState.notes = Array.isArray(release.notes) ? release.notes.slice(0, 4) : [];
  renderUpdatePreviewPanel();
  setUpdatePreviewVisible(updatePreviewState.updateAvailable || updatePreviewState.preview);
}

function startUpdateIconBreathing() {
  var entry = document.getElementById('update-entry');
  if (!entry || !updatePreviewState.visible || !window.gsap) return;
  var ring = entry.querySelector('.update-ring');
  window.gsap.killTweensOf(entry, 'y,boxShadow');
  window.gsap.set(entry, { autoAlpha: 1 });
  if (ring) window.gsap.killTweensOf(ring);
  window.gsap.to(entry, {
    y: -1.4,
    boxShadow: '0 16px 44px rgba(0,0,0,.32),0 0 24px rgba(244,210,138,.18),0 0 13px rgba(157,184,207,.06),inset 0 1px 0 rgba(255,255,255,.11)',
    duration: 2.6,
    repeat: -1,
    yoyo: true,
    ease: 'sine.inOut'
  });
  if (ring) {
    window.gsap.to(ring, {
      rotate: 18,
      duration: 3.8,
      repeat: -1,
      yoyo: true,
      ease: 'sine.inOut',
      transformOrigin: '50% 50%'
    });
  }
}

function renderUpdatePreviewPanel() {
  var version = document.getElementById('update-modal-version');
  var hero = document.getElementById('update-hero-main');
  var list = document.getElementById('update-list');
  if (version) version.textContent = 'v' + updatePreviewState.version;
  if (hero) hero.textContent = updatePreviewState.hero || updatePreviewText('already_latest', '当前版本已是最新。');
  if (list) {
    var notes = Array.isArray(updatePreviewState.notes) && updatePreviewState.notes.length
      ? updatePreviewState.notes
      : [updatePreviewText('upd_ready')];
    list.innerHTML = notes.map(function (text, i) {
      return '<div class="update-item"><span class="update-item-dot" data-index="'
        + String(i + 1).padStart(2, '0')
        + '"></span><div class="update-item-text">'
        + escHtml(text)
        + '</div></div>';
    }).join('');
  }
  renderUpdateDownloadSources();
  updateUpdatePreviewProgress(0);
  syncUpdatePreviewStateClass();
}

function renderUpdateDownloadSources() {
  var container = document.getElementById('update-download-sources');
  if (!container) return;
  var pages = currentUpdateDownloadPages();
  container.innerHTML = '';
  container.hidden = !updatePreviewState.updateAvailable || pages.length < 2;
  if (container.hidden) return;
  pages.forEach(function (page, index) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'update-download-source';
    button.dataset.index = String(index);
    button.textContent = page.label;
    button.title = updatePreviewText('upd_use') + page.label + updatePreviewText('upd_download');
    button.onclick = function () {
      openUpdateDownloadSource(index);
    };
    container.appendChild(button);
  });
}

function syncUpdatePreviewStateClass() {
  var entry = document.getElementById('update-entry');
  var modal = document.querySelector('#update-modal .update-modal');
  var isOpening = updatePreviewState.status === 'opening';
  var isOpened = updatePreviewState.status === 'opened';
  var isError = updatePreviewState.status === 'error';
  var downloadPages = currentUpdateDownloadPages();
  var selectedPage = downloadPages[Number(updatePreviewState.selectedDownloadPageIndex || 0)] || downloadPages[0] || null;
  var updateUrl = currentUpdatePageUrl();
  if (entry) {
    entry.classList.toggle('downloading', isOpening);
    entry.classList.toggle('ready', isOpened);
  }
  if (modal) {
    modal.classList.toggle('ready', isOpened);
    modal.classList.toggle('error', isError);
  }
  var label = document.getElementById('update-btn-label');
  if (label) {
    if (isOpening) label.textContent = updatePreviewText('upd_opening');
    else if (isOpened) label.textContent = updatePreviewText('upd_page_opened');
    else if (isError) label.textContent = updatePreviewText('upd_retry_open');
    else if (!updatePreviewState.updateAvailable) label.textContent = updatePreviewText('upd_current_latest');
    else if (selectedPage) label.textContent = updatePreviewText('upd_go') + selectedPage.label;
    else if (updatePreviewState.externalUrl) label.textContent = updatePreviewText('upd_go_drive');
    else label.textContent = updatePreviewText('sd_view_update');
  }
  var btn = document.getElementById('update-primary-btn');
  if (btn) {
    btn.disabled = isOpening || !updatePreviewState.updateAvailable || !updateUrl;
  }
  var sourceButtons = document.querySelectorAll('#update-download-sources .update-download-source');
  Array.prototype.forEach.call(sourceButtons, function (sourceButton) {
    var index = Number(sourceButton.dataset.index || 0);
    sourceButton.disabled = isOpening;
    sourceButton.classList.toggle('active', index === Number(updatePreviewState.selectedDownloadPageIndex || 0));
  });
  var foot = document.getElementById('update-footnote');
  if (foot) {
    if (isOpening) foot.textContent = updatePreviewText('upd_calling_browser');
    else if (isError) foot.textContent = updatePreviewText('upd_open_failed_prefix') + (updatePreviewState.errorReason || updatePreviewText('upd_retry_later'));
    else if (!updatePreviewState.updateAvailable) foot.textContent = updatePreviewText('already_latest', '当前版本已是最新。');
    else if (downloadPages.length || updatePreviewState.externalUrl) foot.textContent = updatePreviewText('upd_drive_hint');
    else foot.textContent = updatePreviewText('upd_github_hint');
  }
}

function updateUpdatePreviewProgress() {
  updatePreviewState.progress = 0;
  var fill = document.getElementById('update-btn-fill');
  if (fill) fill.style.width = '0%';
  var ring = document.getElementById('update-progress-ring');
  if (ring) ring.style.strokeDashoffset = '55.29';
}

function openUpdatePanel() {
  var mask = document.getElementById('update-modal');
  var entry = document.getElementById('update-entry');
  if (!mask) return;
  renderUpdatePreviewPanel();
  if (entry && window.gsap) {
    window.gsap.fromTo(entry, { scale: 0.93 }, { scale: 1, duration: 0.42, ease: 'back.out(1.7)', overwrite: 'auto' });
  }
  openGsapModal(mask);
  updatePreviewState.open = true;
  animateUpdatePanelContents();
}

function closeUpdatePanel() {
  closeGsapModal(document.getElementById('update-modal'), function () {
    updatePreviewState.open = false;
  });
}

function animateUpdatePanelContents() {
  if (!window.gsap) return;
  var modal = document.querySelector('#update-modal .update-modal');
  if (!modal) return;
  var parts = [
    modal.querySelector('.update-kicker'),
    modal.querySelector('.update-version'),
    modal.querySelector('.update-hero')
  ].filter(Boolean);
  var items = Array.prototype.slice.call(modal.querySelectorAll('.update-item'));
  var sources = Array.prototype.slice.call(modal.querySelectorAll('.update-download-source'));
  var actions = modal.querySelector('.update-actions');
  window.gsap.fromTo(parts,
    { autoAlpha: 0, x: -7, filter: 'blur(5px)' },
    { autoAlpha: 1, x: 0, filter: 'blur(0px)', duration: 0.50, ease: 'power3.out', stagger: 0.045, delay: 0.10, overwrite: true }
  );
  window.gsap.fromTo(items,
    { autoAlpha: 0, x: -8 },
    { autoAlpha: 1, x: 0, duration: 0.34, ease: 'power3.out', stagger: 0.055, delay: 0.25, overwrite: true }
  );
  if (sources.length) {
    window.gsap.fromTo(sources,
      { autoAlpha: 0, y: 6 },
      { autoAlpha: 1, y: 0, duration: 0.30, ease: 'power3.out', stagger: 0.045, delay: 0.34, overwrite: true }
    );
  }
  if (actions) {
    window.gsap.fromTo(actions,
      { autoAlpha: 0, y: 8 },
      { autoAlpha: 1, x: 0, y: 0, duration: 0.36, ease: 'power3.out', delay: 0.42, overwrite: true }
    );
  }
}

function openUpdateDownloadSource(index) {
  var pages = currentUpdateDownloadPages();
  if (!pages[index]) return;
  updatePreviewState.selectedDownloadPageIndex = index;
  syncUpdatePreviewStateClass();
  startUpdatePreviewDownload(index);
}

async function startUpdatePreviewDownload(preferredIndex) {
  if (updatePreviewState.status === 'opening') return;
  if (!updatePreviewState.updateAvailable) {
    showToast(updatePreviewText('upd_latest'));
    return;
  }
  if (Number.isInteger(preferredIndex)) {
    updatePreviewState.selectedDownloadPageIndex = preferredIndex;
  }
  var target = currentUpdatePageUrl(preferredIndex);
  if (!target) {
    showToast(updatePreviewText('upd_no_page'));
    return;
  }
  updatePreviewState.status = 'opening';
  updatePreviewState.errorReason = '';
  syncUpdatePreviewStateClass();
  try {
    if (window.desktopWindow && typeof window.desktopWindow.openUpdatePage === 'function') {
      var result = await window.desktopWindow.openUpdatePage(target);
      if (!result || result.ok === false) throw new Error((result && result.error) || 'OPEN_UPDATE_PAGE_FAILED');
    } else {
      var opened = window.open(target, '_blank', 'noopener');
      if (!opened) throw new Error('OPEN_UPDATE_PAGE_BLOCKED');
    }
    updatePreviewState.status = 'opened';
    syncUpdatePreviewStateClass();
    pulseUpdateReady();
    showToast(updatePreviewState.externalUrl ? updatePreviewText('upd_opened_drive') : updatePreviewText('upd_opened'));
    setTimeout(function () {
      if (updatePreviewState.status === 'opened') {
        updatePreviewState.status = 'idle';
        syncUpdatePreviewStateClass();
      }
    }, 1600);
  } catch (e) {
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = (e && e.message) || 'OPEN_UPDATE_PAGE_FAILED';
    syncUpdatePreviewStateClass();
    showToast(updatePreviewText('upd_open_failed'));
  }
}

function pulseUpdateReady() {
  var entry = document.getElementById('update-entry');
  var btn = document.getElementById('update-primary-btn');
  if (!window.gsap) return;
  if (entry) {
    window.gsap.fromTo(entry,
      { scale: 0.96, filter: 'brightness(1)' },
      { scale: 1.05, filter: 'brightness(1.28)', duration: 0.26, yoyo: true, repeat: 1, ease: 'power2.out', overwrite: true }
    );
  }
  if (btn) {
    window.gsap.fromTo(btn,
      { scale: 0.985 },
      { scale: 1.015, duration: 0.22, yoyo: true, repeat: 1, ease: 'sine.inOut', overwrite: true }
    );
  }
}
