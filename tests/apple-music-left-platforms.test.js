'use strict';

// Apple Music must be a first-class provider in the left playlist/podcast
// switchers, not only in the account modal. The UI derives tabs from
// userPlaylists, so the provider id, order, labels and both catalogue URLs have
// to agree or the Apple playlists silently fall back to NetEase.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const DETAIL = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing slice: ${startMarker}`);
  return text.slice(start, end);
}

function loadDetailHelpers() {
  const sandbox = {
    playlistDetailText: (key, fallback) => fallback == null ? key : fallback,
    encodeURIComponent,
    Object,
    String,
    Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    slice(DETAIL, 'function normalizePlaylistProvider', 'function playlistCardPriority')
      + '\n' + slice(DETAIL, 'function playlistTracksEndpoint', 'function fetchPlaylistTracksPage'),
    sandbox,
    { filename: 'playlist-provider-helpers.js' }
  );
  return sandbox;
}

test('Apple Music survives playlist normalization instead of falling back to NetEase', () => {
  const h = loadDetailHelpers();
  assert.equal(h.normalizePlaylistProvider('applemusic'), 'applemusic');
  assert.equal(h.normalizePlaylistProvider('appleMusic'), 'applemusic');
  assert.equal(h.normalizePlaylistProvider('apple_music'), 'applemusic');
  assert.equal(h.playlistProviderLabel('applemusic'), 'AM');
  assert.equal(h.playlistProviderName('applemusic'), 'Apple Music');
  assert.equal(h.playlistPanelProviderId('applemusic', 'p.1'), 'applemusic:p.1');
  assert.equal(h.playlistPanelKey('applemusic', 'p.1'), 'applemusic:p.1');
});

test('Apple Music playlist detail uses the dedicated server route', () => {
  const h = loadDetailHelpers();
  assert.equal(h.playlistTracksEndpoint('applemusic', 'p.1'), '/api/apple-music/playlist/tracks?id=p.1');
  assert.match(h.playlistTracksEndpoint('applemusic', 'p 1', { limit: 20 }), /limit=20/);
});

test('playlist catalogue and global store acknowledge Apple Music', () => {
  assert.match(SHELL, /if \(provider === 'applemusic'\) return '\/api\/apple-music\/playlists\?limit=/);
  assert.match(SHELL, /appleMusicPlaylists/);
  assert.match(CORE, /\bappleMusicPlaylists\s*=\s*\[\]/);
  assert.match(DETAIL, /PLAYLIST_PROVIDER_ORDER[\s\S]*?'applemusic'/);
});
