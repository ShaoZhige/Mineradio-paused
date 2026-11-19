'use strict';

// 苹果对部分账号停用了密码登录：网页端 music.apple.com 同样报「密码错误」，所以这不是我们的
// 窗口坏了，而是账号侧没有密码登录这条路。登录面板必须在说明里直接点出「改用手机号验证码」，
// 否则用户只会一遍遍重试密码，然后把问题当成播放器的 bug 报回来。
// Apple disabled password sign-in for some accounts, and the web page fails identically, so the
// login panel has to name the verification-code path instead of letting users retry forever.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js');
const CSS = path.join(ROOT, 'public', 'css', 'modal.css');
const LANGS = ['zh_cn', 'zh_tw', 'zh_hk', 'en_us', 'ja_jp', 'ru_ru', 'es_es'];
const KEY = 'login_apple_music_password_hint';

test('七套词典都给出密码报错时的替代登录方式', () => {
  LANGS.forEach((lang) => {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', lang + '.json'), 'utf8'));
    const text = dict[KEY];
    assert.ok(typeof text === 'string' && text.trim().length > 0, lang + ' 缺少 ' + KEY);
  });
});

test('Apple 面板把提示挂进说明行，而不是只写在词典里', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  const at = source.indexOf("loginText('" + KEY + "'");
  assert.ok(at > 0, '说明行没有引用 ' + KEY);
  const around = source.slice(Math.max(0, at - 700), at + 400);
  assert.ok(around.indexOf('login-am-signin-hint') > 0, '提示需要一个独立样式钩子，方便与正文区分');
  assert.ok(around.indexOf("loginText('login_apple_music_desc'") > 0, '提示要接在原有说明后面，不能顶掉它');
});

test('提示样式落在登录说明行内，字号小于正文', () => {
  const css = fs.readFileSync(CSS, 'utf8');
  const rule = css.match(/\.login-auth-copy \.desc \.login-am-signin-hint\s*\{([^}]*)\}/);
  assert.ok(rule, '缺少 .login-am-signin-hint 样式');
  assert.ok(/font-size:\s*10\.5px/.test(rule[1]), '提示要比 11px 的正文更小一档');
});
