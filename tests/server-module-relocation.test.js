// 后端模块搬家后的回归：http 起来真跑一遍。
// 为什么需要它：把 server.js 从仓库根移进 server/ 之后，`__dirname` 指向跟着变了，而
// 静态资源（public/）、图标（build/）、版本（package.json）都是按 `__dirname` 找的。
// 这类错误**不会报任何异常**：进程照常起来、端口照常监听，只是每个请求都 404。
// 所以判据必须是"真的发一个请求，看它有没有回来"，而不是读源码里写了什么。
// Regression for the backend relocation: boot the real server and hit it. Moving server.js from the
// repository root into server/ changes what `__dirname` points at, and the static bundle (public/),
// the icon (build/) and the version (package.json) are all located relative to it. Getting that wrong
// raises nothing: the process starts, the port listens, and every single request 404s. The check
// therefore has to be an actual request whose answer is inspected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const appRoot = path.join(__dirname, '..');

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: requestPath }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    }).on('error', reject);
  });
}

test('the relocated backend still serves the renderer, the icon and the real version', async (t) => {
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  const server = require('../server/server');
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  const { port } = server.address();

  const index = await request(port, '/');
  assert.equal(index.status, 200, 'GET / must be served from the repository-root public/ bundle');
  assert.match(index.body, /<html/i);
  assert.match(index.body, /index-loader/);

  // 前端模块是逐个体现在 loader 的 modulePaths 里的，能取到它才说明整棵 js/ 树还在原地。
  const loader = await request(port, '/js/index-loader.js');
  assert.equal(loader.status, 200);
  assert.match(loader.body, /modulePaths/);

  const favicon = await request(port, '/favicon.ico');
  assert.equal(favicon.status, 200, 'the icon is read from build/ at the repository root, not from server/');

  // 版本来自根目录的 package.json：落回硬编码兜底值不会有任何报错，只会显示错版本号。
  const version = await request(port, '/api/app/version');
  assert.equal(version.status, 200);
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  assert.equal(JSON.parse(version.body).version, pkg.version);
});

test('the repository root holds no loose .js and the tooling points at server/', () => {
  // 布局约定：后端源码一律住在 server/ 下，根目录只放工程元数据与文档。
  const looseAtRoot = fs.readdirSync(appRoot).filter((entry) => entry.endsWith('.js'));
  assert.deepEqual(looseAtRoot, [], 'no .js may sit at the repository root');

  // 搬完必须有人知道新位置：任何一处漏改都是静默失效（模块找不到、或指纹少算一个文件）。
  const main = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  assert.match(main, /path\.join\(__dirname, '\.\.', 'server', 'server\.js'\)/);

  const cuefieldVersion = fs.readFileSync(path.join(appRoot, 'cuefield', 'version.js'), 'utf8');
  assert.match(cuefieldVersion, /path\.join\(root, 'server', 'server\.js'\)/);

  const installer = fs.readFileSync(path.join(appRoot, 'build', 'installer.nsh'), 'utf8');
  assert.match(installer, /resources\\app\\server\\server\.js/,
    'the installer marker that adopts an existing install has to follow the moved file');

  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('server/**/*'));
  assert.ok(!pkg.build.files.some((entry) => entry.endsWith('.js') && !entry.includes('/')),
    'per-file root patterns must be gone, or a new backend module can escape the manifest');
});
