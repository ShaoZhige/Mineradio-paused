//! 行为测试：这些用例是 `tests/logging.test.js` 的对应物，外加脱敏红线那几条。
//!
//! 顺序、滚动、级别过滤三条是"换语言也不能变"的语义；脱敏那几条是 Rust 侧新增的
//! 硬约束 —— 旧实现只靠写日志的人自觉。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;

use mineradio_log::{Fields, Level, LogConfig, Logger, Scope, DEFAULT_MAX_BYTES};
use serde_json::Value;

fn temp_dir(tag: &str) -> PathBuf {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "mineradio-log-test-{}-{}-{}",
        tag,
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn read_entries(path: &PathBuf) -> Vec<Value> {
    let text = fs::read_to_string(path).expect("日志文件应存在");
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_str(line).unwrap_or_else(|err| panic!("不是合法 JSON：{line} / {err}"))
        })
        .collect()
}

#[test]
fn writes_follow_call_order() {
    let dir = temp_dir("order");
    let logger = Logger::new("t", &dir);
    for i in 0..200 {
        logger.info("tick", Fields::new().num("i", i));
    }
    logger.flush();
    let entries = read_entries(&logger.path().unwrap());
    assert_eq!(entries.len(), 200, "一行一个事件，不多不少");
    let actual: Vec<i64> = entries
        .iter()
        .map(|entry| entry["i"].as_i64().unwrap())
        .collect();
    let expected: Vec<i64> = (0..200).collect();
    assert_eq!(actual, expected, "顺序必须与调用顺序一致");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_writers_stay_parseable_and_ordered_per_thread() {
    let dir = temp_dir("concurrent");
    let logger = Logger::new("t", &dir);
    let mut handles = Vec::new();
    for worker in 0..4 {
        let logger = logger.clone();
        handles.push(thread::spawn(move || {
            for seq in 0..50 {
                logger.warn("tick", Fields::new().num("worker", worker).num("seq", seq));
            }
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    let entries = read_entries(&logger.path().unwrap());
    assert_eq!(entries.len(), 200, "并发写不能丢行、不能写坏行");
    // 同一线程内的相对顺序必须保持（跨线程可以交错）
    let mut last_seen = [None::<i64>; 4];
    for entry in &entries {
        let worker = entry["worker"].as_i64().unwrap() as usize;
        let seq = entry["seq"].as_i64().unwrap();
        if let Some(previous) = last_seen[worker] {
            assert!(seq > previous, "worker {worker} 的顺序被搅乱了");
        }
        last_seen[worker] = Some(seq);
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn rotation_keeps_one_previous_file_and_starts_fresh() {
    let dir = temp_dir("rotate");
    let logger = Logger::with_config(LogConfig::new("r", &dir).max_bytes(400));
    logger.info("fill", Fields::new().str("blob", "x".repeat(300)));
    logger.info("fill", Fields::new().str("blob", "y".repeat(300)));
    logger.info("after-rotate", Fields::new().bool("ok", true));
    logger.flush();

    let path = logger.path().unwrap();
    let mut rotated = path.clone().into_os_string();
    rotated.push(".1");
    let rotated = PathBuf::from(rotated);
    assert!(rotated.exists(), "超过上限要滚一份 .1");

    let current = read_entries(&path);
    assert!(
        current.iter().any(|entry| entry["event"] == "after-rotate"),
        "滚动后新文件继续写"
    );
    let previous = read_entries(&rotated);
    assert!(
        previous.iter().any(|entry| entry["event"] == "fill"),
        ".1 里应是滚动前的内容"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn debug_is_dropped_at_info_level() {
    let dir = temp_dir("level");
    let logger = Logger::for_scope(Scope::App, &dir);
    logger.debug("quiet", Fields::new());
    logger.warn("loud", Fields::new());
    let entries = read_entries(&logger.path().unwrap());
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["event"], "loud");
    assert_eq!(entries[0]["level"], "warn");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn line_prefix_matches_the_documented_shape() {
    let dir = temp_dir("shape");
    let logger = Logger::for_scope(Scope::AppleMusic, &dir);
    logger.error(
        "request",
        Fields::new().str("operation", "playSong").bool("ok", false),
    );
    let raw = fs::read_to_string(logger.path().unwrap()).unwrap();
    let line = raw.lines().next().unwrap();
    assert!(
        line.starts_with("{\"at\":\"20"),
        "at 必须是第一个键：{line}"
    );
    assert!(line.contains("\"level\":\"error\""));
    assert!(line.contains("\"scope\":\"apple-music\""));
    assert!(line.contains("\"event\":\"request\""));
    assert!(line.ends_with('}'), "一行必须是完整对象：{line}");

    let entry = read_entries(&logger.path().unwrap()).remove(0);
    let at = entry["at"].as_str().unwrap();
    assert_eq!(at.len(), 24, "at 要与 toISOString() 同形：{at}");
    assert!(at.ends_with('Z'));
    assert_eq!(
        logger.path().unwrap().file_name().unwrap(),
        "apple-music.log"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn reserved_prefix_keys_cannot_be_overridden() {
    let dir = temp_dir("reserved");
    let logger = Logger::new("t", &dir);
    logger.warn(
        "real-event",
        Fields::new()
            .str("at", "1999-01-01T00:00:00.000Z")
            .str("level", "info")
            .str("scope", "bogus")
            .str("event", "fake-event")
            .str("ok", "fine"),
    );
    let entry = read_entries(&logger.path().unwrap()).remove(0);
    assert_eq!(entry["level"], "warn");
    assert_eq!(entry["scope"], "t");
    assert_eq!(entry["event"], "real-event");
    assert_ne!(entry["at"], "1999-01-01T00:00:00.000Z");
    assert_eq!(entry["ok"], "fine");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn oversized_and_deep_payloads_are_clipped() {
    let dir = temp_dir("clip");
    let logger = Logger::new("t", &dir);
    logger.warn(
        "big",
        Fields::new()
            .str("message", "x".repeat(900))
            .value(
                "nested",
                serde_json::json!({ "a": { "b": { "c": "deep" } } }),
            )
            .value(
                "list",
                serde_json::json!(vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]),
            ),
    );
    let entry = read_entries(&logger.path().unwrap()).remove(0);
    let message = entry["message"].as_str().unwrap();
    assert!(message.chars().count() <= 401, "长字符串要截断");
    // nested 本身就在第 1 层，它的 a 落在第 2 层 → 折叠
    assert_eq!(entry["nested"], serde_json::json!({ "a": "[object]" }));
    assert_eq!(entry["list"].as_array().unwrap().len(), 12);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn bad_keys_are_dropped() {
    let dir = temp_dir("badkeys");
    let logger = Logger::new("t", &dir);
    logger.info(
        "k",
        Fields::new()
            .str("good.key-1", "a")
            .str("bad key!", "b")
            .str("表情", "c"),
    );
    let entry = read_entries(&logger.path().unwrap()).remove(0);
    assert_eq!(entry["good.key-1"], "a");
    assert!(entry.get("bad key!").is_none());
    assert!(entry.get("表情").is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn red_lines_are_enforced_end_to_end() {
    let dir = temp_dir("redact");
    let logger = Logger::new("t", &dir);
    logger.error(
        "login-failed",
        Fields::new()
            .str("cookie", "MUSIC_U=abcdef; __csrf=1")
            .str("accessToken", "abc123")
            .str(
                "url",
                "https://music.163.com/api/login?phone=13800000000&token=zzz",
            )
            .str("file", r"C:\Users\shao\AppData\Roaming\Mineradio\app.log")
            .str(
                "message",
                "open 'D:\\Mineradio\\userdata\\renderer.log' failed",
            )
            .str("provider", "netease"),
    );
    let entry = read_entries(&logger.path().unwrap()).remove(0);
    assert_eq!(entry["cookie"], "[redacted]");
    assert_eq!(entry["accessToken"], "[redacted]");
    assert_eq!(entry["url"], "https://music.163.com/…");
    assert_eq!(entry["file"], r"…\app.log");
    assert_eq!(entry["message"], r"open '…\renderer.log' failed");
    assert_eq!(entry["provider"], "netease", "无关字段必须原样保留");

    let raw = fs::read_to_string(logger.path().unwrap()).unwrap();
    for secret in [
        "MUSIC_U",
        "13800000000",
        "shao",
        "Mineradio\\userdata",
        "abc123",
    ] {
        assert!(!raw.contains(secret), "日志里不该出现 {secret}：{raw}");
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unwritable_target_never_panics() {
    let dir = temp_dir("unwritable");
    let blocker = dir.join("blocker");
    fs::write(&blocker, b"x").unwrap();
    let logger = Logger::new("app", blocker.join("nested"));
    logger.error("boom", Fields::new().num("a", 1));
    logger.info("again", Fields::new());
    logger.flush();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn invalid_name_disables_the_logger_instead_of_escaping() {
    let dir = temp_dir("escape");
    let logger = Logger::new("../escape", &dir);
    assert_eq!(logger.path(), None, "非法名字不该指向任何文件");
    logger.error("boom", Fields::new());
    assert!(!dir.join("..").join("escape.log").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn disabled_logger_writes_nothing_anywhere() {
    let logger = Logger::disabled();
    logger.error("boom", Fields::new().str("a", "b"));
    logger.flush();
    assert_eq!(logger.path(), None);
}

#[test]
fn default_budget_matches_the_documented_512kb() {
    assert_eq!(DEFAULT_MAX_BYTES, 512 * 1024);
    assert_eq!(Level::default(), Level::Info, "默认级别是 info");
}
