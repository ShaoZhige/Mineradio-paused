'use strict';

// 原生实时壁纸永远退回"项目预览"的**命令行超长**回归测试。
// Regression cover for the over-long native command line that pinned the live wallpaper to its
// project preview.
//
// 背景：Windows 给进程命令行设了 32767 字符的硬上限，而 PowerShell 的 -EncodedCommand 会把
// 整段脚本 base64(UTF-16LE) 塞进命令行（膨胀约 2.67 倍）。nativeWindowControlScript 编码后
// 约 3.85 万字符，于是 child_process 在 spawn 阶段直接以 ENAMETOOLONG 失败——PowerShell 根本
// 没起来，调用方只拿到一个笼统的 WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED。embed / close /
// park 每一步都失败，壁纸永远退回工程目录封面图（被 object-fit: cover 拉伸 = "发虚、和真壁纸
// 不符"）。现场证据是 %APPDATA%/Mineradio/startup-error.log 里的
// nativeStage=exec + nativeDetail=spawn ENAMETOOLONG。
//
// Background: Windows caps a process command line at 32767 characters and PowerShell's
// -EncodedCommand base64s (UTF-16LE) the whole script into it, inflating it ~2.67x. The window
// control script encodes to ~38.5k characters, so child_process failed at spawn with
// ENAMETOOLONG before PowerShell even started and the caller only saw a generic failure code.
// Every embed/close/park step failed, pinning the wallpaper to its stretched cover art. The
// smoking gun lives in startup-error.log as nativeStage=exec + nativeDetail=spawn ENAMETOOLONG.
//
// 这组测试钉住四件事：
//  1. 命令行预算：任何走 -EncodedCommand 的脚本，编码后都必须 ≤ 32767；
//  2. 长脚本改走"内容哈希命名的 .ps1 + -File"，写进去的必须是原文而不是 base64；
//  3. 真实启动路径（embed）下发的参数形状正确，脚本文件确实落在稳定临时目录里；
//  4. 写文件失败时退回内联编码并留下警告，不静默，也不让整条控制链失效。
// Four invariants: an inline-encoded script must stay within the 32767 cap; long scripts go
// through a content-hashed .ps1 launched with -File and holding the RAW source; the real embed
// launch produces that exact shape on disk; and a failed write falls back to inline encoding
// with a warning instead of quietly taking the control path down.
//
// 覆盖缺口的由来：静态守卫里 windowController 被整个替换成桩，DWM 帮手和 broker 又各有自己的
// 断言，于是"真正把窗口控制脚本塞进命令行"的那一步谁都没看过——这正是它能上线的唯一原因。
// 本文件是这条启动路径目前唯一的行为级覆盖。
// Why this slipped through: the static guard replaces windowController with a stub entirely,
// while the DWM helper and the broker each had their own assertions, so nothing ever inspected
// the step that puts the window control script on the command line. This file is currently the
// only behavioural cover for that launch.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const {
  WallpaperEngineRuntime,
} = require('../desktop/wallpaper-engine-runtime');

const appRoot = path.resolve(__dirname, '..');
const readSource = (relativePath) => fs
  .readFileSync(path.join(appRoot, relativePath), 'utf8')
  .replace(/\r\n/g, '\n');

const runtimeText = readSource('desktop/wallpaper-engine-runtime.js');
const runtimeCheckText = readSource('scripts/check-wallpaper-engine-runtime.js');

// Windows CreateProcess 的命令行上限，单位字符。超过它不是"慢"，是 spawn 直接失败。
// Windows caps a CreateProcess command line here. Past it, spawn does not run slow, it fails.
const COMMAND_LINE_LIMIT = 32767;

// 编码膨胀比例：UTF-16LE 每字符 2 字节，base64 每 3 字节 4 字符 —— 约 2.67 倍。
// Encoding overhead: 2 bytes per UTF-16LE character turned into 4 base64 characters per 3 bytes.
const HEADROOM_WARNING = 30000;

// ---------------------------------------------------------------------------
// 辅助：从源码里取出函数体 / 在 vm 里真跑
// ---------------------------------------------------------------------------

function extractFunction(source, signature) {
  // 签名必须以函数体的左花括号结尾：参数里可能有对象默认值，body 不在第一个 '{' 处。
  // The signature must end with the body brace; a parameter list may carry braces of its own.
  const from = source.indexOf(signature);
  assert(from >= 0, `missing function: ${signature}`);
  const open = from + signature.length - 1;
  assert(source[open] === '{', `signature must end with the body brace: ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${signature}`);
}

function stripComments(source) {
  // 注释里会提到旧写法，做"不得出现"断言前必须先剥掉，否则说明性文字会误报。
  // Comments mention the old shapes too; strip them before negative assertions.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// 这些脚本会返回 base64 而非原文，判断依据必须是源码本身而不是返回值的内容猜测。
// Some of these functions return base64 instead of source; decide from the code, not a guess.
const RETURNS_BASE64 = /return Buffer\.from\(source, 'utf16le'\)\.toString\('base64'\);/;

const SCRIPT_FUNCTIONS = [
  'signatureScript',
  'engineProcessProbeScript',
  'controlBrokerScript',
  'nativeWindowControlScript',
  'nativeProcessWindowIsolationScript',
  'nativeParallaxPointerRelayScript',
  'nativeDwmThumbnailSurfaceScript',
];

function scriptFunctionSource(name) {
  return extractFunction(runtimeText, `function ${name}() {`);
}

function measureScript(name) {
  const source = scriptFunctionSource(name);
  const context = vm.createContext({ Buffer, console: { warn() {} } });
  vm.runInContext(source, context, { filename: `${name}.js` });
  const value = vm.runInContext(name, context)();
  assert.strictEqual(typeof value, 'string', `${name} must return a script string`);
  const returnsBase64 = RETURNS_BASE64.test(source);
  return {
    name,
    value,
    returnsBase64,
    source: returnsBase64 ? Buffer.from(value.trim(), 'base64').toString('utf16le') : value,
    // 真正会占掉命令行的那段文本：走 -EncodedCommand 时就是返回的 base64 本身。
    // What actually occupies the command line: the returned base64 when it is encoded inline.
    launchLength: returnsBase64 ? value.trim().length : Buffer.from(value, 'utf16le').toString('base64').length,
  };
}

const measured = new Map(SCRIPT_FUNCTIONS.map((name) => [name, measureScript(name)]));

// ---------------------------------------------------------------------------
// 1. 尺寸事实：为什么这条路必然走死
// ---------------------------------------------------------------------------

const windowControl = measured.get('nativeWindowControlScript');
const broker = measured.get('controlBrokerScript');
const dwmSurface = measured.get('nativeDwmThumbnailSurfaceScript');

assert(
  windowControl.launchLength > COMMAND_LINE_LIMIT,
  `the window control script must still measure past the cap (measured ${windowControl.launchLength}); `
  + 'if it no longer does, this regression file needs rewriting rather than deleting'
);
assert(
  dwmSurface.launchLength > COMMAND_LINE_LIMIT,
  'the DWM helper is the reason the hashed-script-file path already existed'
);
assert(
  broker.launchLength > HEADROOM_WARNING,
  `the broker script must be recognised as running out of headroom (measured ${broker.launchLength})`
);

// ---------------------------------------------------------------------------
// 2. 通用不变量：任何 -EncodedCommand 启动点的脚本都必须装得进命令行
// ---------------------------------------------------------------------------

// 这条断言换成"逐个脚本判断"就守不住新增的启动点；按启动点扫描，将来谁再塞一段长脚本进来
// 都会在 CI 里当场失败，而不是等到用户看到一张拉伸的封面图。
// Scanning the launch sites instead of the individual scripts covers future ones too: the next
// long script someone inlines fails in CI rather than on a user's stretched cover art.
const encodedLaunchPattern = /'-EncodedCommand',\s*([A-Za-z0-9_]+)\(\)/g;
const encodedLaunches = [];
let match;
while ((match = encodedLaunchPattern.exec(runtimeText)) !== null) encodedLaunches.push(match[1]);

assert(
  encodedLaunches.length >= 1,
  `the inline-encoded launch sites must stay discoverable, found ${JSON.stringify(encodedLaunches)}`
);
// 数量会随脚本迁移到 .ps1 而变少，所以这里不钉死个数：真正要守住的是"每个还在内联的都必须
// 装得进命令行"，而这正是下面那条逐个量的断言。
// The count shrinks as scripts move to .ps1, so it is deliberately not pinned: what matters is
// that every one still inlined fits, which is the per-script measurement below.
assert(
  !encodedLaunches.includes('nativeWindowControlScript'),
  'the window control script must never be launched through -EncodedCommand'
);
assert(
  !encodedLaunches.includes('controlBrokerScript'),
  'the broker script must never be launched through -EncodedCommand'
);
assert(
  !encodedLaunches.includes('nativeProcessWindowIsolationScript'),
  'the resident taskbar monitor grows with every new window it has to enumerate; it must launch '
  + 'from a script file rather than ride on the command line'
);
for (const name of encodedLaunches) {
  const info = measured.get(name) || measureScript(name);
  assert(
    info.returnsBase64,
    `${name} is passed to -EncodedCommand, so it must return base64 rather than raw source`
  );
  assert(
    info.launchLength <= COMMAND_LINE_LIMIT,
    `${name} encodes to ${info.launchLength} characters, past the Windows ${COMMAND_LINE_LIMIT} `
    + 'command-line cap: launch it from a hashed script file instead'
  );
}

// ---------------------------------------------------------------------------
// 3. 长脚本返回原文，交给调用方写成 .ps1
// ---------------------------------------------------------------------------

for (const name of ['controlBrokerScript', 'nativeWindowControlScript', 'nativeDwmThumbnailSurfaceScript']) {
  const info = measured.get(name);
  const body = stripComments(scriptFunctionSource(name));
  assert(
    !info.returnsBase64 && /return source;/.test(body),
    `${name} must return its raw source so the caller can write a .ps1`
  );
  assert(
    !/-EncodedCommand/.test(body),
    `${name} must not decide the launch shape; that belongs to the shared helper`
  );
  // base64 只有 [A-Za-z0-9+/=]，PowerShell 源码一定有 $ - ( ) { } 这些字符。
  // Base64 is limited to [A-Za-z0-9+/=]; PowerShell source always carries $ - ( ) { }.
  assert(
    /[${}()\-]/.test(info.value) && /[A-Za-z]/.test(info.value),
    `${name} must hand back PowerShell source text, not a base64 payload`
  );
}

// ---------------------------------------------------------------------------
// 4. _powerShellHelperArgs：内容哈希命名的 .ps1，写一次复用
// ---------------------------------------------------------------------------

// 这个方法是类简写方法，只有放进类体里才能脱离原文件求值。
// The helper is a shorthand class method; it only parses inside a class body.
const helperSource = extractFunction(runtimeText, '  _powerShellHelperArgs(prefix, scriptSource) {');

function runHelper(options = {}) {
  const writes = [];
  const mkdirs = [];
  const warnings = [];
  const context = vm.createContext({
    Buffer,
    crypto: require('crypto'),
    path: require('path'),
    fs: {
      mkdirSync: (target, opts) => { mkdirs.push({ target: String(target), opts: { ...opts } }); },
      existsSync: () => options.exists === true,
      writeFileSync: (target, data, encoding) => {
        if (options.writeFails) throw new Error('EACCES: permission denied');
        writes.push({ target: String(target), data: String(data), encoding: String(encoding) });
      },
    },
    console: { warn: (...args) => warnings.push(args.map((value) => String(value)).join(' ')) },
  });
  vm.runInContext(`class HelperHost { ${helperSource} }`, context, { filename: 'native-helper.js' });
  const args = vm.runInContext(
    `(function () {
       const host = new HelperHost();
       host.nativeTempPath = ${JSON.stringify(options.tempPath || 'C:/temp/native-helper-temp')};
       return host._powerShellHelperArgs(${JSON.stringify(options.prefix || 'window-control')}, ${JSON.stringify(options.scriptSource || 'param()\nWrite-Output 1\n')});
     })()`,
    context
  );
  return { args: Array.from(args), writes, mkdirs, warnings };
}

const helperScript = 'param([string]$Action)\nAdd-Type -TypeDefinition $source -Language CSharp\n';
const helperRun = runHelper({ prefix: 'window-control', scriptSource: helperScript });

assert.strictEqual(helperRun.args.length, 4, 'the helper must hand back a -File launch, nothing else');
assert.strictEqual(helperRun.args[0], '-ExecutionPolicy');
assert.strictEqual(helperRun.args[1], 'Bypass');
assert.strictEqual(helperRun.args[2], '-File');
const helperFile = String(helperRun.args[3]);
assert(
  /wallpaper-engine-window-control-[a-f0-9]{20}\.ps1$/.test(helperFile),
  `the helper file must be content-hashed so an updated script is never stale, got ${helperFile}`
);
assert(
  path.resolve(path.dirname(helperFile)) === path.resolve('C:/temp/native-helper-temp'),
  'the helper file must live in the stable native temp directory'
);
assert.strictEqual(helperRun.writes.length, 1, 'a cold helper file must be written once');
assert.strictEqual(helperRun.mkdirs.length, 1, 'the temp directory must be ensured before writing');
assert.strictEqual(helperRun.mkdirs[0].opts.recursive, true);
// BOM + UTF-8：Windows PowerShell 5.1 没有 BOM 时会按 ANSI 读文件，脚本里的非 ASCII 会当场乱码。
// BOM + UTF-8: without the BOM, Windows PowerShell 5.1 reads the file as ANSI and mangles
// every non-ASCII character in it.
assert.strictEqual(
  helperRun.writes[0].data,
  `\uFEFF${helperScript}`,
  'the helper file must hold the raw source behind a BOM'
);
assert.strictEqual(helperRun.writes[0].encoding, 'utf8');

// 写一次复用：同一个脚本第二次调用不该再碰磁盘。
// Written once and reused: a second call for the same script must not touch the disk again.
const helperReuse = runHelper({ prefix: 'window-control', scriptSource: helperScript, exists: true });
assert.deepStrictEqual(helperReuse.writes, [], 'an existing helper file must be reused, not rewritten');
assert.strictEqual(String(helperReuse.args[3]), helperFile, 'the same source must resolve to the same file');

// 内容变了，文件名必须跟着变——否则用户会一直跑着旧脚本。
// Change the content and the file name has to follow, or a stale script keeps running.
const helperChanged = runHelper({ prefix: 'window-control', scriptSource: `${helperScript}# shifted\n` });
assert.notStrictEqual(String(helperChanged.args[3]), helperFile, 'a changed script must hash to a new file');

// 前缀区分脚本：窗口控制器和 broker 不能互相覆盖。
// The prefix keeps the window controller and the broker from overwriting each other.
const helperBroker = runHelper({ prefix: 'control-broker', scriptSource: helperScript });
assert(
  /wallpaper-engine-control-broker-[a-f0-9]{20}\.ps1$/.test(String(helperBroker.args[3])),
  'the broker must get its own hashed helper file'
);

// 写文件失败不能把整条控制链带走：退回内联编码，并留下可排查的警告。
// A failed write must not take the control path down: fall back to inline encoding and warn.
const helperFallback = runHelper({ prefix: 'window-control', scriptSource: helperScript, writeFails: true });
assert.strictEqual(helperFallback.args[0], '-EncodedCommand', 'a failed write must fall back to inline encoding');
assert.strictEqual(
  String(helperFallback.args[1]),
  Buffer.from(helperScript, 'utf16le').toString('base64'),
  'the inline fallback must encode the raw source exactly like the legacy path did'
);
assert.strictEqual(helperFallback.warnings.length, 1, 'the fallback must be reported, never silent');
assert(
  /native helper file unavailable/i.test(helperFallback.warnings[0]),
  `the fallback warning must name the cause, got ${helperFallback.warnings[0]}`
);

// ---------------------------------------------------------------------------
// 5. 真实启动路径：embed 下发的命令行必须装得进 Windows
// ---------------------------------------------------------------------------

const openCalls = [];
const openTempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-native-helper-'));
const openRuntime = new WallpaperEngineRuntime({
  nativeTempPath: openTempPath,
  nativeExecFile: (file, args, options, callback) => {
    openCalls.push({ file, args: Array.from(args), options: { ...options } });
    queueMicrotask(() => callback(null, '{"ok":true,"hwnd":"4242"}\n', ''));
    return new EventEmitter();
  },
});

// nativeExecFile 在 Promise 执行器里同步调用，参数此刻已经下发；解析结果不是本文件的关注点。
// nativeExecFile runs synchronously inside the promise executor, so the args are already out;
// how the call resolves is not what this file is about.
openRuntime._nativeWindowControl('embed', { sourceId: 'window:4242:0' }).catch(() => {});

assert.strictEqual(openCalls.length, 1, 'the embed step must spawn exactly one native helper');
const openCall = openCalls[0];
assert.strictEqual(openCall.file, 'powershell.exe');
assert.deepStrictEqual(
  openCall.args.slice(0, 3),
  ['-NoLogo', '-NoProfile', '-NonInteractive'],
  'the window control helper must stay a non-interactive PowerShell launch'
);
assert(!openCall.args.includes('-EncodedCommand'), 'the embed step must launch from a script file');
assert.strictEqual(openCall.args.length, 7, `unexpected window control launch, got ${JSON.stringify(openCall.args)}`);
assert.strictEqual(openCall.args[3], '-ExecutionPolicy');
assert.strictEqual(openCall.args[4], 'Bypass');
assert.strictEqual(openCall.args[5], '-File');
const openHelperFile = String(openCall.args[6]);
assert(
  /wallpaper-engine-window-control-[a-f0-9]{20}\.ps1$/.test(openHelperFile),
  `the embed step must use the hashed window control helper, got ${openHelperFile}`
);
assert(
  path.resolve(path.dirname(openHelperFile)) === path.resolve(openTempPath),
  'the embed helper must sit in the runtime native temp directory'
);
assert.strictEqual(
  fs.readFileSync(openHelperFile, 'utf8'),
  `\uFEFF${windowControl.value}`,
  'the file on disk must be the window control source, not its base64'
);

// 这才是本来的 bug：同一段脚本，走内联编码的命令行装不下，走文件就只占几百字符。
// This is the bug itself: the same script overflows an inline-encoded command line and costs a
// few hundred characters once it moves into a file.
const encodeInline = (scriptSource) => [
  '-NoLogo', '-NoProfile', '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(scriptSource, 'utf16le').toString('base64'),
].join(' ').length;
const legacyLength = encodeInline(windowControl.value);
const launchedLength = openCall.args.join(' ').length;
assert(
  legacyLength > COMMAND_LINE_LIMIT,
  `the legacy inline launch must be shown to overflow (measured ${legacyLength})`
);
assert(
  launchedLength <= COMMAND_LINE_LIMIT,
  `the launched command line must fit (measured ${launchedLength})`
);
assert(
  launchedLength < legacyLength / 50,
  `moving the script into a file must shrink the command line (${legacyLength} -> ${launchedLength})`
);

// 复用：第二次 embed 不该写出新文件。
// Reuse: a second embed must not produce another file.
openRuntime._nativeWindowControl('embed', { sourceId: 'window:4242:0' }).catch(() => {});
assert.strictEqual(openCalls.length, 2, 'the second embed must spawn its own helper');
assert.strictEqual(
  String(openCalls[1].args[6]),
  openHelperFile,
  'the same window control script must reuse one helper file across every embed/close/park call'
);
assert.strictEqual(
  fs.readdirSync(openTempPath).filter((entry) => /^wallpaper-engine-window-control-/.test(entry)).length,
  1,
  'embed/close/park must share a single hashed helper file'
);

fs.rmSync(openTempPath, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 6. 静态守卫必须跟着改，否则等于没守
// ---------------------------------------------------------------------------

// 守卫停在旧写法上时，它检查的是一个"已经不存在的启动方式"——断言全绿而代码全错。
// A guard stuck on the old shape inspects a launch that no longer exists: green assertions over
// broken code.
for (const marker of [
  "assert(!brokerOpen.args.includes('-EncodedCommand'), 'the large broker helper must launch from a hashed script file');",
  "assert(!readyBroker.args.includes('-EncodedCommand'), 'the readiness broker must reuse the hashed script file');",
  "assert(!firstDwmSurface.args.includes('-EncodedCommand'), 'the large DWM helper must launch from a hashed UTF-8 script file');",
]) {
  assert(runtimeCheckText.includes(marker), `the runtime guard must keep this check: ${marker}`);
}
assert(
  runtimeCheckText.includes('wallpaper-engine-control-broker-'),
  'the runtime guard must pin the broker helper file name shape'
);
assert(
  runtimeCheckText.includes('fs.readFileSync(String(brokerScriptFile), \'utf8\')'),
  'the runtime guard must read the helper file that is actually launched'
);
// signatureScript 很短（编码后约 1.2k），保持内联反而是对的：少一次磁盘写。
// signatureScript is tiny (~1.2k encoded), so staying inline is right: one disk write spared.
assert(
  runtimeCheckText.includes("assert(signatureCalls[0].args.includes('-EncodedCommand'));"),
  'a short script must be allowed to stay inline'
);
const signatureInfo = measured.get('signatureScript');
assert(
  signatureInfo.returnsBase64 && signatureInfo.launchLength < 8192,
  'the inline exception must stay justified by an actually small script'
);

console.log('[OK] Native PowerShell helpers stay inside the Windows 32767 character command-line '
  + 'cap: long scripts launch from a content-hashed .ps1 holding the raw source, the real embed '
  + 'path was measured end to end, and a failed write degrades to inline encoding with a warning.');
