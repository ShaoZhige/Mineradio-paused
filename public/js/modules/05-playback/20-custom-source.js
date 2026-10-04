// ============================================================
//  洛雪自定义音源 / LX custom sources
//  - 渲染进程只做两件事：管理脚本清单（导入 / 启用 / 删除），以及把当前歌曲交给
//    主进程侧的音源宿主解析播放地址。
//    The renderer does exactly two things: manage the script list (import / activate /
//    delete) and hand the current song to the main-process host for URL resolution.
//  - 脚本永远不在这里执行：它在隔离沙箱窗口里跑，读不到 DOM、Cookie 和本地文件。
//    Scripts never run here: they live in an isolated sandboxed window with no access to
//    the DOM, cookies or local files.
//  - 禁用状态下的播放路径必须与改动前完全一致，所以「确认没有启用脚本」时
//    连本地请求都不发。
//    The disabled path must stay byte-identical to before, so when we know no script is
//    active we do not even issue the local request.
// ============================================================

var customSourceState = {
  items: [],
  activeId: '',
  loaded: false,
  loading: false
};
var customSourceStatusUnsubscribe = null;
var customSourceResolveAbort = null;
var CUSTOM_SOURCE_RESOLVE_TIMEOUT_MS = 20000;

// 界面文案统一走 i18n；缺键时退回内置中文模板，界面不会出现空串或裸 key。
// All UI copy goes through i18n and falls back to the built-in Chinese template, so the
// UI never shows an empty string or a raw key.
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
function customSourceText(key, fallback, params) {
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

// 脚本失败代码到界面文案的映射。后端只回一个机器可读的 code，
// 具体说法由词典决定，这样换个语言不用动后端。
// Failure codes are mapped to copy here so the backend only has to return a
// machine-readable code and switching language never touches it.
var CUSTOM_SOURCE_FAILURE_KEYS = {
  IMPORT_INVALID: 'custom_source_fail_invalid',
  INIT_TIMEOUT: 'custom_source_fail_init_timeout',
  INIT_FAILED: 'custom_source_fail_init',
  SOURCE_UNSUPPORTED: 'custom_source_fail_unsupported',
  QUALITY_UNSUPPORTED: 'custom_source_fail_unsupported',
  CUSTOM_SOURCE_UNAVAILABLE: 'custom_source_fail_unavailable',
  CUSTOM_SOURCE_UNAUTHORIZED: 'custom_source_fail_unauthorized'
};
var CUSTOM_SOURCE_FAILURE_FALLBACKS = {
  custom_source_fail_invalid: '音源脚本格式无效，或缺少开头的注释元数据块',
  custom_source_fail_duplicate: '这个脚本已经导入过了',
  custom_source_fail_init_timeout: '音源脚本初始化超时（10 秒内没有响应）',
  custom_source_fail_init: '音源脚本初始化失败，无法启用',
  custom_source_fail_unsupported: '音源脚本不支持这个平台或音质',
  custom_source_fail_unavailable: '自定义音源不可用',
  custom_source_fail_unauthorized: '音源操作被拒绝',
  custom_source_fail_generic: '音源脚本执行失败：{message}'
};

function customSourceFailureText(error) {
  var raw = String((error && error.message) || error || '');
  var code = (raw.match(/^([A-Z_]{3,}):?\s*/) || [])[1] || '';
  if (/duplicate script/i.test(raw)) code = 'DUPLICATE';
  if (code === 'DUPLICATE') {
    return customSourceText('custom_source_fail_duplicate', CUSTOM_SOURCE_FAILURE_FALLBACKS.custom_source_fail_duplicate);
  }
  var key = CUSTOM_SOURCE_FAILURE_KEYS[code] || 'custom_source_fail_generic';
  var fallback = CUSTOM_SOURCE_FAILURE_FALLBACKS[key] || CUSTOM_SOURCE_FAILURE_FALLBACKS.custom_source_fail_generic;
  var message = raw.replace(/^[A-Z_]{3,}:\s*/, '') || raw;
  return customSourceText(key, fallback, { message: message });
}

function customSourceStatusText(item) {
  if (!item) return '';
  if (item.status === 'ready') return customSourceText('custom_source_status_ready', '已就绪');
  if (item.status === 'starting') return customSourceText('custom_source_status_starting', '初始化中');
  if (item.status === 'failed') {
    return item.message
      ? customSourceFailureText(item.message)
      : customSourceText('custom_source_status_failed', '初始化失败');
  }
  return item.active
    ? customSourceText('custom_source_status_active', '已启用')
    : customSourceText('custom_source_status_idle', '未启用');
}

function customSourceCapabilityText(item) {
  var sources = (item && item.sources && typeof item.sources === 'object') ? item.sources : {};
  var parts = [];
  Object.keys(sources).forEach(function (key) {
    var source = sources[key] || {};
    var qualitys = Array.isArray(source.qualitys) ? source.qualitys : [];
    parts.push(String(key).toUpperCase() + (qualitys.length ? ' · ' + qualitys.join('/') : ''));
  });
  if (parts.length) return parts.join('　');
  return customSourceText('custom_source_capabilities_waiting', '等待脚本报告支持的平台与音质');
}

function setCustomSourceState(result) {
  result = result || {};
  customSourceState.items = Array.isArray(result.items) ? result.items : [];
  customSourceState.activeId = String(result.activeId || '');
  customSourceState.loaded = true;
  renderCustomSourceList();
}

function makeCustomSourceElement(tag, className, text) {
  var element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
}

// 脚本名、作者、描述全部来自第三方文件，一律走 textContent 构建，不拼 HTML 字符串。
// Script name, author and description all come from a third-party file, so everything is
// built with textContent instead of concatenated HTML.
function renderCustomSourceList() {
  var list = document.getElementById('custom-source-list');
  if (!list) return;
  list.replaceChildren();
  if (!customSourceState.items.length) {
    list.appendChild(makeCustomSourceElement('div', 'custom-source-empty',
      customSourceText('custom_source_empty', '尚未导入音源脚本')));
    return;
  }
  customSourceState.items.forEach(function (item) {
    var isActive = item.id === customSourceState.activeId || item.active === true;
    var row = makeCustomSourceElement('article', 'custom-source-item' + (isActive ? ' active' : ''));
    var head = makeCustomSourceElement('div', 'custom-source-item-head');
    var identity = makeCustomSourceElement('div');
    identity.appendChild(makeCustomSourceElement('div', 'custom-source-name',
      item.name || item.id || customSourceText('custom_source_unnamed', '未命名音源')));
    identity.appendChild(makeCustomSourceElement('div', 'custom-source-meta',
      [item.version ? 'v' + item.version : '', item.author || '', item.description || ''].filter(Boolean).join(' · ')));
    head.appendChild(identity);
    head.appendChild(makeCustomSourceElement('div', 'custom-source-status', customSourceStatusText(item)));
    row.appendChild(head);
    row.appendChild(makeCustomSourceElement('div', 'custom-source-capabilities', customSourceCapabilityText(item)));

    var actions = makeCustomSourceElement('div', 'custom-source-actions');
    if (!isActive) {
      var activateButton = makeCustomSourceElement('button', 'primary',
        customSourceText('custom_source_action_activate', '启用'));
      activateButton.type = 'button';
      activateButton.addEventListener('click', function () { activateCustomSource(item.id); });
      actions.appendChild(activateButton);
    }
    var replaceButton = makeCustomSourceElement('button', '',
      customSourceText('custom_source_action_replace', '替换/更新'));
    replaceButton.type = 'button';
    replaceButton.addEventListener('click', function () { replaceCustomSource(item.id); });
    actions.appendChild(replaceButton);

    var removeButton = makeCustomSourceElement('button', 'danger',
      customSourceText('custom_source_action_remove', '删除'));
    removeButton.type = 'button';
    removeButton.addEventListener('click', function () { removeCustomSource(item.id, item.name); });
    actions.appendChild(removeButton);

    var toggle = makeCustomSourceElement('label', 'custom-source-alert-toggle');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.allowUpdateAlert !== false;
    checkbox.addEventListener('change', function () { setCustomSourceUpdateAlert(item.id, checkbox.checked); });
    toggle.appendChild(checkbox);
    toggle.appendChild(document.createTextNode(customSourceText('custom_source_alert_toggle', '更新提醒')));
    actions.appendChild(toggle);

    row.appendChild(actions);
    list.appendChild(row);
  });
}

function customSourceDesktopApi() {
  var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : null;
  if (api && typeof api.listCustomSources === 'function') return api;
  return null;
}

async function refreshCustomSources() {
  var api = customSourceDesktopApi();
  if (!api) return;
  try {
    setCustomSourceState(await api.listCustomSources());
  } catch (error) {
    // 读不到清单不能把状态标成「已加载且为空」，否则播放时会误以为没有启用脚本。
    // A failed list read must not be recorded as "loaded and empty"; otherwise playback
    // would wrongly conclude that no script is active.
    console.warn('[CustomSource] list failed', error && (error.message || error));
  }
}

async function runCustomSourceAction(action, successKey, successFallback) {
  if (customSourceState.loading) return;
  customSourceState.loading = true;
  try {
    var result = await action();
    if (result && !result.canceled) {
      setCustomSourceState(result);
      if (successKey) showToast(customSourceText(successKey, successFallback));
    }
  } catch (error) {
    showToast(customSourceText('custom_source_error_prefix', '音源操作失败：{message}', {
      message: customSourceFailureText(error)
    }));
  } finally {
    customSourceState.loading = false;
  }
}

function openCustomSourceModal() {
  var modal = document.getElementById('custom-source-modal');
  if (!modal) return;
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  refreshCustomSources().catch(function (error) {
    showToast(customSourceText('custom_source_list_error', '音源列表读取失败：{message}', {
      message: error && (error.message || error) || ''
    }));
  });
}

function closeCustomSourceModal() {
  var modal = document.getElementById('custom-source-modal');
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
}

function importCustomSource() {
  var api = customSourceDesktopApi();
  if (!api || typeof api.importCustomSource !== 'function') return;
  if (!window.confirm(customSourceText('custom_source_confirm_import',
    '第三方音源脚本可以向网络发送歌曲信息。仅导入你信任的 .js 脚本。'))) return;
  runCustomSourceAction(function () { return api.importCustomSource(); },
    'custom_source_imported', '音源已导入，确认后可启用');
}

function replaceCustomSource(id) {
  var api = customSourceDesktopApi();
  if (!api || typeof api.replaceCustomSource !== 'function') return;
  runCustomSourceAction(function () { return api.replaceCustomSource(id); },
    'custom_source_replaced', '音源脚本已验证并替换');
}

function activateCustomSource(id) {
  var api = customSourceDesktopApi();
  if (!api || typeof api.activateCustomSource !== 'function') return;
  runCustomSourceAction(function () { return api.activateCustomSource(id); },
    'custom_source_activated', '自定义音源已启用');
}

function deactivateCustomSource() {
  var api = customSourceDesktopApi();
  if (!api || typeof api.deactivateCustomSource !== 'function') return;
  runCustomSourceAction(function () { return api.deactivateCustomSource(); },
    'custom_source_deactivated', '已恢复内置播放解析');
}

function removeCustomSource(id, name) {
  var api = customSourceDesktopApi();
  if (!api || typeof api.removeCustomSource !== 'function') return;
  if (!window.confirm(customSourceText('custom_source_confirm_remove', '删除音源「{name}」？', {
    name: name || id || ''
  }))) return;
  runCustomSourceAction(function () { return api.removeCustomSource(id); },
    'custom_source_removed', '音源已删除');
}

function setCustomSourceUpdateAlert(id, enabled) {
  var api = customSourceDesktopApi();
  if (!api || typeof api.setCustomSourceUpdateAlert !== 'function') return;
  runCustomSourceAction(function () { return api.setCustomSourceUpdateAlert(id, enabled); });
}

function bindCustomSourceManager() {
  var modal = document.getElementById('custom-source-modal');
  if (modal) {
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeCustomSourceModal();
    });
  }
  var api = customSourceDesktopApi();
  // 浏览器里没有主进程桥，标题栏那个入口就该消失，而不是点了没反应。
  // Without the main-process bridge (plain browser) the titlebar entry should disappear
  // rather than look clickable and do nothing.
  if (!api) return;
  if (!customSourceStatusUnsubscribe && typeof api.onCustomSourceStatus === 'function') {
    customSourceStatusUnsubscribe = api.onCustomSourceStatus(function (status) {
      if (status && Array.isArray(status.items)) setCustomSourceState(status);
      else refreshCustomSources().catch(function () {});
      if (status && status.error) {
        showToast(customSourceText('custom_source_runtime_error', '音源错误：{message}', {
          message: customSourceFailureText(status.error)
        }));
      }
      if (status && status.updateAlert && status.updateAlert.log) {
        showToast(customSourceText('custom_source_update_alert', '音源更新：{log}', {
          log: status.updateAlert.log
        }));
      }
    });
  }
  // 语言切换后状态文本（已就绪 / 初始化失败…）是运行时拼的，得重绘一次。
  // Status text is composed at runtime, so a language switch needs a repaint.
  if (window.MineradioI18n && typeof window.MineradioI18n.onLanguageChange === 'function') {
    window.MineradioI18n.onLanguageChange(function () { renderCustomSourceList(); });
  }
  refreshCustomSources().catch(function () {});
}

// ------------------------------------------------------------
//  播放解析 / Playback resolution
// ------------------------------------------------------------

function customSourceIsLocalOrOffline(song) {
  if (!song) return true;
  var type = String(song.type || song.source || '');
  if (type === 'local' || type === 'podcast') return true;
  if (song.localUrl || song.source === 'local') return true;
  return false;
}

// 返回 null 的语义是「交回内置解析」，调用方据此继续原有链路：
// 未启用、脚本对该平台没有主张、请求超时、被取消，都走这一条。
// Returning null means "hand back to the built-in resolver". Not activated, no opinion
// about this platform, timeout and cancellation all take that path.
async function resolveCustomSourcePlaybackData(song, quality) {
  if (customSourceIsLocalOrOffline(song)) return null;
  // 已经确认清单为空时不发请求：禁用自定义音源的播放路径与改动前逐字节一致。
  // With a known-empty list we skip the request entirely, keeping the disabled playback
  // path byte-identical to before this change.
  if (customSourceState.loaded && !customSourceState.items.length) return null;

  var previous = customSourceResolveAbort;
  var controller = typeof AbortController === 'function' ? new AbortController() : null;
  customSourceResolveAbort = controller;
  var timer = null;
  if (controller) timer = setTimeout(function () { controller.abort(); }, CUSTOM_SOURCE_RESOLVE_TIMEOUT_MS);
  try {
    // 切歌时取消上一首还没回来的脚本请求，别让旧脚本继续占着宿主。
    // Cancel the previous script request on a track switch so a stale script no longer
    // occupies the host.
    if (previous && typeof previous.abort === 'function') previous.abort();
    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song: song, quality: quality || 'hires' })
    };
    // apiJson 只在没有外部 signal 时才自建超时控制器，所以这里自己管超时。
    // apiJson only creates its own timeout controller when no external signal is given,
    // so the timeout is owned here.
    if (controller) options.signal = controller.signal;
    else options.timeoutMs = CUSTOM_SOURCE_RESOLVE_TIMEOUT_MS;
    var data = await apiJson('/api/custom-source/resolve', options);
    if (!data || data.active !== true || data.handled !== true) return null;
    if (!data.url) {
      // 脚本声称接管却没给出地址：这不是「交回内置」，而是这一首确实解析不了。
      // The script claimed the track but returned no URL: that is a real failure for this
      // track, not a hand-back to the built-in path.
      return data;
    }
    return data;
  } catch (error) {
    console.warn('[CustomSource] resolve failed', error && (error.message || error));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (customSourceResolveAbort === controller) customSourceResolveAbort = null;
  }
}
