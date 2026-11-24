//! `at` 字段的时间格式：必须与 JS 的 `new Date().toISOString()` 逐字符一致，
//! 即 `2026-11-24T13:23:17.123Z`（UTC、毫秒三位、末尾 `Z`）。
//!
//! 为什么自己算而不引 `chrono` / `time`：整个 crate 只有这一处需要日期，
//! 而这两个库都会把依赖树撑大一圈。民用历反算用的是 Howard Hinnant 的
//! `civil_from_days`（与 `mineradio-server` 里拼 `Last-Modified` 的那段同源），
//! 它对 1970 前后、闰年、世纪闰都成立，测试里钉了几个已知时刻。

use std::time::{SystemTime, UNIX_EPOCH};

/// 把时刻格式化成 `1970-01-01T00:00:00.000Z`。
///
/// 时钟早于 Unix 纪元时（理论上只会在被手动改表的机器上出现）按纪元处理，
/// 不 panic —— 日志模块的第一条约束是"绝不抛错"。
pub fn iso8601_millis(at: SystemTime) -> String {
    let duration = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs() as i64;
    format_epoch_millis(secs, duration.subsec_millis())
}

/// 当前时刻的 ISO 8601 表示。
pub fn iso8601_now() -> String {
    iso8601_millis(SystemTime::now())
}

fn format_epoch_millis(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 天数（自 1970-01-01 起）→ (年, 月, 日)。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64, millis: u32) -> String {
        iso8601_millis(UNIX_EPOCH + Duration::new(secs, millis * 1_000_000))
    }

    #[test]
    fn matches_javascript_to_iso_string() {
        // 下面这些期望值可以用 `node -e "console.log(new Date(T).toISOString())"` 复核
        assert_eq!(at(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(at(1_700_000_000, 0), "2023-11-14T22:13:20.000Z");
        assert_eq!(at(1_700_000_000, 7), "2023-11-14T22:13:20.007Z");
        // 闰日 + 世纪闰（2000 是闰年，1900 不是）
        assert_eq!(at(951_782_400, 0), "2000-02-29T00:00:00.000Z");
        assert_eq!(at(1_735_689_599, 999), "2024-12-31T23:59:59.999Z");
        assert_eq!(at(1_735_689_600, 0), "2025-01-01T00:00:00.000Z");
    }

    #[test]
    fn always_three_millisecond_digits_and_utc_suffix() {
        let now = iso8601_now();
        assert_eq!(now.len(), 24, "长度必须与 toISOString() 相同：{now}");
        assert!(now.ends_with('Z'), "{now}");
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");
        assert_eq!(&now[19..20], ".");
    }

    #[test]
    fn pre_epoch_clock_does_not_panic() {
        let before = UNIX_EPOCH - Duration::from_secs(86_400);
        assert_eq!(iso8601_millis(before), "1970-01-01T00:00:00.000Z");
    }
}
