//! 播客锁拍的纯计算层：`server/dj-analyzer.js` 里不碰网络、不碰解码器的那一半。
//!
//! 分成两块，都是「给同样的输入必然给同样的输出」：
//!
//! 1. **PCM → 能量序列**（[`PcmEnergy`]）：高低通滤波（[`make_biquad`]）、按 hop 分帧、
//!    逐帧算 RMS 与峰值。这一半只用到 `+ - * /` 与 `sqrt`，IEEE-754 下逐比特可复现，
//!    回放用例因此可以拿 `==` 直接比。
//! 2. **能量序列 → 拍点网格**（[`build_beat_map`] / [`build_range_beats`]）：onset 检测、
//!    候选合并、速度直方图、相位搜索、分段变速、网格生成。里面有 `pow` / `sin` / `cos` /
//!    `atan2`，与 V8 的 libm 实现不保证逐比特一致，回放只能按相对容差比。
//!
//! 三个反直觉的地方，抄的时候都踩过：
//!
//! - **`onset` 是 `Float32Array`**。JS 里写 `onset[i] = ...` 会先舍入到 f32 再存，
//!   后续读出来是 f32 值提成 f64。Rust 侧必须同样用 `Vec<f32>` 存，否则误差会从
//!   onset 一路放大到 `score`、`power`，最后在候选筛选的阈值上翻分支。
//! - **滑动窗口的偏移是原实现自带的偏差**：主循环从 `f = winN + 4` 起跑，但窗口初值
//!   是 `[0, winN)`，每轮减的是 `onset[f - winN]`、加的是 `onset[f]`，于是第一次迭代后
//!   窗口索引集合是 `{0..winN-1} \\ {4} ∪ {winN+4}` —— 跳过了 4 号元素而不是连续滑动。
//!   这是既有行为，照抄；"顺手修正"会让回放红掉，且拍点位置整体偏移。
//! - **分位数和能量数组的长度不是一回事**。`percentile` 拿的是**完整**数组，
//!   而 `bandAt` 的索引上界是 `min(low.len, hit.len) - 1`。两个声道长度不等时
//!   （比如 hit 少一帧）这两处用的就不是同一段数据。
//!
//! 解码器（`mpg123-decoder` 的 WASM）不在这里：换成 Rust 的 MP3 解码后 PCM 不可能逐字节
//! 一致，那一刀走 trait 注入，只验「同样 PCM 喂进去得到的能量序列一致」。

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

/// 拉音频时的默认 UA（网易云认这个 referer 组合）。
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/// 超过这个长度的整曲分析会退化成抽样分段。
pub const FULL_STREAM_QUALITY_LIMIT_SEC: f64 = 7200.0;
/// 时长超过这个值就该走抽样分段，别整曲解码。
pub const FULL_STREAM_LIMIT_SEC: f64 = 3300.0;

/// `Math.max(0, Math.min(1, Number(v) || 0))`。
pub fn clamp01(v: f64) -> f64 {
    if v.is_nan() {
        return 0.0;
    }
    v.clamp(0.0, 1.0)
}

/// `Math.max(min, Math.min(max, Number(v) || 0))`。注意参数顺序是 `(v, min, max)`。
pub fn clamp_range(v: f64, min: f64, max: f64) -> f64 {
    let v = if v.is_nan() { 0.0 } else { v };
    v.max(min).min(max)
}

/// `percentile(arr, p)`：默认最多取 16000 个样本。
pub fn percentile(arr: &[f64], p: f64) -> f64 {
    percentile_sampled(arr, p, 16000)
}

/// 分层抽样后取分位。**下标是 `floor(len * p)` 而不是 `floor((len-1) * p)`**，
/// 且末端还会 `|| 0.001` —— 取到 0 也算 0.001。照抄。
pub fn percentile_sampled(arr: &[f64], p: f64, max_samples: usize) -> f64 {
    if arr.is_empty() {
        return 0.001;
    }
    let max_samples = if max_samples == 0 { 16000 } else { max_samples };
    let mut sample: Vec<f64> = if arr.len() <= max_samples {
        arr.to_vec()
    } else {
        let step = (arr.len() - 1) as f64 / (max_samples - 1) as f64;
        (0..max_samples)
            .map(|i| {
                let idx = ((i as f64 * step).floor() as usize).min(arr.len() - 1);
                arr[idx]
            })
            .collect()
    };
    sample.sort_by(|a, b| a.partial_cmp(b).expect("能量序列里不该出现 NaN"));
    let idx = ((sample.len() as f64 * p).floor() as usize).min(sample.len() - 1);
    let picked = sample[idx];
    if picked == 0.0 {
        0.001
    } else {
        picked
    }
}

/// `median(vals)`：先滤掉非有限值再排序。注意这里**没有** `|| 0.001` 兜底，
/// 空数组给 0。和 [`percentile`] 不一致是原实现如此。
pub fn median(vals: &[f64]) -> f64 {
    let mut v: Vec<f64> = vals.iter().copied().filter(|x| x.is_finite()).collect();
    v.sort_by(|a, b| a.partial_cmp(b).expect("median 里不该出现 NaN"));
    if v.is_empty() {
        0.0
    } else {
        v[((v.len() as f64) * 0.5).floor() as usize]
    }
}

/// 二阶 IIR 的状态。JS 那边是一个裸对象，字段名一一对应。
#[derive(Debug, Clone, Copy, Default)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
    pub x1: f64,
    pub x2: f64,
    pub y1: f64,
    pub y2: f64,
}

/// RBJ cookbook 的 highpass / lowpass，`freq` 先夹到 `[8, sr*0.45]`。
///
/// `q` 传 0（或 NaN）时退回 0.707 —— JS 的 `(q || 0.707)`。
pub fn make_biquad(highpass: bool, freq: f64, q: f64, sr: f64) -> Biquad {
    let freq = freq.max(8.0).min(sr * 0.45);
    let w0 = 2.0 * std::f64::consts::PI * freq / sr;
    let cos = w0.cos();
    let sin = w0.sin();
    let q = if q == 0.0 || q.is_nan() { 0.707 } else { q };
    let alpha = sin / (2.0 * q);
    let (b0, b1, b2) = if highpass {
        let c = (1.0 + cos) * 0.5;
        (c, -(1.0 + cos), c)
    } else {
        let c = (1.0 - cos) * 0.5;
        (c, 1.0 - cos, c)
    };
    let a0 = 1.0 + alpha;
    let a1 = -2.0 * cos;
    let a2 = 1.0 - alpha;
    let inv = 1.0 / a0;
    Biquad {
        b0: b0 * inv,
        b1: b1 * inv,
        b2: b2 * inv,
        a1: a1 * inv,
        a2: a2 * inv,
        x1: 0.0,
        x2: 0.0,
        y1: 0.0,
        y2: 0.0,
    }
}

impl Biquad {
    /// 直接二型（DF-II）单样本。
    pub fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// 一个拍点。字段顺序就是 JS 里 `beats.push({...})` 的字面量顺序，序列化后逐键对齐。
#[derive(Debug, Clone)]
pub struct Beat {
    pub time: f64,
    pub strength: f64,
    pub confidence: f64,
    pub impact: f64,
    /// **三态**：`true` / `false` / `null`。
    ///
    /// JS 里是 `impact >= 0.13 || (downbeat && kickRel >= 0.14) || (bestCand && kickRel >= 0.18)`
    /// —— 最后一项的左操作数是候选对象本身，没有候选时为 `null`，`null && x` 求值成 `null`
    /// 而不是 `false`。所以"这一拍没有候选且不满足前两个条件"时字段值是 `null`。
    /// 前端只做 falsy 判断，`null` 与 `false` 等价；但回放要逐值对齐，必须保住这个区别。
    pub primary: Option<bool>,
    pub camera: Option<bool>,
    pub pulse: bool,
    pub tone: &'static str,
    pub low: f64,
    pub body: f64,
    pub snap: f64,
    pub mass: f64,
    pub sharpness: f64,
    pub combo: &'static str,
    pub step: f64,
    pub index: usize,
    pub dj: bool,
    pub grid: bool,
    pub kick_only: bool,
    pub server: bool,
    /// 只有抽样分段路径会写 `sampled: true`；离线整段分析没有这个键。
    pub sampled: Option<bool>,
}

impl Beat {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("time".into(), json!(self.time));
        m.insert("strength".into(), json!(self.strength));
        m.insert("confidence".into(), json!(self.confidence));
        m.insert("impact".into(), json!(self.impact));
        m.insert("primary".into(), json!(self.primary));
        m.insert("camera".into(), json!(self.camera));
        m.insert("pulse".into(), json!(self.pulse));
        m.insert("tone".into(), json!(self.tone));
        m.insert("low".into(), json!(self.low));
        m.insert("body".into(), json!(self.body));
        m.insert("snap".into(), json!(self.snap));
        m.insert("mass".into(), json!(self.mass));
        m.insert("sharpness".into(), json!(self.sharpness));
        m.insert("combo".into(), json!(self.combo));
        m.insert("step".into(), json!(self.step));
        m.insert("index".into(), json!(self.index));
        m.insert("dj".into(), json!(self.dj));
        m.insert("grid".into(), json!(self.grid));
        m.insert("kickOnly".into(), json!(self.kick_only));
        m.insert("server".into(), json!(self.server));
        if let Some(sampled) = self.sampled {
            m.insert("sampled".into(), json!(sampled));
        }
        Value::Object(m)
    }
}

/// `pulseBeats` 里的一项 —— 比起完整 `Beat` 只留 8 个字段。
#[derive(Debug, Clone)]
pub struct PulseBeat {
    pub time: f64,
    pub strength: f64,
    pub impact: f64,
    pub combo: &'static str,
    pub low: f64,
    pub body: f64,
    pub snap: f64,
}

impl PulseBeat {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("time".into(), json!(self.time));
        m.insert("strength".into(), json!(self.strength));
        m.insert("impact".into(), json!(self.impact));
        m.insert("combo".into(), json!(self.combo));
        m.insert("low".into(), json!(self.low));
        m.insert("body".into(), json!(self.body));
        m.insert("snap".into(), json!(self.snap));
        m.insert("dj".into(), json!(true));
        Value::Object(m)
    }
}

/// 一段音频算出来的拍点图。
///
/// `grid_step` / `section_steps` / `debug` 是 `Option`，因为**空结果是另一套键序**：
/// 空结果里 `tempoSource` 排在 `visualBeatCount` 之后，而非空结果里它排在 `sectionSteps`
/// 与 `duration` 之间。前端读取不依赖键序，但回放要逐键对齐，所以 [`BeatMap::to_json`]
/// 按 `grid_step` 是否为空走两条完全不同的组装路径。
#[derive(Debug, Clone)]
pub struct BeatMap {
    pub kicks: Vec<f64>,
    pub beats: Vec<Beat>,
    pub camera_beats: Vec<Beat>,
    pub pulse_beats: Vec<PulseBeat>,
    pub grid_step: Option<f64>,
    pub section_steps: Option<Vec<f64>>,
    pub tempo_source: &'static str,
    pub duration: f64,
    pub visual_beat_count: usize,
    pub analyzed_at: i64,
    pub debug: Option<Value>,
}

impl BeatMap {
    /// 空结果：`nFrames < 20`、候选为空、抽样全废都走这里。
    pub fn empty(duration: f64, tempo_source: &'static str, analyzed_at: i64) -> Self {
        Self {
            kicks: Vec::new(),
            beats: Vec::new(),
            camera_beats: Vec::new(),
            pulse_beats: Vec::new(),
            grid_step: None,
            section_steps: None,
            tempo_source,
            duration,
            visual_beat_count: 0,
            analyzed_at,
            debug: None,
        }
    }

    /// 供 `analyzePodcastDjIntro` 打补丁用：覆盖时长与来源标签。
    pub fn retag(&mut self, duration: f64, tempo_source: &'static str) {
        self.duration = duration;
        self.tempo_source = tempo_source;
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kicks".into(), json!(self.kicks));
        m.insert(
            "beats".into(),
            Value::Array(self.beats.iter().map(Beat::to_json).collect()),
        );
        m.insert(
            "pulseBeats".into(),
            Value::Array(self.pulse_beats.iter().map(PulseBeat::to_json).collect()),
        );
        m.insert(
            "cameraBeats".into(),
            Value::Array(self.camera_beats.iter().map(Beat::to_json).collect()),
        );
        if self.grid_step.is_none() {
            // 空结果：duration → visualBeatCount → tempoSource → analyzedAt
            m.insert("duration".into(), json!(self.duration));
            m.insert("visualBeatCount".into(), json!(self.visual_beat_count));
            m.insert("tempoSource".into(), json!(self.tempo_source));
            m.insert("analyzedAt".into(), json!(self.analyzed_at as f64));
            return Value::Object(m);
        }
        // 正常结果：gridStep → sectionSteps → tempoSource → duration → ...
        m.insert("gridStep".into(), json!(self.grid_step.unwrap_or(0.5)));
        if let Some(steps) = &self.section_steps {
            m.insert("sectionSteps".into(), json!(steps));
        }
        m.insert("tempoSource".into(), json!(self.tempo_source));
        m.insert("duration".into(), json!(self.duration));
        m.insert("visualBeatCount".into(), json!(self.visual_beat_count));
        m.insert("analyzedAt".into(), json!(self.analyzed_at as f64));
        if let Some(debug) = &self.debug {
            m.insert("debug".into(), debug.clone());
        }
        Value::Object(m)
    }
}

/// onset 检测出来的一个候选峰。
///
/// 只留后续真正读的字段：JS 的 `cand` 里还有 `score` / `lowRel` / `raw`，但它们只在
/// 构造 `power` 时用一次，之后没有任何调用点读 —— 存下来反而会被 dead_code 抓。
#[derive(Debug, Clone, Copy)]
struct Cand {
    frame: i64,
    time: f64,
    low_tone: f64,
    hit_tone: f64,
    power: f64,
}

fn at_or_zero(arr: &[f64], idx: usize) -> f64 {
    arr.get(idx).copied().unwrap_or(0.0)
}

/// 能量序列 → 拍点网格。这是整个模块的核心，逐行照 `buildBeatMapFromLowEnergy` 搬。
///
/// `analyzed_at` 由调用方给（JS 里是 `Date.now()`）：它只进返回值不参与计算，
/// 做成参数才能让这一层保持纯函数。
pub fn build_beat_map(
    low_energy: &[f64],
    hit_energy: &[f64],
    hop_sec: f64,
    duration_sec: f64,
    analyzed_at: i64,
) -> BeatMap {
    let n_frames = low_energy.len().min(hit_energy.len());
    if n_frames < 20 {
        return BeatMap::empty(duration_sec, "podcast-dj-server-empty", analyzed_at);
    }

    // 三次邻域加权平均。索引上界用的是 `n_frames - 1`（两声道长度的较小值），
    // 而不是 `arr.len() - 1` —— 见模块头注释第 3 条。
    let band_at = |arr: &[f64], idx: i64| -> f64 {
        let n = n_frames as i64;
        let idx = idx.clamp(0, n - 1);
        let a = at_or_zero(arr, (idx - 1).max(0) as usize);
        let b = at_or_zero(arr, idx as usize);
        let c = at_or_zero(arr, (idx + 1).min(n - 1) as usize);
        (a + b * 2.0 + c) * 0.25
    };

    // 分位数拿的是**完整**数组，不是 n_frames 切片。
    let low_floor = 0.0004_f64.max(percentile(low_energy, 0.22));
    let low_mid = (low_floor + 0.0002).max(percentile(low_energy, 0.58));
    let low_ref = (low_mid + 0.0002).max(percentile(low_energy, 0.86));
    let low_ceil = (low_ref + 0.0004).max(percentile(low_energy, 0.96));
    let hit_ref = 0.0004_f64.max(percentile(hit_energy, 0.86));

    // f32 是硬要求，见模块头注释第 1 条。
    let mut onset = vec![0f32; n_frames];
    for i in 4..n_frames {
        let prev = low_energy[i - 1] * 0.62 + low_energy[i - 2] * 0.28 + low_energy[i - 3] * 0.10;
        let low_rise = (low_energy[i] - prev).max(0.0);
        let wide_rise = ((low_energy[i] + low_energy[i - 1]) * 0.5
            - (low_energy[i - 3] + low_energy[i - 4]) * 0.5)
            .max(0.0);
        let peak_rise = (hit_energy[i] - hit_energy[i - 2] * 0.84).max(0.0);
        onset[i] = (low_rise * 1.72 + wide_rise * 0.86 + peak_rise * 0.10) as f32;
    }
    let onset_f = |i: usize| -> f64 { onset.get(i).copied().unwrap_or(0.0) as f64 };

    let win_n = ((0.82 / hop_sec).round() as i64).max(52) as usize;
    let min_frame_gap = ((0.215 / hop_sec).round() as i64).max(18);
    let mut candidates: Vec<Cand> = Vec::new();
    let mut sum_o = 0.0_f64;
    let mut sq_o = 0.0_f64;
    for i in 0..win_n {
        let o = onset_f(i);
        sum_o += o;
        sq_o += o * o;
    }

    let loop_start = win_n + 4;
    let loop_end = n_frames.saturating_sub(4);
    if loop_start < loop_end {
        for f in loop_start..loop_end {
            // 窗口不是连续滑动的，见模块头注释第 2 条 —— 照抄。
            let mean = sum_o / win_n as f64;
            let std = (sq_o / win_n as f64 - mean * mean).max(0.0).sqrt();
            let th = mean + std * 1.66 + low_ref * 0.0038;
            let o = onset_f(f);
            if o > th && o >= onset_f(f - 1) && o > onset_f(f + 1) {
                let mut peak_f = f as i64;
                let mut peak_score = o + at_or_zero(low_energy, f) * 0.10;
                for pf in (f as i64 - 2)..=(f as i64 + 3) {
                    let ps = onset_f(pf as usize) + at_or_zero(low_energy, pf as usize) * 0.10;
                    if ps > peak_score {
                        peak_score = ps;
                        peak_f = pf;
                    }
                }
                let low_tone = (band_at(low_energy, peak_f) / low_ref).min(2.6);
                let hit_tone = (band_at(hit_energy, peak_f) / hit_ref).min(2.6);
                let low_rel = clamp01(
                    (band_at(low_energy, peak_f) - low_floor) / (low_ceil - low_floor).max(0.0001),
                );
                let score = (o - th) / (std + mean * 0.38 + low_ref * 0.012).max(0.0006);
                if score > 0.16 && (low_tone > 0.32 || low_rel > 0.22 || hit_tone > 0.52) {
                    let power = score * 0.56
                        + clamp01((low_tone - 0.22) / 1.42).powf(0.82) * 0.34
                        + hit_tone.min(1.5) * 0.08
                        + low_rel * 0.10;
                    let cand = Cand {
                        frame: peak_f,
                        time: peak_f as f64 * hop_sec,
                        low_tone,
                        hit_tone,
                        power,
                    };
                    match candidates.last() {
                        Some(last) if cand.frame - last.frame < min_frame_gap => {
                            if cand.power > last.power {
                                let n = candidates.len();
                                candidates[n - 1] = cand;
                            }
                        }
                        _ => candidates.push(cand),
                    }
                }
            }
            let old = onset_f(f - win_n);
            let next = onset_f(f);
            sum_o += next - old;
            sq_o += next * next - old * old;
        }
    }

    if candidates.is_empty() {
        let duration = if duration_sec == 0.0 {
            n_frames as f64 * hop_sec
        } else {
            duration_sec
        };
        return BeatMap::empty(duration, "podcast-dj-server-empty", analyzed_at);
    }

    let powers: Vec<f64> = candidates.iter().map(|c| c.power).collect();
    let p30 = percentile(&powers, 0.30);
    let p50 = percentile(&powers, 0.50);
    let p90 = (p50 + 0.001).max(percentile(&powers, 0.90));
    let p96 = (p90 + 0.001).max(percentile(&powers, 0.965));
    let mut strong: Vec<Cand> = candidates
        .iter()
        .copied()
        .filter(|c| c.power >= p50 && c.low_tone > 0.34)
        .collect();
    if strong.len() < 16 {
        strong = candidates.clone();
    }

    // 速度直方图：JS 用普通对象的整数键，迭代顺序是数值升序；BTreeMap 天然一致。
    let estimate_step = |list: &[Cand]| -> f64 {
        if list.len() < 3 {
            return 0.0;
        }
        const BIN: f64 = 0.006;
        let mut hist: BTreeMap<i64, f64> = BTreeMap::new();
        let mut med_gaps: Vec<f64> = Vec::new();
        for ai in 0..list.len() {
            let bi_end = (ai + 10).min(list.len());
            for bi in (ai + 1)..bi_end {
                let raw_gap = list[bi].time - list[ai].time;
                if raw_gap < 0.24 {
                    continue;
                }
                if raw_gap > 2.55 {
                    break;
                }
                for div in 1..=6 {
                    let g = raw_gap / div as f64;
                    if g < 0.31 {
                        break;
                    }
                    if g > 0.86 {
                        continue;
                    }
                    let weight = (list[ai].power * list[bi].power).max(0.001).sqrt()
                        / (((bi - ai) * div) as f64).sqrt();
                    let key = (g / BIN).round() as i64;
                    *hist.entry(key).or_insert(0.0) += weight;
                    med_gaps.push(g);
                }
            }
        }
        let keys: Vec<i64> = hist.keys().copied().collect();
        let mut best_key: Option<i64> = None;
        let mut best_score = 0.0;
        for key in keys {
            let score = hist[&key]
                + hist.get(&(key - 1)).copied().unwrap_or(0.0) * 0.72
                + hist.get(&(key + 1)).copied().unwrap_or(0.0) * 0.72;
            if score > best_score {
                best_score = score;
                best_key = Some(key);
            }
        }
        if let Some(best) = best_key {
            return best as f64 * BIN;
        }
        median(&med_gaps)
    };

    let mut global_step = estimate_step(&strong);
    if global_step == 0.0 {
        global_step = estimate_step(&candidates);
    }
    if global_step == 0.0 {
        global_step = 0.50;
    }
    global_step = clamp_range(global_step, 0.32, 0.86);

    let nearest_candidate = |center: f64, window_sec: f64, start_idx: usize| -> Option<usize> {
        let mut best: Option<usize> = None;
        let mut best_score = f64::NEG_INFINITY;
        let mut j = start_idx;
        while j < candidates.len() && candidates[j].time < center - window_sec {
            j += 1;
        }
        let mut ni = j;
        while ni < candidates.len() && candidates[ni].time <= center + window_sec {
            let dist = (candidates[ni].time - center).abs();
            let score = candidates[ni].power * (1.0 - dist / window_sec.max(0.001) * 0.42);
            if score > best_score {
                best = Some(ni);
                best_score = score;
            }
            ni += 1;
        }
        best
    };

    let natural_duration = n_frames as f64 * hop_sec;
    let effective_duration = if duration_sec == 0.0 {
        natural_duration
    } else {
        duration_sec
    };

    let score_phase = |anchor_time: f64, step: f64| -> f64 {
        let mut start = anchor_time;
        // 有意的累加循环（不是乘法）：浮点累积误差是原实现的一部分。
        while start - step > 0.05 {
            start -= step;
        }
        let end = effective_duration.min(180.0);
        let win = (step * 0.18).clamp(0.055, 0.125);
        let mut score = 0.0;
        let mut count = 0usize;
        let mut cursor = 0usize;
        let mut gt = start;
        while gt < end {
            while cursor < candidates.len() && candidates[cursor].time < gt - win {
                cursor += 1;
            }
            let mut best_score = 0.0;
            let mut pi = cursor;
            while pi < candidates.len() && candidates[pi].time <= gt + win {
                let dist = (candidates[pi].time - gt).abs();
                let s = candidates[pi].power * (1.0 - dist / win * 0.44);
                if s > best_score {
                    best_score = s;
                }
                pi += 1;
            }
            score += if best_score != 0.0 {
                best_score
            } else {
                -p30 * 0.08
            };
            count += 1;
            gt += step;
        }
        if count > 0 {
            score / count as f64
        } else {
            f64::NEG_INFINITY
        }
    };

    let phase_limit = effective_duration.min(180.0);
    let mut phase_source: Vec<Cand> = strong
        .iter()
        .copied()
        .filter(|c| c.time < phase_limit)
        .take(72)
        .collect();
    if phase_source.is_empty() {
        phase_source = strong.iter().copied().take(1).collect();
    }
    let mut best_anchor = phase_source.first().map(|c| c.time).unwrap_or(0.0);
    let mut best_anchor_score = f64::NEG_INFINITY;
    for cand in &phase_source {
        let score = score_phase(cand.time, global_step);
        if score > best_anchor_score {
            best_anchor_score = score;
            best_anchor = cand.time;
        }
    }
    let half_step = global_step * 0.5;
    if half_step >= 0.31 {
        let half_score = score_phase(best_anchor, half_step);
        if half_score > best_anchor_score * 1.04 {
            global_step = half_step;
        }
    }
    let mut anchor = best_anchor;
    while anchor - global_step > 0.05 {
        anchor -= global_step;
    }

    let duration = effective_duration;
    let section_len = if duration > 3600.0 { 96.0 } else { 72.0 };
    let section_count = ((duration / section_len).ceil() as i64).max(1) as usize;
    let mut section_steps: Vec<f64> = Vec::with_capacity(section_count);
    for si in 0..section_count {
        let t0 = si as f64 * section_len;
        let t1 = duration.min(t0 + section_len);
        let seg: Vec<Cand> = strong
            .iter()
            .copied()
            .filter(|c| c.time >= t0 && c.time < t1)
            .collect();
        let prev_step = section_steps.last().copied().unwrap_or(global_step);
        let mut local_step = estimate_step(&seg);
        if local_step == 0.0 {
            local_step = if prev_step != 0.0 {
                prev_step
            } else {
                global_step
            };
        }
        if prev_step != 0.0 {
            local_step = clamp_range(local_step, prev_step * 0.94, prev_step * 1.06);
        }
        if global_step != 0.0 {
            local_step = clamp_range(local_step, global_step * 0.86, global_step * 1.14);
        }
        section_steps.push(if prev_step != 0.0 {
            local_step * 0.30 + prev_step * 0.70
        } else {
            local_step
        });
    }
    let step_at = |time: f64| -> f64 {
        let idx =
            ((time / section_len).floor() as i64).clamp(0, section_steps.len() as i64 - 1) as usize;
        let s = section_steps[idx];
        if s != 0.0 {
            s
        } else if global_step != 0.0 {
            global_step
        } else {
            0.50
        }
    };

    let mut beats: Vec<Beat> = Vec::new();
    let mut grid_index = 0usize;
    let mut cursor_idx = 0usize;
    let mut grid_t = anchor;
    while grid_t < duration - 0.04 {
        let local_step = step_at(grid_t);
        if local_step <= 0.0 {
            // 原实现里走不到（step 恒 >= 0.32），纯防死循环。
            break;
        }
        let win_sec = (local_step * 0.20).clamp(0.060, 0.135);
        while cursor_idx < candidates.len() && candidates[cursor_idx].time < grid_t - win_sec {
            cursor_idx += 1;
        }
        let best_cand = nearest_candidate(grid_t, win_sec, cursor_idx).map(|i| candidates[i]);
        let gf = ((grid_t / hop_sec).round() as i64).clamp(0, n_frames as i64 - 1);
        let grid_low = band_at(low_energy, gf);
        let grid_hit = band_at(hit_energy, gf);
        let grid_low_tone = (grid_low / low_ref).min(2.6);
        let grid_hit_tone = (grid_hit / hit_ref).min(2.6);
        let (low_tone, hit_tone) = match best_cand {
            Some(c) => (
                (grid_low_tone * 0.62).max(c.low_tone),
                (grid_hit_tone * 0.62).max(c.hit_tone),
            ),
            None => (grid_low_tone, grid_hit_tone),
        };
        let dist_penalty = match best_cand {
            Some(c) => 1.0 - ((c.time - grid_t).abs() / win_sec).min(1.0) * 0.26,
            None => 0.54,
        };
        let base_power = match best_cand {
            Some(c) => c.power * dist_penalty,
            None => grid_low_tone * 0.25 + grid_hit_tone * 0.06,
        };
        let power_rel = clamp01((base_power - p30 * 0.78) / (p96 - p30 * 0.78).max(0.001));
        let low_rel = clamp01((grid_low - low_floor) / (low_ceil - low_floor).max(0.0001));
        let kick_rel =
            clamp01(power_rel * 0.74 + low_rel * 0.22 + clamp01((hit_tone - 0.26) / 1.70) * 0.04);
        let soft_grid = (best_cand.is_none() && low_rel < 0.20) || kick_rel < 0.16;
        let slot = grid_index % 4;
        let mut combo = match slot {
            0 => "downbeat",
            1 => "push",
            2 => "drop",
            _ => "rebound",
        };
        if kick_rel > 0.84 && combo != "downbeat" {
            combo = "accent";
        }
        let visual_rel = if kick_rel > 0.76 {
            0.76 + (kick_rel - 0.76) * 0.52
        } else {
            kick_rel
        };
        let down_lift = if combo == "downbeat" {
            if visual_rel > 0.18 {
                0.016 + visual_rel * 0.036
            } else {
                visual_rel * 0.028
            }
        } else {
            0.0
        };
        let section_gate = clamp01((kick_rel - 0.10) / 0.58);
        let mut impact = (0.022 + visual_rel.powf(1.62) * 0.86 + down_lift).clamp(0.020, 0.88);
        let mut strength =
            (0.13 + visual_rel.powf(1.12) * 0.68 + down_lift * 0.70).clamp(0.12, 0.93);
        if soft_grid {
            let soft_mul = if combo == "downbeat" { 0.48 } else { 0.30 };
            impact *= soft_mul;
            strength *= 0.58 + section_gate * 0.22;
        }
        let timing_pull = match best_cand {
            Some(_) => 0.24 + clamp01((kick_rel - 0.25) / 0.65) * 0.46,
            None => 0.0,
        };
        let source_time = match best_cand {
            Some(c) => grid_t * (1.0 - timing_pull) + c.time * timing_pull,
            None => grid_t,
        };
        // 对应 `impact >= 0.13 || (downbeat && kickRel >= 0.14) || (bestCand && kickRel >= 0.18)`。
        // 最后一项的左操作数是候选对象本身：没有候选时整个表达式是 null，不是 false。
        let camera_active: Option<bool> =
            if impact >= 0.13 || (combo == "downbeat" && kick_rel >= 0.14) {
                Some(true)
            } else {
                best_cand.map(|_| kick_rel >= 0.18)
            };
        let low_mix = (0.52 + visual_rel * 0.32 + low_tone * 0.035
            - if combo == "accent" { 0.10 } else { 0.0 })
        .clamp(0.42, 0.90);
        let body_mix = (0.060
            + visual_rel * 0.12
            + if combo == "push" { 0.18 } else { 0.0 }
            + if combo == "drop" { 0.24 } else { 0.0 })
        .clamp(0.035, 0.54);
        let snap_mix = (0.026
            + if combo == "accent" { 0.40 } else { 0.0 }
            + if combo == "rebound" { 0.08 } else { 0.0 }
            + visual_rel * 0.038)
            .clamp(0.015, 0.62);
        let index = beats.len();
        beats.push(Beat {
            time: source_time,
            strength,
            confidence: (0.46 + kick_rel * 0.43 + if best_cand.is_some() { 0.08 } else { -0.03 })
                .clamp(0.44, 0.99),
            impact,
            primary: camera_active,
            camera: camera_active,
            pulse: impact > 0.16 || (combo == "downbeat" && kick_rel >= 0.18),
            tone: "podcast-dj-server-low-grid",
            low: low_mix,
            body: body_mix,
            snap: snap_mix,
            mass: (low_mix * 0.72 + visual_rel.powf(1.22) * 0.24).clamp(0.36, 0.94),
            sharpness: (snap_mix * 1.18).clamp(0.03, 0.28),
            combo,
            step: local_step,
            index,
            dj: true,
            grid: true,
            kick_only: true,
            server: true,
            sampled: None,
        });
        grid_index += 1;
        grid_t += local_step;
    }

    let debug = json!({
        "candidates": candidates.len(),
        "hopSec": hop_sec,
        "lowRef": low_ref,
        "step": global_step,
    });
    assemble_map(
        beats,
        global_step,
        section_steps,
        "podcast-dj-server-low-offline",
        duration,
        analyzed_at,
        Some(debug),
    )
}

/// 把 `beats` 拆成三份视图并组装最终结构。两条生成路径（离线整段 / 抽样分段）共用。
fn assemble_map(
    beats: Vec<Beat>,
    grid_step: f64,
    section_steps: Vec<f64>,
    tempo_source: &'static str,
    duration: f64,
    analyzed_at: i64,
    debug: Option<Value>,
) -> BeatMap {
    // JS 是 `beats.filter(b => b.camera !== false)` —— `null` 也会被留下，不能用 truthy 判。
    let camera_beats: Vec<Beat> = beats
        .iter()
        .filter(|b| b.camera != Some(false))
        .cloned()
        .collect();
    let pulse_beats: Vec<PulseBeat> = beats
        .iter()
        .filter(|b| b.pulse && (b.impact >= 0.16 || b.combo == "downbeat"))
        .map(|b| PulseBeat {
            time: b.time,
            strength: b.strength,
            impact: b.impact,
            combo: b.combo,
            low: b.low,
            body: b.body,
            snap: b.snap,
        })
        .collect();
    let visual_beat_count = camera_beats.len();
    let kicks: Vec<f64> = beats.iter().map(|b| b.time).collect();
    BeatMap {
        kicks,
        beats,
        camera_beats,
        pulse_beats,
        grid_step: Some(grid_step),
        section_steps: Some(section_steps),
        tempo_source,
        duration,
        visual_beat_count,
        analyzed_at,
        debug,
    }
}

/// 把一个分块解码结果按 hop 累计成能量序列。
///
/// 与解码器完全解耦：喂进来的是 `[f64]` 声道数据，[`PcmEnergy::process_decoded`] 只做
/// 混音、滤波、分帧。第二刀换掉 `mpg123-decoder` 时这一半不用动。
#[derive(Debug, Clone)]
pub struct PcmEnergy {
    pub low_energy: Vec<f64>,
    pub hit_energy: Vec<f64>,
    pub hop_sec: f64,
    pub effective_samples: u64,
    pub decoded_samples: u64,
    /// 首个有效块报告的原始采样率（0 表示还没收到）。
    raw_sample_rate: f64,
    hp: Option<Biquad>,
    lp: Option<Biquad>,
    effective_sr: f64,
    sample_step: usize,
    hop_size: usize,
    frame_sum: f64,
    frame_peak: f64,
    frame_count: usize,
}

impl PcmEnergy {
    pub fn new(hop_sec: f64) -> Self {
        Self {
            low_energy: Vec::new(),
            hit_energy: Vec::new(),
            hop_sec,
            effective_samples: 0,
            decoded_samples: 0,
            raw_sample_rate: 0.0,
            hp: None,
            lp: None,
            effective_sr: 0.0,
            sample_step: 1,
            hop_size: 0,
            frame_sum: 0.0,
            frame_peak: 0.0,
            frame_count: 0,
        }
    }

    /// 试听 / 抽样窗口的 hop：>4200 秒降到 12.5ms。
    pub fn hop_for_range(duration_hint: f64) -> f64 {
        if duration_hint > 4200.0 {
            0.0125
        } else {
            0.010
        }
    }

    /// 整段分析的 hop：阈值更高（>9000 秒），因为这边是真要解完整曲。
    pub fn hop_for_full(duration_hint: f64) -> f64 {
        if duration_hint > 9000.0 {
            0.0125
        } else {
            0.010
        }
    }

    /// 滤波器只在首个有效块上初始化一次 —— 后续块换采样率也不重建，照抄。
    fn init_filters(&mut self, sample_rate: f64) {
        if self.effective_sr != 0.0 {
            return;
        }
        self.sample_step = if sample_rate >= 44100.0 {
            4
        } else if sample_rate >= 32000.0 {
            3
        } else {
            2
        };
        self.effective_sr = sample_rate / self.sample_step as f64;
        self.hop_size = ((self.effective_sr * self.hop_sec).floor() as usize).max(80);
        self.hp = Some(make_biquad(true, 32.0, 0.72, self.effective_sr));
        self.lp = Some(make_biquad(false, 178.0, 0.82, self.effective_sr));
        self.raw_sample_rate = sample_rate;
    }

    fn push_frame(&mut self) {
        let count = self.frame_count.max(1) as f64;
        self.low_energy.push((self.frame_sum / count).sqrt());
        self.hit_energy.push(self.frame_peak);
        self.frame_sum = 0.0;
        self.frame_peak = 0.0;
        self.frame_count = 0;
    }

    /// 一个解码块：`left` 必给，`right` 为空即单声道。
    ///
    /// `samples_decoded` 是解码器自报的有效样本数（可能小于声道数组长度，
    /// mpg123 的尾块就是这样），三者取最小。
    pub fn process_decoded(
        &mut self,
        samples_decoded: usize,
        sample_rate: f64,
        left: &[f64],
        right: Option<&[f64]>,
    ) {
        if samples_decoded == 0 || left.is_empty() {
            return;
        }
        let sr = if sample_rate == 0.0 {
            44100.0
        } else {
            sample_rate
        };
        self.init_filters(sr);
        let mut n = samples_decoded.min(left.len());
        if let Some(r) = right {
            n = n.min(r.len());
        }
        self.decoded_samples += n as u64;
        let mut hp = self.hp.expect("init_filters 之后必然有滤波器");
        let mut lp = self.lp.expect("init_filters 之后必然有滤波器");
        for i in (0..n).step_by(self.sample_step) {
            let x = match right {
                Some(r) => (left[i] + r[i]) * 0.5,
                None => left[i],
            };
            let y = lp.run(hp.run(x));
            let ay = y.abs();
            self.frame_sum += y * y;
            if ay > self.frame_peak {
                self.frame_peak = ay;
            }
            self.frame_count += 1;
            self.effective_samples += 1;
            if self.frame_count >= self.hop_size {
                self.push_frame();
            }
        }
        self.hp = Some(hp);
        self.lp = Some(lp);
    }

    /// 收尾：剩余不足一 hop 的样本也要成帧（用已累计的 `count` 做分母）。
    pub fn finish(&mut self) {
        if self.frame_count > 0 {
            self.push_frame();
        }
    }

    /// 已解码样本折算的时长。
    pub fn duration(&self) -> f64 {
        if self.effective_sr != 0.0 {
            self.effective_samples as f64 / self.effective_sr
        } else {
            0.0
        }
    }

    /// 与 JS 里 `decode: {...}` 的字段顺序一致。
    pub fn decode_info(&self, chunks: usize) -> Value {
        json!({
            "chunks": chunks,
            "decodedSamples": self.decoded_samples,
            "sampleRate": if self.effective_sr != 0.0 { self.effective_sr * self.sample_step as f64 } else { 0.0 },
            "effectiveSampleRate": self.effective_sr,
            "frames": self.low_energy.len(),
        })
    }
}

/// 试听分析时的一帧裁剪结果。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IntroTrim {
    /// 实际保留的帧数（可直接用作 `&low[..frame_limit]`）。
    pub frame_limit: usize,
    /// 拍点图覆盖到的时长。
    pub map_duration: f64,
}

/// `analyzePodcastDjIntro` 的前置裁剪。
///
/// `intro_sec` 先夹到 `[90, 240]`（默认 180），再按 `(intro+2)/hop` 多留两秒的帧 ——
/// 多出来的部分是为了让末段的 onset 检测有后继样本可用。
pub fn plan_intro_trim(low_len: usize, hop_sec: f64, intro_sec: Option<f64>) -> IntroTrim {
    let intro = clamp_range(intro_sec.unwrap_or(180.0), 90.0, 240.0);
    let hop = if hop_sec == 0.0 { 0.010 } else { hop_sec };
    let want = (((intro + 2.0) / hop.max(0.001)).ceil() as i64).max(1) as usize;
    let kept = want.min(low_len);
    IntroTrim {
        frame_limit: kept,
        map_duration: intro.min(kept as f64 * hop),
    }
}

/// 一个 HTTP Range 窗口的规划结果（不含请求本身）。
#[derive(Debug, Clone, PartialEq)]
pub struct RangeWindow {
    /// 这个窗口对应到整曲的近似秒数（用于给 profile 定位）。
    pub approx_offset: f64,
    /// `Range: bytes=<start>-<end>` 的起点。
    pub start_byte: i64,
    /// 终点（含）。
    pub end_byte: i64,
    /// 窗口名义长度（秒），作为 `durationSec` 传给解码层。
    pub window_sec: f64,
}

impl RangeWindow {
    pub fn range_header(&self) -> String {
        format!("bytes={}-{}", self.start_byte, self.end_byte)
    }
}

/// 长播客的抽样窗口规划：只算位置，不发请求。
///
/// 首个窗口从 0 开始（完整拿到头部与首帧），末个落在 88%，中间按 8%~88% 均分；
/// 非首窗口往前带一点 preroll，避免 Range 起点正好落在 MP3 帧中间导致首帧解不出来。
pub fn plan_range_windows(duration: f64, content_length: f64) -> Vec<RangeWindow> {
    if duration <= 0.0 || content_length <= 0.0 {
        return Vec::new();
    }
    let sample_count: usize = if duration > 14400.0 {
        12
    } else if duration > 9000.0 {
        10
    } else {
        8
    };
    let sample_window = if duration > 14400.0 {
        82.0
    } else if duration > 9000.0 {
        88.0
    } else {
        96.0
    };
    let byte_per_sec = content_length / duration.max(1.0);
    let mut windows = Vec::with_capacity(sample_count);
    for i in 0..sample_count {
        let pos = i as f64 / (sample_count - 1) as f64;
        let shaped = if i == 0 {
            0.0
        } else if i == sample_count - 1 {
            0.88
        } else {
            0.08 + pos * 0.80
        };
        let target_time = (duration - sample_window).min(duration * shaped).max(0.0);
        let preroll_bytes = if i == 0 {
            0.0
        } else {
            (byte_per_sec * 4.0).floor().min(384.0 * 1024.0)
        };
        let start_byte = ((target_time * byte_per_sec).floor() - preroll_bytes).max(0.0);
        let window_bytes =
            ((sample_window * byte_per_sec).floor() + preroll_bytes + 128.0 * 1024.0)
                .max(768.0 * 1024.0);
        let end_byte = (content_length - 1.0).min(start_byte + window_bytes);
        windows.push(RangeWindow {
            approx_offset: start_byte / content_length * duration,
            start_byte: start_byte as i64,
            end_byte: end_byte as i64,
            window_sec: sample_window,
        });
    }
    windows
}

/// 抽样分段里的一个 profile：某段音频的能量画像 + 相位。
#[derive(Debug, Clone, Copy)]
pub struct Profile {
    pub time: f64,
    pub avg: f64,
    pub hi: f64,
    pub activity: f64,
    pub step: f64,
    pub anchor: f64,
}

impl Profile {
    pub fn to_json(&self) -> Value {
        json!({
            "time": self.time,
            "avg": self.avg,
            "hi": self.hi,
            "activity": self.activity,
            "step": self.step,
            "anchor": self.anchor,
        })
    }
}

/// `phaseFromMap`：用圆均值求这段音频在网格上的相位。
///
/// 权重是 `0.20 + impact^1.45`，即抖动小的拍也要参与，只让重拍占主导。
fn phase_from_map(map: &BeatMap, base_step: f64) -> (f64, f64) {
    let raw_step = if base_step != 0.0 {
        base_step
    } else {
        match map.grid_step {
            Some(gs) if gs != 0.0 => gs,
            _ => 0.50,
        }
    };
    let step = clamp_range(raw_step, 0.32, 0.86);
    let source: &[Beat] = if map.camera_beats.is_empty() {
        &map.beats
    } else {
        &map.camera_beats
    };
    let beats: Vec<&Beat> = source
        .iter()
        .filter(|b| b.time.is_finite() && b.time > 0.35)
        .collect();
    if beats.is_empty() {
        return (0.0, step);
    }
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut total = 0.0;
    for b in &beats {
        let w = 0.20 + b.impact.max(0.0).powf(1.45);
        // JS 的 `%` 对正数就是 fmod；Rust 的 `%` 同样返回与被除数同号。
        let phase = ((b.time % step) + step) % step;
        let angle = phase / step * std::f64::consts::PI * 2.0;
        sx += angle.cos() * w;
        sy += angle.sin() * w;
        total += w;
    }
    if total <= 0.0 {
        return (((beats[0].time % step) + step) % step, step);
    }
    let mut angle = (sy / total).atan2(sx / total);
    if angle < 0.0 {
        angle += std::f64::consts::PI * 2.0;
    }
    (angle / (std::f64::consts::PI * 2.0) * step, step)
}

/// 抽样分段路径（`analyzePodcastDjRangeSamples`）的后半段：把各段的 map 合成一张全曲网格。
///
/// `sample_maps` 是 `(offset, map)` 列表，offset 是这段音频在整曲里的近似秒数。
/// 调用方负责过滤「beat 少于 8 个或没有 gridStep」的段 —— 这里假定传进来的都能用。
/// `total_chunks` / `total_decoded` 只是 `debug.decode` 的汇总，不参与计算。
pub fn build_range_beats(
    sample_maps: &[(f64, BeatMap)],
    duration: f64,
    content_length: f64,
    total_chunks: usize,
    total_decoded: u64,
    analyzed_at: i64,
) -> BeatMap {
    if sample_maps.is_empty() {
        return BeatMap::empty(duration, "podcast-dj-server-range-empty", analyzed_at);
    }

    let mut step_votes: Vec<f64> = Vec::new();
    for (_, map) in sample_maps {
        let w = (((map.visual_beat_count as f64) / 16.0).round() as i64).clamp(1, 16) as usize;
        let gs = map.grid_step.unwrap_or(0.50);
        for _ in 0..w {
            step_votes.push(gs);
        }
    }
    let median_vote = median(&step_votes);
    let base = if median_vote != 0.0 {
        median_vote
    } else {
        match sample_maps[0].1.grid_step {
            Some(gs) if gs != 0.0 => gs,
            _ => 0.50,
        }
    };
    let global_step = clamp_range(base, 0.32, 0.86);

    let first_map = &sample_maps[0].1;
    let first_beats: &[Beat] = if first_map.camera_beats.is_empty() {
        &first_map.beats
    } else {
        &first_map.camera_beats
    };
    let mut anchor = first_beats.first().map(|b| b.time).unwrap_or(0.0);
    while anchor - global_step > 0.05 {
        anchor -= global_step;
    }

    let mut profiles: Vec<Profile> = sample_maps
        .iter()
        .map(|(offset, map)| {
            let beats: &[Beat] = if map.camera_beats.is_empty() {
                &map.beats
            } else {
                &map.camera_beats
            };
            let impacts: Vec<f64> = beats
                .iter()
                .map(|b| b.impact)
                .filter(|v| v.is_finite())
                .collect();
            let active: Vec<f64> = impacts.iter().copied().filter(|v| *v >= 0.10).collect();
            let avg_impact = if active.is_empty() {
                0.16
            } else {
                active.iter().sum::<f64>() / active.len() as f64
            };
            let hi_impact = if impacts.is_empty() {
                avg_impact.max(0.55)
            } else {
                percentile_sampled(&impacts, 0.90, 4000)
            };
            let activity = beats.len() as f64 / map.duration.max(20.0);
            let (phase, _) = phase_from_map(map, global_step);
            Profile {
                time: *offset,
                avg: clamp_range(
                    avg_impact * clamp_range(activity / 1.65, 0.38, 1.05),
                    0.08,
                    0.72,
                ),
                hi: clamp_range(hi_impact, 0.18, 0.96),
                activity: clamp_range(activity / 1.65, 0.18, 1.12),
                step: global_step,
                anchor: offset + phase,
            }
        })
        .collect();
    // JS 的 sort 是稳定的，Rust 的 sort_by 也是。
    profiles.sort_by(|a, b| a.time.partial_cmp(&b.time).expect("profile 时间不该是 NaN"));

    // 线性插值取某时刻的画像。JS 里用引用相等判断「前后是同一个 profile」，
    // 这里记下标 —— 两个不同 profile 的 time 可能相同，比时间会误判。
    let profile_at = |time: f64| -> Profile {
        if profiles.len() == 1 {
            return profiles[0];
        }
        let mut prev_idx = 0usize;
        let mut next_idx = profiles.len() - 1;
        for (i, p) in profiles.iter().enumerate() {
            if p.time <= time {
                prev_idx = i;
            }
            if p.time >= time {
                next_idx = i;
                break;
            }
        }
        if prev_idx == next_idx {
            return profiles[prev_idx];
        }
        let prev = profiles[prev_idx];
        let next = profiles[next_idx];
        let mix = clamp01((time - prev.time) / (next.time - prev.time).max(1.0));
        Profile {
            time,
            avg: prev.avg + (next.avg - prev.avg) * mix,
            hi: prev.hi + (next.hi - prev.hi) * mix,
            activity: prev.activity + (next.activity - prev.activity) * mix,
            step: prev.step + (next.step - prev.step) * mix,
            anchor: prev.anchor,
        }
    };

    let mut beats: Vec<Beat> = Vec::new();
    let mut grid_index = 0usize;
    for si in 0..profiles.len() {
        let p = profiles[si];
        let start = if si == 0 {
            0.0
        } else {
            (profiles[si - 1].time + p.time) * 0.5
        };
        let end = if si == profiles.len() - 1 {
            duration
        } else {
            (p.time + profiles[si + 1].time) * 0.5
        };
        let local_step = global_step;
        let mut t = if p.anchor.is_finite() {
            p.anchor
        } else {
            anchor
        };
        while t - local_step > start {
            t -= local_step;
        }
        while t < start {
            t += local_step;
        }
        while t < end - 0.04 {
            if local_step <= 0.0 {
                break;
            }
            let prof = profile_at(t);
            let slot = grid_index % 4;
            let mut combo = match slot {
                0 => "downbeat",
                1 => "push",
                2 => "drop",
                _ => "rebound",
            };
            let section_energy =
                clamp01((prof.avg - 0.055) / 0.54) * clamp_range(prof.activity, 0.30, 1.10);
            let motion = ((grid_index as f64 * 1.618 + prof.avg * 9.7).sin() * 0.5
                + (grid_index as f64 * 0.317).sin() * 0.28)
                * (0.08 + section_energy * 0.17);
            let rel = clamp01(
                0.12 + section_energy * 0.70
                    + motion
                    + if combo == "downbeat" { 0.060 } else { 0.0 },
            );
            if rel > 0.82 && combo != "downbeat" {
                combo = "accent";
            }
            let visual_rel = if rel > 0.78 {
                0.78 + (rel - 0.78) * 0.50
            } else {
                rel
            };
            let combo_lift = match combo {
                "downbeat" => 0.10 * section_energy,
                "drop" => 0.050 * section_energy,
                "accent" => 0.075 * section_energy,
                _ => 0.0,
            };
            let impact = clamp_range(
                0.026 + visual_rel.powf(1.48) * (0.42 + prof.hi * 0.34) + combo_lift,
                0.020,
                0.90,
            );
            let strength = clamp_range(
                0.15 + visual_rel.powf(1.02) * 0.66 + combo_lift * 0.68,
                0.12,
                0.93,
            );
            let camera_active = impact >= 0.105 || (combo == "downbeat" && section_energy >= 0.16);
            let low = clamp_range(
                0.50 + visual_rel * 0.32
                    + if combo == "downbeat" {
                        0.050 * section_energy
                    } else {
                        0.0
                    }
                    - if combo == "accent" { 0.12 } else { 0.0 },
                0.42,
                0.90,
            );
            let body = clamp_range(
                0.06 + visual_rel * 0.15
                    + if combo == "push" {
                        0.22 * section_energy
                    } else {
                        0.0
                    }
                    + if combo == "drop" {
                        0.30 * section_energy
                    } else {
                        0.0
                    },
                0.045,
                0.56,
            );
            let snap = clamp_range(
                0.025
                    + visual_rel * 0.035
                    + if combo == "accent" {
                        0.40 * section_energy
                    } else {
                        0.0
                    }
                    + if combo == "rebound" {
                        0.12 * section_energy
                    } else {
                        0.0
                    },
                0.02,
                0.62,
            );
            let index = beats.len();
            beats.push(Beat {
                time: t,
                strength,
                confidence: 0.68 + visual_rel * 0.22,
                impact,
                primary: Some(camera_active),
                camera: Some(camera_active),
                pulse: impact > 0.16 || (combo == "downbeat" && section_energy >= 0.24),
                tone: "podcast-dj-server-range-grid",
                low,
                body,
                snap,
                mass: clamp_range(low * 0.72 + visual_rel.powf(1.22) * 0.24, 0.36, 0.94),
                sharpness: if combo == "accent" { 0.20 } else { 0.08 },
                combo,
                step: if local_step != 0.0 {
                    local_step
                } else if prof.step != 0.0 {
                    prof.step
                } else {
                    global_step
                },
                index,
                dj: true,
                grid: true,
                kick_only: true,
                server: true,
                sampled: Some(true),
            });
            grid_index += 1;
            t += local_step;
        }
    }

    let section_steps: Vec<f64> = profiles.iter().map(|p| p.step).collect();
    let debug = json!({
        "rangeSampled": true,
        "samples": sample_maps.len(),
        "profiles": profiles.iter().map(Profile::to_json).collect::<Vec<_>>(),
        "contentLength": content_length,
        "decode": { "chunks": total_chunks, "decodedSamples": total_decoded },
    });
    assemble_map(
        beats,
        global_step,
        section_steps,
        "podcast-dj-server-range-offline",
        duration,
        analyzed_at,
        Some(debug),
    )
}
