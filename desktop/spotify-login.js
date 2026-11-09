'use strict';

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PARTITION = 'persist:mineradio-spotify-login';
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

function createSpotifyLogin({
  shell,
  session,
  getSpotifyOAuthConfig,
  buildSpotifyOAuthAuthorizeUrl,
  exchangeSpotifyOAuthCode,
  clearSpotifyToken,
  partition = DEFAULT_PARTITION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const SPOTIFY_LOGIN_PARTITION = partition;
  const SPOTIFY_OAUTH_TIMEOUT_MS = timeoutMs;

  function base64Url(buffer) {
    return Buffer.from(buffer)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  function createSpotifyPkcePair() {
    const codeVerifier = base64Url(crypto.randomBytes(48));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    return { codeVerifier, codeChallenge };
  }

  function spotifyOAuthRedirectMatches(targetUrl, redirectUri) {
    try {
      const target = new URL(String(targetUrl || ''));
      const redirect = new URL(String(redirectUri || ''));
      const normalizePath = (value) => (value || '/').replace(/\/+$/, '') || '/';
      return target.protocol === redirect.protocol &&
        target.host === redirect.host &&
        normalizePath(target.pathname) === normalizePath(redirect.pathname);
    } catch (e) {
      return false;
    }
  }

  function spotifyOAuthResultHtml(ok, message) {
    const escaped = String(message || '').replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
    return [
      '<!doctype html><meta charset="utf-8">',
      '<title>Spotify Login</title>',
      '<style>',
      'html,body{margin:0;height:100%;background:#101414;color:#f3fff6;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      'body{display:grid;place-items:center;}',
      'main{max-width:520px;padding:30px;text-align:center;}',
      '.brand{font-size:12px;letter-spacing:.24em;color:#1ed760;font-weight:900;margin-bottom:14px;}',
      'h1{font-size:26px;margin:0 0 12px;font-weight:850;}',
      'p{margin:0 auto;color:rgba(243,255,246,.72);line-height:1.7;font-size:14px;}',
      '</style>',
      '<main><div class="brand">SPOTIFY</div><h1>' + (ok ? '授权完成' : '授权失败') + '</h1><p>' + escaped + '</p></main>',
    ].join('');
  }

  function startSpotifyOAuthCallbackServer(redirectUri, onCallback) {
    return new Promise((resolve, reject) => {
      let redirect = null;
      try {
        redirect = new URL(String(redirectUri || ''));
      } catch (e) {
        reject(Object.assign(new Error('SPOTIFY_REDIRECT_URI_INVALID'), { code: 'SPOTIFY_REDIRECT_URI_INVALID' }));
        return;
      }
      const redirectHost = String(redirect.hostname || '').toLowerCase();
      if (redirect.protocol !== 'http:' || (redirectHost !== '127.0.0.1' && redirectHost !== '::1' && redirectHost !== '[::1]')) {
        reject(Object.assign(new Error('SPOTIFY_REDIRECT_URI_MUST_BE_HTTP_LOCALHOST'), { code: 'SPOTIFY_REDIRECT_URI_MUST_BE_HTTP_LOCALHOST' }));
        return;
      }
      const port = Number(redirect.port || 80);
      const host = redirect.hostname || '127.0.0.1';
      const normalizePath = (value) => (value || '/').replace(/\/+$/, '') || '/';
      const expectedPath = normalizePath(redirect.pathname);
      const callbackServer = http.createServer(async (req, res) => {
        let current = null;
        try {
          current = new URL(req.url || '/', redirect.origin);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad callback URL');
          return;
        }
        if (normalizePath(current.pathname) !== expectedPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        try {
          const result = await onCallback(current);
          const ok = !!(result && result.ok);
          res.writeHead(ok ? 200 : 500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(spotifyOAuthResultHtml(ok, (result && (result.message || result.error)) || (ok ? '可以回到 Mineradio。' : '请回到 Mineradio 重新尝试。')));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(spotifyOAuthResultHtml(false, e && e.message || 'SPOTIFY_OAUTH_CALLBACK_FAILED'));
        }
      });
      callbackServer.once('error', (err) => {
        const code = err && err.code === 'EADDRINUSE' ? 'SPOTIFY_CALLBACK_PORT_BUSY' : (err && err.code || 'SPOTIFY_CALLBACK_SERVER_FAILED');
        reject(Object.assign(new Error(code), { code, cause: err }));
      });
      callbackServer.listen(port, host, () => {
        resolve({
          server: callbackServer,
          close: () => {
            try { callbackServer.close(); } catch (_) {}
          },
        });
      });
    });
  }

  async function verifySpotifyOAuthCallbackEndpoint() {
    const config = getSpotifyOAuthConfig();
    if (!config.configured) {
      return {
        ok: false,
        provider: 'spotify',
        error: 'SPOTIFY_OAUTH_NOT_CONFIGURED',
        missing: config.missing || [],
        redirectUri: config.redirectUri,
        message: !config.clientIdValid
          ? 'Client ID 格式不正确，请重新复制。'
          : '请先保存 Spotify Client ID。',
      };
    }
    let callbackServer = null;
    try {
      callbackServer = await startSpotifyOAuthCallbackServer(config.redirectUri, async () => ({
        ok: false,
        error: 'SPOTIFY_PREFLIGHT_ONLY',
        message: '当前仅执行本机回调检测。',
      }));
      return {
        ok: true,
        provider: 'spotify',
        redirectUri: config.redirectUri,
        callbackReady: true,
        message: '本机回调端口可用。请确认 Spotify Dashboard 中保存了完全相同的地址。',
      };
    } catch (error) {
      const code = error && (error.code || error.message) || 'SPOTIFY_CALLBACK_SERVER_FAILED';
      return {
        ok: false,
        provider: 'spotify',
        error: code,
        redirectUri: config.redirectUri,
        callbackReady: false,
        message: code === 'SPOTIFY_CALLBACK_PORT_BUSY'
          ? '本机 43879 端口被其他程序占用，请关闭占用程序后重试。'
          : '本机回调检测失败：' + code,
      };
    } finally {
      if (callbackServer && typeof callbackServer.close === 'function') callbackServer.close();
    }
  }

  async function openSpotifyMusicLoginWindow(owner) {
    const config = getSpotifyOAuthConfig();
    if (!config.configured) {
      return {
        ok: false,
        provider: 'spotify',
        error: 'SPOTIFY_OAUTH_NOT_CONFIGURED',
        missing: config.missing,
        redirectUri: config.redirectUri,
        message: 'Spotify 登录需要先配置 SPOTIFY_CLIENT_ID，并在 Spotify Developer Dashboard 登记本地回调地址 ' + config.redirectUri,
      };
    }

    const oauthState = crypto.randomBytes(16).toString('hex');
    const pkce = createSpotifyPkcePair();
    let authUrl = '';
    try {
      authUrl = buildSpotifyOAuthAuthorizeUrl({
        state: oauthState,
        codeChallenge: pkce.codeChallenge,
        redirectUri: config.redirectUri,
        scope: config.scope,
      });
    } catch (e) {
      return {
        ok: false,
        provider: 'spotify',
        error: e.code || e.message,
        missing: e.missing || config.missing,
        message: e.message || 'Spotify 授权地址生成失败',
      };
    }

    return new Promise(async (resolve) => {
      let settled = false;
      let exchangeStarted = false;
      let callbackServer = null;
      let oauthTimeout = null;

      const finish = (result) => {
        if (settled) return result;
        settled = true;
        if (oauthTimeout) clearTimeout(oauthTimeout);
        if (callbackServer && typeof callbackServer.close === 'function') callbackServer.close();
        resolve(result);
        return result;
      };

      const exchangeFromRedirect = async (targetUrl, event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (exchangeStarted) return { ok: true, provider: 'spotify', message: 'Spotify 授权正在处理。' };
        exchangeStarted = true;
        let parsed = null;
        try {
          parsed = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl || ''));
        } catch (e) {
          return finish({ ok: false, provider: 'spotify', error: 'SPOTIFY_OAUTH_BAD_REDIRECT', message: e.message });
        }
        const returnedState = parsed.searchParams.get('state') || '';
        if (returnedState !== oauthState) {
          return finish({ ok: false, provider: 'spotify', error: 'SPOTIFY_OAUTH_STATE_MISMATCH', message: 'Spotify 授权状态校验失败，请重新登录。' });
        }
        const oauthError = parsed.searchParams.get('error') || '';
        if (oauthError) {
          return finish({
            ok: false,
            provider: 'spotify',
            error: oauthError,
            message: parsed.searchParams.get('error_description') || 'Spotify 授权已取消或失败。',
          });
        }
        const code = parsed.searchParams.get('code') || '';
        if (!code) {
          return finish({ ok: false, provider: 'spotify', error: 'SPOTIFY_OAUTH_CODE_MISSING', message: 'Spotify 回调没有返回 code。' });
        }
        try {
          const info = await exchangeSpotifyOAuthCode({
            code,
            codeVerifier: pkce.codeVerifier,
            redirectUri: config.redirectUri,
          });
          return finish(Object.assign({ ok: true, provider: 'spotify', opened: true }, info || {}, {
            redirectUri: config.redirectUri,
            message: 'Spotify 登录成功，会员状态、歌单和 Liked Songs 已可同步。',
          }));
        } catch (e) {
          return finish({
            ok: false,
            provider: 'spotify',
            error: e.code || e.message || 'SPOTIFY_OAUTH_EXCHANGE_FAILED',
            message: e.message || 'Spotify token 换取失败。',
            missing: e.missing || [],
          });
        }
      };

      try {
        callbackServer = await startSpotifyOAuthCallbackServer(config.redirectUri, exchangeFromRedirect);
      } catch (e) {
        resolve({
          ok: false,
          provider: 'spotify',
          error: e.code || e.message || 'SPOTIFY_CALLBACK_SERVER_FAILED',
          redirectUri: config.redirectUri,
          message: (e.code || e.message) === 'SPOTIFY_CALLBACK_PORT_BUSY'
            ? 'Spotify 本地回调端口被占用，请关闭占用 43879 端口的程序后重试。'
            : 'Spotify 本地回调端口启动失败：' + (e.message || e.code || ''),
        });
        return;
      }

      oauthTimeout = setTimeout(() => {
        finish({
          ok: false,
          provider: 'spotify',
          error: 'SPOTIFY_OAUTH_TIMEOUT',
          redirectUri: config.redirectUri,
          message: '三分钟内没有收到 Spotify 回调。请确认 Dashboard 回调地址完全一致、App 所有者为 Premium，且当前账号已加入 Users Management。',
        });
      }, SPOTIFY_OAUTH_TIMEOUT_MS);

      try {
        await shell.openExternal(authUrl);
      } catch (error) {
        finish({
          ok: false,
          provider: 'spotify',
          error: error && error.message || 'SPOTIFY_AUTH_BROWSER_OPEN_FAILED',
          redirectUri: config.redirectUri,
          message: '无法打开系统浏览器，请检查 Windows 默认浏览器设置。',
        });
      }
    });
  }

  async function clearSpotifyMusicLoginSession() {
    const cookieSession = session.fromPartition(SPOTIFY_LOGIN_PARTITION);
    await cookieSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
    });
    clearSpotifyToken();
    return { ok: true, provider: 'spotify' };
  }

  return {
    verifyCallbackEndpoint: verifySpotifyOAuthCallbackEndpoint,
    openLogin: openSpotifyMusicLoginWindow,
    clearSession: clearSpotifyMusicLoginSession,
    createSpotifyPkcePair,
    spotifyOAuthRedirectMatches,
    spotifyOAuthResultHtml,
  };
}

module.exports = { createSpotifyLogin };
