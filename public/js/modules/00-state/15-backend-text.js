'use strict';

// ============================================================
//  后端文案本地化 / Backend copy localization
//  - 后端把「机器可读 code」放在 error，把中文原文放在 message。
//    界面只认 code，具体说法由词典决定，所以换语言不用动后端。
//    The backend puts a machine-readable code in `error` and the Chinese original
//    in `message`. The UI keys off the code and lets the dictionaries own the
//    wording, so switching language never touches the server.
//  - code 没有映射时退回后端原文，而不是显示成空白或裸 code：
//    后端加了新 code 而词典还没跟上，界面最差也只是显示原文，不会坏。
//    An unmapped code falls back to the backend original instead of blanking out,
//    so a new server code degrades to raw text rather than an empty label.
// ============================================================
(function (root) {
  // code -> 词典键 / code to dictionary key.
  // 键名保持 backend_ 前缀，和词典里的 desktop_*、custom_source_fail_* 区分开。
  var BACKEND_TEXT_KEYS = {
    // ── 登录与账号会话 / Login and account sessions ──────────
    LOGIN_EASTER_EGG_LOCKED: 'backend_login_easter_egg_locked',
    INVALID_NETEASE_COOKIE: 'backend_invalid_netease_cookie',
    INVALID_KUGOU_COOKIE: 'backend_invalid_kugou_cookie',
    KUGOU_AUTH_REQUIRED: 'backend_kugou_auth_required',
    QQ_PLAYBACK_AUTH_INCOMPLETE: 'backend_qq_playback_auth_incomplete',
    UNKNOWN_PROVIDER: 'backend_unknown_provider',
    COOKIE_NOT_FOUND: 'backend_cookie_not_found',
    LOGIN_REQUIRED: 'backend_login_required',
    // 登录窗口被关掉时没有失败码可言，但用户看到的仍是后端那句中
    // 文；QQ / 网易云复用词典里已有的 desktop_* 键，避免同一句话两种说法。
    // Closing the login window is not a failure code as such, but the user still
    // sees the backend sentence. QQ / NetEase reuse the existing desktop_* keys
    // so the same situation never grows two different sentences.
    LOGIN_WINDOW_CLOSED_QQ: 'desktop_qq_closed',
    LOGIN_WINDOW_CLOSED_NETEASE: 'desktop_netease_closed',
    LOGIN_WINDOW_CLOSED_KUGOU: 'backend_kugou_login_closed',
    KUGOU_PLAYBACK_TOKEN_INCOMPLETE: 'backend_kugou_playback_token_incomplete',
    SPOTIFY_AUTH_REQUIRED: 'backend_spotify_auth_required',
    SPOTIFY_REAUTH_REQUIRED: 'backend_spotify_reauth_required',
    SPOTIFY_WRITE_SCOPE_REQUIRED: 'backend_spotify_write_scope',
    // ── Spotify OAuth 配置 / Spotify OAuth setup ─────────────
    SPOTIFY_CLIENT_ID_REQUIRED: 'backend_spotify_client_id_required',
    SPOTIFY_CLIENT_ID_INVALID: 'backend_spotify_client_id_invalid',
    SPOTIFY_REDIRECT_URI_INVALID: 'backend_spotify_redirect_invalid',
    SPOTIFY_OAUTH_NOT_CONFIGURED: 'backend_spotify_oauth_not_configured',
    SPOTIFY_OAUTH_STATE_MISMATCH: 'backend_spotify_oauth_state_mismatch',
    SPOTIFY_OAUTH_CODE_MISSING: 'backend_spotify_oauth_code_missing',
    SPOTIFY_OAUTH_TIMEOUT: 'backend_spotify_oauth_timeout',
    SPOTIFY_OAUTH_BAD_REDIRECT: 'backend_spotify_oauth_bad_redirect',
    SPOTIFY_PREFLIGHT_ONLY: 'backend_spotify_preflight_only',
    SPOTIFY_PKCE_CHALLENGE_REQUIRED: 'backend_spotify_pkce_required',
    SPOTIFY_TOKEN_MISSING: 'backend_spotify_token_missing',
    SPOTIFY_REFRESH_TOKEN_MISSING: 'backend_spotify_refresh_missing',
    SPOTIFY_PLAYLIST_OR_TRACK_REQUIRED: 'backend_spotify_playlist_or_track',
    SPOTIFY_PLAYLIST_NAME_REQUIRED: 'backend_spotify_playlist_name',
    SPOTIFY_ITEM_ID_REQUIRED: 'backend_spotify_item_id',
    // ── 内容源可用性 / Source availability ───────────────────
    UPDATE_EXTERNAL_ONLY: 'backend_update_external_only',
    QISHUI_COOKIE_REQUIRED: 'backend_qishui_cookie_required',
    QISHUI_TOKEN_REQUIRED: 'backend_qishui_token_required',
    QISHUI_QR_TOKEN_REQUIRED: 'backend_qishui_qr_token_required',
    QISHUI_QR_CREATE_FAILED: 'backend_qishui_qr_create_failed',
    QISHUI_QR_CHECK_FAILED: 'backend_qishui_qr_check_failed',
    QISHUI_SESSION_EXPIRED: 'backend_qishui_session_expired',
    QISHUI_PROFILE_INCOMPLETE: 'backend_qishui_profile_incomplete',
    QISHUI_PLAYLIST_NOT_FOUND: 'backend_qishui_playlist_not_found',
    QISHUI_PLAYLIST_ADD_FAILED: 'backend_qishui_playlist_add_failed',
    QISHUI_SEARCH_UNAVAILABLE: 'backend_qishui_search_unavailable',
    QISHUI_EMPTY_RESPONSE: 'backend_qishui_empty_response',
    QISHUI_REQUEST_TIMEOUT: 'backend_qishui_timeout',
    QISHUI_SEO_TRACK_UNKNOWN: 'backend_qishui_seo_unknown',
    QISHUI_OAUTH_NOT_CONFIGURED: 'backend_qishui_oauth_not_configured',
    QISHUI_OAUTH_CODE_REQUIRED: 'backend_qishui_oauth_code_required',
    QISHUI_OAUTH_TOKEN_MISSING: 'backend_qishui_oauth_token_missing',
    INVALID_QISHUI_TOKEN: 'backend_qishui_token_invalid',
    KUGOU_SEARCH_UNAVAILABLE: 'backend_kugou_search_unavailable',
    KUGOU_FAVORITE_LIST_NOT_FOUND: 'backend_kugou_favorite_missing',
    KUGOU_SONG_NOT_IN_LIST: 'backend_kugou_song_not_in_list',
    MISSING_HASH: 'backend_missing_hash',
    MISSING_PLAYLIST_ID: 'backend_missing_playlist_id',
    MISSING_MID: 'backend_missing_mid',
    QQ_URL_UNAVAILABLE: 'backend_qq_url_unavailable',
    QQ_LIKED_REQUIRES_PLAYBACK_LOGIN: 'backend_qq_liked_needs_playback',
    // ── 自定义音源 / Custom source ───────────────────────────
    // IMPORT_INVALID 复用既有键：20-custom-source.js 的 CUSTOM_SOURCE_FAILURE_KEYS
    // 已经把它映射到 custom_source_fail_invalid，这里保持同一个键名，避免两套说法。
    // IMPORT_INVALID reuses the key that CUSTOM_SOURCE_FAILURE_KEYS already maps,
    // so the same failure never gets two different sentences.
    IMPORT_INVALID: 'custom_source_fail_invalid',
    INIT_TIMEOUT: 'custom_source_fail_init_timeout',
    INIT_FAILED: 'custom_source_fail_init',
    SOURCE_UNSUPPORTED: 'custom_source_fail_unsupported',
    QUALITY_UNSUPPORTED: 'custom_source_fail_unsupported',
    CUSTOM_SOURCE_UNAVAILABLE: 'custom_source_fail_unavailable',
    CUSTOM_SOURCE_UNAUTHORIZED: 'custom_source_fail_unauthorized'
  };

  // 键 -> 中文兜底。词典没加载出来时也要有话说，不能让界面出现空字符串。
  // Key to Chinese fallback, so a dictionary that failed to load still leaves the
  // UI with a sentence instead of an empty label.
  var BACKEND_TEXT_FALLBACKS = {
    backend_login_easter_egg_locked: '请先完成登录彩蛋解锁。',
    backend_invalid_netease_cookie: '网易云 cookie 缺少 MUSIC_U',
    backend_invalid_kugou_cookie: '酷狗 cookie 无效或缺少登录标识',
    backend_kugou_auth_required: '酷狗登录未完成，请重新网页登录',
    backend_qq_playback_auth_incomplete: 'QQ 账号验证已完成，但 QQ 音乐播放授权尚未生成，请在官方登录窗口完成授权后再关闭',
    backend_unknown_provider: '未知平台，无法导出登录 cookie',
    backend_cookie_not_found: '当前没有可导出的登录 cookie',
    backend_login_required: '请先登录平台账号。',
    backend_kugou_login_closed: '酷狗登录窗口已关闭',
    backend_kugou_playback_token_incomplete: '酷狗账号已登录，但播放 token 不完整，请稍后在播放器内重试登录',
    backend_spotify_auth_required: '连接 Spotify 后显示你的常听歌曲。',
    backend_spotify_reauth_required: '请重新连接 Spotify，授予所需权限。',
    backend_spotify_write_scope: '请在账号面板重新连接 Spotify，授予写入权限。',
    backend_spotify_client_id_required: '请先粘贴 Spotify Client ID。',
    backend_spotify_client_id_invalid: 'Client ID 格式不正确，请只复制 Spotify Dashboard 中的 Client ID。',
    backend_spotify_redirect_invalid: '回调地址无效，请使用 Mineradio 显示的 127.0.0.1 回调地址。',
    backend_spotify_oauth_not_configured: 'Spotify 登录需要先配置 Client ID，并在 Spotify Developer Dashboard 登记本地回调地址。',
    backend_spotify_oauth_state_mismatch: 'Spotify 授权状态校验失败，请重新登录。',
    backend_spotify_oauth_code_missing: 'Spotify 回调没有返回 code。',
    backend_spotify_oauth_timeout: '三分钟内没有收到 Spotify 回调，请确认 Dashboard 回调地址完全一致、App 所有者为 Premium，且当前账号已加入 Users Management。',
    backend_spotify_oauth_bad_redirect: 'Spotify 回调地址无法解析，请重新登录。',
    backend_spotify_preflight_only: '当前仅执行本机回调检测。',
    backend_spotify_pkce_required: 'Spotify 授权缺少 PKCE 校验参数，请重新登录。',
    backend_spotify_token_missing: 'Spotify 登录凭证缺失，请重新登录。',
    backend_spotify_refresh_missing: 'Spotify 刷新凭证缺失，请重新登录。',
    backend_spotify_playlist_or_track: '缺少歌单或歌曲标识。',
    backend_spotify_playlist_name: '请先填写歌单名称。',
    backend_spotify_item_id: '缺少 Spotify 条目标识。',
    backend_update_external_only: 'Mineradio 已停用客户端本地下载与快速补丁，请使用外部下载页面。',
    backend_qishui_cookie_required: '请先登录汽水音乐账号。',
    backend_qishui_token_required: '汽水音乐登录凭证缺失，请重新扫码登录。',
    backend_qishui_qr_token_required: '二维码登录 token 缺失',
    backend_qishui_qr_create_failed: '汽水音乐二维码生成失败',
    backend_qishui_qr_check_failed: '汽水音乐登录状态检查失败',
    backend_qishui_session_expired: '汽水音乐登录状态已失效，请重新扫码登录。',
    backend_qishui_profile_incomplete: '汽水账号接口未返回可验证的用户身份。',
    backend_qishui_playlist_not_found: '当前汽水接入只支持官方推荐歌单。',
    backend_qishui_playlist_add_failed: '加入汽水音乐歌单失败，请稍后重试。',
    backend_qishui_search_unavailable: '汽水公开搜索暂时没有返回匹配结果。',
    backend_qishui_empty_response: '汽水接口暂时返回空响应，请稍后重试。',
    backend_qishui_timeout: '汽水接口请求超时，请稍后重试。',
    backend_qishui_seo_unknown: '汽水音乐 SEO 接口未返回曲目信息',
    backend_qishui_oauth_not_configured: '汽水音乐开放平台授权尚未配置。',
    backend_qishui_oauth_code_required: '缺少汽水音乐授权码。',
    backend_qishui_oauth_token_missing: '缺少汽水音乐开放平台 token。',
    backend_qishui_token_invalid: '汽水音乐 token 无效，请重新登录。',
    backend_kugou_search_unavailable: '酷狗搜索服务暂时不可用，请稍后重试',
    backend_kugou_favorite_missing: '没有找到酷狗的收藏歌单。',
    backend_kugou_song_not_in_list: '这首酷狗歌曲不在目标歌单中。',
    backend_missing_hash: '缺少酷狗歌曲 hash',
    backend_missing_playlist_id: '缺少歌单 ID。',
    backend_missing_mid: '缺少歌曲标识。',
    backend_qq_url_unavailable: 'QQ 音乐没有返回可播放地址。',
    backend_qq_liked_needs_playback: '查看 QQ 音乐「我喜欢」需要先完成播放授权。'
  };

  // 本模块要在 13-i18n.js 之后加载，但仍然不能假设它一定存在：
  // 测试沙箱单独求值模块时没有 window，词典也可能还没初始化完。
  // Loaded after 13-i18n.js, but never assumed present: the test sandbox has no
  // window, and the dictionary may still be initializing.
  function tr(key, fallback) {
    var i18n = root.MineradioI18n;
    if (i18n && typeof i18n.t === 'function') {
      var text = i18n.t(key);
      if (text && text !== key) return text;
    }
    return fallback;
  }

  // 只认全大写常量。中文原文和内部英文句子都不该被当成 code，
  // 否则会把 message 里的整句话拿去查表，查不到再退回自己，绕一圈没有任何意义。
  // Only all-caps constants count as codes: a Chinese sentence or an internal
  // English message must not be treated as one, or the lookup just round-trips.
  var CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;

  function isBackendCode(value) {
    return CODE_PATTERN.test(String(value == null ? '' : value).trim());
  }

  // 从一个后端 payload 里取出 code。error 是约定的机器码字段，
  // code / errorCode 是少数接口的历史写法，一并认掉。
  // Pulls the code out of a backend payload. `error` is the agreed field;
  // `code` / `errorCode` cover a few older endpoints.
  function backendCode(payload) {
    if (!payload || typeof payload !== 'object') return '';
    var candidates = [payload.error, payload.code, payload.errorCode];
    for (var i = 0; i < candidates.length; i++) {
      if (isBackendCode(candidates[i])) return String(candidates[i]).trim();
    }
    return '';
  }

  // code（可能是字符串，也可能是走 throw 带出来的 Error.message）-> 界面文案。
  // 查不到还回 fallback，调用方自己决定退回后端原文还是自己的兜底句。
  // Code (a bare string, or an Error.message) to copy. Returns `fallback` when
  // unmapped so the caller decides what to show instead.
  function backendCodeText(code, fallback) {
    var raw = String(code == null ? '' : code).trim();
    var key = BACKEND_TEXT_KEYS[raw];
    if (!key) return fallback;
    return tr(key, BACKEND_TEXT_FALLBACKS[key] || fallback);
  }

  // 显示点统一入口：优先按 code 查词典，其次用后端原文，最后用调用方兜底。
  // Single entry point for display sites: dictionary by code first, then the
  // backend original, then the caller's own fallback.
  function backendText(payload, fallbackKey, fallbackText) {
    var code = backendCode(payload);
    if (code) {
      var mapped = backendCodeText(code, null);
      if (mapped != null) return mapped;
    }
    var message = payload && typeof payload.message === 'string' ? payload.message : '';
    if (message) return message;
    if (fallbackKey) return tr(fallbackKey, fallbackText);
    return fallbackText || '';
  }

  // 把 payload.message 就地换成词典文案。
  // 只动 message，不动 error：error 是机器码，前端有多处按它做正则分类
  // （例如按 SCOPE / AUTH_REQUIRED 决定给哪句提示），翻译它会把这些判断打掉。
  // Rewrites payload.message in place and deliberately leaves `error` alone:
  // `error` is the machine code and several frontend sites regex it to classify
  // the failure, so translating it would break those branches.
  function localizeBackendPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    if (typeof payload.message !== 'string' || !payload.message) return payload;
    var code = backendCode(payload);
    if (!code) return payload;
    var mapped = backendCodeText(code, null);
    if (mapped != null) payload.message = mapped;
    return payload;
  }

  // 递归版本，用于列表型响应（例如批量体检结果 checks[]）。
  // Recursive variant for list responses such as diagnostics checks[].
  function localizeBackendPayloadDeep(payload, depth) {
    if (!payload || typeof payload !== 'object') return payload;
    if ((depth || 0) > 4) return payload;
    if (Array.isArray(payload)) {
      for (var i = 0; i < payload.length; i++) localizeBackendPayloadDeep(payload[i], (depth || 0) + 1);
      return payload;
    }
    localizeBackendPayload(payload);
    var keys = Object.keys(payload);
    for (var k = 0; k < keys.length; k++) {
      var value = payload[keys[k]];
      if (value && typeof value === 'object') localizeBackendPayloadDeep(value, (depth || 0) + 1);
    }
    return payload;
  }

  root.MineradioBackendText = {
    isBackendCode: isBackendCode,
    backendCode: backendCode,
    backendCodeText: backendCodeText,
    backendText: backendText,
    localize: localizeBackendPayload,
    localizeDeep: localizeBackendPayloadDeep,
    keys: BACKEND_TEXT_KEYS,
    fallbacks: BACKEND_TEXT_FALLBACKS
  };
})(typeof window !== 'undefined' ? window : this);
