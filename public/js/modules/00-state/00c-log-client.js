// 渲染进程的日志出口。以前播放/歌单/登录里的失败只有一句 console.warn，用户报障时终端
// 早就关了，等于什么都没留下。这里统一转到主进程写进 userdata/renderer.log（JSON Lines），
// 和主进程用的是同一套格式（desktop/logging.cjs）。
// Renderer-side log sink: failures used to be a console.warn nobody kept. Everything now goes
// through the bridge into userdata/renderer.log, same JSON Lines format as the main process.
function logEvent(scope, type, fields, level) {
  scope = String(scope || 'renderer');
  type = String(type || 'event');
  level = level === 'error' || level === 'warn' || level === 'debug' ? level : 'info';
  try {
    var api = typeof window !== 'undefined' ? window.desktopWindow : null;
    if (api && typeof api.logEvent === 'function') {
      api.logEvent(scope, type, fields || {}, level);
      return;
    }
  } catch (e) { }
  // 没有桌面桥（纯浏览器里跑前端）时退回 console，行为与以前一致。
  try {
    var method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method]('[' + scope + ']', type, fields || {});
  } catch (e2) { }
}

// 未捕获异常与未处理的 Promise 拒绝：这两个是最容易"静默"的失败，必须留痕。
(function installClientErrorLogging() {
  try {
    if (typeof window === 'undefined' || window.__mineradioErrorLogging) return;
    window.__mineradioErrorLogging = true;
    window.addEventListener('error', function (event) {
      logEvent('window', 'error', {
        message: String((event && event.message) || '').slice(0, 300),
        source: String((event && event.filename) || '').slice(0, 200),
        line: Number(event && event.lineno) || 0,
        column: Number(event && event.colno) || 0,
      }, 'error');
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason;
      logEvent('window', 'unhandledrejection', {
        message: String((reason && reason.message) || reason || '').slice(0, 300),
        stack: String((reason && reason.stack) || '').slice(0, 600),
      }, 'error');
    });
  } catch (e) { }
})();
