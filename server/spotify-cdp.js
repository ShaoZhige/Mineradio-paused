// ============================================================================================
// Regarding the Spotify section, due to the strict policies and terms of the Spotify platform,
// I had to adopt this last resort, using a method similar to 'hijacking' to utilize the official
// player. This is solely a measure of necessity and not malicious intent. If it violates any
// terms, I will promptly remove the code.
// ============================================================================================

'use strict';

// Spotify 客户端状态桥 / Local Spotify client state bridge.
//
// 为什么是这条路（2026-11-17/18 实测，别再换回去）：
//   · Web API /v1/me/player/*   → 免费账号 403，Premium 限定
//   · 系统媒体会话 SMTC          → 客户端把 HardwareMediaKeyHandling 关了，压根不发布会话
//   · UI Automation              → 能读到控件，但值是从不刷新的快照（属性变化事件 0 个）
//   · CDP（本文件）              → 客户端以 --remote-debugging-port=9222 启动后，本地执行 JS
//     拿到毫秒级进度、播放态、曲目、音量，并能定向点按钮，零配额、零安装、不需要 Premium。
//
// 通道分两级，优先用第一级：
//
//   ① API 级（2026-11-18 打通）：往页面注入 `spotify-cdp-bridge.js`，从 React fiber 里挖出
//      DI 容器，`resolve(Symbol.for('PlayerAPI'))` 直接拿到 PlayerAPI。
//      `play({uri})` 精确点播（实测 1.96s 切歌，连切可重复）、`_state` 给毫秒级真进度、
//      `seekTo` / `skipToNext` / `pause` / `resume` 全在，音量走 `PlaybackAPI.setVolume`。
//      **不改任何客户端文件、不装 Spicetify**。
//   ② DOM 级（兜底）：老办法 —— 点搜索框、敲字、点结果行。慢（4~7s）、依赖界面语言，
//      而且可能点到同名曲的另一版录音。只在注入失败时用。
//
// 为什么不再用深链接 / 协议投递：
//   · `spotify:` 协议投递到带 9222 的实例上不生效；页面内 location.assign 跳到 spotify: URI
//     只有**每次页面加载后的第一次**会成功，之后一律被丢弃（2026-11-18 连续三次实测）。
//     hash 路由（#/track/<id>）不触发 SPA 路由；桌面端主世界没有 webpackChunk*，只有 rspack。
//
// 端口只在 127.0.0.1；客户端没带参数启动时 readState() 直接返回 unavailable，
// 上层该保留原有的换源/跳歌行为，不能把用户晾在无声界面上。
//
// Node 22 / Electron 自带 fetch 与 WebSocket，这里不引入任何依赖。

const { BRIDGE_SOURCE } = require('./spotify-cdp-bridge');

const DEFAULT_PORT = 9222;
const REQUEST_TIMEOUT_MS = 3500;
const STATE_CACHE_MS = 700;
// 点播是"敲字 + 等结果"的交互流程，比单次求值慢得多，单独一套预算。
const PLAY_SEARCH_TIMEOUT_MS = 9000;
const PLAY_CONFIRM_TIMEOUT_MS = 7000;
const PLAY_POLL_MS = 350;
// 刚被拉起来的客户端要先下载/渲染 xpui 页面，这段时间 DOM 是空的。
const PLAY_READY_TIMEOUT_MS = 12000;

// 一次 Runtime.evaluate 取回全部字段。曲目名与艺人在 now-playing-widget-v2 的 innerText 里，
// 进度是 <input type=range> 的 value/max（单位就是毫秒，比界面上 "2:55" 精确）。
const STATE_EXPRESSION = [
  '(() => {',
  '  const q = s => document.querySelector(s);',
  '  const widget = q("[data-testid=\\"now-playing-widget-v2\\"]");',
  '  const button = q("[data-testid=\\"control-button-playpause\\"]");',
  '  const progress = q("[data-testid=\\"playback-progressbar\\"] input");',
  '  const volume = q("[data-testid=\\"volume-bar\\"] input");',
  '  const positionLabel = q("[data-testid=\\"playback-position\\"]");',
  '  const parseClock = s => { const m = /^(\\d+):(\\d{2})$/.exec(String(s || "").trim()); return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null; };',
  '  const fineMs = progress ? parseClock(String(progress.getAttribute("aria-valuetext") || "").split("/")[0]) : null;',
  '  const shownMs = parseClock(positionLabel ? positionLabel.textContent : "");',
  '  const coarseMs = progress ? Number(progress.value) || 0 : 0;',
  '  const parts = widget ? String(widget.innerText || "").split("\\n").map(s => s.trim()).filter(Boolean) : [];',
  '  const label = widget ? String(widget.getAttribute("aria-label") || "") : "";',
  '  const buttonLabel = button ? String(button.getAttribute("aria-label") || "") : "";',
  '  return JSON.stringify({',
  '    label: label,',
  '    title: parts[0] || "",',
  '    artist: parts.slice(1).join(", "),',
  '    playButton: buttonLabel,',
  '    isPlaying: /暂停|pause/i.test(buttonLabel),',
  '    positionMs: fineMs != null ? fineMs : (shownMs != null ? shownMs : coarseMs),',
  '    durationMs: progress ? Number(progress.max) || 0 : 0,',
  '    volume: volume ? Math.round((Number(volume.value) || 0) * 100) : 0,',
  '    hasProgress: !!progress',
  '  });',
  '})()',
].join('\n');

function commandExpression(name, payload) {
  // 参数一律走 JSON 字面量，不拼字符串到脚本里。
  const data = JSON.stringify(payload && typeof payload === 'object' ? payload : {});
  return [
    '(() => {',
    '  const p = ' + data + ';',
    '  const q = s => document.querySelector(s);',
    '  const click = id => { const el = q("[data-testid=\\"" + id + "\\"]"); if (!el) return false; el.click(); return true; };',
    '  const setRange = (input, value) => {',
    '    if (!input) return false;',
    '    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;',
    '    setter.call(input, String(value));',
    '    input.dispatchEvent(new Event("input", { bubbles: true }));',
    '    input.dispatchEvent(new Event("change", { bubbles: true }));',
    '    return true;',
    '  };',
    '  const buttonLabel = () => { const b = q("[data-testid=\\"control-button-playpause\\"]"); return b ? String(b.getAttribute("aria-label") || "") : ""; };',
    '  const playing = () => /暂停|pause/i.test(buttonLabel());',
    '  let ok = false;',
    '  switch (p.name) {',
    '    case "Play": ok = playing() || click("control-button-playpause"); break;',
    '    case "Pause": ok = !playing() || click("control-button-playpause"); break;',
    '    case "TogglePlay": ok = click("control-button-playpause"); break;',
    '    case "NextSong": ok = click("control-button-skip-forward"); break;',
    '    case "PreviousSong": ok = click("control-button-skip-back"); break;',
    '    case "Seek": ok = setRange(q("[data-testid=\\"playback-progressbar\\"] input"), Math.max(0, Math.round(Number(p.position) || 0))); break;',
    '    case "SetVolume": ok = setRange(q("[data-testid=\\"volume-bar\\"] input"), Math.max(0, Math.min(1, Number(p.level) || 0))); break;',
    '    default: return JSON.stringify({ ok: false, error: "unsupported command" });',
    '  }',
    '  return JSON.stringify({ ok: ok });',
    '})()',
  ].join('\n');
}

// 搜索结果行的定位表达式。
// 只在 role="row" 内部找 —— 侧边栏歌单、Top result 卡片上也有同名按钮，
// 一旦点在它们上面会变成"播放整个歌单"，而不是我们要的那一首。
// 标签文字随界面语言变（播放“X” / Play “X”），所以只按"含曲名"匹配，不匹配前缀。
// 另外 aria-label 里带曲名的按钮不止一个（还有"更多…的选项"），挨个匹配会点错；
// 真正的播放按钮在每行的 media 单元格里，收紧到那里最稳。
function pickRowExpression(title, artist) {
  const data = JSON.stringify({ title: String(title || ''), artist: String(artist || '') });
  return [
    '(() => {',
    '  const p = ' + data + ';',
    '  const norm = s => String(s || "").toLowerCase().replace(/\\s+/g, " ").trim();',
    '  const want = norm(p.title);',
    '  const artist = norm(p.artist);',
    '  if (!want) return JSON.stringify({ ok: false, reason: "no-title" });',
    '  const rows = [...document.querySelectorAll("[role=\\"row\\"]")];',
    '  const candidates = [];',
    '  for (const row of rows) {',
    '    const rowText = norm(row.innerText);',
    '    if (rowText.indexOf(want) < 0) continue;',
    '    // 播放按钮在 media 单元格里；more-button 的 aria-label 也含曲名，必须排除。',
    '    const media = row.querySelector("[data-testid=\\"media\\"] button[aria-label], [data-testid=\\"media\\"] [role=\\"button\\"][aria-label]");',
    '    const loose = [...row.querySelectorAll("button[aria-label], [role=\\"button\\"][aria-label]")]',
    '      .filter(b => String(b.getAttribute("data-testid") || "") !== "more-button");',
    '    const button = (media && norm(media.getAttribute("aria-label")).indexOf(want) >= 0)',
    '      ? media',
    '      : loose.find(b => norm(b.getAttribute("aria-label")).indexOf(want) >= 0);',
    '    if (!button) continue;',
    '    let score = media === button ? 12 : 10;',
    '    if (rowText.indexOf(want + " ") === 0 || rowText === want) score += 2;',
    '    if (artist && rowText.indexOf(artist) >= 0) score += 3;',
    '    // 标签里那对引号中的才是曲名本身；完全相等的版本（原版）优先于 (Jazz Version) 之类。',
    '    const quoted = (String(button.getAttribute("aria-label") || "").match(/[“"«„](.+?)[”"»«]/) || [])[1] || "";',
    '    const shown = norm(quoted);',
    '    if (shown && shown === want) score += 4;',
    '    else if (shown && shown.indexOf(want) === 0) score += 1;',
    '    // 目标本身不是现场/伴奏版时，别把别的版本当正主（离线搜不到原版时才会轮到这里）。',
    '    if (!/(live|remix|karaoke|instrumental|acoustic|cover|demo|现场|翻唱|伴奏|纯音乐)/i.test(want) &&',
    '        /(live|remix|karaoke|instrumental|acoustic|cover|demo|现场|翻唱|伴奏|纯音乐)/i.test(shown)) score -= 2;',
    '    // 歌曲列表行有多个单元格；"最近播放/Top result"那种卡片行没有，别优先它。',
    '    if (row.querySelectorAll("[role=\\"gridcell\\"]").length >= 3) score += 2;',
    '    candidates.push({ button, score, label: String(button.getAttribute("aria-label") || ""), row: rowText.slice(0, 60) });',
    '  }',
    '  if (!candidates.length) return JSON.stringify({ ok: false, reason: "not-found", rows: rows.length });',
    '  candidates.sort((a, b) => b.score - a.score);',
    '  const best = candidates[0];',
    '  best.button.click();',
    '  return JSON.stringify({ ok: true, label: best.label, row: best.row, count: candidates.length });',
    '})()',
  ].join('\n');
}

// 曲名比对：括号里的 (feat. …) / - Remaster 之类不参与比较，否则同一首永远对不上。
function normalizeTrackKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\((?:feat|ft|with)\.?[^)]*\)/g, ' ')
    .replace(/\[(?:feat|ft|with)\.?[^\]]*\]/g, ' ')
    .replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|remaster\s+\d{4}|single version|radio edit|live|acoustic)\b.*$/g, ' ')
    .replace(/[“”"'’‘`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 客户端播的到底是不是我们要的那一首。宁可漏判（重发一次），也不能误判（歌词全错位）。
function trackMatches(song, state) {
  if (!song || !state) return false;
  const want = normalizeTrackKey(song.name || song.title);
  const actual = normalizeTrackKey(state.title);
  if (!want || !actual) return false;
  if (want === actual) return true;
  if (actual.indexOf(want) >= 0 || want.indexOf(actual) >= 0) return true;
  return false;
}

function createSpotifyCdp(options) {
  options = options || {};
  const port = Number(options.port || process.env.MINERADIO_SPOTIFY_CDP_PORT || DEFAULT_PORT);
  const timeout = Number(options.timeoutMs) || REQUEST_TIMEOUT_MS;

  let cachedState = null;
  let cachedAt = 0;
  let lastSuccessAt = 0;
  let lastError = '';
  let lastCommand = '';
  let lastCommandAt = 0;
  let lastPlay = null;

  // 一次连接里跑多步（点搜索框 → 敲字 → 回车 → 点结果），比每步重连省一大截时间。
  // One socket per interaction sequence, so the search flow does not reconnect five times.
  function openSession() {
    return new Promise((resolve, reject) => {
      let socket;
      let seq = 0;
      let settled = false;
      const pendingById = new Map();
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket && socket.close(); } catch (closeErr) { /* 已经关了 */ }
        reject(new Error('SPOTIFY_CDP_TIMEOUT'));
      }, timeout);

      const finishOpen = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try { socket && socket.close(); } catch (closeErr) { /* 已经关了 */ }
          reject(err);
        } else {
          resolve({ send, evaluate, close });
        }
      };

      function send(method, params) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pendingById.set(id, { res, rej });
          socket.send(JSON.stringify({ id, method, params: params || {} }));
        });
      }

      async function evaluate(expression) {
        const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (answer && answer.exceptionDetails) {
          throw new Error('SPOTIFY_CDP_EVAL_FAILED: ' + String(answer.exceptionDetails.text || '').slice(0, 160));
        }
        const result = (answer && answer.result) || {};
        if (typeof result.value !== 'string') throw new Error('SPOTIFY_CDP_BAD_RESULT');
        try { return JSON.parse(result.value); } catch (evalErr) { throw new Error('SPOTIFY_CDP_BAD_JSON'); }
      }

      function close() {
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch (closeErr) { /* 已经关了 */ }
      }

      fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(timeout) })
        .then(response => {
          if (!response.ok) throw new Error('SPOTIFY_CDP_HTTP_' + response.status);
          return response.json();
        })
        .then(targets => {
          const list = Array.isArray(targets) ? targets : [];
          const page = list.find(
            target => target && target.type === 'page' && /xpui\.app\.spotify\.com|spotify\.com/i.test(String(target.url || ''))
          ) || list.find(target => target && target.type === 'page');
          if (!page || !page.webSocketDebuggerUrl) throw new Error('SPOTIFY_CDP_NO_TARGET');
          socket = new WebSocket(page.webSocketDebuggerUrl);
          socket.onopen = () => finishOpen(null);
          socket.onmessage = event => {
            let message;
            try { message = JSON.parse(String(event.data)); } catch (parseErr) { return; }
            const entry = pendingById.get(message.id);
            if (!entry) return;
            pendingById.delete(message.id);
            if (message.error) entry.rej(new Error('SPOTIFY_CDP_ERROR: ' + String(message.error.message || '').slice(0, 160)));
            else entry.res(message.result || {});
          };
          socket.onerror = () => finishOpen(new Error('SPOTIFY_CDP_WS_ERROR'));
          socket.onclose = () => {
            if (!settled) finishOpen(new Error('SPOTIFY_CDP_WS_CLOSED'));
            else pendingById.forEach(entry => entry.rej(new Error('SPOTIFY_CDP_WS_CLOSED')));
            pendingById.clear();
          };
        })
        .catch(err => finishOpen(err));
    });
  }

  async function withSession(task) {
    const session = await openSession();
    try {
      return await task(session);
    } finally {
      session.close();
    }
  }

  function evaluate(expression) {
    return withSession(session => session.evaluate(expression));
  }

  // ---- 注入桥 ------------------------------------------------------------------
  // 桥的方法一律返回 JSON 字符串（CDP evaluate 只回收标量），这里是唯一的调用入口。
  // 每次先试着直接用；报 NO_BRIDGE 说明页面重载过（window 被清空），再注入一次。
  let bridgeMode = 'unknown'; // 'api' | 'dom'
  let lastBridgeInjectAt = 0;

  function bridgeCallExpression(method, argJson) {
    return [
      '(function () {',
      '  if (!window.__MR__) return JSON.stringify({ ok: false, error: "NO_BRIDGE" });',
      '  return window.__MR__.' + method + '(' + (argJson || '') + ');',
      '})()',
    ].join('\n');
  }

  async function callBridge(method, argJson) {
    let answer = await evaluate(bridgeCallExpression(method, argJson));
    if (answer && answer.error === 'NO_BRIDGE') {
      const injected = await evaluate(BRIDGE_SOURCE);
      lastBridgeInjectAt = Date.now();
      if (!injected || injected.ok !== true) {
        throw new Error(String((injected && injected.error) || 'SPOTIFY_CDP_NO_BRIDGE'));
      }
      answer = await evaluate(bridgeCallExpression(method, argJson));
    }
    return answer;
  }

  async function readStateViaApi() {
    const answer = await callBridge('read');
    if (!answer || answer.ok !== true) {
      throw new Error(String((answer && answer.error) || 'SPOTIFY_CDP_BAD_STATE'));
    }
    return answer.state;
  }

  function rememberState(state) {
    cachedState = Object.assign({}, state, { receivedAt: Date.now() });
    cachedAt = Date.now();
    lastSuccessAt = cachedAt;
    lastError = '';
    return cachedState;
  }

  async function readState(force) {
    const now = Date.now();
    if (!force && cachedState && now - cachedAt < STATE_CACHE_MS) {
      return { ok: true, available: true, cached: true, mode: bridgeMode, state: cachedState };
    }
    let failure = null;

    // ① API 级：真值，毫秒级进度。
    try {
      const state = await readStateViaApi();
      bridgeMode = 'api';
      return { ok: true, available: true, cached: false, mode: 'api', state: rememberState(state) };
    } catch (err) {
      failure = err;
    }

    // ② DOM 级：桥注入不了（页面结构变了 / 客户端版本不兼容）时的退路。
    try {
      const state = await evaluate(STATE_EXPRESSION);
      // 页面刚起来（或正在重载）时 DOM 是空的：这不是"读到一首空歌"，是还没准备好。
      // An empty shell is "not ready yet", never a track with no title.
      if (!state || (!state.hasProgress && !String(state.title || '').trim())) {
        throw new Error('SPOTIFY_CDP_BOOTING');
      }
      bridgeMode = 'dom';
      return { ok: true, available: true, cached: false, mode: 'dom', state: rememberState(state) };
    } catch (domErr) {
      failure = domErr;
    }

    lastError = String((failure && failure.message) || failure);
    // 短暂的断连不该让 UI 立刻闪成"未接入"；缓存还能用就继续给旧状态。
    if (cachedState && Date.now() - cachedAt < 10000) {
      return { ok: true, available: true, cached: true, stale: true, error: lastError, state: cachedState };
    }
    return { ok: false, available: false, error: lastError, state: null };
  }

  async function command(name, payload) {
    const data = Object.assign({ name }, payload || {});
    let bridgeError = null;

    // ① API 级：直接调 PlayerAPI，不依赖 DOM 结构、不受界面语言影响。
    try {
      const answer = await callBridge('cmd', [
        JSON.stringify(String(name)),
        JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
      ].join(', '));
      if (answer && answer.ok === true) {
        bridgeMode = 'api';
        lastCommand = name;
        lastCommandAt = Date.now();
        cachedAt = 0;
        return { ok: true, name, mode: 'api' };
      }
      bridgeError = String((answer && answer.error) || 'SPOTIFY_CDP_COMMAND_REJECTED');
    } catch (err) {
      bridgeError = String((err && err.message) || err);
    }

    // ② DOM 级：桥不可用时的退路。
    try {
      const answer = await evaluate(commandExpression(name, data));
      if (!answer || answer.ok !== true) {
        throw new Error(String((answer && answer.error) || bridgeError || 'SPOTIFY_CDP_COMMAND_REJECTED'));
      }
      bridgeMode = 'dom';
      lastCommand = name;
      lastCommandAt = Date.now();
      cachedAt = 0;
      return { ok: true, name, mode: 'dom' };
    } catch (err) {
      lastError = String((err && err.message) || err);
      return { ok: false, name, error: lastError };
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }

  // 点搜索框：坐标点击（trusted），不是 dispatchEvent —— React 的受控输入只认真事件。
  async function clickSearchInput(session) {
    const box = await session.evaluate([
      '(() => {',
      '  const el = document.querySelector("[data-testid=\\"search-input\\"]");',
      '  if (!el) return JSON.stringify({ ok: false });',
      '  const r = el.getBoundingClientRect();',
      '  return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });',
      '})()',
    ].join('\n'));
    if (!box || !box.ok) throw new Error('SPOTIFY_CDP_NO_SEARCH_INPUT');
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 });
  }

  async function pressKey(session, key, code, keyCode, modifiers) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    if (modifiers) base.modifiers = modifiers;
    await session.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base));
    await session.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }

  // 刚拉起的客户端要几秒才渲染出搜索框；这段时间里点播必然失败，先等它。
  // A freshly started client needs a few seconds before the shell has any DOM.
  async function waitForPageReady() {
    const deadline = Date.now() + PLAY_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const answer = await evaluate([
          '(() => JSON.stringify({',
          '  ok: !!document.querySelector("[data-testid=\\"search-input\\"]")',
          '}))()',
        ].join('\n'));
        if (answer && answer.ok) return true;
      } catch (waitErr) { /* 还没起来，继续等 */ }
      await sleep(500);
    }
    return false;
  }

  // "客户端现在放的是不是我要的这一首"。有 URI 就比 URI —— 那是唯一无歧义的判据；
  // 只有 URI 缺失（DOM 模式读不到）时才退回标题比对。
  function trackIsTarget(song, uri, state) {
    if (!state) return false;
    const want = String(uri || '').trim();
    const actual = String(state.uri || '').trim();
    if (want && actual) return want === actual;
    return trackMatches(song, state);
  }

  // ① API 级点播：给出 URI 直接播，不搜索、不点 DOM。
  // 失败时**不改动**任何状态，调用方照旧走换源 —— 绝不假装播上了。
  async function playTrackViaUri(song, uri, started) {
    const title = String(song.title || song.name || '').trim();
    const artist = String(song.artist || '').trim();
    const result = { ok: false, already: false, mode: 'api', uri, title, artist, elapsedMs: 0 };

    try {
      const answer = await callBridge('play', JSON.stringify(uri));
      if (!answer || answer.ok !== true) {
        result.error = String((answer && answer.error) || 'SPOTIFY_CDP_PLAY_REJECTED');
        result.elapsedMs = Date.now() - started;
        lastPlay = Object.assign({ at: started }, result);
        return result;
      }
      // play() 是异步的：必须等客户端真的换过去，不能"发出去了就当成功"。
      const deadline = Date.now() + PLAY_CONFIRM_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(PLAY_POLL_MS);
        const state = await readState(true);
        if (state.available && trackIsTarget(song, uri, state.state)) {
          bridgeMode = 'api';
          result.ok = true;
          result.state = state.state;
          result.elapsedMs = Date.now() - started;
          lastPlay = Object.assign({ at: started }, result);
          lastCommand = 'PlayTrack';
          lastCommandAt = Date.now();
          return result;
        }
      }
      result.error = 'SPOTIFY_CDP_PLAY_UNCONFIRMED';
    } catch (err) {
      result.error = String((err && err.message) || err);
    }

    result.elapsedMs = Date.now() - started;
    lastPlay = Object.assign({ at: started }, result);
    return result;
  }

  // 让本机客户端播放指定曲目。返回 { ok, already, mode, label, state }。
  async function playTrack(payload) {
    const song = payload || {};
    const title = String(song.title || song.name || '').trim();
    const artist = String(song.artist || '').trim();
    const uri = String(song.uri || song.spotifyUri || '').trim();
    const started = Date.now();
    const result = { ok: false, already: false, title, artist, uri, elapsedMs: 0 };

    if (!title && !uri) {
      result.error = 'SPOTIFY_CDP_NO_TITLE';
      lastPlay = Object.assign({ at: started }, result);
      return result;
    }

    if (!(await waitForPageReady())) {
      result.error = 'SPOTIFY_CDP_PAGE_NOT_READY';
      result.elapsedMs = Date.now() - started;
      lastPlay = Object.assign({ at: started }, result);
      return result;
    }

    // 客户端本来就在放这一首，别多此一举去搜索（还会把歌词页顶掉）。
    const current = await readState(true);
    if (current.available && trackIsTarget(song, uri, current.state)) {
      if (current.state && !current.state.isPlaying) await command('Play');
      return Object.assign(result, {
        ok: true,
        already: true,
        mode: current.mode,
        state: current.state,
        elapsedMs: Date.now() - started,
      });
    }

    // 有 URI 就先走精确点播；走不通且手上有曲名时，再退回搜索点击。
    if (uri) {
      const viaApi = await playTrackViaUri(song, uri, started);
      if (viaApi.ok) return viaApi;
      result.apiError = viaApi.error;
      if (!title) return viaApi;
    }

    const query = (title + ' ' + artist).trim();
    try {
      await withSession(async session => {
        await clickSearchInput(session);
        await sleep(220);
        // 清空上一次的搜索词，否则会拼成 "旧的新的"。
        await pressKey(session, 'a', 'KeyA', 65, 2);
        await sleep(80);
        await session.send('Input.insertText', { text: query });
        await sleep(240);
        await pressKey(session, 'Enter', 'Enter', 13);

        const deadline = Date.now() + PLAY_SEARCH_TIMEOUT_MS;
        let picked = null;
        while (Date.now() < deadline && !picked) {
          await sleep(PLAY_POLL_MS);
          const answer = await session.evaluate(pickRowExpression(title, artist));
          if (answer && answer.ok) picked = answer;
        }
        if (!picked) {
          result.error = 'SPOTIFY_CDP_SEARCH_NO_RESULT';
          result.query = query;
          return;
        }
        result.label = picked.label;
        result.candidates = picked.count;

        const confirmBy = Date.now() + PLAY_CONFIRM_TIMEOUT_MS;
        while (Date.now() < confirmBy) {
          await sleep(PLAY_POLL_MS);
          const state = await session.evaluate(STATE_EXPRESSION);
          if (trackMatches(song, state)) {
            result.ok = true;
            result.mode = 'dom';
            result.state = rememberState(state);
            return;
          }
        }
        result.error = 'SPOTIFY_CDP_PLAY_UNCONFIRMED';
      });
    } catch (err) {
      result.error = String((err && err.message) || err);
      lastError = result.error;
    }

    result.elapsedMs = Date.now() - started;
    if (!result.ok) {
      result.state = null;
      lastPlay = Object.assign({ at: started }, result);
      return result;
    }
    lastPlay = Object.assign({ at: started }, result);
    lastCommand = 'PlayTrack';
    lastCommandAt = Date.now();
    return result;
  }

  function status() {
    return {
      ok: true,
      port,
      // 'api' = 注入桥可用（精确点播 / 真进度）；'dom' = 退回到点击界面；'unknown' = 还没连上过。
      mode: bridgeMode,
      available: !!(lastSuccessAt && Date.now() - lastSuccessAt < 15000),
      lastSuccessAt,
      lastError,
      lastCommand,
      lastCommandAt,
      lastBridgeInjectAt,
      hasState: !!cachedState,
      state: cachedState,
      lastPlay,
    };
  }

  return { readState, command, playTrack, status, port, readStateViaApi };
}

module.exports = {
  createSpotifyCdp,
  BRIDGE_SOURCE,
  STATE_EXPRESSION,
  commandExpression,
  pickRowExpression,
  normalizeTrackKey,
  trackMatches,
  DEFAULT_PORT,
};
