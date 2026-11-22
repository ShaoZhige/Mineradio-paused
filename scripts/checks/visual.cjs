'use strict';

// 检查函数从原 scripts/quick-check.js **原样搬出**，断言一条未改。
const env = require('./env.cjs');
const {
  readAllCssFiles,
  readVisualArchiveText,
  logStep,
  fail,
  supportedLangs,
  requireLocaleKeys,
  fs,
  path,
  vm,
  appRoot,
} = env;

function checkLyricLayoutRangeGuard() {
  logStep('Lyric layout range guard');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const persistenceText = readVisualArchiveText();
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const bindingText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const stageText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const rangeChecks = [
    [htmlText, /id="fx-lyricx"[^>]+min="-4\.0"[^>]+max="4\.0"/, 'lyric x slider range'],
    [htmlText, /id="fx-lyricy"[^>]+min="-2\.4"[^>]+max="2\.7"/, 'lyric y slider range'],
    [htmlText, /id="fx-lyricz"[^>]+min="-3\.2"[^>]+max="3\.2"/, 'lyric z slider range'],
    [htmlText, /id="fx-lyrictiltx"[^>]+min="-84"[^>]+max="84"/, 'lyric tilt x slider range'],
    [htmlText, /id="fx-lyrictilty"[^>]+min="-84"[^>]+max="84"/, 'lyric tilt y slider range'],
    [persistenceText, /lyricOffsetX: layoutNumber\(raw\.lyricOffsetX, 0, -4\.0, 4\.0\)/, 'autosave read x range'],
    [persistenceText, /lyricTiltY: layoutNumber\(fx\.lyricTiltY, 0, -84, 84\)/, 'autosave write tilt y range'],
    [archiveText, /lyricOffsetZ: archiveNumber\(raw, 'lyricOffsetZ', fxDefaults\.lyricOffsetZ, -3\.2, 3\.2\)/, 'archive z range'],
    [bindingText, /lyricOffsetX'\) fx\.lyricOffsetX = clampRange\(fx\.lyricOffsetX, -4\.0, 4\.0\)/, 'runtime x clamp'],
    [bindingText, /lyricTiltX' \|\| pair\[1\] === 'lyricTiltY'\) fx\[pair\[1\]\] = Math\.round\(clampRange\(fx\[pair\[1\]\], -84, 84\)\)/, 'runtime tilt clamp'],
    [stageText, /var layoutY = clampRange\(Number\(fx\.lyricOffsetY\) \|\| 0, -2\.4, 2\.7\)/, 'render y range'],
    [stageText, /var layoutTiltY = clampRange\(Number\(fx\.lyricTiltY\) \|\| 0, -84, 84\)/, 'render tilt y range']
  ];
  for (const [text, pattern, label] of rangeChecks) {
    if (!pattern.test(text)) fail(`expanded lyric layout range missing: ${label}`);
  }
  console.log('[OK] Lyric layout position/depth/angle ranges stay expanded through UI, runtime, autosave, and archives.');
}

function checkPointerLockPermission() {
  logStep('Free camera pointer-lock guard');
  const mainPath = path.join(appRoot, 'desktop', 'main.js');
  const mainText = fs.readFileSync(mainPath, 'utf8');
  const freeCameraPath = path.join(appRoot, 'public', 'js', 'modules', '01-scene', '01-orbit-free-camera.js');
  const pointerPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '00-pointer-cover-particles.js');
  const freeCameraText = fs.readFileSync(freeCameraPath, 'utf8');
  const pointerText = fs.readFileSync(pointerPath, 'utf8');
  if (!/LOCAL_APP_PERMISSION_ALLOWLIST[\s\S]{0,180}pointerLock/.test(mainText)) {
    fail('pointerLock permission is missing from desktop/main.js local app allowlist');
  }
  if (/rawInputBlocked/.test(freeCameraText) || /unadjustedMovement/.test(freeCameraText)) {
    fail('free camera pointer lock must use plain requestPointerLock; raw input requests can break local Electron lock acquisition');
  }
  if (!/var lockResult = el\.requestPointerLock\(\)/.test(freeCameraText)) {
    fail('free camera pointer lock must request plain pointer lock directly');
  }
  if (!/freeCameraPointerLockActive/.test(pointerText) || !/requestFreeCameraPointerLock\('mousemove'\)/.test(pointerText)) {
    fail('free camera mouse move path must keep requesting pointer lock before using mouse deltas');
  }
  console.log('[OK] Local app pointerLock permission and plain lock request are guarded.');
}

function checkLyricBackfaceMaterialGuard() {
  logStep('Lyric backface readability guard');
  const rowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js'), 'utf8');
  if (!/makeLyricBackfaceReadableMaterial/.test(rowText) || !/gl_FrontFacing\s*\?\s*vUv\s*:\s*vec2\(1\.0 - vUv\.x, vUv\.y\)/.test(rowText)) {
    fail('row lyric translation/readability/glow materials must flip UV on backfaces like the primary lyric shader');
  }
  if (!/readabilityMat = makeLyricBackfaceReadableMaterial/.test(rowText) || !/glowMat = makeLyricBackfaceReadableMaterial/.test(rowText)) {
    fail('lyric row readability and glow layers must use backface-readable materials');
  }
  console.log('[OK] Lyric translation/readability/glow layers stay readable from the back side.');
}

function checkLyricScrollPerformanceGuard() {
  logStep('Lyric scroll performance guard');
  const rowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js'), 'utf8');
  const displayModeText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '08-lyrics-display-modes.js'), 'utf8');
  const paletteText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '07-lyrics-palette-text-utils.js'), 'utf8');
  const shaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '11-lyrics-shaders.js'), 'utf8');
  const payloadText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '09-lyrics-payloads.js'), 'utf8');
  const starRiverText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '03-lyrics-star-river.js'), 'utf8');
  const fontText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '05-lyrics-fonts-texture.js'), 'utf8');
  const maskText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '10-lyrics-mask-textures.js'), 'utf8');
  const meshText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '13-lyrics-mesh-build.js'), 'utf8');
  const stageText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const lyricText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  const lyricColorText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '01-lyric-color-controls.js'), 'utf8');
  const lyricColorSetterText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '03-cover-picker-fonts.js'), 'utf8');
  const fxBindText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const fxPanelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const lyricActionsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const switchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js'), 'utf8');
  const schedulerText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '10-frame-scheduler.js'), 'utf8');
  const previewRowLockBindings = (stageText.match(/previewMotionLock: previewMotionLock/g) || []).length;
  if (/lazyGlow/.test(rowText) || /highLineGlowBudget/.test(rowText)) {
    fail('lyric row glow must not be lazily created while scrolling; runtime canvas texture creation causes stutter');
  }
  if (/cropLyricGlowGeometryUv|lyricRowGlowCropFrame|rowGlowCrop|glowCrop/.test(rowText + meshText)) {
    fail('lyric glow must not crop away the texture feathering; hard UV crops cause visible square glow edges');
  }
  const independentGlowRasterBindings = (rowText.match(/lyricGlowRasterMetrics\(/g) || []).length;
  if (
    !/function lyricGlowTextureWidthBudget/.test(maskText) ||
    !/function lyricGlowRasterMetrics/.test(maskText) ||
    !/logicalActiveTextWidth/.test(maskText) ||
    !/minimumRasterFont/.test(maskText) ||
    !/rasterScale:\s*state\.pixelScale/.test(maskText) ||
    !/fontSize:\s*state\.fontSize/.test(maskText) ||
    independentGlowRasterBindings < 2 ||
    !/makeLyricGlowTexture\([\s\S]{0,360}glowRaster\.fontSize[\s\S]{0,360}glowRaster\.scale\)/.test(rowText) ||
    !/beginLyricGlowTextureBuild\([\s\S]{0,360}glowRaster\.fontSize[\s\S]{0,360}glowRaster\.scale\)/.test(rowText) ||
    /(?:make|begin)LyricGlowTexture(?:Build)?\([\s\S]{0,360}lineMask\.rasterScale/.test(rowText) ||
    /rowGlowAspect\s*=\s*Math\.max\(0\.12/.test(rowText) ||
    !/rowGlowTextureRatio/.test(rowText)
  ) {
    fail('row lyric glow must use its own logical-width raster budget and preserve the true long-line texture aspect ratio');
  }
  if (!/makeLyricGlowTexture\([\s\S]{0,260}activeMask\.activeLine,\s*null\)/.test(meshText) || /glowMeta\.matchMask \?/.test(meshText)) {
    fail('single-line lyric glow fallback must use the same standalone feathered texture path');
  }
  if (!/glowLockedToText/.test(rowText) || !/row\.glow\.position\.set\(glowTargetX, glowTargetY, glowTargetZ\)/.test(rowText)) {
    fail('active row lyric glow must stay locked to the text mesh while multi-line lyrics scroll');
  }
  if (/lyricBottomControlOcclusionFade/.test(rowText)) {
    fail('bottom controller glass lyric reflections are intentional and must not be masked away');
  }
  if (!/function lyricRowGlowThreeColor/.test(paletteText) || !/function lyricBeatGlowThreeColor/.test(paletteText) || !/lyricMultiLineGlowDetached/.test(paletteText) || !/lyricRowGlowThreeColor\(pal, !!row\.isTranslation\)/.test(rowText) || !/uGlowColor: \{ value: lyricStageGlowThreeColor/.test(shaderText) || !/uSolarColor: \{ value: lyricBeatGlowThreeColor/.test(shaderText)) {
    fail('multi-line lyric glow and beat bloom must follow the independent glow color instead of lyric text color changes');
  }
  if (!/rowGlow \* \(1 \+ rowGlowBeat \* 0\.46\)/.test(rowText) || !/glowTargetScale = row\.mesh \? row\.mesh\.scale\.x : scaleTarget/.test(rowText) || !/var lyricBeatGlow = fx\.lyricGlowBeat \? stageLyrics\.beatGlow : 0/.test(stageText)) {
    fail('the lyric back glow layer must pulse through opacity while staying locked to the text transform');
  }
  if (!/setLyricSparkColor\(data, lyricBeatGlowThreeColor/.test(paletteText) || !/data\.sunMat\.color\.copy\(lyricBeatGlowThreeColor/.test(paletteText) || !/stageLyricPrewarm\.mesh/.test(paletteText) || !/function setLyricMaterialColor/.test(paletteText) || !/row\.glowMat\) setLyricMaterialColor\(row\.glowMat, lyricRowGlowThreeColor/.test(paletteText) || !/if \(ru\.uColor\) ru\.uColor\.value\.copy/.test(paletteText)) {
    fail('lyric glow color changes must immediately repaint active, outgoing, and prewarmed lyric glow materials');
  }
  if (!/function lyricControlPalette/.test(lyricColorText) || !/picker\) picker\.value = tone/.test(lyricColorText) || !/picker\) picker\.value = linked \? tone : color/.test(lyricColorText) || !/setStageLyricPalette\(lyricPaletteFromHex\(fx\.lyricColor\), \{ immediate: true/.test(lyricColorSetterText)) {
    fail('lyric color controls must display the live palette and repaint lyrics immediately while dragging colors');
  }
  if (!/function lyricHighImpactTextHsl/.test(paletteText) || !/minS:\s*0\.90/.test(paletteText) || !/sampledBright/.test(paletteText) || /primary:\s*'#064b5b'/.test(paletteText)) {
    fail('cover-based lyric text color must stay high-brightness/high-saturation instead of darkening bright cover samples');
  }
  if (!/function lyricCoverLooksMonochrome/.test(paletteText) || !/avgChroma/.test(paletteText) || !/colorfulRatio/.test(paletteText) || !/best\.chroma/.test(paletteText) || /lyricTextPaletteFromHsl\(hsl, avgL, Math\.max\(0, best\.score\)\)/.test(paletteText)) {
    fail('monochrome cover lyric sampling must use real chroma statistics instead of boosting brightness scores into vivid colors');
  }
  if (!/function lyricBackdropAdaptActive\(\)\s*\{[\s\S]{0,180}fx\.lyricBackdropAdapt !== false[\s\S]{0,90}lyricBackgroundAdaptStrengthValue\(\) > 0\.001;/.test(rowText) || /preset === 7 \|\| preset === 8/.test(rowText) || !/setFxPanelControlsHidden\(\['fx-lyricbgadapt-row', 'fx-lyricbgadapt'\], false\)/.test(fxPanelText)) {
    fail('lyric bright-backdrop avoidance must stay global while honoring its performance toggle');
  }
  if (!/color: lyricBeatGlowThreeColor\(pal/.test(meshText) || !/color: lyricStageGlowThreeColor\(pal/.test(meshText) || !/uColor: \{ value: lyricBeatGlowThreeColor\(pal/.test(meshText)) {
    fail('lyric sun, texture glow, and beat particles must initialize from the glow palette instead of the text highlight color');
  }
  if (!/fx && fx\.lyricGlowLinked !== false \? 'glow-linked' : 'glow-detached'/.test(stageText) || !/stageLyricColorSignature\(pal\.glowColor\)/.test(stageText)) {
    fail('stage lyric prewarm cache key must include glow link mode and resolved glow color');
  }
  if (!/newIdx === stageLyrics\.currentIdx && stageLyrics\.current && stageLyrics\.currentPayload/.test(stageText)) {
    fail('stage lyrics must reuse the current payload while the active lyric index is unchanged');
  }
  if (!/function scheduleStageLyricPrewarmForIndex/.test(stageText) || !/stageLyricPrewarm\.targetIndex/.test(stageText)) {
    fail('stage lyric prewarm must support explicit target indexes without timer churn');
  }
  if (!/function stageLyricLightPrewarmReason/.test(stageText) || !/var lightweight = stageLyricLightPrewarmReason\(reason\)/.test(stageText) || !/lightweightTrack: lightweight/.test(stageText) || !/options\.lightweightTrack/.test(stageText)) {
    fail('intro and lyric-toggle prewarm must use lightweight track windows before the first real lyric line takes over');
  }
  if (!/setLyricTrackTarget\(stageLyricPrewarm\.mesh, payload\)/.test(stageText) || !/targetLineIndex >= Number\(data\.trackStart\)/.test(stageText)) {
    fail('stage lyric prewarm meshes must be reusable for any target line inside the prewarmed page');
  }
  if (!/function stageLyricCurrentUsesPersistentTrack/.test(stageText) || !/function initializeStageLyricPersistentTrack/.test(stageText) || !/data\.trackPersistent = true/.test(stageText) || !/data\.trackStart = 0/.test(stageText) || !/data\.trackEnd = lyricsLines\.length - 1/.test(stageText) || !/stageLyrics\.current = mesh;[\s\S]{0,100}initializeStageLyricPersistentTrack\(mesh, payload\)/.test(stageText)) {
    fail('the first multi-line lyric mesh must become the persistent whole-song track root instead of being replaced by a later full mesh');
  }
  if (!/lightPageSize/.test(stageText) || !/lightOverlap/.test(stageText) || !/lightStep/.test(stageText)) {
    fail('lightweight lyric first paint must keep its bounded overlapping window before the full-song mesh is ready');
  }
  if (!/function lyricBufferedTrackWindow\(index, mode\) \{[\s\S]{0,560}return \{ start: 0, end: last \};/.test(stageText) || /function lyricBufferedTrackWindow\(index, mode\) \{[\s\S]{0,620}var pageSize/.test(stageText) || !/var windowInfo = lyricBufferedTrackWindow\(index, mode\);/.test(stageText)) {
    fail('the logical multi-line lyric descriptor track must cover the whole song without page-dependent scroll coordinates');
  }
  if (!/function stableStageLyricRowMaskLayout/.test(meshText) || !/preparedMasks\.rowBaseMask \|\| makeLyricMask\(rowBasePayload \|\| activePayload \|\| payload \|\| text, rowBaseLayout\)/.test(meshText) || !/state\.rowBaseMask = makeLyricMask\(state\.rowBasePayload \|\| state\.activePayload \|\| state\.payload \|\| state\.text, rowBaseLayout\)/.test(meshText)) {
    fail('lyric row base masks must use a stable font layout so long lyrics do not resize while dragging');
  }
  if (!/function scheduleLyricTrackBoundaryPrewarm/.test(meshText) || !/data\.trackPersistent && typeof ensureStageLyricPersistentTrackRows/.test(meshText) || !/ensureStageLyricPersistentTrackRows\(stageLyrics && stageLyrics\.current, targetLineIndex/.test(meshText)) {
    fail('persistent lyric tracks must extend resident rows inside the same root instead of prewarming a replacement page');
  }
  if (!/function shouldSnapLyricTrackScroll/.test(meshText) || !/function snapLyricTrackScroll/.test(meshText) || !/trackScrollSnapUntil/.test(rowText + meshText + stageText) || !/needsScrollSnap/.test(rowText)) {
    fail('multi-line lyric track reuse must snap invalid first-frame scroll offsets so rows do not compress until pause/play');
  }
  if (
    !/var snapTrackScroll = shouldSnapLyricTrackScroll/.test(meshText) ||
    !/data\.trackPersistent && data\.trackScrollPrimed[\s\S]{0,260}snapTrackScroll = false/.test(meshText) ||
    /var snapTrackScroll = previewMotionLock \|\| shouldSnapLyricTrackScroll/.test(meshText) ||
    !/var previewMotionLock = stageLyricProgressPreviewActive\(\)/.test(stageText) ||
    !/progressPreviewHoldY/.test(stageText) ||
    previewRowLockBindings < 2 ||
    !/function stageLyricResidentDisplayedScrollOffset/.test(stageText) ||
    !/var displayedScrollOffset = stageLyricResidentDisplayedScrollOffset/.test(stageText) ||
    !/primeStageLyricResidentRowTransform\(data, row, transformSnapshot\)/.test(stageText) ||
    !/function stageLyricPersistentNextTextRunwayRange/.test(stageText) ||
    !/persistent-track-full-text-runway/.test(stageText) ||
    !/var previewMotionLock = opts\.previewMotionLock === true/.test(rowText) ||
    !/var pendingPayload = data\.trackPersistent && data\.trackPendingPayload/.test(rowText) ||
    !/var targetLineIndex = pendingTargetLineIndex != null/.test(rowText) ||
    !/var continuousTrackMaxRowsPerFrame = 0\.68/.test(rowText) ||
    !/trackStep = clampRange\(trackStep, -continuousTrackMaxStep, continuousTrackMaxStep\)/.test(rowText) ||
    !/function lyricNearestPrimaryLineIndexForVirtual/.test(rowText) ||
    !/var presentationLineIndex = previewTrackCorridor/.test(rowText) ||
    !/data\.trackPresentationLineIndex = presentationLineIndex/.test(rowText) ||
    /if \(previewMotionLock\) \{[\s\S]{0,140}data\.trackScrollOffset = targetIndex/.test(rowText) ||
    /if \(previewMotionLock\) \{[\s\S]{0,180}row\.mesh\.position\.set/.test(rowText) ||
    !/var continuousRowMaxRowsPerFrame = 0\.66/.test(rowText) ||
    !/rowYStep = clampRange\(rowYStep, -continuousRowMaxStepWorld, continuousRowMaxStepWorld\)/.test(rowText) ||
    !/row\.mesh\.position\.y \+= rowYStep/.test(rowText)
  ) {
    fail('progress dragging must keep the shared lyric track easing continuously while only decorative motion is locked');
  }
  if (!/function stageLyricUsesSingleLineSwap/.test(stageText) || !/mode === 'single' && !data\.usesTrack/.test(stageText) || !/if \(singleLineSwap\) \{[\s\S]{0,220}mesh\.position\.z -= dt \* 0\.26/.test(stageText) || !/if \(!singleLineSwap\) group\.position\.y \+= enterDir \* lineWorldStep/.test(meshText)) {
    fail('single-line lyrics must keep the old GitHub fade/float swap instead of inheriting multi-line scroll offsets');
  }
  if (!/function stageLyricPayloadIsSingleLine/.test(stageText) || !/function stageLyricSingleLineTrackStub/.test(stageText) || !/if \(stageLyricPayloadIsSingleLine\(payload\)\) return false;/.test(stageText) || !/singleLineBoundaryNoSyncBuild/.test(stageText) || !/var singleLineDemand = stageLyricPayloadIsSingleLine\(payload\)/.test(stageText) || !/var delay = singleLineDemand \? 0 : 16/.test(stageText)) {
    fail('single-line lyrics must stay on the cheap swap mesh path and prewarm boundary meshes instead of building on the switching frame');
  }
  if (!/if \(mode === 'single'\) \{[\s\S]{0,160}stageLyricSingleLineTrackStub\(index\)/.test(stageText) || !/trackKey: '',[\s\S]{0,140}trackEntries: singleTrack\.entries/.test(stageText) || !/function stageLyricMultiLineWarmupLoad\(\) \{[\s\S]{0,120}return mode !== 'single';/.test(stageText)) {
    fail('single-line lyric payloads must bypass buffered trackEntries even when translations are enabled');
  }
  if (!/var singleLineStartX = singleLineSwap \? 0 : \(Math\.random\(\) - 0\.5\) \* 0\.045/.test(meshText) || !/var singleLineStartX = singleLineSwap \? 0 : \(Math\.random\(\) - 0\.5\) \* 0\.045/.test(stageText) || !/if \(singleLineSwap\) \{[\s\S]{0,220}mesh\.position\.y \+= \(\(0\.18 \+ \(verticalFloatOn \?/.test(stageText)) {
    fail('single-line lyric sentence endings must avoid random lateral jumps and hard visual stops');
  }
  if (!/var stageLyricSingleLinePrewarm = \{ items: \{\}, order: \[\], max: 10 \};/.test(stageText) || !/var stageLyricTrackSwitchBootstrapUntil = 0;/.test(stageText) || !/function scheduleStageLyricSingleLineNextPrewarm/.test(stageText) || !/stageLyricSingleLineNextPrewarmReady\(currentIndex\)/.test(stageText) || !/function stageLyricSingleLineIndexPrewarmReady[\s\S]{0,420}stageLyricSingleLinePrewarmCanServePayload\(payload\)[\s\S]{0,220}stageLyricPrewarmCanServePayload\(payload\)/.test(stageText) || !/function stageLyricSingleLineWarmupPending[\s\S]{0,520}stageLyricSingleLineIndexPrewarmReady\(singleLineIndex\)/.test(stageText.replace(/function stageLyricWarmupPending/, 'function stageLyricSingleLineWarmupPending')) || !/function stageLyricSingleLineUpcomingIndexes/.test(stageText) || !/function stageLyricSingleLinePrewarmDelay/.test(stageText) || !/function scheduleStageLyricSingleLineBootstrapPrewarm/.test(stageText) || !/function scheduleStageLyricSingleLineCachePrewarm/.test(stageText) || !/takeStageLyricSingleLinePrewarmMesh\(payload\) \|\| takeStageLyricPrewarmMesh\(payload\)/.test(stageText) || !/stageLyricSingleLineUpcomingIndexes\(currentIndex, 6\)/.test(stageText) || !/stageLyricTrackSwitchBootstrapUntil = stageLyricNowMs\(\) \+ 4800/.test(stageText) || !/return 0;[\s\S]{0,260}var idx = -1;/.test(stageText) || !/stageLyricSingleLineBootstrapIndex\(\)/.test(stageText) || !/scheduleStageLyricSingleLineBootstrapPrewarm\(prewarmReason, restoreWarmup \? 24 : 44\)/.test(lyricText) || /if \(stageLyricSingleLineNextPrewarmReady\(currentIndex\)\) return true;/.test(stageText) || !/single-line-lookahead-/.test(stageText) || !/markRenderInteraction\('lyric-swap', 360\)/.test(stageText) || !/scheduleStageLyricSingleLineNextPrewarm\(newIdx, lyricT/.test(stageText)) {
    fail('single-line lyrics with translations must prewarm the next sentence mesh before the switching frame');
  }
  if (!/var primeAmount = singleLinePayload \? 0 : \(Math\.abs\(lineStep\) > 0 \? 0\.34 : 0\.24\)/.test(stageText)) {
    fail('single-line lyrics must fade in from zero like the GitHub baseline instead of popping in pre-brightened');
  }
  if (!/visibilityAbs = Math\.abs\(parentVirtualForVisibility - visibilityScrollOffset\)/.test(rowText) || !/visibleRadius \+ 1\.10 - visibilityAbs/.test(rowText)) {
    fail('translation row visibility must be calculated from its bound primary lyric row');
  }
  if (!/singleLineStaticSwap = displayMode === 'single' && !data\.usesTrack/.test(rowText) || !/singleLineTranslationSwap && isFinite\(Number\(row\.baseY\)\)/.test(rowText) || !/baseScale = Number\(row\.baseScale\)/.test(rowText) || !/cloneStageLyricEntryForLayer\(entry,\s*\{\s*virtualIndex:\s*virtualIndex\s*\}\)/.test(rowText)) {
    fail('single-line translation rows must share the primary single-line swap instead of sliding up from their own anchor');
  }
  if (!/lyricLineHasTranslationAt\(n \+ 1\)/.test(displayModeText)) {
    fail('translation-aware lyric spacing must reserve room before a translated next line enters');
  }
  if (/trackScrollPayloadKey/.test(meshText) || !/function lyricTrackScrollWindowKey/.test(meshText) || !/return payload\.trackKey;/.test(meshText) || !/data\.trackScrollWindowKey !== payloadWindowKey/.test(meshText)) {
    fail('multi-line lyric scrolling identity must stay bound to the song/style track instead of resident window bounds');
  }
  if (!/function requestStageLyricWarmup/.test(stageText) || !/function stageLyricWarmupPending/.test(stageText) || !/scheduleStageLyricPrewarmForIndex\(0, 'intro-first-line'/.test(stageText)) {
    fail('stage lyrics must warm up before the first real lyric line replaces the intro title');
  }
  if (!/function buildStageLyricPlaybackPayload/.test(stageText) || !/buildStageLyricDisplayPayload\(index, \{ lightweightTrack: true \}\)/.test(stageText) || !/stageLyricPrewarmCanServePayload\(lightweightPayload\)/.test(stageText)) {
    fail('the first real lyric line must be allowed to take over the lightweight prewarm mesh without rebuilding a full multi-line track');
  }
  if (!/shouldStartLightweight/.test(stageText) || !/currentIsLightweight/.test(stageText) || !/stageLyricMeshCanServePayload\(stageLyrics\.current, lightweightPayload\)/.test(stageText)) {
    fail('songs that enter lyrics immediately must still use a bounded first paint before that root begins resident-row streaming');
  }
  if (!/function scheduleStageLyricFullTrackWarmup/.test(stageText) || !/stageLyricFullTrackWarmupTargetAt/.test(stageText) || !/scheduleStageLyricFullTrackWarmup\(restoreWarmup \? 'track-ready-fast' : 'lyrics-ready-preload', restoreWarmup \? 120 : 24\)/.test(lyricText)) {
    fail('lyrics must schedule full-track warmup as soon as a lyric response is parsed');
  }
  if (!/function requestStageLyricRestoreWarmup/.test(stageText) || !/function scheduleStageLyricRestorePrewarm/.test(stageText) || !/var restoreWarmup = typeof stageLyricRestoreWarmupSeconds === 'function'/.test(lyricText) || !/requestStageLyricRestoreWarmup\(restoreResumeAt, token, 'startup-restore'\)/.test(playbackText)) {
    fail('startup resume lyrics must prewarm around the restored playback time instead of rebuilding uneven chunks from the first line');
  }
  if (!/function clearStageLyricFullTrackWarmup/.test(stageText) || /function disposeStageLyricPrewarmMesh\(\)\s*\{[\s\S]{0,220}stageLyricFullTrackWarmupTimer/.test(stageText)) {
    fail('disposing a lightweight prewarm mesh must not cancel the pending full-track lyric warmup');
  }
  if (!/clampRange\(Number\(data\.lineWorldStep\) \|\| 0\.38, 0\.20, 0\.94\)/.test(stageText) || !/clampRange\(Number\(data\.lineWorldStep\) \|\| lyricMotion\.slide, 0\.20, 0\.94\)/.test(stageText) || !/clampRange\(Number\(data\.lineWorldStep\) \|\| 0\.38, 0\.20, 0\.94\)/.test(rowText)) {
    fail('multi-line lyric reuse and row-layer scrolling must keep the same line spacing clamp as mesh construction');
  }
  if (!/function lyricsAreFallbackTitleOnly/.test(lyricText) || !/var fallbackTitleOnly = lyricsAreFallbackTitleOnly\(lyricsLines\)/.test(lyricText) || !/if \(!fallbackTitleOnly && typeof scheduleStageLyricFullTrackWarmup === 'function'\)/.test(lyricText)) {
    fail('track-title fallback lyrics must not schedule a full multi-line track warmup before real lyrics arrive');
  }
  if (!/function resetLyricsForTrackSwitch/.test(lyricText) || !/function scheduleTrackSwitchFallbackLyrics/.test(lyricText) || !/multiLineDelay/.test(lyricText) || !/scheduleTrackSwitchFallbackLyrics\(song, token, 1500\)/.test(playbackText) || !/cancelPendingTrackFallbackLyrics\(\)/.test(lyricText)) {
    fail('track switches must delay title fallback lyrics so real lyrics do not trigger a double load');
  }
  if (!/var trackLightweight = false/.test(payloadText) || !/trackLightweight = input\.trackLightweight === true/.test(payloadText) || !/trackLightweight: trackLightweight/.test(payloadText)) {
    fail('stage lyric payload normalization must preserve lightweight track windows for stutter-free multi-line first paint');
  }
  if (!/var earlyLyricFetchStarted = false/.test(playbackText) || !/function startTrackLyricFetch/.test(playbackText) || !/if \(!earlyLyricFetchStarted\) fetchLyric\(song, token\)/.test(playbackText)) {
    fail('track switches must start lyric fetching in parallel with audio URL loading and avoid duplicate fetches');
  }
  if (/scheduleStageLyricPrewarm\('renderLyrics', 32\)[\s\S]{0,180}clearStageLyrics\(\)/.test(lyricText)) {
    fail('renderLyrics must not cancel its own lightweight stage lyric prewarm');
  }
  if (!/stageLyricFullTrackWarmupDelay/.test(stageText) || !/requestIdleCallback/.test(stageText) || !/lightweight-upgrade/.test(stageText)) {
    fail('multi-line full-track lyric warmup must be delayed, prefer idle time, and upgrade lightweight pages without repeated line-end postponement');
  }
  if (!/function stageLyricTextLoadInfo/.test(stageText) || !/function stageLyricPreferLightweightTrack/.test(stageText) || !/function stageLyricShouldSkipFullTrackWarmup/.test(stageText) || !/stageLyricPreferLightweightTrack\(\)\) return false;[\s\S]{0,120}return false;/.test(stageText) || !/if \(stageLyricShouldSkipFullTrackWarmup\(reason\)\) return false;/.test(stageText)) {
    fail('dense lyrics must use lightweight first paint only, then allow full-track warmup for steady scrolling');
  }
  if (!/requestStageLyricWarmup\('toggleLyricsPanel'/.test(lyricText) || !/scheduleStageLyricPrewarm\('toggleLyricsPanel', 48\)/.test(lyricText) || !/scheduleStageLyricFullTrackWarmup\('track-ready', 220\)/.test(lyricText)) {
    fail('manual lyric toggle must defer initial rendering and prewarm instead of building the full lyric mesh on the click frame');
  }
  if (!/requestStageLyricWarmup\('setParticleLyricsSilently'/.test(fxBindText) || !/scheduleStageLyricPrewarm\('setParticleLyricsSilently', 48\)/.test(fxBindText) || !/scheduleStageLyricFullTrackWarmup\('track-ready', 220\)/.test(fxBindText)) {
    fail('silent lyric activation must also use the warmup/prewarm path');
  }
  if (!/function scheduleQueueLyricPrefetch/.test(lyricText) || !/async function runQueueLyricPrefetch/.test(lyricText) || !/if \(audio && audio\.paused\) return false;/.test(lyricText) || /\/api\/(?:song\/url|qq\/song\/url|kugou\/song\/url|qishui\/song\/url|spotify\/song\/url)/.test(lyricText) || !/scheduleQueueLyricPrefetch\(idx, 2400\)/.test(playbackText)) {
    fail('queue lyric prefetch must stay isolated from audio URL switching and only run after playback is stable');
  }
  if (!/function shouldDeferStageLyricSyncBuild/.test(stageText) || !/showStageLine\(displayPayload, false, \{ noSyncBuild: true \}\)/.test(stageText)) {
    fail('long lyric page switches must not synchronously build a new mesh on the animation tick');
  }
  if (!/var singleLineBoundaryNoSyncBuild = options\.noSyncBuild && singleLinePayload && !redrawOnly && stageLyrics\.current;/.test(stageText) || !/if \(singleLineBoundaryNoSyncBuild\) \{[\s\S]{0,100}requestStageLyricDemandPrewarm\(payload\);[\s\S]{0,80}return false;[\s\S]{0,40}\}/.test(stageText)) {
    fail('single-line lyric sentence switches must not synchronously build a new mesh on the animation tick');
  }
  if (!/var lightweightFallback = buildStageLyricDisplayPayload\(newIdx, \{ lightweightTrack: true \}\)/.test(stageText) || !/displayPayload = lightweightFallback/.test(stageText)) {
    fail('long lyric page switches must fall back to a lightweight window when the full track page is not ready');
  }
  if (!/var track = options\.lightweightTrack\s*\? buildStageLyricMeshTrackEntries\(index, mode, options\)\s*:\s*buildStageLyricTrackEntries\(index, mode\)/.test(stageText)) {
    fail('triple and multi-line lyrics must use the full-song track cache after the lightweight first-paint path');
  }
  if (!/var multiLineLoad = stageLyricMultiLineWarmupLoad\(\)/.test(stageText) || !/if \(payload\.trackLightweight\) return false;/.test(stageText) || !/if \(!multiLineLoad && lyricsLines\.length < 24\) return false;/.test(stageText) || !/if \(options\.noSyncBuild\) \{[\s\S]{0,100}requestStageLyricDemandPrewarm\(payload\);[\s\S]{0,60}return false;/.test(stageText) || /allowLightweightSyncBuild/.test(stageText)) {
    fail('multi-line lyrics must defer both lightweight and full mesh builds off the animation tick');
  }
  if (!/function beginLyricRowLayerGroupBuild/.test(rowText) || !/function appendLyricRowLayerBuildPhase/.test(rowText) || !/function stepLyricRowLayerGroupBuild/.test(rowText) || !/function beginCooperativeLyricMeshBuild/.test(meshText) || !/function stepCooperativeLyricMeshBuild/.test(meshText) || !/stepCooperativeLyricMeshBuild\(job\.state, 1, 4\.2\)/.test(stageText) || !/stageLyricPrewarm\.workTimer/.test(stageText)) {
    fail('multi-line lyric meshes must be built cooperatively in bounded row sub-phases');
  }
  if (!/function beginLyricReadabilityTextureBuild/.test(maskText) || !/function stepLyricReadabilityTextureBuild/.test(maskText) || !/LYRIC_READABILITY_BUILD_PHASES = 4/.test(maskText) || !/function beginLyricGlowTextureBuild/.test(maskText) || !/function stepLyricGlowTextureBuild/.test(maskText) || !/LYRIC_GLOW_BUILD_PHASES = 12/.test(maskText) || !/row-readability-/.test(rowText) || !/row-glow-/.test(rowText)) {
    fail('lyric readability and glow textures must remain split into cooperative drawing sub-phases');
  }
  if (!/function beginLyricMaskLayoutMetricsBuild/.test(maskText) || !/function stepLyricMaskLayoutMetricsBuild/.test(maskText) || !/function finishLyricMaskLayoutMetricsBuild/.test(maskText) || !/beginLyricMaskLayoutMetricsBuild\(payload \|\| text\)/.test(meshText) || !/stepLyricMaskLayoutMetricsBuild\(state\.layoutState, 1\)/.test(meshText) || !/function lyricRowLayerBundleActiveMask/.test(meshText) || !/lyricRowLayerBundleActiveMask\(preparedRowLayerBundle\)/.test(meshText)) {
    fail('cooperative multi-line lyrics must measure layout without drawing an unused full-window texture and reuse the active row mask');
  }
  if (!/function lyricTextureClarityScale/.test(maskText) || !/lyricTextureClarity/.test(maskText + stageText) || !/function lyricRowTextureWidthBudget/.test(maskText) || !/function compactLyricLineMaskTexture/.test(maskText) || !/renderer\.domElement\.width/.test(maskText) || !/profile && profile\.lowSpec/.test(maskText) || !/mask\.rasterScale/.test(maskText) || !/compactLyricLineMaskTexture\(makeLyricMask/.test(rowText) || !/var glowRaster = lyricGlowRasterMetrics\(row\.lineMask\);[\s\S]{0,420}beginLyricGlowTextureBuild\([\s\S]{0,360}null,\s*glowRaster\.scale\);/.test(rowText) || !/pixelScale/.test(maskText)) {
    fail('row lyric textures must scale to the physical render width and preserve glow/readability proportions');
  }
  if (!/var lyricTextMeasureCache/.test(fontText) || !/function lyricMeasuredCharacterWidth/.test(fontText) || !/fontKerning/.test(fontText) || !/probeSpacing = 0\.001/.test(fontText) || !/function scheduleLyricTextMeasureWarmup/.test(fontText) || !/requestIdleCallback/.test(fontText) || !/layoutMeasureBaseSize:\s*128/.test(maskText) || !/layoutBaseWidthCache/.test(maskText) || !/function measureWidestAtSize/.test(maskText) || !/estimatedFont/.test(maskText)) {
    fail('lyric font fitting must keep bounded character-width caching and coarse-to-exact size selection');
  }
  if (!/function scheduleStageLyricCooperativeWork/.test(stageText) || !/stageLyricPrewarm\.workRaf/.test(stageText) || !/requestAnimationFrame\(function \(\)/.test(stageText) || !/function stageLyricShouldYieldToPendingInput/.test(stageText) || !/isInputPending/.test(stageText)) {
    fail('lyric cooperative work must run after a rendered frame and yield to pending continuous input');
  }
  if (!/var stageLyricResidentBuild = \{ job: null, timer: 0, raf: 0, token: 0 \}/.test(stageText) || !/function startStageLyricResidentBuild/.test(stageText) || !/function ensureStageLyricPersistentTrackRows/.test(stageText) || !/function mergeStageLyricResidentBundle/.test(stageText) || !/function trimStageLyricPersistentTrackRows/.test(stageText) || !/stageLyrics\.current !== job\.mesh/.test(stageText)) {
    fail('multi-line lyrics must stream bounded resident rows into one persistent root with a single cancellable build job');
  }
  if (!/function stageLyricPersistentTargetRowsReady/.test(stageText) || !/function stageLyricPersistentTargetEffectsReady/.test(stageText) || !/function commitStageLyricPersistentPendingTarget/.test(stageText) || !/pending target committed before upload/.test(fs.readFileSync(__filename, 'utf8')) || !/d\.trackPendingProgress =/.test(meshText) || !/pendingWindowAllowed/.test(rowText)) {
    fail('seek targets must stay pending until every visible primary and translation text row is resident and uploaded');
  }
  if (!/function cancelLyricRowLayerGroupBuild/.test(rowText) || !/releaseLyricRowLayerBuildCanvas/.test(rowText) || !/function scheduleStageLyricResidentDemand/.test(stageText) || !/stageLyricProgressPreviewActive\(\)/.test(stageText) || !/coalescedOptions\.urgent = false/.test(stageText) || !/trackTextOnly/.test(rowText + stageText) || !/stageLyricShouldYieldToPendingInput\(\) && !job\.interactive && !job\.textOnly/.test(stageText) || !/lyricCustomLineCount = 10/.test(fs.readFileSync(__filename, 'utf8'))) {
    fail('continuous seek previews must coalesce demand while letting the final text-only window make bounded progress through pending input');
  }
  if (!/stageLyricTrackGeneration \+= 1/.test(stageText) || !/songKey,\s*stageLyricTrackGeneration/.test(stageText)) {
    fail('lyric track identity must change when refreshed lyrics alter a middle line');
  }
  if (!/function refreshStageLyricDisplayMode\(\) \{\s*refreshCurrentLyricStyle\(\);\s*\}/.test(lyricActionsText) || !/buildStageLyricDisplayPayload\(stageLyrics\.currentIdx, \{ lightweightTrack: true \}\)/.test(stageText)) {
    fail('lyric display mode changes must rebuild from a lightweight payload instead of synchronously constructing the whole song');
  }
  if (/renderer\.initTexture/.test(maskText + rowText + meshText + stageText)) {
    fail('lyric texture prewarm must not force synchronous GPU uploads with renderer.initTexture');
  }
  if (!/var lyricDisposeQueue = \[\]/.test(starRiverText) || !/function flushLyricDisposeQueue/.test(starRiverText) || !/processed < 12/.test(starRiverText)) {
    fail('lyric mesh disposal must stay split into bounded background chunks');
  }
  if (!/mesh\.visible = false/.test(rowText) || !/readability\.visible = false/.test(rowText) || !/renderRevealAt/.test(rowText) || !/renderLineUploaded/.test(rowText) || !/renderReadabilityUploaded/.test(rowText) || !/renderGlowUploaded/.test(rowText) || !/var renderRevealCandidates = \[\]/.test(rowText) || !/renderRevealCandidates\.sort/.test(rowText) || !/function resetLyricRenderUploadFrameBudget/.test(rowText) || !/function consumeLyricRenderUploadFrameBudget/.test(rowText) || !/if \(!consumeLyricRenderUploadFrameBudget\(\)\) break/.test(rowText) || !/resetLyricRenderUploadFrameBudget\(true\)/.test(stageText) || !/__mineradioLyricUploadBudgetStats/.test(rowText) || !/row\.mesh\.visible = lineLayerVisible/.test(rowText) || !/row\.glow\.visible = glowLayerVisible/.test(rowText)) {
    fail('all lyric meshes in a rendered frame must share one texture-upload token instead of each receiving a local budget');
  }
  if (!/var persistentTrackTransparentPrewarm =/.test(rowText) || !/data\.trackPersistent/.test(rowText) || !/transparentPrewarm: true/.test(rowText) || !/priority: 300 \+ trackPrewarmOrder/.test(rowText) || !/priority: 400 \+ trackPrewarmOrder/.test(rowText) || !/priority: 500 \+ trackPrewarmOrder/.test(rowText)) {
    fail('resident rows in the persistent lyric root must prewarm text, readability, and glow transparently before entering view');
  }
  if (!/function stageLyricPersistentLineEffectsResident/.test(stageText) || !/persistent-track-visible-effects/.test(stageText) || !/textOnly: true/.test(stageText) || !/maxOffset \+ \(interactivePreview \? 10 : 24\)/.test(stageText) || !/existingRow\.readability = row\.readability/.test(stageText) || !/existingRow\.glow = row\.glow/.test(stageText)) {
    fail('persistent lyrics must build a long text-only runway first and enrich only the visible rows with effects');
  }
  if (!/mask\.logicalFontSize/.test(maskText) || !/mask\.logicalWidth/.test(maskText) || !/function lyricRowLogicalWorldWidth/.test(rowText) || !/baseMask\.logicalFontSize \|\| baseMask\.fontSize/.test(rowText) || !/layoutMask\.logicalFontSize/.test(stageText) || !/var scaleDistance = motionAnchor \? 0 : visibilityAbs/.test(rowText) || !/stableMotionIndex/.test(rowText)) {
    fail('resident lyric raster compaction and wide canvases must preserve a stable logical font size and active-row scale');
  }
  if (!/function lyricViewportFitRatio/.test(rowText) || !/function lyricRowLiveViewportScale/.test(rowText) || !/Math\.min\(leftSpace, rightSpace\) \* 2/.test(rowText) || !/row\.mesh\.localToWorld\(lyricViewportFitLeft\)/.test(rowText) || !/lyricViewportFitLeft\.project\(camera\)/.test(rowText) || !/renderWindowActive && \(!fx \|\| fx\.lyricLiveViewportFit !== false\)/.test(rowText) || !/baseScale \*= lyricRowLiveViewportScale\(row, baseScale\)/.test(rowText) || /lyricLongLineDefaultScale|longLineScale|1380\s*\//.test(rowText)) {
    fail('when enabled, original and translated long lyrics must fit the live left/right viewport space without fixed-width hard compression');
  }
  if (!/var frameScale =/.test(rowText) || !/1 - Math\.pow\(1 - baseTrackEase, frameScale\)/.test(rowText) || !/deltaTime: dt/.test(stageText)) {
    fail('lyric scroll easing must keep the same timing across display frame rates');
  }
  if (/stageLyricBeginPreparedTrackTexturePrewarm|stageLyricPreparedTrackTextReady|warmPreparedStageLyricTrackTextures|full-track-textures-ready/.test(stageText) || !/data\.trackPendingPayload = payload/.test(meshText) || !/ensureStageLyricPersistentTrackRows\(mesh, targetLineIndex/.test(meshText) || !/return true;[\s\S]{0,120}data\.trackPendingPayload = null/.test(meshText)) {
    fail('same-song lyric demand must stay on the persistent root and must not wait for a later whole-track takeover');
  }
  if (!/renderInitialTextReady/.test(rowText + meshText) || !/initialTextRowsReady/.test(rowText) || !/initialTextRevealPending \? 0/.test(rowText) || !/lineUploadPrewarm/.test(rowText) || !/revealPrewarmMaxOffset \+ 1/.test(rowText) || !/motionAnchor \|\| row\.renderLineUploaded \? 0/.test(rowText) || !/priority: 100 \+/.test(rowText) || !/priority: 200 \+/.test(rowText)) {
    fail('multi-line lyric rows must upload all visible text before revealing readability or glow layers as one coherent block');
  }
  if (!/function stageLyricShouldHoldOutgoingForReveal/.test(stageText) || !/lyricRevealSuccessor/.test(stageText) || !/stageLyricTrackRevealReady\(revealSuccessor\)/.test(stageText) || !/if \(holdingForLyricReveal\) return true/.test(stageText)) {
    fail('same-track lyric page and lightweight/full handoffs must retain the outgoing lyrics until the incoming text block is ready');
  }
  if (/track-demand\|track-boundary-next\|track-boundary-prev/.test(stageText) || !/trackLightweight/.test(stageText + rowText + meshText)) {
    fail('long lyric boundary/demand prewarm must use full track windows and distinguish light/full meshes');
  }
  if (!/if \(!payload\.trackLightweight && data\.trackLightweight\) return false;/.test(stageText) || !/if \(!data\.trackPersistent && !payload\.trackLightweight && data\.trackLightweight\) return false;/.test(meshText)) {
    fail('only the persistent track root may reuse its bounded bootstrap mesh for later same-song lines');
  }
  if (!/function lyricTranslationMeshScale/.test(rowText) || !/fontScale: fontScale/.test(rowText) || !/scale: primaryLine \? 1 : \(entry\.scale \|\| lyricTranslationScaleValue\(\)\)/.test(rowText)) {
    fail('translation font-size control must affect translation row texture scale and mesh scale');
  }
  if (!/rowGlowPad/.test(rowText) || /glowTargetScale = row\.mesh \? row\.mesh\.scale\.x \* \(1\.0 \+ rowGlowBeat/.test(rowText)) {
    fail('row lyric glow must feather outside the text while staying locked to the lyric mesh scale during beat pulses');
  }
  if (!/function lyricKaraokeWordRanges/.test(stageText) || !/lyricMeasureTextAtSize\(ctx, text\.slice\(0, c0\)/.test(stageText) || !/mesh\.userData\.nativeKaraokeProgress/.test(stageText) || !/updateLyricMeshProgress\(stageLyrics\.current, progress, \{ nativeKaraoke: lyricLineHasNativeKaraoke\(curLine\) \}\)/.test(stageText)) {
    fail('native YRC karaoke highlight must follow word timing and measured word width without smoothed line-level lag');
  }
  if (!/function retireCurrentStageLyricForIdle/.test(stageText) || !/pausedWithTrack/.test(stageText) || !/if \(pausedWithTrack\) \{[\s\S]{0,360}return;[\s\S]{0,120}retireCurrentStageLyricForIdle\(\)/.test(stageText)) {
    fail('paused playback must keep the current lyric mesh instead of retiring it after a few seconds');
  }
  if (!/function resetFrameGate/.test(schedulerText) || !/function markStageLyricsPlaybackResume/.test(stageText) || !/resetFrameGate\(mainFrameGates\.lyricsParticles/.test(stageText) || !/markStageLyricsPlaybackResume\(reason \|\| 'playback-started'\)/.test(controlsText) || !/markStageLyricsPlaybackResume\(reason\)/.test(switchText)) {
    fail('lyric playback resume must clear frame-gate backlog and reuse the smooth paused lyric state');
  }
  const resumeStart = stageText.indexOf('function markStageLyricsPlaybackResume(reason)');
  const resumeEnd = stageText.indexOf('function tickLyricsParticles', resumeStart);
  const resumeBody = resumeStart >= 0 && resumeEnd > resumeStart ? stageText.slice(resumeStart, resumeEnd) : '';
  if (
    !/function stageLyricCurrentCanResumeWithoutWarmup/.test(stageText) ||
    !/function stageLyricCurrentUsesLightweightTrack/.test(stageText) ||
    !/stageLyricResumeWarmupLastAt/.test(stageText) ||
    !/stageLyricResumeUpgradeDeferUntil/.test(stageText) ||
    !/Number\(stageLyricResumeUpgradeDeferUntil\)/.test(stageText) ||
    !/canResumeWithoutWarmup[\s\S]{0,180}resetStageLyricResumeFrameGates\(\);[\s\S]{0,80}return;/.test(resumeBody) ||
    !/requestStageLyricLightweightUpgrade\(reason, 520\)/.test(resumeBody) ||
    /upgradeCurrentStageLyricFromPreparedTrack/.test(resumeBody)
  ) {
    fail('pause/resume must reuse the current lyric mesh and defer heavy lyric upgrades off the input frame');
  }
  if (
    !/function canResumePausedAudioFast/.test(controlsText) ||
    !/function resumePausedAudioFast/.test(controlsText) ||
    !/function schedulePausedAudioResumeMaintenance/.test(controlsText) ||
    // The span between the fast-resume shortcut and the audio-graph health check
    // is allowed to grow: it now also carries the "wait for canplay after a track
    // switch" step. The anchors are what matter, not the exact character count.
    !/var fastResume = await resumePausedAudioFast\(opts\);[\s\S]{0,80}if \(fastResume === true\) return true;[\s\S]{0,400}if \(!audioGraphHealthy\(\)\) initAudio\(\);/.test(controlsText) ||
    !/restorePlaybackGain\(\);[\s\S]{0,120}await awaitMediaPlayWithTimeout\(media, media\.play\(\), token\);/.test(controlsText) ||
    !/setTimeout\(async function \(\) \{[\s\S]{0,240}ensurePlaybackAudioGraph\(\(reason \|\| 'manual-resume-fast'\) \+ '-deferred-graph'\)/.test(controlsText)
  ) {
    fail('space/button pause resume must use a fast paused-audio path and defer graph maintenance off the input frame');
  }
  console.log('[OK] Lyric scrolling keeps one persistent whole-song text runway, bounded effect layers, realtime continuous drag, and warm lyric activation.');
}

function checkLyricTranslationCompletenessGuard() {
  logStep('Netease lyric translation guard');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const lyricText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  if (!/lyricBodyHasTranslation/.test(serverText) || !/mergeLyricBodies/.test(serverText) || !/ytlrc/.test(serverText)) {
    fail('server /api/lyric must merge legacy lyric translations and return ytlrc');
  }
  if (!/buildLyricTranslationPayload/.test(lyricText) || !/response\.ytlrc/.test(lyricText) || !/translationMatch/.test(lyricText) || !/lyricTranslationTextFromAliases/.test(lyricText) || !/source\.trans/.test(lyricText) || !/hasInterleavedText/.test(lyricText)) {
    fail('frontend lyric parser must merge tlyric/trans/ytlrc and keep order fallback metadata');
  }
  if (!/isLyricCreditLineText/.test(lyricText) || !/orderedPrimaryIndexes/.test(lyricText)) {
    fail('frontend lyric parser must skip singer/credit lines when attaching translated lyrics');
  }
  if (!/function scheduleNeteaseLyricTranslationFallback/.test(lyricText) || !/function findNeteaseLyricFallbackCandidate/.test(lyricText) || !/songProviderKey\(song\) === 'netease'/.test(lyricText) || !/requestIdleCallback/.test(lyricText) || !/mergeInlineLyricResponseForSong/.test(lyricText)) {
    fail('non-Netease providers must asynchronously reuse the Netease translation merge path without blocking primary lyric paint');
  }
  console.log('[OK] Netease tlyric/ytlrc translation merge is guarded.');
}

function checkLyricVerticalFloatToggleGuard() {
  logStep('Lyric vertical float toggle guard');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const persistenceText = readVisualArchiveText();
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const panelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const bindingText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const stageText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const rowText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js'), 'utf8');
  if (!/lyricVerticalFloat:\s*true/.test(defaultsText) || !/id="t-lyricVerticalFloat"/.test(htmlText) || !/toggleFx\('lyricVerticalFloat'\)/.test(htmlText)) {
    fail('lyric vertical float toggle must exist in defaults and UI');
  }
  if (!/lyricVerticalFloat: raw\.lyricVerticalFloat !== false/.test(persistenceText) || !/lyricVerticalFloat: fx\.lyricVerticalFloat !== false/.test(persistenceText) || !/'lyricVerticalFloat'/.test(archiveText)) {
    fail('lyric vertical float toggle must persist through autosave and preset archive');
  }
  if (!/t-lyricVerticalFloat/.test(panelText) || !/key === 'lyricVerticalFloat'/.test(bindingText) || !/bind_lyrics_float_on/.test(bindingText) || !/bind_lyrics_float_off/.test(bindingText)) {
    fail('lyric vertical float toggle must sync panel state and show toggle feedback');
  }
  requireLocaleKeys('bind_lyrics_float_on', 'bind_lyrics_float_off');
  if (!/function lyricVerticalFloatEnabled/.test(stageText) || !/var lyricFloatAmp = verticalFloatOn \?/.test(stageText) || !/style === 'float' && verticalFloatOn/.test(stageText)) {
    fail('stage lyric renderer must gate vertical float/breathing on the toggle');
  }
  if (!/var previewMotionLock = opts\.previewMotionLock === true/.test(rowText) || !/var verticalFloatOn = !previewMotionLock/.test(rowText) || !/motionAnchor \|\| !verticalFloatOn/.test(rowText) || !/var rowDrift = previewMotionLock \? 0 :/.test(rowText) || !/verticalFloatOn \? \(isActive \? jitterY/.test(rowText)) {
    fail('row lyric layers must also stop vertical jitter when the toggle is off');
  }
  console.log('[OK] Lyric vertical float toggle is wired through UI, persistence, archive, and render layers.');
}

function checkSonicTopographyPresetGuard() {
  logStep('Sonic topography visual preset guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const coreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const packagedText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '05-packaged-fx-archive.js'), 'utf8');
  const runtimeText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const persistenceText = readVisualArchiveText();
  const pointerText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '00-pointer-cover-particles.js'), 'utf8');
  const gestureText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '00-gesture-control.js'), 'utf8');
  const orbitText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '01-orbit-free-camera.js'), 'utf8');
  const focusCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '03-focus-cinema-camera.js'), 'utf8');
  const beatCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '02-beat-camera-runtime.js'), 'utf8');
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const presetGridText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '04-preset-grid-uniforms.js'), 'utf8');
  const presetCssText = readAllCssFiles();
  const fxBindText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const fxPanelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const mainLoopText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '11-main-loop.js'), 'utf8');
  const sonicText = fs.readFileSync(path.join(appRoot, 'public', 'sonic-topography-preset.js'), 'utf8');
  const sonicWorkshopText = fs.readFileSync(path.join(appRoot, 'public', 'sonic-workshop-preset.js'), 'utf8');
  const highwayText = fs.readFileSync(path.join(appRoot, 'public', 'highway-drive-preset.js'), 'utf8');
    const shelfCoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const sonicWorkshopBridgeText = fs.readFileSync(path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'mineradio-bridge.html'), 'utf8');
  const paletteText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '07-lyrics-palette-text-utils.js'), 'utf8');
  const accentControlText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '02-accent-background-controls.js'), 'utf8');
  const colorLabText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '06-custom-background-colorlab.js'), 'utf8');
  const keyboardCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '06-keyboard-camera-events.js'), 'utf8');
  const sonicAudioText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '06-sonic-audio-monitor.js'), 'utf8');
  const defaultArchiveText = fs.readFileSync(path.join(appRoot, 'public', 'default-user-fx-archive.json'), 'utf8');
  const starRiverText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '03-lyrics-star-river.js'), 'utf8');
  const stageLyricsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js'), 'utf8');
  const combinedFxState = defaultsText + packagedText + persistenceText + archiveText + fxBindText + fxPanelText + sonicAudioText + defaultArchiveText;
  const requiredSonicFields = [
    'sonicGroundAmplitude',
    'sonicGroundMotionSpeed',
    'sonicGroundDensity',
    'sonicGroundRange',
    'sonicGroundLower',
    'sonicGroundDepth',
    'sonicGroundAutoRotate',
    'sonicGroundColorMode',
    'sonicGroundBaseColor',
    'sonicGroundCoolColor',
    'sonicGroundWarmColor',
    'sonicGroundAccentColor',
    'sonicGroundGlow',
    'sonicGroundSubBass',
    'sonicGroundBass',
    'sonicGroundLowMid',
    'sonicGroundMid',
    'sonicGroundHighMid',
    'sonicGroundPresence',
    'sonicGroundBrilliance',
    'sonicGroundAir',
    'sonicGroundFloatingEnabled',
    'sonicGroundFloatingIntensity',
    'sonicGroundFloatingMinSize',
    'sonicGroundFloatingMaxSize',
    'sonicGroundFloatingSpeed',
    'sonicGroundFloatingCount',
    'sonicAudioMonitorEnabled',
    'sonicAudioAutoTrack',
    'sonicAudioSensitivity',
    'sonicAudioBandStart',
    'sonicAudioBandEnd',
    'sonicAudioThreshold',
    'sonicAudioPulseStrength',
    'sonicWorkshopInputGain',
    'sonicWorkshopAudioIntensity',
    'sonicWorkshopResponseRange',
    'sonicWorkshopPeakIntensity',
    'sonicWorkshopColorMode',
    'sonicWorkshopTheme',
    'sonicWorkshopCustomColor',
    'sonicWorkshopBaseColorMode',
    'sonicWorkshopBaseColor',
    'sonicWorkshopWarmColorMode',
    'sonicWorkshopWarmColor',
    'sonicWorkshopCoolColorMode',
    'sonicWorkshopCoolColor',
    'sonicWorkshopRippleColorMode',
    'sonicWorkshopRippleColor',
    'sonicWorkshopPeakColorMode',
    'sonicWorkshopPeakColor',
    'cameraViewSaved',
    'cameraViewMode',
    'cameraOrbitTheta',
    'cameraOrbitPhi',
    'cameraOrbitRadius',
    'cameraFreePositionX',
    'cameraFreePositionY',
    'cameraFreePositionZ',
    'cameraFreeYaw',
    'cameraFreePitch',
    'cameraFreeRoll',
    'cameraFreeFov',
    'visualRotationSaved',
    'visualRotationX',
    'visualRotationY'
  ];
  if (!/sonic-topography-preset\.js/.test(loaderText) || !/var INDEX = 7/.test(sonicText) || !/function deriveTerrainGridSettings/.test(sonicText) || !/TERRAIN_BASE_SIZE = 168/.test(sonicText) || !/TERRAIN_MAX_GRID_SIZE = 224/.test(sonicText)) {
    fail('Sonic Topography preset must load as a bounded Mineradio-native port of the latest GitHub visual layer');
  }
  if (/gl_FragCoord\.y\s*>\s*uScreenClipPx/.test(sonicText) || /uScreenClipPx/.test(sonicText) || /screenHeight[\s\S]{0,120}\*\s*0\.50/.test(sonicText)) {
    fail('Sonic Topography terrain must not use a hard half-screen fragment clip');
  }
  if (!/function updateSonicRotation/.test(sonicText) || !/function bindVisualRotation/.test(sonicText) || !/state\.boundRotX/.test(sonicText) || !/state\.boundRotY/.test(sonicText) || !/state\.autoYaw/.test(sonicText) || !/sonicGroundAutoRotate/.test(sonicText) || !/state\.root\.rotation\.x\s*=\s*state\.boundRotX/.test(sonicText) || !/state\.root\.rotation\.y\s*=\s*state\.boundRotY\s*\+\s*state\.autoYaw/.test(sonicText) || !/visualRotationActive/.test(sonicText)) {
    fail('Sonic Topography must bind both X/Y axes to the shared starfield particle rotation');
  }
  if (!/SONIC_ORBIT_BASELINE\s*=\s*\{\s*theta:\s*0\.00,\s*phi:\s*0\.18,\s*radius:\s*8\.4\s*\}/.test(orbitText) || !/function readSonicLyricLookAtTarget/.test(orbitText) || !/SONIC_CAMERA_LYRIC_LOOK_AT/.test(orbitText + focusCameraText) || !/readSonicLyricLookAtTarget\(SONIC_CAMERA_LYRIC_LOOK_AT\)/.test(focusCameraText) || /function applyOrbitPointerDrag/.test(pointerText + orbitText) || /applyOrbitPointerDrag\(dx,\s*dy\)/.test(pointerText) || !/applyParticleSpinDrag\(dx,\s*dy,\s*spinDt\)/.test(pointerText) || !/gestureRotation\.x\s*\+=\s*rx/.test(gestureText) || !/gestureRotation\.y\s*\+=\s*ry/.test(gestureText) || /13\.2;\s*orbit\.userPhi\s*=\s*0\.62/.test(presetGridText)) {
    fail('Sonic Topography drag must rotate the terrain while the camera stays lyric-centered, not high-overhead orbiting the camera');
  }
  if (!/var sonicLyricPreset/.test(stageLyricsText) || !/sonicLyricPreset && !fx\.lyricCameraLock && !wallpaperLyricLock/.test(stageLyricsText) || /sonicLyricCameraBasis/.test(stageLyricsText) || !/setStageLyricViewBasisFromCameraOrQuaternion\(lyricCoverWorldQuat\)/.test(stageLyricsText) || !/stageLyricTargetQuaternion\(lyricCoverWorldQuat,\s*layoutTiltX,\s*layoutTiltY\)/.test(stageLyricsText)) {
    fail('Sonic Topography lyrics must stay bound to the rotatable star-river visual basis instead of the camera');
  }
  if (!/backgroundStarRiver/.test(combinedFxState) || !/id="t-backgroundStarRiver"/.test(indexText) || !/backgroundStarRiverParticles/.test(pointerText) || !/function updateBackgroundStarRiverState/.test(pointerText) || !/fx\.backgroundStarRiver === false/.test(pointerText + fxBindText) || !/presetUsesStarRiverParticles[\s\S]{0,120}SONIC_PRESET_INDEX/.test(mainLoopText) || !/presetStarRiverMuted/.test(mainLoopText) || !/SONIC_PRESET_INDEX[\s\S]{0,100}return 0/.test(pointerText) || /lyricStarRiver/.test(combinedFxState + indexText + fxBindText + pointerText + starRiverText) || !/backgroundGlassOpacity'[\s\S]{0,100}'backgroundStarRiver'/.test(archiveText)) {
    fail('background star river must be a persisted global preset-background switch instead of a lyric effect');
  }
  if (!/visualRotation:\s*particles && particles\.rotation/.test(mainLoopText) || !/visualRotationActive:\s*!!\(orbit && orbit\.rotating\)/.test(mainLoopText)) {
    fail('Sonic Topography must receive the live starfield rotation from the main loop');
  }
  if (!/uSubBass/.test(sonicText) || !/uLowMid/.test(sonicText) || !/uHighMid/.test(sonicText) || !/uGlowIntensity/.test(sonicText) || !/uFogColor/.test(sonicText) || !/1\.0-smoothstep\(55\.0,78\.0,vDistance\)/.test(sonicText) || !/DEFAULT_FLOATING_BLOCK_COUNT = 80/.test(sonicText)) {
    fail('Sonic Topography terrain must use the latest GitHub eight-band terrain shader and floating block layer');
  }
  if (!/RIPPLE_LIFETIME = 4\.8/.test(sonicText) || !/RIPPLE_SOFT_FADE_START = 2\.1/.test(sonicText) || !/lifeFade=1\.0-smoothstep\(2\.10,4\.80,timeSince\)/.test(sonicText) || /\(time - r\.start\) < 2\.4/.test(sonicText)) {
    fail('Sonic Topography ripples must fade out softly instead of hard-clearing mid-decay');
  }
  if (!/new THREE\.BoxGeometry\(settings\.boxWidth,\s*1,\s*settings\.boxWidth\)/.test(sonicText) || !/new THREE\.BoxGeometry\(1,\s*1,\s*1\)/.test(sonicText)) {
    fail('Sonic Topography cells and floating blocks must use the latest density-derived GitHub geometry');
  }
  if (!/function deriveGroundLayoutSettings/.test(sonicText) || !/sonicGroundRange/.test(sonicText) || !/state\.root\.rotation\.x\s*=\s*state\.boundRotX/.test(sonicText) || !/state\.root\.position\.set\(0,\s*layout\.y,\s*layout\.z\)/.test(sonicText) || !/state\.root\.scale\.setScalar\(layout\.scale\)/.test(sonicText)) {
    fail('Sonic Topography must expose a wide, lyric-safe horizontal platter layout inside Mineradio camera space');
  }
  if (!/MAX_VISUAL_PRESET_INDEX = 13/.test(coreText) || !/SONIC_PRESET_INDEX = 7/.test(coreText) || !/SONIC_WORKSHOP_PRESET_INDEX = 8/.test(coreText) || !/HIGHWAY_PRESET_INDEX = 13/.test(coreText) || !/MAX_VISUAL_PRESET_INDEX/.test(runtimeText + persistenceText)) {
    fail('Sonic presets 7/8 and Highway Drive preset 13 must survive autosave and startup restore clamps');
  }
  if (!/音域回响/.test(archiveText) || !/presetDisplayOrder = \[0, 9, 10, 11, 12, 6, 7, 8, 13, 5/.test(archiveText) || /音域回响[\s\S]{0,120}disabled:\s*true/.test(archiveText)) {
    fail('Sonic Topography must be exposed as the selectable 音域回响 preset');
  }
  if (!archiveText.includes('音域回响 <span class="pc-name-en">Sonic-Topography</span>')
    || !archiveText.includes('作者 <span class="pc-author-ajin">Ajin</span>')
    || !archiveText.includes('音域回响 <span class="pc-name-en">Sonic Workshop</span>')
    || !archiveText.includes("desc: '作者 CmzYa'")
    || !/var name = p\.nameHtml \|\| p\.name/.test(presetGridText)
    || !/\.preset-card \.pc-name-en[\s\S]{0,260}font-size:\s*[\d.]+px/.test(presetCssText)
    || !/\.preset-card \.pc-author-ajin[\s\S]{0,100}color:\s*#f59e0b/.test(presetCssText)) {
    fail('Sonic preset cards must preserve their English subtitles and Ajin/CmzYa author credits');
  }
  [
    path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'assets', 'index-Z-j1MQ-r.js'),
    path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'assets', 'index-Bhwp8mwk.css'),
    path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'project.json'),
    path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'preview.gif')
  ].forEach((vendorFile) => {
    if (!fs.existsSync(vendorFile)) fail('Sonic Workshop derivative preset is missing packaged Wallpaper Engine asset: ' + path.relative(appRoot, vendorFile));
  });
  if (!/sonic-workshop-preset\.js/.test(loaderText) || !/BRIDGE_SRC = 'vendor\/sonic-workshop\/mineradio-bridge\.html'/.test(sonicWorkshopText) || !/MineradioSonicWorkshop\.update/.test(mainLoopText) || !/visual\.sonic-workshop/.test(mainLoopText) || !/MineradioSonicWorkshop\.onPresetChange/.test(presetGridText) || !/workshopPresetActive/.test(mainLoopText)) {
    fail('Sonic Workshop derivative preset must load, fade as preset 8, hide base particles, and update from the main loop');
  }
  if (!/canvasAnchor\.parentNode\.insertBefore\(layer,\s*canvasAnchor\)/.test(sonicWorkshopText) || !/layer\.setAttribute\('inert'/.test(sonicWorkshopText) || !/iframe\.setAttribute\('inert'/.test(sonicWorkshopText) || !/iframe\.style\.pointerEvents\s*=\s*'none'/.test(sonicWorkshopText) || !/#sonic-workshop-layer,\s*#sonic-workshop-layer \*[\s\S]{0,120}pointer-events:\s*none !important/.test(readAllCssFiles())) {
    fail('Sonic Workshop iframe layer must remain fully pointer-transparent so player buttons and window controls stay clickable');
  }
  // 13/14 是自绘场景预设：模块自带 INDEX，核心状态里另存一份常量用于夹取。
  // 两边编号必须一致，写偏一位老存档的 preset 就会落到别的画面上，而 UI 看起来完全正常。
  if (!/var INDEX = 13;/.test(highwayText)) {
    fail('Highway Drive preset must keep INDEX 13 in sync with HIGHWAY_PRESET_INDEX');
  }
  if (!/highway-drive-preset\.js/.test(loaderText)) {
    fail('Highway Drive preset must be registered in index-loader');
  }
  if (!/MineradioHighwayDrive\.update/.test(mainLoopText) || !/visual\.highway-drive/.test(mainLoopText) || !/highwayPresetActiveEarly/.test(mainLoopText) || !/MineradioHighwayDrive\.onPresetChange/.test(presetGridText)) {
    fail('Highway Drive preset must load, hide base particles, and update from the main loop');
  }
  if (!/setVisualSuppressed: function/.test(shelfCoreText) || !/!visualSuppressed/.test(shelfCoreText) || !/setVisualSuppressed\(highwayPresetActiveEarly\)/.test(mainLoopText)) {
    fail('Highway Drive must suppress the 3D shelf, otherwise the shelf body floats over the road');
  }
  if (!/createCelestialCloudTexture/.test(highwayText) || !/buildCelestialRingGeometry/.test(highwayText)) {
    fail('Highway Drive celestial bodies must stay as one shared procedural glow set');
  }
  if (/CELESTIAL_TEXTURE_PATH|assets\/highway-planets|new THREE\.SphereGeometry/.test(highwayText)) {
    fail('Highway Drive celestial textures are gone; do not bring the textured sphere back');
  }
  if (!/wallpaperRegisterAudioListener/.test(sonicWorkshopBridgeText) || !/__mineradioApplyAudio/.test(sonicWorkshopBridgeText) || !/__mineradioApplyMedia/.test(sonicWorkshopBridgeText) || !/theme:\s*'coral-mirage'/.test(sonicWorkshopBridgeText) || !/themeCycleInterval:\s*50/.test(sonicWorkshopBridgeText) || !/gridSize:\s*320/.test(sonicWorkshopBridgeText) || !/audioIntensity:\s*1\.15/.test(sonicWorkshopBridgeText) || !/responseRange:\s*1\.3/.test(sonicWorkshopBridgeText) || !/peakColorIntensity:\s*0\.62/.test(sonicWorkshopBridgeText) || !/pulseSensitivity:\s*0\.05/.test(sonicWorkshopBridgeText) || !/pulseCooldown:\s*0/.test(sonicWorkshopBridgeText) || !/meteorSensitivity:\s*0\.3/.test(sonicWorkshopBridgeText) || !/cameraDistance:\s*80/.test(sonicWorkshopBridgeText) || !/autoRotateEnabled:\s*true/.test(sonicWorkshopBridgeText) || !/autoRotateSpeed:\s*7/.test(sonicWorkshopBridgeText) || !/cameraAngleX:\s*150/.test(sonicWorkshopBridgeText) || !/cameraAngleY:\s*30/.test(sonicWorkshopBridgeText) || !/showPlayerController:\s*false/.test(sonicWorkshopBridgeText)) {
    fail('Sonic Workshop bridge must preserve the requested Wallpaper Engine default parameters and receive Mineradio audio/media');
  }
  const sonicWorkshopVendorText = fs.readFileSync(path.join(appRoot, 'public', 'vendor', 'sonic-workshop', 'assets', 'index-Z-j1MQ-r.js'), 'utf8');
  if (!/mineradioCustomTheme/.test(sonicWorkshopBridgeText) || !/mineradioCustomTheme/.test(sonicWorkshopText) || !/function workshopCustomThemeForColor/.test(sonicWorkshopText) || !/function workshopPaletteHexesFromCover/.test(sonicWorkshopText) || !/function workshopCustomThemeForPalette/.test(sonicWorkshopText) || !/function workshopCustomThemeForRegions/.test(sonicWorkshopText) || !/function workshopRegionsFromFx/.test(sonicWorkshopText) || !/function applyWorkshopThemeTransition/.test(sonicWorkshopText) || !/WORKSHOP_THEME_TRANSITION_MS\s*=\s*1280/.test(sonicWorkshopText) || !/function applyThemeTransition/.test(sonicWorkshopBridgeText) || !/THEME_TRANSITION_STEP_MS\s*=\s*33/.test(sonicWorkshopBridgeText) || /scheduleWorkshopThemeTransition\(\);/.test(sonicWorkshopText) || !/__mineradioPaletteHexes/.test(sonicWorkshopText) || !/rawWarm/.test(paletteText + sonicWorkshopText) || !/rawCool/.test(paletteText + sonicWorkshopText) || !/rawAreaPrimary/.test(paletteText + sonicWorkshopText + accentControlText) || !/sonicWorkshopColors/.test(paletteText + sonicWorkshopText) || !/coverSourceKey/.test(paletteText + accentControlText) || !/function ensureSonicWorkshopCoverPaletteForUi/.test(accentControlText) || !/function sonicWorkshopCurrentCoverDomSource/.test(accentControlText) || !/function buildSonicWorkshopUiPaletteFromCanvas/.test(accentControlText) || !/function sonicWorkshopUiPaletteForKey/.test(accentControlText) || !/sonicWorkshopCoverUiSample\.palette/.test(accentControlText) || !/coverPickerCanvas/.test(accentControlText) || !/coverProxySrc/.test(accentControlText) || !/coverColors/.test(paletteText + sonicWorkshopText) || !/sonic-workshop-cool-picker/.test(indexText + fxBindText) || !/sonic-workshop-peak-picker/.test(indexText + fxBindText) || !/setSonicWorkshopRegionColorFromPicker/.test(fxBindText + sonicWorkshopText + accentControlText) || !/function sonicRawPaletteHex/.test(accentControlText) || /function sonicWorkshopCoverHex[\s\S]{0,700}sonicPaletteHex/.test(accentControlText) || !/uCoolCore:\s*cool/.test(sonicWorkshopText) || !/uRippleColor:\s*ripple/.test(sonicWorkshopText) || !/MRt\(We\.mineradioCustomTheme\.value\)/.test(sonicWorkshopVendorText) || !/Be\(function\(Mr\)\{return Mr===0\?1e-6:0\}\)/.test(sonicWorkshopVendorText)) {
    fail('Sonic Workshop cover/custom colors must feed the real vendor terrain theme instead of only recoloring the UI controls');
  }
  if (!/colorLabState\.picker\)\s*colorLabState\.picker\.value\s*=\s*hex/.test(colorLabText) || !/id === 'sonic-workshop-cover-picker'[\s\S]{0,180}\^sonic-workshop-/.test(colorLabText) || !/pointerdown[\s\S]{0,180}updateColorLabFromSv\(e\)/.test(fxBindText) || !/function sonicWorkshopRegionControl\(id\)\s*\{[\s\S]{0,120}typeof id === 'object' && id\.id/.test(accentControlText) || !/function pushSonicWorkshopColorChange/.test(accentControlText) || !/function setSonicWorkshopThemeFromPicker[\s\S]{0,520}sonicWorkshopColorControls\(\)\.forEach/.test(accentControlText) || !/pushSonicWorkshopColorChange\(item\.colorKey\)/.test(accentControlText)) {
    fail('Sonic Workshop color lab changes must commit into fx state, UI swatches, saved settings, and the live iframe theme');
  }
  if (!/function isPlaybackSpaceKey/.test(keyboardCameraText) || !/if \(isPlaybackSpaceKey\(e\)\) return;/.test(keyboardCameraText)) {
    fail('Space playback hotkey must not mark render interaction before resume playback');
  }
  if (!/global\.frequencyData/.test(sonicWorkshopText) || /sonicAudioMonitorState/.test(sonicWorkshopText) || /MineradioSonicWorkshop\.update\([\s\S]{0,260}audio:\s*sonicAudioFrame/.test(mainLoopText)) {
    fail('Sonic Workshop derivative must use the local player analyser bridge instead of the original Sonic realtime spectrum frame');
  }
  if (!/WORKSHOP_AUDIO_TARGET_MAX_SAMPLE\s*=\s*0\.52/.test(sonicWorkshopText) || !/WORKSHOP_AUDIO_GAMMA\s*=\s*1\.55/.test(sonicWorkshopText) || !/WORKSHOP_AUDIO_MIN_FLOOR\s*=\s*0\.035/.test(sonicWorkshopText) || !/function workshopAudioFrameStats/.test(sonicWorkshopText) || !/function shapeWorkshopAudioValue/.test(sonicWorkshopText) || !/sonicWorkshopInputGain/.test(sonicWorkshopText) || /Math\.pow\(clamp01\(value\),\s*0\.68\)/.test(sonicWorkshopText) || /1\.05\s*\+\s*energy\s*\*\s*0\.34/.test(sonicWorkshopText)) {
    fail('Sonic Workshop bridge must keep Wallpaper-like dark-field audio shaping instead of overdriving the terrain');
  }
  if (/getUserMedia|getDisplayMedia|desktopCapturer|MediaStream|D:\\\\Steam|workshop\\content/.test(sonicWorkshopText + sonicWorkshopBridgeText)) {
    fail('Sonic Workshop derivative must use packaged assets and Mineradio analyser data instead of runtime capture or the Steam workshop path');
  }
  if (!/fx-sonicamp/.test(indexText) || !/fx-sonicrange/.test(indexText) || !/fx-sonicair/.test(indexText) || !/sonic-ground-base-picker/.test(indexText) || !/fx-sonicfloatcount/.test(indexText) || !/t-sonicGroundFloatingEnabled/.test(indexText) || !/音域地形/.test(indexText) || !/\^fx-sonic/.test(fxPanelText)) {
    fail('visual console must expose layout, color, ground EQ, and floating block controls for 音域回响');
  }
  if (!/fx-sonicaudiobandstart/.test(indexText) || !/sonic-audio-monitor-canvas/.test(indexText) || !/t-sonicAudioAutoTrack/.test(indexText) || !/06-sonic-audio-monitor\.js/.test(loaderText)) {
    fail('visual console must expose the Sonic realtime spectrum range monitor and auto-track controls');
  }
  if (!/function stepSonicAudioMonitor/.test(sonicAudioText) || !/SONIC_AUDIO_BEAT_WINDOWS/.test(sonicAudioText) || !/sonicAudioTrackAutoPulse/.test(sonicAudioText) || !/sonicAudioStepKickEnvelope/.test(sonicAudioText) || !/drawSonicAudioMonitorPanel/.test(sonicAudioText)) {
    fail('Sonic Topography must include the GitHub-derived realtime spectrum, kick envelope, auto-track, and monitor panel module');
  }
  if (!/function sonicAudioHzRangeAverage/.test(sonicAudioText) || !/sonicHzDetailed/.test(sonicAudioText) || !/startHz:\s*46[\s\S]{0,80}endHz:\s*118/.test(sonicAudioText) || !/widthPenalty/.test(sonicAudioText) || !/sampleRate:\s*analysisSampleRate/.test(mainLoopText) || !/fftSize:\s*analysisFftSize/.test(mainLoopText)) {
    fail('Sonic realtime spectrum must use live Hz band analysis for kick windows instead of auto-tracking arbitrary treble bins');
  }
  if (!/SONIC_AUDIO_BASE_BINS\s*=\s*512/.test(sonicAudioText) || !/SONIC_AUDIO_AUTO_TRACK_SCAN_BINS\s*=\s*192/.test(sonicAudioText) || /sonicAudioBandStart[\s\S]{0,90}0,\s*250/.test(combinedFxState) || /sonicAudioBandEnd[\s\S]{0,90}2,\s*256/.test(combinedFxState) || /fx-sonicaudiobandstart[\s\S]{0,90}max="250"/.test(indexText) || /fx-sonicaudiobandend[\s\S]{0,90}max="256"/.test(indexText)) {
    fail('Sonic realtime spectrum must expose the full 512-bin control window across runtime, UI, save, and archive paths');
  }
  if (/getUserMedia|getDisplayMedia|desktopCapturer|MediaStream/.test(sonicAudioText + mainLoopText)) {
    fail('Sonic realtime audio must reuse Mineradio analyser data instead of requesting system or microphone capture');
  }
  if (!/stepSonicAudioMonitor\(frequencyData,\s*audioStepDt/.test(mainLoopText) || !/audio:\s*sonicAudioFrame\s*\|\|/.test(mainLoopText) || !/raw\.sonicDetailed/.test(sonicText)) {
    fail('Sonic Topography must receive detailed realtime audio frames while keeping the legacy bass/mid/treble fallback');
  }
  if (!/function readSonicRealtimeCameraSample/.test(beatCameraText) || !/sonicAudioMonitorState\.frame/.test(beatCameraText) || !/cinemaProfileSample/.test(mainLoopText) || !/sonicAudioFrame && sonicAudioFrame\.sonicDetailed/.test(mainLoopText)) {
    fail('cinematic camera sampling must fuse the Sonic realtime spectrum frame without replacing the original analyser path');
  }
  if (!/function sonicCoverGroundTheme/.test(sonicText) || !/stage\.coverPalette/.test(sonicText) || !/sonicGroundColorMode/.test(sonicText) || !/sonicGroundColorAuto/.test(persistenceText) || !/封面取色/.test(fxBindText + fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '02-accent-background-controls.js'), 'utf8'))) {
    fail('Sonic Topography colors must default to cover-palette sampling and switch to persistent custom colors only after user color selection');
  }
  requiredSonicFields.forEach((field) => {
    if (!combinedFxState.includes(field)) {
      fail(`missing Sonic ground preset field in save/archive/UI path: ${field}`);
    }
  });
  if (!/captureCameraArchiveState/.test(archiveText) || !/applyCameraArchiveState\(data\)/.test(archiveText) || !/applyVisualRotationArchiveState\(data\)/.test(archiveText) || !/isCameraArchiveKey\(key\)/.test(archiveText) || !/cameraViewSaved/.test(archiveText) || !/visualRotationSaved/.test(archiveText) || !/USER_FX_SHARE_KEYS[\s\S]*cameraFreeFov[\s\S]*visualRotationY/.test(archiveText)) {
    fail('user visual archives must save and restore camera plus shared visual rotation state without breaking old MR2 payloads');
  }
  if (!/MineradioSonicTopography\.update/.test(mainLoopText) || !/visual\.sonic-topography/.test(mainLoopText) || !/MineradioSonicTopography\.onPresetChange/.test(presetGridText) || !/MineradioSonicTopography\.pointerRipple/.test(pointerText)) {
    fail('Sonic Topography must update from the main loop, release meshes on preset changes, and support pointer ripples');
  }
  console.log('[OK] 音域回响 preset is selectable, bounded, saved, and driven by existing rhythm envelopes.');
}

// 自动节奏分析开关（默认关闭）的守卫。
// 为什么值得写：这个开关唯一的硬要求就是「默认关闭」，而它由**四处彼此独立**的归一化代码共同决定
// —— fxDefaults、两个持久化归一化（raw / fx 两条路径）、以及存档与分享码归一化。任何一处写成
// `!== false`，缺键就会变成开启，而界面上完全看不出异常：开关只是"自己打开了"，用户不会知道为什么。
// 分享码那边还更隐蔽 —— 码是按下标编码的，别人用旧版本生成的码里根本没有这个键。
// 另外它必须真的拦在分析入口上，否则开关只是装饰。
// Guard for the automatic-beat-analysis switch, which must default to off. That single requirement is
// decided by four independent normalisers (fxDefaults, both persistence paths, the archive/share
// normaliser), and one `!== false` among them turns a missing key into "on" with no visible symptom.
// The share-code path hides it best: codes are index-encoded, so an older build's code has no such key.
// The switch must also actually gate the analysis entry points, or it is decoration.
function checkBeatAnalysisToggleGuard() {
  logStep('Beat analysis toggle guard');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const layoutText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '06-fx-runtime-layout.js'), 'utf8');
  const persistenceText = readVisualArchiveText();
  const archiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const beatText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  const panelText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js'), 'utf8');
  const bindingsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  // 判据读源码文本，而上面的注释里正写着同样的键名与 `!== false`，所以先剥注释。
  // The checks read source text and the comments above spell out the same names, so strip comments first.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const defaultsCode = stripComments(defaultsText);
  const layoutCode = stripComments(layoutText);
  const persistenceCode = stripComments(persistenceText);
  const archiveCode = stripComments(archiveText);
  const beatCode = stripComments(beatText);
  const panelCode = stripComments(panelText);
  const bindingsCode = stripComments(bindingsText);
  const indexCode = stripComments(indexText);

  // 1) 默认值必须是显式 false。
  if (!/beatAnalysis:\s*false\s*,/.test(defaultsCode)) {
    fail('fxDefaults must declare beatAnalysis: false — the feature is meant to ship off');
  }

  // 2) 三处归一化只能认显式 true。逐条点名 raw/fx 两条持久化路径，因为它们是分别写的、可以只改一条。
  if (!/beatAnalysis:\s*raw\.beatAnalysis === true/.test(persistenceCode)) {
    fail('the persistence normaliser (raw path) must read beatAnalysis === true, or a missing key becomes on');
  }
  if (!/beatAnalysis:\s*fx\.beatAnalysis === true/.test(persistenceCode)) {
    fail('the persistence normaliser (fx path) must read beatAnalysis === true, or a missing key becomes on');
  }
  if (!/beatAnalysis:\s*raw\.beatAnalysis === true/.test(archiveCode)) {
    fail('the archive/share normaliser must read beatAnalysis === true, or importing an older code turns it on');
  }
  // 反向：这几处一律不许出现 `!== false` 形态（那正是"缺键即开启"的写法）。
  if (/beatAnalysis[^\n]*!==\s*false/.test(persistenceCode) || /beatAnalysis[^\n]*!==\s*false/.test(archiveCode)) {
    fail('beatAnalysis must never be normalised with `!== false`: a missing key would silently turn the default-off switch on');
  }

  // 3) 行为验证而不是文本验证：把 beatAnalysisEnabled() 抽进沙箱真跑。文本只能说明"写了 === true"，
  //    跑一遍才能证明「缺键 / undefined / 字符串 / 数字 一律是关，只有字面量 true 是开」。
  // Behavioural rather than textual: extract the predicate and actually run it. Text only proves the
  // characters are there; running proves a missing key, undefined, a string and a number all read as off.
  const predicateStart = layoutCode.indexOf('function beatAnalysisEnabled()');
  if (predicateStart < 0) fail('beatAnalysisEnabled() is missing from the fx runtime state module');
  const predicateRest = layoutCode.slice(predicateStart);
  const predicateNext = predicateRest.search(/\n(?:async\s+)?function\s/);
  const predicateBody = predicateNext < 0 ? predicateRest : predicateRest.slice(0, predicateNext);
  const probe = fxLiteral => vm.runInNewContext(
    '(function () { var fx = ' + fxLiteral + ';\n' + predicateBody + '\nreturn beatAnalysisEnabled(); })()',
    {}
  );
  const probeCases = [
    ['undefined fx', 'undefined', false],
    ['missing key', '{}', false],
    ['explicit false', '{ beatAnalysis: false }', false],
    ['string "true"', '{ beatAnalysis: "true" }', false],
    ['number 1', '{ beatAnalysis: 1 }', false],
    ['explicit true', '{ beatAnalysis: true }', true]
  ];
  probeCases.forEach(function (entry) {
    const got = probe(entry[1]);
    if (got !== entry[2]) {
      fail('beatAnalysisEnabled() must return ' + entry[2] + ' for ' + entry[0] + ', got ' + got);
    }
  });

  // 4) 门控必须真的拦在分析入口上。逐函数切开比对，不能只在整文件里找一次：那样把门控只留在
  //    其中一个入口、删掉另一个，判据照样绿。
  // Each analysis entry point is sliced out and checked on its own: searching the whole file would
  // stay green if the gate survived on one entry point and was deleted from another.
  const inBody = (source, signature) => {
    const at = source.indexOf(signature);
    if (at < 0) return '';
    const rest = source.slice(at + signature.length);
    const next = rest.search(/\n(?:async\s+)?function\s/);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const gatedEntries = [
    ['function scheduleBeatAnalysis(', 'the on-demand analysis scheduler'],
    ['function scheduleQueueBeatPrefetch(', 'the queue prefetch scheduler'],
    ['function runQueueBeatPrefetch(', 'the prefetch worker (the switch can flip while it awaits)']
  ];
  gatedEntries.forEach(function (entry) {
    const body = inBody(beatCode, entry[0]);
    if (!body) fail(entry[0] + ' not found — it is a gated analysis entry point');
    else if (!/beatAnalysisEnabled\(\)/.test(body)) {
      fail(entry[1] + ' must bail out when automatic beat analysis is off');
    }
  });

  // 5) 面板接线。开关必须存在、能反映状态、且改动会被持久化 —— 少了持久化，重启就自己弹回默认值。
  if (!/id="t-beatAnalysis"/.test(indexCode) || !/onclick="toggleFx\('beatAnalysis'\)"/.test(indexCode)) {
    fail('the panel must expose #t-beatAnalysis wired to toggleFx(\'beatAnalysis\')');
  }
  if (!/data-i18n="toggle_beat_analysis"/.test(indexCode)) {
    fail('the new switch label must go through the dictionary, or it renders as a bare key');
  }
  if (!/getElementById\('t-beatAnalysis'\)/.test(panelCode) || !/fx\.beatAnalysis === true/.test(panelCode)) {
    fail('updateFxInputs/updatePerformanceControls must reflect fx.beatAnalysis onto #t-beatAnalysis');
  }
  if (!/key === 'beatAnalysis'\)\s*saveLyricLayout/.test(bindingsCode)) {
    fail('toggleFx must persist beatAnalysis, or the switch reverts to its default after a restart');
  }
  if (!/cancelBeatAnalysisTimer\(\)/.test(bindingsCode) || !/cancelBeatPrefetchTimer\(\)/.test(bindingsCode)) {
    fail('turning the switch off must cancel the queued analysis and prefetch, not just flip a flag');
  }

  // 6) 存档与分享码是按下标编码的（见 USER_FX_SHARE_KEYS 里的 Append-only 标记），所以新键只能
  //    追加在末尾。这里把「最后一个追加前的老键」的下标钉死：往后追加不影响它，而只要有人把新键
  //    插在中间，下标立刻变化 —— 那种改动会静默解错所有已发出的分享码。
  // The archive key list is index-encoded, so a new key may only be appended. Pinning the index of the
  // last pre-append key catches a middle insertion, which would silently mis-decode every issued code.
  const shareKeysStart = archiveCode.indexOf('var USER_FX_SHARE_KEYS = [');
  const shareKeysEnd = archiveCode.indexOf('];', shareKeysStart);
  const shareKeys = shareKeysStart < 0 || shareKeysEnd < 0
    ? []
    : Array.from(archiveCode.slice(shareKeysStart, shareKeysEnd).matchAll(/'([A-Za-z0-9_]+)'/g)).map(m => m[1]);
  if (shareKeys.indexOf('lyricTextureClarity') !== 205) {
    fail('USER_FX_SHARE_KEYS must stay append-only: lyricTextureClarity moved from index 205 to ' + shareKeys.indexOf('lyricTextureClarity'));
  }
  // 哨兵会随每次追加前移：新键追加到末尾后，把这里的名字改成最新的那一个。
  // The sentinel moves forward with each append; rename it to the newest key.
  if (shareKeys[shareKeys.length - 1] !== 'wallpaperEngineCaptureRender') {
    fail('wallpaperEngineCaptureRender must be the last USER_FX_SHARE_KEYS entry so the next append goes after it');
  }

  // 7) 四语都要有文案：缺一份，那个语言的开关就显示裸键。
  ['toggle_beat_analysis', 'fx_beat_analysis_title', 'bind_beat_analysis_on', 'bind_beat_analysis_off'].forEach(function (key) {
    supportedLangs().forEach(function (lang) {
      const dict = fs.readFileSync(path.join(appRoot, 'public', 'locales', lang + '.json'), 'utf8');
      if (!dict.includes('"' + key + '"')) fail('locale ' + lang + ' is missing the key ' + key);
    });
  });

  // 8) 面板在运行时会把这排开关整体搬进「系统 → 性能与后台」分组（fxConsoleAppendItem 里是
  //    appendChild，会改父节点），没登记的会被残留扫描收进「其他设置」—— 它仍然在面板里，只是
  //    位置不对，所以没有任何报错、截图也看不出异常。判据落在"同格兄弟全都要登记"而不是只钉这
  //    一个键：只钉一个的话，下次往这排里加开关会以完全相同的方式漏掉。
  // The panel re-parents this grid into System → performance at runtime (fxConsoleAppendItem calls
  // appendChild), and anything unregistered is swept into "other settings" — still in the panel, just
  // in the wrong place, so nothing errors and a screenshot looks fine. Judge the whole sibling grid,
  // not this one key: a per-key check would let the next switch in this row slip through identically.
  const consoleText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  const consoleCode = stripComments(consoleText);
  const gridAt = indexCode.indexOf('id="visual-performance-toggle-grid"');
  if (gridAt < 0) fail('the panel must keep #visual-performance-toggle-grid, the row this switch lives in');
  const nextGridAt = indexCode.indexOf('fx-toggle-grid', gridAt + 1);
  const gridHtml = nextGridAt < 0 ? indexCode.slice(gridAt) : indexCode.slice(gridAt, nextGridAt);
  const gridIds = Array.from(gridHtml.matchAll(/id="(t-[A-Za-z0-9_]+)"/g)).map(m => m[1]);
  if (gridIds.indexOf('t-beatAnalysis') < 0) {
    fail('t-beatAnalysis must sit in the realtime-visual-performance grid with its siblings');
  }
  const unregistered = gridIds.filter(id => !consoleCode.includes("fxConsoleItem('" + id + "'"));
  if (unregistered.length) {
    fail('every switch in the realtime-visual-performance grid must be registered in the console layout, '
      + 'or the residual sweep files it under "other settings": ' + unregistered.join(', '));
  }

  console.log('[OK] Automatic beat analysis defaults to off, is gated on every analysis entry point, and is wired to the panel.');
}

function checkFxConsoleWorkspaceGuard() {
  logStep('Visual console workspace guard');
  const workspacePath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js');
  const panelPath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '05-fx-panel-performance.js');
  const loaderPath = path.join(appRoot, 'public', 'js', 'index-loader.js');
  const htmlPath = path.join(appRoot, 'public', 'index.html');
  const defaultsPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js');
  const packagedDefaultsPath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '05-packaged-fx-archive.js');
  const archivePath = path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js');
  const defaultArchivePath = path.join(appRoot, 'public', 'default-user-fx-archive.json');
  const rowLayersPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '12-lyrics-row-layers.js');
  const stageLyricsPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js');
  const starRiverPath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '03-lyrics-star-river.js');
  const maskTexturePath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '10-lyrics-mask-textures.js');
  const workspace = fs.readFileSync(workspacePath, 'utf8');
  const panel = fs.readFileSync(panelPath, 'utf8');
  const loader = fs.readFileSync(loaderPath, 'utf8');
  const css = readAllCssFiles();
  const html = fs.readFileSync(htmlPath, 'utf8');
  const defaults = fs.readFileSync(defaultsPath, 'utf8');
  const packagedDefaults = fs.readFileSync(packagedDefaultsPath, 'utf8');
  const persistence = readVisualArchiveText();
  const archive = fs.readFileSync(archivePath, 'utf8');
  const defaultArchive = JSON.parse(fs.readFileSync(defaultArchivePath, 'utf8'));
  const rowLayers = fs.readFileSync(rowLayersPath, 'utf8');
  const stageLyrics = fs.readFileSync(stageLyricsPath, 'utf8');
  const starRiver = fs.readFileSync(starRiverPath, 'utf8');
  const maskTexture = fs.readFileSync(maskTexturePath, 'utf8');
  // 六个任务型分组标签已 i18n 化：JS 里用 consoleWorkspaceText(key) 取词，
  // 因此守卫校验「六个 key 都被登记」且「每个 key 在各语言词典里存在」，
  // 而不是在 JS 里搜硬编码中文分组名。
  // The six task-first tab labels moved into the dictionaries, so the guard checks
  // that every category key is registered and translated instead of grepping the
  // old hardcoded Chinese group names.
  const categoryKeys = ['fx_cat_common', 'fx_cat_ui', 'hotkey_cat_lyrics', 'fx_cat_motion', 'fx_cat_shelf', 'fx_cat_system'];
  if (!categoryKeys.every(key => new RegExp(`label: consoleWorkspaceText\\('${key}'\\)`).test(workspace))) {
    fail('task-first visual console tabs are incomplete');
  }
  requireLocaleKeys(...categoryKeys);
  if (!loader.includes("js/modules/07-fx/09-console-workspace.js")) fail('visual console workspace module is not loaded');
  // Wallpaper Engine 自成一组，那 4 个构图滑块必须一并登记 —— 它们此前没有登记，会被 fallback
  // 收进「其他设置」。这里钉住分组归属与选择器白名单，防止将来又漂回去。
  // Wallpaper Engine owns its own group, and the four framing sliders must be registered with it —
  // they had no registration and were being swept into "其他设置" by the residual fallback. Pin both
  // the group membership and the selector whitelist so they cannot drift back.
  if (!/key: 'wallpaper-engine', title: 'Wallpaper Engine'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-value'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('t-wallpaperEngineSilentWindows'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('t-wallpaperEngineGlassSampler'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-opacity'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-position-x'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-position-y'/.test(workspace)
    || !/key: 'wallpaper-engine'[^\]]*fxConsoleItem\('wallpaper-engine-scale'/.test(workspace)) {
    fail('Wallpaper Engine must keep its own console group with the status row, both switches, and the four framing sliders');
  }
  // 逐分组切片再判断，否则跨组正则会一路匹配到后面的 Wallpaper Engine 组，把"已移走"误报成"还在"。
  // Slice the background group out first: a cross-group regex runs past the closing bracket and
  // matches the Wallpaper Engine group instead, reporting a moved item as still present.
  const backgroundGroup = (workspace.split("key: 'background'")[1] || '').split('] }')[0] || '';
  if (/wallpaper|wallpaperEngine/i.test(backgroundGroup)) {
    fail('Wallpaper Engine items must not stay in the background-media group once they have their own');
  }
  // 逐个登记后单个 .fx-slider 已命中白名单，容器不该再加进去 —— 加进去反而会让
  // "登记整个容器" 这种写法悄悄可行，把四个滑块当成一个块搬走。
  // With per-slider registration each .fx-slider already matches the whitelist, so the wrapper must
  // stay out of it — otherwise registering the whole container silently becomes viable again and the
  // four sliders travel as one opaque block.
  if (/\.wallpaper-engine-visual-controls/.test(workspace.split('var selector = ')[1] || '')) {
    fail('register the four WE sliders individually; keeping the wrapper in the selector whitelist allows the opaque-block form');
  }
  if (!/\.wallpaper-engine-visual-controls:empty/.test(css)) {
    fail('the emptied WE slider container must collapse, or it leaves an empty bordered box in the panel');
  }
  // 完整桌面模式的两项配套（壁纸透明度 / 壁纸帧数）必须与它们的开关同组。它们的 html 上带着
  // hidden，但作者样式表的 .fx-slider{display:grid} / .fx-seg{display:flex} 优先级高于 UA 的
  // [hidden]{display:none}，所以它们一直是可见的 —— 别被 hidden 属性误导当成死项。
  // Both desktop-wallpaper companions must sit in the same group as their toggle. Their markup
  // carries `hidden`, but the author-level .fx-slider{display:grid} / .fx-seg{display:flex} rules
  // outrank the UA [hidden]{display:none}, so they have always been visible — do not mistake the
  // attribute for a dead control.
  // 这两项是桌面层设置，归属「桌面歌词」组（那里已有同类的透明度/帧率），不是实验功能 ——
  // 实验功能里只留完整桌面模式那个开关本身。
  // These two are desktop-layer settings and belong to the 桌面歌词 group (which already has the same
  // kind of opacity and frame-rate controls), not 实验功能 — that group keeps only the switch itself.
  // 完整桌面模式的两个参数必须作为 child 挂在该开关下面（缩进 + 导线），而不是组里的并列项。
  // 顺序也重要：child 项要跟在 t-wallpaperMode 之后，否则会挂到上一个开关（桌面歌词）下面 ——
  // fxConsoleAppendItem 遇到新的 fx-toggle 会重置从属容器。
  // Both parameters must be registered as children right after the switch (indent + lead-in line),
  // never as peers. Order matters: a child lands under whichever fx-toggle came last, so following
  // t-wallpaperMode is what attaches them to it — fxConsoleAppendItem resets the nest on a new toggle.
  // 判据落在「登记顺序 + child 层级」上，不落在字符距离上。字符距离当「紧随其后」的代理
  // 会被与结构无关的变化带偏：给这两项接上取词函数，光文案变长就足以把 0,900 的窗口顶出去，
  // 而真实结构一根手指都没动。顺序与层级才是这里要守的东西。
  // Judge by registration order and nesting, not by character distance. Distance is a proxy
  // that unrelated copy length shifts — wiring an accessor into the item label is enough to bust
  // a 0,900 window while the structure never moved. Order and nesting are the real contract.
  const fxRegistration = (id) => {
    const at = workspace.indexOf(`fxConsoleItem('${id}'`);
    return at < 0 ? '' : workspace.slice(at, at + 320);
  };
  const desktopChildren = [['t-wallpaperMode', 'fx-wallpaperopacity'], ['fx-wallpaperopacity', 'wallpaper-fps-seg']];
  const desktopChildBroken = desktopChildren.some(([owner, child]) => {
    const ownerAt = workspace.indexOf(`fxConsoleItem('${owner}'`);
    const childAt = workspace.indexOf(`fxConsoleItem('${child}'`);
    if (ownerAt < 0 || childAt < 0 || childAt < ownerAt) return true;
    // 两者之间除 owner 自己以外不能再有登记：多一个就是被排成了同级项，而不是 child。
    // Nothing but the owner itself may be registered in between: another entry means the item was
    // made a peer instead of a child.
    return (workspace.slice(ownerAt, childAt).match(/fxConsoleItem\(/g) || []).length !== 1;
  });
  // child 标记（缩进 + 导线）必须仍在，否则它会掉回同级、脱离那把共享的锁。
  const desktopChildFlagsMissing = ['fx-wallpaperopacity', 'wallpaper-fps-seg']
    .filter((id) => !/, true, true\)/.test(fxRegistration(id)));
  if (desktopChildBroken || desktopChildFlagsMissing.length) {
    fail('full desktop mode opacity and frame rate must be registered as children directly after its switch'
      + (desktopChildFlagsMissing.length ? '：缺少 child 标记 ' + desktopChildFlagsMissing.join(', ') : ''));
  }
  const experimentalConsoleGroup2 = (workspace.split("key: 'experimental'")[1] || '').split('] }')[0] || '';
  // 实验功能组里不该再登记「壁纸透明度」：它归桌面歌词组，且必须以 child 形式挂在
  // t-wallpaperMode 下面（上面两条判据已经按顺序 + 层级钉住）。判据只看「有没有出现」，
  // 不写死实参文案 —— 实参已接 i18n 键，字面量会随文案变，写死就会误报。
  // The experimental group must not register the wallpaper opacity as a peer: it belongs to
  // the desktop-lyrics group as a child of t-wallpaperMode, already pinned above by order
  // and nesting. Judge by presence only — pinning argument text would break on copy edits.
  const experimentalOpacityAt = experimentalConsoleGroup2.indexOf("fxConsoleItem('fx-wallpaperopacity'");
  if (experimentalOpacityAt >= 0 && !/, true, true\)/.test(experimentalConsoleGroup2.slice(experimentalOpacityAt, experimentalOpacityAt + 320))) {
    fail('wallpaper opacity must stay a child of the full desktop mode switch, not a peer in the experimental group');
  }
// 「Windows 游戏模式」是一整条跨进程链路：主进程模块 → preload 桥 → 界面模块 → 开关元素 →
// 分组登记 → 默认值与持久化 → 打包快照。任一环断掉都会让开关点了没反应或状态显示错，而这类
// 失效全部是静默的，所以逐环钉住。**还原是这项功能的核心承诺**（关闭时按备份写回注册表），
// 必须与写入路径同时存在，否则可能出现"关不掉"。
// The Windows game mode switch is a cross-process chain: main module → preload bridge → UI module
// → toggle element → group registration → defaults/persistence → packaged snapshot. A break in any
// link makes the switch silently inert or its state wrong. Pin each link. The restore path is this
// feature's core promise (write the registry back from the backup) and must ship together with the
// write path, or the switch could become impossible to turn off.
const wgmModule = fs.readFileSync(path.join(appRoot, 'desktop', 'windows-game-mode.js'), 'utf8');
const wgmUi = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '10-windows-game-mode-ui.js'), 'utf8');
const wgmPreload = fs.readFileSync(path.join(appRoot, 'desktop', 'preload.js'), 'utf8');
const wgmMain = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
const wgmLoader = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
if (!/HKCU/.test(wgmModule) || !/GameConfigStore/.test(wgmModule)) {
  fail('the Windows game mode module must target HKCU System GameConfigStore');
}
if (!/function readSubtree/.test(wgmModule) || !/BACKUP_FAILED/.test(wgmModule)) {
  fail('enabling the Windows game mode must back up the registry subtree first and refuse to write without a snapshot');
}
if (!/Remove-Item -LiteralPath/.test(wgmModule) || !/parentKeyName/.test(wgmModule)) {
  fail('disabling the Windows game mode must remove the keys it wrote, including the computed parents entry');
}
// 状态判定的两个输出必须互不包含：/REGISTERED/ 会命中 NOT_REGISTERED，把「从未注册」读成「已注册」，
// 那样关闭后就无法确认是否真的还原了。
// The two status tokens must not contain one another: /REGISTERED/ also matches NOT_REGISTERED,
// reading "never registered" as "registered" and hiding a failed restore.
if (!/MR_GAME_REGISTERED/.test(wgmModule) || !/MR_GAME_ABSENT/.test(wgmModule)) {
  fail('the Windows game mode status tokens must be mutually exclusive so a failed restore stays visible');
}
if (!/function regKeyPath/.test(wgmModule)) {
  fail('registry paths must be built by regKeyPath; hand-written escaping emits double backslashes and targets the wrong key');
}
if (!/minerado-windows-game-mode-status/.test(wgmMain) || !/minerado-windows-game-mode-enable/.test(wgmMain) || !/minerado-windows-game-mode-disable/.test(wgmMain)) {
  fail('the main process must expose status/enable/disable IPC for the Windows game mode switch');
}
if (!/require\('\.\/windows-game-mode'\)/.test(wgmMain)) {
  fail('the main process must require the Windows game mode module');
}
if (!/getWindowsGameModeStatus/.test(wgmPreload) || !/enableWindowsGameMode/.test(wgmPreload) || !/disableWindowsGameMode/.test(wgmPreload)) {
  fail('the preload bridge must expose the Windows game mode APIs to the renderer');
}
if (!/07-fx\/10-windows-game-mode-ui\.js/.test(wgmLoader)) {
  fail('the Windows game mode UI module must be loaded by the index loader');
}
if (!/id="t-windowsGameMode"/.test(html)) {
  fail('the Windows game mode toggle must exist in the DIY panel');
}
if (!/function toggleWindowsGameMode/.test(wgmUi) || !/function refreshWindowsGameModeState/.test(wgmUi)) {
  fail('the Windows game mode UI module must provide the toggle action and the state refresh');
}
// 不支持的平台必须置灰，而不是让用户点了才发现用不了。
// Unsupported platforms must grey the switch out rather than let the user discover it on click.
if (!/supported === false/.test(wgmUi) || !/dev-locked/.test(wgmUi)) {
  fail('the Windows game mode switch must grey out where the platform is unsupported');
}
if (!/typeof refreshWindowsGameModeState === 'function'/.test(panel)) {
  fail('input sync must refresh the Windows game mode state so the panel matches the real registry');
}
if (!/fxConsoleItem\('t-windowsGameMode'/.test(workspace)) {
  fail('the Windows game mode switch must be registered in a console group so it is reachable from the panel');
}
  if (!/className = 'fx-console-child-nest'/.test(workspace) || !/item\.child/.test(workspace)) {
    fail('the console child-subordinate mechanism must exist so switch parameters can nest under their toggle');
  }
  if (!/\.fx-console-child-nest/.test(css)) {
    fail('the child-subordinate container needs styling or nested parameters look like group peers');
  }
  // 从属块之后若还有独立开关（实验功能里是 Cuefield AutoMix），必须隔开：每个 fx-toggle 都会
  // 新建自己的 .fx-toggle-grid，所以分隔线要加在紧随其后的那个 grid 上，否则它看起来像第三个参数。
  // When a standalone switch follows a child block (Cuefield AutoMix in the experimental group), it
  // must be set apart: every fx-toggle opens its own .fx-console-toggle-grid, so the rule belongs on
  // the grid right after the nest or the switch reads as a third parameter of the block above.
  if (!/\.fx-console-child-nest \+ \.fx-toggle-grid/.test(css)) {
    fail('a standalone toggle after a child block needs a separator, or it looks like a nested parameter');
  }
  // 根因：基类 .fx-toggle-grid 是两列布局，两个开关会并排；从属块跟着哪个开关就说不清了。
  // 控制台里必须覆盖成单列。
  // Root cause: the base .fx-toggle-grid is two columns, so two switches sit side by side and a
  // following child block cannot be attributed to either. The console must force a single column.
  if (!/\.fx-console-toggle-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(css)) {
    fail('console toggle grid must be single-column, or switches with child parameters sit side by side');
  }
  // 光单列还不够：child 分支不清空 state.toggleGrid，Cuefield 会复用上一个 grid 追加到从属块之前。
  // 所以从属块之后遇到开关必须强制新建 grid。
  // Single column is not enough: the child branch leaves state.toggleGrid set, so the next switch
  // would be appended into the same grid above the nest. A switch after a nest must force a new grid.
  if (!/!state\.toggleGrid \|\| state\.childNest/.test(workspace)) {
    fail('a switch following a child block must start a fresh grid, or the separator can never match');
  }
  if (!/data-console-layout['"],\s*['"]task-first-v2/.test(workspace) && !/setAttribute\('data-console-layout', 'task-first-v2'\)/.test(workspace)) fail('visual console layout marker is missing');
  if (!/node\.parentNode === panel/.test(workspace)) fail('visual console old-shell cleanup can remove reparented controls');
  if (!/FX_CONSOLE_HISTORY_LIMIT\s*=\s*40/.test(workspace) || !/fxConsoleChangedKeys/.test(workspace)) fail('scoped session history guard is missing');
  if (!/home:\s*1[\s\S]*interface:\s*1[\s\S]*lyrics:\s*1[\s\S]*motion:\s*1[\s\S]*shelf:\s*1[\s\S]*system:\s*1/.test(panel)) fail('visual console tab allow-list is incomplete');
  if (!/\.fx-console-toolbar/.test(css) || !/\.fx-console-group/.test(css) || !/prefers-reduced-motion:reduce/.test(css)) fail('visual console layout or reduced-motion styles are missing');
  if (!/fxConsoleSearchHitDelayTimer/.test(workspace) || !/outline-offset:\s*-2px/.test(css) || !/\.bg-media-actions,[\s\S]{0,160}\.wallpaper-engine-actions/.test(css)) fail('visual console search highlight or background media responsive layout is missing');
  // 「背景星河」的归属：它是预设自带的背景层，不是通用粒子参数，必须留在 动效→基础画面，
  // 且不得再回到 粒子与光影。
  // 判据**真跑一遍布局数据**，而不是比两个分组 key 的先后位置。位置比对只能说明"这条声明夹在
  // 它们之间"：看不出重复声明（旧的留在基础画面组、再加一份到粒子组时，第一处仍在基础画面组，
  // 位置判据照样绿），也分不清"删掉了"和"挪进了别的分组"。而重复声明**不会报错**——
  // fxConsoleAppendItem 认到同一个 DOM 节点后只把别名拼起来，控件实际仍渲染在第一个分组里。
  // 这里把 fxConsoleLayout() 整段抽出来，在只提供 consoleWorkspaceText / fxConsoleItem 的沙箱里
  // 真调一次，直接问数据"这个控件在哪个标签页的哪个分组"，并且必须**恰好命中一次**。
  // 沙箱里没有词典，consoleWorkspaceText 会退回键名，所以断言标题等于 'fx_bg_galaxy' 就是断言
  // "标题取自这个键"。注释一律先剥掉，否则注释里的字样就能单独把判据满足。
  //
  // Where the background star river belongs: it is a preset-owned background layer rather than a
  // generic particle parameter, so it must sit in motion -> base and must not drift back into the
  // particle group. The check RUNS the layout data instead of comparing the positions of the two group
  // keys. Position only shows that a declaration sits between them: it cannot see a duplicate (with the
  // old one left in base and a second added to particles, the first occurrence is still inside base, so
  // the positional check stays green) and cannot tell "deleted" from "moved elsewhere". And a duplicate
  // is silent — fxConsoleAppendItem sees the same element, merges only the aliases, and the control
  // keeps rendering in the first group. The function is therefore extracted and really invoked in a
  // sandbox that only provides consoleWorkspaceText / fxConsoleItem, and the control must be found
  // exactly once. Without a dictionary in the sandbox, consoleWorkspaceText falls back to the key name,
  // so asserting the title equals 'fx_bg_galaxy' asserts which key it came from. Comments are stripped
  // first, or a matching comment alone would satisfy the check.
  const consoleStripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const workspaceCode = consoleStripComments(workspace);
  const panelCode = consoleStripComments(panel);
  const layoutStart = workspaceCode.indexOf('function fxConsoleLayout()');
  const layoutEnd = workspaceCode.indexOf('function fxConsoleResolveBlock');
  if (layoutStart < 0 || layoutEnd <= layoutStart) fail('fxConsoleLayout() cannot be evaluated');
  // 必须包一层函数：runInNewContext 按「脚本」求值，顶层 return 是语法错误。
  // The wrapper is required: runInNewContext evaluates a script, where a top-level return is illegal.
  const consoleTabs = vm.runInNewContext(
    '(function () {\n' + workspaceCode.slice(layoutStart, layoutEnd) + '\nreturn fxConsoleLayout();\n})()',
    {
      consoleWorkspaceText: (key, fallback) => (fallback == null ? key : String(fallback)),
      fxConsoleItem: (ref, title, aliases, history, child) => ({
        ref: ref, title: title, aliases: aliases || '', history: history !== false, child: child === true
      })
    }
  );
  const starRiverHits = [];
  consoleTabs.forEach(tab => (tab.groups || []).forEach(group => (group.items || []).forEach(item => {
    if (item.ref === 't-backgroundStarRiver') starRiverHits.push({ tab: tab.key, group: group.key, item: item });
  })));
  if (starRiverHits.length !== 1) {
    fail(`the console layout must declare the background star river exactly once, found ${starRiverHits.length}`);
  }
  const starRiverEntry = starRiverHits[0];
  if (starRiverEntry.tab !== 'motion' || starRiverEntry.group !== 'base') {
    fail(`the background star river must live in motion -> base, not in ${starRiverEntry.tab} -> ${starRiverEntry.group}`);
  }
  // 别名必须是**中文同义措辞**，不能再拼第二个词典键：曾经有个 fx_starfield，值与标题逐字相同，
  // 对搜索零增益（搜同一串字本来就命中标题），已合并掉。沙箱里 consoleWorkspaceText 返回键名本身，
  // 所以「别名里出现 fx_ 开头的词」就说明有人又把键拼进来了 —— 判据正好利用这一点。
  // The alias must hold Chinese synonyms and must not append a second dictionary key: a former
  // fx_starfield key duplicated the title verbatim and added nothing to search, so it was merged away.
  // In the sandbox consoleWorkspaceText returns the key name, so an `fx_` token in the aliases means a
  // key reference crept back in.
  if (starRiverEntry.item.title !== 'fx_bg_galaxy' || !/星空/.test(starRiverEntry.item.aliases)) {
    fail('the star river console item must be titled with the switch\'s own label and keep the Chinese synonyms as a search alias');
  }
  if (/fx_\w+/.test(starRiverEntry.item.aliases)) {
    fail('the star river search alias must not be assembled from a second dictionary key: ' + starRiverEntry.item.aliases);
  }
  // 旧特效面板（organizeFxPanel 走的降级路径）里，这个开关也不能再被歌词开关的 grid 收走。
  // The legacy panel (the degraded path behind organizeFxPanel) must not claim it for the lyric grid either.
  const lyricListStart = panelCode.indexOf('function ensureLyricPrimaryControls');
  const lyricListEnd = panelCode.indexOf('.forEach(function (id) { moveToggleToGrid(id, grid); })', lyricListStart);
  const lyricMoveList = lyricListStart > -1 && lyricListEnd > lyricListStart ? panelCode.slice(lyricListStart, lyricListEnd) : '';
  if (!/t-lyricVerticalFloat/.test(lyricMoveList) || /t-backgroundStarRiver/.test(lyricMoveList)) {
    fail('the legacy lyric switch grid must keep the lyric switches and must not claim the background star river');
  }
  const clarityButtonsReady = ['1', '2', '3', '4'].every(value => html.includes(`data-lyric-texture-clarity="${value}"`));
  const clarityLabelsReady = ['1×', '2×', '3×', '4×', '标清', '高清', '超清', '极致'].every(label => html.includes(label));
  const packagedDefaultsUseRuntimeDefaults = /PACKAGED_DEFAULT_FX_SNAPSHOT\s*=\s*Object\.freeze\(Object\.assign\(\{[\s\S]{0,180}visualPresetSchema:\s*VISUAL_PRESET_SCHEMA[\s\S]{0,120}\},\s*fxDefaults\)\)/.test(packagedDefaults);
  if (!/id="lyric-texture-quality-seg"/.test(html) || !clarityButtonsReady || !clarityLabelsReady || /data-lyric-texture-clarity="1\.(?:25|5)"/.test(html) || !/lyricTextureClarity:\s*1/.test(defaults) || !packagedDefaultsUseRuntimeDefaults || !defaultArchive.snapshot || defaultArchive.snapshot.lyricTextureClarity !== 1 || !/normalizeLyricTextureClarity/.test(persistence + archive + panel) || !/invalidateLyricQualityTextures\('texture-clarity-change'/.test(panel) || /scheduleStageLyricFullTrackWarmup\('texture-clarity-change'/.test(panel) || !/function lyricQualityPoolBudgetBytes/.test(maskTexture) || !/function makeLyricQualityTexture/.test(maskTexture) || !/function queueLyricRowQuality/.test(rowLayers) || !/qualityHotUntil/.test(rowLayers) || !/backgroundStarRiver'\s*,\s*'lyricTextureClarity'\s*,\s*\/\/ Append-only:[\s\S]{0,120}'lyricLiveViewportFit'/.test(archive)) fail('1x-4x visible-row lyric quality, persistence, cache budget, or append-only MR2 archive wiring is incomplete');
  if (!/function finalizeLyricQualitySelectionFrame/.test(rowLayers) || !/frameCandidates/.test(rowLayers) || !/function lyricQualityEffectiveBudgetBytes/.test(rowLayers) || !/qualityFallbackUntil/.test(rowLayers) || !/function pruneLyricQualityQueue/.test(rowLayers) || !/row\.qualityWanted !== true/.test(rowLayers) || !/lyricQualityEnsureCapacity\(job\.bytes[\s\S]{0,900}makeLyricQualityTexture/.test(rowLayers) || !/qualityRootPriority:\s*isCurrent \? 0 : 1000/.test(stageLyrics) || /qualityRetryAfter/.test(rowLayers) || !/fallbackHotUntil/.test(rowLayers) || !/release:\s*next <= 1/.test(panel)) fail('lyric quality global byte-aware selection, stale-job pruning, pre-render capacity check, or no-flash tier handoff is incomplete');
  const qualityCommitBody = rowLayers.slice(rowLayers.indexOf('function commitLyricRowQuality'), rowLayers.indexOf('function beginLyricQualitySelectionFrame'));
  if (!/frameCommits:\s*\[\]/.test(rowLayers) || !/function commitDeferredLyricQualityRows/.test(rowLayers) || !/lyricQualityState\.deferFinalize \|\| row\.qualityWanted !== true/.test(qualityCommitBody) || /discardLyricRowPendingQuality/.test(qualityCommitBody) || !/commitDeferredLyricQualityRows\(\)/.test(rowLayers) || !/function disposeLyricQualityOwner/.test(rowLayers) || !/__mineradioLyricQualityDisposed/.test(rowLayers) || !/disposeLyricQualityOwner\(lyricData\)/.test(starRiver) || !/qualityProjectedPoolBytes/.test(rowLayers) || !/function lyricQualityHasPendingTexture/.test(rowLayers)) fail('lyric quality deferred commit, disposed-owner cancellation, or bounded atomic tier replacement guard is incomplete');
  const fpsModesReady = ['vsync', '45', '60', '75', '90', '120'].every(value => html.includes(`data-foreground-fps="${value}"`));
  if (!fpsModesReady || !/function setForegroundFpsMode/.test(panel) || !/foregroundFpsMode/.test(persistence) || !/foreground-fps-seg/.test(workspace + css) || !/foregroundFpsMode:\s*'vsync'/.test(defaults) || !packagedDefaultsUseRuntimeDefaults) fail('default VSync and optional foreground FPS controls are incomplete');
  console.log('[OK] Six task tabs, explicit grouping, scoped history, safe DOM cleanup, search, and responsive styles are wired.');
}

function checkIdleGuideCanvasReleaseGuard() {
  logStep('Idle guide canvas release guard');
  const idleText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '09-idle-toast-libraries.js'), 'utf8');
  // 判据跑在剥掉注释的代码上：注释里出现函数名会让"不许出现某写法"这类判据误报。
  // Judgements run on comment-stripped code so a function name mentioned in prose cannot trip them.
  const idleCode = idleText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // 空闲引导画布只在可见期间被绘制（不可见时那一帧只清屏就返回），所以隐藏后必须把后备存储
  // 收回 1x1，否则一块全屏画布会一直占着，直到下次窗口 resize 才被重新撑开。
  // The idle guide canvas is only drawn while visible (the hidden branch just clears and returns),
  // so its backing store has to collapse to 1x1 on hide, otherwise a full-viewport canvas stays
  // allocated until the next window resize re-inflates it.
  if (!/function releaseIdleGuideCanvas\(/.test(idleCode)) {
    fail('the idle guide canvas must be releasable');
  }
  const releaseBlock = idleCode.slice(
    idleCode.indexOf('function releaseIdleGuideCanvas('),
    idleCode.indexOf('function resizeIdleGuideCanvas(')
  );
  if (!/idleGuideCanvas\.width = 1;/.test(releaseBlock) || !/idleGuideCanvas\.height = 1;/.test(releaseBlock)) {
    fail('the idle guide canvas backing store must collapse to 1x1 when hidden');
  }
  if (!/idleGuideParticles = \[\];/.test(releaseBlock)) {
    fail('the idle guide particle array must be dropped with the canvas');
  }
  const visibleBlock = idleCode.slice(
    idleCode.indexOf('function setIdleGuideVisible('),
    idleCode.indexOf('function releaseIdleGuideCanvas(')
  );
  if (!/releaseIdleGuideCanvas\(\);/.test(visibleBlock)) {
    fail('hiding the idle guide must release its canvas');
  }
  // 隐藏分支必须是幂等的、且不能只在状态翻转时执行：初始 idleGuideVisible 就是 false，
  // 若那一轮提前返回，画布会一直保持全屏尺寸。
  // The hidden branch has to be idempotent and must not run only on state flips: the initial
  // idleGuideVisible is already false, and an early return there leaves the canvas full-size.
  if (/if \(idleGuideVisible === show\) return;/.test(visibleBlock)) {
    fail('the idle guide visibility handler must not early-return on an unchanged state');
  }
  if (!/if \(!idleGuideCanvasReleased\) return;/.test(visibleBlock) || !/idleGuideCanvasReleased = false;/.test(visibleBlock)) {
    fail('showing the idle guide again must rebuild the canvas exactly once per hide/show cycle');
  }
  // 这条判据必须收窄到 resizeIdleGuideCanvas 内部：同一行文本也出现在 releaseIdleGuideCanvas 里，
  // 只在文件里全局搜一次的话，"resize 忘了挡"这种回归会被另一处相同写法蒙过去。
  // This judgement has to be scoped inside resizeIdleGuideCanvas: the very same line also appears in
  // releaseIdleGuideCanvas, so a whole-file search would let a "resize forgot to bail" regression
  // pass on the strength of the other copy.
  const resizeBlock = idleCode.slice(
    idleCode.indexOf('function resizeIdleGuideCanvas('),
    idleCode.indexOf('function projectIdleGuidePoint(')
  );
  if (!/if \(!idleGuideCanvas \|\| idleGuideCanvasReleased\) return;/.test(resizeBlock)) {
    fail('resizeIdleGuideCanvas must bail while the canvas is released, or a resize re-inflates it');
  }
  if (!/var idleGuideCanvasReleased = false;/.test(idleCode)) {
    fail('the idle guide release flag must start false');
  }
  console.log('[OK] The idle guide canvas releases its full-screen backing store while hidden and rebuilds it on show, resilient to the initial hidden state.');
}

function checkFirstLaunchDefaultsAndSplashGuard() {
  logStep('First-launch defaults and splash timing guard');
  const defaultsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const packagedText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '05-packaged-fx-archive.js'), 'utf8');
  const archive = JSON.parse(fs.readFileSync(path.join(appRoot, 'public', 'default-user-fx-archive.json'), 'utf8'));
  const persistenceText = readVisualArchiveText();
  const fxArchiveText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
  const splashText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '03-splash.js'), 'utf8');
  const splashCode = splashText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const css = readAllCssFiles();
  const marker = 'var fxDefaults = ';
  const start = defaultsText.indexOf(marker);
  const end = defaultsText.indexOf('\n};', start);
  if (start < 0 || end < 0) fail('fxDefaults object cannot be inspected');
  const defaults = vm.runInNewContext(`(${defaultsText.slice(start + marker.length, end + 2)})`, Object.create(null));
  const snapshot = archive && archive.snapshot;
  const keys = Object.keys(defaults);
  const snapshotKeys = snapshot ? Object.keys(snapshot).filter(key => key !== 'visualPresetSchema') : [];
  const drift = keys.filter(key => !snapshot || JSON.stringify(snapshot[key]) !== JSON.stringify(defaults[key]));
  if (!snapshot || snapshotKeys.length !== keys.length || drift.length) {
    fail(`first-launch runtime and packaged archive defaults drifted: ${drift.join(', ') || 'key-count mismatch'}`);
  }
  const expectedCapturedDefaults = {
    depth: 0.2,
    lyricDisplayMode: 'cinema',
    lyricTranslationMode: 'multi',
    lyricFont: 'sans',
    lyricWeight: 750,
    controlGlassChromaticOffset: 50,
    playlistPanelGlassBlur: 14,
    playlistPanelGlassDensity: 0.55,
    performanceBackground: 'release',
    // 默认档位从 eco 提到 balanced：eco 的粒子预算系数只有 0.28，首启动就少七成粒子。
    // Default tier raised from eco to balanced: eco's particle budget factor is only 0.28.
    performanceQuality: 'balanced',
    memoryAutoSystemTrim: true,
    memorySystemAutoElevate: false,
    wallpaperFps: 60,
    shelfCameraMode: 'dynamic',
    shelfPresence: 'auto',
    // 两个视觉开关的默认值：溢光默认关、轮廓默认开。它们同时在打包快照里（上面的 drift 比对已覆盖），
    // 这里再单独钉一次，是为了让"顺手改默认值"必须先解释清楚，而不是悄悄跟着快照一起漂走。
    // The two visual switch defaults: bloom off, edge on. The packaged snapshot is already covered by
    // the drift comparison above; pinning them here as well forces any future flip to be deliberate.
    edge: true,
    bloom: false
  };
  const capturedDrift = Object.keys(expectedCapturedDefaults).filter(key => JSON.stringify(defaults[key]) !== JSON.stringify(expectedCapturedDefaults[key]));
  if (capturedDrift.length || archive.exportedAt !== 1784607916226 || archive.savedAt !== 1784607916226) {
    fail(`captured first-launch settings identity drifted: ${capturedDrift.join(', ') || 'timestamp'}`);
  }
  // 存档读取的缺键方向：bloom 默认关，缺键就该是 false（`=== true`）；edge 默认开，缺键就该是 true
  //（`!== false`）。两处都写成同一个方向时，旧存档会静默拿到与当前默认相反的值——正是这次要修的坑。
  // 判据必须先剥注释：说明文字里同时出现了两种写法，直接匹配原文会被自己的注释满足。
  // Missing-key direction in the archive readers: bloom defaults off, so a missing key has to read
  // false (`=== true`); edge defaults on, so it has to read true (`!== false`). Forcing both in one
  // direction hands old saves the opposite of the current default — the bug this change fixes.
  // Comments are stripped first because the comment above spells out both spellings.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const persistenceCode = stripComments(persistenceText);
  const fxArchiveCode = stripComments(fxArchiveText);
  if (!/bloom:\s*raw\.bloom === true/.test(persistenceCode) || !/edge:\s*raw\.edge !== false/.test(persistenceCode)) {
    fail('autosave read must treat a missing bloom as off and a missing edge as on, matching the defaults');
  }
  if (!/bloom:\s*!!raw\.bloom/.test(fxArchiveCode) || !/edge:\s*raw\.edge !== false/.test(fxArchiveCode)) {
    fail('preset archive read must follow the same missing-key direction as the autosave read');
  }
  if (!/PACKAGED_DEFAULT_FX_SNAPSHOT\s*=\s*Object\.freeze\(Object\.assign\(\{[\s\S]{0,180}visualPresetSchema:\s*VISUAL_PRESET_SCHEMA[\s\S]{0,120}\},\s*fxDefaults\)\)/.test(packagedText)) {
    fail('packaged first-launch snapshot must inherit the synchronized runtime defaults');
  }
  if (!/function splashTimelineElapsed\(elapsed\)\s*\{\s*return elapsed;\s*\}/.test(splashText)
    || /elapsed\s*\*\s*3\.32/.test(splashText)
    || !/setTimeout\(markSplashReadyToEnter,\s*650\)/.test(splashText)
    || !/setTimeout\(markSplashReadyToEnter,\s*1500\)/.test(splashText)
    || !/\.splash-word-mine\s*\{[\s\S]{0,160}animation:\s*splash-mine-in 5200ms/.test(css)
    || !/\.splash-word-radio\s*\{[\s\S]{0,420}animation:\s*splash-radio-in 5200ms/.test(css)
    || !/\.splash-word-i::after\s*\{[\s\S]{0,480}animation:\s*splash-i-dot-pop 4200ms/.test(css)
    || !/\.splash-signal-line\s*\{[\s\S]{0,500}animation:\s*splash-signal-line 4200ms/.test(css)
    || !/\.splash-signal-line::after\s*\{[\s\S]{0,420}animation:\s*splash-signal-blip 4200ms/.test(css)
    || !/\.splash-sub\s*\{[\s\S]{0,260}animation:\s*splash-sub-in 4200ms/.test(css)) {
    fail('public-repo splash motion speed and the independent fast click-entry gate must stay decoupled');
  }
  if (!/\.user-archive-toolbar\s*\{[\s\S]{0,220}display:\s*grid;[\s\S]{0,160}grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css)
    || !/\.user-archive-tools\s*\{[\s\S]{0,180}display:\s*grid;[\s\S]{0,160}grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(css)
    || !/\.user-archive-tools \.fx-mini-btn\s*\{[\s\S]{0,180}width:\s*100%;[\s\S]{0,160}white-space:\s*nowrap/.test(css)) {
    fail('user archive actions must stay in one balanced three-column row');
  }
  // 启动画面结束后必须释放渲染资源：它不会重播，否则一个活的 WebGL 上下文 + 一块全屏画布
  // 会一直占着内存。关键是"两条收尾路径都要释放"，且释放后 resize 不能把它重新撑回来。
  // The splash must release its render resources once gone: it never replays, so a live WebGL
  // context plus a full-viewport canvas would stay allocated forever. Both dismissal paths have to
  // release, and a later resize must not re-inflate what was released.
  if (!/function releaseSplashRenderResources\(/.test(splashCode)) {
    fail('the splash must release its render resources on dismissal');
  }
  const releaseBlock = splashCode.slice(
    splashCode.indexOf('function releaseSplashRenderResources('),
    splashCode.indexOf('function dismissSplash(')
  );
  if (!/WEBGL_lose_context/.test(releaseBlock) || !/loseContext\(\)/.test(releaseBlock)) {
    fail('the splash WebGL context must be explicitly released, not just dereferenced');
  }
  if (!/removeEventListener\('resize', splashResizeHandler\)/.test(releaseBlock)) {
    fail('the splash resize listener must be removed, otherwise a resize re-inflates the canvas');
  }
  if (!/splashCanvas\.width = 1;/.test(releaseBlock) || !/splashCanvas\.height = 1;/.test(releaseBlock)) {
    fail('the splash canvas backing store must collapse to 1x1 on release');
  }
  const releaseCalls = (splashCode.match(/releaseSplashRenderResources\(\);/g) || []).length;
  if (releaseCalls < 2) {
    fail(`both splash dismissal paths must release resources (found ${releaseCalls} release call)`);
  }
  if (!/function resize\(\) \{\s*if \(splashResourcesReleased\) return;/.test(splashCode)) {
    fail('the splash resize handler must bail out after release');
  }
  // 释放标志必须在 IIFE 之前赋值：resize() 在模块执行期就跑过一次，靠 var 提升读到的会是
  // undefined，语义含糊。
  // The release flag must be assigned before the IIFE because resize() already runs during module
  // evaluation and would otherwise read a hoisted undefined.
  if (splashCode.indexOf('var splashResourcesReleased = false;') > splashCode.indexOf('(function initMineradioSplashCanvas()')) {
    fail('the splash release flag must be declared before the splash canvas IIFE');
  }
  console.log(`[OK] ${keys.length} captured defaults match; splash motion is 5.2s/4.2s while entry stays ready at 1.5s/0.65s; archive actions stay in one row; splash releases its GL context and canvas on dismissal.`);
}

module.exports = {
  checkLyricLayoutRangeGuard,
  checkPointerLockPermission,
  checkLyricBackfaceMaterialGuard,
  checkLyricScrollPerformanceGuard,
  checkLyricTranslationCompletenessGuard,
  checkLyricVerticalFloatToggleGuard,
  checkSonicTopographyPresetGuard,
  checkBeatAnalysisToggleGuard,
  checkFxConsoleWorkspaceGuard,
  checkIdleGuideCanvasReleaseGuard,
  checkFirstLaunchDefaultsAndSplashGuard,
};
