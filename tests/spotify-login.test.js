'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSpotifyLogin } = require('../desktop/spotify-login');

function makeController(overrides = {}) {
  return createSpotifyLogin(Object.assign({
    shell: { openExternal: async () => {} },
    session: { fromPartition: () => ({ clearStorageData: async () => {} }) },
    getSpotifyOAuthConfig: () => ({ configured: false, missing: ['clientId'], redirectUri: 'http://127.0.0.1:43879/callback' }),
    buildSpotifyOAuthAuthorizeUrl: () => 'https://accounts.spotify.com/authorize',
    exchangeSpotifyOAuthCode: async () => ({ ok: true }),
    clearSpotifyToken: () => {},
  }, overrides));
}

test('Spotify PKCE pair is base64url and uses SHA-256 of the verifier', () => {
  const { createSpotifyPkcePair } = makeController();
  const pair = createSpotifyPkcePair();
  assert.match(pair.codeVerifier, /^[A-Za-z0-9_-]+$/);
  assert.match(pair.codeChallenge, /^[A-Za-z0-9_-]+$/);
  const expected = crypto.createHash('sha256').update(pair.codeVerifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  assert.equal(pair.codeChallenge, expected);
});

test('Spotify redirect matching ignores trailing slashes but not paths or ports', () => {
  const { spotifyOAuthRedirectMatches } = makeController();
  const base = 'http://127.0.0.1:43879/callback';
  assert.equal(spotifyOAuthRedirectMatches(base + '/', base), true);
  assert.equal(spotifyOAuthRedirectMatches('http://127.0.0.1:43879/other', base), false);
  assert.equal(spotifyOAuthRedirectMatches('https://127.0.0.1:43879/callback', base), false);
  assert.equal(spotifyOAuthRedirectMatches('http://127.0.0.1:43880/callback', base), false);
});

test('Spotify callback result HTML escapes the message', () => {
  const { spotifyOAuthResultHtml } = makeController();
  const html = spotifyOAuthResultHtml(false, '<script>alert("x")</script>');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('Spotify verify reports missing configuration without opening a server', async () => {
  const controller = makeController();
  const result = await controller.verifyCallbackEndpoint();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SPOTIFY_OAUTH_NOT_CONFIGURED');
  assert.deepEqual(result.missing, ['clientId']);
});

// —— 回调端口的独占与陌生请求（参考 Folia electron/spotify/signIn.cjs 的三处处理）——

const http = require('node:http');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function makeListeningController() {
  const port = await freePort();
  let authorizeArgs = null;
  let announce = null;
  const listening = new Promise((resolve) => { announce = resolve; });
  const controller = makeController({
    shell: { openExternal: async () => { announce(); } },
    getSpotifyOAuthConfig: () => ({
      configured: true,
      clientIdValid: true,
      missing: [],
      scope: [],
      redirectUri: `http://127.0.0.1:${port}/login`,
    }),
    buildSpotifyOAuthAuthorizeUrl: (args) => {
      authorizeArgs = args;
      return 'https://accounts.spotify.com/authorize';
    },
    exchangeSpotifyOAuthCode: async () => ({ ok: true, provider: 'spotify' }),
  });
  return { controller, port, listening, state: () => authorizeArgs && authorizeArgs.state };
}

test('陌生 state 的回调只回一页，不终结正在等的这次授权', async () => {
  const { controller, port, listening, state } = await makeListeningController();
  const pending = controller.openLogin();
  await listening;

  // 本机端口对任何程序开放：这不匹配的请求以前会 finish()，把用户正在等的授权打断。
  const stranger = await httpGet(`http://127.0.0.1:${port}/login?code=X&state=wrong`);
  assert.match(stranger.body, /这不是当前这次授权的回调/);
  assert.equal(state().length > 0, true);

  // 真正的回调仍然能进来并完成。
  const real = await httpGet(`http://127.0.0.1:${port}/login?code=GOOD&state=${state()}`);
  assert.equal(real.status, 200);
  const result = await pending;
  assert.equal(result.ok, true);
});

test('第二次授权顶掉上一次，旧的那次立刻有结果而不是一直等', async () => {
  const { controller, port, listening, state } = await makeListeningController();
  const first = controller.openLogin();
  await listening;

  // 接着点第二次：旧监听必须先被拆掉，否则两个 server 同时绑在 5588 上，回调会落到旧的那个。
  const announceSecond = controller.openLogin();
  const firstResult = await first;
  assert.equal(firstResult.error, 'SPOTIFY_OAUTH_SUPERSEDED');

  const real = await httpGet(`http://127.0.0.1:${port}/login?code=GOOD&state=${state()}`);
  assert.equal(real.status, 200);
  const secondResult = await announceSecond;
  assert.equal(secondResult.ok, true);
});

test('浏览器拉不起来时，授权地址仍然交回渲染层', async () => {
  // 真实故障：openExternal 失败（或只是把浏览器丢到后台），界面上只剩"请去官方页面授权"
  // 却没有任何地址可点。地址必须同时走推送和结果两条路回到渲染层。
  // Real failure: openExternal throws (or only backgrounds the browser) and the UI is left
  // telling the user to authorize with no address. The URL has to reach the renderer twice:
  // as a push and on the result.
  const port = await freePort();
  const pushed = [];
  const owner = {
    webContents: {
      isDestroyed: () => false,
      send: (channel, url) => { pushed.push([channel, url]); },
    },
  };
  const authorizeUrl = 'https://accounts.spotify.com/authorize?client_id=abc&state=def';
  const controller = makeController({
    shell: { openExternal: async () => { throw new Error('no default browser'); } },
    getSpotifyOAuthConfig: () => ({
      configured: true,
      clientIdValid: true,
      missing: [],
      scope: [],
      redirectUri: `http://127.0.0.1:${port}/login`,
    }),
    buildSpotifyOAuthAuthorizeUrl: () => authorizeUrl,
  });

  const result = await controller.openLogin(owner);
  assert.equal(result.ok, false);
  assert.equal(result.authUrl, authorizeUrl);
  assert.deepEqual(pushed, [['spotify-music-oauth-url', authorizeUrl]]);
});
