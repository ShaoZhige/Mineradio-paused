'use strict';

// Spotify 与 Apple Music 的会话不在渲染进程里：一个要等 /api/spotify/status，一个要等 WebView2
// 宿主冷启动（12~25 秒）。进播放器的第一帧它们只能是"未登录"，用户看到的就是"这俩平台一开始
// 没状态，过一会儿才连上"。修法是两条腿：启动时就发起查询，同时把上次确认过的登录态缓存下来
// 先照它渲染。这里钉住缓存的三条底线——只存显示字段、会过期、登出即删。
// SP/AM sessions live outside the renderer, so the first frame can only read "signed out". Fix:
// query at startup AND render from the last confirmed state. This pins the cache's three rules:
// display fields only, it expires, and logout wipes it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./helpers/module-source');

const ROOT = path.join(__dirname, '..');
const READERS = path.join(ROOT, 'public', 'js', 'modules', '00-state', '00b-local-readers.js');
const STARTUP = path.join(ROOT, 'public', 'js', 'modules', '10-shell', '05-startup-bindings.js');
const LOGOUT = path.join(ROOT, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js');
const STATUS = path.join(ROOT, 'public', 'js', 'modules', '08-account', '02-login-status.js');

const sources = {
  readers: fs.readFileSync(READERS, 'utf8'),
  startup: fs.readFileSync(STARTUP, 'utf8'),
  logout: fs.readFileSync(LOGOUT, 'utf8'),
  status: fs.readFileSync(STATUS, 'utf8'),
};

const DAY = 24 * 60 * 60 * 1000;
const FIELDS = ['loggedIn', 'configured', 'nickname', 'avatar', 'avatarUrl', 'userId', 'accountId', 'product', 'storefront'];
const FUNCTIONS = [
  'readProviderLoginCacheTable',
  'writeProviderLoginCacheTable',
  'readCachedProviderLoginStatus',
  'hydrateCachedLoginStatus',
  'rememberProviderLoginStatus',
  'forgetCachedProviderLoginStatus',
  'forgetAllCachedProviderLoginStatus',
];

function sandboxAt(nowMs, stored) {
  let raw = stored == null ? null : JSON.stringify(stored);
  const sandbox = {
    console,
    JSON,
    Object,
    Math,
    Date: { now: () => nowMs },
    localStorage: {
      getItem() { return raw; },
      setItem(_key, value) { raw = String(value); },
      removeItem() { raw = null; },
    },
    PROVIDER_LOGIN_CACHE_KEY: 'mineradio-provider-login-cache-v1',
    PROVIDER_LOGIN_CACHE_TTL_MS: 7 * DAY,
    PROVIDER_LOGIN_CACHE_FIELDS: FIELDS,
  };
  const code = FUNCTIONS.map((name) => extractFunction(sources.readers, name)).join('\n')
    + '\nthis.read = readCachedProviderLoginStatus;'
    + 'this.hydrate = hydrateCachedLoginStatus;'
    + 'this.remember = rememberProviderLoginStatus;'
    + 'this.forget = forgetCachedProviderLoginStatus;'
    + 'this.forgetAll = forgetAllCachedProviderLoginStatus;'
    + 'this.table = readProviderLoginCacheTable;';
  vm.runInNewContext(code, sandbox);
  return { sandbox, dump: () => (raw == null ? null : JSON.parse(raw)) };
}

test('缓存命中的条目叠到默认状态上，并标记来自缓存', () => {
  const now = 1e12;
  const { sandbox } = sandboxAt(now, {
    spotify: { loggedIn: true, nickname: 'Shao', product: 'premium', savedAt: now - 1000 },
  });
  const status = sandbox.hydrate('spotify', { provider: 'spotify', loggedIn: false, nickname: 'Spotify' });
  assert.strictEqual(status.loggedIn, true);
  assert.strictEqual(status.nickname, 'Shao');
  assert.strictEqual(status.provider, 'spotify', '默认状态里的字段要保留');
  assert.strictEqual(status.fromCache, true, '刷新函数据此区分"上次看过"和"刚确认的"');
  assert.strictEqual(status.cachedAt, now - 1000);
});

test('超过 7 天或没有时间戳的条目一律不认', () => {
  const now = 1e12;
  const expired = sandboxAt(now, { applemusic: { loggedIn: true, nickname: 'A', savedAt: now - 8 * DAY } });
  assert.strictEqual(expired.sandbox.read('applemusic'), null, '过期条目必须失效');

  const undated = sandboxAt(now, { applemusic: { loggedIn: true, nickname: 'A' } });
  assert.strictEqual(undated.sandbox.read('applemusic'), null, '没有时间戳的条目来历不明，不能当真');
});

test('只缓存显示字段，不把 VIP 判定、播放能力这类派生结论带进去', () => {
  const now = 1e12;
  const { sandbox, dump } = sandboxAt(now, null);
  sandbox.remember('spotify', {
    loggedIn: true,
    nickname: 'Shao',
    avatar: 'https://x/a.png',
    vipType: 1,
    isVip: true,
    playbackKeyReady: true,
    tokenFileExists: true,
    rateLimited: false,
  });
  const entry = dump().spotify;
  assert.strictEqual(entry.loggedIn, true);
  assert.strictEqual(entry.nickname, 'Shao');
  assert.strictEqual(entry.avatar, 'https://x/a.png');
  assert.strictEqual(entry.vipType, undefined, 'VIP 结论会过期，不能从缓存回填');
  assert.strictEqual(entry.isVip, undefined);
  assert.strictEqual(entry.playbackKeyReady, undefined);
  assert.strictEqual(entry.tokenFileExists, undefined);
});

test('记录到未登录时把条目删掉，而不是留一条 loggedIn:false', () => {
  const now = 1e12;
  const { sandbox, dump } = sandboxAt(now, { spotify: { loggedIn: true, nickname: 'S', savedAt: now } });
  sandbox.remember('spotify', { loggedIn: false });
  assert.deepStrictEqual(dump(), {}, '未登录不该在缓存里留痕');
});

test('登出只清对应平台，别的平台不受牵连', () => {
  const now = 1e12;
  const { sandbox, dump } = sandboxAt(now, {
    spotify: { loggedIn: true, nickname: 'S', savedAt: now },
    applemusic: { loggedIn: true, nickname: 'A', savedAt: now },
  });
  sandbox.forget('spotify');
  assert.strictEqual(dump().spotify, undefined);
  assert.ok(dump().applemusic, '退 Spotify 不该把 Apple Music 一起清掉');
  sandbox.forgetAll();
  assert.strictEqual(dump(), null, '全部退出要把整张表删掉');
});

test('启动时就把 Spotify 查起来，并真正启动它的定时器', () => {
  const line = sources.startup.split('\n').find((text) => text.indexOf('var startupLoginStatusPromise = Promise.all(') === 0);
  assert.ok(line, '找不到启动的登录状态 Promise.all');
  assert.ok(line.indexOf('refreshSpotifyLoginStatus()') > 0, 'Spotify 必须和其他平台一起在启动时查询');
  assert.ok(/startSpotifyLoginStatusAutoRefresh\(\);/.test(sources.startup), '定时器此前只定义没启动，要接上');
});

test('Apple Music 只在缓存说"上次登着"时才后台补验', () => {
  assert.ok(/appleMusicLoginStatus\.loggedIn && appleMusicLoginStatus\.fromCache/.test(sources.startup),
    '没有缓存还去拉 WebView2，会让从没用过 Apple 的人白付一份内存');
  assert.ok(/refreshAppleMusicLoginStatus\(\)/.test(sources.startup), '缓存命中时要在后台补验一次');
});

test('登出会清缓存，刷新成功会写缓存', () => {
  assert.ok(/forgetCachedProviderLoginStatus\(provider\)/.test(sources.logout),
    'finishProviderLogout 必须清掉对应平台的显示缓存');
  assert.ok(/forgetAllCachedProviderLoginStatus\(\)/.test(sources.logout),
    '全部退出要清整张表');
  assert.ok(/rememberProviderLoginStatus\('spotify'/.test(sources.status),
    'Spotify 状态刷新成功要写缓存，否则下次启动仍然没有状态');
});

// 定时器是本轮才真正启动的（之前只定义没调用）。它每 45 秒跑一次，如果"一直没登录"也走清理
// 分支，歌单目录就会每 45 秒重刷一次。钉住这个条件，免得以后被"顺手简化"回去。
// The 45 s timer only started running this round. If the signed-out branch cleaned up
// unconditionally, the shelf would re-render every 45 s for users who never signed in.
test('未登录轮询不重复清歌单，只有真的丢失会话才收拾残局', () => {
  const body = sources.status;
  assert.ok(/var hadSession = prevLogged \|\| spotifyLoginWasLoggedIn;/.test(body), '清理必须以"之前有会话"为前提');
  const guard = body.indexOf('if (hadSession) {');
  assert.ok(guard > 0, '缺少 hadSession 守卫');
  const tail = body.slice(guard, guard + 800);
  assert.ok(/spotifyPlaylists = \[\];/.test(tail), '真的丢失会话时仍要清歌单');
  assert.ok(/playlistCatalogRevision \+= 1;/.test(tail));
});
