'use strict';

// index.html 的界面文案走 data-i18n 标注，i18n 引擎扫描这些属性来替换文本。
// 这条守卫钉住三件容易出错、又都被真实踩过的事：
//   1. 标注的键必须在四本词典里都存在 —— 拼错一个字母界面就会显示裸键名；
//   2. data-i18n 不能挂在含子元素的容器上 —— 引擎用 textContent 替换，
//      挂在容器上会把子元素整个销毁，JS 还在按 id 找的节点会从此消失；
//   3. 已经接线的键不能被改回裸中文。
// The HTML wiring hinges on three things that are easy to break and have all been
// broken before: keys must exist in every dictionary, data-i18n must not sit on a
// container with children (textContent replacement destroys them), and wired labels
// must not silently revert to bare Chinese.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'public', 'index.html');
const LOCALES = path.join(ROOT, 'public', 'locales');

// 空元素：没有闭合标签，也不该有子元素。
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function localeLangs() {
  // 语言列表从 i18n 模块推导，写死的话新加语言会悄悄逃过校验。
  const source = read(path.join(ROOT, 'public', 'js', 'modules', '00-state', '13-i18n.js'));
  const match = /var SUPPORTED_LANGS = \[([^\]]*)\]/.exec(source);
  if (!match) return [];
  return match[1].split(',').map(function (entry) {
    return entry.trim().replace(/^['"]|['"]$/g, '');
  }).filter(Boolean);
}

function dictionaries() {
  const out = {};
  localeLangs().forEach(function (lang) {
    out[lang] = JSON.parse(read(path.join(LOCALES, lang + '.json')));
  });
  return out;
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, function (block) {
    return block.replace(/[^\n]/g, ' ');
  });
}

// 抽出所有 data-i18n* 声明。
function declarations(html) {
  const out = [];
  const pattern = /data-i18n(-attr|-title|-placeholder)?="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const line = html.slice(0, match.index).split('\n').length;
    out.push({ variant: match[1] || '', value: match[2], line: line, index: match.index });
  }
  return out;
}

test('每个 data-i18n 标注的键都在全部词典里存在', () => {
  const html = stripComments(read(HTML));
  const dicts = dictionaries();
  const langs = Object.keys(dicts);
  assert.ok(langs.length >= 2, '没能解析出语言列表');

  const missing = [];
  declarations(html).forEach(function (item) {
    // data-i18n-attr 的值是「要填充哪些属性」，不是键，单独校验。
    if (item.variant === '-attr') return;
    item.value.split(',').forEach(function (key) {
      key = key.trim();
      if (!key || key === 'text' || key === 'html') return;
      langs.forEach(function (lang) {
        if (!(key in dicts[lang])) {
          missing.push('L' + item.line + ' ' + key + ' 缺于 ' + lang + '.json');
        }
      });
    });
  });
  assert.deepStrictEqual(missing, [], '标注了词典里没有的键:\n  ' + missing.join('\n  '));
});

test('data-i18n-attr 只声明受支持的属性', () => {
  const html = stripComments(read(HTML));
  // 引擎认得 text / html 两个特殊值，其余必须是真实存在的 HTML 属性名。
  const allowed = new Set([
    'text', 'html', 'title', 'aria-label', 'placeholder', 'alt', 'value',
  ]);
  const offenders = [];
  declarations(html).forEach(function (item) {
    if (item.variant !== '-attr') return;
    item.value.split(',').forEach(function (attr) {
      attr = attr.trim();
      if (attr && !allowed.has(attr)) {
        offenders.push('L' + item.line + ' ' + attr);
      }
    });
  });
  assert.deepStrictEqual(offenders, [], 'data-i18n-attr 声明了引擎不认识的属性:\n  ' + offenders.join('\n  '));
});

test('data-i18n 不挂在含子元素的容器上', () => {
  const html = stripComments(read(HTML));
  const tagPattern = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)>/g;
  const offenders = [];
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (attrs.indexOf('data-i18n=') < 0) continue;
    if (/data-i18n-attr=/.test(attrs)) continue;
    if (VOID_TAGS.has(tag)) continue;
    const close = html.indexOf('</' + tag, match.index + match[0].length);
    if (close < 0) continue;
    const inner = html.slice(match.index + match[0].length, close);
    if (/<[a-zA-Z]/.test(inner)) {
      offenders.push('L' + html.slice(0, match.index).split('\n').length + ' <' + tag + '>');
    }
  }
  // textContent 替换会把子元素整个删掉，JS 还按 id 引用的节点会消失。
  assert.deepStrictEqual(offenders, [],
    '这些 data-i18n 会把子元素抹掉（请下移到只包住文案的元素上）:\n  ' + offenders.join('\n  '));
});

test('已接线的界面文案没有再退回裸中文', () => {
  const html = stripComments(read(HTML));
  // 接线前写在元素里的裸中文；接线后它们必须作为 data-i18n 的默认文案出现。
  // 第三位是「这条文案落在哪种载体上」：'' 表示文本节点（data-i18n），
  // 'title' 表示 title 属性（data-i18n-title）。判据必须按载体分，否则
  // title 型文案会被误判成"退回裸中文"。
  //
  // '视觉控制台' / 'visual_console' 曾在此列，现已移除：控制台标题行连同副标题被删掉了
  // （面板内已有分类标签页，标题是重复信息），元素不存在就不该再登记映射。
  // 键本身仍留在词典里被别处使用，所以只是从这份接线清单撤下，不是删键。
  //
  // '视觉控制台' / 'visual_console' used to be listed here and was dropped when the console
  // title row was removed (the category tabs already convey the same information). With the
  // element gone there is nothing to wire, so the mapping leaves this list — the dictionary
  // key itself stays, it is used elsewhere.
  const wired = [
    ['每日推荐', 'home_daily'],
    ['歌词字体', 'lyric_font'],
    ['摄像头交互', 'camera_interaction'],
    ['手势触碰', 'camera_gesture'],
    ['高级参数', 'section_advanced'],
    ['画质档位', 'section_quality'],
    ['粒子尺寸', 'particle_size'],
    ['本地缓存', 'server_local_cache'],
    ['当前队列', 'tab_queue'],
    ['封面取色', 'cover_pick_color'],
    ['高亮取色', 'highlight_pick', 'title'],
    ['溢光取色', 'glow_pick', 'title'],
    ['色彩张力', 'color_tension'],
    ['溢光强度', 'bloom_intensity'],
    ['背景压缩', 'bg_compression'],
  ];
  const missing = wired
    .filter(function (pair) {
      const attr = pair[2] ? 'data-i18n-' + pair[2] : 'data-i18n';
      return html.indexOf(attr + '="' + pair[1] + '"') < 0;
    })
    .map(function (pair) { return pair[0] + ' -> ' + pair[1]; });
  assert.deepStrictEqual(missing, [], '这些文案又变回裸中文了: ' + missing.join(', '));
});
