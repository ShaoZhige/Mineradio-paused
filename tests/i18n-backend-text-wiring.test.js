'use strict';

// 后端文案本地化的不变量 / Invariants for backend copy localization
//   1) 映射表里每个 code 指向的词典键必须在四份词典里都存在，否则界面会显示键名。
//      Every code in the map must point at a key that exists in all dictionaries,
//      otherwise the raw key is what the user sees.
//   2) 每个 backend_ 键必须带中文兜底 —— 词典加载失败时界面不能变成空白。
//      Every backend_ key needs a Chinese fallback, so a failed dictionary load
//      still leaves the UI with a sentence instead of an empty label.
//   3) 映射表里的 code 必须真的在源码里出现过。拼错一个字母不会报错，只会让映射
//      永远不命中、静默退回后端中文 —— 那正是这条守卫要拦的故障。
//      Every mapped code must actually appear in the sources. A typo does not throw,
//      it just makes the mapping never match and silently fall back to the backend
//      Chinese, which is exactly the failure this guard exists to catch.
//   4) 本地化只动 message，不动 error。error 是机器码，前端有多处按它做正则分类，
//      翻掉它会打断"缺权限"和"未登录"的区分。
//      Localization rewrites `message` and must leave `error` alone: `error` is the
//      machine code several sites regex to tell a scope failure from an auth failure.
//   5) code 没有映射时保留后端原文，绝不返回空串。
//      An unmapped code keeps the backend original and never yields an empty string.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'public', 'js', 'modules', '00-state', '15-backend-text.js');
const API_LAYER = path.join(ROOT, 'public', 'js', 'modules', '05-playback', '00-api-quality-output.js');
const LOGIN_MODAL = path.join(ROOT, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js');
const LOCALES_DIR = path.join(ROOT, 'public', 'locales');
const I18N_MODULE = path.join(ROOT, 'public', 'js', 'modules', '00-state', '13-i18n.js');

// 语言列表从 i18n 模块推导而不是写死：写死的列表会让新接入的语言悄悄绕过校验。
// The language list is derived from the i18n module rather than hardcoded, so a newly
// wired language cannot slip past the check.
function wiredLangs() {
  const source = fs.readFileSync(I18N_MODULE, 'utf8');
  const match = /var SUPPORTED_LANGS = \[([^\]]*)\]/.exec(source);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function readDict(lang) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang + '.json'), 'utf8'));
}

// 直接在沙箱里求值模块。模块用 (typeof window !== 'undefined' ? window : this) 兜底，
// 沙箱里没有 window 时 root 就是沙箱全局，所以不需要伪造 window。
// The module falls back to `this` when there is no window, so a bare sandbox is enough.
function loadBackendText(messages) {
  const sandbox = { console: console };
  sandbox.MineradioI18n = {
    t: (key) => (Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE, 'utf8'), sandbox, { filename: MODULE });
  return sandbox.MineradioBackendText;
}

// 从模块源码里解析出映射表与兜底表，而不是在这里重抄一份 —— 重抄的那份会和
// 真实映射脱钩，守卫就变成了自说自话。
// Parses the maps out of the module instead of restating them here: a copy would
// drift away from the real mapping and the guard would only be checking itself.
function parseObjectBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, '没能解析出 ' + startMarker);
  const block = source.slice(start, end);
  const pairs = {};
  const re = /^\s{4}([A-Za-z_$][\w$]*|'[^']+')\s*:\s*'([^']*)'\s*,?\s*$/gm;
  let match;
  while ((match = re.exec(block)) !== null) {
    pairs[match[1].replace(/^'|'$/g, '')] = match[2];
  }
  return pairs;
}

const SOURCE = fs.readFileSync(MODULE, 'utf8');
const MAP = parseObjectBlock(SOURCE, 'var BACKEND_TEXT_KEYS = {', 'var BACKEND_TEXT_FALLBACKS = {');
const FALLBACKS = parseObjectBlock(SOURCE, 'var BACKEND_TEXT_FALLBACKS = {', '// 本模块要在');

test('映射表与兜底表被解析出来且非空', () => {
  // 解析失败会让下面几条退化成空循环（永远绿），所以先把解析本身钉住。
  // A failed parse would degrade the checks below into empty loops, so pin the parse.
  assert.ok(Object.keys(MAP).length >= 40, 'BACKEND_TEXT_KEYS 解析异常，只有 ' + Object.keys(MAP).length + ' 条');
  assert.ok(Object.keys(FALLBACKS).length >= 40, 'BACKEND_TEXT_FALLBACKS 解析异常');
  assert.ok(wiredLangs().length >= 2, '没能解析出 SUPPORTED_LANGS');
});

test('每个 code 指向的词典键在四份词典里都存在', () => {
  const langs = wiredLangs();
  const dicts = {};
  langs.forEach((lang) => { dicts[lang] = readDict(lang); });

  const missing = [];
  Object.keys(MAP).forEach((code) => {
    const key = MAP[code];
    langs.forEach((lang) => {
      if (!Object.prototype.hasOwnProperty.call(dicts[lang], key)) {
        missing.push(code + ' -> ' + key + ' (' + lang + ')');
      }
    });
  });
  assert.deepStrictEqual(missing, [], '映射指向了词典里不存在的键: ' + missing.join(', '));
});

test('每个 backend_ 键都带中文兜底', () => {
  const keys = Object.keys(MAP).map((code) => MAP[code]);
  const backendKeys = Array.from(new Set(keys.filter((key) => key.indexOf('backend_') === 0)));
  assert.ok(backendKeys.length > 0, '映射表里应当有 backend_ 前缀的键');
  const missing = backendKeys.filter((key) => !FALLBACKS[key]);
  assert.deepStrictEqual(missing, [], '这些 backend_ 键没有中文兜底: ' + missing.join(', '));
});

test('兜底表里没有映射表用不到的孤儿键', () => {
  // 孤儿兜底键不会报错，只会让人以为某条映射还在。
  // An orphan fallback never throws; it just implies a mapping that no longer exists.
  const used = new Set(Object.keys(MAP).map((code) => MAP[code]));
  const orphans = Object.keys(FALLBACKS).filter((key) => !used.has(key));
  assert.deepStrictEqual(orphans, [], '多余的兜底键: ' + orphans.join(', '));
});

test('映射表里的 code 都能在源码里找到', () => {
  // 只扫「产出 code 的一方」：后端与自定义音源宿主。刻意不扫 public/js ——
  // 映射表自己就住在 public/js 下，把它算进语料等于让这条判据自证，
  // 写错一个字母也会因为"映射表里有"而通过。
  // Only the producers are scanned: the backend and the custom-source host.
  // public/js is deliberately excluded because the map itself lives there —
  // including it would make the check self-certifying, so a typo would pass
  // simply because the map contains it.
  const sources = [];
  const walk = (current) => {
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'locales') return;
        walk(full);
      } else if (path.extname(entry.name) === '.js') {
        sources.push(fs.readFileSync(full, 'utf8'));
      }
    });
  };
  // 根目录只读顶层 .js。对根目录做递归会一路扫进 public/ 与 tests/，
  // 而映射表自己就住在 public/js 下 —— 那样写错一个字母也会因为
  // "映射表里有"而通过，判据变成自证。
  // The root is scanned non-recursively: recursing from it would sweep in
  // public/ and tests/, and the map itself lives under public/js — so a typo
  // would pass simply because the map contains it, making the check self-certifying.
  fs.readdirSync(ROOT, { withFileTypes: true }).forEach((entry) => {
    if (entry.isFile() && path.extname(entry.name) === '.js') {
      sources.push(fs.readFileSync(path.join(ROOT, entry.name), 'utf8'));
    }
  });
  ['desktop', path.join('desktop', 'custom-source')].forEach((dir) => {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) walk(abs);
  });
  const haystack = sources.join('\n');
  assert.ok(sources.length > 5, '语料太少，判据可能已经失效');
  // 语料里出现映射表自己的标识符，就说明扫描范围又扩到了 public/js，
  // 判据会开始自证 —— 这条守住扫描范围本身。
  // Seeing the map's own identifier in the corpus means the scan crept back into
  // public/js and the check would start certifying itself.
  assert.ok(haystack.indexOf('BACKEND_TEXT_FALLBACKS') < 0, '语料里混进了映射表自身，判据会自证');

  // 全大写 token 就够用了：这条检查的目的是「有没有拼对」，不是精确的词法分析。
  // All-caps tokens are enough here: the point is "is it spelled right at all",
  // not lexing.
  const unknown = Object.keys(MAP).filter((code) => !new RegExp('\\b' + code + '\\b').test(haystack));
  assert.deepStrictEqual(unknown, [], '映射表里的这些 code 在源码中找不到（可能拼错）: ' + unknown.join(', '));
});

test('本地化只改 message，绝不改 error', () => {
  const lib = loadBackendText({ backend_provider_removed: '平台接口已移除（词典）' });
  const payload = lib.localize({ ok: false, error: 'PROVIDER_REMOVED', message: '该平台接口已从 Mineradio 移除。' });
  assert.strictEqual(payload.error, 'PROVIDER_REMOVED', 'error 必须保持机器码，前端按它做分类');
  assert.strictEqual(payload.message, '平台接口已移除（词典）', 'message 应当换成词典文案');
});

test('未映射的 code 保留后端原文，不会变成空串', () => {
  const lib = loadBackendText({});
  const payload = lib.localize({ ok: false, error: 'SOMETHING_NEW', message: '后端刚加的新文案' });
  assert.strictEqual(payload.message, '后端刚加的新文案', '没有映射时必须退回后端原文');
  assert.strictEqual(payload.error, 'SOMETHING_NEW');
});

test('英文句子和中文都不被当成 code', () => {
  const lib = loadBackendText({ backend_provider_removed: '不该命中' });
  assert.strictEqual(lib.isBackendCode('PROVIDER_REMOVED'), true);
  assert.strictEqual(lib.isBackendCode('provider_removed'), false);
  assert.strictEqual(lib.isBackendCode('该平台接口已从 Mineradio 移除。'), false);
  assert.strictEqual(lib.isBackendCode('Spotify callback failed'), false);
  // message 里放着一句英文时必须原样保留，不能被误当成 code 拿去查表。
  const payload = lib.localize({ error: 'not a code', message: 'Spotify callback failed' });
  assert.strictEqual(payload.message, 'Spotify callback failed');
});

test('backendText 按 code 查词典 / 退回原文 / 退回调用方兜底', () => {
  const lib = loadBackendText({ backend_unknown_provider: '未知平台（词典）' });

  // 命中 code -> 用词典
  assert.strictEqual(
    lib.backendText({ error: 'UNKNOWN_PROVIDER', message: '未知平台，无法导出登录 cookie' }, null, '兜底'),
    '未知平台（词典）'
  );
  // code 没映射 -> 用后端原文
  assert.strictEqual(lib.backendText({ error: 'BRAND_NEW_CODE', message: '后端原文' }, null, '兜底'), '后端原文');
  // 连 message 都没有 -> 用调用方兜底
  assert.strictEqual(lib.backendText({ ok: false }, null, '兜底'), '兜底');
  // 空 payload 也不能抛
  assert.strictEqual(lib.backendText(null, null, '兜底'), '兜底');
});

test('backendCodeText 对未映射的 code 还回传入的 fallback', () => {
  const lib = loadBackendText({ backend_provider_removed: '已移除（词典）' });
  assert.strictEqual(lib.backendCodeText('PROVIDER_REMOVED', 'x'), '已移除（词典）');
  // 用 null 作为 fallback 时，未命中必须还回 null，调用方据此判断"没查到"。
  assert.strictEqual(lib.backendCodeText('NOPE_NOT_MAPPED', null), null);
});

test('HTTP 出口必须做一次后端文案本地化', () => {
  const code = fs.readFileSync(API_LAYER, 'utf8');
  const apiJson = /async function apiJson[\s\S]*?\n\}/.exec(code);
  assert.ok(apiJson, '没能定位 apiJson');
  assert.ok(/localizeDeep\s*\(/.test(apiJson[0]), 'apiJson 没有再本地化后端文案，收口失效');
  assert.ok(/return\s+data\s*;/.test(apiJson[0]), 'apiJson 应当返回本地化后的对象');
});

test('后端文案入口把机器码换成词典文案，分类判断仍拿得到机器码', () => {
  const code = fs.readFileSync(API_LAYER, 'utf8');
  assert.ok(/function backendText\s*\(/.test(code), '缺少 backendText 入口');
  assert.ok(/function backendCodeDisplay\s*\(/.test(code), '缺少 backendCodeDisplay 入口');
});

test('登录弹窗的显示点不再裸取后端 message', () => {
  const code = fs.readFileSync(LOGIN_MODAL, 'utf8');
  const bare = /\(\s*(?:info|result|qishuiQr)\s*&&\s*\(\s*\w+\.message\s*\|\|\s*\w+\.error\s*\)\s*\)/;
  assert.ok(!bare.test(code), '登录弹窗又有显示点在裸取后端 message，会直接把后端中文放上屏');
  assert.ok(code.indexOf('backendText(') >= 0, '登录弹窗没有使用后端文案入口');
});
