//! `server/static-assets.js` 的 Rust 版：MIME 表、弱 ETag、`If-None-Match` 比对、路径解析。
//!
//! 移植动机见原文件的注释：`public/js` 下 142 个文件共 3.8 MB，Electron 时代每个请求都发
//! `no-store`，配上前端 `?v=<Date.now()>` 的缓存参数，等于每次启动都重新读盘、传输、解析编译。
//! 换成「ETag + 304」之后，没变过的文件渲染进程直接复用带 V8 编译缓存的副本。
//!
//! 与原实现的唯一**故意**差异是 [`resolve`]：Node 那边 `path.join(root, 'public', pn)` 对
//! `../` 是不设防的（`GET /../../package.json` 能读到仓库根的文件），这里直接拒绝含 `..`
//! 的路径。前端所有资源都是 `public/` 下的普通相对路径，不会走到这条分支。

use std::path::{Component, Path, PathBuf};

/// 扩展名 → `Content-Type`。**逐字节照抄** JS 那份表，包括 `.js` 用的是
/// `application/javascript`（而不是 `text/javascript`）——前端有地方按字符串判断过类型，
/// 换写法没有收益，只会给"行为一致"添一条要解释的差异。
pub const MIME_TABLE: &[(&str, &str)] = &[
    (".html", "text/html; charset=utf-8"),
    (".js", "application/javascript"),
    (".css", "text/css"),
    (".json", "application/json"),
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".webp", "image/webp"),
    (".ico", "image/x-icon"),
    (".svg", "image/svg+xml"),
    (".woff2", "font/woff2"),
    (".ttf", "font/ttf"),
    (".txt", "text/plain; charset=utf-8"),
];

/// 未知扩展名的兜底，与 JS 的 `MIME[ext] || 'text/plain'` 一致。
pub const DEFAULT_MIME: &str = "text/plain";

/// `path.extname()` 的等价实现（返回含点后缀；没有则返回空串）。
///
/// 不能用 `Path::extension()`：两者在边界上不同。JS 里 `.gitignore` 的 extname 是 `''`
/// 而 `foo.` 是 `'.'`，`Path::extension()` 前者给 `None`、后者给 `Some("")`。
pub fn js_extname(file_name: &str) -> &str {
    match file_name.rfind('.') {
        None => "",
        Some(0) => "",
        Some(i) => &file_name[i..],
    }
}

/// 按路径取 `Content-Type`。后缀大小写不敏感（JS 那边先 `toLowerCase()`）。
pub fn mime_for_path(path: &str) -> &'static str {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let ext = js_extname(base).to_ascii_lowercase();
    MIME_TABLE
        .iter()
        .find(|(k, _)| *k == ext)
        .map(|(_, v)| *v)
        .unwrap_or(DEFAULT_MIME)
}

/// 弱 ETag：`W/"<size 十六进制>-<mtime 毫秒向下取整的十六进制>"`。
///
/// 弱标记是有意的：只保证语义等价，不保证字节相同，所以不需要把文件内容哈希一遍。
/// 「毫秒级 mtime + size」足以区分本地文件的任何一次编辑，开发时按 F5 照旧拿到新内容。
pub fn etag_for(size: u64, mtime_ms: f64) -> String {
    // JS 是 `Math.floor(stat.mtimeMs).toString(16)`；对负数也是向下取整。
    let floored = mtime_ms.floor() as i64;
    format!("W/\"{size:x}-{:x}\"", floored.max(0) as u64)
}

/// `If-None-Match` 比对。
///
/// 允许是逗号分隔的列表（多级代理和缓存会拼接），逐个比较；比较是**区分大小写**的精确匹配，
/// 与 JS 的 `tag.trim() === etag` 一致——`w/"..."` 不匹配 `W/"..."`，`:contains` 之类的宽松
/// 判断会把 `W/"a"` 和 `W/"ab"` 混起来。
pub fn etag_matches(header_value: Option<&str>, etag: &str) -> bool {
    let Some(raw) = header_value else {
        return false;
    };
    if raw.is_empty() {
        return false;
    }
    raw.split(',').any(|tag| tag.trim() == etag)
}

/// 把 URL 路径映射到 `public/` 下的真实文件。
///
/// 返回 `None` 表示「不该读盘」：含 `..`、含盘符/根前缀、或路径为空。
pub fn resolve(public_dir: &Path, url_path: &str) -> Option<PathBuf> {
    // 与 Node 一致：`/` 映射到 index.html（不做目录列表）。
    let rel = if url_path == "/" || url_path.is_empty() {
        "index.html"
    } else {
        url_path.trim_start_matches('/')
    };

    let candidate = Path::new(rel);
    for comp in candidate.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            // 这一条是相对 Node 版的加固：`../` 一律不认。
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(public_dir.join(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_extname_matches_node_edge_cases() {
        assert_eq!(js_extname("index.html"), ".html");
        assert_eq!(js_extname("a.b.c"), ".c");
        assert_eq!(js_extname(".gitignore"), "");
        assert_eq!(js_extname("noext"), "");
        assert_eq!(js_extname("trailing."), ".");
    }

    #[test]
    fn mime_lookup_uses_the_js_table() {
        assert_eq!(mime_for_path("/js/main.js"), "application/javascript");
        assert_eq!(mime_for_path("a/b/C.JS"), "application/javascript");
        assert_eq!(mime_for_path("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            mime_for_path("vendor/jieba-dict.txt"),
            "text/plain; charset=utf-8"
        );
        // 表里没有的扩展名
        assert_eq!(mime_for_path("assets/x.bin"), "text/plain");
        assert_eq!(mime_for_path("noext"), "text/plain");
    }

    #[test]
    fn etag_matches_recorded_values() {
        // 这几条的期望值来自 rust-anything 对原 JS 的录制（ztest/ra-static-assets/cases.jsonl）
        assert_eq!(etag_for(0, 0.0), "W/\"0-0\"");
        assert_eq!(etag_for(255, 1.0), "W/\"ff-1\"");
        assert_eq!(
            etag_for(4096, 1_700_000_000_123.0),
            "W/\"1000-18bcfe5687b\""
        );
        assert_eq!(
            etag_for(182_287, 1_732_500_000_987.0),
            "W/\"2c80f-193610c10db\""
        );
        assert_eq!(
            etag_for(19_000_000, 1_700_000_000_999.9),
            "W/\"121eac0-18bcfe56be7\""
        );
    }

    #[test]
    fn etag_comparison_is_exact_and_list_aware() {
        assert!(etag_matches(Some("W/\"ff-1\""), "W/\"ff-1\""));
        assert!(!etag_matches(Some("W/\"ff-2\""), "W/\"ff-1\""));
        assert!(etag_matches(Some("W/\"a-1\", W/\"ff-1\""), "W/\"ff-1\""));
        assert!(etag_matches(Some("  W/\"ff-1\"  "), "W/\"ff-1\""));
        // 大小写敏感
        assert!(!etag_matches(Some("w/\"ff-1\""), "W/\"ff-1\""));
        // 强标记不等价于弱标记
        assert!(!etag_matches(Some("\"ff-1\""), "W/\"ff-1\""));
        // 空值 / 缺失
        assert!(!etag_matches(Some(""), "W/\"ff-1\""));
        assert!(!etag_matches(None, "W/\"ff-1\""));
        // `*` 在 If-None-Match 里语义特殊，但原实现当普通字符串比，这里保持一致
        assert!(!etag_matches(Some("*"), "W/\"ff-1\""));
    }

    #[test]
    fn resolve_maps_root_and_refuses_traversal() {
        let root = Path::new("C:/app/public");
        assert_eq!(resolve(root, "/"), Some(root.join("index.html")));
        assert_eq!(
            resolve(root, "/js/main.js"),
            Some(root.join("js").join("main.js"))
        );
        assert_eq!(
            resolve(root, "/../package.json"),
            None,
            "含 .. 的路径必须拒绝"
        );
        assert_eq!(resolve(root, "/a/../../b"), None);
        assert_eq!(resolve(root, "//etc/passwd"), Some(root.join("etc/passwd")));
    }
}
