'use strict';

// 语言文件命名守卫：文件名统一为 Minecraft 风格的 xx_xx.json（zh_cn / en_us / ja_jp /
// ru_ru），且 i18n 模块的语言码与磁盘文件名一一对应，旧式命名（zh-CN.json / en.json /
// ja.json / ru.json）不应残留。任何一处漂移都会让词典加载 404 或语言切换失效。
// Locale filename guard: filenames follow Minecraft's xx_xx.json convention (zh_cn / en_us /
// ja_jp / ru_ru); the i18n module's language codes must map 1:1 onto the on-disk files and no
// deprecated name may linger. Either drift makes dictionary loads 404 or breaks language switch.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { mainI18nBlock } = require('./helpers/module-source');

const root = path.join(__dirname, '..');
const localesDir = path.join(root, 'public', 'locales');
const i18nSrc = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '00-state', '13-i18n.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');

const EXPECTED = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];
const DEPRECATED_FILES = ['zh-CN.json', 'en.json', 'ja.json', 'ru.json'];

test('四份词典文件都按 xx_xx 命名存在', () => {
  for (const code of EXPECTED) {
    assert.ok(fs.existsSync(path.join(localesDir, code + '.json')), `缺少词典文件 ${code}.json`);
  }
});

test('不存在旧式命名（zh-CN.json / en.json / ja.json / ru.json）', () => {
  for (const name of DEPRECATED_FILES) {
    assert.ok(!fs.existsSync(path.join(localesDir, name)), `残留旧命名文件 ${name}`);
  }
});

test('i18n 模块的 SUPPORTED_LANGS 与磁盘文件名一一对应', () => {
  const m = /var SUPPORTED_LANGS = \[([^\]]*)\]/.exec(i18nSrc);
  assert.ok(m, '解析不出 SUPPORTED_LANGS');
  const langs = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.deepStrictEqual(langs.slice().sort(), EXPECTED.slice().sort(),
    'SUPPORTED_LANGS 与预期文件名不一致: ' + langs.join(', '));

  const d = /var DEFAULT_LANG = (['"][a-z_]+['"])/.exec(i18nSrc);
  assert.ok(d, '解析不出 DEFAULT_LANG');
  const def = d[1].replace(/['"]/g, '');
  assert.ok(langs.includes(def), 'DEFAULT_LANG 不在 SUPPORTED_LANGS 内: ' + def);
});

test('normalizeLang 把旧式区域码收敛到新码', () => {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  // 没有 document，底部的 DOMContentLoaded/init 不会触发；只取 normalizeLang。
  vm.runInContext(i18nSrc, sandbox);
  const fn = sandbox.window.MineradioI18n.normalizeLang;
  assert.strictEqual(fn('zh-CN'), 'zh_cn');
  assert.strictEqual(fn('en'), 'en_us');
  assert.strictEqual(fn('ja'), 'ja_jp');
  assert.strictEqual(fn('ru'), 'ru_ru');
  assert.strictEqual(fn('en-US'), 'en_us');
  assert.strictEqual(fn('zh'), 'zh_cn');
});

test('主进程 normalizeDesktopLocale 同样收敛到新码', () => {
  const sandbox = { path, fs, console, Map, JSON, String };
  vm.createContext(sandbox);
  vm.runInContext(mainI18nBlock(mainSrc, { localesDir: localesDir }), sandbox);
  const fn = sandbox.normalizeDesktopLocale;
  assert.strictEqual(fn('zh-CN'), 'zh_cn');
  assert.strictEqual(fn('en-US'), 'en_us');
  assert.strictEqual(fn('ja-JP'), 'ja_jp');
  assert.strictEqual(fn('ru-RU'), 'ru_ru');
  assert.strictEqual(fn('xx'), 'zh_cn');
});
