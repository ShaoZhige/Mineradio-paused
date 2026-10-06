'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
const quickCheckText = fs.readFileSync(path.join(appRoot, 'scripts', 'quick-check.js'), 'utf8');

test('startup QA isolates its disposable userData away from the real profile', () => {
  assert.match(mainText, /MINERADIO_STARTUP_QA_USER_DATA/);
  assert.match(mainText, /MINERADIO_STARTUP_QA_HIDDEN !== '1'/);
  assert.match(mainText, /path\.isAbsolute\(value\)/);
  // QA 的临时 userData 仍必须优先于便携数据根，否则测试会污染真实 profile。
  // The disposable QA userData still has to win over the portable root, or the QA run would
  // pollute the real profile.
  assert.match(mainText, /if \(STARTUP_QA_USER_DATA_PATH\) return STARTUP_QA_USER_DATA_PATH/);
  assert.match(quickCheckText, /path\.join\(process\.env\.TEMP \|\| appData, 'mineradio-startup-qa'\)/);
  assert.match(quickCheckText, /MINERADIO_STARTUP_QA_USER_DATA:\s*qaUserData/);
  assert.match(quickCheckText, /removeOwnedStartupQaDirectory\(qaUserData, qaUserDataParent, runtimeName\)/);
});

test('app-owned data stays inside the application folder', () => {
  // 便携数据根固定在软件目录内；只读安装目录才退回用户配置目录。
  // The portable data root is fixed inside the app folder; only a read-only install folder
  // falls back to the user profile.
  assert.match(mainText, /const PORTABLE_USER_DATA_PATH = path\.join\(APP_ROOT_PATH, 'userdata'\)/);
  assert.match(mainText, /const APP_ROOT_PATH = path\.join\(__dirname, '\.\.'\)/);
  assert.match(mainText, /\[PortableData\] app folder is not writable/);

  const cacheRootBody = (mainText.match(/function defaultCacheRootPath\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert.match(cacheRootBody, /return path\.join\(app\.getPath\('userData'\), 'cache'\)/);
  assert.doesNotMatch(cacheRootBody, /[A-Za-z]:\\/, 'the default cache root must not point at a drive root');

  // 登录凭证导出必须落回软件目录内，不再碰桌面。
  // The cookie export must land back inside the app folder and never touch the desktop.
  assert.match(mainText, /const exportDir = path\.join\(STABLE_USER_DATA_PATH, 'exports'\)/);

  // 桌面只剩「用户显式要求」的快捷方式这一条写入路径：它必须先经过 opt-in 判定，
  // 且打包版不再自动创建。安装器同样不得创建桌面快捷方式。
  // The opt-in shortcut is the only remaining desktop write: it must sit behind the guard,
  // a packaged build must no longer create one on its own, and neither should the installer.
  const desktopWriteLines = mainText.split('\n').filter((line) => /path\.join\(app\.getPath\('desktop'\)/.test(line));
  assert.equal(desktopWriteLines.length, 1, 'the opt-in shortcut must be the only desktop write left');
  const ensureShortcutBody = (mainText.match(/function ensureDesktopShortcut\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert.match(ensureShortcutBody, /if \(!shouldEnsureDesktopShortcut\(\)\) return \{ ok: false, skipped: true \}/);
  assert.match(ensureShortcutBody, /path\.join\(app\.getPath\('desktop'\)/);
  const shortcutGuardBody = (mainText.match(/function shouldEnsureDesktopShortcut\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert.match(shortcutGuardBody, /MINERADIO_CREATE_DESKTOP_SHORTCUT === '1'/);
  assert.doesNotMatch(shortcutGuardBody, /app\.isPackaged/, 'a packaged build must not create a desktop shortcut on its own');
  assert.match(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'), /"createDesktopShortcut":\s*false/);
  assert.match(fs.readFileSync(path.join(appRoot, 'electron-builder.internal-beta.json'), 'utf8'), /"createDesktopShortcut":\s*false/);

  // 数据根落在仓库内，因此必须被 git 忽略：否则一次 git add -A 就会把 cookie 和登录分区推上去。
  // The data root sits inside the working tree, so git has to ignore it; otherwise a single
  // `git add -A` would push the user's cookies and login partitions to the remote.
  assert.match(fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8'), /^userdata\/\s*$/m);

  // 原生脚本兜底也必须留在软件目录内；只有软件目录不可写时才允许退到用户配置目录。
  // The native script fallback stays inside the app folder too, and only a non-writable app
  // folder may push it to the user profile.
  const portablePathsText = fs.readFileSync(path.join(appRoot, 'desktop', 'portable-paths.js'), 'utf8');
  assert.match(portablePathsText, /APP_NATIVE_TEMP_PATH = path\.join\(APP_ROOT_PATH, 'userdata', 'cache', 'native-helper-temp'\)/);
  assert.match(portablePathsText, /\[PortableData\] app native temp folder is not writable/);
  for (const file of ['app-memory.js', 'system-memory.js', 'wallpaper-engine-runtime.js', 'desktop-native-icon-layer-runtime.js']) {
    const text = fs.readFileSync(path.join(appRoot, 'desktop', file), 'utf8');
    assert.match(text, /portablePaths\.resolveNativeTempDir\(\)/, `${file} must use the app-folder native temp fallback`);
    assert.doesNotMatch(text, /'Mineradio',\s*'native-helper-temp'/, `${file} must not rebuild a user-profile helper temp path`);
  }
});
