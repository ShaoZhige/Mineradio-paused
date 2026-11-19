'use strict';

// 冷启动的 Apple Music 宿主第一次 accountStatus 要 12~25 秒：它以前排在 showWindow 前面，
// 用户点「连接 Apple Music」后要干等半分钟才看到窗口，看起来就是"拉不起来"。
// 这里钉住三件事：窗口先开、失败补一次重试、失败时给出提示且不再往下轮询。
// The first accountStatus of a cold host takes 12–25 s and used to run before showWindow, so the
// window showed half a minute after the click. Pin the order, the single retry, and the message.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./helpers/module-source');

const MODULE = path.join(__dirname, '..', 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js');
const source = fs.readFileSync(MODULE, 'utf8');

// extractFunction 从 `function` 开头切片，会丢掉前面的 `async`；补回去，否则 await 不合法。
// extractFunction slices from `function`, dropping the `async` keyword that makes await legal.
function asyncSlice(name) {
  return 'async ' + extractFunction(source, name);
}

function sandboxWith(showResults, statusResults) {
  const calls = [];
  const toasts = [];
  const sandbox = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    JSON,
    globalThis: {},
  };
  sandbox.window = {
    desktopWindow: {
      appleMusicRequest(operation) {
        calls.push(operation);
        if (operation === 'showWindow') {
          const next = showResults.length > 1 ? showResults.shift() : showResults[0];
          return Promise.resolve(next);
        }
        return Promise.resolve({ ok: true, data: {} });
      },
    },
  };
  sandbox.loginText = (key, fallback) => (fallback == null ? key : fallback);
  sandbox.showToast = (text) => toasts.push(text);
  sandbox.updateLoginProviderUi = () => { };
  sandbox.normalizeAppleMusicLoginStatus = (info) => Object.assign({ provider: 'applemusic' }, info, {
    nickname: (info && info.data && info.data.nickname) || '',
    error: (info && info.error) || '',
  });
  sandbox.appleMusicLoginStatus = { loggedIn: false, configured: true, error: '' };
  sandbox.appleMusicLoginBusy = false;
  sandbox.refreshAppleMusicLoginStatus = async () => {
    calls.push('accountStatus');
    const next = statusResults.length > 1 ? statusResults.shift() : statusResults[0];
    sandbox.appleMusicLoginStatus = sandbox.normalizeAppleMusicLoginStatus(next);
    return sandbox.appleMusicLoginStatus;
  };
  sandbox.refreshUserPlaylists = async () => { calls.push('playlists'); };
  const code = asyncSlice('openAppleMusicWindow') + '\n'
    + asyncSlice('openAppleMusicLogin') + '\n'
    + 'this.openAppleMusicLogin = openAppleMusicLogin;\n'
    + 'this.readBusy = () => appleMusicLoginBusy;\n';
  vm.runInNewContext(code, sandbox);
  return { sandbox, calls, toasts };
}

test('窗口先打开，账号状态后查询', async () => {
  const { sandbox, calls } = sandboxWith([{ ok: true }], [{ loggedIn: true, data: { nickname: 'X' } }]);
  await sandbox.openAppleMusicLogin();
  assert.strictEqual(calls[0], 'showWindow', '第一个动作必须是打开窗口：' + calls.join(','));
  assert.ok(calls.includes('accountStatus'), '窗口打开后仍要查状态');
  assert.ok(calls.indexOf('showWindow') < calls.indexOf('accountStatus'), '状态查询不能挡在窗口前面：' + calls.join(','));
});

test('宿主加载失败会退出，窗口打开失败后自动补一次重试', async () => {
  const { sandbox, calls } = sandboxWith([{ ok: false, error: 'disconnected' }, { ok: true }], [{ loggedIn: true }]);
  await sandbox.openAppleMusicLogin();
  const shows = calls.filter((call) => call === 'showWindow');
  assert.strictEqual(shows.length, 2, '失败后应当重试一次：' + calls.join(','));
  assert.ok(calls.includes('accountStatus'), '重试成功后继续查询账号');
});

test('两次都打不开窗口时给出提示，并不再轮询', async () => {
  const { sandbox, calls, toasts } = sandboxWith([{ ok: false, error: 'request-failed' }], [{ loggedIn: false }]);
  await sandbox.openAppleMusicLogin();
  assert.strictEqual(calls.filter((call) => call === 'showWindow').length, 2);
  assert.ok(!calls.includes('accountStatus'), '窗口都没开就不该再查账号：' + calls.join(','));
  assert.ok(toasts.some((text) => text.indexOf('Apple Music 窗口打不开') >= 0), '要告诉用户窗口没打开：' + toasts.join('|'));
  assert.strictEqual(sandbox.appleMusicLoginStatus.error, 'window-unavailable', '状态行也要能说出窗口打不开');
});

test('窗口打开后提示用户在窗口内登录', async () => {
  const { sandbox, toasts } = sandboxWith([{ ok: true }], [{ loggedIn: true }]);
  await sandbox.openAppleMusicLogin();
  assert.ok(toasts.some((text) => text.indexOf('窗口内登录') >= 0), '要说明登录只能窗口里做：' + toasts.join('|'));
});

test('登录成功后收起窗口并刷新歌单', async () => {
  // 第一次读到未登录 → 轮询 → 第二次读到已登录，才走"收起窗口"这条路。
  // Signed out on the first read, signed in on the next poll: only then is the window hidden.
  const { sandbox, calls } = sandboxWith([{ ok: true }], [{ loggedIn: false }, { loggedIn: true, data: { nickname: 'A' } }]);
  await sandbox.openAppleMusicLogin();
  assert.ok(calls.includes('hideWindow'), '登录成功后收起窗口：' + calls.join(','));
  assert.ok(calls.includes('playlists'), '登录成功后刷新歌单：' + calls.join(','));
  assert.strictEqual(sandbox.readBusy(), false, '结束后必须解除忙碌状态');
});

test('没有桌面桥时按运行时不处理，不去碰窗口', async () => {
  const { sandbox, calls } = sandboxWith([{ ok: true }], [{ loggedIn: false }]);
  sandbox.window.desktopWindow = {};
  await sandbox.openAppleMusicLogin();
  assert.deepStrictEqual(calls, [], '没有 appleMusicRequest 就不该发起请求');
  assert.strictEqual(sandbox.appleMusicLoginStatus.error, 'runtime-unavailable');
});
