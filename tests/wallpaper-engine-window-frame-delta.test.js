'use strict';

// 每次启用壁纸都要走两遍开窗：第一遍按请求尺寸开，引擎实际开出来的窗口大一圈，
// 对齐失败 → 关窗 → 按校正尺寸重开。日志里 100% 复现，白花 3 秒多。
// 这里钉住「测到的差值要记住、下次直接按差值开窗」，否则这段弯路会一直留着。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WallpaperEngineRuntime } = require('../desktop/wallpaper-engine-runtime');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'wallpaper-engine-runtime.js'), 'utf8');

test('首次启用记下窗口边框差，之后按差值开窗', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-frame-delta-'));
  const deltaFile = path.join(dir, 'window-frame.json');
  const runtime = new WallpaperEngineRuntime({
    nativeTempPath: dir,
    frameDeltaPath: deltaFile,
    desktopCapturer: null,
    nativeSleep: async () => {},
  });

  assert.deepStrictEqual(runtime.windowFrameDelta, { width: 0, height: 0 });

  assert.strictEqual(runtime._rememberWindowFrameDelta(16, 39), true);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(deltaFile, 'utf8')),
    { width: 16, height: 39 },
    '测到的差值必须落盘，否则下次启动又是两遍开窗'
  );

  const reloaded = new WallpaperEngineRuntime({
    nativeTempPath: dir,
    frameDeltaPath: deltaFile,
    desktopCapturer: null,
    nativeSleep: async () => {},
  });
  assert.deepStrictEqual(reloaded.windowFrameDelta, { width: 16, height: 39 });
});

test('开窗尺寸扣掉差值，且差值不会把窗口压到下限以下', () => {
  assert.match(
    SOURCE,
    /launchWidth:\s*clampInteger\(\s*runtimeOptions\.width - this\.windowFrameDelta\.width/,
    '启动尺寸必须扣掉记住的边框差'
  );
  assert.match(
    SOURCE,
    /launchHeight:\s*clampInteger\(\s*runtimeOptions\.height - this\.windowFrameDelta\.height/,
    '启动尺寸必须扣掉记住的边框差'
  );
  assert.match(SOURCE, /_rememberWindowFrameDelta\(/, '对齐失败时必须回写差值');
});

test('损坏或越界的差值文件退回 0，不会撑大或压小窗口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-frame-delta-bad-'));
  const deltaFile = path.join(dir, 'window-frame.json');

  fs.writeFileSync(deltaFile, 'not json', 'utf8');
  const broken = new WallpaperEngineRuntime({
    nativeTempPath: dir,
    frameDeltaPath: deltaFile,
    desktopCapturer: null,
    nativeSleep: async () => {},
  });
  assert.deepStrictEqual(broken.windowFrameDelta, { width: 0, height: 0 });

  fs.writeFileSync(deltaFile, JSON.stringify({ width: 99999, height: -99999 }), 'utf8');
  const clamped = new WallpaperEngineRuntime({
    nativeTempPath: dir,
    frameDeltaPath: deltaFile,
    desktopCapturer: null,
    nativeSleep: async () => {},
  });
  assert.ok(Math.abs(clamped.windowFrameDelta.width) <= 96, '越界差值必须夹回可用范围');
  assert.ok(Math.abs(clamped.windowFrameDelta.height) <= 96, '越界差值必须夹回可用范围');
});
