'use strict';
const { readAllCss } = require('./helpers/css-source');

// 播客面板的平台切换器要跟歌单一致：同一套胶囊行、列出所有已登录平台、一次只渲染一个。
// 区别在于播客接口目前只有网易云提供，其余平台必须明说「暂无可用播客接口」，
// 否则空面板看起来就像加载失败。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const DETAIL = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'),
  'utf8'
);
const LOCALES = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];

test('播客面板里有和歌单同款的切换器宿主', () => {
  const paneStart = INDEX.indexOf('<div id="podcast-pane"');
  assert.ok(paneStart > 0, '找不到 #podcast-pane');
  const paneEnd = INDEX.indexOf('<div id="playlist-multiselect-bar"', paneStart);
  const pane = INDEX.slice(paneStart, paneEnd);
  assert.match(pane, /<div id="podcast-provider-tabs" class="pl-provider-tabs" style="display:none"><\/div>/);
  assert.ok(
    pane.indexOf('podcast-provider-tabs') < pane.indexOf('podcast-list'),
    '切换器要排在列表上方'
  );
  assert.doesNotMatch(pane, /queue-toolbar/, '工具条已移到滚动区上方，不该再留在 pane 里');
  const toolsAt = INDEX.indexOf('<div id="playlist-panel-tools">');
  const bodyAt = INDEX.indexOf('<div id="playlist-panel-body">');
  assert.ok(toolsAt > 0, '找不到 #playlist-panel-tools');
  assert.ok(toolsAt < bodyAt, '工具条要排在列表滚动区之前，列表才能从它下面裁断');
});

test('切换器复用歌单的类名与交互', () => {
  assert.match(DETAIL, /function renderPodcastProviderTabs\(\)/);
  assert.match(DETAIL, /class="pl-provider-tab' \+ \(isActive \? ' active' : ''\)/);
  assert.match(DETAIL, /getAttribute\('data-podcast-provider'\)/);
  assert.match(DETAIL, /host\.style\.display = 'none'/, '没有平台登录时整行收起');
  assert.match(DETAIL, /localStorage\.setItem\(PODCAST_ACTIVE_PROVIDER_KEY, key\)/, '选中项要持久化');
});

// 播客直接沿用歌单的胶囊几何，没有自己的一套尺寸；差别只在「有平台就有这一行」——
// 这一行同时是当前平台归属的唯一标识，收掉之后就无从判断列表属于哪个平台了。
test('播客沿用歌单的胶囊尺寸', () => {
  const CSS = readAllCss();
  assert.match(CSS, /\.pl-provider-tab \{\s*flex: 1 1 0;/, '胶囊等分整行，与歌单同一条规则');
  assert.doesNotMatch(CSS, /pl-provider-tabs-solo/, '不要为播客另起一套容器级尺寸');
  assert.doesNotMatch(DETAIL, /pl-provider-tabs-solo/);
  assert.match(
    DETAIL,
    /function renderPodcastProviderTabs\(\) \{[\s\S]{0,900}?if \(!available\.length\) \{/,
    '有一个平台登录就要留着这一行'
  );
  assert.match(
    CSS,
    /#podcast-provider-tabs \.pl-provider-tab:only-child \{\s*flex: 0 0 auto;/,
    '单颗按按钮长度收，不撑满整行'
  );
  assert.match(
    DETAIL,
    /function renderPlaylistProviderTabs\(cache\) \{[\s\S]{0,1200}?if \(available\.length < 2\) \{/,
    '歌单那边仍按数量收起，两条路径不能混'
  );
});

test('平台清单从注册表派生，不写死数组', () => {
  assert.match(
    DETAIL,
    /function podcastPanelAvailableProviders\(\) \{\s*return providerRegistryKeysWith\('login'\)/,
    '新增平台只改注册表就该出现在播客切换器里'
  );
  assert.doesNotMatch(
    DETAIL,
    /PODCAST_PROVIDER_ORDER/,
    '写死的平台数组会被 quick-check 的注册表守卫拦下'
  );
  assert.match(DETAIL, /playlistCatalogProviderLoggedIn\(key\)/, '未登录的平台不给按钮');
  assert.match(
    DETAIL,
    /available\.indexOf\('netease'\) >= 0 \? 'netease' : available\[0\]/,
    '有网易云时默认落在网易云，那是唯一有内容的平台'
  );
});

test('没有播客接口的平台给出占位而不是空列表', () => {
  assert.match(DETAIL, /var PODCAST_PROVIDER_SUPPORTED = \{ netease: true \};/);
  assert.match(DETAIL, /function podcastPanelProviderSupported\(provider\)/);
  assert.match(DETAIL, /if \(!podcastPanelProviderSupported\(activeProvider\)\) \{/);
  assert.match(DETAIL, /pl_podcast_provider_unsupported_html/);
  assert.match(DETAIL, /\{ provider: escHtml\(playlistProviderName\(activeProvider\)\) \}/);
});

test('占位文案四个语言包都有', () => {
  for (const locale of LOCALES) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', `${locale}.json`), 'utf8'));
    assert.match(dict.pl_podcast_provider_unsupported_html || '', /\{provider\}/, `${locale} 缺少播客占位文案`);
    assert.ok(dict.pod_provider_unsupported_title, `${locale} 缺少按钮提示文案`);
    // 提示文案会拼进按钮的 title，不能带 HTML。
    assert.doesNotMatch(dict.pod_provider_unsupported_title, /</, `${locale} 的提示文案不应含 HTML`);
  }
});
