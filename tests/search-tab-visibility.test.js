'use strict';

// 搜索页签（All / NE / QQ / KG / QS / Podcast）的可点性回归：
//   1. 搜索进行中页签不许消失 —— 否则用户既看不到进度，也切不回别的平台；
//   2. 再点一次当前页签要重搜，不能当作"无操作"；
//   3. 「全部」按平台逐个出结果，慢的那个不许把整页挂住。
// Regression for the search tab bar: never disappear mid-flight, re-click re-searches, and "All"
// paints per platform instead of waiting for the slowest one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./helpers/module-source');

const appRoot = path.resolve(__dirname, '..');
const searchPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '07-search.js');
const searchSource = fs.readFileSync(searchPath, 'utf8');
const searchCss = fs.readFileSync(path.join(appRoot, 'public', 'css', 'search.css'), 'utf8');

function functionSource(name) {
  // extractFunction 从 `function` 这个词开始切，`async` 前缀会丢；这里补回去。
  // extractFunction slices from the `function` keyword, which drops an `async` prefix.
  const source = extractFunction(searchSource, name);
  return searchSource.includes('async function ' + name + '(') ? 'async ' + source : source;
}

function runFragment(prelude, names) {
  const sandbox = { console };
  vm.runInNewContext(
    prelude + '\n' + names.map(functionSource).join('\n'),
    sandbox
  );
  return sandbox;
}

test('the tab bar is never hidden while a search is in flight', () => {
  // 空首页只在有结果时显示页签，但搜索中/用户已动过这块界面时必须留着。
  assert.match(
    searchCss,
    /body\.empty-home-active\.diy-mode #search-area:not\(\.has-results\):not\(\.search-busy\):not\(.search-tabs-touched\) #search-mode-tabs\s*\{[^}]*display:\s*none/,
    'the only rule that hides the tabs must exempt .search-busy and an already-touched search area'
  );
  assert.match(searchSource, /function setSearchBusy\(on\)/, 'the busy marker needs its own setter');
  assert.match(searchSource, /setSearchBusy\(true\)/, 'a search must mark the surface busy before awaiting');
  assert.match(searchSource, /finally \{[\s\S]{0,200}setSearchBusy\(false\)/,
    'the busy marker must be cleared in a finally block so an error cannot leave it stuck');
  assert.match(searchSource, /if \(requestSeq === searchRequestSeq\) setSearchBusy\(false\)/,
    'only the latest request may clear the busy marker');
});

test('doSearch paints a placeholder and renders partial results before the slow providers answer', async () => {
  const prelude = `
    var searchMode = 'song';
    var searchRequestSeq = 0;
    var searchLastResultQuery = '';
    var pendingSearchProviderPages = null;
    var playlist = [];
    var searchMusicRenderState = { songs: [], providerPages: {}, remoteHasMore: false };
    var MUSIC_SEARCH_MAX_RESULTS = 180;
    var events = [];
    var busyStates = [];
    var $input = { value: '晴天' };
    var $results = {
      innerHTML: '',
      scrollTop: 0,
      classList: { add: function () { events.push('show'); }, remove: function () { }, contains: function () { return false; } },
    };
    function setSearchHistorySurface() { }
    function disconnectSearchLoadMoreObserver() { }
    function searchPanelText(key, fallback) { return fallback || key; }
    function escHtml(value) { return String(value); }
    function searchQuoteClose() { return '”'; }
    function resetSearchMusicRenderState() { }
    function rememberSearchQuery(q) { events.push('remember:' + q); }
    function searchResultKey(q, mode) { return (mode || 'song') + '|' + q; }
    function renderSongSearchResults(songs) { events.push('render:' + songs.length); }
    function playSearchResult(index) { events.push('play:' + index); }
    function refreshSearchLoadMoreSentinel() { }
    function setSearchBusy(on) { busyStates.push(on); }
    var answer = { partial: [{ name: 'a' }], songs: [{ name: 'a' }, { name: 'b' }] };
    function fetchMusicSearchResults(q, mode, previousPages, onPartial) {
      events.push('fetch:' + q);
      if (onPartial && answer.partial) onPartial({ songs: answer.partial, providerPages: {}, hasMore: false });
      return Promise.resolve({ songs: answer.songs, providerPages: {}, hasMore: false });
    }
  `;
  const sandbox = runFragment(prelude, ['doSearch']);
  assert.strictEqual(sandbox.searchMode, 'song');

  await sandbox.doSearch('晴天');

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.busyStates)), [true, false],
    'the search must raise the busy marker first and always drop it again');
  assert.match(sandbox.$results.innerHTML, /晴天/, 'the "searching" placeholder must be painted before awaiting');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.events)), ['show', 'fetch:晴天', 'render:1', 'remember:晴天', 'render:2'],
    'the placeholder shows first, the first platform to answer paints, and the final pass still merges the rest');
});

test('doSearch does not rebuild the list when the final result adds nothing', async () => {
  const prelude = `
    var searchMode = 'song';
    var searchRequestSeq = 0;
    var searchLastResultQuery = '';
    var pendingSearchProviderPages = null;
    var playlist = [];
    var searchMusicRenderState = { songs: [], providerPages: {}, remoteHasMore: false };
    var MUSIC_SEARCH_MAX_RESULTS = 180;
    var events = [];
    var busyStates = [];
    var $input = { value: '晴天' };
    var $results = { innerHTML: '', scrollTop: 0, classList: { add: function () { }, remove: function () { }, contains: function () { return false; } } };
    function setSearchHistorySurface() { }
    function disconnectSearchLoadMoreObserver() { }
    function searchPanelText(key, fallback) { return fallback || key; }
    function escHtml(value) { return String(value); }
    function searchQuoteClose() { return '”'; }
    function resetSearchMusicRenderState() { }
    function rememberSearchQuery(q) { }
    function searchResultKey(q, mode) { return (mode || 'song') + '|' + q; }
    function renderSongSearchResults(songs) { events.push('render:' + songs.length); }
    function playSearchResult(index) { }
    function refreshSearchLoadMoreSentinel() { events.push('sentinel'); }
    function setSearchBusy(on) { busyStates.push(on); }
    function fetchMusicSearchResults(q, mode, previousPages, onPartial) {
      if (onPartial) onPartial({ songs: [{ name: 'a' }], providerPages: { netease: { hasMore: false } }, hasMore: false });
      return Promise.resolve({ songs: [{ name: 'a' }], providerPages: { netease: { hasMore: false } }, hasMore: false });
    }
  `;
  const sandbox = runFragment(prelude, ['doSearch']);
  await sandbox.doSearch('晴天');

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.events)), ['render:1', 'sentinel'],
    'nothing new arrived, so the painted list must stay as it is (rebuilding would reset the scroll position)');
  assert.strictEqual(sandbox.playlist.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.searchMusicRenderState.providerPages)), { netease: { hasMore: false } },
    'the final pass still has to hand over the paging state');
});

test('a superseded search must not clear the busy marker', async () => {
  const prelude = `
    var searchMode = 'song';
    var searchRequestSeq = 0;
    var searchLastResultQuery = '';
    var pendingSearchProviderPages = null;
    var playlist = [];
    var searchMusicRenderState = { songs: [], providerPages: {}, remoteHasMore: false };
    var MUSIC_SEARCH_MAX_RESULTS = 180;
    var busyStates = [];
    var $input = { value: '晴天' };
    var $results = { innerHTML: '', scrollTop: 0, classList: { add: function () { }, remove: function () { }, contains: function () { return false; } } };
    function setSearchHistorySurface() { }
    function disconnectSearchLoadMoreObserver() { }
    function searchPanelText(key, fallback) { return fallback || key; }
    function escHtml(value) { return String(value); }
    function searchQuoteClose() { return '”'; }
    function resetSearchMusicRenderState() { }
    function rememberSearchQuery(q) { }
    function searchResultKey(q, mode) { return (mode || 'song') + '|' + q; }
    function renderSongSearchResults(songs) { }
    function playSearchResult(index) { }
    function refreshSearchLoadMoreSentinel() { }
    function setSearchBusy(on) { busyStates.push(on); }
    function fetchMusicSearchResults() { return Promise.resolve({ songs: [{ name: 'a' }], providerPages: {}, hasMore: false }); }
  `;
  const sandbox = runFragment(prelude, ['doSearch']);
  const pending = sandbox.doSearch('晴天');
  sandbox.searchRequestSeq += 1; // 用户在结果回来之前又敲了一个字
  await pending;

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.busyStates)), [true],
    'the newer search owns the marker; the stale response must leave it alone');
});

test('clicking the already-selected tab searches again instead of doing nothing', () => {
  const prelude = `
    var searchMode = 'song';
    var calls = [];
    var $input = { value: '晴天' };
    var document = { getElementById: function () { return null; } };
    function doSearch(q) { calls.push('search:' + q); }
    function markSearchTabsTouched() { }
    function updateSearchModeTabs() { }
    function clearSearchResults() { calls.push('clear'); }
    function setPeek() { }
    function renderSearchHistory() { return false; }
    function loadPodcastHot() { }
  `;
  const sandbox = runFragment(prelude, ['setSearchMode']);

  sandbox.setSearchMode('song');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.calls)), ['search:晴天'],
    'pressing "All" while already on "All" must re-run the query');

  sandbox.setSearchMode('qq');
  assert.strictEqual(sandbox.searchMode, 'qq');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.calls)), ['search:晴天', 'clear', 'search:晴天'],
    'switching platform still clears and re-searches');
});

test('"All" asks each platform separately and cannot wait forever on one of them', () => {
  assert.match(searchSource, /var SEARCH_PROVIDER_TIMEOUT_MS = \d+;/, 'each provider needs its own ceiling');
  assert.match(searchSource, /\{ timeoutMs: SEARCH_PROVIDER_TIMEOUT_MS \}/, 'the ceiling must reach apiJson');
  assert.match(searchSource, /function ingest\(entry\)/, 'per-provider settling is what makes partial painting possible');
  assert.match(searchSource, /onPartial\(\{ songs: mergedSongs\(\)/, 'every provider that answers must report immediately');
  assert.doesNotMatch(searchSource, /Promise\.allSettled/,
    'allSettled only resolves when the slowest provider does — that is the bug being fixed');
});
