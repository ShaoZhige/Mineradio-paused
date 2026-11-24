//! 项目级日志（Rust 侧）。
//!
//! 格式与 `desktop/logging.cjs` 逐字节对齐：**JSON Lines**，一行一个事件，
//! 字段顺序固定为 `{"at","level","scope","event",...}`，落在 `<dir>/<name>.log`，
//! 超过 512 KB 滚一份 `.1`。这样 `docs/LOGGING.md` 第 4 节那几条 `grep` 换了语言照样能用。
//!
//! # 三条设计约束（与 JS 版同源）
//!
//! 1. **绝不抛错**：目录不可写、磁盘满、文件名非法 —— 一律静默，标记坏了就不再试。
//! 2. **写入有序**：调用顺序 == 文件里的顺序。JS 版靠一条 Promise 队列，这里靠 `Mutex`。
//! 3. **可读**：`grep '"level":"error"'` 拿到的是整条事件，`jq` 能直接过滤字段。
//!
//! # 比 JS 版多的一层：脱敏红线
//!
//! `docs/LOGGING.md` 第 2 节写了"禁止写入 cookie / token / 密码 / 完整 URL / 绝对路径"，
//! 旧实现完全靠写日志的人自觉。这里在落盘前强制执行（见 [`redact`]）：
//! 敏感键名整值替换、URL 只留 origin、绝对路径只留文件名、JWT 与超长 blob 替换掉。
//!
//! # 用法
//!
//! ```
//! use mineradio_log::{Fields, Logger, Scope};
//!
//! // 真实场景里 dir 是 userdata/；这里用 disabled 免得文档测试往磁盘写东西。
//! let logger = Logger::disabled();
//! logger.error(
//!     "start-failed",
//!     Fields::new()
//!         .str("provider", "netease")
//!         .str("songId", "1234567")
//!         .num("elapsedMs", 1200)
//!         .str("error", "upstream-403"),
//! );
//! // 换成 `Logger::for_scope(Scope::Playback, dir)` 才会真的落到 playback.log
//! let _ = Scope::Playback;
//! ```
//!
//! # 与 JS 版的已知差异（都是往"更安全 / 更可查"方向偏）
//!
//! | 项 | JS | 这里 |
//! |---|---|---|
//! | 脱敏 | 只做长度/深度裁剪 | 再叠一层主动拦截 |
//! | 滚动 | 第二次起退化成删掉当前日志 | 真滚动，`.1` 是被替换的 |
//! | 字段顺序 | 插入顺序 | 字典序（`serde_json::Map` 默认 BTreeMap） |
//! | 保留键 | 调用方可以覆写 `at/level/scope/event` | 一律忽略，前缀字段说了算 |
//! | 事件名 | 原样落盘 | 归一化成小写连字符（`pageFailed` → `pagefailed`） |
//! | companion 日志 | 用 `type` 而不是 `event` | 统一成 `event`（旧字段名是历史遗留） |

mod level;
mod redact;
mod sanitize;
mod scope;
mod timestamp;
mod writer;

pub use level::Level;
pub use redact::{is_sensitive_key, redact_object, redact_string, redact_value, REDACTED};
pub use sanitize::{
    is_valid_key, sanitize, sanitize_object, truncate_chars, MAX_ARRAY_ITEMS, MAX_DEPTH, MAX_KEYS,
    MAX_KEY_CHARS, MAX_STRING_CHARS,
};
pub use scope::Scope;
pub use timestamp::{iso8601_millis, iso8601_now};
pub use writer::{RotatingFile, DEFAULT_MAX_BYTES};

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

/// 日志文件名里允许的字符数上限。
const MAX_NAME_CHARS: usize = 32;
/// `event` 字段的长度上限（超过就截断，不影响 grep）。
const MAX_EVENT_CHARS: usize = 48;

/// 一条日志的附加字段。
///
/// 每个 setter 都消耗 `self`，所以链式写法不产生临时变量：
/// `Fields::new().str("provider", p).bool("ok", false)`。
#[derive(Debug, Clone, Default)]
pub struct Fields(Map<String, Value>);

impl Fields {
    pub fn new() -> Self {
        Self(Map::new())
    }

    /// 字符串字段。
    pub fn str(mut self, key: &str, value: impl Into<String>) -> Self {
        self.0.insert(key.to_string(), Value::String(value.into()));
        self
    }

    /// 只在有值时才写入 —— 失败分支里"可能拿不到某个 id"很常见，别塞一堆 `null`。
    pub fn opt_str(mut self, key: &str, value: Option<impl Into<String>>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.to_string(), Value::String(value.into()));
        }
        self
    }

    /// 整数字段（耗时、数量、状态码）。
    pub fn num(mut self, key: &str, value: impl Into<i64>) -> Self {
        self.0.insert(key.to_string(), Value::from(value.into()));
        self
    }

    /// 浮点字段（毫秒平均值之类）。非有限值会被丢掉 —— JSON 里没有 NaN。
    pub fn float(mut self, key: &str, value: f64) -> Self {
        if let Some(number) = serde_json::Number::from_f64(value) {
            self.0.insert(key.to_string(), Value::Number(number));
        }
        self
    }

    /// 布尔字段。
    pub fn bool(mut self, key: &str, value: bool) -> Self {
        self.0.insert(key.to_string(), Value::Bool(value));
        self
    }

    /// 任意 JSON 值（嵌套对象、数组）。
    pub fn value(mut self, key: &str, value: Value) -> Self {
        self.0.insert(key.to_string(), value);
        self
    }

    /// 底层 map，日志实现内部用；也方便测试断言。
    pub fn as_map(&self) -> &Map<String, Value> {
        &self.0
    }

    /// 条目数（0 表示这条日志没有附加字段）。
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<Value> for Fields {
    /// `logger.warn("x", json!({ "a": 1 }))` 也能用；非对象值直接忽略。
    fn from(value: Value) -> Self {
        match value {
            Value::Object(map) => Self(map),
            _ => Self::new(),
        }
    }
}

/// 一条 logger 的配置。
#[derive(Debug, Clone)]
pub struct LogConfig {
    /// 文件名主干，同时也是 `scope` 的落盘值（`app` → `app.log`）。
    pub name: String,
    /// `userdata/` 所在目录。
    pub dir: PathBuf,
    /// 单文件上限，超过就滚一份 `.1`。
    pub max_bytes: u64,
    /// 低于这个级别的事件直接丢弃。
    pub min_level: Level,
    /// 同时打到 stderr（只在调试时开，发布版会把控制台当日志面板用）。
    pub mirror_console: bool,
}

impl LogConfig {
    pub fn new(name: impl Into<String>, dir: impl Into<PathBuf>) -> Self {
        Self {
            name: name.into(),
            dir: dir.into(),
            max_bytes: DEFAULT_MAX_BYTES,
            min_level: Level::Info,
            mirror_console: false,
        }
    }

    pub fn max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    pub fn min_level(mut self, min_level: Level) -> Self {
        self.min_level = min_level;
        self
    }

    pub fn mirror_console(mut self, mirror: bool) -> Self {
        self.mirror_console = mirror;
        self
    }
}

/// 一个子系统的日志出口。`Clone` 是廉价的（内部 `Arc`），可以随便往各个模块里塞。
#[derive(Clone)]
pub struct Logger {
    name: String,
    min_level: Level,
    mirror_console: bool,
    writer: Arc<Mutex<RotatingFile>>,
}

impl std::fmt::Debug for Logger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Logger")
            .field("name", &self.name)
            .field("min_level", &self.min_level)
            .field("path", &self.path())
            .finish()
    }
}

impl Logger {
    /// 按配置建一条 logger。文件名非法或目录不可写都不会报错，只会静默不写。
    pub fn with_config(config: LogConfig) -> Self {
        let writer = match target_path(&config.name, &config.dir) {
            Some(path) => RotatingFile::new(path, config.max_bytes),
            None => RotatingFile::disabled(),
        };
        Self {
            name: config.name,
            min_level: config.min_level,
            mirror_console: config.mirror_console,
            writer: Arc::new(Mutex::new(writer)),
        }
    }

    /// 最常用的构造：`Logger::for_scope(Scope::App, userdata_dir)`。
    pub fn for_scope(scope: Scope, dir: impl Into<PathBuf>) -> Self {
        Self::with_config(LogConfig::new(scope.as_str(), dir))
    }

    /// 自定义名字（测试、临时工具）。名字仍要过 [`is_valid_name`]。
    pub fn new(name: impl Into<String>, dir: impl Into<PathBuf>) -> Self {
        Self::with_config(LogConfig::new(name, dir))
    }

    /// 什么都不写（给单元测试或"用户关了日志"的场景）。
    pub fn disabled() -> Self {
        Self {
            name: "app".to_string(),
            min_level: Level::Error,
            mirror_console: false,
            writer: Arc::new(Mutex::new(RotatingFile::disabled())),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// 实际落盘路径（名字非法时为 `None`）。
    pub fn path(&self) -> Option<PathBuf> {
        self.writer
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .path()
            .cloned()
    }

    /// 写一条事件。`event` 会被归一化成小写连字符（见模块文档）。
    pub fn log(&self, level: Level, event: &str, fields: impl Into<Fields>) {
        if level < self.min_level {
            return;
        }
        let line = self.compose(level, event, fields.into());
        if self.mirror_console {
            eprintln!("{}", line.trim_end());
        }
        let mut writer = self
            .writer
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        writer.append(&line);
    }

    pub fn debug(&self, event: &str, fields: impl Into<Fields>) {
        self.log(Level::Debug, event, fields);
    }

    pub fn info(&self, event: &str, fields: impl Into<Fields>) {
        self.log(Level::Info, event, fields);
    }

    pub fn warn(&self, event: &str, fields: impl Into<Fields>) {
        self.log(Level::Warn, event, fields);
    }

    pub fn error(&self, event: &str, fields: impl Into<Fields>) {
        self.log(Level::Error, event, fields);
    }

    /// 等落盘。当前实现每行都是无缓冲写，这里只是为了让调用方不必关心实现。
    pub fn flush(&self) {
        self.writer
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .flush();
    }

    /// 拼一整行，含换行。
    fn compose(&self, level: Level, event: &str, fields: Fields) -> String {
        // 先裁剪再脱敏：裁剪会把深层折叠成 `[object]`、把串截到 400 字符，
        // 于是脱敏只需处理前两层，第 401 个字符之后的秘密也已经被截掉了。
        let sanitized = sanitize_object(fields.as_map());
        let redacted = redact_object(&sanitized);

        let mut line = String::with_capacity(192);
        line.push_str("{\"at\":\"");
        line.push_str(&iso8601_now());
        line.push_str("\",\"level\":\"");
        line.push_str(level.as_str());
        line.push_str("\",\"scope\":");
        // 名字在构造时已经过 `is_valid_name`（非法就直接不落盘），但这里仍然转义 ——
        // 万一将来放宽校验，也不会因为一个引号把整行 JSON 写坏。
        push_json_string(&mut line, &self.name);
        line.push_str(",\"event\":");
        push_json_string(&mut line, &normalize_event_name(event));
        for (key, value) in &redacted {
            // 这四个是前缀字段，调用方不能覆写（JS 版能，属于历史包袱）。
            if matches!(key.as_str(), "at" | "level" | "scope" | "event") {
                continue;
            }
            line.push_str(",\"");
            line.push_str(key);
            line.push_str("\":");
            line.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()));
        }
        line.push_str("}\n");
        line
    }
}

fn push_json_string(out: &mut String, value: &str) {
    match serde_json::to_string(value) {
        Ok(encoded) => out.push_str(&encoded),
        Err(_) => out.push_str("\"\""),
    }
}

fn target_path(name: &str, dir: &Path) -> Option<PathBuf> {
    if !is_valid_name(name) {
        return None;
    }
    Some(dir.join(format!("{name}.log")))
}

/// 文件名主干校验：避免 `../x` 之类的名字把日志写到别处。
fn is_valid_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_CHARS || name.starts_with('.') {
        return false;
    }
    name.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && !name.contains("..")
}

/// 事件名归一化：小写、只留 `[a-z0-9-]`、合并连续连字符、去掉首尾连字符。
///
/// 空串退化成 `event`（JS 版是 `String(type || 'event')`，同样兜到 `event`）。
pub fn normalize_event_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_EVENT_CHARS));
    let mut last_was_dash = true; // 置 true 顺手把首部连字符吃掉
    for ch in raw.chars() {
        if out.chars().count() >= MAX_EVENT_CHARS {
            break;
        }
        let lowered = ch.to_ascii_lowercase();
        if lowered.is_ascii_alphanumeric() {
            out.push(lowered);
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "event".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_guarded_against_path_escapes() {
        assert!(is_valid_name("app"));
        assert!(is_valid_name("apple-music"));
        assert!(!is_valid_name("../etc/passwd"));
        assert!(!is_valid_name("a/b"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name(".hidden"));
        assert!(!is_valid_name("x".repeat(MAX_NAME_CHARS + 1).as_str()));
    }

    #[test]
    fn event_names_are_normalized_to_lowercase_hyphens() {
        assert_eq!(normalize_event_name("start-failed"), "start-failed");
        assert_eq!(normalize_event_name("pageFailed"), "pagefailed");
        assert_eq!(normalize_event_name("am_start_retry"), "am-start-retry");
        assert_eq!(normalize_event_name("  --a--b--  "), "a-b");
        assert_eq!(normalize_event_name(""), "event");
        assert_eq!(normalize_event_name("状态"), "event");
        assert_eq!(normalize_event_name(&"x".repeat(80)).len(), MAX_EVENT_CHARS);
    }

    #[test]
    fn fields_builders_compose() {
        let fields = Fields::new()
            .str("provider", "netease")
            .opt_str("songId", None::<&str>)
            .opt_str("catalogId", Some("42"))
            .num("elapsedMs", 1200)
            .float("ratio", 0.5)
            .bool("ok", false);
        assert_eq!(fields.len(), 5);
        assert!(!fields.as_map().contains_key("songId"));
        assert_eq!(fields.as_map()["catalogId"], serde_json::json!("42"));
    }

    #[test]
    fn non_finite_floats_are_dropped() {
        let fields = Fields::new().float("x", f64::NAN);
        assert!(fields.is_empty(), "JSON 没有 NaN，应直接丢掉这个字段");
    }
}
