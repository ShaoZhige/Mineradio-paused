'use strict';

// 最小化是高频来回的操作，壁纸留在原地最省事；托盘关闭和退出是真的要它消失。
// 这里钉住两者的分界：只有最小化的 reason 走保留分支，其余一律完整停止。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const LIBRARY = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js'),
  'utf8'
);

function functionSource(source, signature) {
  const from = source.indexOf(signature);
  assert.ok(from >= 0, '找不到 ' + signature);
  const open = from + signature.length - 1;
  assert.strictEqual(source[open], '{', signature + ' 后面应当紧跟函数体');
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error('花括号不平衡：' + signature);
}

test('保留分支只认最小化这一个 reason', () => {
  const body = functionSource(MAIN, "function suspendWallpaperEngineForHiddenHost(win, reason = 'hidden') {");
  assert.match(
    body,
    /\/\^minimi\[sz\]e\(\?:d\)\?\$\/\.test\(normalizedReason\)/,
    '只有最小化才保留原生表面，托盘关闭与退出必须落到完整停止'
  );
  const preservedAt = body.indexOf('preserved: true');
  const stopAt = body.indexOf('stopWallpaperEngineRuntimeForRenderer');
  assert.ok(preservedAt >= 0 && stopAt > preservedAt, '保留分支在完整停止之前返回');
});

test('最小化保留期间告诉渲染进程别拆台', () => {
  const body = functionSource(MAIN, "function suspendWallpaperEngineForHiddenHost(win, reason = 'hidden') {");
  assert.match(body, /phase: 'hold'/, '渲染进程收到 hold 才会跳过自己的 visibilitychange 拆台');
  assert.match(body, /sessionId: String\(runtimeStatus\.sessionId \|\| ''\)/, '保留的是具体会话，恢复时按它重新认领');
  assert.match(
    MAIN,
    /wallpaperEngineHostVisibilityResidentMinimized\s*=\s*true;[\s\S]{0,600}phase: 'hold'/,
    '先立标记再通知渲染进程，避免拆台请求先到'
  );
});

test('托盘关闭先挂起壁纸，不等 autosave 落盘', () => {
  const closeHandler = functionSource(MAIN, "win.on('close', (event) => {");
  const suspendAt = closeHandler.indexOf("suspendWallpaperEngineForHiddenHost(win, 'tray-hide')");
  const autosaveAt = closeHandler.indexOf("flushMainWindowFxAutosave('tray-hide')");
  assert.ok(suspendAt >= 0, '托盘关闭必须挂起壁纸');
  assert.ok(autosaveAt > suspendAt, '挂起要排在 autosave 之前，否则壁纸窗口会一直挂到落盘结束');
  assert.match(
    closeHandler,
    /suspendWallpaperEngineForHiddenHost\(win, 'tray-hide'\)[\s\S]{0,600}win\.hide\(\)/,
    '挂起不替代 hide()，窗口本身仍要正常收进托盘'
  );
});

test('渲染进程只在 hold 阶段跳过拆台，其余阶段照常拆', () => {
  assert.match(LIBRARY, /if \(phase === 'hold'\) \{\s*\/\/[^\n]*\n\s*wallpaperEngineHostResidentHold = true;/);
  const visibilityHandler = functionSource(LIBRARY, "document.addEventListener('visibilitychange', function () {");
  const holdAt = visibilityHandler.indexOf('if (wallpaperEngineHostResidentHold) {');
  const stopAt = visibilityHandler.indexOf('stopWallpaperEngineNativeSession(hiddenSessionId)');
  assert.ok(holdAt >= 0 && stopAt > holdAt, 'hold 标记必须在拆台之前判断');
  assert.match(
    visibilityHandler,
    /wallpaperEngineHostResidentHold = false;\s*return;/,
    'hold 只用一次：下次真正隐藏仍然要拆台'
  );
});
