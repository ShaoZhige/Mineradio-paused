//! `server/qishui-audio-decryptor/` 的 Rust 移植：汽水音乐的加密音频解密（AES-128-CTR）+
//! MP4 盒子解析 + FLAC / M4A 回封。
//!
//! 一致性的判定依据是 `tests/fixtures/qishui-decrypt-cases.jsonl`
//! （41 条，由 `scripts/record-qishui-decrypt.js` 直接 require 原模块录下来的真实输出）。
//! 那个录制器是手写的，不是 `rust-anything bridge` —— 原因见 `docs/REWRITE-PLAN.md` §7.2：
//! 这个单元只导出 `TrackDecryptor` 类，`bridge` 只认「导出函数」的模块。
//!
//! # 与 JS 版的逐点对齐
//!
//! 1. **`bitCount` 是 32 位 popcount**，且用在**下标 i** 上而不是数据上（原实现如此，别"优化"）。
//! 2. **负数归一化用 `+= 0xff` 而不是 `+= 256`**：它是 mod 255，不是补码回绕。
//! 3. **`Buffer.from(hex,'hex')` 遇非法对就停**，不抛错：`"zzzz"` → 空 buffer、`"abzz"` → `[0xab]`。
//!    只有**奇数长度**会抛（原实现的显式检查）。
//! 4. **base64 解码是宽容的**：Node 会跳过所有非字母表字符，`"not/base64@#$"` 解出 6 字节。
//! 5. **`Buffer.from(x,'hex')` 之后 `createDecipheriv` 才校验长度**，所以 `spade_a = "AAAA"`
//!    （恰好全是十六进制字符）会走"当成密钥"这条路，最后报 `Invalid key length`，而不是"解不开"。
//! 6. **IV 只给了 8 字节**，`parseSenc` 会补 8 个零凑满 16 —— 加密侧也是这么构造的，别改成 12 字节 nonce。
//! 7. **FLAC 分支丢掉 `dfLa` 内容的头 4 字节**（full box 的 version/flags），再补 `fLaC` 魔数。
//!
//! # 刻意偏离（都只影响畸形输入）
//!
//! - 越界的 `read_u32` 在 Node 里抛 `RangeError`，这里统一按 0 处理并提前结束解析。
//!   真实文件里 `stsz` / `senc` 的长度总是自洽的；真截断了会在后面的计数校验上报错。
//! - `spade` 的 `paddingLength` 为负时 Node 的 `subarray(1, len - negative)` 会读成"到末尾"，
//!   这里直接判为解不出（返回空串）。输入是自家服务端生成的，不会出现这种形状。

use aes::cipher::{KeyIvInit, StreamCipher};
use aes::Aes128;
use ctr::Ctr128BE;

/// `aes-128-ctr`：16 字节密钥 + 16 字节 IV（计数器按大端整体进位，与 OpenSSL 一致）。
type Aes128Ctr = Ctr128BE<Aes128>;

/// `.m4a` / `.flac`
pub type Extension = &'static str;

/// 解密失败的形状：只带一条与 JS 版逐字相同的消息，方便上层原样回给前端 / 写日志。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptError {
    message: String,
}

impl DecryptError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for DecryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DecryptError {}

/// 解密结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedTrack {
    pub buffer: Vec<u8>,
    /// `.m4a` 或 `.flac`
    pub extension: Extension,
    pub file_name: String,
    pub meta: TrackMeta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackMeta {
    pub is_flac: bool,
    pub sample_count: usize,
    /// `stco` 里声明的 chunk 数。解密不用它，但日志和排障要看。
    pub chunk_count: u32,
}

/// `decrypt({ media: { title, artist } })` 的两个可选项。
#[derive(Debug, Clone, Copy, Default)]
pub struct TrackMedia<'a> {
    pub title: Option<&'a str>,
    pub artist: Option<&'a str>,
}

// ── MP4 盒子 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct Atom {
    size: usize,
    offset: usize,
}

impl Atom {
    const EMPTY: Atom = Atom { size: 0, offset: 0 };

    fn is_empty(self) -> bool {
        self.size == 0
    }
}

fn read_u32(buffer: &[u8], at: usize) -> Option<u32> {
    let end = at.checked_add(4)?;
    let bytes = buffer.get(at..end)?;
    Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// `Mp4Box.fromBuffer`：越界一律给空盒（`size: 0` 是"没找到"的唯一标记）。
fn atom_at(buffer: &[u8], offset: usize) -> Atom {
    if offset.saturating_add(8) > buffer.len() {
        return Atom::EMPTY;
    }
    let size = read_u32(buffer, offset).unwrap_or(0) as usize;
    let end = if size >= 8 && offset + size <= buffer.len() {
        offset + size
    } else {
        buffer.len()
    };
    Atom {
        size: end - offset,
        offset,
    }
}

/// `Mp4Box.findBox(buffer, type, offset, end)`：只扫**同一层**。
fn find_atom(buffer: &[u8], name: &[u8; 4], offset: usize, end: usize) -> Atom {
    let mut position = offset;
    while position < end {
        if position + 8 > end {
            break;
        }
        let size = read_u32(buffer, position).unwrap_or(0) as usize;
        if size < 8 || position + size > end {
            break;
        }
        if &buffer[position + 4..position + 8] == name {
            return atom_at(buffer, position);
        }
        position += size;
    }
    Atom::EMPTY
}

/// 盒子内容（跳过 8 字节头）。
fn atom_payload(buffer: &[u8], atom: Atom) -> &[u8] {
    let start = (atom.offset + 8).min(buffer.len());
    let end = (atom.offset + atom.size).min(buffer.len());
    if end <= start {
        &[]
    } else {
        &buffer[start..end]
    }
}

// ── 单项工具 ────────────────────────────────────────────────────────────────

/// Node 的 `Buffer.from(hex, 'hex')`：逐对解码，遇到非法对**停下**，不抛错；
/// 只有奇数长度抛（原实现的显式检查）。
pub fn hex_to_buffer(hex: &str) -> Result<Vec<u8>, DecryptError> {
    let bytes = hex.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(DecryptError::new("Hex string length must be even."));
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.as_chunks::<2>().0 {
        let (Some(high), Some(low)) = (hex_digit(pair[0]), hex_digit(pair[1])) else {
            break;
        };
        out.push((high << 4) | low);
    }
    Ok(out)
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Node 的 `Buffer.from(text, 'base64')`：跳过所有非字母表字符，余下的位凑满一个字节就输出。
fn base64_decode_lenient(text: &str) -> Vec<u8> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut accumulator: u32 = 0;
    let mut bits = 0u32;
    for byte in text.bytes() {
        let Some(value) = TABLE.iter().position(|&c| c == byte) else {
            continue;
        };
        accumulator = (accumulator << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    out
}

/// `aes-128-ctr`。密钥 / IV 长度不对时报与 OpenSSL 相同的消息。
pub fn aes_ctr_decrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Result<Vec<u8>, DecryptError> {
    if key.len() != 16 {
        return Err(DecryptError::new("Invalid key length"));
    }
    if iv.len() != 16 {
        return Err(DecryptError::new("Invalid initialization vector"));
    }
    let mut buffer = data.to_vec();
    let key_bytes: &[u8; 16] = key.try_into().expect("长度已在上面校验");
    let iv_bytes: &[u8; 16] = iv.try_into().expect("长度已在上面校验");
    let mut cipher = Aes128Ctr::new(key_bytes.into(), iv_bytes.into());
    cipher.apply_keystream(&mut buffer);
    Ok(buffer)
}

/// `bitCount`：32 位 popcount。注意原实现是用在**下标**上的。
fn bit_count(value: usize) -> i32 {
    (value as u32).count_ones() as i32
}

fn decrypt_spade_inner(spade_key: &[u8]) -> Vec<u8> {
    let mut working = Vec::with_capacity(spade_key.len() + 2);
    working.push(0xfa);
    working.push(0x55);
    working.extend_from_slice(spade_key);

    let mut result = Vec::with_capacity(spade_key.len());
    for index in 0..spade_key.len() {
        // `+= 0xff` 是 mod 255，不是补码回绕（见模块头部第 2 条）。
        let mut value = (spade_key[index] as i32 ^ working[index] as i32) - bit_count(index) - 21;
        while value < 0 {
            value += 0xff;
        }
        result.push((value & 0xff) as u8);
    }
    result
}

/// `decodeBase36(charCode)`：数字 / 小写字母才认，其余给 0xff（=255，会把消息长度算到越界）。
fn decode_base36(byte: u8) -> usize {
    match byte {
        b'0'..=b'9' => (byte - b'0') as usize,
        b'a'..=b'z' => (byte - b'a' + 10) as usize,
        _ => 0xff,
    }
}

fn decrypt_spade(spade_key: &[u8]) -> String {
    if spade_key.len() < 3 {
        return String::new();
    }
    let padding_length = (spade_key[0] as i32 ^ spade_key[1] as i32 ^ spade_key[2] as i32) - 48;
    if padding_length < 0 {
        // 见「刻意偏离」：Node 会把负值当成"读到末尾"，这里直接判为解不出。
        return String::new();
    }
    let padding_length = padding_length as usize;
    if spade_key.len() < padding_length + 2 {
        return String::new();
    }

    let inner = &spade_key[1..spade_key.len() - padding_length];
    let temp = decrypt_spade_inner(inner);
    if temp.is_empty() {
        return String::new();
    }

    let skip = decode_base36(temp[0]);
    let decoded_length = spade_key.len() - padding_length - 2;
    let end_index = 1 + decoded_length;
    if skip > end_index - 1 {
        // 与 JS 的 `1 + decodedMessageLength - skipBytes` 为负时 `subarray` 行为对齐：
        // 起点 1 超过终点则取空，这里直接给空串。
        return String::new();
    }
    let end_index = end_index - skip;
    if end_index > temp.len() {
        return String::new();
    }
    let slice = &temp[1..end_index.max(1)];
    String::from_utf8_lossy(slice).to_string()
}

/// `decryptSpadeA`：base64 → spade 解码。失败给空串，不抛错。
pub fn decrypt_spade_a(spade_a: &str) -> String {
    decrypt_spade(&base64_decode_lenient(spade_a))
}

fn is_hex_string(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `parseStsz`：`sample_size != 0` 时是"每个样本都这么大"，否则读尺寸表。
pub fn parse_stsz(data: &[u8]) -> Vec<u32> {
    /// 一首歌撑不到这个数（4 分钟 44.1 kHz / 1024 帧 ≈ 10k 样本）；
    /// 超过就当成坏文件，否则恶意构造的 `sample_count` 能直接要 2 TB 内存。
    const MAX_SAMPLES: usize = 1 << 20;

    let sample_size = read_u32(data, 4).unwrap_or(0);
    let count = (read_u32(data, 8).unwrap_or(0) as usize).min(MAX_SAMPLES);
    if sample_size != 0 {
        return vec![sample_size; count];
    }
    (0..count)
        .map_while(|index| read_u32(data, 12 + index * 4))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StscEntry {
    pub first_chunk: u32,
    pub samples_per_chunk: u32,
    pub id: u32,
}

pub fn parse_stsc(data: &[u8]) -> Vec<StscEntry> {
    let entry_count = read_u32(data, 4).unwrap_or(0) as usize;
    (0..entry_count)
        .map_while(|index| {
            let base = 8 + index * 12;
            Some(StscEntry {
                first_chunk: read_u32(data, base)?,
                samples_per_chunk: read_u32(data, base + 4)?,
                id: read_u32(data, base + 8)?,
            })
        })
        .collect()
}

/// `parseSenc`：每样本 8 字节 IV，补 8 个零成 16 字节（见模块头部第 6 条）。
pub fn parse_senc(data: &[u8]) -> Vec<[u8; 16]> {
    let count = read_u32(data, 4).unwrap_or(0) as usize;
    (0..count)
        .map_while(|index| {
            let position = 8 + index * 8;
            let bytes = data.get(position..position + 8)?;
            let mut iv = [0u8; 16];
            iv[..8].copy_from_slice(bytes);
            Some(iv)
        })
        .collect()
}

/// `scanForFlacMetadata`：在 `stsd` 里找 `dfLa` 盒子，返回其内容（含 4 字节 version/flags）。
pub fn scan_for_flac_metadata(stsd_data: &[u8]) -> Vec<u8> {
    const MARKER: &[u8; 4] = b"dfLa";
    let Some(index) = stsd_data.windows(4).position(|window| window == MARKER) else {
        return Vec::new();
    };
    if index < 4 {
        return Vec::new();
    }
    let box_size = read_u32(stsd_data, index - 4).unwrap_or(0) as usize;
    let content_start = index + 4;
    let content_end = (index - 4 + box_size).min(stsd_data.len());
    if content_end <= content_start {
        return Vec::new();
    }
    stsd_data[content_start..content_end].to_vec()
}

/// 把 `[start, end)` 里**第一个** `enca` 改成 `mp4a`。
pub fn replace_enca_with_mp4a(buffer: &mut [u8], start: usize, end: usize) {
    let end = end.min(buffer.len());
    let mut index = start;
    while index + 4 <= end {
        if &buffer[index..index + 4] == b"enca" {
            buffer[index..index + 4].copy_from_slice(b"mp4a");
            return;
        }
        index += 1;
    }
}

/// `sanitizeFilenamePart`：非法字符换下划线，trim 后为空则用 fallback。
pub fn sanitize_filename_part(value: Option<&str>, fallback: &str) -> String {
    let raw = match value {
        // `String(value || fallback)`：空串也是假值。
        Some(text) if !text.is_empty() => text,
        _ => fallback,
    };
    let normalized: String = raw
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = trim_js(&normalized);
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// JS 的 `String.prototype.trim`：比 Rust 的 `trim` 多认 `U+FEFF`。
fn trim_js(text: &str) -> &str {
    text.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{FEFF}')
}

fn create_file_name(title: Option<&str>, artist: Option<&str>, extension: Extension) -> String {
    let safe_title = sanitize_filename_part(title, "track");
    let safe_artist = sanitize_filename_part(artist, "unknown");
    format!("{safe_title} - {safe_artist}{extension}")
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

fn resolve_key(spade_a: &str) -> Result<Vec<u8>, DecryptError> {
    if spade_a.is_empty() {
        return Err(DecryptError::new("spade_a is required for decryption."));
    }
    let key_hex = if is_hex_string(spade_a) {
        spade_a.to_string()
    } else {
        decrypt_spade_a(spade_a)
    };
    if key_hex.is_empty() {
        return Err(DecryptError::new(
            "Failed to resolve decryption key from spade_a.",
        ));
    }
    hex_to_buffer(&key_hex)
}

fn decrypt_samples(
    file: &[u8],
    key: &[u8],
    sample_sizes: &[u32],
    ivs: &[[u8; 16]],
    mdat_offset: usize,
) -> Result<Vec<Vec<u8>>, DecryptError> {
    let mut decrypted = Vec::with_capacity(sample_sizes.len());
    let mut sample_offset = mdat_offset + 8;
    for (index, size) in sample_sizes.iter().enumerate() {
        let Some(iv) = ivs.get(index) else {
            return Err(DecryptError::new(format!("Missing IV for sample {index}.")));
        };
        let size = *size as usize;
        // Node 的 `subarray` 越界会静默截断，这里照做（真实文件不会越界，畸形文件别崩）。
        let end = (sample_offset + size).min(file.len());
        let encrypted = if sample_offset < end {
            &file[sample_offset..end]
        } else {
            &[]
        };
        decrypted.push(aes_ctr_decrypt(key, iv, encrypted)?);
        sample_offset += size;
    }
    Ok(decrypted)
}

fn build_flac_file(flac_metadata: &[u8], decrypted_samples: &[Vec<u8>]) -> Vec<u8> {
    // `dfLa` 内容的头 4 字节是 full box 的 version/flags，要丢掉再补 `fLaC` 魔数。
    let metadata_body = if flac_metadata.len() > 4 {
        &flac_metadata[4..]
    } else {
        flac_metadata
    };
    let mut out = Vec::with_capacity(
        4 + metadata_body.len() + decrypted_samples.iter().map(Vec::len).sum::<usize>(),
    );
    out.extend_from_slice(b"fLaC");
    out.extend_from_slice(metadata_body);
    for sample in decrypted_samples {
        out.extend_from_slice(sample);
    }
    out
}

fn build_m4a_file(file: &[u8], decrypted_samples: &[Vec<u8>], mdat: Atom, stsd: Atom) -> Vec<u8> {
    let mut output = file.to_vec();
    let mut write_pointer = mdat.offset + 8;
    for sample in decrypted_samples {
        let end = (write_pointer + sample.len()).min(output.len());
        if write_pointer >= end {
            break;
        }
        output[write_pointer..end].copy_from_slice(&sample[..end - write_pointer]);
        write_pointer += sample.len();
    }
    replace_enca_with_mp4a(&mut output, stsd.offset, stsd.offset + stsd.size);
    output
}

/// 解密一首汽水音乐的加密音频。
///
/// `spade_a` 既可以是 32 位十六进制密钥，也可以是服务端下发的加密 blob（原实现的两种形态）；
/// 返回的 `extension` 决定 Content-Type（`.flac` → `audio/flac`，`.m4a` → `audio/mp4`）。
pub fn decrypt(
    encrypted: &[u8],
    spade_a: &str,
    media: TrackMedia<'_>,
) -> Result<DecryptedTrack, DecryptError> {
    if encrypted.is_empty() {
        return Err(DecryptError::new(
            "encryptedBuffer must be a non-empty Buffer.",
        ));
    }

    let key = resolve_key(spade_a)?;

    let moov = find_atom(encrypted, b"moov", 0, encrypted.len());
    if moov.is_empty() {
        return Err(DecryptError::new("Decrypt failed: 'moov' atom not found."));
    }

    let trak = find_atom(encrypted, b"trak", moov.offset + 8, moov.offset + moov.size);
    let mdia = find_atom(encrypted, b"mdia", trak.offset + 8, trak.offset + trak.size);
    let minf = find_atom(encrypted, b"minf", mdia.offset + 8, mdia.offset + mdia.size);
    let stbl = find_atom(encrypted, b"stbl", minf.offset + 8, minf.offset + minf.size);
    let stsd = find_atom(encrypted, b"stsd", stbl.offset + 8, stbl.offset + stbl.size);
    let stsz = find_atom(encrypted, b"stsz", stbl.offset + 8, stbl.offset + stbl.size);
    let stsc = find_atom(encrypted, b"stsc", stbl.offset + 8, stbl.offset + stbl.size);
    let stco = find_atom(encrypted, b"stco", stbl.offset + 8, stbl.offset + stbl.size);

    // `senc` 在 moov 下找不到才去 stbl 里找（两种封装都见过）。
    let mut senc = find_atom(encrypted, b"senc", moov.offset + 8, moov.offset + moov.size);
    if senc.is_empty() {
        senc = find_atom(encrypted, b"senc", stbl.offset + 8, stbl.offset + stbl.size);
    }
    if senc.is_empty() {
        return Err(DecryptError::new("Decrypt failed: 'senc' atom not found."));
    }

    let mdat = find_atom(encrypted, b"mdat", 0, encrypted.len());
    if mdat.is_empty() {
        return Err(DecryptError::new("Decrypt failed: 'mdat' atom not found."));
    }

    let flac_metadata = scan_for_flac_metadata(atom_payload(encrypted, stsd));
    let is_flac = !flac_metadata.is_empty();

    let sample_sizes = parse_stsz(atom_payload(encrypted, stsz));
    let _stsc_entries = parse_stsc(atom_payload(encrypted, stsc));
    let chunk_count = read_u32(atom_payload(encrypted, stco), 4).unwrap_or(0);
    let ivs = parse_senc(atom_payload(encrypted, senc));

    if sample_sizes.len() != ivs.len() {
        return Err(DecryptError::new(format!(
            "Decrypt failed: sample count {} does not match iv count {}.",
            sample_sizes.len(),
            ivs.len()
        )));
    }

    let decrypted_samples = decrypt_samples(encrypted, &key, &sample_sizes, &ivs, mdat.offset)?;

    let extension: Extension = if is_flac { ".flac" } else { ".m4a" };
    let buffer = if is_flac {
        build_flac_file(&flac_metadata, &decrypted_samples)
    } else {
        build_m4a_file(encrypted, &decrypted_samples, mdat, stsd)
    };

    Ok(DecryptedTrack {
        buffer,
        extension,
        file_name: create_file_name(media.title, media.artist, extension),
        meta: TrackMeta {
            is_flac,
            sample_count: sample_sizes.len(),
            chunk_count,
        },
    })
}
