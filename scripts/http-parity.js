'use strict';

// HTTP 客户端「Node 原版 vs Rust」对照实验。
//
// 为什么需要它：`requestText` 里真正决定行为的不是那十几行代码，而是五个容易被
// 默认值掩盖的细节 —— 解不解压、走不走代理、跟不跟重定向、body 按什么字符集解码、
// 以及**超时是"空闲"还是"总时长"**。前四个在正常网络下几乎看不出来，第五个只在
// 长连接上显形。所以这里起一台行为可编排的本地服务器，让两边跑同一批用例。
//
// 最有价值的是 `/slow-drip`：服务器每 120ms 吐一块、共 6 块（总 720ms），而超时设
// 300ms。Node 的 socket 空闲超时不会触发（一直有数据），所以成功；换成 `reqwest` 的
// `timeout()`（总时长）就会在第 300ms 被斩断。这个用例直接证明超时语义对齐了。
//
// 用法：
//   cargo build -p mineradio-http --example http_probe
//   node scripts/http-parity.js
//
// 退出码 0 = 全部一致（已知偏差除外）。

const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PARITY_HTTP_PORT || 18767);
const BASE = `http://127.0.0.1:${PORT}`;
const PROBE = path.join(
  PROJECT_ROOT,
  'target',
  'debug',
  'examples',
  process.platform === 'win32' ? 'http_probe.exe' : 'http_probe',
);

// 用来在服务器侧区分"这次请求是谁发的"，比较请求头时会被剔除。
const WHO_HEADER = 'x-parity-who';

// ---------- Node 侧：照抄 server.js 的 requestText ----------
// 一行都不能改 —— 它就是要被对照的那份实现。
function requestText(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(text);
      });
    });
    req.setTimeout(opts.timeoutMs || 10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('Invalid JSON from ' + targetUrl);
    err.cause = e;
    throw err;
  }
}

// 把 Node 的 Error 归成与 Rust 侧同一套 kind，好比对。
function classifyNodeError(err) {
  const message = String(err && err.message || '');
  if (message === 'Request timeout') return 'timeout';
  if (/^HTTP \d+$/.test(message)) return 'status';
  if (message.startsWith('Invalid JSON from ')) return 'invalidjson';
  return 'network';
}

// ---------- 可编排的本地服务器 ----------
const seen = [];

const routes = {
  '/ok': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('hello');
  },
  '/bom': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    // UTF-8 BOM。两边都该原样保留成 U+FEFF。
    res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]));
  },
  '/emoji': (req, res) => {
    res.writeHead(200);
    res.end('🌈 小马');
  },
  '/invalid-utf8': (req, res) => {
    res.writeHead(200);
    // 0xFF 0xFE 不是合法 UTF-8 起始字节 → 两边都该产出 U+FFFD。
    res.end(Buffer.from([0xff, 0xfe, 0x41]));
  },
  '/gbk-declared': (req, res) => {
    // 声明 gbk 但 body 是 UTF-8 的字节。启了 charset feature 的客户端会按 gbk 解，
    // 得到另一串乱码；Node 一律按 UTF-8 解。这条专门盯着那个 feature。
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=gbk' });
    res.end(Buffer.from('小马', 'utf8'));
  },
  '/404': (req, res) => {
    res.writeHead(404);
    res.end('not found');
  },
  '/500-big': (req, res) => {
    res.writeHead(500);
    // 64 KB，验证"出错时 body 也读完了"（Node 是先拼完 chunks 再判状态码）。
    res.end('x'.repeat(64 * 1024));
  },
  '/json': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ a: 1, b: [2, 3], c: '小马' }));
  },
  '/bad-json': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{a:1}');
  },
  '/slow-first-byte': (req, res) => {
    // 头都不发，先干等 1.5s。
    setTimeout(() => {
      res.writeHead(200);
      res.end('late');
    }, 1500);
  },
  '/hang': () => {
    // 收下请求，永远不应答。靠客户端自己的超时兜底。
  },
  '/slow-drip': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    let index = 0;
    const timer = setInterval(() => {
      res.write(`chunk${index}\n`);
      index += 1;
      if (index >= 6) {
        clearInterval(timer);
        res.end();
      }
    }, 120);
  },
  '/redirect': (req, res) => {
    res.writeHead(302, { Location: '/ok' });
    res.end();
  },
  '/echo': (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${req.method} ${Buffer.concat(chunks).toString('utf8')}`);
    });
  },
};

const HANGING = new Set();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const who = req.headers[WHO_HEADER] || '(none)';
  const headers = {};
  Object.keys(req.headers)
    .filter(key => key !== WHO_HEADER)
    .sort()
    .forEach(key => {
      headers[key] = req.headers[key];
    });
  seen.push({ path: url.pathname, who, headers });

  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(404);
    res.end('no route');
    return;
  }
  if (url.pathname === '/hang') HANGING.add(res);
  handler(req, res);
});

// ---------- 用例 ----------
// `timeoutMs` 不给就用默认 10s；`expect` 只是给人看的预期，真正的判定是两边一致。
const CASES = [
  { name: 'ok', path: '/ok' },
  { name: 'bom', path: '/bom' },
  { name: 'emoji', path: '/emoji' },
  { name: 'invalid-utf8', path: '/invalid-utf8' },
  { name: 'gbk-declared', path: '/gbk-declared' },
  { name: '404', path: '/404' },
  { name: '500-big', path: '/500-big' },
  { name: 'json-ok', path: '/json', json: true },
  { name: 'json-bad', path: '/bad-json', json: true },
  { name: 'redirect-302', path: '/redirect' },
  { name: 'post-echo', path: '/echo', method: 'POST', body: 'payload=小马' },
  // 不用 GET：Node 的 http.request 对 GET 会丢弃 write 的内容、服务器直接 400，
  // 属于畸形用法（真实代码里也没有 requestText(url, {}, body) 这种调用）。
  { name: 'put-with-body', path: '/echo', method: 'PUT', body: 'x' },
  { name: 'refused', url: 'http://127.0.0.1:1/nope' },
  { name: 'slow-first-byte', path: '/slow-first-byte', timeoutMs: 300 },
  { name: 'hang', path: '/hang', timeoutMs: 300 },
  // 核心用例：超时 300ms，但每 120ms 都有数据 → 不该超时。
  { name: 'slow-drip', path: '/slow-drip', timeoutMs: 300 },
];

function buildNodeTask(testCase) {
  const url = testCase.url || BASE + testCase.path;
  const opts = { headers: { [WHO_HEADER]: 'node' } };
  if (testCase.method) opts.method = testCase.method;
  if (testCase.timeoutMs) opts.timeoutMs = testCase.timeoutMs;
  return { url, opts, body: testCase.body };
}

function buildRustTask(testCase) {
  const task = {
    url: testCase.url || BASE + testCase.path,
    headers: [[WHO_HEADER, 'rust']],
    json: Boolean(testCase.json),
  };
  if (testCase.method) task.method = testCase.method;
  if (testCase.body) task.body = testCase.body;
  if (testCase.timeoutMs) task.timeoutMs = testCase.timeoutMs;
  return task;
}

async function runNode(testCase) {
  const { url, opts, body } = buildNodeTask(testCase);
  const started = Date.now();
  try {
    const text = testCase.json
      ? JSON.stringify(await requestJson(url, opts, body))
      : await requestText(url, opts, body);
    return { ok: text, elapsedMs: Date.now() - started };
  } catch (err) {
    return {
      err: {
        kind: classifyNodeError(err),
        message: String(err && err.message || err),
        status: err && err.statusCode,
        body: err && err.body,
      },
      elapsedMs: Date.now() - started,
    };
  }
}

function runRust(testCase) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(PROBE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => {
      out += chunk;
    });
    child.stderr.on('data', chunk => {
      err += chunk;
    });
    child.stdin.end(JSON.stringify(buildRustTask(testCase)) + '\n');
    // 兜底：探针自己该在 timeoutMs 内返回，8s 还没动静就判定它挂住了。
    const killer = setTimeout(() => child.kill(), 8000);
    child.on('close', () => {
      clearTimeout(killer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      if (!line) {
        resolve({ err: { kind: 'probe-crashed', message: err.trim() || '(no output)' }, elapsedMs: Date.now() - started });
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (parseErr) {
        resolve({ err: { kind: 'probe-garbage', message: `${line} / ${parseErr.message}` }, elapsedMs: Date.now() - started });
      }
    });
  });
}

// ---------- 比对 ----------
function normalize(result) {
  if (result.ok !== undefined) {
    // json 模式下 Node 侧给的是字符串、Rust 侧给的是对象，统一 stringify 再比。
    const value = typeof result.ok === 'string' ? result.ok : JSON.stringify(result.ok);
    return { kind: 'ok', value };
  }
  const err = result.err || {};
  return {
    kind: err.kind,
    message: err.message,
    status: err.status === null ? undefined : err.status,
    body: err.body === null ? undefined : err.body,
  };
}

function compare(nodeResult, rustResult) {
  const a = normalize(nodeResult);
  const b = normalize(rustResult);
  const problems = [];

  if (a.kind !== b.kind) {
    problems.push(`kind: node=${a.kind} rust=${b.kind}`);
  }
  if (a.kind === 'ok' && b.kind === 'ok') {
    if (a.value !== b.value) {
      problems.push(`body 不同：node=${JSON.stringify(a.value).slice(0, 120)} rust=${JSON.stringify(b.value).slice(0, 120)}`);
    }
    return problems;
  }
  if (a.kind === 'status') {
    if (a.status !== b.status) problems.push(`status: node=${a.status} rust=${b.status}`);
    if (a.message !== b.message) problems.push(`message: node=${a.message} rust=${b.message}`);
    const nodeBody = a.body === undefined ? '' : a.body;
    const rustBody = b.body === undefined ? '' : b.body;
    if (nodeBody !== rustBody) {
      problems.push(`错误体不同：node=${JSON.stringify(nodeBody).slice(0, 80)} rust=${JSON.stringify(rustBody).slice(0, 80)}`);
    }
  }
  if (a.kind === 'invalidjson' && a.message !== b.message) {
    problems.push(`message: node=${a.message} rust=${b.message}`);
  }
  // network 只比 kind：两边的底层错误文本必然不同（libuv 的 errno 字符串 vs hyper 的
  // 错误链），这一条是模块头部写明的已知偏差。
  return problems;
}

// 服务器看到的请求头：只允许这些差异，其余都算回归。
const ALLOWED_HEADER_DIFFS = new Set([
  // reqwest 在用户没设 accept 时补这一行，Node 什么都不加。见 client.rs 已知偏差 1。
  'accept',
  // 连接管理策略不同（Node 走 agent 的连接池，reqwest 自己一套）。
  'connection',
]);

function compareHeaders(nodeHeaders, rustHeaders) {
  const problems = [];
  const keys = new Set([...Object.keys(nodeHeaders), ...Object.keys(rustHeaders)]);
  for (const key of keys) {
    if (ALLOWED_HEADER_DIFFS.has(key)) continue;
    if (nodeHeaders[key] !== rustHeaders[key]) {
      problems.push(`头 ${key}: node=${JSON.stringify(nodeHeaders[key])} rust=${JSON.stringify(rustHeaders[key])}`);
    }
  }
  return problems;
}

// ---------- 主流程 ----------
function ensureProbe() {
  if (require('fs').existsSync(PROBE)) return true;
  console.error(`找不到 ${PROBE}\n先跑：cargo build -p mineradio-http --example http_probe`);
  return false;
}

async function main() {
  if (!ensureProbe()) process.exit(2);

  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

  let failed = 0;
  const rows = [];

  for (const testCase of CASES) {
    const seenBefore = seen.length;
    const nodeResult = await runNode(testCase);
    const rustResult = await runRust(testCase);
    const newSeen = seen.slice(seenBefore);
    const nodeSeen = newSeen.find(entry => entry.who === 'node');
    const rustSeen = newSeen.find(entry => entry.who === 'rust');

    const problems = compare(nodeResult, rustResult);
    if (nodeSeen && rustSeen) {
      problems.push(...compareHeaders(nodeSeen.headers, rustSeen.headers));
    } else if (!testCase.url) {
      problems.push(`服务器只收到 ${newSeen.length} 个请求，无法比请求头`);
    }

    const shape = normalize(nodeResult);
    const detail = shape.kind === 'ok'
      ? `ok(${String(shape.value).length}B)`
      : `${shape.kind}${shape.status ? ':' + shape.status : ''}`;
    rows.push({
      name: testCase.name,
      detail,
      nodeMs: nodeResult.elapsedMs,
      rustMs: rustResult.elapsedMs,
      problems,
    });
    if (problems.length) failed += 1;
  }

  // 报告
  const nameWidth = Math.max(...rows.map(row => row.name.length), 4);
  console.log('');
  for (const row of rows) {
    const mark = row.problems.length ? 'FAIL' : ' ok ';
    console.log(
      `[${mark}] ${row.name.padEnd(nameWidth)}  ${row.detail.padEnd(22)} node ${String(row.nodeMs).padStart(5)}ms  rust ${String(row.rustMs).padStart(5)}ms`,
    );
    for (const problem of row.problems) console.log(`         └─ ${problem}`);
  }
  console.log('');

  const slowDrip = rows.find(row => row.name === 'slow-drip');
  if (slowDrip && slowDrip.problems.length) {
    console.error('🔴 slow-drip 不一致：超时语义没对齐（多半是把 socket 空闲超时写成了总超时）');
  }

  for (const res of HANGING) res.destroy();
  server.close();

  if (failed > 0) {
    console.error(`FAIL ${failed}/${rows.length} 个用例不一致`);
    process.exit(1);
  }
  console.log(`OK ${rows.length}/${rows.length} 个用例一致`);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
