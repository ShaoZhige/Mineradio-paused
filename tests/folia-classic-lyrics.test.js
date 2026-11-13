'use strict';
const { readAllCss } = require('./helpers/css-source');

// 「歌词样式 → 流光」的静态回归守卫。
//
// 流光样式是独立实现的 DOM 覆盖层：它按 line.words 的逐字时间轴推进，渲染时把
// WebGL 歌词组隐藏掉，避免两层文字叠在一起。设置入口、持久化、模块加载和样式
// 任何一环掉了，用户看到的都是「切了没反应」而不是报错，所以这里把它们钉住。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = read('public/index.html');
const LOADER = read('public/js/index-loader.js');
const MODULE = read('public/js/modules/02-visual/16-folia-classic-lyrics.js');
const CSS = readAllCss();
const DEFAULTS = read('public/js/modules/00-state/04-fx-defaults.js');
const SAVE_READ = read('public/js/modules/00-state/05a-fx-save-read.js');
const PERSISTENCE = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
const ACTIONS = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const PANEL = read('public/js/modules/07-fx/05-fx-panel-performance.js');
const CONSOLE = read('public/js/modules/07-fx/09-console-workspace.js');

test('歌词样式分段控件存在，且排在歌词动画之后', () => {
  assert.match(HTML, /id="lyric-style-seg"/);
  assert.match(HTML, /data-style="default"/);
  assert.match(HTML, /data-style="classic"/);
  assert.match(HTML, /setLyricStyle\('classic'\)/);
  assert.ok(HTML.indexOf('id="lyric-style-seg"') > HTML.indexOf('id="lyric-motion-seg"'));
});

test('流光模块在歌词渲染模块之后加载', () => {
  assert.match(LOADER, /02-visual\/16-folia-classic-lyrics\.js/);
  assert.ok(
    LOADER.indexOf('02-visual/16-folia-classic-lyrics.js')
      > LOADER.indexOf('02-visual/15-ripples-cover-depth.js')
  );
});

test('流光模块按逐字时间轴推进，并隐藏 WebGL 歌词组', () => {
  assert.match(MODULE, /line\.words/);
  assert.match(MODULE, /w\.t/);
  assert.match(MODULE, /getAdjustedLyricPlaybackTime/);
  assert.match(MODULE, /stageLyricIndexForSeconds/);
  assert.match(MODULE, /stageLyrics\.group/);
  assert.match(MODULE, /group\.visible\s*=\s*false/);
  assert.match(MODULE, /group\.visible\s*=\s*true/);
  assert.match(MODULE, /empty-home-active/);
  assert.match(MODULE, /.folia-classic-word/);
  assert.match(MODULE, /--w-rot/);
});

test('没有逐词时间轴时按 Folia 的逐字权重铺开，再聚合到词', () => {
  assert.match(MODULE, /function segmentFallbackWords/);
  // 分词实现只有一份（17-cjk-word-segmenter），流光只委托，不再自己跑 Segmenter。
  // 商籁调的是同一个入口，两个样式才会把同一行歌词断在同一处。
  assert.match(MODULE, /cjkWordSegmenter\.splitWords\(text\)/);
  assert.doesNotMatch(MODULE, /new Intl\.Segmenter\(/);
  assert.match(MODULE, /function spreadUnits/);
  assert.match(MODULE, /sub\.weight \* perWeight/);
  assert.match(MODULE, /Math\.max\(rawDuration, 0\.05\)/);
  assert.match(MODULE, /reading \+ 2/);
  assert.match(MODULE, /function buildWords\(line, nextLine\)/);
  assert.match(MODULE, /buildWords\(line, nextLine\)/);
  assert.match(MODULE, /maxStart - minStart < 0\.05/);
});

test('流光每个词有持续的随机浮动动画', () => {
  assert.match(MODULE, /--bob-x/);
  assert.match(MODULE, /--bob-dur/);
  assert.match(CSS, /@keyframes folia-classic-bob/);
  assert.match(CSS, /animation: folia-classic-bob/);
  // 减少动态效果只停环境性的漂浮/呼吸；歌词入场、退场与逐词过渡是流光本体的反馈，必须保留。
  assert.match(CSS, /\.folia-classic-float,\s*\.folia-classic-body \{ animation: none \}/);
  assert.doesNotMatch(CSS, /\.folia-classic-line\.is-in \{ animation: none \}/);
  assert.doesNotMatch(CSS, /\.folia-classic-line\.is-out \{ animation: none \}/);
  assert.doesNotMatch(CSS, /\.folia-classic-word \{ transition: none \}/);
});

test('歌词样式分段控件登记进 DIY 视野控制台', () => {
  assert.match(CONSOLE, /fxConsoleItem\('lyric-style-seg'/);
  assert.match(CONSOLE, /lyric_style_section/);
});

test('流光设置能保存、读回并带进设置持久化 payload', () => {
  assert.match(DEFAULTS, /lyricStyle:\s*'default'/);
  assert.match(SAVE_READ, /function normalizeSavedLyricStyle/);
  assert.match(SAVE_READ, /lyricStyle:\s*normalizeSavedLyricStyle/);
  assert.match(PERSISTENCE, /lyricStyle:\s*\['lyricStyle'\]/);
  assert.match(ACTIONS, /function setLyricStyle\(/);
  assert.match(PANEL, /updateLyricStyleControls\(\)/);
});

test('流光跟随歌词调色盘的墨色、高亮与辉光', () => {
  assert.match(MODULE, /stageLyrics.palette/);
  assert.match(MODULE, /--folia-ink/);
  assert.match(MODULE, /--folia-hi/);
  assert.match(MODULE, /--folia-glow/);
  assert.match(CSS, /var\(--folia-ink/);
  assert.match(CSS, /var\(--folia-hi/);
  assert.match(CSS, /var\(--folia-glow/);
});

test('流光溢光跟随 DIY 开关、强度、颜色与鼓点', () => {
  assert.match(MODULE, /fx.lyricGlow === false/);
  assert.match(MODULE, /fx.lyricGlowStrength/);
  assert.match(MODULE, /fx.lyricGlowLinked/);
  assert.match(MODULE, /fx.lyricGlowColor/);
  assert.match(MODULE, /fx.lyricGlowBeat/);
  assert.match(MODULE, /stageLyrics.beatGlow/);
  assert.match(MODULE, /function hexRgb/);
  assert.match(MODULE, /--folia-glow-rgb/);
  assert.match(MODULE, /--folia-glow-level/);
  assert.match(CSS, /rgba\(var\(--folia-glow-rgb/);
  assert.match(CSS, /var\(--folia-glow-level/);
});

test('流光 CSS 的层次与状态齐全', () => {
  assert.match(CSS, /#folia-classic-lyrics/);
  assert.match(CSS, /\.folia-classic-word\.is-active/);
  assert.match(CSS, /\.folia-classic-word\.is-passed/);
  assert.match(CSS, /\.folia-classic-word\.is-waiting/);
});

test('7 种语言的歌词样式文案齐全', () => {
  const locales = ['zh_cn', 'zh_tw', 'zh_hk', 'en_us', 'ja_jp', 'ru_ru', 'es_es'];
  for (const locale of locales) {
    const dict = JSON.parse(read(`public/locales/${locale}.json`));
    for (const key of ['lyric_style_section', 'lyric_style_default', 'lyric_style_classic']) {
      assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `${locale} 缺 ${key}`);
    }
  }
});

test('流光跟随歌词动画、位置、角度、大小与字距设置', () => {
  assert.match(MODULE, /root\.dataset\.motion\s*=\s*motion/);
  assert.match(MODULE, /lyricMotionStyle/);
  assert.match(MODULE, /lyricOffsetX/);
  assert.match(MODULE, /lyricOffsetY/);
  assert.match(MODULE, /lyricTiltX/);
  assert.match(MODULE, /lyricTiltY/);
  assert.match(MODULE, /lyricScale/);
  assert.match(MODULE, /lyricLetterSpacing/);
  assert.match(MODULE, /perspective\(1200px\)/);
  assert.match(CSS, /\[data-motion="smooth"\]/);
  assert.match(CSS, /\[data-motion="glass"\]/);
  assert.match(CSS, /\[data-motion="shine"\]/);
  assert.match(CSS, /\[data-motion="glitch"\]/);
  assert.match(CSS, /--folia-soft/);
});

test('流光按 Folia 的逐词时序：行内线性铺开、预读与短行模式', () => {
  assert.ok(MODULE.includes("revealMode = rawDuration < 0.10 ? 'instant' : rawDuration < 0.18 ? 'fast' : 'normal'"));
  assert.ok(MODULE.includes('lineTiming.lookahead'));
  assert.ok(MODULE.includes('lineTiming.renderEnd'));
  assert.ok(MODULE.includes('now < t.start - lineTiming.lookahead'));
  assert.ok(MODULE.includes('t.start + 0.12'));
  assert.ok(MODULE.includes('lineNode.style.animationDuration'));
  assert.match(CSS, /\.folia-classic-line\.is-instant/);
});
