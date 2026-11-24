//! 用 rust-anything 录到的原始 JS 输出当基准，验证 `mineradio_core::static_assets` 与之逐条一致。
//!
//! fixture 是 `ztest/ra-static-assets/cases.jsonl` 的副本（`ztest/` 被 gitignore，进不了 CI）。
//! 重新录制的方式：
//!
//! ```bash
//! rust-anything bridge . server/static-assets.js -o ztest/ra-static-assets --force --keep "serveStatic: 需要活的 res 对象"
//! rust-anything record ztest/ra-static-assets --count 0 --inputs ztest/ra-static-assets/inputs.jsonl
//! rust-anything diff   ztest/ra-static-assets
//! cp ztest/ra-static-assets/cases.jsonl crates/mineradio-core/tests/fixtures/static-assets-cases.jsonl
//! ```
//!
//! 反过来也成立：这条测试红了，说明移植代码与原 JS 不一致，而不是 fixture 过期
//! （fixture 只在有人改 `server/static-assets.js` 时才该重录）。

use std::path::PathBuf;

use mineradio_core::static_assets::{etag_for, etag_matches, mime_for_path};
use serde_json::Value;

fn fixture_lines() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("static-assets-cases.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到 fixture {}：{e}", path.display()));
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("fixture 行不是合法 JSON"))
        .collect()
}

#[test]
fn static_etag_matches_recorded_javascript() {
    let mut checked = 0;
    for case in fixture_lines() {
        if case["fn"] != "staticEtag" {
            continue;
        }
        let expected = case["ok"].as_str().expect("成功的 staticEtag 用例应有 ok");
        let stat = &case["args"][0];
        let size = stat["size"].as_u64().expect("size 应为非负整数");
        let mtime_ms = stat["mtimeMs"].as_f64().expect("mtimeMs 应为数字");
        assert_eq!(
            etag_for(size, mtime_ms),
            expected,
            "staticEtag({stat}) 与 JS 不一致"
        );
        checked += 1;
    }
    assert!(checked >= 8, "只校验了 {checked} 条，fixture 可能被截断");
}

#[test]
fn etag_matches_recorded_javascript() {
    let mut checked = 0;
    let mut skipped = 0;
    for case in fixture_lines() {
        if case["fn"] != "etagMatches" {
            continue;
        }
        let header = match &case["args"][0] {
            Value::String(s) => Some(s.as_str()),
            Value::Null => None,
            // 录制里还有 `123` / `[]` 这类刻意喂的脏输入：它们的期望值（false）来自 JS 的
            // `String(x || '')` 强制转换，而生产路径的 header 只会来自 HeaderMap，永远是
            // 字符串或缺失。这几条的一致性由 rust-anything 的桥接层（23/23）兜住。
            _ => {
                skipped += 1;
                continue;
            }
        };
        let etag = case["args"][1].as_str().expect("etag 应为字符串");
        let expected = case["ok"].as_bool().expect("etagMatches 应返回布尔");
        assert_eq!(
            etag_matches(header, etag),
            expected,
            "etagMatches({:?}, {etag:?}) 与 JS 不一致",
            header
        );
        checked += 1;
    }
    assert!(checked >= 13, "只校验了 {checked} 条，fixture 可能被截断");
    assert!(
        skipped <= 2,
        "跳过的脏输入变多了（{skipped} 条），需要重新评估"
    );
}

#[test]
fn mime_table_is_shared_with_the_static_handler() {
    // 这只是防止有人把 `.js` 改成 `text/javascript` 而没意识到前端按类型判断过。
    assert_eq!(mime_for_path("x.js"), "application/javascript");
    assert_eq!(mime_for_path("x.css"), "text/css");
}
