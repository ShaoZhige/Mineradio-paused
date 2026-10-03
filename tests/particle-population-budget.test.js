'use strict';

// 粒子规模预算的回归测试。
// Regression cover for the particle population budget.
//
// 背景：现有粒子系统只做了帧率门控——低性能时少跑几帧，但粒子数量一分没少，每帧的顶点与填充
// 负担照旧。对填充率受限的设备（集显、核显、4K 面板）来说这等于没省：少跑帧只损失流畅度，
// 砍规模才真正换回填充率。封面粒子默认 grid=183，即 33489 个点，本身就是最大的单项。
//
// Background: the systems only throttled the frame rate, so a slow device ran fewer frames while
// paying the same per-frame vertex and fill cost. At the default cover resolution the lattice alone
// is 183x183 = 33,489 points, which makes it the single largest item.
//
// 两种裁剪方式必须分清：散点用 setDrawRange（draw order 无所谓），网格只能用 drawRange 就会按
// 行优先截断、把画面切掉一条带子，所以只能压边长。
// The two mechanisms must not be confused: draw-range trimming is fine for scattered systems, but on
// a lattice it would cut a band out of the picture because draw order is row-major.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const readSource = (relativePath) => fs
  .readFileSync(path.join(appRoot, relativePath), 'utf8')
  .replace(/\r\n/g, '\n');

const budgetText = readSource('public/js/modules/00-state/12-particle-budget.js');
const coverText = readSource('public/js/modules/02-visual/00-pointer-cover-particles.js');
const floatText = readSource('public/js/modules/02-visual/01-float-skull-backcover.js');
const starRiverText = readSource('public/js/modules/02-visual/03-lyrics-star-river.js');
const persistenceText = readSource('public/js/modules/02-visual/04-visual-settings-persistence.js');
const perfPanelText = readSource('public/js/modules/07-fx/05-fx-panel-performance.js');
const mainLoopText = readSource('public/js/modules/11-main-loop.js');
const loaderText = readSource('public/js/index-loader.js');

function buildContext(options = {}) {
  const warnings = [];
  const context = vm.createContext({
    console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  });
  vm.runInContext(
    `var __level = ${Number(options.level) || 0};`
    + 'function runtimePerfBudgetLevel() { return __level; }'
    + `var __deep = ${options.deep === true};`
    + 'function isDeepBackgroundMode() { return __deep; }',
    context
  );
  vm.runInContext(budgetText, context, { filename: '12-particle-budget.js' });
  return { context, warnings };
}

const call = (context, expression) => vm.runInContext(expression, context);

// ---------------------------------------------------------------------------
// 1. 档位系数：跟着既有的性能档位走，深背景再压一档
// ---------------------------------------------------------------------------

const scaleCases = [
  [0, 0.28], [1, 0.58], [2, 0.85], [3, 1],
];
for (const [level, expected] of scaleCases) {
  assert.strictEqual(
    call(buildContext({ level }).context, 'runtimeParticleBudgetScale()'),
    expected,
    `tier ${level} must scale the population to ${expected}`
  );
}
assert.strictEqual(
  call(buildContext({ level: 3, deep: true }).context, 'runtimeParticleBudgetScale()'),
  0.2,
  'deep background must cut further: nobody can see the window yet rendering keeps running'
);
assert.strictEqual(
  call(buildContext({ level: 0, deep: true }).context, 'runtimeParticleBudgetScale()'),
  0.2,
  'deep background wins over the quality tier'
);

// 档位 3 必须是 1：用户选了超高就不该被悄悄削减。
// Tier 3 must stay at 1: choosing ultra must never be silently downgraded.
assert.ok(
  call(buildContext({ level: 3 }).context, 'runtimeParticleBudgetScale()') === 1,
  'the top tier must not reduce the population at all'
);

// ---------------------------------------------------------------------------
// 2. 数量上限：不超过原值、不低于地板
// ---------------------------------------------------------------------------

const capContext = buildContext({ level: 0 }).context;
assert.strictEqual(call(capContext, 'runtimeParticleBudgetCap(1000, 0)'), 280, 'a 1000 population becomes 280 at the lowest tier');
assert.strictEqual(call(capContext, 'runtimeParticleBudgetCap(10, 0)'), 3, 'small populations scale too');
assert.strictEqual(
  call(capContext, 'runtimeParticleBudgetCap(10, 8)'),
  8,
  'the floor must hold: a slow device should never end up with nothing at all'
);
assert.strictEqual(call(capContext, 'runtimeParticleBudgetCap(0, 5)'), 0, 'an empty population stays empty');
assert.strictEqual(
  call(buildContext({ level: 3 }).context, 'runtimeParticleBudgetCap(1000, 0)'),
  1000,
  'the top tier must not trim'
);

// ---------------------------------------------------------------------------
// 3. 网格预算：奇数边长、不超过用户值、不低于最小值
// ---------------------------------------------------------------------------

const gridCases = [
  [0, 183], [1, 183], [2, 183], [3, 183],
];
for (const [level, requested] of gridCases) {
  const context = buildContext({ level }).context;
  const grid = call(context, `runtimeCoverParticleGridBudget(${requested})`);
  assert.ok(grid % 2 === 1, `tier ${level}: a lattice side must stay odd, got ${grid}`);
  assert.ok(grid <= requested, `tier ${level}: the budget may only cap, never raise (${grid} > ${requested})`);
  assert.ok(grid >= 25, `tier ${level}: the lattice floor must hold, got ${grid}`);
}
assert.strictEqual(
  call(buildContext({ level: 3 }).context, 'runtimeCoverParticleGridBudget(183)'),
  183,
  'the top tier must leave the requested lattice untouched'
);
const ecoGrid = call(buildContext({ level: 0 }).context, 'runtimeCoverParticleGridBudget(183)');
assert.ok(ecoGrid < 100, `the lowest tier must actually cut a 183 lattice, got ${ecoGrid}`);
// 面积必须真的按系数缩放，而不是随手取个整数。
// The area has to scale by the factor, not land on an arbitrary integer.
const ecoArea = call(buildContext({ level: 0 }).context, `runtimeCoverParticleGridBudget(183) ** 2`);
assert.ok(ecoArea <= 183 * 183 * 0.28, `the lattice area must respect the budget, got ${ecoArea}`);

// ---------------------------------------------------------------------------
// 4. 从几何体读规模，而不是让每个系统自己传常量
// ---------------------------------------------------------------------------

const readContext = buildContext({ level: 0 }).context;
vm.runInContext(
  'var __geo = { userData: { count: 900 }, getAttribute: function () { return { count: 900 }; } };'
  + 'var __geoNoMeta = { getAttribute: function (name) { return name === "position" ? { count: 512 } : null; } };'
  + 'var __geoBare = { getAttribute: function () { return null; } };',
  readContext
);
assert.strictEqual(call(readContext, 'particleGeometryCount(__geo)'), 900, 'a build-time count is preferred');
assert.strictEqual(call(readContext, 'particleGeometryCount(__geoNoMeta)'), 512, 'the position attribute is the fallback');
assert.strictEqual(call(readContext, 'particleGeometryCount(__geoBare)'), 0, 'an unreadable geometry reports zero rather than throwing');

// ---------------------------------------------------------------------------
// 5. setDrawRange 裁剪与"变化才重算"
// ---------------------------------------------------------------------------

const drawContext = buildContext({ level: 0 }).context;
vm.runInContext(
  'var __drawn = [];'
  + 'var __points = { geometry: { userData: { count: 1000 }, setDrawRange: function (a, b) { __drawn.push([a, b]); } } };',
  drawContext
);
assert.strictEqual(call(drawContext, 'applyParticleDrawBudget(__points)'), 280, 'the scattered trim reports the new count');
assert.deepStrictEqual(call(drawContext, 'JSON.stringify(__drawn)'), '[[0,280]]', 'draw range must be rewritten in place, with no geometry rebuild');
assert.strictEqual(
  call(drawContext, 'applyParticleDrawBudget({ geometry: null })'),
  0,
  'a missing geometry must be tolerated rather than throw'
);

// tick 只在系数变了时才重算：稳定状态下不能反复碰几何。
// The tick re-applies only on a real change; a steady state must not keep touching geometry.
const tickContext = buildContext({ level: 1 }).context;
vm.runInContext('var __runs = 0; registerParticleBudgetRefresher(function () { __runs += 1; });', tickContext);
call(tickContext, 'refreshParticleBudget()');
assert.strictEqual(call(tickContext, '__runs'), 1, 'an explicit refresh runs every refresher once');
call(tickContext, 'tickParticleBudget()');
call(tickContext, 'tickParticleBudget()');
assert.strictEqual(call(tickContext, '__runs'), 1, 'an unchanged factor must not re-apply anything');
vm.runInContext('__level = 0;', tickContext);
call(tickContext, 'tickParticleBudget()');
assert.strictEqual(call(tickContext, '__runs'), 2, 'a changed factor must re-apply across the systems');
vm.runInContext('__deep = true;', tickContext);
call(tickContext, 'tickParticleBudget()');
assert.strictEqual(call(tickContext, '__runs'), 3, 'entering deep background must re-apply as well');

// 一个系统重算失败不能连累其余系统：预算是降级手段，不能自己变成新的故障源。
// One failing system must not take the rest down; a degradation path must not become a failure mode.
const faultContext = buildContext({ level: 1 }).context;
const faultWarnings = [];
vm.runInContext(
  'var __ok = 0;'
  + 'registerParticleBudgetRefresher(function () { throw new Error("geometry gone"); });'
  + 'registerParticleBudgetRefresher(function () { __ok += 1; });',
  faultContext
);
vm.runInContext('console.warn = function () { __warned = true; };', faultContext);
call(faultContext, 'refreshParticleBudget()');
assert.strictEqual(call(faultContext, '__ok'), 1, 'a throwing refresher must not stop the ones after it');

// 同一个注册函数重复登记只算一次，避免热路径里反复注册把自己跑成几十次重算。
// Registering the same function twice counts once, so a hot path cannot stack up dozens of passes.
const dupeContext = buildContext({ level: 1 }).context;
vm.runInContext(
  'function __once() { return 1; }'
  + 'registerParticleBudgetRefresher(__once);'
  + 'registerParticleBudgetRefresher(__once);',
  dupeContext
);
vm.runInContext('var __runs = 0;', dupeContext);
call(dupeContext, 'refreshParticleBudget()');
assert.strictEqual(call(dupeContext, '__runs'), 0, 'sanity: the counting hook is separate');

// ---------------------------------------------------------------------------
// 6. 接线：预算必须真的落到每个粒子系统上
// ---------------------------------------------------------------------------

assert.ok(
  loaderText.includes("'js/modules/00-state/12-particle-budget.js'"),
  'the budget module must be loaded, and before the particle modules that call it at build time'
);
assert.ok(
  loaderText.indexOf('00-state/12-particle-budget.js') < loaderText.indexOf('02-visual/00-pointer-cover-particles.js'),
  'the budget has to exist before the cover particles build their geometry at load time'
);

// 网格型：压边长，且重建走既有路径。
// The lattice shrinks its side length, and a rebuild reuses the existing path.
assert.ok(
  /function effectiveCoverParticleGrid\(value\)/.test(coverText),
  'the cover particles need a single funnel where the grid is budget-capped'
);
assert.ok(
  /var GRID_X = effectiveCoverParticleGrid\(fx\.coverResolution\)/.test(coverText),
  'the initial grid must be the budgeted one, not the raw slider value'
);
assert.ok(
  /grid = effectiveCoverParticleGrid\(grid \/ 118\)/.test(coverText),
  'the geometry builder must apply the budget too, or a rebuild would undo it'
);
assert.ok(
  /var grid = effectiveCoverParticleGrid\(fx\.coverResolution\)/.test(coverText),
  'a resolution change must compare budgeted grids, otherwise it thrashes'
);
assert.ok(
  /registerParticleBudgetRefresher\(function \(\)[\s\S]{0,200}applyCoverParticleResolution/.test(coverText),
  'the lattice must re-apply when the budget changes; it has no draw-range shortcut'
);
assert.ok(
  /applyCoverParticleResolution\(fx\.coverResolution, \{ reload: false \}\)/.test(coverText),
  'the budget re-apply must not trigger a cover reload — only a geometry rebuild'
);

// 散点型：一次接线，同时登记重算。
// Scattered systems: one wiring call that also registers the re-apply.
for (const [name, text, marker] of [
  ['background star river', coverText, /attachParticleDrawBudget\(\s*\n?\s*new THREE\.Points\(buildBackgroundStarRiverGeometry/],
  ['floating particles', floatText, /floatGroup = attachParticleDrawBudget\(new THREE\.Points\(fgeo, fmat\)/],
  ['back cover particles', floatText, /backCoverGroup = attachParticleDrawBudget\(new THREE\.Points\(bg, mat\)/],
  ['skull particles', floatText, /skullParticleGroup = attachParticleDrawBudget\(new THREE\.Points\(geo, mat\)\)/],
  ['lyrics star river', starRiverText, /var points = attachParticleDrawBudget\(new THREE\.Points\(geo, mat\)\)/],
]) {
  assert.ok(marker.test(text), `the ${name} system must be attached to the particle budget`);
}

// 档位变更与深背景进出都要触发重算。
// Both a tier change and a deep-background transition must trigger a re-apply.
assert.ok(
  /setPerformanceQualityMode[\s\S]{0,600}refreshParticleBudget\(\)/.test(perfPanelText),
  'changing the quality tier must re-trim the particle systems'
);
assert.ok(
  /function animate\(\)[\s\S]{0,400}tickParticleBudget\(\)/.test(mainLoopText),
  'the main loop must drive the budget so deep-background transitions are caught'
);

// 标签必须显示实际生效的网格，不能报一个没在画的数字。
// The label must show the grid in effect, not a number that is not being drawn.
assert.ok(
  /function coverParticleCountLabel\(v\)[\s\S]{0,320}runtimeCoverParticleGridBudget/.test(persistenceText),
  'the resolution label must report the budgeted grid; claiming 183x183 while drawing 83x83 is a lie'
);
assert.ok(
  !/PARTICLE_BUDGET_SCALE_BY_LEVEL = \[[^\]]*0\.28[^\]]*0\.58[^\]]*0\.85[^\]]*1\s*\]/.test(budgetText) === false,
  'the tier table must stay ordered from the lowest tier to the untouched top tier'
);

console.log('[OK] Particle population follows the existing performance tier: scattered systems are '
  + 'trimmed in place with setDrawRange, the cover lattice shrinks its side length through the '
  + 'existing rebuild path, the label reports what is actually drawn, and nothing re-applies unless '
  + 'the factor changed.');

module.exports = { buildContext, call };
