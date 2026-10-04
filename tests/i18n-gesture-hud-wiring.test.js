'use strict';

// 手势 HUD 是纯 JS 渲染的瞬态文案，DOM 上的 data-i18n 够不到它 —— 只能靠模块自己走词典。
// 这条守卫钉住「HUD 文案一律经 gestureText(key, 兜底) 取值」，防止有人图省事又写回裸中文。
// The gesture HUD is transient copy rendered from JS, so DOM-level data-i18n never reaches
// it: the module has to route through the dictionary itself. This guard pins that wiring so
// a hardcoded Chinese literal cannot quietly come back.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { accessorInSandbox } = require('./helpers/module-source');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'public', 'js', 'modules', '10-shell', '00-gesture-control.js');

// 结构断言必须看「真代码」，注释里提到键名不算接线。
// Structural assertions read real code; a key named in a comment does not count.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 已经接线的键：必须都能在模块里找到取值调用。
const WIRED_KEYS = [
  'gesture_loading',
  'gesture_standby',
  'gesture_put_hand',
  'gesture_confirm',
  'gesture_pinch_drag',
  'gesture_pinch_drag_hint',
  'gesture_dragging',
  'gesture_drag_hint',
  'gesture_release',
  'gesture_release_hint',
  'gesture_fist',
  'gesture_fist_hint',
  'gesture_open',
  'gesture_hover',
  'gesture_hint_all',
];

// 接线前写在 HUD / toast 实参位置上的裸中文。它们只允许作为 gestureText 的兜底实参出现。
const NO_LONGER_BARE = [
  '正在加载手势识别…',
  '把手放进视野',
  '捏合拖动',
  '移动手掌 -> 旋转封面',
  '拖动中',
  '松手后保留惯性',
  '松开',
  '可继续触碰或捏合',
  '握拳收束',
  '粒子向中心收缩',
  '张开恢复',
  '悬停',
  '手掌推开粒子 / 捏合旋转 / 握拳收束',
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('手势 HUD 的每条文案都经 gestureText 取值', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  const missing = WIRED_KEYS.filter((key) => code.indexOf("gestureText('" + key + "'") < 0);
  assert.deepStrictEqual(missing, [], '这些键没有走词典: ' + missing.join(', '));
});

test('手势 HUD 不再把裸中文直接喂给 HUD / toast', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  const offenders = NO_LONGER_BARE.filter((literal) =>
    new RegExp('(showGestureHUD|showToast)\\(\\s*[\'"]' + escapeRegExp(literal) + '[\'"]').test(code));
  assert.deepStrictEqual(offenders, [], '这些文案又写回裸中文了: ' + offenders.join(', '));
});

test('gestureText 缺键时露出键名而不是空串（漏译要吵，不要静默）', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  // 行为断言比正则强：真在裸沙箱里跑一遍，直接看缺键时返回了什么。
  // Behavior beats shape — run it for real and read what a missing key returns.
  const missing = accessorInSandbox(source, 'gestureText', { t: (key) => key });
  // 缺键且无兜底 -> 返回键名。空串会让漏译静默发生（界面像坏了），键名是一眼能认出的错误。
  assert.strictEqual(missing('gesture_missing_key'), 'gesture_missing_key', '缺键且无兜底时应返回键名');
  assert.strictEqual(missing('gesture_missing_key', '待命'), '待命', '有兜底时仍应退回兜底');
  const present = accessorInSandbox(source, 'gestureText', { t: () => '词典文案' });
  assert.strictEqual(present('gesture_standby', '待命'), '词典文案');
  const bare = accessorInSandbox(source, 'gestureText', null);
  assert.strictEqual(bare('gesture_standby'), 'gesture_standby', '没有 i18n 运行时也要露出键名');
  assert.strictEqual(bare('gesture_standby', '待命'), '待命', '没有 i18n 运行时且有兜底才退回兜底');
});
