'use strict';

// 主进程原生对话框的 i18n 守卫。
//
// 背景：原生对话框（文件选择器 / 错误框 / 登录窗口标题）由 Electron 直接绘制，
// 渲染进程的 data-i18n 够不到它。主进程因此自读同一份 public/locales/<lang>.json，
// 渲染端切换语言时推一次 IPC。这条链路有两个静默失效点：
//
//   1. 主进程引用了一个词典里没有的键 → t() 退回内置中文，界面在非中文下永远显示中文，
//      而且不抛任何异常；
//   2. 词典读不到（打包路径变化 / 文件缺失）→ 同样静默退回中文。
//
// 所以守卫要钉住：键存在、四语都能取到值、缺词典时不抛、渲染端确实推了语言。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mainI18nBlock } = require('./helpers/module-source');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.js'), 'utf8');
const SWITCHER = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '00-state', '14-i18n-switcher.js'), 'utf8');
const LANGS = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];
const LOCALES_DIR = path.join(ROOT, 'public', 'locales');

function loadDict(lang) {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang + '.json'), 'utf8'));
}
const DICTS = LANGS.map(loadDict);

function mainSandbox(extra) {
  const sandbox = Object.assign({ path, fs, console, Map, JSON, String }, extra || {});
  vm.createContext(sandbox);
  // 语言要传进 mainI18nBlock —— 生成的片段里 `let desktopLocale` 就是在那儿初始化的。
  // 只把它塞进沙箱对象没用：vm 上下文的顶层 let 绑定不挂在 sandbox 上。
  // The locale must go into mainI18nBlock: that is where the generated `let desktopLocale`
  // is initialised. Assigning it on the sandbox object alone does nothing — a top-level
  // `let` in a vm context is not a property of the sandbox.
  vm.runInContext(mainI18nBlock(MAIN, { localesDir: LOCALES_DIR, desktopLocale: (extra || {}).desktopLocale }), sandbox);
  return sandbox;
}

test('主进程引用的每个词典键在四份词典里都存在', () => {
  const used = new Set([
    ...[...MAIN.matchAll(/desktopText\('([a-z0-9_]+)'/g)].map((m) => m[1]),
    ...[...MAIN.matchAll(/__mineradioLoginTitleKey = '([a-z0-9_]+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(used.size >= 10, '只认出 ' + used.size + ' 个键，正则可能与实现脱节');
  const missing = [];
  for (const key of used) {
    for (let i = 0; i < LANGS.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(DICTS[i], key)) missing.push(`${key} 缺于 ${LANGS[i]}`);
    }
  }
  assert.deepStrictEqual(missing, [], missing.join('\n'));
});

test('主进程在四种语言下都取得到值，且不返回空串', () => {
  const keys = [...new Set([
    ...[...MAIN.matchAll(/desktopText\('([a-z0-9_]+)'/g)].map((m) => m[1]),
    ...[...MAIN.matchAll(/__mineradioLoginTitleKey = '([a-z0-9_]+)'/g)].map((m) => m[1]),
  ])];
  const offenders = [];
  for (const lang of LANGS) {
    const sandbox = mainSandbox({ desktopLocale: lang });
    for (const key of keys) {
      const value = sandbox.desktopText(key, '兜底');
      if (!value) offenders.push(`${lang} 的 ${key} 取到空串`);
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

test('非中文语言下，原生对话框文案确实不是中文', () => {
  // 这是这条链路存在的意义：非中文界面不该在这些标题上漏出中文。
  // 抽样若干条已知的对话框标题，逐语言确认真的换了。
  const sandbox = mainSandbox({ desktopLocale: 'en_us' });
  const samples = ['dialog_choose_cache_dir', 'dialog_we_import_title', 'dialog_we_detect_button',
    'dialog_source_import_title', 'dialog_source_replace_title', 'dialog_we_choose_title'];
  const stillChinese = samples.filter((key) => /[一-鿿]/.test(sandbox.desktopText(key, '')));
  assert.deepStrictEqual(stillChinese, [], '英文下这些标题仍是中文：' + stillChinese.join(', '));
});

test('词典读不到时退回内置中文且不抛异常', () => {
  // 主进程没有 i18n 运行时可依赖，抛异常会让所有对话框都打不开 —— 这条必须守住。
  const broken = {
    path, Map, JSON, String,
    fs: { readFileSync() { throw new Error('ENOENT'); } },
    console: { warn() {}, error() {}, log() {} },
  };
  vm.createContext(broken);
  vm.runInContext(mainI18nBlock(MAIN, { localesDir: 'X', desktopLocale: 'en_us' }), broken);
  let value = null;
  assert.doesNotThrow(() => { value = broken.desktopText('btn_ok', '确定'); });
  assert.strictEqual(value, '确定', '词典不可用时应退回调用方给的中文兜底');
});

test('缺键退回兜底而不是把键名显示给用户', () => {
  const sandbox = mainSandbox({ desktopLocale: 'en_us' });
  assert.strictEqual(sandbox.desktopText('no_such_key_at_all', '兜底文案'), '兜底文案');
});

test('语言归一化：区域码取基语言，未知语言退回中文', () => {
  const sandbox = mainSandbox({ desktopLocale: 'zh_cn' });
  assert.strictEqual(sandbox.normalizeDesktopLocale('zh'), 'zh_cn');
  assert.strictEqual(sandbox.normalizeDesktopLocale('zh-TW'), 'zh_cn');
  assert.strictEqual(sandbox.normalizeDesktopLocale('en-US'), 'en_us');
  assert.strictEqual(sandbox.normalizeDesktopLocale('ja-JP'), 'ja_jp');
  assert.strictEqual(sandbox.normalizeDesktopLocale('ru-RU'), 'ru_ru');
  assert.strictEqual(sandbox.normalizeDesktopLocale('xx'), 'zh_cn');
  assert.strictEqual(sandbox.normalizeDesktopLocale(''), 'zh_cn');
});

test('preload 暴露了语言同步桥，渲染端在语言变化时调用它', () => {
  assert.ok(/setLocale:\s*\(lang\)\s*=>\s*ipcRenderer\.invoke\('mineradio-set-locale'/.test(PRELOAD),
    'preload 没有暴露 setLocale 桥');
  assert.ok(/ipcMain\.handle\('mineradio-set-locale'/.test(MAIN),
    '主进程没有处理 mineradio-set-locale');
  assert.ok(/function pushLocaleToDesktop\(/.test(SWITCHER),
    '渲染端没有推送语言给主进程的函数');
  assert.ok(/pushLocaleToDesktop\(lang\)/.test(SWITCHER),
    '语言变更回调没有调用 pushLocaleToDesktop');
});

test('登录窗口与桌面歌词窗口都带上了标题标记（语言切换后才能补写标题）', () => {
  const loginMarks = (MAIN.match(/__mineradioLoginWindow = true/g) || []).length;
  assert.strictEqual(loginMarks, 3, '三个登录窗口（网易云 / QQ / 酷狗）都应打标记，实际 ' + loginMarks);
  assert.ok(/__mineradioDesktopLyricsWindow = true/.test(MAIN), '桌面歌词窗口没有打标记');
  for (const key of ['desktop_netease_login', 'desktop_qq_login', 'desktop_kugou_login']) {
    assert.ok(MAIN.includes("__mineradioLoginTitleKey = '" + key + "'"), key + ' 没有被用作窗口标题键');
  }
});

test('原生对话框不再直接写死中文标题', () => {
  // 这 16 处是原生对话框的全部文案入口。判据覆盖三种形状：
  //   title:       对话框标题
  //   buttonLabel: 打开对话框里的确认按钮
  //   name:        文件类型过滤器名（也是用户可见文案）
  // 少认一种形状就会漏 —— 变实测：漏了 `name:` 那一类（文件过滤器名），
  // 守卫对那处硬编码的中文完全无感。
  // Three shapes carry native-dialog copy. Missing one leaves a blind spot: the `name:`
  // form (file-type filter labels) went unnoticed until this test was mutation-checked.
  const FIELDS = ['title', 'buttonLabel', 'name'];
  const hardcoded = [];
  for (const field of FIELDS) {
    const re = new RegExp("(?:^|[\\s{,])" + field + ":\\s*'[^']*[\\u4e00-\\u9fff][^']*'", 'g');
    for (const m of MAIN.matchAll(re)) {
      const text = m[0].trim();
      // 产品名与固定窗口标题不是界面文案，不该被这条判据拦住。
      if (/Mineradio/.test(text)) continue;
      hardcoded.push(text);
    }
  }
  assert.deepStrictEqual(hardcoded, [],
    '这些原生对话框文案仍是硬编码中文：\n' + hardcoded.join('\n'));
});
