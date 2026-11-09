'use strict';
const { readAllCss } = require('./helpers/css-source');

// 完整桌面模式改用真实桌面壁纸后，几条接线必须一直成立：
// 1) 设置项存在且默认开启；2) 桌面模式下窗口透明、自带底色关闭；
// 3) 桌面模式期间不拉起应用内 WE 会话，退出后恢复；4) 7 个词典都有对应文案。
// The desktop-wallpaper backdrop relies on a few wirings that must stay in place:
// 1) the setting exists and defaults on, 2) the window is transparent in desktop mode and
// Mineradio's own background layers are hidden, 3) the in-app WE session never starts while
// desktop mode owns the backdrop and comes back afterwards, 4) every dictionary has the copy.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8');

const fxDefaults = read('public/js/modules/00-state/04-fx-defaults.js');
const fxSaveRead = read('public/js/modules/00-state/05a-fx-save-read.js');
const fxPersistence = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
const css = readAllCss();
const overlay = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
const weLibrary = read('public/js/modules/07-fx/03-wallpaper-engine-library.js');
const bindings = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
const main = read('desktop/main.js');
const index = read('public/index.html');

// 1) 设置项：默认开启，读写与持久化都带上它。
assert.match(fxDefaults, /desktopWallpaperBackdrop:\s*true/);
assert.match(fxSaveRead, /desktopWallpaperBackdrop:\s*raw\.desktopWallpaperBackdrop\s*!==\s*false/);
assert.match(fxPersistence, /desktopWallpaperBackdrop:\s*fx\.desktopWallpaperBackdrop\s*!==\s*false/);
assert.match(fxPersistence, /desktopWallpaperBackdrop:\s*\['desktopWallpaperBackdrop'\]/);
assert.match(index, /id="t-desktopWallpaperBackdrop"/);
assert.match(bindings, /key === 'desktopWallpaperBackdrop'/);

// 2) 透明背景：只在该组合下生效，且隐藏三块自带底色。
assert.match(css, /body\.desktop-wallpaper-mode\.desktop-backdrop-desktop\s*\{\s*background:\s*transparent/);
assert.match(css, /#custom-bg[\s\S]{0,260}display:\s*none/);
assert.match(overlay, /document\.body\.classList\.toggle\('desktop-backdrop-desktop', desktopBackdrop\)/);
assert.match(overlay, /backdrop:\s*fx\.desktopWallpaperBackdrop === false \? 'mineradio' : 'desktop'/);

// 3) WE 会话：桌面模式期间禁止启动，退出后按当前尺寸恢复；主进程同时挂起并解除挂起。
assert.match(weLibrary, /if\s*\(typeof desktopBackdropUsesDesktopWallpaper === 'function' && desktopBackdropUsesDesktopWallpaper\(\)\)\s*\{[\s\S]{0,220}WALLPAPER_ENGINE_DESKTOP_BACKDROP_ACTIVE/);
assert.match(weLibrary, /WALLPAPER_ENGINE_START_SUPERSEDED\|WALLPAPER_ENGINE_DESKTOP_BACKDROP_ACTIVE/);
assert.match(overlay, /suspendWallpaperEngineLayerForDesktopBackdrop\(\)/);
assert.match(overlay, /setTimeout\(resumeWallpaperEngineAfterDesktopMode, 420\)/);
assert.match(main, /async function suspendWallpaperEngineForDesktopBackdrop/);
assert.match(main, /await suspendWallpaperEngineForDesktopBackdrop\('full-desktop-enable'\)/);
assert.match(main, /wallpaperEngineDesktopBackdropSuspended = false;[\s\S]{0,400}wallpaperEngineHostVisibilitySuspended = false;/);
assert.match(main, /let mainDesktopBackdropKind = 'desktop'/);
assert.match(main, /function probeWallpaperEngineOwnsDesktopBackground\(\)/);
assert.match(main, /weOwnsBackground:/);
assert.doesNotMatch(main, /enable-coexist-preflight/, 'desktop enable must not pre-order the WE DWM surface');
assert.doesNotMatch(main, /function wallpaperEngineProvidesDesktopBackdrop/, 'the old DWM-backdrop probe is gone');

// 4) 七种语言的文案：标签、标题、一次性提示。
for (const lang of ['zh_cn', 'zh_tw', 'zh_hk', 'en_us', 'es_es', 'ja_jp', 'ru_ru']) {
  const dictionary = JSON.parse(read('public/locales/' + lang + '.json'));
  for (const key of ['fx_desktop_backdrop', 'fx_desktop_backdrop_title', 'fx_desktop_backdrop_hint']) {
    assert.equal(typeof dictionary[key], 'string', lang + ' is missing ' + key);
    assert.ok(dictionary[key].length > 0, lang + ' has an empty ' + key);
  }
}

console.log('OK desktop-wallpaper-backdrop');
