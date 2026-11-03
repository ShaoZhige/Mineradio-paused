// 主密钥落盘格式与异步解锁的回归。
// 这里钉的是一个**只在真机上才会发作**的 bug：DPAPI 密文是随机字节，早先的实现把它
// 当 utf8 字符串写盘、再当 utf8 读回，UTF-8 解码会替换非法序列——64 字节读回来能变 113 字节，
// 主密钥永远解不开，于是第二次启动悄悄换一把新密钥，之前加密的凭证全部报废。
// 纯 ASCII 的测试数据完全看不出来，所以这里用「模拟重启」把这条链走一遍。
// Regression for the master-key file format and the async unlock. The bug being pinned only
// shows up on a real machine: DPAPI output is random bytes, and treating them as UTF-8 text
// mangles them (64 bytes came back as 113), so the key could never be decrypted and a fresh
// key was silently generated on the next launch, orphaning every credential.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cryptoLib = require('../desktop/credential-crypto');

const ROOT = path.join(__dirname, '..');
const CRYPTO_SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'credential-crypto.js'), 'utf8');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');

// 假的系统凭据库：不碰 DPAPI，但把「输入输出都是原始字节」这个关键性质保留下来。
// A fake OS credential store: no DPAPI, but it keeps the property that matters —
// inputs and outputs are raw bytes, not text.
function fakeSafeStorage() {
  const state = { shouldReEncrypt: false, sealCount: 0 };
  return {
    state,
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plainText) => {
      state.sealCount += 1;
      return Buffer.concat([Buffer.from('SEALED\u0000'), Buffer.from(String(plainText), 'utf8')]);
    },
    decryptStringAsync: async (blob) => {
      const bytes = Buffer.from(blob);
      const head = Buffer.from('SEALED\u0000');
      if (bytes.length < head.length || !bytes.subarray(0, head.length).equals(head)) {
        throw new Error('bad blob');
      }
      return { result: bytes.subarray(head.length).toString('utf8'), shouldReEncrypt: state.shouldReEncrypt };
    },
  };
}

function freshDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cred-key-${tag}-`));
  return { dir, keyFile: path.join(dir, '.credential-key') };
}

function resetCrypto() {
  cryptoLib.installSafeStorage(null);
  cryptoLib.resetKeyCache();
}

test('主密钥以 MRK1 base64 信封落盘，不是裸 DPAPI 字节', async () => {
  resetCrypto();
  const { keyFile } = freshDir('fmt');
  const store = fakeSafeStorage();
  const key = await cryptoLib.prepareMasterKeyAsync(store, keyFile);
  assert.ok(Buffer.isBuffer(key) && key.length === 32, '应解锁出 32 字节主密钥');
  const text = fs.readFileSync(keyFile, 'utf8').trim();
  assert.ok(text.startsWith(cryptoLib.KEY_FILE_MAGIC), '主密钥文件必须以 MRK1: 开头');
  const raw = Buffer.from(text.slice(cryptoLib.KEY_FILE_MAGIC.length), 'base64');
  assert.ok(raw.length > 0, 'base64 解出的 DPAPI 密文不能为空');
  assert.ok(raw.includes(Buffer.from('SEALED\u0000')), '解出来的应是原样的 DPAPI 字节，而不是被 utf8 洗过一遍');
});

test('模拟重启：缓存清空后重新解锁，旧密文仍能解开', async () => {
  resetCrypto();
  const { keyFile } = freshDir('restart');
  const store = fakeSafeStorage();
  await cryptoLib.prepareMasterKeyAsync(store, keyFile);
  const envelope = cryptoLib.encryptCredential('MUSIC_U=keepme', keyFile);
  assert.ok(cryptoLib.isEncryptedEnvelope(envelope), '应产生 MR1 信封');

  // 进程重启：内存缓存没了，只剩磁盘上的主密钥文件。
  cryptoLib.resetKeyCache();
  const reloaded = await cryptoLib.prepareMasterKeyAsync(store, keyFile);
  assert.ok(Buffer.isBuffer(reloaded), '重启后必须能重新解锁主密钥');
  assert.strictEqual(cryptoLib.decryptCredential(envelope, keyFile), 'MUSIC_U=keepme', '旧密文必须仍能解开');
});

test('shouldReEncrypt 为真时用新底层密钥重封一次', async () => {
  resetCrypto();
  const { keyFile } = freshDir('rot');
  const store = fakeSafeStorage();
  await cryptoLib.prepareMasterKeyAsync(store, keyFile);

  cryptoLib.resetKeyCache();
  store.state.shouldReEncrypt = true;
  const sealsBefore = store.state.sealCount;
  const key = await cryptoLib.prepareMasterKeyAsync(store, keyFile);
  // 注意：不比对文件字节。DPAPI 对同一份数据是确定性的，重封后密文可以完全一样；
  // 这里要钉的是「确实又调了一次加密接口」，不是「文件变了」。
  assert.ok(store.state.sealCount > sealsBefore, 'shouldReEncrypt 为真时必须重新封装主密钥');
  assert.ok(Buffer.isBuffer(key) && key.length === 32, '重封后主密钥仍应可用');
  const envelope = cryptoLib.encryptCredential('after-reseal', keyFile);
  assert.strictEqual(cryptoLib.decryptCredential(envelope, keyFile), 'after-reseal', '重封后加解密仍应正常');
});

test('主密钥文件损坏：重建而非抛错，旧密文变为不可解', async () => {
  resetCrypto();
  const { keyFile } = freshDir('corrupt');
  const store = fakeSafeStorage();
  await cryptoLib.prepareMasterKeyAsync(store, keyFile);
  const envelope = cryptoLib.encryptCredential('sessionid=gone', keyFile);

  fs.writeFileSync(keyFile, '' + cryptoLib.KEY_FILE_MAGIC + 'AAAA', 'utf8');
  cryptoLib.resetKeyCache();
  const rebuilt = await cryptoLib.prepareMasterKeyAsync(store, keyFile);
  assert.ok(Buffer.isBuffer(rebuilt), '损坏后应重建主密钥而不是崩');
  assert.strictEqual(cryptoLib.decryptCredential(envelope, keyFile), '', '旧密文解不开时应返回空串');
});

test('系统凭据库不可用：降级明文，不阻断凭证读写', async () => {
  resetCrypto();
  const { keyFile } = freshDir('unavail');
  const store = {
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => { throw new Error('should not be called'); },
    decryptStringAsync: async () => { throw new Error('should not be called'); },
  };
  const key = await cryptoLib.prepareMasterKeyAsync(store, keyFile);
  assert.strictEqual(key, null, '不可用时应返回 null');
  assert.strictEqual(cryptoLib.hasSafeStorage(), false, '不可用时应报告无系统凭据库');
  assert.strictEqual(cryptoLib.encryptCredential('plain', keyFile), 'plain', '应原样返回明文');
  assert.strictEqual(fs.existsSync(keyFile), false, '不应生成主密钥文件');
});

test('有异步 API 时不走已弃用的同步接口；启动顺序是先解锁再迁移', () => {
  // prepareMasterKeyAsync 必须存在且使用异步接口。
  assert.match(CRYPTO_SOURCE, /async function prepareMasterKeyAsync/, '缺少异步解锁入口');
  assert.match(CRYPTO_SOURCE, /isAsyncEncryptionAvailable/, '未使用异步可用性检测');
  assert.match(CRYPTO_SOURCE, /encryptStringAsync/, '未使用异步加密');
  assert.match(CRYPTO_SOURCE, /decryptStringAsync/, '未使用异步解密');
  // 同步兜底只能出现在 ensureMasterKey 这一处（老版 Electron 才走到）。
  const syncCalls = CRYPTO_SOURCE.match(/\.(isEncryptionAvailable|encryptString|decryptString)\(/g) || [];
  assert.ok(syncCalls.length <= 3, `已弃用同步接口只允许留在兜底路径里，实际出现 ${syncCalls.length} 处`);
  const fallbackStart = CRYPTO_SOURCE.indexOf('function ensureMasterKey(');
  const fallbackEnd = CRYPTO_SOURCE.indexOf('function defaultKeyPathFor(');
  assert.ok(fallbackStart > -1 && fallbackEnd > fallbackStart, '应能定位同步兜底函数');
  const elsewhere = CRYPTO_SOURCE.slice(0, fallbackStart) + CRYPTO_SOURCE.slice(fallbackEnd);
  assert.doesNotMatch(elsewhere, /\.(encryptString|decryptString)\(/, '同步 DPAPI 调用跑到了兜底函数之外');

  // main.js：先 await 解锁，再做明文迁移。
  const unlockIdx = MAIN_SOURCE.indexOf('await unlockCredentialCrypto()');
  const migrateIdx = MAIN_SOURCE.indexOf('migratePlainCredentialsToEncrypted();');
  assert.ok(unlockIdx > -1, 'main.js 应 await unlockCredentialCrypto()');
  assert.ok(migrateIdx > -1 && unlockIdx < migrateIdx, '解锁必须排在明文迁移之前');
});
