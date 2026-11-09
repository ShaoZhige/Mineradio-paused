'use strict';

// Phase 4: 纯函数行为测试。这里不读源码、不做 grep，直接调用模块验证行为，
// 避免像以前那样「源码里有个字符串」就算通过。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizeCloseBehavior, buildTrayMenuTemplate } = require('../desktop/window-behavior');
const fxAutosave = require('../desktop/fx-autosave');

test('normalizeCloseBehavior only keeps tray, everything else exits', () => {
  assert.equal(normalizeCloseBehavior('tray'), 'tray');
  assert.equal(normalizeCloseBehavior('exit'), 'exit');
  assert.equal(normalizeCloseBehavior('TRAY'), 'exit');
  assert.equal(normalizeCloseBehavior(''), 'exit');
  assert.equal(normalizeCloseBehavior(undefined), 'exit');
  assert.equal(normalizeCloseBehavior(null), 'exit');
});

test('tray menu keeps order, desktop-mode visibility, and handlers', () => {
  const calls = [];
  const menu = buildTrayMenuTemplate({
    appName: 'Mineradio',
    desktopModeEnabled: true,
    onShow: () => calls.push('show'),
    onExitDesktopMode: () => calls.push('desktop'),
    onQuit: () => calls.push('quit'),
  });
  assert.deepEqual(menu.map((item) => item.label || item.type), [
    '显示 Mineradio',
    '退出完整桌面模式',
    'separator',
    '退出',
  ]);
  assert.equal(menu[1].visible, true);
  menu[0].click();
  menu[1].click();
  menu[3].click();
  assert.deepEqual(calls, ['show', 'desktop', 'quit']);

  const hidden = buildTrayMenuTemplate({ appName: 'X', desktopModeEnabled: false });
  assert.equal(hidden[1].visible, false);
  assert.equal(hidden[0].label, '显示 X');
});

test('autosave round-trips objects and rejects non-object payloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-autosave-'));
  try {
    const payload = { intensity: 0.4, shelf: 'side', nested: { ok: true } };
    assert.deepEqual(fxAutosave.write(dir, payload), { ok: true });
    assert.deepEqual(fxAutosave.read(dir), payload);

    assert.equal(fxAutosave.write(dir, []).ok, false);
    assert.equal(fxAutosave.write(dir, 'nope').ok, false);
    assert.equal(fxAutosave.write(dir, null).ok, false);
    assert.deepEqual(fxAutosave.read(dir), payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autosave treats corrupt or non-object files as missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-autosave-'));
  try {
    const file = fxAutosave.getPath(dir);
    fs.writeFileSync(file, '{broken', 'utf8');
    assert.equal(fxAutosave.read(dir), null);
    fs.writeFileSync(file, '[]', 'utf8');
    assert.equal(fxAutosave.read(dir), null);
    fs.writeFileSync(file, 'null', 'utf8');
    assert.equal(fxAutosave.read(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
