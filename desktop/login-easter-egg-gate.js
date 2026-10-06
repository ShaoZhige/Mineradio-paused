'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 版本号只在「必须让所有人重做一遍解锁」时改。彩蛋从打字改成选择框不改变解锁语义，
// 所以这里刻意不动：一改就会让已解锁的用户被清掉全部登录态。
// The version only moves when everyone must redo the unlock. Turning the typing ritual into a
// select box does not change the semantics, so this stays put on purpose — bumping it would
// wipe the stored login state of users who already unlocked.
const LOGIN_EASTER_EGG_GATE_VERSION = 'world-peace-v1';
const LOGIN_EASTER_EGG_STATE_FILE = 'login-easter-egg.json';
// 答案就是各语言里的「世界和平」。界面显示哪个词就提交哪个词，所以每个写法都要能过校验；
// 这几个值必须与四份词典的 egg_wish_world_peace 完全一致，改词条就要同步改这里，
// tests/login-easter-egg-gate.test.js 会逐条比对，漏改会直接失败。
// The answer is "World Peace" in each language. The UI submits exactly the label it shows, so
// every spelling has to pass. These values must match egg_wish_world_peace in all four
// dictionaries; the gate test compares them one by one and fails the moment they drift.
const LOGIN_EASTER_EGG_ANSWERS = [
  '世界和平',
  'World Peace',
  '世界平和',
  'Мир во всём мире',
];
const LOGIN_EASTER_EGG_CREDENTIAL_FILES = [
  '.cookie',
  '.qq-cookie',
  '.kugou-cookie',
  '.kugou-vip-evidence.json',
  '.qishui-cookie',
  '.qishui-token',
  '.spotify-token.json',
];

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempFile, file);
}

// 长度不同的候选直接跳过，不做提前返回：逐个比完再合并结果，避免用「第几个词命中」
// 泄露信息（虽然答案本身是公开词条）。
// Length-mismatched candidates are skipped without an early return: every answer is compared
// and the results merged at the end, so a timing observer cannot tell which spelling matched.
function securePasswordMatch(input) {
  const received = Buffer.from(String(input || ''), 'utf8');
  let matched = false;
  for (const answer of LOGIN_EASTER_EGG_ANSWERS) {
    const expected = Buffer.from(answer, 'utf8');
    if (expected.length !== received.length) continue;
    if (crypto.timingSafeEqual(received, expected)) matched = true;
  }
  return matched;
}

class LoginEasterEggGate {
  constructor(options = {}) {
    this.userDataPath = path.resolve(String(options.userDataPath || '.'));
    this.credentialRoots = options.credentialRoots || [];
    this.stateFile = path.join(this.userDataPath, LOGIN_EASTER_EGG_STATE_FILE);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.state = this.readState();
  }

  readState() {
    const raw = safeReadJson(this.stateFile);
    return {
      schema: 1,
      gateVersion: String(raw.gateVersion || ''),
      cookieResetVersion: String(raw.cookieResetVersion || ''),
      resetComplete: raw.resetComplete === true,
      unlocked: raw.unlocked === true,
      resetAt: Number(raw.resetAt || 0) || 0,
      unlockedAt: Number(raw.unlockedAt || 0) || 0,
      resetError: String(raw.resetError || ''),
    };
  }

  writeState(next) {
    this.state = Object.assign({}, this.state, next, { schema: 1 });
    writeJsonAtomic(this.stateFile, this.state);
    return this.state;
  }

  publicStatus() {
    return {
      ok: true,
      gateVersion: LOGIN_EASTER_EGG_GATE_VERSION,
      unlocked: this.state.gateVersion === LOGIN_EASTER_EGG_GATE_VERSION && this.state.unlocked === true,
      resetComplete: this.state.gateVersion === LOGIN_EASTER_EGG_GATE_VERSION && this.state.resetComplete === true,
    };
  }

  isUnlocked() {
    const status = this.publicStatus();
    return status.unlocked && status.resetComplete;
  }

  resolveCredentialRoots() {
    let extraRoots = this.credentialRoots;
    if (typeof extraRoots === 'function') extraRoots = extraRoots();
    if (!Array.isArray(extraRoots)) extraRoots = [extraRoots];
    const roots = [this.userDataPath].concat(extraRoots || []);
    return Array.from(new Set(roots.filter(Boolean).map((root) => path.resolve(String(root)))));
  }

  clearCredentialFiles() {
    for (const root of this.resolveCredentialRoots()) {
      for (const name of LOGIN_EASTER_EGG_CREDENTIAL_FILES) {
        const file = path.join(root, name);
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch (error) {
          throw new Error(`LOGIN_CREDENTIAL_CLEAR_FAILED:${file}:${error.message}`);
        }
      }
    }
  }

  async clearCredentialState(clearProviderSessions) {
    this.clearCredentialFiles();
    if (typeof clearProviderSessions === 'function') await clearProviderSessions();
    // Logout handlers may flush an empty or stale in-memory store while the
    // provider sessions are closing. The second pass also removes migration
    // copies so a later launch cannot restore an old credential.
    this.clearCredentialFiles();
  }

  async initialize(clearProviderSessions) {
    this.state = this.readState();
    if (
      this.state.gateVersion === LOGIN_EASTER_EGG_GATE_VERSION &&
      this.state.cookieResetVersion === LOGIN_EASTER_EGG_GATE_VERSION &&
      this.state.resetComplete
    ) {
      if (!this.state.unlocked) {
        try {
          await this.clearCredentialState(clearProviderSessions);
        } catch (error) {
          const resetError = String(error && error.message || error || 'LOGIN_SESSION_RESET_FAILED');
          try {
            this.writeState({ cookieResetVersion: '', resetComplete: false, resetError });
          } catch (_) {
            this.state = Object.assign({}, this.state, { cookieResetVersion: '', resetComplete: false, resetError });
          }
          return Object.assign({ resetPerformed: false, error: resetError }, this.publicStatus());
        }
      }
      return Object.assign({ resetPerformed: false }, this.publicStatus());
    }

    let resetError = '';
    try {
      await this.clearCredentialState(clearProviderSessions);
    } catch (error) {
      resetError = String(error && error.message || error || 'LOGIN_SESSION_RESET_FAILED');
    }

    const nextState = {
      gateVersion: LOGIN_EASTER_EGG_GATE_VERSION,
      cookieResetVersion: resetError ? '' : LOGIN_EASTER_EGG_GATE_VERSION,
      resetComplete: !resetError,
      unlocked: false,
      resetAt: this.now(),
      unlockedAt: 0,
      resetError,
    };
    try {
      this.writeState(nextState);
    } catch (error) {
      resetError = `LOGIN_EASTER_EGG_STATE_WRITE_FAILED:${error.message}`;
      this.state = Object.assign({}, this.state, nextState, {
        cookieResetVersion: '',
        resetComplete: false,
        resetError,
      });
    }
    return Object.assign({ resetPerformed: true, error: resetError || '' }, this.publicStatus());
  }

  async resetForReplay(clearProviderSessions) {
    this.state = this.readState();
    let resetError = '';
    try {
      await this.clearCredentialState(clearProviderSessions);
    } catch (error) {
      resetError = String(error && error.message || error || 'LOGIN_SESSION_RESET_FAILED');
    }
    const nextState = {
      gateVersion: LOGIN_EASTER_EGG_GATE_VERSION,
      cookieResetVersion: resetError ? '' : LOGIN_EASTER_EGG_GATE_VERSION,
      resetComplete: !resetError,
      unlocked: false,
      resetAt: this.now(),
      unlockedAt: 0,
      resetError,
    };
    try {
      this.writeState(nextState);
    } catch (error) {
      resetError = `LOGIN_EASTER_EGG_STATE_WRITE_FAILED:${error.message}`;
      this.state = Object.assign({}, this.state, nextState, {
        cookieResetVersion: '',
        resetComplete: false,
        resetError,
      });
    }
    return Object.assign({ resetPerformed: true, replayReset: true, error: resetError || '' }, this.publicStatus());
  }

  unlock(input) {
    this.state = this.readState();
    if (!this.state.resetComplete || this.state.gateVersion !== LOGIN_EASTER_EGG_GATE_VERSION) {
      return { ok: false, unlocked: false, error: 'LOGIN_EASTER_EGG_RESET_INCOMPLETE' };
    }
    if (!securePasswordMatch(input)) {
      return { ok: false, unlocked: false, error: 'LOGIN_EASTER_EGG_INVALID' };
    }
    try {
      this.writeState({ unlocked: true, unlockedAt: this.now(), resetError: '' });
    } catch (error) {
      return {
        ok: false,
        unlocked: false,
        error: 'LOGIN_EASTER_EGG_STATE_WRITE_FAILED',
        message: String(error && error.message || error),
      };
    }
    return this.publicStatus();
  }
}

module.exports = {
  LoginEasterEggGate,
  LOGIN_EASTER_EGG_GATE_VERSION,
  LOGIN_EASTER_EGG_STATE_FILE,
  LOGIN_EASTER_EGG_ANSWERS,
  LOGIN_EASTER_EGG_CREDENTIAL_FILES,
  securePasswordMatch,
};
