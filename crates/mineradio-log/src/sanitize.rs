//! 结构裁剪：把"渲染进程递过来的任意对象"压成可以安全落盘的小 JSON。
//!
//! 这是 `desktop/logging.cjs` 里 `sanitize()` 的逐条移植，规则一条没改：
//! 字符串 400 字符截断（末尾加 `…`）、对象最多 20 个键、数组最多 12 项、
//! 嵌套到第 2 层就退化成 `[object]`、键名必须匹配 `^[A-Za-z0-9_.-]{1,48}$`。
//!
//! 与 JS 的两处已知差异（都不影响"该留的信息还在"）：
//!
//! 1. JS 按**插入顺序**取前 20 个键；Rust 的 `serde_json::Map` 默认是 BTreeMap，
//!    所以这里的"前 20 个"是按字典序。只有字段超过 20 个时才有区别。
//! 2. 截断按**字符**而不是 UTF-16 码元。纯 ASCII 与中文完全一致，只有 emoji 这类
//!    增补平面字符会多留几个 —— 日志里出现 400 个 emoji 的概率可以忽略。

use serde_json::{Map, Value};

/// 单条字符串的上限（截断后总长 401，含省略号）。
pub const MAX_STRING_CHARS: usize = 400;
/// 单个对象最多保留的键数。
pub const MAX_KEYS: usize = 20;
/// 数组最多保留的项数。
pub const MAX_ARRAY_ITEMS: usize = 12;
/// 允许的嵌套深度；第 2 层（顶层算 0）的对象/数组退化成 `[object]`。
pub const MAX_DEPTH: usize = 2;
/// 键名的最大长度。
pub const MAX_KEY_CHARS: usize = 48;

/// 键名白名单：`^[A-Za-z0-9_.-]{1,48}$`。
///
/// 这既是"别把奇怪的东西当键"的过滤，也是**不让键名破坏 JSON** 的保证 ——
/// 通过校验的键只含 ASCII 字母数字与 `_.-`，拼进 JSON 时不需要转义。
pub fn is_valid_key(key: &str) -> bool {
    if key.is_empty() || key.len() > MAX_KEY_CHARS {
        return false;
    }
    key.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// 按字符截断，超长时补 `…`（与 JS 的 `slice(0, 400) + '…'` 同形）。
pub fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max).collect();
    out.push('…');
    out
}

/// 裁剪任意 JSON 值（顶层入口）。
pub fn sanitize(value: &Value) -> Value {
    sanitize_at(value, 0)
}

fn sanitize_at(value: &Value, depth: usize) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => Value::String(truncate_chars(text, MAX_STRING_CHARS)),
        Value::Array(items) => {
            if depth >= MAX_DEPTH {
                return Value::String("[object]".to_string());
            }
            Value::Array(
                items
                    .iter()
                    .take(MAX_ARRAY_ITEMS)
                    .map(|item| sanitize_at(item, depth + 1))
                    .collect(),
            )
        }
        Value::Object(map) => {
            if depth >= MAX_DEPTH {
                return Value::String("[object]".to_string());
            }
            Value::Object(sanitize_object_at(map, depth))
        }
    }
}

/// 裁剪一层对象（键名过滤 + 数量上限）。
pub fn sanitize_object(map: &Map<String, Value>) -> Map<String, Value> {
    sanitize_object_at(map, 0)
}

fn sanitize_object_at(map: &Map<String, Value>, depth: usize) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in map.iter().take(MAX_KEYS) {
        if !is_valid_key(key) {
            continue;
        }
        out.insert(key.clone(), sanitize_at(value, depth + 1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn long_strings_are_clipped_with_an_ellipsis() {
        let value = Value::String("x".repeat(900));
        let Value::String(out) = sanitize(&value) else {
            panic!("应还是字符串");
        };
        assert_eq!(out.chars().count(), MAX_STRING_CHARS + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn short_strings_are_untouched() {
        assert_eq!(sanitize(&json!("你好")), json!("你好"));
    }

    #[test]
    fn arrays_are_capped_at_twelve_items() {
        let value = Value::Array((0..50).map(|i| json!(i)).collect());
        let Value::Array(out) = sanitize(&value) else {
            panic!("应还是数组");
        };
        assert_eq!(out.len(), MAX_ARRAY_ITEMS);
        assert_eq!(out[0], json!(0));
        assert_eq!(out[11], json!(11));
    }

    #[test]
    fn nesting_past_depth_two_collapses_to_object_marker() {
        let value = json!({ "a": { "b": { "c": "深" } } });
        let out = sanitize(&value);
        assert_eq!(out, json!({ "a": { "b": "[object]" } }));
    }

    #[test]
    fn objects_are_capped_and_bad_keys_dropped() {
        let mut map = Map::new();
        map.insert("bad key!".to_string(), json!(1));
        map.insert("emptyValue".to_string(), json!(null));
        map.insert("with/slash".to_string(), json!(2));
        for i in 0..30 {
            map.insert(format!("k{i:02}"), json!(i));
        }
        let out = sanitize(&Value::Object(map));
        let Value::Object(out) = out else {
            panic!("应还是对象");
        };
        // 非法键也占名额（与 JS 的 `keys++ >= 20` 同义），所以只会 ≤ 20。
        assert!(out.len() <= MAX_KEYS, "总量不能超过 20，实际 {}", out.len());
        assert!(out.len() >= 18, "也不该被非法键挤掉太多");
        assert!(!out.contains_key("bad key!"));
        assert!(!out.contains_key("with/slash"));
    }

    #[test]
    fn key_rules_are_exactly_the_documented_regex() {
        assert!(is_valid_key("provider"));
        assert!(is_valid_key("elapsedMs"));
        assert!(is_valid_key("a.b-c_1"));
        assert!(!is_valid_key(""));
        assert!(!is_valid_key("has space"));
        assert!(!is_valid_key("表情🙂"));
        assert!(
            is_valid_key(&"k".repeat(MAX_KEY_CHARS)),
            "刚好 48 个字符要放行"
        );
        assert!(!is_valid_key(&"k".repeat(MAX_KEY_CHARS + 1)));
    }

    #[test]
    fn nulls_and_booleans_survive() {
        assert_eq!(sanitize(&json!(null)), json!(null));
        assert_eq!(sanitize(&json!(true)), json!(true));
        assert_eq!(sanitize(&json!(1.5)), json!(1.5));
    }
}
