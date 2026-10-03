'use strict';

// 壁纸"发虚/与真实壁纸不符"四项修复的回归测试。
// Regression cover for the four fixes behind "blurry wallpaper that does not match the
// real wallpaper": preview fallback no longer resampled, a persistent preview label with
// a retry entry, a wider native-scene gate, and a 1x (no-resample) default zoom.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js');
const rendererText = fs.readFileSync(rendererPath, 'utf8');
const libraryText = fs.readFileSync(path.join(appRoot, 'desktop', 'wallpaper-engine-library.js'), 'utf8');
const runtimeText = fs.readFileSync(path.join(appRoot, 'desktop', 'wallpaper-engine-runtime.js'), 'utf8');
const cssText = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8').replace(/\r\n/g, '\n');
const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');

function sourceBlock(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  assert(start >= 0, `missing source block: ${startNeedle}`);
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing source block terminator: ${endNeedle}`);
  return text.slice(start, end);
}

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const syncStart = source.indexOf(`function ${name}(`);
  let from = -1;
  if (asyncStart >= 0 && (syncStart < 0 || asyncStart <= syncStart)) from = asyncStart;
  else from = syncStart;
  assert(from >= 0, `missing function: ${name}`);
  const open = source.indexOf('{', from);
  assert(open > from, `missing body for: ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${name}`);
}

function extractVarLiteral(source, name) {
  const match = new RegExp(`^var ${name} = (.+);$`, 'm').exec(source);
  assert(match, `missing var literal: ${name}`);
  return `var ${name} = ${match[1]};`;
}

function runInSandbox(prelude, sandbox) {
  const context = vm.createContext(sandbox);
  vm.runInContext(prelude, context, { filename: 'wallpaper-engine-preview-fallback.js' });
  return context;
}

function makeRendererSandbox() {
  const store = new Map();
  return {
    store,
    sandbox: {
      console,
      localStorage: {
        getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
        setItem: (key, value) => { store.set(String(key), String(value)); },
        removeItem: (key) => { store.delete(String(key)); },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// ④ 默认缩放：1.08 会让从没动过滑杆的壁纸也被无条件放大 8%（即永远多一次重采样）。
// The 1.08 default resampled every wallpaper by 8% even when the user never touched the
// zoom slider; the default is now exactly 1x.
// ---------------------------------------------------------------------------
const normalizeBlock = sourceBlock(
  rendererText,
  'function normalizeWallpaperEngineSelection(value) {',
  'function readWallpaperEngineSelection() {'
);
assert.match(
  normalizeBlock,
  /visualScale: Math\.max\(1, Math\.min\(1\.6, Number\(value\.visualScale\) \|\| WALLPAPER_ENGINE_DEFAULT_SCALE\)\)/,
  'the selection normalizer must fall back to the no-zoom default'
);

const visualSettingsBlock = sourceBlock(
  rendererText,
  'function wallpaperEngineVisualSettings() {',
  'function syncWallpaperEngineVisualControls() {'
);
assert.match(
  visualSettingsBlock,
  /scale: Math\.max\(1, Math\.min\(1\.6, Number\(wallpaperEngineSelection\.visualScale\) \|\| WALLPAPER_ENGINE_DEFAULT_SCALE\)\)/,
  'the applied visual settings must fall back to the no-zoom default'
);

const scaleVarBlock = sourceBlock(
  rendererText,
  'var WALLPAPER_ENGINE_DEFAULT_SCALE = ',
  'function migrateWallpaperEngineLegacyDefaultScale(raw) {'
);
assert.match(scaleVarBlock, /var WALLPAPER_ENGINE_DEFAULT_SCALE = 1;/, 'the default zoom must be exactly 1x');
assert.match(scaleVarBlock, /var WALLPAPER_ENGINE_LEGACY_DEFAULT_SCALE = 1\.08;/, 'the legacy default must stay recorded for migration');

const layerTransformRule = sourceBlock(cssText, '#wallpaper-engine-image,\n#wallpaper-engine-video,\n#wallpaper-engine-freeze {', '#wallpaper-engine-freeze {');
assert.match(
  layerTransformRule,
  /scale\(var\(--wallpaper-engine-visual-scale, 1\)\)/,
  'the CSS transform fallback must be 1x, not the legacy 1.08'
);
assert.doesNotMatch(
  layerTransformRule,
  /--wallpaper-engine-visual-scale, 1\.08/,
  'no 1.08 fallback may remain in the wallpaper layer transform'
);

assert.match(
  runtimeText,
  /int visualScale = 1000000;/,
  'the DWM surface host must default to 1x'
);
assert.match(
  runtimeText,
  /if \(!Int32\.TryParse\(rawScale \?\? "", out initialScale\)\) initialScale = 1000000;/,
  'the DWM surface host command-line fallback must be 1x'
);
assert.doesNotMatch(runtimeText, /1080000/, 'no 1.08 default may remain in the DWM surface host');

// ---------------------------------------------------------------------------
// ④ 一次性迁移：只有"恰好停在旧默认值 1.08"的记录才迁回 1；用户真正选过的值必须保留。
// One-shot migration: only records still exactly on the legacy 1.08 default move to 1x;
// values the user actually chose must survive.
// ---------------------------------------------------------------------------
const migrationPrelude = [
  extractVarLiteral(rendererText, 'WALLPAPER_ENGINE_SELECTION_STORE_KEY'),
  extractVarLiteral(rendererText, 'WALLPAPER_ENGINE_DEFAULT_SCALE'),
  extractVarLiteral(rendererText, 'WALLPAPER_ENGINE_LEGACY_DEFAULT_SCALE'),
  extractVarLiteral(rendererText, 'WALLPAPER_ENGINE_SCALE_MIGRATION_KEY'),
  extractFunction(rendererText, 'normalizeWallpaperEngineSelection'),
  extractFunction(rendererText, 'migrateWallpaperEngineLegacyDefaultScale'),
  extractFunction(rendererText, 'readWallpaperEngineSelection'),
  'this.__api = { read: readWallpaperEngineSelection, normalize: normalizeWallpaperEngineSelection };',
].join('\n');

const migrationStoreKey = /^var WALLPAPER_ENGINE_SELECTION_STORE_KEY = '(.+)';$/m.exec(rendererText)[1];
const migrationMarkerKey = /^var WALLPAPER_ENGINE_SCALE_MIGRATION_KEY = '(.+)';$/m.exec(rendererText)[1];

// ① 停在旧默认值的记录被迁回 1x，并且写回存储，滑杆读数随之为 1.00。
{
  const { store, sandbox } = makeRendererSandbox();
  store.set(migrationStoreKey, JSON.stringify({ active: true, id: 'a'.repeat(24), visualScale: 1.08 }));
  const context = runInSandbox(migrationPrelude, sandbox);
  const selection = context.__api.read();
  assert.strictEqual(selection.visualScale, 1, 'a record sitting on the legacy default must migrate to 1x');
  assert.strictEqual(
    JSON.parse(store.get(migrationStoreKey)).visualScale,
    1,
    'the migrated value must be written back so the slider reads 1.00'
  );
  assert.strictEqual(store.get(migrationMarkerKey), '1', 'the migration must be marked as done');
}

// ② 迁移只跑一次：用户之后手动调回 1.08（或任何值）不得被再次改写。
{
  const { store, sandbox } = makeRendererSandbox();
  store.set(migrationMarkerKey, '1');
  store.set(migrationStoreKey, JSON.stringify({ active: true, id: 'a'.repeat(24), visualScale: 1.08 }));
  const context = runInSandbox(migrationPrelude, sandbox);
  assert.strictEqual(
    context.__api.read().visualScale,
    1.08,
    'a value set after the one-shot migration must never be rewritten'
  );
}

// ③ 用户真正选过的其它缩放一律保留。
for (const scale of [1.02, 1.2, 1.3, 1.6]) {
  const { store, sandbox } = makeRendererSandbox();
  store.set(migrationStoreKey, JSON.stringify({ active: true, id: 'a'.repeat(24), visualScale: scale }));
  const context = runInSandbox(migrationPrelude, sandbox);
  assert.strictEqual(context.__api.read().visualScale, scale, `deliberate zoom ${scale} must be preserved`);
}

// ---------------------------------------------------------------------------
// ① 预览兜底不再叠加用户的位置/缩放：它只是工程目录里的封面图（常见 512×288）。
// The preview fallback is the project's cover image (often 512x288); the user's
// zoom/position must not be stacked on top of it.
// ---------------------------------------------------------------------------
const applyBackgroundBlock = sourceBlock(
  rendererText,
  'function applyWallpaperEngineBackground(item, quiet) {',
  'function activateWallpaperEngineItem(id) {'
);
assert.match(
  applyBackgroundBlock,
  /markWallpaperEnginePreviewSource\(kind === 'preview'\)/,
  'the preview fallback must be pinned to 1x while native scenes keep the user settings'
);

const clearLayerBlock = sourceBlock(
  rendererText,
  'function clearWallpaperEngineLayerMedia(delay) {',
  'function restoreOriginalBackgroundAfterWallpaperEngine() {'
);
assert.match(
  clearLayerBlock,
  /classList\.remove\('ready', 'image-ready', 'video-ready', 'engine-ready', 'freeze-ready', 'preview-source'\)/,
  'the preview marker must be cleared together with the layer media'
);
const layerReadyBlock = sourceBlock(
  rendererText,
  'function wallpaperEngineLayerReady(kind, token) {',
  'function wallpaperEngineLayerFailed('
);
assert.match(
  layerReadyBlock,
  /classList\.remove\('ready', 'image-ready', 'video-ready', 'engine-ready', 'freeze-ready'\);/,
  'layer-ready must not drop the preview marker it is called with'
);
assert.match(
  layerReadyBlock,
  /markWallpaperEnginePreviewSource\(\s*wallpaperEngineSelection\.kind === 'preview'\s*\|\| \(wallpaperEngineSelection\.kind === 'engine' && wallpaperEngineDesktopPreviewUsesAsset\)\s*\)/,
  'the preview marker must be derived from whatever is actually on screen so it clears on native recovery'
);

const previewSourceRule = sourceBlock(
  cssText,
  '#wallpaper-engine-layer.preview-source #wallpaper-engine-image,',
  'body.desktop-shell #wallpaper-engine-layer,'
);
assert.match(previewSourceRule, /#wallpaper-engine-layer\.preview-source #wallpaper-engine-video/, 'the preview marker must cover the video element too');
assert.match(previewSourceRule, /#wallpaper-engine-layer\.preview-source #wallpaper-engine-freeze/, 'the preview marker must cover the freeze frame too');
assert.match(previewSourceRule, /transform: none;/, 'the pinned preview must drop the zoom/position transform');

const previewMarkerPrelude = [
  extractFunction(rendererText, 'markWallpaperEnginePreviewSource'),
  'this.__api = { mark: markWallpaperEnginePreviewSource };',
].join('\n');
{
  const classes = new Set();
  const context = runInSandbox(previewMarkerPrelude, {
    console,
    document: {
      getElementById: () => ({
        classList: {
          toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
        },
      }),
    },
  });
  context.__api.mark(true);
  assert(classes.has('preview-source'), 'marking a preview fallback must add the class');
  context.__api.mark(false);
  assert(!classes.has('preview-source'), 'leaving the preview fallback must remove the class');
}

// ---------------------------------------------------------------------------
// ② 常驻标注 + 重试入口：一次性 toast 不是可发现的入口。
// A persistent label plus a discoverable retry entry (the one-shot toast is not enough).
// ---------------------------------------------------------------------------
const entryUiPrelude = [
  extractVarLiteral(rendererText, 'WALLPAPER_ENGINE_SELECTION_STORE_KEY'),
  'var wallpaperEngineSelection = null;',
  'var wallpaperEngineRuntimeError = \'\';',
  'var wallpaperEngineDesktopPreviewActive = false;',
  'var wallpaperEngineDesktopPreviewUsesAsset = false;',
  extractFunction(rendererText, 'updateWallpaperEngineEntryUi'),
  'this.__api = { update: updateWallpaperEngineEntryUi, setSelection: (value) => { wallpaperEngineSelection = value; }, setError: (value) => { wallpaperEngineRuntimeError = value; } };',
].join('\n');

function entryUiSandbox() {
  const nodes = {
    'wallpaper-engine-value': { textContent: '' },
    'wallpaper-engine-restore-btn': { disabled: true },
    'wallpaper-engine-retry-btn': { disabled: true },
  };
  return {
    nodes,
    sandbox: {
      console,
      document: { getElementById: (id) => nodes[id] || null },
    },
  };
}

{
  const { nodes, sandbox } = entryUiSandbox();
  const context = runInSandbox(entryUiPrelude, sandbox);
  context.__api.setSelection({ active: true, id: 'a'.repeat(24), title: '示例壁纸', kind: 'preview' });
  context.__api.setError('');
  context.__api.update();
  assert.match(nodes['wallpaper-engine-value'].textContent, /示例壁纸 · 项目预览（非动态壁纸）/, 'the entry must state that a project preview is not the wallpaper');
  assert.strictEqual(nodes['wallpaper-engine-retry-btn'].disabled, false, 'the retry entry must be enabled on a preview fallback');
  assert.strictEqual(nodes['wallpaper-engine-restore-btn'].disabled, false, 'restore stays available');
}

{
  const { nodes, sandbox } = entryUiSandbox();
  const context = runInSandbox(entryUiPrelude, sandbox);
  context.__api.setSelection({ active: true, id: 'a'.repeat(24), title: '示例壁纸', kind: 'engine' });
  context.__api.setError('');
  context.__api.update();
  assert.match(nodes['wallpaper-engine-value'].textContent, /WE 引擎实时运行/, 'a running native scene keeps its own label');
  assert.strictEqual(nodes['wallpaper-engine-retry-btn'].disabled, true, 'no retry entry while the native scene runs');
}

{
  const { nodes, sandbox } = entryUiSandbox();
  const context = runInSandbox(entryUiPrelude, sandbox);
  context.__api.setSelection({ active: false, id: '', title: '', kind: 'preview' });
  context.__api.setError('');
  context.__api.update();
  assert.strictEqual(nodes['wallpaper-engine-value'].textContent, '未启用 · 原背景保留', 'an inactive selection keeps the idle label');
  assert.strictEqual(nodes['wallpaper-engine-retry-btn'].disabled, true, 'the retry entry stays disabled while idle');
}

{
  const { nodes, sandbox } = entryUiSandbox();
  const context = runInSandbox(entryUiPrelude, sandbox);
  context.__api.setSelection({ active: true, id: 'a'.repeat(24), title: '示例壁纸', kind: 'engine' });
  context.__api.setError('WE 引擎运行失败');
  context.__api.update();
  assert.match(nodes['wallpaper-engine-value'].textContent, /WE 引擎运行失败 · 已显示原背景/, 'a failed native run reports the error');
  assert.strictEqual(nodes['wallpaper-engine-retry-btn'].disabled, false, 'a failed native run must be retryable');
}

assert.match(
  htmlText,
  /id="wallpaper-engine-retry-btn"[\s\S]{0,220}onclick="retryWallpaperEngineNativeRun\(\)"[\s\S]{0,40}disabled/,
  'the retry button must be wired to the retry handler and start disabled'
);
assert.match(
  htmlText,
  /id="wallpaper-engine-retry-btn"/,
  'the retry button must exist in the wallpaper entry row'
);

const retryBlock = sourceBlock(rendererText, 'function retryWallpaperEngineNativeRun() {', 'function deactivateWallpaperEngineBackground(quiet) {');
assert.match(retryBlock, /if \(!item\.enginePlayable\)/, 'the retry handler must explain a project that cannot run natively');
assert.match(retryBlock, /activateWallpaperEngineItem\(item\.id\)/, 'the retry handler must re-enter the normal activation path');
assert.match(
  rendererText,
  /function retryWallpaperEngineNativeRun\(\)/,
  'the retry handler must be defined'
);

// ---------------------------------------------------------------------------
// ③ 原生引擎接管范围：PKGV 签名的判据强于 project.json 里写的 type。
// The native gate: a valid PKGV signature is stronger evidence than the declared type.
// ---------------------------------------------------------------------------
const indexProjectPrelude = [
  `const path = require('path');`,
  `const fs = { promises: { realpath: async (target) => target } };`,
  `const SCENE_PACKAGE_EXTENSIONS = new Set(['.pkg', '.pak']);`,
  `const IMAGE_MIME = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);`,
  `const VIDEO_MIME = new Set(['.mp4', '.webm', '.mov']);`,
  `const SAFE_MIME = new Set([...IMAGE_MIME, ...VIDEO_MIME]);`,
  `const opaqueId = () => 'a'.repeat(24);`,
  `const sanitizeText = (value, fallback) => String(value || fallback || '');`,
  `const deriveWorkshopId = () => '';`,
  `const analyzeSceneProperties = () => ({ propertyCount: 0, audioPropertyCount: 0, mutedAudioPropertyCount: 0 });`,
  `var __manifest = null;`,
  `var __files = new Set();`,
  `async function readProjectManifest() { return __manifest; }`,
  `async function firstProjectFile(projectRoot, values, allowedMime) {`,
  `  for (const value of values || []) {`,
  `    const raw = String(value || '').trim();`,
  `    if (!raw) continue;`,
  `    if (!allowedMime.has(path.extname(raw).toLowerCase())) continue;`,
  `    if (__files.has(raw)) return path.join(projectRoot, raw);`,
  `  }`,
  `  return '';`,
  `}`,
  `async function validateScenePackage(file) { return file && /\\.(pkg|pak)$/i.test(file) ? file : ''; }`,
  extractFunction(libraryText, 'indexProject'),
  `this.__api = { index: indexProject, reset: (manifest, files) => { __manifest = manifest; __files = new Set(files); } };`,
].join('\n');

async function indexProjectCase(manifestValue, files) {
  const context = runInSandbox(indexProjectPrelude, { console, require });
  context.__api.reset({ value: manifestValue, stat: { mtimeMs: 1 }, file: '/proj/project.json' }, files);
  return context.__api.index('/proj', { kind: 'workshop', label: 'Steam 创意工坊' });
}

(async () => {
  // 声明了 scene.pkg 但没有 type → 必须仍然是原生可运行。
  {
    const result = await indexProjectCase({ title: 'A', file: 'scene.pkg' }, ['scene.pkg']);
    assert.strictEqual(result.item.enginePlayable, true, 'a declared scene.pkg without a type must stay natively playable');
    assert.strictEqual(result.item.projectType, 'scene', 'the missing type must be inferred from the declared file');
    assert.strictEqual(result.item.safetyMode, 'native-engine', 'the safety mode must report the native engine');
  }

  // 既没有 type 也没有 file，但目录里有标准 scene.pkg → 之前只显示预览图，现在必须原生运行。
  {
    const result = await indexProjectCase({ title: 'B' }, ['scene.pkg', 'preview.jpg']);
    assert.strictEqual(result.item.enginePlayable, true, 'a standard scene.pkg must be found even without type or file');
    assert.strictEqual(result.item.previewOnly, false, 'a project with a valid scene package is not preview-only');
  }

  // type 写错成 web，但确实带着 PKGV 场景包 → 以场景包为准。
  {
    const result = await indexProjectCase({ title: 'C', type: 'web', file: 'index.html' }, ['index.html', 'scene.pak']);
    assert.strictEqual(result.item.enginePlayable, true, 'a valid PKGV package must outrank a wrong declared type');
    assert.strictEqual(result.item.projectType, 'scene', 'the project must be reclassified as a scene');
  }

  // 真正只能预览的项目（无媒体、无场景包、只有封面图）不得被误判。
  {
    const result = await indexProjectCase({ title: 'D', type: 'web', file: 'index.html' }, ['index.html', 'preview.jpg']);
    assert.strictEqual(result.item.enginePlayable, false, 'a web project without a scene package must not claim native playback');
    assert.strictEqual(result.item.previewOnly, true, 'a cover-only project stays preview-only');
    assert.strictEqual(result.item.safetyMode, 'preview-only', 'the safety mode must stay preview-only');
  }

  // 可直接播放的媒体项目不受影响。
  {
    const result = await indexProjectCase({ title: 'E', type: 'video', file: 'clip.mp4' }, ['clip.mp4']);
    assert.strictEqual(result.item.playable, true, 'a video project stays directly playable');
    assert.strictEqual(result.item.enginePlayable, false, 'a video project must not be probed as a scene');
    assert.strictEqual(result.item.mediaType, 'video', 'the media type must be preserved');
  }

  // 没有 type 但声明了视频文件的项目仍需按媒体处理。
  {
    const result = await indexProjectCase({ title: 'F', file: 'clip.mp4' }, ['clip.mp4']);
    assert.strictEqual(result.item.playable, true, 'an untyped media project must keep working');
    assert.strictEqual(result.item.enginePlayable, false, 'an untyped media project must not become a scene');
  }

  console.log('[OK] Wallpaper preview fallback is pinned to 1x and labelled, the native scene gate trusts the PKGV signature over the declared type, and the default zoom no longer resamples every wallpaper.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
