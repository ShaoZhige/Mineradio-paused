//! Mineradio 的本地 HTTP 服务。
//!
//! 三件事：
//!
//! 1. 静态托管 `public/`（前端逐字节不动，这里只是"换台服务器发同样的字节"）
//! 2. `/api/*` 全部返回 `{ok:false, reason:"NOT_IMPLEMENTED"}`，让前端拿到结构化失败而不是 404 空白
//! 3. `/internal/*` 用一次性 token 保护，作为主进程与服务的私聊通道
//!
//! 这个 crate **不依赖 tauri**：`cargo run -p mineradio-server` 就能起来，配合 curl 验证渲染前的
//! 静态链路；同样的 `start()` 被 `src-tauri` 直接调用。
//!
//! 静态部分没有用 `tower-http` 的 `ServeDir`：它的 ETag 格式（`"<mtime>.<nanos>-<size>"`）和
//! 后缀取法（`mime_guess`，`.js` 给 `text/javascript`）都与 Electron 版不同。P2 的目标是行为
//! 一致，所以这里直接调 `mineradio_core::static_assets`，与 `server/static-assets.js` 对齐。

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};

use anyhow::Context;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use mineradio_core::static_assets;

/// 主进程 ↔ 服务的共享状态。端口和 token 在绑定后才知道，所以整体走 State 注入。
#[derive(Clone)]
struct AppState {
    port: u16,
    /// `/internal/*` 的准入 token：一次性生成、随进程消失，渲染进程拿不到（不在 shim 里暴露）
    token: String,
    /// `public/` 的绝对路径
    public_dir: PathBuf,
    /// `/favicon.ico` 的实际文件。Electron 版把它指到 `build/icon.ico`（`public/` 里没有这个文件），
    /// 不照抄的话窗口控制台会多一条 404。
    favicon: Option<PathBuf>,
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
    if !public_dir.is_dir() {
        anyhow::bail!("静态目录不存在：{}", public_dir.display());
    }

    let favicon = default_favicon(&public_dir);
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::from([127, 0, 0, 1]), port))
        .await
        .with_context(|| format!("绑定 127.0.0.1:{port} 失败"))?;
    let addr = listener.local_addr().context("读取本地端口失败")?;

    let state = AppState {
        port: addr.port(),
        token: random_token(),
        public_dir,
        favicon,
    };
    let token = state.token.clone();

    let app = Router::new()
        .route("/api", any(api_stub))
        .route("/api/{*rest}", any(api_stub))
        .route("/internal/ping", any(internal_ping))
        .fallback(static_handler)
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

/// favicon 的位置：与 Electron 版一致取 `<repo>/build/icon.ico`（`public/` 的兄弟目录）。
fn default_favicon(public_dir: &Path) -> Option<PathBuf> {
    let candidate = public_dir.parent()?.join("build").join("icon.ico");
    candidate.is_file().then_some(candidate)
}

fn random_token() -> String {
    // 不引 rand：用系统时间 + 进程号 + 计数器拼一个够用的 16 位十六进制串。
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

/// 静态资源：条件请求 + ETag + 304。
///
/// 语义逐条对齐 `server/static-assets.js`：弱 ETag（size + 毫秒 mtime）、
/// `Cache-Control: no-cache`（"用之前必须验证"，不是"不要缓存"）、未命中时 404 + `Not Found`。
async fn static_handler(State(state): State<AppState>, req: Request) -> Response {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed").into_response();
    }

    let url_path = req.uri().path();
    let target = if url_path == "/favicon.ico" {
        match &state.favicon {
            Some(path) => path.clone(),
            None => return not_found(),
        }
    } else {
        // `resolve` 只做路径拼接与穿越拦截，是否真实存在由下面的 stat 判定。
        let Some(path) = static_assets::resolve(&state.public_dir, url_path) else {
            return not_found();
        };
        path
    };

    serve_file(&target, req.method() == Method::HEAD, req.headers()).await
}

fn not_found() -> Response {
    let mut res = (StatusCode::NOT_FOUND, "Not Found").into_response();
    // 与 JS 一致：404 也带 no-cache，免得代理把"暂时没有"缓存成"永远没有"。
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    res
}

async fn serve_file(
    file_path: &Path,
    head_only: bool,
    headers: &axum::http::HeaderMap,
) -> Response {
    // 用 std::fs 而不是 tokio::fs：这里读的是本机小文件（最大 ~19 MB 的字体/词表），
    // 丢进 spawn_blocking 反而多一次调度；真要放大会换成 tokio::fs。
    let stat = tokio::task::spawn_blocking({
        let path = file_path.to_path_buf();
        move || std::fs::metadata(&path)
    })
    .await
    .ok()
    .and_then(Result::ok);

    let Some(stat) = stat.filter(|s| s.is_file()) else {
        return not_found();
    };

    // 用整数算毫秒，不走浮点：`as_secs_f64() * 1000.0` 在"刚好是整毫秒"的时刻可能算成
    // x-ε，floor 之后差 1，就会凭空换掉 ETag（表现是有一次多余的 200，之后自愈）。
    // `subsec_millis()` 本身就是截断，与 JS 的 Math.floor 同义。
    let mtime_ms = stat
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_secs() * 1000 + u64::from(d.subsec_millis())) as f64)
        .unwrap_or(0.0);
    let etag = static_assets::etag_for(stat.len(), mtime_ms);

    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    if static_assets::etag_matches(if_none_match, &etag) {
        let mut res = StatusCode::NOT_MODIFIED.into_response();
        let h = res.headers_mut();
        h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        return res;
    }

    let body = if head_only {
        Vec::new()
    } else {
        match tokio::task::spawn_blocking({
            let path = file_path.to_path_buf();
            move || std::fs::read(&path)
        })
        .await
        {
            Ok(Ok(data)) => data,
            _ => return not_found(),
        }
    };

    let mut res = body.into_response();
    *res.status_mut() = StatusCode::OK;
    let h = res.headers_mut();
    // 必须按**解析后的文件名**取类型，不能按 URL：`/` 对应的实体是 `index.html`，
    // 按 URL 取会得到 "text/plain"（原实现同样是 `path.extname(filePath)`）。
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(static_assets::mime_for_path(&file_path.to_string_lossy())),
    );
    // HEAD 的 Content-Length 必须报实体长度，不能是 0。
    h.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&stat.len().to_string()).unwrap(),
    );
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    if let Ok(system_time) = stat.modified() {
        if let Ok(value) = HeaderValue::from_str(&httpdate(system_time)) {
            h.insert(header::LAST_MODIFIED, value);
        }
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    res
}

/// `Date.prototype.toUTCString()` 的等价格式（IMF-fixdate）。
///
/// 自己拼而不额外引 `httpdate` 依赖：这里只有一处用法，格式固定。
fn httpdate(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // 民用历反算（Howard Hinnant 的 civil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };

    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MO: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
        WD[days.rem_euclid(7) as usize],
        d,
        MO[(mo - 1) as usize],
        y,
        h,
        m,
        s
    )
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
    /// 返回 (状态码, 头, 体)；头按小写 key 存。
    async fn request(
        port: u16,
        host: &str,
        path: &str,
        extra: &[(&str, &str)],
    ) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let method = if extra.iter().any(|(k, _)| *k == ":head") {
            "HEAD"
        } else {
            "GET"
        };
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
        for (k, v) in extra {
            if *k == ":head" {
                continue;
            }
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).await.unwrap();

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("响应里没有空行");
        let head_text = String::from_utf8_lossy(&raw[..split]).to_string();
        let body = raw[split + 4..].to_vec();
        let mut lines = head_text.lines();
        let status = lines
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        let headers = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        (status, headers, body)
    }

    fn header_of(headers: &[(String, String)], name: &str) -> Option<String> {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
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
        std::fs::create_dir_all(dir.join("js")).unwrap();
        let mut f = std::fs::File::create(dir.join("index.html")).unwrap();
        f.write_all(b"<html>MINERADIO-FIXTURE</html>").unwrap();
        let mut f = std::fs::File::create(dir.join("js").join("main.js")).unwrap();
        f.write_all(b"console.log(1);").unwrap();
        dir
    }

    #[test]
    fn constant_time_eq_matches_normal_equality() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        assert!(!constant_time_eq(b"abc", b"abc123"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn httpdate_renders_imf_fixdate() {
        // 1700000000 = 2023-11-14T22:13:20Z
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        assert_eq!(httpdate(t), "Tue, 14 Nov 2023 22:13:20 GMT");
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(0);
        assert_eq!(httpdate(t), "Thu, 01 Jan 1970 00:00:00 GMT");
    }

    #[tokio::test]
    async fn serves_index_and_stubs_api() {
        let dir = fixture_dir();
        let handle = start_with_port(0, dir.clone()).await.unwrap();
        let port = handle.addr.port();

        let (status, _, body) = request(port, &format!("127.0.0.1:{port}"), "/", &[]).await;
        assert_eq!(status, 200, "首页应 200");
        assert!(
            String::from_utf8_lossy(&body).contains("MINERADIO-FIXTURE"),
            "首页内容不对"
        );

        let (status, _, body) = request(
            port,
            &format!("127.0.0.1:{port}"),
            "/api/search?keywords=x",
            &[],
        )
        .await;
        assert_eq!(status, 501, "未搬移的接口应 501");
        let body = String::from_utf8_lossy(&body);
        assert!(
            body.contains("\"reason\":\"NOT_IMPLEMENTED\""),
            "桩应答缺少 reason：{body}"
        );
        assert!(body.contains("/api/search"), "桩应答应回报请求路径：{body}");

        handle.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn static_sends_js_mime_and_weak_etag_then_304() {
        let dir = fixture_dir();
        let handle = start_with_port(0, dir.clone()).await.unwrap();
        let port = handle.addr.port();
        let host = format!("127.0.0.1:{port}");

        let (status, headers, body) = request(port, &host, "/js/main.js", &[]).await;
        assert_eq!(status, 200);
        assert_eq!(
            header_of(&headers, "content-type").as_deref(),
            Some("application/javascript"),
            "`.js` 必须是 application/javascript（与 Electron 版一致）"
        );
        assert_eq!(
            header_of(&headers, "cache-control").as_deref(),
            Some("no-cache")
        );
        let etag = header_of(&headers, "etag").expect("应带 ETag");
        assert!(etag.starts_with("W/\""), "ETag 应为弱标记：{etag}");
        assert_eq!(
            header_of(&headers, "content-length").as_deref(),
            Some(body.len().to_string().as_str())
        );
        assert!(
            header_of(&headers, "last-modified").is_some(),
            "应带 Last-Modified"
        );

        // 拿回同一个 ETag 再请求 → 304 且无体
        let (status, headers, body) =
            request(port, &host, "/js/main.js", &[("if-none-match", &etag)]).await;
        assert_eq!(status, 304, "ETag 命中应 304");
        assert_eq!(header_of(&headers, "etag").as_deref(), Some(etag.as_str()));
        assert!(body.is_empty(), "304 不能带实体");

        // 列表形式的 If-None-Match 也要命中
        let list = format!("W/\"deadbeef-1\", {etag}");
        let (status, _, _) = request(port, &host, "/js/main.js", &[("if-none-match", &list)]).await;
        assert_eq!(status, 304, "逗号列表里的 ETag 也要命中");

        handle.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn head_has_length_but_no_body() {
        let dir = fixture_dir();
        let handle = start_with_port(0, dir.clone()).await.unwrap();
        let port = handle.addr.port();

        let (status, headers, body) = request(
            port,
            &format!("127.0.0.1:{port}"),
            "/index.html",
            &[(":head", "")],
        )
        .await;
        assert_eq!(status, 200);
        assert!(body.is_empty(), "HEAD 不应带实体");
        assert_eq!(
            header_of(&headers, "content-length").as_deref(),
            Some("<html>MINERADIO-FIXTURE</html>".len().to_string().as_str()),
            "HEAD 的 Content-Length 必须是实体长度"
        );

        handle.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rejects_bad_host_and_guards_internal_token() {
        let dir = fixture_dir();
        let handle = start_with_port(0, dir.clone()).await.unwrap();
        let port = handle.addr.port();
        let good_host = format!("127.0.0.1:{port}");

        let (status, _, _) = request(port, &good_host, "/", &[]).await;
        assert_eq!(status, 200);

        // 换 Host：本机网页想借 DNS rebinding 打进来时挡在门口
        let (status, _, _) = request(port, "evil.example:1234", "/", &[]).await;
        assert_eq!(status, 403, "Host 不符应 403");

        // 跨站请求
        let (status, _, _) = request(
            port,
            &good_host,
            "/api/search",
            &[("sec-fetch-site", "cross-site")],
        )
        .await;
        assert_eq!(status, 403, "跨站请求应 403");

        // /internal 必须带 token
        let (status, _, _) = request(port, &good_host, "/internal/ping", &[]).await;
        assert_eq!(status, 403, "无 token 应 403");
        let (status, _, body) = request(
            port,
            &good_host,
            "/internal/ping",
            &[("x-mineradio-token", &handle.token)],
        )
        .await;
        assert_eq!(status, 200, "带 token 应 200");
        assert!(String::from_utf8_lossy(&body).contains("\"ok\":true"));
        let (status, _, _) = request(
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
    async fn missing_static_file_is_404_and_traversal_is_refused() {
        let dir = fixture_dir();
        let handle = start_with_port(0, dir.clone()).await.unwrap();
        let port = handle.addr.port();
        let host = format!("127.0.0.1:{port}");

        let (status, _, body) = request(port, &host, "/nope.js", &[]).await;
        assert_eq!(status, 404, "不存在的静态文件必须 404");
        assert_eq!(String::from_utf8_lossy(&body), "Not Found");

        // `public/` 的兄弟目录里放一个"机密"文件，确认 `..` 拿不到它
        let secret = dir
            .parent()
            .unwrap()
            .join(format!("mineradio-secret-{}.txt", std::process::id()));
        std::fs::write(&secret, b"TOP-SECRET").unwrap();
        let name = secret.file_name().unwrap().to_str().unwrap().to_string();
        let (status, _, body) = request(port, &host, &format!("/../{name}"), &[]).await;
        assert_eq!(status, 404, "路径穿越必须 404");
        assert!(!String::from_utf8_lossy(&body).contains("TOP-SECRET"));
        let _ = std::fs::remove_file(&secret);

        handle.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
