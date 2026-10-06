'use strict';

/**
 * 便携路径兜底解析 / Portable path fallbacks.
 *
 * 运行期所有原生 helper 脚本、.ps1、scene stage 都要落在软件目录内的 native 临时区。
 * 正常启动时 desktop/main.js 已经把 MINERADIO_NATIVE_TEMP_DIR 注入到 process.env，
 * 但各子模块仍需要一条自己的兜底路径：万一环境变量丢了（单独 require 模块做测试、
 * 子进程继承出错、配置被清空），兜底也要落回软件目录，绝不能悄悄往 %LOCALAPPDATA%
 * 或 os.tmpdir() 里写东西。
 *
 * Helper scripts, .ps1 files and scene stages all belong inside the app folder's native temp
 * area. main.js injects MINERADIO_NATIVE_TEMP_DIR at startup, but each module still needs its
 * own fallback: if the variable is ever lost (a module required standalone in tests, a
 * mis-inherited child process, a wiped config), the fallback must stay inside the app folder
 * instead of quietly writing to %LOCALAPPDATA% or os.tmpdir().
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// desktop/ 的上一级就是软件目录；userdata/cache/native-helper-temp 与主进程默认缓存根一致。
// desktop/'s parent is the app folder; the location matches the main process default cache root.
const APP_ROOT_PATH = path.join(__dirname, '..');
const APP_NATIVE_TEMP_PATH = path.join(APP_ROOT_PATH, 'userdata', 'cache', 'native-helper-temp');

function isUsableDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function envNativeTempDir() {
  const configured = String(process.env.MINERADIO_NATIVE_TEMP_DIR || '').trim();
  return configured ? path.resolve(configured) : '';
}

/**
 * 解析原生临时目录。
 * Resolves the native temp directory.
 *
 * 优先级 / Order: 显式环境变量 → 软件目录内 userdata/cache/native-helper-temp → 用户配置目录。
 * 只有软件目录不可写（只读安装位置）时才允许退到用户配置目录，并留下告警。
 * The user profile is only used when the app folder is not writable (read-only install), and it
 * always leaves a warning behind.
 */
function resolveNativeTempDir() {
  const configured = envNativeTempDir();
  if (configured) return configured;
  if (isUsableDirectory(APP_NATIVE_TEMP_PATH)) return APP_NATIVE_TEMP_PATH;
  const fallback = path.join(
    process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir(),
    'Mineradio',
    'native-helper-temp'
  );
  console.warn('[PortableData] app native temp folder is not writable, falling back to the user profile:', fallback);
  return fallback;
}

module.exports = {
  APP_ROOT_PATH,
  APP_NATIVE_TEMP_PATH,
  envNativeTempDir,
  resolveNativeTempDir,
};
