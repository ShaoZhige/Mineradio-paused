'use strict';

// 退出编排：同步清理 → 自定义源/本地服务/托盘 → 桌面模式与壁纸引擎的异步收尾 →
// 15s 上限 → 二次 app.quit → 3s 硬退出兜底。抽自 desktop/main.js，主进程只保留
// 依赖注入与两个 app 事件转接。
//
// Quit orchestration extracted from desktop/main.js: synchronous surfaces, custom-source
// and local-server teardown, tray, then bounded async desktop-mode / wallpaper-engine
// cleanup, a second app.quit(), and a hard-exit fallback.

function createQuitController({
  app,
  setQuitting,
  getMainWindow,
  hideVisibleSurfacesForQuit,
  clearWallpaperEngineCaptureGrant,
  wallpaperEngineLibrary,
  stopMemoryAutoTimer,
  unregisterFullDesktopEscapeShortcut,
  unregisterMineradioGlobalHotkeys,
  closeDesktopLyricsWindow,
  disposeQishuiAuthForQuit,
  getCustomSourceManager,
  clearCustomSourceManager,
  getLocalServer,
  getTrayController,
  fullDesktopModeRuntime,
  localMusicLibrary,
  wallpaperEngineRuntime,
  warn = console.warn,
  error = console.error,
} = {}) {
  let cleanupPromise = null;
  let cleanupComplete = false;

  function beforeQuit(event) {
    setQuitting(true);
    if (cleanupComplete) return;
    event.preventDefault();
    if (cleanupPromise) return;

    const steps = [
      ['hide-visible-surfaces', () => hideVisibleSurfacesForQuit()],
      ['clear-wallpaper-capture-grant', () => clearWallpaperEngineCaptureGrant()],
      ['wallpaper-engine-library-dispose', () => wallpaperEngineLibrary.dispose()],
      ['stop-memory-timer', () => stopMemoryAutoTimer()],
      ['unregister-desktop-escape', () => unregisterFullDesktopEscapeShortcut()],
      ['unregister-global-hotkeys', () => unregisterMineradioGlobalHotkeys()],
      ['close-desktop-lyrics', () => closeDesktopLyricsWindow()],
      ['dispose-qishui-auth', () => disposeQishuiAuthForQuit()],
    ];
    for (let i = 0; i < steps.length; i += 1) {
      const stepName = steps[i][0];
      try {
        steps[i][1]();
      } catch (err) {
        error('[Shutdown] cleanup step failed:', stepName, err && err.stack || err);
      }
    }

    // 先收脚本宿主再关本地服务：宿主窗口是本地服务解析 URL 的消费者，反过来会留下悬挂请求。
    // Tear down the script host before the local server: the host windows consume URL
    // resolution from that server, and the reverse order leaves dangling requests.
    const manager = getCustomSourceManager();
    if (manager) {
      clearCustomSourceManager();
      void manager.dispose();
    }
    const localServer = getLocalServer();
    if (localServer && typeof localServer.setCustomSourceResolver === 'function') {
      localServer.setCustomSourceResolver(null);
    }
    if (localServer && localServer.close) localServer.close();
    const tray = getTrayController();
    if (tray) tray.destroy();

    const quitMainWindow = getMainWindow() && !getMainWindow().isDestroyed() ? getMainWindow() : null;
    const forceDestroyQuitMainWindow = (reason, detail) => {
      error(`[FullDesktopMode] ${reason}; destroying the exact main window as the HWND cleanup fallback.`, detail || '');
      if (!quitMainWindow || quitMainWindow.isDestroyed()) {
        warn('[FullDesktopMode] main window HWND fallback was already unavailable.');
        return;
      }
      try {
        quitMainWindow.destroy();
        warn('[FullDesktopMode] main window destroyed after incomplete desktop-mode cleanup.');
      } catch (destroyError) {
        error('[FullDesktopMode] main window HWND fallback destroy failed:', destroyError && destroyError.message || destroyError);
      }
    };

    const disposeFullDesktopModeWithGuard = async () => {
      let fullDesktopCleanupTimeout = null;
      let timedOut = false;
      const timeoutResult = new Promise((resolve) => {
        fullDesktopCleanupTimeout = setTimeout(() => {
          timedOut = true;
          resolve({ ok: false, error: 'FULL_DESKTOP_DISPOSE_TIMEOUT' });
        }, 7000);
      });
      let result = null;
      try {
        result = await Promise.race([
          fullDesktopModeRuntime.dispose('app-before-quit'),
          timeoutResult,
        ]);
      } catch (err) {
        if (fullDesktopCleanupTimeout) clearTimeout(fullDesktopCleanupTimeout);
        forceDestroyQuitMainWindow('dispose failed', err && err.message || err);
        return;
      }
      if (fullDesktopCleanupTimeout) clearTimeout(fullDesktopCleanupTimeout);
      if (!result || result.ok !== true) {
        const detail = result && (result.error || result.status && result.status.lastError) || 'unknown';
        forceDestroyQuitMainWindow(timedOut ? 'dispose timed out after 7000ms' : 'dispose incomplete', detail);
      }
    };

    // fs.watch 的句柄是常驻的，不关进程退不出去，所以退出路径上必须先收掉。
    // fs.watch handles are live and keep the process alive, so they must go before quitting.
    try {
      localMusicLibrary.stopWatching();
    } catch (err) {
      warn('[LocalLibrary] watcher stop failed:', err && err.message || err);
    }

    let cleanupTimeout = null;
    const fullDesktopAndWallpaperEngineCleanup = (async () => {
      // A passive desktop host must become a verified top-level HWND before
      // its exact WE source/DWM companion is disposed.
      await disposeFullDesktopModeWithGuard();
      await wallpaperEngineRuntime.dispose().then((result) => {
        if (result && result.ok === false) {
          warn('[Wallpaper Engine] dispose incomplete:', result.reason || 'WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED');
        }
      }).catch((err) => {
        warn('[Wallpaper Engine] dispose failed:', err && err.message || err);
      });
      wallpaperEngineRuntime.stopResidentHelpers('quit');
    })();
    const runtimeCleanup = fullDesktopAndWallpaperEngineCleanup;
    const timeoutCleanup = new Promise((resolve) => {
      cleanupTimeout = setTimeout(() => {
        warn('[Shutdown] runtime cleanup exceeded 15000ms; continuing bounded application exit.');
        resolve();
      }, 15000);
    });
    cleanupPromise = Promise.race([runtimeCleanup, timeoutCleanup]).finally(() => {
      if (cleanupTimeout) clearTimeout(cleanupTimeout);
      cleanupComplete = true;
      app.quit();
      // 如果还有窗口拒绝关闭（例如汽水音乐安全验证窗口会 preventDefault），app.quit() 会永远停在
      // before-quit 之后，进程就变成没有界面的僵尸。兜底硬退出。
      setTimeout(() => {
        error('[Shutdown] quit still pending after cleanup; forcing application exit.');
        app.exit(0);
      }, 3000);
    });
  }

  function willQuit() {
    const tray = getTrayController();
    if (tray) tray.destroy();
  }

  return {
    beforeQuit,
    willQuit,
    isComplete: () => cleanupComplete,
  };
}

module.exports = { createQuitController };
