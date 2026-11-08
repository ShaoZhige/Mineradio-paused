'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HUD = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '10-shell', '04-desktop-overlay-fullscreen.js'),
  'utf8'
);
const PEEK = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '10-shell', '02-peek-panels-upload.js'),
  'utf8'
);

test('控制器露出后只按真实矩形判定悬停', () => {
  assert.match(HUD, /var revealArmed = !desktopModeControlDockState\.peek && !desktopModeControlDockState\.open;/);
  assert.match(HUD, /if \(!desktopModeControlDockState\.peek && !desktopModeControlDockState\.open\) \{\n    rects\.push\(/);
});

test('指针离开窗口后桌面控制器快速收起', () => {
  assert.match(HUD, /document\.addEventListener\('mouseleave', function \(\) \{[\s\S]{0,260}scheduleDesktopModeControlHide\(160\)/);
  assert.match(HUD, /Math\.max\(100, Number\(delay\) \|\| 220\)/);
  assert.match(HUD, /Math\.max\(140, Number\(delay\) \|\| 320\)/);
});

test('指针离开窗口后 DIY 控制台也收起', () => {
  assert.match(PEEK, /document\.addEventListener\('mouseleave', function \(\) \{[\s\S]{0,900}setPeek\(fp, false, 'fx'\)/);
  assert.match(PEEK, /fxPointerLeaveTimer/);
  assert.match(PEEK, /cancelFxPointerLeaveClose\(\)/);
});
