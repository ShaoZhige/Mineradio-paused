'use strict';

// DWM 底座的黑窗问题只在对方机器出现，本地跑不出来。诊断快照是唯一的取证手段：
//   - helper 必须在**离散状态点**（就绪 / V|0 / V|1 / 激活 / 退出）输出带 diag 标记的快照；
//   - Node 侧必须把它连同 stderr 落盘到 userdata 的独立日志，且诊断失败绝不影响壁纸。
// FollowHost 每 100ms 一拍的热路径里不许有诊断调用，否则日志刷爆、跟手被拖慢。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  WallpaperEngineRuntime,
  nativeDwmThumbnailSurfaceScript,
} = require('../desktop/wallpaper-engine-runtime');

const helper = nativeDwmThumbnailSurfaceScript();

function check(name, run) {
  run();
  console.log('ok - ' + name);
}

check('helper 在离散状态点输出诊断快照，热路径里没有', () => {
  // 诊断方法必须存在，且带 diag:true 标记 —— Node 侧靠它识别并落盘。
  assert.match(helper, /void Diag\(string stage, string command, string reason\)/, '缺少诊断快照方法');
  assert.match(helper, /\\"diag\\":true/, '诊断行必须带 diag:true 标记');
  // 快照字段要足够定位黑窗：底座与源的可见性 / 矩形 / HWND / 进程 / 系统版本。
  for (const field of ['surfaceVisible', 'sourceVisible', 'surfaceRect', 'sourceRect',
    'surfaceHwnd', 'sourceHwnd', 'sourcePid', 'os', 'thumbnail']) {
    assert.match(helper, new RegExp('\\\\"' + field + '\\\\":'), `诊断缺字段 ${field}`);
  }
  // 五个状态点全覆盖：启动、激活、显隐、跟随中止、退出。
  for (const stage of ['ready', 'activate', 'visibility', 'follow-abort', 'closed']) {
    assert.match(helper, new RegExp('Diag\\("' + stage + '"'), `缺少 ${stage} 状态点的诊断`);
  }
  // V|0 / V|1 之后必须记录 Show/Hide 执行后的真实可见性，这是判断黑窗收没收住的关键。
  const vAt = helper.indexOf('if (makeVisible) Show(); else Hide();');
  assert.ok(vAt > 0);
  assert.match(helper.slice(vAt, vAt + 500), /Diag\("visibility", command/,
    '显隐命令后必须紧跟一条可见性快照');
});

check('诊断调用不在 FollowHost 的 100ms 热路径里', () => {
  const start = helper.indexOf('void FollowHost(bool force)');
  const end = helper.indexOf('\n  }\n', helper.indexOf('lastHostRect = hostRect;', start));
  const followHost = helper.slice(start, end);
  assert.ok(!/\bDiag\(/.test(followHost), 'FollowHost 里不许逐拍打诊断，会刷爆日志并拖慢跟手');
  // 只有 followTimer 的异常退出分支（会 Close）才允许一条。
  assert.ok(/Diag\("follow-abort"/.test(helper));
});

check('诊断快照落盘到独立日志，且不污染协议行', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-dwm-diag-'));
  const diagLog = path.join(tmp, 'dwm-surface.log');
  const runtime = new WallpaperEngineRuntime({
    platform: 'win32',
    nativeTempPath: path.join(tmp, 'native'),
    dwmSurfaceDiagLogPath: diagLog,
  });
  try {
    const ok = runtime._logDwmDiag({
      diag: true, stage: 'visibility', surfaceVisible: false,
      sourceVisible: true, os: '10.0.26100', command: 'V|0',
    }, 'abc123');
    assert.strictEqual(ok, true, '诊断应写入成功');
    const lines = fs.readFileSync(diagLog, 'utf8').trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.strictEqual(record.stage, 'visibility');
    assert.strictEqual(record.surfaceVisible, false);
    assert.strictEqual(record.sessionId, 'abc123');
    assert.strictEqual(record.diag, undefined, 'diag 标记不应重复写入记录体');
    assert.ok(record.ts, '必须带时间戳');
    // 协议行（无 diag）不能被落盘，否则就绪/显隐回执会污染诊断日志。
    assert.strictEqual(runtime._logDwmDiag({ ok: true, ready: true }, 'abc123'), false);
    assert.strictEqual(fs.readFileSync(diagLog, 'utf8').trim().split(/\r?\n/).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('没配日志路径时诊断是静默旁路，不抛错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-dwm-nodiag-'));
  const runtime = new WallpaperEngineRuntime({
    platform: 'win32',
    nativeTempPath: path.join(tmp, 'native'),
  });
  try {
    assert.strictEqual(runtime._logDwmDiag({ diag: true, stage: 'ready' }, 'abc123'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log('\nDWM surface diagnostics: all checks passed');
