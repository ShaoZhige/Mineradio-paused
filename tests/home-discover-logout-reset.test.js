// 退出登录后首页必须回到起始入口：重置函数清得够干净、每条退出路径都调它、
// 清空逻辑只允许集中在这个函数里。

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

  assert.match(body, /homeDiscoverState\.songs = \[\]/);
  assert.match(body, /homeDiscoverState\.playlists = \[\]/);
  assert.match(body, /homeDiscoverState\.podcasts = \[\]/);
  assert.match(body, /homePlatformRecommendationState\.feeds/);
  assert.match(body, /feed\.loaded = false/);
  // 指纹不清就会被判成「内容没变」而跳过重绘。
  assert.match(body, /homeDashboardDiscoveryCache = \[\]/);
  assert.match(body, /homeDashboardDiscoveryFingerprint = ''/);
  // 在途请求的 token 要作废，否则旧数据会写回刚清空的状态。
  assert.match(body, /homeDiscoverToken \+= 1/);
  assert.match(body, /renderHomeDiscover\(\)/);
});

test('loaded 标记按「是否还有平台登录」决定，不留半拉状态', () => {
  const body = functionSource(DISCOVER_SOURCE, 'resetHomeDiscoverAfterLogout');
  // 全部退出是终态，loaded = true 挡掉别处再触发一次无意义加载。
  assert.match(body, /homeDiscoverState\.loaded = true/);
  // 还有平台登录时作废缓存，让首页按剩下的账号重拉。
  assert.match(body, /homeDiscoverState\.loaded = false/);
  assert.match(body, /hasAnyPlatformLogin/);
});

test('每一条退出路径都调用重置函数', () => {
  const calls = LOGOUT_SOURCE.match(/resetHomeDiscoverAfterLogout\(/g) || [];
  // doLogout + qq / kugou / qishui / spotify 四个分支 + 全部退出。
  assert.ok(calls.length >= 6, '退出路径漏了重置：只有 ' + calls.length + ' 处调用');
});

test('旧版「只清 homeDiscoverState」的写法不许回潮', () => {
  // 散在退出分支里的手写清空会漏掉 feed 与指纹，清空逻辑只允许留在重置函数里。
  assert.doesNotMatch(LOGOUT_SOURCE, /homeDiscoverState\.songs = \[\]/);
  assert.doesNotMatch(LOGOUT_SOURCE, /homeDiscoverState\.mode = 'starter'/);
});
