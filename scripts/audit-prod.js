#!/usr/bin/env node
'use strict';

// 生产依赖漏洞闸门 / Production dependency vulnerability gate.
//
// 为什么不直接拿 `npm audit --omit=dev` 的退出码当门禁：生产树里还剩一条**上游没有修复版**的
// 公告（node-forge 的 RSA PKCS#1 v1.5 验签，公告区间 `<=1.4.0`，而 1.4.0 就是最新版）。
// npm 愿意给的唯一"修复"是把 NeteaseCloudMusicApi 降级到 4.13.6 —— 拿 19 个次版本的功能与修复
// 去换一条本项目根本走不到的代码路径，不采纳。直接当门禁的话它会永远是红的，红就成了噪声。
//
// 所以改成白名单制，并且**三个方向都会失败**：
//   1. 出现白名单之外的公告          -> 失败（新问题必须有人看见）
//   2. 白名单里的公告不再被报告      -> 失败（条目已过期，必须删掉；白名单不许长青苔）
//   3. audit 跑不起来 / 输出不可解析 -> 失败（工具坏了不能当成"没有漏洞"）
// 这样白名单里每一条都被一条真能失败的判据盯着，而不是一句口头承诺。
//
// Why not just gate on the exit code of `npm audit --omit=dev`: one advisory in the production
// tree has no upstream fix (node-forge RSA PKCS#1 v1.5 signature verification — advisory range
// `<=1.4.0`, and 1.4.0 is the newest release). The only "fix" npm offers is downgrading
// NeteaseCloudMusicApi to 4.13.6, trading 19 minor versions of fixes for a code path this app
// never executes. As a plain gate it would sit red forever, and permanent red is just noise.
//
// Hence an allowlist that can fail in three ways: a new advisory fails, an allowlisted advisory
// that stops being reported fails (a stale entry is a lie), and a broken `npm audit` fails
// instead of reading as "clean".

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 允许放行的公告。新增条目必须写清 reason（为什么可以放行）与 recheck（什么时候回来复查），
// 否则 validateAllowlist 会拒绝运行闸门。
// Allowed advisories. Every entry must state why it is acceptable and when to re-check it.
const ALLOWED_ADVISORIES = [
  {
    id: 'GHSA-86w9-cpqp-85rv',
    package: 'node-forge',
    severity: 'high',
    reason:
      '上游未发布修复版：公告区间为 `<=1.4.0`，而 node-forge 最新版就是 1.4.0，没有可升的版本（CWE-347）。' +
      '该公告针对 RSA PKCS#1 v1.5 签名**验签**，而本项目对 node-forge 的全部用法只有 ' +
      '`forge.pki.publicKeyFromPem()` + `publicKey.encrypt()` + `forge.util.bytesToHex()` ' +
      '（见 NeteaseCloudMusicApi/util/crypto.js 的 rsaEncrypt），全程不触碰验签路径。' +
      'npm 给出的降级建议（NeteaseCloudMusicApi 退到 4.13.6）不采纳。',
    recheck:
      'node-forge 发布 >1.4.0 时立即复查本条；上游 NeteaseCloudMusicApi 换掉该依赖时删除本条。',
  },
];

const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical']);
const GHSA_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

function ok(msg) {
  process.stdout.write(`[OK] ${msg}\n`);
}

function err(msg) {
  process.stderr.write(`[ERR] ${msg}\n`);
}

// 校验白名单本身。id 写错会让"新出现的公告"永远匹配不上白名单，闸门反而静默放行，
// 所以缺字段、id 不合法、id 重名一律当场失败。
// Validate the allowlist itself: a typo in an id would make a new advisory unmatchable, which
// silently turns the gate into a rubber stamp.
function validateAllowlist(allowlist) {
  const problems = [];
  const seen = new Set();
  if (!Array.isArray(allowlist)) return ['白名单必须是数组 / allowlist must be an array'];
  for (const entry of allowlist) {
    const id = entry && entry.id;
    if (typeof id !== 'string' || !GHSA_ID.test(id)) {
      problems.push(`白名单条目缺少合法的 GHSA 编号 / invalid GHSA id: ${JSON.stringify(id)}`);
      continue;
    }
    if (seen.has(id)) problems.push(`白名单里 ${id} 重复 / duplicate entry`);
    seen.add(id);
    if (typeof entry.package !== 'string' || !entry.package.trim()) {
      problems.push(`白名单条目 ${id} 缺少 package / missing package`);
    }
    if (!SEVERITIES.has(entry.severity)) {
      problems.push(`白名单条目 ${id} 的 severity 必须是 low/moderate/high/critical`);
    }
    for (const field of ['reason', 'recheck']) {
      if (typeof entry[field] !== 'string' || entry[field].trim().length < 20) {
        problems.push(`白名单条目 ${id} 的 ${field} 缺失或过于简短，无法当依据看 / ${field} missing or too short`);
      }
    }
  }
  return problems;
}

// `npm audit --json` 在"发现漏洞"时退出码是 1，所以退出码不能用来判断成败，必须解析 JSON。
// 解析不出结构就是工具坏了 —— 返回 null，由调用方失败，绝不当作"没有漏洞"。
// `npm audit --json` exits 1 when it finds something, so the exit code carries no signal here.
// Unparseable output means the tool is broken: return null and let the caller fail closed.
function parseAuditJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const metadata = parsed.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  if (!metadata.vulnerabilities || typeof metadata.vulnerabilities !== 'object') return null;
  if (typeof metadata.vulnerabilities.total !== 'number') return null;
  return parsed;
}

// 把 audit 的 `vulnerabilities` 摊平成两块：
//   - advisories：自己就有公告的包（`via` 里是对象）
//   - inherited ：自己没公告、只是因为依赖了有洞的包而被标记（`via` 里是字符串，如 node-forge 的宿主）
// 只有前者参与白名单匹配；后者只作展示，否则会多出一条永远匹配不上的假条目。
// Flatten `vulnerabilities` into real advisories (object entries in `via`) and dependents that are
// only flagged because something they depend on is vulnerable (string entries). Only the former
// participate in allowlist matching.
function collectAdvisories(audit) {
  const advisories = new Map();
  const inherited = new Set();
  const vulnerabilities = (audit && audit.vulnerabilities) || {};
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const via = Array.isArray(entry && entry.via) ? entry.via : [];
    const direct = via.filter((item) => item && typeof item === 'object');
    if (direct.length === 0) {
      inherited.add(name);
      continue;
    }
    for (const item of direct) {
      const fromUrl = String(item.url || '').split('/').filter(Boolean).pop() || '';
      // 没有 url 的公告用 包名 + 标题 拼一个稳定标识，仍然会被归为"白名单之外"从而让闸门失败。
      // Advisories without a url still get a stable id so they can never be silently absorbed.
      const id = fromUrl || `${item.name || name}: ${item.title || 'unknown advisory'}`;
      if (!advisories.has(id)) {
        advisories.set(id, {
          id,
          package: item.name || name,
          severity: item.severity || (entry && entry.severity) || 'unknown',
          title: item.title || '',
        });
      }
    }
  }
  return { advisories, inherited };
}

function evaluate(audit, allowlist) {
  const { advisories, inherited } = collectAdvisories(audit);
  const allowedIds = new Set(allowlist.map((entry) => entry.id));
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  const unexpected = [...advisories.values()].filter((a) => !allowedIds.has(a.id)).sort(byId);
  const stale = allowlist.filter((entry) => !advisories.has(entry.id)).map((entry) => entry.id);
  return {
    ok: unexpected.length === 0 && stale.length === 0,
    unexpected,
    stale,
    reported: [...advisories.values()].sort(byId),
    inherited: [...inherited].sort(),
    counts: (audit && audit.metadata && audit.metadata.vulnerabilities) || null,
  };
}

function runNpmAudit() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // 用临时文件而不是管道接住 npm 的 stdout/stderr：
  //   - Windows 下 `npm` 是 .cmd，不经 shell 启动会 EINVAL，经 shell 启动再配管道则在部分受管环境里
  //     因为无法为子进程建管道而直接 EBUSY（实测），文件描述符没这个问题；
  //   - 顺带避开管道缓冲区上限 —— audit 的 JSON 可能远大于默认 maxBuffer。
  //   - stdout 与 stderr 分开两个文件，避免 npm 的告警混进 JSON 里。
  // Capture the child's streams through temp files instead of pipes: on Windows `npm` is a .cmd
  // (needs a shell, which then cannot always create pipes on locked-down hosts), and this also
  // sidesteps pipe buffer limits. stdout and stderr go to separate files so warnings cannot
  // corrupt the JSON.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-audit-'));
  const stdoutFile = path.join(dir, 'stdout.json');
  const stderrFile = path.join(dir, 'stderr.txt');
  const stdoutFd = fs.openSync(stdoutFile, 'w');
  const stderrFd = fs.openSync(stderrFile, 'w');
  let result;
  try {
    result = spawnSync(npm, ['audit', '--omit=dev', '--json'], {
      stdio: ['ignore', stdoutFd, stderrFd],
      shell: process.platform === 'win32',
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const captured = { status: result.status, error: result.error, stdout: read(stdoutFile), stderr: read(stderrFile) };
  fs.rmSync(dir, { recursive: true, force: true });
  return captured;
}

function main() {
  const allowlistProblems = validateAllowlist(ALLOWED_ADVISORIES);
  if (allowlistProblems.length) {
    allowlistProblems.forEach(err);
    err('白名单不合法，闸门拒绝运行 / allowlist invalid, refusing to run the gate.');
    return 1;
  }

  const result = runNpmAudit();
  if (result.error) {
    err(`无法执行 npm audit / could not spawn npm audit: ${result.error.message}`);
    return 1;
  }
  const audit = parseAuditJson(result.stdout);
  if (!audit) {
    err(
      `npm audit 没有产出可解析的 JSON（退出码 ${result.status}），不能当作"没有漏洞" /` +
        ' unparseable audit output is a failure, not a pass.',
    );
    err(`stdout head: ${String(result.stdout || '').slice(0, 400)}`);
    err(`stderr head: ${String(result.stderr || '').slice(0, 400)}`);
    return 1;
  }

  const verdict = evaluate(audit, ALLOWED_ADVISORIES);
  const counts = verdict.counts || {};
  process.stdout.write(
    `npm audit --omit=dev: total=${counts.total} critical=${counts.critical} high=${counts.high}` +
      ` moderate=${counts.moderate} low=${counts.low}\n`,
  );

  for (const entry of ALLOWED_ADVISORIES) {
    const hit = verdict.reported.find((a) => a.id === entry.id);
    if (hit) ok(`allowlisted ${hit.severity} ${hit.id} (${hit.package}) — ${hit.title}`);
  }
  if (verdict.inherited.length) {
    ok(`flagged only as dependents of the above / 仅因依赖上述公告被牵连: ${verdict.inherited.join(', ')}`);
  }
  for (const hit of verdict.unexpected) {
    err(`新公告 / NEW ${hit.severity} advisory ${hit.id} (${hit.package}): ${hit.title}`);
  }
  for (const id of verdict.stale) {
    err(`白名单条目 ${id} 已不再被报告，属于过期条目，必须删除并重新核对依赖树 / allowlist entry is stale, delete it.`);
  }
  if (!verdict.ok) {
    err('生产依赖闸门未通过 / production dependency gate FAILED.');
    return 1;
  }

  ok(
    `production tree is clean apart from ${ALLOWED_ADVISORIES.length} allowlisted advisory(ies) with no upstream fix` +
      ' / 生产树除白名单外干净。',
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  ALLOWED_ADVISORIES,
  collectAdvisories,
  evaluate,
  main,
  parseAuditJson,
  runNpmAudit,
  validateAllowlist,
};
