'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

// 凭证加密层（与 server.js 共用；safeStorage 由 main.js 注入）。
// Credential encryption layer shared with server.js; safeStorage injected by main.js.
const credentialCrypto = require('../desktop/credential-crypto');
const { createSpotifyPartner } = require('./spotify-partner');

// 项目根：本文件住在 server/ 下，而 Spotify 的凭据与令牌一直落在仓库根目录，位置不变。
// Project root: this file lives under server/ while Spotify's credentials and token always sat at
// the repository root; the location is deliberately preserved.
const PROJECT_ROOT = path.join(__dirname, '..');

const SPOTIFY_ACCOUNTS_BASE = (process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com').replace(/\/+$/, '');
const SPOTIFY_API_BASE = (process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1').replace(/\/+$/, '');
const DEFAULT_SPOTIFY_MARKET = String(process.env.MINERADIO_SPOTIFY_MARKET || process.env.SPOTIFY_MARKET || 'US').trim().toUpperCase();
const DEFAULT_SPOTIFY_CONFIG_FILE = path.join(PROJECT_ROOT, '.spotify-credentials.json');
const DEFAULT_SPOTIFY_TOKEN_FILE = path.join(PROJECT_ROOT, '.spotify-token.json');
// Folia 使用的公开桌面客户端：内置 Client ID + PKCE，安装后即可一键授权，不再要求用户
// 先去 Spotify Developer Dashboard 建应用、填回调、加测试账号。用户仍可用配置文件或环境变量
// 覆盖成自己的 Client ID；覆盖后回调地址也必须与那个应用登记的一致。
// Folia's public desktop client: a built-in Client ID with PKCE, so a fresh install can authorize
// in one click instead of asking for a dashboard app, redirect URI and test users. A user-supplied
// Client ID (file/env) still wins, and then its registered redirect URI must be used.
const DEFAULT_SPOTIFY_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
const DEFAULT_SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:5588/login';
const DEFAULT_SPOTIFY_SCOPES = [
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-library-modify',
  'user-top-read',
  'playlist-modify-private',
  'playlist-modify-public',
];
const SPOTIFY_LIKED_PLAYLIST_ID = 'spotify-liked';
const SPOTIFY_UA = 'Mineradio/2.1.0 (Spotify Web API bridge)';
const SPOTIFY_SEARCH_LIMIT_MAX = 10;
const SPOTIFY_PLAYLIST_PAGE_LIMIT = 50;

let spotifyClientTokenCache = { token: '', expiresAt: 0 };
let spotifyClientTokenRefreshPromise = null;
let spotifyUserTokenRefreshPromise = null;
let spotifyProfileCache = { value: null, at: 0, promise: null };
let spotifyProfileRefreshPromise = null;
let spotifyProfileRefreshError = null;
const spotifySearchCache = new Map();
const spotifySearchInflight = new Map();
// 与 Folia 的 ACCOUNT_MAX_AGE_MS 一致：账号信息十分钟读一次就够。60 秒的缓存配上 45 秒
// 轮询，等于每分钟朝 /v1/me 烧一次共享配额。
// Matches Folia's ACCOUNT_MAX_AGE_MS: reading the account once per 10 minutes is enough. A 60s
// cache plus a 45s poll meant one /v1/me hit per minute against the shared quota.
const SPOTIFY_PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;
// 429 里的 Retry-After 只等这么一点点的，才值得在本次请求内重试一次；再长就交给上层
// 按冷却时间调度，否则"等 4 秒再打一次"会把滚动窗口一直踩住。
// Only a Retry-After this short is worth an inline retry; anything longer is scheduled by the
// caller, otherwise "sleep 4s and fire again" keeps the rolling window occupied forever.
const SPOTIFY_SHORT_RATE_LIMIT_WAIT_MAX_MS = 1500;
const SPOTIFY_TRANSIENT_RETRY_DELAYS_MS = [320, 900];
// Spotify 的 429 是整个开发应用共享的滚动窗口配额，不是某一次请求的错。被限流后继续
// 发新请求只会把窗口一直踩住，所以这里记一个冷却截止时间：冷却期内所有上游调用直接失败，
// 一个字节都不再打给 Spotify，界面也能说明"等 N 秒"而不是反复报错。
// A Spotify 429 is a rolling-window quota shared by the whole dev app, not one bad request.
// Firing more calls only keeps the window occupied, so a cooldown is recorded and every upstream
// call fails fast without touching the network until it expires.
const SPOTIFY_RATE_LIMIT_MIN_COOLDOWN_MS = 20000;
// 固定 120 秒上限会造成"每两分钟撞一次墙"的永动循环：冷却一结束就去探，一探又是 429，
// 于是界面永远停在限流提示上。连续 429 必须指数退避，最长退到半小时。
// A flat 120s cap creates a treadmill: the cooldown expires, one probe hits 429 again, and the
// UI never leaves the "throttled" state. Consecutive 429s therefore back off exponentially.
const SPOTIFY_RATE_LIMIT_MAX_COOLDOWN_MS = 30 * 60 * 1000;
let spotifyRateLimitState = { until: 0, seconds: 0, message: '', strikes: 0 };

function spotifyClientIdLooksValid(value) {
  return /^[A-Za-z0-9]{16,128}$/.test(normalizeText(value));
}

function inspectSpotifyRedirectUri(value) {
  value = normalizeText(value || DEFAULT_SPOTIFY_REDIRECT_URI);
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const loopback = host === '127.0.0.1' || host === '[::1]' || host === '::1';
    const pathName = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
    return {
      ok: parsed.protocol === 'http:' && loopback && !!parsed.port && (pathName === '/callback' || pathName === '/login') && !parsed.username && !parsed.password,
      value: parsed.toString(),
      protocol: parsed.protocol,
      host,
      port: Number(parsed.port || 0),
      path: pathName,
      loopback,
    };
  } catch (err) {
    return { ok: false, value, error: 'SPOTIFY_REDIRECT_URI_INVALID' };
  }
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function firstEnv(keys) {
  for (const key of keys) {
    const value = normalizeText(process.env[key]);
    if (value) return value;
  }
  return '';
}

function uniqueList(items) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item) => {
    item = normalizeText(item);
    if (!item || seen.has(item)) return;
    seen.add(item);
    out.push(item);
  });
  return out;
}

function normalizeScopes(value) {
  if (Array.isArray(value)) return uniqueList(value);
  return uniqueList(String(value || '').split(/[\s,;]+/));
}

function spotifyConfigFileCandidates() {
  const candidates = [];
  function add(value) {
    value = normalizeText(value);
    if (!value) return;
    const resolved = path.resolve(value);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }
  add(firstEnv(['SPOTIFY_CONFIG_FILE', 'MINERADIO_SPOTIFY_CONFIG_FILE']));
  add(DEFAULT_SPOTIFY_CONFIG_FILE);
  add(path.join(PROJECT_ROOT, 'spotify-credentials.json'));
  return candidates;
}

function normalizeSpotifyFileConfig(raw, file) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const spotify = raw.spotify && typeof raw.spotify === 'object' ? raw.spotify : raw;
  return {
    clientId: normalizeText(spotify.clientId || spotify.client_id || spotify.id),
    clientSecret: normalizeText(spotify.clientSecret || spotify.client_secret || spotify.secret),
    redirectUri: normalizeText(spotify.redirectUri || spotify.redirect_uri || spotify.callbackUrl || spotify.callback_url),
    scopes: normalizeScopes(spotify.scopes || spotify.scope),
    market: normalizeText(spotify.market || spotify.country || ''),
    file,
    source: file ? 'file' : '',
  };
}

function readSpotifyFileConfig() {
  const candidates = spotifyConfigFileCandidates();
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = readCredentialJsonFile(file);
      const config = normalizeSpotifyFileConfig(parsed, file);
      if (config.clientId || config.clientSecret || config.redirectUri || config.scopes.length || config.market) return config;
    } catch (err) {
      console.warn('[SpotifyConfig] ignored invalid config file:', file, err.message);
    }
  }
  return normalizeSpotifyFileConfig(null, '');
}

function getSpotifyConfigFile() {
  return process.env.SPOTIFY_CONFIG_FILE || process.env.MINERADIO_SPOTIFY_CONFIG_FILE || DEFAULT_SPOTIFY_CONFIG_FILE;
}

function saveSpotifyConfig(input) {
  input = input && typeof input === 'object' ? input : {};
  // Empty means "use the built-in desktop client"; only a non-empty malformed id is rejected.
  const clientId = normalizeText(input.clientId || input.client_id || input.id) || DEFAULT_SPOTIFY_CLIENT_ID;
  const redirectUri = normalizeText(input.redirectUri || input.redirect_uri || input.callbackUrl || input.callback_url) || DEFAULT_SPOTIFY_REDIRECT_URI;
  const scopes = normalizeScopes(input.scopes || input.scope);
  const market = normalizeText(input.market || input.country || DEFAULT_SPOTIFY_MARKET || 'US').toUpperCase();
  if (!spotifyClientIdLooksValid(clientId)) {
    const err = new Error('SPOTIFY_CLIENT_ID_INVALID');
    err.code = 'SPOTIFY_CLIENT_ID_INVALID';
    throw err;
  }
  const redirectCheck = inspectSpotifyRedirectUri(redirectUri);
  if (!redirectCheck.ok) {
    const err = new Error('SPOTIFY_REDIRECT_URI_INVALID');
    err.code = 'SPOTIFY_REDIRECT_URI_INVALID';
    err.redirectUri = redirectUri;
    throw err;
  }
  const file = getSpotifyConfigFile();
  writeJsonFile(file, {
    spotify: {
      clientId,
      redirectUri,
      scopes: scopes.length ? scopes : DEFAULT_SPOTIFY_SCOPES,
      market,
    },
  });
  return {
    provider: 'spotify',
    ok: true,
    saved: true,
    credentialsFile: file,
    credentialsFileExists: true,
    clientId,
    redirectUri,
    scope: (scopes.length ? scopes : DEFAULT_SPOTIFY_SCOPES).join(' '),
    market,
  };
}

function getSpotifyTokenFile() {
  return process.env.SPOTIFY_TOKEN_FILE || process.env.MINERADIO_SPOTIFY_TOKEN_FILE || DEFAULT_SPOTIFY_TOKEN_FILE;
}

function readStoredSpotifyToken() {
  const file = getSpotifyTokenFile();
  try {
    if (!file || !fs.existsSync(file)) return { file, accessToken: '', refreshToken: '', expiresAt: 0 };
    const raw = readCredentialJsonFile(file);
    return {
      file,
      accessToken: normalizeText(raw.accessToken || raw.access_token),
      refreshToken: normalizeText(raw.refreshToken || raw.refresh_token),
      tokenType: normalizeText(raw.tokenType || raw.token_type || 'Bearer') || 'Bearer',
      scope: normalizeText(raw.scope || (Array.isArray(raw.scopes) ? raw.scopes.join(' ') : '')),
      expiresAt: Number(raw.expiresAt || raw.expires_at || 0) || 0,
      createdAt: Number(raw.createdAt || raw.created_at || 0) || 0,
      authorizedAt: Number(raw.authorizedAt || raw.authorized_at || 0) || 0,
    };
  } catch (err) {
    console.warn('[SpotifyToken] ignored invalid token file:', file, err.message);
    return { file, accessToken: '', refreshToken: '', expiresAt: 0, invalid: true };
  }
}

function writeJsonFile(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 加密写盘；safeStorage 不可用时降级明文。
  // Encrypt at rest; falls back to plaintext when safeStorage is unavailable.
  const text = JSON.stringify(payload, null, 2);
  const stored = credentialCrypto.encryptCredential(text, credentialCrypto.defaultKeyPathFor(file));
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, stored, 'utf8');
  fs.renameSync(tmp, file);
}

// 读回 JSON 凭证文件：密文信封先解密再 parse，明文 JSON 直接 parse（过渡期兼容）。
// Read back JSON credential file: decrypt envelope then parse, or parse plaintext directly.
function readCredentialJsonFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  const text = credentialCrypto.isEncryptedEnvelope(raw)
    ? credentialCrypto.decryptCredential(raw, credentialCrypto.defaultKeyPathFor(file))
    : raw;
  return JSON.parse(text);
}

function saveSpotifyOAuthToken(payload) {
  payload = payload || {};
  const previous = readStoredSpotifyToken();
  const expiresIn = Math.max(60, Number(payload.expires_in || payload.expiresIn) || 3600);
  const now = Date.now();
  const saved = {
    accessToken: normalizeText(payload.access_token || payload.accessToken),
    refreshToken: normalizeText(payload.refresh_token || payload.refreshToken || previous.refreshToken),
    tokenType: normalizeText(payload.token_type || payload.tokenType || 'Bearer') || 'Bearer',
    scope: normalizeText(payload.scope || previous.scope || DEFAULT_SPOTIFY_SCOPES.join(' ')),
    expiresAt: Number(payload.expiresAt || payload.expires_at) || (now + expiresIn * 1000),
    createdAt: now,
    authorizedAt: payload.newAuthorization || payload.new_authorization
      ? now
      : (Number(payload.authorizedAt || payload.authorized_at || previous.authorizedAt || 0) || now),
  };
  if (!saved.accessToken && !saved.refreshToken) {
    const err = new Error('SPOTIFY_TOKEN_MISSING');
    err.code = 'SPOTIFY_TOKEN_MISSING';
    throw err;
  }
  writeJsonFile(getSpotifyTokenFile(), saved);
  spotifyProfileCache = { value: null, at: 0, promise: null };
  spotifyProfileRefreshError = null;
  // 刚换了新授权，允许立刻验证一次；被限流时这一次会重新把冷却时间记上。
  // A fresh authorization earns one immediate verification; if it is still 429 the cooldown
  // simply starts again from that answer.
  resetSpotifyRateLimit();
  return {
    provider: 'spotify',
    loggedIn: !!saved.accessToken,
    tokenConfigured: !!(saved.accessToken || saved.refreshToken),
    expiresAt: saved.expiresAt,
    scope: saved.scope,
  };
}

function clearSpotifyToken() {
  try {
    const file = getSpotifyTokenFile();
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.warn('[SpotifyToken] clear skipped:', err.message);
  }
  spotifyProfileCache = { value: null, at: 0, promise: null };
  spotifyProfileRefreshError = null;
  resetSpotifyRateLimit();
  return { ok: true, provider: 'spotify', loggedIn: false };
}

function getSpotifyOAuthConfig() {
  const fileConfig = readSpotifyFileConfig();
  const envClientId = firstEnv(['SPOTIFY_CLIENT_ID', 'MINERADIO_SPOTIFY_CLIENT_ID']);
  const envClientSecret = firstEnv(['SPOTIFY_CLIENT_SECRET', 'MINERADIO_SPOTIFY_CLIENT_SECRET']);
  const envRedirectUri = firstEnv(['SPOTIFY_REDIRECT_URI', 'MINERADIO_SPOTIFY_REDIRECT_URI']);
  const envScopes = normalizeScopes(firstEnv(['SPOTIFY_SCOPES', 'SPOTIFY_SCOPE', 'MINERADIO_SPOTIFY_SCOPES']));
  // Older Mineradio builds stored the user's own Client ID together with the old
  // 43879/callback. A later save can pair that custom Client ID with the new
  // bundled 5588/login redirect, which Spotify rejects with
  // "redirect_uri: Not matching configuration". That combination cannot be the
  // user's intended app config, so fall back to the bundled Folia client and its
  // matching redirect. A custom Client ID with its own explicit redirect (for
  // example 43879/callback) is still honored, and env overrides always win.
  const fileClientId = fileConfig.clientId;
  const fileRedirectUri = fileConfig.redirectUri;
  const staleCustomClient = !!fileClientId
    && fileClientId !== DEFAULT_SPOTIFY_CLIENT_ID
    && (!fileRedirectUri || fileRedirectUri === DEFAULT_SPOTIFY_REDIRECT_URI);
  const clientId = envClientId || (staleCustomClient ? DEFAULT_SPOTIFY_CLIENT_ID : fileClientId) || DEFAULT_SPOTIFY_CLIENT_ID;
  // Desktop PKCE must not depend on a secret stored in the packaged app or user JSON.
  // A client secret is accepted only from a backend-controlled environment for optional client-credentials requests.
  const clientSecret = envClientSecret;
  const redirectUri = envRedirectUri
    || (staleCustomClient ? DEFAULT_SPOTIFY_REDIRECT_URI : (fileRedirectUri || DEFAULT_SPOTIFY_REDIRECT_URI));
  // Mineradio owns the OAuth flow, so always include the scopes required by
  // the currently exposed account actions. Existing tokens still need a fresh
  // authorization before these newly requested scopes become effective.
  const configuredScopes = envScopes.length ? envScopes : fileConfig.scopes;
  const scopes = uniqueList(DEFAULT_SPOTIFY_SCOPES.concat(configuredScopes || []));
  const market = (firstEnv(['SPOTIFY_MARKET', 'MINERADIO_SPOTIFY_MARKET']) || fileConfig.market || DEFAULT_SPOTIFY_MARKET || 'US').toUpperCase();
  const missing = [];
  if (!clientId) missing.push('SPOTIFY_CLIENT_ID');
  else if (!spotifyClientIdLooksValid(clientId)) missing.push('SPOTIFY_CLIENT_ID');
  const clientIdValid = spotifyClientIdLooksValid(clientId);
  const redirectCheck = inspectSpotifyRedirectUri(redirectUri);
  if (!redirectCheck.ok) missing.push('SPOTIFY_REDIRECT_URI');
  return {
    provider: 'spotify',
    configured: missing.length === 0 && clientIdValid && redirectCheck.ok,
    clientId,
    clientIdBundled: !envClientId && (!fileClientId || staleCustomClient),
    clientSecret,
    redirectUri,
    clientIdValid,
    redirectValid: redirectCheck.ok,
    redirectCheck,
    scopes,
    scope: scopes.join(' '),
    market,
    credentialsFile: fileConfig.file,
    configSource: envClientId || envClientSecret || envRedirectUri || envScopes.length
      ? 'env'
      : (staleCustomClient ? 'bundled-fallback' : (fileConfig.source || 'bundled')),
    ignoredCustomClient: staleCustomClient,
    missing,
  };
}

function getSpotifyConfig() {
  const oauth = getSpotifyOAuthConfig();
  const token = readStoredSpotifyToken();
  const tokenFileExists = !!(token.file && fs.existsSync(token.file));
  const credentialsFileExists = !!(oauth.credentialsFile && fs.existsSync(oauth.credentialsFile));
  const clientCredentialsConfigured = !!(oauth.clientId && oauth.clientSecret);
  const oauthConfigured = !!(oauth.clientId && oauth.clientIdValid && oauth.redirectUri && oauth.redirectValid);
  const tokenConfigured = !!(token.accessToken || token.refreshToken);
  const localConfigMissing = false;
  const spotifyConfigMessage = oauth.ignoredCustomClient
    ? '检测到旧的自定义 Client ID 与内置回调不匹配，已临时使用内置客户端；可直接打开官方授权。'
    : (clientCredentialsConfigured || tokenConfigured
      ? 'Spotify Web API 已接入；播放仍会按匹配源自动换源。'
      : 'Spotify 已内置桌面客户端，可直接打开官方授权；桌面端使用 PKCE，不保存 Client Secret。');
  const missing = [];
  if (!oauth.clientId) missing.push('SPOTIFY_CLIENT_ID');
  const clientCredentialsMissing = [];
  if (!oauth.clientId) clientCredentialsMissing.push('SPOTIFY_CLIENT_ID');
  if (!oauth.clientSecret) clientCredentialsMissing.push('SPOTIFY_CLIENT_SECRET');
  return {
    provider: 'spotify',
    configured: !!(clientCredentialsConfigured || oauthConfigured || tokenConfigured),
    loggedIn: false,
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
    redirectUri: oauth.redirectUri,
    clientIdValid: oauth.clientIdValid,
    redirectValid: oauth.redirectValid,
    scopes: oauth.scopes,
    scope: oauth.scope,
    market: oauth.market,
    clientCredentialsConfigured,
    clientCredentialsMissing,
    oauthConfigured,
    oauthMissing: oauth.missing,
    tokenConfigured,
    tokenFileExists,
    tokenReady: !!(token.accessToken && Date.now() < token.expiresAt - 30000),
    authorizedAt: token.authorizedAt || 0,
    tokenFile: token.file,
    credentialsFile: oauth.credentialsFile,
    credentialsFileExists,
    localConfigMissing,
    configSource: oauth.configSource,
    ignoredCustomClient: !!oauth.ignoredCustomClient,
    missing,
    playbackMode: 'recommend-match',
    capabilities: {
      search: clientCredentialsConfigured || tokenConfigured,
      metadata: clientCredentialsConfigured || tokenConfigured,
      lyric: false,
      playableUrl: false,
      userPlaylists: tokenConfigured,
      likedTracks: tokenConfigured,
    },
    message: spotifyConfigMessage,
  };
}

function requestText(targetUrl, opts, body) {
  opts = opts || {};
  const timeoutMs = Number(opts.timeoutMs) || 10000;
  const method = opts.method || (body == null ? 'GET' : 'POST');
  const headers = Object.assign({ 'User-Agent': SPOTIFY_UA }, opts.headers || {});
  return new Promise((resolve, reject) => {
    const req = https.request(targetUrl, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text);
          return;
        }
        const err = new Error('SPOTIFY_HTTP_' + res.statusCode);
        err.statusCode = res.statusCode;
        err.body = text;
        err.retryAfter = res.headers && res.headers['retry-after'];
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('SPOTIFY_REQUEST_TIMEOUT')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    err.message = 'SPOTIFY_JSON_PARSE_FAILED: ' + err.message;
    throw err;
  }
}

// pathfinder / spclient 用 fetch（undici）而不是裸 https.request。
// Folia 走的就是 Electron 的 fetch，HTTP 栈是 Chromium/undici：有 Accept-Encoding、连接复用，
// TLS 与头部指纹都像浏览器。裸 https.request 连 Accept-Encoding 都不发，Spotify 网关前面的
// 那一层会把它当脚本流量限流（429 + 十几秒 Retry-After），而这跟账号配额无关 —— 同一个令牌
// 在别处好好的。
// pathfinder/spclient go through fetch (undici) rather than a bare https.request. Folia uses
// Electron's fetch, so its HTTP stack is Chromium's: compression, keep-alive, a browser-like TLS
// and header fingerprint. A bare https.request sends no Accept-Encoding at all, and the gateway in
// front of Spotify throttles that as script traffic (429 with a ten-something second Retry-After)
// regardless of the account quota.
async function partnerRequestJson(targetUrl, opts, body) {
  opts = opts || {};
  if (typeof fetch !== 'function') return requestJson(targetUrl, opts, body);
  const timeoutMs = Number(opts.timeoutMs) || 20000;
  const method = opts.method || (body == null ? 'GET' : 'POST');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(targetUrl, {
      method,
      headers: opts.headers || {},
      body: body == null ? undefined : body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    if (!(res.status >= 200 && res.status < 300)) {
      const err = new Error('SPOTIFY_HTTP_' + res.status);
      err.statusCode = res.status;
      err.body = text;
      err.retryAfter = (res.headers && res.headers.get('retry-after')) || '';
      throw err;
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      parseErr.message = 'SPOTIFY_JSON_PARSE_FAILED: ' + parseErr.message;
      throw parseErr;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeoutErr = new Error('SPOTIFY_REQUEST_TIMEOUT');
      timeoutErr.code = 'SPOTIFY_REQUEST_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function spotifyErrorDetails(err) {
  err = err || {};
  let apiMessage = '';
  let apiStatus = '';
  let apiReason = '';
  const rawBody = err.body ? String(err.body) : '';
  try {
    const body = rawBody ? JSON.parse(rawBody) : null;
    if (body && body.error) {
      if (typeof body.error === 'string') {
        apiMessage = body.error_description || body.error;
      } else {
        apiMessage = body.error.message || body.error.reason || '';
        apiStatus = body.error.status || '';
        apiReason = body.error.reason || '';
      }
    }
  } catch (parseErr) {
    // Spotify 的 403 有时回纯文本而不是 JSON，例如
    // "Active premium subscription required for the owner of the app."
    // 解析失败时保留原文，否则下面按原因分类的分支全部失效。
    // Spotify sometimes answers 403 with plain text instead of JSON; keep the raw body so
    // the reason-specific branches below still work. Truncated to keep messages readable.
    apiMessage = normalizeText(rawBody).slice(0, 400);
  }
  const statusCode = Number(err.statusCode || apiStatus || 0) || 0;
  const oauthCode = normalizeText(spotifyTokenErrorBody(err).error);
  let code = normalizeText(err.code || oauthCode || (statusCode ? ('SPOTIFY_HTTP_' + statusCode) : err.message)) || 'SPOTIFY_ERROR';
  let message = apiMessage || normalizeText(err.message) || 'Spotify 请求失败';
  const reauthRequired = !!err.reauthRequired || code === 'SPOTIFY_REAUTH_REQUIRED' || oauthCode === 'invalid_grant';
  if (reauthRequired || statusCode === 401 || code === 'SPOTIFY_REFRESH_TOKEN_MISSING') {
    message = 'Spotify 登录已过期，请重新连接 Spotify。';
  } else if (statusCode === 429) {
    const seconds = Math.max(1, Math.ceil(Number(err.retryAfterMs || spotifyRetryAfterMs(err)) / 1000));
    message = apiReason === 'QUOTA_EXCEEDED'
      ? 'Spotify 开发者账号的共享 API 配额已用完，请稍后再试。'
      : 'Spotify 请求过于频繁，请约 ' + seconds + ' 秒后重试。';
  } else if (statusCode === 403) {
    // Spotify 2026-02 收紧后，App 所有者的 Premium 变成硬门槛：即使 OAuth 授权成功、
    // token 完全有效，所有 Web API 调用都会回 403（原文：Active premium subscription
    // required for the owner of the app）。这类限制发生在 Spotify 服务端，代码侧绕不过去，
    // 所以单独给一个错误码，界面才能说清"授权已完成，被拒的是账号侧"。
    // Since Spotify's 2026-02 tightening the app owner's Premium is a hard requirement: even
    // with a valid OAuth token every Web API call answers 403. Nothing can be fixed in code,
    // so this gets its own code and the UI can explain that authorization itself succeeded.
    if (/premium/i.test(apiMessage)) {
      code = 'SPOTIFY_PREMIUM_REQUIRED';
      message = 'Spotify 要求开发应用的所有者持有有效的 Premium 订阅，否则接口一律返回 403。开通或续费后，Spotify 侧最多需要等几小时才会放行。';
    } else {
      message = 'Spotify 拒绝了当前开发应用。请确认 App 所有者是 Premium，并且当前登录账号已加入 Users Management。';
    }
  } else if (statusCode === 404) {
    message = 'Spotify 没找到这个歌单，可能已删除、未公开或当前账号无权访问。';
  } else if (statusCode === 500 || statusCode === 502 || statusCode === 503) {
    message = 'Spotify 服务暂时不可用，Mineradio 已完成有限重试，请稍后再试。';
  } else if (/scope|permission|insufficient/i.test(apiMessage || code)) {
    message = 'Spotify 授权权限不够，请重新连接 Spotify 后再同步歌单。';
  }
  return {
    error: code,
    message,
    statusCode,
    spotifyApiMessage: apiMessage,
    spotifyApiReason: apiReason,
    quotaExceeded: apiReason === 'QUOTA_EXCEEDED',
    retryAfterSeconds: Math.max(0, Math.ceil(Number(err.retryAfterMs || spotifyRetryAfterMs(err)) / 1000)),
    reauthRequired,
    // 这条错误是哪条岔路报的（pathfinder / web-api），以及降级前另一条岔路说了什么。
    // Which branch raised this error, and what the other branch said before falling back.
    channel: normalizeText(err.channel),
    partnerFailure: normalizeText(err.partnerFailure),
  };
}

function spotifyUrl(pathname, params) {
  const cleanPath = String(pathname || '').replace(/^\/+/, '');
  const url = new URL(cleanPath, SPOTIFY_API_BASE + '/');
  Object.keys(params || {}).forEach((key) => {
    const value = params[key];
    if (value == null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function spotifyTokenHeaders(config, useClientSecret) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (useClientSecret && config && config.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret).toString('base64');
  }
  return headers;
}

async function requestSpotifyToken(bodyParams, opts) {
  opts = opts || {};
  const config = getSpotifyOAuthConfig();
  if (!config.clientId) {
    const err = new Error('SPOTIFY_CLIENT_ID_REQUIRED');
    err.code = 'SPOTIFY_CLIENT_ID_REQUIRED';
    err.missing = ['SPOTIFY_CLIENT_ID'];
    throw err;
  }
  bodyParams = Object.assign({ client_id: config.clientId }, bodyParams || {});
  const body = new URLSearchParams(bodyParams).toString();
  return requestJson(SPOTIFY_ACCOUNTS_BASE + '/api/token', {
    method: 'POST',
    timeoutMs: 9000,
    headers: spotifyTokenHeaders(config, !!opts.useClientSecret),
  }, body);
}

async function getSpotifyClientCredentialsAccessToken() {
  const config = getSpotifyOAuthConfig();
  if (!config.clientId || !config.clientSecret) {
    const err = new Error('SPOTIFY_CREDENTIALS_REQUIRED');
    err.status = getSpotifyConfig();
    throw err;
  }
  const now = Date.now();
  if (spotifyClientTokenCache.token && now < spotifyClientTokenCache.expiresAt - 30000) return spotifyClientTokenCache.token;
  if (spotifyClientTokenRefreshPromise) return spotifyClientTokenRefreshPromise;
  spotifyClientTokenRefreshPromise = (async () => {
    const json = await requestSpotifyToken({ grant_type: 'client_credentials' }, { useClientSecret: true });
    const token = normalizeText(json && json.access_token);
    if (!token) throw new Error('SPOTIFY_TOKEN_MISSING');
    const expiresIn = Math.max(60, Number(json.expires_in) || 3600);
    spotifyClientTokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  })().finally(() => { spotifyClientTokenRefreshPromise = null; });
  return spotifyClientTokenRefreshPromise;
}

function spotifyTokenErrorBody(err) {
  try { return err && err.body ? JSON.parse(String(err.body)) : {}; } catch (_) { return {}; }
}

function spotifyInvalidGrant(err) {
  const body = spotifyTokenErrorBody(err);
  return normalizeText(body && body.error).toLowerCase() === 'invalid_grant';
}

function invalidateSpotifyAccessToken() {
  const stored = readStoredSpotifyToken();
  if (!stored.refreshToken) return clearSpotifyToken();
  writeJsonFile(getSpotifyTokenFile(), {
    accessToken: '',
    refreshToken: stored.refreshToken,
    tokenType: stored.tokenType || 'Bearer',
    scope: stored.scope || DEFAULT_SPOTIFY_SCOPES.join(' '),
    expiresAt: 0,
    createdAt: stored.createdAt || 0,
    authorizedAt: stored.authorizedAt || 0,
  });
  return { ok: true, provider: 'spotify', loggedIn: false, tokenConfigured: true };
}

async function refreshSpotifyUserToken() {
  if (spotifyUserTokenRefreshPromise) return spotifyUserTokenRefreshPromise;
  spotifyUserTokenRefreshPromise = (async () => {
    const stored = readStoredSpotifyToken();
    if (!stored.refreshToken) {
      const err = new Error('SPOTIFY_REFRESH_TOKEN_MISSING');
      err.code = 'SPOTIFY_REFRESH_TOKEN_MISSING';
      err.reauthRequired = true;
      throw err;
    }
    try {
      const json = await requestSpotifyToken({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
      });
      const token = normalizeText(json && json.access_token);
      if (!token) throw new Error('SPOTIFY_TOKEN_MISSING');
      saveSpotifyOAuthToken(Object.assign({}, json, {
        refresh_token: json.refresh_token || stored.refreshToken,
        scope: json.scope || stored.scope,
        authorizedAt: stored.authorizedAt || 0,
      }));
      return readStoredSpotifyToken();
    } catch (err) {
      if (spotifyInvalidGrant(err)) {
        clearSpotifyToken();
        err.code = 'SPOTIFY_REAUTH_REQUIRED';
        err.reauthRequired = true;
      }
      throw err;
    }
  })().finally(() => { spotifyUserTokenRefreshPromise = null; });
  return spotifyUserTokenRefreshPromise;
}

async function getSpotifyUserAccessToken(opts) {
  const force = !!(opts && opts.force);
  let stored = readStoredSpotifyToken();
  if (!force && stored.accessToken && Date.now() < stored.expiresAt - 30000) return stored.accessToken;
  // force 只由"上游回了 401"这条路用：本地记的过期时间可能还早，但 Spotify 已经不认了。
  // `force` is only used when upstream answers 401: the stored expiry can still look fine while
  // Spotify has already stopped honouring the token.
  stored = await refreshSpotifyUserToken();
  if (!stored.accessToken) throw new Error('SPOTIFY_TOKEN_MISSING');
  return stored.accessToken;
}

async function getSpotifyApiAccessToken(opts) {
  opts = opts || {};
  if (opts.preferUser !== false) {
    const stored = readStoredSpotifyToken();
    if (stored.accessToken || stored.refreshToken) {
      try {
        return await getSpotifyUserAccessToken();
      } catch (err) {
        if (!getSpotifyConfig().clientCredentialsConfigured) throw err;
      }
    }
  }
  return getSpotifyClientCredentialsAccessToken();
}

// ── Spotify 的第二条通道（pathfinder + spclient，与 Folia 同一条路）─────────────────
// 公开 Web API 的配额是"整个应用"共享的，内置 Client ID 下动不动就 429。Folia 早就改走
// Spotify 自家客户端用的那两个服务，这里照它的写法接一套，独立于原来那条 /v1 的岔路：
// 这条能用就走这条，不能用（哈希被换、网络失败）再退回 Web API。
// The public Web API quota is shared by the whole app and 429s constantly under the bundled
// Client ID. Folia reads through the same two services Spotify's own clients use; this is that
// channel, kept independent of the /v1 path so a failure here degrades instead of breaking.
const SPOTIFY_PARTNER_RETRY_MS = 5 * 60 * 1000;
// 逃生开关：`MINERADIO_SPOTIFY_CHANNEL=web-api` 直接关掉 pathfinder 通道，全部走原来的 /v1。
// 测试也用它把网络桩钉在 Web API 上。
// Escape hatch: `MINERADIO_SPOTIFY_CHANNEL=web-api` disables pathfinder entirely and pins
// everything to the old /v1 path (tests use it to keep their Web API stubs meaningful).
const SPOTIFY_PARTNER_ENABLED = String(process.env.MINERADIO_SPOTIFY_CHANNEL || '').trim().toLowerCase() !== 'web-api';
let spotifyPartnerState = { disabledUntil: 0, lastError: '', retired: [] };
const spotifyPartner = createSpotifyPartner({
  requestJson: partnerRequestJson,
  getAccessToken: () => getSpotifyUserAccessToken(),
  refreshAccessToken: () => getSpotifyUserAccessToken({ force: true }),
  language: 'zh-CN',
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
});

function spotifyPartnerUsable() {
  if (!SPOTIFY_PARTNER_ENABLED) return false;
  return Date.now() >= Number(spotifyPartnerState.disabledUntil || 0);
}

function spotifyPartnerInfo() {
  return {
    channel: spotifyPartnerUsable() ? 'pathfinder' : 'web-api',
    lastError: spotifyPartnerState.lastError || '',
    retiredQueries: spotifyPartnerState.retired.slice(-6),
  };
}

// 通道日志：限流和降级都是"过一会儿就看不见"的状态，而界面只会说一句"过于频繁"，无论
// 真实原因是 /v1 的配额、pathfinder 的哈希失效，还是账号信息读不到。落一份盘，出问题时
// 直接看 userdata/spotify-channel.log 就能分清是哪条岔路在失败。
// Channel log: throttling and fallback both vanish after a while, and the UI can only say
// "too frequent" whatever the real cause is. Written to userdata/spotify-channel.log so the
// failing branch can be told apart without guessing.
function spotifyChannelLogFile() {
  try {
    const tokenFile = getSpotifyConfig().tokenFile || DEFAULT_SPOTIFY_TOKEN_FILE;
    return path.join(path.dirname(tokenFile), 'spotify-channel.log');
  } catch (err) {
    return path.join(PROJECT_ROOT, 'spotify-channel.log');
  }
}

function spotifyChannelLog(line) {
  try {
    const file = spotifyChannelLogFile();
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, '', 'utf8');
    } catch (statErr) {
      // 文件还不存在：下面 append 会创建它。
    }
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', 'utf8');
  } catch (err) {
    // 日志写不进去不该影响任何请求。
  }
}

function noteSpotifyPartnerFailure(err, where) {
  const message = (err && err.message) || String(err || '');
  spotifyPartnerState.lastError = where + ': ' + message;
  spotifyChannelLog('[partner] ' + where + ' 失败：' + message + (err && err.detail ? ' | ' + err.detail : ''));
  console.warn('[SpotifyPartner] ' + where + ' 走不通（' + message + '），本次改用 Web API');
  if (err && err.code === 'SPOTIFY_PARTNER_RETIRED') {
    // 哈希被换掉是"整条通道都失灵"，不是某一次查询的问题：整体降级一段时间，
    // 免得每个请求都先撞一次 400 再退回。到点自动再试。
    spotifyPartnerState.disabledUntil = Date.now() + SPOTIFY_PARTNER_RETRY_MS;
    spotifyPartnerState.retired.push(String(err.partnerQuery || where));
    console.warn('[SpotifyPartner] 持久化查询已失效，' + Math.round(SPOTIFY_PARTNER_RETRY_MS / 60000) + ' 分钟内改走 Web API');
  }
}

// 先走 pathfinder，出错再走 Web API。限流（429）不退回：退回只会再吃一记 429，
// 而且会把冷却窗口踩得更死，直接把限流交回调用方去显示。
// Try the partner channel first, fall back to the Web API on failure. A 429 is *not* a reason to
// fall back: that only adds another throttled call and keeps the window occupied.
async function withSpotifyPartner(where, partnerCall, fallbackCall) {
  let partnerFailure = '';
  if (spotifyPartnerUsable()) {
    try {
      const value = await partnerCall(spotifyPartner);
      noteSpotifyUpstreamSuccess();
      return value;
    } catch (err) {
      err.channel = 'pathfinder';
      if (spotifyRateLimitedError(err) || Number(err && err.statusCode) === 429) {
        noteSpotifyRateLimit(err);
        throw err;
      }
      if (err && err.code === 'SPOTIFY_PARTNER_OWN_PLAYLIST') throw err;
      if (err && err.code === 'SPOTIFY_PARTNER_INVALID_ITEM') throw err;
      partnerFailure = (err && (err.message || err.code)) || '';
      noteSpotifyPartnerFailure(err, where);
    }
  }
  try {
    return await fallbackCall();
  } catch (err) {
    // 降级以后报出来的错是 /v1 的，用户只看到"过于频繁"，看不出真正坏的是另一条路。
    // 把两条岔路的结果都带上去，诊断才有东西可查。
    // After the fallback the visible error belongs to /v1, so "too frequent" hides the branch
    // that actually failed. Carry both outcomes so diagnostics has something to report.
    if (!err.channel) err.channel = 'web-api';
    if (partnerFailure && !err.partnerFailure) err.partnerFailure = partnerFailure;
    throw err;
  }
}

// 冷却窗口只对 Web API 有意义：pathfinder 走的是另一套配额，不能被 /v1 的 429 拦住。
// 否则会出现"通道明明是好的，界面却还在显示限流等待中"。
// The cooldown only applies to the Web API: pathfinder draws on a different quota and must not
// be held back by a /v1 429, or the UI keeps showing "rate limited" while the good channel works.
function spotifyRateLimitGate() {
  if (spotifyPartnerUsable()) return { rateLimited: false, retryAfterSeconds: 0, message: '' };
  return spotifyRateLimitSnapshot();
}

// pathfinder 的曲目过一遍，变成界面认的那套 song 对象。
function mapPartnerSong(entry, index, query) {
  if (!entry || !entry.id || !entry.name) return null;
  const artists = (entry.artists || []).map(artist => ({
    id: artist.id || '',
    name: artist.name,
    mid: artist.id || '',
    uri: artist.uri || '',
  }));
  return {
    provider: 'spotify',
    source: 'spotify',
    type: 'spotify',
    id: entry.id,
    providerSongId: entry.id,
    spotifyId: entry.id,
    uri: entry.uri,
    spotifyUri: entry.uri,
    spotifyUrl: 'https://open.spotify.com/track/' + entry.id,
    name: entry.name,
    artist: entry.artist,
    artists,
    album: entry.album,
    albumId: entry.albumId,
    albumUri: entry.albumUri,
    cover: entry.cover,
    duration: Math.max(0, Math.round((Number(entry.durationMs) || 0) / 1000)),
    durationMs: Number(entry.durationMs) || 0,
    popularity: 0,
    explicit: false,
    fee: 0,
    playable: false,
    playbackMode: 'recommend-match',
    recommendationSource: 'spotify-partner',
    spotifyRank: index,
    spotifyQuery: query || '',
    previewUrl: '',
    restriction: {
      category: 'provider_limited',
      reason: 'spotify_metadata_only',
      message: 'Spotify 提供歌曲资料，播放会自动寻找其它可播版本。',
      action: 'switch_source',
    },
  };
}

// pathfinder 的歌单卡片 → 左侧面板认的那套 playlist 对象。
function mapPartnerPlaylist(card, profileId) {
  if (!card || !card.id) return null;
  const ownerId = normalizeText(card.ownerUsername);
  // 两种情况都算"我的"：owner 对得上，或者 Spotify 说这个账号能改它的曲目。
  // 后者覆盖了"账号 id 与 username 分属两条通道、对不上"的情况，也是 Folia 的判法。
  // Either the owner matches, or Spotify says this account may change its items — Folia's rule,
  // and it covers the case where the profile came from the other channel.
  const owned = (!!profileId && !!ownerId && ownerId === normalizeText(profileId)) || card.canEdit === true;
  return {
    provider: 'spotify',
    source: 'spotify',
    id: card.id,
    name: card.name || 'Spotify Playlist',
    cover: card.cover || '',
    creator: card.ownerName || card.ownerUsername || 'Spotify',
    trackCount: Number(card.trackCount) || 0,
    playCount: 0,
    subscribed: !owned,
    shelfPane: owned ? 'mine' : 'fav',
    public: undefined,
    collaborative: false,
    spotifyUrl: 'https://open.spotify.com/playlist/' + card.id,
    spotifyUri: card.uri || ('spotify:playlist:' + card.id),
  };
}

// pathfinder 的账号信息 → Web API /me 的形状，好让 normalizeSpotifyProfile 继续用同一套。
function partnerAccountAsProfile(account) {
  return {
    id: normalizeText(account && account.id),
    display_name: normalizeText(account && account.nickname),
    images: account && account.avatar ? [{ url: account.avatar, width: 300 }] : [],
    product: account && account.product === 'premium' ? 'premium' : (account && account.product === 'free' ? 'free' : ''),
    country: '',
    partnerChannel: true,
  };
}

function spotifyDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function spotifyRetryAfterMs(err) {
  const seconds = Number(err && err.retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 0;
}

// 冷却状态：全局一份，因为配额是应用级的。任何一次上游 429 都会开一个冷却窗口，
// 冷却期内的调用一律快速失败，不再打网络。
// Cooldown state is global because the quota is app-wide: any upstream 429 opens a window
// during which calls fail fast instead of hitting the network.
function spotifyRateLimitRemainingMs(now) {
  const until = Number(spotifyRateLimitState.until) || 0;
  const left = until - (now || Date.now());
  return left > 0 ? left : 0;
}

function spotifyRateLimitSnapshot() {
  const leftMs = spotifyRateLimitRemainingMs();
  return {
    rateLimited: leftMs > 0,
    retryAfterSeconds: leftMs > 0 ? Math.max(1, Math.ceil(leftMs / 1000)) : 0,
    message: leftMs > 0 ? spotifyRateLimitState.message : '',
  };
}

// 30 分钟的退避写成"约 1800 秒"没人愿意读，超过一分半换成分钟。
// "About 1800 seconds" is unreadable for a 30-minute backoff; switch to minutes past ~90s.
function spotifyWaitLabel(seconds) {
  const total = Math.max(1, Math.round(Number(seconds) || 0));
  return total >= 90 ? Math.round(total / 60) + ' 分钟' : total + ' 秒';
}

function resetSpotifyRateLimit() {
  spotifyRateLimitState = { until: 0, seconds: 0, message: '', strikes: 0 };
}

// 一次成功的上游调用说明配额已经恢复，退避档位归零。
// A successful upstream call proves the quota recovered, so the backoff ladder resets.
function noteSpotifyUpstreamSuccess() {
  if (!spotifyRateLimitState.strikes && !spotifyRateLimitState.until) return;
  resetSpotifyRateLimit();
}

function noteSpotifyRateLimit(err) {
  const detail = spotifyErrorDetails(err);
  if (Number(detail.statusCode) !== 429 && !detail.quotaExceeded) return spotifyRateLimitSnapshot();
  const waitMs = Math.max(
    Number(err && err.retryAfterMs) || 0,
    Number(detail.retryAfterSeconds || 0) * 1000,
    0
  );
  const baseMs = Math.min(SPOTIFY_RATE_LIMIT_MAX_COOLDOWN_MS, Math.max(SPOTIFY_RATE_LIMIT_MIN_COOLDOWN_MS, waitMs));
  const strikes = (Number(spotifyRateLimitState.strikes) || 0) + 1;
  // QUOTA_EXCEEDED 是开发模式的滚动配额（按小时/天计），短退避毫无意义：直接等半小时。
  // QUOTA_EXCEEDED comes from the dev-mode rolling quota (hours, not seconds); short backoffs
  // are pointless, so jump straight to the long wait.
  const cooldownMs = detail.quotaExceeded
    ? SPOTIFY_RATE_LIMIT_MAX_COOLDOWN_MS
    : Math.min(SPOTIFY_RATE_LIMIT_MAX_COOLDOWN_MS, baseMs * Math.pow(2, strikes - 1));
  spotifyRateLimitState = {
    until: Date.now() + cooldownMs,
    seconds: Math.ceil(cooldownMs / 1000),
    message: detail.message || '',
    strikes,
  };
  // 这条日志是下次排查的唯一线索：Spotify 给的 Retry-After、真实原因和我们实际退避了多久。
  // This log is the only breadcrumb next time: what Spotify asked for, the real reason, and how
  // long we actually backed off.
  const line = '[SpotifyRateLimit] 429 retry-after=' + Math.round(waitMs / 1000) + 's cooldown=' +
    Math.round(cooldownMs / 1000) + 's strikes=' + strikes +
    ' channel=' + (detail.channel || '-') +
    ' reason=' + (detail.spotifyApiReason || '-') +
    ' code=' + (typeof detail.error === 'string' && detail.error !== '[object Object]' ? detail.error : '-') +
    (detail.partnerFailure ? ' partner=' + detail.partnerFailure : '');
  console.warn(line);
  spotifyChannelLog(line);
  return spotifyRateLimitSnapshot();
}

// 用 429 的形状构造错误，这样上层（spotifyErrorDetails / 前端）不需要另开一条分支。
// Shaped like a real 429 so callers and the front end need no extra branch.
function spotifyRateLimitError() {
  const snapshot = spotifyRateLimitSnapshot();
  const err = new Error('SPOTIFY_RATE_LIMITED');
  err.code = 'SPOTIFY_RATE_LIMITED';
  err.statusCode = 429;
  err.rateLimited = true;
  err.retryAfterMs = snapshot.retryAfterSeconds * 1000;
  err.body = JSON.stringify({
    error: { status: 429, message: snapshot.message || 'Spotify rate limit in effect' },
  });
  return err;
}

function assertSpotifyUpstreamAllowed() {
  if (spotifyRateLimitRemainingMs() > 0) throw spotifyRateLimitError();
}

function spotifyRateLimitedError(err) {
  if (!err) return false;
  if (err.rateLimited) return true;
  const status = Number(err.statusCode || 0);
  return status === 429;
}

function spotifyTransientError(err) {
  const status = Number(err && err.statusCode || 0);
  return status === 500 || status === 502 || status === 503 ||
    /SPOTIFY_REQUEST_TIMEOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT/i.test(String(err && (err.code || err.message) || ''));
}

async function spotifyUserRequest(pathname, method, params, payload, opts) {
  opts = opts || {};
  if (!opts.ignoreRateLimit) assertSpotifyUpstreamAllowed();
  method = String(method || 'GET').toUpperCase();
  let token = normalizeText(opts.accessToken) || await getSpotifyUserAccessToken();
  const explicitToken = normalizeText(opts.accessToken);
  let authRetried = false;
  let transientAttempt = 0;
  const body = payload == null ? null : JSON.stringify(payload);
  while (true) {
    try {
      const result = await requestJson(spotifyUrl(pathname, params || {}), {
        method,
        timeoutMs: opts.timeoutMs || 9000,
        headers: Object.assign({
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
        }, body == null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }),
      }, body);
      noteSpotifyUpstreamSuccess();
      return result;
    } catch (err) {
      const status = Number(err && err.statusCode || 0);
      if (status === 401 && !explicitToken && !authRetried) {
        authRetried = true;
        invalidateSpotifyAccessToken();
        token = await getSpotifyUserAccessToken();
        continue;
      }
      if (status === 429) {
        const waitMs = spotifyRetryAfterMs(err);
        err.retryAfterMs = waitMs;
        // 先试"窗口快结束"的那一次重试；只有重试也失败（或本来就等不起）才开冷却。
        // 否则一次 10ms 的抖动会把之后 20 秒的正常请求全挡掉。
        // Try the "window is nearly over" retry first and only arm the cooldown when that fails
        // too, otherwise a 10 ms blip would block the next 20 seconds of healthy traffic.
        if (!opts.noRetry && transientAttempt === 0 && waitMs > 0 && waitMs <= SPOTIFY_SHORT_RATE_LIMIT_WAIT_MAX_MS) {
          transientAttempt += 1;
          await spotifyDelay(waitMs);
          continue;
        }
        noteSpotifyRateLimit(err);
      } else if (!opts.noRetry && transientAttempt < SPOTIFY_TRANSIENT_RETRY_DELAYS_MS.length && spotifyTransientError(err)) {
        const waitMs = SPOTIFY_TRANSIENT_RETRY_DELAYS_MS[transientAttempt] + Math.floor(Math.random() * 120);
        transientAttempt += 1;
        await spotifyDelay(waitMs);
        continue;
      }
      throw err;
    }
  }
}

async function spotifyGet(pathname, params, opts) {
  opts = opts || {};
  if (!opts.ignoreRateLimit) assertSpotifyUpstreamAllowed();
  const preferUser = opts.userOnly || opts.preferUser !== false;
  const explicitToken = normalizeText(opts.accessToken);
  let token = explicitToken || (opts.userOnly
    ? await getSpotifyUserAccessToken()
    : await getSpotifyApiAccessToken({ preferUser }));
  let authRetried = false;
  let transientAttempt = 0;
  while (true) {
    try {
      const result = await requestJson(spotifyUrl(pathname, params || {}), {
        timeoutMs: opts.timeoutMs || 9000,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/json',
        },
      });
      noteSpotifyUpstreamSuccess();
      return result;
    } catch (err) {
      const status = Number(err && err.statusCode || 0);
      if (status === 401 && !explicitToken && !authRetried) {
        authRetried = true;
        const stored = readStoredSpotifyToken();
        if (opts.userOnly || (preferUser && (stored.accessToken || stored.refreshToken))) {
          invalidateSpotifyAccessToken();
          token = await getSpotifyUserAccessToken();
        } else {
          spotifyClientTokenCache = { token: '', expiresAt: 0 };
          token = await getSpotifyClientCredentialsAccessToken();
        }
        continue;
      }
      if (status === 429) {
        const waitMs = spotifyRetryAfterMs(err);
        err.retryAfterMs = waitMs;
        if (!opts.noRetry && transientAttempt === 0 && waitMs > 0 && waitMs <= SPOTIFY_SHORT_RATE_LIMIT_WAIT_MAX_MS) {
          transientAttempt += 1;
          await spotifyDelay(waitMs);
          continue;
        }
        noteSpotifyRateLimit(err);
      } else if (!opts.noRetry && transientAttempt < SPOTIFY_TRANSIENT_RETRY_DELAYS_MS.length && spotifyTransientError(err)) {
        const waitMs = SPOTIFY_TRANSIENT_RETRY_DELAYS_MS[transientAttempt] + Math.floor(Math.random() * 120);
        transientAttempt += 1;
        await spotifyDelay(waitMs);
        continue;
      }
      throw err;
    }
  }
}

async function spotifyUserGet(pathname, params, opts) {
  opts = opts || {};
  return spotifyGet(pathname, params, Object.assign({}, opts, { userOnly: true, preferUser: true }));
}

function cacheWrap(map, key, ttlMs, loader) {
  const now = Date.now();
  const cached = map.get(key);
  if (cached && now - cached.at < ttlMs) return Promise.resolve(cached.value);
  if (spotifySearchInflight.has(key)) return spotifySearchInflight.get(key);
  const promise = Promise.resolve(loader()).then((value) => {
    map.set(key, { at: Date.now(), value });
    if (map.size > 80) {
      const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) map.delete(oldest[0]);
    }
    return value;
  }).finally(() => spotifySearchInflight.delete(key));
  spotifySearchInflight.set(key, promise);
  return promise;
}

function spotifyImage(images) {
  images = Array.isArray(images) ? images.filter(item => item && item.url) : [];
  if (!images.length) return '';
  const sorted = images.slice().sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  return sorted[0].url || '';
}

function mapSpotifyTrack(track, index, query) {
  track = track || {};
  const id = normalizeText(track.id);
  const name = normalizeText(track.name);
  if (!id || !name || track.is_local) return null;
  const album = track.album || {};
  const artists = Array.isArray(track.artists) ? track.artists.map(artist => ({
    id: normalizeText(artist && artist.id),
    name: normalizeText(artist && artist.name),
    mid: normalizeText(artist && artist.id),
    uri: normalizeText(artist && artist.uri),
  })).filter(artist => artist.name) : [];
  const artistText = artists.map(artist => artist.name).join(' / ');
  return {
    provider: 'spotify',
    source: 'spotify',
    type: 'spotify',
    id,
    providerSongId: id,
    spotifyId: id,
    uri: normalizeText(track.uri),
    spotifyUri: normalizeText(track.uri),
    spotifyUrl: track.external_urls && track.external_urls.spotify || '',
    name,
    artist: artistText,
    artists,
    album: normalizeText(album.name),
    albumId: normalizeText(album.id),
    albumUri: normalizeText(album.uri),
    cover: spotifyImage(album.images),
    duration: Math.max(0, Math.round((Number(track.duration_ms) || 0) / 1000)),
    durationMs: Number(track.duration_ms) || 0,
    popularity: Number(track.popularity || 0) || 0,
    explicit: !!track.explicit,
    fee: 0,
    playable: false,
    playbackMode: 'recommend-match',
    recommendationSource: 'spotify-web-api',
    spotifyRank: index,
    spotifyQuery: query || '',
    previewUrl: track.preview_url || '',
    restriction: {
      category: 'provider_limited',
      reason: 'spotify_metadata_only',
      message: 'Spotify 官方 Web API 当前作为搜索/歌单资料源接入，播放会自动寻找其它可播版本。',
      action: 'switch_source',
    },
  };
}

function dedupeSpotifySongs(songs) {
  const out = [];
  const seen = new Set();
  (songs || []).forEach((song) => {
    const key = (song.id || '') + '|' + normalizeText(song.name).toLowerCase() + '|' + normalizeText(song.artist).toLowerCase();
    if (!song || !song.name || seen.has(key)) return;
    seen.add(key);
    out.push(song);
  });
  return out;
}

function normalizeSpotifyProfile(profile) {
  profile = profile || {};
  const product = normalizeText(profile.product || '').toLowerCase();
  const isPremium = product === 'premium';
  return {
    userId: normalizeText(profile.id),
    accountId: normalizeText(profile.account_id),
    nickname: normalizeText(profile.display_name || 'Spotify'),
    avatar: spotifyImage(profile.images),
    country: normalizeText(profile.country),
    product: product || 'unknown',
    vipType: isPremium ? 1 : 0,
    vipLevel: isPremium ? 'vip' : 'none',
    vipLabel: isPremium ? 'Premium' : (product ? product.toUpperCase() : '方案未知'),
    membershipKnown: !!product,
    isVip: isPremium,
    isSvip: false,
  };
}

async function getSpotifyProfile(options) {
  options = options || {};
  const now = Date.now();
  if (!options.force && spotifyProfileCache.value && now - spotifyProfileCache.at < SPOTIFY_PROFILE_CACHE_TTL_MS) {
    return spotifyProfileCache.value;
  }
  if (spotifyProfileCache.promise) return spotifyProfileCache.promise;
  spotifyProfileCache.promise = withSpotifyPartner(
    'account',
    () => spotifyPartner.readAccount().then(partnerAccountAsProfile),
    () => spotifyUserGet('/me', {}, { timeoutMs: options.timeoutMs || 9000 })
  )
    .then((profile) => {
      spotifyProfileCache.value = profile || {};
      spotifyProfileCache.at = Date.now();
      return spotifyProfileCache.value;
    })
    .finally(() => { spotifyProfileCache.promise = null; });
  return spotifyProfileCache.promise;
}

// 状态接口只读缓存，账号信息在后台补。失败不阻塞任何人，但要把原因留下来，让下一次
// 状态查询能如实告诉界面"令牌被撤销了"而不是永远说"已登录"。
// The status endpoint only reads the cache; the account is refreshed in the background. A failure
// blocks nobody, but the reason is kept so the next status call can honestly report a revoked token.
function refreshSpotifyProfileInBackground() {
  if (spotifyProfileRefreshPromise) return spotifyProfileRefreshPromise;
  spotifyProfileRefreshPromise = getSpotifyProfile({ force: true, timeoutMs: 9000 })
    .then(() => { spotifyProfileRefreshError = null; })
    .catch((err) => { spotifyProfileRefreshError = spotifyErrorDetails(err); })
    .finally(() => { spotifyProfileRefreshPromise = null; });
  return spotifyProfileRefreshPromise;
}

function buildSpotifyOAuthAuthorizeUrl(options) {
  options = options || {};
  const config = getSpotifyOAuthConfig();
  if (!config.configured) {
    const err = new Error('SPOTIFY_OAUTH_NOT_CONFIGURED');
    err.code = 'SPOTIFY_OAUTH_NOT_CONFIGURED';
    err.missing = config.missing;
    throw err;
  }
  const codeChallenge = normalizeText(options.codeChallenge || options.code_challenge);
  if (!codeChallenge) {
    const err = new Error('SPOTIFY_PKCE_CHALLENGE_REQUIRED');
    err.code = 'SPOTIFY_PKCE_CHALLENGE_REQUIRED';
    throw err;
  }
  const redirectUri = normalizeText(options.redirectUri || config.redirectUri);
  const url = new URL('/authorize', SPOTIFY_ACCOUNTS_BASE + '/');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('scope', normalizeText(options.scope || config.scope || DEFAULT_SPOTIFY_SCOPES.join(' ')));
  if (options.state) url.searchParams.set('state', String(options.state));
  if (options.showDialog) url.searchParams.set('show_dialog', 'true');
  return url.toString();
}

async function exchangeSpotifyOAuthCode(options) {
  options = options || {};
  const config = getSpotifyOAuthConfig();
  if (!config.configured) {
    const err = new Error('SPOTIFY_OAUTH_NOT_CONFIGURED');
    err.code = 'SPOTIFY_OAUTH_NOT_CONFIGURED';
    err.missing = config.missing;
    throw err;
  }
  const code = normalizeText(options.code);
  const codeVerifier = normalizeText(options.codeVerifier || options.code_verifier);
  if (!code) throw new Error('SPOTIFY_OAUTH_CODE_MISSING');
  if (!codeVerifier) throw new Error('SPOTIFY_PKCE_VERIFIER_MISSING');
  const json = await requestSpotifyToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: normalizeText(options.redirectUri || config.redirectUri),
    code_verifier: codeVerifier,
  });
  saveSpotifyOAuthToken(Object.assign({}, json, { newAuthorization: true }));
  // 刚拿到新授权，同步读一次账号：昵称和会员状态要立刻出现在界面上。之后就交给十分钟
  // 缓存和后台刷新，状态接口不再为它等网络。
  // A fresh grant earns one synchronous account read so the name and plan appear immediately;
  // afterwards the 10-minute cache and the background refresh take over.
  try {
    await getSpotifyProfile({ force: true, timeoutMs: 9000 });
  } catch (err) {
    spotifyProfileRefreshError = spotifyErrorDetails(err);
  }
  return handleSpotifyStatus();
}

async function handleSpotifyStatus() {
  const config = getSpotifyConfig();
  const token = readStoredSpotifyToken();
  const hasToken = !!(token.accessToken || token.refreshToken);
  let profile = null;
  let profileError = '';
  let profileErrorDetail = null;
  let loggedIn = false;
  let rateLimit = spotifyRateLimitGate();
  if (hasToken) {
    // 登录态来自本地令牌，不来自 /v1/me。Folia 的 login_status 也是直接读本地会话、零网络，
    // 账号信息最多每 10 分钟刷新一次（ACCOUNT_MAX_AGE_MS）。把 /v1/me 当"状态探测"用，
    // 等于每 45 秒烧掉一次全体用户共享的配额，然后在 429 里自我循环。
    // Sign-in state comes from the stored token, not from /v1/me. Folia's login_status reads the
    // stored session with zero network and refreshes the account at most every 10 minutes; using
    // /v1/me as a status probe burns the shared quota on every poll.
    loggedIn = true;
    const cached = spotifyProfileCache.value;
    if (cached && (cached.id || cached.display_name)) profile = cached;
    const cacheStale = !cached || (Date.now() - Number(spotifyProfileCache.at || 0)) >= SPOTIFY_PROFILE_CACHE_TTL_MS;
    // 缓存过期就在后台补一次，本次不等它：状态接口必须立刻返回。
    // Refresh in the background when stale; this response must stay instant.
    if (cacheStale && !rateLimit.rateLimited) refreshSpotifyProfileInBackground();
    if (spotifyProfileRefreshError) {
      profileErrorDetail = spotifyProfileRefreshError;
      profileError = spotifyProfileRefreshError.message || 'SPOTIFY_PROFILE_FAILED';
    }
  }
  const currentToken = readStoredSpotifyToken();
  const tokenScopes = normalizeScopes(currentToken.scope);
  const missingWriteScopes = [
    'user-library-modify',
    'playlist-modify-private',
    'playlist-modify-public',
  ].filter(scope => !tokenScopes.includes(scope));
  const normalized = normalizeSpotifyProfile(profile);
  return Object.assign({}, config, normalized, {
    clientSecret: '',
    loggedIn,
    configured: !!(config.configured || loggedIn),
    profileReady: loggedIn,
    tokenConfigured: !!(currentToken.accessToken || currentToken.refreshToken),
    tokenReady: !!(currentToken.accessToken && Date.now() < currentToken.expiresAt - 30000),
    authorizedAt: currentToken.authorizedAt || 0,
    stale: !!(!loggedIn && (currentToken.accessToken || currentToken.refreshToken)),
    reauthRequired: !!(profileErrorDetail && profileErrorDetail.reauthRequired),
    // 限流是可恢复的临时状态，必须单独回给界面：它不是登录失效，也不该被当成"接口被拒"。
    // Rate limiting is a temporary, recoverable state and needs its own fields: it is not a lost
    // login and must not be reported as "API refused".
    rateLimited: !!rateLimit.rateLimited,
    retryAfterSeconds: Number(rateLimit.retryAfterSeconds) || 0,
    error: profileErrorDetail && profileErrorDetail.error || profileError || '',
    errorMessage: profileErrorDetail && profileErrorDetail.message || '',
    capabilities: Object.assign({}, config.capabilities, {
      search: !!(config.clientCredentialsConfigured || loggedIn),
      metadata: !!(config.clientCredentialsConfigured || loggedIn),
      userPlaylists: loggedIn,
      likedTracks: loggedIn,
      likeWrite: loggedIn && tokenScopes.includes('user-library-modify'),
      playlistWrite: loggedIn && (
        tokenScopes.includes('playlist-modify-private') ||
        tokenScopes.includes('playlist-modify-public')
      ),
      lyric: false,
      playableUrl: false,
    }),
    missingWriteScopes,
    accountWriteReady: loggedIn && missingWriteScopes.length === 0,
    channel: spotifyPartnerInfo().channel,
    partnerError: spotifyPartnerInfo().lastError || '',
    // 有令牌但 profile 校验失败时，绝不能回"已接入"这种乐观文案：前端会把 message
    // 原样抛给用户，于是"授权成功却提示一切正常、界面仍是未登录"的错位就是这么来的。
    // When a token exists but the profile check failed, never answer with the optimistic
    // "already connected" copy: the front end surfaces `message` verbatim.
    message: rateLimit.rateLimited
      ? ('Spotify 接口正在限流，授权已保存，约 ' + spotifyWaitLabel(rateLimit.retryAfterSeconds || 30) + '后自动重试。不需要重新授权。')
      : (loggedIn
        ? (missingWriteScopes.length
          ? 'Spotify 已连接；重新授权一次后可写入喜欢和歌单。播放仍会自动换源。'
          : 'Spotify 登录态已保存，可同步会员状态、喜欢和歌单；播放仍会自动换源。')
        : (profileErrorDetail && profileErrorDetail.message ? profileErrorDetail.message : config.message)),
  });
}

async function handleSpotifySetupDiagnostics() {
  const config = getSpotifyConfig();
  const token = readStoredSpotifyToken();
  const hasToken = !!(token.accessToken || token.refreshToken);
  const tokenScopes = normalizeScopes(token.scope);
  const checks = [];
  const push = (id, ok, title, message, extra) => {
    checks.push(Object.assign({ id, ok: !!ok, title, message: normalizeText(message) }, extra || {}));
  };

  // 冷却期内一次上游请求都不发：自检要连打 /me、/me/tracks、/me/playlists 三个接口，
  // 在被限流时跑一遍等于把冷却窗口再延长一遍，永远等不到解封。
  // Not a single upstream call during the cooldown: diagnostics fires three endpoints, which on
  // a throttled app only extends the window and the user never gets out.
  const gate = spotifyRateLimitGate();
  if (gate.rateLimited) {
    return {
      provider: 'spotify',
      ok: false,
      ready: false,
      loggedIn: hasToken,
      configured: config.oauthConfigured,
      clientId: config.clientId,
      clientIdValid: config.clientIdValid,
      redirectUri: config.redirectUri,
      redirectValid: config.redirectValid,
      nickname: '',
      product: 'unknown',
      checks: [],
      channel: spotifyPartnerInfo().channel,
      rateLimited: true,
      retryAfterSeconds: gate.retryAfterSeconds,
      currentStep: !config.oauthConfigured ? 1 : (hasToken ? 4 : 3),
      message: 'Spotify 接口正在限流，约 ' + spotifyWaitLabel(gate.retryAfterSeconds) + '后自动重试；授权本身没有问题。',
    };
  }

  push(
    'client',
    !!(config.clientId && config.clientIdValid),
    'Client ID',
    config.clientId && config.clientIdValid ? 'Client ID 格式有效并已安全保存在本机。' : '请粘贴 Spotify Dashboard 中的 Client ID。'
  );
  push(
    'redirect',
    !!config.redirectValid,
    '回调地址',
    config.redirectValid
      ? '回调地址符合 Spotify 的 127.0.0.1 精确匹配规则。'
      : '回调必须使用 Mineradio 显示的 127.0.0.1 地址。',
    { redirectUri: config.redirectUri }
  );
  push(
    'token',
    !!(token.accessToken || token.refreshToken),
    'OAuth 授权',
    token.accessToken || token.refreshToken ? '已取得并保存 PKCE 用户授权。' : '尚未从 Spotify 收到用户授权。'
  );

  let profile = null;
  let profileDetail = null;
  let rateLimited = false;
  if (token.accessToken || token.refreshToken) {
    try {
      profile = await getSpotifyProfile({ force: true, timeoutMs: 9000 });
      push('profile', true, '账号验证', '已通过 Spotify /me 验证：' + normalizeText(profile.display_name || profile.id || 'Spotify 用户') + '。');
    } catch (err) {
      profileDetail = spotifyErrorDetails(err);
      rateLimited = spotifyRateLimitedError(err) || profileDetail.statusCode === 429 || !!profileDetail.quotaExceeded;
      push('profile', false, '账号验证', profileDetail.message, profileDetail);
    }
  } else {
    push('profile', false, '账号验证', '完成 OAuth 授权后由 Mineradio 自动验证。');
  }

  const requiredReadScopes = ['user-read-private', 'user-library-read', 'playlist-read-private'];
  const missingReadScopes = requiredReadScopes.filter(scope => !tokenScopes.includes(scope));
  // pathfinder 不按这些 Web API 的 scope 放行，通道可用时缺 scope 不该判红；
  // 真缺的时候只影响 Web API 那侧的写入，界面上照实说明即可。
  // pathfinder does not gate on these Web API scopes, so a missing one is not a failure while the
  // partner channel works; it only affects writes on the /v1 side.
  const partnerChannel = spotifyPartnerUsable();
  const scopesOk = !!profile && (missingReadScopes.length === 0 || partnerChannel);
  push(
    'scopes',
    scopesOk,
    '权限范围',
    !profile
      ? '等待账号验证。'
      : (missingReadScopes.length
        ? (partnerChannel
          ? '官方客户端通道不需要这些 Web API 权限范围；需要写入收藏或歌单时再重新授权。'
          : '缺少权限：' + missingReadScopes.join(', ') + '，请重新授权。')
        : '账号方案、喜欢歌曲和私人歌单权限齐全。'),
    { missingScopes: missingReadScopes }
  );

  let libraryReady = false;
  let playlistsReady = false;
  if (rateLimited) {
    // /me 已经被限流，后面两个接口只会再吃两记 429；直接标成"等限流解除"。
    // /me is already throttled; the next two calls would just eat two more 429s.
    push('library', false, '喜欢歌曲', 'Spotify 正在限流，稍后自动重试。');
    push('playlists', false, '歌单接口', 'Spotify 正在限流，稍后自动重试。');
  } else if (profile && (missingReadScopes.length === 0 || partnerChannel)) {
    // 这两项走 pathfinder（Spotify 自家客户端的通道），不再消耗 Web API 那点共享配额。
    // Both checks go through pathfinder, the channel Spotify's own clients use, so they no
    // longer spend the tiny shared Web API quota.
    try {
      await withSpotifyPartner(
        'diagnostics.library',
        () => spotifyPartner.likedTracks(0, 1),
        () => spotifyUserGet('/me/tracks', { limit: 1, offset: 0, market: config.market }, { timeoutMs: 9000 })
      );
      libraryReady = true;
      push('library', true, '喜欢歌曲', 'Liked Songs 接口已接通。');
    } catch (err) {
      const detail = spotifyErrorDetails(err);
      push('library', false, '喜欢歌曲', detail.message, detail);
    }
    try {
      await withSpotifyPartner(
        'diagnostics.playlists',
        () => spotifyPartner.libraryPlaylists(0, 1),
        () => spotifyUserGet('/me/playlists', { limit: 1, offset: 0 }, { timeoutMs: 9000 })
      );
      playlistsReady = true;
      push('playlists', true, '歌单接口', '个人歌单接口已接通。');
    } catch (err) {
      const detail = spotifyErrorDetails(err);
      push('playlists', false, '歌单接口', detail.message, detail);
    }
  } else {
    push('library', false, '喜欢歌曲', '权限验证通过后自动检测。');
    push('playlists', false, '歌单接口', '权限验证通过后自动检测。');
  }

  const ready = !!(profile && (missingReadScopes.length === 0 || partnerChannel) && libraryReady && playlistsReady);
  const gateAfter = spotifyRateLimitGate();
  const partnerInfo = spotifyPartnerInfo();
  return {
    provider: 'spotify',
    ok: ready,
    ready,    loggedIn: !!profile || (gateAfter.rateLimited && hasToken),
    configured: config.oauthConfigured,
    clientId: config.clientId,
    clientIdValid: config.clientIdValid,
    redirectUri: config.redirectUri,
    redirectValid: config.redirectValid,
    nickname: normalizeText(profile && (profile.display_name || profile.id)),
    product: normalizeText(profile && profile.product).toLowerCase() || 'unknown',
    checks,
    channel: partnerInfo.channel,
    partner: partnerInfo,
    rateLimited: !!gateAfter.rateLimited,
    retryAfterSeconds: Number(gateAfter.retryAfterSeconds) || 0,
    currentStep: !config.oauthConfigured ? 1 : (!hasToken ? 3 : (ready ? 4 : 3)),
    message: ready
      ? (partnerInfo.channel === 'pathfinder'
        ? 'Spotify 账号、喜欢歌曲和歌单接口均已接通（走 Spotify 官方客户端通道，不占用 Web API 配额）。'
        : 'Spotify 账号、喜欢歌曲和歌单接口均已接通。')
      : (gateAfter.rateLimited
        ? ('Spotify 接口正在限流，约 ' + spotifyWaitLabel(gateAfter.retryAfterSeconds) + '后自动重试；授权本身没有问题。')
        : (profileDetail && profileDetail.message || '按当前步骤继续，Mineradio 会在每一步自动检测。')),
  };
}

async function handleSpotifySearch(keywords, limit, offset) {
  keywords = normalizeText(keywords);
  limit = Math.max(1, Math.min(20, Number(limit) || 8));
  offset = Math.max(0, Number(offset) || 0);
  const status = getSpotifyConfig();
  if (!keywords) return { provider: 'spotify', configured: status.configured, songs: [], message: status.message };
  if (!status.capabilities.search) {
    return {
      provider: 'spotify',
      configured: status.configured,
      songs: [],
      error: 'SPOTIFY_AUTH_REQUIRED',
      reason: 'missing_spotify_auth',
      message: status.message,
      missing: status.oauthMissing && status.oauthMissing.length ? status.oauthMissing : status.missing,
    };
  }
  const cacheKey = [keywords.toLowerCase(), limit, offset, status.market, status.tokenConfigured ? 'user' : 'client'].join('|');
  return cacheWrap(spotifySearchCache, cacheKey, 2 * 60 * 1000, async () => {
    // 搜索走 pathfinder 的 searchTracks（Spotify 自家客户端那条路），失败才退回 /v1/search。
    const page = await withSpotifyPartner('search', async () => {
      const answer = await spotifyPartner.searchTracks(keywords, offset, limit);
      return {
        songs: dedupeSpotifySongs(
          answer.songs.map((song, index) => mapPartnerSong(song, offset + index, keywords)).filter(Boolean)
        ).slice(0, limit),
        rows: answer.rows,
        total: answer.total,
        hasMore: answer.rows >= limit,
      };
    }, async () => {
      const pages = [];
      let pageOffset = offset;
      let hasMore = false;
      let total = 0;
      while (pages.length < limit) {
        const pageLimit = Math.min(SPOTIFY_SEARCH_LIMIT_MAX, limit - pages.length);
        const json = await spotifyGet('/search', {
          q: keywords,
          type: 'track',
          market: status.market,
          limit: pageLimit,
          offset: pageOffset,
        }, { timeoutMs: 9000, preferUser: true });
        const items = json && json.tracks && Array.isArray(json.tracks.items) ? json.tracks.items : [];
        pages.push(...items);
        total = Number(json && json.tracks && json.tracks.total) || total;
        hasMore = !!(json && json.tracks && json.tracks.next);
        if (!items.length || !hasMore) break;
        pageOffset += items.length;
      }
      return {
        songs: dedupeSpotifySongs(pages.map((item, index) => mapSpotifyTrack(item, index, keywords)).filter(Boolean)).slice(0, limit),
        rows: pages.length,
        total,
        hasMore,
      };
    });
    return {
      provider: 'spotify',
      configured: true,
      market: status.market,
      songs: page.songs,
      rawCount: page.rows,
      total: page.total,
      offset,
      limit,
      nextOffset: offset + page.rows,
      hasMore: page.hasMore,
      message: page.songs.length ? '' : 'Spotify 没有返回匹配结果。',
    };
  });
}

async function handleSpotifyRecommendations(limit) {
  limit = Math.max(1, Math.min(SPOTIFY_SEARCH_LIMIT_MAX, Number(limit) || 10));
  const status = getSpotifyConfig();
  const token = readStoredSpotifyToken();
  const scopes = normalizeScopes(token.scope);
  if (!token.accessToken && !token.refreshToken) {
    return {
      provider: 'spotify',
      loggedIn: false,
      songs: [],
      mode: 'unavailable',
      provenance: 'spotify-web-api',
      error: 'SPOTIFY_AUTH_REQUIRED',
      message: '连接 Spotify 后显示你的常听歌曲。',
    };
  }
  const picked = await withSpotifyPartner('recommendations', async () => {
    // pathfinder 里没有"常听歌曲"这条查询，用的就是喜欢的歌 —— 与 Folia 一致。
    const answer = await spotifyPartner.likedTracks(0, limit);
    return {
      songs: dedupeSpotifySongs(answer.songs.map((song, index) => mapPartnerSong(song, index, 'personal')).filter(Boolean)).slice(0, limit),
      mode: 'liked-affinity',
    };
  }, async () => {
    let items = [];
    let mode = '';
    if (scopes.includes('user-top-read')) {
      try {
        const json = await spotifyUserGet('/me/top/tracks', {
          limit,
          offset: 0,
          time_range: 'medium_term',
        }, { timeoutMs: 9000 });
        items = json && Array.isArray(json.items) ? json.items : [];
        mode = 'personal-top';
      } catch (err) {
        console.warn('[SpotifyRecommendations] top tracks:', err.message);
      }
    }
    if (!items.length && scopes.includes('user-library-read')) {
      try {
        const json = await spotifyUserGet('/me/tracks', {
          limit,
          offset: 0,
          market: status.market,
        }, { timeoutMs: 9000 });
        const rows = json && Array.isArray(json.items) ? json.items : [];
        items = rows.map(row => row && row.track).filter(Boolean);
        mode = 'liked-affinity';
      } catch (err) {
        console.warn('[SpotifyRecommendations] liked tracks:', err.message);
      }
    }
    return {
      songs: dedupeSpotifySongs(items.map((item, index) => mapSpotifyTrack(item, index, 'personal')).filter(Boolean)).slice(0, limit),
      mode,
    };
  });
  const songs = picked.songs;
  const mode = picked.mode;
  return {
    provider: 'spotify',
    loggedIn: true,
    songs,
    mode: mode || 'unavailable',
    provenance: 'spotify-web-api',
    updatedAt: Date.now(),
    message: songs.length ? '' : '当前授权没有可读取的常听或喜欢歌曲；重新连接 Spotify 可启用个人推荐。',
  };
}

function mapSpotifyPlaylist(item, profile) {
  item = item || {};
  const id = normalizeText(item.id);
  if (!id) return null;
  const owner = item.owner || {};
  const ownerId = normalizeText(owner.id);
  const profileId = normalizeText(profile && profile.id);
  const owned = !!(profileId && ownerId === profileId);
  return {
    provider: 'spotify',
    source: 'spotify',
    id,
    name: normalizeText(item.name || 'Spotify Playlist'),
    cover: spotifyImage(item.images),
    creator: normalizeText(owner.display_name || owner.id || 'Spotify'),
    trackCount: Number(item.items && item.items.total) || Number(item.tracks && item.tracks.total) || 0,
    playCount: 0,
    subscribed: !owned,
    shelfPane: owned ? 'mine' : 'fav',
    public: item.public,
    collaborative: !!item.collaborative,
    spotifyUrl: item.external_urls && item.external_urls.spotify || '',
    spotifyUri: normalizeText(item.uri),
  };
}

async function buildSpotifyLikedPlaylistCard(profile) {
  try {
    // 喜欢的第一行 + 总数：pathfinder 一次就够，不用再打 /me/tracks。
    const head = await withSpotifyPartner('liked-card', async () => {
      const answer = await spotifyPartner.likedTracks(0, 1);
      return { cover: answer.songs[0] ? answer.songs[0].cover : '', total: answer.total };
    }, async () => {
      const json = await spotifyUserGet('/me/tracks', { limit: 1, offset: 0, market: getSpotifyConfig().market }, { timeoutMs: 9000 });
      const first = json && Array.isArray(json.items) && json.items[0] && json.items[0].track;
      return { cover: first ? spotifyImage(first.album && first.album.images) : '', total: Number(json && json.total) || 0 };
    });
    return {
      provider: 'spotify',
      source: 'spotify',
      id: SPOTIFY_LIKED_PLAYLIST_ID,
      virtual: true,
      name: 'Spotify 喜欢的歌曲',
      cover: head.cover,
      creator: normalizeText(profile && (profile.display_name || profile.id)) || 'Spotify',
      trackCount: head.total,
      playCount: 0,
      subscribed: false,
      shelfPane: 'fav',
    };
  } catch (err) {
    const detail = spotifyErrorDetails(err);
    return {
      provider: 'spotify',
      source: 'spotify',
      id: SPOTIFY_LIKED_PLAYLIST_ID,
      virtual: true,
      name: 'Spotify 喜欢的歌曲',
      cover: '',
      creator: normalizeText(profile && (profile.display_name || profile.id)) || 'Spotify',
      trackCount: 0,
      playCount: 0,
      subscribed: false,
      shelfPane: 'fav',
      warning: detail.message,
      error: detail.error,
      message: detail.message,
    };
  }
}

// 一页卡片全是 0 才值得去补：只要有一张带数，说明这个通道本来就会给，缺的那几张可能是真空歌单。
// Only a page where every card is zero is worth spending a call on: one non-zero card proves the
// channel does report counts, so the remaining zeros are probably playlists that are really empty.
function spotifyPlaylistCountsMissing(playlists) {
  return Array.isArray(playlists) && playlists.length > 0
    && playlists.every(pl => !(pl && Number(pl.trackCount) > 0));
}

// Web API 的曲目数按 id 贴回卡片（顺序可能因为文件夹展开而与 pathfinder 不同，只认 id）。
// Match by id, not by position: folder flattening can reorder the two lists.
function applySpotifyPlaylistTrackCounts(playlists, items) {
  const counts = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const id = normalizeText(item && item.id);
    const total = Number(item && item.tracks && item.tracks.total);
    if (id && Number.isFinite(total) && total >= 0) counts.set(id, total);
  });
  let filled = 0;
  (Array.isArray(playlists) ? playlists : []).forEach((pl) => {
    if (!pl || !counts.has(pl.id)) return;
    const next = counts.get(pl.id);
    if (Number(pl.trackCount) === next) return;
    pl.trackCount = next;
    filled += 1;
  });
  return filled;
}

// pathfinder 的库列表若没带曲目数（整页都是 0），用一次 Web API 把卡片上的「N 首」补齐。
// 只补一次、只补这一页：限流 / 未授权 / 超时都只是"这次补不上"，列表照旧返回 0 首，
// 不会比现在更糟，也不会为了几行小字去翻完整库。
// When the pathfinder library listing carries no track counts (a whole page of zeros), fill them
// with one Web API call. Throttling or a missing scope just means "this time we could not", and
// the rows still come back — a single call, never a per-playlist fan-out.
async function fillMissingSpotifyPlaylistCounts(playlists, offset) {
  if (!spotifyPlaylistCountsMissing(playlists)) return;
  try {
    const json = await spotifyUserGet('/me/playlists', {
      limit: Math.min(50, Math.max(playlists.length, 20)),
      offset: Math.max(0, Number(offset) || 0),
    }, { timeoutMs: 8000, noRetry: true });
    applySpotifyPlaylistTrackCounts(playlists, json && json.items);
  } catch (_) {
    // 补不上就算了：曲目数只是卡片上的一行小字，不该让整个列表失败。
  }
}

async function handleSpotifyUserPlaylists(options) {
  options = options || {};
  // 冷却期内直接回一条"限流中"，不要走 handleSpotifyStatus + /me + /me/playlists 那一串：
  // 那会在限流时再多打两次网络，而且 500 会让左侧面板把已有歌单当成"全部加载失败"。
  // During the cooldown answer straight away instead of walking status + /me + /me/playlists:
  // that would fire two more throttled calls, and a 500 makes the panel treat cached rows as
  // completely broken.
  const gate = spotifyRateLimitGate();
  if (gate.rateLimited) {
    const stored = readStoredSpotifyToken();
    return {
      provider: 'spotify',
      loggedIn: !!(stored.accessToken || stored.refreshToken),
      playlists: [],
      total: 0,
      offset: 0,
      limit: 0,
      nextOffset: 0,
      hasMore: false,
      partial: true,
      authExpired: false,
      rateLimited: true,
      retryAfterSeconds: gate.retryAfterSeconds,
      error: 'SPOTIFY_RATE_LIMITED',
      message: 'Spotify 接口正在限流，约 ' + spotifyWaitLabel(gate.retryAfterSeconds) + '后自动重试。',
    };
  }
  const status = await handleSpotifyStatus();
  if (!status.loggedIn) {
    return { provider: 'spotify', loggedIn: false, playlists: [], message: status.message, error: status.error || '' };
  }
  const profile = await getSpotifyProfile({ timeoutMs: 9000 });
  const maxTotal = Math.max(1, Math.min(500, Number(options.limit) || 300));
  const playlists = [];
  const startOffset = Math.max(0, Number(options.offset) || 0);
  let offset = startOffset;
  let playlistError = null;
  let remoteTotal = 0;
  let hasRemoteMore = false;
  // 一页歌单：pathfinder 的 libraryV3 优先，失败退回 /me/playlists。
  const readPlaylistPage = (pageOffset, pageLimit) => withSpotifyPartner('playlists', async () => {
    const answer = await spotifyPartner.libraryPlaylists(pageOffset, pageLimit);
    return {
      playlists: answer.playlists.map(card => mapPartnerPlaylist(card, profile && profile.id)).filter(Boolean),
      rows: answer.rows,
      total: answer.total,
    };
  }, async () => {
    const json = await spotifyUserGet('/me/playlists', { limit: pageLimit, offset: pageOffset }, { timeoutMs: 9000 });
    const items = Array.isArray(json && json.items) ? json.items : [];
    return {
      playlists: items.map(item => mapSpotifyPlaylist(item, profile)).filter(Boolean),
      rows: items.length,
      total: Number(json && json.total) || 0,
      hasMore: !!(json && json.next),
    };
  });
  try {
    while (playlists.length < maxTotal) {
      const pageLimit = Math.min(SPOTIFY_PLAYLIST_PAGE_LIMIT, maxTotal - playlists.length);
      const page = await readPlaylistPage(offset, pageLimit);
      page.playlists.forEach((item) => { playlists.push(item); });
      remoteTotal = Number(page.total) || remoteTotal;
      if (page.hasMore === undefined) {
        // pathfinder 不返回"有没有下一页"，用总数和已取行数自己算。
        hasRemoteMore = remoteTotal > 0 ? (offset + page.rows) < remoteTotal : page.rows >= pageLimit;
      } else {
        hasRemoteMore = !!page.hasMore;
      }
      if (!page.rows || page.rows < pageLimit || !hasRemoteMore) break;
      offset += page.rows;
    }
  } catch (err) {
    playlistError = spotifyErrorDetails(err);
  }
  await fillMissingSpotifyPlaylistCounts(playlists, startOffset);
  const likedCard = await buildSpotifyLikedPlaylistCard(profile);
  const total = Math.max(playlists.length + startOffset, remoteTotal) + 1;
  const nextOffset = startOffset + playlists.length;
  return {
    provider: 'spotify',
    loggedIn: true,
    userId: normalizeText(profile && profile.id),
    playlists: (startOffset === 0 ? [likedCard] : []).concat(playlists),
    total,
    offset: startOffset,
    limit: maxTotal,
    nextOffset,
    hasMore: hasRemoteMore && nextOffset < total,
    partial: true,
    error: playlistError && playlistError.error || '',
    message: playlistError && playlistError.message || '',
  };
}

async function handleSpotifyPlaylistTracks(playlistId, opts) {
  opts = opts || {};
  playlistId = normalizeText(playlistId);
  const status = await handleSpotifyStatus();
  if (!status.loggedIn) {
    return { provider: 'spotify', loggedIn: false, playlist: { id: playlistId, provider: 'spotify', name: '' }, tracks: [], message: status.message, error: status.error || '' };
  }
  const limit = Math.max(1, Math.min(SPOTIFY_PLAYLIST_PAGE_LIMIT, Number(opts.limit) || 48));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const market = normalizeText(opts.market || status.market || DEFAULT_SPOTIFY_MARKET);
  if (!playlistId || playlistId === SPOTIFY_LIKED_PLAYLIST_ID || playlistId === 'liked') {
    let page = null;
    try {
      // 喜欢的歌走 pathfinder 的 fetchLibraryTracks：一条查询，不吃 Web API 配额。
      page = await withSpotifyPartner('liked-tracks', async () => {
        const answer = await spotifyPartner.likedTracks(offset, limit);
        return {
          tracks: answer.songs.map((song, index) => mapPartnerSong(song, offset + index, 'liked')).filter(Boolean),
          rows: answer.rows,
          total: answer.total,
        };
      }, async () => {
        const json = await spotifyUserGet('/me/tracks', { limit, offset, market }, { timeoutMs: 12000 });
        const items = Array.isArray(json && json.items) ? json.items : [];
        return {
          tracks: items.map((item, index) => mapSpotifyTrack(item && item.track, offset + index, 'liked')).filter(Boolean),
          rows: items.length,
          total: Number(json && json.total) || 0,
        };
      });
    } catch (err) {
      const detail = spotifyErrorDetails(err);
      return Object.assign({
        provider: 'spotify',
        loggedIn: true,
        playlist: {
          provider: 'spotify',
          id: SPOTIFY_LIKED_PLAYLIST_ID,
          name: 'Spotify 喜欢的歌曲',
          trackCount: 0,
        },
        tracks: [],
        total: 0,
        offset,
        limit,
        nextOffset: offset,
        hasMore: false,
        partial: true,
      }, detail);
    }
    return {
      provider: 'spotify',
      loggedIn: true,
      playlist: {
        provider: 'spotify',
        id: SPOTIFY_LIKED_PLAYLIST_ID,
        name: 'Spotify 喜欢的歌曲',
        trackCount: page.total || page.tracks.length,
      },
      tracks: page.tracks,
      total: page.total || page.tracks.length,
      offset,
      limit,
      nextOffset: offset + page.rows,
      hasMore: page.rows >= limit,
      partial: true,
    };
  }
  let json = null;
  let partnerPage = null;
  try {
    // 歌单内容走 pathfinder 的 fetchPlaylist：连"关注的他人歌单"也能展开，不再受 /v1 的 403 限制。
    partnerPage = await withSpotifyPartner('playlist-tracks', async () => {
      const answer = await spotifyPartner.playlistTracks(playlistId, offset, limit);
      return {
        tracks: answer.songs.map((song, index) => mapPartnerSong(song, offset + index, playlistId)).filter(Boolean),
        rows: answer.rows,
        total: answer.total,
        playlist: answer.playlist,
      };
    }, async () => null);
  } catch (err) {
    partnerPage = null;
    console.warn('[SpotifyPlaylistTracks] ' + err.message);
  }
  if (partnerPage) {
    const card = partnerPage.playlist || {};
    return {
      provider: 'spotify',
      loggedIn: true,
      playlist: {
        provider: 'spotify',
        id: playlistId,
        name: card.name || '',
        cover: card.cover || '',
        creator: card.ownerName || card.ownerUsername || '',
        trackCount: partnerPage.total || partnerPage.tracks.length,
        spotifyUri: card.uri || ('spotify:playlist:' + playlistId),
      },
      tracks: partnerPage.tracks,
      total: partnerPage.total || partnerPage.tracks.length,
      offset,
      limit,
      nextOffset: offset + partnerPage.rows,
      hasMore: partnerPage.rows >= limit,
      partial: true,
    };
  }
  try {
    json = await spotifyUserGet('/playlists/' + encodeURIComponent(playlistId) + '/items', { limit, offset, market }, { timeoutMs: 12000 });
  } catch (err) {
    const detail = spotifyErrorDetails(err);
    if (detail.statusCode === 403) {
      const storedScopes = normalizeScopes(readStoredSpotifyToken().scope);
      const requiredScopes = ['playlist-read-private', 'playlist-read-collaborative'];
      const missingScopes = requiredScopes.filter(scope => !storedScopes.includes(scope));
      if (missingScopes.length) {
        detail.message = 'Spotify 当前授权缺少歌单读取范围，请在账号页重新授权后再试。';
        detail.error = 'SPOTIFY_PLAYLIST_SCOPE_REQUIRED';
        detail.missingScopes = missingScopes;
      } else {
        detail.message = 'Spotify 当前只允许展开本账号自己创建或参与协作的歌单；关注的他人歌单只能同步名称和封面。';
        detail.error = 'SPOTIFY_PLAYLIST_ITEMS_RESTRICTED';
      }
    }
    return Object.assign({
      provider: 'spotify',
      loggedIn: true,
      playlist: {
        provider: 'spotify',
        id: playlistId,
        name: '',
        trackCount: 0,
      },
      tracks: [],
      total: 0,
      offset,
      limit,
      nextOffset: offset,
      hasMore: false,
      partial: true,
    }, detail);
  }
  const items = Array.isArray(json && json.items) ? json.items : [];
  const tracks = items.map((entry, index) => {
    const item = entry && (entry.item || entry.track);
    if (item && item.type && item.type !== 'track') return null;
    return mapSpotifyTrack(item, offset + index, playlistId);
  }).filter(Boolean);
  return {
    provider: 'spotify',
    loggedIn: true,
    playlist: {
      provider: 'spotify',
      id: playlistId,
      name: '',
      trackCount: Number(json && json.total) || tracks.length,
    },
    tracks,
    total: Number(json && json.total) || tracks.length,
    offset,
    limit,
    nextOffset: offset + items.length,
    hasMore: !!(json && json.next),
    partial: true,
  };
}

async function handleSpotifyAlbumDetail(albumId, opts) {
  opts = opts || {};
  const id = normalizeText(albumId);
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit || '80', 10) || 80));
  const market = normalizeText(opts.market || getSpotifyConfig().market);
  if (!id) return { provider: 'spotify', error: 'MISSING_ALBUM_ID', album: null, songs: [] };
  const partnerAlbum = await withSpotifyPartner('album', async () => {
    const songs = [];
    let card = null;
    let total = 0;
    let offset = 0;
    while (songs.length < limit) {
      // pathfinder 的 getAlbum 一次最多给一百行，长专辑照样按 offset 接着读。
      const page = await spotifyPartner.album(id, offset, Math.min(100, limit - songs.length));
      card = card || page.album;
      total = page.total || total;
      songs.push(...page.songs.map(song => mapPartnerSong(song, songs.length, 'album:' + id)).filter(Boolean));
      offset += page.rows;
      if (!page.rows || offset >= total) break;
    }
    return { card, songs: songs.slice(0, limit), total };
  }, async () => null);
  if (partnerAlbum && partnerAlbum.card) {
    const card = partnerAlbum.card;
    return {
      provider: 'spotify',
      album: {
        provider: 'spotify',
        id: card.id,
        albumId: card.id,
        name: card.name,
        artist: card.artist,
        artists: card.artists,
        cover: card.cover,
        releaseDate: card.releaseDate,
        trackCount: card.trackCount || partnerAlbum.total || 0,
        spotifyUrl: 'https://open.spotify.com/album/' + card.id,
        spotifyUri: card.uri,
      },
      songs: partnerAlbum.songs,
      total: card.trackCount || partnerAlbum.total || partnerAlbum.songs.length,
    };
  }
  const params = market ? { market } : {};
  const album = await spotifyGet('/albums/' + encodeURIComponent(id), params, { timeoutMs: 12000 });
  const albumInfo = {
    provider: 'spotify',
    id: normalizeText(album && album.id) || id,
    albumId: normalizeText(album && album.id) || id,
    name: normalizeText(album && album.name),
    artist: Array.isArray(album && album.artists) ? album.artists.map(artist => normalizeText(artist && artist.name)).filter(Boolean).join(' / ') : '',
    artists: Array.isArray(album && album.artists) ? album.artists.map(artist => ({ id: normalizeText(artist && artist.id), name: normalizeText(artist && artist.name), uri: normalizeText(artist && artist.uri) })).filter(artist => artist.name) : [],
    cover: spotifyImage(album && album.images),
    releaseDate: normalizeText(album && album.release_date),
    trackCount: Number(album && album.total_tracks) || 0,
    spotifyUrl: album && album.external_urls && album.external_urls.spotify || '',
    spotifyUri: normalizeText(album && album.uri),
  };
  let items = album && album.tracks && Array.isArray(album.tracks.items) ? album.tracks.items.slice() : [];
  let offset = items.length;
  while (items.length < limit && album && album.tracks && album.tracks.next) {
    const page = await spotifyGet('/albums/' + encodeURIComponent(id) + '/tracks', {
      limit: Math.min(50, limit - items.length),
      offset,
      ...(market ? { market } : {}),
    }, { timeoutMs: 12000 });
    const pageItems = Array.isArray(page && page.items) ? page.items : [];
    items = items.concat(pageItems);
    offset += pageItems.length;
    if (!page || !page.next || !pageItems.length) break;
  }
  const songs = items.slice(0, limit).map((track, index) => {
    if (!track) return null;
    return mapSpotifyTrack(Object.assign({}, track, {
      album: {
        id: albumInfo.albumId,
        name: albumInfo.name,
        uri: albumInfo.spotifyUri,
        images: album && album.images,
      },
    }), index, 'album:' + id);
  }).filter(Boolean);
  return {
    provider: 'spotify',
    album: albumInfo,
    songs,
    total: albumInfo.trackCount || songs.length,
  };
}

function spotifyLibraryUri(type, value) {
  type = normalizeText(type || 'track').toLowerCase();
  value = normalizeText(value && typeof value === 'object'
    ? (value.spotifyUri || value.uri || value.spotifyId || value.providerSongId || value.albumId || value.id)
    : value);
  if (/^spotify:(?:track|album|playlist|episode|show|audiobook|artist|user):[^:]+$/i.test(value)) return value;
  value = value.replace(/^spotify:(?:track|album|playlist):/i, '');
  if (!/^(?:track|album|playlist|episode|show|audiobook|artist|user)$/.test(type) || !value) return '';
  return 'spotify:' + type + ':' + value;
}

function requireSpotifyScopes(required) {
  required = uniqueList(required);
  const granted = normalizeScopes(readStoredSpotifyToken().scope);
  const missing = required.filter(scope => !granted.includes(scope));
  if (!missing.length) return;
  const err = new Error('SPOTIFY_WRITE_SCOPE_REQUIRED');
  err.code = 'SPOTIFY_WRITE_SCOPE_REQUIRED';
  err.statusCode = 403;
  err.missingScopes = missing;
  err.reauthRequired = true;
  throw err;
}

async function handleSpotifyLibraryCheck(type, values) {
  const raw = Array.isArray(values) ? values : String(values == null ? '' : values).split(',');
  const pairs = raw.map(value => ({
    id: normalizeText(value && typeof value === 'object'
      ? (value.spotifyId || value.providerSongId || value.albumId || value.id || value.spotifyUri || value.uri)
      : value),
    uri: spotifyLibraryUri(type, value),
  })).filter(item => item.id && item.uri).slice(0, 40);
  if (!pairs.length) return { provider: 'spotify', ids: [], liked: {} };
  const liked = await withSpotifyPartner('library-check', async () => {
    const saved = await spotifyPartner.libraryLookup(pairs.map(item => item.uri));
    const valuesOut = {};
    pairs.forEach((item) => { valuesOut[item.id] = saved[item.uri] === true; });
    return valuesOut;
  }, async () => {
    const result = await spotifyUserGet('/me/library/contains', {
      uris: pairs.map(item => item.uri).join(','),
    }, { timeoutMs: 9000 });
    const valuesOut = Array.isArray(result) ? result : [];
    const check = {};
    pairs.forEach((item, index) => { check[item.id] = !!valuesOut[index]; });
    return check;
  });
  return {
    provider: 'spotify',
    loggedIn: true,
    ids: pairs.map(item => item.id),
    liked,
  };
}

async function handleSpotifyLibrarySet(type, value, saved) {
  const uri = spotifyLibraryUri(type, value);
  if (!uri) {
    const err = new Error('SPOTIFY_ITEM_ID_REQUIRED');
    err.code = 'SPOTIFY_ITEM_ID_REQUIRED';
    throw err;
  }
  // pathfinder 的收藏改动由账号权限决定，不再看令牌里有没有 user-library-modify；
  // 只有退回 Web API 时才要那道 scope 门。
  await withSpotifyPartner('library-set', async () => {
    await spotifyPartner.setLibrary(uri, saved !== false);
    return true;
  }, async () => {
    requireSpotifyScopes(['user-library-modify']);
    await spotifyUserRequest('/me/library', saved === false ? 'DELETE' : 'PUT', { uris: uri }, null, { timeoutMs: 9000 });
    return true;
  });
  return {
    provider: 'spotify',
    loggedIn: true,
    id: uri.split(':').pop(),
    uri,
    liked: saved !== false,
    saved: saved !== false,
    success: true,
  };
}

async function handleSpotifyPlaylistAddSong(playlistId, song) {
  playlistId = normalizeText(playlistId).replace(/^spotify:/i, '');
  const uri = spotifyLibraryUri('track', song);
  if (!playlistId || !uri) {
    const err = new Error('SPOTIFY_PLAYLIST_OR_TRACK_REQUIRED');
    err.code = 'SPOTIFY_PLAYLIST_OR_TRACK_REQUIRED';
    throw err;
  }
  const added = await withSpotifyPartner('playlist-add', async () => {
    const result = await spotifyPartner.addToPlaylist(playlistId, [uri.split(':').pop()]);
    return result;
  }, async () => {
    const tokenScopes = normalizeScopes(readStoredSpotifyToken().scope);
    if (!tokenScopes.includes('playlist-modify-private') && !tokenScopes.includes('playlist-modify-public')) {
      requireSpotifyScopes(['playlist-modify-private']);
    }
    const result = await spotifyUserRequest(
      '/playlists/' + encodeURIComponent(playlistId) + '/items',
      'POST',
      {},
      { uris: [uri] },
      { timeoutMs: 10000 }
    );
    return { snapshotId: normalizeText(result && result.snapshot_id) };
  });
  return {
    provider: 'spotify',
    loggedIn: true,
    pid: playlistId,
    id: uri.split(':').pop(),
    uri,
    snapshotId: normalizeText(added && added.snapshotId),
    alreadyThere: !!(added && added.added === 0),
    success: true,
  };
}

async function handleSpotifyCreatePlaylist(name, opts) {
  opts = opts || {};
  name = normalizeText(name);
  if (!name) {
    const err = new Error('SPOTIFY_PLAYLIST_NAME_REQUIRED');
    err.code = 'SPOTIFY_PLAYLIST_NAME_REQUIRED';
    throw err;
  }
  const isPublic = opts.public === true;
  const profile = await getSpotifyProfile({ timeoutMs: 9000 });
  const created = await withSpotifyPartner('playlist-create', async () => {
    const made = await spotifyPartner.createPlaylist(name);
    return {
      id: made.id,
      card: mapPartnerPlaylist({
        id: made.id,
        uri: made.uri,
        name: made.name,
        cover: '',
        ownerName: normalizeText(profile && (profile.display_name || profile.id)),
        ownerUsername: normalizeText(profile && profile.id),
        trackCount: 0,
      }, profile && profile.id),
      body: { id: made.id, uri: made.uri, name: made.name },
    };
  }, async () => {
    requireSpotifyScopes([isPublic ? 'playlist-modify-public' : 'playlist-modify-private']);
    const body = await spotifyUserRequest('/me/playlists', 'POST', {}, {
      name,
      public: isPublic,
      collaborative: false,
      description: normalizeText(opts.description || 'Created with Mineradio'),
    }, { timeoutMs: 10000 });
    return { id: normalizeText(body && body.id), card: mapSpotifyPlaylist(body, profile), body };
  });
  return {
    provider: 'spotify',
    loggedIn: true,
    playlist: created.card,
    body: created.body,
    success: true,
  };
}

async function handleSpotifySongUrl(track) {
  const id = normalizeText(track && (track.id || track.providerSongId || track.spotifyId));
  return {
    provider: 'spotify',
    id,
    url: '',
    playable: false,
    playbackMode: 'recommend-match',
    reason: 'provider_limited',
    restriction: {
      category: 'provider_limited',
      reason: 'spotify_metadata_only',
      message: 'Spotify 官方 Web API 不提供可交给 Mineradio 播放的音频直链，正在自动换源。',
      action: 'switch_source',
    },
  };
}

function lrcTimestamp(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return '[' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + '.' + String(hundredths).padStart(2, '0') + ']';
}

async function handleSpotifyLyric(id) {
  const trackId = normalizeText(id);
  // Spotify 自己的歌词在 spclient 上（color-lyrics），与 Web API 无关；Folia 也是这么取的。
  const lyrics = await withSpotifyPartner('lyrics', async () => {
    const answer = await spotifyPartner.lyrics(trackId);
    if (!answer || !answer.lines.length) return null;
    return {
      timed: answer.timed,
      lyric: answer.lines
        .map(line => lrcTimestamp(line.startMs) + line.words.replace(/\s*\n\s*/g, ' ').trim())
        .join('\n'),
    };
  }, async () => null);
  if (lyrics && lyrics.timed && lyrics.lyric) {
    return {
      provider: 'spotify',
      id: trackId,
      lyric: lyrics.lyric,
      tlyric: '',
      yrc: '',
      ytlrc: '',
      source: 'spotify',
      message: '',
    };
  }
  return {
    provider: 'spotify',
    id: trackId,
    lyric: '',
    tlyric: '',
    yrc: '',
    ytlrc: '',
    source: 'none',
    message: 'Spotify 这次没有给出这首歌词，Mineradio 会沿用跨平台歌词兜底。',
  };
}

function resetSpotifyRuntimeStateForTests() {
  spotifyClientTokenCache = { token: '', expiresAt: 0 };
  spotifyClientTokenRefreshPromise = null;
  spotifyUserTokenRefreshPromise = null;
  spotifyProfileCache = { value: null, at: 0, promise: null };
  spotifyProfileRefreshPromise = null;
  spotifyProfileRefreshError = null;
  spotifySearchCache.clear();
  spotifySearchInflight.clear();
  spotifyPartnerState = { disabledUntil: 0, lastError: '', retired: [] };
  resetSpotifyRateLimit();
}

module.exports = {
  getSpotifyConfig,
  getSpotifyOAuthConfig,
  saveSpotifyConfig,
  buildSpotifyOAuthAuthorizeUrl,
  exchangeSpotifyOAuthCode,
  saveSpotifyOAuthToken,
  clearSpotifyToken,
  handleSpotifyStatus,
  handleSpotifySetupDiagnostics,
  handleSpotifySearch,
  handleSpotifyRecommendations,
  handleSpotifyUserPlaylists,
  handleSpotifyPlaylistTracks,
  handleSpotifyAlbumDetail,
  handleSpotifyLibraryCheck,
  handleSpotifyLibrarySet,
  handleSpotifyPlaylistAddSong,
  handleSpotifyCreatePlaylist,
  handleSpotifySongUrl,
  handleSpotifyLyric,
  SPOTIFY_SEARCH_LIMIT_MAX,
  SPOTIFY_LIKED_PLAYLIST_ID,
  _test: {
    getSpotifyUserAccessToken,
    getSpotifyProfile,
    spotifyGet,
    spotifyUserGet,
    spotifyUserRequest,
    spotifyLibraryUri,
    requireSpotifyScopes,
    spotifyErrorDetails,
    normalizeSpotifyProfile,
    spotifyClientIdLooksValid,
    inspectSpotifyRedirectUri,
    readStoredSpotifyToken,
    invalidateSpotifyAccessToken,
    resetSpotifyRuntimeStateForTests,
    spotifyRateLimitSnapshot,
    resetSpotifyRateLimit,
    spotifyPartner,
    spotifyPartnerInfo,
    spotifyPartnerUsable,
    mapPartnerSong,
    mapPartnerPlaylist,
    spotifyPlaylistCountsMissing,
    applySpotifyPlaylistTrackCounts,
  },
};
