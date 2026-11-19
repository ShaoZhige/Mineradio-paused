'use strict';

// The desktop lyrics window is click-through by default. On Windows the
// middle-click unlock gesture is read by a tiny PowerShell loop because
// Electron does not expose global mouse buttons without a native hook.
// This module owns the child process lifecycle; the caller decides what a
// "middle click" means for the current window state.

// 采样周期 40ms 而不是 24ms：这个 PowerShell 循环只要桌面歌词窗口在就常驻，每拍唤醒一次线程。
// 40ms 仍然远细于人手一次中键按下（正常 80~150ms），双击判定不会漏；常驻唤醒次数则少了四成。
// `Start-Sleep` 的实际精度本来就受系统 15.6ms 计时器粒度影响，24ms 并不会更准。
// Sampling every 40 ms instead of 24: this PowerShell loop lives as long as the desktop-lyrics
// window exists and wakes a thread on every tick. 40 ms is still far finer than a real middle click
// (normally 80-150 ms), so the double-click test never misses, while the idle wake-up count drops
// by about 40%. `Start-Sleep` is quantised by the 15.6 ms system timer anyway, so 24 ms was never
// actually more precise.
const POLL_INTERVAL_MS = 40;

const POLL_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioMousePoll {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
"@
$prev = $false
while ($true) {
  $down = (([MineradioMousePoll]::GetAsyncKeyState(4) -band 0x8000) -ne 0)
  if ($down -and -not $prev) {
    [Console]::Out.WriteLine("MMB")
    [Console]::Out.Flush()
  }
  $prev = $down
  Start-Sleep -Milliseconds ${POLL_INTERVAL_MS}
}
`;

function createMiddleClickPoller(options = {}) {
  const spawn = options.spawn;
  const onMiddleClick = typeof options.onMiddleClick === 'function' ? options.onMiddleClick : () => {};
  const platform = options.platform || process.platform;
  const warn = typeof options.warn === 'function' ? options.warn : () => {};

  let child = null;
  let buffer = '';

  function handleOutput(chunk) {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach((line) => {
      if (line.trim() === 'MMB') onMiddleClick();
    });
  }

  function start() {
    if (platform !== 'win32' || child) return;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', POLL_SCRIPT], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', handleOutput);
      child.on('exit', () => {
        child = null;
        buffer = '';
      });
      child.on('error', (error) => {
        child = null;
        buffer = '';
        warn('Desktop lyrics mouse poller failed:', error && error.message || error);
      });
    } catch (error) {
      child = null;
      buffer = '';
      warn('Desktop lyrics mouse poller failed to start:', error && error.message || error);
    }
  }

  function stop() {
    if (!child) return;
    try {
      child.kill();
    } catch (_) {
      // The child may have exited on its own; nothing else to clean up.
    }
    child = null;
    buffer = '';
  }

  function isRunning() {
    return !!child;
  }

  return { start, stop, isRunning };
}

module.exports = { createMiddleClickPoller, POLL_SCRIPT };
