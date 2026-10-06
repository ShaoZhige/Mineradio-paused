var firstPlayDone = false;

function playbackProviderLabel(song) {
  var provider = songProviderKey(song);
  if (provider === 'qq') return playbackI18nText('login_qq', 'QQ 音乐');
  if (provider === 'kugou') return playbackI18nText('provider_kugou');
  if (provider === 'qishui') return playbackI18nText('provider_qishui');
  if (provider === 'spotify') return 'Spotify';
  return playbackI18nText('login_netease', '网易云');
}
function playbackLoginProvider(song) {
  return normalizePlaybackProvider(songProviderKey(song));
}
function playbackRestrictionRawCategory(song, data) {
  data = data || {};
  var restriction = data.restriction || {};
  return data.reason || data.category || data.errorCategory || restriction.category || restriction.reason || '';
}
function playbackRestrictionLooksVipLocked(song, data) {
  data = data || {};
  var restriction = data.restriction || {};
  if (typeof songRequiresVip === 'function' && songRequiresVip(Object.assign({}, song || {}, data || {}))) return true;
  if (data.trial || data.needVip || data.need_vip || data.vipRequired || data.onlyVipPlayable || data.only_vip_playable) return true;
  var text = [
    data.error,
    data.message,
    data.reason,
    data.category,
    restriction.category,
    restriction.reason,
    restriction.message,
    data.rawMessage,
    restriction.rawMessage
  ].map(function (value) { return String(value || '').toLowerCase(); }).join(' ');
  return /vip_required|paid_required|trial_only|need_vip|only_vip|member|vip|会员|付费|购买|数字专辑|专辑/.test(text);
}
function playbackRestrictionMissingPlaybackKey(data) {
  data = data || {};
  var restriction = data.restriction || {};
  return !!(data.missingPlaybackKey || restriction.missingPlaybackKey);
}
function playbackRestrictionCategory(song, data) {
  var category = playbackRestrictionRawCategory(song, data);
  var provider = playbackLoginProvider(song);
  var status = platformStatus(provider) || {};
  var mergedStatus = Object.assign({}, status, data || {}, data && data.restriction || {});
  var loggedIn = !!(status.loggedIn || data && data.loggedIn);
  var vipLevel = typeof providerVipLevel === 'function' ? providerVipLevel(provider, mergedStatus) : 'none';
  var membershipUnknown = !!(
    provider === 'qq'
    && loggedIn
    && (
      status.membershipKnown === false
      || status.membershipStale
      || status.authorizationIncomplete
      || status.vipSyncState === 'unknown'
    )
  );
  var vipLocked = playbackRestrictionLooksVipLocked(song, data);
  if (vipLocked && !playbackRestrictionMissingPlaybackKey(data)) {
    if (category === 'login_required' && loggedIn && vipLevel === 'none' && !membershipUnknown) return 'vip_required';
    if (!category || category === 'url_unavailable' || category === 'copyright_unavailable') {
      if (loggedIn && vipLevel === 'none' && !membershipUnknown) return 'vip_required';
    }
  }
  if (!category && data && data.error && /401|403|login_required|auth|cookie|credential|unauthorized|forbidden/i.test(String(data.error))) return loggedIn && vipLocked ? 'vip_required' : 'login_required';
  if (!category && data && data.error && /vip|member|paid|trial|会员|付费|购买/i.test(String(data.error))) return loggedIn ? 'vip_required' : 'login_required';
  return category || 'url_unavailable';
}
function playbackProviderMembershipText(provider, data) {
  var status = platformStatus(provider) || {};
  var mergedStatus = Object.assign({}, status, data || {}, data && data.restriction || {});
  var level = typeof providerVipLevel === 'function' ? providerVipLevel(provider, mergedStatus) : 'none';
  if (level === 'svip') return 'SVIP';
  if (level === 'vip') return provider === 'spotify' ? 'Premium' : 'VIP';
  if (
    provider === 'qq'
    && status.loggedIn
    && (
      status.membershipKnown === false
      || status.membershipStale
      || status.authorizationIncomplete
      || status.vipSyncState === 'unknown'
    )
  ) return playbackI18nText('pf_vip_pending');
  return playbackI18nText('pf_normal_account');
}
function playbackRestrictionNotice(song, data) {
  data = data || {};
  var restriction = data.restriction || {};
  var category = playbackRestrictionCategory(song, data);
  var provider = playbackProviderLabel(song);
  var providerKey = playbackLoginProvider(song);
  var status = platformStatus(providerKey) || {};
  var loggedIn = !!(status.loggedIn || data.loggedIn);
  var membershipPending = !!(
    providerKey === 'qq'
    && loggedIn
    && (
      status.membershipKnown === false
      || status.membershipStale
      || status.authorizationIncomplete
      || status.vipSyncState === 'unknown'
    )
  );
  var membership = playbackProviderMembershipText(providerKey, data);
  var message = data.message || restriction.message || '';
  // 自定义音源返回的失败不带平台权益语义，必须和会员/登录分支分开判断，
  // 否则一次脚本超时会被解释成「你需要会员」。
  // A custom-source failure carries no platform entitlement semantics and must be told
  // apart from the membership/login branches, otherwise a script timeout would be
  // explained as "you need VIP".
  if (data.active === true) {
    return {
      category: 'custom_source_unavailable',
      title: playbackI18nText('custom_source_unavailable_title', '自定义音源没有返回可播放地址'),
      body: message || playbackI18nText('custom_source_unavailable_body', '当前启用的音源脚本没有为这首歌提供可用地址。可以切换到其它已登录平台的版本，或在自定义音源设置里停用它。'),
      action: 'switch_source',
      toast: playbackI18nText('custom_source_unavailable_toast', '自定义音源不可用')
    };
  }
  if (category === 'vip_required' || category === 'paid_required' || category === 'trial_only') {
    var needText = category === 'paid_required' ? playbackI18nText('pf_purchase_or_higher') : (category === 'trial_only' ? playbackI18nText('pf_full_playback') : playbackI18nText('pf_vip_permission'));
    var title = membershipPending ? playbackI18nText('pf_qq_vip_pending') : (loggedIn ? playbackI18nText('pf_platform_no_vip_status') : playbackI18nText('pf_platform_no_vip'));
    var body = message || (provider + playbackI18nText('pf_paid_track_status_prefix') + membership + playbackI18nText('pf_missing_comma') + needText + '。');
    if (loggedIn && body.indexOf(playbackI18nText('pf_current_status')) < 0) body += playbackI18nText('pf_status_is_infix') + membership + '。';
    return { category: category, title: title, body: body + playbackI18nText('pf_vip_or_switch_suffix'), action: 'upgrade', toast: title };
  }
  if (category === 'login_required') {
    if (loggedIn && playbackRestrictionMissingPlaybackKey(data)) {
      return {
        category: category,
        title: playbackI18nText('pf_platform_auth_incomplete'),
        body: message || (provider + playbackI18nText('pf_auth_incomplete_detail')),
        action: 'login',
        toast: playbackI18nText('pf_auth_incomplete')
      };
    }
    return {
      category: category,
      title: playbackI18nText('pf_platform_not_logged_in'),
      body: (message || (provider + playbackI18nText('pf_need_login_suffix'))) + playbackI18nText('pf_opening_login_suffix'),
      action: 'login',
      toast: playbackI18nText('pf_platform_not_logged_in')
    };
  }
  if (category === 'provider_limited') {
    return {
      category: category,
      title: playbackI18nText('pf_platform_match_only'),
      body: message || (provider + playbackI18nText('pf_search_only_suffix')),
      action: 'switch_source',
      toast: playbackI18nText('pf_auto_switching')
    };
  }
  if (category === 'copyright_unavailable') {
    return {
      category: category,
      title: playbackI18nText('pf_platform_copyright'),
      body: (message || (provider + playbackI18nText('pf_copyright_temp_suffix'))) + playbackI18nText('pf_switch_platform_suffix'),
      action: 'switch_source',
      toast: playbackI18nText('pf_copyright_unplayable')
    };
  }
  return {
    category: category,
    title: playbackI18nText('pf_no_source_on_platform'),
    body: (message || (provider + playbackI18nText('pf_no_url_suffix'))) + playbackI18nText('pf_generic_restriction_suffix'),
    action: 'switch_source',
    toast: playbackI18nText('pf_no_source_on_platform')
  };
}
function playbackRestrictionMessage(song, data) {
  var notice = playbackRestrictionNotice(song, data);
  return notice.body || notice.title;
  data = data || {};
  var restriction = data.restriction || {};
  var category = data.reason || restriction.category || '';
  var provider = playbackProviderLabel(song);
  var message = data.message || restriction.message || '';
  if (!message) {
    if (category === 'login_required') message = playbackI18nText('provider_need_login', '{provider}需要登录后再尝试播放', { provider: provider });
    else if (category === 'vip_required') message = provider + playbackI18nText('pf_requires_vip');
    else if (category === 'paid_required') message = provider + playbackI18nText('pf_requires_purchase');
    else if (category === 'trial_only') message = provider + playbackI18nText('pf_preview_only_returned');
    else if (category === 'copyright_unavailable') message = provider + playbackI18nText('pf_copyright_temp');
    else if (category === 'provider_limited') message = provider + playbackI18nText('pf_match_source_only');
    else message = provider + playbackI18nText('pf_no_playable_url');
  }
  if (category === 'login_required') return message + ' · ' + playbackI18nText('opening_login', '正在打开登录');
  if (category === 'provider_limited') return message + playbackI18nText('pf_can_auto_switch');
  if (category === 'copyright_unavailable' || category === 'url_unavailable') return message + playbackI18nText('pf_try_other_version');
  return message;
}

// ============================================================
// 汽水音乐签名授权 / SodaMusic signature authorization
//
// 会员曲在免签名的回退通路上只能拿到服务端裁剪的试听片段。若本机已装官方客户端但尚未授权，
// 就把「打开客户端授权」的入口挂到试听横幅上；文案由词典负责，后端只提供机器可读的 reason。
// ============================================================
var qishuiSignatureAuthorizePending = false;
var QISHUI_VIP_HINT_KEYS = {
  client_missing: 'qishui_vip_client_missing',
  client_not_authorized: 'qishui_vip_client_unauthorized',
  signature_unavailable: 'qishui_vip_signature_unavailable',
  entitlement_limited: 'qishui_vip_entitlement_limited'
};
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
function playbackI18nText(key, fallback, params) {
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
function qishuiVipClientHintText(hint) {
  hint = hint || {};
  var fallback = hint.message || playbackI18nText('pf_vip_preview_only');
  var key = QISHUI_VIP_HINT_KEYS[hint.reason];
  return key ? playbackI18nText(key, fallback) : fallback;
}
function qishuiAuthorizeFailureText(result) {
  var reason = String(result && result.reason || '');
  if (reason === 'client_not_found' || reason === 'client_not_authorized') {
    return playbackI18nText('qishui_authorize_fail_client_missing', '本机仍未检测到官方汽水音乐客户端，请先安装并登录官方客户端。');
  }
  if (reason === 'native_module_missing' || reason === 'binding_unsupported' || reason === 'authorization_not_persisted') {
    return playbackI18nText('qishui_authorize_fail_module', '官方客户端中未找到可用的签名模块，请先更新到较新版本的官方客户端。');
  }
  if (reason === 'native_load_failed' || reason === 'native_init_failed') {
    return playbackI18nText('qishui_authorize_fail_load', '签名模块加载失败，请确认官方客户端可以正常启动后重试。');
  }
  if (reason === 'signature_self_test_failed' || reason === 'empty_signature' || reason === 'sign_failed') {
    return playbackI18nText('qishui_authorize_fail_selftest', '签名自检失败，请确认已在官方客户端中登录与 Mineradio 相同的账号后重试。');
  }
  return backendText(result, 'qishui_authorize_fail_generic', playbackI18nText('qishui_authorize_fail_generic', '授权未完成，请稍后重试。'));
}
function bindQishuiSignatureAuthorizeButton(hint) {
  var btn = document.getElementById('trial-client-btn');
  if (!btn) return;
  // 只在「已装客户端但还没授权」时给出按钮：其它情况给按钮只会让人白点一次。
  if (!(hint && hint.required && hint.canAuthorize && !hint.authorized)) {
    btn.style.display = 'none';
    btn.classList.remove('busy');
    btn.onclick = null;
    return;
  }
  btn.style.display = '';
  btn.classList.remove('busy');
  btn.textContent = playbackI18nText('qishui_authorize_btn', '打开客户端授权');
  btn.onclick = async function () {
    if (qishuiSignatureAuthorizePending) return;
    qishuiSignatureAuthorizePending = true;
    btn.classList.add('busy');
    btn.textContent = playbackI18nText('qishui_authorize_btn_busy', '正在打开客户端…');
    try {
      var result = await apiJson('/api/qishui/signature/authorize', { method: 'POST', timeoutMs: 20000 });
      if (result && result.ok) {
        showSourceFallbackNotice(
          playbackI18nText('qishui_authorize_done_title', '汽水音乐授权已完成'),
          playbackI18nText('qishui_authorize_done_body', '已在本机绑定签名能力，重新播放这首歌即可尝试完整播放。')
        );
        btn.style.display = 'none';
        btn.onclick = null;
      } else {
        showSourceFallbackNotice(
          playbackI18nText('qishui_authorize_failed_title', '汽水音乐授权未完成'),
          qishuiAuthorizeFailureText(result)
        );
        btn.classList.remove('busy');
        btn.textContent = playbackI18nText('qishui_authorize_btn_retry', '重试授权');
      }
    } catch (error) {
      showSourceFallbackNotice(
        playbackI18nText('qishui_authorize_failed_title', '汽水音乐授权未完成'),
        error && error.message || playbackI18nText('qishui_authorize_fail_generic', '授权未完成，请稍后重试。')
      );
      btn.classList.remove('busy');
      btn.textContent = playbackI18nText('qishui_authorize_btn_retry', '重试授权');
    } finally {
      qishuiSignatureAuthorizePending = false;
    }
  };
}
function qqPlaybackRetryQualities(requestedQuality, resolvedLevel) {
  requestedQuality = normalizePlaybackQualityForProvider(requestedQuality || getProviderPlaybackQuality('qq'), 'qq');
  resolvedLevel = String(resolvedLevel || '').toLowerCase();
  var pool = [];
  if (requestedQuality === 'jymaster' || requestedQuality === 'hires' || requestedQuality === 'lossless' || resolvedLevel === 'hires' || resolvedLevel === 'lossless') {
    pool = ['exhigh', 'standard'];
  } else if (requestedQuality === 'exhigh' || resolvedLevel === 'exhigh') {
    pool = ['standard'];
  }
  return pool.filter(function (q) { return q !== requestedQuality; });
}
async function retryQQPlaybackWithCompatibleQuality(song, idx, token, opts, data, requestedQuality) {
  opts = opts || {};
  if (playbackRestrictionCategory(song, data) === 'login_required' || playbackRestrictionMissingPlaybackKey(data)) return false;
  var tried = Array.isArray(opts.qqQualityTried) ? opts.qqQualityTried.slice() : [];
  [requestedQuality, data && data.level].forEach(function (q) {
    q = normalizePlaybackQuality(q || '');
    if (q && tried.indexOf(q) < 0) tried.push(q);
  });
  var candidates = qqPlaybackRetryQualities(requestedQuality, data && data.level).filter(function (q) { return tried.indexOf(q) < 0; });
  if (!candidates.length || token !== trackSwitchToken) return false;
  var nextQuality = candidates[0];
  var resolvedQuality = normalizePlaybackQuality(data && data.level);
  markPlaybackQualityRuntimeCap(song, 'qq', nextQuality, 'qq-url-unavailable');
  if (!opts.startupAutoplay) showSourceFallbackNotice(playbackI18nText('pf_qq_quality_compat'), playbackI18nText('pf_quality_fail_switch_prefix') + playbackQualityLabel(nextQuality, 'qq') + '。');
  var retryResumeAt = opts.resumeAt;
  if (retryResumeAt == null && opts.startupAutoplay && pendingPlaybackResumeAt > 0) retryResumeAt = pendingPlaybackResumeAt;
  var retryStarted = await playQueueAt(idx, Object.assign({}, opts, {
    qualityOverride: nextQuality,
    qqQualityTried: tried,
    resumeAt: retryResumeAt,
  }));
  return retryStarted === true;
}
var sourceFallbackNoticeTimer = null;
function closeSourceFallbackNotice() {
  var notice = document.getElementById('source-fallback-notice');
  if (sourceFallbackNoticeTimer) { clearTimeout(sourceFallbackNoticeTimer); sourceFallbackNoticeTimer = null; }
  if (notice) notice.classList.remove('show');
  var stack = document.getElementById('source-fallback-stack');
  if (stack) Array.prototype.slice.call(stack.children || []).forEach(removeSourceFallbackCard);
}
function ensureSourceFallbackStack() {
  var stack = document.getElementById('source-fallback-stack');
  if (stack) return stack;
  stack = document.createElement('div');
  stack.id = 'source-fallback-stack';
  stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);
  return stack;
}
function removeSourceFallbackCard(card) {
  if (!card) return;
  card.classList.add('leaving');
  setTimeout(function () {
    if (card.parentNode) card.parentNode.removeChild(card);
  }, 260);
}
function showSourceFallbackNotice(title, body) {
  var stack = ensureSourceFallbackStack();
  if (stack) {
    var card = document.createElement('div');
    card.className = 'source-fallback-card';
    var head = document.createElement('div');
    head.className = 'source-fallback-head';
    var titleElNew = document.createElement('div');
    titleElNew.className = 'source-fallback-title';
    titleElNew.textContent = title || playbackI18nText('pf_auto_switch');
    var close = document.createElement('button');
    close.className = 'source-fallback-close';
    close.type = 'button';
    close.textContent = '×';
    close.onclick = function () { removeSourceFallbackCard(card); };
    var bodyElNew = document.createElement('div');
    bodyElNew.className = 'source-fallback-body';
    bodyElNew.textContent = body || '';
    head.appendChild(titleElNew);
    head.appendChild(close);
    card.appendChild(head);
    card.appendChild(bodyElNew);
    stack.insertBefore(card, stack.firstChild || null);
    while (stack.children.length > 4) removeSourceFallbackCard(stack.lastElementChild);
    requestAnimationFrame(function () { card.classList.add('show'); });
    setTimeout(function () { removeSourceFallbackCard(card); }, 5600);
    return;
  }
  var notice = document.getElementById('source-fallback-notice');
  var titleEl = document.getElementById('source-fallback-title');
  var bodyEl = document.getElementById('source-fallback-body');
  if (!notice || !titleEl || !bodyEl) return;
  titleEl.textContent = title || playbackI18nText('pf_auto_switch');
  bodyEl.textContent = body || '';
  notice.classList.add('show');
  if (sourceFallbackNoticeTimer) clearTimeout(sourceFallbackNoticeTimer);
  sourceFallbackNoticeTimer = setTimeout(closeSourceFallbackNotice, 5000);
}
function normalizeMatchText(text) {
  return String(text || '').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・\-—_.,，。:：'"“”‘’/\\|]+/g, '');
}
function artistNameParts(song) {
  var parts = [];
  if (song && Array.isArray(song.artists)) {
    song.artists.forEach(function (a) { if (a && a.name) parts.push(a.name); });
  }
  if (song && song.artist) {
    String(song.artist).split(/\s*\/\s*|\s*,\s*|、|&| feat\.? | ft\.? /i).forEach(function (name) {
      if (name && name.trim()) parts.push(name.trim());
    });
  }
  return parts.map(normalizeMatchText).filter(Boolean);
}
function isSameTitleArtist(source, candidate) {
  if (!source || !candidate) return false;
  if (normalizeMatchText(source.name || source.title) !== normalizeMatchText(candidate.name || candidate.title)) return false;
  var a = artistNameParts(source);
  var b = artistNameParts(candidate);
  if (!a.length || !b.length) return false;
  return a.some(function (name) { return b.indexOf(name) >= 0; });
}
var SOURCE_FALLBACK_SEARCH_TIMEOUT_MS = 6500;
// 能直接换过去的平台来自注册表的 directFallback 能力（Spotify 不返回可播放直链、汽水要签名，
// 两者都不在其中）。原先这里手抄一份，新增平台时不会有人记得同步。
// Platforms eligible for direct switching come from the registry's directFallback capability.
var SOURCE_FALLBACK_DIRECT_PROVIDERS = providerRegistryKeysWith('directFallback');
var SOURCE_FALLBACK_RECOVERY_TIMEOUT_MS = 20000;
var SOURCE_FALLBACK_MAX_QUEUE_ADVANCES = 2;
var SOURCE_FALLBACK_MAX_PROVIDER_ATTEMPTS = 4;
var sourceFallbackRecoverySerial = 0;
var activeSourceFallbackRecovery = null;
var sourceFallbackBudgetTimeoutResult = {};

function sourceFallbackRecoveryContentKey(song) {
  if (!song) return '';
  var title = normalizeMatchText(song.name || song.title || '');
  var artists = artistNameParts(song).sort().join(',');
  if (title && artists) return title + '|' + artists;
  return sourceFallbackSongKey(song);
}
function sourceFallbackRecoveryFromOptions(opts) {
  if (!opts) return null;
  return opts.sourceFallbackRecovery
    || (opts.playbackOpts && opts.playbackOpts.sourceFallbackRecovery)
    || null;
}
function sourceFallbackRecoveryIdentityActive(recovery) {
  return !!(
    recovery
    && activeSourceFallbackRecovery === recovery
    && !recovery.terminal
    && !recovery.cancelled
    && !recovery.completed
  );
}
function sourceFallbackRecoveryRemainingMs(recovery) {
  if (!sourceFallbackRecoveryIdentityActive(recovery)) return 0;
  return Math.max(0, Number(recovery.deadlineAt) - Date.now());
}
function sourceFallbackRecoveryCanContinue(recovery) {
  return sourceFallbackRecoveryRemainingMs(recovery) > 0;
}
function cancelSourceFallbackRecovery(reason) {
  var recovery = activeSourceFallbackRecovery;
  if (!recovery || recovery.terminal || recovery.completed) return false;
  recovery.cancelled = true;
  recovery.cancelReason = String(reason || 'superseded');
  activeSourceFallbackRecovery = null;
  return true;
}
function completeSourceFallbackRecovery(recovery) {
  if (!recovery || recovery.terminal || recovery.cancelled) return false;
  recovery.completed = true;
  if (activeSourceFallbackRecovery === recovery) activeSourceFallbackRecovery = null;
  return true;
}
function beginSourceFallbackPlaybackInvocation(opts) {
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (!recovery) {
    cancelSourceFallbackRecovery('new-root-playback');
    return true;
  }
  return sourceFallbackRecoveryCanContinue(recovery);
}
function ensureSourceFallbackRecovery(opts, song, idx, token) {
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (recovery) return sourceFallbackRecoveryIdentityActive(recovery) ? recovery : null;
  cancelSourceFallbackRecovery('new-recovery');
  recovery = {
    id: 'source-fallback-' + Date.now() + '-' + (++sourceFallbackRecoverySerial),
    startedAt: Date.now(),
    deadlineAt: Date.now() + SOURCE_FALLBACK_RECOVERY_TIMEOUT_MS,
    rootIndex: idx,
    rootToken: token,
    queueAdvances: 0,
    providerAttempts: 0,
    silent: !!(opts && opts.startupAutoplay),
    visitedSongKeys: Object.create(null),
    attemptedProviderKeys: Object.create(null),
    terminal: false,
    cancelled: false,
    completed: false
  };
  var songKey = sourceFallbackRecoveryContentKey(song);
  if (songKey) recovery.visitedSongKeys[songKey] = true;
  activeSourceFallbackRecovery = recovery;
  return recovery;
}
function sourceFallbackQueuePlaybackOptions(opts, recovery) {
  var next = Object.assign({}, opts || {});
  delete next.fallbackOriginalSong;
  delete next.fallbackCandidateSong;
  delete next.preResolvedPlaybackData;
  delete next.preloadedAudio;
  delete next.preloadedData;
  delete next.preloadedProxyAudioUrl;
  next.fallbackDepth = 0;
  next.sourceFallbackRecovery = recovery;
  return next;
}
function sourceFallbackRecoveryFailureOptions(opts) {
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (!recovery) return null;
  return {
    silent: !!recovery.silent,
    playbackOpts: sourceFallbackQueuePlaybackOptions(opts, recovery),
    sourceFallbackRecovery: recovery
  };
}
function settleExpiredSourceFallbackPlayback(idx, token, opts, message) {
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (!sourceFallbackRecoveryIdentityActive(recovery)) return false;
  if (opts && opts.fallbackOriginalSong && opts.fallbackCandidateSong) {
    restoreSourceFallbackQueueItem(idx, opts.fallbackOriginalSong, opts.fallbackCandidateSong, token);
  }
  return settleSourceFallbackTerminal(
    currentIdx,
    trackSwitchToken,
    message || playbackI18nText('pf_auto_recover_timeout'),
    sourceFallbackRecoveryFailureOptions(opts) || { sourceFallbackRecovery: recovery }
  );
}
function sourceFallbackProviderAttemptKey(recovery, song, provider) {
  return (sourceFallbackRecoveryContentKey(song) || sourceFallbackSongKey(song)) + '|' + normalizePlaybackProvider(provider);
}
function beginSourceFallbackProviderAttempt(recovery, song, provider) {
  if (!sourceFallbackRecoveryCanContinue(recovery)) return false;
  var key = sourceFallbackProviderAttemptKey(recovery, song, provider);
  if (recovery.attemptedProviderKeys[key]) return false;
  if (recovery.providerAttempts >= SOURCE_FALLBACK_MAX_PROVIDER_ATTEMPTS) return false;
  recovery.attemptedProviderKeys[key] = true;
  recovery.providerAttempts++;
  return true;
}
function awaitSourceFallbackBudget(promise, recovery) {
  if (!recovery) return Promise.resolve(promise);
  var remaining = sourceFallbackRecoveryRemainingMs(recovery);
  if (remaining <= 0) return Promise.resolve(sourceFallbackBudgetTimeoutResult);
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve(sourceFallbackBudgetTimeoutResult);
    }, remaining);
    Promise.resolve(promise).then(function (value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sourceFallbackProviderTitle(provider) {
  // 与音源切换器用同一套短名（注册表的 compact 标题），换源提示与切换器里显示的名字才一致。
  // Shares the switcher's compact titles from the registry, so the fallback notice and the switcher
  // name the platform identically.
  return providerRegistryCompactTitle(provider);
}
function sourceFallbackProviderReady(provider) {
  provider = normalizePlaybackProvider(provider);
  if (SOURCE_FALLBACK_DIRECT_PROVIDERS.indexOf(provider) < 0) return false;
  var status = typeof platformStatus === 'function' ? platformStatus(provider) : null;
  if (!status || !status.loggedIn) return false;
  if (provider === 'qq' || provider === 'kugou') return status.playbackKeyReady === true;
  return true;
}
// 默认源路径专用的就绪判定。
// ⚠️ 为什么不能复用 sourceFallbackProviderReady：那个函数以**自动换源候选清单**为门槛，而汽水
//    不在其中（自动换源历史上只覆盖 netease/qq/kugou）。但汽水本身是可搜、可播的（手动音源切换器
//    一直支持它），所以它具备「可被指定为默认源」的资格。两者混用会让「默认源」下拉里的汽水
//    永远搜不到 —— 一个看得见却永远不生效的设置项。（这条是测试抓出来的：断言"顺序走全"时发现
//    汽水根本没被问到。）
// Readiness for the preferred-source path only.
// ⚠️ It cannot reuse sourceFallbackProviderReady: that one gates on the automatic-FALLBACK candidate
//    list, which excludes Qishui (the recovery path has only ever covered netease/qq/kugou). But
//    Qishui is searchable and playable — the manual source switcher has always offered it — so it
//    qualifies as a preferred source. Sharing the gate would make a Qishui preference unreachable:
//    an option visible in the dropdown that can never take effect. (A test caught this: asserting the
//    order is fully walked showed Qishui was never asked.)
function preferredSourceProviderReady(provider) {
  provider = normalizePlaybackProvider(provider);
  if (!provider || !providerRegistryHasCapability(provider, 'preferred')) return false;
  var status = typeof platformStatus === 'function' ? platformStatus(provider) : null;
  if (!status || !status.loggedIn) return false;
  if (provider === 'qq' || provider === 'kugou') return status.playbackKeyReady === true;
  return true;
}
function alternatePlaybackProviders(song) {
  var currentProvider = normalizePlaybackProvider(songProviderKey(song));
  var ordered = typeof accountProviderOrder === 'function'
    ? accountProviderOrder()
    : SOURCE_FALLBACK_DIRECT_PROVIDERS.slice();
  var seen = {};
  var providers = [];
  ordered.concat(SOURCE_FALLBACK_DIRECT_PROVIDERS).forEach(function (provider) {
    provider = normalizePlaybackProvider(provider);
    if (seen[provider] || provider === currentProvider || !sourceFallbackProviderReady(provider)) return;
    seen[provider] = true;
    providers.push(provider);
  });
  return providers;
}
function alternatePlaybackProvider(song) {
  return alternatePlaybackProviders(song)[0] || '';
}

// ── 默认源：播放时优先用用户指定的平台 ──────────────────────────────────────
// 只有**一份查找顺序**：把默认源排到最前，其余平台保持原有优先级。
// 顺序里包含歌曲自身的来源 —— 走到它就原样播放（它本来就只是清单里的一个成员，不需要另设
// 一个「回退原源」的概念），走到别的平台才去搜同名同歌手。整条顺序走完都没命中，同样落在
// 「原样播放」上，即与没有这个设置时一致。
// There is exactly ONE lookup order: the preferred source goes first and the rest keep their existing
// priority. That order contains the song's own provider, and reaching it means "play as-is" — the
// original source is merely a member of the list, so no separate "fall back to the original" concept
// is needed. Other entries are searched for the same title and artist. Exhausting the order lands on
// the same "play as-is", i.e. identical to not having the setting at all.
function preferredSourceLookupOrder(song) {
  var preferred = typeof preferredSourceProvider === 'function' ? preferredSourceProvider() : '';
  var ordered = typeof accountProviderOrder === 'function' ? accountProviderOrder().slice() : [];
  // 账号卡顺序里可能缺平台（用户从没登录过某个平台），补上注册表的直接换源清单。
  SOURCE_FALLBACK_DIRECT_PROVIDERS.forEach(function (provider) {
    if (ordered.indexOf(provider) < 0) ordered.push(provider);
  });
  // 歌曲自身的来源必须出现在顺序里，否则就失去了「走到它就播原曲」的终点。
  var current = normalizePlaybackProvider(songProviderKey(song));
  if (current && ordered.indexOf(current) < 0) ordered.push(current);
  var seen = {};
  var out = [];
  [preferred].concat(ordered).forEach(function (provider) {
    provider = normalizePlaybackProvider(provider);
    if (!provider || seen[provider]) return;
    seen[provider] = true;
    out.push(provider);
  });
  return out;
}

// 整段选源的总预算。单次搜索超时是 6.5s，而"找不到就继续试其它平台"会**串行**试多个平台，
// 最坏情况能把「按下播放到出声」拖到十几秒 —— 那是不可接受的。所以给整段选源一个总时限，
// 到点就停下按原样播。它是播放前的优化，永远不该让播放等太久。
// Overall budget for source selection. A single search may take 6.5s and "keep trying the other
// platforms" tries them SEQUENTIALLY, so the worst case could delay "press play to sound" by more
// than ten seconds. The whole selection is therefore bounded; on expiry it plays the track as-is.
// This runs before playback, so it must never make playback wait long.
var PREFERRED_SOURCE_BUDGET_MS = 4000;

// 把一次搜索限制在剩余预算内。超时或出错都解析成 null（= 没命中），并记一条日志。
// Bounds one search by the remaining budget; timeout and error both resolve to null (a miss).
function searchAlternatePlatformSongWithinBudget(song, provider, remaining) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve(null);
    }, Math.max(0, remaining));
    var promise;
    try {
      promise = searchAlternatePlatformSong(song, provider, null);
    } catch (e) {
      clearTimeout(timer);
      settled = true;
      console.warn('[PreferredSource]', provider, e && (e.message || e));
      resolve(null);
      return;
    }
    Promise.resolve(promise).then(function (value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value || null);
    }, function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.warn('[PreferredSource]', provider, error && (error.message || error));
      resolve(null);
    });
  });
}
async function resolvePreferredSourceSong(song, opts) {
  opts = opts || {};
  if (typeof preferredSourceProvider !== 'function') return null;
  var preferred = preferredSourceProvider();
  if (!preferred) return null;
  // 本地/播客/无来源标识的歌没有"换到别的平台"的语义。
  if (!song || song.type === 'local' || song.type === 'podcast' || song.source === 'podcast' || song.localUrl) return null;
  // 换源重试与无缝接力已经在按自己的策略挑歌，这里再插一手会互相打架；
  // 音质重切同一首歌也不该重新选源。
  if (opts.fallbackDepth > 0 || opts.albumGaplessHandoff || opts.qualitySwitch) return null;
  var current = normalizePlaybackProvider(songProviderKey(song));
  if (!current) return null;
  // 已经是默认源，或者用户选了「不指定」，都无事可做（后者是最常见的零开销路径）。
  if (current === preferred) return null;
  var order = preferredSourceLookupOrder(song);
  var deadline = Date.now() + PREFERRED_SOURCE_BUDGET_MS;
  for (var i = 0; i < order.length; i++) {
    var provider = order[i];
    // 走到歌曲自身的来源 —— 原样播放，不再往后搜（省一次往返，也避免把好好的原曲换掉）。
    if (provider === current) return null;
    var remaining = deadline - Date.now();
    // 预算用尽：剩下的平台一律不试，按原样播。
    if (remaining <= 0) return null;
    if (!preferredSourceProviderReady(provider)) continue;
    var match = await searchAlternatePlatformSongWithinBudget(song, provider, remaining);
    if (match) {
      match.preferredSourceFrom = current;
      return match;
    }
  }
  return null;
}
async function searchAlternatePlatformSong(song, requestedTarget, recovery) {
  var target = requestedTarget || alternatePlaybackProvider(song);
  if (!target) return null;
  // 两道就绪判据取「或」：既有的自动换源候选，或「可被指定为默认源」的平台（后者包含汽水）。
  // 既有调用方传进来的 target 都已经过 sourceFallbackProviderReady 预筛（或由
  // alternatePlaybackProviders 产出），所以第一项对它们恒真 —— 行为不变。默认源路径才需要第二项，
  // 否则汽水会被这道内层门挡住（外层放行了、内层又拦回去，表现为"选了汽水永远搜不到"）。
  // Readiness is an OR of two capabilities: the automatic-fallback candidates, or the platforms that
  // may be preferred (which include Qishui). Existing callers pass targets already filtered by
  // sourceFallbackProviderReady, so the first clause is always true for them and their behaviour is
  // unchanged. Only the preferred-source path needs the second clause; without it Qishui passes the
  // outer check and is rejected here, showing up as "a Qishui preference never finds anything".
  if (!sourceFallbackProviderReady(target) && !preferredSourceProviderReady(target)) return null;
  if (recovery && !sourceFallbackRecoveryCanContinue(recovery)) return null;
  var artist = artistNameParts(song)[0] || '';
  var query = [song.name || song.title || '', song.artist || artist].filter(Boolean).join(' ').trim();
  if (!query) return null;
  var url = providerRegistrySearchUrl(target, query, target === 'netease' ? 12 : 8);
  var data = await awaitSourceFallbackBudget(
    apiJson(url, { timeoutMs: SOURCE_FALLBACK_SEARCH_TIMEOUT_MS }),
    recovery
  );
  if (data === sourceFallbackBudgetTimeoutResult || (recovery && !sourceFallbackRecoveryCanContinue(recovery))) return null;
  var list = data && (data.songs || data.result || []);
  for (var i = 0; i < list.length; i++) {
    if (typeof sourceCandidateRejectReason === 'function' && sourceCandidateRejectReason(song, list[i], target)) continue;
    if (isSameTitleArtist(song, list[i])) return cloneSong(list[i]);
  }
  return null;
}
function sourceFallbackSongKey(song) {
  if (!song) return '';
  if (typeof queueItemKey === 'function') return queueItemKey(song);
  return [songProviderKey(song), song.id || song.mid || song.hash || '', song.name || song.title || '', song.artist || ''].join(':');
}
function restoreSourceFallbackQueueItem(idx, originalSong, candidateSong, expectedToken) {
  if (!originalSong || idx < 0 || idx >= playQueue.length) return false;
  if (expectedToken != null && expectedToken !== trackSwitchToken) return false;
  if (currentIdx !== idx || sourceFallbackSongKey(playQueue[idx]) !== sourceFallbackSongKey(candidateSong)) return false;
  playQueue[idx] = hydrateCustomCover(originalSong);
  if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(playQueue[idx]);
  var title = document.getElementById('thumb-title');
  var artist = document.getElementById('thumb-artist');
  if (title) title.textContent = playQueue[idx].name || playQueue[idx].title || '';
  if (artist) artist.textContent = playQueue[idx].artist || '';
  safeRenderQueuePanel('source-fallback-rollback', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('source-fallback-rollback');
  return true;
}
function settleSourceFallbackTerminal(idx, token, message, opts) {
  opts = opts || {};
  var recovery = sourceFallbackRecoveryFromOptions(opts);
  if (token !== trackSwitchToken || currentIdx !== idx) return false;
  if (recovery) {
    if (!sourceFallbackRecoveryIdentityActive(recovery)) return false;
    recovery.terminal = true;
    recovery.terminalAt = Date.now();
    if (activeSourceFallbackRecovery === recovery) activeSourceFallbackRecovery = null;
  }
  hideLoading();
  forcePlaybackControlsInteractive();
  playToggleBusy = false;
  markQueueItemPlaybackFailed(idx, recovery);
  if (typeof clearAlbumGaplessPreload === 'function') clearAlbumGaplessPreload('source-fallback-terminal');
  if (typeof resetCuefieldAutoMix === 'function') resetCuefieldAutoMix('source-fallback-terminal');
  if (typeof clearPlaybackResumeWatchdogs === 'function') clearPlaybackResumeWatchdogs();
  if (typeof playbackResumeRecovery !== 'undefined' && playbackResumeRecovery) {
    playbackResumeRecovery.serial = (Number(playbackResumeRecovery.serial) || 0) + 1;
    playbackResumeRecovery.pending = false;
  }
  if (audio) {
    try {
      audioFadeSerial++;
      clearAudioFadeTimers();
      audio.onended = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.__mineradioQueueItemKey = '';
      audio.__mineradioTrackSwitchToken = 0;
      audio.load();
    } catch (e) { }
  }
  playing = false;
  setPlayIcon(false);
  if (typeof syncPlaybackStateFromAudioEvent === 'function') syncPlaybackStateFromAudioEvent('source-fallback-terminal');
  if (!opts.silent) showSourceFallbackNotice(playbackI18nText('pf_no_source'), message || playbackI18nText('pf_unplayable_no_source'));
  return false;
}
function markQueueItemPlaybackFailed(idx, recovery) {
  if (!playQueue[idx]) return;
  playQueue[idx]._lastPlaybackFailAt = Date.now();
  playQueue[idx]._lastPlaybackFailRecoveryId = recovery && recovery.id ? recovery.id : '';
}
var MAX_RECENT_AUTO_QUEUE_FAILURES = 12;
function recentQueuePlaybackFailureCount(recovery) {
  var now = Date.now();
  var count = 0;
  for (var index = 0; index < playQueue.length; index++) {
    var failedAt = Number(playQueue[index] && playQueue[index]._lastPlaybackFailAt) || 0;
    if (recovery && playQueue[index] && playQueue[index]._lastPlaybackFailRecoveryId !== recovery.id) continue;
    if (failedAt && now - failedAt <= 18000) {
      count++;
      if (count >= MAX_RECENT_AUTO_QUEUE_FAILURES) break;
    }
  }
  return count;
}
function nextUnblockedQueueIndex(idx, recovery) {
  var now = Date.now();
  for (var step = 1; step < playQueue.length; step++) {
    var nextIdx = (idx + step) % playQueue.length;
    var failedAt = Number(playQueue[nextIdx] && playQueue[nextIdx]._lastPlaybackFailAt) || 0;
    var recoveryKey = sourceFallbackRecoveryContentKey(playQueue[nextIdx]);
    if (recovery && recoveryKey && recovery.visitedSongKeys[recoveryKey]) continue;
    var failedInRecovery = !recovery
      || (playQueue[nextIdx] && playQueue[nextIdx]._lastPlaybackFailRecoveryId === recovery.id);
    if (!failedInRecovery || !failedAt || now - failedAt > 18000) return nextIdx;
  }
  return -1;
}
function isQueueItemRecentlyPlaybackFailed(idx) {
  var failedAt = Number(playQueue[idx] && playQueue[idx]._lastPlaybackFailAt) || 0;
  return !!(failedAt && Date.now() - failedAt <= 18000);
}
async function skipFailedQueueItem(idx, token, message, opts) {
  opts = opts || {};
  if (token !== trackSwitchToken) return false;
  var recovery = ensureSourceFallbackRecovery(opts, playQueue[idx], idx, token);
  if (!recovery) return false;
  var terminalOpts = Object.assign({}, opts, { sourceFallbackRecovery: recovery });
  if (!sourceFallbackRecoveryCanContinue(recovery)) {
    return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_auto_recover_timeout'), terminalOpts);
  }
  hideLoading();
  markQueueItemPlaybackFailed(idx, recovery);
  var currentRecoveryKey = sourceFallbackRecoveryContentKey(playQueue[idx]);
  if (currentRecoveryKey) recovery.visitedSongKeys[currentRecoveryKey] = true;
  if (playQueue.length <= 1) {
    return settleSourceFallbackTerminal(idx, token, message || playbackI18nText('pf_unplayable_empty_queue'), terminalOpts);
  }
  if (recentQueuePlaybackFailureCount(recovery) >= Math.min(MAX_RECENT_AUTO_QUEUE_FAILURES, playQueue.length)) {
    return settleSourceFallbackTerminal(idx, token, '', terminalOpts);
  }
  if (recovery.queueAdvances >= SOURCE_FALLBACK_MAX_QUEUE_ADVANCES) {
    return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_stop_auto_switch'), terminalOpts);
  }
  var nextIdx = nextUnblockedQueueIndex(idx, recovery);
  if (nextIdx < 0) {
    return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_bypass_no_items'), terminalOpts);
  }
  if (!opts.silent) showSourceFallbackNotice(playbackI18nText('pf_skipped_restricted'), message || playbackI18nText('pf_no_other_version'));
  recovery.queueAdvances++;
  var nextRecoveryKey = sourceFallbackRecoveryContentKey(playQueue[nextIdx]);
  if (nextRecoveryKey) recovery.visitedSongKeys[nextRecoveryKey] = true;
  var nextPlaybackOpts = Object.assign(
    {},
    sourceFallbackQueuePlaybackOptions(opts.playbackOpts || {}, recovery),
    { skipShuffleOrder: true }
  );
  var nextStarted = await playQueueAt(nextIdx, nextPlaybackOpts);
  if (nextStarted === true) completeSourceFallbackRecovery(recovery);
  else if (sourceFallbackRecoveryIdentityActive(recovery) && !sourceFallbackRecoveryCanContinue(recovery)) {
    return settleSourceFallbackTerminal(currentIdx, trackSwitchToken, playbackI18nText('pf_auto_recover_timeout'), terminalOpts);
  }
  return nextStarted === true;
}
async function tryAutoPlaybackFallback(song, data, idx, token, opts) {
  opts = opts || {};
  if (opts.fallbackDepth > 0) {
    if (opts.fallbackOriginalSong && opts.fallbackCandidateSong) {
      restoreSourceFallbackQueueItem(idx, opts.fallbackOriginalSong, opts.fallbackCandidateSong, token);
    }
    return false;
  }
  if (!song || song.type === 'local' || song.type === 'podcast' || song.source === 'podcast') return null;
  var category = playbackRestrictionCategory(song, data);
  var fromLabel = playbackProviderLabel(song);
  var alternateProviders = alternatePlaybackProviders(song);
  if (!alternateProviders.length && category === 'login_required') return null;
  var recovery = ensureSourceFallbackRecovery(opts, song, idx, token);
  if (!recovery) return false;
  opts = Object.assign({}, opts, { sourceFallbackRecovery: recovery });
  var skipPlaybackOpts = sourceFallbackQueuePlaybackOptions(opts, recovery);
  skipPlaybackOpts.startupAutoplay = true;
  if (opts.resumeAt != null) skipPlaybackOpts.resumeAt = opts.resumeAt;
  var skipOpts = {
    silent: !!recovery.silent,
    playbackOpts: skipPlaybackOpts,
    sourceFallbackRecovery: recovery
  };
  if (!sourceFallbackRecoveryCanContinue(recovery)) {
    return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_auto_recover_timeout'), skipOpts);
  }
  if (!alternateProviders.length) {
    return await skipFailedQueueItem(idx, token, playbackI18nText('pf_unplayable_no_takeover'), skipOpts);
  }
  if (!opts.startupAutoplay) {
    showSourceFallbackNotice(playbackI18nText('pf_auto_switching'), fromLabel + playbackI18nText('pf_unplayable_checking_infix') + alternateProviders.map(sourceFallbackProviderTitle).join('、') + playbackI18nText('pf_same_title_artist_suffix'));
  }
  for (var providerIndex = 0; providerIndex < alternateProviders.length; providerIndex++) {
    var alternateProvider = alternateProviders[providerIndex];
    if (!beginSourceFallbackProviderAttempt(recovery, song, alternateProvider)) {
      if (!sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_auto_recover_timeout'), skipOpts);
      }
      continue;
    }
    var targetLabel = sourceFallbackProviderTitle(alternateProvider);
    try {
      var alternate = await searchAlternatePlatformSong(song, alternateProvider, recovery);
      if (token !== trackSwitchToken) return false;
      if (!sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_auto_recover_timeout'), skipOpts);
      }
      if (!alternate) continue;
      var alternateData = typeof resolveAlbumGaplessPlaybackData === 'function'
        ? await awaitSourceFallbackBudget(resolveAlbumGaplessPlaybackData(alternate), recovery)
        : null;
      if (token !== trackSwitchToken) return false;
      if (alternateData === sourceFallbackBudgetTimeoutResult || !sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_auto_recover_timeout'), skipOpts);
      }
      if (!alternateData || !alternateData.url) continue;
      var originalSong = playQueue[idx];
      alternate.autoFallbackFrom = songProviderKey(song);
      var committedCandidate = hydrateCustomCover(alternate);
      playQueue[idx] = committedCandidate;
      safeRenderQueuePanel('source-fallback-provisional', { scrollCurrent: miniQueueOpen });
      safeShelfRebuild('source-fallback-provisional');
      var fallbackPlaybackOpts = {
        fallbackDepth: 1,
        startupAutoplay: !!opts.startupAutoplay,
        preserveHomeState: !!opts.preserveHomeState,
        suppressPlayFailureNotice: true,
        preResolvedPlaybackData: alternateData,
        fallbackOriginalSong: originalSong,
        fallbackCandidateSong: committedCandidate,
        sourceFallbackRecovery: recovery,
        qqQualityTried: ['hires', 'lossless', 'exhigh', 'standard']
      };
      if (opts.resumeAt != null) fallbackPlaybackOpts.resumeAt = opts.resumeAt;
      var fallbackPromise = playQueueAt(idx, fallbackPlaybackOpts);
      var fallbackToken = trackSwitchToken;
      var fallbackStarted = await fallbackPromise;
      if (fallbackToken !== trackSwitchToken) return false;
      if (fallbackStarted === true) {
        completeSourceFallbackRecovery(recovery);
        if (!opts.startupAutoplay) showSourceFallbackNotice(playbackI18nText('pf_source_switched'), (song.name || playbackI18nText('track_current_song')) + playbackI18nText('pf_from_infix') + fromLabel + playbackI18nText('pf_switched_to_infix') + targetLabel + '。');
        return true;
      }
      restoreSourceFallbackQueueItem(idx, originalSong, committedCandidate, fallbackToken);
      token = fallbackToken;
      if (!sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_auto_recover_timeout'), skipOpts);
      }
    } catch (e) {
      if (token !== trackSwitchToken) return false;
      if (!sourceFallbackRecoveryCanContinue(recovery)) {
        return settleSourceFallbackTerminal(idx, token, playbackI18nText('pf_auto_recover_timeout'), skipOpts);
      }
      console.warn('[SourceFallback]', alternateProvider, e && (e.message || e));
    }
  }
  return await skipFailedQueueItem(idx, token, playbackI18nText('pf_no_playable_version'), skipOpts);
}
function handlePlaybackUnavailable(song, data) {
  hideLoading();
  forcePlaybackControlsInteractive();
  var provider = playbackLoginProvider(song);
  var notice = playbackRestrictionNotice(song, data);
  var category = notice.category;
  showToast(notice.toast || notice.title || playbackRestrictionMessage(song, data));
  showSourceFallbackNotice(notice.title, notice.body);
  if (category === 'login_required') {
    setTimeout(function () {
      var modal = document.getElementById('login-modal');
      if (!modal || modal.classList.contains('show')) return;
      openProviderLogin(provider);
    }, 520);
  }
}
