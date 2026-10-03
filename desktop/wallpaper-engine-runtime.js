'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { discoverSteamLibraries: defaultDiscoverSteamLibraries } = require('./wallpaper-engine-library');

const SIGNER_PATTERN = /\bSkutta Software\b/i;
const MIN_WIDTH = 64;
const MAX_WIDTH = 7680;
const MIN_HEIGHT = 64;
const MAX_HEIGHT = 4320;
const MIN_FPS = 15;
const MAX_FPS = 240;
const MIN_POSITION = -32000;
const MAX_POSITION = 32000;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 60;
const DEFAULT_X = 0;
const DEFAULT_Y = 0;
const DEFAULT_SOURCE_TIMEOUT_MS = 15000;
const DEFAULT_SOURCE_POLL_MS = 60;
const DEFAULT_REFRESH_SOURCE_TIMEOUT_MS = 1200;
const DEFAULT_REFRESH_SOURCE_POLL_MS = 80;
const ENGINE_BOOTSTRAP_TIMEOUT_MS = 20000;
const ENGINE_PROCESS_POLL_MS = 120;
const ENGINE_PROCESS_STABLE_MS = 720;
const ENGINE_READY_POLL_MS = 180;
const ENGINE_READY_SUCCESS_COUNT = 2;
const ENGINE_READY_CACHE_MS = 2500;
const INITIAL_MUTE_RETRY_DELAYS_MS = Object.freeze([0, 120, 320, 700, 1300, 2200]);
const INITIAL_MUTE_RETRY_DEADLINE_MS = 8000;
const MUTE_REASSERT_DELAYS_MS = Object.freeze([80, 220, 650, 1500, 3200, 6500, 10000]);
const SAFE_PROPERTY_KEY = /^[a-z0-9_.-]{1,128}$/i;
const BLOCKED_PROPERTY_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const WALLPAPER_PACKAGE_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const WALLPAPER_PACKAGE_SCENE_MAX_BYTES = 32 * 1024 * 1024;
const WALLPAPER_PACKAGE_ENTRY_MAX_COUNT = 32768;
const WALLPAPER_PACKAGE_ENTRY_NAME_MAX_BYTES = 4096;
const MUTED_SCENE_PACKAGE_CACHE_VERSION = 1;
const POINTER_RELAY_MAX_FPS = 120;
const POINTER_RELAY_START_TIMEOUT_MS = 5000;
const POINTER_RELAY_STOP_TIMEOUT_MS = 400;
const POINTER_RELAY_RETRY_DELAYS_MS = Object.freeze([360, 1200, 3000]);
const DWM_SURFACE_START_TIMEOUT_MS = 6000;
const DWM_SURFACE_STOP_TIMEOUT_MS = 600;
const DWM_SURFACE_RETRY_DELAY_MS = 650;

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function safeRuntimeOptions(options = {}) {
  return {
    width: clampInteger(options.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH),
    height: clampInteger(options.height, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT),
    fps: clampInteger(options.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS),
    x: clampInteger(options.x, MIN_POSITION, MAX_POSITION, DEFAULT_X),
    y: clampInteger(options.y, MIN_POSITION, MAX_POSITION, DEFAULT_Y),
    sourceTimeoutMs: clampInteger(options.sourceTimeoutMs, 500, 30000, DEFAULT_SOURCE_TIMEOUT_MS),
    sourcePollMs: clampInteger(options.sourcePollMs, 50, 1000, DEFAULT_SOURCE_POLL_MS),
    silentWindows: options.silentWindows !== false,
  };
}

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeEngineProcessState(value) {
  if (value === true) return { ok: true, running: true, matching: true, executable: '', matchingPids: [] };
  if (value === false) return { ok: true, running: false, matching: false, executable: '', matchingPids: [] };
  if (!value || typeof value !== 'object') {
    return { ok: false, running: false, matching: false, executable: '', matchingPids: [] };
  }
  return {
    ok: value.ok !== false,
    running: value.running === true,
    matching: value.matching === true,
    executable: String(value.executable || ''),
    matchingPids: Array.isArray(value.matchingPids)
      ? value.matchingPids.map((entry) => Number(entry) || 0).filter(Boolean)
      : [],
  };
}

function engineProcessPidList(state) {
  if (!Array.isArray(state && state.matchingPids)) return [];
  return state.matchingPids.map((value) => Number(value) || 0).filter(Boolean).sort((a, b) => a - b);
}

function engineProcessPidKey(state) {
  return engineProcessPidList(state).join(',');
}

// 要静默的是**壁纸核心**进程，不是 wallpaperengine 管理器。核心负责壁纸窗口以及它自己弹出的
// 各类对话框（右键菜单后的设置、更新提示），这些才是任务栏上的噪音；而 wallpaperengine 是
// 用户主动打开的管理器窗口，静默它就等于让用户再也找不回入口——从托盘点开也只会得到一个
// 看不见的窗口。所以边界划在这里：核心全静默，管理器放过。
//
// The silent set is the wallpaper CORE, not the wallpaperengine manager. The core owns the wallpaper
// window and every dialog it raises (settings after a right-click, update prompts) — that is the
// taskbar noise. The manager is a window the user opened on purpose, and silencing it would make it
// unreachable: even opening it from the tray would produce an invisible window. Hence the line:
// silence the core entirely, leave the manager alone.
const ENGINE_WINDOW_ISOLATION_PROCESSES = ['wallpaper32', 'wallpaper64'];

// 静音走 WE 接口而不是改包：改包会让 WE 判定来源不可信，每开一次壁纸弹一次安全确认框。
// 代价是开场到第一次 applyProperties 之间可能漏一点声音。详细取舍见
// _prepareSilentLaunchFile 的注释。
// Silence through the engine interface rather than by patching the package: patching makes the
// engine treat the wallpaper as an unverified source and raise a confirmation on every start. The
// cost is a sliver of audio before the first applyProperties lands; see the comment on
// _prepareSilentLaunchFile.
const ENGINE_MUTE_VIA_INTERFACE = true;

function sanitizeMuteProperties(value) {
  const output = Object.create(null);
  output.volume = 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...output };
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (count >= 32) break;
    const key = String(rawKey || '').trim();
    if (!SAFE_PROPERTY_KEY.test(key) || BLOCKED_PROPERTY_KEYS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'volume') continue;
    if (typeof rawValue === 'boolean') output[key] = rawValue;
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) output[key] = rawValue;
    else if (typeof rawValue === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(rawValue.trim())) {
      output[key] = rawValue.trim();
    }
    else continue;
    count += 1;
  }
  return { ...output };
}

async function statFile(target) {
  try {
    const stat = await fs.promises.stat(target);
    return stat.isFile() ? stat : null;
  } catch (_) {
    return null;
  }
}

async function readFileHandleRange(handle, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (!result || result.bytesRead <= 0) throw runtimeError('WALLPAPER_SCENE_PACKAGE_INVALID');
    offset += result.bytesRead;
  }
  return buffer;
}

function readPackageUInt32(buffer, state) {
  if (!buffer || !state || state.offset < 0 || state.offset + 4 > buffer.length) {
    throw runtimeError('WALLPAPER_SCENE_PACKAGE_INDEX_INVALID');
  }
  const value = buffer.readUInt32LE(state.offset);
  state.offset += 4;
  return value;
}

function readPackageString(buffer, state, maximumLength) {
  const length = readPackageUInt32(buffer, state);
  if (length <= 0 || length > maximumLength || state.offset + length > buffer.length) {
    throw runtimeError('WALLPAPER_SCENE_PACKAGE_INDEX_INVALID');
  }
  const value = buffer.subarray(state.offset, state.offset + length).toString('utf8');
  state.offset += length;
  return value;
}

async function readWallpaperPackageScene(scenePackage) {
  const packageStat = await statFile(scenePackage);
  if (!packageStat || packageStat.size < 32) throw runtimeError('WALLPAPER_SCENE_PACKAGE_INVALID');
  const handle = await fs.promises.open(scenePackage, 'r');
  try {
    const indexLength = Math.min(packageStat.size, WALLPAPER_PACKAGE_INDEX_MAX_BYTES);
    const indexBuffer = await readFileHandleRange(handle, indexLength, 0);
    const state = { offset: 0 };
    const header = readPackageString(indexBuffer, state, 32);
    if (!/^PKGV\d{4}$/i.test(header)) throw runtimeError('WALLPAPER_SCENE_PACKAGE_FORMAT_UNSUPPORTED');
    const entryCount = readPackageUInt32(indexBuffer, state);
    if (entryCount <= 0 || entryCount > WALLPAPER_PACKAGE_ENTRY_MAX_COUNT) {
      throw runtimeError('WALLPAPER_SCENE_PACKAGE_INDEX_INVALID');
    }
    let sceneEntry = null;
    for (let index = 0; index < entryCount; index += 1) {
      const name = readPackageString(indexBuffer, state, WALLPAPER_PACKAGE_ENTRY_NAME_MAX_BYTES);
      const offset = readPackageUInt32(indexBuffer, state);
      const length = readPackageUInt32(indexBuffer, state);
      if (name.replace(/\\/g, '/').toLowerCase() === 'scene.json') sceneEntry = { offset, length };
    }
    if (!sceneEntry || sceneEntry.length <= 0 || sceneEntry.length > WALLPAPER_PACKAGE_SCENE_MAX_BYTES) {
      throw runtimeError('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID');
    }
    const dataOffset = state.offset + sceneEntry.offset;
    if (!Number.isSafeInteger(dataOffset)
      || dataOffset < state.offset
      || dataOffset + sceneEntry.length > packageStat.size) {
      throw runtimeError('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID');
    }
    const sceneBuffer = await readFileHandleRange(handle, sceneEntry.length, dataOffset);
    let scene;
    try {
      scene = JSON.parse(sceneBuffer.toString('utf8').replace(/^\uFEFF/, ''));
    } catch (_) {
      throw runtimeError('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID');
    }
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
      throw runtimeError('WALLPAPER_SCENE_PACKAGE_SCENE_INVALID');
    }
    return {
      header,
      dataOffset,
      sceneLength: sceneEntry.length,
      scene,
      packageSize: packageStat.size,
      packageMtimeMs: Number(packageStat.mtimeMs) || 0,
    };
  } finally {
    await handle.close();
  }
}

function visitSceneAudioObjects(scene, visitor) {
  let audioObjectCount = 0;
  let visited = 0;
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 128) return;
    visited += 1;
    if (visited > 250000) throw runtimeError('WALLPAPER_SCENE_PACKAGE_SCENE_TOO_COMPLEX');
    if (Object.prototype.hasOwnProperty.call(value, 'sound')
      && (typeof value.sound === 'string' || Array.isArray(value.sound))) {
      audioObjectCount += 1;
      visitor(value);
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(scene, 0);
  return audioObjectCount;
}

function forceSceneAudioSilent(scene) {
  return visitSceneAudioObjects(scene, (value) => {
    value.startsilent = true;
    value.volume = 0;
  });
}

function inspectSceneAudioSilence(scene) {
  let allSilent = true;
  const audioObjectCount = visitSceneAudioObjects(scene, (value) => {
    if (value.startsilent !== true || value.volume !== 0) allSilent = false;
  });
  return { audioObjectCount, allSilent };
}

async function validateMutedScenePackage(scenePackage, expectedPackageSize, expectedAudioObjectCount) {
  try {
    const cached = await readWallpaperPackageScene(scenePackage);
    if (cached.packageSize !== expectedPackageSize) return false;
    const inspection = inspectSceneAudioSilence(cached.scene);
    return inspection.allSilent && inspection.audioObjectCount === expectedAudioObjectCount;
  } catch (_) {
    return false;
  }
}

function encodePatchedScene(scene, originalLength) {
  const encoded = Buffer.from(JSON.stringify(scene), 'utf8');
  if (encoded.length > originalLength) throw runtimeError('WALLPAPER_SCENE_PACKAGE_PATCH_TOO_LARGE');
  const output = Buffer.alloc(originalLength, 0x20);
  encoded.copy(output);
  return output;
}

function signatureScript() {
  const source = [
    "$ErrorActionPreference = 'Stop'",
    "$target = [Environment]::GetEnvironmentVariable('MINERADIO_WE_SIGNATURE_TARGET', 'Process')",
    'if ([string]::IsNullOrWhiteSpace($target)) { throw \'Missing signature target\' }',
    '$signature = Get-AuthenticodeSignature -LiteralPath $target',
    '[pscustomobject]@{',
    '  status = [string]$signature.Status',
    '  subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { \'\' }',
    '} | ConvertTo-Json -Compress',
  ].join('\r\n');
  return Buffer.from(source, 'utf16le').toString('base64');
}

function engineProcessProbeScript() {
  const source = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$target = [Environment]::GetEnvironmentVariable('MINERADIO_WE_ENGINE_TARGET', 'Process')
$expected = ''
try { if (-not [string]::IsNullOrWhiteSpace($target)) { $expected = [IO.Path]::GetFullPath($target) } } catch { $expected = '' }
$expectedRoot = ''
try { if ($expected) { $expectedRoot = [IO.Path]::GetDirectoryName($expected) } } catch { $expectedRoot = '' }
$processes = @(Get-Process -Name 'wallpaper32','wallpaper64' -ErrorAction SilentlyContinue)
$matching = @()
foreach ($process in $processes) {
  $candidate = ''
  try { $candidate = [IO.Path]::GetFullPath([string]$process.Path) } catch { $candidate = '' }
  $candidateRoot = ''
  try { if ($candidate) { $candidateRoot = [IO.Path]::GetDirectoryName($candidate) } } catch { $candidateRoot = '' }
  if ($expectedRoot -and $candidateRoot -and [string]::Equals($candidateRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $matching += [pscustomobject]@{ process = $process; path = $candidate }
  }
}
$preferred = @($matching | Where-Object { [string]::Equals([string]$_.path, $expected, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1)
$selected = if ($preferred.Count -gt 0) { $preferred[0] } elseif ($matching.Count -gt 0) { $matching[0] } else { $null }
[pscustomobject]@{
  running = $processes.Count -gt 0
  matching = $matching.Count -gt 0
  executable = if ($selected) { [string]$selected.path } else { '' }
  matchingPids = @($matching | ForEach-Object { [int]$_.process.Id })
} | ConvertTo-Json -Compress
`.trim();
  return Buffer.from(source, 'utf16le').toString('base64');
}

function controlBrokerScript() {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('MINERADIO_WE_CONTROL_TARGET', 'Process')
$commandLine = [Environment]::GetEnvironmentVariable('MINERADIO_WE_CONTROL_COMMAND_LINE', 'Process')
$waitForExit = [Environment]::GetEnvironmentVariable('MINERADIO_WE_CONTROL_WAIT', 'Process') -eq '1'
$waitTimeout = 10000
try { $waitTimeout = [Math]::Max(1000, [Math]::Min(20000, [int][Environment]::GetEnvironmentVariable('MINERADIO_WE_CONTROL_WAIT_TIMEOUT', 'Process'))) } catch { $waitTimeout = 10000 }
if ([string]::IsNullOrWhiteSpace($target) -or -not [IO.File]::Exists($target)) { throw 'Missing Wallpaper Engine control target' }
if ([string]::IsNullOrWhiteSpace($commandLine)) { throw 'Missing Wallpaper Engine control command line' }
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class MineradioExplorerParentLauncher {
  const uint PROCESS_CREATE_PROCESS = 0x0080;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint TOKEN_QUERY = 0x0008;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const int TOKEN_INTEGRITY_LEVEL = 25;
  const int SECURITY_MANDATORY_MEDIUM_RID = 0x2000;
  const int SECURITY_MANDATORY_HIGH_RID = 0x3000;
  const uint WAIT_OBJECT_0 = 0x00000000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_PARENT_PROCESS = new IntPtr(0x00020000);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct SID_AND_ATTRIBUTES {
    public IntPtr Sid;
    public uint Attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_MANDATORY_LABEL {
    public SID_AND_ATTRIBUTES Label;
  }

  [DllImport("user32.dll")]
  static extern IntPtr GetShellWindow();

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int tokenInformationLength, out int returnLength);

  [DllImport("advapi32.dll")]
  static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

  [DllImport("advapi32.dll")]
  static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthority);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, uint flags, ref IntPtr size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  static int GetIntegrityRid(IntPtr token) {
    int length = 0;
    GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, IntPtr.Zero, 0, out length);
    if (length <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr buffer = Marshal.AllocHGlobal(length);
    try {
      if (!GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, buffer, length, out length)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      TOKEN_MANDATORY_LABEL label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(buffer, typeof(TOKEN_MANDATORY_LABEL));
      IntPtr countPointer = GetSidSubAuthorityCount(label.Label.Sid);
      if (countPointer == IntPtr.Zero) throw new InvalidOperationException("Desktop Shell token has no integrity SID");
      byte count = Marshal.ReadByte(countPointer);
      if (count == 0) throw new InvalidOperationException("Desktop Shell token integrity SID is empty");
      IntPtr ridPointer = GetSidSubAuthority(label.Label.Sid, (uint)(count - 1));
      if (ridPointer == IntPtr.Zero) throw new InvalidOperationException("Desktop Shell token integrity RID is missing");
      return Marshal.ReadInt32(ridPointer);
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  public static int Launch(string application, string commandLine, string currentDirectory, bool waitForExit, int waitTimeout) {
    Process explorer = null;
    IntPtr explorerProcess = IntPtr.Zero;
    IntPtr explorerToken = IntPtr.Zero;
    IntPtr childToken = IntPtr.Zero;
    IntPtr attributeList = IntPtr.Zero;
    IntPtr parentValue = IntPtr.Zero;
    bool attributeListInitialized = false;
    PROCESS_INFORMATION processInformation = new PROCESS_INFORMATION();
    try {
      IntPtr shellWindow = GetShellWindow();
      if (shellWindow == IntPtr.Zero) throw new InvalidOperationException("Desktop Shell window not found");
      uint shellProcessId;
      if (GetWindowThreadProcessId(shellWindow, out shellProcessId) == 0 || shellProcessId == 0) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      explorer = Process.GetProcessById((int)shellProcessId);
      if (explorer.SessionId != Process.GetCurrentProcess().SessionId) {
        throw new InvalidOperationException("Desktop Shell belongs to a different session");
      }
      explorerProcess = OpenProcess(PROCESS_CREATE_PROCESS | PROCESS_QUERY_LIMITED_INFORMATION, false, explorer.Id);
      if (explorerProcess == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!OpenProcessToken(explorerProcess, TOKEN_QUERY, out explorerToken)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      int integrityRid = GetIntegrityRid(explorerToken);
      if (integrityRid < SECURITY_MANDATORY_MEDIUM_RID || integrityRid >= SECURITY_MANDATORY_HIGH_RID) {
        throw new InvalidOperationException("Desktop Shell token is not medium integrity");
      }
      IntPtr attributeSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      if (attributeSize == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      attributeList = Marshal.AllocHGlobal(attributeSize);
      if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      attributeListInitialized = true;
      parentValue = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(parentValue, explorerProcess);
      if (!UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, parentValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      STARTUPINFOEX startupInfo = new STARTUPINFOEX();
      startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startupInfo.StartupInfo.lpDesktop = @"winsta0\default";
      startupInfo.lpAttributeList = attributeList;
      StringBuilder mutableCommandLine = new StringBuilder(commandLine);
      if (!CreateProcessW(application, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, currentDirectory, ref startupInfo, out processInformation)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      // PROC_THREAD_ATTRIBUTE_PARENT_PROCESS makes Windows inherit Explorer's
      // process token. Verify that contract immediately and fail closed if a
      // future Windows/runtime change ever produces a high-integrity child.
      if (!OpenProcessToken(processInformation.hProcess, TOKEN_QUERY, out childToken)) {
        TerminateProcess(processInformation.hProcess, 1);
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      int childIntegrityRid = GetIntegrityRid(childToken);
      if (childIntegrityRid < SECURITY_MANDATORY_MEDIUM_RID || childIntegrityRid >= SECURITY_MANDATORY_HIGH_RID) {
        TerminateProcess(processInformation.hProcess, 1);
        throw new InvalidOperationException("Wallpaper Engine child is not medium integrity");
      }
      if (waitForExit) {
        uint waitResult = WaitForSingleObject(processInformation.hProcess, (uint)Math.Max(1000, waitTimeout));
        if (waitResult != WAIT_OBJECT_0) throw new TimeoutException("Wallpaper Engine control command did not exit in time");
        uint exitCode;
        if (!GetExitCodeProcess(processInformation.hProcess, out exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (exitCode != 0) throw new InvalidOperationException("Wallpaper Engine control command failed with exit code " + exitCode);
      }
      return processInformation.dwProcessId;
    } finally {
      if (processInformation.hThread != IntPtr.Zero) CloseHandle(processInformation.hThread);
      if (processInformation.hProcess != IntPtr.Zero) CloseHandle(processInformation.hProcess);
      if (childToken != IntPtr.Zero) CloseHandle(childToken);
      if (attributeListInitialized && attributeList != IntPtr.Zero) DeleteProcThreadAttributeList(attributeList);
      if (parentValue != IntPtr.Zero) Marshal.FreeHGlobal(parentValue);
      if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
      if (explorerToken != IntPtr.Zero) CloseHandle(explorerToken);
      if (explorerProcess != IntPtr.Zero) CloseHandle(explorerProcess);
      if (explorer != null) explorer.Dispose();
    }
  }
}

'@
Add-Type -TypeDefinition $source -Language CSharp
$workingDirectory = [IO.Path]::GetDirectoryName($target)
[void][MineradioExplorerParentLauncher]::Launch($target, $commandLine, $workingDirectory, $waitForExit, $waitTimeout)
`.trim();
  // 返回**原始脚本**（与 nativeDwmThumbnailSurfaceScript 一致），不再自行 base64：调用方
  // _powerShellHelperArgs 需要原文才能写成 .ps1 文件。这个脚本编码后约 3.08 万字符，距
  // Windows 32767 命令行上限只剩两千余量，再长出几行就会和窗口控制器一样直接起不来，所以
  // 一并改走 -File。
  // Returns the RAW script, matching nativeDwmThumbnailSurfaceScript, because the caller needs
  // the source text to write a .ps1 file. Encoded it runs to ~30.8k characters, leaving barely
  // two thousand before the Windows 32767 command-line cap, so it moves to -File as well before
  // a few more lines make it unspawnable.
  return source;
}

function nativeWindowControlScript() {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$action = [Environment]::GetEnvironmentVariable('MINERADIO_WE_WINDOW_ACTION', 'Process')
$sourceId = [Environment]::GetEnvironmentVariable('MINERADIO_WE_WINDOW_SOURCE_ID', 'Process')
$expectedTitle = [Environment]::GetEnvironmentVariable('MINERADIO_WE_WINDOW_TITLE', 'Process')
$expectedExecutable = [Environment]::GetEnvironmentVariable('MINERADIO_WE_WINDOW_EXECUTABLE', 'Process')
$hostWindowId = [Environment]::GetEnvironmentVariable('MINERADIO_WE_HOST_WINDOW_ID', 'Process')
$hostExecutable = [Environment]::GetEnvironmentVariable('MINERADIO_WE_HOST_EXECUTABLE', 'Process')
$hostCornerRadius = [Environment]::GetEnvironmentVariable('MINERADIO_WE_HOST_CORNER_RADIUS', 'Process')
if ([string]::IsNullOrWhiteSpace($action) -or [string]::IsNullOrWhiteSpace($sourceId)) { throw 'Missing window control input' }
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class MineradioWeWindowResult {
  public bool ok { get; set; }
  public bool missing { get; set; }
  public bool moved { get; set; }
  public bool embedded { get; set; }
  public bool parked { get; set; }
  public bool aligned { get; set; }
  public bool rounded { get; set; }
  public bool closePosted { get; set; }
  public bool closed { get; set; }
  public long closeWaitMs { get; set; }
  public bool taskbarIsolated { get; set; }
  public long left { get; set; }
  public long top { get; set; }
  public long right { get; set; }
  public long bottom { get; set; }
  public long visibleWidth { get; set; }
  public long visibleHeight { get; set; }
  public uint processId { get; set; }
  public long hostLeft { get; set; }
  public long hostTop { get; set; }
  public long hostRight { get; set; }
  public long hostBottom { get; set; }
}

public static class MineradioWeWindowControl {
  const uint WM_CLOSE = 0x0010;
  const int SM_XVIRTUALSCREEN = 76;
  const int SM_YVIRTUALSCREEN = 77;
  const int SM_CXVIRTUALSCREEN = 78;
  const int SM_CYVIRTUALSCREEN = 79;

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("gdi32.dll", SetLastError=true)] static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int widthEllipse, int heightEllipse);
  [DllImport("user32.dll", SetLastError=true)] static extern int SetWindowRgn(IntPtr hWnd, IntPtr region, bool redraw);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] static extern long GetWindowLongPtrW(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError=true)] static extern long SetWindowLongPtrW(IntPtr hWnd, int index, long value);

  [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ITaskbarList {
    void HrInit();
    void AddTab(IntPtr hWnd);
    void DeleteTab(IntPtr hWnd);
    void ActivateTab(IntPtr hWnd);
    void SetActiveAlt(IntPtr hWnd);
  }

  [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
  class TaskbarList { }

  // 把窗口从 shell 表面摘掉：DeleteTab 移除任务栏按钮，WS_EX_TOOLWINDOW 让 Alt+Tab 也
  // 不再列出它。只改扩展样式、不碰位置尺寸，因此 DWM 缩略图对齐到的 source 矩形不受影响。
  // Drop the window out of the shell surfaces without touching its geometry, so the DWM
  // thumbnail keeps the exact source rect it was aligned to.
  static bool IsolateFromShell(IntPtr hWnd) {
    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x00000080L;
    const long WS_EX_APPWINDOW = 0x00040000L;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_FRAMECHANGED = 0x0020;
    bool isolated = false;
    try {
      ITaskbarList taskbar = (ITaskbarList)new TaskbarList();
      taskbar.HrInit();
      taskbar.DeleteTab(hWnd);
      Marshal.FinalReleaseComObject(taskbar);
      isolated = true;
    } catch { }
    long style = GetWindowLongPtrW(hWnd, GWL_EXSTYLE);
    long next = (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    if (next != style) {
      SetWindowLongPtrW(hWnd, GWL_EXSTYLE, next);
      if (!SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0,
          SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      isolated = true;
    }
    return isolated;
  }

  static IntPtr ParseHandle(string sourceId) {
    string[] parts = (sourceId ?? "").Split(':');
    if (parts.Length != 3 || !String.Equals(parts[0], "window", StringComparison.Ordinal)) throw new InvalidOperationException("Invalid capture source id");
    ulong raw;
    if (!UInt64.TryParse(parts[1], out raw) || raw == 0) throw new InvalidOperationException("Invalid capture window handle");
    return IntPtr.Size == 8 ? new IntPtr(unchecked((long)raw)) : new IntPtr(unchecked((int)raw));
  }

  static IntPtr ParseRawHandle(string rawHandle) {
    ulong raw;
    if (!UInt64.TryParse(rawHandle ?? "", out raw) || raw == 0) throw new InvalidOperationException("Invalid host window handle");
    return IntPtr.Size == 8 ? new IntPtr(unchecked((long)raw)) : new IntPtr(unchecked((int)raw));
  }

  static string WindowTitle(IntPtr hWnd) {
    StringBuilder text = new StringBuilder(1024);
    GetWindowTextW(hWnd, text, text.Capacity);
    return text.ToString();
  }

  static MineradioWeWindowResult Snapshot(IntPtr hWnd, uint processId) {
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
    int virtualLeft = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int virtualTop = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int virtualRight = virtualLeft + Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
    int virtualBottom = virtualTop + Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
    long visibleWidth = Math.Max(0, Math.Min(rect.Right, virtualRight) - Math.Max(rect.Left, virtualLeft));
    long visibleHeight = Math.Max(0, Math.Min(rect.Bottom, virtualBottom) - Math.Max(rect.Top, virtualTop));
    return new MineradioWeWindowResult {
      ok = true,
      left = rect.Left,
      top = rect.Top,
      right = rect.Right,
      bottom = rect.Bottom,
      visibleWidth = visibleWidth,
      visibleHeight = visibleHeight,
      processId = processId
    };
  }

  static uint ValidateProcess(IntPtr hWnd, string expectedExecutable) {
    uint processId;
    if (GetWindowThreadProcessId(hWnd, out processId) == 0 || processId == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    Process process = Process.GetProcessById((int)processId);
    try {
      string actual = Path.GetFullPath(process.MainModule.FileName);
      string expected = Path.GetFullPath(expectedExecutable ?? "");
      if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Window process mismatch");
    } finally { process.Dispose(); }
    return processId;
  }

  static bool ApplyCornerRegion(IntPtr hWnd, RECT rect, string rawRadius) {
    int radius;
    if (!Int32.TryParse(rawRadius ?? "", out radius)) radius = 0;
    radius = Math.Max(0, Math.Min(512, radius));
    if (radius <= 0) {
      SetWindowRgn(hWnd, IntPtr.Zero, true);
      return false;
    }
    int width = Math.Max(1, rect.Right - rect.Left);
    int height = Math.Max(1, rect.Bottom - rect.Top);
    IntPtr region = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
    if (region == IntPtr.Zero) return false;
    if (SetWindowRgn(hWnd, region, true) == 0) {
      DeleteObject(region);
      return false;
    }
    // SetWindowRgn owns the region after success.
    return true;
  }

  static MineradioWeWindowResult RunDpiAware(string action, string sourceId, string expectedTitle, string expectedExecutable, string hostWindowId, string hostExecutable, string hostCornerRadius) {
    IntPtr hWnd = ParseHandle(sourceId);
    if (!IsWindow(hWnd)) return new MineradioWeWindowResult { ok = true, missing = true };
    if (!String.Equals(WindowTitle(hWnd), expectedTitle ?? "", StringComparison.Ordinal)) throw new InvalidOperationException("Capture window title mismatch");
    uint processId = ValidateProcess(hWnd, expectedExecutable);

    if (String.Equals(action, "close", StringComparison.OrdinalIgnoreCase)) {
      MineradioWeWindowResult closeResult = Snapshot(hWnd, processId);
      closeResult.closePosted = PostMessageW(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
      if (!closeResult.closePosted) throw new Win32Exception(Marshal.GetLastWin32Error());
      Stopwatch closeWait = Stopwatch.StartNew();
      // 场景还在初始化时弹出窗口的收尾可能远超 1.8 秒，硬等固定上限会让整个原生会话
      // 因为"没等够"而失败（上层只看到一个笼统的关窗失败，画面直接退回项目预览）。
      // 这里改成轮询到 HWND 真正消失为止，并把实际等待时长回传供上层记录原因。
      // A pop-out still initializing can take far longer than 1.8s to tear down; the old
      // fixed cap failed the whole native session merely for not waiting long enough, and
      // the caller only saw a generic close failure. Poll until the HWND is really gone and
      // report the actual wait so the cause is traceable.
      while (IsWindow(hWnd) && closeWait.ElapsedMilliseconds < 6000) Thread.Sleep(40);
      closeResult.closeWaitMs = closeWait.ElapsedMilliseconds;
      closeResult.closed = !IsWindow(hWnd);
      closeResult.missing = closeResult.closed;
      return closeResult;
    }
    if (String.Equals(action, "park", StringComparison.OrdinalIgnoreCase)) {
      RECT currentRect;
      if (!GetWindowRect(hWnd, out currentRect)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int width = Math.Max(1, currentRect.Right - currentRect.Left);
      int height = Math.Max(1, currentRect.Bottom - currentRect.Top);
      int virtualRight = GetSystemMetrics(SM_XVIRTUALSCREEN) + Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
      int virtualBottom = GetSystemMetrics(SM_YVIRTUALSCREEN) + Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
      const uint SWP_NOZORDER = 0x0004;
      const uint SWP_NOACTIVATE = 0x0010;
      const uint SWP_NOOWNERZORDER = 0x0200;
      const uint SWP_NOSENDCHANGING = 0x0400;
      if (!SetWindowPos(hWnd, IntPtr.Zero, virtualRight - 1, virtualBottom - 1, width, height,
          SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      MineradioWeWindowResult parkResult = Snapshot(hWnd, processId);
      parkResult.moved = true;
      parkResult.parked = parkResult.visibleWidth <= 1 && parkResult.visibleHeight <= 1;
      if (!parkResult.parked) throw new InvalidOperationException("Capture source window did not enter the parking strip");
      return parkResult;
    }
    if (String.Equals(action, "isolate", StringComparison.OrdinalIgnoreCase)) {
      MineradioWeWindowResult isolateResult = Snapshot(hWnd, processId);
      isolateResult.taskbarIsolated = IsolateFromShell(hWnd);
      return isolateResult;
    }
    if (!String.Equals(action, "embed", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unsupported window control action");
    IntPtr hostHWnd = ParseRawHandle(hostWindowId);
    if (!IsWindow(hostHWnd)) throw new InvalidOperationException("Host window is missing");
    ValidateProcess(hostHWnd, hostExecutable);
    RECT hostRect;
    if (!GetWindowRect(hostHWnd, out hostRect)) throw new Win32Exception(Marshal.GetLastWin32Error());
    RECT sourceRect;
    if (!GetWindowRect(hWnd, out sourceRect)) throw new Win32Exception(Marshal.GetLastWin32Error());
    bool rounded = ApplyCornerRegion(hWnd, sourceRect, hostCornerRadius);
    const int tolerance = 2;
    bool aligned = !(Math.Abs(sourceRect.Left - hostRect.Left) > tolerance
      || Math.Abs(sourceRect.Top - hostRect.Top) > tolerance
      || Math.Abs(sourceRect.Right - hostRect.Right) > tolerance
      || Math.Abs(sourceRect.Bottom - hostRect.Bottom) > tolerance);
    MineradioWeWindowResult result = Snapshot(hWnd, processId);
    result.moved = false;
    result.embedded = true;
    result.aligned = aligned;
    result.rounded = rounded;
    result.hostLeft = hostRect.Left;
    result.hostTop = hostRect.Top;
    result.hostRight = hostRect.Right;
    result.hostBottom = hostRect.Bottom;
    return result;
  }

  public static MineradioWeWindowResult Run(string action, string sourceId, string expectedTitle, string expectedExecutable, string hostWindowId, string hostExecutable, string hostCornerRadius) {
    IntPtr previousDpiContext = IntPtr.Zero;
    try {
      // powershell.exe has no PMv2 manifest, so GetWindowRect otherwise returns
      // DPI-virtualized DIPs and can approve a 1536x960 source for a 1920x1200 host.
      previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
    } catch { }
    try {
      return RunDpiAware(action, sourceId, expectedTitle, expectedExecutable, hostWindowId, hostExecutable, hostCornerRadius);
    } finally {
      if (previousDpiContext != IntPtr.Zero) {
        try { SetThreadDpiAwarenessContext(previousDpiContext); } catch { }
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[MineradioWeWindowControl]::Run($action, $sourceId, $expectedTitle, $expectedExecutable, $hostWindowId, $hostExecutable, $hostCornerRadius) | ConvertTo-Json -Compress
`.trim();
  // 返回**原始脚本**（与 nativeDwmThumbnailSurfaceScript 一致），不再自行 base64。这个脚本
  // 编码后约 3.85 万字符，超过 Windows 32767 的命令行上限：以前用 -EncodedCommand 调用时，
  // spawn 会直接以 ENAMETOOLONG 失败，embed/close/park 每一步都失败，壁纸永远退回封面图。
  // Returns the RAW script, matching nativeDwmThumbnailSurfaceScript. Encoded it runs to about
  // 38.5k characters, past the Windows 32767 command-line cap: called with -EncodedCommand,
  // spawn failed with ENAMETOOLONG before the process started, so every embed/close/park step
  // failed and the wallpaper always fell back to its cover art.
  return source;
}

function nativeProcessWindowIsolationScript() {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$processNames = @((Get-Item Env:MINERADIO_WE_ISOLATE_PROCESSES -ErrorAction SilentlyContinue).Value -split ',' |
  ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z0-9_. -]+$' })
if ($processNames.Count -eq 0) { throw 'Missing isolate process list' }
$once = $env:MINERADIO_WE_ISOLATE_ONCE -eq '1'
$emptyPasses = 0
$EMPTY_PASS_LIMIT = 12
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class MineradioWeProcessWindowIsolation {
  [DllImport("user32.dll", SetLastError=true)] static extern long GetWindowLongPtrW(IntPtr hWnd, int index);
  [DllImport("user32.dll", SetLastError=true)] static extern long SetWindowLongPtrW(IntPtr hWnd, int index, long value);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr param);

  [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ITaskbarList {
    void HrInit();
    void AddTab(IntPtr hWnd);
    void DeleteTab(IntPtr hWnd);
    void ActivateTab(IntPtr hWnd);
    void SetActiveAlt(IntPtr hWnd);
  }

  [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
  class TaskbarList { }

  const int GWL_EXSTYLE = -20;
  const long WS_EX_TOOLWINDOW = 0x00000080L;
  const long WS_EX_APPWINDOW = 0x00040000L;
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOZORDER = 0x0004;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint SWP_FRAMECHANGED = 0x0020;

  static bool Isolate(IntPtr hWnd) {
    bool isolated = false;
    try {
      ITaskbarList taskbar = (ITaskbarList)new TaskbarList();
      taskbar.HrInit();
      taskbar.DeleteTab(hWnd);
      Marshal.FinalReleaseComObject(taskbar);
      isolated = true;
    } catch { }
    long style = GetWindowLongPtrW(hWnd, GWL_EXSTYLE);
    long next = (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    if (next != style) {
      SetWindowLongPtrW(hWnd, GWL_EXSTYLE, next);
      SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0,
        SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      isolated = true;
    }
    return isolated;
  }

  // 每一轮都重新按进程名解析 PID，而不是把启动那一刻的 PID 列表钉死：WE 中途重启（用户重开
  // 它、或它自己崩了重启）之后，绑死 PID 的监视器会在旧 PID 消失时判定"引擎已退出"并随之退出，
  // 之后的任务栏就再也没人管了——这正是"有时候会冒出来"的另一个真正来源。按名字解析则永远
  // 跟着最新的实例走，主进程也不需要再挂心跳去重启它。
  // Resolve the PIDs by process name on every pass instead of pinning the list captured at start-up:
  // once the engine restarts, a PID-bound monitor sees its old PIDs vanish, declares the engine gone
  // and exits with them, leaving the taskbar unattended from then on. That is another real source of
  // "it shows up sometimes". Resolving by name always follows the newest instance, and the main
  // process needs no heartbeat to restart it.
  public static int[] ResolvePids(string[] processNames) {
    var pids = new List<int>();
    foreach (string name in processNames) {
      if (string.IsNullOrWhiteSpace(name)) continue;
      Process[] found;
      try { found = Process.GetProcessesByName(name); } catch { continue; }
      foreach (Process process in found) {
        try { pids.Add(process.Id); } catch { } finally { process.Dispose(); }
      }
    }
    return pids.ToArray();
  }

  static string Class(IntPtr hWnd) {
    var sb = new StringBuilder(256);
    GetClassNameW(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  static string Title(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    GetWindowTextW(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  // 只静默**壁纸播放窗口**，其余一律放过。
  //
  // 早先的版本对引擎进程的每一个可见窗口都改样式 + SetWindowPos(SWP_FRAMECHANGED)，那会把
  // Wallpaper Engine 自己的对话框一并 restyle。而引擎很可能正靠那个窗口跟踪"用户还没确认这个
  // 来源警告"，被反复改样式就会让它认为对话框已失效，于是重新弹一个 —— 表现为**每次启动壁纸
  // 都要点一次 OK**。用户主动打开的设置窗口、商店界面也同样不该由我们插手。
  //
  // Only the wallpaper playback window is silenced; everything else is left alone. Earlier versions
  // restyled every visible window of the engine process, which included its own origin-confirmation
  // dialog. The engine most likely tracks that dialog's state to know the user has not answered
  // yet, so restyling it repeatedly can make it conclude the dialog is gone and raise another one —
  // surfacing as "every wallpaper start asks me to press OK". Settings windows the user opened on
  // purpose, and the shop UI, deserve the same restraint.
  public static int Run(int[] processIds) {
    var targets = new HashSet<int>(processIds);
    int isolated = 0;
    EnumWindows(delegate(IntPtr hWnd, IntPtr param) {
      try {
        if (!IsWindow(hWnd) || !IsWindowVisible(hWnd)) return true;
        uint owner;
        GetWindowThreadProcessId(hWnd, out owner);
        if (owner == 0 || !targets.Contains((int)owner)) return true;
        // 类名与标题任一命中即可：类名是常态，标题是类名在不同版本里变了时的兜底。
        // Either the class or the title matching is enough: the class is the normal case, and the
        // title is the backstop for versions that rename the class.
        bool isWallpaperWindow = String.Equals(Class(hWnd), "WPEOverlappedWallpaper", StringComparison.Ordinal)
          || Title(hWnd).StartsWith("Mineradio Wallpaper ", StringComparison.Ordinal);
        if (!isWallpaperWindow) return true;
        if (Isolate(hWnd)) isolated++;
      } catch { }
      return true;
    }, IntPtr.Zero);
    return isolated;
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$deadline = (Get-Date).AddMinutes(30)
while ($true) {
  # 引擎实例换了（重启过）不算退出：重新按名字解析，监视器继续跟。只有连续多轮一个实例都
  # 找不到，才认定引擎真的走了。
  # A swapped engine instance is not an exit: re-resolve by name and keep following. Only a run of
  # consecutive passes with no instance at all means the engine is really gone.
  $targets = @([MineradioWeProcessWindowIsolation]::ResolvePids($processNames))
  if ($targets.Count -eq 0) {
    $emptyPasses += 1
    if ($emptyPasses -ge $EMPTY_PASS_LIMIT) { Write-Output 'isolated=0 reason=engine-exited'; break }
  } else {
    $emptyPasses = 0
  }
  $isolated = 0
  try { $isolated = [MineradioWeProcessWindowIsolation]::Run([int[]]$targets) } catch { $isolated = 0 }
  Write-Output ('isolated=' + $isolated)
  if ($once) { break }
  if ((Get-Date) -ge $deadline) { Write-Output 'reason=deadline'; break }
  Start-Sleep -Milliseconds 1500
}
`.trim();
  return Buffer.from(source, 'utf16le').toString('base64');
}

function nativeParallaxPointerRelayScript() {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$sourceId = [Environment]::GetEnvironmentVariable('MINERADIO_WE_POINTER_SOURCE_ID', 'Process')
$expectedTitle = [Environment]::GetEnvironmentVariable('MINERADIO_WE_POINTER_SOURCE_TITLE', 'Process')
$expectedExecutable = [Environment]::GetEnvironmentVariable('MINERADIO_WE_POINTER_SOURCE_EXECUTABLE', 'Process')
$hostWindowId = [Environment]::GetEnvironmentVariable('MINERADIO_WE_POINTER_HOST_WINDOW_ID', 'Process')
$hostExecutable = [Environment]::GetEnvironmentVariable('MINERADIO_WE_POINTER_HOST_EXECUTABLE', 'Process')
$sessionId = [Environment]::GetEnvironmentVariable('MINERADIO_WE_POINTER_SESSION_ID', 'Process')
if ([string]::IsNullOrWhiteSpace($sourceId) -or [string]::IsNullOrWhiteSpace($expectedTitle) -or
    [string]::IsNullOrWhiteSpace($expectedExecutable) -or [string]::IsNullOrWhiteSpace($hostWindowId) -or
    [string]::IsNullOrWhiteSpace($hostExecutable) -or [string]::IsNullOrWhiteSpace($sessionId)) {
  throw 'Missing native parallax pointer relay input'
}
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MineradioWeParallaxPointerRelay {
  const uint WM_MOUSEMOVE = 0x0200;
  const uint GA_ROOT = 2;

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")]
  static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll")]
  static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

  static IntPtr ParseSourceHandle(string sourceId) {
    string[] parts = (sourceId ?? "").Split(':');
    if (parts.Length != 3 || !String.Equals(parts[0], "window", StringComparison.Ordinal)) {
      throw new InvalidOperationException("Invalid capture source id");
    }
    ulong raw;
    if (!UInt64.TryParse(parts[1], out raw) || raw == 0) {
      throw new InvalidOperationException("Invalid capture source window handle");
    }
    return IntPtr.Size == 8 ? new IntPtr(unchecked((long)raw)) : new IntPtr(unchecked((int)raw));
  }

  static IntPtr ParseRawHandle(string rawHandle) {
    ulong raw;
    if (!UInt64.TryParse(rawHandle ?? "", out raw) || raw == 0) {
      throw new InvalidOperationException("Invalid host window handle");
    }
    return IntPtr.Size == 8 ? new IntPtr(unchecked((long)raw)) : new IntPtr(unchecked((int)raw));
  }

  static string WindowTitle(IntPtr hWnd) {
    StringBuilder text = new StringBuilder(1024);
    GetWindowTextW(hWnd, text, text.Capacity);
    return text.ToString();
  }

  static string WindowClass(IntPtr hWnd) {
    StringBuilder text = new StringBuilder(256);
    GetClassNameW(hWnd, text, text.Capacity);
    return text.ToString();
  }

  static uint ValidateProcess(IntPtr hWnd, string expectedExecutable) {
    if (!IsWindow(hWnd)) throw new InvalidOperationException("Pointer relay window is missing");
    uint processId;
    if (GetWindowThreadProcessId(hWnd, out processId) == 0 || processId == 0) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    Process process = Process.GetProcessById((int)processId);
    try {
      string actual = Path.GetFullPath(process.MainModule.FileName);
      string expected = Path.GetFullPath(expectedExecutable ?? "");
      if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) {
        throw new InvalidOperationException("Pointer relay window process mismatch");
      }
    } finally {
      process.Dispose();
    }
    return processId;
  }

  static void ValidateBoundWindow(IntPtr hWnd, uint expectedProcessId) {
    if (!IsWindow(hWnd)) throw new InvalidOperationException("Pointer relay window disappeared");
    uint processId;
    if (GetWindowThreadProcessId(hWnd, out processId) == 0 || processId != expectedProcessId) {
      throw new InvalidOperationException("Pointer relay window identity changed");
    }
  }

  static IntPtr FindSceneInputWindow(IntPtr source, uint sourceProcessId) {
    List<IntPtr> candidates = new List<IntPtr>();
    EnumChildWindows(source, (hWnd, lParam) => {
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      if (processId == sourceProcessId
          && String.Equals(WindowClass(hWnd), "WPEDesktopDX11Window", StringComparison.Ordinal)
          && String.Equals(WindowTitle(hWnd), "WPELiveWallpaper", StringComparison.Ordinal)
          && GetAncestor(hWnd, GA_ROOT) == source) {
        candidates.Add(hWnd);
      }
      return true;
    }, IntPtr.Zero);
    if (candidates.Count != 1) {
      throw new InvalidOperationException("Expected one WPE Scene input window, found " + candidates.Count);
    }
    return candidates[0];
  }

  static void ValidateSceneInputWindow(IntPtr sceneInput, IntPtr source, uint sourceProcessId) {
    ValidateBoundWindow(sceneInput, sourceProcessId);
    if (GetAncestor(sceneInput, GA_ROOT) != source
        || !String.Equals(WindowClass(sceneInput), "WPEDesktopDX11Window", StringComparison.Ordinal)
        || !String.Equals(WindowTitle(sceneInput), "WPELiveWallpaper", StringComparison.Ordinal)) {
      throw new InvalidOperationException("Pointer relay Scene input window identity changed");
    }
  }

  static int MapCoordinate(int value, int sourceSize, int targetSize) {
    if (sourceSize <= 1 || targetSize <= 1) return 0;
    value = Math.Max(0, Math.Min(sourceSize - 1, value));
    return (int)Math.Max(0, Math.Min(targetSize - 1,
      ((long)value * (long)(targetSize - 1) + (sourceSize - 1) / 2) / (sourceSize - 1)));
  }

  static bool ForwardPointer(IntPtr source, uint sourceProcessId, string expectedTitle,
      IntPtr sceneInput, IntPtr host, uint hostProcessId, int xUnit, int yUnit) {
    ValidateBoundWindow(source, sourceProcessId);
    ValidateSceneInputWindow(sceneInput, source, sourceProcessId);
    ValidateBoundWindow(host, hostProcessId);
    if (!String.Equals(WindowTitle(source), expectedTitle ?? "", StringComparison.Ordinal)) {
      throw new InvalidOperationException("Pointer relay capture window title changed");
    }
    RECT sceneRect;
    if (!GetClientRect(sceneInput, out sceneRect)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    int sceneWidth = Math.Max(1, sceneRect.Right - sceneRect.Left);
    int sceneHeight = Math.Max(1, sceneRect.Bottom - sceneRect.Top);
    int mappedX = MapCoordinate(xUnit, 65536, sceneWidth);
    int mappedY = MapCoordinate(yUnit, 65536, sceneHeight);
    int packed = unchecked((mappedY << 16) | (mappedX & 0xffff));
    if (!PostMessageW(sceneInput, WM_MOUSEMOVE, IntPtr.Zero, new IntPtr(packed))) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return true;
  }

  public static void Run(string sourceId, string expectedTitle, string expectedExecutable,
      string hostWindowId, string hostExecutable, string sessionId) {
    IntPtr previousDpiContext = IntPtr.Zero;
    try {
      previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
    } catch { }
    try {
      IntPtr source = ParseSourceHandle(sourceId);
      IntPtr host = ParseRawHandle(hostWindowId);
      uint sourceProcessId = ValidateProcess(source, expectedExecutable);
      uint hostProcessId = ValidateProcess(host, hostExecutable);
      if (!String.Equals(WindowTitle(source), expectedTitle ?? "", StringComparison.Ordinal)) {
        throw new InvalidOperationException("Pointer relay capture window title mismatch");
      }
      IntPtr sceneInput = FindSceneInputWindow(source, sourceProcessId);
      Console.WriteLine("{\"ok\":true,\"ready\":true,\"sourceProcessId\":" + sourceProcessId
        + ",\"hostProcessId\":" + hostProcessId
        + ",\"sceneInputWindowHandle\":" + sceneInput.ToInt64() + "}");
      Console.Out.Flush();

      string line;
      while ((line = Console.ReadLine()) != null) {
        line = line.Trim();
        if (String.Equals(line, "Q", StringComparison.Ordinal)) break;
        string[] command = line.Split(':');
        if (command.Length != 3 || !String.Equals(command[0], "M", StringComparison.Ordinal)) continue;
        int xUnit;
        int yUnit;
        if (!Int32.TryParse(command[1], out xUnit) || !Int32.TryParse(command[2], out yUnit)
            || xUnit < 0 || xUnit > 65535 || yUnit < 0 || yUnit > 65535) continue;
        ForwardPointer(source, sourceProcessId, expectedTitle, sceneInput, host, hostProcessId, xUnit, yUnit);
      }
    } finally {
      if (previousDpiContext != IntPtr.Zero) {
        try { SetThreadDpiAwarenessContext(previousDpiContext); } catch { }
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[MineradioWeParallaxPointerRelay]::Run($sourceId, $expectedTitle, $expectedExecutable, $hostWindowId, $hostExecutable, $sessionId)
`.trim();
  return Buffer.from(source, 'utf16le').toString('base64');
}

function nativeDwmThumbnailSurfaceScript() {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$sourceId = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_SOURCE_ID', 'Process')
$expectedTitle = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_SOURCE_TITLE', 'Process')
$expectedExecutable = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_SOURCE_EXECUTABLE', 'Process')
$hostWindowId = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_HOST_WINDOW_ID', 'Process')
$hostExecutable = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_HOST_EXECUTABLE', 'Process')
$hostCornerRadius = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_HOST_CORNER_RADIUS', 'Process')
$desktopIconLayering = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_DESKTOP_ICON_LAYERING', 'Process')
$visualOpacity = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_VISUAL_OPACITY', 'Process')
$visualPositionX = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_VISUAL_POSITION_X', 'Process')
$visualPositionY = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_VISUAL_POSITION_Y', 'Process')
$visualScale = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_VISUAL_SCALE', 'Process')
$sessionId = [Environment]::GetEnvironmentVariable('MINERADIO_WE_DWM_SESSION_ID', 'Process')
if ([string]::IsNullOrWhiteSpace($sourceId) -or [string]::IsNullOrWhiteSpace($expectedTitle) -or
    [string]::IsNullOrWhiteSpace($expectedExecutable) -or [string]::IsNullOrWhiteSpace($hostWindowId) -or
    [string]::IsNullOrWhiteSpace($hostExecutable) -or [string]::IsNullOrWhiteSpace($sessionId)) {
  throw 'Missing DWM surface host input'
}
$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public sealed class MineradioWeDwmSurfaceHost : Form {
  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct DWM_THUMBNAIL_PROPERTIES {
    public uint dwFlags;
    public RECT rcDestination;
    public RECT rcSource;
    public byte opacity;
    [MarshalAs(UnmanagedType.Bool)] public bool fVisible;
    [MarshalAs(UnmanagedType.Bool)] public bool fSourceClientAreaOnly;
  }

  const uint DWM_TNP_RECTDESTINATION = 0x00000001;
  const uint DWM_TNP_OPACITY = 0x00000004;
  const uint DWM_TNP_VISIBLE = 0x00000008;
  const uint DWM_TNP_SOURCECLIENTAREAONLY = 0x00000010;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint SWP_SHOWWINDOW = 0x0040;
  const int WM_NCHITTEST = 0x0084;
  const int HTTRANSPARENT = -1;
  const uint GA_ROOT = 2;
  const uint MONITOR_DEFAULTTONEAREST = 2;

  [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ITaskbarList {
    void HrInit();
    void AddTab(IntPtr hWnd);
    void DeleteTab(IntPtr hWnd);
    void ActivateTab(IntPtr hWnd);
    void SetActiveAlt(IntPtr hWnd);
  }

  [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
  class TaskbarList { }

  [DllImport("user32.dll")]
  static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

  [DllImport("user32.dll")]
  static extern bool IsWindow(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter,
    int x, int y, int width, int height, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter,
    string className, string windowName);

  [DllImport("user32.dll")]
  static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

  [DllImport("user32.dll")]
  static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

  [DllImport("gdi32.dll", SetLastError = true)]
  static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom,
    int widthEllipse, int heightEllipse);

  [DllImport("user32.dll", SetLastError = true)]
  static extern int SetWindowRgn(IntPtr hWnd, IntPtr region, bool redraw);

  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr handle);

  [DllImport("dwmapi.dll")]
  static extern int DwmRegisterThumbnail(IntPtr destination, IntPtr source, out IntPtr thumbnail);

  [DllImport("dwmapi.dll")]
  static extern int DwmUpdateThumbnailProperties(IntPtr thumbnail,
    ref DWM_THUMBNAIL_PROPERTIES properties);

  [DllImport("dwmapi.dll")]
  static extern int DwmUnregisterThumbnail(IntPtr thumbnail);

  readonly IntPtr hostWindow;
  readonly IntPtr sourceWindow;
  readonly string sourceTitle;
  readonly int windowCornerRadius;
  bool desktopIconLayeringEnabled;
  readonly System.Windows.Forms.Timer followTimer;
  IntPtr thumbnail = IntPtr.Zero;
  int lastWidth = -1;
  int lastHeight = -1;
  int lastRadius = -1;
  int consecutiveFollowFailures = 0;
  IntPtr desktopIconHost = IntPtr.Zero;
  int visualOpacity = 255;
  int visualPositionX = 0;
  int visualPositionY = 0;
  // 1x：默认不放大。旧默认 1.08 会让 DWM 缩略图无条件按 1.08 重采样一次，壁纸表面
  // 从一开始就是"放大后再画"的，观感发虚且取景被裁。
  // 1x means no zoom: the legacy 1.08 default resampled the DWM thumbnail surface on
  // every frame, softening the wallpaper and cropping its framing from the start.
  int visualScale = 1000000;

  MineradioWeDwmSurfaceHost(IntPtr host, IntPtr source, string expectedTitle, int cornerRadius,
      bool enableDesktopIconLayering, int initialOpacity, int initialPositionX,
      int initialPositionY, int initialScale) {
    hostWindow = host;
    sourceWindow = source;
    sourceTitle = expectedTitle ?? "";
    windowCornerRadius = Math.Max(0, Math.Min(512, cornerRadius));
    desktopIconLayeringEnabled = enableDesktopIconLayering;
    visualOpacity = Math.Max(38, Math.Min(255, initialOpacity));
    visualPositionX = Math.Max(-500000, Math.Min(500000, initialPositionX));
    visualPositionY = Math.Max(-500000, Math.Min(500000, initialPositionY));
    visualScale = Math.Max(1000000, Math.Min(1600000, initialScale));
    FormBorderStyle = FormBorderStyle.None;
    // 这个窗口之前一直挂在任务栏上，标题就叫 "Mineradio WE DWM Surface"——用户以为 WE 还活着，
    // 其实那是本程序自己的 DWM 表面助手。ShowInTaskbar = true 让 WinForms 给了它
    // WS_EX_APPWINDOW，于是就有了那个任务栏条目。改成 false，WinForms 会用 WS_EX_TOOLWINDOW
    // 建这个窗口，任务栏与 Alt+Tab 都不会再出现它。
    //
    // 曾经还有一段手动 SetWindowLongPtr(GWL_EXSTYLE) + DeleteTab 的兜底，但项目契约明确禁止在
    // DWM 表面块里出现 SetWindowLong（防的是用改样式做窗口停放或隐藏），所以收敛到这一行：
    // WinForms 自己就会把 WS_EX_APPWINDOW 换成 WS_EX_TOOLWINDOW，不需要手工改样式。
    //
    // This window used to sit on the taskbar under the title "Mineradio WE DWM Surface", which read
    // like Wallpaper Engine was still running while it was really this app's own DWM surface helper.
    // ShowInTaskbar = true made WinForms give it WS_EX_APPWINDOW, which is where the taskbar entry
    // came from. Setting it to false makes WinForms use WS_EX_TOOLWINDOW instead, so neither the
    // taskbar nor the Alt+Tab list shows it any more.
    //
    // There was also a manual SetWindowLongPtr(GWL_EXSTYLE) + DeleteTab backstop, but the project
    // contract explicitly forbids SetWindowLong inside the DWM surface block (it guards against
    // using restyling for window parking or hiding). So this collapses to one line: WinForms swaps
    // WS_EX_APPWINDOW for WS_EX_TOOLWINDOW by itself and no manual restyling is needed.
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    BackColor = Color.Black;
    Text = "Mineradio WE DWM Surface";
    followTimer = new System.Windows.Forms.Timer();
    followTimer.Interval = 60;
    followTimer.Tick += delegate {
      try { FollowHost(); }
      catch (Exception error) {
        Console.Error.WriteLine(error.Message);
        Console.Error.Flush();
        bool identityValid = IsWindow(hostWindow) && IsWindow(sourceWindow)
          && String.Equals(WindowTitle(sourceWindow), sourceTitle, StringComparison.Ordinal);
        consecutiveFollowFailures += 1;
        // Explorer reparenting and DPI changes can make one FollowHost tick
        // fail transiently. Keep the one DWM helper alive for a short bounded
        // window; invalid HWND/title identity still closes immediately.
        if (!identityValid || consecutiveFollowFailures >= 8) Close();
      }
    };
  }

  protected override bool ShowWithoutActivation { get { return true; } }

  protected override void WndProc(ref Message message) {
    if (message.Msg == WM_NCHITTEST) {
      message.Result = new IntPtr(HTTRANSPARENT);
      return;
    }
    base.WndProc(ref message);
  }

  protected override void OnShown(EventArgs eventArgs) {
    base.OnShown(eventArgs);
    FollowHost();
    followTimer.Start();
    Thread inputThread = new Thread(delegate() {
      try {
        string line;
        while ((line = Console.ReadLine()) != null) {
          string command = line.Trim();
          if (String.Equals(command, "Q", StringComparison.Ordinal)) break;
          if (String.Equals(command, "D", StringComparison.Ordinal)) {
            try {
              if (!IsDisposed && IsHandleCreated) BeginInvoke(new Action(delegate() {
                ActivateThumbnail();
                Console.WriteLine("{\"ok\":true,\"dwm\":true,\"active\":true,\"surfaceWindowHandle\":"
                  + Handle.ToInt64() + "}");
                Console.Out.Flush();
              }));
            } catch { }
            continue;
          }
          if (command.StartsWith("I|", StringComparison.Ordinal)) {
            string value = command.Substring(2);
            if (!String.Equals(value, "0", StringComparison.Ordinal)
                && !String.Equals(value, "1", StringComparison.Ordinal)) continue;
            bool enabled = String.Equals(value, "1", StringComparison.Ordinal);
            try {
              if (!IsDisposed && IsHandleCreated) BeginInvoke(new Action(delegate() {
                desktopIconLayeringEnabled = enabled;
                if (!enabled) desktopIconHost = IntPtr.Zero;
                FollowHost();
                Console.WriteLine("{\"ok\":true,\"iconLayering\":true,\"enabled\":"
                  + (enabled ? "true" : "false") + "}");
                Console.Out.Flush();
              }));
            } catch { }
            continue;
          }
          if (command.StartsWith("V|", StringComparison.Ordinal)) {
            string[] values = command.Split('|');
            int nextOpacity, nextPositionX, nextPositionY, nextScale;
            if (values.Length != 5
                || !Int32.TryParse(values[1], out nextOpacity)
                || !Int32.TryParse(values[2], out nextPositionX)
                || !Int32.TryParse(values[3], out nextPositionY)
                || !Int32.TryParse(values[4], out nextScale)) continue;
            try {
              if (!IsDisposed && IsHandleCreated) BeginInvoke(new Action(delegate() {
                visualOpacity = Math.Max(38, Math.Min(255, nextOpacity));
                visualPositionX = Math.Max(-500000, Math.Min(500000, nextPositionX));
                visualPositionY = Math.Max(-500000, Math.Min(500000, nextPositionY));
                visualScale = Math.Max(1000000, Math.Min(1600000, nextScale));
                FollowHost();
                Console.WriteLine("{\"ok\":true,\"visual\":true,\"opacity\":" + visualOpacity
                  + ",\"positionX\":" + visualPositionX + ",\"positionY\":" + visualPositionY
                  + ",\"scale\":" + visualScale + "}");
                Console.Out.Flush();
              }));
            } catch { }
            continue;
          }
        }
      } catch { }
      try {
        if (!IsDisposed && IsHandleCreated) BeginInvoke(new Action(Close));
      } catch { }
    });
    inputThread.IsBackground = true;
    inputThread.Start();
    Console.WriteLine("{\"ok\":true,\"ready\":true,\"hostWindowHandle\":"
      + hostWindow.ToInt64() + ",\"sourceWindowHandle\":" + sourceWindow.ToInt64()
      + ",\"surfaceWindowHandle\":" + Handle.ToInt64() + ",\"desktopIconLayering\":"
      + (desktopIconLayeringEnabled ? "true" : "false") + "}");
    Console.Out.Flush();
  }

  protected override void OnFormClosed(FormClosedEventArgs eventArgs) {
    followTimer.Stop();
    if (thumbnail != IntPtr.Zero) {
      DwmUnregisterThumbnail(thumbnail);
      thumbnail = IntPtr.Zero;
    }
    base.OnFormClosed(eventArgs);
  }

  static IntPtr ParseSourceHandle(string sourceId) {
    string[] parts = (sourceId ?? "").Split(':');
    if (parts.Length != 3 || !String.Equals(parts[0], "window", StringComparison.Ordinal)) {
      throw new InvalidOperationException("Invalid DWM source id");
    }
    return ParseRawHandle(parts[1]);
  }

  static IntPtr ParseRawHandle(string rawHandle) {
    ulong raw;
    if (!UInt64.TryParse(rawHandle ?? "", out raw) || raw == 0) {
      throw new InvalidOperationException("Invalid DWM window handle");
    }
    return IntPtr.Size == 8 ? new IntPtr(unchecked((long)raw)) : new IntPtr(unchecked((int)raw));
  }

  static string WindowTitle(IntPtr hWnd) {
    StringBuilder text = new StringBuilder(1024);
    GetWindowTextW(hWnd, text, text.Capacity);
    return text.ToString();
  }

  static uint ValidateProcess(IntPtr hWnd, string expectedExecutable) {
    if (!IsWindow(hWnd)) throw new InvalidOperationException("DWM window is missing");
    uint processId;
    if (GetWindowThreadProcessId(hWnd, out processId) == 0 || processId == 0) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    using (Process process = Process.GetProcessById((int)processId)) {
      string actual = Path.GetFullPath(process.MainModule.FileName);
      string expected = Path.GetFullPath(expectedExecutable ?? "");
      if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) {
        throw new InvalidOperationException("DWM window process mismatch");
      }
    }
    return processId;
  }

  static bool RectMatches(RECT first, RECT second) {
    const int tolerance = 2;
    return Math.Abs(first.Left - second.Left) <= tolerance
      && Math.Abs(first.Top - second.Top) <= tolerance
      && Math.Abs(first.Right - second.Right) <= tolerance
      && Math.Abs(first.Bottom - second.Bottom) <= tolerance;
  }

  static bool ContainsDesktopIconView(IntPtr candidate) {
    return candidate != IntPtr.Zero && IsWindow(candidate)
      && FindWindowEx(candidate, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero;
  }

  static IntPtr FindDesktopIconHost() {
    IntPtr progman = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Progman", null);
    if (ContainsDesktopIconView(progman)) return progman;

    IntPtr worker = IntPtr.Zero;
    while ((worker = FindWindowEx(IntPtr.Zero, worker, "WorkerW", null)) != IntPtr.Zero) {
      if (ContainsDesktopIconView(worker)) return worker;
    }
    return IntPtr.Zero;
  }

  IntPtr ResolveDesktopIconHost() {
    if (!ContainsDesktopIconView(desktopIconHost)) desktopIconHost = FindDesktopIconHost();
    return desktopIconHost;
  }

  int ResolveCornerRadius(RECT hostRect) {
    IntPtr monitor = MonitorFromWindow(hostWindow, MONITOR_DEFAULTTONEAREST);
    if (monitor != IntPtr.Zero) {
      MONITORINFO info = new MONITORINFO();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      if (GetMonitorInfo(monitor, ref info)
          && (RectMatches(hostRect, info.rcMonitor) || RectMatches(hostRect, info.rcWork))) return 0;
    }
    return windowCornerRadius;
  }

  static void ApplyCornerRegion(IntPtr hWnd, int width, int height, int radius) {
    if (radius <= 0) {
      SetWindowRgn(hWnd, IntPtr.Zero, true);
      return;
    }
    IntPtr region = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
    if (region == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (SetWindowRgn(hWnd, region, true) == 0) {
      DeleteObject(region);
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    // SetWindowRgn owns the region after a successful call.
  }

  void ActivateThumbnail() {
    if (thumbnail != IntPtr.Zero) return;
    int result = DwmRegisterThumbnail(Handle, sourceWindow, out thumbnail);
    if (result != 0 || thumbnail == IntPtr.Zero) {
      throw new InvalidOperationException("DwmRegisterThumbnail failed: 0x" + result.ToString("X8"));
    }
    FollowHost();
    // Keep the priming HWND a normal Shell capture target until WGC is already
    // live. Removing the taskbar tab earlier makes CreateForWindow reject it.
    try {
      ITaskbarList taskbar = (ITaskbarList)new TaskbarList();
      taskbar.HrInit();
      taskbar.DeleteTab(Handle);
      Marshal.FinalReleaseComObject(taskbar);
    } catch { }
  }

  void FollowHost() {
    if (!IsWindow(hostWindow) || !IsWindow(sourceWindow)) {
      Close();
      return;
    }
    if (!String.Equals(WindowTitle(sourceWindow), sourceTitle, StringComparison.Ordinal)) {
      throw new InvalidOperationException("DWM source window identity changed");
    }
    RECT hostRect;
    if (!GetWindowRect(hostWindow, out hostRect)) throw new Win32Exception(Marshal.GetLastWin32Error());
    int width = Math.Max(1, hostRect.Right - hostRect.Left);
    int height = Math.Max(1, hostRect.Bottom - hostRect.Top);
    int radius = ResolveCornerRadius(hostRect);

    // There is deliberately no second native glass window. The single base
    // DWM surface is captured directly and cropped by Chromium only inside the
    // existing control bar, avoiding an extra transparent layer in the UI.
    // In desktop coexistence the authoritative Electron HWND is a shaped child
    // above DefView inside Explorer's icon WorkerW. Keep that same icon host
    // between Mineradio and the one base DWM surface. Normal top-level windows
    // may opt in too; unrelated WorkerW children retain the exact fallback.
    IntPtr hostRoot = GetAncestor(hostWindow, GA_ROOT);
    // A hot flag change may overlap the native reparenting transition by one
    // follow tick. Resolve the real icon host whenever the authoritative host
    // is currently a child, so a top-level surface is never ordered relative
    // to a non-sibling child HWND. Explicit opt-in still handles the preflight
    // while the Electron host is top-level.
    IntPtr iconHost = (desktopIconLayeringEnabled || hostRoot != hostWindow)
      ? ResolveDesktopIconHost() : IntPtr.Zero;
    if (iconHost != IntPtr.Zero && hostRoot != hostWindow && hostRoot != iconHost) iconHost = IntPtr.Zero;
    IntPtr hostLayer = hostRoot != IntPtr.Zero && hostRoot != hostWindow ? hostRoot : hostWindow;
    IntPtr surfaceInsertAfter = iconHost != IntPtr.Zero ? iconHost : hostLayer;
    if (thumbnail != IntPtr.Zero) {
      if (!SetWindowPos(Handle, surfaceInsertAfter, hostRect.Left, hostRect.Top, width, height,
          SWP_NOACTIVATE | SWP_SHOWWINDOW)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!SetWindowPos(sourceWindow, Handle, hostRect.Left, hostRect.Top, width, height,
          SWP_NOACTIVATE | SWP_SHOWWINDOW)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } else {
      // Until WGC has primed the SVG sampler, show the real source above the
      // empty DWM destination so startup never flashes a black base frame.
      if (!SetWindowPos(sourceWindow, surfaceInsertAfter, hostRect.Left, hostRect.Top, width, height,
          SWP_NOACTIVATE | SWP_SHOWWINDOW)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!SetWindowPos(Handle, sourceWindow, hostRect.Left, hostRect.Top, width, height,
          SWP_NOACTIVATE | SWP_SHOWWINDOW)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    if (width != lastWidth || height != lastHeight || radius != lastRadius) {
      ApplyCornerRegion(Handle, width, height, radius);
      ApplyCornerRegion(sourceWindow, width, height, radius);
      lastWidth = width;
      lastHeight = height;
      lastRadius = radius;
    }

    if (thumbnail != IntPtr.Zero) {
      DWM_THUMBNAIL_PROPERTIES properties = new DWM_THUMBNAIL_PROPERTIES();
      properties.dwFlags = DWM_TNP_RECTDESTINATION | DWM_TNP_OPACITY
        | DWM_TNP_VISIBLE | DWM_TNP_SOURCECLIENTAREAONLY;
      double positionX = visualPositionX / 500000.0;
      double positionY = visualPositionY / 500000.0;
      double requestedScale = visualScale / 1000000.0;
      double automaticOverscan = 1.0 + Math.Max(Math.Abs(positionX), Math.Abs(positionY)) * 0.18;
      double appliedScale = Math.Max(requestedScale, automaticOverscan);
      int destinationWidth = Math.Max(width, (int)Math.Round(width * appliedScale));
      int destinationHeight = Math.Max(height, (int)Math.Round(height * appliedScale));
      int travelX = Math.Max(0, (destinationWidth - width) / 2);
      int travelY = Math.Max(0, (destinationHeight - height) / 2);
      int destinationLeft = -travelX + (int)Math.Round(travelX * positionX);
      int destinationTop = -travelY + (int)Math.Round(travelY * positionY);
      properties.rcDestination = new RECT {
        Left = destinationLeft,
        Top = destinationTop,
        Right = destinationLeft + destinationWidth,
        Bottom = destinationTop + destinationHeight
      };
      properties.opacity = (byte)visualOpacity;
      properties.fVisible = true;
      properties.fSourceClientAreaOnly = true;
      int result = DwmUpdateThumbnailProperties(thumbnail, ref properties);
      if (result != 0) {
        throw new InvalidOperationException("DwmUpdateThumbnailProperties failed: 0x" + result.ToString("X8"));
      }
    }
    consecutiveFollowFailures = 0;
  }

  public static void Run(string sourceId, string expectedTitle, string expectedExecutable,
      string hostWindowId, string hostExecutable, string rawCornerRadius, string rawDesktopIconLayering,
      string rawOpacity, string rawPositionX, string rawPositionY, string rawScale) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    IntPtr source = ParseSourceHandle(sourceId);
    IntPtr host = ParseRawHandle(hostWindowId);
    ValidateProcess(source, expectedExecutable);
    ValidateProcess(host, hostExecutable);
    if (!String.Equals(WindowTitle(source), expectedTitle ?? "", StringComparison.Ordinal)) {
      throw new InvalidOperationException("DWM source title mismatch");
    }
    int cornerRadius;
    if (!Int32.TryParse(rawCornerRadius ?? "", out cornerRadius)) cornerRadius = 0;
    bool enableDesktopIconLayering = String.Equals(rawDesktopIconLayering, "1", StringComparison.Ordinal);
    int initialOpacity, initialPositionX, initialPositionY, initialScale;
    if (!Int32.TryParse(rawOpacity ?? "", out initialOpacity)) initialOpacity = 255;
    if (!Int32.TryParse(rawPositionX ?? "", out initialPositionX)) initialPositionX = 0;
    if (!Int32.TryParse(rawPositionY ?? "", out initialPositionY)) initialPositionY = 0;
    if (!Int32.TryParse(rawScale ?? "", out initialScale)) initialScale = 1000000;
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new MineradioWeDwmSurfaceHost(host, source, expectedTitle, cornerRadius,
      enableDesktopIconLayering, initialOpacity, initialPositionX, initialPositionY, initialScale));
  }
}
'@
Add-Type -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing') -TypeDefinition $source -Language CSharp
try {
  [MineradioWeDwmSurfaceHost]::Run($sourceId, $expectedTitle, $expectedExecutable, $hostWindowId, $hostExecutable, $hostCornerRadius, $desktopIconLayering, $visualOpacity, $visualPositionX, $visualPositionY, $visualScale)
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  if ($_.Exception.InnerException) { [Console]::Error.WriteLine($_.Exception.InnerException.ToString()) }
  [Console]::Error.Flush()
  exit 1
}
`.trim();
  return source;
}

function quoteWindowsArgument(value) {
  const text = String(value == null ? '' : value);
  if (text && !/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function wallpaperRawPropertiesIndex(args) {
  if (!Array.isArray(args)) return -1;
  const optionIndex = args.findIndex((value) => String(value || '').toLowerCase() === '-properties');
  const rawIndex = optionIndex >= 0 ? optionIndex + 1 : -1;
  if (rawIndex <= 0 || rawIndex >= args.length) return -1;
  const raw = String(args[rawIndex] || '');
  if (!raw.startsWith('RAW~(') || !raw.endsWith(')~END') || /[\u0000\r\n]/.test(raw)) return -1;
  try {
    const parsed = JSON.parse(raw.slice(5, -5));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return -1;
  } catch (_) {
    return -1;
  }
  return rawIndex;
}

function verbatimWallpaperControlArguments(args) {
  const rawIndex = wallpaperRawPropertiesIndex(args);
  if (rawIndex < 0) return null;
  return args.map((value, index) => index === rawIndex
    ? String(value)
    : quoteWindowsArgument(value));
}

function wallpaperControlCommandLine(executable, args) {
  const verbatimArgs = verbatimWallpaperControlArguments(args);
  const argumentLine = (verbatimArgs || (Array.isArray(args) ? args : []).map(quoteWindowsArgument)).join(' ');
  return `${quoteWindowsArgument(executable)}${argumentLine ? ` ${argumentLine}` : ''}`;
}

function defaultEngineProcessProbe(powerShellExecutable, nativeTempPath, expectedExecutable) {
  return new Promise((resolve) => {
    childProcess.execFile(powerShellExecutable || 'powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      engineProcessProbeScript(),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3500,
      maxBuffer: 16 * 1024,
      shell: false,
      env: {
        ...process.env,
        TEMP: nativeTempPath,
        TMP: nativeTempPath,
        MINERADIO_NATIVE_TEMP_DIR: nativeTempPath,
        MINERADIO_WE_ENGINE_TARGET: String(expectedExecutable || ''),
      },
    }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, running: false, matching: false, executable: '', matchingPids: [] });
        return;
      }
      const jsonLine = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).reverse().find((line) => /^\{.*\}$/.test(line));
      try {
        const result = jsonLine ? JSON.parse(jsonLine) : null;
        if (!result
          || typeof result !== 'object'
          || typeof result.running !== 'boolean'
          || typeof result.matching !== 'boolean') {
          throw new Error('Wallpaper Engine process probe returned invalid data');
        }
        resolve({
          ok: true,
          running: result && result.running === true,
          matching: result && result.matching === true,
          executable: String(result && result.executable || ''),
          matchingPids: Array.isArray(result && result.matchingPids)
            ? result.matchingPids.map((value) => Number(value) || 0).filter(Boolean)
            : [],
        });
      } catch (_) {
        resolve({ ok: false, running: false, matching: false, executable: '', matchingPids: [] });
      }
    });
  });
}

function defaultDesktopCapturer() {
  try {
    return require('electron').desktopCapturer;
  } catch (_) {
    return null;
  }
}

class WallpaperEngineRuntime {
  constructor(options = {}) {
    this.library = options.library || null;
    this.desktopCapturer = options.desktopCapturer || defaultDesktopCapturer();
    this.discoverSteamLibraries = options.discoverSteamLibraries || defaultDiscoverSteamLibraries;
    this.execFile = options.execFile || childProcess.execFile;
    this.controlExecFile = options.controlExecFile || childProcess.execFile;
    this.spawn = options.spawn || childProcess.spawn;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.nativeSleep = options.nativeSleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now || Date.now;
    this.wallNow = options.wallNow || Date.now;
    this.powerShellExecutable = options.powerShellExecutable || 'powershell.exe';
    this.nativeTempPath = path.resolve(String(
      options.nativeTempPath
      || process.env.MINERADIO_NATIVE_TEMP_DIR
      || path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), 'Mineradio', 'native-helper-temp')
    ));
    fs.mkdirSync(this.nativeTempPath, { recursive: true });
    this.nativeExecFile = options.nativeExecFile || childProcess.execFile;
    this.pointerRelaySpawn = options.pointerRelaySpawn || childProcess.spawn;
    this.dwmSurfaceSpawn = options.dwmSurfaceSpawn || childProcess.spawn;
    this.dwmSurfaceStartTimeoutMs = clampInteger(
      options.dwmSurfaceStartTimeoutMs,
      10,
      30000,
      DWM_SURFACE_START_TIMEOUT_MS
    );
    this.pointerRelayStartTimeoutMs = clampInteger(
      options.pointerRelayStartTimeoutMs,
      10,
      30000,
      POINTER_RELAY_START_TIMEOUT_MS
    );
    this.pointerRelayRetryDelaysMs = Array.isArray(options.pointerRelayRetryDelaysMs)
      ? options.pointerRelayRetryDelaysMs
        .map((value) => clampInteger(value, 1, 30000, 0))
        .filter((value) => value > 0)
        .slice(0, POINTER_RELAY_RETRY_DELAYS_MS.length)
      : [...POINTER_RELAY_RETRY_DELAYS_MS];
    if (!this.pointerRelayRetryDelaysMs.length) {
      this.pointerRelayRetryDelaysMs = [...POINTER_RELAY_RETRY_DELAYS_MS];
    }
    // 发往引擎的命令行日志。排查"引擎为什么弹这个框"这类问题时，唯一能定论的东西就是
    // 我们到底发了什么命令——之前没有它，只能靠猜，或者去监听寿命只有几十毫秒的控制进程。
    // Command-line log for everything sent to the engine. When the engine raises a dialog and the
    // cause is not obvious, the one thing that settles it is what we actually sent — without this
    // you either guess or try to catch a control process that lives a few dozen milliseconds.
    this.controlCommandLogPath = String(options.controlCommandLogPath || '').trim();
    this.windowController = typeof options.windowController === 'function'
      ? options.windowController
      : ((action, details) => this._nativeWindowControl(action, details));
    this.engineProcessProbe = options.engineProcessProbe
      || ((expectedExecutable) => defaultEngineProcessProbe(
        this.powerShellExecutable,
        this.nativeTempPath,
        expectedExecutable
      ));
    this.engineReadyProbe = typeof options.engineReadyProbe === 'function'
      ? options.engineReadyProbe
      : ((executable) => this._runTransientControl(executable, [
        '-control',
        'getWallpaper',
        '-monitor',
        '0',
      ]));
    this.useDesktopShellBroker = this.platform === 'win32' && options.useDesktopShellBroker !== false;
    this.hostElevationProbe = typeof options.hostElevationProbe === 'function'
      ? options.hostElevationProbe
      : (async () => null);
    this.hostElevationCache = null;
    this.signatureCache = new Map();
    this.executableCache = null;
    this.executableDiscoveryPromise = null;
    this.engineBootstrapPromise = null;
    this.engineBootstrapExecutable = '';
    this.engineReadyExecutable = '';
    this.engineReadyAt = 0;
    this.engineReadyPidsKey = '';
    this.active = null;
    this.pending = null;
    this.generation = 0;
    this.disposed = false;
  }

  _publicSession(session) {
    if (!session) return null;
    return {
      ok: true,
      active: true,
      id: session.id,
      sessionId: session.sessionId,
      sourceId: session.sourceId,
      width: session.width,
      height: session.height,
      fps: session.fps,
      embeddedBackend: true,
      captureMode: 'dwm-thumbnail',
      sourceWindowEmbedded: !!(session.windowEmbedding && session.windowEmbedding.embedded),
      sourceWindowAligned: !!(session.windowEmbedding && session.windowEmbedding.aligned),
      sourceWindowRounded: !!(session.windowEmbedding && session.windowEmbedding.rounded),
      sourceWindowParked: !!(session.windowParking && session.windowParking.parked),
      sourceWindowVisibleWidth: Math.max(0, Number(session.windowEmbedding && session.windowEmbedding.visibleWidth) || 0),
      sourceWindowVisibleHeight: Math.max(0, Number(session.windowEmbedding && session.windowEmbedding.visibleHeight) || 0),
      sourceWindowRect: session.windowEmbedding ? {
        left: Number(session.windowEmbedding.left) || 0,
        top: Number(session.windowEmbedding.top) || 0,
        right: Number(session.windowEmbedding.right) || 0,
        bottom: Number(session.windowEmbedding.bottom) || 0,
      } : null,
      hostWindowRect: session.windowEmbedding ? {
        left: Number(session.windowEmbedding.hostLeft) || 0,
        top: Number(session.windowEmbedding.hostTop) || 0,
        right: Number(session.windowEmbedding.hostRight) || 0,
        bottom: Number(session.windowEmbedding.hostBottom) || 0,
      } : null,
      sourceWindowParkingRect: session.windowParking ? {
        left: Number(session.windowParking.left) || 0,
        top: Number(session.windowParking.top) || 0,
        right: Number(session.windowParking.right) || 0,
        bottom: Number(session.windowParking.bottom) || 0,
        visibleWidth: Math.max(0, Number(session.windowParking.visibleWidth) || 0),
        visibleHeight: Math.max(0, Number(session.windowParking.visibleHeight) || 0),
      } : null,
      dwmSurfaceActive: session.dwmSurfaceActive === true,
      dwmSurfaceReady: session.dwmSurfaceReady === true,
      dwmSurfaceHelperPid: Math.max(0, Number(session.dwmSurfaceHelperPid) || 0),
      dwmSurfaceWindowId: Math.max(0, Number(session.dwmSurfaceWindowId) || 0),
      dwmDesktopIconLayering: session.dwmDesktopIconLayering === true,
      dwmVisualOpacity: Math.max(0.15, Math.min(1, Number(session.dwmVisualOpacity) || 1)),
      dwmVisualPositionX: Math.max(-0.5, Math.min(0.5, Number(session.dwmVisualPositionX) || 0)),
      dwmVisualPositionY: Math.max(-0.5, Math.min(0.5, Number(session.dwmVisualPositionY) || 0)),
      dwmVisualScale: Math.max(1, Math.min(1.6, Number(session.dwmVisualScale) || 1)),
      dwmGlassSurfaceReady: session.dwmGlassSurfaceReady === true,
      dwmGlassSurfaceActive: session.dwmGlassSurfaceActive === true,
      dwmGlassSurfaceWindowId: Math.max(0, Number(session.dwmGlassSurfaceWindowId) || 0),
      // Compatibility fields: these now describe the DOM sampler and alias the
      // one base DWM HWND. They no longer represent a second native window.
      dwmGlassSurfaceSampleMode: 'single-dwm-svg-sampler',
      dwmGlassSurfaceGeometry: session.dwmGlassSurfaceGeometry ? { ...session.dwmGlassSurfaceGeometry } : null,
      parallaxPointerRelayActive: session.parallaxPointerRelayActive === true,
      parallaxPointerRelayReady: session.parallaxPointerRelayReady === true,
      parallaxPointerRelayHelperPid: Math.max(0, Number(session.parallaxPointerRelayHelperPid) || 0),
      parallaxPointerRelayTargetWindowId: Math.max(0, Number(session.parallaxPointerRelayTargetWindowId) || 0),
      parallaxPointerRelayTargetClass: String(session.parallaxPointerRelayTargetClass || ''),
      parallaxPointerRelayTargetTitle: String(session.parallaxPointerRelayTargetTitle || ''),
      parallaxPointerRelayQueued: Math.max(0, Number(session.parallaxPointerRelayQueued) || 0),
      parallaxPointerRelayCoalesced: Math.max(0, Number(session.parallaxPointerRelayCoalesced) || 0),
      parallaxPointerRelayPosted: Math.max(0, Number(session.parallaxPointerRelayPosted) || 0),
      parallaxPointerRelayLatestX: typeof session.parallaxPointerRelayLatestX === 'number'
        && Number.isFinite(session.parallaxPointerRelayLatestX)
        ? Math.max(0, Math.min(65535, Math.round(session.parallaxPointerRelayLatestX))) : null,
      parallaxPointerRelayLatestY: typeof session.parallaxPointerRelayLatestY === 'number'
        && Number.isFinite(session.parallaxPointerRelayLatestY)
        ? Math.max(0, Math.min(65535, Math.round(session.parallaxPointerRelayLatestY))) : null,
      audioMuted: session.audioMuted === true,
      audioPropertySuppressed: session.audioPropertySuppressed === true,
      audioMuteCommandCount: Math.max(0, Number(session.audioMuteCommandCount) || 0),
      silentStageApplied: Math.max(0, Number(session.stagedAudioPropertyCount) || 0) > 0,
      stagedAudioPropertyCount: Math.max(0, Number(session.stagedAudioPropertyCount) || 0),
      sceneAudioPatched: Math.max(0, Number(session.patchedSceneAudioObjectCount) || 0) > 0,
      patchedSceneAudioObjectCount: Math.max(0, Number(session.patchedSceneAudioObjectCount) || 0),
    };
  }

  getStatus() {
    const current = this.active;
    return current ? this._publicSession(current) : {
      ok: true,
      active: false,
      id: '',
      sessionId: '',
      sourceId: '',
    };
  }

  async _execFileText(file, args, options = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, stdout) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(String(stdout || ''));
      };
      try {
        this.execFile(file, args, options, done);
      } catch (error) {
        done(error);
      }
    });
  }

  // PowerShell 的 -EncodedCommand 会把整段脚本 base64(UTF-16LE) 塞进命令行，而 Windows 的
  // 命令行上限是 32767 字符。脚本一长，spawn 阶段就会直接以 ENAMETOOLONG 失败 —— 子进程根本
  // 没启动，上层只能看到一个笼统的失败码。本项目实测：nativeWindowControlScript 编码后
  // 约 3.85 万字符，于是 embed/close/park 每一次窗口控制都失败，壁纸永远退回封面图（"发虚、
  // 和真壁纸不符"）。DWM 帮手（编码后约 6.25 万）早就改成"写哈希脚本文件 + -File"了，窗口
  // 控制器和 broker 漏掉了，所以这里统一走同一条安全路径：内容哈希命名的 .ps1，写一次复用。
  // -EncodedCommand base64s the whole script into the command line, and Windows caps a command
  // line at 32767 characters. Past that, spawn fails with ENAMETOOLONG before the process even
  // starts, and the caller only sees a generic failure code. Measured here: the window control
  // script encodes to about 38.5k characters, so every embed/close/park call failed and the
  // wallpaper always fell back to its cover art. The DWM helper (~62.5k encoded) was migrated to
  // a hashed script file long ago; the window controller and the broker were missed. Route all
  // of them through the same safe path: a content-hashed .ps1 written once and reused.
  _powerShellHelperArgs(prefix, scriptSource) {
    const source = String(scriptSource || '');
    try {
      const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 20);
      const file = path.join(this.nativeTempPath, `wallpaper-engine-${prefix}-${digest}.ps1`);
      fs.mkdirSync(this.nativeTempPath, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, `\uFEFF${source}`, 'utf8');
      return ['-ExecutionPolicy', 'Bypass', '-File', file];
    } catch (error) {
      // 临时目录写不进去时退回内联编码：短脚本仍然可用，长脚本会照旧失败，但不要因为一次
      // 磁盘问题让整条控制链彻底不可用。原因记下来，别静默。
      // If the temp file cannot be written, fall back to inline encoding: shorter scripts still
      // work and longer ones fail as before, but one disk problem must not take the whole
      // control path down. Record why instead of failing silently.
      console.warn('[Wallpaper Engine] native helper file unavailable, using inline encoding:', error && error.message || error);
      return ['-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];
    }
  }

  _powerShellEnv(extra = {}) {
    fs.mkdirSync(this.nativeTempPath, { recursive: true });
    return {
      ...process.env,
      TEMP: this.nativeTempPath,
      TMP: this.nativeTempPath,
      MINERADIO_NATIVE_TEMP_DIR: this.nativeTempPath,
      ...extra,
    };
  }

  _stopSessionDwmSurface(session) {
    if (!session) return false;
    if (session.dwmSurfaceRetryTimer) clearTimeout(session.dwmSurfaceRetryTimer);
    session.dwmSurfaceRetryTimer = null;
    const child = session.dwmSurfaceProcess;
    const stdin = child && child.stdin;
    session.dwmSurfaceProcess = null;
    session.dwmSurfaceReady = false;
    session.dwmSurfaceActive = false;
    session.dwmSurfaceHelperPid = 0;
    session.dwmSurfaceWindowId = 0;
    session.dwmDesktopIconLayering = false;
    session.dwmDesktopIconLayeringAckToken = (Number(session.dwmDesktopIconLayeringAckToken) || 0) + 1;
    session.dwmGlassSurfaceReady = false;
    session.dwmGlassSurfaceActive = false;
    session.dwmGlassSurfaceWindowId = 0;
    session.dwmGlassSurfaceGeometry = null;
    session.dwmGlassSurfaceGeometryKey = '';
    if (!child) return false;
    let trackedStop = null;
    const pendingStop = new Promise((resolve) => {
      let settled = false;
      let killTimer = null;
      let settleTimer = null;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolve(exited === true);
      };
      if (child.exitCode != null || child.signalCode != null) {
        finish(true);
        return;
      }
      if (typeof child.once === 'function') child.once('exit', () => finish(true));
      try {
        if (stdin && stdin.destroyed !== true && stdin.writableEnded !== true) {
          stdin.write('Q\n', 'ascii');
          stdin.end();
        }
      } catch (_) { }
      killTimer = setTimeout(() => {
        if (settled || typeof child.kill !== 'function') return;
        try { child.kill(); } catch (_) { }
      }, DWM_SURFACE_STOP_TIMEOUT_MS);
      settleTimer = setTimeout(() => finish(false), DWM_SURFACE_STOP_TIMEOUT_MS + 500);
      if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
      if (settleTimer && typeof settleTimer.unref === 'function') settleTimer.unref();
    });
    trackedStop = pendingStop.finally(() => {
      if (session.dwmSurfaceStopPromise === trackedStop) session.dwmSurfaceStopPromise = null;
    });
    session.dwmSurfaceStopPromise = trackedStop;
    return true;
  }

  async _waitForSessionDwmSurfaceStop(session) {
    const pending = session && session.dwmSurfaceStopPromise;
    if (!pending || typeof pending.then !== 'function') return true;
    return pending;
  }

  _scheduleSessionDwmSurfaceRetry(session) {
    if (!session || this.platform !== 'win32' || this.disposed || this.active !== session
      || session.stopping === true || !session.windowEmbedding || session.windowEmbedding.aligned !== true
      || session.dwmSurfaceRetryTimer || session.dwmSurfaceReady === true) return false;
    session.dwmSurfaceRetryTimer = setTimeout(() => {
      session.dwmSurfaceRetryTimer = null;
      if (this.disposed || this.active !== session || session.stopping === true) return;
      this._startSessionDwmSurface(session).then((ready) => {
        if (!ready) this._scheduleSessionDwmSurfaceRetry(session);
      }).catch(() => this._scheduleSessionDwmSurfaceRetry(session));
    }, DWM_SURFACE_RETRY_DELAY_MS);
    if (session.dwmSurfaceRetryTimer && typeof session.dwmSurfaceRetryTimer.unref === 'function') {
      session.dwmSurfaceRetryTimer.unref();
    }
    return true;
  }

  async _startSessionDwmSurface(session) {
    if (!session || this.platform !== 'win32' || this.disposed || this.active !== session
      || session.stopping === true || !session.windowEmbedding || session.windowEmbedding.aligned !== true) return false;
    if (session.dwmSurfaceReady === true && session.dwmSurfaceProcess) {
      return true;
    }
    if (session.dwmSurfaceStartPromise) return session.dwmSurfaceStartPromise;

    const sourceId = String(session.windowSourceId || session.sourceId || '');
    const hostWindowId = String(session.dwmSurfaceHostWindowId || '');
    const hostExecutable = String(session.dwmSurfaceHostExecutable || '');
    if (!/^window:\d+:\d+$/.test(sourceId) || !/^\d+$/.test(hostWindowId)
      || !session.locationTitle || !session.executable || !hostExecutable) return false;

    const operation = (async () => {
      let child;
      try {
        const helperSource = nativeDwmThumbnailSurfaceScript();
        const helperDigest = crypto.createHash('sha256').update(helperSource).digest('hex').slice(0, 20);
        const helperFile = path.join(this.nativeTempPath, `wallpaper-engine-dwm-surface-${helperDigest}.ps1`);
        if (!fs.existsSync(helperFile)) {
          fs.writeFileSync(helperFile, `\uFEFF${helperSource}`, 'utf8');
        }
        child = this.dwmSurfaceSpawn(this.powerShellExecutable, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          helperFile,
        ], {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this._powerShellEnv({
            MINERADIO_WE_DWM_SOURCE_ID: sourceId,
            MINERADIO_WE_DWM_SOURCE_TITLE: session.locationTitle,
            MINERADIO_WE_DWM_SOURCE_EXECUTABLE: session.executable,
            MINERADIO_WE_DWM_HOST_WINDOW_ID: hostWindowId,
            MINERADIO_WE_DWM_HOST_EXECUTABLE: hostExecutable,
            MINERADIO_WE_DWM_HOST_CORNER_RADIUS: String(session.dwmSurfaceHostCornerRadius || 0),
            MINERADIO_WE_DWM_DESKTOP_ICON_LAYERING: session.dwmSurfaceDesktopIconLayering === true ? '1' : '0',
            MINERADIO_WE_DWM_VISUAL_OPACITY: String(Math.round(Math.max(0.15, Math.min(1, Number(session.dwmVisualOpacity) || 1)) * 255)),
            MINERADIO_WE_DWM_VISUAL_POSITION_X: String(Math.round(Math.max(-0.5, Math.min(0.5, Number(session.dwmVisualPositionX) || 0)) * 1000000)),
            MINERADIO_WE_DWM_VISUAL_POSITION_Y: String(Math.round(Math.max(-0.5, Math.min(0.5, Number(session.dwmVisualPositionY) || 0)) * 1000000)),
            // 帮手启动时只读一次本环境变量，初值必须是 1x：旧默认 1.08 会让 DWM 缩略图从
            // 第一帧起就比宿主矩形大 8%，等于对整张壁纸无条件重采样一次。
            // The helper reads this env var once at spawn, so it must start at 1x. The legacy
            // 1.08 default made the thumbnail 8% larger than the host rect from frame one,
            // i.e. an unconditional full-surface resample.
            MINERADIO_WE_DWM_VISUAL_SCALE: String(Math.round(Math.max(1, Math.min(1.6, Number(session.dwmVisualScale) || 1)) * 1000000)),
            MINERADIO_WE_DWM_SESSION_ID: session.sessionId,
          }),
        });
      } catch (_) {
        return false;
      }
      if (!child || !child.stdin || !child.stdout || typeof child.stdout.on !== 'function') {
        try { if (child && typeof child.kill === 'function') child.kill(); } catch (_) { }
        return false;
      }

      session.dwmSurfaceProcess = child;
      session.dwmSurfaceHelperPid = Math.max(0, Number(child.pid) || 0);
      session.dwmSurfaceReady = false;
      session.dwmSurfaceActive = false;
      session.dwmGlassSurfaceReady = false;
      session.dwmGlassSurfaceActive = false;
      session.dwmGlassSurfaceWindowId = 0;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const ready = await new Promise((resolve) => {
        let timeout = null;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve(value === true);
        };
        timeout = setTimeout(() => finish(false), this.dwmSurfaceStartTimeoutMs);
        if (child.stdout && typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8');
        if (child.stderr && typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout = `${stdout}${String(chunk || '')}`.slice(-8192);
          const lines = stdout.split(/\r?\n/);
          stdout = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!/^\{.*\}$/.test(trimmed)) continue;
            try {
              const result = JSON.parse(trimmed);
              if (result && result.ok === true && result.dwm === true
                && result.active === true && session.dwmSurfaceProcess === child
                && Number(result.surfaceWindowHandle) === Number(session.dwmSurfaceWindowId)) {
                session.dwmSurfaceActive = true;
              }
              if (result && result.ok === true && result.iconLayering === true
                && typeof result.enabled === 'boolean' && session.dwmSurfaceProcess === child) {
                session.dwmDesktopIconLayering = result.enabled === true;
                session.dwmDesktopIconLayeringAckToken = (Number(session.dwmDesktopIconLayeringAckToken) || 0) + 1;
              }
              if (result && result.ok === true && result.ready === true
                && String(result.hostWindowHandle || '') === hostWindowId
                && Number(result.sourceWindowHandle) > 0
                && Number(result.surfaceWindowHandle) > 0) {
                session.dwmSurfaceWindowId = Math.max(0, Number(result.surfaceWindowHandle) || 0);
                session.dwmGlassSurfaceWindowId = session.dwmSurfaceWindowId;
                session.dwmGlassSurfaceReady = session.dwmGlassSurfaceWindowId > 0;
                session.dwmDesktopIconLayering = result.desktopIconLayering === true;
                finish(true);
                return;
              }
            } catch (_) { }
          }
        });
        if (child.stderr && typeof child.stderr.on === 'function') {
          child.stderr.on('data', (chunk) => {
            if (stderr.length < 4096) stderr = `${stderr}${String(chunk || '')}`.slice(0, 4096);
          });
        }
        if (typeof child.once === 'function') {
          child.once('error', () => finish(false));
          child.once('exit', () => finish(false));
        }
      });

      if (!ready || this.active !== session || this.disposed || session.stopping === true
        || session.dwmSurfaceProcess !== child) {
        if (!ready && stderr.trim()) {
          console.warn(`[Wallpaper Engine] DWM surface unavailable: ${stderr.trim().replace(/\s+/g, ' ').slice(0, 400)}`);
        }
        if (session.dwmSurfaceProcess === child) this._stopSessionDwmSurface(session);
        return false;
      }

      session.dwmSurfaceReady = true;
      // 就绪即补发一次视觉设置：渲染进程的推送一般早于这一刻，不补发就会一直按启动
      // 初值渲染（旧默认 1.08 = 整张壁纸被多放大 8%）。
      // Flush on ready: the renderer's push normally lands before this point, and without
      // the flush the helper keeps rendering at its spawn-time default (the legacy 1.08).
      this._pushDwmVisualSettings(session);
      // The source window itself stays directly behind Electron until the
      // renderer has opened a cursor-free capture of this plain helper HWND.
      // Only then does activateDwmSurface() register the DWM thumbnail.
      session.dwmSurfaceActive = false;
      session.windowParking = null;
      if (typeof child.once === 'function') {
        child.once('exit', () => {
          if (session.dwmSurfaceProcess !== child) return;
          session.dwmSurfaceProcess = null;
          session.dwmSurfaceReady = false;
          session.dwmSurfaceActive = false;
          session.dwmSurfaceHelperPid = 0;
          session.dwmSurfaceWindowId = 0;
          session.dwmDesktopIconLayering = false;
          session.dwmDesktopIconLayeringAckToken = (Number(session.dwmDesktopIconLayeringAckToken) || 0) + 1;
          session.dwmGlassSurfaceReady = false;
          session.dwmGlassSurfaceActive = false;
          session.dwmGlassSurfaceWindowId = 0;
          session.dwmGlassSurfaceGeometry = null;
          session.dwmGlassSurfaceGeometryKey = '';
          this._scheduleSessionDwmSurfaceRetry(session);
        });
      }
      return true;
    })();
    session.dwmSurfaceStartPromise = operation;
    try {
      return await operation;
    } finally {
      if (session.dwmSurfaceStartPromise === operation) session.dwmSurfaceStartPromise = null;
    }
  }

  updateGlassSurface(expectedSessionId = '', geometry = {}) {
    if (expectedSessionId && typeof expectedSessionId === 'object') {
      geometry = expectedSessionId;
      expectedSessionId = geometry.sessionId || '';
    }
    const session = this.active;
    expectedSessionId = String(expectedSessionId || '');
    if (!session || (expectedSessionId && session.sessionId !== expectedSessionId)) {
      return { ok: false, error: 'WALLPAPER_ENGINE_SESSION_MISMATCH' };
    }
    if (!session.dwmSurfaceReady || !session.dwmGlassSurfaceReady
      || Number(session.dwmSurfaceWindowId) <= 0
      || Number(session.dwmGlassSurfaceWindowId) !== Number(session.dwmSurfaceWindowId)) {
      return { ok: false, error: 'WALLPAPER_ENGINE_DWM_GLASS_SURFACE_UNAVAILABLE' };
    }

    const viewportWidth = Number(geometry && geometry.viewportWidth);
    const viewportHeight = Number(geometry && geometry.viewportHeight);
    const left = Number(geometry && geometry.left);
    const top = Number(geometry && geometry.top);
    const width = Number(geometry && geometry.width);
    const height = Number(geometry && geometry.height);
    const radius = Number(geometry && geometry.radius);
    if (![viewportWidth, viewportHeight, left, top, width, height, radius].every(Number.isFinite)
      || viewportWidth < 2 || viewportHeight < 2 || width < 0 || height < 0) {
      return { ok: false, error: 'WALLPAPER_ENGINE_DWM_GLASS_GEOMETRY_INVALID' };
    }
    const normalized = (value, extent, min, max) => Math.max(min, Math.min(max,
      Math.round((value / extent) * 1000000)));
    const xUnit = normalized(left, viewportWidth, -2000000, 3000000);
    const yUnit = normalized(top, viewportHeight, -2000000, 3000000);
    const widthUnit = normalized(width, viewportWidth, 0, 3000000);
    const heightUnit = normalized(height, viewportHeight, 0, 3000000);
    const radiusUnit = normalized(radius, viewportWidth, 0, 1000000);
    const active = geometry.active === true && width >= 2 && height >= 2;
    const key = [xUnit, yUnit, widthUnit, heightUnit, radiusUnit, active ? 1 : 0].join('|');
    if (key === session.dwmGlassSurfaceGeometryKey) {
      return { ok: true, updated: false, ...this._publicSession(session) };
    }
    // Geometry is consumed only by the clipped renderer sampler. The native
    // helper intentionally receives no glass command and owns no second layer.
    session.dwmGlassSurfaceGeometryKey = key;
    session.dwmGlassSurfaceGeometry = {
      active,
      left,
      top,
      width,
      height,
      radius,
      viewportWidth,
      viewportHeight,
    };
    session.dwmGlassSurfaceActive = active;
    return { ok: true, updated: true, ...this._publicSession(session) };
  }

  async activateDwmSurface(expectedSessionId = '') {
    const session = this.active;
    expectedSessionId = String(expectedSessionId || '');
    if (!session || (expectedSessionId && session.sessionId !== expectedSessionId)) {
      throw runtimeError('WALLPAPER_ENGINE_SESSION_MISMATCH');
    }
    if (session.dwmSurfaceReady !== true || !session.dwmSurfaceProcess
      || !session.dwmSurfaceProcess.stdin) {
      throw runtimeError('WALLPAPER_ENGINE_DWM_SURFACE_FAILED');
    }
    if (session.dwmSurfaceActive === true) return this._publicSession(session);
    const child = session.dwmSurfaceProcess;
    const stdin = child.stdin;
    if (stdin.destroyed === true || stdin.writableEnded === true) {
      throw runtimeError('WALLPAPER_ENGINE_DWM_SURFACE_FAILED');
    }
    try { stdin.write('D\n', 'ascii'); }
    catch (_) { throw runtimeError('WALLPAPER_ENGINE_DWM_SURFACE_FAILED'); }
    const deadline = this.now() + 2200;
    while (this.now() <= deadline) {
      if (this.disposed || this.active !== session || session.stopping === true
        || session.dwmSurfaceProcess !== child) {
        throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      }
      if (session.dwmSurfaceActive === true) return this._publicSession(session);
      await this.sleep(20);
    }
    throw runtimeError('WALLPAPER_ENGINE_DWM_SURFACE_FAILED');
  }

  async updateDwmDesktopIconLayering(expectedSessionId = '', enabled = false) {
    const session = this.active;
    expectedSessionId = String(expectedSessionId || '');
    enabled = enabled === true;
    if (!session || (expectedSessionId && session.sessionId !== expectedSessionId)) return false;
    // Latch the latest desired order even while the helper is between retries.
    // _startSessionDwmSurface() replays this field into the next helper env.
    session.dwmSurfaceDesktopIconLayering = enabled;
    if (session.dwmSurfaceReady !== true || !session.dwmSurfaceProcess
      || !session.dwmSurfaceProcess.stdin) return false;
    if (session.dwmDesktopIconLayering === enabled) {
      // A helper ACK may arrive just after a caller's timeout rollback. Keep
      // the desired restart state aligned with the now-observed helper state.
      session.dwmSurfaceDesktopIconLayering = enabled;
      return true;
    }

    const child = session.dwmSurfaceProcess;
    const stdin = child.stdin;
    if (stdin.destroyed === true || stdin.writableEnded === true) return false;
    const ackToken = Number(session.dwmDesktopIconLayeringAckToken) || 0;
    try { stdin.write(`I|${enabled ? 1 : 0}\n`, 'ascii'); }
    catch (_) { return false; }

    const deadline = this.now() + 2200;
    while (this.now() <= deadline) {
      if (this.disposed || this.active !== session || session.stopping === true
        || session.dwmSurfaceProcess !== child) return false;
      if ((Number(session.dwmDesktopIconLayeringAckToken) || 0) > ackToken
        && session.dwmDesktopIconLayering === enabled) return true;
      await this.sleep(20);
    }
    if (this.active === session && session.dwmSurfaceProcess === child) {
      if (enabled === false) {
        // Leaving Explorer coexistence must never keep an unresponsive helper
        // below the desktop icon host. Retire that single DWM surface and let
        // the normal retry path recreate it with ordinary top-level ordering.
        session.dwmSurfaceDesktopIconLayering = false;
        this._stopSessionDwmSurface(session);
        this._scheduleSessionDwmSurfaceRetry(session);
      }
    }
    return false;
  }

  updateDwmVisualSettings(expectedSessionId = '', settings = {}) {
    const session = this.active;
    expectedSessionId = String(expectedSessionId || '');
    if (!session || (expectedSessionId && session.sessionId !== expectedSessionId)) return false;
    const opacity = Math.max(0.15, Math.min(1, Number(settings.opacity) || 1));
    const positionX = Math.max(-0.5, Math.min(0.5, Number(settings.positionX) || 0));
    const positionY = Math.max(-0.5, Math.min(0.5, Number(settings.positionY) || 0));
    const scale = Math.max(1, Math.min(1.6, Number(settings.scale) || 1));
    session.dwmVisualOpacity = opacity;
    session.dwmVisualPositionX = positionX;
    session.dwmVisualPositionY = positionY;
    session.dwmVisualScale = scale;
    return this._pushDwmVisualSettings(session);
  }

  // 以前帮手未就绪时这里直接丢包且不重试，缩放会永久停在启动环境变量的初值上；
  // 现在只把值记在会话里并置待发标记，由 _startSessionDwmSurface 的就绪分支补发一次。
  // This used to drop the write when the helper was not ready yet and never retry, so the
  // scale stayed at the spawn-time default forever. The values now stay on the session and
  // the ready path flushes them once.
  _pushDwmVisualSettings(session) {
    if (!session) return false;
    const child = session.dwmSurfaceProcess;
    const stdin = child && child.stdin;
    if (session.dwmSurfaceReady !== true || !stdin || stdin.destroyed === true || stdin.writableEnded === true) {
      session.dwmVisualSettingsPending = true;
      return false;
    }
    const opacity = Math.round(Math.max(0.15, Math.min(1, Number(session.dwmVisualOpacity) || 1)) * 255);
    const positionX = Math.round(Math.max(-0.5, Math.min(0.5, Number(session.dwmVisualPositionX) || 0)) * 1000000);
    const positionY = Math.round(Math.max(-0.5, Math.min(0.5, Number(session.dwmVisualPositionY) || 0)) * 1000000);
    const scale = Math.round(Math.max(1, Math.min(1.6, Number(session.dwmVisualScale) || 1)) * 1000000);
    try {
      stdin.write(`V|${opacity}|${positionX}|${positionY}|${scale}\n`, 'ascii');
      session.dwmVisualSettingsPending = false;
      return true;
    } catch (_) {
      session.dwmVisualSettingsPending = true;
      return false;
    }
  }

  async getDwmGlassCaptureSource(expectedSessionId = '', options = {}) {
    if (!this.desktopCapturer || typeof this.desktopCapturer.getSources !== 'function') {
      throw runtimeError('WALLPAPER_ENGINE_CAPTURE_UNAVAILABLE');
    }
    const session = this.active;
    expectedSessionId = String(expectedSessionId || '');
    if (!session || (expectedSessionId && session.sessionId !== expectedSessionId)) {
      throw runtimeError('WALLPAPER_ENGINE_SESSION_MISMATCH');
    }
    const expectedWindowId = String(Math.max(0, Number(session.dwmSurfaceWindowId) || 0));
    if (session.dwmSurfaceReady !== true || session.dwmGlassSurfaceReady !== true
      || session.dwmGlassSurfaceActive !== true || !/^\d+$/.test(expectedWindowId)
      || expectedWindowId === '0'
      || Number(session.dwmGlassSurfaceWindowId) !== Number(session.dwmSurfaceWindowId)) {
      throw runtimeError('WALLPAPER_ENGINE_DWM_GLASS_SURFACE_UNAVAILABLE');
    }
    if (options.allowDirectSourceId === true) {
      return {
        id: `window:${expectedWindowId}:0`,
        name: 'Mineradio WE DWM Surface',
        directWindowSource: true,
      };
    }
    const timeoutMs = Math.max(200, Math.min(5000, Number(options.timeoutMs) || 1800));
    const pollMs = Math.max(20, Math.min(250, Number(options.pollIntervalMs) || 60));
    const deadline = this.now() + timeoutMs;
    while (this.now() <= deadline) {
      if (this.disposed || this.active !== session || session.stopping === true
        || session.dwmGlassSurfaceReady !== true
        || String(Math.max(0, Number(session.dwmGlassSurfaceWindowId) || 0)) !== expectedWindowId) {
        throw runtimeError('WALLPAPER_ENGINE_REFRESH_SUPERSEDED');
      }
      let sources = [];
      try {
        sources = await this.desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
      } catch (_) { }
      if (!Array.isArray(sources)) sources = [];
      const matched = sources.find((source) => {
        const match = /^window:(\d+):\d+$/.exec(String(source && source.id || ''));
        return !!match && match[1] === expectedWindowId
          && String(source && source.name || '') === 'Mineradio WE DWM Surface';
      });
      if (matched) return matched;
      await this.sleep(pollMs);
    }
    throw runtimeError('WALLPAPER_ENGINE_DWM_GLASS_CAPTURE_SOURCE_TIMEOUT');
  }

  _sessionPointerRelayCanPost(session) {
    return !!(session
      && this.platform === 'win32'
      && !this.disposed
      && this.active === session
      && session.stopping !== true
      && session.windowParking
      && session.windowParking.parked === true
      && session.parallaxPointerRelayReady === true
      && session.parallaxPointerRelayActive === true
      && session.parallaxPointerRelayProcess
      && session.parallaxPointerRelayProcess.stdin
      && session.parallaxPointerRelayProcess.stdin.destroyed !== true);
  }

  _clearSessionPointerRelayTimer(session) {
    if (!session) return;
    if (session.parallaxPointerRelayTimer) clearTimeout(session.parallaxPointerRelayTimer);
    session.parallaxPointerRelayTimer = null;
    session.parallaxPointerRelayPending = false;
  }

  _clearSessionPointerRelayRetries(session, ready = false) {
    if (!session || !session.parallaxPointerRelayRetryTimers) return;
    for (const timer of session.parallaxPointerRelayRetryTimers) clearTimeout(timer);
    session.parallaxPointerRelayRetryTimers.clear();
    const resolve = session.parallaxPointerRelayRetryResolve;
    if (typeof resolve === 'function') {
      resolve(ready === true);
      return;
    }
    session.parallaxPointerRelayRetryResolve = null;
    session.parallaxPointerRelayRetryPromise = null;
  }

  _scheduleSessionPointerRelayRetries(session) {
    if (!session || this.platform !== 'win32' || this.disposed || this.active !== session
      || session.stopping === true || !session.windowParking || session.windowParking.parked !== true
      || !session.parallaxPointerRelayRetryTimers) return Promise.resolve(false);
    if (session.parallaxPointerRelayReady === true && session.parallaxPointerRelayProcess) {
      return Promise.resolve(true);
    }
    if (session.parallaxPointerRelayRetryPromise) return session.parallaxPointerRelayRetryPromise;

    let settle = null;
    const operation = new Promise((resolve) => { settle = resolve; });
    session.parallaxPointerRelayRetryPromise = operation;
    session.parallaxPointerRelayRetryResolve = (ready) => {
      if (session.parallaxPointerRelayRetryPromise !== operation) return;
      for (const timer of session.parallaxPointerRelayRetryTimers) clearTimeout(timer);
      session.parallaxPointerRelayRetryTimers.clear();
      session.parallaxPointerRelayRetryResolve = null;
      session.parallaxPointerRelayRetryPromise = null;
      settle(ready === true);
    };

    const scheduleAttempt = (index) => {
      const finish = session.parallaxPointerRelayRetryResolve;
      if (typeof finish !== 'function') return;
      if (this.disposed || this.active !== session || session.stopping === true
        || !session.windowParking || session.windowParking.parked !== true) {
        finish(false);
        return;
      }
      if (session.parallaxPointerRelayReady === true && session.parallaxPointerRelayProcess) {
        finish(true);
        return;
      }
      if (index >= this.pointerRelayRetryDelaysMs.length) {
        finish(false);
        return;
      }
      const delay = this.pointerRelayRetryDelaysMs[index];
      const timer = setTimeout(() => {
        session.parallaxPointerRelayRetryTimers.delete(timer);
        if (this.disposed || this.active !== session || session.stopping === true
          || !session.windowParking || session.windowParking.parked !== true) {
          const cancel = session.parallaxPointerRelayRetryResolve;
          if (typeof cancel === 'function') cancel(false);
          return;
        }
        this._startSessionPointerRelay(session).then((ready) => {
          const finishAttempt = session.parallaxPointerRelayRetryResolve;
          if (typeof finishAttempt !== 'function') return;
          if (ready) finishAttempt(true);
          else scheduleAttempt(index + 1);
        }).catch(() => scheduleAttempt(index + 1));
      }, delay);
      session.parallaxPointerRelayRetryTimers.add(timer);
    };
    scheduleAttempt(0);
    return operation;
  }

  _stopSessionPointerRelay(session, options = {}) {
    if (!session) return false;
    if (options.clearRetries !== false) this._clearSessionPointerRelayRetries(session);
    this._clearSessionPointerRelayTimer(session);
    const child = session.parallaxPointerRelayProcess;
    const stdin = child && child.stdin;
    if (stdin && session.parallaxPointerRelayDrainListener
      && typeof stdin.removeListener === 'function') {
      stdin.removeListener('drain', session.parallaxPointerRelayDrainListener);
    }
    session.parallaxPointerRelayDrainListener = null;
    session.parallaxPointerRelayBackpressured = false;
    session.parallaxPointerRelayReady = false;
    session.parallaxPointerRelayActive = false;
    session.parallaxPointerRelayProcess = null;
    session.parallaxPointerRelayHelperPid = 0;
    session.parallaxPointerRelayTargetWindowId = 0;
    session.parallaxPointerRelayTargetClass = '';
    session.parallaxPointerRelayTargetTitle = '';
    session.parallaxPointerRelayLastPostedAt = 0;
    session.parallaxPointerRelayLatestX = null;
    session.parallaxPointerRelayLatestY = null;
    if (!child) return false;

    try {
      if (stdin && stdin.destroyed !== true && stdin.writableEnded !== true) {
        stdin.write('Q\n', 'ascii');
        stdin.end();
      }
    } catch (_) { }
    let exited = false;
    const markExited = () => { exited = true; };
    if (typeof child.once === 'function') child.once('exit', markExited);
    const killTimer = setTimeout(() => {
      if (exited || typeof child.kill !== 'function') return;
      try { child.kill(); } catch (_) { }
    }, POINTER_RELAY_STOP_TIMEOUT_MS);
    if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
    if (typeof child.once === 'function') child.once('exit', () => clearTimeout(killTimer));
    return true;
  }

  async _startSessionPointerRelay(session) {
    if (!session || this.platform !== 'win32' || this.disposed || this.active !== session
      || session.stopping === true || !session.windowParking || session.windowParking.parked !== true) return false;
    if (session.parallaxPointerRelayReady === true && session.parallaxPointerRelayProcess) {
      session.parallaxPointerRelayActive = true;
      this._clearSessionPointerRelayRetries(session, true);
      return true;
    }
    if (session.parallaxPointerRelayStartPromise) return session.parallaxPointerRelayStartPromise;

    const sourceId = String(session.windowSourceId || session.sourceId || '');
    const hostWindowId = String(session.parallaxPointerHostWindowId || '');
    const hostExecutable = String(session.parallaxPointerHostExecutable || '');
    if (!/^window:\d+:\d+$/.test(sourceId) || !/^\d+$/.test(hostWindowId)
      || !session.locationTitle || !session.executable || !hostExecutable) return false;

    const operation = (async () => {
      let child;
      try {
        child = this.pointerRelaySpawn(this.powerShellExecutable, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          nativeParallaxPointerRelayScript(),
        ], {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this._powerShellEnv({
            MINERADIO_WE_POINTER_SOURCE_ID: sourceId,
            MINERADIO_WE_POINTER_SOURCE_TITLE: session.locationTitle,
            MINERADIO_WE_POINTER_SOURCE_EXECUTABLE: session.executable,
            MINERADIO_WE_POINTER_HOST_WINDOW_ID: hostWindowId,
            MINERADIO_WE_POINTER_HOST_EXECUTABLE: hostExecutable,
            MINERADIO_WE_POINTER_SESSION_ID: session.sessionId,
          }),
        });
      } catch (_) {
        return false;
      }
      if (!child || !child.stdin || !child.stdout || typeof child.stdout.on !== 'function') {
        try { if (child && typeof child.kill === 'function') child.kill(); } catch (_) { }
        return false;
      }

      session.parallaxPointerRelayProcess = child;
      session.parallaxPointerRelayHelperPid = Math.max(0, Number(child.pid) || 0);
      session.parallaxPointerRelayReady = false;
      session.parallaxPointerRelayActive = false;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const ready = await new Promise((resolve) => {
        let timeout = null;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          resolve(value === true);
        };
        timeout = setTimeout(() => finish(false), this.pointerRelayStartTimeoutMs);
        if (child.stdout && typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8');
        if (child.stderr && typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          if (settled) return;
          stdout = `${stdout}${String(chunk || '')}`.slice(-8192);
          const lines = stdout.split(/\r?\n/);
          stdout = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!/^\{.*\}$/.test(trimmed)) continue;
            try {
              const result = JSON.parse(trimmed);
              if (result && result.ok === true && result.ready === true
                && Number(result.sourceProcessId) > 0 && Number(result.hostProcessId) > 0
                && Number(result.sceneInputWindowHandle) > 0) {
                session.parallaxPointerRelayTargetWindowId = Math.max(0,
                  Number(result.sceneInputWindowHandle) || 0);
                session.parallaxPointerRelayTargetClass = 'WPEDesktopDX11Window';
                session.parallaxPointerRelayTargetTitle = 'WPELiveWallpaper';
                finish(true);
                return;
              }
            } catch (_) { }
          }
        });
        if (child.stderr && typeof child.stderr.on === 'function') {
          child.stderr.on('data', (chunk) => {
            if (stderr.length < 2048) stderr = `${stderr}${String(chunk || '')}`.slice(0, 2048);
          });
        }
        if (typeof child.once === 'function') {
          child.once('error', () => finish(false));
          child.once('exit', () => finish(false));
        }
      });

      if (!ready || this.active !== session || this.disposed || session.stopping === true
        || !session.windowParking || session.windowParking.parked !== true
        || session.parallaxPointerRelayProcess !== child) {
        if (!ready && stderr.trim()) {
          console.warn(`[Wallpaper Engine] native parallax pointer relay unavailable: ${stderr.trim().replace(/\s+/g, ' ').slice(0, 300)}`);
        }
        if (session.parallaxPointerRelayProcess === child) {
          this._stopSessionPointerRelay(session, { clearRetries: false });
        }
        return false;
      }

      session.parallaxPointerRelayReady = true;
      session.parallaxPointerRelayActive = true;
      this._clearSessionPointerRelayRetries(session, true);
      if (typeof child.once === 'function') {
        child.once('exit', () => {
          if (session.parallaxPointerRelayProcess !== child) return;
          this._clearSessionPointerRelayTimer(session);
          session.parallaxPointerRelayProcess = null;
          session.parallaxPointerRelayHelperPid = 0;
          session.parallaxPointerRelayReady = false;
          session.parallaxPointerRelayActive = false;
          session.parallaxPointerRelayBackpressured = false;
          session.parallaxPointerRelayDrainListener = null;
          this._scheduleSessionPointerRelayRetries(session).catch(() => false);
        });
      }
      return true;
    })();
    session.parallaxPointerRelayStartPromise = operation;
    try {
      return await operation;
    } finally {
      if (session.parallaxPointerRelayStartPromise === operation) {
        session.parallaxPointerRelayStartPromise = null;
      }
    }
  }

  _scheduleSessionPointerRelayFlush(session) {
    if (!this._sessionPointerRelayCanPost(session)
      || session.parallaxPointerRelayBackpressured === true
      || session.parallaxPointerRelayTimer) return false;
    const targetFps = Math.max(MIN_FPS, Math.min(POINTER_RELAY_MAX_FPS, Number(session.fps) || DEFAULT_FPS));
    const interval = 1000 / targetFps;
    const now = Number(this.now()) || Date.now();
    const delay = Math.max(0, Number(session.parallaxPointerRelayLastPostedAt) + interval - now);
    if (delay <= 0) return this._flushSessionPointerRelay(session);
    session.parallaxPointerRelayTimer = setTimeout(() => {
      session.parallaxPointerRelayTimer = null;
      this._flushSessionPointerRelay(session);
    }, Math.max(1, Math.ceil(delay)));
    if (session.parallaxPointerRelayTimer && typeof session.parallaxPointerRelayTimer.unref === 'function') {
      session.parallaxPointerRelayTimer.unref();
    }
    return true;
  }

  _flushSessionPointerRelay(session) {
    if (!this._sessionPointerRelayCanPost(session) || session.parallaxPointerRelayPending !== true) {
      if (session) session.parallaxPointerRelayPending = false;
      return false;
    }
    const child = session.parallaxPointerRelayProcess;
    const stdin = child && child.stdin;
    session.parallaxPointerRelayPending = false;
    try {
      const xUnit = Math.max(0, Math.min(65535, Math.round(Number(session.parallaxPointerRelayLatestX))));
      const yUnit = Math.max(0, Math.min(65535, Math.round(Number(session.parallaxPointerRelayLatestY))));
      const writable = stdin.write(`M:${xUnit}:${yUnit}\n`, 'ascii');
      session.parallaxPointerRelayPosted += 1;
      session.parallaxPointerRelayLastPostedAt = Number(this.now()) || Date.now();
      if (writable === false) {
        session.parallaxPointerRelayBackpressured = true;
        const drain = () => {
          if (session.parallaxPointerRelayDrainListener !== drain) return;
          session.parallaxPointerRelayDrainListener = null;
          session.parallaxPointerRelayBackpressured = false;
          if (session.parallaxPointerRelayPending) this._scheduleSessionPointerRelayFlush(session);
        };
        session.parallaxPointerRelayDrainListener = drain;
        if (typeof stdin.once === 'function') stdin.once('drain', drain);
      }
      return true;
    } catch (_) {
      this._stopSessionPointerRelay(session);
      return false;
    }
  }

  noteHostPointerActivity(expectedSessionId = '', coordinates = null) {
    if (expectedSessionId && typeof expectedSessionId === 'object') {
      coordinates = expectedSessionId;
      expectedSessionId = coordinates.sessionId || '';
    }
    const session = this.active;
    expectedSessionId = String(expectedSessionId || '');
    coordinates = coordinates && typeof coordinates === 'object' ? coordinates : null;
    const rawXUnit = coordinates && coordinates.xUnit;
    const rawYUnit = coordinates && coordinates.yUnit;
    const xUnit = Math.round(rawXUnit);
    const yUnit = Math.round(rawYUnit);
    if (!this._sessionPointerRelayCanPost(session)
      || !expectedSessionId
      || session.sessionId !== expectedSessionId
      || typeof rawXUnit !== 'number' || typeof rawYUnit !== 'number'
      || !Number.isFinite(xUnit) || !Number.isFinite(yUnit)
      || xUnit < 0 || xUnit > 65535 || yUnit < 0 || yUnit > 65535) return false;
    session.parallaxPointerRelayLatestX = xUnit;
    session.parallaxPointerRelayLatestY = yUnit;
    session.parallaxPointerRelayQueued += 1;
    if (session.parallaxPointerRelayPending === true
      || session.parallaxPointerRelayTimer
      || session.parallaxPointerRelayBackpressured === true) {
      session.parallaxPointerRelayCoalesced += 1;
    }
    session.parallaxPointerRelayPending = true;
    this._scheduleSessionPointerRelayFlush(session);
    return true;
  }

  async _nativeWindowControl(action, details = {}) {
    const sourceId = String(details.sourceId || '');
    if (!/^window:\d+:\d+$/.test(sourceId)) throw runtimeError('WALLPAPER_ENGINE_WINDOW_SOURCE_INVALID');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (error) {
          const detail = String(stderr || error.message || error || '').trim().slice(0, 500);
          if (detail) console.warn(`[Wallpaper Engine] source window ${action} failed: ${detail}`);
          // 原生脚本抛出的异常文本（标题不匹配 / 进程校验失败 / 窗口已消失…）以前只落在
          // 控制台里，抛给上层的错误对象是空的，事后完全无法判断失败在哪一步。带上它。
          // The native exception text used to exist only in the console; the thrown error
          // carried nothing, which made the failing step untraceable. Attach it.
          const failure = runtimeError(action === 'close'
            ? 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED'
            : 'WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED');
          failure.nativeStage = 'exec';
          failure.nativeDetail = detail;
          reject(failure);
          return;
        }
        try {
          const jsonLine = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).reverse().find((line) => /^\{.*\}$/.test(line));
          const result = jsonLine ? JSON.parse(jsonLine) : null;
          if (!result || result.ok !== true) throw new Error('invalid native window result');
          resolve(result);
        } catch (parseError) {
          // 原生脚本没回可解析的 JSON：把原始输出尾部带上，脚本内报错和脚本被 15 秒超时
          // 杀掉这两种情况才能区分开。
          // No parseable JSON came back. Keep a tail of the raw output so a script error stays
          // distinguishable from the execFile 15s timeout kill.
          const stdoutTail = String(stdout || '').split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(-4)
            .join(' | ')
            .slice(0, 400);
          const failure = runtimeError(action === 'close'
            ? 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED'
            : 'WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED');
          failure.nativeStage = 'parse';
          failure.nativeDetail = stdoutTail || String(parseError && parseError.message || 'no JSON output').slice(0, 400);
          reject(failure);
        }
      };
      try {
        this.nativeExecFile(this.powerShellExecutable, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          ...this._powerShellHelperArgs('window-control', nativeWindowControlScript()),
        ], {
          encoding: 'utf8',
          windowsHide: true,
          // 这个预算要覆盖：PowerShell 冷启动 + Add-Type 编译这段 C#（首次调用没有缓存），
          // 再加上原生侧最多 6 秒的关窗轮询。以前关窗只等 1.8 秒，15 秒够用；放宽到 6 秒后
          // 余量被吃掉大半，慢机器上有可能在轮询还没结束时就被这里杀掉——那等于把"没等够"
          // 换了个地方重新失败。留足余量，并保持与原生关窗上限的联动。
          // This budget covers a cold PowerShell start, the Add-Type compile of this C# source
          // (uncached on first call) and the native close poll of up to 6s. The old 1.8s poll
          // left plenty of room at 15s; widening it to 6s would let a slow machine get killed
          // mid-poll, which reproduces the very "did not wait long enough" failure elsewhere.
          timeout: 20000,
          maxBuffer: 128 * 1024,
          shell: false,
          env: this._powerShellEnv({
            MINERADIO_WE_WINDOW_ACTION: String(action || ''),
            MINERADIO_WE_WINDOW_SOURCE_ID: sourceId,
            MINERADIO_WE_WINDOW_TITLE: String(details.locationTitle || ''),
            MINERADIO_WE_WINDOW_EXECUTABLE: String(details.executable || ''),
            MINERADIO_WE_HOST_WINDOW_ID: String(details.hostWindowId || ''),
            MINERADIO_WE_HOST_EXECUTABLE: String(details.hostExecutable || ''),
            MINERADIO_WE_HOST_CORNER_RADIUS: String(Math.max(0, Math.min(512, Number(details.cornerRadius) || 0))),
          }),
        }, finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  async _controlSessionWindow(action, session, sourceId = '', host = {}) {
    if (!session || !session.executable || !session.locationTitle) {
      throw runtimeError('WALLPAPER_ENGINE_WINDOW_SESSION_INVALID');
    }
    const effectiveSourceId = String(sourceId || session.windowSourceId || session.sourceId || '');
    const result = await this.windowController(action, {
      sourceId: effectiveSourceId,
      locationTitle: session.locationTitle,
      executable: session.executable,
      hostWindowId: String(host.hostWindowId || ''),
      hostExecutable: String(host.hostExecutable || ''),
      cornerRadius: Math.max(0, Math.min(512, Number(host.cornerRadius) || 0)),
    });
    if (!result || result.ok !== true) {
      // 控制器直接回了 ok:false 时，它自己的报错信息以前被丢掉，只留下一个错误码。
      // When the controller itself answers ok:false its own detail used to be dropped.
      const failure = runtimeError(action === 'close'
        ? 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED'
        : 'WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED');
      failure.nativeStage = 'result';
      failure.nativeDetail = String(result && (result.error || result.message) || '').slice(0, 500);
      throw failure;
    }
    if (action === 'embed') {
      if (result.missing === true || result.embedded !== true) {
        throw runtimeError('WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED');
      }
      session.windowSourceId = effectiveSourceId;
      session.windowEmbedding = result;
      session.windowParking = null;
    } else if (action === 'park') {
      if (result.missing === true || result.parked !== true) {
        throw runtimeError('WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED');
      }
      session.windowSourceId = effectiveSourceId;
      session.windowParking = result;
    }
    return result;
  }

  // 把 WE 播放窗口从任务栏和 Alt+Tab 里摘掉。它只是体验增强，失败时记录但不抛出，
  // 避免静默化自身的问题拖垮壁纸加载。
  // Window shell isolation is a comfort feature: failures are logged, never thrown.
  async _isolateSessionWindow(session, sourceId = '') {
    if (!session || session.silentWindows === false) return false;
    const effectiveSourceId = String(sourceId || session.windowSourceId || session.sourceId || '');
    if (!/^window:\d+:\d+$/.test(effectiveSourceId)) return false;
    try {
      const result = await this._controlSessionWindow('isolate', session, effectiveSourceId);
      session.windowShellIsolation = result;
      return !!(result && result.taskbarIsolated === true);
    } catch (error) {
      console.warn('[Wallpaper Engine] source window shell isolation skipped:', error && (error.code || error.message) || error);
      return false;
    }
  }

  // WE 主程序窗口同样是任务栏干扰源，而且它出现得比进程晚、之后还会陆续弹出对话框、更新
  // 提示之类的新窗口。固定三次延迟只能覆盖启动后 2.2 秒，之后弹出的窗口会永久留在任务栏
  // 上——这正是"有时候任务栏会有展示"的来源。改成一个常驻监视器：PowerShell 内部每 1.5 秒
  // 枚举一次，直到本次拉起的 WE 进程退出为止。
  // 只处理本次由本进程拉起的 PID，用户自己开着的 WE 保持原样。
  // The engine's own windows appear after the process does and keep popping up (dialogs, update
  // prompts). Three fixed delays only cover 2.2s, so anything later stays on the taskbar forever
  // — that is where "sometimes it shows up" came from. A resident monitor enumerates every 1.5s
  // until the instance this process started exits. Only those PIDs are touched, so a user-owned
  // engine keeps its taskbar presence.
  _startEngineWindowIsolationMonitor(processNames) {
    this._stopEngineWindowIsolationMonitor();
    const targets = (Array.isArray(processNames) ? processNames : [])
      .map((name) => String(name || '').trim())
      .filter((name) => /^[A-Za-z0-9_. -]+$/.test(name));
    if (!targets.length || this.disposed) return 0;
    let child = null;
    try {
      child = this.spawn(this.powerShellExecutable, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        ...this._powerShellHelperArgs('window-monitor', nativeProcessWindowIsolationScript()),
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: this._powerShellEnv({
          MINERADIO_WE_ISOLATE_PROCESSES: targets.join(','),
        }),
      });
    } catch (error) {
      // 监视器只是体验增强：起不来就退回"启动时静默一次"，不能让整条壁纸加载链断掉。
      // The monitor is a comfort feature: if it cannot start, fall back to a single immediate
      // pass instead of taking the whole wallpaper startup down with it.
      console.warn('[Wallpaper Engine] engine window monitor unavailable, isolating once:',
        error && (error.code || error.message) || error);
      this._isolateEngineWindowsOnce(targets);
      return 0;
    }
    const monitor = { child, pids: targets, isolated: 0, passes: 0, stopped: false };
    this.engineWindowMonitor = monitor;
    // stdout 每轮一行 "isolated=N"；它不是关键结果，但出问题时能看出监视器是否真的在跑。
    // The monitor prints one "isolated=N" line per pass. Not critical, but it shows whether the
    // loop is alive when something goes wrong.
    try {
      if (child && child.stdout && typeof child.stdout.setEncoding === 'function') {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          for (const line of String(chunk || '').split(/\r?\n/)) {
            const match = /^isolated=(\d+)/.exec(line.trim());
            if (!match) continue;
            monitor.passes += 1;
            monitor.isolated += Number(match[1]) || 0;
          }
        });
      }
      if (child && typeof child.on === 'function') {
        child.on('error', (error) => {
          if (monitor.stopped) return;
          console.warn('[Wallpaper Engine] engine window monitor failed:',
            error && (error.code || error.message) || error);
        });
        child.on('exit', () => {
          if (this.engineWindowMonitor === monitor) this.engineWindowMonitor = null;
        });
      }
      if (child && typeof child.unref === 'function') child.unref();
    } catch (error) {
      // 只是观测接线，坏了也不该影响静默本身。
      // Observation wiring only; a failure here must not affect the isolation itself.
      console.warn('[Wallpaper Engine] engine window monitor diagnostics unavailable:',
        error && (error.code || error.message) || error);
    }
    return targets.length;
  }

  _stopEngineWindowIsolationMonitor() {
    const monitor = this.engineWindowMonitor;
    this.engineWindowMonitor = null;
    if (!monitor || !monitor.child) return false;
    monitor.stopped = true;
    try {
      if (typeof monitor.child.kill === 'function') monitor.child.kill();
    } catch (error) {
      console.warn('[Wallpaper Engine] engine window monitor stop failed:',
        error && (error.code || error.message) || error);
    }
    return true;
  }

  // 监视器起不来时的兜底：立刻跑一轮。同一份脚本，靠 MINERADIO_WE_ISOLATE_ONCE 走单次分支。
  // Fallback when the monitor cannot start: one immediate pass. Same script, single-shot branch.
  _isolateEngineWindowsOnce(processNames) {
    const targets = (Array.isArray(processNames) ? processNames : [])
      .map((name) => String(name || '').trim())
      .filter((name) => /^[A-Za-z0-9_. -]+$/.test(name));
    if (!targets.length) return 0;
    try {
      this.nativeExecFile(this.powerShellExecutable, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        ...this._powerShellHelperArgs('window-monitor-once', nativeProcessWindowIsolationScript()),
      ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 32 * 1024,
        shell: false,
        env: this._powerShellEnv({
          MINERADIO_WE_ISOLATE_PROCESSES: targets.join(','),
          MINERADIO_WE_ISOLATE_ONCE: '1',
        }),
      }, (error) => {
        if (error) {
          console.warn('[Wallpaper Engine] engine window shell isolation skipped:',
            String(error.message || error).slice(0, 300));
        }
      });
    } catch (error) {
      console.warn('[Wallpaper Engine] engine window shell isolation skipped:',
        String(error && (error.code || error.message) || error).slice(0, 300));
    }
    return targets.length;
  }

  async _runTransientControl(executable, args) {
    if (this.useDesktopShellBroker && await this._hostIsElevated()) {
      return this._spawnControlViaDesktopShell(executable, args, { waitForExit: true });
    }
    return new Promise((resolve, reject) => {
      try {
        const verbatimArgs = verbatimWallpaperControlArguments(args);
        const controlExecutable = verbatimArgs ? path.basename(executable) : executable;
        const controlArgs = verbatimArgs || args;
        this.controlExecFile(controlExecutable, controlArgs, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3500,
          maxBuffer: 32 * 1024,
          shell: false,
          windowsVerbatimArguments: !!verbatimArgs,
          ...(verbatimArgs ? { cwd: path.dirname(executable) } : {}),
        }, (error, _stdout, stderr) => {
          if (error) {
            const action = String(args && args[1] || 'control').replace(/[^a-z0-9_-]/gi, '').slice(0, 48) || 'control';
            const detail = String(stderr || error.message || error || '').trim().replace(/\s+/g, ' ').slice(0, 500);
            console.warn(`[Wallpaper Engine] ${action} command failed${detail ? `: ${detail}` : ''}`);
            reject(runtimeError('WALLPAPER_ENGINE_CONTROL_FAILED'));
          }
          else resolve();
        });
      } catch (_) {
        reject(runtimeError('WALLPAPER_ENGINE_CONTROL_FAILED'));
      }
    });
  }

  // 静音走哪条路，决定了 Wallpaper Engine 会不会弹"未知来源"警告。
  //
  // Which route silence takes decides whether the engine shows its "unknown source" warning.
  //
  // 改包（改 project.general.properties，再把 Scene 包里的音频对象打补丁写进临时目录）能让 WE
  // 在**加载那一刻**就是静音的，但它拿到的是一个改过的、位于临时目录的文件，认不出来源，于是
  // 每开一次壁纸就弹一次"this wallpaper is not from a known, verified... origins"确认框，等人点 OK。
  //
  // Patching the package (rewriting project.general.properties and the audio objects inside a copy
  // of the Scene package, written into a temp directory) makes the wallpaper silent from the instant
  // it loads — but the engine then receives a modified file in a temp folder it cannot vouch for, so
  // every single wallpaper start raises a "not from a known, verified origin" confirmation the user
  // has to dismiss.
  //
  // 现在改用 WE 自己的静音接口（-control applyProperties 设音量，_muteSession 在 openWallpaper 之后
  // 立刻调用，并持续 reassert）。代价是**壁纸开始播放到第一次 applyProperties 生效之间可能漏出一点
  // 声音**；换来的是启动过程干净、再没有那个拦路的确认框。
  //
  // Silence now goes through the engine's own interface (-control applyProperties; _muteSession runs
  // right after openWallpaper and keeps reasserting). The price is that a sliver of audio can leak
  // between playback starting and the first applyProperties landing; in exchange the startup is
  // clean and that blocking confirmation is gone.
  async _prepareSilentLaunchFile(session, projectFile, scenePackage) {
    if (!session || !projectFile || !scenePackage) return projectFile || scenePackage;
    if (ENGINE_MUTE_VIA_INTERFACE) return projectFile;
    let project;
    try {
      const stat = await fs.promises.stat(projectFile);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) {
        throw runtimeError('WALLPAPER_ENGINE_SILENT_STAGE_FAILED');
      }
      const raw = await fs.promises.readFile(projectFile, 'utf8');
      project = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error && error.code === 'WALLPAPER_ENGINE_SILENT_STAGE_FAILED') throw error;
      throw runtimeError('WALLPAPER_ENGINE_SILENT_STAGE_FAILED');
    }
    if (!project || typeof project !== 'object' || Array.isArray(project)
      || String(project.type || '').trim().toLowerCase() !== 'scene') {
      throw runtimeError('WALLPAPER_ENGINE_SILENT_STAGE_FAILED');
    }
    const properties = project.general && project.general.properties;
    const muteProperties = sanitizeMuteProperties(session.muteProperties);
    let stagedPropertyCount = 0;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, value] of Object.entries(muteProperties)) {
        if (key.toLowerCase() === 'volume' || !Object.prototype.hasOwnProperty.call(properties, key)) continue;
        const property = properties[key];
        if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
        property.value = value;
        stagedPropertyCount += 1;
      }
    }

    let stagedScenePackage = scenePackage;
    try {
      stagedScenePackage = await this._prepareMutedScenePackage(session, scenePackage);
    } catch (error) {
      console.warn('[Wallpaper Engine] cached Scene audio patch unavailable, using property-only suppression:', error && (error.code || error.message) || error);
      session.patchedSceneAudioObjectCount = 0;
      session.mutedScenePackageCacheFile = '';
    }
    if (!stagedPropertyCount && stagedScenePackage === scenePackage) return projectFile;

    const nativeVolume = path.parse(path.resolve(this.nativeTempPath)).root.toLowerCase();
    const packageVolume = path.parse(path.resolve(scenePackage)).root.toLowerCase();
    const preferredStageRoot = nativeVolume === packageVolume
      ? path.resolve(this.nativeTempPath, 'wallpaper-engine-scene-stage')
      : path.resolve(path.parse(scenePackage).root, 'MineradioCache', 'wallpaper-engine-scene-stage');
    let stageRoot = preferredStageRoot;
    try {
      await fs.promises.mkdir(stageRoot, { recursive: true });
    } catch (_) {
      stageRoot = path.resolve(path.dirname(scenePackage), '.mineradio-scene-stage');
      await fs.promises.mkdir(stageRoot, { recursive: true });
    }
    const stageDirectory = path.resolve(stageRoot, session.sessionId);
    const relative = path.relative(stageRoot, stageDirectory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw runtimeError('WALLPAPER_ENGINE_SILENT_STAGE_FAILED');
    }
    await fs.promises.rm(stageDirectory, { recursive: true, force: true });
    await fs.promises.mkdir(stageDirectory, { recursive: true });
    const manifestFile = String(project.file || '').replace(/\\/g, '/');
    const manifestPackageName = /(?:^|\/)([^/]+\.(?:pkg|pak))$/i.exec(manifestFile);
    const stagedPackageName = manifestPackageName && /^[a-z0-9_. -]{1,180}\.(?:pkg|pak)$/i.test(manifestPackageName[1])
      ? manifestPackageName[1]
      : 'scene.pkg';
    if (manifestPackageName) project.file = stagedPackageName;
    const stagedPackageFile = path.join(stageDirectory, stagedPackageName);
    const stagedProjectFile = path.join(stageDirectory, 'project.json');
    const temporaryFile = stagedProjectFile + '.tmp';
    try {
      try {
        await fs.promises.link(stagedScenePackage, stagedPackageFile);
      } catch (_) {
        await fs.promises.copyFile(stagedScenePackage, stagedPackageFile);
      }
      await fs.promises.writeFile(temporaryFile, JSON.stringify(project), 'utf8');
      await fs.promises.rename(temporaryFile, stagedProjectFile);
    } catch (error) {
      try { await fs.promises.rm(stageDirectory, { recursive: true, force: true }); } catch (_) { }
      console.warn('[Wallpaper Engine] silent Scene staging unavailable, using original project:', error && error.message || error);
      session.stagedAudioPropertyCount = 0;
      session.patchedSceneAudioObjectCount = 0;
      session.mutedScenePackageCacheFile = '';
      return projectFile;
    }
    session.stagedProjectRoot = stageDirectory;
    session.stagedProjectBaseRoot = stageRoot;
    session.stagedProjectFile = stagedProjectFile;
    session.stagedAudioPropertyCount = stagedPropertyCount;
    return stagedProjectFile;
  }

  async _prepareMutedScenePackage(session, scenePackage) {
    const source = await readWallpaperPackageScene(scenePackage);
    const patchedScene = JSON.parse(JSON.stringify(source.scene));
    const audioObjectCount = forceSceneAudioSilent(patchedScene);
    if (!audioObjectCount) return scenePackage;
    const patchedBuffer = encodePatchedScene(patchedScene, source.sceneLength);
    const cacheRoot = path.resolve(this.nativeTempPath, 'wallpaper-engine-muted-package-cache');
    await fs.promises.mkdir(cacheRoot, { recursive: true });
    const sourceIdentity = crypto.createHash('sha256')
      .update(String(MUTED_SCENE_PACKAGE_CACHE_VERSION))
      .update('\0')
      .update(path.resolve(scenePackage).toLowerCase())
      .update('\0')
      .update(String(source.packageSize))
      .update('\0')
      .update(String(Math.round(source.packageMtimeMs)))
      .digest('hex');
    const cachedFile = path.join(cacheRoot, `${sourceIdentity}.pkg`);
    const cachedStat = await statFile(cachedFile);
    const cachedPackageIsValid = !!cachedStat
      && cachedStat.size === source.packageSize
      && await validateMutedScenePackage(cachedFile, source.packageSize, audioObjectCount);
    if (!cachedPackageIsValid) {
      if (cachedStat) await fs.promises.rm(cachedFile, { force: true });
      const temporaryFile = path.join(cacheRoot, `${sourceIdentity}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      try {
        await fs.promises.copyFile(scenePackage, temporaryFile);
        const handle = await fs.promises.open(temporaryFile, 'r+');
        try {
          let offset = 0;
          while (offset < patchedBuffer.length) {
            const result = await handle.write(patchedBuffer, offset, patchedBuffer.length - offset, source.dataOffset + offset);
            if (!result || result.bytesWritten <= 0) throw runtimeError('WALLPAPER_SCENE_PACKAGE_PATCH_FAILED');
            offset += result.bytesWritten;
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await fs.promises.rename(temporaryFile, cachedFile);
        } catch (error) {
          const concurrentPackageIsValid = await validateMutedScenePackage(
            cachedFile,
            source.packageSize,
            audioObjectCount
          );
          if (concurrentPackageIsValid) {
            await fs.promises.rm(temporaryFile, { force: true });
          } else {
            await fs.promises.rm(cachedFile, { force: true });
            await fs.promises.rename(temporaryFile, cachedFile);
          }
        }
      } catch (error) {
        try { await fs.promises.rm(temporaryFile, { force: true }); } catch (_) { }
        throw error;
      }
      const rebuiltPackageIsValid = await validateMutedScenePackage(
        cachedFile,
        source.packageSize,
        audioObjectCount
      );
      if (!rebuiltPackageIsValid) {
        await fs.promises.rm(cachedFile, { force: true });
        throw runtimeError('WALLPAPER_SCENE_PACKAGE_PATCH_FAILED');
      }
    }
    session.patchedSceneAudioObjectCount = audioObjectCount;
    session.mutedScenePackageCacheFile = cachedFile;
    return cachedFile;
  }

  async _cleanupStagedProject(session) {
    if (!session || !session.stagedProjectRoot || !session.stagedProjectBaseRoot) return;
    const stageRoot = path.resolve(session.stagedProjectBaseRoot || '');
    const stageDirectory = path.resolve(session.stagedProjectRoot);
    const relative = path.relative(stageRoot, stageDirectory);
    session.stagedProjectRoot = '';
    session.stagedProjectBaseRoot = '';
    session.stagedProjectFile = '';
    session.stagedAudioPropertyCount = 0;
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    try {
      await fs.promises.rm(stageDirectory, { recursive: true, force: true });
    } catch (error) {
      console.warn('[Wallpaper Engine] silent Scene stage cleanup deferred:', error && error.message || error);
    }
  }

  _sessionIsCurrent(session) {
    return !!session
      && !this.disposed
      && session.stopping !== true
      && (this.pending === session || this.active === session);
  }

  _clearSessionMuteReassertions(session) {
    if (!session || !session.muteReassertTimers) return;
    for (const timer of session.muteReassertTimers) clearTimeout(timer);
    session.muteReassertTimers.clear();
  }

  async _applySessionMute(session) {
    if (!this._sessionIsCurrent(session) || !session.executable || !session.locationTitle) return false;
    if (session.muteApplyPromise) return session.muteApplyPromise;
    const operation = (async () => {
      const properties = sanitizeMuteProperties(session.muteProperties);
      await this._runTransientControl(session.executable, [
        '-control',
        'applyProperties',
        '-properties',
        `RAW~(${JSON.stringify(properties)})~END`,
        '-location',
        session.locationTitle,
      ]);
      if (!this._sessionIsCurrent(session)) return false;
      session.audioMuteCommandCount = Math.max(0, Number(session.audioMuteCommandCount) || 0) + 1;
      session.audioMuteLastAt = this.now();
      // This flag means the unique-location property command was acknowledged.
      // It deliberately does not mutate Windows' persistent Core Audio state.
      session.audioPropertySuppressed = true;
      session.audioMuted = true;
      return true;
    })();
    session.muteApplyPromise = operation;
    try {
      return await operation;
    } finally {
      if (session.muteApplyPromise === operation) session.muteApplyPromise = null;
    }
  }

  _scheduleSessionMuteReassertions(session) {
    this._clearSessionMuteReassertions(session);
    if (!this._sessionIsCurrent(session)) return;
    for (const delay of MUTE_REASSERT_DELAYS_MS) {
      const timer = setTimeout(() => {
        if (session.muteReassertTimers) session.muteReassertTimers.delete(timer);
        if (!this._sessionIsCurrent(session)) return;
        this._applySessionMute(session).catch((error) => {
          console.warn('[Wallpaper Engine] location-scoped audio suppression retry failed:', error && error.message || error);
        });
      }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
      session.muteReassertTimers.add(timer);
    }
  }

  async _muteSession(session, muteProperties) {
    const properties = sanitizeMuteProperties(muteProperties);
    session.muteProperties = properties;
    session.audioMuted = false;
    this._clearSessionMuteReassertions(session);
    const deadline = this.wallNow() + INITIAL_MUTE_RETRY_DEADLINE_MS;
    let lastError = null;
    let applied = false;
    for (const delay of INITIAL_MUTE_RETRY_DELAYS_MS) {
      if (delay > 0) await this.nativeSleep(delay);
      if (!this._sessionIsCurrent(session)) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      if (this.wallNow() > deadline) break;
      try {
        applied = await this._applySessionMute(session);
        if (applied) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!applied) {
      if (!this._sessionIsCurrent(session)) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      throw lastError || runtimeError('WALLPAPER_ENGINE_AUDIO_SUPPRESSION_FAILED');
    }
    await this.nativeSleep(80);
    this._scheduleSessionMuteReassertions(session);
  }

  async confirmCaptureReady(expectedSessionId = '') {
    const session = this.active;
    expectedSessionId = String(expectedSessionId || '');
    if (!session || (expectedSessionId && session.sessionId !== expectedSessionId)) return false;
    const muted = await this._applySessionMute(session);
    if (!muted || this.active !== session || session.stopping === true) return false;
    if (!session.windowEmbedding || session.windowEmbedding.aligned !== true) return false;
    // Keep the native WE source physically aligned behind Mineradio so the
    // engine continues to read the real Windows cursor. DWM mirrors that live
    // surface into a click-through helper directly beneath the transparent
    // Electron host; unlike Chromium window capture, it does not bake a second
    // delayed cursor into the picture.
    const surfaceReady = await this._startSessionDwmSurface(session).catch(() => false);
    if (!surfaceReady || this.active !== session || session.stopping === true
      || session.dwmSurfaceReady !== true) return false;
    this._stopSessionPointerRelay(session);
    session.windowParking = null;
    this._scheduleSessionMuteReassertions(session);
    return true;
  }

  _openControlArgs(session) {
    return [
      '-control',
      'openWallpaper',
      '-file',
      session.launchFile,
      '-playInWindow',
      session.locationTitle,
      '-width',
      String(session.launchWidth),
      '-height',
      String(session.launchHeight),
      '-x',
      String(session.launchX),
      '-y',
      String(session.launchY),
      '-borderless',
    ];
  }

  async _openInitialSessionWindow(session, expectedGeneration) {
    if (!session || !session.executable || !session.launchFile) {
      throw runtimeError('WALLPAPER_ENGINE_WINDOW_SESSION_INVALID');
    }
    if (session.initialOpenIssued === true) {
      throw runtimeError('WALLPAPER_ENGINE_INITIAL_OPEN_DUPLICATE');
    }
    session.initialOpenIssued = true;
    const operation = (async () => {
      if (expectedGeneration !== this.generation || this.disposed || this.pending !== session) {
        throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      }
      await this._spawnControl(session.executable, this._openControlArgs(session), {
        isCurrent: () => expectedGeneration === this.generation
          && !this.disposed
          && this.pending === session,
      });
      session.launched = true;
    })();
    session.initialOpenPromise = operation;
    try {
      await operation;
    } finally {
      if (session.initialOpenPromise === operation) session.initialOpenPromise = null;
    }
    if (expectedGeneration !== this.generation || this.disposed || this.pending !== session) {
      throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
    }
  }

  // 关窗失败有两种截然不同的原因：控制器调用本身报错（标题不匹配 / 进程校验失败 /
  // 无法启动控制器），或者控制器返回了但 HWND 在等待窗口内没有消失。两者以前都会塌缩成
  // 同一个错误码，排查时无法区分；这里把阶段、等待时长、底层原因挂在错误对象上。
  // Two very different ways to fail: the controller call itself threw (title mismatch,
  // process validation failure, spawn failure), or it returned with the HWND still alive.
  // Both used to collapse into one opaque code; attach the stage, the wait and the cause.
  _windowCloseError(closeResult, closeError) {
    const error = runtimeError('WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED');
    if (closeError) {
      error.closeStage = 'control';
      error.closeReason = String(
        closeError.nativeDetail
        || closeError.closeReason
        || closeError.message
        || closeError.code
        || closeError
        || 'control failed'
      ).slice(0, 500);
    } else {
      error.closeStage = 'timeout';
      error.closeWaitMs = Number(closeResult && closeResult.closeWaitMs) || 0;
      error.closeReason = 'window still present after ' + String(error.closeWaitMs) + 'ms';
    }
    return error;
  }

  async _relaunchSessionWindow(session, launchWidth, launchHeight, launchX, launchY) {
    const generation = this.generation;
    const isCurrent = () => generation === this.generation
      && !this.disposed
      && session.stopping !== true
      && this.active === session;
    if (!isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
    const previousSourceId = String(session.windowSourceId || session.sourceId || '');
    if (!previousSourceId) throw runtimeError('WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED');
    try {
      await this._spawnControl(session.executable, [
        '-control',
        'closeWallpaper',
        '-location',
        session.locationTitle,
      ], { isCurrent });
    } catch (error) {
      if (!isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      if (error && error.code === 'WALLPAPER_ENGINE_START_SUPERSEDED') throw error;
    }
    if (!isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
    let closeResult = null;
    let closeError = null;
    try {
      closeResult = await this._controlSessionWindow('close', session, previousSourceId);
    } catch (error) {
      // 以前这个 catch 是空的，底层原因（标题校验失败、进程校验失败、控制器起不来）
      // 全部被丢弃，上层只看到笼统的关窗失败。原因保留到抛出的错误对象上。
      // This catch used to be empty, discarding the underlying cause entirely and leaving the
      // caller with a generic close failure. Keep it on the error that gets thrown.
      closeError = error;
    }
    if (!isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
    if (!closeResult || (closeResult.closed !== true && closeResult.missing !== true)) {
      throw this._windowCloseError(closeResult, closeError);
    }
    this._stopSessionPointerRelay(session);
    this._stopSessionDwmSurface(session);
    await this.nativeSleep(180);
    if (!isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
    session.launchWidth = clampInteger(launchWidth, MIN_WIDTH, MAX_WIDTH, session.launchWidth);
    session.launchHeight = clampInteger(launchHeight, MIN_HEIGHT, MAX_HEIGHT, session.launchHeight);
    session.launchX = clampInteger(launchX, MIN_POSITION, MAX_POSITION, session.launchX);
    session.launchY = clampInteger(launchY, MIN_POSITION, MAX_POSITION, session.launchY);
    session.windowEmbedding = null;
    session.windowParking = null;
    session.captureAttached = false;
    await this._spawnControl(session.executable, this._openControlArgs(session), { isCurrent });
    session.launched = true;
    if (!isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
    let earlyMuteError = null;
    const earlyMutePromise = this._muteSession(session, session.muteProperties)
      .then(() => true)
      .catch((error) => {
        earlyMuteError = error;
        return false;
      });
    await this.nativeSleep(240);
    const captureSource = await this._findWindowSource(
      session.locationTitle,
      generation,
      session.runtimeOptions,
      {
        exactTitleOnly: true,
        returnSource: true,
        isCurrent,
        supersededCode: 'WALLPAPER_ENGINE_START_SUPERSEDED',
      }
    );
    if (!isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
    session.sourceId = String(captureSource && captureSource.id || '');
    session.windowSourceId = session.sourceId;
    await this._isolateSessionWindow(session);
    const mutedBeforeCapture = await earlyMutePromise;
    if (!mutedBeforeCapture) {
      if (!isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      await this._muteSession(session, session.muteProperties).catch(() => { throw earlyMuteError; });
    }
  }

  async _verifyExecutableSignature(executable, stat) {
    const key = path.resolve(executable).toLowerCase();
    const stamp = `${Number(stat.size) || 0}:${Math.round(Number(stat.mtimeMs) || 0)}`;
    const cached = this.signatureCache.get(key);
    if (cached && cached.stamp === stamp) return cached.valid;

    let valid = false;
    try {
      const output = await this._execFileText(this.powerShellExecutable, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        signatureScript(),
      ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 7000,
        maxBuffer: 64 * 1024,
        shell: false,
        env: this._powerShellEnv({
          MINERADIO_WE_SIGNATURE_TARGET: executable,
        }),
      });
      const jsonLine = output.split(/\r?\n/).map((line) => line.trim()).reverse().find((line) => /^\{.*\}$/.test(line));
      const signature = jsonLine ? JSON.parse(jsonLine) : null;
      valid = !!signature
        && String(signature.status || '').toLowerCase() === 'valid'
        && SIGNER_PATTERN.test(String(signature.subject || ''));
    } catch (_) {
      valid = false;
    }
    this.signatureCache.set(key, { stamp, valid });
    return valid;
  }

  _candidateExecutables(libraries) {
    const names = this.arch === 'x64'
      ? ['wallpaper64.exe', 'wallpaper32.exe']
      : ['wallpaper32.exe', 'wallpaper64.exe'];
    const seen = new Set();
    const output = [];
    for (const library of Array.isArray(libraries) ? libraries : []) {
      const rawRoot = String(library || '').trim();
      if (!rawRoot) continue;
      const root = path.resolve(rawRoot);
      for (const name of names) {
        const executable = path.join(root, 'steamapps', 'common', 'wallpaper_engine', name);
        const key = executable.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(executable);
      }
    }
    return output;
  }

  async _discoverExecutable(force = false) {
    if (this.platform !== 'win32') return { available: false, reason: 'WALLPAPER_ENGINE_WINDOWS_ONLY' };
    if (force) {
      this.executableCache = null;
      this.signatureCache.clear();
    }
    if (this.executableCache) {
      const stat = await statFile(this.executableCache.executable);
      if (stat && await this._verifyExecutableSignature(this.executableCache.executable, stat)) {
        return this.executableCache;
      }
      this.executableCache = null;
    }
    if (this.executableDiscoveryPromise && !force) return this.executableDiscoveryPromise;

    const discovery = (async () => {
      let libraries = [];
      try { libraries = await this.discoverSteamLibraries(); } catch (_) { libraries = []; }
      let unsignedInstallationFound = false;
      for (const executable of this._candidateExecutables(libraries)) {
        const stat = await statFile(executable);
        if (!stat) continue;
        if (!await this._verifyExecutableSignature(executable, stat)) {
          unsignedInstallationFound = true;
          continue;
        }
        const found = {
          available: true,
          executable,
          executableName: path.basename(executable),
        };
        this.executableCache = found;
        return found;
      }
      return {
        available: false,
        reason: unsignedInstallationFound
          ? 'WALLPAPER_ENGINE_SIGNATURE_INVALID'
          : 'WALLPAPER_ENGINE_NOT_INSTALLED',
      };
    })();
    this.executableDiscoveryPromise = discovery;
    try {
      return await discovery;
    } finally {
      if (this.executableDiscoveryPromise === discovery) this.executableDiscoveryPromise = null;
    }
  }

  async probe(force = false) {
    if (force && typeof force === 'object') force = force.force === true;
    const result = await this._discoverExecutable(force === true);
    return result.available ? {
      ok: true,
      available: true,
      executable: result.executableName,
    } : {
      ok: true,
      available: false,
      reason: result.reason || 'WALLPAPER_ENGINE_NOT_INSTALLED',
    };
  }

  async revealWorkshop(workshopId) {
    workshopId = String(workshopId || '').trim();
    if (!/^\d{5,32}$/.test(workshopId)) throw runtimeError('WALLPAPER_ENGINE_WORKSHOP_ID_INVALID');
    if (this.disposed) throw runtimeError('WALLPAPER_ENGINE_RUNTIME_DISPOSED');
    const installation = await this._discoverExecutable(false);
    if (!installation.available || !installation.executable) {
      throw runtimeError(installation.reason || 'WALLPAPER_ENGINE_NOT_INSTALLED');
    }
    const executable = await this._ensureEngineReady(installation.executable);
    await this._runTransientControl(executable, [
      '-control',
      'revealWallpaper',
      '-id',
      workshopId,
    ]);
    return { ok: true, workshopId };
  }

  // 记一条发往引擎的命令。写失败只忽略——诊断能力不该反过来拖垮播放。
  // Record one command sent to the engine. A write failure is ignored on purpose: a diagnostic aid
  // must never become the reason playback fails.
  _logControlCommand(args) {
    const target = this.controlCommandLogPath;
    if (!target) return false;
    try {
      const line = `${new Date().toISOString()}\t${(Array.isArray(args) ? args : []).map((value) => String(value)).join(' ')}\n`;
      fs.appendFileSync(target, line, 'utf8');
      return true;
    } catch (error) {
      return false;
    }
  }

  async _spawnControl(executable, args, options = {}) {
    this._logControlCommand(args);
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : null;
    const elevated = this.useDesktopShellBroker && await this._hostIsElevated();
    if (isCurrent && !isCurrent()) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
    if (elevated) {
      return this._spawnControlViaDesktopShell(executable, args);
    }
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error && error.code === 'WALLPAPER_ENGINE_START_SUPERSEDED') reject(error);
        else if (error) reject(runtimeError('WALLPAPER_ENGINE_CONTROL_FAILED'));
        else resolve();
      };
      try {
        if (isCurrent && !isCurrent()) {
          finish(runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED'));
          return;
        }
        // 引擎本体必须与本进程解绑（detached: true），否则 MR 一退出，Windows 会把子进程
        // 树一起带走，而这个引擎同时在托管用户自己的桌面壁纸 —— 于是关掉 MR 就等于关掉桌面
        // 壁纸（实测表现为桌面回落成 WE 那张 474x265 的低分辨率备份，看着像"变回默认桌面"）。
        //
        // 改成独立常驻 + 按需唤醒：MR 启动时先探测，引擎已存在就直接复用并只发 -control 命令；
        // 不存在才用 detached 拉起一个，之后它不再随 MR 生死。MR 自己退出时只发
        // closeWallpaper 关掉联动窗口（_closeSession 一直是这么做的），引擎与桌面壁纸留给它
        // 继续管。
        //
        // The engine process must be detached from us. A bound child dies with the parent's
        // process tree, and this engine also hosts the user's own desktop wallpaper, so closing
        // Mineradio would take the desktop down with it (observed as the desktop falling back to
        // WE's 474x265 backup, which reads as "reverts to the default desktop"). Detaching turns
        // this into "resident engine, woken on demand": probe first, reuse a running engine and
        // only send -control commands, launch a detached one when none exists, and on exit send
        // closeWallpaper for our own window only. Control commands stay bound — they exit at once
        // and have nothing to outlive us.
        child = this.spawn(executable, args, {
          windowsHide: true,
          stdio: 'ignore',
          detached: options.keepAlive === true,
          shell: false,
        });
      } catch (error) {
        finish(error);
        return;
      }
      if (!child || typeof child.once !== 'function') {
        finish(new Error('spawn failed'));
        return;
      }
      child.once('error', finish);
      child.once('spawn', () => {
        try { if (typeof child.unref === 'function') child.unref(); } catch (_) { }
        finish();
      });
    });
  }

  async _hostIsElevated() {
    if (this.hostElevationCache !== null) return this.hostElevationCache;
    try {
      this.hostElevationCache = await this.hostElevationProbe() !== false;
    } catch (_) {
      this.hostElevationCache = true;
    }
    return this.hostElevationCache;
  }

  async _spawnControlViaDesktopShell(executable, args, options = {}) {
    this._logControlCommand(args);
    const commandLine = wallpaperControlCommandLine(executable, args);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, _stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (error) {
          const detail = String(stderr || error.message || error || '').trim().slice(0, 500);
          if (detail) console.warn(`[Wallpaper Engine] desktop-token launch failed: ${detail}`);
          reject(runtimeError('WALLPAPER_ENGINE_CONTROL_FAILED'));
        }
        else resolve();
      };
      try {
        this.controlExecFile(this.powerShellExecutable, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          ...this._powerShellHelperArgs('control-broker', controlBrokerScript()),
        ], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 32 * 1024,
          shell: false,
          env: this._powerShellEnv({
            MINERADIO_WE_CONTROL_TARGET: executable,
            MINERADIO_WE_CONTROL_COMMAND_LINE: commandLine,
            MINERADIO_WE_CONTROL_WAIT: options.waitForExit === true ? '1' : '0',
            MINERADIO_WE_CONTROL_WAIT_TIMEOUT: options.waitForExit === true ? '10000' : '0',
          }),
        }, finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  async _probeEngineProcess(expectedExecutable) {
    try {
      return normalizeEngineProcessState(await this.engineProcessProbe(expectedExecutable));
    } catch (_) {
      return normalizeEngineProcessState(null);
    }
  }

  async _waitForKnownEngineState(expectedExecutable, deadline) {
    while (this.wallNow() <= deadline) {
      if (this.disposed) throw runtimeError('WALLPAPER_ENGINE_RUNTIME_DISPOSED');
      const state = await this._probeEngineProcess(expectedExecutable);
      if (state.ok) return state;
      if (this.wallNow() > deadline) break;
      await this.nativeSleep(ENGINE_PROCESS_POLL_MS);
    }
    throw runtimeError('WALLPAPER_ENGINE_PROCESS_PROBE_FAILED');
  }

  async _trustedRunningExecutable(requestedExecutable, state) {
    if (!state || state.matching !== true) {
      throw runtimeError(state && state.running
        ? 'WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH'
        : 'WALLPAPER_ENGINE_NOT_RUNNING');
    }
    const requestedRoot = path.dirname(path.resolve(requestedExecutable));
    const effectiveExecutable = path.resolve(String(state.executable || requestedExecutable));
    if (path.dirname(effectiveExecutable).toLowerCase() !== requestedRoot.toLowerCase()) {
      throw runtimeError('WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH');
    }
    const name = path.basename(effectiveExecutable).toLowerCase();
    if (name !== 'wallpaper32.exe' && name !== 'wallpaper64.exe') {
      throw runtimeError('WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH');
    }
    const stat = await statFile(effectiveExecutable);
    if (!stat || !await this._verifyExecutableSignature(effectiveExecutable, stat)) {
      throw runtimeError('WALLPAPER_ENGINE_SIGNATURE_INVALID');
    }
    return effectiveExecutable;
  }

  async _waitForEngineProcess(requestedExecutable, deadline) {
    let stableObservations = 0;
    let stableSince = 0;
    let effectiveExecutable = '';
    let stablePidsKey = '';
    let observedKnownState = false;
    while (this.wallNow() <= deadline) {
      if (this.disposed) throw runtimeError('WALLPAPER_ENGINE_RUNTIME_DISPOSED');
      const state = await this._probeEngineProcess(requestedExecutable);
      if (!state.ok) {
        effectiveExecutable = '';
        stablePidsKey = '';
        stableObservations = 0;
        stableSince = 0;
        if (this.wallNow() > deadline) break;
        await this.nativeSleep(ENGINE_PROCESS_POLL_MS);
        continue;
      }
      observedKnownState = true;
      if (state.running && !state.matching) {
        throw runtimeError('WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH');
      }
      if (state.matching) {
        const currentExecutable = await this._trustedRunningExecutable(requestedExecutable, state);
        const currentPidsKey = engineProcessPidKey(state);
        if (effectiveExecutable
          && currentExecutable.toLowerCase() === effectiveExecutable.toLowerCase()
          && currentPidsKey === stablePidsKey) {
          effectiveExecutable = currentExecutable;
          stableObservations += 1;
        } else {
          effectiveExecutable = currentExecutable;
          stablePidsKey = currentPidsKey;
          stableObservations = 1;
          stableSince = this.wallNow();
        }
        if (stableObservations >= 2 && this.wallNow() - stableSince >= ENGINE_PROCESS_STABLE_MS) {
          return { executable: effectiveExecutable, state };
        }
      } else {
        effectiveExecutable = '';
        stablePidsKey = '';
        stableObservations = 0;
        stableSince = 0;
      }
      if (this.wallNow() > deadline) break;
      await this.nativeSleep(ENGINE_PROCESS_POLL_MS);
    }
    throw runtimeError(observedKnownState
      ? 'WALLPAPER_ENGINE_BOOTSTRAP_TIMEOUT'
      : 'WALLPAPER_ENGINE_PROCESS_PROBE_FAILED');
  }

  async _waitForEngineControlReady(executable, deadline) {
    let consecutiveSuccesses = 0;
    let readyPidsKey = '';
    while (this.wallNow() <= deadline) {
      if (this.disposed) throw runtimeError('WALLPAPER_ENGINE_RUNTIME_DISPOSED');
      const state = await this._probeEngineProcess(executable);
      if (!state.ok) {
        consecutiveSuccesses = 0;
        readyPidsKey = '';
        if (this.wallNow() > deadline) break;
        await this.nativeSleep(ENGINE_READY_POLL_MS);
        continue;
      }
      if (state.running && !state.matching) {
        throw runtimeError('WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH');
      }
      if (!state.matching) {
        consecutiveSuccesses = 0;
        readyPidsKey = '';
      } else {
        const currentPidsKey = engineProcessPidKey(state);
        if (currentPidsKey !== readyPidsKey) {
          consecutiveSuccesses = 0;
          readyPidsKey = currentPidsKey;
        }
        try {
          const acknowledged = await this.engineReadyProbe(executable);
          consecutiveSuccesses = acknowledged === false ? 0 : consecutiveSuccesses + 1;
          if (consecutiveSuccesses >= ENGINE_READY_SUCCESS_COUNT) {
            this.engineReadyExecutable = path.resolve(executable);
            this.engineReadyAt = this.now();
            this.engineReadyPidsKey = currentPidsKey;
            return true;
          }
        } catch (_) {
          consecutiveSuccesses = 0;
        }
      }
      if (this.wallNow() > deadline) break;
      await this.nativeSleep(ENGINE_READY_POLL_MS);
    }
    throw runtimeError('WALLPAPER_ENGINE_CONTROL_NOT_READY');
  }

  async _ensureEngineReady(requestedExecutable, silentWindows = true) {
    const requested = path.resolve(requestedExecutable);
    if (this.engineBootstrapPromise) {
      if (this.engineBootstrapExecutable.toLowerCase() !== requested.toLowerCase()) {
        throw runtimeError('WALLPAPER_ENGINE_BOOTSTRAP_CONFLICT');
      }
      return this.engineBootstrapPromise;
    }

    const operation = (async () => {
      const deadline = this.wallNow() + ENGINE_BOOTSTRAP_TIMEOUT_MS;
      let state = await this._waitForKnownEngineState(requested, deadline);
      if (state.running && !state.matching) {
        throw runtimeError('WALLPAPER_ENGINE_PROCESS_PATH_MISMATCH');
      }

      let effectiveExecutable = '';
      let effectiveState = state;
      if (state.matching) {
        effectiveExecutable = await this._trustedRunningExecutable(requested, state);
        // 用户早就开着 WE 时走的是这条分支：壁纸窗口跑在**用户自己那个进程**里，进程不是我们
        // 拉起的，所以之前完全不会启动常驻监视器 —— 于是壁纸窗口靠旧路径静默了，而它之后弹
        // 出的任何窗口（设置、更新提示）都直接落到任务栏上，也就是用户看到的"还是有 WE"。
        // 复用场景同样要挂监视器：目标是"开启壁纸后不管什么时候都静默"，而这个目标与进程是谁
        // 拉起的无关。代价是用户自己开的 WE 也会被静默——这正是设置项承诺的语义（"播放壁纸时
        // 不弹任务栏提醒"），而托盘图标仍在，管理器窗口随时能从托盘找回。
        // When the user already had the engine running this is the branch taken: the wallpaper
        // lives inside THEIR process, so no monitor was ever started — the wallpaper window itself
        // was silenced by the older path, while anything it raised later (settings, update
        // prompts) landed straight on the taskbar. That is the "WE is still there" report. A reused
        // engine needs the monitor just as much: the goal is silence whenever a wallpaper is
        // playing, and that has nothing to do with who started the process. The cost is that a
        // user-owned engine is silenced too, which is exactly what the setting promises ("no
        // taskbar reminder while a wallpaper plays"), and the tray icon remains, so the manager
        // window is always reachable from there.
        if (silentWindows !== false) {
          this._startEngineWindowIsolationMonitor(ENGINE_WINDOW_ISOLATION_PROCESSES);
        }
      } else {
        const executableName = path.basename(requested).toLowerCase();
        if (executableName !== 'wallpaper32.exe' && executableName !== 'wallpaper64.exe') {
          throw runtimeError('WALLPAPER_ENGINE_EXECUTABLE_INVALID');
        }
        const executableStat = await statFile(requested);
        if (!executableStat || !await this._verifyExecutableSignature(requested, executableStat)) {
          throw runtimeError('WALLPAPER_ENGINE_SIGNATURE_INVALID');
        }
        // Wallpaper Engine explicitly supports launching the main executable
        // directly from its installation directory. This keeps the core quiet
        // even when its Steam launcher wants to show crash-recovery/browse UI.
        // No -control command is sent until the process and IPC channel are
        // independently confirmed ready below.
        // keepAlive: 这是唯一一处"拉起引擎本体"，需要与 MR 解绑。
        // keepAlive: the only call that starts the engine itself, so it must outlive us.
        await this._spawnControl(requested, [], { keepAlive: true });
        const running = await this._waitForEngineProcess(requested, deadline);
        effectiveExecutable = running.executable;
        effectiveState = running.state;
        // 按进程名（壁纸核心）静默，不按 PID：绑 PID 的监视器在 WE 重启后就会失效，而"用户自己
        // 开着的 WE 也被静默"正是这个功能承诺的语义——播放壁纸时任务栏不该有 WE。
        // Only the instance launched here is isolated. The before/after PID difference delimits
        // "launched here"; a process-name match would also swallow the user's own engine, the
        // exact opposite of the promise this feature makes.
        if (silentWindows !== false) {
          this._startEngineWindowIsolationMonitor(ENGINE_WINDOW_ISOLATION_PROCESSES);
        }
      }

      const cacheAge = this.now() - Number(this.engineReadyAt || 0);
      const effectivePidsKey = engineProcessPidKey(effectiveState);
      const cacheMatches = this.engineReadyExecutable
        && this.engineReadyExecutable.toLowerCase() === effectiveExecutable.toLowerCase()
        && this.engineReadyPidsKey === effectivePidsKey
        && cacheAge >= 0
        && cacheAge <= ENGINE_READY_CACHE_MS;
      if (!cacheMatches) await this._waitForEngineControlReady(effectiveExecutable, deadline);
      return effectiveExecutable;
    })();

    this.engineBootstrapExecutable = requested;
    this.engineBootstrapPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.engineBootstrapPromise === operation) {
        this.engineBootstrapPromise = null;
        this.engineBootstrapExecutable = '';
      }
    }
  }

  async _findWindowSource(locationTitle, generation, options, constraints = {}) {
    if (!this.desktopCapturer || typeof this.desktopCapturer.getSources !== 'function') {
      throw runtimeError('WALLPAPER_ENGINE_CAPTURE_UNAVAILABLE');
    }
    const exactTitleOnly = constraints.exactTitleOnly === true;
    const isCurrent = typeof constraints.isCurrent === 'function'
      ? constraints.isCurrent
      : null;
    const supersededCode = String(constraints.supersededCode || 'WALLPAPER_ENGINE_START_SUPERSEDED');
    const returnSource = constraints.returnSource === true;
    const acceptSource = typeof constraints.acceptSource === 'function'
      ? constraints.acceptSource
      : null;
    const assertCurrent = () => {
      if (generation !== this.generation || this.disposed || (isCurrent && !isCurrent())) {
        throw runtimeError(supersededCode);
      }
    };
    const deadline = this.now() + options.sourceTimeoutMs;
    while (this.now() <= deadline) {
      assertCurrent();
      let sources = [];
      try {
        sources = await this.desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
      } catch (_) { }
      assertCurrent();
      if (!Array.isArray(sources)) sources = [];
      const exact = sources.find((source) => String(source && source.name || '') === locationTitle
        && (!acceptSource || acceptSource(source)));
      const matched = exactTitleOnly
        ? exact
        : exact || sources.find((source) => String(source && source.name || '').includes(locationTitle)
          && (!acceptSource || acceptSource(source)));
      if (matched && matched.id) {
        return returnSource ? matched : String(matched.id);
      }
      assertCurrent();
      await this.sleep(options.sourcePollMs);
    }
    throw runtimeError('WALLPAPER_ENGINE_WINDOW_TIMEOUT');
  }

  async refreshActiveSource(expectedSessionId = '', options = {}) {
    if (expectedSessionId && typeof expectedSessionId === 'object') {
      options = expectedSessionId;
      expectedSessionId = options.sessionId || '';
    }
    if (!options || typeof options !== 'object') options = {};
    if (this.disposed) throw runtimeError('WALLPAPER_ENGINE_RUNTIME_DISPOSED');

    const session = this.active;
    if (!session) throw runtimeError('WALLPAPER_ENGINE_NOT_ACTIVE');
    expectedSessionId = String(expectedSessionId || '');
    if (expectedSessionId && session.sessionId !== expectedSessionId) {
      throw runtimeError('WALLPAPER_ENGINE_SESSION_MISMATCH');
    }
    this._stopSessionPointerRelay(session);
    this._stopSessionDwmSurface(session);

    const generation = this.generation;
    const sessionId = session.sessionId;
    const locationTitle = session.locationTitle;
    const refreshToken = (Number(session.sourceRefreshToken) || 0) + 1;
    session.sourceRefreshToken = refreshToken;
    const runtimeOptions = safeRuntimeOptions({
      ...options,
      sourceTimeoutMs: options.sourceTimeoutMs == null
        ? (options.timeoutMs == null ? DEFAULT_REFRESH_SOURCE_TIMEOUT_MS : options.timeoutMs)
        : options.sourceTimeoutMs,
      sourcePollMs: options.sourcePollMs == null
        ? (options.pollIntervalMs == null
          ? (options.pollMs == null ? DEFAULT_REFRESH_SOURCE_POLL_MS : options.pollMs)
          : options.pollIntervalMs)
        : options.sourcePollMs,
    });
    const isCurrent = () => this.active === session
      && session.sessionId === sessionId
      && session.sourceRefreshToken === refreshToken;

    const captureSource = await this._findWindowSource(
      locationTitle,
      generation,
      runtimeOptions,
      {
        exactTitleOnly: true,
        returnSource: true,
        isCurrent,
        supersededCode: 'WALLPAPER_ENGINE_REFRESH_SUPERSEDED',
      }
    );
    if (generation !== this.generation || this.disposed || !isCurrent()) {
      throw runtimeError('WALLPAPER_ENGINE_REFRESH_SUPERSEDED');
    }
    const refreshedSourceId = String(captureSource && captureSource.id || '');
    const previousHandle = (/^window:(\d+):\d+$/.exec(String(session.sourceId || '')) || [])[1] || '';
    const refreshedHandle = (/^window:(\d+):\d+$/.exec(refreshedSourceId) || [])[1] || '';
    const sameWindow = !!previousHandle && previousHandle === refreshedHandle;
    session.sourceId = refreshedSourceId;
    session.windowSourceId = refreshedSourceId;
    if (!sameWindow) {
      session.windowEmbedding = null;
      session.windowParking = null;
    }
    session.captureAttached = false;
    const result = this._publicSession(session);
    if (options.includeSource === true) result.captureSource = captureSource;
    return result;
  }

  async embedActiveWindow(expectedSessionId = '', host = {}) {
    const session = this.active;
    if (!session) throw runtimeError('WALLPAPER_ENGINE_NOT_ACTIVE');
    expectedSessionId = String(expectedSessionId || '');
    if (expectedSessionId && session.sessionId !== expectedSessionId) {
      throw runtimeError('WALLPAPER_ENGINE_SESSION_MISMATCH');
    }
    if (session.embedPromise) return session.embedPromise;
    const generation = this.generation;
    const operation = (async () => {
      let embedding = await this._controlSessionWindow('embed', session, String(session.sourceId || ''), host);
      for (let attempt = 0; attempt < 3 && embedding.aligned !== true; attempt += 1) {
        const hostWidth = Math.max(1, Number(embedding.hostRight) - Number(embedding.hostLeft));
        const hostHeight = Math.max(1, Number(embedding.hostBottom) - Number(embedding.hostTop));
        const sourceWidth = Math.max(1, Number(embedding.right) - Number(embedding.left));
        const sourceHeight = Math.max(1, Number(embedding.bottom) - Number(embedding.top));
        const scaleX = Math.max(0.5, Math.min(4, Number(session.width) / hostWidth));
        const scaleY = Math.max(0.5, Math.min(4, Number(session.height) / hostHeight));
        const correctedWidth = Math.round(Number(session.launchWidth) - (sourceWidth - hostWidth) * scaleX);
        const correctedHeight = Math.round(Number(session.launchHeight) - (sourceHeight - hostHeight) * scaleY);
        const correctedX = Math.round(Number(session.launchX) + (Number(embedding.hostLeft) - Number(embedding.left)) * scaleX);
        const correctedY = Math.round(Number(session.launchY) + (Number(embedding.hostTop) - Number(embedding.top)) * scaleY);
        if (correctedWidth === session.launchWidth
          && correctedHeight === session.launchHeight
          && correctedX === session.launchX
          && correctedY === session.launchY) break;
        await this._relaunchSessionWindow(session, correctedWidth, correctedHeight, correctedX, correctedY);
        embedding = await this._controlSessionWindow('embed', session, String(session.sourceId || ''), host);
      }
      if (embedding.aligned !== true) throw runtimeError('WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED');
      if (generation !== this.generation || this.disposed || this.active !== session || session.stopping === true) {
        throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      }
      session.parallaxPointerHostWindowId = String(host.hostWindowId || '');
      session.parallaxPointerHostExecutable = String(host.hostExecutable || '');
      session.dwmSurfaceHostWindowId = String(host.hostWindowId || '');
      session.dwmSurfaceHostExecutable = String(host.hostExecutable || '');
      session.dwmSurfaceHostCornerRadius = clampInteger(host.cornerRadius, 0, 512, 0);
      session.dwmSurfaceDesktopIconLayering = host.desktopIconLayering === true;
      session.captureAttached = true;
      await this._isolateSessionWindow(session, String(session.sourceId || ''));
      return this._publicSession(session);
    })();
    session.embedPromise = operation;
    try {
      return await operation;
    } finally {
      if (session.embedPromise === operation) session.embedPromise = null;
    }
  }

  async parkActiveWindow(expectedSessionId = '') {
    const session = this.active;
    if (!session) throw runtimeError('WALLPAPER_ENGINE_NOT_ACTIVE');
    expectedSessionId = String(expectedSessionId || '');
    if (expectedSessionId && session.sessionId !== expectedSessionId) {
      throw runtimeError('WALLPAPER_ENGINE_SESSION_MISMATCH');
    }
    if (session.windowParking && session.windowParking.parked === true) {
      return this._publicSession(session);
    }
    if (session.parkPromise) return session.parkPromise;
    const generation = this.generation;
    const operation = (async () => {
      const parking = await this._controlSessionWindow('park', session, String(session.sourceId || ''));
      if (generation !== this.generation || this.disposed || this.active !== session || session.stopping === true) {
        throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      }
      if (!parking || parking.parked !== true) throw runtimeError('WALLPAPER_ENGINE_WINDOW_ISOLATION_FAILED');
      return this._publicSession(session);
    })();
    session.parkPromise = operation;
    try {
      return await operation;
    } finally {
      if (session.parkPromise === operation) session.parkPromise = null;
    }
  }

  async _closeSession(session) {
    if (!session) return false;
    if (!session.executable || !session.locationTitle) {
      this._stopSessionPointerRelay(session);
      this._stopSessionDwmSurface(session);
      await this._waitForSessionDwmSurfaceStop(session);
      this._clearSessionMuteReassertions(session);
      if (!session.launched) await this._cleanupStagedProject(session);
      return false;
    }
    if (session.closePromise) return session.closePromise;
    const operation = (async () => {
      if (session.initialOpenPromise) {
        try { await session.initialOpenPromise; } catch (_) { }
      }
      if (!session.launched) {
        this._stopSessionPointerRelay(session);
        this._stopSessionDwmSurface(session);
        await this._waitForSessionDwmSurfaceStop(session);
        this._clearSessionMuteReassertions(session);
        await this._cleanupStagedProject(session);
        return false;
      }
      let closeRequested = false;
      const sourceId = String(session.windowSourceId || session.sourceId || '');
      let windowClosed = false;
      // 两个 catch 以前都是空的，关窗失败的原因被整个丢掉，上层只能看到 stopped:false。
      // Both catches used to be empty, so the close failure left no trace and the caller could
      // only ever see stopped:false.
      const closeNotes = [];
      try {
        await this._spawnControl(session.executable, [
          '-control',
          'closeWallpaper',
          '-location',
          session.locationTitle,
        ]);
        closeRequested = true;
      } catch (error) {
        closeNotes.push('we-control:' + String(error && (error.code || error.message) || error || ''));
      }
      if (sourceId) {
        try {
          const fallback = await this._controlSessionWindow('close', session, sourceId);
          windowClosed = !!(fallback && (fallback.closed === true || fallback.missing === true));
        } catch (error) {
          closeNotes.push('hwnd-close:' + String(
            error && (error.nativeDetail || error.closeReason || error.code || error.message) || error || ''
          ));
        }
      }
      await this.nativeSleep(180);
      // 按窗口名枚举是**独立于 HWND 校验**的确认手段：它回答的是"那个标题的窗口还在不在"，
      // 而 HWND 校验回答的是"我能不能操作我现在拿着的那个句柄"。只要还没确认关掉就该跑它。
      // 原来的 `!sourceId` 恰好跳过了最需要它的场景——有 sourceId、但 HWND 校验失败
      //（标题/进程不匹配，正是 nativeStage=exec 那次失败的形态）时，WE 自己的 closeWallpaper
      // 很可能已经把窗口关掉了，而我们却因为没去枚举而判定"没关掉"，进而永久卡在
      // close-previous-window 上。
      // Name enumeration is independent of HWND validation: it answers "is that titled window
      // still around", not "can I drive the handle I am holding". It must run while the close is
      // unconfirmed. The old `!sourceId` gate skipped exactly the case that needs it — a sourceId
      // whose HWND validation failed — where WE's own closeWallpaper likely did close the window.
      if (!windowClosed && closeRequested && this.desktopCapturer
        && typeof this.desktopCapturer.getSources === 'function') {
        try {
          const sources = await this.desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          });
          windowClosed = !sources.some((source) => String(source && source.name || '') === session.locationTitle);
        } catch (error) {
          closeNotes.push('enumerate:' + String(error && (error.message || error) || ''));
        }
      }
      if (!windowClosed) {
        // 把原因留在会话上，让 stop()/start() 能把它带进最终抛出的错误和日志。
        // Keep the reason on the session so stop()/start() can carry it into the thrown error.
        session.closeNotes = closeNotes.join(' | ').slice(0, 400);
        if (closeNotes.length) {
          console.warn('[Wallpaper Engine] session window close unconfirmed:', session.locationTitle, session.closeNotes);
        }
        return false;
      }
      session.closeNotes = '';
      this._stopSessionPointerRelay(session);
      this._stopSessionDwmSurface(session);
      await this._waitForSessionDwmSurfaceStop(session);
      this._clearSessionMuteReassertions(session);
      session.windowSourceId = '';
      session.sourceId = '';
      session.windowEmbedding = null;
      session.windowParking = null;
      session.captureAttached = false;
      session.launched = false;
      await this._cleanupStagedProject(session);
      return true;
    })();
    session.closePromise = operation;
    try {
      return await operation;
    } finally {
      if (session.closePromise === operation) session.closePromise = null;
    }
  }

  async start(id, options = {}) {
    if (id && typeof id === 'object') {
      options = id;
      id = options.id;
    }
    if (this.disposed) throw runtimeError('WALLPAPER_ENGINE_RUNTIME_DISPOSED');
    if (!this.library || typeof this.library.getNativeSceneTarget !== 'function') {
      throw runtimeError('WALLPAPER_ENGINE_LIBRARY_UNAVAILABLE');
    }

    const generation = ++this.generation;
    const runtimeOptions = safeRuntimeOptions(options);
    const sessionId = crypto.randomBytes(12).toString('hex');
    const session = {
      id: String(id || '').toLowerCase(),
      sessionId,
      locationTitle: `Mineradio Wallpaper ${sessionId}`,
      sourceId: '',
      windowSourceId: '',
      windowEmbedding: null,
      windowParking: null,
      width: runtimeOptions.width,
      height: runtimeOptions.height,
      fps: runtimeOptions.fps,
      executable: '',
      launched: false,
      initialOpenIssued: false,
      initialOpenPromise: null,
      sourceRefreshToken: 0,
      audioMuted: false,
      audioPropertySuppressed: false,
      captureAttached: false,
      launchFile: '',
      stagedProjectRoot: '',
      stagedProjectBaseRoot: '',
      stagedProjectFile: '',
      stagedAudioPropertyCount: 0,
      patchedSceneAudioObjectCount: 0,
      mutedScenePackageCacheFile: '',
      launchWidth: runtimeOptions.width,
      launchHeight: runtimeOptions.height,
      launchX: runtimeOptions.x,
      launchY: runtimeOptions.y,
      runtimeOptions,
      silentWindows: runtimeOptions.silentWindows,
      muteProperties: sanitizeMuteProperties(null),
      muteReassertTimers: new Set(),
      audioMuteCommandCount: 0,
      audioMuteLastAt: 0,
      muteApplyPromise: null,
      embedPromise: null,
      parkPromise: null,
      dwmSurfaceHostWindowId: '',
      dwmSurfaceHostExecutable: '',
      dwmSurfaceHostCornerRadius: 0,
      dwmSurfaceDesktopIconLayering: false,
      dwmSurfaceProcess: null,
      dwmSurfaceStartPromise: null,
      dwmSurfaceReady: false,
      dwmSurfaceActive: false,
      dwmSurfaceHelperPid: 0,
      dwmSurfaceWindowId: 0,
      dwmSurfaceRetryTimer: null,
      dwmDesktopIconLayering: false,
      dwmDesktopIconLayeringAckToken: 0,
      dwmVisualOpacity: 1,
      dwmVisualPositionX: 0,
      dwmVisualPositionY: 0,
      dwmVisualScale: 1,
      // 渲染进程可能早于帮手就绪就推送了缩放；置位后由就绪分支补发，避免帮手一直用启动初值。
      // The renderer may push before the helper is ready; this flag lets the ready path
      // flush the value so the helper never keeps its spawn-time default.
      dwmVisualSettingsPending: false,
      dwmGlassSurfaceReady: false,
      dwmGlassSurfaceActive: false,
      dwmGlassSurfaceWindowId: 0,
      dwmGlassSurfaceGeometry: null,
      dwmGlassSurfaceGeometryKey: '',
      parallaxPointerHostWindowId: '',
      parallaxPointerHostExecutable: '',
      parallaxPointerRelayProcess: null,
      parallaxPointerRelayStartPromise: null,
      parallaxPointerRelayReady: false,
      parallaxPointerRelayActive: false,
      parallaxPointerRelayHelperPid: 0,
      parallaxPointerRelayTargetWindowId: 0,
      parallaxPointerRelayTargetClass: '',
      parallaxPointerRelayTargetTitle: '',
      parallaxPointerRelayQueued: 0,
      parallaxPointerRelayCoalesced: 0,
      parallaxPointerRelayPosted: 0,
      parallaxPointerRelayPending: false,
      parallaxPointerRelayTimer: null,
      parallaxPointerRelayLastPostedAt: 0,
      parallaxPointerRelayBackpressured: false,
      parallaxPointerRelayDrainListener: null,
      parallaxPointerRelayRetryTimers: new Set(),
      parallaxPointerRelayRetryPromise: null,
      parallaxPointerRelayRetryResolve: null,
      parallaxPointerRelayLatestX: null,
      parallaxPointerRelayLatestY: null,
      closePromise: null,
      stopping: false,
    };
    this.pending = session;
    let startStage = 'discover-target';

    try {
      const [installation, target] = await Promise.all([
        this._discoverExecutable(false),
        this.library.getNativeSceneTarget(session.id),
      ]);
      if (generation !== this.generation || this.disposed) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      if (!installation.available || !installation.executable) {
        throw runtimeError(installation.reason || 'WALLPAPER_ENGINE_NOT_INSTALLED');
      }
      const projectFile = target && target.projectFile;
      const scenePackage = target && target.scenePackage;
      const projectStat = projectFile && path.isAbsolute(projectFile) && path.extname(projectFile).toLowerCase() === '.json'
        ? await statFile(projectFile)
        : null;
      const sceneExtension = path.extname(String(scenePackage || '')).toLowerCase();
      const targetStat = scenePackage && path.isAbsolute(scenePackage) && (sceneExtension === '.pkg' || sceneExtension === '.pak')
        ? await statFile(scenePackage)
        : null;
      if (!targetStat || !target || String(target.id || '').toLowerCase() !== session.id) {
        throw runtimeError('WALLPAPER_SCENE_PACKAGE_INVALID');
      }
      if (generation !== this.generation || this.disposed) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');

      startStage = 'ensure-engine-ready';
      session.executable = await this._ensureEngineReady(installation.executable, session.silentWindows);
      if (generation !== this.generation || this.disposed || this.pending !== session) {
        throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      }
      session.muteProperties = sanitizeMuteProperties(target && target.muteProperties);
      startStage = 'prepare-silent-project';
      session.launchFile = projectStat
        ? await this._prepareSilentLaunchFile(session, projectFile, scenePackage)
        : scenePackage;
      const previous = this.active;
      if (previous && previous.sessionId !== session.sessionId) {
        startStage = 'close-previous-window';
        // 这里刻意**不重试**：契约是"关窗没被确认就只尝试一次然后失败"，避免连续开窗、
        // 在桌面上叠出多个 WE 窗口。要让这一步能过去，得在 _closeSession 里真正把
        // "窗口是否还在"确认对（见那边的按名枚举），而不是在这里反复试。
        // Deliberately no retry here: the contract is "one attempt, then fail" so we never stack
        // multiple Wallpaper Engine windows. The way out is to make _closeSession actually
        // confirm the window is gone (see the name enumeration there), not to try again.
        const stoppedPrevious = await this.stop(previous.sessionId);
        if (!stoppedPrevious || stoppedPrevious.stopped !== true) {
          const failure = runtimeError(
            stoppedPrevious && stoppedPrevious.reason || 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED'
          );
          failure.closeNotes = String(stoppedPrevious && stoppedPrevious.closeNotes || '').slice(0, 400);
          throw failure;
        }
        if (generation !== this.generation || this.disposed || this.pending !== session) {
          throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
        }
      }
      startStage = 'open-initial-window';
      await this._openInitialSessionWindow(session, generation);
      if (generation !== this.generation || this.disposed) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      let earlyMuteError = null;
      const earlyMutePromise = this._muteSession(session, session.muteProperties)
        .then(() => true)
        .catch((error) => {
          earlyMuteError = error;
          return false;
        });
      startStage = 'find-initial-source';
      const captureSource = await this._findWindowSource(
        session.locationTitle,
        generation,
        runtimeOptions,
        {
          exactTitleOnly: true,
          returnSource: true,
          isCurrent: () => this.pending === session,
        }
      );
      if (generation !== this.generation || this.disposed) throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      session.sourceId = String(captureSource && captureSource.id || '');
      session.windowSourceId = session.sourceId;
      startStage = 'isolate-window-shell';
      await this._isolateSessionWindow(session);
      startStage = 'apply-location-audio-properties';
      const mutedBeforeCapture = await earlyMutePromise;
      if (!mutedBeforeCapture) {
        if (generation !== this.generation || this.disposed || this.pending !== session) {
          throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
        }
        await this._muteSession(session, target && target.muteProperties).catch(() => { throw earlyMuteError; });
      }
      if (generation !== this.generation || this.disposed || this.pending !== session) {
        throw runtimeError('WALLPAPER_ENGINE_START_SUPERSEDED');
      }

      this.active = session;
      if (this.pending === session) this.pending = null;
      return this._publicSession(session);
    } catch (error) {
      console.warn(`[Wallpaper Engine] native Scene start failed at ${startStage}:`, error && (error.code || error.message) || error);
      if (this.pending === session) this.pending = null;
      if (session.launched && (!this.active || this.active.sessionId !== session.sessionId)) {
        await this._closeSession(session);
      } else if (!session.launched) {
        await this._cleanupStagedProject(session);
      }
      // 失败发生在哪个阶段（discover-target / close-previous-window / open-initial-window…）是
      // 排查的第一步，以前它只进 console.warn，落盘日志里看不到，只能靠堆栈行号倒推。
      // The failing stage is the first thing to know, but it only reached console.warn before,
      // so a persisted log left nothing but a stack line number to reverse-engineer.
      if (error && typeof error === 'object' && error.startStage === undefined) {
        try { error.startStage = startStage; } catch (_) { }
      }
      if (error && error.code) throw error;
      throw runtimeError('WALLPAPER_ENGINE_START_FAILED');
    }
  }

  async stop(expectedSessionId = '') {
    if (expectedSessionId && typeof expectedSessionId === 'object') {
      expectedSessionId = expectedSessionId.sessionId || '';
    }
    expectedSessionId = String(expectedSessionId || '');
    const matchesPending = !!(this.pending && this.pending.sessionId === expectedSessionId);
    const matchesActive = !!(this.active && this.active.sessionId === expectedSessionId);
    if (expectedSessionId && !matchesPending && !matchesActive) {
      return { ok: true, stopped: false, reason: 'WALLPAPER_ENGINE_SESSION_MISMATCH' };
    }

    const sessions = [];
    if (expectedSessionId) {
      if (matchesPending) {
        sessions.push(this.pending);
      }
      if (matchesActive) {
        if (!sessions.length || sessions[0].sessionId !== this.active.sessionId) sessions.push(this.active);
      }
    } else {
      if (this.pending) sessions.push(this.pending);
      if (this.active && (!this.pending || this.active.sessionId !== this.pending.sessionId)) sessions.push(this.active);
    }
    if (!sessions.length) return { ok: true, stopped: false, active: !!this.active, sessionId: this.active ? this.active.sessionId : '' };
    // A targeted stop of the old active session must not supersede a newer
    // pending start. The per-session stopping flag is enough to cancel any
    // relaunch work for that active session. Pending/global cancellation still
    // advances the generation so their startup work cannot escape later.
    if (!expectedSessionId || matchesPending) this.generation += 1;
    for (const session of sessions) session.stopping = true;
    let allStopped = true;
    const closeNotes = [];
    for (const session of sessions) {
      const closed = await this._closeSession(session);
      const safelyCancelled = !session.launched && !session.initialOpenPromise;
      if (closed || safelyCancelled) {
        if (this.pending === session) this.pending = null;
        if (this.active === session) this.active = null;
      } else {
        allStopped = false;
        session.stopping = false;
        if (session.closeNotes) closeNotes.push(String(session.closeNotes));
        if (this.active === session) {
          this._scheduleSessionMuteReassertions(session);
          if (session.windowEmbedding && session.windowEmbedding.aligned === true
            && (session.dwmSurfaceReady !== true || !session.dwmSurfaceProcess)) {
            this._scheduleSessionDwmSurfaceRetry(session);
          }
        }
      }
    }
    // 没有任何会话在跑时，任务栏上那个 WE 条目已经不算干扰了，常驻监视器没有继续存在的
    // 理由——收掉它，省下一个常驻 PowerShell。
    // Once no session is running, the engine's taskbar entry is no longer interference and the
    // resident monitor has no reason to stay alive. Reap it instead of keeping a PowerShell around.
    if (!this.active && !this.pending) this._stopEngineWindowIsolationMonitor();
    return {
      ok: true,
      stopped: allStopped,
      active: !!this.active,
      sessionId: this.active ? this.active.sessionId : '',
      reason: allStopped ? '' : 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED',
      // 失败细节留给 start() 挂到抛出的错误上，最终进 startup-error.log。
      // Detail for start() to attach to the thrown error, which ends up in startup-error.log.
      closeNotes: allStopped ? '' : closeNotes.join(' | ').slice(0, 400),
    };
  }

  async dispose() {
    if (this.disposed) {
      return {
        ok: !this.active && !this.pending,
        stopped: !this.active && !this.pending,
        active: !!this.active,
        sessionId: this.active ? this.active.sessionId : '',
        reason: this.active || this.pending ? 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED' : '',
      };
    }
    this.disposed = true;
    // 监视器是 runtime 级的存活物，不属于任何会话：dispose 必须无条件收掉，否则会留下一个
    // 一直枚举窗口的 PowerShell。
    // The monitor is runtime-scoped and belongs to no session, so dispose must always reap it or
    // a PowerShell that keeps enumerating windows outlives the app.
    this._stopEngineWindowIsolationMonitor();
    const isClean = () => !this.active && !this.pending;
    let result = await this.stop();
    if ((!result || result.stopped !== true) && !isClean()) {
      await this.nativeSleep(180);
      result = await this.stop();
    }
    if ((!result || result.stopped !== true) && !isClean()) {
      const leftovers = [];
      if (this.pending) leftovers.push(this.pending);
      if (this.active && (!this.pending || this.active.sessionId !== this.pending.sessionId)) leftovers.push(this.active);
      for (const session of leftovers) {
        this._stopSessionPointerRelay(session);
        this._stopSessionDwmSurface(session);
        await this._waitForSessionDwmSurfaceStop(session);
        this._clearSessionMuteReassertions(session);
      }
      result = {
        ok: false,
        stopped: false,
        active: !!this.active,
        sessionId: this.active ? this.active.sessionId : '',
        reason: 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED',
      };
    } else {
      result = {
        ...(result || {}),
        ok: true,
        stopped: true,
        active: false,
        sessionId: '',
        reason: '',
      };
    }
    this.signatureCache.clear();
    this.executableCache = null;
    return result;
  }
}

module.exports = {
  WallpaperEngineRuntime,
  safeRuntimeOptions,
  readWallpaperPackageScene,
  forceSceneAudioSilent,
  nativeDwmThumbnailSurfaceScript,
};
