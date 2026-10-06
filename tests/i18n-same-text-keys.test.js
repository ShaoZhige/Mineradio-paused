'use strict';

// 「同文本多键」是这套词典的既有形态：多个键的中文值逐字相同，靠**元素 id** 或
// **语义**区分，不是冗余。典型三组：
//   bg_color（取色器 input 的 title） vs bg_color_label（旁边可见的 span 标签）
//   bg_opacity（歌词背景） vs shelf_bg_opacity（3D 歌单架背景）
//   tab_playlists（面板 tab） vs home_my_playlists（首页卡片）
// 真正该删的是**零引用的死键**（btn_close_bg 已删），不是「值相同」的键。
//
// 本守卫做两件事：
//   1. 记死「同文本多键」清单，值集合变化时报警 —— 有人合并或新增同义键会立刻看到；
//   2. 消歧映射表钉住「显示点 → 键」，防止接线时挑错同文本的那个键。
// Same-text keys are a deliberate shape here, distinguished by element id or meaning.
// Merging them would lose the ability to translate those two elements differently later.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LANGS = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];

function loadDict(lang) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', lang + '.json'), 'utf8'));
}
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const DICTS = LANGS.map(loadDict);
const BY_VALUE = new Map();
for (const [key, value] of Object.entries(DICTS[0])) {
  if (!BY_VALUE.has(value)) BY_VALUE.set(value, []);
  BY_VALUE.get(value).push(key);
}

// 记死的同文本多键清单（78 组）。改动这一项前先想清楚：是键多了，还是这两个键该合并？
// 一个值对应多个键时，en 侧必须能区分它们 —— 四语完全相同的两个键无法独立翻译。
// 本清单的每一组都已在非中文侧区分开：中文相同只是当前措辞一致，元素不同就应能分头调。
// 曾经有一组是例外：fx_bg_galaxy / fx_starfield 四语同义（中文都叫「背景星河」，英文一个
// galaxy 一个 starfield），既无法独立翻译、又让同一个功能有两套外文名。它们已被合并成一个键
// （fx_starfield 删除，别名改用中文同义措辞），所以不在本清单里 —— 再出现「同一个值两个键」
// 时先问一句：这两个键真的需要分别翻译吗？
// The former fx_bg_galaxy / fx_starfield pair was the exception: identical meaning in every
// language, so it could never be translated independently and gave one feature two foreign names.
// They are now a single key, which is why the pair is absent here.
// 同系列孪生键（fx_range_start / fx_band_start 那种）已经合并掉了；留在这里的要么跨区域
// 共用措辞，要么非中文侧还能区分。
const KNOWN_SAME_TEXT = [
  ['背景透明度', ['bg_opacity', 'shelf_bg_opacity']],
  ['背景颜色', ['bg_color', 'bg_color_label']],
  ['壁纸帧数', ['fx_wallpaper_fps', 'fx_wallpaper_frames']],
  ['冰蓝', ['accent_ice_blue', 'fx_theme_arctic']],
  ['播放 / 暂停', ['fx_play_pause', 'hotkey_play_pause']],
  ['播放过的歌曲会出现在这里', ['dash_recent_hint', 'home_recent_sub']],
  ['翠绿', ['accent_emerald', 'fx_theme_forest']],
  ['打开官方扫码窗口', ['login_open_qq_window', 'open_scan_window']],
  ['当前', ['source_state_active', 'translation_current']],
  ['地形暗部', ['fx_terrain_dark', 'fx_terrain_shadow']],
  ['等待记录', ['dash_waiting_record', 'home_waiting']],
  ['等待识别本机 Wallpaper Engine 库', ['we_waiting', 'we_waiting_recognize']],
  ['低频重量', ['fx_low_freq_weight', 'fx_low_weight']],
  ['点击打开音乐库', ['dash_click_open_library', 'home_next_sub']],
  ['抖动幅度', ['fx_glitch_jitter', 'fx_shake_amp']],
  ['队列里还没有歌曲', ['dash_queue_empty', 'home_next_empty']],
  ['方块大值', ['fx_block_max', 'fx_cube_max']],
  ['方块强度', ['fx_block_strength', 'fx_cube_strength']],
  ['方块数量', ['fx_block_count', 'fx_cube_count']],
  ['方块速度', ['fx_block_speed', 'fx_cube_speed']],
  ['方块小值', ['fx_block_min', 'fx_cube_min']],
  ['浮空方块', ['fx_floating_blocks', 'fx_floating_cubes']],
  ['歌词', ['dt_lyric_title', 'hotkey_cat_lyrics']],
  ['歌词溢光', ['lyric_glow', 'toggle_lyric_glow']],
  ['歌单架唤出动画', ['fx_shelf_reveal_anim_title', 'fx_shelf_summon_anim']],
  ['歌单详情页动画', ['fx_detail_anim', 'fx_detail_anim_title']],
  ['歌单详情页位置', ['fx_detail_pos', 'fx_detail_pos_title']],
  ['跟随鼓点故障', ['fx_glitch_follow', 'track_glitch_follow_beat']],
  ['关闭', ['btn_close', 'camera_off', 'feature_state_off', 'shelf_off', 'translation_off']],
  ['红心喜欢', ['dt_like_title', 'track_heart_like']],
  ['后台触发压缩', ['fx_mem_bg', 'fx_memory_background_trim']],
  ['唤出秒数', ['fx_shelf_open_seconds', 'fx_summon_sec']],
  ['唤出视差', ['fx_shelf_reveal_parallax', 'fx_summon_parallax']],
  ['唤出缩放', ['fx_shelf_reveal_scale', 'fx_summon_scale']],
  ['唤出位移', ['fx_shelf_reveal_offset', 'fx_summon_offset']],
  ['今日歌曲', ['dash_today_songs', 'home_today_songs']],
  ['卡片错层', ['fx_card_stagger', 'fx_shelf_card_layering']],
  ['亮底避光', ['fx_light_avoid', 'fx_lyric_bright_avoid']],
  ['洛雪自定义音源', ['btn_custom_source', 'custom_source_title']],
  ['默认', ['btn_default', 'font_default']],
  ['前台帧率上限', ['fx_foreground_fps', 'fx_fps_cap']],
  ['切片幅度', ['fx_glitch_slice', 'fx_slice_amp']],
  ['全沉浸式', ['bind_full_immersive', 'dt_immersive_title']],
  ['全屏', ['btn_fullscreen', 'btn_maximize']],
  ['软件可正常操作', ['dc_normal', 'overlay_controls_normal']],
  ['扫码', ['lg_scan', 'login_scan']],
  ['扫码登录', ['btn_scan_login', 'scan_qr_login']],
  ['色散强度', ['fx_dispersion', 'fx_glitch_dispersion']],
  ['珊瑚', ['accent_coral', 'fx_theme_coral']],
  ['上下句高清纹理', ['fx_hd_tex', 'fx_lyric_hd_texture']],
  ['上下句间距', ['fx_context_spacing', 'fx_lyric_context_gap']],
  ['上下句清晰', ['fx_context_clear', 'fx_lyric_context_clarity']],
  ['深海', ['accent_deep_sea', 'fx_theme_ocean']],
  ['使用 <b>网易云音乐 App</b> 扫码，可同步歌单、红心与播客。', ['lg_netease_desc', 'netease_app_scan_desc']],
  ['使用当前 Mineradio 推荐数据', ['dash_use_current_recommend', 'home_daily_sub']],
  ['收起秒数', ['fx_collapse_sec', 'fx_shelf_close_seconds']],
  ['输入压制', ['fx_input_suppress', 'fx_we_input_compression']],
  ['锁定后防误触；鼠标移到桌面歌词上按中键可锁定/解锁', ['fx_desktop_lyrics_lock_hint', 'fx_lock_title']],
  ['图标已显示', ['dc_icons_shown', 'overlay_icons_shown_short']],
  ['未启用 · 原背景保留', ['bg_we_disabled', 'we_not_enabled_original']],
  ['我的歌单', ['home_my_playlists', 'tab_playlists']],
  ['系统级定时释放', ['fx_mem_sys', 'fx_memory_auto_system']],
  ['系统内存读取中...', ['fx_mem_reading', 'mem_reading']],
  ['详情侧旋', ['fx_detail_side_rotation', 'fx_detail_yaw']],
  ['详情前后', ['fx_detail_depth', 'fx_detail_z']],
  ['行入场秒数', ['fx_detail_row_enter', 'fx_row_in_sec']],
  ['选择一种电影视角分析方式', ['ba_choose_mode', 'beatcache_choose_mode']],
  ['音乐库', ['dash_library', 'home_library']],
  ['音域方块', ['fx_cube_section', 'fx_sonic_blocks']],
  ['音域光强', ['fx_sonic_glow', 'fx_tonal_glow']],
  ['桌面歌词绑定鼓点电影震动，基础漂浮始终保留', ['fx_desktop_lyrics_cinema', 'fx_vibration_title']],
  ['自定义音源不可用', ['custom_source_fail_unavailable', 'custom_source_unavailable_toast']],
  ['自动换源', ['as_auto_switch', 'pf_auto_switch']],
  ['最近播放', ['dash_recent_plays', 'home_recent']],
  ['左栏唤出', ['fx_left_open', 'fx_leftbar_open']],
  ['WE 壁纸缩放', ['bg_we_scale', 'fx_we_zoom']],
  ['WE 壁纸透明度', ['bg_we_opacity', 'fx_we_opacity']],
  ['WE 窗口静默', ['fx_we_silent', 'fx_we_window_silence']],
];

// 跨系列撞车白名单：两个键分属不同区域（快捷键分类 vs 详情标题、强调色 vs FX 主题…），
// 中文相同、译文也相同是**正确**的翻译 —— 强行差异化只会制造错译。第三位是允许撞车的语言。
// Cross-series allowlist: the two keys belong to different areas (hotkey category vs
// detail title, accent colour vs FX theme), so identical translations are correct here.
const CROSS_SERIES_ALLOWED = [
  ['冰蓝', ['accent_ice_blue', 'fx_theme_arctic'], ['en_us', 'ja_jp']],
  ['播放 / 暂停', ['fx_play_pause', 'hotkey_play_pause'], ['en_us', 'ja_jp']],
  ['播放过的歌曲会出现在这里', ['dash_recent_hint', 'home_recent_sub'], ['ja_jp']],
  ['翠绿', ['accent_emerald', 'fx_theme_forest'], ['en_us', 'ja_jp']],
  ['等待记录', ['dash_waiting_record', 'home_waiting'], ['ja_jp']],
  ['队列里还没有歌曲', ['dash_queue_empty', 'home_next_empty'], ['en_us', 'ru_ru']],
  ['歌词', ['dt_lyric_title', 'hotkey_cat_lyrics'], ['en_us', 'ja_jp']],
  ['红心喜欢', ['dt_like_title', 'track_heart_like'], ['en_us']],
  ['今日歌曲', ['dash_today_songs', 'home_today_songs'], ['en_us', 'ja_jp']],
  ['全沉浸式', ['bind_full_immersive', 'dt_immersive_title'], ['en_us']],
  ['软件可正常操作', ['dc_normal', 'overlay_controls_normal'], ['en_us', 'ru_ru']],
  ['扫码', ['lg_scan', 'login_scan'], ['en_us', 'ja_jp']],
  ['珊瑚', ['accent_coral', 'fx_theme_coral'], ['en_us', 'ja_jp']],
  ['深海', ['accent_deep_sea', 'fx_theme_ocean'], ['en_us', 'ru_ru']],
  ['使用当前 Mineradio 推荐数据', ['dash_use_current_recommend', 'home_daily_sub'], ['ja_jp']],
  ['图标已显示', ['dc_icons_shown', 'overlay_icons_shown_short'], ['en_us', 'ru_ru']],
  ['系统内存读取中...', ['fx_mem_reading', 'mem_reading'], ['en_us', 'ru_ru']],
  ['选择一种电影视角分析方式', ['ba_choose_mode', 'beatcache_choose_mode'], ['en_us', 'ru_ru']],
  ['最近播放', ['dash_recent_plays', 'home_recent'], ['ja_jp', 'ru_ru']],
  ['WE 壁纸缩放', ['bg_we_scale', 'fx_we_zoom'], ['ru_ru']],
  ['WE 壁纸透明度', ['bg_we_opacity', 'fx_we_opacity'], ['en_us']],
];

// 显示点 → 必须用哪个键。键挑错不会抛异常，只是那个元素在切换语言时不跟着变。
// element/display point -> the key it must use. Picking the twin key fails silently.
// 锚点必须是**唯一**的 markup 片段：像 class="fx-color-row-label" 这样的 class 在页面里
// 出现十几次，用它当锚点会匹配到第一处（另一个颜色行），判据就成了摆设。
// Anchors must be unique markup: that class occurs a dozen times, so anchoring on it would
// match an unrelated colour row and turn the check into a no-op.
// 第四位是「这条文案落在哪种载体上」：'' 表示文本节点（data-i18n），
// 'title' 表示 title 属性（data-i18n-title）。判据必须按载体分，否则 title 型文案
// 会被当成没接线 —— 取色器 input 走的就是 data-i18n-title。
// Slot 4 is the carrier: '' for a text node (data-i18n), 'title' for the title
// attribute (data-i18n-title). Matching has to be per-carrier or a title-only
// string reads as unwired — colour-picker inputs are wired through data-i18n-title.
const DISAMBIGUATION = [
  ['public/index.html', 'id="bg-color-picker"', 'bg_color', 'title'],
  ['public/index.html', 'data-i18n="bg_color_label"', 'bg_color_label', ''],
  ['public/index.html', 'id="fx-bgopacity"', 'bg_opacity', ''],
  ['public/index.html', 'id="fx-shelfbgalpha"', 'shelf_bg_opacity', ''],
  ['public/index.html', 'id="tab-pl"', 'tab_playlists', ''],
];

test('同文本多键清单没有意外变化', () => {
  const actual = [...BY_VALUE.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([value, keys]) => [value, keys.slice().sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const expected = KNOWN_SAME_TEXT
    .map(([value, keys]) => [value, keys.slice().sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const missing = expected.filter((e) => !actual.some((a) => a[0] === e[0] && a[1].join() === e[1].join()));
  const added = actual.filter((a) => !expected.some((e) => e[0] === a[0] && e[1].join() === a[1].join()));
  // 分别断言两个数组：合成一个对象再和 {} 比是错的（空数组 ≠ 空对象），
  // 而且报错时看不出是哪一侧变了。
  // Assert the two arrays separately: folding them into one object and comparing against {}
  // is wrong (an empty array is not an empty object) and hides which side changed.
  assert.deepStrictEqual(missing, [],
    '这些键在清单里，但现在已经不是同文本（可能被合并或改了中文）：' + JSON.stringify(missing));
  assert.deepStrictEqual(added, [],
    '新出现的同文本多键。允许新增（不同元素可以共用中文），但要确认不是想合并已有键：'
    + JSON.stringify(added));
});

test('同文本多键在非中文侧必须能区分（否则无法独立翻译）', () => {
  const offenders = [];
  for (const [value, keys] of BY_VALUE) {
    if (keys.length < 2) continue;
    for (let i = 1; i < LANGS.length; i++) {
      if (new Set(keys.map((k) => DICTS[i][k])).size !== 1) continue;
      const sorted = keys.slice().sort().join();
      const allowed = CROSS_SERIES_ALLOWED.some((e) => e[0] === value
        && e[1].join() === sorted && e[2].includes(LANGS[i]));
      if (allowed) continue;
      offenders.push(`「${value}」的 ${keys.join(' / ')} 在 ${LANGS[i]} 里译文完全相同 —— 切换语言时这两个元素无法区分`);
    }
  }
  // 同文本键在 zh 相同是设计如此；非中文侧也相同则说明这条区分没有实际价值。
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('消歧映射表指向的键确实存在，且元素确实声明了它', () => {
  const offenders = [];
  for (const [rel, anchor, key, carrier] of DISAMBIGUATION) {
    const attr = carrier ? 'data-i18n-' + carrier : 'data-i18n';
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const at = source.indexOf(anchor);
    if (at < 0) {
      offenders.push(`${rel} 里找不到锚点 ${anchor}`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(DICTS[0], key)) {
      offenders.push(`${rel} 的消歧键 ${key} 在词典里不存在`);
      continue;
    }
    // 声明可能在锚点之前、也可能与之同属一个控件块而不同标签
    // （`<div class="fx-slider"><label data-i18n="bg_opacity">…<input id="fx-bgopacity">`）。
    // 所以先看锚点所在开标签，再看它所在的控件块。
    // The declaration can sit before the anchor or share the control block without sharing
    // the tag, so check the anchor's own tag first, then the surrounding control block.
    const tagStart = source.lastIndexOf('<', at);
    const tagEnd = source.indexOf('>', at);
    const ownTag = tagStart >= 0 && tagEnd > tagStart ? source.slice(tagStart, tagEnd) : '';
    if (ownTag.includes(attr + '="' + key + '"')) continue;
    const blockStart = source.lastIndexOf('<div class="fx-slider">', at);
    const block = blockStart >= 0 ? source.slice(blockStart, source.indexOf('</div>', blockStart)) : '';
    if (!block.includes(attr + '="' + key + '"')) {
      offenders.push(`${rel} 的 ${anchor} 所在控件块没有声明 ${attr}="${key}"`);
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('四份词典内部没有重复键（JSON 会静默取最后一个）', () => {
  // 实测踩过：一次键序断言失败后重跑插入脚本，四份词典各多出 9 个重复键。
  // JSON 解析重复键时静默取最后一个，不报任何错 —— 所有测试照样全绿，
  // 但「改这个键」从此变成 no-op。只有按行数键、直接看原始文本才抓得到。
  // Hit this for real: re-running an insert script after a failed assertion left 9 duplicate
  // keys in every dictionary. JSON keeps the last duplicate silently, so every test stayed
  // green while edits to those keys became no-ops. Only counting raw lines catches it.
  const offenders = [];
  for (const lang of LANGS) {
    const raw = fs.readFileSync(path.join(ROOT, 'public', 'locales', lang + '.json'), 'utf8');
    const keys = [...raw.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
    const seen = new Set();
    for (const key of keys) {
      if (seen.has(key)) offenders.push(`${lang} 里 ${key} 出现多次`);
      seen.add(key);
    }
    if (keys.length !== seen.size) {
      offenders.push(`${lang} 文本里有 ${keys.length} 条但只有 ${seen.size} 个唯一键`);
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('零引用的同文本键不会残留（死键该删而不是留着）', () => {
  // 曾经存在一个 btn_close_bg，四语都与 btn_close 相同且全仓零引用，已删除。
  // 这条守卫防的是同类：值重复本身不是问题，零引用的重复才是。
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.workbuddy') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|md)$/.test(entry.name)) sources.push(full);
    }
  };
  walk(ROOT);
  const blob = sources.map((f) => stripComments(fs.readFileSync(f, 'utf8'))).join('\n');
  const dead = [];
  for (const [, keys] of BY_VALUE) {
    if (keys.length < 2) continue;
    for (const key of keys) {
      if (!blob.includes("'" + key + "'") && !blob.includes('"' + key + '"')) dead.push(key);
    }
  }
  assert.deepStrictEqual(dead, [], '这些同文本键全仓零引用，属于死键：' + dead.join(', '));
});
