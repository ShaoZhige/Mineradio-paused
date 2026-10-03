'use strict';

// Two invariants:
//   1. Renderer dialogs must never touch window.prompt — Electron throws on it, which is what
//      broke "new playlist" (the bare call escaped to window.onerror) and playlist rename.
//   2. Main-process error notices must never use the blocking dialog.showErrorBox; a notice the
//      user does not dismiss would freeze the main thread and keep holding the single-instance
//      lock, which is what made a failed startup look like "double-click does nothing".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.join(__dirname, '..');
const dialogSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '09-prompt-dialogs.js'), 'utf8');
const loaderSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'index-loader.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
const playlistSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '00-built-in-playlists.js'), 'utf8');
const archiveSource = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(appRoot, 'desktop', 'main.js'), 'utf8');

function createClassList() {
  const classes = new Set();
  return {
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    contains(name) { return classes.has(name); },
    toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
  };
}

function createElement(tagName) {
  const listeners = new Map();
  const element = {
    tagName: String(tagName || '').toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    value: '',
    type: '',
    autocomplete: '',
    spellcheck: true,
    readOnly: false,
    maxLength: -1,
    children: [],
    style: {},
    attributes: {},
    selected: false,
    setAttribute(name, value) { element.attributes[name] = String(value); },
    removeAttribute(name) { delete element.attributes[name]; },
    appendChild(child) { element.children.push(child); child.parentNode = element; return child; },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event) {
      const payload = Object.assign({ type, target: element, preventDefault() {} }, event || {});
      (listeners.get(type) || []).slice().forEach((handler) => handler(payload));
    },
    focus() { documentStub.activeElement = element; },
    select() { element.selected = true; },
    setSelectionRange() {},
  };
  element.classList = createClassList();
  return element;
}

const documentListeners = new Map();
const documentStub = {
  body: createElement('body'),
  activeElement: null,
  createElement,
  getElementById(id) {
    const stack = [documentStub.body];
    while (stack.length) {
      const node = stack.pop();
      if (node.id === id) return node;
      (node.children || []).forEach((child) => stack.push(child));
    }
    return null;
  },
  addEventListener(type, handler) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    const handlers = documentListeners.get(type);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  },
  dispatch(type, event) {
    (documentListeners.get(type) || []).slice().forEach((handler) => handler(Object.assign({ type, preventDefault() {} }, event || {})));
  },
  contains(node) { return !!node && node !== documentStub.body; },
};

const sandbox = {
  console,
  document: documentStub,
  // Run scheduled callbacks inline: the dialog only uses the timer to focus its input.
  setTimeout(handler) { handler(); return 0; },
  clearTimeout() {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(dialogSource, sandbox);

const dialogMask = () => documentStub.getElementById('mineradio-text-dialog');

async function firstRun() {
  const promise = sandbox.requestMineradioTextInput({
    title: '新建 Mineradio 内置歌单',
    value: '我的歌单',
    maxLength: 40,
    confirmText: '创建',
    hint: '名称最多 40 个字符',
  });
  const mask = dialogMask();
  assert(mask, 'the dialog element must be created on demand');
  assert(mask.classList.contains('show'), 'requesting input must reveal the dialog');
  assert.strictEqual(mask.attributes['aria-hidden'], 'false', 'the dialog must expose its open state');
  const parts = mask.__mineradioParts;
  assert.strictEqual(parts.titleEl.textContent, '新建 Mineradio 内置歌单', 'the dialog shows the requested title');
  assert.strictEqual(parts.inputEl.value, '我的歌单', 'the dialog seeds the requested value');
  assert.strictEqual(parts.inputEl.maxLength, 40, 'the dialog applies the requested length limit');
  assert.strictEqual(parts.confirmEl.textContent, '创建', 'the confirm button uses the requested label');
  assert.strictEqual(parts.hintEl.textContent, '名称最多 40 个字符', 'the dialog shows the requested hint');

  parts.inputEl.value = '我的收藏';
  parts.confirmEl.dispatch('click');
  assert.strictEqual(await promise, '我的收藏', 'confirming must resolve with the typed text');
  assert.strictEqual(mask.classList.contains('show'), false, 'confirming must hide the dialog');
  assert.strictEqual(mask.attributes['aria-hidden'], 'true', 'a closed dialog must not stay exposed to assistive tech');
  assert.strictEqual(documentListeners.get('keydown') && documentListeners.get('keydown').length, 0, 'closing must drop the global key handler');
}

async function cancelAndValidate() {
  const mask = dialogMask();
  const parts = mask.__mineradioParts;

  const cancelled = sandbox.requestMineradioTextInput({ title: '重命名内置歌单', value: '旧的' });
  parts.cancelEl.dispatch('click');
  assert.strictEqual(await cancelled, null, 'the cancel button must resolve null like window.prompt cancel');

  const escaped = sandbox.requestMineradioTextInput({ title: '重命名内置歌单', value: '旧的' });
  documentStub.dispatch('keydown', { key: 'Escape' });
  assert.strictEqual(await escaped, null, 'Escape must cancel the dialog');

  const backdrop = sandbox.requestMineradioTextInput({ title: '重命名内置歌单', value: '旧的' });
  mask.dispatch('mousedown', { target: mask });
  assert.strictEqual(await backdrop, null, 'clicking the backdrop must cancel the dialog');

  const empty = sandbox.requestMineradioTextInput({ title: '重命名内置歌单', value: '', emptyMessage: '请先输入新的歌单名称' });
  parts.inputEl.value = '   ';
  parts.confirmEl.dispatch('click');
  assert.strictEqual(parts.hintEl.textContent, '请先输入新的歌单名称', 'an empty required value must report inline instead of resolving');
  assert(mask.classList.contains('show'), 'an invalid confirm must keep the dialog open');
  parts.inputEl.value = '新的';
  parts.confirmEl.dispatch('click');
  assert.strictEqual(await empty, '新的', 'a non-empty required value must resolve');

  const opened = sandbox.requestMineradioTextInput({ title: '第一个' });
  const second = sandbox.requestMineradioTextInput({ title: '第二个' });
  assert.strictEqual(await opened, null, 'opening a new dialog must resolve the previous one');
  parts.cancelEl.dispatch('click');
  assert.strictEqual(await second, null, 'the second dialog must still be cancellable');
}

async function readOnlyDisplay() {
  const shareCode = 'MR2-' + 'a'.repeat(300);
  const mask = dialogMask();
  const parts = mask.__mineradioParts;
  const shown = sandbox.showMineradioTextDialog('复制这段 MR2 短代码', shareCode);
  assert(parts.panel.classList.contains('multiline'), 'long read-only text must use the multiline field');
  assert(parts.panel.classList.contains('readonly'), 'long read-only text must be flagged read-only');
  assert.strictEqual(parts.fieldEl.value, shareCode, 'the read-only field must carry the full text');
  assert.strictEqual(parts.fieldEl.readOnly, true, 'the display field must not be editable');
  assert.strictEqual(parts.inputEl.readOnly, true, 'the single-line control must also stay read-only in this mode');
  assert.strictEqual(parts.cancelEl.style.display, 'none', 'a read-only notice only needs a close action');
  assert.strictEqual(parts.confirmEl.textContent, '关闭', 'a read-only notice must default to a close label');
  parts.confirmEl.dispatch('click');
  assert.strictEqual(await shown, shareCode, 'closing the notice hands the text back');
  assert.strictEqual(parts.fieldEl.value, shareCode, 'the displayed text is kept for a later re-open');
}

async function noPromptAnywhere() {
  assert.match(loaderSource, /'js\/modules\/09-prompt-dialogs\.js'/, 'the dialog module must be registered in the index loader');
  assert.match(cssSource, /\.mineradio-dialog-mask\s*\{/, 'the dialog must ship its own mask style');
  assert.match(cssSource, /\.mineradio-text-dialog\.multiline/, 'the dialog must style its multiline mode');
  assert.doesNotMatch(
    playlistSource,
    /window\.prompt\(/,
    'playlist create and rename must not call window.prompt'
  );
  assert.doesNotMatch(archiveSource, /window\.prompt\(/, 'the share-code display must not call window.prompt');
  assert.match(playlistSource, /requestMineradioTextInput\(\{/, 'playlist create must use the in-app dialog');
  assert.match(playlistSource, /await requestMineradioTextInput\(\{/, 'playlist rename must await the in-app dialog');
  assert.match(archiveSource, /showMineradioTextDialog\('复制这段 MR2 短代码', code\)/, 'the share code must fall back to a read-only dialog');
  assert.match(playlistSource, /typeof requestMineradioTextInput !== 'function'/, 'the renderer flows must degrade when the dialog module is unavailable');
  assert.match(archiveSource, /typeof showMineradioTextDialog === 'function'/, 'the share-code fallback must degrade when the dialog module is unavailable');
}

function nonBlockingMainProcessNotices() {
  assert.doesNotMatch(mainSource, /dialog\.showErrorBox\(/, 'no main-process notice may use the blocking error box');
  assert.match(mainSource, /function showNonBlockingErrorDialog\(title, detail, options = \{\}\)/, 'main must expose a non-blocking notice helper');
  assert.match(mainSource, /dialog\.showMessageBox\(\{/, 'the helper must use the async message box');
  assert.match(mainSource, /timer = setTimeout\(finish, timeoutMs\)/, 'the notice must have a timeout fallback so it cannot wedge the process');
  assert.match(mainSource, /showNonBlockingErrorDialog\('Mineradio 显示恢复失败'/, 'renderer recovery failures must use the non-blocking notice');
  assert.match(mainSource, /app\.releaseSingleInstanceLock\(\)/, 'a failed startup must release the single-instance lock immediately');
  assert.match(mainSource, /notice\.then\(\(\) => app\.quit\(\)\)/, 'the failed-startup process must quit once the notice is settled');
}

(async () => {
  await firstRun();
  await cancelAndValidate();
  await readOnlyDisplay();
  await noPromptAnywhere();
  nonBlockingMainProcessNotices();
  console.log('[OK] Prompt flows use the in-app dialog and main-process failures report without blocking or holding the instance lock.');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
