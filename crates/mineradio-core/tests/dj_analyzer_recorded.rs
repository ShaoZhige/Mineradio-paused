//! `dj_analyzer` 的行为回放。
//!
//! 用例由 `scripts/record-dj-analyzer.js` 从真实的 JS 实现录出来：
//!
//! 重录：`node scripts/record-dj-analyzer.js --write`
//! 检查同步：`npm run dj:check`
//!
//! 两种比对强度，刻意分开：
//!
//! - **PCM → 能量（`createPcmEnergyTap`）逐比特比**。这一段只有 `+ - * / sqrt`，
//!   IEEE-754 下可复现；PCM 本身由 xorshift32 的整数输出合成，Rust 侧能逐样本重建。
//!   拿 `==` 比而不是容差，任何一处滤波系数或分帧边界抄错都会立刻红。
//! - **能量 → 拍点（`buildBeatMapFromLowEnergy` / `buildRangeBeatsFromMaps`）用 1e-9 相对容差**。
//!   这一层有 `pow / sin / cos / atan2`，V8 的 libm 与 Rust 的不保证逐比特一致
//!   （正常也就差几个 ulp，1e-9 已经宽了两个数量级）。

use std::collections::BTreeMap;

use base64::Engine;
use mineradio_core::dj_analyzer::{
    build_beat_map, build_range_beats, median, percentile, plan_intro_trim, plan_range_windows,
    Beat, BeatMap, PcmEnergy,
};
use serde_json::{json, Value};

const FIXTURE: &str = include_str!("fixtures/dj-analyzer-cases.jsonl");
/// 浮点相对容差。见文件头：这一层不可能逐比特。
const TOL: f64 = 1e-9;

fn b64_bytes(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .unwrap_or_else(|e| panic!("base64 解不开：{e}"))
}

fn f32_from_b64(text: &str) -> Vec<f64> {
    let bytes = b64_bytes(text);
    let (words, _) = bytes.as_chunks::<4>();
    words
        .iter()
        .map(|c| f32::from_le_bytes(*c) as f64)
        .collect()
}

fn f64_from_b64(text: &str) -> Vec<f64> {
    let bytes = b64_bytes(text);
    let (words, _) = bytes.as_chunks::<8>();
    words.iter().map(|c| f64::from_le_bytes(*c)).collect()
}

/// 递归比对，同时检查键序。
///
/// `serde_json` 开了 `preserve_order`，但 `Value` 的 `PartialEq` 对 Map 是**顺序无关**的，
/// 所以不能拿 `assert_eq!` 判整体 —— 键序必须单独比。前端虽然不依赖键序，
/// 但回放要能抓到「字段顺序写错」这种只在 diff 时才暴露的问题。
fn compare(path: &str, expected: &Value, actual: &Value, tol: f64) {
    match (expected, actual) {
        (Value::Object(exp), Value::Object(act)) => {
            let exp_keys: Vec<&String> = exp.keys().collect();
            let act_keys: Vec<&String> = act.keys().collect();
            assert_eq!(exp_keys, act_keys, "{path} 的键集或键序不一致");
            for (key, value) in exp {
                compare(&format!("{path}.{key}"), value, &act[key], tol);
            }
        }
        (Value::Array(exp), Value::Array(act)) => {
            assert_eq!(exp.len(), act.len(), "{path} 长度不一致");
            for (i, (e, a)) in exp.iter().zip(act.iter()).enumerate() {
                compare(&format!("{path}[{i}]"), e, a, tol);
            }
        }
        (Value::Number(exp), Value::Number(act)) => {
            let e = exp.as_f64().expect("数字");
            let a = act.as_f64().expect("数字");
            let scale = e.abs().max(a.abs()).max(1.0);
            let diff = (e - a).abs();
            assert!(
                diff <= tol * scale,
                "{path} 数值差 {diff:e}（期望 {e} 实际 {a}，容差 {:e}）",
                tol * scale
            );
        }
        _ => assert_eq!(expected, actual, "{path} 类型或值不一致"),
    }
}

fn num_eq(path: &str, expected: f64, actual: f64, tol: f64) {
    compare(path, &json!(expected), &json!(actual), tol);
}

fn cases() -> Vec<Value> {
    FIXTURE
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("用例不是合法 JSON"))
        .collect()
}

fn label(case: &Value, index: usize) -> String {
    format!(
        "#{} {} — {}",
        index + 1,
        case["fn"].as_str().unwrap_or("?"),
        case["note"].as_str().unwrap_or("")
    )
}

// ---------- 纯工具 ----------

#[test]
fn replay_percentile_and_median() {
    for (i, case) in cases().iter().enumerate() {
        match case["fn"].as_str().unwrap_or("") {
            "percentile" => {
                let args = &case["args"];
                let values: Vec<f64> = match args["kind"].as_str().unwrap_or("values") {
                    // 17001 个样本不落盘，两侧按同一整数公式重建（wrapping_mul 精确等价于 JS 的 >>> 0）。
                    "seq" => {
                        let n = args["n"].as_u64().expect("n") as u32;
                        (0..n)
                            .map(|i| {
                                (i.wrapping_mul(2_654_435_761u32) % 100_000) as f64 / 100_000.0
                            })
                            .collect()
                    }
                    _ => args["values"]
                        .as_array()
                        .expect("values")
                        .iter()
                        .map(|v| v.as_f64().expect("数字"))
                        .collect(),
                };
                let p = args["p"].as_f64().expect("p");
                num_eq(
                    &label(case, i),
                    case["result"].as_f64().expect("result"),
                    percentile(&values, p),
                    TOL,
                );
            }
            "median" => {
                // JSON 里 NaN/Infinity 序列化成 null，解析回来按 NaN 处理。
                let values: Vec<f64> = case["args"]
                    .as_array()
                    .expect("args")
                    .iter()
                    .map(|v| v.as_f64().unwrap_or(f64::NAN))
                    .collect();
                num_eq(
                    &label(case, i),
                    case["result"].as_f64().expect("result"),
                    median(&values),
                    TOL,
                );
            }
            _ => {}
        }
    }
}

// ---------- PCM → 能量（逐比特） ----------

fn xorshift(mut s: u32) -> u32 {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    s
}

/// 一个解码块：`(样本数, 采样率, 左声道, 右声道)`。右声道为 `None` 即单声道。
type PcmChunk = (usize, f64, Vec<f64>, Option<Vec<f64>>);

/// 按录制脚本里 `pcmChunks` 的同一套整数算法重建 PCM。
///
/// 每个样本都是 `((u32 >> 16) - 32768) / 32768`（除数 2 的幂，精确），鼓点位置再乘
/// 2 的幂的增益并截断到 [-1, 1]（乘 2 的幂与 min/max 也都精确）。所以两侧的 PCM
/// 完全一致，不存在舍入分歧。
fn rebuild_pcm(spec: &Value) -> Vec<PcmChunk> {
    let sample_rate = spec["sampleRate"].as_f64().expect("sampleRate");
    let frames = spec["frames"].as_u64().expect("frames") as usize;
    let channels = spec["channels"].as_u64().expect("channels");
    let chunk_frames = spec["chunkFrames"].as_u64().expect("chunkFrames") as usize;
    let mut state = spec["seed"].as_u64().expect("seed") as u32;
    let kick = spec.get("kick").filter(|k| !k.is_null());
    let (every, len, gain) = match kick {
        Some(k) => (
            k["everyFrames"].as_u64().expect("everyFrames") as usize,
            k["lenFrames"].as_u64().expect("lenFrames") as usize,
            k["gain"].as_f64().expect("gain"),
        ),
        None => (0, 0, 0.0),
    };

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < frames {
        let count = chunk_frames.min(frames - start);
        let mut left = Vec::with_capacity(count);
        let mut right = if channels == 2 {
            Some(Vec::with_capacity(count))
        } else {
            None
        };
        for i in 0..count {
            let abs = start + i;
            let loud = kick.is_some() && (abs % every) < len;
            state = xorshift(state);
            let mut v = ((state >> 16) as f64 - 32768.0) / 32768.0;
            if loud {
                v *= gain;
            }
            left.push(v.clamp(-1.0, 1.0));
            if let Some(r) = right.as_mut() {
                state = xorshift(state);
                let mut w = ((state >> 16) as f64 - 32768.0) / 32768.0;
                if loud {
                    w *= gain;
                }
                r.push(w.clamp(-1.0, 1.0));
            }
        }
        chunks.push((count, sample_rate, left, right));
        start += count;
    }
    chunks
}

#[test]
fn replay_pcm_energy_bit_exact() {
    let mut seen = 0usize;
    for (i, case) in cases().iter().enumerate() {
        if case["fn"].as_str() != Some("createPcmEnergyTap") {
            continue;
        }
        seen += 1;
        let spec = &case["spec"];
        let hop_sec = spec["hopSec"].as_f64().expect("hopSec");
        let mut tap = PcmEnergy::new(hop_sec);
        let chunks = rebuild_pcm(spec);
        for (n, sr, left, right) in &chunks {
            tap.process_decoded(*n, *sr, left, right.as_deref());
        }
        tap.finish();

        let expected = &case["out"];
        let want_low = f64_from_b64(expected["low"].as_str().expect("low"));
        let want_hit = f64_from_b64(expected["hit"].as_str().expect("hit"));
        assert_eq!(
            tap.low_energy.len(),
            want_low.len(),
            "{} 帧数不一致",
            label(case, i)
        );
        // 逐比特：这一段没有 transcendental，容差比对反而会漏掉滤波系数写错。
        for (k, (got, want)) in tap.low_energy.iter().zip(want_low.iter()).enumerate() {
            assert_eq!(
                got.to_bits(),
                want.to_bits(),
                "{} lowEnergy[{k}] 期望 {want:?} 实际 {got:?}",
                label(case, i)
            );
        }
        for (k, (got, want)) in tap.hit_energy.iter().zip(want_hit.iter()).enumerate() {
            assert_eq!(
                got.to_bits(),
                want.to_bits(),
                "{} hitEnergy[{k}] 期望 {want:?} 实际 {got:?}",
                label(case, i)
            );
        }
        num_eq(
            &format!("{} duration", label(case, i)),
            expected["duration"].as_f64().expect("duration"),
            tap.duration(),
            TOL,
        );
        compare(
            &format!("{} decode", label(case, i)),
            &expected["decode"],
            &tap.decode_info(chunks.len()),
            TOL,
        );
    }
    assert_eq!(seen, 3, "PCM 用例条数变了");
}

// ---------- 能量 → 拍点 ----------

#[test]
fn replay_build_beat_map() {
    let mut seen = 0usize;
    for (i, case) in cases().iter().enumerate() {
        if case["fn"].as_str() != Some("buildBeatMapFromLowEnergy") {
            continue;
        }
        seen += 1;
        let args = &case["args"];
        let low = f32_from_b64(args["low"].as_str().expect("low"));
        let hit = f32_from_b64(args["hit"].as_str().expect("hit"));
        assert_eq!(
            low.len(),
            args["lowLen"].as_u64().expect("lowLen") as usize,
            "{} lowLen",
            label(case, i)
        );
        assert_eq!(
            hit.len(),
            args["hitLen"].as_u64().expect("hitLen") as usize,
            "{} hitLen",
            label(case, i)
        );
        let got = build_beat_map(
            &low,
            &hit,
            args["hopSec"].as_f64().expect("hopSec"),
            args["durationSec"].as_f64().expect("durationSec"),
            case["analyzedAt"].as_i64().expect("analyzedAt"),
        )
        .to_json();
        compare(&label(case, i), &case["result"], &got, TOL);
    }
    assert_eq!(seen, 7, "拍点图用例条数变了");
}

#[test]
fn replay_plan_range_windows() {
    let mut seen = 0usize;
    for (i, case) in cases().iter().enumerate() {
        if case["fn"].as_str() != Some("planPodcastDjRangeWindows") {
            continue;
        }
        seen += 1;
        let args = case["args"].as_array().expect("args");
        let got = plan_range_windows(
            args[0].as_f64().expect("duration"),
            args[1].as_f64().expect("contentLength"),
        );
        let got_json = Value::Array(
            got.iter()
                .map(|w| {
                    json!({
                        "windowSec": w.window_sec,
                        "startByte": w.start_byte,
                        "endByte": w.end_byte,
                        "approxOffset": w.approx_offset,
                    })
                })
                .collect(),
        );
        compare(&label(case, i), &case["result"], &got_json, TOL);
    }
    assert_eq!(seen, 4, "窗口规划用例条数变了");
}

/// 从 fixture 的 sample map 反序列化。只填 `buildRangeBeatsFromMaps` 真正读的字段。
fn beat_from_json(v: &Value) -> Beat {
    let strength = v["strength"].as_f64().unwrap_or(0.0);
    Beat {
        time: v["time"].as_f64().unwrap_or(0.0),
        strength,
        confidence: 0.0,
        // JS 里是 `b.impact == null ? (b.strength || 0.3) : b.impact`。
        impact: v["impact"]
            .as_f64()
            .unwrap_or(if strength == 0.0 { 0.3 } else { strength }),
        primary: None,
        camera: Some(true),
        pulse: false,
        tone: "",
        low: 0.0,
        body: 0.0,
        snap: 0.0,
        mass: 0.0,
        sharpness: 0.0,
        combo: "",
        step: 0.0,
        index: 0,
        dj: true,
        grid: true,
        kick_only: true,
        server: true,
        sampled: None,
    }
}

fn beat_map_from_json(v: &Value) -> BeatMap {
    let collect = |key: &str| -> Vec<Beat> {
        v[key]
            .as_array()
            .map(|items| items.iter().map(beat_from_json).collect())
            .unwrap_or_default()
    };
    BeatMap {
        kicks: Vec::new(),
        beats: collect("beats"),
        camera_beats: collect("cameraBeats"),
        pulse_beats: Vec::new(),
        grid_step: v["gridStep"].as_f64(),
        section_steps: None,
        tempo_source: "",
        duration: v["duration"].as_f64().unwrap_or(0.0),
        visual_beat_count: v["visualBeatCount"].as_u64().unwrap_or(0) as usize,
        analyzed_at: 0,
        debug: None,
    }
}

#[test]
fn replay_build_range_beats() {
    let mut seen = 0usize;
    for (i, case) in cases().iter().enumerate() {
        if case["fn"].as_str() != Some("buildRangeBeatsFromMaps") {
            continue;
        }
        seen += 1;
        let args = &case["args"];
        let maps: Vec<(f64, BeatMap)> = args["sampleMaps"]
            .as_array()
            .expect("sampleMaps")
            .iter()
            .map(|item| {
                (
                    item["offset"].as_f64().expect("offset"),
                    beat_map_from_json(&item["map"]),
                )
            })
            .collect();
        let got = build_range_beats(
            &maps,
            args["duration"].as_f64().expect("duration"),
            args["contentLength"].as_f64().expect("contentLength"),
            args["totals"]["chunks"].as_u64().expect("chunks") as usize,
            args["totals"]["decodedSamples"]
                .as_u64()
                .expect("decodedSamples"),
            case["analyzedAt"].as_i64().expect("analyzedAt"),
        )
        .to_json();
        compare(&label(case, i), &case["result"], &got, TOL);
    }
    assert_eq!(seen, 2, "抽样分段用例条数变了");
}

// ---------- 录制覆盖不到的分支 ----------

/// `plan_intro_trim` 没有对应回放用例（它内联在 `analyzePodcastDjIntro` 里，
/// 拆出来只为让 Rust 侧能对齐）。期望值按 JS 那三行手工推导：
///
/// ```js
/// introSec   = clampRange(Number(opts.introSec) || 180, 90, 240)
/// frameLimit = max(1, min(lowLen, ceil((introSec + 2) / max(0.001, hopSec || 0.010))))
/// mapDuration= min(introSec, keptLen * hopSec)
/// ```
#[test]
fn intro_trim_matches_js_formula() {
    // 默认 180 秒：多留 2 秒的帧，拍点图仍只覆盖 180 秒。
    let t = plan_intro_trim(20_000, 0.01, None);
    assert_eq!(t.frame_limit, 18_200);
    assert!((t.map_duration - 180.0).abs() < 1e-12);

    // 低于下界的 60 秒被抬到 90。
    let t = plan_intro_trim(20_000, 0.01, Some(60.0));
    assert_eq!(t.frame_limit, 9_200);
    assert!((t.map_duration - 90.0).abs() < 1e-12);

    // 高于上界的 999 秒被压到 240。
    let t = plan_intro_trim(30_000, 0.01, Some(999.0));
    assert_eq!(t.frame_limit, 24_200);
    assert!((t.map_duration - 240.0).abs() < 1e-12);

    // 音频比 frameLimit 短：全都要，mapDuration 按实际长度算。
    let t = plan_intro_trim(100, 0.01, None);
    assert_eq!(t.frame_limit, 100);
    assert!((t.map_duration - 1.0).abs() < 1e-12);

    // hopSec 给 0 时按 10ms 兜底，且 frameLimit 仍受 lowLen 限制。
    let t = plan_intro_trim(5_000, 0.0, None);
    assert_eq!(t.frame_limit, 5_000);
    assert!((t.map_duration - 50.0).abs() < 1e-12);

    // 空数组：JS 里 slice(0, 1) 得到空数组，mapDuration 归零。
    let t = plan_intro_trim(0, 0.01, None);
    assert_eq!(t.frame_limit, 0);
    assert_eq!(t.map_duration, 0.0);
}

/// 分位数的两个反直觉点，单独钉住（回放里那两条小用例也能抓，但这里意图更明确）。
#[test]
fn percentile_quirks() {
    // 下标是 floor(len * p)。len=4、p=0.22 → floor(0.88)=0，取最小值。
    // 排序后是 [0,0,0,1]，取到 0 时被 `|| 0.001` 兜成 0.001。
    assert_eq!(percentile(&[1.0, 0.0, 0.0, 0.0], 0.22), 0.001);
    // len=8、p=0.58 → floor(4.64)=4，排序后第 4 个（0 基）是 4。
    assert!((percentile(&[3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0], 0.58) - 4.0).abs() < 1e-12);
    // 空数组直接 0.001。
    assert_eq!(percentile(&[], 0.5), 0.001);
    // median 没有 0.001 兜底。
    assert_eq!(median(&[]), 0.0);
}

/// `BTreeMap` 与 JS 对象整数键的迭代顺序一致（数值升序），这是 `estimateStep`
/// 平票时取哪个 bin 的前提。这里直接钉住这个假设。
#[test]
fn btreemap_iterates_numeric_keys_ascending() {
    let mut hist: BTreeMap<i64, f64> = BTreeMap::new();
    for key in [93i64, 7, 52, 144, 61] {
        hist.insert(key, key as f64);
    }
    let keys: Vec<i64> = hist.keys().copied().collect();
    assert_eq!(keys, vec![7, 52, 61, 93, 144]);
}
