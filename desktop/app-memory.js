'use strict';

// 应用内存口径与后台清理。从 desktop/main.js 抽出：main.js 只保留
// collectAppTrimPids（依赖主窗口）与 IPC 转接。
//
// App-level memory and background trimming. Extracted from desktop/main.js so the
// main process keeps only the window-dependent PID collection and IPC wiring.

function createAppMemoryManager({
  app,
  systemMemory,
  getMainWindow,
  collectAppTrimPids,
  platform = process.platform,
  now = Date.now,
  warn = console.warn,
} = {}) {
  let trimTimer = null;
  let autoTimer = null;
  let trimInFlight = false;
  let lastTrimAt = 0;
  let lastTrimReason = '';
  let state = {
    appTrimEnabled: true,
    backgroundTrimEnabled: true,
    enabled: false,
    mask: systemMemory.MEMORY_MASK_DEFAULT,
    intervalMin: 30,
    thresholdPercent: 78,
    autoElevate: false,
    lastRunAt: 0,
    lastReason: '',
    lastResult: null,
    lastError: '',
  };

  function getState() {
    return state;
  }

  function setState(next) {
    state = next;
    return state;
  }

  function isMainWindowForegroundVisible() {
    try {
      const win = getMainWindow && getMainWindow();
      return !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
    } catch (e) {
      return false;
    }
  }

  function metrics() {
    const totals = { browserMB: 0, rendererMB: 0, gpuMB: 0, utilityMB: 0, otherMB: 0, totalMB: 0 };
    let rows = [];
    try {
      rows = app.getAppMetrics() || [];
    } catch (e) {
      rows = [];
    }
    const processes = [];
    rows.forEach((row) => {
      const memory = (row && row.memory) || {};
      const workingSetKB = Number(memory.workingSetSize) || 0;
      const mb = Math.round(workingSetKB / 1024);
      const type = String((row && row.type) || '').toLowerCase();
      if (type === 'tab' || type === 'renderer' || type === 'webview') totals.rendererMB += mb;
      else if (type === 'gpu') totals.gpuMB += mb;
      else if (type === 'utility') totals.utilityMB += mb;
      else if (type === 'browser') totals.browserMB += mb;
      else totals.otherMB += mb;
      totals.totalMB += mb;
      processes.push({
        pid: Number(row && row.pid) || 0,
        type: type || 'unknown',
        name: String((row && row.name) || ''),
        workingSetMB: mb,
        peakWorkingSetMB: Math.round((Number(memory.peakWorkingSetSize) || 0) / 1024),
      });
    });
    return Object.assign({ ok: true, sampledAt: now(), processCount: processes.length, processes }, totals);
  }

  async function trimNow(reason) {
    if (trimInFlight) {
      return { ok: false, skipped: true, reason: 'in-flight' };
    }
    const trimReason = String(reason || 'manual');
    if (isMainWindowForegroundVisible() && trimReason !== 'manual-force') {
      return { ok: false, skipped: true, reason: 'foreground-visible' };
    }
    trimInFlight = true;
    lastTrimAt = now();
    lastTrimReason = trimReason;
    try {
      const before = systemMemory.getMemorySnapshot();
      const trim = await systemMemory.trimAppWorkingSets(collectAppTrimPids());
      const after = systemMemory.getMemorySnapshot();
      return { ok: true, reason: lastTrimReason, before, trim, after };
    } catch (e) {
      return {
        ok: false,
        reason: lastTrimReason,
        error: e.message || 'APP_MEMORY_TRIM_FAILED',
        snapshot: systemMemory.getMemorySnapshot(),
      };
    } finally {
      trimInFlight = false;
    }
  }

  function scheduleTrim(reason, delay = 9000) {
    if (platform !== 'win32') return;
    if (state.appTrimEnabled === false || state.backgroundTrimEnabled === false) return;
    if (now() - lastTrimAt < 120000) return;
    if (trimTimer) clearTimeout(trimTimer);
    trimTimer = setTimeout(() => {
      trimTimer = null;
      const win = getMainWindow && getMainWindow();
      if (!win || win.isDestroyed()) return;
      if (!win.isMinimized() && win.isVisible()) return;
      trimNow(reason).catch(() => {});
    }, Math.max(4000, delay));
  }

  function cancelPendingTrim() {
    if (trimTimer) {
      clearTimeout(trimTimer);
      trimTimer = null;
    }
  }

  function normalizeState(payload = {}) {
    const systemEnabled = systemMemory.SYSTEM_PURGE_AVAILABLE === true && systemMemory.SYSTEM_PURGE_ENABLED === true;
    return {
      appTrimEnabled: payload.appTrimEnabled !== false,
      backgroundTrimEnabled: payload.backgroundTrimEnabled !== false,
      enabled: systemEnabled && payload.enabled === true,
      mask: systemMemory.normalizeMask(payload.mask != null ? payload.mask : state.mask),
      intervalMin: Math.max(5, Math.min(180, Math.round(Number(payload.intervalMin != null ? payload.intervalMin : state.intervalMin) || 30))),
      thresholdPercent: Math.max(0, Math.min(100, Math.round(Number(payload.thresholdPercent != null ? payload.thresholdPercent : state.thresholdPercent) || 0))),
      autoElevate: payload.autoElevate === true,
      lastRunAt: state.lastRunAt || 0,
      lastReason: state.lastReason || '',
      lastResult: state.lastResult || null,
      lastError: '',
    };
  }

  function stopAutoTimer() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  function syncAutoTimer() {
    stopAutoTimer();
    if (!state.enabled) return;
    autoTimer = setInterval(() => {
      runAutoTick('timer').catch(() => {});
    }, Math.max(5, state.intervalMin) * 60000);
  }

  async function runAutoTick(reason = 'auto') {
    if (!state.enabled) {
      return { ok: false, skipped: true, reason: 'disabled', state };
    }
    if (isMainWindowForegroundVisible()) {
      state.lastRunAt = now();
      state.lastReason = reason + ':foreground-visible';
      state.lastResult = { ok: true, skipped: true, reason: 'foreground-visible' };
      return { ok: true, skipped: true, reason: 'foreground-visible', state };
    }
    const snapshot = await systemMemory.getMemorySnapshotExtended();
    const threshold = Number(state.thresholdPercent) || 0;
    if (threshold > 0 && snapshot && snapshot.usedPercent < threshold) {
      state.lastRunAt = now();
      state.lastReason = reason + ':below-threshold';
      state.lastResult = { ok: true, skipped: true, usedPercent: snapshot.usedPercent, thresholdPercent: threshold };
      return { ok: true, skipped: true, snapshot, state };
    }
    state.lastRunAt = now();
    state.lastReason = reason;
    try {
      const result = await systemMemory.purgeSystemMemorySmart(state.mask, {
        autoElevate: state.autoElevate === true,
      });
      state.lastResult = result;
      state.lastError = '';
      return { ok: true, result, snapshot: await systemMemory.getMemorySnapshotExtended(), state };
    } catch (e) {
      state.lastError = e.message || 'MEMORY_AUTO_FAILED';
      state.lastResult = { ok: false, error: state.lastError };
      return { ok: false, error: state.lastError, snapshot: systemMemory.getMemorySnapshot(), state };
    }
  }

  function getLastTrim() {
    return { at: lastTrimAt, reason: lastTrimReason };
  }

  function destroy() {
    cancelPendingTrim();
    stopAutoTimer();
  }

  return {
    metrics,
    getState,
    setState,
    normalizeState,
    trimNow,
    scheduleTrim,
    cancelPendingTrim,
    stopAutoTimer,
    syncAutoTimer,
    runAutoTick,
    getLastTrim,
    isMainWindowForegroundVisible,
    destroy,
  };
}

module.exports = { createAppMemoryManager };
