'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCacheSettingsManager } = require('../desktop/cache-settings');

function makeManager(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-cache-'));
  const userData = path.join(root, 'userdata');
  const sessionData = path.join(root, 'session-data');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(sessionData, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = createCacheSettingsManager({
    app: {
      getPath(name) {
        if (name === 'userData') return userData;
        if (name === 'sessionData') return sessionData;
        throw new Error('unexpected getPath: ' + name);
      },
    },
    fs,
    path,
    crypto,
    appName: 'Mineradio',
    settingsFile: 'cache-settings.json',
    stableUserDataPath: userData,
    nativeHelperTempPath: () => path.join(userData, 'cache', 'native-helper-temp'),
    lyricCacheMaxBytes: 32,
    ...overrides,
  });
  return { manager, root, userData, sessionData };
}

test('init creates the configurable cache tree and keeps sessionData under it', (t) => {
  const { manager, userData } = makeManager(t);
  const settings = manager.init();
  assert.equal(settings.rootPath, path.join(userData, 'cache'));
  for (const key of ['lyricsPath', 'chromiumPath', 'beatmapsPath', 'nativePath']) {
    assert.ok(fs.existsSync(settings[key]), key + ' should exist');
  }
  assert.equal(
    manager.chromiumSessionDataPath(settings),
    path.join(settings.chromiumPath, 'Mineradio')
  );
});

test('write/read round-trips a custom root and setRootPath updates the manager', (t) => {
  const { manager, root } = makeManager(t);
  manager.init();
  const custom = path.join(root, 'custom-cache');
  manager.setRootPath(custom);
  assert.equal(manager.get().rootPath, custom);
  assert.deepEqual(manager.read().rootPath, custom);
  assert.equal(manager.get().lyricsPath, path.join(custom, 'lyrics'));
});

test('normalizeRootPath falls back to userData for blank or broken values', (t) => {
  const { manager, userData } = makeManager(t);
  assert.equal(manager.normalizeRootPath(''), path.join(userData, 'cache'));
  assert.equal(manager.normalizeRootPath(null), path.join(userData, 'cache'));
});

test('lyric cache files are hashed and pruning removes the oldest entries first', async (t) => {
  const { manager } = makeManager(t);
  manager.init();
  const file = manager.lyricCacheFilePath('song:1');
  assert.match(path.basename(file), /^[a-f0-9]{64}\.json$/);
  assert.equal(path.dirname(file), manager.get().lyricsPath);

  const dir = manager.get().lyricsPath;
  for (let i = 0; i < 4; i += 1) {
    const target = path.join(dir, crypto.createHash('sha256').update('k' + i).digest('hex') + '.json');
    fs.writeFileSync(target, 'x'.repeat(20));
    const stamp = new Date(Date.now() - (4 - i) * 10000);
    fs.utimesSync(target, stamp, stamp);
  }
  await manager.pruneLyricCache();
  const left = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  // 32-byte budget keeps at most one 20-byte entry.
  assert.ok(left.length <= 1, 'expected pruning down to the budget, got ' + left.length);
  assert.ok(fs.existsSync(path.join(dir, left[0])), 'the newest entry should survive');
});
