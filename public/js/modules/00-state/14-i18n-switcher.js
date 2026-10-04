'use strict';

// ============================================================
//  语言切换入口 / Language switcher entry
//  - 搜索框内的按钮 + 四语言菜单；不遮挡、不禁用搜索本身。
//    A button in the search box plus a four-language menu; it never blocks or
//    disables search itself.
//  - 选择语言后交给 i18n 核心：重扫 DOM、写 localStorage、广播变更，
//    这里只负责让自己（按钮标签 / 选中态）跟上。
//    Picking a language is delegated to the i18n core (re-scan, persist, broadcast);
//    this module only keeps its own label and selected state in sync.
// ============================================================
(function (root) {
  var i18n = root.MineradioI18n;
  if (!i18n) return;

  function bind() {
    var toggle = document.getElementById('lang-toggle-btn');
    var menu = document.getElementById('lang-menu');
    if (!toggle || !menu) return;

    function refresh() {
      var current = i18n.getLanguage();
      var label = i18n.langLabel(current) || '中文';
      toggle.textContent = label.slice(0, 1);
      var items = menu.querySelectorAll('[data-lang]');
      for (var i = 0; i < items.length; i++) {
        if (items[i].getAttribute('data-lang') === current) items[i].classList.add('active');
        else items[i].classList.remove('active');
      }
    }

    function close() {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }

    function open() {
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    }

    toggle.addEventListener('click', function (event) {
      event.stopPropagation();
      if (menu.hidden) open();
      else close();
    });

    menu.addEventListener('click', function (event) {
      var node = event.target;
      while (node && node !== menu && !node.getAttribute('data-lang')) node = node.parentNode;
      if (!node || node === menu) return;
      var picked = node.getAttribute('data-lang');
      if (picked) i18n.setLanguage(picked);
      close();
    });

    // 点空白处或按 Esc 收起，避免菜单悬挂在界面上。
    // Close on outside click or Esc so the menu never hangs around.
    document.addEventListener('click', function (event) {
      if (menu.hidden) return;
      if (menu.contains(event.target) || toggle.contains(event.target)) return;
      close();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !menu.hidden) close();
    });

    // 原生对话框由主进程绘制，渲染进程的 data-i18n 够不到它。语言变化时把当前语言推过去，
    // 主进程自读同一份词典取词。桥不存在时静默跳过 —— 浏览器里跑或测试沙箱里都没有它。
    // Native dialogs are drawn by the main process, out of reach of data-i18n. Push the active
    // language on every change so the main process can read the same dictionary. Skip
    // silently when the bridge is absent: there is none in the browser or a test sandbox.
    function pushLocaleToDesktop(lang) {
      try {
        var bridge = window.desktopWindow;
        if (bridge && typeof bridge.setLocale === 'function') bridge.setLocale(lang);
      } catch (e) {}
    }

    i18n.onLanguageChange(function (lang) {
      refresh(lang);
      pushLocaleToDesktop(lang);
    });
    pushLocaleToDesktop(i18n.getLanguage());
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})(typeof window !== 'undefined' ? window : this);
