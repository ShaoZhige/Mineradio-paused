'use strict';

// 完整桌面模式会隐藏整条标题栏，但 ? / 更新 / 热键 / DIY 这几个工具按钮不能跟着消失：
// 它们由脚本搬到 #desktop-tools-zone（桌面控制器面板内的顶部一行），退出桌面模式再搬回标题栏。
// 最小化 / 最大化 / 关闭仍然随标题栏一起隐藏，这是桌面模式的预期。
// Full desktop mode hides the whole title bar, but the guide / update / hotkey / DIY buttons
// must survive: the script moves them into #desktop-tools-zone beside the top-right controller
// and moves them back on exit. Minimize / maximize / close stay hidden with the bar by design.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8');

const html = read('public/index.html');
const css = read('public/css/index.css');
const prefs = read('public/js/modules/00-state/02-preferences-ui-modes.js');
const shell = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');

// 1) 工具行容器存在，并且处在和桌面控制器同一层（body 直下）。
assert.match(html, /<div id="desktop-tools-zone" role="toolbar"/);
const panelMarkup = html.indexOf('id="desktop-mode-control-panel"');
assert.ok(panelMarkup >= 0 && html.indexOf('id="desktop-tools-zone"') > panelMarkup, 'tools zone must live inside the controller panel');

// 2) 搬移逻辑：桌面模式优先于全屏，退出时搬回标题栏，全屏仍在时搬回全屏工具行。
assert.match(prefs, /var desktopZone = document\.getElementById\('desktop-tools-zone'\);/);
assert.match(prefs, /var desktopMode = !!\(document\.body && document\.body\.classList\.contains\('desktop-wallpaper-mode'\)\);/);
assert.match(prefs, /var target = desktopMode && desktopZone \? desktopZone : \(isFullscreen \? zone : bar\);/);
assert.match(prefs, /if \(target !== bar\) \{[\s\S]{0,180}target\.appendChild\(node\)/);
assert.match(prefs, /if \(!desktopMode && isFullscreen\) layoutFullscreenToolsZone\(\);/);

// 3) 桌面模式状态一变就同步一次搬移。
assert.match(shell, /if \(typeof syncFullscreenToolsRow === 'function'\) \{\s*syncFullscreenToolsRow\(desktopFullscreenActive === true\);/);

// 4) 工具行收进桌面控制器面板顶部，随面板展开/收起；标题栏整条仍然隐藏。
assert.match(css, /#desktop-tools-zone \{[\s\S]{0,260}position:\s*fixed;[\s\S]{0,120}right:\s*calc\(var\(--desktop-safe-right\) \+ 70px\)/);
assert.match(css, /body\.desktop-wallpaper-mode\.desktop-wallpaper-interactive #desktop-tools-zone \{\s*display:\s*flex/);
assert.match(css, /body\.desktop-shell\.desktop-wallpaper-mode #desktop-titlebar \{\s*display:\s*none !important/);

// 5) 锁定软件操作时，工具行和桌面控制器一样属于可交互的桌面控件。
assert.match(shell, /\{ selector: '#desktop-tools-zone', kind: 'desktop-controls' \}/);

console.log('OK desktop-tools-row');

