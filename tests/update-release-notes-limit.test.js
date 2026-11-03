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

// ---------------------------------------------------------------------------
// 发布样板不得进更新日志
//
// 真实 release body = 标题 + 变更列表 + 「## 下载」小节（网盘链接、安装包名、SHA-256 校验和）。
// 之前只按行挡「下载 / 安装包」，而那两行实际是「完整安装包：…」「SHA-256 校验文件：…」，
// 开头不匹配 → 连校验和那行十六进制都进了弹窗（v2.7.0 实际发生）。
// ---------------------------------------------------------------------------

const checksum = 'a'.repeat(64) + '  Mineradio-2.7.0-Setup.exe';

function realisticReleaseBody() {
  return [
    '# Mineradio 2.7.0',
    '',
    '- 歌单支持导出 / 导入 .mineradio.json 文件分享。',
    '- 修复最小化后壁纸被意外停掉。',
    '',
    '## 下载',
    '',
    '国内用户推荐从阿里云盘下载（不限速）：https://www.alipan.com/s/36YiXCzvuKt',
    '',
    '备用蓝奏云：https://wwars.lanzouq.com/b014xlh7gb 密码 9izq',
    '',
    '完整安装包：`Mineradio-2.7.0-Setup.exe`',
    '',
    'SHA-256 校验文件：`Mineradio-2.7.0-SHA256SUMS.txt`',
    '',
    '```',
    checksum,
    '```',
    '',
    '<!-- mineradio-download-page: 阿里云盘|https://www.alipan.com/s/36YiXCzvuKt -->',
  ].join('\n');
}

test('下载小节不进更新日志：安装包名、校验文件与校验和都被挡掉', async () => {
  const server = serverHarness();
  server.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v2.7.0', html_url: releaseUrl, body: realisticReleaseBody() }) });
  const result = await server.fetchLatestUpdateInfo();
  // vm 里造出来的数组原型与本 realm 不同，先 Array.from 归一化再比。
  assert.deepEqual(Array.from(result.release.notes), [
    '歌单支持导出 / 导入 .mineradio.json 文件分享。',
    '修复最小化后壁纸被意外停掉。',
  ]);
  // 标题行也不该冒充摘要
  assert.equal(result.release.summary, '歌单支持导出 / 导入 .mineradio.json 文件分享。');
  // 🔴 网盘入口标记必须仍然解析出来：清理日志时把它一起挡掉的话，
  // 软件内的下载入口会静默退回「打开 Release 页面」，不报错也没有日志。
  assert.equal(result.release.downloadPages.length >= 1, true, '下拉里的网盘入口不能因为过滤而消失');
});

test('release.notes 那条路径共用同一套样板判据', () => {
  const server = serverHarness();
  const boilerplate = [
    'Mineradio 2.7.0',
    '完整安装包：Mineradio-2.7.0-Setup.exe',
    'SHA-256 校验文件：Mineradio-2.7.0-SHA256SUMS.txt',
    'SHA256校验文件:Mineradio-2.7.0-SHA256SUMS.txt',
    checksum,
    '安装包：Mineradio-2.7.0-Setup.exe',
    '下载：https://example.invalid/',
  ];
  for (const line of boilerplate) {
    assert.equal(server.releaseNoteLineIsBoilerplate(line), true, `应判为发布样板：${line}`);
  }
  // 小节标题由「遇到即截断」处理，和行级判据是两条路，这里用行为验收：
  // 标题之后的任何内容都不该再进列表（模板以后加了新下载说明也一样）。
  for (const heading of ['## 下载', '### 下载地址', '## 下载与校验']) {
    const notes = server.extractReleaseNotes(['- 真实条目。', heading, '- 不该出现。', '完整安装包：x'].join('\n'));
    assert.deepEqual(Array.from(notes), ['真实条目。'], `下载小节（${heading}）之后的内容必须被截断`);
  }
  const realNotes = [
    '歌单支持导出 / 导入 .mineradio.json 文件分享。',
    '修复最小化后壁纸被意外停掉。',
    // CHANGELOG 里真实存在 5 条以「安装包」开头的条目（体积、安装目录选择），
    // 旧的宽前缀规则会把它们整条吞掉。
    '安装包体积从 107 MB 减到 97 MB。',
    '安装包支持用户自由选择安装目录。',
  ];
  for (const line of realNotes) {
    assert.equal(server.releaseNoteLineIsBoilerplate(line), false, `不应误伤真实条目：${line}`);
  }
  // manifest 提供的 notes 也必须过这道判据，否则修好 body 那条、另一条还在漏。
  assert.equal(
    /\.map\(cleanReleaseLine\)\.filter\(text => text && !releaseNoteLineIsBoilerplate\(text\)\)/.test(serverSource),
    true,
    'release.notes 路径必须复用 releaseNoteLineIsBoilerplate'
  );
});
