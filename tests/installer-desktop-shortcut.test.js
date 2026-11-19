'use strict';

// 安装器桌面快捷方式勾选项回归测试
//
// 背景：package.json 里 `createDesktopShortcut` 一直是 false —— electron-builder 既不建桌面
// 快捷方式，也没有任何界面开关，用户想要图标只能自己手动建。现在由安装器的「选择安装位置」页
// 提供一个默认勾选的复选框来接管这件事，所以三处必须同时成立，缺一个就会出现「勾了没建」或
// 「没勾却建了」：
//   1. package.json 仍为 false（否则 electron-builder 会无条件下建，勾选形同虚设）
//   2. 安装段按勾选创建，静默更新不重建（用户可能故意删掉了图标）
//   3. 卸载段删除该快捷方式，别留下死链
//
// Background: `createDesktopShortcut` has always been false in package.json, so
// electron-builder neither creates a desktop shortcut nor exposes a switch. The installer's
// directory page now owns that decision through a checked-by-default checkbox, which only works
// if the three places below stay in agreement.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const installerText = fs
  .readFileSync(path.join(appRoot, 'build', 'installer.nsh'), 'utf8')
  .replace(/\r\n/g, '\n');
// 说明性注释会引用被禁止/要求的写法，所有断言只看真代码行。
// Comments quote the very patterns asserted below, so every assertion reads code lines only.
const installerCode = installerText
  .split('\n')
  .filter((line) => !/^\s*;/.test(line))
  .join('\n');

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
}

function macroSource(name) {
  const start = installerCode.indexOf(`!macro ${name}\n`);
  assert.notEqual(start, -1, `missing installer macro ${name}`);
  const end = installerCode.indexOf('!macroend', start);
  assert.notEqual(end, -1, `missing !macroend for ${name}`);
  return installerCode.slice(start, end);
}

function functionSource(name) {
  const start = installerCode.indexOf(`Function ${name}\n`);
  assert.notEqual(start, -1, `missing installer function ${name}`);
  const end = installerCode.indexOf('FunctionEnd', start);
  assert.notEqual(end, -1, `missing FunctionEnd for ${name}`);
  return installerCode.slice(start, end);
}

test('package.json keeps createDesktopShortcut off so the checkbox owns the decision', () => {
  const pkg = JSON.parse(read('package.json'));
  // 改成 true 的话 electron-builder 会自己在安装段建快捷方式，勾选框就变成摆设了。
  // With true, electron-builder creates the shortcut itself and the checkbox becomes a lie.
  assert.equal(pkg.build.nsis.createDesktopShortcut, false);
  assert.equal(pkg.build.nsis.oneClick, false);
});

test('the directory page renders a desktop-shortcut checkbox that starts checked', () => {
  const page = functionSource('MineradioDirectoryShow');
  assert.match(page, /\$\{NSD_CreateCheckbox\}\s+22u\s+116u\s+238u\s+12u\s+"在桌面创建快捷方式"/);
  assert.match(page, /Pop \$MineradioDesktopShortcutCheck/);
  assert.match(page, /\$\{If\} \$MineradioCreateDesktopShortcut == "1"/);
  assert.match(page, /\$\{NSD_Check\} \$MineradioDesktopShortcutCheck/);
  // 控件底边 = y + 8 + 高，必须留在 140 单位内，否则会被静默裁掉。
  // Bottom edge is y + 8 + height and must stay within the 140-unit page.
  assert.ok(116 + 8 + 12 <= 140, 'checkbox must fit inside the 140-unit dialog');
});

test('leaving the page reads the checkbox state back instead of tracking clicks', () => {
  const leave = functionSource('MineradioDirectoryLeave');
  assert.match(leave, /\$\{NSD_GetState\} \$MineradioDesktopShortcutCheck \$0/);
  assert.match(leave, /\$\{If\} \$0 == \$\{BST_CHECKED\}/);
  // 勾选状态必须在校验安装目录之前落进变量，Abort 重走本页时才能保持一致。
  // The state must be stored before the directory is validated so a re-entered page stays consistent.
  assert.ok(
    leave.indexOf('NSD_GetState') < leave.indexOf('Call MineradioValidateInstallDir'),
    'checkbox state must be captured before the install dir is validated'
  );
});

test('the install section creates the shortcut only when the box was ticked', () => {
  const install = macroSource('customInstall');
  assert.match(install, /\$\{If\} \$MineradioCreateDesktopShortcut == "1"/);
  assert.match(
    install,
    /CreateShortCut "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"\s*\\?\s*\n?\s*"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/,
    'shortcut must point at the installed executable'
  );
  // 不依赖 WinShell 插件：卸载器编译时的插件目录里没有它，用了会让整个包编不出来。
  // No WinShell plugin: the uninstaller compile cannot resolve it and the whole build fails.
  assert.doesNotMatch(install, /WinShell::/);
  assert.match(install, /\$\{Else\}\s*\n\s*DeleteRegValue HKCU "Software\\\$\{APP_GUID\}" DesktopShortcut/);
});

test('a silent update leaves an existing desktop icon alone', () => {
  const install = macroSource('customInstall');
  // 静默更新（/S + 已有旧版本）走「不动」分支：用户可能早就把图标删了。
  // Silent updates (already installed) take the no-op branch: the icon may be long gone.
  assert.match(install, /\$\{If\} \$\{Silent\}\s*\n\s*\$\{AndIf\} \$\{isUpdated\}/);
  assert.match(install, /DetailPrint "Keep desktop shortcut untouched \(silent update\)"/);
  assert.ok(
    install.indexOf('${isUpdated}') < install.indexOf('CreateShortCut'),
    'the update check must guard the CreateShortCut call'
  );
});

test('uninstalling removes the desktop shortcut it created', () => {
  const remove = functionSource('un.MineradioRemoveInstalledFiles');
  assert.match(remove, /\$\{If\} \$\{FileExists\} "\$DESKTOP\\\$0\.lnk"/);
  assert.match(remove, /Delete "\$DESKTOP\\\$0\.lnk"/);
  assert.doesNotMatch(remove, /WinShell::/);
  // 名字优先取 nsis.shortcutName，回退到 exe 文件名，改名后也不会漏删。
  // Prefer nsis.shortcutName and fall back to the exe filename so a rename cannot orphan the lnk.
  assert.match(remove, /StrCpy \$0 "\$\{SHORTCUT_NAME\}"/);
  assert.match(remove, /StrCpy \$0 "\$\{PRODUCT_FILENAME\}"/);
});

test('the checkbox default can be overridden from the command line', () => {
  const resolve = functionSource('MineradioResolveDesktopShortcut');
  assert.match(resolve, /StrCpy \$MineradioCreateDesktopShortcut "1"/);
  assert.match(resolve, /\$\{GetOptions\} \$R0 "\/CREATEDESKTOPSHORTCUT=" \$R1/);
  assert.match(resolve, /\$\{AndIf\} \$R1 == "0"/);
  // customInit 必须调用它，静默安装没有页面回调，变量不初始化就会是空串。
  // customInit must call it: silent installs have no page callback and would leave the var empty.
  assert.match(macroSource('customInit'), /Call MineradioResolveDesktopShortcut/);
});
