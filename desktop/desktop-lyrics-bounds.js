'use strict';

// Pure-ish geometry helpers for the desktop lyrics overlay. The Electron screen
// object is injected so this module stays testable outside Electron.

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function defaultBounds(screen, state, userBounds) {
  const display = userBounds
    ? screen.getDisplayMatching(userBounds)
    : screen.getPrimaryDisplay();
  const area = display.bounds;
  const yRatio = clampNumber(state.y, 0.08, 0.92, 0.76);
  const width = Math.round(Math.min(Math.max(880, area.width * 0.72), area.width - 96));
  const height = Math.round(Math.min(Math.max(340, area.height * 0.38), 560, area.height - 96));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height * yRatio - height / 2),
    width,
    height,
  };
}

function constrainBounds(screen, bounds) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.bounds;
  const next = {
    ...bounds,
    width: Math.round(Math.min(Math.max(320, bounds.width), area.width)),
    height: Math.round(Math.min(Math.max(180, bounds.height), area.height)),
  };
  const maxX = area.x + Math.max(0, area.width - next.width);
  const maxY = area.y + Math.max(0, area.height - next.height);
  next.x = Math.round(clampNumber(next.x, area.x, maxX, area.x));
  next.y = Math.round(clampNumber(next.y, area.y, maxY, area.y));
  return next;
}

function pointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

module.exports = {
  clampNumber,
  defaultBounds,
  constrainBounds,
  pointInBounds,
};
