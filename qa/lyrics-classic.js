'use strict';

// 流光歌词 CDP 冒烟：启动隐藏 Electron，注入一行六词歌词，验证渲染/逐词状态/动效/颜色/辉光开关。
// 与 ztest 里的手工脚本不同，这里以断言为准，失败退出码非 0，可直接进 CI。

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(__dirname, '.tmp');
const QA = path.join(WORK, 'userdata');
const PORT = Number(process.env.MINERADIO_QA_PORT || 9432);
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
    for (let i = 0; i < 120; i += 1) {
      if (await evaluate("typeof setLyricStyle === 'function' && typeof lyricsLines !== 'undefined'")) break;
      await sleep(250);
    }
    await evaluate("if (typeof dismissSplash === 'function') dismissSplash({ instant: true }); 'ok'");
    await sleep(1200);
    await evaluate("var st=document.createElement('style'); st.id='folia-qa-hide-ui'; st.textContent='#empty-home,#search-area,#top-actions,#playlist-panel,#bottom-bar,.bottom-bar,#player-bar,#top-bar,#home-dashboard,#home-shell,#home-view{display:none!important}'; document.head.appendChild(st); 'ui hidden'");
    await call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    // 1.2s leaves the second word active. At 1.8s the middle word is active and
    // sits on the line centre, so the correct camera offset is ~0px and the
    // "camera follows the active word" assertion cannot test anything.
    await evaluate("var text='晚风穿过城市灯火慢慢亮起'; var words=[]; var chunks=['晚风','穿过','城市','灯火','慢慢','亮起']; var c0=0; for(var i=0;i<chunks.length;i++){var w=chunks[i]; words.push({text:w,t:0.6+i*0.5,d:0.5,c0:c0,c1:c0+w.length}); c0+=w.length;} lyricsLines=[{t:0.6,duration:3.4,text:text,words:words,charCount:text.length,source:'yrc-word',translation:'晚风穿过城市，灯火慢慢亮起'}]; window.__foliaNow=1.2; getAdjustedLyricPlaybackTime=function(){return window.__foliaNow;}; document.body.classList.remove('empty-home-active','splash-active'); fx.lyricStyle='classic'; if(typeof updateLyricStyleControls==='function')updateLyricStyleControls(); 'ok'");
    for (let i = 0; i < 6; i += 1) {
      await evaluate("window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'tick'");
      await sleep(200);
    }
    await sleep(350);
    await evaluate("window.cjkWordSegmenter && cjkWordSegmenter.ensureLoaded(); 'started'");
    for (let i = 0; i < 50; i++) {
      if (await evaluate('!!(window.cjkWordSegmenter && cjkWordSegmenter.isReady())')) break;
      await sleep(100);
    }
    const dictState = await evaluate("(function(){var s=window.cjkWordSegmenter;return {ready:!!(s&&s.isReady()), words:s?s.segment('愿与愁'):[], failed:s?!!s.hasFailed():true, vis:document.visibilityState};})()");
    console.log('dictState:', JSON.stringify(dictState));
    assert(dictState.ready, 'jieba dictionary did not load in the app runtime');
    assert(dictState.words.length === 1 && dictState.words[0] === '愿与愁', 'known single-character title was not merged: ' + JSON.stringify(dictState.words));
    // The dictionary-ready rebuild retires the previous line into a 280ms ghost.
    await sleep(400);
    const state = await evaluate("(function(){var root=document.getElementById('folia-classic-lyrics');var chars=root?root.querySelectorAll('.folia-classic-word'):[];return {shown:!!(root&&root.classList.contains('show')),words:chars.length,active:root?root.querySelectorAll('.folia-classic-word.is-active').length:0,passed:root?root.querySelectorAll('.folia-classic-word.is-passed').length:0,waiting:root?root.querySelectorAll('.folia-classic-word.is-waiting').length:0};})()");
    console.log('state:', JSON.stringify(state));
    assert(state.shown, 'overlay is not shown');
    assert(state.words === 6, `expected 6 words, got ${state.words}`);
    assert(state.active >= 1, 'no active word');
    assert(state.passed >= 1, 'no passed word');
    assert(state.active + state.passed + state.waiting === 6, 'word state counts do not add up');
    const pose = await evaluate("(function(){var root=document.getElementById('folia-classic-lyrics');var line=root&&root.querySelector('.folia-classic-line');var cs=line?getComputedStyle(line):null;var act=line&&line.querySelector('.folia-classic-word.is-active');var all=line?Array.prototype.slice.call(line.querySelectorAll('.folia-word-ring')):[];var hosts=line?line.querySelectorAll('.folia-word-rings'):[];var layer=hosts[0];var host=layer&&layer.parentNode; return {inline:line?line.style.transform:'',computed:cs?cs.transform:'none',order:line?Array.prototype.map.call(line.querySelectorAll('.folia-classic-word'),function(w){return w.dataset.text||w.textContent;}).join(''):'',camera:line?line.style.translate:'',ringCount:all.length,hostCount:hosts.length,activeRings:act?act.querySelectorAll('.folia-word-ring').length:0,hostActive:!!(host&&host.classList.contains('is-active')),hostDisplay:layer?getComputedStyle(layer).display:'',hostIndex:host?Array.prototype.indexOf.call(line.querySelectorAll('.folia-classic-word'),host):-1,ringWidths:all.map(function(r){return parseFloat(getComputedStyle(r).width);}),ringLefts:all.map(function(r){return parseFloat(getComputedStyle(r).left);}),wordDur:act?getComputedStyle(act).animationDuration:'',wordDelay:act?getComputedStyle(act).animationDelay:'',lineDur:line?line.style.animationDuration:''};})()");
    console.log('pose:', JSON.stringify(pose));
    assert(pose.inline && pose.inline.indexOf('rotate(') >= 0, 'line has no random rotation');
    assert(pose.computed.indexOf('matrix(') === 0, 'line pose must stay 2D (no perspective)');
    assert(pose.order === '晚风穿过城市灯火慢慢亮起', 'word order was reordered');
    assert(Math.abs(parseFloat(pose.camera || '0')) > 0.2, 'camera did not follow the active word');
    assert(pose.ringCount >= 1 && pose.ringCount <= 2, 'a line should have one or two halo rings, got ' + pose.ringCount);
    assert(pose.hostCount === 1, 'halo rings should live on exactly one host word, got ' + pose.hostCount);
    if (pose.ringCount > 1) {
      assert(pose.ringWidths[1] > pose.ringWidths[0], 'halo rings should grow from left to right');
      assert(pose.ringLefts[0] < pose.ringLefts[1], 'halo rings should travel left to right');
    }
    assert(pose.activeRings === 0 || pose.activeRings === pose.ringCount, 'only the active host word may show halos');
    assert(pose.hostDisplay === (pose.hostActive ? 'block' : 'none'), 'halo layer should only be visible on its active host');
    if (pose.hostIndex >= 0) {
      const hostTime = 0.75 + pose.hostIndex * 0.5;
      await evaluate("window.__foliaNow=" + hostTime + "; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'host'");
      await sleep(60);
      const hostState = await evaluate("(function(){var line=document.querySelector('#folia-classic-lyrics .folia-classic-line');var layer=line&&line.querySelector('.folia-word-rings');return {active:!!(layer&&layer.parentNode.classList.contains('is-active')),display:layer?getComputedStyle(layer).display:'',rings:layer?layer.querySelectorAll('.folia-word-ring').length:0};})()");
      console.log('ring-host:', JSON.stringify(hostState));
      assert(hostState.active, 'ring host word did not become active');
      assert(hostState.display === 'block', 'halo layer did not show on its active host');
      assert(hostState.rings === pose.ringCount, 'host ring count changed');
      await evaluate("window.__foliaNow=1.2; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'restore'");
    }
    assert(parseFloat(pose.wordDur) <= 0.2, 'word entrance is too slow: ' + pose.wordDur);
    assert(parseFloat(pose.wordDelay) <= 0.1, 'first word entrance is delayed: ' + pose.wordDelay);
    assert(parseFloat(pose.lineDur) <= 0.2, 'line entrance is too slow: ' + pose.lineDur);
    await evaluate("fx.lyricStyle='default'; if(typeof updateLyricStyleControls==='function')updateLyricStyleControls(); window.__mineradioFoliaTick && window.__mineradioFoliaTick(); fx.lyricStyle='classic'; if(typeof updateLyricStyleControls==='function')updateLyricStyleControls(); window.__foliaNow=0.6; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'restart'");
    await sleep(90);
    const latency = await evaluate("(function(){var a=document.querySelector('#folia-classic-lyrics .folia-classic-word.is-active');return a?getComputedStyle(a).opacity:'0';})()");
    console.log('latency:', latency);
    assert(parseFloat(latency) > 0.8, 'first active word is not visible quickly: ' + latency);
    await evaluate("window.__foliaNow=1.8; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'resume'");
    await sleep(80);
    await evaluate("fx.lyricMotionStyle='glitch'; fx.lyricOffsetX=0.9; fx.lyricOffsetY=-0.4; fx.lyricTiltY=14; fx.lyricScale=0.92; fx.lyricLetterSpacing=1.5; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'motion'");
    await sleep(450);
    const motion = await evaluate("(function(){var r=document.getElementById('folia-classic-lyrics');var l=r&&r.querySelector('.folia-classic-line');return {motion:r&&r.dataset.motion,transform:r&&r.style.transform,spacing:l&&getComputedStyle(l).letterSpacing};})()");
    console.log('motion:', JSON.stringify(motion));
    assert(motion.motion === 'glitch', 'motion style did not apply');
    assert(/scale|translate|rotate/.test(motion.transform || ''), 'motion transform missing');
    await evaluate("fx.lyricMotionStyle='float'; fx.lyricOffsetX=0; fx.lyricOffsetY=0; fx.lyricTiltY=0; fx.lyricScale=1; fx.lyricLetterSpacing=0; setLyricColorCustom('#ff7a59', true); window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'reset'");
    await sleep(500);
    const color = await evaluate("(function(){var b=document.querySelector('.folia-classic-body');return b?getComputedStyle(b).color:null;})()");
    console.log('color:', color);
    assert(color && color !== 'rgb(255, 255, 255)', 'custom color did not apply');
    const glow = await evaluate("(async function(){function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}function read(){var root=document.getElementById('folia-classic-lyrics');var body=root&&root.querySelector('.folia-classic-word.is-active .folia-classic-body');return {level:root?root.style.getPropertyValue('--folia-glow-level'):null,rgb:root?root.style.getPropertyValue('--folia-glow-rgb'):null,shadow:body?getComputedStyle(body).textShadow:null};}fx.lyricGlow=false;window.__mineradioFoliaTick&&window.__mineradioFoliaTick();await wait(500);var off=read();fx.lyricGlow=true;fx.lyricGlowStrength=0.85;fx.lyricGlowLinked=true;window.__mineradioFoliaTick&&window.__mineradioFoliaTick();await wait(500);var full=read();fx.lyricGlowLinked=false;fx.lyricGlowColor='#ff0000';window.__mineradioFoliaTick&&window.__mineradioFoliaTick();await wait(500);var custom=read();fx.lyricGlowStrength=0.28;fx.lyricGlowLinked=true;window.__mineradioFoliaTick&&window.__mineradioFoliaTick();await wait(500);return {off:off,full:full,custom:custom};})()");
    console.log('glow:', JSON.stringify(glow));
    assert(Number(glow.off.level) === 0, 'glow off level is not 0');
    assert(Number(glow.full.level) > 1, 'glow strength did not scale up');
    assert(/255, 0, 0/.test(glow.custom.rgb || ''), 'custom glow color not applied');

    // Seam test: retire a line while its camera is off-centre and verify the
    // outgoing node keeps its frozen camera/pose instead of snapping, while the
    // incoming node inherits the previous pose. This is the regression that
    // produced the sideways jump and the double-image stutter at every switch.
    await evaluate("lyricsLines=[{t:0.6,duration:2.0,text:text,words:words,charCount:text.length,source:'yrc-word'},{t:2.8,duration:2.0,text:'第二行测试文字',words:[{text:'第二',t:2.8,d:0.5,c0:0,c1:2},{text:'行测',t:3.3,d:0.5,c0:2,c1:4},{text:'试文',t:3.8,d:0.5,c0:4,c1:6},{text:'字',t:4.3,d:0.5,c0:6,c1:7}],charCount:7,source:'yrc-word'}]; window.__foliaNow=1.2; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'two-lines'");
    // 入场动画会临时覆盖 inline translate（0.18s），必须等它跑完再读 computed，
    // 否则 pre 采到的是动画中间值，和切行时冻结的 inline 值对不上，断言会偶发失败。
    await sleep(280);
    const pre = await evaluate("(function(){var l=document.querySelector('#folia-classic-lyrics .folia-classic-line.is-in');var cs=l?getComputedStyle(l):null;return {cam:cs?(parseFloat(cs.translate)||0):0,rotate:cs?cs.rotate:'',left:l?l.offsetLeft:-1,top:l?l.offsetTop:-1};})()");
    await evaluate("window.__foliaNow=3.2; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'switch'");
    await sleep(150);
    const seam = await evaluate("(function(){var root=document.getElementById('folia-classic-lyrics');var out=root&&root.querySelector('.folia-classic-line.is-out');var inn=root&&root.querySelector('.folia-classic-line.is-in');var ocs=out?getComputedStyle(out):null;return {outCam:out?(parseFloat(out.style.translate)||0):0,outTranslate:ocs?ocs.translate:'',outRotate:ocs?ocs.rotate:'',outDur:out?parseFloat(out.style.animationDuration):0,outAnims:out?out.getAnimations().map(function(a){return {name:a.animationName,dur:a.effect&&a.effect.getTiming().duration};}):[],outLeft:out?out.offsetLeft:-1,outTop:out?out.offsetTop:-1,inCount:root?root.querySelectorAll('.folia-classic-line.is-in').length:0,outCount:root?root.querySelectorAll('.folia-classic-line.is-out').length:0,prev:inn?inn.style.getPropertyValue('--pose-prev-transform'):'',inDur:inn?inn.style.animationDuration:''};})()");
    console.log('pre-switch:', JSON.stringify(pre));
    console.log('seam:', JSON.stringify(seam));
    assert(Math.abs(pre.cam) > 0.2, 'pre-switch camera is not off-centre');
    assert(seam.outCount === 1 && seam.inCount === 1, 'expected exactly one outgoing and one incoming line');
    assert(Math.abs(seam.outCam - pre.cam) < 0.2, 'outgoing line lost its camera translate');
    assert(Math.abs((parseFloat(seam.outTranslate) || 0) - pre.cam) < 0.2, 'outgoing line animated its translate away');
    assert(Math.abs((parseFloat(seam.outRotate) || 0) - (parseFloat(pre.rotate) || 0)) < 0.05, 'outgoing line snapped its camera rotate');
    assert(Math.abs(seam.outDur - 0.22) < 0.01, 'outgoing line exit duration is wrong: ' + seam.outDur);
    assert(seam.outAnims.some(function (a) { return a.name === 'folia-classic-line-out' && Math.abs(a.dur - 220) < 1; }), 'outgoing line has no running exit animation (reduced-motion?)');
    assert(Math.abs(seam.outLeft - pre.left) < 1, 'outgoing line jumped horizontally: ' + pre.left + ' -> ' + seam.outLeft);
    assert(Math.abs(seam.outTop - pre.top) < 1, 'outgoing line jumped vertically: ' + pre.top + ' -> ' + seam.outTop);
    assert(!!seam.prev, 'incoming line has no previous-pose handoff');
    assert(parseFloat(seam.inDur) <= 0.2, 'incoming line entrance is too slow: ' + seam.inDur);
    await sleep(220);
    const ghosts = await evaluate("document.querySelectorAll('#folia-classic-lyrics .folia-classic-line.is-out').length");
    assert(ghosts === 0, 'outgoing line was not removed after the fade');

    // 行级（LRC）歌词：下一行在 20 秒后（句后是间奏），逐字点亮必须按演唱时长收束，
    // 不能跟着间隔一路拖到 18 秒——那正是「歌词跟不上嘴」的来源。
    await evaluate("lyricsLines=[{t:0,duration:20,text:'晚风穿过城市灯火慢慢亮起'},{t:20,duration:4,text:'下一句歌词'}]; window.__foliaNow=1.0; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'lrc-gap'");
    await sleep(150);
    const lrcSpan = await evaluate("(function(){var w=window.__mineradioFoliaWords?window.__mineradioFoliaWords():[];return {count:w.length,first:w.length?w[0].start:-1,last:w.length?w[w.length-1].end:-1};})()");
    console.log('lrc-span:', JSON.stringify(lrcSpan));
    assert(lrcSpan.count > 1, 'LRC line did not split into words');
    assert(lrcSpan.first >= 0 && lrcSpan.first < 0.2, 'LRC first word must start at the line start: ' + lrcSpan.first);
    assert(lrcSpan.last > 3.8 && lrcSpan.last < 5.4, 'LRC long-gap line must be clamped to the sung estimate, got ' + lrcSpan.last);

    await evaluate("fx.lyricStyle='default'; if(typeof updateLyricStyleControls==='function')updateLyricStyleControls(); window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'off'");
    await sleep(600);
    const off = await evaluate("(function(){var root=document.getElementById('folia-classic-lyrics');return {shown:!!(root&&root.classList.contains('show'))};})()");
    console.log('off:', JSON.stringify(off));
    assert(off.shown === false, 'overlay did not hide after switching style');
    console.log('QA lyrics-classic: PASS');
  } catch (err) {
    console.error('QA lyrics-classic: FAIL', err && err.stack || err);
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (_) { }
    try { child.kill(); } catch (_) { }
  }
})();
