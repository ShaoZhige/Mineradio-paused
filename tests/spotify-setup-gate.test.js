'use strict';

// Spotify 接入向导的步骤门禁守卫。
//
// 这里钉的是一次真实故障：向导把「回调检测」当成了「授权登录」的前置条件，
// 而回调检测只有用户手动点一次才会变成已完成。结果是配置明明就绪，
// 第三步卡片却被加上 .is-locked（opacity 0.52），按钮看起来是灰的、点不动 ——
// 用户的原话是「没有开始登陆啊」。
//
// 同一处还有第二个坑：启动期的 /api/spotify/status 失败过一次后不会立刻重试
// （定时器 45 秒），那段时间里四步全停在「第一步 进行中」，授权按钮 disabled。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FLOWS = fs.readFileSync(path.join(ROOT, 'public/js/modules/08-account/03-login-modal-flows.js'), 'utf8');

function functionBody(name) {
  const start = FLOWS.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  const open = FLOWS.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < FLOWS.length; i += 1) {
    if (FLOWS[i] === '{') depth += 1;
    else if (FLOWS[i] === '}') {
      depth -= 1;
      if (depth === 0) return FLOWS.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

test('回调检测不再挡在授权登录前面', () => {
  const body = functionBody('spotifySetupCurrentStep');
  assert.ok(
    !/spotifySetupCallbackReady/.test(body),
    'step 3 must not require a manual callback probe; that locks the authorize card'
  );
  // 配置就绪 + 未登录时，当前步骤必须是 3（授权登录），不能退回到 2。
  assert.match(body, /if \(!loggedIn\) return 3;/);
});

test('第二步的完成态由服务端回调校验兜底，不必等用户手动点', () => {
  const panel = functionBody('renderSpotifySetupWizard');
  assert.match(panel, /2:\s*spotifySetupCallbackStepDone\(\)/);
  const done = functionBody('spotifySetupCallbackStepDone');
  assert.match(done, /spotifySetupCallbackReady/, 'a real probe still counts');
  assert.match(done, /redirectValid/, 'server-side redirect validation must count too');
});

test('打开 Spotify 面板时补一次状态查询，避免停在第一步', () => {
  const ensure = functionBody('ensureSpotifyStatusFresh');
  assert.match(ensure, /refreshSpotifyLoginStatus\(\)/);
  assert.match(ensure, /oauthConfigured/, 'skip the round-trip when status is already good');
  for (const caller of ['setLoginProvider', 'resumeLoginModalAfterGate', 'connectLoginMode']) {
    assert.match(functionBody(caller), /ensureSpotifyStatusFresh/, caller + ' must refresh a stale status');
  }
});

test('进入面板不自动拉浏览器，授权只能由第三步的按钮发起', () => {
  // 自动打开会抢在用户看清步骤之前把人甩到浏览器里，用户要求去掉。
  // Opening the browser on panel entry flings people out of the app before they can read
  // the steps; the user asked for that to be removed.
  const body = functionBody('connectLoginMode');
  assert.ok(
    !/openSpotifyWebLogin/.test(body),
    'connectLoginMode must not start the OAuth flow on its own'
  );
  assert.match(body, /ensureSpotifyStatusFresh/);
});
