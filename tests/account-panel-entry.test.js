'use strict';

// 账号胶囊的点击入口：**只有一个** —— 登录 / 平台管理弹窗（每个平台自带退出按钮）。
//
// 背景：2026-11-21 之前这里被改成「已登录 → 弹 #user-modal 账号信息面板」，用户实际用过
// 之后明确反馈多余且难看，要求删掉。这个测试盯住两点：
//   1. 点胶囊永远走 showLoginModal，不许再弹账号信息面板；
//   2. 已登录时要带当前平台作为默认 provider（否则弹窗会停在别的平台上）。
//
// Pins a single entry point: the capsule always opens the login/platform modal.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const utils = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/08-account/01-login-modal-utils.js'), 'utf8');

function userBtnClickBody() {
  const at = utils.indexOf('function onUserBtnClick()');
  assert.ok(at > 0, '找不到 onUserBtnClick');
  return utils.slice(at, utils.indexOf('\n}', at));
}

test('点胶囊一律打开登录弹窗，不再弹账号信息面板', () => {
  const body = userBtnClickBody();
  assert.ok(body.includes('showLoginModal('), '必须打开登录 / 平台管理弹窗');
  assert.ok(!/showUserModal\s*\(/.test(body), '不许再弹 #user-modal 账号信息面板');
});

test('已登录时带着当前平台打开弹窗', () => {
  const body = userBtnClickBody();
  assert.match(body, /hasAnyPlatformLogin\(\)\s*\?\s*firstLoggedProvider\(\)/,
    '已登录要落到第一个已登录平台，避免弹窗停在未登录的平台');
  assert.match(body, /source:\s*'top-account'/);
});

test('拖动后吞掉那一次点击的守卫还在（否则拖胶囊会误开弹窗）', () => {
  const body = userBtnClickBody();
  assert.ok(body.includes('topAccountPillClickSuppressed'), '拖动结束的那次点击必须被吞掉');
});
