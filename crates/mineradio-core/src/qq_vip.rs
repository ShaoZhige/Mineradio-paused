//! QQ 音乐会员状态解析（`server/qq-vip-api.js` 的移植）。
//!
//! 这块的职责是**判断"当前账号是不是 QQ 会员"**：把两三支探测接口返回的任意 JSON
//! 摊平成一棵可判读的证据树，按作用域逐个评分，再合成一个结论。难点不在于网络，
//! 而在于原实现是一堆"看着像 JS 惯用法、其实是刻意写成这样"的表达式。
//!
//! # 行为证明
//!
//! `tests/qq_vip_recorded.rs` 回放 197 条录制（录制器 `scripts/record-qq-vip.js`，
//! 可用 `npm run qqvip:check` 校验 fixture 与当前 JS 是否同步）。录制时把两件环境
//! 钉死：`TZ=UTC`（日期串解析）与 `Date.now()=1735689600000`（墙钟）。
//!
//! # 为什么状态是 `Map` 而不是结构体
//!
//! [`QqVipStatus`] 包着一个 `serde_json::Map`。原因有三个，每个都指向同一件事：
//! **字段的"在不在"本身就是契约的一部分**。
//!
//! 1. 12 个字段是所有分支都有的（`empty_qq_vip_status`），但 `combine` 会多带
//!    `vipSource` / `rawCode`，`resolve` 再多带 11 个计数与判定，`preserve` 又多带
//!    5 个 stale 相关字段。用结构体就得为每个分支决定"这个字段发不发"，
//!    一处判断错就是线上 JSON 多一个 `"vipSource": ""`。
//! 2. `preserve_qq_vip_stale_positive` 的语义是 `{...cachedStatus, 若干覆盖}` ——
//!    它必须把**缓存里我们不认识的字段**原样带出来，结构体做不到。
//! 3. 调用方读的是 `status.isVip` 这种 JS 式访问，真值判断（`!!status.isVip`）
//!    与 `=== true` 在几个地方混用，写死类型的结构体会把这种差别抹掉。
//!
//! 类型安全靠录制兜底：197 条用例里既有字段组合也有错误分支。
//!
//! # JS 语义陷阱（改这个文件前必读）
//!
//! 1. **`Number()` 不是 `parseInt`**：`Number('')` 是 `0`、`Number('0x10')` 是 `16`、
//!    `Number(' 12 ')` 是 `12`、`Number([])` 是 `0`、`Number([5])` 是 `5`、
//!    `Number(['1','2'])` 是 `NaN`、`Number({})` 是 `NaN`。参见 [`js_number`]。
//! 2. **`String(v || '')` 会把 `0` 和 `false` 变成空串**，但 `String(v).trim()` 会
//!    把它们变成 `"0"` / `"false"` —— 同一个函数里两种写法并存，别统一。
//! 3. **`x === 0` 与 `!x` 不等价**：`primitiveMembershipSignal` 返回的是
//!    `1 / 0 / null` 三值，判定里 `signal === 0`（否定）与 `signal == null`（没证据）
//!    是两条不同的路。
//! 4. **`Number.isFinite(numeric) && numeric > 0`** 同时排除了 `NaN`、`Infinity`
//!    与非正数；只写 `> 0` 会让 `Infinity` 也算"有会员"。
//! 5. **到期时间有"秒 / 毫秒"自动判定**（`< 1e10` 视为秒）与一个 **2000-01-01 的
//!    下限**（`946684800000`）。低于下限不是"已过期"，而是"这个字段不算数"。
//! 6. **`Math.max(1, ...[])` 是 `1`**：`vipType` 兜底成 1，不是 0。
//! 7. **`Promise.allSettled`** 的分支是三条：成功、失败、以及"成功但业务码非 0"。
//!    我们的 [`resolve_qq_vip_from_probes`] 用 `Result` 表达前两条，第三条由
//!    [`qq_vip_probe_response_successful`] 单独判。
//! 8. **`negativeQuorum` 是 `min(2, max(1, probeCount))`**：只有一支探测时，
//!    单支否定就算权威否定。这是刻意放宽的，不要"优化"成固定 2。
//!
//! # 与 JS 的两处刻意偏差
//!
//! 1. **无时区的日期串按 UTC 解释**。JS 的 `Date.parse('2024-01-01 00:00:00')`
//!    按**本地时区**解释，结果随机器而变；录制时把 `TZ` 钉成 `UTC` 所以两边一致。
//!    真实接口的到期字段都是数字秒，这条只影响手写 payload。
//! 2. **墙钟改成显式参数**。JS 有四处直接读 `Date.now()`，其中
//!    `qq_vip_object_expiry` 与 `combine_qq_vip_results` 读得还很隐蔽。Rust 侧一律
//!    由调用方传入 `now_ms`，`QQ_VIP_STALE_POSITIVE_GRACE_MS` 之类的默认值不变。
//!    唯一的例外是 `preserve_qq_vip_stale_positive` 的 `options.now`：JS 里
//!    `Number(now) || Date.now()` 会把 `0` 也当成"没给"，所以那边用 `Option`。

use std::future::Future;

use serde_json::{Map, Value};
use sha2::Digest;

// JS 值语义已搬到 `crate::js`（Spotify 的 pathfinder 通道也要用）。这里 re-export，
// 保持 `qq_vip::js_number` 这类公开路径不变。
use crate::js::{is_js_whitespace, num};
pub use crate::js::{js_number, js_string, js_truthy};

/// 遍历深度上限。超过就不再往下走 —— 真实 payload 最深三层，这个值只是防炸栈。
pub const MAX_WALK_DEPTH: usize = 8;

/// `preserveQQVipStalePositive` 的默认宽限期：10 分钟。
pub const QQ_VIP_STALE_POSITIVE_GRACE_MS: f64 = 600_000.0;

/// 到期时间下限（2000-01-01T00:00:00Z）。低于它的时间戳视为"字段无效"而不是"已过期"。
const EXPIRY_FLOOR_MS: f64 = 946_684_800_000.0;

/// 秒 / 毫秒的分界：小于它按秒算，乘 1000。
const SECONDS_UPPER_BOUND: f64 = 10_000_000_000.0;

// ---------- 键名表（与 JS 逐字一致，顺序无关） ----------

const VIP_TYPE_KEYS: &[&str] = &[
    "viptype",
    "viplevel",
    "musicviptype",
    "musicviplevel",
    "greenviptype",
    "greenviplevel",
    "greenlevel",
    "associatortype",
    "associatorlevel",
];

const SVIP_TYPE_KEYS: &[&str] = &[
    "sviptype",
    "sviplevel",
    "superviptype",
    "superviplevel",
    "luxuryviptype",
    "luxuryviplevel",
    "greensvip",
];

const VIP_FLAG_KEYS: &[&str] = &[
    "isvip",
    "ivipflag",
    "inewvip",
    "vip",
    "vipflag",
    "isgreenvip",
    "greenvip",
    "ismember",
    "member",
    "isassociator",
    "associator",
];

const SVIP_FLAG_KEYS: &[&str] = &[
    "issvip",
    "isupervip",
    "inewsupervip",
    "svip",
    "issupervip",
    "supervip",
    "isluxuryvip",
    "luxuryvip",
];

const MEMBERSHIP_STATUS_KEYS: &[&str] = &[
    "status",
    "state",
    "active",
    "opened",
    "valid",
    "vipstatus",
    "memberstatus",
];

const MEMBERSHIP_LEVEL_KEYS: &[&str] = &["level", "viplevel", "memberlevel"];

const MEMBERSHIP_EXPIRY_KEYS: &[&str] = &[
    "expire",
    "expires",
    "expireat",
    "expiretime",
    "expiry",
    "expiryat",
    "expirytime",
    "endtime",
    "validuntil",
    "validtime",
    "deadline",
    "duetime",
    "vipexpireat",
    "vipexpiretime",
    "vipexpirytime",
    "vipendtime",
    "musicvipexpiretime",
    "musicvipendtime",
    "greenvipexpiretime",
    "greenvipendtime",
    "associatorexpiretime",
    "associatorendtime",
    "svipexpiretime",
    "svipendtime",
    "supervipexpiretime",
    "supervipendtime",
    "superendtime",
    "luxuryvipexpiretime",
    "luxuryvipendtime",
];

const VIP_MEMBERSHIP_EXPIRY_KEYS: &[&str] = &[
    "vipexpireat",
    "vipexpiretime",
    "vipexpirytime",
    "vipendtime",
    "musicvipexpiretime",
    "musicvipendtime",
    "greenvipexpiretime",
    "greenvipendtime",
    "associatorexpiretime",
    "associatorendtime",
];

const SVIP_MEMBERSHIP_EXPIRY_KEYS: &[&str] = &[
    "svipexpiretime",
    "svipendtime",
    "supervipexpiretime",
    "supervipendtime",
    "superendtime",
    "luxuryvipexpiretime",
    "luxuryvipendtime",
];

const VIP_MEMBERSHIP_STATUS_KEYS: &[&str] = &[
    "vipstatus",
    "musicvipstatus",
    "greenvipstatus",
    "associatorstatus",
];

const SVIP_MEMBERSHIP_STATUS_KEYS: &[&str] = &["svipstatus", "supervipstatus", "luxuryvipstatus"];

/// 路径里出现这些片段就说明"这一层在讲会员"（`/vip|member|membership|green|luxury|associator/`）。
const MEMBERSHIP_CONTEXT_FRAGMENTS: &[&str] = &[
    "vip",
    "member",
    "membership",
    "green",
    "luxury",
    "associator",
];

/// `svip` 上下文（`/svip|supervip|luxuryvip|luxury/`）。
const SVIP_CONTEXT_FRAGMENTS: &[&str] = &["svip", "supervip", "luxuryvip", "luxury"];

/// uin 型键名（`/^(?:uin|useruin|userid|qq|accountuin)$/`）。
const UIN_KEYS: &[&str] = &["uin", "useruin", "userid", "qq", "accountuin"];

// ---------- 日期解析 ----------

/// `Date.parse` 的子集。
///
/// 支持：`YYYY` / `YYYY-MM` / `YYYY-MM-DD` / `YYYY-MM-DD[T ]HH:mm[:ss[.SSS]]`，
/// 分隔符 `-` 或 `/`，末尾可跟 `Z` / `±HH:mm` / `±HHmm`。**没有时区时按 UTC 解释**
/// （JS 是按本地时区，见模块头部偏差说明）。其余形状一律 `NaN`。
pub fn js_date_parse(text: &str) -> f64 {
    let trimmed = text.trim_matches(is_js_whitespace);
    if trimmed.is_empty() {
        return f64::NAN;
    }
    parse_iso_like(trimmed).unwrap_or(f64::NAN)
}

fn parse_iso_like(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut index = 0;
    let year = take_digits(bytes, &mut index, 4)?;
    let mut month = 1i64;
    let mut day = 1i64;
    if index < bytes.len() && (bytes[index] == b'-' || bytes[index] == b'/') {
        let separator = bytes[index];
        index += 1;
        month = take_digits(bytes, &mut index, 2)?;
        if index < bytes.len() && bytes[index] == separator {
            index += 1;
            day = take_digits(bytes, &mut index, 2)?;
        }
    }
    let mut hour = 0i64;
    let mut minute = 0i64;
    let mut second = 0i64;
    let mut millisecond = 0i64;
    let mut offset_minutes = 0i64;
    if index < bytes.len() {
        if bytes[index] != b'T' && bytes[index] != b't' && bytes[index] != b' ' {
            return None;
        }
        index += 1;
        hour = take_digits(bytes, &mut index, 2)?;
        if index >= bytes.len() || bytes[index] != b':' {
            return None;
        }
        index += 1;
        minute = take_digits(bytes, &mut index, 2)?;
        if index < bytes.len() && bytes[index] == b':' {
            index += 1;
            second = take_digits(bytes, &mut index, 2)?;
            if index < bytes.len() && bytes[index] == b'.' {
                index += 1;
                let digits = take_digits_raw(bytes, &mut index)?;
                // 只取前三位，与 V8 一致（`Date.parse` 的毫秒只有三位精度）。
                let mut value = 0i64;
                for (position, digit) in digits.iter().take(3).enumerate() {
                    value += (*digit as i64) * 10i64.pow(2 - position as u32);
                }
                millisecond = value;
            }
        }
        if index < bytes.len() {
            match bytes[index] {
                b'Z' | b'z' => index += 1,
                b'+' | b'-' => {
                    let sign = if bytes[index] == b'-' { -1 } else { 1 };
                    index += 1;
                    let offset_hour = take_digits(bytes, &mut index, 2)?;
                    let offset_rest = if index < bytes.len() && bytes[index] == b':' {
                        index += 1;
                        take_digits(bytes, &mut index, 2)?
                    } else if index < bytes.len() {
                        take_digits(bytes, &mut index, 2)?
                    } else {
                        0
                    };
                    offset_minutes = sign * (offset_hour * 60 + offset_rest);
                }
                _ => return None,
            }
        }
    }
    if index != bytes.len() {
        return None;
    }
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let millis =
        days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millisecond
            - offset_minutes * 60_000;
    Some(millis as f64)
}

fn take_digits(bytes: &[u8], index: &mut usize, max: usize) -> Option<i64> {
    let digits = take_digits_raw(bytes, index)?;
    if digits.len() > max {
        return None;
    }
    let mut value = 0i64;
    for digit in digits {
        value = value * 10 + digit as i64;
    }
    Some(value)
}

/// 连续数字（至少一位），返回各位数字。
fn take_digits_raw(bytes: &[u8], index: &mut usize) -> Option<Vec<u8>> {
    let start = *index;
    while *index < bytes.len() && bytes[*index].is_ascii_digit() {
        *index += 1;
    }
    if *index == start {
        return None;
    }
    Some(bytes[start..*index].iter().map(|b| b - b'0').collect())
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// 公历 → Unix 天数（Howard Hinnant 的 `days_from_civil`）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

// ---------- 键名与路径 ----------

/// `canonicalQQVipKey`：`String(value || '')` → 删掉非 ASCII 字母数字 → 小写。
///
/// 注意 `0` 与 `false` 是假值，会被压成空串而不是 `"0"` / `"false"`。
pub fn canonical_qq_vip_key(value: &Value) -> String {
    let text = if js_truthy(value) {
        js_string(value)
    } else {
        String::new()
    };
    text.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

fn canonical_key_of(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

fn object_keys(value: &Value) -> Vec<&str> {
    match value {
        Value::Object(map) => map.keys().map(String::as_str).collect(),
        _ => Vec::new(),
    }
}

fn contains(list: &[&str], key: &str) -> bool {
    list.contains(&key)
}

/// `pathMembershipContext`：把路径片段归一化后拼成一句话，看里面有没有会员关键词。
pub fn path_membership_context(path: &[String]) -> MembershipContext {
    let text = path
        .iter()
        .map(|part| canonical_key_of(part))
        .collect::<Vec<_>>()
        .join(" ");
    MembershipContext {
        membership: MEMBERSHIP_CONTEXT_FRAGMENTS
            .iter()
            .any(|f| text.contains(f)),
        svip: SVIP_CONTEXT_FRAGMENTS.iter().any(|f| text.contains(f)),
    }
}

/// 路径推断出的上下文：这一层在讲会员吗？在讲 SVIP 吗？
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MembershipContext {
    pub membership: bool,
    pub svip: bool,
}

/// 这一层自己就带会员字段（不需要路径证明）。
pub fn object_has_direct_membership_key(obj: &Value) -> bool {
    object_keys(obj).into_iter().any(|key| {
        let normalized = canonical_key_of(key);
        contains(VIP_TYPE_KEYS, &normalized)
            || contains(SVIP_TYPE_KEYS, &normalized)
            || contains(VIP_FLAG_KEYS, &normalized)
            || contains(SVIP_FLAG_KEYS, &normalized)
            || contains(VIP_MEMBERSHIP_STATUS_KEYS, &normalized)
            || contains(SVIP_MEMBERSHIP_STATUS_KEYS, &normalized)
    })
}

fn is_membership_expiry_key(key: &str) -> bool {
    contains(MEMBERSHIP_EXPIRY_KEYS, &canonical_key_of(key))
}

/// 到期时间该算 VIP 的还是 SVIP 的。上下文只提供线索，键名优先。
fn membership_expiry_tier(
    key: &str,
    context: Option<&MembershipContext>,
    has_vip_signal: bool,
    has_svip_signal: bool,
) -> &'static str {
    let normalized = canonical_key_of(key);
    if contains(SVIP_MEMBERSHIP_EXPIRY_KEYS, &normalized) {
        return "svip";
    }
    if contains(VIP_MEMBERSHIP_EXPIRY_KEYS, &normalized) {
        return "vip";
    }
    if context.map(|c| c.svip).unwrap_or(false) {
        return "svip";
    }
    if has_vip_signal && has_svip_signal {
        return "both";
    }
    if has_svip_signal {
        return "svip";
    }
    "vip"
}

// ---------- 到期时间 ----------

/// 单层对象上的到期信息。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ObjectExpiry {
    pub present: bool,
    pub expired: bool,
    pub expires_at: f64,
}

/// `qqVipObjectExpiry`：取该层所有到期键的**最大值**（多档会员取最晚的一档）。
pub fn qq_vip_object_expiry(obj: &Value, now_ms: f64) -> ObjectExpiry {
    if !object_has_direct_membership_key(obj) {
        return ObjectExpiry::default();
    }
    let mut latest = 0.0f64;
    for key in object_keys(obj) {
        if !is_membership_expiry_key(key) {
            continue;
        }
        let value = normalized_expiry_ms(&obj[key]);
        if value > latest {
            latest = value;
        }
    }
    if latest <= 0.0 {
        return ObjectExpiry::default();
    }
    ObjectExpiry {
        present: true,
        expired: latest <= now_ms,
        expires_at: latest,
    }
}

/// 这一层的会员权益是否已经过期。没有到期键时返回 `false`（不是"过期"）。
pub fn qq_vip_object_looks_expired(obj: &Value, now_ms: f64) -> bool {
    let expiry = qq_vip_object_expiry(obj, now_ms);
    expiry.present && expiry.expires_at <= now_ms
}

/// 把到期字段归一化成毫秒时间戳。返回 `0` 表示"这个字段不算数"。
///
/// 三步：数字按 `< 1e10` 判秒/毫秒 → 低于 2000-01-01 的下限丢弃 → 字符串才走
/// [`js_date_parse`]。注意 `Number('')` 是 `0` 而不是 `NaN`，所以空串走不到日期解析。
pub fn normalized_expiry_ms(value: &Value) -> f64 {
    let is_null_or_empty = match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        _ => false,
    };
    if is_null_or_empty {
        return 0.0;
    }
    let numeric = js_number(value);
    if numeric.is_finite() && numeric > 0.0 {
        let scaled = if numeric < SECONDS_UPPER_BOUND {
            numeric * 1000.0
        } else {
            numeric
        };
        return if scaled >= EXPIRY_FLOOR_MS {
            scaled
        } else {
            0.0
        };
    }
    if let Value::String(text) = value {
        let parsed = js_date_parse(text);
        if parsed.is_finite() && parsed >= EXPIRY_FLOOR_MS {
            return parsed;
        }
    }
    0.0
}

// ---------- 单层评分 ----------

/// `assessQQVipObject` 的结果：这一层的证据与结论。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Assessment {
    pub evidence: bool,
    pub vip_positive: bool,
    pub svip_positive: bool,
    pub vip_negative: bool,
    pub svip_negative: bool,
    pub vip_type: f64,
    pub svip_type: f64,
    pub vip_expires_at: f64,
    pub svip_expires_at: f64,
    pub expires_at: f64,
}

impl Assessment {
    /// 转成与 JS 同形的 JSON，供录制回放比对。
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("evidence".to_string(), Value::Bool(self.evidence));
        map.insert("vipPositive".to_string(), Value::Bool(self.vip_positive));
        map.insert("svipPositive".to_string(), Value::Bool(self.svip_positive));
        map.insert("vipNegative".to_string(), Value::Bool(self.vip_negative));
        map.insert("svipNegative".to_string(), Value::Bool(self.svip_negative));
        map.insert("vipType".to_string(), num(self.vip_type));
        map.insert("svipType".to_string(), num(self.svip_type));
        map.insert("vipExpiresAt".to_string(), num(self.vip_expires_at));
        map.insert("svipExpiresAt".to_string(), num(self.svip_expires_at));
        map.insert("expiresAt".to_string(), num(self.expires_at));
        Value::Object(map)
    }
}

/// 一层对象里的值 → 三值信号：`Some(1)` 肯定、`Some(0)` 否定、`None` 说不清。
pub fn primitive_membership_signal(value: &Value) -> Option<i32> {
    match value {
        Value::Bool(true) => Some(1),
        Value::Bool(false) => Some(0),
        Value::Number(number) => {
            let numeric = number.as_f64().unwrap_or(f64::NAN);
            if !numeric.is_finite() {
                return None;
            }
            Some(if numeric > 0.0 { 1 } else { 0 })
        }
        Value::String(_) => {
            let text = js_string(value)
                .trim_matches(is_js_whitespace)
                .to_lowercase();
            if text.is_empty() {
                return None;
            }
            if is_decimal_literal(&text) {
                return Some(if js_number(&Value::String(text)) > 0.0 {
                    1
                } else {
                    0
                });
            }
            if matches!(
                text.as_str(),
                "true"
                    | "yes"
                    | "active"
                    | "valid"
                    | "opened"
                    | "open"
                    | "vip"
                    | "svip"
                    | "premium"
                    | "member"
            ) {
                return Some(1);
            }
            if matches!(
                text.as_str(),
                "false"
                    | "no"
                    | "none"
                    | "normal"
                    | "ordinary"
                    | "expired"
                    | "inactive"
                    | "closed"
                    | "invalid"
            ) {
                return Some(0);
            }
            if matches!(
                text.as_str(),
                "已开通" | "有效" | "会员" | "绿钻" | "豪华绿钻"
            ) {
                return Some(1);
            }
            if matches!(
                text.as_str(),
                "未开通" | "已过期" | "过期" | "普通用户" | "普通账号" | "非会员"
            ) {
                return Some(0);
            }
            None
        }
        _ => None,
    }
}

/// `/^-?\d+(?:\.\d+)?$/`，但只认 ASCII 数字。
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    if index < bytes.len() && bytes[index] == b'-' {
        index += 1;
    }
    let integer_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == integer_start {
        return false;
    }
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        let fraction_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == fraction_start {
            return false;
        }
    }
    index == bytes.len()
}

/// 给一层对象打分。
pub fn assess_qq_vip_object(
    obj: &Value,
    context: Option<&MembershipContext>,
    now_ms: f64,
) -> Assessment {
    let mut assessment = Assessment::default();
    let mut vip_expiry_values: Vec<f64> = Vec::new();
    let mut svip_expiry_values: Vec<f64> = Vec::new();

    let keys = object_keys(obj);
    let has_direct_membership_key = object_has_direct_membership_key(obj);
    let has_direct_vip_signal = keys.iter().any(|key| {
        let normalized = canonical_key_of(key);
        contains(VIP_TYPE_KEYS, &normalized)
            || contains(VIP_FLAG_KEYS, &normalized)
            || contains(VIP_MEMBERSHIP_STATUS_KEYS, &normalized)
    });
    let has_direct_svip_signal = keys.iter().any(|key| {
        let normalized = canonical_key_of(key);
        contains(SVIP_TYPE_KEYS, &normalized)
            || contains(SVIP_FLAG_KEYS, &normalized)
            || contains(SVIP_MEMBERSHIP_STATUS_KEYS, &normalized)
    });
    let in_membership_context = context.map(|c| c.membership).unwrap_or(false);
    let in_svip_context = context.map(|c| c.svip).unwrap_or(false);
    let has_paired_membership_signal = has_direct_membership_key
        || (in_membership_context
            && keys.iter().any(|key| {
                let normalized = canonical_key_of(key);
                contains(MEMBERSHIP_STATUS_KEYS, &normalized)
                    || contains(VIP_MEMBERSHIP_STATUS_KEYS, &normalized)
                    || contains(SVIP_MEMBERSHIP_STATUS_KEYS, &normalized)
                    || contains(MEMBERSHIP_LEVEL_KEYS, &normalized)
            }));

    for key in keys {
        let normalized = canonical_key_of(key);
        let value = &obj[key];
        let signal = primitive_membership_signal(value);
        let numeric = js_number(value);
        let is_vip_type = contains(VIP_TYPE_KEYS, &normalized);
        let is_svip_type = contains(SVIP_TYPE_KEYS, &normalized);
        let is_vip_flag = contains(VIP_FLAG_KEYS, &normalized);
        let is_svip_flag = contains(SVIP_FLAG_KEYS, &normalized);
        let is_context_status =
            in_membership_context && contains(MEMBERSHIP_STATUS_KEYS, &normalized);
        let is_context_level =
            in_membership_context && contains(MEMBERSHIP_LEVEL_KEYS, &normalized);

        // 到期键排在类型/标志位之前处理：有配对信号时它们不再当作"类型值"用。
        if has_paired_membership_signal && is_membership_expiry_key(&normalized) {
            let expiry = normalized_expiry_ms(value);
            if expiry > 0.0 {
                let tier = membership_expiry_tier(
                    &normalized,
                    context,
                    has_direct_vip_signal,
                    has_direct_svip_signal,
                );
                if tier == "vip" || tier == "both" {
                    vip_expiry_values.push(expiry);
                }
                if tier == "svip" || tier == "both" {
                    svip_expiry_values.push(expiry);
                }
            }
            continue;
        }

        if is_vip_type {
            assessment.evidence = true;
            if numeric.is_finite() && numeric > 0.0 {
                assessment.vip_type = assessment.vip_type.max(numeric);
                assessment.vip_positive = true;
            } else if signal == Some(0) {
                assessment.vip_negative = true;
            }
            continue;
        }
        if is_svip_type {
            assessment.evidence = true;
            if numeric.is_finite() && numeric > 0.0 {
                assessment.svip_type = assessment.svip_type.max(numeric);
                assessment.svip_positive = true;
            } else if signal == Some(0) {
                assessment.svip_negative = true;
            }
            continue;
        }
        if is_vip_flag {
            match signal {
                None => continue,
                Some(signal) => {
                    assessment.evidence = true;
                    if signal > 0 {
                        assessment.vip_positive = true;
                    } else {
                        assessment.vip_negative = true;
                    }
                }
            }
            continue;
        }
        if is_svip_flag {
            match signal {
                None => continue,
                Some(signal) => {
                    assessment.evidence = true;
                    if signal > 0 {
                        assessment.svip_positive = true;
                    } else {
                        assessment.svip_negative = true;
                    }
                }
            }
            continue;
        }
        if contains(VIP_MEMBERSHIP_STATUS_KEYS, &normalized)
            || contains(SVIP_MEMBERSHIP_STATUS_KEYS, &normalized)
        {
            let Some(signal) = signal else { continue };
            assessment.evidence = true;
            if contains(SVIP_MEMBERSHIP_STATUS_KEYS, &normalized) {
                if signal > 0 {
                    assessment.svip_positive = true;
                } else {
                    assessment.svip_negative = true;
                }
            } else if signal > 0 {
                assessment.vip_positive = true;
            } else {
                assessment.vip_negative = true;
            }
            continue;
        }
        if is_context_status || is_context_level {
            let Some(signal) = signal else { continue };
            assessment.evidence = true;
            if in_svip_context {
                if signal > 0 {
                    assessment.svip_positive = true;
                } else {
                    assessment.svip_negative = true;
                }
            } else if signal > 0 {
                assessment.vip_positive = true;
            } else {
                assessment.vip_negative = true;
            }
        }
    }

    let vip_expires_at = vip_expiry_values.iter().copied().fold(0.0f64, f64::max);
    let svip_expires_at = svip_expiry_values.iter().copied().fold(0.0f64, f64::max);

    // 到期了就把"肯定"翻成"否定"，并把类型清零 —— 过期的会员不是会员。
    if !vip_expiry_values.is_empty() && vip_expires_at <= now_ms {
        assessment.vip_negative = true;
        assessment.vip_positive = false;
        assessment.vip_type = 0.0;
    }
    if !svip_expiry_values.is_empty() && svip_expires_at <= now_ms {
        assessment.svip_negative = true;
        assessment.svip_positive = false;
        assessment.svip_type = 0.0;
    }

    assessment.vip_expires_at = vip_expires_at;
    assessment.svip_expires_at = svip_expires_at;
    assessment.expires_at = if assessment.svip_positive {
        if svip_expires_at > now_ms {
            svip_expires_at
        } else if vip_expires_at > now_ms {
            vip_expires_at
        } else {
            0.0
        }
    } else if assessment.vip_positive && vip_expires_at > now_ms {
        vip_expires_at
    } else {
        0.0
    };
    assessment
}

/// 深度优先遍历整棵 payload，收集有证据的作用域。
///
/// `expected_uin` 非空时会做两道账号校验：路径末段就是自己的 uin（`o010001` 这类
/// 写法也认），或者对象里带 `uin` 类字段但指向别人 —— 后者直接丢整枝。
pub fn collect_qq_vip_assessments(
    value: &Value,
    path: &[String],
    depth: usize,
    now_ms: f64,
    expected_uin: &str,
) -> Vec<Assessment> {
    let mut out = Vec::new();
    collect_into(value, path, depth, now_ms, expected_uin, &mut out);
    out
}

fn collect_into(
    value: &Value,
    path: &[String],
    depth: usize,
    now_ms: f64,
    expected_uin: &str,
    out: &mut Vec<Assessment>,
) {
    if depth > MAX_WALK_DEPTH || value.is_null() {
        return;
    }
    if let Value::Array(items) = value {
        for (index, item) in items.iter().enumerate() {
            let mut next_path = path.to_vec();
            next_path.push(format!("#{index}"));
            collect_into(item, &next_path, depth + 1, now_ms, expected_uin, out);
        }
        return;
    }
    if !value.is_object() {
        return;
    }

    if !expected_uin.is_empty() {
        let last_path_part = path.last().cloned().unwrap_or_default();
        if let Some(path_uin) = uin_from_path_segment(&last_path_part) {
            if !path_uin.is_empty() && path_uin != expected_uin {
                return;
            }
        }
        let direct_uins: Vec<String> = object_keys(value)
            .into_iter()
            .filter(|key| contains(UIN_KEYS, &canonical_key_of(key)))
            .map(|key| digits_only(&js_string(&value[key])))
            .filter(|uin| !uin.is_empty())
            .collect();
        if !direct_uins.is_empty() && !direct_uins.iter().any(|uin| uin == expected_uin) {
            return;
        }
    }

    let context = path_membership_context(path);
    if context.membership || object_has_direct_membership_key(value) {
        let assessment = assess_qq_vip_object(value, Some(&context), now_ms);
        if assessment.evidence {
            out.push(assessment);
        }
    }

    for key in object_keys(value) {
        let mut next_path = path.to_vec();
        next_path.push(key.to_string());
        collect_into(
            &value[key],
            &next_path,
            depth + 1,
            now_ms,
            expected_uin,
            out,
        );
    }
}

/// `^(?:o0*)?\d+$` → 去掉非数字与前导零。不匹配返回 `None`。
///
/// `o010001` 与 `010001` 都认，`o000` 也认（结果为空串）—— 后者在调用点上等价于
/// "路径末段不是 uin"，因为空串是假值。
fn uin_from_path_segment(segment: &str) -> Option<String> {
    let body = match segment
        .strip_prefix('o')
        .or_else(|| segment.strip_prefix('O'))
    {
        Some(rest) => rest,
        None => segment,
    };
    if body.is_empty() || !body.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(digits_only(segment))
}

/// 去掉所有非 ASCII 数字，**保留前导零**（`qqVipSessionCacheKey` 用的是这个版本）。
fn digits_raw(text: &str) -> String {
    text.chars().filter(|ch| ch.is_ascii_digit()).collect()
}

/// 去掉所有非 ASCII 数字，再去掉前导零。
fn digits_only(text: &str) -> String {
    let digits: String = text.chars().filter(|ch| ch.is_ascii_digit()).collect();
    let trimmed = digits.trim_start_matches('0');
    trimmed.to_string()
}

// ---------- 状态对象 ----------

/// 会员状态。见模块头部"为什么状态是 `Map` 而不是结构体"。
///
/// 所有字段都是可选的存在语义：`get("vipSource")` 为 `None` 表示这条路径没产出它，
/// 与"产出了空串"不同。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QqVipStatus(Map<String, Value>);

impl QqVipStatus {
    /// 从 JSON 取状态。非对象一律当空状态（对应 JS 里 `{...非对象}` 的退化结果）。
    pub fn from_value(value: &Value) -> QqVipStatus {
        match value {
            Value::Object(map) => QqVipStatus(map.clone()),
            _ => QqVipStatus::default(),
        }
    }

    /// 空状态：`decision: "unknown"`、`resolved: false`。
    pub fn empty() -> QqVipStatus {
        let mut map = Map::new();
        map.insert("vipType".to_string(), num(0.0));
        map.insert("svipType".to_string(), num(0.0));
        map.insert("vipLevel".to_string(), Value::from("none"));
        map.insert("isVip".to_string(), Value::Bool(false));
        map.insert("isSvip".to_string(), Value::Bool(false));
        map.insert("vipLabel".to_string(), Value::from("无VIP"));
        map.insert("membershipKnown".to_string(), Value::Bool(false));
        map.insert("resolved".to_string(), Value::Bool(false));
        map.insert("decision".to_string(), Value::from("unknown"));
        map.insert("vipExpiresAt".to_string(), num(0.0));
        map.insert("svipExpiresAt".to_string(), num(0.0));
        map.insert("expiresAt".to_string(), num(0.0));
        QqVipStatus(map)
    }

    /// 转回 JSON（字段顺序按插入序，与上一步的赋值顺序一致）。
    pub fn to_value(&self) -> Value {
        Value::Object(self.0.clone())
    }

    /// 有没有这个字段。`None` 表示"这条路径没产出它"。
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// JS 式的 `!!status.key`。
    pub fn truthy(&self, key: &str) -> bool {
        self.0.get(key).map(js_truthy).unwrap_or(false)
    }

    /// JS 式的 `Number(status.key) || 0`。
    pub fn number(&self, key: &str) -> f64 {
        match self.0.get(key) {
            Some(value) => {
                let numeric = js_number(value);
                if numeric.is_finite() && numeric != 0.0 {
                    numeric
                } else {
                    0.0
                }
            }
            None => 0.0,
        }
    }

    /// JS 式的 `status.key || ''`（真值才取字符串）。
    pub fn text(&self, key: &str) -> String {
        match self.0.get(key) {
            Some(value) if js_truthy(value) => js_string(value),
            _ => String::new(),
        }
    }

    /// JS 式的 `status.key === 'literal'`。
    pub fn text_is(&self, key: &str, expected: &str) -> bool {
        matches!(self.0.get(key), Some(Value::String(text)) if text == expected)
    }

    fn set(&mut self, key: &str, value: Value) {
        self.0.insert(key.to_string(), value);
    }

    fn set_bool(&mut self, key: &str, value: bool) {
        self.set(key, Value::Bool(value));
    }

    fn set_number(&mut self, key: &str, value: f64) {
        self.set(key, num(value));
    }

    fn set_text(&mut self, key: &str, value: &str) {
        self.set(key, Value::from(value));
    }

    /// `status.isVip` 为真，或者 `vipLevel` 明写 `vip`。
    pub fn is_vip(&self) -> bool {
        self.truthy("isVip") || self.text_is("vipLevel", "vip")
    }

    /// `status.isSvip` 为真，或者 `vipLevel` 明写 `svip`。
    pub fn is_svip(&self) -> bool {
        self.truthy("isSvip") || self.text_is("vipLevel", "svip")
    }

    /// `status.membershipKnown === true`（不是真值判断）。
    pub fn membership_known(&self) -> bool {
        matches!(self.0.get("membershipKnown"), Some(Value::Bool(true)))
    }

    /// `status.resolved === true`。
    pub fn resolved(&self) -> bool {
        matches!(self.0.get("resolved"), Some(Value::Bool(true)))
    }

    /// `status.authoritativeNegative === true`。
    pub fn authoritative_negative(&self) -> bool {
        matches!(self.0.get("authoritativeNegative"), Some(Value::Bool(true)))
    }

    /// `status.probeIncomplete === true`。
    pub fn probe_incomplete(&self) -> bool {
        matches!(self.0.get("probeIncomplete"), Some(Value::Bool(true)))
    }

    /// `status.decision`，缺省当 `unknown`。
    pub fn decision(&self) -> String {
        match self.0.get("decision") {
            Some(Value::String(text)) => text.clone(),
            _ => "unknown".to_string(),
        }
    }
}

impl From<QqVipStatus> for Value {
    fn from(status: QqVipStatus) -> Value {
        status.to_value()
    }
}

// ---------- 归一化 ----------

/// `fallbackQQVipStatus`：payload 说不清时，用上一次的结论兜底。
fn fallback_qq_vip_status(fallback: Option<&Value>) -> QqVipStatus {
    let empty = QqVipStatus::empty();
    let Some(fallback) = fallback.filter(|value| js_truthy(value)) else {
        return empty;
    };
    if !fallback.is_object() {
        return empty;
    }

    let is_svip = js_truthy(&fallback["isSvip"])
        || matches!(&fallback["vipLevel"], Value::String(text) if text == "svip")
        || first_number(&[
            &fallback["svipType"],
            &fallback["svip_type"],
            &Value::from(0),
        ]) > 0.0;
    let is_vip = is_svip
        || js_truthy(&fallback["isVip"])
        || matches!(&fallback["vipLevel"], Value::String(text) if text == "vip")
        || first_number(&[&fallback["vipType"], &fallback["vip_type"], &Value::from(0)]) > 0.0;
    let known = is_vip
        || matches!(&fallback["membershipKnown"], Value::Bool(true))
        || matches!(&fallback["resolved"], Value::Bool(true));
    if !known {
        return empty;
    }

    let expires_at = first_number(&[
        &fallback["expiresAt"],
        &fallback["expireAt"],
        &Value::from(0),
    ]);
    let mut status = QqVipStatus::empty();
    status.set_number(
        "vipType",
        if is_vip {
            1.0f64.max(first_number(&[
                &fallback["vipType"],
                &fallback["vip_type"],
                &Value::from(0),
            ]))
        } else {
            0.0
        },
    );
    status.set_number(
        "svipType",
        if is_svip {
            1.0f64.max(first_number(&[
                &fallback["svipType"],
                &fallback["svip_type"],
                &Value::from(0),
            ]))
        } else {
            0.0
        },
    );
    status.set_text(
        "vipLevel",
        if is_svip {
            "svip"
        } else if is_vip {
            "vip"
        } else {
            "none"
        },
    );
    status.set_bool("isVip", is_vip);
    status.set_bool("isSvip", is_svip);
    status.set_text(
        "vipLabel",
        if is_svip {
            "SVIP"
        } else if is_vip {
            "VIP"
        } else {
            "无VIP"
        },
    );
    status.set_bool("membershipKnown", true);
    status.set_bool("resolved", true);
    status.set_text("decision", if is_vip { "positive" } else { "negative" });
    status.set_number("vipExpiresAt", if is_svip { 0.0 } else { expires_at });
    status.set_number("svipExpiresAt", if is_svip { expires_at } else { 0.0 });
    status.set_number("expiresAt", expires_at);
    status
}

/// `fallback.x || fallback.y || 0` → `Number(...) || 0`。
fn first_number(candidates: &[&Value]) -> f64 {
    for candidate in candidates {
        if js_truthy(candidate) {
            let numeric = js_number(candidate);
            return if numeric.is_finite() && numeric != 0.0 {
                numeric
            } else {
                0.0
            };
        }
    }
    0.0
}

/// 归一化选项。
#[derive(Debug, Clone, Default)]
pub struct NormalizeOptions {
    /// 墙钟（毫秒）。JS 里是 `Number(options.now) || Date.now()`，调用方要给已解析的值。
    pub now_ms: i64,
    /// 期望的账号 uin。非空时会过滤掉属于别人的作用域。
    pub expected_uin: String,
}

/// `normalizeQQVipPayload`：把一支探测的返回摊平成一个结论。
pub fn normalize_qq_vip_payload(
    payload: &Value,
    fallback: Option<&Value>,
    options: &NormalizeOptions,
) -> QqVipStatus {
    let now = options.now_ms as f64;
    let expected_uin = digits_only(&options.expected_uin);
    let assessments = collect_qq_vip_assessments(payload, &[], 0, now, &expected_uin);

    let positive: Vec<&Assessment> = assessments
        .iter()
        .filter(|item| item.vip_positive || item.svip_positive)
        .collect();
    let explicit_vip_negative = assessments.iter().any(|item| item.vip_negative);

    if positive.is_empty() {
        if explicit_vip_negative {
            let mut status = QqVipStatus::empty();
            status.set_bool("membershipKnown", true);
            status.set_bool("resolved", true);
            status.set_text("decision", "negative");
            return status;
        }
        return fallback_qq_vip_status(fallback);
    }

    let vip_positive: Vec<&&Assessment> =
        positive.iter().filter(|item| item.vip_positive).collect();
    let svip_positive: Vec<&&Assessment> =
        positive.iter().filter(|item| item.svip_positive).collect();
    let is_svip = !svip_positive.is_empty();
    // 多支探测各自给了到期时间时取**最早**的那个 —— 保守估计，早过期早降级。
    let vip_expiries: Vec<f64> = vip_positive
        .iter()
        .map(|item| item.vip_expires_at)
        .filter(|value| *value > now)
        .collect();
    let svip_expiries: Vec<f64> = svip_positive
        .iter()
        .map(|item| item.svip_expires_at)
        .filter(|value| *value > now)
        .collect();
    let vip_expires_at = vip_expiries.iter().copied().fold(f64::INFINITY, f64::min);
    let svip_expires_at = svip_expiries.iter().copied().fold(f64::INFINITY, f64::min);
    let vip_expires_at = if vip_expires_at.is_finite() {
        vip_expires_at
    } else {
        0.0
    };
    let svip_expires_at = if svip_expires_at.is_finite() {
        svip_expires_at
    } else {
        0.0
    };
    // `Math.max(1, ...[])` 是 1：没有任何 VIP 证据时类型兜底成 1。
    let vip_type = 1.0f64.max(
        vip_positive
            .iter()
            .map(|item| item.vip_type)
            .fold(0.0, f64::max),
    );
    let svip_type = if is_svip {
        1.0f64.max(
            svip_positive
                .iter()
                .map(|item| item.svip_type)
                .fold(0.0, f64::max),
        )
    } else {
        0.0
    };

    let mut status = QqVipStatus::empty();
    status.set_number("vipType", vip_type);
    status.set_number("svipType", svip_type);
    status.set_text("vipLevel", if is_svip { "svip" } else { "vip" });
    status.set_bool("isVip", true);
    status.set_bool("isSvip", is_svip);
    status.set_text("vipLabel", if is_svip { "SVIP" } else { "VIP" });
    status.set_bool("membershipKnown", true);
    status.set_bool("resolved", true);
    status.set_text("decision", "positive");
    status.set_number("vipExpiresAt", vip_expires_at);
    status.set_number("svipExpiresAt", svip_expires_at);
    status.set_number(
        "expiresAt",
        if is_svip {
            svip_expires_at
        } else {
            vip_expires_at
        },
    );
    status
}

/// `combineQQVipResults`：把多支探测的结论合成一个。
///
/// 正向优先（任一正向即正向），到期时间取最早的未过期值；否则看权威否定。
pub fn combine_qq_vip_results(results: &[QqVipStatus], now_ms: i64) -> QqVipStatus {
    let now = now_ms as f64;
    let positives: Vec<&QqVipStatus> = results
        .iter()
        .filter(|item| {
            item.decision() == "positive" || item.truthy("isVip") || item.truthy("isSvip")
        })
        .collect();

    if !positives.is_empty() {
        let is_svip = positives.iter().any(|item| item.is_svip());
        let vip_expiries: Vec<f64> = positives
            .iter()
            .map(|item| {
                let direct = item.number("vipExpiresAt");
                if direct != 0.0 {
                    return direct;
                }
                if !item.truthy("isSvip") && !item.text_is("vipLevel", "svip") {
                    item.number("expiresAt")
                } else {
                    0.0
                }
            })
            .filter(|value| *value > now)
            .collect();
        let svip_expiries: Vec<f64> = positives
            .iter()
            .map(|item| {
                let direct = item.number("svipExpiresAt");
                if direct != 0.0 {
                    return direct;
                }
                if item.truthy("isSvip") || item.text_is("vipLevel", "svip") {
                    item.number("expiresAt")
                } else {
                    0.0
                }
            })
            .filter(|value| *value > now)
            .collect();
        let vip_expires_at = vip_expiries.iter().copied().fold(f64::INFINITY, f64::min);
        let svip_expires_at = svip_expiries.iter().copied().fold(f64::INFINITY, f64::min);
        let vip_expires_at = if vip_expires_at.is_finite() {
            vip_expires_at
        } else {
            0.0
        };
        let svip_expires_at = if svip_expires_at.is_finite() {
            svip_expires_at
        } else {
            0.0
        };
        // 有多支 SVIP 时优先拿 SVIP 那支当"最强来源"，否则用第一支。
        let strongest = positives
            .iter()
            .find(|item| is_svip && item.is_svip())
            .copied()
            .unwrap_or(positives[0]);

        let mut status = QqVipStatus::empty();
        status.set_number(
            "vipType",
            1.0f64.max(
                positives
                    .iter()
                    .map(|item| item.number("vipType"))
                    .fold(0.0, f64::max),
            ),
        );
        status.set_number(
            "svipType",
            if is_svip {
                1.0f64.max(
                    positives
                        .iter()
                        .map(|item| item.number("svipType"))
                        .fold(0.0, f64::max),
                )
            } else {
                0.0
            },
        );
        status.set_text("vipLevel", if is_svip { "svip" } else { "vip" });
        status.set_bool("isVip", true);
        status.set_bool("isSvip", is_svip);
        status.set_text("vipLabel", if is_svip { "SVIP" } else { "VIP" });
        status.set_bool("membershipKnown", true);
        status.set_bool("resolved", true);
        status.set_text("decision", "positive");
        status.set_number("vipExpiresAt", vip_expires_at);
        status.set_number("svipExpiresAt", svip_expires_at);
        status.set_number(
            "expiresAt",
            if is_svip {
                svip_expires_at
            } else {
                vip_expires_at
            },
        );
        status.set_text("vipSource", &strongest.text("vipSource"));
        status.set_number("rawCode", strongest.number("rawCode"));
        return status;
    }

    if let Some(negative) = results
        .iter()
        .find(|item| item.decision() == "negative" && item.membership_known())
    {
        let mut status = QqVipStatus::empty();
        status.set_bool("membershipKnown", true);
        status.set_bool("resolved", true);
        status.set_text("decision", "negative");
        status.set_text("vipSource", &negative.text("vipSource"));
        status.set_number("rawCode", negative.number("rawCode"));
        return status;
    }

    QqVipStatus::empty()
}

/// 探测返回本身是否成功（业务码层面）。`code` / `result` 非 0 都算失败。
pub fn qq_vip_probe_response_successful(body: &Value, probe: Option<&Value>) -> bool {
    if !body.is_object() {
        return false;
    }
    let root_codes = [
        body.get("code").cloned().unwrap_or(Value::Null),
        body.get("result").cloned().unwrap_or(Value::Null),
    ];
    // 只认"非 null 且非对象"的值 —— 数组也是对象，会被排除。
    let mut codes: Vec<f64> = Vec::new();
    for code in &root_codes {
        if code.is_null() || code.is_object() {
            continue;
        }
        let numeric = js_number(code);
        if numeric.is_finite() {
            codes.push(numeric);
        }
    }
    if codes.iter().any(|code| *code != 0.0) {
        return false;
    }
    let response_key = probe
        .and_then(|probe| probe.get("responseKey"))
        .map(js_string)
        .unwrap_or_default();
    if !response_key.is_empty() {
        if let Some(block) = body.get(&response_key).filter(|value| value.is_object()) {
            let mut block_codes: Vec<f64> = Vec::new();
            for code in [
                block.get("code").cloned().unwrap_or(Value::Null),
                block.get("result").cloned().unwrap_or(Value::Null),
            ] {
                if code.is_null() || code.is_object() {
                    continue;
                }
                let numeric = js_number(&code);
                if numeric.is_finite() {
                    block_codes.push(numeric);
                }
            }
            if block_codes.iter().any(|code| *code != 0.0) {
                return false;
            }
        }
    }
    true
}

/// payload 里有没有指向这个 uin 的账号标识。
pub fn qq_vip_payload_belongs_to_uin(payload: &Value, uin: &str) -> bool {
    let expected = digits_only(uin);
    if expected.is_empty() || !payload.is_object() {
        return false;
    }
    let mut matched = false;
    walk_for_uin(payload, 0, &expected, &mut matched);
    matched
}

fn walk_for_uin(value: &Value, depth: usize, expected: &str, matched: &mut bool) {
    if *matched || depth > MAX_WALK_DEPTH {
        return;
    }
    // 数组要先于 is_object 判断：serde_json 的数组不是对象，顺序颠倒会把整枝漏掉。
    if let Value::Array(items) = value {
        for item in items {
            walk_for_uin(item, depth + 1, expected, matched);
            if *matched {
                return;
            }
        }
        return;
    }
    for key in object_keys(value) {
        if *matched {
            return;
        }
        let normalized_key = canonical_key_of(key);
        let normalized_value = digits_only(&js_string(&value[key]));
        let key_digits = digits_only(key);
        // 第二个分支：键名本身就是 uin，且值是对象（数组也算）。
        let key_looks_like_uin = !key_digits.is_empty()
            && key_digits == expected
            && matches!(value[key], Value::Object(_) | Value::Array(_));
        if (contains(UIN_KEYS, &normalized_key) && normalized_value == expected)
            || key_looks_like_uin
        {
            *matched = true;
            return;
        }
        walk_for_uin(&value[key], depth + 1, expected, matched);
    }
}

/// 找出 payload 里属于这个 uin 的子树。
///
/// 与 JS 一样按"账号作用域"返回：对象自己带 `uin` 字段，或者某层键名就是 uin。
pub fn qq_vip_payload_scopes_for_uin(payload: &Value, uin: &str) -> Vec<Value> {
    let expected = digits_only(uin);
    if expected.is_empty() || !payload.is_object() {
        return Vec::new();
    }
    let mut scopes = Vec::new();
    collect_scopes(payload, 0, &expected, &mut scopes);
    scopes
}

fn collect_scopes(value: &Value, depth: usize, expected: &str, scopes: &mut Vec<Value>) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    // 同上：数组判断必须在 is_object 之前。
    if let Value::Array(items) = value {
        for item in items {
            collect_scopes(item, depth + 1, expected, scopes);
        }
        return;
    }
    if !value.is_object() {
        return;
    }
    let keys = object_keys(value);
    let direct_identity_match = keys.iter().any(|key| {
        let normalized_key = canonical_key_of(key);
        if !contains(UIN_KEYS, &normalized_key) {
            return false;
        }
        digits_only(&js_string(&value[*key])) == expected
    });
    if direct_identity_match {
        scopes.push(value.clone());
    }
    for key in keys {
        let child = &value[key];
        let map_key = key.trim();
        // `^(?:o0*)?\d+$` 的键名：值必须是对象才算一个作用域。
        let map_key_uin = uin_from_path_segment(map_key).unwrap_or_default();
        if map_key_uin == expected && child.is_object() {
            scopes.push(child.clone());
            continue;
        }
        collect_scopes(child, depth + 1, expected, scopes);
    }
}

/// 多支探测 → 一个结论。
///
/// `request_probe` 为 `None` 对应 JS 里"没传函数"那条分支（返回空状态 + `errorCount: 0`）。
/// 单支抛错不影响其它支 —— 这就是 `Promise.allSettled` 的语义。
pub async fn resolve_qq_vip_from_probes<F, Fut>(
    probes: &[Value],
    request_probe: Option<&F>,
    now_ms: i64,
) -> QqVipStatus
where
    F: Fn(&Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let Some(request_probe) = request_probe else {
        let mut status = QqVipStatus::empty();
        status.set_number("errorCount", 0.0);
        return status;
    };

    let futures = probes.iter().map(|probe| {
        let probe = probe.clone();
        async move {
            let uin = probe.get("uin").map(js_string).unwrap_or_default();
            let expected_uin = digits_only(&uin);
            match request_probe(&probe).await {
                Ok(body) => {
                    let scopes = qq_vip_payload_scopes_for_uin(&body, &uin);
                    let scoped_results: Vec<QqVipStatus> = scopes
                        .iter()
                        .map(|scope| {
                            normalize_qq_vip_payload(
                                scope,
                                None,
                                &NormalizeOptions {
                                    now_ms,
                                    expected_uin: expected_uin.clone(),
                                },
                            )
                        })
                        .collect();
                    let mut normalized = if scopes.is_empty() {
                        QqVipStatus::empty()
                    } else {
                        combine_qq_vip_results(&scoped_results, now_ms)
                    };
                    let account_matched = !scopes.is_empty();
                    normalized.set_text(
                        "vipSource",
                        &probe
                            .get("source")
                            .filter(|value| js_truthy(value))
                            .map(js_string)
                            .unwrap_or_default(),
                    );
                    let raw_code = js_number(
                        &body
                            .get("code")
                            .or_else(|| body.get("result"))
                            .cloned()
                            .unwrap_or(Value::Null),
                    );
                    normalized
                        .set_number("rawCode", if raw_code.is_finite() { raw_code } else { 0.0 });
                    normalized.set_bool(
                        "probeSuccessful",
                        qq_vip_probe_response_successful(&body, Some(&probe)),
                    );
                    normalized.set_bool("accountMatched", account_matched);
                    Ok(normalized)
                }
                Err(detail) => Err(detail),
            }
        }
    });

    let settled = futures_util::future::join_all(futures).await;
    let error_count = settled.iter().filter(|item| item.is_err()).count() as f64;
    let values: Vec<QqVipStatus> = settled.into_iter().filter_map(Result::ok).collect();

    let positive_values: Vec<&QqVipStatus> = values
        .iter()
        .filter(|item| item.decision() == "positive" && item.truthy("probeSuccessful"))
        .collect();
    let negative_values: Vec<&QqVipStatus> = values
        .iter()
        .filter(|item| item.decision() == "negative" && item.truthy("probeSuccessful"))
        .collect();
    let authoritative_negative_values: Vec<&QqVipStatus> = negative_values
        .iter()
        .filter(|item| item.truthy("accountMatched"))
        .copied()
        .collect();

    let probe_count = probes.len() as f64;
    let completed_probe_count = values
        .iter()
        .filter(|item| item.truthy("probeSuccessful"))
        .count() as f64;
    // 只有一支探测时，单支否定就算权威否定 —— 这是刻意的放宽，别改成固定 2。
    let negative_quorum = 2.0f64.min(1.0f64.max(probe_count));
    let authoritative_negative =
        positive_values.is_empty() && authoritative_negative_values.len() as f64 >= negative_quorum;

    let mut combined = if !positive_values.is_empty() {
        let owned: Vec<QqVipStatus> = positive_values.iter().map(|item| (*item).clone()).collect();
        combine_qq_vip_results(&owned, now_ms)
    } else if authoritative_negative {
        let owned: Vec<QqVipStatus> = authoritative_negative_values
            .iter()
            .map(|item| (*item).clone())
            .collect();
        combine_qq_vip_results(&owned, now_ms)
    } else {
        QqVipStatus::empty()
    };

    combined.set_number("errorCount", error_count);
    combined.set_number("probeCount", probe_count);
    combined.set_number("completedProbeCount", completed_probe_count);
    combined.set_number(
        "accountMatchedProbeCount",
        values
            .iter()
            .filter(|item| item.truthy("accountMatched") && item.truthy("probeSuccessful"))
            .count() as f64,
    );
    combined.set_number("positiveProbeCount", positive_values.len() as f64);
    combined.set_number(
        "negativeProbeCount",
        authoritative_negative_values.len() as f64,
    );
    combined.set_number("negativeQuorum", negative_quorum);
    combined.set_bool("authoritativeNegative", authoritative_negative);
    combined.set_bool("authoritativePositive", !positive_values.is_empty());
    // 既没有正向、也没凑够权威否定 —— 只能报"探测不全"，不能报"不是会员"。
    combined.set_bool(
        "probeIncomplete",
        positive_values.is_empty() && !authoritative_negative,
    );
    combined
}

// ---------- 会话缓存与权益 ----------

/// 会话缓存键：`uin:sha256(uin\nmusicKey\n若干 cookie 片段)[..32]`。
///
/// 用途是"同一个账号 + 同一批凭据"共用一份缓存；凭据一换（重新登录）就自动失效。
/// `uin` 这里**保留前导零**（与其它函数不同），因为它是键的一部分而不是账号标识。
pub fn qq_vip_session_cache_key(uin: &str, music_key: &str, cookie: Option<&Value>) -> String {
    let user_id = digits_raw(uin);
    let ticket = music_key.to_string();
    if user_id.is_empty() || ticket.is_empty() {
        return String::new();
    }
    let cookie_text = |key: &str| -> String {
        cookie
            .and_then(|cookie| cookie.get(key))
            .filter(|value| js_truthy(value))
            .map(js_string)
            .unwrap_or_default()
    };
    let material = [
        user_id.clone(),
        ticket,
        cookie_text("login_type"),
        cookie_text("qm_keyst"),
        cookie_text("qqmusic_key"),
        cookie_text("music_key"),
        cookie_text("wxskey"),
        cookie_text("psrf_qqaccess_token"),
        cookie_text("psrf_qqrefresh_token"),
    ]
    .join("\n");
    let digest = sha2::Sha256::digest(material.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{user_id}:{}", &hex[..32])
}

/// 缓存有效期选项。
#[derive(Debug, Clone, Default)]
pub struct CacheTtlOptions {
    /// 墙钟（毫秒），调用方已解析。
    pub now_ms: i64,
    pub positive_ttl_ms: Option<f64>,
    pub negative_ttl_ms: Option<f64>,
}

/// 这份状态能缓存多久。正向 2 分钟、否定 30 秒，正向还会被到期时间截短。
pub fn qq_vip_cache_ttl_ms(status: Option<&QqVipStatus>, options: &CacheTtlOptions) -> f64 {
    let now = options.now_ms as f64;
    let positive_ttl = 0.0f64.max(options.positive_ttl_ms.unwrap_or(120_000.0));
    let negative_ttl = 0.0f64.max(options.negative_ttl_ms.unwrap_or(30_000.0));
    let Some(status) = status else {
        return 0.0;
    };
    if !status.resolved() || !status.membership_known() {
        return 0.0;
    }
    if !status.truthy("isVip") {
        return negative_ttl;
    }
    let expires_at = status.number("expiresAt");
    if expires_at == 0.0 {
        return positive_ttl;
    }
    0.0f64.max(positive_ttl.min(expires_at - now))
}

/// 会员权益判定：能不能听 VIP / SVIP 曲目、最高到哪一档音质。
pub fn qq_vip_entitlement_rights(status: Option<&QqVipStatus>) -> Value {
    let empty = QqVipStatus::empty();
    let status = status.unwrap_or(&empty);
    let is_svip = status.is_svip();
    let is_vip = is_svip || status.is_vip();
    let membership_known = status.membership_known();
    let membership_stale = status.truthy("membershipStale");
    // 过期的正向结论只能"不拦"，不能"放行" —— 这才是 verified 的意义。
    let verified = membership_known && !membership_stale;
    let mut map = Map::new();
    map.insert(
        "level".to_string(),
        Value::from(if is_svip {
            "svip"
        } else if is_vip {
            "vip"
        } else {
            "none"
        }),
    );
    map.insert("membershipKnown".to_string(), Value::Bool(membership_known));
    map.insert("verified".to_string(), Value::Bool(verified));
    map.insert(
        "syncState".to_string(),
        Value::from(if membership_stale {
            "stale_positive"
        } else if membership_known {
            "checked"
        } else {
            "unknown"
        }),
    );
    map.insert(
        "canPlayVipTracks".to_string(),
        Value::Bool(verified && is_vip),
    );
    map.insert(
        "canPlaySvipTracks".to_string(),
        Value::Bool(verified && is_svip),
    );
    map.insert(
        "maxQuality".to_string(),
        Value::from(if verified {
            if is_svip {
                "hires"
            } else if is_vip {
                "lossless"
            } else {
                "standard"
            }
        } else {
            "standard"
        }),
    );
    Value::Object(map)
}

/// 沿用过期的正向结论的选项。
#[derive(Debug, Clone, Default)]
pub struct StalePositiveOptions {
    /// 墙钟（毫秒）。JS 里 `Number(options.now) || Date.now()`，`None` 表示用调用方的默认值。
    pub now_ms: Option<i64>,
    pub grace_ms: Option<f64>,
}

/// 探测失败时，短时间内继续沿用上一次的正向结论。
///
/// 这是"别让网络抖动把会员降级成普通用户"的补丁：正向结论有 10 分钟宽限期，
/// 但只在**探测本身不完整**时生效 —— 明确的权威否定会立刻覆盖它。
pub fn preserve_qq_vip_stale_positive(
    cached_entry: Option<&Value>,
    next_status: Option<&QqVipStatus>,
    options: &StalePositiveOptions,
) -> Option<QqVipStatus> {
    let now = options.now_ms.unwrap_or_default() as f64;
    let grace_ms = 0.0f64.max(options.grace_ms.unwrap_or(QQ_VIP_STALE_POSITIVE_GRACE_MS));
    let entry = cached_entry;
    // `cachedEntry.value ? cachedEntry.value : cachedEntry` —— 缓存项可以是
    // `{value, expiresAt, staleUntil}`，也可以直接就是一个状态对象。
    let cached_value = entry.map(|entry| match entry.get("value") {
        Some(inner) if js_truthy(inner) => inner.clone(),
        _ => entry.clone(),
    });
    let cached_status = cached_value.as_ref().map(QqVipStatus::from_value);
    let Some(cached_status) = cached_status else {
        return next_status.cloned();
    };
    if !cached_status.truthy("isVip")
        || !cached_status.resolved()
        || !cached_status.membership_known()
    {
        return next_status.cloned();
    }
    if let Some(next) = next_status {
        if next.truthy("isVip") && next.resolved() {
            return Some(next.clone());
        }
        if next.authoritative_negative() {
            return Some(next.clone());
        }
    }
    let next_incomplete = next_status.is_none()
        || next_status.map(|next| next.decision()) == Some("unknown".to_string())
        || !next_status.map(QqVipStatus::resolved).unwrap_or(false)
        || next_status
            .map(QqVipStatus::probe_incomplete)
            .unwrap_or(false);
    if !next_incomplete {
        return next_status.cloned();
    }
    let entitlement_expires_at = cached_status.number("expiresAt");
    if entitlement_expires_at > 0.0 && entitlement_expires_at <= now {
        return next_status.cloned();
    }
    let entry_number = |key: &str| -> f64 {
        entry
            .and_then(|entry| entry.get(key))
            .map(js_number)
            .filter(|value| value.is_finite() && *value != 0.0)
            .unwrap_or(0.0)
    };
    let cache_expires_at = {
        let value = entry_number("expiresAt");
        if value != 0.0 {
            value
        } else {
            now
        }
    };
    let stale_until = {
        let explicit = entry_number("staleUntil");
        if explicit != 0.0 {
            explicit
        } else {
            let entitlement_cap = if entitlement_expires_at > 0.0 {
                entitlement_expires_at
            } else {
                9_007_199_254_740_991.0
            };
            (cache_expires_at + grace_ms).min(entitlement_cap)
        }
    };
    if now >= stale_until {
        return next_status.cloned();
    }
    let probe_decision = next_status
        .map(QqVipStatus::decision)
        .unwrap_or_else(|| "unknown".to_string());

    let mut status = cached_status.clone();
    status.set_bool("membershipKnown", true);
    status.set_bool("resolved", true);
    status.set_text("decision", "positive");
    status.set_bool("membershipStale", true);
    status.set_text("vipSyncState", "stale_positive");
    status.set_bool("vipEvidenceConflict", probe_decision == "negative");
    status.set_text("probeDecision", &probe_decision);
    status.set_text("vipSource", "qq-vip-cache-stale-positive");
    status.set_number("staleUntil", stale_until);
    Some(status)
}
