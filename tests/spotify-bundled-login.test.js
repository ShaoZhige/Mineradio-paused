'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLED_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
const BUNDLED_REDIRECT_URI = 'http://127.0.0.1:5588/login';

// Keep this file isolated from the developer's real credentials and from other Spotify tests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-spotify-bundled-'));
process.env.SPOTIFY_CONFIG_FILE = path.join(root, '.spotify-credentials.json');
process.env.SPOTIFY_TOKEN_FILE = path.join(root, '.spotify-token.json');
for (const key of [
  'SPOTIFY_CLIENT_ID', 'MINERADIO_SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET', 'MINERADIO_SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REDIRECT_URI', 'MINERADIO_SPOTIFY_REDIRECT_URI',
  'SPOTIFY_SCOPES', 'SPOTIFY_SCOPE', 'MINERADIO_SPOTIFY_SCOPES',
]) delete process.env[key];

const spotify = require('../server/spotify-api');

test('a fresh install uses the bundled Spotify desktop client and loopback redirect', () => {
  const oauth = spotify.getSpotifyOAuthConfig();
  assert.equal(oauth.clientId, BUNDLED_CLIENT_ID);
  assert.equal(oauth.redirectUri, BUNDLED_REDIRECT_URI);
  assert.equal(oauth.clientIdValid, true);
  assert.equal(oauth.redirectValid, true);
  assert.equal(oauth.configured, true);
  assert.equal(oauth.configSource, 'bundled');
  assert.deepEqual(oauth.missing, []);

  const info = spotify.getSpotifyConfig();
  assert.equal(info.oauthConfigured, true);
  assert.equal(info.configured, true);
  assert.equal(info.localConfigMissing, false);
  assert.match(info.message, /内置/);
});

test('the bundled redirect accepts both /login and the legacy /callback path', () => {
  assert.equal(spotify._test.inspectSpotifyRedirectUri(BUNDLED_REDIRECT_URI).ok, true);
  assert.equal(spotify._test.inspectSpotifyRedirectUri('http://127.0.0.1:43879/callback').ok, true);
  assert.equal(spotify._test.inspectSpotifyRedirectUri('http://127.0.0.1:5588/other').ok, false);
  assert.equal(spotify._test.inspectSpotifyRedirectUri('https://127.0.0.1:5588/login').ok, false);
});

test('saving an empty Client ID keeps the bundled client instead of failing', () => {
  const saved = spotify.saveSpotifyConfig({});
  assert.equal(saved.clientId, BUNDLED_CLIENT_ID);
  assert.equal(saved.redirectUri, BUNDLED_REDIRECT_URI);
  const onDisk = JSON.parse(fs.readFileSync(process.env.SPOTIFY_CONFIG_FILE, 'utf8')).spotify;
  assert.equal(onDisk.clientId, BUNDLED_CLIENT_ID);
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'clientSecret'), false);
});

test('an explicit override still wins and is validated', () => {
  const customId = '0123456789abcdef0123456789abcdef';
  const saved = spotify.saveSpotifyConfig({ clientId: customId, redirectUri: 'http://127.0.0.1:43900/callback' });
  assert.equal(saved.clientId, customId);
  const oauth = spotify.getSpotifyOAuthConfig();
  assert.equal(oauth.clientId, customId);
  assert.equal(oauth.redirectUri, 'http://127.0.0.1:43900/callback');
  assert.equal(oauth.configSource, 'file');
  assert.throws(
    () => spotify.saveSpotifyConfig({ clientId: 'not a client id' }),
    error => error && error.code === 'SPOTIFY_CLIENT_ID_INVALID'
  );
});

test('a stale custom client paired with the bundled redirect falls back to the bundled client', () => {
  // This is the migration case produced by an old custom Client ID being saved
  // together with the new bundled 5588/login redirect. Spotify rejects that pair
  // with "redirect_uri: Not matching configuration", so the built-in client wins.
  const customId = '124e3ad051484e15be202f0edcf4783e';
  const saved = spotify.saveSpotifyConfig({ clientId: customId });
  assert.equal(saved.clientId, customId);
  assert.equal(saved.redirectUri, BUNDLED_REDIRECT_URI);

  const oauth = spotify.getSpotifyOAuthConfig();
  assert.equal(oauth.clientId, BUNDLED_CLIENT_ID);
  assert.equal(oauth.redirectUri, BUNDLED_REDIRECT_URI);
  assert.equal(oauth.configSource, 'bundled-fallback');
  assert.equal(oauth.ignoredCustomClient, true);
  assert.equal(oauth.clientIdBundled, true);

  const info = spotify.getSpotifyConfig();
  assert.equal(info.ignoredCustomClient, true);
  assert.match(info.message, /不匹配/);
});
