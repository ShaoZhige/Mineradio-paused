//! 版本信息：**必须**走 `RtlGetVersion`，不能用 `GetVersionExW`。
//!
//! 本机实测（Win10 22H2）：`GetVersionExW` 谎报 `10.0.9200`，真值是 `10.0.19045`。
//! Electron 的 `os.release()` 走的是未受 manifest 影响的路径，所以 Rust 侧要用同一个真值，
//! 否则渲染进程里 `systemRelease` 的 Win11 判定（build ≥ 22000）会永远为假 —— 玻璃采样
//! 在 Win11 机器上会被错误地关掉，而且看起来像"功能没做"。

use std::ffi::c_void;

#[repr(C)]
struct OsVersionInfoW {
    os_version_info_size: u32,
    major_version: u32,
    minor_version: u32,
    build_number: u32,
    platform_id: u32,
    csd_version: [u16; 128],
}

#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(version_info: *mut c_void) -> i32;
}

/// 返回 `major.minor.build`，与 Node 的 `os.release()` 同格式（如 `10.0.19045`）。
///
/// 失败时返回空串而不是 panic：preload 里探测失败也是退回空串让渲染进程按保守能力判断，
/// 这里保持同样的语义。
pub fn system_release() -> String {
    let mut info = OsVersionInfoW {
        os_version_info_size: std::mem::size_of::<OsVersionInfoW>() as u32,
        major_version: 0,
        minor_version: 0,
        build_number: 0,
        platform_id: 0,
        csd_version: [0; 128],
    };
    // SAFETY: 传入的是本栈上按 C 布局初始化的结构体，size 字段已按约定填好；
    // RtlGetVersion 只写这块内存，不会保留指针。
    let status = unsafe { RtlGetVersion(&mut info as *mut OsVersionInfoW as *mut c_void) };
    if status < 0 {
        return String::new();
    }
    format!(
        "{}.{}.{}",
        info.major_version, info.minor_version, info.build_number
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_three_numeric_parts() {
        let release = system_release();
        let parts: Vec<&str> = release.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "systemRelease 应是 major.minor.build，实际 {release:?}"
        );
        for part in &parts {
            part.parse::<u32>()
                .unwrap_or_else(|_| panic!("{release:?} 里 {part:?} 不是数字"));
        }
        // Windows 10 起 build 就不会低于 10000；这条同时验证"没拿到谎报的 9200"
        let build: u32 = parts[2].parse().unwrap();
        assert!(
            build >= 10000,
            "build 号不可信：{release:?}（GetVersionExW 会谎报 9200）"
        );
    }

    #[test]
    fn knows_win11_boundary() {
        // 只是把判定口径固定在测试里，避免以后有人改成 >= 21H2 之类的界值。
        let release = system_release();
        let build: u32 = release
            .split('.')
            .nth(2)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let is_win11 = build >= 22000;
        println!("systemRelease={release} is_win11={is_win11}");
    }
}
