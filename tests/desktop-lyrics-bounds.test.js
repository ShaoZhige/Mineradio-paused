'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bounds = require('../desktop/desktop-lyrics-bounds');

function makeScreen(area) {
  return {
    getPrimaryDisplay: () => ({ bounds: area }),
    getDisplayMatching: () => ({ bounds: area }),
  };
}

test('desktop lyrics default bounds stay inside the display', () => {
  const screen = makeScreen({ x: 0, y: 0, width: 1920, height: 1080 });
  const out = bounds.defaultBounds(screen, { y: 0.76 }, null);
  assert.equal(out.width, Math.round(Math.min(1920 * 0.72, 1920 - 96)));
  assert.ok(out.height >= 340 && out.height <= 560);
  assert.ok(out.x >= 0 && out.x + out.width <= 1920);
  assert.ok(out.y >= 0 && out.y + out.height <= 1080);
});

test('desktop lyrics default bounds keep the configured y ratio', () => {
  const screen = makeScreen({ x: 0, y: 0, width: 1000, height: 800 });
  const low = bounds.defaultBounds(screen, { y: 0.9 }, null);
  const high = bounds.defaultBounds(screen, { y: 0.1 }, null);
  assert.ok(low.y > high.y);
});

test('constrain bounds clamps size and position into the display', () => {
  const screen = makeScreen({ x: 100, y: 50, width: 800, height: 600 });
  const out = bounds.constrainBounds(screen, { x: -500, y: 9999, width: 20, height: 20 });
  assert.equal(out.width, 320);
  assert.equal(out.height, 180);
  assert.ok(out.x >= 100 && out.x + out.width <= 900);
  assert.ok(out.y >= 50 && out.y + out.height <= 650);
});

test('pointInBounds treats edges as inside', () => {
  const area = { x: 10, y: 10, width: 100, height: 50 };
  assert.equal(bounds.pointInBounds({ x: 10, y: 10 }, area), true);
  assert.equal(bounds.pointInBounds({ x: 110, y: 60 }, area), true);
  assert.equal(bounds.pointInBounds({ x: 111, y: 60 }, area), false);
  assert.equal(bounds.pointInBounds(null, area), false);
});
