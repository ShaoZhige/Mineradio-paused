'use strict';

// 脚本仓库：把用户导入的洛雪脚本连同元数据、启用状态、初始化结果一起存在
// Electron userData 下的独立目录，绝不进入项目目录、Git 或安装包。
// Storage for imported LX scripts: lives under Electron userData only, never in the
// repository, Git history, quick patches or the installer.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseScriptInfo } = require('./protocol');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// id 会参与拼路径，所以必须先挡住路径分隔符与空字节。
// The id is used to build a file path, so separators and NUL bytes must be rejected.
function isSafeScriptId(value) {
  return typeof value === 'string' && value !== '' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

class CustomSourceStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.scriptDir = path.join(rootDir, 'scripts');
    this.indexFile = path.join(rootDir, 'sources.json');
    fs.mkdirSync(this.scriptDir, { recursive: true });
    this.state = this.#readState();
  }

  #readState() {
    let raw;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const state = { activeId: '', items: [] };
      this.#writeState(state);
      return state;
    }

    try {
      const parsed = JSON.parse(raw);
      return this.#normalizeState(parsed);
    } catch {
      // 索引损坏时先留证据再重建，避免用户的音源列表凭空消失。
      // Keep a copy of the corrupt index before rebuilding so the list is not silently lost.
      this.#backupCorruptIndex();
      const state = { activeId: '', items: [] };
      this.#writeState(state);
      return state;
    }
  }

  #normalizeState(parsed) {
    if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) throw new Error('Invalid source index');
    if (typeof parsed.activeId !== 'string') throw new Error('Invalid active source');
    if (!parsed.items.every(item => isPlainObject(item) && isSafeScriptId(item.id))) throw new Error('Invalid source item');
    return { activeId: parsed.activeId, items: parsed.items };
  }

  #backupCorruptIndex() {
    const backup = `${this.indexFile}.corrupt.${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    fs.copyFileSync(this.indexFile, backup);
  }

  #writeState(state) {
    const temp = `${this.indexFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, this.indexFile);
  }

  #save() {
    this.#writeState(this.state);
  }

  #hash(script) {
    return crypto.createHash('sha256').update(script).digest('hex');
  }

  #scriptPath(id) {
    return path.join(this.scriptDir, `${id}.js`);
  }

  #writeScriptAtomic(id, script) {
    const finalPath = this.#scriptPath(id);
    const temp = path.join(this.scriptDir, `${id}.${Date.now()}_${crypto.randomBytes(3).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, script, 'utf8');
      fs.renameSync(temp, finalPath);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  // 替换脚本时先落 .next、把旧文件挪成 .previous，写索引失败还能原位回滚。
  // Replacement stages the new file and moves the old one aside so a failed index write
  // can roll back to the exact previous contents.
  #stageScriptReplacement(id, script) {
    const finalPath = this.#scriptPath(id);
    const nextPath = `${finalPath}.next`;
    const previousPath = `${finalPath}.previous`;
    fs.rmSync(nextPath, { force: true });
    fs.rmSync(previousPath, { force: true });
    try {
      fs.writeFileSync(nextPath, script, 'utf8');
      fs.renameSync(finalPath, previousPath);
      try {
        fs.renameSync(nextPath, finalPath);
      } catch (error) {
        fs.renameSync(previousPath, finalPath);
        throw error;
      }
    } catch (error) {
      fs.rmSync(nextPath, { force: true });
      throw error;
    }
    return { finalPath, nextPath, previousPath };
  }

  #restoreScriptReplacement(paths) {
    fs.rmSync(paths.nextPath, { force: true });
    fs.rmSync(paths.finalPath, { force: true });
    fs.renameSync(paths.previousPath, paths.finalPath);
  }

  #cleanupCommittedBackup(backupPath) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {}
  }

  importScript(originalPath, script) {
    const hash = this.#hash(script);
    if (this.state.items.some(item => item.hash === hash)) throw new Error('IMPORT_INVALID: duplicate script');
    const id = `user_api_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const item = {
      id,
      ...parseScriptInfo(script),
      originalPath: String(originalPath || ''),
      hash,
      allowUpdateAlert: true,
      status: 'idle',
      message: '',
    };
    this.#writeScriptAtomic(id, script);
    this.state.items.push(item);
    try {
      this.#save();
    } catch (error) {
      // 索引写失败就把刚写下的脚本文件也收回，保持「索引即真相」。
      // If the index write fails, remove the script file too: the index is the source of truth.
      this.state.items.pop();
      fs.rmSync(this.#scriptPath(id), { force: true });
      throw error;
    }
    return clone(item);
  }

  list() {
    return this.state.items.map(item => ({ ...clone(item), active: item.id === this.state.activeId }));
  }

  get(id) {
    const item = this.state.items.find(value => value.id === id);
    return item ? clone(item) : null;
  }

  getScript(id) {
    return fs.readFileSync(this.#scriptPath(id), 'utf8');
  }

  getActive() {
    return this.get(this.state.activeId);
  }

  setActive(id) {
    if (id && !this.get(id)) throw new Error('SOURCE_NOT_FOUND');
    const previousActiveId = this.state.activeId;
    this.state.activeId = id || '';
    try {
      this.#save();
    } catch (error) {
      this.state.activeId = previousActiveId;
      throw error;
    }
  }

  setStatus(id, status, message, sources) {
    const index = this.state.items.findIndex(value => value.id === id);
    if (index === -1) return;
    const item = this.state.items[index];
    const previousItem = clone(item);
    Object.assign(item, { status, message: String(message || ''), sources: sources ? clone(sources) : clone(item.sources || {}) });
    try {
      this.#save();
    } catch (error) {
      this.state.items[index] = previousItem;
      throw error;
    }
  }

  setAllowUpdateAlert(id, enable) {
    const item = this.state.items.find(value => value.id === id);
    if (!item) throw new Error('SOURCE_NOT_FOUND');
    const previousAllowUpdateAlert = item.allowUpdateAlert;
    item.allowUpdateAlert = !!enable;
    try {
      this.#save();
    } catch (error) {
      item.allowUpdateAlert = previousAllowUpdateAlert;
      throw error;
    }
  }

  replaceScript(id, script) {
    const index = this.state.items.findIndex(value => value.id === id);
    if (index === -1) throw new Error('SOURCE_NOT_FOUND');
    const item = this.state.items[index];
    const previousItem = clone(item);
    const info = parseScriptInfo(script);
    const hash = this.#hash(script);
    const replacement = this.#stageScriptReplacement(id, script);
    Object.assign(item, info, { hash, status: 'idle', message: '' });
    try {
      this.#save();
    } catch (error) {
      this.state.items[index] = previousItem;
      this.#restoreScriptReplacement(replacement);
      throw error;
    }
    this.#cleanupCommittedBackup(replacement.previousPath);
    return clone(item);
  }

  remove(id) {
    const item = this.state.items.find(value => value.id === id);
    if (!item) throw new Error('SOURCE_NOT_FOUND');
    const previousState = this.state;
    const scriptPath = this.#scriptPath(item.id);
    const stagedPath = `${scriptPath}.remove`;
    fs.rmSync(stagedPath, { force: true });
    fs.renameSync(scriptPath, stagedPath);
    this.state = {
      activeId: this.state.activeId === id ? '' : this.state.activeId,
      items: this.state.items.filter(value => value.id !== id),
    };
    try {
      this.#save();
    } catch (error) {
      this.state = previousState;
      fs.renameSync(stagedPath, scriptPath);
      throw error;
    }
    this.#cleanupCommittedBackup(stagedPath);
  }
}

module.exports = { CustomSourceStore, isSafeScriptId };
