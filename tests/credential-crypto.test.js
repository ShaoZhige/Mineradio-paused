// 凭证加密落盘的回归测试：加解密往返、密文格式、篡改检测、明文兼容、
// safeStorage 不可用降级、JSON 加解密、原地迁移、源码接线守卫。
// Regression tests for credential-at-rest encryption: round-trip, envelope format,
// tamper detection, plaintext compatibility, safeStorage-unavailable fallback,
// JSON helpers, in-place migration, and source-wiring guards.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cryptoLib = require('../desktop/credential-crypto');
const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const SERVER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
const QISHUI_API_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server', 'qishui-api.js'), 'utf8');
const SPOTIFY_API_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'server', 'spotify-api.js'), 'utf8');

const TEST_KEY_HEX = 'a'.repeat(64); // 32 字节测试主密钥

function setupTestKey(keyFile) {
  cryptoLib.resetKeyCache();
  cryptoLib.__installTestKey(keyFile, TEST_KEY_HEX);
}

test('encryptCredential 产生 MR1 信封且可解密回原文', () => {
  const tmp = path.join(os.tmpdir(), 'cred-test-' + process.pid + '.key');
  setupTestKey(tmp);
  const plain = 'MUSIC_U=abc123; __csrf=xyz; oscurpsy=deadbeef';
  const ct = cryptoLib.encryptCredential(plain, tmp);
  assert.ok(ct.startsWith(cryptoLib.MAGIC), '密文应以 MAGIC 开头');
  assert.ok(cryptoLib.isEncryptedEnvelope(ct), 'isEncryptedEnvelope 应识别');
  assert.notStrictEqual(ct, plain, '密文不应等于明文');
  assert.strictEqual(cryptoLib.decryptCredential(ct, tmp), plain, '解密应还原原文');
});

test('AES-GCM 认证：篡改密文后解密返回空串而非脏数据', () => {
  const tmp = path.join(os.tmpdir(), 'cred-tamper-' + process.pid + '.key');
  setupTestKey(tmp);
  const plain = 'sessionid=secret_value';
  const ct = cryptoLib.encryptCredential(plain, tmp);
  // 翻转信封末尾一个字符（改动 base64 → 改动密文或 tag）
  const tampered = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
  assert.strictEqual(cryptoLib.decryptCredential(tampered, tmp), '', '篡改后应返回空串');
});

test('明文输入：decryptCredential 原样返回（过渡期兼容）', () => {
  const tmp = path.join(os.tmpdir(), 'cred-plain-' + process.pid + '.key');
  setupTestKey(tmp);
  const plain = 'MUSIC_U=legacy_cookie_without_encryption';
  assert.strictEqual(cryptoLib.decryptCredential(plain, tmp), plain, '非信封应原样返回');
  assert.strictEqual(cryptoLib.isEncryptedEnvelope(plain), false, '明文不应被判为信封');
});

test('空串：加密后仍可识别为信封或明文，解密回空', () => {
  const tmp = path.join(os.tmpdir(), 'cred-empty-' + process.pid + '.key');
  setupTestKey(tmp);
  const ct = cryptoLib.encryptCredential('', tmp);
  // 空明文加密后仍是合法信封（iv|tag + 空密文）
  assert.ok(cryptoLib.isEncryptedEnvelope(ct), '空串加密后应是信封');
  assert.strictEqual(cryptoLib.decryptCredential(ct, tmp), '', '空明文解密回空');
});

test('JSON 加解密往返', () => {
  const tmp = path.join(os.tmpdir(), 'cred-json-' + process.pid + '.key');
  setupTestKey(tmp);
  const obj = { accessToken: 'tok_abc', refreshToken: 'ref_xyz', expiresAt: 1700000000 };
  const ct = cryptoLib.encryptJson(obj, tmp);
  assert.ok(cryptoLib.isEncryptedEnvelope(ct), 'JSON 加密应是信封');
  const back = cryptoLib.decryptJson(ct, tmp);
  assert.deepStrictEqual(back, obj, 'JSON 解密应还原原对象');
});

test('JSON 明文兼容：decryptJson 解析明文 JSON', () => {
  const tmp = path.join(os.tmpdir(), 'cred-jsonplain-' + process.pid + '.key');
  setupTestKey(tmp);
  const plain = '{"accessToken":"tok","refreshToken":"ref"}';
  const back = cryptoLib.decryptJson(plain, tmp);
  assert.strictEqual(back.accessToken, 'tok', '明文 JSON 应能解析');
});

test('不同主密钥：旧密文解不开返回空（模拟换机器/换账户）', () => {
  const keyA = path.join(os.tmpdir(), 'cred-keyA-' + process.pid + '.key');
  const keyB = path.join(os.tmpdir(), 'cred-keyB-' + process.pid + '.key');
  cryptoLib.resetKeyCache();
  cryptoLib.__installTestKey(keyA, 'a'.repeat(64));
  cryptoLib.__installTestKey(keyB, 'b'.repeat(64));
  const ct = cryptoLib.encryptCredential('secret', keyA);
  assert.strictEqual(cryptoLib.decryptCredential(ct, keyB), '', '不同主密钥应解不出');
  assert.strictEqual(cryptoLib.decryptCredential(ct, keyA), 'secret', '原主密钥能解出');
});

test('encryptFileInPlace：明文文件原地加密，已是密文则跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-mig-'));
  const keyFile = path.join(dir, '.credential-key');
  setupTestKey(keyFile);
  const file = path.join(dir, '.cookie');
  fs.writeFileSync(file, 'MUSIC_U=plain_token', 'utf8');
  assert.strictEqual(cryptoLib.encryptFileInPlace(file, keyFile), true, '明文应被加密');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(cryptoLib.isEncryptedEnvelope(after), '加密后应是信封');
  assert.strictEqual(cryptoLib.encryptFileInPlace(file, keyFile), false, '已是密文应跳过');
});

test('defaultKeyPathFor：与凭证文件同目录的 .credential-key', () => {
  const cred = path.join(os.tmpdir(), 'userdata', '.cookie');
  assert.strictEqual(
    cryptoLib.defaultKeyPathFor(cred),
    path.join(path.dirname(cred), '.credential-key'),
    '主密钥应在凭证同目录'
  );
});

test('源码接线：main.js 注入 safeStorage 并在 server require 前调用迁移', () => {
  assert.match(MAIN_SOURCE, /safeStorage\s*\}/, 'main.js 应从 electron 解构 safeStorage');
  assert.match(MAIN_SOURCE, /installSafeStorage\(safeStorage\)/, '应调用 installSafeStorage');
  assert.match(MAIN_SOURCE, /migratePlainCredentialsToEncrypted\(\)/, '应调用迁移函数');
  // 迁移必须在 require server.js 之前
  const migIdx = MAIN_SOURCE.indexOf('migratePlainCredentialsToEncrypted()');
  const reqIdx = MAIN_SOURCE.indexOf("require(serverModulePath)");
  assert.ok(migIdx > -1 && reqIdx > -1 && migIdx < reqIdx, '迁移应在 require server 之前');
});

test('源码接线：server.js 的读写点走 credential-crypto', () => {
  assert.match(SERVER_SOURCE, /require\('\.\.\/desktop\/credential-crypto'\)/, 'server.js 应 require credential-crypto');
  assert.match(SERVER_SOURCE, /isEncryptedEnvelope/, '读取时应判信封');
  assert.match(SERVER_SOURCE, /encryptCredential/, '写入时应加密');
});

test('源码接线：qishui-api 与 spotify-api 走 credential-crypto', () => {
  assert.match(QISHUI_API_SOURCE, /require\('\.\.\/desktop\/credential-crypto'\)/, 'qishui-api 应 require credential-crypto');
  assert.match(SPOTIFY_API_SOURCE, /require\('\.\.\/desktop\/credential-crypto'\)/, 'spotify-api 应 require credential-crypto');
  assert.match(SPOTIFY_API_SOURCE, /readCredentialJsonFile/, 'spotify-api 应有 readCredentialJsonFile 辅助');
});
