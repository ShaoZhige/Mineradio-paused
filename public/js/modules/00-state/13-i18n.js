'use strict';

// ============================================================
//  界面国际化核心 / UI internationalization core
//  - 支持 zh_cn / en_us / ja_jp / ru_ru，默认 zh_cn。文件名沿用 Minecraft 的 xx_xx 约定。
//    Supports zh_cn / en_us / ja_jp / ru_ru, defaulting to zh_cn. File names follow
//    Minecraft's xx_xx convention.
//  - 只翻译界面文案，不改变功能可用性：搜索、登录在任何语言下都照常可用。
//    Translates UI copy only. Feature availability (search, login, playback) is
//    identical in every language — language is presentation, not a gate.
//  - 静态节点用 data-i18n / data-i18n-attr / data-i18n-placeholder 声明；
//    动态文案调用 MineradioI18n.t(key, params)。
//    Static nodes declare data-i18n / data-i18n-attr / data-i18n-placeholder;
//    dynamic copy calls MineradioI18n.t(key, params).
//  - 词典按语言懒加载，切换语言后重扫 DOM 并广播变更，供各模块重绘动态内容。
//    Dictionaries load lazily per language; switching re-scans the DOM and
//    broadcasts the change so modules can re-render dynamic content.
// ============================================================
(function (root) {
  var STORAGE_KEY = 'mineradio-lang';
  var DEFAULT_LANG = 'zh_cn';
  var SUPPORTED_LANGS = ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'];
  var LANG_LABELS = { 'zh_cn': '中文', en_us: 'English', ja_jp: '日本語', ru_ru: 'Русский' };
  // document.documentElement.lang 走标准 BCP47，与文件名（xx_xx）解耦。
  // document.documentElement.lang uses standard BCP47, decoupled from the xx_xx file names.
  var DOC_LANG = { 'zh_cn': 'zh-CN', en_us: 'en', ja_jp: 'ja', ru_ru: 'ru' };
  // 缺键回退链：俄语优先退到英文再退中文，避免在俄语界面里蹦出中文。
  // Missing-key fallback: Russian prefers English before Chinese, so a Russian UI
  // never drops back into Chinese mid-sentence.
  var FALLBACK_CHAIN = { 'zh_cn': [], en_us: ['zh_cn'], ja_jp: ['zh_cn'], ru_ru: ['en_us', 'zh_cn'] };

  var currentLang = DEFAULT_LANG;
  var dictionaries = {};   // lang -> flat { key: text }
  var loading = {};        // lang -> Promise
  var listeners = [];

  // 从指定语言表里取一个键；表还没加载或没有这个键时返回 undefined，
  // 由 t() 决定走回退链还是退回键名本身。t() 依赖这个 undefined 语义，
  // 所以这里不能返回空串——空串会让回退链失效，非中文界面直接空掉。
  // Read one key out of a language table; returns undefined when the table is not
  // loaded yet or lacks the key, leaving the decision to t()'s fallback chain.
  // t() relies on that undefined semantics, so this must never return an empty
  // string — an empty string would short-circuit the chain and blank the UI.
  function pick(key, lang) {
    var table = dictionaries[lang];
    if (!table) return undefined;
    var value = table[key];
    return value === undefined ? undefined : value;
  }

  // 把任意写法（zh、zh-Hans、en-US、ru-RU…）收敛到受支持的语言码。
  // Collapse any spelling (zh, zh-Hans, en-US, ru-RU, ...) onto a supported code.
  // 任意写法（zh、zh-CN、zh_cn、zh_CN、en-US、en_us…）都收敛到受支持的下划线双段码。
  // Collapse any spelling (zh, zh-CN, zh_cn, zh_CN, en-US, en_us, ...) onto the
  // supported underscore-joined code.
  function normalizeLang(value) {
    if (!value) return DEFAULT_LANG;
    var raw = String(value).trim().toLowerCase().replace(/-/g, '_');
    if (!raw) return DEFAULT_LANG;
    for (var i = 0; i < SUPPORTED_LANGS.length; i++) {
      if (SUPPORTED_LANGS[i].toLowerCase() === raw) return SUPPORTED_LANGS[i];
    }
    var base = raw.split('_')[0];
    if (base === 'zh') return 'zh_cn';
    if (base === 'en') return 'en_us';
    if (base === 'ja') return 'ja_jp';
    if (base === 'ru') return 'ru_ru';
    return DEFAULT_LANG;
  }

  function readStoredLang() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function writeStoredLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  }

  // 系统语言只作首次默认，用户一旦手动选择就永久以用户选择为准。
  // System language is only a first-run default; an explicit choice always wins.
  function detectSystemLang() {
    var nav = root.navigator || {};
    var list = (nav.languages && nav.languages.length) ? nav.languages : [nav.language || nav.userLanguage || ''];
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      return normalizeLang(list[i]);
    }
    return DEFAULT_LANG;
  }

  function resolveInitialLang() {
    var stored = readStoredLang();
    if (stored) return normalizeLang(stored);
    return detectSystemLang();
  }

  // 词典懒加载：失败也 resolve 成空表，缺键走默认语言回退，界面不会因此空掉。
  // Lazy dictionary load: a failure resolves to an empty map; missing keys fall
  // back to the default language, so the UI never blanks out.
  function loadLocale(lang) {
    lang = normalizeLang(lang);
    if (dictionaries[lang]) return Promise.resolve(dictionaries[lang]);
    if (loading[lang]) return loading[lang];
    loading[lang] = new Promise(function (resolve) {
      var request = new XMLHttpRequest();
      request.open('GET', 'locales/' + lang + '.json?v=' + Date.now(), true);
      request.onload = function () {
        var data = null;
        if (request.status >= 200 && request.status < 300) {
          try { data = JSON.parse(request.responseText); } catch (e) { data = null; }
        }
        dictionaries[lang] = (data && typeof data === 'object') ? data : {};
        resolve(dictionaries[lang]);
      };
      request.onerror = function () {
        dictionaries[lang] = {};
        resolve(dictionaries[lang]);
      };
      request.send(null);
    });
    return loading[lang];
  }

  // 回退字典必须提前加载，否则 t() 里"退到英文"时英文表还不存在，等于没退。
  // Fallback dictionaries must be preloaded: otherwise "fall back to English" finds
  // an empty table and the fallback silently does nothing.
  function loadChain(lang) {
    var chain = [lang].concat(FALLBACK_CHAIN[lang] || []);
    return Promise.all(chain.map(loadLocale));
  }

  function t(key, params) {
    if (!key) return '';
    var value = pick(key, currentLang);
    if (value === undefined) {
      var chain = FALLBACK_CHAIN[currentLang] || [DEFAULT_LANG];
      for (var i = 0; i < chain.length && value === undefined; i++) value = pick(key, chain[i]);
    }
    if (value === undefined || value === null) value = key;
    value = typeof value === 'string' ? value : String(value);
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(function (name) {
        value = value.split('{' + name + '}').join(String(params[name]));
      });
    }
    return value;
  }

  function applyToElement(element) {
    if (!element || !element.getAttribute) return;
    var key = element.getAttribute('data-i18n');
    if (key) {
      var text = t(key);
      var targets = element.getAttribute('data-i18n-attr');
      if (targets) {
        targets.split(',').forEach(function (attr) {
          attr = attr.trim();
          if (attr === 'text') element.textContent = text;
          else if (attr === 'html') element.innerHTML = text;
          else if (attr) element.setAttribute(attr, text);
        });
      } else {
        element.textContent = text;
      }
    }
    var titleKey = element.getAttribute('data-i18n-title');
    if (titleKey) element.setAttribute('title', t(titleKey));
    var placeholderKey = element.getAttribute('data-i18n-placeholder');
    if (placeholderKey) element.setAttribute('placeholder', t(placeholderKey));
  }

  function scan(rootNode) {
    var scope = (rootNode && rootNode.querySelectorAll) ? rootNode : document;
    if (!scope || !scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder]');
    for (var i = 0; i < nodes.length; i++) applyToElement(nodes[i]);
    if (document.documentElement) document.documentElement.lang = DOC_LANG[currentLang] || 'en';
  }

  function notify(next, previous) {
    listeners.slice().forEach(function (fn) {
      try { fn(next, previous); } catch (e) {}
    });
  }

  function setLanguage(lang, options) {
    var next = normalizeLang(lang);
    var previous = currentLang;
    if (next === previous && !(options && options.force)) return Promise.resolve(previous);
    currentLang = next;
    writeStoredLang(next);
    return loadChain(next).then(function () {
      scan();
      notify(next, previous);
      return next;
    });
  }

  function onLanguageChange(fn) {
    if (typeof fn === 'function' && listeners.indexOf(fn) < 0) listeners.push(fn);
  }

  function init() {
    currentLang = resolveInitialLang();
    return loadChain(currentLang).then(function () {
      scan();
      notify(currentLang, currentLang);
      return currentLang;
    });
  }

  root.MineradioI18n = {
    t: t,
    init: init,
    scan: scan,
    setLanguage: setLanguage,
    getLanguage: function () { return currentLang; },
    onLanguageChange: onLanguageChange,
    getSupportedLangs: function () { return SUPPORTED_LANGS.slice(); },
    langLabel: function (lang) { return LANG_LABELS[normalizeLang(lang)]; },
    normalizeLang: normalizeLang,
    loadLocale: loadLocale,
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
      init();
    }
  }
})(typeof window !== 'undefined' ? window : this);
