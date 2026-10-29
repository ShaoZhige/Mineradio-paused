'use strict';

// 更新弹窗的日志条数与长度上限。
// 这里钉住的是「一次发布的完整日志能进弹窗」：条数不再被砍到 4 条，
// 长句不再被整条丢弃，同时仍有一道上限挡住异常大的 body。
// 弹窗内的滚动交给 CSS（.update-list），所以条数上限只用于防御。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public/js/modules/08-account/00-update-preview.js'), 'utf8');
const releaseUrl = 'https://example.invalid/releases/v2.6.0';

function serverHarness() {
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    APP_VERSION: '2.5.3', UPDATE_FALLBACK_NOTES: ['发现新版本'],
    UPDATE_CONFIG: { configured: true, provider: 'github', owner: 'fixture', repo: 'fixture' },
  });
  const start = serverSource.indexOf('function normalizeVersion(');
  const end = serverSource.indexOf('async function readUpdateManifest(', start);
  assert(start >= 0 && end > start);
  vm.runInContext(serverSource.slice(start, end), context);
  const fetchStart = serverSource.indexOf('async function fetchLatestUpdateInfo(');
  const fetchEnd = serverSource.indexOf('function readRequestBody(', fetchStart);
  assert(fetchStart >= 0 && fetchEnd > fetchStart);
  vm.runInContext(serverSource.slice(fetchStart, fetchEnd), context);
  return context;
}

function rendererHarness() {
  const nodes = {
    'update-list': { innerHTML: '' },
    'update-hero-main': { textContent: '' },
    'update-footnote': { textContent: '' },
  };
  const context = vm.createContext({
    URL,
    updatePreviewState: { currentVersion: '2.5.3', selectedDownloadPageIndex: 0 },
    document: {
      getElementById: id => nodes[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: { desktopWindow: {} },
    escHtml: text => String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    showToast() {},
    setTimeout: () => 1,
  });
  vm.runInContext(uiSource, context);
  return { context, nodes };
}

const longLine = '把软件自有数据（登录 cookie、各平台令牌、播放分区、缓存、原生脚本临时目录、错误日志）统一收进软件目录下的 userdata，'
  + '不再往 APPDATA、LOCALAPPDATA、用户主目录或系统临时目录分散写入，便携版放进 U 盘换台电脑登录态都跟着走。';

test('a real release section keeps every entry instead of stopping at four', async () => {
  const server = serverHarness();
  const lines = [];
  for (let i = 1; i <= 12; i++) lines.push('- 第 ' + i + ' 条变更说明。');
  const body = ['## 更新内容'].concat(lines, ['网盘：https://example.invalid/retired']).join('\n');
  server.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v2.6.0', html_url: releaseUrl, body }) });
  const result = await server.fetchLatestUpdateInfo();
  assert.equal(result.release.notes.length, 12);
  assert.equal(result.release.notes[11], '第 12 条变更说明。');
});

test('a long changelog sentence is kept verbatim instead of being dropped by a length filter', async () => {
  const server = serverHarness();
  const body = ['## 更新内容', '- ' + longLine, '- 短句。'].join('\n');
  server.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v2.6.0', html_url: releaseUrl, body }) });
  const result = await server.fetchLatestUpdateInfo();
  assert.equal(result.release.notes.length, 2);
  assert.equal(result.release.notes[0], longLine);
});

test('pathological payloads are still bounded, and the hero summary stays one short line', async () => {
  const server = serverHarness();
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push('- 第 ' + i + ' 条变更说明。');
  lines.push('- ' + 'x'.repeat(400));
  const body = lines.join('\n');
  server.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v2.6.0', html_url: releaseUrl, body }) });
  const result = await server.fetchLatestUpdateInfo();
  assert.equal(result.release.notes.length, 30, '超过 30 条时截断');
  assert.equal(result.release.notes.some(text => text.length > 320), false, '超长行不进列表');
  assert.equal(result.release.summary.length <= 97, true, '摘要被收成一行短句');
  assert.equal(result.release.summary, '第 1 条变更说明。');
});

test('a long first entry becomes a truncated summary rather than a paragraph in the header', async () => {
  const server = serverHarness();
  const body = ['## 更新内容', '- ' + longLine].join('\n');
  server.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v2.6.0', html_url: releaseUrl, body }) });
  const result = await server.fetchLatestUpdateInfo();
  assert.equal(result.release.notes[0], longLine);
  assert.equal(result.release.summary.endsWith('…'), true);
  assert.equal(result.release.summary.length <= 97, true);
});

test('the panel renders every entry it receives so the list can scroll instead of truncating', () => {
  const { context, nodes } = rendererHarness();
  const notes = [];
  for (let i = 1; i <= 12; i++) notes.push('第 ' + i + ' 条变更说明。');
  context.applyLatestUpdateInfo({
    currentVersion: '2.5.3',
    latestVersion: 'v2.6.0',
    configured: true,
    updateAvailable: true,
    release: { version: '2.6.0', htmlUrl: releaseUrl, summary: '一次发布说明。', downloadPages: [], notes },
  });
  assert.equal(context.updatePreviewState.notes.length, 12);
  const rendered = nodes['update-list'].innerHTML.match(/class="update-item"/g) || [];
  assert.equal(rendered.length, 12);
  assert.equal(nodes['update-list'].innerHTML.includes('第 12 条变更说明。'), true);
});
