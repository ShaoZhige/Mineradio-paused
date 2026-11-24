'use strict';

// 录制 server/cookie-header.js 的行为，产出 Rust 侧回放用的 cases.jsonl。
//
//   node scripts/record-cookie-header.js > ztest/ra-cookie-header/cases.jsonl
//
// 为什么不用 rust-anything bridge：它只认"导出函数且参数是普通 JSON"的模块。这里
// 的入参本身就是一个多态的 JSON 形状（字符串 / 数组 / 对象 / null / undefined），
// 而 `undefined` 在 JSON 里**没有表示**，`{a: undefined}` 与 `{a: null}` 在编码后
// 会变成同一个东西 —— 但它们在实现里走的是不同分支（见下）。所以传输格式要能区分。
//
// 编码规则（双射，不改变被测行为，只决定怎么过 JSON）：
//   undefined      → { "__undefined__": true }
//   object         → { "__object__": [[k, v], ...] }   ← 必须保序：Map 的插入顺序
//                                                        直接决定拼接后的 Cookie 头顺序
//   array          → 原样递归
//   string/number/boolean/null → 原样
//
// `{a: undefined}` vs `{a: null}` 的实际差异：
//   undefined → typeof 是 'undefined'，走 else if (typeof value !== 'object') → 进
//               collectCookiePair，被 `value === undefined` 丢掉
//   null      → typeof 是 'object'，且 null 是 falsy，所以两个分支都不进 → 也丢掉
// 结果一样，但路径不同。录下来是为了以后有人重构这块时不会以为"两种情况等价"。

const { normalizeCookieHeader, rawCookieFallback } = require('../server/cookie-header');

function encode(value) {
  if (value === undefined) return { __undefined__: true };
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object') {
    return { __object__: Object.keys(value).map((key) => [key, encode(value[key])]) };
  }
  return value;
}

/** @type {Array<{ note: string, input: unknown }>} */
const normalizeCases = [
  { note: '空串', input: '' },
  { note: '只有分号', input: ';;;' },
  { note: '标准双键', input: 'MUSIC_U=abc; __csrf=def' },
  { note: '带 Set-Cookie 属性', input: 'a=1; Path=/; Domain=.163.com; HttpOnly; Secure' },
  { note: '属性名大写也要丢', input: 'a=1; PATH=/; HTTPONLY; SameSite=Lax' },
  { note: '键名大小写不同算两个键', input: 'MUSIC_U=X; music_u=Y' },
  { note: 'LF 多行', input: 'a=1; b=2\nc=3; d=4' },
  { note: 'CRLF 多行', input: 'a=1; b=2\r\nc=3' },
  { note: '空值被 filter 剔除', input: 'a=; b=2' },
  { note: '缺键名（idx=0）丢弃', input: '=value; a=1' },
  { note: '键与值两侧空白', input: '  a  =  1  ;  b  =  2  ' },
  { note: '值里含等号', input: 'a=1=2' },
  { note: '重复键后者覆盖、位置取首次', input: 'a=1; b=2; a=3' },
  { note: '字符串数组', input: ['a=1', 'b=2'] },
  { note: '数组内混对象', input: ['a=1', { name: 'b', value: '2' }, { c: '3' }] },
  { note: '嵌套数组', input: [['a=1'], ['b=2']] },
  { note: '单个 name/value 对象', input: { name: 'a', value: '1' } },
  { note: '扁平对象', input: { a: '1', b: '2' } },
  { note: 'DevTools 导出格式', input: { a: { value: '1' }, b: { value: '2' } } },
  { note: 'DevTools 格式但 value 为 null', input: { a: { value: null }, b: { value: '2' } } },
  { note: '对象值没有 value 属性 → 丢弃', input: { a: { other: 'x' }, b: '2' } },
  { note: '对象值为 null → 丢弃', input: { a: null, b: '2' } },
  { note: '对象值为 undefined → 丢弃（走的是另一条分支）', input: { a: undefined, b: '2' } },
  { note: '对象键序决定输出序', input: { z: '1', a: '2', m: '3' } },
  { note: '类数组下标键提前并按数值升序（Object.keys 规则）', input: { 2: 'a', 1: 'b', x: 'c' } },
  { note: '带前导零的键不是下标，保持插入序', input: { '01': 'a', 9: 'b' } },
  { note: '下标键与普通键混排', input: { z: '1', 10: '2', y: '3', 9: '4' } },
  { note: '数组里带属性名', input: ['Path=/', 'a=1'] },
  { note: '中文值', input: '昵称=小马; a=1' },
  { note: '数字输入', input: 123 },
  { note: '布尔输入', input: true },
  { note: 'null 输入', input: null },
  { note: 'undefined 输入', input: undefined },
  { note: '空数组', input: [] },
  { note: '空对象', input: {} },
  { note: 'name 为空串的对象不进 name/value 分支', input: { name: '', value: '1' } },
  { note: 'name 为 0 的对象不进 name/value 分支', input: { name: 0, value: '1' } },
  { note: 'name 为字符串 "0" 是 truthy，进 name/value 分支', input: { name: '0', value: '1' } },
  { note: 'name 为数组（truthy），String([]) 是空串', input: { name: [], value: '1' } },
  { note: 'name 为对象（truthy），String({}) 是 [object Object]', input: { name: {}, value: '1' } },
  { note: '数字值被 String() 化', input: { a: 1, b: 2 } },
  { note: '布尔值被 String() 化', input: { a: true, b: false } },
];

/** @type {Array<{ note: string, input: unknown }>} */
const fallbackCases = [
  { note: '字符串原样 trim', input: '  a=1; b=2  ' },
  { note: '全字符串数组拼接', input: ['a=1', 'b=2'] },
  { note: '数组含非字符串 → 空串', input: ['a=1', 2] },
  { note: '对象 → 空串', input: { a: '1' } },
  { note: 'null → 空串', input: null },
  { note: 'undefined → 空串', input: undefined },
  { note: '空数组 → 空串', input: [] },
  { note: '非 cookie 形状的裸 token 原样返回', input: 'some-raw-token-without-equals' },
];

const lines = [];

for (const item of normalizeCases) {
  lines.push(JSON.stringify({ fn: 'normalizeCookieHeader', args: [encode(item.input)], ok: normalizeCookieHeader(item.input), note: item.note }));
}

for (const item of fallbackCases) {
  lines.push(JSON.stringify({ fn: 'rawCookieFallback', args: [encode(item.input)], ok: rawCookieFallback(item.input), note: item.note }));
}

// 三种用法：
//   node scripts/record-cookie-header.js            输出到 stdout（人工抽查用）
//   node scripts/record-cookie-header.js --write    直接写进 Rust 侧的 fixture
//   node scripts/record-cookie-header.js --check    与 fixture 逐字节比对（CI 用）
//
// `--check` 是这一刀的关键：JS 那边改一行归一化逻辑，fixture 不重录的话 Rust 测试
// 照样绿（它只证明"Rust 与旧 JS 一致"）。把它挂进 CI，才能保证"两份实现永远同步"。

const fs = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'crates',
  'mineradio-http',
  'tests',
  'fixtures',
  'cookie-header-cases.jsonl',
);

const text = lines.join('\n') + '\n';
const summary = `共 ${lines.length} 条（normalize ${normalizeCases.length} / fallback ${fallbackCases.length}）`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : '';
  if (current !== text) {
    const expected = text.split('\n');
    const actual = current.split('\n');
    const firstDiff = expected.findIndex((line, index) => line !== actual[index]);
    console.error('FAIL fixture 与 server/cookie-header.js 的当前行为不一致');
    console.error(`     文件：${path.relative(path.join(__dirname, '..'), FIXTURE_PATH)}`);
    console.error(`     第 ${firstDiff + 1} 条起不同`);
    console.error(`     重录：node scripts/record-cookie-header.js --write`);
    if (firstDiff >= 0) {
      console.error(`     当前：${String(actual[firstDiff]).slice(0, 200)}`);
      console.error(`     应有：${String(expected[firstDiff]).slice(0, 200)}`);
    }
    process.exit(1);
  }
  console.log(`OK Cookie 头归一化 fixture 一致：${summary}`);
  process.exit(0);
}

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, text, 'utf8');
  console.log(`已写入 ${path.relative(path.join(__dirname, '..'), FIXTURE_PATH)}`);
  console.log(`  ${summary}`);
  process.exit(0);
}

process.stdout.write(text);
process.stderr.write(summary + '\n');
