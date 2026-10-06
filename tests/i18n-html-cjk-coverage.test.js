'use strict';

// ============================================================
//  全量覆盖守卫 / Full-coverage guard
//  逐条列举的清单守不住新接线的键 —— 实测摘掉 data-i18n="fx_crop_horizontal"
//  之后 i18n-index-html-wiring 依然全绿，因为那个键从来没被写进它的 wired 表。
//  所以这里改成：扫 index.html 里**每一个**含 CJK 的显示点，没声明 i18n 就算失败，
//  只剩一份写死的豁免清单。
//  A hand-listed guard cannot cover newly wired keys — removing
//  data-i18n="fx_crop_horizontal" left i18n-index-html-wiring green because that
//  key was never in its list. So this scans every CJK display point instead and
//  fails on any that lacks an i18n declaration, modulo one explicit allowlist.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const CJK = /[一-鿿]/;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const I18N_ATTRS = ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-attr'];

// 故意不带 i18n 声明的显示点 / display points deliberately left without i18n
//  - 语言菜单里的语言自称（中文 / 日本語）：翻译语言自称没有意义
//    Language endonyms in the menu — translating a language's own name is pointless.
//  - 语言按钮的首字「中」：由 14-i18n-switcher.js 按当前语言动态写入
//    The switcher button's initial, written at runtime by 14-i18n-switcher.js.
// 登录彩蛋曾在这里占掉十一条豁免（拼字用字格、打字框、成就文案…）。彩蛋改成选择框并接入
// i18n 之后全部下架，剩下这三条都与彩蛋无关。
// The login easter egg used to own eleven exemptions here (the spelling cells, the typing
// field, the achievement copy). Turning it into a select box and wiring i18n retired all of
// them; the three left have nothing to do with the egg.
const EXEMPT = [
  ['text', '中'],
  ['text', '中文'],
  ['text', '日本語'],
];

// 页面里有大量十进制/十六进制字符引用（&#35009; 裁、&#x5730; 地），不解码的话
// CJK 判据对这些文本一律失效 —— 正是接线脚本当初漏掉 13 个 FX 标签的同一个坑。
// The page is full of numeric character references (&#35009; = 裁, &#x5730; = 地).
// Without decoding, the CJK test silently misses all of them — the same trap that
// made the wiring script skip 13 FX labels.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] || m);
}

// 标签结束位置：跳过属性值里的 '>'，否则 onclick="a > b" 会把标签截断。
// Tag end offset: skip '>' inside attribute values or onclick="a > b" truncates the tag.
function tagEnd(src, from) {
  let quote = null;
  for (let j = from + 1; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return j;
  }
  return src.length;
}

function parseAttrs(body) {
  const attrs = {};
  const re = /([A-Za-z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    attrs[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

function scanUnwired(source) {
  const out = [];
  const stack = [];
  let depth = 0;
  let i = 0;

  function collectText(chunk) {
    if (depth > 0) return;
    const text = decodeEntities(chunk).trim();
    if (text && CJK.test(text)) out.push(['text', text]);
  }

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) { collectText(source.slice(i)); break; }
    if (lt > i) collectText(source.slice(i, lt));
    const end = tagEnd(source, lt);
    const raw = source.slice(lt + 1, end);
    if (raw.startsWith('/')) {
      if (stack.length && stack.pop()) depth = Math.max(0, depth - 1);
    } else {
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const attrs = parseAttrs(body);
      const name = (body.match(/^[^\s/]+/) || [''])[0].toLowerCase();
      const hasI18n = I18N_ATTRS.some((k) => Object.prototype.hasOwnProperty.call(attrs, k));
      const redirected = (attrs['data-i18n-attr'] || '').split(',').map((s) => s.trim());
      for (const prop of ['title', 'aria-label', 'placeholder']) {
        const value = decodeEntities(attrs[prop] || '');
        if (!value || !CJK.test(value)) continue;
        if (prop === 'title' && 'data-i18n-title' in attrs) continue;
        if (prop === 'placeholder' && 'data-i18n-placeholder' in attrs) continue;
        if (redirected.includes(prop)) continue;
        out.push([prop, value]);
      }
      if (!VOID_TAGS.has(name) && !selfClosing) {
        stack.push(hasI18n);
        if (hasI18n) depth += 1;
      }
    }
    i = end + 1;
  }
  return out;
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter(([kind, value]) => {
    const k = kind + '\u0000' + value;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

test('index.html 里每个中文显示点都声明了 i18n', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const found = dedupe(scanUnwired(html)).filter(
    (row) => !EXEMPT.some((e) => e[0] === row[0] && e[1] === row[1])
  );
  assert.deepStrictEqual(found, [],
    '这些中文显示点没有 data-i18n 声明：\n' + found.map((r) => r[0] + ': ' + r[1]).join('\n'));
});

test('豁免清单里的每一项都还在页面上（清单不会悄悄变长）', () => {
  // 反向校验：豁免项如果已经从页面消失，说明清单过时了，会掩盖真正的漏接。
  // Reverse check: an exemption whose text is gone from the page is stale and would
  // keep hiding real gaps forever.
  const html = fs.readFileSync(INDEX_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const found = dedupe(scanUnwired(html));
  const stale = EXEMPT.filter((e) => !found.some((r) => r[0] === e[0] && r[1] === e[1]));
  assert.deepStrictEqual(stale, [],
    '这些豁免项在页面上已经找不到了，清单该删：' + JSON.stringify(stale));
});
