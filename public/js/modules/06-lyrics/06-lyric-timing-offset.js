// 本模块界面文案统一走 i18n；词典是唯一文案来源，缺键时退回内置中文模板。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：xxxText('key') 缺键返回键名；xxxText('key', '兜底') 显式指定缺键时显示什么；
// xxxText('key', '含 {p} 的模板', {p: v}) 带插值，params 同时喂给 t() 与兜底模板。
// Two call shapes: key-only shows the bare key on a miss; an explicit fallback says what to
// show instead; params interpolate into both the dictionary hit and the fallback template.
function lyricTimingOffsetText(key, fallback, params) {
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

var LYRIC_TIMING_OFFSET_STORE_KEY = 'mineradio-lyric-timing-offsets-v1';
var LYRIC_TIMING_OFFSET_LIMIT = 500;
var lyricTimingOffsetMap = readLyricTimingOffsetMap();
var lyricTimingPopoverCloseTimer = null;

function normalizeLyricTimingOffsetSeconds(value) {
  var raw = Number(value);
  if (!isFinite(raw)) raw = 0;
  return Math.round(clampRange(raw, -5, 5) * 10) / 10;
}

function lyricTimingOffsetEntryValue(entry) {
  if (entry && typeof entry === 'object') return normalizeLyricTimingOffsetSeconds(entry.offset);
  return normalizeLyricTimingOffsetSeconds(entry);
}

function readLyricTimingOffsetMap() {
  try {
    var raw = JSON.parse(localStorage.getItem(LYRIC_TIMING_OFFSET_STORE_KEY) || '{}');
    var items = raw && raw.version === 1 && raw.items ? raw.items : raw;
    var out = {};
    Object.keys(items || {}).forEach(function (key) {
      var entry = items[key];
      var offset = lyricTimingOffsetEntryValue(entry);
      if (offset) {
        out[key] = {
          offset: offset,
          updatedAt: Number(entry && entry.updatedAt) || 0,
          title: String(entry && entry.title || '').slice(0, 80),
          artist: String(entry && entry.artist || '').slice(0, 80)
        };
      }
    });
    return out;
  } catch (e) {
    return {};
  }
}

function writeLyricTimingOffsetMap() {
  try {
    var keys = Object.keys(lyricTimingOffsetMap || {}).sort(function (a, b) {
      return (Number(lyricTimingOffsetMap[b] && lyricTimingOffsetMap[b].updatedAt) || 0) - (Number(lyricTimingOffsetMap[a] && lyricTimingOffsetMap[a].updatedAt) || 0);
    }).slice(0, LYRIC_TIMING_OFFSET_LIMIT);
    var items = {};
    keys.forEach(function (key) { items[key] = lyricTimingOffsetMap[key]; });
    lyricTimingOffsetMap = items;
    if (!keys.length) {
      localStorage.removeItem(LYRIC_TIMING_OFFSET_STORE_KEY);
      return;
    }
    localStorage.setItem(LYRIC_TIMING_OFFSET_STORE_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), items: items }));
  } catch (e) { }
}

function lyricTimingCurrentSong() {
  if (typeof currentCoverSong === 'function') return currentCoverSong();
  if (currentIdx >= 0 && playQueue && playQueue[currentIdx]) return playQueue[currentIdx];
  return currentLocalSong || null;
}

function lyricTimingSongKey(song) {
  song = song || lyricTimingCurrentSong();
  if (!song) return '';
  if (typeof queueItemKey === 'function') return queueItemKey(song);
  if (typeof songCustomCoverKey === 'function') return songCustomCoverKey(song);
  if (song.provider === 'spotify' || song.source === 'spotify' || song.type === 'spotify' || song.spotifyId || song.spotifyUri) return 'spotify:' + (song.spotifyId || song.id || song.spotifyUri || song.uri || (song.name + '|' + song.artist));
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
  if (song.localKey) return 'local:' + song.localKey;
  if (song.id != null && song.id !== '') return 'song:' + song.id;
  return String(song.name || '') + '|' + String(song.artist || '');
}

function getLyricTimingOffsetForSong(song) {
  var key = lyricTimingSongKey(song);
  return key && lyricTimingOffsetMap && lyricTimingOffsetMap[key] ? lyricTimingOffsetEntryValue(lyricTimingOffsetMap[key]) : 0;
}

function getActiveLyricTimingOffsetSeconds() {
  return getLyricTimingOffsetForSong(lyricTimingCurrentSong());
}

function getAdjustedLyricPlaybackTime(rawTime) {
  var t = Number(rawTime);
  if (!isFinite(t)) t = 0;
  return Math.max(0, t + getActiveLyricTimingOffsetSeconds());
}

function formatLyricTimingOffset(offset) {
  offset = normalizeLyricTimingOffsetSeconds(offset);
  if (!offset) return '0.0s';
  return (offset > 0 ? '+' : '-') + Math.abs(offset).toFixed(1) + 's';
}

function lyricTimingToastText(offset) {
  offset = normalizeLyricTimingOffsetSeconds(offset);
  if (!offset) return lyricTimingOffsetText('offset_reset');
  return offset > 0 ? (lyricTimingOffsetText('offset_advance') + Math.abs(offset).toFixed(1) + 's') : (lyricTimingOffsetText('offset_delay') + Math.abs(offset).toFixed(1) + 's');
}

function releaseLyricTimingPopoverFocus(root) {
  root = root || document.getElementById('lyric-timing-control');
  var active = document.activeElement;
  if (!root || !active || !root.contains(active) || typeof active.blur !== 'function') return;
  try { active.blur(); } catch (e) { }
}

function clearLyricTimingPopoverClose() {
  if (lyricTimingPopoverCloseTimer) {
    clearTimeout(lyricTimingPopoverCloseTimer);
    lyricTimingPopoverCloseTimer = null;
  }
  var root = document.getElementById('lyric-timing-control');
  if (root) root.classList.remove('closing');
}

function suppressLyricTimingSiblingPanels(suppressed) {
  if (typeof setVolumePanelSiblingSuppressed === 'function') setVolumePanelSiblingSuppressed(!!suppressed);
}

function lyricTimingControlIsActive(root) {
  root = root || document.getElementById('lyric-timing-control');
  if (!root) return false;
  var active = document.activeElement;
  return !!((root.matches && root.matches(':hover')) || (active && root.contains(active)));
}

function releaseLyricTimingSiblingPanelsSoon(root) {
  setTimeout(function () {
    if (!lyricTimingControlIsActive(root)) suppressLyricTimingSiblingPanels(false);
  }, 70);
}

function closeLyricTimingPopover(force) {
  var root = document.getElementById('lyric-timing-control');
  if (!root) return;
  if (lyricTimingPopoverCloseTimer) {
    clearTimeout(lyricTimingPopoverCloseTimer);
    lyricTimingPopoverCloseTimer = null;
  }
  releaseLyricTimingPopoverFocus(root);
  root.classList.add('closing');
  lyricTimingPopoverCloseTimer = setTimeout(function () {
    lyricTimingPopoverCloseTimer = null;
    root.classList.remove('closing');
  }, force ? 220 : 160);
  suppressLyricTimingSiblingPanels(false);
}

function updateLyricTimingOffsetUi(songOverride) {
  var song = songOverride || lyricTimingCurrentSong();
  var key = lyricTimingSongKey(song);
  var offset = getLyricTimingOffsetForSong(song);
  var root = document.getElementById('lyric-timing-control');
  var value = document.getElementById('lyric-timing-value');
  var songEl = document.getElementById('lyric-timing-song');
  if (root) root.classList.toggle('has-offset', !!offset);
  if (value) value.textContent = formatLyricTimingOffset(offset);
  if (songEl) songEl.textContent = song ? (song.name || song.title || lyricTimingOffsetText('track_current_song')) : lyricTimingOffsetText('offset_no_song');
  document.querySelectorAll('[data-lyric-offset-step],[data-lyric-offset-reset]').forEach(function (btn) {
    btn.disabled = !key;
  });
}

function refreshLyricTimingAfterOffsetChange() {
  if (stageLyrics) {
    stageLyrics.currentIdx = -999;
    stageLyrics.currentDisplayKey = '';
  }
  if (typeof pushDesktopLyricsState === 'function') pushDesktopLyricsState(true);
}

function setCurrentLyricTimingOffset(offset, opts) {
  opts = opts || {};
  var song = lyricTimingCurrentSong();
  var key = lyricTimingSongKey(song);
  if (!key || !song) {
    updateLyricTimingOffsetUi(song);
    if (!opts.silent) showToast(lyricTimingOffsetText('offset_play_first'));
    return 0;
  }
  offset = normalizeLyricTimingOffsetSeconds(offset);
  var previous = key && lyricTimingOffsetMap && lyricTimingOffsetMap[key] ? lyricTimingOffsetEntryValue(lyricTimingOffsetMap[key]) : 0;
  var hadEntry = !!(key && lyricTimingOffsetMap && lyricTimingOffsetMap[key]);
  if (!offset && !hadEntry) {
    updateLyricTimingOffsetUi(song);
    refreshLyricTimingAfterOffsetChange();
    if (!opts.silent) showToast(lyricTimingToastText(0));
    return 0;
  }
  if (offset && hadEntry && previous === offset) {
    updateLyricTimingOffsetUi(song);
    if (!opts.silent) showToast(lyricTimingToastText(offset));
    return offset;
  }
  if (offset) {
    lyricTimingOffsetMap[key] = {
      offset: offset,
      updatedAt: Date.now(),
      title: String(song.name || song.title || '').slice(0, 80),
      artist: String(song.artist || '').slice(0, 80)
    };
  } else if (lyricTimingOffsetMap && lyricTimingOffsetMap[key]) {
    delete lyricTimingOffsetMap[key];
  }
  writeLyricTimingOffsetMap();
  updateLyricTimingOffsetUi(song);
  refreshLyricTimingAfterOffsetChange();
  if (!opts.silent) showToast(lyricTimingToastText(offset));
  return offset;
}

function adjustCurrentLyricTimingOffset(delta) {
  var next = getActiveLyricTimingOffsetSeconds() + (Number(delta) || 0);
  return setCurrentLyricTimingOffset(next);
}

function handleLyricTimingOffsetClick(e) {
  if (e && e._mineradioLyricTimingHandled) return;
  var stepBtn = e && e.target && e.target.closest ? e.target.closest('[data-lyric-offset-step]') : null;
  var resetBtn = e && e.target && e.target.closest ? e.target.closest('[data-lyric-offset-reset]') : null;
  if (!stepBtn && !resetBtn) return;
  if (e) {
    e._mineradioLyricTimingHandled = true;
    e.preventDefault();
    e.stopPropagation();
  }
  if (resetBtn) setCurrentLyricTimingOffset(0);
  else adjustCurrentLyricTimingOffset(Number(stepBtn.getAttribute('data-lyric-offset-step')) || 0);
  releaseLyricTimingPopoverFocus(document.getElementById('lyric-timing-control'));
}

function bindLyricTimingOffsetControls() {
  var root = document.getElementById('lyric-timing-control');
  if (!root || root._mineradioLyricTimingBound) return;
  root._mineradioLyricTimingBound = true;
  root.addEventListener('mouseenter', function () {
    suppressLyricTimingSiblingPanels(true);
    clearLyricTimingPopoverClose();
    updateLyricTimingOffsetUi();
  });
  root.addEventListener('focusin', function () {
    suppressLyricTimingSiblingPanels(true);
    clearLyricTimingPopoverClose();
    updateLyricTimingOffsetUi();
  });
  root.addEventListener('mouseleave', function () { releaseLyricTimingSiblingPanelsSoon(root); });
  root.addEventListener('focusout', function () { releaseLyricTimingSiblingPanelsSoon(root); });
  root.addEventListener('click', handleLyricTimingOffsetClick);
  root.querySelectorAll('[data-lyric-offset-step],[data-lyric-offset-reset]').forEach(function (btn) {
    btn.addEventListener('click', handleLyricTimingOffsetClick);
  });
  document.addEventListener('pointerdown', function (e) {
    if (!root.contains(e.target)) closeLyricTimingPopover(false);
  }, true);
  updateLyricTimingOffsetUi();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindLyricTimingOffsetControls);
else bindLyricTimingOffsetControls();
