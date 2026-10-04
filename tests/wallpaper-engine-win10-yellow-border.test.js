'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { accessorBlock, i18nWindow } = require('./helpers/module-source');

const appRoot = path.resolve(__dirname, '..');
const libraryText = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js'),
  'utf8'
);

function sourceBlock(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  assert(start >= 0, `missing source block: ${startNeedle}`);
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing source block terminator: ${endNeedle}`);
  return text.slice(start, end);
}

const captureBlock = sourceBlock(
  libraryText,
  'async function openWallpaperEngineCaptureStream(sessionId, fps, sourceId, options)',
  'window.__mineradioPrepareWallpaperEngineCapture = async function'
);

assert.match(
  captureBlock,
  /sourceIdOnly: options\.sourceIdOnly === true/,
  'capture diagnostics must record source-id-only mode'
);
assert.match(
  captureBlock,
  /if \(options\.sourceIdOnly === true\)[\s\S]{0,180}DISPLAY_MEDIA_FALLBACK_DISABLED/,
  'source-id-only mode must explicitly disable display-media fallback'
);
assert.match(
  captureBlock,
  /if \(options\.sourceIdOnly !== true && typeof navigator\.mediaDevices\.getDisplayMedia === 'function'\)/,
  'getDisplayMedia may only run outside source-id-only mode'
);

const scenePrepareBlock = sourceBlock(
  libraryText,
  'window.__mineradioPrepareWallpaperEngineCapture = async function',
  'window.__mineradioPrepareWallpaperEngineGlassCapture = async function'
);
assert.match(
  scenePrepareBlock,
  /openWallpaperEngineCaptureStream\(sessionId, fps, sourceId, \{\s*sourceIdOnly: true,\s*purpose: 'scene'\s*\}\)/,
  'WE scene pak preparation must not fall back to getDisplayMedia on Windows 10'
);
assert.doesNotMatch(
  scenePrepareBlock,
  /getDisplayMedia/,
  'scene preparation must not directly request display-media capture'
);

const glassPrepareBlock = sourceBlock(
  libraryText,
  'window.__mineradioPrepareWallpaperEngineGlassCapture = async function',
  'window.__mineradioPrepareWallpaperEngineHostBoundsChange = function'
);
assert.match(
  glassPrepareBlock,
  /sourceIdOnly: true/,
  'WE glass sampler must also use exact source-id capture only'
);

// 玻璃采样是可选增强：开关关掉后不得再建立任何捕获会话，否则 Win10 会留下常驻黄框。
// The glass sampler is opt-in: while it is off no capture session may be opened, or
// Windows 10 keeps painting its capture border.
const layerReadyBlock = sourceBlock(
  libraryText,
  'function wallpaperEngineLayerReady(kind, token) {',
  'function wallpaperEngineLayerFailed('
);
assert.match(
  layerReadyBlock,
  /if \(kind === 'dwm' && fx\.wallpaperEngineGlassSampler !== false\)/,
  'the glass sampler may only be scheduled while the setting is enabled'
);

const glassGateBlock = sourceBlock(
  libraryText,
  'async function ensureWallpaperEngineGlassSamplerCapture(sessionId, layerToken, attempt) {',
  'var activeTrack = wallpaperEngineGlassCaptureStream'
);
assert.match(
  glassGateBlock,
  /fx\.wallpaperEngineGlassSampler === false/,
  'the glass sampler gate must also reject retries after the setting is turned off'
);

// 默认值基线：兜底读取路径拿不到平台判定时，基线就是最终值，必须站在"没有黄框"这一边。
// Baseline: a fallback read that never reaches the platform check uses the baseline verbatim,
// so it has to stand on the no-border side.
const defaultsText = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'),
  'utf8'
);
assert.match(
  defaultsText,
  /wallpaperEngineGlassSampler:\s*false,/,
  'the cross-platform glass sampler baseline must stay off so a fallback read cannot ship a Win10 capture border'
);
// 基线关掉不等于永远关掉：读档路径仍要按平台能力把它提升回来，否则 Win11 也拿不到玻璃增强。
// Off by default is not off forever: the read path still has to promote it per platform, or
// Win11 loses the enhancement too.
const persistenceText = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'),
  'utf8'
);
assert.match(
  persistenceText,
  /wallpaperEngineGlassSampler == null\s*\n?\s*\?\s*wallpaperEngineBorderlessCaptureSupported\(\)/,
  'the read path must still promote the sampler on platforms that can hide the capture border'
);

// 存档里早就开着、用户早已忘记的情况不会经过"手动切换"那条提示路径，必须在真正调度采样
// 前补一次提醒。
// A value stored long ago never goes through the toggle handler, so warn right before the
// capture is scheduled.
assert.match(
  layerReadyBlock,
  /if \(kind === 'dwm' && fx\.wallpaperEngineGlassSampler !== false\) \{\s*\n\s*notifyWallpaperEngineGlassSamplerBorder\(\);/,
  'scheduling the glass sampler must remind an unsupported platform about the capture border'
);

function extractFunction(text, signature) {
  const from = text.indexOf(signature);
  assert(from >= 0, `missing function: ${signature}`);
  const open = from + signature.length - 1;
  assert(text[open] === '{', `signature must end with the body brace: ${signature}`);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${signature}`);
}

function runBorderNotification(release) {
  const toasts = [];
  const context = vm.createContext({
    // 通知函数调用了取词函数；带上访问器本体，并用 zh-CN 词典桩让 /Windows 10/ 与 /黄/
    // 断言继续成立。桌面版本号是判定函数要读的，二者合并在同一个 window 上。
    // The notifier calls the accessor; carry it along and answer from the zh-CN dictionary so
    // the /Windows 10/ and /黄/ assertions hold. The desktop release is read by the gate helper,
    // so both live on the same `window` object.
    window: Object.assign(
      { desktopWindow: release === undefined ? undefined : { systemRelease: release } },
      i18nWindow('zh_cn')
    ),
    showToast: (message) => toasts.push(String(message)),
  });
  vm.runInContext(
    extractFunction(defaultsText, 'function wallpaperEngineBorderlessCaptureSupported() {'),
    context,
    { filename: 'fx-defaults.js' }
  );
  vm.runInContext('var wallpaperEngineGlassBorderNotified = false;', context);
  vm.runInContext(accessorBlock(libraryText), context, { filename: 'wallpaper-engine-library.js' });
  vm.runInContext(
    extractFunction(libraryText, 'function notifyWallpaperEngineGlassSamplerBorder() {'),
    context,
    { filename: 'wallpaper-engine-library.js' }
  );
  const first = vm.runInContext('notifyWallpaperEngineGlassSamplerBorder()', context);
  const second = vm.runInContext('notifyWallpaperEngineGlassSamplerBorder()', context);
  return { first, second, toasts };
}

const win10Notice = runBorderNotification('10.0.19045');
assert.strictEqual(win10Notice.first, true, 'Win10 must be reminded that the capture border stays');
assert.strictEqual(win10Notice.second, false, 'the border reminder must fire once per session');
assert.strictEqual(win10Notice.toasts.length, 1, 'one reminder, not one per wallpaper restart');
assert(/Windows 10/.test(win10Notice.toasts[0]), 'the reminder must name the affected platform');
assert(/黄/.test(win10Notice.toasts[0]), 'the reminder must describe the yellow border itself');

const win11Notice = runBorderNotification('10.0.26100');
assert.strictEqual(win11Notice.first, false, 'Win11 can hide the border and must not be nagged');
assert.deepStrictEqual(win11Notice.toasts, [], 'no reminder on a borderless-capable platform');

// 拿不到系统版本是"不确定"，不是"确定有黄框"——不能拿它去打扰用户。
// An unknown release means undecided, not bordered: it must not earn a reminder.
for (const release of [undefined, '']) {
  const unknownNotice = runBorderNotification(release);
  assert.strictEqual(unknownNotice.first, false, 'an unknown release must not be treated as Win10');
  assert.deepStrictEqual(unknownNotice.toasts, [], 'an unknown release must stay silent');
}

console.log('[OK] Wallpaper Engine pak capture avoids Win10 display-capture yellow border fallback, '
  + 'the glass sampler stays behind its setting, defaults to off, and reminds an unsupported '
  + 'platform once per session.');
