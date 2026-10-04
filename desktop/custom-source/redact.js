'use strict';

// 落盘日志脱敏。脚本可以往 updateAlert / 日志里塞它收到的任何东西，
// 其中可能包含用户 Cookie 或 token，写盘前统一遮盖。
// Redacts secrets before anything produced by a third-party script reaches disk or logs.

const EXACT_SECRET_KEY = /^(cookie|set-cookie|authorization|proxy-authorization|auth|authheader|basicauth|proxyauth|authentication)$/i;
const SECRET_KEY_FRAGMENT = /token|secret|api[-_]?key|password|passwd|pwd|credentials?/i;

function isSecretKey(key) {
  return EXACT_SECRET_KEY.test(key) || SECRET_KEY_FRAGMENT.test(key);
}

function redactSecrets(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? '[REDACTED]' : redactSecrets(item, seen);
  }
  return out;
}

module.exports = { redactSecrets, isSecretKey };
