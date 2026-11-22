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

// 「一启动登录会掉」：companion 页面还在热身时 v1/me/storefront 拿不到区域，以前回
// storefront-unavailable，上层把它当成"没人登录"→ 抹掉缓存 → 用户看到登录掉了，过一会儿又回来。
// 现在只有 Apple 明确 401/403，或 MusicKit 自己说没授权，才算真登出。
test('热身态的 storefront-unavailable 不许抹掉登录缓存', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const flows = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/08-account/03-login-modal-flows.js'), 'utf8');
  const at = flows.indexOf('async function refreshAppleMusicLoginStatus(');
  assert.ok(at > 0);
  const body = flows.slice(at, flows.indexOf('\nasync function openAppleMusicWindow', at));

  assert.match(body, /var storefrontUnknown = result && result\.ok === false && result\.error === 'storefront-unavailable';/);
  assert.match(body, /result\.data && typeof result\.data\.authorized === 'boolean'/,
    '要用 companion 带回来的 authorized 区分热身与真登出');
  assert.match(body, /var signedOut = result && result\.ok === false\s*\n\s*&& \(result\.error === 'auth-required' \|\| \(storefrontUnknown && authorizedFlag === false\)\);/,
    '只有 auth-required 或 authorized===false 才算登出');
  // 旧写法（把 storefront-unavailable 直接当登出）必须消失。
  assert.ok(!/result\.error === 'auth-required' \|\| result\.error === 'storefront-unavailable'/.test(body),
    '不能把 storefront-unavailable 直接当登出');
});

// 热身阶段 mk.isAuthorized 还是 false（配置完成前没意义）。如果直接把它当结论，启动瞬间就会
// 判成"退出了"，缓存被清、歌单变"未载入"。只有页面真的答上（HTTP 200）才有资格下结论。
test('热身态不得把 authorized 当结论：只有 200 才算', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'desktop/apple-music/companionRequests.cjs'), 'utf8');
  assert.match(src, /const answered = status === 200;/);
  assert.match(src, /let authorized = answered \? \(mk\.isAuthorized === true\) : null;/,
    '未答上时必须给 null，让上层保留缓存');
  // 超时是"没答上来"，只能在 MusicKit 明确认可时上报 true；false 一律降成 null，
  // 否则一次请求挂死就会把已经连上的账号判成退出。
  assert.match(src, /if \(storefrontTimedOut && mk\.isAuthorized === true\) authorized = true;/,
    '超时只允许上报明确的授权态');
  assert.ok(!/const authorized = \(typeof mk\.isAuthorized === 'boolean'\)/.test(src),
    '不能无条件采纳 isAuthorized——热身期它是 false');
});

// AM 的接入进度条：与 Spotify 向导同思想（每一步由真实回包判断），但链路不同 ——
// 组件启动 → 页面就绪 → 账号确认 → 歌单自检。
test('Apple Music 接入进度条按真实回包推进四步', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/modal.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/08-account/03-login-modal-flows.js'), 'utf8');

  // DOM：四格
  const chips = html.match(/data-am-progress="[1-4]"/g) || [];
  assert.equal(chips.length, 4, '进度条必须有四个步骤');
  assert.ok(html.indexOf('id="apple-music-wizard"') > 0);
  assert.ok(html.indexOf('id="apple-music-progress-note"') > 0, '需要一行说明当前在做什么');

  // 只在 AM 模式下显示
  assert.match(css, /\.login-auth-drawer\.apple-music-mode \.apple-music-wizard\s*\{\s*display: block/);

  // 状态映射：runtime → page → account
  assert.match(js, /var appleMusicSetupStages = \{ runtime: false, page: false, account: false \};/);
  assert.match(js, /if \(error === 'runtime-unavailable'\) \{/);
  assert.match(js, /if \(error !== 'not-ready' && error !== 'request-failed'\) appleMusicSetupStages\.page = true;/,
    'not-ready 说明页面还没就绪，不能算过');
  assert.match(js, /1: !!appleMusicSetupStages\.runtime,/);
  assert.match(js, /4: !!\(appleMusicPlaylists && appleMusicPlaylists\.length\)/, '第四步要看真的读到歌单');

  // 渲染：complete/current + aria
  assert.match(js, /chip\.classList\.toggle\('complete', !!done\[index\]\);/);
  assert.match(js, /chip\.classList\.toggle\('current', index === current\);/);
  assert.match(js, /appleWizard\.setAttribute\('aria-hidden', isAppleMusic \? 'false' : 'true'\);/);
  assert.match(js, /function recheckAppleMusicSetup\(\)/, '需要一个手动重测入口');
});

// 未登录绝不拉起 companion（WebView2 启动十几秒 + 几百兆），已登录也别反复验证。
test('未登录不拉起 Apple companion，已登录按 TTL 验证', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const flows = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/08-account/03-login-modal-flows.js'), 'utf8');
  const shell = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/06-lyrics/01-playlist-panel-shell.js'), 'utf8');

  // 门禁：非 force 且缓存不是"登着" → 直接返回，不发请求
  assert.match(flows, /var cachedLoggedIn = !!\(appleMusicLoginStatus && appleMusicLoginStatus\.loggedIn\);/);
  assert.match(flows, /if \(!cachedLoggedIn \|\| fresh\) return appleMusicLoginStatus;/,
    '未登录（或刚验过）时不许发起 accountStatus');
  assert.match(flows, /var APPLE_MUSIC_STATUS_TTL_MS = 5 \* 60 \* 1000;/);

  // 用户主动入口必须 force，否则点了检测也会被门禁挡掉
  assert.ok(flows.indexOf('refreshAppleMusicLoginStatus(true)') > 0, '登录界面里的检测要 force');

  // 打开歌单栏不再为"未登录"拉起
  assert.match(shell, /appleMusicLoginStatus\.loggedIn && appleMusicLoginStatus\.fromCache/);
  assert.ok(!/Promise\.resolve\(\)\.then\(refreshAppleMusicLoginStatus\)/.test(shell),
    '旧的"不是登着就探一次"要去掉');
});

// 启动阶段：补验排到首屏之后，成功后顺手把歌单首页塞进服务端缓存。
test('启动补验不抢首屏，成功后预取歌单首页', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/modules/10-shell/05-startup-bindings.js'), 'utf8');
  assert.match(src, /requestIdleCallback\(runAppleMusicStartupProbe, \{ timeout: 6000 \}\)/);
  assert.match(src, /apiJson\('\/api\/apple-music\/playlists\?limit=25&offset=0'/,
    '补验成功后要预取歌单首页，面板打开才是秒开');
});
