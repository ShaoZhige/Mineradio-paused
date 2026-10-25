'use strict';

// 安装器首屏语言选择的回归测试 / Installer first-page language picker
//
// 链路共四段，缺一段就会静默失效（用户选了语言，装完界面还是老样子，且没有任何报错）：
//   1. build/installer.nsh 在欢迎页放四个语言单选按钮，离开页面时读回选中项；
//   2. 安装结束把语言码写进 <安装目录>\resources\app\userdata\.installer-language；
//   3. desktop/main.js 通过 IPC 读一次就删掉标记（避免以后重装覆盖用户在应用里的选择）；
//   4. public/js/modules/00-state/13-i18n.js 把安装器的选择排在系统语言之前、用户选择之后。
//
// Four links, and breaking any one of them fails silently — the user picks a language, the app
// still starts in the old one, and nothing logs an error. So every link is asserted here.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const I18N_PATH = path.join(appRoot, 'public', 'js', 'modules', '00-state', '13-i18n.js');

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
}

function stripComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*;/.test(line) && !/^\s*\/\//.test(line))
    .join('\n');
}

const installerCode = stripComments(read(path.join('build', 'installer.nsh')));
const mainText = read(path.join('desktop', 'main.js'));
const preloadText = read(path.join('desktop', 'preload.js'));
const i18nText = read(path.join('public', 'js', 'modules', '00-state', '13-i18n.js'));

test('installer welcome page offers the four supported languages in an openable dropdown', () => {
  // 形态是「点开才展开的列表」，不是一行铺四个单选：收起时只占一行，点箭头才出四项。
  // The shape is a collapsed dropdown rather than four inline radios: one row until the arrow
  // is clicked, then the list opens.
  assert.match(installerCode, /Var\s+MineradioLangCombo\b/, 'the dropdown handle must be declared');
  assert.match(
    installerCode,
    /nsDialogs::CreateControl\s+"COMBOBOX"[\s\S]{0,160}?CBS_DROPDOWNLIST[\s\S]{0,160}?Pop \$MineradioLangCombo/,
    'the welcome page must build a dropdown list (CBS_DROPDOWNLIST), not radios'
  );
  assert.equal(
    /NSD_CreateRadioButton/.test(installerCode),
    false,
    'the four inline radios must be gone — they do not open into a list'
  );

  // 四项保持各自的自称，顺序必须与 CB_SETCURSEL / CB_GETCURSEL 的索引一一对应。
  // Each entry keeps its endonym, and the order has to match the index mapping both ways.
  const options = ['中文', 'English', '日本語', 'Русский'];
  const added = [...installerCode.matchAll(/CB_ADDSTRING\} 0 "STR:([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(added, options, 'the dropdown must list exactly these four endonyms, in order');

  // 四行都要能被预选（/APP_LANG= 或默认值落到哪一行）；索引与上面的四项顺序绑定。
  // Every row must be preselectable (/APP_LANG= or the default lands on one of them).
  for (const index of [0, 1, 2, 3]) {
    assert.match(
      installerCode,
      new RegExp(`CB_SETCURSEL\\} ${index} 0`),
      `the dropdown must be able to preselect row ${index}`
    );
  }
  assert.match(
    installerCode,
    new RegExp(`\\$\\{If\\} \\$0 == 1[\\s\\S]{0,120}?StrCpy \\$MineradioLanguage "en_us"`),
    'index 1 must map onto en_us'
  );
  assert.match(
    installerCode,
    new RegExp(`\\$\\{ElseIf\\} \\$0 == 2[\\s\\S]{0,120}?StrCpy \\$MineradioLanguage "ja_jp"`),
    'index 2 must map onto ja_jp'
  );
  assert.match(
    installerCode,
    new RegExp(`\\$\\{ElseIf\\} \\$0 == 3[\\s\\S]{0,120}?StrCpy \\$MineradioLanguage "ru_ru"`),
    'index 3 must map onto ru_ru'
  );
  assert.match(
    installerCode,
    new RegExp(`StrCpy \\$MineradioLanguage "zh_cn"`),
    'index 0 must map onto zh_cn'
  );

  // 键盘上下键也能换选项，不经过点击回调，所以离开页面时必须读回当前选中项。
  // Arrow keys change the selection without a click, so the leave handler reads it back.
  assert.match(installerCode, /\$\{CB_GETCURSEL\} 0 0[\s\S]{0,80}?Pop \$0/);
  assert.match(installerCode, /Page custom MineradioWelcomeShow MineradioWelcomeLeave/);
});

test('installer writes the picked language where the app looks for it', () => {
  // 应用自己的数据根是 <安装目录>\resources\app\userdata（见 desktop/main.js 的
  // PORTABLE_USER_DATA_PATH），标记必须落在同一个地方，主进程才读得到。
  // The app's data root is <install dir>\resources\app\userdata; the marker has to land there.
  assert.match(installerCode, /resources\\app\\userdata\\\$\{MINERADIO_LANG_MARKER\}/);
  assert.match(installerCode, /!define MINERADIO_LANG_MARKER "\.installer-language"/);
  // 静默安装 / 更新没有界面，不能覆盖用户早已选好的语言。
  // Silent installs and updates show no page and must not overwrite an earlier choice.
  assert.match(installerCode, /\$\{If\} \$MineradioLanguage != ""/);
  assert.match(installerCode, /\$\{If\} \$\{Silent\}[\s\S]{0,120}?StrCpy \$MineradioLanguage ""/);
});

test('main process reads the marker once and then deletes it', () => {
  const reader = mainText.slice(mainText.indexOf('function takeInstallerLanguage()'));
  assert.ok(reader.length > 0, 'takeInstallerLanguage must exist');
  const body = reader.slice(0, reader.indexOf('\n}'));
  assert.match(body, /INSTALLER_LANGUAGE_FILE/);
  assert.match(body, /fs\.readFileSync\(file, 'utf8'\)/);
  // 读完立刻删：留着它，用户以后在应用里换过语言，重装一次又会被安装器的旧选择顶掉。
  // Delete on read: otherwise a reinstall would resurrect the installer's old choice over an
  // explicit in-app selection.
  assert.match(body, /fs\.unlinkSync\(file\)/);
  assert.match(body, /SUPPORTED_LOCALES\.includes\(code\)/);
  // 候选目录要覆盖便携数据根和只读安装目录的兜底位置。
  // Candidates must cover the portable data root and the read-only-install fallback.
  assert.match(body, /\[STABLE_USER_DATA_PATH, PORTABLE_USER_DATA_PATH\]/);
  assert.match(mainText, /ipcMain\.handle\('mineradio-installer-language'/);
  assert.match(preloadText, /getInstallerLanguage: \(\) => ipcRenderer\.invoke\('mineradio-installer-language'\)/);
});

// 把主进程里那段读取逻辑原样求值，真的对着一个临时目录跑一遍 —— 静态断言看不出
// "读完到底删没删" 这种事，而它正是最容易写错、后果又最隐蔽的一环。
// Evaluate the reader straight out of main.js and run it against a real temp folder: static
// assertions cannot tell whether the marker was actually deleted, which is the link that is
// both easiest to get wrong and hardest to notice.
function loadTakeInstallerLanguage(stableDir, portableDir) {
  const start = mainText.indexOf('const INSTALLER_LANGUAGE_FILE');
  assert.notEqual(start, -1, 'INSTALLER_LANGUAGE_FILE must be declared in main.js');
  const fnStart = mainText.indexOf('function takeInstallerLanguage()', start);
  assert.notEqual(fnStart, -1);
  const fnEnd = mainText.indexOf('\n}', fnStart) + 2;
  const source = mainText.slice(start, fnEnd);
  const sandbox = {
    fs: require('node:fs'),
    path: require('node:path'),
    STABLE_USER_DATA_PATH: stableDir,
    PORTABLE_USER_DATA_PATH: portableDir,
    SUPPORTED_LOCALES: ['zh_cn', 'en_us', 'ja_jp', 'ru_ru'],
  };
  return require('node:vm').runInNewContext(`${source}\ntakeInstallerLanguage;`, sandbox);
}

test('the marker is consumed exactly once, whatever the app data root is', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mineradio-installer-lang-'));
  try {
    const userdata = path.join(root, 'userdata');
    fs.mkdirSync(userdata, { recursive: true });
    const marker = path.join(userdata, '.installer-language');
    fs.writeFileSync(marker, 'ru_ru\r\n');

    const takeInstallerLanguage = loadTakeInstallerLanguage(userdata, path.join(root, 'missing'));
    assert.equal(takeInstallerLanguage(), 'ru_ru');
    // 第二次必须读不到：标记已经删掉，否则每次启动都会被安装器的选择顶回旧语言。
    // The second call must come up empty, or every launch would snap back to the installer choice.
    assert.equal(fs.existsSync(marker), false);
    assert.equal(takeInstallerLanguage(), '');

    // 未知语言码直接丢弃，别把它当成有效偏好存下去。
    // Unknown codes are dropped rather than treated as a real preference.
    fs.writeFileSync(marker, 'klingon\n');
    assert.equal(takeInstallerLanguage(), '');

    // 便携目录不存在（只读安装目录兜底到用户配置目录）时也不能抛错。
    // A missing portable folder must not throw.
    assert.equal(takeInstallerLanguage(), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a write-protected app folder still finds the marker through the fallback root', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mineradio-installer-fallback-'));
  try {
    const portable = path.join(root, 'app-userdata');
    const stable = path.join(root, 'profile-mineradio');
    fs.mkdirSync(stable, { recursive: true });
    fs.writeFileSync(path.join(stable, '.installer-language'), 'ja_jp');
    const takeInstallerLanguage = loadTakeInstallerLanguage(stable, portable);
    assert.equal(takeInstallerLanguage(), 'ja_jp');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderer prefers the installer language over the system locale', () => {
  assert.match(
    i18nText,
    /if \(stored\) return Promise\.resolve\(normalizeLang\(stored\)\);[\s\S]{0,400}?readInstallerLang\(\)\.then\(function \(installerLang\) \{[\s\S]{0,120}?installerLang \|\| detectSystemLang\(\)/
  );
  // 没有桌面桥（浏览器预览、测试沙箱）时必须是「空串」而不是抛错，否则首启直接白屏。
  // Without the desktop bridge (browser preview, sandbox) this must resolve to "" not throw.
  assert.match(i18nText, /typeof bridge\.getInstallerLanguage !== 'function'/);
});

// --- 运行期行为：真的把模块求值一次，看它对首启语言的选择 -------------------------
// Runtime behaviour: evaluate the module for real and check which language it settles on.

function loadI18n({ installerLanguage, stored, navigatorLanguage }) {
  delete require.cache[require.resolve(I18N_PATH)];
  const moduleExports = require(I18N_PATH);
  moduleExports.navigator = { language: navigatorLanguage || 'en-US', languages: [navigatorLanguage || 'en-US'] };

  let bridgeCalls = 0;
  if (installerLanguage !== null && installerLanguage !== undefined) {
    moduleExports.desktopWindow = {
      getInstallerLanguage() {
        bridgeCalls += 1;
        return Promise.resolve(installerLanguage);
      },
    };
  }

  const storage = new Map();
  if (stored) storage.set('mineradio-lang', stored);
  global.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };

  // 词典走 XHR 懒加载；这里给一个空表，缺键回退链与语言选择逻辑都不受影响。
  // Dictionaries load over XHR; an empty table is enough for the language-selection logic.
  global.XMLHttpRequest = class {
    open() {}
    send() {
      this.status = 200;
      this.responseText = '{}';
      if (typeof this.onload === 'function') this.onload();
    }
  };
  // document 必须存在才让 scan() 跑得下去，但 readyState 停在 loading 避免自动 init。
  // document has to exist for scan(), while readyState 'loading' keeps auto-init out of the way.
  global.document = {
    readyState: 'loading',
    addEventListener() {},
    documentElement: {},
    querySelectorAll: () => [],
  };

  return {
    api: moduleExports.MineradioI18n,
    bridgeCalls: () => bridgeCalls,
  };
}

test('a fresh profile adopts the installer language instead of the system locale', async () => {
  const { api, bridgeCalls } = loadI18n({ installerLanguage: 'ru_ru', stored: null, navigatorLanguage: 'en-US' });
  const lang = await api.init();
  assert.equal(lang, 'ru_ru');
  assert.equal(api.getLanguage(), 'ru_ru');
  assert.equal(bridgeCalls(), 1);
});

test('an explicit in-app choice still wins over the installer marker', async () => {
  const { api, bridgeCalls } = loadI18n({ installerLanguage: 'ru_ru', stored: 'ja_jp', navigatorLanguage: 'en-US' });
  const lang = await api.init();
  assert.equal(lang, 'ja_jp');
  // 已经有选择时连问都不该问主进程：标记文件该由应用自己留着的那次启动消化掉。
  // With a stored choice the bridge is not even asked; that launch consumes the marker instead.
  assert.equal(bridgeCalls(), 0);
});

test('an unknown installer code falls back to the system locale', async () => {
  const { api } = loadI18n({ installerLanguage: 'klingon', stored: null, navigatorLanguage: 'ja-JP' });
  const lang = await api.init();
  assert.equal(lang, 'ja_jp');
});

test('a broken bridge never blocks the first launch', async () => {
  const { api } = loadI18n({ installerLanguage: null, stored: null, navigatorLanguage: 'en-GB' });
  const lang = await api.init();
  assert.equal(lang, 'en_us');
});

after(() => {
  delete global.localStorage;
  delete global.XMLHttpRequest;
  delete global.document;
});
