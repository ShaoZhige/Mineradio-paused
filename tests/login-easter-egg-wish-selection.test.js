'use strict';

// ============================================================
//  彩蛋许愿「选择」的字号适配 / Fitted font size for the wish selection
//  彩蛋从「打字四个字」改成「一个选择框外形的按钮」之后，唯一还会随语言变形的量就是字号：
//  选择框宽度固定，而四个语言的许愿词长度差了三倍（中文 4 字、俄语 16 字符），
//  字号不跟着收就会顶破边框 —— 而且只在切到那个语言时才看得出来。
//  这里用四份词典里的真实词条算出实际占宽，逐语言验证放得下。
//  After the egg moved from typing four characters to a single select-box shaped button, the only
//  quantity that still deforms per language is the font size: the field width is fixed while the
//  wish label varies threefold across languages (4 CJK glyphs vs 16 Cyrillic characters), so a
//  size that does not shrink overflows the border — and only when that language is selected.
//  This computes the real width from the four dictionaries and proves every language fits.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  LOGIN_EASTER_EGG_WISH_KEY,
  loginEasterEggLabelEmWidth,
  loginEasterEggPhraseEstimateEm,
} = require('../public/js/modules/08-account/00-login-easter-egg');

const LANGS = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];

const RENDERER_PATH = path.join(__dirname, '..', 'public', 'js', 'modules', '08-account', '00-login-easter-egg.js');
const RENDERER_SOURCE = fs.readFileSync(RENDERER_PATH, 'utf8');
const CSS_PATH = path.join(__dirname, '..', 'public', 'css', 'index.css');
const CSS_SOURCE = fs.readFileSync(CSS_PATH, 'utf8');

// 许愿框宽度 min(390px, 100% - 58px) —— 这里只验最宽的那一档。
// The wish box is min(390px, 100% - 58px) wide; this covers the widest of the two cases.
const FIELD_WIDTH = 390;

// 预留宽度与字号区间从渲染模块里读出来，不手抄：手抄的数字在 CSS 改过之后**依然自洽**，
// 于是测试会跟着一起变绿，而界面上的长词已经被省略号截断了。
// The reserve and the font range are read from the renderer rather than copied by hand: a copied
// number stays self-consistent after the CSS changes, so the test goes green while long labels are
// being cut off with an ellipsis on screen.
function rendererNumber(name) {
  const match = RENDERER_SOURCE.match(new RegExp(`${name} = (\\d+)`));
  assert.ok(match, `${name} must be readable from the renderer`);
  return Number(match[1]);
}
const SELECT_PADDING = rendererNumber('LOGIN_EASTER_EGG_SELECT_PADDING');
const SELECT_MAX_FONT = rendererNumber('LOGIN_EASTER_EGG_SELECT_MAX_FONT');
const SELECT_MIN_FONT = rendererNumber('LOGIN_EASTER_EGG_SELECT_MIN_FONT');

function wishLabel(lang) {
  const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'locales', `${lang}.json`), 'utf8'));
  return dict[LOGIN_EASTER_EGG_WISH_KEY];
}

function fittedFontSize(label) {
  const available = FIELD_WIDTH - SELECT_PADDING;
  const size = Math.floor(available / loginEasterEggLabelEmWidth(label));
  return Math.max(SELECT_MIN_FONT, Math.min(SELECT_MAX_FONT, size));
}

test('四个语言的许愿词在选择框里都放得下', () => {
  const available = FIELD_WIDTH - SELECT_PADDING;
  LANGS.forEach((lang) => {
    const label = wishLabel(lang);
    assert.ok(label, `${lang} must define ${LOGIN_EASTER_EGG_WISH_KEY}`);
    const size = fittedFontSize(label);
    const used = size * loginEasterEggLabelEmWidth(label);
    assert.ok(
      used <= available,
      `${lang}: "${label}" needs ${used.toFixed(1)}px but only ${available}px is available (font ${size}px)`
    );
    assert.ok(size >= SELECT_MIN_FONT, `${lang}: fitted font ${size}px falls below the readable floor`);
  });
});

test('估算的占宽不会把最长语言的字号压到下限以下', () => {
  // 俄语是最长的一条；它应当只被压到足以放下的字号，而不是一路撞到下限。
  // Russian is the longest label; it should be eased down just enough to fit, not slammed into
  // the floor.
  const size = fittedFontSize(wishLabel('ru_ru'));
  assert.ok(size > SELECT_MIN_FONT, `Russian should not need the ${SELECT_MIN_FONT}px floor, got ${size}px`);
  assert.ok(size <= SELECT_MAX_FONT);
});

test('脚本预留的宽度正好覆盖 CSS 的横向内边距', () => {
  // 字号是「按钮宽度 - SELECT_PADDING」除出来的，所以那个常数就是 CSS 内边距的影子：
  // 留大了长词白小一圈（中文这种短词看不出来），留小了俄语会被省略号截断。
  // The font size is "button width - SELECT_PADDING" divided by the label width, so the constant is a
  // shadow of the CSS padding: too much and long labels are drawn needlessly small (invisible in the
  // three short languages), too little and Russian gets cut off with an ellipsis.
  const rule = CSS_SOURCE.slice(
    CSS_SOURCE.indexOf('.login-easter-select {'),
    CSS_SOURCE.indexOf('.login-easter-select:hover')
  );
  const padding = rule.match(/padding:\s*0\s+(\d+)px(?:(\s+0\s+(\d+)px))?;/);
  assert.ok(padding, 'the .login-easter-select rule must declare a horizontal padding');
  const right = Number(padding[1]);
  const left = padding[3] === undefined ? right : Number(padding[3]);
  const borders = 2 * Number((rule.match(/border:\s*(\d+)px/) || [])[1] || 2);
  const needed = left + right + borders;
  assert.ok(
    SELECT_PADDING >= needed,
    `SELECT_PADDING (${SELECT_PADDING}) must cover the CSS padding ${left}+${right} plus ${borders}px of border`
  );
  assert.ok(
    SELECT_PADDING - needed <= 6,
    `SELECT_PADDING (${SELECT_PADDING}) leaves ${SELECT_PADDING - needed}px unused, shrinking every label for nothing`
  );
  // 箭头删掉之后右侧不再需要额外留位，内边距必须左右对称，词条才是正的居中。
  // With the chevron gone the right side needs no extra room any more, and symmetric padding is what
  // keeps a centred label actually centred.
  assert.strictEqual(left, right, 'the padding must be symmetric now that the chevron is gone');
});

test('字宽估算把 CJK 记作全角、拉丁与西里尔记作半角', () => {
  // 注意方向：四个汉字是 4em，而「World Peace」虽然只有 10 个字母、按半角算却有 5.9em，
  // 是四个语言里第二宽的。所以字号适配不是"非中文才要收"，中文反而最宽松。
  // Mind the direction: four Han glyphs are 4em, while "World Peace" is 10 letters but 5.9em at
  // half width — the second widest of the four. So the fitting is not a "non-Chinese problem";
  // Chinese is in fact the roomiest.
  assert.ok(Math.abs(loginEasterEggLabelEmWidth('世界和平') - 4) < 0.01, 'four CJK glyphs are 4em');
  assert.ok(loginEasterEggLabelEmWidth('World Peace') > loginEasterEggLabelEmWidth('世界和平'));
  assert.ok(loginEasterEggLabelEmWidth('Мир во всём мире') > loginEasterEggLabelEmWidth('World Peace'));
});

test('空词条也给出可除的宽度', () => {
  // 词典还没加载出来时取词会拿到空串或键名；宽度为 0 会让除法算出 Infinity。
  // Before the dictionary arrives the accessor can return an empty string or a bare key; a width
  // of zero would make the division yield Infinity.
  assert.strictEqual(loginEasterEggLabelEmWidth(''), 1);
  assert.strictEqual(loginEasterEggLabelEmWidth(null), 1);
  assert.ok(Number.isFinite(FIELD_WIDTH / loginEasterEggLabelEmWidth('')));
  // 行宽同理：空词条必须给出有限值，CSS 里的 90vw / var(--phrase-em) 才不会是 NaN。
  // Same for the row width: an empty label has to yield a finite number so the 90vw / var(--phrase-em)
  // in the CSS never becomes NaN.
  assert.strictEqual(loginEasterEggPhraseEstimateEm(''), 0);
  assert.strictEqual(loginEasterEggPhraseEstimateEm(null), 0);
  assert.strictEqual(loginEasterEggPhraseEstimateEm('世'), 0.92);
});

test('全屏短语的字号按整行 em 反推，四种语言都远超旧的字数上限', () => {
  // 旧模型是"每个字符一个 1em 方格"：行宽 = 字符数 em，字号同时被 132px 的上限和 80vw/字符数 压住，
  // 于是同一屏宽里英文的字母只有中文的一半大 —— 而 W 那种四条斜线的字在 20 像素的烘焙格里还会
  // 连成一片。新模型按量出来的字宽给格子（拉丁 .56em、空格 .34em、汉字 1em），同屏宽能放下大得多的字号。
  // The old model gave every character a 1em square, so the row was "character count" em wide and the
  // size was pinned both by a 132px ceiling and by 80vw/count — English letters came out at half the
  // size of Chinese on the same screen, and a glyph of four diagonals merged inside the 20-pixel bake
  // cell. The new model sizes cells from the measured advance (.56em Latin, .34em space, 1em Han),
  // which fits a much larger size in the same width.
  const VIEWPORT = 1920;
  const OLD_CEILING = 132;
  // 估算按 .56em 记一个字母，而真机上 Arial Bold 更宽（实测英文 +14%、俄语 +22%），所以断言不能拿
  // 这个偏乐观的估算给自己发合格证 —— 再留 25% 当悲观上界，断言讲的是"真机上最坏能拿到多少"。
  // The estimator charges .56em per letter while Arial Bold measures wider on a real machine (English
  // +14%, Russian +22%), so the assertion must not grade itself against that optimistic estimate: add
  // 25% as a pessimistic bound so it states what the real render is guaranteed to reach.
  const MEASURED_SAFETY = 1.25;
  const sizeFor = (em, viewport) => {
    const preferred = Math.min(Math.max(72, 0.13 * viewport), 240);
    return Math.min(preferred, (0.90 * viewport) / em);
  };
  const fittedSize = (label) => sizeFor(loginEasterEggPhraseEstimateEm(label) * MEASURED_SAFETY, VIEWPORT);
  LANGS.forEach((lang) => {
    const label = wishLabel(lang);
    const em = loginEasterEggPhraseEstimateEm(label);
    assert.ok(em > 0 && Number.isFinite(em), `${lang}: the row width must be a positive em count`);
    assert.ok(
      em <= Array.from(label).length,
      `${lang}: a proportional cell can never be wider than one em per character, got ${em}em`
    );
    const size = fittedSize(label);
    assert.ok(
      size >= OLD_CEILING * 1.2,
      `${lang}: even allowing ${(MEASURED_SAFETY - 1) * 100}% for the wider measured cells, the fitted ${size.toFixed(0)}px must beat the old ${OLD_CEILING}px ceiling`
    );
    // 硬约束：整行必须留在 90vw 以内（按悲观 em 算，真机上只会更短），否则会顶到屏幕边上。
    // Hard constraint: the whole row has to stay inside 90vw (computed with the pessimistic em, so the
    // real row is only shorter), or it runs into the edge of the screen.
    assert.ok(
      em * MEASURED_SAFETY * size <= 0.90 * VIEWPORT + 0.5,
      `${lang}: the row (${(em * MEASURED_SAFETY * size).toFixed(0)}px) must stay inside 90vw`
    );
  });
  // 跨视口扫一遍 90vw 这条硬约束：字号被上限夹住时应随视口线性放大，触到 90vw 后转为反比收字号 ——
  // 两个分支都不能顶破屏幕。写死单一视口的话，把 min() 写成 max()、或漏掉 90vw 那一项都测不出来。
  // Sweep the 90vw hard constraint across viewports: while the ceiling binds the size grows linearly
  // with the viewport, and once 90vw binds it shrinks inversely — neither branch may overflow. A single
  // hardcoded viewport cannot catch a min() turned into a max() or a dropped 90vw term.
  const widest = LANGS.reduce((worst, lang) => {
    const em = loginEasterEggPhraseEstimateEm(wishLabel(lang)) * MEASURED_SAFETY;
    return em > worst.em ? { lang, em } : worst;
  }, { lang: '', em: 0 });
  let sawCeiling = false;
  let sawFit = false;
  [1024, 1280, 1440, 1920, 2560, 3840].forEach((viewport) => {
    const size = sizeFor(widest.em, viewport);
    assert.ok(
      widest.em * size <= 0.90 * viewport + 0.5,
      `${widest.lang} at ${viewport}px: the row (${(widest.em * size).toFixed(0)}px) must stay inside 90vw`
    );
    if (size === 240) sawCeiling = true; else sawFit = true;
  });
  assert.ok(sawCeiling && sawFit, 'the sweep must exercise both the 240px ceiling and the 90vw constraint');
  // 模型对比：同样的断言套在旧模型（每字符 1em）上，英文根本过不去 —— 这条断言不是恒真的。
  // Model comparison: run the same requirement against the old per-character model and English cannot
  // clear it — the assertion is not vacuous.
  const oldModelEm = Array.from(wishLabel('en_us')).length;
  assert.ok(
    sizeFor(oldModelEm, VIEWPORT) < OLD_CEILING * 1.2,
    'the old per-character model must fail the same requirement English now passes'
  );
  // 汉字仍是全角格；拉丁不再是。
  assert.ok(Math.abs(loginEasterEggPhraseEstimateEm('世界和平') - 3.86) < 0.02, 'four Han glyphs are still four cells');
  assert.ok(
    loginEasterEggPhraseEstimateEm(wishLabel('en_us')) < Array.from(wishLabel('en_us')).length * 0.8,
    'English must stop paying a full em per letter, or its font stays at half of Chinese'
  );
});

// ============================================================
//  提交路径的真机验证 / The submission path, actually executed
//  结构断言只能证明「代码里写着 submit 界面上的那个词」；这里把模块放进沙箱真跑一遍，
//  换语言再跑一遍，直接看交给主进程的字符串是什么。这条不变量一旦破了，彩蛋会在某个
//  语言下彻底点不动，而且在中文环境里完全测不出来。
//  A structural assertion only proves the source *says* it submits the label on screen. This
//  runs the module for real, once per language, and inspects the string handed to the main
//  process. Break this and the egg becomes unclickable in one language while Chinese looks fine.
// ============================================================
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'modules', '08-account', '00-login-easter-egg.js');

function dictionariesByLang() {
  return LANGS.reduce((acc, lang) => {
    acc[lang] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'locales', `${lang}.json`), 'utf8'));
    return acc;
  }, {});
}

function createWishHarness(initialLang, options) {
  const settings = options || {};
  const dicts = dictionariesByLang();
  let currentLang = initialLang;
  const submitted = [];
  const classList = () => ({ list: new Set(), add(c) { this.list.add(c); }, remove(c) { this.list.delete(c); }, contains(c) { return this.list.has(c); } });
  const elements = {};
  const makeElement = (id) => {
    const node = {
      id,
      textContent: '',
      dataset: {},
      className: '',
      offsetWidth: 0,
      clientWidth: FIELD_WIDTH,
      children: [],
      style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; }, getPropertyValue(k) { return this[k]; } },
      classList: classList(),
      attributes: {},
      setAttribute(name, value) { node.attributes[name] = value; },
      removeAttribute(name) { delete node.attributes[name]; },
      focus() {},
      // canvas 用不到：像素化那一步在拿不到 2d 上下文时会自己退出。
      // The canvas is not needed: the pixelation step bails out on its own without a 2d context.
      getContext() { return null; },
      appendChild(child) { node.children.push(child); },
      querySelector() { return null; },
    };
    elements[id] = node;
    return node;
  };
  ['login-easter-egg-choice', 'login-easter-status', 'login-easter-egg-wish', 'login-easter-hint',
    'login-easter-eye-trigger', 'login-easter-unlock-phrase', 'login-easter-unlock-cinematic',
    'login-easter-egg-gate'].forEach(makeElement);

  const sandbox = {
    console,
    Promise,
    Array,
    String,
    Number,
    Date,
    Math,
    JSON,
    Object,
    Set,
    RegExp,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  };
  sandbox.document = {
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => [],
    createElement: () => makeElement('span-' + Math.random().toString(16).slice(2)),
    addEventListener() {},
    documentElement: {},
  };
  sandbox.window = {
    localStorage: sandbox.localStorage,
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    addEventListener() {},
    MineradioI18n: {
      // 只实现本模块用到的三个入口；t() 走真实词典，缺键返回键名。
      // Only the three entry points this module uses; t() reads the real dictionaries and
      // returns the key when it is missing.
      t(key) { return Object.prototype.hasOwnProperty.call(dicts[currentLang], key) ? dicts[currentLang][key] : key; },
      htmlLang() { return 'xx'; },
      onLanguageChange() {},
    },
    desktopWindow: {
      getLoginEasterEggStatus: () => Promise.resolve({ ok: true, unlocked: false }),
      unlockLoginEasterEgg(value) {
        submitted.push(value);
        if (settings.unlockOk) return Promise.resolve({ ok: true, unlocked: true });
        return Promise.resolve({ ok: false, unlocked: false, error: 'LOGIN_EASTER_EGG_INVALID' });
      },
    },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(MODULE_PATH, 'utf8') + '\nthis.__egg = {' +
      ' submit: submitLoginEasterEggWish,' +
      ' tap: handleLoginEasterEggTap,' +
      ' syncInert: syncLoginEasterEggWishInert,' +
      ' state: loginEasterEggState' +
      '};',
    sandbox
  );
  return {
    sandbox,
    elements,
    submitted,
    setLang: (lang) => { currentLang = lang; },
  };
}

test('提交给主进程的就是界面上那个词，且跟随语言', async () => {
  for (const lang of LANGS) {
    const harness = createWishHarness(lang);
    const dict = dictionariesByLang()[lang];
    await harness.sandbox.__egg.submit();
    assert.strictEqual(harness.submitted.length, 1, `${lang}: one click must submit exactly once`);
    assert.strictEqual(harness.submitted[0], dict[LOGIN_EASTER_EGG_WISH_KEY], `${lang}: submitted value must be the label on screen`);
    // 主进程拒了之后要给出提示，不能一声不响。
    // A rejected submit has to say something rather than staying silent.
    assert.strictEqual(harness.elements['login-easter-status'].textContent, dict.egg_status_retry);
  }
});

test('语言在运行时切换后，提交的词跟着换', async () => {
  // 取词发生在点击那一刻而不是加载那一刻；如果换语言后提交的还是旧语言的词，
  // 主进程会判无效而界面上完全看不出原因。
  // The label is read at click time rather than at load time. If a language switch kept
  // submitting the old spelling, the main process would reject it with nothing on screen to
  // explain why.
  const dicts = dictionariesByLang();
  const harness = createWishHarness('zh_cn');
  await harness.sandbox.__egg.submit();
  harness.setLang('ru_ru');
  await harness.sandbox.__egg.submit();
  assert.deepStrictEqual(
    harness.submitted,
    [dicts.zh_cn[LOGIN_EASTER_EGG_WISH_KEY], dicts.ru_ru[LOGIN_EASTER_EGG_WISH_KEY]]
  );
  assert.notStrictEqual(harness.submitted[0], harness.submitted[1], 'the two languages must differ or this proves nothing');
});

test('点眼睛的提示文案随语言走，第五下揭开面板', () => {
  const harness = createWishHarness('ru_ru');
  const dict = dictionariesByLang().ru_ru;
  // 提示按点击数逐级推进：看一眼 → 再点几下 → 有点紧张 → 还差一下，第五下揭开。
  // The hints escalate with the tap count: a glance, keep tapping, getting nervous, one more —
  // and the fifth tap reveals the panel.
  ['egg_hint_glance', 'egg_hint_tap_more', 'egg_hint_nervous', 'egg_hint_one_more'].forEach((key, index) => {
    harness.sandbox.__egg.tap();
    assert.strictEqual(harness.elements['login-easter-hint'].textContent, dict[key], `tap ${index + 1} must show ${key}`);
    assert.strictEqual(harness.sandbox.__egg.state.revealed, false, `tap ${index + 1} must not reveal the panel yet`);
  });
  harness.sandbox.__egg.tap();
  assert.strictEqual(harness.sandbox.__egg.state.revealed, true, 'the fifth tap reveals the panel');
  assert.strictEqual(harness.elements['login-easter-egg-gate'].classList.contains('is-revealed'), true);
  assert.strictEqual(harness.elements['login-easter-hint'].textContent, '', 'the fifth tap clears the hint');
  assert.strictEqual(harness.submitted.length, 0, 'revealing must not submit anything on its own');
});

test('解锁后的逐字 animation 按当前语言的词长建字格', async () => {
  // cinematic 的字格数就是词长：中文 4 格、俄语 16 格。写死四个字格会让英语和俄语
  // 只显示出前四个字符，或者干脆整段不播（旧代码在字格数不等于 4 时直接跳过动画）。
  // The glyph count is the label length: 4 for Chinese, 16 for Russian. Hardcoded four boxes
  // would show only the first four characters of the other languages — or skip the cinematic
  // entirely, which is what the old guard did whenever the count was not exactly four.
  for (const lang of LANGS) {
    const harness = createWishHarness(lang, { unlockOk: true });
    await harness.sandbox.__egg.submit();
    const label = Array.from(dictionariesByLang()[lang][LOGIN_EASTER_EGG_WISH_KEY]);
    const phrase = harness.elements['login-easter-unlock-phrase'];
    assert.strictEqual(phrase.children.length, label.length, `${lang}: one glyph box per character`);
    // 沙箱里拿不到 2d 上下文，所以字格留着文字、行宽走估算值（真机上像素烘焙会用量出来的字宽覆盖）。
    // The sandbox has no 2d context, so the cells keep their text and the row width comes from the
    // estimate; on a real machine the pixel bake overwrites it with the measured width.
    assert.strictEqual(
      phrase.style['--phrase-em'],
      loginEasterEggPhraseEstimateEm(label).toFixed(3),
      `${lang}: --phrase-em drives the fitted font size`
    );
    // 空格用窄格，否则每个空格都占掉一整格宽度。
    // Spaces get a narrow box, otherwise each one eats a full cell.
    const spaces = phrase.children.filter((span) => span.className === 'is-space').length;
    assert.strictEqual(spaces, label.filter((glyph) => !glyph.trim()).length, `${lang}: space boxes must be marked`);
    // 逐字入场延迟按序号错开。
    // The per-glyph entry delay is staggered by index.
    assert.strictEqual(phrase.children[0].style['--extract-delay'], '0.00s');
    if (label.length > 1) {
      assert.notStrictEqual(phrase.children[1].style['--extract-delay'], '0.00s', `${lang}: glyph delays must stagger`);
    }
  }
});

test('面板揭开前后与重开之后，选项按钮的可聚焦性都由 revealed 推导', () => {
  // 揭开前是透明的，若仍可聚焦，键盘用户会停在一个看不见的按钮上；重开登录面板之后
  // 必须仍然是可交互的 —— 这正是「另记一份状态」最容易出错的来回路径。
  // Before the reveal the panel is transparent, and leaving it focusable parks a keyboard user on
  // an invisible button. Reopening the login panel has to keep it interactive — exactly the round
  // trip where a second copy of the state goes wrong.
  const harness = createWishHarness('zh_cn');
  const wish = harness.elements['login-easter-egg-wish'];
  const egg = harness.sandbox.__egg;
  egg.syncInert();
  assert.ok('inert' in wish.attributes, 'a not-yet-revealed panel must be inert');
  for (let i = 0; i < 5; i++) egg.tap();
  assert.strictEqual(egg.state.revealed, true);
  assert.ok(!('inert' in wish.attributes), 'a revealed panel must be interactive');
  // 关掉登录面板再打开：状态还是 revealed，可交互性必须跟着它走。
  // Close and reopen the login panel: the state is still revealed and interactivity follows it.
  egg.syncInert();
  assert.ok(!('inert' in wish.attributes), 'reopening with a revealed panel must stay interactive');
  // 重置回放后重新回到不可交互。
  // Resetting for a replay puts it back to non-interactive.
  egg.state.revealed = false;
  egg.syncInert();
  assert.ok('inert' in wish.attributes, 'a replay reset must make the panel inert again');
});
