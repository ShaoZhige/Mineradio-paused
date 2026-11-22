'use strict';

// 检查函数从原 scripts/quick-check.js **原样搬出**，断言一条未改。
const env = require('./env.cjs');
const {
  spawnSync,
  readAllCssFiles,
  readVisualArchiveText,
  rel,
  logStep,
  fail,
  fs,
  os,
  path,
  vm,
  appRoot,
  QUIT_TEXT,
} = env;

function checkMainWindowChrome() {
  logStep('Main window chrome guard');
  const mainPath = path.join(appRoot, 'desktop', 'main.js');
  const text = fs.readFileSync(mainPath, 'utf8');
  const mainWindowIndex = Math.max(
    text.indexOf('mainWindow = new BrowserWindow({'),
    text.indexOf('const win = new BrowserWindow({'),
  );
  if (mainWindowIndex < 0) fail('main BrowserWindow definition not found in desktop/main.js');
  const snippet = text.slice(mainWindowIndex, mainWindowIndex + 900);
  if (!/frame:\s*false/.test(snippet)) fail('main window is not configured as frame:false');
  if (!/transparent:\s*true/.test(snippet)) fail('main window is not configured as transparent:true');
  console.log('[OK] Main player window still uses frame:false and transparent:true.');
}

function checkBackgroundTransparencyControlsGuard() {
  logStep('Background transparency controls guard');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const rendererText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '00-renderer-quality.js'), 'utf8');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const persistenceText = readVisualArchiveText();
  const backgroundText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '02-accent-background-controls.js'), 'utf8');
  const panelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const bindingText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  if (!/id="fx-windowbgopacity"/.test(htmlText) || !/id="fx-bgglassopacity"/.test(htmlText) || !/id="bg-album-toggle-btn"/.test(htmlText) || !/id="bg-media-crop-btn"/.test(htmlText) || !/id="background-crop-modal"/.test(htmlText) || !/id="fx-bgcropx"/.test(htmlText) || !/id="fx-bgcropy"/.test(htmlText) || !/id="fx-bgzoom"/.test(htmlText)) {
    fail('background transparency/media/crop controls are missing from the appearance panel');
  }
  if (!/alpha:\s*true/.test(rendererText) || !/setClearColor\(0x000000,\s*0\)/.test(rendererText)) {
    fail('WebGL renderer must keep a transparent clear buffer for window background opacity');
  }
  if (!/windowBackgroundOpacity:\s*1/.test(defaultsText) || !/backgroundGlassOpacity:\s*0/.test(defaultsText) || !/backgroundAlbumCover:\s*false/.test(defaultsText) || !/backgroundMediaCropX:\s*50/.test(defaultsText) || !/backgroundMediaZoom:\s*1/.test(defaultsText)) {
    fail('background transparency defaults must preserve the current opaque look');
  }
  if (!/rgba\(var\(--custom-bg-color-rgb/.test(cssText) || !/custom-bg-glass-active/.test(cssText) || !/custom-background-album-cover/.test(cssText) || !/background-crop-stage/.test(cssText) || !/body\.custom-background-override #album-bg/.test(cssText) || !/--custom-bg-position-x/.test(cssText) || !/backdrop-filter:\s*blur\(var\(--custom-bg-glass-blur/.test(cssText)) {
    fail('background layer must expose base alpha and gated glass blur CSS variables');
  }
  if (!/windowBackgroundOpacity/.test(backgroundText) || !/backgroundGlassOpacity/.test(backgroundText) || !/backgroundAlbumCover/.test(backgroundText) || !/customBackgroundActiveMedia/.test(backgroundText) || !/customBackgroundAlbumCoverSource/.test(backgroundText) || !/openCustomBackgroundCropModal/.test(backgroundText) || !/applyCustomBackgroundCropVars/.test(backgroundText) || !/--custom-bg-base-opacity/.test(backgroundText) || !/--custom-bg-glass-blur/.test(backgroundText)) {
    fail('background controls must apply window and glass opacity at runtime');
  }
  if (!/windowBackgroundOpacity/.test(persistenceText) || !/backgroundGlassOpacity/.test(persistenceText) || !/backgroundAlbumCover/.test(persistenceText) || !/backgroundMediaCrop: \['backgroundMediaCropX', 'backgroundMediaCropY', 'backgroundMediaZoom'\]/.test(persistenceText) || !/windowBackgroundOpacity: \['windowBackgroundOpacity'\]/.test(persistenceText)) {
    fail('background transparency controls must be persisted with scoped autosave keys');
  }
  if (!/fx-windowbgopacity/.test(panelText) || !/fx-bgglassopacity/.test(panelText) || !/fx-bgcropx/.test(panelText) || !/fx-bgzoom/.test(panelText) || !/updateCustomBackgroundControls\(\)/.test(panelText)) {
    fail('background transparency controls must sync panel values and reset immediately');
  }
  if (!/fx-windowbgopacity/.test(bindingText) || !/backgroundGlassOpacity/.test(bindingText) || !/backgroundMediaCropX/.test(bindingText) || !/backgroundMediaZoom/.test(bindingText)) {
    fail('background transparency sliders must be bound to runtime fx values');
  }
  if (!/windowBackgroundOpacity/.test(archiveText) || !/backgroundGlassOpacity/.test(archiveText) || !/backgroundAlbumCover/.test(archiveText) || !/backgroundMediaZoom/.test(archiveText)) {
    fail('background transparency controls must be included in user preset archives');
  }
  console.log('[OK] Background window opacity and gated glass opacity controls are wired through UI, CSS, runtime, persistence, and archives.');
}

function checkWallpaperEngineImportGuard() {
  logStep('Wallpaper Engine additive import guard');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const rendererPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js');
  const rendererText = fs.readFileSync(rendererPath, 'utf8');
  const controlGlassText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '15-control-glass-animations.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const quitText = fs.readFileSync(path.join(appRoot, 'desktop', 'quit.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const libraryText = fs.readFileSync(path.join(appRoot, 'desktop', 'wallpaper-engine-library.js'), 'utf8');
  const runtimeText = fs.readFileSync(path.join(appRoot, 'desktop', 'wallpaper-engine-runtime.js'), 'utf8');
  const systemMemoryText = fs.readFileSync(path.join(appRoot, 'desktop', 'system-memory.js'), 'utf8');
  const lifecycleText = fs.readFileSync(path.join(appRoot, 'scripts', 'check-wallpaper-engine-lifecycle.js'), 'utf8');
  if (!/id="custom-bg"/.test(htmlText) || !/id="bg-image-value"/.test(htmlText) || !/id="wallpaper-engine-layer"/.test(htmlText) || !/id="wallpaper-engine-modal"/.test(htmlText)) {
    fail('Wallpaper Engine import must be additive and keep the original background-media controls');
  }
  if (!/body\.wallpaper-engine-active #custom-bg/.test(cssText) || !/#wallpaper-engine-layer\.ready/.test(cssText)
    || !/body\.wallpaper-engine-dwm-active #wallpaper-engine-layer/.test(cssText)) {
    fail('Wallpaper Engine layer must crossfade independently above the preserved original background');
  }
  if (/setCustomBackgroundMedia\s*\(/.test(rendererText) || /fx\.backgroundMedia\s*=/.test(rendererText)) {
    fail('Wallpaper Engine import must never overwrite fx.backgroundMedia');
  }
  if (!/restoreOriginalBackgroundAfterWallpaperEngine/.test(rendererText) || !/visibilitychange/.test(rendererText) || !/IntersectionObserver/.test(rendererText) || !/WALLPAPER_ENGINE_RENDER_BATCH/.test(rendererText) || !/items\.slice\(0, wallpaperEngineRenderLimit\)/.test(rendererText)) {
    fail('Wallpaper Engine renderer must restore the original background, pause when hidden, lazy-load previews, and batch very large libraries');
  }
  if (!/img\[data-animated="1"\]/.test(rendererText) || !/event\.target !== card/.test(rendererText) || !/scheduleWallpaperEngineLibraryRender/.test(rendererText)) {
    fail('Wallpaper Engine modal must unload animated previews, keep keyboard actions scoped, and debounce search rendering');
  }
  if (!/wallpaper-engine-active/.test(fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '02-accent-background-controls.js'), 'utf8'))) {
    fail('The preserved original background video must stay paused while the Wallpaper Engine layer is active');
  }
  if (!/mineradio-wallpaper-engine-list/.test(mainText) || !/mineradio-wallpaper-engine-warmup/.test(mainText) || !/warmupWallpaperEngineRuntime/.test(preloadText) || !/mineradio-wallpaper-engine-project-details/.test(mainText) || !/mineradio-wallpaper-engine-open-project-details/.test(mainText) || !/mineradio-wallpaper-engine-start-scene/.test(mainText) || !/mineradio-wallpaper-engine-capture-result/.test(mainText) || !/mineradio-wallpaper-engine-glass-surface/.test(mainText) || !/mineradio-wallpaper-engine-prepare-glass-capture/.test(mainText) || !/installProtocol\(protocol\)/.test(mainText) || !/listWallpaperEngineProjects/.test(preloadText) || !/getWallpaperEngineProjectDetails/.test(preloadText) || !/openWallpaperEngineProjectDetails/.test(preloadText) || !/startWallpaperEngineScene/.test(preloadText) || !/reportWallpaperEngineCaptureResult/.test(preloadText) || !/prepareWallpaperEngineGlassCapture/.test(preloadText) || !/updateWallpaperEngineGlassSurface/.test(preloadText) || !/stopWallpaperEngineScene/.test(preloadText) || !/isTrustedWallpaperEngineIpc/.test(mainText) || !/function isTrustedMainDocumentUrl/.test(mainText) || !/pathname === '\/' \|\| pathname === '\/index\.html'/.test(mainText)) {
    fail('Wallpaper Engine scan/import/warmup IPC and restricted media protocol are not fully wired');
  }
  if (!/wallpaperEnginePlayWasInterrupted/.test(rendererText) || !/WALLPAPER_ENGINE_SWITCH_FADE_MS/.test(rendererText)) {
    fail('Wallpaper Engine playback interruption and wallpaper-to-wallpaper crossfade guards are missing');
  }
  if (!/projectType === 'video'/.test(libraryText) || !/validateScenePackage/.test(libraryText) || !/PKGV\\d\{4\}/.test(libraryText) || !/addManualProjectFile/.test(libraryText) || !/enginePlayable/.test(libraryText) || !/resolveProjectFile/.test(libraryText) || !/fs\.promises\.realpath/.test(libraryText) || !/X-Content-Type-Options/.test(libraryText) || !/mediaToken/.test(libraryText) || !/wallpaperEngineMediaToken/.test(rendererText)) {
    fail('Wallpaper Engine library must strictly gate project types and contain real paths');
  }
  if (/spawn\s*\(|shell\.open|wallpaper64/i.test(libraryText)) {
    fail('Wallpaper Engine import must not execute imported applications or modify the Windows wallpaper');
  }
  if (!/Get-AuthenticodeSignature/.test(runtimeText) || !/Skutta Software/.test(runtimeText) || !/engineProcessProbe/.test(runtimeText) || /onSourceMiss/.test(runtimeText) || !/projectFile/.test(runtimeText) || !/'openWallpaper'/.test(runtimeText) || !/'-playInWindow'/.test(runtimeText) || !/'closeWallpaper'/.test(runtimeText) || !/'-location'/.test(runtimeText) || !/shell:\s*false/.test(runtimeText) || !/desktopCapturer/.test(runtimeText) || !/controlBrokerScript/.test(runtimeText) || !/GetShellWindow/.test(runtimeText) || !/GetIntegrityRid/.test(runtimeText) || !/PROC_THREAD_ATTRIBUTE_PARENT_PROCESS/.test(runtimeText) || !/CreateProcessW/.test(runtimeText) || !/hostElevationProbe/.test(runtimeText) || !/MINERADIO_WE_CONTROL_TARGET/.test(runtimeText) || !/MINERADIO_WE_CONTROL_COMMAND_LINE/.test(runtimeText) || !/hostElevationProbe:\s*systemMemory\.probeProcessElevation/.test(mainText) || /WALLPAPER_ENGINE_HOST_ELEVATED/.test(mainText)) {
    fail('Wallpaper Engine Scene runtime must use the signed official engine, route elevated hosts through the Explorer medium-integrity broker, and retain the captured window source');
  }
  const dwmSurfaceBlockRaw = runtimeText.slice(
    runtimeText.indexOf('function nativeDwmThumbnailSurfaceScript'),
    runtimeText.indexOf('function quoteWindowsArgument')
  );
  // 否定判据（"这个块里不许出现 SetWindowLong / SetParent / SW_HIDE…"）必须对着剥掉注释的源码。
  // 这个块里本来就该留着"以前用过 SetWindowLong、后来收敛掉了"这类说明，照原文匹配会把有用的
  // 历史记录判成违规——判据比意图宽，守卫就成了噪声。
  // Negative criteria ("no SetWindowLong / SetParent / SW_HIDE in this block") must run against
  // comment-stripped source. The block deliberately documents that SetWindowLong was used once and
  // then removed; matching the raw text reads that useful history as a violation — a criterion wider
  // than its intent turns the guard into noise.
  const dwmSurfaceBlock = dwmSurfaceBlockRaw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const captureReadyBlock = runtimeText.slice(
    runtimeText.indexOf('async confirmCaptureReady'),
    runtimeText.indexOf('_openControlArgs')
  );
  // 关窗等待必须有下限，而且轮询形状不能丢。WE 弹出窗口在场景仍在初始化时可以拖很久才
  // 收尾，早期 1.8 秒的硬上限会让整个原生会话因为"没等够"而失败、画面直接退回项目预览。
  // 这里断言"轮询 HWND + 上限不低于 6000ms + 实际等待时长回传"，而不是钉死某一个数字。
  // The close wait needs a floor and must stay a poll. A pop-out still initializing can take
  // far longer than the early 1.8s cap, which failed the whole native session and dropped the
  // wallpaper to its cover art. Assert the poll, a >= 6000ms cap, and the reported wait
  // instead of pinning one magic number.
  const closeWaitMatch = runtimeText.match(
    /closeWait\.ElapsedMilliseconds < (\d+)\)\s*Thread\.Sleep\((\d+)\)/
  );
  const closeWaitCeilingMs = closeWaitMatch ? Number(closeWaitMatch[1]) : 0;
  if (!/nativeWindowControlScript/.test(runtimeText) || !/GetWindowThreadProcessId/.test(runtimeText)
    || !/Capture window title mismatch/.test(runtimeText) || !/Window process mismatch/.test(runtimeText)
    || !/SetThreadDpiAwarenessContext/.test(runtimeText) || !/new IntPtr\(-4\)/.test(runtimeText)
    || !/const int tolerance = 2/.test(runtimeText)
    || !/bool aligned = !\(Math\.Abs\(sourceRect\.Left - hostRect\.Left\)/.test(runtimeText)
    || !/_relaunchSessionWindow/.test(runtimeText) || !/correctedWidth/.test(runtimeText)
    || !/embedding\.aligned !== true/.test(runtimeText) || !/PostMessageW\(hWnd, WM_CLOSE/.test(runtimeText)
    || !/closeWait\.ElapsedMilliseconds < \d+/.test(runtimeText)
    || closeWaitCeilingMs < 6000
    || !/closeResult\.closeWaitMs = closeWait\.ElapsedMilliseconds/.test(runtimeText)
    || !/closeResult\.closed = !IsWindow\(hWnd\)/.test(runtimeText)
    || !/nativeDwmThumbnailSurfaceScript/.test(runtimeText)
    || !/DwmRegisterThumbnail/.test(dwmSurfaceBlock)
    || !/DwmUpdateThumbnailProperties/.test(dwmSurfaceBlock)
    || !/SetWindowPos\(Handle, surfaceInsertAfter/.test(dwmSurfaceBlock)
    || !/hostRoot != hostWindow && hostRoot != iconHost/.test(dwmSurfaceBlock)
    || !/SetWindowPos\(sourceWindow, Handle/.test(dwmSurfaceBlock)
    || !/_startSessionDwmSurface/.test(captureReadyBlock)
    || /parkActiveWindow|_startSessionPointerRelay/.test(captureReadyBlock)
    || !/captureMode:\s*'dwm-thumbnail'/.test(mainText + runtimeText)
    || !/if \(status && status\.active === true && status\.captureMode === 'dwm-thumbnail'\) return/.test(mainText)
    || /\bSetParent\b|SetWindowLong|SW_HIDE|DwmSetWindowAttribute/.test(dwmSurfaceBlock)) {
    fail('Wallpaper Engine source must stay pixel-aligned behind a validated DWM live surface without capture parking or synthetic input');
  }
  if (!/analyzeSceneProperties/.test(libraryText) || !/getProjectDetails/.test(libraryText)
    || !/muteProperties:\s*propertyAnalysis\.muteProperties/.test(libraryText)
    || !/'applyProperties'/.test(runtimeText)
    || !/RAW~\(\$\{JSON\.stringify\(properties\)\}\)~END/.test(runtimeText)
    || !/windowsVerbatimArguments:\s*!!verbatimArgs/.test(runtimeText)
    || !/cwd:\s*path\.dirname\(executable\)/.test(runtimeText)
    || /['"]mute['"]/.test(runtimeText)
    || !/openWallpaperEngineProjectDetails/.test(rendererText)
    || !/wallpaper-engine-details-drawer/.test(htmlText)
    || !/audioMuted/.test(runtimeText)) {
    fail('Wallpaper Engine Scene audio must stay location-scoped and silent without a global Wallpaper Engine mute');
  }
  // 终点锚点换成"捕获渲染分支的开头"：DWM 块与捕获块的分界就是这一行，字符串不会再随
  // 捕获实现（场景窗口 / DWM 表面）变化而漂走。
  const rendererDwmStartBlock = rendererText.slice(
    rendererText.indexOf("if (result.captureMode === 'dwm-thumbnail')"),
    rendererText.indexOf('var glassCaptureRender = result.captureMode')
  );
  if (!/stopWallpaperEngineCaptureStream\(false\)/.test(rendererDwmStartBlock)
    || !/wallpaperEngineCaptureMode = 'dwm-thumbnail'/.test(rendererDwmStartBlock)
    || !/wallpaperEngineLayerReady\('dwm'/.test(rendererDwmStartBlock)
    || /srcObject\s*=/.test(rendererDwmStartBlock)
    || /wallpaper-engine-cursor-proxy/.test(htmlText + cssText + rendererText)
    || /\b(?:GetCursorPos|ScreenToClient|SetCursorPos|SendInput|ShowCursor|SetSystemCursor|SetWindowsHookEx)\b/.test(dwmSurfaceBlock + mainText + preloadText)) {
    fail('Wallpaper Engine DWM mode must avoid Chromium capture and preserve the one real Windows cursor');
  }
  if (!/DwmRegisterThumbnail/.test(dwmSurfaceBlock)
    || /DwmQueryThumbnailSourceSize/.test(dwmSurfaceBlock)
    || /GlassRefractionSurface/.test(dwmSurfaceBlock)
    || /Mineradio WE Glass Refraction/.test(dwmSurfaceBlock)
    || /DWM_TNP_RECTSOURCE/.test(dwmSurfaceBlock)
    || /command\.StartsWith\("G\|"/.test(dwmSurfaceBlock)
    || /WS_EX_TRANSPARENT|WS_EX_NOACTIVATE/.test(dwmSurfaceBlock)
    || /const double zoom|1\.105/.test(dwmSurfaceBlock)
    || dwmSurfaceBlock.indexOf('taskbar.DeleteTab(Handle)') < dwmSurfaceBlock.indexOf('void ActivateThumbnail()')
    || !/session\.dwmGlassSurfaceWindowId = session\.dwmSurfaceWindowId/.test(runtimeText)
    || !/single-dwm-svg-sampler/.test(runtimeText)
    || !/updateGlassSurface/.test(runtimeText)
    || !/getDwmGlassCaptureSource/.test(runtimeText)
    || !/source\.name \|\| ''\) === 'Mineradio WE DWM Surface'/.test(runtimeText)
    || !/mineradio-wallpaper-engine-glass-surface/.test(mainText)
    || !/kind: 'dwm-glass'/.test(mainText)
    || !/prepareWallpaperEngineRendererGlassCapture/.test(mainText)
    || !/__mineradioPrepareWallpaperEngineGlassCapture/.test(rendererText)
    || !/trustedCursorFreeSurface: true/.test(rendererText)
    || !/wallpaper-engine-glass-sampler/.test(htmlText + cssText)
    || !/wallpaper-engine-glass-sampler-ready/.test(rendererText + cssText)
    || !/waitForWallpaperEngineGlassSamplerPixelChange/.test(rendererText)
    || !/meanAbsoluteRgbFromPriming/.test(rendererText)
    || !/syncWallpaperEngineControlGlassSurface/.test(controlGlassText)
    || !/getBoundingClientRect\(\)/.test(controlGlassText)
    || !/animateWallpaperEngineControlGlassSurface/.test(controlGlassText)
    || !/kind === 'dwm'/.test(rendererText)) {
    fail('Wallpaper Engine DWM mode must feed a cursor-free 1:1 sampler through the existing SVG control-console glass');
  }
  if (!/scheduleWallpaperEngineHostBoundsRestart/.test(mainText) || !/suspendWallpaperEngineForHiddenHost/.test(mainText) || !/resumeWallpaperEngineForVisibleHost/.test(mainText) || !/win\.on\('move'[\s\S]{0,220}scheduleWallpaperEngineHostBoundsRestart\(win, 'move'\)/.test(mainText) || !/win\.on\('resize'[\s\S]{0,220}scheduleWallpaperEngineHostBoundsRestart\(win, 'resize'\)/.test(mainText) || !/scheduleWallpaperEngineHostBoundsRestart\([\s\S]{0,180}display-metrics-changed/.test(mainText) || !/phase:\s*'prepare'/.test(mainText) || !/phase:\s*'restart'/.test(mainText) || !/mineradio-wallpaper-engine-host-bounds-changed/.test(mainText) || !/onWallpaperEngineHostBoundsChanged/.test(preloadText) || !/handleWallpaperEngineHostBoundsChange/.test(rendererText) || !/wallpaperEngineHostBoundsPreparing/.test(rendererText) || !/restartWallpaperEngineAfterHostBoundsChange/.test(rendererText) || !/status\.captureMode === 'dwm-thumbnail'\) return/.test(mainText) || !/followTimer\.Interval = FOLLOW_IDLE_INTERVAL_MS/.test(dwmSurfaceBlock) || !/FOLLOW_ACTIVE_INTERVAL_MS = 16/.test(dwmSurfaceBlock) || !/SWP_NOSIZE/.test(dwmSurfaceBlock) || !/geometrySame/.test(dwmSurfaceBlock) || !/FollowHost\(\)/.test(dwmSurfaceBlock)) {
    fail('Wallpaper Engine DWM surfaces must follow move/resize in place while the legacy capture fallback remains restart-safe');
  }
  const wallpaperHostRestartBlock = rendererText.slice(
    rendererText.indexOf('function restartWallpaperEngineAfterHostBoundsChange'),
    rendererText.indexOf('function handleWallpaperEngineHostBoundsChange')
  );
  const wallpaperPageHideHandler = rendererText.match(/window\.addEventListener\('pagehide', function \(\) \{([\s\S]*?)\n\s*\}\);/);
  if (!/function wallpaperEngineUsesDesktopHostLifecycle/.test(rendererText) || !/function wallpaperEngineNativeHostUnavailable/.test(rendererText) || !/document\.hidden && !\(payload && payload\.forceVisibleHost === true\)/.test(rendererText) || !/setMainWindowBackgroundThrottling\(win, false\)/.test(mainText) || !/matched && confirmed && wallpaperEngineHostVisibilityResumePending/.test(mainText) || !/wallpaperEngineHostRecoveryInFlight/.test(rendererText) || !/if \(wallpaperEngineUsesDesktopHostLifecycle\(\)\) \{[\s\S]{0,260}!document\.hidden[\s\S]{0,180}restartWallpaperEngineAfterHostBoundsChange\(\)[\s\S]{0,100}return;/.test(rendererText) || wallpaperHostRestartBlock.includes('stopWallpaperEngineNativeSession()') || !wallpaperPageHideHandler || wallpaperPageHideHandler[1].includes('stopWallpaperEngineNativeSession()')) {
    fail('Wallpaper Engine desktop Scene visibility must be owned by the main-process prepare/restart lifecycle without renderer stop-all races');
  }
  const wallpaperBoundsPrepareBlock = mainText.slice(
    mainText.indexOf('async function prepareWallpaperEngineRendererHostBoundsFrame'),
    mainText.indexOf('function stopWallpaperEngineRuntimeForRenderer')
  );
  const wallpaperBoundsScheduleBlock = mainText.slice(
    mainText.indexOf('function scheduleWallpaperEngineHostBoundsRestart'),
    mainText.indexOf('function configureLocalAppPermissions')
  );
  const wallpaperCaptureResultBlock = mainText.slice(
    mainText.indexOf("ipcMain.handle('mineradio-wallpaper-engine-capture-result'"),
    mainText.indexOf("ipcMain.handle('mineradio-wallpaper-engine-stop-scene'")
  );
  const boundsTimerIndex = wallpaperBoundsScheduleBlock.indexOf('wallpaperEngineHostBoundsRestartTimer = setTimeout');
  const boundsPrepareIndex = wallpaperBoundsScheduleBlock.indexOf('prepareWallpaperEngineRendererHostBoundsFrame');
  if (!wallpaperBoundsPrepareBlock.includes('await mainWindow.webContents.executeJavaScript(script, true)')
    || wallpaperBoundsPrepareBlock.includes('Promise.race(')
    || /WALLPAPER_ENGINE_BOUNDS_FREEZE_TIMEOUT_MS/.test(mainText)) {
    fail('Wallpaper Engine bounds freeze must await its renderer result without an uncancellable timeout race');
  }
  if (!/if \(wallpaperEngineHostBoundsRestartTimer\) clearTimeout\(wallpaperEngineHostBoundsRestartTimer\)/.test(wallpaperBoundsScheduleBlock)
    || boundsTimerIndex < 0
    || boundsPrepareIndex <= boundsTimerIndex
    || !/job\.started = true/.test(wallpaperBoundsScheduleBlock)
    || !/\}, 260\);/.test(wallpaperBoundsScheduleBlock)) {
    fail('Wallpaper Engine host movement must use a true resettable settled debounce before freezing or stopping the live source');
  }
  if (!/let wallpaperEngineHostBoundsFollowupReason = ''/.test(mainText)
    || !/job && job\.started === true[\s\S]{0,320}wallpaperEngineHostBoundsFollowupReason =/.test(wallpaperBoundsScheduleBlock)
    || !/wallpaperEngineHostBoundsFollowupReason[\s\S]{0,320}scheduleWallpaperEngineHostBoundsRestart\(mainWindow, followupReason\)/.test(wallpaperCaptureResultBlock)) {
    fail('Wallpaper Engine bounds changes arriving during a restart must be replayed after the capture acknowledgement');
  }
  if (!/if \(expectedSessionId && !wallpaperEngineCaptureGrant\) return false/.test(mainText)
    || !/confirmed = await wallpaperEngineRuntime\.confirmCaptureReady/.test(wallpaperCaptureResultBlock)
    || !/captureReady:\s*confirmed/.test(wallpaperCaptureResultBlock)
    || !/stale:\s*true,[\s\S]{0,160}frozen:\s*!!\(prepared && prepared\.frozen === true\)/.test(wallpaperBoundsScheduleBlock)
    || !/bounds-stale-recovery/.test(wallpaperBoundsScheduleBlock)
    || !/const ownsCurrentJob = wallpaperEngineHostBoundsStopPromise === job/.test(wallpaperBoundsScheduleBlock)
    || !/const recoveryOnly = !ownsCurrentJob \|\| !operationCurrent/.test(wallpaperBoundsScheduleBlock)) {
    fail('Wallpaper Engine late capture acknowledgements and stale frozen bounds jobs must recover without reviving an old session');
  }
  if (!/win\.on\('enter-full-screen'[\s\S]{0,420}scheduleWallpaperEngineHostBoundsRestart\(win, 'enter-full-screen'\)/.test(mainText)
    || !/win\.on\('leave-full-screen'[\s\S]{0,420}scheduleWallpaperEngineHostBoundsRestart\(win, 'leave-full-screen'\)/.test(mainText)
    || !/win\.on\('enter-html-full-screen'[\s\S]{0,420}scheduleWallpaperEngineHostBoundsRestart\(win, 'enter-html-full-screen'\)/.test(mainText)
    || !/win\.on\('leave-html-full-screen'[\s\S]{0,420}scheduleWallpaperEngineHostBoundsRestart\(win, 'leave-html-full-screen'\)/.test(mainText)
    || !/forceVisibleHost:\s*true/.test(wallpaperBoundsScheduleBlock)) {
    fail('Wallpaper Engine native and HTML fullscreen transitions must explicitly re-arm the authoritative bounds restart');
  }
  const wallpaperFreezeFrameBlock = rendererText.slice(
    rendererText.indexOf('function captureWallpaperEngineFreezeFrame'),
    rendererText.indexOf('function clearWallpaperEngineFreezeFrame')
  );
  if (!/var freezeScale = Math\.min\(1, 3840 \/ Math\.max\(1, video\.videoWidth\), 2160 \/ Math\.max\(1, video\.videoHeight\)\)/.test(wallpaperFreezeFrameBlock)
    || !/video\.videoWidth \* freezeScale/.test(wallpaperFreezeFrameBlock)
    || !/video\.videoHeight \* freezeScale/.test(wallpaperFreezeFrameBlock)) {
    fail('Wallpaper Engine freeze frames must use one uniform scale so ultrawide sources keep their aspect ratio');
  }
  if (!wallpaperPageHideHandler
    || !/typeof wallpaperEngineHostBoundsUnsubscribe === 'function'[\s\S]{0,180}wallpaperEngineHostBoundsUnsubscribe\(\)[\s\S]{0,180}wallpaperEngineHostBoundsUnsubscribe = null/.test(wallpaperPageHideHandler[1])) {
    fail('Wallpaper Engine host-bounds IPC listeners must be unsubscribed during page teardown');
  }
  if (!/if \(wallpaperEngineSelection\.mediaType === 'video'\)[\s\S]{0,600}if \(document\.hidden\)[\s\S]{0,180}video\.pause\(\)[\s\S]{0,360}requestWallpaperEngineVideoPlayback/.test(rendererText) || !/var animatedImage[\s\S]{0,360}if \(document\.hidden\)[\s\S]{0,180}clearWallpaperEngineLayerMedia\(0\)[\s\S]{0,180}applyWallpaperEngineBackground\(item, true\)/.test(rendererText)) {
    fail('Wallpaper Engine media videos and animated previews must retain their hidden pause/unload and visible resume behavior');
  }
  if (!/MINERADIO_NATIVE_TEMP_DIR/.test(systemMemoryText) || !/setNativeTempPath/.test(systemMemoryText) || !/TEMP:\s*ensureNativeTempPath\(\)/.test(systemMemoryText) || !/NATIVE_HELPER_TEMP_PATH/.test(mainText) || !/nativeTempPath:\s*NATIVE_HELPER_TEMP_PATH/.test(mainText) || !/TEMP:\s*this\.nativeTempPath/.test(runtimeText)) {
    fail('PowerShell Add-Type helpers must use the app-owned stable native temp directory');
  }
  // native 临时区里「每次唯一命名」的 helper 脚本只在正常退出时删除，被强杀 / 崩溃就会残留。
  // 启动时必须清一遍；阈值也不许缩小到会误删另一个实例正在跑的脚本。同理，任何模块都不许
  // 把这类脚本写到 os.tmpdir() —— 那里清扫够不着。
  // Uniquely named native helper scripts are removed only on a clean exit and survive a forced
  // kill, so startup has to prune them; the age threshold must stay long enough not to delete a
  // script another instance is running, and no module may fall back to os.tmpdir().
  {
    const cleanupText = fs.readFileSync(path.join(appRoot, 'desktop', 'native-temp-cleanup.js'), 'utf8');
    const spotifyProbeText = fs.readFileSync(path.join(appRoot, 'desktop', 'spotify-client-probe.js'), 'utf8');
    const logRotationText = fs.readFileSync(path.join(appRoot, 'desktop', 'log-rotation.js'), 'utf8');
    if (!/pruneStaleNativeTempScripts\(NATIVE_HELPER_TEMP_PATH\)/.test(mainText)
      || !/DEFAULT_MAX_AGE_MS = 10 \* 60 \* 1000/.test(cleanupText)
      || !/UNIQUE_HELPER_NAME = \/\^mineradio-/.test(cleanupText)
      || /require\('os'\)/.test(spotifyProbeText)
      || !/appendLogLine\(target, line\)/.test(runtimeText)
      || !/appendLogLine\(file, payload\)/.test(mainText)
      || !/DEFAULT_MAX_BYTES = 4 \* 1024 \* 1024/.test(logRotationText)) {
      fail('Native helper scripts must be pruned at startup by name shape and age, never written to os.tmpdir(), and diagnostic logs must use the rotating append');
    }
  }
  if (/MINERADIO_WE_QA_CLEANUP/.test(mainText) || /taskkill\.exe[\s\S]{0,120}wallpaper(?:32|64)/i.test(mainText) || /x:\s*-16000[\s\S]{0,80}y:\s*-16000/.test(mainText) || !/width:\s*Math\.max\(640,[\s\S]{0,220}physicalBounds\.width[\s\S]{0,220}x:\s*physicalBounds\.x,[\s\S]{0,80}y:\s*physicalBounds\.y/.test(mainText)) {
    fail('Wallpaper Engine release code must launch at the host pixel origin without QA cleanup or fixed offscreen coordinates');
  }
  if (!/capturePrepared:\s*true,\s*captureMode:\s*'dwm-thumbnail'/.test(mainText)
    || !/reportWallpaperEngineCaptureResult\(sessionId, true\)/.test(rendererDwmStartBlock)
    || !/dwmAcknowledgement\.captureReady !== true/.test(rendererDwmStartBlock)
    || !/confirmCaptureReady/.test(mainText + runtimeText)
    || !/dwmSurfaceReady !== true/.test(captureReadyBlock)
    || !/activateDwmSurface/.test(mainText + runtimeText)
    || !/activateWallpaperEngineDwmSurface/.test(preloadText + rendererText)) {
    fail('Wallpaper Engine Scene projects must prime the cursor-free sampler before activating the live DWM thumbnail');
  }
  const permissionAllowlist = mainText.match(/const LOCAL_APP_PERMISSION_ALLOWLIST\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (!/\^window:\\d\+:\\d\+\$/.test(runtimeText) || !/wallpaperEngineCaptureGrant/.test(mainText)
    || !/wallpaperEngineCaptureOperation/.test(mainText) || !/refreshActiveSource/.test(mainText)
    || !/sourceWindowAligned !== true/.test(mainText) || !/stopWallpaperEngineRuntimeForRenderer/.test(mainText)
    || !/payload\.all === true/.test(mainText) || !permissionAllowlist || /['"]media['"]/.test(permissionAllowlist[1])) {
    fail('Wallpaper Engine DWM readiness must stay bound to the exact source/session without broad media permission');
  }
  if (!QUIT_TEXT.includes('cleanupPromise') || !QUIT_TEXT.includes('event.preventDefault()') || !QUIT_TEXT.includes('Promise.race([runtimeCleanup, timeoutCleanup])')) {
    fail('Wallpaper Engine shutdown must wait briefly for the Mineradio-owned source window to close');
  }
  if (!/if \(stopAll\) \{[\s\S]{0,220}wallpaperEngineCaptureOperation \+= 1;[\s\S]{0,220}clearWallpaperEngineCaptureGrant\(\);[\s\S]{0,220}\}\s*const result = await wallpaperEngineRuntime\.stop/.test(mainText)) {
    fail('Wallpaper Engine global stop must invalidate capture operations before awaiting source shutdown');
  }
  if (!/function wallpaperEngineNativeStartIsCurrent[\s\S]{0,320}!wallpaperEngineNativeHostUnavailable\(\)/.test(rendererText) || !/cancelWallpaperEngineSwitchTimer\(\);[\s\S]{0,180}\+\+wallpaperEngineLayerToken;[\s\S]{0,180}stopWallpaperEngineNativeSession\(\)/.test(rendererText) || !/matchesPending/.test(runtimeText) || !/matchesActive/.test(runtimeText)) {
    fail('Wallpaper Engine hidden/switch races must invalidate delayed starts and stop both active and pending sessions');
  }
  const fixtureResult = spawnSync(process.execPath, [path.join(appRoot, 'scripts', 'check-wallpaper-engine-library.js')], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (fixtureResult.status !== 0) {
    process.stdout.write(fixtureResult.stdout || '');
    process.stderr.write(fixtureResult.stderr || '');
    fail('Wallpaper Engine fixture/path/range checks failed');
  }
  const runtimeFixtureResult = spawnSync(process.execPath, [path.join(appRoot, 'scripts', 'check-wallpaper-engine-runtime.js')], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (runtimeFixtureResult.status !== 0) {
    process.stdout.write(runtimeFixtureResult.stdout || '');
    process.stderr.write(runtimeFixtureResult.stderr || '');
    fail('Wallpaper Engine signed runtime/session/capture checks failed');
  }
  console.log('[OK] Independent layer, native Scene runtime, opaque IPC IDs, path containment, safe previews, Range streaming, and original-background restore are guarded.');
}

function checkDesktopWallpaperModeGuard() {
  logStep('Desktop wallpaper mode guard');
  const fullDesktopRuntimePath = path.join(appRoot, 'desktop', 'full-desktop-mode-runtime.js');
  const iconShapeRuntimePath = path.join(appRoot, 'desktop', 'desktop-icon-shape-runtime.js');
  const nativeIconLayerRuntimePath = path.join(appRoot, 'desktop', 'desktop-native-icon-layer-runtime.js');
  const wallpaperEngineRuntimePath = path.join(appRoot, 'desktop', 'wallpaper-engine-runtime.js');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const desktopModeIpcText = fs.readFileSync(path.join(appRoot, 'desktop', 'ipc-desktop-mode.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const fullDesktopRuntimeText = fs.readFileSync(fullDesktopRuntimePath, 'utf8');
  const iconShapeRuntimeText = fs.readFileSync(iconShapeRuntimePath, 'utf8');
  const nativeIconLayerRuntimeText = fs.readFileSync(nativeIconLayerRuntimePath, 'utf8');
  const wallpaperEngineRuntimeText = fs.readFileSync(wallpaperEngineRuntimePath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const wallpaperToggleTag = htmlText.match(/<[^>]*\bid=["']t-wallpaperMode["'][^>]*>/i);
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const layoutText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const persistenceText = readVisualArchiveText();
  const panelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const bindingText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const shellText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'), 'utf8');
  const splashText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '03-splash.js'), 'utf8');
  const bottomControlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '04-bottom-controls-cursor.js'), 'utf8');
  const isolatedDesktopText = [
    fullDesktopRuntimeText,
    iconShapeRuntimeText,
    nativeIconLayerRuntimeText,
    shellText,
  ].join('\n');
  const createWallpaperWindowStart = mainText.indexOf('async function createWallpaperWindow');
  const closeWallpaperWindowStart = mainText.indexOf('async function closeWallpaperWindow');
  const createWallpaperWindowBlock = createWallpaperWindowStart >= 0
    && closeWallpaperWindowStart > createWallpaperWindowStart
    ? mainText.slice(createWallpaperWindowStart, closeWallpaperWindowStart)
    : '';

  const removedLegacyCanvasFiles = [
    path.join(appRoot, 'desktop', 'wallpaper-preload.js'),
    path.join(appRoot, 'public', 'wallpaper.html'),
  ];
  for (const file of removedLegacyCanvasFiles) {
    if (fs.existsSync(file)) {
      fail(`removed legacy Canvas wallpaper asset must stay out of the app and package: ${rel(file)}`);
    }
  }
  const packagedFiles = packageJson.build && Array.isArray(packageJson.build.files)
    ? packageJson.build.files
    : [];
  if (!packagedFiles.includes('!desktop/wallpaper-preload.js')
    || !packagedFiles.includes('!public/wallpaper.html')) {
    fail('electron-builder must explicitly exclude the removed legacy Canvas wallpaper assets');
  }

  const forbiddenLegacyBackdropMarkers = [
    'DesktopWallpaperRuntime',
    'desktopWallpaperRuntime',
    'desktopWallpaperBackdrop',
    'queueDesktopWallpaperBackdrop',
    'disposeDesktopWallpaperBackdrop',
    'syncDesktopWallpaperBackdropHealth',
    'wallpaper-mode-runtime',
    'wallpaper-preload.js',
    'wallpaper.html',
  ];
  for (const marker of forbiddenLegacyBackdropMarkers) {
    if (mainText.includes(marker)) {
      fail(`full desktop mode must not load or revive the removed legacy WorkerW canvas backdrop: ${marker}`);
    }
  }
  if ((mainText.match(/new WallpaperEngineRuntime/g) || []).length !== 1
    || !/single-dwm-svg-sampler/.test(wallpaperEngineRuntimeText)
    || /Mineradio WE Glass Refraction/.test(wallpaperEngineRuntimeText)
    || !/captureMode:\s*'dwm-thumbnail'/.test(mainText + wallpaperEngineRuntimeText)
    || !/new FullDesktopModeRuntime/.test(mainText)) {
    fail('full desktop mode must use one existing Wallpaper Engine DWM base, or reveal the normal system desktop when no WE scene is active');
  }
  if (!createWallpaperWindowBlock
    || !/enableFullDesktopMode\(mainWindow/.test(createWallpaperWindowBlock)
    || /DesktopWallpaperRuntime|desktopWallpaperRuntime|wallpaper\.html|wallpaper-preload\.js|WALLPAPER_BACKDROP/.test(createWallpaperWindowBlock)) {
    fail('entering full desktop mode must expose the complete Mineradio HUD without creating or requiring a legacy fallback wallpaper');
  }
  if (!/mineradio-wallpaper-set-enabled/.test(mainText)
    || !/mineradio-wallpaper-get-status/.test(mainText)
    || !/isTrustedMainWindowIpc/.test(mainText)
    || !/getWallpaperModeStatus/.test(preloadText)
    || !/onWallpaperModeState/.test(preloadText)) {
    fail('full desktop mode must use the trusted, status-reporting main-process lifecycle');
  }
  if (!/new FullDesktopModeRuntime/.test(mainText)
    || !/mineradio-full-desktop-icon-shields/.test(mainText + preloadText)
    || !/attachDesktopWindowForCoexistence/.test(fullDesktopRuntimeText)
    || !/SHELLDLL_DefView/.test(fullDesktopRuntimeText + iconShapeRuntimeText)
    || !/SysListView32/.test(fullDesktopRuntimeText + iconShapeRuntimeText)
    || !/setShape/.test(fullDesktopRuntimeText + iconShapeRuntimeText)
    || !/LVM_GETITEMRECT/.test(iconShapeRuntimeText)
    || !/visibleParts = new int\[\] \{ 1, 2 \}/.test(iconShapeRuntimeText)
    || !/SetWinEventHook/.test(nativeIconLayerRuntimeText)
    || !/layered-color-key/.test(nativeIconLayerRuntimeText)
    || !/KeepMainAtBottom\(\)/.test(nativeIconLayerRuntimeText)
    || !/SnapshotOriginalListViewVisibility\(\)/.test(nativeIconLayerRuntimeText)
    || !/RestoreOriginalListViewVisibility\(\)/.test(nativeIconLayerRuntimeText)
    || !/SnapshotOriginalListViewTransparency\(\)/.test(nativeIconLayerRuntimeText)
    || !/RestoreCurrentListViewTransparency\(\)/.test(nativeIconLayerRuntimeText)
    || !/SnapshotOriginalListViewBackground\(\)/.test(nativeIconLayerRuntimeText)
    || !/ApplyListViewBackgroundKey\(\)/.test(nativeIconLayerRuntimeText)
    || !/RestoreCurrentListViewBackground\(\)/.test(nativeIconLayerRuntimeText)
    || !/SendMessageTimeout/.test(nativeIconLayerRuntimeText)
    || !/SMTO_ABORTIFHUNG/.test(nativeIconLayerRuntimeText)
    || !/SetLayeredWindowAttributes\(_listView, DESKTOP_LAYER_COLOR_KEY, 255, LWA_COLORKEY\)/.test(nativeIconLayerRuntimeText)
    || !/nativeBackgroundKeyApplied/.test(nativeIconLayerRuntimeText + fullDesktopRuntimeText)
    || !/conhost\.exe/.test(nativeIconLayerRuntimeText)
    || !/--headless/.test(nativeIconLayerRuntimeText)
    || !/-NonInteractive/.test(nativeIconLayerRuntimeText)
    || !/EmitTerminal\(restored, terminalCode\)/.test(nativeIconLayerRuntimeText)
    || /SetWindowRgn\(_listView/.test(nativeIconLayerRuntimeText)
    || /EnableWindow/.test(nativeIconLayerRuntimeText)
    || !/paddingDip:\s*0/.test(fullDesktopRuntimeText)
    || !/rounding:\s*'inward'/.test(fullDesktopRuntimeText)
    || !/setHasShadow/.test(fullDesktopRuntimeText)
    || !/updateDwmDesktopIconLayering/.test(mainText)
    || !/desktop-icon-watcher-restarted/.test(fullDesktopRuntimeText)
    || !/phase = 'recovering-icon-layer'/.test(fullDesktopRuntimeText)
    || !/interactiveBindingHealthy\(\)/.test(fullDesktopRuntimeText)
    || !/reconcileInteractiveInternal\(/.test(fullDesktopRuntimeText)
    || !/embeddedDesktop\.enabled !== true[\s\S]{0,180}mainWindow\.moveTop\(\)[\s\S]{0,180}mainWindow\.focus\(\)/.test(mainText)
    || !/embeddedDesktop\.enabled === true && embeddedDesktop\.interactive === true[\s\S]{0,180}ensureIconLayerOrder\(\)/.test(mainText)
    || (mainText.match(/fullDesktopModeHostVisibilityTransitionDepth <= 0\) (?:suspend|resume)WallpaperEngineFor/g) || []).length < 2
    || !/consecutiveFollowFailures >= 8/.test(wallpaperEngineRuntimeText)
    || !/session\.dwmSurfaceDesktopIconLayering = enabled;[\s\S]{0,180}session\.dwmSurfaceReady !== true/.test(wallpaperEngineRuntimeText)
    || /GetCursorPos|SetCursorPos|SendInput|SetWindowsHookEx|WM_MOUSEMOVE|EnableWindow/.test(fullDesktopRuntimeText + iconShapeRuntimeText + nativeIconLayerRuntimeText)) {
    fail('full desktop coexistence must preserve the visible Mineradio HUD, survive native watcher/DWM retries, and remain below the exactly restored Explorer icon plane');
  }
  if (!/id="desktop-mode-control-dock"/.test(htmlText)
    || !/id="desktop-software-lock-toggle"/.test(htmlText)
    || !/id="desktop-icons-visible-toggle"/.test(htmlText)
    || !/desktop-wallpaper-mode\.desktop-wallpaper-interactive #desktop-mode-control-dock/.test(cssText)
    || !/desktop-mode-control-peek #desktop-mode-control-dock/.test(cssText)
    || !/setDesktopSoftwareLocked/.test(preloadText + shellText)
    || !/setDesktopIconsVisible/.test(preloadText + shellText)
    || !/requestDesktopKeyboardFocus/.test(preloadText + shellText)
    || !/updateDesktopPointerRoute/.test(preloadText + shellText)
    || !/mineradio-full-desktop-set-software-lock/.test(mainText + desktopModeIpcText)
    || !/mineradio-full-desktop-set-icons-visible/.test(mainText + desktopModeIpcText)
    || !/mineradio-full-desktop-request-keyboard-focus/.test(mainText + desktopModeIpcText)
    || !/mineradio-full-desktop-pointer-route/.test(mainText + desktopModeIpcText)
    || !/applyInteractivePointerRoute[\s\S]{0,900}softwareInteractionLocked === true[\s\S]{0,180}overDesktopControls !== true/.test(fullDesktopRuntimeText)
    || !/setIgnoreMouseEvents', null, true, \{ forward: true \}/.test(fullDesktopRuntimeText)
    || !/setSoftwareInteractionLocked\(/.test(fullDesktopRuntimeText)
    || !/requestKeyboardFocus\(/.test(fullDesktopRuntimeText)
    || !/safeCall\(webContents, 'focus'/.test(fullDesktopRuntimeText)
    || /requestKeyboardFocus[\s\S]{0,1800}safeCall\(win, '(?:focus|show|moveTop)'/.test(fullDesktopRuntimeText)
    || !/setDesktopIconsVisible/.test(fullDesktopRuntimeText)
    || !/overRevealEdge/.test(shellText)
    || !/document\.addEventListener\('pointerdown'[\s\S]{0,220}!desktopModeControlDockState\.open \|\| dock\.contains\(event\.target\)[\s\S]{0,220}setDesktopModeControlsOpen\(false\)/.test(shellText)
    || !/event && event\.isTrusted[\s\S]{0,100}requestDesktopKeyboardFocus\('pointerdown'\)/.test(shellText)
    || /pointState\.overHotspot\) setDesktopModeControlsOpen\(true\)/.test(shellText)
    || !/desktopUsesLayeredExplorerColorkey/.test(shellText)
    || !/revealDesktopWallpaperUiOnActivation/.test(shellText)
    || !/desktopWallpaperUiActivationState/.test(shellText)
    || !/ensureDesktopWallpaperFunctionalUi/.test(shellText)
    || !/releaseDesktopWallpaperStartupVisibilityGate/.test(shellText)
    || !/document\.documentElement\.classList\.remove\('startup-fast-skip-preload'\)/.test(splashText)
    || /releaseStartupFastSkipPreload\(\)[\s\S]{0,260}requestAnimationFrame\(function \(\) \{[\s\S]{0,180}startup-fast-skip-preload/.test(splashText)
    || !/setImmersiveMode\(false\)/.test(shellText)
    || !/holdBottomControlsVisible\(4200\)/.test(shellText)
    || !/desktopWallpaperKeepsPlayerConsoleVisible/.test(bottomControlsText)
    || !/desktop-wallpaper-hud-prime/.test(shellText)
    || !/desktop-wallpaper-hud-prime\.desktop-wallpaper-mode\.desktop-wallpaper-interactive #bottom-bar,[\s\S]{0,220}desktop-wallpaper-hud-prime\.desktop-wallpaper-mode\.desktop-wallpaper-interactive #empty-home[\s\S]{0,100}transition:\s*none\s*!important/.test(cssText)
    || !/desktop-wallpaper-mode\.desktop-wallpaper-interactive\.empty-home-active #empty-home[\s\S]{0,220}opacity:\s*1\s*!important/.test(cssText)
    || !/desktop-wallpaper-mode\.desktop-wallpaper-interactive:not\(\.empty-home-active\):not\(\.home-controls-locked\) #bottom-bar\.visible:not\(\.soft-hidden\)[\s\S]{0,240}opacity:\s*\.91\s*!important/.test(cssText)
    || !/desktop-wallpaper-mode #bottom-handle/.test(cssText)
    || !/--desktop-safe-bottom/.test(cssText)
    || /desktop-explorer-overlay/.test(shellText + cssText)
    || /desktop-explorer-layered-colorkey[^\{]*\{[\s\S]{0,700}(?:#custom-bg|#album-bg|#wallpaper-engine-layer)[\s\S]{0,300}(?:opacity:\s*0|visibility:\s*hidden)/.test(cssText)
    || !/clearDesktopIconRevealMask\(\)/.test(shellText)
    || !/document\.addEventListener\('mousemove'/.test(shellText)
    || !/setTimeout/.test(shellText)
    || !/globalShortcut\.register\('Escape'/.test(mainText)
    || !/requestFullDesktopEscapeExit\('escape-key'\)/.test(mainText)) {
    fail('full desktop mode must keep a recoverable software lock, click-outside closing, an auto-hidden desktop controller, and a direct Escape exit path');
  }
  if (!/wallpaperFps:\s*60/.test(defaultsText)
    || !/var DEVELOPMENT_LOCKED_FX = \{\}/.test(layoutText)
    || !/normalizeWallpaperFps/.test(persistenceText + panelText + bindingText + shellText)
    || (persistenceText.match(/wallpaperMode:\s*false/g) || []).length < 2
    || !/wallpaperFps:\s*normalizeWallpaperFps\(raw\.wallpaperFps\)/.test(persistenceText)
    || !/wallpaperFps:\s*normalizeWallpaperFps\(fx\.wallpaperFps\)/.test(persistenceText)
    || !/id="wallpaper-fps-seg"/.test(htmlText)
    || !['24', '30', '60'].every((value) => htmlText.includes(`data-wallpaper-fps="${value}"`))
    || !wallpaperToggleTag
    || /\bdev-locked\b/i.test(wallpaperToggleTag[0])
    || /id="fx-wallpaperopacity"[^>]*disabled/.test(htmlText)
    || !/toggleWallpaperModeFromUi/.test(bindingText)
    || !/onWallpaperModeState/.test(preloadText + shellText)
    || !/getWallpaperModeStatus/.test(preloadText + shellText)
    || !/frameRate:\s*normalizeWallpaperFps\(fx\.wallpaperFps\)/.test(shellText)
    || /wallpaperMode/.test(archiveText)) {
    fail('experimental wallpaper UI must persist only opacity/FPS, restart disabled, and follow main-process runtime authority');
  }
  const forbiddenCursorPaths = [
    'getCursorScreenPoint',
    'GetCursorPos',
    'SetCursorPos',
    'SendInput',
    'ShowCursor',
    'SetSystemCursor',
    'SetWindowsHookEx',
    'WM_MOUSEMOVE',
    'wallpaper-engine-cursor-proxy',
    'reportWallpaperEnginePointerActivity',
    'SPI_SETDESKWALLPAPER',
    'taskkill',
    'Stop-Process',
    'wallpaper64',
  ];
  for (const marker of forbiddenCursorPaths) {
    if (isolatedDesktopText.includes(marker)) fail(`full desktop mode must not take over or poll the Windows cursor: ${marker}`);
  }
  if (/\b(?:GetCursorPos|SetCursorPos|SendInput|ShowCursor|SetSystemCursor|SetWindowsHookEx|WM_MOUSEMOVE)\b/.test(isolatedDesktopText)) {
    fail('full desktop mode must preserve the real Windows cursor and must not synthesize pointer input');
  }
  const shutdownBlock = QUIT_TEXT;
  if (!/fullDesktopModeRuntime\.dispose\('app-before-quit'\)/.test(shutdownBlock)
    || !/await disposeFullDesktopModeWithGuard\(\);[\s\S]{0,900}await wallpaperEngineRuntime\.dispose\(\)/.test(shutdownBlock)
    || !/WALLPAPER_ENGINE_WINDOW_CLOSE_FAILED/.test(shutdownBlock)
    || /DesktopWallpaper|desktopWallpaper|wallpaper-mode-runtime|wallpaper\.html/.test(shutdownBlock)) {
    fail('shutdown must detach the complete Mineradio HUD before disposing the single WE DWM chain, with no legacy backdrop cleanup path');
  }

  const coexistFixtureResult = spawnSync(process.execPath, [
    '--test',
    path.join(appRoot, 'tests', 'desktop-icon-shape-runtime.test.js'),
    path.join(appRoot, 'tests', 'full-desktop-mode-runtime.test.js'),
  ], { cwd: appRoot, encoding: 'utf8' });
  if (coexistFixtureResult.status !== 0) {
    process.stdout.write(coexistFixtureResult.stdout || '');
    process.stderr.write(coexistFixtureResult.stderr || '');
    fail('full desktop icon-coexistence fixture failed');
  }
  console.log('[OK] Legacy canvas backdrop is forbidden; the complete Mineradio HUD, recoverable software lock, desktop-icon switch, click-outside close, Escape exit, native watcher recovery, single WE DWM layering, and ordered cleanup are guarded.');
}

function checkDesktopWindowAdaptationGuard() {
  logStep('Desktop window adaptation guard');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const shellText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'), 'utf8');
  const cssText = readAllCssFiles();
  if (!/function getAdaptiveWindowMinimumSize/.test(mainText) || !/function isPortraitDisplayArea/.test(mainText)) {
    fail('main window must adapt minimum size and windowed bounds for portrait displays');
  }
  if (!/screen\.getDisplayNearestPoint\(\{/.test(mainText)
    || !/windowFullscreenDisplayId = display \? display\.id : null/.test(mainText)
    || !/win\.setBounds\(\{[\s\S]{0,260}targetBounds\.height[\s\S]{0,180}win\.setFullScreen\(true\)/.test(mainText)) {
    fail('desktop fullscreen must target the display under the window center before entering fullscreen');
  }
  if (!/screen\.on\('display-metrics-changed', handleDisplayLayoutChanged\)/.test(mainText) || !/screen\.on\('display-removed', handleDisplayLayoutChanged\)/.test(mainText)) {
    fail('desktop window must react to display metric and monitor topology changes');
  }
  if (!/function animateDesktopWindowMinimize/.test(shellText) || !/function animateDesktopWindowRestore/.test(shellText) || !/desktopWindowReducedMotion/.test(shellText)) {
    fail('desktop shell must animate minimize/restore while respecting reduced motion');
  }
  if (!/desktop-window-minimizing/.test(cssText) || !/desktop-window-restoring/.test(cssText) || !/prefers-reduced-motion:\s*reduce/.test(cssText)) {
    fail('desktop shell CSS must include minimize/restore animation and reduced-motion fallback');
  }
  console.log('[OK] Desktop shell adapts portrait displays and window minimize/restore animation.');
}

function checkLongPressReorderGuard() {
  logStep('Long press playlist/queue reorder guard');
  const queueActionsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '10-queue-actions.js'), 'utf8');
  const panelShellText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
  const playlistDetailText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const shelfCoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const shelfInteractionText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '05-card-interactions.js'), 'utf8');
  const cssText = readAllCssFiles();
  if (!/function moveQueueIndex\(/.test(queueActionsText) || !/currentSong/.test(queueActionsText) || !/saveLastPlaybackSnapshot\(true,\s*'queue-reorder'\)/.test(queueActionsText)) {
    fail('queue reorder must preserve the current playing item and persist the queue snapshot');
  }
  if (!/data-queue-index=/.test(panelShellText) || !/function bindLongPressPanelReorder/.test(panelShellText) || !/reorderLongPressMs\s*=\s*520/.test(panelShellText) || !/moveQueueIndex\(panelReorderState\.currentIndex/.test(panelShellText)) {
    fail('left queue panel must expose long-press drag reorder data and bindings');
  }
  if (!/PLAYLIST_REORDER_STORE_KEY/.test(playlistDetailText) || !/function moveUserPlaylistIndex/.test(playlistDetailText) || !/function applyUserPlaylistOrder/.test(playlistDetailText) || !/data-playlist-index=/.test(playlistDetailText)) {
    fail('playlist panel reorder must persist a stable user playlist order');
  }
  if (/function reorderCardTo|shelfPlaylistSourceIndex|reorderCardTo:/.test(shelfCoreText)) {
    fail('3D shelf manager must not expose long-press card reorder hooks');
  }
  if (/shelfLongPressReorderState|shelfLongPressReorder|reorderCardTo/.test(shelfInteractionText)) {
    fail('3D shelf interactions must not bind long-press reorder; it conflicts with shelf card interaction');
  }
  if (!/body\.panel-reordering/.test(cssText) || /body\.shelf-reordering/.test(cssText) || !/\.pl-card\[data-playlist-index\]/.test(cssText)) {
    fail('long-press reorder visual hooks are missing from CSS');
  }
  console.log('[OK] Long-press reorder stays on left playlist/queue panels and is disabled for 3D shelf cards.');
}

// 为什么值得写：2.4.x 的便携数据构建把默认值写成 'exit'，且 initializeDesktopCloseBehavior 在首次启动时
// 把默认值写回 localStorage，于是「关窗口=退出、无托盘」被永久锁死。这里守两件事：
//  (1) 存储键已从 v1 升到 v2，丢弃那个被错误持久化的 exit；
//  (2) readCloseBehaviorPreference 与 main.js 的 closeBehavior 默认值都是 'tray'，且空键时确实返回 'tray'
//      （行为验证，不是文本验证 —— 把函数抽进沙箱、localStorage 返回 null 真跑一遍）。
// Guard for the default close behavior being "stay in tray".
// An earlier portable-data build defaulted to 'exit' and initializeDesktopCloseBehavior persisted that
// default on first launch, permanently locking the window into "close = quit, no tray". This guards:
// (1) the store key was bumped v1 -> v2 to discard the wrongly-persisted exit;
// (2) readCloseBehaviorPreference and main.js both default to 'tray', and an empty key actually resolves
//     to 'tray' (behavioural: the function is extracted into a sandbox with a null localStorage).
function checkCloseBehaviorDefaultGuard() {
  logStep('Close behavior default guard');
  const storesText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const prefsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '02-preferences-ui-modes.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const storesCode = stripComments(storesText);
  const prefsCode = stripComments(prefsText);
  const mainCode = stripComments(mainText);

  if (/var CLOSE_BEHAVIOR_STORE_KEY = 'mineradio-close-behavior-v1';/.test(storesCode)) {
    fail('CLOSE_BEHAVIOR_STORE_KEY must no longer be v1; the buggy auto-persisted exit value would survive the bump');
  }
  if (!/var CLOSE_BEHAVIOR_STORE_KEY = 'mineradio-close-behavior-v2';/.test(storesCode)) {
    fail('CLOSE_BEHAVIOR_STORE_KEY must be bumped to v2 so the wrongly-persisted exit value is discarded');
  }
  if (!/function readCloseBehaviorPreference\(\)\s*\{[\s\S]*?localStorage\.getItem\(CLOSE_BEHAVIOR_STORE_KEY\) \|\| 'tray'/.test(prefsCode)) {
    fail('readCloseBehaviorPreference must default to tray when no key is stored, not exit');
  }
  if (!/function readCloseBehaviorPreference\(\)\s*\{[\s\S]*?catch \(e\)\s*\{\s*return 'tray';/.test(prefsCode)) {
    fail("readCloseBehaviorPreference's catch branch must fall back to tray, not exit");
  }
  if (!/let closeBehavior = 'tray';/.test(mainCode)) {
    fail('main.js must default closeBehavior to tray');
  }

  // 行为验证：把 normalizeCloseBehavior + readCloseBehaviorPreference 抽进沙箱真跑，localStorage 返回 null。
  // Behavioural check: extract both functions into a sandbox and run them with a null localStorage.
  const extractFn = (src, name) => {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) return null;
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
  };
  const vm = require('vm');
  const sandbox = {
    CLOSE_BEHAVIOR_STORE_KEY: 'mineradio-close-behavior-v2',
    localStorage: { _v: null, getItem() { return this._v; }, setItem(k, v) { this._v = v; } },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(prefsCode, 'normalizeCloseBehavior') + '\n' + extractFn(prefsCode, 'readCloseBehaviorPreference') + "\nthis.result = readCloseBehaviorPreference();", sandbox);
  if (sandbox.result !== 'tray') {
    fail('readCloseBehaviorPreference must resolve to tray when localStorage has no stored key; got ' + JSON.stringify(sandbox.result));
  }

  console.log('[OK] Close behavior defaults to tray; the v1 auto-persisted exit is discarded and an empty key resolves to tray.');
}

// 面板内横向工具行的溢出守卫。
// 为什么值得写：这类失效**在界面上就是"按钮不见了"**，没有任何报错 ——
// #playlist-panel 固定 340px（内边距 18px、边框 1px → 内容盒 302px），卡片内只有 280px；
// 行用 display:flex 且不换行时，按钮既不收缩（flex: 0 0 auto / min-width）又排不下，
// 就会溢出到面板外被 `contain: paint` 直接裁掉：点不到、也看不见。
// 实测过的两次：① 歌单详情操作行「播放歌单/重命名/删除/多选」需 388px，溢出 108px，
// 后两个按钮整个消失（俄文侧仅原前三项就需 315px，本来已溢出）；② 选项卡标签随语言变长，
// 日文 285px、俄文 284px、英文 274px 逼近 302px，默认的 flex-shrink 把「現在のキュー」
// 压成两行（按钮高 30→46px），再长一点就被裁。
// 判据因此盯住这组**组合特征**：不换行 + 子项不收缩 = 溢出必然被裁。要么允许换行，要么子项可收缩。
// Guard for horizontally laid-out tool rows inside the playlist panel. This failure shows up as
// "the button is gone" with nothing logged: #playlist-panel is a fixed 340px (18px padding + 1px
// border -> 302px content box) and a card leaves only 280px. With `display: flex` and no wrapping,
// buttons that neither shrink (`flex: 0 0 auto` / min-width) nor fit overflow past the panel and are
// clipped away by `contain: paint` — invisible and unclickable. Measured twice: (1) the playlist
// detail action row needs 388px for 「播放歌单/重命名/删除/多选」, overflowing by 108px and losing the
// last two buttons entirely (in Russian even the original three need 315px, so it was already
// overflowing); (2) the tab labels grow with the language — 285px Japanese, 284px Russian, 274px
// English against 302px — and the default flex-shrink broke 「現在のキュー」 onto two lines (button
// height 30 -> 46px). The judgement therefore targets the dangerous combination: no wrapping plus
// non-shrinking children means the overflow must be clipped. Either the row wraps, or its children
// may shrink.
function checkPanelRowOverflowGuard() {
  logStep('Playlist panel tool row overflow guard');
  const cssText = readAllCssFiles();
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
  const cssCode = stripComments(cssText);

  // 按精确选择器取出规则体；同名规则有多条时合并全部（后写的可能覆盖前面的）。
  function ruleBodies(selector) {
    const out = [];
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|\\})\\s*' + escaped + '\\s*\\{([^}]*)\\}', 'g');
    let match;
    while ((match = re.exec(cssCode))) out.push(match[1]);
    return out;
  }
  const declares = (bodies, property, valuePattern) =>
    bodies.some((body) => new RegExp('(?:^|;|\\{)\\s*' + property + '\\s*:\\s*' + valuePattern, 'm').test(';' + body));

  const tabsBody = ruleBodies('.panel-tabs');
  const tabBody = ruleBodies('.panel-tab');
  const actionsBody = ruleBodies('.pl-detail-actions');
  const actionChildBody = ruleBodies('.pl-detail-actions > button');

  // 两个行本身必须存在，否则下面的断言会因为"取不到规则"而空转成绿。
  // The rows themselves must exist, or the assertions below would pass vacuously.
  if (!tabsBody.length) fail('.panel-tabs rule is missing from the stylesheet');
  if (!actionsBody.length) fail('.pl-detail-actions rule is missing from the stylesheet');
  if (!tabBody.length) fail('.panel-tab rule is missing from the stylesheet');
  if (!actionChildBody.length) fail('.pl-detail-actions > button rule is missing — the row relies on it to keep buttons whole');

  // 1) 两行都必须允许换行。这是"排不下就换行"的唯一出口。
  if (!declares(tabsBody, 'flex-wrap', 'wrap\\b')) {
    fail('.panel-tabs must wrap: the tab labels grow with the language (285px Japanese vs 302px available), '
      + 'and without wrapping flex-shrink breaks a label across two lines inside its pill');
  }
  if (!declares(actionsBody, 'flex-wrap', 'wrap\\b')) {
    fail('.pl-detail-actions must wrap: the four buttons need 388px inside a 280px card, and without '
      + 'wrapping they overflow past the panel edge and `contain: paint` clips them away unseen');
  }

  // 2) 子项不许被压窄（压窄会把标签折行），且标签内部不许断行 —— 两者缺一，标签就会在两行里断开。
  if (!declares(tabBody, 'white-space', 'nowrap')) {
    fail('.panel-tab must set white-space: nowrap, or a long label breaks mid-label instead of the row wrapping');
  }
  if (!declares(tabBody, 'flex', '0\\s+0\\b|none\\b')) {
    fail('.panel-tab must be flex: 0 0 auto, or flex-shrink squeezes it and the label wraps to two lines');
  }
  if (!declares(actionChildBody, 'flex', '0\\s+0\\b|none\\b')) {
    fail('.pl-detail-actions > button must be flex: 0 0 auto, or a squeezed button hides part of its label');
  }
  if (!declares(actionChildBody, 'white-space', 'nowrap')) {
    fail('.pl-detail-actions > button must set white-space: nowrap so the row wraps instead of the label');
  }

  // 3) 不许用 overflow: hidden 把溢出的按钮"藏起来"充数 —— 那是把看不见当成修好了。
  // overflow: hidden must not be used to hide the overflow: that treats "invisible" as "fixed".
  [['.panel-tabs', tabsBody], ['.pl-detail-actions', actionsBody]].forEach(function (entry) {
    if (/(?:^|;)\s*overflow(-x)?\s*:\s*(hidden|clip)\s*(?:;|$)/m.test(';' + entry[1].join(';'))) {
      fail(entry[0] + ' must not clip its own overflow: hidden buttons are still broken, just invisible');
    }
  });

  // 4) 面板内容盒必须仍然算得出 302px。宽度或内边距一改，"排不下"的算式就变了，
  //    上面几条判据的前提也就不成立了 —— 所以把算式本身钉住。
  // The content box must still work out to 302px: changing the width or padding changes the arithmetic
  // that makes the rows overflow, and the judgements above would silently lose their premise.
  const panelBody = ruleBodies('#playlist-panel');
  const widthDecl = panelBody.join(';').match(/(?:^|;)\s*width\s*:\s*(\d+)px/);
  const paddingDecl = panelBody.join(';').match(/(?:^|;)\s*padding\s*:\s*(\d+)px/);
  if (!widthDecl || !paddingDecl) {
    fail('#playlist-panel must keep an explicit px width and padding: the overflow budget is derived from them');
  } else {
    const contentBox = Number(widthDecl[1]) - 2 * Number(paddingDecl[1]) - 2;
    if (contentBox !== 302) {
      fail('#playlist-panel content box is now ' + contentBox + 'px, not the 302px the row budgets assume: '
        + 're-measure the tab strip and the action row before changing the width or padding');
    }
  }

  console.log('[OK] Both playlist panel tool rows wrap and keep their labels whole; the 302px content budget they are sized against is pinned.');
}

function checkFullscreenToolsRowGuard() {
  logStep('Fullscreen tools row guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const prefsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '02-preferences-ui-modes.js'), 'utf8');
  const overlayText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'), 'utf8');
  const guideText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '09-idle-toast-libraries.js'), 'utf8');
  // 判据读源码文本，而上面这段注释里正写着同样的名字与历史，所以先剥注释。
  // The checks below read source text and the comments above spell out the same names, so strip first.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const cssCode = stripComments(cssText);
  const indexCode = stripComments(indexText);
  const prefsCode = stripComments(prefsText);
  const overlayCode = stripComments(overlayText);
  const guideCode = stripComments(guideText);

  // 前提：全屏隐藏标题栏。这条关系一旦不成立，工具行会和标题栏同时出现（两个 DIY 按钮）。
  if (!/body\.desktop-shell\.desktop-fullscreen #desktop-titlebar,[\s\S]{0,80}?\{\s*display:\s*none\s*!important/.test(cssCode)) {
    fail('fullscreen must keep hiding #desktop-titlebar, or the tool row and the title bar would both show up');
  }
  // 工具行只在全屏显示，且未浮现时必须整块不可达 —— 只靠 opacity:0 的话，Tab 还能聚焦到里面的按钮，
  // 读屏也会念出来。所以隐藏态必须写 visibility: hidden。
  if (!/body\.desktop-shell\.desktop-fullscreen #fullscreen-tools-zone,[\s\S]{0,80}?\{\s*display:\s*flex/.test(cssCode)) {
    fail('the tool row must only be displayed in fullscreen');
  }
  const baseRule = /(?:^|\n)#fullscreen-tools-zone \{([\s\S]*?)\n\}/.exec(cssCode);
  if (!baseRule || !/opacity:\s*0/.test(baseRule[1]) || !/visibility:\s*hidden/.test(baseRule[1]) || !/pointer-events:\s*none/.test(baseRule[1])) {
    fail('a hidden tool row must use visibility: hidden (not opacity alone): opacity:0 keeps its buttons tab-focusable and announced');
  }
  if (!/body\.fullscreen-tools-peek #fullscreen-tools-zone,[\s\S]{0,200}?visibility:\s*visible/.test(cssCode)) {
    fail('the peek class must reveal the tool row with visibility: visible');
  }
  // 桌面壁纸模式下标题栏本来就隐藏，控制入口在右上角的 dock —— 工具行要跟着不出现，别去抢位置。
  if (!/body\.desktop-shell\.desktop-wallpaper-mode #fullscreen-tools-zone\s*\{\s*display:\s*none\s*!important/.test(cssCode)) {
    fail('the tool row must stay hidden in desktop-wallpaper mode, where the title bar is hidden too');
  }

  // 旧的全屏 DIY 镜像必须彻底消失：留着它就会和搬进来的真按钮同时出现。
  if (/fullscreen-diy/.test(indexCode) || /fullscreen-diy/.test(cssCode) || /fullscreen-diy-btn/.test(prefsCode)) {
    fail('the old #fullscreen-diy-btn mirror must stay deleted — the real #diy-mode-btn now moves into the row');
  }

  // 工具行在 HTML 里必须是空的：内容由脚本搬进来。写死一个 DIY 按钮就等于又造了一个镜像。
  if (!/<div id="fullscreen-tools-zone"[^>]*><\/div>/.test(indexCode)) {
    fail('#fullscreen-tools-zone must be declared empty in index.html and filled by script');
  }

  // 名单从 HTML 反推：标题栏控件簇里每个直接子控件（窗口按钮除外）都必须被搬。反推而不是抄快照 ——
  // 抄一份的话，新增按钮永远进不了守卫范围。只取直接子元素，所以控制按钮内部的节点（例如更新入口
  // 里的进度环 #update-progress-ring）不会被误判：它们跟着外层节点一起走。
  // The list is derived from the HTML, not copied: every direct child control of the cluster (window
  // buttons aside) must be moved. Only direct children count, so inner nodes of a control (such as
  // #update-progress-ring inside the update entry) are not mistaken for controls — they travel along.
  // 标签扫描而不是正则切片：缩进/换行/换行符风格都不影响结果，重排格式也不会误判深度。
  // A tag scan instead of a regex slice: indentation, line breaks and EOL style cannot change the result.
  // ⚠️ 自闭合只认 `/>`；VOID 名单里的标签（SVG 的 circle/path、input/img 之类）两种写法都要当空气 ——
  // 只让「开始」不计数而让「结束」计数的话，一次错配就把深度提前打回 0。真实踩过：更新入口的
  // SVG 里写着 <circle ...></circle>（成对），于是扫描在它那里提前收尾，后面三个控件整个被漏掉，
  // 而漏掉的表现是「没找到任何问题」。
  // Self-closing is detected by `/>` alone; names in VOID_TAGS count neither as an open nor as a close.
  // Counting the close but not the open of a paired void element (SVG <circle></circle>) desyncs the depth
  // and silently truncates the scan — which is exactly how the three controls after it went missing.
  const TAG_TOKEN = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const VOID_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'br', 'img', 'input', 'meta', 'link']);
  const isSelfClosing = match => /\/\s*$/.test(match[3] || '') || VOID_TAGS.has(match[2].toLowerCase());
  const elementInnerHtml = (text, openAt) => {
    const bodyAt = text.indexOf('>', openAt);
    if (bodyAt < 0) fail('cannot read the title bar control cluster markup — check index.html or this guard');
    const token = new RegExp(TAG_TOKEN.source, 'g');
    token.lastIndex = bodyAt + 1;
    let depth = 0;
    let end = text.length;
    let match;
    while ((match = token.exec(text))) {
      if (match[1] === '/') {
        if (VOID_TAGS.has(match[2].toLowerCase())) continue;
        depth -= 1;
        if (depth < 0) { end = match.index; break; }
        continue;
      }
      if (isSelfClosing(match)) continue;
      depth += 1;
    }
    return text.slice(bodyAt + 1, end);
  };
  const directChildren = block => {
    const token = new RegExp(TAG_TOKEN.source, 'g');
    const children = [];
    let depth = 0;
    let match;
    while ((match = token.exec(block))) {
      // VOID 标签「开」「关」都不计数（同上：只错一侧就会把深度打偏）。
      // Void tags count on neither side for the same reason as above.
      if (VOID_TAGS.has(match[2].toLowerCase())) continue;
      if (match[1] === '/') {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (isSelfClosing(match)) continue;
      if (depth === 0) children.push(match[3] || '');
      depth += 1;
    }
    return children;
  };
  const clusterOpen = indexCode.indexOf('<div class="desktop-window-controls">');
  if (clusterOpen < 0) {
    fail('cannot locate the title bar control cluster (.desktop-window-controls) in index.html — check the markup or this guard');
  }
  const childSelector = attrs => {
    const id = /\bid="([\w-]+)"/.exec(attrs);
    if (id) return '#' + id[1];
    const cls = /\bclass="([^"]+)"/.exec(attrs);
    return cls ? '.' + cls[1].trim().split(/\s+/)[0] : '';
  };
  const childEntries = directChildren(elementInnerHtml(indexCode, clusterOpen))
    .map(attrs => ({ selector: childSelector(attrs), isWindowButton: /data-window-action=/.test(attrs) }))
    .filter(entry => entry.selector);
  const windowButtonCount = childEntries.filter(entry => entry.isWindowButton).length;
  const toolSelectors = childEntries.filter(entry => !entry.isWindowButton).map(entry => entry.selector);
  if (windowButtonCount !== 3 || toolSelectors.length < 4) {
    fail('the title bar cluster must hold the three window buttons and the tool controls — check the markup or this guard');
  }
  const moveListMatch = /var FULLSCREEN_TOOL_SELECTORS = \[([\s\S]*?)\];/.exec(prefsCode);
  if (!moveListMatch) fail('FULLSCREEN_TOOL_SELECTORS is gone: nothing moves the tool buttons into the fullscreen row');
  const moveListCode = moveListMatch[1];
  const moveTargets = (moveListCode.match(/'[#.][\w-]+'/g) || []).map(entry => entry.slice(1, -1));
  toolSelectors.forEach(selector => {
    if (moveTargets.indexOf(selector) < 0) {
      fail(`${selector} lives in the title bar but is not in FULLSCREEN_TOOL_SELECTORS — it would disappear in fullscreen`);
    }
  });
  moveTargets.forEach(target => {
    if (toolSelectors.indexOf(target) < 0) {
      fail(`${target} is listed in FULLSCREEN_TOOL_SELECTORS but is not a title bar control — the list drifted`);
    }
  });
  // 窗口按钮不该被搬：全屏下最小化/最大化/关闭没有意义，搬走反而把标题栏掏空。
  if (/data-window-action/.test(moveListCode)) {
    fail('window buttons must not be moved into the fullscreen tool row');
  }

  // 链路：状态变化时真的调用了搬移，而且拿的正是那份状态。
  if (!/document\.body\.classList\.toggle\('desktop-fullscreen', isFullScreen\)/.test(overlayCode)
    || !/desktopRuntimeState\.fullscreen = isFullScreen;[\s\S]{0,600}?syncFullscreenToolsRow\(isFullScreen\)/.test(overlayCode)) {
    fail('the desktop overlay state handler must call syncFullscreenToolsRow(isFullScreen) — otherwise the row is never filled');
  }
  if (!/function syncFullscreenToolsRow\(isFullscreen\) \{/.test(prefsCode)
    || !/function layoutFullscreenToolsZone\(\) \{/.test(prefsCode)
    || !/function updateFullscreenToolsPeekFromPointer\(x, y\) \{/.test(prefsCode)) {
    fail('syncFullscreenToolsRow / layoutFullscreenToolsZone / updateFullscreenToolsPeekFromPointer must all exist');
  }
  // 语言切换已从标题栏搬进 DIY 视觉控制台：全屏工具行不再需要「菜单开着就继续浮现」的特例，
  // 反过来要守住两件事 —— 标题栏别再出现语言按钮，语言行必须待在 #fx-panel 里。
  // The switcher moved from the title bar into the DIY visual console, so the "keep the row
  // revealed while the menu is open" special case is gone. Two reverse guards replace it:
  // no language button back in the title bar, and the language row really inside #fx-panel.
  if (/fullscreenToolsMenuOpen/.test(prefsCode) || /class="lang-switch"/.test(indexCode) || /id="lang-toggle-btn"/.test(indexCode)) {
    fail('the language switcher must stay out of the title bar; it now lives in the DIY visual console');
  }
  const fxPanelOpen = indexCode.indexOf('<div id="fx-panel">');
  const fxLangRow = indexCode.indexOf('id="fx-lang-row"');
  if (fxPanelOpen < 0 || fxLangRow < fxPanelOpen) {
    fail('#fx-lang-row must sit inside #fx-panel — otherwise the language switcher is unreachable in simple mode');
  }
  if (!/data-lang="zh_cn"/.test(indexCode) || !/data-lang="en_us"/.test(indexCode)
    || !/data-lang="ja_jp"/.test(indexCode) || !/data-lang="ru_ru"/.test(indexCode)) {
    fail('#fx-lang-row must offer all four languages as data-lang options');
  }
  // 语言选择是一个触发器 + 就地展开的滚动列表。三件事必须同时在：
  // 触发器（带 aria-expanded）、列表容器（限高可滚）、选项。少一样就退化成「一排按钮撑满一行」，
  // 或者列表展开后把面板无限拉长 / 加语言后没处滚。
  // The picker is a trigger plus an in-place scrollable list. All three must exist: the
  // trigger (with aria-expanded), the height-capped scrollable list, and the options. Missing
  // any of them either reverts to a row of buttons or lets the list stretch the panel.
  if (!/id="fx-lang-trigger"/.test(indexCode) || !/aria-expanded="false"/.test(indexCode)
    || !/id="fx-lang-menu"[^>]*hidden/.test(indexCode)) {
    fail('#fx-lang-row must be a trigger + collapsed list, not a row of always-visible buttons');
  }
  const fxLangMenuCss = (cssCode.match(/\.fx-lang-menu\s*\{[^}]*\}/) || [''])[0];
  if (!/max-height:\s*\d+px/.test(fxLangMenuCss) || !/overflow-y:\s*auto/.test(fxLangMenuCss)) {
    fail('.fx-lang-menu must cap its height and scroll (max-height + overflow-y:auto)');
  }
  if (!/\.fx-lang-menu\[hidden\]\s*\{[^}]*display:\s*none/.test(cssCode)) {
    fail('.fx-lang-menu[hidden] must beat display:flex, or the list never collapses');
  }
  const langSwitcherText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '14-i18n-switcher.js'), 'utf8');
  if (!/function setOpen\(open\)/.test(langSwitcherText) || !/\.hidden = !open/.test(langSwitcherText)
    || !/i18n\.langLabel\(/.test(langSwitcherText)) {
    fail('the language switcher must toggle the list and label the trigger from the active language');
  }

  // 视觉引导的 DIY 那一步：引导进行中指针浮现被挡着，得靠 .fullscreen-tools-guided 把行亮出来。
  // 三处必须一致 —— 引导加类、CSS 因它显示、CSS 的引导态压制又要把它排除在外。
  if (!/classList\.toggle\('fullscreen-tools-guided', isFullscreenToolRowStep\)/.test(guideCode)
    || !/body\.fullscreen-tools-guided #fullscreen-tools-zone/.test(cssCode)
    || !/body\.visual-guide-active:not\(\.fullscreen-tools-guided\) #fullscreen-tools-zone/.test(cssCode)
    || !/classList\.remove\('fullscreen-tools-guided'\)/.test(guideCode)) {
    fail('the visual guide must be able to reveal the tool row for its DIY step, and must clear that state on close');
  }
  console.log('[OK] Fullscreen tool row wiring, control coverage, and reveal/visibility rules are in sync.');
}

module.exports = {
  checkMainWindowChrome,
  checkBackgroundTransparencyControlsGuard,
  checkWallpaperEngineImportGuard,
  checkDesktopWallpaperModeGuard,
  checkDesktopWindowAdaptationGuard,
  checkLongPressReorderGuard,
  checkCloseBehaviorDefaultGuard,
  checkPanelRowOverflowGuard,
  checkFullscreenToolsRowGuard,
};
