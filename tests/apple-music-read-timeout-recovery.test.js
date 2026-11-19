'use strict';

// 用户正在 Apple Music 窗口里填 Apple ID 时，后台的 accountStatus 超时会把整个文档换掉 ——
// 表单连同已填内容一起消失，看起来就是"登录到一半跳回首页"。只读超时要忍三次才恢复文档；
// 播放类命令仍按一次超时处理（它可能稍后出声）。
// A read timeout must not reload the page the user is typing into; playback commands keep the
// single-strike recovery because a start may still sound later.

const test = require('node:test');
const assert = require('node:assert');
const { createRequestDispatcher } = require('../desktop/apple-music/companionRequests.cjs');

const TIMEOUT_MS = 20;
const SETTLE_MS = 60;

// 页面命令比超时慢，但最终仍会返回：永不落地的 run() 会一直占着并发位，后面的请求全变成 busy。
// The page command is slower than the timeout yet still settles; a run that never settles holds the
// concurrency slot and turns every later request into 'busy'.
function slowContents() {
  return {
    isDestroyed: () => false,
    getURL: () => 'https://music.apple.com/cn/new',
    executeJavaScript: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, data: {} }), SETTLE_MS)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 20));

test('只读请求连续超时三次才换文档', async () => {
  const contents = slowContents();
  let recoveries = 0;
  const dispatch = createRequestDispatcher(() => contents, TIMEOUT_MS, () => 1, async () => { recoveries += 1; return true; });
  const read = { operation: 'accountStatus', params: {} };

  const first = await dispatch({ ...read, id: 'a1' });
  assert.strictEqual(first.error, 'timeout');
  await settle();
  assert.strictEqual(recoveries, 0, '第一次超时不该换文档');

  const second = await dispatch({ ...read, id: 'a2' });
  assert.strictEqual(second.error, 'timeout');
  await settle();
  assert.strictEqual(recoveries, 0, '第二次超时仍不该换文档');

  const third = await dispatch({ ...read, id: 'a3' });
  assert.strictEqual(third.error, 'timeout');
  await settle();
  assert.strictEqual(recoveries, 1, '第三次说明页面真的卡死，才恢复文档');
});

test('换文档之后不再接新请求', async () => {
  const contents = slowContents();
  const dispatch = createRequestDispatcher(() => contents, TIMEOUT_MS, () => 1, async () => true);
  const read = { operation: 'accountStatus', params: {} };
  await dispatch({ ...read, id: 'b1' });
  await settle();
  await dispatch({ ...read, id: 'b2' });
  await settle();
  await dispatch({ ...read, id: 'b3' });
  await settle();
  const after = await dispatch({ ...read, id: 'b4' });
  assert.strictEqual(after.error, 'not-ready', '恢复中的文档不能再执行页面命令');
});

test('播放命令一次超时就恢复文档', async () => {
  const contents = slowContents();
  let recoveries = 0;
  const dispatch = createRequestDispatcher(() => contents, TIMEOUT_MS, () => 1, async () => { recoveries += 1; return true; });
  const result = await dispatch({ id: 'c1', operation: 'pause', params: {} });
  assert.strictEqual(result.error, 'timeout');
  await settle();
  assert.strictEqual(recoveries, 1, '播放超时仍要立刻恢复：它可能稍后出声');
});

test('一次成功读把连续超时计数清零', async () => {
  let slow = true;
  const contents = {
    isDestroyed: () => false,
    getURL: () => 'https://music.apple.com/cn/new',
    executeJavaScript: () => (slow
      ? new Promise((resolve) => setTimeout(() => resolve({ ok: true, data: {} }), SETTLE_MS))
      : Promise.resolve({ ok: true, data: {} })),
  };
  let recoveries = 0;
  const dispatch = createRequestDispatcher(() => contents, TIMEOUT_MS, () => 1, async () => { recoveries += 1; return true; });
  const read = { operation: 'accountStatus', params: {} };

  await dispatch({ ...read, id: 'd1' });
  await settle();
  await dispatch({ ...read, id: 'd2' });
  await settle();
  slow = false;
  await dispatch({ ...read, id: 'd3' });
  slow = true;
  await dispatch({ ...read, id: 'd4' });
  await settle();
  await dispatch({ ...read, id: 'd5' });
  await settle();
  assert.strictEqual(recoveries, 0, '成功读把连续超时计数清零，不该累计到三次');
});

test('登录窗口可见时再怎么超时也不换文档', async () => {
  const contents = slowContents();
  let recoveries = 0;
  let visible = true;
  const dispatch = createRequestDispatcher(
    () => contents, TIMEOUT_MS, () => 1,
    async () => { recoveries += 1; return true; },
    () => !visible,
  );
  const read = { operation: 'accountStatus', params: {} };

  for (const id of ['e1', 'e2', 'e3', 'e4']) {
    const result = await dispatch({ ...read, id });
    assert.strictEqual(result.error, 'timeout', '超时本身仍要如实返回');
    await settle();
  }
  assert.strictEqual(recoveries, 0, '用户正对着这个窗口填 Apple ID，不能重载文档');

  // 窗口收起之后恢复原策略：卡死的页面还是要救。
  visible = false;
  await dispatch({ ...read, id: 'e5' });
  await settle();
  assert.strictEqual(recoveries, 1, '窗口收起后连续超时恢复文档');
});
