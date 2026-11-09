'use strict';

// 构图/界面自动存档的磁盘层。之前内联在 desktop/main.js 里，退出、托盘和桌面模式
// 都依赖它，是 Phase 1 第一个搬出来的模块。行为保持完全一致：12 MB 上限、对象校验、
// 先写 .tmp 再 rename，避免半截 JSON。

const fs = require('fs');
const path = require('path');

const FILE = 'current-fx-autosave.json';
const MAX_BYTES = 12 * 1024 * 1024;

function getPath(userDataDir) {
  return path.join(userDataDir, FILE);
}

function read(userDataDir) {
  try {
    const file = getPath(userDataDir);
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (!stat || stat.size <= 0 || stat.size > MAX_BYTES) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const payload = JSON.parse(raw);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch (e) {
    console.warn('[FxAutosave] read skipped:', e.message);
    return null;
  }
}

function write(userDataDir, payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, error: 'INVALID_AUTOSAVE_PAYLOAD' };
    }
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      return { ok: false, error: 'AUTOSAVE_PAYLOAD_TOO_LARGE' };
    }
    const file = getPath(userDataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    console.warn('[FxAutosave] write failed:', e.message);
    return { ok: false, error: e.message || 'AUTOSAVE_WRITE_FAILED' };
  }
}

module.exports = { FILE, MAX_BYTES, getPath, read, write };
