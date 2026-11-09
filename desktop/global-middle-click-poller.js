'use strict';

// The desktop lyrics window is click-through by default. On Windows the
// middle-click unlock gesture is read by a tiny PowerShell loop because
// Electron does not expose global mouse buttons without a native hook.
// This module owns the child process lifecycle; the caller decides what a
// "middle click" means for the current window state.

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
  Start-Sleep -Milliseconds 24
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
