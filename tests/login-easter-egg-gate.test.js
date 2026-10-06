'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { accessorBlock, i18nWindow } = require('./helpers/module-source');
const {
  LoginEasterEggGate,
  LOGIN_EASTER_EGG_GATE_VERSION,
  LOGIN_EASTER_EGG_ANSWERS,
  LOGIN_EASTER_EGG_CREDENTIAL_FILES,
} = require('../desktop/login-easter-egg-gate');
const { LOGIN_EASTER_EGG_WISH_KEY } = require('../public/js/modules/08-account/00-login-easter-egg');

// 烘焙的落地尺寸：用一个会记账的 2d 上下文把真函数跑一遍，看画布最后被写成多大。
// 这一条正是当初漏掉的：宽度写死了、高度从没写过，画布留着默认的 150 高 —— 而 CSS 是按**画布
// 自己的宽高比**推显示宽度的（`height: .92em; width: auto`），于是每个字都被压成又窄又矮的一小条：
// 看着变小，W 的空隙也被挤没了。真机实测过：只设宽度时 40 高的格子在屏幕上只有 14.7 × 220.8。
// The baked footprint: run the real function against a bookkeeping 2d context and inspect the canvas
// size it ends up with. This is what was missed — the width was pinned while the height never was, so
// the canvas kept its default 150, and because the CSS derives the display width from the canvas's own
// ratio (`height: .92em; width: auto`) every glyph was squashed into a short narrow sliver: smaller,
// with a W's counters squeezed shut. Measured in a real browser: with the width alone set, a 40-tall
// cell showed up as 14.7 x 220.8 on screen.
function bakeProbe(advance) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'modules', '08-account', '00-login-easter-egg.js'), 'utf8');
  const order = [];
  const reads = [];
  const size = { width: 300, height: 150 };
  const stubNode = () => ({
    textContent: '',
    dataset: {},
    className: '',
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    classList: { add() {}, remove() {}, contains() { return false; } },
    children: [],
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    appendChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    getContext() { return null; },
  });
  const sandbox = {
    console, Array, String, Number, Math, JSON, Object, Date, RegExp, Promise, Error, Uint8ClampedArray,
  };
  sandbox.window = Object.assign(
    { addEventListener() {}, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0 },
    i18nWindow('zh_cn')
  );
  sandbox.window.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  sandbox.window.desktopWindow = {
    getLoginEasterEggStatus: () => Promise.resolve({ ok: true, unlocked: false }),
    unlockLoginEasterEgg: () => Promise.resolve({ ok: false, unlocked: false, error: 'LOGIN_EASTER_EGG_INVALID' }),
  };
  sandbox.window.window = sandbox.window;
  sandbox.document = {
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    documentElement: {},
    getElementById: () => stubNode(),
    querySelectorAll: () => [],
    createElement: () => stubNode(),
    addEventListener() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.__bake = bakeLoginEasterEggGlyph;', sandbox);
  const canvas = {
    getContext: () => ({
      font: '',
      textAlign: '',
      textBaseline: '',
      fillStyle: '',
      measureText: () => ({ width: advance }),
      clearRect: () => order.push('clearRect'),
      fillText: () => order.push('fillText'),
      getImageData: (x, y, w, h) => {
        order.push('getImageData');
        reads.push([w, h]);
        return { data: new Uint8ClampedArray(w * h * 4) };
      },
      putImageData: () => order.push('putImageData'),
    }),
  };
  Object.defineProperty(canvas, 'width', {
    get: () => size.width,
    set: (value) => { size.width = value; order.push('set width'); },
  });
  Object.defineProperty(canvas, 'height', {
    get: () => size.height,
    set: (value) => { size.height = value; order.push('set height'); },
  });
  return { em: sandbox.__bake(canvas, 'W'), canvas, order, reads };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-login-gate-'));
  try {
    const migrationRoot = path.join(root, 'chromium-session');
    fs.mkdirSync(migrationRoot, { recursive: true });
    LOGIN_EASTER_EGG_CREDENTIAL_FILES.forEach((name) => {
      fs.writeFileSync(path.join(root, name), 'legacy-login', 'utf8');
      fs.writeFileSync(path.join(migrationRoot, name), 'displaced-legacy-login', 'utf8');
    });
    fs.writeFileSync(path.join(root, '.spotify-credentials.json'), '{"clientId":"keep"}', 'utf8');
    fs.writeFileSync(path.join(root, '.qishui-oauth.json'), '{"clientId":"keep"}', 'utf8');
    fs.writeFileSync(path.join(root, 'current-fx-autosave.json'), '{"keep":true}', 'utf8');

    let partitionClearCount = 0;
    const gate = new LoginEasterEggGate({ userDataPath: root, credentialRoots: [migrationRoot], now: () => 1234 });
    const first = await gate.initialize(async () => {
      partitionClearCount += 1;
      fs.writeFileSync(path.join(root, '.cookie'), 'runtime-flush', 'utf8');
      fs.writeFileSync(path.join(migrationRoot, '.cookie'), 'runtime-migration-flush', 'utf8');
    });
    assert.strictEqual(first.resetPerformed, true);
    assert.strictEqual(first.resetComplete, true);
    assert.strictEqual(first.unlocked, false);
    assert.strictEqual(partitionClearCount, 1);
    LOGIN_EASTER_EGG_CREDENTIAL_FILES.forEach((name) => {
      assert.strictEqual(fs.existsSync(path.join(root, name)), false, `${name} should be cleared`);
      assert.strictEqual(fs.existsSync(path.join(migrationRoot, name)), false, `${name} migration copy should be cleared`);
    });
    assert.strictEqual(fs.existsSync(path.join(root, '.spotify-credentials.json')), true);
    assert.strictEqual(fs.existsSync(path.join(root, '.qishui-oauth.json')), true);
    assert.strictEqual(fs.existsSync(path.join(root, 'current-fx-autosave.json')), true);

    assert.strictEqual(gate.unlock('世界和气').error, 'LOGIN_EASTER_EGG_INVALID');
    // 彩蛋从打字改成选择框后，界面提交的是它显示的那一个词，所以四种语言的写法都要放行；
    // 少写一种，那个语言的用户就会点不动。答案清单与词典的对应关系在下面单独校验。
    // After the switch to a select box the UI submits the label it shows, so every localized
    // spelling has to pass — miss one and that language cannot unlock at all. The link between
    // the answer list and the dictionaries is checked separately below.
    LOGIN_EASTER_EGG_ANSWERS.forEach((answer) => {
      assert.strictEqual(
        new LoginEasterEggGate({ userDataPath: root }).unlock(answer).unlocked,
        true,
        `${answer} must unlock the gate`
      );
    });
    assert.strictEqual(gate.unlock('世界和平').unlocked, true);

    fs.writeFileSync(path.join(root, '.cookie'), 'new-login', 'utf8');
    const reopened = new LoginEasterEggGate({ userDataPath: root, credentialRoots: () => [migrationRoot], now: () => 5678 });
    const second = await reopened.initialize(async () => { partitionClearCount += 1; });
    assert.strictEqual(second.resetPerformed, false);
    assert.strictEqual(second.unlocked, true);
    assert.strictEqual(partitionClearCount, 1);
    assert.strictEqual(fs.readFileSync(path.join(root, '.cookie'), 'utf8'), 'new-login');

    const state = JSON.parse(fs.readFileSync(path.join(root, 'login-easter-egg.json'), 'utf8'));
    assert.strictEqual(state.gateVersion, LOGIN_EASTER_EGG_GATE_VERSION);
    assert.strictEqual(state.cookieResetVersion, LOGIN_EASTER_EGG_GATE_VERSION);
    assert.strictEqual(state.unlocked, true);
    // 答案清单必须与四份词典逐字一致：界面显示哪个词就提交哪个词，
    // 词典改了一个字而 gate 没跟上，那个语言就会静默点不动，只有玩到那一步才看得出来。
    // The answer list has to match all four dictionaries character for character: the UI submits
    // exactly the label it shows, so a dictionary edit the gate did not follow silently breaks
    // that language and only shows up when someone plays the egg.
    ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'].forEach((lang) => {
      const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'locales', `${lang}.json`), 'utf8'));
      assert.ok(dict[LOGIN_EASTER_EGG_WISH_KEY], `${lang} must define ${LOGIN_EASTER_EGG_WISH_KEY}`);
      assert.ok(
        LOGIN_EASTER_EGG_ANSWERS.includes(dict[LOGIN_EASTER_EGG_WISH_KEY]),
        `${lang}'s ${LOGIN_EASTER_EGG_WISH_KEY} (${dict[LOGIN_EASTER_EGG_WISH_KEY]}) must be in the gate's answer list`
      );
    });
    assert.strictEqual(new Set(LOGIN_EASTER_EGG_ANSWERS).size, LOGIN_EASTER_EGG_ANSWERS.length, 'answers must be unique');

    LOGIN_EASTER_EGG_CREDENTIAL_FILES.forEach((name) => {
      fs.writeFileSync(path.join(root, name), 'replayed-login', 'utf8');
      fs.writeFileSync(path.join(migrationRoot, name), 'replayed-migration-login', 'utf8');
    });
    const replayReset = await reopened.resetForReplay(async () => {
      partitionClearCount += 1;
      fs.writeFileSync(path.join(root, '.cookie'), 'runtime-replay-flush', 'utf8');
      fs.writeFileSync(path.join(migrationRoot, '.cookie'), 'runtime-replay-migration-flush', 'utf8');
    });
    assert.strictEqual(replayReset.ok, true);
    assert.strictEqual(replayReset.replayReset, true);
    assert.strictEqual(replayReset.resetComplete, true);
    assert.strictEqual(replayReset.unlocked, false);
    assert.strictEqual(partitionClearCount, 2);
    LOGIN_EASTER_EGG_CREDENTIAL_FILES.forEach((name) => {
      assert.strictEqual(fs.existsSync(path.join(root, name)), false, `${name} should be cleared for replay`);
      assert.strictEqual(fs.existsSync(path.join(migrationRoot, name)), false, `${name} migration copy should be cleared for replay`);
    });
    assert.strictEqual(fs.existsSync(path.join(root, '.spotify-credentials.json')), true);
    assert.strictEqual(fs.existsSync(path.join(root, '.qishui-oauth.json')), true);
    fs.writeFileSync(path.join(migrationRoot, '.cookie'), 'stale-cookie-before-locked-restart', 'utf8');
    const lockedRestart = new LoginEasterEggGate({ userDataPath: root, credentialRoots: [migrationRoot], now: () => 9012 });
    const lockedStatus = await lockedRestart.initialize(async () => { partitionClearCount += 1; });
    assert.strictEqual(lockedStatus.resetPerformed, false);
    assert.strictEqual(lockedStatus.unlocked, false);
    assert.strictEqual(partitionClearCount, 3, 'a locked restart must audit sessions again');
    assert.strictEqual(fs.existsSync(path.join(migrationRoot, '.cookie')), false, 'locked restart must remove restored migration credentials');
    assert.strictEqual(lockedRestart.unlock('世界和平').unlocked, true, 'replayed gate should unlock again');

    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    assert(main.indexOf('migrateLegacyAuthStorage();') < main.indexOf('await initializeLoginEasterEggGate();'));
    assert(main.indexOf('await initializeLoginEasterEggGate();') < main.indexOf("localServer = require(serverModulePath)"));
    ['netease', 'qq', 'kugou'].forEach((provider) => {
      const marker = `ipcMain.handle('${provider}-music-open-login'`;
      const start = main.indexOf(marker);
      assert(start >= 0, `${provider} login IPC missing`);
      assert(main.slice(start, start + 260).includes('loginEasterEggGate.isUnlocked()'), `${provider} login IPC is not gated`);
    });
    assert(!main.includes("ipcMain.handle('qishui-music-open-login'"), 'Qishui must use the embedded signed QR route, not the legacy login-window IPC');
    assert(main.includes("ipcMain.handle('mineradio-login-easter-egg-reset'"));
    assert(main.includes("loginEasterEggGate.resetForReplay(() => clearAllProviderLoginState('renderer-replay-reset'))"));
    assert(main.includes('credentialRoots: () => ['));
    assert(main.includes("clearAllProviderLoginState('startup-gate')"));

    const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
    assert(preload.includes("resetLoginEasterEgg: () => ipcRenderer.invoke('mineradio-login-easter-egg-reset')"));

    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    ['/api/login/cookie', '/api/login/qr/key', '/api/qq/login/cookie', '/api/kugou/login/cookie', '/api/qishui/login/qrcode', '/api/qishui/login/check']
      .forEach((route) => assert(server.includes(`'${route}'`), `${route} gate missing`));
    assert(!server.includes("pn === '/api/qishui/login/token'"), 'legacy Qishui token-login route must stay removed');
    assert(!server.includes("pn === '/api/qishui/login/cookie'"), 'legacy Qishui cookie-login route must stay removed');
    assert(server.includes('function clearAllRuntimeLoginCredentials(reason)'));
    assert(server.includes('server.clearAllLoginCredentials = clearAllRuntimeLoginCredentials'));

    const accountRenderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
    const renderStart = accountRenderer.indexOf('function renderUserBtn()');
    const renderEnd = accountRenderer.indexOf('\n}', renderStart) + 2;
    const renderUserButton = accountRenderer.slice(renderStart, renderEnd);
    assert(renderUserButton.includes("btn.classList.add('logged-out', 'login-eye-avatar')"));
    assert(renderUserButton.includes('loginEasterEggEyeMarkup(true)'));
    assert(renderUserButton.includes("btn.classList.add('logged-in', 'multi-account', 'external-account-pills')"));
    assert(renderUserButton.includes('renderTopAccountPill(provider)'), 'logged-in state must restore provider account capsules');

    const accountUtils = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
    assert(accountUtils.includes('function providerAccountIdentity(provider, status)'));
    assert(accountUtils.includes('status.nickname'));
    assert(accountUtils.includes('status.displayName'));
    assert(accountUtils.includes('accountIds.indexOf(nickname) !== -1'));
    assert(accountUtils.includes("/^\\d{5,}$/.test(nickname)"));
    assert(!/var identity = status\.userId \|\| status\.uid/.test(accountUtils), 'top account capsules must not prioritize numeric account ids');
    const identityStart = accountUtils.indexOf('function providerAccountIdentity(provider, status)');
    const identityEnd = accountUtils.indexOf('\nfunction renderTopAccountPill', identityStart);
    const identitySandbox = {
      // 取词函数读 window.MineradioI18n；注入 zh-CN 词典桩让合成昵称前缀（酷狗/QQ 音乐等）还原为中文，
      // 否则 "酷狗 99887766" 这类合成昵称会被误当成真实昵称返回。
      // The accessors read window.MineradioI18n; inject the zh-CN stub so the synthetic nickname
      // prefixes ("酷狗", "QQ 音乐", …) resolve back to Chinese, otherwise "酷狗 99887766" is
      // mistaken for a real nickname.
      window: i18nWindow('zh_cn'),
      platformStatus: () => ({}),
      platformMeta: (provider) => ({
        netease: { label: '网易云音乐', short: 'NE' },
        qq: { label: 'QQ 音乐', short: 'QQ' },
        kugou: { label: '酷狗音乐', short: 'KG' },
        qishui: { label: '汽水音乐', short: 'QS' },
      }[provider] || { label: provider, short: provider }),
    };
    // 片段沙箱只装了被切片的那段函数，而取词函数定义在文件头部，必须一起带进去，
    // 否则片段里任何一次取词调用都会以 ReferenceError 中断。
    // The fragment sandbox only holds the sliced function; the accessors it calls live at
    // the top of the file and have to be carried in, or the first call throws.
    vm.runInNewContext(accessorBlock(accountUtils) + '\n' + accountUtils.slice(identityStart, identityEnd) + '\nthis.providerAccountIdentity = providerAccountIdentity;', identitySandbox);
    assert.strictEqual(identitySandbox.providerAccountIdentity('netease', { nickname: '平台昵称', userId: '280213969' }), '平台昵称');
    assert.strictEqual(identitySandbox.providerAccountIdentity('qq', { nickname: 'QQ 123456789', userId: '123456789' }), 'QQ 音乐');
    assert.strictEqual(identitySandbox.providerAccountIdentity('kugou', { nickname: '酷狗 99887766', userId: '99887766' }), '酷狗音乐');

    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'index.css'), 'utf8');
    assert(/#user-btn\.login-eye-avatar[\s\S]{0,180}width:\s*48px[\s\S]{0,180}border-radius:\s*50%/.test(css));
    assert(css.includes('.login-easter-unlock-cinematic.is-extracting'));
    assert(css.includes('@keyframes login-easter-world-float'));
    assert(css.includes('.login-easter-achievement.show'));
    assert(css.includes('.login-easter-achievement-pixel-eyes'));
    assert(css.includes('.login-easter-achievement-pixel-eye.pixel-eye-big'));
    assert(css.includes('width: min(326px, calc(100vw - 76px))'));
    assert(css.includes('top: 34px'));
    assert(css.includes('right: 38px'));
    assert(css.includes('0 0 0 2px #b7b7b7'));
    assert(css.includes('font-smooth: never'));
    assert(css.includes('.login-easter-pixel-glyph'));
    assert(css.includes('image-rendering: pixelated'));
    // 整块可点的一个按钮；打字时代的格子样式必须清干净。
    // 刻意不放下拉箭头：箭头承诺"点开还有别的可选"，而这里点下去就是答案。
    // One clickable field; the cell styling from the typing era has to be gone. No dropdown chevron on
    // purpose: an arrow promises a list to choose from, and there is nothing to choose here.
    assert(css.includes('.login-easter-select {'));
    assert(
      !css.includes('login-easter-select-chevron'),
      'the chevron advertised a dropdown that does not exist and must stay deleted'
    );
    assert(css.includes('font-size: var(--select-font-size, 26px)'));
    assert(!css.includes('.login-easter-cell'), 'the spelling cell styles must be removed');
    assert(!css.includes('.login-easter-input'), 'the invisible typing field styles must be removed');
    // cinematic 的行宽与入场延迟都得跟着词条走，否则俄语会横向溢出。
    // 行宽按 em 反推（--phrase-em 由渲染脚本量出来写入），不再按字数：每个字符占一个全角格会
    // 让英文的字号只有中文的一半。
    // The cinematic row width and the per-glyph delay both follow the label, or Russian overflows
    // horizontally. The row is measured in em (--phrase-em, written by the renderer) instead of by
    // character count: a full em per character capped English at half the size of Chinese.
    assert(css.includes('calc(90vw / var(--phrase-em, 3.86))'));
    assert(!css.includes('--phrase-chars'), 'the character-count model must not come back');
    assert(css.includes('transition-delay: var(--extract-delay, 0s)'));
    assert(css.includes('.login-easter-unlock-phrase span.is-space'));

    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert(html.includes('id="login-easter-unlock-cinematic"'));
    assert(html.includes('id="login-easter-achievement"'));
    assert(html.includes('login-easter-achievement-pixel-eyes'));
    assert(html.includes('id="login-reset-all-btn"'));
    assert(html.includes('onclick="logoutAllAccountsAndResetEasterEgg()"'));
    // 打字已被删干净：输入框、四个字格、以及承载它们的 shell 都不该再出现。
    // The typing path is gone for good: neither the field, the four cells, nor their shell may
    // come back.
    assert(!html.includes('login-easter-egg-input'), 'the typing field must be removed');
    assert(!html.includes('login-easter-egg-cells'), 'the four spelling cells must be removed');
    assert(!html.includes('login-easter-input-shell'), 'the typing shell must be removed');
    // 彩蛋文案全部走 i18n：静态节点声明 data-i18n，硬编码中文只能作为缺键兜底留在标签里。
    // Every easter egg string goes through i18n; the Chinese text may only survive as the
    // in-tag fallback for a missing key.
    ['egg_wish_title', 'egg_wish_world_peace', 'egg_eye_tap_label', 'egg_cinematic_continue',
      'egg_achievement_eyebrow', 'egg_achievement_title', 'egg_achievement_aria'].forEach((key) => {
      assert(html.includes(`data-i18n="${key}"`), `index.html must wire ${key}`);
    });
    ['aria-label="轻触大小眼"', 'aria-label="输入四个字的愿望"', 'aria-label="世界和平，点击继续"',
      'aria-label="已达成成就：世界和平！"', '<h1>心愿是</h1>'].forEach((hardcoded) => {
      assert(!html.includes(hardcoded), `hardcoded copy must be replaced by an i18n key: ${hardcoded}`);
    });
    assert(html.includes('已达成成就'));
    assert(html.includes('世界和平！'));

    const easterEggRenderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '08-account', '00-login-easter-egg.js'), 'utf8');
    assert(easterEggRenderer.includes('playLoginEasterEggUnlockCinematic()'));
    assert(easterEggRenderer.includes('dismissLoginEasterEggCinematic()'));
    assert(easterEggRenderer.includes('showLoginEasterEggAchievement()'));
    assert(easterEggRenderer.includes('prepareLoginEasterEggPixelPhrase(phrase)'));
    // 抗锯齿灰边必须被二值化：像素画只有开/关两态。阈值走具名常量，改烘焙分辨率时能一起看见。
    // The antialiased grey edge has to be quantised — pixel art has two states. The cutoff is a named
    // constant so it stays visible next to the bake resolution.
    assert(easterEggRenderer.includes('pixels.data[i + 3] >= LOGIN_EASTER_EGG_PIXEL_ALPHA_CUTOFF'));
    assert(easterEggRenderer.includes('LOGIN_EASTER_EGG_PIXEL_ALPHA_CUTOFF = 92'));
    assert(easterEggRenderer.includes('requestLoginEasterEggReplayReset()'));
    assert(easterEggRenderer.includes('resetLoginEasterEggUiForReplay()'));
    assert(easterEggRenderer.includes('function playLoginEasterEggAchievementChime()'));
    assert(easterEggRenderer.includes('[2093.00, 0.36, 0.82]'));
    assert(easterEggRenderer.includes('playLoginEasterEggAchievementChime();'));
    // 单选项 + 选择框外形：HTML 里的按钮调它，提交的是界面上显示的那个词。
    // One option dressed as a select box: the HTML button calls it and it submits the label the
    // UI is showing.
    assert(html.includes('onclick="submitLoginEasterEggWish()"'));
    assert(html.includes('id="login-easter-egg-choice"'));
    assert(html.includes('class="login-easter-select-value"'));
    assert(
      !html.includes('login-easter-select-chevron'),
      'the chevron node must not come back into the markup either'
    );
    assert(easterEggRenderer.includes('async function submitLoginEasterEggWish()'));
    assert(easterEggRenderer.includes('requestLoginEasterEggUnlock(loginEasterEggWishLabel())'));
    assert(easterEggRenderer.includes("var LOGIN_EASTER_EGG_WISH_KEY = 'egg_wish_world_peace'"));
    // 打字与 IME 相关的一整套代码必须消失，否则会留下没人调用的焦点修补逻辑。
    // The whole typing/IME layer must be gone, or dead focus-repair code stays behind.
    ['normalizeLoginEasterEggCharacters', 'loginEasterEggVisibleValue', 'renderLoginEasterEggCells',
      'handleLoginEasterEggInput', 'resetLoginEasterEggInputAfterError', 'restoreLoginEasterEggInputSurface',
      'focusLoginEasterEggInput', 'scheduleLoginEasterEggInputFocus', 'clearLoginEasterEggFocusRetries',
      'requestLoginEasterEggKeyboardFocus', 'prefixLocked', 'compositionstart',
      'requestDesktopKeyboardFocus'].forEach((dead) => {
      assert(!easterEggRenderer.includes(dead), `typing-era code must be removed: ${dead}`);
    });
    // cinematic 的逐字格按当前语言现建：词长随语言变化，写死的四个字撑不住。
    // The cinematic builds its glyph boxes from the localized label; a hardcoded four-character
    // markup cannot survive a label whose length changes with the language.
    assert(easterEggRenderer.includes('function buildLoginEasterEggPhrase(phrase, wish)'));
    assert(easterEggRenderer.includes('--phrase-em'));
    assert(easterEggRenderer.includes('--extract-delay'));
    // 字形必须按量出来的字宽烘焙成非正方画布：正方格会把 i 白留半格、把 W 压扁。
    assert(easterEggRenderer.includes('ctx.measureText(glyph).width'), 'the bake must size each cell from the measured advance');
    assert(easterEggRenderer.includes('LOGIN_EASTER_EGG_PIXEL_BAKE_HEIGHT = 40'));
    // 字体栈必须有真实粗体字面：宋体只有一个 400，900 会走合成加粗，把 W 糊成一块；
    // 超黑体面（Arial Black 之类）也不行，它的字杆太粗，会把 W 的三角空隙在烘焙格里填死。
    // The stack needs a genuine bold face: SimSun ships a single 400, so a 900 request is synthesised
    // and smears a W; ultra-black faces are no good either, their stems are thick enough to fill the
    // triangular counters of a W inside a baked cell.
    assert(easterEggRenderer.includes("'Arial'"), 'the bake needs a real bold Latin face');
    assert(easterEggRenderer.includes("'Microsoft YaHei'"), 'Han must fall back to a family with a real bold');
    assert(!easterEggRenderer.includes('900 18px SimSun'), 'the synthetic-bold bake stack must not come back');
    assert(css.includes("font-family: 'Arial'"), 'the fallback text stack needs the same face');

    // 画布必须**两个尺寸都裁**。返回的 em 是调用方排行宽用的数，浏览器定显示宽度时看的是画布自己的
    // 宽高比 —— 两者不一致就是「算的是 0.92em，画出来只有 0.245em」。
    // The canvas must be cut in both directions. The returned em is what the caller lays the row out
    // with, while the browser sizes the display from the canvas's own ratio — when the two disagree the
    // row is computed at 0.92em and painted at 0.245em.
    const wideBake = bakeProbe(34);
    assert.strictEqual(wideBake.canvas.height, 40, 'the bake must pin the canvas height, not leave the default 150');
    assert.strictEqual(wideBake.canvas.width, 40, 'a full-width glyph fills the square bake grid');
    assert.ok(
      Math.abs(wideBake.em - (wideBake.canvas.width / wideBake.canvas.height) * 0.92) < 1e-9,
      'the returned em must equal the canvas ratio, or the row width and the painted width disagree'
    );
    assert.ok(
      wideBake.order.indexOf('set width') < wideBake.order.indexOf('fillText')
      && wideBake.order.indexOf('set height') < wideBake.order.indexOf('fillText'),
      'both sizes must be set before drawing — resizing a canvas clears it'
    );
    assert.deepStrictEqual(
      wideBake.reads[0],
      [wideBake.canvas.width, wideBake.canvas.height],
      'the pixels must be read back over the whole canvas'
    );
    const narrowBake = bakeProbe(9);
    assert.strictEqual(narrowBake.canvas.width, Math.round((9 / 34) * 40));
    assert.ok(
      Math.abs(narrowBake.em - (narrowBake.canvas.width / narrowBake.canvas.height) * 0.92) < 1e-9,
      'a narrow glyph must keep the same identity'
    );
    assert.ok(
      Math.abs(bakeProbe(8 / 34).em - (6 / 40) * 0.92) < 1e-9,
      'a glyph too narrow to round up still keeps a 6px floor and the same identity'
    );
    assert(!html.includes('--float-duration:3.8s'), 'the phrase spans must be built at runtime, not hardcoded');
    // 语言切换后字号与提示文案要自己重算：它们不是 data-i18n 节点，DOM 扫描够不到。
    // The fitted font size and hint copy are recomputed on a language switch because they are not
    // data-i18n nodes and the DOM scan cannot reach them.
    assert(easterEggRenderer.includes('onLanguageChange(function ()'));
    assert(easterEggRenderer.includes('syncLoginEasterEggChoiceFace();'));
    // 揭开前必须退出焦点顺序：面板是透明的，而里面那个选项按钮仍可聚焦，
    // 键盘用户会停在一个看不见的按钮上。可交互性由 revealed 单一推导，不另记一份状态。
    // Before the reveal the panel must leave the focus order: it is transparent while its option
    // button is still focusable, so a keyboard user lands on an invisible button. Interactivity
    // derives from `revealed` alone instead of a second copy of the state.
    assert(/<div id="login-easter-egg-wish"[^>]*\binert\b/.test(html), 'the closed wish panel must start inert');
    assert(easterEggRenderer.includes('function syncLoginEasterEggWishInert()'));
    assert(easterEggRenderer.includes("wish.setAttribute('inert', '')"));
    assert(easterEggRenderer.includes("wish.removeAttribute('inert')"));

    const logoutRenderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'), 'utf8');
    assert(logoutRenderer.includes('function logoutAllAccountsAndResetEasterEgg()'));
    assert(!logoutRenderer.includes("apiJson('/api/spotify/logout')"));
    assert(logoutRenderer.includes('resetAllProviderRendererLoginState()'));
    assert(logoutRenderer.includes('resetLoginEasterEggUiForReplay()'));
    assert(logoutRenderer.includes('armLogoutAllAccountsResetConfirmation()'));
    assert(logoutRenderer.includes("button.textContent = accountPanelText('logout_click_again_confirm')"));
    assert(!logoutRenderer.includes('window.confirm('));

    const splashRenderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '10-shell', '03-splash.js'), 'utf8');
    assert(splashRenderer.includes('function retroChord(frequencies, startAt, dur, peak)'));
    assert(splashRenderer.includes('Am7 -> Fmaj7 -> Cmaj7 -> G6'));
    assert(splashRenderer.includes('[220.00, 261.63, 329.63, 392.00]'));

    const desktopMain = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    assert(desktopMain.includes("ipcMain.handle('mineradio-full-desktop-request-keyboard-focus'"));
    assert(desktopMain.includes("fullDesktopModeRuntime.getStatus('renderer-keyboard-focus-fallback')"));
    assert(desktopMain.includes('if (desktopStatus && desktopStatus.enabled) {'));
    assert(desktopMain.includes('ordinaryWindowImeFocusRepairs.get(webContents)'));
    assert(desktopMain.includes('ordinaryWindowImeFocusRepairs.set(webContents, repair)'));
    assert(desktopMain.includes('webContents.blur();'));
    assert(desktopMain.includes('win.focus();'));
    assert(desktopMain.includes('webContents.focus();'));
    assert(/requestDesktopKeyboardFocus:[\s\S]{0,120}ipcRenderer\.invoke\(/.test(preload));

    console.log('[OK] Login easter egg gate, one-time reset, account identity, cinematic, achievement, and route guards verified.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
