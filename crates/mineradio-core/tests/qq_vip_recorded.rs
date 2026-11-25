//! 回放 `scripts/record-qq-vip.js` 录下的 197 条行为，逐条比对 JSON。
//!
//! 每条用例的形状是 `{fn, args, ok, note}`，`args` 就是当初喂给 JS 的入参。
//! 唯一的"翻译"是墙钟：JS 里有四处直接读 `Date.now()`，录制时冻在
//! [`FROZEN_NOW`]；Rust 侧对应函数把时间收成参数，这里按 JS 的
//! `Number(x) || Date.now()` 语义把 `0` / 缺省映射回同一个值。
//!
//! 重录：`node scripts/record-qq-vip.js --write`（`npm run qqvip:check` 检查是否同步）。

use std::future::ready;

use mineradio_core::qq_vip::{
    assess_qq_vip_object, canonical_qq_vip_key, collect_qq_vip_assessments, combine_qq_vip_results,
    js_number, js_string, js_truthy, normalize_qq_vip_payload, normalized_expiry_ms,
    preserve_qq_vip_stale_positive, primitive_membership_signal, qq_vip_cache_ttl_ms,
    qq_vip_entitlement_rights, qq_vip_object_looks_expired, qq_vip_payload_belongs_to_uin,
    qq_vip_payload_scopes_for_uin, qq_vip_probe_response_successful, qq_vip_session_cache_key,
    resolve_qq_vip_from_probes, CacheTtlOptions, MembershipContext, NormalizeOptions, QqVipStatus,
    StalePositiveOptions,
};
use serde_json::Value;

/// 录制时的冻结时刻：2025-01-01T00:00:00Z。
type ReadyProbe = fn(&Value) -> std::future::Ready<Result<Value, String>>;
const FROZEN_NOW: i64 = 1_735_689_600_000;

fn cases() -> Vec<Value> {
    let raw = include_str!("fixtures/qq-vip-cases.jsonl");
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture 行不是合法 JSON"))
        .collect()
}

/// JS 的 `Number(value) || Date.now()`。
fn js_now(options: &Value) -> i64 {
    let candidate = options.get("now").map(js_number).unwrap_or(f64::NAN);
    if candidate.is_finite() && candidate != 0.0 {
        candidate as i64
    } else {
        FROZEN_NOW
    }
}

fn context_of(value: &Value) -> Option<MembershipContext> {
    if value.is_null() {
        return None;
    }
    Some(MembershipContext {
        membership: value.get("membership").map(js_truthy).unwrap_or(false),
        svip: value.get("svip").map(js_truthy).unwrap_or(false),
    })
}

fn statuses_of(value: &Value) -> Vec<QqVipStatus> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter(|item| js_truthy(item))
            .map(QqVipStatus::from_value)
            .collect(),
        _ => Vec::new(),
    }
}

fn number_or_null(signal: Option<i32>) -> Value {
    match signal {
        Some(value) => Value::from(value),
        None => Value::Null,
    }
}

async fn run(case: &Value) -> Value {
    let function = case["fn"].as_str().expect("缺 fn");
    let args = &case["args"];
    let arg = |index: usize| -> Value { args.get(index).cloned().unwrap_or(Value::Null) };

    match function {
        "canonicalQQVipKey" => Value::from(canonical_qq_vip_key(&arg(0))),
        "primitiveMembershipSignal" => number_or_null(primitive_membership_signal(&arg(0))),
        "normalizedExpiryMs" => {
            let value = normalized_expiry_ms(&arg(0));
            if value.is_finite() && value.fract() == 0.0 {
                Value::from(value as i64)
            } else {
                Value::from(value)
            }
        }
        "assessQQVipObject" => {
            let context = context_of(&arg(1));
            let now = arg(2).as_f64().unwrap_or(0.0);
            assess_qq_vip_object(&arg(0), context.as_ref(), now).to_json()
        }
        "collectQQVipAssessments" => {
            let path: Vec<String> = arg(1)
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| item.as_str().unwrap_or_default().to_string())
                        .collect()
                })
                .unwrap_or_default();
            let depth = arg(2).as_u64().unwrap_or(0) as usize;
            let now = arg(3).as_f64().unwrap_or(0.0);
            let uin = arg(4).as_str().unwrap_or_default().to_string();
            Value::Array(
                collect_qq_vip_assessments(&arg(0), &path, depth, now, &uin)
                    .iter()
                    .map(|assessment| assessment.to_json())
                    .collect(),
            )
        }
        "emptyQQVipStatus" => QqVipStatus::empty().to_value(),
        "qqVipObjectLooksExpired" => {
            // JS 里 `Number(now) || Date.now()`：传 0 等于"没给"。
            let raw = arg(1).as_f64().unwrap_or(0.0);
            let now = if raw == 0.0 { FROZEN_NOW as f64 } else { raw };
            Value::Bool(qq_vip_object_looks_expired(&arg(0), now))
        }
        "normalizeQQVipPayload" => {
            let payload = arg(0);
            let fallback = arg(1);
            let options = arg(2);
            let expected_uin = options
                .get("expectedUin")
                .map(|value| {
                    value
                        .as_str()
                        .map(|text| text.to_string())
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            let status = normalize_qq_vip_payload(
                &payload,
                if fallback.is_null() {
                    None
                } else {
                    Some(&fallback)
                },
                &NormalizeOptions {
                    now_ms: js_now(&options),
                    expected_uin,
                },
            );
            status.to_value()
        }
        "combineQQVipResults" => {
            let results = statuses_of(&arg(0));
            combine_qq_vip_results(&results, FROZEN_NOW).to_value()
        }
        "qqVipProbeResponseSuccessful" => {
            let probe = arg(1);
            Value::Bool(qq_vip_probe_response_successful(
                &arg(0),
                if probe.is_null() { None } else { Some(&probe) },
            ))
        }
        "qqVipPayloadBelongsToUin" => {
            let uin = arg(1).as_str().unwrap_or_default().to_string();
            Value::Bool(qq_vip_payload_belongs_to_uin(&arg(0), &uin))
        }
        "qqVipPayloadScopesForUin" => {
            let uin = arg(1).as_str().unwrap_or_default().to_string();
            Value::Array(qq_vip_payload_scopes_for_uin(&arg(0), &uin))
        }
        "qqVipSessionCacheKey" => {
            let uin = match arg(0) {
                Value::String(text) => text,
                Value::Null => String::new(),
                other => js_string(&other),
            };
            let music_key = match arg(1) {
                Value::String(text) => text,
                Value::Null => String::new(),
                other => js_string(&other),
            };
            let cookie = arg(2);
            Value::from(qq_vip_session_cache_key(
                &uin,
                &music_key,
                if cookie.is_null() {
                    None
                } else {
                    Some(&cookie)
                },
            ))
        }
        "qqVipCacheTtlMs" => {
            let status = arg(0);
            let options = arg(1);
            let status = if status.is_null() {
                None
            } else {
                Some(QqVipStatus::from_value(&status))
            };
            let ttl = qq_vip_cache_ttl_ms(
                status.as_ref(),
                &CacheTtlOptions {
                    now_ms: js_now(&options),
                    positive_ttl_ms: options.get("positiveTtlMs").map(js_number),
                    negative_ttl_ms: options.get("negativeTtlMs").map(js_number),
                },
            );
            if ttl.is_finite() && ttl.fract() == 0.0 {
                Value::from(ttl as i64)
            } else {
                Value::from(ttl)
            }
        }
        "qqVipEntitlementRights" => {
            let status = arg(0);
            let status = if status.is_null() {
                None
            } else {
                Some(QqVipStatus::from_value(&status))
            };
            qq_vip_entitlement_rights(status.as_ref())
        }
        "preserveQQVipStalePositive" => {
            let cached = arg(0);
            let next = arg(1);
            let next_status = if next.is_null() {
                None
            } else {
                Some(QqVipStatus::from_value(&next))
            };
            let result = preserve_qq_vip_stale_positive(
                if cached.is_null() {
                    None
                } else {
                    Some(&cached)
                },
                next_status.as_ref(),
                &StalePositiveOptions {
                    now_ms: Some(FROZEN_NOW),
                    grace_ms: None,
                },
            );
            match result {
                Some(status) => status.to_value(),
                None => Value::Null,
            }
        }
        "resolveQQVipFromProbes" => {
            let probes_value = arg(0);
            let responses_value = arg(1);
            let probes: Vec<Value> = match &probes_value {
                Value::Array(items) => items.clone(),
                _ => Vec::new(),
            };
            if !probes_value.is_array() || responses_value.is_null() {
                // 对应 JS 的"probes 不是数组 / 没给取数函数"两条分支。
                return resolve_qq_vip_from_probes::<ReadyProbe, _>(&probes, None, FROZEN_NOW)
                    .await
                    .to_value();
            }
            let responses = responses_value.clone();
            let seek = probes.clone();
            let request_probe = move |probe: &Value| {
                let index = seek.iter().position(|item| item == probe);
                let response = index
                    .and_then(|index| responses.get(index).cloned())
                    .unwrap_or(Value::Null);
                match response.get("err") {
                    Some(Value::String(detail)) => ready(Err(detail.clone())),
                    _ => ready(Ok(response.get("ok").cloned().unwrap_or(Value::Null))),
                }
            };
            resolve_qq_vip_from_probes(&probes, Some(&request_probe), FROZEN_NOW)
                .await
                .to_value()
        }
        other => panic!("fixture 里出现了未覆盖的函数：{other}"),
    }
}

#[tokio::test]
async fn replays_every_recorded_case() {
    let cases = cases();
    assert!(
        cases.len() >= 190,
        "fixture 只剩 {} 条，可能被截断",
        cases.len()
    );
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let actual = run(case).await;
        let expected = case["ok"].clone();
        if actual != expected {
            failures.push(format!(
                "#{index} {}（{}）\n  录制：{}\n  实际：{}",
                case["fn"].as_str().unwrap_or("?"),
                case["note"].as_str().unwrap_or(""),
                serde_json::to_string(&expected).unwrap_or_default(),
                serde_json::to_string(&actual).unwrap_or_default()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} / {} 条不一致：\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn fixture_covers_every_exported_function() {
    let names: Vec<String> = cases()
        .iter()
        .map(|case| case["fn"].as_str().unwrap_or_default().to_string())
        .collect();
    for expected in [
        "canonicalQQVipKey",
        "primitiveMembershipSignal",
        "normalizedExpiryMs",
        "assessQQVipObject",
        "collectQQVipAssessments",
        "emptyQQVipStatus",
        "qqVipObjectLooksExpired",
        "normalizeQQVipPayload",
        "combineQQVipResults",
        "qqVipProbeResponseSuccessful",
        "qqVipPayloadBelongsToUin",
        "qqVipPayloadScopesForUin",
        "resolveQQVipFromProbes",
        "qqVipSessionCacheKey",
        "qqVipCacheTtlMs",
        "qqVipEntitlementRights",
        "preserveQQVipStalePositive",
    ] {
        assert!(
            names.iter().any(|name| name == expected),
            "fixture 里没有 {expected} 的用例"
        );
    }
}
