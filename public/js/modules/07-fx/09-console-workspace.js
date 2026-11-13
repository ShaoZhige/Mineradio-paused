// 文案统一走 i18n：缺键返回键名（不返回空串），params 同时喂给词典与兜底模板。
// Copy goes through i18n; a missing key returns the key itself rather than an empty string.
function consoleWorkspaceText(key, fallback, params) {
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
'use strict';

// 同样是函数：顶层求值会把解析期取到的键名固化，标签页会显示成 fx_cat_common 之类的键名。
// A function for the same reason as below: module-level evaluation freezes the raw key names.
function fxConsoleTabs() {
  return [
    { key: 'home', label: consoleWorkspaceText('fx_cat_common') },
    { key: 'interface', label: consoleWorkspaceText('fx_cat_ui') },
    { key: 'lyrics', label: consoleWorkspaceText('hotkey_cat_lyrics') },
    { key: 'motion', label: consoleWorkspaceText('fx_cat_motion') },
    { key: 'shelf', label: consoleWorkspaceText('fx_cat_shelf') },
    { key: 'system', label: consoleWorkspaceText('fx_cat_system') }
  ];
}

// `child: true` 把该项渲染成上一个 toggle 的从属控件（缩进 + 左侧导线），用于"开关 + 它的参数"
// 这种层级：参数在语义上依附于那个开关，而不是组里的并列项。
// `child: true` renders the item as a subordinate of the preceding toggle (indent plus a lead-in
// line), for a "switch and its parameters" hierarchy where the parameters depend on that switch
// rather than standing as peers in the group.
function fxConsoleItem(ref, title, aliases, history, child) {
  return {
    ref: ref,
    title: title,
    aliases: aliases || '',
    history: history !== false,
    child: child === true
  };
}

// 必须是函数，不能是模块顶层常量：consoleWorkspaceText() 在解析期就执行，而词典要到
// DOMContentLoaded 才异步加载完 —— 常量会把那一刻取到的键名永久固化进数据，界面就只剩键名。
// Must be a function: the text calls run during parse while the dictionary only loads at
// DOMContentLoaded, so a constant would freeze the raw key names into the data.
function fxConsoleLayout() {
  return [
  {
    key: 'home',
    groups: [
      { key: 'presets', title: '视觉预设', hint: consoleWorkspaceText('fx_preset_flow_hint'), open: true, items: [
        fxConsoleItem('preset-grid', '视觉预设', '风格 场景 Emily 安魂 音域 星河 唱片 星球 滚筒 虚空 月蚀圣环 雨幕霓虹 折光蝶群 深海绽放 Eclipse Halo Neon Drizzle Prism Flock Abyssal Bloom')
      ] },
      { key: 'archives', title: '用户存档', hint: consoleWorkspaceText('fx_preset_hint'), items: [
        fxConsoleItem('user-archive-grid', '用户存档', '方案 快照 预设码 应用 回退')
      ] },
      { key: 'reset', title: consoleWorkspaceText('fx_cat_reset'), hint: consoleWorkspaceText('fx_reset_all'), items: [
        // 用 id 取节点：.fx-actions 是排版类名，面板里出现第二处同类按钮行时会抓错。
        // Select by id: .fx-actions is a layout class and grabs the wrong row once a second exists.
        fxConsoleItem({ selector: '#fx-reset-actions' }, '恢复默认', '重置 全部默认')
      ] }
    ]
  },
  {
    key: 'interface',
    groups: [
      // 语言切换放在这里：主界面控件拥挤，切语言又是低频操作。
      // #fx-lang-row 由 index.html 提供，14-i18n-switcher.js 负责绑定点击。
      // The switcher lives here because the main control row is crowded and switching is rare.
      // index.html ships #fx-lang-row; 14-i18n-switcher.js wires the clicks.
      { key: 'language', title: consoleWorkspaceText('fx_interface_language', '界面语言'), hint: consoleWorkspaceText('fx_language_hint'), open: true, items: [
        fxConsoleItem('fx-lang-row', consoleWorkspaceText('fx_interface_language', '界面语言'), '语言 language English 日本語 Русский 中文 zh en ja ru', false)
      ] },
      { key: 'background', title: consoleWorkspaceText('bg_media', '背景媒体'), hint: consoleWorkspaceText('fx_background_hint'), open: true, items: [
        fxConsoleItem('bg-color-picker', consoleWorkspaceText('bg_color_label', '背景颜色'), '纯色 封面取色'),
        fxConsoleItem('bg-media-preview', consoleWorkspaceText('bg_media', '背景媒体'), '封面 图片 视频 上传 裁切 清除', false),
        fxConsoleItem('fx-bgopacity', consoleWorkspaceText('bg_opacity', '背景透明度'), '背景强度'),
        fxConsoleItem('fx-bgcropx', consoleWorkspaceText('fx_crop_horizontal'), '背景水平 位置'),
        fxConsoleItem('fx-bgcropy', consoleWorkspaceText('fx_crop_vertical'), '背景垂直 位置'),
        fxConsoleItem('fx-bgzoom', consoleWorkspaceText('fx_crop_zoom'), '背景放大 缩小')
      ] },
      // Wallpaper Engine 独立成组：它自带一个识别/导入/恢复的状态行和两个行为开关，
      // 再加一组只在壁纸为背景时才生效的构图滑块，混在"背景媒体"里既互相干扰也不好找。
      // 那 4 个 WE 滑块此前没有任何分组登记，会被 fallback 收进"其他设置"；一并登记到这里。
      // Wallpaper Engine gets its own group: it carries a status row (identify / import / restore),
      // two behaviour switches, and a set of framing sliders that only apply while a wallpaper is
      // the background. Mixed into "背景媒体" they crowd each other and are hard to find. Those four
      // WE sliders had no group registration at all and were being swept into "其他设置" by the
      // residual fallback; register them here as well.
      { key: 'wallpaper-engine', title: 'Wallpaper Engine', hint: consoleWorkspaceText('fx_we_compose_hint'), items: [
        fxConsoleItem('wallpaper-engine-value', 'Wallpaper Engine', '壁纸库 识别 导入 恢复原背景', false),
        fxConsoleItem('t-wallpaperEngineSilentWindows', consoleWorkspaceText('fx_we_window_silence'), '任务栏 隐藏 Alt+Tab 进程提醒 静默'),
        fxConsoleItem('t-wallpaperEngineGlassSampler', consoleWorkspaceText('fx_we_glass'), '捕获 黄框 玻璃 像素 采样 Win10'),
        fxConsoleItem('wallpaper-engine-opacity', consoleWorkspaceText('fx_we_opacity'), 'WE 透明 壁纸 淡'),
        fxConsoleItem('wallpaper-engine-position-x', consoleWorkspaceText('bg_we_pos_x'), 'WE 左右 水平 位移'),
        fxConsoleItem('wallpaper-engine-position-y', consoleWorkspaceText('bg_we_pos_y'), 'WE 上下 垂直 位移'),
        fxConsoleItem('wallpaper-engine-scale', consoleWorkspaceText('fx_we_zoom'), 'WE 缩放 放大 缩小')
      ] },
      { key: 'colors', title: consoleWorkspaceText('fx_cat_ui_color'), hint: consoleWorkspaceText('fx_ui_color_hint'), items: [
        fxConsoleItem('ui-accent-picker', consoleWorkspaceText('ui_accent_label', '界面高亮'), '主题色 强调色'),
        fxConsoleItem('visual-tint-picker', consoleWorkspaceText('visual_main_color', '视觉主色'), '粒子主色 封面取色'),
        fxConsoleItem('home-accent-picker', consoleWorkspaceText('home_fill_label', 'Home 填充'), '主页颜色'),
        fxConsoleItem('home-icon-picker', consoleWorkspaceText('home_icon_color', '主页图标'), 'Home 图标颜色'),
        fxConsoleItem('visual-icon-picker', consoleWorkspaceText('visual_icon_color', '视觉图标'), '控制台图标颜色')
      ] },
      { key: 'glass', title: consoleWorkspaceText('fx_cat_glass_leftbar'), hint: consoleWorkspaceText('fx_glass_hint'), items: [
        fxConsoleItem('fx-windowbgopacity', consoleWorkspaceText('fx_window_bg_transparent'), '窗口透明度'),
        fxConsoleItem('fx-bgglassopacity', consoleWorkspaceText('fx_glass_opacity'), '玻璃 背景模糊'),
        fxConsoleItem('fx-glassaberration', consoleWorkspaceText('console_glass_aberration', '控制台玻璃色差'), 'RGB 色散 玻璃质感'),
        fxConsoleItem('fx-playlistblur', consoleWorkspaceText('fx_leftbar_frost'), '歌单栏 模糊'),
        fxConsoleItem('fx-playlistdensity', consoleWorkspaceText('fx_leftbar_occlusion'), '歌单栏 密度 透明'),
        fxConsoleItem('fx-playlistopen', consoleWorkspaceText('fx_leftbar_open'), '打开速度 秒数'),
        fxConsoleItem('fx-playlistclose', consoleWorkspaceText('fx_left_close'), '关闭速度 秒数')
      ] }
    ]
  },
  {
    key: 'lyrics',
    groups: [
      { key: 'display', title: consoleWorkspaceText('fx_cat_lyric_translation'), hint: consoleWorkspaceText('fx_lyric_display_hint'), open: true, items: [
        fxConsoleItem('lyric-source-seg', consoleWorkspaceText('fx_lyric_source'), '原词 自定义歌词', false),
        fxConsoleItem('lyric-display-mode-seg', '歌词行数', '单行 双行 三行 沉浸 自定义'),
        fxConsoleItem('fx-lyriccustomlines', consoleWorkspaceText('fx_lyric_line_count'), '自定义歌词行数'),
        fxConsoleItem('lyric-translation-mode-seg', '双语翻译', '译文 当前 双行 多行 关闭'),
        fxConsoleItem('fx-lyrictranslationgap', consoleWorkspaceText('fx_translation_gap'), '翻译距离'),
        fxConsoleItem('fx-lyrictranslationscale', consoleWorkspaceText('fx_translation_size'), '翻译大小'),
        fxConsoleItem('fx-lyrictranslationopacity', consoleWorkspaceText('fx_translation_opacity'), '翻译透明度')
      ] },
      { key: 'colors', title: consoleWorkspaceText('fx_cat_lyric_color'), hint: consoleWorkspaceText('fx_lyric_color_hint'), items: [
        fxConsoleItem('lyric-color-grid', '歌词颜色', '文字颜色 封面取色'),
        fxConsoleItem('lyric-color-picker', consoleWorkspaceText('fx_lyric_custom_color'), '文字色轮'),
        fxConsoleItem('lyric-highlight-picker', consoleWorkspaceText('fx_lyric_karaoke_highlight'), '高亮颜色 逐字'),
        fxConsoleItem('lyric-glow-picker', consoleWorkspaceText('fx_lyric_bloom_color'), '辉光 光晕 颜色'),
        fxConsoleItem({ selector: '.lyric-glow-effect-row' }, consoleWorkspaceText('fx_lyric_bloom_toggle'), '后层溢光 跟随鼓点'),
        fxConsoleItem('fx-lyricglow', '溢光强度', '歌词辉光 强度'),
        fxConsoleItem('fx-lyricbgadapt', consoleWorkspaceText('fx_lyric_bright_avoid'), '亮背景 可读性 自动压光'),
        fxConsoleItem('t-lyricGlow', '歌词溢光', '后层辉光 开关'),
        fxConsoleItem('t-lyricGlowBeat', '鼓点溢光', '歌词辉光 跟随节拍'),
        fxConsoleItem('t-lyricGlowParticles', '歌词光粒', '歌词粒子 光点')
      ] },
      { key: 'type', title: consoleWorkspaceText('fx_cat_typography'), hint: consoleWorkspaceText('fx_typography_hint'), items: [
        fxConsoleItem('lyric-texture-quality-seg', consoleWorkspaceText('fx_lyric_resolution'), '分辨率 纹理 1x 2x 3x 4x 标清 高清 超清 极致 低配 显存 放大 清楚'),
        fxConsoleItem('lyric-font-grid', '歌词字体', '黑体 宋体 楷宋 Serif Gothic 等宽 上传字体'),
        fxConsoleItem('fx-lyricspacing', '字间距', '文字间距'),
        fxConsoleItem('fx-lyriclineheight', '行距', '歌词行间距'),
        fxConsoleItem('fx-lyricweight', '字重', '粗细'),
        fxConsoleItem('fx-lyricscale', '歌词大小', '字号 缩放'),
        fxConsoleItem('fx-lyricx', '左右位置', '歌词水平'),
        fxConsoleItem('fx-lyricy', '上下位置', '歌词垂直 高度'),
        fxConsoleItem('fx-lyricz', '前后景深', '歌词远近 Z'),
        fxConsoleItem('fx-lyrictiltx', consoleWorkspaceText('fx_lyric_pitch'), '歌词俯仰'),
        fxConsoleItem('fx-lyrictilty', consoleWorkspaceText('fx_lyric_side_rotation'), '歌词侧旋')
      ] },
      { key: 'style', title: consoleWorkspaceText('lyric_style_section', '歌词样式'), hint: '全屏歌词样式 流光 逐词点亮', items: [
        fxConsoleItem('lyric-style-seg', consoleWorkspaceText('lyric_style_section', '歌词样式'), '商籁 流光 逐词 点亮 默认')
      ] },
      { key: 'motion', title: consoleWorkspaceText('fx_cat_lyric_animation'), hint: consoleWorkspaceText('fx_lyric_scroll_hint'), items: [
        fxConsoleItem('lyric-motion-style-seg', consoleWorkspaceText('fx_cat_lyric_animation'), '漂浮 柔滑 玻璃 线光 故障'),
        fxConsoleItem('lyric-glitch-controls', consoleWorkspaceText('fx_glitch_detail'), '故障强度 切片 色散 触发速度 抖动 鼓点'),
        fxConsoleItem('fx-lyriccontextopacity', consoleWorkspaceText('fx_lyric_context_clarity'), '上下文透明度'),
        fxConsoleItem('fx-lyriccontextspread', consoleWorkspaceText('fx_lyric_context_gap'), '上下文距离'),
        fxConsoleItem('fx-lyricedgefade', consoleWorkspaceText('fx_lyric_edge_fade'), '歌词边缘淡出'),
        fxConsoleItem('fx-lyricmotionsoftness', consoleWorkspaceText('fx_lyric_smoothing'), '歌词滚动 丝滑 缓动'),
        fxConsoleItem('t-lyricVerticalFloat', consoleWorkspaceText('fx_lyric_float'), '漂浮 垂直'),
        fxConsoleItem('t-lyricCameraLock', '歌词镜头绑定', '跟随镜头 锁定'),
        fxConsoleItem('t-lyricPauseHold', consoleWorkspaceText('fx_pause_keep_lyric'), '暂停不隐藏')
      ] },
      { key: 'desktop', title: '桌面歌词', hint: consoleWorkspaceText('fx_desktop_lyrics_hint'), items: [
        fxConsoleItem('t-desktopLyrics', '桌面歌词', '全屏置顶歌词'),
        fxConsoleItem('t-desktopLyricsClickThrough', '桌面歌词锁定', '鼠标穿透 防误触'),
        fxConsoleItem('t-desktopLyricsCinema', '桌面歌词电影震动', '桌面歌词 鼓点'),
        fxConsoleItem('t-desktopLyricsHighlight', '桌面歌词高亮跟随', '桌面逐字高亮'),
        fxConsoleItem('fx-desktoplyricssize', '桌面歌词大小', '桌面字号'),
        fxConsoleItem('fx-desktoplyricsopacity', consoleWorkspaceText('fx_desktop_lyrics_opacity'), '桌面歌词透明'),
        fxConsoleItem('fx-desktoplyricsy', '桌面歌词高度', '桌面位置'),
        fxConsoleItem('desktop-lyrics-fps-seg', consoleWorkspaceText('fx_desktop_lyrics_fps'), '24 30 60 120 无上限 FPS')
      ] },
      // 花再 Halo PixelBar 的同步设置。它原来挂在标题栏的一颗按钮 + 浮层里，和主界面那一排
      // 控件挤在一起，而它本质是「外接的歌词屏」—— 跟桌面歌词同性质，所以搬到同一页签。
      // index.html 只提供 #halo-sync-section 这个空容器，控件由 06-lyrics/halo-sync-bridge.js
      // 填进去；这里登记的是容器本身（整块搬运），因此 history 关掉 —— 它改的是音响配置，
      // 不在 fx 存档里，撤销历史抓不到任何变化，留一条空记录只会误导。
      // The Halo PixelBar sync settings used to be a titlebar button plus a popover, crowded in
      // with the main control row. It is really an external lyric screen, i.e. the same kind of
      // thing as desktop lyrics, so it moves to the same tab. index.html ships only the empty
      // container and halo-sync-bridge.js fills it; the container is what gets registered and
      // moved as a whole. History is off: it edits the speaker config, which is not in the fx
      // archive, so an undo snapshot would capture nothing.
      { key: 'halo', title: consoleWorkspaceText('halo_panel_title'), hint: consoleWorkspaceText('halo_group_hint'), items: [
        fxConsoleItem('halo-sync-section', consoleWorkspaceText('halo_panel_title'), '花再 音响 音箱 屏幕 灯效 歌词 硬件 Halo PixelBar speaker', false)
      ] }
    ]
  },
  {
    key: 'motion',
    groups: [
      { key: 'base', title: consoleWorkspaceText('fx_cat_scene'), hint: consoleWorkspaceText('fx_scene_hint'), open: true, items: [
        fxConsoleItem('fx-intensity', consoleWorkspaceText('rhythm_intensity', '律动强度'), '音乐响应 节奏'),
        fxConsoleItem('fx-depth', consoleWorkspaceText('fx_scene_depth'), '立体感 深度'),
        fxConsoleItem('fx-coverres', consoleWorkspaceText('cover_clarity', '封面清晰度'), '粒子数量 分辨率'),
        // 背景星河是预设自带的背景层：透明度按预设决定（星河/音域 0、骷髅 0.38、9-12 号
        // 0.10~0.18、其余 0.34），并在星河/音域下压掉主封面粒子云，所以归到基础画面。
        // 搜索别名只写标题里没有的说法（星空、粒子背景），重复标题的字眼没有意义。
        // The star river is a preset-owned layer: opacity follows the preset and it mutes the cover
        // particle cloud on the star-river presets, so it sits with the scene switches. Search
        // aliases only add wording the title does not already contain.
        // The alias carries Chinese synonyms only: it used to append a second dictionary key whose
        // text was identical to the title, which adds nothing to search. The useful part is wording
        // the title does not contain.
        fxConsoleItem('t-backgroundStarRiver', consoleWorkspaceText('fx_bg_galaxy'), '星空 粒子背景'),
        fxConsoleItem('fx-cineshake', consoleWorkspaceText('toggle_cinema', '电影镜头'), '镜头晃动 强度'),
        fxConsoleItem('t-cinema', consoleWorkspaceText('fx_cinema_toggle'), consoleWorkspaceText('shelf_camera_dynamic', '动态镜头'))
      ] },
      { key: 'particles', title: consoleWorkspaceText('fx_cat_particles'), hint: consoleWorkspaceText('fx_particle_hint'), items: [
        fxConsoleItem('t-float', consoleWorkspaceText('toggle_float_layer', '浮空粒子层'), '漂浮粒子'),
        fxConsoleItem('t-bloom', consoleWorkspaceText('toggle_bloom', '粒子溢光'), '粒子光晕'),
        fxConsoleItem('t-edge', consoleWorkspaceText('toggle_edge', '轮廓高亮'), '边缘光'),
        fxConsoleItem('fx-point', consoleWorkspaceText('particle_size', '粒子尺寸'), '点大小'),
        fxConsoleItem('fx-speed', consoleWorkspaceText('fx_particle_speed'), '粒子流速'),
        fxConsoleItem('fx-twist', consoleWorkspaceText('fx_particle_twist'), '旋转 扭曲'),
        fxConsoleItem('fx-color', consoleWorkspaceText('color_tension', '色彩张力'), '粒子颜色 饱和'),
        fxConsoleItem('fx-bloom', consoleWorkspaceText('fx_bloom_strength'), '溢光 bloom'),
        fxConsoleItem('fx-scatter', consoleWorkspaceText('scatter', '离散感'), '粒子散开'),
        fxConsoleItem('fx-bgfade', consoleWorkspaceText('fx_bg_darken'), '背景压缩 暗度')
      ] },
      { key: 'sonic-terrain', title: consoleWorkspaceText('fx_sonic_ground'), hint: consoleWorkspaceText('fx_terrain_hint'), items: [
        fxConsoleItem('fx-sonicamp', consoleWorkspaceText('fx_ground_undulation'), '音域振幅'),
        fxConsoleItem('fx-sonicspeed', consoleWorkspaceText('fx_terrain_wave_speed'), '地形运动'),
        fxConsoleItem('fx-sonicdensity', consoleWorkspaceText('fx_terrain_density'), '网格密度'),
        fxConsoleItem('fx-sonicrange', consoleWorkspaceText('fx_ground_range'), '地形大小'),
        fxConsoleItem('fx-soniclower', consoleWorkspaceText('fx_lyric_avoid'), '地形降低'),
        fxConsoleItem('fx-sonicdepth', consoleWorkspaceText('fx_ground_depth'), '地形景深'),
        fxConsoleItem('fx-sonicautorotate', consoleWorkspaceText('fx_terrain_rotate'), '旋转速度'),
        fxConsoleItem('sonic-ground-base-picker', consoleWorkspaceText('fx_terrain_shadow'), '音域底色'),
        fxConsoleItem('sonic-ground-cool-picker', consoleWorkspaceText('fx_cool_peak'), '音域冷色'),
        fxConsoleItem('sonic-ground-warm-picker', consoleWorkspaceText('fx_warm_peak'), '音域暖色'),
        fxConsoleItem('sonic-ground-accent-picker', consoleWorkspaceText('fx_ripple_highlight'), '音域强调色'),
        fxConsoleItem('fx-sonicglow', consoleWorkspaceText('fx_tonal_glow'), '地形辉光')
      ] },
      { key: 'sonic-audio', title: consoleWorkspaceText('fx_spectrum_response'), hint: consoleWorkspaceText('fx_spectrum_hint'), items: [
        fxConsoleItem('t-sonicAudioMonitorEnabled', consoleWorkspaceText('fx_realtime_spectrum'), '音频分析 频谱开关'),
        fxConsoleItem('t-sonicAudioAutoTrack', consoleWorkspaceText('fx_kick_auto'), '鼓点自动追踪'),
        fxConsoleItem('sonic-audio-monitor-toggle', consoleWorkspaceText('fx_spectrum_panel'), '音频监视器'),
        fxConsoleItem('fx-sonicaudiosensitivity', consoleWorkspaceText('fx_kick_sensitivity'), '鼓点灵敏度'),
        fxConsoleItem('fx-sonicaudiobandstart', consoleWorkspaceText('fx_band_start'), '频谱起点'),
        fxConsoleItem('fx-sonicaudiobandend', consoleWorkspaceText('fx_band_end'), '频谱终点'),
        fxConsoleItem('fx-sonicaudiothreshold', consoleWorkspaceText('fx_threshold'), '频谱门限'),
        fxConsoleItem('fx-sonicaudiopulse', consoleWorkspaceText('fx_trigger_pulse'), '频谱脉冲'),
        fxConsoleItem('fx-sonicsubbass', consoleWorkspaceText('fx_center_low'), 'Sub Bass'),
        fxConsoleItem('fx-sonicbass', consoleWorkspaceText('fx_low_freq_weight'), 'Bass'),
        fxConsoleItem('fx-soniclowmid', consoleWorkspaceText('fx_slow_wave'), 'Low Mid'),
        fxConsoleItem('fx-sonicmid', consoleWorkspaceText('fx_directional_flow'), 'Mid'),
        fxConsoleItem('fx-sonichighmid', consoleWorkspaceText('fx_spike'), 'High Mid'),
        fxConsoleItem('fx-sonicpresence', consoleWorkspaceText('fx_flash_trigger'), 'Presence'),
        fxConsoleItem('fx-sonicbrilliance', consoleWorkspaceText('fx_edge_flicker'), 'Brilliance'),
        fxConsoleItem('fx-sonicair', consoleWorkspaceText('fx_air_particles'), 'Air 高频')
      ] },
      { key: 'sonic-blocks', title: consoleWorkspaceText('fx_cube_section'), hint: consoleWorkspaceText('fx_cubes_hint'), items: [
        fxConsoleItem('t-sonicGroundFloatingEnabled', consoleWorkspaceText('fx_floating_cubes'), '音域方块开关'),
        fxConsoleItem('fx-sonicfloatcount', consoleWorkspaceText('fx_cube_count'), '浮空数量'),
        fxConsoleItem('fx-sonicfloatintensity', consoleWorkspaceText('fx_cube_strength'), '浮空强度'),
        fxConsoleItem('fx-sonicfloatmin', consoleWorkspaceText('fx_cube_min'), '最小尺寸'),
        fxConsoleItem('fx-sonicfloatmax', consoleWorkspaceText('fx_cube_max'), '最大尺寸'),
        fxConsoleItem('fx-sonicfloatspeed', consoleWorkspaceText('fx_cube_speed'), '浮空速度')
      ] },
      { key: 'sonic-we', title: consoleWorkspaceText('fx_we_section'), hint: consoleWorkspaceText('fx_we_hint'), items: [
        fxConsoleItem('fx-sonicwegain', consoleWorkspaceText('fx_we_input_compression'), 'WE 输入增益'),
        fxConsoleItem('fx-sonicweaudio', consoleWorkspaceText('fx_audio_response'), 'WE 音频强度'),
        fxConsoleItem('fx-sonicwerange', consoleWorkspaceText('fx_response_range'), 'WE 范围'),
        fxConsoleItem('fx-sonicwepeak', consoleWorkspaceText('fx_center_highlight'), 'WE 峰值'),
        fxConsoleItem('sonic-workshop-cover-picker', consoleWorkspaceText('fx_we_theme_base'), '主题 封面取色'),
        fxConsoleItem('sonic-workshop-base-picker', consoleWorkspaceText('fx_we_terrain_base'), 'WE 底色'),
        fxConsoleItem('sonic-workshop-warm-picker', consoleWorkspaceText('fx_we_warm_body'), 'WE 暖色'),
        fxConsoleItem('sonic-workshop-cool-picker', consoleWorkspaceText('fx_we_upper_highlight'), 'WE 冷色'),
        fxConsoleItem('sonic-workshop-ripple-picker', consoleWorkspaceText('fx_we_ripple_bright'), 'WE 波纹'),
        fxConsoleItem('sonic-workshop-peak-picker', consoleWorkspaceText('fx_we_peak_highlight'), 'WE 高光'),
        fxConsoleItem('sonic-workshop-theme-seg', consoleWorkspaceText('fx_we_theme'), '珊瑚 深海 冰蓝 翠绿 极简')
      ] }
    ]
  },
  {
    key: 'shelf',
    groups: [
      { key: 'display', title: consoleWorkspaceText('fx_cat_display'), hint: consoleWorkspaceText('fx_shelf_display_hint'), open: true, items: [
        fxConsoleItem('shelf-seg', '3D 歌单架', '关闭 侧栏 舞台'),
        fxConsoleItem('shelf-camera-seg', '歌单架镜头', '动态镜头 静态镜头'),
        fxConsoleItem('shelf-presence-seg', '歌单架显示', '自动隐藏 常驻'),
        fxConsoleItem('t-shelfShowPodcasts', '显示播客歌单', '3D 播客'),
        fxConsoleItem('t-shelfMergeCollections', '合并收藏歌单', '我的歌单 收藏 连续滚动')
      ] },
      { key: 'look', title: consoleWorkspaceText('fx_cat_appearance'), hint: consoleWorkspaceText('fx_shelf_appearance_hint'), items: [
        fxConsoleItem('shelf-accent-picker', '歌单架颜色', '3D 强调色'),
        fxConsoleItem('fx-shelfsize', '歌单架大小', '3D 缩放'),
        fxConsoleItem('fx-shelfx', '左右位置', '歌单架水平'),
        fxConsoleItem('fx-shelfy', '上下位置', '歌单架垂直'),
        fxConsoleItem('fx-shelfz', '前后景深', '歌单架远近'),
        fxConsoleItem('fx-shelfangle', '侧向角度', '歌单架旋转'),
        fxConsoleItem('fx-shelfopacity', '整体透明度', '歌单架透明'),
        fxConsoleItem('fx-shelfbgalpha', '背景透明度', '歌单架背景')
      ] },
      { key: 'detail-position', title: consoleWorkspaceText('fx_detail_position'), hint: consoleWorkspaceText('fx_detail_pos_hint'), items: [
        fxConsoleItem('fx-shelfdetailx', consoleWorkspaceText('fx_detail_horizontal'), '详情页水平'),
        fxConsoleItem('fx-shelfdetaily', consoleWorkspaceText('fx_detail_vertical'), '详情页垂直'),
        fxConsoleItem('fx-shelfdetailz', consoleWorkspaceText('fx_detail_depth'), '详情页景深'),
        fxConsoleItem('fx-shelfdetailscale', consoleWorkspaceText('fx_detail_size'), '详情页缩放'),
        fxConsoleItem('fx-shelfdetailanglex', consoleWorkspaceText('fx_detail_pitch'), '详情页上下角度'),
        fxConsoleItem('fx-shelfdetailangley', consoleWorkspaceText('fx_detail_side_rotation'), '详情页左右角度'),
        fxConsoleItem('fx-shelfdetailrowgap', consoleWorkspaceText('fx_detail_line_gap'), '歌曲行距')
      ] },
      { key: 'detail-motion', title: consoleWorkspaceText('fx_detail_animation'), hint: consoleWorkspaceText('fx_detail_anim_hint'), items: [
        fxConsoleItem('fx-shelfdetailopen', consoleWorkspaceText('fx_detail_expand_seconds'), '详情打开速度'),
        fxConsoleItem('fx-shelfdetailclose', consoleWorkspaceText('fx_detail_close_seconds'), '详情关闭速度'),
        fxConsoleItem('fx-shelfdetailrowtime', consoleWorkspaceText('fx_detail_row_enter'), '歌曲行动画'),
        fxConsoleItem('fx-shelfdetailintro', consoleWorkspaceText('fx_detail_expand_offset'), '详情入场位移'),
        fxConsoleItem('fx-shelfdetailparallax', consoleWorkspaceText('fx_detail_hover_parallax'), '详情视差')
      ] },
      { key: 'summon', title: consoleWorkspaceText('fx_shelf_reveal_anim'), hint: consoleWorkspaceText('fx_shelf_reveal_hint'), items: [
        fxConsoleItem('fx-shelfsummonopen', consoleWorkspaceText('fx_shelf_open_seconds'), '歌单架打开速度'),
        fxConsoleItem('fx-shelfsummonclose', consoleWorkspaceText('fx_shelf_close_seconds'), '歌单架关闭速度'),
        fxConsoleItem('fx-shelfsummonslide', consoleWorkspaceText('fx_shelf_reveal_offset'), '歌单架滑入'),
        fxConsoleItem('fx-shelfsummonstagger', consoleWorkspaceText('fx_shelf_card_layering'), '卡片延迟'),
        fxConsoleItem('fx-shelfsummonscale', consoleWorkspaceText('fx_shelf_reveal_scale'), '卡片缩放'),
        fxConsoleItem('fx-shelfsummonparallax', consoleWorkspaceText('fx_shelf_reveal_parallax'), '卡片视差'),
        fxConsoleItem('fx-shelfcamenter', consoleWorkspaceText('fx_shelf_camera_enter_speed'), '歌单镜头进入'),
        fxConsoleItem('fx-shelfcamexit', consoleWorkspaceText('fx_shelf_camera_leave_speed'), '歌单镜头退出')
      ] },
      { key: 'camera', title: '摄像头交互', hint: consoleWorkspaceText('fx_camera_gesture_toggle'), items: [
        fxConsoleItem('cam-seg', '摄像头交互', '关闭 手势触碰'),
        fxConsoleItem('gesture-settings-card', consoleWorkspaceText('fx_play_gesture'), '播放 暂停 上一首 下一首 音量 喜欢 歌词 手部光迹 灵敏度')
      ] }
    ]
  },
  {
    key: 'system',
    groups: [
      { key: 'startup', title: consoleWorkspaceText('fx_cat_startup_exit'), hint: consoleWorkspaceText('fx_close_hint'), open: true, items: [
        fxConsoleItem('close-behavior-seg', consoleWorkspaceText('fx_close_window'), '直接退出 后台托盘'),
        fxConsoleItem('t-startupAutoplay', consoleWorkspaceText('fx_autoplay'), '打开软件继续播放'),
        fxConsoleItem('t-startupFastSkip', consoleWorkspaceText('fx_fast_skip'), '快速启动'),
        fxConsoleItem('startup-resume-mode-seg', consoleWorkspaceText('fx_resume_position'), '按上次进度 重播整首'),
        // 与上面的启动项同组。⚠️ 必须登记：面板运行时会按这张表把 HTML 里的控件搬进分组页
        //（appendChild），没登记的会被残留扫描收进「系统 → 其他设置」——界面上只是位置不对、不报错，
        // 后果是它在正确分组里根本查不到（本轮就踩了：不登记时 #preferred-source-select 在运行时
        // 的 DOM 里直接找不到）。
        // Registered with the other startup items. ⚠️ This is mandatory: at runtime the panel moves each
        // control into its group page according to this table, and an unregistered one is swept into
        // "system → other settings" — positionally wrong with no error, and absent from the group it
        // belongs to (this round: without registration, #preferred-source-select was not even findable
        // in the runtime DOM).
        // 登记的是**外层容器**（标签 + 下拉一个块），不是 <select> 本身：控制台只搬运登记过的节点，
        // 标签若是单独的兄弟节点会被留在被丢弃的旧容器里，于是下拉没有标题、看不出是干什么的。
        // Registered is the WRAPPER (label + select as one block), not the <select>: the console moves
        // only the registered node, so a standalone label would be left in the discarded container and
        // the dropdown would appear with no title at all.
        fxConsoleItem('preferred-source-row', consoleWorkspaceText('settings_preferred_source'), '默认源 优先 网易云 QQ 酷狗 汽水 音源 preferred source'),
        // ⚠️ 这个开关一直没登记（上一轮加的时候漏了），所以它一直被残留扫描收进「其他设置」——
        //    界面上只是位置不对、不报错，属于"只有真去看分组才会发现"的那类缺陷。顺手补上。
        // ⚠️ This toggle was never registered (missed when it was added), so the residual sweep kept
        //    filing it under "other settings": positionally wrong, no error, and only visible if you
        //    actually open the group. Registered here.
        fxConsoleItem('t-spotifyLaunchClient', consoleWorkspaceText('settings_spotify_launch_title'), 'Spotify 唤起 客户端 换源 launch client')
      ] },
      { key: 'output', title: consoleWorkspaceText('fx_cat_output'), hint: consoleWorkspaceText('fx_output_hint'), items: [
        fxConsoleItem('audio-output-panel', consoleWorkspaceText('fx_output_device'), '声卡 耳机 扬声器 路由', false)
      ] },
      { key: 'performance', title: consoleWorkspaceText('fx_cat_performance'), hint: consoleWorkspaceText('fx_perf_hint'), items: [
        fxConsoleItem('performance-quality-seg', consoleWorkspaceText('section_quality', '画质档位'), '低配 中 高 超高 渲染质量'),
        fxConsoleItem('foreground-fps-seg', consoleWorkspaceText('fx_foreground_fps'), 'FPS 跟随屏幕 垂直同步 VSync 高刷 节能 45 60 75 90 120'),
        fxConsoleItem('t-lyricLiveViewportFit', consoleWorkspaceText('fx_lyric_bound'), '逐帧 投影 长歌词 屏幕余量 性能'),
        fxConsoleItem('t-lyricContextHighQuality', consoleWorkspaceText('fx_lyric_hd_texture'), '歌词 高清 预热 GPU 显存'),
        fxConsoleItem('t-lyricBackdropAdapt', consoleWorkspaceText('fx_global_avoid'), '歌词 亮底 可读性 动态'),
        fxConsoleItem('t-coverBackdropAdapt', consoleWorkspaceText('fx_cover_avoid'), '粒子 亮底 GPU 着色器'),
        // 必须和其他同格开关一起登记：面板在运行时会把 HTML 里那排开关搬到分组里（appendChild），
        // 没登记的会被残留扫描收进「系统 → 其他设置」，届时它在界面上只是位置不对，不会报错。
        // Must be registered alongside its grid siblings: the panel re-parents those toggles at runtime,
        // and anything unregistered is swept into System → Other settings with no visible error.
        fxConsoleItem('t-beatAnalysis', consoleWorkspaceText('toggle_beat_analysis', '自动节奏分析'), '节奏 节拍 谱面 BPM 分析 性能 电影镜头'),
        fxConsoleItem('performance-background-seg', consoleWorkspaceText('fx_background_render'), '自动优化 保持运行 停止释放'),
        fxConsoleItem('t-liveBackgroundKeep', consoleWorkspaceText('toggle_live_bg_keep', '直播后台保持'), '最小化继续渲染')
      ] },
      { key: 'memory', title: consoleWorkspaceText('fx_cat_memory'), hint: consoleWorkspaceText('fx_memory_hint'), items: [
        fxConsoleItem('memory-status-chip', consoleWorkspaceText('fx_memory_status'), 'Mem Reduct 占用', false),
        fxConsoleItem('memory-status-sub', consoleWorkspaceText('fx_memory_note'), '工作集 待机页', false),
        fxConsoleItem('t-memoryAutoTrimApp', consoleWorkspaceText('fx_mem_auto'), '内存 压缩 Electron'),
        fxConsoleItem('t-memoryAutoTrimOnBackground', consoleWorkspaceText('fx_memory_background_trim'), '最小化内存'),
        fxConsoleItem('t-memoryAutoSystemTrim', consoleWorkspaceText('fx_memory_auto_system'), 'Mem Reduct 自动'),
        fxConsoleItem('t-memorySystemAutoElevate', consoleWorkspaceText('fx_mem_admin'), 'UAC 提权'),
        fxConsoleItem('memory-mask-seg', consoleWorkspaceText('fx_memory_purge_scope'), '工作集 修改页 待机页'),
        fxConsoleItem('fx-memory-interval', consoleWorkspaceText('fx_memory_scheduled'), '分钟 间隔'),
        fxConsoleItem('fx-memory-threshold', consoleWorkspaceText('fx_memory_threshold'), '内存百分比'),
        fxConsoleItem({ selector: '.memory-action-row' }, consoleWorkspaceText('fx_memory_manual'), '压缩播放器 系统释放 提权释放', false)
      ] },
      { key: 'cache', title: consoleWorkspaceText('fx_cat_cache_storage'), hint: consoleWorkspaceText('fx_cache_hint'), items: [
        fxConsoleItem('cache-storage-panel', consoleWorkspaceText('server_local_cache', '本地缓存'), '缓存路径 缓存目录 占用 歌词 封面 音频 更新', false)
      ] },
      { key: 'experimental', title: consoleWorkspaceText('fx_cat_experimental'), hint: consoleWorkspaceText('fx_experimental_hint'), items: [
        fxConsoleItem('t-wallpaperMode', consoleWorkspaceText('toggle_wallpaper', '完整桌面模式'), '完整 Mineradio 进入桌面层 Ctrl Shift M 切换操作层 本次启动有效', false),
        // 完整桌面模式的两项配套参数，标成 child 以缩进挂在那个开关下面：整个 Mineradio 作为桌面
        // 壁纸时的透明度与帧率。它们在代码里与该模式共用一把锁、同一套 disabled 逻辑，此前没有
        // 分组登记，被兜底收进「其他设置」。
        //
        // html 上它们带着 hidden，但作者样式表的 .fx-slider{display:grid} / .fx-seg{display:flex}
        // 优先级高于 UA 的 [hidden]{display:none}，所以一直是可见的 —— 别被属性误导当成死项。
        // The two parameters of full desktop mode, marked as children so they sit indented under that
        // switch: the opacity and frame rate of Mineradio-as-desktop-wallpaper. They share the mode's
        // lock and disabled logic and had no group registration, so the residual sweep took them.
        // Their markup carries `hidden`, but the author-level .fx-slider{display:grid} /
        // .fx-seg{display:flex} rules outrank the UA [hidden]{display:none}, so they are visible.
        fxConsoleItem('fx-wallpaperopacity', consoleWorkspaceText('wallpaper_opacity', '壁纸透明度'), '壁纸 透明 淡', true, true),
        fxConsoleItem('wallpaper-fps-seg', consoleWorkspaceText('fx_wallpaper_fps'), '24 30 60 FPS 帧率', true, true),
        // 背景来源与该开关同级：它决定桌面模式背后画什么，和透明度/帧率不是同一类参数。
        // The backdrop source sits at the same level: it decides what is painted behind desktop
        // mode, unlike the opacity/FPS parameters above.
        fxConsoleItem('t-desktopWallpaperBackdrop', consoleWorkspaceText('fx_desktop_backdrop', '桌面壁纸作背景'), '透出系统桌面壁纸 WE 壁纸需在引擎里设为桌面壁纸 关闭则用 Mineradio 视觉', false),
        fxConsoleItem('t-windowsGameMode', consoleWorkspaceText('fx_game_mode'), '登记为游戏 电源计划 调度优先级 整活 非 Windows 置灰', false),
        fxConsoleItem('t-cuefieldAutoMix', 'Cuefield AutoMix', '自动混音 过渡 节拍分析 下一首 预载 交叉淡化')
      ] }
    ]
  }
];
}

var fxConsoleRegistry = [];
var fxConsoleGroups = {};

function fxConsoleResolveBlock(ref) {
  var el = null;
  if (typeof ref === 'string') el = document.getElementById(ref);
  else if (ref && ref.element) el = ref.element;
  else if (ref && ref.selector) el = document.querySelector('#fx-panel ' + ref.selector) || document.querySelector(ref.selector);
  if (!el) return null;
  var selector = '.fx-slider,.lyric-color-row,.lyric-color-grid,.fx-seg,.preset-grid,.user-archive-grid,.fx-font-grid,.fx-toggle,.lyric-glitch-controls,.lyric-glow-effect-row,.sonic-audio-monitor,.audio-output-section,.cache-storage-panel,.memory-status-chip,.memory-status-sub,.memory-action-row,.halo-sync-section,.fx-actions';
  if (el.matches && el.matches(selector)) return el;
  return el.closest ? (el.closest(selector) || el) : el;
}

function fxConsoleMakeToolbar(panel) {
  // 面板顶栏：左侧标题、右侧撤销 / 历史，分类标签页在下面一行。
  // .fx-console-toolbar 这个 class 名保留 —— fxConsoleClickIsReversible 与
  // fxConsoleFindUnclassifiedControls 用它排除顶栏区域的控件。
  // Panel header: title left, undo / history right, category tabs below. The .fx-console-toolbar
  // class name stays because the reversible-click and unclassified-control guards exclude it.
  var toolbar = document.createElement('div');
  toolbar.className = 'fx-console-toolbar';
  toolbar.id = 'fx-console-toolbar';
  toolbar.innerHTML = consoleWorkspaceText('fx_panel_tabs_html');
  var tabs = toolbar.querySelector('#fx-panel-tabs');
  // 词典未就绪时 fx_panel_tabs_html 退化成键名，innerHTML 里没有 #fx-panel-tabs，
  // querySelector 返回 null，必须自己兜一个空壳。index-loader 把所有模块拼成一个脚本，
  // 这里抛错会让后面的模块（splash、startup 绑定、主循环）全部不执行，界面只剩黑屏。
  // Before the dictionary resolves the html key degrades to its own name, so the shell is
  // missing and must be synthesized. A throw here would skip every later module (the loader
  // concatenates them into one script) and leave a black screen.
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.id = 'fx-panel-tabs';
    tabs.className = 'fx-panel-tabs';
    tabs.setAttribute('role', 'tablist');
    toolbar.appendChild(tabs);
  }
  fxConsoleTabs().forEach(function (meta) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'fx-console-tab-' + meta.key;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-fx-tab', meta.key);
    btn.setAttribute('aria-controls', 'fx-console-page-' + meta.key);
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('tabindex', '-1');
    btn.textContent = meta.label;
    tabs.appendChild(btn);
  });
  // —— 撤销 / 历史入口 ——
  // 撤销栈、40 条上限、650ms 合并窗口与「撤销至此项前」都在本文件实现；这里只负责放入口。
  // Undo / history entry points. The stack, its 40-entry cap, the 650ms merge window and
  // "undo up to here" live in this file; this block only builds the entry points.
  var head = document.createElement('div');
  head.className = 'fx-console-head';

  var headTitle = document.createElement('span');
  headTitle.className = 'fx-console-head-title';
  headTitle.textContent = consoleWorkspaceText('visual_console', '视觉控制台');
  head.appendChild(headTitle);

  var actions = document.createElement('div');
  actions.className = 'fx-console-toolbar-actions';

  // 图标 + 文字：纯文字在 10px 字号下认不出是「撤销」还是「重做」，纯图标又太隐晦。
  // Icon plus label: at 10px a bare word is ambiguous, and an icon alone is too cryptic.
  var ICON_UNDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H10"/></svg>';
  var ICON_HISTORY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3 4.5V9h4.5"/><path d="M12 8v4.4l3 1.8"/></svg>';

  var historyToggle = document.createElement('button');
  historyToggle.type = 'button';
  historyToggle.id = 'fx-console-history-toggle';
  historyToggle.className = 'fx-console-tool-btn';
  historyToggle.innerHTML = ICON_HISTORY + '<span>' + consoleWorkspaceText('fx_history_label', '历史') + '</span>';
  historyToggle.setAttribute('aria-controls', 'fx-console-history');
  historyToggle.setAttribute('aria-expanded', 'false');

  var undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.id = 'fx-console-undo';
  undoButton.className = 'fx-console-tool-btn';
  undoButton.innerHTML = ICON_UNDO + '<span>' + consoleWorkspaceText('fx_undo', '撤销') + '</span>';
  undoButton.disabled = true;
  undoButton.addEventListener('click', function () { undoFxConsoleHistory(); });

  var historyPopover = document.createElement('div');
  historyPopover.id = 'fx-console-history';
  // fx-console-history-popover 是上游 2.1.0/2.2.0 原样的类名，留着自己以后做区分用。
  historyPopover.className = 'fx-console-popover fx-console-history-popover';
  historyPopover.hidden = true;

  historyToggle.addEventListener('click', function () {
    setFxConsoleHistoryOpen(historyPopover.hidden);
  });

  // 撤销是主操作，放在最右（贴着面板右缘），历史在它左边。
  // Undo is the primary action, so it sits rightmost; history tucks in to its left.
  actions.appendChild(historyToggle);
  actions.appendChild(undoButton);
  head.appendChild(actions);
  // 浮层挂在**顶栏**而不是按钮组里：按钮组只有百来像素宽，挂进去浮层会被压成一条窄柱。
  // 顶栏是 position:relative，浮层左右各 0 就能撑满面板宽度。
  // The popover hangs off the HEADER, not the button group: the group is only ~100px wide and
  // would squeeze the list into a narrow column. The header is position:relative, so a
  // left/right:0 popover spans the panel width.
  head.appendChild(historyPopover);
  // 整个顶栏排在分类标签页**上方**：发丝级的分隔比塞在标签页右侧更容易看见，
  // 也不会和多出来的第 7、8 个分类抢横向空间。
  // The header sits ABOVE the category tabs: it reads as a panel header instead of competing
  // with the tabs for horizontal room as categories grow.
  toolbar.insertBefore(head, tabs);
  panel.appendChild(toolbar);
  // 首次渲染一次：把撤销按钮置为 disabled、历史浮层填上空态文案。
  renderFxConsoleHistory();
  return toolbar;
}

// 打开/关闭历史浮层。第一次打开时才挂 document 上的「点外面关掉」与 Escape 监听，
// 避免面板全程常驻两个全局监听（这个控制台是重型面板，能少一个是一个）。
// Toggle the history popover. The outside-click and Escape listeners are attached on first
// open only, so a closed console carries no global listeners at all.
var fxConsoleHistoryDismissBound = false;

function setFxConsoleHistoryOpen(open) {
  var popover = document.getElementById('fx-console-history');
  var toggle = document.getElementById('fx-console-history-toggle');
  if (!popover) return;
  var next = !!open;
  popover.hidden = !next;
  if (toggle) toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
  if (!next) return;
  renderFxConsoleHistory();
  if (fxConsoleHistoryDismissBound) return;
  fxConsoleHistoryDismissBound = true;
  document.addEventListener('click', function (event) {
    var bar = document.getElementById('fx-console-toolbar');
    if (bar && event.target && bar.contains(event.target)) return;
    setFxConsoleHistoryOpen(false);
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event && event.key === 'Escape') setFxConsoleHistoryOpen(false);
  });
}

function fxConsoleMakeGroup(page, tabMeta, groupMeta) {
  var fold = document.createElement('section');
  fold.className = 'fx-fold fx-console-group' + (groupMeta.open ? ' open' : '');
  fold.setAttribute('data-fx-console-group', groupMeta.key);
  fold.setAttribute('data-fx-console-tab', tabMeta.key);
  var groupId = 'fx-console-' + tabMeta.key + '-' + groupMeta.key;
  var head = document.createElement('button');
  head.type = 'button';
  head.id = groupId + '-head';
  head.className = 'fx-fold-head fx-console-group-head';
  head.setAttribute('aria-expanded', groupMeta.open ? 'true' : 'false');
  head.setAttribute('aria-controls', groupId + '-body');
  var title = document.createElement('span');
  title.className = 'fx-fold-title';
  var strong = document.createElement('strong');
  strong.textContent = groupMeta.title;
  var small = document.createElement('small');
  small.textContent = groupMeta.hint || '';
  title.appendChild(strong);
  title.appendChild(small);
  var arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '▶';
  head.appendChild(title);
  head.appendChild(arrow);
  var body = document.createElement('div');
  body.id = groupId + '-body';
  body.className = 'fx-fold-body fx-console-group-body';
  fold.setAttribute('aria-labelledby', head.id);
  head.addEventListener('click', function () {
    var open = !fold.classList.contains('open');
    fold.classList.toggle('open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (typeof repositionFxFloatingPanels === 'function') repositionFxFloatingPanels();
  });
  fold.appendChild(head);
  fold.appendChild(body);
  page.appendChild(fold);
  fxConsoleGroups[tabMeta.key + ':' + groupMeta.key] = fold;
  return body;
}

function fxConsoleAppendItem(body, tabMeta, groupMeta, item, state) {
  var node = fxConsoleResolveBlock(item.ref);
  if (!node) {
    console.warn('[FxConsole] control missing:', item.title, item.ref);
    return;
  }
  var existing = null;
  for (var i = 0; i < fxConsoleRegistry.length; i++) {
    if (fxConsoleRegistry[i].element === node) { existing = fxConsoleRegistry[i]; break; }
  }
  if (existing) {
    existing.aliases += ' ' + item.aliases;
    return;
  }
  if (node.classList.contains('fx-toggle')) {
    // 从属块之后的开关必须另起一个 grid。child 分支不会清空 state.toggleGrid，所以若直接复用，
    // 下一个开关会被追加到上一个的 grid 里，DOM 顺序变成 "grid[开关A, 开关B] + childNest[参数]" ——
    // 参数就跑到了两个开关下面，分隔线（相邻兄弟选择器）也永远匹配不上。
    // 命中 childNest 说明刚处理过从属项，此时强制新建。
    if (!state.toggleGrid || state.childNest) {
      state.toggleGrid = document.createElement('div');
      state.toggleGrid.className = 'fx-toggle-grid fx-console-toggle-grid';
      body.appendChild(state.toggleGrid);
    }
    state.childNest = null;
    state.toggleGrid.appendChild(node);
  } else if (item.child) {
    // 从属控件：套一层缩进容器，并画一条左侧导线接到上面那个开关，读起来是"它的参数"而不是新的一项。
    if (!state.childNest) {
      state.childNest = document.createElement('div');
      state.childNest.className = 'fx-console-child-nest';
      body.appendChild(state.childNest);
    }
    state.childNest.appendChild(node);
  } else {
    state.toggleGrid = null;
    state.childNest = null;
    body.appendChild(node);
  }
  var entry = {
    id: 'fx-console-entry-' + (fxConsoleRegistry.length + 1),
    title: item.title,
    aliases: item.aliases || '',
    tab: tabMeta.key,
    tabLabel: tabMeta.label,
    group: groupMeta.key,
    groupLabel: groupMeta.title,
    history: item.history !== false,
    element: node
  };
  node.setAttribute('data-fx-console-entry', entry.id);
  node.setAttribute('data-fx-console-tab', entry.tab);
  node.setAttribute('data-fx-console-group', entry.group);
  node.setAttribute('data-fx-console-title', entry.title);
  node.setAttribute('data-fx-console-history', entry.history ? 'on' : 'off');
  fxConsoleRegistry.push(entry);
}

function fxConsoleFindUnclassifiedControls(roots) {
  // blockSelector 决定"一个控件属于哪一块"：命中的元素会被整块搬走，没命中的则退化成裸控件。
  // ⚠️ 这里必须包含 `.fx-select`（原生下拉）：否则一个 <select> 会被当成无可归属的裸控件扫走，
  //    即便它已登记，外观与分组也取决于扫描顺序 —— 本轮新增「默认源」下拉时踩到的就是这个。
  // The selector decides which "block" a control belongs to: a match is moved as a whole, a miss
  // degrades to a bare control. ⚠️ It must include `.fx-select`: otherwise a <select> is swept as an
  // unowned bare control, and where it lands depends on scan order rather than on its registration.
  var blockSelector = '.fx-select-row,.fx-select,.fx-slider,.lyric-color-row,.lyric-color-grid,.fx-seg,.preset-grid,.user-archive-grid,.fx-font-grid,.fx-toggle,.lyric-glitch-controls,.lyric-glow-effect-row,.sonic-audio-monitor,.audio-output-section,.cache-storage-panel,.memory-status-chip,.memory-status-sub,.memory-action-row,.halo-sync-section,.fx-actions';
  var blocks = [];
  roots.forEach(function (root) {
    if (!root || !root.isConnected) return;
    if (root.matches && root.matches('input:not([type="hidden"]),select,textarea,button') && !root.closest('[data-fx-console-entry],.fx-console-toolbar,.fx-fold-head,.fx-advanced-head')) {
      blocks.push(root);
    }
    root.querySelectorAll('input:not([type="hidden"]),select,textarea,button').forEach(function (control) {
      if (control.closest('.fx-console-toolbar') || control.closest('[data-fx-console-entry]')) return;
      if (control.closest('.fx-fold-head,.fx-advanced-head')) return;
      var block = control.matches && control.matches(blockSelector) ? control : (control.closest ? control.closest(blockSelector) : null);
      if (!block) block = control;
      if (blocks.indexOf(block) < 0) blocks.push(block);
    });
  });
  return blocks;
}

function fxConsoleSyncHeaderHeight(panel, toolbar) {
  if (!panel || !toolbar) return;
  var apply = function () {
    var height = Math.round(toolbar.getBoundingClientRect().height);
    if (height > 0) panel.style.setProperty('--fx-console-head-h', height + 'px');
  };
  apply();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
  if (typeof ResizeObserver === 'function') {
    if (panel._fxConsoleHeaderResizeObserver) {
      try { panel._fxConsoleHeaderResizeObserver.disconnect(); } catch (_) { }
    }
    var observer = new ResizeObserver(apply);
    observer.observe(toolbar);
    panel._fxConsoleHeaderResizeObserver = observer;
  }
}

function organizeFxConsoleWorkspace() {
  var panel = document.getElementById('fx-panel');
  if (!panel) return;
  if (panel._fxConsoleWorkspaceOrganized) {
    setFxPanelTab(fxPanelTab);
    return;
  }
  // 面板的子节点全是上一轮留下的（.fx-head 挂载点已随热键按钮一起移出控制台），
  // 所以 oldRoots 就是 panel.children 的全部，直接整批清掉。
  // Every child of the panel is a leftover from the previous build (the .fx-head mount point
  // left with the hotkey button), so oldRoots is simply all of panel.children.
  var oldRoots = Array.prototype.slice.call(panel.children);
  fxConsoleRegistry = [];
  fxConsoleGroups = {};
  var oldTabs = document.getElementById('fx-panel-tabs');
  if (oldTabs && oldTabs.parentNode) oldTabs.parentNode.removeChild(oldTabs);
  var toolbar = fxConsoleMakeToolbar(panel);
  // 顶栏卡片固定在面板顶部，只有它下面的内容滚动：页面挂在独立滚动容器里，
  // 面板本身不再滚动，卡片因此不会随内容上移。
  // The header card stays docked at the panel top and only the content below scrolls: pages live
  // in their own scroll container, so the card never travels with the content.
  // 每轮重建都新建滚动容器：旧容器连同上一轮的页面在下面的清理里按旧节点删掉，
  // 但必须等新页面建完 —— 登记过的控件要从旧页面里搬出来，先删就什么都没了。
  // Every build creates a fresh scroller; the old one is removed with the other stale nodes at
  // the end. It has to survive until the new pages are built, because registered controls are
  // moved out of the old pages and would be destroyed if it went first.
  var scrollRoot = document.createElement('div');
  scrollRoot.id = 'fx-console-scroll';
  panel.appendChild(scrollRoot);
  panel.classList.add('fx-console-has-scroll');
  var pages = {};
  fxConsoleTabs().forEach(function (meta) {
    var page = document.createElement('div');
    page.id = 'fx-console-page-' + meta.key;
    page.className = 'fx-tab-page';
    page.setAttribute('data-fx-page', meta.key);
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-labelledby', 'fx-console-tab-' + meta.key);
    page.setAttribute('aria-hidden', 'true');
    scrollRoot.appendChild(page);
    pages[meta.key] = page;
  });
  fxConsoleLayout().forEach(function (tabLayout) {
    var tabMeta = null;
    fxConsoleTabs().some(function (meta) {
      if (meta.key === tabLayout.key) { tabMeta = meta; return true; }
      return false;
    });
    if (!tabMeta || !pages[tabMeta.key]) return;
    tabLayout.groups.forEach(function (groupMeta) {
      var body = fxConsoleMakeGroup(pages[tabMeta.key], tabMeta, groupMeta);
      var state = { toggleGrid: null, childNest: null };
      groupMeta.items.forEach(function (item) {
        fxConsoleAppendItem(body, tabMeta, groupMeta, item, state);
      });
    });
  });
  var residual = fxConsoleFindUnclassifiedControls(oldRoots);
  if (residual.length) {
    var fallbackMeta = { key: 'other', title: consoleWorkspaceText('fx_cat_other'), hint: consoleWorkspaceText('fx_compat_uncategorized') };
    var fallbackBody = fxConsoleMakeGroup(pages.system, { key: 'system', label: consoleWorkspaceText('fx_cat_system') }, fallbackMeta);
    residual.forEach(function (node, index) {
      fxConsoleAppendItem(fallbackBody, { key: 'system', label: consoleWorkspaceText('fx_cat_system') }, fallbackMeta, {
        ref: { element: node },
        title: String(node.textContent || consoleWorkspaceText('fx_cat_compat')).trim().slice(0, 40) || consoleWorkspaceText('fx_cat_compat'),
        aliases: '其他 兼容',
        history: true
      }, { toggleGrid: null, childNest: null });
    });
    console.warn('[FxConsole] residual controls:', residual.length);
  }
  // oldRoots 是**本轮创建任何新节点之前**对 panel 子节点拍的快照，所以里面每一项都必然是
  // 旧节点，直接删掉即可。之前这里多了一个 `!node.classList.contains('fx-tab-page')` 排除，
  // 意图是"别误删本轮新建的 page"，但新旧 page 同名同类，根本区分不开 ——
  // 结果就是每次重建都把上一轮的 6 个 tab page 留在原地，重贴一次翻一倍。
  // 实测：重贴后 fx-console-page-* 在 panel 下各出现两次，内容重复且键名残留。
  //
  // oldRoots is a snapshot taken BEFORE this run creates any new nodes, so everything in it
  // is necessarily stale and can simply be removed. The old guard excluded .fx-tab-page to
  // "avoid deleting this run's new pages", but new and old pages share the same id and class,
  // so it could not tell them apart — every rebuild left the previous run's six tab pages in
  // place, doubling the panel on each repaint (measured: each fx-console-page-* appeared
  // twice, with duplicated content and leftover key names).
  oldRoots.forEach(function (node) {
    // 滚动容器是本轮要复用的新结构，不属于旧节点：重建时把它删掉会让面板只剩顶栏。
    // The scroller is reused across builds and is not a stale node: deleting it here would
    // leave the panel with only its header and an empty body.
    if (!node || node === scrollRoot) return;
    if (node && node.isConnected && node.parentNode === panel && node !== toolbar) node.remove();
  });
  toolbar.querySelector('#fx-panel-tabs').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-fx-tab]') : null;
    if (!btn) return;
    setFxPanelTab(btn.getAttribute('data-fx-tab'));
    if (typeof closeFxConsolePopovers === 'function') closeFxConsolePopovers();
  });
  toolbar.querySelector('#fx-panel-tabs').addEventListener('keydown', function (e) {
    if (!/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) return;
    var buttons = Array.prototype.slice.call(toolbar.querySelectorAll('[data-fx-tab]'));
    var current = buttons.indexOf(document.activeElement);
    if (current < 0) return;
    e.preventDefault();
    var next = e.key === 'Home' ? 0 : (e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length);
    buttons[next].focus();
    setFxPanelTab(buttons[next].getAttribute('data-fx-tab'));
  });
  // 快捷键设置按钮曾在 .fx-head 里，需要注册进 registry 才能被归类。
  // 现在它已移到标题栏（index.html 静态声明），**必须不再登记**：
  // 注册会让重建把它当作面板内控件搬进 tab page，标题栏就少了一个按钮。
  // 早期靠 `!hotkey.closest('.fx-console-toolbar')` 之类的排除项是挡不住的 ——
  // 它根本不在 panel 里。唯一的做法就是不把它登记进控制台。
  //
  // The hotkey button used to live in .fx-head and had to be registered to be categorized.
  // It now lives in the title bar (declared statically in index.html) and must NOT be
  // registered: an entry makes the rebuild treat it as a panel control and move it into a tab
  // page, costing the title bar a button. Exclusions like `closest('.fx-console-toolbar')`
  // cannot help — the node is not inside the panel at all. The only fix is to not register it.
  panel._fxConsoleWorkspaceOrganized = true;
  panel.setAttribute('data-console-layout', 'task-first-v2');
  setFxPanelTab(fxPanelTab);
  // 顶栏是浮在内容之上的常驻卡片，内容区的上边距要按它的真实高度让位。
  // The header floats above the content, so the scroller's top padding tracks its real height.
  fxConsoleSyncHeaderHeight(panel, toolbar);
}

// 词典是异步加载的，而 bindFxPanel() 在解析期就跑了 —— 那时词典还没到，
// consoleWorkspaceText() 缺键会返回键名本身，于是面板上铺满 fx_cat_xxx / fx_lyric_xxx。
// organizeFxConsoleWorkspace() 开头有幂等短路，直接重跑会早退、什么也不重贴；
// 而 fxConsoleRegistry 里存的是**已经求值过**的文案，键名已经固化进去了。
// 所以只能把幂等标记清掉、整个工作区重建一遍。
//
// The dictionary loads asynchronously while bindFxPanel() runs synchronously during
// parse, so a missing key used to render as the key itself and the panel filled up with
// fx_cat_xxx / fx_lyric_xxx. organizeFxConsoleWorkspace() short-circuits on its idempotency
// flag and fxConsoleRegistry stores already-evaluated text, so the only reliable repaint is
// to clear the flag and rebuild the whole workspace.
function relabelFxConsoleWorkspace() {
  var panel = document.getElementById('fx-panel');
  if (!panel) return;
  panel._fxConsoleWorkspaceOrganized = false;
  try {
    organizeFxConsoleWorkspace();
  } catch (e) {
    console.warn('[FxConsole] relabel failed:', e);
  }
  if (typeof relabelFxPanelControls === 'function') {
    try { relabelFxPanelControls(); } catch (e) { console.warn('[FxConsole] relabel controls failed:', e); }
  }
}

// 语言就绪（init 完成会广播一次）与后续切换都要重贴，否则键名会一直留在界面上。
// Repaint once the dictionary is ready (init broadcasts) and on every later switch —
// otherwise the key names stay on screen.
if (typeof window !== 'undefined' && window.MineradioI18n && typeof window.MineradioI18n.onLanguageChange === 'function') {
  window.MineradioI18n.onLanguageChange(function () { relabelFxConsoleWorkspace(); });
}

function fxConsoleEntryForElement(element) {
  var node = element && element.closest ? element.closest('[data-fx-console-entry]') : null;
  if (!node) return null;
  var id = node.getAttribute('data-fx-console-entry');
  for (var i = 0; i < fxConsoleRegistry.length; i++) {
    if (fxConsoleRegistry[i].id === id) return fxConsoleRegistry[i];
  }
  return null;
}



function closeFxConsolePopovers() {
  var results = document.getElementById('fx-console-search-results');
  var history = document.getElementById('fx-console-history');
  var historyBtn = document.getElementById('fx-console-history-toggle');
  var search = document.getElementById('fx-console-search');
  if (results) results.hidden = true;
  if (history) history.hidden = true;
  if (historyBtn) historyBtn.setAttribute('aria-expanded', 'false');
  if (search) search.setAttribute('aria-expanded', 'false');
}

var fxConsoleSearchHitDelayTimer = 0;
var fxConsoleSearchHitClearTimer = 0;

var fxConsoleHistory = [];
var fxConsoleHistoryTxn = null;
var fxConsoleHistoryApplying = false;
var FX_CONSOLE_HISTORY_LIMIT = 40;

function captureFxConsoleState() {
  var snapshot = null;
  if (typeof captureFxArchiveSnapshot === 'function') snapshot = captureFxArchiveSnapshot();
  if (!snapshot) {
    var raw = { visualPresetSchema: typeof VISUAL_PRESET_SCHEMA !== 'undefined' ? VISUAL_PRESET_SCHEMA : 2 };
    Object.keys(fx || {}).forEach(function (key) { raw[key] = fx[key]; });
    snapshot = typeof normalizeFxArchiveSnapshot === 'function' ? normalizeFxArchiveSnapshot(raw) : Object.assign({}, raw);
  }
  return {
    fx: snapshot || {},
    closeBehavior: typeof closeBehaviorPreference !== 'undefined' ? closeBehaviorPreference : null,
    startupResumeMode: typeof startupResumeModePreference !== 'undefined' ? startupResumeModePreference : null,
    startupAutoplay: typeof startupAutoplayPreference !== 'undefined' ? !!startupAutoplayPreference : null,
    startupFastSkip: typeof startupFastSkipPreference !== 'undefined' ? !!startupFastSkipPreference : null
  };
}

var FX_CONSOLE_PREF_KEYS = ['closeBehavior', 'startupResumeMode', 'startupAutoplay', 'startupFastSkip'];
var FX_CONSOLE_EXCLUDED_FX_KEYS = { backgroundAlbumCover: true };

function fxConsoleValueEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fxConsoleChangedKeys(before, after) {
  var changed = { fx: [], prefs: [] };
  var keys = {};
  Object.keys(before && before.fx || {}).forEach(function (key) { keys[key] = true; });
  Object.keys(after && after.fx || {}).forEach(function (key) { keys[key] = true; });
  Object.keys(keys).forEach(function (key) {
    if (!FX_CONSOLE_EXCLUDED_FX_KEYS[key] && !fxConsoleValueEqual(before.fx[key], after.fx[key])) changed.fx.push(key);
  });
  FX_CONSOLE_PREF_KEYS.forEach(function (key) {
    if (!fxConsoleValueEqual(before && before[key], after && after[key])) changed.prefs.push(key);
  });
  return changed;
}

function fxConsoleChangesEmpty(changes) {
  return !changes || (!changes.fx.length && !changes.prefs.length);
}


function fxConsoleFormatHistoryValue(value) {
  if (value === true) return consoleWorkspaceText('feature_state_on', '开启');
  if (value === false) return consoleWorkspaceText('shelf_off', '关闭');
  if (typeof value === 'number') return Math.abs(value - Math.round(value)) < 0.0001 ? String(Math.round(value)) : String(Math.round(value * 100) / 100);
  if (value == null) return consoleWorkspaceText('value_none', '无');
  return String(value);
}

function fxConsoleHistoryDetail(before, after, changes) {
  var changed = [];
  changes = changes || fxConsoleChangedKeys(before, after);
  changes.fx.forEach(function (key) {
    changed.push([before.fx[key], after.fx[key]]);
  });
  changes.prefs.forEach(function (key) {
    changed.push([before[key], after[key]]);
  });
  if (!changed.length) return '';
  if (changed.length > 1) return changed.length + consoleWorkspaceText('fx_params_count');
  return fxConsoleFormatHistoryValue(changed[0][0]) + ' → ' + fxConsoleFormatHistoryValue(changed[0][1]);
}

function fxConsoleHistoryControlLabel(entry, target) {
  var label = entry ? entry.title : consoleWorkspaceText('fx_cat_visual');
  var button = target && target.closest ? target.closest('button') : null;
  if (button && button.textContent && !button.classList.contains('fx-reset-one')) {
    var text = button.textContent.replace(/\s+/g, ' ').trim();
    if (text && text !== label && text.length < 22) label += ' · ' + text;
  }
  return label;
}

function pushFxConsoleHistory(label, controlKey, before, after, mergeable, adapter) {
  var changes = fxConsoleChangedKeys(before, after);
  if (fxConsoleHistoryApplying || fxConsoleChangesEmpty(changes)) return;
  var now = Date.now();
  var last = fxConsoleHistory[fxConsoleHistory.length - 1];
  if (mergeable && last && last.controlKey === controlKey && now - last.time < 650) {
    last.after = after;
    last.changes = fxConsoleChangedKeys(last.before, last.after);
    last.time = now;
    last.detail = fxConsoleHistoryDetail(last.before, last.after, last.changes);
    if (adapter) {
      last.adapter = last.adapter || adapter;
      last.adapter.afterValue = adapter.afterValue;
    }
    if (fxConsoleChangesEmpty(last.changes)) fxConsoleHistory.pop();
  } else {
    fxConsoleHistory.push({
      label: label,
      controlKey: controlKey,
      before: before,
      after: after,
      changes: changes,
      adapter: adapter || null,
      time: now,
      detail: fxConsoleHistoryDetail(before, after, changes)
    });
    if (fxConsoleHistory.length > FX_CONSOLE_HISTORY_LIMIT) fxConsoleHistory.shift();
  }
  renderFxConsoleHistory();
}

function fxConsoleMergeChanges(records) {
  var merged = { fx: [], prefs: [] };
  var fxSeen = {};
  var prefSeen = {};
  (records || []).forEach(function (record) {
    var changes = record && record.changes || fxConsoleChangedKeys(record.before, record.after);
    changes.fx.forEach(function (key) { if (!fxSeen[key]) { fxSeen[key] = true; merged.fx.push(key); } });
    changes.prefs.forEach(function (key) { if (!prefSeen[key]) { prefSeen[key] = true; merged.prefs.push(key); } });
  });
  return merged;
}

function fxConsoleStateMatchesChanges(current, target, changes) {
  if (!current || !target) return false;
  for (var i = 0; i < changes.fx.length; i++) {
    var fxKey = changes.fx[i];
    if (!fxConsoleValueEqual(current.fx[fxKey], target.fx[fxKey])) return false;
  }
  for (var j = 0; j < changes.prefs.length; j++) {
    var prefKey = changes.prefs[j];
    if (!fxConsoleValueEqual(current[prefKey], target[prefKey])) return false;
  }
  return true;
}

function fxConsoleTryApplyInputAdapter(record, targetState, changes) {
  var adapter = record && record.adapter;
  if (!adapter || adapter.kind !== 'input' || changes.prefs.length) return false;
  var control = document.getElementById(adapter.controlId);
  if (!control || !control.matches('input[type="range"],input[type="color"]')) return false;
  control.value = adapter.beforeValue;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  return fxConsoleStateMatchesChanges(captureFxConsoleState(), targetState, changes);
}

function fxConsoleApplyPreferences(state, changes) {
  if (changes.prefs.indexOf('closeBehavior') >= 0 && state.closeBehavior != null && typeof setCloseBehaviorPreference === 'function') {
    setCloseBehaviorPreference(state.closeBehavior, { toast: false });
  }
  if (changes.prefs.indexOf('startupResumeMode') >= 0 && state.startupResumeMode != null && typeof setStartupResumeModePreference === 'function') {
    setStartupResumeModePreference(state.startupResumeMode, { toast: false });
  }
  if (changes.prefs.indexOf('startupAutoplay') >= 0 && state.startupAutoplay != null && typeof startupAutoplayPreference !== 'undefined' && startupAutoplayPreference !== state.startupAutoplay && typeof toggleStartupAutoplay === 'function') {
    toggleStartupAutoplay();
  }
  if (changes.prefs.indexOf('startupFastSkip') >= 0 && state.startupFastSkip != null && typeof startupFastSkipPreference !== 'undefined' && startupFastSkipPreference !== state.startupFastSkip && typeof toggleStartupFastSkip === 'function') {
    toggleStartupFastSkip();
  }
}

function fxConsoleApplyState(state, label, records, allowAdapter) {
  if (!state || fxConsoleHistoryApplying) return false;
  records = records || [];
  var changes = fxConsoleMergeChanges(records);
  if (fxConsoleChangesEmpty(changes)) return false;
  fxConsoleHistoryApplying = true;
  try {
    var applied = allowAdapter && records.length === 1 && fxConsoleTryApplyInputAdapter(records[0], state, changes);
    if (!applied && changes.fx.length) {
      var current = captureFxConsoleState();
      var merged = Object.assign({}, current.fx);
      changes.fx.forEach(function (key) { merged[key] = state.fx[key]; });
      if (typeof applyFxArchiveSnapshot !== 'function' || !applyFxArchiveSnapshot(merged)) throw new Error(consoleWorkspaceText('fx_visual_restore_failed'));
    }
    fxConsoleApplyPreferences(state, changes);
    if (typeof configureMemoryReductFromFx === 'function') configureMemoryReductFromFx('history-undo', false);
    if (typeof saveLyricLayout === 'function') saveLyricLayout({ user: true, reason: 'consoleHistoryUndo' });
    if (typeof showToast === 'function') showToast(consoleWorkspaceText('fx_undo_applied') + label);
    return true;
  } catch (error) {
    console.error('[FxConsole] history rollback failed', error);
    if (typeof showToast === 'function') showToast(consoleWorkspaceText('fx_undo_failed'));
    return false;
  } finally {
    setTimeout(function () {
      fxConsoleHistoryApplying = false;
      renderFxConsoleHistory();
    }, 0);
  }
}

function undoFxConsoleHistory() {
  if (!fxConsoleHistory.length || fxConsoleHistoryApplying) return;
  var record = fxConsoleHistory[fxConsoleHistory.length - 1];
  if (!fxConsoleApplyState(record.before, record.label, [record], true)) return;
  fxConsoleHistory.pop();
  renderFxConsoleHistory();
}

function rollbackFxConsoleHistoryTo(index) {
  index = Math.max(0, Math.min(fxConsoleHistory.length - 1, Number(index) || 0));
  var record = fxConsoleHistory[index];
  var records = fxConsoleHistory.slice(index);
  if (!record || !fxConsoleApplyState(record.before, record.label, records, false)) return;
  fxConsoleHistory.length = index;
  renderFxConsoleHistory();
}

function renderFxConsoleHistory() {
  var undo = document.getElementById('fx-console-undo');
  var pop = document.getElementById('fx-console-history');
  if (undo) undo.disabled = !fxConsoleHistory.length || fxConsoleHistoryApplying;
  if (!pop) return;
  pop.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'fx-console-popover-head';
  head.innerHTML = consoleWorkspaceText('fx_recent_ops_html');
  pop.appendChild(head);
  if (!fxConsoleHistory.length) {
    var empty = document.createElement('div');
    empty.className = 'fx-console-empty';
    empty.textContent = consoleWorkspaceText('fx_history_hint');
    pop.appendChild(empty);
    return;
  }
  for (var i = fxConsoleHistory.length - 1; i >= 0; i--) {
    (function (index) {
      var record = fxConsoleHistory[index];
      var row = document.createElement('div');
      row.className = 'fx-console-history-item';
      var text = document.createElement('span');
      var title = document.createElement('strong');
      title.textContent = record.label;
      var meta = document.createElement('small');
      var d = new Date(record.time);
      meta.textContent = [String(d.getHours()).padStart(2, '0'), String(d.getMinutes()).padStart(2, '0'), String(d.getSeconds()).padStart(2, '0')].join(':') + (record.detail ? ' · ' + record.detail : '');
      text.appendChild(title);
      text.appendChild(meta);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = index === fxConsoleHistory.length - 1 ? consoleWorkspaceText('fx_undo') : consoleWorkspaceText('fx_undo_to_here');
      btn.addEventListener('click', function () {
        if (index === fxConsoleHistory.length - 1) undoFxConsoleHistory();
        else rollbackFxConsoleHistoryTo(index);
      });
      row.appendChild(text);
      row.appendChild(btn);
      pop.appendChild(row);
    })(i);
  }
}

function fxConsoleClickIsReversible(target, entry) {
  if (!target || !entry || !entry.history) return false;
  if (target.closest('.fx-console-toolbar,.fx-console-group-head')) return false;
  if (target.matches('input[type="range"],input[type="color"]')) return false;
  if (target.closest('#audio-output-panel,#cache-storage-panel,.memory-action-row,.bg-media-row,.wallpaper-engine-row')) return false;
  var archive = target.closest('#user-archive-grid');
  if (archive) {
    var archiveBtn = target.closest('button');
    return !!(archiveBtn && archiveBtn.textContent.trim() === consoleWorkspaceText('fx_apply'));
  }
  return !!target.closest('button,.fx-toggle,.fx-seg,.lyric-color-row,.fx-font-grid,.preset-card,.fx-actions');
}

function fxConsoleBeginRangeTxn(target) {
  if (fxConsoleHistoryApplying || !target) return;
  var entry = fxConsoleEntryForElement(target);
  if (!entry || !entry.history) return;
  var input = target.matches && target.matches('input[type="range"],input[type="color"]') ? target : target.closest('input[type="range"],input[type="color"]');
  if (!input) return;
  if (fxConsoleHistoryTxn && fxConsoleHistoryTxn.control === input) return;
  fxConsoleHistoryTxn = {
    control: input,
    entry: entry,
    before: captureFxConsoleState(),
    beforeValue: input.value,
    label: entry.title,
    key: input.id || entry.id
  };
}

function fxConsoleCommitRangeTxn(target) {
  if (!fxConsoleHistoryTxn || fxConsoleHistoryApplying) return;
  if (target && fxConsoleHistoryTxn.control !== target && !(target.closest && target.closest('#color-lab-pop'))) return;
  var txn = fxConsoleHistoryTxn;
  fxConsoleHistoryTxn = null;
  pushFxConsoleHistory(txn.label, txn.key, txn.before, captureFxConsoleState(), true, {
    kind: 'input',
    controlId: txn.control.id,
    beforeValue: txn.beforeValue,
    afterValue: txn.control.value
  });
}


// 视觉控制台的交互绑定入口。滑块拖拽事务（pointerdown/focusin → fxConsoleBeginRangeTxn →
// fxConsoleCommitRangeTxn）都在这里挂载，守卫只判 panel，不依赖任何输入框节点。
// Interaction wiring for the visual console. The slider drag transactions
// (pointerdown/focusin → fxConsoleBeginRangeTxn → fxConsoleCommitRangeTxn) are bound here,
// guarded by the panel alone — no input node required.
function initFxConsoleSearchAndHistory() {
  var panel = document.getElementById('fx-panel');
  if (!panel || panel._fxConsoleSearchHistoryBound) return;
  panel._fxConsoleSearchHistoryBound = true;
  // 滚动期间给 body 挂标记，CSS 借此暂停卡片自身的背景模糊；停手 140ms 后恢复。
  // scroll 不冒泡，用捕获阶段监听内容区的滚动。
  // Mark the body while the console scrolls so CSS can suspend per-card backdrop blur; the
  // marker clears 140ms after scrolling stops. Scroll does not bubble, hence capture.
  var consoleScrollIdleTimer = 0;
  panel.addEventListener('scroll', function () {
    document.body.classList.add('fx-console-scrolling');
    if (consoleScrollIdleTimer) clearTimeout(consoleScrollIdleTimer);
    consoleScrollIdleTimer = setTimeout(function () {
      consoleScrollIdleTimer = 0;
      document.body.classList.remove('fx-console-scrolling');
    }, 140);
  }, { capture: true, passive: true });
  panel.addEventListener('pointerdown', function (e) {
    if (e.target && e.target.matches && e.target.matches('input[type="range"],input[type="color"]')) fxConsoleBeginRangeTxn(e.target);
  }, true);
  panel.addEventListener('focusin', function (e) {
    if (e.target && e.target.matches && e.target.matches('input[type="range"],input[type="color"]')) fxConsoleBeginRangeTxn(e.target);
  }, true);
  panel.addEventListener('keydown', function (e) {
    if (e.target && e.target.matches && e.target.matches('input[type="range"]')) fxConsoleBeginRangeTxn(e.target);
  }, true);
  panel.addEventListener('change', function (e) {
    if (!e.target || !e.target.matches || !e.target.matches('input[type="range"],input[type="color"]')) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(e.target); });
  }, true);
  panel.addEventListener('focusout', function (e) {
    if (!fxConsoleHistoryTxn || fxConsoleHistoryTxn.control !== e.target) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(e.target); });
  }, true);
  panel.addEventListener('click', function (e) {
    if (fxConsoleHistoryApplying) return;
    var entry = fxConsoleEntryForElement(e.target);
    if (!fxConsoleClickIsReversible(e.target, entry)) return;
    var before = captureFxConsoleState();
    var label = fxConsoleHistoryControlLabel(entry, e.target);
    var key = entry.id + ':' + label;
    // The console listens in capture phase, while many controls still use
    // inline/bubble click handlers. Defer to the next task so the target
    // handler has committed its value before the "after" snapshot is read.
    setTimeout(function () {
      pushFxConsoleHistory(label, key, before, captureFxConsoleState(), false);
    }, 0);
  }, true);
  document.addEventListener('pointerdown', function (e) {
    if (!e.target || !e.target.closest || !e.target.closest('#color-lab-pop')) return;
    if (!fxConsoleHistoryTxn && typeof colorLabState !== 'undefined' && colorLabState && colorLabState.picker) fxConsoleBeginRangeTxn(colorLabState.picker);
  }, true);
  document.addEventListener('pointerup', function (e) {
    if (!fxConsoleHistoryTxn) return;
    if (e.target && e.target.closest && e.target.closest('#color-lab-pop button')) return;
    var colorTxn = fxConsoleHistoryTxn.control.matches('input[type="color"]');
    if (colorTxn && (!e.target || !e.target.closest || !e.target.closest('#color-lab-pop'))) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(colorTxn ? e.target : null); });
  }, true);
  document.addEventListener('pointercancel', function () {
    if (fxConsoleHistoryTxn) queueMicrotask(function () { fxConsoleCommitRangeTxn(null); });
  }, true);
  document.addEventListener('click', function (e) {
    if (!fxConsoleHistoryTxn || !e.target || !e.target.closest || !e.target.closest('#color-lab-pop')) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(e.target); });
  }, true);
  document.addEventListener('change', function (e) {
    if (!fxConsoleHistoryTxn || !e.target || !e.target.closest || !e.target.closest('#color-lab-pop')) return;
    queueMicrotask(function () { fxConsoleCommitRangeTxn(e.target); });
  }, true);
  document.addEventListener('pointerdown', function (e) {
    if (!e.target || !e.target.closest || e.target.closest('#fx-console-toolbar,#color-lab-pop')) return;
    closeFxConsolePopovers();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var results = document.getElementById('fx-console-search-results');
    var history = document.getElementById('fx-console-history');
    if ((!results || results.hidden) && (!history || history.hidden)) return;
    closeFxConsolePopovers();
    // 焦点留在原处：这里没有需要归还焦点的输入框。
    // Leave focus where it is: there is no input to hand focus back to.
  }, true);
  window.addEventListener('blur', function () {
    if (fxConsoleHistoryTxn) fxConsoleCommitRangeTxn(null);
  });
}
