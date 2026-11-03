// 凭证加密的「覆盖面」回归：落盘改加密之后，凡是读这些文件的地方都必须解密。
// 这类问题的表现是**静默失效**——不报错、不红闸门、用户只看到功能没了，所以逐条钉住。
// Coverage regression for credential-at-rest encryption: every reader must decrypt.
// The failure mode is silent (no thrown error, no red gate), so each path is pinned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cryptoLib = require('../desktop/credential-crypto');
const qishuiApi = require('../server/qishui-api');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const VERIFY_PACKAGE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-package.js'), 'utf8');

const TEST_KEY_HEX = 'c'.repeat(64);
const internals = qishuiApi._test || {};

function makeCredentialDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cred-cover-${tag}-`));
  return {
    dir,
    keyFile: path.join(dir, '.credential-key'),
    file: (name) => path.join(dir, name),
  };
}

function writeEncryptedJson(filePath, keyFile, value) {
  cryptoLib.resetKeyCache();
  cryptoLib.__installTestKey(keyFile, TEST_KEY_HEX);
  fs.writeFileSync(filePath, cryptoLib.encryptCredential(JSON.stringify(value), keyFile), 'utf8');
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// ---------------------------------------------------------------------------
// 1. OAuth 客户端密钥（clientKey / clientSecret）——原先完全没进加密范围
// ---------------------------------------------------------------------------

test('OAuth 客户端密钥加密后仍能读出 clientSecret', () => {
  const { keyFile, file } = makeCredentialDir('oauth');
  const target = file('.qishui-oauth.json');
  writeEncryptedJson(target, keyFile, {
    clientKey: 'ck_from_file',
    clientSecret: 'cs_from_file',
    redirectUri: 'https://127.0.0.1:43879/callback',
    scope: 'user_info',
  });
  const config = withEnv('QISHUI_OAUTH_CONFIG_FILE', target, () => internals.readQishuiOAuthFileConfig());
  assert.strictEqual(config.clientSecret, 'cs_from_file', '加密的 clientSecret 必须能读回');
  assert.strictEqual(config.clientKey, 'ck_from_file', '加密的 clientKey 必须能读回');
});

test('OAuth 配置的明文文件仍然兼容（过渡期）', () => {
  const { file } = makeCredentialDir('oauthplain');
  const target = file('.qishui-oauth.json');
  fs.writeFileSync(target, JSON.stringify({ clientKey: 'pk', clientSecret: 'ps' }), 'utf8');
  const config = withEnv('QISHUI_OAUTH_CONFIG_FILE', target, () => internals.readQishuiOAuthFileConfig());
  assert.strictEqual(config.clientSecret, 'ps', '明文旧文件不应被加密层打断');
});

// ---------------------------------------------------------------------------
// 2. 扫码登录配置里的 deviceId —— 签名与登录态绑定，读不到就会静默错位
// ---------------------------------------------------------------------------

test('签名设备身份能读出加密后的 deviceId', () => {
  const { keyFile, file } = makeCredentialDir('qr');
  const target = file('.qishui-qr-login.json');
  writeEncryptedJson(target, keyFile, { deviceId: '741071700001' });
  const value = withEnv('QISHUI_QR_CONFIG_FILE', target, () => internals.qishuiPersistedDeviceId());
  assert.strictEqual(value, '741071700001', '加密文件里的 deviceId 必须能读回，否则签名身份与登录时不一致');
});

test('设备身份的明文文件仍然兼容，非法值返回空串', () => {
  const { file } = makeCredentialDir('qrplain');
  const ok = file('.qishui-qr-login.json');
  fs.writeFileSync(ok, JSON.stringify({ deviceId: '123456789012' }), 'utf8');
  assert.strictEqual(withEnv('QISHUI_QR_CONFIG_FILE', ok, () => internals.qishuiPersistedDeviceId()), '123456789012');

  const bad = file('bad.json');
  fs.writeFileSync(bad, JSON.stringify({ deviceId: 'not-a-device' }), 'utf8');
  assert.strictEqual(withEnv('QISHUI_QR_CONFIG_FILE', bad, () => internals.qishuiPersistedDeviceId()), '');
});

// ---------------------------------------------------------------------------
// 3. 迁移范围：OAuth 密钥与 Spotify 覆盖路径都必须被加密
// ---------------------------------------------------------------------------

test('迁移清单覆盖 OAuth 客户端密钥与 Spotify 覆盖路径', () => {
  // 清单现在只有一个出口：credentialFilePaths()。解锁、迁移、导出都读它，
  // 所以守卫盯这里，而不是某个具体调用方。
  const start = MAIN_SOURCE.indexOf('function credentialFilePaths()');
  const end = MAIN_SOURCE.indexOf('async function unlockCredentialCrypto()');
  assert.ok(start > -1 && end > start, '应能定位 credentialFilePaths 的函数体');
  const body = MAIN_SOURCE.slice(start, end);
  assert.match(body, /process\.env\.QISHUI_OAUTH_CONFIG_FILE/, '迁移应包含 .qishui-oauth.json（存 clientSecret）');
  assert.match(body, /process\.env\.MINERADIO_SPOTIFY_CONFIG_FILE/, '迁移应包含 Spotify 的覆盖路径');
});

test('丢失恢复的校验会先解密，否则加密文件永远判为无效', () => {
  const start = MAIN_SOURCE.indexOf('function appOwnedMigrationFileValid(');
  const end = MAIN_SOURCE.indexOf('function migrateMisplacedAppOwnedFiles(');
  assert.ok(start > -1 && end > start, '应能定位 appOwnedMigrationFileValid 的函数体');
  const body = MAIN_SOURCE.slice(start, end);
  assert.match(body, /isEncryptedEnvelope/, '校验前必须识别密文信封');
  assert.match(body, /decryptCredential/, '校验前必须解密');
});

// ---------------------------------------------------------------------------
// 4. 导出登录 cookie：不能把密文当 cookie 写出去
// ---------------------------------------------------------------------------

test('导出登录 cookie 之前先解密', () => {
  assert.match(MAIN_SOURCE, /function readCredentialTextForExport\(/, '应有导出用的解密辅助');
  assert.match(MAIN_SOURCE, /const text = readCredentialTextForExport\(source\)/, '导出必须走解密辅助');
  assert.doesNotMatch(MAIN_SOURCE, /const text = fs\.readFileSync\(source, 'utf8'\);/, '不允许再裸读源文件当作导出内容');
});

// ---------------------------------------------------------------------------
// 5. 打包校验：新增的令牌与主密钥也要进敏感文件清单
// ---------------------------------------------------------------------------

test('打包校验的敏感文件清单包含 Spotify 令牌与凭证主密钥', () => {
  assert.match(VERIFY_PACKAGE_SOURCE, /'\.spotify-token\.json'/, '缺少 .spotify-token.json');
  assert.match(VERIFY_PACKAGE_SOURCE, /'\.credential-key'/, '缺少 .credential-key（主密钥）');
});
