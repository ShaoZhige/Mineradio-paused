'use strict';

// 占位符是「模板」与「调用点」之间的契约，两边不一致时界面会露出 `{count}` 这种原样文本。
// 三条不变量：
//   1. 四份词典里同一个键的占位符集合必须一致 —— 少一个，译文就漏出花括号；
//   2. 代码里传出的 params 键名必须与词典占位符对得上（写 {count} 却传 {n}，插值不到）；
//   3. 词典里带占位符的键必须真的被消费 —— 没人传 params 的键一定会露出占位符。
// A placeholder is a contract between template and call site. All three failure modes end the
// same way: the UI renders a literal `{count}` to the user.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LANGS = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];
const PLACEHOLDER = /\{(\w+)\}/g;
const MODULES = path.join(ROOT, 'public', 'js', 'modules');

function loadDict(lang) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', lang + '.json'), 'utf8'));
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function placeholders(text) {
  return new Set([...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]));
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const DICTS = LANGS.map(loadDict);
const SOURCES = walk(MODULES).map((file) => ({
  rel: path.relative(ROOT, file).replace(/\\/g, '/'),
  code: stripComments(fs.readFileSync(file, 'utf8')),
}));

test('同一个键在四份词典里的占位符集合完全一致', () => {
  const offenders = [];
  for (const key of Object.keys(DICTS[0])) {
    const reference = [...placeholders(DICTS[0][key])].sort();
    for (let i = 1; i < LANGS.length; i++) {
      const other = [...placeholders(DICTS[i][key])].sort();
      if (other.join(',') !== reference.join(',')) {
        offenders.push(`${key}：${LANGS[0]}=[${reference}] 但 ${LANGS[i]}=[${other}]`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('代码传出的 params 键名与词典占位符一致', () => {
  // 三参调用：xxxText('key', '兜底', { … }) 或 xxxText('key', '兜底', 变量)
  const call = /\w+Text\(\s*'([^']+)'\s*,\s*'(?:\\.|[^'\\])*'\s*,\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*\)/g;
  const offenders = [];
  let checked = 0;
  for (const { rel, code } of SOURCES) {
    let m;
    while ((m = call.exec(code)) !== null) {
      const key = m[1];
      const declared = placeholders(DICTS[0][key] || '');
      if (!Object.prototype.hasOwnProperty.call(DICTS[0], key)) {
        offenders.push(`${rel} 用了词典里没有的键 ${key}`);
        continue;
      }
      if (declared.size === 0) {
        offenders.push(`${rel} 的 ${key} 没占位符却传了 params：${m[2].slice(0, 40)}`);
        continue;
      }
      checked += 1;
      // 对象字面量取键名；传变量的无法静态判定，跳过（那条路由守卫的沙箱断言覆盖）。
      if (!m[2].startsWith('{')) continue;
      const passed = new Set([...m[2].matchAll(/(\w+)\s*:/g)].map((x) => x[1]));
      const missing = [...declared].filter((name) => !passed.has(name));
      const extra = [...passed].filter((name) => !declared.has(name));
      if (missing.length || extra.length) {
        offenders.push(`${rel} 的 ${key}：词典要 [${[...declared]}] 代码传 [${[...passed]}]`
          + (missing.length ? ` 缺 ${missing}` : '') + (extra.length ? ` 多 ${extra}` : ''));
      }
    }
  }
  assert.ok(checked >= 5, '只扫到 ' + checked + ' 处带 params 的调用，正则可能失效了');
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('词典里带占位符的键都真的被消费（没接线的会露出花括号）', () => {
  const withPlaceholder = Object.keys(DICTS[0]).filter((k) => placeholders(DICTS[0][k]).size > 0);
  const blob = SOURCES.map((s) => s.code).join('\n') + fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const orphans = withPlaceholder.filter((key) => !blob.includes("'" + key + "'") && !blob.includes('"' + key + '"'));
  // 动态取键的键（映射表里当值出现）也算被消费，上面已覆盖字面量出现的情况。
  assert.deepStrictEqual(orphans, [], '这些键带占位符却没有任何地方引用：' + orphans.join(', '));
});

test('占位符名本身是纯标识符，不会误伤正文里的花括号', () => {
  // 反例防护：如果判据写成 /\{\w+\}/ 但正文里出现 "{ok}" 这类非占位符用法，会被误判。
  // 这里确认判据只认 \w+ 形式，且不匹配跨行或带空格的内容。
  assert.deepStrictEqual([...placeholders('a {x} b { y } c {}')], ['x']);
  assert.deepStrictEqual([...placeholders('无占位符的普通文案')], []);
});
