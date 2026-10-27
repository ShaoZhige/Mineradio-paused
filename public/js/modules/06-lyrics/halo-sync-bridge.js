'use strict';

// ============================================================
//  花再 Halo PixelBar 同步桥（渲染进程） / Halo PixelBar sync bridge
//  - 现有模块只调用 window.haloSync 的语义方法，不碰设备协议；
//    真正的拼包与 USB HID 写入在主进程 desktop/halo-lyric-sync.js 里。
//    Existing modules only call semantic methods on window.haloSync; framing and the
//    USB HID write live in the main process.
//  - 音响不在、开关关掉、桥没接上时全部空转，不影响播放与歌词本体。
//    Every call is best-effort: no speaker, switch off, or no bridge means no-ops.
//  - 设置入口是标题栏的一颗按钮加一块浮层，与 DIY 视觉控制台分开：
//    控制台会整体重建静态子节点，塞进去的东西打开就被删。
//    The settings entry is one titlebar button plus a popover, deliberately apart from the
//    DIY console, which rebuilds its static children and would delete an injected panel.
// ============================================================
(function () {
  if (window.haloSync) return;

  var state = {
    enabled: false,
    config: null,
    song: null,
    lines: [],
    lastLine: '__force__',
    lastSongSig: '',
    audioEl: null,
    lastPlaying: false,
    lastFrameAt: 0,
    lastCoverAt: 0,
  };
  var ui = null;

  function haloText(key, fallback, params) {
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

  function getHalo() {
    try {
      if (window.desktopWindow && window.desktopWindow.halo) return window.desktopWindow.halo;
    } catch (e) { /* ignore */ }
    return null;
  }

  function flagOn(name) {
    return !!(state.enabled && state.config && state.config[name]);
  }

  // 按时间找当前应显示的那一行。歌词行自带起始时间，二分没有意义 —— 单行歌词几百行，
  // 每 250ms 扫一次的开销远小于维护一套索引状态。
  function activeLineAt(lines, t) {
    if (!lines || !lines.length) return '';
    if (lines.length === 1) return lines[0].text || '';
    var line = '';
    for (var i = 0; i < lines.length; i++) {
      var at = lines[i].t;
      if (typeof at === 'number' && at <= t) line = lines[i].text || '';
      else break;
    }
    return line;
  }

  function getAudioEl() {
    var el = null;
    try { if (window.audio && window.audio.nodeType === 1) el = window.audio; } catch (e) { /* ignore */ }
    if (!el) el = document.querySelector('audio');
    if (!el) el = state.audioEl;
    return el;
  }

  function bindAudio(el) {
    if (!el || el.__haloBound) return;
    el.__haloBound = true;
    el.addEventListener('play', function () { var h = getHalo(); if (h && state.enabled) h.playState(true); });
    el.addEventListener('pause', function () { var h = getHalo(); if (h && state.enabled) h.playState(false); });
    el.addEventListener('ended', function () { var h = getHalo(); if (h && state.enabled) h.playState(false); });
  }

  function ensureAudio() {
    var el = getAudioEl();
    if (el && el !== state.audioEl) {
      state.audioEl = el;
      bindAudio(el);
    }
    return el;
  }

  function applyConfig(config) {
    state.config = config || null;
    state.enabled = !!(config && config.enabled);
    if (ui) syncUiFromConfig();
  }

  function refreshConfig() {
    var h = getHalo();
    if (!h) return;
    try {
      h.getConfig().then(function (res) {
        if (res && res.ok && res.config) applyConfig(res.config);
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  function tick() {
    var el = ensureAudio();
    if (!el) return;
    var playing = !el.paused && !el.ended;
    if (playing !== state.lastPlaying) {
      state.lastPlaying = playing;
      var hp = getHalo();
      if (hp && state.enabled) hp.playState(playing);
    }
    if (!state.enabled) return;
    var line = activeLineAt(state.lines, el.currentTime || 0);
    if (line === state.lastLine) return;
    state.lastLine = line;
    var h = getHalo();
    if (h) h.lyric(line || '');
  }

  function dominantRgb(colors) {
    if (!colors || !colors.length) return null;
    var first = colors[0];
    if (typeof first === 'string') {
      var m = /^#?([0-9a-f]{6})$/i.exec(first.trim());
      if (!m) return null;
      var n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    if (first && typeof first === 'object' && first.r != null) {
      return { r: first.r, g: first.g, b: first.b };
    }
    return null;
  }

  window.haloSync = {
    // 歌词成为当前歌词的那一刻调用，传入歌曲元信息与解析后的行
    setLyricContext: function (song, lines) {
      state.song = song || null;
      state.lines = (lines || []).map(function (line) {
        return {
          t: (line && typeof line.t === 'number') ? line.t : 0,
          text: (line && line.text) || '',
        };
      });
      state.lastLine = '__force__';
      if (!song) return;
      var sig = String(song.id || '') + '|' + (song.name || song.title || '') + '|' + (song.artist || '');
      if (sig === state.lastSongSig) return;
      state.lastSongSig = sig;
      var h = getHalo();
      if (h && state.enabled) h.song(song.name || song.title || '', song.artist || '');
    },
    // 节拍分析每帧调用，节流后再过桥
    onAudioFrame: function (frame) {
      if (!frame || !flagOn('beatReactive') || !state.config.ambientEnabled) return;
      var now = Date.now();
      if (now - state.lastFrameAt < 100) return;
      state.lastFrameAt = now;
      var h = getHalo();
      if (h) h.audioFrame(frame.energy, frame.beat, frame.brightness);
    },
    onVolume: function (value) {
      if (!flagOn('volumeSync')) return;
      var h = getHalo();
      if (h) h.volume(value);
    },
    // 封面色只取主色，且 1.5 秒一次：屏色包发太密会把设备刷到复位
    onCoverColors: function (colors) {
      if (!flagOn('followCover')) return;
      var now = Date.now();
      if (now - state.lastCoverAt < 1500) return;
      state.lastCoverAt = now;
      var rgb = dominantRgb(colors);
      if (!rgb) return;
      var h = getHalo();
      if (h) h.coverColor(rgb);
    },
  };

  // ---- 设置浮层 ----

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function row(labelNode, control) {
    var wrap = make('div', 'halo-sync-row');
    wrap.appendChild(labelNode);
    wrap.appendChild(control);
    return wrap;
  }

  function toggleRow(key, disabled) {
    var label = make('label');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.disabled = !!disabled;
    box.addEventListener('change', function () {
      var h = getHalo();
      if (h) h.setConfig(makePatch(key, box.checked));
    });
    return {
      node: row(label, box),
      relabel: function (key2) { label.textContent = haloText(key2); },
      set: function (value) { box.checked = !!value; },
    };
  }

  function selectRow(configKey, labelKey, options) {
    var label = make('label');
    var sel = document.createElement('select');
    options.forEach(function (item) {
      var opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = haloText(item.key);
      opt.__haloKey = item.key;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      var h = getHalo();
      if (h) h.setConfig(makePatch(configKey, sel.value));
    });
    return {
      node: row(label, sel),
      configKey: configKey,
      labelKey: labelKey,
      relabel: function () {
        label.textContent = haloText(labelKey);
        for (var i = 0; i < sel.options.length; i++) {
          var option = sel.options[i];
          if (option.__haloKey) option.textContent = haloText(option.__haloKey);
        }
      },
      set: function (value) { if (value != null) sel.value = value; },
    };
  }

  function makePatch(key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  }

  function chipGroup(items, onPick) {
    var wrap = make('div', 'halo-sync-group');
    var title = make('div', 'halo-sync-group-title');
    wrap.appendChild(title);
    var chips = make('div', 'halo-sync-btns');
    var buttons = items.map(function (item) {
      var btn = make('button', 'halo-sync-chip');
      btn.type = 'button';
      btn.addEventListener('click', function () { onPick(item); });
      chips.appendChild(btn);
      return { node: btn, key: item.key };
    });
    wrap.appendChild(chips);
    return {
      node: wrap,
      relabel: function (titleKey) {
        title.textContent = haloText(titleKey);
        buttons.forEach(function (entry) { entry.node.textContent = haloText(entry.key); });
      },
    };
  }

  function buildHaloPanel() {
    if (ui) return ui;
    var host = document.getElementById('top-right');
    if (!host) return null;

    var btn = document.createElement('button');
    btn.id = 'halo-sync-btn';
    btn.className = 'icon-btn';
    btn.type = 'button';
    btn.innerHTML = '<svg width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7"'
      + ' viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4Z"/>'
      + '<path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18 6.7a7.4 7.4 0 0 1 0 10.6"/></svg>';

    var panel = make('div', 'halo-sync-panel');
    panel.id = 'halo-sync-panel';

    var title = make('div', 'halo-sync-title');
    panel.appendChild(title);

    var toggles = {
      enabled: toggleRow('enabled'),
      ambientEnabled: toggleRow('ambientEnabled'),
      beatReactive: toggleRow('beatReactive'),
      followCover: toggleRow('followCover', true),
      volumeSync: toggleRow('volumeSync'),
      dynamicScroll: toggleRow('dynamicScroll'),
    };
    var toggleKeys = {
      enabled: 'halo_enable',
      ambientEnabled: 'halo_ambient',
      beatReactive: 'halo_beat_reactive',
      followCover: 'halo_follow_cover',
      volumeSync: 'halo_volume_sync',
      dynamicScroll: 'halo_dynamic_scroll',
    };
    Object.keys(toggles).forEach(function (key) {
      panel.appendChild(toggles[key].node);
      toggles[key].relabel(toggleKeys[key]);
    });

    var idle = selectRow('idleScene', 'halo_idle_scene', [
      { value: 'none', key: 'halo_idle_keep' },
      { value: 'clock', key: 'halo_idle_clock' },
    ]);
    var align = selectRow('align', 'halo_align', [
      { value: 'left', key: 'halo_align_left' },
      { value: 'center', key: 'halo_align_center' },
      { value: 'right', key: 'halo_align_right' },
      { value: 'justify', key: 'halo_align_justify' },
    ]);
    var brightness = selectRow('ambientBrightness', 'halo_brightness', [
      { value: 'low', key: 'halo_bright_low' },
      { value: 'medium', key: 'halo_bright_medium' },
      { value: 'high', key: 'halo_bright_high' },
    ]);
    var selects = [idle, align, brightness];
    selects.forEach(function (entry) {
      panel.appendChild(entry.node);
      entry.relabel();
    });

    var scenes = chipGroup([
      { value: 'clock', key: 'halo_scene_clock' },
      { value: 'game', key: 'halo_scene_game' },
      { value: 'work', key: 'halo_scene_work' },
      { value: 'reading', key: 'halo_scene_reading' },
      { value: 'cats', key: 'halo_scene_cats' },
      { value: 'dogs', key: 'halo_scene_dogs' },
      { value: 'memes', key: 'halo_scene_memes' },
      { value: 'cyber', key: 'halo_scene_cyber' },
      { value: 'waves', key: 'halo_scene_waves' },
    ], function (item) {
      var h = getHalo();
      if (h) h.scene(item.value);
    });
    panel.appendChild(scenes.node);
    scenes.relabel('halo_group_scene');

    var spectrum = chipGroup([
      { value: 1, key: 'halo_spectrum_bar' },
      { value: 2, key: 'halo_spectrum_wave' },
      { value: 3, key: 'halo_spectrum_symmetric' },
      { value: 4, key: 'halo_spectrum_dense' },
    ], function (item) {
      var h = getHalo();
      if (h) h.spectrum(item.value);
    });
    panel.appendChild(spectrum.node);
    spectrum.relabel('halo_group_spectrum');

    var clockLabel = make('label');
    var clockSelect = document.createElement('select');
    for (var ci = 1; ci <= 11; ci += 1) {
      var clockOption = document.createElement('option');
      clockOption.value = String(ci);
      clockOption.__haloStyle = ci;
      clockOption.textContent = haloText('halo_clock_style_n', null, { n: ci });
      clockSelect.appendChild(clockOption);
    }
    clockSelect.addEventListener('change', function () {
      var h = getHalo();
      if (h) h.clockStyle(parseInt(clockSelect.value, 10));
    });
    var clockRow = row(clockLabel, clockSelect);
    panel.appendChild(clockRow);

    var status = make('div', 'halo-sync-status');
    panel.appendChild(status);

    var resume = make('button', 'halo-sync-mini-btn');
    resume.type = 'button';
    resume.addEventListener('click', function () {
      var h = getHalo();
      if (!h) return;
      h.manualHold(false);
      status.textContent = haloText('halo_resumed');
    });
    panel.appendChild(resume);

    var detect = make('button', 'halo-sync-mini-btn');
    detect.type = 'button';
    detect.addEventListener('click', function () {
      var h = getHalo();
      if (!h) return;
      status.textContent = '';
      h.connect().then(function () {
        return h.listDevices();
      }).then(function (res) {
        if (res && res.connected) status.textContent = haloText('halo_connected');
        else if (res && res.devices && res.devices.length) {
          status.textContent = haloText('halo_found_devices', null, { n: res.devices.length });
        } else status.textContent = haloText('halo_no_device');
      }).catch(function () { status.textContent = haloText('halo_detect_failed'); });
    });
    panel.appendChild(detect);

    var open = false;
    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      open = !open;
      panel.classList.toggle('show', open);
      if (open) {
        syncUiFromConfig();
        refreshConfig();
      }
    });
    document.addEventListener('click', function (event) {
      if (!open || panel.contains(event.target) || event.target === btn) return;
      open = false;
      panel.classList.remove('show');
    });

    host.appendChild(btn);
    host.appendChild(panel);

    ui = {
      btn: btn,
      panel: panel,
      title: title,
      toggleKeys: toggleKeys,
      toggles: toggles,
      selects: selects,
      scenes: scenes,
      spectrum: spectrum,
      clockLabel: clockLabel,
      clockSelect: clockSelect,
      resume: resume,
      detect: detect,
    };
    relabelHaloPanel();
    return ui;
  }

  function syncUiFromConfig() {
    if (!ui || !state.config) return;
    Object.keys(ui.toggles).forEach(function (key) {
      if (key in state.config) ui.toggles[key].set(state.config[key]);
    });
    ui.selects.forEach(function (entry) {
      entry.set(state.config[entry.configKey]);
    });
  }

  function relabelHaloPanel() {
    if (!ui) return;
    ui.btn.title = haloText('halo_title');
    ui.btn.setAttribute('aria-label', haloText('halo_title'));
    ui.title.textContent = haloText('halo_panel_title');
    Object.keys(ui.toggles).forEach(function (key) {
      ui.toggles[key].relabel(ui.toggleKeys[key]);
    });
    ui.selects.forEach(function (entry) { entry.relabel(); });
    ui.scenes.relabel('halo_group_scene');
    ui.spectrum.relabel('halo_group_spectrum');
    ui.clockLabel.textContent = haloText('halo_clock_style');
    for (var i = 0; i < ui.clockSelect.options.length; i += 1) {
      var option = ui.clockSelect.options[i];
      if (option.__haloStyle) {
        option.textContent = haloText('halo_clock_style_n', null, { n: option.__haloStyle });
      }
    }
    ui.resume.textContent = haloText('halo_resume_lyrics');
    ui.detect.textContent = haloText('halo_detect_device');
  }

  function start() {
    buildHaloPanel();
    ensureAudio();
    refreshConfig();
    window.setInterval(tick, 250);
    window.setInterval(refreshConfig, 5000);
  }

  if (typeof window !== 'undefined' && window.MineradioI18n
    && typeof window.MineradioI18n.onLanguageChange === 'function') {
    window.MineradioI18n.onLanguageChange(function () { relabelHaloPanel(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
