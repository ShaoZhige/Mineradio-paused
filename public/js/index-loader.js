'use strict';

// ── 必须知道的加载模型（改这个文件之前先读完）────────────────────────────────
// 1. 下面每一条路径都会被逐个 XHR 取回文本，然后**拼成一个 classic <script>** 一次性执行
//    （不是 ES module，没有 import/export）。因此：
//    - 所有顶层 `function` / `var` 都落在**同一个全局作用域**里，模块之间靠名字互相看见；
//      这也意味着两个模块用了同名顶层变量会**互相覆盖且不报错**。
//    - 脚本内不存在 `import`，所以「谁依赖谁」只能靠**顺序**表达。
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
// Each path below is fetched as text and the pieces are concatenated into ONE classic <script>
// executed in a single pass — no ES modules, no import/export. So every top-level `function`/`var`
// lands in the SAME global scope (modules see each other by name, and two modules declaring the
// same top-level name overwrite each other silently), and dependencies can only be expressed by
// ORDER. i18n (13/14/15) comes first because other modules may call its copy accessors while
// loading; `00-core-stores.js` precedes everything that reads its state. A new module file MUST be
// registered below — an unregistered file does not error, does not fail a test, and does not warn;
// it simply never loads. quick-check's index module registration guard catches that omission.

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
    'js/modules/00-state/01-perf-render-state.js',
    'js/modules/00-state/03-beat-dj-state.js',
    'js/modules/00-state/04-fx-defaults.js',
    'js/modules/00-state/05-packaged-fx-archive.js',
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

  function readModule(path) {
    const request = new XMLHttpRequest();
    request.open('GET', path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + moduleCacheBust, false);
    request.send(null);

    if ((request.status < 200 || request.status >= 300) && request.status !== 0) {
      throw new Error('Failed to load Mineradio module: ' + path + ' (' + request.status + ')');
    }

    return request.responseText;
  }

  // 惰性加载运行时：注入到拼接脚本尾部，与模块共享同一个全局作用域。
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

  // ── 注入方式 ────────────────────────────────────────────────────────────────
  // 默认仍是拼接。分文件注入（?loader=split）已经写好但**暂时不能当默认值**：整包拼接时，
  // 所有模块顶层 `function` 声明在执行前就一起提升到全局，于是前面的文件能直接调用后面文件里
  // 的函数；拆成多个 <script> 后这个提升不再跨文件，`00-state/06-fx-runtime-layout.js` 在顶层
  // 就调用了 `02-visual/04-visual-settings-persistence.js` 里的 readSavedLyricLayout，实测会
  // 立刻抛错、`fx` 变 undefined，主循环随后每帧报 uniforms 未定义。
  // 要让分文件成为默认，得先清掉这些「后向引用」：把顶层立即执行改成显式 init()，由加载器
  // 在全部模块就绪后统一调用。那一步做完再切默认值才安全。
  // Concatenation stays the default on purpose: inside one script every top-level `function`
  // declaration is hoisted before execution, so earlier files may call functions defined later.
  // Split injection loses that cross-file hoisting and breaks on the first backward reference.
  const loaderMode = (function () {
    try {
      const forced = new URLSearchParams(window.location.search).get('loader');
      return forced === 'split' ? 'split' : 'concat';
    } catch (error) {
      return 'concat';
    }
  })();

  function moduleUrl(path) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + moduleCacheBust;
  }

  // 所有模块执行完后统一跑注册过的收尾工作；单个失败不影响其它。
  // Run every registered boot hook after all modules executed; one failure must not stop the rest.
  function bootRunSource() {
    return String.raw`
;(function () {
  var hooks = window.__mineradioBootHooks || [];
  for (var i = 0; i < hooks.length; i++) {
    try { hooks[i](); } catch (error) { console.error("[Boot] hook failed: " + (error && error.message || error)); }
  }
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
    modulePaths.forEach((path) => {
      const el = document.createElement('script');
      // 动态插入的 script 默认 async=true，会按下载完成的先后执行；必须显式关掉才能保序。
      // Dynamically inserted scripts default to async: they run in download order unless this is off.
      el.async = false;
      el.src = moduleUrl(path);
      el.onerror = () => {
        console.error('[Loader] failed to load module: ' + path);
      };
      appendAfter(el);
    });
    // 惰性运行时与模块共享同一个全局作用域，必须排在所有模块之后。
    const runtime = document.createElement('script');
    runtime.text = bootRunSource() + lazyRuntimeSource;
    appendAfter(runtime);
  }

  // 拼接后所有模块共享一个 sourceURL，栈里只有 `mineradio-index-modules.js:20912`，
  // 得靠行号累加去反查是谁炸的。这里记下每个模块的起止行，并在全局放一个翻译器，
  // 加载期出错时把拼接行号换回「文件:行」，省掉那一步人工对表。
  // After concatenation every module shares one sourceURL, so a stack only says
  // `mineradio-index-modules.js:20912`. Record each module's line range and expose a translator so a
  // load-time failure reports `file:line` instead of a number nobody can map back by hand.
  function buildModuleLineMap(pieces) {
    const map = [];
    let cursor = 1;
    pieces.forEach((piece) => {
      const lineCount = piece.lines;
      map.push({ path: piece.path, start: cursor, end: cursor + lineCount - 1 });
      cursor += lineCount;
    });
    return map;
  }

  function moduleMapSource(map) {
    return ';(function () {\n'
      + '  var map = ' + JSON.stringify(map) + ';\n'
      + '  window.__mineradioModuleLineMap = map;\n'
      // 模块可以在顶层登记「等所有模块都执行完再做」的收尾工作。这是拆掉跨文件函数提升依赖的
      // 那块地基：状态初始化不再要求“后面文件里的函数此刻已经存在”。
      // Modules may register work that has to run after every module has executed. This is the
      // foundation for dropping the cross-file hoisting dependency.
      + '  window.__mineradioBootHooks = window.__mineradioBootHooks || [];\n'
      + '  window.__mineradioDefer = function (fn) {\n'
      + '    if (typeof fn === "function") window.__mineradioBootHooks.push(fn);\n'
      + '  };\n'
      + '  window.__mineradioLocateModule = function (line) {\n'
      + '    line = Number(line) || 0;\n'
      + '    for (var i = 0; i < map.length; i++) {\n'
      + '      if (line >= map[i].start && line <= map[i].end) {\n'
      + '        return map[i].path + ":" + (line - map[i].start + 1);\n'
      + '      }\n'
      + '    }\n'
      + '    return null;\n'
      + '  };\n'
      + '  window.addEventListener("error", function (event) {\n'
      + '    var stack = event && event.error && event.error.stack;\n'
      + '    if (!stack || typeof stack !== "string") return;\n'
      + '    var translated = stack.replace(/mineradio-index-modules\\.js:(\\d+)(?::\\d+)?/g, function (match, lineText) {\n'
      + '      var located = window.__mineradioLocateModule(Number(lineText));\n'
      + '      return located || match;\n'
      + '    });\n'
      + '    if (translated !== stack) console.error("[Loader] mapped stack:\\n" + translated);\n'
      + '  });\n'
      + '})();\n';
  }

  function injectConcatenatedModules() {
    // 每段都补成以换行结尾。缺尾换行的文件若直接拼下一段，下一段的第 1 行会接在上一段的
    // 末行上，行号整体往前错位——第一版映射就是这样把错误指到了隔壁文件。
    // Pad every piece with a trailing newline: without it the next file's first line glues onto the
    // previous file's last line and the whole map shifts by one.
    const pieces = modulePaths.map((path) => {
      const raw = readModule(path);
      const code = raw.endsWith('\n') ? raw : raw + '\n';
      return { path: path, code: code, lines: code.split('\n').length - 1 };
    });
    const lineMap = buildModuleLineMap(pieces);
    const host = document.currentScript.parentNode;
    let anchor = document.currentScript;
    const appendAfter = (el) => {
      host.insertBefore(el, anchor.nextSibling);
      anchor = el;
    };
    // 映射器单独一个 <script>，这样它自己的行数不会挤占拼接脚本的行号。
    // The mapper gets its own <script> so its own line count cannot shift the bundle's line numbers.
    const mapper = document.createElement('script');
    mapper.text = moduleMapSource(lineMap);
    appendAfter(mapper);

    const script = document.createElement('script');
    script.text = pieces.map((piece) => piece.code).join('')
      + bootRunSource()
      + lazyRuntimeSource
      + '\n//# sourceURL=mineradio-index-modules.js\n';
    appendAfter(script);
  }

  if (loaderMode === 'concat') injectConcatenatedModules();
  else injectSplitModules();
})();
