'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertAppleMusicTtmlToLyric, _test } = require('../server/apple-music-lyrics');
const { handleAppleMusicLyric } = require('../server/apple-music-api');

function ttml(body, timing) {
  return [
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="',
    timing || 'Word',
    '"><body dur="00:04.000"><div begin="00:00.000" end="00:04.000">',
    body,
    '</div></body></tt>',
  ].join('');
}

test('word-level TTML becomes line LRC plus word-level YRC', () => {
  const result = convertAppleMusicTtmlToLyric(ttml(
    '<p begin="00:01.000" end="00:03.000" ttm:agent="v1">'
    + '<span begin="00:01.000" end="00:01.500">Hello</span> '
    + '<span begin="00:01.500" end="00:02.500">world</span></p>'
  ));
  assert.equal(result.lyric, '[00:01.00]Hello world');
  // 词间空格必须保留：拉丁词的词尾空格也会并进词里，否则逐字偏移会全错。
  assert.equal(result.yrc, '[1000,2000](1000,500,0)Hello (1500,1000,0)world');
  assert.equal(result.timing, 'Word');
  assert.equal(result.lineCount, 1);
});

test('CJK syllables join without inserting spaces', () => {
  const result = convertAppleMusicTtmlToLyric(ttml(
    '<p begin="00:12.345" end="00:13.400">'
    + '<span begin="00:12.345" end="00:12.600">我</span>'
    + '<span begin="00:12.600" end="00:12.900">的</span>'
    + '<span begin="00:12.900" end="00:13.400">爱</span></p>'
  ));
  assert.equal(result.lyric, '[00:12.35]我的爱');
  assert.equal(result.yrc, '[12345,1055](12345,255,0)我(12600,300,0)的(12900,500,0)爱');
});

test('a whole-line span stays line-level and never fakes word timing', () => {
  // Apple 的行级歌词就是一个包住整句的 span。给成逐字会让渲染器把整行当成不可分的块。
  const result = convertAppleMusicTtmlToLyric(ttml(
    '<p begin="00:01.000" end="00:03.500"><span begin="00:01.000" end="00:03.500">整句歌词</span></p>',
    'Line'
  ));
  assert.equal(result.lyric, '[00:01.00]整句歌词');
  assert.equal(result.yrc, '');
  assert.equal(result.timing, 'Line');
});

test('background vocals are dropped when lead lines exist', () => {
  const result = convertAppleMusicTtmlToLyric(ttml(
    '<p begin="00:01.000" end="00:02.000" ttm:agent="v1">主唱</p>'
    + '<p begin="00:01.000" end="00:02.000" ttm:agent="v2">和声</p>'
    + '<p begin="00:03.000" end="00:04.000" ttm:agent="v1">'
    + '主句<span ttm:role="x-bg" begin="00:03.200" end="00:03.500">(oh)</span></p>'
  ));
  assert.equal(result.lineCount, 2);
  assert.ok(result.lyric.includes('主唱'));
  assert.ok(result.lyric.includes('主句'));
  assert.ok(!result.lyric.includes('和声'));
  assert.ok(!result.lyric.includes('oh'), `background span leaked: ${result.lyric}`);
});

test('songs where every line is tagged v2 still produce lyrics', () => {
  const result = convertAppleMusicTtmlToLyric(ttml(
    '<p begin="00:01.000" end="00:02.000" ttm:agent="v2">只有和声标注</p>'
  ));
  assert.equal(result.lyric, '[00:01.00]只有和声标注');
});

test('entities are decoded and empty lines are skipped', () => {
  const result = convertAppleMusicTtmlToLyric(ttml(
    '<p begin="00:01.000" end="00:02.000">Rock &amp; Roll</p>'
    + '<p begin="00:02.000" end="00:03.000"></p>'
  ));
  assert.equal(result.lyric, '[00:01.00]Rock & Roll');
  assert.equal(result.lineCount, 1);
});

test('YRC words cannot carry parentheses', () => {
  // 解析器按 `(start,dur,tag)文本` 切分，词里再出现小括号会把后面的词整段吞掉。
  const result = convertAppleMusicTtmlToLyric(ttml(
    '<p begin="00:01.000" end="00:02.000">'
    + '<span begin="00:01.000" end="00:01.500">(Oh)</span>'
    + '<span begin="00:01.500" end="00:02.000">yeah</span></p>'
  ));
  assert.ok(!/[()]/.test(result.yrc.replace(/\(\d+,\d+,\d+\)/g, '')), result.yrc);
  assert.equal(result.lyric, '[00:01.00](Oh)yeah');
});

test('timestamps roll over to the next minute instead of 00:60.00', () => {
  assert.equal(_test.lrcTimestamp(59.996), '[01:00.00]');
  assert.equal(_test.lrcTimestamp(125.4), '[02:05.40]');
});

test('unusable payloads return null instead of an empty lyric', () => {
  assert.equal(convertAppleMusicTtmlToLyric(''), null);
  assert.equal(convertAppleMusicTtmlToLyric('<tt><body></body></tt>'), null);
  assert.equal(convertAppleMusicTtmlToLyric(null), null);
});

test('the lyric handler refuses ids Apple cannot address', async () => {
  let calls = 0;
  const result = await handleAppleMusicLyric(async () => { calls += 1; return { ok: true, data: {} }; }, 'i.eoD8V5gfMbAPzJG');
  assert.equal(result.error, 'invalid-song-id');
  assert.equal(result.lyric, '');
  assert.equal(calls, 0, 'a library id must not reach the companion');
});

test('the lyric handler converts the companion TTML and caches it', async () => {
  const payload = ttml(
    '<p begin="00:01.000" end="00:03.000">'
    + '<span begin="00:01.000" end="00:01.500">Hello</span> '
    + '<span begin="00:01.500" end="00:02.500">world</span></p>'
  );
  let calls = 0;
  const requester = async (operation) => {
    calls += 1;
    assert.equal(operation, 'lyrics');
    return { ok: true, data: { ttml: payload } };
  };
  const first = await handleAppleMusicLyric(requester, '987654321');
  assert.equal(first.lyric, '[00:01.00]Hello world');
  assert.ok(first.yrc);
  assert.equal(first.source, 'applemusic');
  assert.equal(first.provider, 'applemusic');
  // 第二首歌不会命中的情况下再查一次，必须走缓存而不是再打一趟 companion。
  const second = await handleAppleMusicLyric(requester, '987654321');
  assert.equal(second.lyric, first.lyric);
  assert.equal(calls, 1);
});

test('a song Apple has no lyric for answers an empty envelope, not an error status', async () => {
  const result = await handleAppleMusicLyric(async () => ({ ok: false, error: 'lyrics-unavailable' }), '123456789');
  assert.equal(result.lyric, '');
  assert.equal(result.yrc, '');
  assert.equal(result.source, 'none');
  assert.equal(result.error, 'lyrics-unavailable');
});
