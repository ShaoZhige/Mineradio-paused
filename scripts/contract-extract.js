#!/usr/bin/env node
'use strict';

/**
 * 契约冻结：从 server/server.js 与 desktop/preload.js 静态导出对外契约。
 *
 *   node scripts/contract-extract.js          生成 docs/API-CONTRACT.json
 *   node scripts/contract-extract.js --check   只校验，不一致则退出码 1（CI 用）
 *
 * 为什么是静态导出而不是运行时反射：
 *   - server.js 顶层 require('electron') 的模块（qishui-auth-v6、dj-analyzer-host）在纯 Node 下起不来，
 *     想运行时反射得先 stub 掉 Electron，比解析源码脆。
 *   - 契约要防的是「有人手滑删了/改了路由」，静态解析刚好只看源码本身。
 *
 * 输出必须确定性：全部排序、不含时间戳，这样 `--check` 才能做「重新生成 == 文件内容」的比对。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server', 'server.js');
const PRELOAD_PATH = path.join(ROOT, 'desktop', 'preload.js');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_PATH = path.join(ROOT, 'docs', 'API-CONTRACT.json');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

// ---------------------------------------------------------------------------
// 通用：把注释与字符串内容涂成空格，长度与位置不变。
// 这样后续按位置取的原文仍然对得上，但正则不会被注释里的冒号/括号误导。
// ---------------------------------------------------------------------------
function maskCommentsAndStrings(src) {
  const out = src.split('');
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === '\\') {
        out[i] = ' ';
        if (i + 1 < src.length) out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i += 1;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      out[i] = ' ';
      if (i + 1 < src.length) out[i + 1] = ' ';
      i += 2;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      quote = c;
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

// 从 openIdx 处的开括号出发，返回配对闭括号的下标（用已涂掩的文本算深度）。
function findMatching(masked, openIdx) {
  const open = masked[openIdx];
  const close = open === '{' ? '}' : open === '[' ? ']' : ')';
  let depth = 0;
  for (let i = openIdx; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 一、HTTP 路由
// server.js 用 `if (pn === '/api/xxx') { ... return; }` 手写分发，没有路由表对象，
// 所以按出现位置切片：每个路由的块 = 本处 → 下一处（或文件尾）。
// ---------------------------------------------------------------------------
function extractMethods(block) {
  const strict = new Set();
  const equals = new Set();
  for (const m of block.matchAll(/req\.method\s*!==\s*'([A-Z]+)'/g)) strict.add(m[1]);
  for (const m of block.matchAll(/req\.method\s*===\s*'([A-Z]+)'/g)) equals.add(m[1]);

  // `req.method === 'POST' ? await readRequestBody(req) : {}` 是「读不读 body」的分支，
  // 不是「只接受 POST」的闸门，所以含三元运算符时按「任意方法」记。
  const ternary = /req\.method\s*===\s*'POST'\s*\?/.test(block);

  if (strict.size > 0) {
    return { methods: [...strict].sort(), guard: 'post-only', note: '非该方法的请求被 405 拒绝' };
  }
  if (equals.has('GET') && equals.has('POST')) {
    return { methods: ['GET', 'POST'], guard: 'branched', note: '按方法分支处理' };
  }
  if (ternary) {
    return { methods: ['*'], guard: 'ternary', note: '任意方法可达，只有 POST 读 body' };
  }
  if (equals.size > 0) {
    return { methods: [...equals].sort(), guard: 'implicit', note: '只对某方法分支，其余方法走默认路径' };
  }
  return { methods: ['*'], guard: 'none', note: '不检查方法' };
}

function extractRoutes(src) {
  const re = /pn\s*===\s*'(\/api\/[^']*)'/g;
  const hits = [];
  let m;
  while ((m = re.exec(src))) hits.push({ route: m[1], index: m.index });

  return hits.map((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : src.length;
    const block = src.slice(hit.index, end);
    const { methods, guard, note } = extractMethods(block);
    const segments = hit.route.replace(/^\/api\//, '').split('/');
    return {
      path: hit.route,
      group: segments[0] || '',
      methods,
      guard,
      note,
      readsBody: /readRequestBody\s*\(/.test(block),
      easterEggGuarded: /LOGIN_EASTER_EGG/.test(block),
      line: lineOf(src, hit.index),
    };
  });
}

// ---------------------------------------------------------------------------
// 二、preload 桥（window.desktopWindow）
// 结构是字面量对象，可能有一层命名空间（如 halo），所以按「深度 1 的键」取顶层，
// 值是 `{` 时递归一层，最终摊平成 `halo.getConfig` 这种点路径。
// ---------------------------------------------------------------------------
function classifyValue(valueText) {
  const channels = [];
  // sendSync 必须单独统计：它是阻塞调用，Tauri 的 invoke 只有异步形态，
  // 这几个方法在 Rust 侧要靠「启动时预读 + 写时异步落盘」来伪造同步语义。
  for (const m of valueText.matchAll(/ipcRenderer\.(invoke|sendSync|send|on|once)\(\s*['"]([^'"]+)['"]/g)) {
    channels.push({ kind: m[1], channel: m[2] });
  }
  if (channels.length === 0) {
    if (/clipboard\./.test(valueText)) return { kind: 'clipboard', channels: [] };
    if (/webUtils\./.test(valueText)) return { kind: 'webUtils', channels: [] };
    // 不是函数就不是桥方法，只是暴露给渲染进程的常量/值（如 isDesktop、systemRelease）
    const isFunction = /=>|function\s*\(/.test(valueText);
    return { kind: isFunction ? 'local' : 'value', channels: [] };
  }
  const invoke = channels.filter((c) => c.kind === 'invoke');
  const sync = channels.filter((c) => c.kind === 'sendSync');
  const send = channels.filter((c) => c.kind === 'send');
  const on = channels.filter((c) => c.kind === 'on' || c.kind === 'once');
  let kind = 'mixed';
  if (invoke.length && !sync.length && !send.length && !on.length) kind = 'invoke';
  else if (sync.length && !invoke.length && !send.length && !on.length) kind = 'sendSync';
  else if (send.length && !invoke.length && !sync.length && !on.length) kind = 'send';
  else if (on.length && !invoke.length && !sync.length && !send.length) kind = 'event';
  return { kind, channels };
}

function extractBridge(src) {
  const exposeIdx = src.indexOf('exposeInMainWorld(\'desktopWindow\'');
  if (exposeIdx < 0) throw new Error('preload.js 里找不到 exposeInMainWorld(\'desktopWindow\')');
  const openIdx = src.indexOf('{', exposeIdx);
  const masked = maskCommentsAndStrings(src);
  const closeIdx = findMatching(masked, openIdx);
  if (closeIdx < 0) throw new Error('desktopWindow 对象未闭合');

  // from 处的字符刚好处在 depthBase 这一层（外层 `{` 在 from 之前），所以深度从 depthBase 起算。
  function entriesBetween(from, to, depthBase) {
    const found = [];
    for (const m of masked.slice(from, to).matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) {
      const keyStart = from + m.index;
      // 只认「本层」且前一个非空字符是 `{` 或 `,` 的键，排除属性值内部的对象字面量。
      let depth = depthBase;
      for (let i = from; i < keyStart; i += 1) {
        if (masked[i] === '{' || masked[i] === '[' || masked[i] === '(') depth += 1;
        else if (masked[i] === '}' || masked[i] === ']' || masked[i] === ')') depth -= 1;
      }
      if (depth !== depthBase) continue;
      let prev = keyStart - 1;
      while (prev >= from && /\s/.test(masked[prev])) prev -= 1;
      const prevCh = prev >= from ? masked[prev] : '{';
      if (prevCh !== '{' && prevCh !== ',') continue;
      found.push({ name: m[1], keyStart, valueStart: keyStart + m[0].length });
    }
    return found;
  }

  const flat = [];
  const topLevel = entriesBetween(openIdx + 1, closeIdx, 1);
  topLevel.forEach((entry, i) => {
    const valueEnd = i + 1 < topLevel.length ? topLevel[i + 1].keyStart : closeIdx;
    const valueText = src.slice(entry.valueStart, valueEnd);
    const maskedValue = masked.slice(entry.valueStart, valueEnd);
    const braceAt = maskedValue.search(/\S/);
    if (braceAt >= 0 && maskedValue[braceAt] === '{') {
      const childOpen = entry.valueStart + braceAt;
      const childClose = findMatching(masked, childOpen);
      const children = entriesBetween(childOpen + 1, childClose, 2);
      children.forEach((child, j) => {
        const childEnd = j + 1 < children.length ? children[j + 1].keyStart : childClose;
        const childText = src.slice(child.valueStart, childEnd);
        const info = classifyValue(childText);
        flat.push({
          name: `${entry.name}.${child.name}`,
          kind: info.kind,
          channels: [...new Set(info.channels.map((c) => `${c.kind}:${c.channel}`))].sort(),
          line: lineOf(src, child.keyStart),
        });
      });
      return;
    }
    const info = classifyValue(valueText);
    flat.push({
      name: entry.name,
      kind: info.kind,
      channels: [...new Set(info.channels.map((c) => `${c.kind}:${c.channel}`))].sort(),
      line: lineOf(src, entry.keyStart),
    });
  });

  return { topLevelCount: topLevel.length, entries: flat };
}

// ---------------------------------------------------------------------------
// 三、前端实际用到哪些 /api/ 路径
// 只认带引号/模板字符串的字面量，去掉 query 与模板插值，防止把注释里的示例算进去。
// ---------------------------------------------------------------------------
function walkJsFiles(dir, acc) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walkJsFiles(full, acc);
    else if (/\.(js|mjs)$/.test(name.name)) acc.push(full);
  }
  return acc;
}

function extractFrontendLiterals() {
  const files = fs.existsSync(PUBLIC_DIR) ? walkJsFiles(PUBLIC_DIR, []) : [];
  const set = new Map();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/['"`](\/api\/[^'"`\s]*)/g)) {
      let p = m[1].split('?')[0].split('#')[0].split('${')[0];
      if (p === '/api/' || p === '/api') continue;
      p = p.replace(/\/+$/, '');
      if (!set.has(p)) set.set(p, path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------
/**
 * 契约里有两块内容不是从源码推出来的，而是由 rust-anything 的分析结果填的。
 * 重新生成时原样保留，否则每次跑 --check 都会被自己擦掉。
 */
const EXTERNAL_FIELDS = ['portOrder', 'portOrderSource'];

function readExternalFields() {
  if (!fs.existsSync(OUT_PATH)) return {};
  try {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    const keep = {};
    for (const field of EXTERNAL_FIELDS) {
      if (prev[field] !== undefined) keep[field] = prev[field];
    }
    return keep;
  } catch (e) {
    // 旧文件坏了就当没有，不影响生成
    return {};
  }
}

function build() {
  const serverSrc = fs.readFileSync(SERVER_PATH, 'utf8');
  const preloadSrc = fs.readFileSync(PRELOAD_PATH, 'utf8');

  const routes = extractRoutes(serverSrc).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bridge = extractBridge(preloadSrc);
  const frontend = extractFrontendLiterals();

  const routePaths = new Set(routes.map((r) => r.path));
  const eventChannels = [];
  for (const entry of bridge.entries) {
    for (const ch of entry.channels) if (ch.startsWith('on:')) eventChannels.push(ch.slice(3));
  }

  // 前端字面量必须能在契约里找到（等于某条路由，或是它的前缀，带参数的路径按前缀算）
  const unmatched = [];
  for (const [literal, file] of [...frontend.entries()].sort()) {
    const ok = routePaths.has(literal) || [...routePaths].some((p) => p.startsWith(literal + '/') || literal.startsWith(p + '/'));
    if (!ok) unmatched.push({ literal, file });
  }
  // 反过来：契约里有、前端从没直接请求的（外部探针 / cuefield / 子进程会用，只做提示不报错）
  const unreferenced = routes
    .map((r) => r.path)
    .filter((p) => ![...frontend.keys()].some((lit) => lit === p || p.startsWith(lit + '/') || lit.startsWith(p + '/')));

  const groups = {};
  for (const r of routes) groups[r.group] = (groups[r.group] || 0) + 1;

  const kinds = {};
  for (const e of bridge.entries) kinds[e.kind] = (kinds[e.kind] || 0) + 1;

  // portOrder 由 rust-anything analyze 填，重生成时保留已有内容
  const external = readExternalFields();

  return {
    $schema: 'mineradio-api-contract/1',
    _doc: [
      '由 scripts/contract-extract.js 静态生成，请勿手改（portOrder 除外）。',
      'CI: npm run contract:check —— 重新生成后与文件内容逐字节比对。',
      'methods 为 ["*"] 表示该路由不检查请求方法。',
    ],
    sources: {
      server: 'server/server.js',
      preload: 'desktop/preload.js',
      frontendGlob: 'public/**/*.js',
    },
    counts: {
      routes: routes.length,
      bridgeTopLevel: bridge.topLevelCount,
      bridgeEntries: bridge.entries.length,
      events: new Set(eventChannels).size,
      frontendLiterals: frontend.size,
    },
    routesByGroup: groups,
    bridgeByKind: kinds,
    events: [...new Set(eventChannels)].sort(),
    routes,
    bridge: bridge.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    frontend: {
      unmatchedLiterals: unmatched,
      unreferencedRoutes: unreferenced.sort(),
    },
    portOrder: external.portOrder || [],
    ...(external.portOrderSource ? { portOrderSource: external.portOrderSource } : {}),
  };
}

function main() {
  const check = process.argv.includes('--check');
  const contract = build();
  const text = `${JSON.stringify(contract, null, 2)}\n`;

  if (check) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error('FAIL docs/API-CONTRACT.json 不存在，先跑 npm run contract:extract');
      process.exit(1);
    }
    const current = fs.readFileSync(OUT_PATH, 'utf8').replace(/\r\n/g, '\n');
    if (current !== text) {
      const cur = JSON.parse(current);
      const diffs = [];
      if (cur.counts.routes !== contract.counts.routes) diffs.push(`routes ${cur.counts.routes} → ${contract.counts.routes}`);
      if (cur.counts.bridgeEntries !== contract.counts.bridgeEntries) diffs.push(`bridge ${cur.counts.bridgeEntries} → ${contract.counts.bridgeEntries}`);
      console.error(`FAIL 契约与源码不一致：${diffs.join('；') || '内容有差异（顺序/字段）'}`);
      console.error('     改的是 server.js / preload.js 就重新跑 npm run contract:extract 并一起提交。');
      process.exit(1);
    }
    if (contract.frontend.unmatchedLiterals.length > 0) {
      console.error('FAIL 前端 /api/ 字面量不在契约里：');
      for (const u of contract.frontend.unmatchedLiterals) console.error(`     ${u.literal}  (${u.file})`);
      process.exit(1);
    }
    console.log(`OK 契约一致：${contract.counts.routes} 路由 / ${contract.counts.bridgeEntries} 桥项 / ${contract.counts.events} 事件`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, text, 'utf8');
  console.log(`已写入 docs/API-CONTRACT.json`);
  console.log(`  路由        ${contract.counts.routes}  (${Object.keys(contract.routesByGroup).length} 个域)`);
  console.log(`  桥顶层键    ${contract.counts.bridgeTopLevel}`);
  console.log(`  桥摊平项    ${contract.counts.bridgeEntries}  ${JSON.stringify(contract.bridgeByKind)}`);
  console.log(`  事件通道    ${contract.counts.events}`);
  console.log(`  前端字面量  ${contract.counts.frontendLiterals}`);
  if (contract.frontend.unmatchedLiterals.length > 0) {
    console.log(`  ⚠ 契约外字面量 ${contract.frontend.unmatchedLiterals.length} 条（--check 会失败）`);
    for (const u of contract.frontend.unmatchedLiterals.slice(0, 10)) console.log(`      ${u.literal}  (${u.file})`);
  }
  if (contract.frontend.unreferencedRoutes.length > 0) {
    console.log(`  ⚠ 前端未直接请求的路由 ${contract.frontend.unreferencedRoutes.length} 条（外部探针/子进程可能用，仅提示）`);
  }
}

main();
