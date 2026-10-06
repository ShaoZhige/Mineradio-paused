'use strict';

// 界面露出 i18n 键名（fx_restore_slider_default、dash_waiting_music_html 之类）几乎都不是"词典缺键"，
// 而是**取词太早**：模块在解析期求值、词典却是异步 fetch 的，此时缺键按约定返回键名本身，
// 于是键名被固化进 DOM 属性/文本或一份顶层数据里，之后再没有人改它。
// 实测两类成因，本条守卫两边都要盯：
//   1. 顶层 var/const 的初值里直接调用取词函数 -> 值被永久冻住（打包存档名 preset_default_test 就是这种）；
//   2. 只写一次的控件（幂等短路 / 不在重贴路径上）-> DOM 里的键名没人再改
//      （107 个滑条复位按钮、补丁台状态文案、歌词来源按钮、空态发现列表都属于这种）。
//
// Why a key name can reach the screen: almost never a missing dictionary entry, but a lookup that
// runs too early — modules evaluate during parse while the dictionary is fetched asynchronously,
// and a missing key returns the key itself, which then gets frozen into DOM or into top-level data
// with nothing left to refresh it. This guard covers both causes.
//
// 局限：顶层扫描按"名字以 Text 结尾 + 紧跟一个引号包起来的键名"的**形态**匹配（不枚举函数名，
// 枚举出来的清单一定会漏）。RHS 直接是函数表达式/箭头函数的语句会跳过 —— 那种取词在调用期才跑。
// Limitation: the scan matches the accessor SHAPE (name ends in Text, followed by a quoted key)
// rather than an enumerated list, and skips statements whose RHS is itself a function.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadDict } = require('./helpers/module-source');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'public', 'js', 'modules');
const dicts = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'].map((lang) => ({ lang, dict: loadDict(lang) }));

// 结构断言只认真代码：注释里出现的键名不算接线。
// Structural assertions read real code; a key named in a comment does not count.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readModule(rel) {
  return fs.readFileSync(path.join(MODULES, rel), 'utf8');
}

function allModuleFiles() {
  const out = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    });
  };
  walk(MODULES);
  return out.sort();
}

// —— 成因 1：顶层数据的初值里含**无兜底**取词调用 ——
// 带兜底的调用在词典就绪前也能显示可读文字，属于可接受形态，不报。
const BARE_GETTER_CALL = /\b[A-Za-z_$][\w$]*Text\s*\(\s*'[^']+'\s*\)/;
const TOP_LEVEL_ASSIGN = /^(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;
const RHS_IS_FUNCTION = /^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

function bracketDelta(text) {
  return (text.match(/[([{]/g) || []).length - (text.match(/[)\]}]/g) || []).length;
}

function topLevelDataWithBareGetterCall(source) {
  const lines = stripComments(source).replace(/\r\n/g, '\n').split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = TOP_LEVEL_ASSIGN.exec(lines[i]);
    if (!m || RHS_IS_FUNCTION.test(m[2])) continue;
    const startLine = i + 1;
    const parts = [m[2]];
    let depth = bracketDelta(m[2]);
    while (depth > 0 && i + 1 < lines.length && i + 2 - startLine < 40) {
      i += 1;
      parts.push(lines[i]);
      depth += bracketDelta(lines[i]);
    }
    if (BARE_GETTER_CALL.test(parts.join('\n'))) offenders.push(m[1] + ' (行 ' + startLine + ')');
  }
  return offenders;
}

test('顶层数据不得在初值里调用无兜底的取词函数（值会被永久冻成键名）', () => {
  const offenders = [];
  for (const file of allModuleFiles()) {
    const hits = topLevelDataWithBareGetterCall(fs.readFileSync(file, 'utf8'));
    hits.forEach((hit) => offenders.push(path.relative(ROOT, file) + ' -> ' + hit));
  }
  assert.deepStrictEqual(
    offenders,
    [],
    '这些顶层初值在词典就绪前求值，缺键会返回键名本身：\n  ' + offenders.join('\n  ')
      + '\n改法：给取词调用补一个与词典逐字一致的兜底，或把该数据改成函数、在消费时再取词。',
  );
});

test('扫描器本身能被触发（否则这条守卫是恒绿的）', () => {
  // 变异：把修好的两处形态重新写回，扫描器必须报出来。
  const frozenConstant = "var PACKAGED_DEFAULT_USER_FX_ARCHIVE_NAME = packagedFxArchiveText('preset_default_test');\n";
  const frozenStore = "var loginStatus = { vipLabel: coreStoresText('vip_none') };\n";
  assert.strictEqual(topLevelDataWithBareGetterCall(frozenConstant).length, 1, '常量形态必须被抓到');
  assert.strictEqual(topLevelDataWithBareGetterCall(frozenStore).length, 1, '对象初值形态必须被抓到');
  // 带兜底、以及 RHS 本身是函数的两种形态都不该报。
  assert.deepStrictEqual(topLevelDataWithBareGetterCall("var a = someText('k', '兜底');\n"), []);
  assert.deepStrictEqual(topLevelDataWithBareGetterCall("var f = function () { return someText('k'); };\n"), []);
});

// —— 成因 2：只写一次的控件不在重贴路径上 ——

test('滑条复位按钮与滑条标签一起重贴（107 个按钮的 title/aria-label 曾全是键名）', () => {
  const code = stripComments(readModule('07-fx/05-fx-panel-performance.js'));
  assert.ok(/function relabelFxSliderResetButtons\(\)/.test(code), '缺少复位按钮的重贴入口');
  assert.ok(/querySelectorAll\('\.fx-reset-one'\)\.forEach\(applyFxSliderResetLabel\)/.test(code), '重贴没有遍历复位按钮');
  assert.ok(/applyFxSliderResetLabel\(btn\)/.test(code), '创建路径没有套用文案');
  // 重贴必须在 relabelFxPanelControls() 里被调用，否则它永远不会跑。
  const relabel = /function relabelFxPanelControls\(\)\s*\{([\s\S]*?)\n\}/.exec(code);
  assert.ok(relabel, '没能解析出 relabelFxPanelControls');
  assert.ok(/relabelFxSliderResetButtons\(\);/.test(relabel[1]), 'relabelFxPanelControls 没有重贴复位按钮');
  // 自定义背景控制区（封面裁切按钮提示 / 封面·渐变模式文字）同样只写一次。
  assert.ok(/updateCustomBackgroundControls\(\);/.test(relabel[1]), 'relabelFxPanelControls 没有重贴自定义背景控制区');
});

test('补丁台状态、音质选项、歌词来源按钮、空态发现列表都订阅了语言就绪', () => {
  const patchBay = stripComments(readModule('05-playback/00-api-quality-output.js'));
  // 这一块的键名暴露是**间歇性**的：启动渲染与词典 fetch 赛跑，跑输时就冻住键名。
  // 用"延迟词典请求"的探针才稳定复现（普通探针多次运行只偶尔命中），所以两个重绘都要在。
  const patchCallback = /onLanguageChange\(function \(\) \{([\s\S]{0,200}?)\}\)/.exec(patchBay);
  assert.ok(patchCallback, '补丁台没有订阅语言就绪');
  assert.ok(/renderAudioOutputDeviceUi\(\);/.test(patchCallback[1]), '补丁台状态文案没有重绘');
  assert.ok(/updatePlaybackQualityUi\(\);/.test(patchCallback[1]), '音质选项没有重绘（竞态下会整片露出键名）');

  const lyricActions = stripComments(readModule('05-playback/06-track-detail-lyrics-actions.js'));
  assert.ok(/onLanguageChange\(function \(\) \{ updateCustomLyricControls\(\); \}\)/.test(lyricActions), '歌词来源按钮没有重贴');

  const dashboard = stripComments(readModule('05-playback/03a-home-dashboard.js'));
  assert.ok(/function relabelHomeDashboardDiscovery\(\)/.test(dashboard), '缺少空态发现列表的重贴入口');
  // 空订阅形态：注册了、回调里也调了，却没清幂等指纹 —— 那样这次调用等于空操作。
  const relabel = /function relabelHomeDashboardDiscovery\(\)\s*\{([\s\S]*?)\n\}/.exec(dashboard);
  assert.ok(relabel, '没能解析出 relabelHomeDashboardDiscovery');
  assert.ok(/homeDashboardDiscoveryFingerprint = '';/.test(relabel[1]), '重贴前没有清掉幂等指纹，等于空操作');
  assert.ok(/relabelHomeDashboardDiscovery\(\);/.test(dashboard), '语言就绪回调没有调用它');
});

test('新增的语言订阅都带沙箱防护（模块会被单测丢进裸沙箱求值）', () => {
  const files = [
    '05-playback/00-api-quality-output.js',
    '05-playback/06-track-detail-lyrics-actions.js',
    '05-playback/03a-home-dashboard.js',
    '07-fx/00-preset-archive-data.js',
  ];
  for (const rel of files) {
    const code = stripComments(readModule(rel));
    const site = /if \(typeof window !== 'undefined' && window\.MineradioI18n[\s\S]{0,160}?onLanguageChange/.exec(code);
    assert.ok(site, rel + ' 的订阅没有 typeof window 防护');
  }
});

// —— 成因 1 的第二个形态：取词调用被包在顶层**函数**里是允许的，但常量不行 ——

test('打包默认存档名是函数而不是顶层常量，且已有用户被写坏的键名会被修一次', () => {
  const packaged = stripComments(readModule('00-state/05-packaged-fx-archive.js'));
  assert.ok(/function packagedDefaultUserFxArchiveName\(\)/.test(packaged), '应改成函数，解析期求值会把键名冻住');
  assert.ok(
    !/var PACKAGED_DEFAULT_USER_FX_ARCHIVE_NAME\s*=/.test(packaged),
    '顶层常量形态会把 preset_default_test 写进存档名并持久化到 localStorage',
  );

  const archives = stripComments(readModule('07-fx/00-preset-archive-data.js'));
  assert.ok(/packagedDefaultUserFxArchiveName\(\)/.test(archives), '存档槽位没有改用函数取值');
  const repair = /function repairPackagedDefaultArchiveNameOnce\(\)\s*\{([\s\S]*?)\n\}/.exec(archives);
  assert.ok(repair, '缺少已持久化键名的修复入口');
  // 名字是用户数据：只在能确证是打包槽位时修，且必须写回存储并重绘。
  assert.ok(/packagedDefaultArchiveNameRepaired = true;/.test(repair[1]), '没有一次性闸门，切语言会反复重译');
  assert.ok(/saveUserFxArchives\(\);/.test(repair[1]), '修好之后没有写回存储');
  assert.ok(/renderUserFxArchives\(\);/.test(repair[1]), '修好之后没有重绘存档列表');
  assert.ok(/onLanguageChange\(repairPackagedDefaultArchiveNameOnce\)/.test(archives), '修复没有被语言就绪驱动');
});

test('这 7 个曾暴露的键在四份词典里都还在', () => {
  const keys = [
    'fx_restore_slider_default',
    'accent_pick_media_first',
    'accent_cover_gradient',
    'track_use_netease_or_local_lyrics',
    'track_add_custom_lyrics',
    'out_current_default',
    'preset_default_test',
    'dash_waiting_music_html',
  ];
  const missing = [];
  for (const { lang, dict } of dicts) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(dict, key) || !String(dict[key]).trim()) {
        missing.push(lang + ' 缺少非空键 ' + key);
      }
    }
  }
  assert.deepStrictEqual(missing, [], missing.join(' | '));
});

// —— 存档面板：整块界面文案必须走词典，且键必须在四语词典里 ——
// 原先这一整块面板（工具栏、分享框、卡片按钮、全部 toast）都是硬编码中文，非中文界面下完全不变。

const ARCHIVE_MODULE = '07-fx/00-preset-archive-data.js';

// 接线时替换掉的裸文案。它们必须已经从该模块里消失。
// 判据钉在具体字面量上，是为了让"某处又写回硬编码"立刻可见。
const RETIRED_ARCHIVE_LITERALS = [
  '用户存档保存失败，本地存储空间可能不足',
  '空白存档不能复制短码',
  '剪贴板里没有可粘贴的存档码',
  '主入口使用 MR2 短代码复制/粘贴',
  '把 MR2 短代码粘到这里，也兼容旧 JSON 存档',
  '空白存档，点击保存写入当前视觉',
  '可继续创建，不限制 4 个',
  'Mineradio 用户存档',
  '用户存档.json',
  '复制这段 MR2 短代码',
  '请导入 JSON 用户存档',
];

const WIRED_ARCHIVE_KEYS = [
  'archive_save_failed_quota', 'archive_time_empty_slot', 'archive_time_just_now', 'archive_time_minutes_ago',
  'archive_default_name', 'archive_share_code_default_name', 'archive_toast_imported', 'archive_toast_code_imported',
  'archive_err_empty_copy', 'archive_toast_full_code_copied', 'archive_toast_code_copied', 'archive_prompt_copy_code',
  'archive_toast_full_code_opened', 'archive_err_copy_failed', 'archive_err_code_generate', 'archive_err_code_checksum',
  'archive_err_code_invalid', 'archive_err_clipboard_empty', 'archive_toast_code_pasted', 'archive_toast_text_pasted',
  'archive_err_paste_first', 'archive_import_name_shortcode', 'archive_note', 'archive_btn_new',
  'archive_btn_paste_code', 'archive_btn_import_json', 'archive_share_placeholder', 'archive_btn_paste_clipboard',
  'archive_btn_import_code', 'archive_btn_copy_code', 'archive_btn_rename', 'archive_btn_file',
  'archive_slot_empty_hint', 'archive_new_blank', 'archive_new_blank_hint', 'archive_toast_created',
  'archive_toast_saved_to', 'archive_err_empty_apply', 'archive_toast_applied', 'archive_toast_renamed_to',
  'archive_toast_deleted', 'archive_export_title', 'archive_err_empty_export', 'archive_toast_exported',
  'archive_err_export_failed', 'archive_err_import_invalid_file', 'archive_export_filename', 'archive_err_pick_json',
];

// 跨域复用的通用按钮键（词典里已有同名文案，不另造孪生键）。
const REUSED_ARCHIVE_KEYS = ['btn_ok', 'btn_cancel', 'btn_save', 'fx_apply', 'btn_clear_queue', 'custom_source_action_remove', 'we_import_failed'];

test('存档面板每个键都真的接了取值调用，且键在四份词典里存在且非空', () => {
  const code = stripComments(readModule(ARCHIVE_MODULE));
  // 键有两种合法载体：直接作为取词实参（packagedFxArchiveText('k' …)），
  // 或作为 label 传给内部会取词的助手（addImportedUserFxArchiveSlot(slot, 'k')）。
  // 所以判据是"键以字符串字面量出现在该模块里 + 该模块确实用了这个取词函数"。
  // 局限：它抓不到"字面量还在但取词调用被删"这种形态——那需要按调用点逐个点名，代价更大；
  // 这里选择保住"键被删"与"整块接线被删"两类更常见的回归。
  // Two legitimate carriers: the key as the accessor's argument, or handed to a helper that
  // resolves it. So require the literal plus the accessor being used in this module.
  assert.ok(code.includes('packagedFxArchiveText('), '该模块没有使用取词函数');
  const unwired = WIRED_ARCHIVE_KEYS.filter((key) => code.indexOf("'" + key + "'") < 0);
  assert.deepStrictEqual(unwired, [], '这些键没有接线: ' + unwired.join(', '));
  const missing = [];
  for (const { lang, dict } of dicts) {
    for (const key of WIRED_ARCHIVE_KEYS.concat(REUSED_ARCHIVE_KEYS)) {
      if (!Object.prototype.hasOwnProperty.call(dict, key) || !String(dict[key]).trim()) {
        missing.push(lang + ' 缺少非空键 ' + key);
      }
    }
  }
  assert.deepStrictEqual(missing, [], missing.join(' | '));
});

test('接线时替换掉的裸中文已从存档模块消失', () => {
  const code = stripComments(readModule(ARCHIVE_MODULE));
  const leftovers = RETIRED_ARCHIVE_LITERALS.filter((text) => code.indexOf(text) >= 0);
  assert.deepStrictEqual(leftovers, [], '这些裸文案还在（同一份文案有两处站点时最容易漏）: ' + leftovers.join(' | '));
});

// —— 歌词配色名：整簇走词典，且顶层常量必须已改成函数 ——

const SWATCH_KEYS = [
  'lyric_swatch_mist_blue', 'lyric_swatch_silver_blue', 'lyric_swatch_glacier', 'lyric_swatch_teal_green',
  'lyric_swatch_pine', 'lyric_swatch_moon_white', 'lyric_swatch_rock_gold', 'lyric_swatch_amber',
  'lyric_swatch_dusk_pink', 'lyric_swatch_rose', 'lyric_swatch_smoke_purple', 'lyric_swatch_electric_purple',
  'lyric_swatch_indigo', 'lyric_swatch_ocean_blue', 'lyric_swatch_neon_cyan', 'lyric_swatch_night_green',
  'lyric_swatch_wine_red', 'lyric_swatch_ink_black',
];

test('歌词配色名走词典，且 lyricColorPresets 是函数而不是顶层常量', () => {
  const code = stripComments(readModule(ARCHIVE_MODULE));
  // 顶层常量会把词典未就绪时取到的键名冻住；含取词调用的顶层数据一律用函数。
  assert.ok(/function lyricColorPresets\(\)\s*\{/.test(code), 'lyricColorPresets 必须是函数');
  assert.ok(!/^var lyricColorPresets\s*=/m.test(code), '不得再是顶层常量');
  const unwired = SWATCH_KEYS.filter((key) => code.indexOf("'" + key + "'") < 0);
  assert.deepStrictEqual(unwired, [], '这些配色键没有接线: ' + unwired.join(', '));
  // 两个消费方必须改成调用（漏一处会拿到 undefined -> 静默不渲染色板）。
  const consumers = ['07-fx/01-lyric-color-controls.js', '07-fx/03-cover-picker-fonts.js'];
  for (const rel of consumers) {
    const text = stripComments(readModule(rel));
    assert.ok(text.indexOf('lyricColorPresets()') >= 0, rel + ' 没有改成调用 lyricColorPresets()');
    assert.ok(text.indexOf('lyricColorPresets.') < 0 && text.indexOf('lyricColorPresets[') < 0,
      rel + ' 仍在把 lyricColorPresets 当数组直接用');
  }
  const missing = [];
  for (const { lang, dict } of dicts) {
    for (const key of SWATCH_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(dict, key) || !String(dict[key]).trim()) {
        missing.push(lang + ' 缺少非空键 ' + key);
      }
    }
  }
  assert.deepStrictEqual(missing, [], missing.join(' | '));
});

test('词典值不得是裸十六进制色值（表列错位就是这么暴露的）', () => {
  // 这条守卫的来由：配色表里 hex 与中文名两列相邻，追加词典时索引错位，
  // 把 #a9b8c8 写进了 zh_cn 的值里 —— 而"键存在且非空"的判据完全看不出来。
  //
  // This caught a real slip: appending the swatch table with a wrong column index wrote the hex
  // into the zh_cn value, and the "key exists and is non-empty" check could not see it.
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const offenders = [];
  for (const { lang, dict } of dicts) {
    for (const [key, value] of Object.entries(dict)) {
      if (HEX.test(String(value).trim())) offenders.push(lang + ' ' + key + ' = ' + value);
    }
  }
  assert.deepStrictEqual(offenders, [], '词典值里出现了裸色值: ' + offenders.join(' | '));
});

// —— 账号胶囊：它在登录弹窗之外，弹窗那侧的可见性闸门管不到它 ——
// 症状很具体：标记走 JS 写入、其余文字与语言无关，所以只有"普通"看上去滞后。

test('账号胶囊的会员标记订阅了语言就绪（可见性闸门覆盖不到它在弹窗之外）', () => {
  const code = stripComments(readModule('08-account/02-login-status.js'));
  assert.ok(
    /if \(typeof window !== 'undefined' && window\.MineradioI18n[\s\S]{0,160}?onLanguageChange/.test(code),
    '订阅缺少沙箱防护（模块会被丢进裸沙箱求值）'
  );
  const sub = /onLanguageChange\(function \(\) \{([\s\S]{0,160}?)\}\)/.exec(code);
  assert.ok(sub, '账号胶囊没有订阅语言就绪，切语言后标记会停在上一个语言');
  assert.ok(/renderUserBtn\(\);/.test(sub[1]), '语言就绪回调没有重绘账号胶囊');

  // 标记文案必须来自词典，否则改词典界面不会变。
  const utils = stripComments(readModule('08-account/01-login-modal-utils.js'));
  assert.ok(/loginModalUtilsText\('login_normal'\)/.test(utils), '胶囊标记取值没有走词典');
  for (const { lang, dict } of dicts) {
    assert.ok(String(dict.login_normal || '').trim(), lang + ' 缺少非空的 login_normal');
  }
});
