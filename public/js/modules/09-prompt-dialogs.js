// 文案统一走 i18n：缺键返回键名（不返回空串），params 同时喂给词典与兜底模板。
// Copy goes through i18n; a missing key returns the key itself rather than an empty string.
function promptDialogsText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === "object") {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}
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
    if (state.hintEl) state.hintEl.textContent = state.emptyMessage || promptDialogsText('prompt_confirm_first');
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
    parts.titleEl.textContent = String(options.title || promptDialogsText('prompt_input'));
    parts.hintEl.textContent = String(options.hint || '');
    parts.cancelEl.textContent = String(options.cancelText || promptDialogsText('btn_cancel', '取消'));
    parts.cancelEl.style.display = readOnly ? 'none' : '';
    parts.confirmEl.textContent = String(options.confirmText || (readOnly ? promptDialogsText('btn_close', '关闭') : '确定'));
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
    confirmText: options.confirmText || promptDialogsText('btn_close', '关闭')
  });
}
