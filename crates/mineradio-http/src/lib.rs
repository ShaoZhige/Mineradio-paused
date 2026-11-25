//! Mineradio 的出网底座。
//!
//! 三块，都是"后面每个 handler 都要用、越晚补越多地方要改"的东西：
//!
//! - [`cookies`]：把用户粘贴的任意形状收敛成一条 `Cookie:` 头。四个平台共用。
//! - [`ua`]：跨平台共用的 UA 常量。
//! - [`client`]：`requestText` / `requestJson` 的移植。**每个 reqwest 选项都显式关掉
//!   或改写**，因为它的默认值与 Node 的 `https.request` 几乎条条相反（压缩、代理、
//!   HTTP/2、字符集、超时语义）。差异清单在模块头部。
//!
//! # 行为证明
//!
//! `cookies` 的每条规则都由 `tests/cookies_recorded.rs` 回放 JS 的真实输出
//! （录制器：`scripts/record-cookie-header.js`）。改实现前先看那里 —— 有些看起来
//! 多余的写法（`idx <= 0`、键值的 falsy 处理不对称、`Object.keys` 的下标键排序）
//! 都是为了让输出逐字节相同。
//!
//! `client` 靠 `scripts/http-parity.js` 对照：同一条本地服务器、同一批用例，Node 用
//! 照抄的 `requestText` 跑一遍、Rust 用本 crate 跑一遍，比结果、比服务器实际收到的
//! 请求头。超时那条用例（慢速持续吐数据）是这个脚本存在的核心理由。

pub mod client;
pub mod cookies;
pub mod ua;

pub use client::{HttpClient, HttpError, Request, DEFAULT_TIMEOUT};
pub use cookies::{normalize_cookie_header, raw_cookie_fallback, CookieInput};
pub use ua::DESKTOP_CHROME_UA;
