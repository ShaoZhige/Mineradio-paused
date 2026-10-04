'use strict';

// 登录弹窗的文案由 JS 渲染，data-i18n 够不到，只能靠模块自己走词典。
// 这条守卫盯住三件事：
//   1. 已接线的键必须真的经过 loginText 取值；
//   2. loginText 缺键时退回兜底中文，不会把裸键名显示给用户；
//   3. 语言变更订阅里的 window 防护必须是函数体第一条语句 —— 这些模块会被单元测试
//      用 vm.runInContext 单独求值，沙箱里没有 window，防护晚一步就等于没有。
// The login modal renders its copy from JS, so the module has to route through the
// dictionary itself. This guard pins the wiring, the missing-key fallback, and one
// ordering rule that has already bitten us: the window guard inside the language
// subscription must come first, because unit tests evaluate these modules standalone
// in a sandbox that has no window.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { accessorInSandbox } = require('./helpers/module-source');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js');

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const WIRED_KEYS = [
  'scan_qr_login', 'qq_scan_desc', 'netease_web_scan_desc', 'netease_app_scan_desc',
  'collapse_import', 'login_cookie_hint', 'wait_scan_confirm', 'login_open_qq_window',
  'open_login_window', 'click_web_netease', 'login_generating_qr', 'refresh_qr',
  'wait_scan', 'login', 'web_login', 'error_prefix', 'saved_netease_session',
  'scan_netease_app', 'login_success', 'web_login_unsupported', 'opened_netease_window',
  'netease_login_incomplete', 'syncing_netease', 'netease_saved', 'netease_loggedin',
  'auto_web_login_unsupported', 'qq_window_opened_scan', 'qq_login_incomplete',
  'qq_loggedin', 'qq_synced', 'qq_login_failed', 'login_success_syncing',
  'login_qr_confirmed_no_credential',
];

// 接线前写在状态行 / toast 实参位置上的裸中文。
const NO_LONGER_BARE = [
  '网易云会话已保存',
  '当前环境不支持自动网页登录，可先使用手动导入。',
  '正在同步网易云会话…',
  '已打开网易云窗口，请在官方页面扫码登录…',
  '当前环境不支持官方网页登录，正在尝试旧二维码…',
  '请使用网易云音乐 App 扫码',
  '扫码已确认，但没有拿到登录凭证，请刷新二维码重试',
  'QQ 音乐已登录: ',
  'QQ 账号已同步: ',
  '网易云已登录: ',
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('登录弹窗的每条动态文案都经 loginText 取值', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  const missing = WIRED_KEYS.filter((key) => code.indexOf("loginText('" + key + "'") < 0);
  assert.deepStrictEqual(missing, [], '这些键没有走词典: ' + missing.join(', '));
});

test('loginText 缺键时露出键名而不是空串（漏译要吵，不要静默）', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  // 行为断言比正则强：真在裸沙箱里跑一遍，直接看缺键时返回了什么。
  // Behavior beats shape — run it for real and read what a missing key returns.
  const missing = accessorInSandbox(source, 'loginText', { t: (key) => key });
  // 缺键且无兜底 -> 返回键名。空串会让漏译静默发生，键名是一眼能认出的错误。
  assert.strictEqual(missing('login_missing_key'), 'login_missing_key', '缺键且无兜底时应返回键名');
  assert.strictEqual(missing('login_missing_key', '确定'), '确定', '有兜底时仍应退回兜底');
  const present = accessorInSandbox(source, 'loginText', { t: () => '词典文案' });
  assert.strictEqual(present('btn_confirm', '确定'), '词典文案');
  const bare = accessorInSandbox(source, 'loginText', null);
  assert.strictEqual(bare('btn_confirm'), 'btn_confirm', '没有 i18n 运行时也要露出键名');
  assert.strictEqual(bare('btn_confirm', '确定'), '确定', '没有 i18n 运行时且有兜底才退回兜底');
});

test('状态行与 toast 不再直接喂裸中文', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  const offenders = NO_LONGER_BARE.filter((literal) =>
    new RegExp('(textContent|innerHTML)\\s*=\\s*[\'"]' + escapeRegExp(literal)).test(code)
    || new RegExp('showToast\\(\\s*[\'"]' + escapeRegExp(literal)).test(code));
  assert.deepStrictEqual(offenders, [], '这些文案又写回裸中文了: ' + offenders.join(', '));
});

test('语言变更订阅存在，且 window 防护排在访问 window 之前', () => {
  const code = fs.readFileSync(MODULE, 'utf8');
  assert.ok(/onLanguageChange\(/.test(code), '没有订阅语言变更，切语言后弹窗文案不会更新');
  const iife = /\(function bindLoginModalLanguage\(\)\s*\{([\s\S]*?)\n\}\)\(\);/.exec(code);
  assert.ok(iife, '没能解析出订阅 IIFE');
  // 剥掉注释后再看第一条语句，否则注释行会把位置判断带偏。
  // Strip comments before reading the first statement; comments would skew the check.
  const bare = stripComments(iife[1]).trim();
  const firstStatement = bare.split(';')[0];
  assert.ok(/typeof window === 'undefined'/.test(firstStatement),
    'window 防护不是函数体第一条语句（实际第一条是：' + firstStatement.trim().slice(0, 80) + '）—— '
    + '写在读 window 之后等于没拦，单元测试在无 window 的沙箱里求值时会直接抛错');
  const firstWindowUse = bare.indexOf('window.');
  assert.ok(firstWindowUse >= 0, '没找到 window 用法，订阅逻辑可能已失效');
  assert.ok(bare.indexOf('typeof window') < firstWindowUse,
    'window 防护出现在读 window 之后，等于没拦');
  // 回调必须真的重绘：只注册不重绘，切语言后弹窗还是旧语言。
  assert.ok(/updateLoginProviderUi\(\)/.test(bare),
    '语言变更回调没有调用 updateLoginProviderUi()，注册了也不会重绘');
});
