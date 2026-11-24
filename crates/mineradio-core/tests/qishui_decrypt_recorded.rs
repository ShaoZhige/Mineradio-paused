//! 用 `scripts/record-qishui-decrypt.js` 录到的原始 JS 输出当基准，逐条回放
//! `mineradio_core::qishui_decrypt`。
//!
//! fixture 是 `ztest/ra-qishui-decrypt/cases.jsonl` 的副本（`ztest/` 被 gitignore，进不了 CI）。
//! 重新录制：
//!
//! ```bash
//! node scripts/record-qishui-decrypt.js > ztest/ra-qishui-decrypt/cases.jsonl
//! cp ztest/ra-qishui-decrypt/cases.jsonl crates/mineradio-core/tests/fixtures/qishui-decrypt-cases.jsonl
//! ```
//!
//! 这条测试红了，说明移植代码与原 JS 不一致，而不是 fixture 过期
//! （只在有人改 `server/qishui-audio-decryptor/` 时才该重录）。

use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use mineradio_core::qishui_decrypt::{
    aes_ctr_decrypt, decrypt, decrypt_spade_a, hex_to_buffer, parse_senc, parse_stsc, parse_stsz,
    replace_enca_with_mp4a, sanitize_filename_part, scan_for_flac_metadata, TrackMedia,
};
use serde_json::Value;

fn fixture_lines() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("qishui-decrypt-cases.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到 fixture {}：{e}", path.display()));
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("fixture 行不是合法 JSON"))
        .collect()
}

/// fixture 里的二进制统一写成 `{"b64": "..."}`。
fn bytes(value: &Value) -> Vec<u8> {
    let text = value["b64"].as_str().expect("二进制字段应有 b64");
    STANDARD.decode(text).expect("b64 解不开")
}

fn opt_str(value: &Value) -> Option<&str> {
    value.as_str()
}

#[test]
fn replay_matches_recorded_javascript() {
    let cases = fixture_lines();
    assert!(
        cases.len() >= 41,
        "fixture 只剩 {} 条，可能被截断",
        cases.len()
    );

    let mut checked = 0;
    for case in &cases {
        let func = case["fn"].as_str().expect("fn 应为字符串");
        let args = case["args"].as_array().expect("args 应为数组");
        let note = case["note"].as_str().unwrap_or("");
        let expected_err = case.get("err").and_then(Value::as_str);

        match func {
            "TrackDecryptor.decrypt" => {
                let encrypted = bytes(&args[0]);
                let spade_a = args[1].as_str().expect("spade_a 应为字符串");
                let media = TrackMedia {
                    title: opt_str(&args[2]),
                    artist: opt_str(&args[3]),
                };
                let actual = decrypt(&encrypted, spade_a, media);
                match expected_err {
                    Some(expected) => assert_eq!(
                        actual.expect_err("JS 抛错了，Rust 却成功").message(),
                        expected,
                        "错误消息不一致 [{note}]"
                    ),
                    None => {
                        let actual = actual.expect("JS 成功，Rust 却报错");
                        let expected = &case["ok"];
                        // 有一条用例只比对返回的形状（不带 buffer），别去解不存在的字段。
                        if expected.get("buffer").is_some() {
                            assert_eq!(
                                actual.buffer,
                                bytes(&expected["buffer"]),
                                "解密出的字节不一致 [{note}]"
                            );
                        }
                        assert_eq!(actual.extension, expected["extension"].as_str().unwrap());
                        assert_eq!(actual.file_name, expected["fileName"].as_str().unwrap());
                        assert_eq!(
                            actual.meta.is_flac,
                            expected["meta"]["isFlac"].as_bool().unwrap()
                        );
                        assert_eq!(
                            actual.meta.sample_count as u64,
                            expected["meta"]["sampleCount"].as_u64().unwrap()
                        );
                        assert_eq!(
                            actual.meta.chunk_count as u64,
                            expected["meta"]["chunkCount"].as_u64().unwrap()
                        );
                    }
                }
            }
            "decryptSpadeA" => {
                let actual = decrypt_spade_a(args[0].as_str().unwrap());
                assert_eq!(
                    actual,
                    case["ok"].as_str().unwrap(),
                    "decryptSpadeA [{note}]"
                );
            }
            "hexToBuffer" => {
                let actual = hex_to_buffer(args[0].as_str().unwrap());
                match expected_err {
                    Some(expected) => assert_eq!(
                        actual.expect_err("JS 抛错了").message(),
                        expected,
                        "hexToBuffer 错误消息 [{note}]"
                    ),
                    None => assert_eq!(actual.unwrap(), bytes(&case["ok"]), "hexToBuffer [{note}]"),
                }
            }
            "aesCtrDecrypt" => {
                let actual = aes_ctr_decrypt(&bytes(&args[0]), &bytes(&args[1]), &bytes(&args[2]))
                    .expect("aesCtrDecrypt 不该失败");
                assert_eq!(actual, bytes(&case["ok"]), "aesCtrDecrypt [{note}]");
            }
            "parseStsz" => {
                let actual: Vec<u64> = parse_stsz(&bytes(&args[0]))
                    .into_iter()
                    .map(u64::from)
                    .collect();
                let expected: Vec<u64> = case["ok"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap())
                    .collect();
                assert_eq!(actual, expected, "parseStsz [{note}]");
            }
            "parseStsc" => {
                let actual = parse_stsc(&bytes(&args[0]));
                let expected = case["ok"].as_array().unwrap();
                assert_eq!(actual.len(), expected.len(), "parseStsc 长度 [{note}]");
                for (entry, want) in actual.iter().zip(expected) {
                    assert_eq!(
                        entry.first_chunk as u64,
                        want["firstChunk"].as_u64().unwrap()
                    );
                    assert_eq!(
                        entry.samples_per_chunk as u64,
                        want["samplesPerChunk"].as_u64().unwrap()
                    );
                    assert_eq!(entry.id as u64, want["id"].as_u64().unwrap());
                }
            }
            "parseSenc" => {
                let actual = parse_senc(&bytes(&args[0]));
                let expected = case["ok"].as_array().unwrap();
                assert_eq!(actual.len(), expected.len(), "parseSenc 长度 [{note}]");
                for (iv, want) in actual.iter().zip(expected) {
                    assert_eq!(iv.to_vec(), bytes(want), "parseSenc 的 IV [{note}]");
                }
            }
            "scanForFlacMetadata" => {
                let actual = scan_for_flac_metadata(&bytes(&args[0]));
                assert_eq!(actual, bytes(&case["ok"]), "scanForFlacMetadata [{note}]");
            }
            "replaceEncaWithMp4a" => {
                let mut target = bytes(&args[0]);
                let start = args[1].as_u64().unwrap() as usize;
                let end = args[2].as_u64().unwrap() as usize;
                replace_enca_with_mp4a(&mut target, start, end);
                assert_eq!(target, bytes(&case["ok"]), "replaceEncaWithMp4a [{note}]");
            }
            "sanitizeFilenamePart" => {
                let actual = sanitize_filename_part(opt_str(&args[0]), args[1].as_str().unwrap());
                assert_eq!(
                    actual,
                    case["ok"].as_str().unwrap(),
                    "sanitizeFilenamePart [{note}]"
                );
            }
            other => panic!("fixture 里出现了未知函数名 {other}"),
        }
        checked += 1;
    }
    assert_eq!(checked, cases.len());
}
