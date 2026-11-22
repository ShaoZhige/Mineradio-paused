'use strict';
// 零引用函数扫描（含语言包 onclick —— 这是之前的盲区：submitDetailComment 就是被
// public/locales/*.json 里的 onclick="submitDetailComment()" 调用的）。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'userdata', 'ztest', 'tests', 'vendor', 'cache'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|cjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const codeFiles = walk(ROOT);
const code = codeFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const localeDir = path.join(ROOT, 'public', 'locales');
const locales = fs.existsSync(localeDir)
  ? fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'))
      .map((f) => fs.readFileSync(path.join(localeDir, f), 'utf8')).join('\n')
  : '';

const defs = [];
for (const f of codeFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) defs.push({ name: m[1], file: f });
}
const count = (text, name) => (text.match(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length;

const dead = [];
const localeOnly = [];
for (const d of defs) {
  if (count(code, d.name) > 1) continue;
  if (count(locales, d.name) > 0) localeOnly.push(d); else dead.push(d);
}
// 已备案的不再重复报（每条都要写清楚理由，见 dead-code-allowlist.json）
const allowPath = path.join(__dirname, 'dead-code-allowlist.json');
const allow = fs.existsSync(allowPath) ? JSON.parse(fs.readFileSync(allowPath, 'utf8')) : {};
const key = (d) => path.relative(ROOT, d.file).replace(/\\/g, '/') + '::' + d.name;
const kept = dead.filter((d) => allow[key(d)]);
const real = dead.filter((d) => !allow[key(d)]);
console.log('顶层函数', defs.length, '| 真死', real.length, '| 已备案保留', kept.length, '| 只被语言包 onclick 调用（禁止删）', localeOnly.length);
console.log('\n── 真死（可删，仍需查 tests/ 与 scripts/checks/）──');
for (const d of real) console.log('  ', path.relative(ROOT, d.file) + ' :: ' + d.name);
console.log('\n── 已备案保留（有理由，见 dead-code-allowlist.json）──');
for (const d of kept) console.log('  ', key(d), '→', allow[key(d)]);
console.log('\n── 只在语言包 HTML 里被调用（onclick）──');
for (const d of localeOnly) console.log('  ', path.relative(ROOT, d.file) + ' :: ' + d.name);
