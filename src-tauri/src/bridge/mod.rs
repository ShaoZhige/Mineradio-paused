//! shim 的注入。`shim.js` 由 `scripts/gen-shim.js` 从 `docs/API-CONTRACT.json` 生成。

/// 生成的占位桥：116 个顶层键、130 个桥项，全部返回 `NOT_IMPLEMENTED`。
pub const SHIM_JS: &str = include_str!("shim.js");

const PORT_TOKEN: &str = "__MINERADIO_PORT__";
const RELEASE_TOKEN: &str = "__MINERADIO_SYSTEM_RELEASE__";

/// 把占位符换成真实值。`system_release` 由 `sysinfo::system_release()` 提供。
pub fn shim_for(port: u16, system_release: &str) -> String {
    let out = SHIM_JS
        .replace(PORT_TOKEN, &port.to_string())
        .replace(RELEASE_TOKEN, &js_escape(system_release));
    debug_assert!(!out.contains("__MINERADIO_"), "shim 里还有没替换掉的占位符");
    out
}

/// 版本串只会是 `10.0.19045` 这种，但仍然转义一次：它会被塞进 JS 字符串字面量。
fn js_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_every_placeholder() {
        let shim = shim_for(18765, "10.0.19045");
        assert!(!shim.contains(PORT_TOKEN));
        assert!(!shim.contains(RELEASE_TOKEN));
        assert!(shim.contains("var PORT = 18765;"), "端口没写进去");
        assert!(shim.contains("\"10.0.19045\""), "版本号没写进去");
    }

    #[test]
    fn shim_declares_every_top_level_method() {
        // 关键回归点：shim 漏一个方法不会报错，只会让前端静默变成 undefined。
        // 这里锁住几个"入口级"方法，其余数量由 npm run shim:check 对契约兜底。
        let shim = shim_for(1, "10.0.0.1");
        for required in [
            "isDesktop: true",
            "systemRelease: SYSTEM_RELEASE",
            "getState: function",
            "setLocale: function",
            "copyText: function",
            "onStateChange: function",
            "readCurrentFxAutosaveSync: function",
            "halo: {",
        ] {
            assert!(shim.contains(required), "shim 缺少 {required}");
        }
        // 占位桥不该暴露 invoke 之类的真通道（P3 才接）
        assert!(
            !shim.contains("__TAURI__"),
            "P1 的 shim 不应引用 tauri 注入对象"
        );
    }

    #[test]
    fn escapes_quotes_in_release_string() {
        assert_eq!(js_escape("a\"b"), "a\\\"b");
        assert_eq!(js_escape("10.0.1"), "10.0.1");
    }
}
