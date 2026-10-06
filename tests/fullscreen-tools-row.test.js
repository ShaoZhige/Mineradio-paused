const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PREFS = path.join(ROOT, 'public', 'js', 'modules', '00-state', '02-preferences-ui-modes.js');

// syncFullscreenToolsRow() 是**搬节点**，不是复制：进全屏把标题栏那排工具按钮搬进全屏工具行，
// 退出再搬回来。搬移最容易错的两件事是「顺序变了」和「搬不回来／重复搬出两份」，而它们在真实
// 界面里都不会报错，只看得到按钮不见了或者多了一个 —— 所以用最小假 DOM 真跑一遍。
// 仓库里没有 jsdom，这里的假 DOM 只实现被调用的那几个方法：getElementById / querySelector /
// appendChild / insertBefore / parentNode / childNodes。
//
// syncFullscreenToolsRow() MOVES nodes (it does not clone them) between the title bar and the fullscreen
// tool row. The two ways a move goes wrong — order scrambled, or a node never coming back / being
// duplicated — are both silent in the real UI, so this runs the function against a minimal fake DOM
// (there is no jsdom in this repo) covering exactly the methods it calls.

function readPrefs() {
  return fs.readFileSync(PREFS, 'utf8');
}

// 抽出来的这一片必须包含常量与函数本体，函数体里用到的其它模块级符号（syncDiyModeButton、
// layoutFullscreenToolsZone）由沙箱提供。
// The slice must contain the constant and the function body; the other module-level symbols it calls are
// supplied by the sandbox.
function extractMoveRuntime() {
  const source = readPrefs();
  const start = source.indexOf('var FULLSCREEN_TOOL_SELECTORS');
  const end = source.indexOf('function layoutFullscreenToolsZone(');
  assert.ok(start >= 0 && end > start, 'FULLSCREEN_TOOL_SELECTORS + syncFullscreenToolsRow() 必须都在 02-preferences-ui-modes.js 里');
  const code = source.slice(start, end);
  const calls = { layout: 0, diySync: 0 };
  const dom = createFakeDom();
  // vm.runInNewContext 按「脚本」求值，顶层 return 是语法错误 —— 必须包一层 IIFE。
  const runtime = vm.runInNewContext(
    '(function () {\n' + code + '\nreturn { move: syncFullscreenToolsRow, selectors: FULLSCREEN_TOOL_SELECTORS };\n})()',
    {
      document: dom.document,
      syncDiyModeButton: function () { calls.diySync += 1; },
      layoutFullscreenToolsZone: function () { calls.layout += 1; }
    }
  );
  return { runtime: runtime, dom: dom, calls: calls };
}

function createFakeDom() {
  function createNode(name) {
    return {
      name: name,
      parentNode: null,
      childNodes: [],
      appendChild: function (child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
      },
      removeChild: function (child) {
        var at = this.childNodes.indexOf(child);
        if (at >= 0) this.childNodes.splice(at, 1);
        child.parentNode = null;
        return child;
      },
      insertBefore: function (child, anchor) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        var at = anchor ? this.childNodes.indexOf(anchor) : -1;
        if (at < 0) this.childNodes.push(child);
        else this.childNodes.splice(at, 0, child);
        return child;
      },
      names: function () {
        return this.childNodes.map(function (node) { return node.name; });
      }
    };
  }
  var zone = createNode('#fullscreen-tools-zone');
  var bar = createNode('.desktop-window-controls');
  var minimize = createNode('[minimize]');
  var windowButtons = [minimize, createNode('[maximize]'), createNode('[close]')];
  // 工具控件的节点按选择器字符串命名，于是断言里的名字就是选择器本身，不会和实现各说各话。
  // Tool nodes are named after their selectors so assertions cannot drift from the implementation.
  var tools = {};
  var selectors = [];
  var document = {
    getElementById: function (id) {
      return id === 'fullscreen-tools-zone' ? zone : null;
    },
    querySelector: function (selector) {
      if (selector === '.desktop-window-controls') return bar;
      var node = tools[selector] || null;
      // 只认「还挂在标题栏或工具行里」的节点：真实 querySelector 找不到已脱离文档的节点，
      // 这里是搬移能跳过缺失控件的原因。
      // Only nodes still mounted in either home are found — a detached node is invisible to the real
      // querySelector, which is what lets the move skip a missing control.
      if (!node || (node.parentNode !== bar && node.parentNode !== zone)) return null;
      return node;
    }
  };
  bar.querySelector = function (selector) {
    // 还原点：真实的簇里最小化按钮始终在，querySelector 找不到它才算异常。
    return selector === '[data-window-action="minimize"]' ? minimize : null;
  };
  function installTools(selectorList) {
    selectors = selectorList.slice();
    // 原地清空（不要重新赋值）：外部持有的是同一个对象引用。
    // Cleared in place, never reassigned: callers hold the same object reference.
    Object.keys(tools).forEach(function (key) { delete tools[key]; });
    bar.childNodes = [];
    selectorList.forEach(function (selector) {
      var node = createNode(selector);
      tools[selector] = node;
      bar.appendChild(node);
    });
    windowButtons.forEach(function (node) { bar.appendChild(node); });
    zone.childNodes = [];
    return tools;
  }
  return {
    document: document,
    zone: zone,
    bar: bar,
    minimize: minimize,
    tools: tools,
    installTools: installTools,
    getSelectors: function () { return selectors; }
  };
}

test('entering fullscreen moves the whole tool row into the row and exiting puts it back in order', () => {
  const { runtime, dom, calls } = extractMoveRuntime();
  // ⚠️ 必须 Array.from()：runtime.selectors 来自 vm 沙箱，是**另一个 realm** 的数组，
  // 它的 Array.prototype 与宿主不同，assert.deepEqual（严格）会因原型不同而判不相等。
  // Must go through Array.from: the vm sandbox is another realm, so its Array.prototype differs and
  // strict deepEqual would reject an otherwise identical array.
  const selectors = Array.from(runtime.selectors);
  dom.installTools(selectors);
  const toolNodes = dom.tools;
  const originalBarOrder = dom.bar.names();
  assert.deepEqual(originalBarOrder, selectors.concat(['[minimize]', '[maximize]', '[close]']), '假 DOM 的初始布局应与标题栏一致');

  runtime.move(true);
  // 搬的是同一批节点，不是副本 —— 语言菜单、热键文案、更新入口进度都挂在节点上。
  assert.deepEqual(dom.zone.names(), selectors, '进入全屏后工具行应包含全部工具控件');
  assert.deepEqual(dom.bar.names(), ['[minimize]', '[maximize]', '[close]'], '搬走后标题栏只剩窗口按钮');
  selectors.forEach(function (selector) {
    assert.equal(dom.zone.childNodes[selectors.indexOf(selector)], toolNodes[selector], selector + ' 必须是同一个节点，不能是副本');
  });
  assert.ok(calls.layout >= 1, '搬完必须重新量一次行宽（位置依赖宽度）');
  assert.ok(calls.diySync >= 1, '搬完要重贴 DIY 按钮状态');

  // 主进程可能重复上报同一个状态 —— 搬移必须幂等，不能越搬越多。
  runtime.move(true);
  assert.deepEqual(dom.zone.names(), selectors, '重复进入全屏不该产生重复节点');

  runtime.move(false);
  assert.deepEqual(dom.bar.names(), originalBarOrder, '退出全屏后标题栏顺序必须与原来完全一致');
  assert.equal(dom.zone.childNodes.length, 0, '退出全屏后工具行应为空');

  runtime.move(false);
  assert.deepEqual(dom.bar.names(), originalBarOrder, '重复退出不该打乱顺序');
});

test('a missing node never breaks the move of the others', () => {
  const { runtime, dom } = extractMoveRuntime();
  const selectors = Array.from(runtime.selectors);
  dom.installTools(selectors);
  // 拟真：某个控件在别的路径里被移出了标题栏（例如被控制台登记搬走）。搬移必须跳过它，
  // 而不是抛错或者把它当锚点插到别处。
  const missing = selectors[1];
  dom.bar.removeChild(dom.tools[missing]);
  const rest = selectors.filter(function (selector) { return selector !== missing; });

  runtime.move(true);
  assert.deepEqual(dom.zone.names(), rest, '缺一个控件时其余照搬');
  runtime.move(false);
  assert.deepEqual(dom.bar.names(), rest.concat(['[minimize]', '[maximize]', '[close]']), '搬回来时也要保持顺序');
});
