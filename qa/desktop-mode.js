'use strict';

// 桌面模式 CDP 冒烟：启动隐藏 Electron，开启全屏桌面覆盖层，验证进入 interactive、
// 覆盖层模式生效、窗口覆盖工作区，再关闭并确认恢复。
// 需要真实 Windows 桌面（Explorer/Progman）。CI 无交互桌面时可用 MINERADIO_QA_ALLOW_SKIP=1 跳过。

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(__dirname, '.tmp');
const QA = path.join(WORK, 'desktop-userdata');
const PORT = Number(process.env.MINERADIO_QA_DESKTOP_PORT || 9433);
const ALLOW_SKIP = process.env.MINERADIO_QA_ALLOW_SKIP === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  try { fs.rmSync(QA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { }
  fs.mkdirSync(QA, { recursive: true });
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.MINERADIO_STARTUP_QA_HIDDEN = '1';
  env.MINERADIO_STARTUP_QA_USER_DATA = QA;
  const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
  let ws = null;
  let id = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => { const seq = ++id; pending.set(seq, { resolve, reject }); ws.send(JSON.stringify({ id: seq, method, params })); });
  const evaluate = async (expression) => {
    const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };
  const status = async () => evaluate("(async () => { const s = (await window.desktopWindow.getWallpaperModeStatus()) || {}; return s.status || {}; })()");
  try {
    let target = null;
    for (let i = 0; i < 90 && !target; i += 1) {
      try {
        const ts = await listTargets();
        target = ts.find((t) => t.type === 'page' && /:3\d{3}/.test(t.url || '') && !/startup\.html/.test(t.url || '')) || null;
      } catch (_) { }
      if (!target) await sleep(500);
    }
    assert(target, 'CDP target not found');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      const w = pending.get(m.id);
      if (!w) return;
      pending.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error))); else w.resolve(m.result);
    });
    await call('Page.enable');
    await call('Runtime.enable');
    for (let i = 0; i < 120; i += 1) {
      if (await evaluate("typeof applyWallpaperModeState === 'function' && typeof getWallpaperModeStatus === 'function' && window.desktopWindow")) break;
      await sleep(250);
    }
    await evaluate("if (typeof dismissSplash === 'function') dismissSplash({ instant: true }); 'ok'");
    await sleep(800);

    await evaluate("(async () => { fx.wallpaperMode = true; updateFxInputs(); await applyWallpaperModeState(true); return 'ok'; })()");
    let state = {};
    for (let i = 0; i < 50; i += 1) {
      state = await status();
      if (state.phase === 'interactive') break;
      await sleep(400);
    }
    console.log('status:', JSON.stringify(state));
    if (state.phase !== 'interactive') {
      if (ALLOW_SKIP) {
        console.log('QA desktop-mode: SKIP (no interactive desktop in this session)');
        return;
      }
      throw new Error(`desktop mode did not become interactive: ${state.phase || 'unknown'}`);
    }
    assert(state.overlayMode === true, 'desktop mode is not running in overlay mode');
    assert(state.bounds && state.bounds.width > 0 && state.bounds.height > 0, 'overlay window geometry missing');

    const bounds = await evaluate("(function(){return {screen:window.screenX+','+window.screenY+' '+window.outerWidth+'x'+window.outerHeight, bodyClass:document.body.className};})()");
    console.log('bounds:', JSON.stringify(bounds));

    await evaluate("(async () => { fx.wallpaperMode = false; updateFxInputs(); await applyWallpaperModeState(false); return 'ok'; })()");
    let restored = {};
    for (let i = 0; i < 40; i += 1) {
      restored = await status();
      if (restored.phase !== 'interactive') break;
      await sleep(300);
    }
    console.log('restored:', JSON.stringify(restored));
    assert(restored.phase !== 'interactive', 'desktop mode did not disable');
    console.log('QA desktop-mode: PASS');
  } catch (err) {
    console.error('QA desktop-mode: FAIL', err && err.stack || err);
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (_) { }
    try { child.kill(); } catch (_) { }
  }
})();
