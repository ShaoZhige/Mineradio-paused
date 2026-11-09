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
    await evaluate("var text='晚风穿过城市灯火慢慢亮起'; var words=[]; var chunks=['晚风','穿过','城市','灯火','慢慢','亮起']; var c0=0; for(var i=0;i<chunks.length;i++){var w=chunks[i]; words.push({text:w,t:0.6+i*0.5,d:0.5,c0:c0,c1:c0+w.length}); c0+=w.length;} lyricsLines=[{t:0.6,duration:3.4,text:text,words:words,charCount:text.length,source:'yrc-word',translation:'晚风穿过城市，灯火慢慢亮起'}]; window.__foliaNow=1.8; getAdjustedLyricPlaybackTime=function(){return window.__foliaNow;}; document.body.classList.remove('empty-home-active','splash-active'); fx.lyricStyle='classic'; if(typeof updateLyricStyleControls==='function')updateLyricStyleControls(); 'ok'");
    for (let i = 0; i < 6; i += 1) {
      await evaluate("window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'tick'");
      await sleep(200);
    }
    await sleep(350);
    const state = await evaluate("(function(){var root=document.getElementById('folia-classic-lyrics');var chars=root?root.querySelectorAll('.folia-classic-word'):[];return {shown:!!(root&&root.classList.contains('show')),words:chars.length,active:root?root.querySelectorAll('.folia-classic-word.is-active').length:0,passed:root?root.querySelectorAll('.folia-classic-word.is-passed').length:0,waiting:root?root.querySelectorAll('.folia-classic-word.is-waiting').length:0};})()");
    console.log('state:', JSON.stringify(state));
    assert(state.shown, 'overlay is not shown');
    assert(state.words === 6, `expected 6 words, got ${state.words}`);
    assert(state.active >= 1, 'no active word');
    assert(state.passed >= 1, 'no passed word');
    assert(state.active + state.passed + state.waiting === 6, 'word state counts do not add up');
    const box = await evaluate("(function(){var root=document.getElementById('folia-classic-lyrics');var line=root&&root.querySelector('.folia-classic-line');function r(el){if(!el)return null;var b=el.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),fs:getComputedStyle(el).fontSize};}return {root:r(root),line:r(line)};})()");
    console.log('box:', JSON.stringify(box));
    assert(box.root && box.root.w > 600 && box.root.h > 120, 'overlay is too small');
    await evaluate("window.__foliaNow=2.7; window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'ok'");
    await sleep(600);
    const state2 = await evaluate("(function(){var root=document.getElementById('folia-classic-lyrics');return {active:root?root.querySelectorAll('.folia-classic-word.is-active').length:0,passed:root?root.querySelectorAll('.folia-classic-word.is-passed').length:0};})()");
    console.log('state2:', JSON.stringify(state2));
    assert(state2.active >= 1, 'no active word at 2.7s');
    assert(state2.passed >= 2, 'passed words did not advance');
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
    await evaluate("fx.lyricStyle='scatter'; if(typeof updateLyricStyleControls==='function')updateLyricStyleControls(); window.__mineradioFoliaTick && window.__mineradioFoliaTick(); 'scatter'");
    await sleep(500);
    const scatter = await evaluate("(function(){var root=document.getElementById('folia-classic-lyrics');var line=root&&root.querySelector('.folia-classic-line');var words=line?Array.prototype.slice.call(line.querySelectorAll('.folia-classic-word')):[];var boxes=words.map(function(w){var b=w.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,fs:parseFloat(getComputedStyle(w).fontSize),left:w.style.getPropertyValue('--sx'),top:w.style.getPropertyValue('--sy')};});return {isScatter:!!(root&&root.classList.contains('is-scatter')),lineScatter:!!(line&&line.classList.contains('is-scatter')),count:words.length,active:line?line.querySelectorAll('.is-active').length:0,boxes:boxes};})()");
    console.log('scatter:', JSON.stringify(scatter).slice(0, 500));
    assert(scatter.isScatter && scatter.lineScatter, 'scatter layout class did not apply');
    assert(scatter.count === 6, `scatter expected 6 words, got ${scatter.count}`);
    assert(scatter.active >= 1, 'scatter has no active word');
    const xs = scatter.boxes.map((b) => b.x);
    const ys = scatter.boxes.map((b) => b.y);
    const sizes = scatter.boxes.map((b) => b.fs);
    assert(Math.max(...xs) - Math.min(...xs) > 300, 'scatter words are not spread horizontally');
    assert(Math.max(...ys) - Math.min(...ys) > 150, 'scatter words are not spread vertically');
    assert(Math.max(...sizes) - Math.min(...sizes) > 8, 'scatter word sizes are uniform');
    for (const b of scatter.boxes) {
      assert(b.x + b.w > 0 && b.x < 1920 && b.y + b.h > 0 && b.y < 1080, 'scatter word outside viewport');
    }
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
