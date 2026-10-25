'use strict';

// ============================================================
//  语言切换入口 / Language switcher entry
//  - 位置：DIY 视觉控制台（#fx-panel）顶部的一排四个语言按钮。
//    标题栏不再放语言按钮 —— 那一排已经太挤，而切语言是低频操作。
//    Lives as a row of four language buttons at the top of the DIY visual console
//    (#fx-panel). The title bar no longer carries a language button: that row was
//    already crowded, and switching language is a low-frequency action.
//  - 选择语言后交给 i18n 核心：重扫 DOM、写 localStorage、广播变更，
//    这里只负责让按钮的选中态跟上。
//    Picking a language is delegated to the i18n core (re-scan, persist, broadcast);
//    this module only keeps the buttons' selected state in sync.
// ============================================================
(function (root) {
  var i18n = root.MineradioI18n;
  if (!i18n) return;

  function bind() {
    var row = document.getElementById('fx-lang-row');
    if (!row) return;

    function refresh() {
      var current = i18n.getLanguage();
      var items = row.querySelectorAll('[data-lang]');
      for (var i = 0; i < items.length; i++) {
        var on = items[i].getAttribute('data-lang') === current;
        items[i].classList.toggle('active', on);
        items[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    row.addEventListener('click', function (event) {
      var node = event.target;
      while (node && node !== row && !node.getAttribute('data-lang')) node = node.parentNode;
      if (!node || node === row) return;
      var picked = node.getAttribute('data-lang');
      if (picked && picked !== i18n.getLanguage()) i18n.setLanguage(picked);
      refresh();
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
      refresh();
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
