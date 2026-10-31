'use strict';

// 展开歌单后「下方空一大截」的回归守卫（2026-10-31 用户报）。
//
// 歌单列表面板是虚拟滚动的：台账里每张卡片 69px、展开的详情块三五百像素，渲染时只画
// 视口窗口内的条目，窗口外的高度由两个占位符撑着。详情块在台账里是独立一条，但它视觉上
// 属于上面那张卡片——窗口的 start/end 按卡片高度切，切在详情上时就变成「高度算进去了，
// 节点没渲染」，面板里凭空出现一整块空白，位置正好在展开的卡片下面。
//
// 两条不变量：
//   1. 窗口边界不能切开详情块（否则多出死空白）；
//   2. 台账总高撑不出滚动条时不做虚拟化——那时占位符永远滚不走，只能是一块死空白。
// Two invariants for the playlist panel's virtual window, both from a real report (2026-10-31):
//   1. the window must never split a detail block from its card, or the reserved height renders
//      as nothing and leaves a blank hole under the expanded playlist;
//   2. when the ledger cannot produce a scrollbar, virtualise nothing — a spacer that can never
//      be scrolled away is dead space.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const DETAIL = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `找不到切片：${startMarker}`);
  return text.slice(start, end);
}

const expandSrc = slice(
  DETAIL,
  'function playlistPanelExpandWindowForDetail(',
  'function playlistCatalogFooterHtml()'
);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(expandSrc + '\nthis.__expand = playlistPanelExpandWindowForDetail;', sandbox);
const expand = sandbox.__expand;

const card = (i) => ({ type: 'card', height: 69, i });
const detail = () => ({ type: 'detail', height: 403 });

test('尾边界不切开详情：end 落在详情上时把它纳入', () => {
  const entries = [card(0), card(1), detail(), card(2)];
  const w = expand(entries, 0, 2);
  assert.strictEqual(w.start, 0);
  assert.strictEqual(w.end, 3, 'end 是排他的，落在详情上必须 +1 才能把它渲染出来');
});

test('头边界不切开详情：start 落在详情上时退回它上面的卡片', () => {
  const entries = [card(0), detail(), card(1), card(2)];
  const w = expand(entries, 1, 3);
  assert.strictEqual(w.start, 0, '详情要跟着它上面那张卡片一起进来');
  assert.strictEqual(w.end, 3);
});

test('连续详情也被整段吃下，不会停在中间', () => {
  const entries = [card(0), detail(), detail(), card(1)];
  const w = expand(entries, 0, 1);
  assert.strictEqual(w.end, 3);
});

test('窗口本来就没碰详情时不动', () => {
  const entries = [card(0), card(1), card(2)];
  const w = expand(entries, 1, 3);
  assert.strictEqual(w.start, 1);
  assert.strictEqual(w.end, 3);
});

test('越界与非法输入被夹住', () => {
  // 跨 realm 的对象原型不同，逐字段比对而不是 deepStrictEqual。
  const empty = expand([], 0, 0);
  assert.strictEqual(empty.start, 0);
  assert.strictEqual(empty.end, 0);
  const over = expand([card(0)], 0, 5);
  assert.strictEqual(over.start, 0);
  assert.strictEqual(over.end, 5);
  const nil = expand(null, 2, 4);
  assert.strictEqual(nil.start, 2);
  assert.strictEqual(nil.end, 4);
});

test('渲染路径真的走了这层外扩', () => {
  const render = slice(DETAIL, 'function renderUserPlaylistsList(', 'function renderMyPodcastCollections(');
  assert.match(render, /playlistPanelExpandWindowForDetail\(cache\.entries,\s*start,\s*end\)/);
  assert.match(render, /start\s*=\s*expanded\.start/);
  assert.match(render, /end\s*=\s*expanded\.end/);
});

test('撑不出滚动条时就整份渲染，不留会滚不走的占位符', () => {
  const render = slice(DETAIL, 'function renderUserPlaylistsList(', 'function renderMyPodcastCollections(');
  // 快速路径：台账总高本来就撑不满一屏。
  assert.match(render, /cache\.totalHeight\s*<=\s*viewport \+ PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX/);
  // 兜底：渲染之后发现还有条目被虚拟掉、面板却已经滚不动 —— 那截永远够不到，必须整份重画。
  assert.match(render, /if \(end < cache\.entries\.length && panel && panel\.scrollHeight <= panel\.clientHeight \+ 4\) \{/);
  const fallback = slice(
    render,
    'if (end < cache.entries.length && panel && panel.scrollHeight <= panel.clientHeight + 4) {',
    'if (panel && opts.preserveScroll)'
  );
  assert.match(fallback, /start = 0/);
  assert.match(fallback, /end = cache\.entries\.length/);
  assert.match(fallback, /\$pl\.innerHTML = playlistPanelWindowHtml\(start, end\)/, '兜底要重新渲染整份，不能只改指针');
});

// 悬挂的 rAF 句柄：窗口最小化/被遮挡时 Chromium 会丢掉待执行的回调，那个 id 再也不会回来。
// `if (state.raf) return` 若一直把它当成「已排队」，之后每次滚动都被短路，列表再也不换窗口。
test('悬挂的 rAF 句柄不会永久卡住面板重排', () => {
  const src = slice(
    DETAIL,
    'var PANEL_VIRTUAL_RAF_STALE_MS',
    'function scheduleQueuePanelVirtualRender()'
  );
  const sandbox = { Date, console, cancelAnimationFrame: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__take = takePanelVirtualFrame;', sandbox);
  const take = sandbox.__take;

  assert.strictEqual(take(null), false, '没有状态时不排队');
  assert.strictEqual(take({ raf: 0, rafAt: 0 }), true, '没有在途句柄时直接排队');
  assert.strictEqual(take({ raf: 12, rafAt: Date.now() }), false, '刚排过的不要重复排');
  assert.strictEqual(take({ raf: 12, rafAt: Date.now() - 5000 }), true, '超过心跳的句柄按已死处理，重新排队');

  const state = { raf: 12, rafAt: Date.now() - 5000 };
  take(state);
  assert.strictEqual(state.raf, 0, '死句柄要被清掉，不能留着继续短路');
  assert.ok(typeof state.rafAt === 'number' && state.rafAt > 0, '重新排队要刷新时间戳');
});

test('最后一个模块 load 就 flush，不等 window 的 load', () => {
  const LOADER = fs.readFileSync(path.join(ROOT, 'public', 'js', 'index-loader.js'), 'utf8');
  assert.match(LOADER, /const isLastModule = moduleIndex === modulePaths\.length - 1;/);
  assert.match(LOADER, /if \(isLastModule\) el\.onload = flushBootHooks;/);
  assert.match(LOADER, /if \(isLastModule\) flushBootHooks\(\);/, '加载失败也要兜一次 flush');
});
