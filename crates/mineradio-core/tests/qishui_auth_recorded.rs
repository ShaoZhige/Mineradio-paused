//! 回放 `scripts/record-qishui-auth.js` 录下的登录编排行为。
//!
//! 模块本体只能在 Electron 里跑（要窗口、要分区、要页面里的 `bdms`），所以录制器
//! 把窗口与页面换成了桩，让真正的业务代码跑在上面。每条用例录下：
//!
//! * `ok` / `err` —— 输出或错误，逐字段比对；
//! * `requests` —— 发出的每个请求（method / url / headers 顺序 / body 原文 / timeout）；
//! * `responses` —— 宿主按序给出的应答，**队列**语义（这个模块的请求严格串行）；
//! * `signs` —— 页面给每次请求追加的 `a_bogus` / `msToken`，用来还原"最后一次
//!   passport 请求"这条签名证据；
//! * `randoms` —— **核逻辑**消费掉的随机流（`bytes(18)` 资产令牌与 `bytes(88)`
//!   msToken 归宿主所有，已从流水账里剔除）；
//! * `host` —— 宿主在初始化时交回的两样东西（`msToken` / `browserInfo.encrypted`）；
//! * `patches` —— `updateConfig` 的调用序列（身份补齐 → msToken → cookie）；
//! * `verifyCalls` / `qrCalls` —— 二次验证与二维码绘制的入参；
//! * `notes` —— `console.log` 的每一行。
//!
//! 重录：`node scripts/record-qishui-auth.js --write`
//! 检查同步：`npm run qishuiauth:check`

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use mineradio_core::qishui_auth::{
    AuthError, AuthHost, AuthRequest, AuthResponse, InitState, JarCookie, QrStyle, Rng, Runtime,
};
use serde_json::{json, Map, Value};

// ---------- 随机流回放 ----------

#[derive(Clone)]
struct ReplayRng {
    records: Arc<Vec<Value>>,
    cursor: Arc<Mutex<usize>>,
}

impl ReplayRng {
    fn new(records: &Value) -> Self {
        Self {
            records: Arc::new(records.as_array().cloned().unwrap_or_default()),
            cursor: Arc::new(Mutex::new(0)),
        }
    }

    fn next(&self, kind: &str, description: &str) -> Value {
        let mut cursor = self.cursor.lock().expect("随机流游标");
        let index = *cursor;
        let record = self
            .records
            .get(index)
            .cloned()
            .unwrap_or_else(|| panic!("随机流在第 {index} 条就空了（要 {description}）"));
        assert_eq!(
            record["kind"].as_str().unwrap_or(""),
            kind,
            "随机流第 {index} 条类型不符（要 {description}）：{record}"
        );
        *cursor += 1;
        record
    }

    fn remaining(&self) -> usize {
        self.records.len() - *self.cursor.lock().expect("随机流游标")
    }
}

impl Rng for ReplayRng {
    fn int(&self, min: u64, max: u64) -> u64 {
        let record = self.next("int", &format!("int({min}, {max})"));
        assert_eq!(
            record["min"].as_u64(),
            Some(min),
            "randomInt 下界不符：{record}"
        );
        assert_eq!(
            record["max"].as_u64(),
            Some(max),
            "randomInt 上界不符：{record}"
        );
        record["value"].as_u64().expect("随机整数")
    }

    fn bytes(&self, size: usize) -> Vec<u8> {
        let record = self.next("bytes", &format!("bytes({size})"));
        assert_eq!(
            record["size"].as_u64(),
            Some(size as u64),
            "字节数不符：{record}"
        );
        let hex = record["hex"].as_str().expect("随机字节");
        (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("十六进制"))
            .collect()
    }

    fn uuid(&self) -> String {
        let record = self.next("uuid", "uuid()");
        record["value"].as_str().expect("随机 uuid").to_string()
    }
}

// ---------- 宿主桩 ----------

struct MockInner {
    config: Mutex<Value>,
    patches: Mutex<Vec<Value>>,
    requests: Mutex<Vec<AuthRequest>>,
    inits: Vec<Value>,
    init_cursor: Mutex<usize>,
    signed: Mutex<String>,
    signs: Vec<Value>,
    responses: Vec<Value>,
    jar: Vec<JarCookie>,
    verify_results: Vec<Value>,
    verify_cursor: Mutex<usize>,
    verify_calls: Mutex<Vec<Value>>,
    qr_calls: Mutex<Vec<Value>>,
    cleared: Mutex<usize>,
    notes: Arc<Mutex<Vec<String>>>,
}

#[derive(Clone)]
struct MockHost {
    inner: Arc<MockInner>,
}

impl MockHost {
    fn new(case: &Value, notes: Arc<Mutex<Vec<String>>>) -> Self {
        let config = case.get("config").cloned().unwrap_or_else(|| json!({}));
        let jar = case
            .get("jar")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| JarCookie {
                        name: text(&item["name"]),
                        value: text(&item["value"]),
                        domain: text(&item["domain"]),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let verify_results = case
            .get("verifyCalls")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|item| item["result"].clone()).collect())
            .unwrap_or_default();
        Self {
            inner: Arc::new(MockInner {
                config: Mutex::new(config),
                patches: Mutex::new(Vec::new()),
                requests: Mutex::new(Vec::new()),
                inits: case
                    .get("inits")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                init_cursor: Mutex::new(0),
                signed: Mutex::new(String::new()),
                signs: case
                    .get("signs")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                responses: case
                    .get("responses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                jar,
                verify_results,
                verify_cursor: Mutex::new(0),
                verify_calls: Mutex::new(Vec::new()),
                qr_calls: Mutex::new(Vec::new()),
                cleared: Mutex::new(0),
                notes,
            }),
        }
    }
}

impl AuthHost for MockHost {
    fn config(&self) -> Value {
        self.inner.config.lock().expect("配置锁").clone()
    }

    fn hostname(&self) -> String {
        // 录制时把 `os.hostname` 固定成了 RECORDER-PC（否则换台机器录出来就不一样）。
        "RECORDER-PC".to_string()
    }

    fn patch_config(&self, patch: &Map<String, Value>) {
        self.inner
            .patches
            .lock()
            .expect("补丁锁")
            .push(Value::Object(patch.clone()));
        let mut config = self.inner.config.lock().expect("配置锁");
        if let Value::Object(map) = &mut *config {
            for (key, value) in patch {
                map.insert(key.clone(), value.clone());
            }
        }
    }

    async fn initialize(&self) -> Result<InitState, AuthError> {
        let index = {
            let mut cursor = self.inner.init_cursor.lock().expect("初始化游标");
            let index = *cursor;
            *cursor += 1;
            index
        };
        // 真实流程里开窗这一步会留下一条日志（窗口标题），录制器把它记进了 notes。
        self.inner
            .notes
            .lock()
            .expect("日志锁")
            .push("window:create:汽水音乐安全验证".to_string());
        let init = self
            .inner
            .inits
            .get(index)
            .cloned()
            .unwrap_or_else(|| panic!("第 {} 次初始化没有录好的交付物", index + 1));
        // JS 的 `_initialize` 收尾就是 `updateConfig({msToken})`，这里照样补一刀 ——
        // 补丁序列要和录制一致。
        let mut patch = Map::new();
        patch.insert("msToken".to_string(), Value::String(text(&init["msToken"])));
        self.patch_config(&patch);
        Ok(InitState {
            ms_token: text(&init["msToken"]),
            browser_encrypted: text(&init["browserEncrypted"]),
        })
    }

    async fn request(&self, request: &AuthRequest) -> Result<AuthResponse, AuthError> {
        let index = {
            let mut requests = self.inner.requests.lock().expect("请求锁");
            requests.push(request.clone());
            requests.len() - 1
        };
        // 页面（真实流程里是 bdms）会把 a_bogus / msToken 贴到查询串末尾。
        // 录制里存着这两次注入的值，照抄一遍，让签名校验跑在真数据上。
        if let Some(sign) = self.inner.signs.get(index) {
            let signed = signed_url(
                &request.url,
                &text(&sign["a_bogus"]),
                &text(&sign["msToken"]),
            );
            *self.inner.signed.lock().expect("签名锁") = signed;
        }
        let answer = self
            .inner
            .responses
            .get(index)
            .cloned()
            .unwrap_or_else(|| panic!("第 {} 个请求没有录好的应答", index + 1));
        Ok(AuthResponse {
            status: answer["status"].as_u64().map(|value| value as u16),
            body: text(&answer["body"]),
        })
    }

    fn last_passport_url(&self) -> String {
        self.inner.signed.lock().expect("签名锁").clone()
    }

    async fn second_verify(&self, decision: &Value, general: &Value) -> Result<Value, AuthError> {
        let index = {
            let mut cursor = self.inner.verify_cursor.lock().expect("验证游标");
            let index = *cursor;
            *cursor += 1;
            index
        };
        self.inner
            .verify_calls
            .lock()
            .expect("验证调用锁")
            .push(json!({ "decision": decision, "general": general }));
        Ok(self
            .inner
            .verify_results
            .get(index)
            .cloned()
            .unwrap_or(Value::Null))
    }

    async fn jar_cookies(&self) -> Result<Vec<JarCookie>, AuthError> {
        Ok(self.inner.jar.clone())
    }

    async fn clear_storage(&self) -> Result<(), AuthError> {
        *self.inner.cleared.lock().expect("清理计数") += 1;
        Ok(())
    }

    async fn render_qr(&self, text_value: &str, style: &QrStyle) -> Result<String, AuthError> {
        self.inner.qr_calls.lock().expect("二维码锁").push(json!({
            "text": text_value,
            "options": {
                "errorCorrectionLevel": style.error_correction_level,
                "margin": style.margin,
                "width": style.width,
                "color": { "dark": style.dark, "light": style.light },
            },
        }));
        // 录制器的 qrcode 桩就是这么造 data URL 的：把内容 base64 进去，
        // 后面缀上参数摘要。真图不参与比对（见模块头的偏差 3）。
        let encoded = base64::engine::general_purpose::STANDARD.encode(text_value);
        Ok(format!(
            "data:image/png;base64,{encoded}#w={},m={},e={},d={},l={}",
            style.width, style.margin, style.error_correction_level, style.dark, style.light
        ))
    }
}

/// 页面注入签名的样子：**set 语义**（同名参数换值保位置），不是往后追加。
/// 追加的话原来那个 `msToken=` 还在，`searchParams.get` 拿到的永远是旧的，
/// 「msToken 与运行时不一致」那条用例就永远绿了。
fn signed_url(base: &str, a_bogus: &str, ms_token: &str) -> String {
    let mut url = url::Url::parse(base).expect("请求地址必须能解析");
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    for (name, value) in [("a_bogus", a_bogus), ("msToken", ms_token)] {
        match pairs.iter_mut().find(|(key, _)| key == name) {
            Some(slot) => slot.1 = value.to_string(),
            None => pairs.push((name.to_string(), value.to_string())),
        }
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in &pairs {
        serializer.append_pair(key, value);
    }
    url.set_query(Some(&serializer.finish()));
    url.to_string()
}

fn text(value: &Value) -> String {
    match value {
        Value::String(item) => item.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

// ---------- 比对 ----------

fn request_to_json(request: &AuthRequest) -> Value {
    json!({
        "method": request.method,
        "url": request.url,
        "headers": request
            .headers
            .iter()
            .map(|(name, value)| json!([name, value]))
            .collect::<Vec<_>>(),
        "body": request.body,
        "timeout": request.timeout_ms,
    })
}

fn error_to_json(error: &AuthError) -> Value {
    json!({ "code": error.code, "message": error.message })
}

fn cases() -> Vec<Value> {
    include_str!("fixtures/qishui-auth-cases.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture 每行都是 JSON"))
        .collect()
}

async fn run_case(
    case: &Value,
) -> (
    Result<Value, AuthError>,
    Arc<MockInner>,
    Arc<Mutex<Vec<String>>>,
) {
    let rng = ReplayRng::new(&case["randoms"]);
    let notes = Arc::new(Mutex::new(Vec::<String>::new()));
    let host = MockHost::new(case, Arc::clone(&notes));
    let probe = host.clone();
    let notes_sink = Arc::clone(&notes);
    let runtime = Runtime::new(host, rng).with_log(Arc::new(move |line: &str| {
        notes_sink.lock().expect("日志锁").push(line.to_string());
    }));

    let outcome = match case["fn"].as_str().unwrap_or("") {
        "getQrCode" => runtime.get_qr_code().await,
        "checkQrConnect" => {
            let token = case["args"][0].as_str().unwrap_or("").to_string();
            runtime.check_qr_connect(&token).await
        }
        "clear" => match runtime.get_qr_code().await {
            Ok(_) => runtime.clear().await.map(|_| Value::Null),
            Err(error) => Err(error),
        },
        "getQrCodeAfterClear" => match runtime.get_qr_code().await {
            Ok(_) => match runtime.clear().await {
                Ok(()) => runtime.get_qr_code().await,
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        },
        other => panic!("fixture 里有未知的用例：{other}"),
    };
    (outcome, probe.inner.clone(), notes)
}

#[tokio::test]
async fn replays_recorded_login_behaviour() {
    let all = cases();
    assert!(!all.is_empty(), "fixture 是空的");
    let mut failures = Vec::new();

    for (index, case) in all.iter().enumerate() {
        let label = format!(
            "第 {} 条 {}/{:?}（{}）",
            index + 1,
            case["fn"].as_str().unwrap_or("?"),
            case["args"],
            case["note"].as_str().unwrap_or("")
        );

        let (outcome, inner, notes) = run_case(case).await;

        // 输出 / 错误
        match (&case.get("err"), outcome) {
            (Some(expected), Err(actual)) => {
                let expected = json!({
                    "code": expected["code"].clone(),
                    "message": expected["message"].clone(),
                });
                let actual = error_to_json(&actual);
                if expected != actual {
                    failures.push(format!(
                        "{label}\n  错误不符\n  期望 {expected}\n  实际 {actual}"
                    ));
                }
            }
            (Some(expected), Ok(actual)) => failures.push(format!(
                "{label}\n  期望抛错 {:?}，实际返回 {actual}",
                expected["message"]
            )),
            (None, Err(actual)) => failures.push(format!(
                "{label}\n  期望返回 {}，实际抛错 {}",
                case["ok"], actual
            )),
            (None, Ok(actual)) => {
                if case["ok"] != actual {
                    failures.push(format!(
                        "{label}\n  输出不符\n  期望 {}\n  实际 {actual}",
                        case["ok"]
                    ));
                }
            }
        }

        // 请求形状
        let actual_requests: Vec<Value> = inner
            .requests
            .lock()
            .expect("请求锁")
            .iter()
            .map(request_to_json)
            .collect();
        let expected_requests = case["requests"].as_array().cloned().unwrap_or_default();
        if expected_requests != actual_requests {
            failures.push(format!(
                "{label}\n  请求不符\n  期望 {}\n  实际 {}",
                expected_requests
                    .iter()
                    .map(|item| item.to_string())
                    .collect::<Vec<_>>()
                    .join(" / "),
                actual_requests
                    .iter()
                    .map(|item| item.to_string())
                    .collect::<Vec<_>>()
                    .join(" / ")
            ));
        }

        // 配置补丁
        let actual_patches = inner.patches.lock().expect("补丁锁").clone();
        let expected_patches = case["patches"].as_array().cloned().unwrap_or_default();
        if expected_patches != actual_patches {
            failures.push(format!(
                "{label}\n  补丁不符\n  期望 {expected_patches:?}\n  实际 {actual_patches:?}"
            ));
        }

        // 二次验证入参（只比入参：返回值是宿主的输入，不是核的输出）
        let actual_verify = inner.verify_calls.lock().expect("验证锁").clone();
        let expected_verify: Vec<Value> = case
            .get("verifyCalls")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| json!({ "decision": item["decision"], "general": item["general"] }))
                    .collect()
            })
            .unwrap_or_default();
        if expected_verify != actual_verify {
            failures.push(format!(
                "{label}\n  二次验证入参不符\n  期望 {expected_verify:?}\n  实际 {actual_verify:?}"
            ));
        }

        // 二维码绘制入参
        let actual_qr = inner.qr_calls.lock().expect("二维码锁").clone();
        let expected_qr = case
            .get("qrCalls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if expected_qr != actual_qr {
            failures.push(format!(
                "{label}\n  二维码入参不符\n  期望 {expected_qr:?}\n  实际 {actual_qr:?}"
            ));
        }

        // 分区清理次数（JS 侧是 clearStorageData + flushStorageData 两条记录）
        let expected_clears = case
            .get("storage")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item["op"].as_str() == Some("clear"))
                    .count()
            })
            .unwrap_or(0);
        let actual_clears = *inner.cleared.lock().expect("清理计数");
        if expected_clears != actual_clears {
            failures.push(format!(
                "{label}\n  分区清理次数不符：期望 {expected_clears}，实际 {actual_clears}"
            ));
        }

        // 日志
        let actual_notes = notes.lock().expect("日志锁").clone();
        let expected_notes: Vec<String> = case
            .get("notes")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(text).collect())
            .unwrap_or_default();
        if expected_notes != actual_notes {
            failures.push(format!(
                "{label}\n  日志不符\n  期望 {expected_notes:?}\n  实际 {actual_notes:?}"
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

/// 随机流必须**一条不剩**地用完 —— 少用一条说明有分支没走到，多用一条说明凭空造了随机。
#[tokio::test]
async fn every_recorded_random_is_consumed() {
    for (index, case) in cases().iter().enumerate() {
        let rng = ReplayRng::new(&case["randoms"]);
        let probe = rng.clone();
        let host = MockHost::new(case, Arc::new(Mutex::new(Vec::new())));
        let runtime = Runtime::new(host, rng);
        let outcome = match case["fn"].as_str().unwrap_or("") {
            "getQrCode" => runtime.get_qr_code().await,
            "checkQrConnect" => {
                let token = case["args"][0].as_str().unwrap_or("").to_string();
                runtime.check_qr_connect(&token).await
            }
            "clear" => {
                let _ = runtime.get_qr_code().await;
                runtime.clear().await.map(|_| Value::Null)
            }
            "getQrCodeAfterClear" => {
                let _ = runtime.get_qr_code().await;
                let _ = runtime.clear().await;
                runtime.get_qr_code().await
            }
            other => panic!("未知用例 {other}"),
        };
        let _ = outcome;
        assert_eq!(
            probe.remaining(),
            0,
            "第 {} 条（{}）还剩 {} 条随机没用",
            index + 1,
            case["note"].as_str().unwrap_or(""),
            probe.remaining()
        );
    }
}
