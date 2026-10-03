'use strict';

// Home 右侧滚动板块在 14 寸等小屏上退化的回归测试（#462 第 5 点）
//
// 症状：非全屏时右侧板块的滚轮只有最下面一行有效（15.6 寸正常、14 寸异常）。
// 根因：`#empty-home .home-grid.home-quick-grid .home-card { min-height: 158px }` 带 ID，特异性高于
// 后面 `@media (max-height:760px/700px)` 里的 `body.desktop-shell .home-card` 覆盖，于是可视高度变矮
// 时四张快速卡片并不跟着缩，吃掉约三分之二高度，行 2 的 `.home-insight-rail` 只剩一行可滚。
//
// Symptom: on small screens only the bottom row of the right-hand board scrolls. The ID-scoped
// quick-grid min-height outranks the later short-viewport overrides, so the four cards never shrink
// and the insight rail is squeezed to a single scrollable row.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '..', 'public', 'css', 'index.css');
const css = fs.readFileSync(cssPath, 'utf8');

function braceDepthAt(index) {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
  }
  return depth;
}

function mediaFor(index) {
  // The rule must sit exactly one level deeper than the `@media` prelude; a `@media` that has
  // already closed by this point in the sheet does not enclose it.
  const depth = braceDepthAt(index);
  if (depth === 0) return '';
  let cursor = css.lastIndexOf('@media', index);
  while (cursor >= 0) {
    if (braceDepthAt(cursor) === depth - 1) {
      return css.slice(cursor, css.indexOf('{', cursor)).trim();
    }
    cursor = css.lastIndexOf('@media', cursor - 1);
  }
  return '';
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+/g) || []).length
    + (selector.match(/\[[^\]]+\]/g) || []).length
    + (selector.match(/:(?!:)[\w-]+/g) || []).length;
  const withoutIdsAndClasses = selector
    .replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/::?[\w-]+(\([^)]*\))?/g, ' ')
    .replace(/[>+~*,]/g, ' ');
  const elements = withoutIdsAndClasses
    .split(/\s+/)
    .filter((token) => token && !/^body$|^html$/.test(token)).length;
  return [ids, classes, elements];
}
function outranks(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function rulesFor(selectorText) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    // A block's "prelude" starts right after the previous `}`, so it can still carry comments and
    // blank lines; strip them before comparing selectors.
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
    if (selector !== selectorText) continue;
    rules.push({
      selector: selectorText,
      declarations: match[2],
      start: match.index,
      media: mediaFor(match.index),
      specificity: specificity(selectorText),
    });
  }
  return rules;
}

const quickCardSelector = '#empty-home .home-grid.home-quick-grid .home-card';
const quickCardRules = rulesFor(quickCardSelector);
assert(quickCardRules.length >= 2, `expected a base rule and a short-viewport override, got ${quickCardRules.length}`);

const baseRule = quickCardRules.find((rule) => !rule.media);
assert(baseRule, 'the quick-grid card base rule is missing');
assert.match(baseRule.declarations, /min-height:\s*158px/, 'the base min-height must stay 158px on tall screens');

// 1. 短屏覆盖必须与基础规则同等或更高特异性，否则永远赢不了。
const shortOverrides = quickCardRules.filter((rule) => /max-height/.test(rule.media));
assert(shortOverrides.length >= 2, 'short-height overrides for the quick-grid cards are missing');
shortOverrides.forEach((rule) => {
  const wins = !outranks(baseRule.specificity, rule.specificity);
  assert(
    wins,
    `${rule.media} override is outranked by the base rule (${baseRule.specificity} vs ${rule.specificity}) and can never apply`
  );
  assert(
    rule.start > baseRule.start,
    `${rule.media} override must come after the base rule to win at equal specificity`
  );
});
shortOverrides.forEach((rule) => {
  const declared = Number((rule.declarations.match(/min-height:\s*(\d+)px/) || [])[1]);
  assert(
    Number.isFinite(declared) && declared < 158,
    `${rule.media} override must actually shrink the card, got min-height ${declared}`
  );
});

// 2. 400px 宽的旧式覆盖（body.desktop-shell .home-card）必须仍然明显弱于基础规则，
//    这条断言把"为什么需要 ID 级覆盖"钉在测试里，避免以后被误删。
const legacyOverride = css.match(/@media \(max-height:\s*760px\)\s*\{[\s\S]{0,400}?body\.desktop-shell \.home-card \{[\s\S]{0,80}?min-height:\s*\d+px/);
assert(legacyOverride, 'the legacy short-viewport home-card override is missing');
assert(
  outranks(baseRule.specificity, specificity('body.desktop-shell .home-card')),
  'the legacy override is expected to be outranked by the ID-scoped quick-grid rule'
);

// 3. 右下板块必须始终留有可滚动高度，并保持自身的滚动能力。
const shellRule = rulesFor('#empty-home .empty-home-shell').find((rule) => !rule.media);
assert(shellRule, 'the home shell rule is missing');
assert.match(shellRule.declarations, /grid-template-rows:\s*auto minmax\(0, 1fr\)/, 'the shell keeps the rail in row 2');
const shellOverrides = rulesFor('#empty-home .empty-home-shell').filter((rule) => /max-height/.test(rule.media));
const reservingOverrides = shellOverrides.filter((rule) => /grid-template-rows/.test(rule.declarations));
assert(
  reservingOverrides.length >= 1,
  'at least one short-viewport shell rule must reserve a minimum scrollable height for the rail'
);
reservingOverrides.forEach((rule) => {
  const reserved = Number((rule.declarations.match(/minmax\((\d+)px,\s*1fr\)/) || [])[1]);
  assert(
    Number.isFinite(reserved) && reserved >= 150,
    `${rule.media} must reserve at least 150px of scrollable rail, got ${reserved}`
  );
});

const railRule = rulesFor('#empty-home .home-insight-rail').find((rule) => !rule.media);
assert(railRule, 'the insight rail rule is missing');
assert.match(railRule.declarations, /overflow:\s*auto/, 'the rail must stay scrollable');
assert.match(railRule.declarations, /min-height:\s*0/, 'the rail must be allowed to shrink so it can scroll');
assert.match(railRule.declarations, /grid-row:\s*2/, 'the rail must stay in the lower right cell');

// 4. 小屏上四张卡片释放出来的高度不能又被别的规则吃掉。
assert.match(
  css,
  /@media \(max-height:\s*700px\)\s*\{[\s\S]{0,900}#empty-home \.home-grid\.home-quick-grid \.home-card-featured \{\s*min-height:\s*(1[01]\d)px/
);
assert.match(
  css,
  /@media \(max-height:\s*700px\)\s*\{[\s\S]{0,600}#empty-home \.home-grid\.home-quick-grid \{\s*grid-template-columns:/,
  'the narrow short-screen grid must also relax its column minimums'
);

console.log('home insight rail short-screen scroll: 12 checks passed');
