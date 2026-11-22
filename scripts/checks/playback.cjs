'use strict';

// 检查函数从原 scripts/quick-check.js **原样搬出**，断言一条未改。
const env = require('./env.cjs');
const {
  readAllCssFiles,
  logStep,
  fail,
  requireLocaleKeys,
  walk,
  runtimeQaScript,
  fs,
  path,
  vm,
  appRoot,
  playlistDetailTextStub,
} = env;

function checkProgressSeekDragGuard() {
  logStep('Progress drag seek guard');
  const progressPath = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js');
  const stagePath = path.join(appRoot, 'public', 'js', 'modules', '02-visual', '14-stage-lyrics-rendering.js');
  const mainLoopPath = path.join(appRoot, 'public', 'js', 'modules', '11-main-loop.js');
  const rendererQualityPath = path.join(appRoot, 'public', 'js', 'modules', '01-scene', '00-renderer-quality.js');
  const text = fs.readFileSync(progressPath, 'utf8');
  const stageText = fs.readFileSync(stagePath, 'utf8');
  const mainLoopText = fs.readFileSync(mainLoopPath, 'utf8');
  const rendererQualityText = fs.readFileSync(rendererQualityPath, 'utf8');
  if (!/previewProgressPointer/.test(text) || !/commitProgressSeek/.test(text) || !/waitForProgressSeekReady/.test(text)) {
    fail('progress drag must preview during drag and commit seek once on release');
  }
  if (!/isProgressDragPreviewActive/.test(text) || !/getProgressDragPreviewSeconds/.test(text)) {
    fail('progress drag must expose preview time for lyrics and beat visuals');
  }
  if (!/stageLyricProgressPreviewActive/.test(stageText) || !/stageLyricPlaybackSeconds/.test(stageText) || !/getProgressDragPreviewSeconds/.test(stageText)) {
    fail('stage lyrics must follow progress drag preview time without seeking audio on every pointermove');
  }
  const previewTickBody = (text.match(/function scheduleProgressLyricPreviewTick\(\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  if (!/scheduleProgressLyricPreviewTick/.test(text) || !/markRenderInteraction\('progress-drag'/.test(text) || !/wakeMainLoopFromBackground/.test(previewTickBody) || /tickLyricsParticles\(\)/.test(previewTickBody) || !/mainFrameGates\.lyricsParticles/.test(mainLoopText) || !/tickLyricsParticles\(\)/.test(mainLoopText)) {
    fail('progress drag must keep one main-loop-owned lyric tick per display frame');
  }
  if (!/function shouldSkipFixedRenderCadenceFrame/.test(mainLoopText) || !/state\.phase[\s\S]{0,300}elapsedMs \* fps \/ 1000/.test(mainLoopText) || !/fps >= displayHz \* 0\.98/.test(mainLoopText) || !/fixedForegroundFps/.test(rendererQualityText) || !/fixedForegroundFps == null \|\| fixedForegroundFps === 0/.test(rendererQualityText)) {
    fail('fixed foreground FPS must use phase accumulation and must not be bypassed by repeated drag interaction wakeups');
  }
  if (/renderProgressPreview\(preview\.time, preview\.duration\);\s*syncBeatMapPlaybackCursor/.test(text)) {
    fail('raw pointermove must not rescan the full beat map during lyric preview');
  }
  if (!/previewHoldUntil/.test(text) || !/previewClockRunning/.test(text) || !/getProgressPreviewClockSeconds/.test(text)) {
    fail('progress drag release must keep one continuous preview clock through seek settle');
  }
  if (!/beginProgressPreviewHold\(serial,\s*2800,\s*!!resumeAfterSeek,\s*media,\s*mediaSrc,\s*targetTime\)/.test(text) || !/finishProgressPreviewHold\(serial,\s*96\)/.test(text)) {
    fail('progress drag release must retain the preview clock across slow seek and lyric-window settlement');
  }
  if (!/function progressSeekTargetReached/.test(text) || !/!progressSeekMediaStillCurrent/.test(text) || !/media\.seeking/.test(text) || !/waitForProgressSeekReady\(media,\s*targetTime,\s*serial/.test(text)) {
    fail('progress seek completion must verify media identity, seek state, serial, and actual target time');
  }
  if (!/function progressSeekPreviewVisualReady/.test(text) || !/stageLyricProgressSeekVisualReady/.test(text + stageText) || !/previewAudioSettled && progressSeekPreviewVisualReady\(\)/.test(text)) {
    fail('progress preview must not hand its clock back before the final lyric window is visually committed');
  }
  if (!/primeProgressSeekPlayback\(media,\s*mediaSrc,\s*serial\)/.test(text) || !/resumePlaySerial/.test(text)) {
    fail('progress drag release must pre-start playback while muted instead of waiting for a second visual/audio handoff');
  }
  if (!/isProgressDragPreviewActive\(\)\s*&&\s*progressDragState\.previewDuration[\s\S]{0,120}renderProgressPreview\(getProgressPreviewClockSeconds\(\),\s*progressDragState\.previewDuration\)/.test(text)) {
    fail('progress UI must follow the same preview clock during release hold');
  }
  if (!/progressBar\.addEventListener\('pointermove'[\s\S]{0,180}queueProgressPointerPreview/.test(text) || !/function queueProgressPointerPreview[\s\S]{0,650}previewProgressPointer/.test(text)) {
    fail('progress pointermove must coalesce and update preview instead of committing audio currentTime');
  }
  if (/progressBar\.addEventListener\('pointermove'[\s\S]{0,220}currentTime\s*=/.test(text)) {
    fail('progress pointermove must not write audio.currentTime while dragging');
  }
  if (!/setAudioOutputGainImmediate\(0\)/.test(text) || !/resumeAfterSeek/.test(text) || !/attemptAudioPlay\(\{ manual: true, silent: true, fade: true \}\)/.test(text)) {
    fail('progress seek must mute during drag and resume with a fade after release');
  }
  if (!/!audio\.paused && !audio\.ended && playing/.test(text) || !/if \(!resumeAfterSeek\)[\s\S]{0,260}media\.pause\(\)/.test(text)) {
    fail('progress seek must only resume audio when it was actually playing before drag');
  }
  const commitStart = text.indexOf('function commitProgressSeek');
  const commitIdentityGuard = text.indexOf('if (!progressSeekMediaStillCurrent(media, mediaSrc))', commitStart);
  const commitMute = text.indexOf('setAudioOutputGainImmediate(0)', commitStart);
  if (!/function progressSeekMediaStillCurrent\(media, mediaSrc\)/.test(text) || commitStart < 0 || commitIdentityGuard < commitStart || commitMute < 0 || commitIdentityGuard > commitMute || /if \(!progressSeekMediaStillCurrent\(media, mediaSrc\)\) \{[\s\S]{0,120}restorePlaybackGain\(\)/.test(text) || !/progressSeekMediaStillCurrent\(dragMedia, dragMediaSrc\)[^\n]*restorePlaybackGain/.test(text)) {
    fail('stale progress drags must never mute or restore gain on a newly switched audio element');
  }
  console.log('[OK] Progress drag previews visually and commits audio seek on release.');
}

function checkPlaybackControlBadgesGuard() {
  logStep('Playback control source/VIP badge guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const searchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '07-search.js'), 'utf8');
  const controlText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '15-ripples-cover-depth.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const qualityText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '00-api-quality-output.js'), 'utf8');
  const fallbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js'), 'utf8');
  const switchCoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js'), 'utf8');
  const lyricFetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-lyrics-fetch-parse.js'), 'utf8');
  const beatPrefetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const glassText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '15-control-glass-animations.js'), 'utf8');
  const loginStatusText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
  const accountUtilsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  const sourceSwitcherGlassOk =
    /\.control-source-switcher::before/.test(cssText) &&
    /html\.control-glass-svg-ok\s+\.control-source-switcher\s*\{[\s\S]{0,180}var\(--saved-panel-glass-filter\)/.test(cssText);
  const sourceSwitcherUsesSharedSvgMap =
    /html\.control-glass-svg-ok[\s\S]{0,1400}\.control-source-switcher,[\s\S]{0,360}var\(--saved-panel-glass-svg-filter\)/.test(cssText) ||
    /html\.control-glass-svg-ok[\s\S]{0,1400}\.control-source-switcher\s*\{[\s\S]{0,240}var\(--saved-panel-glass-svg-filter\)/.test(cssText);
  const sourceSwitcherOriginalMatchOk =
    /SOURCE_SWITCH_BLOCKED_ARTIST_TOKENS\s*=\s*\['asablue'\]/.test(searchText) &&
    /SOURCE_SWITCH_STRICT_ARTIST_ALIASES/.test(searchText) &&
    /function sourceCandidateRejectReason/.test(searchText) &&
    /function findControlSourceMatchResult/.test(searchText) &&
    /function controlSourceIssueLabel/.test(searchText) &&
    /sourceCandidateRejectReason\(song, list\[i\], target\)/.test(fallbackText) &&
    /sourceCandidateRejectReason\(song, candidate, 'netease'\)/.test(lyricFetchText);
  if (!/control-title-text/.test(indexText) || !/control-title-badges/.test(indexText)) {
    fail('bottom player title must reserve inline spans for source and VIP badges');
  }
  const qualityControlCount = (indexText.match(/id="quality-control"/g) || []).length;
  const qualityChipInlineOk =
    qualityControlCount === 1 &&
    /id="control-title"[\s\S]{0,260}id="control-title-badges"[\s\S]{0,260}id="quality-control"\s+class="quality-control control-quality-chip"/.test(indexText) &&
    /\.control-quality-chip\s*\{[\s\S]{0,120}height:\s*15px/.test(cssText) &&
    /#quality-btn\.quality-pill\s*\{[\s\S]{0,220}height:\s*15px[\s\S]{0,120}font-size:\s*8px/.test(cssText) &&
    !/body\.diy-mode\s+#quality-control\s*\{[\s\S]{0,80}display:\s*none\s*!important/.test(cssText);
  if (!qualityChipInlineOk) {
    fail('bottom player quality selector must stay as a compact title-side chip and remain visible in windowed DIY mode');
  }
  if (!/function songRequiresVip/.test(searchText) || !/function songVipTagHtml/.test(searchText) || !/only_vip_playable/.test(searchText)) {
    fail('song VIP detection must cover provider fee, trial, only-vip, and playback restriction metadata');
  }
  if (!/control-title-badges/.test(controlText) || !/songSourceTagHtml\(song, \{ switcher: true \}\)/.test(controlText) || !/songVipTagHtml\(song\)/.test(controlText)) {
    fail('bottom player controls must render the active provider and VIP badges beside the title');
  }
  if (!/song\.resolvedPlaybackProvider/.test(playbackText) || !/song\.vipRequired/.test(playbackText) || !/updateControlTrackInfo\(song\)/.test(playbackText)) {
    fail('playback URL resolution must refresh bottom control badges with provider/VIP state');
  }
  if (!/function playbackRestrictionNotice/.test(fallbackText) || !/function playbackRestrictionCategory/.test(fallbackText) || !/pf_platform_no_vip_status/.test(fallbackText) || !/showSourceFallbackNotice\(notice\.title, notice\.body\)/.test(fallbackText) || !/function playbackFailureNoticeFromError/.test(switchCoreText)) {
    fail('playback failure notices must distinguish membership, login authorization, provider-limited, copyright, and generic no-url causes');
  }
  requireLocaleKeys('pf_platform_no_vip_status');
  if (!/playbackQualityRuntimeCaps/.test(coreStoreText) || !/function markPlaybackQualityRuntimeCap/.test(qualityText) || !/cap-locked/.test(qualityText + cssText) || !/playbackQualityCapValue\(song, playbackProvider\)/.test(playbackText) || !/markPlaybackQualityRuntimeCap\(song, playbackProvider, data\.level/.test(playbackText) || !/markPlaybackQualityRuntimeCap\(song, 'qq', nextQuality/.test(fallbackText) || /qqPlaybackQualityCeiling/.test(coreStoreText + playbackText + fallbackText + beatPrefetchText)) {
    fail('playback quality fallback must be tracked per current song and disable unsupported higher choices without a global QQ ceiling');
  }
  if (!/\.control-title-badges/.test(cssText) || !/\.control-title-text/.test(cssText)) {
    fail('bottom player source/VIP badges must have constrained responsive CSS');
  }
  if (!/search_switcher_chip_html/.test(searchText) || !/function toggleControlSourceSwitcher/.test(searchText) || !/function switchCurrentSongSource/.test(searchText) || !/findControlSourceMatch/.test(searchText) || !/resumeAt: currentResumeSeconds\(0\)/.test(searchText) || !/\.control-source-switcher/.test(cssText) || !sourceSwitcherGlassOk || sourceSwitcherUsesSharedSvgMap) {
    fail('bottom player source badge must expand into a glass source switcher without reusing the shared SVG map that cuts the right edge');
  }
  requireLocaleKeys('search_switcher_chip_html');
  if (!sourceSwitcherOriginalMatchOk) {
    fail('source switching and lyric fallback must reject blacklisted cover/derivative candidates and show no-official-source states');
  }
  if (!/quality-switch-preserve-lyrics/.test(playbackText) || !/visual-prep-skip/.test(playbackText) || !/if \(!qualitySwitch\) \{[\s\S]{0,120}safeRenderQueuePanel\('play-queue-at'\)/.test(playbackText) || !/if \(!qualitySwitch\) lyricSunEnergy = 0/.test(playbackText)) {
    fail('quality switching must preserve lyric and visual state instead of running the full track-switch rendering path');
  }
  const accountPillGlassSurfaceOk =
    /\.top-account-pill::before/.test(cssText) &&
    /\.top-account-pill\s*>\s*\*/.test(cssText) &&
    /html\.control-glass-svg-ok\s+\.top-account-pill::before\s*\{[\s\S]*?url\(#mineradio-account-pill-glass-filter\)/.test(cssText);
  const accountPillDirectSvgFilter =
    /html\.control-glass-svg-ok\s+\.top-account-pill\s*\{[\s\S]*?url\(#mineradio-account-pill-glass-filter\)/.test(cssText) ||
    /html\.control-glass-svg-ok\s+\.top-account-pill,/.test(cssText);
  const lastAccountContainerOverride = cssText.lastIndexOf('#user-btn.multi-account,');
  const lastTopRightIconRule = cssText.lastIndexOf('#top-right .icon-btn');
  const accountContainerGlassDisabledOk =
    lastAccountContainerOverride > lastTopRightIconRule &&
    /#user-btn\.multi-account[\s\S]{0,320}background:\s*transparent\s*!important[\s\S]{0,160}box-shadow:\s*none\s*!important[\s\S]{0,160}backdrop-filter:\s*none\s*!important[\s\S]{0,120}-webkit-backdrop-filter:\s*none\s*!important[\s\S]{0,120}transition:\s*none\s*!important/.test(cssText.slice(lastAccountContainerOverride));
  const accountFilterText = (indexText.match(/<filter id="mineradio-account-pill-glass-filter"[\s\S]*?<\/filter>/) || [''])[0];
  const accountPillSimpleRefractionOk =
    /<feDisplacementMap[\s\S]*?scale="28"[\s\S]*?xChannelSelector="R"[\s\S]*?yChannelSelector="G"/.test(accountFilterText) &&
    !/feOffset|feColorMatrix|feBlend|dispRed|dispGreen|dispBlue/.test(accountFilterText);
  const accountPillDedicatedMapOk =
    /function generateAccountPillGlassDisplacementMap/.test(glassText) &&
    /account-x/.test(glassText) &&
    /rgb\(128,128,128\)/.test(glassText) &&
    /controlGlassState\.accountPillKey[\s\S]{0,360}generateAccountPillGlassDisplacementMap\(width, height, radius\)/.test(glassText);
  const accountPillVerticalStackOk =
    /account-pill-stack/.test(loginStatusText) &&
    /#top-right\.account-pill-stack[\s\S]{0,100}align-items:\s*flex-start/.test(cssText) &&
    /#user-btn\.multi-account\.external-account-pills[\s\S]{0,220}flex-direction:\s*column[\s\S]{0,160}align-items:\s*flex-end/.test(cssText) &&
    /#user-btn\.multi-account\.external-account-pills \.top-account-pill[\s\S]{0,120}width:\s*190px/.test(cssText) &&
    /#user-btn\.multi-account\.external-account-pills \.top-account-name[\s\S]{0,120}max-width:\s*118px/.test(cssText) &&
    /e\.clientY\s*<\s*rect\.top\s*\+\s*rect\.height\s*\/\s*2/.test(accountUtilsText) &&
    !/e\.clientX\s*<\s*rect\.left\s*\+\s*rect\.width\s*\/\s*2/.test(accountUtilsText);
  if (!/mineradio-account-pill-glass-filter/.test(indexText) || !/account-pill-glass-map/.test(indexText) || !/url\(#mineradio-account-pill-glass-filter\)/.test(cssText) || !/overflow:\s*hidden/.test(cssText) || !accountPillGlassSurfaceOk || accountPillDirectSvgFilter || !accountContainerGlassDisabledOk || !accountPillSimpleRefractionOk || !accountPillDedicatedMapOk || !accountPillVerticalStackOk || !/function updateAccountPillGlassDisplacementMap/.test(glassText) || !/accountPillKey/.test(glassText) || !/querySelectorAll\('\.top-account-pill'\)/.test(glassText) || !/requestAnimationFrame\(updateAccountPillGlassDisplacementMap\)/.test(loginStatusText)) {
    fail('top account VIP capsules must use a dedicated glass map/filter and refresh it after account rendering');
  }
  console.log('[OK] Bottom player title shows source and VIP badges without stretching the control bar.');
}

function checkPlaybackResumeRecoveryGuard() {
  logStep('Long-pause playback resume recovery guard');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const progressText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js'), 'utf8');
  if (!/playbackResumeRecovery/.test(coreStoreText) || !/pausedAt/.test(coreStoreText) || !/PLAYBACK_RESUME_STALL_DELAYS/.test(coreStoreText) || !/PLAYBACK_RESUME_LONG_PAUSE_MS/.test(coreStoreText) || !/PLAYBACK_RESUME_LONG_PAUSE_PROVIDER_MS/.test(coreStoreText)) {
    fail('global playback resume recovery state must be defined');
  }
  if (!/function recoverCurrentTrackPlaybackFromFreshUrl/.test(controlsText) || !/playQueueAt\(currentIdx,[\s\S]{0,260}resumeRecovery: true/.test(controlsText)) {
    fail('long-pause recovery must refresh the current provider URL and resume from the old position');
  }
  if (!/function updatePlaybackResumePauseMarker/.test(controlsText) || !/function playbackResumePausedLongEnough/.test(controlsText) || !/recoverCurrentTrackPlaybackFromFreshUrl\('long-pause-stale-source'/.test(controlsText) || !/updatePlaybackResumePauseMarker\(reason\)/.test(fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js'), 'utf8'))) {
    fail('manual resume after a long pause must refresh stale provider URLs before trying the old audio src');
  }
  if (!/function schedulePlaybackStallRecovery/.test(controlsText) || !/ensureAudiblePlaybackGain\('resume-stall-before-refresh'\)/.test(controlsText) || !/recoverCurrentTrackPlaybackFromFreshUrl\('play-rejected'/.test(controlsText)) {
    fail('playback resume recovery must cover rejected play() and stalled media after WebAudio checks');
  }
  if (!/function trackSwitchStallRecoveryAllowed/.test(controlsText) || !/playbackResumeProvider\(song\) === 'qishui'/.test(controlsText) || !/\(opts\.trackSwitch \|\| opts\.manual \|\| opts\.fastResume\)/.test(controlsText) || !/function nudgeQishuiTrackStart/.test(controlsText) || !/qishui-track-start-stalled/.test(controlsText) || /if \(opts\.trackSwitch && !opts\.resumeRecovery\) return;/.test(controlsText)) {
    fail('Qishui auto-next start stalls must be watched, nudged, and refreshed instead of skipping track-switch recovery');
  }
  if (
    !/resumeRecovery: !!opts\.resumeRecovery/.test(playbackText)
    || !/audioEl !== audio/.test(progressText)
    || !/__mineradioTrackSwitchToken\) !== Number\(trackSwitchToken\)/.test(progressText)
    || !/playbackMediaMatchesCurrentQueueItem\(audioEl\)/.test(progressText)
    || !/schedulePlaybackStallRecovery\(name,[\s\S]{0,260}ownerQueueItemKey/.test(progressText)
    || !/function playbackStallRecoveryOwnerStillCurrent/.test(controlsText)
  ) {
    fail('track-start and media error/stalled events must feed the shared resume recovery path');
  }
  console.log('[OK] Long-pause resume recovery refreshes expired provider URLs across providers.');
}

function checkAudioOutputWorkflowPanelGuard() {
  logStep('Audio output workflow panel guard');
  const indexText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const qualityText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '00-api-quality-output.js'), 'utf8');
  // 结构判据一律跑在剥掉注释的代码上：注释里出现 "enumerateDevices()" 这类字样
  // 会让判据误报（判据不能匹配注释里描述的行为，只能匹配真的行为）。
  // Structural judgements run on comment-stripped code: an "enumerateDevices()" mention inside a
  // comment would otherwise trip them. A guard must match what the code does, not what it says.
  const qualityCode = qualityText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const modalUtilsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '08-account', '01-login-modal-utils.js'), 'utf8');
  if (!/id="audio-output-workflow-modal"/.test(indexText) || !/id="audio-output-workflow-body"/.test(indexText) || !/openAudioOutputWorkflowPanel\(\)/.test(indexText)) {
    fail('audio output workflow must have a dedicated derivative modal entry instead of only the compact settings panel');
  }
  if (!/function openAudioOutputWorkflowPanel/.test(qualityText) || !/function closeAudioOutputWorkflowPanel/.test(qualityText) || !/renderAudioRouteWorkflowEdgesForRoot/.test(qualityText) || !/document\.querySelectorAll\('\.audio-route-graph'\)/.test(qualityText) || !/audio-output-summary-card/.test(qualityText) || !/audio-route-board-head/.test(qualityText) || !/out_route_board_title_html/.test(qualityText) || !/route-lane-state/.test(qualityText) || !/out_source_meter_html/.test(qualityText) || !/sortedRouteItems/.test(qualityText) || !/audioOutputMirrorRuntime/.test(qualityText) || !/audioOutputMirrorStatusText/.test(qualityText) || !/out_trying_mirror/.test(qualityText) || !/out_route_note_html/.test(qualityText)) {
    fail('audio output workflow must render compact settings summary and full modal route graph');
  }
  // route-board-title / audio-source-meter 这两个 class 名随 HTML 片段搬进了词典，
  // 因此判据校验承载它们的片段 key，而不是在 JS 里搜 class 字面量。
  // These two class names moved into dictionary HTML fragments, so the guard pins the
  // fragment keys that carry them instead of grepping the class literals out of JS.
  requireLocaleKeys('out_trying_mirror', 'out_route_note_html', 'out_route_board_title_html', 'out_source_meter_html');
  if (!/audio-output-workflow-modal/.test(cssText) || !/audio-output-workflow-modal \.audio-route-graph[\s\S]{0,320}grid-template-areas: "source board" "status board"/.test(cssText) || !/audio-route-board/.test(cssText) || !/route-board-badges/.test(cssText) || !/route-lane-state/.test(cssText) || !/audio-source-meter/.test(cssText) || !/audio-route-node\.pending/.test(cssText) || !/audio-route-node\.warning/.test(cssText) || !/audio-output-workflow-modal \.workflow-link-layer[\s\S]{0,120}display: none/.test(cssText) || !/audio-output-summary-card/.test(cssText)) {
    fail('audio output workflow modal must expose a Loopback-style patch bay board instead of a three-column device table');
  }
  if (!/\['audio-output-workflow-modal', closeAudioOutputWorkflowPanel\]/.test(modalUtilsText)) {
    fail('audio output workflow modal must close through the shared backdrop modal handler');
  }
  // 启动时不得枚举媒体设备。enumerateDevices() 会让 Chromium 启动 audio+video 设备监视，
  // 视频侧随之拉起 Video Capture Service 进程（本机实测常驻约 116MB），而默认配置下本应用
  // 根本不碰摄像头。枚举与热插拔监听都只能发生在"输出设备界面首次可见"之后。
  // Media devices must not be enumerated at boot: it makes Chromium start audio+video device
  // monitoring and spawn the Video Capture Service (~116MB measured resident) although this app
  // never touches a camera by default. Enumeration and the hot-plug listener may only happen after
  // the output-device UI first becomes visible.
  const bootBindStart = qualityCode.indexOf('function bindAudioOutputControls(');
  const revealStart = qualityCode.indexOf('function bindAudioOutputDeviceRevealHook(');
  if (bootBindStart < 0 || revealStart < 0) {
    fail('audio output controls must arm a first-reveal hook instead of enumerating during boot');
  }
  const bootBindBlock = qualityCode.slice(bootBindStart, revealStart);
  if (/refreshAudioOutputDevices\(|enumerateDevices|addEventListener\('devicechange'/.test(bootBindBlock)) {
    fail('boot must not enumerate media devices nor register the hot-plug listener; the reveal hook does it lazily');
  }
  // 枚举只允许出现在 refreshAudioOutputDevices 里：判据是"它之前一处都没有"，
  // 这样新增一个启动期调用点会立刻命中，而不需要维护一份出现次数快照。
  // Enumeration may only appear inside refreshAudioOutputDevices: the judgement is "none before
  // it", so a newly added boot-time call site trips immediately without pinning a count.
  const beforeRefresh = qualityCode.slice(0, qualityCode.indexOf('async function refreshAudioOutputDevices('));
  if (/enumerateDevices/.test(beforeRefresh)) {
    fail('enumerateDevices must not appear before refreshAudioOutputDevices');
  }
  const ensureBlock = qualityCode.slice(
    qualityCode.indexOf('function ensureAudioOutputDevicesLoaded('),
    qualityCode.indexOf('async function refreshAudioOutputDevices(')
  );
  if (!/audioOutputDevicesLoaded\) return;/.test(ensureBlock) || !/audioOutputDevicesLoaded = true;/.test(ensureBlock)) {
    fail('the lazy device load must be one-shot, otherwise every reveal re-enumerates');
  }
  if (!/addEventListener\('devicechange'/.test(ensureBlock)) {
    fail('the device hot-plug listener must be registered by the lazy loader, not at boot');
  }
  const panelOpenBlock = qualityCode.slice(
    qualityCode.indexOf('function openAudioOutputWorkflowPanel('),
    qualityCode.indexOf('function closeAudioOutputWorkflowPanel(')
  );
  if (!/ensureAudioOutputDevicesLoaded\(\);/.test(panelOpenBlock)) {
    fail('opening the output workflow panel must trigger the lazy device load');
  }
  if (!/IntersectionObserver/.test(qualityCode) || !/getElementById\('audio-output-panel'\)/.test(qualityCode)) {
    fail('the settings section must trigger the lazy load on first reveal (it starts inside an inactive tab)');
  }
  const storesText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  if (!/var audioOutputDevicesLoaded = false;/.test(storesText) || !/var audioOutputDeviceChangeBound = false;/.test(storesText)) {
    fail('the lazy-load flags must start false in the shared store');
  }
  console.log('[OK] Audio output workflow opens as a dedicated wiring panel, leaves settings compact, and enumerates devices only on first reveal.');
}

function checkVolumeWheelStepGuard() {
  logStep('Volume wheel step guard');
  const audioText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '08-audio-graph-controls.js'), 'utf8');
  if (!/function adjustVolumeByWheel/.test(audioText) || !/var step = 0\.01;/.test(audioText)) {
    fail('volume control mouse wheel must adjust exactly 1 percent per wheel event');
  }
  console.log('[OK] Volume wheel step is 1%.');
}

function checkNonCurrentAudioPrefetchGuard() {
  logStep('Non-current audio prefetch guard');
  const beatPrefetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  if (!/QUEUE_BEAT_AUDIO_PREFETCH_ENABLED\s*=\s*false/.test(beatPrefetchText)) {
    fail('queue beat prefetch must not request non-current song audio URLs by default');
  }
  if (!/function scheduleQueueBeatPrefetch[\s\S]{0,140}if \(!QUEUE_BEAT_AUDIO_PREFETCH_ENABLED\) return;/.test(beatPrefetchText)) {
    fail('scheduleQueueBeatPrefetch must return before touching non-current audio URL prefetch work');
  }
  if (!/async function runQueueBeatPrefetch[\s\S]{0,120}if \(!QUEUE_BEAT_AUDIO_PREFETCH_ENABLED\) return;/.test(beatPrefetchText)) {
    fail('runQueueBeatPrefetch must also be guarded when an old timer fires');
  }
  console.log('[OK] Non-current audio URL prefetch stays disabled by default.');
}

function checkCuefieldAutoMixGuard() {
  logStep('Cuefield AutoMix integration guard');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const desktopText = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const coreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '16-cuefield-automix-core.js'), 'utf8');
  const timelineText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '17-cuefield-timeline-executor.js'), 'utf8');
  const integrationText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '18-cuefield-automix-integration.js'), 'utf8');
  const adapterText = fs.readFileSync(path.join(appRoot, 'cuefield', 'adapter-mineradio.js'), 'utf8');
  const bridgeText = fs.readFileSync(path.join(appRoot, 'cuefield', 'mineradio-bridge.js'), 'utf8');
  const recipeText = fs.readFileSync(path.join(appRoot, 'cuefield', 'recipe-planner.js'), 'utf8');
  const beatPrefetchText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js'), 'utf8');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const beatCameraText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '01-scene', '02-beat-camera-runtime.js'), 'utf8');
  const audioGraphText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '08-audio-graph-controls.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const progressText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  if (!packageJson.build.files.includes('cuefield/**/*')) {
    fail('Cuefield runtime files must be included in the package');
  }
  // 开关已从控制栏图标按钮搬进 DIY 面板的"实验功能"分组（与完整桌面模式同处），所以这里钉的是
  // 面板内那个 fx-toggle 的 id，而不是已经不存在的 transport 按钮。
  // The switch moved off the transport bar into the DIY panel's "实验功能" group (next to full
  // desktop mode), so pin that fx-toggle id rather than the transport button that no longer exists.
  if (!/16-cuefield-automix-core\.js/.test(loaderText) || !/17-cuefield-timeline-executor\.js/.test(loaderText) || !/18-cuefield-automix-integration\.js/.test(loaderText) || !/id="t-cuefieldAutoMix"/.test(htmlText) || !/id="cuefield-feedback"/.test(htmlText) || !/#t-cuefieldAutoMix\.cuefield-automix-ready/.test(cssText) || !/id="t-cuefieldAutoMix"/.test(htmlText)) {
    fail('Cuefield AutoMix needs loaded runtime modules, a default-off DIY panel control, and local feedback UI');
  }
  // 分组登记必须在控制台布局里，否则面板里点不到它。
  // The group registration must exist in the console layout, otherwise the panel cannot reach it.
  const cuefieldConsoleText = fs.readFileSync(
    path.join(appRoot, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8'
  );
  // 按分组切片再判断，固定的 {0,400} 窗口会被组内注释长度顶穿。
  // Slice the group out before testing: a fixed {0,400} window gets overrun by the group's comments.
  const experimentalGroup = (cuefieldConsoleText.split("key: 'experimental'")[1] || '').split('] }')[0] || '';
  if (!/fxConsoleItem\('t-cuefieldAutoMix'/.test(experimentalGroup)) {
    fail('Cuefield AutoMix must be listed in the DIY console experimental group so it is reachable from the panel');
  }
  if (/id="cuefield-automix-btn"/.test(htmlText) || /#cuefield-automix-btn/.test(cssText)) {
    fail('the transport-bar Cuefield AutoMix button must stay removed now that the switch lives in the DIY panel');
  }
  // 上面钉的是静态资源里"按钮必须保持移除"。但仓库里另有两处**休眠**判据曾经反过来要求它存在：
  // Electron 冒烟 `tests/cuefield-electron-smoke.js` 与实时 QA 脚本 `runtimeQaScript()`。两者从按钮
  // 被移除那天起就一直是坏的，却没人发现——冒烟没有任何 npm 脚本或工作流引用，实时 QA 只在
  // `--electron` 模式下跑。两处已改为断言"按钮不在"，并在这里钉住两端，防止那种写法再长回来。
  // The line above pins the removal in static assets. Two DORMANT checks used to demand the button's
  // existence instead (the Electron smoke and the live QA script) and had been broken since the day
  // it was removed, because neither runs in CI. Both now assert absence; this pins that in turn.
  const cuefieldSmokeText = fs.readFileSync(path.join(appRoot, 'tests', 'cuefield-electron-smoke.js'), 'utf8');
  // 拆成两段拼接：这样这条守卫不会在自己的源码里匹配到自己写的字面量。
  // Split the needles so this guard cannot match its own literals in this file.
  const removedButtonDemands = ['Cuefield AutoMix ' + 'button missing', 'button: ' + '!!button'];
  if (!/cuefield-automix-btn/.test(cuefieldSmokeText) || !/buttonRemoved:/.test(cuefieldSmokeText)) {
    fail('tests/cuefield-electron-smoke.js must keep asserting the removed transport button is absent');
  }
  if (removedButtonDemands.some((needle) => cuefieldSmokeText.includes(needle))) {
    fail('tests/cuefield-electron-smoke.js must not require the removed cuefield-automix-btn again');
  }
  if (removedButtonDemands.some((needle) => fs.readFileSync(__filename, 'utf8').includes(needle))) {
    fail('runtimeQaScript() must not require the removed cuefield-automix-btn again');
  }
  if (!/var cuefieldAutoMixEnabled = false/.test(integrationText) || !/CUEFIELD_AUTOMIX_STORE_KEY/.test(integrationText) || !/if \(!cuefieldAutoMixEnabled \|\| !audio/.test(integrationText) || !/function toggleCuefieldAutoMix/.test(integrationText)) {
    fail('Cuefield AutoMix must be opt-in and must not prepare while disabled');
  }
  if (!/function createCuefieldAutoMix/.test(coreText) || !/function buildCuefieldTimelineExecution/.test(timelineText) || !/planCuefieldTransitionFromCache/.test(serverText) || !/pn === '\/api\/cuefield\/transition'/.test(serverText) || !/pn === '\/api\/cuefield\/feedback'/.test(serverText)) {
    fail('Cuefield planner, timeline executor, and local server endpoints are incomplete');
  }
  if (!/MINERADIO_BEAT_COMBOS/.test(adapterText) || !/raw\[7\]/.test(adapterText) || !/flags & 1/.test(adapterText) || !/flags & 2/.test(adapterText) || !/flags & 4/.test(adapterText) || /raw\[8\][^\n]{0,80}downbeat|raw\[8\][^\n]{0,80}>=\s*7/.test(adapterText)) {
    fail('Cuefield must decode packed comboIdx and flags independently so ordinary camera/pulse flags cannot become false downbeats');
  }
  if (!/chooseTransitionWindow/.test(bridgeText) || !/buildStructureMap/.test(bridgeText) || !/normalizeRecentRecipes/.test(bridgeText) || !/resolveListeningFloor/.test(bridgeText) || !/safety-long-blend/.test(recipeText) || !/end-of-track-crossfade/.test(bridgeText)) {
    fail('Cuefield must keep structure-aware window selection, recipe cooldown, listening floors, and bounded safety/end-of-track fallbacks');
  }
  if (!/cuefieldLyricTextForSong/.test(integrationText) || !/fromLrc:\s*lyricPair\[0\]/.test(integrationText) || !/toLrc:\s*lyricPair\[1\]/.test(integrationText) || !/allowWeak:\s*false/.test(integrationText) || !/allowSafetyFallback:\s*true/.test(integrationText) || !/allowLiveEndCrossfadeFallback:\s*true/.test(integrationText)) {
    fail('Cuefield must consume the existing lyric cache, reject weak beatmixes, and retain explicit bounded safety fallbacks');
  }
  if (!/var provider = songProviderKey\(song\)/.test(beatPrefetchText) || !/return provider \+ ':' \+ id/.test(beatPrefetchText) || !/resolveAlbumGaplessPlaybackData\(song\)/.test(beatPrefetchText)) {
    fail('Cuefield beatmaps must use provider-aware keys and resolve the same provider playback path as the real player');
  }
  if (!/CUEFIELD_FEEDBACK_FILE/.test(desktopText) || !/appendCuefieldFeedback/.test(serverText) || !/readCuefieldFeedbackStats/.test(serverText) || /feedback-remote|CUEFIELD_FEEDBACK_REMOTE|https?:\/\/.*cuefield/i.test(serverText + integrationText)) {
    fail('Cuefield feedback must remain local and must not wire a remote feedback service');
  }
  if (!/albumGaplessHandoff:\s*true/.test(integrationText) || !/resetCuefieldAutoMix\(opts\.cuefieldAutoMix/.test(playbackText) || !/scheduleCuefieldAutoMixPrepare\(token, idx/.test(playbackText) || !/audio\.onended = function \(\) \{[\s\S]{0,160}cuefieldAutoMixExecuting/.test(playbackText) || !/tickCuefieldAutoMix/.test(progressText) || !/resetCuefieldAutoMix\('manual-seek'\)/.test(progressText)) {
    fail('Cuefield must hand off through the proven player path and reset for manual seeking');
  }
  if (!/function claimCuefieldPreparedAudioForPlayback/.test(integrationText) || !/media === audio[\s\S]{0,100}claimCuefieldPreparedAudioForPlayback\(media\);[\s\S]{0,40}return;/.test(integrationText) || !/audio = opts\.preloadedAudio;[\s\S]{0,180}claimCuefieldPreparedAudioForPlayback\(audio\)/.test(playbackText) || !/preserveExecution:\s*!!opts\.cuefieldAutoMix/.test(playbackText)) {
    fail('Cuefield must transfer preloaded B-deck ownership before preparing another track so it cannot pause active playback');
  }
  if (!/function buildEqualPowerCurve/.test(timelineText) || !/function cuefieldVolumeCurveValue/.test(integrationText) || !/equal-power-in/.test(integrationText) || !/equal-power-out/.test(integrationText) || !/function cuefieldApplyGraphEcho/.test(integrationText) || !/function cuefieldApplyGraphDuck/.test(integrationText) || !/function cuefieldApplyTimelineAction/.test(integrationText) || !/volume-only-fallback/.test(integrationText)) {
    fail('Cuefield must execute equal-power A/B volume curves and safely downgrade advanced graph actions');
  }
  if (!/await cuefieldApplyTimelineAction\(action, pending, nextMedia, context\)/.test(integrationText) || !/handoffDelayMs > elapsedMs[\s\S]{0,120}await cuefieldDelay/.test(integrationText) || !/nextMedia\.paused \|\| nextMedia\.ended/.test(integrationText) || !/var handoffReady = await runCuefieldTimeline\(pending, nextMedia, transitionContext\);[\s\S]{0,150}if \(!handoffReady \|\| !cuefieldTransitionStillCurrent\(pending, transitionContext\)\)/.test(integrationText)) {
    fail('Cuefield ownership handoff must await the cancellable action timeline and a live incoming deck');
  }
  if (!/var cuefieldTransitionGeneration = 0/.test(integrationText) || !/cuefieldTransitionGeneration\+\+;[\s\S]{0,120}clearCuefieldTimelineTimers\(\)/.test(integrationText) || !/function cuefieldDelay\(delayMs, generation\)/.test(integrationText) || !/context\.generation !== cuefieldTransitionGeneration/.test(integrationText) || !/audio !== context\.outgoingMedia/.test(integrationText)) {
    fail('Cuefield reset, seek, and pause must invalidate delayed transitions before they can wake and rewrite current audio gain');
  }
  if (!/var cuefieldMediaFadeTimer = 0/.test(integrationText) || !/cuefieldMediaFadeTimer = setInterval\(function \(\) \{[\s\S]{0,100}applyStep\(\)/.test(integrationText) || !/context\.outgoingMedia && context\.outgoingMedia\.currentTime/.test(integrationText) || !/if \(cuefieldMediaFadeTimer\) clearInterval\(cuefieldMediaFadeTimer\)/.test(integrationText)) {
    fail('Cuefield gain must follow the outgoing media clock and keep a timer watchdog when visual RAF is throttled');
  }
  if (!/function recoverCuefieldAutoMixEndedOutgoing/.test(integrationText) || !/__mineradioCuefieldEndedRecoveryToken/.test(playbackText)) {
    fail('Cuefield must resume ordinary queue advance if its outgoing deck ends before a failed handoff settles');
  }
  if (!/__mineradioPreparedGraphFailed/.test(integrationText) || !/The first element is permanently tied/.test(integrationText)) {
    fail('Cuefield must rebuild a clean fallback media element after a partial WebAudio graph failure');
  }
  if (!/var cuefieldActiveTransitionContext = null/.test(integrationText) || !/shouldRestoreOutgoing[\s\S]{0,520}rampAudioOutputGain\(targetVolume, 120\)/.test(integrationText) || !/async function runCuefieldNormalFallback\(\)/.test(integrationText) || !/audio !== nextMedia && audio !== transitionContext\.outgoingMedia/.test(integrationText)) {
    fail('Cuefield disable/cancel must restore its outgoing deck and pre-adoption handoff failures must use normal playback fallback');
  }
  if (!/function cuefieldAutoMixBlockedByAlbumGapless\(index\)[\s\S]{0,120}albumGaplessQueueCanAdvance\(index\)/.test(integrationText) || !/if \(cuefieldAutoMixBlockedByAlbumGapless\(currentIndex\)\) return false;/.test(integrationText) || !/cuefieldAutoMixBlockedByAlbumGapless\(pending\.currentIndex\)[\s\S]{0,180}album-gapless-priority/.test(integrationText) || !/function startAlbumGaplessMix\(preload, reason, remaining\)[\s\S]{0,360}cuefieldAutoMixExecuting[^\n]*return false;/.test(playbackText)) {
    fail('Cuefield AutoMix and album gapless must stay mutually exclusive so only one prepared B-deck can transition');
  }
  if (!/albumGaplessMixed:\s*true/.test(integrationText) || !/preserveGain:\s*albumGaplessMixed/.test(playbackText) || !/preserveGain:\s*!!opts\.preserveGain/.test(controlsText) || !/else if \(!opts\.preserveGain\) restorePlaybackGain\(\)/.test(controlsText)) {
    fail('Cuefield mixed handoff must preserve the completed incoming gain through the shared playback-start path');
  }
  if (!/CUEFIELD_AUTOMIX_NORMAL_START_SETTLE_MS = 4200/.test(integrationText) || !/CUEFIELD_AUTOMIX_HANDOFF_SETTLE_MS = 5200/.test(integrationText) || !/function cuefieldAutoMixVisualTransitionBusy/.test(integrationText) || !/cuefieldAutoMixVisualTransitionBusy\(\)[\s\S]{0,120}scheduleCuefieldAutoMixPrepare\(token, currentIndex, 900/.test(integrationText) || !/cuefieldAutoMixPostSwitchDelay\(!!opts\.cuefieldAutoMix\)/.test(playbackText)) {
    fail('Cuefield background analysis must wait for cover and particle transition work to settle');
  }
  if (!/function contextStillCurrent\(\)/.test(integrationText) || !/var analysisToken = beatMapToken/.test(integrationText) || !/descriptor = await cuefieldAutoMixAudioDescriptor\(song\);[\s\S]{0,220}analysisToken !== beatMapToken[\s\S]{0,120}cuefieldAutoMixVisualTransitionBusy\(\)/.test(integrationText) || !/analyzeAudioBeats\(descriptor\.proxyUrl, null, analysisToken/.test(integrationText)) {
    fail('Cuefield beat analysis must revalidate track ownership and visual-idle state after resolving the next audio URL');
  }
  if (!/audioSourceMedia = null/.test(coreStoreText) || !/function cuefieldCreatePreparedAudioGraph/.test(integrationText) || !/createMediaElementSource\(media\)/.test(integrationText) || !/__mineradioPreparedAudioGraph/.test(audioGraphText) || !/preparedGraph\.adopted = true/.test(audioGraphText) || !/audioSourceMedia = audio/.test(audioGraphText)) {
    fail('Cuefield must prepare B in the same AudioContext and adopt its existing source/analyser/gain graph without rebinding mid-playback');
  }
  if (!/function resetAudioVisualState\(options\)/.test(beatCameraText) || !/preserveEnvelope/.test(beatCameraText) || !/function resetBeatCameraSync\(t, options\)/.test(beatCameraText) || !/preserveMomentum/.test(beatCameraText) || !/resetAudioVisualState\(\{ preserveEnvelope: albumGaplessMixed \}\)/.test(playbackText) || !/preserveMomentum: albumGaplessMixed/.test(playbackText) || !/syncBeatMapPlaybackCursor\(audio \? audio\.currentTime : 0, albumGaplessMixed\)/.test(playbackText)) {
    fail('mixed handoff must preserve the live particle envelope and camera momentum while aligning the new beat-map cursor');
  }
  if (!/var cuefieldMediaFadeSerial = 0/.test(integrationText) || !/function cancelCuefieldMediaFade/.test(integrationText) || !/function claimCuefieldPreparedAudioForPlayback\(media\)[\s\S]{0,180}cancelCuefieldMediaFade\(\)/.test(integrationText) || !/serial !== cuefieldMediaFadeSerial/.test(integrationText) || !/await applyAudioOutputDevice\(nextMedia\)/.test(integrationText)) {
    fail('Cuefield must cancel the temporary B-deck fade and apply the selected output device before ownership handoff');
  }
  console.log('[OK] Cuefield AutoMix is opt-in, packages with the app, uses local feedback, and reuses safe handoff controls.');
}

function checkAlbumDetailGaplessGuard() {
  logStep('Album detail and explicit gapless guard');
  const htmlText = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const cssText = readAllCssFiles();
  const detailText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js'), 'utf8');
  const coreStoreText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '00-core-stores.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const snapshotText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '09-queue-snapshot-autoplay.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const spotifyText = fs.readFileSync(path.join(appRoot, 'server', 'spotify-api.js'), 'utf8');
  if (!/thumb-cover[\s\S]{0,180}openTrackDetailModal\('album'\)/.test(htmlText) || !/control-cover[\s\S]{0,260}openTrackDetailModal\('album'\)/.test(htmlText)) {
    fail('album detail must be reachable from both current cover entry points');
  }
  if (!/\.detail-action-toggle/.test(cssText) || !/\.control-cover:focus-visible/.test(cssText)) {
    fail('album detail entry and gapless toggle must have visible UI affordances');
  }
  if (!/function albumDetailUrlForSong/.test(detailText) || !/function renderAlbumSongList/.test(detailText) || !/function toggleAlbumGaplessPlayback/.test(detailText) || !/function playAlbumDetailSong/.test(detailText)) {
    fail('track detail module must render album songs, play album queues, and expose the gapless toggle');
  }
  if (!/setAlbumGaplessPlaybackContext\(detailAlbumGaplessEnabled, detailAlbumContext/.test(detailText) || !/__albumGaplessKey/.test(detailText) || !/detailAlbumGaplessEnabled\s*=\s*true/.test(detailText)) {
    fail('album detail playback must tag album queues and pass the gapless context into playback');
  }
  if (!/handleNeteaseAlbumDetail/.test(serverText) || !/pn === '\/api\/album\/detail'/.test(serverText) || !/handleQQAlbumDetail/.test(serverText) || !/pn === '\/api\/qq\/album\/detail'/.test(serverText) || !/pn === '\/api\/spotify\/album\/detail'/.test(serverText)) {
    fail('server.js must expose Netease, QQ, and Spotify album detail endpoints');
  }
  if (!/async function handleSpotifyAlbumDetail/.test(spotifyText) || !/\/albums\/' \+ encodeURIComponent\(id\)/.test(spotifyText)) {
    fail('Spotify bridge must expose album detail tracks as metadata source');
  }
  if (!/albumGaplessState/.test(coreStoreText) || !/defaultEnabled:\s*true/.test(coreStoreText) || !/function albumGaplessDefaultEnabledForContext/.test(playbackText) || !/function setAlbumGaplessPlaybackContext/.test(playbackText) || !/function scheduleAlbumGaplessPreloadForCurrent/.test(playbackText) || !/function resolveAlbumGaplessPlaybackData/.test(playbackText) || !/albumGaplessHandoff/.test(playbackText) || !/playAlbumGaplessNextOnEnded/.test(playbackText)) {
    fail('album gapless playback must keep explicit state, preheat next audio, and use a sequential on-ended fallback');
  }
  if (!/ALBUM_GAPLESS_PREROLL_SECONDS\s*=\s*8\.5/.test(playbackText) || !/ALBUM_GAPLESS_MUTED_PREROLL_SECONDS\s*=\s*1\.05/.test(playbackText) || !/ALBUM_GAPLESS_MIX_SECONDS\s*=\s*0\.72/.test(playbackText) || !/ALBUM_GAPLESS_NEXT_ENTRY_FLOOR\s*=\s*0\.90/.test(playbackText) || !/ALBUM_GAPLESS_NEXT_ATTACK_MS\s*=\s*56/.test(playbackText) || !/ALBUM_GAPLESS_ADOPT_SLEW_MS\s*=\s*180/.test(playbackText) || !/ALBUM_GAPLESS_GAIN_STEP_MS\s*=\s*8/.test(playbackText) || !/ALBUM_GAPLESS_BOUNDARY_RELEASE_SECONDS\s*=\s*ALBUM_GAPLESS_MIX_SECONDS/.test(playbackText) || !/ALBUM_GAPLESS_FAST_SILENCE_HOLD_MS/.test(playbackText) || !/ALBUM_GAPLESS_DIRECT_SILENCE_RMS/.test(playbackText) || !/ALBUM_GAPLESS_RESIDUAL_FREQ_AVG/.test(playbackText) || !/albumGaplessTailFreqData/.test(playbackText) || !/function albumGaplessDirectTailSample/.test(playbackText) || !/function startAlbumGaplessPreroll/.test(playbackText) || !/function startAlbumGaplessMix/.test(playbackText) || !/runAlbumGaplessBalancedCrossfade/.test(playbackText) || !/albumGaplessTailSilenceProbe/.test(playbackText) || !/residualTail/.test(playbackText) || !/!tailProbe\.residualTail/.test(playbackText) || !/tail-direct-silence-crossmix/.test(playbackText) || !/boundary-crossmix-reset/.test(playbackText)) {
    fail('album gapless playback must scan tail waveform energy, skip long silent tails, and use balanced crossmix at the cue point');
  }
  if (!/function albumGaplessEqualPowerGains\(progress, outgoingStart, incomingTarget\)/.test(playbackText) || !/outgoing:\s*clampRange\(\(Number\(outgoingStart\) \|\| 0\) \* Math\.cos\(theta\)/.test(playbackText) || !/incoming:\s*clampRange\(\(Number\(incomingTarget\) \|\| 0\) \* Math\.sin\(theta\)/.test(playbackText) || !/function albumGaplessEqualPowerEntryProgress\(elapsedMs, durationMs\)/.test(playbackText) || !/Math\.asin\(ALBUM_GAPLESS_NEXT_ENTRY_FLOOR\)/.test(playbackText) || !/albumGaplessEqualPowerEntryProgress\(elapsedMs, durationMs\)/.test(playbackText) || !/media\.volume = 0;[\s\S]{0,260}preload\.fadeCompleted = false/.test(playbackText) || /media\.volume\s*=\s*ALBUM_GAPLESS_NEXT_ENTRY_FLOOR/.test(playbackText)) {
    fail('album gapless must keep the 0.90/56ms entry strength inside one paired equal-power curve instead of stacking it over a full-volume outgoing deck');
  }
  if (!/Promise\.resolve\(playResult\)\.then\(function \(\)/.test(playbackText) || !/return runAlbumGaplessBalancedCrossfade\(preload, mixMs\)/.test(playbackText) || !/\.then\(function \(completed\)/.test(playbackText) || !/if \(!completed\)/.test(playbackText) || !/preload\.fadeCompleted[\s\S]{0,900}startAlbumGaplessHandoff/.test(playbackText) || !/preload\.fadeResolve[\s\S]{0,180}resolveFade\(false\)/.test(playbackText)) {
    fail('album gapless must await media play and the completed fade state before ownership handoff, and cancellation must resolve false');
  }
  if (!/function disposeAlbumGaplessPreload\(preload\)/.test(playbackText) || !/await applyAudioOutputDevice\(media\);[\s\S]{0,420}serial !== albumGaplessState\.serial[\s\S]{0,320}disposeAlbumGaplessPreload\(\{ media: media \}\)/.test(playbackText) || !/if \(albumGaplessState\.preload === preload\) clearAlbumGaplessPreload\('album-gapless-mix-stale'\);[\s\S]{0,80}else disposeAlbumGaplessPreload\(preload\)/.test(playbackText)) {
    fail('stale album preload promises must revalidate after await and may only dispose the media object they own');
  }
  if (!/fadeWatchdogTimer = setInterval\(function \(\) \{[\s\S]{0,100}applyStep\(performance\.now\(\)\)/.test(playbackText) || !/function scheduleAlbumGaplessNormalFallback\(\)/.test(playbackText) || !/audio !== preload\.media && audio !== handoffPreviousAudio/.test(playbackText) || !/albumGaplessState\.preload\.mixStarted[\s\S]{0,160}restoreAlbumGaplessOutgoingIfCurrent/.test(playbackText)) {
    fail('album gapless must keep its gain curve alive off-RAF, restore on disable, and fall back whether B was adopted or not');
  }
  if (!/function playbackAttemptStillCurrent\(media, token\)/.test(controlsText) || !/expectedMedia: opts\.expectedMedia \|\| audio/.test(controlsText) || !/expectedToken: opts\.expectedToken == null \? trackSwitchToken/.test(controlsText) || !/expectedMedia: playbackMedia, expectedToken: token/.test(playbackText)) {
    fail('stale play promises must be scoped to the media element and track token that started them');
  }
  if (!/var albumGaplessAdoptedGain = 0/.test(playbackText) || !/albumGaplessAdoptedGain = albumGaplessMixed[\s\S]{0,100}Number\(audio\.volume\)/.test(playbackText) || !/setAudioOutputGainImmediate\(albumGaplessMixed \? albumGaplessAdoptedGain : audioSilentFloor\(\)\)/.test(playbackText) || !/preserveGain:\s*albumGaplessMixed/.test(playbackText) || !/rampAudioOutputGain\(targetVolume, ALBUM_GAPLESS_ADOPT_SLEW_MS\)/.test(playbackText) || !/preserveGain:\s*!!opts\.preserveGain/.test(controlsText) || !/else if \(!opts\.preserveGain\) restorePlaybackGain\(\)/.test(controlsText)) {
    fail('mixed album handoff must adopt, preserve, and gently settle the incoming gain without a restorePlaybackGain jump');
  }
  if (!/preloadedAudio/.test(playbackText) || !/preloadedProxyAudioUrl/.test(playbackText) || !/albumGaplessMixed/.test(playbackText) || !/skipShuffleOrder: true/.test(playbackText) || !/searchAlternatePlatformSong\(nextSong\)/.test(playbackText) || !/playQueue\[preload\.index\] = hydrateCustomCover\(preload\.song\)/.test(playbackText)) {
    fail('album gapless handoff must reuse preheated audio, pre-resolve metadata-source fallback, and force album order instead of shuffle order');
  }
  const coverText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '02-visual', '15-ripples-cover-depth.js'), 'utf8');
  if (!/albumGaplessSameAlbumCover/.test(playbackText) || !/noCoverTransition:\s*sameAlbumCoverSwitch/.test(playbackText) || !/opts\.noCoverTransition/.test(coverText)) {
    fail('same-album same-cover transitions must suppress cover particle/color transition effects');
  }
  if (!/albumMid/.test(snapshotText) || !/albumUri/.test(snapshotText)) {
    fail('playback snapshots must preserve album identifiers for album detail entry after restore');
  }
  console.log('[OK] Album detail opens from covers, loads provider album tracks, and gapless playback is explicit/preheated/sequential.');
}

function checkShuffleQueueOrderGuard() {
  logStep('Shuffle queue order guard');
  const controlsText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');
  const playbackText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js'), 'utf8');
  if (!/function reorderQueueForShufflePlaybackOrder/.test(controlsText) || !/shuffleArrayInPlace/.test(controlsText) || !/playQueue\.length = 0;[\s\S]{0,100}playQueue\.push\(currentSong\)/.test(controlsText)) {
    fail('shuffle mode must reorder the visible queue into current song plus randomized upcoming playback order');
  }
  const reorderBlock = controlsText.slice(controlsText.indexOf('function reorderQueueForShufflePlaybackOrder'), controlsText.indexOf('function nextTrack'));
  if (/playQueue\s*=/.test(reorderBlock)) {
    fail('shuffle reorder must preserve the queue array reference used by progressive playlist hydration');
  }
  if (/playMode === 'shuffle'\)\s*currentIdx\s*=\s*Math\.floor\(Math\.random\(\)\s*\*\s*playQueue\.length\)/.test(controlsText)) {
    fail('shuffle nextTrack must advance through the randomized queue instead of jumping to a hidden random index');
  }
  if (!/playMode === 'shuffle'\)\s*currentIdx = currentIdx < 0 \? 0 : \(currentIdx \+ 1\) % playQueue\.length/.test(controlsText) || !/opts\.skipShuffleOrder = true/.test(controlsText)) {
    fail('shuffle next/previous controls must walk the randomized queue order without reshuffling every button press');
  }
  if (!/playMode === 'shuffle'[\s\S]{0,220}reorderQueueForShufflePlaybackOrder\(idx/.test(playbackText)) {
    fail('playQueueAt must normalize a selected track into the front of the randomized queue while shuffle is enabled');
  }
  if (!/playMode === 'shuffle' && prevMode !== 'shuffle'[\s\S]{0,120}reorderQueueForShufflePlaybackOrder\(currentIdx/.test(controlsText)) {
    fail('entering shuffle mode must immediately reorder the visible queue into playback order');
  }
  console.log('[OK] Shuffle mode keeps the visible queue aligned with the actual playback order.');
}

async function checkLargePlaylistVirtualizationGuard() {
  logStep('Large playlist virtualization and progressive queue guard');
  const detailText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  const loaderText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '03-podcast-playlist-loaders.js'), 'utf8');
  const shelfText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '01-manager-core.js'), 'utf8');
  const shelfContentText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '04-shelf', '03-content-list-manager.js'), 'utf8');
  const qishuiText = fs.readFileSync(path.join(appRoot, 'server', 'qishui-api.js'), 'utf8');
  const serverText = fs.readFileSync(path.join(appRoot, 'server', 'server.js'), 'utf8');
  const cssText = readAllCssFiles();

  if (!/fetchNeteaseUserPlaylistsPage/.test(serverText) || !/nextOffset/.test(serverText) || !/hasMore/.test(serverText)) {
    fail('Netease playlist catalog must expose real offset pagination');
  }
  if (!/neteasePlaylistTrackIndexCache/.test(serverText) || !/fetchNeteasePlaylistTrackIndex/.test(serverText) || !/NETEASE_TRACK_STREAM_PAGE_SIZE/.test(serverText)) {
    fail('Netease large-playlist pages must reuse one bounded track-id index instead of reparsing the whole playlist per page');
  }
  if (/targetCount\s*=\s*Math\.min\(240/.test(qishuiText) || !/qishuiWebPlaylistCursorCache/.test(qishuiText)) {
    fail('Qishui playlist pagination must not stop at 240 and must reuse cursor state');
  }
  if (!/function rebindShelfCard/.test(shelfText) || !/function rebindContentRow/.test(shelfContentText)) {
    fail('3D shelf cards and detail rows must reuse their GPU-backed objects');
  }
  const detailScrollerStart = detailText.indexOf('function bindPlaylistPanelDetailScroller');
  const detailScrollerEnd = detailText.indexOf('async function loadMorePlaylistPanelDetailTracks', detailScrollerStart);
  if (detailScrollerStart < 0 || detailScrollerEnd < 0 || /addEventListener\(['"]scroll/.test(detailText.slice(detailScrollerStart, detailScrollerEnd))) {
    fail('expanded playlist detail must share the outer playlist-panel scroll axis');
  }
  if (!/#playlist-panel \.pl-inline-detail[\s\S]*?overflow:\s*visible/.test(cssText) || !/#playlist-panel \.pl-card\.expanded::before/.test(cssText)) {
    fail('continuous expanded playlist detail and its highlighted group styling are missing');
  }
  // overflow:visible 的容器不能有固定高度：高度一旦小于内容，最后几首歌会直接压到下一个歌单卡片上。
  // 逐条解析声明而不是用正则，避免 `\s*` 回溯把 `height: auto` 误判成固定值。
  const inlineDetailRules = Array.from(cssText.matchAll(/#playlist-panel\s+\.pl-inline-detail\s*\{([^}]*)\}/g));
  const inlineDetailCss = inlineDetailRules.length ? inlineDetailRules[inlineDetailRules.length - 1][1] : '';
  const inlineDetailDecls = {};
  inlineDetailCss.split(';').forEach((decl) => {
    const colon = decl.indexOf(':');
    if (colon < 0) return;
    inlineDetailDecls[decl.slice(0, colon).trim().toLowerCase()] = decl.slice(colon + 1).trim().toLowerCase();
  });
  if (inlineDetailDecls.height !== 'auto') {
    fail(`expanded playlist detail must size itself from content (height:auto), got: ${inlineDetailDecls.height || '(none)'}`);
  }
  if (/pl-inline-detail[\s\S]{0,200}?style="height:/.test(detailText)) {
    fail('expanded playlist detail must not be pinned to a computed pixel height inline');
  }
  // 2026-10-26：展开详情的摘要头整块删掉了（未展开的卡片上已经有封面、歌名和曲目数，
  // 再显示一遍等于同一个信息说两次），改由按钮行打头、分页条收尾。
  // 所以这里从「摘要必须 sticky」改成反向断言：摘要头不许回来，分页条必须在。
  // The summary header is gone by design — the collapsed card already carries that information —
  // so this asserts it stays gone and that the pager exists instead.
  if (/#playlist-panel\s+\.pl-detail-head\s*,?\s*\{/.test(cssText) || /\.pl-detail-sticky\s*\{/.test(cssText)) {
    fail('expanded playlist detail must not bring back the duplicated summary header');
  }
  if (!/\.pl-detail-pager\s*\{/.test(cssText) || !/\.pl-pager-btn\s*\{/.test(cssText)) {
    fail('expanded playlist detail must render a pager instead of an inner scroll');
  }
  const detailListRules = Array.from(cssText.matchAll(/#playlist-panel\s+\.pl-detail-list\s*\{([^}]*)\}/g));
  const detailListCss = detailListRules.length ? detailListRules[detailListRules.length - 1][1] : '';
  if (!/\boverflow:\s*visible\b/.test(detailListCss) || /\boverflow-y:\s*(?:auto|scroll)\b/.test(detailListCss)) {
    fail('expanded playlist tracks must keep the single outer scroll axis');
  }
  const shelfSync = shelfText.slice(shelfText.indexOf('function syncRenderedWindow'), shelfText.indexOf('function rebuild'));
  const contentSync = shelfContentText.slice(shelfContentText.indexOf('function syncRenderedRows'), shelfContentText.indexOf('return {', shelfContentText.indexOf('function syncRenderedRows')));
  if (/disposeRenderedCards\(\);\s*renderedStart\s*=\s*start/.test(shelfSync) || /disposeRows\(\);\s*renderedStart\s*=\s*start/.test(contentSync)) {
    fail('3D virtual windows must not dispose the whole GPU pool while scrolling');
  }

  const queueWindowStart = detailText.indexOf('function queuePanelVirtualWindow');
  const queueWindowEnd = detailText.indexOf('function scheduleQueuePanelVirtualRender', queueWindowStart);
  if (queueWindowStart < 0 || queueWindowEnd < 0) fail('queue virtual window helper missing');
  const queueWindowSandbox = { QUEUE_VIRTUAL_ROW_STEP: 62, QUEUE_VIRTUAL_OVERSCAN: 8, Math, Number };
  vm.runInNewContext(detailText.slice(queueWindowStart, queueWindowEnd), queueWindowSandbox, { filename: 'playlist-queue-window.js' });
  const queueWindow = queueWindowSandbox.queuePanelVirtualWindow(null, { clientHeight: 620, scrollTop: 62 * 9988 }, 10000, true, -1);
  if (queueWindow.end - queueWindow.start > 32 || queueWindow.start < 9950 || queueWindow.end !== 10000) {
    fail(`10k queue virtual window is too large or cannot reach the tail: ${JSON.stringify(queueWindow)}`);
  }

  const detailRowsStart = detailText.indexOf('function playlistPanelDetailPageOf');
  const detailRowsEnd = detailText.indexOf('var PLAYLIST_REORDER_STORE_KEY', detailRowsStart);
  if (detailRowsStart < 0 || detailRowsEnd < 0) fail('playlist detail page helper missing');
  // 行距与页容量都必须从实现里读，不能在这里另写一份：2026-10-25 的重叠 bug 就是常量（56）
  // 与真实行距（行 56 + gap 6）脱节造成的，守卫自己硬编码一份会永远看不见这种偏差。
  const perfStateText = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '00-state', '01-perf-render-state.js'), 'utf8');
  const rowStepMatch = perfStateText.match(/var PLAYLIST_DETAIL_ROW_STEP = (\d+);/);
  if (!rowStepMatch) fail('PLAYLIST_DETAIL_ROW_STEP constant missing from perf render state');
  const detailRowStep = Number(rowStepMatch[1]);
  if (!(detailRowStep >= 50 && detailRowStep <= 80)) {
    fail(`playlist detail row step must stay within one rendered row: ${detailRowStep}`);
  }
  const pageSizeMatch = perfStateText.match(/var PLAYLIST_DETAIL_PAGE_SIZE = (\d+);/);
  if (!pageSizeMatch) fail('PLAYLIST_DETAIL_PAGE_SIZE constant missing from perf render state');
  const detailPageSize = Number(pageSizeMatch[1]);
  if (!(detailPageSize >= 3 && detailPageSize <= 12)) {
    fail(`playlist detail page size must stay readable and fit the panel: ${detailPageSize}`);
  }
  const detailRowsSandbox = {
    playlistPanelDetailState: {
      loading: false,
      loadingMore: false,
      tracks: Array.from({ length: 10000 }, (_, index) => ({ id: index, name: 'Track ' + index, artist: 'Artist' })),
      total: 10000,
      hasMore: false,
      page: 0,
      error: '',
      message: ''
    },
    PLAYLIST_DETAIL_ROW_STEP: detailRowStep,
    PLAYLIST_DETAIL_VIRTUAL_OVERSCAN: 7,
    PLAYLIST_DETAIL_INITIAL_RENDER: 96,
    PLAYLIST_DETAIL_PAGE_SIZE: detailPageSize,
    window: { innerHeight: 900 },
    songCoverSrc: () => '',
    playlistDetailText: playlistDetailTextStub,
    normalizePlaylistProvider: provider => provider === 'mineradio' ? 'mineradio' : (['qq', 'kugou', 'qishui', 'spotify'].includes(provider) ? provider : 'netease'),
    escHtml: value => String(value == null ? '' : value),
    Math,
    Number,
    String
  };
  vm.runInNewContext(detailText.slice(detailRowsStart, detailRowsEnd), detailRowsSandbox, { filename: 'playlist-detail-rows.js' });
  // 分页取代了滚动虚拟窗口：10k 条的列表也只在 DOM 里放一页，翻页由页码而不是滚动位置驱动。
  // Paging replaced the scroll window: even a 10k-track playlist keeps exactly one page in the DOM.
  const pageOne = detailRowsSandbox.playlistPanelDetailRowsHtml({});
  const pageOneRows = Array.from(pageOne.matchAll(/data-pl-detail-row="(\d+)"/g), match => Number(match[1]));
  if (pageOneRows.length !== detailPageSize || pageOneRows[0] !== 0 || pageOneRows[pageOneRows.length - 1] !== detailPageSize - 1) {
    fail(`playlist detail page 1 must hold exactly ${detailPageSize} rows: ${JSON.stringify(pageOneRows.slice(0, 3))}…${pageOneRows[pageOneRows.length - 1]}`);
  }
  detailRowsSandbox.playlistPanelDetailState.page = 1;
  const pageTwoRows = Array.from(detailRowsSandbox.playlistPanelDetailRowsHtml({}).matchAll(/data-pl-detail-row="(\d+)"/g), match => Number(match[1]));
  if (pageTwoRows[0] !== detailPageSize || pageTwoRows.length !== detailPageSize) {
    fail(`playlist detail page 2 must start at row ${detailPageSize}: ${JSON.stringify(pageTwoRows.slice(0, 3))}`);
  }
  // 最后一页不足一整页时不能凭空补行，也不能越过 total。
  detailRowsSandbox.playlistPanelDetailState.tracks = detailRowsSandbox.playlistPanelDetailState.tracks.slice(0, detailPageSize + 2);
  detailRowsSandbox.playlistPanelDetailState.total = detailPageSize + 2;
  detailRowsSandbox.playlistPanelDetailState.page = 1;
  const tailRows = Array.from(detailRowsSandbox.playlistPanelDetailRowsHtml({}).matchAll(/data-pl-detail-row="(\d+)"/g), match => Number(match[1]));
  if (tailRows.length !== 2 || tailRows[0] !== detailPageSize) {
    fail(`playlist detail tail page must render only its remainder: ${JSON.stringify(tailRows)}`);
  }
  if (/pl-detail-virtual-spacer/.test(pageOne + pageTwoRows.join('') + tailRows.join(''))) {
    fail('playlist detail must not emit virtual spacers once it pages');
  }

  // 切片起点前移到平台切换器的状态声明：entries 构建现在要先分桶再取选中平台，
  // 那两个函数就在这段里。
  // The slice now starts at the provider-switcher state: entry building buckets by provider first.
  const catalogStart = detailText.indexOf('var PLAYLIST_ACTIVE_PROVIDER_KEY');
  const catalogEnd = detailText.indexOf('function playlistCatalogFooterHtml', catalogStart);
  if (catalogStart < 0 || catalogEnd < 0) fail('playlist catalog virtual entry helper missing');
  const catalogSandbox = {
    playlistCatalogRevision: 1,
    userPlaylists: Array.from({ length: 5000 }, (_, index) => ({ provider: 'netease', id: String(index + 1), name: 'Playlist ' + index })),
    playlistPanelDetailState: { key: '', loading: false, tracks: [], total: 0, page: 0, error: '' },
    normalizePlaylistProvider: provider => ['qq', 'kugou', 'qishui', 'spotify', 'mineradio'].includes(provider) ? provider : 'netease',
    playlistCardPriority: () => 1,
    // 详情高度估算走这里，catalog 场景下没有展开项，给一个纯函数的页信息即可。
    // Detail height estimation reaches for this; with nothing expanded a constant page is enough.
    playlistPanelDetailPageOf: () => ({ page: 0, pages: 1, total: 0 }),
    PLAYLIST_DETAIL_PAGE_SIZE: detailPageSize,
    PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT: 78,
    PLAYLIST_DETAIL_OUTER_FOOTER_HEIGHT: 34,
    PLAYLIST_DETAIL_ROW_STEP: detailRowStep,
    playlistPanelKey: (provider, id) => provider + ':' + id,
    playlistDetailText: playlistDetailTextStub,
    // 歌单搜索的过滤词与匹配函数在 01-playlist-panel-shell.js，切片从 02 开头取不到，
    // 这里给一份等价实现：切片里只用它比对歌单名。
    playlistSearchQuery: '',
    panelSearchHit: (text, query) => !query || String(text == null ? '' : text).toLowerCase().indexOf(query) >= 0,
    window: { innerHeight: 900 },
    Math,
    Number
  };
  vm.runInNewContext(detailText.slice(catalogStart, catalogEnd), catalogSandbox, { filename: 'playlist-catalog-window.js' });
  const catalogStarted = process.hrtime.bigint();
  const catalog = catalogSandbox.playlistPanelBuildVirtualEntries();
  const catalogMs = Number(process.hrtime.bigint() - catalogStarted) / 1e6;
  const visibleTop = Math.max(0, catalog.totalHeight - 620);
  const catalogWindowStart = catalogSandbox.playlistPanelOffsetIndex(catalog.offsets, Math.max(0, visibleTop - 760));
  const catalogWindowEnd = Math.min(catalog.entries.length, catalogSandbox.playlistPanelOffsetIndex(catalog.offsets, visibleTop + 620 + 760) + 1);
  // 平台切换器取代分组标题之后，台账里只剩卡片（原来每组多一条 31px 的标题行）。
  // With the switcher replacing group headers the ledger holds cards only — no 31px title rows.
  const labelEntries = catalog.entries.filter(entry => entry.type !== 'card').length;
  if (catalog.entries.length !== 5000 || labelEntries !== 0) {
    fail(`5k playlist catalog must page out as cards only: ${JSON.stringify({ entries: catalog.entries.length, extra: labelEntries })}`);
  }
  if (catalog.activeProvider !== 'netease' || !(catalog.availableProviders || []).length) {
    fail(`playlist catalog must resolve an active provider: ${JSON.stringify({ active: catalog.activeProvider, available: catalog.availableProviders })}`);
  }
  if (catalogWindowEnd - catalogWindowStart > 72 || catalogWindowEnd !== catalog.entries.length || catalogMs > 120) {
    fail(`5k playlist catalog virtualization missed its scale budget: ${JSON.stringify({ window: catalogWindowEnd - catalogWindowStart, end: catalogWindowEnd, ms: catalogMs })}`);
  }
  // 平台切换必须真的换掉台账：切到另一个平台后卡片来源全部改变，不能只是 UI 层高亮。
  // 走真实 setter（而不是给 sandbox 赋值），否则 var 初始化会把外部值覆盖掉，测了个假的。
  // Switching providers must really rebuild the ledger; going through the real setter matters
  // because the sandbox's `var` initialisation would overwrite an externally assigned value.
  catalogSandbox.schedulePlaylistPanelVirtualRender = () => {};
  catalogSandbox.userPlaylists = catalogSandbox.userPlaylists.concat(
    Array.from({ length: 3 }, (_, index) => ({ provider: 'qq', id: 'q' + index, name: 'QQ ' + index }))
  );
  catalogSandbox.playlistCatalogRevision = 2;
  catalogSandbox.setPlaylistPanelActiveProvider('qq');
  const switched = catalogSandbox.playlistPanelBuildVirtualEntries();
  if (switched.entries.length !== 3 || switched.entries.some(entry => entry.pl.provider !== 'qq') || switched.activeProvider !== 'qq') {
    fail(`switching provider must rebuild the catalog entries: ${JSON.stringify({ entries: switched.entries.length, active: switched.activeProvider })}`);
  }
  // 搜索必须真的过滤台账，而且过滤词要进缓存 key —— 少了那一条，改词后拿回来的
  // 还是上一次的 entries，界面上表现为「输入框在动、列表不动」。
  catalogSandbox.playlistSearchQuery = 'qq 1';
  const searched = catalogSandbox.playlistPanelBuildVirtualEntries();
  if (searched.entries.length === switched.entries.length
    || !searched.entries.every(entry => /qq 1/i.test(entry.pl.name))) {
    fail(`playlist search must filter the ledger by name: ${JSON.stringify({ before: switched.entries.length, after: searched.entries.length })}`);
  }
  catalogSandbox.playlistSearchQuery = '';
  if (catalogSandbox.playlistPanelBuildVirtualEntries().entries.length !== switched.entries.length) {
    fail('clearing the search must restore the full catalog ledger');
  }

  const hydrateStart = loaderText.indexOf('function playlistQueueSource');
  const hydrateEnd = loaderText.indexOf('async function loadPlaylistIntoQueueById', hydrateStart);
  if (hydrateStart < 0 || hydrateEnd < 0) fail('progressive playlist queue helper missing');
  const seed = Array.from({ length: 96 }, (_, id) => ({ id, name: 'Track ' + id }));
  const hydrateSandbox = {
    playQueue: seed,
    queueHydrationState: null,
    PLAYLIST_QUEUE_INITIAL_BATCH_SIZE: 96,
    PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE: 160,
    PLAYLIST_QUEUE_PLAYBACK_AHEAD_THRESHOLD: 96,
    playlistTracksEndpoint: (provider, id, params) => `${provider}:${id}?offset=${params.offset}&limit=${params.limit}`,
    apiJson: async url => {
      const offset = Number((url.match(/offset=(\d+)/) || [])[1]) || 0;
      const limit = Number((url.match(/limit=(\d+)/) || [])[1]) || 0;
      const count = Math.max(0, Math.min(limit, 10000 - offset));
      return {
        tracks: Array.from({ length: count }, (_, index) => ({ id: offset + index, name: 'Track ' + (offset + index) })),
        total: 10000,
        nextOffset: offset + count,
        hasMore: offset + count < 10000
      };
    },
    fetchPlaylistTracksPage: async (provider, id, params) => hydrateSandbox.apiJson(
      hydrateSandbox.playlistTracksEndpoint(provider, id, params)
    ),
    cloneSong: song => Object.assign({}, song),
    markSongsLiked: () => {},
    syncLikeStatusForSongs: () => {},
    safeRenderQueuePanel: () => {},
    scheduleShelfRebuild: () => { hydrateSandbox.shelfRebuilds += 1; },
    shuffleArrayInPlace: rows => rows,
    playMode: 'loop',
    setTimeout: () => { hydrateSandbox.autoSchedules += 1; return hydrateSandbox.autoSchedules; },
    clearTimeout: () => {},
    console,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    autoSchedules: 0,
    shelfRebuilds: 0
  };
  hydrateSandbox.queueHydrationState = {
    token: 7,
    active: true,
    loading: false,
    provider: 'netease',
    playlistId: 'scale-test',
    sourceId: 'scale-test',
    total: 10000,
    nextOffset: 96,
    hasMore: true,
    loaded: 96,
    error: '',
    promise: null,
    timer: 0,
    queueRef: seed,
    liked: false,
    warmPagesRemaining: 1,
    pausedForBuffer: false
  };
  vm.runInNewContext(loaderText.slice(hydrateStart, hydrateEnd), hydrateSandbox, { filename: 'playlist-progressive-queue.js' });
  let pages = 1;
  await hydrateSandbox.hydratePlaylistQueueNextPage('initial-warm-page');
  if (hydrateSandbox.playQueue.length !== 256 || !hydrateSandbox.queueHydrationState.active || hydrateSandbox.autoSchedules !== 0 || hydrateSandbox.shelfRebuilds !== 0) {
    fail(`10k queue must stop after one bounded warm page: ${JSON.stringify({ length: hydrateSandbox.playQueue.length, active: hydrateSandbox.queueHydrationState.active, autoSchedules: hydrateSandbox.autoSchedules, shelfRebuilds: hydrateSandbox.shelfRebuilds })}`);
  }
  while (hydrateSandbox.queueHydrationState.active && pages < 64) {
    await hydrateSandbox.hydratePlaylistQueueNextPage('queue-browse-tail');
    pages += 1;
  }
  const ids = hydrateSandbox.playQueue.map(song => song.id);
  if (ids.length !== 10000 || new Set(ids).size !== 10000 || ids[0] !== 0 || ids[9999] !== 9999 || pages > 63) {
    fail(`10k progressive queue did not complete in order: ${JSON.stringify({ length: ids.length, unique: new Set(ids).size, first: ids[0], last: ids[9999], pages })}`);
  }
  console.log(`[OK] 5k catalog=${catalogMs.toFixed(2)}ms/window ${catalogWindowEnd - catalogWindowStart}; 10k queue=1 warm + ${pages - 1} on-demand pages/window ${queueWindow.end - queueWindow.start}; one outer detail scroll; 3D pools retained.`);
}

module.exports = {
  checkProgressSeekDragGuard,
  checkPlaybackControlBadgesGuard,
  checkPlaybackResumeRecoveryGuard,
  checkAudioOutputWorkflowPanelGuard,
  checkVolumeWheelStepGuard,
  checkNonCurrentAudioPrefetchGuard,
  checkCuefieldAutoMixGuard,
  checkAlbumDetailGaplessGuard,
  checkShuffleQueueOrderGuard,
  checkLargePlaylistVirtualizationGuard,
};
