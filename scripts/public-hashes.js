#!/usr/bin/env node
'use strict';

/**
 * public/ 哈希守卫：Tauri 重写的前提是前端逐字节不动。
 *
 *   node scripts/public-hashes.js          写 docs/PUBLIC-HASHES.txt
 *   node scripts/public-hashes.js --check  重算并比对，有任何差异退出码 1
 *
 * 产物用 sha256sum 的格式（`<hash>  <path>`，路径相对仓库根），所以也能直接：
 *   sha256sum -c docs/PUBLIC-HASHES.txt
 *
 * 只覆盖文件内容，不覆盖权限/时间戳 —— 重写期间这些本来就会变。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_PATH = path.join(ROOT, 'docs', 'PUBLIC-HASHES.txt');

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile()) acc.push(full);
    // 符号链接/设备文件不进来：public/ 里不该有，出现就是异常，交给调用方比对时暴露
  }
  return acc;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function build() {
  if (!fs.existsSync(PUBLIC_DIR)) throw new Error('public/ 不存在');
  const files = walk(PUBLIC_DIR, [])
    .map((full) => ({
      rel: path.relative(ROOT, full).replace(/\\/g, '/'),
      hash: sha256(full),
      size: fs.statSync(full).size,
    }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

function parse(text) {
  const map = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64})\s\s?(.+)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

function main() {
  const check = process.argv.includes('--check');
  const files = build();
  const text = `${files.map((f) => `${f.hash}  ${f.rel}`).join('\n')}\n`;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  if (check) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error('FAIL docs/PUBLIC-HASHES.txt 不存在，先跑 npm run hash:public');
      process.exit(1);
    }
    const expected = parse(fs.readFileSync(OUT_PATH, 'utf8'));
    const actual = new Map(files.map((f) => [f.rel, f.hash]));
    const added = [...actual.keys()].filter((k) => !expected.has(k));
    const removed = [...expected.keys()].filter((k) => !actual.has(k));
    const changed = [...actual.keys()].filter((k) => expected.has(k) && expected.get(k) !== actual.get(k));
    if (added.length || removed.length || changed.length) {
      console.error('FAIL public/ 与基线不一致 —— 重写期间 public/ 必须逐字节不动');
      for (const f of changed) console.error(`     改动  ${f}`);
      for (const f of added) console.error(`     新增  ${f}`);
      for (const f of removed) console.error(`     删除  ${f}`);
      console.error('     如果这次改动是有意的，重新跑 npm run hash:public 并在提交里说明原因。');
      process.exit(1);
    }
    console.log(`OK public/ 未变：${files.length} 个文件 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, text, 'utf8');
  console.log(`已写入 docs/PUBLIC-HASHES.txt`);
  console.log(`  文件 ${files.length} 个，共 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
}

main();
