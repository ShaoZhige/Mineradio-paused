'use strict';

// 全屏 ↔ 窗口化后圆角变直角的回归测试
//
// 主窗口是透明无边框的，圆角由 #desktop-window-shell 的 border-radius + clip-path 画在
// 一个独立 GPU 合成层上。窗口尺寸在切换全屏时一两帧内从整屏跳到小窗，Chromium 有时不会按
// 新尺寸重建裁剪掩码，四角就按旧的直角矩形裁出来，直到某次无关重绘才恢复。修复是在尺寸
// 落定后把裁剪值微调 0.1px 再交还样式表，逼合成器重建掩码。
//
// The main window is transparent and frameless; the rounded corners are painted by
// #desktop-window-shell's border-radius/clip-path on a GPU layer. When the bounds jump between
// fullscreen and windowed, Chromium sometimes keeps the previous rectangular mask and the corners
// render square. The fix nudges the clip value after the bounds settle so the mask is rebuilt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const shellSource = fs
  .readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const coreCss = fs
  .readFileSync(path.join(appRoot, 'public', 'css', 'core.css'), 'utf8')
  .replace(/\r\n/g, '\n');

function functionSource(name) {
  const start = shellSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = shellSource.indexOf('\n}', start);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return shellSource.slice(start, end);
}

test('the rounded corners really are a CSS clip on the window shell', () => {
  // 这条是前提：圆角由 CSS 画，不是 DWM 给的，所以浏览器侧的裁剪掩码才是失效点。
  // 圆角现在是用户可调的（issue #6）：CSS 用 --desktop-shell-radius 变量、20px 兜底。
  assert.match(coreCss, /#desktop-window-shell\s*\{[^}]*border-radius:\s*var\(--desktop-shell-radius,\s*20px\)/);
  assert.match(coreCss, /#desktop-window-shell\s*\{[^}]*clip-path:\s*inset\(0 round var\(--desktop-shell-radius,\s*20px\)\)/);
  // 全屏/最大化/桌面壁纸模式必须把圆角收成 0，否则整屏时四角会露出桌面。
  assert.match(
    coreCss,
    /body\.desktop-shell\.desktop-fullscreen #desktop-window-shell[^{]*\{[^}]*border-radius:\s*0 !important/
  );
});

test('the clip refresh nudges the value and forces a layout flush', () => {
  const refresh = functionSource('refreshDesktopWindowCornerClip');
  // 必须写一个「几乎一样但确实不同」的值：值不变则合成器会把它优化掉。
  // 半径可调后 nudge 从实时变量算出：34 时是 33.9，0（直角）时往大偏到 0.1。
  assert.match(refresh, /getPropertyValue\('--desktop-shell-radius'\)/);
  assert.match(refresh, /nudgedRadius = radius > 0 \? Math\.max\(0, radius - 0\.1\) : 0\.1/);
  assert.match(refresh, /'inset\(0 round ' \+ nudgedRadius \+ 'px\)'/);
  assert.match(refresh, /shell\.style\.clipPath = nudged/);
  // 中间读一次布局，否则两次写入会合并成一次，掩码根本不会重建。
  assert.match(refresh, /void shell\.offsetWidth/);
  assert.match(refresh, /removeProperty\('clip-path'\)/);
});

test('the refresh is debounced past the main-process bounds restore', () => {
  const schedule = functionSource('scheduleDesktopWindowCornerClipRefresh');
  const delay = Number((schedule.match(/setTimeout\(function \(\) \{[\s\S]*?\}, (\d+)\);/) || [])[1]);
  assert.ok(Number.isFinite(delay), 'schedule must use a numeric delay');
  // 主进程 leave-full-screen 后等 50 ms 才 setBounds 回窗口尺寸，早于它刷新还是在旧尺寸上算掩码。
  assert.ok(delay >= 60, `delay must outlast the 50 ms bounds restore, got ${delay}`);
  assert.match(schedule, /clearTimeout\(desktopWindowCornerClipTimer\)/);
});

test('fullscreen, maximize and desktop-wallpaper transitions all trigger the refresh', () => {
  const applyStateBlock = shellSource.slice(shellSource.indexOf('function applyState(state)'));
  const callSite = applyStateBlock.slice(0, applyStateBlock.indexOf('document.querySelectorAll("[data-window-action]"'));
  assert.match(callSite, /isFullScreen !== wasFullScreen/);
  assert.match(callSite, /isMaximized !== wasMaximized/);
  assert.match(callSite, /desktop-wallpaper-mode'\) !== wasWallpaperMode/);
  assert.match(callSite, /scheduleDesktopWindowCornerClipRefresh\(\)/);
});

test('window resizes also settle the clip', () => {
  // 拖拽改尺寸、最大化、DPI 跳变都走 resize，没有状态上报，得单独兜一层。
  assert.match(
    shellSource,
    /window\.addEventListener\('resize', scheduleDesktopWindowCornerClipRefresh, \{ passive: true \}\)/
  );
});

test('the shell radius is a user setting wired end to end (issue #6)', () => {
  const defaults = fs
    .readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const readSaved = fs
    .readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '05a-fx-save-read.js'), 'utf8');
  const layout = fs
    .readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const bindings = fs
    .readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const main = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');

  // 默认值 20（用户定的观感默认）；0（直角）与 120（上限）是合法边界。
  assert.match(defaults, /windowCornerRadius:\s*20/);
  // 读档用 layoutNumber 而不是 ||，否则 0 会被当成"没设置"丢掉。
  assert.match(readSaved, /layoutNumber\(raw\.windowCornerRadius,\s*fxDefaults\.windowCornerRadius,\s*0,\s*120\)/);
  assert.match(readSaved, /windowCornerRadius:\s*savedWindowCornerRadius/);
  // 应用时写 CSS 变量、并把值同步给原生壁纸窗口。
  assert.match(layout, /setProperty\('--desktop-shell-radius', radius \+ 'px'\)/);
  assert.match(layout, /api\.setWindowCornerRadius\(radius\)/);
  // 滑块绑定 + 主进程可信 IPC + preload 暴露，缺一环滑块就只是个摆设。
  assert.match(bindings, /\['fx-windowradius', 'windowCornerRadius'\]/);
  assert.match(main, /ipcMain\.on\('mineradio-window-corner-radius'/);
  assert.match(main, /isTrustedMainWindowIpc\(event\)/);
  assert.match(main, /rendererWindowCornerRadius \* scaleFactor/);
  assert.match(preload, /setWindowCornerRadius:.*ipcRenderer\.send\('mineradio-window-corner-radius'/);
});

test('all seven locales carry the corner-radius label (issue #6)', () => {
  const localesDir = path.join(appRoot, 'public', 'locales');
  const files = fs.readdirSync(localesDir).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 7, 'all seven locale dictionaries must stay in sync');
  for (const name of files) {
    const json = JSON.parse(fs.readFileSync(path.join(localesDir, name), 'utf8'));
    assert.ok(
      typeof json.fx_window_corner_radius === 'string' && json.fx_window_corner_radius.length > 0,
      `${name} is missing fx_window_corner_radius`
    );
  }
});

// 大圆角会把右上角那排按钮啃掉一角，所以按钮要按半径自动往左下避让（issue #6 后续）。
// 几何判据：(R-i-右)² + (R-i-上)² ≤ R²；实测 34/48/80/120 四档都落在圆弧内。
test('大圆角时右上角按钮自动避让，不被裁剪', () => {
  const css = fs.readFileSync(path.join(appRoot, 'public', 'css', 'core.css'), 'utf8');
  // 避让量随半径增长、40px 以下基本不生效（默认观感不变）。
  const insetDecl = css.match(/--shell-corner-inset:\s*([^;\n]+)/);
  assert.ok(insetDecl, '缺少 --shell-corner-inset 声明');
  assert.match(insetDecl[1], /clamp\(0px,/);
  assert.match(insetDecl[1], /--desktop-shell-radius/);
  assert.match(insetDecl[1], /\+ 3px/);
  const controlsBlock = css.slice(css.indexOf('.desktop-window-controls {'), css.indexOf('.desktop-window-btn {'));
  assert.match(controlsBlock, /transform: translate\(calc\(-1 \* var\(--shell-corner-inset, 0px\)\), calc\(var\(--shell-topbar-nudge, 4px\) \+ var\(--shell-corner-inset, 0px\)\)\)/);
  // 最大化/全屏/壁纸桌面态圆角被强制归零，避让量也必须归零，否则按钮会莫名偏移。
  assert.match(css, /body\.desktop-shell\.desktop-maximized,\s*\nbody\.desktop-shell\.desktop-fullscreen,\s*\nbody\.desktop-shell\.desktop-wallpaper-mode \{\s*\n\s*--shell-corner-inset: 0px/);
});

// 按钮下移后会压到右上角的账号胶囊，胶囊必须跟着让同一个量（实测各档始终留 21px 间距）。
test('账号胶囊与横幅跟随同一个避让量，不被按钮压住', () => {
  const css = fs.readFileSync(path.join(appRoot, 'public', 'css', 'core.css'), 'utf8');
  const topRight = css.slice(css.indexOf('body.desktop-shell #top-right {'), css.indexOf('body.desktop-shell #trial-banner {'));
  // top 既跟随避让量、又封顶在 76px（再往下会压住首页卡片，见「纵向封顶」那条用例）。
  assert.match(topRight, /top: clamp\(58px, calc\(58px \+ var\(--shell-corner-inset, 0px\)\), 76px\)/);
  // 横向**不跟随**避让量：胶囊被封顶在 58~76，圆弧在该高度最多啃 17.3px，24px 足够；
  // 跟着往左挪反而会压到左边卡片（用户截图反馈）。
  assert.match(topRight, /right: 24px;/,
    '胶囊必须贴住右边距，别再跟着避让量往左压到卡片上');
  const banner = css.slice(css.indexOf('body.desktop-shell #trial-banner {'), css.indexOf('body.desktop-shell #ai-depth-chip {'));
  assert.match(banner, /top: calc\(112px \+ var\(--shell-corner-inset, 0px\)\)/, '横幅同样下移，避免和胶囊相撞');
});

// updateFxInputs() 只把数值写回滑块、不触发 apply，所以「恢复默认」以前只改数字：
// 圆角数字回到 20、窗口还是旧圆角，得再拖一下滑块才生效。两条重置路径都必须显式补应用。
test('恢复默认立刻应用圆角，不能只改数字', () => {
  const bindings = fs.readFileSync(
    path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const perf = fs.readFileSync(
    path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');

  const resetAt = bindings.indexOf('function resetFx()');
  assert.ok(resetAt > 0, '找不到 resetFx');
  const resetBody = bindings.slice(resetAt, bindings.indexOf('\n}', resetAt));
  assert.match(resetBody, /if \(typeof applyWindowCornerRadius === 'function'\) applyWindowCornerRadius\(\);/);
  assert.ok(
    resetBody.indexOf('updateFxInputs()') < resetBody.indexOf('applyWindowCornerRadius()'),
    '必须在 updateFxInputs 之后补应用，否则读到的还是旧值'
  );

  const sliderAt = perf.indexOf('function resetFxSliderValue(');
  assert.ok(sliderAt > 0, '找不到 resetFxSliderValue');
  const sliderBody = perf.slice(sliderAt, perf.indexOf('\n}', sliderAt));
  assert.match(sliderBody, /key === 'windowCornerRadius'/, '单条滑块的恢复默认也要处理圆角');
  assert.match(sliderBody, /applyWindowCornerRadius\(\)/);
});

// 右下角与右上角是对偶的：圆钮贴着的两个边距（24/24）在大半径下同样会被啃。
// 判据 (R-右)² + (R-下)² ≤ R²；复用同一个 --shell-corner-inset。
test('右下角 DIY 圆钮随圆角避让', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/console.css'), 'utf8');
  const fabRule = css.slice(css.indexOf('#fx-fab {'), css.indexOf('}', css.indexOf('#fx-fab {')));
  assert.match(fabRule, /right: calc\(24px \+ var\(--shell-corner-inset, 0px\)\);/, '圆钮右边要避让');
  assert.match(fabRule, /bottom: calc\(24px \+ var\(--shell-corner-inset, 0px\)\);/, '圆钮底边要避让');
  // peek 与 DIY 两处重新钉位置时不能把避让量丢掉
  assert.match(css, /body\.fx-fab-auto-hide\.fx-fab-peek #fx-fab \{\r?\n  right: calc\(24px \+ var\(--shell-corner-inset, 0px\)\);/);
  assert.match(css, /body\.desktop-shell\.diy-mode #fx-fab \{\r?\n  bottom: calc\(24px \+ var\(--shell-corner-inset, 0px\)\)/);
  // 隐藏按钮跟着一起让，否则它会凸到圆弧外
  assert.match(css, /right: calc\(84px \+ var\(--shell-corner-inset, 0px\)\)/);
  assert.match(css, /bottom: calc\(37px \+ var\(--shell-corner-inset, 0px\)\)/);
});

// 胶囊避让不能无限往下：首页卡片从 132px 起且横向铺到右边，胶囊（高 48）再往下就压住卡片。
// top 用 clamp 封顶 76（卡片前 8px），同时仍要留在标题栏按钮（R=120 时底边 68）下方。
test('账号胶囊的避让有纵向封顶，不会压住首页卡片', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/core.css'), 'utf8');
  const rule = css.slice(css.indexOf('body.desktop-shell #top-right {'), css.indexOf('}', css.indexOf('body.desktop-shell #top-right {')));
  assert.match(rule, /top: clamp\(58px, calc\(58px \+ var\(--shell-corner-inset, 0px\)\), 76px\);/,
    'top 必须封顶，否则大半径下胶囊会压到卡片上沿');
  assert.match(rule, /right: 24px;/, '横向固定 24px，圆弧在 y>=58 时最多啃 17.3px');
  // 三段几何关系写死在注释里，改数字时要重新算：按钮底 68 < 胶囊顶 76 < 胶囊底 124 < 卡片顶 132
  assert.match(rule, /R=120 → inset 27/, '几何依据要留在注释里，别让后人瞎猜');
});

// 首页卡片的底板：填充、毛玻璃、黑晕、::before 渐晕，任何一样留下来都会在圆角处
// 变成"看得见的方形底"。而且光写 `.home-hero{...!important}` 压不过
// `html.control-glass-svg-ok .home-hero`（(0,2,1)），必须用双类名抬到 (0,2,2)。
test('首页卡片不留任何底板，且特异性压过 glass 规则', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/playlist.css'), 'utf8');
  const at = css.indexOf('html body .home-hero.home-hero,');
  assert.ok(at > 0, '缺少高特异性的首页卡片覆盖块');
  const block = css.slice(at, css.indexOf('}', at) + 1);
  assert.match(block, /background: transparent !important;/);
  assert.match(block, /backdrop-filter: none !important;/);
  assert.match(block, /box-shadow: none !important;/, '90px 黑晕在透明底上会变成一圈黑布');
  assert.match(block, /text-shadow: 0 1px 10px rgba\(0, 0, 0, \.38\);/, '去底之后要靠文字投影保证可读性');
  // 双类名是硬要求：单类名 (0,1,1) / html body (0,1,2) 都压不过 glass 的 (0,2,1)
  assert.ok(!/^html body \.home-hero,\s*$/m.test(css), '不能退回单类名写法');
});
