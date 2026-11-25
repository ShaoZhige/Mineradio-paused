//! `scripts/http-parity.js` 用的探针：从 stdin 逐行读任务，逐行吐结果。
//!
//! ```text
//! cargo run -q --example http_probe <<< '{"url":"http://127.0.0.1:1234/ok"}'
//! ```
//!
//! 一次进程跑完所有用例（而不是每个用例起一次）—— 这既省掉反复建 `reqwest::Client`
//! 的开销，也让"连接复用"这类跨请求的性质更接近真实运行。
//!
//! 输入一行一个 JSON：
//! ```json
//! {"url":"…","method":"GET","headers":[["k","v"]],"body":"…","timeoutMs":10000,"json":false}
//! ```
//!
//! 输出一行一个 JSON，两种形状：
//! ```json
//! {"ok":"<文本>","elapsedMs":12}
//! {"err":{"kind":"status","message":"HTTP 404","status":404,"body":"…"},"elapsedMs":3}
//! ```
//!
//! `elapsedMs` **不参与比对**（时序不稳），只打印给人看。

use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

use mineradio_http::{HttpClient, HttpError, Request};
use serde_json::{json, Value};

#[tokio::main]
async fn main() {
    let client = match HttpClient::new() {
        Ok(client) => client,
        Err(err) => {
            eprintln!("建 client 失败：{}", err.message());
            std::process::exit(2);
        }
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let task: Value = match serde_json::from_str(&line) {
            Ok(task) => task,
            Err(err) => {
                eprintln!("跳过非法任务行：{err}");
                continue;
            }
        };
        let result = run(&client, &task).await;
        writeln!(stdout, "{result}").expect("写 stdout 失败");
        // 必须立刻 flush：Node 侧是边写边读的，攒着会导致对拍挂死。
        stdout.flush().expect("flush 失败");
    }
}

async fn run(client: &HttpClient, task: &Value) -> Value {
    let Some(url) = task["url"].as_str() else {
        return json!({ "err": { "kind": "badtask", "message": "缺少 url" } });
    };

    let mut request = Request::get();
    if let Some(method) = task["method"].as_str() {
        request = request.method(method);
    }
    if let Some(headers) = task["headers"].as_array() {
        for pair in headers {
            let (Some(name), Some(value)) = (pair[0].as_str(), pair[1].as_str()) else {
                continue;
            };
            request = request.header(name, value);
        }
    }
    if let Some(body) = task["body"].as_str() {
        request = request.body(body);
    }
    if let Some(millis) = task["timeoutMs"].as_u64() {
        request = request.timeout(Duration::from_millis(millis));
    }
    let want_json = task["json"].as_bool().unwrap_or(false);

    let started = Instant::now();
    let outcome = if want_json {
        client.request_json(url, &request).await
    } else {
        client.request_text(url, &request).await.map(Value::String)
    };
    let elapsed = started.elapsed().as_millis() as u64;

    match outcome {
        Ok(value) => json!({ "ok": value, "elapsedMs": elapsed }),
        Err(err) => json!({
            "err": {
                "kind": kind(&err),
                "message": err.message(),
                "status": err.status_code(),
                "body": err.body(),
            },
            "elapsedMs": elapsed,
        }),
    }
}

fn kind(err: &HttpError) -> &'static str {
    match err {
        HttpError::Timeout => "timeout",
        HttpError::Network { .. } => "network",
        HttpError::Status { .. } => "status",
        HttpError::InvalidJson { .. } => "invalidjson",
        HttpError::Client { .. } => "client",
    }
}
