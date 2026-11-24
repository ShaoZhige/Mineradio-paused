'use strict';

// 静态资源「原版 JS vs Rust」对照实验。
//
// 为什么不用整台 server.js 起服务：它有 electron 的顶层 require，纯 node 起不来。这里把
// server.js 末尾那段静态分发原样复制过来（`pn === '/'` → index.html、`/favicon.ico` →
// build/icon.ico），配上**真实的** `server/static-assets.js`。于是比对面收敛成"静态语义"
// 本身：状态码、Content-Type、Cache-Control、ETag、Last-Modified、实体字节、304 命中。
//
// 用法：
//   cargo build -p mineradio-server        # 先出二进制
//   node scripts/static-parity.js          # 自己起两个服务、比对、退出
//
// 退出码 0 = 全部一致。CI 里可直接当闸门用。

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { serveStatic } = require('../server/static-assets');

const PROJECT_ROOT = path.join(__dirname, '..');
const NODE_PORT = Number(process.env.PARITY_NODE_PORT || 18766);
const RUST_PORT = Number(process.env.PARITY_RUST_PORT || 18765);
const RUST_BIN = path.join(
  PROJECT_ROOT,
  'target',
  'debug',
  process.platform === 'win32' ? 'mineradio-server.exe' : 'mineradio-server'
);

// 覆盖每类分支：首页（URL 是 `/`，实体是 index.html）、普通静态、二进制、无扩展名、
// favicon（不在 public/ 下）、以及三种 404 形态。
const paths = [
  '/',
  '/index.html',
  '/js/index-loader.js',
  '/css/home.css',
  '/vendor/jieba-dict.txt',
  '/assets/skull-decimation-points.bin',
  '/vendor/music-tempo.LICENCE',
  '/favicon.ico',
  '/js/main.js',
  '/nope.js',
  '/js/',
];

const KEYS = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-length'];

const nodeServer = http.createServer((req, res) => {
  const pn = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pn === '/favicon.ico') {
    serveStatic(req, res, path.join(PROJECT_ROOT, 'build', 'icon.ico'));
    return;
  }
  const filePath = path.join(PROJECT_ROOT, 'public', pn === '/' ? '/index.html' : pn);
  serveStatic(req, res, filePath);
});

function fetchWith(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
  });
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

// 比对规则：2xx/304 比全（状态码 + 五个头 + 实体哈希）；4xx 只比状态码和实体。
// 4xx 的头本来就不一样——Node 的 `res.end('Not Found')` 走 chunked、不带 Content-Type，
// axum 会补 `text/plain` 和固定 Content-Length。这是传输细节，不影响任何前端行为。
function compare(a, b) {
  const diffs = [];
  if (a.status !== b.status) {
    diffs.push(`status ${a.status} vs ${b.status}`);
    return diffs;
  }
  if (sha(a.body) !== sha(b.body)) diffs.push(`body sha ${sha(a.body)} vs ${sha(b.body)}`);
  if (a.status >= 400) return diffs;
  for (const k of KEYS) {
    const va = a.headers[k] === undefined ? null : a.headers[k];
    const vb = b.headers[k] === undefined ? null : b.headers[k];
    if (va !== vb) diffs.push(`${k}: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`);
  }
  return diffs;
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetchWith(port, '/', {});
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`端口 ${port} 在 ${timeoutMs}ms 内没就绪`);
}

(async () => {
  if (!require('fs').existsSync(RUST_BIN)) {
    console.error(`找不到 ${RUST_BIN}\n先跑：cargo build -p mineradio-server`);
    process.exit(2);
  }

  await new Promise((r) => nodeServer.listen(NODE_PORT, '127.0.0.1', r));
  const child = spawn(RUST_BIN, ['--port', String(RUST_PORT)], { stdio: 'ignore' });

  const cleanup = () => {
    nodeServer.close();
    if (!child.killed) child.kill();
  };
  process.on('exit', cleanup);

  try {
    await Promise.all([waitReady(NODE_PORT), waitReady(RUST_PORT)]);
  } catch (e) {
    console.error(e.message);
    cleanup();
    process.exit(2);
  }

  let failures = 0;
  const rows = [];

  for (const p of paths) {
    const [a, b] = await Promise.all([fetchWith(NODE_PORT, p, {}), fetchWith(RUST_PORT, p, {})]);
    const diffs = compare(a, b);

    // 条件请求：拿**原版自己的 ETag** 再各请求一次。这条最关键——缓存语义错了不会报错，
    // 只会让每次启动都重新传 3.8 MB。
    if (a.status === 200 && a.headers.etag) {
      const [a2, b2] = await Promise.all([
        fetchWith(NODE_PORT, p, { 'if-none-match': a.headers.etag }),
        fetchWith(RUST_PORT, p, { 'if-none-match': a.headers.etag }),
      ]);
      if (a2.status !== b2.status) diffs.push(`条件请求 status ${a2.status} vs ${b2.status}`);
      if (a2.status === 304 && b2.body.length !== 0) diffs.push('304 却带了实体');
      if (a2.status === 304 && b2.headers.etag !== a.headers.etag) {
        diffs.push(`304 回写的 ETag 不同：${b2.headers.etag}`);
      }
    }

    if (diffs.length) failures += 1;
    rows.push({ path: p, status: a.status, ok: diffs.length === 0, diffs });
  }

  console.table(rows.map((r) => ({ path: r.path, status: r.status, match: r.ok ? 'YES' : 'NO' })));
  for (const r of rows) {
    if (!r.ok) {
      console.log(`\n[MISMATCH] ${r.path}`);
      for (const d of r.diffs) console.log('  - ' + d);
    }
  }
  console.log(`\n${rows.length - failures}/${rows.length} 条一致`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
})();
