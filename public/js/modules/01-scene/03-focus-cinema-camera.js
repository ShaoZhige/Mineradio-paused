// 本模块界面文案统一走 i18n；词典是唯一文案来源，缺键时退回内置中文模板。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：xxxText('key') 缺键返回键名；xxxText('key', '兜底') 显式指定缺键时显示什么；
// xxxText('key', '含 {p} 的模板', {p: v}) 带插值，params 同时喂给 t() 与兜底模板。
// Two call shapes: key-only shows the bare key on a miss; an explicit fallback says what to
// show instead; params interpolate into both the dictionary hit and the fallback template.
function focusCinemaCameraText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === "object") {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}

function unlockCenteredView() {
  orbit.centerLocked = false;
}

function clearCenteredViewOffsets() {
  pointerTarget.x = 0;
  pointerTarget.y = 0;
  pointerParallax.x = 0;
  pointerParallax.y = 0;
  mouseWorld.set(-999, -999, 0);
  mouseActive = false;
  headParallax.x = 0;
  headParallax.y = 0;
  headParallax.active = false;
  headNeutral = null;
  if (typeof gestureRotation !== 'undefined') {
    gestureRotation.x = 0;
    gestureRotation.y = 0;
  }
  if (typeof particleSpin !== 'undefined') {
    particleSpin.vx = 0;
    particleSpin.vy = 0;
  }
  if (typeof pinchState !== 'undefined') pinchState.active = false;
  if (typeof particlePointerSpin !== 'undefined') particlePointerSpin.active = false;
  if (typeof resetParticleRotationTarget === 'function') resetParticleRotationTarget(false);
  if (typeof uniforms !== 'undefined' && uniforms.uHandActive) {
    uniforms.uHandActive.value = 0;
    uniforms.uHandXY.value.set(-999, -999);
    if (uniforms.uGestureGrip) uniforms.uGestureGrip.value = 0;
  }
}

function updateCamera() {
  if (applyFreeCameraToCamera()) return;
  if (orbit.recentering) {
    var recenterThetaDelta = shortestAngleDelta(orbit.userTheta, orbit.baselineTheta);
    var recenterPhiDelta = orbit.baselinePhi - orbit.userPhi;
    var recenterRadiusDelta = orbit.baselineRadius - orbit.userRadius;
    var recenterDistance = Math.sqrt(
      recenterThetaDelta * recenterThetaDelta +
      recenterPhiDelta * recenterPhiDelta +
      Math.pow(recenterRadiusDelta / Math.max(1, orbit.baselineRadius), 2)
    );
    var recenterEase = clampRange(0.050 + recenterDistance * 0.080, 0.052, 0.135);
    orbit.userTheta += recenterThetaDelta * recenterEase;
    orbit.userPhi += recenterPhiDelta * recenterEase;
    orbit.userRadius += recenterRadiusDelta * recenterEase;
    var visualThetaTarget = orbit.baselineTheta + orbit.cineTheta;
    var visualPhiTarget = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.baselinePhi + orbit.cinePhi));
    var visualRadiusTarget = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.baselineRadius + orbit.cineRadius));
    var visualSettled = Math.abs(shortestAngleDelta(orbit.theta, visualThetaTarget)) < 0.0016 &&
      Math.abs(orbit.phi - visualPhiTarget) < 0.0016 &&
      Math.abs(orbit.radius - visualRadiusTarget) < 0.018;
    var recenterTimedOut = orbit.recenterStartedAt && performance.now() - orbit.recenterStartedAt > 1800;
    if (Math.abs(recenterThetaDelta) < 0.0012 &&
      Math.abs(recenterPhiDelta) < 0.0012 &&
      Math.abs(recenterRadiusDelta) < 0.014 &&
      (visualSettled || recenterTimedOut)) {
      settleOrbitRecenterTarget();
    }
  }

  // v8: focus 优先, 否则用 user + cine 复合姿态
  var fa = orbit.focus.active;
  var fa = orbit.focus.active;
  var targetTheta, targetPhi, targetRadius, tLookAt;
  if (fa) {
    targetTheta = orbit.focus.theta;
    targetPhi = orbit.focus.phi;
    targetRadius = orbit.focus.radius;
    tLookAt = orbit.focus.lookAt;
  } else if (orbit.centerLocked) {
    targetTheta = orbit.baselineTheta + orbit.cineTheta;
    targetPhi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.baselinePhi + orbit.cinePhi));
    targetRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.baselineRadius + orbit.cineRadius));
    tLookAt = ZERO_VEC;
  } else {
    targetTheta = orbit.userTheta + orbit.cineTheta;
    targetPhi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.userPhi + orbit.cinePhi));
    targetRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + orbit.cineRadius));
    tLookAt = ZERO_VEC;
  }
  // 丝滑变速: 线性 lerp 自然给出 "快→慢" 缓出曲线
  var focusEase = fa ? 0.16 : 0.10;
  var radiusEase = fa ? 0.12 : 0.07;
  var shelfFocusType = /^shelf-/.test(String(orbit.focus.type || ''));
  if (beatCam.punch > 0.01) {
    focusEase = Math.max(focusEase, 0.12 + beatCam.punch * 0.12);
    radiusEase = Math.max(radiusEase, 0.09 + beatCam.punch * 0.12);
  }
  if (!fa && !shelfFocusType && typeof readSonicLyricLookAtTarget === 'function' && typeof SONIC_CAMERA_LYRIC_LOOK_AT !== 'undefined' && readSonicLyricLookAtTarget(SONIC_CAMERA_LYRIC_LOOK_AT)) {
    tLookAt = SONIC_CAMERA_LYRIC_LOOK_AT;
    focusEase = Math.max(focusEase, 0.115);
    radiusEase = Math.max(radiusEase, 0.082);
  }
  if (shelfFocusType) {
    var shelfFocusWanted = typeof focusHover !== 'undefined' && focusHover ? focusHover.wantType : null;
    var shelfFocusMovingIn = fa;
    var shelfFocusMovingOut = !fa && !shelfFocusWanted;
    if (shelfFocusMovingIn || shelfFocusMovingOut) {
      var shelfMotion = shelfSummonSettings();
      var shelfCameraSpeed = shelfFocusMovingIn ? shelfMotion.cameraEnterSpeed : shelfMotion.cameraExitSpeed;
      focusEase = clampRange(focusEase * shelfCameraSpeed, 0.018, 0.42);
      radiusEase = clampRange(radiusEase * shelfCameraSpeed, 0.014, 0.36);
    }
  }
  orbit.theta += (targetTheta - orbit.theta) * focusEase;
  orbit.phi += (targetPhi - orbit.phi) * focusEase;
  orbit.radius += (targetRadius - orbit.radius) * radiusEase;
  orbit.lookAt.x += (tLookAt.x - orbit.lookAt.x) * focusEase;
  orbit.lookAt.y += (tLookAt.y - orbit.lookAt.y) * focusEase;
  orbit.lookAt.z += (tLookAt.z - orbit.lookAt.z) * focusEase;
  if (shelfFocusType && !fa) {
    var shelfFocusLookDx = tLookAt.x - orbit.lookAt.x;
    var shelfFocusLookDy = tLookAt.y - orbit.lookAt.y;
    var shelfFocusLookDz = tLookAt.z - orbit.lookAt.z;
    if (Math.abs(shortestAngleDelta(orbit.theta, targetTheta)) < 0.003 &&
      Math.abs(orbit.phi - targetPhi) < 0.003 &&
      Math.abs(orbit.radius - targetRadius) < 0.030 &&
      shelfFocusLookDx * shelfFocusLookDx + shelfFocusLookDy * shelfFocusLookDy + shelfFocusLookDz * shelfFocusLookDz < 0.0009) {
      orbit.focus.type = null;
    }
  }

  var cy = Math.cos(orbit.phi), sy = Math.sin(orbit.phi);
  var ct = Math.cos(orbit.theta), st = Math.sin(orbit.theta);
  camera.position.set(
    orbit.lookAt.x + orbit.radius * cy * st,
    orbit.lookAt.y + orbit.radius * sy,
    orbit.lookAt.z + orbit.radius * cy * ct
  );
  camera.lookAt(orbit.lookAt);
  var cameraShake = clampRange(Number(fx.cinemaShake) || 0, 0, 1.8);
  camera.rotation.z += beatCam.rollKick * cameraShake;

  var cameraPunch = Math.max(camPunch * 0.55, beatCam.punch * 0.54 + beatCam.radiusKick * 0.16) * cameraShake;
  var targetFOV = BASE_FOV - cameraPunch * (djMode.active ? 2.62 : 2.35);
  var fovEase = targetFOV < camera.fov ? 0.24 : 0.12;
  camera.fov += (targetFOV - camera.fov) * fovEase;
  camera.updateProjectionMatrix();
  camPunch *= 0.86;
}

// 焦点跟拍 (hover 0.5s 后镜头移到目标)
var focusHover = { wantType: null, pendingTimer: null, exitTimer: null };
function shouldUseWallpaperSafeShelfCamera() {
  return !!(fx && Number(fx.preset) === 5);
}
function shouldUseSkullSafeShelfCamera() {
  return !!(fx && Number(fx.preset) === SKULL_PRESET_INDEX);
}
function shouldUseWallpaperLyricCameraLock() {
  return !!(fx && Number(fx.preset) === 5 && fx.lyricCameraLock);
}
function requestStageLyricCameraSnap(frames) {
  if (typeof stageLyrics === 'undefined' || !stageLyrics) return;
  stageLyrics.snapCameraLockFrames = Math.max(stageLyrics.snapCameraLockFrames || 0, frames || 8);
}
function shouldDimWallpaperForShelf() {
  if (!shouldUseWallpaperSafeShelfCamera()) return false;
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfPinnedOpen) return true;
  return !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent());
}
function shouldOffsetLyricsForShelfDetail() {
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  return !!(shelfManager.hasOpenContent && shelfManager.hasOpenContent());
}
function shouldAvoidStageLyricsForShelf() {
  if (!shelfManager || !shelfManager.getMode || shelfManager.getMode() !== 'side') return false;
  if (shelfAlwaysVisible()) return true;
  if (shelfPinnedOpen) return true;
  if (shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return true;
  return !!(shelfVisibility > 0.24 || (shelfHoverCue && shelfHoverCue.value > 0.28));
}
function activateFocusZone(type) {
  unlockCenteredView();
  orbit.focus.active = true;
  orbit.focus.type = type;
  var shelfProfile = shelfLayoutProfile();
  if (type === 'shelf-side') {
    if (shouldUseWallpaperSafeShelfCamera()) {
      orbit.focus.theta = shelfProfile.portrait ? 0.18 : 0.24;
      orbit.focus.phi = shelfProfile.portrait ? 0.00 : 0.02;
      orbit.focus.radius = shelfProfile.portrait ? 5.74 : 5.32;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 1.04 : 2.24, -0.08, 0.78);
      camPunch = Math.max(camPunch, 0.28);
      requestStageLyricCameraSnap(10);
    } else {
      // 侧栏 (右): 近一点、侧一点，让歌单架打开时有明确的镜头推近。
      orbit.focus.theta = shelfProfile.portrait ? 0.24 : 0.42;
      orbit.focus.phi = shelfProfile.portrait ? -0.06 : -0.12;
      orbit.focus.radius = shelfProfile.portrait ? 5.28 : 4.20;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 1.08 : 2.32, shelfProfile.portrait ? -0.18 : -0.10, 0.72);
      camPunch = Math.max(camPunch, 0.82);
    }
  } else if (type === 'shelf-detail') {
    if (shouldUseWallpaperSafeShelfCamera()) {
      orbit.focus.theta = shelfProfile.portrait ? 0.16 : 0.26;
      orbit.focus.phi = shelfProfile.portrait ? -0.02 : 0.02;
      orbit.focus.radius = shelfProfile.portrait ? 5.88 : 5.18;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 0.72 : 2.28, shelfProfile.portrait ? -0.36 : -0.32, 0.84);
      camPunch = Math.max(camPunch, 0.30);
      requestStageLyricCameraSnap(10);
    } else {
      orbit.focus.theta = shelfProfile.portrait ? 0.16 : 0.34;
      orbit.focus.phi = shelfProfile.portrait ? -0.03 : -0.06;
      orbit.focus.radius = shelfProfile.portrait ? 5.90 : 4.86;
      orbit.focus.lookAt.set(shelfProfile.portrait ? 0.62 : 1.74, shelfProfile.portrait ? -0.08 : 0.02, 0.82);
      camPunch = Math.max(camPunch, 0.38);
    }
  } else if (type === 'shelf-stage') {
    // 舞台: 居中仰拍
    orbit.focus.theta = 0.0;
    orbit.focus.phi = shelfProfile.portrait ? -0.24 : -0.32;
    orbit.focus.radius = shelfProfile.portrait ? 4.8 : 3.8;
    orbit.focus.lookAt.set(0, shelfProfile.portrait ? -1.86 : -1.7, 0.8);
  }
  // 这里原本还有一档 `type === 'queue'`（theta 0.40 / phi 0.05 / radius 5.8 / lookAt(-1.2, 0, 0)），
  // 让相机在左侧队列面板出现时左移抬升，好把镜头对准那个 HTML 面板。已按用户反馈砍掉：面板已经把
  // 队列显示出来了，镜头再跟一次只是让画面在鼠标贴着左边缘来回时反复摇摆，歌词也跟着晃。
  // setFocusZone() 现在会把 'queue' 拦掉，所以这一档的姿态数值也一并删掉 —— 留着一份永远不会被读到的
  // 相机参数，只会让下一个接手的人以为它还能打开。
  //
  // There used to be a `type === 'queue'` profile here (theta 0.40 / phi 0.05 / radius 5.8 /
  // lookAt(-1.2, 0, 0)) that swung the camera left and up when the left queue panel appeared, to aim it
  // at that HTML panel. Removed on user feedback: the panel already shows the queue, and following it
  // only made the view wobble while the pointer moved along the left edge, taking the lyrics with it.
  // setFocusZone() now blocks 'queue', so its pose is deleted too — camera numbers that can never be
  // read would only make the next reader think the zone can still be turned on.
}
function setFocusZone(type, immediate) {
  // 左侧歌单/队列面板 (#playlist-panel) 不再参与镜头跟拍。它的显隐由左边缘的鼠标位置决定，于是
  // 鼠标贴着边缘一晃，面板 peek 出来、镜头跟着左移抬升，整屏连歌词一起摆，移开又摆回去 —— 反复
  // "跳来跳去"。面板本身已经把队列画出来了，不需要镜头再跟一次。
  // 拦在这里而不是只改调用方：漏掉任何一个调用点，focus 都会带着**上一档**的 theta/phi/radius 被
  // 激活，镜头会直接跳到一个谁也不属于的姿态。传进来的 'queue' 一律解释成"不激活任何跟拍"。
  //
  // The left playlist/queue panel (#playlist-panel) no longer drives the camera. Its visibility follows
  // the pointer along the left edge, so brushing that edge makes the panel peek while the camera swings
  // left and up, dragging the whole screen — lyrics included — and swinging back on exit. The panel
  // already shows the queue; the camera does not need to follow as well. Blocked here rather than only
  // at the call sites: a single missed caller would activate the focus with the PREVIOUS zone's
  // theta/phi/radius and snap the camera to a pose that belongs to nothing. Any incoming 'queue' is
  // read as "activate no follow camera at all".
  //
  // 调用方仍然会传 'queue'（左边缘的 peek 判定用它表示"队列拿到了指针焦点"），这个名字保留：它同时
  // 承担"压过 3D 歌单架跟拍"的优先级判断——队列面板开着时不应该再让镜头跑去对准歌单架。只有"把
  // 它交给相机"这一步被拦掉，所以调用方不需要改，也不会漏。
  // Callers keep passing 'queue' (the left-edge peek logic uses it for "the queue holds pointer focus")
  // and the name stays: it also carries the priority rule that the queue outranks the 3D shelf follow
  // camera — with the queue panel open the camera must not go aim at the shelf instead. Only the handoff
  // to the camera is blocked, so no caller needs changing and none can be missed.
  if (type === 'queue') type = null;
  if (type && !shouldUseShelfDynamicCamera(type)) {
    if (/^shelf-/.test(String(orbit.focus.type || ''))) orbit.focus.active = false;
    type = null;
  }
  if (focusHover.wantType === type) return;
  focusHover.wantType = type;
  if (focusHover.pendingTimer) { clearTimeout(focusHover.pendingTimer); focusHover.pendingTimer = null; }
  if (focusHover.exitTimer) { clearTimeout(focusHover.exitTimer); focusHover.exitTimer = null; }
  if (!type) {
    // 立刻退出 focus, 让相机回主姿态 (但插值是平滑的)
    focusHover.exitTimer = setTimeout(function () {
      focusHover.exitTimer = null;
      if (!focusHover.wantType) orbit.focus.active = false;
    }, 120);
    return;
  }
  if (immediate) {
    activateFocusZone(type);
    return;
  }
  // 延迟 500ms 激活
  focusHover.pendingTimer = setTimeout(function () {
    focusHover.pendingTimer = null;
    if (focusHover.wantType !== type) return;
    activateFocusZone(type);
  }, 260);
}

// 电影镜头 v8: 振幅大幅减小, 节拍 punch 加冷却 + 强度门槛
//   - cineTheta/Phi 是非常缓慢的低频漂移, 不再让人 motion sick
//   - punch zoom 只在 真·强主拍 触发, 至少间隔 0.45s, 振幅 ×0.5
var lastCamPunchAt = -10;
var CAM_PUNCH_MIN_INTERVAL = 0.45;     // 秒
var CAM_PUNCH_BEAT_THRESHOLD = 0.55;   // 必须够强才触发
function updateCinema(dt) {
  cinemaT += dt;
  updateBeatCamera(dt);
  if (!fx.cinema) {
    orbit.cineTheta *= 0.95;
    orbit.cinePhi *= 0.95;
    orbit.cineRadius *= 0.95;
    return;
  }
  var damp = orbit.rotating ? 0.25 : 1.0;
  // v8: 振幅减半, 周期更长 (更优雅)
  var dj = djMode.active;
  var shake = clampRange(Number(fx.cinemaShake) || 0, 0, 1.8);
  var beatDamp = (orbit.focus.active ? (dj ? 0.66 : 0.55) : (dj ? 1.12 : 1.0)) * shake;
  var idleDamp = damp * (dj ? 0.72 : 1.0) * shake;
  orbit.cineTheta = Math.sin(cinemaT * 0.08) * 0.012 * idleDamp + beatCam.thetaKick * beatDamp;
  orbit.cinePhi = Math.sin(cinemaT * 0.06 + 1.0) * 0.010 * idleDamp + beatCam.phiKick * beatDamp;
  orbit.cineRadius = Math.sin(cinemaT * 0.04 + 2.0) * 0.080 * idleDamp - beatCam.radiusKick * beatDamp * (dj ? 1.22 : 1.18);
}
updateCamera();

function recenterCamera() {
  orbit.centerLocked = true;
  orbit.recentering = true;
  orbit.recenterStartedAt = performance.now();
  dampCameraImpulseForRecenter(0.32);
  clearCenteredViewOffsets();
  if (typeof skullWheelZoomTarget !== 'undefined') {
    skullWheelZoomTarget = 0;
    if (!(fx && fx.preset === SKULL_PRESET_INDEX)) skullWheelZoom = 0;
  }
  // 同时解除任何镜头跟拍
  if (focusHover) {
    focusHover.wantType = null;
    if (focusHover.pendingTimer) { clearTimeout(focusHover.pendingTimer); focusHover.pendingTimer = null; }
    if (focusHover.exitTimer) { clearTimeout(focusHover.exitTimer); focusHover.exitTimer = null; }
  }
  orbit.focus.active = false;
  if (fx && fx.preset === SKULL_PRESET_INDEX) {
    resetSkullPresetView(false, { smooth: true, keepLyricLock: true });
  } else {
    resetSkullPresetView(true);
  }
  if (!(fx && fx.preset === SKULL_PRESET_INDEX) && ((fx && fx.lyricCameraLock) || shouldUseWallpaperLyricCameraLock())) requestStageLyricCameraSnap(14);
  showToast(focusCinemaCameraText('cam_view_recenter'));
}
