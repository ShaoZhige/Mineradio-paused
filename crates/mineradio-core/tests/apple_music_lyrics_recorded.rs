//! 用 rust-anything 录到的原始 JS 输出当基准，逐条回放 `mineradio_core::apple_music_lyrics`。
//!
//! fixture 是 `ztest/ra-am-lyrics/cases.jsonl` 的副本（`ztest/` 被 gitignore，进不了 CI）。
//! 输入不是自动生成的 —— `record --count 0` 之外的那 25 条是手写的，覆盖点见
//! `scripts/record-apple-music-lyrics.js` 的注释（背景人声、注音、实体、三种时间写法、
//! 空行、v1/v2 取舍、括号替换……）。重新录制的方式：
//!
//! ```bash
//! node scripts/record-apple-music-lyrics.js > ztest/ra-am-lyrics/inputs.jsonl
//! rust-anything record ztest/ra-am-lyrics --count 0 --inputs ztest/ra-am-lyrics/inputs.jsonl
//! cp ztest/ra-am-lyrics/cases.jsonl crates/mineradio-core/tests/fixtures/apple-music-lyrics-cases.jsonl
//! ```
//!
//! 这条测试红了，说明移植代码与原 JS 不一致，而不是 fixture 过期
//! （fixture 只在有人改 `server/apple-music-lyrics.js` 时才该重录）。

use std::path::PathBuf;

use mineradio_core::apple_music_lyrics::convert_apple_music_ttml_to_lyric;
use serde_json::Value;

fn fixture_lines() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("apple-music-lyrics-cases.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到 fixture {}：{e}", path.display()));
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("fixture 行不是合法 JSON"))
        .collect()
}

#[test]
fn convert_matches_recorded_javascript() {
    let cases = fixture_lines();
    assert!(
        cases.len() >= 32,
        "fixture 只剩 {} 条，可能被截断",
        cases.len()
    );

    let mut checked = 0;
    for case in &cases {
        assert_eq!(case["fn"], "convertAppleMusicTtmlToLyric");
        // JS 侧是 `typeof ttml === 'string' ? ttml : ''`，所以非字符串一律当空串喂。
        let input = case["args"][0].as_str().unwrap_or("");
        let actual = convert_apple_music_ttml_to_lyric(input);

        match &case["ok"] {
            Value::Null => assert!(
                actual.is_none(),
                "JS 返回 null，Rust 却给出了 {:?}（输入 {:?}）",
                actual,
                short(input)
            ),
            expected => {
                let actual = actual.unwrap_or_else(|| {
                    panic!("JS 有输出，Rust 返回 None（输入 {:?}）", short(input))
                });
                assert_eq!(
                    actual.lyric,
                    expected["lyric"].as_str().expect("lyric 应为字符串"),
                    "lyric 不一致（输入 {:?}）",
                    short(input)
                );
                assert_eq!(
                    actual.yrc,
                    expected["yrc"].as_str().expect("yrc 应为字符串"),
                    "yrc 不一致（输入 {:?}）",
                    short(input)
                );
                assert_eq!(
                    actual.timing,
                    expected["timing"].as_str().expect("timing 应为字符串"),
                    "timing 不一致（输入 {:?}）",
                    short(input)
                );
                assert_eq!(
                    actual.line_count as u64,
                    expected["lineCount"].as_u64().expect("lineCount 应为整数"),
                    "lineCount 不一致（输入 {:?}）",
                    short(input)
                );
            }
        }
        checked += 1;
    }
    assert_eq!(checked, cases.len());
}

/// 断言消息里只放前 80 个字符，避免一条 4 KB 的 TTML 把输出刷满。
fn short(input: &str) -> String {
    let head: String = input.chars().take(80).collect();
    if input.chars().count() > 80 {
        format!("{head}…")
    } else {
        head
    }
}
