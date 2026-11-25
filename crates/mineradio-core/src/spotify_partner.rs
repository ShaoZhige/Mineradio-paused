//! Spotify 的 pathfinder / spclient 通道（`server/spotify-partner.js` 的移植）。
//!
//! Spotify 的公开 Web API 用的是"应用级"滚动配额，Mineradio 内置的 Client ID 全体用户
//! 共享，随手就能刷出 429。所以这个模块走 Spotify 自家播放器用的那两条私有通道：
//!
//! * 读 → `api-partner.spotify.com/pathfinder/v2/query`（persisted query + sha256 哈希）
//! * 写歌单、读方案、读歌词 → `spclient.wg.spotify.com`
//!
//! 哈希是 Spotify 随时能换的私有接口，换掉时抛 [`ERR_PARTNER_RETIRED`]，上层据此降级到
//! Web API。**这不是异常而是常态**，所以错误码是契约的一部分。
//!
//! # 分层
//!
//! 1. **纯映射**（[`pick_picture`] / [`song_of`] / [`playlist_card`] / [`album_card`] …）：
//!    给同样的 payload 必然给同样的卡片，可以逐条录制回放。
//! 2. **传输抽象**（[`Transport`] / [`Auth`]）：网络与令牌由调用方注入，本 crate 不发请求。
//! 3. **通道**（[`Partner`]）：把两者接起来，负责重试、降级、错误分类。
//!
//! # 行为证明
//!
//! `tests/spotify_partner_recorded.rs` 回放 `scripts/record-spotify-partner.js` 录下的用例。
//! 每条用例除了 `fn/args/ok` 之外还带 `requests`（这次调用发出的全部请求，含 URL、method、
//! headers 顺序与 body 原文）与 `notes`（warn / log 调用的文本）。**请求形状也是契约**：
//! headers 顺序来自 `Object.assign`，body 来自 `JSON.stringify`；顺序错了 Spotify 未必拒绝，
//! 但我们就再也证明不了"与旧实现一致"。
//!
//! # JS 语义陷阱（改这个文件前必读）
//!
//! 1. **`!answer.data` 是 JS 真值**：`{}` 为真、`[]` 为真、`0` / `""` / `null` 为假。
//!    用 `is_null()` 判会漏掉"data 是空字符串"这类真实存在的情况。
//! 2. **`following: list.following === true` 是严格比较**，`"true"` / `1` 都不算。
//! 3. **`Object.assign` 的键序**：已有的键保位置换值，新键追加到末尾。所以
//!    `Authorization` 永远在最后，而 `init.headers` 里给过 `Accept` 时它留在原位。
//! 4. **`init.method || (body == null ? 'GET' : 'POST')`**：空串 method 会塌到默认值；
//!    `init.timeoutMs || timeoutMs` 同理，`0` 表示"用默认"而不是"不等"。
//! 5. **401 重试只在"令牌不是调用方显式给的"时发生**（`&& !init.token`）。
//!    显式令牌被打回 401 时重试只会再撞一次。
//! 6. **`playlistTrackCount` 的五条候选路径带 `try/catch`**：`content` 为 `null` 时
//!    `list.content.totalCount` 抛 `TypeError` 而不是给 `undefined`。两者在这里等价
//!    （都会被 `Number()` 变成非正数后跳过），但别把它当成"安全访问"就删掉后面的兜底。
//! 7. **`Number(source.width) || 0`**：缺 `width` 是 `NaN`，`NaN || 0` 是 `0`，所以
//!    "没有宽度"的图能赢过宽度为负的图（`bestWidth` 从 `-1` 起）。
//! 8. **`new Set(trackIds)` 去重保首次出现的位置**，且去重发生在长度校验之前 ——
//!    `[a, a, a]` 过校验，100 个不重复的不过。
//! 9. **`premium` 可能是 `undefined`**：`readAccount` 读不到账号方案时那个键**整个不出现**，
//!    不是 `null`。所以结果用 `Map` 手工拼，不能用 `json!` 一把梭。
//!
//! # 与 JS 的三处刻意偏差
//!
//! 1. **`slice(0, 200)` / `slice(0, 400)` 按码点而不是 UTF-16 码元切**。JS 会切出孤立
//!    代理，Rust 的 `String` 表示不了。这里的截断对象是错误消息，两者只在 emoji
//!    恰好跨在边界时差一个字符。
//! 2. **`String(init.body)` 的"已经是字符串就原样发"分支没有调用点**，所以 [`CallBody`]
//!    只有 JSON 一个变体。真要用时加变体，别偷偷 `to_string()`。
//! 3. **`offset` / `limit` 是 `i64`**。JS 传 `undefined` 时 `JSON.stringify` 会把键
//!    整个丢掉，Rust 侧没有这个状态。全部调用点都传数字。

// 错误里必须带 `statusCode` / `body` —— 上层的 `classifySpotifyError` 就是按这两个字段
// 分 429 / 403 / 404 的，缩成 Box 或砍字段都会把这份能力弄丢。结构体因此超过 clippy
// 的 128 字节阈值；但错误只在失败路径构造，`Result` 变宽不影响热路径。
#![allow(clippy::result_large_err)]

use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::js::{is_js_whitespace, js_number, js_string, js_truthy, num};

// ---------- 常量 ----------

/// pathfinder 的 persisted query 端点。
pub const QUERY_URL: &str = "https://api-partner.spotify.com/pathfinder/v2/query";

/// spclient（写歌单、读方案、读歌词）。
pub const SPCLIENT_URL: &str = "https://spclient.wg.spotify.com";

/// pathfinder / spclient 按"像不像浏览器"做风控。自造 UA 会被当成异常客户端限流，
/// 与账号配额无关 —— 同一个令牌在 spclient 的歌词接口上完全正常，说明被拒的是
/// "客户端身份"不是用户。
pub const PARTNER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/// 请求超时的默认值。
pub const DEFAULT_TIMEOUT_MS: u64 = 20_000;

/// 歌单名的长度上限（UTF-16 码元）。
pub const MAX_NAME_LENGTH: usize = 100;

/// 一次写入最多带多少首。
pub const MAX_SONGS_A_CHANGE: usize = 100;

/// 去重读歌单时最多扫的行数。
pub const DEDUPE_MAX_ROWS: u64 = 2000;

/// 去重读歌单的分页大小。
pub const DEDUPE_PAGE_ROWS: u64 = 200;

fn cached_regex(slot: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(pattern).expect("正则是常量"))
}

/// 曲目 ID：22 位 ASCII 字母数字。
pub fn track_id_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    cached_regex(&RE, r"^[0-9A-Za-z]{22}$")
}

/// 歌单 URI：`spotify:playlist:<22 位>`。
pub fn playlist_uri_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    cached_regex(&RE, r"^spotify:playlist:[0-9A-Za-z]{22}$")
}

/// 收藏条目：`spotify:(track|album|playlist):<22 位>`。
pub fn library_uri_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    cached_regex(&RE, r"^spotify:(track|album|playlist):[0-9A-Za-z]{22}$")
}

/// 专辑 URI：`spotify:album:<22 位>`。
pub fn album_uri_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    cached_regex(&RE, r"^spotify:album:[0-9A-Za-z]{22}$")
}

/// 读查询及其哈希（与 Folia 逐字一致）。
pub fn query_hash(name: &str) -> Option<&'static str> {
    Some(match name {
        "profileAttributes" => "53bcb064f6cd18c23f752bc324a791194d20df612d8e1239c735144ab0399ced",
        "libraryV3" => "390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455",
        "fetchLibraryTracks" => "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240",
        "fetchPlaylist" => "cd2275433b29f7316176e7b5b5e098ae7744724e1a52d63549c76636b3257749",
        "getAlbum" => "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10",
        "searchTracks" => "bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428",
        "getTrack" => "612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294",
        "areEntitiesInLibrary" => {
            "134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed"
        }
        _ => return None,
    })
}

/// 写操作（同样带哈希）。注意 add / remove 共用同一枚哈希。
pub fn change_hash(name: &str) -> Option<&'static str> {
    Some(match name {
        "addToLibrary" | "removeFromLibrary" => {
            "896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148"
        }
        "addItemsToRootlist" => "bd9c5cae1ee80ebca05d7ed12fd394216f49a20ce72d9dc762868df0f14522ea",
        "removeItemsFromRootlist" => {
            "3422f1866532820a1d8d0560f88542dbdbd35d0377ee5ecd49593590f5f1e86b"
        }
        "addToPlaylist" | "removeFromPlaylist" => {
            "47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990"
        }
        _ => return None,
    })
}

// ---------- 错误 ----------

/// 持久化查询失效（Spotify 换了哈希）。上层据此临时降级到 Web API。
pub const ERR_PARTNER_RETIRED: &str = "SPOTIFY_PARTNER_RETIRED";
/// 查询名 / 改动名不在表里。
pub const ERR_PARTNER_UNSUPPORTED: &str = "SPOTIFY_PARTNER_UNSUPPORTED";
/// 通道通、但这道查询没有数据（歌单不存在之类）。**不是**降级信号。
pub const ERR_PARTNER_NO_DATA: &str = "SPOTIFY_PARTNER_NO_DATA";
/// Spotify 拒了这次写入（200 + 空 data 或 null 结果）。
pub const ERR_PARTNER_CHANGE_REFUSED: &str = "SPOTIFY_PARTNER_CHANGE_REFUSED";
/// 读到账号信息但没有 username。
pub const ERR_PARTNER_NO_ACCOUNT: &str = "SPOTIFY_PARTNER_NO_ACCOUNT";
/// 歌单不存在。
pub const ERR_PARTNER_NO_PLAYLIST: &str = "SPOTIFY_PARTNER_NO_PLAYLIST";
/// 专辑不存在。
pub const ERR_PARTNER_NO_ALBUM: &str = "SPOTIFY_PARTNER_NO_ALBUM";
/// 条目 URI 认不出来。
pub const ERR_PARTNER_INVALID_ITEM: &str = "SPOTIFY_PARTNER_INVALID_ITEM";
/// 曲目 ID / URI 认不出来。
pub const ERR_PARTNER_INVALID_TRACK: &str = "SPOTIFY_PARTNER_INVALID_TRACK";
/// 歌单 URI 认不出来。
pub const ERR_PARTNER_INVALID_PLAYLIST: &str = "SPOTIFY_PARTNER_INVALID_PLAYLIST";
/// 歌单名不合法。
pub const ERR_PARTNER_INVALID_NAME: &str = "SPOTIFY_PARTNER_INVALID_NAME";
/// 想把自己的歌单从收藏里移除。
pub const ERR_PARTNER_OWN_PLAYLIST: &str = "SPOTIFY_PARTNER_OWN_PLAYLIST";
/// 请求体序列化失败。
pub const ERR_PARTNER_ENCODE: &str = "SPOTIFY_PARTNER_ENCODE";

/// 通道错误。字段对应 JS 的 `err.code` / `err.message` / `err.detail` / `err.partnerQuery`，
/// 以及传输层透出时的 `err.statusCode` / `err.body`。
///
/// **传输层错误是原样透出的**：原实现的 `call()` 不包装 `requestJson` 的 reject，所以
/// 上层能直接读 `err.statusCode` 做 429 / 403 / 404 分类。这里保留这两个字段而不是
/// 把它们编进 `detail` 文本 —— 编进去就再也解析不回来了。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PartnerError {
    pub code: String,
    pub message: String,
    /// `String(detail).slice(0, 400)`；`detail` 为空时不设。
    pub detail: Option<String>,
    /// 只有 retired 错误带这个字段（JS 的 `err.partnerQuery`）。
    pub partner_query: Option<String>,
    /// `err.statusCode`。只有传输层透出的错误有。
    pub status_code: Option<u16>,
    /// `err.body` —— 原实现里是响应文本。
    pub body: Option<String>,
}

impl PartnerError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            ..Default::default()
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail: String = detail.into();
        self.detail = Some(slice_utf16(&detail, 400));
        self
    }

    /// 把传输层错误原样搬过来：**不设 `code`**（原实现里它本来就没有），
    /// 保留 `statusCode` / `body` 供上层分类。
    pub fn from_transport(error: TransportError) -> Self {
        Self {
            code: String::new(),
            message: error.message,
            status_code: error.status_code,
            body: error.body,
            ..Default::default()
        }
    }
}

impl std::fmt::Display for PartnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(detail) = &self.detail {
            write!(f, "{}: {} ({})", self.code, self.message, detail)
        } else {
            write!(f, "{}: {}", self.code, self.message)
        }
    }
}

impl std::error::Error for PartnerError {}

/// `String.prototype.slice(0, limit)` 的近似：按码点切，不切裂字符。
fn slice_utf16(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        out.push(ch);
        units += width;
    }
    out
}

fn retired_error(name: &str, detail: &str) -> PartnerError {
    let mut error = PartnerError::new(
        ERR_PARTNER_RETIRED,
        format!("Spotify 的持久化查询 {name} 已失效"),
    );
    if !detail.is_empty() {
        error.detail = Some(slice_utf16(detail, 400));
    }
    error.partner_query = Some(name.to_string());
    error
}

// ---------- 传输抽象 ----------

/// 一次出站请求。字段已经是 wire 形态（body 是序列化后的字符串）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportRequest {
    pub url: String,
    /// `"GET"` / `"POST"`。原实现只产出这两种。
    pub method: String,
    /// **保序**。`Object.assign` 的语义：已有键换值保位置，新键追加末尾。
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: u64,
}

/// 传输层错误。对应 JS 里 `requestJson` reject 出来的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    /// `err.statusCode`。网络层失败（连接被拒、解不出 JSON）时为 `None`。
    pub status_code: Option<u16>,
    /// `err.body` —— 原实现里是**响应文本**，不是对象。
    pub body: Option<String>,
    /// `err.message`。
    pub message: String,
}

impl TransportError {
    pub fn network(message: impl Into<String>) -> Self {
        Self {
            status_code: None,
            body: None,
            message: message.into(),
        }
    }

    pub fn status(status_code: u16, body: impl Into<String>) -> Self {
        let body: String = body.into();
        Self {
            status_code: Some(status_code),
            message: format!("SPOTIFY_HTTP_{status_code}"),
            body: if body.is_empty() { None } else { Some(body) },
        }
    }
}

/// 出站请求的执行者。实现方负责把 [`TransportRequest`] 变成真正的 HTTP 调用，
/// 并把非 2xx 映射成带 `status_code` 的 [`TransportError`]。
pub trait Transport {
    fn send(
        &self,
        request: TransportRequest,
    ) -> impl Future<Output = Result<Value, TransportError>>;
}

/// 令牌来源。`force = true` 对应 JS 的 `getAccessToken({ force: true })`。
pub trait Auth {
    fn access_token(&self, force: bool) -> impl Future<Output = Result<String, PartnerError>>;
}

/// 请求体。原实现还支持"已经是字符串就原样发"，但**没有调用点**，见模块头部偏差 2。
#[derive(Debug, Clone, Copy)]
pub enum CallBody<'a> {
    Json(&'a Value),
}

/// `call()` 的可选覆盖项。
#[derive(Debug, Clone, Default)]
pub struct CallOptions<'a> {
    pub method: Option<&'a str>,
    pub body: Option<CallBody<'a>>,
    /// `0` 等同"没给"（JS 的 `||` 语义）。
    pub timeout_ms: Option<u64>,
    /// 追加/覆盖到默认头之上，顺序参与比对。
    pub headers: Vec<(&'a str, &'a str)>,
    /// 显式令牌：跳过 [`Auth`]，且 401 不重试。
    pub token: Option<&'a str>,
}

impl<'a> CallOptions<'a> {
    fn post(body: &'a Value) -> Self {
        Self {
            method: Some("POST"),
            body: Some(CallBody::Json(body)),
            ..Default::default()
        }
    }
}

/// 通道内部的两种失败：传输层的原始错误（带状态码，要用来判 retired）与业务错误。
enum CallFailure {
    Transport(TransportError),
    Partner(PartnerError),
}

impl CallFailure {
    fn into_partner(self) -> PartnerError {
        match self {
            CallFailure::Partner(error) => error,
            CallFailure::Transport(error) => PartnerError::from_transport(error),
        }
    }
}

/// `Object.assign` 的键语义：同名键换值保位置，否则追加。
///
/// ⚠️ **这条覆盖分支在现有调用点上不可观测**：`init.headers` 里唯一用到的
/// `app-platform` 只出现在 `lyrics()`，而默认头里没有它；`Content-Type` 与
/// `Authorization` 也是新键。把它改成"总是追加"，68 条录制照样全绿（负向验证实测）。
/// 保留它是因为要与 `Object.assign` 逐行对应 —— 将来 `init.headers` 里加
/// 可覆盖的头（比如自定义 `Accept-Language`）时，覆盖语义必须当场就是对的。
fn set_header(headers: &mut Vec<(String, String)>, key: &str, value: &str) {
    if let Some(slot) = headers.iter_mut().find(|(name, _)| name == key) {
        slot.1 = value.to_string();
        return;
    }
    headers.push((key.to_string(), value.to_string()));
}

// ---------- 纯映射 ----------

/// 取字段（对象才有）。
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(key))
}

/// 取字符串字段：不是字符串时给 `""`（JS 的 `typeof x === 'string' ? x : ''`）。
fn text_field(value: &Value, key: &str) -> String {
    field(value, key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// `Number(v) || 0`。注意 **`Infinity` 会保留** —— 只有 `NaN` 才塌成 0。
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = value.map(js_number).unwrap_or(f64::NAN);
    if number.is_nan() {
        0.0
    } else {
        number
    }
}

/// 从封面候选里挑最大的那张。`width` 缺失 / 非数字按 `0` 算，宽者胜，**平局保留先出现的**。
pub fn pick_picture(sources: Option<&Value>) -> String {
    let Some(Value::Array(items)) = sources else {
        return String::new();
    };
    let mut best = String::new();
    let mut best_width = -1.0f64;
    for source in items {
        let Some(url) = field(source, "url").and_then(Value::as_str) else {
            continue;
        };
        if url.is_empty() {
            continue;
        }
        let width = number_or_zero(field(source, "width"));
        if width > best_width {
            best = url.to_string();
            best_width = width;
        }
    }
    best
}

/// 从 URI 里取 22 位 id。认 `spotify:<kind>:<id>` 与老式
/// `spotify:user:<name>:<kind>:<id>` 两种。
///
/// 手写扫描而不是拼正则：`kind` 是调用方给的字面量，拼进正则后一旦有人传了
/// 带元字符的值就会变成另一种语言。
pub fn id_from_uri(uri: &Value, kind: &str) -> String {
    let Some(text) = uri.as_str() else {
        return String::new();
    };
    let Some(rest) = text.strip_prefix("spotify:") else {
        return String::new();
    };
    // `(?:user:[^:]+:)?` —— 用户名至少一个非冒号字符。
    let rest = match rest.strip_prefix("user:") {
        Some(tail) => match tail.split_once(':') {
            Some((name, after)) if !name.is_empty() => after,
            _ => return String::new(),
        },
        None => rest,
    };
    let Some(id) = rest
        .strip_prefix(kind)
        .and_then(|tail| tail.strip_prefix(':'))
    else {
        return String::new();
    };
    if id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        id.to_string()
    } else {
        String::new()
    }
}

fn tag_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    cached_regex(&RE, r"<[^>]+>")
}

fn entity_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    cached_regex(&RE, r"&(amp|lt|gt|quot|#x27|#39);")
}

/// 歌单简介是一行 HTML：去标签、还原**六种**实体、trim。
///
/// 只认这六个 —— Spotify 的简介是它自己从纯文本转义出来的，别的实体不会出现。
pub fn plain_text(html: &Value) -> String {
    let text = if js_truthy(html) {
        js_string(html)
    } else {
        String::new()
    };
    let stripped = tag_pattern().replace_all(&text, "");
    let decoded = entity_pattern().replace_all(&stripped, |caps: &regex::Captures<'_>| {
        match &caps[1] {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            // `#x27` 与 `#39` 都是单引号。
            _ => "'",
        }
        .to_string()
    });
    decoded.trim_matches(is_js_whitespace).to_string()
}

/// `[{uri, profile:{name}}]` → `[{id, name, uri}]`。
pub fn artist_rows(rows: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(items)) = rows else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|row| {
            field(row, "profile")
                .and_then(|profile| field(profile, "name"))
                .map(js_truthy)
                .unwrap_or(false)
        })
        .map(|row| {
            let name = field(row, "profile")
                .and_then(|profile| field(profile, "name"))
                .map(js_string)
                .unwrap_or_default();
            json!({
                "id": id_from_uri(field(row, "uri").unwrap_or(&Value::Null), "artist"),
                "name": name,
                "uri": text_field(row, "uri"),
            })
        })
        .collect()
}

/// pathfinder 的曲目在每种查询里都叫同一个东西，只是各自少一部分字段。
///
/// `beside.uri` 兜底喜欢列表（uri 在行上而不是曲目上）；`beside.album` 兜底专辑详情
/// （曲目自己没有 `albumOfTrack`）。
pub fn song_of(track: Option<&Value>, beside: Option<&Value>) -> Option<Value> {
    let track = track?;
    if !track.is_object() {
        return None;
    }
    // `__typename` 只在**是字符串**且不等于 `Track` 时否定。
    if let Some(typename) = field(track, "__typename").and_then(Value::as_str) {
        if typename != "Track" {
            return None;
        }
    }
    let uri = match field(track, "uri") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        _ => beside
            .and_then(|value| field(value, "uri"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default(),
    };
    let id = id_from_uri(&Value::String(uri), "track");
    let name = text_field(track, "name");
    if id.is_empty() || name.is_empty() {
        return None;
    }
    let artists = artist_rows(field(track, "artists").and_then(|value| field(value, "items")));
    let album_from_beside = beside
        .and_then(|value| field(value, "album"))
        .filter(|value| js_truthy(value))
        .cloned();
    let album = match album_from_beside {
        Some(album) => album,
        None => {
            let source = field(track, "albumOfTrack").cloned().unwrap_or(json!({}));
            json!({
                "id": id_from_uri(field(&source, "uri").unwrap_or(&Value::Null), "album"),
                "name": text_field(&source, "name"),
                "uri": text_field(&source, "uri"),
                "cover": pick_picture(
                    field(&source, "coverArt").and_then(|art| field(art, "sources"))
                ),
            })
        }
    };
    let duration = field(track, "duration")
        .and_then(|value| field(value, "totalMilliseconds"))
        .filter(|value| js_truthy(value))
        .or_else(|| {
            field(track, "trackDuration")
                .and_then(|value| field(value, "totalMilliseconds"))
                .filter(|value| js_truthy(value))
        });
    // `Math.max(0, Number(...) || 0)`
    let duration_ms = number_or_zero(duration).max(0.0);
    let artist_names: Vec<String> = artists
        .iter()
        .map(|artist| text_field(artist, "name"))
        .collect();
    Some(json!({
        "id": id,
        "uri": format!("spotify:track:{id}"),
        "name": name,
        "artists": Value::Array(artists),
        "artist": artist_names.join(" / "),
        "album": text_field(&album, "name"),
        "albumId": text_field(&album, "id"),
        "albumUri": text_field(&album, "uri"),
        "cover": text_field(&album, "cover"),
        "durationMs": num(duration_ms),
    }))
}

/// 曲目数在不同查询里挂在不同的地方：歌单页是 `content.totalCount`，库列表来自网页端
/// "资料库"那一页 —— 那页本来就不显示曲目数，可能根本没求这个字段。只认一条路径会让
/// 库列表整页 0 首。
pub fn playlist_track_count(list: &Value) -> f64 {
    if !list.is_object() {
        return 0.0;
    }
    let candidates = [
        field(list, "content").and_then(|value| field(value, "totalCount")),
        field(list, "tracksV2").and_then(|value| field(value, "totalCount")),
        field(list, "tracks").and_then(|value| field(value, "totalCount")),
        field(list, "totalCount"),
        field(list, "_content").and_then(|value| field(value, "totalCount")),
    ];
    for candidate in candidates {
        let count = js_number(candidate.unwrap_or(&Value::Null));
        if count.is_finite() && count > 0.0 {
            return count;
        }
    }
    0.0
}

/// 歌单卡片。
pub fn playlist_card(list: Option<&Value>) -> Option<Value> {
    let list = list?;
    if !list.is_object() {
        return None;
    }
    let id = id_from_uri(field(list, "uri").unwrap_or(&Value::Null), "playlist");
    if id.is_empty() {
        return None;
    }
    let images = match field(list, "images").and_then(|value| field(value, "items")) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let cover = match images.first() {
        // `images.length ? pickPicture(images[0] && images[0].sources) : ''`
        Some(first) if js_truthy(first) => pick_picture(field(first, "sources")),
        _ => String::new(),
    };
    let owner = field(list, "ownerV2")
        .and_then(|value| field(value, "data"))
        .filter(|value| js_truthy(value))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let uri = match field(list, "uri") {
        Some(Value::String(text)) => text.clone(),
        _ => format!("spotify:playlist:{id}"),
    };
    Some(json!({
        "id": id,
        "uri": uri,
        "name": text_field(list, "name"),
        "cover": cover,
        "description": plain_text(field(list, "description").unwrap_or(&Value::Null)),
        "ownerName": text_field(&owner, "name"),
        "ownerUsername": text_field(&owner, "username"),
        "trackCount": num(playlist_track_count(list)),
        "following": field(list, "following") == Some(&Value::Bool(true)),
        "canEdit": field(list, "currentUserCapabilities")
            .and_then(|caps| field(caps, "canEditItems"))
            .map(js_truthy)
            .unwrap_or(false),
    }))
}

/// 专辑卡片。`releaseDate` 保留原类型 —— `date.year` 是数字时 JS 给数字。
pub fn album_card(union: Option<&Value>) -> Option<Value> {
    let union = union?;
    let id = id_from_uri(field(union, "uri").unwrap_or(&Value::Null), "album");
    if id.is_empty() {
        return None;
    }
    let artists = artist_rows(field(union, "artists").and_then(|value| field(value, "items")));
    let release_date = field(union, "date")
        .and_then(|date| {
            field(date, "isoString")
                .filter(|value| js_truthy(value))
                .or_else(|| field(date, "year").filter(|value| js_truthy(value)))
        })
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));
    // `Number((tracksV2 && tracksV2.totalCount) || (tracks && tracks.totalCount)) || 0`
    let raw_count = field(union, "tracksV2")
        .and_then(|value| field(value, "totalCount"))
        .filter(|value| js_truthy(value))
        .or_else(|| {
            field(union, "tracks")
                .and_then(|value| field(value, "totalCount"))
                .filter(|value| js_truthy(value))
        });
    let track_count = number_or_zero(raw_count);
    let artist_names: Vec<String> = artists
        .iter()
        .map(|artist| text_field(artist, "name"))
        .collect();
    Some(json!({
        "id": id,
        "uri": format!("spotify:album:{id}"),
        "name": text_field(union, "name"),
        "cover": pick_picture(field(union, "coverArt").and_then(|art| field(art, "sources"))),
        "artists": Value::Array(artists),
        "artist": artist_names.join(" / "),
        "releaseDate": release_date,
        "trackCount": num(track_count),
    }))
}

/// 资料库列表的 variables。文件夹会被展开成它里面的歌单。
pub fn library_variables(kind: &str, limit: i64, offset: i64) -> Value {
    json!({
        "filters": [kind],
        "order": null,
        "textFilter": "",
        "features": [],
        "limit": limit,
        "offset": offset,
        "flatten": true,
        "expandedFolders": [],
        "folderUri": null,
        "includeFoldersWhenFlattening": true,
    })
}

// ---------- 通道 ----------

/// 把 [`Transport`] 与 [`Auth`] 接成 pathfinder 通道。
///
/// `own_username` 是构造时读到的账号名（[`Partner::read_account`] 写入），只用于判断
/// "这个歌单是不是自己的" —— 自己的歌单不能从收藏里移除，Spotify 会照做。
pub struct Partner<T: Transport, A: Auth> {
    transport: T,
    auth: A,
    timeout_ms: u64,
    language: String,
    warn: Arc<dyn Fn(&str) + Send + Sync>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    own_username: Mutex<String>,
}

impl<T: Transport, A: Auth> Partner<T, A> {
    pub fn new(transport: T, auth: A) -> Self {
        Self {
            transport,
            auth,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            language: "zh-CN".to_string(),
            warn: Arc::new(|_| {}),
            log: Arc::new(|_| {}),
            own_username: Mutex::new(String::new()),
        }
    }

    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    pub fn with_language(mut self, language: impl Into<String>) -> Self {
        self.language = language.into();
        self
    }

    pub fn with_warn(mut self, warn: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        self.warn = warn;
        self
    }

    pub fn with_log(mut self, log: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        self.log = log;
        self
    }

    /// `read_account` 读到的账号名（还没读过时是空串）。
    pub fn own_username(&self) -> String {
        self.own_username
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    // ----- 底层两跳 -----

    /// 发一枚请求，`bearer` 已经拼好。头里若已有 `Authorization` 则换值保位置。
    async fn send_once(
        &self,
        url: &str,
        method: &str,
        headers: &[(String, String)],
        body: Option<&str>,
        timeout_ms: u64,
        bearer: &str,
    ) -> Result<Value, TransportError> {
        let mut headers = headers.to_vec();
        set_header(&mut headers, "Authorization", &format!("Bearer {bearer}"));
        self.transport
            .send(TransportRequest {
                url: url.to_string(),
                method: method.to_string(),
                headers,
                body: body.map(str::to_string),
                timeout_ms,
            })
            .await
    }

    /// `call(url, init)`：拼头、取令牌、401 换令牌重试一次。
    async fn call(&self, url: &str, options: CallOptions<'_>) -> Result<Value, CallFailure> {
        let body = match options.body {
            None => None,
            Some(CallBody::Json(value)) => Some(serde_json::to_string(value).map_err(|error| {
                CallFailure::Partner(PartnerError::new(ERR_PARTNER_ENCODE, error.to_string()))
            })?),
        };
        let mut headers: Vec<(String, String)> = vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("Accept-Language".to_string(), self.language.clone()),
            ("User-Agent".to_string(), PARTNER_UA.to_string()),
        ];
        for (key, value) in &options.headers {
            set_header(&mut headers, key, value);
        }
        if body.is_some() {
            set_header(&mut headers, "Content-Type", "application/json");
        }
        // `init.method || (body == null ? 'GET' : 'POST')` —— 空串塌到默认。
        let method = match options.method {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => {
                if body.is_none() {
                    "GET".to_string()
                } else {
                    "POST".to_string()
                }
            }
        };
        let timeout_ms = options
            .timeout_ms
            .filter(|value| *value != 0)
            .unwrap_or(self.timeout_ms);
        let body_text = body.as_deref();

        let token = match options.token {
            Some(value) => value.to_string(),
            None => self
                .auth
                .access_token(false)
                .await
                .map_err(CallFailure::Partner)?,
        };
        match self
            .send_once(url, &method, &headers, body_text, timeout_ms, &token)
            .await
        {
            Ok(answer) => Ok(answer),
            Err(error) => {
                // 只有"令牌不是调用方显式给的"才换令牌重试。
                if error.status_code == Some(401) && options.token.is_none() {
                    self.auth
                        .access_token(true)
                        .await
                        .map_err(CallFailure::Partner)?;
                    let fresh = self
                        .auth
                        .access_token(false)
                        .await
                        .map_err(CallFailure::Partner)?;
                    return self
                        .send_once(url, &method, &headers, body_text, timeout_ms, &fresh)
                        .await
                        .map_err(CallFailure::Transport);
                }
                Err(CallFailure::Transport(error))
            }
        }
    }

    /// 一个命名读查询：返回它的 `data`。
    async fn ask(
        &self,
        name: &str,
        variables: &Value,
        token: Option<&str>,
    ) -> Result<Value, PartnerError> {
        let Some(hash) = query_hash(name) else {
            return Err(PartnerError::new(
                ERR_PARTNER_UNSUPPORTED,
                format!("未知的 Spotify 查询：{name}"),
            ));
        };
        let body = json!({
            "variables": variables,
            "operationName": name,
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } },
        });
        let mut options = CallOptions::post(&body);
        options.token = token;
        let answer = match self.call(QUERY_URL, options).await {
            Ok(answer) => answer,
            Err(CallFailure::Transport(error)) if matches!(error.status_code, Some(400 | 404)) => {
                // pathfinder 对"这枚哈希我不知道"的两种答法：400 带错误体，或 404。
                let detail = error.body.as_deref().unwrap_or(&error.message);
                return Err(retired_error(name, detail));
            }
            Err(failure) => return Err(failure.into_partner()),
        };
        let said = said_of(&answer);
        // `if (!answer || !answer.data)`
        let data = field(&answer, "data").filter(|value| js_truthy(value));
        let Some(data) = data else {
            // 只有"哈希不认识"才该整体降级。查询本身没数据是正常结果。
            if said.is_empty() || retired_pattern().is_match(&said) {
                return Err(retired_error(name, &said));
            }
            return Err(PartnerError::new(
                ERR_PARTNER_NO_DATA,
                format!("Spotify 没有返回 {name} 的数据"),
            )
            .with_detail(said));
        };
        if !said.is_empty() {
            (self.warn)(&format!("[SpotifyPartner] {name} 只答了一部分：{said}"));
        }
        Ok(data.clone())
    }

    /// 一次改动只有在 Spotify 没报错、并且给出了结果时才算完成：被拒是 200 + 空 data。
    pub async fn change(&self, name: &str, variables: &Value) -> Result<bool, PartnerError> {
        let Some(hash) = change_hash(name) else {
            return Err(PartnerError::new(
                ERR_PARTNER_UNSUPPORTED,
                format!("未知的 Spotify 改动：{name}"),
            ));
        };
        let body = json!({
            "variables": variables,
            "operationName": name,
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } },
        });
        let answer = match self.call(QUERY_URL, CallOptions::post(&body)).await {
            Ok(answer) => answer,
            Err(CallFailure::Transport(error)) if matches!(error.status_code, Some(400 | 404)) => {
                let detail = error.body.as_deref().unwrap_or(&error.message);
                return Err(retired_error(name, detail));
            }
            Err(failure) => return Err(failure.into_partner()),
        };
        let errors = error_list(&answer);
        let said = said_of(&answer);
        // `Object.values(answer.data)`：数组也算（`typeof [] === 'object'`）。
        let results = match field(&answer, "data") {
            Some(Value::Object(map)) => map.values().cloned().collect::<Vec<_>>(),
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let refused =
            !errors.is_empty() || results.is_empty() || results.iter().any(|item| item.is_null());
        if refused {
            let detail = if said.is_empty() {
                "empty result".to_string()
            } else {
                said
            };
            return Err(
                PartnerError::new(ERR_PARTNER_CHANGE_REFUSED, "Spotify 拒绝了这次改动")
                    .with_detail(detail),
            );
        }
        Ok(true)
    }

    // ----- 公开能力 -----

    /// 跑一道命名读查询，只返回 `data`（原实现里的 `partner.query`）。
    ///
    /// 不带显式令牌 —— 需要指定令牌的是 [`Partner::read_account`]，它内部走 [`Partner::ask`]。
    pub async fn query(&self, name: &str, variables: &Value) -> Result<Value, PartnerError> {
        self.ask(name, variables, None).await
    }

    /// 谁登录着、是不是付费。付费与否决定 Spotify 给不给音频。
    ///
    /// 读方案那一路失败只会 warn，`premium` 键**整个不出现**（JS 的 `undefined`）。
    pub async fn read_account(&self, token: Option<&str>) -> Result<Value, PartnerError> {
        let no_variables = json!({});
        let profile_query = self.ask("profileAttributes", &no_variables, token);
        let plan_query = async {
            let options = CallOptions {
                token,
                ..Default::default()
            };
            match self
                .call(
                    &format!("{SPCLIENT_URL}/melody/v1/product_state?market=from_token"),
                    options,
                )
                .await
            {
                Ok(plan) => Some(plan),
                Err(failure) => {
                    let error = failure.into_partner();
                    (self.warn)(&format!(
                        "[SpotifyPartner] 读不到账号方案：{}",
                        error.message
                    ));
                    None
                }
            }
        };
        let (data, plan) = futures_util::future::join(profile_query, plan_query).await;
        let data = data?;
        let profile = field(&data, "me").and_then(|me| field(me, "profile"));
        let username = profile
            .map(|value| text_field(value, "username"))
            .unwrap_or_default();
        if username.is_empty() {
            return Err(PartnerError::new(
                ERR_PARTNER_NO_ACCOUNT,
                "Spotify 没有给出账号信息",
            ));
        }
        if let Ok(mut slot) = self.own_username.lock() {
            *slot = username.clone();
        }
        let pictures = profile
            .and_then(|value| field(value, "avatar"))
            .and_then(|avatar| field(avatar, "sources"));
        // `plan ? (plan.catalogue === 'premium' || plan.product === 'premium') : undefined`
        let premium = plan.as_ref().map(|plan| {
            text_field(plan, "catalogue") == "premium" || text_field(plan, "product") == "premium"
        });
        let nickname = {
            let name = profile
                .map(|value| text_field(value, "name"))
                .unwrap_or_default();
            if name.is_empty() {
                "Spotify".to_string()
            } else {
                name
            }
        };
        let product = match premium {
            None => "unknown",
            Some(true) => "premium",
            Some(false) => "free",
        };
        // 手工拼 Map：`premium` 为 `undefined` 时那个键整个不存在。
        let mut out = Map::new();
        out.insert("id".to_string(), Value::String(username.clone()));
        out.insert("username".to_string(), Value::String(username));
        out.insert("nickname".to_string(), Value::String(nickname));
        out.insert("avatar".to_string(), Value::String(pick_picture(pictures)));
        if let Some(premium) = premium {
            out.insert("premium".to_string(), Value::Bool(premium));
        }
        out.insert("product".to_string(), Value::String(product.to_string()));
        Ok(Value::Object(out))
    }

    pub async fn search_tracks(
        &self,
        text: &str,
        offset: i64,
        limit: i64,
    ) -> Result<Value, PartnerError> {
        let variables = json!({
            "searchTerm": text,
            "offset": offset,
            "limit": limit,
            "includePreReleases": false,
            "numberOfTopResults": 20,
            "includeAudiobooks": true,
            "includeAuthors": false,
        });
        let data = self.ask("searchTracks", &variables, None).await?;
        let block = field(&data, "searchV2").and_then(|value| field(value, "tracksV2"));
        let rows = match block.and_then(|value| field(value, "items")) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let songs = rows
            .iter()
            .filter_map(|row| {
                song_of(
                    field(row, "item").and_then(|item| field(item, "data")),
                    None,
                )
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "songs": Value::Array(songs),
            "rows": rows.len(),
            "total": num(number_or_zero(block.and_then(|value| field(value, "totalCount")))),
        }))
    }

    pub async fn liked_tracks(&self, offset: i64, limit: i64) -> Result<Value, PartnerError> {
        let data = self
            .ask(
                "fetchLibraryTracks",
                &json!({ "offset": offset, "limit": limit }),
                None,
            )
            .await?;
        let tracks = field(&data, "me")
            .and_then(|me| field(me, "library"))
            .and_then(|library| field(library, "tracks"));
        let rows = match tracks.and_then(|value| field(value, "items")) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let songs = rows
            .iter()
            .filter_map(|row| {
                let track = field(row, "track");
                let beside = json!({
                    "uri": field(track.unwrap_or(&Value::Null), "_uri").cloned().unwrap_or(Value::Null),
                });
                song_of(track.and_then(|value| field(value, "data")), Some(&beside))
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "songs": Value::Array(songs),
            "rows": rows.len(),
            "total": num(number_or_zero(tracks.and_then(|value| field(value, "totalCount")))),
        }))
    }

    pub async fn library_playlists(&self, offset: i64, limit: i64) -> Result<Value, PartnerError> {
        // 注意参数顺序是 (limit, offset)。
        let variables = library_variables("Playlists", limit, offset);
        let data = self.ask("libraryV3", &variables, None).await?;
        let library = field(&data, "me").and_then(|me| field(me, "libraryV3"));
        let rows = match library.and_then(|value| field(value, "items")) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let playlists = rows
            .iter()
            .filter_map(|row| {
                playlist_card(field(row, "item").and_then(|item| field(item, "data")))
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "playlists": Value::Array(playlists),
            "rows": rows.len(),
            "total": num(number_or_zero(library.and_then(|value| field(value, "totalCount")))),
        }))
    }

    fn playlist_uri(playlist_id_or_uri: &str) -> String {
        if playlist_uri_pattern().is_match(playlist_id_or_uri) {
            playlist_id_or_uri.to_string()
        } else {
            format!("spotify:playlist:{playlist_id_or_uri}")
        }
    }

    pub async fn playlist_head(
        &self,
        playlist_id_or_uri: &str,
    ) -> Result<Option<Value>, PartnerError> {
        let uri = Self::playlist_uri(playlist_id_or_uri);
        let data = self
            .ask(
                "fetchPlaylist",
                &json!({ "uri": uri, "offset": 0, "limit": 1, "enableWatchFeedEntrypoint": false }),
                None,
            )
            .await?;
        Ok(playlist_card(field(&data, "playlistV2")))
    }

    pub async fn playlist_tracks(
        &self,
        playlist_id_or_uri: &str,
        offset: i64,
        limit: i64,
    ) -> Result<Value, PartnerError> {
        let uri = Self::playlist_uri(playlist_id_or_uri);
        let data = self
            .ask(
                "fetchPlaylist",
                &json!({ "uri": uri, "offset": offset, "limit": limit, "enableWatchFeedEntrypoint": false }),
                None,
            )
            .await?;
        let Some(list) = field(&data, "playlistV2") else {
            return Err(PartnerError::new(
                ERR_PARTNER_NO_PLAYLIST,
                "Spotify 没有返回这个歌单",
            ));
        };
        let rows = match field(list, "content").and_then(|value| field(value, "items")) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let songs = rows
            .iter()
            .filter_map(|row| {
                song_of(
                    field(row, "itemV2").and_then(|item| field(item, "data")),
                    None,
                )
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "playlist": playlist_card(Some(list)).unwrap_or(Value::Null),
            "songs": Value::Array(songs),
            "rows": rows.len(),
            "total": num(number_or_zero(
                field(list, "content").and_then(|value| field(value, "totalCount")),
            )),
        }))
    }

    pub async fn album(
        &self,
        album_id_or_uri: &str,
        offset: i64,
        limit: i64,
    ) -> Result<Value, PartnerError> {
        let uri = if album_uri_pattern().is_match(album_id_or_uri) {
            album_id_or_uri.to_string()
        } else {
            format!("spotify:album:{album_id_or_uri}")
        };
        let data = self
            .ask(
                "getAlbum",
                &json!({ "uri": uri, "locale": "", "offset": offset, "limit": limit }),
                None,
            )
            .await?;
        let union = field(&data, "albumUnion");
        let Some(card) = album_card(union) else {
            return Err(PartnerError::new(
                ERR_PARTNER_NO_ALBUM,
                "Spotify 没有返回这张专辑",
            ));
        };
        let tracks_v2 = union.and_then(|value| field(value, "tracksV2"));
        let rows = match tracks_v2.and_then(|value| field(value, "items")) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let beside = json!({ "album": card });
        let songs = rows
            .iter()
            .filter_map(|row| song_of(field(row, "track"), Some(&beside)))
            .collect::<Vec<_>>();
        // `Number(tracksV2.totalCount) || card.trackCount || 0`
        let total = number_or_zero(tracks_v2.and_then(|value| field(value, "totalCount")));
        let total = if total != 0.0 {
            total
        } else {
            number_or_zero(field(&card, "trackCount"))
        };
        Ok(json!({
            "album": card,
            "songs": Value::Array(songs),
            "rows": rows.len(),
            "total": num(total),
        }))
    }

    /// 逐条回答"这张专辑/这首歌在不在库里"，顺序与传入的 uri 一一对应。
    pub async fn library_lookup(
        &self,
        uris: &[String],
    ) -> Result<Map<String, Value>, PartnerError> {
        if uris.is_empty() {
            return Ok(Map::new());
        }
        let data = self
            .ask("areEntitiesInLibrary", &json!({ "uris": uris }), None)
            .await?;
        let rows = match field(&data, "lookup") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let mut saved = Map::new();
        for (index, uri) in uris.iter().enumerate() {
            let value = rows
                .get(index)
                .and_then(|row| field(row, "data"))
                .and_then(|data| field(data, "saved"))
                .map(|value| value == &Value::Bool(true))
                .unwrap_or(false);
            saved.insert(uri.clone(), Value::Bool(value));
        }
        Ok(saved)
    }

    pub async fn set_library(&self, uri: &str, saved: bool) -> Result<bool, PartnerError> {
        let Some(captures) = library_uri_pattern().captures(uri) else {
            return Err(PartnerError::new(
                ERR_PARTNER_INVALID_ITEM,
                format!("无法识别的 Spotify 条目：{uri}"),
            ));
        };
        if &captures[1] == "playlist" {
            // 自己的歌单不能"取消收藏"：那等于把它从库里删掉，Spotify 会照做。
            let head = self.playlist_head(uri).await?;
            let own = self.own_username();
            let owner = head
                .as_ref()
                .map(|card| text_field(card, "ownerUsername"))
                .unwrap_or_default();
            if !own.is_empty() && !owner.is_empty() && owner == own {
                return Err(PartnerError::new(
                    ERR_PARTNER_OWN_PLAYLIST,
                    "这是本账号自己的歌单，不能从收藏里移除",
                ));
            }
            let name = if saved {
                "addItemsToRootlist"
            } else {
                "removeItemsFromRootlist"
            };
            self.change(name, &json!({ "uris": [uri] })).await
        } else {
            let name = if saved {
                "addToLibrary"
            } else {
                "removeFromLibrary"
            };
            self.change(name, &json!({ "libraryItemUris": [uri] }))
                .await
        }
    }

    /// 歌单里已经有的曲子不再放一次（Spotify 自己会放成两行）。只扫前 [`DEDUPE_MAX_ROWS`] 行。
    async fn playlist_has_songs(
        &self,
        uri: &str,
        songs: &[String],
    ) -> Result<Vec<String>, PartnerError> {
        let mut found: Vec<String> = Vec::new();
        let mut offset: u64 = 0;
        while offset < DEDUPE_MAX_ROWS {
            let page = self
                .playlist_tracks(uri, offset as i64, DEDUPE_PAGE_ROWS as i64)
                .await?;
            let page_songs = match field(&page, "songs") {
                Some(Value::Array(items)) => items.clone(),
                _ => Vec::new(),
            };
            for song in &page_songs {
                let id = text_field(song, "id");
                let wanted = format!("spotify:track:{id}");
                if songs.iter().any(|candidate| candidate == &wanted) && !found.contains(&id) {
                    found.push(id);
                }
            }
            let rows = number_or_zero(field(&page, "rows"));
            let total = number_or_zero(field(&page, "total"));
            offset += rows as u64;
            if rows <= 0.0 || offset as f64 >= total {
                break;
            }
        }
        Ok(found)
    }

    /// 往歌单里加曲目。返回 `{added, existing}`，`existing` 是"本来就有了"的数量。
    pub async fn add_to_playlist(
        &self,
        playlist_id_or_uri: &str,
        track_ids: &[String],
    ) -> Result<Value, PartnerError> {
        let uri = Self::playlist_uri(playlist_id_or_uri);
        if !playlist_uri_pattern().is_match(&uri) {
            return Err(PartnerError::new(
                ERR_PARTNER_INVALID_PLAYLIST,
                format!("无法识别的 Spotify 歌单：{playlist_id_or_uri}"),
            ));
        }
        // `new Set(trackIds)`：去重、保首次出现的位置，**在长度校验之前**。
        let mut ids: Vec<String> = Vec::new();
        for id in track_ids {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        let valid = !ids.is_empty()
            && ids.len() <= MAX_SONGS_A_CHANGE
            && ids.iter().all(|id| track_id_pattern().is_match(id));
        if !valid {
            return Err(PartnerError::new(
                ERR_PARTNER_INVALID_TRACK,
                "无法识别的 Spotify 曲目",
            ));
        }
        let songs: Vec<String> = ids.iter().map(|id| format!("spotify:track:{id}")).collect();
        let existing = match self.playlist_has_songs(&uri, &songs).await {
            Ok(found) => found,
            Err(error) => {
                // 读不到歌单不代表不能写；去重是锦上添花，别让它挡了收藏这个动作。
                (self.warn)(&format!(
                    "[SpotifyPartner] 歌单去重读取失败，直接写入：{}",
                    error.message
                ));
                Vec::new()
            }
        };
        let fresh: Vec<String> = songs
            .iter()
            .filter(|song| {
                let id = song.strip_prefix("spotify:track:").unwrap_or(song);
                !existing.iter().any(|found| found == id)
            })
            .cloned()
            .collect();
        if fresh.is_empty() {
            return Ok(json!({ "added": 0, "existing": songs.len() }));
        }
        self.change(
            "addToPlaylist",
            &json!({
                "playlistItemUris": fresh,
                "playlistUri": uri,
                "newPosition": { "moveType": "BOTTOM_OF_PLAYLIST", "fromUid": null },
            }),
        )
        .await?;
        Ok(json!({
            "added": fresh.len(),
            "existing": songs.len() - fresh.len(),
        }))
    }

    /// spclient 一次 ops 建空歌单，再把它放进账号库 —— 与 Folia 的两步一致。
    pub async fn create_playlist(&self, name: &str) -> Result<Value, PartnerError> {
        let trimmed = name.trim_matches(is_js_whitespace);
        if trimmed.is_empty() || trimmed.encode_utf16().count() > MAX_NAME_LENGTH {
            return Err(PartnerError::new(
                ERR_PARTNER_INVALID_NAME,
                "歌单名字不合法",
            ));
        }
        let body = json!({
            "ops": [{
                "kind": "UPDATE_LIST_ATTRIBUTES",
                "updateListAttributes": { "newAttributes": { "values": { "name": trimmed } } },
            }],
        });
        let made = self
            .call(
                &format!("{SPCLIENT_URL}/playlist/v2/playlist?format=json"),
                CallOptions::post(&body),
            )
            .await
            .map_err(CallFailure::into_partner)?;
        let uri = text_field(&made, "uri");
        if uri.is_empty() || !playlist_uri_pattern().is_match(&uri) {
            return Err(PartnerError::new(
                ERR_PARTNER_NO_PLAYLIST,
                "Spotify 没有给出新歌单的地址",
            ));
        }
        self.change("addItemsToRootlist", &json!({ "uris": [uri] }))
            .await?;
        (self.log)(&format!("[SpotifyPartner] 新建歌单 {uri}"));
        Ok(json!({
            "id": uri.strip_prefix("spotify:playlist:").unwrap_or(&uri),
            "uri": uri,
            "name": trimmed,
        }))
    }

    /// Spotify 自己的歌词，按行带时间戳。没有 `app-platform` 头时服务端回 400。
    pub async fn lyrics(&self, track_id: &str) -> Result<Option<Value>, PartnerError> {
        if !track_id_pattern().is_match(track_id) {
            return Err(PartnerError::new(
                ERR_PARTNER_INVALID_TRACK,
                "无法识别的 Spotify 曲目",
            ));
        }
        let options = CallOptions {
            headers: vec![("app-platform", "WebPlayer")],
            ..Default::default()
        };
        let answer = match self
            .call(
                &format!(
                    "{SPCLIENT_URL}/color-lyrics/v2/track/{track_id}?format=json&vocalRemoval=false&market=from_token"
                ),
                options,
            )
            .await
        {
            Ok(answer) => answer,
            // 没有歌词就是 404 —— 这不是错误。
            Err(CallFailure::Transport(error)) if error.status_code == Some(404) => {
                return Ok(None)
            }
            Err(failure) => return Err(failure.into_partner()),
        };
        let lines = field(&answer, "lyrics")
            .and_then(|lyrics| field(lyrics, "lines"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if lines.is_empty() {
            return Ok(None);
        }
        let timed = field(&answer, "lyrics")
            .map(|lyrics| text_field(lyrics, "syncType") == "LINE_SYNCED")
            .unwrap_or(false);
        let mapped = lines
            .iter()
            .map(|line| {
                let start = number_or_zero(field(line, "startTimeMs"));
                let words = match field(line, "words") {
                    Some(value) if js_truthy(value) => js_string(value),
                    _ => String::new(),
                };
                json!({ "startMs": num(start), "words": words })
            })
            .collect::<Vec<_>>();
        Ok(Some(
            json!({ "timed": timed, "lines": Value::Array(mapped) }),
        ))
    }
}

// ---------- 错误分类辅助 ----------

fn retired_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    cached_regex(&RE, r"(?i)persisted|hash|document|not found")
}

fn error_list(answer: &Value) -> Vec<Value> {
    match field(answer, "errors") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// `errors.map(e => e && e.message).filter(Boolean).join(' | ').slice(0, 200)`
fn said_of(answer: &Value) -> String {
    let messages: Vec<String> = error_list(answer)
        .iter()
        .filter_map(|error| field(error, "message"))
        .filter(|message| js_truthy(message))
        .map(js_string)
        .collect();
    slice_utf16(&messages.join(" | "), 200)
}

// ---------- 单测 ----------
//
// 这里放的是**录制覆盖不到**的部分：私有辅助函数与"当前调用点无法触发"的分支。
// 行为级证明在 `tests/spotify_partner_recorded.rs`，两者互补。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_header_replaces_in_place() {
        let mut headers = vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("User-Agent".to_string(), "ua".to_string()),
        ];
        set_header(&mut headers, "Accept", "text/plain");
        assert_eq!(
            headers,
            vec![
                ("Accept".to_string(), "text/plain".to_string()),
                ("User-Agent".to_string(), "ua".to_string()),
            ],
            "同名键必须换值保位置，不能追加"
        );
        set_header(&mut headers, "Authorization", "Bearer x");
        assert_eq!(headers.last().unwrap().0, "Authorization", "新键追加到末尾");
        assert_eq!(headers.len(), 3);
    }

    #[test]
    fn slice_utf16_never_splits_a_character() {
        // `😀` 占两个 UTF-16 码元，限 1 时整个字符丢掉，不能切出孤立代理。
        assert_eq!(slice_utf16("a😀b", 1), "a");
        assert_eq!(slice_utf16("a😀b", 3), "a😀");
        assert_eq!(slice_utf16("a😀b", 4), "a😀b");
        // 汉字在 UTF-16 里只占一个码元（BMP），限 1 时能完整保留。
        assert_eq!(slice_utf16("中文", 1), "中");
        assert_eq!(slice_utf16("中文", 2), "中文");
    }

    #[test]
    fn pick_picture_keeps_the_first_on_a_tie() {
        let sources = json!([
            { "url": "https://first", "width": 300 },
            { "url": "https://second", "width": 300 },
            { "url": "https://small", "width": 64 },
        ]);
        assert_eq!(pick_picture(Some(&sources)), "https://first");

        // 没有 width 的图按 0 算，能赢过宽度为负的图（`bestWidth` 从 -1 起）。
        let odd = json!([
            { "url": "https://negative", "width": -5 },
            { "url": "https://nowidth" },
        ]);
        assert_eq!(pick_picture(Some(&odd)), "https://nowidth");

        // 没有 url / url 是空串的一律跳过。
        let broken = json!([{ "width": 999 }, { "url": "", "width": 999 }]);
        assert_eq!(pick_picture(Some(&broken)), "");
        assert_eq!(pick_picture(None), "");
        assert_eq!(pick_picture(Some(&json!({}))), "");
    }

    #[test]
    fn id_from_uri_accepts_the_legacy_user_form() {
        let id = "1111111111111111111111";
        let read = |uri: String| id_from_uri(&Value::String(uri), "playlist");
        assert_eq!(read(format!("spotify:playlist:{id}")), id);
        assert_eq!(read(format!("spotify:user:alice:playlist:{id}")), id);
        // 用户名不能为空、id 必须正好 22 位。
        assert_eq!(read(format!("spotify:user::playlist:{id}")), "");
        assert_eq!(read(format!("spotify:playlist:{}", &id[..21])), "");
        assert_eq!(read(format!("spotify:playlist:{id}0")), "");
        // 非 ASCII 字母数字不算（`is_ascii_alphanumeric`，不是 `is_alphanumeric`）。
        assert_eq!(
            read("spotify:playlist:１１１１１１１１１１１１１１１１１１１１１１".to_string()),
            ""
        );
        // 类型不匹配的 URI 不认。
        assert_eq!(id_from_uri(&json!(123), "playlist"), "");
        assert_eq!(read(format!("https://open.spotify.com/playlist/{id}")), "");
    }

    #[test]
    fn plain_text_strips_tags_and_decodes_six_entities() {
        assert_eq!(
            plain_text(&json!("<b>slow</b> &amp; low &#x27;start&#x27; &lt;3")),
            "slow & low 'start' <3"
        );
        assert_eq!(
            plain_text(&json!("&quot;quoted&quot; &gt; &#39;")),
            "\"quoted\" > '"
        );
        // 未知实体原样留着（JS 的替换函数 `|| ''` 只在表内名字上生效）。
        assert_eq!(plain_text(&json!("&nbsp;x")), "&nbsp;x");
        assert_eq!(plain_text(&json!("  padded \u{feff}")), "padded");
        // falsy 输入 → 空串；`{}` 是 truthy → `[object Object]`。
        assert_eq!(plain_text(&Value::Null), "");
        assert_eq!(plain_text(&json!(0)), "");
        assert_eq!(plain_text(&json!([])), "");
        assert_eq!(plain_text(&json!({})), "[object Object]");
    }

    #[test]
    fn playlist_track_count_walks_five_paths() {
        assert_eq!(
            playlist_track_count(&json!({ "content": { "totalCount": 7 } })),
            7.0
        );
        assert_eq!(
            playlist_track_count(&json!({ "tracksV2": { "totalCount": 8 } })),
            8.0
        );
        assert_eq!(
            playlist_track_count(&json!({ "tracks": { "totalCount": 9 } })),
            9.0
        );
        assert_eq!(playlist_track_count(&json!({ "totalCount": 10 })), 10.0);
        assert_eq!(
            playlist_track_count(&json!({ "_content": { "totalCount": 11 } })),
            11.0
        );
        // `content` 为 null 时 JS 会抛 TypeError 被 try/catch 吞掉 —— 等价于"跳过"。
        assert_eq!(
            playlist_track_count(&json!({ "content": null, "totalCount": 12 })),
            12.0
        );
        // 非正数与非有限值都不算数。
        assert_eq!(playlist_track_count(&json!({ "totalCount": 0 })), 0.0);
        assert_eq!(playlist_track_count(&json!({ "totalCount": -3 })), 0.0);
        assert_eq!(playlist_track_count(&json!({ "totalCount": "abc" })), 0.0);
        assert_eq!(playlist_track_count(&json!("not an object")), 0.0);
    }

    #[test]
    fn library_variables_keep_their_key_order() {
        // workspace 开了 `serde_json/preserve_order`：键序与 JS 的字面量一致，
        // 否则请求体的字节就和旧实现不同了。
        let variables = library_variables("Playlists", 50, 0);
        let keys: Vec<&str> = variables
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "filters",
                "order",
                "textFilter",
                "features",
                "limit",
                "offset",
                "flatten",
                "expandedFolders",
                "folderUri",
                "includeFoldersWhenFlattening",
            ]
        );
    }

    #[test]
    fn number_or_zero_keeps_infinity() {
        // `Number(x) || 0` 只把 NaN 塌成 0，`Infinity` 是 truthy。
        assert_eq!(number_or_zero(None), 0.0);
        assert_eq!(number_or_zero(Some(&Value::Null)), 0.0);
        assert_eq!(number_or_zero(Some(&json!(""))), 0.0);
        assert_eq!(number_or_zero(Some(&json!("12"))), 12.0);
        assert!(number_or_zero(Some(&json!("Infinity"))).is_infinite());
        assert_eq!(number_or_zero(Some(&json!("0x10"))), 16.0);
    }

    #[test]
    fn song_of_rejects_non_tracks_but_keeps_empty_typename() {
        let track = json!({
            "uri": "spotify:track:1111111111111111111111",
            "name": "One",
            "artists": { "items": [] },
        });
        let song = song_of(Some(&track), None).expect("缺 __typename 也算曲目");
        assert_eq!(song["id"], "1111111111111111111111");
        assert_eq!(song["artist"], "");
        assert_eq!(song["durationMs"], 0);

        let other = json!({
            "__typename": "Episode",
            "uri": "spotify:track:1111111111111111111111",
            "name": "One",
        });
        assert!(
            song_of(Some(&other), None).is_none(),
            "__typename 不是 Track"
        );

        // `beside.uri` 只在曲目自己没有 uri 时生效。
        let bare = json!({ "name": "From Row" });
        let beside = json!({ "uri": "spotify:track:5555555555555555555555" });
        let song = song_of(Some(&bare), Some(&beside)).expect("回落到行上的 uri");
        assert_eq!(song["id"], "5555555555555555555555");
    }

    #[test]
    fn album_card_keeps_release_date_type() {
        let numeric_year = json!({
            "uri": "spotify:album:3333333333333333333333",
            "name": "A",
            "date": { "year": 2021 },
            "tracks": { "totalCount": 3 },
        });
        let card = album_card(Some(&numeric_year)).unwrap();
        assert_eq!(card["releaseDate"], 2021, "`date.year` 是数字时 JS 给数字");
        assert_eq!(card["trackCount"], 3);

        // `date` 存在但两个字段都 falsy → 空串（`(a || b) || ''`）。
        let blank = json!({
            "uri": "spotify:album:3333333333333333333333",
            "name": "A",
            "date": { "year": 0 },
        });
        assert_eq!(album_card(Some(&blank)).unwrap()["releaseDate"], "");
    }
}
