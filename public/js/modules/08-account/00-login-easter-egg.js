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
// 点眼睛四次要给的提示，索引即点击数；首尾为空表示不显示。
// Hints shown as the eye is tapped, indexed by tap count; the ends are empty on purpose.
var LOGIN_EASTER_EGG_HINT_KEYS = ['', 'egg_hint_glance', 'egg_hint_tap_more', 'egg_hint_nervous', 'egg_hint_one_more', ''];
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

function renderLoginEasterEggHint() {
  var hint = document.getElementById('login-easter-hint');
  if (!hint) return;
  hint.textContent = loginEasterEggState.hintKey ? loginEasterEggText(loginEasterEggState.hintKey) : '';
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
  if (trigger) {
    trigger.style.setProperty('--egg-tap-strength', String(loginEasterEggState.clickCount));
    replayLoginEasterEggClass(trigger, 'tap-feedback');
  }
  loginEasterEggState.hintKey = LOGIN_EASTER_EGG_HINT_KEYS[loginEasterEggState.clickCount] || '';
  renderLoginEasterEggHint();
  if (loginEasterEggState.clickCount >= 5) revealLoginEasterEggWish();
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
  loginEasterEggStatusPromise = null;
  loginEasterEggState.ready = true;
  loginEasterEggState.unlocked = false;
  loginEasterEggState.clickCount = 0;
  loginEasterEggState.revealed = false;
  loginEasterEggState.hintKey = '';
  loginEasterEggState.validating = false;
  loginEasterEggState.cinematicActive = false;
  loginEasterEggState.cinematicReady = false;
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
    phrase.style.removeProperty('--extract-x');
    phrase.style.removeProperty('--extract-y');
    phrase.style.removeProperty('--phrase-em');
  }
  var gate = document.getElementById('login-easter-egg-gate');
  if (gate) gate.classList.remove('is-revealed');
  var trigger = document.getElementById('login-easter-eye-trigger');
  if (trigger) {
    trigger.classList.remove('tap-feedback');
    trigger.style.removeProperty('--egg-tap-strength');
  }
  var modal = document.getElementById('login-modal');
  if (modal) modal.classList.remove('login-easter-egg-unlocking');
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  if (cinematic) {
    cinematic.classList.remove('is-mounted', 'is-positioned', 'is-extracting', 'is-ready', 'is-dismissing');
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
  return chars.map(function (glyph, index) {
    var span = document.createElement('span');
    span.textContent = glyph;
    if (!glyph.trim()) span.className = 'is-space';
    // 浮动节奏错开，否则整排字会同频抖动。
    // Stagger the float or the whole row pulses in lockstep.
    span.style.setProperty('--float-duration', (3.5 + (index % 4) * 0.3).toFixed(2) + 's');
    span.style.setProperty('--float-delay', (-0.7 - index * 0.35).toFixed(2) + 's');
    span.style.setProperty('--float-distance', (8 + (index % 3) * 2) + 'px');
    span.style.setProperty('--extract-delay', (index * 0.08).toFixed(2) + 's');
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

function playLoginEasterEggUnlockCinematic() {
  loginEasterEggState.ready = true;
  loginEasterEggState.unlocked = true;
  loginEasterEggState.validating = false;
  loginEasterEggState.cinematicActive = true;
  loginEasterEggState.cinematicReady = false;
  setLoginEasterEggStatus('egg_status_accepted', 'success');
  var modal = document.getElementById('login-modal');
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  var phrase = document.getElementById('login-easter-unlock-phrase');
  var source = document.getElementById('login-easter-egg-choice');
  var phraseChars = buildLoginEasterEggPhrase(phrase, loginEasterEggWishLabel());
  prepareLoginEasterEggPixelPhrase(phrase);
  if (!cinematic || !source || !phraseChars.length) {
    completeLoginEasterEggUnlock();
    return;
  }
  cinematic.classList.remove('is-positioned', 'is-extracting', 'is-ready', 'is-dismissing');
  cinematic.classList.add('is-mounted');
  cinematic.setAttribute('aria-hidden', 'false');
  cinematic.setAttribute('tabindex', '0');
  phrase.style.removeProperty('--extract-x');
  phrase.style.removeProperty('--extract-y');
  window.requestAnimationFrame(function () {
    // 起点只有一个：选择框的中心。所有字格从同一点炸开，正好对应「从选项里抽出这句话」。
    // A single origin — the centre of the choice box. Every glyph bursts from that one point,
    // which is exactly the "the answer is pulled out of the option" beat.
    var sourceRect = source.getBoundingClientRect();
    var phraseRect = phrase.getBoundingClientRect();
    var fromX = sourceRect.left + sourceRect.width / 2 - (phraseRect.left + phraseRect.width / 2);
    var fromY = sourceRect.top + sourceRect.height / 2 - (phraseRect.top + phraseRect.height / 2);
    phrase.style.setProperty('--extract-x', fromX.toFixed(2) + 'px');
    phrase.style.setProperty('--extract-y', fromY.toFixed(2) + 'px');
    cinematic.classList.add('is-positioned');
    void cinematic.offsetWidth;
    window.requestAnimationFrame(function () {
      cinematic.classList.add('is-extracting');
      window.setTimeout(function () {
        if (modal) modal.classList.add('login-easter-egg-unlocking');
      }, 520);
      window.setTimeout(function () {
        if (!loginEasterEggState.cinematicActive) return;
        loginEasterEggState.cinematicReady = true;
        cinematic.classList.add('is-ready');
        try { cinematic.focus({ preventScroll: true }); } catch (_) { }
      }, 2700);
    });
  });
}

function dismissLoginEasterEggCinematic() {
  if (!loginEasterEggState.cinematicActive || !loginEasterEggState.cinematicReady) return;
  loginEasterEggState.cinematicReady = false;
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  if (cinematic) cinematic.classList.add('is-dismissing');
  window.setTimeout(completeLoginEasterEggUnlock, 1250);
}

function completeLoginEasterEggUnlock() {
  loginEasterEggState.cinematicActive = false;
  loginEasterEggState.cinematicReady = false;
  var modal = document.getElementById('login-modal');
  var cinematic = document.getElementById('login-easter-unlock-cinematic');
  if (cinematic) {
    cinematic.classList.remove('is-mounted', 'is-positioned', 'is-extracting', 'is-ready', 'is-dismissing');
    cinematic.setAttribute('aria-hidden', 'true');
    cinematic.setAttribute('tabindex', '-1');
  }
  setLoginEasterEggMode(false);
  if (modal) modal.classList.remove('login-easter-egg-unlocking');
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
