'use strict';

// DWM 表面助手是壁纸模式下唯一常驻的高频循环，它的成本全在"看起来没变的时候还照做"上：
//   1. 静止时不能再有任何跨进程调用（原来是每 60ms 两个带尺寸的 SetWindowPos）；
//   2. 纯移动不能给 WE 的 CEF 窗口重设尺寸（等于每拍逼它重排一帧）；
//   3. 拖动期间必须比原来更快，否则"跟手"只是把卡顿换成了滞后；
//   4. 周期重申只负责纠层级漂移，不许顺手把重排也带回来。
// 这些退化都不会报错，只会在真机上变慢/变滞，所以逐条钉住。
// Every one of these can regress silently: the wallpaper still shows, it just stutters again.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { nativeDwmThumbnailSurfaceScript } = require('../desktop/wallpaper-engine-runtime');

const helper = nativeDwmThumbnailSurfaceScript();
const mainText = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

function check(name, run) {
  run();
  console.log('ok - ' + name);
}

check('拖动与静止用两档节拍，起始是空闲档', () => {
  assert.match(helper, /const int FOLLOW_ACTIVE_INTERVAL_MS = 16;/, '拖动档必须是 16ms（≈60Hz）');
  assert.match(helper, /const int FOLLOW_IDLE_INTERVAL_MS = 100;/, '空闲档必须是 100ms');
  assert.match(helper, /const int FOLLOW_SETTLE_MS = 300;/, '停手 300ms 后回落');
  assert.match(helper, /followTimer\.Interval = FOLLOW_IDLE_INTERVAL_MS;/, '定时器必须从空闲档起步');
  assert.doesNotMatch(helper, /followTimer\.Interval = 60\b/, '不许回到固定 60ms 的无条件循环');
});

check('节拍真的会切换，而不是只声明常量', () => {
  assert.match(helper, /int desiredInterval = moving \? FOLLOW_ACTIVE_INTERVAL_MS : FOLLOW_IDLE_INTERVAL_MS;/);
  assert.match(helper, /if \(followTimer\.Interval != desiredInterval\) followTimer\.Interval = desiredInterval;/);
  assert.match(helper, /bool moving = unchecked\(Environment\.TickCount - lastGeometryChangeTick\) < FOLLOW_SETTLE_MS;/);
  // 提前返回那条路径也必须重新算节拍，否则拖动结束后会一直卡在 16ms 抖动。
  const earlyOutStart = helper.indexOf('bool reassertPass');
  assert.ok(earlyOutStart > 0, '找不到早退分支');
  assert.match(helper.slice(earlyOutStart, earlyOutStart + 420), /ApplyFollowCadence\(false\);/,
    '提前返回时也要回调节拍');
});

check('没有变化时在任何 SetWindowPos 之前就返回', () => {
  const earlyReturn = helper.indexOf('bool reassertPass');
  const firstPlacement = helper.indexOf('SetWindowPos(', helper.indexOf('void FollowHost(bool force)'));
  assert.ok(earlyReturn > 0 && firstPlacement > earlyReturn,
    '早退分支必须排在所有 SetWindowPos 之前，否则这轮优化等于没做');
  const guard = helper.slice(earlyReturn, firstPlacement);
  assert.match(guard, /if \(!force && geometrySame && thumbnailSame && !reassertPass\)/);
  assert.match(guard, /return;/);
});

check('纯移动不传尺寸，只有尺寸真的变了才带 width/height', () => {
  assert.match(helper, /bool sizeChanged = width != lastWidth \|\| height != lastHeight;/);
  assert.match(helper, /SWP_NOSIZE/);
  assert.match(helper, /\(sizeChanged \? 0u : SWP_NOSIZE\)/, '尺寸没变时必须挂 SWP_NOSIZE');
  assert.match(helper, /int placementWidth = sizeChanged \? width : 0;/);
  assert.match(helper, /int placementHeight = sizeChanged \? height : 0;/);
  // 圆角区域只在尺寸或半径变化时重算，拖动不该反复 CreateRoundRectRgn。
  assert.match(helper, /if \(sizeChanged \|\| radius != lastRadius\) \{\s*\n\s*ApplyCornerRegion\(Handle/);
});

check('屏幕位置不变时不重发缩略图属性', () => {
  assert.match(helper, /bool thumbnailSame = thumbnail == IntPtr\.Zero/);
  assert.match(helper, /if \(thumbnail != IntPtr\.Zero && \(!thumbnailSame \|\| force\)\)/);
});

check('周期重申纠漂移，但不会顺手把 CEF 重排带回来', () => {
  assert.match(helper, /const int ZORDER_REASSERT_TICKS = 3;/);
  assert.match(helper, /if \(!sizeChanged && reassertPass\) \{/);
  const driftCheck = helper.slice(helper.indexOf('if (!sizeChanged && reassertPass)'), helper.indexOf('uint placementFlags'));
  assert.match(driftCheck, /GetWindowRect\(sourceWindow, out actual\)/, '重申前必须先读真实矩形');
  assert.match(driftCheck, /GetWindowRect\(Handle, out actual\)/);
  assert.match(driftCheck, /RectMatches\(actual, hostRect\)/);
  // 只有真的漂了才把 sizeChanged 置真；否则重申就是两次不带尺寸的 SetWindowPos。
  assert.match(driftCheck, /sizeChanged = \(/);
});

check('换层级目标 / 激活缩略图时必须强制跑一遍', () => {
  const forced = (helper.match(/FollowHost\(true\);/g) || []).length;
  assert.ok(forced >= 2, '层级热切换与缩略图激活都调 FollowHost(true)，实际 ' + forced + ' 处');
  const layering = helper.slice(helper.indexOf('desktopIconLayeringEnabled = enabled;'));
  assert.match(layering.slice(0, 400), /FollowHost\(true\);/, '层级切换不能被"没有变化"短路掉');
  const activate = helper.slice(helper.indexOf('void ActivateThumbnail()'));
  assert.match(activate.slice(0, 600), /FollowHost\(true\);/, '激活后必须立刻下发布局与缩略图属性');
});

check('窗口最小尺寸不再跟着每一次 move 重设', () => {
  const start = mainText.indexOf('function updateMainWindowMinimumSize(win)');
  assert.ok(start > 0, '找不到 updateMainWindowMinimumSize');
  const body = mainText.slice(start, mainText.indexOf('\n}', start));
  assert.match(body, /win\.getMinimumSize\(\)/, '必须先读回当前值判重');
  const readAt = body.indexOf('win.getMinimumSize()');
  const writeAt = body.indexOf('win.setMinimumSize(');
  assert.ok(writeAt > readAt, '判重要排在写入之前');
  assert.strictEqual(body.split('win.setMinimumSize(').length - 1, 1, '只保留一处写入');
  assert.match(body, /if \(Array\.isArray\(current\) && current\[0\] === minimum\.width && current\[1\] === minimum\.height\) return;/);
});

check('move / resize 仍然会更新最小尺寸（判重不能把它整段跳过）', () => {
  assert.match(mainText, /win\.on\('move', \(\) => \{\s*\n\s*updateMainWindowMinimumSize\(win\);/);
  assert.match(mainText, /win\.on\('resize', \(\) => \{\s*\n\s*updateMainWindowMinimumSize\(win\);/);
});

console.log('\nwallpaper-engine-follow-cadence: all checks passed');
