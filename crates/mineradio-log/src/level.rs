//! 日志级别。与 `desktop/logging.cjs` 的 `LEVELS` 完全同值（10/20/30/40），
//! 只是 Rust 侧用 `Ord` 表达"够不够级别"，省掉一张查表。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum Level {
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

impl Level {
    /// 落盘用的字面量与 JS 一致（小写），grep `"level":"error"` 才靠得住。
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    /// 旧代码把级别写成字符串（`logger.event(..., 'warn')`），迁移时得能认回来。
    pub fn from_name(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "debug" => Some(Level::Debug),
            "info" => Some(Level::Info),
            "warn" | "warning" => Some(Level::Warn),
            "error" | "err" => Some(Level::Error),
            _ => None,
        }
    }
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_matches_the_documented_ladder() {
        assert!(Level::Debug < Level::Info);
        assert!(Level::Info < Level::Warn);
        assert!(Level::Warn < Level::Error);
    }

    #[test]
    fn names_round_trip() {
        for level in [Level::Debug, Level::Info, Level::Warn, Level::Error] {
            assert_eq!(Level::from_name(level.as_str()), Some(level));
        }
        assert_eq!(Level::from_name("WARN"), Some(Level::Warn));
        assert_eq!(Level::from_name("nonsense"), None);
    }
}
