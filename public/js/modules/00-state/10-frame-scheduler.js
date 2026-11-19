function createFrameGate(name, defaultFps) {
  return {
    name: String(name || 'frame-gate'),
    defaultFps: Math.max(0, Number(defaultFps) || 0),
    targetFps: Math.max(0, Number(defaultFps) || 0),
    lastRunAt: 0,
    pendingDt: 0,
    runs: 0,
    skips: 0,
    lastDt: 0,
    lastReason: '',
    // 探针的计数键只跟名字有关，构造时算一次就够。主循环有 7 个门，原来每帧都要现拼
    // `'frameGate.' + name + '.runs'/'.skipped'`，也就是每秒上千次没人用的字符串拼接。
    // The probe's counter keys depend only on the name, so build them once here. The main loop
    // has seven gates and used to concatenate these strings on every frame — thousands of
    // allocations per second that nothing reads.
    perfRunKey: 'frameGate.' + String(name || 'frame-gate') + '.runs',
    perfSkipKey: 'frameGate.' + String(name || 'frame-gate') + '.skipped'
  };
}

function consumeFrameGate(gate, now, dt, fps, force, reason) {
  if (!gate) return Math.max(0, Number(dt) || 0);
  now = Number(now) || performance.now();
  dt = Math.max(0, Number(dt) || 0);
  var targetFps = fps == null ? gate.defaultFps : Number(fps);
  if (!isFinite(targetFps) || targetFps < 0) targetFps = gate.defaultFps;
  gate.targetFps = targetFps;
  gate.pendingDt += dt;
  gate.lastReason = reason || gate.lastReason || '';
  if (!targetFps || force) {
    return runFrameGate(gate, now, dt);
  }
  var minGap = 1000 / Math.max(1, targetFps);
  if (gate.lastRunAt && now - gate.lastRunAt < minGap) {
    gate.skips += 1;
    if (window.__mineradioPerf && window.__mineradioPerf.count) {
      window.__mineradioPerf.count(gate.perfSkipKey || ('frameGate.' + gate.name + '.skipped'));
    }
    return 0;
  }
  return runFrameGate(gate, now, dt);
}

function runFrameGate(gate, now, fallbackDt) {
  var stepDt = gate.pendingDt || fallbackDt || 0;
  gate.pendingDt = 0;
  gate.lastRunAt = now;
  gate.lastDt = Math.min(stepDt, 0.18);
  gate.runs += 1;
  if (window.__mineradioPerf && window.__mineradioPerf.count) {
    window.__mineradioPerf.count(gate.perfRunKey || ('frameGate.' + gate.name + '.runs'));
  }
  return gate.lastDt;
}

function resetFrameGate(gate, now) {
  if (!gate) return;
  gate.lastRunAt = Number(now) || performance.now();
  gate.pendingDt = 0;
  gate.lastDt = 0;
  gate.lastReason = 'reset';
}

function collectFrameGateSnapshot(gates) {
  var out = {};
  Object.keys(gates || {}).forEach(function (key) {
    var gate = gates[key];
    if (!gate) return;
    out[key] = {
      name: gate.name,
      targetFps: gate.targetFps,
      runs: gate.runs,
      skips: gate.skips,
      lastDt: Math.round((gate.lastDt || 0) * 10000) / 10000,
      pendingDt: Math.round((gate.pendingDt || 0) * 10000) / 10000,
      lastReason: gate.lastReason
    };
  });
  return out;
}
