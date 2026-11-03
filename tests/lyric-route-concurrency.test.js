'use strict';

// /api/lyric 取数路径的回归：两条上游线路必须并发、合并优先级必须是「lyric_new 优先、lyric 补缺」。
//
// 背景：早先的实现是串行 —— 先等 lyric_new，缺翻译再等 lyric。而「没有翻译」恰恰是最常见的情况，
// 于是绝大多数歌曲都要多等一整趟网络（实测单次 ~270ms，其中约一半耗在第二趟）。
// 这类退化不会报错、不会红任何功能测试，只会让首屏歌词慢半拍，所以在这里钉死。
//
// Regression for the /api/lyric loading path: the two upstream routes must run concurrently and
// the merge must keep lyric_new's fields ahead of the legacy route's. The old serial version paid
// two round trips for the common "no translation" case (~270ms, about half of it the second hop).
// Nothing throws when this regresses — the first lyric just arrives late — hence the pin.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER_PATH = path.join(__dirname, '..', 'server', 'server.js');
const source = fs.readFileSync(SERVER_PATH, 'utf8');

// 从源码里按花括号配对截出一个函数体，供 vm 沙箱执行真实实现。
function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `server.js 里找不到 ${name}`);
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`无法截取 ${name} 的函数体`);
}

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `找不到起点：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `找不到终点：${endMarker}`);
  return source.slice(start, end);
}

// lyricNodeText 在 server.js 里的语义是「取出该字段的歌词文本」，这里给行为等价的最小实现。
function makeSandbox() {
  const context = {
    lyricNodeText(body, key) {
      const node = body && body[key];
      if (!node) return '';
      if (typeof node === 'string') return node;
      return typeof node.lyric === 'string' ? node.lyric : '';
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('mergeLyricBodies'), context);
  vm.runInContext(extractFunction('lyricPayloadFromBody'), context);
  return context;
}

const sandbox = makeSandbox();

// vm 里造出来的对象带的是沙箱自己的 Object.prototype，deepStrictEqual 会因为原型不同而失败。
// 这里先 JSON 归一化成本 realm 的普通对象再比。
// Objects created inside the vm carry the sandbox's Object.prototype, which deepStrictEqual
// rejects on prototype mismatch — normalize through JSON first.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 合并优先级
// ---------------------------------------------------------------------------

assert.deepStrictEqual(
  plain(sandbox.mergeLyricBodies(
    { lrc: { lyric: '[00:01.00]主线' }, yrc: { lyric: '逐字' } },
    { lrc: { lyric: '[00:09.00]旧接口' }, tlyric: { lyric: '翻译' } }
  )),
  { lrc: { lyric: '[00:01.00]主线' }, yrc: { lyric: '逐字' }, tlyric: { lyric: '翻译' } },
  'lyric_new 已有的字段不能被旧接口覆盖，旧接口只补缺'
);

assert.deepStrictEqual(
  plain(sandbox.mergeLyricBodies({}, { lrc: { lyric: '只有旧接口' } })),
  { lrc: { lyric: '只有旧接口' } },
  'lyric_new 为空时应落到旧接口的结果'
);

const payload = sandbox.lyricPayloadFromBody(
  {
    lrc: { lyric: '主歌词' },
    tlyric: { lyric: '翻译' },
    yrc: { lyric: '逐字' },
    ytlrc: { lyric: '逐字翻译' },
    romalrc: { lyric: '罗马音' },
    yromalrc: { lyric: '逐字罗马音' },
  },
  'lyric_new+lyric'
);
assert.deepStrictEqual(plain(payload), {
  lyric: '主歌词',
  tlyric: '翻译',
  yrc: '逐字',
  ytlrc: '逐字翻译',
  romalrc: '罗马音',
  yromalrc: '逐字罗马音',
  source: 'lyric_new+lyric',
});
assert.strictEqual(
  sandbox.lyricPayloadFromBody({}, 'lyric').lyric,
  '',
  '空 body 必须回空串而不是 undefined，前端按字符串处理'
);

// ---------------------------------------------------------------------------
// 并发与缓存（源码级，因为这是调度形态而不是可调用返回值）
// ---------------------------------------------------------------------------

const loader = extractFunction('loadNeteaseLyricBundle');
assert.ok(loader.includes('Promise.allSettled'), '两条上游线路必须并发，不能串行 await');
assert.ok(
  loader.indexOf('lyric_new(') > -1 && loader.indexOf('lyric(') > -1,
  '并发块里应同时出现 lyric_new 与 lyric'
);
// 串行铁证：先单独 await lyric_new，再在另一个语句里 await lyric。
assert.ok(
  !/await\s+lyric_new\s*\([^)]*\)\s*;[\s\S]{0,400}?await\s+lyric\s*\(/.test(loader),
  '检测到串行 await：lyric_new 之后再 await lyric'
);
assert.ok(loader.includes('lyricInflight'), '同一首歌的并发请求必须合流，避免重复打上游');
assert.ok(loader.includes('readLyricResponseCache'), '应优先读短时缓存');
// 缓存写入必须把 body 一起传进去：writeLyricResponseCache 靠 body 判断「是不是空结果」，
// 漏传的话它每次都判定为空、缓存永不写入 —— 表现是缓存完全失效，但不会报任何错。
assert.ok(
  /writeLyricResponseCache\(id,\s*payload,\s*body\)/.test(loader),
  '缓存写入必须带上 body，否则空结果判定永远拿不到字段、缓存永不命中'
);

const route = sliceBetween("if (pn === '/api/lyric') {", "// ---------- 歌曲评论 ----------");
assert.ok(
  route.includes('loadNeteaseLyricBundle'),
  '/api/lyric 路由必须委托给 loadNeteaseLyricBundle，不要在路由里再写一遍取数'
);
assert.ok(
  !route.includes('await lyric('),
  '/api/lyric 路由里不应再出现直接的串行上游调用'
);

// 缓存参数要有限：TTL 有界、条数有界，且空结果不缓存（否则一次上游抽风会挂十分钟）。
assert.ok(/LYRIC_RESPONSE_TTL_MS\s*=\s*\d+\s*\*\s*60\s*\*\s*1000/.test(source), '缓存 TTL 必须是有界分钟数');
assert.ok(/LYRIC_RESPONSE_CACHE_LIMIT\s*=\s*\d+/.test(source), '缓存必须有条数上限');

// 🔴 缓存与 in-flight 必须在 createServer 回调**外面**声明。
// 建在回调里等于每个请求重建一份 Map：短时缓存永远命中不了、合流永远合不上，
// 而且不报任何错 —— 只看代码很难发现，只有实测「第二次还是同样慢」才露馅。
const cacheDecl = source.indexOf('const lyricResponseCache = new Map()');
const inflightDecl = source.indexOf('const lyricInflight = new Map()');
const serverDecl = source.indexOf('const server = http.createServer');
assert.ok(cacheDecl > -1 && inflightDecl > -1, '应能找到缓存与 in-flight 的声明');
assert.ok(
  cacheDecl < serverDecl && inflightDecl < serverDecl,
  '缓存与 in-flight 必须声明在 createServer 之前（模块作用域），否则每个请求都会重建，缓存与合流全部失效'
);
const cacheLine = source.slice(source.lastIndexOf('\n', cacheDecl) + 1, source.indexOf('\n', cacheDecl));
assert.ok(!/^\s/.test(cacheLine), '缓存声明不能有缩进：缩进就意味着还嵌在某个函数里');

// 同理，取数与合并链上的每个函数都必须落在模块作用域。
// 只要有一个还嵌在 createServer 回调里，模块级的 loadNeteaseLyricBundle 就会在运行时抛
// "xxx is not defined" —— 语法检查发现不了，只有真打一次接口才暴露。
for (const name of ['lyricNodeText', 'lyricBodyHasPrimary', 'lyricBodyHasTranslation', 'mergeLyricBodies', 'loadNeteaseLyricBundle']) {
  const idx = source.indexOf(`function ${name}(`);
  assert.ok(idx > -1, `缺少 ${name}`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  assert.ok(
    !/^\s/.test(source.slice(lineStart, lineStart + 2)),
    `${name} 必须在模块作用域：有缩进说明它还嵌在 createServer 回调里，运行时会取不到`
  );
}
const cacheWriter = extractFunction('writeLyricResponseCache');
assert.ok(cacheWriter.includes('lyricBodyHasPrimary'), '空结果判断必须复用既有字段判定，别另写一套');
assert.ok(cacheWriter.includes('lyricBodyHasTranslation'), '空结果判断要同时看翻译字段');

console.log('lyric route concurrency: ok');
