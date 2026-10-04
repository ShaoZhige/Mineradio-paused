'use strict';

// 自定义音源与 Mineradio 现有播放链路的接线不变量。
// 最重要的一条：禁用自定义音源时，网易云/QQ/酷狗/汽水的解析路径必须与改动前完全一致——
// 不竞速、不抢先、不发多余请求。
// Wiring invariants between custom sources and the existing playback chain. The important
// one: with no custom source enabled, the NetEase/QQ/Kugou/Qishui resolution path has to
// stay exactly as it was — no racing, no takeover, no extra request.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PLAYBACK = path.join(ROOT, 'public/js/modules/05-playback');
const CUSTOM_MODULE = path.join(PLAYBACK, '20-custom-source.js');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// 结构断言必须看「真代码」，注释掉的痕迹不算数。
// Structural assertions have to read real code; a commented-out trace does not count.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 在最小上下文里单独加载该模块：只喂它真正会碰到的全局。
// Loads only this module in a minimal context, stubbing just the globals it touches.
function loadModule(overrides = {}) {
  const context = {
    window: {},
    document: {
      getElementById: () => null,
      createElement: () => ({ appendChild() {}, addEventListener() {}, style: {} }),
      createTextNode: () => ({}),
    },
    console: { warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    apiJson: async () => null,
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(read(CUSTOM_MODULE), context);
  return context;
}

test('index-loader registers the module and startup binds it', () => {
  const loader = read(path.join(ROOT, 'public/js/index-loader.js'));
  assert.ok(loader.includes("'js/modules/05-playback/20-custom-source.js'"), '模块未注册到 index-loader');
  // 必须在 shell 启动段之前：启动绑定会立刻调用 bindCustomSourceManager()。
  assert.ok(
    loader.indexOf('20-custom-source.js') < loader.indexOf('10-shell/05-startup-bindings.js'),
    '自定义音源模块必须排在启动绑定之前',
  );
  const startup = read(path.join(ROOT, 'public/js/modules/10-shell/05-startup-bindings.js'));
  assert.ok(startup.includes('bindCustomSourceManager();'), '启动时没有绑定自定义音源');
});

test('the titlebar entry and the settings dialog exist and are i18n-marked', () => {
  const html = read(path.join(ROOT, 'public/index.html'));
  assert.ok(html.includes('id="custom-source-btn"'), '缺少标题栏入口');
  assert.ok(html.includes('id="custom-source-modal"'), '缺少音源设置面板');
  assert.ok(html.includes('id="custom-source-list"'), '缺少脚本列表容器');
  assert.ok(html.includes('onclick="openCustomSourceModal()"'), '入口没有绑定打开动作');
  assert.ok(html.includes('data-i18n="custom_source_warning"'), '风险提示没有接入 i18n');
  const css = read(path.join(ROOT, 'public/css/index.css'));
  assert.ok(css.includes('.custom-source-dialog'), '缺少音源面板样式');
  assert.ok(css.includes('#custom-source-modal'), '缺少音源遮罩样式');
});

test('the disabled path never issues a request', async () => {
  let calls = 0;
  const context = loadModule({ apiJson: async () => { calls += 1; return { active: false, handled: false }; } });
  // 清单已加载且为空 = 确认没有启用任何脚本。
  context.customSourceState.loaded = true;
  context.customSourceState.items = [];

  const result = await context.resolveCustomSourcePlaybackData({ provider: 'netease', id: 1 }, 'hires');

  assert.equal(result, null);
  assert.equal(calls, 0, '确认没有启用脚本时不应发出任何请求');
});

test('a hand-back from the script keeps the built-in path in charge', async () => {
  const context = loadModule({
    apiJson: async () => ({ active: true, handled: false, reason: 'source_unsupported', lxSource: 'tx' }),
  });
  context.customSourceState.loaded = true;
  context.customSourceState.items = [{ id: 'a', active: true }];

  // handled=false 表示脚本对这个平台没有主张，必须交回内置解析而不是判定失败。
  assert.equal(await context.resolveCustomSourcePlaybackData({ provider: 'kugou', hash: 'h' }, 'hires'), null);
});

test('a claimed track with a URL is returned, a claimed track without one is surfaced', async () => {
  const withUrl = loadModule({
    apiJson: async () => ({ active: true, handled: true, url: 'https://audio/x.mp3', level: 'lossless' }),
  });
  withUrl.customSourceState.items = [{ id: 'a', active: true }];
  const resolved = await withUrl.resolveCustomSourcePlaybackData({ provider: 'netease', id: 1 }, 'hires');
  assert.equal(resolved.url, 'https://audio/x.mp3');
  assert.equal(resolved.level, 'lossless');

  const withoutUrl = loadModule({
    apiJson: async () => ({ active: true, handled: true, url: '', reason: 'request_failed', error: 'boom' }),
  });
  withoutUrl.customSourceState.items = [{ id: 'a', active: true }];
  const failed = await withoutUrl.resolveCustomSourcePlaybackData({ provider: 'netease', id: 1 }, 'hires');
  // 脚本声称接管却没给地址：这一首确实解析不了，必须把失败交给调用方去走换源。
  assert.equal(failed.url, '');
  assert.equal(failed.reason, 'request_failed');
});

test('local and podcast tracks are never sent to a script', async () => {
  let calls = 0;
  const context = loadModule({ apiJson: async () => { calls += 1; return null; } });
  context.customSourceState.items = [{ id: 'a', active: true }];

  assert.equal(await context.resolveCustomSourcePlaybackData({ type: 'local', localUrl: 'file:///a.mp3' }, 'hires'), null);
  assert.equal(await context.resolveCustomSourcePlaybackData({ type: 'podcast', id: 3 }, 'hires'), null);
  assert.equal(await context.resolveCustomSourcePlaybackData(null, 'hires'), null);
  assert.equal(calls, 0);
});

test('a resolve failure never throws into the playback chain', async () => {
  const context = loadModule({ apiJson: async () => { throw new Error('network down'); } });
  context.customSourceState.items = [{ id: 'a', active: true }];

  assert.equal(await context.resolveCustomSourcePlaybackData({ provider: 'netease', id: 1 }, 'hires'), null);
});

test('failure codes are mapped to localized copy, not raw codes', () => {
  const context = loadModule();
  assert.match(context.customSourceFailureText(new Error('INIT_TIMEOUT: Script did not initialize')), /10/);
  assert.match(context.customSourceFailureText(new Error('INIT_FAILED: Missing init info')), /初始化失败/);
  assert.match(context.customSourceFailureText(new Error('IMPORT_INVALID: duplicate script')), /已经导入过/);
  assert.match(context.customSourceFailureText(new Error('IMPORT_INVALID: 无效的自定义源文件')), /格式无效/);
  assert.ok(!/^[A-Z_]{3,}/.test(context.customSourceFailureText(new Error('CUSTOM_SOURCE_UNAVAILABLE'))), '不应把原始错误码直接给用户');
});

test('playQueueAt only consults the custom source when nothing was pre-resolved', () => {
  const source = read(path.join(PLAYBACK, '13-playback-start-audio.js'));
  // 内置分发必须整体退到 `if (!data)` 里，否则自定义源与内置接口会同时发出请求。
  assert.ok(
    /if \(!data\) \{\s*\n\s*if \(isQQPlayback\)/.test(source),
    '内置平台分发没有退到 if (!data) 之内，自定义源会与内置接口竞速',
  );
  assert.ok(source.includes('data = await resolveCustomSourcePlaybackData(song, requestedQuality);'), 'playQueueAt 未接入自定义源');
  assert.ok(
    source.includes('var customSourcePlayback = !!(data && data.active === true);'),
    '缺少自定义源结果标记',
  );
  // 预加载 / 自动换源候选解析也走同一策略，否则无缝衔接会绕开脚本。
  const gapless = source.indexOf('async function resolveAlbumGaplessPlaybackData(song) {');
  const gaplessBody = source.slice(gapless, gapless + 2000);
  assert.ok(gaplessBody.includes('resolveCustomSourcePlaybackData'), '预加载解析没有接入自定义源');
});

test('a script never shrinks the platform quality ceiling or fakes a platform downgrade', () => {
  const source = read(path.join(PLAYBACK, '13-playback-start-audio.js'));
  assert.ok(
    source.includes("if (qualityDowngraded && !customSourcePlayback) markPlaybackQualityRuntimeCap("),
    '自定义源的音质不应写进平台运行时上限',
  );
  assert.ok(
    source.includes('qualityDowngraded && !customSourcePlayback) {'),
    '自定义源的低音质不应被说成平台降级',
  );
  assert.ok(
    source.includes('if (isQQPlayback && !customSourcePlayback) {'),
    '自定义源生效时不应回退到内置 QQ 复合音质重试',
  );
});

test('a custom source failure is explained as such instead of as a membership problem', () => {
  const source = read(path.join(PLAYBACK, '11-provider-fallback.js'));
  const activeBranch = source.indexOf('if (data.active === true) {');
  const vipsBranch = source.indexOf("if (category === 'vip_required' || category === 'paid_required'");
  assert.ok(activeBranch > 0, '缺少自定义源失败分支');
  // 必须早于会员/登录分支：脚本超时不能被解释成「你需要会员」。
  assert.ok(activeBranch < vipsBranch, '自定义源分支必须排在会员/登录分支之前');
  assert.ok(source.includes("category: 'custom_source_unavailable'"), '缺少自定义源失败类别');
});

test('the renderer bridge and the main-process channels line up', () => {
  const preload = read(path.join(ROOT, 'desktop/preload.js'));
  const main = read(path.join(ROOT, 'desktop/main.js'));
  const channels = [
    'mineradio-custom-source-list',
    'mineradio-custom-source-import',
    'mineradio-custom-source-replace',
    'mineradio-custom-source-activate',
    'mineradio-custom-source-deactivate',
    'mineradio-custom-source-remove',
    'mineradio-custom-source-set-update-alert',
  ];
  for (const channel of channels) {
    assert.ok(preload.includes(`'${channel}'`), `preload 未转发 ${channel}`);
    assert.ok(main.includes(`'${channel}'`), `主进程未注册 ${channel}`);
  }
  assert.ok(preload.includes("'mineradio-custom-source-status'"), 'preload 未订阅状态推送');
  assert.ok(main.includes("'mineradio-custom-source-status'"), '主进程未推送状态');
  // 只有主窗口可以操作音源，脚本宿主窗口自己不行。
  assert.ok(main.includes('CUSTOM_SOURCE_UNAUTHORIZED'), '缺少发送方校验');
});

test('the manager is restored on startup and released on quit', () => {
  const main = read(path.join(ROOT, 'desktop/main.js'));
  assert.ok(main.includes('await initializeCustomSourceManager();'), '启动时没有恢复音源');
  assert.ok(main.includes('localServer.setCustomSourceResolver('), '没有注入本地解析器');
  assert.ok(main.includes('manager.dispose();'), '退出时没有释放脚本宿主');
  assert.ok(main.includes('setCustomSourceResolver(null)'), '退出时没有摘掉解析器');
  // 音源初始化失败不能拦住启动。
  assert.ok(main.includes("[CustomSource] initialization skipped"), '音源初始化失败没有降级处理');
});

test('every local-server start is followed by a resolver re-injection', () => {
  // 去注释后再扫：否则把注入注释掉，子串匹配照样会通过。
  // Scan comment-stripped source; otherwise a commented-out injection still matches.
  const main = stripComments(read(path.join(ROOT, 'desktop/main.js')));
  // ensureLocalServerStarted() 会重新 require server.js（全新模块实例），resolver
  // 必须跟着重新注入，否则主界面崩溃恢复后自定义音源会静默失效。
  // ensureLocalServerStarted() re-requires server.js, yielding a fresh module instance,
  // so the resolver must be re-injected or custom sources go silently dead after a
  // renderer recovery.
  const callSite = /await ensureLocalServerStarted\(\);\n([\s\S]{0,600}?)await loadMainWindowWithRetry\(win\);/g;
  const gaps = [];
  let match;
  while ((match = callSite.exec(main)) !== null) gaps.push(match[1]);
  assert.ok(gaps.length >= 2, '没有覆盖「首次启动」与「崩溃恢复」两条路径');
  for (const gap of gaps) {
    assert.ok(gap.includes('await initializeCustomSourceManager();'), '服务器启动之后没有重新注入自定义音源解析器');
  }
});
