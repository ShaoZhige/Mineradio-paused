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
  assert.match(helper, /bool regionDirty = sizeChanged \|\| radius != lastRadius;/);
  assert.match(helper, /if \(regionDirty\) ApplyCornerRegion\(Handle, width, height, radius\);/);
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

// issue #5：拖动跟手改事件驱动后新增的不变量。定时器两档仍是兜底，事件钩子才是主路径；
// 这几个点写错都不会报错，只会"钩子静默失效"或"回调崩进程"，所以逐条钉死。
check('窗口移动事件钩子用 OUTOFCONTEXT 跨进程接收，不注入 DLL', () => {
  assert.match(helper, /const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;/);
  assert.match(helper, /const uint WINEVENT_OUTOFCONTEXT = 0x0000;/);
  assert.match(helper, /const uint WINEVENT_SKIPOWNPROCESS = 0x0002;/);
  assert.match(helper, /static extern IntPtr SetWinEventHook\(uint eventMin, uint eventMax, IntPtr module,\s*\n\s*WinEventDelegate callback, uint processId, uint threadId, uint flags\)/,
    'SetWinEventHook P/Invoke 签名必须是 7 参数的标准原型');
  assert.match(helper, /SetWinEventHook\(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE,\s*\n\s*IntPtr\.Zero, locationHookCallback, 0, 0, WINEVENT_OUTOFCONTEXT \| WINEVENT_SKIPOWNPROCESS\)/,
    '只监听 locationchange、进程/线程 ID 传 0 表示全系统，OUTOFCONTEXT|SKIPOWNPROCESS');
});

check('事件回调只认目标窗口并切回 UI 线程，delegate 用 GCHandle 钉住', () => {
  const installAt = helper.indexOf('void InstallLocationHook()');
  const install = helper.slice(installAt, helper.indexOf('\n  }', installAt));
  assert.match(install, /idObject != OBJID_WINDOW/, '必须过滤掉光标等非窗口对象的 locationchange');
  assert.match(install, /idChild != CHILDID_SELF/);
  assert.match(install, /hwnd != hostWindow/, '只跟随 Electron 宿主，不理会别的窗口移动');
  // 回调在线程池线程，必须切回 UI 线程再动 WinForms / SetWindowPos；现在统一走合并入口
  // QueueFollowHost（内部才是 BeginInvoke），避免每条事件都排一个任务。
  assert.match(install, /QueueFollowHost\(\)/, '回调必须走合并入口 QueueFollowHost');
  const queueAt = helper.indexOf('void QueueFollowHost()');
  const queue = helper.slice(queueAt, helper.indexOf('\n  }', queueAt));
  assert.match(queue, /BeginInvoke\(new Action/, 'QueueFollowHost 内部必须切回 UI 线程');
  assert.match(install, /GCHandle\.Alloc\(locationHookCallback\)/, 'delegate 不钉住会被 GC 回收，回调直接崩进程');
});

check('事件钩子的生命周期完整：安装一次、销毁时卸载并释放 delegate', () => {
  assert.match(helper, /static extern bool UnhookWinEvent\(IntPtr hook\)/);
  const removeAt = helper.indexOf('void RemoveLocationHook()');
  const remove = helper.slice(removeAt, helper.indexOf('\n  }', removeAt));
  assert.match(remove, /UnhookWinEvent\(locationHook\)/);
  assert.match(remove, /locationHookPin\.Free\(\)/);
  // 安装在 OnShown、卸载在 OnFormClosed，成对出现。
  const shown = helper.slice(helper.indexOf('protected override void OnShown'), helper.indexOf('protected override void OnFormClosed'));
  assert.match(shown, /InstallLocationHook\(\)/);
  const closed = helper.slice(helper.indexOf('protected override void OnFormClosed'));
  assert.match(closed, /RemoveLocationHook\(\)/);
});

// issue #6 重写：圆角要能实时改，且不能让帮手被 WE 的线程堵住。
// 这两条一旦退化都只会在真机上表现为"壁纸不裁"或"窗口外露一块纯黑"，测试必须钉死。
check('黑底在 UI 线程同步跟随，WE 窗口在后台线程移动（阻塞不许回到 UI 线程）', () => {
  // 实测踩过两次：
  //   1. 跨进程 SetWindowPos 同步 → CEF 一忙就把 UI 线程堵住，黑底停在旧位置露出来；
  //   2. 改成 SWP_ASYNCWINDOWPOS → 位置请求在对方队列里堆积，壁纸"超慢速追赶"鼠标。
  // 正解是把 WE 的窗口交给后台线程（阻塞留在那边），黑底永远在 UI 线程同步跟上。
  // 注释里会提到这个标志（记录踩过的坑），所以先剥掉注释再断言代码本身。
  const codeOnly = helper.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/SWP_ASYNCWINDOWPOS/.test(codeOnly), '不要用 ASYNC 标志，会排队成慢速追赶');
  assert.match(helper, /void StartSourceMoveWorker\(\)/);
  assert.match(helper, /void QueueSourceMove\(/, 'source 移动必须走"只登记最新目标"的入口');
  const loopAt = helper.indexOf('void SourceMoveLoop()');
  const loop = helper.slice(loopAt, helper.indexOf('\n  }\n', loopAt));
  assert.match(loop, /MoveSourceBehindSurface\(/, 'WE 窗口的移动必须由后台线程发起');
  // 摆位形状和原来一致：source 插到 Handle 之后（垫在底座下面），像素对齐关系不变。
  assert.match(helper, /void MoveSourceBehindSurface\(/, '需要唯一的 source 摆位入口');
  assert.match(helper, /SetWindowPos\(sourceWindow, Handle,/, 'source 必须仍然垫在底座 Handle 之后');
  // latest-wins：登记时直接覆盖，不往队列里追加。
  const queueAt = helper.indexOf('void QueueSourceMove(');
  const queue = helper.slice(queueAt, helper.indexOf('\n  }\n', queueAt));
  assert.ok(!/Queue<|ConcurrentQueue|\.Enqueue\(/.test(queue), '不许排队，只保留最新目标');
  // 黑底：UI 线程上的同步 set，且在缩略图分支里也照样先动它。
  const blk = helper.slice(helper.indexOf('uint placementFlags'), helper.indexOf('lastWidth = width;'));
  assert.match(blk, /SetWindowPos\(Handle,[^;]*placementFlags\)/s, '黑底必须同步跟随');
  assert.match(blk, /QueueSourceMove\(/, '缩略图激活后 source 交给后台线程');
  assert.match(blk, /StartSourceMoveWorker\(\)|QueueSourceMove\(/);
  // 启停在 OnShown / OnFormClosed 成对出现。
  assert.match(helper, /StartSourceMoveWorker\(\);/);
  assert.match(helper, /StopSourceMoveWorker\(\);/);
  // 自愈：位置和尺寸都要查。
  assert.match(helper, /bool posOff = Math\.Abs\(self\.Left - hostRect\.Left\) > 2/);
});

check('移动事件必须合并，否则队列里堆满重复的 FollowHost', () => {
  // 拖动时 LOCATIONCHANGE 每帧来好几条，每条都 BeginInvoke 一次等于每帧白做几十次跨进程调用，
  // 既拖慢跟手又放大被 CEF 堵住的概率。
  assert.match(helper, /void QueueFollowHost\(\)/);
  assert.match(helper, /if \(followQueued \|\| IsDisposed \|\| !IsHandleCreated\) return;/,
    '已排队就不能再排，队列里最多一个');
  assert.match(helper, /followQueued = false;\s*\n\s*try \{ FollowHost\(\); \}/,
    '任务开始执行时必须先清标记，否则后续事件全被吞掉');
  // 钩子回调必须走合并入口，而不是直接 BeginInvoke。
  const hookAt = helper.indexOf('void InstallLocationHook()');
  const hook = helper.slice(hookAt, helper.indexOf('\n  }', hookAt));
  assert.match(hook, /QueueFollowHost\(\)/);
  assert.ok(!/BeginInvoke\(new Action\(delegate\(\) \{ FollowHost\(\) \}\); \}\)/.test(hook),
    '钩子里不要保留裸 BeginInvoke(FollowHost)');
});

check('底座必须是色彩键透明，不能涂纯黑', () => {
  // 透明底座：即便它慢半拍露出来，透出的也是桌面而不是一块黑。底色必须是壁纸里几乎不可能
  // 出现的魔法色 —— 用纯黑当键会把暗色壁纸里的纯黑像素一起抠成透明，壁纸会破洞。
  assert.ok(!/BackColor = Color\.Black;/.test(helper), '底座不能再涂纯黑');
  assert.match(helper, /BackColor = Color\.FromArgb\(255, 0, 1, 0\);/);
  assert.match(helper, /TransparencyKey = BackColor;/, '必须在句柄创建后挂色彩键');
});

check('圆角在运行时可变，并带 dirty 标记绕过尺寸短路', () => {
  assert.ok(!/readonly int windowCornerRadius;/.test(helper), '圆角字段不能是 readonly，否则拖滑块永远改不了壁纸');
  assert.match(helper, /bool cornerRadiusDirty;/);
  assert.match(helper, /!cornerRadiusDirty && geometryApplied/, 'dirty 时必须重算半径而不是复用 lastRadius');
  assert.match(helper, /if \(command\.StartsWith\("R\|", StringComparison\.Ordinal\)\)/,
    '缺少 R| 命令就无法在运行时改原生表面圆角');
  assert.match(helper, /cornerRadiusDirty = false;/, '每轮 FollowHost 结束必须清掉 dirty');
});

console.log('\nissue #5 event-driven follow: all checks passed');
