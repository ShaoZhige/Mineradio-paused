// 商籁（Sonnet）歌词样式 —— 参考 Folia 重写为 Mineradio 实现。
//
// 来源：chthollyphile/folia-major（AGPL-3.0）。上游的 sonnet 是 PixiJS 驱动的
// 日式 MG 歌词 PV：整段歌词按杂志海报式构图铺满全屏、四级字号、逐字带物理感
// 入场、镜头按种子切换、段落之间硬切转场。这里复刻它的视觉语言、镜头模型与
// 时序参数，用纯 DOM 文字层 + 一层 Canvas2D 线稿实现，不引入 Pixi / WebGL /
// 打包器，也不含任何上游源码原文、着色器或资源文件。
//
// 授权：本文件按 AGPL-3.0 提供（见 NOTICE.md 与 docs/THIRD_PARTY_PORTS.md）；
// Mineradio 其余部分仍为 GPL-3.0，依 GPL-3.0 第 13 条与本文件组合分发。
//
// 两条硬约束（和上游一致，也是「拖进度条不花屏」的关键）：
//   1. 所有随机都由 hash(seed + 索引 + 用途) 派生，绝不调用运行时随机数生成器；
//   2. 每一帧的姿态都是 f(now) 的纯函数，不累积状态，因此天然 seek-safe。
(function () {
  'use strict';

  var STYLE_ID = 'sonnet';
  var ROOT_ID = 'folia-sonnet-lyrics';
  var SHOT_KINDS = ['editorial-column', 'type-impact', 'quiet-tableau', 'poster-blocks'];
  var TRANSITIONS = ['fast-blur', 'mono-glitch', 'camera-pull'];
  var MAX_LINES_PER_SHOT = 4;
  var MAX_UNITS_PER_SHOT = 48;
  // 版面比视口略紧凑：相机放大 1.2~1.45 倍后，边缘的字才不会被整片推出画面。
  var SAFE_MIN_X = 0.16;
  var SAFE_MAX_X = 0.84;
  var SAFE_MIN_Y = 0.16;
  // 下沿留出底部播放控制条：相机会把版面下沿推下来，静态安全区要收得比视口更紧。
  var SAFE_MAX_Y = 0.76;
  var GLYPH_SETTLE = 0.68;
  var MG_INTERVAL = 50;

  // ── 相机跟随 ──────────────────────────────────────────────────────────────
  // 上游的「视角跟着歌词动」不是整屏平移：每个镜头容器的 pivot 被「当前唱到的字」
  // 的坐标驱动，配合 zoom 把那个字钉在视口中心，镜头在一张被放大的海报上游走。
  // 这里照此实现：逐字焦点全部是 f(now) 纯函数，不做帧间 lerp，seek 后姿态一致。
  //
  // 原版防「字字飞 / 来回飞 / 晃」的四条，缺一不可：
  //   1. 锚点粒度是「词段」（segment），不是整行；trackingFactor 0.5 把逐字位置
  //      拉向该词首末字中点 —— 单字词的段中心就是它自己，段内焦点恒定不动。
  //   2. 同一句的字按时间顺序排成一条线，镜头沿线单向跟读，不会在版面远点间折返。
  //   3. 段间权重是「时间距离」高斯 σ=0.35s 的 softmax 归一化，连续无截断。
  //   4. 呼吸只在整句 reveal 完成之后 1.2s 渐入、幅度 0.6% 视口；唱词期间恒为 0。
  var FOCUS_TRACKING = 0.5;            // 上游 resolveSonnetSegmentCameraFocus 默认 0.5
  var FOCUS_SIGMA = 0.35;             // 段间高斯权重 σ（秒），距离是「时间」不是空间
  var FOCUS_SMOOTH_WINDOW = 0.12;     // 5 点时间窗（秒），含 120ms 前视
  var FOCUS_SMOOTH_OFFSETS = [-1, -0.5, 0, 0.5, 1];
  var FOCUS_SMOOTH_WEIGHTS = [1, 4, 6, 4, 1];
  var FOCUS_BLEND_DISTANCE = 96;      // 上游 maxBlendDistance（px，固定值）
  // 上游 tuning 的 cameraIntensity（默认 1，范围 0~2）。这里调到 0.45：
  // 版面依旧海报式铺开，但视口只按 45% 幅度跟读，单字断句时不会一路扫到版面两端。
  // 线性等比缩小不改变轨迹形状，比硬 clamp / 饱和压缩更平顺（不会出现死区或速度折点）。
  var CAMERA_INTENSITY = 0.38;
  var CAMERA_PATH_DAMP = 0.30;        // 预设路径幅度压低，别抢逐字跟随的戏

  // 呼吸：上游 SONNET_CAMERA_BREATH_*。低频（0.07~0.31Hz）、极小幅度，
  // 且只在 revealDoneTime 之后渐入，唱词过程中相机完全没有常驻正弦扰动。
  var BREATH_MAX_OFFSET = 0.006;      // 视口比例
  var BREATH_MAX_SCALE = 0.002;
  var BREATH_MAX_ROTATION = 0.0015;   // 弧度
  var BREATH_RAMP = 1.2;              // 秒

  // 版面：先量后排（measure → pack）。
  // 旧版按「视口比例等分槽位」，跟字实际多宽完全无关 —— 一个大字必然压到邻居身上。
  // 现在按估算盒打包：同行不重叠、行间不压字，放不下就整体等比缩小（构图比例不变）。
  var LAYOUT_GAP_EM = 0.42;           // 词间距 = 相邻词较大字号 × 该系数
  var LAYOUT_GAP_MIN = 14;            // 词间距下限（px），给逐字入场位移留余量
  var ROW_GAP_EM = 0.34;              // 行距 = 相邻行较大字号 × 该系数
  var ROW_GAP_MIN = 16;               // 行距下限（px）
  var LAYOUT_CENTER_Y = 0.46;         // 版面块中心（略高于几何中心，避开底部控制条）
  var LAYOUT_LINE_HEIGHT = 1.08;      // 与 CSS line-height: 1.05 对齐并留余量
  var LAYOUT_MIN_SCALE = 0.26;        // 整体缩小下限，再小就看不清了
  var LAYOUT_DECO_MARGIN = 0.018;     // 装饰字与正文块的最小距离（短边比例）
  // 逐字入场的物理位移：按「字号 em」而不是固定 px —— 版面整体缩小后（长句 / 小窗）
  // 固定 46px 的位移会把相邻字撞到一起，等比缩小则始终只占自己半个身位。
  // 幅度必须小于词间距的一半（LAYOUT_GAP_EM = 0.42em，两个相邻字相向飞最多靠近 2×0.16em），
  // 否则入场那一瞬间会看到字压字 —— 这正是用户反馈的「歌词叠到一起」。
  var GLYPH_ENTER_X_EM = 0.16;
  var GLYPH_ENTER_Y_EM = 0.13;
  var GLYPH_ENTER_ROT = 4;
  var SHORT_LINE_CHARS = 2;           // 单字/双字行：连续短行合并成一句
  var SHORT_LINE_GAP = 0.75;          // 秒；超过就认为是两句

  // 每种镜头的相机路径：zoom 是「每镜头一个常量」（上游构建期由种子定），
  // 不再随播放进度连续变化；x/y 是整镜头的慢漂移，幅度已被 CAMERA_PATH_DAMP 压低。
  var CAMERA_PATHS = {
    'editorial-column': { x0: -0.055, x1: 0.040, y0: 0.010, y1: -0.012, zoom: 1.30, zoomSpan: 0.10, rot: 1.4 },
    'type-impact': { x0: -0.035, x1: 0.035, y0: 0.020, y1: -0.020, zoom: 1.34, zoomSpan: 0.08, rot: 2.0 },
    'quiet-tableau': { x0: -0.012, x1: 0.012, y0: 0.006, y1: -0.006, zoom: 1.24, zoomSpan: 0.10, rot: 0.6 },
    'poster-blocks': { x0: -0.018, x1: 0.018, y0: -0.010, y1: 0.010, zoom: 1.26, zoomSpan: 0.10, rot: 1.0 }
  };

  var root = null;
  var mgCanvas = null;
  var mgCtx = null;
  var cameraNode = null;
  var shotNode = null;
  var activeShotIndex = -1;
  var program = null;
  var programKey = '';
  var glyphs = [];
  var wordNodes = [];
  var activeTracking = null;
  var lastFocus = null;
  var groupHiddenBySonnet = false;
  var lastTrackToken = null;
  var trackSwitchQuietUntil = 0;
  var lastPaletteKey = '';
  var lastMgDraw = 0;
  var viewW = 1280;
  var viewH = 720;
  // 版面是按「编译时的视口」量出来再打包的：窗口尺寸变了必须重排，
  // 否则字号跟着宽度缩、行距跟着高度缩，比例一错就会重新叠字。
  var layoutW = 0;
  var layoutH = 0;

  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -9 * t); }

  // 确定性哈希：同一个种子永远给出同一组姿态。
  function hashUnit(seed) {
    var x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  function seedFrom(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  function sonnetUsable() {
    return typeof fx !== 'undefined' && fx && fx.lyricStyle === STYLE_ID
      && typeof lyricsLines !== 'undefined' && Array.isArray(lyricsLines)
      && (!fx || fx.particleLyrics !== false)
      && (!document.body || !document.body.classList.contains('empty-home-active'))
      && (!document.body || !document.body.classList.contains('splash-active'));
  }

  function lyricNowSeconds() {
    var seconds = typeof getPlaybackCurrentSeconds === 'function'
      ? getPlaybackCurrentSeconds()
      : (typeof audio !== 'undefined' && audio && isFinite(audio.currentTime) ? audio.currentTime : 0);
    if (typeof getAdjustedLyricPlaybackTime === 'function') {
      var adjusted = getAdjustedLyricPlaybackTime(seconds);
      if (isFinite(adjusted)) seconds = adjusted;
    }
    return Math.max(0, seconds);
  }

  // ── 时间轴 ────────────────────────────────────────────────────────────────
  // LRC 行的收尾不能直接吃下一行时间：长间奏会把整行拖成慢动作。逐词（YRC）
  // 行已有真实窗口，按最长词尾收尾。
  // 行级歌词按实测吐字速度估演唱时长，只裁掉明显超出的部分（口径与 16 号模块
  // 完全一致，两边的字才会同时亮；tests/folia-lyric-timing-behavior 有一致性断言）。
  var SUNG_SEC_PER_CHAR = 0.34;
  var SUNG_SEC_PER_LATIN = 0.35;
  var SUNG_TAIL_SEC = 0.9;
  function sungSpanSeconds(text) {
    var raw = String(text || '');
    var weight = 0;
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) weight += 1;
      else if (/[A-Za-z0-9]/.test(ch)) weight += SUNG_SEC_PER_LATIN;
    }
    return weight > 0 ? weight * SUNG_SEC_PER_CHAR + SUNG_TAIL_SEC : 0;
  }

  // 拖音行（省略号/波浪号/长破折号）靠时间占满，不能被收束，否则字会跑到声音前面。
  function isSustainedVocalLine(text) {
    return /[~\uFF5E\u2026]|\.{3,}|[\u2014\u2015-]{3,}/.test(String(text || ''));
  }

  function lineSpanEnd(line, nextLine) {
    var start = Math.max(0, Number(line && line.t) || 0);
    var nextT = nextLine && Number(nextLine.t) > start ? Number(nextLine.t) : 0;
    var duration = nextT ? nextT - start : Math.max(0.8, Number(line && line.duration) || 4);
    var hasWords = Array.isArray(line && line.words) && line.words.length > 0;
    var sung = sungSpanSeconds(line && line.text);
    if (!hasWords && nextT && sung > 0 && !isSustainedVocalLine(line && line.text) && duration > sung + 0.3) {
      duration = sung;
    }
    var end = start + Math.max(0.5, Math.min(duration, 12));
    if (hasWords) {
      for (var i = 0; i < line.words.length; i++) {
        var w = line.words[i];
        var wordEnd = Number(w && w.t) + Math.max(0.08, Number(w && w.d) || 0.24);
        if (isFinite(wordEnd)) end = Math.max(end, wordEnd);
      }
    }
    return end;
  }

  // 分词统一走 17-cjk-word-segmenter 的 splitWords()：流光的 segmentFallbackWords
  // 调的是同一个入口，两个样式对同一行歌词才会给出同一套词边界。
  // 词典是同步 DFA，就绪后同样的输入永远给同样的输出，seek 到任何位置结果都不变；
  // 就绪那一刻由下面的 onReady 重建一次版面，之后不再变化。
  function segmentWords(text) {
    if (window.cjkWordSegmenter && window.cjkWordSegmenter.splitWords) {
      return window.cjkWordSegmenter.splitWords(text);
    }
    // 分词器模块没加载时（不该发生，index-loader 保证它在前）至少别丢字。
    var raw = String(text || '').replace(/\s+/g, ' ').trim();
    return raw ? [raw] : [];
  }

  // 把一行拆成带时间窗的「词」，每个词再拆成逐字 grapheme 窗口。
  // YRC 用真实逐词时间；LRC 按 Folia 的逐字权重（汉字 1、标点 0、拉丁词 1+len*0.15）铺开。
  function buildUnits(line, nextLine) {
    var start = Math.max(0, Number(line && line.t) || 0);
    var end = lineSpanEnd(line, nextLine);
    var words = Array.isArray(line && line.words) ? line.words : null;
    var units = [];
    var i;
    if (words && words.length) {
      for (i = 0; i < words.length; i++) {
        var w = words[i];
        var text = String((w && w.text) || '').trim();
        if (!text) continue;
        var ws = Math.max(start, Number(w.t) || start);
        var nextWord = words[i + 1];
        var nextStart = nextWord && Number(nextWord.t) > ws ? Number(nextWord.t) : 0;
        var d = Number(w.d) > 0 ? Number(w.d) : (nextStart ? nextStart - ws : 0);
        if (!(d > 0)) d = 0.24;
        units.push({ text: text, start: ws, end: ws + Math.max(0.08, d) });
      }
      var minStart = Infinity, maxStart = -Infinity;
      for (i = 0; i < units.length; i++) {
        minStart = Math.min(minStart, units[i].start);
        maxStart = Math.max(maxStart, units[i].start);
      }
      if (units.length > 1 && maxStart - minStart < 0.05) spreadUnitsEvenly(units, start, end);
    }
    if (!units.length) {
      var tokens = segmentWords(String((line && line.text) || ''));
      for (i = 0; i < tokens.length; i++) units.push({ text: tokens[i], start: start, end: end });
      spreadUnitsEvenly(units, start, end);
    }
    for (i = 0; i < units.length; i++) {
      var chars = Array.from(units[i].text);
      var span = Math.max(0.05, units[i].end - units[i].start) / Math.max(1, chars.length);
      units[i].glyphs = chars.map(function (ch, gi) {
        return { text: ch, start: units[i].start + span * gi, end: units[i].start + span * (gi + 1) };
      });
    }
    return units;
  }

  function spreadUnitsEvenly(units, start, end) {
    if (!units.length) return;
    var weights = units.map(function (u) {
      var chars = Array.from(u.text);
      var w = 0, latin = 0;
      for (var i = 0; i < chars.length; i++) {
        if (/[㐀-鿿぀-ヿ가-힯]/.test(chars[i])) w += /[，。！？、：；"'）】》」』]/.test(chars[i]) ? 0 : 1;
        else if (/[A-Za-z0-9]/.test(chars[i])) latin += 1;
      }
      if (latin) w += 1 + latin * 0.15;
      return Math.max(0.05, w);
    });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    var active = Math.max(0.1, end - start) * 0.9;
    var cursor = start;
    for (var i = 0; i < units.length; i++) {
      var d = active * weights[i] / total;
      units[i].start = cursor;
      units[i].end = cursor + Math.max(0.05, d);
      cursor += d;
    }
  }

  // 四级字号：hero / semi-hero / support，外加一个空心巨型 decoration 副本。
  // 角色按「长度 × 14 + 时长 × 18」打分，和上游的评分口径一致。
  function assignRoles(units, seed) {
    if (!units.length) return;
    var scores = units.map(function (u, i) {
      return u.text.length * 14 + (u.end - u.start) * 18 + hashUnit(seed * 3.7 + i) * 0.01;
    });
    var order = scores.map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) { return b.s - a.s; });
    for (var i = 0; i < units.length; i++) units[i].role = 'support';
    units[order[0].i].role = 'hero';
    if (order.length > 1) units[order[1].i].role = 'semi-hero';
    if (order.length > 4) units[order[2].i].role = 'semi-hero';
    var hero = units[order[0].i];
    units.push({
      text: hero.text,
      start: hero.start,
      end: hero.end,
      role: 'decoration',
      static: true,
      glyphs: hero.glyphs.map(function (g) { return { text: g.text, start: g.start, end: g.end }; })
    });
  }

  function roleScale(role, kind) {
    if (role === 'hero') return kind === 'type-impact' ? 5.0 : 4.2;
    if (role === 'semi-hero') return 2.1;
    if (role === 'decoration') return 5.4;
    return 1.15;
  }

  // 词的估算宽度（em）：不用 canvas 量、也不用等布局，纯函数才能保证 seek-safe。
  // 中日韩全角 1.0em、拉丁 0.56em、标点 0.52em，末尾 1.02 是 CSS 的 letter-spacing: .02em。
  function textEmAdvance(text) {
    var em = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (/\s/.test(ch)) em += 0.30;
      else if (/[A-Za-z0-9]/.test(ch)) em += 0.56;
      else if (/[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch)) em += 1;
      else em += 0.52;
    }
    return Math.max(0.6, em) * 1.02;
  }

  // 词盒：字号 × 字宽，竖排时交换长宽；再按静止旋转取轴对齐包围盒。
  // 打包用的是「旋转后的外框」，所以轻微倾斜也不会压到邻居。
  function measureUnit(unit, width) {
    var size = unitFontSize(unit, width);
    var w = textEmAdvance(String(unit.text || '')) * size;
    var h = size * LAYOUT_LINE_HEIGHT;
    if (unit.vertical) { var t = w; w = h; h = t; }
    var rad = Math.abs(unit.rotate || 0) * Math.PI / 180;
    var c = Math.cos(rad), s = Math.sin(rad);
    return { w: w * c + h * s, h: w * s + h * c, size: size };
  }

  function wordGap(a, b, floor) {
    return Math.max(floor, LAYOUT_GAP_EM * Math.max(a.size, b.size));
  }

  // 打包一遍：给定缩放系数 k，量出每行（竖排时是每列）的尺寸与整块尺寸。
  // 只做测量，不写坐标，方便「放不下就缩一圈再量」。
  function packRows(rows, kind, vertical, width, k) {
    // 间距下限也要跟着 k 收缩：否则缩到很小的时候，14px 的固定间距会把版面撑爆，
    // 最后一圈 clamp 会把末尾几个字钉在同一条线上 —— 那就是「歌词叠一起」。
    var gapFloor = Math.max(4, LAYOUT_GAP_MIN * Math.max(0.4, k));
    var rowFloor = Math.max(5, ROW_GAP_MIN * Math.max(0.4, k));
    var packed = [];
    var blockMain = 0;     // 主轴方向的最大长度（横排=宽，竖排=高）
    var blockCross = 0;    // 交叉轴方向的累计长度
    for (var r = 0; r < rows.length; r++) {
      var list = rows[r];
      var items = [];
      var main = 0, cross = 0;
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        u.fontScale = roleScale(u.role, kind) * k;
        u.vertical = vertical;
        var box = measureUnit(u, width);
        items.push({ u: u, w: box.w, h: box.h, size: box.size, gap: 0 });
        main += vertical ? box.h : box.w;
        cross = Math.max(cross, vertical ? box.w : box.h);
      }
      for (i = 1; i < items.length; i++) {
        var g = wordGap(items[i - 1], items[i], gapFloor);
        items[i].gap = g;
        main += g;
      }
      packed.push({ items: items, main: main, cross: cross, gap: 0 });
      blockMain = Math.max(blockMain, main);
      blockCross += cross;
    }
    for (r = 1; r < packed.length; r++) {
      var rg = Math.max(rowFloor, ROW_GAP_EM * Math.max(packed[r - 1].cross, packed[r].cross));
      packed[r].gap = rg;
      blockCross += rg;
    }
    return {
      rows: packed,
      blockW: vertical ? blockCross : blockMain,
      blockH: vertical ? blockMain : blockCross
    };
  }

  // 版面 = 先量后排。
  // 一行 = 一句，句内按 start 时间顺序沿一条线铺开（上游 placements dump 同形），
  // 偶数行从左往右、奇数行从右往左（之字形），镜头沿线单向跟读不折返。
  // 关键差别：槽位宽度用的是「词的真实宽度」，不是视口比例等分 —— 大字不会再压到邻居。
  function layoutUnits(units, kind, seed, width, height) {
    var W = width || viewW;
    var H = height || viewH;
    var vertical = kind === 'editorial-column';
    var body = [], deco = [], i, r;
    for (i = 0; i < units.length; i++) {
      if (units[i].role === 'decoration') deco.push(units[i]);
      else body.push(units[i]);
    }

    var groups = {}, order = [];
    for (i = 0; i < body.length; i++) {
      var key = String(body[i].line == null ? 0 : body[i].line);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(body[i]);
    }
    var rows = [];
    for (r = 0; r < order.length; r++) {
      rows.push(groups[order[r]].sort(function (a, b) { return a.start - b.start; }));
    }
    // 旋转幅度压小：大角度虽然好看，但旋转外框会吃掉大量行内空间。
    for (i = 0; i < body.length; i++) {
      body[i].rotate = (hashUnit(seed + (body[i].line || 0) * 5.3 + i * 2.9) - 0.5)
        * (kind === 'type-impact' ? 4 : 2.5);
    }

    var availW = (SAFE_MAX_X - SAFE_MIN_X) * W;
    var availH = (SAFE_MAX_Y - SAFE_MIN_Y) * H;
    var k = 1, packed = null;
    for (var pass = 0; pass < 8; pass++) {
      packed = packRows(rows, kind, vertical, W, k);
      if ((packed.blockW <= availW && packed.blockH <= availH) || k <= LAYOUT_MIN_SCALE) break;
      var shrink = Math.min(availW / Math.max(1, packed.blockW), availH / Math.max(1, packed.blockH));
      k = Math.max(LAYOUT_MIN_SCALE, k * shrink * 0.97);
    }
    // 最后一圈的量测结果就是最终字号，坐标按它排。
    packed = packRows(rows, kind, vertical, W, k);

    var safeLeft = SAFE_MIN_X * W, safeTop = SAFE_MIN_Y * H;
    var left = clamp(W * 0.5 - packed.blockW / 2, safeLeft,
      Math.max(safeLeft, SAFE_MAX_X * W - packed.blockW));
    var top = clamp(H * LAYOUT_CENTER_Y - packed.blockH / 2, safeTop,
      Math.max(safeTop, SAFE_MAX_Y * H - packed.blockH));

    var cursor = vertical ? left : top;
    for (r = 0; r < packed.rows.length; r++) {
      var row = packed.rows[r];
      // 竖排是日文竖栏，从上往下读，不做反向；横排才走之字形。
      var reversed = !vertical && r % 2 === 1;
      if (r > 0) cursor += row.gap;
      if (vertical) {
        var cy0 = top;
        var cx = cursor + row.cross / 2;
        for (i = 0; i < row.items.length; i++) {
          var it = row.items[i];
          var yy = cy0 + it.h / 2;
          it.u.x = clamp(cx / W, SAFE_MIN_X, SAFE_MAX_X);
          it.u.y = clamp(yy / H, SAFE_MIN_Y, SAFE_MAX_Y);
          cy0 += it.h + (i + 1 < row.items.length ? row.items[i + 1].gap : 0);
        }
        cursor += row.cross;
      } else {
        var cy = cursor + row.cross / 2;
        var x = reversed ? left + packed.blockW : left;
        for (i = 0; i < row.items.length; i++) {
          var item = row.items[i];
          var cxItem = reversed ? x - item.w / 2 : x + item.w / 2;
          item.u.x = clamp(cxItem / W, SAFE_MIN_X, SAFE_MAX_X);
          item.u.y = clamp(cy / H, SAFE_MIN_Y, SAFE_MAX_Y);
          x += (reversed ? -1 : 1) * item.w;
          if (i + 1 < row.items.length) x += (reversed ? -1 : 1) * row.items[i + 1].gap;
        }
        cursor += row.cross;
      }
    }

    // 空心装饰字是 hero 的回声，但绝不能压在歌词上：只在正文块四周的空余里找位置，
    // 四个方向都试，实在放不下就把字号缩到能放下的尺寸。
    var blockLeft = left, blockTop = top;
    var blockRight = left + packed.blockW, blockBottom = top + packed.blockH;
    var margin = LAYOUT_DECO_MARGIN * Math.min(W, H);
    var safeRight = SAFE_MAX_X * W, safeBottom = SAFE_MAX_Y * H;
    for (var d = 0; d < deco.length; d++) {
      var du = deco[d];
      du.vertical = false;
      du.rotate = -8 + hashUnit(seed + 5.5) * 16;
      du.fontScale = roleScale('decoration', kind) * k;
      var box = measureUnit(du, W);
      var spots = [
        { x: blockLeft - margin - box.w / 2, y: (blockTop + blockBottom) / 2, need: box.w },
        { x: blockRight + margin + box.w / 2, y: (blockTop + blockBottom) / 2, need: box.w },
        { x: (blockLeft + blockRight) / 2, y: blockTop - margin - box.h / 2, need: box.h },
        { x: (blockLeft + blockRight) / 2, y: blockBottom + margin + box.h / 2, need: box.h }
      ];
      var fit = null;
      for (i = 0; i < spots.length; i++) {
        var sp = spots[i];
        if (sp.x - box.w / 2 >= safeLeft && sp.x + box.w / 2 <= safeRight
          && sp.y - box.h / 2 >= safeTop && sp.y + box.h / 2 <= safeBottom) {
          fit = sp;
          break;
        }
      }
      if (!fit) {
        // 四边都放不下：按最宽的一侧余量缩字号，仍贴在该侧外侧。
        var free = Math.max(blockLeft - safeLeft, safeRight - blockRight,
          blockTop - safeTop, safeBottom - blockBottom);
        var scaleDown = clamp(free / Math.max(1, box.w + margin), 0.32, 1);
        du.fontScale *= scaleDown;
        box = measureUnit(du, W);
        fit = spots[0];
        if (blockLeft - safeLeft < box.w) fit = blockRight + margin + box.w / 2 <= safeRight
          ? spots[1] : spots[0];
      }
      du.x = clamp(fit.x / W, SAFE_MIN_X, SAFE_MAX_X);
      du.y = clamp(fit.y / H, SAFE_MIN_Y, SAFE_MAX_Y);
    }
  }

  // 段落切分：相邻行间隔超过「中位间隔 × 2.5」就换镜头，并限制每段 4 行 / 6.5 秒。
  // 镜头种类按种子挑选且不与上一镜头重复；所有姿态都只依赖绝对时间。
  // 单字断句的歌（逐字 LRC / 卡拉 OK 式）会把一个句子拆成很多「一行一字」。
  // 上游是一行 = 一句、segment = 词；这里先把连续短行并回一句，否则 4 行上限
  // 会把一句切成好几个镜头，相机就在几个孤字之间硬切乱飞。
  // 用「最后一个原始行的 t」算间隔，不能用 end —— lineSpanEnd 会吃掉下一行时间。
  function mergeShortLines(infos) {
    var out = [];
    for (var i = 0; i < infos.length; i++) {
      var info = infos[i];
      var compact = String(info.text || '').replace(/[\s\p{P}\p{S}]/gu, '');
      var short = compact.length > 0 && compact.length <= SHORT_LINE_CHARS;
      var last = out[out.length - 1];
      var gap = last ? info.t - last.lastT : Infinity;
      if (short && last && last.short && gap <= SHORT_LINE_GAP) {
        last.text += info.text;
        last.end = info.end;
        last.lastT = info.t;
        last.units = last.units.concat(info.units);
      } else {
        out.push({
          t: info.t, end: info.end, lastT: info.t, text: info.text,
          units: info.units.slice(), short: short
        });
      }
    }
    return out;
  }

  function compileProgram(lines, seed) {
    var infos = [];
    var i, j;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.text) continue;
      infos.push({
        t: Math.max(0, Number(line.t) || 0),
        end: lineSpanEnd(line, lines[i + 1]),
        text: String(line.text),
        units: buildUnits(line, lines[i + 1])
      });
    }
    if (!infos.length) return { shots: [], key: '' };
    infos = mergeShortLines(infos);

    var gaps = [];
    for (i = 0; i + 1 < infos.length; i++) gaps.push(Math.max(0, infos[i + 1].t - infos[i].end));
    gaps.sort(function (a, b) { return a - b; });
    var median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1.5;
    var threshold = clamp(median * 2.5, 1.25, 3.5);

    var paragraphs = [];
    var cur = [];
    for (i = 0; i < infos.length; i++) {
      var info = infos[i];
      if (cur.length && (cur.length >= MAX_LINES_PER_SHOT
        || info.t - cur[cur.length - 1].end > threshold
        || info.end - cur[0].t > 6.5)) {
        paragraphs.push(cur);
        cur = [];
      }
      cur.push(info);
    }
    if (cur.length) paragraphs.push(cur);

    var shots = [];
    var lastKind = -1;
    for (i = 0; i < paragraphs.length; i++) {
      var para = paragraphs[i];
      var start = Math.max(0, para[0].t - 0.02);
      var end = i + 1 < paragraphs.length
        ? Math.max(start + 0.5, paragraphs[i + 1][0].t - 0.02)
        : para[para.length - 1].end + 1.6;
      var s = seed + i * 13.37;
      var kindIndex = Math.floor(hashUnit(s * 3.13 + 0.7) * SHOT_KINDS.length) % SHOT_KINDS.length;
      if (kindIndex === lastKind) kindIndex = (kindIndex + 1) % SHOT_KINDS.length;
      lastKind = kindIndex;
      var kind = SHOT_KINDS[kindIndex];
      var units = [];
      for (j = 0; j < para.length && units.length < MAX_UNITS_PER_SHOT; j++) {
        var lineUnits = para[j].units;
        for (var k = 0; k < lineUnits.length && units.length < MAX_UNITS_PER_SHOT; k++) {
          var src = lineUnits[k];
          units.push({
            text: src.text, start: src.start, end: src.end, line: j,
            glyphs: src.glyphs.map(function (g) { return { text: g.text, start: g.start, end: g.end }; })
          });
        }
      }
      assignRoles(units, s);
      layoutUnits(units, kind, s);
      var cam = CAMERA_PATHS[kind];
      var revealDone = start;
      for (j = 0; j < units.length; j++) {
        for (var gi = 0; gi < units[j].glyphs.length; gi++) {
          if (units[j].glyphs[gi].start > revealDone) revealDone = units[j].glyphs[gi].start;
        }
      }
      shots.push({
        index: i, start: start, end: end, kind: kind, seed: s,
        transition: TRANSITIONS[Math.floor(hashUnit(s * 7.71 + 2.3) * TRANSITIONS.length) % TRANSITIONS.length],
        mgVariant: Math.floor(hashUnit(s * 11.9 + 4.1) * 8) % 8,
        cam: cam,
        // 上游的 zoom / rotation 是每镜头构建期常量，不随播放进度连续变化；
        // revealDoneTime 之后呼吸才渐入，唱词期间相机没有常驻正弦扰动。
        zoom: cam.zoom + hashUnit(s * 5.71 + 1.9) * cam.zoomSpan,
        rotation: (hashUnit(s * 9.37 + 3.3) - 0.5) * 2 * cam.rot,
        revealDoneTime: revealDone,
        units: units
      });
    }
    return { shots: shots, key: '' };
  }

  function programSignature(lines) {
    if (!lines || !lines.length) return 'empty';
    return [lines.length, lines[0].t, lines[lines.length - 1].t,
      String(lines[0].text || '').slice(0, 8), String(lines[lines.length - 1].text || '').slice(0, 8)].join('|');
  }

  function findShotIndex(shots, now) {
    for (var i = 0; i < shots.length; i++) {
      if (now >= shots[i].start && now < shots[i].end) return i;
    }
    return -1;
  }

  // 逐字焦点时间表按「词段」分组（上游 trackSegments = 非装饰的 semantic segment），
  // 不是按整行。单字词的段中心就是它自己，段内焦点恒定 —— 这是单字断句不飞的关键。
  function buildTracking(shot, width, height) {
    var segments = [];
    var count = 0;
    var i, g;
    for (i = 0; i < shot.units.length; i++) {
      var unit = shot.units[i];
      if (unit.static || unit.role === 'decoration') continue;
      var chars = unit.glyphs || [];
      if (!chars.length) continue;
      var size = unitFontSize(unit, width);
      var latin = /^[A-Za-z0-9]/.test(String(unit.text || ''));
      // 词内逐字按字宽排开；.fs-word 以中心对齐，所以偏移量相对词中心计算。
      var advance = size * (unit.vertical ? 0.95 : (latin ? 0.58 : 0.92));
      var list = [];
      for (g = 0; g < chars.length; g++) {
        var offset = (g - (chars.length - 1) / 2) * advance;
        list.push({
          x: unit.x * width + (unit.vertical ? 0 : offset),
          y: unit.y * height + (unit.vertical ? offset : 0),
          start: chars[g].start
        });
      }
      list.sort(function (a, b) { return a.start - b.start; });
      // 相同 startTime 的字并成同一个焦点坐标：YRC 里同起点/零时长的字很常见，
      // 若保留各自坐标，插值会在 0.001s 内从 A 跳到 B，正是「来回飞 + 抖」的来源。
      for (g = 1; g < list.length; g++) {
        if (list[g].start - list[g - 1].start > 0.005) continue;
        var m = g;
        var sx = list[g - 1].x, sy = list[g - 1].y;
        while (m < list.length && list[m].start - list[g - 1].start <= 0.005) {
          sx += list[m].x; sy += list[m].y; m++;
        }
        var n = m - g + 1;
        var ax = sx / n, ay = sy / n;
        for (var q = g - 1; q < m; q++) { list[q].x = ax; list[q].y = ay; }
        g = m - 1;
      }
      count += list.length;
      var first = list[0], last = list[list.length - 1];
      // 段中心 = 首末字中点（上游 segCenter），trackingFactor 把逐字位置拉向它。
      segments.push({
        glyphs: list,
        centerX: (first.x + last.x) / 2,
        centerY: (first.y + last.y) / 2,
        start: first.start,
        end: last.start
      });
    }
    segments.sort(function (a, b) { return a.start - b.start; });
    // 初始/复位锚点：hero 字（上游 pivot = heroPlacement）；无 hero 时用首段中心。
    var hero = null;
    for (i = 0; i < shot.units.length; i++) {
      if (shot.units[i].role === 'hero') { hero = shot.units[i]; break; }
    }
    var basePivot = hero ? { x: hero.x * width, y: hero.y * height }
      : (segments.length ? { x: segments[0].centerX, y: segments[0].centerY }
        : { x: width * 0.5, y: height * 0.5 });
    return {
      segments: segments, basePivot: basePivot, width: width, height: height,
      count: count, revealDoneTime: shot.revealDoneTime
    };
  }

  // 段内：按相邻字的 startTime 线性插值 —— 字还没唱到，镜头已经在朝它移动（预瞄）。
  function segmentFocusAt(seg, t) {
    var gs = seg.glyphs;
    var exactX, exactY;
    if (t <= gs[0].start) { exactX = gs[0].x; exactY = gs[0].y; }
    else if (t >= gs[gs.length - 1].start) { exactX = gs[gs.length - 1].x; exactY = gs[gs.length - 1].y; }
    else {
      exactX = gs[0].x; exactY = gs[0].y;
      for (var i = 0; i + 1 < gs.length; i++) {
        if (t < gs[i].start || t > gs[i + 1].start) continue;
        var span = Math.max(0.001, gs[i + 1].start - gs[i].start);
        var p = clamp((t - gs[i].start) / span, 0, 1);
        exactX = lerp(gs[i].x, gs[i + 1].x, p);
        exactY = lerp(gs[i].y, gs[i + 1].y, p);
        break;
      }
    }
    return {
      x: seg.centerX + (exactX - seg.centerX) * FOCUS_TRACKING,
      y: seg.centerY + (exactY - seg.centerY) * FOCUS_TRACKING
    };
  }

  // 段间：时间距离高斯的 softmax 归一化（上游 resolveSonnetFocusWeights）。
  // 注意 d 是「到段时间窗边界的秒数」，不是空间距离；所有段都参与、无硬截断，
  // 减最大 log 权重保证数值稳定。权重连续可导，不会在段进出时突然变集合。
  function focusAtTime(tracking, t) {
    var segs = tracking.segments;
    if (!segs.length) return { x: tracking.basePivot.x, y: tracking.basePivot.y };
    var logs = [];
    var maxLog = -Infinity;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var d = t < s.start ? s.start - t : (t > s.end ? t - s.end : 0);
      var lw = -(d * d) / (2 * FOCUS_SIGMA * FOCUS_SIGMA);
      logs.push(lw);
      if (lw > maxLog) maxLog = lw;
    }
    var total = 0, wx = 0, wy = 0;
    for (var j = 0; j < segs.length; j++) {
      var w = Math.exp(logs[j] - maxLog);
      var pos = segmentFocusAt(segs[j], t);
      wx += pos.x * w; wy += pos.y * w; total += w;
    }
    return total > 0 ? { x: wx / total, y: wy / total }
      : { x: tracking.basePivot.x, y: tracking.basePivot.y };
  }

  // 5 点时间窗平滑（绝对时间，seek-safe）。上游的保边是「距离 > 96px 直接剔除」，
  // 但上游 focusJitterRepro 测试复现的正是这个硬开关造成的 gate toggling 抖动；
  // 这里改为连续衰减：远构图权重趋于 0（保留「硬切不取中点」语义），阈值处不跳变。
  function resolveCameraFocus(shot, now, tracking) {
    if (!tracking || !tracking.segments.length) {
      return tracking ? { x: tracking.basePivot.x, y: tracking.basePivot.y }
        : { x: 0, y: 0 };
    }
    var lo = Math.max(0, shot.start);
    var hi = Math.max(lo + 0.001, shot.end);
    var t = clamp(now, lo, hi);
    var center = focusAtTime(tracking, t);
    var maxDistSq = FOCUS_BLEND_DISTANCE * FOCUS_BLEND_DISTANCE;
    var sumX = 0, sumY = 0, sumW = 0;
    for (var k = 0; k < FOCUS_SMOOTH_OFFSETS.length; k++) {
      var st = clamp(t + FOCUS_SMOOTH_OFFSETS[k] * FOCUS_SMOOTH_WINDOW, lo, hi);
      var p = focusAtTime(tracking, st);
      var dx = p.x - center.x, dy = p.y - center.y;
      var ratio = (dx * dx + dy * dy) / maxDistSq;
      var gate = 1 / (1 + ratio * ratio);
      var w = FOCUS_SMOOTH_WEIGHTS[k] * gate;
      sumX += p.x * w; sumY += p.y * w; sumW += w;
    }
    var focus = sumW ? { x: sumX / sumW, y: sumY / sumW } : center;
    return {
      x: lerp(tracking.basePivot.x, focus.x, CAMERA_INTENSITY),
      y: lerp(tracking.basePivot.y, focus.y, CAMERA_INTENSITY)
    };
  }

  function cameraFrame(shot, now, width, height, focus) {
    var span = Math.max(0.1, shot.end - shot.start);
    var p = clamp((now - shot.start) / span, 0, 1);
    var e = easeInOut(p);
    // 呼吸：上游只在整句 reveal 完成后 1.2s 渐入，唱词期间恒为 0
    // （resolveSonnetBreathWeight 注释 "so it never pops in mid-line"）。
    // 之前把 0.9% 视口的三层正弦做成常驻，正是「晃得晕」的直接来源。
    var reveal = isFinite(shot.revealDoneTime) ? shot.revealDoneTime : shot.end;
    var bw = easeInOut(clamp((now - reveal) / BREATH_RAMP, 0, 1));
    var tau = now * Math.PI * 2;
    var phase = hashUnit(shot.seed * 13.7) * Math.PI * 2;
    var bx = (Math.sin(tau * 0.13 + phase) * 0.65
      + Math.sin(tau * 0.31 + phase * 1.7) * 0.35) * BREATH_MAX_OFFSET * bw;
    var by = (Math.cos(tau * 0.11 + phase * 2.3) * 0.65
      + Math.sin(tau * 0.29 + phase * 0.9) * 0.35) * BREATH_MAX_OFFSET * bw;
    var bs = Math.sin(tau * 0.09 + phase * 1.3) * BREATH_MAX_SCALE * bw;
    var br = Math.sin(tau * 0.07 + phase * 2.9) * BREATH_MAX_ROTATION * bw * (180 / Math.PI);
    var px = focus ? focus.x : width * 0.5;
    var py = focus ? focus.y : height * 0.5;
    // 整镜头的单缓慢漂移；zoom / rotation 是构建期常量，不随进度连续变化。
    var x = width * 0.5 + lerp(shot.cam.x0, shot.cam.x1, e) * width * CAMERA_PATH_DAMP + bx * width;
    // 视口锚点略高于几何中心（上游 position.y = height * 0.48），给底部控制条留白。
    var y = height * 0.47 + lerp(shot.cam.y0, shot.cam.y1, e) * height * CAMERA_PATH_DAMP + by * height;
    var scale = (isFinite(shot.zoom) ? shot.zoom : 1.30) + bs;
    var rotate = (isFinite(shot.rotation) ? shot.rotation : 0) + br;
    // pivot 跟随的 CSS 等价物：局部点 p → Center + R·Z·(p - focus)。
    // transform-origin 必须是 0 0（见 lyrics.css），否则中心会被额外平移一次。
    return 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)'
      + ' rotate(' + rotate.toFixed(2) + 'deg) scale(' + scale.toFixed(4) + ')'
      + ' translate3d(' + (-px).toFixed(1) + 'px,' + (-py).toFixed(1) + 'px,0)';
  }

  function transitionFrame(shot, now) {
    var dur = 0.24;
    var inAmount = 1 - easeInOut(clamp((now - shot.start) / dur, 0, 1));
    var outAmount = easeInOut(clamp((now - (shot.end - dur)) / dur, 0, 1));
    var amount = Math.max(inAmount, outAmount);
    var blur = shot.transition === 'fast-blur' ? amount * 14 : 0;
    var alpha = 1 - amount * (shot.transition === 'camera-pull' ? 0.72 : 0.90);
    var glitch = shot.transition === 'mono-glitch' ? amount : 0;
    return { alpha: alpha, blur: blur, glitch: glitch, amount: amount };
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function ensureRoot() {
    if (root && root.isConnected) return;
    var host = document.getElementById('canvas-container') || document.body;
    root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.setAttribute('aria-hidden', 'true');
      root.innerHTML = ''
        + '<canvas class="fs-mg"></canvas>'
        + '<div class="fs-frame">'
        + '  <i class="fs-corner fs-corner-tl"></i><i class="fs-corner fs-corner-tr"></i>'
        + '  <i class="fs-corner fs-corner-bl"></i><i class="fs-corner fs-corner-br"></i>'
        + '  <b class="fs-star">✦</b>'
        + '</div>'
        + '<div class="fs-viewport"><div class="fs-camera"><div class="fs-shot"></div></div></div>'
        + '<div class="fs-meta"><span class="fs-meta-side">[ MINERADIO ] SONNET</span>'
        + '<span class="fs-meta-note">KINETIC TYPOGRAPHY / PV</span></div>';
      host.appendChild(root);
    }
    mgCanvas = root.querySelector('.fs-mg');
    mgCtx = mgCanvas && mgCanvas.getContext ? mgCanvas.getContext('2d') : null;
    cameraNode = root.querySelector('.fs-camera');
    shotNode = root.querySelector('.fs-shot');
    activeShotIndex = -1;
    glyphs = [];
    wordNodes = [];
    lastPaletteKey = '';
    measureView();
  }

  function measureView() {
    viewW = Math.max(320, window.innerWidth || 1280);
    viewH = Math.max(240, window.innerHeight || 720);
    if (mgCanvas) {
      var dpr = Math.min(1.5, window.devicePixelRatio || 1);
      mgCanvas.width = Math.round(viewW * dpr);
      mgCanvas.height = Math.round(viewH * dpr);
      mgCanvas.style.width = viewW + 'px';
      mgCanvas.style.height = viewH + 'px';
      if (mgCtx) mgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function palette() {
    var pal = (typeof stageLyrics !== 'undefined' && stageLyrics)
      ? (stageLyrics.palette || stageLyrics.coverPalette || null) : null;
    return pal || { primary: '#eaf3ff', highlight: '#ffffff', secondary: '#a9d4ff', glowColor: '#7fc4ff' };
  }

  function syncPalette() {
    var pal = palette();
    var key = [pal.primary, pal.highlight, pal.secondary, pal.glowColor,
      typeof fx !== 'undefined' && fx ? !!fx.lyricGlow : true].join('|');
    if (key === lastPaletteKey) return;
    lastPaletteKey = key;
    root.style.setProperty('--fs-ink', pal.primary || '#eaf3ff');
    root.style.setProperty('--fs-hi', pal.highlight || '#ffffff');
    root.style.setProperty('--fs-secondary', pal.secondary || '#a9d4ff');
    root.style.setProperty('--fs-accent', pal.glowColor || pal.secondary || '#7fc4ff');
    root.style.setProperty('--fs-glow', (typeof fx !== 'undefined' && fx && fx.lyricGlow === false) ? '0' : '1');
  }

  // 字号只由传入的舞台宽度决定：焦点坐标与实际 DOM 字号必须用同一套计算，
  // 否则相机跟的点会和屏幕上字的位置错开。
  function unitFontSize(unit, width) {
    var scale = 1;
    if (typeof fx !== 'undefined' && fx && isFinite(fx.lyricFontScale)) {
      scale = clamp(Number(fx.lyricFontScale), 0.6, 1.8);
    }
    var base = clamp(width * 0.020, 16, 42) * scale;
    return unit.role === 'hero' ? Math.min(210, base * unit.fontScale)
      : unit.role === 'decoration' ? Math.min(240, base * unit.fontScale)
        : base * unit.fontScale;
  }

  function buildShotDom(shot) {
    shotNode.textContent = '';
    shotNode.dataset.kind = shot.kind;
    root.dataset.kind = shot.kind;
    glyphs = [];
    wordNodes = [];
    activeTracking = buildTracking(shot, viewW, viewH);
    for (var i = 0; i < shot.units.length; i++) {
      var unit = shot.units[i];
      var node = document.createElement('div');
      node.className = 'fs-word';
      node.dataset.role = unit.role;
      if (unit.static) node.classList.add('is-static');
      if (unit.vertical) node.classList.add('is-vertical');
      node.style.left = (unit.x * 100).toFixed(2) + '%';
      node.style.top = (unit.y * 100).toFixed(2) + '%';
      node.style.fontSize = unitFontSize(unit, viewW).toFixed(1) + 'px';
      node.style.setProperty('--fs-rest-rotate', (unit.rotate || 0).toFixed(2) + 'deg');
      if (typeof lyricFontStackForKey === 'function') {
        node.style.fontFamily = lyricFontStackForKey(fx && fx.lyricFont);
      }
      var localGlyphs = [];
      var glyphSize = unitFontSize(unit, viewW);
      for (var g = 0; g < unit.glyphs.length; g++) {
        var glyph = unit.glyphs[g];
        var span = document.createElement('span');
        span.className = 'fs-glyph';
        span.textContent = glyph.text;
        node.appendChild(span);
        var h = shot.seed * 17.3 + i * 7.13 + g * 1.71;
        // 空心装饰字与 hero 同步逐字入场，但位移/旋转幅度收小，读起来像回声而非乱飞。
        var amp = unit.static ? 0.22 : 1;
        localGlyphs.push({
          node: span,
          start: glyph.start,
          end: glyph.end,
          enterX: (hashUnit(h + 0.7) - 0.5) * glyphSize * GLYPH_ENTER_X_EM * amp,
          enterY: (hashUnit(h + 2.3) - 0.5) * glyphSize * GLYPH_ENTER_Y_EM * amp,
          rot: (hashUnit(h + 4.9) - 0.5) * GLYPH_ENTER_ROT * amp,
          last: ''
        });
        glyphs.push(localGlyphs[localGlyphs.length - 1]);
      }
      node.__fsGlyphs = localGlyphs;
      node.__fsStatic = !!unit.static;
      node.__fsState = '';
      shotNode.appendChild(node);
      wordNodes.push(node);
    }
    lastMgDraw = 0;
  }

  // 逐字入场：每个 grapheme 用自己的 start 时间独立弹入，姿态是 f(now) 而非累积动画，
  // 所以拖进度条、暂停、重播都不会出现残留或跳帧。
  function paintGlyphs(now) {
    for (var i = 0; i < glyphs.length; i++) {
      var g = glyphs[i];
      var p = easeOutExpo(clamp((now - (g.start - 0.12)) / GLYPH_SETTLE, 0, 1));
      var dx = g.enterX * (1 - p);
      var dy = g.enterY * (1 - p);
      var rot = g.rot * (1 - p);
      var scale = 0.86 + 0.14 * p;
      var transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)'
        + ' rotate(' + rot.toFixed(2) + 'deg) scale(' + scale.toFixed(3) + ')';
      if (transform !== g.last) {
        g.last = transform;
        g.node.style.transform = transform;
        g.node.style.opacity = (0.12 + 0.88 * p).toFixed(3);
      }
    }
    // 词级状态只在变化时写，色差/辉光由 CSS 消费，避免每帧重算 text-shadow。
    for (var w = 0; w < wordNodes.length; w++) {
      var node = wordNodes[w];
      if (node.__fsStatic) continue;
      var first = node.__fsGlyphs && node.__fsGlyphs[0];
      if (!first) continue;
      var state = now < first.start - 0.12 ? 'waiting'
        : now < first.start + GLYPH_SETTLE ? 'entering' : 'settled';
      if (state !== node.__fsState) {
        node.__fsState = state;
        node.classList.remove('is-waiting', 'is-entering', 'is-settled');
        node.classList.add('is-' + state);
      }
    }
  }

  // ── 背景 MG：一层 Canvas2D，HUD 线框 + 几何 + 漂移小图形 ──────────────────
  function drawMg(shot, now) {
    if (!mgCtx || !shot) return;
    var ctx = mgCtx;
    var w = viewW, h = viewH;
    ctx.clearRect(0, 0, w, h);
    var accent = palette().secondary || '#a9d4ff';
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // 背景随机细线：数量由种子决定，位置 f(now) 缓慢横移。
    ctx.save();
    ctx.lineWidth = 1;
    for (var i = 0; i < 9; i++) {
      var y = h * (0.08 + hashUnit(shot.seed * 2.1 + i * 3.7) * 0.84);
      var x = ((now * (3 + i)) % (w + 160)) - 160;
      ctx.globalAlpha = 0.10 + hashUnit(shot.seed + i * 5.1) * 0.14;
      ctx.strokeStyle = i % 2 ? accent : '#ffffff';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 120 + hashUnit(shot.seed + i) * 260, y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.26;
    var v = shot.mgVariant;
    if (v === 0 || v === 5) {
      // 经典十字 / 双框
      ctx.beginPath();
      ctx.moveTo(w * 0.5, 0); ctx.lineTo(w * 0.5, h);
      ctx.moveTo(0, h * 0.5); ctx.lineTo(w, h * 0.5);
      ctx.stroke();
      ctx.strokeRect(w * 0.06, h * 0.06, w * 0.88, h * 0.88);
      if (v === 5) ctx.strokeRect(w * 0.09, h * 0.09, w * 0.82, h * 0.82);
    } else if (v === 1 || v === 3) {
      // 四角括号
      var m = Math.min(w, h) * 0.09;
      var corners = [[0.05, 0.06, 1, 1], [0.95, 0.06, -1, 1], [0.05, 0.94, 1, -1], [0.95, 0.94, -1, -1]];
      for (var c = 0; c < corners.length; c++) {
        var q = corners[c];
        ctx.beginPath();
        ctx.moveTo(q[0] * w + q[2] * m, q[1] * h);
        ctx.lineTo(q[0] * w, q[1] * h);
        ctx.lineTo(q[0] * w, q[1] * h + q[3] * m);
        ctx.stroke();
      }
    } else if (v === 2 || v === 6) {
      // 跑马灯条 / 标尺框
      for (var t = 0; t < 26; t++) {
        var tx = w * (0.05 + t * 0.035);
        var len = t % 5 === 0 ? 18 : 7;
        ctx.beginPath();
        ctx.moveTo(tx, h * 0.055); ctx.lineTo(tx, h * 0.055 + len);
        ctx.moveTo(tx, h * 0.945); ctx.lineTo(tx, h * 0.945 - len);
        ctx.stroke();
      }
    } else if (v === 4) {
      // 点阵列
      for (var dx = 0; dx < 12; dx++) {
        for (var dy = 0; dy < 8; dy++) {
          ctx.beginPath();
          ctx.arc(w * (0.08 + dx * 0.076), h * (0.12 + dy * 0.105), 1.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    } else {
      // 弧规
      for (var a = 0; a < 5; a++) {
        ctx.beginPath();
        ctx.arc(w * 0.5, h * 0.5, Math.min(w, h) * (0.16 + a * 0.09), -0.9, 0.9);
        ctx.stroke();
      }
    }

    // 大几何：圆环 / 菱形 / 六边形，按种子选，只在大字镜头出现。
    if (shot.kind === 'type-impact' || shot.kind === 'poster-blocks') {
      ctx.globalAlpha = 0.18;
      var cx = w * 0.5, cy = h * 0.5, r = Math.min(w, h) * 0.34;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
      ctx.stroke();
      for (var k = 0; k < 6; k++) {
        var ang = k * Math.PI / 3 + now * 0.05;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
        ctx.stroke();
      }
    }

    // 浮动小图形：位置是 f(now) 的纯函数，不累积粒子状态。
    ctx.globalAlpha = 0.32;
    for (var p = 0; p < 22; p++) {
      var px = w * (0.05 + hashUnit(shot.seed * 3.3 + p * 2.7) * 0.90)
        + Math.sin(now * 0.35 + p) * 12;
      var py = h * (0.05 + hashUnit(shot.seed * 5.9 + p * 4.1) * 0.90)
        + Math.cos(now * 0.27 + p * 1.7) * 10;
      var sz = 2 + hashUnit(shot.seed + p * 9.3) * 5;
      var shape = p % 4;
      ctx.beginPath();
      if (shape === 0) ctx.rect(px - sz / 2, py - sz / 2, sz, sz);
      else if (shape === 1) ctx.arc(px, py, sz / 2, 0, Math.PI * 2);
      else if (shape === 2) {
        ctx.moveTo(px, py - sz); ctx.lineTo(px + sz, py);
        ctx.lineTo(px, py + sz); ctx.lineTo(px - sz, py); ctx.closePath();
      } else {
        ctx.moveTo(px - sz, py); ctx.lineTo(px + sz, py);
        ctx.moveTo(px, py - sz); ctx.lineTo(px, py + sz);
      }
      if (shape === 3) ctx.stroke(); else ctx.stroke();
    }
    ctx.restore();
  }

  function hideStageWebglLyrics(hidden) {
    var group = typeof stageLyrics !== 'undefined' && stageLyrics && stageLyrics.group;
    if (!group) return;
    if (hidden) {
      if (group.visible) { group.visible = false; groupHiddenBySonnet = true; }
    } else if (groupHiddenBySonnet) {
      group.visible = true;
      groupHiddenBySonnet = false;
    }
  }

  function clearOverlay() {
    if (!root) return;
    root.classList.remove('show');
    activeShotIndex = -1;
    glyphs = [];
    wordNodes = [];
    activeTracking = null;
    lastFocus = null;
    if (shotNode) shotNode.textContent = '';
  }

  function tick() {
    try {
      if (!sonnetUsable()) {
        hideStageWebglLyrics(false);
        clearOverlay();
        return;
      }
      ensureRoot();
      hideStageWebglLyrics(true);
      var trackToken = typeof trackSwitchToken !== 'undefined' ? trackSwitchToken : 0;
      if (trackToken !== lastTrackToken) {
        lastTrackToken = trackToken;
        trackSwitchQuietUntil = performance.now() + 600;
        programKey = '';
        clearOverlay();
        return;
      }
      if (performance.now() < trackSwitchQuietUntil) return;

      var lines = lyricsLines || [];
      var signature = programSignature(lines);
      if (!program || signature !== programKey) {
        program = compileProgram(lines, 0.618 + seedFrom(signature) * 0.3);
        programKey = signature;
        layoutW = viewW;
        layoutH = viewH;
        activeShotIndex = -1;
      }
      var now = lyricNowSeconds();
      var index = findShotIndex(program.shots, now);
      if (index < 0) {
        // 间奏/片尾：保留角标与线稿，只清文字。
        if (activeShotIndex !== -2) {
          activeShotIndex = -2;
          if (shotNode) shotNode.textContent = '';
          glyphs = [];
          wordNodes = [];
        }
        root.classList.add('show');
        return;
      }
      var shot = program.shots[index];
      if (index !== activeShotIndex) {
        activeShotIndex = index;
        buildShotDom(shot);
      }
      syncPalette();
      root.classList.add('show');
      root.dataset.transition = shot.transition;
      lastFocus = activeTracking ? resolveCameraFocus(shot, now, activeTracking) : null;
      cameraNode.style.transform = cameraFrame(shot, now, viewW, viewH, lastFocus);
      var tr = transitionFrame(shot, now);
      shotNode.style.opacity = tr.alpha.toFixed(3);
      shotNode.style.filter = tr.blur > 0.05 ? 'blur(' + tr.blur.toFixed(1) + 'px)' : '';
      root.style.setProperty('--fs-glitch', tr.glitch.toFixed(3));
      paintGlyphs(now);
      var stamp = performance.now();
      if (stamp - lastMgDraw >= MG_INTERVAL) {
        lastMgDraw = stamp;
        drawMg(shot, now);
      }
    } catch (err) {
      // 坏歌词数据不能拖垮渲染循环。
      window.__sonnetLastError = String((err && err.stack) || err);
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    tick();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', function () {
      if (!root) return;
      measureView();
      // 视口变化超过 2% 就重编译：版面是「量完再打包」的，尺寸一变量出来的结果就作废。
      if (!layoutW || !layoutH
        || Math.abs(viewW - layoutW) > layoutW * 0.02
        || Math.abs(viewH - layoutH) > layoutH * 0.02) {
        programKey = '';
      }
      activeShotIndex = -1;
      lastMgDraw = 0;
    });
  }

  // 词典是异步加载的：启动头几百毫秒里 splitWords() 还在用 Intl.Segmenter，
  // 词边界和就绪后不一样。就绪那一刻清掉 programKey，让 tick 就地重编译一次，
  // 播放位置不动，只是把词换准。和流光的 onReady 处理保持同一时机。
  if (window.cjkWordSegmenter && window.cjkWordSegmenter.onReady) {
    window.cjkWordSegmenter.onReady(function () {
      programKey = '';
    });
  }

  // QA hooks：隐藏窗口会节流 rAF，测试可以改完状态后同步推一帧。
  window.__mineradioSonnetTick = tick;
  window.__mineradioSonnetState = function () {
    return {
      shown: !!(root && root.classList.contains('show')),
      shotIndex: activeShotIndex,
      kind: root ? root.dataset.kind : '',
      shots: program ? program.shots.length : 0,
      words: wordNodes.length,
      glyphs: glyphs.length,
      focus: lastFocus,
      tracking: activeTracking ? activeTracking.count : 0
    };
  };
  if (window.__MINERADIO_TEST__) {
    window.__mineradioSonnetPure = {
      hashUnit: hashUnit, seedFrom: seedFrom, segmentWords: segmentWords,
      buildUnits: buildUnits, compileProgram: compileProgram, findShotIndex: findShotIndex,
      assignRoles: assignRoles, layoutUnits: layoutUnits,
      measureUnit: measureUnit, textEmAdvance: textEmAdvance,
      unitFontSize: unitFontSize, buildTracking: buildTracking,
      segmentFocusAt: segmentFocusAt, focusAtTime: focusAtTime,
      resolveCameraFocus: resolveCameraFocus,
      cameraFrame: cameraFrame, transitionFrame: transitionFrame,
      SHOT_KINDS: SHOT_KINDS, TRANSITIONS: TRANSITIONS, CAMERA_PATHS: CAMERA_PATHS,
      SAFE: [SAFE_MIN_X, SAFE_MAX_X, SAFE_MIN_Y, SAFE_MAX_Y]
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(frame); }, { once: true });
  } else {
    requestAnimationFrame(frame);
  }
})();
