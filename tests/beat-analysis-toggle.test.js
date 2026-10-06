'use strict';

// 自动节奏分析开关（默认关闭）的行为判据。
// 这里只断言**能跑出结果**的部分：默认值的实际取值、判据函数的行为、存档下标、四语文案。
// 纯源码文本类判据（归一化写法、门控覆盖、面板接线）在 scripts/quick-check.js 的
// checkBeatAnalysisToggleGuard() 里，不在这里重复一份 —— 同一个不变量抄两遍，
// 改的时候就会漏掉一处。
// Behavioural checks for the default-off automatic beat analysis switch: the actual default value,
// the predicate's behaviour, the archive index and the locale copy. Source-text invariants live in
// quick-check's checkBeatAnalysisToggleGuard() and are deliberately not duplicated here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LANGS = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// 整个 fxDefaults 字面量在沙箱里求值：只读源码里"写了什么"，不依赖任何运行时依赖。
// Evaluate the fxDefaults literal in a sandbox: this reads what the source literally says.
function fxDefaultsObject() {
  const text = read('public/js/modules/00-state/04-fx-defaults.js');
  const marker = 'var fxDefaults = ';
  const start = text.indexOf(marker);
  const end = text.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, 'fxDefaults 字面量必须能在源码里定位');
  return vm.runInNewContext('(' + text.slice(start + marker.length, end + 2) + ')', Object.create(null));
}

// 把 beatAnalysisEnabled() 整段抽出来，配一个受控的 fx 真跑一次。
// Extract beatAnalysisEnabled() and run it against a controlled fx.
function beatAnalysisEnabledWith(fxLiteral) {
  const text = read('public/js/modules/00-state/06-fx-runtime-layout.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const start = text.indexOf('function beatAnalysisEnabled()');
  assert.ok(start >= 0, 'beatAnalysisEnabled() 必须存在');
  const rest = text.slice(start);
  const next = rest.search(/\n(?:async\s+)?function\s/);
  const body = next < 0 ? rest : rest.slice(0, next);
  return vm.runInNewContext(
    '(function () { var fx = ' + fxLiteral + ';\n' + body + '\nreturn beatAnalysisEnabled(); })()',
    Object.create(null)
  );
}

test('自动节奏分析的默认值是关闭', () => {
  const defaults = fxDefaultsObject();
  assert.strictEqual(defaults.beatAnalysis, false,
    'beatAnalysis 必须默认 false：这个功能的硬要求是随应用一起关着出厂');
});

test('判据只认显式 true，缺键一律落回关闭', () => {
  // 缺键是最要紧的一路：旧存档、别人的分享码、老版本写下的设置里都没有这个键。
  // A missing key is the case that matters: older archives, share codes and settings written by an
  // earlier build all lack it.
  const cases = [
    ['fx 未定义', 'undefined', false],
    ['缺键', '{}', false],
    ['显式 false', '{ beatAnalysis: false }', false],
    ['null', '{ beatAnalysis: null }', false],
    ['字符串 "true"', '{ beatAnalysis: "true" }', false],
    ['数字 1', '{ beatAnalysis: 1 }', false],
    ['显式 true', '{ beatAnalysis: true }', true]
  ];
  for (const [label, literal, expected] of cases) {
    assert.strictEqual(beatAnalysisEnabledWith(literal), expected,
      `${label} 时判据必须是 ${expected}；` +
      '写成 `!== false` 会让缺键被读成开启，「默认关闭」就名存实亡');
  }
});

test('存档键表保持 append-only，新键只能追加在末尾', () => {
  // 分享码是**按下标**编码的（USER_FX_SHARE_KEYS 里那段 Append-only 注释就是为它写的），
  // 插在中间会静默解错所有已经发出去的码。这里把追加前最后一个老键的下标钉死：
  // 往后追加不影响它，而任何中间插入都会让它移位。
  // Share codes are index-encoded, so a middle insertion silently mis-decodes every issued code.
  // Pinning the last pre-append key's index catches exactly that while allowing appends.
  const text = read('public/js/modules/07-fx/00-preset-archive-data.js');
  const start = text.indexOf('var USER_FX_SHARE_KEYS = [');
  const end = text.indexOf('];', start);
  assert.ok(start >= 0 && end > start, 'USER_FX_SHARE_KEYS 必须能在源码里定位');
  const keys = [...text.slice(start, end).matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  assert.strictEqual(keys.indexOf('lyricTextureClarity'), 205,
    'lyricTextureClarity 的下标变了 —— 有人往 USER_FX_SHARE_KEYS 中间插了键，分享码会解错');
  assert.strictEqual(keys[keys.length - 1], 'beatAnalysis',
    'beatAnalysis 必须是最后一项，这样下一次追加才会排在它后面');
  assert.strictEqual(new Set(keys).size, keys.length, 'USER_FX_SHARE_KEYS 里不能有重复键');
});

test('四份词典都有这个开关的文案', () => {
  // 缺一份，那个语言的开关就会显示裸键（data-i18n 的常规报错形态）。
  const keys = ['toggle_beat_analysis', 'fx_beat_analysis_title', 'bind_beat_analysis_on', 'bind_beat_analysis_off'];
  for (const lang of LANGS) {
    const raw = read('public/locales/' + lang + '.json');
    const dict = JSON.parse(raw);
    for (const key of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(dict, key), `${lang} 缺少 ${key}`);
      assert.ok(String(dict[key]).trim().length > 0, `${lang} 的 ${key} 不能是空文案`);
    }
  }
});
