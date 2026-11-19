'use strict';

// 单个平台登出：
//   1. 登录弹窗里每个平台节点都必须带一个只退自己的按钮 —— 账号面板那个按钮退的是
//      「当前展示的平台」，想退另一个得先切换，而弹窗里没有切换入口；
//   2. 登出必须按平台分派，不能"谁在线就退谁"：未知名字不许静默折成网易云；
//   3. 收尾一致：清掉该平台的界面残留、重建歌架、把展示账号指向还活着的那个。
// Per-platform sign-out: every login node carries a button for its own platform, the dispatch never
// falls back to "whichever account happens to be displayed", and the shared tail always runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction, loadDict } = require('./helpers/module-source');

const appRoot = path.resolve(__dirname, '..');
const logoutSource = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'),
  'utf8'
);
const flowsSource = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'),
  'utf8'
);
const modalCss = fs.readFileSync(path.join(appRoot, 'public', 'css', 'modal.css'), 'utf8');

// extractFunction 从 `function` 起切，async 前缀会丢，这里补回去。
// extractFunction slices from the `function` keyword and drops the async prefix.
function fragment(source, names) {
  return names.map((name) => {
    const body = extractFunction(source, name);
    return source.includes('async function ' + name + '(') ? 'async ' + body : body;
  }).join('\n');
}

function buildSandbox(loggedIn) {
  const prelude = `
    var DICT = ${JSON.stringify(loadDict('zh_cn'))};
    var ACCOUNT_PROVIDER_KEYS = ['netease', 'qq', 'kugou', 'qishui', 'spotify', 'applemusic'];
    var calls = [];
    var loggedInProviders = ${JSON.stringify(loggedIn)};
    var loginStatus = { loggedIn: loggedInProviders.indexOf('netease') >= 0 };
    var qqLoginStatus = { provider: 'qq', loggedIn: loggedInProviders.indexOf('qq') >= 0, userId: 'qq-1' };
    var kugouLoginStatus = { provider: 'kugou', loggedIn: loggedInProviders.indexOf('kugou') >= 0 };
    var qishuiLoginStatus = { provider: 'qishui', loggedIn: loggedInProviders.indexOf('qishui') >= 0 };
    var spotifyLoginStatus = { provider: 'spotify', loggedIn: loggedInProviders.indexOf('spotify') >= 0 };
    var appleMusicLoginStatus = { provider: 'applemusic', loggedIn: loggedInProviders.indexOf('applemusic') >= 0 };
    var qqPlaylists = [{ provider: 'qq', id: 'qq-playlist' }];
    var kugouPlaylists = [];
    var qishuiPlaylists = [];
    var spotifyPlaylists = [];
    var appleMusicPlaylists = [{ provider: 'applemusic', id: 'am-playlist' }];
    var userPlaylists = [{ provider: 'netease', id: 'ne-playlist' }].concat(qqPlaylists);
    var playlistCatalogRevision = 0;
    var dualAccountMode = true;
    var activeAccountProvider = loggedInProviders[0] || 'netease';
    var window = {
      desktopWindow: {
        clearQQMusicLogin: function () { calls.push('ipc:clear-qq'); return Promise.resolve(); },
        clearKugouMusicLogin: function () { calls.push('ipc:clear-kugou'); return Promise.resolve(); },
        clearQishuiMusicLogin: function () { calls.push('ipc:clear-qishui'); return Promise.resolve(); },
        clearSpotifyMusicLogin: function () { calls.push('ipc:clear-spotify'); return Promise.resolve(); },
        clearNeteaseMusicLogin: function () { calls.push('ipc:clear-netease'); return Promise.resolve(); },
        appleMusicRequest: function (action) { calls.push('ipc:apple-music:' + action); return Promise.resolve({ ok: true }); }
      }
    };
    function normalizeAccountProviderKey(provider) { return provider; }
    function hasPlatformLogin(provider) { return loggedInProviders.indexOf(provider) >= 0; }
    function hasAnyPlatformLogin() { return true; }
    function firstLoggedProvider() { return loggedInProviders[0] || 'netease'; }
    function accountPanelText(key, fallback) { return DICT[key] || (fallback == null ? key : fallback); }
    function apiJson(url) { calls.push('api:' + url); return Promise.resolve({ ok: true }); }
    function showToast(text) { calls.push('toast:' + text); }
    function renderUserBtn() { calls.push('render-user-btn'); }
    // 登录态的显示缓存（localStorage）在真实模块里由 00b 提供；这里只要一个记录用的桩，
    // 顺便断言登出确实把对应平台从缓存里清了。
    // The display cache comes from 00b in production; a recording stub is enough here, and it
    // doubles as the assertion that logout clears this provider's cached state.
    function forgetCachedProviderLoginStatus(provider) { calls.push('cache-forget:' + provider); }
    function safeShelfRebuild(tag) { calls.push('shelf:' + tag); }
    function updateUserModalUi() { calls.push('account-panel'); }
    function closeUserModal() { calls.push('close-account-panel'); }
    function resetHomeDiscoverAfterLogout(tag) { calls.push('discover:' + tag); }
    function clearQQPlaybackVipEvidence() { calls.push('vip-evidence'); }
  `;
  const sandbox = { console };
  vm.runInNewContext(
    prelude + '\n' + fragment(logoutSource, ['finishProviderLogout', 'logoutProviderAccount', 'logoutActiveAccount']),
    sandbox
  );
  return sandbox;
}

const callsOf = (sandbox) => JSON.parse(JSON.stringify(sandbox.calls));

test('每个登录平台节点都带一个只退自己的按钮', () => {
  const capsule = extractFunction(flowsSource, 'updateLoginProviderCapsuleStatus');
  assert.match(capsule, /createElement\('span'\)[\s\S]{0,200}login-provider-logout/,
    'the node has to build its own sign-out control');
  assert.match(capsule, /setAttribute\('role',\s*'button'\)/, 'the control must announce itself as a button');
  assert.match(capsule, /signOut\.classList\.toggle\('hidden',\s*!st\.loggedIn\)/,
    'a platform that is not signed in must not offer a sign-out button');
  assert.match(capsule, /signOut\.addEventListener\('pointerdown'/,
    'the control has to swallow pointerdown, otherwise pressing it starts a node drag');
  assert.match(capsule, /addEventListener\('click'[\s\S]{0,200}handleLoginProviderSignOut/,
    'the click has to reach the per-platform handler');
  assert.match(flowsSource, /function handleLoginProviderSignOut\(e,\s*provider\)[\s\S]{0,600}logoutProviderAccount\(provider\)/,
    'the handler must sign out the provider it belongs to, not the displayed one');
  assert.match(flowsSource, /var loginProviderSignOutBusyProvider = '';/,
    'a second click while one sign-out is in flight has to be refused');
});

test('登录节点给退出按钮留了独立一列，开关让到最后一列', () => {
  assert.match(modalCss, /grid-template-columns:\s*18px\s+35px\s+minmax\(0,\s*1fr\)\s+auto\s+auto\s+56px/,
    'the capsule grid needs a sixth track: handle, avatar, name, tier, sign-out, switch');
  assert.match(modalCss, /\.login-provider-logout\s*\{[\s\S]{0,220}grid-column:\s*5\b/,
    'the sign-out control owns the fifth column');
  assert.match(modalCss, /\.login-provider-external-switch\s*\{[\s\S]{0,120}grid-column:\s*6\b/,
    'the capsule switch moved to the sixth column');
  assert.match(modalCss, /\.login-provider-logout\.hidden\s*\{\s*display:\s*none/,
    'a hidden sign-out must not leave an empty track behind');
});

test('退 QQ 只动 QQ：别的平台的状态与歌单都不许被带走', async () => {
  const sandbox = buildSandbox(['netease', 'qq', 'kugou']);
  const ok = await sandbox.logoutProviderAccount('qq');

  assert.equal(ok, true);
  const calls = callsOf(sandbox);
  assert.ok(calls.includes('api:/api/qq/logout'), 'the QQ session has to be dropped server-side');
  assert.ok(calls.includes('ipc:clear-qq'), 'the cached QQ login has to be cleared in the main process');
  assert.ok(calls.includes('vip-evidence'), 'QQ membership evidence must not survive a sign-out');
  assert.ok(calls.includes('shelf:qq-logout'), 'the shelf still holds QQ entries after a sign-out');
  assert.ok(calls.includes('account-panel'), 'the account panel has to be redrawn');
  assert.ok(calls.some((call) => call === 'toast:已退出 QQ 音乐'));
  assert.ok(!calls.some((call) => call === 'api:/api/logout'), 'the NetEase session must stay untouched');
  // 显示缓存也要跟着退：留下的登录态会在下次启动把已退出的账号画成"已连接"。
  // The display cache has to follow the sign-out, or the next launch paints it as connected.
  assert.ok(calls.includes('cache-forget:qq'));
  assert.ok(!calls.includes('cache-forget:kugou'), '别的平台的缓存不能被顺手清掉');

  assert.equal(sandbox.qqLoginStatus.loggedIn, false);
  assert.equal(sandbox.kugouLoginStatus.loggedIn, true, 'Kugou was never asked to sign out');
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.userPlaylists.map((pl) => pl.provider))),
    ['netease'],
    'only the QQ playlist may be dropped'
  );
});

test('退出按钮退的是它自己那个平台，不是当前展示的平台', async () => {
  const sandbox = buildSandbox(['netease', 'qq', 'applemusic']);
  sandbox.activeAccountProvider = 'netease';

  await sandbox.logoutProviderAccount('applemusic');

  const calls = callsOf(sandbox);
  assert.ok(calls.includes('ipc:apple-music:logout'), 'Apple Music signs out through the companion window');
  assert.ok(!calls.some((call) => call.startsWith('api:')), 'Apple Music has no server route to call');
  assert.equal(sandbox.appleMusicLoginStatus.loggedIn, false);
  assert.equal(sandbox.loginStatus.loggedIn, true, 'NetEase is the displayed platform and must not be touched');
});

test('账号面板的按钮仍然退当前展示的平台', async () => {
  const sandbox = buildSandbox(['qq', 'kugou']);
  sandbox.activeAccountProvider = 'kugou';

  await sandbox.logoutActiveAccount();

  const calls = callsOf(sandbox);
  assert.ok(calls.includes('api:/api/kugou/logout'));
  assert.ok(!calls.includes('api:/api/qq/logout'));
  assert.equal(sandbox.kugouLoginStatus.loggedIn, false);
});

test('未知平台名与未登录平台都不产生任何请求', async () => {
  const sandbox = buildSandbox(['netease', 'qq']);

  assert.equal(await sandbox.logoutProviderAccount('twitter'), false,
    'an unknown name must not be folded into the default platform and sign it out');
  assert.equal(sandbox.loginStatus.loggedIn, true);
  assert.equal(await sandbox.logoutProviderAccount('kugou'), false, 'a platform that is not signed in has nothing to sign out');
  assert.deepEqual(callsOf(sandbox), [], 'neither call may reach the network or the UI');
});
