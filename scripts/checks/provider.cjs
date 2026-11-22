'use strict';

// 检查函数从原 scripts/quick-check.js **原样搬出**，断言一条未改。
const env = require('./env.cjs');
const {
  readAllCssFiles,
  readVisualArchiveText,
  rel,
  providerRegistrySourceText,
  logStep,
  fail,
  supportedLangs,
  playlistProviderOrder,
  mergedPlaylistSources,
  hasAllItems,
  langLabels,
  requireLocaleKeys,
  fs,
  path,
  vm,
  appRoot,
  BASE_PLAYLIST_PROVIDERS,
  BASE_PLAYLIST_MERGES,
} = env;

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
  const cssText = readAllCssFiles();
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
  const cssText = readAllCssFiles();
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
  if (!/search: tokenConfigured \|\| webSession \|\| QISHUI_PUBLIC_ENABLED/.test(qishuiText) || !/loggedIn: webSession/.test(qishuiText) || !/请用汽水音乐 App 扫描 Mineradio 中的汽水官方二维码/.test(qishuiText)) {
    fail('Qishui status must keep public catalogue readiness separate from an authenticated Passport Web session');
  }
  // 扫码提示必须指向汽水音乐 App：实测用抖音扫码会被引导「去汽水音乐 App 扫码」，照原文案做只会绕一圈。
  // The prompt must name the Qishui Music app: Douyin sends users to Qishui, so naming Douyin just
  // makes them take a detour.
  if (/抖音 App 扫描|抖音 App 扫码/.test(qishuiText)) {
    fail('Qishui prompts must not tell users to scan with the Douyin app');
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
  if (!/官方扫码 \/ 汽水音乐确认/.test(indexText) || /本地会话 \/ PC 客户端/.test(indexText)) {
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
  const mergedSources = mergedPlaylistSources(playlistShellText);
  if (!/qishuiPlaylists/.test(coreStoreText) || !/if \(provider === 'qishui'\) return '\/api\/qishui\/user\/playlists'/.test(playlistShellText) || !hasAllItems(mergedSources, BASE_PLAYLIST_MERGES)) {
    fail('playlist panel refresh must merge Qishui playlists with the other providers');
  }
  // 平台切换器取代分组标题后，原来的 pl_qishui_playlist 词条不再被引用（已删除）。
  // 这里改为检查更直接的证据：汽水必须出现在切换器的平台顺序表里，否则它在面板里根本没有入口。
  // With the group headings gone that copy key no longer exists; assert the stronger fact instead —
  // qishui must appear in the switcher's provider order, or it has no entry in the panel at all.
  if (!/normalizePlaylistProvider/.test(playlistDetailText) || !/\/api\/qishui\/playlist\/tracks/.test(playlistDetailText) || !/qishui:' \+ id/.test(playlistDetailText) || !hasAllItems(playlistProviderOrder(playlistDetailText), BASE_PLAYLIST_PROVIDERS)) {
    fail('playlist panel detail must open and play Qishui playlists via the Qishui endpoint');
  }
  requireLocaleKeys('pl_page_prev', 'pl_page_next');
  // 第三条原先断言的是 `playlistQueuePageUrl` 里的调用 —— 那个函数是死代码（无人调用），已删。
  // 现在断言真正在用的取页路径：hydratePlaylistQueueNextPage → fetchPlaylistTracksPage(source.provider…)。
  if (!/function playlistQueueSource/.test(playlistLoadText) || !/raw\.indexOf\('qishui:'\)/.test(playlistLoadText) || !/fetchPlaylistTracksPage\(source\.provider/.test(playlistLoadText)) {
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
  const cssText = readAllCssFiles();
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
  const gitignoreText = fs.readFileSync(path.join(appRoot, '.gitignore'), 'utf8');
  if (!/SPOTIFY_SEARCH_LIMIT_MAX\s*=\s*10/.test(spotifyText) || !/client_credentials/.test(spotifyText) || !/SPOTIFY_CLIENT_ID/.test(spotifyText) || !/SPOTIFY_CLIENT_SECRET/.test(spotifyText) || !/cleanPath/.test(spotifyText)) {
    fail('Spotify bridge must use backend client credentials and keep the official search limit guard');
  }
  if (!/playbackMode:\s*'recommend-match'/.test(spotifyText) || !/provider_limited/.test(spotifyText) || !/handleSpotifySongUrl/.test(spotifyText) || !/handleSpotifyLyric/.test(spotifyText)) {
    fail('Spotify must stay a metadata/search match source, not a fake direct audio provider');
  }
  // server.js 的路由和 desktop/main.js 的 PKCE 链路都直接调用 spotify-api 的导出函数，
  // 这些标识符必须从 require 的解构块里取。两个文件此前都只解构了 clearSpotifyToken，
  // 于是 /api/spotify/* 全是 500、IPC 「检测回调」抛 ReferenceError。
  // Both server.js routes and the desktop PKCE flow call spotify-api exports directly, so
  // each name has to appear in that file's destructuring block. Both files used to import
  // only clearSpotifyToken, which turned every Spotify path into a ReferenceError.
  const spotifySpriteNames = Array.from(new Set(
    (serverText + '\n' + desktopMainText).match(/\b(?:handle|save|get|build|exchange|clear|create)Spotify[A-Za-z]+\b/g) || []
  )).filter(name => new RegExp('^\\s*' + name + ',?\\s*$', 'm').test(spotifyText));
  const assertSpotifyImports = (label, sourceText, blockPattern) => {
    const uses = spotifySpriteNames.filter(name => new RegExp('\\b' + name + '\\b').test(sourceText));
    const block = (sourceText.match(blockPattern) || [])[1] || '';
    const missing = uses.filter(name => !new RegExp('\\b' + name + '\\b').test(block));
    if (missing.length) {
      fail(label + ' must destructure every Spotify helper it calls; missing: ' + missing.join(', '));
    }
  };
  assertSpotifyImports('server/server.js', serverText, /const\s*\{([\s\S]*?)\}\s*=\s*require\('\.\/spotify-api'\);/);
  assertSpotifyImports('desktop/main.js', desktopMainText, /const\s*\{([\s\S]*?)\}\s*=\s*require\('\.\.\/server\/spotify-api'\);/);
  const desktopSpotifyText = fs.readFileSync(path.join(appRoot, 'desktop', 'spotify-login.js'), 'utf8');
  if (!/require\('\.\/spotify-api'\)/.test(serverText) || !/\/api\/spotify\/status/.test(serverText) || !/\/api\/spotify\/config/.test(serverText) || !/\/api\/spotify\/setup\/diagnostics/.test(serverText) || !/\/api\/spotify\/search/.test(serverText) || !/\/api\/spotify\/song\/url/.test(serverText) || !/\/api\/spotify\/lyric/.test(serverText)) {
    fail('server.js must route Spotify status/config/setup diagnostics/search/song-url/lyric through the backend bridge');
  }
  if (!/tag-source\.spotify/.test(cssText) || !/spotify-source/.test(cssText)) {
    fail('Spotify source badges must be visible in the UI');
  }
  // 搜索栏的 SP 页签已刻意移除：Spotify 搜索受 Premium 限制，单平台页签只会是空白页。
  // 结果仍然进「全部」合并，所以这里反向守住「不要再加回来」。
  // The standalone SP tab was removed on purpose: Premium-gated search makes a per-platform
  // tab permanently empty. Spotify still merges into "All", so guard against re-adding it.
  if (/search-mode-spotify/.test(indexText) || /search-mode-spotify/.test(searchText)) {
    fail('the Spotify search tab must stay removed; Spotify results belong in the All tab');
  }
  // 音质文案已全部改走 i18n（quality_spotify_match），源码里不会再出现字面 "Spotify"。
  // 因此这里断言"必须引用那个文案键"，而不是断言品牌名字面量 —— 语义一样，还更严：
  // 键名写错或漏翻译都会被抓到。
  // Quality copy now goes through i18n (quality_spotify_match), so the literal word "Spotify"
  // no longer appears in source. Assert the copy key instead of the brand string: same intent,
  // and stricter, because a typo'd or missing key fails here.
  if (!/PLAYBACK_QUALITY_DEFAULTS[\s\S]*spotify:\s*'standard'/.test(coreStoreText) || !/spotify:\s*\[[^\]]*quality_spotify_match/.test(coreStoreText)) {
    fail('Spotify must be represented as a standard match-source quality option');
  }
  if (!/provider === 'spotify'/.test(qualityText) || !/return playbackOutputText\('quality_spotify_match'\)/.test(qualityText) || !/return 'SP'/.test(qualityText)) {
    fail('playback quality UI must label Spotify as a match source');
  }
  // 搜索端点不再硬编码在 07-search.js 里，而是由 provider 注册表给出。
  // 断言要落在注册表上，否则会误报"搜索没接 Spotify"。
  // Search endpoints now come from the provider registry instead of being hardcoded in
  // 07-search.js, so the "Spotify search is wired" assertion has to check the registry.
  const providerRegistryText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '16-provider-registry.js'), 'utf8');
  if (!/songProviderKey\(song\)[\s\S]*spotify/.test(searchText) || !/searchPath:\s*'\/api\/spotify\/search'/.test(providerRegistryText) || !/mergeSongSearchResults\(neteaseSongs, qqSongs, kugouSongs, qishuiSongs, spotifySongs/.test(searchText)) {
    fail('frontend search must include Spotify in source tags, provider search, and All merge');
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
  const desktopSpotify = desktopMainText + '\n' + desktopSpotifyText;
  // 内置客户端把默认回调从 43879/callback 换成 5588/login；旧自定义 Client ID 的
  // 43879/callback 仍按兼容路径处理，守卫只需确认默认回调是 loopback 且校验函数还在。
  // The bundled client moved the default callback to 5588/login; stale custom-client
  // redirects to 43879/callback stay a compatibility path, not the pinned default.
  if (!/SPOTIFY_LOGIN_PARTITION/.test(desktopSpotify) || !/openSpotifyMusicLoginWindow/.test(desktopSpotify) || !/verifySpotifyOAuthCallbackEndpoint/.test(desktopSpotify) || !/spotify-music-open-login/.test(desktopMainText) || !/spotify-music-verify-setup/.test(desktopMainText) || !desktopSpotify.includes('shell.openExternal(authUrl)') || !/SPOTIFY_OAUTH_TIMEOUT_MS/.test(desktopSpotify) || !/SPOTIFY_TOKEN_FILE/.test(desktopMainText) || !(spotifyText + desktopSpotify).includes('127.0.0.1:5588/login')) {
    fail('desktop main must provide system-browser PKCE, a verified loopback callback, bounded timeout, and userData token storage');
  }
  if (!/openSpotifyMusicLogin/.test(desktopPreloadText) || !/verifySpotifyMusicSetup/.test(desktopPreloadText) || !/clearSpotifyMusicLogin/.test(desktopPreloadText)) {
    fail('desktop preload must expose Spotify login, callback verification, and clear-login IPC bridges');
  }
  // 授权地址必须能回到界面：浏览器被默认浏览器吞掉或没抢到前台时，那一行链接是唯一出路。
  // The authorize URL must reach the UI: when the browser never surfaces, that link is the only
  // way for the user to finish the flow.
  if (!/onSpotifyOAuthUrl/.test(desktopPreloadText) || !/openSpotifyAuthUrl/.test(desktopPreloadText) || !/spotify-music-open-auth-url/.test(desktopMainText) || !/spotify-music-oauth-url/.test(desktopSpotify) || !/spotify-setup-auth-url/.test(indexText)) {
    fail('Spotify authorize URL must be published to the renderer and reopenable from the setup card');
  }
  // 兜底行的按钮必须跟卡片按钮共用同一套规则，否则会退回浏览器默认的白底按钮。
  // The fallback row's buttons must share the card button rules, or they fall back to the
  // browser's white default button inside a dark modal.
  if (!/\.spotify-setup-card-actions button,\s*\.spotify-setup-auth-url-actions button/.test(cssText)) {
    fail('Spotify authorize-URL fallback buttons must reuse the setup-card button styling');
  }
  if (!/login-provider-spotify/.test(indexText) || !/account-source-dot\.spotify/.test(cssText)) {
    fail('Spotify must stay visible in the login modal and the top account capsule');
  }
  if (!/spotifyLoginStatus/.test(coreStoreText) || !/spotifyPlaylists/.test(coreStoreText) || !/refreshSpotifyLoginStatus/.test(loginStatusText) || !/openSpotifyWebLogin/.test(loginFlowText) || !/clearSpotifyMusicLogin/.test(userModalText)) {
    fail('frontend account state must include Spotify status, OAuth flow, playlists, and logout');
  }
  // 429 不是登出。限流必须走冷却：状态接口带 rateLimited/retryAfterSeconds，前端不得因为
  // 限流清空歌单或弹「已登出」，否则用户会被推去反复重新授权，而重新授权解不了限流。
  // A 429 is not a logout. Throttling must cool down: status carries rateLimited /
  // retryAfterSeconds, and the front end must not wipe playlists or toast "logged out".
  if (!/spotifyRateLimitSnapshot/.test(spotifyText) || !/rateLimited: !!rateLimit\.rateLimited/.test(spotifyText) || !/if \(!spotifyLoginStatus\.rateLimited\)/.test(loginStatusText) || !/scheduleSpotifyRateLimitRetry/.test(loginFlowText)) {
    fail('Spotify 429 must open a cooldown and must not be reported as a lost login');
  }
  // 固定 120 秒上限会让"冷却结束→探一次→又 429"无限循环。连续 429 必须指数退避到半小时，
  // 卡片角标也必须显示"限流等待中"而不是"进行中"，否则看着就是卡死。
  // A flat cap turns into a treadmill; consecutive 429s must back off exponentially, and the step
  // badge must say "rate limited" instead of "in progress" or it reads as a frozen spinner.
  if (!/SPOTIFY_RATE_LIMIT_MAX_COOLDOWN_MS = 30 \* 60 \* 1000/.test(spotifyText) || !/Math\.pow\(2, strikes - 1\)/.test(spotifyText) || !/login_spotify_rate_limited_short/.test(loginFlowText)) {
    fail('Spotify rate limiting must back off exponentially and label the step as rate limited');
  }
  // 状态接口不得把 /v1/me 当探测手段（Folia 的 login_status 也是零网络读本地会话）。
  // 共享 Client ID 下这条路径从第一个请求就 429，每次都等它等于每分钟烧一次配额。
  // Status must not use /v1/me as a probe: under the shared client id that path answers 429 from
  // the very first request, so awaiting it burns the quota on every poll.
  if (!/refreshSpotifyProfileInBackground/.test(spotifyText) || !/SPOTIFY_PROFILE_CACHE_TTL_MS = 10 \* 60 \* 1000/.test(spotifyText) || !/cacheStale && !rateLimit\.rateLimited/.test(spotifyText)) {
    fail('Spotify status must serve the cached profile and refresh it in the background, never await /v1/me');
  }
  if (!/tokenFileExists/.test(spotifyText) || !/credentialsFileExists/.test(spotifyText) || !/localConfigMissing/.test(spotifyText) || !/fs\.existsSync/.test(spotifyText)) {
    fail('Spotify status must distinguish configured paths from real local token/credential files');
  }
  // 第二条通道：读数据必须走 pathfinder / spclient（Spotify 自家客户端的路），
  // 而不是 public Web API —— 共享 Client ID 下那条路从第一个请求就 429，再怎么退避也治不好。
  // The second channel: reads go through pathfinder / spclient, the services Spotify's own
  // clients use, not the public Web API that 429s from the first request under the bundled id.
  const partnerPath = path.join(appRoot, 'server', 'spotify-partner.js');
  if (!fs.existsSync(partnerPath)) fail('server/spotify-partner.js must exist as the pathfinder/spclient channel');
  const partnerText = fs.readFileSync(partnerPath, 'utf8');
  if (!/api-partner\.spotify\.com\/pathfinder\/v2\/query/.test(partnerText) || !/spclient\.wg\.spotify\.com/.test(partnerText)
    || !/persistedQuery/.test(partnerText) || !/sha256Hash/.test(partnerText)) {
    fail('the Spotify partner channel must use the persisted-query endpoint and spclient');
  }
  for (const query of ['profileAttributes', 'libraryV3', 'fetchLibraryTracks', 'fetchPlaylist', 'getAlbum', 'searchTracks', 'areEntitiesInLibrary']) {
    if (!new RegExp(query + ": '[0-9a-f]{64}'").test(partnerText)) fail('the Spotify partner channel is missing the ' + query + ' query hash');
  }
  // 通道的客户端身份必须像浏览器：自造 UA 配裸 https.request，Spotify 网关会按"脚本流量"
  // 限流（429 + 十几秒 Retry-After），跟账号配额无关 —— 同一个令牌在 spclient 的歌词接口上
  // 完全正常。所以 pathfinder 必须走 fetch（undici）并带浏览器 UA。
  // The channel must present itself like a browser: a made-up UA over a bare https.request is
  // throttled as script traffic (429 with a ten-something second Retry-After) regardless of the
  // account quota, while the same token works on spclient's lyrics endpoint.
  if (!/async function partnerRequestJson/.test(spotifyText) || !/requestJson: partnerRequestJson/.test(spotifyText)) {
    fail('the Spotify partner channel must issue its requests through fetch, not a bare https.request');
  }
  if (!/Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36/.test(partnerText) || /'User-Agent'\s*:\s*'Mineradio\//.test(partnerText)) {
    fail('the Spotify partner channel must present a browser User-Agent');
  }
  if (!/createSpotifyPartner/.test(spotifyText) || !/withSpotifyPartner/.test(spotifyText) || !/SPOTIFY_PARTNER_RETIRED/.test(spotifyText)) {
    fail('spotify-api.js must route through the partner channel and fall back when a query is retired');
  }
  if (!/function spotifyRateLimitGate\(\)/.test(spotifyText) || !/if \(spotifyPartnerUsable\(\)\) return \{ rateLimited: false/.test(spotifyText)) {
    fail('the Web API cooldown must not gate the partner channel');
  }
  // 自检与歌单读取必须先把 pathfinder 摆在前面，否则一次 429 就把四步全锁死。
  // Diagnostics and playlist reads must try pathfinder first, or a single 429 locks all four steps.
  if (!/withSpotifyPartner\(\s*'diagnostics\.library'/.test(spotifyText) || !/withSpotifyPartner\(\s*'diagnostics\.playlists'/.test(spotifyText) || !/withSpotifyPartner\('playlists'/.test(spotifyText)) {
    fail('Spotify diagnostics and playlist listing must go through the partner channel first');
  }
  // 远程播放：客户端出声，MR 只镜像时间轴。换源/跳歌必须在远程曲目上短路，
  // 否则"客户端已经放了、MR 却把这首跳掉"的老毛病会回来。
  // Remote playback: never switch source or skip a track that the official client owns.
  const cdpPath = path.join(appRoot, 'server', 'spotify-cdp.js');
  if (!fs.existsSync(cdpPath)) fail('server/spotify-cdp.js must exist as the local client state bridge');
  const cdpText = fs.readFileSync(cdpPath, 'utf8');
  // 控制客户端的那一半整体收在 PillagerSpotify 部件里，只有一个顶层声明。
  // The client-control half lives inside the PillagerSpotify component, one top-level declaration.
  const remoteText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', 'pillager-spotify.js'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  if (!/Runtime\.evaluate/.test(cdpText) || /api\.spotify\.com\/v1/.test(cdpText)) {
    fail('the Spotify CDP bridge must read the local page through Runtime.evaluate, not the Web API');
  }
  const spotifyProbeText = fs.readFileSync(path.join(appRoot, 'desktop', 'spotify-client-probe.js'), 'utf8');
  if (!/--remote-debugging-port=/.test(spotifyProbeText)) {
    fail('Mineradio must be able to launch the Spotify client with its debug port');
  }
  // 端口必须是每次随机挑的：固定 9222 等于把"本机任意进程都能接手播放"写在命令行上。
  // The port must be random per launch — a fixed 9222 hands local control to any process.
  if (!/function pickDebugPort/.test(spotifyProbeText) || /remote-debugging-port=9222/.test(spotifyProbeText)) {
    fail('the Spotify debug port must be randomised per launch, never the well-known 9222');
  }
  if (!/function readSavedDebugPort/.test(spotifyProbeText) || !/function saveDebugPort/.test(spotifyProbeText)) {
    fail('the chosen Spotify debug port must be remembered so a restart reconnects to the same instance');
  }
  // 拉起的客户端只出声、不露脸：少数客户端版本会在首帧自己 ShowWindow，挂一块黑布在桌面上
  // （issue #1）。守卫必须在 launch 里挂上，且只能用异步的 ShowWindowAsync。
  // The client MR spawns must not leave a window on screen; only the async minimise call is safe.
  if (!/suppressClientWindow\(\)/.test(spotifyProbeText) || !/ShowWindowAsync/.test(spotifyProbeText)) {
    fail('the Spotify client window must be minimised after launch, through ShowWindowAsync only');
  }
  // 桥的每个方法先验 nonce；注入源码只能通过 IIFE 实参传值，不能在函数体里出现字面量。
  // Every bridge method checks the nonce, and the value is only ever an IIFE argument.
  if (!/buildBridgeSource/.test(cdpText) || !/ensureBridgeNonce/.test(cdpText)) {
    fail('the Spotify bridge must be injected with a per-process nonce, not as a static script');
  }
  if (!/\/api\/spotify\/client\/state/.test(serverText) || !/\/api\/spotify\/client\/command/.test(serverText) || !/\/api\/spotify\/client\/launch/.test(serverText)) {
    fail('server.js must expose the Spotify client state, command and launch routes');
  }
  if (!/playback-progressbar/.test(cdpText) || !/getOwnPropertyDescriptor\(HTMLInputElement\.prototype/.test(cdpText)) {
    fail('the CDP bridge must read and drive the progress range input');
  }
  if (!/silent WAV|spotifyRemoteSilentWavUrl/.test(remoteText) || !/clearInterval/.test(remoteText)) {
    fail('the remote playback clock must use a silent WAV and clean up its polling timer');
  }
  if (!/08-account\/pillager-spotify\.js/.test(loaderText)) {
    fail('pillager-spotify.js (the PillagerSpotify component) must be registered in index-loader.js');
  }
  if (!/song\.spotifyRemote\) return true/.test(fallbackText) || !/SpotifyRemote\.playbackData\(song\)/.test(playbackText)) {
    fail('Spotify remote tracks must bypass source fallback and use the remote playback data');
  }
  if (!/data\.directUrl \? data\.url/.test(playbackText)) {
    fail('the silent clock blob must bypass the /api/audio proxy');
  }
  // 点播必须走"搜索 + 点结果行"。退回 spotify: 协议只有**每次页面加载后的第一次**会成功，
  // 也就是第二首开始全部静默失败 —— 这条守卫就是防止有人为了省事把它改回去。
  // Point-play must drive the search UI; spotify: navigation works only once per page load.
  if (!/function pickRowExpression/.test(cdpText) || !/Input\.insertText/.test(cdpText) || !/Input\.dispatchMouseEvent/.test(cdpText)) {
    fail('the CDP bridge must play a track by typing into search and clicking a result row');
  }
  if (/location\.assign\(/.test(cdpText)) {
    fail('never play a track by navigating to a spotify: URI — only the first navigation per page load works');
  }
  if (!/SPOTIFY_CDP_PLAY_UNCONFIRMED/.test(cdpText) || !/function trackMatches/.test(cdpText)) {
    fail('point-play must confirm the client really switched before reporting success');
  }
  if (!/\/api\/spotify\/client\/play-track/.test(serverText) || !/spotifyCdp\.playTrack\(/.test(serverText)) {
    fail('server.js must expose /api/spotify/client/play-track backed by spotifyCdp.playTrack');
  }
  if (!/spotifyRemoteRequestTrack/.test(remoteText) || !/client\/play-track/.test(remoteText)) {
    fail('the renderer must ask the client to switch tracks through play-track');
  }
  if (!/spotifyRemoteSwitchingUntil/.test(remoteText)) {
    fail('the silent clock must freeze while the client is switching, or it mirrors the previous track');
  }
  if (!/await window\.SpotifyRemote\.handleTrackStart\(song\)/.test(playbackText)) {
    fail('the remote handover must be awaited so a failed switch still falls back to switch_source');
  }
  // 点播的主路径是注入桥（PlayerAPI.play({uri})），DOM 搜索只是兜底。
  // 2026-11-18 在本机 1.3.9 实测：注入桥切歌 0.4s 且可重复；DOM 搜索 4~7s 且可能点错版本。
  // 桥只活在渲染进程里，绝不写客户端文件 —— 一旦有人改成改 xpui.spa，这条会拦住。
  const bridgePath = path.join(appRoot, 'server', 'spotify-cdp-bridge.js');
  if (!fs.existsSync(bridgePath)) fail('server/spotify-cdp-bridge.js must exist as the injected PlayerAPI bridge');
  const bridgeText = fs.readFileSync(bridgePath, 'utf8');
  if (!/require\('\.\/spotify-cdp-bridge'\)/.test(cdpText) || !/BRIDGE_SOURCE/.test(cdpText)) {
    fail('the CDP bridge must require and inject spotify-cdp-bridge.js');
  }
  if (!/Symbol\.for\("PlayerAPI"\)/.test(bridgeText) || !/\.resolve\(/.test(bridgeText)) {
    fail('the injected bridge must resolve PlayerAPI through the DI registry');
  }
  if (!/memoizedProps/.test(bridgeText) || !/props\.registry/.test(bridgeText)) {
    fail('the DI registry lives in React fiber memoizedProps.registry — the bridge must read it there');
  }
  if (!/callBridge\('play'/.test(cdpText) || !/playTrackViaUri/.test(cdpText)) {
    fail('point-play must prefer PlayerAPI.play({uri}) over driving the search UI');
  }
  if (!/readStateViaApi/.test(cdpText) || !/positionAsOfTimestamp/.test(bridgeText)) {
    fail('state must come from PlayerAPI._state (positionAsOfTimestamp), not the DOM progress bar');
  }
  if (!/function trackIsTarget/.test(cdpText) || !/want === actual/.test(cdpText)) {
    fail('track confirmation must compare the spotify URI, not just the title');
  }
  if (/writeFileSync|fs\.writeFile|appendFileSync/.test(bridgeText)) {
    fail('the injected bridge must stay runtime-only — never modify the Spotify client files');
  }
  if (!/wantUri === actualUri/.test(remoteText)) {
    fail('the renderer must compare spotify URIs when deciding whether the client already plays the song');
  }
  // 时间轴校准：只允许在"MR 前端 + Spotify 源 + 客户端接管中"这一种状态下跑。
  // 源一旦不是 Spotify（自动换源到别家 / 用户切走），必须整段停 —— 拿别的平台的进度
  // 去校这个静音时钟，会把歌词和动画一起带偏，而且没有任何报错。
  // Calibration is only valid while a Spotify track is mirrored from the client; any other source
  // must disable it entirely, silently wrong otherwise.
  if (!/function spotifyRemoteCalibrationBlocker/.test(remoteText)
    || !/spotifyRemoteSongProvider\(song\) !== 'spotify'/.test(remoteText)) {
    fail('timeline calibration must be gated on the current song being a Spotify source');
  }
  if (!/if \(spotifyRemoteSwitching\(\)\) return 'switching';/.test(remoteText)
    || !/Date\.now\(\) < spotifyRemoteUserSeekUntil\) return 'user-seek'/.test(remoteText)) {
    fail('calibration must skip while the client is switching tracks or the user just seeked');
  }
  if (!/client\/state\?force=1/.test(remoteText)) {
    fail('calibration must read a fresh client state (?force=1) instead of the cached mirror');
  }
  if (!/spotifyRemoteStopCalibration\(\)/.test(remoteText) || !/function spotifyRemoteDeactivate/.test(remoteText)) {
    fail('the calibration timer must be stopped when the remote takeover ends');
  }
  if (!/setInterval\([\s\S]{0,220}spotifyRemoteCalibrate\('timer'\)/.test(remoteText)) {
    fail('calibration must run on its own slow timer, separate from the 1s mirror poll');
  }
  // 客户端状态检测：换歌 / 意外停止 / 通道断开都要反映到 MR，不能让它空转。
  if (!/function spotifyRemoteNoteState/.test(remoteText) || !/function spotifyRemoteNoteChannelMiss/.test(remoteText)) {
    fail('the remote module must watch client state changes (track switch, stop, channel loss)');
  }
  if (!/spotify_client_followed/.test(remoteText) || !/spotify_client_foreign/.test(remoteText)
    || !/spotify_client_disconnected/.test(remoteText) || !/spotify_client_need_restart/.test(remoteText)
    || !/spotify_client_not_installed/.test(remoteText)) {
    fail('client state changes must surface as user-visible notices, not silent divergence '
      + '(including "already running without the debug port" and "client not installed")');
  }
  // 两个开关取代了旧的深链接唤起：删掉的东西不许留残骸，否则下一个人会以为它还在生效。
  if (/SpotifyLaunchClient/.test(remoteText) || /window\.open\('spotify:track:/.test(remoteText)) {
    fail('the deep-link launch mechanism is gone — the renderer must not reference it any more');
  }
  if (!/if \(!spotifyRemotePrefs\.launch\) return Promise\.resolve\(false\)/.test(remoteText)) {
    fail('"start Spotify in the background" off must stop the renderer from launching the client');
  }
  if (!/spotifyHoldSource/.test(fallbackText)) {
    fail('"switch to another source" off must block the fallback instead of trading the track away');
  }
  // 每个模块是独立的 <script>，顶层 var/function 全挂在同一个全局上 —— 同名会被后加载的那个
  // **无声覆盖**。本轮就踩过：preferences 模块里的取偏好函数与远程模块里的同名对象撞车，
  // 结果点开关直接 TypeError，而所有静态守卫都绿。这类 bug 只有真去点才暴露，所以在这里钉住。
  // 现在整个控制部件只有一个顶层声明 PillagerSpotify()，其余全在闭包里 —— 这条守卫就守这个
  // 结构：谁再往里加顶层 var/function，撞名风险立刻回来，直接拦下。
  // Modules share one global scope (each is its own <script>), so duplicate top-level names
  // silently overwrite each other — hit this round with a helper/object name clash that turned the
  // settings toggle into a TypeError while every static guard stayed green. The component therefore
  // keeps exactly one top-level declaration; anything else escalates the risk again.
  const remoteTopLevel = (remoteText.replace(/\/\*[\s\S]*?\*\//g, '').match(/^(?:var|let|const|function)\s+[A-Za-z_$][\w$]*/gm) || [])
    .map(line => line.replace(/^(?:var|let|const|function)\s+/, ''));
  if (remoteTopLevel.length !== 1 || remoteTopLevel[0] !== 'PillagerSpotify') {
    fail('the Spotify control component must stay a single top-level declaration named '
      + 'PillagerSpotify(), everything else inside its closure; found: '
      + (remoteTopLevel.join(', ') || '(none)'));
  }
  if (!/window\.SpotifyRemote = PillagerSpotify\(\)/.test(remoteText)) {
    fail('the component must publish itself as window.SpotifyRemote = PillagerSpotify()');
  }
  const moduleRoot = path.join(appRoot, 'public', 'js', 'modules');
  const moduleFiles = [];
  (function walkModules(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkModules(full);
      else if (entry.name.endsWith('.js')) moduleFiles.push(full);
    }
  })(moduleRoot);
  const remoteModulePath = path.join(moduleRoot, '08-account', 'pillager-spotify.js');
  const nameClashes = [];
  for (const file of moduleFiles) {
    if (file === remoteModulePath) continue;
    const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const name of remoteTopLevel) {
      if (new RegExp('^(?:var|let|const|function)\\s+' + name + '\\b', 'm').test(code)) {
        nameClashes.push(name + ' @ ' + path.relative(appRoot, file));
      }
    }
  }
  if (nameClashes.length) {
    fail('pillager-spotify.js declares names another module also declares; the shared global scope means '
      + 'one silently overwrites the other: ' + nameClashes.slice(0, 6).join(', '));
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
  if (!/\/api\/spotify\/user\/playlists/.test(playlistShellText) || !/spotifyPlaylists/.test(playlistShellText) || !/\/api\/spotify\/playlist\/tracks/.test(playlistDetailText) || !/spotify:' \+ id/.test(playlistDetailText) || !hasAllItems(playlistProviderOrder(playlistDetailText), BASE_PLAYLIST_PROVIDERS)) {
    fail('playlist panel must merge and open Spotify playlists');
  }
  if (!/spotifyErrorDetails/.test(spotifyText) || !/playlistPanelNoticeHtml/.test(playlistDetailText) || !/playlistCardPriority/.test(playlistDetailText) || !/spotify-liked/.test(playlistDetailText) || !/prioritizePlaylistGroupItems/.test(playlistDetailText) || !/showToast\(r && \(r\.message \|\| r\.error\) \|\| podcastPlaylistLoadersText\('pod_empty'\)\)/.test(playlistLoadText)) {
    fail('Spotify playlists must keep liked songs visible and surface API errors instead of pretending details are empty');
  }
  if (!/function playlistQueueSource/.test(playlistLoadText) || !/raw\.indexOf\('spotify:'\)/.test(playlistLoadText) || !/fetchPlaylistTracksPage\(source\.provider/.test(playlistLoadText)) {
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
  if (!/"server\/\*\*\/\*"/.test(packageText)) {
    fail('the package file list must cover server/**/*, or a backend module can be left out of the build');
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
  const cssText = readAllCssFiles();
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
    /#search-results\.search-history-surface,[ \t]*\r?\nhtml\.control-glass-svg-ok\s+#search-results\.search-history-surface\s*\{[\s\S]{0,320}background:\s*linear-gradient\([\s\S]{0,180}!important[\s\S]{0,220}backdrop-filter:\s*blur\(calc\(34px \* var\(--glass-blur-scale, 1\)\)\)\s+saturate\(1\.34\)\s+brightness\(1\.08\)\s*!important/.test(cssText) &&
    !/#search-results\.search-history-surface[\s\S]{0,260}background:\s*rgba\(0,\s*0,\s*0,\s*\.90\)/.test(cssText);
  const searchResultsFrostedSurfaceOk =
    /#search-results\.show:not\(\.search-history-surface\),[ \t]*\r?\nhtml\.control-glass-svg-ok\s+#search-results\.show:not\(\.search-history-surface\)\s*\{[\s\S]{0,320}background:\s*linear-gradient\([\s\S]{0,180}!important[\s\S]{0,220}backdrop-filter:\s*blur\(calc\(34px \* var\(--glass-blur-scale, 1\)\)\)\s+saturate\(1\.34\)\s+brightness\(1\.08\)\s*!important/.test(cssText) &&
    /#search-results\.show:not\(\.search-history-surface\)\s+\.search-result\s*\{[\s\S]{0,180}background:\s*rgba\(255,\s*255,\s*255,\s*\.026\)\s*!important/.test(cssText);
  const searchProviderCapabilityFilterOk =
    /function searchProviderCanSearch\(provider\)/.test(searchText) &&
    /function activeSearchProvidersForMode\(mode\)\s*\{[\s\S]{0,260}MUSIC_SEARCH_PROVIDER_ORDER\.filter\(searchProviderCanSearch\)/.test(searchText) &&
    /function searchProviderLoginNotice\(mode\)/.test(searchText) &&
    // 各平台必须各自发请求、各自结算：曾经用 allSettled 一次性等全部，慢的那个会把整页挂住。
    // Each provider has to be asked and to settle on its own; allSettled waited for the slowest one.
    /fetchProviders\.map\(function \(provider\)[\s\S]{0,420}apiJson\(searchProviderUrl\(provider, q, limit, offset\)/.test(searchText) &&
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
    indexText.includes('css/desktop.css?v=20260716-we-continuity-vsync') &&
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
  console.log('[OK] Provider account membership and per-track playback entitlement remain separated.');
}

function checkQQVipStatusSyncGuard() {
  logStep('QQ VIP status refresh guard');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const vipModuleText = fs.readFileSync(path.join(appRoot, 'server', 'qq-vip-api.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const loginWindowsText = fs.readFileSync(path.join(appRoot, 'desktop', 'login-windows.js'), 'utf8');
  const preloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const loginStatusText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
  const loginFlowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'), 'utf8');
  const accountUtilsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  const userModalText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const startupText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '05-startup-bindings.js'), 'utf8');
  const cssText = readAllCssFiles();

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
  if (!/openQQMusicLoginWindow\(owner, options\)/.test(loginWindowsText) ||
      !/const initialCookie = await readQQLoginCookieHeader\(cookieSession\);[\s\S]{0,220}qqCookieHasPlaybackLogin\(initialCookie\)[\s\S]{0,260}options\.forceReauth/.test(loginWindowsText) ||
      !/options\.forceReauth[\s\S]{0,180}clearStorageData/.test(loginWindowsText) ||
      !/openQQMusicLogin:\s*\(options\)/.test(preloadText) ||
      !/forceReauth:\s*!!\(qqLoginStatus && qqLoginStatus\.authorizationIncomplete && qqLoginStatus\.playbackKeyReady === false\)/.test(loginFlowText) ||
      /forceReauth:\s*!!\(qqLoginStatus && qqLoginStatus\.loggedIn\)/.test(loginFlowText)) {
    fail('QQ reauthorization must only clear an explicitly incomplete playback session, never every logged-in session');
  }
  if (!/function isTrustedQQLoginUrl/.test(loginWindowsText) ||
      !/action:\s*'allow'[\s\S]{0,900}partition:\s*qqPartition/.test(loginWindowsText) ||
      !/playbackFinalizePending[\s\S]{0,700}setTimeout\(resolveDelay,\s*450\)/.test(loginWindowsText) ||
      !/const showLoginWindow = \(\) =>[\s\S]{0,260}loginWindow\.show\(\)/.test(loginWindowsText) ||
      !/showWatchdog = setTimeout\(showLoginWindow,\s*2500\)/.test(loginWindowsText) ||
      !/const loadQQOfficialLoginEntry = async \(\) =>[\s\S]{0,700}cookieSession\.clearCache\(\)[\s\S]{0,420}qqFallbackUrl/.test(loginWindowsText) ||
      /loginWindow\.loadURL\('https:\/\/y\.qq\.com\/n\/ryqq\/player'\)/.test(loginWindowsText) ||
      !/function qqLoginCompletionFromCookie[\s\S]{0,500}QQ_PLAYBACK_AUTH_INCOMPLETE/.test(loginWindowsText) ||
      !/resolve\(qqLoginCompletionFromCookie\(cookie\)\)/.test(loginWindowsText)) {
    fail('QQ OAuth must stay in its official window, keep trusted popups on one partition, and reject web-only partial sessions');
  }
  if (!/async function fetchQQVipStatus[\s\S]{0,220}const musicKey = qqCookiePlaybackKey\(cookieObj\)/.test(serverText) ||
      !/async function handleQQSongUrl[\s\S]{0,500}const playbackKey = qqCookiePlaybackKey\(cookieObj\);\s*const musicKey = playbackKey;/.test(serverText) ||
      !/if \(!qqCookieUin\(obj\) \|\| !qqCookiePlaybackKey\(obj\)\)/.test(serverText) ||
      !/function qqCookieUin[\s\S]{0,180}!!obj\.wxopenid[\s\S]{0,180}obj\.wxuin/.test(serverText)) {
    fail('QQ VIP and vkey requests must use a strict QQ Music playback key and must not persist p_skey-only sessions');
  }
  if (!/cookieIsExpired/.test(loginWindowsText) || !/qqLoginCookieCandidateScore/.test(loginWindowsText) ||
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
  console.log('[OK] QQ membership status can be force-refreshed after renewals.');
}

async function checkProviderAuthCookiePathGuard() {
  logStep('Provider auth cookie path guard');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const loginWindowsText = fs.readFileSync(path.join(appRoot, 'desktop', 'login-windows.js'), 'utf8');
  const qqLoginText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'), 'utf8');
  const accountUtilsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  const playlistLoadText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');
  const cssText = readAllCssFiles();

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
  if (!/function qqLoginCompletionFromCookie[\s\S]{0,420}partial:\s*true[\s\S]{0,160}QQ_PLAYBACK_AUTH_INCOMPLETE/.test(loginWindowsText) ||
      !/resolve\(qqLoginCompletionFromCookie\(cookie\)\)/.test(loginWindowsText) ||
      /partial:\s*true,\s*cookie/.test(loginWindowsText)) {
    fail('QQ login must report a web-only session as incomplete without returning its cookie for persistence');
  }
  if (/resolve\(neteaseCookieHasLogin\(cookie\)[\s\S]{0,140}!qqCookieHasPlaybackLogin/.test(loginWindowsText)) {
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

function checkInstallerPackagingGuard() {
  logStep('Installer packaging guard');
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const packageBuildFiles = pkg.build && Array.isArray(pkg.build.files) ? pkg.build.files : [];
  ['server/**/*'].forEach((entry) => {
    if (!packageBuildFiles.includes(entry)) {
      fail(`electron-builder files must include runtime dependency ${entry}`);
    }
  });
  const installerText = fs.readFileSync(path.join(appRoot, 'build', 'installer.nsh'), 'utf8');
  if (!/MINERADIO_INSTALL_DIR_NAME/.test(installerText)) {
    fail('the installer must keep a configurable install-folder hook');
  }
  // gsap 只从 public/vendor/gsap.min.js 以全局变量使用，node_modules/gsap 已从打包清单里排除
  // （省 6MB）。一旦有人在运行时 require('gsap')，装好的应用里没有这个包，启动就崩 —— 这两件事
  // 必须钉在一起，否则下次谁顺手改成 require 都查不出来。
  // gsap is used as the vendored global from public/vendor/gsap.min.js and node_modules/gsap is
  // excluded from the package to save 6MB. A runtime require('gsap') would then crash the installed
  // app, so the exclusion and the "never require it" rule are pinned together here.
  if (!(pkg.build && Array.isArray(pkg.build.files) ? pkg.build.files : []).includes('!node_modules/gsap/**')) {
    fail("node_modules/gsap must stay excluded from the package — the runtime reads public/vendor/gsap.min.js");
  }
  const requiresGsap = (function () {
    const stack = ['public', 'desktop', 'server', 'cuefield'].map((dir) => path.join(appRoot, dir));
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'vendor') stack.push(full);
          continue;
        }
        if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        if (/require\(\s*['"]gsap['"]\s*\)|from\s+['"]gsap['"]/.test(source)) return true;
      }
    }
    return false;
  })();
  if (requiresGsap) {
    fail("runtime code must not require('gsap') — the package ships it as a global from public/vendor");
  }
  // 差分更新包会强制把 payload 换成「1MB 字典 + 非固实 + 低压缩等级」，实测代价是安装包大 10.4MB
  // （109.6MB → 99.2MB，约 10%）。本项目不做自动更新：release.yml 用极简 latest.yml 顶掉了
  // electron-updater 的更新源，也不发 blockmap，所以这份代价换不到任何东西。改回 true 会让安装包
  // 立刻胖回去，而且没有任何报错。
  // Differential packaging forces the payload to a 1MB dictionary, non-solid, low compression level.
  // Measured cost here: +10.4MB (109.6MB vs 99.2MB, ~10%). This project ships no auto-update —
  // release.yml replaces latest.yml with a minimal manifest and publishes no blockmap — so the trade
  // buys nothing. Flipping this back to true silently re-adds the 10MB.
  if (!pkg.build || !pkg.build.nsis || pkg.build.nsis.differentialPackage !== false) {
    fail('build.nsis.differentialPackage must stay false — it costs ~10MB of installer size and no diff feed is published');
  }
  // xml2js 自带 lib/xml2js.bc.js 是 3.3MB 的 browserify 打包产物，Node 侧只走 package.json 的
  // main（lib/xml2js），这个文件永远不会被加载 —— 从打包清单里排除，省 3.3MB 原始体积。
  // xml2js ships lib/xml2js.bc.js, a 3.3MB browserify bundle; the Node entry (main: lib/xml2js)
  // never touches it, so it is excluded from the package.
  if (!packageBuildFiles.includes('!node_modules/xml2js/lib/xml2js.bc.js')) {
    fail('node_modules/xml2js/lib/xml2js.bc.js must stay excluded — nothing loads that browser bundle');
  }
  // 开始菜单磁贴：manifest 必须与 exe 同名同目录，四张 png 必须在 VisualElements/ 下。
  // 任何一环不对都**不会报错**，只是磁贴退回系统灰底 —— 也就是用户反馈的「图标外面一圈灰蒙蒙」。
  // Start-menu tiles: the manifest has to carry the executable's name and sit next to it, with the
  // four PNGs under VisualElements/. Nothing errors when this is wrong; the tile just falls back to
  // the system grey backdrop, which is exactly the grey halo users reported.
  const tileManifestPath = path.join('build', 'visual-elements', 'Mineradio.VisualElementsManifest.xml');
  // package.json 里写的是正斜杠，path.join 在 Windows 上给的是反斜杠 —— 比较前统一。
  // package.json uses forward slashes while path.join yields backslashes on Windows.
  const tileManifestRef = tileManifestPath.split(path.sep).join('/');
  if (!fs.existsSync(path.join(appRoot, tileManifestPath))) {
    fail('the Start-menu tile manifest is missing: ' + tileManifestPath);
  }
  const exeBaseName = (pkg.build && pkg.build.win && pkg.build.win.executableName)
    || (pkg.build && pkg.build.productName)
    || 'Mineradio';
  if (path.basename(tileManifestPath) !== `${exeBaseName}.VisualElementsManifest.xml`) {
    fail(`the tile manifest must be named after the executable (${exeBaseName}.VisualElementsManifest.xml)`);
  }
  const tileXmlText = fs.readFileSync(path.join(appRoot, tileManifestPath), 'utf8');
  // 必须显式给 BackgroundColor：留空时 Windows 自己垫一层不透明灰，图标四角透明就会透出灰圈。
  // 值用 transparent（跟随系统半透明磁贴），不要写死成图标的深色 —— 那会让这一个磁贴不透明。
  // BackgroundColor must be explicit: when omitted Windows paints its own opaque grey, which shows
  // through the icon's transparent corners. Keep it "transparent" (follows the system's translucent
  // tiles) rather than pinning the icon's dark colour, which would make this one tile opaque.
  if (!/BackgroundColor="(transparent|#[0-9A-Fa-f]{6})"/.test(tileXmlText)) {
    fail('the tile manifest must pin BackgroundColor (use "transparent" to follow the system tiles)');
  }
  const tileExtraFiles = (pkg.build && Array.isArray(pkg.build.extraFiles) ? pkg.build.extraFiles : []);
  const tileCopied = tileExtraFiles.some((entry) => entry && typeof entry === 'object'
    && String(entry.from || '').split('\\').join('/') === tileManifestRef
    && entry.to === path.basename(tileManifestPath));
  if (!tileCopied) {
    fail('package.json extraFiles must copy the tile manifest next to the executable');
  }
  const tilePngsCopied = tileExtraFiles.some((entry) => entry && typeof entry === 'object'
    && entry.from === 'build/visual-elements/VisualElements' && entry.to === 'VisualElements');
  if (!tilePngsCopied) {
    fail('package.json extraFiles must copy build/visual-elements/VisualElements to the app root');
  }
  ['Square44x44Logo.png', 'Square71x71Logo.png', 'Square150x150Logo.png', 'Square310x310Logo.png']
    .forEach((name) => {
      if (!fs.existsSync(path.join(appRoot, 'build', 'visual-elements', 'VisualElements', name))) {
        fail(`Start-menu tile asset is missing: VisualElements/${name}`);
      }
    });
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
  // 安装器首屏的界面语言：点开式下拉列表（不是一行铺四个单选）→ 标记文件 → 主进程读一次即删
  // → 渲染端当首启默认。这条链路任何一环断掉都会静默失效（装完语言没变，且没有任何报错）。
  // The installer's first-page language: an openable dropdown (not four inline radios) → marker
  // file → read-once in the main process → used as the renderer's first-run default. A break
  // anywhere in that chain fails silently (installer choice simply ignored), so guard all links.
  if (!/Var\s+MineradioLangCombo\b/.test(installerCode)) {
    fail('installer welcome page must keep a handle for the language dropdown');
  }
  if (!/nsDialogs::CreateControl\s+"COMBOBOX"[\s\S]{0,160}?CBS_DROPDOWNLIST[\s\S]{0,160}?Pop \$MineradioLangCombo/.test(installerCode)) {
    fail('installer welcome page must offer the language as a dropdown list (CBS_DROPDOWNLIST), so it opens on click');
  }
  if (/NSD_CreateRadioButton/.test(installerCode)) {
    fail('installer must not fall back to four inline language radios — they do not open into a list');
  }
  const langEntries = [...installerCode.matchAll(/CB_ADDSTRING\} 0 "STR:([^"]+)"/g)].map((m) => m[1]);
  const expectedLangEntries = langLabels();
  if (!expectedLangEntries.length) {
    fail('could not derive the language endonyms from 13-i18n.js LANG_LABELS');
  }
  if (langEntries.join('|') !== expectedLangEntries.join('|')) {
    fail(
      'installer language dropdown must list every wired language in app-menu order: expected '
      + expectedLangEntries.join('|') + ', got ' + (langEntries.join('|') || '(none)')
    );
  }
  // 每一行都要能被预选，索引与上面的顺序绑定；少一行就意味着 /APP_LANG= 落不到它上面。
  // Every row must be preselectable and the index mapping must cover all of them.
  langEntries.forEach((label, index) => {
    if (!new RegExp('CB_SETCURSEL\\} ' + index + ' 0').test(installerCode)) {
      fail(`installer cannot preselect dropdown row ${index} (${label})`);
    }
  });
  if (!/\$\{CB_GETCURSEL\} 0 0[\s\S]{0,80}?Pop \$0/.test(installerCode)) {
    fail('installer must read the dropdown selection back on page leave (arrow keys change it too)');
  }
  if (!/\$\{CB_SETCURSEL\} 1 0/.test(installerCode) || !/\$\{CB_SETCURSEL\} 3 0/.test(installerCode)) {
    fail('installer must preselect the dropdown row that matches the resolved language');
  }
  // 标记必须落在 <安装目录>\userdata\，也就是应用在 asar 模式下认的便携数据根
  // （<exe 同级>\userdata）。写回 resources\app\userdata\ 的话，主进程读不到，语言选择静默失效。
  // The marker has to land in <install dir>\userdata\ — the portable root the app resolves to in
  // asar mode (<exe dir>\userdata). Writing back to resources\app\userdata\ is silently ignored.
  if (!/\$INSTDIR\\userdata\\\$\{MINERADIO_LANG_MARKER\}/.test(installerCode)) {
    fail('installer must write the chosen language next to the portable userdata folder');
  }
  if (!/\$\{If\} \$MineradioLanguage != ""/.test(installerCode)) {
    fail('installer must skip the language marker on silent installs and updates');
  }
  const installerPreloadText = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
  const installerI18nText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '13-i18n.js'), 'utf8');
  if (!/getInstallerLanguage: \(\) => ipcRenderer\.invoke\('mineradio-installer-language'\)/.test(installerPreloadText)) {
    fail("preload must expose the installer language bridge as 'mineradio-installer-language'");
  }
  if (!/ipcMain\.handle\('mineradio-installer-language'/.test(installerText + fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8'))) {
    fail('main process must answer the installer language bridge');
  }
  if (!/readInstallerLang\(\)\.then\(function \(installerLang\) \{\s*\n\s*return installerLang \|\| detectSystemLang\(\)/.test(installerI18nText)) {
    fail('renderer must treat the installer language as the first-run default above the system locale');
  }
  const mainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  if (!/function takeInstallerLanguage\(\)/.test(mainText) || !/fs\.unlinkSync\(file\)/.test(mainText)) {
    fail('the installer language marker must be read once and deleted, or reinstalls would override later choices');
  }
  if (!/APP_PACKAGE_INFO/.test(mainText) || !/runtimeName/.test(mainText) || !/appUserModelId/.test(mainText)) {
    fail('desktop runtime must read its display name and AppUserModelID from package metadata');
  }
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  if (!/qishui-audio-decryptor\/track-decryptor/.test(serverText)) {
    fail('server qishui decryptor dependency must stay covered by package files');
  }
  if (!/local\.disabled === true/.test(serverText) || !/provider === 'none'/.test(serverText)) {
    fail('server update config must support a disabled local channel');
  }
  console.log('[OK] Installer packaging keeps one public build with a verifiable file list and language picker.');
}

function checkPlaylistPanelTriggerGuard() {
  logStep('Playlist panel trigger guard');
  const peekText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '02-peek-panels-upload.js'), 'utf8');
  const panelShellText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '01-playlist-panel-shell.js'), 'utf8');
  const fxDefaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const fxRuntimeText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const persistenceText = readVisualArchiveText();
  const fxBindText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const focusCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '03-focus-cinema-camera.js'), 'utf8');
  const desktopMainText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const cssText = readAllCssFiles();
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
  // Apple Music 接入后：登录/主搜索/源切换/全集都多一项。自动换源（directFallback）仍然
  // 刻意不含它 —— companion 给不出可直接播放的地址；但 2026-11-22 起 preferred 含它：
  // 用户要"打开 MR 第一首就听 AM"，靠的是"先搜同名同歌手再换成 AM 曲目"这条默认源路径，
  // 与 directFallback 是两回事（详见 16-provider-registry.js 里 AM 那行的注释）。
  // directFallback still excludes AM; preferred includes it since the default-source matching
  // path (search → swap to the AM track → companion playback) never needs a direct URL.
  const expectedSets = {
    login: 'netease,qq,kugou,qishui,spotify,applemusic',
    mainSearch: 'netease,qq,kugou,qishui,applemusic',
    sourceSwitcher: 'netease,qq,kugou,qishui,spotify,applemusic',
    directFallback: 'netease,qq,kugou',
    preferred: 'netease,qq,kugou,qishui,spotify,applemusic',
    all: 'netease,qq,kugou,qishui,spotify,applemusic'
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
  // Apple Music 只能经外部 companion 播放，拿不到直接地址 —— 自动换源必须排除它。
  // 但**默认源**可以包含它（2026-11-22 起）：那条路径是"先搜同名同歌手、命中就换成 AM 曲目
  // 再交给 companion"，全程不需要直接地址。两件事以前被一条推断捆在一起，是错的。
  // AM stays out of auto-fallback (no direct URL), but may be a preferred source: that path only
  // matches the track and hands it to the companion.
  if ((probe.sets.directFallback || []).indexOf('applemusic') >= 0) {
    fail('applemusic must not be in "directFallback": the companion has no direct playable URL');
  }
  if ((probe.sets.preferred || []).indexOf('applemusic') < 0) {
    fail('applemusic must be selectable as a preferred source: matching a track to its AM version '
      + 'and playing it through the companion needs no direct URL');
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
      literal: "['netease', 'spotify', 'applemusic']",
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
      reason: 'playlist catalogue prefetch priority (netease, Spotify, then Apple Music); the set is '
        + 'completed from the registry right below and the resulting order is unchanged'
    }
  ];
  // 新平台名也要进正则，否则含 applemusic 的字面量会整段绕过这条判据。
  // Every registered platform name belongs here, or a literal mentioning a newer one slips through.
  const PLATFORM_LIST_RE = /\[\s*'(?:netease|qq|kugou|qishui|spotify|applemusic)'(?:\s*,\s*'(?:netease|qq|kugou|qishui|spotify|applemusic)')+\s*\]/;
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
  // Spotify 只剩两个开关，而且两个都必须登记：没登记会被残留扫描收进「其他设置」，
  // 界面上只是位置不对、不报错。旧的 t-spotifyLaunchClient（深链接唤起）已整体删除。
  // Only two Spotify toggles remain, and both must be registered or the residual sweep files them
  // under "other settings" with no error. The old deep-link toggle is gone for good.
  for (const id of ['t-spotifySwitchSource', 't-spotifyRemoteLaunch']) {
    if (!new RegExp("fxConsoleItem\\('" + id + "'").test(consoleText)) {
      fail(id + ' must be registered in the console layout, or the residual sweep files it under '
        + '"other settings" (wrong place, no error)');
    }
    if (!new RegExp('id="' + id + '"').test(indexText)) {
      fail('index.html must still contain #' + id);
    }
  }
  const spotifyLoaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  if (/SpotifyLaunchClient|spotify-launch-client\.js|toggleSpotifyLaunchClient/.test(indexText + consoleText + spotifyLoaderText)) {
    fail('the deep-link launch client was deleted — its markup, console entry and loader registration '
      + 'must be gone too, not left half wired');
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
    supportedLangs().forEach(function (lang) {
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
  const desktopSpotifyText = fs.readFileSync(path.join(appRoot, 'desktop', 'spotify-login.js'), 'utf8');
  const preloadCode = stripComments(readText('desktop/preload.js'));
  const loaderCode = stripComments(readText('public/js/index-loader.js'));
  const rendererCode = stripComments(readText('public/js/modules/06-lyrics/00-built-in-playlists.js'));
  const shellCode = stripComments(readText('public/js/modules/06-lyrics/01-playlist-panel-shell.js'));
  const detailCode = stripComments(readText('public/js/modules/06-lyrics/02-playlist-detail.js'));
  const multiselectCode = stripComments(readText(MULTISELECT_MODULE));
  const indexCode = stripComments(readText('public/index.html'));
  const cssCode = stripComments(readAllCssFiles());

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
  supportedLangs().forEach(function (lang) {
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

module.exports = {
  checkCustomSourceGuard,
  checkQishuiProviderGuard,
  checkSpotifyProviderGuard,
  checkSpotifyProviderSurface,
  checkProviderFallbackTerminalStateGuard,
  checkSearchGlassEntranceGuard,
  checkProviderEntitlementBoundaryGuard,
  checkQQVipStatusSyncGuard,
  checkProviderAuthCookiePathGuard,
  checkInstallerPackagingGuard,
  checkPlaylistPanelTriggerGuard,
  checkProviderRegistryGuard,
  checkUpdateManifestGuard,
  checkPlaylistMultiselectGuard,
};
