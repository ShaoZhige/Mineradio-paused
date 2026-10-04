#!/usr/bin/env node
'use strict';

// Unified Node-level test runner — runs all tests/*.test.js and aggregates results.
// Used by ci.yml and package.json "test:ci" script.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS_DIR = path.join(__dirname, '..', 'tests');
const files = fs
  .readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

// 汽水音乐签名桥接会把官方客户端的专有二进制复制到本地缓存并 require 它。
// 测试进程一律不加载这些二进制：默认关闭桥接并给一个沙箱缓存目录；
// 需要覆盖签名降级行为的用例自行打开开关并指定沙箱（见 qishui-seo-playback-fallback.test.js）。
const testEnv = {
  ...process.env,
  QISHUI_CLIENT_BRIDGE: '0',
  QISHUI_NATIVE_CACHE_DIR: path.join(os.tmpdir(), 'mineradio-tests-qishui-native'),
  QISHUI_CLIENT_DIR: path.join(os.tmpdir(), 'mineradio-tests-qishui-empty-client'),
};

let failed = 0;
let passed = 0;
const start = Date.now();

for (const file of files) {
  const filePath = path.join(TESTS_DIR, file);
  process.stdout.write(`=== ${file} ===\n`);
  const result = spawnSync(process.execPath, [filePath], {
    stdio: 'inherit',
    timeout: 120_000,
    env: testEnv,
  });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(`\nFAIL: ${file} (exit ${result.status})\n`);
  } else {
    passed++;
  }
}

const elapsed = Math.round((Date.now() - start) / 1000);
process.stdout.write(`\n${passed} passed, ${failed} failed, ${files.length} total (${elapsed}s)\n`);

if (failed > 0) {
  process.exit(1);
}
