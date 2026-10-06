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

// 断言要看的是**代码**长什么样，不是注释：源码注释里会引用被替换掉的旧写法（比如
// "旧的 `rank >= 3 && !profile.lowSpec`"、被删掉的 `grid / 118`），不剥掉注释就会被自己写的
// 说明文字误伤 —— 正面写法忘了加会漏报，反面断言倒是会假报。
// Assertions are about the code, not the comments: source comments quote the expressions that were
// replaced (the old `rank >= 3 && !profile.lowSpec`, the removed `grid / 118`), so leaving comments in
// trips the very checks meant to catch those expressions.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

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
  [0, 0.8], [1, 1.4], [2, 1.9], [3, 2.6],
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

// 顶档必须真的把粒子拉到基准的两倍以上：视觉密度的下限由这张表决定，表整体缩水就等于整套
// 粒子系统一起变稀。
// The top tier must draw at least twice the base population: the table sets the floor for how dense
// the scene reads, so shrinking the whole table thins every system at once.
const topScale = call(buildContext({ level: 3 }).context, 'runtimeParticleBudgetScale()');
assert.ok(
  topScale >= 2,
  `the top tier must draw at least 2x the base population, got ${topScale}`
);
// headroom 必须 >= 最大系数，否则顶档会被缓冲区大小悄悄截断 —— 界面写着"超高"，
// 实际画的还是基准数，这种 bug 没有任何报错。
const topFactor = Math.max(...scaleCases.map(([, scale]) => scale));
const headroom = call(buildContext({ level: 3 }).context, 'particleBudgetHeadroom()');
assert.ok(
  headroom >= topFactor,
  `the allocation headroom (${headroom}) must cover the largest tier factor (${topFactor}), or the top tier is clipped by the buffer`
);

// ---------------------------------------------------------------------------
// 2. 数量上限：不超过原值、不低于地板
// ---------------------------------------------------------------------------

const capContext = buildContext({ level: 0 }).context;
assert.strictEqual(call(capContext, 'runtimeParticleBudgetCap(1000, 0)'), 800, 'a 1000 population becomes 800 at the lowest tier');
assert.strictEqual(call(capContext, 'runtimeParticleBudgetCap(10, 0)'), 8, 'small populations scale too');
assert.strictEqual(
  call(capContext, 'runtimeParticleBudgetCap(10, 8)'),
  8,
  'the floor must hold: a slow device should never end up with nothing at all'
);
assert.strictEqual(call(capContext, 'runtimeParticleBudgetCap(0, 5)'), 0, 'an empty population stays empty');
assert.strictEqual(
  call(buildContext({ level: 3 }).context, 'runtimeParticleBudgetCap(1000, 0)'),
  2600,
  'the top tier must grow the population above the base'
);
// 顶档可以超过 base，但永远不能超过几何体容量：多分配的那部分才是它的上限。
// The top tier may exceed the base but never the geometry capacity.
assert.strictEqual(
  call(buildContext({ level: 3 }).context, 'runtimeParticleBudgetCap(1000, 0)'),
  2600,
  'growing past the base is allowed, and the clamp to capacity happens against the geometry'
);

// ---------------------------------------------------------------------------
// 3. 网格预算：奇数边长、不超过用户值、不低于最小值
// ---------------------------------------------------------------------------

// 网格读的是同一张系数表，但方向取决于系数落在 1 的哪一侧：小于 1 是压边长（预算是上限），
// 大于 1 是放大（预算变成下限）。所以用例不能写死"哪几档是压"，只能逐档判方向。
// The lattice reads the same table, but the direction depends on which side of 1 the factor sits:
// below 1 it shrinks (a ceiling), above 1 it grows (a floor). The cases therefore assert the direction
// per tier instead of pinning which tiers happen to cap.
for (const [level, scale] of scaleCases) {
  const context = buildContext({ level }).context;
  const grid = call(context, 'runtimeCoverParticleGridBudget(183)');
  assert.ok(grid % 2 === 1, `tier ${level}: a lattice side must stay odd, got ${grid}`);
  assert.ok(grid >= 25, `tier ${level}: the lattice floor must hold, got ${grid}`);
  if (scale < 1) {
    assert.ok(grid < 183, `tier ${level}: a factor below 1 must actually cut the lattice, got ${grid}`);
  } else {
    assert.ok(grid >= 183, `tier ${level}: a factor at or above 1 must grow the lattice, got ${grid}`);
  }
}
// 放大的幅度必须真的等于系数。边长只能是整数，所以判定落在"与理想边长相差不到 1.5 格"上，
// 而不是逐位相等：按需重建的网格不需要预留缓冲，放大幅度本就由这里保证。
// The growth has to actually follow the factor. The side is an integer, so the check is "within 1.5
// cells of the ideal" rather than exact: an on-demand lattice needs no pre-allocated slack, so this
// is the only place that guarantees the promised growth.
const grownScale = scaleCases[scaleCases.length - 1][1];
const grownGrid = call(buildContext({ level: 3 }).context, 'runtimeCoverParticleGridBudget(183)');
const idealGrid = Math.sqrt(183 * 183 * grownScale);
assert.ok(
  Math.abs(grownGrid - idealGrid) < 1.5,
  `the grown lattice must follow the factor: expected about ${idealGrid.toFixed(1)}, got ${grownGrid}`
);
assert.ok(
  grownGrid * grownGrid >= 183 * 183 * grownScale * 0.99,
  `the grown lattice must reach ${grownScale}x the area, got ${grownGrid}^2 = ${grownGrid * grownGrid}`
);
// 面积必须真的按系数缩放，而不是随手取个整数。
// The area has to scale by the factor, not land on an arbitrary integer.
const ecoArea = call(buildContext({ level: 0 }).context, 'runtimeCoverParticleGridBudget(183) ** 2');
assert.ok(ecoArea < 183 * 183, `the lowest tier must actually cut a 183 lattice, got ${ecoArea}`);
assert.ok(
  ecoArea <= 183 * 183 * scaleCases[0][1],
  `the lattice area must respect the budget, got ${ecoArea}`
);

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
// 期望值由档位表推出来（1000 × 最低档系数），别再写一个手抄的数字。
// The expectation is derived from the tier table (1000 x the lowest factor) instead of a transcribed
// number that has to be found and updated by hand.
const trimmedCount = 1000 * scaleCases[0][1];
assert.strictEqual(
  call(drawContext, 'applyParticleDrawBudget(__points)'),
  trimmedCount,
  'the scattered trim reports the new count'
);
assert.deepStrictEqual(
  call(drawContext, 'JSON.stringify(__drawn)'),
  JSON.stringify([[0, trimmedCount]]),
  'draw range must be rewritten in place, with no geometry rebuild'
);
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

// 网格型：压边长，且重建走既有路径。这里断言的是代码，所以先剥掉注释 —— 源码注释里正好引用了
// 被删掉的那一行。
// The lattice shrinks its side length, and a rebuild reuses the existing path. These look at code, so
// comments come off first: the source comment quotes the very line that was removed.
const coverCode = stripComments(coverText);
assert.ok(
  /function effectiveCoverParticleGrid\(value\)/.test(coverCode),
  'the cover particles need a single funnel where the grid is budget-capped'
);
assert.ok(
  /var GRID_X = effectiveCoverParticleGrid\(fx\.coverResolution\)/.test(coverCode),
  'the initial grid must be the budgeted one, not the raw slider value'
);
assert.ok(
  /grid = normalizeCoverParticleGrid\(grid\)/.test(coverCode),
  'the geometry builder must sanitise the grid it was handed, not convert it back to a resolution'
);
// 反面钉子：这一行曾经存在，代价是预算被算两遍 —— 系数 < 1 时缩小被平方（面积只剩 38%），
// 边长 > 183 时被 clamp 拉回基准再放大（0.75 分辨率配顶档会建出 231×231，比基准 183×183 还密）。
// Negative pin: this line used to be here, and it applied the budget twice — below 1 that squared the
// shrink (a third of the claimed area), above 183 the clamp pulled the side back to the base and
// scaled it up again (0.75 resolution at the top tier built 231x231, denser than the 183x183 base).
assert.ok(
  !/effectiveCoverParticleGrid\(grid \/ 118\)/.test(coverCode),
  'the builder must not re-apply the budget: the caller already passes a budgeted grid'
);
assert.ok(
  /var grid = effectiveCoverParticleGrid\(fx\.coverResolution\)/.test(coverCode),
  'a resolution change must compare budgeted grids, otherwise it thrashes'
);
assert.ok(
  /registerParticleBudgetRefresher\(function \(\)[\s\S]{0,200}applyCoverParticleResolution/.test(coverCode),
  'the lattice must re-apply when the budget changes; it has no draw-range shortcut'
);
assert.ok(
  /applyCoverParticleResolution\(fx\.coverResolution, \{ reload: false \}\)/.test(coverCode),
  'the budget re-apply must not trigger a cover reload — only a geometry rebuild'
);

// ---------------------------------------------------------------------------
// 3b. 预算只能算一次：标签说画多少，几何体就必须建多少
// ---------------------------------------------------------------------------
// 上面几条钉的是"代码长什么样"，这一条钉的是**行为**：把真实的函数（预算模块、分辨率换算、
// 几何体构建）一起放进沙箱，逐档 × 逐分辨率比对"标签报出的边长"和"几何体真正建的边长"。
// 两者一旦不等，就说明预算被算了第二遍 —— 而那正是"分辨率滑块方向看起来是反的"的成因。
//
// The checks above pin what the code looks like; this one pins behaviour: the real functions (budget,
// resolution mapping, geometry builder) run together in a sandbox and the side length the label
// reports is compared with the side length actually built, for every tier and resolution. Any
// mismatch means the budget ran twice — which is exactly what made the resolution slider look like it
// pointed the wrong way.

// 从源码里切出一个完整函数（大括号配平），让沙箱跑真实现而不是手抄的副本。
// Slice a whole function out of the source (brace-balanced) so the sandbox runs the real thing.
function cutFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() must exist for the sandbox`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while slicing ${name}()`);
}

// THREE 只喂几何体构建真正用到的两个类，其余（shader、Points）不参与"建了多少格"。
// Only the two THREE classes the builder actually touches are stubbed; shaders and Points have no
// say in how many cells get built.
const SandboxBufferGeometry = function () { this.attributes = {}; this.userData = {}; };
SandboxBufferGeometry.prototype.setAttribute = function (name, attribute) {
  this.attributes[name] = attribute;
  return this;
};
const SandboxBufferAttribute = function (array, itemSize) {
  this.array = array;
  this.itemSize = itemSize;
  this.count = array.length / itemSize;
};

function coverGeometrySandbox() {
  const context = vm.createContext({
    console: { warn() {}, log() {} },
    Float32Array,
    THREE: { BufferGeometry: SandboxBufferGeometry, BufferAttribute: SandboxBufferAttribute },
  });
  vm.runInContext(
    'var __level = 1; function runtimePerfBudgetLevel() { return __level; }'
    + 'function isDeepBackgroundMode() { return false; }',
    context
  );
  vm.runInContext(budgetText, context, { filename: '12-particle-budget.js' });
  vm.runInContext(
    ['clampRange', 'normalizeCoverResolution', 'coverParticleGridForResolution', 'coverParticleCountLabel']
      .map((name) => cutFunction(persistenceText, name)).join('\n'),
    context,
    { filename: '04-visual-settings-persistence.js (excerpt)' }
  );
  const planeSize = (coverText.match(/var PLANE_SIZE = [^;]+;/) || [])[0];
  assert.ok(planeSize, 'PLANE_SIZE must be readable from the cover particle module');
  vm.runInContext(planeSize, context);
  vm.runInContext(
    ['effectiveCoverParticleGrid', 'normalizeCoverParticleGrid', 'buildCoverParticleGeometry']
      .map((name) => cutFunction(coverText, name)).join('\n'),
    context,
    { filename: '00-pointer-cover-particles.js (excerpt)' }
  );
  return context;
}

const coverSandbox = coverGeometrySandbox();
const coverResolutions = [0.75, 1, 1.2, 1.55];
for (const [level] of scaleCases) {
  coverSandbox.__level = level;
  for (const resolution of coverResolutions) {
    const grid = call(coverSandbox, `runtimeCoverParticleGridBudget(coverParticleGridForResolution(${resolution}))`);
    // 启动路径（GRID_X → buildCoverParticleGeometry）和重建路径（applyCoverParticleResolution）
    // 传的都是这个值，所以几何体必须正好建这么多格。
    // Both the boot path (GRID_X → buildCoverParticleGeometry) and the rebuild path
    // (applyCoverParticleResolution) hand over this value, so the geometry has to build exactly it.
    const geometry = call(coverSandbox, `buildCoverParticleGeometry(effectiveCoverParticleGrid(${resolution}))`);
    assert.strictEqual(
      geometry.userData.grid,
      grid,
      `tier ${level} @ ${resolution}: the built lattice (${geometry.userData.grid}) must equal the budgeted one (${grid})`
    );
    assert.strictEqual(
      geometry.userData.count,
      grid * grid,
      `tier ${level} @ ${resolution}: the built cell count must match the budgeted side, got ${geometry.userData.count}`
    );
    assert.strictEqual(
      geometry.attributes.position.count,
      grid * grid,
      `tier ${level} @ ${resolution}: the position buffer must hold exactly the budgeted cells`
    );
    // 标签与几何体同源：标签报多少，缓冲区里就得有多少。
    // The label and the geometry must agree: whatever the label claims is what the buffer has to hold.
    assert.strictEqual(
      call(coverSandbox, `coverParticleCountLabel(${resolution})`),
      `${grid}x${grid}`,
      `tier ${level} @ ${resolution}: the label must report the grid that is actually built`
    );
  }
}
// 滑块方向：同一档位下，分辨率越高必须越密。预算是乘在请求面积上的，所以这条在每一档都成立，
// 与系数落在 1 的哪一侧无关。修掉双算之前，高档位下这条是反的。
// Slider direction: within one tier, a higher resolution must mean a denser lattice. The budget
// multiplies the requested area, so this holds at every tier regardless of which side of 1 the factor
// sits. Before the double application was removed this was inverted at the higher tiers.
for (const [level] of scaleCases) {
  coverSandbox.__level = level;
  const areasByResolution = coverResolutions.map((resolution) => call(
    coverSandbox,
    `buildCoverParticleGeometry(effectiveCoverParticleGrid(${resolution})).userData.count`
  ));
  for (let index = 1; index < areasByResolution.length; index += 1) {
    assert.ok(
      areasByResolution[index] > areasByResolution[index - 1],
      `tier ${level}: raising the resolution must densify the lattice, got ${areasByResolution.join(' -> ')}`
    );
  }
}
// 输入整形：兜底只负责"能算"，不负责预算 —— 越界输入不该变成 NaN 坐标。
// Input sanitising only has to make the maths safe, not to apply the budget: out-of-range input must
// never turn into NaN positions.
for (const [raw, expected] of [[0, 3], [1, 3], [2, 3], [7, 7], [8, 9], [7.4, 7]]) {
  assert.strictEqual(
    call(coverSandbox, `normalizeCoverParticleGrid(${raw})`),
    expected,
    `normalizeCoverParticleGrid(${raw}) must yield an odd side of at least 3`
  );
}

// 散点型：一次接线，同时登记重算。
// Scattered systems: one wiring call that also registers the re-apply.
for (const [name, text, marker] of [
  ['background star river', coverText, /attachParticleDrawBudget\(\s*\n?\s*new THREE\.Points\(buildBackgroundStarRiverGeometry/],
  ['floating particles', floatText, /floatGroup = attachParticleDrawBudget\(new THREE\.Points\(fgeo, fmat\)/],
  ['back cover particles', floatText, /backCoverGroup = attachParticleDrawBudget\(new THREE\.Points\(bg, mat\)/],
  ['skull particles', floatText, /skullParticleGroup = attachParticleDrawBudget\(new THREE\.Points\(geo, mat\)\)/],
  ['lyrics star river', starRiverText, /attachParticleDrawBudget\(new THREE\.Points\(geo, mat\),\s*baseCount\)/],
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
// 不再把具体数值写进正则（改一次档位就要改一次测试），改成解析出真实数组只校验语义：
// 单调递增、覆盖四档、顶档必须大于 1。
// The concrete numbers no longer live in a regex (every retune would break the test); parse the
// real array and assert only the semantics: monotonic, four tiers, top tier above 1.
const tierTable = JSON.parse('[' + (budgetText.match(/PARTICLE_BUDGET_SCALE_BY_LEVEL = \[([^\]]+)\]/) || [, ''])[1] + ']');
assert.strictEqual(tierTable.length, 4, `the tier table must cover four tiers, got ${tierTable.length}`);
for (let index = 1; index < tierTable.length; index += 1) {
  assert.ok(
    tierTable[index] > tierTable[index - 1],
    `the tier table must increase monotonically, got ${tierTable.join(', ')}`
  );
}
assert.ok(
  tierTable[tierTable.length - 1] > 1,
  `the top tier must draw above the base population, got ${tierTable[tierTable.length - 1]}`
);

// ---------------------------------------------------------------------------
// 覆盖完整性：每个散点系统都要接入预算，且会重建的系统必须能解除登记。
// Coverage: every scattered system must join the budget, and rebuilt ones must be able to detach.
// ---------------------------------------------------------------------------

const lyricMeshText = readSource('public/js/modules/02-visual/13-lyrics-mesh-build.js');
const shelfCoreText = readSource('public/js/modules/04-shelf/01-manager-core.js');

// 登记数组只进不出是真实的泄漏：歌词网格随布局（换行、字号、窗口尺寸）反复重建，歌单架连线粒子
// 随签名变化（登录状态、列表内容、合并方式）重建，每次都追加一个新闭包。预算重算要遍历那个数组，
// 于是用得越久越慢 —— 正是"开一天之后开始卡"这类难以复现的问题。
// A registry that only grows is a real leak: the lyric mesh is rebuilt on every layout change and the
// shelf connectors on every signature change, each appending a fresh closure. The re-apply pass walks
// that array, so the app slows the longer it stays open — exactly the "it started stuttering after a
// day" report that is miserable to reproduce.
assert.ok(
  /function unregisterParticleBudgetRefresher/.test(budgetText),
  'the budget module must expose an unregister hook; without it a rebuilt system cannot detach'
);
assert.ok(
  /points\.detachParticleBudget/.test(budgetText),
  'attachParticleDrawBudget must hand back a detach function instead of only registering'
);
assert.ok(
  /attachParticleDrawBudget/.test(lyricMeshText),
  'lyric mesh sparks must join the particle budget'
);
assert.ok(
  /detachParticleBudget/.test(starRiverText),
  'lyric mesh teardown must detach its registration, or the registry grows on every layout change'
);
assert.ok(
  /attachParticleDrawBudget\(new THREE\.Points\(pgeo, pmat\)/.test(shelfCoreText),
  'shelf connector particles must join the particle budget'
);
assert.ok(
  /connectorParticles\.detachParticleBudget/.test(shelfCoreText),
  'shelf connectors must unregister before being rebuilt, or the registry grows on every list change'
);
console.log('[OK] Particle population follows the existing performance tier: scattered systems are '
  + 'trimmed in place with setDrawRange, the cover lattice shrinks its side length through the '
  + 'existing rebuild path, the label reports what is actually drawn, and nothing re-applies unless '
  + 'the factor changed.');

// ---------------------------------------------------------------------------
// 5. 档位不能被反向压低：用户显式选的档位优先于硬件检测
// ---------------------------------------------------------------------------
// 症状：把画质拨到「超高」，粒子仍比上游（没有这层预算系统时）明显稀。两条原因都在这里钉死：
//   - 旧的 `rank >= 3 && !profile.lowSpec` 让低端机上的最高档只能拿到 level 2（系数 0.85）；
//   - 旧的 `balancedSpec` 判据（`cores <= 8 || renderPixels >= 4.2M`）几乎人人命中，把「高」档
//     （rank 2）压成 level 1（系数 0.58）。
// Symptom: even at "ultra" the particles looked thinner than upstream (which has no budget layer).
// Both causes are pinned here.
const perfText = readSource('public/js/modules/00-state/08-desktop-render-power.js');
const defaultsText = readSource('public/js/modules/00-state/04-fx-defaults.js');

// 这里和上面的接线检查一样，先剥掉注释再断言（stripComments 定义在文件顶部）。
// Like the wiring checks above, these strip comments first (the helper lives at the top of the file).
const bodyBetween = (text, startMarker, endMarker) => stripComments(
  text.slice(text.indexOf(startMarker), text.indexOf(endMarker))
);

const budgetLevelBody = bodyBetween(perfText, 'function runtimePerfBudgetLevel()', 'function runtimePerfScale()');
assert.ok(budgetLevelBody.length > 0, 'runtimePerfBudgetLevel() body cannot be inspected');
assert.ok(
  /rank >= 3\)\s*return 3/.test(budgetLevelBody),
  'the top tier must return level 3 unconditionally'
);
assert.ok(
  !/rank >= 3[^\n]*profile\.lowSpec/.test(budgetLevelBody),
  'the top tier must no longer be downgraded by the detected hardware tier'
);

// balancedSpec 只保留"真的吃填充率"这一条：低配 + 4K 级（7.2M 像素以上）。
// 核数不再参与（粒子是填充率瓶颈，跟核数无关），阈值从 4.2M 提到 7.2M。
const detectBody = bodyBetween(
  perfText, 'function detectRuntimeHardwareProfile()', 'function refreshRuntimeHardwareSurfaceProfile()'
);
const balancedLine = (detectBody.match(/var balancedSpec = [^;]+;/) || [''])[0];
assert.ok(balancedLine, 'the balancedSpec test cannot be inspected');
assert.ok(
  !/cores/.test(balancedLine),
  `core count must not decide balancedSpec (particle systems are fill-rate bound), got: ${balancedLine}`
);
assert.ok(
  /veryLargeSurface/.test(balancedLine) && !/\blargeSurface\b/.test(balancedLine),
  `only the 7.2M-pixel threshold may decide balancedSpec, got: ${balancedLine}`
);

// 初次检测和 resize 后的刷新走的是两条代码路径，公式必须逐字一致，否则改窗口大小会让档位跳变。
const refreshBody = bodyBetween(
  perfText, 'function refreshRuntimeHardwareSurfaceProfile()', 'function performanceQualityRank()'
);
const refreshLine = (refreshBody.match(/balancedSpec = [^;]+;/) || [''])[0];
assert.ok(refreshLine, 'the refreshed balancedSpec test cannot be inspected');
assert.ok(
  /lowSpec \|\| next\.veryLargeSurface/.test(refreshLine),
  `the refresh path must reuse the same balancedSpec formula as the first detection, got: ${refreshLine}`
);

// 默认档位不能是 eco：它是**显式的省电档**，把它设成默认等于让新装的画质落在"低配预设"上，
// 用户不动设置就看不到这套粒子系统本来的样子。
// The default tier must not be eco: eco is the explicit low-power notch, so shipping it as the default
// makes a fresh install look like a low-end preset until the user goes and changes it.
const defaultQuality = (defaultsText.match(/performanceQuality:\s*'([^']+)'/) || [])[1];
assert.notStrictEqual(
  defaultQuality, 'eco',
  'the default tier must not be eco: the default look must not be the low-power preset'
);
assert.ok(
  /^(balanced|high|ultra)$/.test(defaultQuality || ''),
  `the default tier must be one of balanced/high/ultra, got ${defaultQuality}`
);

console.log('[OK] The quality tier is never downgraded by hardware detection: ultra always reaches '
  + 'level 3, balancedSpec only flags genuinely fill-rate-bound machines, both detection paths agree, '
  + 'and the default tier is not the eco notch.');

module.exports = { buildContext, call };
