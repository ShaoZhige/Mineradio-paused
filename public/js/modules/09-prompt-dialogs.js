// ============================================================
//  Mineradio 文本输入弹层
// ============================================================
// Electron 渲染进程从未实现 window.prompt —— 调用会直接抛
// "prompt() is and will not be supported."，而 window.confirm / window.alert 是可用的。
// 内置歌单新建、内置歌单重命名、MR2 短码展示这三处过去依赖 window.prompt，因此都需要
// 这个自绘弹层。
// 中英对照：Electron never implemented window.prompt in the renderer — calling it throws
// "prompt() is and will not be supported." Provide an in-app dialog for the flows that used to
// depend on it. The element is created on demand so no markup change is required.
var mineradioTextDialogState = null;
var mineradioTextDialogKeyHandler = null;

function mineradioTextDialogMask() {
  return document.getElementById('mineradio-text-dialog');
}

function ensureMineradioTextDialog() {
  var existing = mineradioTextDialogMask();
  if (existing) return existing;
  if (!document.body) return null;

  var mask = document.createElement('div');
  mask.id = 'mineradio-text-dialog';
  mask.className = 'mineradio-dialog-mask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-hidden', 'true');

  var panel = document.createElement('div');
  panel.className = 'modal mineradio-text-dialog';

  var titleEl = document.createElement('h2');
  titleEl.className = 'mineradio-text-dialog-title';

  var inputEl = document.createElement('input');
  inputEl.className = 'mineradio-text-dialog-input';
  inputEl.type = 'text';
  inputEl.autocomplete = 'off';

  var fieldEl = document.createElement('textarea');
  fieldEl.className = 'mineradio-text-dialog-input mineradio-text-dialog-field';
  fieldEl.autocomplete = 'off';
  fieldEl.spellcheck = false;

  var hintEl = document.createElement('div');
  hintEl.className = 'mineradio-text-dialog-hint';

  var rowEl = document.createElement('div');
  rowEl.className = 'btn-row';

  var cancelEl = document.createElement('button');
  cancelEl.type = 'button';
  cancelEl.className = 'modal-btn';

  var confirmEl = document.createElement('button');
  confirmEl.type = 'button';
  confirmEl.className = 'modal-btn primary';

  rowEl.appendChild(cancelEl);
  rowEl.appendChild(confirmEl);
  panel.appendChild(titleEl);
  panel.appendChild(inputEl);
  panel.appendChild(fieldEl);
  panel.appendChild(hintEl);
  panel.appendChild(rowEl);
  mask.appendChild(panel);
  document.body.appendChild(mask);

  mask.__mineradioParts = {
    mask: mask,
    panel: panel,
    titleEl: titleEl,
    inputEl: inputEl,
    fieldEl: fieldEl,
    hintEl: hintEl,
    cancelEl: cancelEl,
    confirmEl: confirmEl
  };

  cancelEl.addEventListener('click', function () { closeMineradioTextDialog(null); });
  confirmEl.addEventListener('click', function () { submitMineradioTextDialog(); });
  mask.addEventListener('mousedown', function (event) {
    if (event.target === mask) closeMineradioTextDialog(null);
  });
  function confirmOnEnter(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing === true) return;
    event.preventDefault();
    submitMineradioTextDialog();
  }
  inputEl.addEventListener('keydown', confirmOnEnter);
  fieldEl.addEventListener('keydown', confirmOnEnter);
  return mask;
}

function mineradioTextDialogParts() {
  var mask = ensureMineradioTextDialog();
  return mask ? mask.__mineradioParts || null : null;
}

function mineradioTextDialogControl(state) {
  if (!state) return null;
  return state.multiline ? state.fieldEl : state.inputEl;
}

function submitMineradioTextDialog() {
  var state = mineradioTextDialogState;
  if (!state) return;
  var control = mineradioTextDialogControl(state);
  var value = control ? String(control.value || '') : '';
  if (!state.readOnly && state.required && !value.trim()) {
    if (state.hintEl) state.hintEl.textContent = state.emptyMessage || '请输入内容后再确认';
    if (control) { try { control.focus(); } catch (_) {} }
    return;
  }
  closeMineradioTextDialog(value);
}

function closeMineradioTextDialog(value) {
  var state = mineradioTextDialogState;
  mineradioTextDialogState = null;
  if (mineradioTextDialogKeyHandler) {
    document.removeEventListener('keydown', mineradioTextDialogKeyHandler, true);
    mineradioTextDialogKeyHandler = null;
  }
  var mask = mineradioTextDialogMask();
  if (mask) {
    mask.classList.remove('show');
    mask.setAttribute('aria-hidden', 'true');
  }
  if (!state) return;
  // 取消（Esc / 点遮罩 / 取消按钮）一律回 null，与 window.prompt 的语义一致：
  // 调用方用 == null 判断"用户放弃"。
  try { state.resolve(value == null ? null : String(value)); } catch (_) {}
  var returnFocus = state.returnFocus;
  if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
    try { returnFocus.focus(); } catch (_) {}
  }
}

// 返回 Promise<string|null>：确认得到文本，取消/关闭得到 null。
// readOnly 用于展示无法通过剪贴板给出的长文本（例如 MR2 短码），此时进入多行只读模式。
function requestMineradioTextInput(options) {
  options = options || {};
  return new Promise(function (resolve) {
    var parts = mineradioTextDialogParts();
    if (!parts) { resolve(null); return; }
    if (mineradioTextDialogState) closeMineradioTextDialog(null);
    var readOnly = options.readOnly === true;
    var multiline = readOnly || options.multiline === true;
    var value = options.value == null ? '' : String(options.value);
    var maxLength = Math.max(0, Math.round(Number(options.maxLength) || 0));
    var control = multiline ? parts.fieldEl : parts.inputEl;
    parts.panel.classList.toggle('multiline', multiline);
    parts.panel.classList.toggle('readonly', readOnly);
    parts.titleEl.textContent = String(options.title || '输入内容');
    parts.hintEl.textContent = String(options.hint || '');
    parts.cancelEl.textContent = String(options.cancelText || '取消');
    parts.cancelEl.style.display = readOnly ? 'none' : '';
    parts.confirmEl.textContent = String(options.confirmText || (readOnly ? '关闭' : '确定'));
    parts.inputEl.value = multiline ? '' : value;
    parts.fieldEl.value = multiline ? value : '';
    [parts.inputEl, parts.fieldEl].forEach(function (element) {
      element.readOnly = readOnly;
      if (maxLength > 0) element.maxLength = maxLength;
      else element.removeAttribute('maxlength');
    });
    parts.mask.classList.add('show');
    parts.mask.setAttribute('aria-hidden', 'false');
    var openedState = {
      resolve: resolve,
      multiline: multiline,
      readOnly: readOnly,
      required: readOnly ? false : options.required !== false,
      emptyMessage: String(options.emptyMessage || ''),
      inputEl: parts.inputEl,
      fieldEl: parts.fieldEl,
      hintEl: parts.hintEl,
      returnFocus: document.activeElement && document.activeElement !== document.body ? document.activeElement : null
    };
    mineradioTextDialogState = openedState;
    mineradioTextDialogKeyHandler = function (event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMineradioTextDialog(null);
    };
    document.addEventListener('keydown', mineradioTextDialogKeyHandler, true);
    setTimeout(function () {
      if (mineradioTextDialogState !== openedState) return;
      try {
        control.focus();
        if (readOnly) control.select();
        else control.setSelectionRange(control.value.length, control.value.length);
      } catch (_) {}
    }, 30);
  });
}

// 只读展示：调用方通常忽略返回值，但仍然把文本交回去，方便将来做"复制"按钮。
function showMineradioTextDialog(title, text, options) {
  options = options || {};
  return requestMineradioTextInput({
    title: title,
    value: text == null ? '' : String(text),
    readOnly: true,
    multiline: true,
    confirmText: options.confirmText || '关闭'
  });
}
