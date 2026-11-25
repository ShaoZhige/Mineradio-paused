'use strict';

// 录制 server/spotify-partner.js 的通道行为，产出 Rust 侧回放用的 cases.jsonl。
//
//   node scripts/record-spotify-partner.js           输出到 stdout（人工抽查）
//   node scripts/record-spotify-partner.js --write   直接写进 Rust 侧 fixture
//   node scripts/record-spotify-partner.js --check   与 fixture 逐字节比对（CI 用）
//
// 为什么不用 rust-anything bridge：`createSpotifyPartner` 的唯一入参是**一堆函数**
// （requestJson / getAccessToken / log / warn），返回值又是一个方法对象。bridge 只认
// "导出函数 + 普通 JSON 入参"，表达不了。所以录制器自己写：注入 mock 传输层，
// 把每个能力的"入参 → 请求序列 → 输出"整条链录下来。
//
// 两个刻意选择：
//
//   1. **responses 是字典不是队列**。`readAccount` 用 `Promise.all` 并发发两个请求，
//      谁先到 `requestJson` 取决于微任务调度 —— 按顺序录会在换机器时翻车。所以响应
//      按 key 归组（`pathfinder:<operationName>` / `spclient:<path>`），同 key 多次
//      调用按数组顺序消费。requests 则按"排序后逐条比对"，顺序同样不参与判定。
//   2. **不传 refreshAccessToken**，让默认的 `() => getAccessToken({force: true})`
//      生效，这样 401 重试路径能验证"force 取一次 + 再取一次"的三段调用序列。

const partnerModule = require('../server/spotify-partner');

const { createSpotifyPartner } = partnerModule;

const TRACK_A = '1111111111111111111111';
const TRACK_B = '5555555555555555555555';
const TRACK_C = '6666666666666666666666';
const TRACK_D = '7777777777777777777777';
const ARTIST = '2222222222222222222222';
const ALBUM = '3333333333333333333333';
const PLAYLIST = '4444444444444444444444';

// ---------- 响应形状 ----------

const ok = (body) => ({ ok: body === undefined ? {} : body });
const fail = (statusCode, body, message) => ({
  error: { statusCode, body: body == null ? '' : String(body), message: message || ('SPOTIFY_HTTP_' + statusCode) },
});

function trackData(id, name, extra) {
  return Object.assign({
    __typename: 'Track',
    uri: 'spotify:track:' + id,
    name,
    artists: { items: [{ uri: 'spotify:artist:' + ARTIST, profile: { name: 'Alice Cooper' } }] },
    albumOfTrack: {
      uri: 'spotify:album:' + ALBUM,
      name: 'Album One',
      coverArt: {
        sources: [
          { url: 'https://img/cover-64.jpg', width: 64 },
          { url: 'https://img/cover-300.jpg', width: 300 },
          { url: 'https://img/cover-tie.jpg', width: 300 },
        ],
      },
    },
    duration: { totalMilliseconds: 193000 },
  }, extra || {});
}

function albumUnion(extra) {
  return Object.assign({
    __typename: 'Album',
    uri: 'spotify:album:' + ALBUM,
    name: 'Album One',
    coverArt: { sources: [{ url: 'https://img/cover-300.jpg', width: 300 }] },
    artists: { items: [{ uri: 'spotify:artist:' + ARTIST, profile: { name: 'Alice Cooper' } }] },
    date: { isoString: '2020-03-01' },
    tracksV2: { totalCount: 1, items: [{ track: trackData(TRACK_C, 'From Album', { albumOfTrack: undefined }) }] },
  }, extra || {});
}

function playlistPayload(extra) {
  return Object.assign({
    __typename: 'Playlist',
    uri: 'spotify:playlist:' + PLAYLIST,
    name: 'Morning Mix',
    description: '<b>slow</b> &amp; low &#x27;start&#x27; &lt;3',
    images: { items: [{ sources: [{ url: 'https://img/pl-64.jpg', width: 64 }, { url: 'https://img/pl.jpg', width: 300 }] }] },
    ownerV2: { data: { name: 'Alice', username: 'alice' } },
    currentUserCapabilities: { canEditItems: true },
    following: false,
    content: { totalCount: 1, items: [{ uid: 'row-1', itemV2: { data: trackData(TRACK_B, 'From Playlist') } }] },
  }, extra || {});
}

// 每种 pathfinder 查询的"标准答复"。
const ANSWERS = {
  profileAttributes: ok({
    data: { me: { profile: { username: 'alice', name: 'Alice', avatar: { sources: [{ url: 'https://img/avatar-160.jpg', width: 160 }] } } } },
  }),
  libraryV3: ok({
    data: {
      me: {
        libraryV3: {
          totalCount: 1,
          items: [{ item: { data: playlistPayload() } }],
        },
      },
    },
  }),
  fetchLibraryTracks: ok({
    data: {
      me: {
        library: {
          tracks: {
            totalCount: 2,
            items: [
              { track: { _uri: 'spotify:track:' + TRACK_A, data: trackData(TRACK_A, 'Liked One') } },
              { track: { _uri: 'spotify:track:' + TRACK_B, data: trackData(TRACK_B, 'Liked Two') } },
            ],
          },
        },
      },
    },
  }),
  fetchPlaylist: ok({ data: { playlistV2: playlistPayload() } }),
  getAlbum: ok({ data: { albumUnion: albumUnion() } }),
  searchTracks: ok({
    data: {
      searchV2: {
        tracksV2: {
          totalCount: 1,
          items: [{ item: { data: trackData(TRACK_D, 'Found Song') } }],
        },
      },
    },
  }),
  areEntitiesInLibrary: ok({ data: { lookup: [{ data: { saved: true } }, { data: { saved: false } }] } }),
  addToLibrary: ok({ data: { addToLibrary: { __typename: 'AddToLibraryResponse' } } }),
  removeFromLibrary: ok({ data: { removeFromLibrary: { __typename: 'RemoveFromLibraryResponse' } } }),
  addItemsToRootlist: ok({ data: { addItemsToRootlist: { __typename: 'RootlistResponse' } } }),
  removeItemsFromRootlist: ok({ data: { removeItemsFromRootlist: { __typename: 'RootlistResponse' } } }),
  addToPlaylist: ok({ data: { addToPlaylist: { __typename: 'AddToPlaylistResponse' } } }),
};

const PRODUCT_STATE = ok({ catalogue: 'premium', product: 'premium' });

function lyricsAnswer(lines, syncType) {
  return ok({ lyrics: { syncType: syncType || 'LINE_SYNCED', lines } });
}

// ---------- 传输层桩 ----------

function responseKey(record) {
  if (record.url.includes('api-partner.spotify.com')) {
    let operationName = '';
    try { operationName = JSON.parse(record.body || '{}').operationName || ''; } catch (_) { operationName = ''; }
    return 'pathfinder:' + operationName;
  }
  if (record.url.includes('spclient.wg.spotify.com')) {
    const path = record.url.replace('https://spclient.wg.spotify.com', '').split('?')[0];
    return 'spclient:' + path;
  }
  return 'other:' + record.url;
}

function makePartner(script) {
  const requests = [];
  const responses = {};
  const notes = [];
  const tokens = [];

  const requestJson = async (url, opts, body) => {
    const record = {
      url: String(url),
      method: opts.method,
      timeoutMs: opts.timeoutMs,
      headers: Object.entries(opts.headers || {}),
      body: body == null ? null : String(body),
    };
    requests.push(record);
    const key = responseKey(record);
    const answer = script(record) || ok({});
    if (!responses[key]) responses[key] = [];
    responses[key].push(answer.error ? { error: answer.error } : { ok: answer.ok === undefined ? {} : answer.ok });
    if (answer.error) {
      const error = new Error(answer.error.message);
      error.statusCode = answer.error.statusCode;
      error.body = answer.error.body;
      throw error;
    }
    return answer.ok === undefined ? {} : answer.ok;
  };

  const getAccessToken = async (options) => {
    tokens.push(options && options.force === true ? 'force' : 'plain');
    return 'tok-' + tokens.length;
  };

  const partner = createSpotifyPartner({
    requestJson,
    getAccessToken,
    language: 'zh-CN',
    timeoutMs: 20000,
    warn: (text) => notes.push('warn:' + text),
    log: (text) => notes.push('log:' + text),
  });

  return { partner, requests, responses, notes, tokens };
}

// ---------- 用例 ----------

const CASES = [];

function add(fn, args, script, note) {
  CASES.push({ fn, args, script, note });
}

// —— 账号 ——
add('readAccount', [null], (record) => {
  if (record.url.includes('product_state')) return PRODUCT_STATE;
  return ANSWERS.profileAttributes;
}, '账号 + 付费方案都读到了');

add('readAccount', [null], (record) => {
  // 方案那一路失败只 warn，`premium` 键整个不出现
  if (record.url.includes('product_state')) return fail(500, 'boom');
  return ANSWERS.profileAttributes;
}, '读方案失败：warn 一次，premium 键缺失');

add('readAccount', [null], (record) => {
  if (record.url.includes('product_state')) return fail(500, 'boom');
  return ok({ data: { me: { profile: { name: 'Nobody' } } } });
}, '有 profile 但没有 username → NO_ACCOUNT');

// —— 搜索 / 喜欢 / 资料库 ——
add('searchTracks', ['found song', 0, 20], () => ANSWERS.searchTracks, '搜索：一行结果');
add('searchTracks', ['nothing', 40, 20], () => ok({ data: {} }), '搜索：没有 tracksV2');
add('likedTracks', [0, 48], () => ANSWERS.fetchLibraryTracks, '喜欢的歌：uri 在行上');
add('libraryPlaylists', [0, 50], () => ANSWERS.libraryV3, '资料库歌单：卡片 + 简介实体');

// —— 歌单 ——
add('playlistHead', [PLAYLIST], () => ANSWERS.fetchPlaylist, '歌单头：只取 1 行');
add('playlistHead', ['spotify:playlist:' + PLAYLIST], () => ANSWERS.fetchPlaylist, '歌单头：直接给 URI');
add('playlistHead', [PLAYLIST], () => ok({ data: {} }), '歌单头：没有 playlistV2 → null');
add('playlistTracks', [PLAYLIST, 0, 48], () => ANSWERS.fetchPlaylist, '歌单曲目');
add('playlistTracks', [PLAYLIST, 0, 48], () => ok({ data: {} }), '歌单不存在 → NO_PLAYLIST');

// 曲目数挂在五个不同的路径上（真实世界的三种来源）
const COUNT_PATHS = [
  ['content.totalCount', { content: { totalCount: 7, items: [] } }],
  ['tracksV2.totalCount', { tracksV2: { totalCount: 8 } }],
  ['tracks.totalCount', { tracks: { totalCount: 9 } }],
  ['list.totalCount', { totalCount: 10 }],
  ['_content.totalCount', { _content: { totalCount: 11 } }],
  ['content 为 null 时回落到 totalCount', { content: null, totalCount: 12 }],
];
for (const [label, extra] of COUNT_PATHS) {
  add('playlistHead', [PLAYLIST], () => ok({ data: { playlistV2: playlistPayload(extra) } }), '曲目数来源：' + label);
}

// —— 专辑 ——
add('album', [ALBUM, 0, 80], () => ANSWERS.getAlbum, '专辑：曲目继承 album');
add('album', ['spotify:album:' + ALBUM, 0, 80], () => ANSWERS.getAlbum, '专辑：直接给 URI');
add('album', [ALBUM, 0, 80], () => ok({ data: {} }), '专辑不存在 → NO_ALBUM');
add('album', [ALBUM, 0, 80], () => ok({
  data: {
    albumUnion: albumUnion({
      date: { year: 2021 },
      tracksV2: { totalCount: 0, items: [] },
      tracks: { totalCount: 3 },
    }),
  },
}), '专辑：date.year 是数字、曲目数回落到 tracks');

// —— 收藏查询 / 写入 ——
add('libraryLookup', [['spotify:track:' + TRACK_A, 'spotify:album:' + ALBUM]], () => ANSWERS.areEntitiesInLibrary, '批量查询收藏状态');
add('libraryLookup', [[]], () => ok({ data: {} }), '空数组 → 不发请求');
add('setLibrary', ['spotify:track:' + TRACK_A, true], () => ANSWERS.addToLibrary, '收藏单曲');
add('setLibrary', ['spotify:track:' + TRACK_A, false], () => ANSWERS.removeFromLibrary, '取消收藏单曲');
add('setLibrary', ['spotify:album:' + ALBUM, true], () => ANSWERS.addToLibrary, '收藏专辑走 addToLibrary');
add('setLibrary', ['spotify:playlist:' + PLAYLIST, true], (record) => {
  if (record.url.includes('api-partner') && JSON.parse(record.body).operationName === 'fetchPlaylist') {
    return ANSWERS.fetchPlaylist;
  }
  return ANSWERS.addItemsToRootlist;
}, '收藏歌单走 addItemsToRootlist');
add('setLibrary', ['spotify:playlist:' + PLAYLIST, false], (record) => {
  if (record.url.includes('api-partner') && JSON.parse(record.body).operationName === 'fetchPlaylist') {
    return ANSWERS.fetchPlaylist;
  }
  return ANSWERS.removeItemsFromRootlist;
}, '取消收藏别人的歌单');
add('setLibrary', ['spotify:playlist:' + PLAYLIST, false], (record) => {
  if (record.url.includes('api-partner') && JSON.parse(record.body).operationName === 'fetchPlaylist') {
    return ok({ data: { playlistV2: playlistPayload({ ownerV2: { data: { name: 'Me', username: 'me' } } }) } });
  }
  return ANSWERS.removeItemsFromRootlist;
}, '取消收藏别人的歌单（owner 不是自己）');
add('setLibrary', ['spotify:episode:' + TRACK_A, true], () => ok({}), '不认识的条目 → INVALID_ITEM');

// 自己的歌单不能取消收藏：需要先 readAccount 把 ownUsername 写进去
add('readAccountThenSetLibrary', [null, 'spotify:playlist:' + PLAYLIST, false], (record) => {
  if (record.url.includes('product_state')) return PRODUCT_STATE;
  if (record.url.includes('api-partner')) {
    const operation = JSON.parse(record.body).operationName;
    if (operation === 'profileAttributes') return ANSWERS.profileAttributes;
    return ANSWERS.fetchPlaylist;
  }
  return ok({});
}, '先读账号再取消收藏自己的歌单 → OWN_PLAYLIST');

// —— 写入歌单 ——
add('addToPlaylist', [PLAYLIST, [TRACK_A]], (record) => {
  const operation = record.url.includes('api-partner') ? JSON.parse(record.body).operationName : '';
  if (operation === 'fetchPlaylist') {
    // 歌单里已经有 TRACK_A：去重应当把它剔掉，最终零新增
    return ok({
      data: {
        playlistV2: playlistPayload({
          content: { totalCount: 1, items: [{ itemV2: { data: trackData(TRACK_A, 'Already Here') } }] },
        }),
      },
    });
  }
  return ANSWERS.addToPlaylist;
}, '加歌：已经有 → added 0');
add('addToPlaylist', [PLAYLIST, [TRACK_C, TRACK_D]], (record) => {
  const operation = record.url.includes('api-partner') ? JSON.parse(record.body).operationName : '';
  if (operation === 'fetchPlaylist') {
    return ok({
      data: {
        playlistV2: playlistPayload({
          content: { totalCount: 1, items: [{ itemV2: { data: trackData(TRACK_A, 'Already Here') } }] },
        }),
      },
    });
  }
  return ANSWERS.addToPlaylist;
}, '加歌：两首新的');
add('addToPlaylist', [PLAYLIST, [TRACK_C, TRACK_C, TRACK_D]], (record) => {
  const operation = record.url.includes('api-partner') ? JSON.parse(record.body).operationName : '';
  if (operation === 'fetchPlaylist') return ANSWERS.fetchPlaylist;
  return ANSWERS.addToPlaylist;
}, '加歌：重复 id 先按 Set 去重');
add('addToPlaylist', [PLAYLIST, [TRACK_C]], (record) => {
  const operation = record.url.includes('api-partner') ? JSON.parse(record.body).operationName : '';
  if (operation === 'fetchPlaylist') return fail(500, 'read failed');
  return ANSWERS.addToPlaylist;
}, '加歌：去重读取失败 → warn 后照写');
add('addToPlaylist', [PLAYLIST, ['short']], () => ok({}), '加歌：id 不是 22 位');
add('addToPlaylist', [PLAYLIST, []], () => ok({}), '加歌：空列表');
add('addToPlaylist', ['not-a-playlist', [TRACK_A]], () => ok({}), '加歌：歌单 URI 不合法');
add('addToPlaylist', [PLAYLIST, Array.from({ length: 101 }, (_, i) => String(i).padStart(22, '0'))], () => ok({}), '加歌：超过 100 首');

// —— 新建歌单 ——
add('createPlaylist', ['Late Night'], (record) => {
  if (record.url.includes('/playlist/v2/playlist')) {
    return ok({ uri: 'spotify:playlist:' + PLAYLIST });
  }
  return ANSWERS.addItemsToRootlist;
}, '新建歌单：两步（ops + rootlist）');
add('createPlaylist', ['   '], () => ok({}), '新建歌单：名字全空白');
add('createPlaylist', ['x'.repeat(101)], () => ok({}), '新建歌单：名字超 100');
add('createPlaylist', ['ok name'], () => ok({ uri: 'not-a-uri' }), '新建歌单：返回的 uri 不合法');

// —— 歌词 ——
add('lyrics', [TRACK_A], () => lyricsAnswer([
  { startTimeMs: '0', words: 'first line' },
  { startTimeMs: '4200', words: 'second line' },
]), '歌词：逐行带时间');
add('lyrics', [TRACK_A], () => lyricsAnswer([{ startTimeMs: '1000', words: 'unsynced' }], 'UNSYNCED'), '歌词：非逐行同步');
add('lyrics', [TRACK_A], () => fail(404, ''), '歌词：404 → null');
add('lyrics', [TRACK_A], () => ok({ lyrics: { syncType: 'LINE_SYNCED', lines: [] } }), '歌词：空行 → null');
add('lyrics', ['bad-id'], () => ok({}), '歌词：曲目 id 不合法');

// —— 哈希失效 / 没有数据 / 401 ——
add('query', ['profileAttributes', {}], () => fail(400, '{"errors":[{"message":"PersistedQueryNotFound"}]}'), '哈希被换：400 → RETIRED');
add('query', ['profileAttributes', {}], () => fail(404, 'not found'), '哈希被换：404 → RETIRED');
add('query', ['profileAttributes', {}], () => ok({ errors: [{ message: 'PersistedQueryNotFound' }] }), '哈希被换：200 + errors → RETIRED');
add('query', ['profileAttributes', {}], () => ok({ errors: [{ message: 'That playlist has no items Spotify can read' }] }), '查询没数据 → NO_DATA（不是降级信号）');
add('query', ['profileAttributes', {}], () => ok({ errors: [] }), '没有 data 也没有 errors → RETIRED');
add('query', ['profileAttributes', {}], () => ok({ data: {} }), 'data 是空对象 → 算有数据（JS 真值）');
add('query', ['profileAttributes', {}], () => ok({ data: null, errors: [{ message: 'partial' }] }), 'data 是 null + 无关错误 → NO_DATA');
add('query', ['profileAttributes', {}], () => ok({ data: { me: {} }, errors: [{ message: 'partly failed' }] }), '有 data 但有 errors → warn 后照用');
add('query', ['unknownQuery', {}], () => ok({}), '未知查询名 → UNSUPPORTED');
add('query', ['profileAttributes', {}], (() => {
  // 第一次 401，换令牌后第二次成功 —— 验证"force 取一次 + 再取一次"的三段调用。
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? fail(401, 'expired') : ANSWERS.profileAttributes;
  };
})(), '令牌过期：401 → 换令牌重试成功');
add('query', ['profileAttributes', {}], () => fail(503, 'unavailable'), '其它状态码原样透出');
add('query', ['profileAttributes', {}], () => ({ error: { statusCode: undefined, body: '', message: 'ECONNRESET' } }), '网络错误：没有 statusCode');

add('change', ['addToLibrary', { libraryItemUris: ['spotify:track:' + TRACK_A] }], () => ok({ data: { addToLibrary: { ok: true } } }), '改动成功 → true');
add('change', ['addToLibrary', {}], () => ok({ data: {} }), '改动被拒：data 是空对象 → CHANGE_REFUSED');
add('change', ['addToLibrary', {}], () => ok({ data: { addToLibrary: null } }), '改动被拒：结果是 null');
add('change', ['addToLibrary', {}], () => ok({ data: [{ ok: true }] }), '改动的 data 是数组也认（Object.values）');
add('change', ['addToLibrary', {}], () => ok({ errors: [{ message: 'nope' }] }), '改动带 errors → CHANGE_REFUSED');
add('change', ['unknownChange', {}], () => ok({}), '未知改动名 → UNSUPPORTED');
add('change', ['addToLibrary', {}], () => fail(400, 'gone'), '改动 400 → RETIRED');

// ---------- 执行 ----------

const CALLS = {
  readAccount: (partner, [token]) => partner.readAccount(token === undefined ? undefined : token),
  searchTracks: (partner, [text, offset, limit]) => partner.searchTracks(text, offset, limit),
  likedTracks: (partner, [offset, limit]) => partner.likedTracks(offset, limit),
  libraryPlaylists: (partner, [offset, limit]) => partner.libraryPlaylists(offset, limit),
  playlistHead: (partner, [id]) => partner.playlistHead(id),
  playlistTracks: (partner, [id, offset, limit]) => partner.playlistTracks(id, offset, limit),
  album: (partner, [id, offset, limit]) => partner.album(id, offset, limit),
  libraryLookup: (partner, [uris]) => partner.libraryLookup(uris),
  setLibrary: (partner, [uri, saved]) => partner.setLibrary(uri, saved),
  readAccountThenSetLibrary: async (partner, [token, uri, saved]) => {
    await partner.readAccount(token);
    return partner.setLibrary(uri, saved);
  },
  addToPlaylist: (partner, [id, ids]) => partner.addToPlaylist(id, ids),
  createPlaylist: (partner, [name]) => partner.createPlaylist(name),
  lyrics: (partner, [id]) => partner.lyrics(id),
  query: (partner, [name, variables]) => partner.query(name, variables),
  change: (partner, [name, variables]) => partner.change(name, variables),
};

function errorShape(error) {
  const shape = { code: error.code || '', message: error.message || '' };
  if (error.detail !== undefined) shape.detail = error.detail;
  if (error.partnerQuery !== undefined) shape.partnerQuery = error.partnerQuery;
  // 传输层原样透出的两个字段。空 body 不写 —— 与 Rust 侧 `Option<String>` 的 None 对齐。
  if (error.statusCode !== undefined && error.statusCode !== null) shape.statusCode = error.statusCode;
  if (error.body) shape.body = String(error.body);
  return shape;
}

async function main() {
  const lines = [];
  for (const item of CASES) {
    const env = makePartner(item.script);
    let value;
    let error;
    try {
      value = await CALLS[item.fn](env.partner, item.args);
    } catch (caught) {
      error = errorShape(caught);
    }
    const entry = { fn: item.fn, args: item.args };
    if (error) entry.err = error;
    else entry.ok = value === undefined ? null : value;
    entry.requests = env.requests;
    entry.responses = env.responses;
    entry.tokens = env.tokens;
    if (env.notes.length) entry.notes = env.notes;
    entry.note = item.note;
    lines.push(JSON.stringify(entry));
  }
  return lines;
}

const fs = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, '..', 'crates', 'mineradio-core', 'tests', 'fixtures', 'spotify-partner-cases.jsonl');

(async () => {
  const lines = await main();
  const text = lines.join('\n') + '\n';
  const summary = `共 ${lines.length} 条`;

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : '';
    if (current !== text) {
      const expected = text.split('\n');
      const actual = current.split('\n');
      const firstDiff = expected.findIndex((line, index) => line !== actual[index]);
      console.error('FAIL fixture 与 server/spotify-partner.js 的当前行为不一致');
      console.error(`     文件：${path.relative(path.join(__dirname, '..'), FIXTURE_PATH)}`);
      console.error(`     第 ${firstDiff + 1} 条起不同`);
      console.error(`     重录：node scripts/record-spotify-partner.js --write`);
      if (firstDiff >= 0) {
        console.error(`     当前：${String(actual[firstDiff]).slice(0, 240)}`);
        console.error(`     应有：${String(expected[firstDiff]).slice(0, 240)}`);
      }
      process.exit(1);
    }
    console.log(`OK Spotify pathfinder fixture 一致：${summary}`);
    process.exit(0);
  }

  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, text, 'utf8');
    console.log(`已写入 ${path.relative(path.join(__dirname, '..'), FIXTURE_PATH)}`);
    console.log(`  ${summary}`);
    process.exit(0);
  }

  process.stdout.write(text);
  process.stderr.write(summary + '\n');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
