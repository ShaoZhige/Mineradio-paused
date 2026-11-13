'use strict';

// 「当前队列 / 我的歌单 / 迷你队列」搜索框的回归守卫。
//
// 队列有两处入口（左栏页签与底部迷你队列），看的是同一个 playQueue，所以必须共用
// 一个过滤词；过滤只改「显示」，行上的 data-queue-index 仍要是真实下标，否则搜索
// 状态下点第 2 行会播到队列里完全另一首歌。歌单这边只收窄卡片名单，平台切换器不能
// 跟着消失。这些都不会抛错，只会「点了不对」，所以判据钉在源码接线与沙箱行为上。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = read('public/index.html');
const SHELL = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
const DETAIL = read('public/js/modules/06-lyrics/02-playlist-detail.js');
const CSS = read('public/css/playlist.css');
const LOCALES = ['zh_cn', 'zh_hk', 'zh_tw', 'en_us', 'ja_jp', 'es_es', 'ru_ru'];

test('三处输入框都接在同一个入口上，占位文案走 i18n', () => {
  assert.match(HTML, /id="queue-search-input"[\s\S]{0,240}oninput="setQueueSearch\(this\.value, this\)"/);
  assert.match(HTML, /id="mini-queue-search-input"[\s\S]{0,240}oninput="setQueueSearch\(this\.value, this\)"/);
  assert.match(HTML, /id="pl-search-input"[\s\S]{0,240}oninput="setPlaylistSearch\(this\.value, this\)"/);
  assert.match(HTML, /id="queue-search-input"[\s\S]{0,360}data-i18n-placeholder="pl_search_queue"/);
  assert.match(HTML, /id="pl-search-input"[\s\S]{0,360}data-i18n-placeholder="pl_search_playlists"/);
  // 左栏与迷你弹层是两个框、一个状态，靠这个属性互相同步。
  assert.equal((HTML.match(/data-queue-search="1"/g) || []).length, 2);
});

test('搜索行跟着页签显隐，不会留在别的页签上', () => {
  assert.match(SHELL, /var queueSearchRow = document\.getElementById\('queue-search'\)/);
  assert.match(SHELL, /queueSearchRow\.style\.display = tab === 'queue'/);
  assert.match(SHELL, /var plSearchRow = document\.getElementById\('pl-search'\)/);
  assert.match(SHELL, /plSearchRow\.style\.display = tab === 'playlists'/);
});

test('队列过滤只改显示，行上挂的仍是 playQueue 的真实下标', () => {
  // 播放 / 删除 / 拖动排序 / 收藏全都拿这个下标回去索引 playQueue。
  assert.match(SHELL, /var i = indexMap \? indexMap\[windowInfo\.start \+ localIndex\] : windowInfo\.start \+ localIndex;/);
  assert.match(SHELL, /data-queue-index="' \+ i \+ '"/);
  assert.match(SHELL, /onclick="if\(window\.__mineradioSuppressReorderClick\)return;playQueueAt\(' \+ i \+ '\)"/);
  // 虚拟窗口按过滤后的条数算，否则原队列长度会把占位符撑出一片空白。
  assert.match(SHELL, /queuePanelVirtualWindow\(\$ql, panelScroller, total, false, scrollIndex\)/);
  // 搜索态不再提示「还有多少首未载入」。
  assert.match(SHELL, /indexMap \? '' : queueHydrationFooterHtml\(false\)/);
});

test('迷你队列与左栏共用同一个过滤词', () => {
  assert.match(SHELL, /function syncQueueSearchInputs\(sourceEl, rawValue\)/);
  assert.match(SHELL, /document\.querySelectorAll\('\[data-queue-search\]'\)/);
  assert.match(SHELL, /queueSearchQuery = next;[\s\S]{0,400}renderQueuePanel\(\{ animate: false, scrollCurrent: false \}\);/);
  assert.match(SHELL, /queueSearchQuery = next;[\s\S]{0,400}renderMiniQueuePanel\(\{ animate: false, scrollCurrent: false \}\);/);
});

test('歌单过滤只收窄卡片名单，不动平台切换器', () => {
  assert.match(DETAIL, /items = items\.filter\(function \(entry\) \{/);
  assert.match(DETAIL, /panelSearchHit\(entry && entry\.pl && entry\.pl\.name, playlistSearchQuery\)/);
  // 过滤词必须进缓存 key：少了这一条，改词后拿回来的还是上一次的 entries，
  // 表现就是「输入框在动、列表不动」。
  assert.match(DETAIL, /playlistPanelVirtualCache\.searchQuery === playlistSearchQuery/);
  assert.match(DETAIL, /searchQuery: playlistSearchQuery,/);
  // 搜索期间不再「滚到末尾就拉下一页」：那会把所有平台的歌单拉完，只为给过滤结果凑数。
  assert.match(DETAIL, /if \(!playlistSearchQuery && typeof requestNextPlaylistCatalogPage === 'function'/);
});

function loadSearchHelpers() {
  const start = SHELL.indexOf('function normalizePanelSearch');
  const end = SHELL.indexOf('function togglePanelSearchClearState', start);
  assert.ok(start >= 0 && end > start, 'panel search helpers missing from the shell module');
  const sandbox = { queueSearchQuery: '', playQueue: [], Math, String };
  vm.createContext(sandbox);
  vm.runInContext(SHELL.slice(start, end), sandbox, { filename: 'panel-search-helpers.js' });
  return sandbox;
}

test('空过滤词返回 null，调用方才能走原来的整份渲染路径', () => {
  const box = loadSearchHelpers();
  box.playQueue = [{ name: '晚风', artist: '陈婧霏' }];
  assert.equal(box.queueSearchIndices(), null);
});

test('队列按歌名 / 歌手 / 专辑匹配，且大小写无关', () => {
  const box = loadSearchHelpers();
  box.playQueue = [
    { name: 'Lemon Tree', artist: 'Fools Garden', album: 'Dish of the Day' },
    { name: '晚风', artist: '陈婧霏', album: '尘埃' },
    { name: 'Lemon', artist: '米津玄師', album: 'STRAY SHEEP' }
  ];
  box.queueSearchQuery = 'lemon';
  assert.deepEqual(Array.from(box.queueSearchIndices()), [0, 2]);
  box.queueSearchQuery = '陈婧霏';
  assert.deepEqual(Array.from(box.queueSearchIndices()), [1]);
  box.queueSearchQuery = 'stray';
  assert.deepEqual(Array.from(box.queueSearchIndices()), [2]);
  box.queueSearchQuery = '没有这首';
  assert.deepEqual(Array.from(box.queueSearchIndices()), []);
});

test('缺字段的曲目不会让过滤抛错', () => {
  const box = loadSearchHelpers();
  box.playQueue = [{ name: '有的' }, null, { artist: '只有歌手' }];
  box.queueSearchQuery = '有';
  // 第 1 项是 null：不能抛错，也不能算命中；另外两项分别是歌名与歌手命中。
  assert.deepEqual(Array.from(box.queueSearchIndices()), [0, 2]);
});

test('四个搜索文案在七个语言包里都在', () => {
  const keys = ['pl_search_queue', 'pl_search_playlists', 'pl_search_no_match', 'pl_search_no_playlist_html'];
  for (const loc of LOCALES) {
    const dict = JSON.parse(read('public/locales/' + loc + '.json'));
    for (const key of keys) {
      assert.ok(typeof dict[key] === 'string' && dict[key], loc + ' missing ' + key);
    }
    assert.match(dict.pl_search_no_playlist_html, /^<div style="/, loc + ' 的歌单空态要带样式，否则会顶成一行裸文字');
  }
});

test('搜索行有样式，清除按钮只在有内容时出现', () => {
  assert.match(CSS, /\.panel-search input \{/);
  assert.match(CSS, /\.panel-search input:focus \{/);
  assert.match(CSS, /\.mini-queue-search input \{/);
  assert.match(CSS, /\.panel-search\.has-value \.panel-search-clear \{\s*display: block/);
  // 原生 × 只在自己画了清除按钮的框里藏掉；迷你弹层靠它清空。
  assert.match(CSS, /\.panel-search input::-webkit-search-cancel-button \{\s*display: none/);
});
