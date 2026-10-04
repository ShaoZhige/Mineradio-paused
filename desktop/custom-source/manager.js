'use strict';

// 自定义音源总控：负责脚本生命周期、激活状态与播放地址解析。
// 一次只允许启用一个脚本（与洛雪一致）；切换脚本时先启动新的、成功后再停旧的。
// Custom source manager: owns script lifecycle, activation state and URL resolution.
// Only one script may be active at a time (same as LX); activating a new one starts the
// candidate first and only stops the previous runtime after the candidate is ready.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { CustomSourceStore } = require('./store');
const { LxSourceRuntime } = require('./runtime');
const { parseScriptInfo, selectLxQuality, validateActionResponse } = require('./protocol');
const { toLxMusicInfo } = require('./music-info');

// 脚本音质到 Mineradio 音质档位的映射；前端用 level 判断是否需要提示降级。
// Script quality mapped back onto Mineradio quality levels so the player can reason about it.
const QUALITY_LEVELS = Object.freeze({
  '128k': 'standard',
  '320k': 'exhigh',
  flac: 'lossless',
  flac24bit: 'hires',
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function initializedSources(result) {
  if (!result || typeof result !== 'object') return {};
  return clone(result.sources && typeof result.sources === 'object' ? result.sources : result);
}

function errorMessage(error) {
  return String(error?.message || error || 'CUSTOM_SOURCE_FAILED').slice(0, 1024);
}

class CustomSourceManager extends EventEmitter {
  constructor({ store, runtimeFactory, userDataPath, app, BrowserWindow, ipcMain } = {}) {
    super();
    const dataPath = userDataPath || app?.getPath?.('userData');
    if (!store && !dataPath) throw new TypeError('store or userDataPath is required');
    this.store = store || new CustomSourceStore(path.join(dataPath, 'custom-sources'));
    this.electron = { app, BrowserWindow, ipcMain };
    this.runtimeFactory = runtimeFactory || (options => new LxSourceRuntime(options));
    this.runtime = null;
    this.activeId = '';
    this.sources = {};
  }

  #getItem(id) {
    if (typeof this.store.get === 'function') return this.store.get(id);
    return this.store.list().find(item => item.id === id) || null;
  }

  #emitStatus(extra = {}) {
    this.emit('status', { ...this.getStatus(), ...extra });
  }

  // 脚本在初始化完成前就可能发出 updateAlert。此时先扣住，等宿主真正切到它
  // 之后再决定要不要告诉用户，避免「导入一个失败脚本却弹更新提示」。
  // A script may emit updateAlert before it is actually activated. Hold it until the host
  // has committed to this runtime, so importing a failing script never nags the user.
  #createRuntime(item, script, currentScriptInfo = item) {
    let alertSent = false;
    let alertsEnabled = false;
    let pendingAlert = null;
    const publishAlert = data => {
      const latest = this.#getItem(item.id);
      if (latest && latest.allowUpdateAlert === false) return;
      this.emit('updateAlert', { id: item.id, ...data });
    };
    const runtime = this.runtimeFactory({
      script,
      currentScriptInfo,
      electron: this.electron,
      onUpdateAlert: data => {
        if (alertSent) throw new Error('UPDATE_ALERT_FAILED: Update alert already sent');
        alertSent = true;
        if (!alertsEnabled) {
          pendingAlert = data;
          return;
        }
        publishAlert(data);
      },
    });
    return {
      runtime,
      enableAlerts() {
        alertsEnabled = true;
        if (!pendingAlert) return;
        const alert = pendingAlert;
        pendingAlert = null;
        publishAlert(alert);
      },
    };
  }

  async #stopQuietly(runtime) {
    if (!runtime || typeof runtime.stop !== 'function') return;
    try {
      await runtime.stop();
    } catch (error) {
      this.emit('runtimeError', error);
    }
  }

  async #startCandidate(item, script, currentScriptInfo = item) {
    const candidate = this.#createRuntime(item, script, currentScriptInfo);
    try {
      const result = await candidate.runtime.start();
      return { ...candidate, sources: initializedSources(result) };
    } catch (error) {
      await this.#stopQuietly(candidate.runtime);
      throw error;
    }
  }

  // 启动失败不上抛：应用启动不能因为一个坏脚本而失败。
  // A failing script must never take the app startup down, so this never throws.
  async startActive() {
    const active = this.store.getActive();
    if (!active) return this.getStatus();
    if (this.runtime && this.activeId === active.id) return this.getStatus();
    let candidate;
    try {
      candidate = await this.#startCandidate(active, this.store.getScript(active.id));
      this.store.setStatus(active.id, 'ready', '', candidate.sources);
    } catch (error) {
      if (candidate) await this.#stopQuietly(candidate.runtime);
      try {
        this.store.setStatus(active.id, 'failed', errorMessage(error), active.sources || {});
      } catch {}
      this.#emitStatus({ error: errorMessage(error) });
      return this.getStatus();
    }
    const previous = this.runtime;
    this.runtime = candidate.runtime;
    this.activeId = active.id;
    this.sources = candidate.sources;
    candidate.enableAlerts();
    await this.#stopQuietly(previous);
    this.#emitStatus();
    return this.getStatus();
  }

  async activate(id) {
    const item = this.#getItem(id);
    if (!item) throw new Error('SOURCE_NOT_FOUND');
    if (this.runtime && this.activeId === id) return this.getStatus();

    const candidate = await this.#startCandidate(item, this.store.getScript(id));
    const previousActiveId = this.store.getActive()?.id || '';
    try {
      this.store.setActive(id);
      this.store.setStatus(id, 'ready', '', candidate.sources);
    } catch (error) {
      // 持久化失败就退回原状态，并且不能留下一个已经在跑的孤儿 runtime。
      // If persistence fails, roll the store back and never leave an orphaned runtime.
      try {
        this.store.setActive(previousActiveId);
      } catch {}
      await this.#stopQuietly(candidate.runtime);
      throw error;
    }

    const previous = this.runtime;
    this.runtime = candidate.runtime;
    this.activeId = id;
    this.sources = candidate.sources;
    candidate.enableAlerts();
    await this.#stopQuietly(previous);
    this.#emitStatus();
    return this.getStatus();
  }

  async deactivate() {
    this.store.setActive('');
    const previous = this.runtime;
    this.runtime = null;
    this.activeId = '';
    this.sources = {};
    await this.#stopQuietly(previous);
    this.#emitStatus();
    return this.getStatus();
  }

  // 导入即验证：先在临时宿主里跑通初始化，通过了才落盘，
  // 用户不会在列表里看到一个「装上了但根本起不来」的脚本。
  // Import validates first: the script must survive a throwaway runtime before it is
  // persisted, so the list never gains an entry that simply cannot boot.
  async importScript(filePath, script) {
    const currentScriptInfo = parseScriptInfo(script);
    const placeholder = { id: `import_${Date.now()}`, ...currentScriptInfo, allowUpdateAlert: true };
    const candidate = await this.#startCandidate(placeholder, script, currentScriptInfo);
    try {
      return this.store.importScript(filePath, script);
    } finally {
      await this.#stopQuietly(candidate.runtime);
      this.#emitStatus();
    }
  }

  async replaceScript(id, script) {
    const item = this.#getItem(id);
    if (!item) throw new Error('SOURCE_NOT_FOUND');
    const currentScriptInfo = { ...item, ...parseScriptInfo(script) };
    const candidate = await this.#startCandidate(item, script, currentScriptInfo);
    let replaced;
    try {
      replaced = this.store.replaceScript(id, script);
    } catch (error) {
      await this.#stopQuietly(candidate.runtime);
      throw error;
    }

    if (this.activeId === id) {
      const previous = this.runtime;
      this.runtime = candidate.runtime;
      this.sources = candidate.sources;
      candidate.enableAlerts();
      await this.#stopQuietly(previous);
    } else {
      await this.#stopQuietly(candidate.runtime);
    }
    this.#emitStatus();
    return replaced;
  }

  async remove(id) {
    const wasActive = this.activeId === id;
    this.store.remove(id);
    if (wasActive) {
      const previous = this.runtime;
      this.runtime = null;
      this.activeId = '';
      this.sources = {};
      await this.#stopQuietly(previous);
    }
    this.#emitStatus();
    return this.list();
  }

  setAllowUpdateAlert(id, enabled) {
    this.store.setAllowUpdateAlert(id, enabled);
    this.#emitStatus();
    return this.list();
  }

  list() {
    return this.store.list().map(item => {
      if (item.id !== this.activeId || !this.runtime) return item;
      return { ...item, active: true, status: 'ready', message: '', sources: clone(this.sources) };
    });
  }

  getStatus() {
    if (!this.runtime || !this.activeId) return { active: false, activeId: '', sources: {} };
    return { active: true, activeId: this.activeId, sources: clone(this.sources) };
  }

  // handled 的语义很关键：只有脚本真的对这首歌有主张时才返回 true。
  // 平台不认识、没声明该平台、没声明 musicUrl 动作，都交回内置接口——
  // Mineradio 有五个平台，脚本通常只覆盖其中一两个。
  // `handled` is the important bit: it is only true when the script really claims this
  // track. An unknown provider, an undeclared platform or a missing musicUrl action all
  // go back to the built-in path, because Mineradio has five providers and a script
  // typically covers one or two of them.
  async resolveMusicUrl(song, mineradioQuality, options = {}) {
    if (!this.runtime || !this.activeId) return { active: false, handled: false };
    const signal = options && options.signal ? options.signal : null;
    let lxSong;
    try {
      lxSong = toLxMusicInfo(song);
    } catch {
      return { active: true, handled: false, reason: 'source_unsupported', lxSource: '' };
    }
    const sourceInfo = this.sources[lxSong.source];
    if (!sourceInfo || !Array.isArray(sourceInfo.actions) || !sourceInfo.actions.includes('musicUrl')) {
      return { active: true, handled: false, reason: 'source_unsupported', lxSource: lxSong.source };
    }
    const lxQuality = selectLxQuality(mineradioQuality, Array.isArray(sourceInfo.qualitys) ? sourceInfo.qualitys : []);
    if (!lxQuality) {
      return {
        active: true,
        handled: true,
        url: '',
        reason: 'quality_unsupported',
        error: 'QUALITY_UNSUPPORTED',
        lxSource: lxSong.source,
      };
    }
    try {
      const url = validateActionResponse('musicUrl', await this.runtime.request({
        source: lxSong.source,
        action: 'musicUrl',
        info: { type: lxQuality, musicInfo: lxSong },
      }, { signal }));
      return {
        active: true,
        handled: true,
        // provider/source 描述「地址是谁给的」，而不是歌曲原本属于哪个平台，
        // 这样播放来源标签不会把一次自定义源解析说成平台解析。
        // provider/source describe who supplied the URL, not which platform the song
        // belongs to, so the playback provenance label stays honest.
        provider: 'lx-custom-source',
        source: 'lx-custom-source',
        lxSource: lxSong.source,
        url,
        level: QUALITY_LEVELS[lxQuality],
        lxQuality,
      };
    } catch (error) {
      return {
        active: true,
        handled: true,
        url: '',
        reason: signal && signal.aborted ? 'request_cancelled' : 'request_failed',
        error: errorMessage(error),
        lxSource: lxSong.source,
      };
    }
  }

  async dispose() {
    const previous = this.runtime;
    this.runtime = null;
    this.activeId = '';
    this.sources = {};
    await this.#stopQuietly(previous);
  }
}

module.exports = { CustomSourceManager, QUALITY_LEVELS };
