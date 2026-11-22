'use strict';

// 项目级日志。所有子系统共用一份实现：一行一个 JSON 对象，落到 userdata/<name>.log，
// 超过上限滚一份 .1。设计约束只有三条：
//   1. **绝不抛错**（日志坏了不能影响主流程）；
//   2. **写入有序**（异步 append 不保证顺序，这里用队列串起来，时间线必须可信）；
//   3. **可读**（JSON Lines：grep 得到整条事件，jq 能直接过滤字段）。
// One logging implementation for the whole app: JSON Lines per subsystem, ordered async appends,
// size-based rotation, and it never throws.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 512 * 1024;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// 渲染进程传过来的对象不可信：只留原始类型、限深限长，避免一条日志把文件撑爆。
function sanitize(value, depth) {
    depth = depth || 0;
    if (value == null) return value;
    const type = typeof value;
    if (type === 'string') return value.length > 400 ? value.slice(0, 400) + '…' : value;
    if (type === 'number') return Number.isFinite(value) ? value : null;
    if (type === 'boolean') return value;
    // 函数/符号/大整数对象没有日志价值，丢掉比塞一段源码好。
    if (type === 'function' || type === 'symbol' || type === 'bigint') return undefined;
    if (type !== 'object') return String(value).slice(0, 120);
    if (depth >= 2) return '[object]';
    if (Array.isArray(value)) return value.slice(0, 12).map(item => sanitize(item, depth + 1));
    const out = {};
    let keys = 0;
    for (const key of Object.keys(value)) {
        if (keys++ >= 20) break;
        if (!/^[A-Za-z0-9_.-]{1,48}$/.test(key)) continue;
        out[key] = sanitize(value[key], depth + 1);
    }
    return out;
}

function createLogger({ name = 'app', dir, filePath, maxBytes = DEFAULT_MAX_BYTES, level = 'info', mirrorConsole = false } = {}) {
    const target = filePath || (dir ? path.join(dir, name + '.log') : '');
    const minLevel = LEVELS[level] || LEVELS.info;
    let ready = false;
    let broken = !target;
    let bytes = 0;
    let queue = Promise.resolve();

    function rotate() {
        try { fs.renameSync(target, target + '.1'); } catch { try { fs.unlinkSync(target); } catch { } }
        bytes = 0;
    }

    function ensure() {
        if (ready || broken) return ready;
        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            try { bytes = fs.statSync(target).size; } catch { bytes = 0; }
            if (bytes > maxBytes) rotate();
            ready = true;
        } catch {
            broken = true;
        }
        return ready;
    }

    function appendLine(line) {
        if (!ensure()) return Promise.resolve();
        // 每写一行都看体积：只在首次 ensure 时判大小，跑久了就永远不滚（旧实现的坑）。
        if (bytes > maxBytes) rotate();
        bytes += Buffer.byteLength(line);
        return fs.promises.appendFile(target, line).catch(() => { });
    }

    function write(entry, entryLevel) {
        const lv = LEVELS[entryLevel] || LEVELS.info;
        if (lv < minLevel) return;
        let line;
        try {
            line = JSON.stringify(Object.assign(
                { at: new Date().toISOString(), level: entryLevel || 'info', scope: name },
                sanitize(entry) || {}
            )) + '\n';
        } catch {
            return;
        }
        if (mirrorConsole) {
            try { console[entryLevel === 'error' ? 'error' : entryLevel === 'warn' ? 'warn' : 'log']('[' + name + ']', entry); } catch { }
        }
        queue = queue.then(() => appendLine(line));
    }

    return {
        name,
        filePath: target,
        write(entry) { write(entry, (entry && entry.level) || 'info'); },
        event(type, fields, entryLevel) {
            write(Object.assign({ event: String(type || 'event') }, fields || {}), entryLevel || 'info');
        },
        info(message, fields) { write(Object.assign({ message: String(message || '') }, fields || {}), 'info'); },
        warn(message, fields) { write(Object.assign({ message: String(message || '') }, fields || {}), 'warn'); },
        error(message, fields) { write(Object.assign({ message: String(message || '') }, fields || {}), 'error'); },
        // 测试与退出前用：等队列落盘。
        flush() { return queue; },
    };
}

// 把主进程现有的 console.error / console.warn 镜像进日志文件。服务端有近百处
// `console.error('[Scope]', err)`，逐处改既不现实也容易漏；这里一次性兜住，
// 新代码仍然可以直接用 logger.event 写结构化字段。
// Mirror the existing console.error/warn calls into the log file, so the ~100 server error paths
// are persisted without touching a single call site.
function installConsoleMirror(logger) {
    if (!logger || typeof logger.event !== 'function') return () => { };
    if (installConsoleMirror.installed) return installConsoleMirror.installed;
    const originals = { error: console.error, warn: console.warn };
    const flatten = (args) => args.map((value) => {
        if (typeof value === 'string') return value;
        if (value && typeof value.message === 'string') return value.name ? value.name + ': ' + value.message : value.message;
        try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' ').slice(0, 600);
    const patch = (channel) => function (...args) {
        try { logger.event('console', { channel, message: flatten(args) }, channel === 'error' ? 'error' : 'warn'); } catch { }
        try { originals[channel].apply(console, args); } catch { }
    };
    console.error = patch('error');
    console.warn = patch('warn');
    const restore = () => {
        console.error = originals.error;
        console.warn = originals.warn;
        installConsoleMirror.installed = null;
    };
    installConsoleMirror.installed = restore;
    return restore;
}

module.exports = { createLogger, sanitize, installConsoleMirror, LEVELS, DEFAULT_MAX_BYTES };
