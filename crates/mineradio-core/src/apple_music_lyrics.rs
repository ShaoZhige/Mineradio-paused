//! `server/apple-music-lyrics.js` 的 Rust 移植：TTML → 行级 LRC + 逐字 YRC。
//!
//! Apple Music 的歌词来自 companion 的 `.../songs/<id>/syllable-lyrics`，是 TTML。
//! 这里**只做格式转换**，输出的仍是前端既有解析器认识的两种文本，不引入第三种歌词格式。
//!
//! 一致性的判定依据是 `tests/fixtures/apple-music-lyrics-cases.jsonl`
//! （用 rust-anything 跑原 JS 录下来的 25 条输出），不是"看起来对"。
//!
//! # 与 JS 版的逐点对齐（改代码前先读这一节）
//!
//! 1. **`\s` 用显式字符类 [`JS_WS`]，不用 `\s`**：JS 的 `\s` 含 `U+FEFF` 但不含 `U+0085`，
//!    Rust `regex` 的 `\s`（Unicode `White_Space`）正好反过来。差这两处会改变空白折叠结果。
//! 2. **`\d` 写成 `[0-9]`**：Rust `regex` 的 `\d` 认全 Unicode 数字（阿拉伯-印度数字等），
//!    JS 的 `\d` 只有 ASCII。
//! 3. **`[\s\S]*?` 换成 `(?s).*?`**：Rust `regex` 里 `.` 默认不跨行，`(?s)` 才等于 JS 的 `[\s\S]`。
//! 4. **`.length` 一律按 UTF-16 码元算**（[`js_len`]）：JS 的字符串长度是码元数，
//!    按 `chars()` 算会让含增补平面字符的行拿到不一样的估算时长。
//! 5. **`Math.round` 用 [`js_round`]**：`f64::round` 是"远离零"，JS 是"向 +∞ 取半"。
//!    两者只在负数上分道扬镳，而这里的值理论非负 —— 但估算时长那几处一旦算出负数就会露馅，
//!    所以照 JS 实现，别用 `round()`。
//! 6. **`decode_ttml_entities` 的替换顺序不能动**：`&amp;` 必须最后解，
//!    否则 `&amp;lt;` 会先变成 `<` 再被当标签吃掉。
//!
//! # 已知的、刻意接受的偏差
//!
//! - 数字实体落在 UTF-16 代理区（`&#55296;`–`&#57343;`）：JS 会产出一个孤立代理，
//!   Rust 的 `char` 表示不了，这里保留原样的 `&#...;` 字面量。真实 TTML 里不会出现。
//! - `Number(text)` 的宽松写法（`0x10`、`Infinity`）不完整支持：只认十进制/科学计数，
//!   认不出来就当 `None`。TTML 的裸秒数只会是十进制。

use std::sync::LazyLock;

use regex::Regex;

/// 与 companion 的 2 MB 上限对齐：就算上游被换掉，解析端也不会吃掉一份巨大的字符串。
const MAX_TTML_LENGTH: usize = 2 * 1024 * 1024;
const MAX_LINES: usize = 4000;
const MAX_SPANS_PER_LINE: usize = 400;

/// JS 的 `\s` 字符集。见模块头部第 1 条。
const JS_WS: &str = r"[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

/// `JS_WS` 的字符级判定，给 `starts_with` 用（正则字符类没法直接问"这个字符算不算"）。
fn is_js_ws(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
            | '\u{2000}'..='\u{200A}'
    )
}

/// TTML → 两段文本的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct AppleLyric {
    /// 行级 LRC。永远有值（前端拿不到逐字时还有东西可显示）。
    pub lyric: String,
    /// 逐字 YRC。只有真的存在逐字时间时才是非空串。
    pub yrc: String,
    /// 原文声明的 `itunes:timing`；没声明时按有无逐字回落到 `Word` / `Line`。
    pub timing: String,
    /// 真正输出的行数（已剔除背景人声与空行）。
    pub line_count: usize,
}

#[derive(Debug, Clone)]
struct Word {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Clone)]
struct LyricLine {
    start: f64,
    end: f64,
    text: String,
    words: Vec<Word>,
    agent: String,
}

static LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<p\b([^>]*)>(.*?)</p>").expect("内置正则必须能编译"));
static SPAN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<span\b([^>]*)>(.*?)</span>").expect("内置正则必须能编译"));
static RT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<rt\b.*?</rt>").expect("内置正则必须能编译"));
static RP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<rp\b.*?</rp>").expect("内置正则必须能编译"));
static BR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)<br{JS_WS}*/?>")).expect("内置正则必须能编译"));
static TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^>]*>").expect("内置正则必须能编译"));
static WS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{JS_WS}+")).expect("内置正则必须能编译"));
static TIMING_ATTR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#"(?i)itunes:timing{JS_WS}*={JS_WS}*"([^"]*)""#))
        .expect("内置正则必须能编译")
});
static HOURS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]+):([0-9]{1,2}):([0-9]{1,2}(?:\.[0-9]+)?)$").expect("内置正则必须能编译")
});
static MINUTES_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{1,2}):([0-9]{1,2}(?:\.[0-9]+)?)$").expect("内置正则必须能编译")
});
static DECIMAL_ENTITY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&#([0-9]+);").expect("内置正则必须能编译"));
static HEX_ENTITY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&#x([0-9a-fA-F]+);").expect("内置正则必须能编译"));

/// 只用到这四个属性，所以用枚举而不是"传字符串现编译正则"——
/// 后者每个 span 要编译四次正则，而且传错名字会静默返回空串。
#[derive(Debug, Clone, Copy)]
enum Attr {
    Begin,
    End,
    Role,
    Agent,
}

impl Attr {
    fn pattern(self) -> &'static LazyLock<Regex> {
        static BEGIN: LazyLock<Regex> = LazyLock::new(|| attr_pattern("begin"));
        static END: LazyLock<Regex> = LazyLock::new(|| attr_pattern("end"));
        static ROLE: LazyLock<Regex> = LazyLock::new(|| attr_pattern("ttm:role"));
        static AGENT: LazyLock<Regex> = LazyLock::new(|| attr_pattern("ttm:agent"));
        match self {
            Attr::Begin => &BEGIN,
            Attr::End => &END,
            Attr::Role => &ROLE,
            Attr::Agent => &AGENT,
        }
    }
}

fn attr_pattern(name: &str) -> Regex {
    Regex::new(&format!(
        r#"(?i)(?:^|{JS_WS}){}{JS_WS}*={JS_WS}*"([^"]*)""#,
        regex::escape(name)
    ))
    .expect("内置正则必须能编译")
}

/// 取属性值；缺失时返回空串（与 JS 版 `match ? match[1] : ''` 一致）。
fn ttml_attr(attrs: &str, name: Attr) -> String {
    match name.pattern().captures(attrs) {
        Some(caps) => caps[1].to_string(),
        None => String::new(),
    }
}

/// JS 的 `str.length`：UTF-16 码元数，不是字符数。
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JS 的 `Math.round`：向 +∞ 取半（`f64::round` 是远离零，负半整数上会差 1）。
fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `hh:mm:ss.SSS` / `mm:ss.SSS` / 纯秒，三种都要认。
fn ttml_seconds(raw: &str) -> Option<f64> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Some(caps) = HOURS_RE.captures(text) {
        let hours: f64 = caps[1].parse().ok()?;
        let minutes: f64 = caps[2].parse().ok()?;
        let seconds: f64 = caps[3].parse().ok()?;
        return Some(hours * 3600.0 + minutes * 60.0 + seconds);
    }
    if let Some(caps) = MINUTES_RE.captures(text) {
        let minutes: f64 = caps[1].parse().ok()?;
        let seconds: f64 = caps[2].parse().ok()?;
        return Some(minutes * 60.0 + seconds);
    }
    match text.parse::<f64>() {
        Ok(value) if value.is_finite() && value >= 0.0 => Some(value),
        _ => None,
    }
}

fn decode_ttml_entities(text: &str) -> String {
    // 顺序 = JS 版的顺序，别重排（详见模块头部第 6 条）。
    let after_decimal = DECIMAL_ENTITY_RE.replace_all(text, |caps: &regex::Captures| {
        let original = caps.get(0).map(|m| m.as_str()).unwrap_or_default();
        match caps[1].parse::<u32>() {
            Ok(code) if code > 0 && code <= 0x10ffff => decode_code_point(code, original),
            _ => original.to_string(),
        }
    });
    let after_hex = HEX_ENTITY_RE.replace_all(&after_decimal, |caps: &regex::Captures| {
        let original = caps.get(0).map(|m| m.as_str()).unwrap_or_default();
        match u32::from_str_radix(&caps[1], 16) {
            Ok(code) if code > 0 && code <= 0x10ffff => decode_code_point(code, original),
            _ => original.to_string(),
        }
    });
    after_hex
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        // `&amp;` 必须最后解：先解它，`&amp;lt;` 会被当成真正的 `<`，随后被当成标签吃掉。
        .replace("&amp;", "&")
}

/// 代理区/越界的码点保留字面量（见「已知偏差」）。
fn decode_code_point(code: u32, original: &str) -> String {
    match char::from_u32(code) {
        Some(ch) => ch.to_string(),
        None => original.to_string(),
    }
}

/// 去掉注音、括注、换行标签与所有标签，只留可见文字（保留首尾空白）。
fn ttml_plain_raw(fragment: &str) -> String {
    let stripped = RT_RE.replace_all(fragment, "");
    let stripped = RP_RE.replace_all(&stripped, "");
    let stripped = BR_RE.replace_all(&stripped, " ");
    let stripped = TAG_RE.replace_all(&stripped, "");
    let decoded = decode_ttml_entities(&stripped);
    WS_RE.replace_all(&decoded, " ").to_string()
}

fn is_background_role(attrs: &str) -> bool {
    let role = ttml_attr(attrs, Attr::Role).to_lowercase();
    matches!(role.as_str(), "x-bg" | "x-bg-vocal" | "background")
}

#[derive(Debug)]
enum Item {
    Text(String),
    Span {
        background: bool,
        text: String,
        start: Option<f64>,
        end: Option<f64>,
    },
}

fn read_ttml_items(body: &str) -> Vec<Item> {
    let mut items: Vec<Item> = Vec::new();
    let mut cursor = 0usize;
    for caps in SPAN_RE.captures_iter(body) {
        if items.len() >= MAX_SPANS_PER_LINE {
            break;
        }
        let whole = caps.get(0).expect("captures_iter 必有整体匹配");
        push_text(&mut items, &body[cursor..whole.start()]);
        cursor = whole.end();
        let attrs = &caps[1];
        items.push(Item::Span {
            background: is_background_role(attrs),
            text: ttml_plain_raw(&caps[2]).trim().to_string(),
            start: ttml_seconds(&ttml_attr(attrs, Attr::Begin)),
            end: ttml_seconds(&ttml_attr(attrs, Attr::End)),
        });
    }
    push_text(&mut items, &body[cursor..]);
    items
}

fn push_text(items: &mut Vec<Item>, raw: &str) {
    let text = ttml_plain_raw(raw);
    if !text.is_empty() {
        items.push(Item::Text(text));
    }
}

fn read_ttml_lines(ttml: &str) -> Vec<LyricLine> {
    let mut lines = Vec::new();
    for caps in LINE_RE.captures_iter(ttml) {
        if lines.len() >= MAX_LINES {
            break;
        }
        let attrs = &caps[1];
        let items = read_ttml_items(&caps[2]);
        // 背景人声与主唱同轨时混进同一行会把时间轴搅乱；单独成段时又常常只有一句和声。
        // 统一丢掉，主歌词才是播放时要跟着唱的那一轨。
        let kept: Vec<&Item> = items
            .iter()
            .filter(|item| match item {
                Item::Text(_) => true,
                Item::Span { background, .. } => !*background,
            })
            .collect();

        let mut text = String::new();
        let mut words: Vec<Word> = Vec::new();
        for (index, item) in kept.iter().enumerate() {
            match item {
                Item::Text(chunk) => text.push_str(chunk),
                Item::Span {
                    text: span_text,
                    start,
                    end,
                    ..
                } => {
                    if span_text.is_empty() {
                        continue;
                    }
                    text.push_str(span_text);
                    let Some(start) = *start else { continue };
                    let word_end = match *end {
                        Some(end) if end > start => end,
                        _ => start + (js_len(span_text) as f64 * 0.16).max(0.12),
                    };
                    // 词尾空格并进词里：YRC 的字符偏移按拼好的整行算，少了这个空格后面的词全会错位。
                    let trailing = match kept.get(index + 1) {
                        Some(Item::Text(chunk)) if chunk.starts_with(is_js_ws) => " ",
                        _ => "",
                    };
                    words.push(Word {
                        text: format!("{span_text}{trailing}"),
                        start,
                        end: word_end,
                    });
                }
            }
        }
        let text = WS_RE.replace_all(&text, " ").trim().to_string();
        if text.is_empty() {
            continue;
        }

        let mut start = ttml_seconds(&ttml_attr(attrs, Attr::Begin));
        let mut end = ttml_seconds(&ttml_attr(attrs, Attr::End));
        if let Some(first) = words.first() {
            if start.is_none() {
                start = Some(first.start);
            }
            let begin = start.expect("上面刚补过");
            if end.is_none_or(|e| e <= begin) {
                end = words.last().map(|w| w.end);
            }
        }
        let Some(start) = start else { continue };
        let end = match end {
            Some(end) if end > start => end,
            _ => start + (js_len(&text) as f64 * 0.34).max(0.8),
        };
        lines.push(LyricLine {
            start,
            end,
            text,
            words: if words.len() > 1 { words } else { Vec::new() },
            agent: ttml_attr(attrs, Attr::Agent).to_lowercase(),
        });
    }
    lines
}

fn lrc_timestamp(seconds: f64) -> String {
    // 先取整到百分之一秒再拆分秒，否则 59.996 会被写成 `[00:60.00]`。
    // `Math.round(x) || 0` 的 `|| 0` 是为了兜 NaN；x 非有限时下面 `max(0)` 之外还要防 NaN。
    let rounded = js_round(seconds * 100.0);
    let centis = if rounded.is_finite() {
        rounded.max(0.0)
    } else {
        0.0
    };
    let minutes = (centis / 6000.0).floor();
    let rest = centis - minutes * 6000.0;
    format!(
        "[{:0>2}:{:0>2}.{:0>2}]",
        minutes as i64,
        (rest / 100.0).floor() as i64,
        (rest % 100.0) as i64
    )
}

/// YRC 的词里不能出现小括号：解析器按 `(start,dur,tag)文本` 切分，括号会把后面的词吞掉。
fn yrc_word_text(text: &str) -> String {
    let mapped: String = text
        .chars()
        .map(|ch| match ch {
            '(' => '（',
            ')' => '）',
            other => other,
        })
        .collect();
    WS_RE.replace_all(&mapped, " ").to_string()
}

fn to_yrc_line(line: &LyricLine) -> String {
    let start_ms = js_round(line.start * 1000.0);
    let end_ms = js_round(line.end * 1000.0);
    let duration_ms = (end_ms - start_ms).max(1.0);
    let body: String = line
        .words
        .iter()
        .map(|word| {
            let word_start = js_round(word.start * 1000.0);
            let word_duration = js_round((word.end - word.start) * 1000.0).max(1.0);
            format!(
                "({},{},0){}",
                word_start as i64,
                word_duration as i64,
                yrc_word_text(&word.text)
            )
        })
        .collect();
    format!("[{},{}]{}", start_ms as i64, duration_ms as i64, body)
}

/// TTML → `{ lyric, yrc, timing, lineCount }`；没有任何可用歌词时返回 `None`。
///
/// `ttml` 为空串等价于 JS 侧传入非字符串（`typeof x === 'string' ? x : ''`）。
pub fn convert_apple_music_ttml_to_lyric(ttml: &str) -> Option<AppleLyric> {
    if ttml.is_empty() || js_len(ttml) > MAX_TTML_LENGTH {
        return None;
    }
    let mut lines = read_ttml_lines(ttml);
    lines.retain(|line| !line.text.is_empty());
    // JS 的 `Array.prototype.sort` 在 V8 里是稳定排序，`sort_by` 也是。
    lines.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.end
                    .partial_cmp(&b.end)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    if lines.is_empty() {
        return None;
    }

    // 主唱段落存在时再丢掉 `v2`：有些歌整首都标成 v2，一刀切会得到空歌词。
    let has_lead_agent = lines.iter().any(|line| line.agent == "v1");
    let kept: Vec<LyricLine> = if has_lead_agent {
        lines
            .into_iter()
            .filter(|line| line.agent != "v2")
            .collect()
    } else {
        lines
    };
    if kept.is_empty() {
        return None;
    }

    let lyric = kept
        .iter()
        .map(|line| format!("{}{}", lrc_timestamp(line.start), line.text))
        .collect::<Vec<_>>()
        .join("\n");
    let word_lines: Vec<&LyricLine> = kept.iter().filter(|line| !line.words.is_empty()).collect();
    let yrc = word_lines
        .iter()
        .map(|line| to_yrc_line(line))
        .collect::<Vec<_>>()
        .join("\n");

    let timing = match TIMING_ATTR_RE.captures(ttml) {
        Some(caps) if !caps[1].is_empty() => caps[1].to_string(),
        _ => {
            if yrc.is_empty() {
                "Line".to_string()
            } else {
                "Word".to_string()
            }
        }
    };

    Some(AppleLyric {
        lyric,
        yrc,
        timing,
        line_count: kept.len(),
    })
}
