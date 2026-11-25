//! `qishui_qr_login` 的行为回放。
//!
//! 用例由 `scripts/record-qishui-qr-login.js` 从真实的 JS 实现录出来：
//!
//! 重录：`node scripts/record-qishui-qr-login.js --write`
//! 检查同步：`npm run qishuiqr:check`
//!
//! 录制器只替换了三样东西：`auth`（构造参数本来就注入）、配置文件路径（固定成
//! `ztest/qishui-qr-config.json`）、`os.hostname`（钉成 `RECORDER-PC`）。
//! 其余（默认值补齐、BOM 剥离、坏配置回落、合并语义、落盘格式）全是真代码在跑。

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};

use mineradio_core::qishui_auth::AuthError;
use mineradio_core::qishui_qr_login::{has_login_cookie, QrAuth, QrConfigStore, QrLogin};
use serde_json::{json, Value};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;
type Hook = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

// ---------- 桩：上游 ----------

struct AuthInner {
    /// 按调用名分组的应答。**不能用一个全局游标**：轮询期间刷新二维码那条用例里，
    /// 嵌套的 `getQrCode` 会在 `checkQrConnect` 之后才被请求，单游标会拿错条目。
    script: std::collections::HashMap<String, Vec<Value>>,
    cursors: Mutex<std::collections::HashMap<String, usize>>,
    calls: Mutex<Vec<String>>,
    on_get: Mutex<Option<Hook>>,
    on_check: Mutex<Option<Hook>>,
    nested_fired: Mutex<bool>,
}

#[derive(Clone)]
struct MockAuth {
    inner: Arc<AuthInner>,
}

impl MockAuth {
    fn new(script: Vec<(String, Value)>) -> Self {
        let mut grouped: std::collections::HashMap<String, Vec<Value>> =
            std::collections::HashMap::new();
        for (name, value) in script {
            grouped.entry(name).or_default().push(value);
        }
        Self {
            inner: Arc::new(AuthInner {
                script: grouped,
                cursors: Mutex::new(std::collections::HashMap::new()),
                calls: Mutex::new(Vec::new()),
                on_get: Mutex::new(None),
                on_check: Mutex::new(None),
                nested_fired: Mutex::new(false),
            }),
        }
    }

    fn set_get_hook(&self, hook: Hook) {
        *self.inner.on_get.lock().expect("钩子锁") = Some(hook);
    }

    fn set_check_hook(&self, hook: Hook) {
        *self.inner.on_check.lock().expect("钩子锁") = Some(hook);
    }

    fn calls(&self) -> Vec<String> {
        self.inner.calls.lock().expect("调用锁").clone()
    }

    fn take(&self, name: &str) -> Value {
        let mut cursors = self.inner.cursors.lock().expect("脚本游标");
        let index = {
            let slot = cursors.entry(name.to_string()).or_insert(0);
            let index = *slot;
            *slot += 1;
            index
        };
        self.inner
            .script
            .get(name)
            .and_then(|list| list.get(index))
            .cloned()
            .unwrap_or_else(|| panic!("脚本里没有 {name} 的第 {} 个应答", index + 1))
    }
}

/// 打断点只跑一次：录制器里的嵌套调用也只触发一次。
fn fire_once(inner: &AuthInner, slot: &Mutex<Option<Hook>>) {
    let mut fired = inner.nested_fired.lock().expect("嵌套标记");
    if *fired {
        return;
    }
    let hook = slot.lock().expect("钩子锁").clone();
    if hook.is_none() {
        return;
    }
    *fired = true;
    drop(fired);
    if let Some(hook) = hook {
        drive_to_ready(hook());
    }
}

/// 桩里的钩子要"在 await 期间把另一个 async 调用跑完"。桩的每个应答都是就绪的，
/// 所以直接用空 waker 把 future 轮询到 Ready 即可，不需要真正的执行器。
fn drive_to_ready<F: Future<Output = ()>>(future: F) {
    let mut future = Box::pin(future);
    let waker = std::task::Waker::noop();
    let mut context = std::task::Context::from_waker(waker);
    for _ in 0..10_000 {
        if future.as_mut().poll(&mut context).is_ready() {
            return;
        }
    }
    panic!("嵌套调用一直没有完成");
}

impl QrAuth for MockAuth {
    fn get_qr_code(&self) -> BoxFuture<'_, Result<Value, AuthError>> {
        self.inner
            .calls
            .lock()
            .expect("调用锁")
            .push("getQrCode".to_string());
        fire_once(&self.inner, &self.inner.on_get);
        let value = self.take("getQrCode");
        Box::pin(async move { Ok(value) })
    }

    fn check_qr_connect<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<Value, AuthError>> {
        self.inner
            .calls
            .lock()
            .expect("调用锁")
            .push(format!("checkQrConnect:{token}"));
        fire_once(&self.inner, &self.inner.on_check);
        let value = self.take("checkQrConnect");
        Box::pin(async move { Ok(value) })
    }

    fn clear(&self) -> BoxFuture<'_, Result<(), AuthError>> {
        self.inner
            .calls
            .lock()
            .expect("调用锁")
            .push("clear".to_string());
        let _ = self.take("clear");
        Box::pin(async { Ok(()) })
    }
}

// ---------- 桩：配置文件 ----------

#[derive(Clone)]
struct MockStore {
    file: Arc<Mutex<Option<String>>>,
}

impl MockStore {
    fn new(initial: Option<&str>) -> Self {
        Self {
            file: Arc::new(Mutex::new(initial.map(str::to_string))),
        }
    }

    fn parsed(&self) -> Option<Value> {
        let text = self.file.lock().expect("配置锁").clone()?;
        serde_json::from_str(&text).ok()
    }
}

impl QrConfigStore for MockStore {
    fn path(&self) -> String {
        // 录制时用的就是这个相对路径，`getStatus().configFile` 会原样带出来。
        "ztest/qishui-qr-config.json".to_string()
    }

    fn read_plaintext(&self) -> Option<String> {
        self.file.lock().expect("配置锁").clone()
    }

    fn write_plaintext(&self, text: &str) {
        *self.file.lock().expect("配置锁") = Some(text.to_string());
    }

    fn hostname(&self) -> String {
        "RECORDER-PC".to_string()
    }
}

// ---------- 回放 ----------

fn cases() -> Vec<Value> {
    let raw = include_str!("fixtures/qishui-qr-login-cases.jsonl");
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture 行不是合法 JSON"))
        .collect()
}

fn script_of(case: &Value) -> Vec<(String, Value)> {
    case["authReturned"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    (
                        item["call"].as_str().unwrap_or_default().to_string(),
                        item["value"].clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 一条用例跑完的观察结果。
struct Report {
    result: Option<Value>,
    err: Option<Value>,
    calls: Vec<String>,
    warnings: Vec<String>,
    /// 跑完之后配置文件里的内容（没有文件就是 `null`）。
    file: Value,
}

async fn dispatch(case: &Value, login: &Arc<QrLogin<MockAuth, MockStore>>) -> Result<Value, Value> {
    let fail =
        |code: &str| -> Result<Value, Value> { Err(json!({ "code": code, "message": code })) };
    match case["fn"].as_str().unwrap_or_default() {
        "createQrCode" => login
            .create_qr_code()
            .await
            .map_err(|e| json!({ "code": e.code, "message": e.message })),
        "createQrCodeThenStatus" => {
            login
                .create_qr_code()
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            Ok(login.get_status())
        }
        "createQrCodeWithCookie" => {
            login
                .create_qr_code()
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            Ok(login.get_status())
        }
        "createQrCodeThenCheck" => {
            let qr = login
                .create_qr_code()
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            let token = qr["data"]["token"].as_str().unwrap_or_default().to_string();
            let first = login
                .check_qr_connect(&token)
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            Ok(json!({
                "qr": qr,
                "first": first,
                "status": login.get_status(),
                "cookie": login.get_cookie(),
            }))
        }
        "checkQrConnect" => {
            let token = case["args"][0].as_str().unwrap_or_default();
            login
                .check_qr_connect(token)
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))
        }
        "checkPaddedToken" => {
            let qr = login
                .create_qr_code()
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            let token = qr["data"]["token"].as_str().unwrap_or_default();
            let polled = login
                .check_qr_connect(&format!("  {token}  "))
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            Ok(json!({ "polled": polled, "status": login.get_status() }))
        }
        "checkTwice" => {
            let qr = login
                .create_qr_code()
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            let token = qr["data"]["token"].as_str().unwrap_or_default().to_string();
            let first = login
                .check_qr_connect(&token)
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            let second = login
                .check_qr_connect(&token)
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            Ok(json!({ "first": first, "second": second, "status": login.get_status() }))
        }
        "checkAfterRefresh" | "checkAfterClear" => {
            let qr = login
                .create_qr_code()
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            let token = qr["data"]["token"].as_str().unwrap_or_default().to_string();
            let polled = login
                .check_qr_connect(&token)
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            Ok(json!({ "polled": polled, "status": login.get_status() }))
        }
        "getStatus" => Ok(login.get_status()),
        "getCookie" => Ok(Value::String(login.get_cookie())),
        "clear" => {
            let status = login
                .clear()
                .await
                .map_err(|e| json!({ "code": e.code, "message": e.message }))?;
            Ok(json!({ "status": status, "cookie": login.get_cookie() }))
        }
        "updateConfig" => {
            let config = login.update_config(&case["args"][0]);
            Ok(json!({ "config": config, "status": login.get_status() }))
        }
        "configFileBroken"
        | "configFileExtraKeys"
        | "configFileBlank"
        | "configFileBom"
        | "initialConfigOverridesFile" => Ok(json!({
            "status": login.get_status(),
            "config": login.config(),
        })),
        other => fail(other),
    }
}

async fn run_case(case: &Value) -> Report {
    let notes = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = {
        let notes = Arc::clone(&notes);
        Arc::new(move |line: &str| notes.lock().expect("日志锁").push(line.to_string()))
    };

    let auth = MockAuth::new(script_of(case));
    let store = MockStore::new(case.get("setupFile").and_then(Value::as_str));
    let initial = case.get("initialConfig").filter(|value| value.is_object());
    let login = Arc::new(QrLogin::new(
        auth.clone(),
        store.clone(),
        initial,
        Some(sink),
    ));

    match case.get("scenario").and_then(Value::as_str).unwrap_or("") {
        "reenterCreateOnGetQrCode" => {
            let weak: Weak<QrLogin<MockAuth, MockStore>> = Arc::downgrade(&login);
            auth.set_get_hook(Arc::new(move || {
                let weak = weak.clone();
                Box::pin(async move {
                    if let Some(login) = weak.upgrade() {
                        let _ = login.create_qr_code().await;
                    }
                })
            }));
        }
        "reenterCreateOnCheck" => {
            let weak: Weak<QrLogin<MockAuth, MockStore>> = Arc::downgrade(&login);
            auth.set_check_hook(Arc::new(move || {
                let weak = weak.clone();
                Box::pin(async move {
                    if let Some(login) = weak.upgrade() {
                        let _ = login.create_qr_code().await;
                    }
                })
            }));
        }
        "clearOnCheck" => {
            let weak: Weak<QrLogin<MockAuth, MockStore>> = Arc::downgrade(&login);
            auth.set_check_hook(Arc::new(move || {
                let weak = weak.clone();
                Box::pin(async move {
                    if let Some(login) = weak.upgrade() {
                        let _ = login.clear().await;
                    }
                })
            }));
        }
        _ => {}
    }

    let outcome = dispatch(case, &login).await;
    let (result, err) = match outcome {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    let warnings = notes.lock().expect("日志锁").clone();
    let file = store.parsed().unwrap_or(Value::Null);
    Report {
        result,
        err,
        calls: auth.calls(),
        warnings,
        file,
    }
}

/// 数字按容差比，其余按键/长度严格比。键顺序不参与比较（`Value` 的相等本来就是无序的）。
fn diff_json(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Number(left), Value::Number(right)) => {
            let (left, right) = (
                left.as_f64().unwrap_or(f64::NAN),
                right.as_f64().unwrap_or(f64::NAN),
            );
            let tolerance = 1e-9 * left.abs().max(1.0);
            if (left - right).abs() > tolerance {
                out.push(format!("{path}: 期望 {left}，实际 {right}"));
            }
        }
        (Value::Object(left), Value::Object(right)) => {
            for (key, value) in left {
                match right.get(key) {
                    Some(other) => diff_json(&format!("{path}.{key}"), value, other, out),
                    None => out.push(format!("{path}.{key}: 实际缺这个键")),
                }
            }
            for key in right.keys() {
                if !left.contains_key(key) {
                    out.push(format!("{path}.{key}: 期望里没有这个键"));
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                out.push(format!("{path}: 长度 {} vs {}", left.len(), right.len()));
            }
            for (index, (item, other)) in left.iter().zip(right.iter()).enumerate() {
                diff_json(&format!("{path}[{index}]"), item, other, out);
            }
        }
        _ => {
            if expected != actual {
                out.push(format!("{path}: 期望 {expected}，实际 {actual}"));
            }
        }
    }
}

#[tokio::test]
async fn replays_recorded_session_behaviour() {
    let all = cases();
    assert!(!all.is_empty(), "fixture 是空的");
    let mut failures = Vec::new();

    for (index, case) in all.iter().enumerate() {
        let label = format!(
            "第 {} 条 {}（{}）",
            index + 1,
            case["fn"].as_str().unwrap_or("?"),
            case["note"].as_str().unwrap_or("")
        );

        // hasLoginCookie 是纯函数，单独一组。
        if case["fn"] == "hasLoginCookie" {
            for probe in case["probes"].as_array().cloned().unwrap_or_default() {
                let input = probe["input"].as_str().unwrap_or_default();
                let expected = probe["result"].as_bool().unwrap_or(false);
                if has_login_cookie(input) != expected {
                    failures.push(format!(
                        "{label}\n  {input:?}: 期望 {expected}，实际 {}",
                        has_login_cookie(input)
                    ));
                }
            }
            continue;
        }

        let report = run_case(case).await;

        let expected_result = case.get("result").cloned().unwrap_or(Value::Null);
        let expected_err = case.get("err").cloned();
        match (&expected_err, report.err.clone()) {
            (Some(expected), Some(actual)) => {
                let mut diffs = Vec::new();
                diff_json("err", expected, &actual, &mut diffs);
                if !diffs.is_empty() {
                    failures.push(format!("{label}\n  {}", diffs.join("\n  ")));
                }
            }
            (Some(expected), None) => failures.push(format!(
                "{label}\n  期望抛 {}，实际返回 {}",
                expected["code"],
                report
                    .result
                    .as_ref()
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            )),
            (None, Some(actual)) => failures.push(format!(
                "{label}\n  期望返回，实际抛 {}（{}）",
                actual["code"], actual["message"]
            )),
            (None, None) => {
                let actual = report.result.clone().unwrap_or(Value::Null);
                let mut diffs = Vec::new();
                diff_json("result", &expected_result, &actual, &mut diffs);
                if !diffs.is_empty() {
                    failures.push(format!("{label}\n  {}", diffs.join("\n  ")));
                }
            }
        }

        // 上游调用序列（顺序有意义：缓存命中就不该再有第二次调用）。
        let expected_calls: Vec<String> = case["authCalls"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default();
        if expected_calls != report.calls {
            failures.push(format!(
                "{label}\n  调用序列不符\n  期望 {expected_calls:?}\n  实际 {:?}",
                report.calls
            ));
        }

        // 落盘内容。
        let expected_file = case.get("fileAfter").cloned().unwrap_or(Value::Null);
        let key = case["fn"].as_str().unwrap_or_default();
        // 这几种用例只看读到的配置，不看文件（录制器读文件失败时记的就是 null）。
        let check_file = !matches!(
            key,
            "hasLoginCookie"
                | "getStatus"
                | "getCookie"
                | "checkQrConnect"
                | "createQrCodeThenStatus"
                | "createQrCodeWithCookie"
        );
        if check_file {
            let actual_file = report.file.clone();
            let mut diffs = Vec::new();
            diff_json("fileAfter", &expected_file, &actual_file, &mut diffs);
            if !diffs.is_empty() {
                failures.push(format!("{label}\n  {}", diffs.join("\n  ")));
            }
        }

        let expected_warnings: Vec<String> = case["warnings"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default();
        if expected_warnings != report.warnings {
            failures.push(format!(
                "{label}\n  日志不符\n  期望 {expected_warnings:?}\n  实际 {:?}",
                report.warnings
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} / {} 条不一致：\n{}",
        failures.len(),
        all.len(),
        failures.join("\n\n")
    );
}
