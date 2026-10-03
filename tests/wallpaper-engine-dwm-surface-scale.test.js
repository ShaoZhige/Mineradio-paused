'use strict';

// DWM 缩略图缩放默认值与"就绪后补发"的回归测试。
// Regression cover for the DWM thumbnail scale default and the ready-path flush.
//
// 背景：应用内的壁纸表面由原生帮手（wallpaper-engine-dwm-surface-*.ps1）用 DWM 缩略图铺满
// 宿主窗口，缩略图目标矩形 = 宿主矩形 × max(视觉缩放, 自动越界补偿)。只要缩放不是 1，整张
// 壁纸就会被无条件重采样一次；旧的 1.08 默认让每张壁纸都多放大 8%（发虚 + 构图与真实壁
// 纸不一致）。帮手的缩放来自两个地方：启动时的环境变量初值，以及运行期通过 stdin 的
// `V|opacity|posX|posY|scale` 指令。渲染进程的推送通常早于帮手就绪，旧实现遇到这种情况
// 会直接丢包且不重试，把帮手永久锁在启动初值上。
//
// Background: the in-app wallpaper surface is a DWM thumbnail of the Wallpaper Engine window,
// stretched to the host rect by a scale factor. Any factor other than 1 resamples the whole
// wallpaper, and the legacy 1.08 default upscaled every wallpaper by 8% (soft image plus a
// framing that does not match the real wallpaper). The helper learns the factor from a
// spawn-time environment variable and from `V|...` stdin commands, but the renderer's push
// normally lands before the helper is ready and used to be dropped without a retry.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const runtimeText = fs.readFileSync(
  path.join(appRoot, 'desktop', 'wallpaper-engine-runtime.js'),
  'utf8',
).replace(/\r\n/g, '\n');

function sourceBlock(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  assert(start >= 0, `missing source block: ${startNeedle}`);
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing source block terminator: ${endNeedle}`);
  return text.slice(start, end);
}

function extractMethod(source, signature) {
  // The signature must end with the opening brace of the body; parameter lists may contain
  // braces of their own (e.g. `settings = {}`), so the body never starts at the first `{`.
  const from = source.indexOf(signature);
  assert(from >= 0, `missing method: ${signature}`);
  const open = from + signature.length - 1;
  assert(source[open] === '{', `signature must end with the body brace: ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${signature}`);
}

function runInSandbox(prelude) {
  const context = vm.createContext({ console });
  vm.runInContext(prelude, context, { filename: 'wallpaper-engine-dwm-surface-scale.js' });
  return context;
}

// ---------------------------------------------------------------------------
// 1) 主进程里不应再有任何 1.08 的代码级默认值。
//    1) No code-level 1.08 default may remain in the main process.

{
  assert.strictEqual(
    /1080000/.test(runtimeText),
    false,
    'native helper scale unit 1080000 (1.08x) must not be hardcoded any more',
  );
  assert.strictEqual(
    /\|\|\s*1\.08/.test(runtimeText),
    false,
    'no `|| 1.08` fallback may remain in the wallpaper engine runtime',
  );
  assert.strictEqual(
    /dwmVisualScale: 1\.08/.test(runtimeText),
    false,
    'the session must not start at the legacy 1.08 scale',
  );
  assert(
    /dwmVisualScale: 1,/.test(runtimeText),
    'the session must start at exactly 1x',
  );
  assert(
    /dwmVisualSettingsPending: false,/.test(runtimeText),
    'the session must carry the pending-flush flag',
  );
  assert(
    /MINERADIO_WE_DWM_VISUAL_SCALE: String\(Math\.round\(Math\.max\(1, Math\.min\(1\.6, Number\(session\.dwmVisualScale\) \|\| 1\)\) \* 1000000\)\)/.test(runtimeText),
    'the spawn-time scale env var must fall back to 1x',
  );
}

// ---------------------------------------------------------------------------
// 2) 会话更新必须走可补发的写入路径，且帮手就绪后必须补发一次。
//    2) Session updates must go through the flushable write helper, and the helper's
//       ready path must flush once.

{
  const updateBlock = extractMethod(runtimeText, 'updateDwmVisualSettings(expectedSessionId = \'\', settings = {}) {');
  assert(
    /return this\._pushDwmVisualSettings\(session\);/.test(updateBlock),
    'updateDwmVisualSettings must delegate to the flushable writer',
  );
  assert(
    /Number\(settings\.scale\) \|\| 1\)/.test(updateBlock),
    'updateDwmVisualSettings must default the scale to 1x',
  );

  const surfaceBlock = sourceBlock(runtimeText, 'async _startSessionDwmSurface(session)', 'updateGlassSurface(');
  const readyIndex = surfaceBlock.indexOf('session.dwmSurfaceReady = true;');
  assert(readyIndex >= 0, 'missing ready flag assignment');
  const flushIndex = surfaceBlock.indexOf('this._pushDwmVisualSettings(session);', readyIndex);
  assert(
    flushIndex > readyIndex && flushIndex - readyIndex < 700,
    'the DWM surface ready path must flush the visual settings right after the ready flag',
  );
}

// ---------------------------------------------------------------------------
// 3) 补发行为：未就绪不入管道并置待发标记；就绪后按 `V|opacity|posX|posY|scale` 写出 1x。
//    3) Flush behaviour: not ready -> nothing written plus a pending marker; ready -> the
//       `V|opacity|posX|posY|scale` command with a 1x scale.

{
  const methodSource = extractMethod(runtimeText, '_pushDwmVisualSettings(session) {')
    .replace('_pushDwmVisualSettings(session) {', 'function __pushDwmVisualSettings(session) {');
  const context = runInSandbox(methodSource);
  // The extracted method closes over nothing: every value it touches hangs off the session.
  assert.strictEqual(typeof context.__pushDwmVisualSettings, 'function', 'extracted method must compile');

  function makeStdin(options = {}) {
    const writes = [];
    return {
      writes,
      destroyed: options.destroyed === true,
      writableEnded: false,
      write(chunk) {
        if (options.throwOnWrite === true) throw new Error('EPIPE');
        writes.push(chunk);
      },
    };
  }

  function makeSession(overrides = {}) {
    const stdin = overrides.stdin === undefined ? makeStdin() : overrides.stdin;
    return Object.assign({
      dwmSurfaceReady: true,
      dwmSurfaceProcess: { stdin },
      dwmVisualOpacity: 1,
      dwmVisualPositionX: 0,
      dwmVisualPositionY: 0,
      dwmVisualScale: 1,
      dwmVisualSettingsPending: false,
    }, overrides.session || {}, { dwmSurfaceProcess: { stdin } });
  }

  // 未就绪：不写管道，置待发标记，等就绪分支补发。
  const notReady = makeSession({ session: { dwmSurfaceReady: false } });
  assert.strictEqual(
    context.__pushDwmVisualSettings(notReady),
    false,
    'a not-ready helper must make the flush report failure',
  );
  assert.strictEqual(notReady.dwmSurfaceProcess.stdin.writes.length, 0, 'nothing may be written before ready');
  assert.strictEqual(notReady.dwmVisualSettingsPending, true, 'the pending flag must be raised');

  // 就绪：写出 1x 缩放（旧默认会写成 1080000）。
  const ready = makeSession({});
  assert.strictEqual(context.__pushDwmVisualSettings(ready), true, 'a ready helper must accept the flush');
  assert.deepStrictEqual(ready.dwmSurfaceProcess.stdin.writes, ['V|255|0|0|1000000\n'], 'scale must be 1x');
  assert.strictEqual(ready.dwmVisualSettingsPending, false, 'the pending flag must be cleared');

  // 会话初值未推送：仍必须是 1x，而不是旧默认 1.08。
  const untouched = {
    dwmSurfaceReady: true,
    dwmSurfaceProcess: { stdin: makeStdin() },
    dwmVisualSettingsPending: false,
  };
  assert.strictEqual(context.__pushDwmVisualSettings(untouched), true, 'the init defaults must flush');
  assert.deepStrictEqual(
    untouched.dwmSurfaceProcess.stdin.writes,
    ['V|255|0|0|1000000\n'],
    'an untouched session must render at 1x, not 1.08x',
  );

  // 缩放上下限仍按 1..1.6 收敛，位置按百万分之一刻度。
  const zoomed = makeSession({
    session: {
      dwmVisualOpacity: 0.5,
      dwmVisualPositionX: 0.25,
      dwmVisualPositionY: -0.25,
      dwmVisualScale: 0,
    },
  });
  context.__pushDwmVisualSettings(zoomed);
  assert.deepStrictEqual(
    zoomed.dwmSurfaceProcess.stdin.writes,
    ['V|128|250000|-250000|1000000\n'],
    'opacity/position units and the 1x floor must hold',
  );

  const maxZoom = makeSession({ session: { dwmVisualScale: 9 } });
  context.__pushDwmVisualSettings(maxZoom);
  assert.deepStrictEqual(maxZoom.dwmSurfaceProcess.stdin.writes, ['V|255|0|0|1600000\n'], 'scale must clamp to 1.6x');

  // 管道异常/已关闭：保留待发标记，交给下一次补发重试。
  const brokenPipe = makeSession({ session: {}, stdin: makeStdin({ throwOnWrite: true }) });
  assert.strictEqual(context.__pushDwmVisualSettings(brokenPipe), false, 'a throwing pipe must not be silent');
  assert.strictEqual(brokenPipe.dwmVisualSettingsPending, true, 'a throwing pipe must keep the pending flag');

  const closedPipe = makeSession({ session: {}, stdin: makeStdin({ destroyed: true }) });
  assert.strictEqual(context.__pushDwmVisualSettings(closedPipe), false, 'a closed pipe must not be written');
  assert.strictEqual(closedPipe.dwmVisualSettingsPending, true, 'a closed pipe must keep the pending flag');

  // 悬空会话不得抛异常。
  assert.strictEqual(context.__pushDwmVisualSettings(null), false, 'a missing session must be tolerated');
}

console.log('wallpaper-engine-dwm-surface-scale: ok');
