'use strict';

// ============================================================
//  语言切换入口 / Language switcher entry
//  - 位置：DIY 视觉控制台（#fx-panel）「界面」页签的第一组。
//    标题栏不再放语言按钮 —— 那一排已经太挤，而切语言是低频操作。
//    Lives in the first group of the Interface tab of the DIY visual console (#fx-panel).
//    The title bar no longer carries a language button: that row was already crowded,
//    and switching language is a low-frequency action.
//  - 形态：一个显示当前语言的触发器，点开后在下方就地展开选项列表（不是浮层下拉）。
//    #fx-panel 自身是 overflow-x:hidden 的滚动容器，浮层会被横向裁掉、贴底还会被滚出
//    视野，所以列表走流内展开。
//    Shape: a trigger showing the active language; clicking it expands the option list in
//    place. #fx-panel is a scroll container with overflow-x:hidden, so a floating popup
//    would be clipped sideways and scrolled out of view near the bottom.
//  - 事件用 document 级委托 + 每次现取节点：DIY 控制台重建时整块节点会被搬走甚至替换，
//    绑定在节点上的引用会失效，委托则不受影响。
//    Clicks are delegated from document and nodes are re-queried every time: the console
//    rebuilds can move or replace the node, which would orphan listener-bound references.
//  - 选择语言后交给 i18n 核心：重扫 DOM、写 localStorage、广播变更，这里只负责
//    触发器的文字和列表的选中态。
//    Picking a language is delegated to the i18n core (re-scan, persist, broadcast); this
//    module only keeps the trigger label and the list selection in sync.
// ============================================================
(function (root) {
  var i18n = root.MineradioI18n;
  if (!i18n) return;

  function nodes() {
    return {
      row: document.getElementById('fx-lang-row'),
      trigger: document.getElementById('fx-lang-trigger'),
      menu: document.getElementById('fx-lang-menu'),
      value: document.getElementById('fx-lang-value')
    };
  }

  function optionNodes(menu) {
    if (!menu) return [];
    return Array.prototype.slice.call(menu.querySelectorAll('[data-lang]'));
  }

  function labelOf(lang) {
    return i18n.langLabel(lang) || lang;
  }

  // 触发器文字与列表选中态。节点可能还没进 DOM（面板尚未构建）或刚被重建，所以要容错。
  // Trigger label and list selection. Tolerate missing nodes: the panel may not be built yet
  // or may have just been rebuilt.
  function refresh() {
    var n = nodes();
    var current = i18n.getLanguage();
    if (n.value) n.value.textContent = labelOf(current);
    var items = optionNodes(n.menu);
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-lang') === current;
      items[i].classList.toggle('active', on);
      items[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (n.trigger) n.trigger.setAttribute('aria-label', labelOf(current));
  }

  function setOpen(open) {
    var n = nodes();
    if (!n.menu || !n.trigger) return;
    n.menu.hidden = !open;
    n.trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;
    // 展开后把当前语言滚进列表视口（block:'nearest' 不会带动整块面板跳动）。
    // Bring the active language into the list's own view; 'nearest' keeps the panel still.
    var active = n.menu.querySelector('[data-lang].active') || n.menu.querySelector('[data-lang]');
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
  }

  function isOpen() {
    var n = nodes();
    return !!(n.menu && !n.menu.hidden);
  }

  function pick(lang) {
    setOpen(false);
    if (lang && lang !== i18n.getLanguage()) {
      i18n.setLanguage(lang);
    } else {
      refresh();
    }
  }

  // 原生对话框由主进程绘制，渲染进程的 data-i18n 够不到它。语言变化时把当前语言推过去，
  // 主进程自读同一份词典取词。桥不存在时静默跳过 —— 浏览器里跑或测试沙箱里都没有它。
  // Native dialogs are drawn by the main process, out of reach of data-i18n. Push the active
  // language on every change so the main process can read the same dictionary. Skip silently
  // when the bridge is absent: there is none in the browser or a test sandbox.
  function pushLocaleToDesktop(lang) {
    try {
      var bridge = window.desktopWindow;
      if (bridge && typeof bridge.setLocale === 'function') bridge.setLocale(lang);
    } catch (e) {}
  }

  function closestMatch(target, selector) {
    if (!target || target.nodeType !== 1) return null;
    if (typeof target.closest === 'function') return target.closest(selector);
    return null;
  }

  function onClick(event) {
    var target = event.target;

    var option = closestMatch(target, '#fx-lang-menu [data-lang]');
    if (option) {
      pick(option.getAttribute('data-lang'));
      return;
    }

    if (closestMatch(target, '#fx-lang-trigger')) {
      setOpen(!isOpen());
      return;
    }

    // 点到语言行以外的地方就收起 —— 面板里其它控件照样能点，因为这里只改 hidden。
    // Collapse when the click lands outside the row; other controls keep working because
    // this only flips a hidden attribute.
    if (!closestMatch(target, '#fx-lang-row')) setOpen(false);
  }

  function onKeydown(event) {
    if (!isOpen()) return;
    var n = nodes();
    var key = event.key;

    if (key === 'Escape') {
      setOpen(false);
      if (n.trigger && typeof n.trigger.focus === 'function') n.trigger.focus();
      event.preventDefault();
      return;
    }

    if (key === 'Tab') {
      setOpen(false);
      return;
    }

    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;

    // 焦点不在语言行内就不接管：面板里还有别的滑块和输入框要用方向键。
    // Only take over the arrow keys while focus is inside the row — the panel has sliders
    // and inputs that need them.
    var row = n.row;
    if (!row || !row.contains(document.activeElement)) return;

    var items = optionNodes(n.menu);
    if (!items.length) return;
    var index = items.indexOf(document.activeElement);
    var next;
    if (key === 'Home') next = 0;
    else if (key === 'End') next = items.length - 1;
    else if (key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
    else next = index <= 0 ? items.length - 1 : index - 1;

    items[next].focus();
    event.preventDefault();
  }

  var bound = false;

  function bind() {
    if (bound) return;
    bound = true;

    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown);

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
