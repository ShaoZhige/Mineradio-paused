//! Mineradio 的本地 HTTP 服务。P1 阶段只做三件事：
//!
//! 1. 静态托管 `public/`（前端逐字节不动，所以这里只是"换个服务器发同样的字节"）
//! 2. `/api/*` 全部返回 `{ok:false, reason:"NOT_IMPLEMENTED"}`，让前端拿到结构化失败而不是 404 空白
//! 3. `/internal/*` 用一次性 token 保护，作为主进程与服务的私聊通道
//!
//! 这个 crate **不依赖 tauri**：`cargo run -p mineradio-server` 就能起来，配合 curl 验证渲染前的
//! 静态链路；同样的 `start()` 被 `src-tauri` 直接调用。

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use anyhow::Context;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower_http::services::ServeDir;

/// 主进程 ↔ 服务的共享状态。端口和 token 在绑定后才知道，所以整体走 State 注入。
#[derive(Clone)]
struct AppState {
    port: u16,
    /// `/internal/*` 的准入 token：一次性生成、随进程消失，渲染进程拿不到（不在 shim 里暴露）
    token: String,
}

/// 服务句柄：调用方拿它拼 URL、并在退出时优雅关停。
pub struct ServerHandle {
    pub addr: SocketAddr,
    pub token: String,
    shutdown: Option<oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    /// 关停并等任务退出。重复调用是安全的（第二次直接返回）。
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = self.join.await;
    }
}

/// 绑定 `127.0.0.1:0`（系统分配端口）并开始服务。
///
/// 只绑回环地址是刻意的：Electron 时代的服务也是本地私有的，Tauri 侧不能因为"反正本机"
/// 就监听到 0.0.0.0 —— 那会把整个曲库接口暴露到局域网。
pub async fn start(public_dir: PathBuf) -> anyhow::Result<ServerHandle> {
    start_with_port(0, public_dir).await
}

/// 同上，但可以指定端口（`0` = 系统分配）。指定端口只用于调试。
pub async fn start_with_port(port: u16, public_dir: PathBuf) -> anyhow::Result<ServerHandle> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::from([127, 0, 0, 1]), port))
        .await
        .with_context(|| format!("绑定 127.0.0.1:{port} 失败"))?;
    let addr = listener.local_addr().context("读取本地端口失败")?;

    if !public_dir.is_dir() {
        anyhow::bail!("静态目录不存在：{}", public_dir.display());
    }

    let state = AppState {
        port: addr.port(),
        token: random_token(),
    };
    let token = state.token.clone();

    let static_service = ServeDir::new(&public_dir).append_index_html_on_directories(true);

    let app = Router::new()
        .route("/api", any(api_stub))
        .route("/api/{*rest}", any(api_stub))
        .route("/internal/ping", any(internal_ping))
        .fallback_service(static_service)
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, guard));

    let (tx, rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(err) = server.await {
            eprintln!("[mineradio-server] 服务异常退出：{err}");
        }
    });

    Ok(ServerHandle {
        addr,
        token,
        shutdown: Some(tx),
        join,
    })
}

fn random_token() -> String {
    // 不引 rand：用系统时间 + 进程号 + 计数器拼一个够用的 32 位十六进制串。
    // 这个 token 只防"同机其它网页猜端口去调 /internal"，不承担密码学职责。
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;
    let mixed = nanos ^ (pid << 32) ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{mixed:016x}{:08x}", (nanos >> 32) as u32)
}

/// `/api/*` 的占位应答。
///
/// 前端大量代码是 `fetch('/api/...').then(r => r.json())` 再按字段判断，
/// 所以这里给 **HTTP 501 + 完整 JSON 体**，而不是 404：前者能走到前端的错误分支，
/// 后者会变成"接口不存在"的另一种假象，排查时分不清是没搬还是搬错了。
async fn api_stub(req: Request) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().as_str().to_string();
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "ok": false,
            "reason": "NOT_IMPLEMENTED",
            "path": path,
            "method": method,
            "detail": "Rust 侧尚未搬移该路由，见 docs/REWRITE-PLAN.md 的 P2",
        })),
    )
        .into_response()
}

async fn internal_ping(State(state): State<AppState>) -> Response {
    Json(json!({ "ok": true, "port": state.port })).into_response()
}

/// 前置守卫：Host 必须是本机回环，跨站请求一律拒，`/internal/*` 还要 token。
///
/// 这三条在 Electron 版里靠"只有自家窗口会访问"隐式成立；换成 WebView2 + 本地 HTTP 后
/// 任何本机网页都能敲这个端口，所以必须显式挡住。
async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let port = state.port;

    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|host| {
            let host = host.to_ascii_lowercase();
            host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
        })
        .unwrap_or(false);
    if !host_ok {
        return (StatusCode::FORBIDDEN, "bad host").into_response();
    }

    if let Some(site) = req
        .headers()
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
    {
        if site.eq_ignore_ascii_case("cross-site") {
            return (StatusCode::FORBIDDEN, "cross-site blocked").into_response();
        }
    }

    if req.uri().path().starts_with("/internal/") {
        let token_ok = req
            .headers()
            .get("x-mineradio-token")
            .and_then(|v| v.to_str().ok())
            .map(|got| constant_time_eq(got.as_bytes(), state.token.as_bytes()))
            .unwrap_or(false);
        if !token_ok {
            return (StatusCode::FORBIDDEN, "bad token").into_response();
        }
    }

    next.run(req).await
}

/// 定时比较，避免 token 被逐字节试探出前缀。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 给调用方的默认静态目录：仓库里的 `public/`。
pub fn default_public_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("public")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 自带一个极小的 HTTP/1.1 客户端：只为验证"服务真的按预期回话"，
    /// 不引 reqwest —— 那会给这个本应很轻的 crate 拖进一整套 TLS 依赖。
    async fn request(port: u16, host: &str, path: &str, extra: &[(&str, &str)]) -> (u16, String) {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let mut head = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
        for (k, v) in extra {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).await.unwrap();

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }

    /// 每个用例独占一个临时目录，避免并行跑测试时互相踩。
    fn fixture_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mineradio-server-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(dir.join("index.html")).unwrap();
        f.write_all(b"<html>MINERADIO-FIXTURE</html>").unwrap();
        dir
    }

    #[test]
    fn constant_time_eq_matches_normal_equality() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        assert!(!constant_time_eq(b"abc", b"abc123"));
        assert!(constant_time_eq(b"", b""));
    }

    #[tokio::test]
    async fn serves_index_and_stubs_api() {
        let dir = fixture_dir();
        let handle = start_with_port(0, dir.clone()).await.unwrap();
        let port = handle.addr.port();

        let (status, body) = request(port, &format!("127.0.0.1:{port}"), "/", &[]).await;
        assert_eq!(status, 200, "首页应 200");
        assert!(body.contains("MINERADIO-FIXTURE"), "首页内容不对：{body}");

        let (status, body) = request(
            port,
            &format!("127.0.0.1:{port}"),
            "/api/search?keywords=x",
            &[],
        )
        .await;
        assert_eq!(status, 501, "未搬移的接口应 501");
        assert!(
            body.contains("\"reason\":\"NOT_IMPLEMENTED\""),
            "桩应答缺少 reason：{body}"
        );
        assert!(body.contains("/api/search"), "桩应答应回报请求路径：{body}");

        handle.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rejects_bad_host_and_guards_internal_token() {
        let dir = fixture_dir();
        let handle = start_with_port(0, dir.clone()).await.unwrap();
        let port = handle.addr.port();
        let good_host = format!("127.0.0.1:{port}");

        let (status, _) = request(port, &good_host, "/", &[]).await;
        assert_eq!(status, 200);

        // 换 Host：本机网页想借 DNS rebinding 打进来时挡在门口
        let (status, _) = request(port, "evil.example:1234", "/", &[]).await;
        assert_eq!(status, 403, "Host 不符应 403");

        // 跨站请求
        let (status, _) = request(
            port,
            &good_host,
            "/api/search",
            &[("sec-fetch-site", "cross-site")],
        )
        .await;
        assert_eq!(status, 403, "跨站请求应 403");

        // /internal 必须带 token
        let (status, _) = request(port, &good_host, "/internal/ping", &[]).await;
        assert_eq!(status, 403, "无 token 应 403");
        let (status, body) = request(
            port,
            &good_host,
            "/internal/ping",
            &[("x-mineradio-token", &handle.token)],
        )
        .await;
        assert_eq!(status, 200, "带 token 应 200：{body}");
        let (status, _) = request(
            port,
            &good_host,
            "/internal/ping",
            &[("x-mineradio-token", "wrong")],
        )
        .await;
        assert_eq!(status, 403, "错 token 应 403");

        handle.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_static_file_is_404_not_200() {
        let dir = fixture_dir();
        let handle = start_with_port(0, dir.clone()).await.unwrap();
        let port = handle.addr.port();
        let (status, _) = request(port, &format!("127.0.0.1:{port}"), "/nope.js", &[]).await;
        assert_eq!(status, 404, "不存在的静态文件必须 404");
        handle.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
