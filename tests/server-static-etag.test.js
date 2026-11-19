'use strict';

// 静态资源条件请求（ETag + 304）回归测试
//
// 背景：server.js 早年对所有静态文件一律发 `Cache-Control: no-store`，而前端 index-loader 又给
// 每个模块 URL 拼 `?v=<Date.now()>`。两者叠加等于每次启动都宣告 public/js 下 142 个文件
// （共 3.8 MB）是全新资源 —— 浏览器副本用不上、V8 编译缓存也用不上，启动时要重新读盘、
// 传输、解析编译一遍。
//
// 现在改成标准条件请求。这个测试盯住三件最容易改坏的事：
//   1. ETag 必须随文件内容/时间变化 —— 否则改了代码刷新还是旧的（"我改了但没生效"）
//   2. ETag 相同时必须回 304 且不带正文 —— 否则优化等于没做
//   3. 不许悄悄退回 no-store —— 那会让浏览器连副本都不存
//
// Background: static files used to answer with a blanket `no-store` while index-loader appended
// `?v=<Date.now()>` to every module URL, so all 142 files under public/js (3.8 MB) looked brand new
// on every launch. This test pins the three things that are easy to break: the ETag has to track
// the file, a matching ETag has to produce a bodyless 304, and `no-store` must not come back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { staticEtag, etagMatches, serveStatic } = require('../server/static-assets');

const appRoot = path.resolve(__dirname, '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-etag-'));
}

// 用 serveStatic 起一个真实的最小 HTTP 服务：测的是生产代码本身，不是复刻版。
// A real minimal HTTP server wired to serveStatic, so the production code is what gets exercised.
function withStaticServer(rootDir, run) {
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname;
    serveStatic(req, res, path.join(rootDir, urlPath === '/' ? '/index.html' : urlPath));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await run(base));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
    server.on('error', reject);
  });
}

test('ETag tracks file size and mtime, and is stable when neither changes', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.js');
  fs.writeFileSync(file, 'console.log(1);', 'utf8');

  const first = staticEtag(fs.statSync(file));
  const again = staticEtag(fs.statSync(file));
  assert.equal(first, again, '同一个未修改的文件必须给出同一个 ETag，否则每次都是 200');
  assert.match(first, /^W\/"[0-9a-f]+-[0-9a-f]+"$/, 'ETag 形状必须是 weak + size + mtime');

  // 内容变长 → size 变 → ETag 必须跟着变，否则改了代码刷新还是旧的。
  fs.writeFileSync(file, 'console.log(12);', 'utf8');
  assert.notEqual(staticEtag(fs.statSync(file)), first, '文件改过之后 ETag 必须变');

  // 只动 mtime 不动内容也必须变：这是"保存了但内容碰巧一样"的场景。
  const stat = fs.statSync(file);
  const touched = { size: stat.size, mtimeMs: stat.mtimeMs + 1000 };
  assert.notEqual(staticEtag(touched), staticEtag(stat), 'mtime 变了 ETag 也要变');
});

test('If-None-Match accepts a single tag and a comma-separated list', () => {
  const etag = 'W/"10-abc"';
  assert.equal(etagMatches(etag, etag), true);
  assert.equal(etagMatches(`W/"dead-beef", ${etag}`, etag), true);
  assert.equal(etagMatches(` ${etag} `, etag), true, '两侧空白要容忍');
  assert.equal(etagMatches('W/"other"', etag), false);
  assert.equal(etagMatches('', etag), false);
  assert.equal(etagMatches(undefined, etag), false);
});

test('an unchanged file answers 304 with no body, a changed one answers 200', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'app.js'), 'var a = 1;', 'utf8');

  await withStaticServer(dir, async (base) => {
    const first = await fetch(`${base}/app.js`);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag, '200 必须带 ETag');
    assert.equal(first.headers.get('cache-control'), 'no-cache', '必须是 no-cache（可存但须验证）');
    assert.ok(!/no-store/.test(first.headers.get('cache-control') || ''), '不许退回 no-store');
    assert.equal(await first.text(), 'var a = 1;');

    const second = await fetch(`${base}/app.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304, '文件没变必须回 304');
    assert.equal(await second.text(), '', '304 不能带正文');

    // 改内容后同一个 If-None-Match 必须失效 —— 否则开发时改了代码刷新还是旧的。
    fs.writeFileSync(path.join(dir, 'app.js'), 'var a = 22;', 'utf8');
    const third = await fetch(`${base}/app.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(third.status, 200, '文件变了必须回 200');
    assert.equal(await third.text(), 'var a = 22;');
  });
});

test('missing files answer 404 and do not throw', async () => {
  const dir = tempDir();
  await withStaticServer(dir, async (base) => {
    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);
  });
});

test('no static response sets no-store anywhere in the server', () => {
  // 静态资源这条路径上不许再出现 no-store：它是"连存都不许存"，会把 V8 编译缓存一起废掉。
  // API 响应（sendJSON）继续 no-store 是对的，所以只在 static-assets 模块里断言。
  const source = fs.readFileSync(path.join(appRoot, 'server', 'static-assets.js'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.ok(!/no-store/.test(code), 'static-assets.js 里不能再出现 no-store');
});

test('index-loader no longer changes every module URL on every launch', () => {
  // `?v=<Date.now()>` 会让 142 个模块每次启动都是全新 URL，条件请求无从谈起。
  const source = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.ok(!/moduleCacheBust\s*=\s*String\(Date\.now\(\)\)/.test(code), '缓存参数不能是每次启动都变的时间戳');
  assert.match(code, /cacheBust/, '仍要保留一个手动强制刷新缓存的口子');
});
