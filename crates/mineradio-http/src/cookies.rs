//! Cookie 头归一化 —— `server/cookie-header.js` 的 Rust 移植。
//!
//! 把用户粘贴进来的任意形状（原始头串 / name-value 数组 / 普通对象 / DevTools 的多行
//! 导出 / Set-Cookie 的整段属性）收敛成一条 `k=v; k=v` 的 Cookie 头。四个平台
//! （网易云、QQ、酷狗、汽水）共用同一条路径，所以它出一次错就是四处登录态一起坏。
//!
//! # 为什么入参是个自建 enum 而不是 `serde_json::Value`
//!
//! 三个原因，每一个都会在回放里显形：
//!
//! 1. **`undefined` 与 `null` 走不同分支**。`{a: undefined}` 会进 `collectCookiePair`
//!    然后被 `value === undefined` 丢掉；`{a: null}` 因为 `typeof null === 'object'`
//!    且 null 是 falsy，两个分支都不进，同样丢掉。结果一样但路径不同，`serde_json`
//!    里 `undefined` 根本不存在。
//! 2. **对象键序必须保真**。归一化结果是一条按插入顺序拼接的字符串，而
//!    `serde_json::Value` 的 Object 默认是 `BTreeMap`（键被排序）。
//! 3. **数字与布尔要按 JS 的 `String()` 化**，不能走 serde 的类型转换。
//!
//! # 移植时照抄、不能"优化"的地方
//!
//! - `Object.keys()` 会把**类数组下标键提前并按数值升序**。`{2:'a', 1:'b', x:'c'}` 的
//!   键序是 `1, 2, x` 而不是 `2, 1, x`。见 [`object_key_order`]。
//! - 键名的 `|| ''` 和值的处理**不对称**：键是 `String(key || '')`（`0` / `false` /
//!   `''` 全塌成空串后被丢弃），值是 `String(value).trim()`（`0` 会变成 `"0"`、
//!   `false` 变成 `"false"`）。这是最容易写错的一处 —— 见 [`js_key_text`] 与
//!   [`js_value_text`]。
//! - `input.name && hasOwnProperty(input, 'value')` 里 `name` 要 **truthy** 才算数。
//!   所以 `{name: '', value: '1'}` 不走 name-value 分支，而是被当成普通对象遍历，
//!   结果产出 `"value=1"`（`name` 空串被丢、`value` 保留）。直觉上会以为结果是空。
//! - 字符串输入按 `\r?\n` 切行、再按 `;` 切段，`idx <= 0` 才丢 —— `=x` 没有键名
//!   必须丢，但 `a=` 是"键存在、值为空"，留到最后的 filter 再剔。
//! - 重复键取**首次出现的位置 + 最后一次的值**（`Map.set` 语义）。

/// JS 侧 `typeof` 能区分、而 JSON 不能的输入形状。
///
/// `function` / `symbol` / `bigint` 在真实调用点上不可能出现，不建模。
#[derive(Debug, Clone, PartialEq)]
pub enum CookieInput {
    /// JS 的 `undefined`。与 [`CookieInput::Null`] 在多数分支同效，但路径不同。
    Undefined,
    /// JS 的 `null`。`typeof null === 'object'` 且 falsy，是唯一一个"是对象但不 truthy"的值。
    Null,
    /// 字符串。**必须与数字分开**：`String(key || '')` 里字符串 `"0"` 是 truthy，
    /// 而数字 `0` 是 falsy 会被塌成空串 —— 合并成一个变体就丢了这个区别。
    Text(String),
    /// 数字。`String()` 化按 JS 的规则（整数不写小数点）。
    Number(f64),
    /// 布尔。`String()` 化是 `"true"` / `"false"`。
    Bool(bool),
    /// 数组，逐项递归。
    Array(Vec<CookieInput>),
    /// 对象，**保持调用方给的顺序**（含重复键时后者覆盖，模拟 `JSON.parse`）。
    Object(Vec<(String, CookieInput)>),
}

impl CookieInput {
    /// 字符串输入。（最常见的形状：用户直接粘一整条 Cookie 头。）
    pub fn text(value: impl Into<String>) -> Self {
        CookieInput::Text(value.into())
    }

    /// 对象输入，保持给定顺序。
    pub fn object<K: Into<String>>(pairs: impl IntoIterator<Item = (K, CookieInput)>) -> Self {
        let mut out: Vec<(String, CookieInput)> = Vec::new();
        for (key, value) in pairs {
            let key = key.into();
            // JS 对象不可能有重复键；重复意味着调用方拼错了，按 JSON.parse 的规则取后者。
            match out.iter_mut().find(|(existing, _)| *existing == key) {
                Some(slot) => slot.1 = value,
                None => out.push((key, value)),
            }
        }
        CookieInput::Object(out)
    }
}

/// Set-Cookie 的属性名 —— 不是 cookie 名，归一化时一律丢弃。
///
/// 保留原样发出去会让服务端解析出一个叫 `Path` 的 cookie，有的平台会直接判 403。
const COOKIE_ATTRIBUTE_NAMES: &[&str] = &[
    "path", "domain", "expires", "max-age", "samesite", "secure", "httponly",
];

fn is_cookie_attribute(key: &str) -> bool {
    // 属性名全是 ASCII，键名也只会是 ASCII 才可能命中 —— 用 to_ascii_lowercase 足够，
    // 且避免 Unicode 大小写映射（`İ` 在 JS 的 toLowerCase 里会变成两个码元）带来的歧义。
    let lowered = key.to_ascii_lowercase();
    COOKIE_ATTRIBUTE_NAMES.contains(&lowered.as_str())
}

/// 归一化的累积结果，语义等价于 JS 的 `Map<string, string>`：
/// 重复键**保留首次出现的位置**、更新值。
type Picked = Vec<(String, String)>;

fn set_keep_position(picked: &mut Picked, key: String, value: String) {
    match picked.iter_mut().find(|(existing, _)| *existing == key) {
        Some(slot) => slot.1 = value,
        None => picked.push((key, value)),
    }
}

/// JS 的 truthiness。`"0"`、`[]`、`{}` 都是真 —— 只有 `""`、`0`、`-0`、`NaN`、
/// `null`、`undefined`、`false` 是假。
fn js_truthy(value: &CookieInput) -> bool {
    match value {
        CookieInput::Undefined | CookieInput::Null => false,
        CookieInput::Text(text) => !text.is_empty(),
        CookieInput::Number(number) => *number != 0.0 && !number.is_nan(),
        CookieInput::Bool(flag) => *flag,
        CookieInput::Array(_) | CookieInput::Object(_) => true,
    }
}

/// JS 的 `String(number)`。
///
/// 整数且绝对值 < 1e21 时不写小数点（`String(1e20)` 是 `"100000000000000000000"`）。
/// 已知偏差：JS 在 `|x| >= 1e21` 或 `|x| < 1e-6` 时用 `"1e+21"` / `"1e-7"` 的指数形式，
/// 这里回落到 Rust 的 `"1e21"` / `"1e-7"`（指数不带 `+`）。cookie 场景不会出现这种数。
fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == 0.0 {
        // 含 -0：JS 的 String(-0) 是 "0"。
        return "0".to_string();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    format!("{value}")
}

/// `String(v)`，用于 `collectCookiePair` 里的键与值。
///
/// 数组按 `,` 拼接且 `null`/`undefined` 元素变成空串（`String([null, 1])` 是 `",1"`
/// 而不是 `"null,1"`）；普通对象一律 `[object Object]`。
fn js_string(value: &CookieInput) -> String {
    match value {
        CookieInput::Undefined => "undefined".to_string(),
        CookieInput::Null => "null".to_string(),
        CookieInput::Text(text) => text.clone(),
        CookieInput::Number(number) => js_number_to_string(*number),
        CookieInput::Bool(flag) => flag.to_string(),
        CookieInput::Array(items) => items
            .iter()
            .map(|item| match item {
                // Array.prototype.join 把空位、null、undefined 都当空串。
                CookieInput::Undefined | CookieInput::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        CookieInput::Object(_) => "[object Object]".to_string(),
    }
}

/// 键的 JS 语义：`String(key || '')`。
///
/// 与 [`js_value_text`] 的差别就在这个 `|| ''` 上 —— 值是 `String(value).trim()`，
/// 没有短路，所以键值 `0` 会塌成空串、值 `0` 会变成 `"0"`。
fn js_key_text(value: &CookieInput) -> String {
    if js_truthy(value) {
        js_string(value)
    } else {
        String::new()
    }
}

/// 值的 JS 语义：`String(value).trim()`。
fn js_value_text(value: &CookieInput) -> String {
    js_string(value).trim().to_string()
}

/// 收集一个键值对。键为空、是 cookie 属性、或值为 null/undefined 时丢弃。
fn collect_cookie_pair(picked: &mut Picked, key: &CookieInput, value: &CookieInput) {
    let key = js_key_text(key).trim().to_string();
    if key.is_empty() || is_cookie_attribute(&key) {
        return;
    }
    if matches!(value, CookieInput::Null | CookieInput::Undefined) {
        return;
    }
    set_keep_position(picked, key, js_value_text(value));
}

/// `Object.keys()` 的顺序：**类数组下标键**（`"0"`..`"4294967294"`，无前导零）
/// 按数值升序排在前面，其余键按插入顺序跟在后面。
///
/// 这条规则在实际 cookie 里几乎不会触发（键名都是 `MUSIC_U` 这种），但它属于
/// "照抄才能行为一致"的范畴：`{2:'a', 1:'b'}` 的归一化结果顺序会被它影响。
fn object_key_order(pairs: &[(String, CookieInput)]) -> Vec<String> {
    fn array_index(key: &str) -> Option<u32> {
        if key.is_empty() || key.len() > 10 {
            return None;
        }
        if !key.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        // 规范要求规范化形式：没有前导零（`"01"` 不是下标），且 < 2^32 - 1。
        if key.len() > 1 && key.starts_with('0') {
            return None;
        }
        let parsed: u64 = key.parse().ok()?;
        if parsed > u64::from(u32::MAX) - 1 {
            return None;
        }
        u32::try_from(parsed).ok()
    }

    let mut indices: Vec<(u32, String)> = Vec::new();
    let mut others: Vec<String> = Vec::new();
    for (key, _) in pairs {
        match array_index(key) {
            Some(index) => indices.push((index, key.clone())),
            None => others.push(key.clone()),
        }
    }
    indices.sort_by_key(|(index, _)| *index);
    indices
        .into_iter()
        .map(|(_, key)| key)
        .chain(others)
        .collect()
}

fn lookup<'a>(pairs: &'a [(String, CookieInput)], key: &str) -> &'a CookieInput {
    // object_key_order 产出的键一定存在（重复键已被 CookieInput::object 并掉）。
    &pairs
        .iter()
        .find(|(existing, _)| existing == key)
        .expect("键来自同一份 pairs，不可能缺失")
        .1
}

/// 对象是否有自有的 `value` 属性（对应 `hasOwnProperty.call(x, 'value')`）。
fn has_own_value(pairs: &[(String, CookieInput)]) -> bool {
    pairs.iter().any(|(key, _)| key == "value")
}

/// 递归收集任意形状的 cookie 输入。
fn collect_cookie_input(input: &CookieInput, picked: &mut Picked) {
    match input {
        CookieInput::Undefined | CookieInput::Null => {}
        CookieInput::Array(items) => {
            for item in items {
                collect_cookie_input(item, picked);
            }
        }
        CookieInput::Object(pairs) => {
            // `input.name && hasOwnProperty(input, 'value')` —— name 要 truthy 才算数。
            if let Some((_, name)) = pairs.iter().find(|(key, _)| key == "name") {
                if js_truthy(name) && has_own_value(pairs) {
                    let value = lookup(pairs, "value");
                    collect_cookie_pair(picked, name, value);
                    return;
                }
            }
            for key in object_key_order(pairs) {
                let value = lookup(pairs, &key);
                // `value && typeof value === 'object'` —— null 是对象但 falsy，进不来。
                if let CookieInput::Object(inner) = value {
                    if has_own_value(inner) {
                        let inner_value = lookup(inner, "value");
                        collect_cookie_pair(picked, &CookieInput::text(&key), inner_value);
                    }
                } else if !matches!(value, CookieInput::Null | CookieInput::Undefined) {
                    // `typeof value !== 'object'`：字符串 / 数字 / 布尔进这里。
                    collect_cookie_pair(picked, &CookieInput::text(&key), value);
                }
            }
        }
        // `typeof !== 'object'` 的标量（字符串 / 数字 / 布尔）：`String()` 化后按行切。
        CookieInput::Text(_) | CookieInput::Number(_) | CookieInput::Bool(_) => {
            let raw = js_string(input);
            for line in raw.split('\n') {
                // `\r?\n` 的切法：CRLF 的 `\r` 留在行尾，随后的 trim 会去掉。
                for part in line.split(';') {
                    let part = part.trim();
                    // JS 写的是 `if (idx <= 0) return;`，一次判断同时挡掉"没有 `=`"（-1）
                    // 和"没有键名"（0）。Rust 的 `find` 用 None 表示前者，所以只剩 0 要判。
                    //
                    // 顺带记一笔：这一行**不可观测** —— 实测把 `index == 0` 的 continue 删掉，
                    // 全部用例照样通过。因为 `=value` 切出来的键是空串，后面
                    // `collect_cookie_pair` 的 `key.is_empty()` 会再挡一次。保留它是为了
                    // 与 JS 逐行对应（少传一次参数、少一次属性名比对），不是唯一防线。
                    let Some(index) = part.find('=') else {
                        continue;
                    };
                    if index == 0 {
                        continue;
                    }
                    collect_cookie_pair(
                        picked,
                        &CookieInput::text(&part[..index]),
                        &CookieInput::text(&part[index + 1..]),
                    );
                }
            }
        }
    }
}

/// 归一化成可直接放进 `Cookie:` 请求头的字符串。值全为空时返回空串。
pub fn normalize_cookie_header(input: &CookieInput) -> String {
    let mut picked: Picked = Vec::new();
    collect_cookie_input(input, &mut picked);
    picked
        .into_iter()
        .filter(|(key, value)| !key.is_empty() && !value.is_empty())
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// 归一化失败时的退路：只在输入本来就是字符串或全字符串数组时原样返回（trim 后）。
///
/// 调用点的写法一直是 `normalizeCookieHeader(x) || rawCookieFallback(x)`。归一化会把
/// 它认不出的东西丢干净，而"完全认不出"通常意味着用户粘的是一段不是标准 cookie 的
/// 凭据（某些平台的自定义 token），这时候原样发出去比发空要好。
pub fn raw_cookie_fallback(input: &CookieInput) -> String {
    match input {
        CookieInput::Text(text) => text.trim().to_string(),
        CookieInput::Array(items) => {
            if items
                .iter()
                .all(|item| matches!(item, CookieInput::Text(_)))
            {
                items
                    .iter()
                    .map(js_string)
                    .collect::<Vec<_>>()
                    .join("; ")
                    .trim()
                    .to_string()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> CookieInput {
        CookieInput::text(value)
    }

    #[test]
    fn attributes_are_dropped_but_key_case_is_kept() {
        assert_eq!(
            normalize_cookie_header(&text("a=1; PATH=/; HttpOnly")),
            "a=1"
        );
        assert_eq!(
            normalize_cookie_header(&text("MUSIC_U=X; music_u=Y")),
            "MUSIC_U=X; music_u=Y"
        );
    }

    #[test]
    fn duplicate_key_keeps_first_position_last_value() {
        assert_eq!(normalize_cookie_header(&text("a=1; b=2; a=3")), "a=3; b=2");
    }

    #[test]
    fn empty_value_filtered_but_missing_key_dropped_earlier() {
        assert_eq!(normalize_cookie_header(&text("a=; b=2")), "b=2");
        assert_eq!(normalize_cookie_header(&text("=v; a=1")), "a=1");
    }

    #[test]
    fn falsy_name_is_not_a_pair_but_truthy_numeric_string_name_is() {
        // name 是数字 0 → falsy → 不当 name/value 对，退化成普通对象遍历。
        let zero_name =
            CookieInput::object([("name", CookieInput::Number(0.0)), ("value", text("1"))]);
        assert_eq!(normalize_cookie_header(&zero_name), "name=0; value=1");

        // name 是字符串 "0" → truthy → 当成 name/value 对，只剩一个键。
        let numeric_name = CookieInput::object([("name", text("0")), ("value", text("1"))]);
        assert_eq!(normalize_cookie_header(&numeric_name), "0=1");
    }

    #[test]
    fn falsy_name_falls_through_to_plain_object_walk() {
        // name 是空串 → 不当 name/value 对，而是当普通对象遍历：name 被丢、value 保留。
        let input = CookieInput::object([("name", text("")), ("value", text("1"))]);
        assert_eq!(normalize_cookie_header(&input), "value=1");
    }

    #[test]
    fn array_index_keys_come_first_and_sorted() {
        let input = CookieInput::object([("2", text("a")), ("1", text("b")), ("x", text("c"))]);
        assert_eq!(normalize_cookie_header(&input), "1=b; 2=a; x=c");
    }

    #[test]
    fn null_and_undefined_values_are_dropped() {
        let input = CookieInput::object([
            ("a", CookieInput::Null),
            ("b", CookieInput::Undefined),
            ("c", text("3")),
        ]);
        assert_eq!(normalize_cookie_header(&input), "c=3");
    }

    #[test]
    fn raw_fallback_only_accepts_string_shapes() {
        assert_eq!(raw_cookie_fallback(&text("  a=1  ")), "a=1");
        assert_eq!(
            raw_cookie_fallback(&CookieInput::Array(vec![text("a=1"), text("b=2")])),
            "a=1; b=2"
        );
        assert_eq!(
            raw_cookie_fallback(&CookieInput::Array(vec![text("a=1"), CookieInput::Null])),
            ""
        );
        assert_eq!(raw_cookie_fallback(&CookieInput::Object(vec![])), "");
    }
}
