//! Mineradio 的纯逻辑层：不碰窗口、不碰网络传输、不依赖 tauri。
//!
//! 放这里的判断标准是「给同样的输入必然给同样的输出」——这样它才能被单元测试、
//! 被 axum 直接调用、也能被 rust-anything 的录制回放验证。

pub mod apple_music_lyrics;
pub mod js;
pub mod qishui_decrypt;
pub mod qq_vip;
pub mod static_assets;
