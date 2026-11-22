'use strict';

// 「WE 捕获渲染」：把壁纸窗口抓成视频流画在自己窗口里，绕开跨窗口合成。
// 三条硬约束：默认关闭、只对需要合成的壁纸（原生 Scene）生效、开关必须走完整持久化链路。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('默认关闭：默认值、打包快照、读取归一化都必须是 opt-in', () => {
  assert.match(read('public/js/modules/00-state/04-fx-defaults.js'), /wallpaperEngineCaptureRender: false,/);
  assert.match(read('public/default-user-fx-archive.json'), /"wallpaperEngineCaptureRender": false,/);
  // 读取必须 `=== true`：写成 `!== false` 会让老存档/别人的分享码把它顺手打开。
  assert.match(read('public/js/modules/00-state/05a-fx-save-read.js'), /wallpaperEngineCaptureRender: raw\.wallpaperEngineCaptureRender === true,/);
  assert.match(read('public/js/modules/07-fx/00-preset-archive-data.js'), /wallpaperEngineCaptureRender: raw\.wallpaperEngineCaptureRender === true,/);
});

test('分享码按位编码：新键只能追加在末尾', () => {
  const archive = read('public/js/modules/07-fx/00-preset-archive-data.js');
  const at = archive.indexOf("'wallpaperEngineCaptureRender'");
  assert.ok(at > 0, '分享码键表里没有这一位');
  const after = archive.slice(at, archive.indexOf('];', at));
  assert.ok(!/^\s*'[A-Za-z]/.test(after.split('\n').slice(1).join('\n')),
    '新键必须排在最后，插到中间会让旧分享码解错位');
});

test('持久化：保存映射与快照都要带上它', () => {
  const persistence = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
  assert.match(persistence, /wallpaperEngineCaptureRender: \['wallpaperEngineCaptureRender'\]/);
  assert.match(persistence, /wallpaperEngineCaptureRender: fx\.wallpaperEngineCaptureRender === true,/);
});

test('UI：开关存在、面板回显、切换会落盘并重建壁纸', () => {
  const html = read('public/index.html');
  assert.match(html, /id="t-wallpaperEngineCaptureRender"/);
  assert.match(html, /onclick="toggleFx\('wallpaperEngineCaptureRender'\)"/);
  assert.match(read('public/js/modules/07-fx/05-fx-panel-performance.js'),
    /t-wallpaperEngineCaptureRender[\s\S]{0,120}fx\.wallpaperEngineCaptureRender === true/);
  const bindings = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
  assert.match(bindings, /key === 'wallpaperEngineCaptureRender' \|\| key === 'desktopWallpaperBackdrop'/,
    '不在落盘列表里的话，切换后重启就丢了');
  assert.match(bindings, /if \(key === 'wallpaperEngineCaptureRender'\) \{[\s\S]{0,400}applyWallpaperEngineBackground\(null, false\)/,
    '切换后要重建壁纸层，否则看不到变化');
});

test('只对原生场景生效：视频壁纸走 MR 自己的播放路径，不经过这里', () => {
  const lib = read('public/js/modules/07-fx/03-wallpaper-engine-library.js');
  const at = lib.indexOf('async function startWallpaperEngineNativeBackground(');
  const body = lib.slice(at, lib.indexOf('\n}', lib.indexOf('captureRender: fx.wallpaperEngineCaptureRender', at)));
  assert.match(body, /captureRender: fx\.wallpaperEngineCaptureRender === true/,
    'captureRender 必须挂在原生场景的启动参数上（这一段就是"需要合成"的那类壁纸）');
});

test('主进程：起后台抓帧 worker，并把 capture-worker 与流地址交回渲染端', () => {
  const main = read('desktop/main.js');
  const at = main.indexOf("ipcMain.handle('mineradio-wallpaper-engine-start-scene'");
  const body = main.slice(at, main.indexOf("return { ...result, ...embedded, capturePrepared: true, captureMode: 'dwm-thumbnail' };", at));
  assert.match(body, /if \(payload && payload\.captureRender === true\) \{/);
  // Chromium 抓不到那个窗口，必须走常驻进程。
  assert.match(body, /wallpaperEngineCaptureWorker\s*\n?\s*\.start\(`Mineradio Wallpaper \$\{grant\.sessionId\}`\)/);
  assert.match(body, /captureMode: 'capture-worker'/);
  assert.match(body, /captureStreamUrl: captureWorker\.url/);
  // 失败要真停掉会话，不能留一个没人接管的原生窗口。
  assert.match(body, /wallpaperEngineRuntime\.stop\(grant\.sessionId\)/);
  // 抓帧进程跟着会话走。
  assert.match(main, /mineradio-wallpaper-engine-stop-scene'[\s\S]{0,400}wallpaperEngineCaptureWorker\.stop\(\)/);
});

test('七语种都有词条', () => {
  const dir = path.join(root, 'public/locales');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(dict.fx_we_capture_render, file + ' 缺 fx_we_capture_render');
    assert.ok(dict.fx_we_capture_render_title, file + ' 缺 fx_we_capture_render_title');
  }
});

test('渲染端：capture-worker 挂 MJPEG 图片层，清理时断流', () => {
  const lib = read('public/js/modules/07-fx/03-wallpaper-engine-library.js');
  assert.match(lib, /if \(result\.captureMode === 'capture-worker' && result\.captureStreamUrl\)/);
  assert.match(lib, /captureImage\.src = String\(result\.captureStreamUrl\)/);
  assert.match(lib, /captureLayer\.classList\.add\('capture-ready'\)/);
  assert.match(lib, /captureImage\.removeAttribute\('src'\)/, '清理时必须断流，否则 MJPEG 连接一直挂着');
  assert.match(read('public/index.html'), /id="wallpaper-engine-capture-image"/);
});

test('精确源起不来时能兜底：但只由捕获渲染开关解锁', () => {
  const lib = read('public/js/modules/07-fx/03-wallpaper-engine-library.js');
  const prepare = lib.slice(
    lib.indexOf('window.__mineradioPrepareWallpaperEngineCapture = async function'),
    lib.indexOf('window.__mineradioPrepareWallpaperEngineGlassCapture = async function'));
  assert.match(prepare, /allowDisplayMediaFallback: fx\.wallpaperEngineCaptureRender === true/,
    '兜底必须挂在开关上，默认仍然是严格模式');
  assert.match(lib, /if \(options\.sourceIdOnly === true && !allowDisplayMediaFallback\) \{/);
  // 失败一次就回退到原生，不能在重启环里死循环
  assert.match(lib, /function fallbackWallpaperEngineCaptureRender\(item, error, token\)/);
  assert.match(lib, /if \(wallpaperEngineCaptureRenderFallback\) return false;/);
  assert.match(lib, /captureRender: fx\.wallpaperEngineCaptureRender === true && !wallpaperEngineCaptureRenderFallback/);
});

test('捕获模式必须保留 grant 并回发确认 ACK（否则跟随对齐不生效，屏幕上会留一块没对齐的壁纸）', () => {
  const main = read('desktop/main.js');
  const at = main.indexOf("ipcMain.handle('mineradio-wallpaper-engine-start-scene'");
  const body = main.slice(at, main.indexOf("return { ...result, ...embedded, capturePrepared: true, captureMode: 'capture-worker'", at));
  assert.ok(!/clearWallpaperEngineCaptureGrant\(grant\.sessionId\);\s*\n\s*\/\/ 捕获渲染/.test(body),
    '不能在返回前清 grant，ACK 会匹配不上');
  assert.match(body, /wallpaperEngineCaptureWorker\s*\n?\s*\.start\(/);

  const lib = read('public/js/modules/07-fx/03-wallpaper-engine-library.js');
  assert.match(lib, /reportWallpaperEngineCaptureResult\(sessionId, true, \{ skipDwmSurface: true \}\)/,
    '捕获模式要发确认 ACK，但不要起 DWM 缩略图表面');
});

test('捕获层必须跟圆角设置走（否则四角会露出直角壁纸）', () => {
  const css = read('public/css/background.css');
  // desktop-shell 下按选择器白名单裁圆角，新图层漏登记就是直角。
  assert.match(css, /body\.desktop-shell #wallpaper-engine-capture-image,/, 'desktop-shell 圆角列表里缺捕获层');
  assert.match(css, /body\.desktop-shell\.desktop-maximized #wallpaper-engine-capture-image,/);
  assert.match(css, /body\.desktop-shell\.desktop-fullscreen #wallpaper-engine-capture-image,/);
  assert.match(css, /body\.desktop-shell\.desktop-wallpaper-mode #wallpaper-engine-capture-image,/);
  assert.match(css, /html:fullscreen body\.desktop-shell #wallpaper-engine-capture-image,/);
});

test('捕获模式用 DWM cloak 隐藏原生窗口（隐藏后仍能抓帧）', () => {
  const runtime = read('desktop/wallpaper-engine-runtime.js');
  assert.match(runtime, /String\.Equals\(action, "cloak", StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(runtime, /DwmSetWindowAttribute\(hWnd, 13, ref cloakValue, 4\)/, '13 = DWMWA_CLOAK');
  assert.match(runtime, /async setActiveWindowCloaked\(expectedSessionId = '', cloaked = true\)/);

  const main = read('desktop/main.js');
  const at = main.indexOf("ipcMain.handle('mineradio-wallpaper-engine-start-scene'");
  const body = main.slice(at, main.indexOf("captureMode: 'capture-worker'", at));
  assert.match(body, /await wallpaperEngineRuntime\.setActiveWindowCloaked\(grant\.sessionId, true\)/,
    '起完捕获要把原生窗口 cloaked，否则屏幕上会留一块没对齐的壁纸');
  assert.match(main, /stop-scene'[\s\S]{0,400}setActiveWindowCloaked\('', false\)/);
});
