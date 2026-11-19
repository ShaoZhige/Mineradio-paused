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
const fs = require('fs');
const path = require('path');
const portablePaths = require('./portable-paths');

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

// MR 负责用调试端口启动客户端：用户不必改快捷方式。
// 已经在运行时**绝不**替用户关掉它 —— 那会打断正在放的音乐，只能提示重启接入。
// MR starts the client with the debug port so the user never has to edit a shortcut.
// If it is already running we never close it; closing would interrupt playback.
async function launchClientWithDebugPort(port) {
  if (await isClientRunning()) return { ok: false, reason: 'already-running' };
  const exe = path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe');
  if (!fs.existsSync(exe)) return { ok: false, reason: 'not-installed', path: exe };
  try {
    const child = spawn(exe, ['--remote-debugging-port=' + (Number(port) || 9222)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true, pid: child.pid || 0 };
  } catch (err) {
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
  sendMediaKey,
  minimizeClientWindow,
  inspectClientWindow,
  isClientRunning,
  MEDIA_KEYS,
};
