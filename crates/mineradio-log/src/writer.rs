//! 落盘：追加一行、按体积滚动一份 `.1`、**永不抛错**。
//!
//! 与 `desktop/logging.cjs` 的三处刻意差异：
//!
//! 1. **滚动是真滚动**。JS 版 `fs.renameSync(target, target + '.1')` 在 Windows 上
//!    不能覆盖已存在的 `.1`，失败后它退化成 `unlinkSync(target)` —— 也就是从第二次
//!    滚动起，最近的日志被整个删掉，`.1` 永远是第一次那份。这里先删 `.1` 再改名。
//! 2. 改名失败时（文件被别的进程占着）**不删日志**，只是本次不滚动、继续往原文件写，
//!    并记住"别每行都再试一遍"。丢功能可以，丢日志不行。
//! 3. 每次 append 都重新 open + close，不长期持有句柄：这样"写一行就落盘"是天然的，
//!    崩溃时最后一行不会卡在用户态缓冲里；滚动也不必先关句柄。

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// 与 JS 的 `DEFAULT_MAX_BYTES` 同值（512 KB）。
pub const DEFAULT_MAX_BYTES: u64 = 512 * 1024;

pub struct RotatingFile {
    /// `None` = 这条 logger 关掉了（名字非法 / 明确禁用），所有写入静默丢弃。
    target: Option<PathBuf>,
    max_bytes: u64,
    bytes: u64,
    ready: bool,
    broken: bool,
    /// 上一次改名失败：别每行都重试，但文件仍继续写。
    rotate_blocked: bool,
}

impl RotatingFile {
    pub fn new(target: PathBuf, max_bytes: u64) -> Self {
        Self {
            target: Some(target),
            max_bytes: if max_bytes == 0 {
                DEFAULT_MAX_BYTES
            } else {
                max_bytes
            },
            bytes: 0,
            ready: false,
            broken: false,
            rotate_blocked: false,
        }
    }

    /// 不落盘的文件（`min_level` 过滤之外的另一种"关掉"）。
    pub fn disabled() -> Self {
        Self {
            target: None,
            max_bytes: DEFAULT_MAX_BYTES,
            bytes: 0,
            ready: false,
            broken: true,
            rotate_blocked: false,
        }
    }

    pub fn path(&self) -> Option<&PathBuf> {
        self.target.as_ref()
    }

    pub fn is_broken(&self) -> bool {
        self.broken
    }

    /// 追加一行（必须自带换行）。任何错误都吞掉 —— 日志坏了不能影响主流程。
    pub fn append(&mut self, line: &str) {
        if self.broken || !self.ensure() {
            return;
        }
        if self.bytes > self.max_bytes && !self.rotate_blocked {
            self.rotate();
        }
        let Some(target) = self.target.as_ref() else {
            return;
        };
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(target) {
            if file.write_all(line.as_bytes()).is_ok() {
                self.bytes = self.bytes.saturating_add(line.len() as u64);
            }
        }
    }

    /// 无缓冲写入，恒成功；留着是为了让调用方不必知道实现细节。
    pub fn flush(&mut self) {}

    fn ensure(&mut self) -> bool {
        if self.ready || self.broken {
            return self.ready;
        }
        let Some(target) = self.target.clone() else {
            self.broken = true;
            return false;
        };
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() && fs::create_dir_all(parent).is_err() {
                self.broken = true;
                return false;
            }
        }
        self.bytes = fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
        if self.bytes > self.max_bytes {
            self.rotate();
        }
        self.ready = true;
        true
    }

    fn rotate(&mut self) {
        self.bytes = 0;
        let Some(target) = self.target.clone() else {
            return;
        };
        let rotated = rotated_path(&target);
        // 先删旧 `.1`：Windows 的 rename 不覆盖已存在文件，不删的话每次都失败。
        let _ = fs::remove_file(&rotated);
        if fs::rename(&target, &rotated).is_err() {
            // 改名失败通常是文件被占用。这里**不**像 JS 版那样把当前日志删掉：
            // 本次不滚动，接着往原文件写，只是记住别再每行都试一遍。
            self.rotate_blocked = true;
        }
    }
}

fn rotated_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(".1");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mineradio-log-unit-{}-{}-{}",
            tag,
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn appends_keep_order_and_content() {
        let dir = temp_dir("append");
        let path = dir.join("t.log");
        let mut file = RotatingFile::new(path.clone(), DEFAULT_MAX_BYTES);
        for i in 0..5 {
            file.append(&format!("line{i}\n"));
        }
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, "line0\nline1\nline2\nline3\nline4\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_replaces_the_previous_dot_one() {
        let dir = temp_dir("rotate");
        let path = dir.join("t.log");
        let mut file = RotatingFile::new(path.clone(), 20);
        file.append("aaaaaaaaaaaaaaaaaaaa\n"); // 21 字节 > 20
        file.append("bbbbbbbbbbbbbbbbbbbb\n"); // 本次先滚动，再写进新文件
        file.append("cccc\n");
        let rotated = fs::read_to_string(path.with_extension("log.1")).unwrap();
        let current = fs::read_to_string(&path).unwrap();
        // 只保留一份 .1，所以第三行写入时 aaaa 那段被 bbbb 顶掉了 ——
        // 这正是与 JS 版的区别：旧实现因为 rename 覆盖失败，.1 会永远停在 aaaa。
        assert!(rotated.contains("bbbb"), ".1 里应是上一段内容：{rotated}");
        assert!(
            !rotated.contains("aaaa"),
            ".1 必须被替换而不是残留：{rotated}"
        );
        assert!(current.contains("cccc"), "新内容应在当前文件：{current}");
        assert!(!current.contains("aaaa"), "当前文件必须从零开始");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_parent_directories() {
        let dir = temp_dir("nested");
        let path = dir.join("a").join("b").join("t.log");
        let mut file = RotatingFile::new(path.clone(), DEFAULT_MAX_BYTES);
        file.append("x\n");
        assert!(path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_target_is_silent() {
        let dir = temp_dir("broken");
        // 用一个普通文件当目录，create_dir_all 必失败
        let blocker = dir.join("blocker");
        fs::write(&blocker, b"x").unwrap();
        let mut file = RotatingFile::new(blocker.join("t.log"), DEFAULT_MAX_BYTES);
        file.append("nobody cares\n");
        assert!(file.is_broken(), "应被标记为坏掉，而不是重试");
        let _ = fs::remove_dir_all(&dir);
    }
}
