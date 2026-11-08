'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'desktop/full-desktop-mode-runtime.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');

test('overlay enable restores leftover hidden icons before probing', () => {
  assert.doesNotMatch(runtime, /readOverlayIconsMarker/);
  assert.match(runtime, /fs\.existsSync\(this\.overlayIconsMarkerPath\(\)\)/);
  assert.match(runtime, /runOverlayDesktopIconsScript\('show'\)[\s\S]{0,120}writeOverlayIconsMarker\(false\)/);
});

test('leaving desktop mode always shows icons left hidden by a crash', () => {
  assert.match(runtime, /let hadHiddenMarker = false;/);
  assert.match(runtime, /if \(hadHiddenMarker\) \{[\s\S]{0,160}runOverlayDesktopIconsScript\('show'\)/);
});

test('startup repair restarts Explorer when the desktop icon host is missing', () => {
  assert.match(main, /restartExplorerForDesktopIcons/);
  assert.match(main, /taskkill', \['\/f', '\/im', 'explorer\.exe'\]/);
  assert.match(main, /if \(!result\.line && iconsHiddenByUs\)/);
});

test('startup repair keeps the marker until the icons are actually shown again', () => {
  assert.match(main, /const restored = \/ICON_LAYER_REPAIRED\/\.test\(result\.line\);/);
  assert.match(main, /if \(!iconsHiddenByUs \|\| restored\) \{[\s\S]{0,120}unlinkSync\(iconsHiddenMarker\)/);
  assert.match(main, /keeping marker for the next start/);
});
