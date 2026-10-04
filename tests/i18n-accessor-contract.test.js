'use strict';

// 取词调用的兜底文案必须与词典同键的值逐字相同。
// 这条不变量同时挡住两类真实事故：
//   1. 有人改了词典文案却没同步兜底 —— 加载失败或词典缺键时，界面会退回旧说法；
//   2. 有人只改了代码里的兜底 —— 词典在运行时优先，界面看到的仍是词典那套说法，
//      于是"改了文案"这个动作其实没生效。
// 换句话说：词典与代码各说各话时，两边看到的界面不一样，而没人会立刻发现。
// The accessor fallback must match the dictionary verbatim. That single invariant catches
// two real failures: editing one side only (the dictionary wins at runtime, so a code-only
// edit changes nothing visible), and the two sides drifting apart unnoticed.
//
// 同时钉住取词函数的形态：签名带 params、并且用 typeof window 兜底，否则在裸沙箱里
// 求值会直接抛 ReferenceError，把引用它的测试整片带崩。
// It also pins the accessor shape: three params, and a `typeof window` guard so evaluating
// it in a bare sandbox cannot throw ReferenceError and take down whole test files.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { accessorNames, accessorInSandbox } = require('./helpers/module-source');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'public', 'js', 'modules');
const LANGS = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// 注释里提到键名不算接线：结构断言只看真代码。
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function loadDict(lang) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', lang + '.json'), 'utf8'));
}

// JS 单引号字符串字面量里的转义：\' \\ \n 只管这三种，其余原样保留。
function unescapeLiteral(raw) {
  return raw.replace(/\\(['\\n])/g, (_, ch) => (ch === 'n' ? '\n' : ch));
}

const FILES = walk(MODULES).map((file) => ({
  rel: path.relative(ROOT, file).replace(/\\/g, '/'),
  source: fs.readFileSync(file, 'utf8'),
}));

// 取词函数名从「定义」里取，不从调用里猜 —— 猜会把形参不同的函数一起卷进来。
const ACCESSORS = new Set();
for (const file of FILES) for (const name of accessorNames(file.source)) ACCESSORS.add(name);

test('取词函数的形态统一：三参签名 + typeof window 兜底', () => {
  const offenders = [];
  for (const { rel, source } of FILES) {
    for (const name of accessorNames(source)) {
      const head = new RegExp('function ' + name + '\\(([^)]*)\\)').exec(source);
      if (!head || !/^key,\s*fallback,\s*params$/.test(head[1].trim())) {
        offenders.push(rel + ' 的 ' + name + ' 签名不是 (key, fallback, params)');
      }
      const body = new RegExp('function ' + name + '\\(key, fallback, params\\) \\{([\\s\\S]*?)\\n\\}').exec(source);
      if (!body) {
        offenders.push(rel + ' 的 ' + name + ' 无法解析出实现');
        continue;
      }
      if (!/typeof window !== 'undefined'/.test(body[1])) {
        offenders.push(rel + ' 的 ' + name + ' 没有 typeof window 兜底，裸沙箱里会抛 ReferenceError');
      }
      if (!/return text/.test(body[1])) {
        offenders.push(rel + ' 的 ' + name + ' 没有在无词典时返回兜底文案');
      }
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('取词调用引用的键在词典里存在，且有兜底时兜底与词典同值', () => {
  // 这条守卫曾要求「每处接线都写中文兜底，且与词典逐字相同」。那是接线量小时的写法，
  // 规模化之后它反过来成了阻力：每加一处界面文案就要在代码里再抄一遍中文，
  // 两处漂移的风险随代码量线性上升。
  //
  // 现在的判据分两层：
  //   必须成立 —— 键在四份词典里都存在（有兜底时兜底还要与词典同值）。
  //     缺键时 t() 返回键名本身，界面上会出现 "local_collect_unsupported" 这种裸键，
  //     漏译立刻可见，这正是我们要的：静默显示另一种措辞比报错更难查。
  //   不再要求 —— 每处都写兜底。单参调用 xxxText('key') 是合法且推荐的写法。
  // The old rule demanded a Chinese fallback at every call site, which turned each new piece
  // of copy into a second place to keep in sync. Missing keys are now the loud failure mode:
  // t() returns the key itself, so an untranslated string shows up as a bare key.
  const dict = loadDict('zh_cn');
  const withFallback = "\\b(" + [...ACCESSORS].join('|') + ")\\(\\s*'([^']+)'\\s*,\\s*'((?:\\\\.|[^'\\\\])*)'";
  const keyOnly = "\\b(" + [...ACCESSORS].join('|') + ")\\(\\s*'([^']+)'\\s*\\)";
  const offenders = [];
  let withCount = 0;
  let keyOnlyCount = 0;
  for (const { rel, source } of FILES) {
    const code = stripComments(source);
    let m;
    const fb = new RegExp(withFallback, 'g');
    while ((m = fb.exec(code)) !== null) {
      const key = m[2];
      const fallback = unescapeLiteral(m[3]);
      withCount += 1;
      if (!Object.prototype.hasOwnProperty.call(dict, key)) {
        offenders.push(rel + ' 用了词典里没有的键 ' + key);
      } else if (dict[key] !== fallback) {
        offenders.push(rel + ' 的 ' + key + ' 兜底与词典不一致\n    代码: ' + fallback + '\n    词典: ' + dict[key]);
      }
    }
    const ko = new RegExp(keyOnly, 'g');
    while ((m = ko.exec(code)) !== null) {
      keyOnlyCount += 1;
      if (!Object.prototype.hasOwnProperty.call(dict, m[2])) {
        offenders.push(rel + ' 用了词典里没有的键 ' + m[2]);
      }
    }
  }
  assert.ok(withCount + keyOnlyCount > 300, '只扫到 ' + (withCount + keyOnlyCount) + ' 处取词调用，正则可能失效了');
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('取词调用引用的每个键在四份词典里都存在且键序一致', () => {
  const dicts = LANGS.map(loadDict);
  const orders = new Set(dicts.map((d) => Object.keys(d).join('\u0000')));
  assert.strictEqual(orders.size, 1, '四份词典的键序不一致');
  const keys = new Set();
  for (const { source } of FILES) {
    const code = stripComments(source);
    const call = new RegExp('\\b(' + [...ACCESSORS].join('|') + ')\\(\'([^\']+)\'', 'g');
    let m;
    while ((m = call.exec(code)) !== null) keys.add(m[2]);
  }
  const missing = [];
  for (const key of keys) {
    for (let i = 0; i < LANGS.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(dicts[i], key)) missing.push(key + ' 缺于 ' + LANGS[i]);
    }
  }
  assert.deepStrictEqual(missing, [], missing.join(', '));
});

test('没有取词函数把 window 防护写在读取之后', () => {
  // 这条是「裸沙箱 ReferenceError」的成因守卫：先读 window 再判断，等于没判断。
  const offenders = [];
  for (const { rel, source } of FILES) {
    for (const name of accessorNames(source)) {
      const body = new RegExp('function ' + name + '\\(key, fallback, params\\) \\{([\\s\\S]*?)\\n\\}').exec(source);
      if (!body) continue;
      const firstWindowUse = body[1].indexOf('window.');
      const guardAt = body[1].indexOf('typeof window');
      if (firstWindowUse >= 0 && guardAt > firstWindowUse) {
        offenders.push(rel + ' 的 ' + name + ' 先读 window 再防护');
      }
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('取词函数的占位符插值写法正确（不会被模板转义破坏）', () => {
  // 真实事故：批量重写取词函数时，多行模板里的 {field} 被 Python 当成占位符转义成
  // {{field}}，于是 split('{{field}}') 去找字面量，永远匹配不上 —— 占位符插值静默失效，
  // 而 node --check 与绝大多数测试都察觉不到（界面上的 {provider} 变成原样文字）。
  //
  // 这条判据直接看源码里那两行插值语句的形状。之所以要专门钉：它是批量改写最容易踩的坑，
  // 而且失效方式极其安静。
  // A real accident: a batch rewrite let the template layer escape {field} into {{field}},
  // so split('{{field}}') looked for a literal and never matched. Placeholder substitution
  // died silently while `node --check` and nearly every test stayed green.
  const offenders = [];
  for (const { rel, source } of FILES) {
    const code = stripComments(source);
    for (const name of ACCESSORS) {
      const body = new RegExp('function ' + name + '\\(key, fallback, params\\) \\{([\\s\\S]*?)\\n\\}')
        .exec(code);
      if (!body) continue;
      const inner = body[1];
      // 必须有形如 split('{' + field + '}') 的插值；出现双花括号即为转义残留
      if (inner.includes("split('{{'") || inner.includes("'}}')")) {
        offenders.push(rel + ' 的 ' + name + ' 出现双花括号，占位符插值已失效');
      }
      const single = /split\('\{' \+ \w+ \+ '\}'\)/.test(inner);
      const dbl = /split\('\{\{' \+ \w+ \+ '\}\}'\)/.test(inner);
      if (!single || dbl) {
        offenders.push(rel + ' 的 ' + name + ' 的插值语句形状不对：'
          + (inner.match(/split\([^)]*\)/) || ['(没找到)'])[0]);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('取词函数在带插值时两条路径都生效（词典命中与兜底）', () => {
  // 形状对了不等于行为对：真正跑一遍，验证 {field} 在两条路径上都被替换。
  // Shape is not behaviour: run it and check the placeholder resolves on both paths.
  for (const name of ACCESSORS) {
    const file = FILES.find((f) => f.source.includes('function ' + name + '(key, fallback, params)'));
    if (!file) continue;
    const call = accessorInSandbox(file.source, name, { t: (k) => (k === 'has' ? '词典 {v}' : k) });
    assert.strictEqual(call('has', '兜底 {v}', { v: 'X' }), '词典 X',
      name + ' 词典命中时没有把占位符替换掉');
    const callNoDict = accessorInSandbox(file.source, name, { t: (k) => k });
    assert.strictEqual(callNoDict('missing', '兜底 {v}', { v: 'X' }), '兜底 X',
      name + ' 走兜底时没有把占位符替换掉');
  }
});
