'use strict';
// 生成守卫台账：把每个 tests/*.test.js 归类为 A 行为型 / B 契约型 / C 纯文本型，
// 并统计断言规模。目的：让"这条守卫为什么存在"可查，而不是靠删。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const dir = path.join(ROOT, 'tests');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

function classify(src) {
  const readsSource = /readFileSync\(|readAllCss\(|readSource\(/.test(src);
  const runsCode = /require\('node:vm'\)|vm\.runIn|new Function|spawnSync\(|require\('\.\.\/server|require\('\.\.\/desktop/.test(src);
  const assertions = (src.match(/assert\.(match|doesNotMatch|ok|strictEqual|deepEqual|equal)\b/g) || []).length;
  const behaviors = (src.match(/assert\.(strictEqual|deepEqual|equal|throws)\b/g) || []).length;
  if (runsCode && !readsSource) return { kind: 'A 行为型', assertions, behaviors };
  if (readsSource && runsCode) return { kind: 'B 契约+行为', assertions, behaviors };
  if (readsSource && behaviors === 0) return { kind: 'C 纯文本', assertions, behaviors };
  return { kind: 'B 契约型', assertions, behaviors };
}

const rows = files.map((f) => {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  return Object.assign({ file: f }, classify(src));
});
const byKind = {};
for (const r of rows) (byKind[r.kind] = byKind[r.kind] || []).push(r);

console.log('测试文件', rows.length);
for (const [k, list] of Object.entries(byKind)) {
  console.log(k + '：' + list.length + ' 个文件 / ' + list.reduce((s, r) => s + r.assertions, 0) + ' 条断言');
}
const c = (byKind['C 纯文本'] || []);
console.log('\nC 类（纯文本，须逐条过四问）：');
for (const r of c) console.log('  ', r.file, '(' + r.assertions + ' 条)');

// 写台账
const lines = [];
lines.push('# 守卫台账（自动生成，勿手改）', '');
lines.push('> 重新生成：`node scripts/guard-ledger.js`。用途：回答"这条守卫为什么存在"，并防止新增守卫没有登记。');
lines.push('> 分类规则：A 行为型＝跑被测代码；B 契约型＝读源码但断言的是结构契约；C 纯文本＝只断言某段字符串还在。', '');
lines.push('## 汇总', '', '| 类型 | 文件数 | 断言数 |', '|---|---|---|');
for (const [k, list] of Object.entries(byKind)) {
  lines.push('| ' + k + ' | ' + list.length + ' | ' + list.reduce((s, r) => s + r.assertions, 0) + ' |');
}
lines.push('', '## 明细', '', '| 文件 | 类型 | 断言 | 等值断言 |', '|---|---|---|---|');
for (const r of rows) lines.push('| ' + r.file + ' | ' + r.kind + ' | ' + r.assertions + ' | ' + r.behaviors + ' |');
fs.writeFileSync(path.join(ROOT, 'docs', 'GUARD-LEDGER.md'), lines.join('\n') + '\n');
console.log('\n已写入 docs/GUARD-LEDGER.md');
