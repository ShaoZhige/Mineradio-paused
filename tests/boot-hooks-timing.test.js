'use strict';

// 启动钩子时序守卫（2026-10-31 用户报「歌单和歌曲一多，下方大片空白」的根因）。
//
// 分文件注入之后，模块是以 `el.src` 动态插入的**外部**脚本，`async=false` 只保证它们彼此
// 按插入顺序执行；而跑钩子那段是**内联**脚本，插入当场就同步跑完了——那一刻模块一个都还没
// 下载回来，钩子表还是空的。于是之后每个模块登记的钩子都躺在一个再也没人读的数组里，滚动
// 懒渲染（bindPlaylistPanelLazyRender）和弹窗背景关闭全部静默失效：面板滚到底也不换窗口，
// 虚拟列表用占位符撑出来的高度就成了永久空白。
//
// 三条不变量：
//   1. 钩子不在内联脚本插入时跑，而是等到 load（外部脚本都属于它管的资源）；
//   2. 页面已经 complete 时立即跑，别把钩子永远挂在等不来的事件上；
//   3. flush 之后才登记的钩子直接执行，不能又塞进数组。
// Three invariants for the boot hooks, from a real report (2026-10-31): the inline runner used to
// execute before any split module had downloaded, so every hook registered later sat in a list
// nobody read again; lazy panel scrolling was silently dead and the virtual list's spacers turned
// into permanent blank space.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LOADER = fs.readFileSync(path.join(ROOT, 'public', 'js', 'index-loader.js'), 'utf8');

// 把 index-loader 里两个源码生成函数原样取出来重放：它们只做字符串拼接 / 模板，没有外部依赖。
function bodyOf(name) {
  const head = LOADER.indexOf(`function ${name}(`);
  assert.ok(head >= 0, `找不到 ${name}`);
  const open = LOADER.indexOf('{', head);
  const close = LOADER.indexOf('\n  }\n', open);
  assert.ok(close > open, `找不到 ${name} 的结尾`);
  return LOADER.slice(open + 1, close + 1);
}

function evalSourceOf(name) {
  const body = bodyOf(name).trim();
  const expr = body.replace(/^return\s+/, '').replace(/;\s*$/, '');
  assert.ok(expr !== body, `${name} 应当直接 return 一个字符串表达式`);
  return vm.runInNewContext(`(${expr})`, { JSON });
}

function makeSandbox() {
  const listeners = { window: {}, document: {} };
  const sandbox = {
    console,
    window: { addEventListener: (type, fn) => { listeners.window[type] = fn; } },
    document: { readyState: 'loading', addEventListener: (type, fn) => { listeners.document[type] = fn; } },
  };
  vm.createContext(sandbox);
  return { sandbox, listeners };
}

test('旧的「内联插入当场遍历钩子」形态已经消失', () => {
  assert.ok(
    !/var hooks = window\.__mineradioBootHooks \|\| \[\];\s*\n\s*for \(var i = 0; i < hooks\.length; i\+\+\) \{\s*\n\s*try \{ hooks\[i\]\(\); \}/.test(LOADER),
    'bootRunSource 不能再在插入时就跑完，那一刻模块还没下载回来'
  );
});

test('钩子推迟到 load，且已 complete 时立即跑', () => {
  assert.match(LOADER, /if \(document\.readyState === "complete"\) window\.__mineradioRunBootHooks\(\);/);
  assert.match(LOADER, /else window\.addEventListener\("load", window\.__mineradioRunBootHooks, \{ once: true \}\);/);
});

test('flush 之后才登记的钩子直接执行，不再入队', () => {
  assert.match(LOADER, /if \(window\.__mineradioBootFlushed\) \{/);
  assert.match(LOADER, /try \{ fn\(\); \} catch \(error\)/);
});

test('真实时序：load 之前不跑，load 之后跑一次，迟到的登记立刻跑', () => {
  const hooksSource = evalSourceOf('bootHooksSource');
  const runSource = evalSourceOf('bootRunSource');
  const { sandbox, listeners } = makeSandbox();

  // 地基脚本：只登记 defer，不跑任何东西。
  vm.runInContext(hooksSource, sandbox);
  assert.strictEqual(typeof sandbox.window.__mineradioDefer, 'function');

  const ran = [];
  sandbox.window.__mineradioDefer(() => ran.push('early'));
  assert.deepStrictEqual(ran, [], '还没 flush，钩子只能排队');

  // 收尾脚本：此时 document 还是 loading（模块仍在下载），必须只挂监听。
  vm.runInContext(runSource, sandbox);
  assert.strictEqual(sandbox.window.__mineradioBootFlushed, undefined, 'load 之前不许 flush');
  assert.deepStrictEqual(ran, [], 'load 之前不许执行钩子');
  assert.strictEqual(typeof listeners.window.load, 'function', '必须挂上 load 监听');

  // load 到达：排队的那一个跑掉，队列清空，标记置位。
  listeners.window.load();
  assert.deepStrictEqual(ran, ['early']);
  assert.strictEqual(sandbox.window.__mineradioBootFlushed, true);
  assert.strictEqual(sandbox.window.__mineradioBootHooks.length, 0);

  // flush 之后才注入的模块：直接执行，不再进那个没人读的数组。
  sandbox.window.__mineradioDefer(() => ran.push('late'));
  assert.deepStrictEqual(ran, ['early', 'late']);
  assert.strictEqual(sandbox.window.__mineradioBootHooks.length, 0);
});

test('页面已经 complete 时不等 load，直接 flush', () => {
  const hooksSource = evalSourceOf('bootHooksSource');
  const runSource = evalSourceOf('bootRunSource');
  const { sandbox } = makeSandbox();
  sandbox.document.readyState = 'complete';

  vm.runInContext(hooksSource, sandbox);
  const ran = [];
  sandbox.window.__mineradioDefer(() => ran.push('hook'));
  vm.runInContext(runSource, sandbox);

  assert.deepStrictEqual(ran, ['hook'], 'complete 时钩子必须立刻执行，而不是挂在等不来的 load 上');
  assert.strictEqual(sandbox.window.__mineradioBootFlushed, true);
});

test('钩子抛错不中断其余钩子', () => {
  const hooksSource = evalSourceOf('bootHooksSource');
  const runSource = evalSourceOf('bootRunSource');
  const { sandbox, listeners } = makeSandbox();

  vm.runInContext(hooksSource, sandbox);
  const ran = [];
  sandbox.window.__mineradioDefer(() => { throw new Error('boom'); });
  sandbox.window.__mineradioDefer(() => ran.push('second'));
  vm.runInContext(runSource, sandbox);
  listeners.window.load();

  assert.deepStrictEqual(ran, ['second'], '前一个钩子失败不能带走后面的');
  assert.strictEqual(sandbox.window.__mineradioBootFlushed, true);
});
