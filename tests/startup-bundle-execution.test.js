'use strict';

// 启动期渲染守卫：index-loader 把 113 个模块拼成同一个 <script>，任何一个模块在
// 顶层抛错，后面的模块全部不会执行。之前 13-i18n.js 缺 pick()、09-console-workspace.js
// 对 null 调 appendChild，两次都只表现为"只剩外壳的黑屏"，因为 splash 揭幕、startup
// 绑定与主循环都被吃掉了，而启动状态日志一路报 ready。
// 这个守卫真的把拼好的 bundle 跑一遍：任何一个模块抛错就红。
//
// Startup rendering guard: index-loader concatenates 113 modules into a single <script>.
// A throw in any one of them silently skips every module after it. That is how a missing
// helper and a null appendChild both presented as "black screen with only the frame left",
// while startup-state.json still reported ready. This guard actually executes the
// concatenated bundle: any module that throws turns it red.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LOADER = path.join(ROOT, 'public/js/index-loader.js');

// 拼 bundle 的方式和 index-loader 保持一致（同步读文件再按顺序拼接），
// 这样守卫跑的就是浏览器真正执行的那一串代码。
// Mirrors index-loader exactly (sequential read, then concatenate) so the guard runs the
// very same string the browser executes.
function readModuleList() {
  const loader = fs.readFileSync(LOADER, 'utf8');
  const paths = [];
  const re = /'(js\/modules\/[^']+|sonic-[^']+\.js)'/g;
  let m;
  while ((m = re.exec(loader)) !== null) paths.push(m[1]);
  return paths;
}

function buildBundle() {
  return readModuleList()
    .map((p) => fs.readFileSync(path.join(ROOT, 'public', p), 'utf8'))
    .join('');
}

// WebGL 上下文 / 渲染器这类第三方对象的方法面很大，逐个补方法会让守卫退化成
// "Three.js API 覆盖率测试"。这个可链式空壳兜住它们：任何方法调用返回 undefined，
// 任何属性读取再给一个同样可链式的空壳，守卫只负责发现**我们自己代码**的异常。
// The WebGL context / renderer surface is huge; stubbing method by method would turn this
// guard into a Three.js API coverage test. This chainable shell absorbs them: any method
// call returns undefined and any property read yields another chainable shell, so the
// guard stays focused on failures in *our* code.
function makeChainable(name) {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === 'valueOf') return () => 0;
      if (prop === 'toString') return () => '';
      if (prop === Symbol.iterator || prop === 'then') return undefined;
      if (typeof prop === 'string' && /^(is|get|has)[A-Z]/.test(prop)) return () => false;
      return makeChainable(prop);
    },
    apply() { return makeChainable(name); },
  });
}

// 最小 DOM：只实现模块在顶层真正会碰到的那几件事。
// Minimal DOM: implements only what modules actually touch at the top level.
function makeStubElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    id: '',
    style: {
      setProperty() {},
      removeProperty() {},
      getPropertyValue() { return ''; },
    },
    dataset: {},
    children: [],
    hidden: false,
    _attrs: {},
    textContent: '',
    innerHTML: '',
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => el.classList._set.add(x)); },
      remove(...c) { c.forEach((x) => el.classList._set.delete(x)); },
      contains(c) { return el.classList._set.has(c); },
      toggle(c) { el.classList._set.has(c) ? el.classList._set.delete(c) : el.classList._set.add(c); },
    },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k); },
    appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    insertBefore(child) { el.children.push(child); child.parentNode = el; return child; },
    remove() {},
    getContext() { return makeChainable('ctx'); },
    toDataURL() { return 'data:image/png;base64,'; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    focus() {},
    blur() {},
    click() {},
    focus() {},
  };
  el.parentNode = null;
  return el;
}

function makeStubDom() {
  const body = makeStubElement('body');
  const head = makeStubElement('head');
  const byId = new Map();
  // 顶层代码普遍 getElementById(...).classList.add(...)，给一个不会崩的元素即可。
  // Top-level code commonly does getElementById(...).classList.add(...); a stable stub
  // element is enough to keep that from throwing for unrelated reasons.
  const document = {
    readyState: 'loading',
    body,
    head,
    documentElement: makeStubElement('html'),
    cookie: '',
    referrer: '',
    hidden: false,
    visibilityState: 'visible',
    title: 'Mineradio',
    fonts: { ready: Promise.resolve(), addEventListener() {}, check: () => true },
    createElement: (tag) => makeStubElement(tag),
    createElementNS: (_ns, tag) => makeStubElement(tag),
    createTextNode: (t) => ({ nodeValue: t, textContent: t }),
    createDocumentFragment: () => makeStubElement('fragment'),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeStubElement('div'));
      return byId.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  };
  body.ownerDocument = document;
  return { document, byId };
}

// 把注释与字符串字面量替换成等长空白，**保留偏移量**，这样后面按行号定位不会错位。
// 用逐字符扫描而不是正则：正则处理撇号/转义/模板串会跑飞，一次就把后面整段代码
// 连同它所在的 function 声明吃掉，判据于是误报"漏定义"（曾一次报 3387 条）。
// 字符串里必须一起清掉的是 GLSL 着色器源码——mod289/perm/snoise/vec4 之类
// 长得像函数调用，会把守卫淹在假警报里。
//
// Blanks out comments and string literals in place, preserving offsets so line-based
// locations stay accurate. A hand-rolled scanner rather than regex: regexes go haywire on
// apostrophes, escapes and template literals, eating the following function declarations
// and producing thousands of phantom hits. Strings must go too because GLSL shader source
// is full of things that look exactly like function calls (mod289, perm, snoise, vec4).
function blankCommentsAndStrings(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // 行注释
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    // 块注释
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    // 字符串 / 模板串
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // 正则字面量：/^backgroundMedia(CropX|…)$/ 这类里全是长得像调用的名字
    // （qq、sonic、backgroundMedia），不清掉会把守卫淹在假警报里。
    // 判断依据是"前一个非空白字符是表达式起始位置"，这是 JS 里区分 / 除法的标准启发式。
    // Regex literals: /^backgroundMedia(CropX|…)$/ is full of call-shaped names (qq, sonic,
    // backgroundMedia). The test is "previous non-space char starts an expression", the
    // standard heuristic for telling regex division apart in JS.
    if (c === '/') {
      const before = src.slice(0, i).replace(/\s+$/, '');
      const lastCh = before[before.length - 1] || '';
      const startsExpr = !lastCh
        || '(,=:[!&|?{};+-*%~^<>'.includes(lastCh)
        || /\b(?:return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/.test(before);
      if (startsExpr) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) { j += 1; closed = true; break; }
          j += 1;
        }
        if (closed) {
          while (j < n && /[gimsuyvd]/.test(src[j])) j += 1;
          blank(i, j);
          i = j;
          continue;
        }
      }
    }
    i += 1;
  }
  return out.join('');
}

test('the loader module list is intact and every module file exists', () => {
  const paths = readModuleList();
  assert.ok(paths.length > 50, `模块清单异常，只有 ${paths.length} 个`);
  for (const p of paths) {
    const file = path.join(ROOT, 'public', p);
    assert.ok(fs.existsSync(file), `模块文件不存在：${p}`);
  }
});


test('a module never calls a bare helper that no module in the bundle defines', () => {
  // index-loader 把所有模块拼成一个 script，作用域是共享的：某个模块少定义一个函数，
  // 抛错会从它自己的位置冒出来，但后果由它后面的所有模块承担。之前 13-i18n.js 调了
  // 从未定义的 pick()，黑屏就是 bundle 第 2 行抛错、另外 112 个模块没跑。
  // Since all modules share one scope, the reference set is the union of every module's
  // definitions — that still catches pick() while accepting legitimate cross-module
  // globals like showToast() / readCustomCoverMap().
  const GLOBALS = new Set([
    'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'Promise', 'RegExp',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Error', 'TypeError', 'Proxy', 'Reflect',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
    'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
    'queueMicrotask', 'fetch', 'structuredClone', 'setImmediate', 'clearImmediate',
    'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
    'Int32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'TextEncoder',
    'TextDecoder', 'Blob', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
    'Image', 'Audio', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'WheelEvent',
    'PointerEvent', 'TouchEvent', 'DragEvent', 'ClipboardEvent', 'MutationObserver',
    'IntersectionObserver', 'ResizeObserver', 'PerformanceObserver', 'IntersectionObserverEntry',
    'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelIdleCallback',
    'eval', 'parseInt', 'console', 'alert', 'confirm', 'prompt', 'globalThis', 'undefined',
    'NaN', 'Infinity', 'window', 'document', 'navigator', 'location', 'history', 'screen',
    'localStorage', 'sessionStorage', 'performance', 'crypto', 'speechSynthesis',
    'ResizeObserver', 'IntersectionObserver', 'Function', 'WeakRef', 'FinalizationRegistry',
    // Promise / 迭代器的标准回调形参：new Promise((resolve, reject) => …) 里的 reject
    // 是形参，不是漏定义的全局。
    'resolve', 'reject', 'done', 'next', 'throw', 'iterator', 'step', 'sent', 'value',
    // 浏览器全局
    'btoa', 'atob', 'fetch', 'reportError', 'queueMicrotask', 'structuredClone',
    'requestIdleCallback', 'cancelIdleCallback', 'createImageBitmap', 'OffscreenCanvas',
    'matchMedia', 'scrollTo', 'scrollBy', 'getSelection', 'find', 'print', 'open', 'close',
    'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'blur', 'focus',
  ]);
  // 语法关键字与不可能是"漏定义"的形态。
  const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'delete',
    'void', 'in', 'of', 'await', 'yield', 'super', 'this', 'class', 'extends', 'case', 'do',
    'else', 'try', 'finally', 'throw', 'instanceof', 'with', 'debugger', 'export', 'import',
  ]);

  const paths = readModuleList();
  const sources = paths.map((p) => {
    const raw = fs.readFileSync(path.join(ROOT, 'public', p), 'utf8');
    return { p, code: blankCommentsAndStrings(raw) };
  });

  // bundle 共享作用域：所有模块定义过的名字都算数。
  // Shared bundle scope: a name defined by any module counts as defined.
  const definedAnywhere = new Set(GLOBALS);
  for (const { code } of sources) {
    for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) definedAnywhere.add(m[1]);
    for (const m of code.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)) definedAnywhere.add(m[1]);
    for (const m of code.matchAll(/(?:var|let|const)\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const n = part.split(':').pop().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) definedAnywhere.add(n);
      }
    }
    for (const m of code.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) definedAnywhere.add(m[1]);
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:function|\()/g)) definedAnywhere.add(m[1]);
    // 形参也是"已定义"：回调里的 fn() / reject() / skipRecord() 是参数，不是漏掉的全局。
    // Parameters count as defined too: a callback's fn() / reject() / skipRecord() is a
    // parameter, not a missing global. Without this every promise callback looks undefined.
    for (const m of code.matchAll(/function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
      for (const part of m[1].split(',')) {
        const n = part.replace(/=.*$/, '').replace(/^\s*\.\.\./, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) definedAnywhere.add(n);
      }
    }
    for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of m[1].split(',')) {
        const n = part.replace(/=.*$/, '').replace(/^\s*\.\.\./, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) definedAnywhere.add(n);
      }
    }
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) definedAnywhere.add(m[1]);
    // 解构形参：catch ({ code, message }) / ({ a, b }) => …
    for (const m of code.matchAll(/\(\s*\{([^}]*)\}\s*\)\s*=>/g)) {
      for (const part of m[1].split(',')) {
        const n = part.split(/[:=]/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) definedAnywhere.add(n);
      }
    }
    for (const m of code.matchAll(/catch\s*\(\s*\{([^}]*)\}\s*\)/g)) {
      for (const part of m[1].split(',')) {
        const n = part.split(/[:=]/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) definedAnywhere.add(n);
      }
    }
    // 工厂函数形参：listeners.factory(fn, …)
    for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/g)) {
      void m;
    }
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*function\s*\(([^)]*)\)/g)) {
      for (const part of m[3].split(',')) {
        const n = part.replace(/=.*$/, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) definedAnywhere.add(n);
      }
    }
    // UMD 包装：}(this, function (root, factory) { … module.exports = factory(); …
    // factory 是形参，root 是形参。
    for (const m of code.matchAll(/function\s*\(\s*root\s*,\s*factory\s*\)/g)) {
      definedAnywhere.add('root');
      definedAnywhere.add('factory');
    }
    for (const m of code.matchAll(/function\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g)) {
      definedAnywhere.add(m[1]);
      definedAnywhere.add(m[2]);
    }
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/g)) {
      void m;
    }
    // 通用：点号调用里紧跟的第一个裸标识符多半是形参（fn / factory / callback …）。
    for (const m of code.matchAll(/\.\s*[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\))/g)) {
      definedAnywhere.add(m[1]);
    }
    // catch (e) / for (const x of …) 这类绑定
    for (const m of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) definedAnywhere.add(m[1]);
  }

  const problems = [];
  for (const { p, code } of sources) {
    // 裸调用：前一个字符不是 . （排除链式方法），也不是 function/new 的一部分。
    for (const m of code.matchAll(/(^|[^\w$.])([a-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (KEYWORDS.has(name)) continue;
      if (definedAnywhere.has(name)) continue;
      // 形如 obj.foo( / this.foo( 已被上面的 [^\w$.] 排除；剩下的裸调用再排掉
      // "方法名风格" 的误报：get*/set*/is*/has* 等通常是链式结果上的调用。
      if (/^(get|set|is|has|enable|disable)[A-Z]/.test(name)) continue;
      problems.push(`${p}: ${name}()`);
    }
  }
  assert.deepStrictEqual(
    problems,
    [],
    '这些裸函数名在整个 bundle 里都没有定义。它们一旦被调用就会抛错，'
    + '而 index-loader 把所有模块拼成一个 script，后面的模块（含 splash 揭幕与主循环）'
    + '都不会执行，表现为只剩外壳的黑屏：\n' + problems.slice(0, 40).join('\n')
  );
});

test('the i18n dictionary accessor used by t() actually exists', () => {
  // pick() 曾被调用但从未定义，而 13-i18n.js 是 bundle 的第一个模块：它一抛错，
  // 后面 112 个模块全部不执行。这里钉住「用了就必须有定义」。
  // pick() was called but never defined, and 13-i18n.js is the bundle's first module: one
  // throw there skips the other 112. This pins "if it is called, it must be defined".
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/00-state/13-i18n.js'), 'utf8');
  const called = new Set();
  const re = /\b(pick|normalizeLang|loadLocale|applyToElement)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) called.add(m[1]);
  for (const name of called) {
    const defined = new RegExp(`function ${name}\\s*\\(`).test(src)
      || new RegExp(`(?:var|let|const)\\s+${name}\\s*=`).test(src);
    assert.ok(defined, `13-i18n.js 调用了 ${name}() 却没有定义它`);
  }
});

test('DOM built from an i18n HTML string never appends into a possibly-null node', () => {
  // 词典未就绪时 fx_panel_tabs_html 会退化成键名，querySelector 拿不到壳节点，
  // 直接 .appendChild() 就抛错；index-loader 把所有模块拼成一个 script，
  // 这一行抛错会把后面 18 个模块（含 splash 揭幕与主循环）一起吃掉 —— 表现就是黑屏。
  // 这里扫**整个模块**（不只 fxConsoleMakeToolbar）：只扫一个函数曾在变异测试里漏判，
  // 守卫必须覆盖所有 querySelector 结果被直接 appendChild 的写法。
  // Before the dictionary resolves, fx_panel_tabs_html degrades to its own key, so the
  // shell node is missing and a bare appendChild throws — which eats every later module.
  // Scan the WHOLE module: scanning a single function let a mutation slip through.
  const rel = 'js/modules/07-fx/09-console-workspace.js';
  const body = blankCommentsAndStrings(fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8'));

  const declRe = /(?:var|let|const)\s+(\w+)\s*=\s*[\w.]+\.querySelector\(/g;
  const violations = [];
  let m;
  while ((m = declRe.exec(body)) !== null) {
    const name = m[1];
    // 窗口要够大：声明和 appendChild 之间可能夹着整段注释（原文件里就有 7 行），
    // 窗口太窄会让判据"看不见"真正的 appendChild，从而放行一个已经回归的写法。
    // 兜底判据只在 appendChild **之前**的那段文本里找。
    // The window must be generous: a long comment block can sit between the declaration
    // and the appendChild (the original file had seven lines), and too narrow a window
    // hides the appendChild from the check, letting a regression slip through.
    const window = 4000;
    const tail = body.slice(m.index, m.index + window);
    const appendRe = new RegExp('\\b' + name + '\\s*\\.appendChild\\(');
    const appendAt = tail.search(appendRe);
    if (appendAt < 0) continue;
    const between = tail.slice(0, appendAt);
    const guarded = new RegExp('if\\s*\\(\\s*!' + name + '\\s*\\)').test(between)
      || new RegExp(name + '\\s*\\|\\|').test(between)
      || new RegExp('if\\s*\\(\\s*' + name + '\\s*\\)').test(between);
    if (!guarded) violations.push(rel + ': ' + name + '（querySelector 结果未兜空值就 appendChild）');
  }
  assert.deepStrictEqual(
    violations,
    [],
    'querySelector 结果未兜空值就 appendChild，词典未就绪时抛错会吃掉后续模块：\n' + violations.join('\n')
  );
  assert.ok(declRe.test(body), '判据没匹配到任何 querySelector，模块结构可能变了，守卫需重新对齐');
});

test('a panel built from i18n text repaints when the dictionary becomes ready', () => {
  // 词典异步加载，而 bindFxPanel() 在解析期同步跑 —— 首屏面板里的文案全是键名
  // （实测 32 个：hotkey_hotkey / fx_preset_hint / fx_cat_ui_colorfx_ui_color_hint …）。
  // 修法是订阅 onLanguageChange 把面板重建。这里钉住"订阅还在"，否则键名会一直留在界面上。
  // The dictionary loads asynchronously while bindFxPanel() runs synchronously during
  // parse, so the first paint is all key names (measured: 32 of them). The fix is to
  // subscribe to onLanguageChange and rebuild. Pin the subscription so keys can't return.
  const rel = 'js/modules/07-fx/09-console-workspace.js';
  const src = fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');

  assert.ok(
    /onLanguageChange/.test(src),
    `${rel} 不再订阅 onLanguageChange，词典就绪后视觉控制台会一直显示键名`
  );
  // 订阅回调必须真的触发重贴，不能只是空订阅。
  assert.ok(
    /onLanguageChange\s*\(\s*function\s*\(\)\s*\{\s*relabelFxConsoleWorkspace\(\)/.test(src),
    `${rel} 的 onLanguageChange 回调没有调用 relabelFxConsoleWorkspace()，订阅形同虚设`
  );
  // 重贴函数本身必须存在。
  assert.ok(
    /function relabelFxConsoleWorkspace\s*\(/.test(src),
    `${rel} 缺少 relabelFxConsoleWorkspace()，无法重贴`
  );
  // 重建必须先清掉幂等标记，否则 organizeFxConsoleWorkspace() 会早退、什么也不重贴。
  assert.ok(
    /relabelFxConsoleWorkspace[\s\S]{0,600}?_fxConsoleWorkspaceOrganized\s*=\s*false/.test(src),
    'relabelFxConsoleWorkspace() 没有清除 _fxConsoleWorkspaceOrganized 幂等标记，'
    + 'organizeFxConsoleWorkspace() 会早退，重建等于没做'
  );
  // registry 存的是已求值文案，重贴必须走重建而不是只改 registry。
  assert.ok(
    /relabelFxConsoleWorkspace[\s\S]{0,900}?organizeFxConsoleWorkspace\(\)/.test(src),
    'relabelFxConsoleWorkspace() 没有调用 organizeFxConsoleWorkspace()，'
    + 'fxConsoleRegistry 里已求值的键名不会被换掉'
  );
  // 兜底重建不能把面板搞崩：包一层 try。
  // 注意 `organizeFxConsoleWorkspace();` 后面是分号再换行，不能用 `\s*\}\s*catch` 这种
  // 要求紧挨着的写法（曾因此误报"没有 try/catch"）。
  // The call ends with a semicolon before the newline, so a pattern demanding `}` right
  // after `)` reports a false negative — that happened once.
  assert.ok(
    /try\s*\{[\s\S]{0,160}?organizeFxConsoleWorkspace\(\)[\s\S]{0,160}?\}\s*catch/.test(src),
    '重建没有 try/catch 保护，重贴失败会抛到调用方'
  );
});

test('the visual console no longer ships the search / undo / history toolbar', () => {
  // 工具栏（搜索框 / 撤销 / 历史）已整体移除：撤销默认 disabled、历史浮层长期为空，
  // 搜索框几乎不用，却要各自维护浮层与事件绑定，还每次重贴都得跟着重建。
  // 面板现在从分类标签页开始。
  // The toolbar is gone: undo shipped disabled, the history popover stayed empty, the
  // search box barely got used — yet each needed its own popover, event bindings and a
  // rebuild on every repaint. The panel now starts at the category tabs.
  const rel = 'js/modules/07-fx/09-console-workspace.js';
  const src = fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');
  const buildStart = src.indexOf('function fxConsoleMakeToolbar(');
  assert.ok(buildStart >= 0, '找不到 fxConsoleMakeToolbar');
  const buildEnd = src.indexOf('\nfunction ', buildStart + 10);
  const build = src.slice(buildStart, buildEnd < 0 ? src.length : buildEnd);

  // 工具栏的 innerHTML 只能拼分类标签页，不能再有搜索/撤销/历史。
  for (const gone of ['fx_search_input_html', 'fx_undo_btn_html', 'fx_history_btn_html',
    'fx-console-search-row', 'fx-console-search-results', 'fx-console-history']) {
    assert.ok(
      build.indexOf(gone) < 0,
      `fxConsoleMakeToolbar() 里又出现了 ${gone}，工具栏不该被恢复`
    );
  }
  // 仍必须保留分类标签页，否则整个面板没有入口。
  assert.ok(build.includes('fx_panel_tabs_html'), '工具栏移除后必须保留分类标签页');

  // 关键：滑块拖拽事务的绑定不能因为搜索框消失而早退。
  // 这才是真正要防的回归 —— 早退条件里带着已删除的搜索框，会把下面所有事务监听
  // 一起跳过，拖动滑块将不再产生快照。closeFxConsolePopovers() 里那些
  // getElementById('fx-console-search') 只是判空取值（元素没了返回 null），无害，不在此列。
  // The regression that matters is the early-return guard: a guard that still required the
  // removed search box would skip every transaction listener below. The
  // getElementById('fx-console-search') reads inside closeFxConsolePopovers are harmless
  // null-guarded lookups, so they are deliberately not policed here.
  assert.ok(
    /function initFxConsoleSearchAndHistory\(\)\s*\{\s*var panel = document\.getElementById\('fx-panel'\);\s*\n\s*if \(!panel \|\| panel\._fxConsoleSearchHistoryBound\) return;/.test(src),
    'initFxConsoleSearchAndHistory 的早退守卫必须只判 panel；'
    + '若又带上已删除的搜索框，滑块拖拽事务（fxConsoleBeginRangeTxn）将不再绑定'
  );
  assert.ok(src.includes('fxConsoleBeginRangeTxn'), '滑块拖拽事务绑定被误删');
});

test('a rebuild clears stale nodes instead of stacking a second copy', () => {
  // 旧代码在清理 oldRoots 时排除了 .fx-tab-page，本意是"别误删本轮新建的 page"，
  // 但新旧 page 同 id 同类，根本区分不开 —— 结果是**每次重建都把上一轮的 6 个 tab page
  // 留在原地**，重贴一次翻一倍（实测 fx-console-page-* 各出现两次，内容重复且键名残留）。
  // oldRoots 是创建新节点**之前**拍的快照，所以里面每一项都必然是旧节点，直接删即可。
  //
  // The old cleanup excluded .fx-tab-page to "avoid deleting this run's new pages", but new
  // and old pages share id and class, so it could not tell them apart — every rebuild left
  // the previous run's six tab pages behind, doubling the panel on each repaint. oldRoots is
  // a snapshot taken before any new node exists, so everything in it is stale by definition.
  const rel = 'js/modules/07-fx/09-console-workspace.js';
  const src = fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');

  const cleanup = src.match(/oldRoots\.forEach\(function \(node\) \{[\s\S]{0,400}?\}\);/);
  assert.ok(cleanup, '找不到 oldRoots 的清理逻辑');
  const body = cleanup[0];
  assert.ok(
    !/classList\.contains\(\s*['"]fx-tab-page['"]\s*\)/.test(body),
    'oldRoots 清理又把 .fx-tab-page 排除了：新旧 page 同类，无法区分，'
    + '会导致每次重建都留下一份旧的 tab page（面板内容翻倍）'
  );
  assert.ok(
    /node\.remove\(\)/.test(body),
    'oldRoots 清理没有真正 remove 节点'
  );
});

test('the console title row and its old .fx-head mount point are both gone', () => {
  // 标题行（视觉控制台 / MINERADIO VISUALS · …）已删：面板内已有分类标签页，标题是重复信息。
  // .fx-head 挂载点也已随之删除 —— 它唯一的作用是承载 #hotkey-settings-btn，
  // 而该按钮现在直接静态声明在标题栏里（「?」与「DIY」之间），不再需要运行时挂载点。
  // The title row is gone, and so is the .fx-head mount point: its only purpose was hosting
  // #hotkey-settings-btn, which is now declared statically in the title bar instead.
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const hotkeys = fs.readFileSync(path.join(ROOT, 'public/js/modules/07-fx/06-hotkeys.js'), 'utf8');

  // 标题与副标题不得复活。判据必须按 data-i18n 键收窄，不能按 .fx-title 类名 ——
  // 歌单面板复用了同一套类名（queue_title / queue_sub），按类名判会误伤。
  // The title and subtitle must not come back. Match on the i18n key, not the class name:
  // the playlist panel reuses .fx-title / .fx-sub (queue_title / queue_sub).
  assert.ok(!/data-i18n="visual_console"/.test(html), '控制台标题 data-i18n="visual_console" 不该回来');
  assert.ok(!/data-i18n="visual_console_sub"/.test(html), '控制台副标题 data-i18n="visual_console_sub" 不该回来');
  assert.ok(
    !/class="fx-title"[^>]*data-i18n="visual_console"/.test(html),
    '控制台 .fx-title 元素不该回来'
  );
  // 挂载点已无用途，不该复活。
  assert.ok(
    !/<div class="fx-head"/.test(html),
    '.fx-head 挂载点不该回来（#hotkey-settings-btn 已静态声明在标题栏，不再需要它）'
  );
  assert.ok(
    !/querySelector\('\.fx-head'\)/.test(hotkeys),
    'ensureHotkeySettingsButton() 不该再找 .fx-head —— 按钮已静态声明，它只该负责重贴'
  );
  // 按钮本体必须静态存在于标题栏，且排在 DIY 左边。
  // The button must exist statically in the title bar, positioned left of DIY.
  const btnMatch = /<button id="hotkey-settings-btn"[\s\S]{0,400}?>/.exec(html);
  assert.ok(btnMatch, '标题栏里缺少 #hotkey-settings-btn（应静态声明，不要运行时创建）');
  const btnAt = btnMatch.index;
  const diyAt = html.indexOf('id="diy-mode-btn"');
  assert.ok(diyAt > 0, '标题栏里找不到 #diy-mode-btn');
  assert.ok(btnAt < diyAt, '热键按钮必须排在 DIY 左边（? / 热键 / DIY）');
  // 引导按钮在最左。
  const guideAt = html.indexOf('id="visual-guide-btn"');
  assert.ok(guideAt > 0 && guideAt < btnAt, '引导按钮 ? 应排在热键按钮左边（? / 热键 / DIY）');
  // 静态按钮自带 onclick，不再由 JS 挂事件。
  assert.ok(
    /id="hotkey-settings-btn"[\s\S]{0,400}?onclick="openHotkeySettings\(\)"/.test(html),
    '#hotkey-settings-btn 应在 HTML 上直接绑定 onclick'
  );
  // 文案仍需在语言就绪后重贴：静态 HTML 里写死的是中文，词典没到时 t() 会返回键名。
  // The static label still needs a repaint: the HTML default is Chinese, and a missing
  // dictionary entry makes t() return the key instead.
  assert.ok(
    /function relabelHotkeySettingsButton\s*\(/.test(hotkeys)
      && /onLanguageChange[\s\S]{0,400}?relabelHotkeySettingsButton\(\)/.test(hotkeys),
    '快捷键按钮没有订阅 onLanguageChange 重贴文案，界面上会一直显示 hotkey_hotkey 键名'
  );
  assert.ok(
    !/createElement\([^)]*\)[^;]*hotkey-settings-btn/.test(hotkeys),
    'ensureHotkeySettingsButton() 不该再运行时创建这个按钮（已静态声明）'
  );
  // ⚠️ 绝不能把它登记进控制台 registry：登记等于声明"这是面板内控件"，
  // 重建会把它搬进某个 tab page，标题栏就少了这个按钮。
  // 排除项（closest('.fx-console-toolbar') 之类）挡不住 —— 它根本不在 panel 里。
  // It must NOT be registered into the console registry: an entry declares it a panel
  // control, so the rebuild moves it into a tab page and the title bar loses the button.
  // Exclusions cannot help — the node is not inside the panel at all.
  const consoleWs = fs.readFileSync(path.join(ROOT, 'public/js/modules/07-fx/09-console-workspace.js'), 'utf8');
  assert.ok(
    !/getElementById\('hotkey-settings-btn'\)/.test(consoleWs),
    '控制台不该再取 #hotkey-settings-btn —— 它已移到标题栏，登记会把按钮搬进面板'
  );
  assert.ok(
    !/function fxConsoleRegisterHotkeySearchEntry/.test(consoleWs),
    'fxConsoleRegisterHotkeySearchEntry 应随按钮迁移一起删除'
  );
});

test('no module-level constant freezes i18n text at parse time', () => {
  // 顶层 `var X = [ ...xxxText('key')... ]` 在解析期就求值，而词典要等 DOMContentLoaded
  // 才异步加载完 —— 取到的是键名本身，并且**永久固化在数据里**。之后无论重建多少次 DOM
  // 都不会变，因为坏的是数据源、不是显示层。
  // 实测踩过两次：FX_CONSOLE_LAYOUT（6 个分组标题）与 FX_CONSOLE_TABS（6 个标签页）。
  //
  // A top-level `var X = [ ...xxxText('key')... ]` is evaluated during parse, but the
  // dictionary only finishes loading asynchronously at DOMContentLoaded, so it resolves to the
  // key itself and bakes that into the data permanently — no DOM rebuild can fix it afterwards,
  // because the data source, not the view, is stale. Bitten twice: FX_CONSOLE_LAYOUT (six group
  // headings) and FX_CONSOLE_TABS (six category tabs).
  // 判据用**模式**匹配而不是枚举函数名。枚举是我自己的第一个版本犯的错：
  // 名单里漏了 guideText()，`visualGuideSteps` 这个顶层常量就把键名冻住了，
  // 守卫却报绿。取词包装函数在各模块里叫什么没有规律（xxxText / hotkeysText /
  // guideText / customSourceText …），只能按"名字以 Text 结尾 + 在调用处带一个键名参数"来认。
  // Match by PATTERN, not by an enumerated list of function names. Enumerating was the mistake
  // in my own first version: the list missed guideText(), so the module-level
  // `visualGuideSteps` constant froze its key names while the guard stayed green. The wrappers
  // have no naming regularity (xxxText / hotkeysText / guideText / customSourceText …), so
  // they can only be recognised by shape: a `*Text` name called with a quoted key literal.
  const CALL = /\b([A-Za-z_$][\w$]*Text)\s*\(\s*'([^']+)'/;

  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'public/js/modules'));

  const violations = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let depth = 0;
    let start = -1;
    let inTopBlock = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!inTopBlock) {
        const m = /^(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[[{]/.exec(line);
        if (!m) continue;
        start = i;
        // ⚠️ 单行对象/数组（`var x = { a: 1 };`）在同一行就把 depth 抵消回 0。
        // 若沿用旧写法 `if (depth <= 0 && i > start)`，这里的 i === start 恒不成立，
        // inTopBlock 永远不会复位，块会一路"延伸"到后面几个函数头上 ——
        // 我因此把 controlSourceProviders()（一个**函数**）误判成违规。
        //
        // A single-line object/array nets depth back to 0 on the very same line, so the old
        // `i > start` guard never released the block and it kept spanning the functions that
        // followed — which made me flag controlSourceProviders(), a plain function, as a
        // violation. The block now ends wherever depth returns to 0, same line included.
        depth = (line.match(/[[{]/g) || []).length - (line.match(/[\]}]/g) || []).length;
        if (depth <= 0) continue;          // 单行闭合，块已结束
        inTopBlock = true;
        continue;
      }
      depth += (line.match(/[[{]/g) || []).length - (line.match(/[\]}]/g) || []).length;
      const hit = CALL.exec(line) || /\.t\(\s*'([^']+)'/.exec(line);
      if (hit) {
        violations.push(
          path.relative(ROOT, f) + ':' + (i + 1)
          + '  顶层常量里调用了取词函数（键 "' + hit[hit.length - 1] + '" 会被永久固化成键名）',
        );
      }
      if (depth <= 0) inTopBlock = false;
    }
  }
  assert.deepStrictEqual(
    violations,
    [],
    '这些顶层常量在解析期就调用了取词函数，词典的异步加载来不及，'
    + '键名会被永久固化，重贴也救不回来（数据源坏了，不是显示层）：\n' + violations.join('\n')
  );
});

test('no two modules define the same top-level function name', () => {
  // index-loader 把所有模块拼成一个共享作用域的 script，**后声明的函数会覆盖先声明的**。
  // 我把一个顶层常量改成函数 playbackQualityOptions() 时，00-api-quality-output.js 里早就
  // 有个同名函数 playbackQualityOptions(provider) —— 后者覆盖前者，而它内部又调用
  // playbackQualityOptions()，于是无限递归，运行时直接 "Maximum call stack size exceeded"。
  // 静态测试全绿，只有真跑起来才炸。
  //
  // index-loader concatenates every module into one shared-scope script, so a later
  // declaration silently overwrites an earlier one. Renaming a constant to
  // playbackQualityOptions() collided with an existing playbackQualityOptions(provider) in
  // another module; the survivor then called itself, recursing until the stack blew. Every
  // static test stayed green — only running the app exposed it.
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'public/js/modules'));

  const seen = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      if (!seen.has(m[1])) seen.set(m[1], new Set());
      seen.get(m[1]).add(path.relative(ROOT, f));
    }
  }
  // 同一文件里重复声明是分支写法，不算冲突；只报**跨文件**重名。
  // Repeating a name inside one file is a branch-style redeclaration, not a collision; only
  // cross-file duplicates matter here.
  const clashes = [];
  for (const [name, where] of seen) {
    if (where.size > 1) clashes.push(name + '  ->  ' + [...where].join('  |  '));
  }
  assert.deepStrictEqual(
    clashes,
    [],
    '这些函数名在多个模块里各有一份。共享作用域下后者会覆盖前者，'
    + '若两者互相调用就会无限递归（Maximum call stack size exceeded），且静态测试不会报警：\n'
    + clashes.join('\n')
  );
});

test('the guide highlight ring is gone and its card still positions', () => {
  // 用户反馈"点开后的发光框又难看又框不准模块"。环本身带红色光晕、循环扫描线，
  // 基础尺寸写死 80×48 再按目标缩放，尺寸不一的模块上对不准。
  // 删除时踩过一个坑：positionVisualGuideStep() 的早退守卫里还留着 ring，
  // 环没了会导致**整个函数早退**，卡片位置与遮罩焦点都不再更新 —— 功能静默失效。
  // The ring is gone. But positionVisualGuideStep()'s early-return guard used to include it;
  // with the element removed the whole function bailed out, so the card was never positioned
  // and the scrim focus never updated — a silent functional regression.
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/css/index.css'), 'utf8');
  const guide = fs.readFileSync(path.join(ROOT, 'public/js/modules/09-idle-toast-libraries.js'), 'utf8');

  assert.ok(!/id="visual-guide-ring"/.test(html), '#visual-guide-ring 不该回来');
  assert.ok(!/visual-guide-ring/.test(css), '.visual-guide-ring 的 CSS 不该回来');
  assert.ok(!/visual-guide-scan/.test(css), '扫描线动画 @keyframes visual-guide-scan 不该回来');
  // 引导步骤与卡片必须保留。
  assert.ok(/id="visual-guide-card"/.test(html), '步骤说明卡片必须保留');
  assert.ok(/function fxGuideSteps\(\)/.test(guide), '引导步骤应改成函数（否则键名会被解析期固化）');
  assert.ok(/function fxGuideStepsDiy\(\)/.test(guide), 'DIY 版引导步骤同样应改成函数');
  // 早退守卫不得再包含 ring。取函数开头到第一次给 scrim 定位为止，足够覆盖守卫。
  // The guard is covered by the head of the function, up to the scrim positioning.
  const posStart = guide.indexOf('function positionVisualGuideStep()');
  assert.ok(posStart >= 0, '找不到 positionVisualGuideStep()');
  const posHead = guide.slice(posStart, guide.indexOf('var scrim', posStart));
  assert.ok(
    posHead.length > 0 && posHead.length < 800,
    'positionVisualGuideStep() 的结构变了，守卫需要重新对齐'
  );
  assert.ok(
    !/visual-guide-ring/.test(posHead),
    'positionVisualGuideStep() 的早退守卫里不该再出现 visual-guide-ring —— '
    + '环已删除，留着会让整个函数早退，卡片永远不定位'
  );
  assert.ok(
    /if \(!guide \|\| !card\) return;/.test(posHead),
    'positionVisualGuideStep() 的早退守卫应只判 guide 与 card'
  );
  assert.ok(!/var visualGuideSteps\b/.test(guide), 'visualGuideSteps 顶层常量会把键名冻住');
});

test('a dialog assembled from i18n strings always keeps a close control', () => {
  // 热键弹窗的结构（外壳/标题/关闭键/页签/提示）是 hotkeysText() 拼出来的，而词典异步加载。
  // ensureHotkeyModal() 原本只跑一次，词典没就绪时 hotkeysText() 返回键名并固化进 innerHTML。
  // 后果特别隐蔽：**hotkey_close_btn 本身就是一段 HTML 字符串**，缺键时只剩纯文本，
  // 于是关闭按钮根本不渲染 —— 弹窗只剩 Esc 能关（实测 closeBtnExists:false）。
  //
  // The dialog shell is assembled from hotkeysText() output while the dictionary loads
  // asynchronously, and ensureHotkeyModal() ran exactly once. With no dictionary the calls
  // returned key names baked into innerHTML. The nasty part: hotkey_close_btn *is* an HTML
  // string, so a missing key left plain text and the close button never rendered — the dialog
  // could only be dismissed with Esc (measured: closeBtnExists false).
  const rel = 'js/modules/07-fx/06-hotkeys.js';
  const src = fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');

  // 外壳必须来自函数（每次打开重建），不能是创建时固化的一次性字符串。
  assert.ok(
    /function hotkeyDialogShell\(\)/.test(src),
    `${rel} 缺少 hotkeyDialogShell()：弹窗外壳会被创建时的键名永久固化`
  );
  const shellStart = src.indexOf('function hotkeyDialogShell()');
  const shell = src.slice(shellStart, src.indexOf('\n}', shellStart));
  assert.ok(
    /hotkey_dialog_open|hotkeysText\('hotkey_dialog_open'\)/.test(shell),
    'hotkeyDialogShell() 里应拼出弹窗外壳'
  );
  assert.ok(
    /hotkey_close_btn/.test(shell),
    'hotkeyDialogShell() 里必须包含关闭键，否则关闭按钮无从谈起'
  );

  // 打开时必须重建外壳。
  const openStart = src.indexOf('function openHotkeySettings()');
  assert.ok(openStart >= 0, '找不到 openHotkeySettings()');
  const openHead = src.slice(openStart, src.indexOf('function closeHotkeySettings', openStart));
  assert.ok(
    /refreshHotkeyModalShell\(\)/.test(openHead),
    'openHotkeySettings() 必须调用 refreshHotkeyModalShell()，'
    + '否则首次打开时词典往往还没就绪，弹窗里全是键名'
  );

  // ⚠️ 兜底：即使词典永远拿不到关闭键文案，按钮也必须存在。
  // 用户不能只剩 Esc 一条路。缺键时插入一份硬编码的关闭按钮。
  assert.ok(
    /HOTKEY_CLOSE_FALLBACK/.test(src) && /data-hotkey-close/.test(src),
    `${rel} 缺少关闭按钮兜底：词典缺键时关闭按钮会整个消失`
  );
  // 两处重建路径都要兜底（创建时 + 重建时），否则重建后又没了。
  const fallbacks = (src.match(/HOTKEY_CLOSE_FALLBACK/g) || []).length;
  assert.ok(
    fallbacks >= 3,
    `关闭按钮兜底只出现 ${fallbacks} 次；应覆盖定义 + ensureHotkeyModal + refreshHotkeyModalShell`
  );
  // 语言切换后也要重贴，否则已打开的弹窗停在旧语言。
  assert.ok(
    /onLanguageChange[\s\S]{0,400}?refreshHotkeyModalShell\(\)/.test(src),
    '热键弹窗没有订阅 onLanguageChange 重贴，切换语言后弹窗文案不会更新'
  );
});

test('every module that owns boot-time wiring is present in the loader', () => {
  // splash 揭幕 / startup 绑定 / 主循环缺一不可：它们是「黑屏」与「正常启动」的分界。
  // Splash reveal, startup bindings and the main loop are the boundary between a black
  // screen and a normal boot; all three must stay in the loader list.
  const paths = readModuleList();
  for (const required of [
    'js/modules/00-state/13-i18n.js',
    'js/modules/10-shell/03-splash.js',
    'js/modules/10-shell/05-startup-bindings.js',
    'js/modules/11-main-loop.js',
  ]) {
    assert.ok(paths.includes(required), `loader 缺少 ${required}`);
  }
  // 顺序同样有讲究：i18n 必须最先，startup 绑定必须排在主循环之前。
  assert.strictEqual(paths.indexOf('js/modules/00-state/13-i18n.js'), 0, 'i18n 模块必须是第一个');
  assert.ok(
    paths.indexOf('js/modules/10-shell/05-startup-bindings.js') < paths.indexOf('js/modules/11-main-loop.js'),
    'startup 绑定必须排在主循环之前',
  );
});
