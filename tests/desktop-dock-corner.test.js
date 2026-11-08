'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'index.css'), 'utf8');
const RENDERER = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'),
  'utf8'
);

test('桌面控制器固定在窗口最右上角', () => {
  assert.match(
    CSS,
    /body\.desktop-shell\.desktop-wallpaper-mode\.desktop-wallpaper-interactive #desktop-mode-control-dock \{[\s\S]{0,200}top: calc\(var\(--desktop-safe-top\) \+ 16px\);[\s\S]{0,120}right: calc\(var\(--desktop-safe-right\) \+ 16px\)/
  );
  assert.match(CSS, /#desktop-mode-control-dock \{[\s\S]{0,160}top: 16px;[\s\S]{0,80}right: 16px;/);
});

test('账号胶囊与 Home 为最右上角控制器让位', () => {
  assert.match(
    CSS,
    /body\.desktop-shell\.desktop-wallpaper-mode\.desktop-wallpaper-interactive #top-right \{[\s\S]{0,220}right: calc\(var\(--desktop-safe-right\) \+ 16px \+ 52px \+ 12px\)/
  );
});

test('渲染层不再按 Home 按钮计算控制器位置', () => {
  const start = RENDERER.indexOf('function syncDesktopDockPosition(');
  assert.ok(start >= 0);
  const body = RENDERER.slice(start, start + 420);
  assert.ok(body.indexOf('home-btn') < 0);
  assert.match(body, /dock\.style\.left = 'auto'/);
});
