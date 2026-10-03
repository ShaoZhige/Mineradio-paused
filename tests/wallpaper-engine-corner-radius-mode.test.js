'use strict';

// 原生 WE 窗口圆角与软件窗口外壳的一致性回归测试（#471）
//
// 症状：更新后 Wallpaper Engine 壁纸的四角不再跟随软件窗口的圆角。
// 根因：index.css 里 `body.desktop-shell.desktop-maximized/-fullscreen/-wallpaper-mode
// #desktop-window-shell` 会把窗口外壳的圆角与裁剪清零（壁纸模式整屏铺满，本就该是直角）。
// 主进程 wallpaperEngineHostCornerRadius() 只对齐了最大化/全屏，漏了「桌面壁纸模式」：
// 该模式下 Electron 窗口被挂进资源管理器的 WorkerW，既不算最大化也不算全屏，于是应用侧画直角、
// 原生壁纸窗口仍被切成 34px 圆角，四角对不上。
//
// Symptom: after the update the Wallpaper Engine wallpaper no longer follows the app window's
// corners. index.css zeroes the shell radius / clip-path for .desktop-maximized,
// .desktop-fullscreen and .desktop-wallpaper-mode, but the main-process helper only mirrored
// maximised / fullscreen — wallpaper mode (window reparented into Explorer's WorkerW) was missed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} is missing`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

let desktopModeEnabled = false;
const sandbox = {
  Math,
  Number,
  windowFullscreenActive: false,
  htmlFullscreenActive: false,
  screen: { getDisplayMatching: () => ({ scaleFactor: 2 }) },
  fullDesktopModeRuntime: {
    getStatus: () => ({ enabled: desktopModeEnabled }),
  },
};
vm.createContext(sandbox);
vm.runInContext(extractFunction(mainSource, 'wallpaperEngineHostCornerRadius'), sandbox);

function fakeWindow(flags) {
  const state = Object.assign({ destroyed: false, maximized: false, fullscreen: false }, flags || {});
  return {
    isDestroyed: () => state.destroyed,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullscreen,
    getContentBounds: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
  };
}
function radiusFor(flags) {
  return sandbox.wallpaperEngineHostCornerRadius(fakeWindow(flags));
}

function reset() {
  desktopModeEnabled = false;
  sandbox.windowFullscreenActive = false;
  sandbox.htmlFullscreenActive = false;
}

// 1. 普通窗口态：圆角跟随应用外壳（34px × 显示器缩放）。
reset();
assert.strictEqual(radiusFor({}), 68, 'an ordinary window keeps the 34px shell radius at 200% scaling');

// 2. 应用侧已经是直角的状态，原生窗口必须一起变直角。
reset();
assert.strictEqual(radiusFor({ maximized: true }), 0, 'a maximised window keeps square corners');
assert.strictEqual(radiusFor({ fullscreen: true }), 0, 'a fullscreen window keeps square corners');
sandbox.windowFullscreenActive = true;
assert.strictEqual(radiusFor({}), 0, 'an Electron window-fullscreen window keeps square corners');
sandbox.windowFullscreenActive = false;
sandbox.htmlFullscreenActive = true;
assert.strictEqual(radiusFor({}), 0, 'an HTML-fullscreen window keeps square corners');

// 3. 回归点：桌面壁纸模式（窗口挂在 Explorer 的 WorkerW 下，既非最大化也非全屏）。
reset();
desktopModeEnabled = true;
assert.strictEqual(
  radiusFor({}),
  0,
  'desktop wallpaper mode must square the native WE window, matching the app shell'
);
// 4. 离开壁纸模式后必须恢复圆角，不能把状态粘住。
reset();
assert.strictEqual(radiusFor({}), 68, 'leaving wallpaper mode restores the rounded native window');

// 5. 防御：window 缺失或已销毁时不得抛错。
reset();
assert.strictEqual(sandbox.wallpaperEngineHostCornerRadius(null), 0, 'a missing window resolves to square');
assert.strictEqual(radiusFor({ destroyed: true }), 0, 'a destroyed window resolves to square');

// 6. 防漂移：CSS 里所有把窗口外壳清零圆角的状态，主进程都必须有对应信号。
//    Drift guard: every CSS state that squares the app shell must have a matching main-process signal.
const shellSquareRule = cssText.match(
  /body\.desktop-shell[\s\S]{0,400}?#desktop-window-shell[\s\S]{0,200}?border-radius:\s*0\s*!important/
);
assert(shellSquareRule, 'the shell-square CSS rule is missing');
const squareSelectors = shellSquareRule[0]
  .split(',')
  .map((selector) => selector.replace(/\s+/g, ' ').trim())
  .filter(Boolean);
assert(squareSelectors.length >= 4, `expected at least four square-shell selectors, got ${squareSelectors.length}`);
const radiusFn = mainSource.slice(
  mainSource.indexOf('function wallpaperEngineHostCornerRadius('),
  mainSource.indexOf('function wallpaperEnginePhysicalContentBounds(')
);
const expectedSignals = [
  [/desktop-maximized/, /win\.isMaximized\(\)/],
  [/desktop-fullscreen/, /win\.isFullScreen\(\)/],
  [/desktop-wallpaper-mode/, /fullDesktopModeRuntime\.getStatus\([^)]*\)\.enabled === true/],
  [/html:fullscreen/, /htmlFullscreenActive/],
];
expectedSignals.forEach(([selectorNeedle, signalNeedle]) => {
  const declared = squareSelectors.some((selector) => selectorNeedle.test(selector));
  assert(declared, `${selectorNeedle} must still square the app shell in CSS`);
  assert(
    signalNeedle.test(radiusFn),
    `${selectorNeedle} squares the app shell, so wallpaperEngineHostCornerRadius must react to ${signalNeedle}`
  );
});
assert(
  /wallpaperEngineHostCornerRadius\(mainWindow\)/.test(mainSource),
  'the radius helper must stay wired to the real main window'
);
assert(
  /cornerRadius: hostCornerRadius/.test(mainSource),
  'the computed radius must still reach the native WE embedding call'
);

console.log('wallpaper engine corner radius mode: 12 checks passed');
