// 粒子规模预算 / Particle population budget.
//
// 现有粒子系统只做了"帧率门控"：低性能时少跑几帧，但粒子的**数量不变**，每帧的顶点和填充
// 负担一点没少。对填充率受限的设备（集显、核显、4K 面板）来说，砍规模比降帧率有效得多——
// 少画八成粒子换来的是实打实的填充率，而少跑帧只损失流畅度、不省每帧成本。
//
// The existing systems only throttle the frame rate: on a slow device they run fewer frames, but
// the population stays at full size, so the per-frame vertex and fill cost is unchanged. Shrinking
// the population is the lever that actually returns fill rate; dropping frames only costs
// smoothness and saves nothing per frame.
//
// 预算跟着既有的 performanceQuality 档位走（eco / balanced / ultra，再叠加检测到的硬件档位），
// 不新增配置项：项目已经有一个"性能"旋钮，粒子规模本就该由它决定，而不是再挂一个用户看不懂
// 的数字。用户显式选择的画质仍然优先——预算只在它之上做上限，不会把"高画质"反向拉低。
//
// The budget rides the existing performanceQuality setting (eco / balanced / ultra layered over
// the detected hardware tier) and adds no new knob: the project already has a performance dial and
// the population should follow it rather than expose another number nobody can interpret. An
// explicit user choice still wins — the budget only ever caps it from above.
//
// 两种裁剪方式，按粒子的排布决定：
//  - 散点（星河 / 漂浮 / 封底 / 骷髅）：setDrawRange，即时生效，不重建几何、不重新分配缓冲。
//  - 网格（封面粒子）：drawRange 是按行优先截断，画前 N 个会让画面缺一条带子，所以只能压边长。
//
// Two trimming mechanisms, chosen by how the particles are laid out: scattered systems are trimmed
// with setDrawRange (instant, no rebuild); a lattice cannot be, because draw order is row-major and
// drawing the first N would cut a band out of the picture, so its side length has to shrink.

// 每档的规模系数。低于 1 才有意义；高档位保持 1，用户选了 ultra 就不该被悄悄削减。
// Population factor per tier. Only below 1 does anything; the top tier stays at 1 so choosing
// ultra is never silently downgraded.
var PARTICLE_BUDGET_SCALE_BY_LEVEL = [0.28, 0.58, 0.85, 1];

// 深度后台模式（窗口不可见）下再压一档：这时没人看得见画面，但渲染仍在跑。
// One more notch in deep background mode: nobody can see the window, yet rendering keeps running.
var PARTICLE_BUDGET_DEEP_BACKGROUND_SCALE = 0.2;

// 网格粒子的最小边长。再低就看不出是封面纹理而不是色块了。
// Floor for the lattice side length: below this it stops reading as cover art and becomes a blob.
var PARTICLE_BUDGET_MIN_GRID = 25;

var particleBudgetRefreshers = [];
var particleBudgetAppliedScale = -1;

function runtimeParticleBudgetScale() {
  if (typeof isDeepBackgroundMode === 'function' && isDeepBackgroundMode()) {
    return PARTICLE_BUDGET_DEEP_BACKGROUND_SCALE;
  }
  var level = (typeof runtimePerfBudgetLevel === 'function') ? runtimePerfBudgetLevel() : 2;
  level = Math.max(0, Math.min(PARTICLE_BUDGET_SCALE_BY_LEVEL.length - 1, Math.round(Number(level) || 0)));
  return PARTICLE_BUDGET_SCALE_BY_LEVEL[level];
}

// 按系数压一个数量级，并保证不会低于 floor（免得低配下一个粒子都不剩）。
// Scale a population by the factor, never dropping below the floor so a slow device does not end
// up with nothing at all.
function runtimeParticleBudgetCap(baseCount, floor) {
  var base = Math.max(0, Math.floor(Number(baseCount) || 0));
  if (!base) return 0;
  var minimum = Math.max(0, Math.floor(Number(floor) || 0));
  return Math.max(minimum, Math.min(base, Math.round(base * runtimeParticleBudgetScale())));
}

// 网格型粒子上限：按面积开方得到边长，再夹在用户值与最小边长之间。
// Cap a lattice by side length: take the square root of the area budget, then clamp between the
// requested value and the floor.
function runtimeCoverParticleGridBudget(userGrid) {
  var requested = Math.max(8, Math.round(Number(userGrid) || 0));
  var scale = runtimeParticleBudgetScale();
  if (scale >= 1) return requested;
  // 先向下取整再对齐奇数：预算是**上限**，任何一步向上取整都会让实际面积反过来超出预算
  // （183 格、0.28 系数时 √9376.9 ≈ 96.8，round 到 97 之后 97² 已经越界）。
  // Floor first, then align to odd: the budget is a ceiling, and any upward rounding pushes the
  // drawn area back over it (at 183 with a 0.28 factor, √9376.9 ≈ 96.8 and rounding to 97 already
  // overshoots).
  var target = Math.floor(Math.sqrt(requested * requested * scale));
  var capped = Math.max(PARTICLE_BUDGET_MIN_GRID, target);
  if (capped % 2 === 0) capped -= 1;
  return Math.min(requested, capped);
}

// 从几何体本身读出粒子数：优先用构建时记下的 userData.count，其次退回 position 属性的顶点数。
// 让每个系统自己传常量容易接错（换一个几何体就忘了同步），从几何体读则永远和实际缓冲区一致。
// Read the population from the geometry itself: prefer the count recorded at build time, otherwise
// fall back to the position attribute. Letting each system pass its own constant is easy to get
// wrong (swap a geometry and the constant goes stale), while the geometry is always in sync.
function particleGeometryCount(geometry) {
  if (!geometry) return 0;
  if (geometry.userData && Number(geometry.userData.count) > 0) {
    return Math.floor(Number(geometry.userData.count));
  }
  var position = typeof geometry.getAttribute === 'function' ? geometry.getAttribute('position') : null;
  return position && Number(position.count) > 0 ? Math.floor(Number(position.count)) : 0;
}

// 散点型粒子上限：直接改 drawRange，不碰几何和缓冲。
// Cap a scattered population by rewriting the draw range; geometry and buffers are untouched.
function applyParticleDrawBudget(points, baseCount, floor) {
  var target = points || null;
  if (!target || !target.geometry || typeof target.geometry.setDrawRange !== 'function') return 0;
  var declared = baseCount === undefined || baseCount === null
    ? particleGeometryCount(target.geometry)
    : Number(baseCount) || 0;
  var cap = runtimeParticleBudgetCap(declared, floor);
  target.geometry.setDrawRange(0, cap);
  return cap;
}

// 建点对象时一次接线：立刻裁一次，并把"预算变了再裁一次"登记好，省得每个系统各写一遍。
// points.detachParticleBudget() 可解除登记 —— **会随布局重建的系统必须在 dispose 时调用**。
// Wire a scattered system in one call: trim it now and register the re-trim, so no system has to
// repeat the boilerplate. points.detachParticleBudget() unregisters again, which **any system that
// is rebuilt must call from its dispose path**.
function attachParticleDrawBudget(points, baseCount, floor) {
  applyParticleDrawBudget(points, baseCount, floor);
  var refresher = function () {
    applyParticleDrawBudget(points, baseCount, floor);
  };
  registerParticleBudgetRefresher(refresher);
  if (points && typeof points === 'object') {
    try {
      points.detachParticleBudget = function () {
        unregisterParticleBudgetRefresher(refresher);
      };
    } catch (_) { }
  }
  return points;
}

// 各粒子系统在预算变化时登记一次重算入口；深背景模式的进出、画质切换都会触发。
// Each system registers one re-apply hook; deep-background transitions and quality changes fire it.
function registerParticleBudgetRefresher(fn) {
  if (typeof fn !== 'function') return false;
  if (particleBudgetRefreshers.indexOf(fn) >= 0) return false;
  particleBudgetRefreshers.push(fn);
  return true;
}

// 解除登记。**会随布局反复重建的系统必须用**：每次重建都 register 一个新闭包，
// particleBudgetRefreshers 只进不出就会无限增长 —— 那是一次真实的内存泄漏，而且每帧的
// 重算循环会遍历越来越长的数组，帧率随使用时长单调下降。
//
// 长期存在的系统（银河、封面点阵等）不需要它，它们在进程生命周期内只登记一次。
//
// Unregister a hook. **Systems that are rebuilt repeatedly must use this**: each rebuild registers a
// fresh closure, and since particleBudgetRefreshers only ever grew, that was a real leak — and the
// re-apply loop walked a longer array every time, so the frame rate decayed with uptime.
//
// Long-lived systems (the star river, the cover lattice) do not need it: they register once per
// process.
function unregisterParticleBudgetRefresher(fn) {
  if (typeof fn !== 'function') return false;
  var index = particleBudgetRefreshers.indexOf(fn);
  if (index < 0) return false;
  particleBudgetRefreshers.splice(index, 1);
  return true;
}

function refreshParticleBudget() {
  particleBudgetAppliedScale = runtimeParticleBudgetScale();
  for (var i = 0; i < particleBudgetRefreshers.length; i++) {
    // 单个系统重算失败不该连累其余系统：预算是降级手段，不能自己变成故障源。
    // One system failing to re-apply must not take the rest down; a degradation mechanism must
    // never become a new failure mode.
    try { particleBudgetRefreshers[i](); } catch (error) {
      console.warn('[ParticleBudget] refresher failed:', error && (error.message || error) || error);
    }
  }
  return particleBudgetAppliedScale;
}

// 每帧调一次，只在系数真的变了时才重算。深背景状态是每帧动态读出来的（没有"切换点"可以挂），
// 所以用比较代替钩子：稳定状态下它只是一次数值比较，绝不碰几何。
// Called once per frame and re-applies only when the factor actually changed. Deep-background state
// is read dynamically every frame with no transition to hook, so a comparison replaces a hook: in a
// steady state this is one numeric compare and never touches geometry.
function tickParticleBudget() {
  var scale = runtimeParticleBudgetScale();
  if (particleBudgetAppliedScale >= 0 && Math.abs(scale - particleBudgetAppliedScale) < 0.001) return 0;
  return refreshParticleBudget();
}

function particleBudgetCurrentScale() {
  return particleBudgetAppliedScale >= 0 ? particleBudgetAppliedScale : runtimeParticleBudgetScale();
}
