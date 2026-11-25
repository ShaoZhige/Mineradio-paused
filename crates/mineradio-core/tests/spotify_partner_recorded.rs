//! 回放 `scripts/record-spotify-partner.js` 录下的通道行为。
//!
//! 每条用例的形状是 `{fn, args, ok|err, requests, responses, tokens, notes}`：
//!
//! * `ok` / `err` —— 输出或错误，逐字段比对。
//! * `requests` —— 这一次调用发出的**全部**请求（URL / method / headers 顺序 / body 原文
//!   / timeout）。这是契约的一部分：headers 顺序来自 `Object.assign`，body 来自
//!   `JSON.stringify`，顺序错了就证明不了"与旧实现一致"。
//! * `responses` —— 按 key 归组的预设响应。**不是队列**：`readAccount` 用 `Promise.all`
//!   并发发两个请求，顺序不确定，所以按 `pathfinder:<operationName>` /
//!   `spclient:<path>` 归组，同 key 多次调用按数组顺序消费。
//! * `tokens` —— `getAccessToken` 的调用序列（`plain` / `force`）。
//! * `notes` —— warn / log 调用的文本。
//!
//! 顺序无关的三项（requests / tokens / notes）比较前排序：`readAccount` 的两个请求
//! 谁先到达传输层取决于调度，把它们当成"必须按录制顺序"会让测试在不同机器上翻车。
//!
//! 重录：`node scripts/record-spotify-partner.js --write`
//! 检查同步：`npm run spotifypartner:check`

// 与模块本身同样的理由：`PartnerError` 要带 statusCode / body，超过 clippy 的阈值。
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use mineradio_core::spotify_partner::{
    Auth, Partner, PartnerError, Transport, TransportError, TransportRequest,
};
use serde_json::{json, Value};

// ---------- 桩 ----------

#[derive(Clone)]
enum Answer {
    Ok(Value),
    Fail(TransportError),
}

#[derive(Clone)]
struct MockTransport {
    responses: Arc<HashMap<String, Vec<Answer>>>,
    cursors: Arc<Mutex<HashMap<String, usize>>>,
    requests: Arc<Mutex<Vec<TransportRequest>>>,
}

impl MockTransport {
    fn new(responses: &Value) -> Self {
        let mut table = HashMap::new();
        if let Some(map) = responses.as_object() {
            for (key, list) in map {
                let answers = list
                    .as_array()
                    .map(|items| items.iter().map(parse_answer).collect())
                    .unwrap_or_default();
                table.insert(key.clone(), answers);
            }
        }
        Self {
            responses: Arc::new(table),
            cursors: Arc::new(Mutex::new(HashMap::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn take(&self, key: &str) -> Result<Answer, TransportError> {
        let mut cursors = self.cursors.lock().expect("游标锁");
        let index = cursors.entry(key.to_string()).or_insert(0);
        let answers = self
            .responses
            .get(key)
            .ok_or_else(|| TransportError::network(format!("fixture 里没有 {key} 的预设响应")))?;
        let answer = answers.get(*index).cloned().ok_or_else(|| {
            TransportError::network(format!("{key} 的预设响应用完了（第 {} 次）", *index + 1))
        })?;
        *index += 1;
        Ok(answer)
    }

    fn recorded(&self) -> Vec<TransportRequest> {
        self.requests.lock().expect("请求锁").clone()
    }
}

fn parse_answer(item: &Value) -> Answer {
    if let Some(error) = item.get("error") {
        let status_code = error
            .get("statusCode")
            .and_then(Value::as_u64)
            .map(|v| v as u16);
        let body = error
            .get("body")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        return Answer::Fail(TransportError {
            status_code,
            body,
            message,
        });
    }
    Answer::Ok(item.get("ok").cloned().unwrap_or(Value::Null))
}

/// 与录制器的 `responseKey()` 逐字对应。
fn response_key(request: &TransportRequest) -> String {
    if request.url.contains("api-partner.spotify.com") {
        let operation = request
            .body
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|body| {
                body.get("operationName")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        return format!("pathfinder:{operation}");
    }
    if request.url.contains("spclient.wg.spotify.com") {
        let path = request
            .url
            .trim_start_matches("https://spclient.wg.spotify.com")
            .split('?')
            .next()
            .unwrap_or("");
        return format!("spclient:{path}");
    }
    format!("other:{}", request.url)
}

impl Transport for MockTransport {
    async fn send(&self, request: TransportRequest) -> Result<Value, TransportError> {
        let key = response_key(&request);
        self.requests.lock().expect("请求锁").push(request);
        match self.take(&key)? {
            Answer::Ok(value) => Ok(value),
            Answer::Fail(error) => Err(error),
        }
    }
}

#[derive(Clone)]
struct MockAuth {
    calls: Arc<Mutex<Vec<&'static str>>>,
}

impl MockAuth {
    fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn recorded(&self) -> Vec<String> {
        self.calls
            .lock()
            .expect("令牌锁")
            .iter()
            .map(|item| item.to_string())
            .collect()
    }
}

impl Auth for MockAuth {
    async fn access_token(&self, force: bool) -> Result<String, PartnerError> {
        let mut calls = self.calls.lock().expect("令牌锁");
        calls.push(if force { "force" } else { "plain" });
        Ok(format!("tok-{}", calls.len()))
    }
}

// ---------- 比对工具 ----------

fn request_to_json(request: &TransportRequest) -> Value {
    json!({
        "url": request.url,
        "method": request.method,
        "timeoutMs": request.timeout_ms,
        "headers": request
            .headers
            .iter()
            .map(|(name, value)| json!([name, value]))
            .collect::<Vec<_>>(),
        "body": request.body,
    })
}

/// 排序后的规范化文本，用于"顺序无关"的比较。
fn sorted_lines(items: impl IntoIterator<Item = Value>) -> Vec<String> {
    let mut lines: Vec<String> = items
        .into_iter()
        .map(|item| serde_json::to_string(&item).expect("可序列化"))
        .collect();
    lines.sort();
    lines
}

fn cases() -> Vec<Value> {
    let raw = include_str!("fixtures/spotify-partner-cases.jsonl");
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture 行不是合法 JSON"))
        .collect()
}

fn args_of(case: &Value) -> Vec<Value> {
    case["args"].as_array().cloned().unwrap_or_default()
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

fn opt_text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

fn int(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number as i64))
        .unwrap_or(0)
}

fn strs(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().map(text).collect())
        .unwrap_or_default()
}

// ---------- 按 fn 分派 ----------

async fn run_case(
    case: &Value,
    partner: &Partner<MockTransport, MockAuth>,
) -> Result<Value, PartnerError> {
    let args = args_of(case);
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    match case["fn"].as_str().unwrap_or("") {
        "readAccount" => {
            let token = opt_text(&arg(0));
            partner.read_account(token.as_deref()).await
        }
        "searchTracks" => {
            partner
                .search_tracks(&text(&arg(0)), int(&arg(1)), int(&arg(2)))
                .await
        }
        "likedTracks" => partner.liked_tracks(int(&arg(0)), int(&arg(1))).await,
        "libraryPlaylists" => partner.library_playlists(int(&arg(0)), int(&arg(1))).await,
        "playlistHead" => Ok(partner
            .playlist_head(&text(&arg(0)))
            .await?
            .unwrap_or(Value::Null)),
        "playlistTracks" => {
            partner
                .playlist_tracks(&text(&arg(0)), int(&arg(1)), int(&arg(2)))
                .await
        }
        "album" => {
            partner
                .album(&text(&arg(0)), int(&arg(1)), int(&arg(2)))
                .await
        }
        "libraryLookup" => Ok(Value::Object(partner.library_lookup(&strs(&arg(0))).await?)),
        "setLibrary" => Ok(Value::Bool(
            partner
                .set_library(&text(&arg(0)), arg(1) == Value::Bool(true))
                .await?,
        )),
        "readAccountThenSetLibrary" => {
            let token = opt_text(&arg(0));
            partner.read_account(token.as_deref()).await?;
            Ok(Value::Bool(
                partner
                    .set_library(&text(&arg(1)), arg(2) == Value::Bool(true))
                    .await?,
            ))
        }
        "addToPlaylist" => {
            partner
                .add_to_playlist(&text(&arg(0)), &strs(&arg(1)))
                .await
        }
        "createPlaylist" => partner.create_playlist(&text(&arg(0))).await,
        "lyrics" => Ok(partner.lyrics(&text(&arg(0))).await?.unwrap_or(Value::Null)),
        // `query` / `change` 在原实现里也是暴露的（`partner.query(name, vars)`）。
        "query" => {
            // `ask` 不是公开方法，但 `query` 是 —— 走它才能覆盖"未知查询名"
            // 与"哈希失效"两类分支。
            partner.query(&text(&arg(0)), &arg(1)).await
        }
        "change" => {
            let changed = partner.change(&text(&arg(0)), &arg(1)).await?;
            Ok(Value::Bool(changed))
        }
        other => panic!("fixture 里出现了没实现的 fn：{other}"),
    }
}

fn error_to_json(error: &PartnerError) -> Value {
    let mut out = json!({ "code": error.code, "message": error.message });
    if let Some(detail) = &error.detail {
        out["detail"] = Value::String(detail.clone());
    }
    if let Some(query) = &error.partner_query {
        out["partnerQuery"] = Value::String(query.clone());
    }
    if let Some(status) = error.status_code {
        out["statusCode"] = json!(status);
    }
    if let Some(body) = &error.body {
        out["body"] = Value::String(body.clone());
    }
    out
}

/// fixture 里 `err` 那一段，缺的键不补 —— 与 [`error_to_json`] 的"不设就不出现"对齐。
fn expected_error(error: &Value) -> Value {
    let mut out = json!({ "code": error["code"].clone(), "message": error["message"].clone() });
    for key in ["detail", "partnerQuery", "statusCode", "body"] {
        if let Some(value) = error.get(key) {
            out[key] = value.clone();
        }
    }
    out
}

fn sorted(items: &[String]) -> Vec<String> {
    let mut list = items.to_vec();
    list.sort();
    list
}

// ---------- 测试 ----------

#[tokio::test]
async fn replays_recorded_channel_behaviour() {
    let all = cases();
    assert!(!all.is_empty(), "fixture 是空的");
    let mut failures = Vec::new();

    for (index, case) in all.iter().enumerate() {
        let notes = Arc::new(Mutex::new(Vec::<String>::new()));
        let warn_notes = Arc::clone(&notes);
        let log_notes = Arc::clone(&notes);
        let transport = MockTransport::new(&case["responses"]);
        let auth = MockAuth::new();
        let transport_probe = transport.clone();
        let auth_probe = auth.clone();
        let partner = Partner::new(transport, auth)
            .with_language("zh-CN")
            .with_timeout_ms(20_000)
            .with_warn(Arc::new(move |text: &str| {
                warn_notes
                    .lock()
                    .expect("warn 锁")
                    .push(format!("warn:{text}"));
            }))
            .with_log(Arc::new(move |text: &str| {
                log_notes
                    .lock()
                    .expect("log 锁")
                    .push(format!("log:{text}"));
            }));

        let outcome = run_case(case, &partner).await;
        let label = format!(
            "第 {} 条 {}（{}）",
            index + 1,
            case["fn"].as_str().unwrap_or("?"),
            case["note"].as_str().unwrap_or("")
        );

        match (&case.get("err"), outcome) {
            (Some(_), Err(actual)) => {
                let expected = expected_error(&case["err"]);
                let actual = error_to_json(&actual);
                if expected != actual {
                    failures.push(format!(
                        "{label}\n  错误不符\n  期望 {expected}\n  实际 {actual}"
                    ));
                }
            }
            (Some(expected), Ok(actual)) => failures.push(format!(
                "{label}\n  期望抛错 {}，实际返回 {actual}",
                expected["code"]
            )),
            (None, Err(actual)) => failures.push(format!(
                "{label}\n  期望返回 {}，实际抛错 {}（{}）",
                case["ok"], actual.code, actual.message
            )),
            (None, Ok(actual)) => {
                let expected = case["ok"].clone();
                if expected != actual {
                    failures.push(format!(
                        "{label}\n  输出不符\n  期望 {expected}\n  实际 {actual}"
                    ));
                }
            }
        }

        // 请求形状（顺序无关）
        let expected_requests =
            sorted_lines(case["requests"].as_array().cloned().unwrap_or_default());
        let actual_requests = sorted_lines(
            transport_probe
                .recorded()
                .iter()
                .map(request_to_json)
                .collect::<Vec<_>>(),
        );
        if expected_requests != actual_requests {
            failures.push(format!(
                "{label}\n  请求不符\n  期望 {}\n  实际 {}",
                expected_requests.join(" / "),
                actual_requests.join(" / ")
            ));
        }

        // 令牌调用序列（顺序无关：readAccount 的两个请求谁先到不影响 pool 语义）
        let expected_tokens: Vec<String> = case["tokens"]
            .as_array()
            .map(|items| items.iter().map(text).collect())
            .unwrap_or_default();
        let actual_tokens = auth_probe.recorded();
        if sorted(&expected_tokens) != sorted(&actual_tokens) {
            failures.push(format!(
                "{label}\n  令牌序列不符\n  期望 {expected_tokens:?}\n  实际 {actual_tokens:?}"
            ));
        }

        // 副作用日志（顺序无关）
        let expected_notes: Vec<String> = case["notes"]
            .as_array()
            .map(|items| items.iter().map(text).collect())
            .unwrap_or_default();
        let actual_notes = notes.lock().expect("notes 锁").clone();
        if sorted(&expected_notes) != sorted(&actual_notes) {
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

#[test]
fn fixture_covers_every_channel_capability() {
    let names: Vec<String> = cases()
        .iter()
        .map(|case| case["fn"].as_str().unwrap_or_default().to_string())
        .collect();
    for expected in [
        "readAccount",
        "searchTracks",
        "likedTracks",
        "libraryPlaylists",
        "playlistHead",
        "playlistTracks",
        "album",
        "libraryLookup",
        "setLibrary",
        "readAccountThenSetLibrary",
        "addToPlaylist",
        "createPlaylist",
        "lyrics",
        "query",
        "change",
    ] {
        assert!(
            names.iter().any(|name| name == expected),
            "fixture 里没有 {expected} 的用例"
        );
    }
}
