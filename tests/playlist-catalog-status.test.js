'use strict';

// 列表底部的「载入状态行」有两条不变量，二者都来自真实故障（2026-10-29）：
//   1. 失败**不能粘滞**：任何一次后台分页出错都会被记成永久错误，于是列表已经全部加载完，
//      「部分歌单载入失败」还一直挂在那儿 —— 这正是用户报的现象；
//   2. 没有丢数据就不许说「部分失败」：单个平台首屏 0 条（常见于 token 过期）时，
//      已显示的内容一条没少，只能给一次短提示，且要能引导到「重新登录」。
// Two invariants for the playlist catalogue status row, both from a real report (2026-10-29):
//   1. failures must not latch — the old code remembered any failed page forever, so a fully
//      loaded list still showed "部分歌单载入失败";
//   2. a platform that lost nothing must not be reported as a partial failure: one zero-row
//      platform (usually an expired token) deserves a short notice plus "sign in again".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SHELL = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
const DETAIL = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');

const DICT = {
  pl_loading_bg: '正在后台载入歌单 · ',
  pl_count_unit: ' 个',
  pl_partial_failed_prefix: '部分歌单载入失败 · 已显示 ',
  pl_provider_load_failed: '歌单载入失败',
  pl_provider_not_loaded: '歌单本次未载入',
  pl_provider_auth_expired: '登录已过期',
  pl_retry: '重试',
  pl_relogin: '重新登录',
};
const NAMES = { netease: '网易云音乐', kugou: '酷狗音乐', qq: 'QQ 音乐', qishui: '汽水音乐' };

function slice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `找不到切片：${startMarker}`);
  return text.slice(start, end);
}

function provider(overrides) {
  return Object.assign({
    enabled: true, loaded: 0, total: 0, nextOffset: 0, hasMore: false, loading: false, error: '', authExpired: false,
  }, overrides);
}

function build() {
  const sandbox = {
    playlistCatalogSyncState: {
      providers: {}, loading: false, failedProviders: [], authExpiredProviders: [], noticeUntil: 0, noticeTimer: 0,
    },
    userPlaylists: [],
    queueViewTab: 'playlists',
    renderUserPlaylistsList() {},
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    Object,
    Array,
    String,
    Boolean,
    playlistDetailText: (key) => (DICT[key] === undefined ? key : DICT[key]),
    playlistProviderName: (key) => NAMES[key] || key,
    escHtml: (value) => String(value),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    slice(SHELL, 'function refreshPlaylistCatalogErrorState', 'function retryPlaylistCatalogProviders'),
    sandbox,
    { filename: 'playlist-catalog-error-state.js' }
  );
  vm.runInContext(
    slice(DETAIL, 'function playlistCatalogFooterHtml', 'function schedulePlaylistPanelVirtualRender'),
    sandbox,
    { filename: 'playlist-catalog-footer.js' }
  );
  return sandbox;
}

test('后台分页失败不会把状态行钉死：失败平台恢复后就该整行消失', () => {
  const s = build();
  s.userPlaylists = Array.from({ length: 32 }, (_, i) => ({ id: 'ne' + i, provider: 'netease' }));
  s.playlistCatalogSyncState.providers = {
    netease: provider({ loaded: 32, total: 32, nextOffset: 32 }),
    kugou: provider({ error: '酷狗登录已过期', authExpired: true }),
  };
  s.refreshPlaylistCatalogErrorState();
  s.playlistCatalogSyncState.noticeUntil = 0;
  // 首屏 0 条的平台失败不丢任何已显示的歌单，短提示过期后不该留下任何文字。
  assert.equal(s.playlistCatalogFooterHtml(), '');

  // 该平台下一次分页成功，失败集合必须被清空（老实现会一直报错）。
  s.playlistCatalogSyncState.providers.kugou = provider({ loaded: 4, total: 4, nextOffset: 4 });
  s.refreshPlaylistCatalogErrorState();
  assert.deepEqual(s.playlistCatalogSyncState.failedProviders, []);
  assert.equal(s.playlistCatalogSyncState.error, '');
  assert.equal(s.playlistCatalogFooterHtml(), '');
});

test('真的丢了数据才说「部分失败」，并给出重试', () => {
  const s = build();
  s.userPlaylists = Array.from({ length: 38 }, (_, i) => ({ id: 'ne' + i, provider: 'netease' }));
  s.playlistCatalogSyncState.providers = {
    netease: provider({ loaded: 32, total: 32, nextOffset: 32 }),
    kugou: provider({ loaded: 6, total: 40, nextOffset: 6, error: 'KUGOU_GATEWAY_FAILED' }),
    qq: provider({ loaded: 2, total: 2, nextOffset: 2 }),
  };
  s.refreshPlaylistCatalogErrorState();
  const html = s.playlistCatalogFooterHtml();
  assert.match(html, /酷狗音乐歌单载入失败/);
  assert.match(html, /data-pl-catalog-retry="1"/);
  assert.doesNotMatch(html, /queue-hydration-spinner/, '失败态不该继续转圈，转圈暗示马上就好');

  // 多个平台一起失败时退回汇总文案，而不是只报一个名字。
  s.playlistCatalogSyncState.providers.qq = provider({ loaded: 2, error: 'QQ_DOWN' });
  s.refreshPlaylistCatalogErrorState();
  assert.match(s.playlistCatalogFooterHtml(), /部分歌单载入失败 · 已显示 38 个/);
});

test('登录过期给「重新登录」而不是「重试」，混着普通失败时仍给重试', () => {
  const s = build();
  s.userPlaylists = [{ id: 'ne1', provider: 'netease' }];
  s.playlistCatalogSyncState.providers = {
    netease: provider({ loaded: 1, total: 1, nextOffset: 1 }),
    kugou: provider({ error: '酷狗登录已过期', authExpired: true }),
  };
  s.refreshPlaylistCatalogErrorState();
  s.playlistCatalogSyncState.noticeUntil = Date.now() + 60000;
  const authHtml = s.playlistCatalogFooterHtml();
  assert.match(authHtml, /酷狗音乐登录已过期/);
  assert.match(authHtml, /data-pl-catalog-relogin="kugou"/);

  // 另一个平台同时普通失败：重试才是唯一能推进的动作。
  s.playlistCatalogSyncState.providers.qq = provider({ error: 'QQ_DOWN' });
  s.refreshPlaylistCatalogErrorState();
  const mixedHtml = s.playlistCatalogFooterHtml();
  assert.match(mixedHtml, /data-pl-catalog-retry="1"/);
  assert.doesNotMatch(mixedHtml, /data-pl-catalog-relogin/);
});

test('一条歌单都没有时用状态行替代「未找到歌单」，而不是把失败伪装成空列表', () => {
  const s = build();
  s.userPlaylists = [];
  s.playlistCatalogSyncState.providers = {
    netease: provider({ error: 'UPSTREAM_DOWN' }),
    kugou: provider({ error: '酷狗登录已过期', authExpired: true }),
  };
  s.refreshPlaylistCatalogErrorState();
  const html = s.playlistCatalogFooterHtml();
  assert.match(html, /歌单载入失败/);
  assert.match(html, /data-pl-catalog-retry="1"/);
});

test('还在分页时只显示进度，不显示错误行', () => {
  const s = build();
  s.userPlaylists = [{ id: 'ne1', provider: 'netease' }];
  s.playlistCatalogSyncState.providers = {
    netease: provider({ loaded: 32, total: 90, nextOffset: 32, hasMore: true, loading: true }),
    kugou: provider({ error: '酷狗登录已过期', authExpired: true }),
  };
  s.refreshPlaylistCatalogErrorState();
  const html = s.playlistCatalogFooterHtml();
  assert.match(html, /queue-hydration-spinner/);
  assert.match(html, /正在后台载入歌单 · 32\/90/);
  assert.doesNotMatch(html, /登录已过期/);
});
