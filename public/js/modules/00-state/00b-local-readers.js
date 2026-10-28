// 本地存档读取器：把「从 localStorage 读出一份用户状态」的函数，连同它们的赋值，集中到
// 00-core-stores 之后的这一处。
//
// 为什么必须单独一层：00-core-stores 在顶层就要 `var customCoverMap = readCustomCoverMap()`，
// 而这些 reader 原本散在 05-playback / 02-visual / 03-beat / 07-fx。整包拼接时靠跨文件函数提升
// 侥幸能跑，拆成分文件就全是 ReferenceError——而且第一处抛错会中断 00-core-stores 后续所有赋值，
// 于是 customLyricFonts、listenStatsState 这类状态集体变成 undefined，表面上炸出十几条不相干
// 的错。本文件排在 00-core-stores 之后，所以它引用的 STORE_KEY 常量都已就位。
//
// Why this layer exists: 00-core-stores evaluates `var customCoverMap = readCustomCoverMap()` at
// top level, while those readers lived in 05-playback / 02-visual / 03-beat / 07-fx. Concatenation
// survived on cross-file hoisting; split injection does not. Worse, the first throw aborts every
// later assignment in 00-core-stores, so customLyricFonts / listenStatsState quietly become
// undefined and the console fills with errors that look unrelated.
//
// 注意：这里的 i18n 访问器是本文件自带的 localReadersText，不借用 02-visual/05 的同款——那个
// 模块在本文件之后才加载，指过去又会变成一处后向引用。
// The i18n accessor here is local on purpose: borrowing the one from 02-visual/05 would recreate
// the very backward reference this file exists to remove.

function localReadersText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === 'object') {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}

// 原 05-playback/01-cover-custom-map.js
function readCustomCoverMap() {
  try {
    var raw = localStorage.getItem(CUSTOM_COVER_STORE_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

// 原 05-playback/06-track-detail-lyrics-actions.js
function readCustomLyricMap() {
  try {
    var raw = JSON.parse(localStorage.getItem(CUSTOM_LYRIC_STORE_KEY) || '{}') || {};
    var out = {};
    Object.keys(raw).forEach(function (key) {
      var item = raw[key];
      if (typeof item === 'string') out[key] = { text: item, updatedAt: 0 };
      else if (item && typeof item.text === 'string') out[key] = { text: item.text, updatedAt: item.updatedAt || 0 };
    });
    return out;
  } catch (e) {
    return {};
  }
}

// 原 05-playback/06-track-detail-lyrics-actions.js
function readCustomLyricPrefs() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_LYRIC_PREF_STORE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}

// 原 02-visual/05-lyrics-fonts-texture.js
function normalizeCustomLyricFontName(name) {
  name = String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (name || localReadersText('lyfonts_custom')).slice(0, 18);
}

// 原 02-visual/05-lyrics-fonts-texture.js
function normalizeCustomLyricFontRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var id = String(raw.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  var dataUrl = String(raw.dataUrl || '');
  if (!id || !/^data:(font\/(ttf|otf|woff2?|sfnt)|application\/(font-woff|x-font-ttf|x-font-otf|octet-stream)|application\/vnd\.ms-fontobject);base64,/i.test(dataUrl)) return null;
  return {
    id: id,
    name: normalizeCustomLyricFontName(raw.name),
    family: String(raw.family || ('MineradioCustomLyricFont-' + id)).replace(/["\\]/g, '').slice(0, 72) || ('MineradioCustomLyricFont-' + id),
    dataUrl: dataUrl,
    size: Math.max(0, Number(raw.size) || 0),
    savedAt: Math.max(0, Number(raw.savedAt) || Date.now())
  };
}

// 原 02-visual/05-lyrics-fonts-texture.js
function readCustomLyricFonts() {
  try {
    var raw = JSON.parse(localStorage.getItem(CUSTOM_LYRIC_FONT_STORE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeCustomLyricFontRecord).filter(Boolean).slice(0, CUSTOM_LYRIC_FONT_MAX_COUNT);
  } catch (e) {
    return [];
  }
}

// 原 03-beat/03-local-beat-cache-modal.js
function unpackLocalBeatEvent(row) {
  if (typeof row === 'number') return row;
  if (!Array.isArray(row)) return row;
  var flags = row[8] || 0;
  return {
    time: row[0] || 0,
    strength: row[1] == null ? 0.42 : row[1],
    confidence: row[2] == null ? 0.72 : row[2],
    impact: row[3] == null ? (row[1] || 0.42) : row[3],
    low: row[4] == null ? 0.62 : row[4],
    body: row[5] == null ? 0.22 : row[5],
    snap: row[6] == null ? 0.16 : row[6],
    combo: LOCAL_BEAT_COMBOS[row[7] || 0] || undefined,
    primary: !!(flags & 1),
    camera: !!(flags & 2),
    pulse: !!(flags & 4),
    dj: !!(flags & 8),
    grid: !!(flags & 16),
    kickOnly: !!(flags & 32),
    mass: row[9] == null ? 0.62 : row[9],
    sharpness: row[10] == null ? 0.12 : row[10],
    step: row[11] || 0
  };
}

// 原 03-beat/03-local-beat-cache-modal.js
function unpackLocalBeatMap(stored) {
  if (!stored) return null;
  if (stored.v && stored.v !== 1 && stored.v !== 2) return stored;
  var camera = (stored.cameraBeats || []).map(unpackLocalBeatEvent);
  var pulse = (stored.pulseBeats || []).map(unpackLocalBeatEvent);
  return {
    kicks: camera.map(function (b) { return typeof b === 'number' ? b : b.time; }),
    beats: camera,
    pulseBeats: pulse,
    cameraBeats: camera,
    gridStep: stored.gridStep || 0,
    sectionSteps: stored.sectionSteps || [],
    tempoSource: stored.tempoSource || 'local',
    duration: stored.duration || 0,
    visualBeatCount: stored.visualBeatCount || camera.length,
    analyzedAt: stored.analyzedAt || Date.now(),
    partial: !!stored.partial,
    partialUntilSec: stored.partialUntilSec || 0
  };
}

// 原 03-beat/03-local-beat-cache-modal.js
function readLocalBeatPrefs() {
  try { return JSON.parse(localStorage.getItem(LOCAL_BEAT_PREF_STORE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}

// 原 03-beat/03-local-beat-cache-modal.js
function readLocalBeatMapCache() {
  var out = {};
  try {
    var raw = JSON.parse(localStorage.getItem(LOCAL_BEATMAP_STORE_KEY) || '{}') || {};
    Object.keys(raw).forEach(function (key) {
      var entry = raw[key] || {};
      out[key] = { updatedAt: entry.updatedAt || 0 };
      if (entry.mr) out[key].mr = unpackLocalBeatMap(entry.mr);
      if (entry.dj) out[key].dj = unpackLocalBeatMap(entry.dj);
    });
  } catch (e) {
    out = {};
  }
  return out;
}

// 原 05-playback/02-listen-stats.js
function loadListenStatsState() {
  try {
    var raw = localStorage.getItem(HOME_LISTEN_STATS_KEY);
    if (!raw) return { history: [], songs: {}, artists: {}, updatedAt: 0 };
    var data = JSON.parse(raw);
    return {
      history: Array.isArray(data.history) ? data.history.slice(0, 180) : [],
      songs: data.songs && typeof data.songs === 'object' ? data.songs : {},
      artists: data.artists && typeof data.artists === 'object' ? data.artists : {},
      updatedAt: Number(data.updatedAt) || 0,
    };
  } catch (e) {
    return { history: [], songs: {}, artists: {}, updatedAt: 0 };
  }
}

// 原 07-fx/06-hotkeys.js
function getHotkeyDefaults() {
  var defaults = { local: {}, global: {} };
  hotkeyActionsList().forEach(function (action) {
    defaults.local[action.key] = action.local || '';
    defaults.global[action.key] = action.global || '';
  });
  return defaults;
}

// 原 07-fx/06-hotkeys.js
function readHotkeySettings() {
  var defaults = getHotkeyDefaults();
  try {
    var raw = JSON.parse(localStorage.getItem(HOTKEY_SETTINGS_STORE_KEY) || '{}') || {};
    return {
      local: Object.assign({}, defaults.local, raw.local || {}),
      global: Object.assign({}, defaults.global, raw.global || {})
    };
  } catch (e) {
    return defaults;
  }
}

// 原 05-playback/00-api-quality-output.js
function normalizePlaybackQuality(value) {
  value = String(value || '').toLowerCase();
  if (value === 'jymaster' || value === 'master' || value === 'svip') return 'jymaster';
  if (value === 'hires' || value === 'hi-res' || value === 'highres' || value === 'highest') return 'hires';
  if (value === 'lossless' || value === 'flac' || value === 'sq') return 'lossless';
  if (value === 'exhigh' || value === 'high' || value === '320k' || value === 'hq') return 'exhigh';
  if (value === 'standard' || value === 'normal' || value === 'std') return 'standard';
  return 'hires';
}

// 原 05-playback/00-api-quality-output.js
function normalizePlaybackProvider(provider) {
  if (provider === 'qq') return 'qq';
  if (provider === 'kugou') return 'kugou';
  if (provider === 'qishui') return 'qishui';
  if (provider === 'spotify') return 'spotify';
  return 'netease';
}

// 原 05-playback/00-api-quality-output.js
function normalizePlaybackQualityForProvider(value, provider) {
  provider = normalizePlaybackProvider(provider);
  var q = normalizePlaybackQuality(value);
  if (provider === 'qq' && q === 'jymaster') return 'hires';
  return q;
}

// 原 05-playback/00-api-quality-output.js
function readPlaybackQualityPreference() {
  var fallback = {
    netease: PLAYBACK_QUALITY_DEFAULTS.netease,
    qq: PLAYBACK_QUALITY_DEFAULTS.qq,
    kugou: PLAYBACK_QUALITY_DEFAULTS.kugou,
    qishui: PLAYBACK_QUALITY_DEFAULTS.qishui,
    spotify: PLAYBACK_QUALITY_DEFAULTS.spotify
  };
  try {
    var raw = localStorage.getItem(PLAYBACK_QUALITY_STORE_KEY) || '';
    if (!raw) return fallback;
    if (raw.trim().charAt(0) !== '{') {
      var legacy = normalizePlaybackQuality(raw);
      return {
        netease: normalizePlaybackQualityForProvider(legacy, 'netease'),
        qq: normalizePlaybackQualityForProvider(legacy, 'qq'),
        kugou: normalizePlaybackQualityForProvider(legacy, 'kugou'),
        qishui: normalizePlaybackQualityForProvider(fallback.qishui, 'qishui'),
        spotify: normalizePlaybackQualityForProvider(fallback.spotify, 'spotify')
      };
    }
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      netease: normalizePlaybackQualityForProvider(parsed.netease || fallback.netease, 'netease'),
      qq: normalizePlaybackQualityForProvider(parsed.qq || fallback.qq, 'qq'),
      kugou: normalizePlaybackQualityForProvider(parsed.kugou || fallback.kugou || 'lossless', 'kugou'),
      qishui: normalizePlaybackQualityForProvider(parsed.qishui || fallback.qishui || 'standard', 'qishui'),
      spotify: normalizePlaybackQualityForProvider(parsed.spotify || fallback.spotify || 'standard', 'spotify')
    };
  } catch (e) {
    return fallback;
  }
}

// 原 05-playback/00-api-quality-output.js
function getProviderPlaybackQuality(provider) {
  provider = normalizePlaybackProvider(provider);
  var prefs = playbackQualityPrefs || {};
  return normalizePlaybackQualityForProvider(prefs[provider] || PLAYBACK_QUALITY_DEFAULTS[provider], provider);
}

// 原 05-playback/00-api-quality-output.js
function normalizeAudioOutputIdList(list) {
  var seen = {};
  return (Array.isArray(list) ? list : []).map(function (id) { return String(id || '').trim(); }).filter(function (id) {
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  }).slice(0, 4);
}

// 原 05-playback/00-api-quality-output.js
function readAudioOutputDevicePreference() {
  try { return localStorage.getItem(AUDIO_OUTPUT_DEVICE_STORE_KEY) || ''; } catch (e) { return ''; }
}

// 原 05-playback/00-api-quality-output.js
function readAudioOutputMirrorPreference() {
  try {
    return normalizeAudioOutputIdList(JSON.parse(localStorage.getItem(AUDIO_OUTPUT_MIRROR_STORE_KEY) || '[]'));
  } catch (e) { return []; }
}

// 原 05-playback/00-api-quality-output.js
function readAudioInputBridgePreference() {
  try {
    var parsed = JSON.parse(localStorage.getItem(AUDIO_INPUT_BRIDGE_STORE_KEY) || '{}');
    return { enabled: !!parsed.enabled, deviceId: String(parsed.deviceId || '') };
  } catch (e) {
    return { enabled: false, deviceId: '' };
  }
}

// ── 赋值：这些 var 从 00-core-stores 搬过来，位置必须仍在它之后（常量在这里才就位）。
// Assignments moved out of 00-core-stores; they still have to sit after it for the STORE_KEY
// constants to be defined.
var customCoverMap = readCustomCoverMap();
var customLyricMap = readCustomLyricMap();
var customLyricPrefs = readCustomLyricPrefs();
var customLyricFonts = readCustomLyricFonts();
var localBeatMapCache = readLocalBeatMapCache();
var localBeatMapPrefs = readLocalBeatPrefs();
var listenStatsState = loadListenStatsState();
var hotkeySettings = readHotkeySettings();
// 播放质量 / 音频设备的读取同理：原来 00-core-stores 在顶层直接调 05-playback/00 的函数。
// Playback-quality and audio-device reads: 00-core-stores used to call into 05-playback/00 at top
// level, which only worked through cross-file hoisting.
var playbackQualityPrefs = readPlaybackQualityPreference();
var playbackQuality = getProviderPlaybackQuality('netease');
var audioOutputDeviceId = readAudioOutputDevicePreference();
var audioOutputMirrorDeviceIds = readAudioOutputMirrorPreference();
var audioInputBridgeState = readAudioInputBridgePreference();
// 字体注册会往 document 里插 <style>，启动时跑一次就够，且不参与任何模块期的状态推导。
// 放到 boot 阶段：它调用的 registerCustomLyricFont 属于 07-fx，此刻还没加载。
// Font registration injects a <style> and takes part in nothing that other modules read at load
// time, so it runs at boot — registerCustomLyricFont lives in 07-fx, which loads much later.
if (typeof window !== 'undefined' && typeof window.__mineradioDefer === 'function') {
  window.__mineradioDefer(function () {
    try {
      if (typeof registerSavedCustomLyricFonts === 'function') registerSavedCustomLyricFonts();
    } catch (error) {
      console.warn('[LocalReaders] lyric font registration failed:', error && error.message || error);
    }
  });
}
