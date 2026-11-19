'use strict';

/**
 * 诊断日志的大小上限 / Cap the diagnostic logs.
 *
 * `wallpaper-engine-commands.log`、`startup-error.log`、`wallpaper-engine-start-timing.log` 都是
 * 纯 append，从来不删。命令日志每发一条控制命令就多一行，实测已经到 286 KB；长期用下去会变成
 * 几 MB 的文本，拖慢打开速度，也让用户按 issue 指引去拖日志时更难找。
 *
 * 做法是标准的一代轮转：超过上限就把 `x.log` 改名为 `x.1.log` 再继续写新的，历史留一份就够。
 * 关键约束是**不能给启动路径加 IO**——所以大小检查按写入量节流：累计写满 128 KB 才 stat 一次，
 * 而不是每条命令都问一次盘。
 *
 * These three diagnostic logs are pure appends with no ceiling. The command log grows a line per
 * control command and is already at 286 KB; over months it turns into megabytes of text that slows
 * down opening it and buries the lines a user was asked to attach to an issue.
 *
 * Standard single-generation rotation: rename `x.log` to `x.1.log` and keep writing. The important
 * constraint is not adding I/O to the startup path, so the size check is throttled — one stat per
 * 128 KB written instead of one per line.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
// 累计写入这么多字节之后才查一次文件大小。按命令日志的典型行长度（~60 字节）算，大约是
// 每两千条命令 stat 一次，成本可以忽略。
// Stat the file only after this many bytes have been written since the last check — roughly one
// stat per couple of thousand command lines.
const STAT_EVERY_BYTES = 128 * 1024;

const pendingBytes = new Map();

function rotateLogFile(filePath) {
  const parsed = path.parse(filePath);
  const archived = path.join(parsed.dir, `${parsed.name}.1${parsed.ext}`);
  try {
    if (fs.existsSync(archived)) fs.unlinkSync(archived);
    fs.renameSync(filePath, archived);
    // 归档完必须立刻把原文件建回来：下一次 append 虽然会自己创建，但中间这段时间里日志路径
    // 是不存在的，用户按提示去打开就会看到"文件不存在"。
    // Recreate the file right away: the next append would create it anyway, but until then the log
    // path would not exist and a user following the "attach this log" instruction finds nothing.
    fs.writeFileSync(filePath, '', 'utf8');
    return true;
  } catch (_) {
    // 改名失败（文件被别的进程占着）就退一步直接截断：宁可丢历史，也不能让它无限长。
    // If the rename fails (held open by another process), truncate instead: losing history beats
    // letting the file grow without bound.
    try { fs.truncateSync(filePath, 0); return true; } catch (_) { return false; }
  }
}

/**
 * append 一行（或一段）日志，并在文件超过上限时轮转。
 *
 * @param {string} filePath
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxBytes] 默认 4 MB；传 0 表示不设上限
 * @returns {boolean} 写入是否成功
 */
function appendLogLine(filePath, text, options = {}) {
  const target = String(filePath || '').trim();
  const body = String(text == null ? '' : text);
  if (!target || !body) return false;

  const configured = Number(options.maxBytes);
  const maxBytes = Number.isFinite(configured) ? Math.max(0, configured) : DEFAULT_MAX_BYTES;

  // 先看要不要轮转，再写 —— 这样切分点落在两条日志之间，新文件从这一条开始，历史完整。
  // Check before writing so the split lands between two records: the new file starts with this
  // entry and the archived file ends with the previous one.
  if (maxBytes && (pendingBytes.get(target) || 0) >= STAT_EVERY_BYTES) {
    pendingBytes.set(target, 0);
    try {
      if (fs.statSync(target).size > maxBytes) rotateLogFile(target);
    } catch (_) {
      // 查不到大小（文件刚好被删）不是错。
    }
  }

  try {
    fs.appendFileSync(target, body, 'utf8');
  } catch (_) {
    return false;
  }
  if (!maxBytes) return true;
  pendingBytes.set(target, (pendingBytes.get(target) || 0) + Buffer.byteLength(body, 'utf8'));
  return true;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  STAT_EVERY_BYTES,
  rotateLogFile,
  appendLogLine,
};
