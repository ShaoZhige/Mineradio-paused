// 本模块界面文案统一走 i18n；词典是唯一文案来源。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：
//   loginEasterEggText('key')            —— 推荐。词典缺键时返回键名本身，漏译一眼可见。
//   loginEasterEggText('key', '兜底')     —— 仅在「缺键时该显示什么」有明确要求时用。
//   loginEasterEggText('key', '含 {p} 的模板', {p: v}) —— 带插值，params 同时喂给 t() 与兜底模板。
// 缺键刻意返回键名而不是空串：空串会让漏译静默发生，键名在界面上是一眼能认出的错误。
// Two call shapes. A missing key returns the key itself on purpose: an empty string would make
// an untranslated string fail silently, while a bare key is self-identifying on screen.
function loginEasterEggText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === "object") {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}

// 彩蛋的「答案」是当前语言的许愿词。选择框只展示这一项，显示的词和提交的词必须同源，
// 否则换语言后界面显示的是一句、校验认的又是另一句。
// The answer is the localized wish. The select box shows that one entry, and the label on
// screen has to be the exact string that gets submitted, or a language switch would display
// one sentence while the gate validates another.
var LOGIN_EASTER_EGG_WISH_KEY = 'egg_wish_world_peace';
// 点眼睛要给的提示，索引即点击数。**索引 0 必须有文案**：一次都没点时屏幕上只有一个圆眼睛
// 和一个空 div，用户会把它当成加载失败/卡死（issue #332 就是这么报的）。索引 5 之后为空，
// 因为那时已经进入许愿面板，提示行会被 CSS 淡出。
// Hints shown as the eye is tapped, indexed by tap count. **Index 0 must carry copy**: with no
// tap yet the screen is one round eye plus an empty div, which reads as a frozen gate (that is
// exactly how issue #332 was reported). Index 5 and up stay empty because the wish panel takes
// over and CSS fades the hint row out.
var LOGIN_EASTER_EGG_HINT_KEYS = ['egg_hint_idle', 'egg_hint_glance', 'egg_hint_tap_more', 'egg_hint_nervous', 'egg_hint_one_more', ''];
// 选择框字号的自适应区间：宽度固定，长词（俄语 16 字符）必须收字号。
// Fitted font-size range for the select box: the width is fixed, so long labels (16 Cyrillic
// characters) have to shrink.
var LOGIN_EASTER_EGG_SELECT_MAX_FONT = 26;
var LOGIN_EASTER_EGG_SELECT_MIN_FONT = 13;
// 从可用宽度里减掉的横向预留：左右各 26px 内边距 + 2px 边框 + 2px 余量。**必须跟着
// .login-easter-select 的 padding 走** —— 留多了字会白小一圈（词都很短时看不出来），
// 留少了长词会被省略号截掉。
// Horizontal reserve subtracted from the usable width: 26px of padding on each side, 2px of border
// and 2px of slack. **It has to track the padding of .login-easter-select**: too much and the label
// is drawn needlessly small (invisible while the labels are short), too little and long labels get
// cut off with an ellipsis.
var LOGIN_EASTER_EGG_SELECT_PADDING = 54;
// 全屏短语的排版模型：字格高度统一、宽度按字形本身的比例给。
// 高度统一 = 所有字共享同一条基线（画布等高 + 同一个 middle 基线 y）；宽度按比例 = 拉丁与西里尔
// 不再每个字母白占一个全角格，于是同一屏宽里字号能放大近一倍。汉字本来就是全角，比例仍是 1。
// Layout model for the full-screen phrase: a uniform cell height with per-glyph widths. The uniform
// height is what keeps every glyph on one shared baseline (equal canvases, the same 'middle' baseline
// y); the proportional width is what stops Latin and Cyrillic from paying a full em per letter, which
// is what used to cap English at about half the size of Chinese on the same screen. Han glyphs are
// full-width anyway, so their ratio stays 1.
var LOGIN_EASTER_EGG_PHRASE_CELL_EM = 0.92;   // 字格高度占字号的比例（与 CSS 的 .92em 对齐）
var LOGIN_EASTER_EGG_PHRASE_GAP_EM = 0.06;    // 字格间距（与 CSS 的 gap 对齐）
var LOGIN_EASTER_EGG_PHRASE_SPACE_EM = 0.34;  // 空格字格宽度（与 CSS 的 .is-space 对齐）
// 像素烘焙：画布统一 40 高、字号 34。20 高的旧尺寸放不下 W 这种四条斜线的字 —— 笔画在那一格里
// 会连成一片，再被放大到屏幕上就是一团白。
// Pixel bake: every canvas is 40 tall with a 34px font. The old 20px grid could not hold a glyph made
// of four diagonals — the strokes merged inside the cell, and upscaling to the screen turned that into
// a white blob.
var LOGIN_EASTER_EGG_PIXEL_BAKE_HEIGHT = 40;
var LOGIN_EASTER_EGG_PIXEL_BAKE_FONT = 34;
// 字体栈必须给出**真实的粗体字面**：旧栈以 SimSun 打头，宋体只有一个 400 字面，900 那一档整个
// 是合成的（在 Electron 里实测：400→900 字重，W 的墨迹从 194 像素涨到 249 像素而字宽几乎不动），
// 合成出来的 W 在 20 像素高的烘焙格里**一个内部空隙都不剩**，整块实心 —— 那就是"糊成一团"。
// 这里以 Arial 打头，W 拿到的是真实的 Arial Bold 轮廓；900 这一档浏览器仍会再叠一层模拟加粗
// （实测比 700 档墨迹多 28%、字宽 0.944em→1.0em），但 40 像素的格子里空隙还留着 32 处，代价可接受。
// 汉字回退到雅黑 Bold（实测 700 与 900 完全一致 = 真的拿到了 Bold 字面，没有叠模拟），西里尔
// Arial 本身就覆盖。
// 刻意不用 Arial Black 这类超黑体面：它们的字杆更粗，W 三个三角空隙在 40 像素的烘焙格里只剩
// 一两个像素，二值化之后就并成一块了 —— 那正是要修的病。
// The stack has to offer a **real bold face**: the old one led with SimSun, which ships a single 400
// face, so the whole 900 step was synthesised (measured in Electron: going 400 -> 900 moved the W's
// ink from 194px to 249px while the advance barely changed), and the synthesised W kept **not one
// counter** in a 20px-tall bake — a solid block, which is the "smeared into a blob" report.
// Leading with Arial gives the W genuine Arial Bold outlines; the browser still layers a simulated
// bold pass on top at 900 (measured: 28% more ink than the 700 step, advance 0.944em -> 1.0em), but a
// 40px cell still holds 32 counters, so that cost is acceptable. Han falls back to YaHei Bold (700 and
// 900 measured identical — a real bold face, no extra simulation), and Arial covers Cyrillic itself.
// Ultra-black faces are deliberately avoided: their stems are thicker, which leaves a W's three
// triangular counters one or two pixels wide in a 40px bake, and thresholding merges them back into a
// blob — exactly the defect being fixed.
var LOGIN_EASTER_EGG_PIXEL_FONT_STACK = "'Arial', 'Segoe UI', 'Microsoft YaHei', SimHei, sans-serif";
// 透明度阈值：把抗锯齿的灰边二值化成实心像素，像素画只有开/关两态。
// Alpha cutoff: quantises the antialiased grey edge into solid pixels; pixel art has only two states.
var LOGIN_EASTER_EGG_PIXEL_ALPHA_CUTOFF = 92;
// 解锁电影的时间线。这几个数字必须与 CSS 里的 --cine-* 对齐：脚本用它们算「什么时候进入
// 稳定态」，算早了最后一个字还没落位就浮起来，算晚了又是一段干等着没人动。
// The unlock timeline. These have to track the --cine-* variables in CSS: they decide when the row
// counts as settled — too early and it floats before the last glyph has landed, too late and there
// is a stretch with nothing moving at all.
var LOGIN_EASTER_EGG_GLYPH_STAGGER_MS = 70;
var LOGIN_EASTER_EGG_GLYPH_IN_MS = 900;
// reduce 下没有位移，只剩一段 .34s 的淡入（与 CSS 的 --cine-glyph-in 对齐）。
// Under reduce there is no movement, only a .34s fade (tracks --cine-glyph-in in CSS).
var LOGIN_EASTER_EGG_GLYPH_IN_MS_REDUCED = 340;
var LOGIN_EASTER_EGG_STAGGER_SPREAD_MS = 620;
// 字要等黑幕铺过大半才入场，否则它亮起来时门面板和播放器界面都还在，看着就是"字和卡片重叠"。
// 这个值必须等于 CSS 的 --cine-glyph-lead（= --cine-veil-in × .55）：normal 1.05s × .55 ≈ 580ms，
// reduce 的 .5s × .55 ≈ 275ms。改 CSS 的 --cine-veil-in 就得同步改这里，否则 settle 会算错。
// The row waits until the veil is well past half, otherwise it lights up while the gate panel and
// the player are both still visible — read as the phrase overlapping the card. This has to equal
// CSS --cine-glyph-lead (--cine-veil-in x .55): 1.05s x .55 ~= 580ms normal, .5s x .55 ~= 275ms
// under reduce. Changing --cine-veil-in means changing these two with it or settle drifts.
var LOGIN_EASTER_EGG_GLYPH_LEAD_MS = 580;
var LOGIN_EASTER_EGG_GLYPH_LEAD_MS_REDUCED = 275;
// 点下去之后这段时间里忽略点击：双击许愿按钮的第二下会落在刚铺满的这一层上，没有死区就会
// 一刀切掉还没开始的画面。
// Clicks are ignored for this long after the press: the second half of a double-click on the wish
// button lands on this freshly mounted layer, and without the guard it cuts the intro off at once.
var LOGIN_EASTER_EGG_CINEMATIC_GUARD_MS = 420;
// 退场定时器要比 CSS 的 --cine-veil-out 晚一点收尾，早了会把还没淡完的黑幕硬切掉；晚了则黑幕
// 已经散尽、登录面板却还没回来，屏幕上是一段空窗（实测 360ms 那一帧什么都没有）。
// reduce 的 --cine-veil-out 是 .42s，所以这一档要跟着缩短。
// The exit timer has to outlast CSS --cine-veil-out or the veil is cut mid-fade; and it must not
// run long, or the veil is already gone while the panel has not returned and the screen sits empty
// (measured: the 360ms frame shows nothing at all). --cine-veil-out is .42s under reduce, so this
// step shrinks with it.
var LOGIN_EASTER_EGG_CINEMATIC_EXIT_MS = 720;
var LOGIN_EASTER_EGG_CINEMATIC_EXIT_MS_REDUCED = 520;
var LOGIN_EASTER_EGG_BROWSER_PREVIEW_KEY = 'mineradio-login-easter-egg-browser-preview-v1';
var loginEasterEggStatusPromise = null;
var loginEasterEggState = {
  ready: false,
  unlocked: false,
  clickCount: 0,
  revealed: false,
  hintKey: '',
  statusKey: '',
  statusMode: '',
  validating: false,
  cinematicActive: false,
  cinematicReady: false,
  cinematicDismissing: false,
  cinematicStartedAt: 0,
  cinematicTimers: [],
  achievementTimer: null
};

function loginEasterEggEyeMarkup(compact) {
  return '<span class="login-easter-eyes' + (compact ? ' compact' : '') + '" aria-hidden="true">' +
    '<i class="login-easter-eye login-easter-eye-big"></i>' +
    '<i class="login-easter-eye login-easter-eye-small"></i>' +
    '</span>';
}

function loginEasterEggBrowserPreviewUnlocked() {
  try { return localStorage.getItem(LOGIN_EASTER_EGG_BROWSER_PREVIEW_KEY) === '1'; } catch (_) { return false; }
}

async function ensureLoginEasterEggStatus(force) {
  if (!force && loginEasterEggState.ready) return loginEasterEggState.unlocked;
  if (!force && loginEasterEggStatusPromise) return loginEasterEggStatusPromise;
  loginEasterEggStatusPromise = (async function () {
    var api = window.desktopWindow;
    var status = null;
    if (api && typeof api.getLoginEasterEggStatus === 'function') {
      try { status = await api.getLoginEasterEggStatus(); } catch (_) { status = null; }
    } else {
      status = { ok: true, unlocked: loginEasterEggBrowserPreviewUnlocked(), browserPreview: true };
    }
    loginEasterEggState.ready = true;
    loginEasterEggState.unlocked = !!(status && status.ok && status.unlocked);
    return loginEasterEggState.unlocked;
  })().finally(function () { loginEasterEggStatusPromise = null; });
  return loginEasterEggStatusPromise;
}

function loginEasterEggAllowsStartupGuide() {
  return loginEasterEggState.ready && loginEasterEggState.unlocked;
}

function setLoginEasterEggMode(locked) {
  var modal = document.getElementById('login-modal');
  if (!modal) return;
  modal.classList.toggle('login-easter-egg-locked', !!locked);
  var gate = document.getElementById('login-easter-egg-gate');
  if (gate) gate.setAttribute('aria-hidden', locked ? 'false' : 'true');
}

function bindLoginEasterEggGate() {
  // 彩蛋唯一还需要键盘支持的地方：cinematic 是一个 role=button 的全屏层，
  // 空格/回车都要能把它收掉。
  // The only keyboard affordance left: the cinematic is a full-screen role=button layer and
  // Space/Enter have to dismiss it.
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  if (!cinematic || cinematic.__loginEasterEggBound) return;
  cinematic.__loginEasterEggBound = true;
  cinematic.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    dismissLoginEasterEggCinematic();
  });
}

async function prepareLoginEasterEggGate() {
  bindLoginEasterEggGate();
  var unlocked = await ensureLoginEasterEggStatus(false);
  setLoginEasterEggMode(!unlocked);
  // 未解锁时先写一次提示行：光靠后面的 tap 才渲染，用户第一次打开看到的是一片空白。
  // Paint the hint row up front while the gate is locked: leaving it for the first tap is what
  // makes the very first screen look blank.
  if (!unlocked) renderLoginEasterEggHint();
  // 面板在被揭开之前是透明的，但里面的选项按钮仍在 Tab 顺序里：键盘一路敲下去会停在
  // 一个看不见的按钮上。inert 让它同时退出焦点顺序与辅助技术树。
  // The panel is transparent before it is revealed yet its option button stays in the tab order,
  // so a keyboard user lands on an invisible button. inert removes it from both the focus order
  // and the accessibility tree.
  syncLoginEasterEggWishInert();
  if (!unlocked) {
    window.setTimeout(function () {
      if (loginEasterEggState.revealed || loginEasterEggState.cinematicActive) return;
      var trigger = document.getElementById('login-easter-eye-trigger');
      if (trigger) trigger.focus({ preventScroll: true });
    }, 220);
  }
  return unlocked;
}

// 可交互性完全由 revealed 推导，不单独记一份状态：否则「先揭开、再关掉重开登录面板」
// 这种来回之后，两处状态会各说各话，选项按钮就再也点不动了。
// Interactivity is derived from `revealed` rather than tracked separately: otherwise the
// reveal-then-close-then-reopen round trip lets the two copies drift apart and the option button
// stops responding for good.
function syncLoginEasterEggWishInert() {
  var wish = document.getElementById('login-easter-egg-wish');
  if (!wish) return;
  if (loginEasterEggState.revealed) wish.removeAttribute('inert');
  else wish.setAttribute('inert', '');
}

function replayLoginEasterEggClass(node, className) {
  if (!node) return;
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

function loginEasterEggPrefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) {
    return false;
  }
}

// 整排字的错开总时长有上限：俄语 16 格按 70ms 一个要 1.05 秒，最后一个字还没出来，前面的
// 已经开始浮了。字数一多就自动收窄步长，整排始终在 .62 秒内出齐。
// The total spread is capped: 16 Russian glyphs at 70ms each take 1.05s, so the first ones are
// already floating before the last has arrived. The step narrows with the count to keep the whole
// row on screen within .62s.
function loginEasterEggGlyphStaggerMs(glyphCount) {
  var count = Math.max(1, Number(glyphCount) || 1);
  if (count < 2) return 0;
  return Math.min(
    LOGIN_EASTER_EGG_GLYPH_STAGGER_MS,
    Math.floor(LOGIN_EASTER_EGG_STAGGER_SPREAD_MS / (count - 1))
  );
}

// 稳定态的时刻 = 黑幕铺过大半（字才开始入场）+ 最后一个字落位 + 一点余量。到这一刻才放开
// 浮动与「点击继续」。
// Settled = the veil has covered most of the screen (only then does the row enter), the last glyph
// has landed, plus a little slack. Only then do the float and the click affordance come in.
function loginEasterEggCinematicSettleMs(glyphCount) {
  if (loginEasterEggPrefersReducedMotion()) {
    return LOGIN_EASTER_EGG_GLYPH_LEAD_MS_REDUCED + LOGIN_EASTER_EGG_GLYPH_IN_MS_REDUCED + 120;
  }
  return LOGIN_EASTER_EGG_GLYPH_LEAD_MS
    + Math.max(0, Number(glyphCount) - 1) * loginEasterEggGlyphStaggerMs(glyphCount)
    + LOGIN_EASTER_EGG_GLYPH_IN_MS + 140;
}

// 时间线全部挂在这里登记，退场 / 重放 / 重置都能一次清干净：漏一个定时器就会出现
// 「重开之后上一轮的画面自己冒出来」。
// Every timer goes through this list so exit, replay and reset can clear them in one call; one
// missed timer and the previous run's cinematic pops back up on the next open.
function clearLoginEasterEggCinematicTimers() {
  var timers = loginEasterEggState.cinematicTimers || [];
  timers.forEach(function (id) {
    if (id === null || id === undefined) return;
    try { window.clearTimeout(id); } catch (_) { }
    try { window.cancelAnimationFrame(id); } catch (_) { }
  });
  loginEasterEggState.cinematicTimers = [];
}

function renderLoginEasterEggHint() {
  var hint = document.getElementById('login-easter-hint');
  if (!hint) return;
  // 一次都没点时也显示提示（hintKey 初始为空），否则首屏只有一个圆眼睛。
  // Keep the hint on screen before the first tap too — an empty hintKey would leave the first
  // screen with nothing but a round eye.
  var key = loginEasterEggState.hintKey
    || (loginEasterEggState.clickCount === 0 ? LOGIN_EASTER_EGG_HINT_KEYS[0] : '');
  hint.textContent = key ? loginEasterEggText(key) : '';
}

function handleLoginEasterEggTap() {
  if (loginEasterEggState.revealed) {
    var choice = document.getElementById('login-easter-egg-choice');
    if (choice) {
      try { choice.focus({ preventScroll: true }); } catch (_) { }
    }
    return;
  }
  loginEasterEggState.clickCount = Math.min(5, loginEasterEggState.clickCount + 1);
  var trigger = document.getElementById('login-easter-eye-trigger');
  // 最后一下**不抖**。抖动是给「一下一下按」这个过程配的手感，而最后一下的手感是「门开了」；
  // 更要紧的是 `tap-feedback` 的 animation 会盖住 `is-revealed` 里那句
  // `transform: translateY(-146px) scale(.82)` —— 只要还在抖，眼睛就上不去，必须等这 480ms
  // 播完才让位，看起来就是「按了却卡一下才反应」。所以触发揭示的这一次既不挂类，也顺手把
  // 前一下（可能还没播完）的余震清掉。
  // The last tap does **not** shake. The shake belongs to the "tap, tap, tap" build-up; the last
  // tap's feel is "the door opens". Worse, the `tap-feedback` animation outranks the
  // `transform: translateY(-146px) scale(.82)` in `is-revealed`, so the eye cannot start moving up
  // until those 480ms are over — which reads as a stutter right when it should react. The tap that
  // reveals therefore never gets the class, and clears any leftover shake from the previous one.
  var revealingTap = loginEasterEggState.clickCount >= 5;
  if (trigger) {
    if (revealingTap) {
      trigger.classList.remove('tap-feedback');
      trigger.style.removeProperty('--egg-tap-strength');
    } else {
      trigger.style.setProperty('--egg-tap-strength', String(loginEasterEggState.clickCount));
      replayLoginEasterEggClass(trigger, 'tap-feedback');
    }
  }
  loginEasterEggState.hintKey = LOGIN_EASTER_EGG_HINT_KEYS[loginEasterEggState.clickCount] || '';
  renderLoginEasterEggHint();
  if (revealingTap) revealLoginEasterEggWish();
}

function revealLoginEasterEggWish() {
  loginEasterEggState.revealed = true;
  var gate = document.getElementById('login-easter-egg-gate');
  if (gate) gate.classList.add('is-revealed');
  syncLoginEasterEggWishInert();
  syncLoginEasterEggChoiceFace();
  var choice = document.getElementById('login-easter-egg-choice');
  if (choice) {
    try { choice.focus({ preventScroll: true }); } catch (_) { }
  }
}

function loginEasterEggWishLabel() {
  return loginEasterEggText(LOGIN_EASTER_EGG_WISH_KEY);
}

// 按字宽估算词条占多少 em：CJK 全角记 1，拉丁/西里尔记 .56，空格记 .3。
// Estimate the label width in em: 1 for a full-width CJK glyph, .56 for Latin/Cyrillic, .3 for
// a space.
function loginEasterEggLabelEmWidth(label) {
  var total = 0;
  Array.from(String(label || '')).forEach(function (glyph) {
    if (/\s/.test(glyph)) total += 0.3;
    else if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(glyph)) total += 1;
    else total += 0.56;
  });
  return total || 1;
}

// 选择框宽度固定，长词要收字号才放得下；四个语言里最长的是俄语。
// The field width is fixed, so a long label needs a smaller size; Russian is the longest of the
// four languages.
function syncLoginEasterEggChoiceFace() {
  var button = document.getElementById('login-easter-egg-choice');
  if (!button) return;
  var available = button.clientWidth - LOGIN_EASTER_EGG_SELECT_PADDING;
  // 面板还没显示出来时量不到宽度，交给 CSS 里的默认字号。
  // The panel has no layout while hidden, so leave the CSS default in place.
  if (!(available > 0)) {
    button.style.removeProperty('--select-font-size');
    return;
  }
  var size = Math.floor(available / loginEasterEggLabelEmWidth(loginEasterEggWishLabel()));
  size = Math.max(LOGIN_EASTER_EGG_SELECT_MIN_FONT, Math.min(LOGIN_EASTER_EGG_SELECT_MAX_FONT, size));
  button.style.setProperty('--select-font-size', size + 'px');
}

function setLoginEasterEggStatus(key, mode) {
  loginEasterEggState.statusKey = key || '';
  loginEasterEggState.statusMode = mode || '';
  var status = document.getElementById('login-easter-status');
  if (!status) return;
  status.textContent = loginEasterEggState.statusKey ? loginEasterEggText(loginEasterEggState.statusKey) : '';
  status.dataset.mode = loginEasterEggState.statusMode;
}

async function requestLoginEasterEggUnlock(value) {
  var api = window.desktopWindow;
  if (api && typeof api.unlockLoginEasterEgg === 'function') {
    return api.unlockLoginEasterEgg(value);
  }
  // 浏览器预览态没有主进程可问，只认当前语言显示的那一个词。
  // With no main process to ask, accept exactly the label the UI is showing.
  if (value !== loginEasterEggWishLabel()) return { ok: false, unlocked: false, error: 'LOGIN_EASTER_EGG_INVALID' };
  try { localStorage.setItem(LOGIN_EASTER_EGG_BROWSER_PREVIEW_KEY, '1'); } catch (_) { }
  return { ok: true, unlocked: true, browserPreview: true };
}

async function requestLoginEasterEggReplayReset() {
  var api = window.desktopWindow;
  if (api && typeof api.resetLoginEasterEgg === 'function') {
    return api.resetLoginEasterEgg();
  }
  try { localStorage.removeItem(LOGIN_EASTER_EGG_BROWSER_PREVIEW_KEY); } catch (_) { }
  return { ok: true, unlocked: false, resetComplete: true, replayReset: true, browserPreview: true };
}

function resetLoginEasterEggUiForReplay() {
  if (loginEasterEggState.achievementTimer) window.clearTimeout(loginEasterEggState.achievementTimer);
  clearLoginEasterEggCinematicTimers();
  loginEasterEggStatusPromise = null;
  loginEasterEggState.ready = true;
  loginEasterEggState.unlocked = false;
  loginEasterEggState.clickCount = 0;
  loginEasterEggState.revealed = false;
  loginEasterEggState.hintKey = '';
  loginEasterEggState.validating = false;
  loginEasterEggState.cinematicActive = false;
  loginEasterEggState.cinematicReady = false;
  loginEasterEggState.cinematicDismissing = false;
  loginEasterEggState.cinematicStartedAt = 0;
  loginEasterEggState.achievementTimer = null;
  try { localStorage.removeItem(LOGIN_EASTER_EGG_BROWSER_PREVIEW_KEY); } catch (_) { }
  var active = document.activeElement;
  if (active && typeof active.blur === 'function') {
    try { active.blur(); } catch (_) { }
  }
  setLoginEasterEggStatus('', '');
  renderLoginEasterEggHint();
  syncLoginEasterEggWishInert();
  var phrase = document.getElementById('login-easter-unlock-phrase');
  if (phrase) {
    phrase.textContent = '';
    phrase.style.removeProperty('--phrase-em');
  }
  var hint = document.getElementById('login-easter-unlock-hint');
  if (hint) hint.textContent = '';
  var gate = document.getElementById('login-easter-egg-gate');
  if (gate) gate.classList.remove('is-revealed');
  var trigger = document.getElementById('login-easter-eye-trigger');
  if (trigger) {
    trigger.classList.remove('tap-feedback');
    trigger.style.removeProperty('--egg-tap-strength');
  }
  // 重放时面板必须立刻回来：这里不要淡入，否则重开的门有一秒钟是空窗。
  // On replay the panel has to be back at once: no fade here, or the reopened gate sits empty
  // for a second.
  restoreLoginEasterEggPanel(false);
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  if (cinematic) {
    cinematic.classList.remove('is-mounted', 'is-visible', 'is-settled', 'is-dismissing');
    cinematic.setAttribute('aria-hidden', 'true');
    cinematic.setAttribute('tabindex', '-1');
  }
  var toast = document.getElementById('login-easter-achievement');
  if (toast) toast.classList.remove('show');
  setLoginEasterEggMode(true);
  bindLoginEasterEggGate();
}

async function submitLoginEasterEggWish() {
  if (loginEasterEggState.validating || loginEasterEggState.cinematicActive) return;
  replayLoginEasterEggClass(document.getElementById('login-easter-egg-choice'), 'is-pressed');
  loginEasterEggState.validating = true;
  var result;
  try { result = await requestLoginEasterEggUnlock(loginEasterEggWishLabel()); }
  catch (error) { result = { ok: false, error: String(error && error.message || error) }; }
  if (result && result.ok && result.unlocked) {
    playLoginEasterEggUnlockCinematic();
    return;
  }
  if (result && result.error === 'LOGIN_EASTER_EGG_RESET_INCOMPLETE') {
    setLoginEasterEggStatus('egg_cleanup_incomplete', 'error');
    loginEasterEggState.validating = false;
    return;
  }
  if (result && result.error === 'LOGIN_EASTER_EGG_STATE_WRITE_FAILED') {
    setLoginEasterEggStatus('egg_save_failed', 'error');
    loginEasterEggState.validating = false;
    return;
  }
  // 只剩「词典还没到」这一种可能：此刻界面上的词还不是答案，提示重选而不是判错。
  // The only case left is a dictionary that has not arrived yet, where the label on screen is
  // not the answer yet — ask for another pick instead of reporting a wrong answer.
  setLoginEasterEggStatus('egg_status_retry', 'error');
  replayLoginEasterEggClass(document.getElementById('login-easter-egg-wish'), 'error-shake');
  loginEasterEggState.validating = false;
}

// 整行占多少 em：字格宽（画布比例 × .92）+ 空格窄格 + 字格间距。CSS 拿它把字号卡到刚好铺满。
// How many em the row needs: per-glyph cell (canvas ratio x .92) plus narrow space cells plus the
// gaps between cells. CSS divides the viewport by it to size the font to fit exactly.
function loginEasterEggPhraseEstimateEm(chars) {
  var glyphs = Array.isArray(chars) ? chars : Array.from(String(chars || ''));
  var rowEm = LOGIN_EASTER_EGG_PHRASE_GAP_EM * Math.max(0, glyphs.length - 1);
  glyphs.forEach(function (glyph) {
    rowEm += String(glyph || '').trim()
      ? LOGIN_EASTER_EGG_PHRASE_CELL_EM * loginEasterEggLabelEmWidth(glyph)
      : LOGIN_EASTER_EGG_PHRASE_SPACE_EM;
  });
  return rowEm;
}

// 按当前语言的许愿词现建字格：词长随语言变化，写死在 HTML 里的四个字撑不住。
// Build the glyph boxes from the localized wish; a hardcoded four-character markup cannot
// survive a label whose length changes with the language.
function buildLoginEasterEggPhrase(phrase, wish) {
  var chars = Array.from(String(wish || ''));
  if (!phrase || !chars.length) return [];
  phrase.textContent = '';
  // 先写一个按字宽估算的行宽，像素烘焙那一步会用量出来的真实字宽覆盖它。
  // Write an estimated row width first; the pixel bake overwrites it with the measured one.
  phrase.style.setProperty('--phrase-em', loginEasterEggPhraseEstimateEm(chars).toFixed(3));
  // 逐字入场延迟：字数多时步长自动收窄（见 loginEasterEggGlyphStaggerMs），整排才能在
  // 一个固定窗口内出齐。浮动周期的节奏仍在 CSS 里统一给，逐字不同相位会让字间距一直变。
  // Entry stagger: the step narrows as the count grows (see loginEasterEggGlyphStaggerMs) so the
  // whole row lands inside a fixed window. The float cycle stays shared in CSS — per-glyph phases
  // would make the spacing between glyphs drift.
  var staggerMs = loginEasterEggGlyphStaggerMs(chars.length);
  return chars.map(function (glyph, index) {
    var span = document.createElement('span');
    span.textContent = glyph;
    if (!glyph.trim()) span.className = 'is-space';
    span.style.setProperty('--extract-delay', ((index * staggerMs) / 1000).toFixed(2) + 's');
    phrase.appendChild(span);
    return span;
  });
}

// 把一个字烘焙成像素画布，返回它在行里占多少 em（0 = 烘焙失败，调用方保留文字）。
// Bake one glyph into a pixel canvas and return how many em it occupies in the row (0 = the bake
// failed, and the caller keeps the plain text).
function bakeLoginEasterEggGlyph(canvas, glyph) {
  var height = LOGIN_EASTER_EGG_PIXEL_BAKE_HEIGHT;
  var ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return 0;
  var font = '900 ' + LOGIN_EASTER_EGG_PIXEL_BAKE_FONT + 'px ' + LOGIN_EASTER_EGG_PIXEL_FONT_STACK;
  ctx.font = font;
  // 先量后画，且量完必须重新设一遍上下文状态：给 canvas.width / canvas.height 赋值会重置字号、
  // 对齐与填充色，漏设的话画出来的是默认 10px sans，字格只剩一个小点。
  // Measure first, then set the context state again after resizing: assigning canvas.width or
  // canvas.height resets the font, alignment and fill colour, and skipping that draws the glyph in
  // the default 10px sans.
  var advance = 0;
  try { advance = ctx.measureText(glyph).width; } catch (_) { advance = 0; }
  if (!(advance > 0)) advance = LOGIN_EASTER_EGG_PIXEL_BAKE_FONT;
  canvas.width = Math.max(6, Math.round((advance / LOGIN_EASTER_EGG_PIXEL_BAKE_FONT) * height));
  // 高度必须跟着写：只设 width 的话画布保留默认的 150 高，字只画在顶部 height 那一段里。CSS 用
  // `height: .92em; width: auto` 显示，宽度按**画布自己的宽高比**推出来，于是 40:150 这个错比例
  // 会把每个字缩成一条又窄又矮的小痕迹 —— 这正是"字太小、W 糊成一团"的另一半原因。
  // The height must be assigned too: setting only the width leaves the default 150 and draws the glyph
  // inside just the top `height` rows. The CSS shows it with `height: .92em; width: auto`, so the
  // display width is derived from the canvas's own ratio — and a wrong 40:150 ratio shrinks every
  // glyph into a narrow, squat mark, which is the other half of "the letters are too small and a W is
  // a blob".
  canvas.height = height;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // y 对每个字都相同、画布又等高，所以整排字共享一条基线；宽窄只影响字格宽，不影响对齐。
  // The y is identical for every glyph and the canvases share a height, so the row sits on one
  // baseline: a proportional width changes the cell, never the alignment.
  ctx.fillText(glyph, canvas.width / 2, height / 2 + 0.5);
  var pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (var i = 0; i < pixels.data.length; i += 4) {
    var solid = pixels.data[i + 3] >= LOGIN_EASTER_EGG_PIXEL_ALPHA_CUTOFF;
    pixels.data[i] = 255;
    pixels.data[i + 1] = 255;
    pixels.data[i + 2] = 255;
    pixels.data[i + 3] = solid ? 255 : 0;
  }
  ctx.putImageData(pixels, 0, 0);
  // 画布统一按 .92em 高显示，所以这个字格在行里就是「宽高比 × .92」em。
  // Every canvas is displayed .92em tall, so this cell takes (width ratio x .92) em in the row.
  return (canvas.width / height) * LOGIN_EASTER_EGG_PHRASE_CELL_EM;
}

function prepareLoginEasterEggPixelPhrase(phrase) {
  if (!phrase) return 0;
  var children = Array.prototype.slice.call(phrase.children);
  if (!children.length) return 0;
  var rowEm = LOGIN_EASTER_EGG_PHRASE_GAP_EM * (children.length - 1);
  var baked = 0;
  children.forEach(function (charNode) {
    if (!charNode) return;
    var glyph = String(charNode.dataset.pixelGlyph || charNode.textContent || '').trim().slice(0, 1);
    if (!glyph) {
      // 空格不烘焙：没有字形可画，只占一个窄格。
      // Spaces are not baked: there is nothing to draw, so they only take a narrow cell.
      rowEm += LOGIN_EASTER_EGG_PHRASE_SPACE_EM;
      return;
    }
    var cellEm = Number(charNode.dataset.glyphEm) || 0;
    if (!charNode.querySelector('canvas')) {
      var canvas = document.createElement('canvas');
      canvas.className = 'login-easter-pixel-glyph';
      cellEm = bakeLoginEasterEggGlyph(canvas, glyph);
      if (cellEm > 0) {
        charNode.textContent = '';
        charNode.dataset.pixelGlyph = glyph;
        charNode.dataset.glyphEm = String(cellEm);
        charNode.appendChild(canvas);
        baked += 1;
      }
    }
    // 量不到（拿不到 2d 上下文）就退回按字宽估算；字格里留着文字，字号照样算得出来。
    // When the glyph cannot be measured (no 2d context) fall back to the estimated width; the cell
    // keeps its text and the row still fits.
    rowEm += cellEm > 0 ? cellEm : LOGIN_EASTER_EGG_PHRASE_CELL_EM * loginEasterEggLabelEmWidth(glyph);
  });
  // 用量出来的真实行宽覆盖估算值：估算按 .56em 记一个字母，实际 Arial Bold 更宽（俄语那串
  // 西里尔字母量出来 9.53em，估算只有 8.28em，差 15%），差得多了字号就顶着屏幕边。
  // Overwrite the estimate with the measured row width: the estimator charges .56em per letter while
  // Arial Bold is wider (the Russian string measures 9.53em against an 8.28em estimate — 15% off), and
  // that much slack pushes the row off the screen edge.
  phrase.style.setProperty('--phrase-em', rowEm.toFixed(3));
  return baked;
}

// 面板退场完全交给 CSS 里 `login-easter-egg-unlocking` 的 !important 规则（连 gsap 的内联
// opacity 一起压住）。回到界面时由这里补一段淡入：直接拆类会让面板在 cine 已经透明的那一瞬间
// "啪"地跳回来，那又是一次硬切。
// The panel's exit is pure CSS (the !important rule under login-easter-egg-unlocking, which also
// beats gsap's inline opacity). The way back gets a fade here: removing the class alone snaps the
// panel back the instant the cinematic is already transparent, which is one more hard cut.
function restoreLoginEasterEggPanel(animate) {
  var modal = document.getElementById('login-modal');
  if (!modal) return;
  modal.classList.remove('login-easter-egg-unlocking');
  var panel = modal.querySelector('.modal');
  if (!panel) return;
  if (window.gsap) {
    try {
      window.gsap.killTweensOf(panel);
      if (animate) {
        window.gsap.fromTo(panel, { autoAlpha: 0 }, {
          autoAlpha: 1,
          duration: 0.34,
          ease: 'power2.out',
          overwrite: true,
          onComplete: function () { window.gsap.set(panel, { clearProps: 'opacity,visibility' }); }
        });
      } else {
        window.gsap.set(panel, { clearProps: 'opacity,visibility' });
      }
      return;
    } catch (_) { }
  }
  panel.style.removeProperty('opacity');
  panel.style.removeProperty('visibility');
}

function playLoginEasterEggUnlockCinematic() {
  loginEasterEggState.ready = true;
  loginEasterEggState.unlocked = true;
  loginEasterEggState.validating = false;
  loginEasterEggState.cinematicActive = true;
  loginEasterEggState.cinematicReady = false;
  loginEasterEggState.cinematicDismissing = false;
  loginEasterEggState.cinematicStartedAt = Date.now();
  clearLoginEasterEggCinematicTimers();
  setLoginEasterEggStatus('egg_status_accepted', 'success');
  var modal = document.getElementById('login-modal');
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  var phrase = document.getElementById('login-easter-unlock-phrase');
  var hint = document.getElementById('login-easter-unlock-hint');
  var source = document.getElementById('login-easter-egg-choice');
  var phraseChars = buildLoginEasterEggPhrase(phrase, loginEasterEggWishLabel());
  prepareLoginEasterEggPixelPhrase(phrase);
  // 提示行与 aria-label 走同一个键，但这条是**看得见**的那份：整屏可点却不说出来，等于没有关闭方式。
  // The hint shares a key with the aria-label but this is the visible copy: a screen that dismisses
  // on click without saying so may as well have no way out.
  if (hint) hint.textContent = loginEasterEggText('egg_cinematic_hint');
  if (!cinematic || !source || !phraseChars.length) {
    completeLoginEasterEggUnlock();
    return;
  }
  cinematic.classList.remove('is-visible', 'is-settled', 'is-dismissing');
  cinematic.classList.add('is-mounted');
  cinematic.setAttribute('aria-hidden', 'false');
  cinematic.setAttribute('tabindex', '0');
  // 入场必须晚一帧：同一帧里 display:none → grid 与 opacity 0 → 1 会被合并成一次样式计算，
  // 浏览器直接跳到终态，"啪"一下就是最终画面 —— 这是"很急促"的一半。
  // The entrance has to start one frame later: display:none -> grid together with opacity 0 -> 1 in
  // the same frame collapses into a single style resolution, so the browser jumps straight to the
  // end state and the screen snaps. That snap is half of the "rushed" report.
  loginEasterEggState.cinematicTimers.push(window.requestAnimationFrame(function () {
    void cinematic.offsetWidth;
    cinematic.classList.add('is-visible');
    // 许愿面板的退场与抽字**同一帧**开始。挂到定时器上就会出现「世界和平」已经亮着、
    // 下面那行「心愿是 世界和平」还停着的重影（曾经是 520ms 定时器 + 1.35s 过渡）。
    // The wish panel starts clearing on the **same frame** as the row rises. Hanging it on a timer
    // is what produced the double image of the phrase over the still-visible wish row.
    if (modal) modal.classList.add('login-easter-egg-unlocking');
  }));
  // 稳定态：浮动与「点击继续」一起出现，点击从这一刻起随时可关。
  // Settled: the float and the affordance arrive together, and any click dismisses from here on.
  loginEasterEggState.cinematicTimers.push(window.setTimeout(function () {
    if (!loginEasterEggState.cinematicActive || loginEasterEggState.cinematicDismissing) return;
    loginEasterEggState.cinematicReady = true;
    cinematic.classList.add('is-settled');
    try { cinematic.focus({ preventScroll: true }); } catch (_) { }
  }, loginEasterEggCinematicSettleMs(phraseChars.length)));
}

function dismissLoginEasterEggCinematic() {
  if (!loginEasterEggState.cinematicActive || loginEasterEggState.cinematicDismissing) return;
  // 死区：双击许愿按钮的第二下正好落在这里。这一段画面正在入场，忽略它是唯一合理的反应 ——
  // 反过来说，超过死区之后**任何一次**点击都必须立刻有反应，不能再有「等它播完」的门槛。
  // Dead zone: the second half of a double-click lands here, while the intro is still playing, so
  // ignoring it is the only sane response. Past the dead zone, though, **every** click has to act
  // right away — no more waiting for the animation to finish.
  var elapsed = Date.now() - (loginEasterEggState.cinematicStartedAt || 0);
  if (elapsed < LOGIN_EASTER_EGG_CINEMATIC_GUARD_MS) return;
  loginEasterEggState.cinematicDismissing = true;
  loginEasterEggState.cinematicReady = false;
  clearLoginEasterEggCinematicTimers();
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  if (cinematic) {
    // 连同 is-settled 一起挂上：不管在哪一刻点下去，退场都从"已经稳定"的形态开始，
    // 不会出现浮到一半忽然换一条曲线。
    // is-settled goes on with it: whatever moment the click lands on, the exit starts from the
    // settled shape instead of switching curves halfway through the float.
    cinematic.classList.add('is-settled', 'is-dismissing');
  }
  loginEasterEggState.cinematicTimers.push(
    window.setTimeout(
      completeLoginEasterEggUnlock,
      loginEasterEggPrefersReducedMotion()
        ? LOGIN_EASTER_EGG_CINEMATIC_EXIT_MS_REDUCED
        : LOGIN_EASTER_EGG_CINEMATIC_EXIT_MS
    )
  );
}

function completeLoginEasterEggUnlock() {
  clearLoginEasterEggCinematicTimers();
  loginEasterEggState.cinematicActive = false;
  loginEasterEggState.cinematicReady = false;
  loginEasterEggState.cinematicDismissing = false;
  loginEasterEggState.cinematicStartedAt = 0;
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  if (cinematic) {
    cinematic.classList.remove('is-mounted', 'is-visible', 'is-settled', 'is-dismissing');
    cinematic.setAttribute('aria-hidden', 'true');
    cinematic.setAttribute('tabindex', '-1');
  }
  setLoginEasterEggMode(false);
  restoreLoginEasterEggPanel(true);
  if (typeof resumeLoginModalAfterGate === 'function') resumeLoginModalAfterGate();
  showLoginEasterEggAchievement();
}

function playLoginEasterEggAchievementChime() {
  var ctx = typeof ensureUiSfxContext === 'function' ? ensureUiSfxContext() : null;
  if (!ctx) return;
  try {
    var t = ctx.currentTime + 0.015;
    var master = ctx.createGain();
    var volume = Math.max(0, Math.min(1, typeof targetVolume === 'number' ? targetVolume : 0.72));
    master.gain.setValueAtTime(0.0001, t);
    master.gain.linearRampToValueAtTime(0.12 * (0.32 + volume * 0.68), t + 0.018);
    master.gain.exponentialRampToValueAtTime(0.0001, t + 1.22);
    master.connect(ctx.destination);

    [
      [1046.50, 0.00, 0.46],
      [1318.51, 0.10, 0.50],
      [1567.98, 0.21, 0.58],
      [2093.00, 0.36, 0.82],
    ].forEach(function (note, index) {
      var start = t + note[1];
      var end = start + note[2];
      var osc = ctx.createOscillator();
      var overtone = ctx.createOscillator();
      var gain = ctx.createGain();
      var overtoneGain = ctx.createGain();
      osc.type = 'sine';
      overtone.type = index === 3 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(note[0], start);
      overtone.frequency.setValueAtTime(note[0] * 2.01, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(index === 3 ? 0.68 : 0.52, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      overtoneGain.gain.setValueAtTime(0.0001, start);
      overtoneGain.gain.linearRampToValueAtTime(index === 3 ? 0.16 : 0.11, start + 0.004);
      overtoneGain.gain.exponentialRampToValueAtTime(0.0001, Math.min(end, start + 0.28));
      osc.connect(gain);
      overtone.connect(overtoneGain);
      gain.connect(master);
      overtoneGain.connect(master);
      osc.start(start);
      overtone.start(start);
      osc.stop(end + 0.02);
      overtone.stop(end + 0.02);
    });
    window.setTimeout(function () {
      try { master.disconnect(); } catch (_) { }
    }, 1450);
  } catch (error) {
    console.warn('Login achievement chime failed:', error);
  }
}

function showLoginEasterEggAchievement() {
  var toast = document.getElementById('login-easter-achievement');
  if (!toast) return;
  if (loginEasterEggState.achievementTimer) window.clearTimeout(loginEasterEggState.achievementTimer);
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  playLoginEasterEggAchievementChime();
  loginEasterEggState.achievementTimer = window.setTimeout(function () {
    toast.classList.remove('show');
    loginEasterEggState.achievementTimer = null;
  }, 5200);
}

if (typeof window !== 'undefined' && window.MineradioI18n
  && typeof window.MineradioI18n.onLanguageChange === 'function') {
  // 按钮文字由 i18n 的 DOM 扫描刷新，但字号、提示与状态文案要自己重算：
  // 它们不是 DOM 上的 data-i18n 节点，扫描够不到。
  // The i18n DOM scan refreshes the button label, but the fitted font size plus the hint and
  // status copy are ours to recompute — they are not data-i18n nodes.
  window.MineradioI18n.onLanguageChange(function () {
    syncLoginEasterEggChoiceFace();
    renderLoginEasterEggHint();
    if (loginEasterEggState.statusKey) {
      setLoginEasterEggStatus(loginEasterEggState.statusKey, loginEasterEggState.statusMode);
    }
  });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', function () { syncLoginEasterEggChoiceFace(); });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { ensureLoginEasterEggStatus(false); }, { once: true });
  } else {
    ensureLoginEasterEggStatus(false);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOGIN_EASTER_EGG_WISH_KEY: LOGIN_EASTER_EGG_WISH_KEY,
    loginEasterEggLabelEmWidth: loginEasterEggLabelEmWidth,
    loginEasterEggPhraseEstimateEm: loginEasterEggPhraseEstimateEm,
  };
}
