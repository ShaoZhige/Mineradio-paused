//! 脱敏红线：这一层是"主动删除"，不是 JS 版的兜底清洗。
//!
//! `docs/LOGGING.md` 第 2 节列了禁写清单：cookie / token / 密码 / 完整 URL 与 query /
//! 歌词原文与歌曲名 / 用户目录绝对路径 / 昵称与头像地址。
//! 旧实现只靠"写日志的人自己记得别写"，`sanitize()` 只做长度与深度裁剪；
//! 这里改成**按规则自动拦**，三条：
//!
//! 1. **键名**命中敏感词 → 整个值换成 `[redacted]`（覆盖 `cookie`、`accessToken`、
//!    `spade_a` 等；判定是"归一化后完全相等或以后缀结尾"，所以 `refresh_token`
//!    `X-Auth-Token` 这类变体都跑不掉）。
//! 2. **值里出现 URL** → 只留 `scheme://host[:port]`，路径与 query 一律砍掉。
//! 3. **值里出现绝对路径** → 只留文件名（`…\app.log`）。含空格的路径会在空格处截断，
//!    这是刻意选的失败方向：宁可少留信息，也不能漏出 `C:\Users\<用户名>`。
//!
//! 另外还挡两种"看起来是标识符其实是凭据"的串：JWT（`eyJ…` 三段点号）与
//! 超长 hex/base64 块（≥64 字符）。
//!
//! 顺序很关键：**先 `sanitize`（裁剪）再 `redact`**。裁剪会把第 2 层以下折叠成
//! `[object]`、把字符串截到 400 字符，于是脱敏只需要处理前两层，而且第 400 字符
//! 之后的秘密（如果有）已经被截掉了。

use serde_json::{Map, Value};

/// 命中脱敏规则后写进日志的占位符。
pub const REDACTED: &str = "[redacted]";

/// 归一化后**完全等于**这些词就脱敏。
const EXACT_KEYS: &[&str] = &[
    "cookie",
    "cookies",
    "cookieheader",
    "setcookie",
    "token",
    "tokens",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "authtoken",
    "bearer",
    "authorization",
    "auth",
    "password",
    "passwd",
    "pwd",
    "secret",
    "clientsecret",
    "credential",
    "credentials",
    "apikey",
    "xapikey",
    "sessionid",
    "csrf",
    "csrftoken",
    // 汽水音乐的解密密钥（`spade_a` / `spadeKey`）。它不是"账号凭据"，
    // 但泄露等于把音频解密送人。
    "spadea",
    "spadekey",
];

/// 归一化后**以这些词结尾**也脱敏 —— 挡住 `refreshToken`、`X-Auth-Token`、`spade_a` 之类的变体。
const SENSITIVE_SUFFIXES: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "cookie",
    "apikey",
    "credential",
    "credentials",
];

/// 键名归一化：只留 ASCII 字母数字、转小写。
///
/// 这样 `X-Auth-Token`、`x_auth_token`、`accessToken` 都会落到 `xauthtoken` / `accesstoken`
/// 这类可比对的形状上，不用维护一张真值表。
fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// 这个键名是否禁止写值。
pub fn is_sensitive_key(key: &str) -> bool {
    let normalized = normalize_key(key);
    if normalized.is_empty() {
        return false;
    }
    EXACT_KEYS.contains(&normalized.as_str())
        || SENSITIVE_SUFFIXES
            .iter()
            .any(|suffix| normalized.ends_with(suffix))
}

/// 递归脱敏一个值（键名上下文由调用方携带）。
pub fn redact_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_string(text)),
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        Value::Object(map) => Value::Object(redact_object(map)),
        other => other.clone(),
    }
}

/// 脱敏一层对象：敏感键整值替换，其余递归。
pub fn redact_object(map: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in map {
        if is_sensitive_key(key) {
            out.insert(key.clone(), Value::String(REDACTED.to_string()));
        } else {
            out.insert(key.clone(), redact_value(value));
        }
    }
    out
}

/// 脱敏单个字符串。
pub fn redact_string(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    // `Authorization: Bearer xxx` 这类：值本身不是敏感键，得按内容认。
    if let Some(masked) = mask_bearer(input) {
        return masked;
    }
    if looks_like_jwt(input) {
        return "[jwt]".to_string();
    }
    if let Some(origin) = url_origin(input) {
        return origin;
    }
    let scrubbed = scrub_paths(input);
    let masked = mask_assignments(&scrubbed);
    if looks_like_blob(&masked) {
        return "[blob]".to_string();
    }
    masked
}

/// `Bearer <token>` → `Bearer [redacted]`（大小写不敏感，改到串尾或空白为止）。
///
/// 要求 token 至少 8 个字符且字符集像凭据，否则 `the bearer of bad news` 这种正常英文
/// 也会被抹掉 —— 脱敏不能把日志抹成看不懂的东西。
fn mask_bearer(input: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    let at = lower.find("bearer ")?;
    let value_start = at + "bearer ".len();
    let value_end = input[value_start..]
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .map(|offset| value_start + offset)
        .unwrap_or(input.len());
    let value = &input[value_start..value_end];
    if value.len() < 8
        || !value.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/' | '=')
        })
    {
        return None;
    }
    let mut out = String::with_capacity(input.len());
    out.push_str(&input[..value_start]);
    out.push_str(REDACTED);
    out.push_str(&input[value_end..]);
    Some(out)
}

/// 三段点号的 `eyJ…`：JWT 的固定长相。
fn looks_like_jwt(input: &str) -> bool {
    input.len() > 40 && input.starts_with("eyJ") && input.matches('.').count() >= 2
}

/// 若整串是一个 URL，返回只保留 origin 的版本。
fn url_origin(input: &str) -> Option<String> {
    const SCHEMES: &[&str] = &["https://", "http://", "wss://", "ws://"];
    let lower = input.to_ascii_lowercase();

    if lower.starts_with("//") {
        return Some(with_origin_marker("", input, 2));
    }
    for scheme in SCHEMES {
        if lower.starts_with(scheme) {
            let rest = &input[scheme.len()..];
            let origin_len = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            let host = &rest[..origin_len];
            if host.is_empty() {
                return Some(format!("{scheme}…"));
            }
            return Some(if origin_len < rest.len() {
                format!("{scheme}{host}/…")
            } else {
                format!("{scheme}{host}")
            });
        }
    }
    None
}

fn with_origin_marker(prefix: &str, input: &str, skip: usize) -> String {
    let rest = &input[skip..];
    let origin_len = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = &rest[..origin_len];
    if host.is_empty() {
        format!("{prefix}…")
    } else if origin_len < rest.len() {
        format!("{prefix}//{host}/…")
    } else {
        format!("{prefix}//{host}")
    }
}

/// 把串里出现的绝对路径换成 `…\文件名` / `…/文件名`。
///
/// 认三种开头：Windows 盘符（`C:\` / `C:/`）、UNC（`\\server\share`）、
/// Unix 用户目录（`/home/`、`/Users/`、`/root/`、`/tmp/`、`/var/folders/`、`/private/var/`）。
/// 最后这组只认少数根，是为了不误伤 `/api/account?x=1` 这种正常 URL 路径。
fn scrub_paths(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let Some(start) = find_path_start(rest) else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = path_end(tail);
        if end == 0 {
            // 理论上不会发生（路径至少以分隔符开头）。留一条退路：
            // 宁可原样输出，也不能因为空跨度在这里转不出去。
            out.push_str(tail);
            return out;
        }
        let span = &tail[..end];
        let separator = if span.contains('\\') { '\\' } else { '/' };
        out.push('…');
        out.push(separator);
        out.push_str(&basename(span));
        rest = &tail[end..];
    }
}

fn find_path_start(input: &str) -> Option<usize> {
    let bytes = input.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        // 边界：路径必须从"词首"开始，避免把 `x1C:\` 这种拼进标识符的片段当成路径。
        let at_boundary = index == 0 || {
            let previous = bytes[index - 1];
            !(previous.is_ascii_alphanumeric() || previous == b'_')
        };

        if at_boundary {
            // 盘符：`C:\` 或 `C:/`
            if byte.is_ascii_alphabetic()
                && bytes.get(index + 1) == Some(&b':')
                && matches!(bytes.get(index + 2), Some(b'\\') | Some(b'/'))
            {
                return Some(index);
            }
            // UNC：`\\server\share`。
            // 必须再往后找一个分隔符才算 —— 否则 `\\d+` 这种正则片段（错误消息里很常见）
            // 会被当成路径吃掉，日志反而看不出在报什么错。
            if *byte == b'\\' && bytes.get(index + 1) == Some(&b'\\') {
                let tail = &input[index..];
                let end = path_end(tail);
                if tail[..end][2..].contains('\\') {
                    return Some(index);
                }
            }
        }

        if !at_boundary || *byte != b'/' {
            continue;
        }
        let lowered = input[index..].to_ascii_lowercase();
        for root in [
            "/home/",
            "/users/",
            "/root/",
            "/tmp/",
            "/var/folders/",
            "/private/var/",
        ] {
            if lowered.starts_with(root) {
                return Some(index);
            }
        }
    }
    None
}

fn path_end(input: &str) -> usize {
    const MAX_PATH_SCAN: usize = 512;
    for (index, ch) in input.char_indices() {
        if index >= MAX_PATH_SCAN {
            return index;
        }
        let terminator = matches!(
            ch,
            ' ' | '\t'
                | '\n'
                | '\r'
                | '\0'
                | '"'
                | '\''
                | '`'
                | ','
                | ';'
                | ')'
                | ']'
                | '}'
                | '>'
                | '|'
                | '，'
                | '。'
                | '、'
                | '）'
                | '；'
        );
        if terminator {
            return index;
        }
    }
    input.len()
}

fn basename(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .find(|segment| !segment.is_empty())
        .map(|segment| segment.to_string())
        .unwrap_or_else(|| "[path]".to_string())
}

/// 把 `token=xxx` / `?access_token=xxx` 这类赋值里的值抹掉（URL 的 query 常混在
/// 普通日志消息里，例如 Node 的 `AggregateError` 会把整条 URL 塞进 message）。
fn mask_assignments(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut emitted = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] != b'=' {
            index += 1;
            continue;
        }
        // 往回找标识符起点（`=` 是 ASCII，回退途中不会落到多字节字符中间）。
        let mut start = index;
        while start > 0 && is_ident_byte(bytes[start - 1]) {
            start -= 1;
        }
        let ident = &input[start..index];
        if ident.is_empty() || start < emitted || !is_sensitive_key(ident) {
            index += 1;
            continue;
        }
        // 往前找值的终点；终止符都是 ASCII，不会切在多字节字符中间。
        let mut end = index + 1;
        while end < bytes.len() && !is_value_end(bytes[end]) {
            end += 1;
        }
        out.push_str(&input[emitted..index + 1]);
        out.push_str(REDACTED);
        emitted = end;
        index = end;
    }

    out.push_str(&input[emitted..]);
    out
}

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.' || byte == b'-'
}

fn is_value_end(byte: u8) -> bool {
    matches!(
        byte,
        b'&' | b';'
            | b' '
            | b'\t'
            | b'\n'
            | b'\r'
            | b'"'
            | b'\''
            | b','
            | b')'
            | b']'
            | b'}'
            | b'#'
    )
}

/// 超长 hex / base64 块：日志里出现这种东西基本只有一种解释。
///
/// 三个条件缺一不可：够长（≥64）、字符集像凭据、**不同字符至少有 8 种**。
/// 最后一条是为了不误伤「xxxx…」这种用来凑长度的填充串 —— 它们同样是"长且全字母数字"，
/// 但显然不是秘密。真实 token 的字符分布不会这么单调。
fn looks_like_blob(input: &str) -> bool {
    if input.chars().count() < 64 {
        return false;
    }
    let mut seen = [false; 128];
    let mut distinct = 0usize;
    for byte in input.bytes() {
        if byte < 128 && !seen[byte as usize] {
            seen[byte as usize] = true;
            distinct += 1;
        }
    }
    if distinct < 8 {
        return false;
    }
    if input.bytes().all(|b| b.is_ascii_hexdigit()) {
        return true;
    }
    input
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sensitive_keys_cover_the_obvious_variants() {
        for key in [
            "cookie",
            "Cookie",
            "accessToken",
            "refresh_token",
            "X-Auth-Token",
            "authorization",
            "password",
            "PASSWD",
            "clientSecret",
            "apiKey",
            "spade_a",
            "spadeKey",
            "credentials",
            "sessionId",
        ] {
            assert!(is_sensitive_key(key), "{key} 应被判为敏感键");
        }
        for key in [
            "provider",
            "songId",
            "elapsedMs",
            "catalogId",
            "stage",
            "ok",
            "message",
            "code",
            "storefront",
            "playlistId",
        ] {
            assert!(!is_sensitive_key(key), "{key} 不该被判为敏感键");
        }
    }

    #[test]
    fn sensitive_values_are_replaced_whole() {
        let map = json!({ "cookie": "MUSIC_U=abc", "songId": "123" });
        let Value::Object(out) = redact_value(&map) else {
            panic!()
        };
        assert_eq!(out["cookie"], json!(REDACTED));
        assert_eq!(out["songId"], json!("123"));
    }

    #[test]
    fn nested_sensitive_keys_are_found() {
        let map = json!({ "headers": { "authorization": "Bearer x" }, "ok": false });
        let Value::Object(out) = redact_value(&map) else {
            panic!()
        };
        assert_eq!(out["headers"]["authorization"], json!(REDACTED));
    }

    #[test]
    fn urls_keep_only_the_origin() {
        assert_eq!(
            redact_string("https://music.163.com/api/song?ids=1&token=abc"),
            "https://music.163.com/…"
        );
        assert_eq!(
            redact_string("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            redact_string("wss://example.com/socket"),
            "wss://example.com/…"
        );
    }

    #[test]
    fn absolute_paths_keep_only_the_file_name() {
        assert_eq!(
            redact_string(r"C:\Users\shao\AppData\Roaming\Mineradio\app.log"),
            r"…\app.log"
        );
        assert_eq!(redact_string("/home/shao/.config/x.json"), "…/x.json");
        assert_eq!(
            redact_string("ENOENT: open 'D:\\Mineradio\\userdata\\renderer.log'"),
            "ENOENT: open '…\\renderer.log'"
        );
    }

    #[test]
    fn normal_url_paths_are_not_mistaken_for_files() {
        assert_eq!(redact_string("/api/account/status"), "/api/account/status");
        assert_eq!(
            redact_string("https://example.com/home/a"),
            "https://example.com/…"
        );
    }

    #[test]
    fn bearer_and_jwt_are_masked() {
        assert_eq!(redact_string("Bearer abcdef123456"), "Bearer [redacted]");
        assert_eq!(
            redact_string("Authorization: bearer abcdef123456 rest"),
            "Authorization: bearer [redacted] rest"
        );
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
        assert_eq!(redact_string(jwt), "[jwt]");
    }

    #[test]
    fn query_assignments_are_masked_even_when_embedded() {
        assert_eq!(
            redact_string("GET /api/x?access_token=secretvalue&a=1"),
            "GET /api/x?access_token=[redacted]&a=1"
        );
        assert_eq!(
            redact_string("token=abc cookie=def"),
            "token=[redacted] cookie=[redacted]"
        );
        // 不敏感的名字原样保留
        assert_eq!(redact_string("ids=1&offset=2"), "ids=1&offset=2");
    }

    #[test]
    fn long_blobs_are_replaced() {
        // 真实形态：hex 的 session key / base64 的密钥块
        let hex = "9f2c7a1be4d65380c0ffee1234567890abcdef0192837465ba9876543210fedcba";
        assert_eq!(redact_string(hex), "[blob]");
        let base64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2";
        assert_eq!(redact_string(base64), "[blob]");
        // 短的不动
        assert_eq!(redact_string(&"a".repeat(40)), "a".repeat(40));
        // 长但单调的填充串不是秘密，别误伤（之前一刀切会把日志抹成 [blob]）
        assert_eq!(redact_string(&"x".repeat(400)), "x".repeat(400));
    }

    #[test]
    fn plain_messages_survive_untouched() {
        for message in [
            "playback failed",
            "[Server] 端口被占用",
            "durationMs=1200 stage=queue",
            "https://example.com", // 只有 origin，没有可泄露的路径
        ] {
            let expected = if message == "https://example.com" {
                "https://example.com"
            } else {
                message
            };
            assert_eq!(redact_string(message), expected);
        }
    }

    #[test]
    fn empty_string_is_empty() {
        assert_eq!(redact_string(""), "");
    }
}
