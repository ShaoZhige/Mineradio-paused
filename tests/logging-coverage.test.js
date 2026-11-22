'use strict';

// 日志覆盖守卫：这些失败分支都是"用户报障时唯一能查的东西"，不能被顺手删掉。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('播放失败总入口留痕（覆盖所有平台）', () => {
  const src = read('public/js/modules/05-playback/11-provider-fallback.js');
  const at = src.indexOf('function handlePlaybackUnavailable(');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.match(body, /logEvent\('playback', 'start-failed'/);
  assert.match(body, /provider:/, '必须记平台');
  assert.match(body, /songId:/, '必须记歌 id（便于对照用户报的那首）');
});

test('队列续页失败留痕', () => {
  const src = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');
  assert.match(src, /logEvent\('queue', 'page-failed'/);
});

test('歌词"没歌词"能区分上游没有与解析失败', () => {
  const src = read('public/js/modules/06-lyrics/00-lyrics-fetch-parse.js');
  assert.match(src, /logEvent\('lyric', 'unavailable'/);
  assert.match(src, /'parse-empty' : 'no-lyric-upstream'/);
  assert.match(src, /logEvent\('lyric', 'fetch-failed'/);
});

test('五个平台的登录态只在变化时落一行', () => {
  const src = read('public/js/modules/08-account/02-login-status.js');
  assert.match(src, /function noteAccountStatus\(provider, status\)/);
  assert.match(src, /if \(accountStatusLog\[provider\] === key\) return;/, '轮询不能刷屏');
  for (const provider of ['netease', 'qq', 'kugou', 'qishui', 'spotify']) {
    assert.ok(src.includes(`noteAccountStatus('${provider}'`), `缺少 ${provider} 的登录态日志`);
  }
});

test('自定义音源失败留痕（渲染端 + 主进程）', () => {
  const src = read('public/js/modules/05-playback/20-custom-source.js');
  assert.match(src, /logEvent\('source', 'list-failed'/);
  assert.match(src, /logEvent\('source', 'resolve-failed'/);
  assert.match(read('desktop/main.js'), /source\.init-skipped/);
});

test('全屏/最大化切换留痕，且只在变化时', () => {
  const src = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
  assert.match(src, /logEvent\('window', 'state', \{ fullscreen: isFullScreen, maximized: isMaximized/);
  assert.match(src, /isMaximized !== wasMaximized \|\| isFullScreen !== wasFullScreen/,
    '重复上报已被 lastKey 挡掉，这里只该记真实切换');
});

test('脱敏：新增日志点不许写入 token / cookie / 完整 URL', () => {
  const files = [
    'public/js/modules/05-playback/11-provider-fallback.js',
    'public/js/modules/06-lyrics/03-podcast-playlist-loaders.js',
    'public/js/modules/06-lyrics/00-lyrics-fetch-parse.js',
    'public/js/modules/08-account/02-login-status.js',
    'public/js/modules/05-playback/20-custom-source.js',
  ];
  for (const file of files) {
    const src = read(file);
    const logCalls = src.match(/logEvent\([\s\S]{0,400}?\);/g) || [];
    for (const call of logCalls) {
      assert.ok(!/cookie|token|password|localUrl|https?:\/\//i.test(call),
        `${file} 的日志里出现了敏感字段：${call.slice(0, 120)}`);
    }
  }
});
