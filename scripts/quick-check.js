#!/usr/bin/env node
'use strict';

// 静态契约检查编排器。检查本体在 scripts/checks/*.cjs（从原单文件原样搬出，断言未改）。
// main() 的语句与顺序与拆分前完全一致，只是把 checkXxx() 换成了 CHECKS['checkXxx']()。
const env = require('./checks/env.cjs');
const playback = require('./checks/playback.cjs');
const desktop = require('./checks/desktop.cjs');
const visual = require('./checks/visual.cjs');
const provider = require('./checks/provider.cjs');
const misc = require('./checks/misc.cjs');
const { fail, jsCheckFiles, runNodeSyntaxCheck, parseCombinedIndexModules, scanForbiddenMarkers, runElectronRuntimeCheck, runMainStartupRecoveryCheck, path, appRoot, runElectron } = env;

const CHECKS = Object.assign({}, playback, desktop, visual, provider, misc);
env.checks = CHECKS;

async function main() {
  console.log(`App root: ${appRoot}`);
  runNodeSyntaxCheck(jsCheckFiles());
  // 注册守卫必须排在 parseCombinedIndexModules 之前：后者会对每条注册做 readFileSync，
  // 一旦有"注册了但文件不存在"就会先抛 ENOENT 栈，本函数的 missingFiles 判据便永远轮不到执行
  // （那会让它变成一条不可能失败的检查）。
  // The registration guard runs BEFORE the combined parse: the parse readFileSyncs every entry, so a
  // registered-but-absent path would blow up with an ENOENT stack first and this function's
  // missingFiles judgement would never be reached — i.e. it would be a check that cannot fail.
  CHECKS["checkIndexModuleRegistrationGuard"]();
  parseCombinedIndexModules();
  scanForbiddenMarkers();
  CHECKS["checkMainWindowChrome"]();
  CHECKS["checkBackgroundTransparencyControlsGuard"]();
  CHECKS["checkWallpaperEngineImportGuard"]();
  CHECKS["checkDesktopWallpaperModeGuard"]();
  CHECKS["checkDesktopWindowAdaptationGuard"]();
  CHECKS["checkLyricLayoutRangeGuard"]();
  CHECKS["checkPointerLockPermission"]();
  CHECKS["checkProgressSeekDragGuard"]();
  CHECKS["checkLyricBackfaceMaterialGuard"]();
  CHECKS["checkLyricScrollPerformanceGuard"]();
  CHECKS["checkPersistentCacheStorageGuard"]();
  CHECKS["checkExternalUpdatePageBridgeGuard"]();
  CHECKS["checkLyricTranslationCompletenessGuard"]();
  CHECKS["checkLyricVerticalFloatToggleGuard"]();
  CHECKS["checkQishuiProviderGuard"]();
  CHECKS["checkCustomSourceGuard"]();
  CHECKS["checkSpotifyProviderSurface"]();
  // 这个守卫检查 preload/main 的 Spotify 桥是否接全。它写好之后一直没被调用过，
  // 结果 preload 缺三个桥、main 缺三个通道都没人发现，用户点"接入 Spotify"直接卡死。
  await CHECKS["checkSpotifyProviderGuard"]();
  CHECKS["checkPlaybackControlBadgesGuard"]();
  await CHECKS["checkProviderFallbackTerminalStateGuard"]();
  CHECKS["checkSearchGlassEntranceGuard"]();
  CHECKS["checkProviderEntitlementBoundaryGuard"]();
  CHECKS["checkQQVipStatusSyncGuard"]();
  await CHECKS["checkProviderAuthCookiePathGuard"]();
  CHECKS["checkPlaybackResumeRecoveryGuard"]();
  CHECKS["checkAudioOutputWorkflowPanelGuard"]();
  CHECKS["checkVolumeWheelStepGuard"]();
  CHECKS["checkNonCurrentAudioPrefetchGuard"]();
  CHECKS["checkCuefieldAutoMixGuard"]();
  CHECKS["checkAlbumDetailGaplessGuard"]();
  CHECKS["checkInstallerPackagingGuard"]();
  CHECKS["checkSonicTopographyPresetGuard"]();
  CHECKS["checkLongPressReorderGuard"]();
  CHECKS["checkPlaylistPanelTriggerGuard"]();
  CHECKS["checkFullscreenToolsRowGuard"]();
  CHECKS["checkBeatAnalysisToggleGuard"]();
  CHECKS["checkCloseBehaviorDefaultGuard"]();
  CHECKS["checkUpdateManifestGuard"]();
  CHECKS["checkProviderRegistryGuard"]();
  CHECKS["checkPlaylistMultiselectGuard"]();
  CHECKS["checkPanelRowOverflowGuard"]();
  CHECKS["checkShuffleQueueOrderGuard"]();
  await CHECKS["checkLargePlaylistVirtualizationGuard"]();
  CHECKS["checkFirstLaunchDefaultsAndSplashGuard"]();
  CHECKS["checkIdleGuideCanvasReleaseGuard"]();
  CHECKS["checkWorkflowGatingHonestyGuard"]();
  CHECKS["checkFxConsoleWorkspaceGuard"]();
  CHECKS["checkResourceBudgetGuard"]();
  CHECKS["checkDjAnalyzerIsolationGuard"]();
  if (runElectron) {
    runElectronRuntimeCheck();
    runMainStartupRecoveryCheck();
  }
  else console.log('\n== Electron runtime smoke check ==\n[SKIP] Fast/static mode. Re-run with --electron, or npm run check:quick -- --electron.');
}

main().then(function () {
  console.log('\nAll checks passed.');
}).catch(function (error) {
  console.error('\n[FAIL] ' + (error.message || error));
  process.exit(1);
});
