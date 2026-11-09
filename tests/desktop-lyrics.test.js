'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopLyricsController } = require('../desktop/desktop-lyrics');

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.bounds = { x: 100, y: 100, width: 920, height: 190 };
    this.destroyed = false;
    this.visible = false;
    this.ignoreCalls = [];
    this.opacity = 1;
    this.closed = false;
    this.sent = [];
    this.webContents = {
      send: (channel, payload) => this.sent.push({ channel, payload }),
      once: () => {},
    };
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(next) { this.bounds = { ...next }; }
  setOpacity(value) { this.opacity = value; }
  setIgnoreMouseEvents(ignore, opts) { this.ignoreCalls.push({ ignore, opts }); }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  showInactive() { this.visible = true; }
  close() { this.closed = true; }
  loadURL() { return Promise.resolve(); }
}

function makeController(overrides = {}) {
  const mainWindow = {
    sent: [],
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => mainWindow.sent.push({ channel, payload }) },
  };
  const screen = {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 200, y: 120 }),
  };
  const controller = createDesktopLyricsController({
    BrowserWindow: FakeWindow,
    screen,
    spawn: () => { throw new Error('spawn should not run in this test'); },
    platform: 'linux',
    overlayUrl: () => 'app://desktop-lyrics',
    preloadPath: '/preload.js',
    title: 'Lyrics',
    getMainWindow: () => mainWindow,
    warn: () => {},
    ...overrides,
  });
  return { controller, mainWindow };
}

test('desktop lyrics controller creates a click-through window and broadcasts state', () => {
  const { controller, mainWindow } = makeController();
  const win = controller.create({ y: 0.7, opacity: 0.8 });
  assert.ok(win instanceof FakeWindow);
  assert.equal(controller.isOpen(), true);
  assert.equal(controller.getState().enabled, true);
  assert.equal(win.ignoreCalls[0].ignore, true);
  assert.equal(win.ignoreCalls[0].opts.forward, true);
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  assert.ok(win.sent.some((entry) => entry.channel === 'mineradio-desktop-lyrics-state'));
  assert.equal(mainWindow.sent.length, 0);

  controller.broadcastEnabled(true);
  assert.ok(mainWindow.sent.some((entry) => entry.channel === 'mineradio-desktop-lyrics-enabled-state'));
});

test('desktop lyrics controller unlocks, moves and re-locks', () => {
  const { controller } = makeController();
  const win = controller.create({ clickThrough: true, y: 0.7 });
  assert.deepEqual(controller.moveBy(10, 10), { ok: false, error: 'DESKTOP_LYRICS_LOCKED' });

  controller.setLockState(false);
  assert.equal(controller.getState().clickThrough, false);
  const before = win.getBounds();
  const moved = controller.moveBy(2000, -2000);
  assert.deepEqual(moved, { ok: true });
  assert.equal(win.bounds.x, before.x + 160);
  assert.equal(win.bounds.y, before.y - 160);

  controller.setPointerCapture(true);
  assert.equal(win.ignoreCalls.at(-1).ignore, false);

  controller.setLockState(true);
  assert.equal(controller.getState().clickThrough, true);
});

test('desktop lyrics controller hot bounds are clamped and update is routed', () => {
  const { controller } = makeController();
  controller.create({ y: 0.7 });
  controller.setHotBounds({ left: -99999, top: -99999, right: 99999, bottom: 99999 });
  assert.equal(controller.getState().enabled, true);

  controller.update({ opacity: 0.5 });
  assert.equal(controller.getState().opacity, 0.5);

  controller.update({ enabled: false });
  assert.equal(controller.getState().enabled, false);
});

test('desktop lyrics controller close resets state and announces', () => {
  const { controller, mainWindow } = makeController();
  controller.create({ y: 0.7 });
  controller.close();
  assert.equal(controller.isOpen(), false);
  assert.equal(controller.getState().enabled, false);
  assert.ok(mainWindow.sent.some((entry) => entry.channel === 'mineradio-desktop-lyrics-enabled-state'
    && entry.payload.enabled === false));
});
