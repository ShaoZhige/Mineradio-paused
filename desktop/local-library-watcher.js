'use strict';
// 本地音乐库的文件夹监视：新增文件自动入库、消失文件自动下架。
// Folder watching for the local music library: new files are imported automatically, vanished ones
// are pruned.
//
// 用原生 fs.watch，不引第三方依赖。它的限制必须正面处理：**Windows 上 fs.watch 不支持 recursive**，
// 所以子目录要自己逐个注册；每个 watcher 都要记得关，否则进程退不出去。而且一次批量落盘会连发
// 多个事件，所以每个根目录一个防抖就够了，不需要为每个文件单独计时。
//
// Two hard limits of the native API are handled head-on: fs.watch is not recursive on Windows, so
// subdirectories are registered one by one, and every watcher has to be closed or the process will
// not exit. A bulk drop fires a burst of events, so one debounce per root is enough — there is no
// need for per-file timers.
//
// 自动下架的判据是**文件消失但它所在的目录还在**。盘符掉了、网络盘断连都会让文件"消失"，那种
// 情况下把整段索引删光是不可逆的数据损失；而用户真的删了一首歌，目录还在，这时留着一条打不开的
// 记录才是纯粹的噪音。
//
// The pruning rule is "the file is gone but its directory still exists". A dropped drive or a
// disconnected network share also makes files vanish, and wiping the index for that is irreversible
// data loss; a song the user really deleted leaves its directory behind, and keeping an unplayable
// record there is just noise.

const fs = require('fs');
const path = require('path');

// 一次批量落盘会连发多个事件，合并成一次增量同步。
// A bulk drop fires a burst of events; collapse them into one incremental sync.
const LOCAL_LIBRARY_WATCH_DEBOUNCE_MS = 5000;

// fs.watch 的 watcher 是有成本的：每个都要占一个句柄，注册太多会拖慢启动、也更容易撞上上限。
// A watcher costs a handle, so registering too many slows startup and risks the ceiling.
const LOCAL_LIBRARY_MAX_WATCHED_DIRECTORIES = 200;

// 只登记这些层数的子目录。再深的目录树多半不是音乐库，遍历它没有意义。
// Only descend this many levels: a tree deeper than this is not a music library in practice.
const LOCAL_LIBRARY_WATCH_MAX_DEPTH = 6;

function isSupportedAudioFile(candidate) {
  const extension = path.extname(String(candidate || '')).toLowerCase();
  return ['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.m4b', '.aiff', '.alac'].includes(extension);
}

// Windows 上路径大小写不敏感，同一个目录可能以不同大小写出现；折叠后再去重才不会重复注册。
// Windows paths are case-insensitive, so the same directory can show up in different casings;
// folding before de-duplicating keeps a single watcher per real directory.
function normalizedDirectoryKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const resolved = path.resolve(text);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// 收集 root 之下所有需要注册监听器的目录。返回实际登记的目录与被跳过的数量：调用方需要知道
// 是否被截断了，因为"没监视到"和"确实没有新歌"在界面上必须是两回事。
// Collect every directory under root that needs a watcher. Returns the registered directories and
// how many were skipped, because the caller has to be able to tell "not being watched" apart from
// "genuinely no new songs".
function collectWatchableDirectories(root, cap, maxDepth = LOCAL_LIBRARY_WATCH_MAX_DEPTH) {
  const registered = [];
  const queue = [{ directory: root, depth: 0 }];
  const seen = new Set();
  let skipped = 0;
  while (queue.length) {
    const current = queue.shift();
    const key = normalizedDirectoryKey(current.directory);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let entries = [];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch (error) {
      // 目录读不到（权限、断开的盘）就跳过，不该让整次遍历失败。
      // An unreadable directory (permissions, a dropped drive) is skipped rather than fatal.
      continue;
    }
    if (entries.some((entry) => entry.isFile() && isSupportedAudioFile(entry.name))) {
      if (registered.length >= cap) {
        skipped += 1;
        continue;
      }
      registered.push(current.directory);
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return { directories: registered, skipped };
}

module.exports = {
  LOCAL_LIBRARY_MAX_WATCHED_DIRECTORIES,
  normalizedDirectoryKey,
  LOCAL_LIBRARY_WATCH_DEBOUNCE_MS,
  LOCAL_LIBRARY_WATCH_MAX_DEPTH,
  collectWatchableDirectories,
  isSupportedAudioFile,
};
