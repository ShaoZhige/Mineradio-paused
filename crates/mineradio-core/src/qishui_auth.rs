//! 汽水音乐登录（`server/qishui-auth-v6.js` 的移植）。
//!
//! 汽水的登录接口不认裸 HTTP：每个 passport 请求的查询串上都必须带一个 44 位的
//! `a_bogus` 签名和一个服务端下发的 `msToken`，而算这两样东西的 `bdms` 只肯在
//! 真实的 Chromium 页面里跑（`webSecurity: false`、`contextIsolation: true`）。
//! 所以这个模块的本质是**编排**：起页面、等组件、拿身份、按固定形状发请求、
//! 把 2046（二次验证）走完、最后把会话 cookie 落进配置。
//!
//! # 分层：什么搬过来了，什么留在宿主
//!
//! 搬进 Rust 的（[`Runtime`]）：
//!
//! * 设备身份（`ensureIdentity` 的补齐规则）、
//! * 每个请求的查询串 / 表单体 / 头部（含 `x-ss-stub` 的 md5）、
//! * `a_bogus` 与 `msToken` 的事后校验、
//! * 二维码应答的解析与扫码地址拼装、
//! * 扫码轮询的状态机（2046 → 二次验证 → 重发 → 仍 2046 报错）、
//! * `qrGeneration` 代次守卫与 cookie 落盘的域名过滤。
//!
//! 留在宿主（[`AuthHost`]）的，只有**没有窗口就做不了的四件事**：
//!
//! 1. 起一个 `persist:` 分区的窗口、加载 seed / host 两个页面、等 `bdms` 就绪
//!    （[`AuthHost::initialize`]），顺带产出 `msToken` 与 `browserInfo.encrypted`；
//! 2. 在页面里发请求并回传 `{status, body}`（[`AuthHost::request`]）；
//! 3. 弹窗让用户做二次验证（[`AuthHost::second_verify`]）；
//! 4. 读分区里的 cookie、清分区、把文本画成二维码（[`AuthHost::jar_cookies`] /
//!    [`AuthHost::clear_storage`] / [`AuthHost::render_qr`]）。
//!
//! 另外 `webRequest.onBeforeSendHeaders` 钩子记录的那条"最后一次 passport 请求"
//! 是签名校验的唯一证据，宿主必须把它交回来（[`AuthHost::last_passport_url`]）。
//!
//! # 与 JS 的三处刻意偏差
//!
//! 1. **并发初始化不做去重**。JS 用 `this.initializing` 把并发的 `initialize()`
//!    合并成一个 promise；Rust 侧只做"已初始化则直接返回"，同时进来的第二个人会
//!    各自调一次 [`AuthHost::initialize`]。宿主自己必须是幂等的（JS 的 `_initialize`
//!    也是幂等的），而桥接层对登录流程本来就是串行的。
//! 2. **`disposeForQuit` 不在这一层**。它要做的是"退出时别再拦 close、直接销毁窗口"，
//!    属于窗口生命周期，跟着宿主走（JS 里它也只是 `window.destroy()` + 关掉资产服务器）。
//! 3. **二维码图片本身不逐像素比对**。`render_qr` 由宿主实现（JS 侧是 `qrcode` 包，
//!    Tauri 侧大概是前端库），像素编码必然不同；契约是"把这段文本画出来"，不是
//!    "产出同样的 PNG 字节"。
//!
//! # JS 语义陷阱（改这个文件前必读）
//!
//! 1. **`request_host` 是双重编码**：常量本身已经是 `app%3A%2F%2Fresources`，
//!    再经过 `searchParams.set` 一次，线上发出去的是 `app%253A%252F%252Fresources`。
//!    看着像 bug，但改掉就与旧实现不一致了。
//! 2. **`Number(data.error_code) === 0`**：`"0"` / `""` / `null` / `false` 全都算 0，
//!    `undefined` 是 NaN（不算 0）。所以"没有 error_code 字段"和"error_code 是 0"
//!    是两种不同的结果。
//! 3. **`verified.status !== true` 是严格比较**：二次验证返回 `{status: "true"}`
//!    算**没通过**，会抛 `QISHUI_MFA_CANCELLED`。
//! 4. **`{...body, ...bizParams}` 是 Object.assign 语义**：同名键换值保位置，
//!    新键追加到末尾。表单体的字节顺序因此取决于这个顺序。
//! 5. **`String(indexUrl || '')`**：`''`、`0`、`null` 都变成空串，然后 `new URL('')`
//!    抛 `ERR_INVALID_URL`。Rust 侧复刻了这个错误码（见 [`ERR_INVALID_URL`]）。
//! 6. **`data.session_cookie ? 'present' : 'absent'`** 只看真值，不看长度。

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use md5::{Digest, Md5};
use serde_json::{Map, Value};
use url::form_urlencoded;
use url::Url;

use crate::js::{js_number, js_string, js_truthy};

// ---------- 常量 ----------

/// passport 接口的根。
pub const API_BASE: &str = "https://api.qishui.com";

/// 汽水音乐的 aid（头条系的应用 id）。
pub const AID: &str = "386088";

/// 客户端版本，会作为 `version_code` 发出去。
pub const APP_VERSION: &str = "3.5.2";

/// 护照 JS SDK 版本。
pub const SDK_VERSION: &str = "2.4.13";

/// 二次验证 SDK 版本。
pub const VERIFY_SDK_VERSION: &str = "1.0.29";

/// 安全 SDK 版本（`p_zt`）。
pub const SECURE_SDK_VERSION: &str = "3.3.5";

/// `bdms` 组件版本。
pub const BDMS_VERSION: &str = "1.0.0.41";

/// 登录窗口独占的持久化分区名。**不能与其他窗口共用**：窗口开着
/// `webSecurity: false`，共用分区会把别的窗口也拖下水。
pub const AUTH_PARTITION: &str = "persist:mineradio-qishui-auth-v6";

/// 要拦下来换成本地副本的 `bdms` 地址（线上那份会校验来源）。
pub const OFFICIAL_BDMS_URL: &str =
    "https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/stable/1.0.0.41/bdms.js";

/// 登录窗口的 UA。**必须**是汽水客户端自己的 UA，换成浏览器 UA 会被风控。
pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.2.1 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36";

/// 二次验证取消（用户关窗 / 验证页没给成功）。
pub const ERR_MFA_CANCELLED: &str = "QISHUI_MFA_CANCELLED";

/// `new URL()` 解析失败时 Node 抛的错误码。JS 侧它会原样出现在 `err.code` 上，
/// 所以 Rust 侧也照抄 —— 上层若要按码分支，两边得看同一个值。
pub const ERR_INVALID_URL: &str = "ERR_INVALID_URL";

/// `a_bogus` 的长度。不是 44 就说明签名根本没注入进去。
pub const A_BOGUS_LENGTH: usize = 44;

/// 请求超时（毫秒）。这是页面里 `fetch` 的上限。
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;

/// 二次验证的网络日志最多留多少条（宿主实现里用）。
pub const MFA_LOG_LIMIT: usize = 100;

// ---------- 错误 ----------

/// 登录流程的错误。字段对应 JS 的 `err.code` / `err.message`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthError {
    /// 大多数错误是空串（JS 只 `new Error(msg)`），2046 取消才有码。
    pub code: String,
    pub message: String,
}

impl AuthError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: String::new(),
            message: message.into(),
        }
    }

    pub fn with_code(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    /// `new URL()` 抛的那个错误。文案是 Node 写死的 `Invalid URL`。
    fn invalid_url() -> Self {
        Self::with_code(ERR_INVALID_URL, "Invalid URL")
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code.is_empty() {
            return write!(formatter, "{}", self.message);
        }
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AuthError {}

// ---------- 随机源 ----------

/// 登录流程要用的全部随机性。
///
/// 抽成 trait 有两个原因：一是回放测试要能把随机流换成"录制下来的那份"，
/// 二是**密码学随机是平台设施**，core 不该绑一个具体实现（Tauri 侧用
/// `getrandom` 或 `BCryptGenRandom`，测试用流水账）。
pub trait Rng: Send + Sync {
    /// `crypto.randomInt(min, max)`：`[min, max)` 的整数。
    fn int(&self, min: u64, max: u64) -> u64;
    /// `crypto.randomBytes(size)`。
    fn bytes(&self, size: usize) -> Vec<u8>;
    /// `crypto.randomUUID()`。
    fn uuid(&self) -> String;
}

/// 十六进制小写，等价于 `buffer.toString('hex')`。
fn to_hex(bytes: &[u8]) -> String {
    use fmt::Write as _;
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

/// `randomDigits(length, firstMax)`：首位取 `[1, firstMax]`，其余取 `[0, 9]`。
///
/// 首位不能是 0 是上游的风控要求（设备号首位为 0 会被当成伪造）。
pub fn random_digits(rng: &dyn Rng, length: usize, first_max: u64) -> String {
    let mut value = rng.int(1, std::cmp::max(2, first_max + 1)).to_string();
    while value.len() < length {
        value.push_str(&rng.int(0, 10).to_string());
    }
    value
}

// ---------- 身份 ----------

/// 设备身份。四个字段都会进查询串，缺一个上游就换一套风控策略。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QishuiIdentity {
    pub device_id: String,
    pub install_id: String,
    pub verify_portrait_id: String,
    pub computer_name: String,
}

// ---------- 纯函数 ----------

static NULL_VALUE: Value = Value::Null;

/// `data.<key>`，取不到就是 `null`（对应 JS 的 `undefined`）。
fn field<'a>(data: &'a Value, key: &str) -> &'a Value {
    data.get(key).unwrap_or(&NULL_VALUE)
}

/// `envelope.data || {}`：**按真值**兜底，`{}` / `[]` 都算有值。
fn envelope_data(envelope: &Value) -> &Value {
    let data = field(envelope, "data");
    if js_truthy(data) {
        data
    } else {
        &NULL_VALUE
    }
}

/// `String(data[key])` —— **缺键**是 `"undefined"`（JSON 里没有 undefined，
/// 但 JS 里"没这个属性"就是 undefined），显式 `null` 才是 `"null"`。
fn text_or_undefined(data: &Value, key: &str) -> String {
    match data.get(key) {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(value) => js_string(value),
    }
}

/// `data[key] || ''`。
fn text_or_empty(data: &Value, key: &str) -> String {
    let value = field(data, key);
    if js_truthy(value) {
        js_string(value)
    } else {
        String::new()
    }
}

/// `Number(data.error_code)`。
fn error_code(data: &Value) -> f64 {
    js_number(field(data, "error_code"))
}

/// `normalizeBizParams`：把二次验证的 `biz_params` 统一成"字符串 → 字符串"。
///
/// 上游给过三种形状：对象、JSON 字符串、`a=1&b=2` 这种表单串。三者的处理顺序
/// 不能换 —— `JSON.parse` 成功但结果不是对象（`42` / `"x"` / `[]`）要**抛错**，
/// 而 `JSON.parse` 失败才回落到表单解析。
pub fn normalize_biz_params(value: Option<&Value>) -> Result<Map<String, Value>, AuthError> {
    let source = match value {
        Some(item) if js_truthy(item) => item,
        _ => return Ok(Map::new()),
    };
    let parsed: Value = match source {
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(parsed) => parsed,
            // `new URLSearchParams(text)` 永远不会抛：不合法的一律当字面量。
            Err(_) => {
                let mut result = Map::new();
                for (key, item) in form_urlencoded::parse(text.as_bytes()) {
                    result.insert(key.into_owned(), Value::String(item.into_owned()));
                }
                return Ok(result);
            }
        },
        other => other.clone(),
    };
    let map = match &parsed {
        Value::Object(map) => map,
        // 数字 / 布尔 / 数组 / 字符串都算"格式无效"。
        _ => return Err(AuthError::new("二次验证 biz_params 格式无效")),
    };
    let mut result = Map::new();
    for (key, item) in map {
        if item.is_null() {
            continue;
        }
        // `typeof item === 'object'` 的才 JSON 化，其余 `String(item)`。
        let text = if item.is_object() || item.is_array() {
            serde_json::to_string(item).unwrap_or_default()
        } else {
            js_string(item)
        };
        result.insert(key.clone(), Value::String(text));
    }
    Ok(result)
}

/// `mergeDecision`：把信封摊平成 decision，`data` 那层抹掉。
pub fn merge_decision(envelope: &Value) -> Map<String, Value> {
    let mut decision = Map::new();
    if let Value::Object(map) = envelope {
        for (key, value) in map {
            decision.insert(key.clone(), value.clone());
        }
    }
    if let Value::Object(map) = envelope_data(envelope) {
        for (key, value) in map {
            decision.insert(key.clone(), value.clone());
        }
    }
    decision.remove("data");
    decision
}

/// `officialScanUrl`：把上游给的 `qrcode_index_url` 换成官方扫码落地页。
///
/// 只取原地址上的 `token`，其余参数一律丢掉 —— 上游会塞一堆只有它自己认的
/// 追踪参数。最后 `+` 还原成 `%20`，因为 `URLSearchParams` 把空格编成 `+`。
pub fn official_scan_url(
    index_url: Option<&Value>,
    computer_name: &str,
) -> Result<String, AuthError> {
    let raw = match index_url {
        Some(value) if js_truthy(value) => js_string(value),
        _ => String::new(),
    };
    let source = Url::parse(&raw).map_err(|_| AuthError::invalid_url())?;
    let token = source
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    if token.is_empty() {
        return Err(AuthError::new("qrcode_index_url 缺少 token"));
    }
    let mut target =
        Url::parse("https://bff-pc.qishui.com/light/invoke/scan_login").expect("扫登录地址是常量");
    {
        let mut query = target.query_pairs_mut();
        query.append_pair("token", &token);
        query.append_pair("os", "Windows");
        query.append_pair(
            "computer_name",
            if computer_name.is_empty() {
                "Windows-PC"
            } else {
                computer_name
            },
        );
    }
    Ok(target.as_str().replace('+', "%20"))
}

/// `parseCookieString`：`a=1; b=2` → 有序键值对。
///
/// 三条容易抄漏的规则：`indexOf('=') > 0` 意味着**没有 `=` 的段与以 `=` 开头的段
/// 都被丢掉**；键值两头都 trim；同名键后者覆盖前者但**保留首次出现的位置**。
pub fn parse_cookie_string(raw: &str) -> Map<String, Value> {
    let mut result = Map::new();
    for pair in raw.split(';') {
        let Some(index) = pair.find('=') else {
            continue;
        };
        if index == 0 {
            continue;
        }
        let name = pair[..index].trim();
        let value = pair[index + 1..].trim();
        result.insert(name.to_string(), Value::String(value.to_string()));
    }
    result
}

/// `buildCookieString`：空名字的条目跳过，用 `; ` 连接。
pub fn build_cookie_string(values: &Map<String, Value>) -> String {
    values
        .iter()
        .filter(|(name, _)| !name.is_empty())
        .map(|(name, value)| format!("{name}={}", js_string(value)))
        .collect::<Vec<_>>()
        .join("; ")
}

/// `safeEndpoint`：日志里只留 origin + path，绝不带查询串（里面有 token）。
pub fn safe_endpoint(raw: &Value) -> String {
    if let Value::String(text) = raw {
        if let Ok(url) = Url::parse(text) {
            return format!("{}{}", url.origin().ascii_serialization(), url.path());
        }
    }
    let text = if js_truthy(raw) {
        js_string(raw)
    } else {
        String::new()
    };
    text.split('?').next().unwrap_or("").to_string()
}

/// 二维码的绘制参数。与 JS 侧 `QRCode.toDataURL` 的入参逐字段对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QrStyle {
    pub error_correction_level: &'static str,
    pub margin: u32,
    pub width: u32,
    pub dark: &'static str,
    pub light: &'static str,
}

/// 登录窗口用的那套二维码参数（360 px、白底黑码、M 级纠错、2 格留白）。
pub const QR_STYLE: QrStyle = QrStyle {
    error_correction_level: "M",
    margin: 2,
    width: 360,
    dark: "#000000",
    light: "#ffffff",
};

// ---------- 宿主 ----------

/// 一次 passport 请求的完整形状。宿主只负责"把它发出去"，怎么发不管。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthRequest {
    pub method: String,
    pub url: String,
    /// 顺序是契约的一部分（`x-ss-stub` 必须最后）。
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: u64,
}

/// 页面里 `fetch` 回来的东西。`status` 缺失对应 JS 的 `undefined`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthResponse {
    pub status: Option<u16>,
    pub body: String,
}

/// 分区 cookie 罐里的一条。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JarCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
}

/// 初始化完成后宿主必须交回来的两样东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitState {
    /// 页面 localStorage 里那个 118 位 + `==` 的 `msToken`。
    pub ms_token: String,
    /// `window.__qishuiBrowserInfo().encrypted`，会作为 `account_sdk_source_info` 发出去。
    pub browser_encrypted: String,
}

/// 宿主能力。只有"没有窗口就做不了"的事才允许出现在这里。
#[allow(async_fn_in_trait)]
pub trait AuthHost {
    /// `getConfig()`，每次拿到的都应该是当前值（`ensureIdentity` 会读两遍）。
    fn config(&self) -> Value;

    /// `os.hostname()`。会作为 `computer_name` 发出去（扫码页面上显示的那台机器名）。
    fn hostname(&self) -> String;

    /// `updateConfig(patch)`：合并进持久化配置。**同步**，与 JS 一致。
    fn patch_config(&self, patch: &Map<String, Value>);

    /// 起窗口、加载两页、等 `bdms`、写回 `msToken`。必须幂等。
    async fn initialize(&self) -> Result<InitState, AuthError>;

    /// 在页面里发一次请求。
    async fn request(&self, request: &AuthRequest) -> Result<AuthResponse, AuthError>;

    /// `webRequest.onBeforeSendHeaders` 记下的最后一条 passport 请求地址
    /// （签名注入后的那版，带 `a_bogus` / `msToken`）。没有就是空串。
    fn last_passport_url(&self) -> String;

    /// 弹窗做二次验证。返回 `{status, message}` 之类的对象，**不校验**形状 ——
    /// 严格比较 `status === true` 是调用方的事。
    async fn second_verify(&self, decision: &Value, general: &Value) -> Result<Value, AuthError>;

    /// 读分区里全部的 cookie（不过滤域名，过滤是调用方的事）。
    async fn jar_cookies(&self) -> Result<Vec<JarCookie>, AuthError>;

    /// 清空分区存储（cookies / localStorage / IndexedDB / CacheStorage / SW）。
    async fn clear_storage(&self) -> Result<(), AuthError>;

    /// 把文本画成 data URL。
    async fn render_qr(&self, text: &str, style: &QrStyle) -> Result<String, AuthError>;
}

// ---------- 通道 ----------

/// 日志回调（JS 侧是 `console.log`）。抽成别名是为了避开 `type_complexity`。
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

struct RuntimeState {
    initialized: bool,
    ms_token: String,
    browser_encrypted: String,
}

/// 登录编排器。状态只有"初始化过没有"和 `qrGeneration`，其余都在宿主那边。
pub struct Runtime<H: AuthHost, R: Rng> {
    host: H,
    rng: R,
    state: Mutex<RuntimeState>,
    /// 每次出码 +1。**晚到的轮询靠它认领**：响应回来时如果代次变了，
    /// 说明用户已经刷新过二维码，这批 cookie 不能落盘。
    qr_generation: Arc<AtomicU64>,
    log: Option<LogSink>,
}

impl<H: AuthHost, R: Rng> Runtime<H, R> {
    pub fn new(host: H, rng: R) -> Self {
        Self {
            host,
            rng,
            state: Mutex::new(RuntimeState {
                initialized: false,
                ms_token: String::new(),
                browser_encrypted: String::new(),
            }),
            qr_generation: Arc::new(AtomicU64::new(0)),
            log: None,
        }
    }

    /// 日志回调（JS 侧是 `console.log`）。
    pub fn with_log(mut self, log: LogSink) -> Self {
        self.log = Some(log);
        self
    }

    /// 当前代次。桥接层想"用户点了刷新"时也可以调 [`Self::bump_qr_generation`]。
    pub fn qr_generation(&self) -> u64 {
        self.qr_generation.load(Ordering::Relaxed)
    }

    /// 代次 +1。晚到的轮询会因此被丢弃。
    pub fn bump_qr_generation(&self) -> u64 {
        self.qr_generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn emit(&self, text: String) {
        if let Some(log) = &self.log {
            log(&text);
        }
    }

    // ----- 身份 -----

    /// `ensureIdentity`：配置里缺什么补什么，然后把补齐后的四件套给出来。
    ///
    /// 注意这里**每次都读一遍配置**：并发进来的两次调用会各自补一遍，靠
    /// `updateConfig` 的幂等性收场（真实实现里第二个 patch 是空的）。
    fn ensure_identity(&self) -> Result<QishuiIdentity, AuthError> {
        let config = self.host.config();
        let mut patch = Map::new();
        if !js_truthy(field(&config, "deviceId")) {
            patch.insert(
                "deviceId".to_string(),
                Value::String(random_digits(&self.rng, 16, 8)),
            );
        }
        if !js_truthy(field(&config, "installId")) {
            patch.insert(
                "installId".to_string(),
                Value::String(random_digits(&self.rng, 15, 8)),
            );
        }
        if !js_truthy(field(&config, "verifyPortraitId")) {
            patch.insert(
                "verifyPortraitId".to_string(),
                Value::String(format!("{}.login", self.rng.uuid())),
            );
        }
        if !js_truthy(field(&config, "computerName")) {
            let name = self.host.hostname();
            patch.insert(
                "computerName".to_string(),
                Value::String(if name.is_empty() {
                    "Windows-PC".to_string()
                } else {
                    name
                }),
            );
        }
        if !patch.is_empty() {
            self.host.patch_config(&patch);
        }
        let current = self.host.config();
        let text = |key: &str, fallback: &str| {
            let value = field(&current, key);
            if js_truthy(value) {
                js_string(value)
            } else {
                fallback.to_string()
            }
        };
        Ok(QishuiIdentity {
            device_id: text("deviceId", ""),
            install_id: text("installId", ""),
            verify_portrait_id: text("verifyPortraitId", ""),
            computer_name: text("computerName", "Windows-PC"),
        })
    }

    // ----- 初始化 -----

    /// 已初始化就直接返回，否则把活派给宿主。
    pub async fn initialize(&self) -> Result<(), AuthError> {
        {
            let state = self.state.lock().expect("运行时状态锁");
            if state.initialized {
                return Ok(());
            }
        }
        // 身份要在建窗口之前补齐 —— `_initialize` 的第一行就是 `ensureIdentity()`。
        self.ensure_identity()?;
        let init = self.host.initialize().await?;
        let mut state = self.state.lock().expect("运行时状态锁");
        state.initialized = true;
        state.ms_token = init.ms_token;
        state.browser_encrypted = init.browser_encrypted;
        Ok(())
    }

    fn ms_token(&self) -> String {
        self.state.lock().expect("运行时状态锁").ms_token.clone()
    }

    // ----- 请求 -----

    /// `commonParams`：每个 passport 请求都带的固定参数。
    fn common_params(&self, identity: &QishuiIdentity) -> Map<String, Value> {
        let browser_encrypted = self
            .state
            .lock()
            .expect("运行时状态锁")
            .browser_encrypted
            .clone();
        let text = |value: &str| Value::String(value.to_string());
        let mut params = Map::new();
        params.insert("passport_jssdk_version".into(), text(SDK_VERSION));
        params.insert("passport_jssdk_type".into(), text("normal"));
        params.insert("is_from_ttaccountsdk".into(), text("1"));
        params.insert("aid".into(), text(AID));
        params.insert("language".into(), text("zh"));
        params.insert("account_sdk_source".into(), text("web"));
        params.insert("p_js_v".into(), text(SDK_VERSION));
        params.insert("p_js_t".into(), text("pro"));
        params.insert("p_zt".into(), text(SECURE_SDK_VERSION));
        params.insert("p_ver".into(), text(VERIFY_SDK_VERSION));
        // 常量本身就是百分号编码过的，再过一遍 URLSearchParams 会变成 %25 —— 故意的。
        params.insert("request_host".into(), text("app%3A%2F%2Fresources"));
        params.insert("p_bd".into(), text(BDMS_VERSION));
        params.insert(
            "biz_trace_id".into(),
            Value::String(to_hex(&self.rng.bytes(4))),
        );
        params.insert("is_new_login".into(), text("1"));
        params.insert("is_from_iesaccountsaas".into(), text("1"));
        params.insert(
            "device_id".into(),
            Value::String(identity.device_id.clone()),
        );
        params.insert(
            "install_id".into(),
            Value::String(identity.install_id.clone()),
        );
        params.insert("did".into(), Value::String(identity.device_id.clone()));
        params.insert("iid".into(), Value::String(identity.install_id.clone()));
        params.insert("device_platform".into(), text("PC"));
        params.insert("version_code".into(), text(APP_VERSION));
        params.insert(
            "account_sdk_source_info".into(),
            Value::String(browser_encrypted),
        );
        params.insert("msToken".into(), Value::String(self.ms_token()));
        params
    }

    /// `requestHeaders`：五个头部，顺序固定。
    fn request_headers(
        &self,
        identity: &QishuiIdentity,
        biz_trace_id: &str,
    ) -> Vec<(String, String)> {
        let trace_id = to_hex(&self.rng.bytes(16));
        let short: String = trace_id.chars().take(16).collect();
        vec![
            (
                "Accept".to_string(),
                "application/json, text/javascript".to_string(),
            ),
            ("User-Agent".to_string(), UA.to_string()),
            (
                "x-tt-passport-verify-portrait".to_string(),
                identity.verify_portrait_id.clone(),
            ),
            (
                "x-tt-passport-trace-id".to_string(),
                biz_trace_id.to_string(),
            ),
            (
                "x-tt-trace-id".to_string(),
                format!("00-{trace_id}-{short}-01"),
            ),
        ]
    }

    /// `this.request(...)`：拼请求、发出去、校验签名、解析信封。
    pub async fn request(
        &self,
        method: &str,
        pathname: &str,
        params: Option<&Map<String, Value>>,
        data: Option<&Map<String, Value>>,
    ) -> Result<Value, AuthError> {
        self.initialize().await?;
        let identity = self.ensure_identity()?;

        let mut query = self.common_params(&identity);
        if let Some(extra) = params {
            for (key, value) in extra {
                query.insert(key.clone(), value.clone());
            }
        }

        let base = Url::parse(API_BASE).expect("API_BASE 是常量");
        let mut url = base.join(pathname).map_err(|_| AuthError::invalid_url())?;
        if query.values().any(|value| !value.is_null()) {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in &query {
                if value.is_null() {
                    continue;
                }
                pairs.append_pair(key, &js_string(value));
            }
        }
        let biz_trace_id = match query.get("biz_trace_id") {
            Some(value) => js_string(value),
            None => String::new(),
        };
        let mut headers = self.request_headers(&identity, &biz_trace_id);

        let body = match data {
            Some(fields) => {
                let mut serializer = form_urlencoded::Serializer::new(String::new());
                for (key, value) in fields {
                    if value.is_null() {
                        continue;
                    }
                    serializer.append_pair(key, &form_value(value));
                }
                let body = serializer.finish();
                headers.push((
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                ));
                let mut hasher = Md5::new();
                hasher.update(body.as_bytes());
                headers.push((
                    "x-ss-stub".to_string(),
                    format!("{:x}", hasher.finalize()).to_uppercase(),
                ));
                Some(body)
            }
            None => None,
        };

        let request = AuthRequest {
            method: method.trim().to_uppercase(),
            url: url.as_str().to_string(),
            headers,
            body,
            timeout_ms: REQUEST_TIMEOUT_MS,
        };
        let response = self.host.request(&request).await?;

        // `response.status < 200 || response.status >= 400` —— `undefined` 两边都是 false，
        // 所以"没有状态码"是放行的，不能当成失败。
        if let Some(status) = response.status {
            if !(200..400).contains(&status) {
                return Err(AuthError::new(format!(
                    "汽水登录接口 HTTP {status}: {}",
                    slice_chars(&response.body, 300)
                )));
            }
        }

        let text = if response.body.is_empty() {
            "{}"
        } else {
            response.body.as_str()
        };
        let envelope: Value = serde_json::from_str(text)
            .map_err(|_| AuthError::new("汽水登录接口返回了无效 JSON"))?;

        // 签名到底注入成功没有：`a_bogus` 必须 44 位、`msToken` 必须还是我们自己那个。
        let signed = self.host.last_passport_url();
        let (a_bogus, signed_ms_token) = match Url::parse(&signed) {
            Ok(parsed) => {
                let pick = |name: &str| {
                    parsed
                        .query_pairs()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| value.into_owned())
                        .unwrap_or_default()
                };
                (pick("a_bogus"), pick("msToken"))
            }
            Err(_) => (String::new(), String::new()),
        };
        if a_bogus.chars().count() != A_BOGUS_LENGTH || signed_ms_token != self.ms_token() {
            return Err(AuthError::new(
                "汽水安全参数注入失败：a_bogus 或 msToken 缺失",
            ));
        }
        Ok(envelope)
    }

    // ----- 二维码 -----

    /// `getQrCode()`。
    pub async fn get_qr_code(&self) -> Result<Value, AuthError> {
        self.bump_qr_generation();
        self.initialize().await?;
        let identity = self.ensure_identity()?;
        let mut params = Map::new();
        params.insert("next".into(), Value::String(API_BASE.to_string()));
        params.insert("need_logo".into(), Value::String("false".into()));
        params.insert("need_short_url".into(), Value::String("false".into()));
        let mut envelope = self
            .request("GET", "/passport/web/get_qrcode/", Some(&params), None)
            .await?;

        let data = envelope_data(&envelope);
        let code = error_code(data);
        let message = field(&envelope, "message");
        if js_string(message) != "success" || code != 0.0 {
            let detail = if js_truthy(field(data, "description")) {
                js_string(field(data, "description"))
            } else if js_truthy(message) {
                js_string(message)
            } else {
                String::new()
            };
            return Err(AuthError::new(format!(
                "二维码生成失败：code={} {}",
                text_or_undefined(data, "error_code"),
                detail
            )));
        }

        let scan_url = official_scan_url(
            Some(field(data, "qrcode_index_url")),
            &identity.computer_name,
        )?;
        let qrcode = self.host.render_qr(&scan_url, &QR_STYLE).await?;
        let mut merged = match data {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        merged.insert("qrcode".into(), Value::String(qrcode));
        merged.insert("scan_url".into(), Value::String(scan_url));
        if let Value::Object(map) = &mut envelope {
            map.insert("data".into(), Value::Object(merged));
        }
        Ok(envelope)
    }

    /// `checkQrConnect(token)`：轮询扫码状态，必要时把二次验证走完。
    pub async fn check_qr_connect(&self, token: &str) -> Result<Value, AuthError> {
        let generation = self.qr_generation();
        self.initialize().await?;
        let identity = self.ensure_identity()?;

        let mut body = Map::new();
        body.insert("need_logo".into(), Value::String("false".into()));
        body.insert("need_short_url".into(), Value::String("false".into()));
        body.insert("is_frontier".into(), Value::String("true".into()));
        body.insert("token".into(), Value::String(token.to_string()));
        body.insert("is_new_login".into(), Value::String("1".into()));
        body.insert("next".into(), Value::String(API_BASE.to_string()));

        let mut envelope = self
            .request(
                "POST",
                "/passport/web/check_qrconnect/",
                Some(&Map::new()),
                Some(&body),
            )
            .await?;
        let mut data_value = envelope_data(&envelope).clone();

        if error_code(&data_value) == 2046.0 {
            let mut decision = merge_decision(&envelope);
            if !js_truthy(decision.get("verify_portrait_id").unwrap_or(&NULL_VALUE)) {
                decision.insert(
                    "verify_portrait_id".into(),
                    Value::String(identity.verify_portrait_id.clone()),
                );
            }
            let biz_params = normalize_biz_params(decision.get("biz_params"))?;
            let decision_value = Value::Object(decision);
            let general = json_general_params(&identity);
            let verified = self.host.second_verify(&decision_value, &general).await?;
            // `verified.status !== true`：字符串 "true" 不算通过。
            let passed = js_truthy(&verified) && field(&verified, "status") == &Value::Bool(true);
            if !passed {
                let message = field(&verified, "message");
                let text = if js_truthy(message) {
                    js_string(message)
                } else {
                    "二次验证未完成".to_string()
                };
                return Err(AuthError::with_code(ERR_MFA_CANCELLED, text));
            }
            // `{...body, ...bizParams}`：同名键换值保位置。
            let mut merged = body.clone();
            for (key, value) in &biz_params {
                merged.insert(key.clone(), value.clone());
            }
            let mut resend = Map::new();
            resend.insert("isResend".into(), Value::String("true".into()));
            envelope = self
                .request(
                    "POST",
                    "/passport/web/check_qrconnect/",
                    Some(&resend),
                    Some(&merged),
                )
                .await?;
            data_value = envelope_data(&envelope).clone();
            if error_code(&data_value) == 2046.0 {
                return Err(AuthError::new(
                    "二次验证已通过，但服务端仍返回 2046；请重新刷新二维码",
                ));
            }
        }

        // 扫码链路只能靠日志定位：只记状态与字段有无，绝不打印 cookie 值。
        // 轮询每 2s 一次，"还在等"且没拿到会话时不写，免得把日志刷掉。
        let has_session = js_truthy(field(&data_value, "session_cookie"));
        let status_text = text_or_undefined(&data_value, "status");
        let code = error_code(&data_value);
        if has_session || code != 0.0 || (!status_text.is_empty() && status_text != "1") {
            self.emit(format!(
                "[QishuiQr] check code={} status={} session_cookie={} gen={}/{}",
                text_or_undefined(&data_value, "error_code"),
                status_text,
                if has_session { "present" } else { "absent" },
                generation,
                self.qr_generation()
            ));
        }

        if generation == self.qr_generation()
            && code == 0.0
            && (status_text == "3" || status_text == "confirmed" || has_session)
        {
            let session_cookie = text_or_empty(&data_value, "session_cookie");
            self.persist_session_cookies(&session_cookie, generation)
                .await?;
        }
        Ok(envelope)
    }

    /// `persistSessionCookies`：把分区里的 cookie 与响应体里的会话字段合并落盘。
    async fn persist_session_cookies(
        &self,
        session_cookie: &str,
        generation: u64,
    ) -> Result<(), AuthError> {
        let mut current = Map::new();
        for cookie in self.host.jar_cookies().await? {
            let domain = cookie.domain.trim_start_matches('.').to_lowercase();
            if domain == "qishui.com" || domain.ends_with(".qishui.com") {
                current.insert(cookie.name, Value::String(cookie.value));
            }
        }
        let jar_names: Vec<String> = current.keys().cloned().collect();
        let from_response = parse_cookie_string(session_cookie);
        let response_names: Vec<String> = from_response.keys().cloned().collect();
        for (name, value) in from_response {
            current.insert(name, value);
        }
        // 只记名字不记值：会话字段到底是从浏览器 cookie 罐落进来的，还是响应体
        // `session_cookie` 给的，决定了以后该往哪条路修。
        let join = |names: &[String]| {
            if names.is_empty() {
                "none".to_string()
            } else {
                names.join(",")
            }
        };
        let stored: Vec<String> = current.keys().cloned().collect();
        self.emit(format!(
            "[QishuiQr] persist jar=[{}] response=[{}] stored=[{}]",
            join(&jar_names),
            join(&response_names),
            join(&stored)
        ));
        if generation != self.qr_generation() {
            return Ok(());
        }
        let mut patch = Map::new();
        patch.insert(
            "cookie".into(),
            Value::String(build_cookie_string(&current)),
        );
        patch.insert("msToken".into(), Value::String(self.ms_token()));
        self.host.patch_config(&patch);
        Ok(())
    }

    /// `clear()`：代次 +1、清分区、把运行时状态抹掉。
    pub async fn clear(&self) -> Result<(), AuthError> {
        self.bump_qr_generation();
        self.host.clear_storage().await?;
        let mut state = self.state.lock().expect("运行时状态锁");
        state.initialized = false;
        state.ms_token.clear();
        state.browser_encrypted.clear();
        Ok(())
    }
}

/// `typeof item === 'object' ? JSON.stringify(item) : String(item)` 里的 JSON 边。
fn form_value(value: &Value) -> String {
    if value.is_object() || value.is_array() {
        serde_json::to_string(value).unwrap_or_default()
    } else {
        js_string(value)
    }
}

/// 按**码点**截断。JS 的 `slice` 按 UTF-16 码元，会在 emoji 中间切开；
/// 这里的截断对象是错误消息，只在跨边界时差一个字符。
fn slice_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit).collect()
}

/// 二次验证要的 `generalParams`。键序与 JS 的字面量一致。
fn json_general_params(identity: &QishuiIdentity) -> Value {
    let mut general = Map::new();
    general.insert(
        "device_id".into(),
        Value::String(identity.device_id.clone()),
    );
    general.insert(
        "install_id".into(),
        Value::String(identity.install_id.clone()),
    );
    general.insert("did".into(), Value::String(identity.device_id.clone()));
    general.insert("iid".into(), Value::String(identity.install_id.clone()));
    general.insert("device_platform".into(), Value::String("PC".into()));
    general.insert("version_code".into(), Value::String(APP_VERSION.into()));
    let mut root = Map::new();
    root.insert("generalParams".into(), Value::Object(general));
    Value::Object(root)
}

// ---------- 单测 ----------
//
// 这里放的是**录制覆盖不到**的部分：私有辅助函数、以及"当前调用点触发不了"的
// 分支（空 cookie 名、`computerName` 为空、错误消息截断、代次晚到）。行为级证明
// 在 `tests/qishui_auth_recorded.rs`，两者互补。

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(value: &str) -> Value {
        Value::String(value.to_string())
    }

    #[test]
    fn parse_cookie_string_skips_broken_pairs() {
        let parsed = parse_cookie_string(" a = 1 ; b=2; novalue; =orphan; c=; d=x=y");
        let keys: Vec<&str> = parsed.keys().map(String::as_str).collect();
        // `" =orphan"` 这一段的等号在**下标 1**（前面有个空格），所以 `index > 0` 成立，
        // JS 会老老实实插一个空名字的键。这正是 `buildCookieString` 要 `filter(name)`
        // 的原因 —— 空名字不是理论情况，是这条输入造出来的。
        assert_eq!(
            keys,
            vec!["a", "b", "", "c", "d"],
            "没有等号的段丢掉，以等号「开头」的也丢"
        );
        assert_eq!(parsed[""], text("orphan"));
        assert_eq!(parsed["a"], text("1"), "键值两头 trim");
        assert_eq!(parsed["c"], text(""), "空值是合法的");
        assert_eq!(parsed["d"], text("x=y"), "只按第一个等号切");

        // 同名键：后者覆盖前者，**位置**留在第一次出现的地方。
        let parsed = parse_cookie_string("a=1; b=2; a=3");
        let keys: Vec<&str> = parsed.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["a", "b"]);
        assert_eq!(parsed["a"], text("3"));
    }

    #[test]
    fn build_cookie_string_skips_empty_names() {
        let mut values = Map::new();
        values.insert("a".to_string(), text("1"));
        values.insert(String::new(), text("ghost"));
        values.insert("b".to_string(), text("2"));
        // 空名字的条目只可能从 cookie 罐里来（`parseCookieString` 已经挡掉了）。
        assert_eq!(build_cookie_string(&values), "a=1; b=2");
    }

    #[test]
    fn official_scan_url_keeps_only_the_token() {
        let url = official_scan_url(
            Some(&text(
                "https://api.qishui.com/passport/web/qrcode_index/?token=abc+def&track=1",
            )),
            "PC-1",
        )
        .expect("正常地址");
        assert_eq!(
            url,
            "https://bff-pc.qishui.com/light/invoke/scan_login?token=abc%20def&os=Windows&computer_name=PC-1",
            "`+` 要还原成 %20，只留 token"
        );

        // computerName 为空时回落成 Windows-PC（`computerName || 'Windows-PC'`）。
        let url = official_scan_url(Some(&text("https://x/?token=t")), "").expect("地址");
        assert!(url.ends_with("computer_name=Windows-PC"), "实际 {url}");

        // 没有 token。
        let error = official_scan_url(Some(&text("https://x/?from=pc")), "PC").unwrap_err();
        assert_eq!(error.message, "qrcode_index_url 缺少 token");
        assert_eq!(error.code, "");

        // 整个缺失 / 空串 → `new URL('')` 那个错。
        for value in [
            None,
            Some(Value::Null),
            Some(text("")),
            Some(Value::from(0)),
        ] {
            let error = official_scan_url(value.as_ref(), "PC").unwrap_err();
            assert_eq!(error.code, ERR_INVALID_URL);
            assert_eq!(error.message, "Invalid URL");
        }
    }

    #[test]
    fn normalize_biz_params_follows_the_three_shapes() {
        let map = normalize_biz_params(Some(&json_object(&[
            ("ch", text("1")),
            ("n", Value::from(0)),
            ("flag", Value::Bool(false)),
            ("skip", Value::Null),
            ("obj", json!({ "a": 1 })),
            ("arr", json!([1, 2])),
        ])))
        .expect("对象");
        assert_eq!(map["ch"], text("1"));
        assert_eq!(map["n"], text("0"), "0 是数字，String(0) 是 \"0\"");
        assert_eq!(map["flag"], text("false"));
        assert!(!map.contains_key("skip"), "null 要跳过（undefined 同理）");
        assert_eq!(map["obj"], text("{\"a\":1}"));
        assert_eq!(map["arr"], text("[1,2]"));

        // 表单串：`URLSearchParams` 语义，同名后者覆盖。
        let map = normalize_biz_params(Some(&text("a=1&b=x+y&a=2"))).expect("表单串");
        let keys: Vec<&str> = map.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["a", "b"]);
        assert_eq!(map["a"], text("2"));
        assert_eq!(map["b"], text("x y"), "+ 解码成空格");

        // JSON 字符串成功但结果不是对象 → 抛错（不能回落到表单解析）。
        let error = normalize_biz_params(Some(&text("42"))).unwrap_err();
        assert_eq!(error.message, "二次验证 biz_params 格式无效");
        let error = normalize_biz_params(Some(&text("[]"))).unwrap_err();
        assert_eq!(error.message, "二次验证 biz_params 格式无效");

        // falsy 一律空表。
        for value in [
            None,
            Some(Value::Null),
            Some(text("")),
            Some(Value::from(0)),
        ] {
            assert!(normalize_biz_params(value.as_ref()).unwrap().is_empty());
        }
    }

    #[test]
    fn merge_decision_lifts_data_and_drops_it() {
        let decision = merge_decision(&json!({
            "message": "success",
            "data": { "error_code": 2046, "message": "覆盖掉外层" },
        }));
        assert_eq!(
            decision["message"],
            text("覆盖掉外层"),
            "data 里的同名键后写，覆盖"
        );
        assert_eq!(decision["error_code"], Value::from(2046));
        assert!(!decision.contains_key("data"), "data 那层要抹掉");

        // data 不是对象时只有信封本身。
        let decision = merge_decision(&json!({ "message": "x", "data": "not-an-object" }));
        assert_eq!(decision["message"], text("x"));
        assert!(!decision.contains_key("data"));
    }

    #[test]
    fn text_helpers_distinguish_missing_from_null() {
        let data = json!({ "present": "x", "empty": "", "null": null, "zero": 0 });
        assert_eq!(text_or_undefined(&data, "present"), "x");
        assert_eq!(text_or_undefined(&data, "missing"), "undefined");
        assert_eq!(text_or_undefined(&data, "null"), "null");
        assert_eq!(text_or_empty(&data, "empty"), "");
        assert_eq!(text_or_empty(&data, "zero"), "", "0 是 falsy");
        assert_eq!(text_or_empty(&data, "missing"), "");
        // 非对象取值同样给 undefined。
        assert_eq!(text_or_undefined(&Value::Bool(true), "x"), "undefined");
    }

    #[test]
    fn slice_chars_counts_code_points() {
        assert_eq!(slice_chars("abc", 3), "abc");
        assert_eq!(slice_chars("abcd", 3), "abc");
        // 单个 emoji 在 Rust 里是一个字符，不会被切成孤立代理。
        assert_eq!(slice_chars("a😀b", 2), "a😀");
        assert_eq!(slice_chars("", 3), "");
    }

    #[test]
    fn form_value_jsonifies_containers_only() {
        assert_eq!(form_value(&json!({ "a": 1 })), "{\"a\":1}");
        assert_eq!(form_value(&json!([1, "b"])), "[1,\"b\"]");
        assert_eq!(form_value(&text("plain")), "plain");
        assert_eq!(form_value(&Value::from(12)), "12");
        assert_eq!(form_value(&Value::Bool(true)), "true");
    }

    #[test]
    fn random_digits_keeps_the_first_digit_in_range() {
        struct FixedRng;
        impl Rng for FixedRng {
            fn int(&self, min: u64, max: u64) -> u64 {
                min + (max - min) / 2
            }
            fn bytes(&self, size: usize) -> Vec<u8> {
                vec![0; size]
            }
            fn uuid(&self) -> String {
                "uuid".to_string()
            }
        }
        // 首位走 `randomInt(1, max(2, firstMax + 1))` = `randomInt(1, 9)`，
        // 之后每位数走 `randomInt(0, 10)`；FixedRng 都取区间中点。
        let digits = random_digits(&FixedRng, 4, 8);
        assert_eq!(digits.len(), 4);
        assert_eq!(digits, "5555");
        assert_eq!(digits.chars().next().unwrap(), '5', "首位落在 [1,8] 之内");
    }

    #[test]
    fn safe_endpoint_keeps_origin_and_path() {
        assert_eq!(
            safe_endpoint(&text(
                "https://api.qishui.com/passport/web/check_qrconnect/?token=secret"
            )),
            "https://api.qishui.com/passport/web/check_qrconnect/",
            "查询串里有 token，绝不能进日志"
        );
        assert_eq!(safe_endpoint(&text("not a url?x=1")), "not a url");
        assert_eq!(safe_endpoint(&Value::Null), "");
    }

    // ----- 代次守卫 -----

    struct StubHost {
        patches: Arc<Mutex<Vec<Value>>>,
    }

    impl AuthHost for StubHost {
        fn config(&self) -> Value {
            json!({
                "deviceId": "1",
                "installId": "2",
                "verifyPortraitId": "3",
                "computerName": "PC",
            })
        }

        fn hostname(&self) -> String {
            "PC".to_string()
        }

        fn patch_config(&self, patch: &Map<String, Value>) {
            self.patches
                .lock()
                .expect("补丁锁")
                .push(Value::Object(patch.clone()));
        }

        async fn initialize(&self) -> Result<InitState, AuthError> {
            Ok(InitState {
                ms_token: "ms".to_string(),
                browser_encrypted: "enc".to_string(),
            })
        }

        async fn request(&self, _request: &AuthRequest) -> Result<AuthResponse, AuthError> {
            unreachable!("这个用例不发请求")
        }

        fn last_passport_url(&self) -> String {
            String::new()
        }

        async fn second_verify(
            &self,
            _decision: &Value,
            _general: &Value,
        ) -> Result<Value, AuthError> {
            unreachable!("这个用例不做二次验证")
        }

        async fn jar_cookies(&self) -> Result<Vec<JarCookie>, AuthError> {
            Ok(vec![
                JarCookie {
                    name: "sessionid".to_string(),
                    value: "v".to_string(),
                    domain: ".qishui.com".to_string(),
                },
                JarCookie {
                    name: "foreign".to_string(),
                    value: "x".to_string(),
                    domain: ".example.com".to_string(),
                },
            ])
        }

        async fn clear_storage(&self) -> Result<(), AuthError> {
            Ok(())
        }

        async fn render_qr(&self, _text: &str, _style: &QrStyle) -> Result<String, AuthError> {
            unreachable!("这个用例不画二维码")
        }
    }

    struct NoRng;
    impl Rng for NoRng {
        fn int(&self, min: u64, _max: u64) -> u64 {
            min
        }
        fn bytes(&self, size: usize) -> Vec<u8> {
            vec![0; size]
        }
        fn uuid(&self) -> String {
            "u".to_string()
        }
    }

    #[tokio::test]
    async fn stale_poll_never_persists() {
        let host = StubHost {
            patches: Arc::new(Mutex::new(Vec::new())),
        };
        let probe = host.patches.clone();
        let runtime = Runtime::new(host, NoRng);
        // 出码两次 → 代次 2；拿一个过期代次去落盘。
        runtime.bump_qr_generation();
        runtime.bump_qr_generation();
        runtime
            .persist_session_cookies("k=v", 1)
            .await
            .expect("落盘不报错");
        assert!(
            probe.lock().expect("补丁锁").is_empty(),
            "代次不符时一个字都不能写"
        );

        // 代次对上才写，并且只写 qishui.com 及其子域。
        runtime
            .persist_session_cookies("k=v", 2)
            .await
            .expect("落盘");
        let patches = probe.lock().expect("补丁锁").clone();
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0]["cookie"], text("sessionid=v; k=v"));
        // `ms_token` 是空串：这个桩没走过 initialize。
        assert_eq!(patches[0]["msToken"], text(""));
    }

    /// 小工具：按给定顺序造一个对象（`json!` 的宏展开会按字面量顺序，这里只是更好读）。
    fn json_object(pairs: &[(&str, Value)]) -> Value {
        let mut map = Map::new();
        for (key, value) in pairs {
            map.insert((*key).to_string(), value.clone());
        }
        Value::Object(map)
    }
}
