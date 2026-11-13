'use strict';

// 商籁歌词 CDP 冒烟：启动隐藏 Electron，注入多段歌词，验证覆盖层、
// 四级字号、逐字入场、镜头切换、seek 确定性与样式退出。
// 隐藏窗口会节流 rAF，所以全程用 __mineradioSonnetTick() 同步推帧。

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(__dirname, '.tmp', 'sonnet');
const QA = path.join(WORK, 'userdata');
const PORT = Number(process.env.MINERADIO_QA_PORT || 9433);
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
  try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) { }
  fs.mkdirSync(QA, { recursive: true });
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.MINERADIO_STARTUP_QA_HIDDEN = '1';
  env.MINERADIO_STARTUP_QA_USER_DATA = QA;
  const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
  let ws = null;
  let id = 0;
  const pageErrors = [];
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
        pageErrors.push(d && (d.exception && d.exception.description || d.text));
      }
      const w = pending.get(m.id);
      if (!w) return;
      pending.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error))); else w.resolve(m.result);
    });
    await call('Page.enable');
    await call('Runtime.enable');
    for (let i = 0; i < 120; i += 1) {
      if (await evaluate("typeof setLyricStyle === 'function' && typeof lyricsLines !== 'undefined' && typeof __mineradioSonnetTick === 'function'")) break;
      await sleep(250);
    }
    assert(await evaluate("typeof __mineradioSonnetTick === 'function'"), '商籁模块没有被加载');
    await evaluate("if (typeof dismissSplash === 'function') dismissSplash({ instant: true }); 'ok'");
    await sleep(1000);
    await call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await evaluate(`
      var text='晚风穿过城市灯火慢慢亮起';
      var chunks=['晚风','穿过','城市','灯火','慢慢','亮起'];
      var words=chunks.map(function(w,i){return {text:w,t:0.6+i*0.32,d:0.32};});
      lyricsLines=[
        {t:0.6,duration:3.4,text:text,words:words,source:'yrc-word'},
        {t:4.2,duration:2.0,text:'第二行测试文字',source:'lrc'},
        {t:6.5,duration:2.0,text:'第三行也在这里',source:'lrc'},
        {t:14.0,duration:2.0,text:'副歌要更大声',source:'lrc'},
        {t:16.4,duration:2.0,text:'最后一行收尾',source:'lrc'}
      ];
      window.__sonnetNow=1.2;
      getAdjustedLyricPlaybackTime=function(){return window.__sonnetNow;};
      document.body.classList.remove('empty-home-active','splash-active');
      fx.particleLyrics=true;
      fx.lyricStyle='sonnet';
      if(typeof updateLyricStyleControls==='function')updateLyricStyleControls();
      'ok'`);
    // 切歌静默期 600ms，推几帧让渲染循环越过它。
    for (let i = 0; i < 8; i += 1) {
      await evaluate("window.__mineradioSonnetTick && window.__mineradioSonnetTick(); 'tick'");
      await sleep(120);
    }
    const state = await evaluate(`(function(){
      var root=document.getElementById('folia-sonnet-lyrics');
      var shot=root&&root.querySelector('.fs-shot');
      var words=root?Array.prototype.slice.call(root.querySelectorAll('.fs-word')):[];
      var glyphs=root?Array.prototype.slice.call(root.querySelectorAll('.fs-glyph')):[];
      return {
        shown:!!(root&&root.classList.contains('show')),
        kind:root?root.dataset.kind:'',
        transition:root?root.dataset.transition:'',
        words:words.length,
        hero:root?root.querySelectorAll('.fs-word[data-role="hero"]').length:0,
        semi:root?root.querySelectorAll('.fs-word[data-role="semi-hero"]').length:0,
        support:root?root.querySelectorAll('.fs-word[data-role="support"]').length:0,
        deco:root?root.querySelectorAll('.fs-word[data-role="decoration"]').length:0,
        glyphs:glyphs.length,
        visible:glyphs.filter(function(g){return parseFloat(g.style.opacity||'0')>0.8;}).length,
        corners:root?root.querySelectorAll('.fs-corner').length:0,
        camera:root?root.querySelector('.fs-camera').style.transform:'',
        shots:window.__mineradioSonnetState?window.__mineradioSonnetState().shots:0,
        shotIndex:window.__mineradioSonnetState?window.__mineradioSonnetState().shotIndex:-1,
        focus:window.__mineradioSonnetState?window.__mineradioSonnetState().focus:null,
        tracking:window.__mineradioSonnetState?window.__mineradioSonnetState().tracking:0,
        error:window.__sonnetLastError||''
      };})()`);
    console.log('state:', JSON.stringify(state));
    assert(!state.error, '渲染循环抛错: ' + state.error);
    assert(state.shown, '商籁覆盖层没有显示');
    assert(state.shots >= 2, '时间轴没有切出多个镜头');
    assert(state.kind && state.transition, '镜头或转场种类缺失');
    assert(state.hero === 1 && state.deco === 1, 'hero / 空心装饰字数量不对');
    assert(state.support >= 1, '缺少 support 级文字');
    assert(state.words >= 5 && state.glyphs >= state.words, '逐字节点没建出来');
    assert(state.visible >= 1, '逐字入场没有生效（没有可见 glyph）');
    assert(state.corners === 4, '四角印刷角标缺失');
    assert(state.camera.includes('scale('), '相机推拉没有写入');
    assert(state.tracking > 0 && state.tracking <= state.glyphs, '逐字焦点时间表不完整');

    // 版面不重叠：真实渲染层里任意两个词（含相机变换、含静止旋转）的包围盒都不许相交。
    // 这是「歌词叠到一起」的回归门槛 —— 单元测试量的是估算盒，这里量的是浏览器实际布局。
    const overlap = await evaluate(`(function(){
      var root=document.getElementById('folia-sonnet-lyrics');
      function rects(sel){
        return Array.prototype.slice.call(root.querySelectorAll(sel)).map(function(w){
          var r=w.getBoundingClientRect();
          return {t:(w.textContent||'').slice(0,6),x:r.left,y:r.top,w:r.width,h:r.height};
        });
      }
      function worstOf(list, other){
        var worst=0,pair=null;
        for(var i=0;i<list.length;i++){
          for(var j=(other?0:i+1);j<(other?other.length:list.length);j+=1){
            var a=list[i],b=other?other[j]:list[j];
            if(a===b)continue;
            var ox=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
            var oy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
            var m=Math.min(ox,oy);
            if(m>worst){worst=m;pair=[a.t,b.t];}
          }
        }
        return {count:list.length,worst:worst,pair:pair};
      }
      var bodyRects=rects('.fs-word[data-role]:not([data-role="decoration"]) .fs-glyph');
      var decoRects=rects('.fs-word[data-role="decoration"]');
      return {body:worstOf(bodyRects), deco:worstOf(decoRects), cross:worstOf(decoRects, bodyRects)};})()`);
    console.log('overlap:', JSON.stringify(overlap));
    assert(overlap.body.count >= 3, '重叠检测需要至少 3 个词');
    assert(overlap.body.worst <= 2, '真实渲染层歌词互相重叠: '
      + JSON.stringify(overlap.body.pair) + ' 重叠 ' + overlap.body.worst.toFixed(1) + 'px');
    assert(overlap.cross.worst <= 2, '空心装饰字压住了歌词: '
      + JSON.stringify(overlap.cross.pair) + ' 重叠 ' + overlap.cross.worst.toFixed(1) + 'px');

    // 视角跟随：同一镜头内，不同时刻的焦点与 transform 必须真的移动；回到同一时刻必须一致。
    const follow = await evaluate(`(function(){
      function at(t){
        window.__sonnetNow=t; window.__mineradioSonnetTick();
        var root=document.getElementById('folia-sonnet-lyrics');
        var st=window.__mineradioSonnetState();
        return {camera:root.querySelector('.fs-camera').style.transform,focus:st.focus,index:st.shotIndex};
      }
      return {a:at(1.0),b:at(2.2),back:at(1.0)};})()`);
    console.log('follow:', JSON.stringify(follow));
    assert(follow.a.index === follow.b.index, '跟随测试必须落在同一镜头内');
    assert(follow.a.focus && follow.b.focus, '渲染层没有生成相机焦点');
    const moved = Math.abs(follow.a.focus.x - follow.b.focus.x) + Math.abs(follow.a.focus.y - follow.b.focus.y);
    assert(moved > 10, '相机焦点没有跟随逐字时间轴移动（位移 ' + moved.toFixed(1) + 'px）');
    assert(follow.a.camera !== follow.b.camera, '相机 transform 没有跟随歌词变化');
    assert(follow.a.camera === follow.back.camera, '回到同一时刻相机姿态不一致');

    // 视角流畅度：同一镜头内以 60fps 连续推进，逐帧位移、方向反转与 jerk 都要受控。
    // 这是「单字断句来回飞 / 视角抖动」在真实渲染层的回归门槛。
    const smooth = await evaluate(`(function(){
      var prev=null,prevV=null,reversals=0,maxStep=0,maxJerk=0,baseIndex=null,frames=0;
      for(var i=0;i<120;i++){
        window.__sonnetNow=0.7+i/60; window.__mineradioSonnetTick();
        var st=window.__mineradioSonnetState();
        if(baseIndex===null)baseIndex=st.shotIndex;
        if(st.shotIndex!==baseIndex||!st.focus)break;
        frames++;
        var f=st.focus;
        if(prev){
          var dx=f.x-prev.x,dy=f.y-prev.y,d=Math.sqrt(dx*dx+dy*dy);
          var v={x:dx*60,y:dy*60,s:d*60};
          if(d>maxStep)maxStep=d;
          if(prevV){
            if(v.x*prevV.x+v.y*prevV.y<0&&v.s>30&&prevV.s>30)reversals++;
            var j=Math.sqrt(Math.pow(v.x-prevV.x,2)+Math.pow(v.y-prevV.y,2));
            if(j>maxJerk)maxJerk=j;
          }
          prevV=v;
        }
        prev=f;
      }
      return {frames:frames,maxStep:maxStep,reversals:reversals,maxJerk:maxJerk};
    })()`);
    console.log('smooth:', JSON.stringify(smooth));
    assert(smooth.frames >= 90, '流畅度采样帧数不足');
    assert(smooth.maxStep < 12, '真机逐帧跳变过大: ' + smooth.maxStep.toFixed(2) + 'px');
    assert(smooth.reversals <= 2, '真机镜头方向反复: ' + smooth.reversals + ' 次');
    assert(smooth.maxJerk < 60, '真机逐帧 jerk 过大: ' + smooth.maxJerk.toFixed(1));

    // seek 到后面的镜头，再回到同一时刻：镜头种类与相机姿态必须完全一致。
    const seek = await evaluate(`(function(){
      window.__sonnetNow=15.0; window.__mineradioSonnetTick();
      var root=document.getElementById('folia-sonnet-lyrics');
      var later={kind:root.dataset.kind,index:window.__mineradioSonnetState().shotIndex,camera:root.querySelector('.fs-camera').style.transform};
      window.__sonnetNow=1.2; window.__mineradioSonnetTick();
      var back={kind:root.dataset.kind,index:window.__mineradioSonnetState().shotIndex,camera:root.querySelector('.fs-camera').style.transform};
      window.__sonnetNow=1.2; window.__mineradioSonnetTick();
      var again={kind:root.dataset.kind,index:window.__mineradioSonnetState().shotIndex,camera:root.querySelector('.fs-camera').style.transform};
      return {later:later,back:back,again:again};})()`);
    console.log('seek:', JSON.stringify(seek));
    assert(seek.later.index !== seek.back.index, 'seek 没有切换镜头');
    assert(seek.back.kind !== seek.later.kind, '相邻镜头不应重复构图');
    assert(seek.back.camera === seek.again.camera, '同一时刻相机姿态不确定（seek 花屏）');
    assert(seek.back.index === seek.again.index, '同一时刻镜头索引不确定');

    const off = await evaluate(`(function(){
      fx.lyricStyle='default'; window.__mineradioSonnetTick();
      var root=document.getElementById('folia-sonnet-lyrics');
      return {shown:!!(root&&root.classList.contains('show')),words:root?root.querySelectorAll('.fs-word').length:-1,error:window.__sonnetLastError||''};})()`);
    console.log('off:', JSON.stringify(off));
    assert(!off.shown, '切回默认样式后覆盖层没有隐藏');
    assert(off.words === 0, '切回默认样式后文字没有清理');
    assert(pageErrors.length === 0, '页面有未捕获异常: ' + JSON.stringify(pageErrors.slice(0, 3)));
    // --shot：把当前镜头存成预览图，方便人工核对构图（隐藏窗口用 CDP 截图）。
    if (process.argv.indexOf('--shot') >= 0) {
      // 三个时刻连拍：用来肉眼确认「镜头是不是真的跟着字在走」，而不只是数值在变。
      // 隐藏窗口的合成器会节流，入场/淡入的 CSS 过渡可能停在 opacity 0 → 截出空白图，
      // 所以截图前先关掉过渡，等一帧再拍。
      let last = null;
      for (const t of [1.0, 2.2, 5.2, 14.5]) {
        await evaluate("fx.lyricStyle='sonnet'; window.__sonnetNow=" + t
          + "; window.__mineradioSonnetTick();"
          + "var el=document.getElementById('folia-sonnet-lyrics');"
          + "if(el){el.style.transition='none';el.style.opacity='1';}"
          + "document.querySelectorAll('.fs-word').forEach(function(w){w.style.opacity='';});'shot'");
        await sleep(450);
        const png = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const out = path.join(WORK, 'preview-' + t.toFixed(1) + '.png');
        fs.writeFileSync(out, Buffer.from(png.data, 'base64'));
        last = png.data;
        console.log('preview:', out);
      }
      // 拍完把过渡还回去，避免影响后续断言。
      await evaluate("var el=document.getElementById('folia-sonnet-lyrics');if(el){el.style.transition='';el.style.opacity='';}'ok'");
      if (last) fs.writeFileSync(path.join(WORK, 'preview.png'), Buffer.from(last, 'base64'));
    }
    console.log('QA lyrics-sonnet: PASS');
  } catch (err) {
    console.error('QA lyrics-sonnet: FAIL', err && err.stack || err);
    if (pageErrors.length) console.error('PAGE ERRORS:', JSON.stringify(pageErrors.slice(0, 5)));
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (_) { }
    try { child.kill(); } catch (_) { }
  }
})();
