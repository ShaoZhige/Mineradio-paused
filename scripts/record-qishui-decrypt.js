// 录制 `server/qishui-audio-decryptor/` 的原始 JS 输出，作为 Rust 移植的比对基准。
//
// 为什么不用 `rust-anything bridge`：那个单元只导出 `TrackDecryptor` 类、不导出任何函数，
// `bridge` 会直接报 `exports no functions; bridge a unit with an exported function API`。
// 所以这里直接 require 原模块跑真代码，输出沿用 rust-anything 的 `{fn,args,ok}` 形状：
// - args 一律是**可回放的原始入参**（Buffer 写成 `{"b64": "..."}`，不写人类说明），
//   Rust 侧照着 args 重建入参即可，不需要为每条用例写特判；
// - 抛异常的用例记 `err`（消息逐字比对）；
// - 另加一个 `note` 字段只给人看，不参与比对。
//
// 用法：node scripts/record-qishui-decrypt.js > ztest/ra-qishui-decrypt/cases.jsonl
'use strict';

const crypto = require('crypto');
const { TrackDecryptor } = require('../server/qishui-audio-decryptor/track-decryptor');
const { Mp4Box } = require('../server/qishui-audio-decryptor/mp4-box');
const utils = require('../server/qishui-audio-decryptor/decrypt-utils');

const cases = [];

function bin(buffer) {
  return { b64: Buffer.from(buffer).toString('base64') };
}

/** 记一条用例。`run` 抛异常就记 err（消息逐字比对）。 */
function record(fn, args, note, run) {
  let ok;
  try {
    ok = run();
  } catch (error) {
    cases.push({ fn, args, note, err: String(error && error.message ? error.message : error) });
    return;
  }
  cases.push({ fn, args, note, ok });
}

// ── 小工具 ─────────────────────────────────────────────────────────────────
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function uint32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

function concat(parts) {
  return Buffer.concat(parts);
}

function flipBit(buffer, index) {
  const copy = Buffer.from(buffer);
  copy[index] ^= 0x5a;
  return copy;
}

const KEY_HEX = '00112233445566778899aabbccddeeff';
const KEY = Buffer.from(KEY_HEX, 'hex');

function bitCount(value) {
  let current = value;
  current = current - ((current >> 1) & 0x55555555);
  current = (current & 0x33333333) + ((current >> 2) & 0x33333333);
  return (((current + (current >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * `decryptSpade` 的逆运算，用来造一个**真的能被解开**的 spade blob。
 * inner[0] 取 0xBF 是为了让 temp[0]=48（'0'）→ skip=0 → 尾巴长度 0，边界最少。
 */
function encodeSpade(message) {
  const msg = Buffer.from(message, 'utf8');
  if (!msg.length) throw new Error('encodeSpade 不接受空串');
  const inner = Buffer.alloc(1 + msg.length);
  inner[0] = 0xbf;
  for (let index = 1; index < inner.length; index += 1) {
    const target = msg[index - 1];
    const working = index === 1 ? 0x55 : inner[index - 2];
    let v = target + bitCount(index) + 21;
    while (v > 254) v -= 255;
    inner[index] = v ^ working;
  }
  const head = 0x30 ^ inner[0] ^ inner[1]; // paddingLength = head^inner0^inner1 - 48 = 0
  return Buffer.concat([Buffer.from([head]), inner]).toString('base64');
}

function sencBox(ivPrefixes) {
  return box('senc', concat([
    Buffer.from([0, 0, 0, 0]),
    uint32(ivPrefixes.length),
    ...ivPrefixes.map((iv) => Buffer.from(iv)),
  ]));
}

function stsdBox(entry) {
  return box('stsd', concat([Buffer.from([0, 0, 0, 0]), uint32(1), entry]));
}

/**
 * 造一个"加密"的 MP4：样本按 AES-128-CTR 加密后连续排在 mdat 里，
 * senc 给出每样本的 8 字节 IV 前缀（JS 侧会补 8 个零），
 * `flac` 为真时在 stsd 里塞一个 dfLa 盒子走 FLAC 分支。
 */
function buildEncryptedMp4({ samples, ivPrefixes, flac }) {
  const encrypted = samples.map((plain, index) => {
    const iv = Buffer.alloc(16);
    Buffer.from(ivPrefixes[index]).copy(iv, 0);
    const cipher = crypto.createCipheriv('aes-128-ctr', KEY, iv);
    return Buffer.concat([cipher.update(plain), cipher.final()]);
  });

  const streamInfo = Buffer.alloc(34, 0x11);
  streamInfo.write('fLaC', 0, 'ascii');
  const stsdEntry = flac
    ? box('dfLa', concat([Buffer.from([0, 0, 0, 0]), streamInfo]))
    : box('enca', Buffer.from('aabbccdd', 'hex'));
  const stbl = box('stbl', concat([
    stsdBox(stsdEntry),
    box('stsz', concat([Buffer.from([0, 0, 0, 0]), uint32(0), uint32(samples.length),
      ...samples.map((plain) => uint32(plain.length))])),
    box('stsc', concat([Buffer.from([0, 0, 0, 0]), uint32(1), uint32(1), uint32(samples.length), uint32(1)])),
    box('stco', concat([Buffer.from([0, 0, 0, 0]), uint32(1), uint32(0)])),
  ]));
  const moov = box('moov', concat([
    sencBox(ivPrefixes),
    box('trak', box('mdia', box('minf', stbl))),
  ]));

  return { file: concat([moov, box('mdat', concat(encrypted))]), encrypted };
}

const SAMPLES = [
  Buffer.from('the quick brown fox jumps', 'utf8'),
  Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  Buffer.from('短样本', 'utf8'),
  Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 7) & 0xff)),
];
const IV_PREFIXES = [
  Buffer.from('0011223344556677', 'hex'),
  Buffer.from('8899aabbccddeeff', 'hex'),
  Buffer.from('0102030405060708', 'hex'),
  Buffer.from('ffffffffffffffff', 'hex'),
];

// ── 组合路径：TrackDecryptor.decrypt ───────────────────────────────────────
const decryptor = new TrackDecryptor();

/** decrypt 用例统一成 args = [bin(encrypted), spadeA, title|null, artist|null]。 */
function recordDecrypt(note, input, project) {
  const media = input.media || {};
  const args = [
    bin(input.encryptedBuffer),
    input.spadeA,
    media.title === undefined ? null : media.title,
    media.artist === undefined ? null : media.artist,
  ];
  record('TrackDecryptor.decrypt', args, note, () => project(decryptor.decrypt(input)));
}

const fullProjection = (out) => ({
  buffer: bin(out.buffer),
  extension: out.extension,
  fileName: out.fileName,
  meta: out.meta,
});

const m4aFixture = buildEncryptedMp4({ samples: SAMPLES, ivPrefixes: IV_PREFIXES, flac: false });
recordDecrypt('m4a 分支：spade_a 直接是十六进制，标题带非法字符', {
  encryptedBuffer: m4aFixture.file,
  spadeA: KEY_HEX,
  media: { title: 'Track/One', artist: 'A:B' },
}, fullProjection);

const flacFixture = buildEncryptedMp4({ samples: SAMPLES, ivPrefixes: IV_PREFIXES, flac: true });
const spadeBlob = encodeSpade(KEY_HEX);
recordDecrypt('flac 分支：spade_a 是加密 blob，中文标题', {
  encryptedBuffer: flacFixture.file,
  spadeA: spadeBlob,
  media: { title: '青花瓷', artist: '周杰伦' },
}, fullProjection);

recordDecrypt('media 缺省（文件名回落 track / unknown）', {
  encryptedBuffer: m4aFixture.file,
  spadeA: KEY_HEX,
}, (out) => ({ extension: out.extension, fileName: out.fileName, meta: out.meta }));

recordDecrypt('空 buffer', { encryptedBuffer: Buffer.alloc(0), spadeA: KEY_HEX, media: {} }, fullProjection);
recordDecrypt('缺 spade_a', { encryptedBuffer: m4aFixture.file, spadeA: '', media: {} }, fullProjection);
recordDecrypt('解不开的 spade_a', { encryptedBuffer: m4aFixture.file, spadeA: 'AAAA', media: {} }, fullProjection);

recordDecrypt('没有 moov', {
  encryptedBuffer: box('mdat', Buffer.from('payload!!')),
  spadeA: KEY_HEX,
  media: {},
}, fullProjection);

const emptyStbl = box('stbl', concat([
  stsdBox(box('enca', Buffer.from('x'))),
  box('stsz', concat([Buffer.from([0, 0, 0, 0]), uint32(0), uint32(0)])),
  box('stsc', concat([Buffer.from([0, 0, 0, 0]), uint32(0)])),
  box('stco', concat([Buffer.from([0, 0, 0, 0]), uint32(0)])),
]));
const emptyMoov = box('moov', box('trak', box('mdia', box('minf', emptyStbl))));
recordDecrypt('没有 senc', {
  encryptedBuffer: concat([emptyMoov, box('mdat', Buffer.alloc(16))]),
  spadeA: KEY_HEX,
  media: {},
}, fullProjection);

const encryptedTotal = m4aFixture.encrypted.reduce((sum, chunk) => sum + chunk.length, 0);
recordDecrypt('没有 mdat（把尾部 mdat 整个切掉）', {
  encryptedBuffer: m4aFixture.file.subarray(0, m4aFixture.file.length - encryptedTotal - 8),
  spadeA: KEY_HEX,
  media: {},
}, fullProjection);

// `Mp4Box.findBox` 只扫同一层；stsz 埋在 moov/trak/mdia/minf/stbl 里，
// 所以录制器自己写一个递归版（产品代码里没有这个需求，decrypt 是一层层显式取）。
function deepFind(buffer, type, start, end) {
  const from = start === undefined ? 0 : start;
  const to = end === undefined ? buffer.length : end;
  let position = from;
  while (position + 8 <= to) {
    const size = buffer.readUInt32BE(position);
    if (size < 8 || position + size > to) break;
    const found = buffer.subarray(position + 4, position + 8).toString('ascii');
    if (found === type) return Mp4Box.fromBuffer(buffer, position);
    const inner = deepFind(buffer, type, position + 8, position + size);
    if (!inner.isEmpty()) return inner;
    position += size;
  }
  return Mp4Box.fromBuffer(Buffer.alloc(0), 0);
}

const mismatch = Buffer.from(m4aFixture.file);
deepFind(mismatch, 'stsz').data.writeUInt32BE(SAMPLES.length - 1, 8);
recordDecrypt('stsz 少一个尺寸 → 样本数与 IV 数不等', {
  encryptedBuffer: mismatch,
  spadeA: KEY_HEX,
  media: {},
}, fullProjection);

const badStsz = Buffer.from(m4aFixture.file);
deepFind(badStsz, 'stsz').data.writeUInt32BE(0, 8);
recordDecrypt('stsz 报 0 个样本但 senc 有 4 个 IV', {
  encryptedBuffer: badStsz,
  spadeA: KEY_HEX,
  media: {},
}, fullProjection);

// ── 单函数：spade / hex / AES ──────────────────────────────────────────────
record('decryptSpadeA', [spadeBlob], '合法 blob → 原样还原十六进制密钥', () => utils.decryptSpadeA(spadeBlob));
record('decryptSpadeA', ['not/base64@#$'], 'base64 垃圾字符', () => utils.decryptSpadeA('not/base64@#$'));
record('decryptSpadeA', ['AA=='], '过短（< 3 字节）', () => utils.decryptSpadeA('AA=='));
record('decryptSpadeA', [''], '空串', () => utils.decryptSpadeA(''));
record('decryptSpadeA', ['AQIDBAU='], '长度够但内容随机', () => utils.decryptSpadeA('AQIDBAU='));
const flipped = flipBit(Buffer.from(spadeBlob, 'base64'), 3).toString('base64');
record('decryptSpadeA', [flipped], '第 4 字节被改 → 应还原出错误内容或空串', () => utils.decryptSpadeA(flipped));

record('hexToBuffer', [KEY_HEX], '32 位十六进制', () => bin(utils.hexToBuffer(KEY_HEX)));
record('hexToBuffer', ['abc'], '奇数长度 → 抛错', () => bin(utils.hexToBuffer('abc')));
record('hexToBuffer', ['zzzz'], '非十六进制 → Node 解出空 buffer', () => bin(utils.hexToBuffer('zzzz')));
record('hexToBuffer', ['AABBCCDD'], '大写', () => bin(utils.hexToBuffer('AABBCCDD')));
record('hexToBuffer', ['aabbccd'], '奇数长度短串', () => bin(utils.hexToBuffer('aabbccd')));

const ctrKeyA = Buffer.from(KEY_HEX, 'hex');
const ctrIvA = Buffer.alloc(16, 0x07);
const ctrPlainA = Buffer.from('hello world 1234', 'utf8');
const ctrCipherA = crypto.createCipheriv('aes-128-ctr', ctrKeyA, ctrIvA);
const ctrDataA = Buffer.concat([ctrCipherA.update(ctrPlainA), ctrCipherA.final()]);
record('aesCtrDecrypt', [bin(ctrKeyA), bin(ctrIvA), bin(ctrDataA)], '单块，key 是 00..ff 递增',
  () => bin(utils.aesCtrDecrypt(ctrKeyA, ctrIvA, ctrDataA)));

const ctrKeyB = Buffer.alloc(16, 0xff);
const ctrIvB = Buffer.from('000000000000000000000000000000ff', 'hex');
const ctrPlainB = Buffer.alloc(80, 0x41);
const ctrCipherB = crypto.createCipheriv('aes-128-ctr', ctrKeyB, ctrIvB);
const ctrDataB = Buffer.concat([ctrCipherB.update(ctrPlainB), ctrCipherB.final()]);
record('aesCtrDecrypt', [bin(ctrKeyB), bin(ctrIvB), bin(ctrDataB)], '80 字节跨块 + 计数器末字节进位',
  () => bin(utils.aesCtrDecrypt(ctrKeyB, ctrIvB, ctrDataB)));

record('aesCtrDecrypt', [bin(Buffer.alloc(16, 1)), bin(Buffer.alloc(16, 2)), bin(Buffer.alloc(0))],
  '空 payload', () => bin(utils.aesCtrDecrypt(Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(0))));

// ── 单函数：MP4 盒子解析 ───────────────────────────────────────────────────
const stszFixed = box('stsz', concat([Buffer.from([0, 0, 0, 0]), uint32(512), uint32(3)])).subarray(8);
record('parseStsz', [bin(stszFixed)], '固定尺寸 512 × 3', () => utils.parseStsz(stszFixed));

const stszTable = box('stsz', concat([
  Buffer.from([0, 0, 0, 0]), uint32(0), uint32(4), uint32(1), uint32(2), uint32(3), uint32(4000),
])).subarray(8);
record('parseStsz', [bin(stszTable)], '尺寸表 1/2/3/4000', () => utils.parseStsz(stszTable));

const stscData = box('stsc', concat([
  Buffer.from([0, 0, 0, 0]), uint32(2),
  uint32(1), uint32(4), uint32(1),
  uint32(5), uint32(2), uint32(1),
])).subarray(8);
record('parseStsc', [bin(stscData)], '两条表项', () => utils.parseStsc(stscData));

const sencData = box('senc', concat([
  Buffer.from([0, 0, 0, 0]), uint32(2),
  Buffer.from('0011223344556677', 'hex'),
  Buffer.from('8899aabbccddeeff', 'hex'),
])).subarray(8);
record('parseSenc', [bin(sencData)], '两个 IV（各补到 16 字节）',
  () => utils.parseSenc(sencData).map((iv) => bin(iv)));

const dfLaStsd = box('stsd', concat([
  Buffer.from([0, 0, 0, 0]), uint32(1),
  box('dfLa', Buffer.from('00000000fLaC-and-streaminfo')),
])).subarray(8);
record('scanForFlacMetadata', [bin(dfLaStsd)], '有 dfLa，返回其内容（去掉 4 字节版本号）',
  () => bin(utils.scanForFlacMetadata(dfLaStsd)));

const noDfLaStsd = box('stsd', box('enca', Buffer.from('nothing here'))).subarray(8);
record('scanForFlacMetadata', [bin(noDfLaStsd)], '没有 dfLa → 空 buffer',
  () => bin(utils.scanForFlacMetadata(noDfLaStsd)));

record('scanForFlacMetadata', [bin(Buffer.from('dfLa1234'))], 'dfLa 出现在偏移 0（< 4）→ 空 buffer',
  () => bin(utils.scanForFlacMetadata(Buffer.from('dfLa1234'))));

const encaWhole = Buffer.from('xxxxencaxxxxencaxxxx');
record('replaceEncaWithMp4a', [bin(encaWhole), 4, 12], '范围内第一个 enca 被替换',
  () => {
    const target = Buffer.from(encaWhole);
    utils.replaceEncaWithMp4a(target, 4, 12);
    return bin(target);
  });
record('replaceEncaWithMp4a', [bin(encaWhole), 0, 4], '范围内没有 enca → 原样',
  () => {
    const target = Buffer.from(encaWhole);
    utils.replaceEncaWithMp4a(target, 0, 4);
    return bin(target);
  });

// ── 单函数：文件名清洗 ─────────────────────────────────────────────────────
for (const value of ['a/b:c*d?e"f<g>h|i', '   ', '', null, '正常标题', 'a\\b', 'a\tb']) {
  record('sanitizeFilenamePart', [value, 'fallback'], `入参 ${JSON.stringify(value)}`,
    () => utils.sanitizeFilenamePart(value, 'fallback'));
}

for (const item of cases) process.stdout.write(`${JSON.stringify(item)}\n`);
process.stderr.write(`共 ${cases.length} 条用例\n`);
