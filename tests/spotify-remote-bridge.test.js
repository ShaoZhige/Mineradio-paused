'use strict';

// Spotify 官方客户端的本地 CDP 通道 + 远程播放的"静音时钟"与换源互斥。
// 纯本地：不连 Spotify、不连 9222、不启动 Electron。
// Local CDP bridge, silent clock and the source-fallback exclusion — all offline.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const {
  createSpotifyCdp,
  STATE_EXPRESSION,
  commandExpression,
  pickRowExpression,
  normalizeTrackKey,
  trackMatches,
} = require('../server/spotify-cdp');

(async () => {
  // ── 1. 状态表达式必须是"只读 DOM"，不能偷偷退回 Web API ────────────────────
  for (const id of [
    'now-playing-widget-v2',
    'control-button-playpause',
    'playback-progressbar',
    'volume-bar',
    'playback-position',
  ]) {
    assert.ok(STATE_EXPRESSION.includes(id), 'state expression is missing ' + id);
  }
  assert.ok(!/api\.spotify\.com|\/v1\/me/.test(STATE_EXPRESSION), 'state expression must not touch Web API');
  assert.ok(/aria-valuetext/.test(STATE_EXPRESSION), 'position must prefer the 1s-precision label');

  // ── 2. 指令表达式：参数走 JSON 字面量、滑块用原生 setter + 事件 ──────────────
  const seekExpr = commandExpression('Seek', { name: 'Seek', position: 123456 });
  assert.ok(seekExpr.includes('123456'), 'seek position was not embedded');
  assert.ok(seekExpr.includes('Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set'), 'native setter is required for React inputs');
  assert.ok(/new Event\("input"/.test(seekExpr) && /new Event\("change"/.test(seekExpr), 'input/change events are required');
  assert.ok(commandExpression('NextSong', { name: 'NextSong' }).includes('control-button-skip-forward'));
  assert.ok(commandExpression('Pause', { name: 'Pause' }).includes('control-button-playpause'));
  assert.ok(commandExpression('Drop', { name: 'Drop' }).includes('unsupported command'), 'unknown commands must be refused');
  assert.ok(!commandExpression('Seek', { name: 'Seek", alert(1)//', position: 1 }).includes('alert(1)//";'),
    'command payloads must be JSON-escaped');

  // ── 3. 点播为什么不用 spotify: 协议，以及它到底怎么点 ────────────────────
  const pick = pickRowExpression('修煉愛情', '林俊傑');
  assert.ok(/\[role=\\"row\\"\]/.test(pick), 'track rows must be located inside role=row');
  assert.ok(pick.includes('.click()'), 'the row play button must be clicked');
  assert.ok(!/location\.assign|spotify:/.test(pick), 'never fall back to protocol navigation');
  assert.ok(pick.includes('修煉愛情'), 'the target title must reach the page');
  assert.ok(pickRowExpression('a"b', '').includes('a\\"b'), 'titles must be JSON-escaped');

  // 曲名比对：括号补充说明、Remaster 后缀不该影响判定
  assert.strictEqual(normalizeTrackKey('飛機 (feat. 林俊峰)'), '飛機');
  assert.strictEqual(normalizeTrackKey('Never Gonna Give You Up - 2022 Remaster'), 'never gonna give you up');
  assert.ok(trackMatches({ name: 'Blinding Lights' }, { title: 'Blinding Lights' }));
  assert.ok(trackMatches({ name: '飛機 (feat. 林俊峰)' }, { title: '飛機' }));
  assert.ok(!trackMatches({ name: 'Shape of You' }, { title: 'Blinding Lights' }));

  // ── 4. 用假的 fetch / WebSocket 跑通读取、遥控、点播 ────────────────────
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const sent = [];
  let stateAnswer = JSON.stringify({
    label: '当前播放：修煉愛情/林俊傑',
    title: '修煉愛情',
    artist: '林俊傑',
    playButton: '暂停',
    isPlaying: true,
    positionMs: 65000,
    durationMs: 287000,
    volume: 60,
    hasProgress: true,
  });
  let pickAnswer = JSON.stringify({ ok: true, label: '播放“Blinding Lights”', row: 'Blinding Lights | The Weeknd', count: 2 });
  let searchTitle = '';
  // 注入桥的假实现：armed 之前一律报 NO_REGISTRY，好让 DOM 回退那几条断言照旧成立。
  const apiBox = { armed: false, bridge: false, state: null, played: [] };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      sent.push({ url });
      setTimeout(() => {
        if (this.onopen) this.onopen();
      }, 0);
    }
    send(text) {
      const parsed = JSON.parse(text);
      sent.push({ send: parsed });
      const expression = String((parsed.params && parsed.params.expression) || '');
      let value = null;
      if (parsed.method === 'Input.insertText') {
        searchTitle = String(parsed.params.text || '');
        // 用户敲完搜索词之后，客户端就在下一轮求值里换成了目标曲目。
        if (/Blinding Lights/.test(searchTitle)) {
          stateAnswer = JSON.stringify({
            title: 'Blinding Lights',
            artist: 'The Weeknd',
            playButton: '暂停',
            isPlaying: true,
            positionMs: 1200,
            durationMs: 200040,
            volume: 0,
            hasProgress: true,
          });
        }
      } else if (parsed.method === 'Runtime.evaluate') {
        if (/var PLAYER = Symbol\.for/.test(expression)) {
          if (apiBox.armed) {
            apiBox.bridge = true;
            value = JSON.stringify({ ok: true, mode: 'api' });
          } else {
            value = JSON.stringify({ ok: false, error: 'NO_REGISTRY' });
          }
        } else if (/window\.__MR__/.test(expression)) {
          if (!apiBox.bridge) {
            value = JSON.stringify({ ok: false, error: 'NO_BRIDGE' });
          } else if (/__MR__\.read\(\)/.test(expression)) {
            value = JSON.stringify({ ok: true, state: apiBox.state });
          } else if (/__MR__\.play\(/.test(expression)) {
            const match = /window\.__MR__\.play\((.+?)\);/.exec(expression);
            const target = match ? JSON.parse(match[1]) : '';
            apiBox.played.push(target);
            // 客户端真的换过去了：URI 与曲名同时更新，随后的轮询就能确认。
            apiBox.state = Object.assign({}, apiBox.state, {
              uri: target, title: 'Blinding Lights', artist: 'The Weeknd', positionMs: 0, isPlaying: true,
            });
            value = JSON.stringify({ ok: true, uri: target });
          } else if (/__MR__\.cmd\(/.test(expression)) {
            value = JSON.stringify({ ok: true });
          } else {
            value = JSON.stringify({ ok: false, error: 'unknown bridge call' });
          }
        } else if (expression.includes('now-playing-widget-v2')) value = stateAnswer;
        else if (expression.includes('[role=\\"row\\"]')) value = pickAnswer;
        else if (expression.includes('search-input')) value = JSON.stringify({ ok: true, x: 10, y: 20 });
        else if (/switch \(p\.name\)/.test(expression)) value = JSON.stringify({ ok: true });
      }
      if (value == null) {
        // Input.* 这类命令也要回包，否则调用方会一直等下去。
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: parsed.id, result: {} }) });
        }, 0);
        return;
      }
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: parsed.id, result: { result: { value } } }) });
      }, 0);
    }
    close() { sent.push({ close: true }); }
  }

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{
      type: 'page',
      url: 'https://xpui.app.spotify.com/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/fake',
    }],
  });
  globalThis.WebSocket = FakeWebSocket;

  const bridge = createSpotifyCdp({ timeoutMs: 2000 });
  const first = await bridge.readState(true);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.available, true);
  assert.strictEqual(first.state.title, '修煉愛情');
  assert.strictEqual(first.state.positionMs, 65000);
  assert.strictEqual(first.state.isPlaying, true);
  assert.ok(sent.some(item => item.send && item.send.method === 'Runtime.evaluate'), 'Runtime.evaluate was never sent');

  const cached = await bridge.readState();
  assert.strictEqual(cached.cached, true, 'state should be cached between polls');

  const command = await bridge.command('Pause');
  assert.strictEqual(command.ok, true, 'pause command should succeed');
  assert.ok(sent.some(item => item.send && item.send.params && /case "Pause"/.test(item.send.params.expression)), 'pause expression was not sent');

  // 点播：搜索框点击 → 敲字 → 点结果行 → 用真实状态确认
  sent.length = 0;
  const played = await bridge.playTrack({ title: 'Blinding Lights', artist: 'The Weeknd' });
  assert.strictEqual(played.ok, true, 'playTrack should confirm the new track: ' + played.error);
  assert.strictEqual(played.already, false);
  assert.strictEqual(played.state.title, 'Blinding Lights');
  assert.ok(sent.some(item => item.send && item.send.method === 'Input.dispatchMouseEvent' && item.send.params.type === 'mousePressed'),
    'the search box must be clicked with a trusted mouse event');
  assert.ok(sent.some(item => item.send && item.send.method === 'Input.insertText' && /Blinding Lights/.test(item.send.params.text)),
    'the query must be typed as trusted text input');
  assert.ok(sent.some(item => item.send && item.send.method === 'Input.dispatchKeyEvent' && item.send.params.key === 'Enter'),
    'Enter must be pressed to run the search');
  assert.ok(sent.some(item => item.send && item.send.params && /\[role=\\"row\\"\]/.test(String(item.send.params.expression))),
    'the search results were never queried');
  assert.ok(!sent.some(item => item.send && /location\.assign/.test(String(item.send.params && item.send.params.expression))),
    'protocol navigation must not be used for playback');

  // 同一首已经在放：不重复搜索
  sent.length = 0;
  const again = await bridge.playTrack({ title: 'Blinding Lights', artist: 'The Weeknd' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.already, true);
  assert.ok(!sent.some(item => item.send && item.send.method === 'Input.insertText'), 'an already playing track must not be searched again');

  // 搜不到就明确失败，绝不假装播上了
  stateAnswer = JSON.stringify({
    title: '修煉愛情', artist: '林俊傑', playButton: '暂停', isPlaying: true, positionMs: 0, durationMs: 287000, volume: 0, hasProgress: true,
  });
  pickAnswer = JSON.stringify({ ok: false, reason: 'not-found', rows: 0 });
  const missing = await createSpotifyCdp({ timeoutMs: 2000 }).playTrack({ title: '不存在的歌', artist: '无名' });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error, 'SPOTIFY_CDP_SEARCH_NO_RESULT');
  assert.strictEqual(missing.state, null);

  // ── 4b. 注入桥可用：给 URI 就直接播，一次 DOM 都不点 ─────────────────────
  // 这是新的主路径：play({uri}) 走 PlayerAPI，不搜索、不点界面、不会点错版本。
  apiBox.armed = true;
  apiBox.bridge = false;
  apiBox.played.length = 0;
  apiBox.state = {
    uri: 'spotify:track:AAAA', title: '修煉愛情', artist: '林俊傑',
    durationMs: 287000, positionMs: 12345, isPlaying: true, volume: 55,
    hasProgress: true, source: 'api',
  };
  sent.length = 0;
  const apiCdp = createSpotifyCdp({ timeoutMs: 2000 });
  const apiFirst = await apiCdp.readState(true);
  assert.strictEqual(apiFirst.mode, 'api', 'the injected bridge must be preferred: ' + apiFirst.error);
  assert.strictEqual(apiFirst.state.uri, 'spotify:track:AAAA');
  assert.strictEqual(apiFirst.state.positionMs, 12345, 'api state must keep millisecond precision');
  assert.ok(sent.some(i => i.send && /var PLAYER = Symbol\.for/.test(String(i.send.params && i.send.params.expression))),
    'the bridge script must be injected when __MR__ is missing');

  sent.length = 0;
  const apiPlay = await apiCdp.playTrack({ title: 'Blinding Lights', artist: 'The Weeknd', uri: 'spotify:track:BBBB' });
  assert.strictEqual(apiPlay.ok, true, 'uri play should confirm: ' + apiPlay.error);
  assert.strictEqual(apiPlay.mode, 'api');
  assert.deepStrictEqual(apiBox.played, ['spotify:track:BBBB']);
  assert.ok(!sent.some(i => i.send && i.send.method === 'Input.insertText'),
    'a uri play must never type into the search box');
  assert.ok(!sent.some(i => i.send && i.send.method === 'Input.dispatchMouseEvent'),
    'a uri play must never click the UI');

  // 同一首再点一次：不重发 play
  const apiAgain = await apiCdp.playTrack({ title: 'Blinding Lights', artist: 'The Weeknd', uri: 'spotify:track:BBBB' });
  assert.strictEqual(apiAgain.already, true);
  assert.strictEqual(apiBox.played.length, 1, 'an already playing uri must not be re-played');

  const apiCmd = await apiCdp.command('Seek', { position: 30000 });
  assert.strictEqual(apiCmd.ok, true);
  assert.strictEqual(apiCmd.mode, 'api');
  assert.ok(sent.some(i => i.send && /window\.__MR__\.cmd\(/.test(String(i.send.params && i.send.params.expression))),
    'commands must go through the bridge when it is available');
  assert.strictEqual(apiCdp.status().mode, 'api');

  // 桥不可用时必须退回 DOM 读法，而不是报"没接入"
  apiBox.armed = false;
  apiBox.bridge = false;
  apiBox.state = null;

  // 断连：返回 unavailable，且不能把旧状态冒充成实时状态
  globalThis.fetch = async () => { throw new Error('offline'); };
  const broken = createSpotifyCdp({ timeoutMs: 300 });
  const unavailable = await broken.readState(true);
  assert.strictEqual(unavailable.available, false);
  assert.strictEqual(unavailable.state, null);

  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;

  // ── 5. 换源互斥：三条硬守卫 ─────────────────────────────────────────────
  const fallback = read('public/js/modules/05-playback/11-provider-fallback.js');
  assert.ok(/song\.spotifyRemote/.test(fallback), 'fallback must short-circuit remote tracks');
  const startAudio = read('public/js/modules/05-playback/13-playback-start-audio.js');
  assert.ok(/SpotifyRemote\.playbackData\(song\)/.test(startAudio), 'remote playbackData is not wired');
  assert.ok(/song\.spotifyRemote = true/.test(startAudio), 'remote tracks are not marked');
  assert.ok(/data\.directUrl \? data\.url/.test(startAudio), 'blob clock must bypass the /api/audio proxy');
  assert.ok(/song\.spotifyRemote\) \{[\s\S]{0,220}beat analysis skipped/.test(startAudio), 'silent clock must not be sent to the beat analyser');
  assert.ok(/await window\.SpotifyRemote\.handleTrackStart\(song\)/.test(startAudio),
    'the handover must be awaited, or a failed switch would still be treated as taken over');
  assert.ok(/window\.SpotifyRemote\.forwardVolume\(next\)/.test(read('public/js/modules/05-playback/08-audio-graph-controls.js')),
    'MR volume must reach the client through the component API, not a global function');
  const loader = read('public/js/index-loader.js');
  assert.ok(loader.includes('08-account/pillager-spotify.js'), 'the PillagerSpotify component is not registered in the loader');
  const serverSource = read('server/server.js');
  assert.ok(/\/api\/spotify\/client\/play-track/.test(serverSource), 'the play-track endpoint is missing');
  assert.ok(/spotifyCdp\.playTrack\(/.test(serverSource), 'the endpoint does not call playTrack');

  // ── 5b. 部件化：控制客户端的那一半只有一个顶层声明 ──────────────────────
  // 每个模块都是独立的 classic <script>，顶层声明共享同一个 window，散着写就会互相覆盖。
  // 所以整个控制面被收进 PillagerSpotify()，对外只留 window.SpotifyRemote（播放引擎照旧读它）。
  const componentSource = read('public/js/modules/08-account/pillager-spotify.js');
  const componentTopLevel = (componentSource.replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/^(?:var|let|const|function)\s+[A-Za-z_$][\w$]*/gm) || [])
    .map(line => line.replace(/^(?:var|let|const|function)\s+/, ''));
  assert.deepStrictEqual(componentTopLevel, ['PillagerSpotify'],
    'the control component must expose exactly one top-level declaration: function PillagerSpotify()');
  assert.ok(/window\.SpotifyRemote = PillagerSpotify\(\)/.test(componentSource),
    'the component must publish its API as window.SpotifyRemote = PillagerSpotify()');
  assert.ok(/\n  return \{/.test(componentSource), 'the factory must return its API object');
  assert.ok(/forwardVolume: spotifyRemoteForwardVolume,/.test(componentSource),
    'volume forwarding must be part of the public API');
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/js/modules/08-account/spotify-remote.js')),
    'the old flat module must be gone, not left behind next to the component');

  // ── 6. 静音 WAV 时钟：头合法、长度等于歌曲时长、采样点全是零电平 ──────────
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalSetInterval = globalThis.setInterval;
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  let capturedBlob = null;
  globalThis.window = { addEventListener: () => {} };
  globalThis.document = { hidden: false };
  globalThis.setInterval = () => 1;
  globalThis.fetch = async () => ({ json: async () => ({ ok: false, available: false }) });
  globalThis.URL.createObjectURL = blob => { capturedBlob = blob; return 'blob:mineradio-clock'; };
  globalThis.URL.revokeObjectURL = () => {};
  const remotePath = require.resolve('../public/js/modules/08-account/pillager-spotify.js');
  delete require.cache[remotePath];
  require(remotePath);
  const playbackData = globalThis.window.SpotifyRemote.playbackData({ name: 'x' });
  assert.strictEqual(typeof globalThis.window.SpotifyRemote.forwardVolume, 'function',
    'the component API must expose forwardVolume for the volume slider');
  assert.strictEqual(playbackData.directUrl, true);
  assert.strictEqual(playbackData.remote, true);
  assert.strictEqual(playbackData.url, 'blob:mineradio-clock');
  assert.ok(capturedBlob, 'no WAV blob was created');
  const bytes = Buffer.from(await capturedBlob.arrayBuffer());
  assert.strictEqual(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(bytes.readUInt32LE(24), 8000, 'sample rate');
  assert.strictEqual(bytes.readUInt16LE(34), 8, 'bit depth');
  assert.strictEqual(bytes.readUInt32LE(40), bytes.length - 44, 'data chunk length');
  assert.ok(bytes.subarray(44).every(byte => byte === 128), '8-bit PCM silence must be 0x80, not 0x00');
  assert.strictEqual(bytes.length - 44, 240 * 8000, 'default clock should be 240 seconds');

  // 歌曲数据里的时长优先：切歌瞬间客户端报的还是上一首
  const timed = globalThis.window.SpotifyRemote.playbackData({ name: 'x', duration: 187 });
  assert.strictEqual(timed.durationMs, 187000, 'song duration must win over the stale client duration');

  // 接管是异步的：客户端切不过去时必须返回 false，让上层继续换源
  const takeover = await globalThis.window.SpotifyRemote.handleTrackStart({ provider: 'spotify', name: 'y' });
  assert.strictEqual(takeover, false, 'an unreachable client must not be reported as taken over');

  // ── 7. 接管全流程：客户端在放 A，MR 要放 B ───────────────────────────────
  // 客户端先报 A；点播接口返回 B 之后，时钟必须跟 B 走，并且时长用客户端那一版的。
  globalThis.audio = {
    currentTime: 0,
    duration: 200,
    paused: true,
    playCount: 0,
    play() { this.paused = false; this.playCount += 1; return Promise.resolve(); },
    pause() { this.paused = true; },
    addEventListener() {},
  };
  const stateA = { title: 'A 曲', artist: '甲', isPlaying: true, positionMs: 42000, durationMs: 200000, volume: 40, hasProgress: true };
  const stateB = { title: 'B 曲', artist: '乙', isPlaying: true, positionMs: 3000, durationMs: 205000, volume: 0, hasProgress: true, receivedAt: Date.now() };
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).indexOf('/play-track') >= 0) {
      return { json: async () => ({ ok: true, title: 'B 曲', state: stateB }) };
    }
    return { json: async () => ({ ok: true, available: true, state: stateA }) };
  };
  const remote = globalThis.window.SpotifyRemote;
  await remote.poll();
  assert.strictEqual(remote.available(), true, 'the channel should be marked available after a good poll');
  assert.strictEqual(remote.isActive(), false, 'polling alone must not take over playback');

  const songB = { provider: 'spotify', name: 'B 曲', artist: '乙', duration: 187 };
  const tookOver = await remote.handleTrackStart(songB);
  assert.strictEqual(tookOver, true, 'a confirmed switch must be taken over');
  assert.ok(calls.some(url => /play-track/.test(url) && /title=B%20%E6%9B%B2|title=B/.test(url)), 'the switch request was not sent');
  assert.strictEqual(remote.state().title, 'B 曲');
  assert.strictEqual(remote.playbackData(songB).durationMs, 205000,
    'a freshly confirmed client duration must win over stale song metadata');

  // 切歌后立即对表（不再有 1.5s 抑制窗，那会让歌词晚一拍）：时钟必须马上跟到客户端位置。
  remote.syncToAudio();
  assert.strictEqual(Math.round(globalThis.audio.currentTime), 3, 'the clock must follow the client position immediately');
  assert.strictEqual(globalThis.audio.paused, false, 'the silent clock must run while the client plays');

  remote.deactivate();
  assert.strictEqual(remote.isActive(), false);
  delete globalThis.audio;

  // ── 8. 时间轴校准：只认"MR 前端 + Spotify 源 + 客户端接管中" ────────────────
  // 这条边界是用户要求的硬约束：源不是 Spotify 时校准必须整段不触发，
  // 否则会拿别的平台的进度去改这个时钟，歌词与动画一起偏，而且不会报错。
  const calAudio = {
    currentTime: 10,
    duration: 300,
    paused: false,
    addEventListener() {},
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
  globalThis.audio = calAudio;
  // 生产里 songProviderKey 由 07-search.js 提供；沙箱里按同样语义补一个。
  globalThis.songProviderKey = song => String((song && song.provider) || '');
  let forceReads = 0;
  let clientState = {
    uri: 'spotify:track:AAAA',
    title: 'B 曲',
    artist: '乙',
    isPlaying: true,
    positionMs: 10000,
    durationMs: 205000,
    hasProgress: true,
  };
  globalThis.fetch = async url => {
    if (String(url).indexOf('/api/spotify/client/state') >= 0) {
      forceReads += 1;
      return { json: async () => ({ ok: true, available: true, state: Object.assign({}, clientState) }) };
    }
    return { json: async () => ({ ok: false }) };
  };

  globalThis.playQueue = [{ provider: 'spotify', name: 'B 曲', artist: '乙', spotifyUri: 'spotify:track:AAAA', duration: 205 }];
  globalThis.currentIdx = 0;
  await remote.poll();
  const calSong = globalThis.playQueue[0];
  const calTaken = await remote.handleTrackStart(calSong);
  assert.strictEqual(calTaken, true, 'the client already plays this track, so the takeover must succeed');
  assert.strictEqual(remote.calibration().running, true, 'calibration must start once the client owns the track');
  assert.strictEqual(remote.calibration().blocker, '', 'nothing should block calibration for a live Spotify track');

  // 对齐时不动物钟
  const aligned = await remote.calibrate('test');
  assert.strictEqual(aligned.corrected, false, 'a 0ms drift must not snap the clock');
  assert.strictEqual(Math.round(calAudio.currentTime), 10);

  // 漂移超过阈值才拉回
  calAudio.currentTime = 3;
  const corrected = await remote.calibrate('test');
  assert.strictEqual(corrected.corrected, true, 'a 7s drift must be corrected');
  assert.strictEqual(Math.round(calAudio.currentTime), 10, 'the clock must snap to the client position');
  assert.strictEqual(remote.calibration().stats.corrections, 1);
  assert.ok(forceReads >= 3, 'calibration must read a fresh state (?force=1) rather than the cached mirror');

  // 源换成别的平台：校准必须跳过，且一次都不许碰时钟
  globalThis.playQueue[0] = { provider: 'qq', name: 'B 曲', artist: '乙' };
  calAudio.currentTime = 3;
  const sourceChanged = await remote.calibrate('test');
  assert.strictEqual(sourceChanged.skipped, 'source-changed', 'a non-Spotify source must disable calibration');
  assert.strictEqual(Math.round(calAudio.currentTime), 3, 'a skipped calibration must not touch the clock');

  // 换回 Spotify，但客户端已经自己切到另一首：同样不许校准
  globalThis.playQueue[0] = calSong;
  clientState = Object.assign({}, clientState, { uri: 'spotify:track:CCCC', title: '别的歌' });
  await remote.poll();
  assert.strictEqual(remote.calibration().watch.uri, 'spotify:track:CCCC', 'the watcher must follow the client state');
  const trackChanged = await remote.calibrate('test');
  assert.strictEqual(trackChanged.skipped, 'track-changed', 'calibration must stop when the client moved to another track');

  // 客户端停了：观察器要记下来（提示走 showToast，沙箱里没有就静默跳过）
  clientState = Object.assign({}, clientState, { uri: 'spotify:track:AAAA', title: 'B 曲', isPlaying: false });
  await remote.poll();
  assert.strictEqual(remote.calibration().watch.playing, false, 'a client stop must be observed');

  // 两个开关：默认都开，写进去能读回来
  assert.deepStrictEqual(remote.prefs(), { launch: true, switchSource: true });
  remote.setPref('switchSource', false);
  assert.strictEqual(remote.allowSourceFallback(), false, '"SP 换源其他" off must block the fallback');
  remote.setPref('switchSource', true);
  assert.strictEqual(remote.allowSourceFallback(), true);
  remote.setPref('launch', false);
  assert.strictEqual(remote.getPref('launch'), false, 'the launch preference must persist');

  remote.deactivate();
  assert.strictEqual(remote.calibration().running, false, 'deactivation must stop the calibration timer');
  delete globalThis.audio;
  delete globalThis.playQueue;
  delete globalThis.currentIdx;
  delete globalThis.songProviderKey;

  // ── 9. 拖进度条只发 Seek，绝不把客户端的歌暂停 ─────────────────────────────
  // 播放引擎在 progress-bar 的 pointerdown 里会静音并 pause 本地那段静音 WAV（不这样的话
  // 拖动期间会从旧位置出声），松手再 play() 回来。这两个事件都不是用户按了暂停/播放，
  // 转发给客户端的结果就是"拉到一半歌停了"，而且拖多久停多久。
  // progressDragState.active 正好框住这段时间，PillagerSpotify 必须整段忽略。
  const dragAudio = {
    currentTime: 4,
    duration: 205,
    paused: false,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    fire(type) { (this.listeners[type] || []).slice().forEach(fn => fn({ type: type })); },
  };
  globalThis.audio = dragAudio;
  globalThis.progressDragState = { active: false };
  const commandLog = [];
  let dragState = {
    uri: 'spotify:track:DDDD',
    title: 'C 曲',
    artist: '丙',
    isPlaying: true,
    positionMs: 4000,
    durationMs: 205000,
    hasProgress: true,
  };
  globalThis.playQueue = [{ provider: 'spotify', name: 'C 曲', artist: '丙', spotifyUri: 'spotify:track:DDDD', duration: 205 }];
  globalThis.currentIdx = 0;
  globalThis.fetch = async url => {
    const href = String(url);
    if (href.indexOf('/api/spotify/client/command') >= 0) {
      commandLog.push(new URL(href, 'http://127.0.0.1').searchParams.get('name'));
      return { json: async () => ({ ok: true }) };
    }
    if (href.indexOf('/play-track') >= 0) {
      return { json: async () => ({ ok: true, title: 'C 曲', state: Object.assign({}, dragState) }) };
    }
    return { json: async () => ({ ok: true, available: true, state: Object.assign({}, dragState) }) };
  };
  await remote.poll();
  const dragTaken = await remote.handleTrackStart(globalThis.playQueue[0]);
  assert.strictEqual(dragTaken, true, 'the drag test needs an active remote takeover');
  // 接管后会开一段抑制窗（那段时间本来也不该转发）；等它过去，否则正面对照会被吞掉。
  await new Promise(resolve => setTimeout(resolve, 2300));
  remote.syncToAudio(); // 装好 play / pause / seeked 三个钩子
  commandLog.length = 0;

  globalThis.progressDragState.active = true;
  dragAudio.fire('pause');
  dragAudio.fire('play');
  assert.deepStrictEqual(commandLog, [], 'the drag hold must not pause or resume the client');

  globalThis.progressDragState.active = false;
  dragAudio.fire('pause');
  assert.deepStrictEqual(commandLog, ['Pause'], 'a real pause must still reach the client');
  commandLog.length = 0;
  dragAudio.fire('play');
  assert.deepStrictEqual(commandLog, ['Play'], 'a real play must still reach the client');

  // 松手才是用户真正的意图：一次 Seek，位置就是我们拉到的地方。
  commandLog.length = 0;
  dragAudio.currentTime = 120;
  dragAudio.fire('seeked');
  assert.deepStrictEqual(commandLog, ['Seek'], 'releasing the drag must forward exactly one Seek');

  remote.deactivate();
  delete globalThis.audio;
  delete globalThis.progressDragState;
  delete globalThis.playQueue;
  delete globalThis.currentIdx;

  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.setInterval = originalSetInterval;
  globalThis.URL.createObjectURL = originalCreate;
  globalThis.URL.revokeObjectURL = originalRevoke;
  globalThis.fetch = originalFetch;

  console.log('spotify remote bridge: all assertions passed');
})().catch(err => {
  console.error('spotify remote bridge test failed:', err && err.stack);
  process.exit(1);
});
