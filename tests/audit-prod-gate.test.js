const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const gate = require(path.join(appRoot, 'scripts', 'audit-prod.js'));

const ALLOWED_ID = 'GHSA-86w9-cpqp-85rv';

function auditOf(vulnerabilities) {
  return {
    auditReportVersion: 2,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: Object.keys(vulnerabilities).length },
    },
    vulnerabilities,
  };
}

function advisory(id, name, severity, title) {
  return {
    source: 1,
    name,
    dependency: name,
    title,
    url: `https://github.com/advisories/${id}`,
    severity,
    cwe: [],
    range: '*',
  };
}

function nodeForgeEntry() {
  return {
    name: 'node-forge',
    severity: 'high',
    isDirect: false,
    via: [advisory(ALLOWED_ID, 'node-forge', 'high', 'node-forge RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements')],
    effects: ['NeteaseCloudMusicApi'],
    range: '*',
  };
}

test('the shipped allowlist is well formed, so a typo cannot turn the gate into a rubber stamp', () => {
  assert.deepStrictEqual(gate.validateAllowlist(gate.ALLOWED_ADVISORIES), []);
  for (const entry of gate.ALLOWED_ADVISORIES) {
    assert.match(entry.id, /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
    // 放行依据和复查触发条件都得写出来，长度下限只是防"随手占位"。
    assert.ok(entry.reason.trim().length >= 60, `${entry.id} 的 reason 太短，无法当依据看`);
    assert.ok(entry.recheck.trim().length >= 20, `${entry.id} 的 recheck 太短，无法当复查条件看`);
  }
});

test('a malformed allowlist is rejected rather than silently waving advisories through', () => {
  const good = (over) => ({ id: ALLOWED_ID, package: 'node-forge', severity: 'high', reason: 'r'.repeat(60), recheck: 'c'.repeat(20), ...over });
  assert.ok(gate.validateAllowlist([good({ id: 'CVE-2026-0001' })]).length > 0, 'id 不是 GHSA 编号');
  assert.ok(gate.validateAllowlist([good({ severity: 'medium' })]).length > 0, 'severity 不在允许集合');
  assert.ok(gate.validateAllowlist([good({ package: '' })]).length > 0, 'package 缺失');
  assert.ok(gate.validateAllowlist([good({ reason: '太短' })]).length > 0, 'reason 过短');
  assert.ok(gate.validateAllowlist([good({ recheck: '' })]).length > 0, 'recheck 缺失');
  assert.ok(gate.validateAllowlist([good(), good()]).length > 0, '同一个 id 重复登记');
  assert.ok(gate.validateAllowlist('not-an-array').length > 0);
});

test('unparseable audit output fails the gate instead of reading as clean', () => {
  assert.strictEqual(gate.parseAuditJson(''), null);
  assert.strictEqual(gate.parseAuditJson('   '), null);
  assert.strictEqual(gate.parseAuditJson('npm ERR! something exploded'), null);
  // `npm audit` 报错时也会吐出合法 JSON，但没有 metadata —— 必须当作工具坏了。
  assert.strictEqual(gate.parseAuditJson('{"error":{"code":"ENOLOCK","summary":"no lockfile"}}'), null);
  assert.strictEqual(gate.parseAuditJson('{"metadata":{}}'), null);
  assert.strictEqual(gate.parseAuditJson('{"metadata":{"vulnerabilities":{"total":"2"}}}'), null);
  const parsed = gate.parseAuditJson('{"metadata":{"vulnerabilities":{"total":0}}}');
  assert.strictEqual(parsed.metadata.vulnerabilities.total, 0);
});

test('the current production tree passes: only the allowlisted advisory remains', () => {
  const audit = auditOf({
    NeteaseCloudMusicApi: { name: 'NeteaseCloudMusicApi', severity: 'high', isDirect: true, via: ['node-forge'], effects: [], range: '>=4.14.0' },
    'node-forge': nodeForgeEntry(),
  });
  const verdict = gate.evaluate(audit, gate.ALLOWED_ADVISORIES);
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(verdict.unexpected, []);
  assert.deepStrictEqual(verdict.stale, []);
  assert.deepStrictEqual(verdict.reported.map((a) => a.id), [ALLOWED_ID]);
  // via 里只有字符串的包只是"被牵连"，不能当作新公告，否则会多出一条永远匹配不上的假条目。
  assert.deepStrictEqual(verdict.inherited, ['NeteaseCloudMusicApi']);
  assert.strictEqual(verdict.counts.total, 2);
});

test('a new advisory fails the gate and is named in the verdict', () => {
  const audit = auditOf({
    'node-forge': nodeForgeEntry(),
    undici: {
      name: 'undici',
      severity: 'high',
      isDirect: false,
      via: [advisory('GHSA-1111-2222-3333', 'undici', 'high', 'undici TLS certificate validation bypass')],
      effects: [],
      range: '>=7.24.1 <7.29.1',
    },
  });
  const verdict = gate.evaluate(audit, gate.ALLOWED_ADVISORIES);
  assert.strictEqual(verdict.ok, false);
  assert.deepStrictEqual(verdict.unexpected.map((a) => a.id), ['GHSA-1111-2222-3333']);
  assert.strictEqual(verdict.unexpected[0].package, 'undici');
  assert.deepStrictEqual(verdict.stale, []);
});

test('a stale allowlist entry fails the gate, so an exemption cannot quietly outlive its reason', () => {
  const audit = auditOf({
    undici: {
      name: 'undici',
      severity: 'high',
      isDirect: false,
      via: [advisory('GHSA-1111-2222-3333', 'undici', 'high', 'undici TLS certificate validation bypass')],
      effects: [],
      range: '>=7.24.1 <7.29.1',
    },
  });
  const verdict = gate.evaluate(audit, gate.ALLOWED_ADVISORIES);
  assert.strictEqual(verdict.ok, false);
  assert.deepStrictEqual(verdict.stale, [ALLOWED_ID]);
});

test('a fully clean tree passes with an empty allowlist', () => {
  const verdict = gate.evaluate(auditOf({}), []);
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(verdict.reported, []);
  assert.deepStrictEqual(verdict.stale, []);
});

test('the npm audit workflow really runs the gate instead of swallowing the production report', () => {
  const workflow = fs.readFileSync(path.join(appRoot, '.github', 'workflows', 'npm-audit.yml'), 'utf8');
  const lines = workflow.split(/\r?\n/);
  // 只认 `run:` 行：注释里也会提到脚本名，按子串匹配会把说明文字当成调用。
  const runLines = lines.filter((line) => /^\s*run:.*scripts\/audit-prod\.js/.test(line));
  assert.strictEqual(runLines.length, 1, '生产审计必须恰好由一个步骤调用闸门');
  assert.ok(!runLines[0].includes('|| true'), '生产审计闸门不得吞掉失败');
  const nameLine = lines.slice(0, lines.indexOf(runLines[0])).reverse().find((line) => /^\s*-\s*name:/.test(line));
  assert.ok(nameLine, '闸门必须落在一个具名步骤里');
  assert.doesNotMatch(nameLine, /\(report only\)|\(advisory\)/, '生产审计不再是仅信息步骤');
  // 含 devDependencies 的那一份保持仅信息，且必须自述，否则诚实性守卫会拦下。
  const devStep = lines.find((line) => /^\s*-\s*name:.*Audit all dependencies/.test(line));
  assert.ok(devStep, '全量审计步骤必须保留并具名');
  assert.match(devStep, /\(report only\)/, '全量审计必须自述为仅信息');
});
