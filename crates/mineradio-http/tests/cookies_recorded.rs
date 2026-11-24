//! 回放 `scripts/record-cookie-header.js` 录下的 JS 真实输出。
//!
//! 重录三步：
//! ```text
//! node scripts/record-cookie-header.js > ztest/ra-cookie-header/cases.jsonl
//! cp ztest/ra-cookie-header/cases.jsonl crates/mineradio-http/tests/fixtures/cookie-header-cases.jsonl
//! cargo test -p mineradio-http
//! ```
//!
//! 录制格式（`__object__` / `__undefined__` 是为了让 JSON 能表达 JS 才有的东西）：
//! ```text
//! undefined                  → {"__undefined__": true}
//! { a: 1 }                   → {"__object__": [["a", 1]]}   ← 数组保序，普通 JSON 对象不保序
//! ["a=1", null]              → ["a=1", null]
//! "MUSIC_U=x"                → "MUSIC_U=x"
//! ```
//!
//! 不使用 `rust-anything bridge`：它要求导出函数的入参是"普通 JSON"，而这里的入参
//! 本身就是多态 JSON 形状，`undefined` 在其中无法表示。

use serde_json::Value;

use mineradio_http::{
    normalize_cookie_header, raw_cookie_fallback, CookieInput, DESKTOP_CHROME_UA,
};

const FIXTURE: &str = include_str!("fixtures/cookie-header-cases.jsonl");

/// 把录制格式还原成 [`CookieInput`]。
fn decode(value: &Value) -> CookieInput {
    match value {
        Value::Null => CookieInput::Null,
        Value::Bool(flag) => CookieInput::Bool(*flag),
        Value::Number(number) => CookieInput::Number(number.as_f64().expect("录制里只有常规数字")),
        Value::String(text) => CookieInput::text(text.as_str()),
        Value::Array(items) => CookieInput::Array(items.iter().map(decode).collect()),
        Value::Object(map) => {
            if map.contains_key("__undefined__") {
                return CookieInput::Undefined;
            }
            let Value::Array(pairs) = map.get("__object__").expect("对象必须以 __object__ 编码")
            else {
                panic!("__object__ 必须是数组：{value:?}");
            };
            CookieInput::object(pairs.iter().map(|pair| {
                let pair = pair.as_array().expect("对象条目必须是 [键, 值]");
                let key = pair[0].as_str().expect("键必须是字符串").to_string();
                (key, decode(&pair[1]))
            }))
        }
    }
}

fn cases() -> Vec<Value> {
    FIXTURE
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture 每行都得是合法 JSON"))
        .collect()
}

#[test]
fn every_recorded_case_replays() {
    let cases = cases();
    assert!(
        cases.len() >= 50,
        "fixture 只剩 {} 条，可能被截断了",
        cases.len()
    );

    let mut checked = 0usize;
    for case in &cases {
        let function = case["fn"].as_str().expect("缺少 fn");
        let note = case["note"].as_str().unwrap_or("");
        let input = decode(&case["args"][0]);
        let expected = case["ok"].as_str().expect("录制结果必须是字符串");

        let actual = match function {
            "normalizeCookieHeader" => normalize_cookie_header(&input),
            "rawCookieFallback" => raw_cookie_fallback(&input),
            other => panic!("未知函数 {other}"),
        };

        assert_eq!(actual, expected, "{function} [{note}]");
        checked += 1;
    }

    assert_eq!(checked, cases.len(), "有条目被跳过");
}

/// 两个函数都在录里出现，否则"通过"可能只是因为只测了一半。
#[test]
fn fixture_covers_both_functions() {
    let cases = cases();
    let names: Vec<&str> = cases
        .iter()
        .map(|case| case["fn"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"normalizeCookieHeader"));
    assert!(names.contains(&"rawCookieFallback"));
}

/// UA 必须与 JS 源码逐字一致 —— 这是"改一处忘一处"最容易漏的地方。
///
/// 用读文件而不是 `include_str!`：后者会把 7266 行的 server.js 编进测试二进制，
/// 每次改 JS 都要重新编译一遍测试。
#[test]
fn desktop_ua_matches_the_js_source() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/server.js");
    let source = std::fs::read_to_string(&path).expect("读不到 server/server.js");
    let expected = format!("const UA = '{DESKTOP_CHROME_UA}';");
    assert!(
        source.contains(&expected),
        "server/server.js 里的 UA 与 DESKTOP_CHROME_UA 不一致"
    );
}
