#!/usr/bin/env node
// 把刚打好的安装包归档到仓库上一级的 releases\<tag>\ ，供上传网盘与日后回查。
//
// 为什么不再从云端取：GitHub runner 的产物要在这台机器上下回来，95 MB 得二十多分钟，
// 中途还会断流；本地自己构建只要两分钟。既然两边都是同一条提交打出来的，留本地那份
// 就够用了 —— 云端那份的职责只是挂在 Release 上给用户下载。
//
// Archive the installer we just built into ..\releases\<tag>\. The cloud copy exists only
// to be published as a Release asset; downloading it here costs twenty minutes on this
// link, while building locally costs two.
//
// 目录语义：同版本目录已存在就往里覆盖，不存在就新建。两个版本的包不会混在一起 ——
// 归档时会把该目录里其它版本的安装包和校验和清掉，免得传网盘时拿错。
//
// Usage:
//   node scripts/archive-release-build.mjs                # 版本取自 package.json
//   node scripts/archive-release-build.mjs --tag v2.6.1   # 必须与 package.json 一致
//   node scripts/archive-release-build.mjs --out D:/dist  # 自定义归档目录
//   node scripts/archive-release-build.mjs --dry-run      # 只说要动哪些文件

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const MANIFEST_SRC = path.join(REPO_ROOT, 'docs', 'update', 'latest.yml');
const RELEASES_ROOT = path.resolve(REPO_ROOT, '..', 'releases');

function log(message) {
  process.stdout.write(message + '\n');
}

function fail(message) {
  process.stderr.write('\n[失败] ' + message + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const options = { tag: '', outDir: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tag') options.tag = (argv[++i] || '').trim();
    else if (arg === '--out') options.outDir = (argv[++i] || '').trim();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      log('用法: node scripts/archive-release-build.mjs [--tag vX.Y.Z] [--out <目录>] [--dry-run]');
      process.exit(0);
    } else fail('不认识的参数：' + arg);
  }
  return options;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

function sha256(filePath) {
  const hash = createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

// 备用更新线路读的极简清单必须与包版本一致。漏改过一次（停在 2.2.0），备用线路从此
// 读到「没有新版本」，静默失效且不报错。
function assertManifestVersion(version) {
  if (!fs.existsSync(MANIFEST_SRC)) fail('缺少 docs/update/latest.yml，无法生成备用更新清单。');
  const text = fs.readFileSync(MANIFEST_SRC, 'utf8');
  const match = text.match(/^version:\s*(\S+)\s*$/m);
  const manifestVersion = match ? match[1].replace(/^['"]|['"]$/g, '') : '';
  if (manifestVersion !== version) {
    fail(
      'docs/update/latest.yml 的 version 是 ' +
        (manifestVersion || '（缺失）') +
        '，与 package.json 的 ' +
        version +
        ' 不一致。\n  先改 docs/update/latest.yml，否则备用更新线路会静默失效。',
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!version) fail('package.json 里没有 version。');

  const tag = options.tag || 'v' + version;
  if (tag !== 'v' + version) {
    fail('tag ' + tag + ' 与 package.json 的版本（v' + version + '）不一致。先统一版本号。');
  }

  const installerName = 'Mineradio-' + version + '-Setup.exe';
  const sumsName = 'Mineradio-' + version + '-SHA256SUMS.txt';
  const installerPath = path.join(DIST_DIR, installerName);
  if (!fs.existsSync(installerPath)) {
    fail('dist 里没有 ' + installerName + '。先跑 3-build.bat 的 [2] 打包。');
  }
  assertManifestVersion(version);

  const outDir = options.outDir ? path.resolve(options.outDir) : path.join(RELEASES_ROOT, tag);
  const hash = sha256(installerPath);
  const size = fs.statSync(installerPath).size;

  // 同版本目录一般早就在了（上次传网盘留下的），直接覆盖；没有就建。
  const existing = fs.existsSync(outDir);
  if (options.dryRun) {
    log('[--dry-run] 归档目录：' + outDir + (existing ? '（已存在，覆盖）' : '（新建）'));
    log('[--dry-run] 将写入：' + installerName + ' ' + formatSize(size));
    log('[--dry-run] 将写入：latest.yml / ' + sumsName);
    log('[--dry-run] 未改动任何文件。');
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  // 目录里不该同时躺着两个版本的安装包：清掉本版本之外的同名模式文件。
  for (const entry of fs.readdirSync(outDir)) {
    const staleInstaller = /-Setup\.exe$/i.test(entry) && entry !== installerName;
    const staleSums = /SHA256SUMS\.txt$/i.test(entry) && entry !== sumsName;
    if (staleInstaller || staleSums) {
      fs.rmSync(path.join(outDir, entry), { force: true });
      log('  清掉旧产物：' + entry);
    }
  }

  // 校验和写在 dist 里，与 CI 同格式：`<hash>  <文件名>`。
  fs.writeFileSync(path.join(DIST_DIR, sumsName), hash + '  ' + installerName + '\n', 'utf8');

  // 用仓库内的极简清单覆盖 electron-builder 生成的那份。后者带 files[].url / sha512 /
  // path，配上 blockmap 就是完整的自动更新源；这份归档文件是要跟着网盘分发的，不能带。
  // Overwrite the builder-generated manifest: the archived copy travels with the mirror
  // download, and that manifest would be a working auto-update feed.
  fs.copyFileSync(MANIFEST_SRC, path.join(outDir, 'latest.yml'));

  for (const name of [installerName, sumsName]) {
    fs.copyFileSync(path.join(DIST_DIR, name), path.join(outDir, name));
  }

  log('\n已归档（' + (existing ? '覆盖' : '新建') + '）：' + outDir);
  log('  ' + installerName.padEnd(38) + formatSize(size));
  log('  latest.yml'.padEnd(40) + '极简清单');
  log('  ' + sumsName);
  log('\n安装包：' + path.join(outDir, installerName));
  log('SHA-256：' + hash);
  log('\n可以直接把这个目录里的安装包传到阿里云盘 / 蓝奏云。');
}

try {
  main();
} catch (error) {
  fail(error && error.stack ? error.stack : String(error));
}
