'use strict';

// DIY 视觉控制台的顶栏卡片要停在原位：面板自身不滚动，内容挂进独立的滚动区，
// 同时卡片保持原来的悬浮透明样式（圆角 15px、半透明底、模糊）。
// The DIY console header card must stay put: the panel itself does not scroll, content lives in
// its own scroller, and the card keeps its original floating translucent look.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
const workspace = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
const panelCode = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');

// 1) 面板默认保持原来的滚动容器；工作区建好内容滚动区后才切换成固定顶栏的布局。
const panelMatch = css.match(/#fx-panel \{[^}]*position:\s*fixed[^}]*\}/);
assert.ok(panelMatch, 'the main #fx-panel rule is missing');
const panelBlock = panelMatch[0];
assert.match(panelBlock, /overflow-y:\s*auto/);
assert.match(panelBlock, /padding:\s*18px 18px 32px/, 'the panel keeps its original top inset');

const scrolledPanelRule = css.match(/#fx-panel\.fx-console-has-scroll \{[^}]*\}/);
assert.ok(scrolledPanelRule, 'the has-scroll modifier rule is missing');
assert.match(scrolledPanelRule[0], /display:\s*block/);
assert.match(scrolledPanelRule[0], /overflow:\s*hidden/, 'with a content scroller the panel must not scroll itself');
assert.match(scrolledPanelRule[0], /padding:\s*0/);

// 2) 内容区铺满整个面板、从常驻卡片下面穿过去，顶部按卡片实际高度让位。
const scrollRule = css.match(/#fx-console-scroll \{[^}]*\}/);
assert.ok(scrollRule, '#fx-console-scroll rule is missing');
assert.match(scrollRule[0], /position:\s*absolute/);
assert.match(scrollRule[0], /inset:\s*0/);
assert.match(scrollRule[0], /overflow-y:\s*auto/);
assert.match(scrollRule[0], /padding:\s*calc\(var\(--fx-console-head-h, 80px\) \+ 30px\) 18px 32px/);
assert.match(scrollRule[0], /mask-image:\s*linear-gradient\(180deg, transparent 0/, 'content fades out above the card instead of being hard-clipped');
const toolbarFloatRule = css.match(/#fx-panel\.fx-console-has-scroll \.fx-console-toolbar \{[^}]*\}/);
assert.ok(toolbarFloatRule, 'the floating header rule is missing');
assert.match(toolbarFloatRule[0], /position:\s*absolute/);
assert.match(toolbarFloatRule[0], /z-index:\s*3/);

// 3) 顶栏卡片保持原来的悬浮透明外观；常态不再靠 sticky/负偏移滚动。
const toolbarMatch = css.match(/^\.fx-console-toolbar \{[^}]*\}/m);
assert.ok(toolbarMatch, '.fx-console-toolbar rule is missing');
const toolbarBlock = toolbarMatch[0];
assert.match(toolbarBlock, /position:\s*relative/);
assert.match(toolbarBlock, /border-radius:\s*15px/);
assert.match(toolbarBlock, /background:\s*rgba\(0, 0, 0, \.54\)/);
assert.match(toolbarBlock, /backdrop-filter:\s*blur/);
assert.match(toolbarBlock, /margin:\s*-2px -2px 14px/);
assert.doesNotMatch(toolbarBlock, /position:\s*sticky/);
assert.doesNotMatch(toolbarBlock, /top:\s*-18px/);
assert.doesNotMatch(toolbarBlock, /linear-gradient\(180deg, rgba\(16, 20, 23/);

// 4) 工作区把页面挂进滚动区，顶栏仍是同一张卡，并给面板打上 has-scroll 标记。
assert.match(workspace, /panel\.classList\.add\('fx-console-has-scroll'\)/);
assert.match(workspace, /scrollRoot\.appendChild\(page\)/);
assert.match(workspace, /toolbar\.className = 'fx-console-toolbar'/);

// 4b) 重建时不能把滚动容器当旧节点删掉：那样面板只剩顶栏、内容全空。
assert.match(workspace, /var scrollRoot = document\.createElement\('div'\);\s*scrollRoot\.id = 'fx-console-scroll';/);
assert.match(workspace, /node === scrollRoot\) return;/, 'the rebuild cleanup must never delete the content scroller');
assert.match(workspace, /function relabelFxConsoleWorkspace\(\)/);

// 4c) 卡片高度由脚本实测后写进 --fx-console-head-h，内容区据此让位。
assert.match(workspace, /function fxConsoleSyncHeaderHeight\(panel, toolbar\)/);
assert.match(workspace, /panel\.style\.setProperty\('--fx-console-head-h', height \+ 'px'\)/);
assert.match(workspace, /new ResizeObserver\(apply\)/);
assert.match(workspace, /fxConsoleSyncHeaderHeight\(panel, toolbar\);/);

// 4d) 滚动性能：与歌单面板同级的 contain / will-change，滚动期间暂停卡片自身的背景模糊。
assert.match(scrollRule[0], /contain:\s*layout paint/);
assert.match(scrollRule[0], /will-change:\s*scroll-position/);
assert.match(css, /body\.fx-console-scrolling #fx-console-scroll \* \{[\s\S]{0,120}backdrop-filter:\s*none !important/);
assert.match(workspace, /panel\.addEventListener\('scroll', function \(\) \{/);
assert.match(workspace, /document\.body\.classList\.add\('fx-console-scrolling'\)/);
assert.match(workspace, /\}, 140\);/);

// 5) 卡片放大后的排版：面板更宽、卡片更高、字号更大。
assert.match(panelBlock, /width:\s*min\(520px, calc\(100vw - 48px\)\)/);
assert.match(css, /\.preset-card \{[^}]*min-height:\s*128px/);
assert.match(css, /\.preset-card \{[^}]*border-radius:\s*14px/);
assert.match(css, /\.preset-card \.pc-name \{\s*font-size:\s*15\.5px/);
assert.match(css, /\.preset-card \.pc-desc \{\s*font-size:\s*11\.5px/);
assert.match(css, /\.preset-card \.pc-name-en \{\s*color:[^}]*font-size:\s*10\.5px/);
assert.match(css, /\.preset-card \.pc-icon svg \{\s*width:\s*22px;\s*height:\s*22px/);
assert.match(css, /\.preset-card\.preset-card-premium \{[^}]*min-height:\s*146px/);

// 5) 标签页的滚动记忆跟着内容区走，而不是面板。
assert.match(panelCode, /var panelScroll = document\.getElementById\('fx-console-scroll'\) \|\| panel;/);
assert.match(panelCode, /fxPanelTabScroll\[previousTab\] = panelScroll\.scrollTop;/);
assert.match(panelCode, /panelScroll\.scrollTop = Object\.prototype\.hasOwnProperty/);

console.log('OK fx-console-header-pin');
