#!/usr/bin/env node
'use strict';

// Build artifact integrity checker.
// Used by package-integrity.yml after a Windows build.

const fs = require('node:fs');
const path = require('node:path');

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const errors = [];

function error(msg) {
  errors.push(msg);
  process.stderr.write(`[ERR] ${msg}\n`);
}

function ok(msg) {
  process.stdout.write(`[OK] ${msg}\n`);
}

function warn(msg) {
  process.stdout.write(`[WARN] ${msg}\n`);
}

function walkDir(dir) {
  const result = [];
  try {
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      result.push(entry);
    }
  } catch { /* dir missing — handled by caller */ }
  return result;
}

const distDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(distDir)) {
  warn('dist/ not found — skip build-artifact checks (run build first)');
} else {
  const unpacked = path.join(distDir, 'win-unpacked');
  if (fs.existsSync(unpacked)) {
    ok('win-unpacked/ present');
    fs.existsSync(path.join(unpacked, 'Mineradio.exe'))
      ? ok('Mineradio.exe present')
      : warn('Mineradio.exe missing from win-unpacked/');
    ok(`expected version: ${PKG.version}`);
  }

  const allFiles = walkDir(distDir);

  const dangerous = [
    '.cookie', '.qq-cookie', '.kugou-cookie', '.qishui-cookie', '.qishui-token',
    '.qishui-oauth.json', '.qishui-qr-identity.json', '.qishui-qr-login.json',
    '.spotify-credentials.json', '.env',
  ];
  for (const bad of dangerous) {
    if (allFiles.some(f => f.endsWith(bad) || f.includes(bad))) {
      error(`Sensitive file found in build: ${bad}`);
    }
  }

  const testFiles = allFiles.filter(f => f.endsWith('.test.js'));
  testFiles.length > 0
    ? error('Test files found in build artifact')
    : ok('No test files in build artifact');

  const sourceMaps = allFiles.filter(f => f.endsWith('.map'));
  if (sourceMaps.length > 0) warn(`Source maps found: ${sourceMaps.length} files`);

  const installers = allFiles.filter(f => f.endsWith('.exe'));
  for (const inst of installers) {
    const basename = path.basename(inst);
    const expected = `Mineradio-${PKG.version}-Setup.exe`;
    basename === expected
      ? ok(`Installer named correctly: ${basename}`)
      : warn(`Installer name: ${basename} (expected: ${expected})`);
  }
}

const secretPatterns = [
  /-----BEGIN RSA PRIVATE KEY-----/,
  /-----BEGIN PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{36}/,
  /gho_[A-Za-z0-9]{36}/,
];
for (const dir of ['desktop', 'public']) {
  const full = path.join(__dirname, '..', dir);
  if (!fs.existsSync(full)) continue;
  for (const f of walkDir(full)) {
    const fp = path.join(full, f);
    let content;
    try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const pat of secretPatterns) {
      if (pat.test(content)) error(`Potential secret in source: ${fp}`);
    }
  }
}
ok('Source tree checked for secrets');

// 打包清单守卫：后端每个 .js 文件都必须被 build.files 的某个 pattern 覆盖。
// 防止再出现 server/qishui-client-bridge.js 这种"代码引用了、打包漏了"的启动崩溃。
//
// ⚠️ 判据的根目录是从哪里来的：这里原本扫描的是**仓库根目录**的 .js。后端模块搬进 server/ 之后，
// 根目录一个 .js 都不剩，这条判据就会永远通过 —— 一个恒绿的守卫比没有守卫更危险，因为它看上去
// 还在守着。所以扫描面跟着被保护的对象一起搬到 server/，并在末尾断言"确实扫到了文件"。
// Packaging-manifest guard: every backend .js must be covered by some build.files pattern, so that
// a dependency the code requires but the build forgot (the qishui-client-bridge.js startup crash)
// cannot ship again.
//
// ⚠️ Where the scan root comes from: this used to scan the repository root, where the backend modules
// lived. Once they moved into server/ that directory holds no .js at all and the check would pass
// forever — a permanently green guard is worse than no guard, because it still looks like coverage.
// The scan surface follows the thing it protects, and the assertion at the end proves it found files.
const backendDir = path.join(__dirname, '..', 'server');
const buildFilePatterns = PKG.build?.files || [];
function patternCoversBackendFile(pattern, relativeFile) {
  if (pattern.startsWith('!')) return false;
  if (!pattern.endsWith('**/*')) return false; // 只认目录级覆盖：server/ 下新增文件必须自动落入
  const dir = pattern.slice(0, -'**/*'.length);
  return relativeFile.startsWith(dir);
}
const backendFiles = fs.existsSync(backendDir)
  ? fs.readdirSync(backendDir).filter(entry => entry.endsWith('.js'))
  : [];
if (backendFiles.length === 0) {
  error('No backend .js found under server/ — the scan root moved, so this guard would pass vacuously');
}
const uncoveredBackend = backendFiles.filter((entry) => {
  const relative = path.posix.join('server', entry);
  return !buildFilePatterns.some(p => patternCoversBackendFile(p, relative));
});
// 只有真的一条不差才报 OK：无条件打印 OK 会让"9 个文件全未覆盖"看起来也像通过。
// OK is printed only when nothing is uncovered; printing it unconditionally makes "all 9 files
// uncovered" look like a pass.
if (uncoveredBackend.length === 0 && backendFiles.length > 0) {
  ok(`All ${backendFiles.length} backend JS files covered by build.files`);
} else {
  uncoveredBackend.forEach((entry) => error(`Backend JS file not covered by build.files: server/${entry}`));
}

if (errors.length > 0) {
  process.stdout.write(`\n${errors.length} error(s), exiting with code 1\n`);
  process.exit(1);
}
process.stdout.write('\nAll checks passed\n');
process.exit(0);
