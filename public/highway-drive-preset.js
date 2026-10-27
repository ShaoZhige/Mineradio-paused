/**
 * Highway Drive visual preset for Mineradio.
 * A bounded first-person road scene driven by the shared eight-band sonic monitor.
 */
(function (global) {
  'use strict';

  // 本仓库编号已用到 12，新预设只能往后排：9~12 是现有的四个 premium 视觉预设。
  // 直接沿用上游 PR 的 9 会让老存档里的 preset 9 被解释成这个预设。
  var INDEX = 13;
  var ROAD_SEGMENT_COUNT = 112;
  var ROAD_COLUMN_COUNT = 17;
  var ROAD_BAND_COUNT = 8;
  var ROAD_NEAR = 1.4;
  var ROAD_LENGTH = 98;
  var ROAD_SPECTRUM_SAMPLE_COUNT = ROAD_SEGMENT_COUNT + 1;
  var ROAD_SPECTRUM_STEP = ROAD_LENGTH / ROAD_SEGMENT_COUNT;
  var ROAD_TRACK_LANE_BANDS = [[0, 4], [2, 6], [3, 7], [1, 5]];
  var ROAD_TRACK_LANE_CENTERS = [-0.67, -0.17, 0.17, 0.67];
  var ROAD_TRACK_LANE_SEQUENCE = [1, 2, 0, 3, 2, 0, 3, 1];
  var ROAD_TRACK_LANE_COUNT = ROAD_TRACK_LANE_BANDS.length;
  var ROAD_TRACK_MAX_EVENT_LANES = 2;
  var ROAD_TRACK_MIN_EVENT_GAP = 0.12;
  var ROAD_TRACK_ONSET_THRESHOLD = 0.15;
  var ROAD_HALF_WIDTH = 3.7;
  var SHOULDER_HALF_WIDTH = 26;
  var ROAD_BASE_Y = -1.62;
  var LIGHT_PAIR_COUNT = 24;
  var LIGHT_SPACING = 6.4;
  var MAX_CAMERA_ROLL = 0.012;
  var CAMERA_ROLL_RESPONSE = 1.15;
  // 场景里不再有锥体、立方体这些低模实体：地形、植被、路灯、路标全部是点。
  // 每种粒子自带一条固定的「槽位」属性，每帧只按 travel 求 ahead，再写回世界坐标。
  var TERRAIN_SLOT_COUNT = 256;
  var TERRAIN_ROW_POINTS = 14;
  var TERRAIN_LAYER_COUNT = 2;
  var TERRAIN_LAYER_CONFIG = [
    { lateral: 6, spread: 13, height: 5, tint: 0.20, size: 1.4 },
    { lateral: 9, spread: 19, height: 9, tint: 0.86, size: 1.3 }
  ];
  // 每个槽位每侧每层多留一个「脊点」，它负责把山脊轮廓画清楚。
  var TERRAIN_POINT_COUNT = TERRAIN_SLOT_COUNT * TERRAIN_ROW_POINTS * 2 * TERRAIN_LAYER_COUNT;
  var FLORA_SLOT_COUNT = 54;
  var FLORA_BEADS = 5;
  var FLORA_POINT_COUNT = FLORA_SLOT_COUNT * 2 * FLORA_BEADS;
  var GROUND_DUST_COUNT = 7000;
  var VOID_DUST_COUNT = 4200;
  var MOTE_COUNT = 260;
  var GATE_POINT_COUNT = 236;
  var GATE_SPACING = 132;
  var BIOME_ZONE_LENGTH = 420;
  var WEATHER_TRANSITION_START = 0.72;
  var PRECIPITATION_COUNT = 384;
  var LANDMARK_SPACING = 148;
  var LANDMARK_PASS_DISTANCE = 12;
  var BIOME_NAMES = ['mountains', 'river', 'hills', 'desert', 'beach', 'grassland'];
  var ABYSS_COLORS = [0x4a5f78, 0x5a3f2e, 0x2c3742, 0x5d6a7a, 0x04060f, 0x08121f];
  var WEATHER_NAMES = ['clear-day', 'golden-hour', 'rain', 'snow', 'starry-night', 'aurora'];
  var CELESTIAL_NAMES = ['moon', 'mars', 'jupiter', 'saturn', 'neptune', 'venus', 'mercury'];
  var CELESTIAL_RING_PARTICLE_COUNT = 760;
  var CELESTIAL_CONFIG = [
    { radius: 4.25, flatten: 1.00, tilt: 0.12, spin: 0.040, color: 0xc8c8c2, glow: 0.95 },
    { radius: 4.05, flatten: 0.99, tilt: 0.44, spin: 0.035, color: 0xb44725, glow: 1.10 },
    { radius: 5.05, flatten: 0.93, tilt: 0.05, spin: 0.062, color: 0xd6ad78, glow: 1.32 },
    { radius: 4.75, flatten: 0.91, tilt: 0.47, spin: 0.057, color: 0xd8bd82, glow: 1.16, ring: true },
    { radius: 4.55, flatten: 0.98, tilt: 0.49, spin: 0.047, color: 0x397bd8, glow: 1.38 },
    { radius: 4.35, flatten: 0.99, tilt: 0.05, spin: 0.028, color: 0xd9a95d, glow: 1.42 },
    { radius: 3.75, flatten: 1.00, tilt: 0.03, spin: 0.032, color: 0x898783, glow: 0.82 }
  ];
  var WEATHER_BY_BIOME_TOUR = [
    [3, 2, 0, 1, 0, 4],
    [5, 2, 0, 1, 1, 4]
  ];
  var LANDMARK_NAMES = [
    'Eiffel Tower',
    'Big Ben',
    'Burj Khalifa',
    'Taj Mahal',
    'Sydney Opera House',
    'Pyramids of Giza',
    'Oriental Pearl Tower',
    'Empire State Building'
  ];
  var BIOME_PALETTES = [
    { ground: 0x071411, mountain: 0x29424a, mound: 0x18382e, trunk: 0x26362f, crown: 0x315b49, water: 0x16424d },
    { ground: 0x071817, mountain: 0x24444a, mound: 0x183d32, trunk: 0x263b32, crown: 0x2b6550, water: 0x137b96 },
    { ground: 0x0a1d11, mountain: 0x2e4c3c, mound: 0x2d6538, trunk: 0x304334, crown: 0x4d7a45, water: 0x1c5968 },
    { ground: 0x241607, mountain: 0x76502c, mound: 0xa06a32, trunk: 0x4d5b35, crown: 0x39704d, water: 0x1d5867 },
    { ground: 0x3c2914, mountain: 0x7a5b38, mound: 0xb8884d, trunk: 0x5b4028, crown: 0x397454, water: 0x1688a5 },
    { ground: 0x092111, mountain: 0x315342, mound: 0x347442, trunk: 0x314637, crown: 0x4d8555, water: 0x1a6572 }
  ];
  var BAND_KEYS = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'presence', 'brilliance', 'air'];

  var state = {
    root: null,
    scene: null,
    road: null,
    roadMaterial: null,
    shoulder: null,
    shoulderMaterial: null,
    leftRail: null,
    rightRail: null,
    poleMaterial: null,
    sky: null,
    skyMaterial: null,
    precipitation: null,
    precipitationMaterial: null,
    celestialRoot: null,
    celestialMesh: null,
    celestialMaterial: null,
    celestialSpriteMaterials: null,
    celestialCore: null,
    celestialCoreMaterial: null,
    celestialRing: null,
    celestialRingMaterial: null,
    abyssFloor: null,
    abyssMaterial: null,
    terrainCloud: null,
    groundDustCloud: null,
    voidDustCloud: null,
    floraCloud: null,
    lampCloud: null,
    moteCloud: null,
    gateMaterial: null,
    gateClouds: [],
    lampBeams: null,
    lampBeamPositions: null,
    pixelRatio: 1,
    roadPositions: null,
    roadEnergy: null,
    roadPulse: null,
    roadTrackPulse: null,
    spectrumEnergyHistory: null,
    spectrumPulseHistory: null,
    trackPulseHistory: null,
    spectrumHead: -1,
    spectrumSamples: 0,
    spectrumDistance: 0,
    spectrumWavePeak: 0,
    trackNotePeak: 0,
    spectrumEventLanePeak: 0,
    pendingTrigger: 0,
    trackEventIndex: 0,
    lastTrackLane: -1,
    trackVisitedMask: 0,
    trackCueAge: 0,
    trackCueCooldown: 0,
    trackPreviousBeat: 0,
    trackPreviousBands: [0, 0, 0, 0, 0, 0, 0, 0],
    shoulderPositions: null,
    leftRailPositions: null,
    rightRailPositions: null,
    dummy: null,
    rollQuaternion: null,
    rollAxis: null,
    roll: 0,
    biomeIndex: -1,
    nextBiomeIndex: -1,
    biomeBlend: 0,
    biomeFade: 0,
    leftWaterAmount: 0,
    rightWaterAmount: 0,
    weatherIndex: 0,
    nextWeatherIndex: 0,
    weatherBlend: 0,
    celestialIndex: 0,
    nextCelestialIndex: 0,
    activeCelestialIndex: -1,
    activeCelestialZone: -1,
    celestialOpacity: 0,
    celestialAxialTilt: 0,
    celestialAxisAzimuth: 0,
    celestialAxisX: 0,
    celestialAxisZ: 0,
    rainAmount: 0,
    snowAmount: 0,
    visibleLandmark: '',
    opacity: 0,
    travel: 0,
    time: 0,
    speed: 12,
    boost: 0,
    beat: 0,
    lastTrigger: 0,
    seed: 0,
    initialized: false,
    bands: [0, 0, 0, 0, 0, 0, 0, 0]
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  }

  function clamp01(value) {
    return clamp(Number(value) || 0, 0, 1);
  }

  function lerp(a, b, amount) {
    return a + (b - a) * amount;
  }

  function damp(current, target, speed, dt) {
    return current + (target - current) * (1 - Math.exp(-Math.max(0, speed) * Math.max(0.001, dt || 1 / 60)));
  }

  function smoothstep(value) {
    var t = clamp01(value);
    return t * t * (3 - 2 * t);
  }

  function hash1(index, seed) {
    var x = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453123;
    return (x - Math.floor(x)) * 2 - 1;
  }

  function valueNoise1D(value, seed) {
    var index = Math.floor(value);
    var fraction = value - index;
    var blend = smoothstep(fraction);
    return lerp(hash1(index, seed), hash1(index + 1, seed), blend);
  }

  function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function recycledWorldPlacement(index, spacing, count, leadOffset, travel, passDistance) {
    var cycleLength = Math.max(spacing, count * spacing);
    var firstWorldDistance = leadOffset + index * spacing;
    var recycleCount = Math.max(0, Math.ceil((travel - passDistance - firstWorldDistance) / cycleLength));
    var worldDistance = firstWorldDistance + recycleCount * cycleLength;
    return {
      ahead: worldDistance - travel,
      slot: Math.floor(worldDistance / spacing),
      worldDistance: worldDistance,
      recycleCount: recycleCount
    };
  }

  function biomeIndexAtDistance(distance, seed) {
    var offset = positiveModulo(Math.floor((Number(seed) || 0) * 13), BIOME_NAMES.length);
    var zone = Math.floor(Math.max(0, Number(distance) || 0) / BIOME_ZONE_LENGTH);
    return positiveModulo(zone + offset, BIOME_NAMES.length);
  }

  function biomeStateAtDistance(distance, seed) {
    var safeDistance = Math.max(0, Number(distance) || 0);
    var currentIndex = biomeIndexAtDistance(safeDistance, seed);
    var nextIndex = biomeIndexAtDistance(safeDistance + BIOME_ZONE_LENGTH, seed);
    var progress = positiveModulo(safeDistance, BIOME_ZONE_LENGTH) / BIOME_ZONE_LENGTH;
    return {
      index: currentIndex,
      name: BIOME_NAMES[currentIndex],
      nextIndex: nextIndex,
      nextName: BIOME_NAMES[nextIndex],
      blend: smoothstep((progress - WEATHER_TRANSITION_START) / (1 - WEATHER_TRANSITION_START)),
      progress: progress,
      zone: Math.floor(safeDistance / BIOME_ZONE_LENGTH)
    };
  }

  function weatherIndexForSequence(sequenceIndex) {
    var biomeIndex = positiveModulo(sequenceIndex, BIOME_NAMES.length);
    var tourIndex = positiveModulo(Math.floor(sequenceIndex / BIOME_NAMES.length), WEATHER_BY_BIOME_TOUR.length);
    return WEATHER_BY_BIOME_TOUR[tourIndex][biomeIndex];
  }

  function celestialIndexForZone(zone, seed) {
    var safeZone = Math.max(0, Math.floor(Number(zone) || 0));
    var weatherOffset = positiveModulo(Math.floor((Number(seed) || 0) * 13), BIOME_NAMES.length);
    var celestialOffset = positiveModulo(Math.floor((Number(seed) || 0) * 17), CELESTIAL_NAMES.length);
    var nightOrdinal = 0;
    for (var index = 0; index < safeZone; index++) {
      if (weatherIndexForSequence(index + weatherOffset) >= 4) nightOrdinal += 1;
    }
    return positiveModulo(3 + nightOrdinal * 2 + celestialOffset, CELESTIAL_NAMES.length);
  }

  function celestialPositionForZone(zone, seed) {
    var safeZone = Math.max(0, Math.floor(Number(zone) || 0));
    var safeSeed = Number(seed) || 0;
    var side = hash1(safeZone + 17, safeSeed + 503) >= 0 ? 1 : -1;
    var horizontal = 17.5 + (hash1(safeZone + 31, safeSeed + 587) + 1) * 1.75;
    var height = 17 + (hash1(safeZone + 47, safeSeed + 643) + 1) * 1.75;
    var depth = -74 - (hash1(safeZone + 59, safeSeed + 701) + 1) * 3;
    return { x: side * horizontal, y: height, z: depth, side: side < 0 ? 'left' : 'right' };
  }

  function celestialAxialTiltForZone(zone, index, seed) {
    var safeZone = Math.max(0, Math.floor(Number(zone) || 0));
    var safeIndex = Math.max(0, Math.min(CELESTIAL_CONFIG.length - 1, Math.round(Number(index) || 0)));
    var safeSeed = Number(seed) || 0;
    var baseTilt = CELESTIAL_CONFIG[safeIndex].tilt;
    var tiltVariation = (hash1(safeZone + 83, safeSeed + safeIndex * 137 + 761) + 1) * 0.5;
    var fineVariation = (hash1(safeZone + 109, safeSeed + safeIndex * 191 + 823) + 1) * 0.5;
    var angle = clamp(baseTilt * (0.78 + tiltVariation * 0.44) + fineVariation * 0.036, 0.025, 0.62);
    var azimuth = (hash1(safeZone + 131, safeSeed + safeIndex * 223 + 887) + 1) * Math.PI;
    var spinPhase = (hash1(safeZone + 157, safeSeed + safeIndex * 257 + 947) + 1) * Math.PI;
    return {
      angle: angle,
      azimuth: azimuth,
      x: Math.sin(azimuth) * angle,
      z: Math.cos(azimuth) * angle,
      spinPhase: spinPhase
    };
  }

  function weatherStateAtDistance(distance, seed) {
    var safeDistance = Math.max(0, Number(distance) || 0);
    var seedOffset = positiveModulo(Math.floor((Number(seed) || 0) * 13), BIOME_NAMES.length);
    var rawZone = Math.floor(safeDistance / BIOME_ZONE_LENGTH);
    var sequence = rawZone + seedOffset;
    var progress = positiveModulo(safeDistance, BIOME_ZONE_LENGTH) / BIOME_ZONE_LENGTH;
    var currentIndex = weatherIndexForSequence(sequence);
    var nextIndex = weatherIndexForSequence(sequence + 1);
    var blend = smoothstep((progress - WEATHER_TRANSITION_START) / (1 - WEATHER_TRANSITION_START));
    return {
      index: currentIndex,
      name: WEATHER_NAMES[currentIndex],
      nextIndex: nextIndex,
      nextName: WEATHER_NAMES[nextIndex],
      blend: blend,
      progress: progress,
      zone: rawZone
    };
  }

  function landmarkIndexAtDistance(distance) {
    return positiveModulo(Math.floor(Math.max(0, Number(distance) || 0) / LANDMARK_SPACING), LANDMARK_NAMES.length);
  }

  function roadCenterAt(distance, seed) {
    var broad = valueNoise1D(distance / 168 + 17.3, seed + 11) * 5.2;
    var turn = valueNoise1D(distance / 88 + 43.7, seed + 29) * 2.6;
    var drift = valueNoise1D(distance / 320 + 91.2, seed + 47) * 3.4;
    return broad + turn + drift;
  }

  function roadElevationAt(distance, seed) {
    return valueNoise1D(distance / 180 + 9.4, seed + 73) * 0.24
      + valueNoise1D(distance / 82 + 31.8, seed + 97) * 0.07;
  }

  function localRoadSample(ahead) {
    var base = state.travel;
    var center = roadCenterAt(base, state.seed);
    var heading = (roadCenterAt(base + 0.8, state.seed) - roadCenterAt(base - 0.8, state.seed)) / 1.6;
    var elevation = roadElevationAt(base, state.seed);
    var slope = (roadElevationAt(base + 1.2, state.seed) - roadElevationAt(base - 1.2, state.seed)) / 2.4;
    return {
      x: roadCenterAt(base + ahead, state.seed) - center - heading * ahead,
      y: roadElevationAt(base + ahead, state.seed) - elevation - slope * ahead
    };
  }

  function normalizeHex(value, fallback) {
    value = value == null ? '' : String(value).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    if (/^#[0-9a-fA-F]{3}$/.test(value)) {
      return '#' + value.slice(1).split('').map(function (part) { return part + part; }).join('');
    }
    if (typeof global.lyricPaletteColorToHex === 'function') {
      return global.lyricPaletteColorToHex(value, fallback, 0.42);
    }
    return fallback;
  }

  function readTheme(fx) {
    var stage = global.stageLyrics || {};
    var palette = stage.coverPalette || stage.palette || {};
    var fallbackPrimary = normalizeHex(fx && fx.visualTintColor, '#26d9ff');
    var primary = new THREE.Color(normalizeHex(palette.primary, fallbackPrimary));
    var secondary = new THREE.Color(normalizeHex(palette.secondary, '#ffad42'));
    var accent = new THREE.Color(normalizeHex(palette.highlight, '#f7fbff'));
    var colorDistance = Math.abs(primary.r - secondary.r) + Math.abs(primary.g - secondary.g) + Math.abs(primary.b - secondary.b);
    if (colorDistance < 0.28) secondary.lerp(new THREE.Color('#ffad42'), 0.72);
    accent.lerp(new THREE.Color('#ffffff'), 0.28);
    return { primary: primary, secondary: secondary, accent: accent };
  }

  function readAudio(raw) {
    raw = raw || {};
    var detailed = raw.sonicDetailed || raw.subBass != null || raw.lowMid != null || raw.highMid != null;
    var bass = clamp01(raw.bass);
    var mid = clamp01(raw.mid);
    var treble = clamp01(raw.treble);
    var beat = clamp01(raw.beat);
    var energy = clamp01(raw.energy);
    var bands = detailed ? BAND_KEYS.map(function (key) { return clamp01(raw[key]); }) : [
      clamp01(bass * 0.58 + beat * 0.48),
      clamp01(bass * 0.82 + beat * 0.26),
      clamp01(mid * 0.54 + bass * 0.16),
      clamp01(mid * 0.88 + energy * 0.08),
      clamp01(treble * 0.48 + mid * 0.22),
      clamp01(treble * 0.62 + beat * 0.10),
      clamp01(treble * 0.76 + energy * 0.06),
      clamp01(treble * 0.45 + energy * 0.10)
    ];
    return {
      bands: bands,
      energy: energy,
      beat: clamp01(raw.kickEnvelope != null ? raw.kickEnvelope : beat),
      trigger: clamp01(Math.max(Number(raw.triggerPulse) || 0, Number(raw.kickOnset) || 0, beat * 0.72))
    };
  }

  function buildRoadGeometry() {
    var rows = ROAD_SEGMENT_COUNT + 1;
    var vertexCount = rows * ROAD_COLUMN_COUNT;
    var positions = new Float32Array(vertexCount * 3);
    var uv = new Float32Array(vertexCount * 2);
    var energy = new Float32Array(vertexCount);
    var pulse = new Float32Array(vertexCount);
    var trackPulse = new Float32Array(vertexCount);
    var indices = [];
    for (var row = 0; row < rows; row++) {
      for (var column = 0; column < ROAD_COLUMN_COUNT; column++) {
        var vertex = row * ROAD_COLUMN_COUNT + column;
        uv[vertex * 2] = column / (ROAD_COLUMN_COUNT - 1);
        uv[vertex * 2 + 1] = row / ROAD_SEGMENT_COUNT;
        if (row < ROAD_SEGMENT_COUNT && column < ROAD_COLUMN_COUNT - 1) {
          var next = vertex + ROAD_COLUMN_COUNT;
          indices.push(vertex, next, vertex + 1, next, next + 1, vertex + 1);
        }
      }
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('aBandEnergy', new THREE.BufferAttribute(energy, 1));
    geometry.setAttribute('aBandPulse', new THREE.BufferAttribute(pulse, 1));
    geometry.setAttribute('aTrackPulse', new THREE.BufferAttribute(trackPulse, 1));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    state.roadPositions = positions;
    state.roadEnergy = energy;
    state.roadPulse = pulse;
    state.roadTrackPulse = trackPulse;
    resetSpectrumHistory();
    return geometry;
  }

  function roadVertexShader() {
    return [
      'precision highp float;',
      'attribute float aBandEnergy;',
      'attribute float aBandPulse;',
      'attribute float aTrackPulse;',
      'varying vec2 vUv;',
      'varying float vBandEnergy;',
      'varying float vBandPulse;',
      'varying float vTrackPulse;',
      'varying float vDepth;',
      'void main(){',
      '  vUv=uv;',
      '  vBandEnergy=aBandEnergy;',
      '  vBandPulse=aBandPulse;',
      '  vTrackPulse=aTrackPulse;',
      '  vDepth=max(0.0,-position.z);',
      '  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
      '}'
    ].join('\n');
  }

  function roadFragmentShader() {
    return [
      'precision highp float;',
      'uniform float uTime;',
      'uniform float uTravel;',
      'uniform float uBeat;',
      'uniform float uBoost;',
      'uniform float uOpacity;',
      'uniform vec3 uPrimary;',
      'uniform vec3 uSecondary;',
      'uniform vec3 uAccent;',
      'varying vec2 vUv;',
      'varying float vBandEnergy;',
      'varying float vBandPulse;',
      'varying float vTrackPulse;',
      'varying float vDepth;',
      'void main(){',
      '  float side=abs(vUv.x*2.0-1.0);',
      '  float fog=1.0-smoothstep(54.0,98.0,vDepth);',
      '  float laneDist=min(abs(side-0.34),side);',
      '  float dash=step(0.44,fract((vDepth+uTravel)*0.085));',
      '  float lane=(1.0-smoothstep(0.006,0.024,laneDist))*dash;',
      '  float edge=1.0-smoothstep(0.010,0.045,abs(side-0.955));',
      '  float rim=smoothstep(0.955,0.995,side);',
      '  float flow=0.5+0.5*sin((vDepth+uTravel)*0.26-uTime*1.9);',
      '  float laneBand=smoothstep(0.020,0.340,laneDist);',
      '  vec3 bandColor=mix(uPrimary,uSecondary,smoothstep(0.08,0.92,side));',
      '  float spectrum=(0.12+vBandEnergy*0.88)*(0.44+flow*0.56);',
      '  float waveGlow=pow(max(vBandPulse,0.0),1.16)*(0.34+flow*0.66);',
      '  float trackGlow=pow(max(vTrackPulse,0.0),1.06)*laneBand;',
      '  float sheen=(1.0-smoothstep(0.0,0.62,abs(side-0.55)))*(0.35+flow*0.65);',
      '  float seamPhase=fract((vDepth+uTravel)/9.0);',
      '  float seam=1.0-smoothstep(0.0,0.045,min(seamPhase,1.0-seamPhase));',
      '  vec3 color=bandColor*(0.030+spectrum*0.16);',
      '  color+=uAccent*sheen*0.10;',
      '  color+=uAccent*seam*0.30;',
      '  color+=uAccent*lane*(0.86+uBoost*0.58+uBeat*0.12);',
      '  color+=mix(uPrimary,uSecondary,step(0.5,vUv.x))*(edge*1.05+rim*0.70)*(0.96+vBandEnergy*0.72);',
      '  color+=mix(bandColor,uAccent,0.30)*waveGlow*0.86;',
      '  color+=mix(bandColor,uAccent,0.72)*trackGlow*1.32;',
      '  float alpha=uOpacity*fog*(0.075+sheen*0.06+seam*0.16+lane*0.90+edge*0.95+rim*0.85+waveGlow*0.42+trackGlow*0.46);',
      '  gl_FragColor=vec4(color,alpha);',
      '}'
    ].join('\n');
  }

  function buildRoadMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTravel: { value: 0 },
        uBeat: { value: 0 },
        uBoost: { value: 0 },
        uOpacity: { value: 0 },
        uPrimary: { value: new THREE.Color('#26d9ff') },
        uSecondary: { value: new THREE.Color('#ffad42') },
        uAccent: { value: new THREE.Color('#ffffff') }
      },
      vertexShader: roadVertexShader(),
      fragmentShader: roadFragmentShader(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
  }

  function skyVertexShader() {
    return [
      'precision highp float;',
      'varying vec2 vUv;',
      'void main(){',
      '  vUv=uv;',
      '  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
      '}'
    ].join('\n');
  }

  function skyFragmentShader() {
    return [
      'precision highp float;',
      'uniform float uTime;',
      'uniform float uOpacity;',
      'uniform float uMode;',
      'uniform float uNextMode;',
      'uniform float uBlend;',
      'varying vec2 vUv;',
      'float hash21(vec2 p){',
      '  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);',
      '}',
      'float noise2(vec2 p){',
      '  vec2 i=floor(p);',
      '  vec2 f=fract(p);',
      '  f=f*f*(3.0-2.0*f);',
      '  return mix(mix(hash21(i),hash21(i+vec2(1.0,0.0)),f.x),mix(hash21(i+vec2(0.0,1.0)),hash21(i+vec2(1.0,1.0)),f.x),f.y);',
      '}',
      'float fbm(vec2 p){',
      '  float value=0.0;',
      '  float weight=0.54;',
      '  for(int i=0;i<4;i++){',
      '    value+=noise2(p)*weight;',
      '    p=p*2.03+vec2(17.3,9.1);',
      '    weight*=0.48;',
      '  }',
      '  return value;',
      '}',
      'float sunDisc(vec2 uv,vec2 center,float radius){',
      '  vec2 delta=vec2((uv.x-center.x)*1.65,uv.y-center.y);',
      '  return 1.0-smoothstep(radius,radius+0.012,length(delta));',
      '}',
      'float cloudField(vec2 uv,float scale,float drift){',
      '  vec2 p=vec2(uv.x*scale-uTime*drift,uv.y*scale*1.34);',
      '  return fbm(p)+noise2(p*0.42+7.8)*0.22;',
      '}',
      'float stars(vec2 uv){',
      '  vec2 grid=uv*vec2(190.0,108.0);',
      '  vec2 cell=floor(grid);',
      '  vec2 point=fract(grid)-0.5;',
      '  float seed=hash21(cell);',
      '  float sparkle=0.72+0.28*sin(uTime*(0.7+seed*1.6)+seed*31.0);',
      '  return step(0.982,seed)*(1.0-smoothstep(0.02,0.18,length(point)))*sparkle;',
      '}',
      'vec3 skyForMode(float mode,vec2 uv){',
      '  float h=clamp(uv.y,0.0,1.0);',
      '  if(mode<0.5){',
      '    vec3 color=mix(vec3(0.62,0.82,0.94),vec3(0.055,0.31,0.68),pow(h,0.72));',
      '    float sun=sunDisc(uv,vec2(0.42,0.68),0.045);',
      '    float halo=1.0-smoothstep(0.04,0.28,length(vec2((uv.x-0.42)*1.65,uv.y-0.68)));',
      '    float cloud=smoothstep(0.59,0.78,cloudField(uv,4.2,0.010))*smoothstep(0.10,0.78,h);',
      '    color=mix(color,vec3(0.91,0.96,1.0),cloud*0.62);',
      '    return color+vec3(1.0,0.84,0.52)*(sun*0.82+halo*0.18);',
      '  }',
      '  if(mode<1.5){',
      '    vec3 color=mix(vec3(0.98,0.37,0.13),vec3(0.055,0.10,0.29),pow(h,0.64));',
      '    float sun=sunDisc(uv,vec2(0.30,0.54),0.065);',
      '    float haze=(1.0-smoothstep(0.04,0.44,abs(h-0.49)))*(0.42+noise2(vec2(uv.x*5.0,uTime*0.012))*0.18);',
      '    float cloud=smoothstep(0.62,0.80,cloudField(uv+vec2(0.0,0.18),3.7,0.008));',
      '    color=mix(color,vec3(0.23,0.13,0.24),cloud*0.48);',
      '    return color+vec3(1.0,0.73,0.32)*(sun*0.95+haze*0.22);',
      '  }',
      '  if(mode<2.5){',
      '    vec3 color=mix(vec3(0.30,0.38,0.43),vec3(0.045,0.075,0.13),pow(h,0.78));',
      '    float storm=cloudField(uv+vec2(0.0,0.20),3.2,0.020);',
      '    color=mix(color,vec3(0.035,0.055,0.075),smoothstep(0.48,0.84,storm)*0.72);',
      '    float horizon=1.0-smoothstep(0.02,0.34,abs(h-0.24));',
      '    return color+vec3(0.10,0.16,0.18)*horizon;',
      '  }',
      '  if(mode<3.5){',
      '    vec3 color=mix(vec3(0.78,0.86,0.91),vec3(0.25,0.39,0.54),pow(h,0.76));',
      '    float overcast=smoothstep(0.48,0.78,cloudField(uv+vec2(0.0,0.28),3.0,0.008));',
      '    color=mix(color,vec3(0.48,0.58,0.67),overcast*0.46);',
      '    return color+vec3(0.12,0.16,0.20)*(1.0-h)*0.22;',
      '  }',
      '  if(mode<4.5){',
      '    vec3 color=mix(vec3(0.055,0.105,0.19),vec3(0.006,0.015,0.055),pow(h,0.65));',
      '    float milky=1.0-smoothstep(0.08,0.36,abs(uv.y-(0.30+uv.x*0.30)));',
      '    milky*=0.22+fbm(uv*vec2(5.0,3.2))*0.34;',
      '    return color+vec3(0.20,0.25,0.38)*milky+vec3(0.82,0.90,1.0)*stars(uv);',
      '  }',
      '  vec3 color=mix(vec3(0.035,0.095,0.15),vec3(0.004,0.018,0.052),pow(h,0.62));',
      '  float wave=sin(uv.x*13.0+fbm(vec2(uv.x*2.6,uTime*0.025))*5.2-uTime*0.16);',
      '  float curtain=pow(smoothstep(0.10,0.94,wave*0.5+0.5),1.7);',
      '  curtain*=smoothstep(0.18,0.48,h)*(1.0-smoothstep(0.76,0.99,h));',
      '  float ribbon=sin(uv.x*19.0-uTime*0.11+noise2(uv*3.0)*4.0)*0.5+0.5;',
      '  vec3 aurora=mix(vec3(0.08,0.92,0.56),vec3(0.30,0.48,1.0),ribbon);',
      '  aurora=mix(aurora,vec3(0.78,0.24,0.72),smoothstep(0.68,1.0,ribbon));',
      '  return color+aurora*curtain*0.62+vec3(0.72,0.90,1.0)*stars(uv)*0.74;',
      '}',
      'void main(){',
      '  vec3 current=skyForMode(uMode,vUv);',
      '  vec3 next=skyForMode(uNextMode,vUv);',
      '  vec3 color=mix(current,next,smoothstep(0.0,1.0,uBlend));',
      '  gl_FragColor=vec4(color,uOpacity);',
      '}'
    ].join('\n');
  }

  function precipitationVertexShader() {
    return [
      'precision highp float;',
      'attribute float aSeed;',
      'uniform float uTime;',
      'uniform float uRain;',
      'uniform float uSnow;',
      'varying float vRain;',
      'varying float vSnow;',
      'varying float vSeed;',
      'void main(){',
      '  float strength=max(uRain,uSnow);',
      '  vec3 transformed=position;',
      '  float fallSpeed=uRain*22.0+uSnow*3.2;',
      '  transformed.y=mod(position.y+12.0-uTime*fallSpeed+aSeed*30.0,30.0)-12.0;',
      '  transformed.x+=sin(uTime*(0.45+aSeed*0.55)+aSeed*31.0)*uSnow*1.25;',
      '  transformed.x-=uRain*(transformed.y+12.0)*0.055;',
      '  vec4 mvPosition=modelViewMatrix*vec4(transformed,1.0);',
      '  float perspective=clamp(22.0/max(5.0,-mvPosition.z),0.34,1.35);',
      '  gl_PointSize=mix(5.0,8.5,uSnow)*perspective*strength;',
      '  gl_Position=projectionMatrix*mvPosition;',
      '  vRain=uRain;',
      '  vSnow=uSnow;',
      '  vSeed=aSeed;',
      '}'
    ].join('\n');
  }

  function precipitationFragmentShader() {
    return [
      'precision highp float;',
      'uniform float uOpacity;',
      'varying float vRain;',
      'varying float vSnow;',
      'varying float vSeed;',
      'void main(){',
      '  vec2 point=gl_PointCoord-0.5;',
      '  float rainShape=(1.0-smoothstep(0.045,0.13,abs(point.x)))*(1.0-smoothstep(0.40,0.50,abs(point.y)));',
      '  float snowShape=1.0-smoothstep(0.20,0.50,length(point));',
      '  float alpha=max(vRain*rainShape*0.72,vSnow*snowShape*(0.62+vSeed*0.30))*uOpacity;',
      '  if(alpha<0.015) discard;',
      '  vec3 color=mix(vec3(0.65,0.82,0.92),vec3(0.96,0.99,1.0),vSnow);',
      '  gl_FragColor=vec4(color,alpha);',
      '}'
    ].join('\n');
  }

  // 天体全部改成同一套粒子光团：球面上撒点、中心再补一些，靠颜色与大小区分彼此。
  // 之前一半是带贴图的实体球、一半是天空里的模糊光斑，两种质感摆在一起很违和。
  // 天体统一成「模糊光团」：一张程序化柔光贴图 + 一层更亮的内核，外圈再罩一层散射光。
  // 之前是贴图实体球，跟别处的模糊光斑摆在一起很违和。
  function createCelestialCloudTexture(seed) {
    var size = 160;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var context = canvas.getContext('2d');
    var half = size / 2;
    var gradient = context.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, 'rgba(255,255,255,0.98)');
    gradient.addColorStop(0.30, 'rgba(255,255,255,0.64)');
    gradient.addColorStop(0.56, 'rgba(255,255,255,0.26)');
    gradient.addColorStop(0.80, 'rgba(255,255,255,0.07)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    // 表面斑块：让每颗行星的纹理不一样，光看轮廓也能分辨。
    context.globalCompositeOperation = 'source-atop';
    for (var index = 0; index < 52; index++) {
      var angle = (hash1(index, seed) + 1) * Math.PI;
      var radius = (hash1(index + 311, seed) + 1) * 0.5 * half * 0.80;
      var spotX = half + Math.cos(angle) * radius;
      var spotY = half + Math.sin(angle) * radius;
      var spotSize = 4 + (hash1(index + 617, seed) + 1) * 10;
      var spotAlpha = 0.025 + (hash1(index + 733, seed) + 1) * 0.055;
      context.beginPath();
      context.arc(spotX, spotY, spotSize, 0, Math.PI * 2);
      context.fillStyle = hash1(index + 811, seed) > 0
        ? 'rgba(0,0,0,' + spotAlpha.toFixed(3) + ')'
        : 'rgba(255,255,255,' + spotAlpha.toFixed(3) + ')';
      context.fill();
    }
    context.globalCompositeOperation = 'source-over';
    var texture = new THREE.CanvasTexture(canvas);
    if (THREE.sRGBEncoding != null) texture.encoding = THREE.sRGBEncoding;
    return texture;
  }

  function createCelestialSprite(texture, name, renderOrder) {
    var material = new THREE.SpriteMaterial({
      map: texture,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
    var sprite = new THREE.Sprite(material);
    sprite.name = name;
    sprite.renderOrder = renderOrder;
    return sprite;
  }

  function buildCelestialRingGeometry() {
    var count = CELESTIAL_RING_PARTICLE_COUNT;
    var positions = new Float32Array(count * 3);
    var scales = new Float32Array(count);
    var seeds = new Float32Array(count);
    var tints = new Float32Array(count);
    for (var index = 0; index < count; index++) {
      var t = (hash1(index, 101) + 1) * 0.5;
      var radius = 1.26 + t * 0.90;
      var angle = (hash1(index, 131) + 1) * Math.PI;
      // 环中间留一道缝，才看得出是土星那道环而不是一个光盘。
      var gap = Math.abs(radius - 1.72) < 0.06 ? 0.22 : 1;
      positions[index * 3] = Math.cos(angle) * radius;
      positions[index * 3 + 1] = (hash1(index, 149) + 1) * 0.012;
      positions[index * 3 + 2] = Math.sin(angle) * radius;
      scales[index] = (0.85 + (hash1(index, 163) + 1) * 0.4) * gap;
      seeds[index] = (hash1(index, 179) + 1) * 0.5;
      tints[index] = clamp01(0.35 + t * 0.45);
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
    geometry.computeBoundingSphere();
    return geometry;
  }

  function createCelestialLayer() {
    state.celestialRoot = new THREE.Group();
    state.celestialRoot.name = 'highway-celestial-3d-root';
    var initialPosition = celestialPositionForZone(0, state.seed);
    state.celestialRoot.position.set(initialPosition.x, initialPosition.y, initialPosition.z);

    state.celestialSpriteMaterials = CELESTIAL_CONFIG.map(function (config, index) {
      return createCelestialSprite(createCelestialCloudTexture(state.seed + index * 37 + 11), 'highway-celestial-cloud-' + index, -90).material;
    });
    state.celestialMesh = new THREE.Sprite(state.celestialSpriteMaterials[0]);
    state.celestialMesh.name = 'highway-celestial-' + CELESTIAL_NAMES[0];
    state.celestialMesh.center.set(0.5, 0.5);
    state.celestialRoot.add(state.celestialMesh);

    state.celestialCoreMaterial = new THREE.SpriteMaterial({
      map: createCelestialCloudTexture(state.seed + 907),
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
    state.celestialCore = new THREE.Sprite(state.celestialCoreMaterial);
    state.celestialCore.name = 'highway-celestial-core';
    state.celestialCore.renderOrder = -89;
    state.celestialRoot.add(state.celestialCore);

    state.celestialRingMaterial = createParticleMaterial({
      colorA: 0x6a5433,
      colorB: 0xe6cf9a,
      sizeK: 215,
      glow: 1.05,
      fogNear: 400,
      fogFar: 800
    });
    state.celestialRing = new THREE.Points(buildCelestialRingGeometry(), state.celestialRingMaterial);
    state.celestialRing.name = 'highway-celestial-saturn-ring';
    state.celestialRing.rotation.x = 1.10;
    state.celestialRing.rotation.z = -0.08;
    state.celestialRing.renderOrder = -88;
    state.celestialRing.frustumCulled = false;
    state.celestialRoot.add(state.celestialRing);

    state.root.add(state.celestialRoot);
    applyCelestialAppearance(0);
    state.celestialRoot.visible = false;
  }

  function applyCelestialAppearance(index) {
    if (!state.celestialMesh || index < 0 || index >= CELESTIAL_CONFIG.length) return;
    var config = CELESTIAL_CONFIG[index];
    var color = new THREE.Color(config.color);
    state.activeCelestialIndex = index;
    state.celestialMaterial = state.celestialSpriteMaterials[index];
    state.celestialMesh.material = state.celestialMaterial;
    state.celestialMaterial.color.copy(color);
    state.celestialMaterial.opacity = 0;
    state.celestialMesh.name = 'highway-celestial-' + CELESTIAL_NAMES[index];
    // 扁率靠纵向压扁，光团也要跟着扁。
    state.celestialMesh.scale.set(config.radius * 2.9, config.radius * 2.9 * config.flatten, 1);
    if (state.celestialCore) {
      state.celestialCoreMaterial.color.copy(color.clone().lerp(new THREE.Color(0xffffff), 0.34));
      state.celestialCore.scale.set(config.radius * 1.15, config.radius * 1.15 * config.flatten, 1);
    }
    state.celestialRing.scale.setScalar(config.radius);
    state.celestialRing.visible = !!config.ring;
  }

  function applyCelestialAxialTilt(zone, index) {
    if (!state.celestialRoot || !state.celestialMesh) return;
    var orientation = celestialAxialTiltForZone(zone, index, state.seed);
    state.celestialRoot.rotation.set(orientation.x, 0, orientation.z);
    state.celestialAxialTilt = orientation.angle;
    state.celestialAxisAzimuth = orientation.azimuth;
    state.celestialAxisX = orientation.x;
    state.celestialAxisZ = orientation.z;
  }

  function updateCelestialLayer(weather, dt) {
    if (!state.celestialRoot || !state.celestialMesh) return;
    var currentNight = weather.index >= 4;
    var nextNight = weather.nextIndex >= 4;
    var displayIndex = -1;
    var displayZone = -1;
    var celestialOpacity = 0;
    if (currentNight && nextNight) {
      if (weather.blend < 0.5) {
        displayIndex = state.celestialIndex;
        displayZone = weather.zone;
        celestialOpacity = 1 - smoothstep(weather.blend / 0.5);
      } else {
        displayIndex = state.nextCelestialIndex;
        displayZone = weather.zone + 1;
        celestialOpacity = smoothstep((weather.blend - 0.5) / 0.5);
      }
    } else if (currentNight) {
      displayIndex = state.celestialIndex;
      displayZone = weather.zone;
      celestialOpacity = 1 - weather.blend;
    } else if (nextNight) {
      displayIndex = state.nextCelestialIndex;
      displayZone = weather.zone + 1;
      celestialOpacity = weather.blend;
    }
    var appearanceChanged = displayIndex >= 0 && displayIndex !== state.activeCelestialIndex;
    if (appearanceChanged) applyCelestialAppearance(displayIndex);
    if (displayZone >= 0 && (displayZone !== state.activeCelestialZone || appearanceChanged)) {
      var position = celestialPositionForZone(displayZone, state.seed);
      state.celestialRoot.position.set(position.x, position.y, position.z);
      applyCelestialAxialTilt(displayZone, displayIndex);
      state.activeCelestialZone = displayZone;
    }
    state.celestialOpacity = clamp01(celestialOpacity);
    state.celestialRoot.visible = state.celestialOpacity > 0.01;
    if (displayIndex >= 0) {
      var config = CELESTIAL_CONFIG[displayIndex];
      state.celestialRing.visible = !!config.ring && state.celestialOpacity > 0.01;
    }
  }

  function createWeatherLayer() {
    state.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uMode: { value: 0 },
        uNextMode: { value: 0 },
        uBlend: { value: 0 }
      },
      vertexShader: skyVertexShader(),
      fragmentShader: skyFragmentShader(),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });
    state.sky = new THREE.Mesh(new THREE.PlaneGeometry(240, 135, 1, 1), state.skyMaterial);
    state.sky.name = 'highway-dynamic-sky';
    state.sky.position.set(0, 10, -100);
    state.sky.renderOrder = -100;
    state.sky.frustumCulled = false;
    state.root.add(state.sky);
    createCelestialLayer();

    var positions = new Float32Array(PRECIPITATION_COUNT * 3);
    var seeds = new Float32Array(PRECIPITATION_COUNT);
    for (var index = 0; index < PRECIPITATION_COUNT; index++) {
      var seed = (hash1(index, 701) + 1) * 0.5;
      positions[index * 3] = hash1(index, 733) * 25;
      positions[index * 3 + 1] = -12 + (hash1(index, 769) + 1) * 15;
      positions[index * 3 + 2] = -5 - (hash1(index, 811) + 1) * 45;
      seeds[index] = seed;
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.computeBoundingSphere();
    state.precipitationMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uRain: { value: 0 },
        uSnow: { value: 0 }
      },
      vertexShader: precipitationVertexShader(),
      fragmentShader: precipitationFragmentShader(),
      transparent: true,
      depthWrite: false,
      depthTest: true
    });
    state.precipitation = new THREE.Points(geometry, state.precipitationMaterial);
    state.precipitation.name = 'highway-weather-precipitation';
    state.precipitation.renderOrder = 8;
    state.precipitation.frustumCulled = false;
    state.root.add(state.precipitation);
  }

  function buildShoulderGeometry() {
    var rows = ROAD_SEGMENT_COUNT + 1;
    var positions = new Float32Array(rows * 2 * 3);
    var indices = [];
    for (var row = 0; row < ROAD_SEGMENT_COUNT; row++) {
      var vertex = row * 2;
      indices.push(vertex, vertex + 2, vertex + 1, vertex + 2, vertex + 3, vertex + 1);
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    state.shoulderPositions = positions;
    return geometry;
  }

  function buildRail(side, color) {
    var positions = new Float32Array(ROAD_SEGMENT_COUNT * 2 * 3);
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    var material = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0, depthWrite: false });
    var line = new THREE.LineSegments(geometry, material);
    line.frustumCulled = false;
    if (side < 0) state.leftRailPositions = positions;
    else state.rightRailPositions = positions;
    return line;
  }

  // 粒子统一走这一套：圆形柔光点 + 深度雾衰减 + 逐点闪烁。
  // 之前的地形和路边景物是锥体、立方体、圆柱拼的，低模方块感太重，全部换成点。
  function particleVertexShader() {
    return [
      'precision highp float;',
      'attribute float aScale;',
      'attribute float aSeed;',
      'attribute float aTint;',
      'uniform float uTime;',
      'uniform float uBeat;',
      'uniform float uEnergy;',
      'uniform float uPixelRatio;',
      'uniform vec3 uColorA;',
      'uniform vec3 uColorB;',
      'uniform float uFogNear;',
      'uniform float uFogFar;',
      'uniform float uGlow;',
      'uniform float uSizeK;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main(){',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  float depth = max(0.6, -mv.z);',
      '  float flicker = 0.68 + 0.32 * sin(uTime * (0.9 + aSeed * 2.6) + aSeed * 37.0);',
      '  float size = aScale * (0.82 + uBeat * 0.46 + uEnergy * 0.30) * flicker;',
      '  gl_PointSize = clamp(size * uPixelRatio * (uSizeK / depth), 1.0, 46.0);',
      '  float fog = 1.0 - smoothstep(uFogNear, uFogFar, depth);',
      '  vAlpha = fog * (0.42 + flicker * 0.58);',
      '  vColor = mix(uColorA, uColorB, clamp(aTint, 0.0, 1.0)) * uGlow * (0.80 + uBeat * 0.34 + uEnergy * 0.26);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n');
  }

  function particleFragmentShader() {
    return [
      'precision highp float;',
      'uniform float uOpacity;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main(){',
      '  vec2 offset = gl_PointCoord - vec2(0.5);',
      '  float radius = length(offset);',
      '  if (radius > 0.5) discard;',
      '  float core = pow(1.0 - smoothstep(0.0, 0.5, radius), 1.9);',
      '  gl_FragColor = vec4(vColor * core, vAlpha * core * uOpacity);',
      '}'
    ].join('\n');
  }

  function createParticleMaterial(options) {
    options = options || {};
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uBeat: { value: 0 },
        uEnergy: { value: 0 },
        uPixelRatio: { value: 1 },
        uColorA: { value: new THREE.Color(options.colorA == null ? 0x1d8fb0 : options.colorA) },
        uColorB: { value: new THREE.Color(options.colorB == null ? 0x2f4f7a : options.colorB) },
        uFogNear: { value: options.fogNear == null ? 26 : options.fogNear },
        uFogFar: { value: options.fogFar == null ? 96 : options.fogFar },
        uGlow: { value: options.glow == null ? 1 : options.glow },
        uSizeK: { value: options.sizeK == null ? 80 : options.sizeK }
      },
      vertexShader: particleVertexShader(),
      fragmentShader: particleFragmentShader(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
  }

  function createParticleCloud(count, name, options) {
    var positions = new Float32Array(count * 3);
    var scales = new Float32Array(count);
    var seeds = new Float32Array(count);
    var tints = new Float32Array(count);
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
    geometry.computeBoundingSphere();
    var material = createParticleMaterial(options);
    var points = new THREE.Points(geometry, material);
    points.name = name;
    points.renderOrder = options && options.renderOrder != null ? options.renderOrder : 0;
    points.frustumCulled = false;
    return {
      points: points,
      geometry: geometry,
      material: material,
      positions: positions,
      scales: scales,
      seeds: seeds,
      tints: tints,
      count: count,
      layerPeaks: null
    };
  }

  // 地形是全场点数最多的一层，位置全在顶点着色器里算：
  // CPU 每帧只更新几个 uniform，两万点也不会拖慢主循环。
  function terrainVertexShader() {
    return [
      'precision highp float;',
      'attribute float aSlot;',
      'attribute float aSide;',
      'attribute float aLateral;',
      'attribute float aRise;',
      'attribute float aLayer;',
      'attribute float aTint;',
      'attribute float aScale;',
      'attribute float aSeed;',
      'uniform float uTime;',
      'uniform float uTravel;',
      'uniform float uBeat;',
      'uniform float uEnergy;',
      'uniform float uPixelRatio;',
      'uniform float uSizeK;',
      'uniform float uGlow;',
      'uniform float uFogNear;',
      'uniform float uFogFar;',
      'uniform float uSlotCount;',
      'uniform float uRoadLength;',
      'uniform float uBandLow;',
      'uniform float uBandHigh;',
      'uniform float uBaseY;',
      'uniform float uNearNear;',
      'uniform float uNearFar;',
      'uniform float uTravelScale;',
      'uniform vec3 uColorA;',
      'uniform vec3 uColorB;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main(){',
      '  float spacing = uRoadLength / max(uSlotCount, 1.0);',
      '  float ahead = mod(aSlot * spacing - uTravel * uTravelScale, uRoadLength);',
      '  float bandEnergy = mix(uBandLow, uBandHigh, aLayer);',
      '  vec3 local;',
      '  local.x = aSide * aLateral;',
      '  local.y = uBaseY + aRise * (0.80 + bandEnergy * 0.55);',
      '  local.z = -ahead;',
      '  vec4 mv = modelViewMatrix * vec4(local, 1.0);',
      '  float depth = max(0.6, -mv.z);',
      '  float flicker = 0.62 + 0.38 * sin(uTime * (1.1 + aSeed * 2.4) + aSeed * 41.0);',
      '  float size = aScale * (0.78 + uBeat * 0.42 + uEnergy * 0.26) * flicker;',
      '  gl_PointSize = clamp(size * uPixelRatio * (uSizeK / depth), 1.0, 40.0);',
      '  float fog = 1.0 - smoothstep(uFogNear, uFogFar, depth);',
      '  float nearFade = smoothstep(uNearNear, uNearFar, ahead);',
      '  vAlpha = fog * nearFade * (0.34 + flicker * 0.66);',
      '  vColor = mix(uColorA, uColorB, clamp(aTint, 0.0, 1.0)) * uGlow * (0.78 + uBeat * 0.30 + uEnergy * 0.24);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n');
  }

  function createTerrainMaterial(options) {
    options = options || {};
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uBeat: { value: 0 },
        uEnergy: { value: 0 },
        uPixelRatio: { value: 1 },
        uSizeK: { value: options.sizeK == null ? 320 : options.sizeK },
        uGlow: { value: options.glow == null ? 2.2 : options.glow },
        uFogNear: { value: options.fogNear == null ? 40 : options.fogNear },
        uFogFar: { value: options.fogFar == null ? 118 : options.fogFar },
        uSlotCount: { value: TERRAIN_SLOT_COUNT },
        uRoadLength: { value: ROAD_LENGTH },
        uBandLow: { value: 0 },
        uBandHigh: { value: 0 },
        uBaseY: { value: options.baseY == null ? ROAD_BASE_Y : options.baseY },
        uNearNear: { value: options.nearNear == null ? 2 : options.nearNear },
        uNearFar: { value: options.nearFar == null ? 18 : options.nearFar },
        uTravelScale: { value: options.travelScale == null ? 0.22 : options.travelScale },
        uTravel: { value: 0 },
        uColorA: { value: new THREE.Color(0x1d8fb0) },
        uColorB: { value: new THREE.Color(0x2f4f7a) }
      },
      vertexShader: terrainVertexShader(),
      fragmentShader: particleFragmentShader(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
  }

  function createTerrainCloud() {
    var count = TERRAIN_POINT_COUNT;
    var positions = new Float32Array(count * 3);
    var slots = new Float32Array(count);
    var sides = new Float32Array(count);
    var laterals = new Float32Array(count);
    var rises = new Float32Array(count);
    var layers = new Float32Array(count);
    var tints = new Float32Array(count);
    var scales = new Float32Array(count);
    var seeds = new Float32Array(count);
    var cursor = 0;
    for (var slot = 0; slot < TERRAIN_SLOT_COUNT; slot++) {
      for (var layer = 0; layer < TERRAIN_LAYER_COUNT; layer++) {
        var config = TERRAIN_LAYER_CONFIG[layer];
        // 山脊的高低与横向位置都沿路缓慢变化，逐槽随机只会散成一团雾。
        var peakNoise = Math.abs(valueNoise1D(slot * 0.021 + layer * 23.1, state.seed + 401));
        var peak = 0.30 + peakNoise * 1.10;
        var contourCenter = 0.44 + valueNoise1D(slot * 0.018 + layer * 11.3, state.seed + 571) * 0.26;
        var ridgeLateral = config.lateral + config.spread * contourCenter;
        var ridgeHeight = config.height * peak;
        for (var sideIndex = 0; sideIndex < 2; sideIndex++) {
          for (var row = 0; row < TERRAIN_ROW_POINTS; row++) {
            // 点集中在山脊附近，下方留一小段当坡脚，剪影才立得住。
            var t = 0.46 + 0.54 * (row / (TERRAIN_ROW_POINTS - 1));
            var wobble = 0.94 + 0.12 * Math.sin(t * 6.1 + slot * 0.37 + layer * 1.9);
            slots[cursor] = slot;
            sides[cursor] = sideIndex ? 1 : -1;
            laterals[cursor] = ridgeLateral + t * config.spread * 0.30;
            rises[cursor] = ridgeHeight * t * wobble;
            layers[cursor] = layer;
            tints[cursor] = clamp01(config.tint + t * 0.30 + hash1(slot * 31 + row + layer * 7, state.seed + 137) * 0.06);
            scales[cursor] = config.size * (1.06 - t * 0.30) * (0.9 + (hash1(slot * 17 + row + layer * 5, state.seed + 251) + 1) * 0.16);
            seeds[cursor] = (hash1(slot * 13 + row + layer * 97, state.seed + 311) + 1) * 0.5;
            cursor += 1;
          }
        }
      }
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSlot', new THREE.BufferAttribute(slots, 1));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    geometry.setAttribute('aLateral', new THREE.BufferAttribute(laterals, 1));
    geometry.setAttribute('aRise', new THREE.BufferAttribute(rises, 1));
    geometry.setAttribute('aLayer', new THREE.BufferAttribute(layers, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.computeBoundingSphere();
    var material = createTerrainMaterial();
    var points = new THREE.Points(geometry, material);
    points.name = 'highway-particles-terrain';
    points.frustumCulled = false;
    // 必须排在 shoulder 之后：那层地坪是半透明实色，先画就会被它整片盖掉。
    points.renderOrder = 1;
    state.terrainCloud = {
      points: points,
      geometry: geometry,
      material: material,
      count: count,
      positions: positions
    };
    state.root.add(points);
  }

  function updateTerrainCloud() {
    var cloud = state.terrainCloud;
    if (!cloud) return;
    var uniforms = cloud.material.uniforms;
    uniforms.uTravel.value = state.travel;
    uniforms.uBandLow.value = state.bands[2] * 0.72 + state.bands[3] * 0.28;
    uniforms.uBandHigh.value = state.bands[5] * 0.64 + state.bands[6] * 0.36;
    if (state.voidDustCloud) state.voidDustCloud.material.uniforms.uTravel.value = state.travel;
    var dustUniforms = state.groundDustCloud && state.groundDustCloud.material.uniforms;
    if (dustUniforms) {
      dustUniforms.uTravel.value = state.travel;
      dustUniforms.uBandLow.value = state.bands[1] * 0.6;
      dustUniforms.uBandHigh.value = state.bands[4] * 0.6;
    }
  }

  // 路肩外的地面散一层细尘，否则那层纯色地坪会像一块贴在画面上的色板。
  function createGroundDustCloud() {
    var count = GROUND_DUST_COUNT;
    var positions = new Float32Array(count * 3);
    var slots = new Float32Array(count);
    var sides = new Float32Array(count);
    var laterals = new Float32Array(count);
    var rises = new Float32Array(count);
    var layers = new Float32Array(count);
    var tints = new Float32Array(count);
    var scales = new Float32Array(count);
    var seeds = new Float32Array(count);
    for (var index = 0; index < count; index++) {
      slots[index] = (hash1(index, 1103) + 1) * 0.5 * TERRAIN_SLOT_COUNT;
      sides[index] = hash1(index, 1129) >= 0 ? 1 : -1;
      laterals[index] = 5.5 + (hash1(index, 1151) + 1) * 0.5 * 54;
      rises[index] = 0.15 + (hash1(index, 1171) + 1) * 0.5 * 3.0;
      layers[index] = 0;
      tints[index] = clamp01(0.10 + (hash1(index, 1193) + 1) * 0.28);
      scales[index] = 0.55 + (hash1(index, 1217) + 1) * 0.5 * 0.5;
      seeds[index] = (hash1(index, 1237) + 1) * 0.5;
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSlot', new THREE.BufferAttribute(slots, 1));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    geometry.setAttribute('aLateral', new THREE.BufferAttribute(laterals, 1));
    geometry.setAttribute('aRise', new THREE.BufferAttribute(rises, 1));
    geometry.setAttribute('aLayer', new THREE.BufferAttribute(layers, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.computeBoundingSphere();
    var material = createTerrainMaterial({ sizeK: 280, glow: 1.6, fogNear: 18, fogFar: 88, nearNear: 0.4, nearFar: 5 });
    var points = new THREE.Points(geometry, material);
    points.name = 'highway-particles-ground-dust';
    points.frustumCulled = false;
    points.renderOrder = 1;
    state.groundDustCloud = { points: points, geometry: geometry, material: material, count: count };
    state.root.add(points);
  }

  // 玻璃路面下面是空的，得给虚空一点内容：一层比地形跑得更快的光尘。
  // 路面是玻璃的，底下必须真有「深渊」：一层随相机走的深色地幕，边缘圆形渐隐接住天空。
  function createAbyssLayer() {
    var geometry = new THREE.PlaneGeometry(260, 260, 1, 1);
    var material = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uNight: { value: 0 },
        uColor: { value: new THREE.Color(0x050810) }
      },
      vertexShader: [
        'precision highp float;',
        'varying vec2 vUv;',
        'void main(){',
        '  vUv=uv;',
        '  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision highp float;',
        'uniform float uOpacity;',
        'uniform float uNight;',
        'uniform vec3 uColor;',
        'varying vec2 vUv;',
        'void main(){',
        '  float d=length(vUv-vec2(0.5));',
        '  float edge=1.0-smoothstep(0.22,0.50,d);',
        '  vec3 col=uColor;',
        '  gl_FragColor=vec4(col, edge*uOpacity*mix(0.82,0.95,uNight));',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'highway-abyss-floor';
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -2.42;
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    state.abyssFloor = mesh;
    state.abyssMaterial = material;
    state.root.add(mesh);
  }

  function createVoidDustCloud() {
    var count = VOID_DUST_COUNT;
    var positions = new Float32Array(count * 3);
    var slots = new Float32Array(count);
    var sides = new Float32Array(count);
    var laterals = new Float32Array(count);
    var rises = new Float32Array(count);
    var layers = new Float32Array(count);
    var tints = new Float32Array(count);
    var scales = new Float32Array(count);
    var seeds = new Float32Array(count);
    for (var index = 0; index < count; index++) {
      slots[index] = (hash1(index, 1301) + 1) * 0.5 * TERRAIN_SLOT_COUNT;
      sides[index] = hash1(index, 1327) >= 0 ? 1 : -1;
      laterals[index] = 1.2 + (hash1(index, 1361) + 1) * 0.5 * 46;
      rises[index] = (hash1(index, 1387) + 1) * 0.5 * 0.9;
      layers[index] = 0;
      tints[index] = clamp01(0.28 + (hash1(index, 1409) + 1) * 0.4);
      scales[index] = 0.55 + (hash1(index, 1433) + 1) * 0.5 * 0.75;
      seeds[index] = (hash1(index, 1451) + 1) * 0.5;
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSlot', new THREE.BufferAttribute(slots, 1));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    geometry.setAttribute('aLateral', new THREE.BufferAttribute(laterals, 1));
    geometry.setAttribute('aRise', new THREE.BufferAttribute(rises, 1));
    geometry.setAttribute('aLayer', new THREE.BufferAttribute(layers, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.computeBoundingSphere();
    var material = createTerrainMaterial({
      sizeK: 265,
      glow: 1.7,
      fogNear: 20,
      fogFar: 84,
      nearNear: 0.4,
      nearFar: 7,
      baseY: -2.55,
      travelScale: 0.36
    });
    var points = new THREE.Points(geometry, material);
    points.name = 'highway-particles-void-dust';
    points.frustumCulled = false;
    points.renderOrder = 0;
    state.voidDustCloud = { points: points, geometry: geometry, material: material, count: count };
    state.root.add(points);
  }

  function createFloraCloud() {
    var cloud = createParticleCloud(FLORA_POINT_COUNT, 'highway-particles-flora', {
      fogNear: 26,
      fogFar: 92,
      glow: 1.9,
      sizeK: 180,
      renderOrder: 2
    });
    var cursor = 0;
    for (var slot = 0; slot < FLORA_SLOT_COUNT; slot++) {
      for (var sideIndex = 0; sideIndex < 2; sideIndex++) {
        for (var bead = 0; bead < FLORA_BEADS; bead++) {
          cloud.tints[cursor] = clamp01(0.22 + bead * 0.13 + hash1(slot * 7 + bead, state.seed + 187) * 0.12);
          cloud.scales[cursor] = 1.05 + bead * 0.10;
          cloud.seeds[cursor] = (hash1(slot * 29 + bead + sideIndex * 53, state.seed + 233) + 1) * 0.5;
          cursor += 1;
        }
      }
    }
    state.floraCloud = cloud;
    state.root.add(cloud.points);
  }

  function updateFloraCloud() {
    var cloud = state.floraCloud;
    if (!cloud) return;
    var positions = cloud.positions;
    var cursor = 0;
    var spacing = ROAD_LENGTH / FLORA_SLOT_COUNT;
    for (var slot = 0; slot < FLORA_SLOT_COUNT; slot++) {
      var ahead = positiveModulo(slot * spacing - state.travel * 0.72, ROAD_LENGTH);
      var sample = localRoadSample(ahead);
      var distanceFade = 1 - smoothstep(ahead / ROAD_LENGTH);
      for (var sideIndex = 0; sideIndex < 2; sideIndex++) {
        var side = sideIndex ? 1 : -1;
        var jitter = hash1(slot * 19 + sideIndex * 71, state.seed + 353);
        var lateral = 7.4 + (hash1(slot * 23 + sideIndex * 61, state.seed + 419) + 1) * 3.4;
        var trunkHeight = 1.15 + (hash1(slot * 41 + sideIndex * 89, state.seed + 467) + 1) * 1.25;
        var baseY = ROAD_BASE_Y + sample.y - 0.05;
        var sway = Math.sin(state.time * 1.1 + slot * 0.7 + jitter * 2.0) * 0.06 * trunkHeight;
        for (var bead = 0; bead < FLORA_BEADS; bead++) {
          var t = (bead + 1) / FLORA_BEADS;
          var offset = cursor * 3;
          positions[offset] = sample.x + side * lateral + sway * t;
          positions[offset + 1] = baseY + trunkHeight * t * (0.82 + state.bands[4] * 0.30) * (0.6 + distanceFade * 0.4);
          positions[offset + 2] = -ahead - jitter * 1.6;
          cursor += 1;
        }
      }
    }
    cloud.geometry.attributes.position.needsUpdate = true;
  }

  function createMoteCloud() {
    var cloud = createParticleCloud(MOTE_COUNT, 'highway-particles-motes', {
      fogNear: 12,
      fogFar: 74,
      glow: 0.92,
      sizeK: 84,
      renderOrder: 6
    });
    for (var index = 0; index < MOTE_COUNT; index++) {
      cloud.scales[index] = 0.5 + (hash1(index, 617) + 1) * 0.62;
      cloud.seeds[index] = (hash1(index, 653) + 1) * 0.5;
      cloud.tints[index] = clamp01(0.5 + (hash1(index, 691) + 1) * 0.4);
      cloud.positions[index * 3] = hash1(index, 727) * 34;
      cloud.positions[index * 3 + 1] = -1.2 + (hash1(index, 761) + 1) * 7.4;
      cloud.positions[index * 3 + 2] = -2 - (hash1(index, 797) + 1) * 46;
    }
    cloud.geometry.attributes.position.needsUpdate = true;
    state.moteCloud = cloud;
    state.root.add(cloud.points);
  }

  function updateMoteCloud(dt) {
    var cloud = state.moteCloud;
    if (!cloud) return;
    var positions = cloud.positions;
    var span = 46;
    var drift = state.speed * dt * 1.35;
    for (var index = 0; index < MOTE_COUNT; index++) {
      var offset = index * 3;
      var depth = -(positions[offset + 2] || 1) - drift;
      if (depth < 1.5) depth += span;
      positions[offset + 2] = -depth;
      positions[offset] += Math.sin(state.time * 0.7 + index) * 0.004;
    }
    cloud.geometry.attributes.position.needsUpdate = true;
  }

  function createLampCloud() {
    var cloud = createParticleCloud(LIGHT_PAIR_COUNT * 2, 'highway-particles-lamps', {
      fogNear: 20,
      fogFar: 92,
      glow: 1.6,
      sizeK: 110,
      renderOrder: 4
    });
    for (var index = 0; index < LIGHT_PAIR_COUNT * 2; index++) {
      cloud.scales[index] = 1.7 + (index % 2 ? 0.1 : 0);
      cloud.seeds[index] = (hash1(index, 811) + 1) * 0.5;
      cloud.tints[index] = index % 2 ? 1 : 0;
    }
    state.lampCloud = cloud;
    state.root.add(cloud.points);

    var beamPositions = new Float32Array(LIGHT_PAIR_COUNT * 2 * 2 * 3);
    var beamGeometry = new THREE.BufferGeometry();
    beamGeometry.setAttribute('position', new THREE.BufferAttribute(beamPositions, 3));
    beamGeometry.computeBoundingSphere();
    state.poleMaterial = new THREE.LineBasicMaterial({
      color: 0x6f7f92,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    state.lampBeams = new THREE.LineSegments(beamGeometry, state.poleMaterial);
    state.lampBeams.name = 'highway-lamp-beams';
    state.lampBeams.frustumCulled = false;
    state.lampBeams.renderOrder = 3;
    state.lampBeamPositions = beamPositions;
    state.root.add(state.lampBeams);
  }

  function createGateClouds() {
    state.gateMaterial = createParticleMaterial({
      colorA: 0x26d9ff,
      colorB: 0xffad42,
      fogNear: 40,
      fogFar: 128,
      glow: 1.02,
      sizeK: 70
    });
    for (var index = 0; index < LANDMARK_NAMES.length; index++) {
      var positions = new Float32Array(GATE_POINT_COUNT * 3);
      var scales = new Float32Array(GATE_POINT_COUNT);
      var seeds = new Float32Array(GATE_POINT_COUNT);
      var tints = new Float32Array(GATE_POINT_COUNT);
      var cursor = 0;
      var radius = 6.4;
      var archCount = Math.floor(GATE_POINT_COUNT * 0.42);
      for (var arch = 0; arch < archCount; arch++) {
        var angle = Math.PI * (arch / (archCount - 1));
        positions[cursor * 3] = Math.cos(angle) * radius;
        positions[cursor * 3 + 1] = Math.sin(angle) * radius * 0.82;
        positions[cursor * 3 + 2] = Math.sin(angle * 2.0) * 0.5;
        scales[cursor] = 1.5 + (arch % 3) * 0.2;
        seeds[cursor] = arch / archCount;
        tints[cursor] = 0.24 + Math.sin(angle) * 0.5;
        cursor += 1;
      }
      while (cursor < GATE_POINT_COUNT) {
        var u = hash1(cursor * 3 + index * 17, 917);
        var v = (hash1(cursor * 5 + index * 23, 953) + 1) * 0.5;
        var span = Math.sqrt(Math.max(0, 1 - u * u)) * radius;
        positions[cursor * 3] = u * radius;
        positions[cursor * 3 + 1] = v * span * 0.82;
        positions[cursor * 3 + 2] = (hash1(cursor * 7 + index * 29, 991) + 1) * 0.6 - 0.3;
        scales[cursor] = 0.6 + (hash1(cursor, 1031) + 1) * 0.5;
        seeds[cursor] = v;
        tints[cursor] = clamp01(0.36 + v * 0.62);
        cursor += 1;
      }
      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
      geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
      geometry.computeBoundingSphere();
      var points = new THREE.Points(geometry, state.gateMaterial);
      points.name = 'highway-particles-gate-' + index;
      points.frustumCulled = false;
      points.visible = false;
      points.renderOrder = 5;
      state.root.add(points);
      state.gateClouds.push(points);
    }
  }

  function ensureLayer(scene) {
    if (state.initialized && state.scene === scene) return;
    clearLayer();
    if (!scene || typeof THREE === 'undefined') return;
    state.scene = scene;
    state.seed = state.seed || (Math.random() * 900 + 100);
    state.rollQuaternion = new THREE.Quaternion();
    state.rollAxis = new THREE.Vector3(0, 0, 1);
    state.root = new THREE.Group();
    state.root.name = 'highway-drive-root';

    createWeatherLayer();

    state.shoulderMaterial = new THREE.MeshBasicMaterial({ color: 0x020407, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    state.shoulder = new THREE.Mesh(buildShoulderGeometry(), state.shoulderMaterial);
    state.shoulder.frustumCulled = false;
    state.shoulder.renderOrder = -3;
    state.root.add(state.shoulder);

    state.roadMaterial = buildRoadMaterial();
    state.road = new THREE.Mesh(buildRoadGeometry(), state.roadMaterial);
    state.road.frustumCulled = false;
    state.road.renderOrder = -2;
    state.root.add(state.road);

    state.leftRail = buildRail(-1, 0x26d9ff);
    state.rightRail = buildRail(1, 0xffad42);
    state.leftRail.renderOrder = -1;
    state.rightRail.renderOrder = -1;
    state.root.add(state.leftRail);
    state.root.add(state.rightRail);

    createAbyssLayer();
    createTerrainCloud();
    createGroundDustCloud();
    createVoidDustCloud();
    createFloraCloud();
    createLampCloud();
    createMoteCloud();
    createGateClouds();

    state.root.visible = false;
    scene.add(state.root);
    state.initialized = true;
  }

  function roadBandForSide(side) {
    return Math.min(ROAD_BAND_COUNT - 1, Math.floor(Math.abs(clamp(Number(side) || 0, -1, 1)) * ROAD_BAND_COUNT));
  }

  function roadTrackLaneForSide(side) {
    var safeSide = clamp(Number(side) || 0, -1, 1);
    var nearestLane = 0;
    var nearestDistance = Infinity;
    for (var lane = 0; lane < ROAD_TRACK_LANE_COUNT; lane++) {
      var distance = Math.abs(safeSide - roadTrackLaneCenter(lane));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestLane = lane;
      }
    }
    return nearestLane;
  }

  function roadTrackLaneCenter(lane) {
    var safeLane = Math.max(0, Math.min(ROAD_TRACK_LANE_COUNT - 1, Math.round(Number(lane) || 0)));
    return ROAD_TRACK_LANE_CENTERS[safeLane];
  }

  function roadTrackLaneForBand(band) {
    var safeBand = Math.max(0, Math.min(ROAD_BAND_COUNT - 1, Math.round(Number(band) || 0)));
    for (var lane = 0; lane < ROAD_TRACK_LANE_COUNT; lane++) {
      if (ROAD_TRACK_LANE_BANDS[lane].indexOf(safeBand) >= 0) return lane;
    }
    return 0;
  }

  function spectrumHistorySlotForRow(row, head) {
    var safeRow = Math.max(0, Math.min(ROAD_SEGMENT_COUNT, Math.round(Number(row) || 0)));
    var safeHead = Math.round(Number(head) || 0);
    return positiveModulo(safeHead - (ROAD_SEGMENT_COUNT - safeRow), ROAD_SPECTRUM_SAMPLE_COUNT);
  }

  function spectrumPulseForBand(current, previous, band, beat, boost) {
    var safeBand = Math.max(0, Math.min(ROAD_BAND_COUNT - 1, Math.round(Number(band) || 0)));
    var lowWeight = 1 - safeBand / (ROAD_BAND_COUNT - 1);
    var onset = Math.max(0, clamp01(current) - clamp01(previous));
    var beatDrive = clamp01(beat) * (0.16 + lowWeight * 0.58);
    var boostDrive = clamp01(boost) * (0.08 + lowWeight * 0.34);
    return clamp01(onset * 3.2 + beatDrive + boostDrive);
  }

  function rhythmChartCueFrame(audio, previousBands, previousBeat, previousTrigger, cueAge, cooldown, dt) {
    audio = audio || {};
    var currentBands = audio.bands || [];
    var elapsed = clamp(Number(dt) || 0, 0, 0.1);
    var nextAge = Math.max(0, Number(cueAge) || 0) + elapsed;
    var nextCooldown = Math.max(0, (Number(cooldown) || 0) - elapsed);
    var onsetPeak = 0;
    var onsetTotal = 0;
    var bandTotal = 0;
    for (var band = 0; band < ROAD_BAND_COUNT; band++) {
      var current = clamp01(currentBands[band]);
      var previous = clamp01(previousBands && previousBands[band]);
      var onset = Math.max(0, current - previous);
      onsetPeak = Math.max(onsetPeak, onset);
      onsetTotal += onset;
      bandTotal += current;
    }
    var onsetStrength = clamp01(onsetPeak * 2.2 + onsetTotal / ROAD_BAND_COUNT * 1.6);
    var beat = clamp01(audio.beat);
    var trigger = clamp01(audio.trigger);
    var beatRise = Math.max(0, beat - clamp01(previousBeat));
    var triggerCandidate = trigger > ROAD_TRACK_ONSET_THRESHOLD && clamp01(previousTrigger) <= ROAD_TRACK_ONSET_THRESHOLD;
    var beatCandidate = beat > 0.18 && beatRise > 0.035;
    var onsetCandidate = onsetStrength >= ROAD_TRACK_ONSET_THRESHOLD;
    var activeEnergy = Math.max(clamp01(audio.energy), bandTotal / ROAD_BAND_COUNT);
    var fillGap = clamp(0.58 - activeEnergy * 0.20 - beat * 0.06, 0.34, 0.58);
    var fillCandidate = activeEnergy > 0.10 && nextAge >= fillGap;
    var emitted = nextCooldown <= 0 && (triggerCandidate || beatCandidate || onsetCandidate || fillCandidate);
    var strength = 0;
    if (emitted) {
      strength = Math.max(
        triggerCandidate ? trigger : 0,
        beatCandidate ? beat : 0,
        onsetCandidate ? onsetStrength : 0,
        fillCandidate ? 0.42 + activeEnergy * 0.30 : 0
      );
      strength = Math.max(0.34, clamp01(strength));
      nextAge = 0;
      nextCooldown = ROAD_TRACK_MIN_EVENT_GAP;
    }
    return {
      emitted: emitted,
      strength: strength,
      onsetStrength: onsetStrength,
      fillCandidate: fillCandidate,
      cueAge: nextAge,
      cooldown: nextCooldown
    };
  }

  function rhythmTrackEventFrame(currentBands, previousBands, previousTrackPulses, beat, trigger, eventIndex, lastLane) {
    var candidates = new Array(ROAD_BAND_COUNT);
    var eventStrength = clamp01(trigger);
    var eventBeat = clamp01(beat) * eventStrength;
    for (var band = 0; band < ROAD_BAND_COUNT; band++) {
      var current = clamp01(currentBands && currentBands[band]);
      var previous = clamp01(previousBands && previousBands[band]);
      candidates[band] = spectrumPulseForBand(current, previous, band, eventBeat, eventStrength);
    }
    var rankedBands = candidates.map(function (value, band) {
      return { band: band, value: value };
    }).sort(function (a, b) {
      return b.value - a.value || a.band - b.band;
    });
    var pulses = new Array(ROAD_TRACK_LANE_COUNT);
    for (var lane = 0; lane < ROAD_TRACK_LANE_COUNT; lane++) {
      var laneBands = ROAD_TRACK_LANE_BANDS[lane];
      var laneEnergy = Math.max(
        clamp01(currentBands && currentBands[laneBands[0]]),
        clamp01(currentBands && currentBands[laneBands[1]])
      );
      pulses[lane] = clamp01(previousTrackPulses && previousTrackPulses[lane]) * (laneEnergy > 0.18 ? 0.62 : 0.36);
    }
    var safeEventIndex = Math.max(0, Math.floor(Number(eventIndex) || 0));
    var safeLastLane = Number(lastLane);
    var eventLanes = [];
    if (eventStrength > 0.28 && rankedBands.length) {
      var dominantLane = roadTrackLaneForBand(rankedBands[0].band);
      var sequenceLane = ROAD_TRACK_LANE_SEQUENCE[safeEventIndex % ROAD_TRACK_LANE_SEQUENCE.length];
      var primaryLane = positiveModulo(sequenceLane + dominantLane, ROAD_TRACK_LANE_COUNT);
      if (primaryLane === safeLastLane) {
        primaryLane = positiveModulo(primaryLane + (safeEventIndex % 2 === 0 ? 1 : -1), ROAD_TRACK_LANE_COUNT);
      }
      pulses[primaryLane] = Math.max(pulses[primaryLane], 0.68 + eventStrength * 0.32);
      eventLanes.push(primaryLane);
      if (eventStrength > 0.86 && safeEventIndex % 6 === 5) {
        var secondaryLane = positiveModulo(primaryLane + 2, ROAD_TRACK_LANE_COUNT);
        pulses[secondaryLane] = Math.max(pulses[secondaryLane], 0.52 + eventStrength * 0.28);
        eventLanes.push(secondaryLane);
      }
      safeEventIndex++;
      safeLastLane = primaryLane;
    }
    return {
      pulses: pulses,
      eventLanes: eventLanes,
      nextEventIndex: safeEventIndex,
      lastLane: isFinite(safeLastLane) ? safeLastLane : -1
    };
  }

  function resetSpectrumHistory() {
    state.spectrumEnergyHistory = new Float32Array(ROAD_SPECTRUM_SAMPLE_COUNT * ROAD_BAND_COUNT);
    state.spectrumPulseHistory = new Float32Array(ROAD_SPECTRUM_SAMPLE_COUNT * ROAD_BAND_COUNT);
    state.trackPulseHistory = new Float32Array(ROAD_SPECTRUM_SAMPLE_COUNT * ROAD_TRACK_LANE_COUNT);
    state.spectrumHead = -1;
    state.spectrumSamples = 0;
    state.spectrumDistance = 0;
    state.spectrumWavePeak = 0;
    state.trackNotePeak = 0;
    state.spectrumEventLanePeak = 0;
    state.pendingTrigger = 0;
    state.trackEventIndex = 0;
    state.lastTrackLane = -1;
    state.trackVisitedMask = 0;
    state.trackCueAge = 0;
    state.trackCueCooldown = 0;
    state.trackPreviousBeat = 0;
    state.trackPreviousBands = [0, 0, 0, 0, 0, 0, 0, 0];
  }

  function pushSpectrumHistorySample() {
    if (!state.spectrumEnergyHistory || !state.spectrumPulseHistory || !state.trackPulseHistory) resetSpectrumHistory();
    var previousHead = state.spectrumHead;
    var nextHead = positiveModulo(previousHead + 1, ROAD_SPECTRUM_SAMPLE_COUNT);
    var nextEnergyOffset = nextHead * ROAD_BAND_COUNT;
    var previousEnergyOffset = previousHead >= 0 ? previousHead * ROAD_BAND_COUNT : -1;
    var nextPulseOffset = nextHead * ROAD_BAND_COUNT;
    var previousPulseOffset = previousHead >= 0 ? previousHead * ROAD_BAND_COUNT : -1;
    var nextTrackOffset = nextHead * ROAD_TRACK_LANE_COUNT;
    var previousTrackOffset = previousHead >= 0 ? previousHead * ROAD_TRACK_LANE_COUNT : -1;
    var currentBands = new Array(ROAD_BAND_COUNT);
    var previousBands = new Array(ROAD_BAND_COUNT);
    for (var band = 0; band < ROAD_BAND_COUNT; band++) {
      var energy = clamp01(state.bands[band]);
      var previous = previousEnergyOffset >= 0 ? state.spectrumEnergyHistory[previousEnergyOffset + band] : 0;
      currentBands[band] = energy;
      previousBands[band] = previous;
      state.spectrumEnergyHistory[nextEnergyOffset + band] = energy;
      var previousPulse = previousPulseOffset >= 0 ? state.spectrumPulseHistory[previousPulseOffset + band] : 0;
      var detectedPulse = spectrumPulseForBand(energy, previous, band, state.beat, Math.max(state.boost * 0.42, state.pendingTrigger * 0.68));
      state.spectrumPulseHistory[nextPulseOffset + band] = Math.max(detectedPulse, previousPulse * 0.58);
    }
    var previousTrackPulses = new Array(ROAD_TRACK_LANE_COUNT);
    for (var lane = 0; lane < ROAD_TRACK_LANE_COUNT; lane++) {
      previousTrackPulses[lane] = previousTrackOffset >= 0 ? state.trackPulseHistory[previousTrackOffset + lane] : 0;
    }
    var trackFrame = rhythmTrackEventFrame(
      currentBands,
      previousBands,
      previousTrackPulses,
      state.beat,
      state.pendingTrigger,
      state.trackEventIndex,
      state.lastTrackLane
    );
    for (var pulseLane = 0; pulseLane < ROAD_TRACK_LANE_COUNT; pulseLane++) {
      state.trackPulseHistory[nextTrackOffset + pulseLane] = trackFrame.pulses[pulseLane];
    }
    state.trackEventIndex = trackFrame.nextEventIndex;
    state.lastTrackLane = trackFrame.lastLane;
    state.spectrumEventLanePeak = Math.max(state.spectrumEventLanePeak, trackFrame.eventLanes.length);
    for (var eventLaneIndex = 0; eventLaneIndex < trackFrame.eventLanes.length; eventLaneIndex++) {
      state.trackVisitedMask |= 1 << trackFrame.eventLanes[eventLaneIndex];
    }
    state.pendingTrigger = 0;
    state.spectrumHead = nextHead;
    state.spectrumSamples = Math.min(ROAD_SPECTRUM_SAMPLE_COUNT, state.spectrumSamples + 1);
  }

  function advanceSpectrumHistory(distance) {
    if (!state.spectrumEnergyHistory || !state.spectrumPulseHistory || !state.trackPulseHistory) resetSpectrumHistory();
    if (state.spectrumSamples === 0) pushSpectrumHistorySample();
    state.spectrumDistance += Math.max(0, Number(distance) || 0);
    var steps = Math.min(ROAD_SPECTRUM_SAMPLE_COUNT, Math.floor(state.spectrumDistance / ROAD_SPECTRUM_STEP));
    for (var index = 0; index < steps; index++) pushSpectrumHistorySample();
    state.spectrumDistance -= steps * ROAD_SPECTRUM_STEP;
  }

  function historyValueAtRow(row, channel, history, stride) {
    if (state.spectrumHead < 0) return 0;
    var slot = spectrumHistorySlotForRow(row, state.spectrumHead);
    var safeChannel = Math.max(0, Math.min(stride - 1, Math.round(Number(channel) || 0)));
    var offset = slot * stride + safeChannel;
    if (!history) return 0;
    var current = history[offset] || 0;
    if (row >= ROAD_SEGMENT_COUNT) return current;
    var nextSlot = spectrumHistorySlotForRow(row + 1, state.spectrumHead);
    var next = history[nextSlot * stride + safeChannel] || 0;
    var phase = clamp01(state.spectrumDistance / ROAD_SPECTRUM_STEP);
    return current + (next - current) * phase;
  }

  function spectrumValueAtRow(row, band) {
    return historyValueAtRow(row, band, state.spectrumEnergyHistory, ROAD_BAND_COUNT);
  }

  function spectrumPulseValueAtRow(row, band) {
    return historyValueAtRow(row, band, state.spectrumPulseHistory, ROAD_BAND_COUNT);
  }

  function trackPulseValueAtRow(row, lane) {
    return historyValueAtRow(row, lane, state.trackPulseHistory, ROAD_TRACK_LANE_COUNT);
  }

  function spectrumTrackLaneValueAtRow(row, lane, pulse) {
    var safeLane = Math.max(0, Math.min(ROAD_TRACK_LANE_COUNT - 1, Math.round(Number(lane) || 0)));
    if (pulse) return trackPulseValueAtRow(row, safeLane);
    var laneBands = ROAD_TRACK_LANE_BANDS[safeLane];
    return Math.max(
      spectrumValueAtRow(row, laneBands[0]),
      spectrumValueAtRow(row, laneBands[1])
    );
  }

  function updateRoadGeometry() {
    var step = ROAD_SPECTRUM_STEP;
    var rowSamples = new Array(ROAD_SEGMENT_COUNT + 1);
    state.spectrumWavePeak = 0;
    state.trackNotePeak = 0;
    for (var row = 0; row <= ROAD_SEGMENT_COUNT; row++) {
      var ahead = ROAD_NEAR + row * step;
      rowSamples[row] = localRoadSample(ahead);
      var distanceFade = 1 - smoothstep(ahead / ROAD_LENGTH);
      for (var column = 0; column < ROAD_COLUMN_COUNT; column++) {
        var vertex = row * ROAD_COLUMN_COUNT + column;
        var side = -1 + column * 2 / (ROAD_COLUMN_COUNT - 1);
        var trackLane = roadTrackLaneForSide(side);
        var band = roadBandForSide(side);
        var bandEnergy = spectrumValueAtRow(row, band);
        var bandPulse = spectrumPulseValueAtRow(row, band);
        var trackPulse = trackPulseValueAtRow(row, trackLane);
        var sideAmount = Math.abs(side);
        var ripple = Math.sin((state.travel + ahead) * (0.46 + band * 0.018) - state.time * (2.2 + band * 0.08) + band * 0.86);
        var beatRidge = Math.sin((state.travel + ahead) * 0.74 - state.time * 4.4);
        var energyLift = bandEnergy * (0.036 + sideAmount * 0.075) * ripple;
        var beatLift = state.beat * 0.026 * beatRidge;
        var pulseLift = bandPulse * (0.020 + sideAmount * 0.042);
        var trackLift = trackPulse * (0.040 + sideAmount * 0.032);
        var lift = (energyLift + beatLift + pulseLift + trackLift) * distanceFade;
        var offset = vertex * 3;
        state.roadPositions[offset] = rowSamples[row].x + side * ROAD_HALF_WIDTH;
        state.roadPositions[offset + 1] = ROAD_BASE_Y + rowSamples[row].y + lift;
        state.roadPositions[offset + 2] = -ahead;
        state.roadEnergy[vertex] = bandEnergy;
        state.roadPulse[vertex] = bandPulse;
        state.roadTrackPulse[vertex] = trackPulse;
        state.spectrumWavePeak = Math.max(state.spectrumWavePeak, bandPulse);
        state.trackNotePeak = Math.max(state.trackNotePeak, trackPulse);
      }
      var shoulderOffset = row * 6;
      state.shoulderPositions[shoulderOffset] = rowSamples[row].x - SHOULDER_HALF_WIDTH;
      state.shoulderPositions[shoulderOffset + 1] = ROAD_BASE_Y + rowSamples[row].y - 0.045;
      state.shoulderPositions[shoulderOffset + 2] = -ahead;
      state.shoulderPositions[shoulderOffset + 3] = rowSamples[row].x + SHOULDER_HALF_WIDTH;
      state.shoulderPositions[shoulderOffset + 4] = ROAD_BASE_Y + rowSamples[row].y - 0.045;
      state.shoulderPositions[shoulderOffset + 5] = -ahead;
    }
    state.road.geometry.attributes.position.needsUpdate = true;
    state.road.geometry.attributes.aBandEnergy.needsUpdate = true;
    state.road.geometry.attributes.aBandPulse.needsUpdate = true;
    state.road.geometry.attributes.aTrackPulse.needsUpdate = true;
    state.shoulder.geometry.attributes.position.needsUpdate = true;
    updateRails(rowSamples, step);
  }

  function updateRails(rowSamples, step) {
    for (var row = 0; row < ROAD_SEGMENT_COUNT; row++) {
      var aheadA = ROAD_NEAR + row * step;
      var aheadB = aheadA + step;
      var leftOffset = row * 6;
      var leftEnergyA = spectrumTrackLaneValueAtRow(row, 0, false);
      var leftEnergyB = spectrumTrackLaneValueAtRow(row + 1, 0, false);
      var rightEnergyA = spectrumTrackLaneValueAtRow(row, ROAD_TRACK_LANE_COUNT - 1, false);
      var rightEnergyB = spectrumTrackLaneValueAtRow(row + 1, ROAD_TRACK_LANE_COUNT - 1, false);
      var leftLiftA = 0.12 + leftEnergyA * 0.08 + spectrumTrackLaneValueAtRow(row, 0, true) * 0.12;
      var leftLiftB = 0.12 + leftEnergyB * 0.08 + spectrumTrackLaneValueAtRow(row + 1, 0, true) * 0.12;
      var rightLiftA = 0.12 + rightEnergyA * 0.08 + spectrumTrackLaneValueAtRow(row, ROAD_TRACK_LANE_COUNT - 1, true) * 0.12;
      var rightLiftB = 0.12 + rightEnergyB * 0.08 + spectrumTrackLaneValueAtRow(row + 1, ROAD_TRACK_LANE_COUNT - 1, true) * 0.12;
      state.leftRailPositions[leftOffset] = rowSamples[row].x - ROAD_HALF_WIDTH - 0.36;
      state.leftRailPositions[leftOffset + 1] = ROAD_BASE_Y + rowSamples[row].y + leftLiftA;
      state.leftRailPositions[leftOffset + 2] = -aheadA;
      state.leftRailPositions[leftOffset + 3] = rowSamples[row + 1].x - ROAD_HALF_WIDTH - 0.36;
      state.leftRailPositions[leftOffset + 4] = ROAD_BASE_Y + rowSamples[row + 1].y + leftLiftB;
      state.leftRailPositions[leftOffset + 5] = -aheadB;
      state.rightRailPositions[leftOffset] = rowSamples[row].x + ROAD_HALF_WIDTH + 0.36;
      state.rightRailPositions[leftOffset + 1] = ROAD_BASE_Y + rowSamples[row].y + rightLiftA;
      state.rightRailPositions[leftOffset + 2] = -aheadA;
      state.rightRailPositions[leftOffset + 3] = rowSamples[row + 1].x + ROAD_HALF_WIDTH + 0.36;
      state.rightRailPositions[leftOffset + 4] = ROAD_BASE_Y + rowSamples[row + 1].y + rightLiftB;
      state.rightRailPositions[leftOffset + 5] = -aheadB;
    }
    state.leftRail.geometry.attributes.position.needsUpdate = true;
    state.rightRail.geometry.attributes.position.needsUpdate = true;
  }

  function updateRoadsideLights() {
    if (!state.lampCloud) return;
    var cloud = state.lampCloud;
    var positions = cloud.positions;
    var beamPositions = state.lampBeamPositions;
    var loopLength = LIGHT_PAIR_COUNT * LIGHT_SPACING;
    var phase = state.travel % LIGHT_SPACING;
    for (var index = 0; index < LIGHT_PAIR_COUNT; index++) {
      var ahead = 4.6 + index * LIGHT_SPACING - phase;
      if (ahead < ROAD_NEAR + 1.2) ahead += loopLength;
      var sample = localRoadSample(ahead);
      var baseY = ROAD_BASE_Y + sample.y;
      var lampY = baseY + 1.5 + state.bands[5] * 0.24;
      for (var sideIndex = 0; sideIndex < 2; sideIndex++) {
        var side = sideIndex ? 1 : -1;
        var x = sample.x + side * (ROAD_HALF_WIDTH + 0.95);
        var lampIndex = index * 2 + sideIndex;
        positions[lampIndex * 3] = x;
        positions[lampIndex * 3 + 1] = lampY;
        positions[lampIndex * 3 + 2] = -ahead;
        var beamOffset = lampIndex * 6;
        beamPositions[beamOffset] = x;
        beamPositions[beamOffset + 1] = baseY - 0.05;
        beamPositions[beamOffset + 2] = -ahead;
        beamPositions[beamOffset + 3] = x;
        beamPositions[beamOffset + 4] = lampY;
        beamPositions[beamOffset + 5] = -ahead;
      }
    }
    cloud.geometry.attributes.position.needsUpdate = true;
    if (state.lampBeams) state.lampBeams.geometry.attributes.position.needsUpdate = true;
  }

  function setBlendedHexColor(target, currentHex, nextHex, blend) {
    var amount = clamp01(blend);
    target.setRGB(
      lerp((currentHex >> 16 & 255) / 255, (nextHex >> 16 & 255) / 255, amount),
      lerp((currentHex >> 8 & 255) / 255, (nextHex >> 8 & 255) / 255, amount),
      lerp((currentHex & 255) / 255, (nextHex & 255) / 255, amount)
    );
  }

  function applyBiomePalette(index, nextIndex, blend) {
    if (index < 0 || index >= BIOME_PALETTES.length) return;
    if (nextIndex == null || nextIndex < 0 || nextIndex >= BIOME_PALETTES.length) nextIndex = index;
    var palette = BIOME_PALETTES[index];
    var nextPalette = BIOME_PALETTES[nextIndex];
    if (state.shoulderMaterial) {
      setBlendedHexColor(state.shoulderMaterial.color, palette.ground, nextPalette.ground, blend);
      // 地坪只做底色，压到近黑才不会跟粒子抢视线。
      state.shoulderMaterial.color.multiplyScalar(0.16);
    }
    if (state.voidDustCloud) {
      setBlendedHexColor(state.voidDustCloud.material.uniforms.uColorA.value, palette.mountain, nextPalette.mountain, blend);
      setBlendedHexColor(state.voidDustCloud.material.uniforms.uColorB.value, palette.water, nextPalette.water, blend);
    }
    if (state.groundDustCloud) {
      setBlendedHexColor(state.groundDustCloud.material.uniforms.uColorA.value, palette.trunk, nextPalette.trunk, blend);
      setBlendedHexColor(state.groundDustCloud.material.uniforms.uColorB.value, palette.crown, nextPalette.crown, blend);
    }
    if (state.terrainCloud) {
      setBlendedHexColor(state.terrainCloud.material.uniforms.uColorA.value, palette.mound, nextPalette.mound, blend);
      setBlendedHexColor(state.terrainCloud.material.uniforms.uColorB.value, palette.mountain, nextPalette.mountain, blend);
    }
    if (state.floraCloud) {
      setBlendedHexColor(state.floraCloud.material.uniforms.uColorA.value, palette.trunk, nextPalette.trunk, blend);
      setBlendedHexColor(state.floraCloud.material.uniforms.uColorB.value, palette.crown, nextPalette.crown, blend);
    }
  }

  function biomeWaterForSide(index, beachWaterSide, side) {
    if (index === 1) return 1;
    if (index === 4 && beachWaterSide === side) return 1;
    return 0;
  }

  function syncBiomeTransition(distance) {
    var biome = biomeStateAtDistance(distance, state.seed);
    state.biomeIndex = biome.index;
    state.nextBiomeIndex = biome.nextIndex;
    state.biomeBlend = biome.blend;
    state.biomeFade = 1;
    applyBiomePalette(biome.index, biome.nextIndex, biome.blend);
    var currentBeachWaterSide = biome.zone % 2 ? -1 : 1;
    var nextBeachWaterSide = (biome.zone + 1) % 2 ? -1 : 1;
    state.leftWaterAmount = lerp(
      biomeWaterForSide(biome.index, currentBeachWaterSide, -1),
      biomeWaterForSide(biome.nextIndex, nextBeachWaterSide, -1),
      biome.blend
    );
    state.rightWaterAmount = lerp(
      biomeWaterForSide(biome.index, currentBeachWaterSide, 1),
      biomeWaterForSide(biome.nextIndex, nextBeachWaterSide, 1),
      biome.blend
    );
    return biome;
  }

  function updateWeather(dt) {
    if (!state.skyMaterial || !state.precipitationMaterial) return;
    var weather = weatherStateAtDistance(state.travel + ROAD_LENGTH * 0.34, state.seed);
    state.weatherIndex = weather.index;
    state.nextWeatherIndex = weather.nextIndex;
    state.weatherBlend = weather.blend;
    state.celestialIndex = celestialIndexForZone(weather.zone, state.seed);
    state.nextCelestialIndex = celestialIndexForZone(weather.zone + 1, state.seed);
    state.rainAmount = (weather.index === 2 ? 1 - weather.blend : 0) + (weather.nextIndex === 2 ? weather.blend : 0);
    state.snowAmount = (weather.index === 3 ? 1 - weather.blend : 0) + (weather.nextIndex === 3 ? weather.blend : 0);

    if (state.abyssMaterial) {
      var abyssCurrent = ABYSS_COLORS[weather.index] == null ? 0x04060f : ABYSS_COLORS[weather.index];
      var abyssNext = ABYSS_COLORS[weather.nextIndex] == null ? 0x04060f : ABYSS_COLORS[weather.nextIndex];
      setBlendedHexColor(state.abyssMaterial.uniforms.uColor.value, abyssCurrent, abyssNext, weather.blend);
      state.abyssMaterial.uniforms.uNight.value = lerp(weather.index >= 4 ? 1 : 0, weather.nextIndex >= 4 ? 1 : 0, weather.blend);
    }
    state.skyMaterial.uniforms.uTime.value = state.time;
    state.skyMaterial.uniforms.uMode.value = weather.index;
    state.skyMaterial.uniforms.uNextMode.value = weather.nextIndex;
    state.skyMaterial.uniforms.uBlend.value = weather.blend;
    state.precipitationMaterial.uniforms.uTime.value = state.time;
    state.precipitationMaterial.uniforms.uRain.value = state.rainAmount;
    state.precipitationMaterial.uniforms.uSnow.value = state.snowAmount;
    state.precipitation.visible = Math.max(state.rainAmount, state.snowAmount) > 0.01;
    updateCelestialLayer(weather, dt);
  }

  function updateLandscape(dt) {
    if (!state.terrainCloud) return;
    syncBiomeTransition(state.travel + ROAD_LENGTH * 0.34);
    updateTerrainCloud();
    updateFloraCloud();
    updateMoteCloud(dt);
  }

  function updateLandmarks() {
    if (!state.gateClouds.length) return;
    state.visibleLandmark = '';
    for (var index = 0; index < state.gateClouds.length; index++) {
      var gate = state.gateClouds[index];
      var placement = recycledWorldPlacement(index, GATE_SPACING, LANDMARK_NAMES.length, 96, state.travel, LANDMARK_PASS_DISTANCE);
      var ahead = placement.ahead;
      var visible = ahead >= -LANDMARK_PASS_DISTANCE && ahead <= ROAD_LENGTH + 6;
      gate.visible = visible;
      if (!visible) continue;
      var sample = localRoadSample(ahead);
      gate.position.set(sample.x, ROAD_BASE_Y + sample.y - 0.05, -ahead);
      gate.scale.setScalar(1 + state.beat * 0.10 + state.boost * 0.06);
      state.visibleLandmark = LANDMARK_NAMES[index];
    }
    if (state.gateMaterial) {
      state.gateMaterial.uniforms.uTime.value = state.time;
      state.gateMaterial.uniforms.uBeat.value = state.beat;
      state.gateMaterial.uniforms.uEnergy.value = state.bands[6];
    }
  }

  function targetRoadSpeed(audio, fx, lowDrive, boost, beat) {
    var speedControl = clamp(Number(fx && fx.speed) || 1, 0.25, 2.2);
    return (10.5 + speedControl * 5.8)
      + clamp01(audio && audio.energy) * 9.5
      + clamp01(lowDrive) * 8.6
      + clamp01(beat) * 7.2
      + clamp01(boost) * 15.5;
  }

  function updateAudioState(audio, fx, dt) {
    var intensity = clamp(Number(fx && fx.intensity) || 0.85, 0.1, 2.2);
    var chartCue = rhythmChartCueFrame(
      audio,
      state.trackPreviousBands,
      state.trackPreviousBeat,
      state.lastTrigger,
      state.trackCueAge,
      state.trackCueCooldown,
      dt
    );
    state.trackCueAge = chartCue.cueAge;
    state.trackCueCooldown = chartCue.cooldown;
    state.trackPreviousBeat = audio.beat;
    state.trackPreviousBands = audio.bands.slice();
    if (chartCue.emitted) state.pendingTrigger = Math.max(state.pendingTrigger, chartCue.strength);
    for (var index = 0; index < ROAD_BAND_COUNT; index++) {
      var target = clamp01(audio.bands[index]) * intensity;
      state.bands[index] = damp(state.bands[index], target, target > state.bands[index] ? 16 : 4.6, dt);
    }
    var triggerHit = audio.trigger > 0.28 && state.lastTrigger <= 0.28;
    if (triggerHit) {
      state.boost = Math.max(state.boost, 0.72 + audio.trigger * 0.28);
      state.pendingTrigger = Math.max(state.pendingTrigger, audio.trigger);
    }
    state.lastTrigger = audio.trigger;
    state.boost *= Math.exp(-2.9 * dt);
    state.beat = damp(state.beat, Math.max(audio.beat, audio.trigger * 0.84), audio.beat > state.beat ? 20 : 5.4, dt);
    var lowDrive = state.bands[0] * 0.48 + state.bands[1] * 0.52;
    var targetSpeed = targetRoadSpeed(audio, fx, lowDrive, state.boost, state.beat);
    state.speed = damp(state.speed, targetSpeed, targetSpeed > state.speed ? 7.8 : 2.4, dt);
  }

  function syncTheme(fx, dt) {
    var theme = readTheme(fx);
    var amount = 1 - Math.exp(-3.2 * Math.max(0.001, dt));
    var uniforms = state.roadMaterial.uniforms;
    uniforms.uPrimary.value.lerp(theme.primary, amount);
    uniforms.uSecondary.value.lerp(theme.secondary, amount);
    uniforms.uAccent.value.lerp(theme.accent, amount);
    state.leftRail.material.color.lerp(theme.primary, amount);
    state.rightRail.material.color.lerp(theme.secondary, amount);
    if (state.lampCloud) {
      state.lampCloud.material.uniforms.uColorA.value.lerp(theme.primary.clone().lerp(theme.accent, 0.24), amount);
      state.lampCloud.material.uniforms.uColorB.value.lerp(theme.secondary.clone().lerp(theme.accent, 0.18), amount);
    }
    if (state.moteCloud) state.moteCloud.material.uniforms.uColorA.value.lerp(theme.accent, amount * 0.7);
    if (state.gateMaterial) {
      state.gateMaterial.uniforms.uColorA.value.lerp(theme.primary, amount);
      state.gateMaterial.uniforms.uColorB.value.lerp(theme.secondary, amount);
    }
  }

  function syncParticleUniforms(particle, opacity, beat, energy, pixelRatio) {
    if (!particle) return;
    var uniforms = particle.material.uniforms;
    uniforms.uOpacity.value = opacity;
    uniforms.uBeat.value = beat;
    uniforms.uEnergy.value = energy;
    uniforms.uTime.value = state.time;
    if (pixelRatio) uniforms.uPixelRatio.value = pixelRatio;
  }

  function syncOpacity() {
    var opacity = clamp01(state.opacity);
    state.root.visible = opacity > 0.01;
    state.roadMaterial.uniforms.uOpacity.value = opacity;
    if (state.skyMaterial) state.skyMaterial.uniforms.uOpacity.value = opacity;
    if (state.precipitationMaterial) state.precipitationMaterial.uniforms.uOpacity.value = opacity;
    var celestialOpacity = opacity * state.celestialOpacity;
    if (state.celestialMaterial) state.celestialMaterial.opacity = celestialOpacity;
    if (state.celestialCoreMaterial) state.celestialCoreMaterial.opacity = celestialOpacity * 0.62;
    if (state.celestialRingMaterial) state.celestialRingMaterial.uniforms.uOpacity.value = celestialOpacity;
    state.shoulderMaterial.opacity = opacity * 0.06;
    if (state.abyssMaterial) state.abyssMaterial.uniforms.uOpacity.value = opacity * 0.92;
    state.leftRail.material.opacity = opacity * (0.78 + state.bands[6] * 0.22);
    state.rightRail.material.opacity = opacity * (0.78 + state.bands[5] * 0.22);
    if (state.poleMaterial) state.poleMaterial.opacity = opacity * 0.34;
    var worldOpacity = opacity * state.biomeFade;
    syncParticleUniforms(state.terrainCloud, worldOpacity * 0.62, state.beat, state.bands[2], state.pixelRatio);
    syncParticleUniforms(state.groundDustCloud, worldOpacity * 0.5, state.beat, state.bands[1], state.pixelRatio);
    syncParticleUniforms(state.voidDustCloud, opacity * 0.62, state.beat, state.bands[0], state.pixelRatio);
    syncParticleUniforms(state.floraCloud, worldOpacity * 0.74, state.beat, state.bands[4], state.pixelRatio);
    syncParticleUniforms(state.lampCloud, opacity * 0.95, state.beat, state.bands[6], state.pixelRatio);
    syncParticleUniforms(state.moteCloud, opacity * 0.72, state.beat, state.bands[7], state.pixelRatio);
    syncParticleUniforms(state.gateClouds.length ? { material: state.gateMaterial } : null, worldOpacity * 0.88, state.beat, state.bands[6], state.pixelRatio);
  }

  function clearLayer() {
    if (state.root && state.scene) state.scene.remove(state.root);
    var geometries = [];
    var materials = [];
    if (state.root) {
      state.root.traverse(function (object) {
        if (object.geometry && geometries.indexOf(object.geometry) === -1) geometries.push(object.geometry);
        var list = Array.isArray(object.material) ? object.material : [object.material];
        list.forEach(function (material) {
          if (material && materials.indexOf(material) === -1) materials.push(material);
        });
      });
    }
    geometries.forEach(function (geometry) { geometry.dispose(); });
    materials.forEach(function (material) { material.dispose(); });
    state.root = null;
    state.scene = null;
    state.road = null;
    state.roadMaterial = null;
    state.roadPositions = null;
    state.roadEnergy = null;
    state.roadPulse = null;
    state.roadTrackPulse = null;
    state.spectrumEnergyHistory = null;
    state.spectrumPulseHistory = null;
    state.trackPulseHistory = null;
    state.spectrumHead = -1;
    state.spectrumSamples = 0;
    state.spectrumDistance = 0;
    state.spectrumWavePeak = 0;
    state.trackNotePeak = 0;
    state.shoulder = null;
    state.leftRail = null;
    state.rightRail = null;
    state.poleMaterial = null;
    state.sky = null;
    state.skyMaterial = null;
    state.precipitation = null;
    state.precipitationMaterial = null;
    state.celestialRoot = null;
    state.celestialMesh = null;
    state.celestialMaterial = null;
    state.celestialSpriteMaterials = null;
    state.celestialCore = null;
    state.celestialCoreMaterial = null;
    state.celestialRing = null;
    state.celestialRingMaterial = null;
    state.abyssFloor = null;
    state.abyssMaterial = null;
    state.terrainCloud = null;
    state.groundDustCloud = null;
    state.voidDustCloud = null;
    state.floraCloud = null;
    state.lampCloud = null;
    state.moteCloud = null;
    state.gateMaterial = null;
    state.gateClouds = [];
    state.lampBeams = null;
    state.lampBeamPositions = null;
    state.biomeIndex = -1;
    state.nextBiomeIndex = -1;
    state.biomeBlend = 0;
    state.biomeFade = 0;
    state.leftWaterAmount = 0;
    state.rightWaterAmount = 0;
    state.weatherIndex = 0;
    state.nextWeatherIndex = 0;
    state.weatherBlend = 0;
    state.celestialIndex = 0;
    state.nextCelestialIndex = 0;
    state.activeCelestialIndex = -1;
    state.activeCelestialZone = -1;
    state.celestialOpacity = 0;
    state.celestialAxialTilt = 0;
    state.celestialAxisAzimuth = 0;
    state.celestialAxisX = 0;
    state.celestialAxisZ = 0;
    state.rainAmount = 0;
    state.snowAmount = 0;
    state.visibleLandmark = '';
    state.initialized = false;
    state.opacity = 0;
  }

  function isActive(fx) {
    return !!(fx && Number(fx.preset) === INDEX);
  }

  function syncShelfSuppression(active) {
    var manager = global.shelfManager;
    if (manager && typeof manager.setVisualSuppressed === 'function') manager.setVisualSuppressed(active);
  }

  function update(dt, ctx) {
    ctx = ctx || {};
    var fx = ctx.fx || {};
    var active = isActive(fx);
    syncShelfSuppression(active);
    state.opacity = damp(state.opacity, active ? 1 : 0, active ? 4.2 : 2.8, dt);
    if (!active && state.opacity < 0.01) {
      if (state.root) state.root.visible = false;
      return;
    }
    ensureLayer(ctx.scene);
    if (!state.root || !ctx.camera) return;
    state.pixelRatio = (typeof renderer !== 'undefined' && renderer && renderer.getPixelRatio)
      ? renderer.getPixelRatio()
      : (Number(global.devicePixelRatio) || 1);
    var audio = readAudio(ctx.audio);
    updateAudioState(audio, fx, dt);
    state.time += dt;
    state.travel += state.speed * dt;
    if (state.travel > 100000) state.travel -= 50000;
    advanceSpectrumHistory(state.speed * dt);
    state.root.position.copy(ctx.camera.position);
    state.root.quaternion.copy(ctx.camera.quaternion);
    var curveNow = roadCenterAt(state.travel + 18, state.seed) - roadCenterAt(state.travel - 18, state.seed);
    var targetRoll = clamp(-curveNow * 0.0009, -MAX_CAMERA_ROLL, MAX_CAMERA_ROLL);
    state.roll = damp(state.roll, targetRoll, CAMERA_ROLL_RESPONSE, dt);
    state.rollQuaternion.setFromAxisAngle(state.rollAxis, state.roll);
    state.root.quaternion.multiply(state.rollQuaternion);
    updateRoadGeometry();
    updateRoadsideLights();
    updateWeather(dt);
    updateLandscape(dt);
    updateLandmarks();
    syncTheme(fx, dt);
    state.roadMaterial.uniforms.uTime.value = state.time;
    state.roadMaterial.uniforms.uTravel.value = state.travel;
    state.roadMaterial.uniforms.uBeat.value = state.beat;
    state.roadMaterial.uniforms.uBoost.value = state.boost;
    syncOpacity();
  }

  function onPresetChange(prev, next, ctx) {
    syncShelfSuppression(next === INDEX);
    if (prev === INDEX && next !== INDEX) clearLayer();
    if (next === INDEX && ctx && ctx.scene) {
      state.seed = Math.random() * 900 + 100;
      state.travel = 0;
      state.time = 0;
      state.speed = 12;
      state.boost = 0;
      state.roll = 0;
      state.beat = 0;
      state.lastTrigger = 0;
      state.biomeIndex = -1;
      state.nextBiomeIndex = -1;
      state.biomeBlend = 0;
      state.biomeFade = 0;
      state.leftWaterAmount = 0;
      state.rightWaterAmount = 0;
      state.weatherIndex = 0;
      state.nextWeatherIndex = 0;
      state.weatherBlend = 0;
      state.celestialIndex = 0;
      state.nextCelestialIndex = 0;
      state.activeCelestialIndex = -1;
      state.activeCelestialZone = -1;
      state.celestialOpacity = 0;
      state.celestialAxialTilt = 0;
      state.celestialAxisAzimuth = 0;
      state.celestialAxisX = 0;
      state.celestialAxisZ = 0;
      state.rainAmount = 0;
      state.snowAmount = 0;
      state.visibleLandmark = '';
      state.bands = [0, 0, 0, 0, 0, 0, 0, 0];
      resetSpectrumHistory();
      ensureLayer(ctx.scene);
    }
  }

  function snapshot() {
    return {
      active: !!(state.root && state.root.visible),
      initialized: state.initialized,
      travel: state.travel,
      speed: state.speed,
      roll: state.roll,
      opacity: state.opacity,
      bands: state.bands.slice(),
      biome: state.biomeIndex >= 0 ? BIOME_NAMES[state.biomeIndex] : '',
      nextBiome: state.nextBiomeIndex >= 0 ? BIOME_NAMES[state.nextBiomeIndex] : '',
      biomeBlend: state.biomeBlend,
      leftWaterAmount: state.leftWaterAmount,
      rightWaterAmount: state.rightWaterAmount,
      weather: WEATHER_NAMES[state.weatherIndex] || '',
      nextWeather: WEATHER_NAMES[state.nextWeatherIndex] || '',
      weatherBlend: state.weatherBlend,
      celestial: state.celestialOpacity > 0.01 && state.activeCelestialIndex >= 0 ? CELESTIAL_NAMES[state.activeCelestialIndex] || '' : '',
      nextCelestial: state.nextWeatherIndex >= 4 ? CELESTIAL_NAMES[state.nextCelestialIndex] || '' : '',
      celestialSide: state.activeCelestialZone >= 0 && state.celestialRoot ? (state.celestialRoot.position.x < 0 ? 'left' : 'right') : '',
      celestialPosition: state.activeCelestialZone >= 0 && state.celestialRoot ? {
        x: state.celestialRoot.position.x,
        y: state.celestialRoot.position.y,
        z: state.celestialRoot.position.z
      } : null,
      celestialAxialTilt: state.celestialAxialTilt,
      celestialAxisAzimuth: state.celestialAxisAzimuth,
      celestialAxis: state.activeCelestialZone >= 0 ? { x: state.celestialAxisX, z: state.celestialAxisZ } : null,
      celestialClouds: state.celestialSpriteMaterials ? state.celestialSpriteMaterials.length : 0,
      celestialRingParticles: state.celestialRing ? state.celestialRing.geometry.attributes.position.count : 0,
      celestialMeshCount: state.celestialMesh ? 1 + (state.celestialRing ? 1 : 0) : 0,
      rainAmount: state.rainAmount,
      snowAmount: state.snowAmount,
      precipitationCount: state.precipitation ? PRECIPITATION_COUNT : 0,
      visibleLandmark: state.visibleLandmark,
      terrainParticles: state.terrainCloud ? state.terrainCloud.count : 0,
      groundDustParticles: state.groundDustCloud ? state.groundDustCloud.count : 0,
      voidDustParticles: state.voidDustCloud ? state.voidDustCloud.count : 0,
      floraParticles: state.floraCloud ? state.floraCloud.count : 0,
      moteParticles: state.moteCloud ? state.moteCloud.count : 0,
      roadVertices: (ROAD_SEGMENT_COUNT + 1) * ROAD_COLUMN_COUNT,
      roadWaveVertices: state.roadPulse ? state.roadPulse.length : 0,
      roadTrackVertices: state.roadTrackPulse ? state.roadTrackPulse.length : 0,
      spectrumHistorySamples: state.spectrumSamples,
      spectrumWavePeak: state.spectrumWavePeak,
      trackNotePeak: state.trackNotePeak,
      spectrumEventLanePeak: state.spectrumEventLanePeak,
      trackEventCount: state.trackEventIndex,
      trackVisitedLanes: [0, 1, 2, 3].filter(function (lane) { return state.trackVisitedMask & (1 << lane); }).length,
      lastTrackLane: state.lastTrackLane,
      spectrumTravelPhase: clamp01(state.spectrumDistance / ROAD_SPECTRUM_STEP),
      lightPairs: LIGHT_PAIR_COUNT
    };
  }

  global.MineradioHighwayDrive = {
    INDEX: INDEX,
    isActive: isActive,
    update: update,
    clear: clearLayer,
    onPresetChange: onPresetChange,
    snapshot: snapshot,
    _test: {
      roadCenterAt: roadCenterAt,
      roadElevationAt: roadElevationAt,
      roadBandForSide: roadBandForSide,
      roadTrackLaneForSide: roadTrackLaneForSide,
      roadTrackLaneCenter: roadTrackLaneCenter,
      roadTrackLaneForBand: roadTrackLaneForBand,
      spectrumHistorySlotForRow: spectrumHistorySlotForRow,
      spectrumPulseForBand: spectrumPulseForBand,
      rhythmChartCueFrame: rhythmChartCueFrame,
      rhythmTrackEventFrame: rhythmTrackEventFrame,
      biomeIndexAtDistance: biomeIndexAtDistance,
      biomeStateAtDistance: biomeStateAtDistance,
      weatherStateAtDistance: weatherStateAtDistance,
      celestialIndexForZone: celestialIndexForZone,
      celestialConfigs: CELESTIAL_CONFIG.map(function (config) {
        return { radius: config.radius, flatten: config.flatten, color: config.color, glow: config.glow == null ? 1 : config.glow, ring: !!config.ring };
      }),
      celestialPositionForZone: celestialPositionForZone,
      celestialAxialTiltForZone: celestialAxialTiltForZone,
      landmarkIndexAtDistance: landmarkIndexAtDistance,
      recycledWorldPlacement: recycledWorldPlacement,
      readAudio: readAudio,
      targetRoadSpeed: targetRoadSpeed,
      setJourneyForQa: function (distance, seed) {
        state.travel = Math.max(0, Number(distance) || 0);
        if (seed != null) state.seed = Number(seed) || 0;
        syncBiomeTransition(state.travel + ROAD_LENGTH * 0.34);
        var weather = weatherStateAtDistance(state.travel + ROAD_LENGTH * 0.34, state.seed);
        state.weatherIndex = weather.index;
        state.nextWeatherIndex = weather.nextIndex;
        state.weatherBlend = weather.blend;
        state.celestialIndex = celestialIndexForZone(weather.zone, state.seed);
        state.nextCelestialIndex = celestialIndexForZone(weather.zone + 1, state.seed);
      },
      constants: {
        segmentCount: ROAD_SEGMENT_COUNT,
        columnCount: ROAD_COLUMN_COUNT,
        bandCount: ROAD_BAND_COUNT,
        spectrumSampleCount: ROAD_SPECTRUM_SAMPLE_COUNT,
        trackMaxEventLanes: ROAD_TRACK_MAX_EVENT_LANES,
        trackMinEventGap: ROAD_TRACK_MIN_EVENT_GAP,
        trackOnsetThreshold: ROAD_TRACK_ONSET_THRESHOLD,
        trackLaneCount: ROAD_TRACK_LANE_COUNT,
        trackLaneBands: ROAD_TRACK_LANE_BANDS.map(function (bands) { return bands.slice(); }),
        lightPairCount: LIGHT_PAIR_COUNT,
        terrainSlotCount: TERRAIN_SLOT_COUNT,
        terrainLayerCount: TERRAIN_LAYER_COUNT,
        terrainPointCount: TERRAIN_POINT_COUNT,
        floraPointCount: FLORA_POINT_COUNT,
        moteCount: MOTE_COUNT,
        groundDustCount: GROUND_DUST_COUNT,
        voidDustCount: VOID_DUST_COUNT,
        gatePointCount: GATE_POINT_COUNT,
        gateSpacing: GATE_SPACING,
        biomeZoneLength: BIOME_ZONE_LENGTH,
        biomeNames: BIOME_NAMES.slice(),
        weatherNames: WEATHER_NAMES.slice(),
        celestialNames: CELESTIAL_NAMES.slice(),
        weatherTransitionStart: WEATHER_TRANSITION_START,
        precipitationCount: PRECIPITATION_COUNT,
        landmarkNames: LANDMARK_NAMES.slice(),
        landmarkSpacing: LANDMARK_SPACING,
        landmarkPassDistance: LANDMARK_PASS_DISTANCE,
        maxCameraRoll: MAX_CAMERA_ROLL,
        cameraRollResponse: CAMERA_ROLL_RESPONSE
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
