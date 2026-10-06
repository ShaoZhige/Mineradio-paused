'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const portablePaths = require('./portable-paths');

const isWin = process.platform === 'win32';

function getMemorySnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total > free ? total - free : 0;
  return {
    platform: process.platform,
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    totalMB: Math.round(total / 1048576),
    freeMB: Math.round(free / 1048576),
    usedMB: Math.round(used / 1048576),
    usedPercent: total > 0 ? Math.round(used * 100 / total) : 0,
    process: {
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    },
  };
}

function tempScriptPath() {
  // 临时脚本优先落在软件目录内的 native 临时区，避免往 %TEMP% 散落 helper 脚本；
  // 环境变量丢失时兜底同样走软件目录，不会退回 os.tmpdir()。
  // Prefer the app's own native temp folder so helper scripts never scatter into %TEMP%, and
  // keep the fallback inside the app folder too instead of dropping back to os.tmpdir().
  const root = portablePaths.resolveNativeTempDir();
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  return path.join(root, 'mineradio-app-trim-' + process.pid + '-' + Date.now() + '.ps1');
}

function safeUnlink(filePath) {
  try { if (filePath) fs.unlinkSync(filePath); } catch (e) {}
}

function trimAppWorkingSets(pids) {
  if (!isWin) return Promise.resolve({ ok: true, unsupported: true, trimmed: 0, scope: 'app' });
  const list = Array.isArray(pids)
    ? pids.filter((pid) => Number.isFinite(Number(pid)) && Number(pid) > 0).map((pid) => Math.round(Number(pid)))
    : [];
  const pidLiteral = (list.length ? Array.from(new Set(list)) : [process.pid]).join(',');
  const scriptPath = tempScriptPath();
  const script = [
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class MineradioTrim {',
    '  [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);',
    '  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);',
    '  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
    '  public static int TrimMany(int[] pids) {',
    '    int n = 0;',
    '    foreach (int pid in pids) {',
    '      IntPtr h = OpenProcess(0x0500, false, pid);',
    '      if (h == IntPtr.Zero) continue;',
    '      try { if (EmptyWorkingSet(h)) n++; } finally { CloseHandle(h); }',
    '    }',
    '    return n;',
    '  }',
    '}',
    '\'@',
    '$pids = @(' + pidLiteral + ')',
    '$trimmed = [MineradioTrim]::TrimMany([int[]]$pids)',
    'Write-Output (@{ ok=$true; trimmed=$trimmed; scope="app"; pids=$pids } | ConvertTo-Json -Compress)',
  ].join('\r\n');
  fs.writeFileSync(scriptPath, script, 'utf8');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      safeUnlink(scriptPath);
      if (error) {
        resolve({ ok: false, error: error.message || 'APP_MEMORY_TRIM_FAILED', scope: 'app' });
        return;
      }
      try {
        const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
        resolve(text ? JSON.parse(text) : { ok: true, trimmed: 0, scope: 'app' });
      } catch (parseError) {
        resolve({ ok: false, error: parseError.message || 'APP_MEMORY_TRIM_PARSE_FAILED', scope: 'app' });
      }
    });
  });
}

module.exports = {
  getMemorySnapshot,
  trimAppWorkingSets,
};
