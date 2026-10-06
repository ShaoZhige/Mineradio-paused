// 「默认源」查找顺序的行为回归。
//
// 为什么必须真跑：这一段的全部意义就是"顺序"——先问哪个平台、什么时候停下来、什么时候原样播。
// 源码文本判据（`/provider === current/` 之类）证明不了"实际只问了 netease 和 kugou、没问 qishui"，
// 也证明不了"走到歌曲自身来源就停"。所以这里把真实模块丢进沙箱、真调一次，并把**问过哪些平台、
// 按什么顺序**记下来断言。
// Why this must actually run: the entire point of this code is the ORDER — which platform is asked,
// when it stops, when the track plays as-is. Reading the source cannot show "it asked netease then
// kugou and never qishui", nor "reaching the song's own provider stops the search". So the real module
// goes into a sandbox, runs for real, and the platforms it asked (and in what order) are recorded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { withProviderRegistry } = require('./helpers/module-source');

const ROOT = path.join(__dirname, '..');
const fallbackPath = path.join(ROOT, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js');
const fallbackText = fs.readFileSync(fallbackPath, 'utf8');

// 造一个能记账的沙箱：记录询问过的平台顺序，并按配置返回搜索结果。
//
// ⚠️ 「默认源」不能靠注入 stub 来设定：注册表模块里就有 `preferredSourceProvider()`，而函数声明
//    会覆盖沙箱上预设的同名属性 —— stub 会被真实实现顶掉。所以这里**给出真实的 localStorage**，
//    让代码走它自己的读取路径。顺带把「偏好读取」这一段的集成也覆盖了。
// ⚠️ The preference cannot be stubbed: the registry module declares preferredSourceProvider(), and a
//    function declaration overwrites a pre-set property of the same name, so any stub is replaced by
//    the real implementation. A real localStorage is provided instead, letting the code take its own
//    read path — which also covers the preference plumbing.
function createSandbox(options) {
  const opts = options || {};
  const asked = [];
  const searched = [];
  // matches: { [provider]: song|null }
  const matches = opts.matches || {};
  const loggedIn = opts.loggedIn || ['netease', 'qq', 'kugou', 'qishui'];
  const statuses = {};
  loggedIn.forEach((provider) => { statuses[provider] = { loggedIn: true, playbackKeyReady: true }; });

  const sandbox = {
    console: { warn() {} },
    window: {},
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    Date,
    Object,
    Array,
    Promise,
    normalizePlaybackProvider(provider) {
      const key = String(provider || '').trim().toLowerCase();
      return ['netease', 'qq', 'kugou', 'qishui', 'spotify'].includes(key) ? key : '';
    },
    songProviderKey(song) { return (song && song.provider) || 'netease'; },
    platformStatus(provider) { return statuses[provider] || { loggedIn: false }; },
    accountProviderOrder() { return opts.accountProviderOrder || ['netease', 'qq', 'kugou', 'qishui']; },
    cloneSong(song) { return Object.assign({}, song); },
    async apiJson(url) {
      // 从 URL 反推是哪个平台，并记录顺序 —— 这就是「查找顺序」的直接证据。
      // ⚠️ 这里**必须从注册表派生**，不能手写 if 链：手写链最初只认 qq/kugou/qishui、其余一律
      //    当网易云，于是 /api/spotify/search 被记成 netease，Spotify 的用例假红过一次。
      //    派生之后新增平台也不会再漂移。
      // The platform is inferred from the URL, which is the direct evidence of the lookup order.
      // ⚠️ This must DERIVE from the registry rather than a hand-written if chain: the chain only knew
      //    qq/kugou/qishui and folded everything else into netease, so /api/spotify/search was recorded
      //    as netease and the Spotify case failed spuriously once.
      const provider = sandbox.providerRegistryKeys().find(
        (key) => url.startsWith(sandbox.providerRegistrySearchUrl(key, '', 0))
      ) || '(unknown)';
      asked.push(provider);
      searched.push(url);
      const hit = Object.prototype.hasOwnProperty.call(matches, provider) ? matches[provider] : null;
      return { songs: hit ? [hit] : [] };
    },
    isSameTitleArtist(source, candidate) {
      const a = String((source && source.name) || '') + '|' + String((source && source.artist) || '');
      const b = String((candidate && candidate.name) || '') + '|' + String((candidate && candidate.artist) || '');
      return a === b;
    },
    hydrateCustomCover(song) { return song; },
  };
  // storedPreference 为 undefined 表示"从没设置过"，此时不提供 localStorage，走真实默认值。
  // An undefined storedPreference means "never set", so no localStorage is provided and the real
  // default is exercised.
  if (opts.storedPreference !== undefined) {
    sandbox.localStorage = {
      _v: opts.storedPreference,
      getItem() { return this._v; },
      setItem(key, value) { this._v = String(value); }
    };
  }

  vm.createContext(sandbox);
  vm.runInContext(withProviderRegistry(fallbackText), sandbox, { filename: fallbackPath });
  return { sandbox, asked, searched };
}

const SONG_FROM_QQ = { provider: 'qq', id: 'qq-1', mid: 'M1', name: '晴天', artist: '周杰伦' };
const NET_CANDIDATE = { provider: 'netease', id: 1001, name: '晴天', artist: '周杰伦' };
const KG_CANDIDATE = { provider: 'kugou', id: 'kg-1', hash: 'H1', name: '晴天', artist: '周杰伦' };

test('默认源排到查找顺序最前，命中就用它的同名曲', async () => {
  const { sandbox, asked } = createSandbox({ storedPreference: 'netease', matches: { netease: NET_CANDIDATE } });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.ok(result, '默认源里有同名曲时应当返回它');
  assert.equal(result.provider, 'netease');
  assert.equal(result.preferredSourceFrom, 'qq', '要记录它换自哪个平台');
  assert.deepEqual(asked, ['netease'], '只该问默认源一次就命中');
});

test('默认源没有就按顺序继续试其它平台，直到走到歌曲自身的来源', async () => {
  // 网易云没有，酷狗有 → 应该跳过 qq（歌曲自身来源之前的顺序）先去问更早的平台，
  // 命中酷狗就返回。
  const { sandbox, asked } = createSandbox({
    storedPreference: 'netease',
    accountProviderOrder: ['netease', 'kugou', 'qq'],
    matches: { netease: null, kugou: KG_CANDIDATE }
  });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.ok(result);
  assert.equal(result.provider, 'kugou');
  assert.deepEqual(asked, ['netease', 'kugou'], '按顺序问，命中即停');
});

test('走到歌曲自身的来源就停下原样播放，不再往后搜', async () => {
  // 顺序 [netease, qq(自身), kugou]：问网易云没有 → 下一个就是 qq = 自身来源 → 立即停下。
  // 关键：酷狗**不该被问到**，否则会把好好的原曲换掉，也白花一次往返。
  const { sandbox, asked } = createSandbox({
    storedPreference: 'netease',
    accountProviderOrder: ['netease', 'qq', 'kugou'],
    matches: { netease: null, kugou: KG_CANDIDATE }
  });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.equal(result, null, '走到自身来源应原样播放');
  assert.deepEqual(asked, ['netease'], '不该越过歌曲自身的来源继续搜');
});

test('歌曲已在默认源上时完全不发搜索', async () => {
  const { sandbox, asked } = createSandbox({ storedPreference: 'netease' });
  const result = await sandbox.resolvePreferredSourceSong({ provider: 'netease', id: 9, name: '晴天', artist: '周杰伦' }, {});
  assert.equal(result, null);
  assert.deepEqual(asked, [], '已在默认源上，零开销');
});

test('选了「不指定」时完全不发搜索', async () => {
  const { sandbox, asked } = createSandbox({ storedPreference: 'auto' });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.equal(result, null);
  assert.deepEqual(asked, []);
});

test('本地歌曲、播客与内部转场都不参与选源', async () => {
  const local = createSandbox({ storedPreference: 'netease' });
  assert.equal(await local.sandbox.resolvePreferredSourceSong({ type: 'local', name: 'x', artist: 'y' }, {}), null);
  assert.equal(await local.sandbox.resolvePreferredSourceSong({ type: 'podcast', name: 'x', artist: 'y' }, {}), null);
  assert.equal(await local.sandbox.resolvePreferredSourceSong({ localUrl: 'mineradio-local://a', provider: 'local', name: 'x', artist: 'y' }, {}), null);
  // 换源重试 / 无缝接力 / 音质重切都有自己的挑歌策略，不能被这里再插一手。
  const qqSong = { provider: 'qq', name: '晴天', artist: '周杰伦' };
  assert.equal(await local.sandbox.resolvePreferredSourceSong(qqSong, { fallbackDepth: 1 }), null);
  assert.equal(await local.sandbox.resolvePreferredSourceSong(qqSong, { albumGaplessHandoff: true }), null);
  assert.equal(await local.sandbox.resolvePreferredSourceSong(qqSong, { qualitySwitch: true }), null);
  assert.deepEqual(local.asked, [], '以上任一情形都不该发搜索');
});

test('所有平台都没命中时原样播放，且顺序走全', async () => {
  const { sandbox, asked } = createSandbox({
    storedPreference: 'netease',
    accountProviderOrder: ['netease', 'kugou', 'qishui', 'qq'],
    matches: { netease: null, kugou: null, qishui: null }
  });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.equal(result, null);
  // qq 是自身来源（顺序里排最后），所以问到 qishui 之后就该停在 qq。
  assert.deepEqual(asked, ['netease', 'kugou', 'qishui']);
});

test('搜索抛错或超时都只当作没命中，绝不让播放被挡住', async () => {
  const { sandbox } = createSandbox({ storedPreference: 'netease' });
  // 让搜索直接抛错。
  sandbox.apiJson = async () => { throw new Error('network down'); };
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.equal(result, null, '搜索失败必须安静地回到原样播放');
});

test('未登录的平台不会被问到', async () => {
  const { sandbox, asked } = createSandbox({
    storedPreference: 'netease',
    loggedIn: [],
    accountProviderOrder: ['netease', 'qq', 'kugou']
  });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.equal(result, null);
  assert.deepEqual(asked, [], '未登录的平台没有可用音源，问了也是白问');
});

test('查找顺序把默认源放在首位，且歌曲自身来源一定在顺序里（终点标记）', () => {
  const { sandbox } = createSandbox({ storedPreference: 'kugou', accountProviderOrder: ['netease', 'qq', 'qishui'] });
  const order = sandbox.preferredSourceLookupOrder({ provider: 'spotify', name: 'x', artist: 'y' });
  assert.equal(order[0], 'kugou', '默认源必须排第一');
  assert.ok(order.includes('spotify'), '歌曲自身的来源必须在顺序里，否则没有终点可停');
  assert.equal(new Set(order).size, order.length, '顺序里不能有重复项');
});

test('从没设置过时默认源是网易云，且读取不会把默认值写回存储', () => {
  // 需求就是"默认源设为网易云"：没设置过时必须落到它，否则用户感受不到任何变化。
  // The requirement is a netease default: with nothing stored it must resolve to netease.
  const { sandbox } = createSandbox({});
  assert.equal(sandbox.readPreferredSourcePreference(), 'netease');
  assert.equal(sandbox.preferredSourceProvider(), 'netease');
  // ⚠️ 写回默认值会把"默认"锁死成"用户的选择"，日后改默认值对老用户不再生效（本项目在
  //    「关闭行为」上踩过这个坑）。所以读操作必须是纯读。
  // Writing the default back would freeze it into a user choice; reading must stay read-only.
  assert.equal(sandbox.localStorage, undefined, '没设置过时不该有存储写入，更不该凭空建一个');
});

test('汽水也能被指定为默认源（它可搜可播，只是不在自动换源候选里）', async () => {
  // 这条是补一个真实缺陷的回归：汽水具备 preferred 能力，但内层就绪判定历史上按自动换源清单
  // （不含汽水）过滤，导致"选了汽水永远搜不到"——设置项看得见却永远不生效。
  const { sandbox, asked } = createSandbox({
    storedPreference: 'qishui',
    accountProviderOrder: ['netease', 'qq', 'kugou'],
    matches: { qishui: { provider: 'qishui', id: 'qs-1', name: '晴天', artist: '周杰伦' } }
  });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.ok(result, '汽水作为默认源时必须真的能搜到');
  assert.equal(result.provider, 'qishui');
  assert.deepEqual(asked, ['qishui'], '默认源排第一，命中即停');
});

test('Spotify 也能被指定为默认源（靠本机客户端播放的那条路）', async () => {
  // 回归：最初我把 Spotify 一并排除（理由"它不返回可播放直链"），漏掉了「播放 Spotify 源唤起
  // 客户端」这条真实播放路径 —— Premium + 已装客户端的用户就是要让歌先匹配成 Spotify 版本。
  // Regression: Spotify was initially excluded on the single grounds that it returns no playable URL,
  // which missed the client-launch playback path — a Premium user with the client installed wants
  // their tracks matched to Spotify first.
  const { sandbox, asked } = createSandbox({
    storedPreference: 'spotify',
    loggedIn: ['netease', 'qq', 'kugou', 'qishui', 'spotify'],
    accountProviderOrder: ['netease', 'qq', 'kugou'],
    matches: { spotify: { provider: 'spotify', id: 'sp-1', spotifyId: 'sp-1', name: '晴天', artist: '周杰伦' } }
  });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.ok(result, 'Spotify 作为默认源时必须真的能搜到');
  assert.equal(result.provider, 'spotify');
  assert.deepEqual(asked, ['spotify'], '默认源排第一，命中即停');
  // 它仍然不能进自动换源候选：那条路要求"能直接拿到可播放地址"，换到 Spotify 等于换了个播不了的。
  // It still must not be an automatic-fallback candidate: that path needs a directly playable URL.
  assert.equal(sandbox.SOURCE_FALLBACK_DIRECT_PROVIDERS.includes('spotify'), false);
});

test('未登录的 Spotify 不会被当作默认源去搜', async () => {
  // 没登录时 platformStatus 没有可播放授权，问了也是白搜。
  const { sandbox, asked } = createSandbox({ storedPreference: 'spotify', loggedIn: [] });
  const result = await sandbox.resolvePreferredSourceSong(SONG_FROM_QQ, {});
  assert.equal(result, null);
  assert.deepEqual(asked, []);
});

test('存了已下线的未知平台时退回默认源，而不是让设置失效', () => {
  // 历史遗留的未知平台要能自愈回默认值。
  assert.equal(createSandbox({ storedPreference: 'gone-provider' }).sandbox.preferredSourceProvider(), 'netease');
  // 显式「不指定」是一个真实选项，不能被当成"没设置过"而退回默认。
  assert.equal(createSandbox({ storedPreference: 'auto' }).sandbox.preferredSourceProvider(), '');
  // 下拉里必须真的能选到 Spotify（用户反馈的就是这个）。用 join 比较：沙箱里的数组来自另一个
  // realm，deepStrictEqual 会因为 Array.prototype 不同而拒绝两个内容相同的数组。
  // Spotify must really be selectable (the reported issue). Compared via join because a sandbox array
  // comes from another realm and deepStrictEqual rejects two identical arrays across realms.
  assert.equal(createSandbox({}).sandbox.preferredSourceOptions().map((o) => o.value).join(','),
    'auto,netease,qq,kugou,qishui,spotify');
});
