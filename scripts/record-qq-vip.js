'use strict';

// 录制 server/qq-vip-api.js 的全部导出行为，产出 Rust 侧回放用的 cases.jsonl。
//
//   node scripts/record-qq-vip.js           输出到 stdout（人工抽查）
//   node scripts/record-qq-vip.js --write   直接写进 Rust 侧 fixture
//   node scripts/record-qq-vip.js --check   与 fixture 逐字节比对（CI 用）
//
// 为什么不用 rust-anything bridge：`bridge` 只认"导出函数、参数是普通 JSON"的单元。
// 这里 `resolveQQVipFromProbes` 的第二个参数是**函数**（注入的取数器），而且整模块
// 多处读 `Date.now()`；两件事都得靠"注入 + 冻钟"解决，工具生成的骨架表达不了。
//
// 两处环境固定，缺一条录制就不可复现：
//   1. `process.env.TZ = 'UTC'` —— `normalizedExpiryMs` 对字符串到期时间会走
//      `Date.parse`，而无时区的日期串在 V8 里按**本地时区**解释。钉成 UTC 后
//      "2024-01-01" 恒为 1704067200000，换台机器也一样。
//   2. `Date.now = () => NOW` —— 模块里有三处直接读墙钟（`qqVipObjectExpiry`、
//      `combineQQVipResults`、`qqVipCacheTtlMs` 的默认值）。冻住之后录制可复现，
//      Rust 侧对应函数把这些值收成显式参数（见 crates/mineradio-core/src/qq_vip.rs）。

process.env.TZ = 'UTC';

const qqVip = require('../server/qq-vip-api');

const T = qqVip._test;

/** 冻结时刻：2025-01-01T00:00:00Z。所有"未来/过去"的用例都相对它。 */
const NOW = 1735689600000;
const DAY = 86400000;
const FUTURE = NOW + 30 * DAY;
const PAST = NOW - DAY;

Date.now = () => NOW;

const toSeconds = (ms) => Math.floor(ms / 1000);

// ---------- 真实形状的 payload ----------

function activeVipPayload(uin, expiresAtMs) {
  return {
    code: 0,
    req_1: {
      code: 0,
      data: {
        uin_map: {
          [String(uin)]: {
            vip_info: {
              is_vip: true,
              vip_type: 1,
              end_time: toSeconds(expiresAtMs),
            },
          },
        },
      },
    },
  };
}

function ordinaryPayload(uin) {
  return {
    code: 0,
    req_1: {
      code: 0,
      data: {
        uin_map: {
          [String(uin)]: {
            vip_info: { is_vip: false, vip_type: 0 },
          },
        },
      },
    },
  };
}

function svipPayload(uin, expiresAtMs) {
  return {
    code: 0,
    data: {
      uin_map: {
        [String(uin)]: {
          svip_info: {
            is_svip: true,
            svip_type: 2,
            svip_end_time: toSeconds(expiresAtMs),
          },
        },
      },
    },
  };
}

// ---------- 各函数的用例 ----------

const cases = [];
function add(fn, args, note) {
  cases.push({ fn, args, note });
}

// canonicalQQVipKey
[
  ['VIP_Type', '下划线',
  ],
  ['green_vip_level', '绿钻等级键'],
  ['is-svip', '连字符'],
  ['a.b.c', '点号'],
  ['', '空串'],
  [null, 'null → 空串（String(v||\'\')）'],
  [0, '数字 0 是 falsy → 空串，不是 "0"'],
  [123, '非零数字被 String 化'],
  ['中文VIP', '中日韩字符被整段删掉，只留 ASCII 部分'],
  ['  VIP  ', '空白也删（不在 [a-z0-9] 里）'],
].forEach(([input, note]) => add('canonicalQQVipKey', [input], note));

// primitiveMembershipSignal
[
  [true, 'true → 1'],
  [false, 'false → 0'],
  [0, '0 → 0'],
  [1, '1 → 1'],
  [-3, '负数 → 0'],
  [0.4, '小数 >0 → 1'],
  ['1', '数字串'],
  ['0', '零数字串 → 0'],
  ['-3', '负数字串 → 0（正则允许负号）'],
  ['1.5', '小数串'],
  [' 1 ', '两侧空白 trim 后仍认'],
  ['', '空串 → null'],
  ['  ', '纯空白 → null'],
  ['true', 'true 字符串'],
  ['YES', '大写 yes（先 toLowerCase）'],
  ['active', 'active'],
  ['opened', 'opened'],
  ['open', 'open'],
  ['svip', 'svip'],
  ['premium', 'premium'],
  ['false', 'false 字符串'],
  ['no', 'no'],
  ['none', 'none'],
  ['ordinary', 'ordinary'],
  ['expired', 'expired'],
  ['closed', 'closed'],
  ['invalid', 'invalid'],
  ['已开通', '中文肯定'],
  ['豪华绿钻', '中文肯定'],
  ['未开通', '中文否定'],
  ['非会员', '中文否定'],
  ['maybe', '认不出的词 → null'],
  ['0x10', '十六进制串两个正则都不匹配 → null'],
  ['1e5', '科学计数法不匹配 → null'],
  [null, 'null → null（typeof object）'],
  [{}, '对象 → null'],
  [[], '数组 → null'],
].forEach(([input, note]) => add('primitiveMembershipSignal', [input], note));

// normalizedExpiryMs
[
  [0, '0 → 0'],
  [null, 'null → 0'],
  ['', '空串 → 0'],
  [1700000000, '秒级时间戳被 ×1000'],
  [1700000000000, '毫秒级原样'],
  [9999999999, '刚好小于 1e10 仍按秒'],
  [10000000000, '等于 1e10 不再乘'],
  [946684800, '2000-01-01 整点，乘千后正好过阈值'],
  [946684799, '差一秒，乘千后低于阈值 → 0'],
  [-1, '负数 → 0'],
  ['2024-01-01', 'ISO 日期串（TZ=UTC 下按 UTC）'],
  ['2024-01-01T00:00:00Z', '带 Z 的 ISO'],
  ['2024-01-01T00:00:00+08:00', '带偏移的 ISO'],
  [' 1700000000 ', '带空白的数字串'],
  ['abc', '解析不出 → 0'],
  [true, '布尔 true → Number 1 → ×1000 后仍低于阈值 → 0'],
  [false, 'false → 0'],
  [{}, '对象 → Number NaN，也不是字符串 → 0'],
  [[], '空数组 → Number 0 → 0'],
  [['2024-01-01'], '单元素数组 → Number NaN，typeof 不是 string → 0'],
].forEach(([input, note]) => add('normalizedExpiryMs', [input], note));

// assessQQVipObject
const assessCases = [
  [{ is_vip: true }, null, '单个 VIP 标志位'],
  [{ isvip: 1 }, null, '归一化后的键名'],
  [{ vip_type: 1 }, null, 'VIP 类型数值'],
  [{ vip_type: 0 }, null, 'VIP 类型为 0 → 否定'],
  [{ vip_type: 'abc' }, null, '类型值不可解析 → 有证据但两不靠'],
  [{ svip_type: 2 }, null, 'SVIP 类型'],
  [{ is_svip: true, is_vip: true }, null, '同时有两者'],
  [{ vipStatus: 'active' }, null, 'VIP 状态键 + 单词信号'],
  [{ svipStatus: 'expired' }, null, 'SVIP 状态键 + 否定信号'],
  [{ is_vip: '也许' }, null, '标志位给了认不出的值 → 不算证据'],
  [{ label: 'VIP' }, null, '只有文本标签：不认（没有成员键）'],
  [{ end_time: toSeconds(FUTURE), is_vip: true }, null, '带未来到期时间'],
  [{ end_time: toSeconds(PAST), is_vip: true }, null, '带已过期时间 → 翻成否定'],
  [{ vip_end_time: toSeconds(FUTURE) }, { membership: true, svip: false }, '在 membership 上下文里靠路径认到期键'],
  [{ end_time: toSeconds(FUTURE) }, { membership: true, svip: true }, 'svip 上下文 → 到期归 SVIP'],
  [{ vip_end_time: toSeconds(FUTURE), svip_end_time: toSeconds(FUTURE + DAY) }, null, 'VIP 与 SVIP 各自到期'],
  [{ level: 3 }, { membership: true, svip: false }, 'membership 上下文里的 level'],
  [{ level: 3 }, null, '没有上下文时 level 不算证据'],
  [{ status: 'vip' }, { membership: true, svip: true }, 'svip 上下文里的通用 status'],
  [{ vip_type: [1] }, null, '类型值是单元素数组（Number 强转成 1）'],
  [{ vip_type: {} }, null, '类型值是对象（Number → NaN）'],
  [{ vip_type: null }, null, '类型值是 null（Number 0，但 primitive 信号为 null）'],
  [{ is_vip: true, vip_type: 4, svip_type: 2 }, null, '三者并存，取最大值'],
];
for (const [obj, context, note] of assessCases) {
  add('assessQQVipObject', [obj, context, NOW], note);
}

// collectQQVipAssessments
add('collectQQVipAssessments', [{ vip_info: { is_vip: true } }, [], 0, NOW, ''], '路径里没有成员上下文，靠直接键');
add('collectQQVipAssessments', [{ end_time: toSeconds(FUTURE), vip_type: 1 }, [], 0, NOW, ''], '根节点就算一个作用域');
add('collectQQVipAssessments', [{ data: { vip_info: { is_vip: true } } }, [], 0, NOW, ''], '嵌套一层');
add(
  'collectQQVipAssessments',
  [{ data: { uin_map: { 10001: { vip_info: { is_vip: true } } } } }, [], 0, NOW, '10001'],
  '路径末段是 uin 且匹配',
);
add(
  'collectQQVipAssessments',
  [{ data: { uin_map: { 10001: { vip_info: { is_vip: true } } } } }, [], 0, NOW, '20002'],
  '路径末段是别的 uin → 整枝丢弃',
);
add(
  'collectQQVipAssessments',
  [{ data: { list: [{ uin: 10001, is_vip: true }, { uin: 20002, is_vip: true }] } }, [], 0, NOW, '10001'],
  '数组里按 directUin 过滤',
);
add(
  'collectQQVipAssessments',
  [{ data: { list: [{ uin: 'o10001', is_vip: true }] } }, [], 0, NOW, '10001'],
  'directUin 带 o 前缀与零填充',
);
add(
  'collectQQVipAssessments',
  [{ a: { b: { c: { d: { e: { f: { g: { h: { i: { is_vip: true } } } } } } } } } }, [], 0, NOW, ''],
  '超过 8 层深度就不再往下走',
);
add('collectQQVipAssessments', [null, [], 0, NOW, ''], 'null 直接返回空');
add('collectQQVipAssessments', ['just a string', [], 0, NOW, ''], '标量直接返回空');

// emptyQQVipStatus / qqVipObjectLooksExpired
add('emptyQQVipStatus', [], '空状态基线');
add('qqVipObjectLooksExpired', [{ vip_type: 1, vip_end_time: toSeconds(PAST) }, NOW], '有到期键且已过 → true');
add('qqVipObjectLooksExpired', [{ vip_type: 1, vip_end_time: toSeconds(FUTURE) }, NOW], '未过 → false');
add('qqVipObjectLooksExpired', [{ vip_end_time: toSeconds(PAST) }, NOW], '没有成员键 → 直接 false（present 为假）');
add('qqVipObjectLooksExpired', [{ vip_type: 1 }, NOW], '没有到期键 → false');
add('qqVipObjectLooksExpired', [{ vip_type: 1, vip_end_time: toSeconds(FUTURE) }, 0], 'now 传 0 会退回 Date.now()');

// normalizeQQVipPayload
add('normalizeQQVipPayload', [{ code: 0, data: {} }, null, { now: NOW }], '空响应 → unknown（不能当成普通账号）');
add('normalizeQQVipPayload', [{ code: 0, data: { vip_info: { label: 'VIP', title: 'Green Diamond' } } }, null, { now: NOW }], '只有文本标签 → 不提升');
add('normalizeQQVipPayload', [ordinaryPayload('10001'), null, { now: NOW }], '明确的普通账号 → negative');
add('normalizeQQVipPayload', [activeVipPayload('10001', FUTURE), null, { now: NOW }], '真实 uin_map 形状 → positive');
add('normalizeQQVipPayload', [activeVipPayload('10001', PAST), null, { now: NOW }], '到期时间已过 → negative');
add('normalizeQQVipPayload', [svipPayload('10001', FUTURE), null, { now: NOW }], 'SVIP 形状');
add('normalizeQQVipPayload', [{ data: { vip_info: { vip_type: 3 } } }, null, { now: NOW }], '只有 vip_type，正数');
add('normalizeQQVipPayload', [{ data: { is_vip: true } }, null, { now: NOW, expectedUin: '10001' }], 'expectedUin 存在但 payload 里没有 uin 字段 → 不做拦截');
add('normalizeQQVipPayload', [activeVipPayload('10001', FUTURE), null, { now: NOW, expectedUin: '10001' }], 'expectedUin 匹配');
add('normalizeQQVipPayload', [activeVipPayload('10001', FUTURE), null, { now: NOW, expectedUin: '20002' }], 'expectedUin 不匹配');
add(
  'normalizeQQVipPayload',
  [{ data: {} }, { isVip: true, vipType: 2, expiresAt: FUTURE }, { now: NOW }],
  '无法判定时回落到 fallback 的正向结论',
);
add(
  'normalizeQQVipPayload',
  [{ data: {} }, { membershipKnown: true, isVip: false }, { now: NOW }],
  'fallback 声明"已知且非会员" → negative',
);
add('normalizeQQVipPayload', [{ data: {} }, { vipLevel: 'svip', expiresAt: FUTURE }, { now: NOW }], 'fallback 只有 vipLevel=svip');
add('normalizeQQVipPayload', [{ data: { is_vip: false } }, { isVip: true }, { now: NOW }], '显式否定压过 fallback 的正向');
add(
  'normalizeQQVipPayload',
  [{ data: { list: [{ uin: 1, is_vip: true, vip_type: 1, vip_end_time: toSeconds(FUTURE) }, { uin: 2, is_vip: true, vip_type: 1, vip_end_time: toSeconds(FUTURE + DAY) }] } }, null, { now: NOW }],
  '多作用域时取最早到期',
);
add(
  'normalizeQQVipPayload',
  [{ data: { vip_info: { is_vip: true, vip_type: 1, vip_end_time: toSeconds(FUTURE) } } }, null, { now: NOW + 60 * DAY }],
  '换个 now，同一 payload 变成已过期',
);
add('normalizeQQVipPayload', [null, null, { now: NOW }], 'payload 为 null');
add('normalizeQQVipPayload', [{ data: { vip_info: { vip_type: '3' } } }, null, {}], 'options 为空对象时 now 退回 Date.now');

// combineQQVipResults
add('combineQQVipResults', [[]], '空数组');
add('combineQQVipResults', [null], '非数组');
add('combineQQVipResults', [[{ decision: 'positive', isVip: true, vipType: 1, vipExpiresAt: FUTURE }]], '单个正向后选最早到期');
add(
  'combineQQVipResults',
  [[
    { decision: 'positive', isVip: true, vipType: 1, vipExpiresAt: FUTURE },
    { decision: 'positive', isVip: true, vipType: 5, vipExpiresAt: FUTURE + DAY },
  ]],
  '多个正向取最大类型、最早到期',
);
add(
  'combineQQVipResults',
  [[
    { decision: 'positive', isVip: true, isSvip: true, vipLevel: 'svip', svipExpiresAt: FUTURE, vipExpiresAt: FUTURE + DAY },
  ]],
  'SVIP 正向：取 svipExpiresAt',
);
add('combineQQVipResults', [[{ decision: 'positive', isVip: true, vipExpiresAt: PAST }]], '到期时间已过 → 不参与取最小');
add('combineQQVipResults', [[{ decision: 'negative', membershipKnown: true, vipSource: 'probe-a', rawCode: 0 }]], '单个否定');
add('combineQQVipResults', [[{ decision: 'negative', membershipKnown: false }]], '只有未确认的否定 → unknown');
add(
  'combineQQVipResults',
  [[
    { decision: 'positive', isVip: true, vipType: 1, vipExpiresAt: FUTURE, vipSource: 'probe-b' },
    { decision: 'negative', membershipKnown: true, vipSource: 'probe-a', rawCode: 0 },
  ]],
  '正负混合时正向胜出，并带上最强那支的来源',
);
add('combineQQVipResults', [[null, null]], '数组里全是 null 被过滤');

// qqVipProbeResponseSuccessful
[
  [{ code: 0 }, null, 'code 0'],
  [{ result: 0 }, null, '只有 result 0'],
  [{ code: 1 }, null, 'code 非 0 → 失败'],
  [{ code: '0' }, null, '字符串 code 也能通过 Number 化'],
  [{ code: '1' }, null, '字符串 code 非 0 → 失败'],
  [{ code: 0, req_1: { code: 1 } }, { responseKey: 'req_1' }, '指定 responseKey 的块里 code 非 0'],
  [{ code: 0, req_1: { code: 0 } }, { responseKey: 'req_1' }, '指定块里 code 为 0'],
  [{ code: 0, req_1: { code: 1 } }, null, '没指定 responseKey 就不看块'],
  [{ code: { nested: 1 } }, null, 'code 是对象 → 被过滤掉，仍算成功'],
  [null, null, 'null body'],
  ['text', null, '字符串 body'],
].forEach(([body, probe, note]) => add('qqVipProbeResponseSuccessful', [body, probe], note));

// qqVipPayloadBelongsToUin
add('qqVipPayloadBelongsToUin', [{ uin: 10001 }, '10001'], '直接 uin 命中');
add('qqVipPayloadBelongsToUin', [{ uin: 'o010001' }, '10001'], '带 o 前缀与零填充');
add('qqVipPayloadBelongsToUin', [{ uin: 20002 }, '10001'], 'uin 不匹配');
add('qqVipPayloadBelongsToUin', [{ data: { uin_map: { 10001: { a: 1 } } } }, '10001'], '键名是 uin 且值是对象');
add('qqVipPayloadBelongsToUin', [{ data: { uin_map: { 10001: 'scalar' } } }, '10001'], '键名是 uin 但值不是对象 → 不算');
add('qqVipPayloadBelongsToUin', [null, '10001'], 'payload 为 null');
add('qqVipPayloadBelongsToUin', [{ uin: 10001 }, ''], 'uin 为空 → false');
add('qqVipPayloadBelongsToUin', [{ a: { b: { c: { d: { e: { f: { g: { h: { i: { uin: 10001 } } } } } } } } } }, '10001'], '超过深度上限后放弃');
add('qqVipPayloadBelongsToUin', [{ data: { list: [{ uin: 20002 }, { uin: 10001 }] } }, '10001'], '数组里翻到匹配的那个');
add('qqVipPayloadBelongsToUin', [{ data: { list: [{ uin: 20002 }] } }, '10001'], '数组里没有匹配 → false');

// qqVipPayloadScopesForUin
add('qqVipPayloadScopesForUin', [activeVipPayload('10001', FUTURE), '10001'], '真实 uin_map 形状');
add('qqVipPayloadScopesForUin', [activeVipPayload('10001', FUTURE), '20002'], 'uin 不匹配 → 空');
add('qqVipPayloadScopesForUin', [{ data: { list: [{ uin: 10001, a: 1 }, { uin: 20002, b: 2 }] } }, '10001'], '数组里只取匹配的那个');
add('qqVipPayloadScopesForUin', [{ uin: 10001, nested: { uin: 10001 } }, '10001'], '自身与子节点都命中');
add('qqVipPayloadScopesForUin', [{ data: { uin_map: { 10001: { vip_info: { is_vip: true } } } } }, '10001'], '键名即 uin 的作用域整体带回');

// resolveQQVipFromProbes
const probe = (uin, source, responseKey) => ({ uin, source, responseKey });

// `responses[i]` 是第 i 支探测的返回值：`{ ok: body }` 正常返回，`{ err: '...' }` 抛出。
// 两个都塞进 args，Rust 侧照着重放（`null` 表示"没有取数函数"这个分支）。
async function resolveCase(probes, responses, note) {
  const list = Array.isArray(probes) ? probes : [];
  const requestProbe = Array.isArray(responses)
    ? async (item) => {
      const index = list.indexOf(item);
      const response = responses[index] || { ok: null };
      if (Object.prototype.hasOwnProperty.call(response, 'err')) throw new Error(response.err);
      return response.ok;
    }
    : null;
  const ok = await qqVip.resolveQQVipFromProbes(probes, requestProbe);
  cases.push({ fn: 'resolveQQVipFromProbes', args: [probes, responses === null ? null : responses], ok, note });
}

async function main() {
  add('qqVipSessionCacheKey', [10001, 'musickey-abc', {}], '常规情况');
  add('qqVipSessionCacheKey', ['o010001', 'musickey-abc', {}], 'uin 带 o 前缀：只保留数字');
  add('qqVipSessionCacheKey', [10001, 'musickey-abc', { login_type: '2' }], 'cookie 里带 login_type');
  add('qqVipSessionCacheKey', [10001, '', {}], 'musicKey 为空 → 空串');
  add('qqVipSessionCacheKey', ['', 'musickey-abc', {}], 'uin 为空 → 空串');
  add(
    'qqVipSessionCacheKey',
    [10001, 'musickey-abc', { login_type: '2', qm_keyst: 'k', qqmusic_key: 'q', music_key: 'm', wxskey: 'w', psrf_qqaccess_token: 'a', psrf_qqrefresh_token: 'r' }],
    'cookie 里六个字段全给',
  );
  add('qqVipSessionCacheKey', [10001, 'musickey-abc', null], 'cookieObj 为 null');

  add('qqVipCacheTtlMs', [null, { now: NOW }], 'null 状态 → 0');
  add('qqVipCacheTtlMs', [T.emptyQQVipStatus(), { now: NOW }], 'unknown 状态 → 0');
  add('qqVipCacheTtlMs', [{ resolved: true, membershipKnown: true, isVip: false }, { now: NOW }], '否定结论用 negativeTtl');
  add('qqVipCacheTtlMs', [{ resolved: true, membershipKnown: true, isVip: true, expiresAt: 0 }, { now: NOW }], '正向但无到期时间 → positiveTtl');
  add('qqVipCacheTtlMs', [{ resolved: true, membershipKnown: true, isVip: true, expiresAt: NOW + 60000 }, { now: NOW }], '到期时间早于 TTL → 取剩余时间');
  add('qqVipCacheTtlMs', [{ resolved: true, membershipKnown: true, isVip: true, expiresAt: PAST }, { now: NOW }], '到期时间已过 → 0');
  add(
    'qqVipCacheTtlMs',
    [{ resolved: true, membershipKnown: true, isVip: true, expiresAt: NOW + 600000 }, { now: NOW, positiveTtlMs: 1000, negativeTtlMs: 2000 }],
    '自定义两个 TTL',
  );

  add('qqVipEntitlementRights', [null], 'null → 最低档');
  add('qqVipEntitlementRights', [{ membershipKnown: true, isVip: true }], 'VIP');
  add('qqVipEntitlementRights', [{ membershipKnown: true, isSvip: true }], 'SVIP');
  add('qqVipEntitlementRights', [{ membershipKnown: true, isVip: true, membershipStale: true }], 'stale 正向 → 不算 verified');
  add('qqVipEntitlementRights', [{ vipLevel: 'vip' }], '只有 vipLevel');
  add('qqVipEntitlementRights', [{ membershipKnown: false, isVip: true }], '有 isVip 但未知 → 不给权限');

  add('preserveQQVipStalePositive', [null, null], '缓存为空、新状态也为空');
  add(
    'preserveQQVipStalePositive',
    [{ value: { isVip: true, resolved: true, membershipKnown: true, expiresAt: FUTURE }, expiresAt: NOW - 1000 }, null],
    '缓存正向、新状态探测不完整 → 沿用过期的正向',
  );
  add(
    'preserveQQVipStalePositive',
    [{ value: { isVip: true, resolved: true, membershipKnown: true, expiresAt: FUTURE }, expiresAt: NOW - 1000 }, { decision: 'unknown', resolved: false }],
    '新状态明确 unknown → 沿用',
  );
  add(
    'preserveQQVipStalePositive',
    [{ value: { isVip: true, resolved: true, membershipKnown: true, expiresAt: FUTURE }, expiresAt: NOW - 1000 }, { decision: 'negative', resolved: true, authoritativeNegative: true }],
    '新状态是权威否定 → 立刻采信',
  );
  add(
    'preserveQQVipStalePositive',
    [{ value: { isVip: true, resolved: true, membershipKnown: true, expiresAt: FUTURE }, expiresAt: NOW - 1000 }, { isVip: true, resolved: true }],
    '新状态也是正向 → 用新的',
  );
  add(
    'preserveQQVipStalePositive',
    [{ value: { isVip: true, resolved: true, membershipKnown: true, expiresAt: PAST }, expiresAt: NOW - 1000 }, null],
    '缓存里的权益本身已过期 → 不沿用',
  );
  add(
    'preserveQQVipStalePositive',
    [{ value: { isVip: true, resolved: true, membershipKnown: true, expiresAt: FUTURE }, expiresAt: NOW - 20 * 60000, staleUntil: NOW + 1000 }, null],
    '把 staleUntil 带进结果',
  );
  add(
    'preserveQQVipStalePositive',
    [{ value: { isVip: true, resolved: true, membershipKnown: true, expiresAt: FUTURE }, expiresAt: NOW - 20 * 60000 }, { decision: 'negative', resolved: false }],
    '探测说否定但不完整 → 结果里记下证据冲突',
  );
  add(
    'preserveQQVipStalePositive',
    [{ isVip: true, resolved: true, membershipKnown: true, expiresAt: FUTURE, expiresAt2: 1 }, null],
    'cachedEntry 没有 value 包装，直接当状态用',
  );
  add(
    'preserveQQVipStalePositive',
    [{ value: { isVip: false, resolved: true, membershipKnown: true }, expiresAt: NOW }, null],
    '缓存不是正向 → 直接返回新状态',
  );

  const resolves = [
    [async () => resolveCase([probe('10001', 'a', 'req_1'), probe('10001', 'b')], [{ ok: activeVipPayload('10001', FUTURE) }, { ok: activeVipPayload('10001', FUTURE) }], '两支都正向')],
    [async () => resolveCase([probe('10001', 'a', 'req_1'), probe('10001', 'b')], [{ ok: ordinaryPayload('10001') }, { ok: ordinaryPayload('10001') }], '两支都权威否定（达到 quorum）')],
    [async () => resolveCase([probe('10001', 'a', 'req_1'), probe('10001', 'b')], [{ ok: ordinaryPayload('10001') }, { err: 'boom' }], '一支否定一支抛错 → 达不到 quorum')],
    [async () => resolveCase([probe('10001', 'a', 'req_1')], [{ ok: ordinaryPayload('10001') }], '单支否定：quorum 为 1')],
    [async () => resolveCase([probe('10001', 'a', 'req_1')], [{ ok: activeVipPayload('20002', FUTURE) }], 'payload 属于别的 uin → 不匹配账号')],
    [async () => resolveCase([probe('10001', 'a', 'req_1')], [{ ok: { code: 1 } }], '探测返回业务错误码 → probeSuccessful 为假')],
    [async () => resolveCase([probe('10001', 'a', 'req_1')], [{ ok: null }], '探测返回 null')],
    [async () => resolveCase([], [], '空探测列表')],
    [async () => resolveCase(null, null, 'probes 不是数组')],
  ];
  for (const [run] of resolves) await run();
}

const fs = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, '..', 'crates', 'mineradio-core', 'tests', 'fixtures', 'qq-vip-cases.jsonl');

const CALLS = {
  canonicalQQVipKey: ([a]) => T.canonicalQQVipKey(a),
  primitiveMembershipSignal: ([a]) => T.primitiveMembershipSignal(a),
  normalizedExpiryMs: ([a]) => T.normalizedExpiryMs(a),
  assessQQVipObject: ([obj, context, now]) => T.assessQQVipObject(obj, context, now),
  collectQQVipAssessments: ([value, pathParts, depth, now, uin]) => T.collectQQVipAssessments(value, [], pathParts, depth, now, uin),
  emptyQQVipStatus: () => T.emptyQQVipStatus(),
  qqVipObjectLooksExpired: ([obj, now]) => qqVip.qqVipObjectLooksExpired(obj, now),
  normalizeQQVipPayload: ([payload, fallback, options]) => qqVip.normalizeQQVipPayload(payload, fallback, options),
  combineQQVipResults: ([results]) => qqVip.combineQQVipResults(results),
  qqVipProbeResponseSuccessful: ([body, p]) => T.qqVipProbeResponseSuccessful(body, p),
  qqVipPayloadBelongsToUin: ([payload, uin]) => T.qqVipPayloadBelongsToUin(payload, uin),
  qqVipPayloadScopesForUin: ([payload, uin]) => T.qqVipPayloadScopesForUin(payload, uin),
  qqVipSessionCacheKey: ([uin, key, cookie]) => qqVip.qqVipSessionCacheKey(uin, key, cookie),
  qqVipCacheTtlMs: ([status, options]) => qqVip.qqVipCacheTtlMs(status, options),
  qqVipEntitlementRights: ([status]) => qqVip.qqVipEntitlementRights(status),
  preserveQQVipStalePositive: ([cached, next, options]) => qqVip.preserveQQVipStalePositive(cached, next, options),
};

(async () => {
  await main();

  const lines = cases.map((item) => {
    const ok = item.ok !== undefined ? item.ok : CALLS[item.fn](item.args);
    return JSON.stringify({ fn: item.fn, args: item.args, ok, note: item.note });
  });

  const text = lines.join('\n') + '\n';
  const summary = `共 ${lines.length} 条（now=${NOW}，TZ=UTC）`;

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : '';
    if (current !== text) {
      const expected = text.split('\n');
      const actual = current.split('\n');
      const firstDiff = expected.findIndex((line, index) => line !== actual[index]);
      console.error('FAIL fixture 与 server/qq-vip-api.js 的当前行为不一致');
      console.error(`     文件：${path.relative(path.join(__dirname, '..'), FIXTURE_PATH)}`);
      console.error(`     第 ${firstDiff + 1} 条起不同`);
      console.error(`     重录：node scripts/record-qq-vip.js --write`);
      if (firstDiff >= 0) {
        console.error(`     当前：${String(actual[firstDiff]).slice(0, 200)}`);
        console.error(`     应有：${String(expected[firstDiff]).slice(0, 200)}`);
      }
      process.exit(1);
    }
    console.log(`OK QQ VIP fixture 一致：${summary}`);
    process.exit(0);
  }

  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, text, 'utf8');
    console.log(`已写入 ${path.relative(path.join(__dirname, '..'), FIXTURE_PATH)}`);
    console.log(`  ${summary}`);
    process.exit(0);
  }

  process.stdout.write(text);
  process.stderr.write(summary + '\n');
})();
