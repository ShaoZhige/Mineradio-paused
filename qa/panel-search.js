'use strict';

// 面板搜索 CDP 冒烟：启动隐藏 Electron，注入队列与歌单，验证
//   1) 队列按歌名/歌手过滤，行上的 data-queue-index 仍是真实下标；
//   2) 左栏与底部迷你队列共用同一个过滤词；
//   3) 歌单只过滤卡片，平台切换器不受影响，搜不到时给专门的空态；
//   4) 清空后恢复整份列表。
// 过滤是在渲染期做的，隐藏窗口的 rAF 节流不影响断言（全部同步调用）。

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(__dirname, '.tmp', 'panel-search');
const QA = path.join(WORK, 'userdata');
const PORT = Number(process.env.MINERADIO_QA_PORT || 9440);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  try { fs.rmSync(QA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { }
  fs.mkdirSync(QA, { recursive: true });
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.MINERADIO_STARTUP_QA_HIDDEN = '1';
  env.MINERADIO_STARTUP_QA_USER_DATA = QA;
  const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
  let ws = null;
  let id = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => { const seq = ++id; pending.set(seq, { resolve, reject }); ws.send(JSON.stringify({ id: seq, method, params })); });
  const evaluate = async (expression) => {
    const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };
  try {
    let target = null;
    for (let i = 0; i < 90 && !target; i += 1) {
      try {
        const ts = await listTargets();
        target = ts.find((t) => t.type === 'page' && /:3\d{3}/.test(t.url || '') && !/startup\.html/.test(t.url || '')) || null;
      } catch (_) { }
      if (!target) await sleep(500);
    }
    assert(target, 'CDP target not found');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params && m.params.exceptionDetails;
        console.error('PAGE-ERROR', d && (d.exception && d.exception.description || d.text));
      }
      const w = pending.get(m.id);
      if (!w) return;
      pending.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error))); else w.resolve(m.result);
    });
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const shot = async (name) => {
      try {
        const res = await call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(WORK, name + '.png'), Buffer.from(res.data, 'base64'));
      } catch (err) { console.error('screenshot failed:', name, err && err.message); }
    };
    for (let i = 0; i < 120; i += 1) {
      if (await evaluate("typeof setQueueSearch === 'function' && typeof renderQueuePanel === 'function'")) break;
      await sleep(250);
    }
    await evaluate("if (typeof dismissSplash === 'function') dismissSplash({ instant: true }); 'ok'");
    await sleep(800);

    // 队列种子：两首 Lemon（大小写不同）+ 中文 + 伪装字段，覆盖歌名/歌手/专辑三条匹配路径。
    const seeded = await evaluate(`(function(){
      playQueue = [
        { id:'t1', name:'Lemon Tree', artist:'Fools Garden', album:'Dish of the Day', source:'netease' },
        { id:'t2', name:'晚风', artist:'陈婧霏', album:'尘埃', source:'netease' },
        { id:'t3', name:'Lemon', artist:'米津玄師', album:'STRAY SHEEP', source:'netease' },
        { id:'t4', name:'晴天', artist:'周杰伦', album:'叶惠美', source:'netease' },
        { id:'t5', name:'Lemonade', artist:'Internet Money', album:'B4', source:'netease' }
      ];
      currentIdx = 0;
      window.__qaPlayed = [];
      playQueueAt = function(i){ window.__qaPlayed.push(i); };
      document.body.classList.remove('empty-home-active','splash-active');
      // 走面板自己的「常开」入口：直接 add('show') 拿不到 .show 的展开位移，
      // 面板会停在 peek 的左移状态，截图与 rect 都对不上。
      if (typeof setPlaylistPanelPinned === 'function') setPlaylistPanelPinned(true, true);
      switchPlaylistTab('queue', { animate:false, save:false });
      renderQueuePanel({ animate:false, scrollCurrent:false });
      return { rows: document.querySelectorAll('#queue-list .queue-item').length, query: queueSearchQuery };
    })()`);
    console.log('queue seeded:', JSON.stringify(seeded));
    assert(seeded.rows === 5, `expected 5 queue rows, got ${seeded.rows}`);

    const filtered = await evaluate(`(function(){
      var input = document.getElementById('queue-search-input');
      input.value = 'lemon';
      setQueueSearch('lemon', input);
      var rows = Array.prototype.map.call(document.querySelectorAll('#queue-list .queue-item'), function(r){ return Number(r.dataset.queueIndex); });
      var names = Array.prototype.map.call(document.querySelectorAll('#queue-list .qi-name'), function(n){ return n.textContent; });
      return { rows: rows, names: names, query: queueSearchQuery, inputValue: input.value,
        miniInput: (document.getElementById('mini-queue-search-input')||{}).value,
        footer: document.getElementById('queue-list').innerHTML.indexOf('queue-hydration') >= 0 };
    })()`);
    console.log('queue filtered:', JSON.stringify(filtered));
    assert(filtered.rows.length === 3, `expected 3 matching tracks, got ${filtered.rows.length}`);
    // 真实下标：0 / 2 / 4，不是过滤后的 0 / 1 / 2。
    assert(JSON.stringify(filtered.rows) === JSON.stringify([0, 2, 4]), 'filtered rows must keep the real playQueue index: ' + JSON.stringify(filtered.rows));
    assert(filtered.names.join('|').toLowerCase().indexOf('晚风') < 0, 'non-matching track leaked into the filtered list');
    assert(filtered.miniInput === 'lemon', 'mini queue input was not synced with the panel input');
    await shot('queue-filtered');

    // 点第 2 行必须播队列里的第 3 首（真实下标 2），不是过滤后的第 2 行。
    const clicked = await evaluate(`(function(){
      document.querySelectorAll('#queue-list .queue-item')[1].click();
      return window.__qaPlayed;
    })()`);
    console.log('clicked:', JSON.stringify(clicked));
    assert(JSON.stringify(clicked) === JSON.stringify([2]), 'clicking a filtered row must play the real queue index, got ' + JSON.stringify(clicked));

    const mini = await evaluate(`(function(){
      setMiniQueueOpen(true);
      renderMiniQueuePanel({ animate:false, scrollCurrent:false });
      var rows = Array.prototype.map.call(document.querySelectorAll('#mini-queue-list .mini-queue-item'), function(r){ return Number(r.dataset.queueIndex); });
      var count = document.getElementById('mini-queue-count').textContent;
      return { rows: rows, count: count };
    })()`);
    console.log('mini:', JSON.stringify(mini));
    assert(JSON.stringify(mini.rows) === JSON.stringify([0, 2, 4]), 'mini queue must reuse the same filter: ' + JSON.stringify(mini.rows));
    assert(/3\s*\/\s*5/.test(mini.count), 'mini queue count should read 匹配/总数, got ' + mini.count);

    const emptyQueue = await evaluate(`(function(){
      var input = document.getElementById('queue-search-input');
      input.value = 'zzzz';
      setQueueSearch('zzzz', input);
      return { text: document.getElementById('queue-list').textContent.trim(), miniText: document.getElementById('mini-queue-list').textContent.trim() };
    })()`);
    console.log('queue empty:', JSON.stringify(emptyQueue));
    assert(/没有匹配|No matching/.test(emptyQueue.text), 'queue search should show a dedicated empty state, got ' + emptyQueue.text);
    assert(/没有匹配|No matching/.test(emptyQueue.miniText), 'mini queue must show the same empty state');

    const restored = await evaluate(`(function(){
      setQueueSearch('');
      setMiniQueueOpen(false);
      return { rows: document.querySelectorAll('#queue-list .queue-item').length, query: queueSearchQuery,
        miniRows: document.querySelectorAll('#mini-queue-list .mini-queue-item').length,
        clearVisible: getComputedStyle(document.querySelector('#queue-search .panel-search-clear')).display };
    })()`);
    console.log('queue restored:', JSON.stringify(restored));
    assert(restored.rows === 5 && restored.query === '', 'clearing the search must restore the full queue');
    assert(restored.clearVisible === 'none', 'the clear button must hide again on an empty box');

    // 歌单：三张卡片，搜到 1 张；再搜不存在的词要看空态，平台切换器仍在。
    const playlists = await evaluate(`(function(){
      userPlaylists = [
        { provider:'netease', id:'p1', name:'夜晚的歌', trackCount:12, creator:'我' },
        { provider:'netease', id:'p2', name:'Morning Run', trackCount:8, creator:'我' },
        { provider:'netease', id:'p3', name:'工作专注', trackCount:30, creator:'我' }
      ];
      playlistCatalogRevision += 1;
      playlistSearchQuery = '';
      switchPlaylistTab('playlists', { animate:false, save:false, refresh:false });
      renderUserPlaylistsList({ animate:false });
      var before = document.querySelectorAll('#pl-list .pl-card').length;
      var input = document.getElementById('pl-search-input');
      input.value = 'morning';
      setPlaylistSearch('morning', input);
      var after = Array.prototype.map.call(document.querySelectorAll('#pl-list .pl-card'), function(c){ return c.dataset.playlistId; });
      var searchRow = document.getElementById('pl-search');
      var queueRow = document.getElementById('queue-search');
      return { before: before, after: after,
        plSearchVisible: !!searchRow && getComputedStyle(searchRow).display !== 'none',
        queueSearchHidden: !!queueRow && getComputedStyle(queueRow).display === 'none' };
    })()`);
    console.log('playlists:', JSON.stringify(playlists));
    assert(playlists.before === 3, 'expected 3 playlist cards before searching, got ' + playlists.before);
    assert(JSON.stringify(playlists.after) === JSON.stringify(['p2']), 'playlist search must keep only the matching card: ' + JSON.stringify(playlists.after));
    assert(playlists.plSearchVisible && playlists.queueSearchHidden, 'search rows must follow the active tab');

    const noPlaylist = await evaluate(`(function(){
      var input = document.getElementById('pl-search-input');
      input.value = 'not-a-playlist';
      setPlaylistSearch('not-a-playlist', input);
      var tabs = document.getElementById('pl-provider-tabs');
      return { html: document.getElementById('pl-list').innerHTML.slice(0, 160),
        empty: /没有匹配|No matching/.test(document.getElementById('pl-list').textContent),
        tabsDisplay: tabs ? tabs.style.display : '(missing)' };
    })()`);
    console.log('playlist empty:', JSON.stringify(noPlaylist));
    assert(noPlaylist.empty, 'playlist search should show a dedicated empty state, got ' + noPlaylist.html);
    await shot('playlist-empty');

    const final = await evaluate(`(function(){
      setPlaylistSearch('');
      var cards = document.querySelectorAll('#pl-list .pl-card').length;
      return { cards: cards, query: playlistSearchQuery };
    })()`);
    console.log('playlist restored:', JSON.stringify(final));
    assert(final.cards === 3 && final.query === '', 'clearing the playlist search must restore all cards');

    console.log('QA panel-search: PASS');
  } finally {
    try { if (ws) ws.close(); } catch (_) { }
    try { child.kill(); } catch (_) { }
  }
})().catch((err) => {
  console.error('QA panel-search: FAIL —', err && err.message);
  process.exit(1);
});
