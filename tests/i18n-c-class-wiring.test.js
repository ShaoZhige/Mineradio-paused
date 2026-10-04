'use strict';

// C 类接线的不变量 / Invariants for the C-class wiring
//
// C 类的病灶是「插件化重写模块时把词典取词丢掉了」：显示点退回裸中文，词典条目
// 从此再也取不到。所以守卫必须同时盯住两侧 —— 光看键名会被「键还在词典里」骗过，
// 光看中文会被「文案碰巧相同」骗过。
//
// The defect class here is a dropped lookup, not a missing key: the display site
// reverted to bare Chinese and the dictionary entry became unreachable. The guard
// therefore has to bind both ends. Key names alone are satisfied by the entry merely
// existing; Chinese alone is satisfied by any coincidental match.
//
//   1) 每个接线的兜底文案必须与词典同键的值逐字相同。键写错、兜底漂移、两边对调
//      都会破坏这条，而这三种错误都不会抛异常 —— 界面只是安静地显示错的字。
//      Every wired fallback must equal the dictionary value for that key, character
//      for character. A wrong key, a drifted fallback, or a swapped pair all break
//      this without throwing; the UI just shows the wrong words quietly.
//   2) 取词函数必须把 params 透传给 t()，并且也插值进兜底模板。缺了后半段，
//      词典加载失败时 {provider} 会原样显示给用户。
//      The helper must forward params to t() and also interpolate the fallback:
//      without the second half a failed dictionary load prints {provider} verbatim.
//   3) 词典键序在四份语言文件里必须一致，重复键会让后一份覆盖前一份。
//      Key order must match across all four dictionaries; a duplicate key would
//      silently shadow the earlier entry.
//   4) 接线完成后，被替换掉的裸中文不得再出现在该文件里。
//      Once wired, the replaced bare literal must be gone from that file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'public', 'locales');
const I18N_MODULE = path.join(ROOT, 'public', 'js', 'modules', '00-state', '13-i18n.js');
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');

// 语言列表从 i18n 模块推导而不是写死：写死的列表会让新接入的语言悄悄绕过校验。
// Derive the language list from the i18n module so a newly wired language cannot slip past.
function wiredLangs() {
  const source = fs.readFileSync(I18N_MODULE, 'utf8');
  const match = /var SUPPORTED_LANGS = \[([^\]]*)\]/.exec(source);
  assert.ok(match, 'i18n 模块里找不到 SUPPORTED_LANGS');
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function readDict(lang) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang + '.json'), 'utf8'));
}

// ── 接线站点表 ──────────────────────────────────────────────────────────────
// 兜底文案一律从词典取，不在这里重抄 —— 重抄的那份会和真实词典脱钩，
// 守卫就变成自己检查自己。
// Fallbacks are read from the dictionary rather than restated here: a copy would
// drift from the real dictionary and the guard would only be checking itself.
const SITES = [
  ['public/js/modules/05-playback/11-provider-fallback.js', 'playbackI18nText', 'provider_need_login'],
  ['public/js/modules/05-playback/11-provider-fallback.js', 'playbackI18nText', 'opening_login'],
  ['public/js/modules/08-account/02-login-status.js', 'loginStatusText', 'saved_qq_session'],
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', 'playlistPanelText', 'queue_empty'],
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', 'playlistPanelText', 'next_play'],
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', 'playlistPanelText', 'remove'],
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', 'playlistPanelText', 'login_show_podcasts'],
  ['public/js/modules/05-playback/07-search.js', 'searchPanelText', 'search_history'],
  ['public/js/modules/05-playback/07-search.js', 'searchPanelText', 'next_play'],
  ['public/js/modules/05-playback/06-track-detail-lyrics-actions.js', 'trackActionText', 'next_play'],
  ['public/js/modules/05-playback/06-track-detail-lyrics-actions.js', 'trackActionText', 'local_collect_unsupported'],
  ['public/js/modules/05-playback/06-track-detail-lyrics-actions.js', 'trackActionText', 'local_like_unsupported'],
  ['public/js/modules/08-account/04-user-modal-logout.js', 'accountPanelText', 'account_switch_dual'],
  ['public/js/modules/08-account/04-user-modal-logout.js', 'accountPanelText', 'account_switch_hint'],
  ['public/js/modules/05-playback/03-home-discover-weather.js', 'homeDiscoverText', 'home_frequent_artists'],
  ['public/js/modules/05-playback/03-home-discover-weather.js', 'homeDiscoverText', 'home_artist_plays'],
  ['public/js/modules/05-playback/03-home-discover-weather.js', 'homeDiscoverText', 'track_count'],
  ['public/js/modules/05-playback/03-home-discover-weather.js', 'homeDiscoverText', 'home_private_radio'],
  ['public/js/modules/05-playback/04-home-empty-wallpaper.js', 'homeWallpaperText', 'home_private_radio'],
];

// 本批新增的取词函数。它们必须是同一个形态，否则站点表里的调用会静默退化成裸字面量。
// The helpers added by this batch must share one shape, or the calls in the site table
// degenerate into bare literals.
const HELPERS = [
  ['public/js/modules/08-account/02-login-status.js', 'loginStatusText'],
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', 'playlistPanelText'],
  ['public/js/modules/05-playback/07-search.js', 'searchPanelText'],
  ['public/js/modules/05-playback/06-track-detail-lyrics-actions.js', 'trackActionText'],
  ['public/js/modules/08-account/04-user-modal-logout.js', 'accountPanelText'],
  ['public/js/modules/05-playback/03-home-discover-weather.js', 'homeDiscoverText'],
  ['public/js/modules/05-playback/04-home-empty-wallpaper.js', 'homeWallpaperText'],
  ['public/js/modules/05-playback/11-provider-fallback.js', 'playbackI18nText'],
];

// 接线时替换掉的裸中文。它们必须已经从对应文件里消失。
// Bare copy that was replaced; it must be gone from those files.
const RETIRED = [
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', '队列为空，先搜索或打开歌单</div>'],
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', 'title="下一首播放"'],
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', 'title="移除"'],
  ['public/js/modules/06-lyrics/01-playlist-panel-shell.js', '>登录后显示我的播客</div>'],
  ['public/js/modules/05-playback/07-search.js', '<span>搜索历史</span>'],
  ['public/js/modules/05-playback/07-search.js', 'title="下一首播放"'],
  ['public/js/modules/05-playback/06-track-detail-lyrics-actions.js', 'title="下一首播放"'],
  ['public/js/modules/05-playback/06-track-detail-lyrics-actions.js', "'本地文件暂不支持同步'"],
  ['public/js/modules/05-playback/11-provider-fallback.js', "provider + '需要登录后再尝试播放'"],
  ['public/js/modules/05-playback/11-provider-fallback.js', "message + ' · 正在打开登录'"],
  ['public/js/modules/08-account/02-login-status.js', "return '已保存 QQ 音乐会话 · '"],
  ['public/js/modules/08-account/04-user-modal-logout.js', '右上角已切换为多平台并排展示。'],
  ['public/js/modules/05-playback/03-home-discover-weather.js', "'私人雷达'"],
  ['public/js/modules/05-playback/04-home-empty-wallpaper.js', "'私人雷达'"],
];

// 从源码里切出一个具名函数并求值。用花括号配对而不是「找到下一个顶格 }」，
// 后者在函数被重新排版后就会切错位置，让守卫悄悄失去意义。
// Extract a named function by brace matching instead of "the next column-0 brace":
// the latter mis-slices as soon as the function is reformatted, quietly neutering the guard.
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '源码里找不到函数 ' + name);
  let depth = 0;
  let i = source.indexOf('{', start);
  assert.ok(i >= 0, name + ' 没有函数体');
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? source.length : close + 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 的函数体没有闭合');
}

// 在沙箱里求值取词函数。window 必须存在，函数体第一句就读 window.MineradioI18n。
function loadHelper(file, name, t) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const sandbox = { console: console, window: {} };
  if (t) sandbox.window.MineradioI18n = { t: t };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(source, name), sandbox, { filename: file });
  return sandbox[name];
}

const LANGS = wiredLangs();
const DICTS = {};
for (const lang of LANGS) DICTS[lang] = readDict(lang);

test('每个接线站点的兜底文案与词典同键的值逐字相同', () => {
  for (const [file, helper, key] of SITES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const expected = DICTS['zh_cn'][key];
    assert.ok(expected, key + ' 不在 zh-CN 词典里');
    const call = helper + "('" + key + "', '" + expected + "'";
    assert.ok(source.includes(call),
      file + ' 未按词典文案接线 ' + key + '\n  期望出现: ' + call);
  }
});

test('接线站点引用的每个键在四份词典里都存在', () => {
  for (const [, , key] of SITES) {
    for (const lang of LANGS) {
      assert.ok(Object.prototype.hasOwnProperty.call(DICTS[lang], key),
        key + ' 在 ' + lang + ' 词典里缺失');
    }
  }
});

test('取词函数把词典值原样返回', () => {
  for (const [file, name] of HELPERS) {
    const fn = loadHelper(file, name, (key) => DICTS['zh_cn'][key]);
    assert.strictEqual(fn('queue_empty', '不该用到兜底'), DICTS['zh_cn']['queue_empty'],
      name + ' 没有取用词典值');
  }
});

test('词典缺键时退回兜底而不是显示键名', () => {
  for (const [file, name] of HELPERS) {
    const fn = loadHelper(file, name, (key) => key);
    assert.strictEqual(fn('no_such_key_here', '兜底文案'), '兜底文案',
      name + ' 在缺键时没有退回兜底');
  }
});

test('没有 i18n 运行时：有兜底退回兜底，无兜底露出键名，且都不抛异常', () => {
  for (const [file, name] of HELPERS) {
    const fn = loadHelper(file, name, null);
    assert.strictEqual(fn('queue_empty', '兜底文案'), '兜底文案',
      name + ' 在没有 i18n 时没有退回兜底');
    // 无兜底时返回键名而不是空串：漏译要吵，不要静默。空串会让界面像坏了。
    assert.strictEqual(fn('queue_empty'), 'queue_empty',
      name + ' 在没有 i18n 且无兜底时应露出键名');
  }
});

test('params 同时透传给 t() 并插值进兜底模板', () => {
  const seen = [];
  for (const [file, name] of HELPERS) {
    // 词典命中时，插值由 t() 负责，helper 只负责把 params 传下去。
    const withDict = loadHelper(file, name, (key, params) => {
      seen.push(params);
      return 'provider=' + (params && params.provider);
    });
    assert.strictEqual(withDict('provider_need_login', '兜底', { provider: 'QQ 音乐' }), 'provider=QQ 音乐',
      name + ' 没有把 params 透传给 t()');
    // 词典缺键时，{provider} 必须由 helper 自己插值，否则用户看到的是花括号占位符。
    const fallbackOnly = loadHelper(file, name, null);
    assert.strictEqual(fallbackOnly('k', '{provider}需要登录后再尝试播放', { provider: 'QQ 音乐' }),
      'QQ 音乐需要登录后再尝试播放', name + ' 没有把 params 插值进兜底模板');
    // 兜底模板本身带占位符时也照样插值。
    assert.strictEqual(fallbackOnly('k', '已切换到 {provider}', { provider: 'QQ 音乐' }),
      '已切换到 QQ 音乐', name + ' 带插值的兜底模板没有生效');
  }
  assert.ok(seen.every((params) => params && params.provider === 'QQ 音乐'),
    'params 没有原样传到 t()');
});

test('词典之间键序完全一致且没有重复键', () => {
  const orders = {};
  for (const lang of LANGS) {
    const raw = fs.readFileSync(path.join(LOCALES_DIR, lang + '.json'), 'utf8');
    const keys = Object.keys(JSON.parse(raw));
    orders[lang] = keys;
    const dupes = keys.filter((key, index) => keys.indexOf(key) !== index);
    assert.deepStrictEqual(dupes, [], lang + ' 词典里有重复键: ' + dupes.join(', '));
  }
  const base = orders['zh_cn'];
  for (const lang of LANGS) {
    assert.deepStrictEqual(orders[lang], base, lang + ' 的键序与 zh-CN 不一致');
  }
});

test('home_artist_plays 用占位符而不是靠嗅探语言拼后缀', () => {
  for (const lang of LANGS) {
    const value = DICTS[lang]['home_artist_plays'];
    assert.ok(value, lang + ' 缺少 home_artist_plays');
    assert.ok(value.includes('{count}'),
      lang + ' 的 home_artist_plays 没有 {count} 占位符: ' + value);
  }
  // 站点必须通过 params 传入次数，而不是拼字符串。
  const source = fs.readFileSync(
    path.join(ROOT, 'public/js/modules/05-playback/03-home-discover-weather.js'), 'utf8');
  assert.ok(source.includes("homeDiscoverText('home_artist_plays'"),
    '首页没有通过 home_artist_plays 取「N 次」');
  assert.ok(/home_artist_plays'[^)]*\{\s*count\s*:/.test(source),
    'home_artist_plays 的站点没有传入 count');
});

test('手势 HUD 的状态前缀已接线', () => {
  // 钉的是 gesture_prefix（「手势：」带冒号），不是 gesture_status（「手势」无冒号）。
  // 后者全仓零引用，只有这个守卫自己提过它；界面上一直接的是前者。
  // This pins gesture_prefix ("Gesture:" with the colon), not gesture_status ("Gesture").
  // The latter has zero references repo-wide and was only ever named by this guard.
  const KEY = 'gesture_prefix';
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  assert.ok(html.includes('data-i18n="' + KEY + '"'), '手势 HUD 前缀没有 data-i18n');
  const match = new RegExp('<span data-i18n="' + KEY + '">([^<]*)</span>').exec(html);
  assert.ok(match, KEY + ' 所在的 span 不存在');
  // applyToElement 无 data-i18n-attr 时用 textContent 覆盖，所以包裹元素里不能有子元素 ——
  // 有子元素的话那部分会被静默删掉。
  assert.strictEqual(match[1], DICTS['zh_cn'][KEY],
    KEY + ' 元素的默认文本与词典不一致');
});

test('被替换掉的裸中文已从对应文件消失', () => {
  for (const [file, literal] of RETIRED) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!source.includes(literal),
      file + ' 里仍残留裸文案: ' + literal);
  }
});
