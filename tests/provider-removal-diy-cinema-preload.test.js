const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// Spotify 已回归，这里守卫的是"接入面完整"：登录/设置 UI、账号胶囊与登录工作流排序、HTTP 路由未被 404 拦死。
// Spotify is restored; this asserts the login/capsule/HTTP surface stays intact.
test('restored spotify provider keeps its user-facing login and HTTP surface', () => {
  const index = read('public', 'index.html');
  const accounts = read('public', 'js', 'modules', '08-account', '01-login-modal-utils.js');
  const flows = read('public', 'js', 'modules', '08-account', '03-login-modal-flows.js');
  const server = read('server/server.js');

  assert.match(index, /login-provider-spotify/);
  assert.match(index, /spotify-setup-wizard/);
  // ⚠️ 平台清单现在由 provider 注册表派生，源码里不再有 `ACCOUNT_PROVIDER_KEYS = ['netease', ...]`
  //    这样的字面量数组 —— 钉字面量的写法会因为"清单改成派生了"而失败，而它真正要守的是
  //    「spotify 仍在这两个集合里」。所以改为在沙箱里跑注册表、断言派生结果，判据跟着意图走。
  // ⚠️ The platform lists now derive from the provider registry, so the literal arrays are gone. A
  //    judgement pinned to the literal would fail merely because the implementation changed shape,
  //    while what it actually guards is "spotify is still in both sets". So run the registry in a
  //    sandbox and assert the derived result: the check follows the intent, not the syntax.
  const { withProviderRegistry } = require('./helpers/module-source');
  const registrySandbox = { console };
  vm.createContext(registrySandbox);
  vm.runInContext(withProviderRegistry('this.loginProviders = providerRegistryKeysWith("login");'), registrySandbox);
  assert.ok(registrySandbox.loginProviders.includes('spotify'),
    'spotify must stay in the account platform set (derived from the provider registry)');
  assert.match(accounts, /ACCOUNT_PROVIDER_KEYS = providerRegistryKeysWith\('login'\)/);
  assert.match(flows, /LOGIN_WORKFLOW_PROVIDERS = providerRegistryKeysWith\('login'\)/);
  // 旧的"已移除平台"404 拦截会盖掉全部 /api/spotify/* 真实路由。
  // The legacy removed-provider 404 gate would shadow every live /api/spotify/* route.
  assert.doesNotMatch(server, /pn\.indexOf\('\/api\/spotify\/'\) === 0/);
  assert.match(server, /pn === '\/api\/spotify\/status'/);
  assert.match(server, /pn === '\/api\/spotify\/config'/);
});

// 全屏工具行挂在账号胶囊下方：它跟着**最下面那颗**胶囊走，胶囊隐藏/换行时位置也要跟上。
// The fullscreen tool row hangs below the account pills and follows the bottom-most one.
test('fullscreen tool row follows the bottom-most visible account pill', () => {
  const source = read('public', 'js', 'modules', '00-state', '02-preferences-ui-modes.js');
  assert.match(source, /querySelectorAll\('\.top-account-pill'\)/);
  assert.match(source, /bounds\.bottom = Math\.max\(bounds\.bottom, rect\.bottom\)/);
  assert.match(source, /top = anchor\.bottom \+ gap/);
  assert.match(source, /new ResizeObserver\(scheduleFullscreenToolsLayout\)/);
  assert.match(source, /new MutationObserver\(scheduleFullscreenToolsLayout\)/);
});

test('full-track cinematic analysis waits for playback and retries bounded failures', () => {
  const source = read('public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js');
  assert.match(source, /function queueCurrentTrackAnalysis\(delay\)/);
  assert.match(source, /if \(!audio \|\| audio\.paused\) \{\s*queueCurrentTrackAnalysis\(620\)/);
  assert.match(source, /analysisAttempts\+\+/);
  assert.match(source, /analysisAttempts < 3/);
  assert.match(source, /smoothBeatMapHandoff\(songId, map, token, song \|\| null\)/);
  assert.match(source, /skipMusicTempo: beatAnalysisConfig\.skipMusicTempoWhilePlaying && !audio\.paused/);
});
