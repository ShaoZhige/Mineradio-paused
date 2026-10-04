'use strict';

// 洛雪脚本宿主：在独立、沙箱化的 Electron 渲染进程里跑第三方音源脚本，
// 并通过一组白名单 IPC 通道代理它需要的全部能力。
// scripts/ 目录下的脚本永远不接触 require、process、文件系统或任意 Electron IPC。
// LX script host: runs third-party sources inside a dedicated sandboxed Electron renderer
// and proxies every capability it needs through a whitelist of IPC channels. Custom source
// scripts never see require, process, the filesystem or arbitrary Electron IPC.

const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { filterInitPayload, validateActionResponse } = require('./protocol');
const { redactSecrets } = require('./redact');

const inflate = promisify(zlib.inflate);
const deflate = promisify(zlib.deflate);
const RUNTIME_ARGUMENT = '--mineradio-lx-runtime-id=';
const INIT_TIMEOUT = 10_000;
const ACTION_TIMEOUT = 20_000;
const MAX_HTTP_BODY_BYTES = 20 * 1024 * 1024;
const MAX_ZLIB_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_ZLIB_OUTPUT_BYTES = 8 * 1024 * 1024;
const hosts = new WeakMap();
const SCRIPT_INFO_KEYS = ['name', 'description', 'version', 'author', 'homepage'];
const PAUSE_MEDIA_SCRIPT = `
(() => {
  for (const element of document.querySelectorAll('audio,video')) {
    element.muted = true;
    element.pause();
  }
})()
`;

function sanitizeScriptInfo(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const key of SCRIPT_INFO_KEYS) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  return result;
}

function normalizeRequestOptions(url, options = {}) {
  if (typeof url !== 'string' || url !== url.trim() || url.length > 2048 || /[\u0000-\u001f\u007f]/.test(url)) {
    throw new Error('HTTP_FAILED: Invalid URL');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('HTTP_FAILED: Invalid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('HTTP_FAILED: Invalid URL');
  }

  const numericTimeout = Number(options.timeout);
  const timeout = Number.isFinite(numericTimeout)
    ? Math.min(Math.max(numericTimeout, 1), 60_000)
    : 60_000;
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers && typeof options.headers === 'object' ? options.headers : {}) };
  let body = options.body;
  if (options.form && typeof options.form === 'object') {
    body = new URLSearchParams(options.form);
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
  } else if (options.formData && typeof options.formData === 'object') {
    body = new FormData();
    for (const [key, value] of Object.entries(options.formData)) body.append(key, value);
  }
  return { url, method, timeout, headers, body };
}

function parseHttpBody(raw) {
  const text = Buffer.from(raw).toString();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeUpdateUrl(updateUrl) {
  if (typeof updateUrl !== 'string' || updateUrl === '') return undefined;
  if (updateUrl.length > 1024 || updateUrl !== updateUrl.trim()) {
    throw new Error('UPDATE_ALERT_FAILED: Invalid update URL');
  }
  let parsed;
  try {
    parsed = new URL(updateUrl);
  } catch {
    throw new Error('UPDATE_ALERT_FAILED: Invalid update URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('UPDATE_ALERT_FAILED: Invalid update URL');
  }
  return updateUrl;
}

function errorResult(error) {
  return { error: String(error?.message || error).slice(0, 1024) };
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return null;
}

function bufferFromLimited(value, maxBytes, message) {
  if (typeof value === 'string' && Buffer.byteLength(value) > maxBytes) throw new Error(message);
  const declaredLength = typeof value?.byteLength === 'number'
    ? value.byteLength
    : Array.isArray(value) ? value.length : null;
  if (declaredLength !== null && declaredLength > maxBytes) throw new Error(message);
  const buffer = Buffer.from(value);
  if (buffer.length > maxBytes) throw new Error(message);
  return buffer;
}

// 响应体必须边读边算大小：只看 Content-Length 会被分块编码或谎报长度绕过去。
// The body is measured while streaming: trusting Content-Length alone would be defeated
// by chunked encoding or a lying header.
async function readLimitedResponseBody(response) {
  const rawContentLength = headerValue(response.headers, 'content-length');
  const contentLength = rawContentLength == null ? null : Number(rawContentLength);
  if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_BODY_BYTES) {
    throw new Error('HTTP_FAILED: Response too large');
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_HTTP_BODY_BYTES) {
          await Promise.resolve(reader.cancel?.()).catch(() => {});
          throw new Error('HTTP_FAILED: Response too large');
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }

  if (!Number.isFinite(contentLength)) throw new Error('HTTP_FAILED: Response length is unknown');
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length > MAX_HTTP_BODY_BYTES) throw new Error('HTTP_FAILED: Response too large');
  return raw;
}

async function runZlib(payload) {
  const data = bufferFromLimited(payload.data, MAX_ZLIB_INPUT_BYTES, 'ZLIB_FAILED: Input too large');
  if (payload.operation === 'deflate') {
    const result = await deflate(data, { maxOutputLength: MAX_ZLIB_OUTPUT_BYTES });
    if (result.length > MAX_ZLIB_OUTPUT_BYTES) throw new Error('ZLIB_FAILED: Output too large');
    return result;
  }
  if (payload.operation === 'inflate') {
    try {
      const result = await inflate(data, { maxOutputLength: MAX_ZLIB_OUTPUT_BYTES });
      if (result.length > MAX_ZLIB_OUTPUT_BYTES) throw new Error('ZLIB_FAILED: Output too large');
      return result;
    } catch (error) {
      if (/maxOutputLength|too large|BUFFER_TOO_LARGE|larger than/i.test(String(error?.message || error))) {
        throw new Error('ZLIB_FAILED: Output too large');
      }
      throw error;
    }
  }
  throw new Error('ZLIB_FAILED: Unsupported operation');
}

function blockRuntimeMedia(contents) {
  if (typeof contents.setAudioMuted === 'function') contents.setAudioMuted(true);
  contents.on('media-started-playing', () => {
    if (typeof contents.setAudioMuted === 'function') contents.setAudioMuted(true);
    if (typeof contents.executeJavaScript === 'function') {
      Promise.resolve(contents.executeJavaScript(PAUSE_MEDIA_SCRIPT, true)).catch(() => {});
    }
  });
}

// 每条 IPC 都先核对发送方 webContents，否则主播放器页面自己就能冒充脚本宿主。
// Every IPC call re-checks the sender webContents; otherwise the main player page could
// impersonate the script host itself.
function lookupRuntime(host, event, payload) {
  const runtime = payload && host.runtimes.get(payload.runtimeId);
  return runtime && runtime.window && event.sender?.id === runtime.window.webContents.id
    ? runtime
    : null;
}

function runCrypto(payload) {
  const args = Array.isArray(payload.args) ? payload.args : [];
  switch (payload.operation) {
    case 'md5':
      return crypto.createHash('md5').update(String(args[0] ?? '')).digest('hex');
    case 'aesEncrypt': {
      const cipher = crypto.createCipheriv(String(args[1]), Buffer.from(args[2]), Buffer.from(args[3]));
      return Buffer.concat([cipher.update(Buffer.from(args[0])), cipher.final()]);
    }
    case 'rsaEncrypt': {
      let data = Buffer.from(args[0]);
      if (data.length > 128) throw new Error('CRYPTO_FAILED: RSA input is too large');
      data = Buffer.concat([Buffer.alloc(128 - data.length), data]);
      return crypto.publicEncrypt({
        key: args[1],
        padding: crypto.constants.RSA_NO_PADDING,
      }, data);
    }
    case 'randomBytes': {
      const size = Number(args[0]);
      if (!Number.isInteger(size) || size < 0 || size > 65_536) {
        throw new Error('CRYPTO_FAILED: Invalid random byte count');
      }
      return crypto.randomBytes(size);
    }
    default:
      throw new Error('CRYPTO_FAILED: Unsupported operation');
  }
}

// ipcMain 是进程级单例，因此宿主句柄按 ipcMain 缓存，并在最后一个 runtime 停止时拆除监听。
// ipcMain is a process-wide singleton, so the host handle is cached per ipcMain and its
// listeners are removed once the last runtime stops.
function installHost(ipcMain) {
  let host = hosts.get(ipcMain);
  if (host) return host;

  host = { ipcMain, runtimes: new Map(), listeners: new Map(), handles: new Set() };
  const sync = (channel, operation) => {
    const listener = (event, payload) => {
      const runtime = lookupRuntime(host, event, payload);
      if (!runtime) {
        event.returnValue = { error: 'UNAUTHORIZED' };
        return;
      }
      try {
        event.returnValue = operation(runtime, payload);
      } catch (error) {
        runtime.logError(channel, error);
        event.returnValue = errorResult(error);
      }
    };
    ipcMain.on(channel, listener);
    host.listeners.set(channel, listener);
  };
  const receive = (channel, operation) => {
    const listener = (event, payload) => {
      const runtime = lookupRuntime(host, event, payload);
      if (runtime) operation(runtime, payload);
    };
    ipcMain.on(channel, listener);
    host.listeners.set(channel, listener);
  };
  const handle = (channel, operation) => {
    ipcMain.handle(channel, async (event, payload) => {
      const runtime = lookupRuntime(host, event, payload);
      if (!runtime) throw new Error('UNAUTHORIZED');
      return operation(runtime, payload);
    });
    host.handles.add(channel);
  };

  sync('mineradio-lx-bootstrap', runtime => ({
    currentScriptInfo: { ...runtime.currentScriptInfo },
  }));
  sync('mineradio-lx-crypto', (_runtime, payload) => runCrypto(payload));
  handle('mineradio-lx-zlib', async (_runtime, payload) => runZlib(payload));
  handle('mineradio-lx-http', async (runtime, payload) => {
    try {
      return await runtime.handleHttp(payload);
    } catch (error) {
      return errorResult(error);
    }
  });
  handle('mineradio-lx-inited', (runtime, payload) => {
    try {
      return runtime.handleInited(payload.data);
    } catch (error) {
      runtime.failInit(error.message, { stopRuntime: true });
      throw error;
    }
  });
  handle('mineradio-lx-update-alert', (runtime, payload) => runtime.handleUpdateAlert(payload.data));
  receive('mineradio-lx-http-cancel', (runtime, payload) => runtime.cancelHttp(payload.requestId));
  receive('mineradio-lx-response', (runtime, payload) => runtime.handleActionResponse(payload));
  receive('mineradio-lx-init-error', (runtime, payload) => runtime.failInit(payload.error, { stopRuntime: true }));

  hosts.set(ipcMain, host);
  return host;
}

function uninstallHostIfUnused(host) {
  if (host.runtimes.size) return;
  for (const [channel, listener] of host.listeners) host.ipcMain.removeListener(channel, listener);
  for (const channel of host.handles) host.ipcMain.removeHandler(channel);
  hosts.delete(host.ipcMain);
}

class LxSourceRuntime {
  constructor({
    script,
    currentScriptInfo = {},
    electron,
    fetchImpl = globalThis.fetch,
    logger = console,
    onUpdateAlert = null,
    initTimeout = INIT_TIMEOUT,
  }) {
    if (typeof script !== 'string') throw new TypeError('script must be a string');
    this.script = script;
    this.currentScriptInfo = sanitizeScriptInfo(currentScriptInfo);
    this.electron = electron || require('electron');
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.onUpdateAlert = onUpdateAlert;
    this.initTimeout = Number.isFinite(Number(initTimeout))
      ? Math.min(Math.max(Number(initTimeout), 1), 60_000)
      : INIT_TIMEOUT;
    this.runtimeId = crypto.randomUUID();
    this.window = null;
    this.host = null;
    this.httpRequests = new Map();
    this.actions = new Map();
    this.initState = null;
    this.stopped = false;
  }

  start() {
    if (this.initState) return this.initState.promise;
    const { BrowserWindow, ipcMain, app } = this.electron;
    this.host = installHost(ipcMain);
    this.host.runtimes.set(this.runtimeId, this);
    this.stopped = false;

    let resolveInit;
    let rejectInit;
    const promise = new Promise((resolve, reject) => {
      resolveInit = resolve;
      rejectInit = reject;
    });
    // A stopped/failed runtime promise can be observed by the caller without
    // producing an unhandled rejection before start() returns.
    promise.catch(() => {});
    this.initState = {
      promise,
      resolve: resolveInit,
      reject: rejectInit,
      settled: false,
      timer: setTimeout(() => this.failInit('INIT_TIMEOUT: Script did not initialize', { stopRuntime: true }), this.initTimeout),
    };

    try {
      const preload = path.join(__dirname, 'runtime-preload.js');
      this.window = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        webPreferences: {
          preload,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          contextIsolation: true,
          sandbox: true,
          devTools: !app?.isPackaged,
          webviewTag: false,
          // 每次运行一个独立内存 partition：脚本之间不共享 storage、Cookie 或缓存。
          // One in-memory partition per run: scripts share no storage, cookies or cache.
          partition: `mineradio-lx-${this.runtimeId}`,
          images: false,
          webgl: false,
          spellcheck: false,
          autoplayPolicy: 'document-user-activation-required',
          additionalArguments: [`${RUNTIME_ARGUMENT}${this.runtimeId}`],
        },
      });

      const contents = this.window.webContents;
      for (const eventName of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
        contents.on(eventName, event => event.preventDefault());
      }
      blockRuntimeMedia(contents);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      contents.session.on('will-download', event => event.preventDefault());
      if (app?.isPackaged) contents.on('devtools-opened', () => contents.closeDevTools());
      contents.once('did-finish-load', () => {
        if (!this.stopped && this.window && !this.window.isDestroyed()) {
          contents.send('mineradio-lx-script', { runtimeId: this.runtimeId, script: this.script });
        }
      });
      this.window.once('closed', () => {
        if (!this.stopped) this.stop();
      });
      Promise.resolve(this.window.loadFile(path.join(__dirname, 'runtime.html')))
        .catch(error => {
          this.failInit(`INIT_FAILED: ${error.message}`, { stopRuntime: true });
        });
    } catch (error) {
      this.failInit(`INIT_FAILED: ${error.message}`, { stopRuntime: true });
    }
    return promise;
  }

  handleInited(data) {
    if (!this.initState || this.initState.settled) throw new Error('INIT_FAILED: Script is already initialized');
    const filtered = filterInitPayload(data);
    this.initState.settled = true;
    clearTimeout(this.initState.timer);
    this.initState.resolve(filtered);
    return filtered;
  }

  failInit(message, { stopRuntime = false } = {}) {
    if (!this.initState || this.initState.settled) return;
    this.initState.settled = true;
    clearTimeout(this.initState.timer);
    this.initState.reject(new Error(String(message || 'INIT_FAILED').slice(0, 1024)));
    if (stopRuntime) this.stop();
  }

  async handleHttp(payload) {
    if (!this.fetchImpl) throw new Error('HTTP_FAILED: fetch is unavailable');
    const requestId = String(payload.requestId || '');
    if (!requestId || requestId.length > 128 || this.httpRequests.has(requestId)) {
      throw new Error('HTTP_FAILED: Invalid request id');
    }
    const options = normalizeRequestOptions(payload.url, payload.options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('HTTP_FAILED: Timed out')), options.timeout);
    this.httpRequests.set(requestId, controller);
    try {
      const response = await this.fetchImpl(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
        redirect: 'follow',
      });
      const raw = await readLimitedResponseBody(response);
      const body = parseHttpBody(raw);
      return {
        response: {
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          bytes: raw.length,
          raw,
          body,
        },
        body,
      };
    } finally {
      clearTimeout(timer);
      this.httpRequests.delete(requestId);
    }
  }

  cancelHttp(requestId) {
    const controller = this.httpRequests.get(String(requestId));
    if (controller) controller.abort(new Error('HTTP_FAILED: Cancelled'));
  }

  // 切歌时调用方会 abort 掉还没完成的请求；这里必须同时摘掉监听并撤单，
  // 否则过期响应会留在 actions 里，被误认成当前歌曲的结果。
  // Track switches abort in-flight requests. Both the listener and the pending entry must
  // be dropped, otherwise a stale response lingers in `actions` and can be mistaken for
  // the current track's result.
  request(data, options = {}) {
    if (!this.window || this.stopped) return Promise.reject(new Error('RUNTIME_STOPPED'));
    const signal = options && options.signal ? options.signal : null;
    if (signal && signal.aborted) return Promise.reject(new Error('REQUEST_CANCELLED: Aborted before send'));
    const requestKey = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.actions.delete(requestKey);
        reject(new Error('REQUEST_FAILED: Timed out'));
      }, ACTION_TIMEOUT);
      const pending = { resolve, reject, timer, action: data.action, detach: null };
      this.actions.set(requestKey, pending);
      if (signal) {
        const onAbort = () => {
          if (!this.actions.has(requestKey)) return;
          this.actions.delete(requestKey);
          clearTimeout(timer);
          reject(new Error('REQUEST_CANCELLED: Aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.window.webContents.send('mineradio-lx-request', { requestKey, data });
    });
  }

  handleActionResponse(payload) {
    const pending = this.actions.get(payload.requestKey);
    if (!pending) return;
    this.actions.delete(payload.requestKey);
    clearTimeout(pending.timer);
    pending.detach?.();
    if (payload.error) {
      pending.reject(new Error(String(payload.error).slice(0, 1024)));
      return;
    }
    try {
      pending.resolve(validateActionResponse(pending.action, payload.result));
    } catch (error) {
      pending.reject(error);
    }
  }

  handleUpdateAlert(data) {
    const safe = redactSecrets(data);
    if (!safe || typeof safe !== 'object' || typeof safe.log !== 'string') {
      throw new Error('UPDATE_ALERT_FAILED: Invalid data');
    }
    const result = {
      log: safe.log.slice(0, 1024),
      updateUrl: normalizeUpdateUrl(safe.updateUrl),
    };
    if (this.onUpdateAlert) this.onUpdateAlert(result);
    return undefined;
  }

  logError(scope, error) {
    this.logger?.error?.(`[custom-source:${scope}]`, redactSecrets({
      message: String(error?.message || error).slice(0, 1024),
    }));
  }

  // 停止必须收干净三样东西：待完成的 HTTP、待回复的请求、以及宿主监听，
  // 否则切歌时旧脚本的响应会漏进新一首，进程里也会堆下悬挂的 ipc 监听。
  // Stopping must drain pending HTTP, pending action requests and the host listeners;
  // otherwise a stale script response leaks into the next track and ipc listeners pile up.
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.failInit('Runtime stopped');
    for (const controller of this.httpRequests.values()) controller.abort(new Error('Runtime stopped'));
    this.httpRequests.clear();
    for (const pending of this.actions.values()) {
      clearTimeout(pending.timer);
      pending.detach?.();
      pending.reject(new Error('Runtime stopped'));
    }
    this.actions.clear();
    if (this.host) {
      this.host.runtimes.delete(this.runtimeId);
      uninstallHostIfUnused(this.host);
      this.host = null;
    }
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
}

module.exports = { LxSourceRuntime, normalizeRequestOptions, parseHttpBody };
