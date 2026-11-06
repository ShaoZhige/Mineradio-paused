'use strict';

// 完整桌面模式现在是「透明全屏覆盖层」：不 SetParent、不修改 Explorer 的图标 ListView，
// 桌面壁纸与图标从窗口后面透出来，因此不会再出现图标黑底。
// Full desktop mode is now a transparent full-screen overlay: no SetParent and no edits to
// Explorer's icon ListView, so the desktop wallpaper/icons show through and icons can never be
// left with a black backdrop.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8');

const main = read('desktop/main.js');
const preload = read('desktop/preload.js');
const runtime = read('desktop/full-desktop-mode-runtime.js');
const shell = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');

// 1) 主进程用覆盖层模式创建 runtime。
assert.match(main, /overlayMode: true/);
assert.match(runtime, /this\.overlayMode = options\.overlayMode === true;/);

// 2) 覆盖层分支：不 attach、不启动图标层 watcher。
assert.match(runtime, /if \(this\.overlayMode\) \{\s*this\.enabled = true;\s*this\.interactive = true;\s*this\.attachment = this\.overlayAttachment\(display\);/);
assert.match(runtime, /this\.iconLayerMode = 'transparent-overlay';/);
assert.match(runtime, /overlayAttachment\(display\) \{/);
assert.match(runtime, /startIconShapeWatcher\(display = this\.shapeDisplayForWindow\(\)\) \{\s*if \(this\.overlayMode\) return null;/);
assert.match(runtime, /async enableIconShape\(win, display, reason = 'desktop-coexist', options = \{\}\) \{\s*if \(this\.overlayMode\) return \{ ok: true, skipped: true \};/);
assert.match(runtime, /async ensureIconLayerOrder\(\) \{\s*if \(this\.overlayMode\) \{/);

// 3) 覆盖层下「显示桌面图标」只用 ShowWindow 切换可见性，不改图标样式/背景/合成方式。
assert.match(runtime, /runOverlayDesktopIconsScript\(action\) \{/);
assert.match(runtime, /if \(\$Action -eq 'hide'\) \{ \[void\]\[IconRepair\]::ShowWindow\(\$list, 0\) \}/);
assert.match(runtime, /if \(\$Action -eq 'show'\) \{ \[void\]\[IconRepair\]::ShowWindow\(\$list, 5\) \}/);
assert.doesNotMatch(runtime.slice(
  runtime.indexOf('runOverlayDesktopIconsScript(action) {'),
  runtime.indexOf('probeOverlayDesktopIconsVisible()')
), /\[IconRepair\]::SetWindowLongPtr\(|\[IconRepair\]::SendMessageTimeout\(/, 'overlay icon visibility must not touch icon styles/compositing');
assert.match(runtime, /this\.desktopIconsVisible === false && this\.overlayIconsOriginalVisible === true/);
assert.match(runtime, /this\.writeOverlayIconsMarker\(this\.desktopIconsVisible === false/);
assert.match(runtime, /overlayIconsOriginalVisible/);

// 4) 进入/退出/鼠标锁定都走覆盖层分支。
assert.match(runtime, /async disableInternal\(reason = 'disabled', preservedError = null\) \{\s*if \(this\.overlayMode\) return this\.disableOverlayInternal\(reason, preservedError\);/);
assert.match(runtime, /async disableOverlayInternal\(reason = 'disabled', preservedError = null\) \{/);
assert.match(runtime, /this\.attachment\.kind === 'icon-host' \|\| this\.attachment\.kind === 'overlay'/);

// 4b) 「图标显示在界面上方」：只给图标层加 WS_EX_TRANSPARENT（命中测试），不改外观。
assert.match(runtime, /this\.overlayIconsAbove = false;/);
assert.match(runtime, /async setOverlayIconsAbove\(value, reason = 'desktop-icons-above-changed'\) \{/);
assert.match(runtime, /runIconLayerHitTestScript\(action\) \{/);
assert.match(runtime, /if\(\$Action -eq 'off'\)\{ \[void\]\[MineradioIconHitTest\]::SetWindowLongPtr\(\$list,-20,\[IntPtr\]\(\$ex -bor 0x20\)\) \}/);
assert.match(runtime, /if\(\$Action -eq 'on'\)\{ \[void\]\[MineradioIconHitTest\]::SetWindowLongPtr\(\$list,-20,\[IntPtr\]\(\$ex -band \(-bnot 0x20\)\)\) \}/);
const hitTestBody = runtime.slice(
  runtime.indexOf('runIconLayerHitTestScript(action) {'),
  runtime.indexOf('async setOverlayIconsAbove(')
);
assert.doesNotMatch(hitTestBody, /LVM_SETBKCOLOR|0x00080000/, 'icons-above must not touch icon styles/background');
assert.match(preload, /setDesktopIconsAbove: \(above\) => ipcRenderer\.invoke\('mineradio-full-desktop-set-icons-above'/);
assert.match(main, /ipcMain\.handle\('mineradio-full-desktop-set-icons-above'/);
assert.match(shell, /desktop-icons-above-toggle/);
// 7 个语言都补齐了层级开关的文案（parity）。
for (const file of ['en_us', 'es_es', 'ja_jp', 'ru_ru', 'zh_cn', 'zh_hk', 'zh_tw']) {
  const locale = JSON.parse(read(`public/locales/${file}.json`));
  for (const key of ['dc_icons_above', 'dc_icons_above_on', 'dc_icons_above_off', 'dc_icons_above_failed']) {
    assert.ok(locale[key], `${file} missing ${key}`);
  }
}

// 5) 启动时的图标层残留修复仍然保留，负责清理旧版本可能留下的黑底状态。
assert.match(main, /function repairLeakedDesktopIconLayer\(\)/);

console.log('OK desktop-overlay-mode');
