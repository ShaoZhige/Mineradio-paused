'use strict';

/**
 * 清理 native 临时区里的残留脚本 / Prune stale helper scripts from the native temp area.
 *
 * 有三处会往 native 临时区写「每次唯一命名」的 PowerShell 脚本：
 *   - desktop-native-icon-layer-runtime.js  `mineradio-native-icon-layer-<pid>-<ts>-<hex>.ps1`
 *   - spotify-client-probe.js               `mineradio-spotify-probe-<pid>-<ts>.ps1`
 *   - system-memory.js                      `mineradio-<label>-<pid>-<ts>.ps1|json`
 * 它们都只在回调 / 退出时删一次。应用被强杀、渲染进程崩溃、机器断电，删除那一步就没跑到，
 * 文件会永久留在 userdata\cache\native-helper-temp 里越堆越多。
 *
 * 这里做的只有一件事：启动时按「文件名形状 + 年龄」扫一遍，删掉确定是残留的那些。
 * 判据刻意收得很紧 —— 名字必须长得像 `mineradio-<label>-<pid>-<13 位毫秒时间戳>`，扩展名必须
 * 是 .ps1 / .json，且 mtime 早于阈值。这样两类"正常存在的文件"绝不会被误删：
 *   - `mineradio-desktop-icons-visibility.ps1` 固定名、每次覆盖写，不含 pid-时间戳；
 *   - `wallpaper-engine-*.ps1` 按内容摘要命名，是有意复用缓存，前缀也不同。
 *
 * Three modules write uniquely named PowerShell helpers into the native temp area, and each
 * removes its own file exactly once (in a callback or on exit). A forced kill, a renderer crash
 * or a power cut skips that step and the file stays forever. This module prunes those leftovers at
 * startup only when both the file-name shape and the age say so, so deliberately reused caches
 * (`wallpaper-engine-*.ps1`, digest-named) and fixed-name scratch files are never touched.
 */

const fs = require('fs');
const path = require('path');

// 残留判定阈值：比任何一次 helper 调用都长得多（最长的 PowerShell 调用超时是 60s），
// 又短到不会让文件堆过夜。同一个 native 临时区被两个实例共用时，这条也防止误删对方正在跑的脚本。
// A stale-file threshold: far longer than any single helper call (the longest PowerShell timeout
// is 60 s), short enough that nothing survives overnight. It also prevents one instance from
// deleting a script another instance is still running out of the shared temp area.
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

// 只认「每次唯一命名」的形状：mineradio-<label>-<pid>-<13 位毫秒时间戳>[-<hex>].(ps1|json)
// 时间戳强制 13 位（2001 ~ 2286 年有效），pid 至少 3 位，避免把 `mineradio-foo-1-2.ps1`
// 这种有人手写的名字也当成残留。图标层的随机后缀允许为空串（`Math.random()` 理论上可以是 0，
// 那时文件名会留下一个孤零零的 `-`）。
// Only the "unique per run" shape: a 13-digit epoch-ms timestamp and a 3+ digit pid. The icon
// layer's random suffix may be empty, which leaves a lone trailing `-` in the name.
const UNIQUE_HELPER_NAME = /^mineradio-[a-z0-9][a-z0-9-]*-\d{3,}-\d{13}(?:-[0-9a-f]*)?\.(?:ps1|json)$/;

function isStaleHelperName(fileName) {
  return UNIQUE_HELPER_NAME.test(String(fileName || ''));
}

/**
 * 扫一遍目录，删掉确定是残留的 helper 脚本。
 *
 * @param {string} directory native 临时区目录
 * @param {object} [options]
 * @param {number} [options.maxAgeMs] 超过这个年龄才删，默认 10 分钟
 * @param {number} [options.now] 当前时间（测试注入）
 * @returns {{scanned:number, removed:string[], kept:number, failed:string[]}}
 */
function pruneStaleNativeTempScripts(directory, options = {}) {
  const dir = String(directory || '').trim();
  const result = { scanned: 0, removed: [], kept: 0, failed: [] };
  if (!dir) return result;

  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Math.max(0, Number(options.maxAgeMs))
    : DEFAULT_MAX_AGE_MS;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    // 目录还没建出来是最常见的情况（首次启动），交给调用方的 mkdir，这里不算错。
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isStaleHelperName(entry.name)) continue;
    result.scanned += 1;
    const filePath = path.join(dir, entry.name);
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch (_) {
      result.failed.push(entry.name);
      continue;
    }
    if (now - stats.mtimeMs < maxAgeMs) {
      result.kept += 1;
      continue;
    }
    try {
      fs.unlinkSync(filePath);
      result.removed.push(entry.name);
    } catch (_) {
      // 正在被别的进程占用、权限不足 —— 都不该让启动流程失败，留给下一次启动。
      result.failed.push(entry.name);
    }
  }
  return result;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  isStaleHelperName,
  pruneStaleNativeTempScripts,
};
