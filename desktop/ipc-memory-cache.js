'use strict';

// 内存诊断与缓存目录 IPC：GPU 诊断、内存快照、自动整理、系统内存清理、缓存目录设置。

function registerMemoryCacheIpc(deps) {
  const {
    ipcMain,
    getGpuDiagnostics,
    systemMemory,
    memoryManager,
    normalizeMemoryAutoState,
    syncMemoryAutoTimer,
    isMainWindowForegroundVisible,
    runMemoryAutoTick,
    trimAppMemoryNow,
    collectAppMemoryMetrics,
    cacheSettingsManager,
    dialog,
    desktopText,
  } = deps;

  ipcMain.handle('mineradio-get-gpu-diagnostics', () => {
    return getGpuDiagnostics();
  });

  ipcMain.handle('mineradio-memory-get-snapshot', async () => {
    try {
      return {
        ok: true,
        snapshot: await systemMemory.getMemorySnapshotExtended(),
        elevated: false,
        systemPurgeAvailable: systemMemory.SYSTEM_PURGE_AVAILABLE === true,
        systemPurgeEnabled: systemMemory.SYSTEM_PURGE_ENABLED === true,
        appMetrics: systemMemory.getMemorySnapshot().process,
        auto: memoryManager.getState(),
        lastTrimAt: memoryManager.getLastTrim().at,
        lastTrimReason: memoryManager.getLastTrim().reason,
      };
    } catch (e) {
      return { ok: false, error: e.message || 'MEMORY_SNAPSHOT_FAILED', snapshot: systemMemory.getMemorySnapshot(), auto: memoryManager.getState() };
    }
  });

  ipcMain.handle('mineradio-app-memory-metrics', async () => collectAppMemoryMetrics());

  ipcMain.handle('mineradio-memory-configure-auto', async (_event, payload = {}) => {
    memoryManager.setState(normalizeMemoryAutoState(payload));
    syncMemoryAutoTimer();
    if (memoryManager.getState().enabled && payload.runNow === true && !isMainWindowForegroundVisible()) {
      await runMemoryAutoTick('configure');
    }
    return {
      ok: true,
      state: memoryManager.getState(),
      systemPurgeAvailable: systemMemory.SYSTEM_PURGE_AVAILABLE === true,
      systemPurgeEnabled: systemMemory.SYSTEM_PURGE_ENABLED === true,
    };
  });

  ipcMain.handle('mineradio-memory-trim-app', async (_event, payload = {}) => {
    return trimAppMemoryNow(payload.reason || 'renderer');
  });

  ipcMain.handle('mineradio-memory-purge-system', async (_event, payload = {}) => {
    const mask = systemMemory.normalizeMask(payload && payload.mask);
    const autoElevate = payload && payload.autoElevate === true;
    try {
      if (isMainWindowForegroundVisible()) {
        return {
          ok: true,
          result: { ok: false, skipped: true, reason: 'foreground-visible', message: 'System memory purge is skipped while Mineradio is visible.' },
          snapshot: systemMemory.getMemorySnapshot(),
          elevated: false,
          systemPurgeAvailable: systemMemory.SYSTEM_PURGE_AVAILABLE === true,
          systemPurgeEnabled: systemMemory.SYSTEM_PURGE_ENABLED === true,
        };
      }
      const elevatedBefore = await systemMemory.isProcessElevated();
      const result = await systemMemory.purgeSystemMemorySmart(mask, { autoElevate, manual: true });
      return {
        ok: true,
        result,
        snapshot: await systemMemory.getMemorySnapshotExtended(),
        elevated: elevatedBefore || await systemMemory.isProcessElevated(),
        systemPurgeAvailable: systemMemory.SYSTEM_PURGE_AVAILABLE === true,
        systemPurgeEnabled: systemMemory.SYSTEM_PURGE_ENABLED === true,
      };
    } catch (e) {
      return {
        ok: false,
        error: e.message || 'SYSTEM_MEMORY_PURGE_FAILED',
        snapshot: systemMemory.getMemorySnapshot(),
        elevated: false,
        systemPurgeAvailable: systemMemory.SYSTEM_PURGE_AVAILABLE === true,
        systemPurgeEnabled: systemMemory.SYSTEM_PURGE_ENABLED === true,
      };
    }
  });

  ipcMain.handle('mineradio-cache-get-settings', async () => {
    try {
      return await cacheSettingsManager.snapshot();
    } catch (error) {
      return { ok: false, error: error.message || 'CACHE_SETTINGS_READ_FAILED' };
    }
  });

  ipcMain.handle('mineradio-cache-choose-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: desktopText('dialog_choose_cache_dir', '选择 Mineradio 缓存目录'),
      defaultPath: cacheSettingsManager.get().rootPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: true, canceled: true };
    return { ok: true, canceled: false, rootPath: cacheSettingsManager.normalizeRootPath(result.filePaths[0]) };
  });

  ipcMain.handle('mineradio-cache-set-settings', async (_event, payload = {}) => {
    try {
      cacheSettingsManager.setRootPath(payload.rootPath);
      const snapshot = await cacheSettingsManager.snapshot();
      snapshot.restartRequired = snapshot.settings.restartRequired;
      return snapshot;
    } catch (error) {
      return { ok: false, error: error.message || 'CACHE_SETTINGS_WRITE_FAILED' };
    }
  });
}

module.exports = { registerMemoryCacheIpc };
