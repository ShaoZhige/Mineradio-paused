//! 汽水扫码登录的会话卡：`server/qishui-qr-login.js` 的状态机。
//!
//! 与 [`crate::qishui_auth`] 的分工：那边只管"怎么跟上游说话"（出码、轮询、清分区），
//! 这边管"这台机器上算不算登录了" —— 活动令牌、二维码代次、确认结果的一次性缓存、
//! 会话卡落盘。两层之间的接口就是 [`QrAuth`]，实现可以是 `qishui_auth::Runtime`，
//! 也可以是测试里的桩。
//!
//! 三处容易被抄错的地方：
//!
//! 1. **载荷校验在代次校验之前**。`createQrCode` 先看 `data.token` / `data.qrcode`，
//!    再比 `generation !== qrGeneration`。顺序反了的话，刷新二维码那条用例会报
//!    `REPLACED` 而不是它真正的原因。
//! 2. **确认条件里的 `Number(data.error_code) === 0` 不能写成"缺键也算 0"**。
//!    JS 里缺键是 `Number(undefined)` = `NaN`，只有键存在且是 `""` / `null` / `"0"` /
//!    `0` 才是 0。
//! 3. **报错时 `qrPending` 保持为真**。`createQrCode` 在 `await` 之前就把 `qrPending`
//!    置真了，之后抛错不会回滚 —— 这个"脏状态"是原实现的既有行为，照抄。
//!
//! 配置文件的加密（`safeStorage` + `MR1` 信封）不在这里：`QrConfigStore` 收发的都是
//! **明文**，加解密归宿主（P4）。

use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::js::{js_number, js_string, js_truthy};
use crate::qishui_auth::{AuthError, AuthHost, Rng, Runtime};

/// 上游给的二维码载荷缺 token 或 qrcode。
pub const ERR_PAYLOAD_INCOMPLETE: &str = "QISHUI_QR_PAYLOAD_INCOMPLETE";
/// 出码期间用户又刷新了一次，先到的那个作废。
pub const ERR_REPLACED: &str = "QISHUI_QR_REPLACED";
/// 轮询没带令牌。
pub const ERR_TOKEN_REQUIRED: &str = "QISHUI_QR_TOKEN_REQUIRED";

// 不加 `Send`：`qishui_auth::AuthHost` 的 async 方法本身没有 `Send` 约束，硬加会在
// 适配层炸掉。真正需要跨线程时（P3 的桥接层）再在调用侧把整段包进专用线程，
// 而不是要求每个宿主实现都满足 `Send`。
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// 登录状态机的错误。字段对应 JS 的 `err.code` / `err.message`；这三条错误的码与文案相同。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QrLoginError {
    pub code: String,
    pub message: String,
}

impl QrLoginError {
    fn coded(code: &str) -> Self {
        Self {
            code: code.to_string(),
            message: code.to_string(),
        }
    }

    /// 上游错误原样透出 —— JS 里 `await auth.getQrCode()` 的 reject 不包装。
    fn from_auth(error: AuthError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

/// 这个单元需要用到的上游能力（`qishui_auth::Runtime` 已经全部具备）。
///
/// 故意只列这三个：接口越窄，测试桩越好写，也越不容易把窗口层的东西漏进来。
pub trait QrAuth {
    fn get_qr_code(&self) -> BoxFuture<'_, Result<Value, AuthError>>;
    fn check_qr_connect<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<Value, AuthError>>;
    fn clear(&self) -> BoxFuture<'_, Result<(), AuthError>>;
}

impl<H: AuthHost + 'static, R: Rng + 'static> QrAuth for Runtime<H, R> {
    fn get_qr_code(&self) -> BoxFuture<'_, Result<Value, AuthError>> {
        Box::pin(Runtime::get_qr_code(self))
    }

    fn check_qr_connect<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<Value, AuthError>> {
        Box::pin(Runtime::check_qr_connect(self, token))
    }

    fn clear(&self) -> BoxFuture<'_, Result<(), AuthError>> {
        Box::pin(Runtime::clear(self))
    }
}

/// 会话卡的持久化。收发**明文**，加解密与临时文件由宿主负责。
pub trait QrConfigStore: Send + Sync {
    /// 配置文件路径，`getStatus().configFile` 原样返回它。
    fn path(&self) -> String;
    /// 读出已解密的明文；文件不存在、解密失败都给 `None`。
    fn read_plaintext(&self) -> Option<String>;
    /// 落盘（加密、写临时文件、改名都在实现里）。
    fn write_plaintext(&self, text: &str);
    /// 机器名，用于补齐 `computerName`。
    fn hostname(&self) -> String;
}

/// 日志出口（JS 侧只有一处 `console.warn`）。
pub type WarnSink = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

struct State {
    config: Map<String, Value>,
    qr_generation: u64,
    active_qr_token: String,
    confirmed_qr_token: String,
    confirmed_qr_result: Option<Value>,
    qr_pending: bool,
}

/// 扫码登录的会话卡。
pub struct QrLogin<A: QrAuth, S: QrConfigStore> {
    auth: A,
    store: S,
    state: Mutex<State>,
    warn: Option<WarnSink>,
}

impl<A: QrAuth, S: QrConfigStore> QrLogin<A, S> {
    /// JS 构造时是 `{ ...readConfig(file), ...(options.initialConfig || {}) }` —— 读配置就发生
    /// 在构造期，所以"坏配置"那条警告也只可能在这里发出来，`warn` 必须从构造入口传进来。
    pub fn new(auth: A, store: S, initial_config: Option<&Value>, warn: Option<WarnSink>) -> Self {
        let mut login = Self {
            auth,
            store,
            state: Mutex::new(State {
                config: Map::new(),
                qr_generation: 0,
                active_qr_token: String::new(),
                confirmed_qr_token: String::new(),
                confirmed_qr_result: None,
                qr_pending: false,
            }),
            warn,
        };
        let mut config = login.load_config(&login.store.hostname());
        if let Some(Value::Object(overrides)) = initial_config {
            for (key, value) in overrides {
                config.insert(key.clone(), value.clone());
            }
        }
        login.state.get_mut().expect("状态锁").config = config;
        login
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("扫码状态锁")
    }

    fn warn_line(&self, line: &str) {
        if let Some(sink) = &self.warn {
            sink(line);
        }
    }

    // ----- 配置 -----

    fn load_config(&self, hostname: &str) -> Map<String, Value> {
        let mut config = default_config(hostname);
        let Some(raw) = self.store.read_plaintext() else {
            return config;
        };
        let text = raw.trim_start_matches('\u{feff}').trim();
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(parsed)) => {
                for (key, value) in parsed {
                    config.insert(key, value);
                }
            }
            Ok(_) => {
                // `typeof parsed === 'object'` 为假（数字 / 字符串 / null / 数组）时只留默认值。
                // JSON 数组在 JS 里也是 object，但展开成 `{...[]}` 等于什么都没写，结果一致。
            }
            Err(_) => {
                // V8 的解析报错文案没法逐字复刻，这里只说"这条配置被忽略了"。
                self.warn_line("[QishuiQrLogin] ignored invalid config");
            }
        }
        config
    }

    /// `updateConfig(partial)`：合并 → 落盘 → 返回新配置。键序按 `Object.assign` 语义。
    pub fn update_config(&self, partial: &Value) -> Value {
        let merged = {
            let mut state = self.state();
            if let Value::Object(partial) = partial {
                for (key, value) in partial {
                    state.config.insert(key.clone(), value.clone());
                }
            }
            state.config.clone()
        };
        self.store.write_plaintext(
            &serde_json::to_string_pretty(&Value::Object(merged.clone())).unwrap_or_default(),
        );
        Value::Object(merged)
    }

    pub fn config(&self) -> Value {
        Value::Object(self.state().config.clone())
    }

    // ----- 公开能力 -----

    /// 出码。返回上游的原始应答（宿主与页面都要这个原样形状）。
    pub async fn create_qr_code(&self) -> Result<Value, QrLoginError> {
        let generation = {
            let mut state = self.state();
            state.qr_generation += 1;
            state.active_qr_token.clear();
            state.confirmed_qr_token.clear();
            state.confirmed_qr_result = None;
            state.qr_pending = true;
            state.qr_generation
        };

        let result = self
            .auth
            .get_qr_code()
            .await
            .map_err(QrLoginError::from_auth)?;
        let data = data_of(&result);
        // 顺序要紧：先看载荷，再看代次。
        if !js_truthy(data.get("token").unwrap_or(&Value::Null))
            || !js_truthy(data.get("qrcode").unwrap_or(&Value::Null))
        {
            return Err(QrLoginError::coded(ERR_PAYLOAD_INCOMPLETE));
        }
        {
            let mut state = self.state();
            if generation != state.qr_generation {
                return Err(QrLoginError::coded(ERR_REPLACED));
            }
            state.active_qr_token = js_string(data.get("token").unwrap_or(&Value::Null));
        }
        Ok(result)
    }

    /// 轮询。返回 `{ ...上游应答, data: { ...上游 data, confirmed } }`。
    pub async fn check_qr_connect(&self, token: &str) -> Result<Value, QrLoginError> {
        let token = token.trim().to_string();
        if token.is_empty() {
            return Err(QrLoginError::coded(ERR_TOKEN_REQUIRED));
        }
        let (active, confirmed_token, cached, generation) = {
            let state = self.state();
            (
                state.active_qr_token.clone(),
                state.confirmed_qr_token.clone(),
                state.confirmed_qr_result.clone(),
                state.qr_generation,
            )
        };
        // 令牌对不上就是"这张码过期了"，不打上游 —— 页面据此提示用户刷新。
        if token != active {
            return Ok(json!({
                "message": "error",
                "data": { "error_code": 2, "status": "expired", "confirmed": false },
            }));
        }
        // 确认过一次之后，后续轮询直接复用 —— 否则每次都要消耗一次上游令牌。
        if confirmed_token == token {
            if let Some(result) = cached {
                return Ok(result);
            }
        }

        let result = self
            .auth
            .check_qr_connect(&token)
            .await
            .map_err(QrLoginError::from_auth)?;
        let data = data_of(&result);
        // 代次与 cookie 都必须在 `await` **之后**再看：轮询在路上的时候，用户可能
        // 刷新了二维码，或者上游刚把会话 cookie 写进配置。
        let confirmed = {
            let state = self.state();
            let cookie = state.config.get("cookie").cloned().unwrap_or(Value::Null);
            state.qr_generation == generation
                && state.active_qr_token == token
                && error_code_is_zero(&data)
                && (prop_string(&data, "status") == "3"
                    || prop_string(&data, "status") == "confirmed"
                    || js_truthy(data.get("session_cookie").unwrap_or(&Value::Null)))
                && has_login_cookie(&js_string(&cookie))
        };

        // `confirmed` 是塞进 `data` 里，不是放在顶层。
        let mut nested = data.clone();
        nested.insert("confirmed".to_string(), Value::Bool(confirmed));
        let merged = with_data(&result, &nested);
        if confirmed {
            let mut state = self.state();
            if state.qr_generation == generation && state.active_qr_token == token {
                state.confirmed_qr_token = token;
                state.qr_pending = false;
                state.confirmed_qr_result = Some(merged.clone());
            }
        }
        Ok(merged)
    }

    /// `String(config.cookie || '').trim()`。
    pub fn get_cookie(&self) -> String {
        let state = self.state();
        match state.config.get("cookie") {
            Some(value) if js_truthy(value) => js_string(value).trim().to_string(),
            _ => String::new(),
        }
    }

    /// 会话卡状态。字段名与顺序照 JS 的对象字面量，前端直接读这些键。
    pub fn get_status(&self) -> Value {
        let state = self.state();
        let cookie = state.config.get("cookie").cloned().unwrap_or(Value::Null);
        let login_cookie = has_login_cookie(&js_string(&cookie));
        json!({
            "provider": "qishui",
            "loggedIn": !state.qr_pending && login_cookie,
            "cookieReady": login_cookie,
            "qrPending": state.qr_pending,
            "qrConfirmed": !state.active_qr_token.is_empty()
                && state.confirmed_qr_token == state.active_qr_token,
            "deviceId": match state.config.get("deviceId") {
                Some(value) if js_truthy(value) => js_string(value),
                _ => String::new(),
            },
            "msTokenReady": js_truthy(state.config.get("msToken").unwrap_or(&Value::Null)),
            "configFile": self.store.path(),
        })
    }

    /// 退出登录：作废当前二维码、清分区、把 cookie 与 msToken 抹掉（deviceId 留着）。
    pub async fn clear(&self) -> Result<Value, QrLoginError> {
        {
            let mut state = self.state();
            state.qr_generation += 1;
            state.active_qr_token.clear();
            state.confirmed_qr_token.clear();
            state.confirmed_qr_result = None;
            state.qr_pending = false;
        }
        self.auth.clear().await.map_err(QrLoginError::from_auth)?;
        self.update_config(&json!({ "cookie": "", "msToken": "" }));
        Ok(self.get_status())
    }
}

/// `defaultConfig()`：六个键，机器名由宿主给。
fn default_config(hostname: &str) -> Map<String, Value> {
    let mut config = Map::new();
    for key in ["deviceId", "installId", "verifyPortraitId"] {
        config.insert(key.to_string(), Value::String(String::new()));
    }
    config.insert(
        "computerName".to_string(),
        Value::String(if hostname.is_empty() {
            "Windows-PC".to_string()
        } else {
            hostname.to_string()
        }),
    );
    for key in ["cookie", "msToken"] {
        config.insert(key.to_string(), Value::String(String::new()));
    }
    config
}

/// `result && result.data || {}` —— 结果不是对象、或 `data` 是 falsy 时都当空对象。
fn data_of(result: &Value) -> Map<String, Value> {
    match result.get("data") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// `{ ...result, data: { ...data, confirmed } }`。
fn with_data(result: &Value, data: &Map<String, Value>) -> Value {
    let mut out = match result {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    out.insert("data".to_string(), Value::Object(data.clone()));
    Value::Object(out)
}

/// `Number(data.error_code) === 0` —— **缺键是 NaN**，不能当 0。
fn error_code_is_zero(data: &Map<String, Value>) -> bool {
    match data.get("error_code") {
        Some(value) => js_number(value) == 0.0,
        None => false,
    }
}

/// `String(data[key])`，缺键给 `"undefined"`、显式 null 给 `"null"`。
fn prop_string(data: &Map<String, Value>, key: &str) -> String {
    match data.get(key) {
        None => "undefined".to_string(),
        Some(value) => js_string(value),
    }
}

/// `/(?:^|;\s*)(?:sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss)=[^;\s]+/i`
///
/// 字段表必须与 `qishui-api.js` 的 `qishuiCookieHasLogin` 一模一样：少认两个字段，
/// 这边说"没登录"、那边说"已登录"，登录会卡在等确认。
pub fn has_login_cookie(cookie: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|;\s*)(?:sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss)=[^;\s]+",
        )
        .expect("登录 cookie 的正则写错了")
    });
    pattern.is_match(cookie)
}

// ---------- 单测 ----------
//
// 录制覆盖不到的是"当前调用路径不会走到"的分支：上游返回非对象、`error_code` 缺键、
// 配置默认值、落盘格式。行为级证明在 `tests/qishui_qr_login_recorded.rs`。

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, Value)]) -> Map<String, Value> {
        let mut out = Map::new();
        for (key, value) in pairs {
            out.insert((*key).to_string(), value.clone());
        }
        out
    }

    #[test]
    fn error_code_zero_needs_the_key_to_exist() {
        // 缺键是 `Number(undefined)` = NaN —— 不能当 0，否则"上游没给码"会被误判成成功。
        assert!(!error_code_is_zero(&map(&[])));
        assert!(error_code_is_zero(&map(&[("error_code", json!(0))])));
        assert!(error_code_is_zero(&map(&[("error_code", json!("0"))])));
        assert!(error_code_is_zero(&map(&[("error_code", json!(""))])));
        assert!(error_code_is_zero(&map(&[("error_code", Value::Null)])));
        assert!(!error_code_is_zero(&map(&[("error_code", json!(2))])));
        assert!(!error_code_is_zero(&map(&[("error_code", json!("abc"))])));
        // `Number([])` 是 `Number('')` = 0；`Number([1])` 是 `Number('1')` = 1。
        assert!(error_code_is_zero(&map(&[("error_code", json!([]))])));
        assert!(!error_code_is_zero(&map(&[("error_code", json!([1]))])));
    }

    #[test]
    fn data_of_treats_non_objects_as_empty() {
        assert!(data_of(&Value::Null).is_empty());
        assert!(data_of(&json!("text")).is_empty());
        assert!(data_of(&json!({ "data": null })).is_empty());
        assert!(data_of(&json!({ "data": [] })).is_empty());
        assert_eq!(data_of(&json!({ "data": { "a": 1 } }))["a"], json!(1));
    }

    #[test]
    fn with_data_keeps_envelope_and_replaces_data() {
        let merged = with_data(
            &json!({ "message": "success", "data": { "old": 1 } }),
            &map(&[("a", json!(2))]),
        );
        assert_eq!(merged["message"], json!("success"));
        assert_eq!(merged["data"], json!({ "a": 2 }));
        // 上游返回非对象时只有 `data` 一个键（`{...'text'}` 展开成空对象）。
        let merged = with_data(&json!("text"), &map(&[]));
        assert_eq!(merged, json!({ "data": {} }));
    }

    #[test]
    fn prop_string_distinguishes_missing_from_null() {
        let data = map(&[("status", Value::Null), ("n", json!(3))]);
        assert_eq!(prop_string(&data, "status"), "null");
        assert_eq!(prop_string(&data, "n"), "3");
        assert_eq!(prop_string(&data, "missing"), "undefined");
    }

    #[test]
    fn default_config_keeps_js_key_order_and_falls_back() {
        let config = default_config("PC-1");
        let keys: Vec<&str> = config.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "deviceId",
                "installId",
                "verifyPortraitId",
                "computerName",
                "cookie",
                "msToken"
            ]
        );
        assert_eq!(config["computerName"], json!("PC-1"));
        // `os.hostname() || 'Windows-PC'`
        assert_eq!(default_config("")["computerName"], json!("Windows-PC"));
    }

    #[test]
    fn update_config_writes_two_space_json() {
        struct Store(Mutex<Option<String>>);
        impl QrConfigStore for Store {
            fn path(&self) -> String {
                "cfg.json".to_string()
            }
            fn read_plaintext(&self) -> Option<String> {
                self.0.lock().unwrap().clone()
            }
            fn write_plaintext(&self, text: &str) {
                *self.0.lock().unwrap() = Some(text.to_string());
            }
            fn hostname(&self) -> String {
                "PC".to_string()
            }
        }
        struct NoAuth;
        impl QrAuth for NoAuth {
            fn get_qr_code(&self) -> BoxFuture<'_, Result<Value, AuthError>> {
                Box::pin(async { Err(AuthError::new("unused")) })
            }
            fn check_qr_connect<'a>(
                &'a self,
                _token: &'a str,
            ) -> BoxFuture<'a, Result<Value, AuthError>> {
                Box::pin(async { Err(AuthError::new("unused")) })
            }
            fn clear(&self) -> BoxFuture<'_, Result<(), AuthError>> {
                Box::pin(async { Ok(()) })
            }
        }

        let store = Store(Mutex::new(None));
        let login = QrLogin::new(NoAuth, store, None, None);
        login.update_config(&json!({ "cookie": "c=1" }));
        let written = login.store.read_plaintext().expect("应当落盘");
        assert!(
            written.starts_with("{\n  \"deviceId\": \"\","),
            "实际 {written}"
        );
        assert!(written.contains("\"cookie\": \"c=1\""), "实际 {written}");
        assert!(!written.ends_with('\n'), "JSON.stringify 不带行尾换行");
    }
}
