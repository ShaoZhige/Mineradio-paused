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

// 每档的规模系数（相对各系统自己的基准数量）。整张表就是**一个密度旋钮**：四档同乘一个倍数，
// 画面上所有系统的粒子就按同一比例加浓，而档与档之间的间距保持不变 —— 想整体变密就改这里，
// 不要去动各系统的基准常量（那等于把"基准"这个参照点也一起搬走）。
// 顶档大于 1，所以要的是"比基准更多"，几何体必须按 PARTICLE_BUDGET_HEADROOM 预留余量，
// 否则 setDrawRange 会超出已分配的顶点数。
// Population factor per tier, relative to each system's own base count. The table is **one density
// dial**: multiplying all four tiers by the same factor thickens every system on screen by that ratio
// while keeping the spacing between tiers intact, so a global density change belongs here rather than
// in each system's base constant (which would move the reference point itself). The top tier exceeds
// 1 on purpose, so geometries must be allocated with PARTICLE_BUDGET_HEADROOM of slack; otherwise
// setDrawRange runs past the end of the buffer.
var PARTICLE_BUDGET_SCALE_BY_LEVEL = [0.8, 1.4, 1.9, 2.6];

// 几何体预分配的余量倍数。必须 >= 系数表的最大值，否则顶档会被缓冲区大小悄悄截断 ——
// 那是最难查的一类 bug：设置里写着"超高"，实际画的还是基准数。
// 它跟着系数表走：能画多少的上限是缓冲区给的，表翻倍而这里不动，顶档就会悄悄少画一半。
// Allocation slack for every geometry. Must be >= the largest tier factor, or the top tier gets
// silently clipped by the buffer size — the nastiest kind of bug, because the UI still says "ultra"
// while the base population is all that ever gets drawn. It moves with the table: the buffer is what
// caps the drawn population, so doubling the table without this clips the top tier to half of it.
var PARTICLE_BUDGET_HEADROOM = 2.7;

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
  // 不再夹在 base 以内：顶档系数大于 1，本就要画到基准之上。
  // 真正的上限是缓冲区大小，只有 applyParticleDrawBudget 拿得到几何体，所以夹在那里做。
  // No longer clamped to the base: the top tier factor exceeds 1 precisely so it can draw past it.
  // The real ceiling is the buffer size, and only applyParticleDrawBudget can see the geometry, so
  // that is where the clamp happens.
  return Math.max(minimum, Math.round(base * runtimeParticleBudgetScale()));
}

// 网格型粒子上限：按面积开方得到边长，再夹在用户值与最小边长之间。
// Cap a lattice by side length: take the square root of the area budget, then clamp between the
// requested value and the floor.
function runtimeCoverParticleGridBudget(userGrid) {
  var requested = Math.max(8, Math.round(Number(userGrid) || 0));
  var scale = runtimeParticleBudgetScale();
  if (scale === 1) return requested;
  // 预算是**面积**预算，所以边长取平方根：先向下取整再对齐奇数，任何一步向上取整都会让实际
  // 面积反过来超出预算（183 格、0.4 系数时 √13403.6 ≈ 115.8，round 到 116 之后 116² 已经越界）。
  // The budget is an **area** budget, so the side length is its square root: floor first, then align
  // to odd, because any upward rounding pushes the drawn area back over it (at 183 with a 0.4
  // factor, √13403.6 ≈ 115.8 and rounding to 116 already overshoots).
  var target = Math.floor(Math.sqrt(requested * requested * scale));
  if (scale < 1) {
    var capped = Math.max(PARTICLE_BUDGET_MIN_GRID, target);
    if (capped % 2 === 0) capped -= 1;
    return Math.min(requested, capped);
  }
  // 顶档放大：网格是按需重建的，所以放大不需要预留缓冲，直接把边长开方放大即可。
  // 同样向下对齐奇数，中心格才不会被挤掉。
  // Growing past the base: the lattice is rebuilt on demand, so growth needs no pre-allocated slack;
  // the side length just scales by the square root. Floor to odd again so the centre cell survives.
  var grown = Math.max(requested, target);
  // 放大时向上对齐奇数：向下对齐会让实际面积掉到 1.3 倍以下（183 格时 208→207 只剩 1.279 倍）。
  // 缩小才必须向下取整（那是预算上限），放大取整方向相反，因为这里 1.3 是**下限**。
  // Align odd upward when growing: flooring drops the area below the promised 1.3x (at 183,
  // 208 -> 207 leaves only 1.279x). Rounding down is only required when shrinking, where the
  // budget is a ceiling; growth rounds the other way because 1.3 is a floor.
  if (grown % 2 === 0) grown += 1;
  return grown;
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
  if (position && Number(position.count) > 0) return Math.floor(Number(position.count));
  // 星河那类几何体只带自定义属性（seed / lane / depthSeed），既没有 position 也没有
  // userData.count。不退回读一次属性长度的话它会被当成"0 个粒子"——setDrawRange(0, 0) 让整片
  // 粒子直接消失，而且没有任何报错，是最难查的一种失败。
  // Star-river style geometries carry only custom attributes (seed / lane / depthSeed) with neither
  // a position attribute nor userData.count. Without this fallback they read as zero particles, and
  // setDrawRange(0, 0) makes the whole field disappear silently — the hardest kind of failure to
  // track down.
  var attributes = geometry.attributes || null;
  if (attributes) {
    for (var key in attributes) {
      var attribute = attributes[key];
      if (attribute && Number(attribute.count) > 0) return Math.floor(Number(attribute.count));
    }
  }
  return 0;
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
  // 顶档系数大于 1，但画不出缓冲区里没有的顶点：必须夹到几何体实际容量，
  // 否则 setDrawRange 越界（WebGL 会静默少画或直接报错，取决于驱动）。
  // The top tier exceeds 1, yet vertices that were never allocated cannot be drawn: clamp to the
  // real geometry capacity, or setDrawRange overruns (drivers either draw short or error out).
  var capacity = particleGeometryCount(target.geometry);
  if (capacity > 0 && cap > capacity) cap = capacity;
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

// 各粒子系统建几何体时用它放大分配量。基准数量（baseCount）保持原值不变，
// 这样"系数 × 基准"的语义在每一档都读得懂，余量只存在于缓冲区里。
// Geometries call this when allocating. The base count stays untouched, so "factor x base" keeps
// reading the same at every tier and the slack lives only in the buffer.
function particleBudgetHeadroom() {
  return PARTICLE_BUDGET_HEADROOM;
}
