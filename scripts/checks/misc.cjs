'use strict';

// 检查函数从原 scripts/quick-check.js **原样搬出**，断言一条未改。
const env = require('./env.cjs');
const {
  spawnSync,
  readAllCssFiles,
  rel,
  logStep,
  fail,
  requireLocaleKeys,
  walk,
  readIndexModulePaths,
  fs,
  os,
  path,
  appRoot,
} = env;

function checkIndexModuleRegistrationGuard() {
  logStep('Index module registration guard');
  const { publicDir, loader, modulePaths, lazyModulePaths } = readIndexModulePaths();
  // 漏登记不会报错、不会红测试、控制台也不提醒 —— 那个文件就是不会被加载，
  // 所以这条判据要盯的就是"模块目录里的每个 .js 都在 modulePaths 里"。
  // An unregistered module never loads and never complains, so the judgement is set equality
  // between the module tree on disk and the loader's registration list.
  // 扫描面只取 js/modules：这是"模块"的约定目录。
  // public/js/index-loader.js 与 public/js/preload-mode.js 由 index.html 的 <script src> 显式加载，
  // 不走 modulePaths；public 根下的两个 preset 文件则是**登记了的**（下面的 existsSync 会覆盖它们），
  // 所以不把"public 根下每个 .js 都必须登记"写进判据 —— 那会把正常的一次性脚本误判成漏登记。
  // The scan is scoped to js/modules (the module tree by convention). index-loader.js and
  // preload-mode.js load through index.html's <script src> instead, and every other path in
  // modulePaths is covered by the existsSync check below — so "all .js at public root must be
  // registered" is deliberately NOT asserted, as it would flag legitimate one-off scripts.
  const modulesRoot = path.join(publicDir, 'js', 'modules');
  const onDisk = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.js')) {
          onDisk.push(path.relative(publicDir, full).split(path.sep).join('/'));
        }
      });
  })(modulesRoot);
  const eager = new Set(modulePaths);
  const lazy = new Set(lazyModulePaths);
  // 同一个模块不能既立即加载又惰性加载 —— 那会执行两次，顶层 var/function 静默互相覆盖。
  // A module may not be both eager and lazy; it would execute twice and silently re-declare names.
  const bothLists = lazyModulePaths.filter((rel) => eager.has(rel));
  if (bothLists.length) {
    fail(`modules registered in both modulePaths and lazyModulePaths: ${bothLists.join(', ')}`);
  }
  // 惰性清单不是"可以不登记"的后门：只要有惰性模块，加载器就必须真的提供注入机制和入口转发桩，
  // 否则那些模块要么永不加载，要么被 index.html 的内联处理器按名字调用时直接 ReferenceError。
  // The lazy list is not an "unregistered is fine" backdoor: if it is used, the loader must really
  // provide the injection helper and the entry stubs, or the modules never load / the inline
  // handlers in index.html throw ReferenceError on the missing global.
  if (lazyModulePaths.length) {
    if (!/__mineradioEnsureLazyModule/.test(loader)) {
      fail('lazyModulePaths is populated but the loader defines no __mineradioEnsureLazyModule injector');
    }
    if (!/__mineradioLazyStub/.test(loader)) {
      fail('lazyModulePaths is populated but the loader installs no entry stubs for inline handlers');
    }
  }
  const registered = new Set(modulePaths.concat(lazyModulePaths));
  const unregistered = onDisk.filter((rel) => !registered.has(rel));
  if (unregistered.length) {
    fail(`module files missing from modulePaths (they would never load): ${unregistered.join(', ')}`);
  }
  const allPaths = modulePaths.concat(lazyModulePaths);
  const missingFiles = allPaths.filter((rel) => !fs.existsSync(path.join(publicDir, rel)));
  if (missingFiles.length) {
    fail(`modulePaths entries without a file on disk: ${missingFiles.join(', ')}`);
  }
  // 重复登记会让同一个模块执行两次，顶层 var/function 被重复声明（后者静默覆盖前者）。
  // A duplicate registration executes the module twice and silently re-declares its top-level names.
  const duplicates = allPaths.filter((rel, i) => allPaths.indexOf(rel) !== i);
  if (duplicates.length) {
    fail(`modulePaths contains duplicates: ${[...new Set(duplicates)].join(', ')}`);
  }
  // 加载模型是"拼成一个 classic script"，没有 import/export；一旦有人在模块里写 ESM 语法，
  // 整段拼接脚本会直接抛语法错误。
  // The model concatenates modules into one classic script; ESM syntax anywhere breaks the batch.
  const esmOffenders = onDisk.filter((rel) => /^\s*(import|export)\s/m.test(fs.readFileSync(path.join(publicDir, rel), 'utf8')));
  if (esmOffenders.length) {
    fail(`module files must stay classic scripts (no import/export): ${esmOffenders.join(', ')}`);
  }
  if (!/Loading model/.test(loader)) {
    fail('the loader must keep its loading-model note so the order-sensitivity is not folklore');
  }
  console.log(`[OK] All ${onDisk.length} module files are registered exactly once, hold no ESM syntax, and the loader documents the concatenated-script model.`);
}

function checkPersistentCacheStorageGuard() {
  logStep('Persistent cache storage guard');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const lyricText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const cacheUiText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '08-cache-storage-settings.js'), 'utf8');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const setNameAt = mainText.indexOf('app.setName(APP_NAME)');
  const firstUserDataLookupAt = mainText.indexOf("app.getPath('appData')");
  const cacheText = fs.readFileSync(path.join(appRoot, 'desktop', 'cache-settings.js'), 'utf8');
  if (!/const CACHE_SETTINGS_FILE/.test(mainText) || !/const LYRIC_CACHE_MAX_BYTES = 96 \* 1024 \* 1024/.test(mainText) || !/function defaultRootPath\(\)/.test(cacheText) || setNameAt < 0 || firstUserDataLookupAt < 0 || setNameAt > firstUserDataLookupAt || !/const STABLE_USER_DATA_PATH = resolveStableUserDataPath\(\)/.test(mainText) || !/app\.setPath\('userData', STABLE_USER_DATA_PATH\)/.test(mainText) || !/app\.setPath\('sessionData', cacheSettingsManager\.chromiumSessionDataPath\(INITIAL_CACHE_SETTINGS\)\)/.test(mainText) || !/const currentChromiumPath = app\.getPath\('sessionData'\)/.test(cacheText) || !/MINERADIO_BEAT_CACHE_DIR = cacheSettingsManager\.get\(\)\.beatmapsPath/.test(mainText) || !/nativePath:\s*path\.join\(rootPath, 'native-helper-temp'\)/.test(cacheText) || !/const NATIVE_HELPER_TEMP_PATH = INITIAL_CACHE_SETTINGS\.nativePath/.test(mainText) || !/activeWallpaperEnginePath/.test(cacheText) || !/wallpaperEngineBytes/.test(cacheText)) {
    fail('desktop cache settings must keep app-owned userData stable and route Chromium sessionData plus beatmaps to the configurable cache root');
  }
  // 便携化守卫：数据根必须落在软件目录内，缓存根不得再指向盘符根目录。
  // Portability guard: the data root must sit inside the app folder and the cache root must
  // never point at a drive root again.
  //
  // 打包进 asar 后 __dirname 落在只读归档里，mkdir 会失败并静默退回 %APPDATA%（用户看到的是
  // 「登录态全丢」），所以数据根必须挪到 exe 同级 —— 这是唯一允许的例外。两个分支都得在：
  // 少了 exe 分支 = 打包版丢数据，少了 APP_ROOT 分支 = 源码运行把数据写到仓库外。
  // Inside app.asar __dirname is read-only: mkdir fails and the code silently falls back to
  // %APPDATA%, which users experience as "all my logins are gone". The root therefore has to move
  // next to the exe — the only allowed exception. Both branches must stay: without the exe branch
  // the packaged app loses data, without the APP_ROOT branch a source run writes outside the repo.
  const cacheRootBody = (cacheText.match(/function defaultRootPath\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  const portableRootDecl = (mainText.match(/const PORTABLE_USER_DATA_PATH =[\s\S]{0,260}?;\n/) || [''])[0];
  if (!/const APP_ROOT_IN_ASAR = APP_ROOT_PATH\.includes\('app\.asar'\)/.test(mainText)
    || !/const PORTABLE_USER_DATA_PATH = APP_ROOT_IN_ASAR/.test(portableRootDecl)
    || !/path\.join\(path\.dirname\(process\.execPath\), 'userdata'\)/.test(portableRootDecl)
    || !/path\.join\(APP_ROOT_PATH, 'userdata'\)/.test(portableRootDecl)
    // 旧的 <安装目录>\resources\app\userdata 必须留作迁移来源，否则升级后老用户登录态搬不过来。
    // The old <install>\resources\app\userdata has to stay as the migration source, or upgrades
    // would strand an existing user's login state.
    || !/process\.resourcesPath, 'app', 'userdata'/.test(mainText)
    || !/if \(STARTUP_QA_USER_DATA_PATH\) return STARTUP_QA_USER_DATA_PATH/.test(mainText)
    || !/path\.join\(app\.getPath\('userData'\), 'cache'\)/.test(cacheRootBody)
    || /[A-Za-z]:\\/.test(cacheRootBody)
    || !/function migratePortableUserData\(\)/.test(mainText)
    || !/PORTABLE_MIGRATION_MARKER/.test(mainText)) {
    fail('every app-owned path must stay inside the app folder: portable userData, app-relative cache root, and the legacy copy migration');
  }
  // 数据根就在仓库里，必须被 git 挡住：否则一次 git add -A 就会把用户 cookie 和登录分区带上远端。
  // The data root lives inside the working tree, so git must ignore it — otherwise a single
  // `git add -A` would publish the user's cookies and login partitions.
  const portableGitignoreText = fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8');
  if (!/^userdata\/\s*$/m.test(portableGitignoreText)) {
    fail('.gitignore must ignore the portable userdata directory that now holds credentials and caches');
  }
  // 原生 helper 脚本的兜底路径也必须落在软件目录内，不能退回 %LOCALAPPDATA% 或 os.tmpdir()。
  // The native helper script fallback must stay inside the app folder as well; it may not drop
  // back to %LOCALAPPDATA% or os.tmpdir().
  const portablePathsText = fs.readFileSync(path.join(appRoot, 'desktop', 'portable-paths.js'), 'utf8');
  const nativeTempCallers = ['system-memory.js', 'wallpaper-engine-runtime.js', 'desktop-native-icon-layer-runtime.js']
    .map((file) => fs.readFileSync(path.join(appRoot, 'desktop', file), 'utf8'));
  if (!/APP_NATIVE_TEMP_PATH = path\.join\(APP_ROOT_PATH, 'userdata', 'cache', 'native-helper-temp'\)/.test(portablePathsText)
    || !/function resolveNativeTempDir\(\)/.test(portablePathsText)
    || !/\[PortableData\] app native temp folder is not writable/.test(portablePathsText)
    || nativeTempCallers.some((text) => !/portablePaths\.resolveNativeTempDir\(\)/.test(text))
    || nativeTempCallers.some((text) => /'Mineradio',\s*'native-helper-temp'/.test(text))) {
    fail('native helper temp must resolve through the app-folder fallback, never the user profile or os.tmpdir()');
  }
  if (!/function migrateMisplacedAppOwnedFiles\(\)/.test(mainText) || !/APP_OWNED_MIGRATION_FILES/.test(mainText) || !/process\.env\.QISHUI_COOKIE_FILE = path\.join\(STABLE_USER_DATA_PATH, '\.qishui-cookie'\)/.test(mainText) || !/process\.env\.SPOTIFY_TOKEN_FILE = path\.join\(STABLE_USER_DATA_PATH, '\.spotify-token\.json'\)/.test(mainText)) {
    fail('provider credentials must migrate out of the old Chromium cache path and remain under stable userData');
  }
  const cacheSettingsText = fs.readFileSync(path.join(appRoot, 'desktop', 'cache-settings.js'), 'utf8');
  const cacheIpcText = fs.readFileSync(path.join(appRoot, 'desktop', 'ipc-memory-cache.js'), 'utf8');
  if (!/mineradio-cache-get-settings/.test(mainText + cacheIpcText) || !/mineradio-cache-set-settings/.test(mainText + cacheIpcText) || !/mineradio-cache-read-lyric/.test(mainText) || !/mineradio-cache-write-lyric/.test(mainText) || !/crypto\.createHash\('sha256'\)/.test(cacheSettingsText) || !/pruneLyricCache/.test(cacheSettingsText)) {
    fail('desktop cache storage must expose configurable paths and bounded hashed lyric persistence');
  }
  if (!/getCacheSettings:/.test(preloadText) || !/setCacheSettings:/.test(preloadText) || !/readLyricCache:/.test(preloadText) || !/writeLyricCache:/.test(preloadText)) {
    fail('renderer cache controls must be exposed through the desktop preload bridge');
  }
  const playbackStartText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  if (!/function persistentLyricCacheKey/.test(lyricText) || !/await readPersistentLyricCache\(song\)/.test(lyricText) || !/refreshPersistentLyricCache\(song\)/.test(lyricText) || !/writePersistentLyricCache\(song, mergedResponse\)/.test(lyricText) || !/function scheduleQueueLyricPrefetch/.test(lyricText) || !/function runQueueLyricPrefetch/.test(lyricText) || !/scheduleQueueLyricPrefetch\(idx, 2400\)/.test(playbackStartText)) {
    fail('lyrics must read persistent cache before network fetch, refresh it without blocking playback, and prefetch the next queue lyric');
  }
  if (!/07-fx\/08-cache-storage-settings\.js/.test(loaderText) || !/cache-storage-panel/.test(htmlText) || !/cache-storage-lyrics-size/.test(htmlText) || !/cache-storage-chromium-size/.test(htmlText) || !/cache-storage-beatmaps-size/.test(htmlText) || !/cache-storage-wallpaper-size/.test(htmlText) || !/cache-storage-userdata-size/.test(htmlText) || !/cache-storage-beatmaps-path/.test(cacheUiText) || !/cache-storage-wallpaper-path/.test(cacheUiText) || !/function chooseMineradioCacheRoot/.test(cacheUiText) || !/function refreshMineradioCacheSettings/.test(cacheUiText) || !/\.cache-storage-panel/.test(cssText) || /cache-storage-updates-(?:path|size)/.test(htmlText + cacheUiText)) {
    fail('advanced settings must show configurable cache paths and their current usage');
  }
  console.log('[OK] Persistent lyric and application cache paths are configurable and report current usage.');
}

function checkExternalUpdatePageBridgeGuard() {
  logStep('External update page bridge guard');
  const regression = spawnSync(process.execPath, ['--test',
    path.join(appRoot, 'tests', 'update-external-only.test.js'),
    path.join(appRoot, 'tests', 'update-download-link-rotation.test.js')
  ], { cwd: appRoot, encoding: 'utf8' });
  if (regression.status !== 0) {
    process.stdout.write(regression.stdout || '');
    process.stderr.write(regression.stderr || '');
    fail('external update link rotation regression failed');
  }
  process.stdout.write(regression.stdout || '');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const updateUiText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '00-update-preview.js'), 'utf8');
  const updateIndexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const bridgeText = mainText + '\n' + preloadText;
  if (
    !/ipcMain\.handle\('mineradio-open-update-page', async \(event, value\) =>/.test(mainText)
    || !/isTrustedMainWindowIpc\(event\)/.test(mainText)
    || !/target\.length > 2048/.test(mainText)
    || !/parsed\.protocol !== 'https:'/.test(mainText)
    || !/await shell\.openExternal\(parsed\.href\)/.test(mainText)
    || !/openUpdatePage: \(url\) => ipcRenderer\.invoke\('mineradio-open-update-page'/.test(preloadText)
  ) {
    fail('desktop update bridge must open only bounded HTTPS pages from the trusted main document');
  }
  if (/mineradio-open-update-installer|openUpdateInstaller|getUpdateDownloadDir|MINERADIO_UPDATE_DIR/.test(bridgeText)) {
    fail('desktop update bridge must not expose the removed local installer or update-cache path');
  }
  if (
    !/mineradio-download-page/.test(serverText)
    || !/extractReleaseDownloadPages/.test(serverText)
    || !/downloadPages/.test(serverText)
    || !/error:\s*'UPDATE_EXTERNAL_ONLY'/.test(serverText)
    || !/selectUpdateDownloadSource/.test(updateUiText)
    || !/update-download-source/.test(updateUiText)
    || !/desktopWindow\.openUpdatePage\(target\)/.test(updateUiText)
  ) {
    fail('updates must resolve to an external download page and keep legacy local routes disabled');
  }
  // 「本应用不会在本地下载或应用补丁」这条常驻提示已随 i18n 迁移交给词典：
  // index.html 用 data-i18n 绑定 sd_open_browser_note，词典给出各语言文案。
  // 因此判据改为「HTML 声明 + 所有语言词典都含该键」，而不是在 JS 里搜硬编码
  // 中文——i18n 接线完成后 JS 侧本就不该再留这份中文原文，搜它只会误报。
  // This persistent notice moved into the i18n dictionaries: index.html binds it
  // via data-i18n=sd_open_browser_note. The guard therefore checks the HTML binding
  // plus the key's presence in every language dictionary, instead of grepping the
  // old hardcoded Chinese string out of JS, which i18n wiring legitimately removes.
  if (!/id="update-footnote"[^>]*data-i18n="sd_open_browser_note"/.test(updateIndexText)) {
    fail('the local-download-free update notice must stay bound via data-i18n="sd_open_browser_note"');
  }
  requireLocaleKeys('sd_open_browser_note');
  if (
    /startUpdateDownloadJob|startUpdatePatchJob|updateDownloadJobs|UPDATE_DOWNLOAD_DIR|pickPatchAsset/.test(serverText)
    || /\/api\/update\/(?:download|patch)|openUpdateInstaller|快速补丁/.test(updateUiText)
  ) {
    fail('local installer download and quick-patch workers must remain removed');
  }
  console.log('[OK] Updates use a trusted HTTPS-only external-page bridge with no local installer path.');
}

// 工作流里"永远不会红的检查"必须自述是仅信息，否则读者会把绿灯当成门禁。
// 判据：凡是带 `continue-on-error: true`，或 run 命令里写了 `|| true` 的步骤，
// 它最近的 `- name:` / `- uses:` 必须含 "(report only)" 或 "(advisory)"。
// A check that can never fail has to declare itself, otherwise a green light reads as a gate.
// Judgement: any step carrying `continue-on-error: true` or a `|| true` in its run command must have
// its nearest `- name:` / `- uses:` say "(report only)" or "(advisory)".
function checkWorkflowGatingHonestyGuard() {
  logStep('Workflow gating honesty guard');
  const dir = path.join(appRoot, '.github', 'workflows');
  const declares = /\((report only|advisory)\)/i;
  const offenders = [];
  const reportOnly = [];
  fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort().forEach((file) => {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const neverFails = /^\s*continue-on-error:\s*true\s*$/i.test(line) || /\|\|\s*true\s*$/.test(line.trim());
      if (!neverFails) return;
      // 向上找最近的步骤声明行（`- name:` 或 `- uses:`）——步骤名就在它附近，不会跨到别的步骤。
      // Walk up to the nearest step declaration; the step name sits right there and cannot belong
      // to a different step.
      let label = null;
      for (let i = index; i >= 0 && index - i <= 6; i -= 1) {
        const m = lines[i].match(/^\s*-\s*(?:name|uses):\s*(.+?)\s*$/);
        if (m) {
          label = m[1];
          break;
        }
      }
      if (label === null) {
        offenders.push(`${file}:${index + 1} 无法定位所属步骤名`);
        return;
      }
      if (declares.test(label)) reportOnly.push(`${file} → ${label}`);
      else offenders.push(`${file}:${index + 1} 步骤「${label}」永不失败却没有标注 (report only)/(advisory)`);
    });
  });
  if (offenders.length) {
    fail(`decorative CI steps must declare themselves: ${offenders.join(' | ')}`);
  }
  // 只有 13 个工作流里有少量仅信息步骤是正常的；这条日志让"哪些是仅信息"一眼可见。
  // A handful of declared report-only steps is expected; this log makes the inventory visible.
  console.log(`[OK] Every never-failing step declares itself. Report-only steps: ${reportOnly.length}${reportOnly.length ? ' → ' + reportOnly.join('; ') : ''}.`);
}

// DJ 节奏分析的解码与 FFT 必须在 utilityProcess 里跑。
// 这条接线极其容易静默回退：把 server.js 那一行 require('./dj-analyzer-host') 改回
// require('./dj-analyzer')，功能照样正常、测试照样绿，只有主进程事件循环重新被占住
// （实测单次分析就能造成 66ms 的长任务，期间所有 IPC 一起变慢）。所以用守卫钉住两端。
// The DJ beat-analysis decode/FFT must run in a utilityProcess. Reverting that one require
// silently restores the blocking behaviour: nothing fails, nothing turns red, the main
// process just goes back to being occupied for the whole analysis.
function checkResourceBudgetGuard() {
  logStep('Resource budget guard');
  // 资源有界性：关键上限钉死预期值 + 前端体积相对基线不超容差。
  // 单独跑：`node scripts/check-resource-budget.js`；更体积基线：`--write-baseline`。
  // Resource boundedness: pinned critical caps plus a bundle-size ceiling against a committed
  // baseline. Standalone: `node scripts/check-resource-budget.js`.
  const { runResourceBudgetCheck } = require('../check-resource-budget');
  const result = runResourceBudgetCheck();
  for (const warning of result.warnings) console.log(`[WARN] ${warning}`);
  if (!result.ok) return fail('资源预算越界：' + result.failures.join('；'));
  console.log(`[OK] ${result.pinned.length} 项上限仍在预期值，${result.bundleSummary}`);
}

function checkDjAnalyzerIsolationGuard() {
  logStep('DJ analysis isolation guard');
  const serverPath = path.join(appRoot, 'server', 'server.js');
  const serverText = fs.readFileSync(serverPath, 'utf8');
  // 只看真正的代码行：注释里提到「直接 require('./dj-analyzer') 会怎样」是正常的说明，
  // 不该被当成实际引用。整行注释与块注释的行首都剔除。
  const serverCode = serverText
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  if (!/require\('\.\/dj-analyzer-host'\)/.test(serverCode)) {
    fail('server.js must reach DJ beat analysis through ./dj-analyzer-host; requiring ./dj-analyzer directly runs decoding and FFT on the main-process event loop');
  }
  if (/require\('\.\/dj-analyzer'\)/.test(serverCode)) {
    fail('server.js must not require ./dj-analyzer directly — that blocks the main-process event loop for the whole analysis');
  }
  const hostPath = path.join(appRoot, 'server', 'dj-analyzer-host.js');
  const workerPath = path.join(appRoot, 'server', 'dj-worker.js');
  if (!fs.existsSync(hostPath) || !fs.existsSync(workerPath)) {
    fail('server/dj-analyzer-host.js and server/dj-worker.js must both exist — the utilityProcess boundary needs both ends');
  }
  const hostText = fs.readFileSync(hostPath, 'utf8');
  if (!/utilityProcess\.fork\(/.test(hostText)) {
    fail('dj-analyzer-host must fork the worker through utilityProcess');
  }
  // 降级链不能删：纯 Node 环境（npm test、后端搬家回归、scripts 直跑 server.js）里
  // 没有 utilityProcess，缺了回退会让播客锁拍直接抛错。
  if (!/analyzePodcastDjStream\b/.test(hostText) || !/require\('\.\/dj-analyzer'\)/.test(hostText)) {
    fail('dj-analyzer-host must keep the in-process fallback for environments without utilityProcess');
  }
  const workerText = fs.readFileSync(workerPath, 'utf8');
  if (!/process\.parentPort/.test(workerText)) {
    fail('dj-worker must listen on process.parentPort, otherwise the forked process never replies');
  }
  console.log('[OK] DJ beat analysis runs in a utilityProcess, with an in-process fallback when unavailable.');
}

module.exports = {
  checkIndexModuleRegistrationGuard,
  checkPersistentCacheStorageGuard,
  checkExternalUpdatePageBridgeGuard,
  checkWorkflowGatingHonestyGuard,
  checkResourceBudgetGuard,
  checkDjAnalyzerIsolationGuard,
};
