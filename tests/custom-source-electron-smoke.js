// 真实 Electron 环境下的洛雪脚本宿主契约测试。
// 单元测试用的是假的 ipcMain/BrowserWindow，只有这里能验证沙箱本身：
// globalThis.lx 全部公开字段、crypto/buffer/zlib 通道、以及 require/process 确实不可见。
// Host contract test under a real Electron runtime. The unit tests use fake ipcMain and
// BrowserWindow stubs; only this file can prove the sandbox itself: the full public
// globalThis.lx surface, the crypto/buffer/zlib channels, and that require/process are
// genuinely unreachable from a script.
//
// 运行方式 / Run with: npm run test:custom-source-host

if (!process.versions.electron) {
  // 被普通 node 误跑时安静跳过，避免 CI 里出现看不懂的失败。
  // Silently skip when invoked by plain node so CI never reports a confusing failure.
  process.exit(0);
}

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { LxSourceRuntime } = require('../desktop/custom-source/runtime');

const FIXTURES = path.join(__dirname, 'fixtures', 'custom-source');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-electron-source-'));
app.setPath('userData', userData);
app.disableHardwareAcceleration();

async function runBasic() {
  const script = fs.readFileSync(path.join(FIXTURES, 'basic-source.js'), 'utf8');
  const runtime = new LxSourceRuntime({
    script,
    currentScriptInfo: { id: 'smoke', name: 'Basic Test Source', allowUpdateAlert: false },
    electron: { app, BrowserWindow, ipcMain },
  });
  try {
    const initialized = await runtime.start();
    assert.deepEqual(initialized.sources.wy.qualitys, ['128k', '320k', 'flac']);
    const url = await runtime.request({
      source: 'wy',
      action: 'musicUrl',
      info: { type: 'flac', musicInfo: { meta: { songId: 42 } } },
    });
    assert.equal(url, 'https://audio.example/42/flac.mp3');
    console.log('[OK] basic source initializes and resolves a musicUrl inside the sandbox');
  } finally {
    runtime.stop();
  }
}

async function createLoopbackServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      const timer = setTimeout(() => { if (!res.destroyed) res.end('late'); }, 30_000);
      req.once('close', () => clearTimeout(timer));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/json') {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      } else if (req.url === '/text') {
        res.end('plain text');
      } else if (req.url === '/echo') {
        res.end(body);
      } else {
        res.statusCode = 404;
        res.end('missing');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function runContract() {
  const server = await createLoopbackServer();
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const template = fs.readFileSync(path.join(FIXTURES, 'contract-source.js'), 'utf8');
  const script = template
    .replace('__BASE_URL__', baseUrl)
    .replace('__PUBLIC_KEY__', JSON.stringify(publicKey.export({ type: 'spki', format: 'pem' })));
  const alerts = [];
  const runtime = new LxSourceRuntime({
    script,
    currentScriptInfo: { name: 'Contract Test Source' },
    electron: { app, BrowserWindow, ipcMain },
    onUpdateAlert: value => alerts.push(value),
  });
  try {
    const initialized = await runtime.start();
    assert.deepEqual(initialized.sources.local.actions, ['musicUrl', 'lyric', 'pic']);
    assert.equal(alerts.length, 1);
    const lyric = await runtime.request({ source: 'local', action: 'lyric', info: {} });
    assert.equal(lyric.lyric, '[00:00.00]a');
    const pic = await runtime.request({ source: 'local', action: 'pic', info: {} });
    assert.equal(pic, 'https://img.example/cover.jpg');
    console.log('[OK] full LX 2.0.0 host contract: utils, HTTP forms, cancel, updateAlert, actions');
  } finally {
    runtime.stop();
    await new Promise(resolve => server.close(resolve));
  }
}

async function runInitTimeout() {
  const script = fs.readFileSync(path.join(FIXTURES, 'timeout-source.js'), 'utf8');
  const runtime = new LxSourceRuntime({
    script,
    currentScriptInfo: { name: 'Timeout Test Source' },
    initTimeout: 50,
    electron: { app, BrowserWindow, ipcMain },
  });
  await assert.rejects(runtime.start(), /INIT_TIMEOUT/);
  assert.equal(runtime.window, null);
  console.log('[OK] a script that never sends `inited` times out and leaves no window behind');
}

async function run() {
  await app.whenReady();
  // Electron 在没有窗口时可能提前退出事件循环，留一个哨兵窗口贯穿全部用例。
  // Electron can drain its event loop with no window open; a sentinel keeps it alive.
  const sentinel = new BrowserWindow({ show: false });
  try {
    await runBasic();
    await runContract();
    await runInitTimeout();
  } finally {
    sentinel.destroy();
  }
}

run().then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
