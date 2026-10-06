// ============================================================
async function apiJson(url, opts) {
  opts = opts || {};
  var timeoutMs = Number(opts.timeoutMs) || 0;
  var fetchOpts = Object.assign({}, opts);
  delete fetchOpts.timeoutMs;
  var timer = null;
  if (timeoutMs && window.AbortController && !fetchOpts.signal) {
    var controller = new AbortController();
    fetchOpts.signal = controller.signal;
    timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  }
  try {
    var res = await fetch(url, fetchOpts);
    var data = await res.json();
    // 后端把机器码放在 error、中文原文放在 message。所有 HTTP 请求都经过这里，
    // 在这一层把 message 换成词典文案，就不用逐个显示点去改。
    // The backend puts a machine code in `error` and the Chinese original in
    // `message`. Every HTTP call funnels through here, so localizing `message`
    // once covers all display sites instead of patching them one by one.
    var backendText = window.MineradioBackendText;
    if (backendText && typeof backendText.localizeDeep === 'function') backendText.localizeDeep(data, 0);
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// 音质区块与输出设备区块的界面文案统一走 i18n；缺键时退回内置中文模板。
// Quality / audio-output UI copy goes through i18n and falls back to the built-in
// Chinese template, so the panel never shows an empty string or a raw key.
// params 既透传给 t()，也插值进兜底模板，缺词典时占位符仍会被替换掉。
// params goes to both t() and the fallback template, so placeholders still resolve
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
function playbackOutputText(key, fallback, params) {
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

// 后端文案的统一取用入口。后端把机器码放在 error、原文放在 message，
// 界面按 code 查词典；code 没有映射时退回原文，最后才用调用方自己的兜底句。
// Unified accessor for backend copy. The backend puts a machine code in `error`
// and the original text in `message`; the UI looks copy up by code and falls
// back to the original, then to the caller's own default.
function backendText(payload, fallbackKey, fallbackText) {
  var lib = window.MineradioBackendText;
  if (lib && typeof lib.backendText === 'function') {
    return lib.backendText(payload, fallbackKey, fallbackText);
  }
  return (payload && payload.message) || fallbackText || '';
}

// 有些站点把后端机器码装进 Error 再抛出来，分类判断要用机器码（例如按
// SCOPE / AUTH_REQUIRED 决定给哪句提示），只有显示这一步需要换成词典文案。
// Some sites throw an Error carrying the raw machine code. Classification needs
// that code — for example to tell a scope failure from an auth failure — so only
// the display step swaps it for dictionary copy.
function backendCodeDisplay(value) {
  var raw = String(value == null ? '' : value);
  var lib = window.MineradioBackendText;
  if (lib && typeof lib.backendCodeText === 'function') {
    var mapped = lib.backendCodeText(raw, '');
    if (mapped) return mapped;
  }
  return raw;
}

function normalizePlaybackQuality(value) {
  value = String(value || '').toLowerCase();
  if (value === 'jymaster' || value === 'master' || value === 'svip') return 'jymaster';
  if (value === 'hires' || value === 'hi-res' || value === 'highres' || value === 'highest') return 'hires';
  if (value === 'lossless' || value === 'flac' || value === 'sq') return 'lossless';
  if (value === 'exhigh' || value === 'high' || value === '320k' || value === 'hq') return 'exhigh';
  if (value === 'standard' || value === 'normal' || value === 'std') return 'standard';
  return 'hires';
}
function normalizePlaybackProvider(provider) {
  if (provider === 'qq') return 'qq';
  if (provider === 'kugou') return 'kugou';
  if (provider === 'qishui') return 'qishui';
  if (provider === 'spotify') return 'spotify';
  return 'netease';
}
function normalizePlaybackQualityForProvider(value, provider) {
  provider = normalizePlaybackProvider(provider);
  var q = normalizePlaybackQuality(value);
  if (provider === 'qq' && q === 'jymaster') return 'hires';
  return q;
}
function playbackQualityOptions(provider) {
  provider = normalizePlaybackProvider(provider);
  // 表是 00-core-stores.js 里的 playbackQualityOptionTable()（原先叫 playbackQualityOptions，
  // 与本函数重名导致无限递归，已改名）。
  // The table is playbackQualityOptionTable() in 00-core-stores.js. It used to carry this same
  // name, shadowed this function and sent it into infinite recursion, so it was renamed.
  var table = playbackQualityOptionTable();
  return table[provider] || table.netease;
}
function currentPlaybackQualityProvider() {
  var song = Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  return normalizePlaybackProvider(songProviderKey(song));
}
function getProviderPlaybackQuality(provider) {
  provider = normalizePlaybackProvider(provider);
  var prefs = playbackQualityPrefs || {};
  return normalizePlaybackQualityForProvider(prefs[provider] || PLAYBACK_QUALITY_DEFAULTS[provider], provider);
}
function setProviderPlaybackQuality(provider, value) {
  provider = normalizePlaybackProvider(provider);
  if (!playbackQualityPrefs || typeof playbackQualityPrefs !== 'object') playbackQualityPrefs = {};
  playbackQualityPrefs[provider] = normalizePlaybackQualityForProvider(value, provider);
  playbackQuality = playbackQualityPrefs[provider];
  savePlaybackQualityPreference();
}
function getPlaybackQualityForSong(song) {
  var provider = normalizePlaybackProvider(songProviderKey(song));
  return getProviderPlaybackQuality(provider);
}
function playbackQualityLabel(value, provider) {
  provider = normalizePlaybackProvider(provider || currentPlaybackQualityProvider());
  value = normalizePlaybackQualityForProvider(value, provider);
  if (provider === 'spotify') return playbackOutputText('quality_spotify_match');
  if (provider === 'qishui') return playbackOutputText('out_qishui_quality');
  if (provider === 'qq') {
    if (value === 'hires') return 'Hi-Res FLAC';
    if (value === 'lossless') return playbackOutputText('quality_lossless_flac', '无损 FLAC');
    if (value === 'exhigh') return '320k MP3';
    if (value === 'standard') return '128k MP3';
    return playbackOutputText('quality_lossless_flac', '无损 FLAC');
  }
  if (provider === 'kugou') {
    if (value === 'hires') return playbackOutputText('out_kugou_hires');
    if (value === 'lossless') return playbackOutputText('out_kugou_lossless');
    if (value === 'exhigh') return playbackOutputText('out_kugou_320k');
    if (value === 'standard') return playbackOutputText('out_kugou_128k');
    return playbackOutputText('out_kugou_lossless');
  }
  if (value === 'jymaster') return playbackOutputText('quality_jymaster', '超清母带');
  if (value === 'hires') return playbackOutputText('quality_hires', '高清臻音');
  if (value === 'lossless') return playbackOutputText('quality_lossless', '无损');
  if (value === 'exhigh') return playbackOutputText('quality_exhigh', '极高');
  if (value === 'standard') return playbackOutputText('quality_standard', '标准');
  return playbackOutputText('quality_hires', '高清臻音');
}
function playbackQualityShortLabel(value, provider) {
  provider = normalizePlaybackProvider(provider || currentPlaybackQualityProvider());
  value = normalizePlaybackQualityForProvider(value, provider);
  if (provider === 'spotify') return 'SP';
  if (provider === 'qishui') return 'QS';
  if (provider === 'qq') {
    if (value === 'hires') return 'QQ Hires';
    if (value === 'lossless') return 'QQ SQ';
    if (value === 'exhigh') return 'QQ 320';
    if (value === 'standard') return 'QQ 128';
    return 'QQ SQ';
  }
  if (provider === 'kugou') {
    if (value === 'hires') return 'KG Hires';
    if (value === 'lossless') return 'KG SQ';
    if (value === 'exhigh') return 'KG 320';
    if (value === 'standard') return 'KG 128';
    return 'KG SQ';
  }
  if (value === 'jymaster') return playbackOutputText('out_master');
  if (value === 'hires') return playbackOutputText('out_hi_res');
  if (value === 'lossless') return 'SQ';
  if (value === 'exhigh') return 'HQ';
  if (value === 'standard') return 'STD';
  return playbackOutputText('out_hi_res');
}
function playbackQualityRank(value, provider) {
  value = normalizePlaybackQualityForProvider(value, provider);
  if (value === 'jymaster') return 5;
  if (value === 'hires') return 4;
  if (value === 'lossless') return 3;
  if (value === 'exhigh') return 2;
  if (value === 'standard') return 1;
  return 4;
}
function playbackQualityWasDowngraded(requested, resolved, provider) {
  return playbackQualityRank(resolved, provider) < playbackQualityRank(requested, provider);
}
function playbackQualityTrackKey(song, provider) {
  provider = normalizePlaybackProvider(provider || songProviderKey(song));
  song = song || {};
  var id = song.id || song.mid || song.songmid || song.hash || song.fileHash || song.audioHash || song.providerSongId || '';
  var media = song.mediaMid || song.media_mid || song.albumAudioId || song.album_audio_id || song.mixSongId || '';
  if (!id) id = [song.name || song.title || '', song.artist || '', song.album || ''].join('|');
  return provider + ':' + String(id || '').trim() + ':' + String(media || '').trim();
}
function playbackQualityRuntimeCapForSong(song, provider) {
  if (!song) return null;
  var key = playbackQualityTrackKey(song, provider);
  return key && playbackQualityRuntimeCaps ? playbackQualityRuntimeCaps[key] || null : null;
}
function playbackQualityCapValue(song, provider) {
  var cap = playbackQualityRuntimeCapForSong(song, provider);
  return cap && cap.ceiling ? normalizePlaybackQualityForProvider(cap.ceiling, provider) : '';
}
function playbackQualityAboveCap(value, provider, capValue) {
  if (!capValue) return false;
  capValue = normalizePlaybackQualityForProvider(capValue, provider);
  return playbackQualityRank(value, provider) > playbackQualityRank(capValue, provider);
}
function effectivePlaybackQualityForSong(song, provider, requested) {
  provider = normalizePlaybackProvider(provider || songProviderKey(song));
  var q = normalizePlaybackQualityForProvider(requested || getProviderPlaybackQuality(provider), provider);
  var cap = playbackQualityCapValue(song, provider);
  return playbackQualityAboveCap(q, provider, cap) ? cap : q;
}
function markPlaybackQualityRuntimeCap(song, provider, ceiling, reason) {
  provider = normalizePlaybackProvider(provider || songProviderKey(song));
  if (!song || !ceiling) return false;
  ceiling = normalizePlaybackQualityForProvider(ceiling, provider);
  var key = playbackQualityTrackKey(song, provider);
  if (!key) return false;
  var prev = playbackQualityRuntimeCaps && playbackQualityRuntimeCaps[key];
  if (prev && playbackQualityRank(prev.ceiling, provider) <= playbackQualityRank(ceiling, provider)) return false;
  playbackQualityRuntimeCaps[key] = {
    provider: provider,
    ceiling: ceiling,
    reason: reason || '',
    at: Date.now()
  };
  updatePlaybackQualityUi();
  return true;
}
function playbackBitrateLabel(br) {
  br = Number(br) || 0;
  if (!br) return '';
  if (br >= 1000000) return (br / 1000000).toFixed(br >= 2000000 ? 1 : 2).replace(/\.0+$/, '') + ' Mbps';
  return Math.round(br / 1000) + ' kbps';
}
function playbackResolvedQualityText(data, provider) {
  data = data || {};
  provider = normalizePlaybackProvider(provider || data.provider || currentPlaybackQualityProvider());
  var label = provider === 'qq' && data.quality
    ? String(data.quality)
    : playbackQualityLabel(data.level || getProviderPlaybackQuality(provider), provider);
  var br = playbackBitrateLabel(data.br);
  return br ? (label + ' · ' + br) : label;
}
function readPlaybackQualityPreference() {
  var fallback = {
    netease: PLAYBACK_QUALITY_DEFAULTS.netease,
    qq: PLAYBACK_QUALITY_DEFAULTS.qq,
    kugou: PLAYBACK_QUALITY_DEFAULTS.kugou,
    qishui: PLAYBACK_QUALITY_DEFAULTS.qishui,
    spotify: PLAYBACK_QUALITY_DEFAULTS.spotify
  };
  try {
    var raw = localStorage.getItem(PLAYBACK_QUALITY_STORE_KEY) || '';
    if (!raw) return fallback;
    if (raw.trim().charAt(0) !== '{') {
      var legacy = normalizePlaybackQuality(raw);
      return {
        netease: normalizePlaybackQualityForProvider(legacy, 'netease'),
        qq: normalizePlaybackQualityForProvider(legacy, 'qq'),
        kugou: normalizePlaybackQualityForProvider(legacy, 'kugou'),
        qishui: normalizePlaybackQualityForProvider(fallback.qishui, 'qishui'),
        spotify: normalizePlaybackQualityForProvider(fallback.spotify, 'spotify')
      };
    }
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      netease: normalizePlaybackQualityForProvider(parsed.netease || fallback.netease, 'netease'),
      qq: normalizePlaybackQualityForProvider(parsed.qq || fallback.qq, 'qq'),
      kugou: normalizePlaybackQualityForProvider(parsed.kugou || fallback.kugou || 'lossless', 'kugou'),
      qishui: normalizePlaybackQualityForProvider(parsed.qishui || fallback.qishui || 'standard', 'qishui'),
      spotify: normalizePlaybackQualityForProvider(parsed.spotify || fallback.spotify || 'standard', 'spotify')
    };
  } catch (e) {
    return fallback;
  }
}
function savePlaybackQualityPreference() {
  try { localStorage.setItem(PLAYBACK_QUALITY_STORE_KEY, JSON.stringify(playbackQualityPrefs || {})); } catch (e) { }
}
function updatePlaybackQualityUi() {
  var provider = currentPlaybackQualityProvider();
  var currentSong = Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  var currentQuality = getProviderPlaybackQuality(provider);
  var runtimeCapQuality = playbackQualityCapValue(currentSong, provider);
  var effectiveQuality = effectivePlaybackQualityForSong(currentSong, provider, currentQuality);
  playbackQuality = currentQuality;
  var label = document.getElementById('quality-btn-label');
  var btn = document.getElementById('quality-btn');
  var list = document.getElementById('quality-option-list');
  var canUseSvip = provider === 'netease' && hasProviderSvip('netease', loginStatus);
  var displayQuality = provider === 'netease' && effectiveQuality === 'jymaster' && !canUseSvip ? 'hires' : effectiveQuality;
  if (label) label.textContent = playbackQualityShortLabel(displayQuality, provider);
  var qualityProviderTitle = provider === 'spotify' ? playbackOutputText('out_spotify_match_prefix') : (provider === 'qishui' ? playbackOutputText('out_qishui_quality_prefix') : (provider === 'qq' ? playbackOutputText('out_qq_quality_prefix') : (provider === 'kugou' ? playbackOutputText('out_kugou_quality_prefix') : playbackOutputText('out_netease_quality_prefix'))));
  if (btn) btn.title = qualityProviderTitle + playbackQualityLabel(displayQuality, provider) +
    (provider === 'netease' && currentQuality === 'jymaster' && !canUseSvip
      ? ' ' + playbackOutputText('svip_required', '· 超清母带需网易云 SVIP') : '');
  if (btn && runtimeCapQuality) btn.title += playbackOutputText('out_song_max_infix') + playbackQualityLabel(runtimeCapQuality, provider);
  if (list) {
    list.innerHTML = playbackQualityOptions(provider).map(function (item) {
      var capLocked = playbackQualityAboveCap(item.key, provider, runtimeCapQuality);
      var locked = !!(item.svip && !canUseSvip) || capLocked;
      return '<button class="quality-option' + (item.svip ? ' svip-only' : '') + (capLocked ? ' cap-locked' : '') + (locked ? ' locked' : '') + '" data-quality="' + item.key + '" data-svip="' + (item.svip ? '1' : '0') + '" ' + (locked ? 'disabled ' : '') + 'onclick="setPlaybackQuality(\'' + item.key + '\')"><span>' + escHtml(item.title) + '</span><small>' + escHtml(capLocked ? (playbackOutputText('out_current_max_prefix') + playbackQualityLabel(runtimeCapQuality, provider)) : item.sub) + '</small></button>';
    }).join('');
  }
  document.querySelectorAll('.quality-option').forEach(function (option) {
    var q = normalizePlaybackQualityForProvider(option.dataset.quality, provider);
    var capLocked = playbackQualityAboveCap(q, provider, runtimeCapQuality);
    var locked = (option.dataset.svip === '1' && !canUseSvip) || capLocked;
    option.classList.toggle('active', q === displayQuality);
    option.classList.toggle('locked', locked);
    option.classList.toggle('cap-locked', capLocked);
    option.disabled = locked;
    if (capLocked) option.title = playbackOutputText('out_song_max_prefix') + playbackQualityLabel(runtimeCapQuality, provider);
    option.title = locked ? playbackOutputText('out_need_svip') : playbackQualityLabel(q, provider);
  });
  if (runtimeCapQuality) {
    document.querySelectorAll('.quality-option.cap-locked').forEach(function (option) {
      option.title = playbackOutputText('out_song_max_prefix') + playbackQualityLabel(runtimeCapQuality, provider);
    });
  }
}
function setPlaybackQuality(value) {
  var provider = currentPlaybackQualityProvider();
  var currentSong = Array.isArray(playQueue) && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  var next = normalizePlaybackQualityForProvider(value, provider);
  var cap = playbackQualityCapValue(currentSong, provider);
  if (playbackQualityAboveCap(next, provider, cap)) {
    showSourceFallbackNotice(playbackOutputText('out_quality_locked'), playbackOutputText('out_song_max_playable_prefix') + playbackQualityLabel(cap, provider) + playbackOutputText('out_higher_disabled_suffix'));
    updatePlaybackQualityUi();
    return;
  }
  if (provider === 'netease' && next === 'jymaster' && !hasProviderSvip('netease', loginStatus)) {
    showToast(hasPlatformLogin('netease') ? playbackOutputText('quality_jymaster_need_svip', '超清母带需要网易云 SVIP') : playbackOutputText('quality_login_netease_svip', '登录网易云 SVIP 后可用超清母带'));
    if (!hasPlatformLogin('netease')) openProviderLogin('netease');
    return;
  }
  setProviderPlaybackQuality(provider, next);
  updatePlaybackQualityUi();
  var wrap = document.getElementById('quality-control');
  if (wrap) wrap.classList.remove('open');
  applyPlaybackQualityToCurrentTrack(next, provider);
}
function canReloadCurrentTrackForQuality() {
  if (currentIdx < 0 || currentIdx >= playQueue.length) return false;
  if (!audio || !audio.src || audio.paused || audio.ended) return false;
  var song = playQueue[currentIdx];
  if (!song || song.type === 'local' || song.source === 'local') return false;
  return songProviderKey(song) === 'netease' || songProviderKey(song) === 'qq' || songProviderKey(song) === 'kugou';
}
function applyPlaybackQualityToCurrentTrack(nextQuality, provider) {
  var song = currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  provider = normalizePlaybackProvider(provider || songProviderKey(song));
  var label = playbackQualityLabel(nextQuality || getProviderPlaybackQuality(provider), provider);
  if (!canReloadCurrentTrackForQuality()) {
    showToast(playbackOutputText('out_quality_preference_prefix') + label + playbackOutputText('out_next_playback_suffix'));
    return;
  }
  var resumeAt = audio && isFinite(audio.currentTime) ? audio.currentTime : 0;
  showToast(playbackOutputText('out_switching_quality_prefix') + label);
  Promise.resolve(playQueueAt(currentIdx, {
    qualityOverride: nextQuality || getProviderPlaybackQuality(provider),
    qualitySwitch: true,
    resumeAt: resumeAt,
    preserveHomeState: true,
  })).catch(function (e) {
    console.warn('[QualitySwitch]', e);
    showToast(playbackOutputText('out_quality_switch_failed'));
  }).finally(forcePlaybackControlsInteractive);
}
function toggleQualityPanel(e) {
  if (e) e.stopPropagation();
  var wrap = document.getElementById('quality-control');
  if (wrap) {
    wrap.classList.toggle('open');
  }
}
function bindQualityControl() {
  var wrap = document.getElementById('quality-control');
  if (wrap) {
    wrap.addEventListener('mouseenter', function () { wrap.classList.add('open'); });
    wrap.addEventListener('mouseleave', function () { setTimeout(function () { if (!wrap.matches(':hover')) wrap.classList.remove('open'); }, 260); });
  }
  document.addEventListener('click', function (e) {
    if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
  });
  updatePlaybackQualityUi();
}
var audioRouteWorkflowDrag = null;
function audioRoutePointForPort(port, root) {
  if (!port || !root) return null;
  var portRect = port.getBoundingClientRect();
  var rootRect = root.getBoundingClientRect();
  return {
    x: portRect.left + portRect.width / 2 - rootRect.left,
    y: portRect.top + portRect.height / 2 - rootRect.top
  };
}
function audioRoutePointFromEvent(e, root) {
  if (!e || !root) return null;
  var rootRect = root.getBoundingClientRect();
  return { x: e.clientX - rootRect.left, y: e.clientY - rootRect.top };
}
function audioRouteBezierPath(a, b) {
  var dx = Math.max(42, Math.abs(b.x - a.x) * 0.42);
  return 'M ' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) +
    ' C ' + (a.x + dx).toFixed(1) + ' ' + a.y.toFixed(1) +
    ', ' + (b.x - dx).toFixed(1) + ' ' + b.y.toFixed(1) +
    ', ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1);
}
function appendAudioRoutePath(svg, from, to, className) {
  if (!svg || !from || !to) return;
  var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', audioRouteBezierPath(from, to));
  path.setAttribute('class', className || 'workflow-link');
  svg.appendChild(path);
}
function audioRoutePortByAttr(root, attr, value) {
  var ports = root ? root.querySelectorAll('.flow-port.in[' + attr + ']') : [];
  value = String(value || '');
  for (var i = 0; i < ports.length; i += 1) {
    if (String(ports[i].getAttribute(attr) || '') === value) return ports[i];
  }
  return null;
}
function renderAudioRouteWorkflowEdgesForRoot(root, tempPoint) {
  if (!root) return;
  var svg = root.querySelector('#audio-route-workflow-svg');
  if (!svg) return;
  svg.setAttribute('viewBox', '0 0 ' + Math.max(1, root.clientWidth || 1) + ' ' + Math.max(1, root.clientHeight || 1));
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var sourceOut = root.querySelector('[data-audio-route-source="player"]');
  var sourcePoint = audioRoutePointForPort(sourceOut, root);
  var primaryPort = audioRoutePortByAttr(root, 'data-output-primary-target', audioOutputDeviceId || '');
  appendAudioRoutePath(svg, sourcePoint, audioRoutePointForPort(primaryPort, root), 'workflow-link active primary');
  normalizeAudioOutputIdList(audioOutputMirrorDeviceIds).forEach(function (id) {
    if (!id || id === (audioOutputDeviceId || '')) return;
    appendAudioRoutePath(svg, sourcePoint, audioRoutePointForPort(audioRoutePortByAttr(root, 'data-output-mirror-target', id), root), audioOutputMirrorRouteClass(id));
  });
  if (audioInputBridgeState && audioInputBridgeState.enabled && audioInputBridgeState.deviceId) {
    appendAudioRoutePath(svg, sourcePoint, audioRoutePointForPort(audioRoutePortByAttr(root, 'data-input-bridge-target', audioInputBridgeState.deviceId), root), 'workflow-link active bridge');
  }
  if (audioRouteWorkflowDrag && audioRouteWorkflowDrag.root === root && tempPoint) {
    appendAudioRoutePath(svg, audioRoutePointForPort(audioRouteWorkflowDrag.port, root), tempPoint, 'workflow-link temp');
  }
}
function renderAudioRouteWorkflowEdges(tempPoint) {
  var roots = document.querySelectorAll('.audio-route-graph');
  Array.prototype.forEach.call(roots, function (root) {
    renderAudioRouteWorkflowEdgesForRoot(root, tempPoint);
  });
}
function finishAudioRouteWorkflowDrag(e) {
  if (!audioRouteWorkflowDrag) return;
  var root = audioRouteWorkflowDrag.root;
  var target = document.elementFromPoint(e.clientX, e.clientY);
  var port = target && target.closest ? target.closest('.flow-port.in') : null;
  if (root && port && root.contains(port)) {
    if (port.hasAttribute('data-output-primary-target')) {
      setAudioOutputDevice(port.getAttribute('data-output-primary-target') || '', true);
    } else if (port.hasAttribute('data-output-mirror-target')) {
      toggleAudioOutputMirrorDevice(port.getAttribute('data-output-mirror-target') || '');
    } else if (port.hasAttribute('data-input-bridge-target')) {
      setAudioInputBridgeDevice(port.getAttribute('data-input-bridge-target') || '', true);
    }
  }
  if (root) root.classList.remove('dragging-line');
  audioRouteWorkflowDrag = null;
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { }
  requestAnimationFrame(renderAudioRouteWorkflowEdges);
}
function bindAudioRouteWorkflowPointerEvents(outputList) {
  if (!outputList || outputList._routeWorkflowBound) return;
  outputList._routeWorkflowBound = true;
  outputList.addEventListener('pointerdown', function (e) {
    var port = e.target && e.target.closest ? e.target.closest('.flow-port.out[data-audio-route-source]') : null;
    if (!port || !outputList.contains(port)) return;
    var root = port.closest('.audio-route-graph');
    audioRouteWorkflowDrag = { root: root, port: port };
    if (root) root.classList.add('dragging-line');
    try { outputList.setPointerCapture(e.pointerId); } catch (_) { }
    e.preventDefault();
    e.stopPropagation();
    renderAudioRouteWorkflowEdges(root ? audioRoutePointFromEvent(e, root) : null);
  });
  outputList.addEventListener('pointermove', function (e) {
    if (!audioRouteWorkflowDrag || !audioRouteWorkflowDrag.root) return;
    e.preventDefault();
    renderAudioRouteWorkflowEdges(audioRoutePointFromEvent(e, audioRouteWorkflowDrag.root));
  });
  outputList.addEventListener('pointerup', finishAudioRouteWorkflowDrag);
  outputList.addEventListener('pointercancel', function (e) {
    if (audioRouteWorkflowDrag && audioRouteWorkflowDrag.root) audioRouteWorkflowDrag.root.classList.remove('dragging-line');
    audioRouteWorkflowDrag = null;
    try { outputList.releasePointerCapture(e.pointerId); } catch (_) { }
    renderAudioRouteWorkflowEdges();
  });
  if (!bindAudioRouteWorkflowPointerEvents._resizeBound) {
    bindAudioRouteWorkflowPointerEvents._resizeBound = true;
    window.addEventListener('resize', function () { requestAnimationFrame(renderAudioRouteWorkflowEdges); });
    window.addEventListener('orientationchange', function () { requestAnimationFrame(renderAudioRouteWorkflowEdges); });
  }
}
function bindAudioRouteSelectionEvents(container) {
  if (container && !container._audioRouteSelectBound) {
    container._audioRouteSelectBound = true;
    container.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-output-primary],[data-output-mirror],[data-input-bridge]') : null;
      if (!btn || !container.contains(btn)) return;
      if (btn.hasAttribute('data-output-primary')) {
        setAudioOutputDevice(btn.getAttribute('data-output-primary') || '', true);
        return;
      }
      if (btn.hasAttribute('data-output-mirror')) {
        toggleAudioOutputMirrorDevice(btn.getAttribute('data-output-mirror') || '');
        return;
      }
      if (btn.hasAttribute('data-input-bridge')) {
        setAudioInputBridgeDevice(btn.getAttribute('data-input-bridge') || '', true);
      }
    });
  }
}
function bindAudioOutputControls() {
  var outputList = document.getElementById('audio-output-list');
  var workflowBody = document.getElementById('audio-output-workflow-body');
  bindAudioRouteSelectionEvents(outputList);
  bindAudioRouteSelectionEvents(workflowBody);
  bindAudioRouteWorkflowPointerEvents(outputList);
  bindAudioRouteWorkflowPointerEvents(workflowBody);
  renderAudioOutputDeviceUi();
  bindAudioOutputDeviceRevealHook();
}

// 启动阶段只装一个"界面首次可见"的触发器，不在这里枚举设备。
// 原因见 ensureAudioOutputDevicesLoaded 的说明。
// Boot only arms a first-reveal trigger; it does not enumerate here. See
// ensureAudioOutputDevicesLoaded for why.
function bindAudioOutputDeviceRevealHook() {
  var panel = document.getElementById('audio-output-panel');
  if (!panel || panel._mineradioDeviceRevealBound) return;
  panel._mineradioDeviceRevealBound = true;
  var onEnter = function () {
    panel.removeEventListener('pointerenter', onEnter);
    ensureAudioOutputDevicesLoaded();
  };
  panel.addEventListener('pointerenter', onEnter);
  if (typeof IntersectionObserver !== 'function') return;
  // 面板可能一开始在未激活的分区里（display:none），所以用可见性而不是"文档已加载"来触发。
  // The panel often starts inside an inactive section, hence a visibility trigger rather than
  // a document-ready one.
  var observer = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].isIntersecting) continue;
      observer.disconnect();
      ensureAudioOutputDevicesLoaded();
      return;
    }
  });
  observer.observe(panel);
}
function readAudioOutputDevicePreference() {
  try { return localStorage.getItem(AUDIO_OUTPUT_DEVICE_STORE_KEY) || ''; } catch (e) { return ''; }
}
function saveAudioOutputDevicePreference() {
  try { localStorage.setItem(AUDIO_OUTPUT_DEVICE_STORE_KEY, audioOutputDeviceId || ''); } catch (e) { }
}
function normalizeAudioOutputIdList(list) {
  var seen = {};
  return (Array.isArray(list) ? list : []).map(function (id) { return String(id || '').trim(); }).filter(function (id) {
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  }).slice(0, 4);
}
function readAudioOutputMirrorPreference() {
  try {
    return normalizeAudioOutputIdList(JSON.parse(localStorage.getItem(AUDIO_OUTPUT_MIRROR_STORE_KEY) || '[]'));
  } catch (e) { return []; }
}
function saveAudioOutputMirrorPreference() {
  try { localStorage.setItem(AUDIO_OUTPUT_MIRROR_STORE_KEY, JSON.stringify(normalizeAudioOutputIdList(audioOutputMirrorDeviceIds))); } catch (e) { }
}
function audioOutputMirrorSinkSupported() {
  return typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype && typeof HTMLMediaElement.prototype.setSinkId === 'function';
}
function audioOutputMirrorReadableError(e) {
  var name = e && e.name ? String(e.name) : '';
  if (name === 'NotAllowedError') return playbackOutputText('out_no_output_permission');
  if (name === 'NotFoundError') return playbackOutputText('out_device_unavailable');
  if (name === 'AbortError') return playbackOutputText('out_switch_failed');
  if (name === 'NotSupportedError') return playbackOutputText('out_kernel_unsupported');
  return playbackOutputText('out_play_failed');
}
function markAudioOutputMirrorRuntime(id, state, message) {
  id = String(id || '');
  if (!id) return;
  if (!audioOutputMirrorRuntime) audioOutputMirrorRuntime = {};
  var prev = audioOutputMirrorRuntime[id] || {};
  message = String(message || '');
  if (prev.state === state && prev.message === message) return;
  audioOutputMirrorRuntime[id] = { state: state, message: message, at: Date.now() };
  if (markAudioOutputMirrorRuntime.renderPending) return;
  markAudioOutputMirrorRuntime.renderPending = true;
  var schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
  schedule(function () {
    markAudioOutputMirrorRuntime.renderPending = false;
    renderAudioOutputDeviceUi();
    renderAudioRouteWorkflowEdges();
  });
}
function audioOutputMirrorRuntimeFor(id) {
  id = String(id || '');
  return audioOutputMirrorRuntime && audioOutputMirrorRuntime[id] || null;
}
function audioOutputMirrorConfirmedCount(ids) {
  return normalizeAudioOutputIdList(ids).filter(function (id) {
    var rt = audioOutputMirrorRuntimeFor(id);
    return rt && rt.state === 'playing';
  }).length;
}
function audioOutputMirrorRouteClass(id) {
  var rt = audioOutputMirrorRuntimeFor(id);
  if (rt && rt.state === 'playing') return 'workflow-link active mirror';
  return 'workflow-link pending mirror';
}
function audioOutputMirrorStatusText(id, active, disabled) {
  if (disabled) return playbackOutputText('out_primary_cannot_mirror');
  if (!active) return playbackOutputText('out_mirror_experimental');
  if (!audioOutputMirrorSinkSupported()) return playbackOutputText('out_kernel_no_mirror_2');
  var src = audio && (audio.currentSrc || audio.src || '');
  if (!audio || !src) return playbackOutputText('out_try_mirror_on_playback');
  var rt = audioOutputMirrorRuntimeFor(id);
  if (!rt) return playbackOutputText('out_mirror_pending');
  if (rt.state === 'playing') return playbackOutputText('out_mirror_confirmed');
  if (rt.state === 'paused') return playbackOutputText('out_pause_with_player');
  if (rt.state === 'sink-ready') return playbackOutputText('out_device_selected_wait');
  if (rt.state === 'sink-pending' || rt.state === 'play-pending') return playbackOutputText('out_trying_mirror_2');
  if (rt.state === 'waiting') return playbackOutputText('out_try_mirror_on_playback');
  if (rt.state === 'sink-error' || rt.state === 'play-error' || rt.state === 'unsupported') return playbackOutputText('out_mirror_failed_prefix') + (rt.message || playbackOutputText('out_switch_please'));
  return playbackOutputText('out_mirror_pending');
}
function readAudioInputBridgePreference() {
  try {
    var parsed = JSON.parse(localStorage.getItem(AUDIO_INPUT_BRIDGE_STORE_KEY) || '{}');
    return { enabled: !!parsed.enabled, deviceId: String(parsed.deviceId || '') };
  } catch (e) {
    return { enabled: false, deviceId: '' };
  }
}
function saveAudioInputBridgePreference() {
  try { localStorage.setItem(AUDIO_INPUT_BRIDGE_STORE_KEY, JSON.stringify(audioInputBridgeState || { enabled: false, deviceId: '' })); } catch (e) { }
}
function audioOutputDeviceById(deviceId) {
  deviceId = String(deviceId || '');
  return (audioOutputDevices || []).filter(function (device) { return device && device.deviceId === deviceId; })[0] || null;
}
function isVirtualMicOutputDevice(device) {
  var label = String(device && device.label || '').toLowerCase();
  return /cable input|vb-audio|voicemeeter|virtual|loopback|blackhole|sonar|stereo mix|立体声混音|虚拟|线缆/.test(label);
}
function recommendedAudioInputBridgeDeviceId() {
  var selected = audioInputBridgeState && audioInputBridgeState.deviceId;
  if (selected && audioOutputDeviceById(selected)) return selected;
  var virtual = (audioOutputDevices || []).filter(isVirtualMicOutputDevice)[0];
  return virtual && virtual.deviceId || '';
}
function audioInputDeviceLabel(device, index) {
  if (!device || !device.deviceId) return playbackOutputText('out_input_device');
  return device.label || (playbackOutputText('out_input_device_prefix') + (index + 1));
}
function audioOutputDeviceStatusText() {
  if (audioInputBridgeState && audioInputBridgeState.enabled) {
    var bridgeDevice = audioOutputDeviceById(audioInputBridgeState.deviceId);
    return bridgeDevice ? (playbackOutputText('out_bridged_to_prefix') + audioOutputDeviceLabel(bridgeDevice, 0)) : playbackOutputText('out_bridge_waiting');
  }
  if (audioOutputDeviceId) {
    var primary = audioOutputDeviceById(audioOutputDeviceId);
    return primary ? (playbackOutputText('out_current_output_prefix') + audioOutputDeviceLabel(primary, 0)) : playbackOutputText('out_current_pending_restore');
  }
  return playbackOutputText('out_current_default');
}
function audioOutputDeviceLabel(device, index) {
  if (!device || !device.deviceId) return playbackOutputText('out_system_default');
  return device.label || (playbackOutputText('out_output_device_prefix') + (index + 1));
}
function renderAudioOutputDeviceUi() {
  var list = document.getElementById('audio-output-list');
  if (!list) return;
  var outputs = [{ deviceId: '', label: playbackOutputText('out_system_default') }].concat(audioOutputDevices || []);
  var bridgeId = recommendedAudioInputBridgeDeviceId();
  var bridgeEnabled = !!(audioInputBridgeState && audioInputBridgeState.enabled);
  var mirrorIds = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds);
  var outputItems = outputs.map(function (device, index) {
    return {
      device: device,
      index: index,
      id: device && device.deviceId ? String(device.deviceId) : '',
      label: audioOutputDeviceLabel(device, index)
    };
  });
  function sortedRouteItems(items, rank) {
    return items.slice().sort(function (a, b) {
      var ra = rank(a);
      var rb = rank(b);
      if (ra !== rb) return ra - rb;
      return String(a.label || '').localeCompare(String(b.label || ''), 'zh-Hans-CN');
    });
  }
  var primaryItems = sortedRouteItems(outputItems, function (item) {
    if (item.id === (audioOutputDeviceId || '')) return 0;
    if (!item.id) return 1;
    return 2;
  });
  var mirrorItems = sortedRouteItems(outputItems.filter(function (item) { return !!item.id; }), function (item) {
    if (mirrorIds.indexOf(item.id) >= 0 && item.id !== (audioOutputDeviceId || '')) return 0;
    if (isVirtualMicOutputDevice(item.device)) return 1;
    if (item.id === (audioOutputDeviceId || '')) return 3;
    return 2;
  });
  var primaryHtml = primaryItems.map(function (item) {
    var device = item.device;
    var index = item.index;
    var id = device && device.deviceId ? String(device.deviceId) : '';
    var active = id === (audioOutputDeviceId || '');
    var virtualClass = device && device.deviceId && isVirtualMicOutputDevice(device) ? ' virtual' : '';
    return '<button class="audio-route-node output workflow-node' + virtualClass + (active ? ' active connected' : '') + '" type="button" data-output-primary="' + escHtml(id) + '" title="' + escHtml(audioOutputDeviceLabel(device, index)) + '">' +
      '<span class="flow-port in" data-output-primary-target="' + escHtml(id) + playbackOutputText('out_primary_node_html') + (id ? 'OUT' : 'SYS') + '</span><span class="route-node-text"><b>' + escHtml(audioOutputDeviceLabel(device, index)) + '</b><small>' + (active ? playbackOutputText('out_primary_connected') : playbackOutputText('out_drag_connect_primary')) + '</small></span>' +
      '<span class="route-node-pulse"></span></button>';
  }).join('');
  var mirrorHtml = mirrorItems.map(function (item) {
    var device = item.device;
    var index = item.index;
    var id = String(device.deviceId || '');
    var disabled = id === (audioOutputDeviceId || '');
    var active = mirrorIds.indexOf(id) >= 0 && !disabled;
    var rt = audioOutputMirrorRuntimeFor(id);
    var pendingClass = active && (!rt || rt.state !== 'playing') ? ' pending' : '';
    var warningClass = active && rt && (rt.state === 'sink-error' || rt.state === 'play-error' || rt.state === 'unsupported') ? ' warning' : '';
    return '<button class="audio-route-node mirror workflow-node' + (active ? ' active connected' : '') + pendingClass + warningClass + (disabled ? ' disabled' : '') + '" type="button" data-output-mirror="' + escHtml(id) + '" title="' + escHtml(audioOutputDeviceLabel(device, index)) + '">' +
      '<span class="flow-port in" data-output-mirror-target="' + escHtml(id) + playbackOutputText('out_mirror_node_html') + escHtml(audioOutputDeviceLabel(device, index)) + '</b><small>' + escHtml(audioOutputMirrorStatusText(id, active, disabled)) + '</small></span>' +
      '<span class="route-node-pulse"></span></button>';
  }).join('');
  var bridgeDevice = bridgeId ? audioOutputDeviceById(bridgeId) : null;
  var bridgeLabel = bridgeDevice ? audioOutputDeviceLabel(bridgeDevice, 0) : playbackOutputText('out_no_vbcable');
  var inputHint = (audioInputDevices || []).slice(0, 2).map(function (device, index) { return audioInputDeviceLabel(device, index); }).join(' / ');
  var activePrimary = audioOutputDeviceId ? audioOutputDeviceById(audioOutputDeviceId) : null;
  var summaryText = audioOutputDeviceStatusText();
  var mirrorCount = mirrorIds.filter(function (id) { return id && id !== (audioOutputDeviceId || ''); }).length;
  var mirrorConfirmedCount = audioOutputMirrorConfirmedCount(mirrorIds);
  var mirrorStateLabel = mirrorCount ? (mirrorConfirmedCount ? (playbackOutputText('output_mirror_confirmed', '已确认 {confirmed}/{total}', { confirmed: mirrorConfirmedCount, total: mirrorCount })) : (playbackOutputText('output_mirror_pending', '待确认 {count} 路', { count: mirrorCount }))) : playbackOutputText('feature_state_off', '关闭');
  var workflowHtml =
    '<div class="audio-route-graph' + (bridgeEnabled ? ' bridge-on' : '') + '">' +
      '<svg id="audio-route-workflow-svg" class="workflow-link-layer audio-link-layer" aria-hidden="true"></svg>' +
      '<div class="audio-flow-source workflow-node" data-audio-node="player">' +
        '<span class="route-node-kicker">SOURCE</span><span class="route-node-icon">MR</span><span class="route-node-text"><b>Mineradio Player</b><small>' + escHtml(summaryText) + playbackOutputText('out_source_meter_html') +
      '</div>' +
      '<div class="audio-route-status"><span class="route-energy-dot"></span><b>Patch Bay</b><small>' + escHtml(audioOutputDeviceId ? playbackOutputText('out_primary_assigned') : playbackOutputText('out_primary_follows_default')) + '</small></div>' +
      '<div class="audio-route-board">' +
        '<div class="audio-route-board-head">' +
          playbackOutputText('out_route_board_title_html') +
          playbackOutputText('out_primary_chip_prefix') + escHtml(activePrimary ? audioOutputDeviceLabel(activePrimary, 0) : playbackOutputText('out_system_default')) + '</span>' +
          playbackOutputText('out_mirror_chip_prefix') + escHtml(mirrorStateLabel) + '</span>' +
          '<span class="audio-route-chip' + (bridgeEnabled ? ' active' : '') + playbackOutputText('out_vm_chip_prefix') + (bridgeEnabled ? playbackOutputText('out_connected') : playbackOutputText('out_not_connected')) + '</span></span>' +
        '</div>' +
        '<div class="audio-route-lanes">' +
          playbackOutputText('out_primary_lane_head_html') + escHtml(activePrimary ? playbackOutputText('out_assigned') : playbackOutputText('out_system_default')) + '</em></div><div class="route-node-grid">' + primaryHtml + '</div></div>' +
          playbackOutputText('out_mirror_lane_head_html') + escHtml(mirrorStateLabel) + '</em></div><div class="route-node-grid mirror-grid">' + (mirrorHtml || playbackOutputText('out_no_mirror_device_html')) + playbackOutputText('out_route_note_html') +
          playbackOutputText('out_vm_lane_head_html') + escHtml(inputHint || playbackOutputText('out_game_receive_hint')) + '</small></span><em class="route-lane-state">' + escHtml(bridgeEnabled ? playbackOutputText('out_bridged') : playbackOutputText('out_not_connected')) + '</em></div>' +
            '<div class="route-node-grid bridge-grid"><button class="audio-route-node bridge workflow-node' + (bridgeEnabled ? ' active connected' : '') + (!bridgeId ? ' disabled' : '') + '" type="button" data-input-bridge="' + escHtml(bridgeId) + '">' +
              '<span class="flow-port in" data-input-bridge-target="' + escHtml(bridgeId) + playbackOutputText('out_vm_input_node_html') + escHtml(bridgeLabel) + '</b><small>' + escHtml(bridgeEnabled ? playbackOutputText('out_sent_to_virtual') : (bridgeId ? playbackOutputText('out_can_join_virtual') : playbackOutputText('out_need_virtual_cable'))) + '</small></span><span class="route-node-pulse"></span>' +
            '</button></div>' +
            '<div class="audio-route-note">' + escHtml(inputHint ? (playbackOutputText('out_input_prefix') + inputHint) : playbackOutputText('out_real_mic_hint')) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  var workflowSubtitle = document.getElementById('audio-output-workflow-subtitle');
  if (workflowSubtitle) workflowSubtitle.textContent = summaryText;
  list.innerHTML =
    '<button class="audio-output-summary-card" type="button" onclick="openAudioOutputWorkflowPanel()">' +
      '<span class="route-node-icon">MR</span>' +
      '<span class="audio-output-summary-copy"><b>' + escHtml(summaryText) + '</b><small>' +
        escHtml((activePrimary ? playbackOutputText('output_primary_assigned', '主输出已指定') : playbackOutputText('output_primary_system_default', '主输出使用系统默认')) + ' / ' + playbackOutputText('output_mirror_label', '镜像监听') + ' ' + mirrorStateLabel + ' / ' + playbackOutputText('output_bridge_label', '桥接') + ' ' + (bridgeEnabled ? playbackOutputText('feature_state_on', '开启') : playbackOutputText('feature_state_off', '关闭'))) +
      '</small></span>' +
      '<span class="audio-output-summary-action">' + playbackOutputText('output_route_label', '路由') + '</span>' +
    '</button>';
  var workflowBody = document.getElementById('audio-output-workflow-body');
  if (workflowBody) workflowBody.innerHTML = workflowHtml;
  requestAnimationFrame(function () { renderAudioRouteWorkflowEdges(); });
}
function openAudioOutputWorkflowPanel() {
  var modal = document.getElementById('audio-output-workflow-modal');
  if (!modal) return;
  openGsapModal(modal);
  bindAudioOutputControls();
  renderAudioOutputDeviceUi();
  requestAnimationFrame(function () {
    renderAudioRouteWorkflowEdges();
    setTimeout(renderAudioRouteWorkflowEdges, 80);
  });
  ensureAudioOutputDevicesLoaded();
}
function closeAudioOutputWorkflowPanel() {
  closeGsapModal(document.getElementById('audio-output-workflow-modal'));
}
// 启动时不枚举媒体设备。enumerateDevices() 会让 Chromium 启动 audio+video 设备监视，
// 视频侧会因此拉起 Video Capture Service 进程 —— 实测常驻约 116MB，而本应用在默认配置下
// 根本不使用摄像头。这份列表只被输出设备界面读取（见 renderAudioOutputDeviceUi），
// 因此推迟到界面首次可见时再枚举。设备热插拔监听同理一并推迟。
// Do not enumerate media devices at boot. enumerateDevices() makes Chromium start audio+video
// device monitoring, and the video side spawns the Video Capture Service (~116MB resident)
// while this app never uses a camera in its default configuration. The list is only consumed by
// the output-device UI, so enumeration (and the hot-plug listener) wait for first reveal.
function ensureAudioOutputDevicesLoaded() {
  if (audioOutputDevicesLoaded) return;
  audioOutputDevicesLoaded = true;
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener && !audioOutputDeviceChangeBound) {
    audioOutputDeviceChangeBound = true;
    navigator.mediaDevices.addEventListener('devicechange', function () { refreshAudioOutputDevices(false); });
  }
  refreshAudioOutputDevices(false);
}
async function refreshAudioOutputDevices(showNotice) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    audioOutputDevices = [];
    audioInputDevices = [];
    renderAudioOutputDeviceUi();
    if (showNotice) showToast(playbackOutputText('out_selection_unsupported'));
    return;
  }
  try {
    var devices = await navigator.mediaDevices.enumerateDevices();
    audioOutputDevices = devices.filter(function (device) { return device && device.kind === 'audiooutput' && device.deviceId !== 'default'; });
    audioInputDevices = devices.filter(function (device) { return device && device.kind === 'audioinput' && device.deviceId !== 'default'; });
    if (audioInputBridgeState && audioInputBridgeState.enabled && audioInputBridgeState.deviceId && !audioOutputDeviceById(audioInputBridgeState.deviceId)) {
      audioInputBridgeState.enabled = false;
      saveAudioInputBridgePreference();
    }
    renderAudioOutputDeviceUi();
    if (showNotice) showToast(playbackOutputText('out_refreshed'));
  } catch (e) {
    audioOutputDevices = [];
    audioInputDevices = [];
    renderAudioOutputDeviceUi();
    if (showNotice) showToast(playbackOutputText('out_read_failed'));
  }
}
function bindAudioOutputMirrorEvents(media) {
  if (!media || media._mineradioAudioMirrorBound) return;
  media._mineradioAudioMirrorBound = true;
  ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'volumechange', 'emptied'].forEach(function (name) {
    media.addEventListener(name, function () { syncAudioOutputMirrors(name); });
  });
}
function removeAudioOutputMirror(id) {
  var mirror = audioOutputMirrorElements && audioOutputMirrorElements[id];
  if (mirror) {
    try { mirror.pause(); } catch (e) { }
    try { mirror.removeAttribute('src'); mirror.load(); } catch (e) { }
    delete audioOutputMirrorElements[id];
  }
  if (audioOutputMirrorRuntime && id) delete audioOutputMirrorRuntime[id];
}
function clearAudioOutputMirrors() {
  Object.keys(audioOutputMirrorElements || {}).forEach(removeAudioOutputMirror);
  if (audioOutputMirrorSyncTimer) {
    clearInterval(audioOutputMirrorSyncTimer);
    audioOutputMirrorSyncTimer = 0;
  }
}
async function applyAudioOutputMirrorSink(mirror, sinkId) {
  if (!mirror || typeof mirror.setSinkId !== 'function') {
    markAudioOutputMirrorRuntime(sinkId, 'unsupported', playbackOutputText('out_kernel_unsupported'));
    return false;
  }
  try {
    markAudioOutputMirrorRuntime(sinkId, 'sink-pending', playbackOutputText('out_selecting_device'));
    await mirror.setSinkId(sinkId);
    markAudioOutputMirrorRuntime(sinkId, 'sink-ready', playbackOutputText('out_device_selected'));
    return true;
  } catch (e) {
    markAudioOutputMirrorRuntime(sinkId, 'sink-error', audioOutputMirrorReadableError(e));
    console.warn('[AudioOutputMirror]', e);
    return false;
  }
}
function syncAudioOutputMirrors(reason) {
  var ids = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds).filter(function (id) { return id && id !== (audioOutputDeviceId || ''); });
  var src = audio && (audio.currentSrc || audio.src || '');
  Object.keys(audioOutputMirrorRuntime || {}).forEach(function (id) {
    if (ids.indexOf(id) < 0) delete audioOutputMirrorRuntime[id];
  });
  if (!ids.length) {
    clearAudioOutputMirrors();
    return;
  }
  if (!audioOutputMirrorSinkSupported()) {
    clearAudioOutputMirrors();
    ids.forEach(function (id) { markAudioOutputMirrorRuntime(id, 'unsupported', playbackOutputText('out_kernel_unsupported')); });
    return;
  }
  if (!audio || !src) {
    clearAudioOutputMirrors();
    ids.forEach(function (id) { markAudioOutputMirrorRuntime(id, 'waiting', playbackOutputText('out_try_on_playback')); });
    return;
  }
  Object.keys(audioOutputMirrorElements || {}).forEach(function (id) {
    if (ids.indexOf(id) < 0) removeAudioOutputMirror(id);
  });
  ids.forEach(function (id) {
    var mirror = audioOutputMirrorElements[id];
    if (!mirror) {
      mirror = new Audio();
      mirror.crossOrigin = 'anonymous';
      mirror.preload = 'auto';
      mirror.muted = !!audio.muted;
      mirror.volume = audio.volume;
      mirror.playbackRate = audio.playbackRate || 1;
      audioOutputMirrorElements[id] = mirror;
    }
    if (mirror._mineradioSinkId !== id || !mirror._mineradioSinkReady) {
      mirror._mineradioSinkId = id;
      if (!mirror._mineradioSinkBusy) {
        mirror._mineradioSinkBusy = true;
        Promise.resolve(applyAudioOutputMirrorSink(mirror, id)).then(function (ok) {
          mirror._mineradioSinkBusy = false;
          mirror._mineradioSinkReady = !!ok;
          if (ok) syncAudioOutputMirrors('mirror-sink-ready');
        });
      }
    }
    if ((mirror.currentSrc || mirror.src || '') !== src) {
      try { mirror.src = src; mirror.load(); } catch (e) { }
    }
    try { mirror.muted = !!audio.muted; mirror.volume = audio.volume; mirror.playbackRate = audio.playbackRate || 1; } catch (e) { }
    try {
      if (isFinite(audio.currentTime) && Math.abs((mirror.currentTime || 0) - audio.currentTime) > 0.22) {
        mirror.currentTime = audio.currentTime;
      }
    } catch (e) { }
    if (!mirror._mineradioSinkReady) return;
    if (audio.paused || audio.ended) {
      try { mirror.pause(); } catch (e) { }
      markAudioOutputMirrorRuntime(id, 'paused', playbackOutputText('out_pause_with_player'));
    } else {
      var rt = audioOutputMirrorRuntimeFor(id);
      if (!rt || rt.state !== 'playing') markAudioOutputMirrorRuntime(id, 'play-pending', playbackOutputText('now_playing', '正在播放'));
      var p = mirror.play();
      if (p && p.then) {
        p.then(function () {
          markAudioOutputMirrorRuntime(id, 'playing', playbackOutputText('out_confirmed'));
        }).catch(function (e) {
          markAudioOutputMirrorRuntime(id, 'play-error', audioOutputMirrorReadableError(e));
          console.warn('[AudioOutputMirror] play failed:', e);
        });
      } else {
        markAudioOutputMirrorRuntime(id, 'playing', playbackOutputText('out_confirmed'));
      }
    }
  });
  if (!audioOutputMirrorSyncTimer) {
    audioOutputMirrorSyncTimer = setInterval(function () { syncAudioOutputMirrors('clock'); }, 2200);
  }
}
async function applyAudioOutputDevice(media) {
  var sinkId = audioOutputDeviceId || '';
  var hasTarget = !!(media || audioCtx || uiSfxCtx);
  var mediaResult = null;
  var contextResult = null;
  var sfxResult = null;
  var errors = [];
  async function applySink(target, label) {
    if (!target) return null;
    if (typeof target.setSinkId !== 'function') return false;
    try {
      await target.setSinkId(sinkId);
      return true;
    } catch (e) {
      errors.push({ label: label, error: e });
      return false;
    }
  }
  bindAudioOutputMirrorEvents(media);
  mediaResult = await applySink(media, 'audio');
  contextResult = await applySink(audioCtx, 'audio-context');
  sfxResult = await applySink(uiSfxCtx, 'ui-sfx');
  var webAudioRouteActive = !!(audioReady && audioCtx && gainNode);
  var ok = webAudioRouteActive ? contextResult === true : (mediaResult === true || contextResult === true);
  if (sfxResult === true && !webAudioRouteActive && !media) ok = true;
  syncAudioOutputMirrors('apply-device');
  if (ok) {
    renderAudioOutputDeviceUi();
    return true;
  }
  if (!hasTarget) {
    renderAudioOutputDeviceUi();
    return null;
  }
  if (errors.length) {
    console.warn('[AudioOutput]', errors);
    if (errors.some(function (item) { return item.error && item.error.name === 'NotFoundError'; })) {
      audioOutputDeviceId = '';
      saveAudioOutputDevicePreference();
    }
  }
  renderAudioOutputDeviceUi();
  return false;
}
function setAudioOutputDevice(deviceId, showNotice) {
  audioOutputDeviceId = String(deviceId || '');
  var requestedDeviceId = audioOutputDeviceId;
  if (!requestedDeviceId || requestedDeviceId !== (audioInputBridgeState && audioInputBridgeState.deviceId || '')) {
    if (audioInputBridgeState && audioInputBridgeState.enabled) {
      audioInputBridgeState.enabled = false;
      saveAudioInputBridgePreference();
    }
  }
  audioOutputMirrorDeviceIds = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds).filter(function (id) { return id !== requestedDeviceId; });
  saveAudioOutputMirrorPreference();
  saveAudioOutputDevicePreference();
  renderAudioOutputDeviceUi();
  Promise.resolve(applyAudioOutputDevice(audio)).then(function (ok) {
    if (!showNotice) return;
    if (!requestedDeviceId) showToast(playbackOutputText('out_back_to_default'));
    else if (ok === true) showToast(playbackOutputText('out_switched'));
    else if (ok === null) showToast(playbackOutputText('out_saved_auto_enable'));
    else if (audioReady && audioCtx && typeof audioCtx.setSinkId !== 'function') showToast(playbackOutputText('out_kernel_no_live_switch'));
    else showToast(playbackOutputText('out_current_unavailable_saved'));
  });
}
function toggleAudioOutputMirrorDevice(deviceId) {
  deviceId = String(deviceId || '');
  if (!deviceId) return;
  if (!audioOutputMirrorSinkSupported()) {
    markAudioOutputMirrorRuntime(deviceId, 'unsupported', playbackOutputText('out_kernel_unsupported'));
    showToast(playbackOutputText('out_kernel_no_mirror'));
    return;
  }
  if (deviceId === (audioOutputDeviceId || '')) {
    showToast(playbackOutputText('out_already_primary'));
    return;
  }
  var ids = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds);
  var pos = ids.indexOf(deviceId);
  if (pos >= 0) {
    ids.splice(pos, 1);
    removeAudioOutputMirror(deviceId);
    showToast(playbackOutputText('out_mirror_off'));
  } else {
    ids.push(deviceId);
    markAudioOutputMirrorRuntime(deviceId, audio && (audio.currentSrc || audio.src || '') ? 'sink-pending' : 'waiting', audio && (audio.currentSrc || audio.src || '') ? playbackOutputText('out_trying') : playbackOutputText('out_try_on_playback'));
    showToast(audio && (audio.currentSrc || audio.src || '') ? playbackOutputText('out_trying_mirror') : playbackOutputText('out_saved_mirror_try'));
  }
  audioOutputMirrorDeviceIds = normalizeAudioOutputIdList(ids);
  saveAudioOutputMirrorPreference();
  renderAudioOutputDeviceUi();
  syncAudioOutputMirrors('mirror-toggle');
}
function setAudioInputBridgeDevice(deviceId, showNotice) {
  deviceId = String(deviceId || '');
  if (!deviceId) {
    if (showNotice) showToast(playbackOutputText('out_no_vm_cable'));
    renderAudioOutputDeviceUi();
    return;
  }
  var wasEnabled = !!(audioInputBridgeState && audioInputBridgeState.enabled && audioInputBridgeState.deviceId === deviceId);
  audioInputBridgeState = { enabled: !wasEnabled, deviceId: deviceId };
  saveAudioInputBridgePreference();
  if (audioInputBridgeState.enabled) {
    audioOutputDeviceId = deviceId;
    audioOutputMirrorDeviceIds = normalizeAudioOutputIdList(audioOutputMirrorDeviceIds).filter(function (id) { return id !== deviceId; });
    saveAudioOutputMirrorPreference();
    saveAudioOutputDevicePreference();
    Promise.resolve(applyAudioOutputDevice(audio)).then(function () {
      if (showNotice) showToast(playbackOutputText('out_vm_bridge_on'));
    });
  } else {
    if (audioOutputDeviceId === deviceId) {
      audioOutputDeviceId = '';
      saveAudioOutputDevicePreference();
      Promise.resolve(applyAudioOutputDevice(audio));
    }
    if (showNotice) showToast(playbackOutputText('out_vm_bridge_off'));
  }
  renderAudioOutputDeviceUi();
}
