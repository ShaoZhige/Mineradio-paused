'use strict';

// 更新弹窗的「下载线路」行为回归：
//   1. 点线路只切换选中，**不**直接打开浏览器 —— 打开是「前往」按钮的职责。
//   2. 蓝奏云的提取码要显示在线路按钮上（没密码那个页面根本打不开）。
//   3. 提取码走独立标记，不能塞进 URL 标记：已发出去的旧客户端会把 URL 之后的内容
//      当成 URL 的一部分，塞进去会让它们的网盘入口失效。
//
// Regression for the update dialog's download-source pills: selecting a source must not open
// the browser, the 蓝奏云 extraction code must be visible on the pill, and the code must ride
// its own marker so older shipped clients keep parsing the page URL correctly.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public/js/modules/08-account/00-update-preview.js'), 'utf8');

// ---------------------------------------------------------------------------
// 服务端：标记解析
// ---------------------------------------------------------------------------

function serverHarness() {
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    APP_VERSION: '2.5.3', UPDATE_FALLBACK_NOTES: ['发现新版本'],
    UPDATE_CONFIG: { configured: true, provider: 'github', owner: 'fixture', repo: 'fixture' },
  });
  const start = serverSource.indexOf('function normalizeVersion(');
  const end = serverSource.indexOf('async function readUpdateManifest(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(serverSource.slice(start, end), context);
  return context;
}

function withPasswordMarker() {
  return [
    '# Mineradio 2.8.0',
    '- 一条真实变更。',
    '## 下载',
    '<!-- mineradio-download-page: 阿里云盘|https://www.alipan.com/s/36YiXCzvuKt -->',
    '<!-- mineradio-download-page: 蓝奏云|https://wwars.lanzouq.com/b014xlh7gb -->',
    '<!-- mineradio-download-password: 蓝奏云|9izq -->',
  ].join('\n');
}

// 线上 v2.7.0 的真实形状：没有密码标记，只有正文里那句「密码 9izq」。
function legacyBody() {
  return [
    '# Mineradio 2.7.0',
    '- 一条真实变更。',
    '## 下载',
    '国内用户推荐从阿里云盘下载（不限速）：https://www.alipan.com/s/36YiXCzvuKt',
    '备用蓝奏云：https://wwars.lanzouq.com/b014xlh7gb 密码 9izq',
    '<!-- mineradio-download-page: 阿里云盘|https://www.alipan.com/s/36YiXCzvuKt -->',
    '<!-- mineradio-download-page: 蓝奏云|https://wwars.lanzouq.com/b014xlh7gb -->',
  ].join('\n');
}

test('提取码走独立标记，挂到对应线路上且不污染 URL', () => {
  const server = serverHarness();
  const pages = Array.from(server.extractReleaseDownloadPages(withPasswordMarker()));
  assert.equal(pages.length, 2);
  const aliyun = pages.find((page) => page.label === '阿里云盘');
  const lanzou = pages.find((page) => page.label === '蓝奏云');
  // 没有提取码的线路不加这个键，保持原有的对象形状（老测试依赖 { label, url }）。
  assert.equal(aliyun.password, undefined, '没写密码的线路不该凭空多出提取码');
  assert.equal(lanzou.password, '9izq');
  assert.equal(lanzou.url, 'https://wwars.lanzouq.com/b014xlh7gb', 'URL 必须保持原样，不能被密码污染');
});

test('旧发布正文没有密码标记时，从「密码 xxx」那句兜底取', () => {
  const server = serverHarness();
  const pages = Array.from(server.extractReleaseDownloadPages(legacyBody()));
  const lanzou = pages.find((page) => page.label === '蓝奏云');
  assert.ok(lanzou, '旧正文的线路标记仍要能解析');
  assert.equal(lanzou.password, '9izq', '2.7.0 这类旧正文靠正文里的密码兜底');
  assert.equal(lanzou.url, 'https://wwars.lanzouq.com/b014xlh7gb');
});

// ---------------------------------------------------------------------------
// 前端：选中与打开分离
// ---------------------------------------------------------------------------

function element(tag) {
  return {
    tagName: tag,
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    className: '',
    textContent: '',
    title: '',
    type: '',
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
  };
}

function rendererHarness() {
  const nodes = {
    'update-download-sources': element('div'),
    'update-primary-btn': element('button'),
    'update-btn-label': element('span'),
    'update-footnote': element('div'),
    'update-entry': element('div'),
    'update-modal': element('div'),
  };
  const context = vm.createContext({
    URL,
    window: { desktopWindow: {} },
    // updatePreviewState 由 00-state/01-perf-render-state.js 声明，这里注入同形对象，
    // 让模块直接在上面读写（与 update-release-notes-limit.test.js 的 harness 保持一致）。
    updatePreviewState: {
      currentVersion: '2.5.3',
      selectedDownloadPageIndex: 0,
      downloadPages: [],
      updateAvailable: false,
    },
    escHtml: (text) => String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    document: {
      getElementById: (id) => nodes[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => element(tag),
      addEventListener() {},
    },
    showToast() {},
    setTimeout: () => 1,
  });
  vm.runInContext(uiSource, context);
  return { context, nodes };
}

function seedPages(context) {
  context.updatePreviewState.updateAvailable = true;
  context.updatePreviewState.downloadPages = [
    { label: '阿里云盘', url: 'https://www.alipan.com/s/36YiXCzvuKt', password: '' },
    { label: '蓝奏云', url: 'https://wwars.lanzouq.com/b014xlh7gb', password: '9izq' },
  ];
  context.updatePreviewState.releaseUrl = '';
  context.updatePreviewState.externalUrl = '';
  context.updatePreviewState.downloadPageUrl = '';
}

test('线路按钮只写平台名，提取码放在说明行提示', () => {
  const { context, nodes } = rendererHarness();
  seedPages(context);
  context.renderUpdateDownloadSources();
  const pills = nodes['update-download-sources'].children;
  assert.equal(pills.length, 2);
  assert.equal(pills[0].textContent, '阿里云盘');
  assert.equal(pills[1].textContent, '蓝奏云', '按钮文案只放平台名，不要把提取码塞进去');

  // 选中需要提取码的线路：说明行提示提取码本身
  context.updatePreviewState.selectedDownloadPageIndex = 1;
  context.syncUpdatePreviewStateClass();
  assert.equal(nodes['update-footnote'].textContent, '该网盘需要提取码 9izq');

  // 切回不需要提取码的线路：说明行恢复通用提示，不残留 9izq
  context.updatePreviewState.selectedDownloadPageIndex = 0;
  context.syncUpdatePreviewStateClass();
  assert.doesNotMatch(nodes['update-footnote'].textContent, /9izq/);
});

test('点线路只切换选中，不打开浏览器', () => {
  const { context, nodes } = rendererHarness();
  seedPages(context);
  context.renderUpdateDownloadSources();
  let opened = 0;
  context.window.desktopWindow.openUpdatePage = async () => { opened += 1; return { ok: true }; };

  nodes['update-download-sources'].children[1].onclick();
  assert.equal(opened, 0, '点线路不应打开任何网页');
  assert.equal(context.updatePreviewState.selectedDownloadPageIndex, 1, '应切换选中');
});

test('「前往」按钮打开的是当前选中的那条线路', async () => {
  const { context, nodes } = rendererHarness();
  seedPages(context);
  context.renderUpdateDownloadSources();
  let openedUrl = '';
  context.window.desktopWindow.openUpdatePage = async (url) => { openedUrl = url; return { ok: true }; };

  context.updatePreviewState.selectedDownloadPageIndex = 1;
  // 打开前先看按钮文案：要跟着选中项走，否则用户不知道「前往」会去哪。
  // （打开之后文案会变成「已打开」，所以这条断言必须放在前面。）
  context.syncUpdatePreviewStateClass();
  assert.match(nodes['update-btn-label'].textContent, /蓝奏云/);

  await context.startUpdatePreviewDownload();
  assert.equal(openedUrl, 'https://wwars.lanzouq.com/b014xlh7gb', '应打开蓝奏云，而不是默认第一条');
});
