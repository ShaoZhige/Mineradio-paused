'use strict';

// 引导叠层是常驻在舞台上的浮层，文案由 JS 逐帧渲染，data-i18n 扫不到它。
// 这条守卫钉住「每个引导步骤都带 key 字段，且标题/正文统一经 guideText 拼键取值」。
// The visual guide is a persistent overlay whose copy is rendered from JS, so DOM-level
// data-i18n never reaches it. This guard pins that each step carries a key and that the
// title/body are resolved through guideText.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { accessorInSandbox } = require('./helpers/module-source');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'public', 'js', 'modules', '09-idle-toast-libraries.js');

// 结构断言只认真代码：注释里出现键名不算接线。
// Structural assertions read real code; a key named in a comment does not count.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 带 key 的引导步骤：每个都要能拼出 _title / _body 两条键。
// Steps carrying a key: each must resolve to a _title / _body pair.
const STEP_KEYS = [
  'guide_step4',
  'guide_step_search',
  'guide_step_library',
  'guide_step_visual',
  'guide_step_controls',
  'guide_step_shelf',
];

// 与步骤无关、直接取值的键。
const DIRECT_KEYS = [
  'guide_hint_finish',
  'guide_hint_continue',
  'btn_finish',
  'btn_next',
];

test('每个引导步骤都声明了 key 字段', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  const missing = STEP_KEYS.filter((key) => code.indexOf("key: '" + key + "'") < 0);
  assert.deepStrictEqual(missing, [], '这些步骤没挂词典键: ' + missing.join(', '));
});

test('引导标题和正文按 key 拼 _title / _body 取值', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  const titleSite = /title\.textContent\s*=\s*guideText\(step\.key\s*\?\s*step\.key\s*\+\s*'_title'/.test(code);
  const bodySite = /body\.textContent\s*=\s*guideText\(step\.key\s*\?\s*step\.key\s*\+\s*'_body'/.test(code);
  assert.ok(titleSite, '标题没有经 guideText 拼 _title 取值');
  assert.ok(bodySite, '正文没有经 guideText 拼 _body 取值');
});

test('引导按钮和提示文案都走 guideText', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  const missing = DIRECT_KEYS.filter((key) => code.indexOf("guideText('" + key + "'") < 0);
  assert.deepStrictEqual(missing, [], '这些键没有走词典: ' + missing.join(', '));
});

test('语言切换后引导叠层会重绘', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  // 引导是常驻浮层，只靠下一次渲染事件是不够的，必须订阅语言变更。
  assert.ok(/onLanguageChange\(/.test(code), '没有订阅语言变更，切换语言后引导文案不会更新');
  const subscription = /i18n\.onLanguageChange\(function\s*\(\)\s*\{([\s\S]{0,300}?)\}\)/.exec(code);
  assert.ok(subscription, '没能解析出语言变更回调');
  assert.ok(/showVisualGuideStep\(/.test(subscription[1]), '语言变更回调没有重绘引导步骤');
});

test('guideText 缺键时露出键名而不是空串（漏译要吵，不要静默）', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  // 行为断言比正则强：真在裸沙箱里跑一遍，直接看缺键时返回了什么 ——
  // 缺键判定写漏就会把 "guide_step4_title" 这种裸键名显示给用户。
  // Behavior beats shape: run it for real and read what a missing key returns.
  const missing = accessorInSandbox(source, 'guideText', { t: (key) => key });
  // 缺键且无兜底 -> 返回键名。这是有意为之：引导步骤的键名一旦漏译，
  // 界面上会出现 "guide_step4_title"，一眼就能认出是缺键而不是功能坏了。
  assert.strictEqual(missing('guide_step4_title'), 'guide_step4_title', '缺键且无兜底时应返回键名');
  assert.strictEqual(missing('guide_step4_title', '歌词来源'), '歌词来源', '有兜底时仍应退回兜底');
  const present = accessorInSandbox(source, 'guideText', { t: () => '词典文案' });
  assert.strictEqual(present('guide_step4_title', '歌词来源'), '词典文案');
  const bare = accessorInSandbox(source, 'guideText', null);
  assert.strictEqual(bare('guide_step4_title'), 'guide_step4_title', '没有 i18n 运行时也要露出键名');
  assert.strictEqual(bare('guide_step4_title', '歌词来源'), '歌词来源', '没有 i18n 运行时且有兜底才退回兜底');
});
