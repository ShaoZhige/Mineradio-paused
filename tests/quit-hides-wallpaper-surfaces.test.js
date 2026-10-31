'use strict';

// 关掉软件后，WE 播放窗口与渲染层的粒子还留在屏幕上：退出清理要先收全桌面模式再关 WE，
// 慢的时候十几秒，这期间主窗口照常可见。这里钉住「清理链开始之前先把这两块表面撤掉」。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');

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

test('退出清理一开始就撤掉画面，不等清理链走完', () => {
  const beforeQuit = functionSource(MAIN, "app.on('before-quit', (event) => {");
  const hideAt = beforeQuit.indexOf('hideVisibleSurfacesForQuit()');
  assert.ok(hideAt >= 0, 'before-quit 必须调用 hideVisibleSurfacesForQuit');
  const cleanupAt = beforeQuit.indexOf('wallpaperEngineRuntime.dispose()');
  assert.ok(cleanupAt > hideAt, '撤画面的动作必须排在 WE 清理之前');
});

test('撤画面用透明度而不是 hide()', () => {
  const body = functionSource(MAIN, 'function hideVisibleSurfacesForQuit() {');
  assert.match(body, /setOpacity\(0\)/, '透明化是即时且不触发可见性恢复守卫的做法');
  assert.doesNotMatch(body, /\.hide\(\)/, 'hide() 会触发隐藏恢复与 WE 挂起流程，和退出清理抢链路');
});

test('撤画面时把 WE 播放窗口一起收掉', () => {
  const body = functionSource(MAIN, 'function hideVisibleSurfacesForQuit() {');
  assert.match(body, /getStatus\(\)/, '只在有活动会话时才需要动 WE 窗口');
  assert.match(
    body,
    /stopWallpaperEngineRuntimeForRenderer\('quit-visible-surfaces'\)/,
    '普通模式退出必须真的关掉 WE，只停车的话窗口会一直留到进程退出'
  );
  assert.match(body, /parkActiveWindow\(\)/, '全桌面模式下 WE 嵌在资源管理器里，先停车交给桌面模式 dispose');
});
