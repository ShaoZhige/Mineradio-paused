//! 日志的 `scope`（子系统）。`docs/LOGGING.md` 第 1 节把它定为固定枚举，
//! 这里用 enum 而不是字符串，就是为了让"写错 scope"在编译期就报错。
//!
//! ⚠️ 文档第 1 节的清单漏了 `playlist`，但第 3 节的事件目录里有 `playlist`/`catalog-page-failed`。
//! 以**事件目录为准**补进枚举，并把文档一起改了 —— 否则照文档实现的人会把这几条日志
//! 记到 `queue` 或 `app` 下，事后 grep 不到。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    Playback,
    Queue,
    Lyric,
    Account,
    Source,
    Window,
    AppleMusic,
    App,
    Renderer,
    /// 见模块头部：文档漏了它，但事件目录里在用。
    Playlist,
}

impl Scope {
    pub const ALL: [Scope; 10] = [
        Scope::Playback,
        Scope::Queue,
        Scope::Lyric,
        Scope::Account,
        Scope::Source,
        Scope::Window,
        Scope::AppleMusic,
        Scope::App,
        Scope::Renderer,
        Scope::Playlist,
    ];

    /// 落盘字面量：小写连字符，与 JS 侧 `createLogger({ name })` 的 name 一一对应
    /// （`apple-music` 会写成 `userdata/apple-music.log`，名字不能改）。
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Playback => "playback",
            Scope::Queue => "queue",
            Scope::Lyric => "lyric",
            Scope::Account => "account",
            Scope::Source => "source",
            Scope::Window => "window",
            Scope::AppleMusic => "apple-music",
            Scope::App => "app",
            Scope::Renderer => "renderer",
            Scope::Playlist => "playlist",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        let lowered = name.trim().to_ascii_lowercase();
        Scope::ALL.into_iter().find(|s| s.as_str() == lowered)
    }
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scope_round_trips_and_is_lowercase_hyphen() {
        for scope in Scope::ALL {
            assert_eq!(Scope::from_name(scope.as_str()), Some(scope));
            assert!(
                scope
                    .as_str()
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '-'),
                "{scope} 的落盘字面量必须是纯小写连字符"
            );
        }
    }

    #[test]
    fn playlist_is_kept_even_though_the_doc_list_omits_it() {
        assert_eq!(Scope::from_name("playlist"), Some(Scope::Playlist));
    }
}
