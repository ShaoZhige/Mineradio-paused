'use strict';

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PARTITION = 'persist:mineradio-spotify-login';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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

  // 本机只有一个 5588，而 Windows 的 SO_REUSEADDR 允许重复 bind：两次授权同时监听时，连接
  // 会落到先绑定的那个（上一次的），新的那次永远等不到回调 —— 表现就是「一直显示等待浏览器
  // 授权」。Folia 的 signIn.cjs 用 start() 里的 drop() 规避同一件事。
  //
  // 另外存 { handle, abort }：新的授权顶掉旧的时，旧的那个 await 必须得到一个结果，否则
  // 前端会永远停在等待上（Promise 不落定，UI 没有可显示的东西）。
  let pendingCallback = null;

  function stopSpotifyCallbackServer(handle) {
    if (!handle) return;
    try { handle.server.close(); } catch (_) {}
    // close() 只停止接收新连接，已建立的 keep-alive 连接会让端口继续占着。Folia 同处调
    // closeAllConnections，这里照做，否则下一次 listen 仍可能落到旧 socket 上。
    try {
      if (typeof handle.server.closeAllConnections === 'function') handle.server.closeAllConnections();
    } catch (_) {}
  }

  function releasePendingSpotifyCallback(handle) {
    if (pendingCallback && pendingCallback.handle === handle) pendingCallback = null;
  }

  function dropPendingSpotifyCallback() {
    const previous = pendingCallback;
    pendingCallback = null;
    if (!previous) return;
    stopSpotifyCallbackServer(previous.handle);
    if (typeof previous.abort === 'function') previous.abort();
  }

  function startSpotifyOAuthCallbackServer(redirectUri, onCallback, onResponseSent) {
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
      // 这一页写完才有资格释放端口：closeAllConnections 会掐断还没刷出去的响应，浏览器上
      // 就变成「连接被重置」而不是那句说明。Folia 用 response.end(text, callback) 是一个道理。
      const responseSent = () => {
        if (typeof onResponseSent !== 'function') return;
        try { onResponseSent(); } catch (_) {}
      };
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
          res.end(spotifyOAuthResultHtml(ok, (result && (result.message || result.error)) || (ok ? '可以回到 Mineradio。' : '请回到 Mineradio 重新尝试。')), responseSent);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(spotifyOAuthResultHtml(false, e && e.message || 'SPOTIFY_OAUTH_CALLBACK_FAILED'), responseSent);
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
          ? 'Spotify Client ID 格式不正确，请检查高级设置中的覆盖值。'
          : 'Spotify 内置客户端配置不可用，请检查回调地址。',
      };
    }
    let callbackServer = null;
    // 授权流程正在监听时不要再起第二个 server 去测同一个端口：那正是「两次 bind、回调落到
    // 旧的那个」的来源。端口此刻确实可用，直接如实回报即可。
    if (pendingCallback) {
      return {
        ok: true,
        provider: 'spotify',
        redirectUri: config.redirectUri,
        callbackReady: true,
        message: '本机回调端口正为这次授权监听，可以直接回到浏览器继续。',
      };
    }
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
          ? '本机 ' + (new URL(config.redirectUri).port || '80') + ' 端口被其他程序占用，请关闭占用程序后重试。'
          : '本机回调检测失败：' + code,
      };
    } finally {
      stopSpotifyCallbackServer(callbackServer);
    }
  }

  // 授权地址只在主进程里生成（state 与 PKCE 都在这儿），浏览器一旦没被拉到前台，渲染层
  // 手里就什么都没有 —— 用户只能看到"请在 Spotify 官方页面完成授权"，却没有任何地址可去。
  // 所以每次把地址主动推一份过去，让界面上始终有可点击、可复制的链接。
  // The authorize URL only exists here (`state` and PKCE live in this process). If the browser
  // never surfaces, the renderer holds nothing and the user is told to authorize with no URL
  // to go to. Push a copy out so the UI always has a link to click or paste.
  function publishSpotifyAuthUrl(owner, authUrl) {
    try {
      const wc = owner && owner.webContents;
      if (wc && !wc.isDestroyed() && typeof wc.send === 'function') {
        wc.send('spotify-music-oauth-url', String(authUrl || ''));
      }
    } catch (_) {}
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
        message: 'Spotify 登录配置不可用。请确认回调地址是 ' + config.redirectUri + '，或清除高级设置里的 Client ID 覆盖。',
      };
    }

    // 新的一次授权取代上一次：先把旧监听连它的 keep-alive 连接一起关掉，否则两次授权会同时
    // 绑在 5588 上，浏览器回来的请求被旧的那次接走，这一次就永远等下去。
    dropPendingSpotifyCallback();

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

      // 响应写完（或超时路径根本没有响应要写）之后才释放端口。留一点延迟还给 res.end：
      // 它是异步刷出的，立刻 closeAllConnections 会把那一页掐成「连接被重置」。
      const releaseCallback = () => {
        stopSpotifyCallbackServer(callbackServer);
        releasePendingSpotifyCallback(callbackServer);
      };

      const finish = (result) => {
        if (settled) return result;
        settled = true;
        if (oauthTimeout) clearTimeout(oauthTimeout);
        // 结果里带上授权地址：即便这次失败（典型是 openExternal 没能拉起浏览器），
        // 界面仍能把那一条显示出来，用户手动粘贴就能继续。
        // Carry the authorize URL on the result: even when this attempt fails (typically
        // openExternal not launching anything), the UI can still show the link.
        if (authUrl && result && !result.authUrl) result.authUrl = authUrl;
        resolve(result);
        // 真回调的路径由 responseSent 及时关闭；超时与启动失败没有响应可写，走这个兜底。
        const timer = setTimeout(releaseCallback, 250);
        if (typeof timer.unref === 'function') timer.unref();
        return result;
      };

      const exchangeFromRedirect = async (targetUrl, event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        let parsed = null;
        try {
          parsed = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl || ''));
        } catch (e) {
          // 连地址都解析不了的东西不是这次授权的答案，回一页就走，不碰正在等的这一次。
          return { ok: false, provider: 'spotify', error: 'SPOTIFY_OAUTH_BAD_REDIRECT', message: e.message };
        }
        const returnedState = parsed.searchParams.get('state') || '';
        // 这个端口对整台机器开放：任何进程、浏览器的预连接、甚至一个存过的旧书签都会打进来。
        // state 不对就只回一句话，绝不终结当前这次 —— Folia 的 signIn.cjs:97-100 是同样的处理。
        // 也不能在这里占住 exchangeStarted，否则真正的回调会被下一行当成「正在处理」挡在门外。
        if (returnedState !== oauthState) {
          return {
            ok: false,
            provider: 'spotify',
            error: 'SPOTIFY_OAUTH_STATE_MISMATCH',
            message: '这不是当前这次授权的回调，请回到浏览器完成授权。',
          };
        }
        if (exchangeStarted) return { ok: true, provider: 'spotify', message: 'Spotify 授权正在处理。' };
        exchangeStarted = true;
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
        // 只有这次授权已经落定，那一页写完才释放端口；陌生请求写完不关，端口继续等真回调。
        const onResponseSent = () => { if (settled) releaseCallback(); };
        callbackServer = await startSpotifyOAuthCallbackServer(config.redirectUri, exchangeFromRedirect, onResponseSent);
        pendingCallback = {
          handle: callbackServer,
          // 被新的一次授权顶掉时给出明确结果，别让调用方一直等。
          abort: () => finish({
            ok: false,
            provider: 'spotify',
            error: 'SPOTIFY_OAUTH_SUPERSEDED',
            message: '这次授权已被新的一次取代，请在当前窗口重新完成授权。',
          }),
        };
      } catch (e) {
        resolve({
          ok: false,
          provider: 'spotify',
          error: e.code || e.message || 'SPOTIFY_CALLBACK_SERVER_FAILED',
          redirectUri: config.redirectUri,
          message: (e.code || e.message) === 'SPOTIFY_CALLBACK_PORT_BUSY'
            ? 'Spotify 本地回调端口被占用，请关闭占用该端口的程序后重试。'
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
          message: '十分钟内没有收到 Spotify 回调。请确认浏览器已完成授权，且本机回调地址没有被其他程序占用。',
        });
      }, SPOTIFY_OAUTH_TIMEOUT_MS);

      // 先把地址交给界面，再拉浏览器：openExternal 即使"成功"，也可能只是把浏览器丢到
      // 后台窗口里，用户眼前什么都没有 —— 那一行链接就是他唯一的出路。
      // Hand the URL to the UI before launching the browser: openExternal can succeed while
      // the browser lands behind this window, leaving the user with nothing in front of them.
      publishSpotifyAuthUrl(owner, authUrl);
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
