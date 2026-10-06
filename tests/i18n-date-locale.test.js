'use strict';

// ============================================================
//  日期与「实时文案」的语言跟随 / Dates and live copy follow the language
//  两处真实缺陷的形状：
//    1. toLocaleDateString('zh-CN', …) 写死语言 —— 英语界面上照样蹦出「星期一」。
//       写死的区域标签不会报错、不会退到系统语言，只是永远说中文。
//    2. 「每日热评」「星期几」这类文案不在 DOM 的 data-i18n 节点上，切换语言时
//       i18n 的 DOM 扫描够不到，必须由模块自己订阅语言变更后重绘。
//       少了这个订阅，界面切到英语而这两处仍旧是中文，且只有盯到那一块才发现。
//  Two real defect shapes: a hardcoded toLocaleDateString('zh-CN', …) that never errors and
//  simply keeps speaking Chinese inside an English UI, and copy that lives outside the DOM's
//  data-i18n nodes ("daily reviews", the weekday) which the i18n DOM scan cannot reach — the
//  owning module has to subscribe to the language change and repaint itself.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'public', 'js', 'modules');
const I18N_PATH = path.join(MODULES, '00-state', '13-i18n.js');
const DASHBOARD_PATH = path.join(MODULES, '05-playback', '03a-home-dashboard.js');
const TRACK_DETAIL_PATH = path.join(MODULES, '05-playback', '06-track-detail-lyrics-actions.js');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// 注释里举例的 'zh-CN' 不算违规：只看真代码。
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('没有任何模块给日期格式化写死区域标签', () => {
  // 只禁「格式化输出」这一类调用：localeCompare 的 'zh-CN' 是排序规则，不是显示文案，
  // 换成界面语言反而会让文件名排序随语言漂移。
  // Only display formatting is banned. The 'zh-CN' in localeCompare is a collation rule rather
  // than display copy, and swapping it for the UI language would make file sorting drift.
  const offenders = [];
  const pattern = /toLocale(?:Date|Time)String\(\s*['"]([a-zA-Z-]+)['"]|toLocaleString\(\s*['"]([a-zA-Z-]+)['"]/g;
  walk(MODULES).forEach((file) => {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    let match;
    while ((match = pattern.exec(text)) !== null) {
      offenders.push(path.relative(ROOT, file) + ' -> ' + (match[1] || match[2]));
    }
  });
  assert.deepStrictEqual(offenders, [],
    'these modules hardcode a display locale instead of following MineradioI18n.htmlLang():\n' + offenders.join('\n'));
});

test('i18n 暴露 BCP47 标签，且覆盖每一个受支持语言', () => {
  const source = fs.readFileSync(I18N_PATH, 'utf8');
  assert.match(source, /function htmlLang\(\)\s*\{[\s\S]{0,200}DOC_LANG\[currentLang\]/);
  assert.match(source, /htmlLang: htmlLang/);
  // 新加一门语言却忘了补 DOC_LANG 标签，日期会静默退到英文而不报错。
  // Adding a language without its DOC_LANG tag makes dates silently fall back to English.
  // 键可能带引号也可能不带（en_us: / 'en_us':），两种写法都算数。
  // The keys may or may not be quoted (en_us: / 'en_us':); both spellings count.
  const docLangBlock = (source.match(/var DOC_LANG = \{[\s\S]*?\};/) || [''])[0];
  assert.ok(docLangBlock, 'DOC_LANG must exist');
  ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'].forEach((lang) => {
    assert.match(docLangBlock, new RegExp(`['"]?${lang}['"]?\\s*:`), `DOC_LANG must carry a tag for ${lang}`);
  });
  // 模块本身可被 require：裸沙箱里没有 document，初始化必须被拦住，否则求值即抛。
  // The module must be requireable: without a document the initialisation has to bail out or
  // evaluation throws.
  const api = require(I18N_PATH).MineradioI18n;
  assert.strictEqual(typeof api.htmlLang, 'function');
  assert.strictEqual(api.htmlLang(), 'zh-CN', 'the default language is zh_cn');
});

test('主页星期几走 htmlLang，不再写死 zh-CN', () => {
  const text = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  assert.match(text, /function homeDashboardDateLocale\(\)/);
  assert.match(text, /i18n\.htmlLang\(\)/);
  assert.match(text, /toLocaleDateString\(locale, options\)/);
  // 取不到标签时必须退回系统默认而不是某个硬编码语言。
  // A missing tag must fall back to the system default, not to some hardcoded language.
  assert.match(text, /toLocaleDateString\(undefined, options\)/);
});

test('每日热评与星期几订阅语言变更后立刻重绘', () => {
  // 这两处不是 data-i18n 节点，i18n 的 DOM 扫描够不到；只靠 15 秒的刷新定时器会让
  // 界面在语言切换后继续显示旧语言。
  // Neither is a data-i18n node, so the i18n DOM scan cannot reach them; relying on the 15s
  // refresh timer alone would leave the old language on screen after a switch.
  const text = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  const hook = (text.match(/MineradioI18n\.onLanguageChange\(function \(\)\s*\{[\s\S]*?\n\s*\}\);/) || [''])[0];
  assert.ok(hook, 'the home dashboard must subscribe to language changes');
  assert.match(hook, /homeDashboardUpdateClock\(\)/, 'the weekday/clock must be refreshed');
  assert.match(hook, /renderHomeDashboard\(\)/, 'the review card must be re-rendered');
});

test('歌单/评论区的日期同样跟随语言', () => {
  const text = fs.readFileSync(TRACK_DETAIL_PATH, 'utf8');
  assert.match(text, /function commentTimeLabel\(ms\)/);
  assert.match(text, /i18n\.htmlLang\(\)/);
});
