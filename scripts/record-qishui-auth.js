'use strict';

// 录制 server/qishui-auth-v6.js 的行为，产出 Rust 侧回放用的 cases.jsonl。
//
//   node scripts/record-qishui-auth.js           输出到 stdout（人工抽查）
//   node scripts/record-qishui-auth.js --write   直接写进 Rust 侧 fixture
//   node scripts/record-qishui-auth.js --check   与 fixture 逐字节比对（CI 用）
//
// 这个录制器和别的不一样：**目标模块在纯 Node 下 require 不起来**。它顶层就
// `require('electron')` 拿 BrowserWindow / app / session，还 require('qrcode')。
// 所以这里先接管 Module._load 把这两个换成桩，再让真正的业务代码跑在桩上。
//
// 桩的取舍：**只桩"窗口与页面"，不桩业务逻辑**。也就是说 ensureIdentity、
// commonParams、request() 的 URL / 表单编码 / x-ss-stub、2046 二次验证明细、
// persistSessionCookies 的域名过滤，全都是**真代码**在跑；被替换掉的只有
//   - BrowserWindow（真的会开窗口）、
//   - session.webRequest（真的挂在 Chromium 上）、
//   - webContents.executeJavaScript（真的在页面里执行）、
//   - qrcode.toDataURL（真的画 PNG）、
//   - crypto 随机源（真随机会让 fixture 每次都不同）。
//
// 三个刻意选择：
//
//   1. **随机流当流水账记下来**。模块用 crypto.randomInt / randomBytes / randomUUID
//      造设备号、biz_trace_id、追踪头、msToken。换成计数器驱动后，把每一步的
//      (kind, 入参, 值) 全部记进 `randoms`，Rust 侧的 Rng 就按这份流水账逐条比对
//      着重放 —— 比"两边各自算一遍随机数"可靠得多。
//   2. **`responses` 是队列**。这个模块的请求严格串行（没有 Promise.all），
//      所以按顺序消费就够。"轮询晚到 + 用户刷新了二维码"那种竞态没法从外部
//      可复现地录（它会多出一次真实的请求），改由 Rust 侧的单测覆盖。
//   3. **签名注入由脚本给定**。真实流程里 a_bogus / msToken 是页面里的 bdms 追加的，
//      桩没法算。所以每条用例可以给一个 `sign` 函数，桩负责把它拼进 URL 并触发
//      onBeforeSendHeaders 钩子 —— 让 `lastPassportRequest` 由**真的闭包**写进去，
//      这样 request() 里那段"a_bogus 必须 44 位"的校验也是真代码在跑。

const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'crates',
  'mineradio-core',
  'tests',
  'fixtures',
  'qishui-auth-cases.jsonl',
);

// ---------- 1. 确定性 ----------

const realRandom = {
  randomInt: crypto.randomInt,
  randomBytes: crypto.randomBytes,
  randomUUID: crypto.randomUUID,
};

let randoms = [];
let sequence = 0;

crypto.randomInt = (min, max) => {
  const span = Math.max(1, max - min);
  const value = min + (sequence % span);
  sequence += 1;
  randoms.push({ kind: 'int', min, max, value });
  return value;
};
// 带回调的那次调用是 Node 内部（net / dns）要的随机，不属于被测模块，原样代劳。
crypto.randomBytes = (size, callback) => {
  if (typeof callback === 'function') return realRandom.randomBytes.call(crypto, size, callback);
  sequence += 1;
  const buffer = Buffer.alloc(size, sequence % 256);
  randoms.push({ kind: 'bytes', size, hex: buffer.toString('hex') });
  return buffer;
};
crypto.randomUUID = () => {
  sequence += 1;
  const value = '00000000-0000-4000-8000-' + String(sequence).padStart(12, '0');
  randoms.push({ kind: 'uuid', value });
  return value;
};

// 机器名会进扫码 URL 的 computer_name，换台机器录出来就不一样了。
os.hostname = () => 'RECORDER-PC';

// ---------- 2. 桩：qrcode ----------

let qrCalls = [];

function makeQr() {
  return {
    toDataURL: async (text, options) => {
      qrCalls.push({ text, options });
      // 不画 PNG：把内容 base64 进去，这样 `ok` 里的 data URL 顺带把 scan_url 钉住了。
      return 'data:image/png;base64,' + Buffer.from(String(text), 'utf8').toString('base64') +
        '#w=' + options.width + ',m=' + options.margin + ',e=' + options.errorCorrectionLevel +
        ',d=' + options.color.dark + ',l=' + options.color.light;
    },
  };
}

// ---------- 3. 桩：electron ----------

// 把 executeJavaScript 的入参从脚本字符串里抠出来。被测模块只会发四种脚本，
// 而且都是 JSON.stringify 直接内联的，所以 `JSON.parse('[' + 内容 + ']')` 就够。
function scriptArgs(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error('未识别的页面脚本：' + text.slice(0, 80));
  const inner = text
    .slice(start + marker.length)
    .trim()
    .replace(/\)\s*$/, '');
  return JSON.parse('[' + inner + ']');
}

const DEFAULT_BROWSER_INFO = { encrypted: 'ENC-STUB', ua: 'stub' };

function makeHarness(item) {
  const state = {
    config: Object.assign({}, item.config || {}),
    jar: (item.jar || []).map((cookie) => Object.assign({}, cookie)),
    localStorage: {},
    notes: [],
    patches: [],
    requests: [],
    responses: [],
    signs: [],
    qrCalls: [],
    verifyCalls: [],
    storage: [],
    inits: [],
    recording: true,
  };

  const hooks = {};
  const authSession = {
    webRequest: {
      onBeforeRequest: (filter, callback) => { hooks.beforeRequest = { filter, callback }; },
      onHeadersReceived: (filter, callback) => { hooks.headersReceived = { filter, callback }; },
      onBeforeSendHeaders: (filter, callback) => { hooks.beforeSendHeaders = { filter, callback }; },
      onCompleted: (filter, callback) => { hooks.completed = { filter, callback }; },
      onErrorOccurred: (filter, callback) => { hooks.errorOccurred = { filter, callback }; },
    },
    cookies: {
      get: async () => state.jar.map((cookie) => Object.assign({}, cookie)),
    },
    clearStorageData: async (options) => {
      if (state.recording) state.storage.push({ op: 'clear', storages: options.storages });
    },
    flushStorageData: async () => {
      if (state.recording) state.storage.push({ op: 'flush' });
    },
  };

  // 每次 BrowserWindow 都必须是**新的**对象：`clear()` 会把窗口标记成 destroyed，
  // 共用一个桩的话，清理之后 `!window.isDestroyed()` 永远为假，`initialize()`
  // 就会在每次调用时重跑一遍（窗口开三次、msToken 重生成三次）。
  const makeWindow = () => ({
    destroyed: false,
    visible: false,
    title: null,
    size: null,
  });

  const firePassportHook = (payload, signedUrl) => {
    const hook = hooks.beforeSendHeaders;
    if (!hook) return;
    const urls = (hook.filter && hook.filter.urls) || [];
    const matches = urls.some((pattern) => {
      if (!pattern.endsWith('*')) return pattern === signedUrl;
      return signedUrl.startsWith(pattern.slice(0, -1));
    });
    if (!matches) return;
    hook.callback({ method: payload.method, url: signedUrl, requestHeaders: payload.headers }, () => {});
  };

  const executeJavaScript = async (script) => {
    const text = String(script);
    if (text.indexOf("localStorage.getItem('xmsty')") >= 0) {
      return state.localStorage.xmsty || state.localStorage.xmst || '';
    }
    if (text.indexOf("localStorage.setItem('xmst'") >= 0) {
      const matched = text.match(/setItem\('xmst', ("(?:[^"\\]|\\.)*")\)/);
      if (!matched) throw new Error('localStorage.setItem 脚本长得不对：' + text);
      const value = JSON.parse(matched[1]);
      state.localStorage.xmst = value;
      state.localStorage.xmsty = value;
      // 这次初始化的交付物。`clear()` 之后重新初始化会拿到**另一个** msToken，
      // 所以按次数记下来，Rust 侧的宿主桩按序发。
      state.inits.push({
        msToken: value,
        browserEncrypted: (item.browserInfo || DEFAULT_BROWSER_INFO).encrypted,
      });
      return true;
    }
    if (text.indexOf('window.__qishuiBrowserInfo()') >= 0) {
      return item.browserInfo || DEFAULT_BROWSER_INFO;
    }
    if (text.indexOf('({') === 0 && text.indexOf('bdms:') > 0) {
      // waitForBdms 的探测脚本
      return item.bdms || { glue: '3.3.5', bdms: '1.0.0.41', loaded: true };
    }
    if (text.indexOf('window.__qishuiCancelSecondVerify') >= 0) {
      if (state.recording) state.notes.push('page:cancel-second-verify');
      return true;
    }
    if (text.indexOf('window.__qishuiRequest(') >= 0) {
      const [payload] = scriptArgs(text, 'window.__qishuiRequest(');
      return handleRequest(payload);
    }
    if (text.indexOf('window.__qishuiSecondVerify(') >= 0) {
      const [decision, general] = scriptArgs(text, 'window.__qishuiSecondVerify(');
      const answer = item.verify ? item.verify(decision, general) : { status: true };
      state.verifyCalls.push({ decision, general, result: answer === undefined ? null : answer });
      return answer;
    }
    throw new Error('未识别的页面脚本：' + text.slice(0, 120));
  };

  const handleRequest = async (payload) => {
    if (state.recording) state.requests.push(payload);
    // 真实流程里 bdms 会**改写**查询串上的 a_bogus / msToken（set 语义，不是追加），
    // 所以这里也 set —— 追加的话 `searchParams.get('msToken')` 拿到的是原来那个，
    // 「msToken 与运行时不一致」那条用例就永远绿了。
    const sign = (item.sign || defaultSign)(payload, state);
    const signed = new URL(payload.url);
    signed.searchParams.set('a_bogus', sign.a_bogus);
    signed.searchParams.set('msToken', sign.msToken);
    state.signs.push({ a_bogus: sign.a_bogus, msToken: sign.msToken });
    firePassportHook(payload, signed.toString());
    const answer = item.respond ? await item.respond(payload, state) : { status: 200, body: '{}' };
    if (state.recording) state.responses.push(answer);
    return answer;
  };

  const buildWindow = () => {
    const ref = makeWindow();
    return {
      ref,
      isDestroyed: () => ref.destroyed,
      setMenuBarVisibility: () => {},
      webContents: { setUserAgent: () => {}, executeJavaScript },
      on: (event) => { ref['on:' + event] = true; },
      loadURL: async () => {},
      setTitle: (title) => { ref.title = title; },
      setSize: (width, height) => { ref.size = [width, height]; },
      center: () => {},
      show: () => { ref.visible = true; },
      focus: () => {},
      hide: () => { ref.visible = false; },
      destroy: () => { ref.destroyed = true; },
    };
  };

  const electron = {
    app: { isReady: () => true, whenReady: async () => {} },
    session: { fromPartition: (partition) => ({ partition, hooks: () => hooks, ...authSession }) },
    BrowserWindow: function BrowserWindow(options) {
      if (state.recording) state.notes.push('window:create:' + options.title);
      return fakeWindow;
    },
  };

  return {
    state,
    hooks,
    session: () => ({ hooks: () => hooks, ...authSession }),
    window: (options) => {
      if (state.recording) state.notes.push('window:create:' + options.title);
      return buildWindow();
    },
  };
}

function defaultSign(_payload, state) {
  return { a_bogus: 'A'.repeat(44), msToken: state.localStorage.xmst || '' };
}

// ---------- 4. 用例数据 ----------

const SCAN_TOKEN = 'TOK123';

function qrEnvelope(extra) {
  return {
    status: 200,
    body: JSON.stringify({
      message: 'success',
      data: Object.assign(
        {
          error_code: 0,
          qrcode_index_url: 'https://api.qishui.com/passport/web/qrcode_index/?token=' + SCAN_TOKEN + '&from=pc',
        },
        extra || {},
      ),
    }),
  };
}

function envelope(data, message) {
  return { status: 200, body: JSON.stringify({ message: message === undefined ? 'success' : message, data }) };
}

const WAITING = () => envelope({ error_code: 0, status: 1 });
const CONFIRMED = (extra) => envelope(Object.assign({ error_code: 0, status: 3 }, extra || {}));

const CASES = [];

function add(fn, args, options, note) {
  CASES.push(Object.assign({ fn, args, note }, options));
}

// —— 二维码 ——
add('getQrCode', [], { respond: () => qrEnvelope() }, '正常出码');
add('getQrCode', [], {
  respond: () => qrEnvelope({ error_code: 0, qrcode: 'ignored-by-module' }),
}, '上游多给的 qrcode 字段会被覆盖');
add('getQrCode', [], { respond: () => envelope({ error_code: 1001, description: '风控' }, 'fail') }, 'message 不是 success');
add('getQrCode', [], { respond: () => envelope({ error_code: 1001, description: '风控' }) }, 'error_code 非 0');
add('getQrCode', [], {
  respond: () => envelope({ error_code: '0', qrcode_index_url: 'https://api.qishui.com/passport/web/qrcode_index/?token=' + SCAN_TOKEN }),
}, 'error_code 是字符串 "0" 也算成功（Number 语义）');
add('getQrCode', [], {
  respond: () => envelope({ error_code: 0, qrcode_index_url: 'https://api.qishui.com/passport/web/qrcode_index/?from=pc' }),
}, 'index_url 缺 token');
add('getQrCode', [], { respond: () => envelope({ error_code: 0 }) }, 'index_url 整个缺失');
add('getQrCode', [], { respond: () => ({ status: 500, body: 'upstream down' }) }, 'HTTP 500');
add('getQrCode', [], { respond: () => ({ status: 200, body: '<html>not json</html>' }) }, '响应不是 JSON');
add('getQrCode', [], { respond: () => ({ status: 204, body: '' }) }, '204 空响应 → 空对象信封');
add('getQrCode', [], { respond: () => qrEnvelope(), sign: () => ({ a_bogus: 'A'.repeat(43), msToken: 'x' }) }, 'a_bogus 43 位 + msToken 不对（两个条件同时踩）');
// 下面两条**只**踩一个条件：msToken 必须是对的，否则 msToken 那条先抛，
// a_bogus 长度校验就成了死代码（负向验证会因此变绿）。
add('getQrCode', [], {
  respond: () => qrEnvelope(),
  sign: (_payload, state) => ({ a_bogus: 'A'.repeat(43), msToken: state.localStorage.xmst || '' }),
}, 'a_bogus 只有 43 位（msToken 正确）');
add('getQrCode', [], {
  respond: () => qrEnvelope(),
  sign: (_payload, state) => ({ a_bogus: '', msToken: state.localStorage.xmst || '' }),
}, 'a_bogus 是空串（msToken 正确）');
add('getQrCode', [], { respond: () => qrEnvelope(), sign: (_payload, state) => ({ a_bogus: 'A'.repeat(44), msToken: 'stale-token' }) }, 'msToken 与运行时不一致');
add('getQrCode', [], { respond: () => qrEnvelope(), config: fullConfig() }, '身份已完整：一个 patch 都不发');
add('getQrCode', [], { respond: () => qrEnvelope(), config: { deviceId: '12345678' } }, '身份只缺一部分：只补缺的');

// —— 扫码轮询 ——
add('checkQrConnect', ['TOK123'], { respond: () => WAITING() }, '等待中：不写日志、不落 cookie');
add('checkQrConnect', ['TOK123'], {
  respond: () => CONFIRMED(),
  jar: [
    { name: 'sessionid', value: 'v1', domain: '.qishui.com' },
    { name: 'sid_guard', value: 'v2', domain: 'api.qishui.com' },
    { name: 'other', value: 'skip', domain: '.example.com' },
  ],
}, '已确认：jar 里同域的 cookie 落盘');
add('checkQrConnect', ['TOK123'], {
  respond: () => CONFIRMED({ session_cookie: 'a=1; b=2' }),
}, '响应体自带 session_cookie');
add('checkQrConnect', ['TOK123'], {
  respond: () => CONFIRMED({ session_cookie: 'dup=from-response' }),
  jar: [{ name: 'dup', value: 'from-jar', domain: 'qishui.com' }],
}, '响应体的同名 cookie 覆盖 jar 的，位置不变');
add('checkQrConnect', ['TOK123'], { respond: () => envelope({ error_code: 401, status: 0 }) }, '非 0 错误码：写日志');
add('checkQrConnect', ['TOK123'], { respond: () => envelope({ error_code: 0, status: 'confirmed' }) }, 'status 是字符串 confirmed');
add('checkQrConnect', ['TOK123'], { respond: () => envelope({ error_code: 0, status: '1' }) }, 'status 是字符串 "1"：静默');
add('checkQrConnect', [], { respond: () => WAITING() }, 'token 为空');
add('checkQrConnect', ['TOK123'], {
  respond: () => CONFIRMED({ session_cookie: 'k=v' }),
  jar: [{ name: 'UPPER', value: 'v', domain: '.QISHUI.COM' }],
}, '域名大小写与点前缀都归一化');

// 2046：二次验证
add('checkQrConnect', ['TOK123'], {
  respond: (payload, _state, runtime) => {
    if (payload.url.indexOf('isResend=true') >= 0) {
      return CONFIRMED({ session_cookie: 'k=after-mfa' });
    }
    return envelope({
      error_code: 2046,
      verify_portrait_id: 'portrait-from-server',
      biz_params: { ch: '1', payload: { nested: true } },
    });
  },
  verify: () => ({ status: true }),
}, '2046 → 二次验证通过 → 重发请求成功');
add('checkQrConnect', ['TOK123'], {
  respond: () => envelope({ error_code: 2046, biz_params: {} }),
  verify: () => ({ status: false, message: '用户关掉了窗口' }),
}, '2046 → 用户取消');
add('checkQrConnect', ['TOK123'], {
  respond: () => envelope({ error_code: 2046 }),
  verify: () => null,
}, '2046 → 二次验证返回 null');
add('checkQrConnect', ['TOK123'], {
  respond: () => envelope({ error_code: 2046 }),
  verify: () => ({ status: 'true' }),
}, '2046 → status 是字符串 "true"（严格比较不算通过）');
add('checkQrConnect', ['TOK123'], {
  respond: () => envelope({ error_code: 2046 }),
}, '2046 → 默认二次验证返回 {status:true}');
add('checkQrConnect', ['TOK123'], {
  respond: (payload) => {
    if (payload.url.indexOf('isResend=true') >= 0) return envelope({ error_code: 2046 });
    return envelope({ error_code: 2046, verify_portrait_id: 'p1', biz_params: {} });
  },
  verify: () => ({ status: true }),
}, '2046 → 验证通过但重发仍 2046');
add('checkQrConnect', ['TOK123'], {
  respond: (payload) => {
    if (payload.url.indexOf('isResend=true') >= 0) return CONFIRMED({ session_cookie: 'k=v' });
    return envelope({ error_code: 2046, biz_params: 'ch=1&payload=%7B%22a%22%3A1%7D' });
  },
  verify: () => ({ status: true }),
}, 'biz_params 是 URLSearchParams 字符串');
add('checkQrConnect', ['TOK123'], {
  respond: (payload) => {
    if (payload.url.indexOf('isResend=true') >= 0) return CONFIRMED({ session_cookie: 'k=v' });
    return envelope({ error_code: 2046, biz_params: '{"ch":"1","empty":null,"n":0,"flag":false}' });
  },
  verify: () => ({ status: true }),
}, 'biz_params 是 JSON 字符串（null 跳过、数字与布尔转字符串）');
add('checkQrConnect', ['TOK123'], {
  respond: () => envelope({ error_code: 2046, biz_params: ['nope'] }),
  verify: () => ({ status: true }),
}, 'biz_params 是数组 → 格式无效');
add('checkQrConnect', ['TOK123'], {
  respond: () => envelope({ error_code: 2046, biz_params: 42 }),
  verify: () => ({ status: true }),
}, 'biz_params 是数字 → 格式无效');

// biz_params 与表单体撞键：`{...body, ...bizParams}` 是 Object.assign 语义，
// 同名键换值**保位置**，新键才追加到末尾。这是只靠看代码最容易抄错的一处。
add('checkQrConnect', ['TOK123'], {
  respond: (payload) => {
    if (payload.url.indexOf('isResend=true') >= 0) return CONFIRMED({ session_cookie: 'k=v' });
    return envelope({ error_code: 2046, biz_params: { token: 'OVERRIDE', ch: '1' } });
  },
  verify: () => ({ status: true }),
}, 'biz_params 撞上 token：换值保位置，ch 追加到末尾');

// —— 清理 ——
add('clear', [], { respond: () => qrEnvelope() }, '清空：clearStorageData + flushStorageData');
add('getQrCodeAfterClear', [], { respond: () => qrEnvelope() }, 'clear 之后重新初始化（msToken 重新生成）');

function fullConfig() {
  return {
    deviceId: '87654321',
    installId: '12345678',
    verifyPortraitId: '00000000-0000-4000-8000-000000000000.login',
    computerName: 'PRE-CONFIGURED-PC',
    msToken: 'stale-ms-token',
    cookie: 'a=b',
  };
}

// ---------- 5. 执行 ----------

// 被测模块在**加载时**就把 `{ BrowserWindow, app, session }` 解构走了，所以不能每轮
// 换一个 electron 对象 —— 只能给一个长期有效的门面，内部转发到"当前用例"的桩。
let activeHarness = null;

function currentHarness() {
  if (!activeHarness) throw new Error('桩还没就绪');
  return activeHarness;
}

const electronFacade = {
  app: { isReady: () => true, whenReady: async () => {} },
  session: { fromPartition: (partition) => currentHarness().session(partition) },
  BrowserWindow: function BrowserWindow(options) {
    return currentHarness().window(options);
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronFacade;
  if (request === 'qrcode') return makeQr();
  return originalLoad.call(this, request, parent, isMain);
};

const auth = require('../server/qishui-auth-v6');

const realLog = console.log;

function shapeError(error) {
  const shape = { code: error && error.code ? String(error.code) : '', message: String((error && error.message) || '') };
  return shape;
}

async function runCase(item) {
  randoms = [];
  sequence = 0;
  qrCalls = [];

  const harness = makeHarness(item);
  activeHarness = harness;

  const config = harness.state.config;
  auth.configure({
    getConfig: () => config,
    updateConfig: (patch) => {
      if (harness.state.recording) {
        harness.state.patches.push(JSON.parse(JSON.stringify(patch)));
      }
      Object.assign(config, patch);
    },
  });

  console.log = (...args) => {
    if (harness.state.recording) harness.state.notes.push(util.format(...args));
  };

  let value;
  let error;
  try {
    if (item.fn === 'getQrCode') {
      value = await auth.getQrCode();
    } else if (item.fn === 'checkQrConnect') {
      value = await auth.checkQrConnect(item.args[0]);
    } else if (item.fn === 'clear') {
      await auth.getQrCode();
      harness.state.recording = true;
      value = await auth.clear();
    } else if (item.fn === 'getQrCodeAfterClear') {
      await auth.getQrCode();
      await auth.clear();
      value = await auth.getQrCode();
    } else {
      throw new Error('未知用例：' + item.fn);
    }
  } catch (caught) {
    error = shapeError(caught);
  } finally {
    console.log = realLog;
    harness.state.recording = false;
    try { await auth.clear(); } catch (_) { /* 清理失败不影响录制 */ }
  }

  const entry = { fn: item.fn, args: item.args };
  if (item.config) entry.config = item.config;
  if (item.jar) entry.jar = item.jar;
  if (error) entry.err = error;
  else entry.ok = value === undefined ? null : value;
  // 只留**核逻辑**的随机流。`bytes(18)` 是资产服务器的路径令牌、`bytes(88)` 是
  // msToken —— 这两样都归宿主（窗口/分区）所有，Rust 侧由 host 直接交付成品，
  // 不参与重放，所以从流水账里剔掉，让"消费完必须正好用光"这条断言站得住。
  entry.randoms = randoms.filter((item2) => !(item2.kind === 'bytes' && (item2.size === 18 || item2.size === 88)));
  entry.inits = harness.state.inits;
  entry.signs = harness.state.signs;
  entry.requests = harness.state.requests.map((payload) => ({
    method: payload.method,
    url: payload.url,
    headers: Object.entries(payload.headers || {}),
    body: payload.body === undefined ? null : payload.body,
    timeout: payload.timeout,
  }));
  entry.responses = harness.state.responses;
  if (qrCalls.length) entry.qrCalls = qrCalls;
  if (harness.state.verifyCalls.length) entry.verifyCalls = harness.state.verifyCalls;
  if (harness.state.storage.length) entry.storage = harness.state.storage;
  entry.patches = harness.state.patches;
  entry.notes = harness.state.notes;
  entry.note = item.note;
  return entry;
}

// 模块里 qrcode 的调用要拦下来记参数：makeQr 是每次 require 时新建的，这里补一层。

async function main() {
  const lines = [];
  for (const item of CASES) {
    const entry = await runCase(item);
    lines.push(JSON.stringify(entry));
  }
  return lines;
}

(async () => {
  const lines = await main();
  const text = lines.join('\n') + '\n';
  const summary = `共 ${lines.length} 条`;

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : '';
    if (current !== text) {
      const expected = text.split('\n');
      const actual = current.split('\n');
      const firstDiff = expected.findIndex((line, index) => line !== actual[index]);
      realLog('FAIL fixture 与 server/qishui-auth-v6.js 的当前行为不一致');
      realLog(`     文件：${path.relative(path.join(__dirname, '..'), FIXTURE_PATH)}`);
      realLog(`     第 ${firstDiff + 1} 条起不同`);
      realLog('     重录：node scripts/record-qishui-auth.js --write');
      if (firstDiff >= 0) {
        realLog(`     当前：${String(actual[firstDiff]).slice(0, 240)}`);
        realLog(`     应有：${String(expected[firstDiff]).slice(0, 240)}`);
      }
      process.exit(1);
    }
    realLog(`OK 汽水登录 fixture 一致：${summary}`);
    process.exit(0);
  }

  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, text, 'utf8');
    realLog(`已写入 ${path.relative(path.join(__dirname, '..'), FIXTURE_PATH)}`);
    realLog(`  ${summary}`);
    process.exit(0);
  }

  process.stdout.write(text);
  process.stderr.write(summary + '\n');
})().catch((error) => {
  realLog(error);
  process.exit(1);
});
