//! JS 值语义的 Rust 复刻：`Number()` / `String()` / 真值判断 / 数字格式化。
//!
//! 这些函数原先长在 [`crate::qq_vip`] 里（QQ 会员判定是第一块需要它们的移植）。
//! 现在搬出来共用，因为 Spotify 的 pathfinder 通道同样要在一堆"看着像 JSON、
//! 实际按 JS 规则解释"的字段上做判断 —— 两处各写一份迟早会走偏。
//!
//! 公开路径不变：`qq_vip::js_number` 之类仍可用（那边做了 re-export）。

use serde_json::Value;

/// JS 的 `Number(v)`。
///
/// 与 `parseInt` / `f64::from_str` 都不同：空串与纯空白是 `0`（不是 `NaN`）、
/// 十六进制/二进制/八进制前缀认、数组先 `join(',')` 再解析、对象一律 `NaN`。
pub fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => parse_js_number(text),
        // `Number([1,2])` 是 `Number('1,2')` → NaN；`Number([])` 是 `Number('')` → 0。
        Value::Array(items) => parse_js_number(&js_array_join(items)),
        Value::Object(_) => f64::NAN,
    }
}

/// JS 的 `String(v)`。
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => {
            if *flag {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(number) => js_number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => js_array_join(items),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `Array.prototype.join(',')`：`null` 与 `undefined` 元素变成空串（不是 `"null"`）。
pub(crate) fn js_array_join(items: &[Value]) -> String {
    items
        .iter()
        .map(|item| match item {
            Value::Null => String::new(),
            other => js_string(other),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// JS 的真值判断。`"0"`、`[]`、`{}` 都是真，只有 `null` / `false` / `0` / `""` 是假。
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Number.prototype.toString()` 的常用区间。
///
/// 整数直接给十进制（`1.0` → `"1"`）。`|x| >= 1e21` 与 `1e-7` 以下 JS 会改用指数
/// 记法，这里保持 Rust 的默认格式 —— 这个函数只在 uin / 缓存指纹这类整数字段上用，
/// 那些区间到不了。
fn js_number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_string();
    }
    if number == 0.0 {
        return "0".to_string();
    }
    if number.fract() == 0.0 && number.abs() < 1e21 {
        return format!("{number:.0}");
    }
    format!("{number}")
}

/// JS 的字符串转数字（`StringNumericLiteral`）。解析不出来给 `NaN`。
fn parse_js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // 带符号的进制前缀在 JS 里是 NaN（`-0x10` 不合法），所以先看无符号前缀。
    if let Some(rest) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return match u64::from_str_radix(rest, 16) {
            Ok(value) => value as f64,
            Err(_) => f64::NAN,
        };
    }
    if let Some(rest) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        return match u64::from_str_radix(rest, 2) {
            Ok(value) => value as f64,
            Err(_) => f64::NAN,
        };
    }
    if let Some(rest) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        return match u64::from_str_radix(rest, 8) {
            Ok(value) => value as f64,
            Err(_) => f64::NAN,
        };
    }
    if !is_js_decimal_literal(trimmed) {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `[+-]? ( digits [. digits?] | . digits ) ( [eE] [+-]? digits )?`
fn is_js_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
        index += 1;
    }
    let integer_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let integer_digits = index - integer_start;
    let mut fraction_digits = 0;
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        let fraction_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        fraction_digits = index - fraction_start;
    }
    // `1.` 合法、`.5` 合法、`.` 不合法。
    if integer_digits == 0 && fraction_digits == 0 {
        return false;
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        let exponent_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len()
}

/// JS 的空白字符集。注意它含 `U+FEFF`，且**不含** `U+0085`。
pub(crate) fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&ch)
}

/// 把 `f64` 放回 `Value`：整数值给整数（`1.0` → `1`），避免 JSON 里出现 `1.0`。
pub(crate) fn num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    Value::from(value)
}
