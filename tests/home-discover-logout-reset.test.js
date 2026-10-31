// 退出登录后首页卡片必须回到「一开始什么都没有」的样子。
// 这里钉住三件事：重置函数存在且清得够干净、每条退出路径都调它、旧版只清一半的写法不许回潮。
// Logging out must restore the starter home. These tests pin the reset helper, its reach,
// and the fact that every logout path goes through it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DISCOVER_SOURCE = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '05-playback', '03-home-discover-weather.js'),
  'utf8',
);
const LOGOUT_SOURCE = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'),
  'utf8',
);

function functionSource(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '找不到函数 ' + name);
  // 截到下一条顶层 function 声明为止，够这段函数体用。
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:async )?function [A-Za-z0-9_]+\(/);
  return next >= 0 ? source.slice(start, start + 1 + next) : source.slice(start);
}

test('重置函数会清掉三处缓存，而不只是歌曲数组', () => {
  const body = functionSource(DISCOVER_SOURCE, 'resetHomeDiscoverAfterLogout');

  // 1) 首页发现状态
  assert.match(body, /homeDiscoverState\.songs = \[\]/);
  assert.match(body, /homeDiscoverState\.playlists = \[\]/);
  assert.match(body, /homeDiscoverState\.podcasts = \[\]/);
  // 2) 各平台推荐 feed（弹窗里那一排卡片）
  assert.match(body, /homePlatformRecommendationState\.feeds/);
  assert.match(body, /feed\.loaded = false/);
  // 3) 仪表盘指纹缓存：不清就永远判「内容没变」而跳过重绘
  assert.match(body, /homeDashboardDiscoveryCache = \[\]/);
  assert.match(body, /homeDashboardDiscoveryFingerprint = ''/);
  // 在途请求要作废，否则旧账号的数据会写回刚清空的状态
  assert.match(body, /homeDiscoverToken \+= 1/);
  // 清完必须重绘，否则 DOM 上还是旧卡片
  assert.match(body, /renderHomeDiscover\(\)/);
});

test('loaded 标记按「是否还有平台登录」决定，不留半拉状态', () => {
  const body = functionSource(DISCOVER_SOURCE, 'resetHomeDiscoverAfterLogout');
  // 全部退出：loaded = true 当终态，避免别处再触发一次无意义加载
  assert.match(body, /homeDiscoverState\.loaded = true/);
  // 还有别的平台：作废缓存让首页重拉
  assert.match(body, /homeDiscoverState\.loaded = false/);
  assert.match(body, /hasAnyPlatformLogin/);
});

test('每一条退出路径都调用重置函数', () => {
  const calls = LOGOUT_SOURCE.match(/resetHomeDiscoverAfterLogout\(/g) || [];
  // doLogout + qq / kugou / qishui / spotify 四个分支 + 全部退出
  assert.ok(calls.length >= 6, '退出路径漏了重置：只有 ' + calls.length + ' 处调用');
});

test('旧版「只清 homeDiscoverState」的写法不许回潮', () => {
  // 曾经在 resetAllProviderRendererLoginState 里手写四行清空，漏了 feed 与指纹，
  // 于是退出后卡片还是上个账号的内容。统一走重置函数。
  assert.doesNotMatch(LOGOUT_SOURCE, /homeDiscoverState\.songs = \[\]/);
  assert.doesNotMatch(LOGOUT_SOURCE, /homeDiscoverState\.mode = 'starter'/);
});
