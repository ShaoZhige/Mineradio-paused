#!/usr/bin/env node
'use strict';

// 跨平台回归测试运行器：在 Windows 上再跑一遍 tests/*.test.js（ci.yml 的那一遍跑在 ubuntu 上）。
// 注意它**不是** Electron 运行器：下面用 `process.execPath` 启动测试，而本脚本由 `node` 调起，
// 所以运行时是普通 Node。真正跑在 Electron 里的检查是 `npm run test:custom-source-host`。
// Cross-platform regression runner: a second pass over tests/*.test.js on Windows (ci.yml runs the
// same suite on ubuntu). NOT an Electron runtime — see the note above about `process.execPath`.
// The Electron-hosted check is `npm run test:custom-source-host`.
//
// 用法：不带参数跑全部；带一个文件名（相对 tests/）只跑那一个，便于本地定位。
// Usage: no argument runs everything; a single file name (relative to tests/) runs just that one.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');

function run(file) {
  process.stdout.write(`=== ${path.basename(file)} ===\n`);
  const result = spawnSync(
    process.execPath,
    [file],
    { stdio: 'inherit', timeout: 300_000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } }
  );
  process.stdout.write(`EXIT: ${result.status}\n`);
  return result.status === 0;
}

const TEST_FILE = process.argv[2];
let failed = 0;
let passed = 0;

if (TEST_FILE) {
  const full = path.join(rootDir, 'tests', TEST_FILE);
  if (!fs.existsSync(full)) {
    process.stderr.write(`file not found: ${full}\n`);
    process.exit(1);
  }
  run(full) ? passed++ : failed++;
} else {
  const files = fs.readdirSync(path.join(rootDir, 'tests'))
    .filter(f => f.endsWith('.test.js'))
    .sort();
  for (const file of files) {
    run(path.join(rootDir, 'tests', file)) ? passed++ : failed++;
  }
}

process.stdout.write(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
