'use strict';

// issue #2：舞台模式下「自动隐藏」对 3D 歌单架无效，收起后还剩半截。
//
// 舞台模式的可见度以前被写死成 1.0（`else { targetVis = allItems.length ? 1.0 : 0 }`），
// fx 面板里「歌单架显示：自动隐藏 / 常驻」只对侧栏模式生效；而且 `group.visible` 用的是
// `mode !== 'side' || shelfVisibility > 0`，舞台模式恒为真，卡片淡出后 group 与舞台专属的
// 连线粒子还在画 —— 这就是「还剩一半」的残影。
//
// 这条 issue 的修法是把舞台模式接到底部热区上，这里守住三件事：热区判定本身、
// 可见度决策真的读了它、残影那条永真条件没有回来。
// Issue #2: stage mode pinned its visibility at 1.0, so the "auto hide" option did nothing there,
// and the group stayed visible regardless (leaving the stage connector particles drawn). These
// tests pin the bottom hot zone, the visibility decision that reads it, and the removal of the
// always-true visibility condition.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const LAYOUT_PATH = path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '00-layout-hover.js');
const MANAGER_PATH = path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js');
const BINDINGS_PATH = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js');

const layoutText = fs.readFileSync(LAYOUT_PATH, 'utf8');
const managerText = fs.readFileSync(MANAGER_PATH, 'utf8');
const bindingsText = fs.readFileSync(BINDINGS_PATH, 'utf8');

function sliceFunction(text, name) {
  const start = text.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' must exist');
  const end = text.indexOf('\n}', start);
  assert.notEqual(end, -1, name + ' must be closed at column 0');
  return text.slice(start, end + 2);
}

// 把热区那三个函数原样求值，对着真实坐标跑一遍 —— 静态断言看不出 "clientY 阈值到底怎么算"。
// Evaluate the hot-zone helpers straight out of the module and drive them with real coordinates:
// a regex cannot tell whether the pointer threshold is actually being applied.
function loadStageHelpers(initial) {
  const source = [
    'var stageShelfPointerInside = false;',
    'var stageShelfHoldUntil = 0;',
    sliceFunction(layoutText, 'stageShelfHoldActive'),
    sliceFunction(layoutText, 'updateStageShelfPointerFromPointer'),
    sliceFunction(layoutText, 'stageShelfPreviewWanted'),
    '({',
    '  update: updateStageShelfPointerFromPointer,',
    '  wanted: stageShelfPreviewWanted,',
    '  inside: function () { return stageShelfPointerInside; },',
    '  setHold: function (v) { stageShelfHoldUntil = v; }',
    '})',
  ].join('\n');

  const state = Object.assign({ now: 1000, splash: false, mode: 'stage', alwaysVisible: false }, initial || {});
  const sandbox = {
    performance: { now: () => state.now },
    innerHeight: 800,
    shelfManager: { getMode: () => state.mode },
    shelfAlwaysVisible: () => state.alwaysVisible,
    document: { body: { classList: { contains: (cls) => state.splash && cls === 'splash-active' } } },
  };
  return { helpers: vm.runInNewContext(source, sandbox), state };
}

test('the stage hot zone is the bottom half of the screen', () => {
  const { helpers, state } = loadStageHelpers();

  helpers.update({ clientX: 900, clientY: 700 });
  assert.equal(helpers.inside(), true, 'a pointer in the bottom band must open the shelf');

  helpers.update({ clientX: 900, clientY: 120 });
  assert.equal(helpers.inside(), false, 'a pointer near the top must not keep it open');

  // 边界：0.55 * 800 = 440，落在阈值两侧要分别是关/开。
  helpers.update({ clientY: 439 });
  assert.equal(helpers.inside(), false);
  helpers.update({ clientY: 441 });
  assert.equal(helpers.inside(), true);

  // 指针离开窗口（传 null）与启动页期间都必须收起，否则热区状态会一直挂着。
  helpers.update(null);
  assert.equal(helpers.inside(), false, 'leaving the window must clear the hot zone');

  state.splash = true;
  helpers.update({ clientY: 700 });
  assert.equal(helpers.inside(), false, 'the splash screen must keep the shelf closed');
});

test('the hot zone only applies while the shelf is in stage mode', () => {
  const { helpers, state } = loadStageHelpers();

  state.mode = 'side';
  helpers.update({ clientY: 700 });
  assert.equal(helpers.inside(), false, 'side mode keeps its own right-edge cue; the bottom band must not leak into it');

  state.mode = 'off';
  helpers.update({ clientY: 700 });
  assert.equal(helpers.inside(), false);
});

test('"always" presence and the mode-switch grace period both want the shelf visible', () => {
  const { helpers, state } = loadStageHelpers();

  // 自动隐藏 + 指针不在底部 → 收起。
  helpers.update({ clientY: 100 });
  assert.equal(helpers.wanted(), false);

  // 「常驻」设置必须压过指针位置。
  state.alwaysVisible = true;
  assert.equal(helpers.wanted(), true, '"always" must win over the pointer position');
  state.alwaysVisible = false;

  // 刚切进舞台模式的宽限期：指针还在设置面板上，也要先显示出来。
  helpers.setHold(1000 + 1200);
  assert.equal(helpers.wanted(), true, 'the grace period must hold the shelf open right after switching');
  state.now = 1000 + 1201;
  assert.equal(helpers.wanted(), false, 'the grace period must expire');
});

test('the manager reads the hot zone instead of pinning stage visibility at 1.0', () => {
  const stageBranch = (managerText.match(/\} else \{\s*\n\s*\/\/ 舞台模式[\s\S]*?targetVis = [^;]+;\s*\n\s*\}/) || [''])[0];
  assert.ok(stageBranch, 'the stage branch of the visibility decision must keep its explanatory comment');
  assert.match(stageBranch, /stageShelfPreviewWanted\(\)/);
  // 「常驻」是在热区判定内部处理的（stageShelfPreviewWanted），不在 manager 里重复一遍。
  assert.match(
    sliceFunction(layoutText, 'stageShelfPreviewWanted'),
    /shelfAlwaysVisible\(\)/,
    'the "always" option has to be honoured in stage mode'
  );
  assert.match(stageBranch, /selectedIdx >= 0/, 'a selected card must keep the shelf open');
  assert.match(stageBranch, /contentList\.isOpen\(\)/, 'an open track list must keep the shelf open');

  // 旧写法：无条件 1.0 —— 那正是这条 issue 的根因。
  assert.doesNotMatch(managerText, /targetVis = allItems\.length \? 1\.0 : 0;/);
});

test('the group is hidden once it has faded out, so no stage residue is left behind', () => {
  // 残影源头：`mode !== 'side' || shelfVisibility > 0` 让舞台模式的 group 永远可见。
  assert.doesNotMatch(
    managerText,
    /group\.visible = [^;]*mode !== 'side'/,
    'stage mode must not keep the whole group visible after the cards faded out'
  );
  assert.match(
    managerText,
    /group\.visible = appRevealed\s*\n\s*&& shelfVisibility > 0\.002/,
    'visibility must be driven by the fade value in both modes'
  );
  // 连线粒子跟着 group 走，否则卡片没了它还在底部画线。
  assert.match(managerText, /connectorParticles\.visible = group\.visible && mode === 'stage'/);
});

test('pointer updates reach the stage hot zone through the single cue entry point', () => {
  const cueBody = (layoutText.match(/function updateShelfHoverCueFromPointer\(e\) \{[\s\S]*?\n\}/) || [''])[0];
  assert.ok(cueBody, 'updateShelfHoverCueFromPointer must exist');
  assert.ok(
    cueBody.indexOf('updateStageShelfPointerFromPointer(e)') < cueBody.indexOf('shelfPlaybackSwitchGuardActive()'),
    'the stage hot zone has to be updated before the guard early-returns'
  );
  // 进入舞台模式时要给宽限期，否则刚切过去就收起。
  assert.match(bindingsText, /if \(m === 'stage'\) stageShelfHoldUntil = performance\.now\(\) \+ 1200;/);
});
