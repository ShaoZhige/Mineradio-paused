// ============================================================
//  平台（provider）权威注册表 —— 单一数据源
//  The authoritative platform (provider) registry — the single source of truth.
//
//  为什么要有它：同一个平台清单原先散落在 **6 处**、且彼此不一致，还都带着平台名/接口路径的
//  硬编码分支。新增一个平台时没有任何机制提醒你去改齐这几处，漏掉哪一处都**不会报错**，只会
//  "那个平台在某些功能里就是不存在"。历史上已经漏过：搜索支持的平台与换源支持的平台不是同一份
//  清单，Spotify 加进去了但换源清单里没有，汽水在搜索里有、在自动换源里没有。
//  现在所有清单都从这一份派生：新增平台只改这里，各处按能力自动覆盖。
//
//  Why this exists: the same platform list lived in six places, none of them agreeing, each carrying
//  its own hardcoded name branches and endpoint paths. Adding a platform gave no signal that the
//  other places needed updating, and every miss failed silently — the platform simply did not exist
//  for that feature. It has already gone wrong: the search list and the fallback list were different
//  sets, and a platform present in one was absent from the other. Every list now derives from here.
//
//  ⚠️ 这里刻意写成 function 而不是顶层 var：所有模块最终被拼成一个 script 注入（见 index-loader），
//     函数声明会提升、与加载顺序无关，而顶层 var 的赋值是有先后的。写成 var 会让"谁先加载"
//     变成隐蔽的崩溃条件。
//  ⚠️ Deliberately a function, not a top-level var: every module ends up concatenated into one
//     injected script, where function declarations hoist but top-level var assignments do not.
//     A var here would turn load order into a hidden failure condition.
// ============================================================

// 取词：与仓库其它 <域>Text(key, fallback, params) 保持**逐字一致的形态** —— 两条路径各自就地
// 插值，不抽公共子函数。`i18n-c-class-wiring` 会强制这个形态（三参签名 + typeof window 兜底 +
// split/join 写法 + 命中与兜底都替换），抽子函数会让那条全仓判据失败，而它存在的意义正是
// 保证所有取词函数长得一样、可以被同一套判据检查。
// Word lookup kept shape-identical to every other <domain>Text(key, fallback, params) in this
// repository: each path interpolates in place rather than delegating to a helper, because the
// i18n-c-class-wiring test enforces that exact shape so one set of judgements covers them all.
function providerRegistryText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === "object") {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}

// 能力位说明（每一项都对应仓库里一处真实存在的清单）：
//   login          账号面板与登录工作流里出现的平台
//   mainSearch     主搜索面板可以选到的一档
//   sourceSwitcher 播放控制栏「音源切换器」里列出的平台
//   directFallback 播放失败后可自动换过去的平台（能直接拿到可播放地址）
//   preferred      可被设为「默认源」的平台
// Capability flags, each one backing a list that really exists in the repository.
var PROVIDER_REGISTRY_ROWS = [
  {
    key: 'netease',
    badge: 'NE',
    // 全名：账号面板、换源提示、设置项用
    labelKey: 'track_netease_music',
    labelFallback: '网易云音乐',
    // 短名：空间紧凑处（音源切换器）用。与全名是两个不同的键，这不是重复 ——
    // 账号面板写「酷狗音乐」、切换器写「酷狗」，两种长度都是有意的。
    // Compact title for tight spots. A different key from the full label on purpose: the account
    // panel reads "酷狗音乐" while the switcher reads "酷狗", and both lengths are intentional.
    compactKey: 'login_netease',
    compactFallback: '网易云',
    appKey: 'lmu_netease_app',
    appFallback: '网易云音乐 App',
    searchPath: '/api/search',
    caps: { login: true, mainSearch: true, sourceSwitcher: true, directFallback: true, preferred: true }
  },
  {
    key: 'qq',
    badge: 'QQ',
    labelKey: 'search_qq_music',
    labelFallback: 'QQ音乐',
    compactKey: 'search_qq_music',
    compactFallback: 'QQ音乐',
    appKey: 'lmu_qq_app',
    appFallback: 'QQ 音乐 App',
    searchPath: '/api/qq/search',
    caps: { login: true, mainSearch: true, sourceSwitcher: true, directFallback: true, preferred: true }
  },
  {
    key: 'kugou',
    badge: 'KG',
    labelKey: 'provider_kugou',
    labelFallback: '酷狗音乐',
    compactKey: 'search_kugou',
    compactFallback: '酷狗',
    appKey: 'lmu_kugou_app',
    appFallback: '酷狗音乐 App',
    searchPath: '/api/kugou/search',
    caps: { login: true, mainSearch: true, sourceSwitcher: true, directFallback: true, preferred: true }
  },
  {
    key: 'qishui',
    badge: 'QS',
    labelKey: 'provider_qishui',
    labelFallback: '汽水音乐',
    compactKey: 'dash_qishui',
    compactFallback: '汽水',
    appKey: 'lmu_qishui_app',
    appFallback: '汽水音乐 App',
    searchPath: '/api/qishui/search',
    caps: { login: true, mainSearch: true, sourceSwitcher: true, directFallback: false, preferred: true }
  },
  {
    key: 'spotify',
    badge: 'SP',
    // Spotify 是品牌名，四语都写作 "Spotify"，不另造词典键（给品牌名建键会与既有同值键
    // 撞上同文本守卫，而两者本就无法也不需要区分）。
    // "Spotify" is a brand name, identical in all four languages, so no dictionary key is minted:
    // a key for it would collide with an existing same-valued key under the same-text guard, and the
    // two could not be told apart anyway.
    labelKey: '',
    labelFallback: 'Spotify',
    compactKey: '',
    compactFallback: 'Spotify',
    appKey: '',
    appFallback: 'Spotify',
    searchPath: '/api/spotify/search',
    // preferred: true —— 可以被指定为默认源。这与 directFallback 的语义不同：
    //   · directFallback 要求"能直接拿到可播放地址"，Spotify 做不到 → 必须为 false
    //     （否则自动换源会换到一个同样播不了的源上，得接着再换一次）。
    //   · preferred 只是"把谁排到查找顺序最前"。开了「播放 Spotify 源唤起客户端」的
    //     Premium 用户，本来就是靠本机客户端播 Spotify 曲目，把他们常听的歌优先匹配成
    //     Spotify 版本正是想要的。
    //     ⚠️ 代价要说明白：未装客户端或非 Premium 时，这会让每首歌先在 Spotify 匹配一次、
    //        播不了再自动换源到别家 —— 比不指定要多一次搜索与一次客户端唤起尝试。
    //        这是用户的显式选择，不是默认行为（默认是网易云）。
    // preferred: true — selectable as the preferred source, which is a different question from
    // directFallback. directFallback requires "can hand back a playable URL", which Spotify cannot,
    // so it must stay false (auto-fallback would otherwise land on an equally unplayable source and
    // have to switch again). preferred only decides who goes first in the lookup order: a Premium
    // user with the "launch the Spotify client" setting plays Spotify tracks natively anyway, so
    // matching their songs to the Spotify version first is exactly what they want.
    // ⚠️ The trade-off is real and worth stating: without the client, or on Free, this makes every
    //    track search Spotify once and then auto-switch away — one extra search and one extra client
    //    launch attempt versus not setting it. It is an explicit user choice, not a default.
    caps: { login: true, mainSearch: false, sourceSwitcher: true, directFallback: false, preferred: true }
  }
];

var providerRegistryCache = null;

function providerRegistry() {
  if (!providerRegistryCache) {
    providerRegistryCache = PROVIDER_REGISTRY_ROWS.map(function (row) {
      return {
        key: row.key,
        badge: row.badge,
        labelKey: row.labelKey,
        labelFallback: row.labelFallback,
        compactKey: row.compactKey,
        compactFallback: row.compactFallback,
        appKey: row.appKey,
        appFallback: row.appFallback,
        searchPath: row.searchPath,
        caps: Object.assign({}, row.caps)
      };
    });
  }
  return providerRegistryCache;
}

// 已知平台的全部 key，顺序 = 注册表顺序（各处清单的基准顺序）。
// Every known platform key, in registry order — the canonical order the other lists build on.
function providerRegistryKeys() {
  return providerRegistry().map(function (row) { return row.key; });
}

function providerRegistryEntry(provider) {
  var key = normalizeProviderRegistryKey(provider);
  if (!key) return null;
  var rows = providerRegistry();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) return rows[i];
  }
  return null;
}

// 认不出来的一律返回空串，让调用方走各自既有的兜底分支 —— 而不是抛错或悄悄当成网易云
//（原先多处 `if (provider === 'qq') ... else 网易云` 的写法会把任何未知平台当成网易云）。
// Unrecognised input yields an empty string so callers keep their own fallback branch, instead of
// being silently coerced to netease the way the old `if (qq) ... else netease` chains did.
function normalizeProviderRegistryKey(provider) {
  var key = String(provider || '').trim().toLowerCase();
  if (!key) return '';
  for (var i = 0; i < PROVIDER_REGISTRY_ROWS.length; i++) {
    if (PROVIDER_REGISTRY_ROWS[i].key === key) return key;
  }
  return '';
}

// 按能力筛选。capable 传 'login' / 'mainSearch' / 'sourceSwitcher' / 'directFallback' / 'preferred'。
// Filter by capability: 'login' | 'mainSearch' | 'sourceSwitcher' | 'directFallback' | 'preferred'.
function providerRegistryKeysWith(capable) {
  return providerRegistry().filter(function (row) {
    return row.caps[capable] === true;
  }).map(function (row) { return row.key; });
}

function providerRegistryHasCapability(provider, capable) {
  var entry = providerRegistryEntry(provider);
  return !!(entry && entry.caps[capable] === true);
}

function providerRegistryLabel(provider) {
  var entry = providerRegistryEntry(provider);
  if (!entry) return String(provider || '');
  return entry.labelKey
    ? providerRegistryText(entry.labelKey, entry.labelFallback)
    : entry.labelFallback;
}

function providerRegistryCompactTitle(provider) {
  var entry = providerRegistryEntry(provider);
  if (!entry) return String(provider || '');
  return entry.compactKey
    ? providerRegistryText(entry.compactKey, entry.compactFallback)
    : entry.compactFallback;
}

function providerRegistryBadge(provider) {
  var entry = providerRegistryEntry(provider);
  return entry ? entry.badge : String(provider || '').toUpperCase().slice(0, 2);
}

// 平台搜索接口。limit 由调用方给：主搜索面板、音源切换器、换源搜索各自的上限本来就不同，
// 统一成同一个数字反而会改变行为。path 为空表示该平台不支持搜索。
// The search endpoint, with the limit supplied by the caller: the main search panel, the source
// switcher and the fallback search genuinely use different limits, so collapsing them would change
// behaviour. An empty path means the platform cannot be searched.
function providerRegistrySearchUrl(provider, query, limit) {
  var entry = providerRegistryEntry(provider);
  if (!entry || !entry.searchPath) return '';
  var cap = Number(limit) > 0 ? '&limit=' + Number(Math.floor(Number(limit))) : '';
  return entry.searchPath + '?keywords=' + encodeURIComponent(String(query || '')) + cap;
}

// ── 默认源偏好 ─────────────────────────────────────────────────────────────
// 用户指定的「默认源」：播放时把它排到平台查找顺序的最前面。
//
// ⚠️ 存储里要能区分「没设置过」与「明确选了不指定」，所以显式「不指定」存成 'auto' 而不是空串 ——
//    否则读回时会被当成"没设置过"、又落回默认值，那个「不指定」选项就成了摆设。
// ⚠️ 另外**绝不把默认值写回存储**：写回就等于把"默认"锁死成"用户的选择"，以后改默认值对
//    已经启动过的用户不再生效（本项目在「关闭行为」上真踩过这个坑）。
// The stored value distinguishes "never set" from "explicitly none", so the explicit choice is stored
// as 'auto' rather than an empty string: an empty string would read back as "never set" and fall into
// the default again, making that option a no-op. The default is never written back to storage either
// — doing so would freeze a default into a user choice, which this project already got wrong once.
var PREFERRED_SOURCE_STORE_KEY = 'mineradio-preferred-source-v1';
// 显式「不指定」的哨兵值。
var PREFERRED_SOURCE_AUTO = 'auto';
// 默认：把网易云排在查找顺序最前（与本次改造之前的事实行为一致，因此默认状态下用户感受不到变化）。
var DEFAULT_PREFERRED_SOURCE = 'netease';

function preferredSourceStorage() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch (e) {
    return null;
  }
}

// 归一化用户选择：只有具备 preferred 能力的平台能被指定。Spotify 会被拒（它不返回可播放直链，
// 指定它等于每首歌都先白搜一次再换走）。
// Only platforms with the preferred capability are accepted; Spotify is rejected because it never
// returns a playable URL, so preferring it means searching it only to switch away again.
function normalizePreferredSourceValue(value) {
  var raw = String(value == null ? '' : value).trim().toLowerCase();
  if (raw === PREFERRED_SOURCE_AUTO) return PREFERRED_SOURCE_AUTO;
  var key = normalizeProviderRegistryKey(raw);
  if (key && providerRegistryHasCapability(key, 'preferred')) return key;
  return '';
}

// 用户的选择本身：返回 'auto' 或某个平台 key；没设置过则返回默认值。
function readPreferredSourcePreference() {
  var storage = preferredSourceStorage();
  if (!storage) return DEFAULT_PREFERRED_SOURCE;
  var raw = null;
  try { raw = storage.getItem(PREFERRED_SOURCE_STORE_KEY); } catch (e) { return DEFAULT_PREFERRED_SOURCE; }
  if (raw == null || raw === '') return DEFAULT_PREFERRED_SOURCE;
  var normalized = normalizePreferredSourceValue(raw);
  // 存了个不认识的平台（已下线/被移除）→ 退回默认，而不是让整条链路拿到空值。
  return normalized || DEFAULT_PREFERRED_SOURCE;
}

// 实际的「默认源」平台；'auto'（明确不指定）解析为空串。
function preferredSourceProvider() {
  var preference = readPreferredSourcePreference();
  return preference === PREFERRED_SOURCE_AUTO ? '' : preference;
}

// 只有用户**显式操作**才写存储。
function savePreferredSourcePreference(value) {
  var storage = preferredSourceStorage();
  var normalized = normalizePreferredSourceValue(value);
  if (!normalized) return false;
  try {
    storage.setItem(PREFERRED_SOURCE_STORE_KEY, normalized);
    return true;
  } catch (e) {
    return false;
  }
}

// 设置面板的下拉选项：可被指定的平台（注册表 preferred 能力）+ 一个「不指定」。
// Options for the settings dropdown: the platforms that may be preferred, plus an explicit "none".
function preferredSourceOptions() {
  var options = [{ value: PREFERRED_SOURCE_AUTO, label: providerRegistryText('settings_preferred_source_auto', '不指定（保持原样）') }];
  providerRegistryKeysWith('preferred').forEach(function (key) {
    options.push({ value: key, label: providerRegistryLabel(key) });
  });
  return options;
}
