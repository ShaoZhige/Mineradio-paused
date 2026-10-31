'use strict';

// ── 必须知道的加载模型（改这个文件之前先读完）────────────────────────────────
// 1. 下面每一条路径都是一个**独立的 classic <script src>**，由本文件按顺序注入
//    （不是 ES module，没有 import/export）。因此：
//    - 所有顶层 `function` / `var` 仍然落在**同一个全局作用域**里，模块之间靠名字互相看见；
//      两个模块用了同名顶层名字会**互相覆盖且不报错**（`startup-bundle-execution` 守卫拦这个）。
//    - 但**没有跨文件的函数提升**：A 执行时，B 里声明的函数还不存在。所以「A 在顶层调用 B 的
//      函数」这种写法是硬错误，必须把被调用的东西挪到 A 之前，或者用 `__mineradioDefer` 推迟。
//      这是与旧「拼成一个 script」模型唯一的语义差别 —— 那边靠提升侥幸能跑，这里会直接抛错。
// 2. 顺序敏感，以下是**既有约定**，改顺序前先确认：
//    - i18n 三个模块（13/14/15）排在最前。它们提供 `window.MineradioI18n`，而其它模块的
//      文案访问器在加载期与运行期都会读它，所以不要往后挪；
//    - `00-core-stores.js` 要在所有读它那份状态的模块之前；
//    - 同一目录内按文件名序号排列，新文件请顺着序号往后加。
// 3. **新增模块必须登记到 `modulePaths`**（位置按上面的顺序规则挑）。
//    没登记不会报错、不会红测试、控制台也不会提醒 —— 那个文件就是不会被加载。
//    `scripts/quick-check.js` 的 "Index module registration guard" 会拦住这种漏登记。
// 4. 模块文件名带 `a`/`b` 后缀（如 `17a-`、`17b-`）表示"插在同序号模块之间的补充模块"，
//    它们是靠顺序插进去的，不要重命名成整数序号。
//
// ── Loading model (read this before editing the file) ────────────────────────
// Every path below becomes its own classic <script src>, injected in order — no ES modules, no
// import/export. Top-level `function`/`var` still land in ONE shared global scope (modules see
// each other by name, and two modules declaring the same name overwrite each other silently), but
// there is **no cross-file hoisting**: when A runs, a function declared in a later file does not
// exist yet. So "A calls B's function at top level" is a hard error here — move the callee ahead of
// A, or wrap the call in `__mineradioDefer`. That hoisting is the only semantic difference from the
// old single-script bundle, where such a call happened to work. Register every new module below:
// an unregistered file does not error, does not fail a test, and does not warn — it simply never
// loads, and quick-check's registration guard is what catches the omission.

(function loadMineradioIndexModules() {
  const moduleCacheBust = String(Date.now());
  const modulePaths = [
    'js/modules/00-state/13-i18n.js',
    'js/modules/00-state/14-i18n-switcher.js',
    'js/modules/00-state/15-backend-text.js',
    'js/modules/00-state/00a-shared-utils.js',
    // 偏好读取要在 00-core-stores 之前：00-core 在顶层就调用 readAudioFadePreference() 等，
    // 靠拼接期的函数提升本来能跑，拆成分文件后会变成 ReferenceError。
    // Preference readers come before the core stores: the stores call them during evaluation.
    'js/modules/00-state/02-preferences-ui-modes.js',
    'js/modules/00-state/00-core-stores.js',
    // 本地存档读取器必须紧跟 00-core-stores：它引用的 STORE_KEY 常量都在那里定义，而 00-core
    // 顶层又要用这些 reader 的返回值初始化 customCoverMap / customLyricFonts / listenStatsState…
    // The local-storage readers have to follow 00-core-stores: they use its STORE_KEY constants and
    // 00-core initialises those stores from their return values at top level.
    'js/modules/00-state/00b-local-readers.js',
    'js/modules/00-state/01-perf-render-state.js',
    'js/modules/00-state/03-beat-dj-state.js',
    'js/modules/00-state/04-fx-defaults.js',
    'js/modules/00-state/05-packaged-fx-archive.js',
    // 存档**读取**层要在 06 之前：06 在顶层就 Object.assign({}, fxDefaults, readSavedLyricLayout())
    // 求 fx，而 01-scene/01、02-visual/00、10-shell/05 在顶层就要读它的 preset / coverResolution /
    // shelf / floatLayer 等真值。读取层的写入对半留在 02-visual/04（位置更晚也没人需要它提前）。
    // The read side of the visual archive has to land before 06: 06 builds `fx` at top level from
    // readSavedLyricLayout(), and 01-scene/01, 02-visual/00 and 10-shell/05 read preset /
    // coverResolution / shelf / floatLayer from it at top level too. The write half stays in
    // 02-visual/04, which loads later — nothing needs it early.
    'js/modules/00-state/05a-fx-save-read.js',
    'js/modules/00-state/06-fx-runtime-layout.js',
    'js/modules/00-state/07-ui-playback-runtime.js',
    'js/modules/00-state/08-desktop-render-power.js',
    'js/modules/00-state/09-performance-probe.js',
    'js/modules/00-state/10-frame-scheduler.js',
    'js/modules/00-state/11-system-memory-controls.js',
    'js/modules/00-state/12-particle-budget.js',
    'js/modules/00-state/16-provider-registry.js',
    'js/modules/01-scene/00-renderer-quality.js',
    'js/modules/01-scene/01-orbit-free-camera.js',
    'js/modules/01-scene/02-beat-camera-runtime.js',
    'js/modules/01-scene/03-focus-cinema-camera.js',
    'js/modules/01-scene/04-bottom-controls-cursor.js',
    'js/modules/02-visual/00-pointer-cover-particles.js',
    'js/modules/02-visual/01-float-skull-backcover.js',
    'js/modules/02-visual/02-lyrics-state-layout.js',
    'js/modules/02-visual/03-lyrics-star-river.js',
    'js/modules/02-visual/04-visual-settings-persistence.js',
    'js/modules/02-visual/05-lyrics-fonts-texture.js',
    'js/modules/02-visual/06-custom-background-colorlab.js',
    'js/modules/02-visual/07-lyrics-palette-text-utils.js',
    'js/modules/02-visual/08-lyrics-display-modes.js',
    'js/modules/02-visual/09-lyrics-payloads.js',
    'js/modules/02-visual/10-lyrics-mask-textures.js',
    'js/modules/02-visual/11-lyrics-shaders.js',
    'js/modules/02-visual/12-lyrics-row-layers.js',
    'js/modules/02-visual/13-lyrics-mesh-build.js',
    'js/modules/02-visual/14-stage-lyrics-rendering.js',
    'js/modules/02-visual/15-ripples-cover-depth.js',
    'sonic-topography-preset.js',
    'sonic-workshop-preset.js',
    'highway-drive-preset.js',
    'js/modules/03-beat/00-tempo-worker-cache-prefetch.js',
    'js/modules/03-beat/01-audio-beat-analysis.js',
    'js/modules/03-beat/02-podcast-dj-analysis.js',
    'js/modules/03-beat/03-local-beat-cache-modal.js',
    'js/modules/03-beat/04-beat-map-runtime.js',
    'js/modules/03-beat/05-cover-loading-crop.js',
    'js/modules/03-beat/06-sonic-audio-monitor.js',
    'js/modules/04-shelf/00-layout-hover.js',
    'js/modules/04-shelf/01-manager-core.js',
    'js/modules/04-shelf/02-rebuild-panel-sync.js',
    'js/modules/04-shelf/03-content-list-manager.js',
    'js/modules/04-shelf/04-cover-api-helpers.js',
    'js/modules/04-shelf/05-card-interactions.js',
    'js/modules/04-shelf/06-keyboard-camera-events.js',
    'js/modules/05-playback/00-api-quality-output.js',
    'js/modules/05-playback/01-cover-custom-map.js',
    'js/modules/05-playback/02-listen-stats.js',
    'js/modules/05-playback/03-home-discover-weather.js',
    'js/modules/05-playback/03a-home-dashboard.js',
    'js/modules/05-playback/04-home-empty-wallpaper.js',
    'js/modules/05-playback/05-home-actions.js',
    'js/modules/05-playback/06-track-detail-lyrics-actions.js',
    'js/modules/05-playback/07-search.js',
    'js/modules/05-playback/08-audio-graph-controls.js',
    'js/modules/05-playback/09-queue-snapshot-autoplay.js',
    'js/modules/05-playback/10-queue-actions.js',
    'js/modules/05-playback/11-provider-fallback.js',
    'js/modules/05-playback/12-playback-switch-core.js',
    'js/modules/05-playback/13-playback-start-audio.js',
    'js/modules/05-playback/14-player-controls.js',
    'js/modules/05-playback/15-control-glass-animations.js',
    'js/modules/05-playback/16-cuefield-automix-core.js',
    'js/modules/05-playback/17-cuefield-timeline-executor.js',
    'js/modules/05-playback/17a-cuefield-bridge-engine.js',
    'js/modules/05-playback/17b-cuefield-source-loop.js',
    'js/modules/05-playback/18-cuefield-automix-integration.js',
    'js/modules/05-playback/19-media-session.js',
    'js/modules/05-playback/20-custom-source.js',
    'js/modules/06-lyrics/halo-sync-bridge.js',
    'js/modules/06-lyrics/00-lyrics-fetch-parse.js',
    'js/modules/06-lyrics/00-built-in-playlists.js',
    'js/modules/06-lyrics/01-playlist-panel-shell.js',
    'js/modules/06-lyrics/02-playlist-detail.js',
    'js/modules/06-lyrics/03-podcast-playlist-loaders.js',
    'js/modules/06-lyrics/04-progress-seek.js',
    'js/modules/06-lyrics/05-upload-dragdrop.js',
    'js/modules/06-lyrics/06-lyric-timing-offset.js',
    'js/modules/06-lyrics/07-playlist-multiselect.js',
    'js/modules/07-fx/00-preset-archive-data.js',
    'js/modules/07-fx/01-lyric-color-controls.js',
    'js/modules/07-fx/02-accent-background-controls.js',
    'js/modules/07-fx/03-cover-picker-fonts.js',
    'js/modules/07-fx/04-preset-grid-uniforms.js',
    'js/modules/07-fx/05-fx-panel-performance.js',
    'js/modules/07-fx/06-hotkeys.js',
    'js/modules/07-fx/07-bindings-shelf-immersive.js',
    'js/modules/07-fx/08-cache-storage-settings.js',
    'js/modules/07-fx/09-console-workspace.js',
    'js/modules/07-fx/10-windows-game-mode-ui.js',
    'js/modules/08-account/00-update-preview.js',
    'js/modules/08-account/00-login-easter-egg.js',
    'js/modules/08-account/01-login-modal-utils.js',
    'js/modules/08-account/02-login-status.js',
    'js/modules/08-account/03-login-modal-flows.js',
    'js/modules/08-account/spotify-launch-client.js',
    'js/modules/08-account/04-user-modal-logout.js',
    'js/modules/08-account/05-startup-login-guide.js',
    'js/modules/09-idle-toast-libraries.js',
    'js/modules/09-prompt-dialogs.js',
    'js/modules/10-shell/00-gesture-control.js',
    'js/modules/10-shell/01-viewport-resize-shortcuts.js',
    'js/modules/10-shell/02-peek-panels-upload.js',
    'js/modules/10-shell/03-splash.js',
    'js/modules/10-shell/04-desktop-overlay-fullscreen.js',
    'js/modules/10-shell/05-startup-bindings.js',
    'js/modules/11-main-loop.js',
  ];

  // ── 惰性模块清单 ────────────────────────────────────────────────────────────
  // 壁纸引擎是单块最重的功能（2705 行，109 个顶层函数），而且一加载就注册 capture 阶段的
  // pointermove / mousemove 监听，并在上次启用过壁纸时立刻发起一次跨进程扫盘。没在用壁纸的
  // 用户不该为它付启动成本，所以改成首次真正需要时注入 <script src>。
  // 它仍然**必须登记**，只是登记在这份清单里：quick-check 的登记守卫会把两个清单合并，
  // 再与磁盘上的模块树做集合比对，所以「忘了登记」和「登记了却永不加载」都会被拦住。
  // The wallpaper engine is the heaviest single feature (2705 lines, 109 top-level functions) and
  // loading it registers capture-phase pointermove/mousemove listeners and may immediately start a
  // cross-process disk scan. Users who never touch wallpapers should not pay that on startup, so it
  // is injected on first use. It still has to be registered — in this list — and quick-check merges
  // both lists before comparing against the module tree, so a missing entry is still caught.
  const lazyModulePaths = [
    'js/modules/07-fx/03-wallpaper-engine-library.js',
  ];

  // 惰性加载运行时：注入到最后，与模块共享同一个全局作用域。
  // 它做三件事：
  //   1. 提供 __mineradioEnsureLazyModule()，用 <script src> 按需注入惰性模块并去重；
  //   2. 给 index.html 的内联 on* 入口放「转发桩」——第一次点击先加载，再由真函数接手
  //      （真模块的顶层 function 声明会覆盖同名全局，桩内部会重新读 window[name]）；
  //   3. 上次启用过壁纸的话立刻补加载一次，别让壁纸在启动后不显示。
  // Lazy runtime, appended to the concatenated script so it shares the same global scope:
  //  1. __mineradioEnsureLazyModule() injects a lazy module via <script src> with de-duplication;
  //  2. index.html's inline on* handlers get forwarding stubs — the first click loads the module,
  //     then the real top-level function (which overwrites the global name) takes over;
  //  3. if a wallpaper was active last session, load immediately so it does not go missing.
  const lazyRuntimeSource = `
(function () {
  'use strict';
  var lazyFiles = ${JSON.stringify(lazyModulePaths)};
  var lazyCacheBust = ${JSON.stringify(moduleCacheBust)};
  var lazyLoaded = Object.create(null);
  var lazyLoading = Object.create(null);
  function isLazyFile(path) { return lazyFiles.indexOf(path) >= 0; }
  window.__mineradioLazyModuleLoaded = function (path) {
    return !!lazyLoaded[String(path || '')];
  };
  window.__mineradioEnsureLazyModule = function (path, reason) {
    path = String(path || '');
    if (!isLazyFile(path)) return Promise.resolve(false);
    if (lazyLoaded[path]) return Promise.resolve(true);
    if (lazyLoading[path]) return lazyLoading[path];
    lazyLoading[path] = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = path + '?v=' + encodeURIComponent(lazyCacheBust);
      el.async = true;
      el.onload = function () {
        lazyLoaded[path] = true;
        lazyLoading[path] = null;
        resolve(true);
      };
      el.onerror = function () {
        lazyLoading[path] = null;
        if (window.console && typeof console.error === 'function') {
          console.error('[LazyModule] failed to load ' + path + ' (triggered by ' + (reason || 'unknown') + ')');
        }
        reject(new Error('LAZY_MODULE_LOAD_FAILED'));
      };
      document.body.appendChild(el);
    });
    return lazyLoading[path];
  };

  var WALLPAPER_ENGINE_MODULE = ${JSON.stringify(lazyModulePaths[0] || '')};
  var WALLPAPER_ENGINE_SELECTION_KEY = 'mineradio-wallpaper-engine-selection-v1';
  // 与 wallpapers 模块里 normalizeWallpaperEngineSelection 的 active 判据保持一致：
  // active 必须为 true，且 id 归一化后正好 24 位 hex。
  // Mirrors the module's own active test: active === true and a 24-char hex id after normalising.
  function wallpaperEngineLooksActive() {
    try {
      var raw = JSON.parse(localStorage.getItem(WALLPAPER_ENGINE_SELECTION_KEY) || '{}');
      var id = String((raw && raw.id) || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
      return !!(raw && raw.active === true && id.length === 24);
    } catch (e) {
      return false;
    }
  }
  var wallpaperEntries = ${JSON.stringify([
    'chooseWallpaperEngineDirectory',
    'chooseWallpaperEngineProjectFile',
    'closeWallpaperEngineLibrary',
    'closeWallpaperEngineProjectDetails',
    'deactivateWallpaperEngineBackground',
    'launchWallpaperEngineProjectDetails',
    'openWallpaperEngineLibrary',
    'refreshWallpaperEngineLibrary',
    'restoreHiddenWallpaperEngineItems',
    'retryWallpaperEngineNativeRun',
    'scheduleWallpaperEngineLibraryRender',
    'setWallpaperEngineVisualSetting'
  ])};
  wallpaperEntries.forEach(function (name) {
    if (typeof window[name] === 'function') return;
    var stub = function () {
      var self = this;
      var args = arguments;
      return window.__mineradioEnsureLazyModule(WALLPAPER_ENGINE_MODULE, name).then(function () {
        var fn = window[name];
        if (typeof fn === 'function' && !fn.__mineradioLazyStub) return fn.apply(self, args);
        return undefined;
      }).catch(function () { return undefined; });
    };
    stub.__mineradioLazyStub = true;
    window[name] = stub;
  });
  if (WALLPAPER_ENGINE_MODULE && wallpaperEngineLooksActive()) {
    window.__mineradioEnsureLazyModule(WALLPAPER_ENGINE_MODULE, 'restore-active-selection').catch(function () { });
  }
})();
`;

  // ── 注入 ────────────────────────────────────────────────────────────────────
  // 只保留分文件注入。以前还有一条「把所有模块拼成一个 <script>」的路径，默认走它、靠
  // 跨文件函数提升兜住后向引用；那条路径已经整个删掉：它每次都要 117 次**同步** XHR
  // （`open(..., false)`，直接阻塞主线程），换来的是一个两万行的巨型 script，栈里只有
  // `mineradio-index-modules.js:64467`，还得靠行号映射反查文件。分文件后每个模块有自己的
  // URL，栈里直接是 `js/modules/xxx.js:12`，也不用再跟浏览器解释一个巨型脚本。
  // Split injection is the only path left. The old "concatenate everything into one <script>"
  // route is gone: it cost 117 *synchronous* XHRs (open(..., false) blocks the main thread),
  // produced one 20k-line script whose stacks only said `mineradio-index-modules.js:64467`, and
  // needed a line map just to name the failing file. Each module now has its own URL, so a stack
  // already reads `js/modules/xxx.js:12`.
  // 跨文件函数提升随之消失 —— 那正是 2026-10-28 这一轮把读取层前移的原因。见文件头注释。
  // Cross-file hoisting is gone with it, which is why the read layer had to move ahead of its
  // consumers; see the header comment.

  function moduleUrl(path) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + moduleCacheBust;
  }

  // 所有模块执行完后统一跑注册过的收尾工作；单个失败不影响其它。
  //
  // 时机很关键：模块是以 `el.src` 动态插入的**外部**脚本（async=false 只保证它们彼此按插入
  // 顺序执行），而这段是**内联**脚本，插入当场就同步跑完——那时候模块一个都还没下载回来，
  // 钩子表还是空的。以前内联脚本跑完就结束了，于是之后模块登记的钩子永远躺在数组里没人读，
  // 滚动懒渲染和弹窗背景关闭全部失效（表现：歌单/队列列表滚动后内容不更新，底部留一片空白）。
  // 所以改成等 load（外部脚本都属于它管的资源）、并且在已经 complete 时立即跑；跑完之后
  // 再登记的钩子由 __mineradioDefer 直接执行。
  // Run every registered boot hook after all modules executed; one failure must not stop the rest.
  //
  // Timing matters: the modules are dynamically inserted **external** scripts (async=false only
  // keeps them ordered among themselves), while this one is **inline** and runs the moment it is
  // inserted — when not a single module has downloaded yet and the hook list is still empty. It
  // used to end there, so every hook registered later sat in a list nobody read again, and the
  // panel's lazy scrolling plus the backdrop close were silently dead (the list stopped updating
  // while scrolling and left a blank block at the bottom). Hence load, immediate when already
  // complete, and __mineradioDefer runs late registrations directly.
  function bootRunSource() {
    return String.raw`
;(function () {
  window.__mineradioRunBootHooks = function () {
    // 钩子里可能又登记（例如被它调起的模块），跑完一轮再看一眼，最多三轮，避免互相激活死循环。
    for (var round = 0; round < 3; round++) {
      var hooks = window.__mineradioBootHooks || [];
      if (!hooks.length) break;
      window.__mineradioBootHooks = [];
      for (var i = 0; i < hooks.length; i++) {
        try { hooks[i](); } catch (error) { console.error("[Boot] hook failed: " + (error && error.message || error)); }
      }
    }
    window.__mineradioBootFlushed = true;
  };
  if (document.readyState === "complete") window.__mineradioRunBootHooks();
  else window.addEventListener("load", window.__mineradioRunBootHooks, { once: true });
})();
`;
  }
  function injectSplitModules() {
    const host = document.currentScript.parentNode;
    // 每个新节点都要插在「上一个刚插入的节点」之后，否则后插的会跑到前面，顺序整个反掉。
    let anchor = document.currentScript;
    const appendAfter = (el) => {
      host.insertBefore(el, anchor.nextSibling);
      anchor = el;
    };
    // 地基要先于第一个模块：模块顶层就会调 __mineradioDefer。
    // The foundation goes in before the first module: modules call __mineradioDefer at top level.
    const boot = document.createElement('script');
    boot.text = bootHooksSource();
    appendAfter(boot);
    // 最后一个模块的 load（脚本执行完之后才触发）就是钩子最早的安全时机：此刻所有模块的
    // 顶层都跑过了。别等 window 的 load —— 播放器首屏有壁纸和封面，那个事件可能晚好几秒，
    // 而这段时间里面板的滚动懒渲染一直是死的。加载失败也要兜一次，否则一个 404 就能把整条
    // 收尾流程永远挂住。
    // The last module's load (fired after execution) is the earliest safe moment for the hooks:
    // every module's top level has run by then. Waiting for window load would be seconds late on a
    // player with a wallpaper and cover art, and lazy panel scrolling stays dead meanwhile. A
    // failed load flushes too, so one 404 cannot hang the whole tail for good.
    const flushBootHooks = () => {
      if (typeof window.__mineradioRunBootHooks === 'function') window.__mineradioRunBootHooks();
    };
    modulePaths.forEach((path, moduleIndex) => {
      const el = document.createElement('script');
      // 动态插入的 script 默认 async=true，会按下载完成的先后执行；必须显式关掉才能保序。
      // Dynamically inserted scripts default to async: they run in download order unless this is off.
      el.async = false;
      el.src = moduleUrl(path);
      const isLastModule = moduleIndex === modulePaths.length - 1;
      el.onerror = () => {
        console.error('[Loader] failed to load module: ' + path);
        if (isLastModule) flushBootHooks();
      };
      if (isLastModule) el.onload = flushBootHooks;
      appendAfter(el);
    });
    // 惰性运行时与模块共享同一个全局作用域，必须排在所有模块之后。
    const runtime = document.createElement('script');
    runtime.text = bootRunSource() + lazyRuntimeSource;
    appendAfter(runtime);
  }

  // boot 钩子表 + 它的注册器。它**必须比任何模块先执行**，因为模块会在顶层调用
  // `window.__mineradioDefer(...)`。这也是拆掉跨文件函数提升之后的地基：模块不再能指望
  // 「后面文件里的函数此刻已经存在」，需要等的就登记到这里，由 bootRunSource() 统一跑。
  // The boot hook list and its register. It has to run BEFORE any module, because modules call
  // __mineradioDefer at top level. It is also the foundation for living without cross-file
  // hoisting: a module can no longer assume a later file's function already exists, so whatever it
  // needs to wait for gets registered here and is run by bootRunSource().
  function bootHooksSource() {
    return ';(function () {\n'
      + '  window.__mineradioBootHooks = window.__mineradioBootHooks || [];\n'
      + '  window.__mineradioDefer = function (fn) {\n'
      + '    if (typeof fn !== "function") return;\n'
      // boot 已经跑过还来登记，说明是之后才注入的模块：直接执行，不要再往一个没人
      // 再读的数组里塞（那正是「滚动列表永远不刷新」的成因）。
      + '    if (window.__mineradioBootFlushed) {\n'
      + '      try { fn(); } catch (error) { console.error("[Boot] deferred call failed: " + (error && error.message || error)); }\n'
      + '      return;\n'
      + '    }\n'
      + '    window.__mineradioBootHooks.push(fn);\n'
      + '  };\n'
      + '})();\n';
  }

  injectSplitModules();
})();
