'use strict';

// 「歌词样式 → 商籁」的回归守卫。
//
// 商籁是全屏海报式歌词 PV：确定性种子驱动镜头、四级字号、逐字入场、硬切转场。
// 它没有任何构建期依赖，一旦漏登记模块、漏白名单、漏语言包，表现都是「切了没反应」
// 而不是报错，所以接入面用静态断言钉住；时间轴与构图则用 vm 加载模块后直接跑纯函数，
// 验证确定性、seek-safe、安全区与歌词无损这些真正的语义。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readAllCss } = require('./helpers/css-source');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = read('public/index.html');
const LOADER = read('public/js/index-loader.js');
const MODULE = read('public/js/modules/02-visual/18-folia-sonnet-lyrics.js');
const SEGMENTER = read('public/js/modules/02-visual/17-cjk-word-segmenter.js');
const MODES = read('public/js/modules/02-visual/08-lyrics-display-modes.js');
const SAVE_READ = read('public/js/modules/00-state/05a-fx-save-read.js');
const DEFAULTS = read('public/js/modules/00-state/04-fx-defaults.js');
const ACTIONS = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const CONSOLE = read('public/js/modules/07-fx/09-console-workspace.js');
const CSS = readAllCss();

function loadPure() {
  const sandbox = {
    __MINERADIO_TEST__: true,
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById() { return null; },
      createElement() { return { style: {}, classList: { add() {}, contains() { return false; } } }; },
      body: { classList: { contains() { return false; } } }
    },
    requestAnimationFrame() {},
    addEventListener() {},
    performance: { now: () => 0 },
    fx: { lyricStyle: 'default' },
    lyricsLines: [],
    stageLyrics: { group: { visible: true }, palette: { primary: '#fff', highlight: '#fff', secondary: '#a9d4ff' } }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 真实加载顺序里分词器在商籁之前；没有它 splitWords 会退化成整行，
  // 商籁的分词/角色分级断言就没有意义了。沙箱不给 fetch，词典停在未就绪态，
  // 正好覆盖「Intl.Segmenter + 同一套 normalize」这条路径。
  vm.runInContext(SEGMENTER, sandbox, { filename: '17-cjk-word-segmenter.js' });
  vm.runInContext(MODULE, sandbox, { filename: '18-folia-sonnet-lyrics.js' });
  assert.ok(sandbox.__mineradioSonnetPure, '纯函数没有导出给测试');
  return sandbox.__mineradioSonnetPure;
}

const PURE = loadPure();

const LINES = [
  {
    t: 0.5, duration: 2.0, text: '晚风穿过城市灯火慢慢亮起',
    words: ['晚风', '穿过', '城市', '灯火', '慢慢', '亮起'].map((text, i) => ({
      text, t: 0.6 + i * 0.32, d: 0.32, c0: 0, c1: text.length
    }))
  },
  { t: 2.8, duration: 2.0, text: '第二行测试文字' },
  { t: 5.1, duration: 2.0, text: '第三行也在这里' },
  { t: 12.0, duration: 2.0, text: '副歌要更大声' },
  { t: 14.4, duration: 2.0, text: '最后一行收尾' }
];

test('商籁按钮、白名单与存档兼容都接上了', () => {
  assert.match(HTML, /data-style="sonnet"/);
  assert.match(HTML, /setLyricStyle\('sonnet'\)/);
  assert.match(HTML, /data-i18n="lyric_style_sonnet"/);
  assert.match(MODES, /style === 'classic' \|\| style === 'sonnet'/);
  assert.match(SAVE_READ, /style === 'classic' \|\| style === 'sonnet'/);
  assert.match(DEFAULTS, /lyricStyle:\s*'default'/);
  assert.match(ACTIONS, /function setLyricStyle\(/);
  assert.match(CONSOLE, /商籁/);
});

test('商籁模块登记在流光之后，且不引入新依赖或全局名', () => {
  assert.match(LOADER, /02-visual\/18-folia-sonnet-lyrics\.js/);
  assert.ok(LOADER.indexOf('02-visual/18-folia-sonnet-lyrics.js')
    > LOADER.indexOf('02-visual/16-folia-classic-lyrics.js'));
  assert.match(MODULE, /\(function \(\) \{\s*'use strict';/);
  assert.match(MODULE, /'use strict';/);
  assert.doesNotMatch(MODULE, /require\(|import\s|export\s/);
  assert.doesNotMatch(MODULE, /Math\.random/);
  assert.match(MODULE, /requestAnimationFrame\(frame\)/);
  assert.match(MODULE, /getAdjustedLyricPlaybackTime/);
  assert.match(MODULE, /stageLyrics\.group/);
  assert.match(MODULE, /window\.__mineradioSonnetTick/);
});

test('7 种语言都有商籁文案', () => {
  const locales = ['zh_cn', 'zh_tw', 'zh_hk', 'en_us', 'ja_jp', 'ru_ru', 'es_es'];
  for (const locale of locales) {
    const dict = JSON.parse(read(`public/locales/${locale}.json`));
    for (const key of ['lyric_style_section', 'lyric_style_default', 'lyric_style_classic', 'lyric_style_sonnet']) {
      assert.ok(typeof dict[key] === 'string' && dict[key].length > 0, `${locale} 缺 ${key}`);
    }
  }
});

test('商籁 CSS 覆盖层、四级字号、角标与 reduced-motion 策略齐全', () => {
  assert.match(CSS, /#folia-sonnet-lyrics/);
  assert.match(CSS, /#folia-sonnet-lyrics\.show/);
  assert.match(CSS, /\.fs-word\[data-role="hero"\]/);
  assert.match(CSS, /\.fs-word\[data-role="semi-hero"\]/);
  assert.match(CSS, /\.fs-word\[data-role="support"\]/);
  assert.match(CSS, /\.fs-word\[data-role="decoration"\]/);
  assert.match(CSS, /-webkit-text-stroke/);
  assert.match(CSS, /\.fs-corner-tl/);
  assert.match(CSS, /\.fs-corner-br/);
  assert.match(CSS, /writing-mode: vertical-rl/);
  assert.match(CSS, /var\(--fs-glitch\)/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  // 本机 reduce 恒真：商籁不能靠 CSS 循环动画表达关键状态。
  assert.doesNotMatch(CSS, /#folia-sonnet-lyrics[^{]*\{[^}]*animation:\s*[^;]*infinite/);
});

test('时间轴编译是确定性的，且不重叠、覆盖整首歌', () => {
  const a = PURE.compileProgram(LINES, 0.71);
  const b = PURE.compileProgram(LINES, 0.71);
  assert.deepStrictEqual(a, b, '同一首歌两次编译必须完全一致');
  assert.ok(a.shots.length >= 2, '至少应切出两个镜头');
  for (let i = 0; i < a.shots.length; i++) {
    const shot = a.shots[i];
    assert.ok(shot.end > shot.start, `镜头 ${i} 时间窗非法`);
    assert.ok(shot.units.length > 0, `镜头 ${i} 没有文字`);
    assert.ok(PURE.SHOT_KINDS.includes(shot.kind));
    assert.ok(PURE.TRANSITIONS.includes(shot.transition));
    if (i > 0) {
      assert.ok(shot.start >= a.shots[i - 1].end - 0.001, `镜头 ${i} 与上一镜头重叠`);
      assert.notStrictEqual(shot.kind, a.shots[i - 1].kind, '相邻镜头不能重复同一种构图');
    }
  }
});

test('段落不超过 4 行，且分词拼回原文无损', () => {
  const program = PURE.compileProgram(LINES, 0.71);
  for (const shot of program.shots) {
    const lineNumbers = new Set(shot.units.filter((u) => !u.static).map((u) => u.line));
    assert.ok(lineNumbers.size <= 4, '一个镜头最多 4 行');
    for (const unit of shot.units) {
      assert.ok(unit.text.length > 0, '不能出现空词');
      assert.ok(unit.glyphs.length > 0, '每个词必须有逐字窗口');
      const joined = unit.glyphs.map((g) => g.text).join('');
      assert.strictEqual(joined, unit.text, '逐字窗口拼不回词文本');
    }
  }
});

test('所有构图坐标都落在安全区内', () => {
  const [minX, maxX, minY, maxY] = PURE.SAFE;
  for (const kind of PURE.SHOT_KINDS) {
    const program = PURE.compileProgram(LINES, 0.33);
    for (const shot of program.shots) {
      const units = shot.units.map((u) => Object.assign({}, u));
      PURE.layoutUnits(units, kind, 7.13, 1920, 1080);
      for (const unit of units) {
        assert.ok(unit.x >= minX - 0.001 && unit.x <= maxX + 0.001, `${kind} x 越界: ${unit.x}`);
        assert.ok(unit.y >= minY - 0.001 && unit.y <= maxY + 0.001, `${kind} y 越界: ${unit.y}`);
        assert.ok(unit.fontScale > 0, `${kind} 字号倍数非法`);
      }
    }
  }
});

// 版面必须「先量后排」：旧实现按视口比例等分槽位，跟字宽无关，一个大字必然压住邻居。
// 这条测试用与渲染层同一套 measureUnit 估算盒，两两检查包围盒不相交。
function layoutBoxes(units, kind, width, height, seed) {
  const copy = units.map((u) => Object.assign({}, u, {
    glyphs: (u.glyphs || []).map((g) => Object.assign({}, g))
  }));
  PURE.layoutUnits(copy, kind, seed || 7.13, width, height);
  return copy.filter((u) => u.role !== 'decoration').map((u) => {
    const box = PURE.measureUnit(u, width);
    return { text: u.text, cx: u.x * width, cy: u.y * height, w: box.w, h: box.h };
  });
}

function assertNoOverlap(boxes, label, tol) {
  const slack = tol == null ? 2 : tol;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
      const oy = Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
      assert.ok(ox <= slack || oy <= slack,
        `${label}: 「${a.text}」与「${b.text}」重叠 (${ox.toFixed(1)}×${oy.toFixed(1)}px)`);
    }
  }
}

test('版面不重叠：任意两个歌词词盒都不相交', () => {
  const W = 1920;
  const H = 1080;
  const dense = [
    { t: 0.5, duration: 2.2, text: '月光落在旧唱片的划痕上又慢慢散开' },
    { t: 3.0, duration: 2.0, text: '我们把没说完的话留在了副歌里' },
    { t: 5.4, duration: 1.8, text: '城市在身后缩小成一颗亮点' },
    { t: 7.6, duration: 1.8, text: '再大声一点' }
  ];
  const perChar = ['第', '二', '行', '测', '试', '文', '字', '在', '这']
    .map((ch, i) => ({ t: 0.5 + i * 0.4, duration: 0.4, text: ch }));
  const cases = [
    { name: '常规分词', lines: LINES },
    { name: '长句四行', lines: dense },
    { name: '单字断句', lines: perChar }
  ];
  for (const kind of PURE.SHOT_KINDS) {
    for (const item of cases) {
      const program = PURE.compileProgram(item.lines, 0.41);
      for (let i = 0; i < program.shots.length; i += 1) {
        const label = `${kind} / ${item.name} / 镜头 ${i}`;
        assertNoOverlap(layoutBoxes(program.shots[i].units, kind, W, H), label);
      }
    }
  }
});

test('版面放不下时整体等比缩小，而不是把词压到一起', () => {  const W = 1280;
  const H = 720;
  // 一行 16 个双字词：1280 宽放不下原尺寸，必须整体缩小且仍不重叠。
  const long = [{ t: 0.4, duration: 6, text: '一二三四五六七八九十一二三四五六七八九十' }];
  const program = PURE.compileProgram(long, 0.5);
  for (const kind of PURE.SHOT_KINDS) {
    const boxes = layoutBoxes(program.shots[0].units, kind, W, H);
    assertNoOverlap(boxes, `${kind} / 超长行`);
    for (const box of boxes) {
      assert.ok(box.cx - box.w / 2 >= PURE.SAFE[0] * W - 1, '缩小后仍越出左边界');
      assert.ok(box.cx + box.w / 2 <= PURE.SAFE[1] * W + 1, '缩小后仍越出右边界');
    }
  }
});

test('窗口尺寸变化会重排版面（否则尺寸一变形距被压扁重新叠字）', () => {
  const at = MODULE.indexOf("addEventListener('resize'");
  assert.ok(at > 0, '找不到 resize 监听');
  const handler = MODULE.slice(at, at + 700);
  assert.match(handler, /programKey = ''/, 'resize 时必须让版面重新编译，不能只重置镜头索引');
  assert.match(MODULE, /layoutW = viewW;/, '编译时必须记录排版所用的视口尺寸');
  assert.match(MODULE, /layoutH = viewH;/);
});

test('角色分级包含 hero、support 与空心 decoration 副本', () => {
  const program = PURE.compileProgram(LINES, 0.71);
  for (const shot of program.shots) {
    const roles = shot.units.map((u) => u.role);
    assert.ok(roles.includes('hero'), '每个镜头都要有 hero');
    assert.ok(roles.includes('support'), '每个镜头都要有 support');
    assert.ok(roles.includes('decoration'), '每个镜头都要有空心装饰字');
    const deco = shot.units.find((u) => u.role === 'decoration');
    assert.strictEqual(deco.static, true, '装饰字不参与逐字入场');
  }
});

test('逐字时间轴：YRC 用真实窗口，LRC 按权重均分且严格递增', () => {
  const yrc = PURE.buildUnits(LINES[0], LINES[1]);
  assert.strictEqual(yrc.length, 6);
  assert.ok(Math.abs(yrc[0].start - 0.6) < 0.001, 'YRC 起点应来自 words[].t');
  assert.ok(Math.abs(yrc[5].end - (0.6 + 5 * 0.32 + 0.32)) < 0.001, 'YRC 终点应来自最后一个词');
  const lrc = PURE.buildUnits({ t: 1, duration: 3, text: '晚风穿过城市灯火' }, null);
  assert.ok(lrc.length > 0);
  for (let i = 1; i < lrc.length; i++) {
    assert.ok(lrc[i].start >= lrc[i - 1].start - 0.001, 'LRC 词窗口必须单调');
  }
  assert.ok(lrc[lrc.length - 1].end <= 4.01, 'LRC 不能超出行时长');
});

test('seek-safe：同一时刻的镜头查找、相机与转场姿态恒定', () => {
  const program = PURE.compileProgram(LINES, 0.71);
  const now = 3.2;
  const idx = PURE.findShotIndex(program.shots, now);
  assert.ok(idx >= 0, '测试时刻必须落在某个镜头内');
  const shot = program.shots[idx];
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(PURE.findShotIndex(program.shots, now), idx);
    assert.strictEqual(PURE.cameraFrame(shot, now, 1920, 1080), PURE.cameraFrame(shot, now, 1920, 1080));
    assert.deepStrictEqual(PURE.transitionFrame(shot, now), PURE.transitionFrame(shot, now));
  }
  const middle = (shot.start + shot.end) / 2;
  if (middle - shot.start > 0.3 && shot.end - middle > 0.3) {
    assert.strictEqual(PURE.transitionFrame(shot, middle).amount, 0, '镜头中段不该有转场');
  }
  assert.ok(PURE.transitionFrame(shot, shot.start + 0.01).amount > 0.8, '镜头起始应是转场峰值');
  assert.ok(PURE.transitionFrame(shot, shot.end - 0.01).amount > 0.8, '镜头结尾应是转场峰值');
  assert.ok(PURE.cameraFrame(shot, now, 1920, 1080).includes('scale('), '相机必须有推拉');
});

test('逐字焦点时间表覆盖所有真实字，且不含空心装饰字', () => {
  const program = PURE.compileProgram(LINES, 0.71);
  for (const shot of program.shots) {
    const tracking = PURE.buildTracking(shot, 1920, 1080);
    const expected = shot.units
      .filter((u) => !u.static && u.role !== 'decoration')
      .reduce((n, u) => n + u.glyphs.length, 0);
    assert.strictEqual(tracking.count, expected, '相机必须为每个 grapheme 建焦点');
    assert.ok(tracking.segments.length >= 1, '每个镜头至少有一行焦点时间表');
    for (const seg of tracking.segments) {
      for (let i = 1; i < seg.glyphs.length; i++) {
        assert.ok(seg.glyphs[i].start >= seg.glyphs[i - 1].start - 0.001, '焦点时间必须单调');
      }
      for (const g of seg.glyphs) {
        assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y), '焦点坐标必须是有限值');
      }
    }
    assert.ok(Number.isFinite(tracking.basePivot.x) && Number.isFinite(tracking.basePivot.y), 'hero 锚点非法');
  }
});

test('相机跟随歌词：焦点随逐字时间移动，seek 后姿态完全一致', () => {
  const program = PURE.compileProgram(LINES, 0.71);
  const shot = program.shots[0];
  const tracking = PURE.buildTracking(shot, 1920, 1080);
  const a = PURE.resolveCameraFocus(shot, 1.0, tracking);
  const b = PURE.resolveCameraFocus(shot, 2.0, tracking);
  const moved = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  assert.ok(moved > 10, `相机没有跟着歌词走（焦点位移仅 ${moved.toFixed(1)}px）`);
  assert.deepStrictEqual(PURE.resolveCameraFocus(shot, 1.0, tracking), a, '焦点不是 f(now) 纯函数（seek 花屏）');
  const camA = PURE.cameraFrame(shot, 1.0, 1920, 1080, a);
  const camB = PURE.cameraFrame(shot, 2.0, 1920, 1080, b);
  assert.notStrictEqual(camA, camB, '相机 transform 没有随焦点变化');
  assert.ok(camA.includes('translate3d(-'), '相机必须把焦点 pivot 写进 transform');
  assert.ok(/scale\(1\.[2-9]/.test(camA), '镜头必须放大，否则看不出视角在版面上游走');
  assert.deepStrictEqual(
    PURE.resolveCameraFocus(shot, shot.start - 5, tracking),
    PURE.resolveCameraFocus(shot, shot.start, tracking),
    '镜头开始前焦点必须钳在起始锚点'
  );
});

test('CSS 的相机原点必须是 0 0，否则 pivot 会被额外平移', () => {
  const block = CSS.match(/\.fs-camera\s*\{[^}]*\}/);
  assert.ok(block, '找不到 .fs-camera 样式块');
  assert.match(block[0], /transform-origin:\s*0 0\s*;/, '相机 transform-origin 必须是 0 0');
});

// ── 以下三条针对真机反馈：「单字断句一个字飞很远 / 一句来回飞 / 视角抖动」 ──────
// 每行只有一个字的卡拉 OK 式逐字歌词。
const PER_CHAR_LINES = [];
'晚风穿过城市灯火'.split('').forEach((ch, i) => {
  PER_CHAR_LINES.push({ t: 0.6 + i * 0.32, duration: 0.32, text: ch, source: 'yrc-char' });
});
'第二行收尾'.split('').forEach((ch, i) => {
  PER_CHAR_LINES.push({ t: 4.0 + i * 0.32, duration: 0.32, text: ch, source: 'yrc-char' });
});

test('单字断句并回同一句，不被 4 行上限切成多个硬切镜头', () => {
  const prog = PURE.compileProgram(PER_CHAR_LINES, 0.71);
  assert.strictEqual(prog.shots.length, 1, '连续单字行不该被切成多个镜头');
  const shot = prog.shots[0];
  const lineNumbers = new Set(shot.units.filter((u) => !u.static).map((u) => u.line));
  assert.strictEqual(lineNumbers.size, 2, '8 个单字 + 5 个单字应合并成 2 句');
  const body = shot.units.filter((u) => !u.static && u.role !== 'decoration');
  assert.strictEqual(body.length, 13, '每个单字都应成为独立词段');

  // 同句内的坐标必须按时间顺序单向排布，而不是按字号角色撒到版面四角。
  for (const lineNo of lineNumbers) {
    const units = shot.units
      .filter((u) => !u.static && u.role !== 'decoration' && u.line === lineNo)
      .sort((a, b) => a.start - b.start);
    let direction = 0;
    for (let i = 1; i < units.length; i += 1) {
      const delta = units[i].x - units[i - 1].x;
      if (Math.abs(delta) < 1e-6) continue;
      const sign = Math.sign(delta);
      if (!direction) direction = sign;
      assert.strictEqual(sign, direction, `第 ${lineNo} 句的字没有按时间顺序单向排布`);
    }
  }
});

test('相机轨迹：锚点是词段、同句不飞远、不来回、逐帧不抖', () => {
  const prog = PURE.compileProgram(PER_CHAR_LINES, 0.71);
  const shot = prog.shots[0];
  const tracking = PURE.buildTracking(shot, 1920, 1080);
  const body = shot.units.filter((u) => !u.static && u.role !== 'decoration');
  // 上游 trackSegments = semantic segment（≈词），不是整行。
  assert.strictEqual(tracking.segments.length, body.length, '焦点锚点必须是词段而不是整行');
  for (const seg of tracking.segments) {
    if (seg.glyphs.length === 1) {
      assert.strictEqual(seg.centerX, seg.glyphs[0].x, '单字词的段中心必须是它自己');
      assert.strictEqual(seg.centerY, seg.glyphs[0].y, '单字词的段中心必须是它自己');
    }
  }

  const byLine = {};
  body.forEach((u) => { (byLine[u.line] = byLine[u.line] || []).push(u); });
  for (const key of Object.keys(byLine)) {
    const units = byLine[key];
    const t0 = Math.min(...units.map((u) => u.glyphs[0].start));
    const t1 = Math.max(...units.map((u) => u.glyphs[u.glyphs.length - 1].start));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let prev = null, prevV = null, reversals = 0, maxStep = 0, maxJerk = 0;
    for (let t = t0; t <= t1; t += 1 / 60) {
      const f = PURE.resolveCameraFocus(shot, t, tracking);
      minX = Math.min(minX, f.x); maxX = Math.max(maxX, f.x);
      minY = Math.min(minY, f.y); maxY = Math.max(maxY, f.y);
      if (prev) {
        const dx = f.x - prev.x, dy = f.y - prev.y, d = Math.hypot(dx, dy);
        const v = { x: dx * 60, y: dy * 60, s: d * 60 };
        maxStep = Math.max(maxStep, d);
        if (prevV) {
          if (v.x * prevV.x + v.y * prevV.y < 0 && v.s > 30 && prevV.s > 30) reversals += 1;
          maxJerk = Math.max(maxJerk, Math.hypot(v.x - prevV.x, v.y - prevV.y));
        }
        prevV = v;
      }
      prev = f;
    }
    const span = `${(maxX - minX).toFixed(0)}x${(maxY - minY).toFixed(0)}px`;
    assert.ok(maxX - minX < 260 && maxY - minY < 120, `第 ${key} 句焦点移动过远: ${span}`);
    assert.ok(reversals <= 1, `第 ${key} 句内镜头方向反复 ${reversals} 次`);
    assert.ok(maxStep < 8, `第 ${key} 句逐帧跳变过大: ${maxStep.toFixed(2)}px/frame`);
    assert.ok(maxJerk < 40, `第 ${key} 句逐帧 jerk 过大: ${maxJerk.toFixed(1)}`);
    // 轨迹前半段不能是死区：线性等比收敛，前 1/3 必须有可感知的跟读。
    const early = PURE.resolveCameraFocus(shot, t0, tracking);
    const third = PURE.resolveCameraFocus(shot, t0 + (t1 - t0) / 3, tracking);
    assert.ok(Math.abs(third.x - early.x) + Math.abs(third.y - early.y) > 8,
      '镜头前段被压成静止（饱和限幅的死区）');
  }
  // 单字断句同样必须 seek-safe。
  const a = PURE.resolveCameraFocus(shot, 1.4, tracking);
  PURE.resolveCameraFocus(shot, 4.6, tracking);
  assert.deepStrictEqual(PURE.resolveCameraFocus(shot, 1.4, tracking), a);
});

test('唱词期间没有常驻呼吸、缩放或旋转扰动', () => {
  const prog = PURE.compileProgram(LINES, 0.71);
  const shot = prog.shots[0];
  const tracking = PURE.buildTracking(shot, 1920, 1080);
  const focus = PURE.resolveCameraFocus(shot, 1.0, tracking);
  const parse = (s) => {
    const t = /translate3d\(([-\d.]+)px,([-\d.]+)px/.exec(s);
    const sc = /scale\(([-\d.]+)\)/.exec(s);
    const ro = /rotate\(([-\d.]+)deg\)/.exec(s);
    return { x: +t[1], y: +t[2], scale: +sc[1], rotate: +ro[1] };
  };
  assert.ok(shot.revealDoneTime > 1.0, '测试时刻必须落在整句 reveal 完成之前');
  const a = parse(PURE.cameraFrame(shot, 1.0, 1920, 1080, focus));
  const b = parse(PURE.cameraFrame(shot, 1.001, 1920, 1080, focus));
  assert.ok(Math.abs(b.x - a.x) < 0.2, '唱词期间 x 有常驻正弦扰动');
  assert.ok(Math.abs(b.y - a.y) < 0.2, '唱词期间 y 有常驻正弦扰动');
  assert.ok(Math.abs(b.scale - a.scale) < 1e-6, 'zoom 不应随播放进度连续变化');
  assert.ok(Math.abs(b.rotate - a.rotate) < 1e-6, 'rotation 不应有常驻正弦');
  assert.match(MODULE, /BREATH_RAMP/);
  assert.match(MODULE, /revealDoneTime/);
});
