'use strict';

// 分文件注入的守卫。
//
// 加载器只做一件事：按 `modulePaths` 的顺序，把每个模块作为独立 `<script src>` 插进文档。
// 这里不比对源码文本，而是**真的把 loader 跑一遍**，把它创建出来的 script 节点收集起来，
// 再断言三件在浏览器里出错就不会有人提醒的事：
//   1. `async` 必须显式关掉 —— 动态插入的 script 默认 async，执行顺序会退化到「谁先下载完」；
//   2. boot 地基（`__mineradioDefer` 的定义）必须排在第一个模块之前，否则模块顶层调用它
//      就是 TypeError，而这条错误会把该文件后面所有赋值一起吃掉；
//   3. 收尾脚本（跑 boot 钩子 + 惰性模块运行时）必须排在所有模块之后。
//
// The loader has exactly one job: inject every entry of `modulePaths` as its own `<script src>`,
// in order. Rather than grepping the source, this test *runs* the loader, collects the script
// nodes it creates, and pins three things whose failure is silent:
//   1. `async` must be turned off explicitly — dynamically inserted scripts default to async, so
//      execution order collapses into download order;
//   2. the boot foundation (defining `__mineradioDefer`) must precede the first module, because
//      modules call it at top level and that throw would swallow the rest of the file;
//   3. the closing script (boot hooks + lazy-module runtime) must come after every module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
const loaderText = fs.readFileSync(loaderPath, 'utf8');

// 把 loader 放在假 DOM 里执行，返回它插入的节点（按插入顺序）。
// Runs the loader against a fake DOM and returns the nodes it injected, in insertion order.
function runLoader() {
  const injected = [];

  function makeNode() {
    return {
      text: '',
      src: '',
      async: true, // 浏览器的默认值：任何被插入的 script 都从 true 开始
      onerror: null,
      nextSibling: null,
      parentNode: host,
    };
  }

  // 只实现 loader 真正用到的那一个方法。`appendAfter` 总是插在「上一个节点」之后，
  // 所以按调用顺序累积就够了 —— 顺序即插入顺序。
  const host = {
    insertBefore(node) {
      injected.push(node);
      return node;
    },
  };

  const document = {
    currentScript: makeNode(),
    createElement: () => makeNode(),
  };

  const sandbox = {
    console,
    document,
    window: { location: { search: '' } },
    Date,
    JSON,
    String,
    Number,
    Object,
    Promise,
  };
  sandbox.window.document = document;
  vm.createContext(sandbox);
  vm.runInContext(loaderText, sandbox, { filename: 'index-loader.js' });

  return injected;
}

// 从 loader 源码里取登记清单，顺序敏感。
// 直接截 `const modulePaths = [ … ];` 这一段再抽字符串 —— 早先版本用「前缀白名单」正则
// （js/modules/… 或 sonic-…），结果漏掉了 `highway-drive-preset.js`（它两个前缀都不带），
// 清单从第 44 项起整体错位一格，断言报了一个完全不相关的位置。
// Reads the registered list straight out of the `const modulePaths = [ … ];` literal. An earlier
// prefix-whitelist regex (js/modules/… or sonic-…) missed `highway-drive-preset.js`, which matches
// neither, shifting the list by one from index 44 on and failing at an unrelated position.
function readModulePaths() {
  const marker = 'const modulePaths = [';
  const start = loaderText.indexOf(marker);
  assert.ok(start >= 0, 'index-loader.js 里找不到 const modulePaths = [');
  const end = loaderText.indexOf('];', start);
  assert.ok(end > start, 'modulePaths 数组没有闭合');
  const block = loaderText.slice(start + marker.length, end);
  return [...block.matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
}

test('loader injects one script per module, in registration order', () => {
  const injected = runLoader();
  const paths = readModulePaths();

  assert.ok(paths.length > 100, `登记清单异常，只有 ${paths.length} 个模块`);

  // 首个是 boot 地基，末个是收尾脚本，中间全是模块。
  assert.equal(
    injected.length,
    paths.length + 2,
    `应注入 ${paths.length} 个模块 + 2 个辅助脚本，实际 ${injected.length} 个`
  );

  const modules = injected.slice(1, -1);
  modules.forEach((node, i) => {
    assert.ok(
      node.src.startsWith(paths[i] + '?v='),
      `第 ${i + 1} 个注入的应是 ${paths[i]}，实际是 ${node.src || '(空)'}`
    );
  });

  // 同一个文件被登记两次就等于执行两次，模块顶层那些赋值/事件绑定会跑第二遍。
  assert.equal(new Set(paths).size, paths.length, '登记清单里有重复项');

  // 每个登记的文件都得真的存在于磁盘上，否则运行时只是一个 404 和一个空白的 console.error。
  for (const p of paths) {
    assert.ok(fs.existsSync(path.join(appRoot, 'public', p)), `登记了不存在的文件：${p}`);
  }
});

test('every injected module script has async explicitly disabled', () => {
  // 这是整条分文件方案唯一的正确性支点：动态插入的 script 默认 async=true，浏览器会按
  // 「谁先下载完谁先跑」执行，而模块之间有严格的顺序依赖（i18n → core stores → 读取层 →
  // 消费者）。少了 el.async = false，顺序会随磁盘缓存的冷热而变，表现为偶发、不可复现的
  // undefined is not a function。
  //
  // The single load-bearing detail of the whole scheme: dynamically inserted scripts default to
  // async=true, so they run in download-completion order while the modules have strict ordering
  // dependencies. Without el.async = false the order shifts with cache temperature and shows up as
  // intermittent, unreproducible "undefined is not a function".
  const injected = runLoader();
  const modules = injected.slice(1, -1);
  assert.ok(modules.length > 100, '注入的模块数量异常，守卫需要重新对齐');
  for (const node of modules) {
    assert.equal(
      node.async,
      false,
      `模块 ${node.src} 的 async 仍是 true —— 执行顺序会退化成下载顺序`
    );
  }
});

test('the boot foundation runs before the first module and the closing script after the last', () => {
  const injected = runLoader();

  assert.match(
    injected[0].text,
    /__mineradioDefer/,
    '第一个注入的脚本必须定义 __mineradioDefer，模块在顶层就会调用它'
  );

  const last = injected[injected.length - 1];
  assert.match(last.text, /__mineradioBootHooks/, '收尾脚本必须负责跑 boot 钩子');
  assert.match(last.text, /__mineradioEnsureLazyModule/, '收尾脚本必须带上惰性模块运行时');
  assert.equal(last.src, '', '收尾脚本是内联的，不该有 src');
});

test('the concatenating injection path is gone, not merely unused', () => {
  // 曾经有两条路径：把 117 个模块拼成一个 <script>（默认），或者分文件注入（?loader=split）。
  // 拼接那条已经删了 —— 它每次启动要做 117 次**同步** XHR，直接阻塞主线程，而且栈里只有
  // 一个巨型 sourceURL。留下任何残骸（开关判断、映射器、拼接函数）都等于给下一个人一个
  // 「看起来还能切回去」的错觉。
  //
  // There used to be two paths: concatenate all 117 modules into one <script> (the default) or
  // inject per file (?loader=split). The concatenating one is deleted — 117 *synchronous* XHRs on
  // every start, blocking the main thread, plus a single blob URL in every stack. Leaving any
  // remnant (a mode switch, a mapper, a joiner) would imply it can still be switched back.
  for (const gone of [
    'injectConcatenatedModules',
    'buildModuleLineMap',
    'moduleMapSource',
    'loaderMode',
    '?loader=',
  ]) {
    assert.ok(
      !loaderText.includes(gone),
      `index-loader.js 里还有「${gone}」的残留：拼接路径应整体删除，不是留着不用`
    );
  }
  // 同步 XHR 也必须一并消失：那条路径是它唯一的用途。
  assert.ok(
    !/\.open\([^)]*,\s*false\s*\)/.test(loaderText),
    'index-loader.js 里还有同步 XHR（open(..., false)），它只服务于已删除的拼接路径'
  );
});
