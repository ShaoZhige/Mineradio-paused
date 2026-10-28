'use strict';

// ============================================================
//  花再 Halo PixelBar 同步桥（渲染进程） / Halo PixelBar sync bridge
//  - 现有模块只调用 window.haloSync 的语义方法，不碰设备协议；
//    真正的拼包与 USB HID 写入在主进程 desktop/halo-lyric-sync.js 里。
//    Existing modules only call semantic methods on window.haloSync; framing and the
//    USB HID write live in the main process.
//  - 音响不在、开关关掉、桥没接上时全部空转，不影响播放与歌词本体。
//    Every call is best-effort: no speaker, switch off, or no bridge means no-ops.
//  - 设置块住在 DIY 视觉控制台里（歌词页签 → 花再 Halo PixelBar）。index.html 只声明一个
//    空容器 #halo-sync-section 并把它登记进 09-console-workspace.js 的布局表，控件在本文件
//    里生成 —— 控制台会整块搬运登记过的节点，但未登记的直接删，所以容器必须是静态的、
//    登记过的，控件什么时候填进去都行。
//    The settings block lives inside the DIY console (Lyrics tab → Halo PixelBar). index.html
//    declares one empty container and registers it in 09-console-workspace.js's layout table;
//    the controls are built here. The console moves registered nodes as a whole and deletes
//    unregistered ones, so the container must be static — its contents can be filled any time.
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

  // ---- DIY 控制台里的设置块 ----
  //
  // 控件一律借用控制台既有的样式类，外观因此跟着面板走，不再有一套自己的暗色浮层样式：
  //   .fx-toggle        开关（右侧 .dot 当指示灯）
  //   .fx-select-row    下拉（标签在左、控件在右）
  //   .fx-section-label 小节标题
  //   .fx-mini-btn      次要按钮
  // 这里只负责建节点与下发配置；搬运由 09-console-workspace.js 按登记表完成。
  //
  // Every control borrows the console's own classes, so the block inherits the panel's look
  // instead of carrying a second dark popover style: .fx-toggle for switches, .fx-select-row
  // for dropdowns, .fx-section-label for sub-headings, .fx-mini-btn for secondary buttons.
  // This file only builds nodes and pushes config; the console moves them per its registry.

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function makePatch(key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  }

  // 开关自己翻转 .on 并下发配置。不复用 toggleFx()：那是视觉存档的写入器，
  // 音响配置不在 fx 里，走那条路只会写进无关的存档字段。
  // Toggles flip their own .on class and push the config. toggleFx() is not reused — it writes
  // the visual archive, and the speaker config is not part of it.
  function toggleNode(configKey, labelKey, locked) {
    var node = make('div', 'fx-toggle' + (locked ? ' dev-locked' : ''));
    node.id = 't-halo-' + configKey;
    var label = make('span');
    var dot = make('span', 'dot');
    node.appendChild(label);
    node.appendChild(dot);
    if (!locked) {
      node.addEventListener('click', function () {
        var next = !node.classList.contains('on');
        node.classList.toggle('on', next);
        var h = getHalo();
        if (h) h.setConfig(makePatch(configKey, next));
      });
    }
    return {
      node: node,
      // 控制台的开关是一行一个标签 + 右侧指示灯，标签超长会被省略号截掉（英文与俄文
      // 尤其容易）。title 把完整文案补在悬停提示里，截断时不至于看不出这是哪一项。
      // The console's toggle is one line plus an indicator dot, so a long label gets ellipsised
      // (English and Russian hit this first). The title carries the full text as a fallback.
      relabel: function () {
        var text = haloText(labelKey);
        label.textContent = text;
        node.title = text;
      },
      set: function (value) { node.classList.toggle('on', !!value); },
    };
  }

  // onPick 存在时走独立通道（时钟样式不是配置字段，主进程另有 halo-sync-clock-style），
  // 否则按配置字段下发。
  // onPick routes through its own channel (clock style is not a config field and has its own
  // main-process handler); otherwise the value goes out as a config patch.
  function selectNode(configKey, labelKey, options, onPick) {
    var wrap = make('div', 'fx-select-row');
    wrap.id = 'halo-row-' + configKey;
    var label = make('span', 'fx-select-row-label');
    var sel = document.createElement('select');
    sel.className = 'fx-select';
    options.forEach(function (item) {
      var opt = document.createElement('option');
      opt.value = String(item.value);
      opt.__haloLabel = item;
      opt.textContent = haloText(item.key, null, item.params);
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      var h = getHalo();
      if (!h) return;
      if (onPick) onPick(sel.value);
      else h.setConfig(makePatch(configKey, sel.value));
    });
    wrap.appendChild(label);
    wrap.appendChild(sel);
    return {
      node: wrap,
      configKey: configKey,
      relabel: function () {
        label.textContent = haloText(labelKey);
        for (var i = 0; i < sel.options.length; i += 1) {
          var option = sel.options[i];
          if (option.__haloLabel) {
            option.textContent = haloText(option.__haloLabel.key, null, option.__haloLabel.params);
          }
        }
      },
      set: function (value) { if (value != null) sel.value = String(value); },
    };
  }

  // 场景与频谱是「发一条命令」而不是「存一个状态」，所以做成按钮而非分段控件：
  // 分段控件会暗示一个当前选中项，而设备并不回报当前场景。
  // Scenes and spectrum styles fire a command rather than storing a state, so they are buttons:
  // a segmented control would imply an active selection the device never reports back.
  function chipGroup(titleKey, items, onPick) {
    var wrap = make('div', 'halo-sync-group');
    var title = make('div', 'fx-section-label');
    var chips = make('div', 'halo-sync-chips');
    var buttons = items.map(function (item) {
      var btn = make('button', 'fx-mini-btn ghost');
      btn.type = 'button';
      btn.addEventListener('click', function () { onPick(item); });
      chips.appendChild(btn);
      return { node: btn, key: item.key };
    });
    wrap.appendChild(title);
    wrap.appendChild(chips);
    return {
      node: wrap,
      relabel: function () {
        title.textContent = haloText(titleKey);
        buttons.forEach(function (entry) { entry.node.textContent = haloText(entry.key); });
      },
    };
  }

  function clockOptions() {
    var list = [];
    for (var i = 1; i <= 11; i += 1) {
      list.push({ value: i, key: 'halo_clock_style_n', params: { n: i } });
    }
    return list;
  }

  function buildHaloSection() {
    if (ui) return ui;
    var host = document.getElementById('halo-sync-section');
    if (!host) return null;
    host.textContent = '';

    var toggles = {
      enabled: toggleNode('enabled', 'halo_enable'),
      ambientEnabled: toggleNode('ambientEnabled', 'halo_ambient'),
      beatReactive: toggleNode('beatReactive', 'halo_beat_reactive'),
      // 跟随封面固定置灰：屏色包发太密会把设备刷到复位，这条通道留着占位、不开放操作。
      // followCover stays greyed out: dense colour packets can reset the device, so the channel
      // is a placeholder rather than an operable switch.
      followCover: toggleNode('followCover', 'halo_follow_cover', true),
      volumeSync: toggleNode('volumeSync', 'halo_volume_sync'),
      dynamicScroll: toggleNode('dynamicScroll', 'halo_dynamic_scroll'),
    };
    var grid = make('div', 'fx-toggle-grid');
    Object.keys(toggles).forEach(function (key) {
      grid.appendChild(toggles[key].node);
      toggles[key].relabel();
    });
    host.appendChild(grid);

    var selects = [
      selectNode('idleScene', 'halo_idle_scene', [
        { value: 'none', key: 'halo_idle_keep' },
        { value: 'clock', key: 'halo_idle_clock' },
      ]),
      selectNode('align', 'halo_align', [
        { value: 'left', key: 'halo_align_left' },
        { value: 'center', key: 'halo_align_center' },
        { value: 'right', key: 'halo_align_right' },
        { value: 'justify', key: 'halo_align_justify' },
      ]),
      selectNode('ambientBrightness', 'halo_brightness', [
        { value: 'low', key: 'halo_bright_low' },
        { value: 'medium', key: 'halo_bright_medium' },
        { value: 'high', key: 'halo_bright_high' },
      ]),
      selectNode('clockStyle', 'halo_clock_style', clockOptions(), function (value) {
        var h = getHalo();
        if (h) h.clockStyle(parseInt(value, 10));
      }),
    ];
    selects.forEach(function (entry) {
      host.appendChild(entry.node);
      entry.relabel();
    });

    var scenes = chipGroup('halo_group_scene', [
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
    host.appendChild(scenes.node);
    scenes.relabel();

    var spectrum = chipGroup('halo_group_spectrum', [
      { value: 1, key: 'halo_spectrum_bar' },
      { value: 2, key: 'halo_spectrum_wave' },
      { value: 3, key: 'halo_spectrum_symmetric' },
      { value: 4, key: 'halo_spectrum_dense' },
    ], function (item) {
      var h = getHalo();
      if (h) h.spectrum(item.value);
    });
    host.appendChild(spectrum.node);
    spectrum.relabel();

    var status = make('div', 'halo-sync-status');
    host.appendChild(status);

    // 按钮行用自己的类而不是控制台的 .fx-actions：后者被「恢复默认」那一项按全局选择器
    // 抓取，多一条同类的行就会把它抢走（实测过一次）。
    // Own class instead of the console's .fx-actions: that one is located through a global
    // selector by the reset entry, so a second row carrying it gets stolen (measured once).
    var actions = make('div', 'halo-sync-actions');
    var resume = make('button', 'fx-mini-btn ghost');
    resume.type = 'button';
    resume.addEventListener('click', function () {
      var h = getHalo();
      if (!h) return;
      h.manualHold(false);
      status.textContent = haloText('halo_resumed');
    });
    var detect = make('button', 'fx-mini-btn ghost');
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
    actions.appendChild(resume);
    actions.appendChild(detect);
    host.appendChild(actions);

    ui = {
      host: host,
      toggles: toggles,
      selects: selects,
      scenes: scenes,
      spectrum: spectrum,
      status: status,
      resume: resume,
      detect: detect,
    };
    relabelHaloSection();
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

  function relabelHaloSection() {
    if (!ui) return;
    Object.keys(ui.toggles).forEach(function (key) { ui.toggles[key].relabel(); });
    ui.selects.forEach(function (entry) { entry.relabel(); });
    ui.scenes.relabel();
    ui.spectrum.relabel();
    ui.resume.textContent = haloText('halo_resume_lyrics');
    ui.detect.textContent = haloText('halo_detect_device');
  }

  function start() {
    buildHaloSection();
    ensureAudio();
    refreshConfig();
    window.setInterval(tick, 250);
    window.setInterval(refreshConfig, 5000);
  }

  if (typeof window !== 'undefined' && window.MineradioI18n
    && typeof window.MineradioI18n.onLanguageChange === 'function') {
    window.MineradioI18n.onLanguageChange(function () { relabelHaloSection(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
