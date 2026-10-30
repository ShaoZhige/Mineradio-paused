// dj-analyzer 的主进程侧代理。
//
// 真正的解码 + 频谱计算在 utilityProcess（server/dj-worker.js）里跑，主进程只负责发消息
// 和收结果，因此那类 O(n) 计算不再占住主进程的事件循环。对外导出的函数名与参数与
// server/dj-analyzer 完全一致，调用方（server/server.js 的 /api/podcast/dj-beatmap）
// 一行都不用改。
//
// 降级链 / Fallback chain —— 任何一步拿不到子进程，都退回进程内直接调用：
//   1. 不在 Electron 里（纯 Node 测试、CI、scripts 直跑 server.js）→ 进程内
//   2. require('electron') 拿不到 utilityProcess（旧版本 / 非主进程）→ 进程内
//   3. fork 抛错，或连续失败达到上限 → 进程内
// 降级后功能与改动前完全一致，只是不再有隔离收益。这条链很重要：宁可白改，也不能
// 让播客锁拍在打包环境里因为 fork 失败而彻底不可用。

const path = require('path');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_START_FAILURES = 2;

let child = null;
let childUsable = false;
let seq = 0;
let startFailures = 0;
let isolatedDisabled = false;
let pending = new Map();

function getUtilityProcess() {
  // 必须惰性且包在 try 里：server/ 在设计上要能在纯 Node 下被 require（CI 里的后端回归
  // 测试就是这么跑的），顶层 require('electron') 会直接把那个环境炸掉。
  if (!process.versions.electron) return null;
  try {
    const electron = require('electron');
    const utilityProcess = electron && electron.utilityProcess;
    return (utilityProcess && typeof utilityProcess.fork === 'function') ? utilityProcess : null;
  } catch (err) {
    return null;
  }
}

function rejectAll(reason) {
  const items = Array.from(pending.values());
  pending.clear();
  items.forEach(function (item) {
    clearTimeout(item.timer);
    item.reject(reason);
  });
}

function dropChild(kill) {
  const proc = child;
  child = null;
  childUsable = false;
  if (proc && kill) {
    try { proc.kill(); } catch (err) { /* 已经退出 */ }
  }
  rejectAll(new Error('DJ_ANALYZE_WORKER_EXITED'));
}

function handleMessage(msg) {
  const id = msg && msg.id;
  const item = pending.get(id);
  if (!item) return;
  pending.delete(id);
  clearTimeout(item.timer);
  if (msg && msg.ok) item.resolve(msg.result);
  else item.reject(new Error((msg && msg.error) || 'DJ_ANALYZE_FAILED'));
}

function ensureChild() {
  if (isolatedDisabled) return null;
  if (child && childUsable) return child;
  const utilityProcess = getUtilityProcess();
  if (!utilityProcess) {
    isolatedDisabled = true;
    console.warn('[DjAnalyzerHost] utilityProcess unavailable, analyzing in-process');
    return null;
  }
  const entry = path.join(__dirname, 'dj-worker.js');
  let proc;
  try {
    proc = utilityProcess.fork(entry, [], { serviceName: 'MineradioDjAnalyzer' });
  } catch (err) {
    startFailures += 1;
    console.warn('[DjAnalyzerHost] fork failed:', (err && err.message) || err);
    if (startFailures >= MAX_START_FAILURES) isolatedDisabled = true;
    return null;
  }
  child = proc;
  childUsable = true;
  proc.on('message', handleMessage);
  proc.on('exit', function (code) {
    // proc 已经不是当前实例，说明这是超时杀掉或重建前的旧进程的延迟退出，不能让它把
    // 新实例的状态清掉。
    if (proc !== child) return;
    child = null;
    childUsable = false;
    if (pending.size) {
      console.warn('[DjAnalyzerHost] worker exited with pending requests, code', code);
      rejectAll(new Error('DJ_ANALYZE_WORKER_EXITED'));
    }
  });
  return proc;
}

function request(fn, audioUrl, opts) {
  if (isolatedDisabled) return null;
  const proc = ensureChild();
  if (!proc) return null;
  return new Promise(function (resolve, reject) {
    const id = ++seq;
    const timer = setTimeout(function () {
      pending.delete(id);
      reject(new Error('DJ_ANALYZE_TIMEOUT'));
      // 超时基本等于子进程内部卡死，杀掉让下一次请求重建，而不是让后续请求一起排到底。
      dropChild(true);
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolve, reject: reject, timer: timer });
    try {
      proc.postMessage({ id: id, fn: fn, audioUrl: audioUrl, opts: opts || {} });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function analyzePodcastDjStream(audioUrl, opts) {
  const task = request('stream', audioUrl, opts);
  if (task) return task;
  return require('./dj-analyzer').analyzePodcastDjStream(audioUrl, opts);
}

function analyzePodcastDjIntro(audioUrl, opts) {
  const task = request('intro', audioUrl, opts);
  if (task) return task;
  return require('./dj-analyzer').analyzePodcastDjIntro(audioUrl, opts);
}

// 纯计算、不碰 IO，留在主进程比往返一次进程更快。
function buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, hopSec, durationSec) {
  return require('./dj-analyzer').buildBeatMapFromLowEnergy(lowEnergy, hitEnergy, hopSec, durationSec);
}

module.exports = {
  analyzePodcastDjStream,
  analyzePodcastDjIntro,
  buildBeatMapFromLowEnergy,
  // 仅供测试：确认当前是否真的在用独立进程。
  __isWorkerActive: function () { return !!(child && childUsable); },
};
