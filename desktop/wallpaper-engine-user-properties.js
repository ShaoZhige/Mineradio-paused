// 把 Wallpaper Engine 自己保存的壁纸属性搬进 Mineradio 的播放会话。
//
// 为什么会缺这一步：WE 把用户在这张壁纸上调过的每一项都记在 `config.json` 的
// `<用户名>.wproperties["<scene.pkg 路径>"]["Monitor0"]` 里（关掉的提示框、改小的音乐组件、
// 清空的自定义文字……）。但命令行 `-control openWallpaper -file …` 打开时不查这张表 —— 实测
// 传 `project.json` 和传 `scene.pkg` 出来的都是项目里的默认值。所以只能自己读出来，再用 WE 的
// `applyProperties` 补一遍；静音本来就走的同一个接口，只是这次带的是真实用户值。
//
// Why this exists: Wallpaper Engine stores everything the user tuned for a wallpaper under
// `<user>.wproperties["<scene.pkg path>"]["Monitor0"]` in its `config.json`. Command-line
// `-control openWallpaper -file …` does not consult that table (measured: both `project.json`
// and `scene.pkg` render the project defaults), so we read it ourselves and replay it through
// `applyProperties` — the same interface the mute path already uses.
const fs = require('fs');

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_USER_PROPERTIES = 256;
const MAX_PROPERTY_STRING = 512;
const SAFE_PROPERTY_KEY = /^[A-Za-z0-9_.\-]{1,96}$/;
const RESERVED_CONFIG_KEYS = new Set(['version']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// WE 的键是带盘符的完整路径，正斜杠、有时大小写不一致，还可能带 `//?/` 长路径前缀。
// Keys are full paths with a drive letter, forward slashes, inconsistent casing and possibly a
// `//?/` long-path prefix.
function normalizeConfigPath(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^\/\/\?\/?/, '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

function sanitizePropertyValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    return text.length <= MAX_PROPERTY_STRING ? text : undefined;
  }
  return undefined;
}

// 一份属性表：键名合法、值能原样塞回 JSON，数量封顶。
// One property table: legal keys, JSON-safe values, hard cap on count.
function sanitizeUserPropertyValues(values) {
  const output = {};
  if (!isPlainObject(values)) return output;
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(values)) {
    if (count >= MAX_USER_PROPERTIES) break;
    const key = String(rawKey == null ? '' : rawKey).trim();
    if (!SAFE_PROPERTY_KEY.test(key) || key.toLowerCase() === 'volume') continue;
    const value = sanitizePropertyValue(rawValue);
    if (value === undefined) continue;
    output[key] = value;
    count += 1;
  }
  return output;
}

// `wproperties` 的每条记录按显示器分组（`Monitor0`、`Monitor1`……）。没有分组层的旧数据
// 直接把属性摊在记录本身上，两种形态都得认。
// Each `wproperties` record is grouped per monitor; older/locally-made entries put the properties
// straight on the record, so both shapes are accepted.
function pickMonitorValues(entry) {
  if (!isPlainObject(entry)) return null;
  const monitorKey = Object.keys(entry).find((key) => key.toLowerCase() === 'monitor0');
  if (monitorKey && isPlainObject(entry[monitorKey])) {
    return { monitor: monitorKey, values: entry[monitorKey] };
  }
  const flatKeys = Object.keys(entry).filter((key) => {
    const value = entry[key];
    return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
  });
  if (flatKeys.length) return { monitor: '', values: entry };
  const nestedKey = Object.keys(entry).find((key) => isPlainObject(entry[key]));
  if (nestedKey) return { monitor: nestedKey, values: entry[nestedKey] };
  return null;
}

// config.json 顶层是 `?installdirectory`、`version` 和每个 Steam 用户一段。逐个用户找，
// 谁的表里有这张壁纸就用谁 —— 同一台机器上换账号登录是常见情况。
// The config's top level holds `?installdirectory`, `version` and one section per Steam user.
// Whichever section knows this wallpaper wins; switching accounts on one machine is normal.
function collectUserWproperties(config) {
  const output = [];
  if (!isPlainObject(config)) return output;
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('?') || RESERVED_CONFIG_KEYS.has(key.toLowerCase())) continue;
    if (!isPlainObject(value) || !isPlainObject(value.wproperties)) continue;
    output.push({ user: key, wproperties: value.wproperties });
  }
  return output;
}

function matchWallpaperEntry(wproperties, candidates) {
  const wanted = (Array.isArray(candidates) ? candidates : [])
    .map(normalizeConfigPath)
    .filter(Boolean);
  if (!wanted.length) return null;
  const normalized = new Map();
  for (const key of Object.keys(wproperties)) {
    const normalizedKey = normalizeConfigPath(key);
    if (normalizedKey) normalized.set(normalizedKey, key);
  }
  for (const candidate of wanted) {
    const key = normalized.get(candidate);
    if (key === undefined) continue;
    const picked = pickMonitorValues(wproperties[key]);
    if (!picked) continue;
    return { matchedPath: key, monitor: picked.monitor, values: picked.values };
  }
  return null;
}

function parseConfig(text) {
  try {
    return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

// 读不到、读坏了、没有这张壁纸 —— 一律返回空属性，绝不阻断启动。
// Unreadable, corrupt or "this wallpaper is not in there" all collapse to an empty result and
// never block the start.
async function readWallpaperEngineUserProperties(options = {}) {
  const empty = { properties: {}, matchedPath: '', monitor: '', user: '' };
  const configFile = String(options.configFile || '').trim();
  if (!configFile) return empty;
  let raw;
  try {
    const stat = await fs.promises.stat(configFile);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) return empty;
    raw = await fs.promises.readFile(configFile, 'utf8');
  } catch (_) {
    return empty;
  }
  const config = parseConfig(raw);
  if (!config) return empty;
  const candidates = [options.packageFile, options.projectFile];
  for (const section of collectUserWproperties(config)) {
    const match = matchWallpaperEntry(section.wproperties, candidates);
    if (!match) continue;
    return {
      properties: sanitizeUserPropertyValues(match.values),
      matchedPath: match.matchedPath,
      monitor: match.monitor,
      user: section.user,
    };
  }
  return empty;
}

// 用户值必须落回项目里真实存在的属性，否则 applyProperties 会被整个拒掉（实测退出码 4）。
// 类型也得对得上：bool 属性收到字符串、slider 收到布尔值，WE 一律不认。
// User values have to land on properties the project actually declares, otherwise the whole
// applyProperties call is rejected (measured: exit code 4), and the types must match as well.
function filterSceneUserProperties(values, descriptors) {
  const output = {};
  if (!isPlainObject(values) || !Array.isArray(descriptors) || !descriptors.length) return output;
  const byKey = new Map();
  for (const descriptor of descriptors) {
    if (descriptor && descriptor.key) byKey.set(String(descriptor.key), descriptor);
  }
  for (const [key, value] of Object.entries(values)) {
    const descriptor = byKey.get(key);
    if (!descriptor) continue;
    const type = String(descriptor.type || '').toLowerCase();
    if (type === 'bool') {
      if (typeof value === 'boolean') output[key] = value;
      continue;
    }
    if (type === 'slider') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      let next = value;
      if (Number.isFinite(descriptor.min) && next < descriptor.min) next = descriptor.min;
      if (Number.isFinite(descriptor.max) && next > descriptor.max) next = descriptor.max;
      output[key] = next;
      continue;
    }
    if (type === 'combo') {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      const options = Array.isArray(descriptor.options) ? descriptor.options : [];
      const text = String(value);
      if (!options.length) {
        output[key] = text;
        continue;
      }
      const hit = options.find((option) => option && String(option.value) === text);
      if (hit) output[key] = hit.value;
      continue;
    }
    if (type === 'color' || type === 'textinput' || type === 'text' || type === 'texture') {
      if (typeof value === 'string') output[key] = value;
      continue;
    }
    // group / 未知类型不接受用户值：它们不是可写属性。
    // group and unknown types are not writable properties.
  }
  return output;
}

// 合并顺序是刻意的：静音值在后，用户自己调过的音量也盖不过"这个会话必须静音"。
// The order is deliberate: mute values come last so a user-tuned volume never wins over
// "this session must stay silent".
function buildScenePropertyPayload(muteProperties, userProperties) {
  const mute = isPlainObject(muteProperties) ? muteProperties : {};
  const volume = typeof mute.volume === 'number' && Number.isFinite(mute.volume) ? mute.volume : 0;
  return { ...sanitizeUserPropertyValues(userProperties), ...mute, volume };
}

module.exports = {
  normalizeConfigPath,
  sanitizeUserPropertyValues,
  filterSceneUserProperties,
  buildScenePropertyPayload,
  readWallpaperEngineUserProperties,
};
