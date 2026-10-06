function normalizeWallpaperFps(value) {
  var n = Number(value);
  if (!isFinite(n) || n <= 0) return 30;
  if (n <= 26) return 24;
  if (n <= 45) return 30;
  return 60;
}

// Scene 玻璃采样要把壁纸像素抓进 Chromium，走的是 Windows Graphics Capture。
// 该系统能力只在 Win11（build 22000+）允许关闭捕获边框，Win10 会留下一圈常驻黄框，
// 所以在 Win10 上默认关掉采样；用户仍可在设置里手动打开（会收到一次黄框提示）。
// Borderless capture requires Win11 (build >= 22000); Win10 always paints the
// capture border, so the sampler defaults to off there and stays user-overridable.
function wallpaperEngineBorderlessCaptureSupported() {
  try {
    var release = window.desktopWindow && window.desktopWindow.systemRelease;
    // 拿不到系统版本时不猜：宁可少一个玻璃增强，也不让用户无故看到捕获黄框。
    if (typeof release !== 'string' || !release) return false;
    var parts = release.split('.');
    var major = Number(parts[0]) || 0;
    var build = Number(parts[2]) || 0;
    if (major > 10) return true;
    return major === 10 && build >= 22000;
  } catch (e) {
    return false;
  }
}

var fxDefaults = {
  preset: 0,            // 0..8 legacy series; 9=halo, 10=neon rain, 11=prism flock, 12=abyssal bloom
  intensity: 0.85,
  cinemaShake: 0.5,
  depth: 0.2,
  coverResolution: 1.55,
  point: 1.0, speed: 1.0, twist: 0.0, color: 1.10, scatter: 0.0, bgFade: 0.20,
  bloomStrength: 0.95,
  lyricGlowStrength: 0.28,
  lyricBackgroundAdapt: 0.72,
  lyricScale: 1.0,
  lyricOffsetX: 0,
  lyricOffsetY: 0,
  lyricOffsetZ: 0,
  lyricTiltX: 0,
  lyricTiltY: 0,
  lyricColorMode: 'auto',
  lyricColor: '#7ec8d8',
  lyricHighlightMode: 'auto',
  lyricHighlightColor: '#fff0b8',
  lyricGlowLinked: true,
  lyricGlowColor: '#9db8cf',
  lyricDisplayMode: 'cinema',
  lyricTranslationMode: 'multi',
  lyricMotionStyle: 'float',
  lyricCustomLineCount: 10,
  lyricGlitchCameraBind: true,
  lyricGlitchIntensity: 1.0,
  lyricGlitchSlice: 0.72,
  lyricGlitchChroma: 0.86,
  lyricGlitchRate: 1.0,
  lyricGlitchJitter: 0.72,
  lyricContextOpacity: 0.54,
  lyricContextSpread: 1.96,
  lyricTranslationGap: 0.92,
  lyricTranslationScale: 0.65,
  lyricTranslationOpacity: 0.86,
  lyricEdgeFade: 0.32,
  lyricMotionSoftness: 0.72,
  lyricFont: 'sans',
  lyricLetterSpacing: 0,
  lyricLineHeight: 1.0,
  lyricWeight: 750,
  lyricTextureClarity: 1,
  lyricLiveViewportFit: true,
  lyricContextHighQuality: true,
  lyricBackdropAdapt: true,
  coverBackdropAdapt: true,
  visualTintMode: 'auto',
  visualTintColor: '#9db8cf',
  uiAccentColor: '#ffffff',
  homeAccentColor: '#ffffff',
  homeIconColor: '#ffffff',
  visualIconColor: '#ffffff',
  backgroundColorMode: 'cover',
  backgroundColor: '#000000',
  backgroundOpacity: 1,
  windowBackgroundOpacity: 1,
  backgroundGlassOpacity: 0,
  controlGlassChromaticOffset: 50,
  playlistPanelGlassBlur: 14,
  playlistPanelGlassDensity: 0.55,
  playlistPanelOpenDuration: 0.72,
  playlistPanelCloseDuration: 0.48,
  backgroundColorCustom: false,
  backgroundImage: '',
  backgroundMedia: null,
  backgroundAlbumCover: false,
  backgroundMediaCropX: 50,
  backgroundMediaCropY: 50,
  backgroundMediaZoom: 1,
  desktopLyrics: false,
  desktopLyricsSize: 1.0,
  desktopLyricsOpacity: 0.92,
  desktopLyricsY: 0.76,
  desktopLyricsClickThrough: false,
  desktopLyricsCinema: false,
  desktopLyricsHighlight: false,
  desktopLyricsFps: 0,
  wallpaperMode: false,
  wallpaperOpacity: 1,
  wallpaperFps: 60,
  // WE 窗口静默：把 Wallpaper Engine 的运行窗口从任务栏和 Alt+Tab 里摘掉，
  // 播放壁纸时不弹任务栏提醒。默认开启，可在设置里关闭。
  wallpaperEngineSilentWindows: true,
  // 把本程序登记为 Windows 游戏（整活）：开启后系统游戏模式会给出更好的电源计划与调度
  // 优先级。它只写 HKCU，不需要管理员权限；关闭时按备份原样还原注册表。默认关闭。
  // Register this app as a Windows game (joke feature): the system game mode then favours it
  // with a better power plan and scheduling priority. Writes HKCU only, so no elevation; the
  // registry is restored from a backup when switched off. Defaults to off.
  windowsGameMode: false,
  // WE 玻璃采样：抓壁纸真实像素给控制栏玻璃做底。基线取 false——这条链路走 Chromium 窗口
  // 捕获，Win10 必然留下一圈系统黄框。取不到系统版本、或读取走了兜底路径时，基线就是最终
  // 值，此时宁可少一个玻璃增强，也不要让用户无故看到黄框。Win11（build 22000+）由读取路径
  // 按 wallpaperEngineBorderlessCaptureSupported() 改回 true。
  // Baseline false: the sampler goes through Chromium window capture, which always paints the
  // system yellow border on Win10. The baseline becomes the final value whenever the release is
  // unknown or the read path fell back, so lose the glass enhancement rather than show a border
  // nobody asked for. Win11 (build >= 22000) is turned back on by the read path.
  wallpaperEngineGlassSampler: false,
  // 视觉开关默认值：溢光（bloom）默认关，轮廓高亮（edge）默认开。
  // bloom 参与两处渲染：预设网格的 uBloomStrength（关掉直接归零）和独立的 bloomParticles 层
  // （整层隐藏），见 07-fx/04-preset-grid-uniforms.js；edge 只是网格着色器里的 uEdgeEnabled 一项。
  // 注意：自动存档、预设存档、打包快照三处读取都把「缺键」解释成这里的值，所以改这两个默认值时
  // 必须同时核对读取处的方向——`=== true` 只对默认关的键成立，默认开的键必须写成 `!== false`。
  // Visual switch defaults: bloom off, edge on. bloom drives both uBloomStrength on the preset grid
  // (zeroed when off) and the separate bloomParticles layer (hidden entirely); edge is only the
  // uEdgeEnabled term in the grid shader. All three readers (autosave, preset archive, packaged
  // snapshot) read a missing key as the value declared here, so `=== true` is only right for a
  // default-off key; a default-on key has to read `!== false`.
  floatLayer: false, cinema: true, edge: true, aiDepth: false, bloom: false, lyricGlow: true,
  lyricGlowBeat: true,
  lyricGlowParticles: false,
  lyricVerticalFloat: true,
  backgroundStarRiver: true,
  lyricPauseHold: true,
  lyricCameraLock: false,
  sonicGroundAmplitude: 50,
  sonicGroundMotionSpeed: 50,
  sonicGroundDensity: 46,
  sonicGroundRange: 82,
  sonicGroundLower: 68,
  sonicGroundDepth: 62,
  sonicGroundAutoRotate: 50,
  sonicGroundColorMode: 'cover',
  sonicGroundBaseColor: '#05070c',
  sonicGroundCoolColor: '#0066ff',
  sonicGroundWarmColor: '#ff3c19',
  sonicGroundAccentColor: '#33e6ff',
  sonicGroundGlow: 20,
  sonicGroundSubBass: 90,
  sonicGroundBass: 92,
  sonicGroundLowMid: 50,
  sonicGroundMid: 50,
  sonicGroundHighMid: 50,
  sonicGroundPresence: 25,
  sonicGroundBrilliance: 50,
  sonicGroundAir: 48,
  sonicGroundFloatingEnabled: true,
  sonicGroundFloatingIntensity: 36,
  sonicGroundFloatingMinSize: 9,
  sonicGroundFloatingMaxSize: 12,
  sonicGroundFloatingSpeed: 59,
  sonicGroundFloatingCount: 80,
  sonicAudioMonitorEnabled: true,
  sonicAudioAutoTrack: true,
  sonicAudioSensitivity: 100,
  sonicAudioBandStart: 1,
  sonicAudioBandEnd: 4,
  sonicAudioThreshold: 32,
  sonicAudioPulseStrength: 62,
  sonicWorkshopInputGain: 82,
  sonicWorkshopAudioIntensity: 1.15,
  sonicWorkshopResponseRange: 1.30,
  sonicWorkshopPeakIntensity: 0.62,
  sonicWorkshopColorMode: 'cover',
  sonicWorkshopTheme: 'minimal-monochrome',
  sonicWorkshopCustomColor: '#d9dde3',
  sonicWorkshopBaseColorMode: 'cover',
  sonicWorkshopBaseColor: '#0b0c0e',
  sonicWorkshopWarmColorMode: 'cover',
  sonicWorkshopWarmColor: '#d9dde3',
  sonicWorkshopCoolColorMode: 'custom',
  sonicWorkshopCoolColor: '#ffffff',
  sonicWorkshopRippleColorMode: 'cover',
  sonicWorkshopRippleColor: '#ffffff',
  sonicWorkshopPeakColorMode: 'cover',
  sonicWorkshopPeakColor: '#f2f5f8',
  particleLyrics: true,    // v7.2: 粒子歌词
  backCover: false,        // 旧的封面背面粒子层关闭；浮空粒子层会跟随封面翻转
  shelf: 'side',
  shelfPinnedOpen: false,
  shelfCameraMode: 'dynamic',
  shelfPresence: 'auto',
  shelfShowPodcasts: false,
  shelfMergeCollections: true,
  shelfSize: 0.92,
  shelfOffsetX: -0.34,
  shelfOffsetY: -0.2,
  shelfOffsetZ: 0.12,
  shelfAngleY: -11,
  shelfAngleYManual: true,
  shelfOpacity: 1,
  shelfBgOpacity: 0.79,
  shelfAccentColor: '#ffffff',
  shelfDetailOffsetX: 0,
  shelfDetailOffsetY: 0,
  shelfDetailOffsetZ: 0,
  shelfDetailScale: 1.35,
  shelfDetailAngleX: 0,
  shelfDetailAngleY: -13,
  shelfDetailRowGap: 1,
  shelfDetailOpenDuration: 0.6,
  shelfDetailCloseDuration: 0.18,
  shelfDetailRowDuration: 0.72,
  shelfDetailIntroStrength: 1,
  shelfDetailParallax: 1,
  shelfSummonOpenDuration: 0.91,
  shelfSummonCloseDuration: 0.46,
  shelfSummonSlide: 1.9,
  shelfSummonStagger: 1,
  shelfSummonScale: 1,
  shelfSummonParallax: 1,
  shelfCameraEnterSpeed: 0.24,
  shelfCameraExitSpeed: 0.24,
  performanceBackground: 'release',
  // 默认从 eco 提到 balanced：eco 档下粒子预算系数只有 0.28（见 12-particle-budget.js），
  // 首启动就比上游少七成粒子，看起来像"粒子坏了"而不是"省电档"。balanced 是安全的中档。
  // Raised from eco to balanced: at eco the particle budget factor is only 0.28 (see
  // 12-particle-budget.js), so a fresh install draws roughly a quarter of the population and reads
  // as broken rather than power-saving. balanced is the safe middle tier.
  performanceQuality: 'balanced',
  foregroundFpsMode: 'vsync',
  memoryAutoTrimApp: true,
  memoryAutoTrimOnBackground: true,
  memoryAutoSystemTrim: true,
  memorySystemAutoElevate: false,
  memorySystemIntervalMin: 30,
  memorySystemThresholdPercent: 78,
  memorySystemMask: 29,
  memorySafetyRevision: 4,
  liveBackgroundKeep: false,
  // 自动节奏分析：默认关闭。开启后播放时自动分析节拍生成谱面（供视觉与电影镜头同步）；
  // 关闭则不自动分析，已有谱面缓存（含手动在「本地节奏分析」里分析过的）仍然照用。
  // Automatic beat analysis defaults to off: when on, playback analyses beats into a chart for the
  // visuals and cinema camera; when off nothing is analysed, while existing charts (including ones
  // produced by the manual local-beat modal) are still consumed.
  beatAnalysis: false,
  cam: 'off',
  gesturePlayerActions: true,
  gestureHandOverlay: true,
  gestureSensitivity: 'balanced',
};
function normalizeForegroundFpsMode(value) {
  var mode = String(value || '').trim().toLowerCase();
  if (mode === 'vsync' || mode === 'adaptive') return mode;
  if (/^(45|60|75|90|120)$/.test(mode)) return mode;
  return fxDefaults.foregroundFpsMode || 'vsync';
}
function foregroundFixedFpsForMode(mode) {
  mode = normalizeForegroundFpsMode(mode);
  if (mode === 'vsync') return 0;
  if (mode === 'adaptive') return null;
  return Math.max(1, Number(mode) || 60);
}
