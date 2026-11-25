//! 出网请求 —— `server/server.js` 里 `requestText` / `requestJson` 的 Rust 移植。
//!
//! # 为什么每个 reqwest 选项都要显式关掉
//!
//! Node 的 `https.request` 是个**很原始**的客户端：不加 `Accept-Encoding`、不解压、
//! 不走代理、不协商 HTTP/2、body 一律按 UTF-8 解码。reqwest 的默认值几乎每一条都跟它
//! 相反，照默认用会得到"能跑但行为不同"的客户端，而且差异都在边上（压缩、代理、
//! 字符集），正常测试根本发现不了。所以这里把 feature 和 builder 都写死：
//!
//! | 项 | Node `https.request` | reqwest 默认 | 这里 |
//! |---|---|---|---|
//! | `Accept-Encoding` | 不发 | 不启 gzip 也不发 | 不启 gzip |
//! | 自动解压 | 不 | 启 gzip 才解 | **不启** |
//! | 代理 | 不读环境变量 / 系统设置 | 启 `system-proxy` 才读 | `.no_proxy()` |
//! | HTTP/2 协商 | 不发 ALPN | 发 | `native-tls-no-alpn` + 无 `http2` |
//! | body 解码 | 强制 UTF-8（坏字节 → U+FFFD） | 启 `charset` 才按 Content-Type 解 | `.bytes()` + `from_utf8_lossy` |
//! | 超时 | **socket 空闲**超时 | `timeout()` 是总超时 | `read_timeout` + `connect_timeout` |
//!
//! **超时那条是这一刀存在的主要理由。** `req.setTimeout(10000)` 只在 socket 上连续
//! 10 秒没有任何字节流动时才触发；一个每秒吐 100 KB、总共要传 3 分钟的音频流**永远
//! 不会超时**。换成 `reqwest` 的 `timeout()`（总时长），同一个流会在第 10 秒被斩断 ——
//! 表现是"下载到一半失败"，很难联想到超时配置。`read_timeout` 才是对应物：它管的是
//! "读完一个 chunk 到下一个 chunk 之间"的间隔。
//!
//! # 已知偏差
//!
//! 1. **默认带 `Accept: */*`**。reqwest 在用户没设 accept 时补这一行，Node 什么也不加。
//!    要真正"不发"得换 hyper 直接用，代价远大于收益；`scripts/http-parity.js` 会把
//!    两边服务器收到的头打出来，这条差异是显式记录的，不是偷偷吞掉。
//! 2. **网络错误的 `code` 对不上**。Node 抛的是 libuv 的 errno 字符串（`ECONNREFUSED`、
//!    `ENOTFOUND`、`ECONNRESET`），reqwest 底层是 hyper + schannel，不复现这些名字。
//!    这里只保留 [`HttpError::Network`] 的 `detail` 文本，**不要**把它当错误码用。
//!    `server.js` 里 `classifyUpdateError` 已经在按文本正则分类，搬过去时要照着改。
//! 3. **`Content-Length` 与实际不符时**两边报的错不同（见 `scripts/http-parity.js` 的
//!    `truncated` 用例），都属于"网络层故障"，上层都是同一个兜底分支。

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::Duration;

/// `requestText` 的默认超时：`opts.timeoutMs || 10000`。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// 一次请求的参数。字段刻意与 `requestText(targetUrl, opts, body)` 一一对应。
#[derive(Debug, Clone, Default)]
pub struct Request {
    /// HTTP 方法，默认 `GET`。
    pub method: Option<String>,
    /// 请求头。**按给定顺序发送**（个别平台会校验头的顺序，虽然罕见）。
    pub headers: Vec<(String, String)>,
    /// 请求体。`Some(空 vec)` 与 `None` 不同：前者会真的发一个零长的 body。
    pub body: Option<Vec<u8>>,
    /// 覆盖默认超时。对应 `opts.timeoutMs`。
    pub timeout: Option<Duration>,
}

impl Request {
    /// `GET` + 无 body。
    pub fn get() -> Self {
        Request::default()
    }

    /// 加一个请求头。
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// 设 body（`POST` 之类要自己再设 method）。
    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// 覆盖超时。
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// 覆盖方法。
    pub fn method(mut self, method: impl Into<String>) -> Self {
        self.method = Some(method.into());
        self
    }
}

/// 请求失败。变体对应 `requestText` 抛出的几种 `Error`。
#[derive(Debug, Clone)]
pub enum HttpError {
    /// `req.destroy(new Error('Request timeout'))` —— socket 空闲超过阈值。
    Timeout,
    /// 其他传输层失败（连接被拒、DNS、TLS、对端提前断开…）。
    ///
    /// `detail` 是给人看的文本，**不是**错误码。见模块头部的「已知偏差 2」。
    Network {
        /// reqwest 的完整错误链。
        detail: String,
    },
    /// 状态码 >= 400。**body 已经完整读完**才返回这个错误 —— 与 Node 一致
    /// （它是先 `end` 事件里拼完 chunks 再判 statusCode）。
    Status {
        /// HTTP 状态码。
        status: u16,
        /// 已读到的响应体（按 UTF-8 宽松解码）。
        body: String,
    },
    /// `JSON.parse` 失败。
    InvalidJson {
        /// 请求的 URL（错误消息里带它，方便定位是哪个接口返回了脏数据）。
        url: String,
        /// 解析器的原始报错。
        detail: String,
    },
    /// 客户端本身没法构建（TLS 后端初始化失败等）。正常不会出现。
    Client {
        /// 底层报错。
        detail: String,
    },
}

impl HttpError {
    /// 与 JS 侧 `err.message` 对应的文本。
    ///
    /// 搬 handler 时大量 `catch` 分支是在比对 message 或 `err.statusCode`，所以这个
    /// 对应关系必须稳定。
    pub fn message(&self) -> String {
        match self {
            HttpError::Timeout => "Request timeout".to_string(),
            HttpError::Network { detail } => detail.clone(),
            HttpError::Status { status, .. } => format!("HTTP {status}"),
            HttpError::InvalidJson { url, .. } => format!("Invalid JSON from {url}"),
            HttpError::Client { detail } => detail.clone(),
        }
    }

    /// 对应 JS 的 `err.statusCode`。只有 [`HttpError::Status`] 有。
    pub fn status_code(&self) -> Option<u16> {
        match self {
            HttpError::Status { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// 对应 JS 的 `err.body`。只有 [`HttpError::Status`] 有。
    pub fn body(&self) -> Option<&str> {
        match self {
            HttpError::Status { body, .. } => Some(body),
            _ => None,
        }
    }
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for HttpError {}

/// 按超时值缓存 `reqwest::Client`。
///
/// `read_timeout` 是 **Client 级**配置，没法单请求覆盖。而 `requestText` 的调用点里
/// 少数会传 `timeoutMs`（音频探测、更新检查），多数用默认值。所以按毫秒值分桶缓存：
/// 默认桶常驻，其余按需建。`reqwest::Client` 内部是 Arc，clone 只加引用计数。
pub struct HttpClient {
    default_timeout: Duration,
    clients: Mutex<HashMap<u64, reqwest::Client>>,
}

impl HttpClient {
    /// 用默认 10 秒超时构造。
    pub fn new() -> Result<Self, HttpError> {
        Self::with_default_timeout(DEFAULT_TIMEOUT)
    }

    /// 指定默认超时（对应 `opts.timeoutMs` 的缺省值）。
    pub fn with_default_timeout(default_timeout: Duration) -> Result<Self, HttpError> {
        let client = build_client(default_timeout)?;
        let mut clients = HashMap::new();
        clients.insert(millis(default_timeout), client);
        Ok(HttpClient {
            default_timeout,
            clients: Mutex::new(clients),
        })
    }

    fn client_for(&self, timeout: Duration) -> Result<reqwest::Client, HttpError> {
        let key = millis(timeout);
        // 锁只在这一小段里持有，绝不跨 await。
        {
            let clients = self.clients.lock().expect("client 缓存锁被毒化");
            if let Some(client) = clients.get(&key) {
                return Ok(client.clone());
            }
        }
        let client = build_client(timeout)?;
        let mut clients = self.clients.lock().expect("client 缓存锁被毒化");
        // 并发首用时可能已经有人建好了，用先到的那个。
        Ok(clients.entry(key).or_insert(client).clone())
    }

    fn timeout_of(&self, request: &Request) -> Duration {
        request.timeout.unwrap_or(self.default_timeout)
    }

    /// 取回响应体文本。对应 `requestText`。
    ///
    /// 状态码 >= 400 时返回 [`HttpError::Status`]（**body 已读完**），与 Node 一致。
    pub async fn request_text(&self, url: &str, request: &Request) -> Result<String, HttpError> {
        let timeout = self.timeout_of(request);
        let client = self.client_for(timeout)?;

        let method = match request.method.as_deref() {
            Some(raw) => {
                reqwest::Method::from_bytes(raw.to_uppercase().as_bytes()).map_err(|err| {
                    HttpError::Client {
                        detail: format!("非法的方法 {raw}：{err}"),
                    }
                })?
            }
            None => reqwest::Method::GET,
        };

        let mut builder = client.request(method, url);
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = &request.body {
            // Node 的 `req.write(body)` + `req.end()` 发的是 **chunked** —— 它不设
            // Content-Length（除非调用方自己设）。而 reqwest 对定长 body 会自动算出
            // Content-Length，服务器看到的东西就不一样了。
            //
            // 这不是吹毛求疵：老式 PHP / Java 网关对 chunked 的支持并不可靠，反过来
            // 也有只认 chunked 的。要让"服务器看到同一份请求"，就得包成未知长度的流。
            // 用户显式设了 Content-Length 时 reqwest 会照用，不会被这里覆盖。
            let bytes: Vec<u8> = body.clone();
            builder = builder.body(reqwest::Body::wrap_stream(futures_util::stream::once(
                async move { Ok::<Vec<u8>, std::io::Error>(bytes) },
            )));
        }

        // `send()` 覆盖"建连 → 发出请求 → 收到响应头"这一段。`read_timeout` 管不到
        // 这段（它只在读 body 时计时），但 Node 的 socket 空闲超时是全程有效的 ——
        // 一个连上来就不吭声的服务器，Node 会超时，纯靠 `read_timeout` 的客户端会一直等。
        //
        // 这里是**总时长**而不是空闲时长，但只覆盖到响应头为止（通常是毫秒级），
        // 与"body 一直有数据流动就永不超时"那个关键性质并不冲突。
        let response = match tokio::time::timeout(timeout, builder.send()).await {
            Ok(Ok(response)) => response,
            Ok(Err(err)) => return Err(map_transport_error(err)),
            Err(_) => return Err(HttpError::Timeout),
        };
        let status = response.status().as_u16();

        // 先读完整个 body 再判状态码 —— Node 是 `end` 事件里拼完 chunks 才看 statusCode，
        // 顺序反过来会让 5xx 的响应体丢失（而错误页正文常常就是排查线索）。
        //
        // 用 `.bytes()` 而不是 `.text()`：后者在启用 charset feature 时会按
        // Content-Type 里的 charset 解码，而 Node 一律按 UTF-8 解 —— 一个 `charset=gbk`
        // 的响应，两边会得到完全不同的字符串。
        let bytes = response.bytes().await.map_err(map_transport_error)?;
        let text = String::from_utf8_lossy(&bytes).into_owned();

        if status >= 400 {
            return Err(HttpError::Status { status, body: text });
        }
        Ok(text)
    }

    /// `requestText` + `JSON.parse`。对应 `requestJson`。
    pub async fn request_json(
        &self,
        url: &str,
        request: &Request,
    ) -> Result<serde_json::Value, HttpError> {
        let text = self.request_text(url, request).await?;
        serde_json::from_str(&text).map_err(|err| HttpError::InvalidJson {
            url: url.to_string(),
            detail: err.to_string(),
        })
    }
}

fn millis(timeout: Duration) -> u64 {
    // 亚毫秒的超时按 1ms 算，避免 0 被当成"没有超时"。
    timeout.as_millis().max(1) as u64
}

fn build_client(timeout: Duration) -> Result<reqwest::Client, HttpError> {
    reqwest::Client::builder()
        // `req.setTimeout(N)` 是 **socket 空闲**超时：只要还有字节在流动就重置。
        // `read_timeout` 管的就是这个；`timeout()` 是总时长，语义不同，不能用。
        //
        // 注意 `read_timeout` 只覆盖"读响应体"的间隙，**等待响应头**那段它管不到
        // （reqwest 没有单独的头超时 API）。那一段在 `request_text` 里用
        // `tokio::time::timeout` 包住 `send()` 补上 —— 两段合起来才等于 Node 的
        // "socket 上连续 N 秒没有字节流动"。
        .read_timeout(timeout)
        // 建连阶段同理，`read_timeout` 覆盖不到。
        .connect_timeout(timeout)
        // Node 的 https.request **不跟随重定向**：302 是原样交给调用方，由业务代码自己
        // 决定要不要跟（有的接口 302 到登录页，跟过去就变成"登录成功了但拿不到数据"）。
        // reqwest 默认跟最多 10 跳（且 GET 化、丢 body），必须关掉才是同一个东西。
        .redirect(reqwest::redirect::Policy::none())
        // Node 的 https.request 不读任何代理设置（环境变量、系统代理都不看）。
        // reqwest 只要启了 system-proxy 就会读 —— 本机恰好有 http_proxy 环境变量，
        // 不关掉的话所有请求都会被塞进代理，测试结果与线上完全不同。
        .no_proxy()
        // 不启用 cookie 存储：四个平台各自手动拼 Cookie 头（有的还要做归一化、
        // 有的要区分 session 与持久 cookie），交给 Client 管会互相污染。
        .build()
        .map_err(|err| HttpError::Client {
            detail: err.to_string(),
        })
}

fn map_transport_error(err: reqwest::Error) -> HttpError {
    if err.is_timeout() {
        return HttpError::Timeout;
    }
    // 保留完整错误链：`err` 的 Display 只有最外一层，`source()` 才是"连接被拒"之类
    // 的具体原因。日志与排查都靠它。
    let mut detail = err.to_string();
    let mut source = std::error::Error::source(&err);
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    HttpError::Network { detail }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages_match_the_js_shapes() {
        assert_eq!(HttpError::Timeout.message(), "Request timeout");
        assert_eq!(
            HttpError::Status {
                status: 404,
                body: "nope".into()
            }
            .message(),
            "HTTP 404"
        );
        assert_eq!(
            HttpError::InvalidJson {
                url: "https://example.com/api".into(),
                detail: "expected value".into()
            }
            .message(),
            "Invalid JSON from https://example.com/api"
        );
    }

    #[test]
    fn only_status_errors_carry_code_and_body() {
        let status = HttpError::Status {
            status: 500,
            body: "boom".into(),
        };
        assert_eq!(status.status_code(), Some(500));
        assert_eq!(status.body(), Some("boom"));

        assert_eq!(HttpError::Timeout.status_code(), None);
        assert_eq!(HttpError::Timeout.body(), None);
    }

    #[test]
    fn sub_millisecond_timeout_is_not_treated_as_zero() {
        assert_eq!(millis(Duration::from_micros(200)), 1);
        assert_eq!(millis(Duration::from_millis(10_000)), 10_000);
    }

    #[test]
    fn client_caches_by_timeout_bucket() {
        let client = HttpClient::new().expect("建 client 不该失败");
        let first = client.client_for(DEFAULT_TIMEOUT).expect("默认桶");
        let again = client.client_for(DEFAULT_TIMEOUT).expect("默认桶");
        let other = client
            .client_for(Duration::from_millis(1234))
            .expect("新桶");
        // reqwest::Client 是 Arc 包装，没有公开的指针比较手段；用"数量"证明缓存生效。
        assert_eq!(client.clients.lock().unwrap().len(), 2);
        let _ = (first, again, other);
    }
}
