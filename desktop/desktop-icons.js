'use strict';

// 桌面图标层恢复：绕过 Electron，直接用 PowerShell 查 Progman/DefView/SysListView32，
// 清掉历史遗留的 WS_EX_LAYERED/WS_EX_TRANSPARENT，并在桌面视图消失时重启 Explorer。
// 从 desktop/main.js 搬出来，行为保持不变；tempDir 由调用方传入，便于测试与打包。

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const MARKER_NAME = 'mineradio-desktop-icons-hidden.flag';

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDesktopIconRepairScript(iconsHiddenByUs) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class MineradioIconLeakRepair {',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);',
    '  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);',
    '  [DllImport("user32.dll", EntryPoint="SetWindowLongPtr")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);',
    '  [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr r, bool e);',
    '  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '}',
    '"@',
    "$forceShow = '" + (iconsHiddenByUs ? '1' : '0') + "'",
    "$progman=[MineradioIconLeakRepair]::FindWindow('Progman',$null)",
    '$defview=[IntPtr]::Zero',
    'if($progman -ne [IntPtr]::Zero){$defview=[MineradioIconLeakRepair]::FindWindowEx($progman,[IntPtr]::Zero,"SHELLDLL_DefView",$null)}',
    'if($defview -eq [IntPtr]::Zero){$w=[IntPtr]::Zero; do{$w=[MineradioIconLeakRepair]::FindWindowEx([IntPtr]::Zero,$w,"WorkerW",$null); if($w -ne [IntPtr]::Zero){$defview=[MineradioIconLeakRepair]::FindWindowEx($w,[IntPtr]::Zero,"SHELLDLL_DefView",$null)}}while($w -ne [IntPtr]::Zero -and $defview -eq [IntPtr]::Zero)}',
    'if($defview -eq [IntPtr]::Zero){return}',
    '$list=[MineradioIconLeakRepair]::FindWindowEx($defview,[IntPtr]::Zero,"SysListView32",$null)',
    'if($list -eq [IntPtr]::Zero){return}',
    '$ex=[MineradioIconLeakRepair]::GetWindowLongPtr($list,-20).ToInt64()',
    '$layered=($ex -band 0x00080000) -ne 0',
    '$transparent=($ex -band 0x20) -ne 0',
    '$bg=[IntPtr]::Zero',
    '[void][MineradioIconLeakRepair]::SendMessageTimeout($list,0x1000,[IntPtr]::Zero,[IntPtr]::Zero,2,2000,[ref]$bg)',
    "if(-not $layered -and -not $transparent -and $bg.ToInt64() -ne 0 -and $forceShow -ne '1'){return}",
    'if($layered -or $transparent){[void][MineradioIconLeakRepair]::SetWindowLongPtr($list,-20,[IntPtr](($ex -band (-bnot 0x00080000)) -band (-bnot 0x20)))}',
    '$r=[IntPtr]::Zero',
    '[void][MineradioIconLeakRepair]::SendMessageTimeout($list,0x1001,[IntPtr]::Zero,[IntPtr](-1),2,2000,[ref]$r)',
    "if($forceShow -eq '1'){[void][MineradioIconLeakRepair]::ShowWindow($list,5)}",
    '[void][MineradioIconLeakRepair]::InvalidateRect($list,[IntPtr]::Zero,$true)',
    '[void][MineradioIconLeakRepair]::UpdateWindow($list)',
    '"ICON_LAYER_REPAIRED layered=$layered transparent=$transparent shown=$forceShow"',
  ].join('\n').replace(/\n/g, '\r\n');
  return script;
}

function runDesktopIconRecoveryScript(script, tempDir) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
      env: { ...process.env, TEMP: tempDir, TMP: tempDir },
    }, (error, stdout, stderr) => {
      const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      resolve({ error, line, stderr: String(stderr || '') });
    });
  });
}

async function restartExplorerForDesktopIcons() {
  await new Promise((resolve) => {
    execFile('taskkill', ['/f', '/im', 'explorer.exe'], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
  await sleepMs(800);
  try {
    const child = spawn('explorer.exe', [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (_) { }
  // Explorer needs a moment to recreate SHELLDLL_DefView / SysListView32.
  await sleepMs(3200);
}

async function repairLeakedDesktopIconLayer(tempDir) {
  if (process.platform !== 'win32') return false;
  const iconsHiddenMarker = path.join(tempDir, MARKER_NAME);
  let iconsHiddenByUs = false;
  try { iconsHiddenByUs = fs.existsSync(iconsHiddenMarker); } catch (_) { }

  let result = await runDesktopIconRecoveryScript(buildDesktopIconRepairScript(iconsHiddenByUs), tempDir);
  if (!result.line && iconsHiddenByUs) {
    // The desktop view itself is gone (Explorer crashed or was killed while the icons were
    // hidden), so ShowWindow cannot reach it. Rebuild the shell, then retry once.
    console.warn('[FullDesktopMode] desktop icon host missing; restarting Explorer to restore icons');
    await restartExplorerForDesktopIcons();
    result = await runDesktopIconRecoveryScript(buildDesktopIconRepairScript(true), tempDir);
  }
  if (result.error) console.warn('[FullDesktopMode] icon layer leak repair failed:', result.error.message || result.error);
  if (result.line) console.log('[FullDesktopMode] icon layer leak repair:', result.line);
  else if (iconsHiddenByUs) console.warn('[FullDesktopMode] icon layer leak repair produced no output:', result.stderr.slice(-200));

  const restored = /ICON_LAYER_REPAIRED/.test(result.line);
  if (!iconsHiddenByUs || restored) {
    try { fs.unlinkSync(iconsHiddenMarker); } catch (_) { }
  } else {
    console.warn('[FullDesktopMode] desktop icons may still be hidden; keeping marker for the next start');
  }
  return restored;
}

module.exports = {
  MARKER_NAME,
  buildDesktopIconRepairScript,
  runDesktopIconRecoveryScript,
  restartExplorerForDesktopIcons,
  repairLeakedDesktopIconLayer,
};
