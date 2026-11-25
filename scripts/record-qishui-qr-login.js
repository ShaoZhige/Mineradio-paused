'use strict';

// 录制 `server/qishui-qr-login.js` 的行为，产出 Rust 回放用例。
//
//   node scripts/record-qishui-qr-login.js           # 打印到 stdout
//   node scripts/record-qishui-qr-login.js --write   # 写 crates/mineradio-core/tests/fixtures/qishui-qr-login-cases.jsonl
//   node scripts/record-qishui-qr-login.js --check   # 只比对，不一致就非零退出（CI 用）
//
// 这个模块本身没有网络与随机：它是一台状态机，`auth` 还是从构造函数注进来的。
// 所以录制很干净 —— 把 `auth` 换成受控的桩，配置文件换成 `ztest/` 下的固定相对路径，
// 再把每一步的返回值、auth 调用序列、状态快照、落盘内容全记下来。
//
// `credential-crypto` 不换桩：没有 safeStorage 时它自己就降级成明文，
// 正好让录制出的配置文件可读、可逐字节比对。

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// `defaultConfig().computerName` 取的是 `os.hostname()`；不钉住的话 fixture 会带上本机机器名，
// 换台机器 `--check` 就红。
os.hostname = () => 'RECORDER-PC';

const OUT = path.join(__dirname, '..', 'crates', 'mineradio-core', 'tests', 'fixtures', 'qishui-qr-login-cases.jsonl');
const CONFIG_FILE = 'ztest/qishui-qr-config.json';

// ---- 让 server/qishui-qr-login.js 能在纯 Node 下 require 起来 ----
// 它顶层 `require('./qishui-auth-v6')`，而那个文件顶层 `require('electron')`；桩一个最小门面即可。
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { isReady: () => true, whenReady: async () => {} },
      session: { fromPartition: () => ({ webRequest: {}, cookies: { get: async () => [] } }) },
      BrowserWindow: function BrowserWindow() {
        throw new Error('录制不需要真的开窗');
      },
    };
  }
  if (request === 'qrcode') return { toDataURL: async () => 'data:image/png;base64,STUB' };
  return originalLoad.call(this, request, parent, isMain);
};

const { createQishuiQrLoginBridge, hasLoginCookie } = require('../server/qishui-qr-login');

// ---- 日志：模块里只有 console.warn 一处（配置读坏时），单独收起来比对 ----
const realWarn = console.warn;
let warnings = [];
console.warn = function (...args) {
  warnings.push(args.map((a) => String(a)).join(' '));
};

// ---- auth 桩 ----
function makeAuth(plan, bridgeRef) {
  const calls = [];
  const returned = [];
  const cursors = {};
  function next(name) {
    const list = plan[name] || [];
    const index = cursors[name] || 0;
    cursors[name] = index + 1;
    if (index >= list.length) throw new Error('auth 桩缺少 ' + name + ' 的第 ' + (index + 1) + ' 个应答');
    return list[index];
  }
  async function run(item) {
    if (item && typeof item === 'object' && item.nested) {
      // 让被测流程在 await 期间被打断：模拟"轮询还没回来用户又刷新了二维码 / 退出登录"。
      try {
        await bridgeRef.current[item.nested](...(item.nestedArgs || []));
      } catch (err) {
        const code = err && err.code;
        if (code && code !== 'QISHUI_QR_REPLACED' && code !== 'QISHUI_QR_PAYLOAD_INCOMPLETE') throw err;
      }
      return item.value === undefined ? null : item.value;
    }
    return item;
  }
  return {
    calls,
    returned,
    configure: (handlers) => {
      // configure 是宿主接线，不属于这个单元的状态机；不记进调用序列。
      void handlers;
    },
    // 每条先在**请求时**占位，拿到值再回填 —— 嵌套调用是先完成、后返回的，
    // 按完成顺序记会让 Rust 侧重放时的消费顺序翻转。
    async getQrCode() {
      calls.push('getQrCode');
      const slot = { call: 'getQrCode', value: null };
      returned.push(slot);
      const value = await run(next('getQrCode'));
      slot.value = value === undefined ? null : value;
      return value;
    },
    async checkQrConnect(token) {
      calls.push('checkQrConnect:' + token);
      const slot = { call: 'checkQrConnect', value: null };
      returned.push(slot);
      const value = await run(next('checkQrConnect'));
      slot.value = value === undefined ? null : value;
      return value;
    },
    async clear() {
      calls.push('clear');
      const slot = { call: 'clear', value: null };
      returned.push(slot);
      const value = await run(next('clear'));
      slot.value = value === undefined ? null : value;
      return value;
    },
  };
}

// ---- 用例 ----
const QR = (token) => ({
  message: 'success',
  data: {
    token: token === undefined ? 'tok-1' : token,
    qrcode: 'data:image/png;base64,QQ==',
    qrcode_index_url: 'https://api.qishui.com/passport/web/qrcode_index/?token=x',
  },
});
const LOGIN_COOKIE = 'sessionid=s1; sessionid_ss=s1; uid_tt=u1';
const CASES = [];
function add(fn, args, options, note) {
  CASES.push(Object.assign({ fn, args, note }, options));
}

add('createQrCode', [], { auth: { getQrCode: [QR('tok-1')] } }, '正常出码：返回上游原样结果，状态里 qrPending');
add('createQrCode', [], { auth: { getQrCode: [{ message: 'success', data: { token: 'tok-1' } }] } }, '缺 qrcode → QISHUI_QR_PAYLOAD_INCOMPLETE');
add('createQrCode', [], { auth: { getQrCode: [{ message: 'success', data: { qrcode: 'x' } }] } }, '缺 token → QISHUI_QR_PAYLOAD_INCOMPLETE');
add('createQrCode', [], { auth: { getQrCode: [null] } }, '上游返回 null → 当空对象处理，仍然 incomplete');
add('createQrCode', [], { auth: { getQrCode: [{ data: { token: 0, qrcode: 'x' } }] } }, 'token 是数字 0（falsy）→ incomplete');
add('createQrCode', [], { auth: { getQrCode: [{ data: { token: 12345, qrcode: 'x' } }] } }, 'token 是数字（truthy）→ 转成字符串当活动令牌');
add('createQrCode', [], {
  scenario: 'reenterCreateOnGetQrCode',
  auth: { getQrCode: [{ nested: 'createQrCode', value: QR('tok-1') }, QR('tok-2')] },
}, '出码期间又刷新了一次 → 先到的那个报 QISHUI_QR_REPLACED');

add('createQrCodeThenStatus', [], { auth: { getQrCode: [QR('tok-1')] } }, '出码后的状态：qrPending 真、cookie 未就绪');
add('createQrCodeWithCookie', [], {
  initialConfig: { cookie: LOGIN_COOKIE },
  auth: { getQrCode: [QR('tok-1')] },
}, '已有 cookie 但二维码待确认 → loggedIn 假、cookieReady 真');

add('checkQrConnect', [''], { auth: {} }, '空 token → QISHUI_QR_TOKEN_REQUIRED');
add('checkQrConnect', ['   '], { auth: {} }, '纯空白 token → QISHUI_QR_TOKEN_REQUIRED');
add('checkQrConnect', ['stale'], { auth: {} }, '拿过期令牌轮询 → error_code 2 / expired，不打上游');
add('checkPaddedToken', [], {
  initialConfig: { cookie: LOGIN_COOKIE },
  auth: {
    getQrCode: [QR('tok-1')],
    checkQrConnect: [{ data: { error_code: 0, status: '3' } }],
  },
}, '令牌两头带空格 → trim 后命中活动令牌，正常走上游并确认');

const CONFIRM_CASE = (note, data, cookie, extra) => add('createQrCodeThenCheck', [], Object.assign({
  initialConfig: { cookie },
  auth: {
    getQrCode: [QR('tok-1')],
    checkQrConnect: [{ message: 'success', data }],
  },
}, extra || {}), note);

CONFIRM_CASE('status "3" + 有效 cookie → 确认', { error_code: 0, status: '3' }, LOGIN_COOKIE);
CONFIRM_CASE('status "confirmed" → 确认', { error_code: 0, status: 'confirmed' }, LOGIN_COOKIE);
CONFIRM_CASE('只给 session_cookie 也算确认', { error_code: 0, session_cookie: 'sid=1' }, LOGIN_COOKIE);
CONFIRM_CASE('error_code 是空串（Number("")===0）→ 确认', { error_code: '', status: '3' }, LOGIN_COOKIE);
CONFIRM_CASE('error_code 是 null（Number(null)===0）→ 确认', { error_code: null, status: '3' }, LOGIN_COOKIE);
CONFIRM_CASE('error_code "2" → 不确认', { error_code: '2', status: '3' }, LOGIN_COOKIE);
CONFIRM_CASE('status 是数字 3 → 确认', { error_code: 0, status: 3 }, LOGIN_COOKIE);
CONFIRM_CASE('cookie 为空 → 不确认', { error_code: 0, status: '3' }, '');
CONFIRM_CASE('只有 uid_tt_ss 也算登录 cookie', { error_code: 0, status: '3' }, 'uid_tt_ss=u');
CONFIRM_CASE('xsessionid 不算登录 cookie', { error_code: 0, status: '3' }, 'xsessionid=x');
CONFIRM_CASE('cookie 里 sessionid 值为空 → 不算', { error_code: 0, status: '3' }, 'sessionid=; a=b');

add('checkTwice', [], {
  initialConfig: { cookie: LOGIN_COOKIE },
  auth: {
    getQrCode: [QR('tok-1')],
    checkQrConnect: [{ data: { error_code: 0, status: '3' } }, { data: { error_code: 9, status: '0' } }],
  },
}, '确认之后再轮询复用缓存，不再打上游');

add('checkAfterRefresh', [], {
  initialConfig: { cookie: LOGIN_COOKIE },
  auth: {
    getQrCode: [QR('tok-1'), QR('tok-2')],
    checkQrConnect: [{ nested: 'createQrCode', value: { data: { error_code: 0, status: '3' } } }],
  },
  scenario: 'reenterCreateOnCheck',
}, '轮询期间用户刷新了二维码 → 代次不符，不确认');
add('checkAfterClear', [], {
  initialConfig: { cookie: LOGIN_COOKIE },
  auth: {
    getQrCode: [QR('tok-1')],
    checkQrConnect: [{ nested: 'clear', value: { data: { error_code: 0, status: '3' } } }],
    clear: [null],
  },
  scenario: 'clearOnCheck',
}, '轮询期间退出登录 → 代次不符，不确认');

add('getStatus', [], { initialConfig: { cookie: '', msToken: '', deviceId: '' } }, '空状态：什么都没就绪');
add('getStatus', [], {
  initialConfig: { cookie: '  ' + LOGIN_COOKIE + '  ', msToken: 'ms-1', deviceId: 'dev-1' },
}, '有 cookie（带空格）/ msToken / deviceId');

add('getCookie', [], { initialConfig: { cookie: '  sessionid=s1  ' } }, 'getCookie 会 trim');
add('getCookie', [], { initialConfig: { cookie: undefined } }, 'cookie 缺失 → 空串');

add('clear', [], {
  initialConfig: { cookie: LOGIN_COOKIE, msToken: 'ms-1', deviceId: 'dev-1' },
  auth: { clear: [null] },
}, '清理：清 cookie 与 msToken，deviceId 留着');

add('updateConfig', [{ cookie: 'sessionid=x', extra: 1 }], {
  initialConfig: { cookie: 'sessionid=old', deviceId: 'dev-1' },
}, 'updateConfig 合并写入并落盘');

add('configFileBroken', [], { setupFile: '{ not json' }, '配置文件坏了 → 回落默认值并 warn');
add('configFileExtraKeys', [], { setupFile: '{"deviceId":"dev-9","unknown":42}' }, '配置文件带未知键 → 保留');
add('configFileBlank', [], { setupFile: '   ' }, '配置文件是空白 → 回落默认值');
add('configFileBom', [], { setupFile: '\uFEFF{"deviceId":"dev-bom"}' }, '配置文件带 BOM → 先剥掉再解析');
add('initialConfigOverridesFile', [], {
  setupFile: '{"deviceId":"from-file","installId":"i-file"}',
  initialConfig: { deviceId: 'from-option' },
}, 'initialConfig 覆盖文件里的同名键');

const COOKIE_PROBES = [
  '', 'sessionid=abc', 'foo=1; sessionid=abc', 'sessionid=', 'sessionid =abc',
  'SessionID=abc', 'xsessionid=abc', 'sid_guard=v', 'sid_tt=v', 'uid_tt=v', 'uid_tt_ss=v',
  'a=sessionid=abc', 'sessionid=abc def', 'sessionid=abc;', ';sessionid=abc',
];

function resetConfigFile(setupFile) {
  try { fs.rmSync(CONFIG_FILE, { force: true }); } catch (_) { /* 不存在 */ }
  if (setupFile !== undefined && setupFile !== null) {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, setupFile, 'utf8');
  }
}

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function runCase(item) {
  resetConfigFile(item.setupFile);
  warnings = [];
  const bridgeRef = { current: null };
  const auth = makeAuth(item.auth || {}, bridgeRef);
  const bridge = createQishuiQrLoginBridge(Object.assign({
    auth,
    configFile: CONFIG_FILE,
    initialConfig: item.initialConfig || {},
  }));
  bridgeRef.current = bridge;

  const entry = {
    fn: item.fn,
    args: item.args,
    note: item.note,
  };
  if (item.setupFile !== undefined) entry.setupFile = item.setupFile;
  if (item.initialConfig) entry.initialConfig = item.initialConfig;
  if (item.scenario) entry.scenario = item.scenario;

  const call = async () => {
    switch (item.fn) {
      case 'createQrCode':
        return bridge.createQrCode();
      case 'createQrCodeThenStatus':
        await bridge.createQrCode();
        return bridge.getStatus();
      case 'createQrCodeWithCookie':
        await bridge.createQrCode();
        return bridge.getStatus();
      case 'createQrCodeThenCheck': {
        const qr = await bridge.createQrCode();
        const first = await bridge.checkQrConnect(qr.data.token);
        return { qr, first, status: bridge.getStatus(), cookie: bridge.getCookie() };
      }
      case 'checkQrConnect':
        return bridge.checkQrConnect(item.args[0]);
      case 'checkPaddedToken': {
        const qr = await bridge.createQrCode();
        const polled = await bridge.checkQrConnect('  ' + qr.data.token + '  ');
        return { polled, status: bridge.getStatus() };
      }
      case 'checkTwice': {
        const qr = await bridge.createQrCode();
        const first = await bridge.checkQrConnect(qr.data.token);
        const second = await bridge.checkQrConnect(qr.data.token);
        return { first, second, status: bridge.getStatus() };
      }
      case 'checkAfterRefresh': {
        const qr = await bridge.createQrCode();
        const polled = await bridge.checkQrConnect(qr.data.token);
        return { polled, status: bridge.getStatus() };
      }
      case 'checkAfterClear': {
        const qr = await bridge.createQrCode();
        const polled = await bridge.checkQrConnect(qr.data.token);
        return { polled, status: bridge.getStatus() };
      }
      case 'getStatus':
        return bridge.getStatus();
      case 'getCookie':
        return bridge.getCookie();
      case 'clear': {
        const status = await bridge.clear();
        return { status, cookie: bridge.getCookie() };
      }
      case 'updateConfig': {
        const config = bridge._test.updateConfig(item.args[0]);
        return { config, status: bridge.getStatus() };
      }
      case 'configFileBroken':
      case 'configFileExtraKeys':
      case 'configFileBlank':
      case 'configFileBom':
      case 'initialConfigOverridesFile': {
        const status = bridge.getStatus();
        return { status, config: bridge._test.getConfig() };
      }
      default:
        throw new Error('未知用例：' + item.fn);
    }
  };

  try {
    entry.result = await call();
  } catch (err) {
    entry.err = { code: (err && err.code) || '', message: (err && err.message) || String(err) };
  }
  entry.authCalls = auth.calls;
  const returned = auth.returned;
  // 桩每次调用返回什么 —— Rust 侧照这个重放，用例逻辑不必再写一遍。
  entry.authReturned = returned;
  entry.fileAfter = readConfigFile();
  // V8 的 JSON 解析报错文案没法在 Rust 里逐字复刻，只比对"记了这条警告"。
  entry.warnings = warnings.map((line) =>
    line.indexOf('[QishuiQrLogin] ignored invalid config') === 0
      ? '[QishuiQrLogin] ignored invalid config'
      : line);
  return entry;
}

function cookiesEntry() {
  return {
    fn: 'hasLoginCookie',
    note: '登录 cookie 判定的 15 种写法',
    args: [],
    result: null,
    authCalls: [],
    fileAfter: null,
    warnings: [],
    probes: COOKIE_PROBES.map((input) => ({ input, result: hasLoginCookie(input) })),
  };
}

async function main() {
  const lines = [];
  for (const item of CASES) {
    lines.push(await runCase(item));
  }
  lines.push(cookiesEntry());
  resetConfigFile(null);
  return lines;
}

main().then((lines) => {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body, 'utf8');
    console.log('已写入 ' + lines.length + ' 条 → ' + OUT);
    return;
  }
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = fs.readFileSync(OUT, 'utf8'); } catch (_) { current = ''; }
    if (current === body) {
      console.log('qishui-qr-login fixture 与当前实现一致（' + lines.length + ' 条）');
      return;
    }
    const old = current.trim().split('\n').filter(Boolean);
    console.error('qishui-qr-login fixture 已过期：文件 ' + old.length + ' 条，实际 ' + lines.length + ' 条');
    for (let i = 0; i < Math.max(old.length, lines.length); i++) {
      if (old[i] !== JSON.stringify(lines[i])) {
        console.error('首个差异在第 ' + (i + 1) + ' 条：');
        console.error('  文件 ' + String(old[i]).slice(0, 300));
        console.error('  实际 ' + JSON.stringify(lines[i]).slice(0, 300));
        break;
      }
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(body);
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
