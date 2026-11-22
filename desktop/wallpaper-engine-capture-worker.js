'use strict';

// WE 壁纸的「后台捕获」worker：常驻一个 PowerShell 进程抓 Wallpaper Engine 的播窗，
// 把帧转成本机回环上的 MJPEG，渲染进程用一个 <img> 直接显示。
//
// 为什么不走 Chromium 采集：WE 播窗是 DirectComposition 表面，getUserMedia / getDisplayMedia
// 一律 "Could not start video source"（2026-11-21 三次实测）。GDI 的 PrintWindow 抓得到
// （真壁纸画面、约 38fps、1080p ≈ 83KB/帧），代价是一次 JPEG 编解码与一份常驻进程。
// Chromium cannot capture that surface at all; GDI PrintWindow can.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// 🔴 抓帧脚本必须交给 PowerShell 去执行，而 PowerShell **不认 asar**：
// 打包后（asar = true）`__dirname` 落在 `resources\app.asar\desktop`，`-File <app.asar>\…ps1`
// 只会得到「文件不存在」，表现为安装版里"抓帧一直失败、退回封面图"，而本地跑（真实目录）完全正常。
// 所以这个 .ps1 在 package.json 的 build.asarUnpack 里解包，这里把路径改到 app.asar.unpacked。
// 开发期没有 app.asar 段，替换不会命中，直接用 __dirname。
// The .ps1 is executed by PowerShell, which cannot read inside app.asar: it must live in
// app.asar.unpacked and the path has to be rewritten (same trick as halo-hid-server.js).
const SCRIPT_PATH = (() => {
  const plain = path.join(__dirname, 'wallpaper-engine-capture-loop.ps1');
  const unpacked = plain.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  if (unpacked === plain) return plain; // 开发期：目录里就是真实文件
  try {
    if (fs.existsSync(unpacked)) return unpacked;
  } catch (error) { /* 读不到就退回原路径，让下游报出真实错误 */ }
  return plain;
})();
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

class WallpaperEngineCaptureWorker {
  constructor(options = {}) {
    this.fps = Math.max(15, Math.min(60, Number(options.fps) || 40));
    this.quality = Math.max(40, Math.min(95, Number(options.quality) || 70));
    this.maxWidth = Math.max(0, Number(options.maxWidth) || 0);
    // 3 = PW_CLIENTONLY | PW_RENDERFULLCONTENT：只抓客户区，避免把 WE 的不可见边框算进画面。
    this.printFlags = Math.max(1, Math.min(3, Number(options.printFlags) || 3));
    this.child = null;
    this.server = null;
    this.token = '';
    this.port = 0;
    this.title = '';
    this.latest = null;
    this.buffer = Buffer.alloc(0);
    this.frames = 0;
    this.startedAt = 0;
    this.lastError = '';
    this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  }

  get running() {
    return !!(this.child && this.server);
  }

  url() {
    if (!this.running || !this.port) return '';
    return `http://127.0.0.1:${this.port}/stream/${this.token}`;
  }

  async start(title) {
    this.stop();
    const safeTitle = String(title || '').slice(0, 120);
    if (!safeTitle) return { ok: false, error: 'CAPTURE_WORKER_TITLE_MISSING' };
    if (!fs.existsSync(SCRIPT_PATH)) return { ok: false, error: 'CAPTURE_WORKER_SCRIPT_MISSING' };

    this.token = crypto.randomBytes(12).toString('hex');
    this.title = safeTitle;
    this.latest = null;
    this.buffer = Buffer.alloc(0);
    this.frames = 0;
    this.lastError = '';

    try {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(0, '127.0.0.1', resolve);
      });
    } catch (error) {
      this.stop();
      return { ok: false, error: 'CAPTURE_WORKER_SERVER_FAILED', detail: String(error && error.message || error) };
    }
    this.port = this.server.address().port;

    try {
      this.child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH,
        '-TitleMatch', safeTitle,
        '-Fps', String(this.fps),
        '-Quality', String(this.quality),
        '-MaxWidth', String(this.maxWidth),
        '-PrintFlags', String(this.printFlags),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.stop();
      return { ok: false, error: 'CAPTURE_WORKER_SPAWN_FAILED', detail: String(error && error.message || error) };
    }

    this.child.stdout.on('data', (chunk) => this._ingest(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (!text) return;
      this.lastError = text.slice(0, 300);
      this.onLog(text);
    });
    this.child.on('exit', () => { this.child = null; });
    this.startedAt = Date.now();

    // 等首帧：没有帧就等于没成，交给调用方回退。
    // 12 秒而不是 4 秒 —— WE 的播窗是异步建出来的，抓帧脚本本身还要等窗口出现（最多 18s），
    // 4 秒窗口太窄，实测会稳定报 TARGET_NOT_FOUND。
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (this.latest) return { ok: true, url: this.url(), port: this.port };
      if (!this.child) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const failed = this.lastError || 'CAPTURE_WORKER_NO_FRAME';
    this.stop();
    return { ok: false, error: 'CAPTURE_WORKER_NO_FRAME', detail: failed };
  }

  _ingest(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readInt32LE(0);
      if (len <= 0 || len > MAX_FRAME_BYTES) {
        this.lastError = 'CAPTURE_WORKER_BAD_FRAME';
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 4 + len) return;
      this.latest = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);
      this.frames += 1;
    }
  }

  _handleRequest(req, res) {
    const url = String(req.url || '');
    if (!this.token || url.indexOf('/stream/' + this.token) !== 0) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
      'cache-control': 'no-store',
      connection: 'close',
    });
    const writeFrame = () => {
      if (!this.latest || res.writableEnded) return false;
      res.write('--frame\r\ncontent-type: image/jpeg\r\ncontent-length: ' + this.latest.length + '\r\n\r\n');
      res.write(this.latest);
      res.write('\r\n');
      return true;
    };
    writeFrame();
    const timer = setInterval(() => { if (!writeFrame()) clearInterval(timer); }, Math.max(8, Math.round(1000 / this.fps)));
    req.on('close', () => clearInterval(timer));
    res.on('close', () => clearInterval(timer));
  }

  status() {
    return {
      running: this.running,
      title: this.title,
      port: this.port,
      frames: this.frames,
      fps: this.fps,
      lastError: this.lastError,
    };
  }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch (_) { }
      this.child = null;
    }
    if (this.server) {
      try { this.server.close(); } catch (_) { }
      this.server = null;
    }
    this.port = 0;
    this.token = '';
    this.latest = null;
    this.buffer = Buffer.alloc(0);
    this.frames = 0;
    this.title = '';
  }
}

module.exports = { WallpaperEngineCaptureWorker };
