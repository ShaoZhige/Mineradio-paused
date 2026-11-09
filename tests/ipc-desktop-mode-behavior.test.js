'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerDesktopModeIpc } = require('../desktop/ipc-desktop-mode');

function harness({ trusted = true } = {}) {
  const handlers = new Map();
  const calls = { shields: 0, icons: [], zone: null, sync: 0, pointer: null, lock: 0 };
  registerDesktopModeIpc({
    ipcMain: {
      on: (name, fn) => handlers.set(name, fn),
      handle: (name, fn) => handlers.set(name, fn),
    },
    isTrustedMainWindowIpc: () => trusted,
    fullDesktopModeRuntime: {
      updateIconShields: (rects) => { calls.shields = rects.length; },
      setDesktopIconsVisible: async (visible) => { calls.icons.push(visible); return { ok: true }; },
      setSoftwareInteractionLocked: async (locked) => { calls.lock += 1; return { ok: true, locked }; },
      requestKeyboardFocus: () => ({ ok: true, focused: true }),
      getStatus: () => ({ enabled: false }),
      updatePointerRoute: (route) => { calls.pointer = route; },
    },
    normalizeDesktopControllerZone: (payload) => ({ x: payload.x | 0, y: payload.y | 0 }),
    setDesktopControllerZone: (zone) => { calls.zone = zone; },
    syncDesktopControllerPointerPoll: () => { calls.sync += 1; },
    getSenderWindow: () => null,
  });
  return { handlers, calls };
}

test('icon shields only forward an array when enabled and interactive', () => {
  const { handlers, calls } = harness();
  handlers.get('mineradio-full-desktop-icon-shields')({}, { enabled: true, interactive: false, rects: [{}, {}] });
  assert.equal(calls.shields, 0);
  handlers.get('mineradio-full-desktop-icon-shields')({}, { enabled: true, interactive: true, rects: [{}, {}] });
  assert.equal(calls.shields, 2);
});

test('untrusted icon visibility request is rejected', async () => {
  const { handlers, calls } = harness({ trusted: false });
  const res = await handlers.get('mineradio-full-desktop-set-icons-visible')({}, true);
  assert.equal(res.ok, false);
  assert.equal(calls.icons.length, 0);
});

test('controller zone updates main state and restarts the poll', () => {
  const { handlers, calls } = harness();
  handlers.get('mineradio-full-desktop-controller-zone')({}, { x: 5, y: 6 });
  assert.deepEqual(calls.zone, { x: 5, y: 6 });
  assert.equal(calls.sync, 1);
});

test('software lock forwards lock state and restarts the poll', async () => {
  const { handlers, calls } = harness();
  const res = await handlers.get('mineradio-full-desktop-set-software-lock')({}, true);
  assert.equal(res.locked, true);
  assert.equal(calls.lock, 1);
  assert.equal(calls.sync, 1);
});

test('pointer route maps booleans to the runtime contract', () => {
  const { handlers, calls } = harness();
  handlers.get('mineradio-full-desktop-pointer-route')({}, { overSoftwareUi: true, overDesktopControls: false });
  assert.deepEqual(calls.pointer, { overSoftwareUi: true, overDesktopControls: false });
});
