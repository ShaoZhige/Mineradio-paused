// 自定义音源总控的生命周期与解析语义。
// 重点覆盖三件容易出错的事：切换脚本的顺序、失败时不留下孤儿 runtime、
// 以及「脚本对这首歌没有主张」必须交回内置接口而不是直接判定播放失败。
// Manager lifecycle and resolution semantics. Focused on the three easy-to-get-wrong
// things: activation ordering, never leaking an orphaned runtime on failure, and the rule
// that "the script has no opinion about this track" must fall back to the built-in path
// rather than failing playback.

const test = require('node:test');
const assert = require('node:assert/strict');

const { CustomSourceManager } = require('../desktop/custom-source/manager');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createStore(items = [], activeId = '') {
  const state = {
    activeId,
    items: items.map(item => ({
      status: 'idle',
      message: '',
      allowUpdateAlert: true,
      ...clone(item),
    })),
    scripts: new Map(items.map(item => [item.id, item.script || `/**\n * @name ${item.name || item.id}\n */`])),
  };
  return {
    state,
    list: () => state.items.map(item => ({ ...clone(item), active: item.id === state.activeId })),
    get: id => clone(state.items.find(item => item.id === id) || null),
    getActive: () => clone(state.items.find(item => item.id === state.activeId) || null),
    getScript: id => state.scripts.get(id),
    setActive(id) {
      if (id && !state.items.some(item => item.id === id)) throw new Error('SOURCE_NOT_FOUND');
      state.activeId = id || '';
    },
    setStatus(id, status, message, sources) {
      const item = state.items.find(value => value.id === id);
      if (!item) return;
      item.status = status;
      item.message = String(message || '');
      if (sources) item.sources = clone(sources);
    },
    setAllowUpdateAlert(id, enabled) {
      const item = state.items.find(value => value.id === id);
      if (!item) throw new Error('SOURCE_NOT_FOUND');
      item.allowUpdateAlert = !!enabled;
    },
    importScript(filePath, script) {
      const item = {
        id: `imported-${state.items.length + 1}`,
        name: 'Imported',
        originalPath: filePath,
        status: 'idle',
        message: '',
        allowUpdateAlert: true,
      };
      state.items.push(item);
      state.scripts.set(item.id, script);
      return clone(item);
    },
    replaceScript(id, script) {
      const item = state.items.find(value => value.id === id);
      if (!item) throw new Error('SOURCE_NOT_FOUND');
      item.version = script.includes('@version 2') ? '2' : item.version;
      state.scripts.set(id, script);
      return clone(item);
    },
    remove(id) {
      const index = state.items.findIndex(value => value.id === id);
      if (index === -1) throw new Error('SOURCE_NOT_FOUND');
      state.items.splice(index, 1);
      state.scripts.delete(id);
      if (state.activeId === id) state.activeId = '';
    },
  };
}

function runtimeFactoryFromQueue(queue, optionsSeen = []) {
  return options => {
    optionsSeen.push(options);
    const next = queue.shift();
    if (!next) throw new Error('No fake runtime queued');
    return next;
  };
}

function pick(value, keys) {
  const out = {};
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

test('resolves a supported track through the active runtime', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k', 'flac'] } };
  const store = createStore([{ id: 'a', name: 'A', sources }], 'a');
  let requestPayload;
  const runtime = {
    start: async () => sources,
    request: async payload => {
      requestPayload = payload;
      return `https://audio/${payload.info.type}.mp3`;
    },
    stop() {},
  };
  const manager = new CustomSourceManager({ store, runtimeFactory: () => runtime });

  await manager.startActive();
  const result = await manager.resolveMusicUrl(
    { provider: 'netease', id: 1, name: 'A', artist: 'B' },
    'hires',
  );

  assert.equal(result.active, true);
  assert.equal(result.handled, true);
  assert.equal(result.level, 'lossless');
  assert.equal(result.url, 'https://audio/flac.mp3');
  // 播放来源标记必须说清「地址是自定义源给的」，而不是把它伪装成平台解析。
  // Provenance must say the URL came from the custom source, not masquerade as a platform hit.
  assert.equal(result.provider, 'lx-custom-source');
  assert.equal(result.source, 'lx-custom-source');
  assert.equal(result.lxSource, 'wy');
  assert.equal(requestPayload.source, 'wy');
  assert.equal(requestPayload.info.musicInfo.meta.songId, 1);
});

test('returns inactive without constructing a runtime', async () => {
  const manager = new CustomSourceManager({
    store: createStore(),
    runtimeFactory: () => { throw new Error('unused'); },
  });

  assert.deepEqual(
    await manager.resolveMusicUrl({ provider: 'netease', id: 1 }, 'standard'),
    { active: false, handled: false },
  );
});

test('unknown platforms and undeclared sources fall back to the built-in path', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['320k'] } };
  const store = createStore([{ id: 'a', sources }], 'a');
  let requests = 0;
  const runtime = {
    start: async () => sources,
    request: async () => { requests += 1; },
    stop() {},
  };
  const manager = new CustomSourceManager({ store, runtimeFactory: () => runtime });
  await manager.startActive();

  // 脚本没声明 tx：交给内置的 QQ 接口，不能让 QQ 直接变成不可播。
  // The script does not declare tx: hand it to the built-in QQ path instead of making
  // every QQ track unplayable.
  assert.deepEqual(
    pick(await manager.resolveMusicUrl({ provider: 'qq', mid: 'x' }, 'standard'), ['active', 'handled', 'reason']),
    { active: true, handled: false, reason: 'source_unsupported' },
  );
  // 洛雪协议里没有对应搜索来源的平台同样交回内置接口。
  // Platforms with no LX source in the public contract fall back the same way.
  assert.deepEqual(
    pick(await manager.resolveMusicUrl({ provider: 'kugou', hash: 'h', id: '1' }, 'standard'), ['active', 'handled', 'reason']),
    { active: true, handled: false, reason: 'source_unsupported' },
  );
  // 声明了 wy 但没有可用音质：这是脚本自身的问题，必须报出来而不是静默降级。
  // wy is declared but no quality is usable: that is the script's own defect and must be
  // reported instead of silently downgrading.
  assert.deepEqual(
    pick(await manager.resolveMusicUrl({ provider: 'netease', id: 1 }, 'standard'), ['active', 'handled', 'url', 'reason', 'error']),
    { active: true, handled: true, url: '', reason: 'quality_unsupported', error: 'QUALITY_UNSUPPORTED' },
  );
  assert.equal(requests, 0);
});

test('a script failure is reported instead of thrown at the caller', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }], 'a');
  const runtime = {
    start: async () => sources,
    request: async () => { throw new Error('INVALID_RESPONSE: Expected an HTTP URL'); },
    stop() {},
  };
  const manager = new CustomSourceManager({ store, runtimeFactory: () => runtime });
  await manager.startActive();

  const result = await manager.resolveMusicUrl({ provider: 'netease', id: 1 }, 'standard');

  // 解析失败必须是返回值而不是异常：本地 HTTP 路由抛错会把播放链路整段打断。
  // Resolution failure must be a return value, not an exception: throwing inside the local
  // HTTP route would break the whole playback chain.
  assert.equal(result.active, true);
  assert.equal(result.handled, true);
  assert.equal(result.url, '');
  assert.equal(result.reason, 'request_failed');
  assert.match(result.error, /Expected an HTTP URL/);
});

test('does not expose mutable runtime source capabilities', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }], 'a');
  const runtime = {
    start: async () => sources,
    request: async () => 'https://audio/track.mp3',
    stop() {},
  };
  const manager = new CustomSourceManager({ store, runtimeFactory: () => runtime });
  await manager.startActive();

  manager.getStatus().sources.wy.actions.length = 0;
  manager.list()[0].sources.wy.qualitys.length = 0;

  const result = await manager.resolveMusicUrl({ provider: 'netease', id: 1 }, 'standard');
  assert.equal(result.url, 'https://audio/track.mp3');
});

test('starts a candidate before stopping the old runtime when activating', async () => {
  const sourceA = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const sourceB = { tx: { actions: ['musicUrl'], qualitys: ['320k'] } };
  const store = createStore([
    { id: 'a', sources: sourceA },
    { id: 'b', sources: sourceB },
  ], 'a');
  const order = [];
  const oldRuntime = {
    start: async () => { order.push('start-a'); return sourceA; },
    stop: async () => { order.push('stop-a'); },
  };
  const candidate = {
    start: async () => { order.push('start-b'); return { sources: sourceB }; },
    stop: async () => { order.push('stop-b'); },
  };
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: runtimeFactoryFromQueue([oldRuntime, candidate]),
  });

  await manager.startActive();
  await manager.activate('b');

  assert.deepEqual(order, ['start-a', 'start-b', 'stop-a']);
  assert.equal(store.state.activeId, 'b');
  assert.equal(manager.getStatus().activeId, 'b');
});

test('keeps a successful activation when the old runtime fails to stop', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }, { id: 'b', sources }], 'a');
  const oldRuntime = {
    start: async () => sources,
    stop: async () => { throw new Error('old stop failed'); },
  };
  const candidate = { start: async () => sources, stop() {} };
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: runtimeFactoryFromQueue([oldRuntime, candidate]),
  });
  const runtimeErrors = [];
  manager.on('runtimeError', error => runtimeErrors.push(error.message));
  await manager.startActive();

  await manager.activate('b');

  assert.equal(manager.getStatus().activeId, 'b');
  assert.deepEqual(runtimeErrors, ['old stop failed']);
});

test('failed activation keeps the old runtime and store state unchanged', async () => {
  const sourceA = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([
    { id: 'a', sources: sourceA, status: 'ready' },
    { id: 'b', status: 'idle' },
  ], 'a');
  let oldStops = 0;
  let candidateStops = 0;
  const oldRuntime = { start: async () => sourceA, stop: () => { oldStops += 1; } };
  const candidate = {
    start: async () => { throw new Error('INIT_FAILED: bad source'); },
    stop: () => { candidateStops += 1; },
  };
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: runtimeFactoryFromQueue([oldRuntime, candidate]),
  });
  await manager.startActive();
  const before = clone(store.state.items);

  await assert.rejects(manager.activate('b'), /bad source/);

  assert.equal(store.state.activeId, 'a');
  assert.deepEqual(store.state.items, before);
  assert.equal(manager.getStatus().activeId, 'a');
  assert.equal(oldStops, 0);
  assert.equal(candidateStops, 1);
});

test('stops a startup runtime when persisting its ready status fails', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }], 'a');
  const originalSetStatus = store.setStatus;
  store.setStatus = (id, status, message, value) => {
    if (status === 'ready') throw new Error('status save failed');
    originalSetStatus(id, status, message, value);
  };
  let stops = 0;
  const runtime = {
    start: async () => sources,
    stop: () => { stops += 1; },
  };
  const manager = new CustomSourceManager({ store, runtimeFactory: () => runtime });

  await manager.startActive();

  assert.equal(stops, 1);
  assert.deepEqual(manager.getStatus(), { active: false, activeId: '', sources: {} });
  assert.equal(store.state.activeId, 'a');
  assert.equal(store.state.items[0].status, 'failed');
});

test('a broken active script never takes the app startup down', async () => {
  const store = createStore([{ id: 'a', sources: {} }], 'a');
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: () => ({ start: async () => { throw new Error('INIT_FAILED: no inited'); }, stop() {} }),
  });

  const status = await manager.startActive();

  assert.deepEqual(status, { active: false, activeId: '', sources: {} });
  assert.equal(store.state.items[0].status, 'failed');
});

test('validates imports before persisting them and does not activate them', async () => {
  const store = createStore([{ id: 'a' }], 'a');
  let stopped = 0;
  const candidate = {
    start: async () => ({ wy: { actions: ['musicUrl'], qualitys: ['128k'] } }),
    stop: () => { stopped += 1; },
  };
  const optionsSeen = [];
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: runtimeFactoryFromQueue([candidate], optionsSeen),
  });
  const script = '/**\n * @name Imported\n */\nvoid 0';

  const imported = await manager.importScript('C:\\sources\\imported.js', script);

  assert.equal(imported.id, 'imported-2');
  assert.equal(store.state.scripts.get(imported.id), script);
  assert.equal(store.state.activeId, 'a');
  assert.equal(optionsSeen[0].script, script);
  assert.equal(stopped, 1);
});

test('failed replacement validation preserves the old script and active runtime', async () => {
  const oldScript = '/**\n * @name A\n * @version 1\n */\nvoid 0';
  const newScript = '/**\n * @name A\n * @version 2\n */\nvoid 0';
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', version: '1', script: oldScript, sources }], 'a');
  let oldStops = 0;
  let candidateStops = 0;
  const oldRuntime = { start: async () => sources, stop: () => { oldStops += 1; } };
  const candidate = {
    start: async () => { throw new Error('INIT_FAILED: replacement rejected'); },
    stop: () => { candidateStops += 1; },
  };
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: runtimeFactoryFromQueue([oldRuntime, candidate]),
  });
  await manager.startActive();

  await assert.rejects(manager.replaceScript('a', newScript), /replacement rejected/);

  assert.equal(store.state.scripts.get('a'), oldScript);
  assert.equal(store.state.items[0].version, '1');
  assert.equal(manager.getStatus().activeId, 'a');
  assert.equal(oldStops, 0);
  assert.equal(candidateStops, 1);
});

test('successful active replacement persists only after initialization and swaps runtimes', async () => {
  const oldScript = '/**\n * @name A\n * @version 1\n */\nvoid 0';
  const newScript = '/**\n * @name A\n * @version 2\n */\nvoid 0';
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', version: '1', script: oldScript, sources }], 'a');
  const order = [];
  const originalReplace = store.replaceScript;
  store.replaceScript = (id, script) => {
    order.push('persist');
    return originalReplace(id, script);
  };
  const oldRuntime = { start: async () => sources, stop: () => { order.push('stop-old'); } };
  const candidate = {
    start: async () => { order.push('start-candidate'); return sources; },
    stop: () => { order.push('stop-candidate'); },
  };
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: runtimeFactoryFromQueue([oldRuntime, candidate]),
  });
  await manager.startActive();

  await manager.replaceScript('a', newScript);

  assert.deepEqual(order, ['start-candidate', 'persist', 'stop-old']);
  assert.equal(store.state.scripts.get('a'), newScript);
  assert.equal(manager.getStatus().activeId, 'a');
});

test('remove and dispose stop only the runtime they own', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }], 'a');
  let stops = 0;
  const runtime = { start: async () => sources, stop: () => { stops += 1; } };
  const manager = new CustomSourceManager({ store, runtimeFactory: () => runtime });
  await manager.startActive();

  await manager.remove('a');
  await manager.dispose();

  assert.equal(stops, 1);
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(manager.getStatus(), { active: false, activeId: '', sources: {} });
});

test('deactivate restores the built-in path and keeps the script installed', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }], 'a');
  let stops = 0;
  const runtime = { start: async () => sources, stop: () => { stops += 1; } };
  const manager = new CustomSourceManager({ store, runtimeFactory: () => runtime });
  await manager.startActive();

  await manager.deactivate();

  assert.equal(stops, 1);
  assert.deepEqual(manager.getStatus(), { active: false, activeId: '', sources: {} });
  assert.deepEqual(
    await manager.resolveMusicUrl({ provider: 'netease', id: 1 }, 'standard'),
    { active: false, handled: false },
  );
  assert.equal(manager.list().length, 1);
});

test('emits at most one enabled update alert per runtime', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }], 'a');
  let runtimeOptions;
  const runtime = { start: async () => sources, stop() {} };
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: options => {
      runtimeOptions = options;
      return runtime;
    },
  });
  const alerts = [];
  manager.on('updateAlert', value => alerts.push(value));
  await manager.startActive();

  runtimeOptions.onUpdateAlert({ log: 'v2 available', updateUrl: 'https://example.com' });
  assert.throws(
    () => runtimeOptions.onUpdateAlert({ log: 'duplicate' }),
    /already sent/,
  );

  assert.deepEqual(alerts, [{ id: 'a', log: 'v2 available', updateUrl: 'https://example.com' }]);
});

test('update alerts respect the per-script opt-out', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }], 'a');
  let runtimeOptions;
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: options => {
      runtimeOptions = options;
      return { start: async () => sources, stop() {} };
    },
  });
  const alerts = [];
  manager.on('updateAlert', value => alerts.push(value));
  await manager.startActive();
  manager.setAllowUpdateAlert('a', false);

  runtimeOptions.onUpdateAlert({ log: 'v2 available' });

  assert.deepEqual(alerts, []);
});

test('publishes a candidate update alert only after activation commits', async () => {
  const sources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } };
  const store = createStore([{ id: 'a', sources }, { id: 'b', sources }], 'a');
  let created = 0;
  const manager = new CustomSourceManager({
    store,
    runtimeFactory: options => {
      created += 1;
      if (created === 1) return { start: async () => sources, stop() {} };
      return {
        start: async () => {
          options.onUpdateAlert({ log: 'candidate update' });
          return sources;
        },
        stop() {},
      };
    },
  });
  const alerts = [];
  manager.on('updateAlert', value => alerts.push({ ...value, activeAtEvent: store.state.activeId }));
  await manager.startActive();

  await manager.activate('b');

  assert.deepEqual(alerts, [{ id: 'b', log: 'candidate update', activeAtEvent: 'b' }]);
});
