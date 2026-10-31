// 归档脚本是「本地构筑完直接留在 releases\ 里」的那一步，不进 CI 主链路。
// 这里钉住几条改坏了会悄悄出事的性质：目录落在仓库外、同版本目录覆盖而不是套娃、
// 归档的清单是极简版、校验和由 node 自己算。
// The archiver keeps the locally built installer in ..\releases\<tag>\. These tests pin
// what would fail silently: destination outside the repo, overwrite semantics, and which
// manifest ends up in the archive.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'archive-release-build.mjs');
const SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

// 注释里提到某个词和代码里真的这么干是两件事。
function stripComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const CODE = stripComments(SOURCE);

function slice(from, to) {
  const start = CODE.indexOf(from);
  assert.ok(start >= 0, '找不到起始锚点：' + from);
  const end = to ? CODE.indexOf(to, start + from.length) : CODE.length;
  assert.ok(end >= 0, '找不到结束锚点：' + to);
  return CODE.slice(start, end);
}

test('npm run archive:release 指向这个脚本', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['archive:release'], 'node scripts/archive-release-build.mjs');
});

test('归档目录在仓库外，不污染工作区', () => {
  assert.match(CODE, /const RELEASES_ROOT = path\.resolve\(REPO_ROOT, '\.\.', 'releases'\)/);
  assert.match(CODE, /path\.join\(RELEASES_ROOT, tag\)/);
  assert.doesNotMatch(CODE, /path\.(?:resolve|join)\(REPO_ROOT, 'releases'/);
});

test('tag 必须与 package.json 版本一致', () => {
  assert.match(CODE, /if \(tag !== 'v' \+ version\)/);
});

test('同版本目录覆盖，不套一层新目录', () => {
  // 用户的要求：releases 里已有对应版本号目录就往里覆盖，没有就新建。
  const mkdir = CODE.match(/fs\.mkdirSync\(outDir,\s*\{\s*recursive:\s*true\s*\}\s*\)/);
  assert.ok(mkdir, '必须用 recursive mkdir 覆盖已存在目录');
  assert.match(CODE, /fs\.copyFileSync\(path\.join\(DIST_DIR, name\), path\.join\(outDir, name\)\)/);
  // 目录里不同版本的两个安装包不能并存，否则传网盘时会拿错。
  assert.match(CODE, /entry !== installerName/);
  assert.match(CODE, /fs\.rmSync\(path\.join\(outDir, entry\),\s*\{\s*force:\s*true\s*\}\s*\)/);
});

test('归档的是极简清单，不是 builder 生成的更新源', () => {
  assert.match(CODE, /const MANIFEST_SRC = path\.join\(REPO_ROOT, 'docs', 'update', 'latest\.yml'\)/);
  assert.match(CODE, /fs\.copyFileSync\(MANIFEST_SRC, path\.join\(outDir, 'latest\.yml'\)\)/);
  // 打包工具自己生成的那份带 files[].url / sha512 / path，绝不能跟着网盘发出去。
  assert.doesNotMatch(CODE, /copyFileSync\(path\.join\(DIST_DIR, 'latest\.yml'\)/);
});

test('SHA-256 由 node 自己算，不依赖平台工具', () => {
  assert.match(CODE, /createHash\('sha256'\)/);
  assert.doesNotMatch(CODE, /certutil|Get-FileHash/);
});

test('包没打出来时说清楚该跑哪一步', () => {
  assert.match(CODE, /if \(!fs\.existsSync\(installerPath\)\)/);
  assert.match(CODE, /3-build\.bat/);
});

test('--dry-run 不落盘', () => {
  const main = slice('function main(', 'try {\n  main();');
  const dryRunAt = main.indexOf('options.dryRun');
  const firstWriteAt = main.indexOf('fs.mkdirSync(outDir');
  assert.ok(dryRunAt > 0, '--dry-run 分支丢了');
  assert.ok(firstWriteAt > dryRunAt, '--dry-run 必须早于任何写盘动作');
  const dryRunBlock = main.slice(dryRunAt, firstWriteAt);
  assert.doesNotMatch(dryRunBlock, /copyFileSync|writeFileSync|rmSync|mkdirSync/);
});
