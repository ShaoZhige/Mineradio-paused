// 两处「接口兜底写法」的回归守卫：天气定位必须走 HTTPS，VIP 归一化不能被空对象壳子挡住。
// Guards for two payload-handling traps: the geolocation endpoint has to be HTTPS, and the VIP
// normalisers must not be shadowed by an empty object shell.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

function sliceBetween(startNeedle, endNeedle) {
  const start = SERVER.indexOf(startNeedle);
  assert.ok(start > 0, `${startNeedle} must exist`);
  const end = SERVER.indexOf(endNeedle, start);
  return SERVER.slice(start, end > 0 ? end : undefined);
}

test('天气定位只走 HTTPS，不再把出口 IP 明文发出去', () => {
  const decl = sliceBetween('const WEATHER_IP_LOCATION_URL', '\n');
  assert.ok(/https:\/\//.test(decl), `the endpoint must be https, got ${decl.trim()}`);
  assert.ok(!/http:\/\//.test(decl), 'plain http is what this test exists to prevent');
  const body = sliceBetween('async function fetchIpWeatherLocation', 'function weatherRadioSeedQueries');
  // ipwho.is 的字段是 latitude / longitude / timezone.id，照抄 ip-api 的 lat / lon / timezone 会静默
  // 拿到 undefined 然后一路回落到默认城市。
  // ipwho.is spells them latitude / longitude / timezone.id; the ip-api names would read undefined
  // and silently fall back to the default city.
  assert.ok(/body\.latitude/.test(body), 'must read ipwho.is latitude');
  assert.ok(/body\.longitude/.test(body), 'must read ipwho.is longitude');
  assert.ok(!/body\.lat\b/.test(body), 'the ip-api field name must be gone');
  assert.ok(!/body\.lon\b/.test(body), 'the ip-api field name must be gone');
  assert.ok(/body\.success === false/.test(body), 'ipwho.is reports failure via success:false');
  assert.ok(/body\.timezone && body\.timezone\.id/.test(body), 'timezone is an object, not a string');
});

test('空的 vipInfo 壳子不能挡住真正有内容的账号对象', () => {
  // `a || b || c || {}` 里空对象是 truthy，会整段盖掉后面带内容的那个。
  // An empty object is truthy, so it shadows the object that actually carries the payload.
  const helper = sliceBetween('function firstPopulatedObject', 'function normalizeNeteaseVip');
  assert.ok(/Object\.keys\(item\)\.length > 0/.test(helper), 'the helper must test for content, not existence');
  const calls = SERVER.match(/const vipInfo = firstPopulatedObject\(\[/g) || [];
  assert.ok(calls.length >= 2, `both normalisers must use it, found ${calls.length}`);
  assert.ok(!/profile\.vipInfo \|\| profile\.vipinfo/.test(SERVER), 'the shadowing chain must not come back');
  assert.ok(!/data\.vipInfo \|\| data\.vipinfo \|\| data\.vip/.test(SERVER), 'the shadowing chain must not come back');
  // 只换嵌套 vipInfo 的取法；account / profile 本体早就进了 objects 数组，别顺手把那段也改了。
  // Only the nested vipInfo lookup changes; account/profile are already in `objects`.
  assert.ok(/const objects = \[account, profile, vipInfo, extra, vipData\]/.test(SERVER));
});
