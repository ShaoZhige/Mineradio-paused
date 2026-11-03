'use strict';

// 凭证加密落盘：AES-256-GCM + 系统凭据库（Windows 上是 DPAPI，经 safeStorage）保管主密钥。
//
// 为什么不是 safeStorage.encryptString 直接加密 cookie：
//  1. safeStorage 只保密、不认证——密文被改半个字节不会报错，会静默解出脏数据。
//  2. AES-GCM 是认证加密：保密 + 完整性校验，篡改即抛错。
//  3. 双层结构：safeStorage 保护一把随机主密钥（落盘的是 DPAPI 密文），
//     主密钥再用 AES-256-GCM 加密 cookie。换机器/换账户，DPAPI 解不开主密钥，密文自动失效。
//
// 主密钥文件格式：`MRK1:` + base64(DPAPI 密文)。
// 🔴 这里必须是 base64，不能把 DPAPI 的原始字节当 utf8 字符串存：
//    DPAPI 输出是随机字节，UTF-8 解码会替换非法序列，读回来长度都变了（实测 64B → 113B），
//    主密钥永远解不开 → 第二次启动静默换成新密钥 → 之前加密的凭证全部报废。
//    这个坑在纯 ASCII 的测试数据上完全看不出来，只有真跑一次才会有反应。
//
// Electron 45 起 `isEncryptionAvailable` / `encryptString` / `decryptString` 已弃用，
// 官方要求用 `isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync`。
// 异步版还多给一个 `shouldReEncrypt`：系统轮换了底层密钥时它会为 true，这时必须立刻重封一次。
// 所以主密钥在启动阶段解锁（prepareMasterKeyAsync），同步接口只消费内存里的缓存密钥，
// 不再碰 DPAPI。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cryptoApi = typeof crypto === 'object' && crypto ? crypto : null;
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // GCM 推荐 96-bit IV
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;  // AES-256
const MAGIC = 'MR1';   // Mineradio credential envelope v1
const KEY_FILE_MAGIC = 'MRK1:'; // Mineradio 主密钥信封 v1

// safeStorage 由 Electron 主进程注入（见 main.js）。纯 Node 测试环境里拿不到时，
// 降级为明文并打一条警告——凭证永远能读写，加密只是"尽力而为"，不能让应用起不来。
let safeStorageHandle = null;
let fallbackWarned = false;
let keyCache = new Map(); // credentialKeyPath -> Buffer
// unknown：还没预解锁；ready：异步可用且已解锁；unavailable：本环境没有系统凭据库
let availability = 'unknown';

function hasSafeStorage() {
  // 测试钩子：__installTestKey 注入 { __test: true } 并预填 keyCache，直接放行。
  if (safeStorageHandle && safeStorageHandle.__test) return true;
  if (availability === 'ready') return true;
  if (availability === 'unavailable') return false;
  // 还没预解锁：只有**没有异步 API 的老版 Electron** 才允许走同步兜底，
  // 否则一律等 prepareMasterKeyAsync，避免又调到已弃用的同步接口。
  return !!(safeStorageHandle
    && typeof safeStorageHandle.isEncryptionAvailable === 'function'
    && typeof safeStorageHandle.isAsyncEncryptionAvailable !== 'function'
    && safeStorageHandle.isEncryptionAvailable());
}

// 由 main.js 注入 Electron 的 safeStorage 模块。在 require server.js 之前调用。
function installSafeStorage(safeStorageModule) {
  safeStorageHandle = safeStorageModule || null;
  availability = safeStorageModule ? 'unknown' : 'unavailable';
}

function getSafeStorage() {
  return safeStorageHandle;
}

// ---------------------------------------------------------------------------
// 主密钥文件的读写（MRK1 base64 信封）
// ---------------------------------------------------------------------------

function encodeKeyBlob(buffer) {
  return KEY_FILE_MAGIC + Buffer.from(buffer).toString('base64');
}

function decodeKeyBlob(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(KEY_FILE_MAGIC)) return null;
  const blob = Buffer.from(trimmed.slice(KEY_FILE_MAGIC.length), 'base64');
  return blob.length ? blob : null;
}

function readKeyBlob(keyFile) {
  try {
    if (!fs.existsSync(keyFile)) return null;
    return decodeKeyBlob(fs.readFileSync(keyFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeKeyBlob(keyFile, blob) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const tmp = keyFile + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, encodeKeyBlob(blob), 'utf8');
  fs.renameSync(tmp, keyFile);
}

// ---------------------------------------------------------------------------
// 主密钥解锁
// ---------------------------------------------------------------------------

function rememberKey(keyFile, masterKey) {
  if (!masterKey || masterKey.length !== KEY_BYTES) return null;
  keyCache.set(keyFile, masterKey);
  return masterKey;
}

// 启动阶段异步解锁主密钥（Electron 45+ 的唯一正确路径）。
// 必须在 require('server/server.js') 之前 await 一次，之后同步接口只用缓存。
async function prepareMasterKeyAsync(safeStorageModule, keyFile) {
  const target = keyFile || defaultKeyPathFor('');
  if (keyCache.has(target)) return keyCache.get(target);
  const moduleRef = safeStorageModule || safeStorageHandle;
  if (!moduleRef) {
    availability = 'unavailable';
    return null;
  }
  if (typeof moduleRef.isAsyncEncryptionAvailable !== 'function') {
    // 老版 Electron：没有异步接口，退回同步路径（在那里才允许调已弃用的同步方法）。
    availability = 'unknown';
    return ensureMasterKey(target, moduleRef);
  }
  let available = false;
  try { available = await moduleRef.isAsyncEncryptionAvailable(); } catch (_) { available = false; }
  if (!available) {
    availability = 'unavailable';
    if (!fallbackWarned) {
      fallbackWarned = true;
      console.warn('[CredentialCrypto] system credential store unavailable — credentials will be stored in plain text.');
    }
    return null;
  }
  availability = 'ready';

  const blob = readKeyBlob(target);
  if (blob && typeof moduleRef.decryptStringAsync === 'function') {
    try {
      const output = await moduleRef.decryptStringAsync(blob);
      const decrypted = Buffer.from(String((output && output.result) || ''), 'base64');
      const masterKey = rememberKey(target, decrypted);
      if (masterKey) {
        // 系统提示底层密钥已轮换：立刻用新密钥重封一次，否则下次可能解不开。
        // shouldReEncrypt 是异步 API 才有的信号，同步版没有。
        if (output && output.shouldReEncrypt === true
          && typeof moduleRef.encryptStringAsync === 'function') {
          try {
            const resealed = await moduleRef.encryptStringAsync(masterKey.toString('base64'));
            writeKeyBlob(target, resealed);
          } catch (resignError) {
            console.warn('[CredentialCrypto] master key re-seal failed:', resignError.message);
          }
        }
        return masterKey;
      }
    } catch (e) {
      // DPAPI 解不开（换机器/换账户/密钥损坏）→ 旧密文全部无法解密，只能重建主密钥。
      console.warn('[CredentialCrypto] master key unreadable, regenerating:', e.message);
    }
  }
  if (typeof moduleRef.encryptStringAsync !== 'function') return null;
  const fresh = cryptoApi.randomBytes(KEY_BYTES);
  const sealed = await moduleRef.encryptStringAsync(fresh.toString('base64'));
  writeKeyBlob(target, sealed);
  return rememberKey(target, fresh);
}

// 同步取主密钥：只读缓存；缓存没有时仅允许没有异步 API 的老版 Electron 走同步兜底。
// 同步路径也写 MRK1 base64 信封，和异步路径同一个格式，避免两套格式互不兼容。
function ensureMasterKey(keyFile, safeStorageModule) {
  const target = keyFile || defaultKeyPathFor('');
  if (keyCache.has(target)) return keyCache.get(target);
  const moduleRef = safeStorageModule || safeStorageHandle;
  if (!hasSafeStorage() || !moduleRef) {
    if (!fallbackWarned) {
      fallbackWarned = true;
      console.warn('[CredentialCrypto] safeStorage unavailable — credentials will be stored in plain text.');
    }
    return null;
  }
  try {
    const blob = readKeyBlob(target);
    let masterKey = null;
    if (blob) {
      try {
        const decrypted = moduleRef.decryptString(blob);
        const buf = Buffer.from(String(decrypted || ''), 'base64');
        if (buf.length === KEY_BYTES) masterKey = buf;
      } catch (e) {
        console.warn('[CredentialCrypto] master key unreadable, regenerating:', e.message);
      }
    }
    if (!masterKey) {
      masterKey = cryptoApi.randomBytes(KEY_BYTES);
      writeKeyBlob(target, moduleRef.encryptString(masterKey.toString('base64')));
    }
    return rememberKey(target, masterKey);
  } catch (e) {
    console.warn('[CredentialCrypto] ensureMasterKey failed:', e.message);
    return null;
  }
}

// 给一组凭证文件指定一个公共主密钥路径。主密钥放在用户数据目录下，
// 与凭证文件同目录，但主密钥本身被 DPAPI 加密，拷走也没用。
function defaultKeyPathFor(credentialFile) {
  const dir = path.dirname(credentialFile || '.');
  return path.join(dir, '.credential-key');
}

// ---------------------------------------------------------------------------
// 凭证加解密
// ---------------------------------------------------------------------------

// 判断一段文本是不是本模块产生的密文信封。
function isEncryptedEnvelope(text) {
  if (typeof text !== 'string' || text.length < 24) return false;
  return text.slice(0, MAGIC.length) === MAGIC;
}

// 加密一段明文 → 信封字符串。safeStorage 不可用时原样返回明文（并保证 isEncryptedEnvelope 为 false）。
function encryptCredential(plaintext, keyFile) {
  const value = String(plaintext == null ? '' : plaintext);
  if (!hasSafeStorage()) return value;
  const key = ensureMasterKey(keyFile);
  if (!key || !cryptoApi) return value;
  try {
    const iv = cryptoApi.randomBytes(IV_BYTES);
    const cipher = cryptoApi.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    // 信封：MAGIC + base64(iv | tag | ciphertext)
    return MAGIC + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  } catch (e) {
    console.warn('[CredentialCrypto] encryptCredential failed:', e.message);
    return value;
  }
}

// 解密信封 → 明文。输入不是信封（明文）时原样返回（过渡期兼容）。
function decryptCredential(text, keyFile) {
  const value = String(text == null ? '' : text);
  if (!isEncryptedEnvelope(value)) return value;
  if (!hasSafeStorage() || !cryptoApi) return '';
  const key = ensureMasterKey(keyFile);
  if (!key) return '';
  try {
    const blob = Buffer.from(value.slice(MAGIC.length), 'base64');
    if (blob.length < IV_BYTES + GCM_TAG_BYTES) return '';
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + GCM_TAG_BYTES);
    const ct = blob.subarray(IV_BYTES + GCM_TAG_BYTES);
    const decipher = cryptoApi.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    // 认证失败 / 主密钥不匹配 → 视为不可用，上层会触发重新登录。
    console.warn('[CredentialCrypto] decryptCredential failed (credential will need re-login):', e.message);
    return '';
  }
}

// JSON 专用：把对象序列化后加密，读回时解密并 JSON.parse。
function encryptJson(obj, keyFile) {
  return encryptCredential(JSON.stringify(obj == null ? null : obj), keyFile);
}

function decryptJson(text, keyFile) {
  const pt = decryptCredential(text, keyFile);
  if (!pt) return null;
  try { return JSON.parse(pt); } catch (_) { return null; }
}

// 把一个文件的内容加密写回（原地迁移用）：读出明文 → 加密写回。
function encryptFileInPlace(filePath, keyFile) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (isEncryptedEnvelope(raw)) return false; // 已是密文
    if (!hasSafeStorage()) return false;
    const encrypted = encryptCredential(raw, keyFile || defaultKeyPathFor(filePath));
    if (!isEncryptedEnvelope(encrypted)) return false;
    const tmp = filePath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, encrypted, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    console.warn('[CredentialCrypto] encryptFileInPlace failed for', filePath, ':', e.message);
    return false;
  }
}

function resetKeyCache() {
  keyCache.clear();
  availability = safeStorageHandle && safeStorageHandle.__test ? 'ready' : 'unknown';
}

// 测试钩子：注入一个固定主密钥，跳过 safeStorage / DPAPI。
function __installTestKey(keyFile, keyHex) {
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== KEY_BYTES) throw new Error('test key must be 32 bytes');
  keyCache.set(keyFile, buf);
  safeStorageHandle = { __test: true };
  availability = 'ready';
}

module.exports = {
  installSafeStorage,
  getSafeStorage,
  hasSafeStorage,
  prepareMasterKeyAsync,
  ensureMasterKey,
  defaultKeyPathFor,
  isEncryptedEnvelope,
  encryptCredential,
  decryptCredential,
  encryptJson,
  decryptJson,
  encryptFileInPlace,
  resetKeyCache,
  __installTestKey,
  MAGIC,
  KEY_FILE_MAGIC,
};
