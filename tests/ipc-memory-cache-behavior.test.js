'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerMemoryCacheIpc } = require('../desktop/ipc-memory-cache');

function harness({ foreground = false } = {}) {
  const handlers = new Map();
  const calls = { purge: 0, trim: [], setRoot: [], sync: 0 };
  const managerState = { enabled: false };
  registerMemoryCacheIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    getGpuDiagnostics: () => ({ gpu: 'ok' }),
    systemMemory: {
      SYSTEM_PURGE_AVAILABLE: true,
      SYSTEM_PURGE_ENABLED: true,
      getMemorySnapshot: () => ({ process: { rss: 1 } }),
      getMemorySnapshotExtended: async () => ({ extended: true }),
      isProcessElevated: async () => false,
      purgeSystemMemorySmart: async () => { calls.purge += 1; return { ok: true }; },
      normalizeMask: (mask) => mask || 'default',
    },
    memoryManager: {
      getState: () => managerState,
      setState: (state) => Object.assign(managerState, state),
      getLastTrim: () => ({ at: 1, reason: 'timer' }),
    },
    normalizeMemoryAutoState: (payload) => ({ enabled: payload.enabled === true }),
    syncMemoryAutoTimer: () => { calls.sync += 1; },
    isMainWindowForegroundVisible: () => foreground,
    runMemoryAutoTick: async () => {},
    trimAppMemoryNow: async (reason) => { calls.trim.push(reason); return { ok: true }; },
    collectAppMemoryMetrics: async () => ({ metrics: true }),
    cacheSettingsManager: {
      snapshot: async () => ({ ok: true, settings: { restartRequired: false } }),
      get: () => ({ rootPath: 'C:/cache' }),
      setRootPath: (p) => { calls.setRoot.push(p); },
      normalizeRootPath: (p) => p,
    },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    desktopText: (key, fallback) => fallback,
  });
  return { handlers, calls, managerState };
}

test('memory snapshot exposes manager state', async () => {
  const { handlers } = harness();
  const res = await handlers.get('mineradio-memory-get-snapshot')();
  assert.equal(res.ok, true);
  assert.deepEqual(res.auto, { enabled: false });
  assert.equal(res.lastTrimReason, 'timer');
});

test('trim defaults to renderer reason', async () => {
  const { handlers, calls } = harness();
  await handlers.get('mineradio-memory-trim-app')({}, {});
  assert.deepEqual(calls.trim, ['renderer']);
});

test('system purge is skipped while the window is visible', async () => {
  const { handlers, calls } = harness({ foreground: true });
  const res = await handlers.get('mineradio-memory-purge-system')({}, { mask: 'x' });
  assert.equal(res.ok, true);
  assert.equal(res.result.skipped, true);
  assert.equal(calls.purge, 0);
});

test('cache settings writes root path and returns restart flag', async () => {
  const { handlers, calls } = harness();
  const res = await handlers.get('mineradio-cache-set-settings')({}, { rootPath: 'D:/cache' });
  assert.deepEqual(calls.setRoot, ['D:/cache']);
  assert.equal(res.restartRequired, false);
});
