'use strict';

// issue #7：主页全屏后图标集中在中心的回归测试。
//
// 根因：桌面全屏态给 #empty-home 加了 width: min(1480px, …)，又给 .empty-home-shell 加了
// max-width:1480px + margin:0 auto。视口比 1480px 宽时，整块内容被锁在屏幕中心一小条，
// 4 张快捷卡片跟着挤在中间。普通窗口态和最大化态都是 calc(100vw - 44px) 铺满，只有全屏态锁宽。
// 修法是去掉这两处锁宽，让全屏也铺满；但必须保留 .home-quick-grid 的 210px 账号胶囊避让，
// 否则卡片右边缘会压到右上角多账号胶囊。
//
// issue #7: after entering fullscreen the home cards stayed bunched in the centre of a wide
// screen. The fullscreen rules capped #empty-home at 1480px and centred the shell with
// max-width + margin:auto. Normal and maximised states already fill the viewport. The fix drops
// both caps while keeping the quick-grid's 210px capsule gutter.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { readAllCss } = require('./helpers/css-source');
const css = readAllCss();
const topbar = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'topbar.css'), 'utf8');
const dashboard = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'home-dashboard.css'), 'utf8');

function fullScreenBlock(selector) {
  const at = topbar.indexOf(selector);
  assert.notEqual(at, -1, `missing rule for ${selector}`);
  const open = topbar.indexOf('{', at);
  const close = topbar.indexOf('}', open);
  // 剥掉注释：否定判据不能命中"以前锁过 1480px"的说明文字。
  return topbar.slice(open, close)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 1. 全屏容器必须铺满视口，不能再出现 1480px 上限。
const homeFull = fullScreenBlock('body.desktop-shell.desktop-fullscreen #empty-home');
assert.match(homeFull, /width:\s*calc\(100vw - 96px\)/, 'fullscreen home must fill the viewport width');
assert.doesNotMatch(homeFull, /min\(1480px/, 'the 1480px cap that centred the home must be gone');

// 2. shell 自身也不能二次锁宽，否则只改容器无效。
const shellFull = fullScreenBlock('body.desktop-shell.desktop-fullscreen .empty-home-shell');
assert.match(shellFull, /max-width:\s*none/, 'the shell must not re-cap its width in fullscreen');
assert.match(shellFull, /margin:\s*0(?:\s|;)/, 'the shell must not re-centre itself with margin:auto');
assert.doesNotMatch(shellFull, /margin:\s*0 auto/, 'margin:0 auto is the centring that must be removed');

// 3. 普通窗口态和最大化态本来就铺满，不能被这次改动误伤。
assert.match(
  css,
  /body\.desktop-shell #empty-home[\s\S]{0,120}?width:\s*calc\(100vw - 44px\)/,
  'normal desktop-shell state must keep filling the viewport'
);

// 4. 账号胶囊避让必须保留：全屏时 #top-right 只是上移，没有隐藏，卡片右缘仍要避开 224px 区域。
//    那段规则带一大段"210px 从哪来"的注释，先剥注释再匹配。
const dashboardCode = dashboard.replace(/\/\*[\s\S]*?\*\//g, ' ');
assert.match(
  dashboardCode,
  /#empty-home \.home-grid\.home-quick-grid\s*\{[\s\S]{0,600}?padding-right:\s*210px/,
  'the 210px top-right capsule gutter must survive the fullscreen width change'
);

// 5. 全屏时胶囊确实仍可见（只是 top 上移），这是第 4 条成立的前提。
assert.match(
  css,
  /body\.desktop-shell\.desktop-fullscreen #top-right\s*\{[^}]*top:\s*24px/,
  'fullscreen must keep #top-right visible (only moved up), otherwise the gutter rationale breaks'
);

console.log('home fullscreen spread: 5 checks passed');
