'use strict';

// Apple Music 的歌词是 TTML（companion 读 `.../songs/<id>/syllable-lyrics`）。
// 这个方法只做格式转换：TTML → 项目里所有平台已经在用的两种文本（LRC 行级 + YRC 逐字），
// 后面继续交给 public/js/modules/06-lyrics/00-lyrics-fetch-parse.js 里既有的解析器，
// 不引入第三种歌词格式。
//
// Apple's lyrics come back as TTML from `.../songs/<id>/syllable-lyrics`. This module only
// converts: TTML -> the two text forms every other provider already returns (line-level LRC and
// word-level YRC), so the renderer keeps using its existing parser and no new format appears.
//
// 结构（实测与 Folia 的测试样本一致）：
//   <tt itunes:timing="Word"><body><div>
//     <p begin="00:12.345" end="00:15.678" ttm:agent="v1" itunes:key="L1">
//       <span begin="00:12.345" end="00:12.600">我</span>
//       <span begin="00:12.600" end="00:12.900">的</span>
//     </p>
//     <p begin="..." end="..." ttm:agent="v2">背景人声</p>
//   </div></body></tt>
//
// 时间写法可能是 `hh:mm:ss.SSS`、`mm:ss.SSS` 或纯秒，三种都要认。

// 与 companion 的 2 MB 上限对齐：就算上游被换掉，解析端也不会吃掉一份巨大的字符串。
const MAX_TTML_LENGTH = 2 * 1024 * 1024;
const MAX_LINES = 4000;
const MAX_SPANS_PER_LINE = 400;

function ttmlSeconds(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const full = text.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (full) return Number(full[1]) * 3600 + Number(full[2]) * 60 + Number(full[3]);
  const short = text.match(/^(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (short) return Number(short[1]) * 60 + Number(short[2]);
  const bare = Number(text);
  return Number.isFinite(bare) && bare >= 0 ? bare : null;
}

function decodeTtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (match, code) => {
      const point = Number(code);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, code) => {
      const point = parseInt(code, 16);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // `&amp;` 必须最后解：先解它，`&amp;lt;` 会被当成真正的 `<`，随后被当成标签吃掉。
    // `&amp;` is decoded last; doing it first turns `&amp;lt;` into a real `<` that then gets
    // swallowed as markup.
    .replace(/&amp;/g, '&');
}

// 只留可见文字：注音、括注、换行标签都要去掉，剩下的标签也不能漏进歌词。
function ttmlPlainText(fragment) {
  const stripped = String(fragment || '')
    .replace(/<rt\b[\s\S]*?<\/rt>/gi, '')
    .replace(/<rp\b[\s\S]*?<\/rp>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeTtmlEntities(stripped).replace(/\s+/g, ' ').trim();
}

function ttmlAttr(attrs, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(attrs || '').match(new RegExp('(?:^|\\s)' + escaped + '\\s*=\\s*"([^"]*)"', 'i'));
  return match ? match[1] : '';
}

function isBackgroundRole(attrs) {
  const role = ttmlAttr(attrs, 'ttm:role').toLowerCase();
  return role === 'x-bg' || role === 'x-bg-vocal' || role === 'background';
}

// 拉丁文的词间空格落在 `<span>` **之间**的文本里（`…>Hello</span> <span…`），
// 每个 span 的文本又是 trim 过的，直接拼会得到 `Helloworld`。所以整段按顺序切成「词」与
// 「词间文本」两类 token，拼行文本时原样保留顺序，词尾空格也一并记进词里（YRC 的字符偏移要用）。
// Latin word gaps live in the text *between* spans (`…>Hello</span> <span…`), while each span's
// text is trimmed, so plain concatenation yields `Helloworld`. Split the body into ordered tokens
// (words and inter-word text), keep the order when rebuilding the line, and carry a word's trailing
// space into the word itself — YRC character offsets depend on it.
function ttmlPlainRaw(fragment) {
  const stripped = String(fragment || '')
    .replace(/<rt\b[\s\S]*?<\/rt>/gi, '')
    .replace(/<rp\b[\s\S]*?<\/rp>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeTtmlEntities(stripped).replace(/\s+/g, ' ');
}

function readTtmlItems(body) {
  const items = [];
  const pattern = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let match;
  let cursor = 0;
  const pushText = (raw) => {
    const text = ttmlPlainRaw(raw);
    if (text) items.push({ kind: 'text', text });
  };
  while ((match = pattern.exec(body))) {
    if (items.length >= MAX_SPANS_PER_LINE) break;
    pushText(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const attrs = match[1] || '';
    items.push({
      kind: 'span',
      background: isBackgroundRole(attrs),
      text: ttmlPlainRaw(match[2]).trim(),
      start: ttmlSeconds(ttmlAttr(attrs, 'begin')),
      end: ttmlSeconds(ttmlAttr(attrs, 'end')),
    });
  }
  pushText(body.slice(cursor));
  return items;
}

function readTtmlLines(ttml) {
  const lines = [];
  const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pattern.exec(ttml))) {
    if (lines.length >= MAX_LINES) break;
    const attrs = match[1] || '';
    const items = readTtmlItems(match[2] || '');
    // 背景人声与主唱同轨时，混进同一行会把时间轴搅乱；单独成段时又常常只有一句和声。
    // 统一丢掉，主歌词才是播放时要跟着唱的那一轨。
    // Background vocals either share a line with the lead or stand alone as a stray harmony;
    // dropping them keeps the timeline readable.
    const kept = items.filter((item) => item.kind === 'text' || !item.background);
    let text = '';
    const words = [];
    for (let index = 0; index < kept.length; index += 1) {
      const item = kept[index];
      if (item.kind === 'text') {
        text += item.text;
        continue;
      }
      if (!item.text) continue;
      text += item.text;
      if (item.start == null) continue;
      const wordEnd = item.end != null && item.end > item.start
        ? item.end
        : item.start + Math.max(0.12, item.text.length * 0.16);
      // 词尾空格并进词里：YRC 的字符偏移按拼好的整行算，少了这个空格后面的词全会错位。
      // Fold the trailing space into the word: YRC offsets are measured on the joined line, and a
      // missing space shifts every following word.
      const next = kept[index + 1];
      const trailing = next && next.kind === 'text' && /^\s/.test(next.text) ? ' ' : '';
      words.push({ text: item.text + trailing, start: item.start, end: wordEnd });
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    let start = ttmlSeconds(ttmlAttr(attrs, 'begin'));
    let end = ttmlSeconds(ttmlAttr(attrs, 'end'));
    if (words.length) {
      if (start == null) start = words[0].start;
      if (end == null || end <= start) end = words[words.length - 1].end;
    }
    if (start == null) continue;
    if (end == null || end <= start) end = start + Math.max(0.8, text.length * 0.34);
    lines.push({
      start,
      end,
      text,
      words: words.length > 1 ? words : [],
      agent: ttmlAttr(attrs, 'ttm:agent').toLowerCase(),
    });
  }
  return lines;
}

function lrcTimestamp(seconds) {
  // 先取整到百分之一秒再拆分秒，否则 59.996 会被写成 `[00:60.00]`。
  // Round to centiseconds before splitting, or 59.996 would be written as `[00:60.00]`.
  const centis = Math.max(0, Math.round(Number(seconds) * 100) || 0);
  const minutes = Math.floor(centis / 6000);
  const rest = centis - minutes * 6000;
  return '[' + String(minutes).padStart(2, '0') + ':' + String(Math.floor(rest / 100)).padStart(2, '0') + '.' + String(rest % 100).padStart(2, '0') + ']';
}

// YRC 的词里不能出现小括号：解析器是按 `(start,dur,tag)文本` 切分的，括号会把后面的词吞掉。
// YRC words cannot contain parentheses; the parser splits on `(start,dur,tag)text` and a stray
// parenthesis swallows the words after it.
function yrcWordText(text) {
  return String(text || '').replace(/[()]/g, (ch) => (ch === '(' ? '（' : '）')).replace(/\s+/g, ' ');
}

function toYrcLine(line) {
  const startMs = Math.round(line.start * 1000);
  const endMs = Math.round(line.end * 1000);
  const durationMs = Math.max(1, endMs - startMs);
  const body = line.words.map((word) => {
    const wordStart = Math.round(word.start * 1000);
    const wordDuration = Math.max(1, Math.round((word.end - word.start) * 1000));
    return '(' + wordStart + ',' + wordDuration + ',0)' + yrcWordText(word.text);
  }).join('');
  return '[' + startMs + ',' + durationMs + ']' + body;
}

// 把 TTML 转成 `{ lyric, yrc, timing, lineCount }`。
// `lyric` 永远是行级 LRC（前端拿不到逐字时还有东西可显示）；
// `yrc` 只在真的有逐字时间时才给 —— 只有一行一个大 span 的「行级」TTML 给 yrc 反而会让前端
// 以为这是逐字歌，把整行当成一个不可分的长块。
// Returns `{ lyric, yrc, timing, lineCount }`. `lyric` is always line-level LRC so there is
// something to show even without word timing; `yrc` is only returned when real word timing exists,
// because a single whole-line span would otherwise be mistaken for word-level lyrics.
function convertAppleMusicTtmlToLyric(ttml) {
  const xml = typeof ttml === 'string' ? ttml : '';
  if (!xml || xml.length > MAX_TTML_LENGTH) return null;
  const lines = readTtmlLines(xml)
    .filter((line) => line.text)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  if (!lines.length) return null;

  // 主唱段落存在时再丢掉 `v2`：有些歌整首都标成 v2，一刀切会得到空歌词。
  // Only drop `v2` when lead lines exist; some songs tag every line as v2 and a blanket filter
  // would return nothing.
  const hasLeadAgent = lines.some((line) => line.agent === 'v1');
  const kept = hasLeadAgent ? lines.filter((line) => line.agent !== 'v2') : lines;
  if (!kept.length) return null;

  const lyric = kept.map((line) => lrcTimestamp(line.start) + line.text).join('\n');
  const wordLines = kept.filter((line) => line.words.length > 0);
  const yrc = wordLines.length ? wordLines.map(toYrcLine).join('\n') : '';
  const timingMatch = xml.match(/itunes:timing\s*=\s*"([^"]*)"/i);
  return {
    lyric,
    yrc,
    timing: (timingMatch && timingMatch[1]) || (yrc ? 'Word' : 'Line'),
    lineCount: kept.length,
  };
}

module.exports = {
  convertAppleMusicTtmlToLyric,
  _test: {
    ttmlSeconds,
    decodeTtmlEntities,
    ttmlPlainText,
    readTtmlLines,
    lrcTimestamp,
    MAX_LINES,
  },
};
