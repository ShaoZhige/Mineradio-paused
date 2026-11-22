'use strict';

// 圆钮（#fx-fab）点击 = 开关 DIY 控制台面板，不再只能靠"鼠标移开自动收起"。
// 难点在悬停：面板本来就是 hover 就 peek 出来的，所以"点一下关掉"必须能压住悬停重开。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fx = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/07-fx/07-bindings-shelf-immersive.js'), 'utf8');
const peek = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/modules/10-shell/02-peek-panels-upload.js'), 'utf8');

test('toggleFxPanel 不带参数时是真开关（开着就关）', () => {
  const body = fx.slice(fx.indexOf('function toggleFxPanel(force)'), fx.indexOf('function resetFx()'));
  assert.match(body, /if \(force === false \|\| \(force !== true && currentlyOpen\)\)/,
    '不带参数且已打开时必须走关闭分支');
  assert.match(body, /closeFxPanelVisual\(el, currentlyOpen\);/);
});

test('抑制悬停重开只由点击触发，启动期的 toggleFxPanel(false) 不许置位', () => {
  const body = fx.slice(fx.indexOf('function toggleFxPanel(force)'), fx.indexOf('function resetFx()'));
  const closeBranch = body.slice(body.indexOf('if (force === false'), body.indexOf('fxPanelClickClosed = false;\n  el.classList.remove'));
  assert.ok(closeBranch.indexOf('fxPanelClickClosed = false;') > 0,
    'force===false 分支要把抑制清掉，否则启动时调一次就再也悬停不开');

  const click = fx.slice(fx.indexOf('function handleFxFabClick'), fx.indexOf('(function bindFxFabClickToggle'));
  assert.match(click, /if \(open\) \{[\s\S]{0,240}?toggleFxPanel\(false\);[\s\S]{0,240}?fxPanelClickClosed = true;/,
    '只有用户点击关闭才置抑制');
});

test('刚被悬停打开时的点击算打开，不会立刻关掉', () => {
  const click = fx.slice(fx.indexOf('function handleFxFabClick'), fx.indexOf('(function bindFxFabClickToggle'));
  assert.match(click, /Date\.now\(\) - \(Number\(fxPanelPeekOpenedAt\) \|\| 0\) < 320/);
  assert.match(peek, /if \(!fpOn\) fxPanelPeekOpenedAt = Date\.now\(\);/, '悬停打开时要记时刻');
});

test('指针离开圆钮/面板后解除抑制，悬停能再打开', () => {
  assert.match(peek, /if \(!inFxFab && !inFxPanel && !inFxBridge && typeof fxPanelClickClosed !== 'undefined' && fxPanelClickClosed\) \{/);
  assert.match(peek, /var fxSuppressed = typeof fxPanelClickClosed !== 'undefined' && fxPanelClickClosed;/);
  assert.match(peek, /if \(!fxSuppressed && \(inFxFab \|\| inFxPanel \|\| inFxBridge\)\) \{/);
});

test('圆钮点击只绑一次', () => {
  assert.match(fx, /fab\.__fxClickBound = true;/);
  assert.match(fx, /fab\.addEventListener\('click', handleFxFabClick\);/);
});
