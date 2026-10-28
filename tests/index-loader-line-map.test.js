'use strict';

// 拼接加载器的行号映射。
//
// 所有模块拼成一个 <script>，共用同一个 sourceURL，所以报错只给出
// `mineradio-index-modules.js:20912` —— 想定位得靠行号累加手工对表。这里守住三件事：
// 映射器还在、区间是从 1 开始连续的、每段末尾补齐了换行（缺尾换行会让下一段的首行接到上一段
// 的末行上，行号整体往前错位，第一版就把错误指到了隔壁文件）。
//
// The concatenated loader shares one sourceURL across every module, so a stack only reports a line
// number inside that blob. These tests pin the line map, its contiguous one-based ranges, and the
// trailing-newline padding that keeps the ranges aligned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
const loaderText = fs.readFileSync(loaderPath, 'utf8');

function sliceFunction(text, name) {
  const start = text.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' must exist');
  const end = text.indexOf('\n  }', start);
  assert.notEqual(end, -1, name + ' must be closed inside the loader IIFE');
  return text.slice(start, end + 4);
}

test('loader exposes a module line map and a translator for concatenated stacks', () => {
  assert.match(loaderText, /__mineradioModuleLineMap/, 'the map has to be published for debugging');
  assert.match(loaderText, /__mineradioLocateModule/, 'a translator is what turns a blob line into file:line');
  assert.match(loaderText, /mineradio-index-modules/, 'stacks still come from the concatenated sourceURL');
  // 每段补尾换行：少了它，下一段的首行会被接到上一段的末行上。
  assert.match(
    loaderText,
    /raw\.endsWith\('\\n'\) \? raw : raw \+ '\\n'/,
    'each module piece must end with a newline or the whole map shifts'
  );
  // 默认必须还是拼接：分文件注入会因为跨文件函数提升丢失而崩。
  assert.match(
    loaderText,
    /forced === 'split' \? 'split' : 'concat'/,
    'split injection cannot be the default until backward references are gone'
  );
});

test('buildModuleLineMap produces contiguous one-based ranges', () => {
  const fnSource = sliceFunction(loaderText, 'buildModuleLineMap');
  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(fnSource + '\nthis.build = buildModuleLineMap;', sandbox);
  const map = sandbox.build([
    { path: 'a.js', code: 'x\ny\n', lines: 2 },
    { path: 'b.js', code: 'z\n', lines: 1 },
    { path: 'c.js', code: 'q\nr\ns\n', lines: 3 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(map)), [
    { path: 'a.js', start: 1, end: 2 },
    { path: 'b.js', start: 3, end: 3 },
    { path: 'c.js', start: 4, end: 6 }
  ]);
});
