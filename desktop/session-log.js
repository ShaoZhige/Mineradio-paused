'use strict';

/**
 * 每次运行一个日志文件 / one log file per app run.
 *
 * 需求：打开和退出都留一份日志，文件按「开始记录的时间」命名，最多保留最近 50 份，
 * 攒满后删最旧的一份。原来所有会话都往 `userdata/app.log` 里追加，只在超过 512 KB 时
 * 滚一份 `.1` —— 那既分不清是哪一次运行，也无法回答「上次退出前发生了什么」。
 *
 * 落点：`<userData>/logs/2026-11-21_23-54-07.log`（本地时间，文件名即时间序）。
 * 每次启动写一行 `session/start`，退出写一行 `session/end`；超过上限在启动时清最旧的。
 * 所有函数都不抛错 —— 日志系统坏了不能拦住启动，也不能拦住退出。
 *
 * One file per run named by local start time, a start/end record inside, and at most
 * `MAX_SESSION_LOGS` files kept (oldest pruned at startup). Nothing here ever throws.
 */

const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR_NAME = 'logs';
const MAX_SESSION_LOGS = 50;
// 会话文件按时间命名，不走大小轮转；给一个够大的上限只是兜底，避免一天不关的实例
// 无限增长（正常情况下永远碰不到，碰到时 createLogger 会滚 .1，不影响保留策略）。
// Size rotation is a last-resort guard only; the retention policy is by file count.
const SESSION_LOG_MAX_BYTES = 32 * 1024 * 1024;

// 只认自己写的文件名，别的文件（.1 归档、用户手动放进来的东西）一律不动。
// Only touch files this module created.
const SESSION_LOG_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?\.log$/;

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

// 2026-11-21_23-54-07 —— 本地时间，含秒，同一天多次启动也不会撞名。
function sessionStamp(date) {
  const d = date instanceof Date ? date : new Date();
  const day = [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join('-');
  const time = [pad2(d.getHours()), pad2(d.getMinutes()), pad2(d.getSeconds())].join('-');
  return day + '_' + time;
}

function listSessionLogs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // 文件名本身即时间序，字符串排序等价于时间排序（同年同月同日、固定宽度）。
  return names.filter((name) => SESSION_LOG_PATTERN.test(name)).sort();
}

/**
 * 只保留最近 keep 份，返回被删掉的文件名。
 * @param {string} dir
 * @param {number} [keep]
 * @returns {string[]}
 */
function pruneSessionLogs(dir, keep = MAX_SESSION_LOGS) {
  const limit = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : MAX_SESSION_LOGS;
  const names = listSessionLogs(dir);
  const excess = names.length - limit;
  if (excess <= 0) return [];
  const removed = [];
  for (let index = 0; index < excess; index += 1) {
    const name = names[index];
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // 删不掉（被杀软占着之类）就留着：下次启动还会再试，不能因此中断启动。
    }
  }
  return removed;
}

function appendRecord(filePath, payload) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(payload) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 把升级前遗留的 `userdata/app.log` 收进 logs/，用它的最后修改时间当名字。
 * 不这么做的话它会永远停在 userdata 根目录：既不在保留策略里，也没人再写它。
 * Adopt the pre-upgrade `userdata/app.log` so it does not sit in the userData root forever.
 */
function adoptLegacyAppLog(logDir, legacyFile) {
  try {
    const stat = fs.statSync(legacyFile);
    if (!stat.isFile()) return '';
    if (stat.size === 0) {
      try { fs.unlinkSync(legacyFile); } catch { }
      return '';
    }
    const base = sessionStamp(stat.mtime);
    let target = path.join(logDir, base + '.log');
    let suffix = 1;
    while (fs.existsSync(target)) target = path.join(logDir, base + '-' + suffix++ + '.log');
    fs.renameSync(legacyFile, target);
    return target;
  } catch {
    return '';
  }
}

/**
 * 开始一次会话的日志文件。
 *
 * @param {object} options
 * @param {string} options.userDataDir  userdata 根目录（logs/ 建在它下面）
 * @param {number} [options.pid]
 * @param {object} [options.meta]       额外写进 session/start 的字段
 * @param {number} [options.maxSessionLogs]
 * @param {Date}   [options.now]        测试注入
 * @returns {{ ok: boolean, dir: string, filePath: string, fileName: string, removed: string[],
 *            finish: (status?: string, extra?: object) => boolean }}
 */
function beginSessionLog(options = {}) {
  const userDataDir = String(options.userDataDir || '').trim();
  const empty = {
    ok: false,
    dir: '',
    filePath: '',
    fileName: '',
    removed: [],
    finish() { return false; },
  };
  if (!userDataDir) return empty;

  const logDir = path.join(userDataDir, LOG_DIR_NAME);
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    return empty;
  }

  adoptLegacyAppLog(logDir, path.join(userDataDir, 'app.log'));

  const stamp = sessionStamp(options.now);
  let filePath = path.join(logDir, stamp + '.log');
  let fileName = stamp + '.log';
  let suffix = 1;
  while (fs.existsSync(filePath)) {
    fileName = stamp + '-' + suffix++ + '.log';
    filePath = path.join(logDir, fileName);
  }

  const startedAt = new Date();
  const header = Object.assign({
    at: startedAt.toISOString(),
    level: 'info',
    scope: 'app',
    event: 'session/start',
    pid: Number(options.pid) || process.pid,
    file: fileName,
  }, options.meta && typeof options.meta === 'object' ? options.meta : {});
  appendRecord(filePath, header);

  // 先建文件再清旧文件：万一清理出问题，至少这次的日志已经落盘。
  const removed = pruneSessionLogs(logDir, options.maxSessionLogs);

  let finished = false;
  function finish(status = 'quit', extra = {}) {
    if (finished) return false;
    finished = true;
    const endedAt = new Date();
    return appendRecord(filePath, Object.assign({
      at: endedAt.toISOString(),
      level: 'info',
      scope: 'app',
      event: 'session/end',
      status: String(status || 'quit'),
      uptimeMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      removedOnStart: removed.length,
    }, extra && typeof extra === 'object' ? extra : {}));
  }

  return { ok: true, dir: logDir, filePath, fileName, removed, finish };
}

module.exports = {
  LOG_DIR_NAME,
  MAX_SESSION_LOGS,
  SESSION_LOG_MAX_BYTES,
  SESSION_LOG_PATTERN,
  sessionStamp,
  listSessionLogs,
  pruneSessionLogs,
  beginSessionLog,
  adoptLegacyAppLog,
};
