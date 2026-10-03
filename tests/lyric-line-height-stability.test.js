'use strict';

// Line spacing must be a pure function of the user's own settings plus the font size. It must
// never depend on how many lines happen to be in the current payload — that is what made the
// glow/row layout jump between songs and drown out the DIY line-height slider.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const visualDir = path.join(__dirname, '..', 'public', 'js', 'modules', '02-visual');
const fontSource = fs.readFileSync(path.join(visualDir, '05-lyrics-fonts-texture.js'), 'utf8');
const modeSource = fs.readFileSync(path.join(visualDir, '08-lyrics-display-modes.js'), 'utf8');
const maskSource = fs.readFileSync(path.join(visualDir, '10-lyrics-mask-textures.js'), 'utf8');
const meshSource = fs.readFileSync(path.join(visualDir, '13-lyrics-mesh-build.js'), 'utf8');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} is missing`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

const sandbox = {
  clampRange(value, min, max) {
    return Math.max(min, Math.min(max, value));
  },
  fx: { lyricLineHeight: 1.24, lyricContextSpread: 1.96 },
  fxDefaults: { lyricLineHeight: 1.0, lyricContextSpread: 1.96 },
};
vm.createContext(sandbox);

const baseConstant = fontSource.match(/const LYRIC_MASK_LINE_HEIGHT_BASE = [^;]+;/);
assert(baseConstant, 'the shared line-height base constant is missing');
vm.runInContext(baseConstant[0], sandbox);
vm.runInContext(extractFunction(modeSource, 'lyricContextSpreadValue'), sandbox);
vm.runInContext(extractFunction(fontSource, 'lyricLineHeightFactor'), sandbox);
vm.runInContext(extractFunction(fontSource, 'lyricMaskLineHeight'), sandbox);
vm.runInContext(extractFunction(meshSource, 'stableStageLyricRowMaskLayout'), sandbox);

assert.strictEqual(typeof sandbox.lyricMaskLineHeight, 'function', 'line height must come from one shared helper');
assert.strictEqual(
  sandbox.lyricMaskLineHeight.length,
  1,
  'the line-height helper may only be parameterised by font size, never by a line count'
);

// The multi-line figure is the reference value: it keeps the previous multi-line look intact
// while single-line payloads stop collapsing to a different value.
const reference = 128 * 0.98 * 1.24 * 1.96;
assert(
  Math.abs(sandbox.lyricMaskLineHeight(128) - reference) < 1e-9,
  `line height must be font size x 0.98 x DIY factor x context spread, got ${sandbox.lyricMaskLineHeight(128)}`
);

// The row track builds from the single-line row-base payload; a second formula there is what
// desynchronised row spacing from the rendered mask.
assert.strictEqual(
  sandbox.stableStageLyricRowMaskLayout().fontSize,
  128,
  'the row-track baseline layout keeps the 128px reference size'
);
assert(
  Math.abs(sandbox.stableStageLyricRowMaskLayout().lineHeight - sandbox.lyricMaskLineHeight(128)) < 1e-9,
  'the row-track baseline layout must use exactly the same line height as the mask texture'
);

// The row track must never place rows tighter than the text they hold: one row of text occupies
// about 0.72 world units, so a sub-0.4 world step means neighbouring lines overlap.
const rowStep = (worldW, canvasWidth, canvasHeight) => {
  const lineHeight = sandbox.stableStageLyricRowMaskLayout().lineHeight;
  const worldH = worldW * (canvasHeight / canvasWidth);
  return worldH * (lineHeight / canvasHeight);
};
const singleLineStep = rowStep(6.1, 2048, 384);
assert(
  singleLineStep > 0.4,
  `a single-line row-base mask must not space rows tighter than its own glyph height, got ${singleLineStep}`
);

// The DIY slider stays the only proportional control over spacing.
sandbox.fx.lyricLineHeight = 1.8;
const tall = sandbox.lyricMaskLineHeight(128);
sandbox.fx.lyricLineHeight = 0.72;
const tight = sandbox.lyricMaskLineHeight(128);
assert(
  Math.abs(tall / tight - 1.8 / 0.72) < 1e-9,
  'the DIY line height must scale spacing proportionally across its whole range'
);

assert.doesNotMatch(
  maskSource,
  /lines\.length > 1 \? 0\.98 : 1\.0/,
  'line height must not branch on the number of lines in the payload'
);
assert.doesNotMatch(
  maskSource,
  /lines\.length > 1 \? lyricContextSpreadValue\(\) : 1/,
  'context spread must not switch on and off with the line count'
);
assert.match(
  maskSource,
  /: lyricMaskLineHeight\(fontSize\);/,
  'the rendered mask must take its line height from the shared helper'
);
assert.match(
  meshSource,
  /lineHeight: typeof lyricMaskLineHeight === 'function' \? lyricMaskLineHeight\(fontSize\)/,
  'the row-track baseline layout must delegate to the shared helper'
);

console.log('[OK] Lyric line spacing stays independent of line count and follows the DIY line-height factor.');
