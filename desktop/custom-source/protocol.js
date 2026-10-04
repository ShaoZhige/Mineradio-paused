'use strict';

// 洛雪音乐桌面版自定义音源公开协议的常量与纯函数。
// 这里刻意不引入 electron / fs，方便在普通 Node 进程里直接单测，
// 也让「协议」和「运行环境」两件事不会互相纠缠。
// Pure LX Music Desktop custom-source protocol helpers. No electron/fs imports so the
// contract can be unit tested in plain Node and stays decoupled from the runtime host.

const LX_API_VERSION = '2.0.0';
const LX_ENV = 'desktop';
const EVENT_NAMES = Object.freeze({ request: 'request', inited: 'inited', updateAlert: 'updateAlert' });
const SOURCE_KEYS = Object.freeze(['kw', 'kg', 'tx', 'wy', 'mg', 'local']);
const QUALITY_KEYS = Object.freeze(['128k', '320k', 'flac', 'flac24bit']);
const ACTIONS = Object.freeze({
  kw: ['musicUrl'],
  kg: ['musicUrl'],
  tx: ['musicUrl'],
  wy: ['musicUrl'],
  mg: ['musicUrl'],
  local: ['musicUrl', 'lyric', 'pic'],
});
// 与洛雪一致的长度上限，超长按「截断 + ...」处理，不拒绝导入。
// Same maximum lengths as LX; over-long values are truncated rather than rejected.
const META_LIMITS = Object.freeze({ name: 24, description: 36, author: 56, homepage: 1024, version: 36 });
const TARGET_QUALITY = Object.freeze({
  standard: '128k',
  exhigh: '320k',
  lossless: 'flac',
  hires: 'flac24bit',
  jymaster: 'flac24bit',
});

function parseScriptInfo(script) {
  const header = /^\/\*[\s\S]+?\*\//.exec(String(script || ''));
  if (!header) throw new Error('IMPORT_INVALID: 无效的自定义源文件');
  const values = {};
  for (const line of header[0].split(/\r?\n/)) {
    const match = /^\s?\*\s?@(\w+)\s(.+)$/.exec(line);
    if (match && META_LIMITS[match[1]] != null) values[match[1]] = match[2].trim();
  }
  for (const [key, limit] of Object.entries(META_LIMITS)) {
    values[key] = String(values[key] || '');
    if (values[key].length > limit) values[key] = values[key].slice(0, limit - 3) + '...';
  }
  values.name ||= `user_api_${Date.now()}`;
  return values;
}

function filterInitPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.sources) throw new Error('INIT_FAILED: Missing init info');
  const sources = {};
  for (const key of SOURCE_KEYS) {
    const item = payload.sources[key];
    if (!item || item.type !== 'music') continue;
    sources[key] = {
      name: String(item.name || key),
      type: 'music',
      actions: ACTIONS[key].filter(action => Array.isArray(item.actions) && item.actions.includes(action)),
      qualitys: key === 'local' ? [] : QUALITY_KEYS.filter(q => Array.isArray(item.qualitys) && item.qualitys.includes(q)),
    };
  }
  return { openDevTools: payload.openDevTools === true, sources };
}

// 在脚本声明的音质里挑一个不高于用户目标音质的最优项。
// Pick the highest quality the script declares that does not exceed the user's target.
function selectLxQuality(target, supported) {
  const desired = TARGET_QUALITY[target] || 'flac24bit';
  const max = QUALITY_KEYS.indexOf(desired);
  const list = Array.isArray(supported) ? supported : [];
  for (let i = max; i >= 0; i--) {
    if (list.includes(QUALITY_KEYS[i])) return QUALITY_KEYS[i];
  }
  return null;
}

function validateActionResponse(action, value) {
  if (action === 'musicUrl' || action === 'pic') {
    let url;
    // 先排除控制字符/首尾空白，避免 URL 解析把不可见字符吃掉后当成合法地址。
    // Reject control characters and surrounding whitespace before URL parsing so a
    // mangled string cannot sneak through as a usable address.
    const hasUnsafeUrlChars = typeof value !== 'string' || value !== value.trim() || /[\u0000-\u001F\u007F]/.test(value);
    try {
      url = !hasUnsafeUrlChars && /^https?:\/\//i.test(value) ? new URL(value) : null;
    } catch {
      url = null;
    }
    if (!url || value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      throw new Error('INVALID_RESPONSE: Expected an HTTP URL');
    }
    return value;
  }
  if (action === 'lyric') {
    if (!value || typeof value !== 'object' || typeof value.lyric !== 'string' || value.lyric.length > 51200) {
      throw new Error('INVALID_RESPONSE: Expected lyric data');
    }
    return {
      lyric: value.lyric,
      tlyric: typeof value.tlyric === 'string' && value.tlyric.length <= 5120 ? value.tlyric : null,
      rlyric: typeof value.rlyric === 'string' && value.rlyric.length <= 5120 ? value.rlyric : null,
      lxlyric: typeof value.lxlyric === 'string' && value.lxlyric.length <= 8192 ? value.lxlyric : null,
    };
  }
  throw new Error(`INVALID_RESPONSE: Unsupported action ${action}`);
}

// 播放解析策略：脚本对这首歌「有主张」时才由它接管，否则完全交回内置接口。
// 与上游 PR 的差别在于 handled：Mineradio 支持五个平台，脚本往往只声明其中一两个，
// 把「脚本没声明这个平台」也当成接管会导致其余平台直接播不了。
// Playback policy: the script only owns a track when it actually has an opinion about it.
// Unlike the upstream PR this respects `handled`: Mineradio ships five providers while a
// script usually declares one or two, and treating "script does not cover this platform"
// as ownership would make every other platform unplayable.
function customSourcePolicy(result) {
  if (!result || result.active !== true) return 'builtin';
  if (result.handled !== true) return 'builtin';
  return result.url ? 'custom' : 'fallback';
}

module.exports = {
  LX_API_VERSION,
  LX_ENV,
  EVENT_NAMES,
  SOURCE_KEYS,
  QUALITY_KEYS,
  ACTIONS,
  META_LIMITS,
  TARGET_QUALITY,
  parseScriptInfo,
  filterInitPayload,
  selectLxQuality,
  validateActionResponse,
  customSourcePolicy,
};
