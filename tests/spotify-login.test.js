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
