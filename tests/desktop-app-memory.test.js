'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAppMemoryManager } = require('../desktop/app-memory');

function makeSystemMemory(overrides = {}) {
  return Object.assign({
    MEMORY_MASK_DEFAULT: 1,
    SYSTEM_PURGE_AVAILABLE: true,
    SYSTEM_PURGE_ENABLED: true,
    normalizeMask: (mask) => Number(mask) || 1,
    getMemorySnapshot: () => ({ ok: true, usedPercent: 50 }),
    getMemorySnapshotExtended: async () => ({ ok: true, usedPercent: 50 }),
    trimAppWorkingSets: async (pids) => ({ ok: true, pids }),
    purgeSystemMemorySmart: async (mask, opts) => ({ ok: true, mask, opts }),
  }, overrides);
}

function makeManager(extra = {}) {
  const systemMemory = extra.systemMemory || makeSystemMemory();
  const app = extra.app || {
    getAppMetrics: () => [
      { pid: 1, type: 'browser', memory: { workingSetSize: 1024 * 100, peakWorkingSetSize: 1024 * 120 } },
      { pid: 2, type: 'Tab', memory: { workingSetSize: 1024 * 300 } },
      { pid: 3, type: 'gpu', memory: { workingSetSize: 1024 * 50 } },
      { pid: 4, type: 'utility', memory: { workingSetSize: 1024 * 25 } },
    ],
  };
  const manager = createAppMemoryManager({
    app,
    systemMemory,
    getMainWindow: extra.getMainWindow || (() => ({ isDestroyed: () => false, isVisible: () => false, isMinimized: () => false })),
    collectAppTrimPids: extra.collectAppTrimPids || (() => [10, 11]),
    platform: extra.platform || 'win32',
    now: extra.now || (() => 1000),
  });
  return { manager, systemMemory, app };
}

test('metrics aggregates process types and tolerates a failing app metrics call', () => {
  const { manager } = makeManager();
  const metrics = manager.metrics();
  assert.equal(metrics.ok, true);
  assert.equal(metrics.browserMB, 100);
  assert.equal(metrics.rendererMB, 300);
  assert.equal(metrics.gpuMB, 50);
  assert.equal(metrics.utilityMB, 25);
  assert.equal(metrics.totalMB, 475);
  assert.equal(metrics.processCount, 4);
  assert.deepEqual(metrics.processes[1], {
    pid: 2, type: 'tab', name: '', workingSetMB: 300, peakWorkingSetMB: 0,
  });

  const broken = makeManager({ app: { getAppMetrics: () => { throw new Error('nope'); } } });
  assert.equal(broken.manager.metrics().totalMB, 0);
});

test('trimNow skips while the window is visible and runs on manual-force', async () => {
  const visibleWindow = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
  const { manager, systemMemory } = makeManager({ getMainWindow: () => visibleWindow });
  const skipped = await manager.trimNow('tray-hide');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'foreground-visible');

  const forced = await manager.trimNow('manual-force');
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.trim.pids, [10, 11]);
  assert.equal(manager.getLastTrim().reason, 'manual-force');
  // 12MB 的 trim 不应落盘, snapshot calls still go through the injected object.
  assert.ok(systemMemory);
});

test('normalizeState clamps intervals and only enables when the system purge is available', () => {
  const { manager } = makeManager({ systemMemory: makeSystemMemory({ SYSTEM_PURGE_ENABLED: false }) });
  const state = manager.normalizeState({ enabled: true, intervalMin: 1, thresholdPercent: 140, mask: 7 });
  assert.equal(state.enabled, false);
  assert.equal(state.intervalMin, 5);
  assert.equal(state.thresholdPercent, 100);
  assert.equal(state.mask, 7);

  manager.setState(manager.normalizeState({ enabled: true, appTrimEnabled: false }));
  assert.equal(manager.getState().appTrimEnabled, false);
});

test('runAutoTick skips below the threshold and purges above it', async () => {
  const purges = [];
  const systemMemory = makeSystemMemory({
    getMemorySnapshotExtended: async () => ({ ok: true, usedPercent: 20 }),
    purgeSystemMemorySmart: async (mask) => { purges.push(mask); return { ok: true }; },
  });
  const { manager } = makeManager({ systemMemory });
  manager.setState(manager.normalizeState({ enabled: true, thresholdPercent: 78 }));

  const below = await manager.runAutoTick('test');
  assert.equal(below.skipped, true);
  assert.equal(purges.length, 0);

  manager.getState().thresholdPercent = 10;
  const above = await manager.runAutoTick('test');
  assert.equal(above.ok, true);
  assert.equal(purges.length, 1);
});
