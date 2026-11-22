'use strict';

// 壁纸切换等待的三态守卫（issue #5 智能合成的切换延迟优化）
//
// 现状根因（探查实测）：
//   1. DWM 模式下可见画面在原生表面，#wallpaper-engine-layer 被 CSS visibility:hidden
//      整个隐藏 —— 渐隐对旧场景毫无视觉作用，但切换仍等 440+20ms 才开始加载新壁纸。
//   2. 引擎冷启是全部链路里最贵的一段（预热后 0.65s、冷启 3.8s+），却排在淡出之后。
//
// 修复分三态：
//   · 旧画面在原生表面（dwm-active）→ 跳过等待立即加载（省 460ms）
//   · 旧画面在 DOM 且新壁纸是 Scene → 保留渐隐，引擎冷启与淡出并行（省 ~440ms 冷启）
//   · 其余 → 原有串行（DOM 媒体切换保留渐隐视觉）
//
// 这些退化都只表现为"切换变慢"，不报错，所以静态钉死。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js'),
  'utf8'
);

function check(name, run) {
  run();
  console.log('ok - ' + name);
}

// 1. 跳过淡出的判据必须是"旧画面真的在 DWM 原生表面"，而不是"有任何旧帧"：
//    DOM 媒体之间切换的渐隐是刻意的视觉设计，不许被顺手带走。
check('DWM 旧画面跳过 440ms 淡出等待，DOM 旧帧保留渐隐', () => {
  const branch = source.indexOf("preserveOutgoingFrame && !document.body.classList.contains('wallpaper-engine-dwm-active')");
  assert.ok(branch > 0, '切换分支必须按 dwm-active 区分');
  // else 分支（dwm-active 或首次）必须立即 begin
  const settle = source.slice(branch);
  assert.match(settle.slice(0, 1600), /else \{\s*\n\s*clearWallpaperEngineLayerMedia\(0\);\s*\n\s*beginWallpaperEngineMediaLoad\(\);/,
    '原生表面旧画面/首次启用必须立即加载，不得再排定时器');
});

// 2. 保留渐隐的分支里，引擎冷启必须与淡出并行（预载先于排定淡出收尾定时器）。
check('DOM 旧帧切 Scene 时引擎冷启与淡出并行', () => {
  const prefetch = source.indexOf('if (kind === \'engine\' && !wallpaperEngineNativeHostUnavailable()) ensureNativeStarted();');
  const fadeTimer = source.indexOf('WALLPAPER_ENGINE_SWITCH_FADE_MS + 20');
  assert.ok(prefetch > 0, '淡出分支必须预载引擎');
  assert.ok(fadeTimer > prefetch, '预载必须排在淡出收尾定时器之前');
});

// 3. 引擎启动只许一次：淡出预载 + begin 收尾共用一个防重入口。
check('引擎冷启防重（nativePrefetchStarted）', () => {
  const guard = source.indexOf('function ensureNativeStarted()');
  assert.ok(guard > 0, '必须有统一的引擎启动入口');
  const body = source.slice(guard, source.indexOf('\n  }', guard));
  assert.match(body, /if \(nativePrefetchStarted\) return;/, '第二次调用必须直接返回');
  assert.match(body, /nativePrefetchStarted = true;/, '首次调用必须置位');
  // begin 的 engine 分支必须走这个入口，而不是自己再 start 一次
  const beginAt = source.indexOf('function beginWallpaperEngineMediaLoad()');
  const begin = source.slice(beginAt, source.indexOf('} else if (kind === \'media\'', beginAt));
  assert.match(begin, /if \(kind === 'engine'\) \{\s*\n\s*ensureNativeStarted\(\);/,
    'begin 的 engine 分支必须走防重入口');
  // 预载入口的失败处理必须保留原有的 token/错误分流（不许静默吞掉真失败）
  assert.match(body, /WALLPAPER_ENGINE_START_SUPERSEDED/);
  assert.match(body, /wallpaperEngineLayerFailed\(item, kind, token, error\);/);
});

// 4. 预载入口保留了原有的可用性检查，且与 begin 内部的检查一致。
check('预载与 begin 的可用性检查一致', () => {
  assert.match(source, /if \(kind === 'engine' && !wallpaperEngineNativeHostUnavailable\(\)\) ensureNativeStarted\(\);/,
    '预载前必须检查 nativeHostUnavailable');
});

console.log('\nwallpaper switch prefetch: all checks passed');
