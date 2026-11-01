// 壁纸用户属性的回归测试：从 WE 的 config.json 命中这张壁纸、按项目属性白名单过滤类型、
// 以及"静音覆盖用户音量"的合并顺序。
// Regression tests for the Wallpaper Engine user-property import: matching the wallpaper inside
// the engine's config.json, filtering values by the project's declared properties, and the merge
// order that keeps a user-tuned volume from leaking audio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeConfigPath,
  sanitizeUserPropertyValues,
  filterSceneUserProperties,
  buildScenePropertyPayload,
  readWallpaperEngineUserProperties,
} = require('../desktop/wallpaper-engine-user-properties');

const PKG = 'E:/steam/steamapps/workshop/content/431960/3470764447/scene.pkg';

function tempConfig(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'we-props-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return file;
}

function configWith(wproperties, user = 'shao') {
  return {
    '?installdirectory': 'E:/steam/steamapps/common/wallpaper_engine',
    [user]: { general: {}, version: 5, wproperties },
    version: 5,
  };
}

test('normalizeConfigPath unifies slashes, case and long-path prefixes', () => {
  assert.strictEqual(
    normalizeConfigPath('E:\\Steam\\steamapps\\Workshop\\content\\431960\\scene.pkg'),
    'e:/steam/steamapps/workshop/content/431960/scene.pkg'
  );
  assert.strictEqual(
    normalizeConfigPath('//?/E:/steam/scene.pkg'),
    'e:/steam/scene.pkg'
  );
  assert.strictEqual(normalizeConfigPath(''), '');
});

test('matches the wallpaper by scene.pkg path regardless of slash style', async () => {
  const configFile = tempConfig(configWith({
    [PKG]: { Monitor0: { newproperty50: false, newproperty45: 0 } },
  }));
  const result = await readWallpaperEngineUserProperties({
    configFile,
    packageFile: 'E:\\steam\\steamapps\\workshop\\content\\431960\\3470764447\\scene.pkg',
    projectFile: 'E:\\steam\\steamapps\\workshop\\content\\431960\\3470764447\\project.json',
  });
  assert.deepStrictEqual(result.properties, { newproperty50: false, newproperty45: 0 });
  assert.strictEqual(result.user, 'shao');
  assert.strictEqual(result.monitor, 'Monitor0');
  assert.strictEqual(result.matchedPath, PKG);
});

test('falls back to the project.json key when that is what the config recorded', async () => {
  const projectKey = 'e:/steam/steamapps/workshop/content/431960/3470764447/project.json';
  const configFile = tempConfig(configWith({
    [projectKey]: { Monitor0: { time: false } },
  }));
  const result = await readWallpaperEngineUserProperties({
    configFile,
    packageFile: PKG,
    projectFile: 'E:\\steam\\steamapps\\workshop\\content\\431960\\3470764447\\project.json',
  });
  assert.deepStrictEqual(result.properties, { time: false });
});

test('picks the first user section that knows the wallpaper', async () => {
  const configFile = tempConfig({
    '?installdirectory': 'E:/steam',
    someoneelse: { wproperties: { 'e:/other/scene.pkg': { Monitor0: { a: 1 } } } },
    shao: { wproperties: { [PKG]: { Monitor0: { a: 2 } } } },
    version: 5,
  });
  const result = await readWallpaperEngineUserProperties({ configFile, packageFile: PKG });
  assert.strictEqual(result.user, 'shao');
  assert.deepStrictEqual(result.properties, { a: 2 });
});

test('accepts a flat record without a monitor layer', async () => {
  const configFile = tempConfig(configWith({ [PKG]: { shu: false, newproperty17: 9 } }));
  const result = await readWallpaperEngineUserProperties({ configFile, packageFile: PKG });
  assert.deepStrictEqual(result.properties, { shu: false, newproperty17: 9 });
  assert.strictEqual(result.monitor, '');
});

test('unknown wallpaper, missing file and broken JSON all yield nothing', async () => {
  const unknown = await readWallpaperEngineUserProperties({
    configFile: tempConfig(configWith({ 'e:/steam/other/scene.pkg': { Monitor0: { a: 1 } } })),
    packageFile: PKG,
  });
  assert.deepStrictEqual(unknown.properties, {});
  assert.strictEqual(unknown.matchedPath, '');

  const missing = await readWallpaperEngineUserProperties({
    configFile: path.join(os.tmpdir(), 'we-props-does-not-exist', 'config.json'),
    packageFile: PKG,
  });
  assert.deepStrictEqual(missing.properties, {});

  const broken = await readWallpaperEngineUserProperties({
    configFile: tempConfig('{ not json'),
    packageFile: PKG,
  });
  assert.deepStrictEqual(broken.properties, {});
});

test('drops hostile keys, oversized strings and non-scalar values', async () => {
  const configFile = tempConfig(configWith({
    [PKG]: {
      Monitor0: {
        good: 1,
        'bad key with spaces': 2,
        huge: 'x'.repeat(600),
        nested: { a: 1 },
        arr: [1, 2],
        volume: 55,
      },
    },
  }));
  const result = await readWallpaperEngineUserProperties({ configFile, packageFile: PKG });
  assert.deepStrictEqual(result.properties, { good: 1 });
});

test('filterSceneUserProperties keeps only declared properties with matching types', () => {
  const descriptors = [
    { key: 'music', type: 'slider', min: 0, max: 1 },
    { key: 'prompt', type: 'bool' },
    { key: 'font', type: 'combo', options: [{ label: '1', value: '1' }, { label: '2', value: '2' }] },
    { key: 'tint', type: 'color' },
    { key: 'caption', type: 'textinput' },
    { key: 'group', type: 'group' },
  ];
  const filtered = filterSceneUserProperties({
    music: 0.4,
    musicOutOfRange: 9,
    prompt: 'false',
    promptOk: true,
    font: '2',
    fontBad: '9',
    tint: '1 1 1',
    caption: '夜莺 Night',
    group: 'x',
    undeclared: true,
  }, descriptors);
  assert.deepStrictEqual(filtered, {
    music: 0.4,
    font: '2',
    tint: '1 1 1',
    caption: '夜莺 Night',
  });

  const clamped = filterSceneUserProperties({ music: 12 }, descriptors);
  assert.deepStrictEqual(clamped, { music: 1 });

  const boolOk = filterSceneUserProperties({ prompt: false }, descriptors);
  assert.deepStrictEqual(boolOk, { prompt: false });

  const comboOk = filterSceneUserProperties({ font: '2' }, descriptors);
  assert.deepStrictEqual(comboOk, { font: '2' });
});

test('filterSceneUserProperties returns nothing without descriptors', () => {
  assert.deepStrictEqual(filterSceneUserProperties({ a: 1 }, []), {});
  assert.deepStrictEqual(filterSceneUserProperties({ a: 1 }, null), {});
  assert.deepStrictEqual(filterSceneUserProperties(null, [{ key: 'a', type: 'bool' }]), {});
});

test('a user-tuned volume never overrides the session mute', () => {
  const payload = buildScenePropertyPayload({ volume: 0, music: 0 }, { volume: 80, music: 0.7, caption: 'x' });
  assert.strictEqual(payload.volume, 0);
  assert.strictEqual(payload.music, 0);
  assert.strictEqual(payload.caption, 'x');
});

test('payload keeps mute values when the user table is empty', () => {
  const payload = buildScenePropertyPayload({ volume: 0, radio: false }, null);
  assert.deepStrictEqual(payload, { volume: 0, radio: false });
});

test('sanitizeUserPropertyValues caps the count and keeps scalars', () => {
  const values = { caption: 'hello', enabled: true, size: 1.5, volume: 3 };
  assert.deepStrictEqual(sanitizeUserPropertyValues(values), {
    caption: 'hello',
    enabled: true,
    size: 1.5,
  });
  assert.deepStrictEqual(sanitizeUserPropertyValues(null), {});
});
