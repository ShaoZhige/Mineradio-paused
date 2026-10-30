// DJ 节奏分析的子进程入口。
//
// 为什么需要这个进程：解码整首歌（WASM 版 mpg123）再加逐帧滤波与能量统计，是纯 CPU
// 密集的 O(n) 计算，原先直接跑在 Electron 主进程的事件循环上。主进程一旦被这类任务
// 占住，期间所有 IPC —— 窗口操作、托盘菜单、preload 暴露的接口 —— 都会排队等待，
// 表现就是「分析节奏的时候整体发顿」。这里把它挪进 utilityProcess：主进程只发消息、
// 收结果，重计算与事件循环彻底分离。
//
// 协议 / Protocol
//   主进程 → 子进程  { id, fn: 'stream' | 'intro', audioUrl, opts }
//   子进程 → 主进程  { id, ok: true, result } | { id, ok: false, error }
//
// dj-analyzer 只依赖 mpg123-decoder（wasm 以 base64 内联在 JS 里，没有独立的 .wasm
// 文件，也不含原生绑定），且模块级只有两个常量、没有可变状态，因此这个进程可以长期
// 复用，不必每首歌重启。

const ANALYZE_FNS = {
  stream: 'analyzePodcastDjStream',
  intro: 'analyzePodcastDjIntro',
};

function loadAnalyzer() {
  return require('./dj-analyzer');
}

// 抽成独立函数是为了能在测试里直接调用，不必真的 fork 一个进程。
async function runAnalyzeTask(msg, analyzer) {
  const id = msg && msg.id;
  const fnName = ANALYZE_FNS[msg && msg.fn];
  if (!fnName) throw new Error('Unknown analyze fn: ' + String(msg && msg.fn));
  const audioUrl = msg.audioUrl;
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) throw new Error('Invalid audio url');
  const opts = (msg.opts && typeof msg.opts === 'object') ? msg.opts : {};
  const impl = analyzer || loadAnalyzer();
  const result = await impl[fnName](audioUrl, opts);
  return { id: id, ok: true, result: result };
}

function startWorker() {
  const port = process.parentPort;
  if (!port) return false;
  const analyzer = loadAnalyzer();
  // 串行处理：多个请求同时进来时排队，而不是并行。并行会同时实例化多个 WASM 解码器，
  // 互相抢 CPU 反而每个都更慢，而且峰值内存成倍上涨。正常的播客场景本来就是一次一首。
  // Serialise instead of running in parallel: concurrent WASM decoders fight over the same
  // cores and multiply peak memory, so parallel is slower in practice for this workload.
  let chain = Promise.resolve();
  port.on('message', function (event) {
    const msg = event && event.data;
    chain = chain.then(async function () {
      let reply;
      try {
        reply = await runAnalyzeTask(msg, analyzer);
      } catch (err) {
        reply = { id: msg && msg.id, ok: false, error: (err && err.message) || String(err) };
      }
      try {
        port.postMessage(reply);
      } catch (err) {
        // 主进程已经退出时 postMessage 会抛，这里无事可做。
      }
    });
  });
  return true;
}

// 只有被 utilityProcess fork 时 process.parentPort 才存在；被测试 require 时不会启动监听。
if (process.parentPort) startWorker();

module.exports = { ANALYZE_FNS, runAnalyzeTask, startWorker };
