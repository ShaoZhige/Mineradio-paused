// DIY 控制台「撤销 / 历史」入口的回归：撤销栈与历史语义一直都在，入口曾经被删掉，
// 结果撤销默认 disabled、历史浮层永远空着 —— 等于把写好的能力锁死。
// 这份用例钉住「入口在、首帧渲染过、四种语言都有按钮文案、语义常数没被动过」。
// Regression for the DIY console undo/history entry points. The stack and its semantics were
// always there; the entry points were removed, which left undo permanently disabled and the
// history popover empty. These checks pin the entry points, the first render, the localized
// label, and the untouched history constants.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKSPACE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'index.css'), 'utf8');
const LOCALES = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];

function readLocale(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', `${name}.json`), 'utf8'));
}

function section(name) {
  const start = WORKSPACE.indexOf(`function ${name}(`);
  assert.ok(start > -1, `应能找到 ${name}`);
  const next = WORKSPACE.indexOf('\nfunction ', start + 10);
  return WORKSPACE.slice(start, next > -1 ? next : WORKSPACE.length);
}

test('工具栏会创建撤销与历史两个入口', () => {
  const toolbar = section('fxConsoleMakeToolbar');
  assert.match(toolbar, /undoButton\.id\s*=\s*'fx-console-undo'/, '缺少撤销按钮的 id');
  assert.match(toolbar, /historyToggle\.id\s*=\s*'fx-console-history-toggle'/, '缺少历史开关的 id');
  assert.match(toolbar, /historyPopover\.id\s*=\s*'fx-console-history'/, '缺少历史浮层容器');
  assert.match(toolbar, /undoButton\.disabled\s*=\s*true/, '撤销按钮初始必须是 disabled');
});

test('工具栏建完会立刻渲染一次历史（否则撤销永远 disabled）', () => {
  const toolbar = section('fxConsoleMakeToolbar');
  assert.match(toolbar, /panel\.appendChild\(toolbar\)[\s\S]{0,200}renderFxConsoleHistory\(\)/, '建完工具栏必须渲染一次历史');
});

test('撤销按钮与历史开关都已绑定行为', () => {
  const toolbar = section('fxConsoleMakeToolbar');
  assert.match(toolbar, /undoButton\.addEventListener\('click'[\s\S]{0,80}undoFxConsoleHistory\(\)/, '撤销按钮未绑定');
  assert.match(toolbar, /historyToggle\.addEventListener\('click'[\s\S]{0,80}setFxConsoleHistoryOpen/, '历史开关未绑定');
  const toggle = section('setFxConsoleHistoryOpen');
  assert.match(toggle, /renderFxConsoleHistory\(\)/, '打开浮层时必须重绘');
  assert.match(toggle, /Escape/, '应支持 Escape 关闭');
});

test('历史语义常数没被改动（40 条上限 / 650ms 合并）', () => {
  assert.match(WORKSPACE, /FX_CONSOLE_HISTORY_LIMIT\s*=\s*40/, '40 条上限被改动');
  assert.match(WORKSPACE, /now\s*-\s*last\.time\s*<\s*650/, '650ms 合并窗口被改动');
  assert.match(WORKSPACE, /function fxConsoleChangedKeys/, '变更键集合被移除');
  assert.match(WORKSPACE, /function rollbackFxConsoleHistoryTo/, '「撤销至此项前」被移除');
});

test('浮层容器有定位样式（只留 -head 子规则会飘到文档流里）', () => {
  assert.match(CSS, /\.fx-console-popover\s*\{[^}]*position:\s*absolute/, '缺少 .fx-console-popover 容器定位');
  assert.match(CSS, /\.fx-console-toolbar-actions\s*\{[^}]*display:\s*flex/, '缺少工具栏操作区排版');
});

test('四种语言都有历史按钮文案', () => {
  for (const name of LOCALES) {
    const dict = readLocale(name);
    assert.strictEqual(typeof dict.fx_history_label, 'string', `${name} 缺少 fx_history_label`);
    assert.ok(dict.fx_history_label.trim().length > 0, `${name} 的 fx_history_label 为空`);
    assert.strictEqual(typeof dict.fx_undo, 'string', `${name} 缺少 fx_undo`);
    assert.strictEqual(typeof dict.fx_recent_ops_html, 'string', `${name} 缺少 fx_recent_ops_html`);
  }
});
