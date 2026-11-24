//! Mineradio 的出网底座。
//!
//! 目前只有两块，都是"后面每个 handler 都要用、越晚补越多地方要改"的东西：
//!
//! - [`cookies`]：把用户粘贴的任意形状收敛成一条 `Cookie:` 头。四个平台共用。
//! - [`ua`]：跨平台共用的 UA 常量。
//!
//! HTTP 客户端（超时语义、重试、错误形状）还没进来。它比这两块难 —— Node 的
//! `req.setTimeout` 是**连接空闲超时**（只要还在收数据就永不超时），而 `reqwest`
//! 的 `timeout()` 是**总超时**，两者对音频代理这种长连接的意义完全相反。等真正
//! 开始搬 handler 时单独一刀处理，并配本地服务器对拍。
//!
//! # 行为证明
//!
//! `cookies` 的每条规则都由 `tests/cookies_recorded.rs` 回放 JS 的真实输出
//! （录制器：`scripts/record-cookie-header.js`）。改实现前先看那里 —— 有些看起来
//! 多余的写法（`idx <= 0`、键值的 falsy 处理不对称、`Object.keys` 的下标键排序）
//! 都是为了让输出逐字节相同。

pub mod cookies;
pub mod ua;

pub use cookies::{normalize_cookie_header, raw_cookie_fallback, CookieInput};
pub use ua::DESKTOP_CHROME_UA;
