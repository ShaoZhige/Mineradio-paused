'use strict';

// Cookie 头归一化：把用户粘贴进来的任意形状（原始头串、name/value 数组、对象、
// DevTools 导出的多行格式）收敛成一条 `k=v; k=v` 的 Cookie 头。
//
// 抽成独立模块的原因和 static-assets.js 一样：它原来是 server.js 里的私有函数，
// 后来 qishui-api.js 又照着抄了一份（只有函数名前缀不同），两份并存的代价是
// "改一处忘一处"。现在两端共用同一份实现，也更方便测试直接 require，
// 不必对着 7266 行的 server.js 做字符串断言。
//
// 几条看着多余、实际删不得的规则：
//
// 1. `COOKIE_ATTRIBUTE_NAMES` 里的属性名必须丢掉。用户从浏览器复制 Set-Cookie 时
//    常把 `Path=/; Domain=.163.com; HttpOnly` 一起带进来，当成 cookie 发出去会让
//    服务端解析出 `Path` 这个键 —— 有的平台会因此判为畸形请求直接 403。
// 2. 属性名判定是**小写比较**（`key.toLowerCase()`），但保留的键名维持原样。
//    Cookie 名在 RFC 里是大小写敏感的，`MUSIC_U` 不能变成 `music_u`。
// 3. 值是 `null` / `undefined` 的键直接丢，但**空串保留到下一步**再由
//    `normalizeCookieHeader` 的 filter 剔除 —— 这个顺序差异会在"后面又出现同名
//    非空值"时体现：先丢空串的话，同名键的位置会变。现在的顺序是后者覆盖前者、
//    位置取首次出现处（`Map` 语义）。
// 4. 字符串输入按行再按分号切，所以 `\n` 分隔的多行导出也能吃。`idx <= 0` 而不是
//    `< 0`：`=value` 这种没有键名的片段必须丢掉，否则会产出一个空键。
//
// Cookie header normalization: collapse whatever shape the user pasted (a raw header,
// an array of name/value pairs, a plain object, or a multi-line DevTools export) into a
// single `k=v; k=v` Cookie header. Extracted from server.js because qishui-api.js had
// grown a verbatim copy of the same five functions.

/**
 * Set-Cookie 的属性名（不是 cookie 名），归一化时一律丢弃。
 * @type {Set<string>}
 */
const COOKIE_ATTRIBUTE_NAMES = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'samesite',
  'secure',
  'httponly',
]);

/**
 * 收集一个键值对。键为空、是 cookie 属性、或值为 null/undefined 时丢弃。
 *
 * @param {Map<string, string>} picked 累积结果，键取首次出现的位置
 * @param {unknown} key 键名，任意类型（会被 String() 化后 trim）
 * @param {unknown} value 值，null/undefined 丢弃
 */
function collectCookiePair(picked, key, value) {
  key = String(key || '').trim();
  if (!key || COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) return;
  if (value === null || value === undefined) return;
  picked.set(key, String(value).trim());
}

/**
 * 递归收集任意形状的 cookie 输入。
 *
 * 支持的形状：
 * - `null` / `undefined` → 什么都不做
 * - 数组 → 逐项递归
 * - `{ name, value }` → 当成单个 cookie
 * - `{ k: 'v' }` / `{ k: { value: 'v' } }` → 对象形式（后者是 DevTools 的导出格式）
 * - 其他 → 转成字符串，按行、再按分号切
 *
 * @param {unknown} input
 * @param {Map<string, string>} picked
 */
function collectCookieInput(input, picked) {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    input.forEach((item) => collectCookieInput(item, picked));
    return;
  }
  if (typeof input === 'object') {
    if (input.name && Object.prototype.hasOwnProperty.call(input, 'value')) {
      collectCookiePair(picked, input.name, input.value);
      return;
    }
    Object.keys(input).forEach((key) => {
      const value = input[key];
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
        collectCookiePair(picked, key, value.value);
      } else if (typeof value !== 'object') {
        collectCookiePair(picked, key, value);
      }
    });
    return;
  }
  String(input).split(/\r?\n/).forEach((line) => {
    line.split(';').forEach((part) => {
      const raw = String(part || '').trim();
      const idx = raw.indexOf('=');
      if (idx <= 0) return;
      collectCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1));
    });
  });
}

/**
 * 归一化成可直接放进 `Cookie:` 请求头的字符串。值全为空时返回空串。
 *
 * @param {unknown} input
 * @returns {string}
 */
function normalizeCookieHeader(input) {
  const picked = new Map();
  collectCookieInput(input, picked);
  return Array.from(picked.entries())
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

/**
 * 归一化失败时的退路：只在输入本来就是字符串或全字符串数组时原样返回（trim 后）。
 *
 * 调用点的写法一直是 `normalizeCookieHeader(x) || rawCookieFallback(x)`。归一化会把
 * 它认不出的东西丢干净，而"完全认不出"通常意味着用户粘的是一段不是标准 cookie 的
 * 凭据（比如某些平台的自定义 token），这时候原样发出去比发空要好。
 *
 * @param {unknown} input
 * @returns {string}
 */
function rawCookieFallback(input) {
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input) && input.every((item) => typeof item === 'string')) return input.join('; ').trim();
  return '';
}

module.exports = {
  COOKIE_ATTRIBUTE_NAMES,
  collectCookiePair,
  collectCookieInput,
  normalizeCookieHeader,
  rawCookieFallback,
};
