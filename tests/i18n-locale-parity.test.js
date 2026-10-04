'use strict';

// 界面国际化的三条不变量 / Three invariants for the UI internationalization layer:
//   1) 已接入的每一种语言必须与默认语言键集一致，否则会静默出现回退文案。
//      Every wired language must expose the same key set as the default one, or
//      missing keys silently fall back.
//   2) index.html 里标注的每个 data-i18n 键必须真实存在于默认词典，否则界面上会
//      直接显示键名。
//      Every data-i18n key marked in index.html must exist in the default
//      dictionary, otherwise the raw key is what the user sees.
//   3) 语言菜单、「已接入语言」列表、词典文件三者必须闭环，缺一处就会出现"能选
//      但没翻译"或"翻译了但选不到"。
//      The picker, the wired-language list and the dictionary files must form a
//      closed loop; a gap shows up as "selectable but untranslated" or
//      "translated but unreachable".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const localesDir = path.join(root, 'public', 'locales');
const i18nModule = path.join(root, 'public', 'js', 'modules', '00-state', '13-i18n.js');
const DEFAULT_LANG = 'zh_cn';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 语言列表从 i18n 模块推导，而不是在这里写死：写死的列表会让新接入的语言悄悄
// 绕过校验，而"绕过"的后果恰好是它本该拦住的静默回退。判据必须跟着接线走。
// The language list is derived from the i18n module instead of being hardcoded here:
// a hardcoded list lets a newly wired language slip past the check, and slipping
// past is exactly the silent fallback this test exists to catch.
function wiredLangs() {
  const source = fs.readFileSync(i18nModule, 'utf8');
  const match = /var SUPPORTED_LANGS = \[([^\]]*)\]/.exec(source);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

test('语言列表可从 i18n 模块推导', () => {
  // 提取失败会让下面两个用例退化成空循环（永远绿），所以先把提取本身钉住。
  // A failed extraction would degrade the tests below into empty loops that can never
  // fail, so the extraction itself is pinned first.
  const langs = wiredLangs();
  assert.ok(langs.length >= 2, '没能从 i18n 模块解析出 SUPPORTED_LANGS');
  assert.ok(langs.indexOf(DEFAULT_LANG) >= 0, '默认语言必须在 SUPPORTED_LANGS 里');
});

test('已接入语言的键集与默认语言一致', () => {
  const baseKeys = Object.keys(readJson(path.join(localesDir, DEFAULT_LANG + '.json'))).sort();
  assert.ok(baseKeys.length > 0, '默认词典不应为空');

  const others = wiredLangs().filter((lang) => lang !== DEFAULT_LANG);
  assert.ok(others.length > 0, '除默认语言外应至少接入一种语言');

  others.forEach((lang) => {
    const file = path.join(localesDir, lang + '.json');
    assert.ok(fs.existsSync(file), lang + ' 词典文件缺失');
    const keys = Object.keys(readJson(file)).sort();
    const missing = baseKeys.filter((k) => keys.indexOf(k) < 0);
    const extra = keys.filter((k) => baseKeys.indexOf(k) < 0);
    assert.deepStrictEqual(missing, [], lang + ' 缺少键: ' + missing.slice(0, 8).join(', '));
    assert.deepStrictEqual(extra, [], lang + ' 多出未定义键: ' + extra.slice(0, 8).join(', '));
  });
});

test('语言菜单能选到每一种已接入语言', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const offered = Array.from(new Set((html.match(/data-lang="[^"]+"/g) || [])
    .map((token) => token.slice('data-lang="'.length, -1))));

  const missing = wiredLangs().filter((lang) => offered.indexOf(lang) < 0);
  assert.deepStrictEqual(missing, [], '语言菜单缺少已接入语言: ' + missing.join(', '));
});

test('index.html 标注的 data-i18n 键都存在于默认词典', () => {
  const dict = readJson(path.join(localesDir, DEFAULT_LANG + '.json'));
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const marked = Array.from(new Set((html.match(/data-i18n="[^"]+"/g) || [])
    .map((token) => token.slice('data-i18n="'.length, -1))));

  assert.ok(marked.length > 0, 'index.html 应当已带有 data-i18n 标注');

  const missing = marked.filter((key) => !Object.prototype.hasOwnProperty.call(dict, key));
  assert.deepStrictEqual(missing, [], 'index.html 中的键未在词典定义: ' + missing.join(', '));
});
