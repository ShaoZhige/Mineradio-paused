'use strict';

/**
 * Spotify 客户端通道的运行日志。
 *
 * 为什么单独开一份：这条链路（拉起客户端 → 随机调试端口 → 注入桥 → 窗口守卫）出问题时，
 * 症状全在"另一台机器上"，靠用户口述根本定位不了 —— issue #1 的"多出一块黑窗"就是典型：
 * 我这边隐藏启动连窗口都不创建，用户那边却挂着一块黑布，两边唯一能对上的东西就是日志。
 * 这份日志只记录**状态变化**（拉起、端口、窗口守卫命中、通道断/恢复、命令失败），
 * 不记录每首歌、每次进度更新，避免变成噪声。
 *
 * A dedicated diagnostic log for the local Spotify client channel. Every symptom in this path
 * happens on somebody else's machine, so the only thing both sides can compare is a log. It
 * records state transitions only — launch, port, guard hits, channel loss/recovery, command
 * failures — never per-track or per-tick noise.
 *
 * 未 configure（例如在测试里 require 这个模块）时全部是空操作，不写文件。
 * Every call is a no-op until configure() hands over a directory, so unit tests write nothing.
 */

const path = require('path');
const { appendLogLine } = require('./log-rotation');

const LOG_FILE_NAME = 'spotify-client.log';
const MAX_FIELD_CHARS = 200;

let logFilePath = '';

function configure(options) {
  const dir = String((options && options.dir) || '').trim();
  logFilePath = dir ? path.join(dir, LOG_FILE_NAME) : '';
  return logFilePath;
}

function logSpotifyClientPath() {
  return logFilePath;
}

// 值必须能安全地放进一行 key=value：压掉换行/制表符，长错误串截断。
// Values must survive a single-line key=value record: flatten whitespace, cap the length.
function formatField(value) {
  const text = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length > MAX_FIELD_CHARS ? text.slice(0, MAX_FIELD_CHARS) + '…' : text;
}

function spotifyClientLog(event, details) {
  const target = logFilePath;
  const name = formatField(event);
  if (!target || !name) return false;
  const fields = [];
  if (details && typeof details === 'object') {
    for (const key of Object.keys(details)) {
      const value = details[key];
      if (value === undefined || value === null || value === '') continue;
      const text = formatField(value);
      if (!text) continue;
      fields.push(String(key) + '=' + text);
    }
  }
  const stamp = new Date().toISOString();
  return appendLogLine(target, stamp + '  ' + name + (fields.length ? '  ' + fields.join('  ') : '') + '\n');
}

module.exports = {
  LOG_FILE_NAME,
  configure,
  logSpotifyClientPath,
  spotifyClientLog,
};
