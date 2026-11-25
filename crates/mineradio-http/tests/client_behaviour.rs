//! `mineradio-http` 的客户端行为契约（不依赖 Node）。
//!
//! 与 `scripts/http-parity.js` 分工不同：
//! - parity 脚本证明"**与 Node 原版一致**"，但它要 node + cargo 两个工具链，进不了 `cargo test`；
//! - 这里证明"**自身行为符合契约**"，用纯 Rust 起本地服务器，四道闸门里的
//!   `cargo test --workspace` 就能跑到。
//!
//! 最要紧的是 `timeout_is_idle_not_total`：服务器每 100ms 吐一块、共 5 块（总 500ms），
//! 而超时只给 250ms。**必须成功**。写成总超时的话这条会红 —— 而线上表现是"音频
//! 下载到一半莫名失败"，极难联想到超时配置。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use mineradio_http::{HttpClient, HttpError, Request};

/// 起一个只服务一次请求的服务器，把响应交给 `respond` 写出去。返回端口。
fn serve_once(respond: impl FnOnce(&mut TcpStream) + Send + 'static) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定失败");
    let port = listener.local_addr().expect("取端口失败").port();
    thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // 必须先把请求读掉：不读的话客户端可能卡在写请求体上。
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            respond(&mut stream);
        }
    });
    port
}

fn respond_with(
    status_line: &'static str,
    extra_headers: &'static str,
    body: &'static [u8],
) -> impl FnOnce(&mut TcpStream) + Send + 'static {
    move |stream: &mut TcpStream| {
        let head = format!(
            "HTTP/1.1 {status_line}\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body);
        let _ = stream.flush();
    }
}

fn client() -> HttpClient {
    HttpClient::new().expect("建 client 不该失败")
}

#[tokio::test]
async fn reads_body_as_utf8() {
    let port = serve_once(respond_with(
        "200 OK",
        "Content-Type: text/plain\r\n",
        "小马 🌈".as_bytes(),
    ));
    let text = client()
        .request_text(&format!("http://127.0.0.1:{port}/"), &Request::get())
        .await
        .expect("该成功");
    assert_eq!(text, "小马 🌈");
}

/// 声明 charset=utf-8 之外的编码也不该改变解码方式 —— Node 一律按 UTF-8 解。
#[tokio::test]
async fn ignores_declared_charset() {
    // 0xFF 0xFE 0x41：不是合法 UTF-8 起始字节。
    let port = serve_once(respond_with(
        "200 OK",
        "Content-Type: text/plain; charset=gbk\r\n",
        &[0xff, 0xfe, 0x41],
    ));
    let text = client()
        .request_text(&format!("http://127.0.0.1:{port}/"), &Request::get())
        .await
        .expect("该成功");
    // 宽松解码：坏字节变成 U+FFFD，'A' 保留。与 Node 的 Buffer.toString('utf8') 一致。
    assert_eq!(text, "\u{FFFD}\u{FFFD}A");
}

#[tokio::test]
async fn status_errors_carry_body() {
    let port = serve_once(respond_with("404 Not Found", "", b"not found"));
    let err = client()
        .request_text(&format!("http://127.0.0.1:{port}/"), &Request::get())
        .await
        .expect_err("404 必须报错");
    assert_eq!(err.message(), "HTTP 404");
    assert_eq!(err.status_code(), Some(404));
    assert_eq!(err.body(), Some("not found"));
    assert!(matches!(err, HttpError::Status { .. }));
}

/// 重定向不跟随：302 原样交回调用方，与 Node 的 `https.request` 一致。
#[tokio::test]
async fn redirects_are_not_followed() {
    let port = serve_once(respond_with("302 Found", "Location: /elsewhere\r\n", b""));
    let text = client()
        .request_text(&format!("http://127.0.0.1:{port}/"), &Request::get())
        .await
        .expect("302 不算错误状态");
    assert_eq!(text, "");
}

/// 核心用例：超时是**空闲**时长，不是总时长。
#[tokio::test]
async fn timeout_is_idle_not_total() {
    let port = serve_once(|stream: &mut TcpStream| {
        let _ =
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 30\r\nConnection: close\r\n\r\n");
        let _ = stream.flush();
        // 每 100ms 一块，共 5 块 → 总耗时 ~500ms，但任何一次间隔都远小于 250ms 的超时。
        for index in 0..5 {
            thread::sleep(Duration::from_millis(100));
            let _ = stream.write_all(format!("chunk{index}\n").as_bytes());
            let _ = stream.flush();
        }
    });

    let started = Instant::now();
    let text = client()
        .request_text(
            &format!("http://127.0.0.1:{port}/"),
            &Request::get().timeout(Duration::from_millis(250)),
        )
        .await
        .expect("持续有数据流动时不该超时");
    let elapsed = started.elapsed();

    assert!(text.starts_with("chunk0"), "实际拿到：{text:?}");
    assert!(
        elapsed >= Duration::from_millis(400),
        "总耗时只有 {elapsed:?}，说明根本没等到数据流结束 —— 用例本身没生效"
    );
}

/// 反过来：一直不吐数据（连响应头都不发）就必须超时。
#[tokio::test]
async fn silence_times_out() {
    let port = serve_once(|stream: &mut TcpStream| {
        // 收下请求后什么都不发，等客户端自己放弃。
        thread::sleep(Duration::from_secs(3));
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    });

    let started = Instant::now();
    let err = client()
        .request_text(
            &format!("http://127.0.0.1:{port}/"),
            &Request::get().timeout(Duration::from_millis(200)),
        )
        .await
        .expect_err("沉默的服务器必须判超时");
    let elapsed = started.elapsed();

    assert!(matches!(err, HttpError::Timeout), "实际是 {err:?}");
    assert_eq!(err.message(), "Request timeout");
    assert!(
        elapsed < Duration::from_secs(2),
        "超时判定花了 {elapsed:?}，明显没有按 200ms 生效"
    );
}

#[tokio::test]
async fn invalid_json_is_reported_with_the_url() {
    let port = serve_once(respond_with(
        "200 OK",
        "Content-Type: application/json\r\n",
        b"{a:1}",
    ));
    let url = format!("http://127.0.0.1:{port}/api");
    let err = client()
        .request_json(&url, &Request::get())
        .await
        .expect_err("非法 JSON 必须报错");
    assert!(matches!(err, HttpError::InvalidJson { .. }));
    assert_eq!(err.message(), format!("Invalid JSON from {url}"));
}

#[tokio::test]
async fn json_parses() {
    let port = serve_once(respond_with(
        "200 OK",
        "Content-Type: application/json\r\n",
        br#"{"a":1,"b":[2,3]}"#,
    ));
    let value = client()
        .request_json(&format!("http://127.0.0.1:{port}/"), &Request::get())
        .await
        .expect("该成功");
    assert_eq!(value["a"], 1);
    assert_eq!(value["b"][1], 3);
}

/// 请求体走 chunked —— 与 Node 的 `req.write()` 一致（不设 Content-Length）。
///
/// 这条是 parity 脚本发现的：定长 body 时 reqwest 会自己算 Content-Length，
/// 服务器看到的东西就和 Node 不一样了。
#[tokio::test]
async fn request_body_is_chunked() {
    let (tx, rx) = std::sync::mpsc::channel::<String>();

    // 这个用例要自己起 listener：`serve_once` 会预读一次请求头，而这里需要的正是
    // 原始的请求头字节。
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定失败");
    let port = listener.local_addr().expect("取端口失败").port();
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    buffer.extend_from_slice(&chunk[..read]);
                    // chunked 的结束标记。
                    if String::from_utf8_lossy(&buffer).contains("0\r\n\r\n") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&buffer).to_string());
        let _ =
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let _ = stream.flush();
    });

    let _ = client()
        .request_text(
            &format!("http://127.0.0.1:{port}/"),
            &Request::get().method("POST").body("payload"),
        )
        .await;

    let head = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("没收到请求头");
    let lowered = head.to_lowercase();
    assert!(
        lowered.contains("transfer-encoding: chunked"),
        "请求体应当是 chunked（与 Node 一致），实际请求头：\n{head}"
    );
    assert!(
        !lowered.contains("content-length"),
        "不该出现 Content-Length，实际请求头：\n{head}"
    );
}
