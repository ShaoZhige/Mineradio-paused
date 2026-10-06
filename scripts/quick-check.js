const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync: baseSpawnSync } = require('child_process');

// spawnSync() wires an anonymous stdin pipe by default. Security software on
// some Windows machines rejects that pipe, so every child process fails with
// EBUSY and healthy files get reported as broken. Pin stdin to 'ignore' to skip
// the pipe entirely; stdout and stderr stay captured exactly as before.
function spawnSync(command, args, options = {}) {
  const stdio = options.stdio || ['ignore', 'pipe', 'pipe'];
  return baseSpawnSync(command, args, { ...options, stdio });
}

const appRoot = path.resolve(__dirname, '..');
const runElectron = process.argv.includes('--electron') || process.argv.includes('--full');
const forbiddenPattern = /\b(fsr|dlss|native-fg|framegen)\b|frame generation/i;

function rel(file) {
  return path.relative(appRoot, file).replace(/\\/g, '/');
}

// 平台注册表的源码。任何把「按能力取平台清单」的模块单独丢进沙箱的判据都要把它前置 ——
// 那些模块在**加载时**就调 providerRegistryKeysWith()，沙箱里没有它就是一个 ReferenceError，
// 而报出来的名字与被测模块毫无关系，很容易被误读成"守卫坏了"。
// Source of the provider registry. Any judgement that sandboxes a module which derives its platform
// list from capabilities must prepend this: those modules call providerRegistryKeysWith() at LOAD
// time, and a missing binding surfaces as a ReferenceError naming a function the module under test
// never mentions — easy to misread as a broken guard.
function providerRegistrySourceText() {
  return fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '16-provider-registry.js'), 'utf8');
}

function logStep(name) {
  console.log(`\n== ${name} ==`);
}

function fail(message) {
  throw new Error(message);
}

// 校验若干 i18n 键在每一种已接入语言的词典里都存在且非空。
// Guards that a UI string is present must look it up through the dictionaries
// rather than grepping hardcoded Chinese out of JS: once a string is wired to
// i18n, the literal legitimately leaves the source file. Language list is
// derived from SUPPORTED_LANGS so newly wired languages are covered too.
function requireLocaleKeys(...keys) {
  const m = /var SUPPORTED_LANGS = \[([^\]]*)\]/.exec(
    fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '13-i18n.js'), 'utf8')
  );
  if (!m) return fail('无法从 i18n 模块解析出 SUPPORTED_LANGS');
  const langs = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (langs.length < 2) return fail('SUPPORTED_LANGS 至少应包含默认语言与一种外语');
  for (const lang of langs) {
    let dict;
    try {
      dict = JSON.parse(fs.readFileSync(path.join(appRoot, 'public', 'locales', `${lang}.json`), 'utf8'));
    } catch (e) {
      return fail(`${lang}.json 无法解析：${e.message}`);
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(dict, key) || !String(dict[key]).trim()) {
        return fail(`${lang}.json 缺少非空键 ${key}`);
      }
    }
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'dist-internal-beta', 'vendor'].includes(entry.name)) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function jsCheckFiles() {
  const files = [];
  const addIfExists = file => {
    if (fs.existsSync(file)) files.push(file);
  };

  walk(path.join(appRoot, 'public', 'js', 'modules')).forEach(file => {
    if (file.endsWith('.js')) files.push(file);
  });
  addIfExists(path.join(appRoot, 'public', 'js', 'index-loader.js'));
  walk(path.join(appRoot, 'desktop')).forEach(file => {
    if (file.endsWith('.js')) files.push(file);
  });
  // 整个 server/ 目录整棵走一遍，而不是逐个点名：后端模块有 9 个文件加两个资源子目录，点名
  // 写法下新增一个文件不会有任何提示，它会静默逃过语法检查。
  // Walk the whole server/ tree instead of naming files: with a per-file list a newly added backend
  // module is silently skipped by the syntax check, and nothing says so.
  walk(path.join(appRoot, 'server')).forEach(file => {
    if (file.endsWith('.js')) files.push(file);
  });
  walk(path.join(appRoot, 'cuefield')).forEach(file => {
    if (file.endsWith('.js')) files.push(file);
  });

  return [...new Set(files)].sort();
}

function runNodeSyntaxCheck(files) {
  logStep('Node syntax check');
  let checked = 0;
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: appRoot,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      fail(`node --check failed: ${rel(file)}`);
    }
    checked += 1;
  }
  console.log(`[OK] Checked ${checked} JavaScript files.`);
}

function runPlaybackAudioGraphRegressionCheck() {
  logStep('Playback audio graph track-switch regression');
  const testFile = path.join(appRoot, 'tests', 'playback-audio-graph-recovery.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`playback audio graph regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runPlaybackSourceFallbackTransactionCheck() {
  logStep('Playback source fallback finite transaction regression');
  const testFile = path.join(appRoot, 'tests', 'playback-source-fallback-transaction.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`playback source fallback transaction regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runPlaybackSingleRepeatLoopRegressionCheck() {
  logStep('Playback single-repeat loop regression');
  const testFile = path.join(appRoot, 'tests', 'playback-single-repeat-loop.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`playback single-repeat loop regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runLocalMusicLibraryRegressionCheck() {
  logStep('Persistent local FLAC library regression');
  const testFile = path.join(appRoot, 'tests', 'local-music-library-persistence.test.js');
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`persistent local FLAC library regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

// 后端源码搬家（根目录 → server/）的回归。这条必须**真的把服务起起来发请求**：把 server.js 移动
// 位置会改变 `__dirname` 的落点，而静态资源/图标/版本都按它定位，改错了不抛任何异常 —— 进程正常
// 监听、每个请求都 404。读源码看不出来，只有真发一次请求才知道。
// Regression for the backend relocation (root -> server/). This one has to boot the service and make
// real requests: moving server.js changes what `__dirname` points at, and the static bundle, icon and
// version resolve relative to it. A mistake raises nothing — the port listens and everything 404s.
// Source text cannot show that; only an actual request can.
function runServerModuleRelocationCheck() {
  logStep('Backend module relocation regression');
  const testFile = path.join(appRoot, 'tests', 'server-module-relocation.test.js');
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`backend module relocation regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runBuiltInPlaylistRegressionCheck() {
  logStep('Persistent cross-provider built-in playlist regression');
  const testFile = path.join(appRoot, 'tests', 'built-in-playlist-library.test.js');
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`built-in playlist regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runWallpaperEngineIdleDisposeRegressionCheck() {
  logStep('Wallpaper Engine idle-dispose regression');
  const testFile = path.join(appRoot, 'tests', 'wallpaper-engine-idle-dispose.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`Wallpaper Engine idle-dispose regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runWallpaperEngineMinimizeResidentRegressionCheck() {
  logStep('Wallpaper Engine minimize resident regression');
  const testFile = path.join(appRoot, 'tests', 'wallpaper-engine-minimize-resident.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`Wallpaper Engine minimize resident regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runWallpaperEngineWin10YellowBorderRegressionCheck() {
  logStep('Wallpaper Engine Win10 yellow-border regression');
  const testFile = path.join(appRoot, 'tests', 'wallpaper-engine-win10-yellow-border.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`Wallpaper Engine Win10 yellow-border regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runGestureCameraPermissionRegressionCheck() {
  logStep('Gesture camera permission regression');
  const testFile = path.join(appRoot, 'tests', 'gesture-camera-permission.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`gesture camera permission regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runGesturePlayerActionsRegressionCheck() {
  logStep('Gesture player actions regression');
  const testFile = path.join(appRoot, 'tests', 'gesture-player-actions.test.js');
  const result = spawnSync(process.execPath, [testFile], { cwd: appRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`gesture player actions regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runGestureRuntimeLifecycleRegressionCheck() {
  logStep('Gesture camera runtime lifecycle regression');
  const testFile = path.join(appRoot, 'tests', 'gesture-runtime-lifecycle.test.js');
  const result = spawnSync(process.execPath, [testFile], { cwd: appRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`gesture camera runtime lifecycle regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runCuratedVisualPresetsRegressionCheck() {
  logStep('Curated visual presets regression');
  const testFile = path.join(appRoot, 'tests', 'curated-visual-presets.test.js');
  const result = spawnSync(process.execPath, [testFile], { cwd: appRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`curated visual presets regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runVisualClarityAndPortraitFullscreenRegressionCheck() {
  logStep('Lyric clarity, WE visual controls, and portrait fullscreen regression');
  const testFile = path.join(appRoot, 'tests', 'visual-clarity-and-portrait-fullscreen.test.js');
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`visual clarity and portrait fullscreen regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

// 粒子规模预算：档位系数、headroom 与缓冲区容量的关系、网格预算只能算一次。
// Particle population budget: the tier factors, the headroom-versus-capacity relationship, and the
// lattice budget being applied exactly once.
function runParticlePopulationBudgetRegressionCheck() {
  logStep('Particle population budget regression');
  const testFile = path.join(appRoot, 'tests', 'particle-population-budget.test.js');
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`particle population budget regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runQQVipEntitlementRegressionCheck() {
  logStep('QQ/Kugou provider entitlement regression');
  const testFiles = [
    path.join(appRoot, 'tests', 'qq-vip-entitlement.test.js'),
    path.join(appRoot, 'tests', 'kugou-vip-hardening.test.js'),
    path.join(appRoot, 'tests', 'kugou-login-bridge.test.js'),
    path.join(appRoot, 'tests', 'kugou-api-resilience.test.js'),
    path.join(appRoot, 'tests', 'provider-login-state-recovery.test.js'),
    path.join(appRoot, 'tests', 'provider-entitlement-boundary.test.js'),
  ];
  const result = spawnSync(process.execPath, ['--test'].concat(testFiles), {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail('QQ/Kugou provider entitlement regression failed');
  }
  process.stdout.write(result.stdout || '');
}

function runLoginEasterEggGateRegressionCheck() {
  logStep('Login easter egg one-time gate and wish selection regression');
  const testFiles = [
    path.join(appRoot, 'tests', 'login-easter-egg-gate.test.js'),
    path.join(appRoot, 'tests', 'login-easter-egg-wish-selection.test.js'),
  ];
  const result = spawnSync(process.execPath, ['--test'].concat(testFiles), {
    cwd: appRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`login easter egg gate/wish selection regression failed: ${testFiles.map(rel).join(', ')}`);
  }
  process.stdout.write(result.stdout || '');
}

function runSpotifyApiResilienceRegressionCheck() {
  logStep('Spotify API resilience regression');
  const testFile = path.join(appRoot, 'tests', 'spotify-api-resilience.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`Spotify API resilience regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runProviderRemovalDiyCinemaRegressionCheck() {
  logStep('Provider removal, fullscreen DIY, and cinematic preload regression');
  const testFile = path.join(appRoot, 'tests', 'provider-removal-diy-cinema-preload.test.js');
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`provider removal/DIY/cinematic regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runVisualPerformanceControlsRegressionCheck() {
  logStep('Visual performance controls regression');
  const testFile = path.join(appRoot, 'tests', 'visual-performance-controls.test.js');
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`visual performance controls regression failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runPlatformAccountSyncGuardCheck() {
  logStep('Platform account action and listen-sync guard');
  const testFile = path.join(appRoot, 'tests', 'platform-account-sync-guard.test.js');
  const result = spawnSync(process.execPath, [testFile], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`platform account/listen-sync guard failed: ${rel(testFile)}`);
  }
  process.stdout.write(result.stdout || '');
}

function runHomeDailyRecommendationRegressionCheck() {
  logStep('Complete daily recommendation data and bounded rendering regression');
  const testFiles = [
    path.join(appRoot, 'tests', 'home-daily-recommendations-backend.test.js'),
    path.join(appRoot, 'tests', 'home-daily-recommendation-virtualization.test.js'),
  ];
  const result = spawnSync(process.execPath, ['--test'].concat(testFiles), {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail('complete daily recommendation regression failed');
  }
  process.stdout.write(result.stdout || '');
}

function runQishuiProviderDistributionRegressionCheck() {
  logStep('Qishui provider distribution, entitlement, and signed Passport QR regression');
  const testFiles = [
    path.join(appRoot, 'tests', 'qishui-provider-distribution.test.js'),
    path.join(appRoot, 'tests', 'qishui-passport-qr-login.test.js'),
    path.join(appRoot, 'tests', 'qishui-session-recovery.test.js'),
    path.join(appRoot, 'tests', 'qishui-entitlement-cache.test.js'),
    path.join(appRoot, 'tests', 'qishui-tier-rights.test.js'),
  ];
  const result = spawnSync(process.execPath, ['--test'].concat(testFiles), {
    cwd: appRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail('Qishui provider distribution/entitlement/QR regression failed');
  }
  process.stdout.write(result.stdout || '');
}

function readIndexModulePaths() {
  const publicDir = path.join(appRoot, 'public');
  const loaderPath = path.join(publicDir, 'js', 'index-loader.js');
  const loader = fs.readFileSync(loaderPath, 'utf8');
  const match = loader.match(/const modulePaths = \[([\s\S]*?)\];/);
  if (!match) fail('modulePaths not found in public/js/index-loader.js');
  return { publicDir, loader, modulePaths: [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]) };
}

function checkIndexModuleRegistrationGuard() {
  logStep('Index module registration guard');
  const { publicDir, loader, modulePaths } = readIndexModulePaths();
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
  const registered = new Set(modulePaths);
  const unregistered = onDisk.filter((rel) => !registered.has(rel));
  if (unregistered.length) {
    fail(`module files missing from modulePaths (they would never load): ${unregistered.join(', ')}`);
  }
  const missingFiles = modulePaths.filter((rel) => !fs.existsSync(path.join(publicDir, rel)));
  if (missingFiles.length) {
    fail(`modulePaths entries without a file on disk: ${missingFiles.join(', ')}`);
  }
  // 重复登记会让同一个模块执行两次，顶层 var/function 被重复声明（后者静默覆盖前者）。
  // A duplicate registration executes the module twice and silently re-declares its top-level names.
  const duplicates = modulePaths.filter((rel, i) => modulePaths.indexOf(rel) !== i);
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

function parseCombinedIndexModules() {
  logStep('Combined index module parse');
  const { publicDir, modulePaths } = readIndexModulePaths();
  const combined = modulePaths
    .map(modulePath => fs.readFileSync(path.join(publicDir, modulePath), 'utf8'))
    .join('\n');
  new Function(combined);
  console.log(`[OK] Combined classic script parses. Modules: ${modulePaths.length}.`);
}

function scanForbiddenMarkers() {
  logStep('Forbidden FSR/DLSS/native FG scan');
  const scanTargets = [
    path.join(appRoot, 'public', 'js'),
    path.join(appRoot, 'desktop'),
    path.join(appRoot, 'server'),
    path.join(appRoot, 'cuefield')
  ];
  const files = [];
  for (const target of scanTargets) {
    if (!fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      walk(target).forEach(file => {
        if (/\.(js|json|html|css)$/i.test(file)) files.push(file);
      });
    } else {
      files.push(target);
    }
  }

  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (forbiddenPattern.test(text)) hits.push(rel(file));
  }
  if (hits.length) fail(`Forbidden markers found:\n${hits.join('\n')}`);
  console.log(`[OK] No FSR/DLSS/native FG markers in ${files.length} scanned files.`);
}

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
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const rendererText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '00-renderer-quality.js'), 'utf8');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const persistenceText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
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
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const rendererPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js');
  const rendererText = fs.readFileSync(rendererPath, 'utf8');
  const controlGlassText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '15-control-glass-animations.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
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
  if (!/mineradio-wallpaper-engine-list/.test(mainText) || !/mineradio-wallpaper-engine-project-details/.test(mainText) || !/mineradio-wallpaper-engine-open-project-details/.test(mainText) || !/mineradio-wallpaper-engine-start-scene/.test(mainText) || !/mineradio-wallpaper-engine-capture-result/.test(mainText) || !/mineradio-wallpaper-engine-glass-surface/.test(mainText) || !/mineradio-wallpaper-engine-prepare-glass-capture/.test(mainText) || !/installProtocol\(protocol\)/.test(mainText) || !/listWallpaperEngineProjects/.test(preloadText) || !/getWallpaperEngineProjectDetails/.test(preloadText) || !/openWallpaperEngineProjectDetails/.test(preloadText) || !/startWallpaperEngineScene/.test(preloadText) || !/reportWallpaperEngineCaptureResult/.test(preloadText) || !/prepareWallpaperEngineGlassCapture/.test(preloadText) || !/updateWallpaperEngineGlassSurface/.test(preloadText) || !/stopWallpaperEngineScene/.test(preloadText) || !/isTrustedWallpaperEngineIpc/.test(mainText) || !/function isTrustedMainDocumentUrl/.test(mainText) || !/pathname === '\/' \|\| pathname === '\/index\.html'/.test(mainText)) {
    fail('Wallpaper Engine scan/import IPC and restricted media protocol are not fully wired');
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
  const rendererDwmStartBlock = rendererText.slice(
    rendererText.indexOf("if (result.captureMode === 'dwm-thumbnail')"),
    rendererText.indexOf('var stream = takeWallpaperEnginePreparedCaptureStream')
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
  if (!/scheduleWallpaperEngineHostBoundsRestart/.test(mainText) || !/suspendWallpaperEngineForHiddenHost/.test(mainText) || !/resumeWallpaperEngineForVisibleHost/.test(mainText) || !/win\.on\('move'[\s\S]{0,220}scheduleWallpaperEngineHostBoundsRestart\(win, 'move'\)/.test(mainText) || !/win\.on\('resize'[\s\S]{0,220}scheduleWallpaperEngineHostBoundsRestart\(win, 'resize'\)/.test(mainText) || !/scheduleWallpaperEngineHostBoundsRestart\([\s\S]{0,180}display-metrics-changed/.test(mainText) || !/phase:\s*'prepare'/.test(mainText) || !/phase:\s*'restart'/.test(mainText) || !/mineradio-wallpaper-engine-host-bounds-changed/.test(mainText) || !/onWallpaperEngineHostBoundsChanged/.test(preloadText) || !/handleWallpaperEngineHostBoundsChange/.test(rendererText) || !/wallpaperEngineHostBoundsPreparing/.test(rendererText) || !/restartWallpaperEngineAfterHostBoundsChange/.test(rendererText) || !/status\.captureMode === 'dwm-thumbnail'\) return/.test(mainText) || !/followTimer\.Interval = 60/.test(dwmSurfaceBlock) || !/FollowHost\(\)/.test(dwmSurfaceBlock)) {
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
  if (!/appQuitCleanupPromise/.test(mainText) || !/event\.preventDefault\(\)/.test(mainText) || !/Promise\.race\(\[runtimeCleanup, timeoutCleanup\]\)/.test(mainText)) {
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
  const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const fullDesktopRuntimeText = fs.readFileSync(fullDesktopRuntimePath, 'utf8');
  const iconShapeRuntimeText = fs.readFileSync(iconShapeRuntimePath, 'utf8');
  const nativeIconLayerRuntimeText = fs.readFileSync(nativeIconLayerRuntimePath, 'utf8');
  const wallpaperEngineRuntimeText = fs.readFileSync(wallpaperEngineRuntimePath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const wallpaperToggleTag = htmlText.match(/<[^>]*\bid=["']t-wallpaperMode["'][^>]*>/i);
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const layoutText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const persistenceText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
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
    || !/mineradio-full-desktop-set-software-lock/.test(mainText)
    || !/mineradio-full-desktop-set-icons-visible/.test(mainText)
    || !/mineradio-full-desktop-request-keyboard-focus/.test(mainText)
    || !/mineradio-full-desktop-pointer-route/.test(mainText)
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
  const shutdownBlock = mainText.slice(mainText.indexOf("app.on('before-quit'"));
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
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
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

function checkLyricLayoutRangeGuard() {
  logStep('Lyric layout range guard');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const persistenceText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const bindingText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const stageText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const rangeChecks = [
    [htmlText, /id="fx-lyricx"[^>]+min="-4\.0"[^>]+max="4\.0"/, 'lyric x slider range'],
    [htmlText, /id="fx-lyricy"[^>]+min="-2\.4"[^>]+max="2\.7"/, 'lyric y slider range'],
    [htmlText, /id="fx-lyricz"[^>]+min="-3\.2"[^>]+max="3\.2"/, 'lyric z slider range'],
    [htmlText, /id="fx-lyrictiltx"[^>]+min="-84"[^>]+max="84"/, 'lyric tilt x slider range'],
    [htmlText, /id="fx-lyrictilty"[^>]+min="-84"[^>]+max="84"/, 'lyric tilt y slider range'],
    [persistenceText, /lyricOffsetX: layoutNumber\(raw\.lyricOffsetX, 0, -4\.0, 4\.0\)/, 'autosave read x range'],
    [persistenceText, /lyricTiltY: layoutNumber\(fx\.lyricTiltY, 0, -84, 84\)/, 'autosave write tilt y range'],
    [archiveText, /lyricOffsetZ: archiveNumber\(raw, 'lyricOffsetZ', fxDefaults\.lyricOffsetZ, -3\.2, 3\.2\)/, 'archive z range'],
    [bindingText, /lyricOffsetX'\) fx\.lyricOffsetX = clampRange\(fx\.lyricOffsetX, -4\.0, 4\.0\)/, 'runtime x clamp'],
    [bindingText, /lyricTiltX' \|\| pair\[1\] === 'lyricTiltY'\) fx\[pair\[1\]\] = Math\.round\(clampRange\(fx\[pair\[1\]\], -84, 84\)\)/, 'runtime tilt clamp'],
    [stageText, /var layoutY = clampRange\(Number\(fx\.lyricOffsetY\) \|\| 0, -2\.4, 2\.7\)/, 'render y range'],
    [stageText, /var layoutTiltY = clampRange\(Number\(fx\.lyricTiltY\) \|\| 0, -84, 84\)/, 'render tilt y range']
  ];
  for (const [text, pattern, label] of rangeChecks) {
    if (!pattern.test(text)) fail(`expanded lyric layout range missing: ${label}`);
  }
  console.log('[OK] Lyric layout position/depth/angle ranges stay expanded through UI, runtime, autosave, and archives.');
}

function checkPointerLockPermission() {
  logStep('Free camera pointer-lock guard');
  const mainPath = path.join(appRoot, 'desktop', 'main.js');
  const mainText = fs.readFileSync(mainPath, 'utf8');
  const freeCameraPath = path.join(appRoot, 'public', 'js', 'modules', '01-scene', '01-orbit-free-camera.js');
  const pointerPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '00-pointer-cover-particles.js');
  const freeCameraText = fs.readFileSync(freeCameraPath, 'utf8');
  const pointerText = fs.readFileSync(pointerPath, 'utf8');
  if (!/LOCAL_APP_PERMISSION_ALLOWLIST[\s\S]{0,180}pointerLock/.test(mainText)) {
    fail('pointerLock permission is missing from desktop/main.js local app allowlist');
  }
  if (/rawInputBlocked/.test(freeCameraText) || /unadjustedMovement/.test(freeCameraText)) {
    fail('free camera pointer lock must use plain requestPointerLock; raw input requests can break local Electron lock acquisition');
  }
  if (!/var lockResult = el\.requestPointerLock\(\)/.test(freeCameraText)) {
    fail('free camera pointer lock must request plain pointer lock directly');
  }
  if (!/freeCameraPointerLockActive/.test(pointerText) || !/requestFreeCameraPointerLock\('mousemove'\)/.test(pointerText)) {
    fail('free camera mouse move path must keep requesting pointer lock before using mouse deltas');
  }
  console.log('[OK] Local app pointerLock permission and plain lock request are guarded.');
}

function checkProgressSeekDragGuard() {
  logStep('Progress drag seek guard');
  const progressPath = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js');
  const stagePath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js');
  const mainLoopPath = path.join(appRoot, 'public', 'js', 'modules', '11-main-loop.js');
  const rendererQualityPath = path.join(appRoot, 'public', 'js', 'modules', '01-scene', '00-renderer-quality.js');
  const text = fs.readFileSync(progressPath, 'utf8');
  const stageText = fs.readFileSync(stagePath, 'utf8');
  const mainLoopText = fs.readFileSync(mainLoopPath, 'utf8');
  const rendererQualityText = fs.readFileSync(rendererQualityPath, 'utf8');
  if (!/previewProgressPointer/.test(text) || !/commitProgressSeek/.test(text) || !/waitForProgressSeekReady/.test(text)) {
    fail('progress drag must preview during drag and commit seek once on release');
  }
  if (!/isProgressDragPreviewActive/.test(text) || !/getProgressDragPreviewSeconds/.test(text)) {
    fail('progress drag must expose preview time for lyrics and beat visuals');
  }
  if (!/stageLyricProgressPreviewActive/.test(stageText) || !/stageLyricPlaybackSeconds/.test(stageText) || !/getProgressDragPreviewSeconds/.test(stageText)) {
    fail('stage lyrics must follow progress drag preview time without seeking audio on every pointermove');
  }
  const previewTickBody = (text.match(/function scheduleProgressLyricPreviewTick\(\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  if (!/scheduleProgressLyricPreviewTick/.test(text) || !/markRenderInteraction\('progress-drag'/.test(text) || !/wakeMainLoopFromBackground/.test(previewTickBody) || /tickLyricsParticles\(\)/.test(previewTickBody) || !/mainFrameGates\.lyricsParticles/.test(mainLoopText) || !/tickLyricsParticles\(\)/.test(mainLoopText)) {
    fail('progress drag must keep one main-loop-owned lyric tick per display frame');
  }
  if (!/function shouldSkipFixedRenderCadenceFrame/.test(mainLoopText) || !/state\.phase[\s\S]{0,300}elapsedMs \* fps \/ 1000/.test(mainLoopText) || !/fps >= displayHz \* 0\.98/.test(mainLoopText) || !/fixedForegroundFps/.test(rendererQualityText) || !/fixedForegroundFps == null \|\| fixedForegroundFps === 0/.test(rendererQualityText)) {
    fail('fixed foreground FPS must use phase accumulation and must not be bypassed by repeated drag interaction wakeups');
  }
  if (/renderProgressPreview\(preview\.time, preview\.duration\);\s*syncBeatMapPlaybackCursor/.test(text)) {
    fail('raw pointermove must not rescan the full beat map during lyric preview');
  }
  if (!/previewHoldUntil/.test(text) || !/previewClockRunning/.test(text) || !/getProgressPreviewClockSeconds/.test(text)) {
    fail('progress drag release must keep one continuous preview clock through seek settle');
  }
  if (!/beginProgressPreviewHold\(serial,\s*2800,\s*!!resumeAfterSeek,\s*media,\s*mediaSrc,\s*targetTime\)/.test(text) || !/finishProgressPreviewHold\(serial,\s*96\)/.test(text)) {
    fail('progress drag release must retain the preview clock across slow seek and lyric-window settlement');
  }
  if (!/function progressSeekTargetReached/.test(text) || !/!progressSeekMediaStillCurrent/.test(text) || !/media\.seeking/.test(text) || !/waitForProgressSeekReady\(media,\s*targetTime,\s*serial/.test(text)) {
    fail('progress seek completion must verify media identity, seek state, serial, and actual target time');
  }
  if (!/function progressSeekPreviewVisualReady/.test(text) || !/stageLyricProgressSeekVisualReady/.test(text + stageText) || !/previewAudioSettled && progressSeekPreviewVisualReady\(\)/.test(text)) {
    fail('progress preview must not hand its clock back before the final lyric window is visually committed');
  }
  if (!/primeProgressSeekPlayback\(media,\s*mediaSrc,\s*serial\)/.test(text) || !/resumePlaySerial/.test(text)) {
    fail('progress drag release must pre-start playback while muted instead of waiting for a second visual/audio handoff');
  }
  if (!/isProgressDragPreviewActive\(\)\s*&&\s*progressDragState\.previewDuration[\s\S]{0,120}renderProgressPreview\(getProgressPreviewClockSeconds\(\),\s*progressDragState\.previewDuration\)/.test(text)) {
    fail('progress UI must follow the same preview clock during release hold');
  }
  if (!/progressBar\.addEventListener\('pointermove'[\s\S]{0,180}queueProgressPointerPreview/.test(text) || !/function queueProgressPointerPreview[\s\S]{0,650}previewProgressPointer/.test(text)) {
    fail('progress pointermove must coalesce and update preview instead of committing audio currentTime');
  }
  if (/progressBar\.addEventListener\('pointermove'[\s\S]{0,220}currentTime\s*=/.test(text)) {
    fail('progress pointermove must not write audio.currentTime while dragging');
  }
  if (!/setAudioOutputGainImmediate\(0\)/.test(text) || !/resumeAfterSeek/.test(text) || !/attemptAudioPlay\(\{ manual: true, silent: true, fade: true \}\)/.test(text)) {
    fail('progress seek must mute during drag and resume with a fade after release');
  }
  if (!/!audio\.paused && !audio\.ended && playing/.test(text) || !/if \(!resumeAfterSeek\)[\s\S]{0,260}media\.pause\(\)/.test(text)) {
    fail('progress seek must only resume audio when it was actually playing before drag');
  }
  const commitStart = text.indexOf('function commitProgressSeek');
  const commitIdentityGuard = text.indexOf('if (!progressSeekMediaStillCurrent(media, mediaSrc))', commitStart);
  const commitMute = text.indexOf('setAudioOutputGainImmediate(0)', commitStart);
  if (!/function progressSeekMediaStillCurrent\(media, mediaSrc\)/.test(text) || commitStart < 0 || commitIdentityGuard < commitStart || commitMute < 0 || commitIdentityGuard > commitMute || /if \(!progressSeekMediaStillCurrent\(media, mediaSrc\)\) \{[\s\S]{0,120}restorePlaybackGain\(\)/.test(text) || !/progressSeekMediaStillCurrent\(dragMedia, dragMediaSrc\)[^\n]*restorePlaybackGain/.test(text)) {
    fail('stale progress drags must never mute or restore gain on a newly switched audio element');
  }
  console.log('[OK] Progress drag previews visually and commits audio seek on release.');
}

function checkLyricBackfaceMaterialGuard() {
  logStep('Lyric backface readability guard');
  const rowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js'), 'utf8');
  if (!/makeLyricBackfaceReadableMaterial/.test(rowText) || !/gl_FrontFacing\s*\?\s*vUv\s*:\s*vec2\(1\.0 - vUv\.x, vUv\.y\)/.test(rowText)) {
    fail('row lyric translation/readability/glow materials must flip UV on backfaces like the primary lyric shader');
  }
  if (!/readabilityMat = makeLyricBackfaceReadableMaterial/.test(rowText) || !/glowMat = makeLyricBackfaceReadableMaterial/.test(rowText)) {
    fail('lyric row readability and glow layers must use backface-readable materials');
  }
  console.log('[OK] Lyric translation/readability/glow layers stay readable from the back side.');
}

function checkLyricScrollPerformanceGuard() {
  logStep('Lyric scroll performance guard');
  const rowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js'), 'utf8');
  const displayModeText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '08-lyrics-display-modes.js'), 'utf8');
  const paletteText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '07-lyrics-palette-text-utils.js'), 'utf8');
  const shaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '11-lyrics-shaders.js'), 'utf8');
  const payloadText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '09-lyrics-payloads.js'), 'utf8');
  const starRiverText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '03-lyrics-star-river.js'), 'utf8');
  const fontText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '05-lyrics-fonts-texture.js'), 'utf8');
  const maskText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '10-lyrics-mask-textures.js'), 'utf8');
  const meshText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '13-lyrics-mesh-build.js'), 'utf8');
  const stageText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const lyricText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  const lyricColorText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '01-lyric-color-controls.js'), 'utf8');
  const lyricColorSetterText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '03-cover-picker-fonts.js'), 'utf8');
  const fxBindText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const fxPanelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const lyricActionsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const switchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js'), 'utf8');
  const schedulerText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '10-frame-scheduler.js'), 'utf8');
  const previewRowLockBindings = (stageText.match(/previewMotionLock: previewMotionLock/g) || []).length;
  if (/lazyGlow/.test(rowText) || /highLineGlowBudget/.test(rowText)) {
    fail('lyric row glow must not be lazily created while scrolling; runtime canvas texture creation causes stutter');
  }
  if (/cropLyricGlowGeometryUv|lyricRowGlowCropFrame|rowGlowCrop|glowCrop/.test(rowText + meshText)) {
    fail('lyric glow must not crop away the texture feathering; hard UV crops cause visible square glow edges');
  }
  const independentGlowRasterBindings = (rowText.match(/lyricGlowRasterMetrics\(/g) || []).length;
  if (
    !/function lyricGlowTextureWidthBudget/.test(maskText) ||
    !/function lyricGlowRasterMetrics/.test(maskText) ||
    !/logicalActiveTextWidth/.test(maskText) ||
    !/minimumRasterFont/.test(maskText) ||
    !/rasterScale:\s*state\.pixelScale/.test(maskText) ||
    !/fontSize:\s*state\.fontSize/.test(maskText) ||
    independentGlowRasterBindings < 2 ||
    !/makeLyricGlowTexture\([\s\S]{0,360}glowRaster\.fontSize[\s\S]{0,360}glowRaster\.scale\)/.test(rowText) ||
    !/beginLyricGlowTextureBuild\([\s\S]{0,360}glowRaster\.fontSize[\s\S]{0,360}glowRaster\.scale\)/.test(rowText) ||
    /(?:make|begin)LyricGlowTexture(?:Build)?\([\s\S]{0,360}lineMask\.rasterScale/.test(rowText) ||
    /rowGlowAspect\s*=\s*Math\.max\(0\.12/.test(rowText) ||
    !/rowGlowTextureRatio/.test(rowText)
  ) {
    fail('row lyric glow must use its own logical-width raster budget and preserve the true long-line texture aspect ratio');
  }
  if (!/makeLyricGlowTexture\([\s\S]{0,260}activeMask\.activeLine,\s*null\)/.test(meshText) || /glowMeta\.matchMask \?/.test(meshText)) {
    fail('single-line lyric glow fallback must use the same standalone feathered texture path');
  }
  if (!/glowLockedToText/.test(rowText) || !/row\.glow\.position\.set\(glowTargetX, glowTargetY, glowTargetZ\)/.test(rowText)) {
    fail('active row lyric glow must stay locked to the text mesh while multi-line lyrics scroll');
  }
  if (/lyricBottomControlOcclusionFade/.test(rowText)) {
    fail('bottom controller glass lyric reflections are intentional and must not be masked away');
  }
  if (!/function lyricRowGlowThreeColor/.test(paletteText) || !/function lyricBeatGlowThreeColor/.test(paletteText) || !/lyricMultiLineGlowDetached/.test(paletteText) || !/lyricRowGlowThreeColor\(pal, !!row\.isTranslation\)/.test(rowText) || !/uGlowColor: \{ value: lyricStageGlowThreeColor/.test(shaderText) || !/uSolarColor: \{ value: lyricBeatGlowThreeColor/.test(shaderText)) {
    fail('multi-line lyric glow and beat bloom must follow the independent glow color instead of lyric text color changes');
  }
  if (!/rowGlow \* \(1 \+ rowGlowBeat \* 0\.46\)/.test(rowText) || !/glowTargetScale = row\.mesh \? row\.mesh\.scale\.x : scaleTarget/.test(rowText) || !/var lyricBeatGlow = fx\.lyricGlowBeat \? stageLyrics\.beatGlow : 0/.test(stageText)) {
    fail('the lyric back glow layer must pulse through opacity while staying locked to the text transform');
  }
  if (!/setLyricSparkColor\(data, lyricBeatGlowThreeColor/.test(paletteText) || !/data\.sunMat\.color\.copy\(lyricBeatGlowThreeColor/.test(paletteText) || !/stageLyricPrewarm\.mesh/.test(paletteText) || !/function setLyricMaterialColor/.test(paletteText) || !/row\.glowMat\) setLyricMaterialColor\(row\.glowMat, lyricRowGlowThreeColor/.test(paletteText) || !/if \(ru\.uColor\) ru\.uColor\.value\.copy/.test(paletteText)) {
    fail('lyric glow color changes must immediately repaint active, outgoing, and prewarmed lyric glow materials');
  }
  if (!/function lyricControlPalette/.test(lyricColorText) || !/picker\) picker\.value = tone/.test(lyricColorText) || !/picker\) picker\.value = linked \? tone : color/.test(lyricColorText) || !/setStageLyricPalette\(lyricPaletteFromHex\(fx\.lyricColor\), \{ immediate: true/.test(lyricColorSetterText)) {
    fail('lyric color controls must display the live palette and repaint lyrics immediately while dragging colors');
  }
  if (!/function lyricHighImpactTextHsl/.test(paletteText) || !/minS:\s*0\.90/.test(paletteText) || !/sampledBright/.test(paletteText) || /primary:\s*'#064b5b'/.test(paletteText)) {
    fail('cover-based lyric text color must stay high-brightness/high-saturation instead of darkening bright cover samples');
  }
  if (!/function lyricCoverLooksMonochrome/.test(paletteText) || !/avgChroma/.test(paletteText) || !/colorfulRatio/.test(paletteText) || !/best\.chroma/.test(paletteText) || /lyricTextPaletteFromHsl\(hsl, avgL, Math\.max\(0, best\.score\)\)/.test(paletteText)) {
    fail('monochrome cover lyric sampling must use real chroma statistics instead of boosting brightness scores into vivid colors');
  }
  if (!/function lyricBackdropAdaptActive\(\)\s*\{[\s\S]{0,180}fx\.lyricBackdropAdapt !== false[\s\S]{0,90}lyricBackgroundAdaptStrengthValue\(\) > 0\.001;/.test(rowText) || /preset === 7 \|\| preset === 8/.test(rowText) || !/setFxPanelControlsHidden\(\['fx-lyricbgadapt-row', 'fx-lyricbgadapt'\], false\)/.test(fxPanelText)) {
    fail('lyric bright-backdrop avoidance must stay global while honoring its performance toggle');
  }
  if (!/color: lyricBeatGlowThreeColor\(pal/.test(meshText) || !/color: lyricStageGlowThreeColor\(pal/.test(meshText) || !/uColor: \{ value: lyricBeatGlowThreeColor\(pal/.test(meshText)) {
    fail('lyric sun, texture glow, and beat particles must initialize from the glow palette instead of the text highlight color');
  }
  if (!/fx && fx\.lyricGlowLinked !== false \? 'glow-linked' : 'glow-detached'/.test(stageText) || !/stageLyricColorSignature\(pal\.glowColor\)/.test(stageText)) {
    fail('stage lyric prewarm cache key must include glow link mode and resolved glow color');
  }
  if (!/newIdx === stageLyrics\.currentIdx && stageLyrics\.current && stageLyrics\.currentPayload/.test(stageText)) {
    fail('stage lyrics must reuse the current payload while the active lyric index is unchanged');
  }
  if (!/function scheduleStageLyricPrewarmForIndex/.test(stageText) || !/stageLyricPrewarm\.targetIndex/.test(stageText)) {
    fail('stage lyric prewarm must support explicit target indexes without timer churn');
  }
  if (!/function stageLyricLightPrewarmReason/.test(stageText) || !/var lightweight = stageLyricLightPrewarmReason\(reason\)/.test(stageText) || !/lightweightTrack: lightweight/.test(stageText) || !/options\.lightweightTrack/.test(stageText)) {
    fail('intro and lyric-toggle prewarm must use lightweight track windows before the first real lyric line takes over');
  }
  if (!/setLyricTrackTarget\(stageLyricPrewarm\.mesh, payload\)/.test(stageText) || !/targetLineIndex >= Number\(data\.trackStart\)/.test(stageText)) {
    fail('stage lyric prewarm meshes must be reusable for any target line inside the prewarmed page');
  }
  if (!/function stageLyricCurrentUsesPersistentTrack/.test(stageText) || !/function initializeStageLyricPersistentTrack/.test(stageText) || !/data\.trackPersistent = true/.test(stageText) || !/data\.trackStart = 0/.test(stageText) || !/data\.trackEnd = lyricsLines\.length - 1/.test(stageText) || !/stageLyrics\.current = mesh;[\s\S]{0,100}initializeStageLyricPersistentTrack\(mesh, payload\)/.test(stageText)) {
    fail('the first multi-line lyric mesh must become the persistent whole-song track root instead of being replaced by a later full mesh');
  }
  if (!/lightPageSize/.test(stageText) || !/lightOverlap/.test(stageText) || !/lightStep/.test(stageText)) {
    fail('lightweight lyric first paint must keep its bounded overlapping window before the full-song mesh is ready');
  }
  if (!/function lyricBufferedTrackWindow\(index, mode\) \{[\s\S]{0,560}return \{ start: 0, end: last \};/.test(stageText) || /function lyricBufferedTrackWindow\(index, mode\) \{[\s\S]{0,620}var pageSize/.test(stageText) || !/var windowInfo = lyricBufferedTrackWindow\(index, mode\);/.test(stageText)) {
    fail('the logical multi-line lyric descriptor track must cover the whole song without page-dependent scroll coordinates');
  }
  if (!/function stableStageLyricRowMaskLayout/.test(meshText) || !/preparedMasks\.rowBaseMask \|\| makeLyricMask\(rowBasePayload \|\| activePayload \|\| payload \|\| text, rowBaseLayout\)/.test(meshText) || !/state\.rowBaseMask = makeLyricMask\(state\.rowBasePayload \|\| state\.activePayload \|\| state\.payload \|\| state\.text, rowBaseLayout\)/.test(meshText)) {
    fail('lyric row base masks must use a stable font layout so long lyrics do not resize while dragging');
  }
  if (!/function scheduleLyricTrackBoundaryPrewarm/.test(meshText) || !/data\.trackPersistent && typeof ensureStageLyricPersistentTrackRows/.test(meshText) || !/ensureStageLyricPersistentTrackRows\(stageLyrics && stageLyrics\.current, targetLineIndex/.test(meshText)) {
    fail('persistent lyric tracks must extend resident rows inside the same root instead of prewarming a replacement page');
  }
  if (!/function shouldSnapLyricTrackScroll/.test(meshText) || !/function snapLyricTrackScroll/.test(meshText) || !/trackScrollSnapUntil/.test(rowText + meshText + stageText) || !/needsScrollSnap/.test(rowText)) {
    fail('multi-line lyric track reuse must snap invalid first-frame scroll offsets so rows do not compress until pause/play');
  }
  if (
    !/var snapTrackScroll = shouldSnapLyricTrackScroll/.test(meshText) ||
    !/data\.trackPersistent && data\.trackScrollPrimed[\s\S]{0,260}snapTrackScroll = false/.test(meshText) ||
    /var snapTrackScroll = previewMotionLock \|\| shouldSnapLyricTrackScroll/.test(meshText) ||
    !/var previewMotionLock = stageLyricProgressPreviewActive\(\)/.test(stageText) ||
    !/progressPreviewHoldY/.test(stageText) ||
    previewRowLockBindings < 2 ||
    !/function stageLyricResidentDisplayedScrollOffset/.test(stageText) ||
    !/var displayedScrollOffset = stageLyricResidentDisplayedScrollOffset/.test(stageText) ||
    !/primeStageLyricResidentRowTransform\(data, row, transformSnapshot\)/.test(stageText) ||
    !/function stageLyricPersistentNextTextRunwayRange/.test(stageText) ||
    !/persistent-track-full-text-runway/.test(stageText) ||
    !/var previewMotionLock = opts\.previewMotionLock === true/.test(rowText) ||
    !/var pendingPayload = data\.trackPersistent && data\.trackPendingPayload/.test(rowText) ||
    !/var targetLineIndex = pendingTargetLineIndex != null/.test(rowText) ||
    !/var continuousTrackMaxRowsPerFrame = 0\.68/.test(rowText) ||
    !/trackStep = clampRange\(trackStep, -continuousTrackMaxStep, continuousTrackMaxStep\)/.test(rowText) ||
    !/function lyricNearestPrimaryLineIndexForVirtual/.test(rowText) ||
    !/var presentationLineIndex = previewTrackCorridor/.test(rowText) ||
    !/data\.trackPresentationLineIndex = presentationLineIndex/.test(rowText) ||
    /if \(previewMotionLock\) \{[\s\S]{0,140}data\.trackScrollOffset = targetIndex/.test(rowText) ||
    /if \(previewMotionLock\) \{[\s\S]{0,180}row\.mesh\.position\.set/.test(rowText) ||
    !/var continuousRowMaxRowsPerFrame = 0\.66/.test(rowText) ||
    !/rowYStep = clampRange\(rowYStep, -continuousRowMaxStepWorld, continuousRowMaxStepWorld\)/.test(rowText) ||
    !/row\.mesh\.position\.y \+= rowYStep/.test(rowText)
  ) {
    fail('progress dragging must keep the shared lyric track easing continuously while only decorative motion is locked');
  }
  if (!/function stageLyricUsesSingleLineSwap/.test(stageText) || !/mode === 'single' && !data\.usesTrack/.test(stageText) || !/if \(singleLineSwap\) \{[\s\S]{0,220}mesh\.position\.z -= dt \* 0\.26/.test(stageText) || !/if \(!singleLineSwap\) group\.position\.y \+= enterDir \* lineWorldStep/.test(meshText)) {
    fail('single-line lyrics must keep the old GitHub fade/float swap instead of inheriting multi-line scroll offsets');
  }
  if (!/function stageLyricPayloadIsSingleLine/.test(stageText) || !/function stageLyricSingleLineTrackStub/.test(stageText) || !/if \(stageLyricPayloadIsSingleLine\(payload\)\) return false;/.test(stageText) || !/singleLineBoundaryNoSyncBuild/.test(stageText) || !/var singleLineDemand = stageLyricPayloadIsSingleLine\(payload\)/.test(stageText) || !/var delay = singleLineDemand \? 0 : 16/.test(stageText)) {
    fail('single-line lyrics must stay on the cheap swap mesh path and prewarm boundary meshes instead of building on the switching frame');
  }
  if (!/if \(mode === 'single'\) \{[\s\S]{0,160}stageLyricSingleLineTrackStub\(index\)/.test(stageText) || !/trackKey: '',[\s\S]{0,140}trackEntries: singleTrack\.entries/.test(stageText) || !/function stageLyricMultiLineWarmupLoad\(\) \{[\s\S]{0,120}return mode !== 'single';/.test(stageText)) {
    fail('single-line lyric payloads must bypass buffered trackEntries even when translations are enabled');
  }
  if (!/var singleLineStartX = singleLineSwap \? 0 : \(Math\.random\(\) - 0\.5\) \* 0\.045/.test(meshText) || !/var singleLineStartX = singleLineSwap \? 0 : \(Math\.random\(\) - 0\.5\) \* 0\.045/.test(stageText) || !/if \(singleLineSwap\) \{[\s\S]{0,220}mesh\.position\.y \+= \(\(0\.18 \+ \(verticalFloatOn \?/.test(stageText)) {
    fail('single-line lyric sentence endings must avoid random lateral jumps and hard visual stops');
  }
  if (!/var stageLyricSingleLinePrewarm = \{ items: \{\}, order: \[\], max: 10 \};/.test(stageText) || !/var stageLyricTrackSwitchBootstrapUntil = 0;/.test(stageText) || !/function scheduleStageLyricSingleLineNextPrewarm/.test(stageText) || !/stageLyricSingleLineNextPrewarmReady\(currentIndex\)/.test(stageText) || !/function stageLyricSingleLineIndexPrewarmReady[\s\S]{0,420}stageLyricSingleLinePrewarmCanServePayload\(payload\)[\s\S]{0,220}stageLyricPrewarmCanServePayload\(payload\)/.test(stageText) || !/function stageLyricSingleLineWarmupPending[\s\S]{0,520}stageLyricSingleLineIndexPrewarmReady\(singleLineIndex\)/.test(stageText.replace(/function stageLyricWarmupPending/, 'function stageLyricSingleLineWarmupPending')) || !/function stageLyricSingleLineUpcomingIndexes/.test(stageText) || !/function stageLyricSingleLinePrewarmDelay/.test(stageText) || !/function scheduleStageLyricSingleLineBootstrapPrewarm/.test(stageText) || !/function scheduleStageLyricSingleLineCachePrewarm/.test(stageText) || !/takeStageLyricSingleLinePrewarmMesh\(payload\) \|\| takeStageLyricPrewarmMesh\(payload\)/.test(stageText) || !/stageLyricSingleLineUpcomingIndexes\(currentIndex, 6\)/.test(stageText) || !/stageLyricTrackSwitchBootstrapUntil = stageLyricNowMs\(\) \+ 4800/.test(stageText) || !/return 0;[\s\S]{0,260}var idx = -1;/.test(stageText) || !/stageLyricSingleLineBootstrapIndex\(\)/.test(stageText) || !/scheduleStageLyricSingleLineBootstrapPrewarm\(prewarmReason, restoreWarmup \? 24 : 44\)/.test(lyricText) || /if \(stageLyricSingleLineNextPrewarmReady\(currentIndex\)\) return true;/.test(stageText) || !/single-line-lookahead-/.test(stageText) || !/markRenderInteraction\('lyric-swap', 360\)/.test(stageText) || !/scheduleStageLyricSingleLineNextPrewarm\(newIdx, lyricT/.test(stageText)) {
    fail('single-line lyrics with translations must prewarm the next sentence mesh before the switching frame');
  }
  if (!/var primeAmount = singleLinePayload \? 0 : \(Math\.abs\(lineStep\) > 0 \? 0\.34 : 0\.24\)/.test(stageText)) {
    fail('single-line lyrics must fade in from zero like the GitHub baseline instead of popping in pre-brightened');
  }
  if (!/visibilityAbs = Math\.abs\(parentVirtualForVisibility - visibilityScrollOffset\)/.test(rowText) || !/visibleRadius \+ 1\.10 - visibilityAbs/.test(rowText)) {
    fail('translation row visibility must be calculated from its bound primary lyric row');
  }
  if (!/singleLineStaticSwap = displayMode === 'single' && !data\.usesTrack/.test(rowText) || !/singleLineTranslationSwap && isFinite\(Number\(row\.baseY\)\)/.test(rowText) || !/baseScale = Number\(row\.baseScale\)/.test(rowText) || !/cloneStageLyricEntryForLayer\(entry,\s*\{\s*virtualIndex:\s*virtualIndex\s*\}\)/.test(rowText)) {
    fail('single-line translation rows must share the primary single-line swap instead of sliding up from their own anchor');
  }
  if (!/lyricLineHasTranslationAt\(n \+ 1\)/.test(displayModeText)) {
    fail('translation-aware lyric spacing must reserve room before a translated next line enters');
  }
  if (/trackScrollPayloadKey/.test(meshText) || !/function lyricTrackScrollWindowKey/.test(meshText) || !/return payload\.trackKey;/.test(meshText) || !/data\.trackScrollWindowKey !== payloadWindowKey/.test(meshText)) {
    fail('multi-line lyric scrolling identity must stay bound to the song/style track instead of resident window bounds');
  }
  if (!/function requestStageLyricWarmup/.test(stageText) || !/function stageLyricWarmupPending/.test(stageText) || !/scheduleStageLyricPrewarmForIndex\(0, 'intro-first-line'/.test(stageText)) {
    fail('stage lyrics must warm up before the first real lyric line replaces the intro title');
  }
  if (!/function buildStageLyricPlaybackPayload/.test(stageText) || !/buildStageLyricDisplayPayload\(index, \{ lightweightTrack: true \}\)/.test(stageText) || !/stageLyricPrewarmCanServePayload\(lightweightPayload\)/.test(stageText)) {
    fail('the first real lyric line must be allowed to take over the lightweight prewarm mesh without rebuilding a full multi-line track');
  }
  if (!/shouldStartLightweight/.test(stageText) || !/currentIsLightweight/.test(stageText) || !/stageLyricMeshCanServePayload\(stageLyrics\.current, lightweightPayload\)/.test(stageText)) {
    fail('songs that enter lyrics immediately must still use a bounded first paint before that root begins resident-row streaming');
  }
  if (!/function scheduleStageLyricFullTrackWarmup/.test(stageText) || !/stageLyricFullTrackWarmupTargetAt/.test(stageText) || !/scheduleStageLyricFullTrackWarmup\(restoreWarmup \? 'track-ready-fast' : 'lyrics-ready-preload', restoreWarmup \? 120 : 24\)/.test(lyricText)) {
    fail('lyrics must schedule full-track warmup as soon as a lyric response is parsed');
  }
  if (!/function requestStageLyricRestoreWarmup/.test(stageText) || !/function scheduleStageLyricRestorePrewarm/.test(stageText) || !/var restoreWarmup = typeof stageLyricRestoreWarmupSeconds === 'function'/.test(lyricText) || !/requestStageLyricRestoreWarmup\(restoreResumeAt, token, 'startup-restore'\)/.test(playbackText)) {
    fail('startup resume lyrics must prewarm around the restored playback time instead of rebuilding uneven chunks from the first line');
  }
  if (!/function clearStageLyricFullTrackWarmup/.test(stageText) || /function disposeStageLyricPrewarmMesh\(\)\s*\{[\s\S]{0,220}stageLyricFullTrackWarmupTimer/.test(stageText)) {
    fail('disposing a lightweight prewarm mesh must not cancel the pending full-track lyric warmup');
  }
  if (!/clampRange\(Number\(data\.lineWorldStep\) \|\| 0\.38, 0\.20, 0\.94\)/.test(stageText) || !/clampRange\(Number\(data\.lineWorldStep\) \|\| lyricMotion\.slide, 0\.20, 0\.94\)/.test(stageText) || !/clampRange\(Number\(data\.lineWorldStep\) \|\| 0\.38, 0\.20, 0\.94\)/.test(rowText)) {
    fail('multi-line lyric reuse and row-layer scrolling must keep the same line spacing clamp as mesh construction');
  }
  if (!/function lyricsAreFallbackTitleOnly/.test(lyricText) || !/var fallbackTitleOnly = lyricsAreFallbackTitleOnly\(lyricsLines\)/.test(lyricText) || !/if \(!fallbackTitleOnly && typeof scheduleStageLyricFullTrackWarmup === 'function'\)/.test(lyricText)) {
    fail('track-title fallback lyrics must not schedule a full multi-line track warmup before real lyrics arrive');
  }
  if (!/function resetLyricsForTrackSwitch/.test(lyricText) || !/function scheduleTrackSwitchFallbackLyrics/.test(lyricText) || !/multiLineDelay/.test(lyricText) || !/scheduleTrackSwitchFallbackLyrics\(song, token, 1500\)/.test(playbackText) || !/cancelPendingTrackFallbackLyrics\(\)/.test(lyricText)) {
    fail('track switches must delay title fallback lyrics so real lyrics do not trigger a double load');
  }
  if (!/var trackLightweight = false/.test(payloadText) || !/trackLightweight = input\.trackLightweight === true/.test(payloadText) || !/trackLightweight: trackLightweight/.test(payloadText)) {
    fail('stage lyric payload normalization must preserve lightweight track windows for stutter-free multi-line first paint');
  }
  if (!/var earlyLyricFetchStarted = false/.test(playbackText) || !/function startTrackLyricFetch/.test(playbackText) || !/if \(!earlyLyricFetchStarted\) fetchLyric\(song, token\)/.test(playbackText)) {
    fail('track switches must start lyric fetching in parallel with audio URL loading and avoid duplicate fetches');
  }
  if (/scheduleStageLyricPrewarm\('renderLyrics', 32\)[\s\S]{0,180}clearStageLyrics\(\)/.test(lyricText)) {
    fail('renderLyrics must not cancel its own lightweight stage lyric prewarm');
  }
  if (!/stageLyricFullTrackWarmupDelay/.test(stageText) || !/requestIdleCallback/.test(stageText) || !/lightweight-upgrade/.test(stageText)) {
    fail('multi-line full-track lyric warmup must be delayed, prefer idle time, and upgrade lightweight pages without repeated line-end postponement');
  }
  if (!/function stageLyricTextLoadInfo/.test(stageText) || !/function stageLyricPreferLightweightTrack/.test(stageText) || !/function stageLyricShouldSkipFullTrackWarmup/.test(stageText) || !/stageLyricPreferLightweightTrack\(\)\) return false;[\s\S]{0,120}return false;/.test(stageText) || !/if \(stageLyricShouldSkipFullTrackWarmup\(reason\)\) return false;/.test(stageText)) {
    fail('dense lyrics must use lightweight first paint only, then allow full-track warmup for steady scrolling');
  }
  if (!/requestStageLyricWarmup\('toggleLyricsPanel'/.test(lyricText) || !/scheduleStageLyricPrewarm\('toggleLyricsPanel', 48\)/.test(lyricText) || !/scheduleStageLyricFullTrackWarmup\('track-ready', 220\)/.test(lyricText)) {
    fail('manual lyric toggle must defer initial rendering and prewarm instead of building the full lyric mesh on the click frame');
  }
  if (!/requestStageLyricWarmup\('setParticleLyricsSilently'/.test(fxBindText) || !/scheduleStageLyricPrewarm\('setParticleLyricsSilently', 48\)/.test(fxBindText) || !/scheduleStageLyricFullTrackWarmup\('track-ready', 220\)/.test(fxBindText)) {
    fail('silent lyric activation must also use the warmup/prewarm path');
  }
  if (!/function scheduleQueueLyricPrefetch/.test(lyricText) || !/async function runQueueLyricPrefetch/.test(lyricText) || !/if \(audio && audio\.paused\) return false;/.test(lyricText) || /\/api\/(?:song\/url|qq\/song\/url|kugou\/song\/url|qishui\/song\/url|spotify\/song\/url)/.test(lyricText) || !/scheduleQueueLyricPrefetch\(idx, 2400\)/.test(playbackText)) {
    fail('queue lyric prefetch must stay isolated from audio URL switching and only run after playback is stable');
  }
  if (!/function shouldDeferStageLyricSyncBuild/.test(stageText) || !/showStageLine\(displayPayload, false, \{ noSyncBuild: true \}\)/.test(stageText)) {
    fail('long lyric page switches must not synchronously build a new mesh on the animation tick');
  }
  if (!/var singleLineBoundaryNoSyncBuild = options\.noSyncBuild && singleLinePayload && !redrawOnly && stageLyrics\.current;/.test(stageText) || !/if \(singleLineBoundaryNoSyncBuild\) \{[\s\S]{0,100}requestStageLyricDemandPrewarm\(payload\);[\s\S]{0,80}return false;[\s\S]{0,40}\}/.test(stageText)) {
    fail('single-line lyric sentence switches must not synchronously build a new mesh on the animation tick');
  }
  if (!/var lightweightFallback = buildStageLyricDisplayPayload\(newIdx, \{ lightweightTrack: true \}\)/.test(stageText) || !/displayPayload = lightweightFallback/.test(stageText)) {
    fail('long lyric page switches must fall back to a lightweight window when the full track page is not ready');
  }
  if (!/var track = options\.lightweightTrack\s*\? buildStageLyricMeshTrackEntries\(index, mode, options\)\s*:\s*buildStageLyricTrackEntries\(index, mode\)/.test(stageText)) {
    fail('triple and multi-line lyrics must use the full-song track cache after the lightweight first-paint path');
  }
  if (!/var multiLineLoad = stageLyricMultiLineWarmupLoad\(\)/.test(stageText) || !/if \(payload\.trackLightweight\) return false;/.test(stageText) || !/if \(!multiLineLoad && lyricsLines\.length < 24\) return false;/.test(stageText) || !/if \(options\.noSyncBuild\) \{[\s\S]{0,100}requestStageLyricDemandPrewarm\(payload\);[\s\S]{0,60}return false;/.test(stageText) || /allowLightweightSyncBuild/.test(stageText)) {
    fail('multi-line lyrics must defer both lightweight and full mesh builds off the animation tick');
  }
  if (!/function beginLyricRowLayerGroupBuild/.test(rowText) || !/function appendLyricRowLayerBuildPhase/.test(rowText) || !/function stepLyricRowLayerGroupBuild/.test(rowText) || !/function beginCooperativeLyricMeshBuild/.test(meshText) || !/function stepCooperativeLyricMeshBuild/.test(meshText) || !/stepCooperativeLyricMeshBuild\(job\.state, 1, 4\.2\)/.test(stageText) || !/stageLyricPrewarm\.workTimer/.test(stageText)) {
    fail('multi-line lyric meshes must be built cooperatively in bounded row sub-phases');
  }
  if (!/function beginLyricReadabilityTextureBuild/.test(maskText) || !/function stepLyricReadabilityTextureBuild/.test(maskText) || !/LYRIC_READABILITY_BUILD_PHASES = 4/.test(maskText) || !/function beginLyricGlowTextureBuild/.test(maskText) || !/function stepLyricGlowTextureBuild/.test(maskText) || !/LYRIC_GLOW_BUILD_PHASES = 12/.test(maskText) || !/row-readability-/.test(rowText) || !/row-glow-/.test(rowText)) {
    fail('lyric readability and glow textures must remain split into cooperative drawing sub-phases');
  }
  if (!/function beginLyricMaskLayoutMetricsBuild/.test(maskText) || !/function stepLyricMaskLayoutMetricsBuild/.test(maskText) || !/function finishLyricMaskLayoutMetricsBuild/.test(maskText) || !/beginLyricMaskLayoutMetricsBuild\(payload \|\| text\)/.test(meshText) || !/stepLyricMaskLayoutMetricsBuild\(state\.layoutState, 1\)/.test(meshText) || !/function lyricRowLayerBundleActiveMask/.test(meshText) || !/lyricRowLayerBundleActiveMask\(preparedRowLayerBundle\)/.test(meshText)) {
    fail('cooperative multi-line lyrics must measure layout without drawing an unused full-window texture and reuse the active row mask');
  }
  if (!/function lyricTextureClarityScale/.test(maskText) || !/lyricTextureClarity/.test(maskText + stageText) || !/function lyricRowTextureWidthBudget/.test(maskText) || !/function compactLyricLineMaskTexture/.test(maskText) || !/renderer\.domElement\.width/.test(maskText) || !/profile && profile\.lowSpec/.test(maskText) || !/mask\.rasterScale/.test(maskText) || !/compactLyricLineMaskTexture\(makeLyricMask/.test(rowText) || !/var glowRaster = lyricGlowRasterMetrics\(row\.lineMask\);[\s\S]{0,420}beginLyricGlowTextureBuild\([\s\S]{0,360}null,\s*glowRaster\.scale\);/.test(rowText) || !/pixelScale/.test(maskText)) {
    fail('row lyric textures must scale to the physical render width and preserve glow/readability proportions');
  }
  if (!/var lyricTextMeasureCache/.test(fontText) || !/function lyricMeasuredCharacterWidth/.test(fontText) || !/fontKerning/.test(fontText) || !/probeSpacing = 0\.001/.test(fontText) || !/function scheduleLyricTextMeasureWarmup/.test(fontText) || !/requestIdleCallback/.test(fontText) || !/layoutMeasureBaseSize:\s*128/.test(maskText) || !/layoutBaseWidthCache/.test(maskText) || !/function measureWidestAtSize/.test(maskText) || !/estimatedFont/.test(maskText)) {
    fail('lyric font fitting must keep bounded character-width caching and coarse-to-exact size selection');
  }
  if (!/function scheduleStageLyricCooperativeWork/.test(stageText) || !/stageLyricPrewarm\.workRaf/.test(stageText) || !/requestAnimationFrame\(function \(\)/.test(stageText) || !/function stageLyricShouldYieldToPendingInput/.test(stageText) || !/isInputPending/.test(stageText)) {
    fail('lyric cooperative work must run after a rendered frame and yield to pending continuous input');
  }
  if (!/var stageLyricResidentBuild = \{ job: null, timer: 0, raf: 0, token: 0 \}/.test(stageText) || !/function startStageLyricResidentBuild/.test(stageText) || !/function ensureStageLyricPersistentTrackRows/.test(stageText) || !/function mergeStageLyricResidentBundle/.test(stageText) || !/function trimStageLyricPersistentTrackRows/.test(stageText) || !/stageLyrics\.current !== job\.mesh/.test(stageText)) {
    fail('multi-line lyrics must stream bounded resident rows into one persistent root with a single cancellable build job');
  }
  if (!/function stageLyricPersistentTargetRowsReady/.test(stageText) || !/function stageLyricPersistentTargetEffectsReady/.test(stageText) || !/function commitStageLyricPersistentPendingTarget/.test(stageText) || !/pending target committed before upload/.test(fs.readFileSync(__filename, 'utf8')) || !/d\.trackPendingProgress =/.test(meshText) || !/pendingWindowAllowed/.test(rowText)) {
    fail('seek targets must stay pending until every visible primary and translation text row is resident and uploaded');
  }
  if (!/function cancelLyricRowLayerGroupBuild/.test(rowText) || !/releaseLyricRowLayerBuildCanvas/.test(rowText) || !/function scheduleStageLyricResidentDemand/.test(stageText) || !/stageLyricProgressPreviewActive\(\)/.test(stageText) || !/coalescedOptions\.urgent = false/.test(stageText) || !/trackTextOnly/.test(rowText + stageText) || !/stageLyricShouldYieldToPendingInput\(\) && !job\.interactive && !job\.textOnly/.test(stageText) || !/lyricCustomLineCount = 10/.test(fs.readFileSync(__filename, 'utf8'))) {
    fail('continuous seek previews must coalesce demand while letting the final text-only window make bounded progress through pending input');
  }
  if (!/stageLyricTrackGeneration \+= 1/.test(stageText) || !/songKey,\s*stageLyricTrackGeneration/.test(stageText)) {
    fail('lyric track identity must change when refreshed lyrics alter a middle line');
  }
  if (!/function refreshStageLyricDisplayMode\(\) \{\s*refreshCurrentLyricStyle\(\);\s*\}/.test(lyricActionsText) || !/buildStageLyricDisplayPayload\(stageLyrics\.currentIdx, \{ lightweightTrack: true \}\)/.test(stageText)) {
    fail('lyric display mode changes must rebuild from a lightweight payload instead of synchronously constructing the whole song');
  }
  if (/renderer\.initTexture/.test(maskText + rowText + meshText + stageText)) {
    fail('lyric texture prewarm must not force synchronous GPU uploads with renderer.initTexture');
  }
  if (!/var lyricDisposeQueue = \[\]/.test(starRiverText) || !/function flushLyricDisposeQueue/.test(starRiverText) || !/processed < 12/.test(starRiverText)) {
    fail('lyric mesh disposal must stay split into bounded background chunks');
  }
  if (!/mesh\.visible = false/.test(rowText) || !/readability\.visible = false/.test(rowText) || !/renderRevealAt/.test(rowText) || !/renderLineUploaded/.test(rowText) || !/renderReadabilityUploaded/.test(rowText) || !/renderGlowUploaded/.test(rowText) || !/var renderRevealCandidates = \[\]/.test(rowText) || !/renderRevealCandidates\.sort/.test(rowText) || !/function resetLyricRenderUploadFrameBudget/.test(rowText) || !/function consumeLyricRenderUploadFrameBudget/.test(rowText) || !/if \(!consumeLyricRenderUploadFrameBudget\(\)\) break/.test(rowText) || !/resetLyricRenderUploadFrameBudget\(true\)/.test(stageText) || !/__mineradioLyricUploadBudgetStats/.test(rowText) || !/row\.mesh\.visible = lineLayerVisible/.test(rowText) || !/row\.glow\.visible = glowLayerVisible/.test(rowText)) {
    fail('all lyric meshes in a rendered frame must share one texture-upload token instead of each receiving a local budget');
  }
  if (!/var persistentTrackTransparentPrewarm =/.test(rowText) || !/data\.trackPersistent/.test(rowText) || !/transparentPrewarm: true/.test(rowText) || !/priority: 300 \+ trackPrewarmOrder/.test(rowText) || !/priority: 400 \+ trackPrewarmOrder/.test(rowText) || !/priority: 500 \+ trackPrewarmOrder/.test(rowText)) {
    fail('resident rows in the persistent lyric root must prewarm text, readability, and glow transparently before entering view');
  }
  if (!/function stageLyricPersistentLineEffectsResident/.test(stageText) || !/persistent-track-visible-effects/.test(stageText) || !/textOnly: true/.test(stageText) || !/maxOffset \+ \(interactivePreview \? 10 : 24\)/.test(stageText) || !/existingRow\.readability = row\.readability/.test(stageText) || !/existingRow\.glow = row\.glow/.test(stageText)) {
    fail('persistent lyrics must build a long text-only runway first and enrich only the visible rows with effects');
  }
  if (!/mask\.logicalFontSize/.test(maskText) || !/mask\.logicalWidth/.test(maskText) || !/function lyricRowLogicalWorldWidth/.test(rowText) || !/baseMask\.logicalFontSize \|\| baseMask\.fontSize/.test(rowText) || !/layoutMask\.logicalFontSize/.test(stageText) || !/var scaleDistance = motionAnchor \? 0 : visibilityAbs/.test(rowText) || !/stableMotionIndex/.test(rowText)) {
    fail('resident lyric raster compaction and wide canvases must preserve a stable logical font size and active-row scale');
  }
  if (!/function lyricViewportFitRatio/.test(rowText) || !/function lyricRowLiveViewportScale/.test(rowText) || !/Math\.min\(leftSpace, rightSpace\) \* 2/.test(rowText) || !/row\.mesh\.localToWorld\(lyricViewportFitLeft\)/.test(rowText) || !/lyricViewportFitLeft\.project\(camera\)/.test(rowText) || !/renderWindowActive && \(!fx \|\| fx\.lyricLiveViewportFit !== false\)/.test(rowText) || !/baseScale \*= lyricRowLiveViewportScale\(row, baseScale\)/.test(rowText) || /lyricLongLineDefaultScale|longLineScale|1380\s*\//.test(rowText)) {
    fail('when enabled, original and translated long lyrics must fit the live left/right viewport space without fixed-width hard compression');
  }
  if (!/var frameScale =/.test(rowText) || !/1 - Math\.pow\(1 - baseTrackEase, frameScale\)/.test(rowText) || !/deltaTime: dt/.test(stageText)) {
    fail('lyric scroll easing must keep the same timing across display frame rates');
  }
  if (/stageLyricBeginPreparedTrackTexturePrewarm|stageLyricPreparedTrackTextReady|warmPreparedStageLyricTrackTextures|full-track-textures-ready/.test(stageText) || !/data\.trackPendingPayload = payload/.test(meshText) || !/ensureStageLyricPersistentTrackRows\(mesh, targetLineIndex/.test(meshText) || !/return true;[\s\S]{0,120}data\.trackPendingPayload = null/.test(meshText)) {
    fail('same-song lyric demand must stay on the persistent root and must not wait for a later whole-track takeover');
  }
  if (!/renderInitialTextReady/.test(rowText + meshText) || !/initialTextRowsReady/.test(rowText) || !/initialTextRevealPending \? 0/.test(rowText) || !/lineUploadPrewarm/.test(rowText) || !/revealPrewarmMaxOffset \+ 1/.test(rowText) || !/motionAnchor \|\| row\.renderLineUploaded \? 0/.test(rowText) || !/priority: 100 \+/.test(rowText) || !/priority: 200 \+/.test(rowText)) {
    fail('multi-line lyric rows must upload all visible text before revealing readability or glow layers as one coherent block');
  }
  if (!/function stageLyricShouldHoldOutgoingForReveal/.test(stageText) || !/lyricRevealSuccessor/.test(stageText) || !/stageLyricTrackRevealReady\(revealSuccessor\)/.test(stageText) || !/if \(holdingForLyricReveal\) return true/.test(stageText)) {
    fail('same-track lyric page and lightweight/full handoffs must retain the outgoing lyrics until the incoming text block is ready');
  }
  if (/track-demand\|track-boundary-next\|track-boundary-prev/.test(stageText) || !/trackLightweight/.test(stageText + rowText + meshText)) {
    fail('long lyric boundary/demand prewarm must use full track windows and distinguish light/full meshes');
  }
  if (!/if \(!payload\.trackLightweight && data\.trackLightweight\) return false;/.test(stageText) || !/if \(!data\.trackPersistent && !payload\.trackLightweight && data\.trackLightweight\) return false;/.test(meshText)) {
    fail('only the persistent track root may reuse its bounded bootstrap mesh for later same-song lines');
  }
  if (!/function lyricTranslationMeshScale/.test(rowText) || !/fontScale: fontScale/.test(rowText) || !/scale: primaryLine \? 1 : \(entry\.scale \|\| lyricTranslationScaleValue\(\)\)/.test(rowText)) {
    fail('translation font-size control must affect translation row texture scale and mesh scale');
  }
  if (!/rowGlowPad/.test(rowText) || /glowTargetScale = row\.mesh \? row\.mesh\.scale\.x \* \(1\.0 \+ rowGlowBeat/.test(rowText)) {
    fail('row lyric glow must feather outside the text while staying locked to the lyric mesh scale during beat pulses');
  }
  if (!/function lyricKaraokeWordRanges/.test(stageText) || !/lyricMeasureTextAtSize\(ctx, text\.slice\(0, c0\)/.test(stageText) || !/mesh\.userData\.nativeKaraokeProgress/.test(stageText) || !/updateLyricMeshProgress\(stageLyrics\.current, progress, \{ nativeKaraoke: lyricLineHasNativeKaraoke\(curLine\) \}\)/.test(stageText)) {
    fail('native YRC karaoke highlight must follow word timing and measured word width without smoothed line-level lag');
  }
  if (!/function retireCurrentStageLyricForIdle/.test(stageText) || !/pausedWithTrack/.test(stageText) || !/if \(pausedWithTrack\) \{[\s\S]{0,360}return;[\s\S]{0,120}retireCurrentStageLyricForIdle\(\)/.test(stageText)) {
    fail('paused playback must keep the current lyric mesh instead of retiring it after a few seconds');
  }
  if (!/function resetFrameGate/.test(schedulerText) || !/function markStageLyricsPlaybackResume/.test(stageText) || !/resetFrameGate\(mainFrameGates\.lyricsParticles/.test(stageText) || !/markStageLyricsPlaybackResume\(reason \|\| 'playback-started'\)/.test(controlsText) || !/markStageLyricsPlaybackResume\(reason\)/.test(switchText)) {
    fail('lyric playback resume must clear frame-gate backlog and reuse the smooth paused lyric state');
  }
  const resumeStart = stageText.indexOf('function markStageLyricsPlaybackResume(reason)');
  const resumeEnd = stageText.indexOf('function tickLyricsParticles', resumeStart);
  const resumeBody = resumeStart >= 0 && resumeEnd > resumeStart ? stageText.slice(resumeStart, resumeEnd) : '';
  if (
    !/function stageLyricCurrentCanResumeWithoutWarmup/.test(stageText) ||
    !/function stageLyricCurrentUsesLightweightTrack/.test(stageText) ||
    !/stageLyricResumeWarmupLastAt/.test(stageText) ||
    !/stageLyricResumeUpgradeDeferUntil/.test(stageText) ||
    !/Number\(stageLyricResumeUpgradeDeferUntil\)/.test(stageText) ||
    !/canResumeWithoutWarmup[\s\S]{0,180}resetStageLyricResumeFrameGates\(\);[\s\S]{0,80}return;/.test(resumeBody) ||
    !/requestStageLyricLightweightUpgrade\(reason, 520\)/.test(resumeBody) ||
    /upgradeCurrentStageLyricFromPreparedTrack/.test(resumeBody)
  ) {
    fail('pause/resume must reuse the current lyric mesh and defer heavy lyric upgrades off the input frame');
  }
  if (
    !/function canResumePausedAudioFast/.test(controlsText) ||
    !/function resumePausedAudioFast/.test(controlsText) ||
    !/function schedulePausedAudioResumeMaintenance/.test(controlsText) ||
    // The span between the fast-resume shortcut and the audio-graph health check
    // is allowed to grow: it now also carries the "wait for canplay after a track
    // switch" step. The anchors are what matter, not the exact character count.
    !/var fastResume = await resumePausedAudioFast\(opts\);[\s\S]{0,80}if \(fastResume === true\) return true;[\s\S]{0,400}if \(!audioGraphHealthy\(\)\) initAudio\(\);/.test(controlsText) ||
    !/restorePlaybackGain\(\);[\s\S]{0,120}await awaitMediaPlayWithTimeout\(media, media\.play\(\), token\);/.test(controlsText) ||
    !/setTimeout\(async function \(\) \{[\s\S]{0,240}ensurePlaybackAudioGraph\(\(reason \|\| 'manual-resume-fast'\) \+ '-deferred-graph'\)/.test(controlsText)
  ) {
    fail('space/button pause resume must use a fast paused-audio path and defer graph maintenance off the input frame');
  }
  console.log('[OK] Lyric scrolling keeps one persistent whole-song text runway, bounded effect layers, realtime continuous drag, and warm lyric activation.');
}

function checkPersistentCacheStorageGuard() {
  logStep('Persistent cache storage guard');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const lyricText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const cacheUiText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '08-cache-storage-settings.js'), 'utf8');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const setNameAt = mainText.indexOf('app.setName(APP_NAME)');
  const firstUserDataLookupAt = mainText.indexOf("app.getPath('appData')");
  if (!/const CACHE_SETTINGS_FILE/.test(mainText) || !/const LYRIC_CACHE_MAX_BYTES = 96 \* 1024 \* 1024/.test(mainText) || !/function defaultCacheRootPath\(\)/.test(mainText) || setNameAt < 0 || firstUserDataLookupAt < 0 || setNameAt > firstUserDataLookupAt || !/const STABLE_USER_DATA_PATH = resolveStableUserDataPath\(\)/.test(mainText) || !/app\.setPath\('userData', STABLE_USER_DATA_PATH\)/.test(mainText) || !/app\.setPath\('sessionData', chromiumSessionDataPath\(cacheSettings\)\)/.test(mainText) || !/const currentChromiumPath = app\.getPath\('sessionData'\)/.test(mainText) || !/MINERADIO_BEAT_CACHE_DIR = cacheSettings\.beatmapsPath/.test(mainText) || !/nativePath:\s*path\.join\(rootPath, 'native-helper-temp'\)/.test(mainText) || !/const NATIVE_HELPER_TEMP_PATH = INITIAL_CACHE_SETTINGS\.nativePath/.test(mainText) || !/activeWallpaperEnginePath/.test(mainText) || !/wallpaperEngineBytes/.test(mainText)) {
    fail('desktop cache settings must keep app-owned userData stable and route Chromium sessionData plus beatmaps to the configurable cache root');
  }
  // 便携化守卫：数据根必须落在软件目录内，缓存根不得再指向盘符根目录。
  // Portability guard: the data root must sit inside the app folder and the cache root must
  // never point at a drive root again.
  const cacheRootBody = (mainText.match(/function defaultCacheRootPath\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  if (!/const PORTABLE_USER_DATA_PATH = path\.join\(APP_ROOT_PATH, 'userdata'\)/.test(mainText)
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
  const nativeTempCallers = ['app-memory.js', 'system-memory.js', 'wallpaper-engine-runtime.js', 'desktop-native-icon-layer-runtime.js']
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
  if (!/mineradio-cache-get-settings/.test(mainText) || !/mineradio-cache-set-settings/.test(mainText) || !/mineradio-cache-read-lyric/.test(mainText) || !/mineradio-cache-write-lyric/.test(mainText) || !/crypto\.createHash\('sha256'\)/.test(mainText) || !/pruneLyricCache/.test(mainText)) {
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
    || !/openUpdateDownloadSource/.test(updateUiText)
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

function checkLyricTranslationCompletenessGuard() {
  logStep('Netease lyric translation guard');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const lyricText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  if (!/lyricBodyHasTranslation/.test(serverText) || !/mergeLyricBodies/.test(serverText) || !/ytlrc/.test(serverText)) {
    fail('server /api/lyric must merge legacy lyric translations and return ytlrc');
  }
  if (!/buildLyricTranslationPayload/.test(lyricText) || !/response\.ytlrc/.test(lyricText) || !/translationMatch/.test(lyricText) || !/lyricTranslationTextFromAliases/.test(lyricText) || !/source\.trans/.test(lyricText) || !/hasInterleavedText/.test(lyricText)) {
    fail('frontend lyric parser must merge tlyric/trans/ytlrc and keep order fallback metadata');
  }
  if (!/isLyricCreditLineText/.test(lyricText) || !/orderedPrimaryIndexes/.test(lyricText)) {
    fail('frontend lyric parser must skip singer/credit lines when attaching translated lyrics');
  }
  if (!/function scheduleNeteaseLyricTranslationFallback/.test(lyricText) || !/function findNeteaseLyricFallbackCandidate/.test(lyricText) || !/songProviderKey\(song\) === 'netease'/.test(lyricText) || !/requestIdleCallback/.test(lyricText) || !/mergeInlineLyricResponseForSong/.test(lyricText)) {
    fail('non-Netease providers must asynchronously reuse the Netease translation merge path without blocking primary lyric paint');
  }
  console.log('[OK] Netease tlyric/ytlrc translation merge is guarded.');
}

function checkLyricVerticalFloatToggleGuard() {
  logStep('Lyric vertical float toggle guard');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const persistenceText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const panelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const bindingText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const stageText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const rowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js'), 'utf8');
  if (!/lyricVerticalFloat:\s*true/.test(defaultsText) || !/id="t-lyricVerticalFloat"/.test(htmlText) || !/toggleFx\('lyricVerticalFloat'\)/.test(htmlText)) {
    fail('lyric vertical float toggle must exist in defaults and UI');
  }
  if (!/lyricVerticalFloat: raw\.lyricVerticalFloat !== false/.test(persistenceText) || !/lyricVerticalFloat: fx\.lyricVerticalFloat !== false/.test(persistenceText) || !/'lyricVerticalFloat'/.test(archiveText)) {
    fail('lyric vertical float toggle must persist through autosave and preset archive');
  }
  if (!/t-lyricVerticalFloat/.test(panelText) || !/key === 'lyricVerticalFloat'/.test(bindingText) || !/bind_lyrics_float_on/.test(bindingText) || !/bind_lyrics_float_off/.test(bindingText)) {
    fail('lyric vertical float toggle must sync panel state and show toggle feedback');
  }
  requireLocaleKeys('bind_lyrics_float_on', 'bind_lyrics_float_off');
  if (!/function lyricVerticalFloatEnabled/.test(stageText) || !/var lyricFloatAmp = verticalFloatOn \?/.test(stageText) || !/style === 'float' && verticalFloatOn/.test(stageText)) {
    fail('stage lyric renderer must gate vertical float/breathing on the toggle');
  }
  if (!/var previewMotionLock = opts\.previewMotionLock === true/.test(rowText) || !/var verticalFloatOn = !previewMotionLock/.test(rowText) || !/motionAnchor \|\| !verticalFloatOn/.test(rowText) || !/var rowDrift = previewMotionLock \? 0 :/.test(rowText) || !/verticalFloatOn \? \(isActive \? jitterY/.test(rowText)) {
    fail('row lyric layers must also stop vertical jitter when the toggle is off');
  }
  console.log('[OK] Lyric vertical float toggle is wired through UI, persistence, archive, and render layers.');
}

function checkCustomSourceGuard() {
  logStep('LX custom source guard');
  const hostDir = path.join(appRoot, 'desktop', 'custom-source');
  const hostFiles = ['protocol.js', 'store.js', 'runtime.js', 'runtime-preload.js', 'manager.js', 'music-info.js', 'redact.js', 'runtime.html'];
  for (const file of hostFiles) {
    if (!fs.existsSync(path.join(hostDir, file))) fail(`自定义音源宿主缺少 ${file}`);
  }
  const protocolText = fs.readFileSync(path.join(hostDir, 'protocol.js'), 'utf8');
  const storeText = fs.readFileSync(path.join(hostDir, 'store.js'), 'utf8');
  const runtimeText = fs.readFileSync(path.join(hostDir, 'runtime.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(hostDir, 'runtime-preload.js'), 'utf8');
  const managerText = fs.readFileSync(path.join(hostDir, 'manager.js'), 'utf8');
  const musicInfoText = fs.readFileSync(path.join(hostDir, 'music-info.js'), 'utf8');
  const runtimeHtmlText = fs.readFileSync(path.join(hostDir, 'runtime.html'), 'utf8');
  const desktopMainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const desktopPreloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const customModuleText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '20-custom-source.js'), 'utf8');
  const startAudioText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const fallbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js'), 'utf8');
  const indexLoaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const gitignoreText = fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8');

  // 脚本必须跑在锁定过的沙箱文档里：没有网络、没有图片、没有样式、只有 eval 一层。
  // The script must run inside a locked-down document: no network, no images, no styles.
  if (!/default-src 'none'/.test(runtimeHtmlText) || !/connect-src 'none'/.test(runtimeHtmlText) || !/img-src 'none'/.test(runtimeHtmlText)) {
    fail('自定义音源运行文档必须自带严格 CSP');
  }
  for (const flag of ['nodeIntegration: false', 'nodeIntegrationInWorker: false', 'contextIsolation: true', 'sandbox: true', 'webviewTag: false']) {
    if (!runtimeText.includes(flag)) fail(`自定义音源运行环境缺少隔离项 ${flag}`);
  }
  if (!/partition: `mineradio-lx-\$\{this\.runtimeId\}`/.test(runtimeText)) {
    fail('每次脚本运行必须使用独立的内存 partition，不能共用主窗口会话');
  }
  if (!/setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/.test(runtimeText)) {
    fail('自定义音源运行环境必须拒绝全部权限申请');
  }
  if (!/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/.test(runtimeText)) {
    fail('自定义音源运行环境必须拒绝打开新窗口');
  }
  if (!/for \(const eventName of \['will-navigate', 'will-redirect', 'will-attach-webview'\]\)/.test(runtimeText)) {
    fail('自定义音源运行环境必须拦住导航与 webview 挂载');
  }
  if (!/session\.on\('will-download'/.test(runtimeText)) fail('自定义音源运行环境必须拒绝下载');
  if (!/event\.sender\?\.id === runtime\.window\.webContents\.id/.test(runtimeText)) {
    fail('每条音源 IPC 都必须校验发送方 webContents');
  }

  // preload 只能暴露 globalThis.lx 这一个面，绝不能把 ipcRenderer 本体递出去。
  // The preload may only expose globalThis.lx; it must never hand out raw ipcRenderer.
  if (!/contextBridge\.exposeInMainWorld\('lx', \{/.test(preloadText)) fail('音源 preload 必须只暴露 globalThis.lx');
  if (/exposeInMainWorld\((?!'lx')/.test(preloadText)) fail('音源 preload 暴露了 lx 之外的全局对象');
  if (!/webFrame\.executeJavaScript/.test(preloadText)) fail('音源脚本必须在页面主世界执行');

  // 脚本请求不得携带 Mineradio 自己的凭据：宿主不读 cookie 文件、不引入任何平台 API 模块。
  // Script requests must not carry Mineradio credentials: the host reads no cookie file and
  // imports no platform API module.
  // 注释里提到 Cookie 是在解释隔离边界，所以先剥注释再查真实用法。
  // Comments mention cookies to explain the isolation boundary, so strip comments first
  // and only then look for real usage.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const [name, text] of [['runtime.js', runtimeText], ['runtime-preload.js', preloadText], ['manager.js', managerText]]) {
    const code = stripComments(text);
    if (/cookie/i.test(code)) fail(`${name} 不应接触任何 Cookie`);
    if (/require\(['"][^'"]*-api(\.js)?['"]\)/.test(code)) fail(`${name} 不应引入平台 API 模块`);
    if (/DEFAULT_QQ_COOKIE_FILE|DEFAULT_COOKIE_FILE|qishui-auth|kugou-api/.test(code)) fail(`${name} 引用了平台登录态资源`);
  }
  if (!/redactSecrets/.test(runtimeText)) fail('自定义音源日志必须先脱敏');
  if (!/redactSecrets\(data\)/.test(runtimeText) || !/redactSecrets\(\{\s*\n?\s*message/.test(runtimeText)) {
    fail('updateAlert 与错误日志都必须经过脱敏');
  }

  // 脚本落盘位置必须在 Electron userData 下，不能落在项目目录里。
  // Scripts live under Electron userData and never inside the project tree.
  if (!/new CustomSourceStore\(path\.join\(dataPath, 'custom-sources'\)\)/.test(managerText)) {
    fail('脚本仓库必须落在 userData 的独立目录里');
  }
  if (!/userDataPath: app\.getPath\('userData'\)/.test(desktopMainText)) {
    fail('主进程必须把 userData 路径交给音源总控');
  }
  if (!/isSafeScriptId/.test(storeText) || !/!value\.includes\('\\\\'\)/.test(storeText)) {
    fail('脚本 id 必须挡住路径分隔符，避免越出脚本目录');
  }
  if (!/custom-sources\//.test(gitignoreText)) {
    fail('.gitignore 必须挡住可能被误放进仓库的 custom-sources 数据目录');
  }

  // 播放策略：脚本对该平台没有主张时必须交回内置接口。
  // Playback policy: an undeclared platform must hand back to the built-in path.
  if (!/result\.handled !== true\) return 'builtin'/.test(protocolText)) {
    fail('customSourcePolicy 必须尊重 handled，否则未声明的平台会直接不可播');
  }
  if (!/handled: false, reason: 'source_unsupported'/.test(managerText)) {
    fail('总控必须把未支持平台标记为 handled:false');
  }
  if (!/provider: 'lx-custom-source'/.test(managerText) || !/source: 'lx-custom-source'/.test(managerText)) {
    fail('解析结果必须标清地址来自自定义音源');
  }
  if (!/throw new Error\('SOURCE_UNSUPPORTED: Unknown Mineradio provider'\)/.test(musicInfoText)) {
    fail('歌曲映射必须对不支持的平台显式报错');
  }

  // 前端接线：内置分发整体退到 if (!data) 之内，自定义源不与内置接口竞速。
  // Frontend wiring: the built-in dispatch sits inside `if (!data)`, so nothing races.
  if (!/if \(!data\) \{\s*\n\s*if \(isQQPlayback\)/.test(startAudioText)) {
    fail('内置平台分发必须退到 if (!data) 之内，否则自定义源会与内置接口同时发请求');
  }
  if (!/data = await resolveCustomSourcePlaybackData\(song, requestedQuality\)/.test(startAudioText)) {
    fail('播放链路没有接入自定义源解析');
  }
  if (!/qualityDowngraded && !customSourcePlayback\) markPlaybackQualityRuntimeCap\(/.test(startAudioText)) {
    fail('脚本的音质上限不能写成平台的运行时音质上限');
  }
  if (!/customSourceState\.loaded && !customSourceState\.items\.length/.test(customModuleText)) {
    fail('确认没有启用脚本时必须跳过本地请求');
  }
  const activeBranch = fallbackText.indexOf('if (data.active === true) {');
  const vipBranch = fallbackText.indexOf("if (category === 'vip_required' || category === 'paid_required'");
  if (activeBranch < 0 || vipBranch < 0 || activeBranch > vipBranch) {
    fail('自定义源失败必须排在会员/登录分支之前，否则脚本超时会被说成需要会员');
  }

  if (!indexLoaderText.includes("'js/modules/05-playback/20-custom-source.js'")) {
    fail('index-loader 未注册自定义音源模块');
  }
  if (!indexText.includes('id="custom-source-btn"') || !indexText.includes('id="custom-source-modal"')) {
    fail('index.html 缺少自定义音源入口或设置面板');
  }
  if (!indexText.includes('data-i18n="custom_source_warning"')) {
    fail('第三方脚本风险提示必须可见且走 i18n');
  }
  if (!cssText.includes('.custom-source-dialog')) fail('缺少自定义音源面板样式');

  for (const channel of [
    'mineradio-custom-source-list',
    'mineradio-custom-source-import',
    'mineradio-custom-source-replace',
    'mineradio-custom-source-activate',
    'mineradio-custom-source-deactivate',
    'mineradio-custom-source-remove',
    'mineradio-custom-source-set-update-alert',
  ]) {
    if (!desktopMainText.includes(`'${channel}'`)) fail(`主进程未注册 ${channel}`);
    if (!desktopPreloadText.includes(`'${channel}'`)) fail(`preload 未转发 ${channel}`);
  }
  // 「真代码里有 X」这类断言一律先剥注释再匹配：注释掉的痕迹不该算数，
  // 否则守卫就是永真的（把代码注释掉它照样绿）。
  // Presence checks match against comment-stripped source; a commented-out trace must not
  // count, otherwise the guard is unfalsifiable — commenting the code out still passes.
  const mainCode = stripComments(desktopMainText);
  if (!mainCode.includes('CUSTOM_SOURCE_UNAUTHORIZED')) fail('主进程必须校验音源 IPC 的发送方');
  if (!mainCode.includes('await initializeCustomSourceManager();')) fail('启动时没有恢复已启用的音源');
  // ensureLocalServerStarted() 会重新 require server/server.js，新模块实例上的 resolver
  // 必须重新注入，否则崩溃恢复后自定义音源静默失效。
  // ensureLocalServerStarted() re-requires server/server.js, so the resolver on the fresh module
  // instance must be re-injected or custom sources silently die after a recovery.
  {
    const callSite = /await ensureLocalServerStarted\(\);\n([\s\S]{0,600}?)await loadMainWindowWithRetry\(win\);/g;
    const gaps = [];
    let match;
    while ((match = callSite.exec(mainCode)) !== null) gaps.push(match[1]);
    if (gaps.length < 2) fail('未覆盖「首次启动」与「崩溃恢复」两条服务器启动路径');
    for (const gap of gaps) {
      if (!gap.includes('await initializeCustomSourceManager();')) fail('服务器启动之后没有重新注入自定义音源解析器');
    }
  }
  if (!/server\.setCustomSourceResolver = resolver =>/.test(serverText)) fail('server.js 缺少自定义源解析器注入点');
  if (!/pn === '\/api\/custom-source\/resolve'/.test(serverText)) fail('server.js 缺少自定义源解析路由');
  if (!/controller\.abort\(new Error\('REQUEST_ABORTED'\)\)/.test(serverText)) fail('解析路由必须把取消信号传下去');

  // 词典语言列表从 i18n 模块推导，而不是写死：写死的列表会让新接入的语言绕过
  // 这条守卫，而绕过的后果恰好是它本该拦住的静默回退。
  // The dictionary language list is derived from the i18n module instead of being
  // hardcoded: a hardcoded list lets a newly wired language slip past this guard, and
  // slipping past is exactly the silent fallback it exists to catch.
  const i18nText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '13-i18n.js'), 'utf8');
  const langMatch = /var SUPPORTED_LANGS = \[([^\]]*)\]/.exec(i18nText);
  if (!langMatch) fail('无法从 i18n 模块解析出 SUPPORTED_LANGS');
  const localeLangs = langMatch[1].split(',').map(entry => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (localeLangs.length < 2) fail('SUPPORTED_LANGS 至少应包含默认语言与一种外语');
  for (const lang of localeLangs) {
    const dict = JSON.parse(fs.readFileSync(path.join(appRoot, 'public', 'locales', `${lang}.json`), 'utf8'));
    for (const key of ['btn_custom_source', 'custom_source_title', 'custom_source_warning', 'custom_source_unavailable_title']) {
      if (!Object.prototype.hasOwnProperty.call(dict, key)) fail(`${lang}.json 缺少 ${key}`);
    }
  }
  console.log(`[OK] LX custom source host is sandboxed, opt-in, and never races the built-in providers.`);
}

function checkQishuiProviderGuard() {
  logStep('Qishui provider guard');
  const qishuiText = fs.readFileSync(path.join(appRoot, 'server', 'qishui-api.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const playlistShellText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
  const playlistDetailText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const playlistLoadText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');
  const shelfCoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const shelfContentText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '03-content-list-manager.js'), 'utf8');
  const homeText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03-home-discover-weather.js'), 'utf8');
  const qishuiLoginText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'), 'utf8');
  const qishuiStatusText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
  const accountLogoutText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'), 'utf8');
  const desktopMainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const desktopPreloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const qishuiPassportText = fs.readFileSync(path.join(appRoot, 'server', 'qishui-auth-v6.js'), 'utf8');
  const qishuiQrBridgeText = fs.readFileSync(path.join(appRoot, 'server', 'qishui-qr-login.js'), 'utf8');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  if (!/QISHUI_PUBLIC_SEARCH_URL/.test(qishuiText) || !/api-vehicle\.volcengine\.com\/v2\/search\/type/.test(qishuiText) || !/function handleQishuiPublicSearch/.test(qishuiText)) {
    fail('Qishui must keep a public search fallback so the provider is usable before OAuth credentials are bundled');
  }
  if (!/QISHUI_PUBLIC_CONTENTS_URL/.test(qishuiText) || !/api-vehicle\.volcengine\.com\/v2\/custom\/contents/.test(qishuiText) || !/function fetchQishuiPublicDetail/.test(qishuiText)) {
    fail('Qishui lyric/detail fallback must stay available for public search results');
  }
  if (/vsaa\.cn|QISHUI_VIP_PROXY|music\.qishui\.vip/.test(qishuiText)) {
    fail('Qishui playback must not depend on third-party VIP/proxy endpoints');
  }
  if (!/search: tokenConfigured \|\| webSession \|\| QISHUI_PUBLIC_ENABLED/.test(qishuiText) || !/loggedIn: webSession/.test(qishuiText) || !/请使用抖音 App 扫描 Mineradio 中的汽水官方二维码/.test(qishuiText)) {
    fail('Qishui status must keep public catalogue readiness separate from an authenticated Passport Web session');
  }
  const oldQishuiCredentialPrompt = new RegExp('当前版本还没有内置' + '抖音开放平台应用凭证');
  if (!/function qishuiPublicSearchReady/.test(qishuiLoginText) || !/function openQishuiPublicSearch/.test(qishuiLoginText) || !/refreshBtn\.onclick = isQishui \? openQishuiWebLogin :/.test(qishuiLoginText) || oldQishuiCredentialPrompt.test(qishuiLoginText)) {
    fail('Qishui login modal must retain public search separately from official Passport QR authentication');
  }
  if (!/searchReady/.test(qishuiStatusText) || !/capabilities\.search/.test(qishuiStatusText)) {
    fail('Qishui frontend status must expose public search readiness separately from OAuth login');
  }
  if (!/require\('\.\/qishui-qr-login'\)/.test(serverText) || !/\/api\/qishui\/login\/qrcode/.test(serverText) || !/\/api\/qishui\/login\/check/.test(serverText) || /pn === '\/api\/qishui\/login\/(?:token|cookie)'/.test(serverText)) {
    fail('Qishui login server must expose only the signed Passport QR create/check boundary');
  }
  if (!/persist:mineradio-qishui-auth-v6/.test(qishuiPassportText) || !/a_bogus/.test(qishuiPassportText) || !/check_qrconnect/.test(qishuiPassportText) || !/secondVerify/.test(qishuiPassportText) || !/createQishuiQrLoginBridge/.test(qishuiQrBridgeText)) {
    fail('Qishui Passport QR must retain the isolated signing runtime, a_bogus validation, polling, persistence, and MFA bridge');
  }
  if (!/pollQishuiQr/.test(qishuiLoginText) || !/login_scan_douyin_confirm/.test(qishuiLoginText) || /读取本机汽水|本机会话|Token 导入|submitQishuiTokenLogin|openQishuiMusicLogin/.test(qishuiLoginText)) {
    fail('Qishui login UI must use only the official in-panel QR flow');
  }
  requireLocaleKeys('login_scan_douyin_confirm');
  if (/ipcMain\.handle\('qishui-music-open-login'/.test(desktopMainText) || /openQishuiMusicLogin/.test(desktopPreloadText) || !/await qishuiQrLogin\.clear\(\)/.test(desktopMainText)) {
    fail('Qishui desktop bridge must remove the old login-window IPC and await Passport partition cleanup');
  }
  if (!/logout_qishui_logged/.test(accountLogoutText) || !/logout_qishui_sync/.test(accountLogoutText) || /本机汽水会话|OpenAPI token/.test(accountLogoutText)) {
    fail('Qishui account status must describe the official QR session without exposing legacy import modes');
  }
  requireLocaleKeys('logout_qishui_logged', 'logout_qishui_sync', 'logout_qishui_not_logged', 'logout_scan_douyin');
  if (!/官方扫码 \/ 抖音确认/.test(indexText) || /本地会话 \/ PC 客户端/.test(indexText)) {
    fail('Qishui login node must identify the official QR flow');
  }
  if (!/\/luna\/pc\/me/.test(qishuiText) || !/\/luna\/pc\/user\/playlist/.test(qishuiText) || !/\/luna\/pc\/playlist\/detail/.test(qishuiText) || !/function qishuiPcAppParams/.test(qishuiText) || !/pcApp: true/.test(qishuiText) || !/count: Math\.min\(100/.test(qishuiText) || /\/luna\/pc\/playlist\/detail[\s\S]{0,260}cnt:/.test(qishuiText)) {
    fail('Qishui playlist sync must use PC app APIs with user playlist, count/next_cursor, and LunaPC headers');
  }
  if (!/function qishuiImageUrl/.test(qishuiText) || !/~c5_375x375\.jpg/.test(qishuiText) || !/~c5_300x300\.jpg/.test(qishuiText) || !/directPlayable: true/.test(qishuiText)) {
    fail('Qishui playlist tracks must build full urls+uri covers and mark PC-session tracks as directly playable');
  }
  if (!/\/luna\/pc\/track_v2/.test(qishuiText) || !/function fetchQishuiPcTrackV2/.test(qishuiText) || !/function resolveQishuiDownloadInfo/.test(qishuiText) || !/play_info_list/.test(qishuiText) || !/url_player_info/.test(qishuiText) || !/video_model/.test(qishuiText)) {
    fail('Qishui playback must resolve PC track_v2 audio from play_info_list, url_player_info, or video_model');
  }
  // track_v2 的签名校验升级后未签名请求只会拿到空响应，免签名的 SEO 回退是免费曲的唯一通路。
  if (!/QISHUI_SEO_TRACK_URL/.test(qishuiText) || !/function fetchQishuiSeoTrack/.test(qishuiText) ||
      !/function resolveQishuiSeoPlayback/.test(qishuiText) || !/function qishuiSeoPlaybackResult/.test(qishuiText) ||
      !/qishui-beta-seo-track/.test(qishuiText) || !/vipClientHint/.test(qishuiText)) {
    fail('Qishui playback must keep the unsigned SEO fallback so free tracks stay playable and VIP limits are reported');
  }
  // SEO payload 的 quality_map.<音质>.need_vip 描述音质档位，免费曲同样会出现，不能当成整曲付费判据。
  if (!/function qishuiSeoVipOnlySignal/.test(qishuiText) || !/limitedFreeActive/.test(qishuiText) ||
      /qishuiSeoVipOnlySignal[\s\S]{0,600}qishuiTrackPlaybackRestriction/.test(qishuiText)) {
    fail('Qishui SEO payloads must be classified by their own narrow VIP markers, never by recursive need_vip keys');
  }
  const qishuiBridgePath = path.join(appRoot, 'server', 'qishui-client-bridge.js');
  if (!fs.existsSync(qishuiBridgePath)) {
    fail('Qishui must keep a local signature bridge module instead of hardcoding signatures');
  } else {
    const qishuiBridgeText = fs.readFileSync(qishuiBridgePath, 'utf8');
    const qishuiBridgeCode = qishuiBridgeText.replace(/\/\*[\s\S]*?\*\//g, '');
    if (!/function authorizeQishuiClientBridge/.test(qishuiBridgeText) || !/function revokeQishuiClientAuthorization/.test(qishuiBridgeText) ||
        !/client_not_authorized/.test(qishuiBridgeText) || !/generateHttpSignatureHeaders/.test(qishuiBridgeText) ||
        !/currentAuthorization\(\)/.test(qishuiBridgeText)) {
      fail('Qishui signature bridge must sign only after an explicit local authorization');
    }
    if (/X-Helios|X-Medusa/.test(qishuiBridgeCode)) {
      fail('Qishui signature headers must come from the official SDK, never be hardcoded');
    }
    if (!/\.mineradio['"]?\s*,\s*['"]qishui-native|qishui-native/.test(qishuiBridgeText) || !/QISHUI_NATIVE_CACHE_DIR/.test(qishuiBridgeText)) {
      fail('Qishui proprietary binaries must be staged into a per-user cache directory, never into the repository');
    }
  }
  const qishuiNativeArtifacts = ['bdms.node', 'metasecml.dll', 'metasecml.dylib', 'libmetasecml.so']
    .filter(name => fs.existsSync(path.join(appRoot, name)));
  const qishuiGitignoreText = fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8');
  if (qishuiNativeArtifacts.length || !/qishui-native\//.test(qishuiGitignoreText) || !/bdms\.node/.test(qishuiGitignoreText)) {
    fail('Qishui official client binaries must never be committed: found ' + qishuiNativeArtifacts.join(', '));
  }
  if (!/function buildQishuiTrackV2Request/.test(qishuiText) || !/bridge\.signing/.test(qishuiText) ||
      !/getQishuiClientBridgeStatus/.test(qishuiText)) {
    fail('Qishui track_v2 may only switch to the signed request shape when the bridge is authorized');
  }
  if (!/api\/qishui\/signature\/authorize/.test(serverText) || !/api\/qishui\/signature\/revoke/.test(serverText) ||
      !/handleQishuiSignatureAuthorize/.test(serverText) || !/req\.method !== 'POST'/.test(serverText)) {
    fail('server.js must expose the explicit POST-only Qishui signature authorization routes');
  }
  const qishuiSongRouteStart = serverText.indexOf("if (pn === '/api/qishui/song/url')");
  const qishuiSongRouteEnd = serverText.indexOf("if (pn === '/api/qishui/lyric')", qishuiSongRouteStart);
  const qishuiSongRouteText = serverText.slice(qishuiSongRouteStart, qishuiSongRouteEnd);
  if (qishuiSongRouteStart < 0 || qishuiSongRouteEnd <= qishuiSongRouteStart ||
      !/handleQishuiSongUrl\(\{/.test(qishuiSongRouteText) ||
      !/quality: url\.searchParams\.get\('quality'\)/.test(qishuiSongRouteText) ||
      !/\}, qishuiCookie\)/.test(qishuiSongRouteText)) {
    fail('server.js must pass the saved Qishui cookie into /api/qishui/song/url');
  }
  if (!/TrackDecryptor/.test(serverText) || !/qishui-audio-decryptor/.test(serverText) || !/function getQishuiDecryptedAudio/.test(serverText) || !/audioUrl\.includes\('#auth='\)/.test(serverText) || !/sendAudioBuffer/.test(serverText)) {
    fail('Qishui encrypted #auth audio must be decrypted by /api/audio with Range support');
  }
  if (!/function handleQishuiUserPlaylists/.test(qishuiText) || !/function handleQishuiPlaylistTracks/.test(qishuiText) || !/QISHUI_VIRTUAL_FEED_PLAYLIST_ID/.test(qishuiText) || !/userPlaylists: configured/.test(qishuiText)) {
    fail('Qishui must expose a login-backed virtual playlist for the normal playlist/shelf pipeline');
  }
  const webLibraryStart = qishuiText.indexOf('async function fetchQishuiWebLibrary');
  const webLibraryEnd = qishuiText.indexOf('\nasync function handleQishuiStatus', webLibraryStart);
  const webLibraryText = qishuiText.slice(webLibraryStart, webLibraryEnd);
  if (webLibraryStart < 0 || webLibraryEnd <= webLibraryStart || !/if \(\/created\|collection\|collect\/i\.test\(label\)\)/.test(webLibraryText) || !/extractQishuiPlaylistCards\(json\)/.test(webLibraryText)) {
    fail('Qishui library sync must only extract playlist cards from created/collection responses, never profile or recent-track payloads');
  }
  if (!/async function handleQishuiSearch\(keywords, limit, cookieText, offset\)/.test(qishuiText) || !/handleQishuiStatus\(cookieText\)/.test(qishuiText) || !/qishuiCookieFingerprint\(cookieText\)/.test(qishuiText) || !/handleQishuiSearch\(kw, limit, qishuiCookie, offset\)/.test(serverText)) {
    fail('Qishui search status and cache keys must use the saved web-session cookie');
  }
  if (!/function fetchQishuiWebLibraryFeedFallback/.test(qishuiText) || !/qishui-web-library-fallback/.test(qishuiText) || !/fetchQishuiWebPlaylistTracks\(pl\.id/.test(qishuiText)) {
    fail('Qishui web feed must fall back to liked/recent/playlist detail when the upstream feed endpoint returns 404');
  }
  if (!/function handleQishuiStatus/.test(qishuiText) || !/my_info/.test(qishuiText) || !/profileReady/.test(qishuiText) || !/handleQishuiStatus\(qishuiCookie\)/.test(serverText)) {
    fail('Qishui status must read the real PC account profile from /luna/pc/me my_info');
  }
  if (!/likedCard\.trackCount/.test(qishuiText) || !/likedCard\.cover/.test(qishuiText) || !/profile\.nickname/.test(qishuiText)) {
    fail('Qishui liked playlist must keep the real liked-card cover/count and account creator while deferring detail loading');
  }
  if (!/\/api\/qishui\/user\/playlists/.test(serverText) || !/\/api\/qishui\/playlist\/tracks/.test(serverText)) {
    fail('server.js must route Qishui user playlists and playlist track detail endpoints');
  }
  if (!/qishuiPlaylists/.test(coreStoreText) || !/if \(provider === 'qishui'\) return '\/api\/qishui\/user\/playlists'/.test(playlistShellText) || !/builtInPlaylists\.concat\(neteasePlaylists, qqPlaylists, kugouPlaylists, qishuiPlaylists, spotifyPlaylists\)/.test(playlistShellText)) {
    fail('playlist panel refresh must merge Qishui playlists with the other providers');
  }
  if (!/normalizePlaylistProvider/.test(playlistDetailText) || !/\/api\/qishui\/playlist\/tracks/.test(playlistDetailText) || !/qishui:' \+ id/.test(playlistDetailText) || !/pl_qishui_playlist/.test(playlistDetailText)) {
    fail('playlist panel detail must open and play Qishui playlists via the Qishui endpoint');
  }
  requireLocaleKeys('pl_qishui_playlist');
  if (!/function playlistQueueSource/.test(playlistLoadText) || !/raw\.indexOf\('qishui:'\)/.test(playlistLoadText) || !/playlistTracksEndpoint\(source\.provider/.test(playlistLoadText)) {
    fail('whole-playlist queue loading must support qishui: playlist ids');
  }
  if (!/provider === 'qishui'/.test(shelfCoreText) || !/qishui:'/.test(shelfCoreText) || !/\/api\/qishui\/playlist\/tracks/.test(shelfContentText)) {
    fail('3D shelf must display and drill into Qishui playlists through the Qishui endpoint');
  }
  if (!/discover_platforms/.test(homeText) || !/hasAnyPlatformLogin\(\)/.test(homeText) || /网易云 \/ QQ 音乐/.test(homeText)) {
    fail('Home discover must acknowledge Qishui/Kugou login playlists instead of only Netease/QQ');
  }
  requireLocaleKeys('discover_platforms');
  if (!/lyric-glow-enable-btn/.test(indexText) || !/lyric-glow-beat-btn/.test(indexText)) {
    fail('Lyric glow back-layer controls must stay visible in the lyric appearance panel');
  }
  console.log('[OK] Qishui search/lyric fallback stays usable without third-party playback proxy.');
}

async function checkSpotifyProviderGuard() {
  logStep('Spotify provider guard');
  const spotifyPath = path.join(appRoot, 'server', 'spotify-api.js');
  if (!fs.existsSync(spotifyPath)) fail('spotify-api.js must exist as a backend-only Spotify Web API bridge');
  const spotifyText = fs.readFileSync(spotifyPath, 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const qualityText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '00-api-quality-output.js'), 'utf8');
  const searchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '07-search.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const fallbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js'), 'utf8');
  const lyricText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  const playlistShellText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
  const playlistDetailText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const playlistLoadText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');
  const shelfCoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const shelfContentText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '03-content-list-manager.js'), 'utf8');
  const loginStatusText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
  const loginFlowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'), 'utf8');
  const userModalText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'), 'utf8');
  const desktopMainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const desktopPreloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const queueText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '09-queue-snapshot-autoplay.js'), 'utf8');
  const packageText = fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8');
  const internalBuilderText = fs.readFileSync(path.join(appRoot, 'electron-builder.internal-beta.json'), 'utf8');
  const gitignoreText = fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8');
  if (!/SPOTIFY_SEARCH_LIMIT_MAX\s*=\s*10/.test(spotifyText) || !/client_credentials/.test(spotifyText) || !/SPOTIFY_CLIENT_ID/.test(spotifyText) || !/SPOTIFY_CLIENT_SECRET/.test(spotifyText) || !/cleanPath/.test(spotifyText)) {
    fail('Spotify bridge must use backend client credentials and keep the official search limit guard');
  }
  if (!/playbackMode:\s*'recommend-match'/.test(spotifyText) || !/provider_limited/.test(spotifyText) || !/handleSpotifySongUrl/.test(spotifyText) || !/handleSpotifyLyric/.test(spotifyText)) {
    fail('Spotify must stay a metadata/search match source, not a fake direct audio provider');
  }
  if (!/require\('\.\/spotify-api'\)/.test(serverText) || !/\/api\/spotify\/status/.test(serverText) || !/\/api\/spotify\/config/.test(serverText) || !/\/api\/spotify\/setup\/diagnostics/.test(serverText) || !/\/api\/spotify\/search/.test(serverText) || !/\/api\/spotify\/song\/url/.test(serverText) || !/\/api\/spotify\/lyric/.test(serverText)) {
    fail('server.js must route Spotify status/config/setup diagnostics/search/song-url/lyric through the backend bridge');
  }
  if (!/search-mode-spotify/.test(indexText) || !/tag-source\.spotify/.test(cssText) || !/spotify-source/.test(cssText)) {
    fail('Spotify search tab and source badges must be visible in the UI');
  }
  if (!/PLAYBACK_QUALITY_DEFAULTS[\s\S]*spotify:\s*'standard'/.test(coreStoreText) || !/spotify:\s*\[[\s\S]*Spotify/.test(coreStoreText)) {
    fail('Spotify must be represented as a standard match-source quality option');
  }
  if (!/provider === 'spotify'/.test(qualityText) || !/Spotify/.test(qualityText) || !/return 'SP'/.test(qualityText)) {
    fail('playback quality UI must label Spotify as a match source');
  }
  if (!/search-mode-spotify/.test(searchText) || !/songProviderKey\(song\)[\s\S]*spotify/.test(searchText) || !/\/api\/spotify\/search/.test(searchText) || !/mergeSongSearchResults\(neteaseSongs, qqSongs, kugouSongs, qishuiSongs, spotifySongs/.test(searchText)) {
    fail('frontend search must include Spotify in tabs, source tags, provider search, and All merge');
  }
  if (!/\/api\/spotify\/song\/url/.test(playbackText) || !/isSpotifyPlayback/.test(playbackText) || !/provider_limited/.test(fallbackText)) {
    fail('Spotify playback must flow through provider_limited auto source fallback');
  }
  if (!/\/api\/spotify\/lyric/.test(lyricText)) {
    fail('Spotify lyric endpoint must return a safe empty lyric response for the shared lyric pipeline');
  }
  if (!/spotifyId/.test(queueText) || !/spotifyUri/.test(queueText) || !/spotifyUrl/.test(queueText)) {
    fail('Spotify queue snapshots must preserve provider ids and uri fields');
  }
  if (!/getSpotifyOAuthConfig/.test(spotifyText) || !/saveSpotifyConfig/.test(spotifyText) || !/buildSpotifyOAuthAuthorizeUrl/.test(spotifyText) || !/exchangeSpotifyOAuthCode/.test(spotifyText) || !/handleSpotifyStatus/.test(spotifyText) || !/handleSpotifyUserPlaylists/.test(spotifyText) || !/handleSpotifyPlaylistTracks/.test(spotifyText)) {
    fail('Spotify bridge must expose OAuth status plus playlist and liked-track handlers');
  }
  if (!/user-read-private/.test(spotifyText) || !/user-library-read/.test(spotifyText) || !/playlist-read-private/.test(spotifyText) || !/SPOTIFY_LIKED_PLAYLIST_ID/.test(spotifyText) || !/\/me\/tracks/.test(spotifyText) || !/\/me\/playlists/.test(spotifyText) || !/\/me/.test(spotifyText)) {
    fail('Spotify OAuth must request profile, private playlists, and Liked Songs scopes/endpoints');
  }
  if (!/Number\(item\.items && item\.items\.total\) \|\| Number\(item\.tracks && item\.tracks\.total\)/.test(spotifyText) || !/\/playlists\/['"]? \+ encodeURIComponent\(playlistId\) \+ ['"]?\/items/.test(spotifyText) || !/entry && \(entry\.item \|\| entry\.track\)/.test(spotifyText) || !/item\.type !== 'track'/.test(spotifyText) || !/Math\.min\(SPOTIFY_PLAYLIST_PAGE_LIMIT, Number\(opts\.limit\)/.test(spotifyText) || !/SPOTIFY_PLAYLIST_ITEMS_RESTRICTED/.test(spotifyText) || !/SPOTIFY_PLAYLIST_SCOPE_REQUIRED/.test(spotifyText)) {
    fail('Spotify playlist sync must use the 2026 /items response, keep legacy item compatibility, cap pages at 50, and explain owner/collaborator restrictions');
  }
  if (/spotifyUserGet\('\/playlists\/' \+ encodeURIComponent\(playlistId\) \+ '\/tracks'/.test(spotifyText)) {
    fail('Spotify playlist detail must not call the removed /playlists/{id}/tracks endpoint');
  }
  const mapPlaylistStart = spotifyText.indexOf('function mapSpotifyPlaylist');
  const mapPlaylistEnd = spotifyText.indexOf('\nasync function buildSpotifyLikedPlaylistCard', mapPlaylistStart);
  const mapPlaylistSandbox = {
    normalizeText: value => String(value || '').trim(),
    spotifyImage: images => Array.isArray(images) && images[0] && images[0].url || '',
    Number,
  };
  vm.runInNewContext(spotifyText.slice(mapPlaylistStart, mapPlaylistEnd), mapPlaylistSandbox, { filename: 'spotify-playlist-map.js' });
  const mappedPlaylist = mapPlaylistSandbox.mapSpotifyPlaylist({
    id: 'owned-playlist',
    name: 'Owned',
    owner: { id: 'listener' },
    items: { total: 321 },
    tracks: { total: 0 },
  }, { id: 'listener' });
  if (!mappedPlaylist || mappedPlaylist.trackCount !== 321 || mappedPlaylist.subscribed) {
    fail('Spotify playlist cards must read items.total and preserve owned-playlist classification');
  }
  const detailStart = spotifyText.indexOf('async function handleSpotifyPlaylistTracks');
  const detailEnd = spotifyText.indexOf('\nasync function handleSpotifyAlbumDetail', detailStart);
  let requestedPath = '';
  let requestedParams = null;
  let responseItem = { item: { id: 'new-track', name: 'New Track' } };
  const detailSandbox = {
    normalizeText: value => String(value || '').trim(),
    handleSpotifyStatus: async () => ({ loggedIn: true, market: 'US' }),
    spotifyUserGet: async (requestPath, params) => {
      requestedPath = requestPath;
      requestedParams = params;
      return { items: [responseItem], total: 1, next: null };
    },
    mapSpotifyTrack: track => track ? { id: track.id, name: track.name } : null,
    spotifyErrorDetails: error => ({ error: error && error.message || 'FAILED', message: '' }),
    readStoredSpotifyToken: () => ({ scope: 'playlist-read-private playlist-read-collaborative' }),
    normalizeScopes: value => String(value || '').split(/\s+/).filter(Boolean),
    SPOTIFY_PLAYLIST_PAGE_LIMIT: 50,
    SPOTIFY_LIKED_PLAYLIST_ID: 'spotify-liked',
    DEFAULT_SPOTIFY_MARKET: 'US',
    Math,
    Number,
    Object,
    encodeURIComponent,
  };
  vm.runInNewContext(spotifyText.slice(detailStart, detailEnd), detailSandbox, { filename: 'spotify-playlist-items.js' });
  let detail = await detailSandbox.handleSpotifyPlaylistTracks('owned-playlist', { limit: 96, offset: 0 });
  if (requestedPath !== '/playlists/owned-playlist/items' || !requestedParams || requestedParams.limit !== 50 || !detail.tracks[0] || detail.tracks[0].id !== 'new-track') {
    fail('Spotify playlist detail must request /items with a 50-row page and map entry.item');
  }
  responseItem = { track: { id: 'legacy-track', name: 'Legacy Track' } };
  detail = await detailSandbox.handleSpotifyPlaylistTracks('legacy-playlist', { limit: 1, offset: 0 });
  if (!detail.tracks[0] || detail.tracks[0].id !== 'legacy-track') {
    fail('Spotify playlist detail must retain compatibility with legacy entry.track payloads');
  }
  if (!/\/api\/spotify\/logout/.test(serverText) || !/\/api\/spotify\/user\/playlists/.test(serverText) || !/\/api\/spotify\/playlist\/tracks/.test(serverText)) {
    fail('server.js must route Spotify logout, user playlists, and playlist track detail endpoints');
  }
  if (!/SPOTIFY_LOGIN_PARTITION/.test(desktopMainText) || !/openSpotifyMusicLoginWindow/.test(desktopMainText) || !/verifySpotifyOAuthCallbackEndpoint/.test(desktopMainText) || !/spotify-music-open-login/.test(desktopMainText) || !/spotify-music-verify-setup/.test(desktopMainText) || !/shell\.openExternal\(authUrl\)/.test(desktopMainText) || !/SPOTIFY_OAUTH_TIMEOUT_MS/.test(desktopMainText) || !/SPOTIFY_TOKEN_FILE/.test(desktopMainText) || !/127\.0\.0\.1:43879\/callback/.test(spotifyText + desktopMainText)) {
    fail('desktop main must provide system-browser PKCE, a verified loopback callback, bounded timeout, and userData token storage');
  }
  if (!/openSpotifyMusicLogin/.test(desktopPreloadText) || !/verifySpotifyMusicSetup/.test(desktopPreloadText) || !/clearSpotifyMusicLogin/.test(desktopPreloadText)) {
    fail('desktop preload must expose Spotify login, callback verification, and clear-login IPC bridges');
  }
  if (!/login-provider-spotify/.test(indexText) || !/user-provider-spotify/.test(indexText) || !/account-add-spotify/.test(indexText) || !/account-source-dot\.spotify/.test(cssText) || !/account-provider-chip\.spotify/.test(cssText)) {
    fail('Spotify login and account tabs must be visible in the UI');
  }
  if (!/spotifyLoginStatus/.test(coreStoreText) || !/spotifyPlaylists/.test(coreStoreText) || !/refreshSpotifyLoginStatus/.test(loginStatusText) || !/openSpotifyWebLogin/.test(loginFlowText) || !/clearSpotifyMusicLogin/.test(userModalText)) {
    fail('frontend account state must include Spotify status, OAuth flow, playlists, and logout');
  }
  if (!/tokenFileExists/.test(spotifyText) || !/credentialsFileExists/.test(spotifyText) || !/localConfigMissing/.test(spotifyText) || !/fs\.existsSync/.test(spotifyText)) {
    fail('Spotify status must distinguish configured paths from real local token/credential files');
  }
  if (!/localConfigMissing/.test(loginStatusText) || !/tokenFileExists/.test(loginStatusText) || !/credentialsFileExists/.test(loginStatusText) || !/submitSpotifyConfigLogin/.test(loginFlowText) || !/saveSpotifySetupClientId/.test(loginFlowText) || !/\/api\/spotify\/config/.test(loginFlowText)) {
    fail('Spotify frontend status must surface missing local OAuth config/token and provide validated Client ID save + OAuth flow');
  }
  if (!/SPOTIFY_DEVELOPER_DASHBOARD_URL/.test(loginFlowText) || !/openSpotifyDeveloperDashboard/.test(loginFlowText) || !/copySpotifyRedirectUri/.test(loginFlowText) || !/verifySpotifySetupCallback/.test(loginFlowText) || !/runSpotifySetupDiagnostics/.test(loginFlowText) || !/spotify-setup-step-1/.test(indexText) || !/spotify-setup-step-4/.test(indexText) || !/spotify-setup-wizard/.test(cssText) || !/spotify-setup-steps/.test(cssText)) {
    fail('Spotify onboarding must provide a spacious four-step wizard with per-step local and API verification');
  }
  if (!/loginRefreshRequestSeq/.test(loginFlowText) || !/isLoginRefreshCurrent/.test(loginFlowText)) {
    fail('login modal provider switching must guard stale async status and QR writes');
  }
  if (!/\/api\/spotify\/user\/playlists/.test(playlistShellText) || !/spotifyPlaylists/.test(playlistShellText) || !/\/api\/spotify\/playlist\/tracks/.test(playlistDetailText) || !/spotify:' \+ id/.test(playlistDetailText) || !/pl_spotify_playlist/.test(playlistDetailText)) {
    fail('playlist panel must merge and open Spotify playlists');
  }
  if (!/spotifyErrorDetails/.test(spotifyText) || !/playlistPanelNoticeHtml/.test(playlistDetailText) || !/playlistCardPriority/.test(playlistDetailText) || !/spotify-liked/.test(playlistDetailText) || !/prioritizePlaylistGroupItems/.test(playlistDetailText) || !/showToast\(r && \(r\.message \|\| r\.error\) \|\| podcastPlaylistLoadersText\('pod_empty'\)\)/.test(playlistLoadText)) {
    fail('Spotify playlists must keep liked songs visible and surface API errors instead of pretending details are empty');
  }
  if (!/function playlistQueueSource/.test(playlistLoadText) || !/raw\.indexOf\('spotify:'\)/.test(playlistLoadText) || !/playlistTracksEndpoint\(source\.provider/.test(playlistLoadText)) {
    fail('whole-playlist queue loading must support spotify: playlist ids');
  }
  if (!/provider === 'spotify'/.test(shelfCoreText) || !/spotify:/.test(shelfCoreText) || !/\/api\/spotify\/playlist\/tracks/.test(shelfContentText)) {
    fail('3D shelf must display and drill into Spotify playlists through the Spotify endpoint');
  }
  // 打包清单已收敛为一条 `server/**/*`：不再逐个点名 `*-api.js` / `qishui-*.js`，那套点名写法
  // 正是 qishui-client-bridge.js 漏打包的成因。判据改成"两份清单都要覆盖整个 server/ 目录"，
  // 后端新增任何模块都自动落在覆盖范围内。
  // The manifest collapsed into a single `server/**/*` entry instead of naming each `*-api.js` /
  // `qishui-*.js` file — that per-name list is exactly how qishui-client-bridge.js went missing from
  // a build. The check now requires both manifests to cover the whole server/ directory, so any new
  // backend module is inside the covered range by construction.
  if (!/"server\/\*\*\/\*"/.test(packageText) || !/"server\/\*\*\/\*"/.test(internalBuilderText)) {
    fail('official and internal-beta package file lists must cover server/**/*, or a backend module can be left out of the build');
  }
  if (!/\.spotify-credentials\.json/.test(gitignoreText) || !/spotify-credentials\.json/.test(gitignoreText) || !/\.spotify-token\.json/.test(gitignoreText) || !/spotify-token\.json/.test(gitignoreText)) {
    fail('Spotify local credential files must stay ignored by git');
  }
  console.log('[OK] Spotify Web API match source is guarded across backend, UI, playback fallback, lyrics, and packaging.');
}

// Spotify 已作为一档正式平台回归，这里守卫的是「接入面必须完整存在」：
// 登录/设置 UI、账号胶囊排序、登录工作流排序、以及未被 PROVIDER_REMOVED 404 拦死的 HTTP 路由。
// Spotify is restored as a first-class provider, so this guard asserts the surface is intact:
// login/setup UI, account capsule ordering, login workflow ordering, and HTTP routes not short-circuited.
function checkSpotifyProviderSurface() {
  logStep('Spotify provider surface guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const flowsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'), 'utf8');
  const accountText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  if (!/login-provider-spotify/.test(indexText) || !/spotify-setup-wizard/.test(indexText)) {
    fail('spotify login and setup UI surface is missing');
  }
  // ⚠️ 平台清单已改为从 provider 注册表派生，源码里不再有 `ACCOUNT_PROVIDER_KEYS = ['netease', …]`
  //    这样的字面量数组。原先这两条判据钉的正是字面量 —— 于是"实现改成派生"会让守卫失败，
  //    而它真正要守的是「spotify 仍参与账号胶囊与登录工作流的排序」。现在真跑一遍注册表、断言
  //    派生集合里含 spotify：判据跟着**意图**走，而不是跟着实现的写法走。
  //    （这正是"钉快照"的典型代价：写法一变就红，而它守的东西其实没变。）
  // ⚠️ The lists now derive from the provider registry, so the literal arrays are gone. The old
  //    judgements pinned those literals, which means a change of implementation SHAPE would fail
  //    them even though the thing they guard — spotify participating in both orderings — is intact.
  //    Run the registry and assert the derived set: the judgement follows the intent, not the syntax.
  const vmModule = require('vm');
  const registryProbe = { console };
  vmModule.createContext(registryProbe);
  vmModule.runInContext(
    fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '16-provider-registry.js'), 'utf8')
      + '\nthis.loginProviders = providerRegistryKeysWith("login");',
    registryProbe
  );
  if (!Array.isArray(registryProbe.loginProviders) || registryProbe.loginProviders.indexOf('spotify') < 0) {
    fail('spotify must participate in account capsule ordering (absent from the registry login set)');
  }
  // 两边都必须**从注册表派生**：写回字面量清单就等于把"新增平台会漏"的坑重新挖开。
  // Both sites must derive from the registry: a literal list would reopen the "a new provider is
  // silently skipped" hole this refactor closed.
  if (!/ACCOUNT_PROVIDER_KEYS = providerRegistryKeysWith\('login'\)/.test(accountText)) {
    fail('ACCOUNT_PROVIDER_KEYS must derive from the provider registry, not a hand-kept list');
  }
  if (!/LOGIN_WORKFLOW_PROVIDERS = providerRegistryKeysWith\('login'\)/.test(flowsText)) {
    fail('LOGIN_WORKFLOW_PROVIDERS must derive from the provider registry, not a hand-kept list');
  }
  // 旧的"已移除平台"404 拦截会盖掉所有 /api/spotify/* 真实路由，必须彻底不存在。
  // The legacy removed-provider 404 gate shadows every live /api/spotify/* route, so it must be gone.
  if (/pn\.indexOf\('\/api\/spotify\/'\) === 0/.test(serverText)) {
    fail('/api/spotify/* must not be short-circuited by a PROVIDER_REMOVED 404 gate');
  }
  if (!/pn === '\/api\/spotify\/status'/.test(serverText) || !/pn === '\/api\/spotify\/config'/.test(serverText)) {
    fail('spotify HTTP routes must stay registered after the removed-provider gate');
  }
  console.log('[OK] Spotify keeps login, setup, account-capsule ordering and HTTP surface.');
}

function checkPlaybackControlBadgesGuard() {
  logStep('Playback control source/VIP badge guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const searchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '07-search.js'), 'utf8');
  const controlText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '15-ripples-cover-depth.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const qualityText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '00-api-quality-output.js'), 'utf8');
  const fallbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js'), 'utf8');
  const switchCoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js'), 'utf8');
  const lyricFetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  const beatPrefetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const glassText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '15-control-glass-animations.js'), 'utf8');
  const loginStatusText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
  const accountUtilsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  const sourceSwitcherGlassOk =
    /\.control-source-switcher::before/.test(cssText) &&
    /html\.control-glass-svg-ok\s+\.control-source-switcher\s*\{[\s\S]{0,180}var\(--saved-panel-glass-filter\)/.test(cssText);
  const sourceSwitcherUsesSharedSvgMap =
    /html\.control-glass-svg-ok[\s\S]{0,1400}\.control-source-switcher,[\s\S]{0,360}var\(--saved-panel-glass-svg-filter\)/.test(cssText) ||
    /html\.control-glass-svg-ok[\s\S]{0,1400}\.control-source-switcher\s*\{[\s\S]{0,240}var\(--saved-panel-glass-svg-filter\)/.test(cssText);
  const sourceSwitcherOriginalMatchOk =
    /SOURCE_SWITCH_BLOCKED_ARTIST_TOKENS\s*=\s*\['asablue'\]/.test(searchText) &&
    /SOURCE_SWITCH_STRICT_ARTIST_ALIASES/.test(searchText) &&
    /function sourceCandidateRejectReason/.test(searchText) &&
    /function findControlSourceMatchResult/.test(searchText) &&
    /function controlSourceIssueLabel/.test(searchText) &&
    /sourceCandidateRejectReason\(song, list\[i\], target\)/.test(fallbackText) &&
    /sourceCandidateRejectReason\(song, candidate, 'netease'\)/.test(lyricFetchText);
  if (!/control-title-text/.test(indexText) || !/control-title-badges/.test(indexText)) {
    fail('bottom player title must reserve inline spans for source and VIP badges');
  }
  const qualityControlCount = (indexText.match(/id="quality-control"/g) || []).length;
  const qualityChipInlineOk =
    qualityControlCount === 1 &&
    /id="control-title"[\s\S]{0,260}id="control-title-badges"[\s\S]{0,260}id="quality-control"\s+class="quality-control control-quality-chip"/.test(indexText) &&
    /\.control-quality-chip\s*\{[\s\S]{0,120}height:\s*15px/.test(cssText) &&
    /#quality-btn\.quality-pill\s*\{[\s\S]{0,220}height:\s*15px[\s\S]{0,120}font-size:\s*8px/.test(cssText) &&
    !/body\.diy-mode\s+#quality-control\s*\{[\s\S]{0,80}display:\s*none\s*!important/.test(cssText);
  if (!qualityChipInlineOk) {
    fail('bottom player quality selector must stay as a compact title-side chip and remain visible in windowed DIY mode');
  }
  if (!/function songRequiresVip/.test(searchText) || !/function songVipTagHtml/.test(searchText) || !/only_vip_playable/.test(searchText)) {
    fail('song VIP detection must cover provider fee, trial, only-vip, and playback restriction metadata');
  }
  if (!/control-title-badges/.test(controlText) || !/songSourceTagHtml\(song, \{ switcher: true \}\)/.test(controlText) || !/songVipTagHtml\(song\)/.test(controlText)) {
    fail('bottom player controls must render the active provider and VIP badges beside the title');
  }
  if (!/song\.resolvedPlaybackProvider/.test(playbackText) || !/song\.vipRequired/.test(playbackText) || !/updateControlTrackInfo\(song\)/.test(playbackText)) {
    fail('playback URL resolution must refresh bottom control badges with provider/VIP state');
  }
  if (!/function playbackRestrictionNotice/.test(fallbackText) || !/function playbackRestrictionCategory/.test(fallbackText) || !/pf_platform_no_vip_status/.test(fallbackText) || !/showSourceFallbackNotice\(notice\.title, notice\.body\)/.test(fallbackText) || !/function playbackFailureNoticeFromError/.test(switchCoreText)) {
    fail('playback failure notices must distinguish membership, login authorization, provider-limited, copyright, and generic no-url causes');
  }
  requireLocaleKeys('pf_platform_no_vip_status');
  if (!/playbackQualityRuntimeCaps/.test(coreStoreText) || !/function markPlaybackQualityRuntimeCap/.test(qualityText) || !/cap-locked/.test(qualityText + cssText) || !/playbackQualityCapValue\(song, playbackProvider\)/.test(playbackText) || !/markPlaybackQualityRuntimeCap\(song, playbackProvider, data\.level/.test(playbackText) || !/markPlaybackQualityRuntimeCap\(song, 'qq', nextQuality/.test(fallbackText) || /qqPlaybackQualityCeiling/.test(coreStoreText + playbackText + fallbackText + beatPrefetchText)) {
    fail('playback quality fallback must be tracked per current song and disable unsupported higher choices without a global QQ ceiling');
  }
  if (!/\.control-title-badges/.test(cssText) || !/\.control-title-text/.test(cssText)) {
    fail('bottom player source/VIP badges must have constrained responsive CSS');
  }
  if (!/search_switcher_chip_html/.test(searchText) || !/function toggleControlSourceSwitcher/.test(searchText) || !/function switchCurrentSongSource/.test(searchText) || !/findControlSourceMatch/.test(searchText) || !/resumeAt: currentResumeSeconds\(0\)/.test(searchText) || !/\.control-source-switcher/.test(cssText) || !sourceSwitcherGlassOk || sourceSwitcherUsesSharedSvgMap) {
    fail('bottom player source badge must expand into a glass source switcher without reusing the shared SVG map that cuts the right edge');
  }
  requireLocaleKeys('search_switcher_chip_html');
  if (!sourceSwitcherOriginalMatchOk) {
    fail('source switching and lyric fallback must reject blacklisted cover/derivative candidates and show no-official-source states');
  }
  if (!/quality-switch-preserve-lyrics/.test(playbackText) || !/visual-prep-skip/.test(playbackText) || !/if \(!qualitySwitch\) \{[\s\S]{0,120}safeRenderQueuePanel\('play-queue-at'\)/.test(playbackText) || !/if \(!qualitySwitch\) lyricSunEnergy = 0/.test(playbackText)) {
    fail('quality switching must preserve lyric and visual state instead of running the full track-switch rendering path');
  }
  const accountPillGlassSurfaceOk =
    /\.top-account-pill::before/.test(cssText) &&
    /\.top-account-pill\s*>\s*\*/.test(cssText) &&
    /html\.control-glass-svg-ok\s+\.top-account-pill::before\s*\{[\s\S]*?url\(#mineradio-account-pill-glass-filter\)/.test(cssText);
  const accountPillDirectSvgFilter =
    /html\.control-glass-svg-ok\s+\.top-account-pill\s*\{[\s\S]*?url\(#mineradio-account-pill-glass-filter\)/.test(cssText) ||
    /html\.control-glass-svg-ok\s+\.top-account-pill,/.test(cssText);
  const lastAccountContainerOverride = cssText.lastIndexOf('#user-btn.multi-account,');
  const lastTopRightIconRule = cssText.lastIndexOf('#top-right .icon-btn');
  const accountContainerGlassDisabledOk =
    lastAccountContainerOverride > lastTopRightIconRule &&
    /#user-btn\.multi-account[\s\S]{0,320}background:\s*transparent\s*!important[\s\S]{0,160}box-shadow:\s*none\s*!important[\s\S]{0,160}backdrop-filter:\s*none\s*!important[\s\S]{0,120}-webkit-backdrop-filter:\s*none\s*!important[\s\S]{0,120}transition:\s*none\s*!important/.test(cssText.slice(lastAccountContainerOverride));
  const accountFilterText = (indexText.match(/<filter id="mineradio-account-pill-glass-filter"[\s\S]*?<\/filter>/) || [''])[0];
  const accountPillSimpleRefractionOk =
    /<feDisplacementMap[\s\S]*?scale="28"[\s\S]*?xChannelSelector="R"[\s\S]*?yChannelSelector="G"/.test(accountFilterText) &&
    !/feOffset|feColorMatrix|feBlend|dispRed|dispGreen|dispBlue/.test(accountFilterText);
  const accountPillDedicatedMapOk =
    /function generateAccountPillGlassDisplacementMap/.test(glassText) &&
    /account-x/.test(glassText) &&
    /rgb\(128,128,128\)/.test(glassText) &&
    /controlGlassState\.accountPillKey[\s\S]{0,360}generateAccountPillGlassDisplacementMap\(width, height, radius\)/.test(glassText);
  const accountPillVerticalStackOk =
    /account-pill-stack/.test(loginStatusText) &&
    /#top-right\.account-pill-stack[\s\S]{0,100}align-items:\s*flex-start/.test(cssText) &&
    /#user-btn\.multi-account\.external-account-pills[\s\S]{0,220}flex-direction:\s*column[\s\S]{0,160}align-items:\s*flex-end/.test(cssText) &&
    /#user-btn\.multi-account\.external-account-pills \.top-account-pill[\s\S]{0,120}width:\s*190px/.test(cssText) &&
    /#user-btn\.multi-account\.external-account-pills \.top-account-name[\s\S]{0,120}max-width:\s*118px/.test(cssText) &&
    /e\.clientY\s*<\s*rect\.top\s*\+\s*rect\.height\s*\/\s*2/.test(accountUtilsText) &&
    !/e\.clientX\s*<\s*rect\.left\s*\+\s*rect\.width\s*\/\s*2/.test(accountUtilsText);
  if (!/mineradio-account-pill-glass-filter/.test(indexText) || !/account-pill-glass-map/.test(indexText) || !/url\(#mineradio-account-pill-glass-filter\)/.test(cssText) || !/overflow:\s*hidden/.test(cssText) || !accountPillGlassSurfaceOk || accountPillDirectSvgFilter || !accountContainerGlassDisabledOk || !accountPillSimpleRefractionOk || !accountPillDedicatedMapOk || !accountPillVerticalStackOk || !/function updateAccountPillGlassDisplacementMap/.test(glassText) || !/accountPillKey/.test(glassText) || !/querySelectorAll\('\.top-account-pill'\)/.test(glassText) || !/requestAnimationFrame\(updateAccountPillGlassDisplacementMap\)/.test(loginStatusText)) {
    fail('top account VIP capsules must use a dedicated glass map/filter and refresh it after account rendering');
  }
  console.log('[OK] Bottom player title shows source and VIP badges without stretching the control bar.');
}

async function checkProviderFallbackTerminalStateGuard() {
  logStep('Provider fallback transaction and terminal-state guard');
  const fallbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const beatPrefetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  if (!/function sourceFallbackProviderReady/.test(fallbackText) || !/status\.playbackKeyReady === true/.test(fallbackText) || !/function alternatePlaybackProviders/.test(fallbackText) || /if \(provider === 'netease'\) return 'qq'/.test(fallbackText)) {
    fail('automatic fallback must only select logged-in direct providers with complete playback authorization');
  }
  if (!/SOURCE_FALLBACK_SEARCH_TIMEOUT_MS\s*=\s*6500/.test(fallbackText) || !/apiJson\(url, \{ timeoutMs: SOURCE_FALLBACK_SEARCH_TIMEOUT_MS \}\)/.test(fallbackText) || !/SOURCE_FALLBACK_RECOVERY_TIMEOUT_MS\s*=\s*20000/.test(fallbackText) || !/function awaitSourceFallbackBudget/.test(fallbackText) || (playbackText.match(/timeoutMs:\s*9000/g) || []).length < 2 || (playbackText.match(/timeoutMs:\s*14000/g) || []).length < 2 || (playbackText.match(/timeoutMs:\s*15000/g) || []).length < 4 || (playbackText.match(/timeoutMs:\s*20000/g) || []).length < 2) {
    fail('fallback search, normal source resolution, and gapless source resolution must all be time-bounded');
  }
  if (!/alternateData[\s\S]{0,220}!alternateData\.url[\s\S]{0,320}playQueue\[idx\] = committedCandidate/.test(fallbackText) || !/fallbackStarted === true[\s\S]{0,180}pf_source_switched/.test(fallbackText) || !/function restoreSourceFallbackQueueItem/.test(fallbackText)) {
    fail('fallback candidates must be URL-probed before provisional commit and only announce success after audible playback');
  }
  requireLocaleKeys('pf_source_switched');
  if (!/async function skipFailedQueueItem/.test(fallbackText) || !/skipShuffleOrder:\s*true/.test(fallbackText) || !/return nextStarted === true/.test(fallbackText) || !/function settleSourceFallbackTerminal/.test(fallbackText) || !/audio\.removeAttribute\('src'\)/.test(fallbackText) || !/audio\.__mineradioQueueItemKey = ''/.test(fallbackText)) {
    fail('failed fallback must await the next track or settle one terminal state with no stale audio owner');
  }
  if (!/opts\.preResolvedPlaybackData/.test(playbackText) || !/fallbackResult !== null/.test(playbackText) || /if \(isQQPlayback && await retryQQPlaybackWithCompatibleQuality\(song, idx, token, retryPlaybackOpts, data, requestedQuality\)\)/.test(playbackText)) {
    fail('normal playback must consume a preflighted fallback URL and must not recursively retry QQ qualities after an empty URL response');
  }
  if (!/AUDIO_PLAY_REQUEST_TIMEOUT_MS\s*=\s*9000/.test(controlsText) || !/function awaitMediaPlayWithTimeout/.test(controlsText) || (controlsText.match(/awaitMediaPlayWithTimeout\(/g) || []).length < 5 || !/function playbackMediaMatchesCurrentQueueItem/.test(controlsText)) {
    fail('media.play promises must be time-bounded and manual resume must reject stale audio ownership');
  }
  if (!/function probePlaybackAudioUrl/.test(serverText) || !/AUDIO_URL_PROBE_BYTES\s*=\s*8192/.test(serverText) || !/function audioProbeMagic/.test(serverText) || !/audioProxyHeadersFor\(audioUrl, 'bytes=0-'/.test(serverText) || !/&& !!magic/.test(serverText) || !/function probeQQAudioUrl/.test(serverText) || !/probe\.ok/.test(serverText) || !/function readStreamChunkWithTimeout/.test(serverText) || !/fetchWithTimeout\(audioUrl, \{ headers: hdr \}, 9000\)/.test(serverText)) {
    fail('provider URL resolution and the audio proxy must verify real upstream bytes with bounded connection and stream waits');
  }
  const magicStart = serverText.indexOf('function audioProbeMagic');
  const magicEnd = serverText.indexOf('async function probePlaybackAudioUrl', magicStart);
  const magicSandbox = { Buffer };
  vm.runInNewContext(serverText.slice(magicStart, magicEnd), magicSandbox, { filename: 'audio-probe-magic.js' });
  if (magicSandbox.audioProbeMagic(Buffer.from('ID3\u0004\u0000\u0000', 'binary')) !== 'mp3-id3' || magicSandbox.audioProbeMagic(Buffer.from('fLaC0000', 'ascii')) !== 'flac' || magicSandbox.audioProbeMagic(Buffer.alloc(1024, 0x41)) !== '') {
    fail('audio byte probe must accept known media headers and reject MIME-only garbage bytes');
  }
  const neteaseMatchNoticePos = playbackText.indexOf('data.sourceMatch && !song.neteaseSourceMatchNotified');
  const networkPlaybackFailurePos = playbackText.lastIndexOf('if (!playbackStarted)');
  const serverBudget = Number((serverText.match(/NETEASE_SONG_URL_TOTAL_BUDGET_MS\s*=\s*(\d+)/) || [])[1] || 0);
  const playbackBudget = 14000;
  if (
    !/function neteasePlaybackMatchQuery/.test(playbackText)
    || (playbackText.match(/neteasePlaybackMatchQuery\(song\)/g) || []).length < 2
    || !/song\.resolvedNeteaseId\s*=/.test(playbackText)
    || !/data && data\.sourceMatch/.test(playbackText)
    || neteaseMatchNoticePos < 0
    || neteaseMatchNoticePos < networkPlaybackFailurePos
    || !/async function retryNeteaseSourceMatchPlayback/.test(playbackText)
    || !/excludeIds: triedIds, skipDirect: true/.test(playbackText)
    || !/matchedPlaybackFallback = await tryAutoPlaybackFallback/.test(playbackText)
    || !/neteasePlaybackMatchQuery\(song\)/.test(beatPrefetchText)
    || !/timeoutMs:\s*14000/.test(beatPrefetchText)
    || !/async function findNeteaseSameTrackCandidates/.test(serverText)
    || !/cloudsearch\(\{ keywords: query, type: 1, limit: 16, cookie: userCookie \}\)/.test(serverText)
    || !/song_detail\(\{ ids: \[\.\.\.new Set\(detailIds\)\]\.join\(','\), cookie: userCookie \}\)/.test(serverText)
    || !/sourceVersions\.join\('\|'\) !== candidateVersions\.join\('\|'\)/.test(serverText)
    || !/function neteaseSourceMatchArtistSetEqual/.test(serverText)
    || !/function mergeNeteaseSourceMatchSong/.test(serverText)
    || !/fingerprintMatches/.test(serverText)
    || !/async function resolveNeteaseSameTrackPlayback/.test(serverText)
    || !/source: 'netease-same-track'/.test(serverText)
    || !/netease_same_recording/.test(serverText)
    || !/netease_official_alternate/.test(serverText)
    || !/netease_same_track_metadata/.test(serverText)
    || !/noCopyrightRcmd/.test(serverText)
    || !/sourceMatchTriedIds/.test(serverText)
    || !/getPlaybackLoginInfo/.test(serverText)
    || serverBudget <= 0
    || serverBudget + 800 >= playbackBudget
    || !/handleSongUrl\(sid, loginInfo, quality, matchHints\)/.test(serverText)
  ) {
    fail('Netease unavailable tracks must exhaust bounded same-track candidates while preserving the original queue item');
  }
  const matchQueryStart = playbackText.indexOf('function neteasePlaybackMatchQuery');
  const matchQueryEnd = playbackText.indexOf('function clearNeteaseSourceMatchMetadata', matchQueryStart);
  const matchQuerySandbox = { Array, String, encodeURIComponent };
  vm.runInNewContext(playbackText.slice(matchQueryStart, matchQueryEnd), matchQuerySandbox, { filename: 'netease-playback-match-query.js' });
  const querySong = { id: 'song-1', name: 'Fossils', artist: 'acloudyskye' };
  const noOptsQuery = new URLSearchParams(matchQuerySandbox.neteasePlaybackMatchQuery(querySong).replace(/^&/, ''));
  const arrayOptsQuery = new URLSearchParams(matchQuerySandbox.neteasePlaybackMatchQuery(querySong, { excludeIds: ['candidate-a', 'candidate-b'] }).replace(/^&/, ''));
  const stringOptsQuery = new URLSearchParams(matchQuerySandbox.neteasePlaybackMatchQuery(querySong, { excludeIds: 'candidate-c,candidate-d' }).replace(/^&/, ''));
  const sparseQuery = new URLSearchParams(matchQuerySandbox.neteasePlaybackMatchQuery({ id: 'sparse-song' }).replace(/^&/, ''));
  if (
    noOptsQuery.get('excludeIds') !== ''
    || arrayOptsQuery.get('excludeIds') !== 'candidate-a,candidate-b'
    || stringOptsQuery.get('excludeIds') !== 'candidate-c,candidate-d'
    || sparseQuery.get('artist') !== ''
    || sparseQuery.get('artistIds') !== ''
    || sparseQuery.get('artistNames') !== ''
    || sparseQuery.get('excludeIds') !== ''
  ) {
    fail('Netease playback match query must safely normalize missing, array, and string excludeIds values');
  }
  if (/apis\.netstart\.cn|\/simi\/song|simi_song/.test([serverText, playbackText, fallbackText].join('\n'))) {
    fail('production playback must not depend on the public documentation host or use unrelated Netease recommendation results');
  }
  const handleSongUrlStart = serverText.indexOf('async function handleSongUrl');
  const handleSongUrlEnd = serverText.indexOf('\n}', handleSongUrlStart);
  const handleSongUrlText = serverText.slice(handleSongUrlStart, handleSongUrlEnd);
  const directResolvePos = handleSongUrlText.indexOf('resolveNeteaseDirectSongUrl');
  const directReturnPos = handleSongUrlText.indexOf('if (direct && direct.url && !direct.trial) return direct');
  const sameTrackResolvePos = handleSongUrlText.indexOf('resolveNeteaseSameTrackPlayback');
  if (directResolvePos < 0 || directReturnPos <= directResolvePos || sameTrackResolvePos <= directReturnPos) {
    fail('Netease direct playback must return before same-track search, and same-track search must finish before cross-provider fallback');
  }
  const matcherStart = serverText.indexOf('function neteaseSourceMatchText');
  const matcherEnd = serverText.indexOf('function neteaseSourceMatchCacheKey', matcherStart);
  if (matcherStart < 0 || matcherEnd <= matcherStart) fail('Netease same-recording matcher source is incomplete');
  const matcherSandbox = {};
  vm.runInNewContext(serverText.slice(matcherStart, matcherEnd), matcherSandbox, { filename: 'netease-source-match-helpers.js' });
  const matchSource = {
    id: 441102546,
    name: 'I Was King',
    dt: 238826,
    ar: [{ id: 20878, name: 'ONE OK ROCK' }],
    h: { br: 320000, size: 9555636, sr: 44100 },
    m: { br: 192000, size: 5733399, sr: 44100 },
    l: { br: 128000, size: 3822280, sr: 44100 },
  };
  const exactDuplicate = {
    id: 1931495429,
    name: 'I Was King',
    dt: 238826,
    ar: [{ id: 20878, name: 'ONE OK ROCK' }],
    h: { br: 320000, size: 9555636, sr: 44100 },
    m: { br: 192000, size: 5733399, sr: 44100 },
    l: { br: 128000, size: 3822280, sr: 44100 },
    __privilege: { pl: 320000, plLevel: 'exhigh' },
  };
  const liveVersion = Object.assign({}, exactDuplicate, { id: 9991, name: 'I Was King (Live)' });
  const wrongArtist = Object.assign({}, exactDuplicate, { id: 9992, ar: [{ id: 1, name: 'Someone Else' }] });
  const collaborationSource = { id: 2001, name: 'Same Song', dt: 200000, ar: [{ id: 11, name: 'A' }, { id: 12, name: 'B' }] };
  const partialCollaboration = { id: 2002, name: 'Same Song', dt: 200180, ar: [{ id: 11, name: 'A' }, { id: 13, name: 'C' }] };
  const taylorSource = { id: 3001, name: 'Love Story', dt: 235000, ar: [{ id: 44266, name: 'Taylor Swift' }] };
  const taylorVersion = { id: 3002, name: "Love Story (Taylor's Version)", dt: 235200, ar: [{ id: 44266, name: 'Taylor Swift' }] };
  const metadataReencode = { id: 3003, name: 'Love Story', dt: 235213, ar: [{ id: 44266, name: 'Taylor Swift' }] };
  const popMix = { id: 3004, name: 'Love Story (Pop Mix)', dt: 235400, ar: [{ id: 44266, name: 'Taylor Swift' }] };
  const officialAlternate = { id: 3005, name: 'Love Story', dt: 236067, ar: [{ id: 44266, name: 'Taylor Swift' }], __officialSourceMatch: true };
  const unofficialLongDrift = Object.assign({}, officialAlternate, { id: 3006, __officialSourceMatch: false });
  if (
    matcherSandbox.neteaseSourceMatchFingerprintCount(matchSource, exactDuplicate) < 3
    || matcherSandbox.neteaseSourceMatchCandidateScore(matchSource, exactDuplicate) <= 0
    || matcherSandbox.neteaseSourceMatchCandidateScore(matchSource, liveVersion) !== -1
    || matcherSandbox.neteaseSourceMatchCandidateScore(matchSource, wrongArtist) !== -1
    || matcherSandbox.neteaseSourceMatchCandidateScore(collaborationSource, partialCollaboration) !== -1
    || matcherSandbox.neteaseSourceMatchCandidateScore(taylorSource, taylorVersion) !== -1
    || matcherSandbox.neteaseSourceMatchCandidateScore(taylorSource, metadataReencode) <= 0
    || matcherSandbox.neteaseSourceMatchCandidateScore(taylorSource, popMix) !== -1
    || matcherSandbox.neteaseSourceMatchCandidateScore(taylorSource, officialAlternate) <= 0
    || matcherSandbox.neteaseSourceMatchCandidateScore(taylorSource, unofficialLongDrift) !== -1
  ) {
    fail('Netease matching must accept exact/re-encoded tracks and reject live, re-recorded, wrong-artist, or partial-collaboration candidates');
  }
  const mergeStart = serverText.indexOf('function neteaseSourceMatchHintArtists');
  const mergeEnd = serverText.indexOf('async function findNeteaseSameTrackCandidates', mergeStart);
  vm.runInNewContext(serverText.slice(mergeStart, mergeEnd), matcherSandbox, { filename: 'netease-source-match-merge.js' });
  const mergedGraySong = matcherSandbox.mergeNeteaseSourceMatchSong(
    { id: 4001, name: '', ar: [], al: {}, dt: 238826 },
    { id: 4001, name: 'I Was King', ar: [{ id: 20878, name: 'ONE OK ROCK' }], al: { name: 'Ambitions' }, dt: 238826 },
    { artistIds: '20878', artistNames: 'ONE OK ROCK', album: 'Ambitions' }
  );
  if (mergedGraySong.name !== 'I Was King' || !mergedGraySong.ar.length || mergedGraySong.ar[0].id !== 20878 || mergedGraySong.al.name !== 'Ambitions') {
    fail('gray Netease song details must be hydrated from search results and frontend metadata');
  }
  const applyStart = playbackText.indexOf('function clearNeteaseSourceMatchMetadata');
  const applyEnd = playbackText.indexOf('function neteaseSourceMatchTriedIds', applyStart);
  const applySandbox = { Number };
  vm.runInNewContext(playbackText.slice(applyStart, applyEnd), applySandbox, { filename: 'netease-source-match-metadata.js' });
  const originalQueueSong = { provider: 'netease', id: 'original-1', name: 'Original', artist: 'Artist', album: 'Album', cover: 'cover.jpg' };
  const originalIdentity = JSON.stringify(originalQueueSong);
  applySandbox.applyNeteaseSourceMatchMetadata(originalQueueSong, { sourceMatch: true, resolvedNeteaseId: 'playable-2', source: 'netease-same-track', matchKind: 'netease_same_recording', matchedSong: { album: 'Other Release' } });
  if (originalQueueSong.id !== 'original-1' || originalQueueSong.provider !== 'netease' || originalQueueSong.name !== 'Original' || originalQueueSong.artist !== 'Artist' || originalQueueSong.album !== 'Album' || originalQueueSong.cover !== 'cover.jpg' || originalQueueSong.resolvedNeteaseId !== 'playable-2' || originalIdentity === JSON.stringify(originalQueueSong)) {
    fail('Netease source-match metadata must annotate playback without replacing original queue identity, cover, lyrics context, or album');
  }
  const retryStart = playbackText.indexOf('function neteaseSourceMatchTriedIds');
  const retryEnd = playbackText.indexOf('async function resolveAlbumGaplessPlaybackData', retryStart);
  const retrySandbox = {
    Array,
    Object,
    Math,
    Number,
    String,
    console,
    encodeURIComponent,
    trackSwitchToken: 7,
    neteasePlaybackMatchQuery(song, opts) {
      retrySandbox.matchQuery = { song, opts };
      return '&excludeIds=' + encodeURIComponent((opts.excludeIds || []).join(',')) + '&skipDirect=1';
    },
    async apiJson(url) {
      retrySandbox.retryUrl = url;
      return { sourceMatch: true, url: 'https://candidate-b.invalid/audio', resolvedNeteaseId: 'candidate-b', sourceMatchTriedIds: ['candidate-a', 'candidate-b'] };
    },
    async playQueueAt(idx, opts) {
      retrySandbox.trackSwitchToken += 1;
      retrySandbox.retryPlayback = { idx, opts };
      return true;
    },
  };
  vm.runInNewContext(playbackText.slice(retryStart, retryEnd), retrySandbox, { filename: 'netease-source-match-retry.js' });
  const retrySong = { provider: 'netease', id: 'original-1', name: 'Original', artist: 'Artist' };
  const retryResult = await retrySandbox.retryNeteaseSourceMatchPlayback(retrySong, { sourceMatch: true, resolvedNeteaseId: 'candidate-a', sourceMatchTriedIds: ['candidate-a'] }, 0, 7, {}, 'standard');
  if (retryResult !== true || retrySong.id !== 'original-1' || !retrySandbox.matchQuery || retrySandbox.matchQuery.opts.excludeIds[0] !== 'candidate-a' || !retrySandbox.matchQuery.opts.skipDirect || !retrySandbox.retryPlayback || retrySandbox.retryPlayback.opts.preResolvedPlaybackData.resolvedNeteaseId !== 'candidate-b') {
    fail('failed browser decode must exclude the first Netease candidate, retry the next candidate, and keep the original queue identity');
  }

  const status = {
    netease: { loggedIn: true },
    qq: { loggedIn: false, playbackKeyReady: false },
    kugou: { loggedIn: false, playbackKeyReady: false },
  };
  const notices = [];
  const sourceSong = { provider: 'netease', id: 'ne-1', name: 'I Was King', artist: 'ONE OK ROCK' };
  const media = {
    src: 'https://old.invalid/audio',
    paused: false,
    ended: true,
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() {},
  };
  const sandbox = {
    console,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(fn) { fn(); },
    normalizePlaybackProvider(provider) { return ['qq', 'kugou', 'qishui', 'spotify'].includes(provider) ? provider : 'netease'; },
    songProviderKey(song) { return song && song.provider || 'netease'; },
    platformStatus(provider) { return status[provider] || { loggedIn: false }; },
    accountProviderOrder() { return ['netease', 'qq', 'kugou', 'qishui', 'spotify']; },
    providerVipLevel() { return 'none'; },
    queueItemKey(song) { return (song && song.provider || '') + ':' + (song && (song.id || song.mid) || ''); },
    hydrateCustomCover(song) { return song; },
    sourceCandidateRejectReason() { return ''; },
    cloneSong(song) { return Object.assign({}, song); },
    normalizePlaybackQuality(value) { return value || 'hires'; },
    normalizePlaybackQualityForProvider(value) { return value || 'hires'; },
    getProviderPlaybackQuality() { return 'hires'; },
    playbackQualityLabel(value) { return value; },
    markPlaybackQualityRuntimeCap() {},
    pendingPlaybackResumeAt: 0,
    playQueue: [sourceSong],
    currentIdx: 0,
    trackSwitchToken: 1,
    audio: media,
    audioFadeSerial: 0,
    playToggleBusy: true,
    playing: true,
    miniQueueOpen: false,
    hideLoading() { sandbox.loadingHidden = true; },
    forcePlaybackControlsInteractive() { sandbox.controlsReleased = true; },
    clearAudioFadeTimers() {},
    setPlayIcon(value) { sandbox.iconPlaying = value; },
    syncPlaybackStateFromAudioEvent() {},
    safeRenderQueuePanel() {},
    safeShelfRebuild() {},
    updateControlTrackInfo() {},
    showToast() {},
    showSourceFallbackNotice(title, body) { notices.push({ title, body }); },
    document: { getElementById() { return null; }, body: { appendChild() {} } },
    apiJson: async function () { sandbox.searchCalls += 1; return { songs: [] }; },
    resolveAlbumGaplessPlaybackData: async function () { return { url: 'https://candidate.invalid/audio' }; },
    playQueueAt: async function () { sandbox.childPlayCalls += 1; sandbox.trackSwitchToken += 1; return false; },
    searchCalls: 0,
    childPlayCalls: 0,
  };
  // 平台注册表要一同进沙箱：本模块在**加载时**就用它取清单
  //（`var SOURCE_FALLBACK_DIRECT_PROVIDERS = providerRegistryKeysWith('directFallback')`）。
  // 真实加载也是这样 —— index-loader 把模块拼成一个 script，注册表排在消费方之前。
  // The registry rides along: this module calls it at load time to build its list, exactly as in
  // production, where index-loader concatenates the registry ahead of its consumers.
  vm.runInNewContext(providerRegistrySourceText() + '\n' + fallbackText, sandbox, { filename: '11-provider-fallback.js' });
  sandbox.showSourceFallbackNotice = function (title, body) { notices.push({ title, body }); };
  const noTargetProviders = sandbox.alternatePlaybackProviders(sourceSong);
  if (noTargetProviders.length !== 0) fail('Netease-only login must not silently select logged-out QQ or Kugou');
  const noTargetResult = await sandbox.tryAutoPlaybackFallback(sourceSong, { category: 'url_unavailable' }, 0, 1, {});
  if (noTargetResult !== false || sandbox.searchCalls !== 0 || sandbox.childPlayCalls !== 0 || sandbox.playQueue[0].provider !== 'netease' || media.src !== '' || sandbox.playing !== false || sandbox.playToggleBusy !== false || !sandbox.loadingHidden || !sandbox.controlsReleased) {
    fail('Netease-only fallback must terminate without search, queue mutation, stale audio, or locked controls');
  }

  status.qq = { loggedIn: true, playbackKeyReady: true };
  sandbox.playQueue = [sourceSong];
  sandbox.currentIdx = 0;
  sandbox.trackSwitchToken = 10;
  sandbox.audio = Object.assign({}, media, { src: 'https://old.invalid/audio', paused: false, ended: true });
  sandbox.playToggleBusy = true;
  sandbox.playing = true;
  sandbox.searchCalls = 0;
  sandbox.childPlayCalls = 0;
  notices.length = 0;
  sandbox.apiJson = async function () {
    sandbox.searchCalls += 1;
    return { songs: [{ provider: 'qq', id: 'qq-1', mid: 'qq-1', name: sourceSong.name, artist: sourceSong.artist }] };
  };
  const failedCandidateResult = await sandbox.tryAutoPlaybackFallback(sourceSong, { category: 'url_unavailable' }, 0, 10, {});
  if (failedCandidateResult !== false || sandbox.playQueue[0].provider !== 'netease' || sandbox.childPlayCalls !== 1 || notices.some(item => item.title === '已自动切换音源')) {
    fail('a probed candidate whose media start fails must roll back the original source and never announce success');
  }
  delete sourceSong._lastPlaybackFailAt;
  sandbox.playQueue = [sourceSong, { provider: 'netease', id: 'ne-2', name: 'Next' }];
  sandbox.trackSwitchToken = 20;
  const skippedPlaybackOpts = [];
  sandbox.playQueueAt = async function (idx, opts) {
    skippedPlaybackOpts.push({ idx, opts });
    return true;
  };
  const defaultSkipResult = await sandbox.skipFailedQueueItem(0, 20, '', { silent: true });
  delete sourceSong._lastPlaybackFailAt;
  const preservedSkipResult = await sandbox.skipFailedQueueItem(0, 20, '', { silent: true, playbackOpts: { startupAutoplay: true, fallbackDepth: 0 } });
  if (
    defaultSkipResult !== true
    || preservedSkipResult !== true
    || skippedPlaybackOpts.length !== 2
    || skippedPlaybackOpts[0].opts.fallbackDepth !== 0
    || skippedPlaybackOpts[0].opts.skipShuffleOrder !== true
    || skippedPlaybackOpts[1].opts.startupAutoplay !== true
    || skippedPlaybackOpts[1].opts.fallbackDepth !== 0
    || skippedPlaybackOpts[1].opts.skipShuffleOrder !== true
  ) {
    fail('failed queue items must advance without reshuffling while preserving the caller playback options');
  }
  if (
    !/SOURCE_FALLBACK_MAX_QUEUE_ADVANCES\s*=\s*2/.test(fallbackText)
    || !/SOURCE_FALLBACK_MAX_PROVIDER_ATTEMPTS\s*=\s*4/.test(fallbackText)
    || !/recovery\.visitedSongKeys/.test(fallbackText)
    || !/recovery\.attemptedProviderKeys/.test(fallbackText)
    || !/beginSourceFallbackPlaybackInvocation\(opts\)/.test(playbackText)
    || !/clearPlaybackResumeWatchdogs\(\)/.test(fallbackText)
  ) {
    fail('automatic recovery must use one finite transaction with queue/provider dedupe and watchdog invalidation');
  }
  console.log('[OK] Provider fallback respects active credentials, commits after playback, and reaches a clean terminal state.');
}

function checkSearchGlassEntranceGuard() {
  logStep('Search glass entrance guard');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const glassText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '15-control-glass-animations.js'), 'utf8');
  const searchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '07-search.js'), 'utf8');
  const peekText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '02-peek-panels-upload.js'), 'utf8');
  const searchPillDirectSvg = /html\.control-glass-svg-ok\s+\.search-mode-tabs button,[ \t]*\r?\nhtml\.control-glass-svg-ok\s+\.search-history-chip\s*\{[\s\S]{0,260}backdrop-filter:\s*url\(#mineradio-search-pill-glass-filter\)\s+saturate\(1\)\s*!important[\s\S]{0,220}-webkit-backdrop-filter:\s*url\(#mineradio-search-pill-glass-filter\)\s+saturate\(1\)\s*!important/.test(cssText);
  const searchAreaKeepsGlassComposited =
    /#search-area\s*\{[\s\S]{0,120}top:\s*-76px[\s\S]{0,220}transition:\s*top\s+\.45s[\s\S]{0,120}opacity\s+\.35s/.test(cssText) &&
    /#search-area\.peek\s*\{[\s\S]{0,80}top:\s*24px[\s\S]{0,80}opacity:\s*1[\s\S]{0,80}pointer-events:\s*auto/.test(cssText) &&
    !/Search entrance mirrors the bottom player reveal|#search-box\s*>\s*\*/.test(cssText);
  const searchBoxUsesSavedRgbGlassSurface =
    /#search-box\s*\{[\s\S]{0,90}overflow:\s*visible[\s\S]{0,60}isolation:\s*isolate/.test(cssText) &&
    /#search-box::before\s*\{[\s\S]{0,90}content:\s*none\s*!important/.test(cssText) &&
    /#search-box\s*\{[\s\S]{0,220}background:\s*transparent\s*!important[\s\S]{0,220}box-shadow:\s*none\s*!important[\s\S]{0,220}backdrop-filter:\s*none\s*!important[\s\S]{0,160}-webkit-backdrop-filter:\s*none\s*!important/.test(cssText) &&
    /#search-area\.peek\s+#search-box\s*\{[\s\S]{0,220}background:\s*var\(--saved-panel-glass-bg\)\s*!important[\s\S]{0,220}box-shadow:\s*var\(--saved-panel-glass-shadow\)\s*!important[\s\S]{0,220}backdrop-filter:\s*var\(--saved-panel-glass-filter\)\s*!important/.test(cssText) &&
    /html\.control-glass-svg-ok\s+#search-area\.peek\s+#search-box\s*\{[\s\S]{0,180}backdrop-filter:\s*url\(#mineradio-search-box-glass-filter\)\s+saturate\(1\)\s*!important[\s\S]{0,180}-webkit-backdrop-filter:\s*url\(#mineradio-search-box-glass-filter\)\s+saturate\(1\)\s*!important/.test(cssText) &&
    /html\.control-glass-svg-ok\s+#search-box::before\s*\{[\s\S]{0,90}content:\s*none\s*!important/.test(cssText) &&
    /#search-box\s+#search-icon,[ \t]*\r?\n#search-box\s+#search-input\s*\{[\s\S]{0,80}position:\s*relative[\s\S]{0,80}z-index:\s*1/.test(cssText) &&
    !/html\.control-glass-svg-ok\s+#search-box::before\s*\{[\s\S]{0,260}url\(#mineradio-search-box-glass-filter\)/.test(cssText) &&
    !/#search-area\s+#search-box\s*\{[\s\S]{0,260}background:\s*var\(--glass-bg\)\s*!important/.test(cssText);
  const searchPillUsesSavedRgbGlassSurface =
    /html\.control-glass-svg-ok\s+\.search-mode-tabs button,[ \t]*\r?\nhtml\.control-glass-svg-ok\s+\.search-history-chip\s*\{[\s\S]{0,180}background:\s*var\(--saved-button-glass-bg\)\s*!important[\s\S]{0,180}border-color:\s*transparent\s*!important[\s\S]{0,180}box-shadow:\s*var\(--saved-button-glass-shadow\)\s*!important[\s\S]{0,220}url\(#mineradio-search-pill-glass-filter\)/.test(cssText);
  const searchTabsRailStaysTransparent =
    /#search-area\s+\.search-mode-tabs,[ \t]*\r?\nhtml\.control-glass-svg-ok\s+#search-area\s+\.search-mode-tabs\s*\{[\s\S]{0,160}background:\s*transparent\s*!important[\s\S]{0,160}border-color:\s*transparent\s*!important[\s\S]{0,160}box-shadow:\s*none\s*!important[\s\S]{0,160}backdrop-filter:\s*none\s*!important[\s\S]{0,160}-webkit-backdrop-filter:\s*none\s*!important/.test(cssText);
  const searchHistoryFrostedSurfaceOk =
    /function setSearchHistorySurface\(on\)\s*\{[\s\S]{0,120}classList\.toggle\('search-history-surface',\s*!!on\)/.test(searchText) &&
    /function renderSearchHistory\(\)\s*\{[\s\S]{0,900}setSearchHistorySurface\(true\)/.test(searchText) &&
    /function renderSongSearchResults\(songs\)\s*\{[\s\S]{0,120}setSearchHistorySurface\(false\)/.test(searchText) &&
    /#search-results\.search-history-surface,[ \t]*\r?\nhtml\.control-glass-svg-ok\s+#search-results\.search-history-surface\s*\{[\s\S]{0,320}background:\s*linear-gradient\([\s\S]{0,180}!important[\s\S]{0,220}backdrop-filter:\s*blur\(34px\)\s+saturate\(1\.34\)\s+brightness\(1\.08\)\s*!important/.test(cssText) &&
    !/#search-results\.search-history-surface[\s\S]{0,260}background:\s*rgba\(0,\s*0,\s*0,\s*\.90\)/.test(cssText);
  const searchResultsFrostedSurfaceOk =
    /#search-results\.show:not\(\.search-history-surface\),[ \t]*\r?\nhtml\.control-glass-svg-ok\s+#search-results\.show:not\(\.search-history-surface\)\s*\{[\s\S]{0,320}background:\s*linear-gradient\([\s\S]{0,180}!important[\s\S]{0,220}backdrop-filter:\s*blur\(34px\)\s+saturate\(1\.34\)\s+brightness\(1\.08\)\s*!important/.test(cssText) &&
    /#search-results\.show:not\(\.search-history-surface\)\s+\.search-result\s*\{[\s\S]{0,180}background:\s*rgba\(255,\s*255,\s*255,\s*\.026\)\s*!important/.test(cssText);
  const searchProviderCapabilityFilterOk =
    /function searchProviderCanSearch\(provider\)/.test(searchText) &&
    /function activeSearchProvidersForMode\(mode\)\s*\{[\s\S]{0,260}MUSIC_SEARCH_PROVIDER_ORDER\.filter\(searchProviderCanSearch\)/.test(searchText) &&
    /function searchProviderLoginNotice\(mode\)/.test(searchText) &&
    /Promise\.allSettled\(fetchProviders\.map\(function\s*\(provider\)/.test(searchText) &&
    /function loadNextMusicSearchPage\(expectedKey\)/.test(searchText) &&
    /new IntersectionObserver/.test(searchText) &&
    /mergeSongSearchResults\(neteaseSongs,\s*qqSongs,\s*kugouSongs,\s*qishuiSongs,\s*spotifySongs/.test(searchText);
  const searchFusionRankingOk =
    /function searchPopularityScore\(song,\s*sourceIndex\)/.test(searchText) &&
    /function searchCanonicalSongKey\(song\)/.test(searchText) &&
    /氛围\|浴室\|节奏版\|进行曲/.test(searchText) &&
    /var providerSeen = \{\};[\s\S]{0,80}var canonicalSeen = \{\};/.test(searchText) &&
    /score \+= searchPopularityScore\(song,\s*sourceIndex\)/.test(searchText);
  const searchHistorySharedAcrossTabsOk =
    /SEARCH_HISTORY_STORE_VERSION\s*=\s*3/.test(searchText) &&
    /return \{ version: SEARCH_HISTORY_STORE_VERSION, items: \[\] \}/.test(searchText) &&
    /function readSearchHistory\(\)\s*\{[\s\S]{0,120}\.items\.slice\(\)/.test(searchText) &&
    /function runSearchHistory\(q\)/.test(searchText) &&
    /function doPodcastSearch\(q\)[\s\S]{0,700}rememberSearchQuery\(q\)/.test(searchText) &&
    /if \(!renderSearchHistory\(\) && searchMode === 'podcast'\) loadPodcastHot\(\)/.test(searchText) &&
    !/data-history-mode/.test(searchText);
  const searchBoxFilterText = (indexText.match(/<filter id="mineradio-search-box-glass-filter"[\s\S]*?<\/filter>/) || [''])[0];
  const searchPillFilterText = (indexText.match(/<filter id="mineradio-search-pill-glass-filter"[\s\S]*?<\/filter>/) || [''])[0];
  const searchBoxSourceMergeCount = (searchBoxFilterText.match(/<feMergeNode in="SourceGraphic"/g) || []).length;
  const searchPillSourceMergeCount = (searchPillFilterText.match(/<feMergeNode in="SourceGraphic"/g) || []).length;
  const searchBoxFilterMatchesSavedRgbGlass =
    /css\/index\.css\?v=20260716-we-continuity-vsync/.test(indexText) &&
    /x="-24%"\s+y="-34%"\s+width="158%"/.test(searchBoxFilterText) &&
    /height="168%"/.test(searchBoxFilterText) &&
    /id="search-box-glass-map"\s+x="-10%"\s+y="-4%"\s+width="120%"\s+height="108%"/.test(searchBoxFilterText) &&
    searchBoxSourceMergeCount === 3 &&
    /scale="180"[\s\S]{0,120}xChannelSelector="R"[\s\S]{0,120}yChannelSelector="B"/.test(searchBoxFilterText) &&
    /<feOffset in="dispRed" dx="-90" dy="0" result="dispRedShifted"/.test(searchBoxFilterText) &&
    /scale="170"[\s\S]{0,120}xChannelSelector="R"[\s\S]{0,120}yChannelSelector="B"/.test(searchBoxFilterText) &&
    /scale="160"[\s\S]{0,120}xChannelSelector="R"[\s\S]{0,120}yChannelSelector="B"/.test(searchBoxFilterText) &&
    /<feBlend in="rg" in2="blue" mode="screen" result="output"/.test(searchBoxFilterText) &&
    /<feGaussianBlur in="output" stdDeviation="0\.5"/.test(searchBoxFilterText) &&
    /x="-48%"\s+y="-68%"/.test(searchPillFilterText) &&
    /width="210%"\s+height="236%"/.test(searchPillFilterText) &&
    /id="search-pill-glass-map"\s+x="-24%"\s+y="-14%"\s+width="148%"\s+height="128%"/.test(searchPillFilterText) &&
    searchPillSourceMergeCount === 3 &&
    /scale="118"[\s\S]{0,120}xChannelSelector="R"[\s\S]{0,120}yChannelSelector="B"/.test(searchPillFilterText) &&
    /<feOffset in="dispRed" dx="-34" dy="0" result="dispRedShifted"/.test(searchPillFilterText) &&
    /scale="108"[\s\S]{0,120}xChannelSelector="R"[\s\S]{0,120}yChannelSelector="B"/.test(searchPillFilterText) &&
    /scale="100"[\s\S]{0,120}xChannelSelector="R"[\s\S]{0,120}yChannelSelector="B"/.test(searchPillFilterText) &&
    /<feGaussianBlur in="output" stdDeviation="0\.35"/.test(searchPillFilterText) &&
    !/searchChromaNoise|searchChromaTint|chromaticOutput/.test(searchBoxFilterText) &&
    !/searchPillChromaNoise|searchPillChromaTint|chromaticPillOutput/.test(searchPillFilterText) &&
    !/result="refracted"|xChannelSelector="G"/.test(searchBoxFilterText) &&
    !/result="refracted"|xChannelSelector="G"/.test(searchPillFilterText);
  const searchPillSvgOk = searchPillDirectSvg && searchPillUsesSavedRgbGlassSurface;
  const chromaticOffsetFunctionText = (glassText.match(/function applyControlGlassChromaticOffset\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  const searchGlassUsesSavedRgbMapOk =
    /function generateAccountPillGlassDisplacementMap\(width,\s*height,\s*radius,\s*minWidth,\s*minHeight\)/.test(glassText) &&
    !/SEARCH_BOX_GLASS_CHROMA|SEARCH_PILL_GLASS_CHROMA/.test(glassText) &&
    !/mineradio-search-box-glass-filter|mineradio-search-pill-glass-filter/.test(chromaticOffsetFunctionText) &&
    /function generateSearchBoxGlassDisplacementMap/.test(glassText) &&
    /generateControlGlassDisplacementMap\(width,\s*height,\s*radius\)/.test(glassText) &&
    /function generateSearchPillGlassDisplacementMap/.test(glassText) &&
    /updateGlassDisplacementMapForElement\([\s\S]{0,260}generateSearchBoxGlassDisplacementMap/.test(glassText) &&
    /generateSearchPillGlassDisplacementMap\(width,\s*height,\s*radius\)/.test(glassText) &&
    !/generateSearchBoxGlassDisplacementMap[\s\S]{0,140}generateAccountPillGlassDisplacementMap/.test(glassText);
  const searchGlassPrewarmOk =
    /function glassImageHasHref/.test(glassText) &&
    /function queueSearchGlassReadyAfterPaint/.test(glassText) &&
    /setSearchGlassPriming\(true\)/.test(glassText) &&
    /var frames = 3/.test(glassText) &&
    /function syncSearchGlassReadyState/.test(glassText) &&
    /classList\.toggle\('search-glass-ready', on\)/.test(glassText) &&
    /classList\.toggle\('search-glass-priming', on\)/.test(glassText) &&
    /classList\.toggle\('search-glass-fallback', on\)/.test(glassText) &&
    /function prepareSearchGlassBeforePeek/.test(glassText) &&
    /requestAnimationFrame\(prepareSearchGlassBeforePeek\)/.test(glassText) &&
    /setTimeout\(prepareSearchGlassBeforePeek,\s*140\)/.test(glassText) &&
    /syncSearchGlassReadyState\(true,\s*false\)/.test(glassText) &&
    /syncSearchGlassReadyState\(changed,\s*changed\)/.test(glassText);
  const setPeekPreparesBeforeShow =
    (() => {
      const start = peekText.indexOf('function setPeek(el, on, key)');
      const end = peekText.indexOf('function uploadTipWasSeen');
      const setPeekBody = start >= 0 && end > start ? peekText.slice(start, end) : '';
      return /prepareSearchGlassBeforePeek/.test(setPeekBody) &&
        /scheduleSearchPeekAfterGlassReady\(el\)/.test(setPeekBody) &&
        setPeekBody.indexOf('prepareSearchGlassBeforePeek') < setPeekBody.indexOf("el.classList.add('peek')");
    })() &&
    /function scheduleSearchPeekAfterGlassReady\(el\)/.test(peekText) &&
    /function isSearchGlassReadyForReveal\(\)/.test(peekText) &&
    /function isSearchPeekRevealPending\(\)/.test(peekText) &&
    /key === 'search' && typeof prepareSearchGlassBeforePeek === 'function'/.test(peekText) &&
    /var searchGlassReady = prepareSearchGlassBeforePeek\(\)/.test(peekText) &&
    /if \(!searchGlassReady\)\s*\{[\s\S]*?scheduleSearchPeekAfterGlassReady\(el\)[\s\S]*?return;[\s\S]*?\}/.test(peekText) &&
    /\(saOn \|\| isSearchPeekRevealPending\(\)\) && !emptyHomeActive/.test(peekText);
  if (!searchHistorySharedAcrossTabsOk) {
    fail('search history must stay shared across All, provider, and Podcast tabs');
  }
  if (!searchPillDirectSvg || !searchAreaKeepsGlassComposited || !searchBoxUsesSavedRgbGlassSurface || !searchTabsRailStaysTransparent || !searchHistoryFrostedSurfaceOk || !searchResultsFrostedSurfaceOk || !searchProviderCapabilityFilterOk || !searchFusionRankingOk || !searchBoxFilterMatchesSavedRgbGlass || !searchPillSvgOk || !searchGlassUsesSavedRgbMapOk || !searchGlassPrewarmOk || !setPeekPreparesBeforeShow) {
    fail('search glass must use the saved RGB SVG surface and reveal only by opacity/transform');
  }
  console.log('[OK] Search glass uses the saved RGB SVG surface and is composited before the search panel appears.');
}

function checkProviderEntitlementBoundaryGuard() {
  logStep('Provider entitlement boundary guard');
  const kugouText = fs.readFileSync(path.join(appRoot, 'server', 'kugou-api.js'), 'utf8');
  const qishuiText = fs.readFileSync(path.join(appRoot, 'server', 'qishui-api.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const loginText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
  const userModalText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  if (/rememberKugouPlaybackVipEvidence|mergeKugouPlaybackVipEvidence|premium-quality-playback|member-track-playback/.test(kugouText)) {
    fail('Kugou playback success must never be promoted into account membership evidence');
  }
  if (!/function normalizeKugouVipPayloadV2/.test(kugouText) ||
      /\/vip\|member\|music_pack\//.test(kugouText) ||
      /const vipText = Object\.keys/.test(kugouText) ||
      !/const apiMembershipKnown = apiStates\.length > 0/.test(kugouText) ||
      !/membershipVerified:\s*apiMembershipKnown/.test(kugouText) ||
      !/const isWebRolePayload = membershipOrigin === 'kugou-web-roleinfo'/.test(kugouText) ||
      !/const freshMembershipSource = isWebRolePayload \? 'kugou-web-roleinfo' : 'kugou-vip-api'/.test(kugouText) ||
      !/membershipSource:\s*apiMembershipKnown[\s\S]*?freshMembershipSource[\s\S]*?'kugou-cookie-hint'/.test(kugouText)) {
    fail('Kugou membership must come from account-scoped API entitlement records; cookies may only provide a non-authoritative hint');
  }
  if (!/function kugouPlaybackCacheScope/.test(kugouText) ||
      !/kugouPlaybackCacheScope\(auth, membership\)/.test(kugouText) ||
      !/function kugouVipCacheKey/.test(kugouText) ||
      !/crypto\.createHash\('sha256'\)\.update\(identity\)\.digest\('hex'\)/.test(kugouText) ||
      !/rights\.canPlaySvipTracks[\s\S]{0,180}rights\.canPlayVipTracks[\s\S]{0,180}rights\.canPlayMusicPackageTracks/.test(kugouText)) {
    fail('Kugou membership and URL resolution caches must be isolated by the full account identity and verified entitlement tier');
  }
  if (!/kugouPlaybackParamsRequireVip\(params\)/.test(kugouText) ||
      !/const canAttemptMemberTrack = membershipRights\.canPlayVipTracks[\s\S]{0,100}membershipRights\.canPlayMusicPackageTracks/.test(kugouText) ||
      !/memberTrack && !canAttemptMemberTrack/.test(kugouText) ||
      !/function kugouMembershipRights/.test(kugouText) ||
      !/function kugouEffectiveQuality/.test(kugouText) ||
      !/if \(!rights\.canPlayVipTracks\) return 'standard'/.test(kugouText)) {
    fail('Kugou member tracks and premium qualities must be denied or downgraded for ordinary accounts');
  }
  if (!/api\/kugou\/song\/url/.test(serverText) || !/api\/qishui\/song\/url/.test(serverText) ||
      !/onlyVipPlayable/.test(serverText) || !/privilege/.test(serverText) || !/fee/.test(serverText) ||
      !/qqPlaybackEvidenceQuery\(song\) \+ qualityParam/.test(playbackText)) {
    fail('Kugou and Qishui playback requests must carry track entitlement hints through the server boundary');
  }
  if (!/function qishuiMembershipFromData/.test(qishuiText) ||
      !/function qishuiTrackRequiresVip/.test(qishuiText) ||
      !/function qishuiStreamRequiredTier/.test(qishuiText) ||
      !/function qishuiRequiredTierAllowed/.test(qishuiText) ||
      !/QISHUI_TRACK_SVIP_KEYS/.test(qishuiText) ||
      !/function qishuiApplyMembershipObservation/.test(qishuiText) ||
      !/membership_unknown/.test(qishuiText) ||
      !/vip_required/.test(qishuiText)) {
    fail('Qishui must strictly separate account membership from track-level VIP/SVIP restrictions and retain only bounded official evidence');
  }
  if (!/verifiedMembership/.test(loginText) ||
      !/membershipSource === 'kugou-vip-api'/.test(loginText) ||
      !/applyKugouPlaybackStatusEvidence\(data\)/.test(playbackText)) {
    fail('Kugou playback responses may update badges only when they carry verified membership API state');
  }
  if (!/\.kugou-vip-evidence\.json/.test(mainText) || !/unlink/.test(mainText)) {
    fail('Startup migration must delete deprecated persisted Kugou playback evidence for existing users');
  }
  if (!/kgVipLevel === 'svip'/.test(userModalText) || !/logout_kugou_svip/.test(userModalText) || !/logout_kugou_vip/.test(userModalText)) {
    fail('Kugou account modal must distinguish SVIP from normal VIP');
  }
  requireLocaleKeys('logout_kugou_svip', 'logout_kugou_vip');
  console.log('[OK] Provider account membership and per-track playback entitlement remain separated.');
}

function checkQQVipStatusSyncGuard() {
  logStep('QQ VIP status refresh guard');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const vipModuleText = fs.readFileSync(path.join(appRoot, 'server', 'qq-vip-api.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const loginStatusText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
  const loginFlowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'), 'utf8');
  const accountUtilsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  const userModalText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const startupText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '05-startup-bindings.js'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');

  if (!/function fetchQQVipStatus/.test(serverText) || !/SRFVipQuery_V2/.test(serverText) || !/QQ_VIP_INFO_CACHE_TTL_MS/.test(serverText) || !/forceVip/.test(serverText) || !/vipCheckedAt/.test(serverText)) {
    fail('QQ login status must include an explicit forceable VIP probe instead of relying only on profile fields');
  }
  if (!/function refreshQQConfiguredCookieStore/.test(serverText) || /function getQQLoginInfo[\s\S]{0,220}refreshConfiguredCookieStores\(true\)/.test(serverText)) {
    fail('QQ force refresh must only reload QQ cookies and must not refresh Qishui/Kugou/Netease stores');
  }
  if (!/function normalizeQQVipPayload/.test(serverText) || !/qqVipObjectLooksExpired/.test(serverText) || !/vipProbeAvailable/.test(serverText) ||
      !/decision:\s*'unknown'/.test(vipModuleText) || !/resolveQQVipFromProbes/.test(vipModuleText)) {
    fail('QQ VIP status must normalize active, expired, VIP, and SVIP signals before exposing badges');
  }
  if (!/Promise\.allSettled\(probes\.map/.test(vipModuleText) ||
      !/qqVipSessionCacheKey/.test(serverText) ||
      /qqVipInfoCache\.get\(uin\)/.test(serverText)) {
    fail('QQ VIP probes must all settle and cache results by the current account session fingerprint');
  }
  if (/vipEvidence:\s*playbackVipEvidence/.test(serverText) || /member-track-playback/.test(serverText) ||
      !/function qqPlaybackShowsMemberAccess[\s\S]{0,260}return false;/.test(loginStatusText)) {
    fail('QQ song hints and successful playback must not be promoted into persistent account VIP evidence');
  }
  if (!/function refreshQQVipStatusNow/.test(loginStatusText) || !/function qqLoginNeedsAuthorizationRefresh/.test(loginStatusText) || !/function qqMembershipNeedsSync/.test(loginStatusText) || !/forceVip=1/.test(loginStatusText) || !/window\.addEventListener\('focus'/.test(loginStatusText) || !/visibilitychange/.test(loginStatusText)) {
    fail('QQ frontend must force VIP refresh on manual refresh and foreground return');
  }
  if (!/membershipKnown !== true/.test(loginStatusText) ||
      !/Object\.assign\(\{\}, qqLoginStatus,[\s\S]{0,180}membershipStale:\s*true/.test(loginStatusText) ||
      /mergeQQPlaybackVipEvidence\(Object\.assign/.test(loginStatusText)) {
    fail('QQ frontend must keep last-known-good membership on transient failures and show unknown membership as pending');
  }
  if (!/openQQMusicLoginWindow\(owner, options\)/.test(mainText) ||
      !/const initialCookie = await readQQLoginCookieHeader\(cookieSession\);[\s\S]{0,220}qqCookieHasPlaybackLogin\(initialCookie\)[\s\S]{0,260}options\.forceReauth/.test(mainText) ||
      !/options\.forceReauth[\s\S]{0,180}clearStorageData/.test(mainText) ||
      !/openQQMusicLogin:\s*\(options\)/.test(preloadText) ||
      !/forceReauth:\s*!!\(qqLoginStatus && qqLoginStatus\.authorizationIncomplete && qqLoginStatus\.playbackKeyReady === false\)/.test(loginFlowText) ||
      /forceReauth:\s*!!\(qqLoginStatus && qqLoginStatus\.loggedIn\)/.test(loginFlowText)) {
    fail('QQ reauthorization must only clear an explicitly incomplete playback session, never every logged-in session');
  }
  if (!/function isTrustedQQLoginUrl/.test(mainText) ||
      !/action:\s*'allow'[\s\S]{0,500}partition:\s*QQ_LOGIN_PARTITION/.test(mainText) ||
      !/playbackFinalizePending[\s\S]{0,700}setTimeout\(resolveDelay,\s*450\)/.test(mainText) ||
      !/const showLoginWindow = \(\) =>[\s\S]{0,260}loginWindow\.show\(\)/.test(mainText) ||
      !/showWatchdog = setTimeout\(showLoginWindow,\s*2500\)/.test(mainText) ||
      !/const loadQQOfficialLoginEntry = async \(\) =>[\s\S]{0,700}cookieSession\.clearCache\(\)[\s\S]{0,420}QQ_LOGIN_FALLBACK_URL/.test(mainText) ||
      /loginWindow\.loadURL\('https:\/\/y\.qq\.com\/n\/ryqq\/player'\)/.test(mainText) ||
      !/function qqLoginCompletionFromCookie[\s\S]{0,500}QQ_PLAYBACK_AUTH_INCOMPLETE/.test(mainText) ||
      !/resolve\(qqLoginCompletionFromCookie\(cookie\)\)/.test(mainText)) {
    fail('QQ OAuth must stay in its official window, keep trusted popups on one partition, and reject web-only partial sessions');
  }
  if (!/async function fetchQQVipStatus[\s\S]{0,220}const musicKey = qqCookiePlaybackKey\(cookieObj\)/.test(serverText) ||
      !/async function handleQQSongUrl[\s\S]{0,500}const playbackKey = qqCookiePlaybackKey\(cookieObj\);\s*const musicKey = playbackKey;/.test(serverText) ||
      !/if \(!qqCookieUin\(obj\) \|\| !qqCookiePlaybackKey\(obj\)\)/.test(serverText) ||
      !/function qqCookieUin[\s\S]{0,180}!!obj\.wxopenid[\s\S]{0,180}obj\.wxuin/.test(serverText)) {
    fail('QQ VIP and vkey requests must use a strict QQ Music playback key and must not persist p_skey-only sessions');
  }
  if (!/cookieIsExpired/.test(mainText) || !/qqLoginCookieCandidateScore/.test(mainText) ||
      !/QQ_VKEY_REQUEST_TIMEOUT_MS = 6000/.test(serverText) ||
      !/QQ_AUDIO_PROBE_TOTAL_MS = 6200/.test(serverText) ||
      (playbackText.match(/timeoutMs: 15000/g) || []).length < 2) {
    fail('QQ cookie selection and end-to-end playback timeout budgets must be deterministic and aligned');
  }
  if (!/providerVipAuditSameUser/.test(loginStatusText) || !/lstatus_synced_suffix/.test(loginStatusText)) {
    fail('provider VIP audit must detect normal-to-VIP sync as well as VIP loss');
  }
  requireLocaleKeys('lstatus_synced_suffix');
  if (!/qqLoginStatusText/.test(loginFlowText) || !/qqNeedsMembershipSync/.test(loginFlowText) || !/login_sync_vip/.test(loginFlowText) || !/login_reopen_sync_vip/.test(loginFlowText) ||
      !/qqNeedsAuthRefresh \? openQQWebLogin : \(qqLoginStatus\.loggedIn \? refreshQr : openQQWebLogin\)/.test(loginFlowText) ||
      /qqNeedsAuthRefresh \|\| qqNeedsMembershipSync/.test(loginFlowText)) {
    fail('QQ login panel must reauthorize only missing playback credentials and use the forceVip status probe for membership sync');
  }
  requireLocaleKeys('login_sync_vip', 'login_reopen_sync_vip');
  if (!/pendingSync = providerMembershipNeedsSync\(provider, status\)/.test(accountUtilsText) || !/qqMembershipNeedsSync\(status\)/.test(accountUtilsText) || !/lmu_sync_pending/.test(accountUtilsText) || !/\.top-account-vip\.pending/.test(cssText)) {
    fail('QQ top account badge must show pending sync instead of ordinary account when membership auth is stale');
  }
  if (!/refreshQQLoginStatus\(\{ forceVip: true, reason: 'startup' \}\)/.test(startupText)) {
    fail('startup must force a QQ VIP status recheck so renewed memberships sync immediately');
  }
  if (!/logout_qq_svip/.test(userModalText) || !/logout_qq_pending/.test(userModalText) || !/refreshQQVipStatusNow\('account-modal'\)/.test(userModalText)) {
    fail('account modal must distinguish QQ SVIP and refresh QQ membership when opened');
  }
  requireLocaleKeys('logout_qq_svip', 'logout_qq_pending');
  console.log('[OK] QQ membership status can be force-refreshed after renewals.');
}

async function checkProviderAuthCookiePathGuard() {
  logStep('Provider auth cookie path guard');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const qqLoginText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'), 'utf8');
  const accountUtilsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  const playlistLoadText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');

  if (!/function getCookieFile\(\)/.test(serverText) || !/function getQQCookieFile\(\)/.test(serverText) || !/function getKugouCookieFile\(\)/.test(serverText) || !/function getQishuiCookieFile\(\)/.test(serverText)) {
    fail('provider cookie files must be resolved lazily after Electron sets userData env paths');
  }
  if (/const\s+(COOKIE_FILE|QQ_COOKIE_FILE|KUGOU_COOKIE_FILE|QISHUI_COOKIE_FILE)\s*=\s*process\.env\./.test(serverText)) {
    fail('server.js must not capture provider cookie env paths in startup constants');
  }
  if (!/configuredCookieStores/.test(serverText) || !/refreshConfiguredCookieStores\(false\)/.test(serverText) || !/saveConfiguredCookieStore/.test(serverText)) {
    fail('server.js must refresh and save provider cookie stores through the configured userData paths');
  }
  if (!/function ensureLocalServerStarted\(\)/.test(mainText) || !/function configureLocalServerEnvironment\(port\)/.test(mainText) || !/delete require\.cache\[require\.resolve\(serverModulePath\)\]/.test(mainText)) {
    fail('Electron main must configure auth storage env paths before requiring server.js');
  }
  if (!/async function loadMainWindowWithRetry\(win\)/.test(mainText) || !/const port = mainServerPort \|\| process\.env\.PORT \|\| 3000/.test(mainText) || !/win\.loadURL\(targetUrl\)/.test(mainText)) {
    fail('Main window navigation must use the configured server port through the bounded retry path');
  }
  if (!/function reportWindowCreationFailure\(context, error\)/.test(mainText) || !/function showNonBlockingErrorDialog\(title, detail, options = \{\}\)/.test(mainText) || !/showNonBlockingErrorDialog\(\s*`Mineradio 启动失败 \(\$\{code\}\)`/.test(mainText)) {
    fail('Main window startup failures must be surfaced instead of leaving a headless server process');
  }
  if (/dialog\.showErrorBox\(/.test(mainText)) {
    fail('Blocking error dialogs must not return: they freeze the main thread and hold the single-instance lock');
  }
  if (!/app\.releaseSingleInstanceLock\(\)/.test(mainText) || !/notice\.then\(\(\) => app\.quit\(\)\)/.test(mainText)) {
    fail('A failed startup must release the single-instance lock and quit once the notice is settled');
  }
  if (!/function resolveStartupErrorCode\(context, error\)/.test(mainText) || !/STARTUP_ERROR_LOG_FILE/.test(mainText) || !/MR-BOOT-SERVER-PORT/.test(mainText) || !/MR-BOOT-WINDOW-LOAD/.test(mainText) || !/startup-error\.log/.test(mainText)) {
    fail('Startup failure dialog must include stable MR-BOOT error codes and write startup-error.log');
  }
  if (!/process\.on\('uncaughtException'/.test(mainText) || !/process\.on\('unhandledRejection'/.test(mainText) || !/startupCompleted = true/.test(mainText)) {
    fail('Startup error code window must also cover uncaught startup failures before the main window finishes loading');
  }
  if (/await\s+(?:mainWindow|win)\.webContents\.session\.clearCache\(\)/.test(mainText)) {
    fail('Startup must not block first navigation on Chromium cache clearing');
  }
  if (!/let mainWindowCreatePromise = null/.test(mainText) || !/let localServerStartPromise = null/.test(mainText) || !/if \(mainWindowCreatePromise\) return mainWindowCreatePromise/.test(mainText) || !/if \(localServerStartPromise\) return localServerStartPromise/.test(mainText)) {
    fail('Server and BrowserWindow startup must each have a single in-flight promise');
  }
  if (!/STARTUP_SHOW_WATCHDOG_MS/.test(mainText) || !/function showMainWindowSafely\(win, reason\)/.test(mainText) || !/did-finish-load[\s\S]{0,160}showMainWindowSafely\(win/.test(mainText) || !/ready-to-show[\s\S]{0,120}showMainWindowSafely\(win/.test(mainText)) {
    fail('Main window must have ready-to-show, did-finish-load, and watchdog visibility fallbacks');
  }
  if (!/function createTrustedMainDocumentReadySignal\(win, expectedUrl\)/.test(mainText)
    || !/isTrustedMainDocumentUrl\(candidateUrl\)/.test(mainText)
    || !/Promise\.race\(\[observedLoadPromise, readySignal\.promise\]\)/.test(mainText)
    || !/if \(readySignal\.isReady\(\)\) return;[\s\S]{0,100}webContents\.stop\(\)/.test(mainText)
    || !/finally \{[\s\S]{0,80}readySignal\.cancel\(\)/.test(mainText)
    || !/removeListener\('did-navigate'/.test(mainText)
    || !/for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/.test(mainText)
    || !/did-fail-load/.test(mainText)
    || !/render-process-gone/.test(mainText)
    || !/unresponsive/.test(mainText)) {
    fail('Main window navigation must accept a trusted committed document, clean up readiness listeners, retry once, and preserve real failure signals');
  }
  if (!/const failedWindow = mainWindow/.test(mainText) || !/failedWindow\.destroy\(\)/.test(mainText) || !/app\.releaseSingleInstanceLock\(\)/.test(mainText) || !/notice\.then\(\(\) => app\.quit\(\)\)/.test(mainText)) {
    fail('Startup failure must destroy the hidden BrowserWindow and release the single-instance lock');
  }
  if (!/if \(mainWindow === win\)[\s\S]{0,120}mainWindow = null/.test(mainText) || !/win\.on\('closed'/.test(mainText)) {
    fail('BrowserWindow event closures must only clear the same local window instance');
  }
  if (!fs.existsSync(path.join(appRoot, 'desktop', 'startup.html')) || !/win\.loadFile\(startupShell\)/.test(mainText)) {
    fail('A lightweight packaged startup shell must remain available while the local server is preparing');
  }
  const singleInstanceBranch = mainText.indexOf('if (!gotSingleInstanceLock)');
  const startupStateCall = "writeStartupState('module-loaded'";
  if (singleInstanceBranch < 0 || mainText.slice(0, singleInstanceBranch).includes(startupStateCall) || !mainText.slice(singleInstanceBranch).includes(startupStateCall)) {
    fail('Secondary instances must quit before they can overwrite the primary startup-state.json');
  }
  if (!/function qqLoginCompletionFromCookie[\s\S]{0,420}partial:\s*true[\s\S]{0,160}QQ_PLAYBACK_AUTH_INCOMPLETE/.test(mainText) ||
      !/resolve\(qqLoginCompletionFromCookie\(cookie\)\)/.test(mainText) ||
      /partial:\s*true,\s*cookie/.test(mainText)) {
    fail('QQ login must report a web-only session as incomplete without returning its cookie for persistence');
  }
  if (/resolve\(neteaseCookieHasLogin\(cookie\)[\s\S]{0,140}!qqCookieHasPlaybackLogin/.test(mainText)) {
    fail('Netease login must not reuse QQ playback authorization checks');
  }
  if (!/if \(!qqPlaybackReady\)/.test(qqLoginText) || !/login_qq_synced_auth_incomplete/.test(qqLoginText)) {
    fail('QQ frontend login flow must not close as a full success when playback authorization is incomplete');
  }
  requireLocaleKeys('login_qq_synced_auth_incomplete', 'login_qq_synced_auth_incomplete_detail');
  if (!/Buffer\.from\(raw,\s*'hex'\)\.toString\('utf8'\)/.test(serverText) || !/QQ_LIKED_PLAYLIST_ID/.test(serverText) || !/fetchQQLikedPlaylistPage/.test(serverText) || !/music\.srfDissInfo\.DissInfo/.test(serverText) || !/method: 'CgiGetDiss'/.test(serverText) || !/song_begin: offset/.test(serverText) || !/song_num: limit/.test(serverText) || !/rawTracks\.map\(mapQQPlaylistTrack\)/.test(serverText) || !/songlist_size/.test(serverText) || !/const upstreamTotal/.test(serverText) || !/firstTrack && firstTrack\.cover/.test(serverText) || !/getCachedQQLikedPlaylistCover/.test(serverText) || !/handleQQLikedPlaylistTracks/.test(serverText) || !/QQ_LIKED_AUTH_MESSAGE/.test(serverText)) {
    fail('QQ profile hex nicknames and the CgiGetDiss liked-playlist paging/first-cover flow must stay supported');
  }
  if (/fcg_musiclist_getmyfav|fetchQQLikedPlaylistMap/.test(serverText)) {
    fail('QQ liked playlist must not regress to the retired fcg_musiclist_getmyfav endpoint or N+1 song-detail map');
  }
  if (!/created\.concat\(collected\)\.filter\(pl => !isQQFavoritePlaylist\(pl\)\)/.test(serverText) || !/base\.unshift\(likedCard\)/.test(serverText)) {
    fail('QQ user playlists must replace any raw liked card with the enriched first-track-cover card');
  }
  const favoriteStart = serverText.indexOf('function isQQLikedPlaylistId');
  const favoriteEnd = serverText.indexOf('\nfunction isQzoneBackgroundPlaylist', favoriteStart);
  const favoriteSandbox = { QQ_LIKED_PLAYLIST_ID: 'liked', QQ_LIKED_DIRID: 201, String, Number };
  vm.runInNewContext(serverText.slice(favoriteStart, favoriteEnd), favoriteSandbox, { filename: 'qq-liked-recognition.js' });
  if (!favoriteSandbox.isQQFavoritePlaylist({ id: 'ordinary', dirid: 201, name: 'anything' }) || !favoriteSandbox.isQQFavoritePlaylist({ id: 'ordinary', dirid: 0, name: '我的喜欢' }) || favoriteSandbox.isQQFavoritePlaylist({ id: 'rock', dirid: 99, name: '我喜欢的摇滚' })) {
    fail('QQ liked-card recognition must accept the official dirid/exact name without deleting ordinary user playlists that merely contain liked wording');
  }
  const likedPageStart = serverText.indexOf('async function fetchQQLikedPlaylistPage');
  const likedPageEnd = serverText.indexOf('\nfunction buildQQLikedPlaylistCard', likedPageStart);
  let qqPayload = null;
  let qqResponse = {
    req_0: {
      code: 0,
      data: {
        songlist: [
          { id: 'first', name: 'First', cover: 'album-cover' },
          { id: 'unavailable', name: '', mid: '' },
          { id: 'second', name: 'Second' },
        ],
        songlist_size: 3,
        total_song_num: 457,
        hasmore: 1,
        dirinfo: { dir_name: 'liked' },
      },
    },
  };
  const likedPageSandbox = {
    QQ_LIKED_DIRID: 201,
    qqMusicRequest: async payload => {
      qqPayload = payload;
      return qqResponse;
    },
    mapQQPlaylistTrack: track => track,
    Math,
    Number,
    parseInt,
    Error,
  };
  vm.runInNewContext(serverText.slice(likedPageStart, likedPageEnd), likedPageSandbox, { filename: 'qq-liked-page.js' });
  const likedPage = await likedPageSandbox.fetchQQLikedPlaylistPage({ limit: 48, offset: 96 });
  if (!qqPayload || qqPayload.req_0.module !== 'music.srfDissInfo.DissInfo' || qqPayload.req_0.method !== 'CgiGetDiss' || qqPayload.req_0.param.dirid !== 201 || qqPayload.req_0.param.song_begin !== 96 || qqPayload.req_0.param.song_num !== 48 || likedPage.total !== 457 || likedPage.tracks.length !== 2 || likedPage.pageSpan !== 3 || likedPage.nextOffset !== 99 || !likedPage.hasMore) {
    fail('QQ liked playlist must preserve exact CgiGetDiss paging and total/next-offset semantics');
  }
  qqResponse = { code: 0 };
  let missingBlockRejected = false;
  try {
    await likedPageSandbox.fetchQQLikedPlaylistPage({ limit: 48, offset: 0 });
  } catch (error) {
    missingBlockRejected = error && error.code === 'QQ_LIKED_SYNC_FAILED';
  }
  qqResponse = { code: 0, req_0: { code: 10004, data: { code: -100008 } } };
  let authFailureClassified = false;
  try {
    await likedPageSandbox.fetchQQLikedPlaylistPage({ limit: 48, offset: 0 });
  } catch (error) {
    authFailureClassified = error && error.code === 'QQ_LIKED_REQUIRES_PLAYBACK_LOGIN';
  }
  if (!missingBlockRejected || !authFailureClassified) {
    fail('QQ liked sync must reject incomplete musicu responses and classify expired playback authorization explicitly');
  }
  qqResponse = {
    req_0: {
      code: 0,
      data: { songlist: [], songlist_size: 0, total_song_num: 457, hasmore: 0 },
    },
  };
  const beyondEndPage = await likedPageSandbox.fetchQQLikedPlaylistPage({ limit: 48, offset: 480 });
  if (beyondEndPage.total !== 457 || beyondEndPage.nextOffset !== 480 || beyondEndPage.hasMore) {
    fail('QQ liked sync must preserve upstream total on an empty beyond-end page');
  }
  const likedCardStart = serverText.indexOf('function buildQQLikedPlaylistCard');
  const likedCardEnd = serverText.indexOf('\nasync function getQQLikedPlaylistCard', likedCardStart);
  const likedCoverCacheStart = serverText.indexOf('const qqLikedPlaylistCoverByUser');
  const likedCoverCacheEnd = serverText.indexOf('\nfunction isQQLikedPlaylistId', likedCoverCacheStart);
  const likedCardSandbox = {
    QQ_LIKED_PLAYLIST_ID: 'qq-liked',
    QQ_LIKED_DIRID: 201,
    QQ_LIKED_PLAYLIST_NAME: 'Liked',
    QQ_LIKED_PLAYLIST_COVER: 'fallback-cover',
    Map,
    String,
    Math,
    Number,
  };
  vm.runInNewContext(serverText.slice(likedCoverCacheStart, likedCoverCacheEnd) + '\n' + serverText.slice(likedCardStart, likedCardEnd), likedCardSandbox, { filename: 'qq-liked-card.js' });
  const likedInfo = { userId: 'listener-1', nickname: 'Listener' };
  const firstPageForCard = { tracks: [{ id: 'first', name: 'First', cover: 'album-cover' }], total: 457, offset: 0 };
  const likedCard = likedCardSandbox.buildQQLikedPlaylistCard(likedInfo, firstPageForCard, '');
  const secondPageCard = likedCardSandbox.buildQQLikedPlaylistCard(likedInfo, { tracks: [{ id: 'page-49', name: 'Page 49', cover: 'page-2-cover' }], total: 457, offset: 48 }, '');
  const emptiedCard = likedCardSandbox.buildQQLikedPlaylistCard(likedInfo, { tracks: [], total: 0, offset: 0 }, '');
  if (!likedCard || likedCard.cover !== 'album-cover' || likedCard.trackCount !== 457 || secondPageCard.cover !== 'album-cover' || emptiedCard.cover !== 'fallback-cover') {
    fail('QQ liked playlist card must keep the first album cover stable across pages and clear it when the playlist becomes empty');
  }
  if (!/var liked = isLikedPlaylistContext\(id, title, r && r\.playlist\)/.test(playlistLoadText) || !/if \(liked\) markSongsLiked\(playQueue, true\)/.test(playlistLoadText) || !/if \(state\.liked\) markSongsLiked\(pageTracks, true\)/.test(playlistLoadText)) {
    fail('QQ/Spotify virtual liked playlists must mark loaded queue tracks as liked');
  }
  if (!/data-login-provider-sort/.test(qqLoginText) || !/login-provider-sort-handle/.test(qqLoginText) || !/closest\('\[data-login-provider-sort\]'\)/.test(qqLoginText) || !/closest\('\.flow-port\.out'\)/.test(qqLoginText)) {
    fail('login workflow must split provider sorting onto a left drag handle and keep wiring on the right flow port');
  }
  const loginProviderExternalSwitchOk =
    /function handleLoginProviderExternalSwitchEvent\(e,\s*provider\)/.test(qqLoginText) &&
    /externalSwitch\.setAttribute\('role',\s*'switch'\)/.test(qqLoginText) &&
    /externalSwitch\.setAttribute\('aria-checked'/.test(qqLoginText) &&
    /login_provider_external_label_html/.test(qqLoginText) &&
    /externalSwitch\.addEventListener\('click'[\s\S]{0,180}handleLoginProviderExternalSwitchEvent/.test(qqLoginText) &&
    !/function selectLoginProviderNode\(provider\)\s*\{[\s\S]{0,260}toggleAccountProviderExternal\(provider\)/.test(qqLoginText) &&
    /\.login-provider-external-switch\s*\{[\s\S]{0,220}width:\s*56px[\s\S]{0,360}pointer-events:\s*auto/.test(cssText) &&
    /\.login-provider-external-label\s*\{/.test(cssText) &&
    /button\.external-on \.login-provider-external-switch i\s*\{[\s\S]{0,80}left:\s*38px/.test(cssText);
  if (!loginProviderExternalSwitchOk) {
    fail('login provider capsules must show a real on/off switch for external top-pill visibility');
  }
  requireLocaleKeys('login_provider_external_label_html');
  if (/Math\.abs\(dy\)\s*>\s*Math\.abs\(dx\)[\s\S]{0,80}\?\s*'sort'\s*:\s*'wire'/.test(qqLoginText) || /mode\s*===\s*'wire'/.test(qqLoginText)) {
    fail('login workflow must not guess sort vs wire from drag direction');
  }
  if (!/function scheduleLoginWorkflowEdges/.test(qqLoginText) || !/scheduleLoginWorkflowEdges\('open'\)/.test(qqLoginText) || !/scheduleLoginWorkflowEdges\('node-ui'\)/.test(qqLoginText) || !/scheduleLoginWorkflowEdges\('resize'\)/.test(qqLoginText)) {
    fail('login workflow edges must be rescheduled after modal open, UI layout changes, and resize to avoid offset lines');
  }
  if (!/function captureAccountProviderRects/.test(accountUtilsText) || !/function animateAccountProviderReorder/.test(accountUtilsText) || !/provider-reorder-moving/.test(accountUtilsText) || !/return order\.filter\(function \(provider\) \{ return selected\.indexOf\(provider\) >= 0; \}\);/.test(accountUtilsText)) {
    fail('provider capsule order must use FLIP animation and external pills must follow the explicit highlighted list');
  }
  if (!/\.login-provider-sort-handle/.test(cssText) || !/grid-template-columns:\s*18px\s+35px\s+minmax\(0,\s*1fr\)\s+auto/.test(cssText) || !/\.top-account-pill\.provider-reorder-moving/.test(cssText)) {
    fail('provider capsule sorting must expose a left drag handle and animated reorder styles');
  }
  console.log('[OK] Provider auth cookies stay on userData paths and QQ partial login is explicit.');
}

function checkPlaybackResumeRecoveryGuard() {
  logStep('Long-pause playback resume recovery guard');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const progressText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js'), 'utf8');
  if (!/playbackResumeRecovery/.test(coreStoreText) || !/pausedAt/.test(coreStoreText) || !/PLAYBACK_RESUME_STALL_DELAYS/.test(coreStoreText) || !/PLAYBACK_RESUME_LONG_PAUSE_MS/.test(coreStoreText) || !/PLAYBACK_RESUME_LONG_PAUSE_PROVIDER_MS/.test(coreStoreText)) {
    fail('global playback resume recovery state must be defined');
  }
  if (!/function recoverCurrentTrackPlaybackFromFreshUrl/.test(controlsText) || !/playQueueAt\(currentIdx,[\s\S]{0,260}resumeRecovery: true/.test(controlsText)) {
    fail('long-pause recovery must refresh the current provider URL and resume from the old position');
  }
  if (!/function updatePlaybackResumePauseMarker/.test(controlsText) || !/function playbackResumePausedLongEnough/.test(controlsText) || !/recoverCurrentTrackPlaybackFromFreshUrl\('long-pause-stale-source'/.test(controlsText) || !/updatePlaybackResumePauseMarker\(reason\)/.test(fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js'), 'utf8'))) {
    fail('manual resume after a long pause must refresh stale provider URLs before trying the old audio src');
  }
  if (!/function schedulePlaybackStallRecovery/.test(controlsText) || !/ensureAudiblePlaybackGain\('resume-stall-before-refresh'\)/.test(controlsText) || !/recoverCurrentTrackPlaybackFromFreshUrl\('play-rejected'/.test(controlsText)) {
    fail('playback resume recovery must cover rejected play() and stalled media after WebAudio checks');
  }
  if (!/function trackSwitchStallRecoveryAllowed/.test(controlsText) || !/playbackResumeProvider\(song\) === 'qishui'/.test(controlsText) || !/\(opts\.trackSwitch \|\| opts\.manual \|\| opts\.fastResume\)/.test(controlsText) || !/function nudgeQishuiTrackStart/.test(controlsText) || !/qishui-track-start-stalled/.test(controlsText) || /if \(opts\.trackSwitch && !opts\.resumeRecovery\) return;/.test(controlsText)) {
    fail('Qishui auto-next start stalls must be watched, nudged, and refreshed instead of skipping track-switch recovery');
  }
  if (
    !/resumeRecovery: !!opts\.resumeRecovery/.test(playbackText)
    || !/audioEl !== audio/.test(progressText)
    || !/__mineradioTrackSwitchToken\) !== Number\(trackSwitchToken\)/.test(progressText)
    || !/playbackMediaMatchesCurrentQueueItem\(audioEl\)/.test(progressText)
    || !/schedulePlaybackStallRecovery\(name,[\s\S]{0,260}ownerQueueItemKey/.test(progressText)
    || !/function playbackStallRecoveryOwnerStillCurrent/.test(controlsText)
  ) {
    fail('track-start and media error/stalled events must feed the shared resume recovery path');
  }
  console.log('[OK] Long-pause resume recovery refreshes expired provider URLs across providers.');
}

function checkAudioOutputWorkflowPanelGuard() {
  logStep('Audio output workflow panel guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const qualityText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '00-api-quality-output.js'), 'utf8');
  // 结构判据一律跑在剥掉注释的代码上：注释里出现 "enumerateDevices()" 这类字样
  // 会让判据误报（判据不能匹配注释里描述的行为，只能匹配真的行为）。
  // Structural judgements run on comment-stripped code: an "enumerateDevices()" mention inside a
  // comment would otherwise trip them. A guard must match what the code does, not what it says.
  const qualityCode = qualityText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const modalUtilsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  if (!/id="audio-output-workflow-modal"/.test(indexText) || !/id="audio-output-workflow-body"/.test(indexText) || !/openAudioOutputWorkflowPanel\(\)/.test(indexText)) {
    fail('audio output workflow must have a dedicated derivative modal entry instead of only the compact settings panel');
  }
  if (!/function openAudioOutputWorkflowPanel/.test(qualityText) || !/function closeAudioOutputWorkflowPanel/.test(qualityText) || !/renderAudioRouteWorkflowEdgesForRoot/.test(qualityText) || !/document\.querySelectorAll\('\.audio-route-graph'\)/.test(qualityText) || !/audio-output-summary-card/.test(qualityText) || !/audio-route-board-head/.test(qualityText) || !/out_route_board_title_html/.test(qualityText) || !/route-lane-state/.test(qualityText) || !/out_source_meter_html/.test(qualityText) || !/sortedRouteItems/.test(qualityText) || !/audioOutputMirrorRuntime/.test(qualityText) || !/audioOutputMirrorStatusText/.test(qualityText) || !/out_trying_mirror/.test(qualityText) || !/out_route_note_html/.test(qualityText)) {
    fail('audio output workflow must render compact settings summary and full modal route graph');
  }
  // route-board-title / audio-source-meter 这两个 class 名随 HTML 片段搬进了词典，
  // 因此判据校验承载它们的片段 key，而不是在 JS 里搜 class 字面量。
  // These two class names moved into dictionary HTML fragments, so the guard pins the
  // fragment keys that carry them instead of grepping the class literals out of JS.
  requireLocaleKeys('out_trying_mirror', 'out_route_note_html', 'out_route_board_title_html', 'out_source_meter_html');
  if (!/audio-output-workflow-modal/.test(cssText) || !/audio-output-workflow-modal \.audio-route-graph[\s\S]{0,320}grid-template-areas: "source board" "status board"/.test(cssText) || !/audio-route-board/.test(cssText) || !/route-board-badges/.test(cssText) || !/route-lane-state/.test(cssText) || !/audio-source-meter/.test(cssText) || !/audio-route-node\.pending/.test(cssText) || !/audio-route-node\.warning/.test(cssText) || !/audio-output-workflow-modal \.workflow-link-layer[\s\S]{0,120}display: none/.test(cssText) || !/audio-output-summary-card/.test(cssText)) {
    fail('audio output workflow modal must expose a Loopback-style patch bay board instead of a three-column device table');
  }
  if (!/\['audio-output-workflow-modal', closeAudioOutputWorkflowPanel\]/.test(modalUtilsText)) {
    fail('audio output workflow modal must close through the shared backdrop modal handler');
  }
  // 启动时不得枚举媒体设备。enumerateDevices() 会让 Chromium 启动 audio+video 设备监视，
  // 视频侧随之拉起 Video Capture Service 进程（本机实测常驻约 116MB），而默认配置下本应用
  // 根本不碰摄像头。枚举与热插拔监听都只能发生在"输出设备界面首次可见"之后。
  // Media devices must not be enumerated at boot: it makes Chromium start audio+video device
  // monitoring and spawn the Video Capture Service (~116MB measured resident) although this app
  // never touches a camera by default. Enumeration and the hot-plug listener may only happen after
  // the output-device UI first becomes visible.
  const bootBindStart = qualityCode.indexOf('function bindAudioOutputControls(');
  const revealStart = qualityCode.indexOf('function bindAudioOutputDeviceRevealHook(');
  if (bootBindStart < 0 || revealStart < 0) {
    fail('audio output controls must arm a first-reveal hook instead of enumerating during boot');
  }
  const bootBindBlock = qualityCode.slice(bootBindStart, revealStart);
  if (/refreshAudioOutputDevices\(|enumerateDevices|addEventListener\('devicechange'/.test(bootBindBlock)) {
    fail('boot must not enumerate media devices nor register the hot-plug listener; the reveal hook does it lazily');
  }
  // 枚举只允许出现在 refreshAudioOutputDevices 里：判据是"它之前一处都没有"，
  // 这样新增一个启动期调用点会立刻命中，而不需要维护一份出现次数快照。
  // Enumeration may only appear inside refreshAudioOutputDevices: the judgement is "none before
  // it", so a newly added boot-time call site trips immediately without pinning a count.
  const beforeRefresh = qualityCode.slice(0, qualityCode.indexOf('async function refreshAudioOutputDevices('));
  if (/enumerateDevices/.test(beforeRefresh)) {
    fail('enumerateDevices must not appear before refreshAudioOutputDevices');
  }
  const ensureBlock = qualityCode.slice(
    qualityCode.indexOf('function ensureAudioOutputDevicesLoaded('),
    qualityCode.indexOf('async function refreshAudioOutputDevices(')
  );
  if (!/audioOutputDevicesLoaded\) return;/.test(ensureBlock) || !/audioOutputDevicesLoaded = true;/.test(ensureBlock)) {
    fail('the lazy device load must be one-shot, otherwise every reveal re-enumerates');
  }
  if (!/addEventListener\('devicechange'/.test(ensureBlock)) {
    fail('the device hot-plug listener must be registered by the lazy loader, not at boot');
  }
  const panelOpenBlock = qualityCode.slice(
    qualityCode.indexOf('function openAudioOutputWorkflowPanel('),
    qualityCode.indexOf('function closeAudioOutputWorkflowPanel(')
  );
  if (!/ensureAudioOutputDevicesLoaded\(\);/.test(panelOpenBlock)) {
    fail('opening the output workflow panel must trigger the lazy device load');
  }
  if (!/IntersectionObserver/.test(qualityCode) || !/getElementById\('audio-output-panel'\)/.test(qualityCode)) {
    fail('the settings section must trigger the lazy load on first reveal (it starts inside an inactive tab)');
  }
  const storesText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  if (!/var audioOutputDevicesLoaded = false;/.test(storesText) || !/var audioOutputDeviceChangeBound = false;/.test(storesText)) {
    fail('the lazy-load flags must start false in the shared store');
  }
  console.log('[OK] Audio output workflow opens as a dedicated wiring panel, leaves settings compact, and enumerates devices only on first reveal.');
}

function checkVolumeWheelStepGuard() {
  logStep('Volume wheel step guard');
  const audioText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '08-audio-graph-controls.js'), 'utf8');
  if (!/function adjustVolumeByWheel/.test(audioText) || !/var step = 0\.01;/.test(audioText)) {
    fail('volume control mouse wheel must adjust exactly 1 percent per wheel event');
  }
  console.log('[OK] Volume wheel step is 1%.');
}

function checkNonCurrentAudioPrefetchGuard() {
  logStep('Non-current audio prefetch guard');
  const beatPrefetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  if (!/QUEUE_BEAT_AUDIO_PREFETCH_ENABLED\s*=\s*false/.test(beatPrefetchText)) {
    fail('queue beat prefetch must not request non-current song audio URLs by default');
  }
  if (!/function scheduleQueueBeatPrefetch[\s\S]{0,140}if \(!QUEUE_BEAT_AUDIO_PREFETCH_ENABLED\) return;/.test(beatPrefetchText)) {
    fail('scheduleQueueBeatPrefetch must return before touching non-current audio URL prefetch work');
  }
  if (!/async function runQueueBeatPrefetch[\s\S]{0,120}if \(!QUEUE_BEAT_AUDIO_PREFETCH_ENABLED\) return;/.test(beatPrefetchText)) {
    fail('runQueueBeatPrefetch must also be guarded when an old timer fires');
  }
  console.log('[OK] Non-current audio URL prefetch stays disabled by default.');
}

function checkCuefieldAutoMixGuard() {
  logStep('Cuefield AutoMix integration guard');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const desktopText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const coreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '16-cuefield-automix-core.js'), 'utf8');
  const timelineText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '17-cuefield-timeline-executor.js'), 'utf8');
  const integrationText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '18-cuefield-automix-integration.js'), 'utf8');
  const adapterText = fs.readFileSync(path.join(appRoot, 'cuefield', 'adapter-mineradio.js'), 'utf8');
  const bridgeText = fs.readFileSync(path.join(appRoot, 'cuefield', 'mineradio-bridge.js'), 'utf8');
  const recipeText = fs.readFileSync(path.join(appRoot, 'cuefield', 'recipe-planner.js'), 'utf8');
  const beatPrefetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const beatCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '02-beat-camera-runtime.js'), 'utf8');
  const audioGraphText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '08-audio-graph-controls.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const progressText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const beta = JSON.parse(fs.readFileSync(path.join(appRoot, 'electron-builder.internal-beta.json'), 'utf8'));
  if (!packageJson.build.files.includes('cuefield/**/*') || !(beta.files || []).includes('cuefield/**/*')) {
    fail('Cuefield runtime files must be included in regular and internal-beta packages');
  }
  // 开关已从控制栏图标按钮搬进 DIY 面板的"实验功能"分组（与完整桌面模式同处），所以这里钉的是
  // 面板内那个 fx-toggle 的 id，而不是已经不存在的 transport 按钮。
  // The switch moved off the transport bar into the DIY panel's "实验功能" group (next to full
  // desktop mode), so pin that fx-toggle id rather than the transport button that no longer exists.
  if (!/16-cuefield-automix-core\.js/.test(loaderText) || !/17-cuefield-timeline-executor\.js/.test(loaderText) || !/18-cuefield-automix-integration\.js/.test(loaderText) || !/id="t-cuefieldAutoMix"/.test(htmlText) || !/id="cuefield-feedback"/.test(htmlText) || !/#t-cuefieldAutoMix\.cuefield-automix-ready/.test(cssText) || !/id="t-cuefieldAutoMix"/.test(htmlText)) {
    fail('Cuefield AutoMix needs loaded runtime modules, a default-off DIY panel control, and local feedback UI');
  }
  // 分组登记必须在控制台布局里，否则面板里点不到它。
  // The group registration must exist in the console layout, otherwise the panel cannot reach it.
  const cuefieldConsoleText = fs.readFileSync(
    path.join(appRoot, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8'
  );
  // 按分组切片再判断，固定的 {0,400} 窗口会被组内注释长度顶穿。
  // Slice the group out before testing: a fixed {0,400} window gets overrun by the group's comments.
  const experimentalGroup = (cuefieldConsoleText.split("key: 'experimental'")[1] || '').split('] }')[0] || '';
  if (!/fxConsoleItem\('t-cuefieldAutoMix'/.test(experimentalGroup)) {
    fail('Cuefield AutoMix must be listed in the DIY console experimental group so it is reachable from the panel');
  }
  if (/id="cuefield-automix-btn"/.test(htmlText) || /#cuefield-automix-btn/.test(cssText)) {
    fail('the transport-bar Cuefield AutoMix button must stay removed now that the switch lives in the DIY panel');
  }
  // 上面钉的是静态资源里"按钮必须保持移除"。但仓库里另有两处**休眠**判据曾经反过来要求它存在：
  // Electron 冒烟 `tests/cuefield-electron-smoke.js` 与实时 QA 脚本 `runtimeQaScript()`。两者从按钮
  // 被移除那天起就一直是坏的，却没人发现——冒烟没有任何 npm 脚本或工作流引用，实时 QA 只在
  // `--electron` 模式下跑。两处已改为断言"按钮不在"，并在这里钉住两端，防止那种写法再长回来。
  // The line above pins the removal in static assets. Two DORMANT checks used to demand the button's
  // existence instead (the Electron smoke and the live QA script) and had been broken since the day
  // it was removed, because neither runs in CI. Both now assert absence; this pins that in turn.
  const cuefieldSmokeText = fs.readFileSync(path.join(appRoot, 'tests', 'cuefield-electron-smoke.js'), 'utf8');
  // 拆成两段拼接：这样这条守卫不会在自己的源码里匹配到自己写的字面量。
  // Split the needles so this guard cannot match its own literals in this file.
  const removedButtonDemands = ['Cuefield AutoMix ' + 'button missing', 'button: ' + '!!button'];
  if (!/cuefield-automix-btn/.test(cuefieldSmokeText) || !/buttonRemoved:/.test(cuefieldSmokeText)) {
    fail('tests/cuefield-electron-smoke.js must keep asserting the removed transport button is absent');
  }
  if (removedButtonDemands.some((needle) => cuefieldSmokeText.includes(needle))) {
    fail('tests/cuefield-electron-smoke.js must not require the removed cuefield-automix-btn again');
  }
  if (removedButtonDemands.some((needle) => fs.readFileSync(__filename, 'utf8').includes(needle))) {
    fail('runtimeQaScript() must not require the removed cuefield-automix-btn again');
  }
  if (!/var cuefieldAutoMixEnabled = false/.test(integrationText) || !/CUEFIELD_AUTOMIX_STORE_KEY/.test(integrationText) || !/if \(!cuefieldAutoMixEnabled \|\| !audio/.test(integrationText) || !/function toggleCuefieldAutoMix/.test(integrationText)) {
    fail('Cuefield AutoMix must be opt-in and must not prepare while disabled');
  }
  if (!/function createCuefieldAutoMix/.test(coreText) || !/function buildCuefieldTimelineExecution/.test(timelineText) || !/planCuefieldTransitionFromCache/.test(serverText) || !/pn === '\/api\/cuefield\/transition'/.test(serverText) || !/pn === '\/api\/cuefield\/feedback'/.test(serverText)) {
    fail('Cuefield planner, timeline executor, and local server endpoints are incomplete');
  }
  if (!/MINERADIO_BEAT_COMBOS/.test(adapterText) || !/raw\[7\]/.test(adapterText) || !/flags & 1/.test(adapterText) || !/flags & 2/.test(adapterText) || !/flags & 4/.test(adapterText) || /raw\[8\][^\n]{0,80}downbeat|raw\[8\][^\n]{0,80}>=\s*7/.test(adapterText)) {
    fail('Cuefield must decode packed comboIdx and flags independently so ordinary camera/pulse flags cannot become false downbeats');
  }
  if (!/chooseTransitionWindow/.test(bridgeText) || !/buildStructureMap/.test(bridgeText) || !/normalizeRecentRecipes/.test(bridgeText) || !/resolveListeningFloor/.test(bridgeText) || !/safety-long-blend/.test(recipeText) || !/end-of-track-crossfade/.test(bridgeText)) {
    fail('Cuefield must keep structure-aware window selection, recipe cooldown, listening floors, and bounded safety/end-of-track fallbacks');
  }
  if (!/cuefieldLyricTextForSong/.test(integrationText) || !/fromLrc:\s*lyricPair\[0\]/.test(integrationText) || !/toLrc:\s*lyricPair\[1\]/.test(integrationText) || !/allowWeak:\s*false/.test(integrationText) || !/allowSafetyFallback:\s*true/.test(integrationText) || !/allowLiveEndCrossfadeFallback:\s*true/.test(integrationText)) {
    fail('Cuefield must consume the existing lyric cache, reject weak beatmixes, and retain explicit bounded safety fallbacks');
  }
  if (!/var provider = songProviderKey\(song\)/.test(beatPrefetchText) || !/return provider \+ ':' \+ id/.test(beatPrefetchText) || !/resolveAlbumGaplessPlaybackData\(song\)/.test(beatPrefetchText)) {
    fail('Cuefield beatmaps must use provider-aware keys and resolve the same provider playback path as the real player');
  }
  if (!/CUEFIELD_FEEDBACK_FILE/.test(desktopText) || !/appendCuefieldFeedback/.test(serverText) || !/readCuefieldFeedbackStats/.test(serverText) || /feedback-remote|CUEFIELD_FEEDBACK_REMOTE|https?:\/\/.*cuefield/i.test(serverText + integrationText)) {
    fail('Cuefield feedback must remain local and must not wire a remote feedback service');
  }
  if (!/albumGaplessHandoff:\s*true/.test(integrationText) || !/resetCuefieldAutoMix\(opts\.cuefieldAutoMix/.test(playbackText) || !/scheduleCuefieldAutoMixPrepare\(token, idx/.test(playbackText) || !/audio\.onended = function \(\) \{[\s\S]{0,160}cuefieldAutoMixExecuting/.test(playbackText) || !/tickCuefieldAutoMix/.test(progressText) || !/resetCuefieldAutoMix\('manual-seek'\)/.test(progressText)) {
    fail('Cuefield must hand off through the proven player path and reset for manual seeking');
  }
  if (!/function claimCuefieldPreparedAudioForPlayback/.test(integrationText) || !/media === audio[\s\S]{0,100}claimCuefieldPreparedAudioForPlayback\(media\);[\s\S]{0,40}return;/.test(integrationText) || !/audio = opts\.preloadedAudio;[\s\S]{0,180}claimCuefieldPreparedAudioForPlayback\(audio\)/.test(playbackText) || !/preserveExecution:\s*!!opts\.cuefieldAutoMix/.test(playbackText)) {
    fail('Cuefield must transfer preloaded B-deck ownership before preparing another track so it cannot pause active playback');
  }
  if (!/function buildEqualPowerCurve/.test(timelineText) || !/function cuefieldVolumeCurveValue/.test(integrationText) || !/equal-power-in/.test(integrationText) || !/equal-power-out/.test(integrationText) || !/function cuefieldApplyGraphEcho/.test(integrationText) || !/function cuefieldApplyGraphDuck/.test(integrationText) || !/function cuefieldApplyTimelineAction/.test(integrationText) || !/volume-only-fallback/.test(integrationText)) {
    fail('Cuefield must execute equal-power A/B volume curves and safely downgrade advanced graph actions');
  }
  if (!/await cuefieldApplyTimelineAction\(action, pending, nextMedia, context\)/.test(integrationText) || !/handoffDelayMs > elapsedMs[\s\S]{0,120}await cuefieldDelay/.test(integrationText) || !/nextMedia\.paused \|\| nextMedia\.ended/.test(integrationText) || !/var handoffReady = await runCuefieldTimeline\(pending, nextMedia, transitionContext\);[\s\S]{0,150}if \(!handoffReady \|\| !cuefieldTransitionStillCurrent\(pending, transitionContext\)\)/.test(integrationText)) {
    fail('Cuefield ownership handoff must await the cancellable action timeline and a live incoming deck');
  }
  if (!/var cuefieldTransitionGeneration = 0/.test(integrationText) || !/cuefieldTransitionGeneration\+\+;[\s\S]{0,120}clearCuefieldTimelineTimers\(\)/.test(integrationText) || !/function cuefieldDelay\(delayMs, generation\)/.test(integrationText) || !/context\.generation !== cuefieldTransitionGeneration/.test(integrationText) || !/audio !== context\.outgoingMedia/.test(integrationText)) {
    fail('Cuefield reset, seek, and pause must invalidate delayed transitions before they can wake and rewrite current audio gain');
  }
  if (!/var cuefieldMediaFadeTimer = 0/.test(integrationText) || !/cuefieldMediaFadeTimer = setInterval\(function \(\) \{[\s\S]{0,100}applyStep\(\)/.test(integrationText) || !/context\.outgoingMedia && context\.outgoingMedia\.currentTime/.test(integrationText) || !/if \(cuefieldMediaFadeTimer\) clearInterval\(cuefieldMediaFadeTimer\)/.test(integrationText)) {
    fail('Cuefield gain must follow the outgoing media clock and keep a timer watchdog when visual RAF is throttled');
  }
  if (!/function recoverCuefieldAutoMixEndedOutgoing/.test(integrationText) || !/__mineradioCuefieldEndedRecoveryToken/.test(playbackText)) {
    fail('Cuefield must resume ordinary queue advance if its outgoing deck ends before a failed handoff settles');
  }
  if (!/__mineradioPreparedGraphFailed/.test(integrationText) || !/The first element is permanently tied/.test(integrationText)) {
    fail('Cuefield must rebuild a clean fallback media element after a partial WebAudio graph failure');
  }
  if (!/var cuefieldActiveTransitionContext = null/.test(integrationText) || !/shouldRestoreOutgoing[\s\S]{0,520}rampAudioOutputGain\(targetVolume, 120\)/.test(integrationText) || !/async function runCuefieldNormalFallback\(\)/.test(integrationText) || !/audio !== nextMedia && audio !== transitionContext\.outgoingMedia/.test(integrationText)) {
    fail('Cuefield disable/cancel must restore its outgoing deck and pre-adoption handoff failures must use normal playback fallback');
  }
  if (!/function cuefieldAutoMixBlockedByAlbumGapless\(index\)[\s\S]{0,120}albumGaplessQueueCanAdvance\(index\)/.test(integrationText) || !/if \(cuefieldAutoMixBlockedByAlbumGapless\(currentIndex\)\) return false;/.test(integrationText) || !/cuefieldAutoMixBlockedByAlbumGapless\(pending\.currentIndex\)[\s\S]{0,180}album-gapless-priority/.test(integrationText) || !/function startAlbumGaplessMix\(preload, reason, remaining\)[\s\S]{0,360}cuefieldAutoMixExecuting[^\n]*return false;/.test(playbackText)) {
    fail('Cuefield AutoMix and album gapless must stay mutually exclusive so only one prepared B-deck can transition');
  }
  if (!/albumGaplessMixed:\s*true/.test(integrationText) || !/preserveGain:\s*albumGaplessMixed/.test(playbackText) || !/preserveGain:\s*!!opts\.preserveGain/.test(controlsText) || !/else if \(!opts\.preserveGain\) restorePlaybackGain\(\)/.test(controlsText)) {
    fail('Cuefield mixed handoff must preserve the completed incoming gain through the shared playback-start path');
  }
  if (!/CUEFIELD_AUTOMIX_NORMAL_START_SETTLE_MS = 4200/.test(integrationText) || !/CUEFIELD_AUTOMIX_HANDOFF_SETTLE_MS = 5200/.test(integrationText) || !/function cuefieldAutoMixVisualTransitionBusy/.test(integrationText) || !/cuefieldAutoMixVisualTransitionBusy\(\)[\s\S]{0,120}scheduleCuefieldAutoMixPrepare\(token, currentIndex, 900/.test(integrationText) || !/cuefieldAutoMixPostSwitchDelay\(!!opts\.cuefieldAutoMix\)/.test(playbackText)) {
    fail('Cuefield background analysis must wait for cover and particle transition work to settle');
  }
  if (!/function contextStillCurrent\(\)/.test(integrationText) || !/var analysisToken = beatMapToken/.test(integrationText) || !/descriptor = await cuefieldAutoMixAudioDescriptor\(song\);[\s\S]{0,220}analysisToken !== beatMapToken[\s\S]{0,120}cuefieldAutoMixVisualTransitionBusy\(\)/.test(integrationText) || !/analyzeAudioBeats\(descriptor\.proxyUrl, null, analysisToken/.test(integrationText)) {
    fail('Cuefield beat analysis must revalidate track ownership and visual-idle state after resolving the next audio URL');
  }
  if (!/audioSourceMedia = null/.test(coreStoreText) || !/function cuefieldCreatePreparedAudioGraph/.test(integrationText) || !/createMediaElementSource\(media\)/.test(integrationText) || !/__mineradioPreparedAudioGraph/.test(audioGraphText) || !/preparedGraph\.adopted = true/.test(audioGraphText) || !/audioSourceMedia = audio/.test(audioGraphText)) {
    fail('Cuefield must prepare B in the same AudioContext and adopt its existing source/analyser/gain graph without rebinding mid-playback');
  }
  if (!/function resetAudioVisualState\(options\)/.test(beatCameraText) || !/preserveEnvelope/.test(beatCameraText) || !/function resetBeatCameraSync\(t, options\)/.test(beatCameraText) || !/preserveMomentum/.test(beatCameraText) || !/resetAudioVisualState\(\{ preserveEnvelope: albumGaplessMixed \}\)/.test(playbackText) || !/preserveMomentum: albumGaplessMixed/.test(playbackText) || !/syncBeatMapPlaybackCursor\(audio \? audio\.currentTime : 0, albumGaplessMixed\)/.test(playbackText)) {
    fail('mixed handoff must preserve the live particle envelope and camera momentum while aligning the new beat-map cursor');
  }
  if (!/var cuefieldMediaFadeSerial = 0/.test(integrationText) || !/function cancelCuefieldMediaFade/.test(integrationText) || !/function claimCuefieldPreparedAudioForPlayback\(media\)[\s\S]{0,180}cancelCuefieldMediaFade\(\)/.test(integrationText) || !/serial !== cuefieldMediaFadeSerial/.test(integrationText) || !/await applyAudioOutputDevice\(nextMedia\)/.test(integrationText)) {
    fail('Cuefield must cancel the temporary B-deck fade and apply the selected output device before ownership handoff');
  }
  console.log('[OK] Cuefield AutoMix is opt-in, packages with the app, uses local feedback, and reuses safe handoff controls.');
}

function checkAlbumDetailGaplessGuard() {
  logStep('Album detail and explicit gapless guard');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const detailText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js'), 'utf8');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const snapshotText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '09-queue-snapshot-autoplay.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const spotifyText = fs.readFileSync(path.join(appRoot, 'server', 'spotify-api.js'), 'utf8');
  if (!/thumb-cover[\s\S]{0,180}openTrackDetailModal\('album'\)/.test(htmlText) || !/control-cover[\s\S]{0,260}openTrackDetailModal\('album'\)/.test(htmlText)) {
    fail('album detail must be reachable from both current cover entry points');
  }
  if (!/\.detail-action-toggle/.test(cssText) || !/\.control-cover:focus-visible/.test(cssText)) {
    fail('album detail entry and gapless toggle must have visible UI affordances');
  }
  if (!/function albumDetailUrlForSong/.test(detailText) || !/function renderAlbumSongList/.test(detailText) || !/function toggleAlbumGaplessPlayback/.test(detailText) || !/function playAlbumDetailSong/.test(detailText)) {
    fail('track detail module must render album songs, play album queues, and expose the gapless toggle');
  }
  if (!/setAlbumGaplessPlaybackContext\(detailAlbumGaplessEnabled, detailAlbumContext/.test(detailText) || !/__albumGaplessKey/.test(detailText) || !/detailAlbumGaplessEnabled\s*=\s*true/.test(detailText)) {
    fail('album detail playback must tag album queues and pass the gapless context into playback');
  }
  if (!/handleNeteaseAlbumDetail/.test(serverText) || !/pn === '\/api\/album\/detail'/.test(serverText) || !/handleQQAlbumDetail/.test(serverText) || !/pn === '\/api\/qq\/album\/detail'/.test(serverText) || !/pn === '\/api\/spotify\/album\/detail'/.test(serverText)) {
    fail('server.js must expose Netease, QQ, and Spotify album detail endpoints');
  }
  if (!/async function handleSpotifyAlbumDetail/.test(spotifyText) || !/\/albums\/' \+ encodeURIComponent\(id\)/.test(spotifyText)) {
    fail('Spotify bridge must expose album detail tracks as metadata source');
  }
  if (!/albumGaplessState/.test(coreStoreText) || !/defaultEnabled:\s*true/.test(coreStoreText) || !/function albumGaplessDefaultEnabledForContext/.test(playbackText) || !/function setAlbumGaplessPlaybackContext/.test(playbackText) || !/function scheduleAlbumGaplessPreloadForCurrent/.test(playbackText) || !/function resolveAlbumGaplessPlaybackData/.test(playbackText) || !/albumGaplessHandoff/.test(playbackText) || !/playAlbumGaplessNextOnEnded/.test(playbackText)) {
    fail('album gapless playback must keep explicit state, preheat next audio, and use a sequential on-ended fallback');
  }
  if (!/ALBUM_GAPLESS_PREROLL_SECONDS\s*=\s*8\.5/.test(playbackText) || !/ALBUM_GAPLESS_MUTED_PREROLL_SECONDS\s*=\s*1\.05/.test(playbackText) || !/ALBUM_GAPLESS_MIX_SECONDS\s*=\s*0\.72/.test(playbackText) || !/ALBUM_GAPLESS_NEXT_ENTRY_FLOOR\s*=\s*0\.90/.test(playbackText) || !/ALBUM_GAPLESS_NEXT_ATTACK_MS\s*=\s*56/.test(playbackText) || !/ALBUM_GAPLESS_ADOPT_SLEW_MS\s*=\s*180/.test(playbackText) || !/ALBUM_GAPLESS_GAIN_STEP_MS\s*=\s*8/.test(playbackText) || !/ALBUM_GAPLESS_BOUNDARY_RELEASE_SECONDS\s*=\s*ALBUM_GAPLESS_MIX_SECONDS/.test(playbackText) || !/ALBUM_GAPLESS_FAST_SILENCE_HOLD_MS/.test(playbackText) || !/ALBUM_GAPLESS_DIRECT_SILENCE_RMS/.test(playbackText) || !/ALBUM_GAPLESS_RESIDUAL_FREQ_AVG/.test(playbackText) || !/albumGaplessTailFreqData/.test(playbackText) || !/function albumGaplessDirectTailSample/.test(playbackText) || !/function startAlbumGaplessPreroll/.test(playbackText) || !/function startAlbumGaplessMix/.test(playbackText) || !/runAlbumGaplessBalancedCrossfade/.test(playbackText) || !/albumGaplessTailSilenceProbe/.test(playbackText) || !/residualTail/.test(playbackText) || !/!tailProbe\.residualTail/.test(playbackText) || !/tail-direct-silence-crossmix/.test(playbackText) || !/boundary-crossmix-reset/.test(playbackText)) {
    fail('album gapless playback must scan tail waveform energy, skip long silent tails, and use balanced crossmix at the cue point');
  }
  if (!/function albumGaplessEqualPowerGains\(progress, outgoingStart, incomingTarget\)/.test(playbackText) || !/outgoing:\s*clampRange\(\(Number\(outgoingStart\) \|\| 0\) \* Math\.cos\(theta\)/.test(playbackText) || !/incoming:\s*clampRange\(\(Number\(incomingTarget\) \|\| 0\) \* Math\.sin\(theta\)/.test(playbackText) || !/function albumGaplessEqualPowerEntryProgress\(elapsedMs, durationMs\)/.test(playbackText) || !/Math\.asin\(ALBUM_GAPLESS_NEXT_ENTRY_FLOOR\)/.test(playbackText) || !/albumGaplessEqualPowerEntryProgress\(elapsedMs, durationMs\)/.test(playbackText) || !/media\.volume = 0;[\s\S]{0,260}preload\.fadeCompleted = false/.test(playbackText) || /media\.volume\s*=\s*ALBUM_GAPLESS_NEXT_ENTRY_FLOOR/.test(playbackText)) {
    fail('album gapless must keep the 0.90/56ms entry strength inside one paired equal-power curve instead of stacking it over a full-volume outgoing deck');
  }
  if (!/Promise\.resolve\(playResult\)\.then\(function \(\)/.test(playbackText) || !/return runAlbumGaplessBalancedCrossfade\(preload, mixMs\)/.test(playbackText) || !/\.then\(function \(completed\)/.test(playbackText) || !/if \(!completed\)/.test(playbackText) || !/preload\.fadeCompleted[\s\S]{0,900}startAlbumGaplessHandoff/.test(playbackText) || !/preload\.fadeResolve[\s\S]{0,180}resolveFade\(false\)/.test(playbackText)) {
    fail('album gapless must await media play and the completed fade state before ownership handoff, and cancellation must resolve false');
  }
  if (!/function disposeAlbumGaplessPreload\(preload\)/.test(playbackText) || !/await applyAudioOutputDevice\(media\);[\s\S]{0,420}serial !== albumGaplessState\.serial[\s\S]{0,320}disposeAlbumGaplessPreload\(\{ media: media \}\)/.test(playbackText) || !/if \(albumGaplessState\.preload === preload\) clearAlbumGaplessPreload\('album-gapless-mix-stale'\);[\s\S]{0,80}else disposeAlbumGaplessPreload\(preload\)/.test(playbackText)) {
    fail('stale album preload promises must revalidate after await and may only dispose the media object they own');
  }
  if (!/fadeWatchdogTimer = setInterval\(function \(\) \{[\s\S]{0,100}applyStep\(performance\.now\(\)\)/.test(playbackText) || !/function scheduleAlbumGaplessNormalFallback\(\)/.test(playbackText) || !/audio !== preload\.media && audio !== handoffPreviousAudio/.test(playbackText) || !/albumGaplessState\.preload\.mixStarted[\s\S]{0,160}restoreAlbumGaplessOutgoingIfCurrent/.test(playbackText)) {
    fail('album gapless must keep its gain curve alive off-RAF, restore on disable, and fall back whether B was adopted or not');
  }
  if (!/function playbackAttemptStillCurrent\(media, token\)/.test(controlsText) || !/expectedMedia: opts\.expectedMedia \|\| audio/.test(controlsText) || !/expectedToken: opts\.expectedToken == null \? trackSwitchToken/.test(controlsText) || !/expectedMedia: playbackMedia, expectedToken: token/.test(playbackText)) {
    fail('stale play promises must be scoped to the media element and track token that started them');
  }
  if (!/var albumGaplessAdoptedGain = 0/.test(playbackText) || !/albumGaplessAdoptedGain = albumGaplessMixed[\s\S]{0,100}Number\(audio\.volume\)/.test(playbackText) || !/setAudioOutputGainImmediate\(albumGaplessMixed \? albumGaplessAdoptedGain : audioSilentFloor\(\)\)/.test(playbackText) || !/preserveGain:\s*albumGaplessMixed/.test(playbackText) || !/rampAudioOutputGain\(targetVolume, ALBUM_GAPLESS_ADOPT_SLEW_MS\)/.test(playbackText) || !/preserveGain:\s*!!opts\.preserveGain/.test(controlsText) || !/else if \(!opts\.preserveGain\) restorePlaybackGain\(\)/.test(controlsText)) {
    fail('mixed album handoff must adopt, preserve, and gently settle the incoming gain without a restorePlaybackGain jump');
  }
  if (!/preloadedAudio/.test(playbackText) || !/preloadedProxyAudioUrl/.test(playbackText) || !/albumGaplessMixed/.test(playbackText) || !/skipShuffleOrder: true/.test(playbackText) || !/searchAlternatePlatformSong\(nextSong\)/.test(playbackText) || !/playQueue\[preload\.index\] = hydrateCustomCover\(preload\.song\)/.test(playbackText)) {
    fail('album gapless handoff must reuse preheated audio, pre-resolve metadata-source fallback, and force album order instead of shuffle order');
  }
  const coverText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '15-ripples-cover-depth.js'), 'utf8');
  if (!/albumGaplessSameAlbumCover/.test(playbackText) || !/noCoverTransition:\s*sameAlbumCoverSwitch/.test(playbackText) || !/opts\.noCoverTransition/.test(coverText)) {
    fail('same-album same-cover transitions must suppress cover particle/color transition effects');
  }
  if (!/albumMid/.test(snapshotText) || !/albumUri/.test(snapshotText)) {
    fail('playback snapshots must preserve album identifiers for album detail entry after restore');
  }
  console.log('[OK] Album detail opens from covers, loads provider album tracks, and gapless playback is explicit/preheated/sequential.');
}

function checkInternalBetaPackagingGuard() {
  logStep('Internal beta packaging guard');
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const betaConfigPath = path.join(appRoot, 'electron-builder.internal-beta.json');
  if (!pkg.scripts || !/electron-builder\.internal-beta\.json/.test(pkg.scripts['build:win:internal-beta'] || '') || !/--publish never/.test(pkg.scripts['build:win:internal-beta'] || '')) {
    fail('internal beta build must stay on its own electron-builder config and use --publish never');
  }
  if (!fs.existsSync(betaConfigPath)) fail('electron-builder.internal-beta.json is required for isolated gray-test packaging');
  const beta = JSON.parse(fs.readFileSync(betaConfigPath, 'utf8'));
  const meta = beta.extraMetadata || {};
  const mineradio = meta.mineradio || {};
  const update = mineradio.update || {};
  if (meta.version !== '1.1.2' || beta.productName !== 'Mineradio_Beat' || meta.productName !== 'Mineradio_Beat') {
    fail('internal beta package metadata must identify v1.1.2 Mineradio_Beat');
  }
  if (!/dist-internal-beta/.test(beta.directories && beta.directories.output || '') || beta.publish !== null) {
    fail('internal beta output must stay in dist-internal-beta and not configure GitHub publishing');
  }
  if (beta.asar !== true) {
    fail('internal beta package must use asar so source files are not installed as plain resources');
  }
  if ((beta.appId || '') !== 'com.mineradio.beat.internal' || (mineradio.appUserModelId || '') !== 'com.mineradio.beat.internal') {
    fail('internal beta must use an isolated app id/AppUserModelID');
  }
  if (mineradio.runtimeName !== 'Mineradio_Beat' || update.disabled !== true || update.provider !== 'none') {
    fail('internal beta runtime name and update-disable metadata must stay isolated');
  }
  const requiredRuntimeFiles = ['server/**/*'];
  const packageBuildFiles = pkg.build && Array.isArray(pkg.build.files) ? pkg.build.files : [];
  const betaBuildFiles = Array.isArray(beta.files) ? beta.files : [];
  requiredRuntimeFiles.forEach((entry) => {
    if (!packageBuildFiles.includes(entry) || !betaBuildFiles.includes(entry)) {
      fail(`electron-builder files must include runtime dependency ${entry}`);
    }
  });
  if (!beta.nsis || beta.nsis.include !== 'build/installer-internal-beta.nsh' || !/Mineradio_Beat-v\$\{version\}-灰度内测版/.test(beta.nsis.artifactName || '')) {
    fail('internal beta NSIS config must use the beta wrapper and beta artifact name');
  }
  const wrapperText = fs.readFileSync(path.join(appRoot, 'build', 'installer-internal-beta.nsh'), 'utf8');
  if (!/MINERADIO_INSTALL_DIR_NAME "Mineradio_Beat"/.test(wrapperText) || !/禁止传播/.test(wrapperText) || !/installer\.nsh/.test(wrapperText)) {
    fail('internal beta NSIS wrapper must define Mineradio_Beat and the no-redistribution notice');
  }
  const installerText = fs.readFileSync(path.join(appRoot, 'build', 'installer.nsh'), 'utf8');
  if (!/MINERADIO_INSTALL_DIR_NAME/.test(installerText) || !/MINERADIO_INSTALL_NOTICE/.test(installerText)) {
    fail('shared installer must keep configurable install-folder and notice hooks');
  }
  // Drive-letter probe: 盘符必须用 GetDriveTypeW 判定是否固定磁盘（#265/#275/#86/#102）。
  // Drive-letter probe must use GetDriveTypeW; IfFileExists "<letter>:\*.*" only proves "the root
  // has entries", so card readers / optical drives / empty removable disks were treated as
  // install targets. 说明性注释会引用被替换掉的旧写法，故"不得出现"类断言只看真代码行。
  const installerCode = installerText
    .split(/\r?\n/)
    .filter((line) => !/^\s*;/.test(line))
    .join('\n');
  if (/IfFileExists\s+"[A-Z]:\\\*\.\*"/.test(installerCode)) {
    fail('installer must not select install drives via IfFileExists "<letter>:\\*.*"');
  }
  if (!/System::Call\s+'kernel32::GetDriveTypeW\(w "\$0:\\\\"\) i \.r1'/.test(installerCode)) {
    fail('installer must probe drive type through kernel32::GetDriveTypeW');
  }
  ['MineradioDriveLetterIsFixed', 'MineradioFirstFixedDriveLetter', 'MineradioUseFirstAvailableInstallDir', 'MineradioHasPreferredInstallDrive']
    .forEach((fnName) => {
      if (!new RegExp(`Function\\s+${fnName}\\b`).test(installerCode)) {
        fail(`installer drive helper ${fnName} is missing`);
      }
    });
  if (!/!define MINERADIO_DRIVE_FIXED 3/.test(installerCode)) {
    fail('installer must pin DRIVE_FIXED to 3 before comparing drive types');
  }
  if (!/Call\s+MineradioFirstFixedDriveLetter/.test(installerCode)) {
    fail('installer drive helpers must share a single fixed-drive enumeration');
  }
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  if (!/APP_PACKAGE_INFO/.test(mainText) || !/runtimeName/.test(mainText) || !/appUserModelId/.test(mainText)) {
    fail('desktop runtime must read beta name/AppUserModelID from package metadata');
  }
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  if (!/qishui-audio-decryptor\/track-decryptor/.test(serverText)) {
    fail('server qishui decryptor dependency must stay covered by package files');
  }
  if (!/local\.disabled === true/.test(serverText) || !/provider === 'none'/.test(serverText)) {
    fail('server update config must support disabled internal beta update metadata');
  }
  console.log('[OK] Internal beta packaging stays isolated, closed-channel, and non-publishing.');
}

function checkSonicTopographyPresetGuard() {
  logStep('Sonic topography visual preset guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const coreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const packagedText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '05-packaged-fx-archive.js'), 'utf8');
  const runtimeText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const persistenceText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
  const pointerText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '00-pointer-cover-particles.js'), 'utf8');
  const gestureText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '00-gesture-control.js'), 'utf8');
  const orbitText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '01-orbit-free-camera.js'), 'utf8');
  const focusCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '03-focus-cinema-camera.js'), 'utf8');
  const beatCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '02-beat-camera-runtime.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const presetGridText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '04-preset-grid-uniforms.js'), 'utf8');
  const presetCssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const fxBindText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const fxPanelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const mainLoopText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '11-main-loop.js'), 'utf8');
  const sonicText = fs.readFileSync(path.join(appRoot, 'public', 'sonic-topography-preset.js'), 'utf8');
  const sonicWorkshopText = fs.readFileSync(path.join(appRoot, 'public', 'sonic-workshop-preset.js'), 'utf8');
  const sonicWorkshopBridgeText = fs.readFileSync(path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'mineradio-bridge.html'), 'utf8');
  const paletteText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '07-lyrics-palette-text-utils.js'), 'utf8');
  const accentControlText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '02-accent-background-controls.js'), 'utf8');
  const colorLabText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '06-custom-background-colorlab.js'), 'utf8');
  const keyboardCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '06-keyboard-camera-events.js'), 'utf8');
  const sonicAudioText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '06-sonic-audio-monitor.js'), 'utf8');
  const defaultArchiveText = fs.readFileSync(path.join(appRoot, 'public', 'default-user-fx-archive.json'), 'utf8');
  const starRiverText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '03-lyrics-star-river.js'), 'utf8');
  const stageLyricsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const combinedFxState = defaultsText + packagedText + persistenceText + archiveText + fxBindText + fxPanelText + sonicAudioText + defaultArchiveText;
  const requiredSonicFields = [
    'sonicGroundAmplitude',
    'sonicGroundMotionSpeed',
    'sonicGroundDensity',
    'sonicGroundRange',
    'sonicGroundLower',
    'sonicGroundDepth',
    'sonicGroundAutoRotate',
    'sonicGroundColorMode',
    'sonicGroundBaseColor',
    'sonicGroundCoolColor',
    'sonicGroundWarmColor',
    'sonicGroundAccentColor',
    'sonicGroundGlow',
    'sonicGroundSubBass',
    'sonicGroundBass',
    'sonicGroundLowMid',
    'sonicGroundMid',
    'sonicGroundHighMid',
    'sonicGroundPresence',
    'sonicGroundBrilliance',
    'sonicGroundAir',
    'sonicGroundFloatingEnabled',
    'sonicGroundFloatingIntensity',
    'sonicGroundFloatingMinSize',
    'sonicGroundFloatingMaxSize',
    'sonicGroundFloatingSpeed',
    'sonicGroundFloatingCount',
    'sonicAudioMonitorEnabled',
    'sonicAudioAutoTrack',
    'sonicAudioSensitivity',
    'sonicAudioBandStart',
    'sonicAudioBandEnd',
    'sonicAudioThreshold',
    'sonicAudioPulseStrength',
    'sonicWorkshopInputGain',
    'sonicWorkshopAudioIntensity',
    'sonicWorkshopResponseRange',
    'sonicWorkshopPeakIntensity',
    'sonicWorkshopColorMode',
    'sonicWorkshopTheme',
    'sonicWorkshopCustomColor',
    'sonicWorkshopBaseColorMode',
    'sonicWorkshopBaseColor',
    'sonicWorkshopWarmColorMode',
    'sonicWorkshopWarmColor',
    'sonicWorkshopCoolColorMode',
    'sonicWorkshopCoolColor',
    'sonicWorkshopRippleColorMode',
    'sonicWorkshopRippleColor',
    'sonicWorkshopPeakColorMode',
    'sonicWorkshopPeakColor',
    'cameraViewSaved',
    'cameraViewMode',
    'cameraOrbitTheta',
    'cameraOrbitPhi',
    'cameraOrbitRadius',
    'cameraFreePositionX',
    'cameraFreePositionY',
    'cameraFreePositionZ',
    'cameraFreeYaw',
    'cameraFreePitch',
    'cameraFreeRoll',
    'cameraFreeFov',
    'visualRotationSaved',
    'visualRotationX',
    'visualRotationY'
  ];
  if (!/sonic-topography-preset\.js/.test(loaderText) || !/var INDEX = 7/.test(sonicText) || !/function deriveTerrainGridSettings/.test(sonicText) || !/TERRAIN_BASE_SIZE = 168/.test(sonicText) || !/TERRAIN_MAX_GRID_SIZE = 224/.test(sonicText)) {
    fail('Sonic Topography preset must load as a bounded Mineradio-native port of the latest GitHub visual layer');
  }
  if (/gl_FragCoord\.y\s*>\s*uScreenClipPx/.test(sonicText) || /uScreenClipPx/.test(sonicText) || /screenHeight[\s\S]{0,120}\*\s*0\.50/.test(sonicText)) {
    fail('Sonic Topography terrain must not use a hard half-screen fragment clip');
  }
  if (!/function updateSonicRotation/.test(sonicText) || !/function bindVisualRotation/.test(sonicText) || !/state\.boundRotX/.test(sonicText) || !/state\.boundRotY/.test(sonicText) || !/state\.autoYaw/.test(sonicText) || !/sonicGroundAutoRotate/.test(sonicText) || !/state\.root\.rotation\.x\s*=\s*state\.boundRotX/.test(sonicText) || !/state\.root\.rotation\.y\s*=\s*state\.boundRotY\s*\+\s*state\.autoYaw/.test(sonicText) || !/visualRotationActive/.test(sonicText)) {
    fail('Sonic Topography must bind both X/Y axes to the shared starfield particle rotation');
  }
  if (!/SONIC_ORBIT_BASELINE\s*=\s*\{\s*theta:\s*0\.00,\s*phi:\s*0\.18,\s*radius:\s*8\.4\s*\}/.test(orbitText) || !/function readSonicLyricLookAtTarget/.test(orbitText) || !/SONIC_CAMERA_LYRIC_LOOK_AT/.test(orbitText + focusCameraText) || !/readSonicLyricLookAtTarget\(SONIC_CAMERA_LYRIC_LOOK_AT\)/.test(focusCameraText) || /function applyOrbitPointerDrag/.test(pointerText + orbitText) || /applyOrbitPointerDrag\(dx,\s*dy\)/.test(pointerText) || !/applyParticleSpinDrag\(dx,\s*dy,\s*spinDt\)/.test(pointerText) || !/gestureRotation\.x\s*\+=\s*rx/.test(gestureText) || !/gestureRotation\.y\s*\+=\s*ry/.test(gestureText) || /13\.2;\s*orbit\.userPhi\s*=\s*0\.62/.test(presetGridText)) {
    fail('Sonic Topography drag must rotate the terrain while the camera stays lyric-centered, not high-overhead orbiting the camera');
  }
  if (!/var sonicLyricPreset/.test(stageLyricsText) || !/sonicLyricPreset && !fx\.lyricCameraLock && !wallpaperLyricLock/.test(stageLyricsText) || /sonicLyricCameraBasis/.test(stageLyricsText) || !/setStageLyricViewBasisFromCameraOrQuaternion\(lyricCoverWorldQuat\)/.test(stageLyricsText) || !/stageLyricTargetQuaternion\(lyricCoverWorldQuat,\s*layoutTiltX,\s*layoutTiltY\)/.test(stageLyricsText)) {
    fail('Sonic Topography lyrics must stay bound to the rotatable star-river visual basis instead of the camera');
  }
  if (!/backgroundStarRiver/.test(combinedFxState) || !/id="t-backgroundStarRiver"/.test(indexText) || !/backgroundStarRiverParticles/.test(pointerText) || !/function updateBackgroundStarRiverState/.test(pointerText) || !/fx\.backgroundStarRiver === false/.test(pointerText + fxBindText) || !/presetUsesStarRiverParticles[\s\S]{0,120}SONIC_PRESET_INDEX/.test(mainLoopText) || !/presetStarRiverMuted/.test(mainLoopText) || !/SONIC_PRESET_INDEX[\s\S]{0,100}return 0/.test(pointerText) || /lyricStarRiver/.test(combinedFxState + indexText + fxBindText + pointerText + starRiverText) || !/backgroundGlassOpacity'[\s\S]{0,100}'backgroundStarRiver'/.test(archiveText)) {
    fail('background star river must be a persisted global preset-background switch instead of a lyric effect');
  }
  if (!/visualRotation:\s*particles && particles\.rotation/.test(mainLoopText) || !/visualRotationActive:\s*!!\(orbit && orbit\.rotating\)/.test(mainLoopText)) {
    fail('Sonic Topography must receive the live starfield rotation from the main loop');
  }
  if (!/uSubBass/.test(sonicText) || !/uLowMid/.test(sonicText) || !/uHighMid/.test(sonicText) || !/uGlowIntensity/.test(sonicText) || !/uFogColor/.test(sonicText) || !/1\.0-smoothstep\(55\.0,78\.0,vDistance\)/.test(sonicText) || !/DEFAULT_FLOATING_BLOCK_COUNT = 80/.test(sonicText)) {
    fail('Sonic Topography terrain must use the latest GitHub eight-band terrain shader and floating block layer');
  }
  if (!/RIPPLE_LIFETIME = 4\.8/.test(sonicText) || !/RIPPLE_SOFT_FADE_START = 2\.1/.test(sonicText) || !/lifeFade=1\.0-smoothstep\(2\.10,4\.80,timeSince\)/.test(sonicText) || /\(time - r\.start\) < 2\.4/.test(sonicText)) {
    fail('Sonic Topography ripples must fade out softly instead of hard-clearing mid-decay');
  }
  if (!/new THREE\.BoxGeometry\(settings\.boxWidth,\s*1,\s*settings\.boxWidth\)/.test(sonicText) || !/new THREE\.BoxGeometry\(1,\s*1,\s*1\)/.test(sonicText)) {
    fail('Sonic Topography cells and floating blocks must use the latest density-derived GitHub geometry');
  }
  if (!/function deriveGroundLayoutSettings/.test(sonicText) || !/sonicGroundRange/.test(sonicText) || !/state\.root\.rotation\.x\s*=\s*state\.boundRotX/.test(sonicText) || !/state\.root\.position\.set\(0,\s*layout\.y,\s*layout\.z\)/.test(sonicText) || !/state\.root\.scale\.setScalar\(layout\.scale\)/.test(sonicText)) {
    fail('Sonic Topography must expose a wide, lyric-safe horizontal platter layout inside Mineradio camera space');
  }
  if (!/MAX_VISUAL_PRESET_INDEX = 12/.test(coreText) || !/SONIC_PRESET_INDEX = 7/.test(coreText) || !/SONIC_WORKSHOP_PRESET_INDEX = 8/.test(coreText) || !/MAX_VISUAL_PRESET_INDEX/.test(runtimeText + persistenceText)) {
    fail('Sonic preset 7 and Workshop derivative preset 8 must survive autosave and startup restore clamps');
  }
  if (!/音域回响/.test(archiveText) || !/presetDisplayOrder = \[0, 9, 10, 11, 12, 6, 7, 8/.test(archiveText) || /音域回响[\s\S]{0,120}disabled:\s*true/.test(archiveText)) {
    fail('Sonic Topography must be exposed as the selectable 音域回响 preset');
  }
  if (!archiveText.includes('音域回响 <span class="pc-name-en">Sonic-Topography</span>')
    || !archiveText.includes('作者 <span class="pc-author-ajin">Ajin</span>')
    || !archiveText.includes('音域回响 <span class="pc-name-en">Wallpaper Engine</span>')
    || !archiveText.includes("desc: '作者 CmzYa'")
    || !/var name = p\.nameHtml \|\| p\.name/.test(presetGridText)
    || !/\.preset-card \.pc-name-en[\s\S]{0,260}font-size:\s*9px/.test(presetCssText)
    || !/\.preset-card \.pc-author-ajin[\s\S]{0,100}color:\s*#f59e0b/.test(presetCssText)) {
    fail('Sonic preset cards must preserve their English subtitles and Ajin/CmzYa author credits');
  }
  [
    path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'assets', 'index-Z-j1MQ-r.js'),
    path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'assets', 'index-Bhwp8mwk.css'),
    path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'project.json'),
    path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'preview.gif')
  ].forEach((vendorFile) => {
    if (!fs.existsSync(vendorFile)) fail('Sonic Workshop derivative preset is missing packaged Wallpaper Engine asset: ' + path.relative(appRoot, vendorFile));
  });
  if (!/sonic-workshop-preset\.js/.test(loaderText) || !/BRIDGE_SRC = 'vendor\/sonic-workshop\/mineradio-bridge\.html'/.test(sonicWorkshopText) || !/MineradioSonicWorkshop\.update/.test(mainLoopText) || !/visual\.sonic-workshop/.test(mainLoopText) || !/MineradioSonicWorkshop\.onPresetChange/.test(presetGridText) || !/workshopPresetActive/.test(mainLoopText)) {
    fail('Sonic Workshop derivative preset must load, fade as preset 8, hide base particles, and update from the main loop');
  }
  if (!/canvasAnchor\.parentNode\.insertBefore\(layer,\s*canvasAnchor\)/.test(sonicWorkshopText) || !/layer\.setAttribute\('inert'/.test(sonicWorkshopText) || !/iframe\.setAttribute\('inert'/.test(sonicWorkshopText) || !/iframe\.style\.pointerEvents\s*=\s*'none'/.test(sonicWorkshopText) || !/#sonic-workshop-layer,\s*#sonic-workshop-layer \*[\s\S]{0,120}pointer-events:\s*none !important/.test(fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8'))) {
    fail('Sonic Workshop iframe layer must remain fully pointer-transparent so player buttons and window controls stay clickable');
  }
  if (!/wallpaperRegisterAudioListener/.test(sonicWorkshopBridgeText) || !/__mineradioApplyAudio/.test(sonicWorkshopBridgeText) || !/__mineradioApplyMedia/.test(sonicWorkshopBridgeText) || !/theme:\s*'coral-mirage'/.test(sonicWorkshopBridgeText) || !/themeCycleInterval:\s*50/.test(sonicWorkshopBridgeText) || !/gridSize:\s*320/.test(sonicWorkshopBridgeText) || !/audioIntensity:\s*1\.15/.test(sonicWorkshopBridgeText) || !/responseRange:\s*1\.3/.test(sonicWorkshopBridgeText) || !/peakColorIntensity:\s*0\.62/.test(sonicWorkshopBridgeText) || !/pulseSensitivity:\s*0\.05/.test(sonicWorkshopBridgeText) || !/pulseCooldown:\s*0/.test(sonicWorkshopBridgeText) || !/meteorSensitivity:\s*0\.3/.test(sonicWorkshopBridgeText) || !/cameraDistance:\s*80/.test(sonicWorkshopBridgeText) || !/autoRotateEnabled:\s*true/.test(sonicWorkshopBridgeText) || !/autoRotateSpeed:\s*7/.test(sonicWorkshopBridgeText) || !/cameraAngleX:\s*150/.test(sonicWorkshopBridgeText) || !/cameraAngleY:\s*30/.test(sonicWorkshopBridgeText) || !/showPlayerController:\s*false/.test(sonicWorkshopBridgeText)) {
    fail('Sonic Workshop bridge must preserve the requested Wallpaper Engine default parameters and receive Mineradio audio/media');
  }
  const sonicWorkshopVendorText = fs.readFileSync(path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'assets', 'index-Z-j1MQ-r.js'), 'utf8');
  if (!/mineradioCustomTheme/.test(sonicWorkshopBridgeText) || !/mineradioCustomTheme/.test(sonicWorkshopText) || !/function workshopCustomThemeForColor/.test(sonicWorkshopText) || !/function workshopPaletteHexesFromCover/.test(sonicWorkshopText) || !/function workshopCustomThemeForPalette/.test(sonicWorkshopText) || !/function workshopCustomThemeForRegions/.test(sonicWorkshopText) || !/function workshopRegionsFromFx/.test(sonicWorkshopText) || !/function applyWorkshopThemeTransition/.test(sonicWorkshopText) || !/WORKSHOP_THEME_TRANSITION_MS\s*=\s*1280/.test(sonicWorkshopText) || !/function applyThemeTransition/.test(sonicWorkshopBridgeText) || !/THEME_TRANSITION_STEP_MS\s*=\s*33/.test(sonicWorkshopBridgeText) || /scheduleWorkshopThemeTransition\(\);/.test(sonicWorkshopText) || !/__mineradioPaletteHexes/.test(sonicWorkshopText) || !/rawWarm/.test(paletteText + sonicWorkshopText) || !/rawCool/.test(paletteText + sonicWorkshopText) || !/rawAreaPrimary/.test(paletteText + sonicWorkshopText + accentControlText) || !/sonicWorkshopColors/.test(paletteText + sonicWorkshopText) || !/coverSourceKey/.test(paletteText + accentControlText) || !/function ensureSonicWorkshopCoverPaletteForUi/.test(accentControlText) || !/function sonicWorkshopCurrentCoverDomSource/.test(accentControlText) || !/function buildSonicWorkshopUiPaletteFromCanvas/.test(accentControlText) || !/function sonicWorkshopUiPaletteForKey/.test(accentControlText) || !/sonicWorkshopCoverUiSample\.palette/.test(accentControlText) || !/coverPickerCanvas/.test(accentControlText) || !/coverProxySrc/.test(accentControlText) || !/coverColors/.test(paletteText + sonicWorkshopText) || !/sonic-workshop-cool-picker/.test(indexText + fxBindText) || !/sonic-workshop-peak-picker/.test(indexText + fxBindText) || !/setSonicWorkshopRegionColorFromPicker/.test(fxBindText + sonicWorkshopText + accentControlText) || !/function sonicRawPaletteHex/.test(accentControlText) || /function sonicWorkshopCoverHex[\s\S]{0,700}sonicPaletteHex/.test(accentControlText) || !/uCoolCore:\s*cool/.test(sonicWorkshopText) || !/uRippleColor:\s*ripple/.test(sonicWorkshopText) || !/MRt\(We\.mineradioCustomTheme\.value\)/.test(sonicWorkshopVendorText) || !/Be\(function\(Mr\)\{return Mr===0\?1e-6:0\}\)/.test(sonicWorkshopVendorText)) {
    fail('Sonic Workshop cover/custom colors must feed the real vendor terrain theme instead of only recoloring the UI controls');
  }
  if (!/colorLabState\.picker\)\s*colorLabState\.picker\.value\s*=\s*hex/.test(colorLabText) || !/id === 'sonic-workshop-cover-picker'[\s\S]{0,180}\^sonic-workshop-/.test(colorLabText) || !/pointerdown[\s\S]{0,180}updateColorLabFromSv\(e\)/.test(fxBindText) || !/function sonicWorkshopRegionControl\(id\)\s*\{[\s\S]{0,120}typeof id === 'object' && id\.id/.test(accentControlText) || !/function pushSonicWorkshopColorChange/.test(accentControlText) || !/function setSonicWorkshopThemeFromPicker[\s\S]{0,520}sonicWorkshopColorControls\(\)\.forEach/.test(accentControlText) || !/pushSonicWorkshopColorChange\(item\.colorKey\)/.test(accentControlText)) {
    fail('Sonic Workshop color lab changes must commit into fx state, UI swatches, saved settings, and the live iframe theme');
  }
  if (!/function isPlaybackSpaceKey/.test(keyboardCameraText) || !/if \(isPlaybackSpaceKey\(e\)\) return;/.test(keyboardCameraText)) {
    fail('Space playback hotkey must not mark render interaction before resume playback');
  }
  if (!/global\.frequencyData/.test(sonicWorkshopText) || /sonicAudioMonitorState/.test(sonicWorkshopText) || /MineradioSonicWorkshop\.update\([\s\S]{0,260}audio:\s*sonicAudioFrame/.test(mainLoopText)) {
    fail('Sonic Workshop derivative must use the local player analyser bridge instead of the original Sonic realtime spectrum frame');
  }
  if (!/WORKSHOP_AUDIO_TARGET_MAX_SAMPLE\s*=\s*0\.52/.test(sonicWorkshopText) || !/WORKSHOP_AUDIO_GAMMA\s*=\s*1\.55/.test(sonicWorkshopText) || !/WORKSHOP_AUDIO_MIN_FLOOR\s*=\s*0\.035/.test(sonicWorkshopText) || !/function workshopAudioFrameStats/.test(sonicWorkshopText) || !/function shapeWorkshopAudioValue/.test(sonicWorkshopText) || !/sonicWorkshopInputGain/.test(sonicWorkshopText) || /Math\.pow\(clamp01\(value\),\s*0\.68\)/.test(sonicWorkshopText) || /1\.05\s*\+\s*energy\s*\*\s*0\.34/.test(sonicWorkshopText)) {
    fail('Sonic Workshop bridge must keep Wallpaper-like dark-field audio shaping instead of overdriving the terrain');
  }
  if (/getUserMedia|getDisplayMedia|desktopCapturer|MediaStream|D:\\\\Steam|workshop\\content/.test(sonicWorkshopText + sonicWorkshopBridgeText)) {
    fail('Sonic Workshop derivative must use packaged assets and Mineradio analyser data instead of runtime capture or the Steam workshop path');
  }
  if (!/fx-sonicamp/.test(indexText) || !/fx-sonicrange/.test(indexText) || !/fx-sonicair/.test(indexText) || !/sonic-ground-base-picker/.test(indexText) || !/fx-sonicfloatcount/.test(indexText) || !/t-sonicGroundFloatingEnabled/.test(indexText) || !/音域地形/.test(indexText) || !/\^fx-sonic/.test(fxPanelText)) {
    fail('visual console must expose layout, color, ground EQ, and floating block controls for 音域回响');
  }
  if (!/fx-sonicaudiobandstart/.test(indexText) || !/sonic-audio-monitor-canvas/.test(indexText) || !/t-sonicAudioAutoTrack/.test(indexText) || !/06-sonic-audio-monitor\.js/.test(loaderText)) {
    fail('visual console must expose the Sonic realtime spectrum range monitor and auto-track controls');
  }
  if (!/function stepSonicAudioMonitor/.test(sonicAudioText) || !/SONIC_AUDIO_BEAT_WINDOWS/.test(sonicAudioText) || !/sonicAudioTrackAutoPulse/.test(sonicAudioText) || !/sonicAudioStepKickEnvelope/.test(sonicAudioText) || !/drawSonicAudioMonitorPanel/.test(sonicAudioText)) {
    fail('Sonic Topography must include the GitHub-derived realtime spectrum, kick envelope, auto-track, and monitor panel module');
  }
  if (!/function sonicAudioHzRangeAverage/.test(sonicAudioText) || !/sonicHzDetailed/.test(sonicAudioText) || !/startHz:\s*46[\s\S]{0,80}endHz:\s*118/.test(sonicAudioText) || !/widthPenalty/.test(sonicAudioText) || !/sampleRate:\s*analysisSampleRate/.test(mainLoopText) || !/fftSize:\s*analysisFftSize/.test(mainLoopText)) {
    fail('Sonic realtime spectrum must use live Hz band analysis for kick windows instead of auto-tracking arbitrary treble bins');
  }
  if (!/SONIC_AUDIO_BASE_BINS\s*=\s*512/.test(sonicAudioText) || !/SONIC_AUDIO_AUTO_TRACK_SCAN_BINS\s*=\s*192/.test(sonicAudioText) || /sonicAudioBandStart[\s\S]{0,90}0,\s*250/.test(combinedFxState) || /sonicAudioBandEnd[\s\S]{0,90}2,\s*256/.test(combinedFxState) || /fx-sonicaudiobandstart[\s\S]{0,90}max="250"/.test(indexText) || /fx-sonicaudiobandend[\s\S]{0,90}max="256"/.test(indexText)) {
    fail('Sonic realtime spectrum must expose the full 512-bin control window across runtime, UI, save, and archive paths');
  }
  if (/getUserMedia|getDisplayMedia|desktopCapturer|MediaStream/.test(sonicAudioText + mainLoopText)) {
    fail('Sonic realtime audio must reuse Mineradio analyser data instead of requesting system or microphone capture');
  }
  if (!/stepSonicAudioMonitor\(frequencyData,\s*audioStepDt/.test(mainLoopText) || !/audio:\s*sonicAudioFrame\s*\|\|/.test(mainLoopText) || !/raw\.sonicDetailed/.test(sonicText)) {
    fail('Sonic Topography must receive detailed realtime audio frames while keeping the legacy bass/mid/treble fallback');
  }
  if (!/function readSonicRealtimeCameraSample/.test(beatCameraText) || !/sonicAudioMonitorState\.frame/.test(beatCameraText) || !/cinemaProfileSample/.test(mainLoopText) || !/sonicAudioFrame && sonicAudioFrame\.sonicDetailed/.test(mainLoopText)) {
    fail('cinematic camera sampling must fuse the Sonic realtime spectrum frame without replacing the original analyser path');
  }
  if (!/function sonicCoverGroundTheme/.test(sonicText) || !/stage\.coverPalette/.test(sonicText) || !/sonicGroundColorMode/.test(sonicText) || !/sonicGroundColorAuto/.test(persistenceText) || !/封面取色/.test(fxBindText + fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '02-accent-background-controls.js'), 'utf8'))) {
    fail('Sonic Topography colors must default to cover-palette sampling and switch to persistent custom colors only after user color selection');
  }
  requiredSonicFields.forEach((field) => {
    if (!combinedFxState.includes(field)) {
      fail(`missing Sonic ground preset field in save/archive/UI path: ${field}`);
    }
  });
  if (!/captureCameraArchiveState/.test(archiveText) || !/applyCameraArchiveState\(data\)/.test(archiveText) || !/applyVisualRotationArchiveState\(data\)/.test(archiveText) || !/isCameraArchiveKey\(key\)/.test(archiveText) || !/cameraViewSaved/.test(archiveText) || !/visualRotationSaved/.test(archiveText) || !/USER_FX_SHARE_KEYS[\s\S]*cameraFreeFov[\s\S]*visualRotationY/.test(archiveText)) {
    fail('user visual archives must save and restore camera plus shared visual rotation state without breaking old MR2 payloads');
  }
  if (!/MineradioSonicTopography\.update/.test(mainLoopText) || !/visual\.sonic-topography/.test(mainLoopText) || !/MineradioSonicTopography\.onPresetChange/.test(presetGridText) || !/MineradioSonicTopography\.pointerRipple/.test(pointerText)) {
    fail('Sonic Topography must update from the main loop, release meshes on preset changes, and support pointer ripples');
  }
  console.log('[OK] 音域回响 preset is selectable, bounded, saved, and driven by existing rhythm envelopes.');
}

function checkLongPressReorderGuard() {
  logStep('Long press playlist/queue reorder guard');
  const queueActionsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '10-queue-actions.js'), 'utf8');
  const panelShellText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
  const playlistDetailText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const shelfCoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const shelfInteractionText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '05-card-interactions.js'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
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

function checkPlaylistPanelTriggerGuard() {
  logStep('Playlist panel trigger guard');
  const peekText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '02-peek-panels-upload.js'), 'utf8');
  const panelShellText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
  const fxDefaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const fxRuntimeText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const persistenceText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
  const fxBindText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const focusCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '03-focus-cinema-camera.js'), 'utf8');
  const desktopMainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  if (!/PLAYLIST_PANEL_HIDE_DELAY\s*=\s*72/.test(peekText) || /key === 'pl' && isPlaylistPanelInMotion/.test(peekText)) {
    fail('left playlist panel close must start promptly instead of keeping the large hover bridge alive during motion');
  }
  if (!/function isPlaylistPanelOpeningMotion/.test(peekText) || !/!panel\.classList\.contains\('playlist-panel-closing'\)/.test(peekText) || !/function isPlaylistPanelActiveState[\s\S]{0,180}isPlaylistPanelOpeningMotion\(panel\)/.test(peekText)) {
    fail('playlist panel hit testing must treat opening motion as active but exclude closing motion from the trigger area');
  }
  if (!/function isPlaylistFullscreenEdgeMode/.test(peekText) || !/!isPlaylistFullscreenEdgeMode\(\)[\s\S]{0,220}state\.isPrimaryDisplay === false[\s\S]{0,120}state\.hasDisplayOnLeft/.test(peekText)) {
    fail('secondary-display seam guard must be disabled for fullscreen left-edge playlist access');
  }
  if (!/PLAYLIST_PANEL_EDGE_TRIGGER_X\s*=\s*104/.test(peekText) || !/PLAYLIST_PANEL_FULLSCREEN_EDGE_TRIGGER_X\s*=\s*128/.test(peekText) || !/SECONDARY_PLAYLIST_EDGE_DWELL_MS\s*=\s*220/.test(peekText) || !/SECONDARY_PLAYLIST_SEAM_CLOSE_X\s*=\s*6/.test(peekText)) {
    fail('playlist panel edge trigger thresholds must keep the default edge usable while slowing only secondary-display seam entry');
  }
  if (!/PLAYLIST_PANEL_HOME_EDGE_TRIGGER_X\s*=\s*16/.test(peekText) || !/function playlistPanelInitialEdgeTriggerX\(defaultWidth, eventTarget\)/.test(peekText) || !/eventTarget\.closest\('#empty-home'\)/.test(peekText) || !/isPlaylistEdgeTrigger\(ex, ey, H, e\.target\)/.test(peekText)) {
    fail('home must narrow only the unopened playlist edge trigger so its small controls remain reachable');
  }
  if (!/function isPlaylistPanelBottomControlsConflict/.test(peekText) || !/PLAYLIST_PANEL_BOTTOM_LEFT_BLOCK_X/.test(peekText) || !/shouldClosePlaylistPanelFromPointer\(ppOn,\s*ex,\s*ppRect,\s*ey,\s*H\)/.test(peekText)) {
    fail('playlist panel trigger must yield to the bottom player controls at the lower-left edge');
  }
  if (!/PLAYLIST_PANEL_FULLSCREEN_FOCUS_HOLD_X\s*=\s*14/.test(peekText) || !/PLAYLIST_PANEL_FULLSCREEN_EDGE_LEAVE_TOLERANCE_X\s*=\s*-8/.test(peekText) || !/function isPlaylistFullscreenEdgeFocusHold/.test(peekText) || !/return inTrigger \|\| inPanel \|\| isPlaylistFullscreenEdgeFocusHold\(pp,\s*ex,\s*ey,\s*H\)/.test(peekText)) {
    fail('fullscreen left-edge playlist focus must hold the queue camera only at the screen seam while the panel is active');
  }
  if (/isPlaylistPanelActiveState\(pp\) && ex < targetRect\.right/.test(peekText)) {
    fail('playlist panel focus must not return to a wide x-only focus strip after pointer leaves the panel band');
  }
  const shelfHoverText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '00-layout-hover.js'), 'utf8');
  const shelfPanelSyncText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '02-rebuild-panel-sync.js'), 'utf8');
  // 左侧歌单/队列面板不再驱动镜头：它挂在左边缘的鼠标位置上，所以贴着边缘一晃镜头就跟着摆，整屏
  // 连歌词一起"跳来跳去"。这里把 setFocusZone() 整段抽出来真跑一遍，断言『queue 不激活任何跟拍』
  // 并且『歌单架档位照样能激活』——后半句是防空转：只断言前者的话，一个把任何输入都丢掉的实现也能过。
  // The left playlist/queue panel no longer drives the camera: it follows the pointer on the left edge,
  // so brushing that edge swung the camera and dragged the whole screen — lyrics included. The function
  // is extracted and really invoked to assert that a 'queue' zone activates nothing while a shelf zone
  // still does; the second half is what keeps the first from being vacuous, since an implementation that
  // discarded every input would satisfy it on its own.
  // 判据要读源码文本，而注释里正写着这一段历史，所以先把注释剥掉再比。
  // The checks below read source text and the comments above spell out the same history, so strip
  // comments first.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const focusStart = focusCameraText.indexOf('function setFocusZone(');
  const focusEnd = focusCameraText.indexOf('\nfunction ', focusStart + 1);
  if (focusStart < 0 || focusEnd <= focusStart) fail('setFocusZone() cannot be evaluated');
  const focusCode = stripComments(focusCameraText.slice(focusStart, focusEnd));
  const focusProbe = {
    activated: [],
    timeouts: [],
    orbit: { focus: { active: false, type: null, theta: 0, phi: 0, radius: 0, lookAt: { set: function () { } } } },
    focusHover: { wantType: null, pendingTimer: null, exitTimer: null },
    shouldUseShelfDynamicCamera: function () { return true; },
    activateFocusZone: function (type) { focusProbe.activated.push(type); focusProbe.orbit.focus.active = true; focusProbe.orbit.focus.type = type; },
    setTimeout: function (fn, ms) { focusProbe.timeouts.push(ms); return 1; },
    clearTimeout: function () { }
  };
  vm.runInNewContext('(function () {\n' + focusCode + '\nreturn setFocusZone;\n})()', focusProbe)( 'queue', true);
  if (focusProbe.activated.length || focusProbe.focusHover.wantType !== null) {
    fail('the left playlist/queue panel must not activate any follow camera');
  }
  vm.runInNewContext('(function () {\n' + focusCode + '\nreturn setFocusZone;\n})()', focusProbe)('shelf-side', true);
  if (focusProbe.activated.length !== 1 || focusProbe.activated[0] !== 'shelf-side') {
    fail('the 3D shelf follow camera must still activate, or the queue check above proves nothing');
  }
  // 姿态表里也不能再留着那一档：留一份永远读不到的相机数值，下一个人会以为它还能打开。
  // The pose table must not keep that zone either: camera numbers that can never be read would make the
  // next reader think the zone can still be turned on.
  const poseStart = focusCameraText.indexOf('function activateFocusZone(');
  const poseEnd = focusCameraText.indexOf('function setFocusZone(');
  if (poseStart < 0 || poseEnd <= poseStart || /queue/.test(stripComments(focusCameraText.slice(poseStart, poseEnd)))) {
    fail('the queue follow camera pose must stay deleted from activateFocusZone()');
  }
  if (!/function isFullscreenPlaylistQueueFocusLockedAtEdge/.test(peekText) || !/isPlaylistFullscreenEdgeFocusHold\(panel,\s*ex,\s*ey,\s*innerHeight\)/.test(peekText) || !/function clearShelfPreviewOnPointerExit\(e\)/.test(shelfHoverText) || !/keepQueueFocus \? 'queue' : null/.test(shelfHoverText) || !/clearShelfPreviewOnPointerExit\(e\)/.test(shelfPanelSyncText)) {
    fail('fullscreen left-edge playlist focus must survive edge leave events without broadening 3D shelf focus behavior');
  }
  if (!/function setMainWindowFullscreenResizeGuard/.test(desktopMainText) || !/win\.setResizable\(shouldResize\)/.test(desktopMainText) || !/setMainWindowFullscreenResizeGuard\(win,\s*true\)[\s\S]{0,120}win\.setFullScreen\(true\)/.test(desktopMainText) || !/setMainWindowFullscreenResizeGuard\(win,\s*false\)[\s\S]{0,120}win\.setFullScreen\(false\)/.test(desktopMainText) || !/(?:mainWindow|win)\.on\('enter-full-screen'[\s\S]{0,120}setMainWindowFullscreenResizeGuard\((?:mainWindow|win),\s*true\)/.test(desktopMainText) || !/(?:mainWindow|win)\.on\('leave-full-screen'[\s\S]{0,140}setMainWindowFullscreenResizeGuard\((?:mainWindow|win),\s*false\)/.test(desktopMainText)) {
    fail('native fullscreen must disable BrowserWindow resizing so the Windows resize cursor cannot steal the left-edge playlist focus');
  }
  if (!/resetSecondaryPlaylistEdgeGuard\(\)/.test(panelShellText)) {
    fail('playlist panel soft close must clear pending secondary-edge dwell timers');
  }
  if (!/--playlist-panel-open-ms:\s*var\(--mineradio-playlist-panel-open-ms,\s*280ms\)/.test(cssText) || !/--playlist-panel-close-ms:\s*var\(--mineradio-playlist-panel-close-ms,\s*180ms\)/.test(cssText) || !/setPlaylistPanelCssVar\('--mineradio-playlist-panel-open-ms'/.test(fxRuntimeText) || !/setPlaylistPanelCssVar\('--mineradio-playlist-panel-close-ms'/.test(fxRuntimeText)) {
    fail('playlist panel animation durations must be driven by runtime CSS variables, not only static panel defaults');
  }
  if (!/playlistPanelOpenDuration:\s*0\.72/.test(fxDefaultsText) || !/playlistPanelCloseDuration:\s*0\.48/.test(fxDefaultsText)) {
    fail('playlist panel animation defaults must preserve the captured first-launch state');
  }
  const durationRangeText = [fxRuntimeText, persistenceText, fxBindText, archiveText].join('\n');
  if ((durationRangeText.match(/0\.08,\s*0\.72/g) || []).length < 4 || (durationRangeText.match(/0\.06,\s*0\.48/g) || []).length < 4 || !/fx-playlistopen" type="range" min="0\.08" max="0\.72"/.test(indexText) || !/fx-playlistclose" type="range" min="0\.06" max="0\.48"/.test(indexText)) {
    fail('playlist panel animation slider range must match runtime, persistence, and archive clamps');
  }
  console.log('[OK] Playlist panel trigger, secondary-edge, bottom-control, and animation-duration guards are in sync.');
}

/**
 * 全屏工具行守卫 / Fullscreen tool row guard
 *
 * 起因：全屏时 #desktop-titlebar 整条被隐藏，于是标题栏里那排工具按钮（? / 语言 / 更新 / 热键 / DIY）
 * 会一起消失 —— 而它已经不是第一次了：热键按钮从视觉控制台搬进标题栏（2.4.0）、语言按钮从搜索框
 * 搬进标题栏（同期），两次都静默丢掉了全屏入口，因为没有任何一处守在这条关系上。
 * 所以这里守的不是某几个字符串，而是那条关系本身：**标题栏控件簇里的每个工具控件都必须在
 * FULLSCREEN_TOOL_SELECTORS 名单里**（名单由 HTML 反推，不是抄一份快照），以及这条链路
 * 每一步都在（状态变化 → 搬移 / 全屏隐藏标题栏 / 工具行只在全屏显示 / 未浮现时不可 Tab 可达）。
 *
 * Why this exists: fullscreen hides the whole title bar, which silently takes the tool buttons with it.
 * That already happened twice (the hotkey button moved in from the visual console in 2.4.0, the language
 * button from the search box in the same period) because nothing guarded the relationship. So the guard
 * checks the relationship, not a handful of strings: every tool control in the title bar cluster must be
 * in FULLSCREEN_TOOL_SELECTORS (derived from the HTML, not a hand-copied snapshot), and every step of the
 * chain must be present.
 */
// 自动节奏分析开关（默认关闭）的守卫。
// 为什么值得写：这个开关唯一的硬要求就是「默认关闭」，而它由**四处彼此独立**的归一化代码共同决定
// —— fxDefaults、两个持久化归一化（raw / fx 两条路径）、以及存档与分享码归一化。任何一处写成
// `!== false`，缺键就会变成开启，而界面上完全看不出异常：开关只是"自己打开了"，用户不会知道为什么。
// 分享码那边还更隐蔽 —— 码是按下标编码的，别人用旧版本生成的码里根本没有这个键。
// 另外它必须真的拦在分析入口上，否则开关只是装饰。
// Guard for the automatic-beat-analysis switch, which must default to off. That single requirement is
// decided by four independent normalisers (fxDefaults, both persistence paths, the archive/share
// normaliser), and one `!== false` among them turns a missing key into "on" with no visible symptom.
// The share-code path hides it best: codes are index-encoded, so an older build's code has no such key.
// The switch must also actually gate the analysis entry points, or it is decoration.
function checkBeatAnalysisToggleGuard() {
  logStep('Beat analysis toggle guard');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const layoutText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const persistenceText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const beatText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  const panelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const bindingsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  // 判据读源码文本，而上面的注释里正写着同样的键名与 `!== false`，所以先剥注释。
  // The checks read source text and the comments above spell out the same names, so strip comments first.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const defaultsCode = stripComments(defaultsText);
  const layoutCode = stripComments(layoutText);
  const persistenceCode = stripComments(persistenceText);
  const archiveCode = stripComments(archiveText);
  const beatCode = stripComments(beatText);
  const panelCode = stripComments(panelText);
  const bindingsCode = stripComments(bindingsText);
  const indexCode = stripComments(indexText);

  // 1) 默认值必须是显式 false。
  if (!/beatAnalysis:\s*false\s*,/.test(defaultsCode)) {
    fail('fxDefaults must declare beatAnalysis: false — the feature is meant to ship off');
  }

  // 2) 三处归一化只能认显式 true。逐条点名 raw/fx 两条持久化路径，因为它们是分别写的、可以只改一条。
  if (!/beatAnalysis:\s*raw\.beatAnalysis === true/.test(persistenceCode)) {
    fail('the persistence normaliser (raw path) must read beatAnalysis === true, or a missing key becomes on');
  }
  if (!/beatAnalysis:\s*fx\.beatAnalysis === true/.test(persistenceCode)) {
    fail('the persistence normaliser (fx path) must read beatAnalysis === true, or a missing key becomes on');
  }
  if (!/beatAnalysis:\s*raw\.beatAnalysis === true/.test(archiveCode)) {
    fail('the archive/share normaliser must read beatAnalysis === true, or importing an older code turns it on');
  }
  // 反向：这几处一律不许出现 `!== false` 形态（那正是"缺键即开启"的写法）。
  if (/beatAnalysis[^\n]*!==\s*false/.test(persistenceCode) || /beatAnalysis[^\n]*!==\s*false/.test(archiveCode)) {
    fail('beatAnalysis must never be normalised with `!== false`: a missing key would silently turn the default-off switch on');
  }

  // 3) 行为验证而不是文本验证：把 beatAnalysisEnabled() 抽进沙箱真跑。文本只能说明"写了 === true"，
  //    跑一遍才能证明「缺键 / undefined / 字符串 / 数字 一律是关，只有字面量 true 是开」。
  // Behavioural rather than textual: extract the predicate and actually run it. Text only proves the
  // characters are there; running proves a missing key, undefined, a string and a number all read as off.
  const predicateStart = layoutCode.indexOf('function beatAnalysisEnabled()');
  if (predicateStart < 0) fail('beatAnalysisEnabled() is missing from the fx runtime state module');
  const predicateRest = layoutCode.slice(predicateStart);
  const predicateNext = predicateRest.search(/\n(?:async\s+)?function\s/);
  const predicateBody = predicateNext < 0 ? predicateRest : predicateRest.slice(0, predicateNext);
  const probe = fxLiteral => vm.runInNewContext(
    '(function () { var fx = ' + fxLiteral + ';\n' + predicateBody + '\nreturn beatAnalysisEnabled(); })()',
    {}
  );
  const probeCases = [
    ['undefined fx', 'undefined', false],
    ['missing key', '{}', false],
    ['explicit false', '{ beatAnalysis: false }', false],
    ['string "true"', '{ beatAnalysis: "true" }', false],
    ['number 1', '{ beatAnalysis: 1 }', false],
    ['explicit true', '{ beatAnalysis: true }', true]
  ];
  probeCases.forEach(function (entry) {
    const got = probe(entry[1]);
    if (got !== entry[2]) {
      fail('beatAnalysisEnabled() must return ' + entry[2] + ' for ' + entry[0] + ', got ' + got);
    }
  });

  // 4) 门控必须真的拦在分析入口上。逐函数切开比对，不能只在整文件里找一次：那样把门控只留在
  //    其中一个入口、删掉另一个，判据照样绿。
  // Each analysis entry point is sliced out and checked on its own: searching the whole file would
  // stay green if the gate survived on one entry point and was deleted from another.
  const inBody = (source, signature) => {
    const at = source.indexOf(signature);
    if (at < 0) return '';
    const rest = source.slice(at + signature.length);
    const next = rest.search(/\n(?:async\s+)?function\s/);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const gatedEntries = [
    ['function scheduleBeatAnalysis(', 'the on-demand analysis scheduler'],
    ['function scheduleQueueBeatPrefetch(', 'the queue prefetch scheduler'],
    ['function runQueueBeatPrefetch(', 'the prefetch worker (the switch can flip while it awaits)']
  ];
  gatedEntries.forEach(function (entry) {
    const body = inBody(beatCode, entry[0]);
    if (!body) fail(entry[0] + ' not found — it is a gated analysis entry point');
    else if (!/beatAnalysisEnabled\(\)/.test(body)) {
      fail(entry[1] + ' must bail out when automatic beat analysis is off');
    }
  });

  // 5) 面板接线。开关必须存在、能反映状态、且改动会被持久化 —— 少了持久化，重启就自己弹回默认值。
  if (!/id="t-beatAnalysis"/.test(indexCode) || !/onclick="toggleFx\('beatAnalysis'\)"/.test(indexCode)) {
    fail('the panel must expose #t-beatAnalysis wired to toggleFx(\'beatAnalysis\')');
  }
  if (!/data-i18n="toggle_beat_analysis"/.test(indexCode)) {
    fail('the new switch label must go through the dictionary, or it renders as a bare key');
  }
  if (!/getElementById\('t-beatAnalysis'\)/.test(panelCode) || !/fx\.beatAnalysis === true/.test(panelCode)) {
    fail('updateFxInputs/updatePerformanceControls must reflect fx.beatAnalysis onto #t-beatAnalysis');
  }
  if (!/key === 'beatAnalysis'\)\s*saveLyricLayout/.test(bindingsCode)) {
    fail('toggleFx must persist beatAnalysis, or the switch reverts to its default after a restart');
  }
  if (!/cancelBeatAnalysisTimer\(\)/.test(bindingsCode) || !/cancelBeatPrefetchTimer\(\)/.test(bindingsCode)) {
    fail('turning the switch off must cancel the queued analysis and prefetch, not just flip a flag');
  }

  // 6) 存档与分享码是按下标编码的（见 USER_FX_SHARE_KEYS 里的 Append-only 标记），所以新键只能
  //    追加在末尾。这里把「最后一个追加前的老键」的下标钉死：往后追加不影响它，而只要有人把新键
  //    插在中间，下标立刻变化 —— 那种改动会静默解错所有已发出的分享码。
  // The archive key list is index-encoded, so a new key may only be appended. Pinning the index of the
  // last pre-append key catches a middle insertion, which would silently mis-decode every issued code.
  const shareKeysStart = archiveCode.indexOf('var USER_FX_SHARE_KEYS = [');
  const shareKeysEnd = archiveCode.indexOf('];', shareKeysStart);
  const shareKeys = shareKeysStart < 0 || shareKeysEnd < 0
    ? []
    : Array.from(archiveCode.slice(shareKeysStart, shareKeysEnd).matchAll(/'([A-Za-z0-9_]+)'/g)).map(m => m[1]);
  if (shareKeys.indexOf('lyricTextureClarity') !== 205) {
    fail('USER_FX_SHARE_KEYS must stay append-only: lyricTextureClarity moved from index 205 to ' + shareKeys.indexOf('lyricTextureClarity'));
  }
  if (shareKeys[shareKeys.length - 1] !== 'beatAnalysis') {
    fail('beatAnalysis must be the last USER_FX_SHARE_KEYS entry so the next append goes after it');
  }

  // 7) 四语都要有文案：缺一份，那个语言的开关就显示裸键。
  ['toggle_beat_analysis', 'fx_beat_analysis_title', 'bind_beat_analysis_on', 'bind_beat_analysis_off'].forEach(function (key) {
    ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'].forEach(function (lang) {
      const dict = fs.readFileSync(path.join(appRoot, 'public', 'locales', lang + '.json'), 'utf8');
      if (!dict.includes('"' + key + '"')) fail('locale ' + lang + ' is missing the key ' + key);
    });
  });

  // 8) 面板在运行时会把这排开关整体搬进「系统 → 性能与后台」分组（fxConsoleAppendItem 里是
  //    appendChild，会改父节点），没登记的会被残留扫描收进「其他设置」—— 它仍然在面板里，只是
  //    位置不对，所以没有任何报错、截图也看不出异常。判据落在"同格兄弟全都要登记"而不是只钉这
  //    一个键：只钉一个的话，下次往这排里加开关会以完全相同的方式漏掉。
  // The panel re-parents this grid into System → performance at runtime (fxConsoleAppendItem calls
  // appendChild), and anything unregistered is swept into "other settings" — still in the panel, just
  // in the wrong place, so nothing errors and a screenshot looks fine. Judge the whole sibling grid,
  // not this one key: a per-key check would let the next switch in this row slip through identically.
  const consoleText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  const consoleCode = stripComments(consoleText);
  const gridAt = indexCode.indexOf('id="visual-performance-toggle-grid"');
  if (gridAt < 0) fail('the panel must keep #visual-performance-toggle-grid, the row this switch lives in');
  const nextGridAt = indexCode.indexOf('fx-toggle-grid', gridAt + 1);
  const gridHtml = nextGridAt < 0 ? indexCode.slice(gridAt) : indexCode.slice(gridAt, nextGridAt);
  const gridIds = Array.from(gridHtml.matchAll(/id="(t-[A-Za-z0-9_]+)"/g)).map(m => m[1]);
  if (gridIds.indexOf('t-beatAnalysis') < 0) {
    fail('t-beatAnalysis must sit in the realtime-visual-performance grid with its siblings');
  }
  const unregistered = gridIds.filter(id => !consoleCode.includes("fxConsoleItem('" + id + "'"));
  if (unregistered.length) {
    fail('every switch in the realtime-visual-performance grid must be registered in the console layout, '
      + 'or the residual sweep files it under "other settings": ' + unregistered.join(', '));
  }

  console.log('[OK] Automatic beat analysis defaults to off, is gated on every analysis entry point, and is wired to the panel.');
}

// 备用更新线路的极简版本说明守卫。
// 为什么值得写：GitHub API 取不到 Release 时（限流 / 网络 / 404），客户端会去 Release 资产里取
// latest.yml 作为备用线路。这个文件出问题**双方都不会报错**：客户端读到的版本比当前低，就安静地
// 显示"已是最新"，用户永远收不到更新提示 —— 这正是它曾经的状态（文件停在 2.2.0，包版本已到 2.4.3）。
// 另一头是反方向的风险：改用打包工具生成的 dist/latest.yml 会带 files[].url / sha512 / path，
// 配上 Release 里的 .blockmap 就是 electron-updater 的完整自动更新源，任何 electron-builder 生态的
// 客户端都能静默下载安装，绕过"只提示、用户自行去网盘下载"的设计。两个方向都要钉住。
// 另外把文件内容真的喂给解析器跑一遍：这个文件的标量是逐行正则取的，而它顶部有一大段注释，
// 注释里又必然写着 "version" 这个词 —— 文本判据看不出注释是否会被误当成键。
// Guard for the minimal version manifest behind the fallback update path. When the GitHub API is
// unavailable the client reads latest.yml from the release assets, and a broken file fails silently
// on both sides: a version lower than the running build makes the client report "up to date" forever
// (which is exactly what happened — the file sat at 2.2.0 while the package reached 2.4.3). The
// opposite risk is swapping in the builder-generated dist/latest.yml, whose files[].url / sha512 /
// path plus the .blockmap form a full electron-updater feed. And the content is fed to the real
// parser: its scalars are read line-by-line with a regex while the file opens with a prose comment
// that necessarily contains the word "version", so source text cannot show whether that comment is
// mistaken for a key.
// 平台（provider）注册表守卫。
// 这是"以后新增一个音源不会漏"的**机制本身**：注册表是唯一数据源，各处清单都由能力位派生，
// 任何地方重新写死一份平台清单都必须失败。历史教训是同一个清单散落 6 处、彼此不一致，而漏掉
// 一处**不报任何错** —— 只表现为"那个平台在某些功能里就是不存在"（汽水在搜索里有、在自动换源里没有）。
// Guard for the provider registry — the mechanism that keeps a newly added source from being missed.
// The registry is the single data source and every list derives from a capability flag, so any place
// that reintroduces a hardcoded platform list has to fail. The history: the same list lived in six
// places, none agreeing, and a miss reported nothing at all — it only showed up as "that platform
// simply does not exist for this feature" (Qishui was in search but absent from auto-fallback).
function checkProviderRegistryGuard() {
  logStep('Provider registry single-source guard');
  const registryText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '16-provider-registry.js'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');

  // 1) 模块必须被加载，且排在消费方之前（消费方在**加载时**就按能力取清单）。
  // The module must be loaded, and ahead of its consumers, which derive their lists at LOAD time.
  if (!loaderText.includes("'js/modules/00-state/16-provider-registry.js'")) {
    fail('the provider registry must be registered in index-loader.js, or nothing that derives from it loads');
  }
  const registryAt = loaderText.indexOf('16-provider-registry.js');
  ['05-playback/07-search.js', '05-playback/11-provider-fallback.js', '08-account/01-login-modal-utils.js',
    '08-account/03-login-modal-flows.js', '08-account/04-user-modal-logout.js', '06-lyrics/01-playlist-panel-shell.js'
  ].forEach(function (consumer) {
    const at = loaderText.indexOf(consumer);
    if (at < 0) fail('consumer ' + consumer + ' is not registered in index-loader.js');
    else if (at < registryAt) fail('the provider registry must load before ' + consumer + ', which derives its list from it');
  });

  // 2) 行为验证：真跑注册表，断言每个能力位的集合。这些集合同时定义多处清单的语义。
  // Behavioural: run the registry and assert each capability set. These sets define several lists at once.
  const probe = { console };
  vm.createContext(probe);
  vm.runInContext(registryText + '\nthis.sets = {' +
    'login: providerRegistryKeysWith("login"),' +
    'mainSearch: providerRegistryKeysWith("mainSearch"),' +
    'sourceSwitcher: providerRegistryKeysWith("sourceSwitcher"),' +
    'directFallback: providerRegistryKeysWith("directFallback"),' +
    'preferred: providerRegistryKeysWith("preferred"),' +
    'all: providerRegistryKeys()' +
    '};', probe);
  const expectedSets = {
    login: 'netease,qq,kugou,qishui,spotify',
    mainSearch: 'netease,qq,kugou,qishui',
    sourceSwitcher: 'netease,qq,kugou,qishui,spotify',
    directFallback: 'netease,qq,kugou',
    preferred: 'netease,qq,kugou,qishui,spotify',
    all: 'netease,qq,kugou,qishui,spotify'
  };
  Object.keys(expectedSets).forEach(function (capability) {
    const got = (probe.sets[capability] || []).join(',');
    if (got !== expectedSets[capability]) {
      fail('provider registry capability "' + capability + '" is now [' + got + '], expected ['
        + expectedSets[capability] + '] — every list deriving from it changes with it');
    }
  });
  // ⚠️ 只有 directFallback 必须排除 Spotify，**preferred 不能排除**。
  //    两者的语义不同：directFallback 要求"能直接拿到可播放地址"（Spotify 做不到，换过去还得再换一次）；
  //    preferred 只是决定查找顺序里谁排最前 —— 开了「唤起 Spotify 客户端」的 Premium 用户正是靠
  //    本机客户端播 Spotify 曲目，所以要能把它设为默认源。
  //    我最初把两者一并排除，是按"它播不了"这个单一理由推的，漏掉了客户端唤起这条真实播放路径。
  // ⚠️ Only directFallback excludes Spotify; preferred must NOT. They ask different questions:
  //    directFallback requires a directly playable URL (Spotify cannot, so a fallback there would have
  //    to switch again), while preferred merely decides who goes first in the lookup order — and a
  //    Premium user with the client-launch setting plays Spotify tracks natively. Excluding both was a
  //    single-reason inference that missed the client-launch playback path.
  if ((probe.sets.directFallback || []).indexOf('spotify') >= 0) {
    fail('spotify must not be in "directFallback": it never yields a playable URL, so the fallback would '
      + 'land on an equally unplayable source and have to switch again');
  }
  if ((probe.sets.preferred || []).indexOf('spotify') < 0) {
    fail('spotify must be selectable as a preferred source: users who play Spotify through the launched '
      + 'client need their tracks matched to Spotify first');
  }

  // 3) 每个消费方都必须**从注册表派生**。逐处点名能力位，而不是只检查"文件里提到过注册表"：
  //    只检查提到过的话，把某处改回字面量、而文件别处仍引用注册表，判据照样绿。
  // Every consumer must DERIVE from the registry. Each site names its capability: checking only that a
  // file mentions the registry would stay green when one site reverts to a literal.
  const consumerSites = [
    ['public/js/modules/05-playback/07-search.js', "providerRegistryKeysWith('sourceSwitcher')", 'the playback source switcher list'],
    ['public/js/modules/05-playback/07-search.js', "providerRegistryKeysWith('mainSearch')", 'the search panel platform list'],
    ['public/js/modules/05-playback/07-search.js', "providerRegistryHasCapability(provider, 'mainSearch')", 'the search capability check'],
    ['public/js/modules/05-playback/11-provider-fallback.js', "providerRegistryKeysWith('directFallback')", 'the auto-fallback candidate list'],
    ['public/js/modules/05-playback/11-provider-fallback.js', "providerRegistryHasCapability(provider, 'preferred')", 'the preferred-source readiness check'],
    ['public/js/modules/08-account/01-login-modal-utils.js', "providerRegistryKeysWith('login')", 'the account platform list'],
    ['public/js/modules/08-account/03-login-modal-flows.js', "providerRegistryKeysWith('login')", 'the login workflow platform list'],
    ['public/js/modules/08-account/04-user-modal-logout.js', "providerRegistryKeysWith('login')", 'the logged-provider count'],
    ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', "providerRegistryKeysWith('login')", 'the playlist catalogue sweeps']
  ];
  consumerSites.forEach(function (site) {
    const text = fs.readFileSync(path.join(appRoot, site[0]), 'utf8');
    if (!text.includes(site[1])) {
      fail(site[2] + ' must derive from the registry via ' + site[1] + ' — a hand-kept list silently '
        + 'skips any platform added later');
    }
  });

  // 4) 禁止重新写死平台清单。**这一条才是「以后加源不会漏」的机制**：只靠"我改过了"是不够的，
  //    必须让下一个人写死清单时立刻失败。
  // ⚠️ 白名单只收「优先级声明」形式，且那条文件必须同时从注册表补全集合（下面紧接着断言）——
  //    白名单不是"允许写死"，而是"允许声明顺序，集合仍由注册表决定"。
  // No hardcoded platform lists may come back. THIS is the mechanism: "I already converted them" is not
  // enough — the next person writing a literal list has to fail immediately. The whitelist only admits
  // PRIORITY declarations, and each such file must also complete its set from the registry, asserted
  // right after. It is not "hardcoding allowed"; it is "ordering allowed, set still decided by the registry".
  const PRIORITY_LITERAL_ALLOWLIST = [
    {
      file: 'public/js/modules/06-lyrics/01-playlist-panel-shell.js',
      literal: "['netease', 'spotify']",
      // ⚠️ 必须点名**该处**的补全语句，不能只检查"文件里提到过注册表"：该文件别处还有别的注册表调用，
      //    只检查"提到过"的话，把这一处的补全删掉判据照样绿（反向验证抓到的就是这个）。
      //    所以这里存的是那句补全本身，比对时去掉空白以便不受缩进影响。
      // ⚠️ The completion for THIS site must be named explicitly. Checking merely that the file mentions
      //    the registry stays green when this particular completion is deleted, because the file calls
      //    the registry elsewhere too — exactly what the reverse verification caught. The marker is the
      //    completion statement itself, compared whitespace-insensitively so indentation cannot matter.
      completion: "var order = PLAYLIST_CATALOG_PREFETCH_PRIORITY.slice();"
        + "providerRegistryKeysWith('login').forEach(function (provider) {"
        + "if (order.indexOf(provider) < 0) order.push(provider);});",
      reason: 'playlist catalogue prefetch priority (netease first, then Spotify); the set is completed '
        + 'from the registry right below and the resulting order is unchanged'
    }
  ];
  const PLATFORM_LIST_RE = /\[\s*'(?:netease|qq|kugou|qishui|spotify)'(?:\s*,\s*'(?:netease|qq|kugou|qishui|spotify)')+\s*\]/;
  const offenders = [];
  const scanFile = function (file) {
    const text = fs.readFileSync(file, 'utf8');
    // 先剥注释：注释里举例说明平台清单是说明性的，不是代码。
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const match = code.match(PLATFORM_LIST_RE);
    if (!match) return;
    const literal = match[0].replace(/\s+/g, ' ');
    const relative = rel(file);
    const allowed = PRIORITY_LITERAL_ALLOWLIST.some(function (entry) {
      return entry.file === relative && entry.literal.replace(/\s+/g, ' ') === literal;
    });
    if (!allowed) offenders.push(relative + '  ' + literal);
  };
  const walkForLists = function (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^(node_modules|\.git|dist|custom-source)$/.test(entry.name)) continue;
        walkForLists(full);
      } else if (entry.name.endsWith('.js')) scanFile(full);
    }
  };
  ['public/js/modules', 'desktop', 'server'].forEach(function (root) { walkForLists(path.join(appRoot, root)); });
  if (offenders.length) {
    fail('hardcoded platform list(s) found — every list must derive from the provider registry, or a '
      + 'platform added later silently misses this feature:\n      ' + offenders.join('\n      '));
  }
  PRIORITY_LITERAL_ALLOWLIST.forEach(function (entry) {
    const text = fs.readFileSync(path.join(appRoot, entry.file), 'utf8');
    // 去掉所有空白再比对：缩进/换行风格都不该影响结果，但**必须是这一处的**补全语句。
    // Whitespace is stripped before comparing, so indentation cannot matter — but it must be THIS site's
    // completion statement, not merely some mention elsewhere in the file.
    const compact = text.replace(/\s+/g, '');
    if (!compact.includes(entry.completion.replace(/\s+/g, ''))) {
      fail('the allowlisted priority declaration in ' + entry.file + ' must complete its set from the '
        + 'registry (' + entry.reason + '), or it is just a hardcoded list again');
    }
  });

  // 5) 默认源偏好：默认值、纯读、以及「显式不指定」可区分。
  //    写回默认值会把"默认"锁死成"用户的选择"（本项目在关闭行为上真踩过），所以读必须是纯读。
  // The preferred-source preference: its default, that reading is pure, and that an explicit "none" is
  // distinguishable. Writing the default back would freeze it into a user choice.
  const preferenceProbe = function (stored) {
    const box = { console };
    if (stored !== undefined) {
      box.localStorage = { _v: stored, getItem() { return this._v; }, setItem(key, value) { this._v = String(value); } };
    }
    vm.createContext(box);
    vm.runInContext(registryText + '\nthis.pref = readPreferredSourcePreference();'
      + '\nthis.provider = preferredSourceProvider();'
      + '\nthis.options = preferredSourceOptions();', box);
    return box;
  };
  const unset = preferenceProbe(undefined);
  if (unset.pref !== 'netease' || unset.provider !== 'netease') {
    fail('with nothing stored the preferred source must be netease (the requested default), got '
      + JSON.stringify(unset.pref));
  }
  if (preferenceProbe('auto').provider !== '') {
    fail('an explicit "auto" must resolve to no preferred source; collapsing it into the default would '
      + 'make that dropdown option a no-op');
  }
  if (preferenceProbe('qq').provider !== 'qq') fail('a stored platform key must be honoured');
  if (preferenceProbe('spotify').provider !== 'spotify') {
    fail('spotify must be honoured as a preferred source (it is selectable in the dropdown)');
  }
  // 不认识的平台（已下线/被移除）仍要自愈回默认值，而不是让整条链路拿到空值。
  // An unknown platform (retired/removed) must still self-heal to the default rather than leaving the
  // chain with an empty value.
  if (preferenceProbe('gone-provider').provider !== 'netease') {
    fail('a stored but unknown platform key must fall back to the default preferred source');
  }
  const optionValues = (unset.options || []).map(function (option) { return option.value; });
  if (optionValues.join(',') !== 'auto,' + expectedSets.preferred) {
    fail('the dropdown options must be "auto" plus the registry preferred set, got [' + optionValues.join(',') + ']');
  }
  const writeProbe = { console, localStorage: { getItem() { return null; }, setItem() { writeProbe.wrote = true; } } };
  vm.createContext(writeProbe);
  vm.runInContext(registryText + '\nthis.pref = readPreferredSourcePreference();', writeProbe);
  if (writeProbe.wrote) {
    fail('reading the preferred source must not write to storage: persisting a default locks it in as a '
      + 'user choice, so changing the default later stops applying');
  }

  // 6) 接线：设置项要真的存在且由注册表填充；播放链路要真的调用选源，并在 await 之后验 token
  //   （否则用户在这段时间里切歌会把已失效的结果播出去）。
  // Wiring: the setting must exist and be filled from the registry, and the playback path must call the
  // resolver and re-check its token after the await.
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  if (!/id="preferred-source-select"[^>]*onchange="setPreferredSourceProvider\(this\.value\)"/.test(indexText)) {
    fail('index.html must declare #preferred-source-select wired to setPreferredSourceProvider()');
  }
  if (!/data-i18n="settings_preferred_source"/.test(indexText)) {
    fail('the preferred-source label must go through the dictionary, or it renders as a bare key');
  }
  // ⚠️ 登记的是**外层容器**而非 <select>：运行时面板按登记表把控件 appendChild 进分组页，只搬登记过的
  //    那个节点，标签若是兄弟节点就会被留在被丢弃的旧容器里 —— 下拉仍在，但**没有标题**，看不出
  //    是干什么的（本轮实测过一次：截图里只有下拉、没有「默认源」三个字）。
  //    同时容器类必须进「块」选择器，否则 select 会被当成无归属裸控件按扫描顺序落位。
  // ⚠️ The WRAPPER is registered, not the <select>: the runtime panel appends the registered node into
  //    its group page, so a sibling label would stay behind in the discarded container — the dropdown
  //    would survive but lose its title (measured this round: the screenshot showed the control with no
  //    "默认源" label). The wrapper class must also be in the block selector, or the select degrades to
  //    an unowned bare control placed by scan order.
  const consoleText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  if (!/id="preferred-source-row"[\s\S]{0,400}id="preferred-source-select"/.test(indexText)) {
    fail('#preferred-source-select must be wrapped in #preferred-source-row together with its label, so '
      + 'the console moves the label along with the control');
  }
  if (!/fxConsoleItem\('preferred-source-row'/.test(consoleText)) {
    fail('the preferred-source wrapper must be registered in the console layout, or the residual sweep '
      + 'files it under "other settings" (wrong place, no error)');
  }
  if (!/fxConsoleItem\('t-spotifyLaunchClient'/.test(consoleText)) {
    fail('t-spotifyLaunchClient must be registered too — it was missed when added and has been sitting in '
      + '"other settings" since');
  }
  if (!/var blockSelector = '\.fx-select-row,/.test(consoleText)) {
    fail('the block selector must include .fx-select-row, or the wrapped control is treated as an unowned '
      + 'bare control and placed by scan order rather than by its registration');
  }
  const startText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const hookAt = startText.indexOf('await resolvePreferredSourceSong(song, opts)');
  if (hookAt < 0) fail('playQueueAt must apply the preferred source before using the song downstream');
  else if (!/token !== trackSwitchToken/.test(startText.slice(hookAt, hookAt + 320))) {
    fail('the preferred-source hook must re-check its token after awaiting, or a track the user switched '
      + 'to during the search would play the stale result');
  }
  // 内层搜索的就绪门必须同时接受「可被指定为默认源」的平台，否则选了汽水会永远搜不到
  // ——这条是测试抓出来的真实缺陷，钉住它。
  const fallbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js'), 'utf8');
  if (!/!sourceFallbackProviderReady\(target\) && !preferredSourceProviderReady\(target\)/.test(fallbackText)) {
    fail('the shared search must accept preferred-capability providers too, or a Qishui preference passes '
      + 'the outer check and is rejected inside: the option would never work');
  }

  // 7) 四语词条齐全（缺一份，那个语言的下拉与提示就显示裸键）。
  ['settings_preferred_source', 'settings_preferred_source_sub', 'settings_preferred_source_auto',
    'settings_preferred_source_on', 'settings_preferred_source_off'].forEach(function (key) {
    ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'].forEach(function (lang) {
      const dict = fs.readFileSync(path.join(appRoot, 'public', 'locales', lang + '.json'), 'utf8');
      if (!dict.includes('"' + key + '"')) fail('locale ' + lang + ' is missing the key ' + key);
    });
  });

  console.log('[OK] Every platform list derives from the single provider registry, no hardcoded list can come '
    + 'back, and the preferred source defaults to netease with a pure (non-persisting) read.');
}

function checkUpdateManifestGuard() {
  logStep('Fallback update manifest guard');
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const manifestText = fs.readFileSync(path.join(appRoot, 'docs', 'update', 'latest.yml'), 'utf8');
  const workflowPath = path.join(appRoot, '.github', 'workflows', 'release.yml');
  const workflowText = fs.readFileSync(workflowPath, 'utf8');
  // 判据要读 workflow 文本，而上面解释"为什么去掉 blockmap"的注释里正写着 blockmap 这个词，
  // 所以先剥注释 —— 否则注释自己就能把判据喂绿。
  // The checks read the workflow text and the comment above spells out "blockmap", so strip first —
  // otherwise the comment alone would satisfy the assertion.
  const workflowCode = workflowText.replace(/(^|[^:])\/\/[^\n]*/g, '$1').split('\n')
    .filter((line) => !/^\s*#/.test(line)).join('\n');

  // 1) 版本必须与 package.json 一致：这是"静默失效"的唯一入口，必须由机械判据盯着。
  // The version must match package.json: this is the one way the file fails silently, so a machine
  // has to watch it rather than a release checklist.
  const parsed = /^version:\s*(.+)$/m.exec(manifestText);
  if (!parsed) fail('docs/update/latest.yml must declare a version scalar');
  const manifestVersion = parsed[1].trim().replace(/^['"]|['"]$/g, '');
  if (manifestVersion !== pkg.version) {
    fail('docs/update/latest.yml says version ' + manifestVersion + ' but package.json is ' + pkg.version
      + '; the fallback update path would silently report "up to date"');
  }

  // 2) 反方向：绝不能出现自动更新源字段。逐字段点名，而不是找一次 "files"。
  // The other direction: none of the auto-update feed fields may appear. Each is named on its own.
  ['files', 'path', 'url', 'sha512'].forEach(function (field) {
    if (new RegExp('^\\s*' + field + '\\s*:', 'm').test(manifestText)) {
      fail('docs/update/latest.yml must not declare `' + field + ':` — those fields turn it into an '
        + 'electron-updater feed that can silently download and install, bypassing the mirror-only design');
    }
  });

  // 3) 发布流程必须真的把这份文件发布出去，并且不能同时放上 blockmap。
  // The release workflow must actually publish this file, and must not ship the blockmap alongside it.
  if (!/Copy-Item docs\/update\/latest\.yml dist\/latest\.yml -Force/.test(workflowCode)) {
    fail('release.yml must overwrite the builder-generated dist/latest.yml with the minimal manifest, '
      + 'or the auto-update feed fields reach the release assets');
  }
  if (/(^|\s)dist\/\*?\.?blockmap/.test(workflowCode)) {
    fail('release.yml must not upload .blockmap: paired with a feed manifest it completes an auto-update path');
  }
  if (!/dist\/latest\.yml/.test(workflowCode)) {
    fail('release.yml must still publish latest.yml, or the fallback path has nothing to read');
  }

  // 4) 行为验证：把文件内容真的喂给解析器。文本判据证明不了"注释没被当成键"。
  // Behavioural probe: feed the real content to the parser. Source text cannot show whether the
  // leading comment is mistaken for a key.
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
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
  const probeManifest = (text) => {
    const probe = { console, manifestText: text };
    vm.createContext(probe);
    vm.runInContext([
      extractFn(serverText, 'yamlScalar'),
      extractFn(serverText, 'normalizeVersion'),
      extractFn(serverText, 'compareVersions'),
      'this.scalarVersion = yamlScalar(manifestText, "version");',
      'this.scalarDate = yamlScalar(manifestText, "releaseDate");',
      'this.normalized = normalizeVersion(this.scalarVersion);',
      // 端到端语义：备用线路要能对"比它老的客户端"报出更新可用，否则它是接好了但没用。
      // End-to-end semantics: the fallback must report an update as available to an older client,
      // otherwise the path is wired but useless.
      'this.newerThanOldBuild = compareVersions(this.scalarVersion, "2.0.0");'
    ].join('\n'), probe, { filename: 'update-manifest-probe' });
    return probe;
  };
  // 两种行尾都要测：工作区的 .yml 是 CRLF（.gitattributes 只给 .js/.json/.md 等指定 eol=lf），
  // 而 CI checkout 之后是 LF。只测本地那种的话，"本地读得到版本、发布后读不到"这类差异
  // 永远不会在本地暴露。
  // Both line endings are exercised: the working tree keeps .yml as CRLF (only .js/.json/.md get
  // eol=lf) while a CI checkout yields LF. Testing just the local variant would hide any
  // "reads fine here, not after publishing" difference.
  [['CRLF', manifestText], ['LF', manifestText.replace(/\r\n/g, '\n')]].forEach(function (variant) {
    const probe = probeManifest(variant[1]);
    if (probe.normalized !== pkg.version) {
      fail('the parser must read ' + pkg.version + ' out of the manifest with ' + variant[0]
        + ' line endings (its leading comment must not be mistaken for a key); got '
        + JSON.stringify(probe.normalized));
    }
    if (!probe.scalarDate) {
      fail('the parser must still find releaseDate in the manifest with ' + variant[0] + ' line endings');
    }
    if (probe.newerThanOldBuild !== 1) {
      fail('compareVersions must see the manifest version as newer than an older build with '
        + variant[0] + ' line endings, got ' + probe.newerThanOldBuild);
    }
  });

  // 5) 发布正文必须带上「网盘下载」标记。
  // 客户端从 Release 正文里解析 `mineradio-download-page` 标记来构造软件内的「网盘下载」入口；
  // 标记没了**不会报错**，只会安静地退回成「打开 Release 页面」，用户再也拿不到不限速直链。
  // 实测过一次：v2.4.3 的 Release 正文里就没有这个标记，而当时记录了这条要求的 RELEASE.md
  // 已被删除 —— 于是"必须有标记"这件事既没人执行、也没人检查。
  // 这里同时把 URL 与 README 里公布的分发入口对齐：两处写的是同一个网盘，改了一处另一处必须跟上，
  // 否则用户从软件内点进去、和从 README 点进去会拿到两个不同的链接，而两边都不报错。
  // The release body must carry the mirror-download marker. The client parses
  // `mineradio-download-page` out of it; a missing marker fails silently by degrading the in-app
  // entry to "open the release page". v2.4.3 shipped without it while the RELEASE.md that documented
  // the requirement had already been deleted — nobody enforced it and nothing checked it. The URL is
  // also aligned with the distribution route published in README: two places advertise one mirror,
  // and a one-sided edit would send users to different links from the app and from the docs.
  const markerPattern = /<!--\s*mineradio-download-page\s*:\s*([^|<>\r\n]{1,32})\s*\|\s*(https:\/\/[^\s<>]+?)\s*-->/g;
  // 扫的是已剥注释的 workflowCode：上面解释"标记必须保留"的那段注释里正写着这个词。
  // Scanning the comment-stripped text: the comment above spells the marker name out.
  const markers = Array.from(workflowCode.matchAll(markerPattern));
  if (!markers.length) {
    fail('release.yml must emit a `mineradio-download-page` marker in the release body, or the in-app '
      + 'mirror-download entry silently degrades to "open the release page"');
  }
  const readmeText = fs.readFileSync(path.join(appRoot, 'README.md'), 'utf8');
  markers.forEach(function (marker) {
    if (!readmeText.includes(marker[2])) {
      fail('the mirror URL in release.yml (' + marker[2] + ') is not published in README.md: the two '
        + 'documented download routes would drift apart with nothing failing');
    }
  });

  console.log('[OK] The fallback update manifest matches package.json, stays free of auto-update feed fields, is '
    + 'published by the release workflow, and the real parser reads the right version out of it in both line endings. '
    + 'The release body still carries its mirror-download marker, aligned with README.');
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
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
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

// 歌单 / 队列多选 → 批量加入内置歌单的接线守卫。
// 为什么值得写：这条链路横跨五层（主进程库 → IPC → preload → 渲染层 helper → 多选模块），少接一层
// 都不会报错，只会「功能静静地不存在」—— 勾选框不出现、工具条不出现、点了没反应，控制台一片干净。
// 更隐蔽的是虚拟滚动：勾选态一旦被存进 DOM，滚出视野再滚回来就丢了，而短列表上完全看不出来。
// 所以判据分三块：(1) 五层符号齐全，且 IPC 频道名两侧拼的是同一个串；(2) HTML / CSS / i18n 的落点
// 都在，且新增词条真的被消费（没消费的键就是死文案）；(3) 把整个多选模块放进沙箱真跑一遍，验证
// 「按行下标记勾选」「换个歌单不继承上一次的勾选」「全选 / 取消全选」。
// Guard for multi-select over the queue and the playlist detail, plus the bulk "add to built-in
// playlist" path. The feature spans five layers (library -> IPC -> preload -> renderer helper ->
// multi-select module) and a missing link fails silently: no checkboxes, no bar, no reaction, clean
// console. The virtualised lists make it worse — selection kept in the DOM is lost as soon as a row
// scrolls out and back, which a short list never reveals. Three parts: layer symbols with both sides
// of the IPC channel spelled identically; HTML/CSS/i18n anchors with every new key actually consumed;
// and the module itself run in a sandbox to prove the index-keyed bookkeeping and the scope pinning.
function checkPlaylistMultiselectGuard() {
  logStep('Playlist / queue multi-select guard');
  const MULTISELECT_MODULE = 'public/js/modules/06-lyrics/07-playlist-multiselect.js';
  const readText = (relative) => fs.readFileSync(path.join(appRoot, relative), 'utf8');
  // 判据读源码文本，而上面的注释里正写着同样的名字，所以先剥注释。
  // The checks read source text and the comments above spell out the same names, so strip first.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const libraryCode = stripComments(readText('desktop/built-in-playlist-library.js'));
  const mainCode = stripComments(readText('desktop/main.js'));
  const preloadCode = stripComments(readText('desktop/preload.js'));
  const loaderCode = stripComments(readText('public/js/index-loader.js'));
  const rendererCode = stripComments(readText('public/js/modules/06-lyrics/00-built-in-playlists.js'));
  const shellCode = stripComments(readText('public/js/modules/06-lyrics/01-playlist-panel-shell.js'));
  const detailCode = stripComments(readText('public/js/modules/06-lyrics/02-playlist-detail.js'));
  const multiselectCode = stripComments(readText(MULTISELECT_MODULE));
  const indexCode = stripComments(readText('public/index.html'));
  const cssCode = stripComments(readText('public/css/index.css'));

  // ── 1) 五层符号，以及两侧必须拼出同一个频道名 ──────────────────────────────
  if (!/addTracks\(id, sources\)\s*\{/.test(libraryCode)) {
    fail('BuiltInPlaylistLibrary must expose addTracks(id, sources): one mutate for the whole batch');
  }
  if (!/addBuiltInPlaylistTracks:\s*\(/.test(preloadCode)) {
    fail('preload must export addBuiltInPlaylistTracks');
  }
  const bulkChannel = /addBuiltInPlaylistTracks:[\s\S]{0,120}?ipcRenderer\.invoke\('([^']+)'/.exec(preloadCode);
  if (!bulkChannel) fail('addBuiltInPlaylistTracks must invoke its own IPC channel');
  else {
    // 只钉"存在这个名字"是不够的：频道名两边各写一次，改名时只改一侧就会得到一个永远不返回的
    // invoke（渲染层 await 挂住，界面没有任何报错）。所以用 preload 里的名字去主进程找 handler。
    // Naming both sides separately is not enough: renaming one side yields an invoke that never
    // resolves and the awaited promise simply hangs with nothing in the UI.
    if (!mainCode.includes("ipcMain.handle('" + bulkChannel[1] + "'")) {
      fail('main and preload must agree on the bulk-add channel: preload invokes ' + bulkChannel[1] + ' but main does not handle it');
    }
    if (!new RegExp("ipcMain\\.handle\\('" + bulkChannel[1] + "'[\\s\\S]{0,200}?isTrustedMainWindowIpc\\(event\\)").test(mainCode)) {
      fail('the bulk-add channel must keep the untrusted-sender guard every other playlist mutation has');
    }
  }
  if (!/async function addTracksToBuiltInPlaylist\(/.test(rendererCode)) {
    fail('the renderer must expose addTracksToBuiltInPlaylist(id, tracks): one IPC call per batch');
  }
  if (!/window\.desktopWindow\.addBuiltInPlaylistTracks\(/.test(rendererCode)) {
    fail('the renderer bulk helper must go through window.desktopWindow.addBuiltInPlaylistTracks');
  }
  if (!loaderCode.includes("'js/modules/06-lyrics/07-playlist-multiselect.js'")) {
    fail('the multi-select module must be registered in index-loader.js, or none of it is ever loaded');
  }

  // ── 2) 勾选框只能由「行构造器」发出：两处列表各管自己的 scope ───────────────
  // 队列行与歌单详情行分别是两个渲染函数，只接一处的话另一个列表就没有勾选框 —— 而另一处往往
  // 正好是用户抱怨的那个列表。逐处点名，而不是在整文件里找一次。
  // The queue row and the playlist-detail row are rendered by two different functions; wiring only
  // one leaves the other list without checkboxes. Each site is named instead of searched once.
  [
    ['the queue row builder', shellCode, "playlistMultiActiveFor('queue')"],
    ['the playlist-detail row builder', detailCode, "playlistMultiActiveFor('detail', st.key)"]
  ].forEach(function (site) {
    if (!site[1].includes(site[2])) {
      fail(site[0] + ' must ask whether multi-select is active for its own scope');
    }
    if (!site[1].includes('playlistMultiCheckboxHtml(i)')) {
      fail(site[0] + ' must render the row checkbox from the full-list index');
    }
    if (!site[1].includes('playlistMultiRowClass(i)')) {
      fail(site[0] + ' must render the selected-row class from the full-list index');
    }
  });

  // ── 3) 点击拦截必须挂在常驻容器上、且跑在捕获阶段 ──────────────────────────
  // 行是反复重建的（虚拟滚动），监听只能挂容器；而行的播放/跳转写在内联 onclick 里，冒泡阶段拦
  // 已经晚了：歌会先播起来。所以必须是捕获阶段 + stopImmediatePropagation。
  // Rows are rebuilt by the virtualiser, so the listener belongs on the container. The row's own
  // play/navigate handler is an inline onclick, which a bubble-phase listener runs after. Capture
  // phase plus stopImmediatePropagation is what keeps a tick from also starting playback.
  [
    ['the queue list (#queue-list)', 'queue-list'],
    ['the playlist list (#pl-list)', 'pl-list']
  ].forEach(function (site) {
    const at = multiselectCode.indexOf("getElementById('" + site[1] + "')");
    if (at < 0) fail(site[0] + ' must carry the multi-select click listener, not the rows');
    // 监听必须紧跟在刚取到的那个容器后面挂上，否则「容器上挂了监听」这件事就不成立。
    // The listener has to be attached to the container that was just looked up.
    const listenerAt = multiselectCode.indexOf("addEventListener('click'", at);
    if (listenerAt < 0 || listenerAt - at > 160) {
      fail(site[0] + ' must attach its click listener to the container it just looked up');
    }
    // 把监听函数体整个截出来，再看注册语句结尾是不是 `, true)`：只在片段里找 "true" 会被函数体
    // 内的其他 true 骗过。阶段判断读的是函数闭合括号之后那几个字符。
    // Scan to the listener's closing brace, then read what follows it: searching the fragment for
    // "true" would be satisfied by any `true` inside the body, which is a different claim.
    let depth = 0;
    let cursor = multiselectCode.indexOf('{', multiselectCode.indexOf('function', listenerAt));
    const bodyStart = cursor;
    for (; bodyStart >= 0 && cursor < multiselectCode.length; cursor++) {
      if (multiselectCode[cursor] === '{') depth++;
      else if (multiselectCode[cursor] === '}') { depth--; if (depth === 0) { cursor++; break; } }
    }
    const body = bodyStart < 0 ? '' : multiselectCode.slice(bodyStart, cursor);
    if (!/^,\s*true\s*\)/.test(multiselectCode.slice(cursor, cursor + 10).trim())) {
      fail(site[0] + "'s listener must run in the capture phase, or the row's own onclick fires first");
    }
    if (!/stopImmediatePropagation\(\)/.test(body)) {
      fail(site[0] + " must stop propagation, or ticking a row also starts playing it");
    }
  });

  // ── 4) HTML 落点 ──────────────────────────────────────────────────────────
  ['queue-multiselect-btn', 'playlist-multiselect-bar', 'ms-select-all', 'ms-count', 'ms-add', 'ms-done',
    'bulk-playlist-modal', 'bulk-playlist-list', 'bulk-playlist-current', 'bulk-playlist-new-name'].forEach(function (id) {
    if (!indexCode.includes('id="' + id + '"')) fail('index.html must declare #' + id);
  });
  if (!/id="queue-multiselect-btn"[^>]*onclick="playlistMultiToggle\('queue'\)"/.test(indexCode)) {
    fail('the queue entry button must open multi-select for the queue scope');
  }
  if (!/id="ms-select-all"[^>]*onclick="playlistMultiToggleAll\(\)"/.test(indexCode)) {
    fail('the select-all button must be wired to playlistMultiToggleAll()');
  }
  if (!/id="ms-add"[^>]*onclick="playlistMultiOpenPicker\(\)"/.test(indexCode)) {
    fail('the add button must be wired to playlistMultiOpenPicker()');
  }
  if (!/id="ms-done"[^>]*onclick="playlistMultiExit\(\)"/.test(indexCode)) {
    fail('the done button must be wired to playlistMultiExit()');
  }
  // 工具条必须在 #playlist-panel 内部：它靠 sticky bottom 贴着面板的滚动容器，被挪到面板外面就
  // 变成页面底部一条悬空横条。按 div 深度扫描找闭合处，而不是钉"后面某个 id"—— 后者会随无关
  // 改动失效，而失效方向恰好是「永远绿」。
  // The bar relies on sticky-bottom inside the panel's scroll container; outside it, it becomes a
  // floating strip at the page bottom. The panel's closing tag is found by a div-depth scan rather
  // than by pinning a later element's id — that form breaks on unrelated edits, and it breaks green.
  const panelStart = indexCode.indexOf('<div id="playlist-panel"');
  const barStart = indexCode.indexOf('id="playlist-multiselect-bar"');
  let panelEnd = -1;
  if (panelStart >= 0) {
    let depth = 0;
    for (const token of indexCode.slice(panelStart).matchAll(/<div\b|<\/div>/g)) {
      depth += token[0] === '</div>' ? -1 : 1;
      if (depth === 0) { panelEnd = panelStart + token.index + token[0].length; break; }
    }
  }
  // 必须落在面板开标签之后、闭合标签之前：只判「在闭合标签之前」的话，把工具条挪到面板**前面**
  // 照样绿（反向验证抓到的正是这一条），而那时它已经不在面板里了。
  // It has to sit after the panel's opening tag and before its closing tag: checking only the closing
  // side stays green when the bar is moved *ahead* of the panel, where it is equally outside.
  if (panelStart < 0 || barStart < 0 || panelEnd < 0 || barStart < panelStart || barStart > panelEnd) {
    fail('the selection bar must live inside #playlist-panel, or sticky-bottom floats it outside the panel');
  }

  // ── 5) 词条：四语齐全、键序一致、且每一个都被真的用上 ──────────────────────
  const multiselectKeys = ['ms_select', 'ms_select_all', 'ms_clear_all', 'ms_selected_count', 'ms_add_to_playlist',
    'ms_pick_songs_first', 'ms_picker_title', 'ms_no_builtin_target', 'ms_batch_added', 'ms_batch_added_partial', 'ms_batch_dup_all'];
  const keyPositions = {};
  ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'].forEach(function (lang) {
    const dict = JSON.parse(readText('public/locales/' + lang + '.json'));
    const order = Object.keys(dict);
    multiselectKeys.forEach(function (key) {
      if (!dict[key]) fail('locale ' + lang + ' must define ' + key + ', or that language renders a bare key');
    });
    keyPositions[lang] = multiselectKeys.map(function (key) { return order.indexOf(key); });
  });
  // 键序四语必须一致：词典是按位置对齐维护的，插在不同位置会让后续对齐整体错位。
  // Key order must match across the four dictionaries; they are kept aligned by position.
  Object.keys(keyPositions).forEach(function (lang) {
    if (keyPositions[lang].join(',') !== keyPositions.zh_cn.join(',')) {
      fail('locale ' + lang + ' must place the multi-select keys at the same positions as zh_cn');
    }
  });
  // 每个词条都得有人取：没被消费的键是死文案，四语翻译白做，而且没人会发现它其实没接线。
  // Every key must be consumed: an unused key is dead copy that silently never reaches the UI.
  ['ms_select', 'ms_picker_title'].forEach(function (key) {
    if (!indexCode.includes('data-i18n="' + key + '"')) {
      fail('index.html must take ' + key + ' from the dictionary instead of hardcoding the label');
    }
  });
  ['ms_select_all', 'ms_clear_all', 'ms_selected_count', 'ms_add_to_playlist', 'ms_pick_songs_first',
    'ms_no_builtin_target', 'ms_batch_added', 'ms_batch_added_partial', 'ms_batch_dup_all'].forEach(function (key) {
    if (!multiselectCode.includes("'" + key + "'") && !detailCode.includes("'" + key + "'")) {
      fail('no module renders ' + key + ': the key is dead copy');
    }
  });

  // ── 6) CSS：默认隐藏 + 勾只在选中态出现 ───────────────────────────────────
  if (!/\.ms-check\.on svg\s*\{[\s\S]{0,80}?opacity:\s*1/.test(cssCode)) {
    fail('the tick must only be drawn on .ms-check.on, or every row reads as selected');
  }
  if (!/\.multiselect-bar\s*\{[\s\S]{0,420}?display:\s*none/.test(cssCode) || !/\.multiselect-bar\.show\s*\{\s*display:\s*flex/.test(cssCode)) {
    fail('the selection bar must start hidden and be revealed by .show — a bar that is always visible covers the last rows');
  }
  // 选择器后面必须紧跟 `,` 或 `{`：只匹配前缀的话，把 `.qi-act` 改成 `.qi-act-unused` 也照样命中
  // （反向验证抓到过这一条），而那等于把这排按钮又放回来了。
  // The selector must be followed by `,` or `{`: matching the bare prefix stays green when the rule is
  // renamed to `.qi-act-unused`, which is the same thing as putting the buttons back.
  if (!/body\.playlist-multiselect \.queue-item \.qi-act\s*[,{]/.test(cssCode)
    || !/body\.playlist-multiselect \.pl-detail-remove\s*[,{]/.test(cssCode)) {
    fail('per-row action buttons must be hidden in multi-select, or a tick click reads as a remove/collect click');
  }

  // ── 7) 行为验证：把整个多选模块放进沙箱真跑 ───────────────────────────────
  // DOM 查询一律返回 null：这里测的是「勾选怎么记、scope 怎么认」，不是渲染。文本判据只能说明
  // 函数名写在文件里；跑一遍才能证明勾选真的按下标记、且换一个歌单不会继承上一次的勾选。
  // Behavioural probe: the whole module runs in a sandbox with every DOM lookup returning null. Text
  // only proves the names are present; running proves the selection is index-keyed and that opening
  // another playlist does not inherit the previous selection.
  const vm = require('vm');
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {}, toggle() {} } }
    }
  };
  vm.createContext(sandbox);
  const probeSource = multiselectCode + '\n' + [
    "playQueue = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];",
    'var out = {};',
    "playlistMultiState = { active: true, scope: 'queue', key: '', selected: Object.create(null) };",
    'playlistMultiToggleIndex(2);',
    'playlistMultiToggleIndex(0);',
    'playlistMultiToggleIndex(2);',
    'out.toggledCount = playlistMultiCount();',
    'out.toggledIndices = playlistMultiSelectedIndices().join(",");',
    'out.toggledSongs = playlistMultiSelectedSongs().map(function (song) { return song.name; }).join(",");',
    'playlistMultiToggleAll();',
    'out.allCount = playlistMultiCount();',
    'playlistMultiToggleAll();',
    'out.clearedCount = playlistMultiCount();',
    "playlistMultiState = { active: true, scope: 'detail', key: 'mineradio:A', selected: Object.create(null) };",
    "out.sameKey = playlistMultiActiveFor('detail', 'mineradio:A');",
    "out.otherKey = playlistMultiActiveFor('detail', 'mineradio:B');",
    "out.otherScope = playlistMultiActiveFor('queue');",
    "playlistMultiState = { active: false, scope: 'detail', key: 'mineradio:A', selected: Object.create(null) };",
    "out.whenInactive = playlistMultiActiveFor('detail', 'mineradio:A');",
    'this.probe = out;'
  ].join('\n');
  vm.runInContext(probeSource, sandbox);
  const probe = sandbox.probe || {};
  const expectations = [
    ['toggledCount', 1],
    ['toggledIndices', '0'],
    ['toggledSongs', 'a'],
    ['allCount', 3],
    ['clearedCount', 0],
    ['sameKey', true],
    ['otherKey', false],
    ['otherScope', false],
    ['whenInactive', false]
  ];
  expectations.forEach(function (entry) {
    if (probe[entry[0]] !== entry[1]) {
      fail('playlistMulti ' + entry[0] + ' must be ' + JSON.stringify(entry[1]) + ', got ' + JSON.stringify(probe[entry[0]]));
    }
  });

  console.log('[OK] Multi-select keys selection by row index and pins it to one playlist; bulk add crosses all five layers on one channel name.');
}

function checkFullscreenToolsRowGuard() {
  logStep('Fullscreen tools row guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
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
    fail('the title bar cluster must hold the three window buttons, the .lang-switch wrapper and the tool controls — check the markup or this guard');
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
  // 语言菜单是向下展开的下拉层，指针移进菜单项会离开命中框 —— 菜单开着时必须继续算浮现，
  // 否则鼠标往下一移，整行连菜单一起消失，语言根本切不了。
  if (!/function fullscreenToolsMenuOpen\(\) \{[\s\S]{0,200}?!menu\.hidden/.test(prefsCode)
    || !/if \(!active && fullscreenToolsMenuOpen\(\)\) active = true;/.test(prefsCode)) {
    fail('the tool row must stay revealed while the language menu is open, or the menu cannot be clicked');
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

function checkShuffleQueueOrderGuard() {
  logStep('Shuffle queue order guard');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  if (!/function reorderQueueForShufflePlaybackOrder/.test(controlsText) || !/shuffleArrayInPlace/.test(controlsText) || !/playQueue\.length = 0;[\s\S]{0,100}playQueue\.push\(currentSong\)/.test(controlsText)) {
    fail('shuffle mode must reorder the visible queue into current song plus randomized upcoming playback order');
  }
  const reorderBlock = controlsText.slice(controlsText.indexOf('function reorderQueueForShufflePlaybackOrder'), controlsText.indexOf('function nextTrack'));
  if (/playQueue\s*=/.test(reorderBlock)) {
    fail('shuffle reorder must preserve the queue array reference used by progressive playlist hydration');
  }
  if (/playMode === 'shuffle'\)\s*currentIdx\s*=\s*Math\.floor\(Math\.random\(\)\s*\*\s*playQueue\.length\)/.test(controlsText)) {
    fail('shuffle nextTrack must advance through the randomized queue instead of jumping to a hidden random index');
  }
  if (!/playMode === 'shuffle'\)\s*currentIdx = currentIdx < 0 \? 0 : \(currentIdx \+ 1\) % playQueue\.length/.test(controlsText) || !/opts\.skipShuffleOrder = true/.test(controlsText)) {
    fail('shuffle next/previous controls must walk the randomized queue order without reshuffling every button press');
  }
  if (!/playMode === 'shuffle'[\s\S]{0,220}reorderQueueForShufflePlaybackOrder\(idx/.test(playbackText)) {
    fail('playQueueAt must normalize a selected track into the front of the randomized queue while shuffle is enabled');
  }
  if (!/playMode === 'shuffle' && prevMode !== 'shuffle'[\s\S]{0,120}reorderQueueForShufflePlaybackOrder\(currentIdx/.test(controlsText)) {
    fail('entering shuffle mode must immediately reorder the visible queue into playback order');
  }
  console.log('[OK] Shuffle mode keeps the visible queue aligned with the actual playback order.');
}

function electronExecutable() {
  const exe = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(exe) ? exe : null;
}

function runtimeQaScript() {
  return `
const path = require('path');
const { app, BrowserWindow } = require('electron');

const appRoot = process.env.MINERADIO_QA_APP_ROOT;
const qaPreload = process.env.MINERADIO_QA_PRELOAD;
const pagePath = path.join(appRoot, 'public', 'index.html');
const logs = [];

function finish(code, payload) {
  console.log('MINERADIO_QA_RESULT:' + JSON.stringify(payload));
  setTimeout(() => app.exit(code), 80);
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true,
      preload: qaPreload
    }
  });

  win.webContents.on('console-message', (_event, details) => {
    logs.push({
      level: details && details.level,
      message: String(details && details.message || '').slice(0, 360)
    });
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    finish(1, { ok: false, reason: 'render-process-gone', details, logs });
  });

  await win.loadFile(pagePath);
  await new Promise(resolve => setTimeout(resolve, 3000));

  const result = await win.webContents.executeJavaScript(\`
    (async () => {
      const failures = [];
      const now = performance.now();
      const displayHz = typeof estimatedDisplayRefreshHz === 'function' ? estimatedDisplayRefreshHz() : 0;
      const fpsBeforeBoost = typeof getAdaptiveRenderFps === 'function' ? getAdaptiveRenderFps(now) : 0;
      if (typeof estimatedDisplayRefreshHz !== 'function') failures.push('estimatedDisplayRefreshHz missing');
      if (typeof selectAdaptiveRenderCadence !== 'function') failures.push('selectAdaptiveRenderCadence missing');
      if (typeof sampleAdaptiveFrameCost !== 'function') failures.push('sampleAdaptiveFrameCost missing');
      if (!(displayHz >= 48 && displayHz <= 240)) failures.push('displayHz outside expected range: ' + displayHz);
      if (!(fpsBeforeBoost >= 45 || fpsBeforeBoost === 0)) failures.push('adaptive fps too low: ' + fpsBeforeBoost);
      if (typeof markRenderInteraction === 'function') markRenderInteraction('quick-check', 1000);
      const fpsAfterBoost = typeof getAdaptiveRenderFps === 'function' ? getAdaptiveRenderFps(performance.now()) : 0;
      if (!(fpsAfterBoost === 0 || fpsAfterBoost >= fpsBeforeBoost || fpsAfterBoost >= 60)) {
        failures.push('interaction boost did not preserve fps: ' + fpsBeforeBoost + ' -> ' + fpsAfterBoost);
      }
      function inspectFixedForegroundFpsCadence() {
        if (typeof shouldSkipFixedRenderCadenceFrame !== 'function' || typeof markRenderInteraction !== 'function') {
          return { ok: false, reason: 'fixed cadence helpers missing' };
        }
        const profiles = [];
        [60, 120, 144].forEach(hz => {
          [45, 60, 75, 90, 120].forEach(target => {
            const state = { key: '', lastCheckAt: 0, phase: 0 };
            const seconds = 8;
            let rendered = 0;
            for (let frame = 1; frame <= hz * seconds; frame++) {
              if (!shouldSkipFixedRenderCadenceFrame(state, frame * 1000 / hz, target, hz, String(target))) rendered += 1;
            }
            const actual = rendered / seconds;
            const expected = Math.min(target, hz);
            profiles.push({ hz, target, actual, expected, ok: Math.abs(actual - expected) <= 1 });
          });
        });
        const oldMode = fx && fx.foregroundFpsMode;
        const oldLastRenderAt = renderPerfState && renderPerfState.lastRenderAt;
        const oldBoostUntil = typeof renderInteractionBoostUntil !== 'undefined' ? renderInteractionBoostUntil : 0;
        const oldReason = typeof renderInteractionReason !== 'undefined' ? renderInteractionReason : '';
        let fixedPreserved = false;
        let vsyncCanWake = false;
        try {
          fx.foregroundFpsMode = '45';
          renderPerfState.lastRenderAt = 1234.5;
          markRenderInteraction('qa-fixed-cadence', 20);
          fixedPreserved = renderPerfState.lastRenderAt === 1234.5;
          fx.foregroundFpsMode = 'vsync';
          renderPerfState.lastRenderAt = 1234.5;
          markRenderInteraction('qa-vsync-wake', 20);
          vsyncCanWake = renderPerfState.lastRenderAt === 0 && getAdaptiveRenderFps(performance.now()) === 0;
        } finally {
          if (fx) fx.foregroundFpsMode = oldMode;
          if (renderPerfState) renderPerfState.lastRenderAt = oldLastRenderAt;
          if (typeof renderInteractionBoostUntil !== 'undefined') renderInteractionBoostUntil = oldBoostUntil;
          if (typeof renderInteractionReason !== 'undefined') renderInteractionReason = oldReason;
          if (typeof resetFixedRenderCadenceState === 'function') resetFixedRenderCadenceState();
        }
        return { ok: profiles.every(profile => profile.ok) && fixedPreserved && vsyncCanWake, profiles, fixedPreserved, vsyncCanWake };
      }
      const fixedFpsCadenceQa = inspectFixedForegroundFpsCadence();
      if (!fixedFpsCadenceQa.ok) failures.push('fixed foreground FPS cadence or VSync wake behavior failed: ' + JSON.stringify(fixedFpsCadenceQa));
      const runtime = typeof window.__mineradioPerfSnapshot === 'function' ? window.__mineradioPerfSnapshot() : null;
      const perf = window.__mineradioPerf && typeof window.__mineradioPerf.snapshot === 'function'
        ? window.__mineradioPerf.snapshot()
        : null;
      if (!runtime || !runtime.viewport) failures.push('runtime viewport snapshot missing');
      if (runtime && runtime.viewport && typeof runtime.viewport.displayHz !== 'number') failures.push('viewport displayHz missing');
      if (runtime && runtime.viewport && !runtime.viewport.adaptiveLoad) failures.push('viewport adaptiveLoad missing');
      if (runtime && runtime.viewport && !(runtime.viewport.adaptiveLoad.avgMs > 0)) failures.push('adaptiveLoad avgMs was not sampled');
      if (!perf || !perf.render) failures.push('perf render snapshot missing');
      if (document.getElementById('cuefield-automix-btn')) failures.push('Cuefield AutoMix transport button must stay removed now that the switch lives in the DIY panel');
      if (window.cuefieldAutoMixEnabled !== false) failures.push('Cuefield AutoMix must default off in a fresh profile');
      if (!window.CuefieldAutoMix || typeof window.CuefieldAutoMix.createCuefieldAutoMix !== 'function') failures.push('Cuefield AutoMix core missing');
      if (!window.CuefieldTimelineExecutor || typeof window.CuefieldTimelineExecutor.buildCuefieldTimelineExecution !== 'function') failures.push('Cuefield timeline executor missing');
      if (typeof toggleCuefieldAutoMix !== 'function' || typeof tickCuefieldAutoMix !== 'function') failures.push('Cuefield renderer integration missing');
      function inspectLyricTextureQualityTiers() {
        if (typeof makeLyricMask !== 'function' || typeof compactLyricLineMaskTexture !== 'function' || typeof makeLyricQualityTexture !== 'function') {
          return { ok: false, reason: 'lyric quality texture builders missing' };
        }
        let mask = null;
        const builtTextures = [];
        try {
          mask = compactLyricLineMaskTexture(makeLyricMask('清晰度验证 High resolution lyric'));
          const rows = [{ tier: 1, width: Number(mask && mask.width) || 0, height: Number(mask && mask.height) || 0 }];
          [2, 3, 4].forEach(tier => {
            const built = makeLyricQualityTexture(mask, tier);
            if (built && built.texture) builtTextures.push(built.texture);
            rows.push({
              tier,
              width: Number(built && built.width) || 0,
              height: Number(built && built.height) || 0,
              bytes: Number(built && built.bytes) || 0,
              markedQuality: !!(built && built.texture && built.texture.userData && built.texture.userData.__mineradioLyricQuality)
            });
          });
          const widths = rows.map(row => row.width);
          const heights = rows.map(row => row.height);
          const monotonic = widths.every((width, index) => index === 0 || width > widths[index - 1]) && heights.every((height, index) => index === 0 || height > heights[index - 1]);
          const boundedActualScale = widths[0] > 0 && widths[1] >= widths[0] * 1.75 && widths[2] >= widths[0] * 2.4 && widths[3] >= widths[0] * 3.0;
          const marked = rows.slice(1).every(row => row.markedQuality && row.bytes > 0);
          return { ok: monotonic && boundedActualScale && marked, rows, monotonic, boundedActualScale, marked };
        } catch (error) {
          return { ok: false, reason: String(error && error.stack || error) };
        } finally {
          builtTextures.forEach(texture => {
            if (typeof lyricQualityDisposeTexture === 'function') lyricQualityDisposeTexture(texture);
            else if (typeof disposeOwnedLyricTexture === 'function') disposeOwnedLyricTexture(texture);
          });
          if (mask && mask.texture && typeof disposeOwnedLyricTexture === 'function') disposeOwnedLyricTexture(mask.texture);
        }
      }
      const lyricTextureQualityQa = inspectLyricTextureQualityTiers();
      if (!lyricTextureQualityQa.ok) failures.push('1x-4x lyric texture quality is not physically increasing: ' + JSON.stringify(lyricTextureQualityQa));
      async function inspectLyricQualityCacheStability() {
        const oldLines = window.lyricsLines;
        const oldTranslations = window.lyricsTranslationLines;
        const oldFx = {
          clarity: fx && fx.lyricTextureClarity,
          display: fx && fx.lyricDisplayMode,
          translation: fx && fx.lyricTranslationMode,
          count: fx && fx.lyricCustomLineCount,
          particles: fx && fx.particleLyrics
        };
        let root = null;
        try {
          invalidateLyricQualityTextures('qa-quality-cache-start', { release: true });
          window.lyricsLines = Array.from({ length: 80 }, (_, index) => ({
            t: index * 2,
            duration: 2,
            text: 'quality cache lyric row ' + index + ' smooth continuous line',
            translation: '清晰度缓存译文 ' + index,
            charCount: 40
          }));
          window.lyricsTranslationLines = window.lyricsLines.map(line => ({ t: line.t, text: line.translation }));
          fx.lyricTextureClarity = 4;
          fx.lyricDisplayMode = 'custom';
          fx.lyricTranslationMode = 'multi';
          fx.lyricCustomLineCount = 10;
          fx.particleLyrics = true;
          if (typeof stageLyricTrackCache !== 'undefined') stageLyricTrackCache = { key: '', entries: null, lineMap: null, start: 0, end: -1 };
          if (typeof lyricPrimaryVirtualPrefixCache !== 'undefined') lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
          const payload = buildStageLyricDisplayPayload(30, { lightweightTrack: true });
          root = buildLyricMesh(payload);
          const data = root && root.userData && root.userData.lyric;
          if (!data || !Array.isArray(data.rowLayers)) return { ok: false, reason: 'quality cache row layers missing' };
          if (typeof initializeStageLyricPersistentTrack === 'function') initializeStageLyricPersistentTrack(root, payload);
          const target = lyricPrimaryVirtualIndex(30);
          data.trackScrollOffset = target;
          data.trackScrollPrimed = true;
          const updateOptions = {
            opacity: 1,
            readability: 1,
            contextIntro: 1,
            shownProgress: 0.5,
            contextDrift: 0,
            targetLineIndex: 30,
            targetVirtualIndex: target,
            rowGlow: 1,
            renderBase: 260,
            ease: 1,
            trackEase: 1
          };
          function step() {
            resetLyricRenderUploadFrameBudget(true);
            updateLyricRowLayers(data, updateOptions);
            finalizeLyricQualitySelectionFrame();
            data.rowLayers.forEach(row => { if (row) row.renderRevealAt = 0; });
          }
          for (let reveal = 0; reveal < data.rowLayers.length * 3 + 12; reveal++) step();
          for (let settle = 0; settle < 110; settle++) {
            step();
            await new Promise(resolve => setTimeout(resolve, 24));
            if (lyricQualityState.queue.length === 0 && lyricQualityState.residents.length > 0 && !lyricQualityState.residents.some(row => row.qualityPendingTexture)) break;
          }
          function residentIds() {
            return lyricQualityState.residents.map(row => (row.lineIndex + '|' + (row.isTranslation ? 't' : 'p') + '|' + (row.qualityTexture && row.qualityTexture.uuid))).sort();
          }
          const firstIds = residentIds();
          const firstRows = lyricQualityState.residents.length;
          const firstBytes = lyricQualityState.bytes;
          const firstQueue = lyricQualityState.queue.length;
          for (let stable = 0; stable < 30; stable++) {
            step();
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          const stableIds = residentIds();
          const anchor = lyricQualityState.residents.find(row => row.qualityTexture && row.isPrimary) || lyricQualityState.residents[0];
          if (!anchor || !anchor.qualityTexture) return { ok: false, reason: 'quality cache never produced a resident texture' };
          const oldTexture = anchor.qualityTexture;
          const baseTexture = anchor.baseLineTexture;
          fx.lyricTextureClarity = 3;
          invalidateLyricQualityTextures('texture-clarity-change');
          // Simulate a seek/input hold outliving the 3.2s fallback window.
          // The old 4x pool can be larger than the normal 3x budget, yet each
          // visible row still has to replace atomically without a 1x flash.
          const expiredFallbackAt = lyricQualityNowMs() - 1;
          lyricQualityState.transitionBudgetUntil = expiredFallbackAt;
          lyricQualityState.residents.forEach(row => { if (row) row.qualityFallbackUntil = expiredFallbackAt; });
          const startedOverNewBudget = firstBytes > lyricQualityPoolBudgetBytes(3);
          const immediateSame = lyricQualityCurrentMap(anchor) === oldTexture && !oldTexture.userData.__mineradioDisposed;
          let sawBase = false;
          for (let handoff = 0; handoff < 130; handoff++) {
            step();
            if (lyricQualityCurrentMap(anchor) === baseTexture) sawBase = true;
            await new Promise(resolve => setTimeout(resolve, 22));
            if (anchor.qualityTier === 3 && lyricQualityState.queue.length === 0 && !lyricQualityState.residents.some(row => row.qualityPendingTexture || row.qualityTier !== 3)) break;
          }
          const maxRows = lyricQualityMaxResidentRows();
          const stable = JSON.stringify(firstIds) === JSON.stringify(stableIds);
          const withinBounds = firstRows > 0 && firstRows <= maxRows && firstBytes <= lyricQualityPoolBudgetBytes(4) && firstQueue === 0;
          const allTierThree = lyricQualityState.residents.length > 0 && !lyricQualityState.residents.some(row => row.qualityTier !== 3 || row.qualityPendingTexture);
          const handoffOk = startedOverNewBudget && immediateSame && !sawBase && anchor.qualityTier === 3 && allTierThree && oldTexture.userData.__mineradioDisposed && lyricQualityCurrentMap(anchor) === anchor.qualityTexture;
          const newTier = anchor.qualityTier;
          const uploadOk = !window.__mineradioLyricUploadBudgetStats || Number(window.__mineradioLyricUploadBudgetStats.maxConsumed) <= 1;
          resetLyricRenderUploadFrameBudget(true);
          updateLyricRowLayers(data, updateOptions);
          const hadDisposeFrameCandidates = lyricQualityState.frameCandidates.some(candidate => candidate && candidate.data === data);
          disposeLyricMesh(root);
          root = null;
          finalizeLyricQualitySelectionFrame();
          await new Promise(resolve => setTimeout(resolve, 240));
          const disposedRows = Array.isArray(data.rowLayers) ? data.rowLayers : [];
          const noDisposeResurrection = data.__mineradioLyricQualityDisposed === true &&
            !lyricQualityState.frameCandidates.some(candidate => candidate && candidate.data === data) &&
            !lyricQualityState.frameCommits.some(candidate => candidate && candidate.data === data) &&
            !lyricQualityState.queue.some(job => job && job.data === data) &&
            !lyricQualityState.residents.some(row => disposedRows.indexOf(row) >= 0) &&
            !disposedRows.some(row => row && (row.qualityTexture || row.qualityPendingTexture || row.qualityQueuedKey));
          return { ok: stable && withinBounds && handoffOk && uploadOk && hadDisposeFrameCandidates && noDisposeResurrection, stable, withinBounds, handoffOk, uploadOk, startedOverNewBudget, allTierThree, hadDisposeFrameCandidates, noDisposeResurrection, firstRows, maxRows, firstBytes, firstQueue, immediateSame, sawBase, newTier };
        } catch (error) {
          return { ok: false, reason: String(error && error.stack || error) };
        } finally {
          if (root && typeof disposeLyricMesh === 'function') disposeLyricMesh(root);
          invalidateLyricQualityTextures('qa-quality-cache-finish', { release: true });
          window.lyricsLines = oldLines;
          window.lyricsTranslationLines = oldTranslations;
          if (fx) {
            fx.lyricTextureClarity = oldFx.clarity;
            fx.lyricDisplayMode = oldFx.display;
            fx.lyricTranslationMode = oldFx.translation;
            fx.lyricCustomLineCount = oldFx.count;
            fx.particleLyrics = oldFx.particles;
          }
          if (typeof stageLyricTrackCache !== 'undefined') stageLyricTrackCache = { key: '', entries: null, lineMap: null, start: 0, end: -1 };
          if (typeof lyricPrimaryVirtualPrefixCache !== 'undefined') lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
        }
      }
      const lyricQualityCacheQa = await inspectLyricQualityCacheStability();
      if (!lyricQualityCacheQa.ok) failures.push('visible-row lyric quality cache was not stable, bounded, or no-flash: ' + JSON.stringify(lyricQualityCacheQa));
      function inspectLyricMode(displayMode, translationMode, sampleIndex) {
        if (typeof buildStageLyricDisplayPayload !== 'function' || typeof buildLyricMesh !== 'function') {
          failures.push('stage lyric builders missing');
          return null;
        }
        const oldLines = window.lyricsLines;
        const oldTranslations = window.lyricsTranslationLines;
        const oldFx = {
          particleLyrics: fx && fx.particleLyrics,
          lyricDisplayMode: fx && fx.lyricDisplayMode,
          lyricTranslationMode: fx && fx.lyricTranslationMode
        };
        try {
          sampleIndex = Math.max(1, Math.round(Number(sampleIndex) || 1));
          const lineCount = displayMode === 'single'
            ? Math.max(32, sampleIndex + 4)
            : Math.max(4, sampleIndex + 4);
          window.lyricsLines = Array.from({ length: lineCount }, (_, idx) => {
            const text = idx === sampleIndex
              ? 'current line should glow'
              : (idx === sampleIndex + 1 ? 'next line follows softly' : 'context lyric line ' + idx);
            const translation = idx === sampleIndex
              ? 'current translation stays visible'
              : (idx === sampleIndex + 1 ? 'next translation stays visible' : 'translation line ' + idx);
            return { t: idx * 2, duration: 2, text, translation, charCount: text.length };
          });
          /*
          window.lyricsLines = [
            { t: 0, duration: 2, text: 'before the night opens', translation: '夜色打开以前', charCount: 23 },
            { t: 2, duration: 2, text: 'current line should glow', translation: '当前行应该发光', charCount: 24 },
            { t: 4, duration: 2, text: 'next line follows softly', translation: '下一行轻轻跟随', charCount: 24 },
            { t: 6, duration: 2, text: 'third line keeps moving', translation: '第三行继续移动', charCount: 23 }
          ];
          */
          window.lyricsTranslationLines = window.lyricsLines.map(line => ({ t: line.t, text: line.translation }));
          fx.particleLyrics = true;
          fx.lyricDisplayMode = displayMode;
          fx.lyricTranslationMode = translationMode;
          if (typeof stageLyricTrackCache !== 'undefined') stageLyricTrackCache = { key: '', entries: null, lineMap: null, start: 0, end: -1 };
          if (typeof lyricPrimaryVirtualPrefixCache !== 'undefined') lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
          const payload = buildStageLyricDisplayPayload(sampleIndex);
          const payloadTranslations = payload && payload.entries
            ? payload.entries.filter(entry => entry && entry.translationLine).length
            : 0;
          const mesh = payload ? buildLyricMesh(payload) : null;
          const rows = mesh && mesh.userData && mesh.userData.lyric && mesh.userData.lyric.rowLayers
            ? mesh.userData.lyric.rowLayers
            : [];
          const data = mesh && mesh.userData && mesh.userData.lyric ? mesh.userData.lyric : null;
          const qaTargetLine = data && data.usesTrack
            ? sampleIndex
            : (data && Number.isFinite(Number(data.trackTargetLineIndex)) ? Number(data.trackTargetLineIndex) : 1);
          const qaTargetVirtual = data && data.usesTrack && typeof lyricPrimaryVirtualIndex === 'function'
            ? lyricPrimaryVirtualIndex(qaTargetLine)
            : (data && Number.isFinite(Number(data.trackTargetVirtualIndex)) ? Number(data.trackTargetVirtualIndex) : 0);
          if (data && typeof updateLyricRowLayers === 'function') {
            data.trackScrollOffset = qaTargetVirtual;
            data.trackScrollPrimed = true;
            const qaLyricUpdateOptions = {
              opacity: 1,
              readability: 1,
              contextIntro: 1,
              shownProgress: 0.5,
              contextDrift: 0,
              targetLineIndex: qaTargetLine,
              targetVirtualIndex: qaTargetVirtual,
              rowGlow: 1,
              renderBase: 260,
              ease: 1,
              trackEase: 1
            };
            const qaRevealPasses = Math.max(2, rows.length + 2);
            for (let qaRevealPass = 0; qaRevealPass < qaRevealPasses; qaRevealPass++) {
              if (typeof resetLyricRenderUploadFrameBudget === 'function') resetLyricRenderUploadFrameBudget();
              updateLyricRowLayers(data, qaLyricUpdateOptions);
            }
            rows.forEach(row => { if (row) row.renderRevealAt = 0; });
            for (let qaVisiblePass = 0; qaVisiblePass < qaRevealPasses; qaVisiblePass++) {
              if (typeof resetLyricRenderUploadFrameBudget === 'function') resetLyricRenderUploadFrameBudget();
              updateLyricRowLayers(data, qaLyricUpdateOptions);
            }
          }
          const translationRows = rows.filter(row => row && row.isTranslation);
          const primaryRows = rows.filter(row => row && row.isPrimary);
          const runawayRows = translationRows.filter(row => row && row.mesh && Math.abs(row.mesh.position.y) > 3.2);
          function rowOpacity(row) {
            const mat = row && row.mat;
            if (mat && mat.uniforms && mat.uniforms.uOpacity) return Number(mat.uniforms.uOpacity.value) || 0;
            return Number(mat && mat.opacity) || 0;
          }
          const currentTranslationRows = translationRows.filter(row => row && Number(row.parentIndex) === qaTargetLine);
          const nextTranslationRows = translationRows.filter(row => row && Number(row.parentIndex) === qaTargetLine + 1);
          const currentTranslationOpacity = currentTranslationRows.reduce((max, row) => Math.max(max, rowOpacity(row)), 0);
          const nextTranslationOpacity = nextTranslationRows.reduce((max, row) => Math.max(max, rowOpacity(row)), 0);
          const currentTranslationYOffset = currentTranslationRows.reduce((max, row) => {
            const y = row && row.mesh ? Number(row.mesh.position.y) : 0;
            const baseY = row && Number.isFinite(Number(row.baseY)) ? Number(row.baseY) : y;
            return Math.max(max, Math.abs(y - baseY));
          }, 0);
          if (mesh && typeof disposeLyricMesh === 'function') disposeLyricMesh(mesh);
          return {
            payloadTranslations,
            meshTranslations: translationRows.length,
            meshPrimaries: primaryRows.length,
            runawayTranslations: runawayRows.length,
            currentTranslationOpacity,
            nextTranslationOpacity,
            currentTranslationYOffset
          };
        } finally {
          window.lyricsLines = oldLines;
          window.lyricsTranslationLines = oldTranslations;
          if (fx) {
            fx.particleLyrics = oldFx.particleLyrics;
            fx.lyricDisplayMode = oldFx.lyricDisplayMode;
            fx.lyricTranslationMode = oldFx.lyricTranslationMode;
          }
          if (typeof stageLyricTrackCache !== 'undefined') stageLyricTrackCache = { key: '', entries: null, lineMap: null, start: 0, end: -1 };
          if (typeof lyricPrimaryVirtualPrefixCache !== 'undefined') lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
        }
      }
      const lyricQa = {
        singleCurrent: inspectLyricMode('single', 'current', 24),
        singleMulti: inspectLyricMode('single', 'multi', 24),
        dualDual: inspectLyricMode('dual', 'dual', 1),
        dualMulti: inspectLyricMode('dual', 'multi', 1)
      };
      if (!lyricQa.singleCurrent || lyricQa.singleCurrent.meshTranslations < 1 || lyricQa.singleCurrent.runawayTranslations) failures.push('single/current translation row invalid');
      if (!lyricQa.singleMulti || lyricQa.singleMulti.meshTranslations < 1 || lyricQa.singleMulti.runawayTranslations) failures.push('single/multi translation row invalid');
      if (!lyricQa.dualDual || lyricQa.dualDual.meshPrimaries < 2 || lyricQa.dualDual.meshTranslations < 2 || lyricQa.dualDual.runawayTranslations) failures.push('dual/dual translation rows invalid');
      if (!lyricQa.dualMulti || lyricQa.dualMulti.meshPrimaries < 2 || lyricQa.dualMulti.meshTranslations < 2 || lyricQa.dualMulti.runawayTranslations) failures.push('dual/multi translation rows invalid');
      if (!lyricQa.singleCurrent || lyricQa.singleCurrent.currentTranslationOpacity < 0.12) failures.push('single/current translation row not visible after binding update');
      if (!lyricQa.singleMulti || lyricQa.singleMulti.currentTranslationOpacity < 0.12) failures.push('single/multi translation row not visible after binding update');
      if (!lyricQa.singleCurrent || lyricQa.singleCurrent.currentTranslationYOffset > 0.015) failures.push('single/current translation row still slides from its base position');
      if (!lyricQa.singleMulti || lyricQa.singleMulti.currentTranslationYOffset > 0.015) failures.push('single/multi translation row still slides from its base position');
      if (!lyricQa.dualDual || lyricQa.dualDual.nextTranslationOpacity < 0.10) failures.push('dual/dual second translation row not visible after binding update');
      if (!lyricQa.dualMulti || lyricQa.dualMulti.nextTranslationOpacity < 0.10) failures.push('dual/multi second translation row not visible after binding update');
      async function inspectPersistentLyricContinuity() {
        const oldLines = window.lyricsLines;
        const oldTranslations = window.lyricsTranslationLines;
        const oldAudio = audio;
        const oldPlaying = playing;
        const oldFx = {
          particleLyrics: fx && fx.particleLyrics,
          lyricDisplayMode: fx && fx.lyricDisplayMode,
          lyricTranslationMode: fx && fx.lyricTranslationMode,
          lyricCustomLineCount: fx && fx.lyricCustomLineCount,
          lyricGlow: fx && fx.lyricGlow,
          lyricGlowBeat: fx && fx.lyricGlowBeat,
          lyricGlowStrength: fx && fx.lyricGlowStrength,
          lyricBackgroundAdapt: fx && fx.lyricBackgroundAdapt
        };
        const oldStageGlow = {
          beatGlow: stageLyrics && stageLyrics.beatGlow,
          highBloom: stageLyrics && stageLyrics.highBloom
        };
        try {
          if (typeof clearStageLyrics === 'function') clearStageLyrics();
          const qaLongGlowText = 'Yeah, you should be with him, I let you go from time (Uh, yeah)';
          const qaShortGlowText = 'You should stay with him';
          window.lyricsLines = Array.from({ length: 80 }, (_, idx) => {
            const text = idx === 43
              ? qaLongGlowText
              : (idx === 44 ? qaShortGlowText : 'persistent primary lyric ' + idx);
            return {
              t: idx * 1.5,
              duration: 1.5,
              text: text,
              translation: 'persistent translation ' + idx,
              charCount: text.length
            };
          });
          window.lyricsTranslationLines = window.lyricsLines.map(line => ({ t: line.t, text: line.translation }));
          fx.particleLyrics = true;
          fx.lyricDisplayMode = 'custom';
          fx.lyricCustomLineCount = 10;
          fx.lyricTranslationMode = 'multi';
          fx.lyricGlow = true;
          fx.lyricGlowBeat = false;
          fx.lyricGlowStrength = 0.85;
          fx.lyricBackgroundAdapt = 0;
          stageLyrics.beatGlow = 0;
          stageLyrics.highBloom = 0;
          audio = { src: 'qa://persistent-lyrics', currentTime: 0.2, duration: 120, ended: false, paused: false };
          playing = true;
          if (typeof stageLyricTrackCache !== 'undefined') stageLyricTrackCache = { key: '', entries: null, lineMap: null, start: 0, end: -1 };
          if (typeof lyricPrimaryVirtualPrefixCache !== 'undefined') lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
          if (typeof createLyricsParticles === 'function') createLyricsParticles();
          const initialPayload = buildStageLyricDisplayPayload(0, { lightweightTrack: true });
          const root = buildLyricMesh(initialPayload);
          stageLyrics.group.add(root);
          stageLyrics.current = root;
          stageLyrics.currentIdx = 0;
          stageLyrics.currentPayload = initialPayload;
          stageLyrics.currentDisplayKey = initialPayload.key;
          initializeStageLyricPersistentTrack(root, initialPayload);
          const rootId = root.id;
          const targets = [0, 12, 43, 44, 79];
          let maxResidentPrimary = 0;
          let maxResidentRows = 0;
          let maxSameTrackOutgoing = 0;
          let maxUploadConsumed = 0;
          let maxIndexLag = 0;
          let baselineGlyphWorldH = null;
          let maxGlyphWorldDrift = 0;
          let maxLogicalRowWidth = 0;
          let minActiveScale = Infinity;
          let minimumForwardRunway = Infinity;
          let adjacentTargetsReady = 0;
          let wholeSongResident = false;
          const glowRasterSamples = [];
          function inspectActiveGlowRaster(row, target) {
            const lineMask = row && row.lineMask;
            const glowMap = row && row.glowMat && (
              row.glowMat.map ||
              (row.glowMat.uniforms && row.glowMat.uniforms.uMap && row.glowMat.uniforms.uMap.value)
            );
            const glowImage = glowMap && glowMap.image;
            const glowMeta = glowMap && glowMap.userData || {};
            const textGeometry = row && row.mesh && row.mesh.geometry && row.mesh.geometry.parameters || {};
            const glowGeometry = row && row.glow && row.glow.geometry && row.glow.geometry.parameters || {};
            if (!lineMask || !row.mesh || !row.glow || !glowImage) {
              return { ok: false, target: target, reason: 'active glow raster missing' };
            }
            const textFrameW = Math.max(0.001, Number(textGeometry.width) || Number(row.lineWorldW) || 0) * Math.max(0.001, Number(row.mesh.scale.x) || 0);
            const textFrameH = Math.max(0.001, Number(textGeometry.height) || Number(row.lineWorldH) || 0) * Math.max(0.001, Number(row.mesh.scale.y) || 0);
            const lineRasterW = Math.max(1, Number(lineMask.width) || 1);
            const lineRasterH = Math.max(1, Number(lineMask.height) || 1);
            const textInkW = textFrameW * Math.max(1, Number(lineMask.activeTextWidth) || Number(lineMask.textWidth) || lineRasterW) / lineRasterW;
            const glyphWorldH = textFrameH * Math.max(1, Number(lineMask.fontSize) || 1) / lineRasterH;
            const glowFrameW = Math.max(0.001, Number(glowGeometry.width) || 0) * Math.max(0.001, Number(row.glow.scale.x) || 0);
            const glowFrameH = Math.max(0.001, Number(glowGeometry.height) || 0) * Math.max(0.001, Number(row.glow.scale.y) || 0);
            const glowRasterW = Math.max(1, Number(glowMeta.width) || Number(glowImage.width) || 1);
            const glowRasterH = Math.max(1, Number(glowMeta.height) || Number(glowImage.height) || 1);
            const glowTextRasterW = Math.max(1, Number(glowMeta.textWidth) || glowRasterW);
            const glowInkW = glowFrameW * glowTextRasterW / glowRasterW;
            const glowFontSize = Math.max(0, Number(glowMeta.fontSize) || 0);
            const glowRasterScale = Math.max(0, Number(glowMeta.rasterScale) || 0);
            const lineRasterScale = Math.max(0.0001, Number(lineMask.rasterScale) || 1);
            const lineFontSize = Math.max(0.0001, Number(lineMask.fontSize) || 1);
            const widthAlignment = glowInkW / Math.max(0.001, textInkW);
            const rasterFontGain = glowFontSize / lineFontSize;
            const rasterScaleGain = glowRasterScale / lineRasterScale;
            const textureFrameToGlyph = glowRasterH / Math.max(1, glowFontSize);
            const worldFrameToGlyph = glowFrameH / Math.max(0.001, glyphWorldH);
            const padToGlyph = Math.max(0, glowFrameW - glowInkW) / Math.max(0.002, glyphWorldH * 2);
            const centerError = Math.hypot(
              (Number(row.glow.position.x) || 0) - (Number(row.mesh.position.x) || 0),
              (Number(row.glow.position.y) || 0) - (Number(row.mesh.position.y) || 0)
            ) / Math.max(0.001, glyphWorldH);
            const scaleError = Math.abs((Number(row.glow.scale.x) || 0) - (Number(row.mesh.scale.x) || 0));
            return {
              ok: glowFontSize > 0 && glowRasterScale > 0 && widthAlignment >= 0.90 && widthAlignment <= 1.10 && centerError <= 0.02 && scaleError <= 0.0001,
              target: target,
              text: row.text || '',
              logicalWidth: Number(lineMask.logicalWidth) || lineRasterW,
              lineRasterW: lineRasterW,
              glowRasterW: glowRasterW,
              lineFontSize: lineFontSize,
              glowFontSize: glowFontSize,
              lineRasterScale: lineRasterScale,
              glowRasterScale: glowRasterScale,
              rasterFontGain: rasterFontGain,
              rasterScaleGain: rasterScaleGain,
              widthAlignment: widthAlignment,
              textureFrameToGlyph: textureFrameToGlyph,
              worldFrameToGlyph: worldFrameToGlyph,
              padToGlyph: padToGlyph,
              centerError: centerError,
              scaleError: scaleError
            };
          }
          function relativeGlowMetricDrift(a, b) {
            a = Number(a) || 0;
            b = Number(b) || 0;
            return Math.abs(a - b) / Math.max(0.001, (Math.abs(a) + Math.abs(b)) * 0.5);
          }
          for (const target of targets) {
            audio.currentTime = Math.min(119.2, target * 1.5 + 0.2);
            const beforeTarget = Number(root.userData.lyric.trackTargetLineIndex);
            updateLyricMeshProgress(root, 0.42);
            const beforeProgress = Number(root.userData.lyric.textMat.uniforms.uProgress.value) || 0;
            const payload = buildStageLyricDisplayPayload(target);
            const accepted = setLyricTrackTarget(root, payload);
            if (!accepted) return { ok: false, reason: 'target rejected', target };
            const pendingImmediately = !!root.userData.lyric.trackPendingPayload;
            if (pendingImmediately) {
              updateLyricMeshProgress(root, 0.73);
              const heldProgress = Number(root.userData.lyric.textMat.uniforms.uProgress.value) || 0;
              if (Number(root.userData.lyric.trackTargetLineIndex) !== beforeTarget) return { ok: false, reason: 'pending target committed before upload', target };
              if (Math.abs(heldProgress - beforeProgress) > 0.0001) return { ok: false, reason: 'pending target changed old row progress', target, beforeProgress, heldProgress };
            }
            stageLyrics.currentIdx = target;
            stageLyrics.currentPayload = payload;
            stageLyrics.currentDisplayKey = payload.key;
            const deadline = performance.now() + 7000;
            let activeReady = false;
            while (performance.now() < deadline) {
              updateStageLyrics3D(1 / 60);
              await new Promise(resolve => requestAnimationFrame(resolve));
              const data = root.userData && root.userData.lyric;
              const active = data && data.rowLayers && data.rowLayers.find(row => row && row.isPrimary && Number(row.lineIndex) === target);
              const targetVirtual = lyricPrimaryVirtualIndex(target);
              const trackSettled = !!(data && Math.abs((Number(data.trackScrollOffset) || 0) - targetVirtual) <= 0.045);
              const activeCentered = !!(active && active.mesh && Math.abs(Number(active.mesh.position.y) || 0) <= Math.max(0.012, (Number(data && data.lineWorldStep) || 0.38) * 0.12));
              activeReady = !!(active && active.renderLineUploaded && stageLyricPersistentTargetRowsReady(root, target));
              const uploadStats = window.__mineradioLyricUploadBudgetStats || {};
              maxUploadConsumed = Math.max(maxUploadConsumed, Number(uploadStats.consumed) || 0, Number(uploadStats.maxConsumed) || 0);
              if (activeReady && !data.trackPendingPayload && trackSettled && activeCentered) break;
            }
            const data = root.userData && root.userData.lyric;
            if (!activeReady || !data) return { ok: false, reason: 'target resident timeout', target };
            const commitOffsets = lyricDisplayOffsetsForMode(data.displayMode);
            for (const offset of commitOffsets) {
              const lineIndex = target + Math.round(Number(offset) || 0);
              if (lineIndex < 0 || lineIndex >= window.lyricsLines.length || !lyricLineDisplayTextAt(lineIndex)) continue;
              const expectedRows = data.rowLayers.filter(row => {
                const rowLineIndex = row && row.isTranslation ? Number(row.parentIndex) : Number(row && row.lineIndex);
                return row && row.mesh && rowLineIndex === lineIndex;
              });
              if (!expectedRows.length) return { ok: false, reason: 'commit window row absent', target, lineIndex };
              for (const expectedRow of expectedRows) {
                const rowOpacity = expectedRow.mat && expectedRow.mat.uniforms && expectedRow.mat.uniforms.uOpacity
                  ? Number(expectedRow.mat.uniforms.uOpacity.value) || 0
                  : Number(expectedRow.mat && expectedRow.mat.opacity) || 0;
                if (!expectedRow.mesh.visible || rowOpacity <= 0.001) return { ok: false, reason: 'commit window row not visible', target, lineIndex, translation: !!expectedRow.isTranslation, rowOpacity };
              }
            }
            for (let settle = 0; settle < 12; settle++) {
              updateStageLyrics3D(1 / 60);
              await new Promise(resolve => requestAnimationFrame(resolve));
            }
            const primaryRows = data.rowLayers.filter(row => row && row.isPrimary);
            const translationRows = data.rowLayers.filter(row => row && row.isTranslation);
            const activeRow = primaryRows.find(row => Number(row.lineIndex) === target);
            if (!activeRow || !activeRow.lineMask || !activeRow.mesh) return { ok: false, reason: 'active row missing after settle', target };
            const glyphWorldH = Number(activeRow.lineWorldH) * (Number(activeRow.lineMask.fontSize) || 0) / Math.max(1, Number(activeRow.lineMask.height) || 1);
            maxLogicalRowWidth = Math.max(maxLogicalRowWidth, Number(activeRow.lineMask.logicalWidth) || Number(activeRow.lineMask.width) || 0);
            if (baselineGlyphWorldH == null) baselineGlyphWorldH = glyphWorldH;
            else maxGlyphWorldDrift = Math.max(maxGlyphWorldDrift, Math.abs(glyphWorldH - baselineGlyphWorldH) / Math.max(0.001, baselineGlyphWorldH));
            minActiveScale = Math.min(minActiveScale, Number(activeRow.mesh.scale.x) || 0);
            if (Math.abs(Number(data.persistentMaskLayout && data.persistentMaskLayout.fontSize) - 128) > 0.01) {
              return { ok: false, reason: 'persistent logical font inherited compact raster size', target, layout: data.persistentMaskLayout };
            }
            const visibleEffectsDeadline = performance.now() + 4000;
            while (performance.now() < visibleEffectsDeadline && !stageLyricPersistentTargetEffectsReady(root, target)) {
              updateStageLyrics3D(1 / 60);
              await new Promise(resolve => requestAnimationFrame(resolve));
            }
            if (!stageLyricPersistentTargetEffectsReady(root, target)) return { ok: false, reason: 'visible effects timeout', target };
            if (target === 43 || target === 44) {
              const effectsActiveRow = data.rowLayers.find(row => row && row.isPrimary && Number(row.lineIndex) === target);
              const glowSample = inspectActiveGlowRaster(effectsActiveRow, target);
              if (!glowSample.ok) return { ok: false, reason: 'active glow raster geometry invalid', glowSample: glowSample };
              glowRasterSamples.push(glowSample);
            }
            const visibleTranslations = translationRows.filter(row => lyricLineAllowedForDisplayMode(Number(row.parentIndex), target, data.displayMode));
            if (visibleTranslations.some(row => !row.glow || !row.glowMat)) return { ok: false, reason: 'visible translation row missing glow', target };
            if (target < window.lyricsLines.length - 12) {
              const runwayDeadline = performance.now() + 1800;
              const nextTarget = target + 1;
              while (performance.now() < runwayDeadline && !stageLyricPersistentTargetRowsReady(root, nextTarget)) {
                updateStageLyrics3D(1 / 60);
                await new Promise(resolve => requestAnimationFrame(resolve));
              }
              if (stageLyricPersistentTargetRowsReady(root, nextTarget)) adjacentTargetsReady += 1;
              updateStageLyricPersistentResidentBounds(data);
              minimumForwardRunway = Math.min(minimumForwardRunway, Number(data.trackResidentEnd) - target);
            }
            const rowKeys = data.rowLayers.map(row => stageLyricResidentRowKey(row)).filter(Boolean);
            const uniqueKeys = new Set(rowKeys);
            if (uniqueKeys.size !== rowKeys.length) return { ok: false, reason: 'duplicate resident row', target, rowKeys: rowKeys.length, unique: uniqueKeys.size };
            maxResidentPrimary = Math.max(maxResidentPrimary, primaryRows.length);
            maxResidentRows = Math.max(maxResidentRows, data.rowLayers.length);
            maxIndexLag = Math.max(maxIndexLag, Math.abs(Number(data.trackTargetLineIndex) - target));
            const sameTrackOutgoing = (stageLyrics.outgoing || []).filter(mesh => {
              const outgoingData = mesh && mesh.userData && mesh.userData.lyric;
              return outgoingData && outgoingData.trackKey === data.trackKey;
            }).length;
            maxSameTrackOutgoing = Math.max(maxSameTrackOutgoing, sameTrackOutgoing);
            if (stageLyrics.current !== root || root.id !== rootId) return { ok: false, reason: 'persistent root replaced', target, rootId, currentId: stageLyrics.current && stageLyrics.current.id };
          }
          const wholeTrackDeadline = performance.now() + 7000;
          while (performance.now() < wholeTrackDeadline) {
            updateStageLyrics3D(1 / 60);
            await new Promise(resolve => requestAnimationFrame(resolve));
            const data = root.userData && root.userData.lyric;
            wholeSongResident = !!(
              data && data.trackTextRunwayComplete &&
              Number(data.trackResidentPrimaryCount) === window.lyricsLines.length
            );
            const uploadStats = window.__mineradioLyricUploadBudgetStats || {};
            maxUploadConsumed = Math.max(maxUploadConsumed, Number(uploadStats.consumed) || 0, Number(uploadStats.maxConsumed) || 0);
            if (wholeSongResident) break;
          }
          const finalResidentData = root.userData && root.userData.lyric;
          maxResidentPrimary = Math.max(maxResidentPrimary, Number(finalResidentData && finalResidentData.trackResidentPrimaryCount) || 0);
          maxResidentRows = Math.max(maxResidentRows, Number(finalResidentData && finalResidentData.rowLayers && finalResidentData.rowLayers.length) || 0);
          const trackKeyBeforeRefresh = root.userData.lyric.trackKey;
          window.lyricsLines[40].text += ' refreshed-middle';
          invalidateStageLyricPayloadForNewLyrics('qa-middle-refresh');
          const refreshedPayload = buildStageLyricDisplayPayload(40, { lightweightTrack: true });
          if (!refreshedPayload || refreshedPayload.trackKey === trackKeyBeforeRefresh) {
            return { ok: false, reason: 'middle lyric refresh reused old track identity' };
          }
          const longGlowRaster = glowRasterSamples.find(sample => sample && sample.target === 43);
          const shortGlowRaster = glowRasterSamples.find(sample => sample && sample.target === 44);
          const glowRasterPairOk = !!(
            longGlowRaster && shortGlowRaster &&
            longGlowRaster.rasterFontGain >= 1.15 &&
            longGlowRaster.rasterScaleGain >= 1.15 &&
            relativeGlowMetricDrift(longGlowRaster.textureFrameToGlyph, shortGlowRaster.textureFrameToGlyph) <= 0.15 &&
            relativeGlowMetricDrift(longGlowRaster.worldFrameToGlyph, shortGlowRaster.worldFrameToGlyph) <= 0.18 &&
            relativeGlowMetricDrift(longGlowRaster.padToGlyph, shortGlowRaster.padToGlyph) <= 0.22
          );
          return {
            // Long active/translation rows now fit the real left/right screen
            // corridor. Continuity QA must allow that intentional shrink while
            // still rejecting unreadable collapse below half scale.
            ok: maxSameTrackOutgoing === 0 && maxUploadConsumed <= 1 && maxIndexLag === 0 && wholeSongResident && maxResidentPrimary === window.lyricsLines.length && maxLogicalRowWidth > 2048 && maxGlyphWorldDrift <= 0.035 && minActiveScale >= 0.50 && minimumForwardRunway >= 20 && adjacentTargetsReady >= 3 && glowRasterPairOk,
            rootId,
            maxSameTrackOutgoing,
            maxUploadConsumed,
            maxIndexLag,
            maxResidentPrimary,
            maxResidentRows,
            baselineGlyphWorldH,
            maxGlyphWorldDrift,
            maxLogicalRowWidth,
            minActiveScale,
            minimumForwardRunway,
            adjacentTargetsReady,
            wholeSongResident,
            glowRasterPairOk,
            longGlowRaster,
            shortGlowRaster
          };
        } catch (error) {
          return { ok: false, error: String(error && error.stack || error) };
        } finally {
          if (typeof clearStageLyrics === 'function') clearStageLyrics();
          audio = oldAudio;
          playing = oldPlaying;
          window.lyricsLines = oldLines;
          window.lyricsTranslationLines = oldTranslations;
          if (fx) {
            fx.particleLyrics = oldFx.particleLyrics;
            fx.lyricDisplayMode = oldFx.lyricDisplayMode;
            fx.lyricTranslationMode = oldFx.lyricTranslationMode;
            fx.lyricCustomLineCount = oldFx.lyricCustomLineCount;
            fx.lyricGlow = oldFx.lyricGlow;
            fx.lyricGlowBeat = oldFx.lyricGlowBeat;
            fx.lyricGlowStrength = oldFx.lyricGlowStrength;
            fx.lyricBackgroundAdapt = oldFx.lyricBackgroundAdapt;
          }
          if (stageLyrics) {
            stageLyrics.beatGlow = oldStageGlow.beatGlow;
            stageLyrics.highBloom = oldStageGlow.highBloom;
          }
          if (typeof stageLyricTrackCache !== 'undefined') stageLyricTrackCache = { key: '', entries: null, lineMap: null, start: 0, end: -1 };
          if (typeof lyricPrimaryVirtualPrefixCache !== 'undefined') lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
        }
      }
      async function inspectProgressDragLyricContinuity() {
        const oldLines = window.lyricsLines;
        const oldTranslations = window.lyricsTranslationLines;
        const oldAudio = audio;
        const oldPlaying = playing;
        const oldUniformTime = uniforms && uniforms.uTime ? Number(uniforms.uTime.value) || 0 : null;
        const oldDragState = typeof progressDragState !== 'undefined' ? Object.assign({}, progressDragState) : null;
        const oldFx = {
          particleLyrics: fx && fx.particleLyrics,
          lyricDisplayMode: fx && fx.lyricDisplayMode,
          lyricTranslationMode: fx && fx.lyricTranslationMode,
          lyricCustomLineCount: fx && fx.lyricCustomLineCount,
          lyricVerticalFloat: fx && fx.lyricVerticalFloat,
          lyricMotionStyle: fx && fx.lyricMotionStyle
        };
        try {
          if (typeof clearStageLyrics === 'function') clearStageLyrics();
          window.lyricsLines = Array.from({ length: 120 }, (_, idx) => ({
            t: idx * 1.5,
            duration: 1.5,
            text: 'drag primary lyric ' + idx,
            translation: 'drag translation ' + idx,
            charCount: 22
          }));
          window.lyricsTranslationLines = window.lyricsLines.map(line => ({ t: line.t, text: line.translation }));
          fx.particleLyrics = true;
          fx.lyricDisplayMode = 'custom';
          fx.lyricCustomLineCount = 10;
          fx.lyricTranslationMode = 'multi';
          fx.lyricVerticalFloat = false;
          fx.lyricMotionStyle = 'smooth';
          const mediaState = { time: 0.2, duration: 180, seeking: false, readyState: 4, paused: true };
          const dragMedia = new EventTarget();
          dragMedia.src = 'qa://progress-drag-lyrics';
          dragMedia.currentSrc = dragMedia.src;
          dragMedia.ended = false;
          Object.defineProperties(dragMedia, {
            currentTime: {
              configurable: true,
              get: () => mediaState.time,
              set: value => {
                const target = Math.max(0, Math.min(mediaState.duration, Number(value) || 0));
                mediaState.seeking = true;
                mediaState.readyState = 1;
                setTimeout(() => {
                  mediaState.time = target;
                  mediaState.seeking = false;
                  mediaState.readyState = 4;
                  dragMedia.dispatchEvent(new Event('seeked'));
                  dragMedia.dispatchEvent(new Event('timeupdate'));
                  dragMedia.dispatchEvent(new Event('canplay'));
                }, 120);
              }
            },
            duration: { configurable: true, get: () => mediaState.duration },
            seeking: { configurable: true, get: () => mediaState.seeking },
            readyState: { configurable: true, get: () => mediaState.readyState },
            paused: { configurable: true, get: () => mediaState.paused }
          });
          dragMedia.pause = () => { mediaState.paused = true; dragMedia.dispatchEvent(new Event('pause')); };
          dragMedia.play = () => { mediaState.paused = false; dragMedia.dispatchEvent(new Event('playing')); return Promise.resolve(); };
          audio = dragMedia;
          playing = false;
          if (typeof stageLyricTrackCache !== 'undefined') stageLyricTrackCache = { key: '', entries: null, lineMap: null, start: 0, end: -1 };
          if (typeof lyricPrimaryVirtualPrefixCache !== 'undefined') lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
          if (typeof createLyricsParticles === 'function') createLyricsParticles();
          const initialPayload = buildStageLyricDisplayPayload(0, { lightweightTrack: true });
          const root = buildLyricMesh(initialPayload);
          stageLyrics.group.add(root);
          stageLyrics.current = root;
          stageLyrics.currentIdx = 0;
          stageLyrics.currentPayload = initialPayload;
          stageLyrics.currentDisplayKey = initialPayload.key;
          initializeStageLyricPersistentTrack(root, initialPayload);
          const rootId = root.id;
          const bar = document.getElementById('progress-bar');
          if (!bar) return { ok: false, reason: 'progress bar missing' };
          const rect = bar.getBoundingClientRect();
          if (!rect.width) return { ok: false, reason: 'progress bar has no width' };
          const pointerId = 77;
          const dispatchPointer = (type, ratio) => {
            bar.dispatchEvent(new PointerEvent(type, {
              bubbles: true,
              pointerId,
              pointerType: 'mouse',
              button: 0,
              buttons: type === 'pointerup' ? 0 : 1,
              clientX: rect.left + rect.width * ratio,
              clientY: rect.top + rect.height * 0.5
            }));
          };
          const finalTarget = 72;
          const finalRatio = (finalTarget * 1.5 + 0.2) / mediaState.duration;
          let maxResidentPrimaryDuringDrag = 0;
          let maxResidentRowsDuringDrag = 0;
          const sampleResident = () => {
            const residentData = root.userData && root.userData.lyric;
            maxResidentPrimaryDuringDrag = Math.max(maxResidentPrimaryDuringDrag, Number(residentData && residentData.trackResidentPrimaryCount) || 0);
            maxResidentRowsDuringDrag = Math.max(maxResidentRowsDuringDrag, Number(residentData && residentData.rowLayers && residentData.rowLayers.length) || 0);
          };
          const median = values => {
            if (!values.length) return null;
            const sorted = values.slice().sort((a, b) => a - b);
            const middle = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
          };
          const seenPrimaryRows = new Set();
          let previousVisualOffsetsByKey = new Map();
          let previousContinuousSample = null;
          let continuousSamples = 0;
          let movingFrames = 0;
          let snapFrames = 0;
          let reverseFrames = 0;
          let overshootFrames = 0;
          let maxTrackFollowRatio = 0;
          let maxVisualFollowRatio = 0;
          let maxVisualStep = 0;
          let maxTrackRowsPerFrame = 0;
          let maxVisualRowsPerFrame = 0;
          let maxJoinError = 0;
          const presentationLinesVisited = new Set();
          let previousPresentationLine = null;
          let maxPresentationLineStep = 0;
          let corridorSamples = 0;
          let corridorMissingTextFrames = 0;
          const motionAnomalies = [];
          const sampleContinuousMotion = () => {
            const data = root.userData && root.userData.lyric;
            if (!data || !Array.isArray(data.rowLayers)) return false;
            const lineStepWorld = Math.max(0.001, Number(data.lineWorldStep) || 0.38);
            const primaryRows = data.rowLayers.filter(row => row && row.isPrimary && row.mesh && Number.isFinite(Number(row.virtualIndex)));
            if (!primaryRows.length) return false;
            const visualByRow = primaryRows.map(row => ({
              row,
              key: stageLyricResidentRowKey(row),
              offset: Number(row.virtualIndex) + (Number(row.mesh.position.y) || 0) / lineStepWorld
            })).filter(sample => Number.isFinite(sample.offset));
            const visualOffsetsByKey = new Map(visualByRow.map(sample => [sample.key, sample.offset]));
            const existingOffsets = visualByRow.filter(sample => seenPrimaryRows.has(sample.key)).map(sample => sample.offset);
            const existingMedian = median(existingOffsets);
            if (existingMedian != null) {
              for (const sample of visualByRow) {
                if (!seenPrimaryRows.has(sample.key)) maxJoinError = Math.max(maxJoinError, Math.abs(sample.offset - existingMedian));
              }
            }
            for (const sample of visualByRow) seenPrimaryRows.add(sample.key);
            const visualOffset = median(visualByRow.map(sample => sample.offset));
            const scrollOffset = Number(data.trackScrollOffset);
            const pendingTargetLineIndex = data.trackPendingPayload && Number.isFinite(Number(data.trackPendingPayload.trackIndex))
              ? Number(data.trackPendingPayload.trackIndex)
              : null;
            const targetLineIndex = pendingTargetLineIndex == null ? Number(data.trackTargetLineIndex) : pendingTargetLineIndex;
            const targetVirtualIndex = pendingTargetLineIndex == null && Number.isFinite(Number(data.trackTargetVirtualIndex))
              ? Number(data.trackTargetVirtualIndex)
              : lyricPrimaryVirtualIndex(Number.isFinite(targetLineIndex) ? targetLineIndex : 0);
            const presentationLine = Number(data.trackPresentationLineIndex);
            if (data.trackPreviewCorridorActive && Number.isFinite(presentationLine)) {
              corridorSamples += 1;
              presentationLinesVisited.add(Math.round(presentationLine));
              if (previousPresentationLine != null) maxPresentationLineStep = Math.max(maxPresentationLineStep, Math.abs(presentationLine - previousPresentationLine));
              previousPresentationLine = presentationLine;
              const corridorHasVisibleText = data.rowLayers.some(row => {
                if (!row || !row.isPrimary || !row.mesh || !row.renderLineUploaded || !row.mesh.visible) return false;
                return lyricLineAllowedForDisplayMode(Number(row.lineIndex), presentationLine, data.displayMode);
              });
              if (!corridorHasVisibleText) corridorMissingTextFrames += 1;
            }
            if (!Number.isFinite(scrollOffset) || visualOffset == null || !Number.isFinite(targetVirtualIndex)) return false;
            if (previousContinuousSample) {
              const gap = targetVirtualIndex - previousContinuousSample.scrollOffset;
              const delta = scrollOffset - previousContinuousSample.scrollOffset;
              const lastLineIndex = Math.max(0, window.lyricsLines.length - 1);
              const normalizedTargetLine = Math.max(0, Math.min(lastLineIndex, Math.round(Number(targetLineIndex) || 0)));
              const neighborLineIndex = normalizedTargetLine < lastLineIndex ? normalizedTargetLine + 1 : Math.max(0, normalizedTargetLine - 1);
              const primarySlotStep = Math.max(0.001, Math.abs(lyricPrimaryVirtualIndex(neighborLineIndex) - lyricPrimaryVirtualIndex(normalizedTargetLine)) || 1);
              const renderFrame = Number(window.__mineradioLyricUploadBudgetStats && window.__mineradioLyricUploadBudgetStats.frame) || 0;
              const renderFrameSpan = Math.max(1, renderFrame - Number(previousContinuousSample.renderFrame || 0));
              maxTrackRowsPerFrame = Math.max(maxTrackRowsPerFrame, Math.abs(delta) / primarySlotStep / renderFrameSpan);
              if (Math.abs(gap) > 0.025) {
                const followRatio = Math.abs(delta / gap);
                maxTrackFollowRatio = Math.max(maxTrackFollowRatio, followRatio);
                if (followRatio > 0.72 || (Math.abs(gap) > 0.25 && Math.abs(scrollOffset - targetVirtualIndex) < 0.0001)) {
                  snapFrames += 1;
                  if (motionAnomalies.length < 12) motionAnomalies.push({ type: 'track-snap', gap, delta, followRatio, scrollOffset, targetVirtualIndex });
                }
                const dragDirection = finalTarget >= 0 ? 1 : -1;
                if (delta * dragDirection < -0.0001) {
                  reverseFrames += 1;
                  if (motionAnomalies.length < 12) motionAnomalies.push({ type: 'track-reverse', gap, delta, scrollOffset, targetVirtualIndex });
                }
                const targetHeldStill = Math.abs(targetVirtualIndex - previousContinuousSample.targetVirtualIndex) < 0.0001;
                if (targetHeldStill && (targetVirtualIndex - previousContinuousSample.scrollOffset) * (targetVirtualIndex - scrollOffset) < -0.000001) overshootFrames += 1;
              }
              const visualGap = targetVirtualIndex - previousContinuousSample.visualOffset;
              const stableVisualDeltas = [];
              for (const [key, offset] of visualOffsetsByKey) {
                if (previousVisualOffsetsByKey.has(key)) stableVisualDeltas.push(offset - previousVisualOffsetsByKey.get(key));
              }
              const stableVisualDelta = median(stableVisualDeltas);
              const visualDelta = stableVisualDelta == null ? visualOffset - previousContinuousSample.visualOffset : stableVisualDelta;
              maxVisualStep = Math.max(maxVisualStep, Math.abs(visualDelta));
              maxVisualRowsPerFrame = Math.max(maxVisualRowsPerFrame, Math.abs(visualDelta) / primarySlotStep / renderFrameSpan);
              if (Math.abs(visualGap) > 0.025) {
                maxVisualFollowRatio = Math.max(maxVisualFollowRatio, Math.abs(visualDelta / visualGap));
                const dragDirection = finalTarget >= 0 ? 1 : -1;
                if (visualDelta * dragDirection < -0.0001) {
                  reverseFrames += 1;
                  if (motionAnomalies.length < 12) motionAnomalies.push({ type: 'visual-reverse', visualGap, visualDelta, visualOffset, targetVirtualIndex });
                }
              }
              if (Math.abs(delta) > 0.0005 || Math.abs(visualDelta) > 0.0005) movingFrames += 1;
            }
            previousContinuousSample = {
              scrollOffset,
              visualOffset,
              targetVirtualIndex,
              renderFrame: Number(window.__mineradioLyricUploadBudgetStats && window.__mineradioLyricUploadBudgetStats.frame) || 0
            };
            previousVisualOffsetsByKey = visualOffsetsByKey;
            continuousSamples += 1;
            return true;
          };
          const qaLyricFrame = async () => {
            await new Promise(resolve => requestAnimationFrame(resolve));
          };
          const dragMotionSamples = {
            groupY: [],
            groupScaleY: [],
            rootY: [],
            rootScale: [],
            primaryY: [],
            translationY: [],
            worldPrimaryY: [],
            screenPrimaryY: [],
            screenTranslationY: []
          };
          const primaryWorldPosition = new THREE.Vector3();
          const translationWorldPosition = new THREE.Vector3();
          let maxTrackLockError = 0;
          let maxPrimaryAnchorError = 0;
          let maxEffectYError = 0;
          let unlockedMotionSamples = 0;
          const sampleDragMotion = () => {
            const data = root.userData && root.userData.lyric;
            if (!data || !Array.isArray(data.rowLayers)) return false;
            const primary = data.rowLayers.find(row => row && row.isPrimary && Number(row.lineIndex) === finalTarget && row.mesh);
            const translation = data.rowLayers.find(row => row && row.isTranslation && Number(row.parentIndex) === finalTarget && row.mesh);
            if (!primary || !translation) return false;
            if (camera) camera.updateMatrixWorld(true);
            stageLyrics.group.updateMatrixWorld(true);
            primary.mesh.getWorldPosition(primaryWorldPosition);
            translation.mesh.getWorldPosition(translationWorldPosition);
            dragMotionSamples.groupY.push(Number(stageLyrics.group.position.y) || 0);
            dragMotionSamples.groupScaleY.push(Number(stageLyrics.group.scale.y) || 0);
            dragMotionSamples.rootY.push(Number(root.position.y) || 0);
            dragMotionSamples.rootScale.push(Number(root.scale.x) || 0);
            dragMotionSamples.primaryY.push(Number(primary.mesh.position.y) || 0);
            dragMotionSamples.translationY.push(Number(translation.mesh.position.y) || 0);
            dragMotionSamples.worldPrimaryY.push(Number(primaryWorldPosition.y) || 0);
            dragMotionSamples.screenPrimaryY.push(Number(primaryWorldPosition.clone().project(camera).y) || 0);
            dragMotionSamples.screenTranslationY.push(Number(translationWorldPosition.clone().project(camera).y) || 0);
            if (!root.userData.progressPreviewMotionLocked) unlockedMotionSamples += 1;
            const targetVirtualIndex = lyricPrimaryVirtualIndex(finalTarget);
            maxTrackLockError = Math.max(maxTrackLockError, Math.abs((Number(data.trackScrollOffset) || 0) - targetVirtualIndex));
            maxPrimaryAnchorError = Math.max(maxPrimaryAnchorError, Math.abs(Number(primary.mesh.position.y) || 0));
            if (primary.readability) maxEffectYError = Math.max(maxEffectYError, Math.abs(primary.readability.position.y - primary.mesh.position.y));
            if (primary.glow) maxEffectYError = Math.max(maxEffectYError, Math.abs(primary.glow.position.y - primary.mesh.position.y));
            if (translation.readability) maxEffectYError = Math.max(maxEffectYError, Math.abs(translation.readability.position.y - translation.mesh.position.y));
            if (translation.glow) maxEffectYError = Math.max(maxEffectYError, Math.abs(translation.glow.position.y - translation.mesh.position.y));
            return true;
          };
          const motionSpan = values => values.length ? Math.max(...values) - Math.min(...values) : Infinity;
          dispatchPointer('pointerdown', 0.05);
          const dragRatios = [];
          for (let step = 1; step <= 96; step += 1) dragRatios.push(0.05 + (finalRatio - 0.05) * step / 96);
          for (const ratio of dragRatios) {
            dispatchPointer('pointermove', ratio);
            await qaLyricFrame();
            sampleResident();
            sampleContinuousMotion();
          }
          let dragLockReady = false;
          const dragLockDeadline = performance.now() + 2200;
          while (performance.now() < dragLockDeadline) {
            await qaLyricFrame();
            const lockData = root.userData && root.userData.lyric;
            dragLockReady = !!(
              lockData && !lockData.trackPendingPayload &&
              Number(lockData.trackTargetLineIndex) === finalTarget &&
              stageLyricPersistentTargetRowsReady(root, finalTarget)
            );
            sampleResident();
            sampleContinuousMotion();
            if (dragLockReady) break;
          }
          if (!dragLockReady) return { ok: false, reason: 'drag preview target text timeout' };
          const effectsReadyAtFirstTextCommit = stageLyricPersistentTargetEffectsReady(root, finalTarget);
          let settleErrorIncreases = 0;
          let previousSettleError = Infinity;
          for (let sample = 0; sample < 36; sample += 1) {
            await qaLyricFrame();
            sampleContinuousMotion();
            const settleData = root.userData && root.userData.lyric;
            const settleTargetVirtual = lyricPrimaryVirtualIndex(finalTarget);
            const settleError = Math.abs((Number(settleData && settleData.trackScrollOffset) || 0) - settleTargetVirtual);
            if (settleError > previousSettleError + 0.003) settleErrorIncreases += 1;
            previousSettleError = settleError;
            if (!sampleDragMotion()) return { ok: false, reason: 'drag preview target rows missing during motion sample' };
          }
          const releasedAt = performance.now();
          dispatchPointer('pointerup', finalRatio);
          let previewDroppedBeforeReady = false;
          let maxUploadConsumed = 0;
          let textCommitMs = Infinity;
          let effectsReadyAtTextCommit = effectsReadyAtFirstTextCommit;
          const textDeadline = performance.now() + 2200;
          while (performance.now() < textDeadline) {
            await qaLyricFrame();
            const data = root.userData && root.userData.lyric;
            const textReady = !!(
              data && !data.trackPendingPayload &&
              Number(data.trackTargetLineIndex) === finalTarget &&
              stageLyricPersistentTargetRowsReady(root, finalTarget)
            );
            const preview = typeof getProgressDragPreviewSeconds === 'function' ? getProgressDragPreviewSeconds() : null;
            if (preview == null && !textReady) previewDroppedBeforeReady = true;
            if (preview != null && textReady) sampleDragMotion();
            sampleContinuousMotion();
            const uploadStats = window.__mineradioLyricUploadBudgetStats || {};
            maxUploadConsumed = Math.max(maxUploadConsumed, Number(uploadStats.consumed) || 0, Number(uploadStats.maxConsumed) || 0);
            sampleResident();
            if (textReady) {
              textCommitMs = performance.now() - releasedAt;
              break;
            }
          }
          if (!isFinite(textCommitMs)) return { ok: false, reason: 'drag target text timeout', previewDroppedBeforeReady };
          const dataAtCommit = root.userData && root.userData.lyric;
          const offsets = lyricDisplayOffsetsForMode(dataAtCommit.displayMode);
          for (const offset of offsets) {
            const lineIndex = finalTarget + Math.round(Number(offset) || 0);
            if (lineIndex < 0 || lineIndex >= window.lyricsLines.length) continue;
            const expected = dataAtCommit.rowLayers.filter(row => {
              const rowLineIndex = row && row.isTranslation ? Number(row.parentIndex) : Number(row && row.lineIndex);
              return row && row.mesh && rowLineIndex === lineIndex;
            });
            if (expected.length < 2 || expected.some(row => !row.renderLineUploaded || !row.mesh.visible)) {
              return { ok: false, reason: 'drag committed a partial text window', lineIndex, rows: expected.length };
            }
          }
          let settlementMotionSamples = 0;
          const settlementDeadline = performance.now() + 1800;
          while (performance.now() < settlementDeadline && stageLyricProgressPreviewActive()) {
            await qaLyricFrame();
            if (!stageLyricProgressPreviewActive()) break;
            sampleContinuousMotion();
            if (sampleDragMotion()) settlementMotionSamples += 1;
          }
          const previewReleasedAfterSettlement = !stageLyricProgressPreviewActive();
          const releaseBaselineRootY = Number(root.position.y) || 0;
          const releaseBaselineRootScale = Number(root.scale.x) || 0;
          const releaseBaselineRootRotation = Number(root.rotation.z) || 0;
          const releaseBaselineScreenY = dragMotionSamples.screenPrimaryY.length
            ? dragMotionSamples.screenPrimaryY[dragMotionSamples.screenPrimaryY.length - 1]
            : Infinity;
          await qaLyricFrame();
          const releaseData = root.userData && root.userData.lyric;
          const releasePrimary = releaseData && releaseData.rowLayers && releaseData.rowLayers.find(row => row && row.isPrimary && Number(row.lineIndex) === finalTarget && row.mesh);
          let releaseScreenY = Infinity;
          if (releasePrimary && camera) {
            camera.updateMatrixWorld(true);
            stageLyrics.group.updateMatrixWorld(true);
            releasePrimary.mesh.getWorldPosition(primaryWorldPosition);
            releaseScreenY = Number(primaryWorldPosition.clone().project(camera).y) || 0;
          }
          const releaseRootYDelta = Math.abs((Number(root.position.y) || 0) - releaseBaselineRootY);
          const releaseRootScaleDelta = Math.abs((Number(root.scale.x) || 0) - releaseBaselineRootScale);
          const releaseRootRotationDelta = Math.abs((Number(root.rotation.z) || 0) - releaseBaselineRootRotation);
          const releaseScreenYDelta = Math.abs(releaseScreenY - releaseBaselineScreenY);
          const effectsDeadline = performance.now() + 7000;
          while (performance.now() < effectsDeadline && !stageLyricPersistentTargetEffectsReady(root, finalTarget)) {
            await qaLyricFrame();
            sampleContinuousMotion();
            if (stageLyricProgressPreviewActive()) sampleDragMotion();
            const uploadStats = window.__mineradioLyricUploadBudgetStats || {};
            maxUploadConsumed = Math.max(maxUploadConsumed, Number(uploadStats.consumed) || 0, Number(uploadStats.maxConsumed) || 0);
            sampleResident();
          }
          const effectsReady = stageLyricPersistentTargetEffectsReady(root, finalTarget);
          const data = root.userData && root.userData.lyric;
          const sameTrackOutgoing = (stageLyrics.outgoing || []).filter(mesh => {
            const outgoingData = mesh && mesh.userData && mesh.userData.lyric;
            return outgoingData && outgoingData.trackKey === data.trackKey;
          }).length;
          const groupYDrift = motionSpan(dragMotionSamples.groupY);
          const groupScaleDrift = motionSpan(dragMotionSamples.groupScaleY);
          const rootYDrift = motionSpan(dragMotionSamples.rootY);
          const rootScaleDrift = motionSpan(dragMotionSamples.rootScale);
          const primaryYDrift = motionSpan(dragMotionSamples.primaryY);
          const translationYDrift = motionSpan(dragMotionSamples.translationY);
          const worldPrimaryYDrift = motionSpan(dragMotionSamples.worldPrimaryY);
          const screenPrimaryYDrift = motionSpan(dragMotionSamples.screenPrimaryY);
          const screenTranslationYDrift = motionSpan(dragMotionSamples.screenTranslationY);
          const continuousScrollOk = continuousSamples >= 80 && movingFrames >= 20 &&
            snapFrames === 0 && reverseFrames === 0 && overshootFrames === 0 &&
            maxTrackFollowRatio <= 0.60 && maxVisualFollowRatio <= 0.60 &&
            maxTrackRowsPerFrame <= 0.70 && maxVisualRowsPerFrame <= 0.70 && maxJoinError <= 0.18 &&
            corridorSamples >= 20 && presentationLinesVisited.size >= 20 && maxPresentationLineStep <= 3 && corridorMissingTextFrames === 0 &&
            settleErrorIncreases <= 1 && dragMotionSamples.primaryY.length >= 24 && settlementMotionSamples >= 6 &&
            unlockedMotionSamples === 0 && previewReleasedAfterSettlement &&
            rootYDrift <= 0.0001 && rootScaleDrift <= 0.0001 && maxEffectYError <= 0.05 &&
            releaseRootYDelta <= 0.008 && releaseRootScaleDelta <= 0.008 && releaseRootRotationDelta <= 0.008 && releaseScreenYDelta <= 0.008;
          return {
            ok: !previewDroppedBeforeReady && textCommitMs <= 1400 && effectsReady && continuousScrollOk &&
              stageLyrics.current === root && root.id === rootId && sameTrackOutgoing === 0 &&
              maxUploadConsumed <= 1 && maxResidentPrimaryDuringDrag <= window.lyricsLines.length && Number(data.trackResidentPrimaryCount) <= window.lyricsLines.length,
            rootId,
            finalTarget,
            committedTarget: Number(data.trackTargetLineIndex),
            previewDroppedBeforeReady,
            textCommitMs,
            effectsReadyAtTextCommit,
            effectsReady,
            sameTrackOutgoing,
            maxUploadConsumed,
            maxResidentPrimaryDuringDrag,
            maxResidentRowsDuringDrag,
            residentPrimary: Number(data.trackResidentPrimaryCount) || 0,
            motionSamples: dragMotionSamples.primaryY.length,
            settlementMotionSamples,
            groupYDrift,
            groupScaleDrift,
            rootYDrift,
            rootScaleDrift,
            primaryYDrift,
            translationYDrift,
            worldPrimaryYDrift,
            screenPrimaryYDrift,
            screenTranslationYDrift,
            unlockedMotionSamples,
            previewReleasedAfterSettlement,
            releaseRootYDelta,
            releaseRootScaleDelta,
            releaseRootRotationDelta,
            releaseScreenYDelta,
            maxTrackLockError,
            maxPrimaryAnchorError,
            maxEffectYError,
            continuousScrollOk,
            continuousSamples,
            movingFrames,
            snapFrames,
            reverseFrames,
            overshootFrames,
            maxTrackFollowRatio,
            maxVisualFollowRatio,
            maxVisualStep,
            maxTrackRowsPerFrame,
            maxVisualRowsPerFrame,
            corridorSamples,
            presentationLinesVisited: presentationLinesVisited.size,
            maxPresentationLineStep,
            corridorMissingTextFrames,
            maxJoinError,
            settleErrorIncreases,
            motionAnomalies
          };
        } catch (error) {
          return { ok: false, error: String(error && error.stack || error) };
        } finally {
          if (typeof clearProgressPreviewHold === 'function') clearProgressPreviewHold();
          if (typeof clearStageLyrics === 'function') clearStageLyrics();
          audio = oldAudio;
          playing = oldPlaying;
          window.lyricsLines = oldLines;
          window.lyricsTranslationLines = oldTranslations;
          if (oldDragState && typeof progressDragState !== 'undefined') Object.assign(progressDragState, oldDragState);
          if (oldUniformTime != null && uniforms && uniforms.uTime) uniforms.uTime.value = oldUniformTime;
          if (fx) {
            fx.particleLyrics = oldFx.particleLyrics;
            fx.lyricDisplayMode = oldFx.lyricDisplayMode;
            fx.lyricTranslationMode = oldFx.lyricTranslationMode;
            fx.lyricCustomLineCount = oldFx.lyricCustomLineCount;
            fx.lyricVerticalFloat = oldFx.lyricVerticalFloat;
            fx.lyricMotionStyle = oldFx.lyricMotionStyle;
          }
          if (typeof stageLyricTrackCache !== 'undefined') stageLyricTrackCache = { key: '', entries: null, lineMap: null, start: 0, end: -1 };
          if (typeof lyricPrimaryVirtualPrefixCache !== 'undefined') lyricPrimaryVirtualPrefixCache = { key: '', values: [0] };
        }
      }
      let persistentLyricQa = null;
      let progressDragLyricQa = null;
      async function waitQaFrame() {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      async function inspectSearchGlassEntrance() {
        const area = document.getElementById('search-area');
        const box = document.getElementById('search-box');
        const map = document.getElementById('search-box-glass-map');
        if (!area || !box || !map || typeof setPeek !== 'function') return { ok: false, reason: 'missing search glass nodes' };
        document.documentElement.classList.remove('startup-fast-skip-preload');
        document.body.classList.remove('startup-fast-skip-revealing', 'splash-active', 'immersive-mode');
        area.classList.remove('peek');
        document.documentElement.classList.remove('search-glass-ready', 'search-glass-priming', 'search-glass-fallback');
        map.removeAttribute('href');
        try { map.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); } catch (e) {}
        if (typeof updateSearchBoxGlassDisplacementMap === 'function') updateSearchBoxGlassDisplacementMap();
        if (typeof updateSearchPillGlassDisplacementMap === 'function') updateSearchPillGlassDisplacementMap();
        if (typeof applyControlGlassChromaticOffset === 'function') applyControlGlassChromaticOffset();
        const readSearchBoxGlassStyle = () => {
          const areaStyle = getComputedStyle(area);
          const boxStyle = getComputedStyle(box);
          const boxGlassStyle = getComputedStyle(box, '::before');
          const tabs = document.querySelector('#search-area .search-mode-tabs');
          const tabsStyle = tabs ? getComputedStyle(tabs) : null;
          const pill = document.querySelector('#search-area .search-mode-tabs button') || document.querySelector('#search-area .search-history-chip');
          const pillStyle = pill ? getComputedStyle(pill) : null;
          const pillGlassStyle = pill ? getComputedStyle(pill, '::before') : null;
          const boxMap = document.getElementById('search-box-glass-map');
          const pillMap = document.getElementById('search-pill-glass-map');
          const boxFilter = document.getElementById('mineradio-search-box-glass-filter');
          const pillFilter = document.getElementById('mineradio-search-pill-glass-filter');
          const readHref = img => {
            if (!img) return '';
            let href = img.getAttribute('href') || '';
            try { href = href || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || ''; } catch (e) {}
            return href;
          };
          const readOffsetDx = (filter, result) => {
            const node = filter && filter.querySelector ? filter.querySelector('feOffset[result="' + result + '"]') : null;
            return node ? Number(node.getAttribute('dx')) : NaN;
          };
          const decodeHref = href => {
            try { return decodeURIComponent(href || ''); } catch (e) { return String(href || ''); }
          };
          const boxHref = readHref(boxMap);
          const pillHref = readHref(pillMap);
          const boxHrefText = decodeHref(boxHref);
          const pillHrefText = decodeHref(pillHref);
          return {
            opacity: areaStyle.opacity,
            directFilter: boxStyle.backdropFilter || boxStyle.webkitBackdropFilter || '',
            directBackgroundColor: boxStyle.backgroundColor || '',
            directBorderTopColor: boxStyle.borderTopColor || '',
            directBorderTopWidth: boxStyle.borderTopWidth || '',
            directBoxShadow: boxStyle.boxShadow || '',
            glassContent: boxGlassStyle.content || '',
            glassFilter: boxGlassStyle.backdropFilter || boxGlassStyle.webkitBackdropFilter || '',
            glassBackgroundColor: boxGlassStyle.backgroundColor || '',
            glassBorderTopColor: boxGlassStyle.borderTopColor || '',
            glassBorderTopWidth: boxGlassStyle.borderTopWidth || '',
            glassBoxShadow: boxGlassStyle.boxShadow || '',
            tabsFilter: tabsStyle ? (tabsStyle.backdropFilter || tabsStyle.webkitBackdropFilter || '') : '',
            tabsBackgroundColor: tabsStyle ? (tabsStyle.backgroundColor || '') : '',
            tabsBorderTopColor: tabsStyle ? (tabsStyle.borderTopColor || '') : '',
            tabsBoxShadow: tabsStyle ? (tabsStyle.boxShadow || '') : '',
            pillFilter: pillStyle ? (pillStyle.backdropFilter || pillStyle.webkitBackdropFilter || '') : '',
            pillBackgroundColor: pillStyle ? (pillStyle.backgroundColor || '') : '',
            pillBorderTopColor: pillStyle ? (pillStyle.borderTopColor || '') : '',
            pillBorderTopWidth: pillStyle ? (pillStyle.borderTopWidth || '') : '',
            pillBoxShadow: pillStyle ? (pillStyle.boxShadow || '') : '',
            pillGlassContent: pillGlassStyle ? (pillGlassStyle.content || '') : '',
            pillGlassFilter: pillGlassStyle ? (pillGlassStyle.backdropFilter || pillGlassStyle.webkitBackdropFilter || '') : '',
            pillGlassBackgroundColor: pillGlassStyle ? (pillGlassStyle.backgroundColor || '') : '',
            pillGlassBoxShadow: pillGlassStyle ? (pillGlassStyle.boxShadow || '') : '',
            boxMapIsRgb: boxHref.indexOf('glass-red') > -1 || boxHrefText.indexOf('glass-red') > -1,
            pillMapIsRgb: pillHref.indexOf('glass-blue') > -1 || pillHrefText.indexOf('glass-blue') > -1,
            boxRedDx: readOffsetDx(boxFilter, 'dispRedShifted'),
            boxGreenDx: readOffsetDx(boxFilter, 'dispGreenShifted'),
            boxBlueDx: readOffsetDx(boxFilter, 'dispBlueShifted'),
            pillRedDx: readOffsetDx(pillFilter, 'dispRedShifted'),
            pillGreenDx: readOffsetDx(pillFilter, 'dispGreenShifted'),
            pillBlueDx: readOffsetDx(pillFilter, 'dispBlueShifted')
          };
        };
        const searchBoxFilterLooksLikeSavedRgbGlass = value => String(value || '').includes('mineradio-search-box-glass-filter') && String(value || '').includes('saturate(1)');
        const searchPillFilterLooksLikeSavedRgbGlass = value => String(value || '').includes('mineradio-search-pill-glass-filter') && String(value || '').includes('saturate(1)');
        const searchBoxDirectFilterLooksCleared = value => String(value || '') === 'none';
        const searchBoxMapLooksLikeSavedRgbGlass = value =>
          !!(value && value.boxMapIsRgb) &&
          isFinite(value && value.boxRedDx) &&
          isFinite(value && value.boxGreenDx) &&
          isFinite(value && value.boxBlueDx) &&
          Math.abs((value && value.boxRedDx) + 90) <= 0.5 &&
          Math.abs((value && value.boxGreenDx) + 90) <= 0.5 &&
          Math.abs((value && value.boxBlueDx) + 90) <= 0.5;
        const searchBoxHiddenStyleLooksClear = value =>
          String(value && value.glassContent || '') === 'none' &&
          searchBoxDirectFilterLooksCleared(value && value.directFilter) &&
          String(value && value.directBackgroundColor || '').includes('0, 0, 0, 0') &&
          String(value && value.directBoxShadow || '') === 'none' &&
          searchBoxMapLooksLikeSavedRgbGlass(value);
        const searchBoxVisibleStyleLooksLikeSavedRgbGlass = value =>
          String(value && value.glassContent || '') === 'none' &&
          searchBoxFilterLooksLikeSavedRgbGlass(value && value.directFilter) &&
          String(value && value.directBackgroundColor || '').includes('0, 0, 0') &&
          String(value && value.directBoxShadow || '').includes('inset') &&
          searchBoxMapLooksLikeSavedRgbGlass(value);
        const closedStyle = readSearchBoxGlassStyle();
        const closed = {
          peek: area.classList.contains('peek'),
          ready: document.documentElement.classList.contains('search-glass-ready'),
          priming: document.documentElement.classList.contains('search-glass-priming'),
          fallback: document.documentElement.classList.contains('search-glass-fallback'),
          opacity: closedStyle.opacity,
          directFilter: closedStyle.directFilter,
          directBackgroundColor: closedStyle.directBackgroundColor,
          directBorderTopColor: closedStyle.directBorderTopColor,
          directBorderTopWidth: closedStyle.directBorderTopWidth,
          directBoxShadow: closedStyle.directBoxShadow,
          glassContent: closedStyle.glassContent,
          glassFilter: closedStyle.glassFilter,
          glassBackgroundColor: closedStyle.glassBackgroundColor,
          glassBorderTopColor: closedStyle.glassBorderTopColor,
          glassBorderTopWidth: closedStyle.glassBorderTopWidth,
          glassBoxShadow: closedStyle.glassBoxShadow,
          pillFilter: closedStyle.pillFilter,
          pillBackgroundColor: closedStyle.pillBackgroundColor,
          pillBorderTopColor: closedStyle.pillBorderTopColor,
          pillBorderTopWidth: closedStyle.pillBorderTopWidth,
          pillBoxShadow: closedStyle.pillBoxShadow,
          pillGlassContent: closedStyle.pillGlassContent,
          pillGlassFilter: closedStyle.pillGlassFilter,
          pillGlassBackgroundColor: closedStyle.pillGlassBackgroundColor,
          pillGlassBoxShadow: closedStyle.pillGlassBoxShadow,
          tabsFilter: closedStyle.tabsFilter,
          tabsBackgroundColor: closedStyle.tabsBackgroundColor,
          tabsBorderTopColor: closedStyle.tabsBorderTopColor,
          tabsBoxShadow: closedStyle.tabsBoxShadow,
          boxMapIsRgb: closedStyle.boxMapIsRgb,
          pillMapIsRgb: closedStyle.pillMapIsRgb,
          boxRedDx: closedStyle.boxRedDx,
          boxGreenDx: closedStyle.boxGreenDx,
          boxBlueDx: closedStyle.boxBlueDx,
          pillRedDx: closedStyle.pillRedDx,
          pillGreenDx: closedStyle.pillGreenDx,
          pillBlueDx: closedStyle.pillBlueDx
        };
        setPeek(area, true, 'search');
        const immediateStyle = readSearchBoxGlassStyle();
        const immediate = {
          peek: area.classList.contains('peek'),
          ready: document.documentElement.classList.contains('search-glass-ready'),
          priming: document.documentElement.classList.contains('search-glass-priming'),
          fallback: document.documentElement.classList.contains('search-glass-fallback'),
          opacity: immediateStyle.opacity,
          directFilter: immediateStyle.directFilter,
          directBackgroundColor: immediateStyle.directBackgroundColor,
          directBorderTopColor: immediateStyle.directBorderTopColor,
          directBorderTopWidth: immediateStyle.directBorderTopWidth,
          directBoxShadow: immediateStyle.directBoxShadow,
          glassContent: immediateStyle.glassContent,
          glassFilter: immediateStyle.glassFilter,
          glassBackgroundColor: immediateStyle.glassBackgroundColor,
          glassBorderTopColor: immediateStyle.glassBorderTopColor,
          glassBorderTopWidth: immediateStyle.glassBorderTopWidth,
          glassBoxShadow: immediateStyle.glassBoxShadow,
          pillFilter: immediateStyle.pillFilter,
          pillBackgroundColor: immediateStyle.pillBackgroundColor,
          pillBorderTopColor: immediateStyle.pillBorderTopColor,
          pillBorderTopWidth: immediateStyle.pillBorderTopWidth,
          pillBoxShadow: immediateStyle.pillBoxShadow,
          pillGlassContent: immediateStyle.pillGlassContent,
          pillGlassFilter: immediateStyle.pillGlassFilter,
          pillGlassBackgroundColor: immediateStyle.pillGlassBackgroundColor,
          pillGlassBoxShadow: immediateStyle.pillGlassBoxShadow,
          tabsFilter: immediateStyle.tabsFilter,
          tabsBackgroundColor: immediateStyle.tabsBackgroundColor,
          tabsBorderTopColor: immediateStyle.tabsBorderTopColor,
          tabsBoxShadow: immediateStyle.tabsBoxShadow,
          boxMapIsRgb: immediateStyle.boxMapIsRgb,
          pillMapIsRgb: immediateStyle.pillMapIsRgb,
          boxRedDx: immediateStyle.boxRedDx,
          boxGreenDx: immediateStyle.boxGreenDx,
          boxBlueDx: immediateStyle.boxBlueDx,
          pillRedDx: immediateStyle.pillRedDx,
          pillGreenDx: immediateStyle.pillGreenDx,
          pillBlueDx: immediateStyle.pillBlueDx
        };
        // SVG readiness is asynchronous and the visible opacity transition is
        // 350 ms. Four rAFs can sample the entrance near opacity 0 on a fast
        // machine, so wait for the real visible state with a bounded timeout.
        for (let frame = 0; frame < 36; frame += 1) {
          await waitQaFrame();
          const probeStyle = readSearchBoxGlassStyle();
          if (
            area.classList.contains('peek') &&
            document.documentElement.classList.contains('search-glass-ready') &&
            Number(probeStyle.opacity) > 0.45
          ) break;
        }
        const afterPaintStyle = readSearchBoxGlassStyle();
        const afterPaint = {
          peek: area.classList.contains('peek'),
          ready: document.documentElement.classList.contains('search-glass-ready'),
          priming: document.documentElement.classList.contains('search-glass-priming'),
          fallback: document.documentElement.classList.contains('search-glass-fallback'),
          opacity: afterPaintStyle.opacity,
          directFilter: afterPaintStyle.directFilter,
          directBackgroundColor: afterPaintStyle.directBackgroundColor,
          directBorderTopColor: afterPaintStyle.directBorderTopColor,
          directBorderTopWidth: afterPaintStyle.directBorderTopWidth,
          directBoxShadow: afterPaintStyle.directBoxShadow,
          glassContent: afterPaintStyle.glassContent,
          glassFilter: afterPaintStyle.glassFilter,
          glassBackgroundColor: afterPaintStyle.glassBackgroundColor,
          glassBorderTopColor: afterPaintStyle.glassBorderTopColor,
          glassBorderTopWidth: afterPaintStyle.glassBorderTopWidth,
          glassBoxShadow: afterPaintStyle.glassBoxShadow,
          pillFilter: afterPaintStyle.pillFilter,
          pillBackgroundColor: afterPaintStyle.pillBackgroundColor,
          pillBorderTopColor: afterPaintStyle.pillBorderTopColor,
          pillBorderTopWidth: afterPaintStyle.pillBorderTopWidth,
          pillBoxShadow: afterPaintStyle.pillBoxShadow,
          pillGlassContent: afterPaintStyle.pillGlassContent,
          pillGlassFilter: afterPaintStyle.pillGlassFilter,
          pillGlassBackgroundColor: afterPaintStyle.pillGlassBackgroundColor,
          pillGlassBoxShadow: afterPaintStyle.pillGlassBoxShadow,
          tabsFilter: afterPaintStyle.tabsFilter,
          tabsBackgroundColor: afterPaintStyle.tabsBackgroundColor,
          tabsBorderTopColor: afterPaintStyle.tabsBorderTopColor,
          tabsBoxShadow: afterPaintStyle.tabsBoxShadow,
          boxMapIsRgb: afterPaintStyle.boxMapIsRgb,
          pillMapIsRgb: afterPaintStyle.pillMapIsRgb,
          boxRedDx: afterPaintStyle.boxRedDx,
          boxGreenDx: afterPaintStyle.boxGreenDx,
          boxBlueDx: afterPaintStyle.boxBlueDx,
          pillRedDx: afterPaintStyle.pillRedDx,
          pillGreenDx: afterPaintStyle.pillGreenDx,
          pillBlueDx: afterPaintStyle.pillBlueDx
        };
        const checks = {
          closedHidden: !closed.peek && Number(closed.opacity) < 0.01,
          closedFilterOk: searchBoxDirectFilterLooksCleared(closed.directFilter),
          closedBodyOk: searchBoxHiddenStyleLooksClear(closed),
          immediateHeldBackUntilSvgReady: !immediate.peek && immediate.priming && Number(immediate.opacity) < 0.01,
          immediateFilterOk: searchBoxDirectFilterLooksCleared(immediate.directFilter),
          immediateBodyOk: searchBoxHiddenStyleLooksClear(immediate),
          afterPaintPeek: afterPaint.peek,
          afterPaintReady: afterPaint.ready,
          afterPaintVisible: Number(afterPaint.opacity) > 0.45,
          afterPaintFilterOk: searchBoxFilterLooksLikeSavedRgbGlass(afterPaint.directFilter) && String(afterPaint.glassContent || '') === 'none',
          afterPaintBodyOk: searchBoxVisibleStyleLooksLikeSavedRgbGlass(afterPaint),
          searchPillFilterOk: searchPillFilterLooksLikeSavedRgbGlass(afterPaint.pillFilter),
          searchPillBodyOk: String(afterPaint.pillGlassContent || '') === 'none' &&
            (String(afterPaint.pillBackgroundColor || '').includes('0, 0, 0') ||
            String(afterPaint.pillBackgroundColor || '').includes('255, 255, 255')) &&
            String(afterPaint.pillBorderTopWidth || '') !== '0px' &&
            String(afterPaint.pillBoxShadow || '').includes('inset') &&
            !!afterPaint.pillMapIsRgb &&
            isFinite(afterPaint.pillRedDx) &&
            isFinite(afterPaint.pillGreenDx) &&
            isFinite(afterPaint.pillBlueDx) &&
            Math.abs(afterPaint.pillRedDx + 34) <= 0.5 &&
            Math.abs(afterPaint.pillGreenDx + 34) <= 0.5 &&
            Math.abs(afterPaint.pillBlueDx + 34) <= 0.5,
          searchTabsRailOk: String(afterPaint.tabsFilter || '') === 'none' &&
            String(afterPaint.tabsBackgroundColor || '').includes('0, 0, 0, 0') &&
            String(afterPaint.tabsBorderTopColor || '').includes('0, 0, 0, 0') &&
            String(afterPaint.tabsBoxShadow || '') === 'none'
        };
        setPeek(area, false, 'search');
        return {
          ok: checks.closedHidden &&
            checks.closedFilterOk &&
            checks.closedBodyOk &&
            checks.immediateHeldBackUntilSvgReady &&
            checks.immediateFilterOk &&
            checks.immediateBodyOk &&
            checks.afterPaintPeek &&
            checks.afterPaintReady &&
            checks.afterPaintVisible &&
            checks.afterPaintFilterOk &&
            checks.afterPaintBodyOk &&
            checks.searchPillFilterOk &&
            checks.searchPillBodyOk &&
            checks.searchTabsRailOk,
          checks,
          closed,
          immediate,
          afterPaint
        };
      }
      const searchGlassQa = await inspectSearchGlassEntrance();
      if (!searchGlassQa.ok) failures.push('search glass panel lost the saved RGB SVG material during reveal: ' + JSON.stringify(searchGlassQa));
      persistentLyricQa = await inspectPersistentLyricContinuity();
      if (!persistentLyricQa.ok) failures.push('persistent multi-line lyric continuity failed: ' + JSON.stringify(persistentLyricQa));
      progressDragLyricQa = await inspectProgressDragLyricContinuity();
      if (!progressDragLyricQa.ok) failures.push('real progress drag lyric continuity failed: ' + JSON.stringify(progressDragLyricQa));
      async function inspectAudioGraphMediaHandoff() {
        if (audio || audioCtx || source) return { ok: true, skipped: 'renderer already owns an audio graph' };
        const deckA = new Audio();
        const deckB = new Audio();
        try {
          audio = deckA;
          const firstReady = initAudio();
          const sourceA = source;
          const firstBound = audioSourceMedia === deckA;
          audio = deckB;
          resetPlaybackAudioGraphForSourceSwitch('qa-media-element-handoff');
          const detachedOldSource = source === null && audioSourceMedia === null;
          const secondReady = initAudio();
          const rebound = source && source !== sourceA && audioSourceMedia === deckB && audioGraphHealthy();
          return { ok: !!(firstReady && firstBound && detachedOldSource && secondReady && rebound), firstReady, firstBound, detachedOldSource, secondReady, rebound: !!rebound };
        } catch (error) {
          return { ok: false, error: String(error && error.stack || error) };
        } finally {
          disconnectAudioGraphNodes(false);
          audio = null;
          if (audioCtx && audioCtx.state !== 'closed' && audioCtx.close) {
            try { await audioCtx.close(); } catch (error) {}
          }
          audioCtx = null;
        }
      }
      const audioGraphHandoffQa = await inspectAudioGraphMediaHandoff();
      if (!audioGraphHandoffQa.ok) failures.push('audio analyser did not rebind from deck A to adopted deck B: ' + JSON.stringify(audioGraphHandoffQa));
      return {
        ok: failures.length === 0,
        failures,
        displayHz,
        fpsBeforeBoost,
        fpsAfterBoost,
        fixedFpsCadenceQa,
        lyricTextureQualityQa,
        lyricQualityCacheQa,
        lyricQa,
        persistentLyricQa,
        progressDragLyricQa,
        searchGlassQa,
        audioGraphHandoffQa,
        render: perf && perf.render,
        viewport: runtime && runtime.viewport
      };
    })();
  \`);

  finish(result.ok ? 0 : 1, { ok: result.ok, result, logs: logs.slice(-16) });
}).catch(error => {
  finish(1, { ok: false, error: String(error && error.stack || error), logs });
});
`;
}

function runElectronRuntimeCheck() {
  logStep('Electron runtime smoke check');
  const electron = electronExecutable();
  if (!electron) fail('Electron executable not found. Run npm install first.');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-quick-check-'));
  const qaScript = path.join(tempDir, 'qa-renderer-check.js');
  const qaPreload = path.join(tempDir, 'qa-preload.js');
  fs.writeFileSync(qaScript, runtimeQaScript(), 'utf8');
  fs.writeFileSync(qaPreload, `
try {
  window.localStorage.setItem('mineradio-startup-fast-skip-v1', 'true');
  window.localStorage.removeItem('mineradio-cuefield-automix-v1');
} catch (error) {}
`, 'utf8');

  try {
    const result = spawnSync(electron, [qaScript], {
      cwd: appRoot,
      env: { ...process.env, MINERADIO_QA_APP_ROOT: appRoot, MINERADIO_QA_PRELOAD: qaPreload },
      encoding: 'utf8',
      timeout: 45000
    });
    if (result.error) {
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      fail(String(result.error.message || result.error));
    }
    const match = String(result.stdout || '').match(/MINERADIO_QA_RESULT:(\{.*\})/);
    const payload = match ? JSON.parse(match[1]) : null;
    if (result.status !== 0 || !payload || payload.ok !== true) {
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      fail(`Electron runtime smoke check failed. Exit code: ${result.status}`);
    }
    const qa = payload.result || {};
    const render = qa.render || {};
    const searchGlass = qa.searchGlassQa || {};
    const lyricTextureQuality = qa.lyricTextureQualityQa || {};
    const lyricQualityCache = qa.lyricQualityCacheQa || {};
    const fixedFpsCadence = qa.fixedFpsCadenceQa || {};
    const persistentLyrics = qa.persistentLyricQa || {};
    const progressDragLyrics = qa.progressDragLyricQa || {};
    const afterPaint = searchGlass.afterPaint || {};
    console.log('[OK] Electron runtime smoke check passed.');
    console.log(`     displayHz=${Math.round((qa.displayHz || 0) * 10) / 10}, fps=${qa.fpsBeforeBoost}, boost=${qa.fpsAfterBoost}, mode=${render.mode || 'unknown'}`);
    console.log(`     fixedFpsCadence: ${(fixedFpsCadence.profiles || []).map(profile => `${profile.hz}Hz/${profile.target}=${Math.round(profile.actual * 10) / 10}`).join(', ') || 'n/a'}, dragCap=${!!fixedFpsCadence.fixedPreserved}, vsyncWake=${!!fixedFpsCadence.vsyncCanWake}`);
    console.log(`     lyricTextureQuality: ${(lyricTextureQuality.rows || []).map(row => `${row.tier}x=${row.width}x${row.height}`).join(', ') || 'n/a'}`);
    console.log(`     lyricQualityCache: rows=${lyricQualityCache.firstRows || 0}/${lyricQualityCache.maxRows || 0}, bytes=${lyricQualityCache.firstBytes || 0}, stable=${!!lyricQualityCache.stable}, expiredOverBudget=${!!lyricQualityCache.startedOverNewBudget}, noBaseFlash=${lyricQualityCache.sawBase === false}, noDisposeRevive=${!!lyricQualityCache.noDisposeResurrection}, tier=${lyricQualityCache.newTier || 0}`);
    console.log(`     persistentLyrics: root=${persistentLyrics.rootId || 'n/a'}, sameTrackOutgoing=${persistentLyrics.maxSameTrackOutgoing}, upload/frame=${persistentLyrics.maxUploadConsumed}, indexLag=${persistentLyrics.maxIndexLag}, residentPrimary=${persistentLyrics.maxResidentPrimary}, runway=${persistentLyrics.minimumForwardRunway}, logicalWidth=${persistentLyrics.maxLogicalRowWidth}, fontDrift=${Math.round((persistentLyrics.maxGlyphWorldDrift || 0) * 1000) / 10}%, activeScale=${Math.round((persistentLyrics.minActiveScale || 0) * 1000) / 1000}`);
    console.log(`     progressDragLyrics: root=${progressDragLyrics.rootId || 'n/a'}, commit=${Math.round(progressDragLyrics.textCommitMs || 0)}ms, previewGap=${!!progressDragLyrics.previewDroppedBeforeReady}, samples=${progressDragLyrics.continuousSamples || 0}, moving=${progressDragLyrics.movingFrames || 0}, snaps=${progressDragLyrics.snapFrames || 0}, reverse=${progressDragLyrics.reverseFrames || 0}, trackRows/frame=${Math.round((progressDragLyrics.maxTrackRowsPerFrame || 0) * 1000) / 1000}, visualRows/frame=${Math.round((progressDragLyrics.maxVisualRowsPerFrame || 0) * 1000) / 1000}, corridor=${progressDragLyrics.presentationLinesVisited || 0} lines/${progressDragLyrics.corridorMissingTextFrames || 0} blank, join=${Math.round((progressDragLyrics.maxJoinError || 0) * 1000) / 1000}, upload/frame=${progressDragLyrics.maxUploadConsumed}`);
    console.log(`     searchGlass: boxDirect=${afterPaint.directFilter || 'n/a'}, boxBefore=${afterPaint.glassFilter || 'n/a'}, pillDirect=${afterPaint.pillFilter || 'n/a'}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function removeOwnedStartupQaDirectory(target, parent, expectedLeaf) {
  if (!target || !parent || !expectedLeaf) return;
  const resolvedTarget = path.resolve(target);
  const resolvedParent = path.resolve(parent);
  if (path.dirname(resolvedTarget) !== resolvedParent || path.basename(resolvedTarget) !== expectedLeaf) {
    fail(`Refusing to remove unexpected startup QA path: ${resolvedTarget}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function runMainStartupRecoveryCheck() {
  logStep('Real main-entry startup recovery check');
  if (process.platform !== 'win32') {
    console.log('[SKIP] Real main-entry startup recovery check is Windows-specific.');
    return;
  }
  const electron = electronExecutable();
  if (!electron) fail('Electron executable not found. Run npm install first.');
  const appData = process.env.APPDATA;
  if (!appData) fail('APPDATA is required for the real main-entry startup recovery check');
  const runtimeName = `MineradioStartupQA-${process.pid}-${Date.now()}`;
  const qaUserDataParent = path.join(process.env.TEMP || appData, 'mineradio-startup-qa');
  fs.mkdirSync(qaUserDataParent, { recursive: true });
  const qaUserData = path.join(qaUserDataParent, runtimeName);
  const stateFile = path.join(qaUserData, 'startup-state.json');
  const qaSessionData = path.join(qaUserData, 'cache', 'chromium', runtimeName);
  try {
    const result = spawnSync(electron, [appRoot], {
      cwd: appRoot,
      env: {
        ...process.env,
        MINERADIO_RUNTIME_NAME: runtimeName,
        MINERADIO_APP_USER_MODEL_ID: 'com.mineradio.startup.qa',
        MINERADIO_NO_DESKTOP_SHORTCUT: '1',
        MINERADIO_STARTUP_QA_USER_DATA: qaUserData,
        MINERADIO_STARTUP_TEST_SERVER_DELAY_MS: '4500',
        MINERADIO_STARTUP_TEST_FAIL_FIRST_NAV: '1',
        MINERADIO_STARTUP_TEST_STALL_LOAD_PROMISE: '1',
        MINERADIO_STARTUP_QA_HIDDEN: '1',
        MINERADIO_STARTUP_QA_EXIT_MS: '700',
      },
      encoding: 'utf8',
      timeout: 40000,
    });
    if (result.error || result.status !== 0 || !fs.existsSync(stateFile)) {
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      fail(`Real main-entry startup QA failed: ${result.error && result.error.message || `exit=${result.status}`}`);
    }
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const events = Array.isArray(state.events) ? state.events : [];
    const firstAt = phase => {
      const event = events.find(item => item && item.phase === phase);
      return event ? Number(event.at) || 0 : 0;
    };
    const windowCreatedAt = firstAt('window-created');
    const windowVisibleAt = firstAt('window-visible');
    const serverReadyAt = firstAt('server-ready');
    const retryAt = firstAt('navigation-retry');
    const navigationReadyAt = firstAt('navigation-ready');
    const readyAt = firstAt('ready');
    const retryEvents = events.filter(item => item && item.phase === 'navigation-retry');
    const navigationAttempts = events.filter(item => item && item.phase === 'navigation-attempt');
    const secondNavigationAt = navigationAttempts[1] ? Number(navigationAttempts[1].at) || 0 : 0;
    const failedAt = firstAt('failed');
    if (
      state.phase !== 'ready'
      || !windowCreatedAt
      || !windowVisibleAt
      || !serverReadyAt
      || !retryAt
      || !navigationReadyAt
      || !readyAt
      || retryEvents.length !== 1
      || navigationAttempts.length !== 2
      || !secondNavigationAt
      || failedAt
      || windowVisibleAt >= serverReadyAt
      || readyAt <= retryAt
      || navigationReadyAt < secondNavigationAt
      || navigationReadyAt - secondNavigationAt >= 15000
      || windowVisibleAt - Number(state.startedAt || 0) > 5000
    ) {
      fail(`Real main-entry startup recovery invariants failed: ${JSON.stringify({ state, windowCreatedAt, windowVisibleAt, serverReadyAt, retryAt, navigationReadyAt, readyAt, secondNavigationAt, failedAt })}`);
    }
    console.log(`[OK] Startup shell visible in ${windowVisibleAt - state.startedAt}ms; injected first navigation failure recovered, stalled loadURL Promise was accepted by trusted navigation readiness in ${navigationReadyAt - secondNavigationAt}ms.`);
  } finally {
    if (fs.existsSync(qaUserData)) removeOwnedStartupQaDirectory(qaUserData, qaUserDataParent, runtimeName);
    const qaSessionParent = path.dirname(qaSessionData);
    if (fs.existsSync(qaSessionData)) removeOwnedStartupQaDirectory(qaSessionData, qaSessionParent, runtimeName);
  }
}

// 沙箱里用的 playlistDetailText 桩：抽出的渲染片段会调用它，而它的定义在被切走
// 之外。桩保持与真实实现一致的回退语义（有 fallback 用 fallback，否则回退到 key），
// 避免沙箱与真实行为漂移。
// Stub for playlistDetailText inside the vm sandboxes: the sliced render fragments
// call it while its definition sits outside the slice. It mirrors the real
// fallback semantics (use fallback when given, otherwise the key) so the sandbox
// cannot drift from the real function.
const playlistDetailTextStub = (key, fallback, params) => {
  if (fallback == null) return key;
  let out = String(fallback);
  if (params && typeof params === 'object') {
    for (const field of Object.keys(params)) out = out.split('{' + field + '}').join(String(params[field]));
  }
  return out;
};

async function checkLargePlaylistVirtualizationGuard() {
  logStep('Large playlist virtualization and progressive queue guard');
  const detailText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');
  const shelfText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const shelfContentText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '03-content-list-manager.js'), 'utf8');
  const qishuiText = fs.readFileSync(path.join(appRoot, 'server', 'qishui-api.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');

  if (!/fetchNeteaseUserPlaylistsPage/.test(serverText) || !/nextOffset/.test(serverText) || !/hasMore/.test(serverText)) {
    fail('Netease playlist catalog must expose real offset pagination');
  }
  if (!/neteasePlaylistTrackIndexCache/.test(serverText) || !/fetchNeteasePlaylistTrackIndex/.test(serverText) || !/NETEASE_TRACK_STREAM_PAGE_SIZE/.test(serverText)) {
    fail('Netease large-playlist pages must reuse one bounded track-id index instead of reparsing the whole playlist per page');
  }
  if (/targetCount\s*=\s*Math\.min\(240/.test(qishuiText) || !/qishuiWebPlaylistCursorCache/.test(qishuiText)) {
    fail('Qishui playlist pagination must not stop at 240 and must reuse cursor state');
  }
  if (!/function rebindShelfCard/.test(shelfText) || !/function rebindContentRow/.test(shelfContentText)) {
    fail('3D shelf cards and detail rows must reuse their GPU-backed objects');
  }
  const detailScrollerStart = detailText.indexOf('function bindPlaylistPanelDetailScroller');
  const detailScrollerEnd = detailText.indexOf('async function loadMorePlaylistPanelDetailTracks', detailScrollerStart);
  if (detailScrollerStart < 0 || detailScrollerEnd < 0 || /addEventListener\(['"]scroll/.test(detailText.slice(detailScrollerStart, detailScrollerEnd))) {
    fail('expanded playlist detail must share the outer playlist-panel scroll axis');
  }
  if (!/#playlist-panel \.pl-inline-detail[\s\S]*?overflow:\s*visible/.test(cssText) || !/#playlist-panel \.pl-card\.expanded::before/.test(cssText)) {
    fail('continuous expanded playlist detail and its highlighted group styling are missing');
  }
  const detailStickyRules = Array.from(cssText.matchAll(/#playlist-panel\s+\.pl-detail-sticky\s*\{([^}]*)\}/g));
  const detailStickyCss = detailStickyRules.length ? detailStickyRules[detailStickyRules.length - 1][1] : '';
  if (!/\bposition:\s*sticky\b/.test(detailStickyCss) || !/\btop:\s*(?!auto\b)[^;}]+/.test(detailStickyCss) || /\bposition:\s*(?:relative|static)\b|\btop:\s*auto\b/.test(detailStickyCss)) {
    fail('expanded playlist summary must stay sticky on the outer playlist-panel scroll axis');
  }
  const detailListRules = Array.from(cssText.matchAll(/#playlist-panel\s+\.pl-detail-list\s*\{([^}]*)\}/g));
  const detailListCss = detailListRules.length ? detailListRules[detailListRules.length - 1][1] : '';
  if (!/\boverflow:\s*visible\b/.test(detailListCss) || /\boverflow-y:\s*(?:auto|scroll)\b/.test(detailListCss)) {
    fail('expanded playlist tracks must keep the single outer scroll axis');
  }
  const shelfSync = shelfText.slice(shelfText.indexOf('function syncRenderedWindow'), shelfText.indexOf('function rebuild'));
  const contentSync = shelfContentText.slice(shelfContentText.indexOf('function syncRenderedRows'), shelfContentText.indexOf('return {', shelfContentText.indexOf('function syncRenderedRows')));
  if (/disposeRenderedCards\(\);\s*renderedStart\s*=\s*start/.test(shelfSync) || /disposeRows\(\);\s*renderedStart\s*=\s*start/.test(contentSync)) {
    fail('3D virtual windows must not dispose the whole GPU pool while scrolling');
  }

  const queueWindowStart = detailText.indexOf('function queuePanelVirtualWindow');
  const queueWindowEnd = detailText.indexOf('function scheduleQueuePanelVirtualRender', queueWindowStart);
  if (queueWindowStart < 0 || queueWindowEnd < 0) fail('queue virtual window helper missing');
  const queueWindowSandbox = { QUEUE_VIRTUAL_ROW_STEP: 62, QUEUE_VIRTUAL_OVERSCAN: 8, Math, Number };
  vm.runInNewContext(detailText.slice(queueWindowStart, queueWindowEnd), queueWindowSandbox, { filename: 'playlist-queue-window.js' });
  const queueWindow = queueWindowSandbox.queuePanelVirtualWindow(null, { clientHeight: 620, scrollTop: 62 * 9988 }, 10000, true, -1);
  if (queueWindow.end - queueWindow.start > 32 || queueWindow.start < 9950 || queueWindow.end !== 10000) {
    fail(`10k queue virtual window is too large or cannot reach the tail: ${JSON.stringify(queueWindow)}`);
  }

  const detailRowsStart = detailText.indexOf('function playlistPanelDetailRowsHtml');
  const detailRowsEnd = detailText.indexOf('var PLAYLIST_REORDER_STORE_KEY', detailRowsStart);
  if (detailRowsStart < 0 || detailRowsEnd < 0) fail('playlist detail virtual row helper missing');
  const detailRowsSandbox = {
    playlistPanelDetailState: {
      loading: false,
      loadingMore: false,
      tracks: Array.from({ length: 10000 }, (_, index) => ({ id: index, name: 'Track ' + index, artist: 'Artist' })),
      total: 10000,
      hasMore: false,
      error: '',
      message: ''
    },
    PLAYLIST_DETAIL_ROW_STEP: 56,
    PLAYLIST_DETAIL_VIRTUAL_OVERSCAN: 7,
    PLAYLIST_DETAIL_INITIAL_RENDER: 96,
    window: { innerHeight: 900 },
    songCoverSrc: () => '',
    playlistDetailText: playlistDetailTextStub,
    normalizePlaylistProvider: provider => provider === 'mineradio' ? 'mineradio' : (['qq', 'kugou', 'qishui', 'spotify'].includes(provider) ? provider : 'netease'),
    escHtml: value => String(value == null ? '' : value),
    Math,
    Number,
    String
  };
  vm.runInNewContext(detailText.slice(detailRowsStart, detailRowsEnd), detailRowsSandbox, { filename: 'playlist-detail-rows.js' });
  const detailRowsHtml = detailRowsSandbox.playlistPanelDetailRowsHtml({ viewport: 620, scrollTop: 56 * 9988 });
  const detailRowIndexes = Array.from(detailRowsHtml.matchAll(/data-pl-detail-row="(\d+)"/g), match => Number(match[1]));
  const detailSpacerCount = (detailRowsHtml.match(/class="pl-detail-virtual-spacer"/g) || []).length;
  if (detailRowIndexes.length > 26 || detailRowIndexes[detailRowIndexes.length - 1] !== 9999 || detailSpacerCount !== 2) {
    fail(`10k playlist detail virtual window regressed: ${JSON.stringify({ rows: detailRowIndexes.length, last: detailRowIndexes[detailRowIndexes.length - 1], spacers: detailSpacerCount })}`);
  }

  const catalogStart = detailText.indexOf('var playlistPanelVirtualCache');
  const catalogEnd = detailText.indexOf('function playlistCatalogFooterHtml', catalogStart);
  if (catalogStart < 0 || catalogEnd < 0) fail('playlist catalog virtual entry helper missing');
  const catalogSandbox = {
    playlistCatalogRevision: 1,
    userPlaylists: Array.from({ length: 5000 }, (_, index) => ({ provider: 'netease', id: String(index + 1), name: 'Playlist ' + index })),
    playlistPanelDetailState: { key: '', loading: false, tracks: [], total: 0, error: '' },
    normalizePlaylistProvider: provider => ['qq', 'kugou', 'qishui', 'spotify'].includes(provider) ? provider : 'netease',
    playlistCardPriority: () => 1,
    playlistPanelKey: (provider, id) => provider + ':' + id,
    playlistDetailText: playlistDetailTextStub,
    window: { innerHeight: 900 },
    Math,
    Number
  };
  vm.runInNewContext(detailText.slice(catalogStart, catalogEnd), catalogSandbox, { filename: 'playlist-catalog-window.js' });
  const catalogStarted = process.hrtime.bigint();
  const catalog = catalogSandbox.playlistPanelBuildVirtualEntries();
  const catalogMs = Number(process.hrtime.bigint() - catalogStarted) / 1e6;
  const visibleTop = Math.max(0, catalog.totalHeight - 620);
  const catalogWindowStart = catalogSandbox.playlistPanelOffsetIndex(catalog.offsets, Math.max(0, visibleTop - 760));
  const catalogWindowEnd = Math.min(catalog.entries.length, catalogSandbox.playlistPanelOffsetIndex(catalog.offsets, visibleTop + 620 + 760) + 1);
  if (catalog.entries.length !== 5001 || catalogWindowEnd - catalogWindowStart > 72 || catalogWindowEnd !== catalog.entries.length || catalogMs > 120) {
    fail(`5k playlist catalog virtualization missed its scale budget: ${JSON.stringify({ entries: catalog.entries.length, window: catalogWindowEnd - catalogWindowStart, end: catalogWindowEnd, ms: catalogMs })}`);
  }

  const hydrateStart = loaderText.indexOf('function playlistQueueSource');
  const hydrateEnd = loaderText.indexOf('async function loadPlaylistIntoQueueById', hydrateStart);
  if (hydrateStart < 0 || hydrateEnd < 0) fail('progressive playlist queue helper missing');
  const seed = Array.from({ length: 96 }, (_, id) => ({ id, name: 'Track ' + id }));
  const hydrateSandbox = {
    playQueue: seed,
    queueHydrationState: null,
    PLAYLIST_QUEUE_INITIAL_BATCH_SIZE: 96,
    PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE: 160,
    PLAYLIST_QUEUE_PLAYBACK_AHEAD_THRESHOLD: 96,
    playlistTracksEndpoint: (provider, id, params) => `${provider}:${id}?offset=${params.offset}&limit=${params.limit}`,
    apiJson: async url => {
      const offset = Number((url.match(/offset=(\d+)/) || [])[1]) || 0;
      const limit = Number((url.match(/limit=(\d+)/) || [])[1]) || 0;
      const count = Math.max(0, Math.min(limit, 10000 - offset));
      return {
        tracks: Array.from({ length: count }, (_, index) => ({ id: offset + index, name: 'Track ' + (offset + index) })),
        total: 10000,
        nextOffset: offset + count,
        hasMore: offset + count < 10000
      };
    },
    fetchPlaylistTracksPage: async (provider, id, params) => hydrateSandbox.apiJson(
      hydrateSandbox.playlistTracksEndpoint(provider, id, params)
    ),
    cloneSong: song => Object.assign({}, song),
    markSongsLiked: () => {},
    syncLikeStatusForSongs: () => {},
    safeRenderQueuePanel: () => {},
    scheduleShelfRebuild: () => { hydrateSandbox.shelfRebuilds += 1; },
    shuffleArrayInPlace: rows => rows,
    playMode: 'loop',
    setTimeout: () => { hydrateSandbox.autoSchedules += 1; return hydrateSandbox.autoSchedules; },
    clearTimeout: () => {},
    console,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    autoSchedules: 0,
    shelfRebuilds: 0
  };
  hydrateSandbox.queueHydrationState = {
    token: 7,
    active: true,
    loading: false,
    provider: 'netease',
    playlistId: 'scale-test',
    sourceId: 'scale-test',
    total: 10000,
    nextOffset: 96,
    hasMore: true,
    loaded: 96,
    error: '',
    promise: null,
    timer: 0,
    queueRef: seed,
    liked: false,
    warmPagesRemaining: 1,
    pausedForBuffer: false
  };
  vm.runInNewContext(loaderText.slice(hydrateStart, hydrateEnd), hydrateSandbox, { filename: 'playlist-progressive-queue.js' });
  let pages = 1;
  await hydrateSandbox.hydratePlaylistQueueNextPage('initial-warm-page');
  if (hydrateSandbox.playQueue.length !== 256 || !hydrateSandbox.queueHydrationState.active || hydrateSandbox.autoSchedules !== 0 || hydrateSandbox.shelfRebuilds !== 0) {
    fail(`10k queue must stop after one bounded warm page: ${JSON.stringify({ length: hydrateSandbox.playQueue.length, active: hydrateSandbox.queueHydrationState.active, autoSchedules: hydrateSandbox.autoSchedules, shelfRebuilds: hydrateSandbox.shelfRebuilds })}`);
  }
  while (hydrateSandbox.queueHydrationState.active && pages < 64) {
    await hydrateSandbox.hydratePlaylistQueueNextPage('queue-browse-tail');
    pages += 1;
  }
  const ids = hydrateSandbox.playQueue.map(song => song.id);
  if (ids.length !== 10000 || new Set(ids).size !== 10000 || ids[0] !== 0 || ids[9999] !== 9999 || pages > 63) {
    fail(`10k progressive queue did not complete in order: ${JSON.stringify({ length: ids.length, unique: new Set(ids).size, first: ids[0], last: ids[9999], pages })}`);
  }
  console.log(`[OK] 5k catalog=${catalogMs.toFixed(2)}ms/window ${catalogWindowEnd - catalogWindowStart}; 10k queue=1 warm + ${pages - 1} on-demand pages/window ${queueWindow.end - queueWindow.start}; one outer detail scroll; 3D pools retained.`);
}

function checkFxConsoleWorkspaceGuard() {
  logStep('Visual console workspace guard');
  const workspacePath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js');
  const panelPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js');
  const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
  const cssPath = path.join(appRoot, 'public', 'css', 'index.css');
  const htmlPath = path.join(appRoot, 'public', 'index.html');
  const defaultsPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js');
  const packagedDefaultsPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '05-packaged-fx-archive.js');
  const persistencePath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js');
  const archivePath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js');
  const defaultArchivePath = path.join(appRoot, 'public', 'default-user-fx-archive.json');
  const rowLayersPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js');
  const stageLyricsPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js');
  const starRiverPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '03-lyrics-star-river.js');
  const maskTexturePath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '10-lyrics-mask-textures.js');
  const workspace = fs.readFileSync(workspacePath, 'utf8');
  const panel = fs.readFileSync(panelPath, 'utf8');
  const loader = fs.readFileSync(loaderPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const defaults = fs.readFileSync(defaultsPath, 'utf8');
  const packagedDefaults = fs.readFileSync(packagedDefaultsPath, 'utf8');
  const persistence = fs.readFileSync(persistencePath, 'utf8');
  const archive = fs.readFileSync(archivePath, 'utf8');
  const defaultArchive = JSON.parse(fs.readFileSync(defaultArchivePath, 'utf8'));
  const rowLayers = fs.readFileSync(rowLayersPath, 'utf8');
  const stageLyrics = fs.readFileSync(stageLyricsPath, 'utf8');
  const starRiver = fs.readFileSync(starRiverPath, 'utf8');
  const maskTexture = fs.readFileSync(maskTexturePath, 'utf8');
  // 六个任务型分组标签已 i18n 化：JS 里用 consoleWorkspaceText(key) 取词，
  // 因此守卫校验「六个 key 都被登记」且「每个 key 在各语言词典里存在」，
  // 而不是在 JS 里搜硬编码中文分组名。
  // The six task-first tab labels moved into the dictionaries, so the guard checks
  // that every category key is registered and translated instead of grepping the
  // old hardcoded Chinese group names.
  const categoryKeys = ['fx_cat_common', 'fx_cat_ui', 'hotkey_cat_lyrics', 'fx_cat_motion', 'fx_cat_shelf', 'fx_cat_system'];
  if (!categoryKeys.every(key => new RegExp(`label: consoleWorkspaceText\\('${key}'\\)`).test(workspace))) {
    fail('task-first visual console tabs are incomplete');
  }
  requireLocaleKeys(...categoryKeys);
  if (!loader.includes("js/modules/07-fx/09-console-workspace.js")) fail('visual console workspace module is not loaded');
  // Wallpaper Engine 自成一组，那 4 个构图滑块必须一并登记 —— 它们此前没有登记，会被 fallback
  // 收进「其他设置」。这里钉住分组归属与选择器白名单，防止将来又漂回去。
  // Wallpaper Engine owns its own group, and the four framing sliders must be registered with it —
  // they had no registration and were being swept into "其他设置" by the residual fallback. Pin both
  // the group membership and the selector whitelist so they cannot drift back.
  if (!/key: 'wallpaper-engine', title: 'Wallpaper Engine'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-value'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('t-wallpaperEngineSilentWindows'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('t-wallpaperEngineGlassSampler'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-opacity'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-position-x'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-position-y'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-scale'/.test(workspace)) {
    fail('Wallpaper Engine must keep its own console group with the status row, both switches, and the four framing sliders');
  }
  // 逐分组切片再判断，否则跨组正则会一路匹配到后面的 Wallpaper Engine 组，把"已移走"误报成"还在"。
  // Slice the background group out first: a cross-group regex runs past the closing bracket and
  // matches the Wallpaper Engine group instead, reporting a moved item as still present.
  const backgroundGroup = (workspace.split("key: 'background'")[1] || '').split('] }')[0] || '';
  if (/wallpaper|wallpaperEngine/i.test(backgroundGroup)) {
    fail('Wallpaper Engine items must not stay in the background-media group once they have their own');
  }
  // 逐个登记后单个 .fx-slider 已命中白名单，容器不该再加进去 —— 加进去反而会让
  // "登记整个容器" 这种写法悄悄可行，把四个滑块当成一个块搬走。
  // With per-slider registration each .fx-slider already matches the whitelist, so the wrapper must
  // stay out of it — otherwise registering the whole container silently becomes viable again and the
  // four sliders travel as one opaque block.
  if (/\.wallpaper-engine-visual-controls/.test(workspace.split('var selector = ')[1] || '')) {
    fail('register the four WE sliders individually; keeping the wrapper in the selector whitelist allows the opaque-block form');
  }
  if (!/\.wallpaper-engine-visual-controls:empty/.test(css)) {
    fail('the emptied WE slider container must collapse, or it leaves an empty bordered box in the panel');
  }
  // 完整桌面模式的两项配套（壁纸透明度 / 壁纸帧数）必须与它们的开关同组。它们的 html 上带着
  // hidden，但作者样式表的 .fx-slider{display:grid} / .fx-seg{display:flex} 优先级高于 UA 的
  // [hidden]{display:none}，所以它们一直是可见的 —— 别被 hidden 属性误导当成死项。
  // Both desktop-wallpaper companions must sit in the same group as their toggle. Their markup
  // carries `hidden`, but the author-level .fx-slider{display:grid} / .fx-seg{display:flex} rules
  // outrank the UA [hidden]{display:none}, so they have always been visible — do not mistake the
  // attribute for a dead control.
  // 这两项是桌面层设置，归属「桌面歌词」组（那里已有同类的透明度/帧率），不是实验功能 ——
  // 实验功能里只留完整桌面模式那个开关本身。
  // These two are desktop-layer settings and belong to the 桌面歌词 group (which already has the same
  // kind of opacity and frame-rate controls), not 实验功能 — that group keeps only the switch itself.
  // 完整桌面模式的两个参数必须作为 child 挂在该开关下面（缩进 + 导线），而不是组里的并列项。
  // 顺序也重要：child 项要跟在 t-wallpaperMode 之后，否则会挂到上一个开关（桌面歌词）下面 ——
  // fxConsoleAppendItem 遇到新的 fx-toggle 会重置从属容器。
  // Both parameters must be registered as children right after the switch (indent + lead-in line),
  // never as peers. Order matters: a child lands under whichever fx-toggle came last, so following
  // t-wallpaperMode is what attaches them to it — fxConsoleAppendItem resets the nest on a new toggle.
  // 判据落在「登记顺序 + child 层级」上，不落在字符距离上。字符距离当「紧随其后」的代理
  // 会被与结构无关的变化带偏：给这两项接上取词函数，光文案变长就足以把 0,900 的窗口顶出去，
  // 而真实结构一根手指都没动。顺序与层级才是这里要守的东西。
  // Judge by registration order and nesting, not by character distance. Distance is a proxy
  // that unrelated copy length shifts — wiring an accessor into the item label is enough to bust
  // a 0,900 window while the structure never moved. Order and nesting are the real contract.
  const fxRegistration = (id) => {
    const at = workspace.indexOf(`fxConsoleItem('${id}'`);
    return at < 0 ? '' : workspace.slice(at, at + 320);
  };
  const desktopChildren = [['t-wallpaperMode', 'fx-wallpaperopacity'], ['fx-wallpaperopacity', 'wallpaper-fps-seg']];
  const desktopChildBroken = desktopChildren.some(([owner, child]) => {
    const ownerAt = workspace.indexOf(`fxConsoleItem('${owner}'`);
    const childAt = workspace.indexOf(`fxConsoleItem('${child}'`);
    if (ownerAt < 0 || childAt < 0 || childAt < ownerAt) return true;
    // 两者之间除 owner 自己以外不能再有登记：多一个就是被排成了同级项，而不是 child。
    // Nothing but the owner itself may be registered in between: another entry means the item was
    // made a peer instead of a child.
    return (workspace.slice(ownerAt, childAt).match(/fxConsoleItem\(/g) || []).length !== 1;
  });
  // child 标记（缩进 + 导线）必须仍在，否则它会掉回同级、脱离那把共享的锁。
  const desktopChildFlagsMissing = ['fx-wallpaperopacity', 'wallpaper-fps-seg']
    .filter((id) => !/, true, true\)/.test(fxRegistration(id)));
  if (desktopChildBroken || desktopChildFlagsMissing.length) {
    fail('full desktop mode opacity and frame rate must be registered as children directly after its switch'
      + (desktopChildFlagsMissing.length ? '：缺少 child 标记 ' + desktopChildFlagsMissing.join(', ') : ''));
  }
  const experimentalConsoleGroup2 = (workspace.split("key: 'experimental'")[1] || '').split('] }')[0] || '';
  // 实验功能组里不该再登记「壁纸透明度」：它归桌面歌词组，且必须以 child 形式挂在
  // t-wallpaperMode 下面（上面两条判据已经按顺序 + 层级钉住）。判据只看「有没有出现」，
  // 不写死实参文案 —— 实参已接 i18n 键，字面量会随文案变，写死就会误报。
  // The experimental group must not register the wallpaper opacity as a peer: it belongs to
  // the desktop-lyrics group as a child of t-wallpaperMode, already pinned above by order
  // and nesting. Judge by presence only — pinning argument text would break on copy edits.
  const experimentalOpacityAt = experimentalConsoleGroup2.indexOf("fxConsoleItem('fx-wallpaperopacity'");
  if (experimentalOpacityAt >= 0 && !/, true, true\)/.test(experimentalConsoleGroup2.slice(experimentalOpacityAt, experimentalOpacityAt + 320))) {
    fail('wallpaper opacity must stay a child of the full desktop mode switch, not a peer in the experimental group');
  }
// 「Windows 游戏模式」是一整条跨进程链路：主进程模块 → preload 桥 → 界面模块 → 开关元素 →
// 分组登记 → 默认值与持久化 → 打包快照。任一环断掉都会让开关点了没反应或状态显示错，而这类
// 失效全部是静默的，所以逐环钉住。**还原是这项功能的核心承诺**（关闭时按备份写回注册表），
// 必须与写入路径同时存在，否则可能出现"关不掉"。
// The Windows game mode switch is a cross-process chain: main module → preload bridge → UI module
// → toggle element → group registration → defaults/persistence → packaged snapshot. A break in any
// link makes the switch silently inert or its state wrong. Pin each link. The restore path is this
// feature's core promise (write the registry back from the backup) and must ship together with the
// write path, or the switch could become impossible to turn off.
const wgmModule = fs.readFileSync(path.join(appRoot, 'desktop', 'windows-game-mode.js'), 'utf8');
const wgmUi = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '10-windows-game-mode-ui.js'), 'utf8');
const wgmPreload = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
const wgmMain = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
const wgmLoader = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
if (!/HKCU/.test(wgmModule) || !/GameConfigStore/.test(wgmModule)) {
  fail('the Windows game mode module must target HKCU System GameConfigStore');
}
if (!/function readSubtree/.test(wgmModule) || !/BACKUP_FAILED/.test(wgmModule)) {
  fail('enabling the Windows game mode must back up the registry subtree first and refuse to write without a snapshot');
}
if (!/Remove-Item -LiteralPath/.test(wgmModule) || !/parentKeyName/.test(wgmModule)) {
  fail('disabling the Windows game mode must remove the keys it wrote, including the computed parents entry');
}
// 状态判定的两个输出必须互不包含：/REGISTERED/ 会命中 NOT_REGISTERED，把「从未注册」读成「已注册」，
// 那样关闭后就无法确认是否真的还原了。
// The two status tokens must not contain one another: /REGISTERED/ also matches NOT_REGISTERED,
// reading "never registered" as "registered" and hiding a failed restore.
if (!/MR_GAME_REGISTERED/.test(wgmModule) || !/MR_GAME_ABSENT/.test(wgmModule)) {
  fail('the Windows game mode status tokens must be mutually exclusive so a failed restore stays visible');
}
if (!/function regKeyPath/.test(wgmModule)) {
  fail('registry paths must be built by regKeyPath; hand-written escaping emits double backslashes and targets the wrong key');
}
if (!/minerado-windows-game-mode-status/.test(wgmMain) || !/minerado-windows-game-mode-enable/.test(wgmMain) || !/minerado-windows-game-mode-disable/.test(wgmMain)) {
  fail('the main process must expose status/enable/disable IPC for the Windows game mode switch');
}
if (!/require\('\.\/windows-game-mode'\)/.test(wgmMain)) {
  fail('the main process must require the Windows game mode module');
}
if (!/getWindowsGameModeStatus/.test(wgmPreload) || !/enableWindowsGameMode/.test(wgmPreload) || !/disableWindowsGameMode/.test(wgmPreload)) {
  fail('the preload bridge must expose the Windows game mode APIs to the renderer');
}
if (!/07-fx\/10-windows-game-mode-ui\.js/.test(wgmLoader)) {
  fail('the Windows game mode UI module must be loaded by the index loader');
}
if (!/id="t-windowsGameMode"/.test(html)) {
  fail('the Windows game mode toggle must exist in the DIY panel');
}
if (!/function toggleWindowsGameMode/.test(wgmUi) || !/function refreshWindowsGameModeState/.test(wgmUi)) {
  fail('the Windows game mode UI module must provide the toggle action and the state refresh');
}
// 不支持的平台必须置灰，而不是让用户点了才发现用不了。
// Unsupported platforms must grey the switch out rather than let the user discover it on click.
if (!/supported === false/.test(wgmUi) || !/dev-locked/.test(wgmUi)) {
  fail('the Windows game mode switch must grey out where the platform is unsupported');
}
if (!/typeof refreshWindowsGameModeState === 'function'/.test(panel)) {
  fail('input sync must refresh the Windows game mode state so the panel matches the real registry');
}
if (!/fxConsoleItem\('t-windowsGameMode'/.test(workspace)) {
  fail('the Windows game mode switch must be registered in a console group so it is reachable from the panel');
}
  if (!/className = 'fx-console-child-nest'/.test(workspace) || !/item\.child/.test(workspace)) {
    fail('the console child-subordinate mechanism must exist so switch parameters can nest under their toggle');
  }
  if (!/\.fx-console-child-nest/.test(css)) {
    fail('the child-subordinate container needs styling or nested parameters look like group peers');
  }
  // 从属块之后若还有独立开关（实验功能里是 Cuefield AutoMix），必须隔开：每个 fx-toggle 都会
  // 新建自己的 .fx-toggle-grid，所以分隔线要加在紧随其后的那个 grid 上，否则它看起来像第三个参数。
  // When a standalone switch follows a child block (Cuefield AutoMix in the experimental group), it
  // must be set apart: every fx-toggle opens its own .fx-console-toggle-grid, so the rule belongs on
  // the grid right after the nest or the switch reads as a third parameter of the block above.
  if (!/\.fx-console-child-nest \+ \.fx-toggle-grid/.test(css)) {
    fail('a standalone toggle after a child block needs a separator, or it looks like a nested parameter');
  }
  // 根因：基类 .fx-toggle-grid 是两列布局，两个开关会并排；从属块跟着哪个开关就说不清了。
  // 控制台里必须覆盖成单列。
  // Root cause: the base .fx-toggle-grid is two columns, so two switches sit side by side and a
  // following child block cannot be attributed to either. The console must force a single column.
  if (!/\.fx-console-toggle-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(css)) {
    fail('console toggle grid must be single-column, or switches with child parameters sit side by side');
  }
  // 光单列还不够：child 分支不清空 state.toggleGrid，Cuefield 会复用上一个 grid 追加到从属块之前。
  // 所以从属块之后遇到开关必须强制新建 grid。
  // Single column is not enough: the child branch leaves state.toggleGrid set, so the next switch
  // would be appended into the same grid above the nest. A switch after a nest must force a new grid.
  if (!/!state\.toggleGrid \|\| state\.childNest/.test(workspace)) {
    fail('a switch following a child block must start a fresh grid, or the separator can never match');
  }
  if (!/data-console-layout['"],\s*['"]task-first-v2/.test(workspace) && !/setAttribute\('data-console-layout', 'task-first-v2'\)/.test(workspace)) fail('visual console layout marker is missing');
  if (!/node\.parentNode === panel/.test(workspace)) fail('visual console old-shell cleanup can remove reparented controls');
  if (!/FX_CONSOLE_HISTORY_LIMIT\s*=\s*40/.test(workspace) || !/fxConsoleChangedKeys/.test(workspace)) fail('scoped session history guard is missing');
  if (!/home:\s*1[\s\S]*interface:\s*1[\s\S]*lyrics:\s*1[\s\S]*motion:\s*1[\s\S]*shelf:\s*1[\s\S]*system:\s*1/.test(panel)) fail('visual console tab allow-list is incomplete');
  if (!/\.fx-console-toolbar/.test(css) || !/\.fx-console-group/.test(css) || !/prefers-reduced-motion:reduce/.test(css)) fail('visual console layout or reduced-motion styles are missing');
  if (!/fxConsoleSearchHitDelayTimer/.test(workspace) || !/outline-offset:\s*-2px/.test(css) || !/\.bg-media-actions,[\s\S]{0,160}\.wallpaper-engine-actions/.test(css)) fail('visual console search highlight or background media responsive layout is missing');
  // 「背景星河」的归属：它是预设自带的背景层，不是通用粒子参数，必须留在 动效→基础画面，
  // 且不得再回到 粒子与光影。
  // 判据**真跑一遍布局数据**，而不是比两个分组 key 的先后位置。位置比对只能说明"这条声明夹在
  // 它们之间"：看不出重复声明（旧的留在基础画面组、再加一份到粒子组时，第一处仍在基础画面组，
  // 位置判据照样绿），也分不清"删掉了"和"挪进了别的分组"。而重复声明**不会报错**——
  // fxConsoleAppendItem 认到同一个 DOM 节点后只把别名拼起来，控件实际仍渲染在第一个分组里。
  // 这里把 fxConsoleLayout() 整段抽出来，在只提供 consoleWorkspaceText / fxConsoleItem 的沙箱里
  // 真调一次，直接问数据"这个控件在哪个标签页的哪个分组"，并且必须**恰好命中一次**。
  // 沙箱里没有词典，consoleWorkspaceText 会退回键名，所以断言标题等于 'fx_bg_galaxy' 就是断言
  // "标题取自这个键"。注释一律先剥掉，否则注释里的字样就能单独把判据满足。
  //
  // Where the background star river belongs: it is a preset-owned background layer rather than a
  // generic particle parameter, so it must sit in motion -> base and must not drift back into the
  // particle group. The check RUNS the layout data instead of comparing the positions of the two group
  // keys. Position only shows that a declaration sits between them: it cannot see a duplicate (with the
  // old one left in base and a second added to particles, the first occurrence is still inside base, so
  // the positional check stays green) and cannot tell "deleted" from "moved elsewhere". And a duplicate
  // is silent — fxConsoleAppendItem sees the same element, merges only the aliases, and the control
  // keeps rendering in the first group. The function is therefore extracted and really invoked in a
  // sandbox that only provides consoleWorkspaceText / fxConsoleItem, and the control must be found
  // exactly once. Without a dictionary in the sandbox, consoleWorkspaceText falls back to the key name,
  // so asserting the title equals 'fx_bg_galaxy' asserts which key it came from. Comments are stripped
  // first, or a matching comment alone would satisfy the check.
  const consoleStripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const workspaceCode = consoleStripComments(workspace);
  const panelCode = consoleStripComments(panel);
  const layoutStart = workspaceCode.indexOf('function fxConsoleLayout()');
  const layoutEnd = workspaceCode.indexOf('function fxConsoleResolveBlock');
  if (layoutStart < 0 || layoutEnd <= layoutStart) fail('fxConsoleLayout() cannot be evaluated');
  // 必须包一层函数：runInNewContext 按「脚本」求值，顶层 return 是语法错误。
  // The wrapper is required: runInNewContext evaluates a script, where a top-level return is illegal.
  const consoleTabs = vm.runInNewContext(
    '(function () {\n' + workspaceCode.slice(layoutStart, layoutEnd) + '\nreturn fxConsoleLayout();\n})()',
    {
      consoleWorkspaceText: (key, fallback) => (fallback == null ? key : String(fallback)),
      fxConsoleItem: (ref, title, aliases, history, child) => ({
        ref: ref, title: title, aliases: aliases || '', history: history !== false, child: child === true
      })
    }
  );
  const starRiverHits = [];
  consoleTabs.forEach(tab => (tab.groups || []).forEach(group => (group.items || []).forEach(item => {
    if (item.ref === 't-backgroundStarRiver') starRiverHits.push({ tab: tab.key, group: group.key, item: item });
  })));
  if (starRiverHits.length !== 1) {
    fail(`the console layout must declare the background star river exactly once, found ${starRiverHits.length}`);
  }
  const starRiverEntry = starRiverHits[0];
  if (starRiverEntry.tab !== 'motion' || starRiverEntry.group !== 'base') {
    fail(`the background star river must live in motion -> base, not in ${starRiverEntry.tab} -> ${starRiverEntry.group}`);
  }
  // 别名必须是**中文同义措辞**，不能再拼第二个词典键：曾经有个 fx_starfield，值与标题逐字相同，
  // 对搜索零增益（搜同一串字本来就命中标题），已合并掉。沙箱里 consoleWorkspaceText 返回键名本身，
  // 所以「别名里出现 fx_ 开头的词」就说明有人又把键拼进来了 —— 判据正好利用这一点。
  // The alias must hold Chinese synonyms and must not append a second dictionary key: a former
  // fx_starfield key duplicated the title verbatim and added nothing to search, so it was merged away.
  // In the sandbox consoleWorkspaceText returns the key name, so an `fx_` token in the aliases means a
  // key reference crept back in.
  if (starRiverEntry.item.title !== 'fx_bg_galaxy' || !/星空/.test(starRiverEntry.item.aliases)) {
    fail('the star river console item must be titled with the switch\'s own label and keep the Chinese synonyms as a search alias');
  }
  if (/fx_\w+/.test(starRiverEntry.item.aliases)) {
    fail('the star river search alias must not be assembled from a second dictionary key: ' + starRiverEntry.item.aliases);
  }
  // 旧特效面板（organizeFxPanel 走的降级路径）里，这个开关也不能再被歌词开关的 grid 收走。
  // The legacy panel (the degraded path behind organizeFxPanel) must not claim it for the lyric grid either.
  const lyricListStart = panelCode.indexOf('function ensureLyricPrimaryControls');
  const lyricListEnd = panelCode.indexOf('.forEach(function (id) { moveToggleToGrid(id, grid); })', lyricListStart);
  const lyricMoveList = lyricListStart > -1 && lyricListEnd > lyricListStart ? panelCode.slice(lyricListStart, lyricListEnd) : '';
  if (!/t-lyricVerticalFloat/.test(lyricMoveList) || /t-backgroundStarRiver/.test(lyricMoveList)) {
    fail('the legacy lyric switch grid must keep the lyric switches and must not claim the background star river');
  }
  const clarityButtonsReady = ['1', '2', '3', '4'].every(value => html.includes(`data-lyric-texture-clarity="${value}"`));
  const clarityLabelsReady = ['1×', '2×', '3×', '4×', '标清', '高清', '超清', '极致'].every(label => html.includes(label));
  const packagedDefaultsUseRuntimeDefaults = /PACKAGED_DEFAULT_FX_SNAPSHOT\s*=\s*Object\.freeze\(Object\.assign\(\{[\s\S]{0,180}visualPresetSchema:\s*VISUAL_PRESET_SCHEMA[\s\S]{0,120}\},\s*fxDefaults\)\)/.test(packagedDefaults);
  if (!/id="lyric-texture-quality-seg"/.test(html) || !clarityButtonsReady || !clarityLabelsReady || /data-lyric-texture-clarity="1\.(?:25|5)"/.test(html) || !/lyricTextureClarity:\s*1/.test(defaults) || !packagedDefaultsUseRuntimeDefaults || !defaultArchive.snapshot || defaultArchive.snapshot.lyricTextureClarity !== 1 || !/normalizeLyricTextureClarity/.test(persistence + archive + panel) || !/invalidateLyricQualityTextures\('texture-clarity-change'/.test(panel) || /scheduleStageLyricFullTrackWarmup\('texture-clarity-change'/.test(panel) || !/function lyricQualityPoolBudgetBytes/.test(maskTexture) || !/function makeLyricQualityTexture/.test(maskTexture) || !/function queueLyricRowQuality/.test(rowLayers) || !/qualityHotUntil/.test(rowLayers) || !/backgroundStarRiver'\s*,\s*'lyricTextureClarity'\s*,\s*\/\/ Append-only:[\s\S]{0,120}'lyricLiveViewportFit'/.test(archive)) fail('1x-4x visible-row lyric quality, persistence, cache budget, or append-only MR2 archive wiring is incomplete');
  if (!/function finalizeLyricQualitySelectionFrame/.test(rowLayers) || !/frameCandidates/.test(rowLayers) || !/function lyricQualityEffectiveBudgetBytes/.test(rowLayers) || !/qualityFallbackUntil/.test(rowLayers) || !/function pruneLyricQualityQueue/.test(rowLayers) || !/row\.qualityWanted !== true/.test(rowLayers) || !/lyricQualityEnsureCapacity\(job\.bytes[\s\S]{0,900}makeLyricQualityTexture/.test(rowLayers) || !/qualityRootPriority:\s*isCurrent \? 0 : 1000/.test(stageLyrics) || /qualityRetryAfter/.test(rowLayers) || !/fallbackHotUntil/.test(rowLayers) || !/release:\s*next <= 1/.test(panel)) fail('lyric quality global byte-aware selection, stale-job pruning, pre-render capacity check, or no-flash tier handoff is incomplete');
  const qualityCommitBody = rowLayers.slice(rowLayers.indexOf('function commitLyricRowQuality'), rowLayers.indexOf('function beginLyricQualitySelectionFrame'));
  if (!/frameCommits:\s*\[\]/.test(rowLayers) || !/function commitDeferredLyricQualityRows/.test(rowLayers) || !/lyricQualityState\.deferFinalize \|\| row\.qualityWanted !== true/.test(qualityCommitBody) || /discardLyricRowPendingQuality/.test(qualityCommitBody) || !/commitDeferredLyricQualityRows\(\)/.test(rowLayers) || !/function disposeLyricQualityOwner/.test(rowLayers) || !/__mineradioLyricQualityDisposed/.test(rowLayers) || !/disposeLyricQualityOwner\(lyricData\)/.test(starRiver) || !/qualityProjectedPoolBytes/.test(rowLayers) || !/function lyricQualityHasPendingTexture/.test(rowLayers)) fail('lyric quality deferred commit, disposed-owner cancellation, or bounded atomic tier replacement guard is incomplete');
  const fpsModesReady = ['vsync', '45', '60', '75', '90', '120'].every(value => html.includes(`data-foreground-fps="${value}"`));
  if (!fpsModesReady || !/function setForegroundFpsMode/.test(panel) || !/foregroundFpsMode/.test(persistence) || !/foreground-fps-seg/.test(workspace + css) || !/foregroundFpsMode:\s*'vsync'/.test(defaults) || !packagedDefaultsUseRuntimeDefaults) fail('default VSync and optional foreground FPS controls are incomplete');
  console.log('[OK] Six task tabs, explicit grouping, scoped history, safe DOM cleanup, search, and responsive styles are wired.');
}

function checkIdleGuideCanvasReleaseGuard() {
  logStep('Idle guide canvas release guard');
  const idleText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '09-idle-toast-libraries.js'), 'utf8');
  // 判据跑在剥掉注释的代码上：注释里出现函数名会让"不许出现某写法"这类判据误报。
  // Judgements run on comment-stripped code so a function name mentioned in prose cannot trip them.
  const idleCode = idleText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // 空闲引导画布只在可见期间被绘制（不可见时那一帧只清屏就返回），所以隐藏后必须把后备存储
  // 收回 1x1，否则一块全屏画布会一直占着，直到下次窗口 resize 才被重新撑开。
  // The idle guide canvas is only drawn while visible (the hidden branch just clears and returns),
  // so its backing store has to collapse to 1x1 on hide, otherwise a full-viewport canvas stays
  // allocated until the next window resize re-inflates it.
  if (!/function releaseIdleGuideCanvas\(/.test(idleCode)) {
    fail('the idle guide canvas must be releasable');
  }
  const releaseBlock = idleCode.slice(
    idleCode.indexOf('function releaseIdleGuideCanvas('),
    idleCode.indexOf('function resizeIdleGuideCanvas(')
  );
  if (!/idleGuideCanvas\.width = 1;/.test(releaseBlock) || !/idleGuideCanvas\.height = 1;/.test(releaseBlock)) {
    fail('the idle guide canvas backing store must collapse to 1x1 when hidden');
  }
  if (!/idleGuideParticles = \[\];/.test(releaseBlock)) {
    fail('the idle guide particle array must be dropped with the canvas');
  }
  const visibleBlock = idleCode.slice(
    idleCode.indexOf('function setIdleGuideVisible('),
    idleCode.indexOf('function releaseIdleGuideCanvas(')
  );
  if (!/releaseIdleGuideCanvas\(\);/.test(visibleBlock)) {
    fail('hiding the idle guide must release its canvas');
  }
  // 隐藏分支必须是幂等的、且不能只在状态翻转时执行：初始 idleGuideVisible 就是 false，
  // 若那一轮提前返回，画布会一直保持全屏尺寸。
  // The hidden branch has to be idempotent and must not run only on state flips: the initial
  // idleGuideVisible is already false, and an early return there leaves the canvas full-size.
  if (/if \(idleGuideVisible === show\) return;/.test(visibleBlock)) {
    fail('the idle guide visibility handler must not early-return on an unchanged state');
  }
  if (!/if \(!idleGuideCanvasReleased\) return;/.test(visibleBlock) || !/idleGuideCanvasReleased = false;/.test(visibleBlock)) {
    fail('showing the idle guide again must rebuild the canvas exactly once per hide/show cycle');
  }
  // 这条判据必须收窄到 resizeIdleGuideCanvas 内部：同一行文本也出现在 releaseIdleGuideCanvas 里，
  // 只在文件里全局搜一次的话，"resize 忘了挡"这种回归会被另一处相同写法蒙过去。
  // This judgement has to be scoped inside resizeIdleGuideCanvas: the very same line also appears in
  // releaseIdleGuideCanvas, so a whole-file search would let a "resize forgot to bail" regression
  // pass on the strength of the other copy.
  const resizeBlock = idleCode.slice(
    idleCode.indexOf('function resizeIdleGuideCanvas('),
    idleCode.indexOf('function projectIdleGuidePoint(')
  );
  if (!/if \(!idleGuideCanvas \|\| idleGuideCanvasReleased\) return;/.test(resizeBlock)) {
    fail('resizeIdleGuideCanvas must bail while the canvas is released, or a resize re-inflates it');
  }
  if (!/var idleGuideCanvasReleased = false;/.test(idleCode)) {
    fail('the idle guide release flag must start false');
  }
  console.log('[OK] The idle guide canvas releases its full-screen backing store while hidden and rebuilds it on show, resilient to the initial hidden state.');
}

function checkFirstLaunchDefaultsAndSplashGuard() {
  logStep('First-launch defaults and splash timing guard');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const packagedText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '05-packaged-fx-archive.js'), 'utf8');
  const archive = JSON.parse(fs.readFileSync(path.join(appRoot, 'public', 'default-user-fx-archive.json'), 'utf8'));
  const persistenceText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
  const fxArchiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const splashText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '03-splash.js'), 'utf8');
  const splashCode = splashText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const css = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
  const marker = 'var fxDefaults = ';
  const start = defaultsText.indexOf(marker);
  const end = defaultsText.indexOf('\n};', start);
  if (start < 0 || end < 0) fail('fxDefaults object cannot be inspected');
  const defaults = vm.runInNewContext(`(${defaultsText.slice(start + marker.length, end + 2)})`, Object.create(null));
  const snapshot = archive && archive.snapshot;
  const keys = Object.keys(defaults);
  const snapshotKeys = snapshot ? Object.keys(snapshot).filter(key => key !== 'visualPresetSchema') : [];
  const drift = keys.filter(key => !snapshot || JSON.stringify(snapshot[key]) !== JSON.stringify(defaults[key]));
  if (!snapshot || snapshotKeys.length !== keys.length || drift.length) {
    fail(`first-launch runtime and packaged archive defaults drifted: ${drift.join(', ') || 'key-count mismatch'}`);
  }
  const expectedCapturedDefaults = {
    depth: 0.2,
    lyricDisplayMode: 'cinema',
    lyricTranslationMode: 'multi',
    lyricFont: 'sans',
    lyricWeight: 750,
    controlGlassChromaticOffset: 50,
    playlistPanelGlassBlur: 14,
    playlistPanelGlassDensity: 0.55,
    performanceBackground: 'release',
    // 默认档位从 eco 提到 balanced：eco 的粒子预算系数只有 0.28，首启动就少七成粒子。
    // Default tier raised from eco to balanced: eco's particle budget factor is only 0.28.
    performanceQuality: 'balanced',
    memoryAutoSystemTrim: true,
    memorySystemAutoElevate: false,
    wallpaperFps: 60,
    shelfCameraMode: 'dynamic',
    shelfPresence: 'auto',
    // 两个视觉开关的默认值：溢光默认关、轮廓默认开。它们同时在打包快照里（上面的 drift 比对已覆盖），
    // 这里再单独钉一次，是为了让"顺手改默认值"必须先解释清楚，而不是悄悄跟着快照一起漂走。
    // The two visual switch defaults: bloom off, edge on. The packaged snapshot is already covered by
    // the drift comparison above; pinning them here as well forces any future flip to be deliberate.
    edge: true,
    bloom: false
  };
  const capturedDrift = Object.keys(expectedCapturedDefaults).filter(key => JSON.stringify(defaults[key]) !== JSON.stringify(expectedCapturedDefaults[key]));
  if (capturedDrift.length || archive.exportedAt !== 1784607916226 || archive.savedAt !== 1784607916226) {
    fail(`captured first-launch settings identity drifted: ${capturedDrift.join(', ') || 'timestamp'}`);
  }
  // 存档读取的缺键方向：bloom 默认关，缺键就该是 false（`=== true`）；edge 默认开，缺键就该是 true
  //（`!== false`）。两处都写成同一个方向时，旧存档会静默拿到与当前默认相反的值——正是这次要修的坑。
  // 判据必须先剥注释：说明文字里同时出现了两种写法，直接匹配原文会被自己的注释满足。
  // Missing-key direction in the archive readers: bloom defaults off, so a missing key has to read
  // false (`=== true`); edge defaults on, so it has to read true (`!== false`). Forcing both in one
  // direction hands old saves the opposite of the current default — the bug this change fixes.
  // Comments are stripped first because the comment above spells out both spellings.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const persistenceCode = stripComments(persistenceText);
  const fxArchiveCode = stripComments(fxArchiveText);
  if (!/bloom:\s*raw\.bloom === true/.test(persistenceCode) || !/edge:\s*raw\.edge !== false/.test(persistenceCode)) {
    fail('autosave read must treat a missing bloom as off and a missing edge as on, matching the defaults');
  }
  if (!/bloom:\s*!!raw\.bloom/.test(fxArchiveCode) || !/edge:\s*raw\.edge !== false/.test(fxArchiveCode)) {
    fail('preset archive read must follow the same missing-key direction as the autosave read');
  }
  if (!/PACKAGED_DEFAULT_FX_SNAPSHOT\s*=\s*Object\.freeze\(Object\.assign\(\{[\s\S]{0,180}visualPresetSchema:\s*VISUAL_PRESET_SCHEMA[\s\S]{0,120}\},\s*fxDefaults\)\)/.test(packagedText)) {
    fail('packaged first-launch snapshot must inherit the synchronized runtime defaults');
  }
  if (!/function splashTimelineElapsed\(elapsed\)\s*\{\s*return elapsed;\s*\}/.test(splashText)
    || /elapsed\s*\*\s*3\.32/.test(splashText)
    || !/setTimeout\(markSplashReadyToEnter,\s*650\)/.test(splashText)
    || !/setTimeout\(markSplashReadyToEnter,\s*1500\)/.test(splashText)
    || !/\.splash-word-mine\s*\{[\s\S]{0,160}animation:\s*splash-mine-in 5200ms/.test(css)
    || !/\.splash-word-radio\s*\{[\s\S]{0,420}animation:\s*splash-radio-in 5200ms/.test(css)
    || !/\.splash-word-i::after\s*\{[\s\S]{0,480}animation:\s*splash-i-dot-pop 4200ms/.test(css)
    || !/\.splash-signal-line\s*\{[\s\S]{0,500}animation:\s*splash-signal-line 4200ms/.test(css)
    || !/\.splash-signal-line::after\s*\{[\s\S]{0,420}animation:\s*splash-signal-blip 4200ms/.test(css)
    || !/\.splash-sub\s*\{[\s\S]{0,260}animation:\s*splash-sub-in 4200ms/.test(css)) {
    fail('public-repo splash motion speed and the independent fast click-entry gate must stay decoupled');
  }
  if (!/\.user-archive-toolbar\s*\{[\s\S]{0,220}display:\s*grid;[\s\S]{0,160}grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css)
    || !/\.user-archive-tools\s*\{[\s\S]{0,180}display:\s*grid;[\s\S]{0,160}grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(css)
    || !/\.user-archive-tools \.fx-mini-btn\s*\{[\s\S]{0,180}width:\s*100%;[\s\S]{0,160}white-space:\s*nowrap/.test(css)) {
    fail('user archive actions must stay in one balanced three-column row');
  }
  // 启动画面结束后必须释放渲染资源：它不会重播，否则一个活的 WebGL 上下文 + 一块全屏画布
  // 会一直占着内存。关键是"两条收尾路径都要释放"，且释放后 resize 不能把它重新撑回来。
  // The splash must release its render resources once gone: it never replays, so a live WebGL
  // context plus a full-viewport canvas would stay allocated forever. Both dismissal paths have to
  // release, and a later resize must not re-inflate what was released.
  if (!/function releaseSplashRenderResources\(/.test(splashCode)) {
    fail('the splash must release its render resources on dismissal');
  }
  const releaseBlock = splashCode.slice(
    splashCode.indexOf('function releaseSplashRenderResources('),
    splashCode.indexOf('function dismissSplash(')
  );
  if (!/WEBGL_lose_context/.test(releaseBlock) || !/loseContext\(\)/.test(releaseBlock)) {
    fail('the splash WebGL context must be explicitly released, not just dereferenced');
  }
  if (!/removeEventListener\('resize', splashResizeHandler\)/.test(releaseBlock)) {
    fail('the splash resize listener must be removed, otherwise a resize re-inflates the canvas');
  }
  if (!/splashCanvas\.width = 1;/.test(releaseBlock) || !/splashCanvas\.height = 1;/.test(releaseBlock)) {
    fail('the splash canvas backing store must collapse to 1x1 on release');
  }
  const releaseCalls = (splashCode.match(/releaseSplashRenderResources\(\);/g) || []).length;
  if (releaseCalls < 2) {
    fail(`both splash dismissal paths must release resources (found ${releaseCalls} release call)`);
  }
  if (!/function resize\(\) \{\s*if \(splashResourcesReleased\) return;/.test(splashCode)) {
    fail('the splash resize handler must bail out after release');
  }
  // 释放标志必须在 IIFE 之前赋值：resize() 在模块执行期就跑过一次，靠 var 提升读到的会是
  // undefined，语义含糊。
  // The release flag must be assigned before the IIFE because resize() already runs during module
  // evaluation and would otherwise read a hoisted undefined.
  if (splashCode.indexOf('var splashResourcesReleased = false;') > splashCode.indexOf('(function initMineradioSplashCanvas()')) {
    fail('the splash release flag must be declared before the splash canvas IIFE');
  }
  console.log(`[OK] ${keys.length} captured defaults match; splash motion is 5.2s/4.2s while entry stays ready at 1.5s/0.65s; archive actions stay in one row; splash releases its GL context and canvas on dismissal.`);
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

async function main() {
  console.log(`App root: ${appRoot}`);
  runNodeSyntaxCheck(jsCheckFiles());
  runPlaybackAudioGraphRegressionCheck();
  runPlaybackSourceFallbackTransactionCheck();
  runPlaybackSingleRepeatLoopRegressionCheck();
  runLocalMusicLibraryRegressionCheck();
  runBuiltInPlaylistRegressionCheck();
  runServerModuleRelocationCheck();
  runWallpaperEngineIdleDisposeRegressionCheck();
  runWallpaperEngineMinimizeResidentRegressionCheck();
  runWallpaperEngineWin10YellowBorderRegressionCheck();
  runGestureCameraPermissionRegressionCheck();
  runGesturePlayerActionsRegressionCheck();
  runGestureRuntimeLifecycleRegressionCheck();
  runCuratedVisualPresetsRegressionCheck();
  runVisualClarityAndPortraitFullscreenRegressionCheck();
  runParticlePopulationBudgetRegressionCheck();
  runQQVipEntitlementRegressionCheck();
  runLoginEasterEggGateRegressionCheck();
  runQishuiProviderDistributionRegressionCheck();
  runProviderRemovalDiyCinemaRegressionCheck();
  runVisualPerformanceControlsRegressionCheck();
  runPlatformAccountSyncGuardCheck();
  runHomeDailyRecommendationRegressionCheck();
  // 注册守卫必须排在 parseCombinedIndexModules 之前：后者会对每条注册做 readFileSync，
  // 一旦有"注册了但文件不存在"就会先抛 ENOENT 栈，本函数的 missingFiles 判据便永远轮不到执行
  // （那会让它变成一条不可能失败的检查）。
  // The registration guard runs BEFORE the combined parse: the parse readFileSyncs every entry, so a
  // registered-but-absent path would blow up with an ENOENT stack first and this function's
  // missingFiles judgement would never be reached — i.e. it would be a check that cannot fail.
  checkIndexModuleRegistrationGuard();
  parseCombinedIndexModules();
  scanForbiddenMarkers();
  checkMainWindowChrome();
  checkBackgroundTransparencyControlsGuard();
  checkWallpaperEngineImportGuard();
  checkDesktopWallpaperModeGuard();
  checkDesktopWindowAdaptationGuard();
  checkLyricLayoutRangeGuard();
  checkPointerLockPermission();
  checkProgressSeekDragGuard();
  checkLyricBackfaceMaterialGuard();
  checkLyricScrollPerformanceGuard();
  checkPersistentCacheStorageGuard();
  checkExternalUpdatePageBridgeGuard();
  checkLyricTranslationCompletenessGuard();
  checkLyricVerticalFloatToggleGuard();
  checkQishuiProviderGuard();
  checkCustomSourceGuard();
  checkSpotifyProviderSurface();
  checkPlaybackControlBadgesGuard();
  await checkProviderFallbackTerminalStateGuard();
  checkSearchGlassEntranceGuard();
  checkProviderEntitlementBoundaryGuard();
  checkQQVipStatusSyncGuard();
  await checkProviderAuthCookiePathGuard();
  checkPlaybackResumeRecoveryGuard();
  checkAudioOutputWorkflowPanelGuard();
  checkVolumeWheelStepGuard();
  checkNonCurrentAudioPrefetchGuard();
  checkCuefieldAutoMixGuard();
  checkAlbumDetailGaplessGuard();
  checkInternalBetaPackagingGuard();
  checkSonicTopographyPresetGuard();
  checkLongPressReorderGuard();
  checkPlaylistPanelTriggerGuard();
  checkFullscreenToolsRowGuard();
  checkBeatAnalysisToggleGuard();
  checkCloseBehaviorDefaultGuard();
  checkUpdateManifestGuard();
  checkProviderRegistryGuard();
  checkPlaylistMultiselectGuard();
  checkPanelRowOverflowGuard();
  checkShuffleQueueOrderGuard();
  await checkLargePlaylistVirtualizationGuard();
  checkFirstLaunchDefaultsAndSplashGuard();
  checkIdleGuideCanvasReleaseGuard();
  checkWorkflowGatingHonestyGuard();
  checkFxConsoleWorkspaceGuard();
  if (runElectron) {
    runElectronRuntimeCheck();
    runMainStartupRecoveryCheck();
  }
  else console.log('\n== Electron runtime smoke check ==\n[SKIP] Fast/static mode. Re-run with --electron, or npm run check:quick -- --electron.');
}

main().then(function () {
  console.log('\nAll checks passed.');
}).catch(function (error) {
  console.error(`\n[FAIL] ${error.message || error}`);
  process.exit(1);
});
