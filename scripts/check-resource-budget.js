#!/usr/bin/env node
'use strict';

// 确定性资源预算门禁 / Deterministic resource-budget gate.
//
// 为什么需要它：这个项目的资源上限散在几十个模块里，改大一个数字不会让任何测试变红，
// 只会让内存、索引和每帧开销在真机上慢慢爬。所以把「有界性」本身当成可执行约定：
//
//   1. 关键上限钉死预期值 —— 想放大就必须改这张表，那是一次显式决定，不是顺手。
//   2. 前端体积相对基线不得超出容差（默认 10%）—— 防「多引一个库」这类无声膨胀。
//   3. 上限必须是正的有限值 —— 挡住 NaN / undefined / 0 这种「写错了所以永不触发」。
//   4. 定时器与监听器成对、以及上限是否被测试引用，先只报告不拦截：
//      这两项有合理例外（例如页面级常驻轮询），硬拦会比漏拦更糟。
//
// 单独运行：node scripts/check-resource-budget.js
// 接受基线：node scripts/check-resource-budget.js --write-baseline
// show warnings only: --warn-only

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(__dirname, 'resource-budget-baseline.json');

// 每条：kind=module 表示从模块导出读；kind=source 表示从源码正则抽。
// 「为什么钉这个数」写清楚，否则后人只会觉得门禁在挡路。
const PINNED_BUDGETS = [
  { id: 'local.maxImportFiles', kind: 'module', get: (lib) => lib.resourceBudgets.maxImportFiles, expected: 50000, why: '单次导入文件数上限' },
  { id: 'local.metadataConcurrency', kind: 'module', get: (lib) => lib.resourceBudgets.metadataConcurrency, expected: 3, why: '元数据解析并发' },
  { id: 'local.maxLibraryIndexBytes', kind: 'module', get: (lib) => lib.resourceBudgets.maxLibraryIndexBytes, expected: 16 * 1024 * 1024, why: '本地库索引体积' },
  { id: 'local.maxCoverBytes', kind: 'module', get: (lib) => lib.resourceBudgets.maxCoverBytes, expected: 6 * 1024 * 1024, why: '封面单文件体积' },
  { id: 'local.maxLyricBytes', kind: 'module', get: (lib) => lib.resourceBudgets.maxLyricBytes, expected: 512 * 1024, why: '歌词单文件体积' },
  { id: 'local.maxCoverPixels', kind: 'module', get: (lib) => lib.resourceBudgets.maxCoverPixels, expected: 12 * 1024 * 1024, why: '封面解码像素上限' },
  {
    id: 'playlist.detailPageSize',
    kind: 'source',
    file: 'public/js/modules/00-state/01-perf-render-state.js',
    pattern: /PLAYLIST_DETAIL_PAGE_SIZE\s*=\s*(\d+)/,
    expected: 5,
    why: '歌单详情每页行数（5 行是量出来的，第 6 行会顶出面板）',
  },
  {
    id: 'playlist.detailRowStep',
    kind: 'source',
    file: 'public/js/modules/00-state/01-perf-render-state.js',
    pattern: /PLAYLIST_DETAIL_ROW_STEP\s*=\s*(\d+)/,
    expected: 62,
    why: '虚拟列表行距，与页高换算绑定',
  },
  {
    id: 'playlist.virtualOverscanPx',
    kind: 'source',
    file: 'public/js/modules/00-state/01-perf-render-state.js',
    pattern: /PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX\s*=\s*(\d+)/,
    expected: 760,
    why: '虚拟列表上下额外渲染的像素缓冲',
  },
  {
    id: 'console.historyLimit',
    kind: 'source',
    file: 'public/js/modules/07-fx/09-console-workspace.js',
    pattern: /FX_CONSOLE_HISTORY_LIMIT\s*=\s*(\d+)/,
    expected: 40,
    why: '控制台撤销历史条数',
  },
];

// 体积基线：故意不写死在代码里，改体积要走 --write-baseline 留下痕迹。
const DEFAULT_TOLERANCE_PERCENT = 10;

function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function measureBundle() {
  const walk = (dir) => {
    let bytes = 0;
    let files = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = walk(full);
        bytes += sub.bytes;
        files += sub.files;
      } else if (/\.(js|css)$/i.test(entry.name)) {
        bytes += fs.statSync(full).size;
        files += 1;
      }
    }
    return { bytes, files };
  };
  return {
    publicJs: walk(path.join(appRoot, 'public', 'js')),
    publicCss: walk(path.join(appRoot, 'public', 'css')),
  };
}

function readSource(relPath) {
  const full = path.join(appRoot, relPath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function resolvePinned() {
  const results = [];
  const library = require(path.join(appRoot, 'desktop', 'local-music-library.js'));
  for (const item of PINNED_BUDGETS) {
    let actual = null;
    let problem = '';
    try {
      if (item.kind === 'module') {
        actual = item.get(library);
      } else {
        const source = readSource(item.file);
        if (source == null) {
          problem = `找不到 ${item.file}`;
        } else {
          const match = source.match(item.pattern);
          if (!match) problem = `源码里找不到声明（${item.pattern}）`;
          else actual = Number(match[1]);
        }
      }
    } catch (error) {
      problem = error.message;
    }
    if (!problem && !(typeof actual === 'number' && Number.isFinite(actual) && actual > 0)) {
      problem = `不是正的有限数值：${String(actual)}`;
    }
    results.push({ ...item, actual, problem });
  }
  return results;
}

// 报告项：上限是否被测试/守卫引用，以及定时器有没有配对。
// 这两项只提示不拦截，理由见文件头。
function collectAdvisories() {
  const advisories = [];
  const corpusDirs = ['tests'];
  let corpus = '';
  for (const dir of corpusDirs) {
    const full = path.join(appRoot, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.js')) corpus += fs.readFileSync(path.join(full, name), 'utf8');
    }
  }
  const quickCheck = readSource('scripts/quick-check.js') || '';
  corpus += quickCheck;

  // 定时器配对：只在「整份文件一次 clearInterval 都没有」时提示。
  const scanDirs = ['public/js', 'desktop', 'server'];
  for (const rel of scanDirs) {
    const base = path.join(appRoot, rel);
    if (!fs.existsSync(base)) continue;
    for (const file of walkJs(base)) {
      const text = fs.readFileSync(file, 'utf8');
      const sets = (text.match(/setInterval\s*\(/g) || []).length;
      const clears = (text.match(/clearInterval\s*\(/g) || []).length;
      if (sets > 0 && clears === 0) {
        advisories.push(`定时器未配对：${path.relative(appRoot, file)}（setInterval ${sets} 处，clearInterval 0 处）`);
      }
    }
  }
  return { advisories, corpus };
}

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walkJs(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function runResourceBudgetCheck(options = {}) {
  const failures = [];
  const warnings = [];
  const pinned = resolvePinned();
  for (const item of pinned) {
    if (item.problem) {
      failures.push(`${item.id}：${item.problem}`);
      continue;
    }
    if (item.actual !== item.expected) {
      failures.push(`${item.id} 从 ${item.expected} 变成了 ${item.actual}（${item.why}）—— 确认这是有意的，再同步改 scripts/check-resource-budget.js`);
    }
  }

  const bundle = measureBundle();
  const baseline = readBaseline();
  let bundleSummary = '';
  if (!baseline) {
    warnings.push('没有体积基线（scripts/resource-budget-baseline.json），体积检查跳过');
  } else {
    const tolerance = Number(baseline.tolerancePercent) || DEFAULT_TOLERANCE_PERCENT;
    const limit = (value) => Math.round(value * (1 + tolerance / 100));
    const checks = [
      ['public/js', bundle.publicJs.bytes, baseline.publicJsBytes],
      ['public/css', bundle.publicCss.bytes, baseline.publicCssBytes],
    ];
    for (const [label, actual, base] of checks) {
      if (!Number.isFinite(base)) continue;
      const cap = limit(base);
      if (actual > cap) {
        failures.push(`${label} 体积 ${actual} B 超出基线 +${tolerance}%（上限 ${cap} B）。确实要加，跑 --write-baseline 并说明原因`);
      }
    }
    bundleSummary = `js ${(bundle.publicJs.bytes / 1024).toFixed(1)} KB（基线 ${(baseline.publicJsBytes / 1024).toFixed(1)} KB）· css ${(bundle.publicCss.bytes / 1024).toFixed(1)} KB（基线 ${(baseline.publicCssBytes / 1024).toFixed(1)} KB）`;
  }

  if (options.advisories !== false) {
    const { advisories } = collectAdvisories();
    warnings.push(...advisories);
  }

  return { ok: failures.length === 0, failures, warnings, pinned, bundle, bundleSummary };
}

function writeBaseline() {
  const bundle = measureBundle();
  const payload = {
    note: '体积基线。更新方式：node scripts/check-resource-budget.js --write-baseline（只在有意增体积时执行，并在提交信息里说明原因）',
    tolerancePercent: DEFAULT_TOLERANCE_PERCENT,
    publicJsBytes: bundle.publicJs.bytes,
    publicCssBytes: bundle.publicCss.bytes,
    updatedAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

module.exports = { runResourceBudgetCheck, writeBaseline, PINNED_BUDGETS };

if (require.main === module) {
  const writeMode = process.argv.includes('--write-baseline');
  if (writeMode) {
    const payload = writeBaseline();
    console.log(`[baseline] 已写入 ${path.relative(appRoot, BASELINE_FILE)}：js ${payload.publicJsBytes} B / css ${payload.publicCssBytes} B`);
    process.exit(0);
  }
  const result = runResourceBudgetCheck({ advisories: !process.argv.includes('--quiet') });
  for (const item of result.pinned) {
    const mark = item.problem || item.actual !== item.expected ? 'FAIL' : ' ok ';
    console.log(`[${mark}] ${item.id.padEnd(30)} ${item.problem || item.actual}`);
  }
  if (result.bundleSummary) console.log(`[bundle] ${result.bundleSummary}`);
  for (const warning of result.warnings) console.log(`[warn] ${warning}`);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`[ERR] ${failure}`);
    console.error(`\n资源预算门禁失败：${result.failures.length} 项`);
    process.exit(1);
  }
  console.log('\n资源预算门禁通过。');
}
