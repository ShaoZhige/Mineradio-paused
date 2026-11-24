//! UA 常量。
//!
//! 只收**跨平台共用**的那一个。各平台自己那份（`QISHUI_PC_APP_UA`、`KUGOU_H5_UA`、
//! `SPOTIFY_UA`…）留在各自的 handler 模块里 —— 它们跟具体接口的签名/风控一起变，
//! 抽到公共层反而会让"改一个平台影响全部"。

/// 桌面版 Chrome 的 UA，用于网易云、酷狗网页端这类需要"像浏览器"的请求。
///
/// 值必须与 `server/server.js` 的 `UA` 逐字一致（`server/kugou-api.js` 的
/// `KUGOU_HEADERS['User-Agent']` 也是同一个串）。它是**抓包那一刻**的浏览器版本，
/// 不是"越新越好"：网易云的接口会校验 UA 与 cookie 里其他指纹的自洽性，
/// 单方面抬高版本号反而可能被判异常。搬过来的意义是"不改"，不是"升级"。
pub const DESKTOP_CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
