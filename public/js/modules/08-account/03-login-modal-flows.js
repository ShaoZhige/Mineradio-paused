var loginRefreshRequestSeq = 0;
var loginWorkflowDrag = null;
var LOGIN_WORKFLOW_CONNECTION_STORE_KEY = 'mineradio-login-workflow-connections-v1';
// 登录工作流里列出的平台同样来自注册表（login 能力）。
// The platforms listed in the login workflow also come from the registry (login capability).
var LOGIN_WORKFLOW_PROVIDERS = providerRegistryKeysWith('login');
var loginWorkflowPendingProvider = '';
var loginWorkflowVerifiedSession = {};
var loginProviderPointer = null;
var loginProviderClickSuppressed = false;
var loginWorkflowEdgeRenderFrame = 0;
var loginWorkflowEdgeRenderTimers = [];
var SPOTIFY_DEVELOPER_DASHBOARD_URL = 'https://developer.spotify.com/dashboard';
var SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:43879/callback';
var spotifySetupCallbackReady = false;
var spotifySetupDiagnostics = null;
var spotifySetupBusy = false;
var spotifySetupAutoCheckKey = '';
// 登录成功后的换源提醒，单次加载内只弹一次 / one-shot per page load.
var spotifyLoginReminderShown = false;

// 登录相关文案统一走 i18n；缺键时退回内置中文，界面不会出现空串或裸 key。
// Login copy goes through i18n and falls back to the built-in Chinese text, so the
// modal never shows an empty string or a raw key.
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
function loginText(key, fallback, params) {
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

function isLoginRefreshCurrent(provider, seq) {
  return loginProvider === provider && loginRefreshRequestSeq === seq;
}

function normalizeLoginProviderKey(provider) {
  // spotify 必须显式返回，否则会落到默认分支被当成 netease，
  // 登录节点图的 OAuth 分支（loginProvider === 'spotify'）将全部失效。
  // spotify must be matched explicitly or it falls through to the netease default,
  // which silently disables every OAuth branch keyed on loginProvider === 'spotify'.
  if (provider === 'spotify') return 'spotify';
  return provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : 'netease'));
}
function loginProviderSupportsCookieMode(provider) {
  provider = normalizeLoginProviderKey(provider);
  return provider !== 'spotify' && provider !== 'qishui';
}
function loginProviderOfficialModeText(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (provider === 'spotify') return { title: 'OAuth', sub: loginText('login_popup_spotify_window') };
  if (provider === 'qishui') return { title: loginText('login_scan'), sub: loginText('login_douyin_official_auth') };
  if (provider === 'kugou') return { title: loginText('login_official_site'), sub: loginText('login_popup_kugou_window') };
  return { title: loginText('login_scan'), sub: loginText('login_popup_after_connect') };
}
function setManualCookieOpenForProvider(provider, open) {
  provider = normalizeLoginProviderKey(provider);
  if (provider === 'netease') neteaseManualCookieOpen = !!open;
  else if (provider === 'qq') qqManualCookieOpen = !!open;
  else if (provider === 'kugou') kugouManualCookieOpen = !!open;
  else if (provider === 'qishui') qishuiManualCookieOpen = false;
}
function isManualCookieOpenForProvider(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (provider === 'netease') return !!neteaseManualCookieOpen;
  if (provider === 'qq') return !!qqManualCookieOpen;
  if (provider === 'kugou') return !!kugouManualCookieOpen;
  if (provider === 'qishui') return false;
  return false;
}
function readLoginWorkflowConnections() {
  try { localStorage.removeItem(LOGIN_WORKFLOW_CONNECTION_STORE_KEY); } catch (e) { }
  return [];
}
function saveLoginWorkflowConnections(list) {
  try { localStorage.removeItem(LOGIN_WORKFLOW_CONNECTION_STORE_KEY); } catch (e) { }
}
function providerHasLiveLogin(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (loginWorkflowVerifiedSession && loginWorkflowVerifiedSession[provider]) return true;
  try { return typeof hasPlatformLogin === 'function' && hasPlatformLogin(provider); } catch (e) { return false; }
}
function loginWorkflowConnectedProviders() {
  return loginWorkflowProviderOrder().filter(providerHasLiveLogin);
}
function loginWorkflowProviderOrder() {
  try { return accountProviderOrder(); } catch (e) { return LOGIN_WORKFLOW_PROVIDERS.slice(); }
}
function syncLoginWorkflowConnectionsFromStatus() {
  saveLoginWorkflowConnections([]);
  return loginWorkflowConnectedProviders();
}
function hasLoginWorkflowConnection(provider) {
  provider = normalizeLoginProviderKey(provider);
  return loginWorkflowConnectedProviders().indexOf(provider) >= 0;
}
function markLoginWorkflowConnected(provider) {
  provider = normalizeLoginProviderKey(provider);
  loginWorkflowVerifiedSession[provider] = true;
  if (!isAccountProviderExternallyVisible(provider)) {
    var list = accountProviderVisibleList();
    list.push(provider);
    saveAccountProviderVisibleList(list);
  }
}
function setLoginAuthDrawerOpen(open) {
  var drawer = document.getElementById('login-auth-drawer');
  var modal = document.querySelector('#login-modal .dual-login-modal');
  if (modal) modal.classList.toggle('login-details-open', !!open);
  if (drawer) drawer.classList.toggle('show', !!open);
  if (!open) {
    loginWorkflowPendingProvider = '';
    try { stopQrPoll(); } catch (e) { }
  }
}
function markLoginNodeConnecting() {
  var graph = document.getElementById('login-node-graph');
  if (!graph) return;
  graph.classList.remove('connecting');
  void graph.offsetWidth;
  graph.classList.add('connecting');
  setTimeout(function () { graph.classList.remove('connecting'); }, 980);
}
function loginWorkflowActiveMode() {
  return isManualCookieOpenForProvider(loginProvider) ? 'cookie' : 'official';
}
function workflowPointForPort(port, root) {
  if (!port || !root) return null;
  var portRect = port.getBoundingClientRect();
  var rootRect = root.getBoundingClientRect();
  return {
    x: portRect.left + portRect.width / 2 - rootRect.left,
    y: portRect.top + portRect.height / 2 - rootRect.top
  };
}
function workflowPointFromEvent(e, root) {
  if (!e || !root) return null;
  var rootRect = root.getBoundingClientRect();
  return { x: e.clientX - rootRect.left, y: e.clientY - rootRect.top };
}
function workflowPointDistance(a, b) {
  if (!a || !b) return Infinity;
  var dx = a.x - b.x;
  var dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
function loginWorkflowMrTargetPoint(graph) {
  if (!graph) return null;
  return workflowPointForPort(graph.querySelector('[data-login-mr-target="mr"]'), graph);
}
function loginWorkflowSnapPoint(point, graph) {
  var mr = loginWorkflowMrTargetPoint(graph);
  if (point && mr && workflowPointDistance(point, mr) <= 92) return mr;
  return point;
}
function loginWorkflowNearMr(point, graph) {
  var mr = loginWorkflowMrTargetPoint(graph);
  return !!(point && mr && workflowPointDistance(point, mr) <= 108);
}
function workflowBezierPath(a, b) {
  var gap = Math.abs(b.x - a.x);
  var dx = Math.max(18, Math.min(86, gap * 0.55));
  return 'M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
    ' C ' + (a.x + dx).toFixed(1) + ' ' + a.y.toFixed(1) +
    ', ' + (b.x - dx).toFixed(1) + ' ' + b.y.toFixed(1) +
    ', ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
}
function appendWorkflowPath(svg, from, to, className) {
  if (!svg || !from || !to) return;
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', workflowBezierPath(from, to));
  path.setAttribute('class', className || 'workflow-link');
  svg.appendChild(path);
}
function clearWorkflowSvg(svg) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}
function renderLoginWorkflowEdges(tempPoint) {
  var graph = document.getElementById('login-node-graph');
  var svg = document.getElementById('login-workflow-svg');
  if (!graph || !svg) return;
  var w = Math.max(1, graph.clientWidth || 1);
  var h = Math.max(1, graph.clientHeight || 1);
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  clearWorkflowSvg(svg);
  var mrIn = graph.querySelector('[data-login-mr-target="mr"]');
  loginWorkflowConnectedProviders().forEach(function (provider) {
    var providerOut = graph.querySelector('[data-login-provider-output="' + provider + '"]');
    appendWorkflowPath(svg, workflowPointForPort(providerOut, graph), workflowPointForPort(mrIn, graph), 'workflow-link active' + (provider === loginProvider ? ' selected' : ''));
  });
  if (loginWorkflowPendingProvider && !providerHasLiveLogin(loginWorkflowPendingProvider)) {
    var pendingOut = graph.querySelector('[data-login-provider-output="' + loginWorkflowPendingProvider + '"]');
    appendWorkflowPath(svg, workflowPointForPort(pendingOut, graph), workflowPointForPort(mrIn, graph), 'workflow-link pending');
  }
  if (loginWorkflowDrag && tempPoint) {
    appendWorkflowPath(svg, workflowPointForPort(loginWorkflowDrag.port, graph), loginWorkflowSnapPoint(tempPoint, graph), 'workflow-link temp');
  }
}
function scheduleLoginWorkflowEdges(reason) {
  if (loginWorkflowEdgeRenderFrame) cancelAnimationFrame(loginWorkflowEdgeRenderFrame);
  loginWorkflowEdgeRenderFrame = requestAnimationFrame(function () {
    loginWorkflowEdgeRenderFrame = 0;
    renderLoginWorkflowEdges();
  });
  loginWorkflowEdgeRenderTimers.forEach(function (timer) { clearTimeout(timer); });
  loginWorkflowEdgeRenderTimers = [];
  [70, 170, 340, 560].forEach(function (delay) {
    loginWorkflowEdgeRenderTimers.push(setTimeout(function () {
      renderLoginWorkflowEdges();
    }, delay));
  });
}
function selectLoginProviderNode(provider) {
  if (loginProviderClickSuppressed) {
    loginProviderClickSuppressed = false;
    return;
  }
  provider = normalizeLoginProviderKey(provider);
  setLoginProvider(provider, true);
  setLoginAuthDrawerOpen(hasLoginWorkflowConnection(provider) || loginWorkflowPendingProvider === provider);
  updateLoginProviderUi();
}
function connectLoginProviderToMr(provider) {
  provider = normalizeLoginProviderKey(provider);
  if (provider !== loginProvider) setLoginProvider(provider, true);
  loginWorkflowPendingProvider = provider;
  setLoginAuthDrawerOpen(true);
  markLoginNodeConnecting();
  updateLoginProviderUi();
  connectLoginMode(loginWorkflowActiveMode());
}
function finishLoginWorkflowDrag(e) {
  var graph = document.getElementById('login-node-graph');
  if (!graph || !loginWorkflowDrag) return;
  var drag = loginWorkflowDrag;
  var target = document.elementFromPoint(e.clientX, e.clientY);
  var port = target && target.closest ? target.closest('.flow-port.in') : null;
  var mrNode = target && target.closest ? target.closest('[data-login-node="mr"]') : null;
  var eventPoint = workflowPointFromEvent(e, graph);
  var nearMr = loginWorkflowNearMr(eventPoint, graph);
  if ((port && graph.contains(port)) || (mrNode && graph.contains(mrNode)) || nearMr) {
    var mrTarget = port && port.getAttribute('data-login-mr-target');
    if (drag.source === 'provider' && (mrTarget || mrNode || nearMr)) {
      connectLoginProviderToMr(drag.provider);
    }
  }
  loginWorkflowDrag = null;
  graph.classList.remove('dragging-line', 'drop-ready');
  try { graph.releasePointerCapture(e.pointerId); } catch (_) { }
  scheduleLoginWorkflowEdges('wire-finish');
}
function beforeLoginProviderForPointer(y) {
  var parent = document.getElementById('login-platform-tabs');
  if (!parent) return '';
  var nodes = Array.prototype.slice.call(parent.querySelectorAll('[data-login-provider]'));
  for (var i = 0; i < nodes.length; i += 1) {
    var rect = nodes[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return nodes[i].getAttribute('data-login-provider') || '';
  }
  return '';
}
function startLoginWorkflowPointerDrag(graph, state, e) {
  loginWorkflowDrag = {
    port: state.port,
    source: 'provider',
    provider: state.provider
  };
  graph.classList.add('dragging-line');
  renderLoginWorkflowEdges(workflowPointFromEvent(e, graph));
}
function accountProviderOrderAfterMove(provider, beforeProvider) {
  provider = normalizeLoginProviderKey(provider);
  beforeProvider = beforeProvider ? normalizeLoginProviderKey(beforeProvider) : '';
  var order = accountProviderOrder().filter(function (item) { return item !== provider; });
  var index = beforeProvider ? order.indexOf(beforeProvider) : -1;
  if (index < 0) order.push(provider);
  else order.splice(index, 0, provider);
  return order;
}
function shouldMoveLoginProviderBefore(provider, beforeProvider) {
  var current = accountProviderOrder();
  var next = accountProviderOrderAfterMove(provider, beforeProvider);
  return current.join('|') !== next.join('|');
}
function finishLoginProviderPointer(e) {
  var graph = document.getElementById('login-node-graph');
  if (loginWorkflowDrag) {
    finishLoginWorkflowDrag(e);
    loginProviderClickSuppressed = true;
    setTimeout(function () { loginProviderClickSuppressed = false; }, 120);
    return;
  }
  var state = loginProviderPointer;
  loginProviderPointer = null;
  if (graph) graph.classList.remove('sorting-provider');
  if (!state) return;
  if (state.node) state.node.classList.remove('sorting');
  try { if (graph) graph.releasePointerCapture(e.pointerId); } catch (_) { }
  loginProviderClickSuppressed = true;
  setTimeout(function () { loginProviderClickSuppressed = false; }, 120);
  scheduleLoginWorkflowEdges('sort-finish');
}
function loginProviderVipLabel(provider, status) {
  if (!status || !status.loggedIn) return '';
  var level = providerVipLevel(provider, status);
  return level === 'svip' ? 'SVIP' : (level === 'vip' ? 'VIP' : loginText('login_normal'));
}
function handleLoginProviderExternalSwitchEvent(e, provider) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  provider = normalizeLoginProviderKey(provider);
  toggleAccountProviderExternal(provider);
  updateLoginProviderUi();
  scheduleLoginWorkflowEdges('external-switch');
}
function updateLoginProviderCapsuleStatus(provider, btn) {
  var st = platformStatus(provider) || {};
  var meta = platformMeta(provider);
  var handle = btn.querySelector('.login-provider-sort-handle');
  if (!handle) {
    handle = document.createElement('span');
    handle.className = 'login-provider-sort-handle';
    handle.innerHTML = '<i></i><i></i><i></i>';
    btn.insertBefore(handle, btn.firstChild);
  }
  handle.setAttribute('data-login-provider-sort', provider);
  handle.setAttribute('title', 'Drag to sort');
  handle.setAttribute('aria-label', 'Drag to sort');
  var logo = btn.querySelector('.provider-logo');
  if (logo) {
    if (st.loggedIn) {
      logo.classList.add('has-avatar');
      logo.innerHTML = '<img src="' + providerAvatarSrc(provider, st) + '" alt="">';
    } else {
      logo.classList.remove('has-avatar');
      logo.textContent = meta.short;
    }
  }
  var badge = btn.querySelector('.login-provider-state-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'login-provider-state-badge';
    btn.appendChild(badge);
  }
  var externalSwitch = btn.querySelector('.login-provider-external-switch');
  if (!externalSwitch) {
    externalSwitch = document.createElement('span');
    externalSwitch.className = 'login-provider-external-switch';
    btn.appendChild(externalSwitch);
  }
  externalSwitch.removeAttribute('aria-hidden');
  externalSwitch.setAttribute('role', 'switch');
  externalSwitch.setAttribute('tabindex', '0');
  externalSwitch.setAttribute('data-login-provider-external', provider);
  externalSwitch.setAttribute('aria-label', loginText('login_show_in_capsule'));
  externalSwitch.setAttribute('aria-checked', isAccountProviderExternallyVisible(provider) ? 'true' : 'false');
  if (!externalSwitch.querySelector('.login-provider-external-label')) {
    externalSwitch.innerHTML = loginText('login_provider_external_label_html');
  }
  if (!externalSwitch.__loginProviderExternalBound) {
    externalSwitch.__loginProviderExternalBound = true;
    externalSwitch.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
    });
    externalSwitch.addEventListener('click', function (e) {
      handleLoginProviderExternalSwitchEvent(e, externalSwitch.getAttribute('data-login-provider-external') || provider);
    });
    externalSwitch.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      handleLoginProviderExternalSwitchEvent(e, externalSwitch.getAttribute('data-login-provider-external') || provider);
    });
  }
  externalSwitch.title = isAccountProviderExternallyVisible(provider) ? loginText('login_show_capsule_off') : loginText('login_show_capsule_on');
  var label = loginProviderVipLabel(provider, st);
  var level = providerVipLevel(provider, st);
  badge.textContent = label;
  badge.className = 'login-provider-state-badge ' + (st.loggedIn ? (level === 'none' ? 'normal' : level) : 'hidden');
}
function bindLoginWorkflowPointerEvents() {
  var graph = document.getElementById('login-node-graph');
  if (!graph || graph._workflowBound) return;
  graph._workflowBound = true;
  graph.addEventListener('pointerdown', function (e) {
    var sortHandle = e.target && e.target.closest ? e.target.closest('[data-login-provider-sort]') : null;
    if (sortHandle && graph.contains(sortHandle)) {
      var sortNode = sortHandle.closest('.login-node-providers [data-login-provider]');
      var sortProvider = sortNode && sortNode.getAttribute('data-login-provider') || sortHandle.getAttribute('data-login-provider-sort') || '';
      if (!sortProvider) return;
      sortProvider = normalizeLoginProviderKey(sortProvider);
      if (sortProvider !== loginProvider) setLoginProvider(sortProvider, true);
      loginProviderPointer = {
        provider: sortProvider,
        node: sortNode,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false
      };
      if (sortNode) sortNode.classList.add('sorting');
      graph.classList.add('sorting-provider');
      loginProviderClickSuppressed = true;
      try { graph.setPointerCapture(e.pointerId); } catch (_) { }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    var port = e.target && e.target.closest ? e.target.closest('.flow-port.out') : null;
    if (!port || !graph.contains(port)) return;
    var providerNode = port.closest('.login-node-providers [data-login-provider]');
    var provider = port.getAttribute('data-login-provider-output') || (providerNode && providerNode.getAttribute('data-login-provider')) || '';
    if (!provider) return;
    if (provider !== loginProvider) setLoginProvider(provider, true);
    loginProviderClickSuppressed = true;
    startLoginWorkflowPointerDrag(graph, { provider: provider, port: port }, e);
    try { graph.setPointerCapture(e.pointerId); } catch (_) { }
    e.preventDefault();
    e.stopPropagation();
  });
  graph.addEventListener('pointermove', function (e) {
    if (!loginProviderPointer && !loginWorkflowDrag) return;
    e.preventDefault();
    if (loginProviderPointer) {
      var dx = e.clientX - loginProviderPointer.startX;
      var dy = e.clientY - loginProviderPointer.startY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (!loginProviderPointer.dragging && dist < 5) return;
      loginProviderPointer.dragging = true;
      if (loginProviderPointer.node) loginProviderPointer.node.classList.add('sorting');
      graph.classList.add('sorting-provider');
      loginProviderClickSuppressed = true;
      var beforeProvider = beforeLoginProviderForPointer(e.clientY);
      if (beforeProvider !== loginProviderPointer.provider && shouldMoveLoginProviderBefore(loginProviderPointer.provider, beforeProvider)) {
        moveAccountProviderBefore(loginProviderPointer.provider, beforeProvider);
        updateLoginProviderUi();
      }
      return;
    }
    if (!loginWorkflowDrag) return;
    var point = workflowPointFromEvent(e, graph);
    graph.classList.toggle('drop-ready', loginWorkflowNearMr(point, graph));
    renderLoginWorkflowEdges(point);
  });
  graph.addEventListener('pointerup', finishLoginProviderPointer);
  graph.addEventListener('pointercancel', function (e) {
    if (loginProviderPointer && loginProviderPointer.node) loginProviderPointer.node.classList.remove('sorting');
    loginProviderPointer = null;
    loginWorkflowDrag = null;
    graph.classList.remove('dragging-line', 'drop-ready', 'sorting-provider');
    try { graph.releasePointerCapture(e.pointerId); } catch (_) { }
    scheduleLoginWorkflowEdges('pointer-cancel');
  });
  if (!bindLoginWorkflowPointerEvents._resizeBound) {
    bindLoginWorkflowPointerEvents._resizeBound = true;
    window.addEventListener('resize', function () { scheduleLoginWorkflowEdges('resize'); });
    window.addEventListener('orientationchange', function () { scheduleLoginWorkflowEdges('orientation'); });
  }
}
function updateLoginNodeGraphUi() {
  var graph = document.getElementById('login-node-graph');
  if (graph) graph.setAttribute('data-provider', loginProvider);
  syncAccountProviderOrderUi();
  var connected = syncLoginWorkflowConnectionsFromStatus();
  loginWorkflowProviderOrder().forEach(function (provider) {
    var btn = document.getElementById('login-provider-' + provider);
    if (!btn) return;
    updateLoginProviderCapsuleStatus(provider, btn);
    btn.classList.toggle('active', provider === loginProvider);
    btn.classList.toggle('external-on', isAccountProviderExternallyVisible(provider));
    btn.classList.toggle('connected', connected.indexOf(provider) >= 0);
    btn.classList.toggle('pending', loginWorkflowPendingProvider === provider && connected.indexOf(provider) < 0);
  });
  var official = document.getElementById('login-mode-official');
  var cookie = document.getElementById('login-mode-cookie');
  var officialText = loginProviderOfficialModeText(loginProvider);
  if (official) {
    var title = official.querySelector('b');
    var sub = official.querySelector('small');
    if (title) title.textContent = officialText.title;
    if (sub) sub.textContent = officialText.sub;
    official.disabled = false;
    official.classList.toggle('active', !isManualCookieOpenForProvider(loginProvider));
  }
  if (cookie) {
    var cookieTitle = cookie.querySelector('b');
    var cookieSub = cookie.querySelector('small');
    if (cookieTitle) cookieTitle.textContent = 'Cookie';
    if (cookieSub) cookieSub.textContent = loginProviderSupportsCookieMode(loginProvider) ? loginText('login_manual_import_after_connect') : loginText('login_cookie_import_unsupported');
    cookie.disabled = !loginProviderSupportsCookieMode(loginProvider);
    cookie.classList.toggle('active', isManualCookieOpenForProvider(loginProvider));
  }
  var copy = graph && graph.querySelector('.login-node-copy');
  if (copy) {
    var meta = platformMeta(loginProvider);
    var copySub = copy.querySelector('small');
    var connectedCount = connected.length;
    if (copySub) copySub.textContent = hasLoginWorkflowConnection(loginProvider)
      ? ((meta && meta.label || loginProvider) + loginText('login_connected_total_infix') + connectedCount + loginText('login_api_count_suffix'))
      : (loginWorkflowPendingProvider === loginProvider
        ? ((meta && meta.label || loginProvider) + loginText('login_pending_confirm_suffix'))
        : (connectedCount ? (loginText('login_connected_prefix') + connectedCount + loginText('login_api_count_drag_more')) : loginText('login_drag_api_here')));
  }
  scheduleLoginWorkflowEdges('node-ui');
}
function connectLoginProvider(provider) {
  selectLoginProviderNode(provider);
}
function selectLoginMode(mode) {
  if (mode === 'cookie' && !loginProviderSupportsCookieMode(loginProvider)) {
    showToast(loginProvider === 'qishui' ? loginText('login_qishui_scan_only') : loginText('login_spotify_oauth_note'));
    return;
  }
  setManualCookieOpenForProvider(loginProvider, mode === 'cookie');
  updateLoginProviderUi();
  setLoginAuthDrawerOpen(hasLoginWorkflowConnection(loginProvider) || loginWorkflowPendingProvider === loginProvider);
}
function startSelectedLoginConnection() {
  if (!hasLoginWorkflowConnection(loginProvider) && loginWorkflowPendingProvider !== loginProvider) {
    showToast(loginText('login_drag_api_hint'));
    return;
  }
  setLoginAuthDrawerOpen(true);
  connectLoginMode(loginWorkflowActiveMode());
}
function connectLoginMode(mode) {
  setLoginAuthDrawerOpen(true);
  markLoginNodeConnecting();
  if (loginProvider === 'spotify') {
    setManualCookieOpenForProvider('spotify', false);
    updateLoginProviderUi();
    scheduleSpotifySetupAutoCheck();
    return;
  }
  if (mode === 'cookie') {
    if (!loginProviderSupportsCookieMode(loginProvider)) {
      showToast(loginProvider === 'qishui' ? loginText('login_qishui_scan_only') : loginText('login_spotify_oauth_note'));
      return;
    }
    setManualCookieOpenForProvider(loginProvider, true);
    updateLoginProviderUi();
    var input = document.getElementById('qq-cookie-input');
    if (input) setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }, 80);
    return;
  }
  setManualCookieOpenForProvider(loginProvider, false);
  updateLoginProviderUi();
  setTimeout(openProviderWebLogin, 120);
}

var pendingCookieExportProvider = '';
function providerCookieExportLabel(provider) {
  provider = normalizeLoginProviderKey(provider);
  var meta = platformMeta(provider);
  return meta && meta.label || (provider === 'spotify' ? 'Spotify' : provider);
}
function offerLoginCookieExport(provider, info) {
  provider = normalizeLoginProviderKey(provider);
  if (!hasPlatformLogin(provider) && !(info && info.loggedIn)) return;
  markLoginWorkflowConnected(provider);
  updateLoginNodeGraphUi();
  pendingCookieExportProvider = provider;
  var label = providerCookieExportLabel(provider);
  var prompt = document.getElementById('cookie-export-prompt');
  var title = document.getElementById('cookie-export-title');
  var desc = document.getElementById('cookie-export-desc');
  if (title) title.textContent = loginText('login_export_cookie_prefix') + label + loginText('login_export_cookie_suffix');
  if (desc) desc.textContent = loginText('login_cookie_filename_prefix') + label + loginText('login_cookie_filename_suffix');
  if (prompt) prompt.classList.add('show');
}
function dismissCookieExportPrompt() {
  pendingCookieExportProvider = '';
  var prompt = document.getElementById('cookie-export-prompt');
  if (prompt) prompt.classList.remove('show');
}
async function confirmCookieExportPrompt() {
  var provider = pendingCookieExportProvider;
  dismissCookieExportPrompt();
  if (!provider) return;
  var api = window.desktopWindow;
  if (!api || typeof api.exportLoginCookie !== 'function') {
    showToast(loginText('login_export_desktop_only'));
    return;
  }
  try {
    var result = await api.exportLoginCookie(provider);
    if (result && result.ok) showToast(loginText('login_cookie_exported'));
    else showToast(backendText(result, null, loginText('login_no_cookie_to_export')));
  } catch (e) {
    showToast(loginText('login_export_cookie_failed'));
  }
}

async function showLoginModal(opts) {
  opts = opts || {};
  loginProvider = opts.provider ? normalizeLoginProviderKey(opts.provider) : 'netease';
  var modal = document.getElementById('login-modal');
  if (typeof setLoginEasterEggMode === 'function' &&
      (!loginEasterEggState || !loginEasterEggState.ready || !loginEasterEggState.unlocked)) {
    setLoginEasterEggMode(true);
  }
  openGsapModal(modal);
  var unlocked = typeof prepareLoginEasterEggGate === 'function'
    ? await prepareLoginEasterEggGate()
    : true;
  if (!unlocked) return;
  resumeLoginModalAfterGate();
}
function resumeLoginModalAfterGate() {
  bindLoginWorkflowPointerEvents();
  setLoginAuthDrawerOpen(false);
  updateLoginProviderUi();
  scheduleLoginWorkflowEdges('open');
}
function closeLoginModal() {
  stopQrPoll();
  setLoginAuthDrawerOpen(false);
  closeGsapModal(document.getElementById('login-modal'));
}
function setLoginProvider(provider, silent) {
  loginProvider = normalizeLoginProviderKey(provider);
  loginRefreshRequestSeq += 1;
  updateLoginProviderUi();
  if (!silent && document.getElementById('login-modal').classList.contains('show')) refreshQr();
}
function qishuiPublicSearchReady() {
  return !!(qishuiLoginStatus && (qishuiLoginStatus.searchReady || qishuiLoginStatus.publicCatalog));
}
function qishuiLoginStatusText(info) {
  info = info || qishuiLoginStatus || {};
  if (info.reauthRequired) return loginText('login_qishui_expired');
  if (info.stale) return loginText('login_qishui_unavailable');
  if (info.webSession) return loginText('login_qishui_connected');
  return loginText('login_scan_douyin_qr');
}
function spotifyLoginStatusText(info) {
  info = info || spotifyLoginStatus || {};
  if (info.loggedIn) return loginText('login_spotify_connected_prefix_2') + (info.product === 'premium' ? 'Premium' : (info.product ? String(info.product).toUpperCase() : loginText('login_plan_unknown'))) + loginText('login_spotify_syncable_suffix');
  if (info.reauthRequired) return loginText('login_spotify_grant_expired');
  if (info.stale) return loginText('login_spotify_session_expired');
  if (info.localConfigMissing) return loginText('login_spotify_not_connected');
  if (info.oauthConfigured) return loginText('login_spotify_ready_connect');
  if (info.configured || info.searchReady) return loginText('login_spotify_search_ready');
  var missing = info.oauthMissing && info.oauthMissing.length ? (loginText('login_missing_prefix') + info.oauthMissing.join(', ')) : '';
  return loginText('login_spotify_dashboard_hint') + missing;
}
function parseSpotifyConfigInput(text) {
  text = String(text || '').trim();
  if (!text) return {};
  var parsed = null;
  if (/^\s*\{/.test(text)) {
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  }
  if (parsed && typeof parsed === 'object') {
    var source = parsed.spotify && typeof parsed.spotify === 'object' ? parsed.spotify : parsed;
    return {
      clientId: source.clientId || source.client_id || source.id || '',
      redirectUri: source.redirectUri || source.redirect_uri || source.callbackUrl || source.callback_url || '',
      market: source.market || source.country || '',
      scope: source.scope || source.scopes || ''
    };
  }
  var payload = {};
  var loose = [];
  text.split(/[\r\n;]+/).forEach(function (part) {
    part = String(part || '').trim();
    if (!part) return;
    var pair = part.match(/^([A-Za-z0-9_\-\s]+)\s*[:=]\s*(.+)$/);
    if (!pair) {
      loose.push(part);
      return;
    }
    var key = pair[1].toLowerCase().replace(/[\s_-]+/g, '');
    var value = pair[2].trim();
    if (key === 'clientid' || key === 'spotifyclientid' || key === 'id') payload.clientId = value;
    else if (key === 'redirecturi' || key === 'callbackurl' || key === 'callback') payload.redirectUri = value;
    else if (key === 'market' || key === 'country') payload.market = value;
    else if (key === 'scope' || key === 'scopes') payload.scope = value;
  });
  if (!payload.clientId && loose.length) payload.clientId = loose[0];
  return payload;
}
async function openSpotifyDeveloperDashboard() {
  try {
    var api = window.desktopWindow;
    if (api && typeof api.openUpdatePage === 'function') await api.openUpdatePage(SPOTIFY_DEVELOPER_DASHBOARD_URL);
    else window.open(SPOTIFY_DEVELOPER_DASHBOARD_URL, '_blank');
  } catch (e) { }
  showToast(loginText('login_spotify_dashboard_opened'));
}
async function copySpotifyRedirectUri() {
  var ok = false;
  try {
    var api = window.desktopWindow;
    if (api && typeof api.copyText === 'function') {
      var res = await Promise.resolve(api.copyText(SPOTIFY_REDIRECT_URI));
      ok = !res || res.ok !== false;
    }
  } catch (e) { ok = false; }
  if (!ok && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(SPOTIFY_REDIRECT_URI);
      ok = true;
    } catch (e) { ok = false; }
  }
  if (!ok) {
    var helper = document.createElement('textarea');
    helper.value = SPOTIFY_REDIRECT_URI;
    helper.setAttribute('readonly', 'readonly');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(helper);
  }
  showToast(ok ? loginText('login_callback_copied') : loginText('login_copy_callback_failed'));
}

function spotifySetupCurrentStep() {
  var configReady = !!(spotifyLoginStatus && spotifyLoginStatus.oauthConfigured);
  var loggedIn = !!(spotifyLoginStatus && spotifyLoginStatus.loggedIn);
  if (!configReady) return 1;
  if (!spotifySetupCallbackReady && !loggedIn) return 2;
  if (!loggedIn) return 3;
  return 4;
}

function setSpotifySetupOverall(message, kind) {
  var node = document.getElementById('spotify-setup-overall');
  if (!node) return;
  node.textContent = message || loginText('login_spotify_auto_detect_hint');
  node.className = 'spotify-setup-overall' + (kind ? (' ' + kind) : '');
}

function spotifySetupEscapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function renderSpotifySetupChecks() {
  var root = document.getElementById('spotify-setup-check-list');
  if (!root) return;
  var checks = spotifySetupDiagnostics && Array.isArray(spotifySetupDiagnostics.checks)
    ? spotifySetupDiagnostics.checks.filter(function (check) {
      return ['profile', 'scopes', 'library', 'playlists'].indexOf(check && check.id) >= 0;
    })
    : [];
  if (!checks.length) {
    root.innerHTML = loginText('login_spotify_setup_checks_html');
    return;
  }
  root.innerHTML = checks.map(function (check) {
    var title = spotifySetupEscapeHtml(check && check.title || loginText('login_api'));
    var message = spotifySetupEscapeHtml(check && check.message || '');
    return '<span class="spotify-setup-check ' + (check && check.ok ? 'ok' : 'fail') + '" title="' + message + '">' + title + '</span>';
  }).join('');
}

function renderSpotifySetupWizard() {
  var wizard = document.getElementById('spotify-setup-wizard');
  if (!wizard) return;
  var configReady = !!(spotifyLoginStatus && spotifyLoginStatus.oauthConfigured);
  var loggedIn = !!(spotifyLoginStatus && spotifyLoginStatus.loggedIn);
  var diagnosticsReady = !!(spotifySetupDiagnostics && spotifySetupDiagnostics.ready);
  var currentStep = spotifySetupCurrentStep();
  var completed = {
    1: configReady,
    2: spotifySetupCallbackReady || loggedIn,
    3: loggedIn,
    4: diagnosticsReady
  };
  [1, 2, 3, 4].forEach(function (step) {
    var card = document.getElementById('spotify-setup-step-' + step);
    var progress = document.querySelector('[data-spotify-progress="' + step + '"]');
    var state = document.querySelector('[data-spotify-step-state="' + step + '"]');
    var locked = step > currentStep && !completed[step];
    if (card) {
      card.classList.toggle('is-complete', !!completed[step]);
      card.classList.toggle('is-active', step === currentStep && !completed[step]);
      card.classList.toggle('is-locked', !!locked);
    }
    if (progress) {
      progress.classList.toggle('complete', !!completed[step]);
      progress.classList.toggle('current', step === currentStep && !completed[step]);
    }
    if (state) state.textContent = completed[step] ? loginText('login_passed') : (locked ? loginText('login_wait_previous_step') : (spotifySetupBusy ? loginText('login_checking') : loginText('login_in_progress')));
  });
  var input = document.getElementById('spotify-setup-client-id');
  if (input && !input.value && spotifyLoginStatus && spotifyLoginStatus.clientId) input.value = spotifyLoginStatus.clientId;
  var redirect = document.getElementById('spotify-setup-redirect-uri');
  if (redirect) redirect.textContent = spotifyLoginStatus && spotifyLoginStatus.redirectUri || SPOTIFY_REDIRECT_URI;
  var saveButton = document.getElementById('spotify-setup-save-client');
  var callbackButton = document.getElementById('spotify-setup-check-callback');
  var authButton = document.getElementById('spotify-setup-authorize');
  var diagnoseButton = document.getElementById('spotify-setup-diagnose');
  if (saveButton) saveButton.disabled = spotifySetupBusy || spotifyConfigBusy || spotifyOAuthBusy;
  if (callbackButton) callbackButton.disabled = !configReady || spotifySetupBusy || spotifyOAuthBusy;
  if (authButton) {
    authButton.disabled = !configReady || (!spotifySetupCallbackReady && !loggedIn) || spotifySetupBusy || spotifyOAuthBusy;
    authButton.textContent = spotifyOAuthBusy ? loginText('login_wait_browser_auth') : (loggedIn ? loginText('login_reauthorize_spotify') : loginText('login_open_browser_auth'));
  }
  if (diagnoseButton) diagnoseButton.disabled = !loggedIn || spotifySetupBusy || spotifyOAuthBusy;
  renderSpotifySetupChecks();
}

async function saveSpotifySetupClientId() {
  if (spotifySetupBusy || spotifyConfigBusy || spotifyOAuthBusy) return;
  var input = document.getElementById('spotify-setup-client-id');
  var clientId = String(input && input.value || '').replace(/\s+/g, '').trim();
  if (!clientId) {
    setSpotifySetupOverall(loginText('login_paste_dashboard_id'), 'fail');
    if (input) input.focus();
    return;
  }
  spotifyConfigBusy = true;
  spotifySetupBusy = true;
  setSpotifySetupOverall(loginText('login_saving_verifying_client_id'));
  renderSpotifySetupWizard();
  try {
    var info = await apiJson('/api/spotify/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId, redirectUri: SPOTIFY_REDIRECT_URI })
    });
    if (!info || info.ok === false || info.error) throw new Error(backendText(info, null, loginText('login_client_id_save_failed')));
    spotifyLoginStatus = normalizeSpotifyLoginStatus(info);
    spotifySetupCallbackReady = false;
    spotifySetupDiagnostics = null;
    setSpotifySetupOverall(loginText('login_client_id_format_ok'), 'success');
  } catch (error) {
    setSpotifySetupOverall(error && error.message || loginText('login_client_id_save_failed'), 'fail');
  } finally {
    spotifyConfigBusy = false;
    spotifySetupBusy = false;
    updateLoginProviderUi();
  }
}

async function verifySpotifySetupCallback(silent) {
  if (spotifySetupBusy || spotifyOAuthBusy) return false;
  var api = window.desktopWindow;
  if (!api || typeof api.verifySpotifyMusicSetup !== 'function') {
    spotifySetupCallbackReady = false;
    setSpotifySetupOverall(loginText('login_not_desktop_env'), 'fail');
    renderSpotifySetupWizard();
    return false;
  }
  spotifySetupBusy = true;
  if (!silent) setSpotifySetupOverall(loginText('login_checking_callback'));
  renderSpotifySetupWizard();
  try {
    var result = await api.verifySpotifyMusicSetup();
    spotifySetupCallbackReady = !!(result && result.ok && result.callbackReady);
    setSpotifySetupOverall(result && result.message || (spotifySetupCallbackReady ? loginText('login_callback_check_passed') : loginText('login_local_callback_check_failed')), spotifySetupCallbackReady ? 'success' : 'fail');
    return spotifySetupCallbackReady;
  } catch (error) {
    spotifySetupCallbackReady = false;
    setSpotifySetupOverall(error && error.message || loginText('login_local_callback_check_failed'), 'fail');
    return false;
  } finally {
    spotifySetupBusy = false;
    renderSpotifySetupWizard();
  }
}

async function runSpotifySetupDiagnostics(force) {
  if (spotifySetupBusy) return spotifySetupDiagnostics;
  spotifySetupBusy = true;
  setSpotifySetupOverall(loginText('login_spotify_verify_profile'));
  renderSpotifySetupWizard();
  try {
    spotifySetupDiagnostics = await apiJson('/api/spotify/setup/diagnostics?t=' + Date.now());
    var ready = !!(spotifySetupDiagnostics && spotifySetupDiagnostics.ready);
    setSpotifySetupOverall(spotifySetupDiagnostics && spotifySetupDiagnostics.message || (ready ? loginText('login_spotify_all_apis_ok') : loginText('login_some_apis_failed')), ready ? 'success' : 'fail');
    return spotifySetupDiagnostics;
  } catch (error) {
    spotifySetupDiagnostics = { ready: false, checks: [], message: error && error.message || loginText('login_spotify_check_failed') };
    setSpotifySetupOverall(spotifySetupDiagnostics.message, 'fail');
    return spotifySetupDiagnostics;
  } finally {
    spotifySetupBusy = false;
    renderSpotifySetupWizard();
  }
}

function scheduleSpotifySetupAutoCheck() {
  if (loginProvider !== 'spotify') return;
  var key = [spotifyLoginStatus && spotifyLoginStatus.oauthConfigured ? 1 : 0, spotifyLoginStatus && spotifyLoginStatus.loggedIn ? 1 : 0].join(':');
  if (spotifySetupAutoCheckKey === key) return;
  spotifySetupAutoCheckKey = key;
  setTimeout(async function () {
    if (loginProvider !== 'spotify') return;
    if (loginProvider === 'spotify' && spotifyLoginStatus && spotifyLoginStatus.loggedIn) await runSpotifySetupDiagnostics(false);
  }, 80);
}
function openQishuiPublicSearch() {
  closeLoginModal();
  if (typeof setSearchMode === 'function') setSearchMode('qishui');
  var input = document.getElementById('search-input');
  if (input) {
    setTimeout(function () {
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) { } }
    }, 60);
  }
  showToast(loginText('login_qishui_search_match'));
}
function updateLoginProviderUi() {
  var meta = platformMeta(loginProvider);
  var isQQ = loginProvider === 'qq';
  var isKugou = loginProvider === 'kugou';
  var isQishui = loginProvider === 'qishui';
  var isNetease = loginProvider === 'netease';
  var isManualCookieProvider = isNetease || isQQ || isKugou;
  var title = document.getElementById('login-modal-title');
  var desc = document.getElementById('login-modal-desc');
  var shell = document.getElementById('qr-shell');
  var st = document.getElementById('qr-status');
  var refreshBtn = document.getElementById('refresh-qr-btn');
  var qqPanel = document.getElementById('qq-cookie-panel');
  var qqCookieToggle = document.getElementById('qq-cookie-toggle-btn');
  var qqCookieInput = document.getElementById('qq-cookie-input');
  var qqCookieNote = qqPanel ? qqPanel.querySelector('.qq-cookie-note') : null;
  var qqCard = document.getElementById('qq-web-login-card');
  var neteaseBtn = document.getElementById('login-provider-netease');
  var qqBtn = document.getElementById('login-provider-qq');
  var kugouBtn = document.getElementById('login-provider-kugou');
  var qishuiBtn = document.getElementById('login-provider-qishui');
  var qqCookieSaveBtn = document.getElementById('qq-cookie-save-btn');
  var canOpenNeteaseWeb = !!(window.desktopWindow && typeof window.desktopWindow.openNeteaseMusicLogin === 'function');
  var canUseQishuiQrLogin = true;
  var qishuiSearchReady = qishuiPublicSearchReady();
  var qishuiBusy = !!(qishuiTokenBusy || qishuiOAuthBusy);
  var isSpotify = loginProvider === 'spotify';
  var spotifyBtn = document.getElementById('login-provider-spotify');
  var loginDrawer = document.getElementById('login-auth-drawer');
  var loginModalPanel = document.querySelector('#login-modal .dual-login-modal');
  var spotifyWizard = document.getElementById('spotify-setup-wizard');
  var canOpenSpotifyOAuth = !!(window.desktopWindow && typeof window.desktopWindow.openSpotifyMusicLogin === 'function');
  var spotifyBusy = !!(spotifyConfigBusy || spotifyOAuthBusy);
  if (loginDrawer) loginDrawer.classList.toggle('spotify-mode', isSpotify);
  if (loginModalPanel) loginModalPanel.classList.toggle('spotify-setup-open', isSpotify);
  if (spotifyWizard) spotifyWizard.setAttribute('aria-hidden', isSpotify ? 'false' : 'true');
  updateLoginNodeGraphUi();
  if (isSpotify) {
    if (neteaseBtn) neteaseBtn.classList.toggle('active', false);
    if (qqBtn) qqBtn.classList.toggle('active', false);
    if (kugouBtn) kugouBtn.classList.toggle('active', false);
    if (qishuiBtn) qishuiBtn.classList.toggle('active', false);
    if (spotifyBtn) spotifyBtn.classList.toggle('active', true);
    if (title) title.textContent = loginText('login_connect_spotify');
    if (desc) desc.innerHTML = canOpenSpotifyOAuth
      ? loginText('login_spotify_client_id_hint')
      : loginText('login_no_desktop_bridge');
    if (shell) {
      shell.classList.add('web-login-preview');
      shell.classList.remove('qq-preview', 'netease-preview');
    }
    if (qqPanel) {
      qqPanel.classList.add('show', 'spotify-guide-panel');
    }
    if (qqCookieToggle) qqCookieToggle.classList.remove('show');
    if (qqCookieInput) qqCookieInput.placeholder = spotifyLoginStatus.oauthConfigured
      ? loginText('login_client_id_saved')
      : loginText('login_paste_spotify_client_id');
    if (qqCookieNote) qqCookieNote.innerHTML =
      loginText('login_spotify_guide_title_html') +
      '<div class="spotify-guide-steps">' +
        loginText('login_step1_create_app_html') +
        loginText('login_step2_redirect_prefix_html') + SPOTIFY_REDIRECT_URI + '</code></span>' +
        loginText('login_step3_copy_id_html') +
      '</div>' +
      '<div class="spotify-guide-actions">' +
        loginText('login_open_dashboard_btn_html') +
        loginText('login_copy_callback_btn_html') +
        loginText('login_pkce_note_html') +
      '</div>';
    if (qqCookieSaveBtn) {
      qqCookieSaveBtn.disabled = spotifyBusy;
      qqCookieSaveBtn.textContent = spotifyConfigBusy ? loginText('login_saving') : (spotifyOAuthBusy ? loginText('login_wait_authorize') : loginText('login_save_and_authorize'));
    }
    if (qqCard) {
      qqCard.style.display = '';
      qqCard.disabled = spotifyBusy || !canOpenSpotifyOAuth || !spotifyLoginStatus.oauthConfigured;
      var spCardMark = qqCard.querySelector('b');
      var spCardLabel = qqCard.querySelector('span');
      if (spCardMark) spCardMark.textContent = 'SP';
      if (spCardLabel) spCardLabel.textContent = spotifyOAuthBusy ? loginText('login_wait_spotify_auth') : (spotifyLoginStatus.oauthConfigured ? loginText('login_open_spotify_auth') : loginText('login_save_client_id_first'));
    }
    if (st) {
      st.className = 'preview';
      st.textContent = spotifyLoginStatusText();
    }
    if (refreshBtn) {
      refreshBtn.disabled = spotifyBusy || !canOpenSpotifyOAuth;
      refreshBtn.textContent = spotifyConfigBusy ? loginText('login_saving') : (spotifyOAuthBusy ? loginText('login_wait_authorize') : (spotifyLoginStatus.oauthConfigured ? loginText('login_connect_spotify') : loginText('login_save_and_authorize')));
      refreshBtn.onclick = spotifyLoginStatus.oauthConfigured ? openSpotifyWebLogin : submitSpotifyConfigLogin;
    }
    renderSpotifySetupWizard();
    scheduleSpotifySetupAutoCheck();
    updateLoginNodeGraphUi();
    return;
  }
  if (qqPanel) qqPanel.classList.remove('spotify-guide-panel');
  if (spotifyBtn) spotifyBtn.classList.toggle('active', false);
  if (neteaseBtn) neteaseBtn.classList.toggle('active', loginProvider === 'netease');
  if (qqBtn) qqBtn.classList.toggle('active', isQQ);
  if (kugouBtn) kugouBtn.classList.toggle('active', isKugou);
  if (qishuiBtn) qishuiBtn.classList.toggle('active', isQishui);
  if (title) title.textContent = isQishui ? loginText('login_scan_qishui_music') : (loginText('scan_qr_login', '扫码登录') + meta.label);
  if (desc) desc.innerHTML = isQQ
    ? loginText('qq_scan_desc', '打开 <b>QQ 音乐官方网页登录窗口</b> 扫码，成功后会自动同步账号会话。')
    : (isKugou
      ? loginText('login_kugou_web_hint')
    : (isQishui
      ? loginText('login_qishui_scan_hint')
    : (canOpenNeteaseWeb
      ? loginText('netease_web_scan_desc', '打开 <b>网易云音乐官方网页登录窗口</b> 扫码，避开接口二维码风控；成功后会自动同步账号会话。')
      : loginText('netease_app_scan_desc', '使用 <b>网易云音乐 App</b> 扫码，可同步歌单、红心与播客。'))));
  var manualCookieOpen = isManualCookieOpenForProvider(loginProvider);
  if (shell) {
    var useWebPreview = isQQ || isKugou || (isNetease && (canOpenNeteaseWeb || manualCookieOpen));
    shell.classList.toggle('web-login-preview', useWebPreview);
    shell.classList.toggle('qq-preview', isQQ);
    shell.classList.toggle('netease-preview', isNetease && canOpenNeteaseWeb);
  }
  if (qqPanel) qqPanel.classList.toggle('show', isManualCookieProvider && manualCookieOpen);
  if (qqCookieToggle) {
    qqCookieToggle.classList.toggle('show', isManualCookieProvider);
    qqCookieToggle.textContent = manualCookieOpen ? loginText('collapse_import', '收起导入') : loginText('login_cookie_import');
  }
  if (qqCookieInput) qqCookieInput.placeholder = isKugou ? 'KuGoo=...; token=...; userid=...; kg_mid=...' : (isNetease ? 'MUSIC_U=...; __csrf=...' : 'uin=...; qqmusic_key=...; qm_keyst=...');
  if (qqCookieNote) qqCookieNote.textContent = isKugou ? loginText('login_import_kugou_desc') : (isNetease ? loginText('login_import_netease_desc') : loginText('login_cookie_hint', '从 y.qq.com 的登录会话导入。'));
  if (qqCookieSaveBtn) qqCookieSaveBtn.textContent = loginText('login_save_cookie');
  if (qqCard) {
    qqCard.style.display = '';
    qqCard.disabled = isQishui ? (qishuiBusy || !canUseQishuiQrLogin) : (isQQ ? !!qqWebLoginBusy : (isKugou ? !!kugouWebLoginBusy : !!neteaseWebLoginBusy));
    var cardMark = qqCard.querySelector('b');
    var cardLabel = qqCard.querySelector('span');
    if (cardMark) cardMark.textContent = isQQ ? 'QQ' : (isKugou ? 'KG' : (isQishui ? 'QS' : 'NE'));
    if (cardLabel) cardLabel.textContent = isQQ
      ? (qqWebLoginBusy ? loginText('wait_scan_confirm', '等待扫码确认') : (qqLoginStatus.loggedIn ? loginText('login_reopen_sync_vip') : loginText('login_open_qq_window', '打开官方扫码窗口')))
      : (isKugou ? (kugouWebLoginBusy ? loginText('login_wait_confirm') : loginText('open_login_window', '打开官方登录窗口')) : (isQishui ? (qishuiOAuthBusy ? loginText('login_generating_qr') : loginText('login_scan_qishui')) : (neteaseWebLoginBusy ? loginText('wait_scan_confirm', '等待扫码确认') : loginText('open_login_window', '打开官方登录窗口'))));
  }
  if (st) {
    st.className = isManualCookieProvider ? 'preview' : '';
    st.textContent = isQQ
      ? qqLoginStatusText(qqLoginStatus)
      : (isKugou
        ? (kugouLoginStatus.loggedIn ? (loginText('login_kugou_session_saved_prefix') + (kugouLoginStatus.nickname || '')) : loginText('login_kugou_click_login_hint'))
        : (isQishui
          ? qishuiLoginStatusText()
        : (canOpenNeteaseWeb ? loginText('click_web_netease', '点击“网页登录”打开网易云官方窗口') : loginText('login_generating_qr', '正在生成二维码…'))));
  }
  if (refreshBtn) {
    refreshBtn.disabled = isQishui ? (qishuiBusy || !canUseQishuiQrLogin) : (isQQ ? !!qqWebLoginBusy : (isKugou ? !!kugouWebLoginBusy : !!neteaseWebLoginBusy));
    var qqNeedsAuthRefresh = isQQ && qqLoginStatus.loggedIn && (
      qqLoginStatus.authorizationIncomplete ||
      qqLoginStatus.playbackKeyReady === false
    );
    var qqNeedsMembershipSync = isQQ && typeof qqMembershipNeedsSync === 'function' && qqMembershipNeedsSync(qqLoginStatus);
    refreshBtn.textContent = isQishui ? (qishuiOAuthBusy ? loginText('login_generating') : loginText('refresh_qr', '刷新二维码')) : (isQQ ? (qqWebLoginBusy ? loginText('wait_scan', '等待扫码…') : (qqNeedsAuthRefresh ? loginText('login_reauthorize') : (qqNeedsMembershipSync ? loginText('login_sync_vip') : (qqLoginStatus.loggedIn ? loginText('login_refresh_status') : loginText('scan_qr_login', '扫码登录'))))) : (isKugou ? (kugouWebLoginBusy ? loginText('login_waiting') : loginText('login', '登录')) : (canOpenNeteaseWeb ? (neteaseWebLoginBusy ? loginText('wait_scan', '等待扫码…') : loginText('web_login', '网页登录')) : loginText('refresh_qr', '刷新二维码'))));
    refreshBtn.onclick = isQishui ? openQishuiWebLogin : (isQQ ? (qqNeedsAuthRefresh ? openQQWebLogin : (qqLoginStatus.loggedIn ? refreshQr : openQQWebLogin)) : (isKugou ? openKugouWebLogin : (canOpenNeteaseWeb ? openNeteaseWebLogin : refreshQr)));
  }
  updateLoginNodeGraphUi();
}
async function refreshQr() {
  stopQrPoll();
  updateLoginProviderUi();
  var refreshProvider = loginProvider;
  var refreshSeq = ++loginRefreshRequestSeq;
  if (loginProvider === 'spotify') {
    qrKey = null;
    var spotifyStatus = document.getElementById('qr-status');
    var spotifyImg = document.getElementById('qr-img');
    if (spotifyImg) spotifyImg.src = '';
    var spotifyInfo = await refreshSpotifyLoginStatus();
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    updateLoginProviderUi();
    if (spotifyStatus) {
      spotifyStatus.textContent = spotifyLoginStatusText(spotifyInfo);
      spotifyStatus.className = 'preview';
    }
    return;
  }
  if (loginProvider === 'qishui') {
    qrKey = null;
    var qishuiStatus = document.getElementById('qr-status');
    var qishuiImg = document.getElementById('qr-img');
    if (qishuiImg) qishuiImg.src = '';
    qishuiOAuthBusy = true;
    updateLoginProviderUi();
    try {
      var qishuiQr = await apiJson('/api/qishui/login/qrcode?t=' + Date.now());
      if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
      if (!qishuiQr || !qishuiQr.token || !qishuiQr.qrcode) {
        throw new Error(backendText(qishuiQr, null, loginText('login_qishui_qr_generate_failed')));
      }
      qrKey = qishuiQr.token;
      if (qishuiImg) {
        qishuiImg.src = qishuiQr.qrcode;
        qishuiImg.alt = loginText('login_qishui_qr_title');
      }
      if (qishuiStatus) {
        qishuiStatus.textContent = loginText('login_scan_douyin_confirm');
        qishuiStatus.className = '';
      }
      startQrPoll();
    } catch (e) {
      if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
      if (qishuiStatus) {
        qishuiStatus.textContent = loginText('error_prefix', '出错: ') + (e && e.message ? e.message : e);
        qishuiStatus.className = 'fail';
      }
    } finally {
      qishuiOAuthBusy = false;
      if (isLoginRefreshCurrent(refreshProvider, refreshSeq)) updateLoginProviderUi();
      if (qishuiStatus && qrKey && isLoginRefreshCurrent(refreshProvider, refreshSeq)) {
        qishuiStatus.textContent = loginText('login_scan_douyin_confirm');
        qishuiStatus.className = '';
      }
    }
    return;
  }
  if (loginProvider === 'qq') {
    qrKey = null;
    var qqStatus = document.getElementById('qr-status');
    var qqImg = document.getElementById('qr-img');
    if (qqImg) qqImg.src = '';
    var info = await refreshQQVipStatusNow('login-panel');
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    if (qqStatus) {
      qqStatus.textContent = qqLoginStatusText(info);
      qqStatus.className = 'preview';
    }
    return;
  }
  if (loginProvider === 'kugou') {
    qrKey = null;
    var kugouStatus = document.getElementById('qr-status');
    var kugouImg = document.getElementById('qr-img');
    if (kugouImg) kugouImg.src = '';
    var kugouInfo = await refreshKugouLoginStatus();
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    if (kugouStatus) {
      kugouStatus.textContent = kugouInfo && kugouInfo.loggedIn ? (loginText('login_kugou_session_saved_prefix') + (kugouInfo.nickname || '')) : loginText('login_kugou_click_login_hint');
      kugouStatus.className = 'preview';
    }
    return;
  }
  if (window.desktopWindow && typeof window.desktopWindow.openNeteaseMusicLogin === 'function') {
    qrKey = null;
    var neImg = document.getElementById('qr-img');
    var neStatus = document.getElementById('qr-status');
    if (neImg) neImg.src = '';
    if (neStatus) {
      neStatus.textContent = loginStatus.loggedIn ? (loginText('saved_netease_session', '已保存网易云会话') + ' · ' + (loginStatus.nickname || '')) : loginText('click_web_netease', '点击“网页登录”打开网易云官方窗口');
      neStatus.className = 'preview';
    }
    return;
  }
  try {
    var k = await apiJson('/api/login/qr/key');
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    if (!k.key) throw new Error(loginText('login_get_key_failed'));
    qrKey = k.key;
    var q = await apiJson('/api/login/qr/create?key=' + encodeURIComponent(qrKey));
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    if (!q.img) throw new Error(loginText('login_qr_generate_failed'));
    document.getElementById('qr-img').src = q.img;
    document.getElementById('qr-status').textContent = loginText('scan_netease_app', '请使用网易云音乐 App 扫码');
    startQrPoll();
  } catch (e) {
    if (!isLoginRefreshCurrent(refreshProvider, refreshSeq)) return;
    document.getElementById('qr-status').textContent = loginText('error_prefix', '出错: ') + e.message;
    document.getElementById('qr-status').className = 'fail';
  }
}
function startQrPoll() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    clearTimeout(qrPollTimer);
  }
  if (loginProvider === 'qishui') {
    var generation = qishuiQrPollGeneration;
    qrPollTimer = setTimeout(function () { pollQishuiQr(generation); }, 1200);
    return;
  }
  qrPollTimer = setInterval(checkQr, 2000);
}
function stopQrPoll() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    clearTimeout(qrPollTimer);
    qrPollTimer = null;
  }
  qishuiQrPollGeneration += 1;
  qishuiQrPollBusy = false;
}
function scheduleQishuiQrPoll(generation, delay) {
  if (generation !== qishuiQrPollGeneration || loginProvider !== 'qishui' || !qrKey) return;
  if (qrPollTimer) clearTimeout(qrPollTimer);
  qrPollTimer = setTimeout(function () { pollQishuiQr(generation); }, Math.max(1000, Number(delay) || 4500));
}
async function pollQishuiQr(generation) {
  if (generation !== qishuiQrPollGeneration || loginProvider !== 'qishui' || !qrKey || qishuiQrPollBusy) return;
  qishuiQrPollBusy = true;
  var statusEl = document.getElementById('qr-status');
  var nextDelay = 4500;
  try {
    var result = await apiJson('/api/qishui/login/check?token=' + encodeURIComponent(qrKey) + '&t=' + Date.now());
    if (generation !== qishuiQrPollGeneration || loginProvider !== 'qishui') return;
    if (result && result.loggedIn) {
      stopQrPoll();
      qishuiLoginStatus = normalizeQishuiLoginStatus(result);
      activeAccountProvider = 'qishui';
      markLoginWorkflowConnected('qishui');
      renderUserBtn();
      if (statusEl) {
        statusEl.textContent = loginText('login_success', '登录成功！');
        statusEl.className = 'scan';
      }
      await refreshUserPlaylists(true);
      loadHomeDiscover(true);
      setTimeout(function () {
        closeLoginModal();
        showToast(loginText('login_qishui_logged_in_prefix') + (qishuiLoginStatus.nickname || qishuiLoginStatus.userId || ''));
      }, 450);
      return;
    }
    var code = Number(result && (result.errorCode || result.error_code) || 0);
    var qrStatus = String(result && result.status || 'waiting');
    if (code === 2 || qrStatus === 'expired' || qrStatus === 'reauth_required' || result && result.reauthRequired) {
      stopQrPoll();
      if (statusEl) {
        statusEl.textContent = result && result.reauthRequired ? loginText('login_status_expired_rescan') : loginText('login_qr_expired_refresh_2');
        statusEl.className = 'fail';
      }
      return;
    }
    if (qrStatus === 'verifying') {
      nextDelay = 8000;
      if (statusEl) {
        statusEl.textContent = loginText('login_scan_confirmed_reverify');
        statusEl.className = 'preview';
      }
    } else if (code === 7 || qrStatus === 'rate_limited') {
      nextDelay = Number(result && result.retryAfterMs) || 60000;
      if (statusEl) {
        statusEl.textContent = loginText('login_rate_limited');
        statusEl.className = 'preview';
      }
    } else if (qrStatus === 'mfa_cancelled') {
      stopQrPoll();
      if (statusEl) {
        statusEl.textContent = loginText('login_2fa_cancelled');
        statusEl.className = 'fail';
      }
      return;
    } else if (statusEl) {
      statusEl.textContent = qrStatus === 'scanned' || qrStatus === '2'
        ? loginText('login_scanned_confirm_phone_2')
        : loginText('login_wait_scan_confirm');
      statusEl.className = qrStatus === 'scanned' || qrStatus === '2' ? 'scan' : '';
    }
  } catch (e) {
    nextDelay = 8000;
    console.warn('Qishui QR check failed:', e);
    if (statusEl) {
      statusEl.textContent = loginText('login_status_check_retry');
      statusEl.className = 'fail';
    }
  } finally {
    qishuiQrPollBusy = false;
    scheduleQishuiQrPoll(generation, nextDelay);
  }
}
function toggleQQCookiePanel() {
  if (loginProvider === 'spotify') return;
  setManualCookieOpenForProvider(loginProvider, !isManualCookieOpenForProvider(loginProvider));
  updateLoginProviderUi();
}
function openProviderWebLogin() {
  if (loginProvider === 'qq') return openQQWebLogin();
  if (loginProvider === 'kugou') return openKugouWebLogin();
  if (loginProvider === 'qishui') return openQishuiWebLogin();
  if (loginProvider === 'spotify') return openSpotifyWebLogin();
  return openNeteaseWebLogin();
}
async function openSpotifyWebLogin() {
  if (spotifyOAuthBusy) return;
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.openSpotifyMusicLogin !== 'function') {
    setSpotifySetupOverall(loginText('login_spotify_no_bridge'), 'fail');
    return;
  }
  if (!spotifyLoginStatus.oauthConfigured && !spotifyLoginStatus.tokenConfigured) {
    var latestStatus = await refreshSpotifyLoginStatus();
    if (!latestStatus.oauthConfigured && !latestStatus.tokenConfigured) {
      updateLoginProviderUi();
      setSpotifySetupOverall(loginText('login_spotify_step1_first'), 'fail');
      return;
    }
  }
  if (!spotifySetupCallbackReady) {
    var callbackReady = await verifySpotifySetupCallback(false);
    if (!callbackReady) return;
  }
  spotifyOAuthBusy = true;
  updateLoginProviderUi();
  setSpotifySetupOverall(loginText('login_spotify_browser_opened'));
  var failText = '';
  try {
    var result = await api.openSpotifyMusicLogin();
    if (!result || !result.ok) {
      if (result && result.error === 'SPOTIFY_OAUTH_NOT_CONFIGURED') {
        throw new Error(backendText(result, 'backend_spotify_client_id_required', loginText('login_spotify_client_id_required')) + (result.redirectUri ? (loginText('login_callback_uri_infix') + result.redirectUri) : ''));
      }
      throw new Error(backendText(result, null, loginText('login_spotify_auth_incomplete')));
    }
    setSpotifySetupOverall(loginText('login_spotify_verifying'));
    var info = await refreshSpotifyLoginStatus();
    if (!info || !info.loggedIn) throw new Error(backendText(info, null, loginText('login_spotify_session_unavailable')));
    activeAccountProvider = 'spotify';
    markLoginWorkflowConnected('spotify');
    renderUserBtn();
    await refreshUserPlaylists(true);
    loadHomeDiscover(true);
    spotifyOAuthBusy = false;
    updateLoginProviderUi();
    await runSpotifySetupDiagnostics(true);
    showToast(loginText('login_spotify_connected_prefix') + (info.nickname || info.userId || ''));
    // 提醒：未开启本机 Spotify 客户端时，因无返回的可播放直链，将自动换源到同首歌的其他可用源。
    // Reminder: without the local Spotify client open, playback auto-switches to another
    // available source of the same track because no playable direct link is returned.
    if (!spotifyLoginReminderShown) {
      spotifyLoginReminderShown = true;
      setTimeout(function () { showToast(loginText('spotify_login_reminder')); }, 2400);
    }
  } catch (e) {
    failText = e && e.message ? e.message : loginText('login_spotify_auth_failed');
    setSpotifySetupOverall(failText, 'fail');
  } finally {
    spotifyOAuthBusy = false;
    updateLoginProviderUi();
    if (failText) setSpotifySetupOverall(failText, 'fail');
  }
}
async function submitSpotifyConfigLogin() {
  return saveSpotifySetupClientId();
}
async function openNeteaseWebLogin() {
  if (neteaseWebLoginBusy) return;
  var statusEl = document.getElementById('qr-status');
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.openNeteaseMusicLogin !== 'function') {
    if (statusEl) { statusEl.textContent = loginText('web_login_unsupported', '当前环境不支持官方网页登录，正在尝试旧二维码…'); statusEl.className = 'fail'; }
    return refreshQr();
  }

  neteaseWebLoginBusy = true;
  updateLoginProviderUi();
  if (statusEl) { statusEl.textContent = loginText('opened_netease_window', '已打开网易云窗口，请在官方页面扫码登录…'); statusEl.className = 'preview'; }
  try {
    var result = await api.openNeteaseMusicLogin();
    if (!result || !result.ok || !result.cookie) {
      throw new Error(backendText(result, null, loginText('netease_login_incomplete', '网易云登录未完成')));
    }
    if (statusEl) { statusEl.textContent = loginText('syncing_netease', '正在同步网易云会话…'); statusEl.className = 'preview'; }
    var info = await apiJson('/api/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: result.cookie })
    });
    if (!info || !info.loggedIn) throw new Error(backendText(info, null, loginText('login_netease_session_unavailable')));
    loginStatus = info;
    activeAccountProvider = 'netease';
    renderUserBtn();
    refreshUserPlaylists(true);
    loadHomeDiscover(true);
    if (statusEl) { statusEl.textContent = loginText('netease_saved', '网易云会话已保存'); statusEl.className = 'scan'; }
    offerLoginCookieExport('netease', info);
    setTimeout(function () {
      closeLoginModal();
      showToast(loginText('netease_loggedin', '网易云已登录: ') + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    neteaseWebLoginBusy = false;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : loginText('login_netease_failed'); statusEl.className = 'fail'; }
  } finally {
    if (neteaseWebLoginBusy) {
      neteaseWebLoginBusy = false;
      updateLoginProviderUi();
    }
  }
}
async function openQQWebLogin() {
  if (qqWebLoginBusy) return;
  var statusEl = document.getElementById('qr-status');
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.openQQMusicLogin !== 'function') {
    qqManualCookieOpen = true;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = loginText('auto_web_login_unsupported', '当前环境不支持自动网页登录，可先使用手动导入。'); statusEl.className = 'fail'; }
    return;
  }

  qqWebLoginBusy = true;
  updateLoginProviderUi();
  if (statusEl) { statusEl.textContent = loginText('qq_window_opened_scan', '已打开 QQ 音乐窗口，请扫码并确认登录…'); statusEl.className = 'preview'; }
  try {
    var result = await api.openQQMusicLogin({
      forceReauth: !!(qqLoginStatus && qqLoginStatus.authorizationIncomplete && qqLoginStatus.playbackKeyReady === false)
    });
    if (!result || !result.ok || !result.cookie) {
      throw new Error(backendText(result, null, loginText('qq_login_incomplete', 'QQ 登录未完成')));
    }
    if (statusEl) { statusEl.textContent = loginText('login_syncing_qq_session'); statusEl.className = 'preview'; }
    var info = await apiJson('/api/qq/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: result.cookie })
    });
    if (!info || !info.loggedIn) throw new Error(backendText(info, null, loginText('login_qq_session_unavailable')));
    qqLoginStatus = normalizeQQLoginStatus(info);
    auditProviderVipState('qq', qqLoginStatus);
    activeAccountProvider = 'qq';
    qqManualCookieOpen = false;
    renderUserBtn();
    refreshUserPlaylists(true);
    offerLoginCookieExport('qq', info);
    var qqPlaybackReady = !!info.playbackKeyReady && !result.partial;
    if (!qqPlaybackReady) {
      if (statusEl) { statusEl.textContent = loginText('login_qq_synced_auth_incomplete_detail'); statusEl.className = 'preview'; }
      showToast(loginText('login_qq_synced_auth_incomplete'));
      return;
    }
    if (statusEl) { statusEl.textContent = qqPlaybackReady ? qqLoginStatusText(qqLoginStatus) : loginText('login_qq_synced_partial'); statusEl.className = 'scan'; }
    setTimeout(function () {
      closeLoginModal();
      showToast((qqPlaybackReady ? loginText('qq_loggedin', 'QQ 音乐已登录: ') : loginText('qq_synced', 'QQ 账号已同步: ')) + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    qqWebLoginBusy = false;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : loginText('qq_login_failed', 'QQ 登录失败'); statusEl.className = 'fail'; }
  } finally {
    if (qqWebLoginBusy) {
      qqWebLoginBusy = false;
      updateLoginProviderUi();
    }
  }
}
async function openKugouWebLogin() {
  if (kugouWebLoginBusy) return;
  var statusEl = document.getElementById('qr-status');
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.openKugouMusicLogin !== 'function') {
    kugouManualCookieOpen = true;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = loginText('auto_web_login_unsupported', '当前环境不支持自动网页登录，可先使用手动导入。'); statusEl.className = 'fail'; }
    return;
  }

  kugouWebLoginBusy = true;
  updateLoginProviderUi();
  if (statusEl) { statusEl.textContent = loginText('login_kugou_window_opened'); statusEl.className = 'preview'; }
  try {
    var result = await api.openKugouMusicLogin({ forceReauth: true });
    if (!result || !result.ok || !result.cookie) {
      throw new Error(backendText(result, null, loginText('login_kugou_incomplete')));
    }
    if (statusEl) { statusEl.textContent = loginText('login_syncing_kugou_session'); statusEl.className = 'preview'; }
    var info = await apiJson('/api/kugou/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: result.cookie })
    });
    if (!info || !info.loggedIn) throw new Error(backendText(info, null, loginText('login_kugou_session_unavailable')));
    kugouLoginStatus = normalizeKugouLoginStatus(info);
    activeAccountProvider = 'kugou';
    kugouManualCookieOpen = false;
    renderUserBtn();
    refreshUserPlaylists(true);
    offerLoginCookieExport('kugou', info);
    var ready = !!info.playbackKeyReady && !result.partial;
    if (statusEl) { statusEl.textContent = ready ? loginText('login_kugou_session_saved') : loginText('login_kugou_synced_partial'); statusEl.className = 'scan'; }
    setTimeout(function () {
      closeLoginModal();
      showToast((ready ? loginText('login_kugou_logged_in_prefix') : loginText('login_kugou_synced_prefix')) + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    kugouWebLoginBusy = false;
    updateLoginProviderUi();
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : loginText('login_kugou_failed'); statusEl.className = 'fail'; }
  } finally {
    if (kugouWebLoginBusy) {
      kugouWebLoginBusy = false;
      updateLoginProviderUi();
    }
  }
}
async function openQishuiWebLogin() {
  if (qishuiTokenBusy || qishuiOAuthBusy) return;
  return refreshQr();
}
async function submitQQCookieLogin() {
  if (loginProvider === 'spotify') return submitSpotifyConfigLogin();
  if (loginProvider === 'qishui') return openQishuiWebLogin();
  if (loginProvider === 'netease') return submitNeteaseCookieLogin();
  var isKugou = loginProvider === 'kugou';
  if (isKugou ? kugouCookieBusy : qqCookieBusy) return;
  var input = document.getElementById('qq-cookie-input');
  var statusEl = document.getElementById('qr-status');
  var saveBtn = document.getElementById('qq-cookie-save-btn');
  var cookie = input ? input.value.trim() : '';
  if (!cookie) {
    if (statusEl) { statusEl.textContent = isKugou ? loginText('login_paste_kugou_cookie') : loginText('login_paste_qq_cookie'); statusEl.className = 'fail'; }
    return;
  }
  if (isKugou) kugouCookieBusy = true;
  else qqCookieBusy = true;
  if (saveBtn) saveBtn.classList.add('busy');
  if (statusEl) { statusEl.textContent = isKugou ? loginText('login_saving_kugou_session') : loginText('login_saving_qq_session'); statusEl.className = 'preview'; }
  try {
    var info = await apiJson(isKugou ? '/api/kugou/login/cookie' : '/api/qq/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookie })
    });
    if (!info || !info.loggedIn) throw new Error(backendText(info, null, isKugou ? loginText('login_kugou_session_unavailable') : loginText('login_qq_session_unavailable')));
    if (isKugou) kugouLoginStatus = normalizeKugouLoginStatus(info);
    else {
      qqLoginStatus = normalizeQQLoginStatus(info);
      auditProviderVipState('qq', qqLoginStatus);
    }
    activeAccountProvider = isKugou ? 'kugou' : 'qq';
    if (input) input.value = '';
    renderUserBtn();
    refreshUserPlaylists(true);
    var manualPlaybackReady = !!info.playbackKeyReady;
    if (statusEl) { statusEl.textContent = manualPlaybackReady ? (isKugou ? loginText('login_kugou_session_saved') : qqLoginStatusText(qqLoginStatus)) : (isKugou ? loginText('login_kugou_synced_partial') : loginText('login_qq_synced_partial')); statusEl.className = 'scan'; }
    setManualCookieOpenForProvider(activeAccountProvider, false);
    offerLoginCookieExport(activeAccountProvider, info);
    setTimeout(function () {
      closeLoginModal();
      showToast((manualPlaybackReady ? (isKugou ? loginText('login_kugou_logged_in_prefix') : loginText('qq_loggedin', 'QQ 音乐已登录: ')) : (isKugou ? loginText('login_kugou_synced_prefix') : loginText('qq_synced', 'QQ 账号已同步: '))) + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : (isKugou ? loginText('login_kugou_session_save_failed') : loginText('login_qq_session_save_failed')); statusEl.className = 'fail'; }
  } finally {
    if (isKugou) kugouCookieBusy = false;
    else qqCookieBusy = false;
    if (saveBtn) saveBtn.classList.remove('busy');
  }
}

async function submitNeteaseCookieLogin() {
  if (qqCookieBusy) return;
  var input = document.getElementById('qq-cookie-input');
  var statusEl = document.getElementById('qr-status');
  var saveBtn = document.getElementById('qq-cookie-save-btn');
  var cookie = input ? input.value.trim() : '';
  if (!cookie) {
    if (statusEl) { statusEl.textContent = loginText('login_paste_netease_cookie'); statusEl.className = 'fail'; }
    return;
  }
  qqCookieBusy = true;
  if (saveBtn) saveBtn.classList.add('busy');
  if (statusEl) { statusEl.textContent = loginText('login_saving_netease_session'); statusEl.className = 'preview'; }
  try {
    var info = await apiJson('/api/login/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookie })
    });
    if (!info || !info.loggedIn) throw new Error(backendText(info, null, loginText('login_netease_session_unavailable')));
    loginStatus = info;
    activeAccountProvider = 'netease';
    neteaseManualCookieOpen = false;
    if (input) input.value = '';
    renderUserBtn();
    refreshUserPlaylists(true);
    loadHomeDiscover(true);
    if (statusEl) { statusEl.textContent = loginText('netease_saved', '网易云会话已保存'); statusEl.className = 'scan'; }
    offerLoginCookieExport('netease', info);
    setTimeout(function () {
      closeLoginModal();
      showToast(loginText('netease_loggedin', '网易云已登录: ') + (info.nickname || info.userId || ''));
    }, 420);
  } catch (e) {
    if (statusEl) { statusEl.textContent = e && e.message ? e.message : loginText('login_netease_session_save_failed'); statusEl.className = 'fail'; }
  } finally {
    qqCookieBusy = false;
    if (saveBtn) saveBtn.classList.remove('busy');
    updateLoginProviderUi();
  }
}
async function checkQr() {
  if (!qrKey) return;
  try {
    var r = await apiJson('/api/login/qr/check?key=' + encodeURIComponent(qrKey));
    var $st = document.getElementById('qr-status');
    if (r.code === 800) { $st.textContent = loginText('login_qr_expired_refresh'); $st.className = 'fail'; stopQrPoll(); }
    else if (r.code === 801) { $st.textContent = loginText('login_scan_in_app'); $st.className = ''; }
    else if (r.code === 802) { $st.textContent = loginText('login_scanned_confirm_phone'); $st.className = 'scan'; }
    else if (r.code === 803 && (r.loggedIn || r.hasCookie)) {
      $st.textContent = r.pendingProfile ? loginText('login_success_syncing', '登录成功，正在同步账号资料…') : loginText('login_success', '登录成功！'); $st.className = 'scan';
      stopQrPoll();
      loginStatus = r.loggedIn ? r : Object.assign({}, r, { loggedIn: true, pendingProfile: true, nickname: r.nickname || loginText('login_netease_user') });
      activeAccountProvider = 'netease';
      renderUserBtn();
      setTimeout(async function () {
        var fresh = await refreshLoginStatus(true);
        if (!fresh || !fresh.loggedIn) {
          loginStatus = Object.assign({}, loginStatus, { loggedIn: true, pendingProfile: true });
          renderUserBtn();
          fresh = loginStatus;
        }
        closeLoginModal();
        offerLoginCookieExport('netease', fresh);
        showToast(loginText('login_welcome_prefix') + (fresh && fresh.nickname ? fresh.nickname : ''));
      }, r.pendingProfile ? 1200 : 500);
    } else if (r.code === 803) {
      $st.textContent = loginText('login_qr_confirmed_no_credential', '扫码已确认，但没有拿到登录凭证，请刷新二维码重试'); $st.className = 'fail';
      stopQrPoll();
    }
  } catch (e) { console.warn(e); }
}

// 登录弹窗是常驻浮层：语言切换后必须重绘，否则标题、说明和按钮会停在旧语言。
// 只在弹窗可见时重绘，避免在用户没打开弹窗时白跑一遍渲染。
// The login modal is a persistent overlay, so it has to re-render on a language
// switch. Guarded by visibility so a hidden modal never triggers a wasted render.
(function bindLoginModalLanguage() {
  // 模块会被测试沙箱单独求值，那时没有 window，这类加载期 IIFE 必须先拦掉，
  // 否则会在求值阶段抛 ReferenceError，把整个测试文件带崩。
  // This module is evaluated standalone in a bare test sandbox with no window;
  // a load-time IIFE has to bail out first or evaluation throws.
  if (typeof window === 'undefined' || !window.MineradioI18n) return;
  var i18n = window.MineradioI18n;
  if (!i18n || typeof i18n.onLanguageChange !== 'function') return;
  i18n.onLanguageChange(function () {
    var modal = document.getElementById('login-modal');
    if (modal && modal.classList && modal.classList.contains('show')) updateLoginProviderUi();
  });
})();
