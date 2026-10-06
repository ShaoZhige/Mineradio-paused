'use strict';

// 模块源码在测试里的两个常见用法：
//   1. 按花括号配平切出一个函数 —— 正则遇到嵌套花括号就会切歪；
//   2. 把片段放进裸沙箱跑一遍 —— 片段用到的取词函数定义在文件头部，必须一起带上。
// 后者是模块化之后才出现的问题：片段依赖的 helper 不在切片范围内。
// Two recurring needs: brace-matched extraction (a regex mis-slices nested braces), and
// running a fragment in a bare sandbox — the accessors a fragment calls live at the top
// of the file, outside the slice, so they have to be carried along.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 取词函数统一形态：function <域>Text(key, fallback, params) { ... }
// Every accessor shares one shape, so one pattern finds them all.
const ACCESSOR_HEAD = /^function (\w+Text)\(key, fallback(?:, params)?\) \{/gm;

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('源码里没有找到函数 ' + name);
  let depth = 0;
  for (let i = source.indexOf('{', start); i >= 0 && i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 的花括号不配平');
}

function accessorNames(source) {
  const names = [];
  ACCESSOR_HEAD.lastIndex = 0;
  let m;
  while ((m = ACCESSOR_HEAD.exec(source)) !== null) names.push(m[1]);
  return names;
}

// 片段沙箱要用的取词函数定义（原样搬运，不重写实现，避免测试与实际实现漂移）。
// Verbatim copies of the accessors, so the sandbox cannot drift from the real code.
function accessorBlock(source) {
  return accessorNames(source).map((name) => extractFunction(source, name)).join('\n');
}

// 在裸沙箱里拿到取词函数本体：i18n 为 null 时不注入 window，验证没有运行时也不抛。
// Returns the accessor itself, with `window` injected only when an i18n stub is given.
function accessorInSandbox(source, name, i18n, extra) {
  const sandbox = Object.assign({}, extra || {});
  if (i18n) sandbox.window = { MineradioI18n: i18n };
  vm.runInNewContext(extractFunction(source, name) + '\nthis.call = ' + name + ';', sandbox);
  return sandbox.call;
}

// 渲染进程取词函数依赖 window.MineradioI18n。沙箱里没有真实 i18n 运行时，给一个只查
// zh-CN 词典的桩：t(key) 命中返回中文，未命中返回键名本身（与真实行为一致——漏键可见）。
// Renderer accessors read window.MineradioI18n. A bare sandbox has no runtime, so provide a
// stub backed by the zh-CN dictionary: a hit returns Chinese, a miss returns the key itself,
// matching the real "missing keys are visible" behaviour.
function loadDict(lang) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'locales', lang + '.json'), 'utf8'));
}

function i18nWindow(locale) {
  const dict = loadDict(locale || 'zh_cn');
  return {
    MineradioI18n: {
      t: (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key),
    },
  };
}

// 平台注册表是所有 provider 清单的唯一来源，多个模块在**加载时**就调用它取清单
//（例如 `var SOURCE_FALLBACK_DIRECT_PROVIDERS = providerRegistryKeysWith('directFallback')`）。
// 所以任何把这些模块单独丢进裸沙箱的测试都会报 `providerRegistryKeysWith is not defined`。
// 这里按生产环境的真实加载方式处理：index-loader 把模块拼成一个 script，注册表排在消费方之前。
// 测试照做即可，同时在语义上更贴近真实加载顺序。
// The provider registry is the single source for every provider list, and several modules call it at
// LOAD time (`var SOURCE_FALLBACK_DIRECT_PROVIDERS = providerRegistryKeysWith('directFallback')`), so
// any test that sandboxes one of those modules alone gets a ReferenceError. This mirrors production:
// index-loader concatenates modules into one script with the registry ahead of its consumers.
const PROVIDER_REGISTRY_PATH = path.join(__dirname, '..', '..', 'public', 'js', 'modules', '00-state', '16-provider-registry.js');

function providerRegistrySource() {
  return fs.readFileSync(PROVIDER_REGISTRY_PATH, 'utf8');
}

function withProviderRegistry(source) {
  return providerRegistrySource() + '\n' + source;
}

module.exports = {
  extractFunction,
  accessorNames,
  accessorBlock,
  accessorInSandbox,
  mainI18nBlock,
  loadDict,
  i18nWindow,
  withProviderRegistry,
  providerRegistrySource,
};

// 主进程 i18n 助手的提取器。片段沙箱跑 desktop/main.js 的切片时，切片里会调用
// desktopText()，而它定义在文件更早的位置、不在切片内 —— 不带进去就是 ReferenceError。
// Extractor for the main-process i18n helpers: a fragment that calls desktopText() needs
// that function in scope, and it lives outside the sliced range.
// 依赖链：desktopText -> readDesktopLocale -> normalizeDesktopLocale，所以三个都要。
// Dependency chain: desktopText -> readDesktopLocale -> normalizeDesktopLocale.
const MAIN_I18N_HELPERS = ['normalizeDesktopLocale', 'readDesktopLocale', 'desktopText'];
// 这三个助手依赖模块级的 const/let（语言白名单、词典目录、缓存、语言状态）。
// 只提取函数定义会得到一个在沙箱里报 "undefined has no .includes" 的片段 ——
// 常量必须一起带进去，而且要在函数之前（const 有暂时性死区）。
// The helpers close over module-level consts. Extracting only the functions yields a
// fragment that throws "undefined has no .includes"; the constants must come along, and
// they must precede the functions because const bindings are in the temporal dead zone.
const MAIN_I18N_CONSTANTS = ['LOCALES_DIR', 'SUPPORTED_LOCALES', 'FALLBACK_LOCALE'];

function extractConst(source, name) {
  const at = source.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('源码里没有找到常量 ' + name);
  const end = source.indexOf('\n', at);
  return source.slice(at, end);
}

function mainI18nBlock(source, extraGlobals) {
  // LOCALES_DIR 依赖 __dirname，沙箱里没有这个绑定 —— 换成调用方给的绝对路径，
  // 语义与主进程一致（仓库根下的 public/locales，打包后同一路径落在 asar 内）。
  // LOCALES_DIR closes over __dirname, which a bare sandbox lacks; take the path from the
  // caller instead. Same target as the main process: public/locales under the app root.
  const constants = MAIN_I18N_CONSTANTS
    .filter((name) => source.includes('const ' + name + ' ='))
    .map((name) => (name === 'LOCALES_DIR'
      ? 'const LOCALES_DIR = ' + JSON.stringify(extraGlobals && extraGlobals.localesDir || '') + ';'
      : extractConst(source, name)))
    .join('\n');
  // 缓存与语言状态是可变绑定，沙箱里要能读写，所以声明成可赋值形式。
  // Cache and locale are mutable bindings the sandbox must be able to read and write.
  // 注意：这里插入的是**生成器求值后的字面量**，不是变量名。生成出来的代码在沙箱里跑，
  // 沙箱作用域里没有 extraGlobals 这个绑定 —— 写成变量名会得到一个 ReferenceError。
  // Emit evaluated literals, not variable names: the generated code runs in the sandbox,
  // which has no `extraGlobals` binding.
  const initialLocale = (extraGlobals && extraGlobals.desktopLocale) || 'zh_cn';
  const state = [
    'let desktopLocale = ' + JSON.stringify(initialLocale) + ';',
    'const desktopLocaleCache = new Map();',
  ].join('\n');
  return constants + '\n' + state + '\n'
    + MAIN_I18N_HELPERS.map((name) => extractFunction(source, name)).join('\n');
}
