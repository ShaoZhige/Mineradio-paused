// ============================================================================================
// Regarding the Spotify section, due to the strict policies and terms of the Spotify platform,
// I had to adopt this last resort, using a method similar to 'hijacking' to utilize the official
// player. This is solely a measure of necessity and not malicious intent. If it violates any
// terms, I will promptly remove the code.
// ============================================================================================

'use strict';

// desktop/spotify-client-probe.js
// 探针：不碰 Spotify 的 API，只跟"运行中的官方客户端"打交道。
//
// 目的只有一个 —— 先量清楚三件事，再决定要不要把 Spotify 接成 Mineradio 的远程播放源：
//   1. 系统媒体会话（SMTC）里能不能读到 Spotify 的曲目、播放状态和**进度**；
//   2. 媒体键（VK_MEDIA_*）能不能控制它，以及会不会误伤别的播放器；
//   3. 深链接点播之后，客户端窗口被唤醒多久才能塞回去。
//
// 全部走本机的 PowerShell + WinRT，不联网、不消耗 Spotify 的接口配额、不需要 Premium。
// 这里刻意只做"读"和"发一条命令"，不缓存状态、不轮询：接线时才知道哪些是可靠的。
//
// A probe, not a feature: it only measures how much of the running official client can be
// observed and driven from here (SMTC state, media keys, deep-link focus). Everything is local
// PowerShell/WinRT — no API calls, no quota, no Premium.

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const portablePaths = require('./portable-paths');
const { spotifyClientLog } = require('./spotify-client-log');

const PROBE_TIMEOUT_MS = 15000;

// Windows 的媒体键虚拟码。keybd_event 一次按下 + 一次抬起才是"按了一下"。
const MEDIA_KEYS = Object.freeze({
  playpause: 0xB3,
  next: 0xB0,
  prev: 0xB1,
  stop: 0xB2,
});

// SMTC 的播放状态枚举：Closed=0 Opened=1 Changing=2 Stopped=3 Playing=4 Paused=5。
const PLAYBACK_STATUS = ['closed', 'opened', 'changing', 'stopped', 'playing', 'paused'];

function tempScriptPath(label) {
  // 环境变量丢了也要落回软件目录内的 native 临时区，不能悄悄写 os.tmpdir()：启动时的残留清扫
  // 只扫那一个目录，写到系统临时目录的脚本谁也清不到。
  // Fall back into the app folder's native temp area even when the variable is missing. Writing to
  // os.tmpdir() would put the file outside the one directory the startup prune looks at.
  const dir = String(process.env.MINERADIO_NATIVE_TEMP_DIR || '').trim() || portablePaths.resolveNativeTempDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { /* 已经存在 */ }
  return path.join(dir, 'mineradio-' + label + '-' + process.pid + '-' + Date.now() + '.ps1');
}

function runPowerShell(lines, timeoutMs) {
  // PowerShell 只存在于 Windows：非 Windows 上直接返回 null，别让 execFile 抛 ENOENT。
  // 桌面端只跑 Windows，这条判断是给 CI（ubuntu-24.04 上跑 Node 测试）兜底的 ——
  // 以前 Linux 上跑这个测试会冒出 "spawn powershell.exe ENOENT" 并让整条 CI 红。
  // PowerShell only exists on Windows; CI runs the Node suite on Linux where this must no-op.
  if (process.platform !== 'win32') return Promise.resolve(null);
  const scriptPath = tempScriptPath('spotify-probe');
  // 脚本里刻意不写中文：PowerShell 5.1 读无 BOM 的 UTF-8 会把中文变成乱码。
  // Deliberately ASCII-only: PowerShell 5.1 misreads BOM-less UTF-8 that holds Chinese text.
  fs.writeFileSync(scriptPath, lines.join('\r\n'), 'utf8');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      timeout: timeoutMs || PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      try { fs.unlinkSync(scriptPath); } catch (err) { /* 临时文件删不掉不该影响结果 */ }
      const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
      if (!text) {
        reject(new Error(String(stderr || (error && error.message) || 'powershell returned nothing').slice(0, 400)));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('invalid powershell json: ' + text.slice(0, 320)));
      }
    });
  });
}

// PowerShell 5.1 默认按当前代码页（GBK）写 stdout，Node 按 UTF-8 读会把中文曲名读成乱码。
// 每个脚本开头都钉一次输出编码。
// PowerShell 5.1 writes stdout in the OEM/ANSI code page; Node reads UTF-8, so Chinese titles
// arrive as mojibake unless the output encoding is pinned in every script.
const PS_UTF8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';

// SMTC 的异步调用在 PowerShell 里要手工等：WinRT 的 IAsyncOperation 没有直接可用的 Result。
// WinRT's IAsyncOperation has no usable Result in PowerShell, so it is awaited by hand.
const SMTC_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  PS_UTF8,
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
  '$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq \'AsTask\' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq \'IAsyncOperation`1\' })[0]',
  'function Await($op, $type) {',
  '  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))',
  '  $task.Wait(8000) | Out-Null',
  '  return $task.Result',
  '}',
];

// 读当前所有媒体会话。位置与时长来自 timeline：Spotify 报得准不准，正是要量的东西。
// Every active media session, with the timeline Spotify reports — its accuracy is the point.
async function readMediaSessions() {
  const lines = SMTC_PRELUDE.concat([
    '$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
    '$sessions = @()',
    'foreach ($session in $manager.GetSessions()) {',
    '  $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])',
    '  $info = $session.GetPlaybackInfo()',
    '  $tl = $session.GetTimelineProperties()',
    '  $sessions += [pscustomobject]@{',
    '    appId = $session.SourceAppUserModelId',
    '    status = [string]$info.PlaybackStatus',
    '    statusCode = [int]$info.PlaybackStatus',
    '    title = $props.Title',
    '    artist = $props.Artist',
    '    album = $props.AlbumTitle',
    '    positionMs = [int]$tl.Position.TotalMilliseconds',
    '    durationMs = [int]$tl.EndTime.TotalMilliseconds',
    '    lastUpdated = $tl.LastUpdatedTime.ToString(\'o\')',
    '    isCurrent = [bool]$session.IsCurrentSession',
    '  }',
    '}',
    '@{ sessions = $sessions } | ConvertTo-Json -Depth 6 -Compress',
  ]);
  const answer = await runPowerShell(lines);
  const sessions = (answer && Array.isArray(answer.sessions))
    ? answer.sessions
    : (answer && answer.sessions ? [answer.sessions] : []);
  return sessions.map(session => ({
    appId: String(session.appId || ''),
    status: PLAYBACK_STATUS[Number(session.statusCode)] || String(session.status || ''),
    isPlaying: Number(session.statusCode) === 4,
    title: String(session.title || ''),
    artist: String(session.artist || ''),
    album: String(session.album || ''),
    positionMs: Math.max(0, Number(session.positionMs) || 0),
    durationMs: Math.max(0, Number(session.durationMs) || 0),
    lastUpdated: String(session.lastUpdated || ''),
    isCurrent: !!session.isCurrent,
    // Spotify 的桌面客户端在 SMTC 里报的是 SpotifyAB.SpotifyMusic_...!Spotify。
    isSpotify: /spotify/i.test(String(session.appId || '')),
  }));
}

// 发一次媒体键。keybd_event 需要成对：按下（0）再抬起（KEYEVENTF_KEYUP = 2）。
async function sendMediaKey(kind) {
  const code = MEDIA_KEYS[String(kind || '').toLowerCase()];
  if (!code) throw new Error('unknown media key: ' + kind);
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    PS_UTF8,
    'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);\' -Name Media -Namespace MineradioProbe | Out-Null',
    '[MineradioProbe.Media]::keybd_event(' + code + ', 0, 0, [UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 30',
    '[MineradioProbe.Media]::keybd_event(' + code + ', 0, 2, [UIntPtr]::Zero)',
    '@{ sent = ' + code + ' } | ConvertTo-Json -Compress',
  ];
  return runPowerShell(lines);
}

// Spotify 客户端的最小化：它没有 headless 模式，深链接会把窗口顶到前台，只能立刻塞回托盘。
// 找不到主窗口（已经缩在托盘里）就什么都不做 —— 那本来就是要的结果。
// The client has no headless mode; a deep link raises its window, so it is minimised right after.
// No main window means it is already in the tray, which is the desired end state anyway.
async function minimizeClientWindow() {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    PS_UTF8,
    'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\' -Name Window -Namespace MineradioProbe | Out-Null',
    '$target = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $target) { @{ minimized = $false; reason = "no-window" } | ConvertTo-Json -Compress; exit 0 }',
    '$ok = [MineradioProbe.Window]::ShowWindow($target.MainWindowHandle, 6)',
    '@{ minimized = [bool]$ok; pid = $target.Id; handle = [int64]$target.MainWindowHandle } | ConvertTo-Json -Compress',
  ];
  return runPowerShell(lines);
}

// MR 拉起的客户端只负责出声，窗口不该露脸：多数机器上隐藏启动（STARTUPINFO 的 SW_HIDE）
// 根本不会出窗口，但有的客户端版本会在首帧自己 ShowWindow —— 那一刻它还是一块没画过的黑布，
// 挂在桌面上要等用户从托盘退出才消失（issue #1 的反馈）。
// 这里只盯"MR 自己拉起客户端"之后的这一小段时间：看见可见窗口就最小化，收工即退。
// 用户自己开的客户端永远不碰 —— 那样会把人正在听的 Spotify 窗口抢走。
// The client we spawn only exists to make sound; its window should never be on screen.
// This watches a short window after our own launch and minimises anything that shows up.
const CLIENT_WINDOW_GUARD_MS = 25000;
const CLIENT_WINDOW_GUARD_STEP_MS = 150;
// 还没看见窗口时（隐藏启动的常态）没必要 150ms 一探，放宽一倍省点 CPU。
const CLIENT_WINDOW_GUARD_IDLE_STEP_MS = 300;
// 最小化之后要连续这么久（约 2 秒）没再弹回来才算稳住。实测客户端在启动收尾时会自己
// ShowWindow 一次，把第一次最小化直接顶掉 —— 只按一下是没用的。
const CLIENT_WINDOW_GUARD_STABLE_TICKS = 13;

async function suppressClientWindow(timeoutMs) {
  const span = Math.max(300, Math.min(60000, Number(timeoutMs) || CLIENT_WINDOW_GUARD_MS));
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    PS_UTF8,
    // ShowWindowAsync，不是 ShowWindow：跨进程的同步版本在目标线程卡住时会连着把我们也卡住
    // （DWM 助手那边已经交过一次学费）。
    // ShowWindowAsync rather than ShowWindow: the synchronous variant blocks on a hung target.
    'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);\' -Name WindowGuard -Namespace MineradioProbe | Out-Null',
    '$deadline = (Get-Date).AddMilliseconds(' + span + ')',
    '$saw = $false',
    '$hits = 0',
    '$stable = 0',
    '$step = ' + CLIENT_WINDOW_GUARD_IDLE_STEP_MS,
    'while ((Get-Date) -lt $deadline) {',
    '  $target = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    '  if ($target -and -not [MineradioProbe.WindowGuard]::IsIconic($target.MainWindowHandle)) {',
    '    [MineradioProbe.WindowGuard]::ShowWindowAsync($target.MainWindowHandle, 6) | Out-Null',
    '    $saw = $true',
    '    $hits = $hits + 1',
    '    $stable = 0',
    '    $step = ' + CLIENT_WINDOW_GUARD_STEP_MS,
    '  } elseif ($saw) {',
    '    $stable = $stable + 1',
    '    if ($stable -ge ' + CLIENT_WINDOW_GUARD_STABLE_TICKS + ') { break }',
    '  }',
    '  Start-Sleep -Milliseconds $step',
    '}',
    '@{ sawWindow = $saw; minimized = $hits; spanMs = ' + span + ' } | ConvertTo-Json -Compress',
  ];
  // 脚本自己是有限循环，外面的 timeout 只是兜住 PowerShell 起不来这种意外。
  const answer = await runPowerShell(lines, span + 8000);
  // 只在真的压过窗口时记一行：正常情况下这里什么都不该出现，出现了就说明用户的客户端
  // 会自己把窗口 Show 出来，正是 issue #1 那份反馈的现场。
  // Only log actual hits: in the normal case nothing shows up here, and a hit is exactly the
  // symptom reported in issue #1.
  if (answer && answer.sawWindow === true) {
    spotifyClientLog('window-guard', { minimized: answer.minimized, spanMs: answer.spanMs });
  }
  return answer;
}

// 找 Spotify 的窗口句柄与标题，用来判断"点播之后它到底露出来多久"。
async function inspectClientWindow() {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    PS_UTF8,
    'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);\' -Name Window -Namespace MineradioProbe | Out-Null',
    '$target = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $target) { @{ running = $true; hasWindow = $false } | ConvertTo-Json -Compress; exit 0 }',
    '@{ running = $true; hasWindow = $true; pid = $target.Id; title = $target.MainWindowTitle; visible = [bool][MineradioProbe.Window]::IsWindowVisible($target.MainWindowHandle); minimized = [bool][MineradioProbe.Window]::IsIconic($target.MainWindowHandle) } | ConvertTo-Json -Compress',
  ];
  return runPowerShell(lines);
}

async function isClientRunning() {
  try {
    const answer = await runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      '$target = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Select-Object -First 1',
      '@{ running = [bool]$target } | ConvertTo-Json -Compress',
    ]);
    return !!(answer && answer.running);
  } catch (err) {
    return false;
  }
}

// ---- 调试端口的选择与记忆 -------------------------------------------------------
// 客户端是 CEF，`--remote-debugging-port` 只接受 0 或 1024–65535（libcef 的判断是
// `port >= 1024 && port <= 65535`）。传 0 等于交给系统，而系统只会从动态端口段里挑
// （Windows 默认 49152–65535）—— 范围其实只有四分之一。自己挑才能覆盖 1024–65535，
// 代价是要自己兜住"选中的端口被抢"，所以先 bind 一次再放掉。
// The client is CEF: `--remote-debugging-port` takes 0 or 1024–65535. Passing 0 lets the OS
// choose, and the OS only picks from the dynamic range (49152–65535 on Windows by default) —
// a quarter of the space. Choosing ourselves widens the range, at the cost of a bind probe.
const DEBUG_PORT_MIN = 1024;
const DEBUG_PORT_MAX = 65535;
// 通用 CDP 扫描器与开发工具默认会试的那一批：随机撞上等于白做。
const DEBUG_PORT_SKIP = new Set([1024, 1080, 3000, 3128, 3306, 5000, 5432, 6379, 8000, 8080, 8081, 8443, 8888, 9222, 9229, 9418]);
const DEBUG_PORT_ATTEMPTS = 10;
// DevTools 的 HTTP 端点在页面加载之前就能应答，1.5 秒足以判断端口是否真的起来了。
const DEBUG_PORT_READY_TIMEOUT_MS = 1500;
const DEBUG_PORT_FILE_NAME = '.spotify-cdp-port';

// 端口记在原生临时区：MR 退出时客户端不会跟着退出，下次启动要靠这个文件把通道接回来。
// 临时目录被系统清掉只会让下次退回 9222 并提示重启客户端，不会出错。
function debugPortFilePath() {
  const override = String(process.env.MINERADIO_SPOTIFY_PORT_FILE || '').trim();
  if (override) return override;
  return path.join(portablePaths.APP_NATIVE_TEMP_PATH || portablePaths.resolveNativeTempDir(), DEBUG_PORT_FILE_NAME);
}

function isValidDebugPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= DEBUG_PORT_MIN && port <= DEBUG_PORT_MAX;
}

function readSavedDebugPort() {
  try {
    const saved = Number(fs.readFileSync(debugPortFilePath(), 'utf8').trim());
    return isValidDebugPort(saved) ? saved : null;
  } catch (err) {
    return null;
  }
}

function saveDebugPort(port) {
  if (!isValidDebugPort(port)) return false;
  try {
    fs.writeFileSync(debugPortFilePath(), String(Number(port)), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

function forgetDebugPort() {
  try {
    fs.unlinkSync(debugPortFilePath());
    return true;
  } catch (err) {
    return false;
  }
}

// bind 一下再放掉：既排除别的程序占着的端口，也排除 Hyper-V / WSL 保留的区间
// （那些端口 listen 会直接 EACCES，bind 测试把它们一并筛掉）。
function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    try {
      probe.listen({ port, host: '127.0.0.1', exclusive: true });
    } catch (err) {
      resolve(false);
    }
  });
}

// crypto.randomInt 的均匀性有保证（Math.random 没有），上界是开区间。
async function pickDebugPort() {
  for (let i = 0; i < DEBUG_PORT_ATTEMPTS; i++) {
    const candidate = crypto.randomInt(DEBUG_PORT_MIN, DEBUG_PORT_MAX + 1);
    if (DEBUG_PORT_SKIP.has(candidate)) continue;
    if (await isPortFree(candidate)) return candidate;
  }
  // 十次都撞车几乎不可能；真撞上就如实失败，别偷偷退回固定端口。
  return 0;
}

async function waitForDebugPort(port, timeoutMs) {
  if (!isValidDebugPort(port)) return false;
  const deadline = Date.now() + (Number(timeoutMs) || DEBUG_PORT_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(600) });
      if (response.ok) return true;
    } catch (err) {
      // 还没起来，继续等
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return false;
}

// 记住的端口可能早就失效（客户端被关过、端口被系统回收）：探一下，没人应答就忘掉它。
// 只在启动时跑一次，默认 400ms 上限 —— "客户端没在跑"是常态，不该拖住启动。
async function verifySavedDebugPort(timeoutMs) {
  const saved = readSavedDebugPort();
  if (!saved) return null;
  if (await waitForDebugPort(saved, Number(timeoutMs) || 400)) return saved;
  forgetDebugPort();
  return null;
}

// MR 负责用调试端口启动客户端：用户不必改快捷方式。
// 已经在运行时**绝不**替用户关掉它 —— 那会打断正在放的音乐，只能提示重启接入。
// 端口每次随机（见上），所以启动成功后要把它记下来，MR 重启后才连得回同一个实例。
// MR starts the client with the debug port so the user never has to edit a shortcut.
// If it is already running we never close it; closing would interrupt playback.
async function launchClientWithDebugPort(port) {
  if (await isClientRunning()) {
    spotifyClientLog('launch-skipped', { reason: 'already-running', savedPort: readSavedDebugPort() });
    return { ok: false, reason: 'already-running', port: readSavedDebugPort() };
  }
  const exe = path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe');
  if (!fs.existsSync(exe)) {
    spotifyClientLog('launch-skipped', { reason: 'not-installed', path: exe });
    return { ok: false, reason: 'not-installed', path: exe };
  }
  // 调用方仍可指定端口（诊断用）；正常路径一律随机。
  const chosen = isValidDebugPort(port) ? Number(port) : await pickDebugPort();
  if (!chosen) {
    spotifyClientLog('launch-skipped', { reason: 'no-port' });
    return { ok: false, reason: 'no-port' };
  }
  try {
    const child = spawn(exe, ['--remote-debugging-port=' + chosen], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    saveDebugPort(chosen);
    spotifyClientLog('launch', { port: chosen, pid: child.pid || 0 });
    // 窗口守卫和端口探测并行跑，不占等待时间。
    suppressClientWindow().catch(() => {});
    // 端口真的应答了才算数；没应答也不阻断 —— 前端还会自己轮询 6 秒，
    // 这里只是给诊断留一个 portReady 字段。
    const ready = await waitForDebugPort(chosen);
    if (!ready) spotifyClientLog('launch-port-timeout', { port: chosen });
    return { ok: true, pid: child.pid || 0, port: chosen, portReady: ready };
  } catch (err) {
    spotifyClientLog('launch-failed', { port: chosen, error: (err && err.message) || err });
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

// 无安装、无重启、无调试端口的状态源：Windows 辅助功能（UI Automation）直接读客户端窗口里的
// 控件树。Chromium 在第一个 UIA 客户端接入时会打开无障碍树，歌词/曲名/进度条都在里面。
// 这一步只做"看得到什么"的取样，先量清楚再决定接线方式。
// A zero-install, zero-restart state source: read the client's control tree through UI Automation.
// Chromium turns its accessibility tree on when the first UIA client attaches. This samples what
// is actually exposed before anything is wired to it.
async function readWindowTree(limit, raw) {
  const max = Math.max(20, Math.min(600, Number(limit) || 240));
  // raw=true 时连没有名字的节点也一起吐出来：排查"网页内容到底进没进树"要看类名。
  const nameFilter = raw ? '' : '  if (-not $name -and -not $value) { continue }';
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    PS_UTF8,
    'Add-Type -AssemblyName UIAutomationClient | Out-Null',
    'Add-Type -AssemblyName UIAutomationTypes | Out-Null',
    '$p = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $p) { @{ ok = $false; reason = "no-window" } | ConvertTo-Json -Compress; exit 0 }',
    '$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)',
    'Start-Sleep -Milliseconds 500',
    '$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)',
    '$items = @()',
    'foreach ($el in $all) {',
    '  if ($items.Count -ge ' + max + ') { break }',
    '  $c = $el.Current',
    '  $type = ($c.ControlType.ProgrammaticName -replace "ControlType\\.", "")',
    '  $name = $c.Name',
    '  $value = ""',
    '  if ($type -eq "ProgressBar" -or $type -eq "Slider") {',
    '    try {',
    '      $rv = $el.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)',
    '      $value = [string][math]::Round($rv.Current.Value, 1) + "/" + [string][math]::Round($rv.Current.Maximum, 1)',
    '    } catch { }',
    '  }',
    nameFilter,
    '  $items += [pscustomobject]@{ type = $type; name = $name; id = $c.AutomationId; cls = $c.ClassName; value = $value }',
    '}',
    '@{ ok = $true; title = $p.MainWindowTitle; total = $all.Count; items = $items } | ConvertTo-Json -Depth 5 -Compress',
  ];
  const answer = await runPowerShell(lines, 30000);
  if (!answer || !answer.ok) return { ok: false, reason: (answer && answer.reason) || 'uia-failed' };
  return {
    ok: true,
    title: String(answer.title || ''),
    total: Number(answer.total) || 0,
    items: Array.isArray(answer.items) ? answer.items : [],
  };
}

// 播放状态读取：只问 UIA 要"当前播放栏"相关的那几类控件，不做全树枚举。
// 用控件名做筛选在 Node 侧完成（脚本保持 ASCII，PS 5.1 读无 BOM 中文会乱码）。
// Reads only the control types the player bar uses; name matching happens in Node so the
// script itself stays ASCII (PowerShell 5.1 misreads BOM-less UTF-8 with Chinese literals).
async function readPlayerState() {
  const started = Date.now();
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    PS_UTF8,
    'Add-Type -AssemblyName UIAutomationClient | Out-Null',
    'Add-Type -AssemblyName UIAutomationTypes | Out-Null',
    '$p = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $p) { @{ ok = $false; reason = "no-window" } | ConvertTo-Json -Compress; exit 0 }',
    '$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)',
    '$typeProp = [System.Windows.Automation.AutomationElement]::ControlTypeProperty',
    '$cGroup = [System.Windows.Automation.PropertyCondition]::new($typeProp, [System.Windows.Automation.ControlType]::Group)',
    '$cButton = [System.Windows.Automation.PropertyCondition]::new($typeProp, [System.Windows.Automation.ControlType]::Button)',
    '$cSlider = [System.Windows.Automation.PropertyCondition]::new($typeProp, [System.Windows.Automation.ControlType]::Slider)',
    '$cond = [System.Windows.Automation.OrCondition]::new([System.Windows.Automation.Condition[]]@($cGroup, $cButton, $cSlider))',
    '$nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)',
    '$groups = @()',
    '$buttons = @()',
    '$sliders = @()',
    'foreach ($el in $nodes) {',
    '  $c = $el.Current',
    '  $type = $c.ControlType.ProgrammaticName',
    '  if ($type -eq "ControlType.Group") { if ($c.Name) { $groups += $c.Name } }',
    '  elseif ($type -eq "ControlType.Button") { if ($c.Name) { $buttons += $c.Name } }',
    '  elseif ($type -eq "ControlType.Slider") {',
    '    try {',
    '      $rv = $el.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)',
    '      $sliders += [pscustomobject]@{ name = $c.Name; value = [double]$rv.Current.Value; max = [double]$rv.Current.Maximum }',
    '    } catch { }',
    '  }',
    '}',
    '@{ ok = $true; windowTitle = $p.MainWindowTitle; groups = $groups; buttons = $buttons; sliders = $sliders } | ConvertTo-Json -Depth 5 -Compress',
  ];
  const answer = await runPowerShell(lines, 20000);
  if (!answer || !answer.ok) {
    return { ok: false, reason: (answer && answer.reason) || 'uia-failed', elapsedMs: Date.now() - started };
  }
  const groups = Array.isArray(answer.groups) ? answer.groups : (answer.groups ? [answer.groups] : []);
  const buttons = Array.isArray(answer.buttons) ? answer.buttons : (answer.buttons ? [answer.buttons] : []);
  const sliders = Array.isArray(answer.sliders) ? answer.sliders : (answer.sliders ? [answer.sliders] : []);

  // 播放栏的无障碍名是「当前播放：<曲名>/<艺人>」，Spotify 支持多艺人时用逗号串在一起。
  // 曲名本身可能带斜杠，所以从最后一个斜杠切。
  const nowLabel = groups.find(name => /^当前播放\s*[：:]/.test(name))
    || groups.find(name => /^now playing\b/i.test(name))
    || '';
  let title = '';
  let artist = '';
  if (nowLabel) {
    const rest = nowLabel.replace(/^当前播放\s*[：:]\s*/, '').replace(/^now playing\s*[：:]\s*/i, '');
    const cut = rest.lastIndexOf('/');
    if (cut > 0) {
      title = rest.slice(0, cut).trim();
      artist = rest.slice(cut + 1).trim();
    } else {
      title = rest.trim();
    }
  }

  // 主按钮叫「播放」= 当前暂停，叫「暂停」= 当前在播。
  const playButton = buttons.find(name => /^(播放|暂停|play|pause)$/i.test(name)) || '';
  const isPlaying = /^(暂停|pause)$/i.test(playButton);

  // 进度滑块的量程就是毫秒；导航栏那个滑块量程只有几百像素，用值域排除。
  const progress = sliders.find(slider => Number(slider.max) > 5000) || null;

  return {
    ok: true,
    queriedAt: Date.now(),
    elapsedMs: Date.now() - started,
    windowTitle: String(answer.windowTitle || ''),
    isPlaying,
    playButton,
    positionMs: progress ? Math.max(0, Math.round(Number(progress.value) || 0)) : 0,
    durationMs: progress ? Math.max(0, Math.round(Number(progress.max) || 0)) : 0,
    track: { title, artist },
    nowPlayingLabel: nowLabel,
  };
}

module.exports = {
  readMediaSessions,
  readWindowTree,
  readPlayerState,
  launchClientWithDebugPort,
  readSavedDebugPort,
  saveDebugPort,
  forgetDebugPort,
  verifySavedDebugPort,
  pickDebugPort,
  isValidDebugPort,
  DEBUG_PORT_MIN,
  DEBUG_PORT_MAX,
  sendMediaKey,
  minimizeClientWindow,
  suppressClientWindow,
  CLIENT_WINDOW_GUARD_MS,
  inspectClientWindow,
  isClientRunning,
  MEDIA_KEYS,
};
