'use strict';

// 录制 server/dj-analyzer.js 的**纯计算层**，产出 Rust 回放用例。
//
//   node scripts/record-dj-analyzer.js           # 打印到 stdout
//   node scripts/record-dj-analyzer.js --write   # 写 crates/mineradio-core/tests/fixtures/dj-analyzer-cases.jsonl
//   node scripts/record-dj-analyzer.js --check   # 只比对，不一致就非零退出（CI 用）
//
// 范围：buildBeatMapFromLowEnergy / planPodcastDjRangeWindows / buildRangeBeatsFromMaps /
// createPcmEnergyTap / percentile / median。
// **不含**解码器与 HTTP：mpg123 是 WASM，Rust 那边换成别的 MP3 解码后 PCM 不可能逐字节一致，
// 那条边界留到第二刀用 trait 注入验。
//
// PCM 用整数算法合成：xorshift32 出 u32 → 取高 16 位减 32768 → 除 32768（2 的幂，精确）→
// 鼓点位置乘 2 的幂再截断到 [-1,1]。全程没有 transcendental，Rust 侧能逐样本重建出
// **完全相同**的 PCM，于是「PCM → 能量」这一段可以拿 == 比，不用容差。

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'crates', 'mineradio-core', 'tests', 'fixtures', 'dj-analyzer-cases.jsonl');

// `buildBeatMapFromLowEnergy` 的返回值里有 analyzedAt: Date.now()。钉住它，
// 换台机器 --check 才不会红；Rust 侧把它当参数传。
const FIXED_NOW = 1764144000000;
Date.now = () => FIXED_NOW;

const dj = require('../server/dj-analyzer');

// ---------- 编码 ----------

function f32b64(arr) {
  const f = Float32Array.from(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

function f64b64(arr) {
  const f = Float64Array.from(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

// ---------- 确定性 PCM ----------

function xorshift(s) {
  s = (s ^ (s << 13)) >>> 0;
  s = (s ^ (s >>> 17)) >>> 0;
  s = (s ^ (s << 5)) >>> 0;
  return s;
}

// 按 spec 切块。Rust 侧必须用逐字相同的切块方式（chunkFrames 边界会影响
// frameCount 归零的时机？不会 —— 但会影响 decodedSamples 的累计与 n 的取值）。
function pcmChunks(spec) {
  const kick = spec.kick || null;
  const chunks = [];
  let s = spec.seed >>> 0;
  for (let start = 0; start < spec.frames; start += spec.chunkFrames) {
    const count = Math.min(spec.chunkFrames, spec.frames - start);
    const left = new Float64Array(count);
    const right = spec.channels === 2 ? new Float64Array(count) : null;
    for (let i = 0; i < count; i++) {
      const abs = start + i;
      const loud = kick ? (abs % kick.everyFrames) < kick.lenFrames : false;
      s = xorshift(s);
      let v = ((s >>> 16) - 32768) / 32768;
      if (loud) v = v * kick.gain;
      left[i] = Math.max(-1, Math.min(1, v));
      if (right) {
        s = xorshift(s);
        let w = ((s >>> 16) - 32768) / 32768;
        if (loud) w = w * kick.gain;
        right[i] = Math.max(-1, Math.min(1, w));
      }
    }
    chunks.push({ samplesDecoded: count, sampleRate: spec.sampleRate, left, right });
  }
  return chunks;
}

function runTap(spec) {
  const tap = dj.createPcmEnergyTap(spec.hopSec);
  const chunks = pcmChunks(spec);
  for (const c of chunks) {
    tap.processDecoded({
      samplesDecoded: c.samplesDecoded,
      sampleRate: c.sampleRate,
      channelData: c.right ? [c.left, c.right] : [c.left],
    });
  }
  // 真实现里这一步是 `tap.processDecoded(decoder.decode(new Uint8Array(0)))`，
  // 空 result 会被提前 return，等价于传 null。
  tap.processDecoded(null);
  tap.finish();
  return {
    low: f64b64(tap.lowEnergy),
    hit: f64b64(tap.hitEnergy),
    hopSec: spec.hopSec,
    duration: tap.effectiveSampleRate ? tap.effectiveSamples / tap.effectiveSampleRate : 0,
    decode: {
      chunks: chunks.length,
      decodedSamples: tap.decodedSamples,
      sampleRate: tap.sampleRate,
      effectiveSampleRate: tap.effectiveSampleRate,
      frames: tap.lowEnergy.length,
    },
  };
}

// ---------- 合成能量序列（不是 PCM，直接给 lowEnergy/hitEnergy） ----------

// 规律鼓点：指数衰减包络 + 整数散列出来的底噪。Math.exp 只影响「造数据」，
// 数组本身会被量化成 f32 存进 fixture，两侧拿到的是同一批数字。
function synthEnergy(frames, opts) {
  const o = opts || {};
  const hopSec = o.hopSec || 0.01;
  const step = o.stepSec || 0.5;
  const decay = o.decay || 9;
  const low = new Array(frames);
  const hit = new Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i * hopSec;
    const phase = (t % step) / step;
    const env = Math.exp(-phase * decay);
    const noise = (((i * 2654435761) >>> 0) % 1000) / 100000;
    low[i] = 0.02 + env * (o.lowAmp === undefined ? 0.35 : o.lowAmp) + noise;
    hit[i] = 0.01 + env * (o.hitAmp === undefined ? 0.8 : o.hitAmp) + noise * 2;
  }
  return { low, hit };
}

// 稀疏峰：只有给定帧附近有能量，用来逼出「候选不足 16 个 → strong 退回全体」分支。
function synthSparse(frames, peaks, base) {
  const b = base || 0.004;
  const low = new Array(frames).fill(b);
  const hit = new Array(frames).fill(b * 0.5);
  for (const p of peaks) {
    for (let d = 0; d < 4; d++) {
      const i = p + d;
      if (i >= 0 && i < frames) {
        low[i] = 0.42 - d * 0.06;
        hit[i] = 0.9 - d * 0.1;
      }
    }
  }
  return { low, hit };
}

// ---------- 用例 ----------

function mapCase(note, energy, hopSec, durationSec) {
  // 先量化到 f32 再喂进去 —— fixture 存的就是 f32，两侧输入必须逐位相同。
  const low = Array.from(Float32Array.from(energy.low));
  const hit = Array.from(Float32Array.from(energy.hit));
  const result = dj.buildBeatMapFromLowEnergy(low, hit, hopSec, durationSec);
  return {
    fn: 'buildBeatMapFromLowEnergy',
    note,
    args: {
      low: f32b64(low),
      hit: f32b64(hit),
      lowLen: low.length,
      hitLen: hit.length,
      hopSec,
      durationSec,
    },
    analyzedAt: FIXED_NOW,
    result,
  };
}

function rangeWindowsCase(note, duration, contentLength) {
  return {
    fn: 'planPodcastDjRangeWindows',
    note,
    args: [duration, contentLength],
    result: dj.planPodcastDjRangeWindows(duration, contentLength),
  };
}

function percentileCase(note, args) {
  let values;
  if (args.kind === 'seq') {
    values = [];
    for (let i = 0; i < args.n; i++) values.push(((i * 2654435761) >>> 0) % 100000 / 100000);
  } else {
    values = args.values;
  }
  return { fn: 'percentile', note, args, result: dj.percentile(values, args.p) };
}

function medianCase(note, arr) {
  return { fn: 'median', note, args: arr, result: dj.median(arr) };
}

function pcmCase(note, spec) {
  return { fn: 'createPcmEnergyTap', note, spec, out: runTap(spec) };
}

// 手写的小 sample map：buildRangeBeatsFromMaps 只读 time/impact/strength、
// duration、visualBeatCount、gridStep。字段给全但值很小，fixture 才不会爆。
function tinyBeat(time, impact, strength) {
  return { time, impact, strength };
}

function sampleMap(beats, duration, gridStep) {
  return { beats, cameraBeats: beats.slice(), duration, visualBeatCount: beats.length, gridStep };
}

function rangeBeatsCase(note, sampleMaps, duration, contentLength, totals) {
  const result = dj.buildRangeBeatsFromMaps(sampleMaps, duration, contentLength, totals);
  return {
    fn: 'buildRangeBeatsFromMaps',
    note,
    args: { sampleMaps, duration, contentLength, totals },
    analyzedAt: FIXED_NOW,
    result,
  };
}

function build() {
  const lines = [];

  // ---- 窗口规划：三档时长各自对应不同的采样数与窗口长度 ----
  lines.push(rangeWindowsCase('15 分钟：8 个窗口、96 秒窗', 900, 21_600_000));
  lines.push(rangeWindowsCase('3 小时：10 个窗口、88 秒窗', 10800, 259_200_000));
  lines.push(rangeWindowsCase('5 小时：12 个窗口、82 秒窗', 18000, 432_000_000));
  lines.push(rangeWindowsCase('比窗口还短的时长：targetTime 会被夹到 0', 60, 960_000));

  // ---- 分位/中位数：空、常规、超 16000 抽样 ----
  lines.push(percentileCase('空数组给 0.001', { kind: 'values', values: [], p: 0.5 }));
  lines.push(percentileCase('取到最小值 0 也算 0.001', { kind: 'values', values: [0, 0, 0, 1], p: 0.22 }));
  lines.push(percentileCase('小数组：下标是 floor(len*p)', { kind: 'values', values: [3, 1, 4, 1, 5, 9, 2, 6], p: 0.58 }));
  // 17001 > 16000 上限，走分层抽样；数组不落盘，两侧按同一整数公式重建（wrapping_mul 精确）。
  lines.push(percentileCase('17001 个样本走分层抽样（上限 16000）', { kind: 'seq', n: 17001, p: 0.86 }));
  lines.push(medianCase('中位数取 floor(len*0.5)', [5, 1, 4, 2, 3]));
  lines.push(medianCase('滤掉 NaN/Infinity 后为空', [NaN, Infinity, -Infinity]));

  // ---- PCM → 能量：三种采样率 + 单/双声道 ----
  lines.push(pcmCase('44.1k 立体声 6 秒，每 0.25 秒一次鼓点（sampleStep=4）', {
    sampleRate: 44100,
    frames: 264_600,
    channels: 2,
    seed: 20261126,
    chunkFrames: 4096,
    hopSec: 0.01,
    kick: { everyFrames: 11025, lenFrames: 1400, gain: 6 },
  }));
  lines.push(pcmCase('32k 单声道 5 秒（sampleStep=3，right 缺失）', {
    sampleRate: 32000,
    frames: 160_000,
    channels: 1,
    seed: 777001,
    chunkFrames: 3000,
    hopSec: 0.01,
    kick: { everyFrames: 8000, lenFrames: 900, gain: 4 },
  }));
  lines.push(pcmCase('22.05k 立体声 4 秒（sampleStep=2，hop 分帧跨块）', {
    sampleRate: 22050,
    frames: 88_200,
    channels: 2,
    seed: 51,
    chunkFrames: 1000,
    hopSec: 0.01,
    kick: { everyFrames: 5512, lenFrames: 600, gain: 5 },
  }));

  // ---- 能量序列 → 拍点网格 ----
  const dense20 = synthEnergy(2000, { stepSec: 0.5, decay: 9 });
  lines.push(mapCase('20 秒 120BPM 规律鼓点：完整路径（候选 ≥ 16，分段变速生效）', dense20, 0.01, 20));
  // 拍间隔 0.86 秒（≈70BPM，估速会被 clamp 到上界），时长 72.5 → 正好切出 2 段，
  // 第 2 段的候选全落在数组之外（数组只有 20 秒），用来逼出「seg 为空 → 沿用 prevStep」。
  lines.push(mapCase('72.5 秒但数组只有 20 秒：2 段 sectionSteps，后段 seg 为空靠 prevStep',
    synthEnergy(2000, { stepSec: 0.86, decay: 12 }), 0.01, 72.5));
  lines.push(mapCase('durationSec=0：回落到 nFrames*hopSec', synthEnergy(400, { stepSec: 0.6 }), 0.01, 0));
  lines.push(mapCase('候选不足 16 个：strong 退回全体候选', synthSparse(400, [40, 80, 120, 160, 200, 240, 280, 320]), 0.01, 4));
  lines.push(mapCase('全静音：onset 恒 0，候选为空 → 空结果', {
    low: new Array(400).fill(0),
    hit: new Array(400).fill(0),
  }, 0.01, 4));
  lines.push(mapCase('只有 15 帧：nFrames<20 直接空结果', {
    low: new Array(15).fill(0.1),
    hit: new Array(15).fill(0.2),
  }, 0.01, 0.15));
  {
    // low 比 hit 多 3 帧：分位数用完整 low，但 bandAt 的上界是 min(len)。
    const base = synthEnergy(400, { stepSec: 0.5 });
    const low = base.low.concat([0.9, 0.85, 0.8]);
    lines.push(mapCase('low 比 hit 长 3 帧：percentile 用完整数组，bandAt 用 min 上界', { low: low, hit: base.hit }, 0.01, 4));
  }

  // ---- 抽样分段合成 ----
  const beatA = [];
  for (let i = 0; i < 10; i++) beatA.push(tinyBeat(1.2 + i * 0.5, 0.14 + (i % 4) * 0.12, 0.3 + (i % 3) * 0.15));
  const beatB = [];
  for (let i = 0; i < 10; i++) beatB.push(tinyBeat(26.0 + i * 0.48, 0.2 + (i % 3) * 0.1, 0.35 + (i % 2) * 0.2));
  lines.push(rangeBeatsCase('两段 profile 插值 + 相位回填', [
    { offset: 0, map: sampleMap(beatA, 20, 0.5) },
    { offset: 25, map: sampleMap(beatB, 20, 0.48) },
  ], 40, 5_000_000, { chunks: 37, decodedSamples: 1_512_000 }));
  lines.push(rangeBeatsCase('一段全废：空 sampleMaps 走空结果', [], 40, 5_000_000, { chunks: 0, decodedSamples: 0 }));

  return lines;
}

function main() {
  const lines = build();
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body, 'utf8');
    console.log('已写入 ' + lines.length + ' 条 → ' + OUT + '（' + (body.length / 1024).toFixed(1) + ' KB）');
    return;
  }
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = fs.readFileSync(OUT, 'utf8');
    } catch (_) {
      current = '';
    }
    if (current === body) {
      console.log('dj-analyzer fixture 与当前实现一致（' + lines.length + ' 条）');
      return;
    }
    const old = current.trim().split('\n').filter(Boolean);
    console.error('dj-analyzer fixture 已过期：文件 ' + old.length + ' 条，实际 ' + lines.length + ' 条');
    for (let i = 0; i < Math.max(old.length, lines.length); i++) {
      if (old[i] !== JSON.stringify(lines[i])) {
        console.error('首个差异在第 ' + (i + 1) + ' 条：');
        console.error('  文件 ' + String(old[i]).slice(0, 300));
        console.error('  实际 ' + JSON.stringify(lines[i]).slice(0, 300));
        break;
      }
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(body);
}

main();
