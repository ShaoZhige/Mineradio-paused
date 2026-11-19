'use strict';

// 静态资源响应：条件请求 + ETag。
//
// 之前 server.js 里的 serveStatic 给每个文件都发
// `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`，而 index-loader
// 又给每个模块 URL 拼上 `?v=<Date.now()>`。两件事叠起来的结果是：public/js 下 142 个文件、
// 共 3.8 MB 的代码，每次启动都被当成全新资源 —— 浏览器副本用不上、V8 的编译缓存也用不上，
// 于是每次开机都要重新读盘、重新传输、重新解析编译一遍。这是启动耗时里最容易被忽视的一笔。
//
// 现在改成标准条件请求：文件没变回 304（渲染进程直接复用带编译缓存的副本），变了回 200。
// ETag 取 size + mtimeMs，所以改过的文件必然换 ETag，开发时按 F5 照旧拿到新内容 ——
// 不需要任何"版本号"参与，也就不会出现"改了代码没生效"的老坑。
//
// Static asset responses: conditional requests with an ETag.
//
// serveStatic used to answer every file with a blanket `no-store`, while index-loader appended
// `?v=<Date.now()>` to every module URL. Together that made all 142 files under public/js
// (3.8 MB of code) look brand new on every launch: neither the browser copy nor V8's compile
// cache could be reused, so each start re-read, re-sent and re-compiled the whole front end.
// Now it is a standard conditional request — 304 when unchanged (the renderer reuses its copy,
// compile cache included), 200 when changed. The ETag is size + mtimeMs, so an edited file always
// changes it and a dev refresh still picks the change up; no version number takes part, so the old
// "I edited it but nothing changed" trap cannot come back.

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
};

// 弱 ETag：size + 毫秒级 mtime 足够区分本地文件的任何一次编辑，又不用把整份内容哈希一遍。
// A weak ETag: size plus millisecond mtime distinguishes any edit to a local file without
// hashing the whole body.
function staticEtag(stat) {
  return 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
}

// If-None-Match 允许是逗号分隔的列表（多级代理或缓存会拼接），逐个比较。
// If-None-Match may be a comma-separated list; compare each tag.
function etagMatches(headerValue, etag) {
  const raw = String(headerValue || '');
  if (!raw) return false;
  return raw.split(',').some((tag) => tag.trim() === etag);
}

function serveStatic(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-cache' });
      res.end('Not Found');
      return;
    }
    const etag = staticEtag(stat);
    if (etagMatches(req && req.headers && req.headers['if-none-match'], etag)) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Cache-Control': 'no-cache' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'text/plain',
        'Content-Length': data.length,
        'ETag': etag,
        'Last-Modified': stat.mtime.toUTCString(),
        // `no-cache` 不是「不缓存」，是「用之前必须验证」。配合 ETag 正是我们要的语义：
        // 每次都问一句，没变白拿 304，变了拿新内容。
        // `no-cache` means "revalidate before use", not "do not store" — with an ETag that is
        // exactly the behaviour we want.
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

module.exports = { MIME, staticEtag, etagMatches, serveStatic };
