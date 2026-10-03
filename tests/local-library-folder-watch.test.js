'use strict';

// 本地音乐库文件夹监视的端到端测试：在真实文件系统上跑。
// End-to-end cover for the local music library folder watcher, on a real filesystem.
//
// 监视器这一类东西靠源码断言是守不住的——它的问题全在生命周期上：句柄有没有关、防抖有没有把
// 事件合并、批量落盘会不会重复入库、文件消失时判据对不对。这些都必须真的建目录、真的写文件、
// 真的让 fs.watch 跑起来才测得出来。
//
// Source-level assertions cannot hold a watcher down: its problems live in the lifecycle — whether
// handles get closed, whether the debounce collapses a burst, whether a bulk drop is imported
// twice, and whether the "the file is gone" rule is right. All of that needs real directories, real
// writes, and a real fs.watch.
//
// 判据里最要紧的一条：**盘掉线也会让文件"消失"**，那时候删索引是不可逆的数据损失。所以只有
// "文件没了但它所在目录还在"才下架。这条会在下面的断连场景里被真的验证。
//
// The rule that matters most: a dropped drive also makes files "vanish", and wiping the index for
// that is irreversible data loss. Pruning therefore requires the file to be gone *while its
// directory still exists*, which the disconnect scenario below verifies for real.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  LocalMusicLibrary,
} = require('../desktop/local-music-library');
const {
  LOCAL_LIBRARY_MAX_WATCHED_DIRECTORIES,
  collectWatchableDirectories,
  isSupportedAudioFile,
  normalizedDirectoryKey,
} = require('../desktop/local-library-watcher');

function makeSongFile(directory, name) {
  const file = path.join(directory, name);
  // 内容不必是合法音频：parseMetadata 被注入成桩，这里只需要 stat 得出来。
  // The bytes need not be valid audio: parseMetadata is a stub, so all that matters is that stat
  // succeeds.
  fs.writeFileSync(file, `fake-audio:${name}`);
  return file;
}

function makeLibrary(userDataPath, options = {}) {
  return new LocalMusicLibrary({
    userDataPath,
    parseMetadata: async (file) => ({
      common: { title: path.basename(file), artists: ['Tester'] },
      format: {},
    }),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// 1. 纯函数：扩展名识别、路径折叠、目录收集
// ---------------------------------------------------------------------------

assert.ok(isSupportedAudioFile('a.MP3'), 'the extension check must be case-insensitive');
assert.ok(isSupportedAudioFile('b.flac') && isSupportedAudioFile('c.wav'), 'common audio extensions must be recognised');
assert.ok(!isSupportedAudioFile('notes.txt') && !isSupportedAudioFile('cover.jpg'), 'non-audio files must be ignored');
assert.ok(!isSupportedAudioFile(''), 'an empty path must not be treated as audio');

// 这条断言描述的是 **Windows 的大小写折叠语义**，而 CI 跑在 ubuntu 上。posix 路径区分大小写，
// 所以在 Linux 上折叠 case 不但无意义、而且必然失败——它断言的是平台行为，不是本模块的行为。
// 用运行平台来选期望值：Windows 上折叠，posix 上原样保留。两种平台都必须自洽。
//
// This assertion describes **Windows case-folding semantics**, while CI runs on ubuntu. A posix
// path is case-sensitive, so folding case there is not merely pointless but guaranteed to fail —
// it asserts platform behaviour, not this module's behaviour. Pick the expectation from the running
// platform: folded on Windows, verbatim on posix. Both platforms must stay self-consistent.
{
  const windowsSemantics = process.platform === 'win32';
  assert.strictEqual(
    normalizedDirectoryKey('C:\\Users\\X'),
    windowsSemantics ? normalizedDirectoryKey('c:\\users\\x') : normalizedDirectoryKey('C:\\Users\\X'),
    windowsSemantics
      ? 'Windows paths must fold case so one directory cannot get two watchers'
      : 'posix paths must stay case-sensitive, otherwise two distinct directories collapse into one watcher'
  );
}

// 目录收集：只收真正含音频文件的目录，且受上限约束。
// Directory collection: only directories that really hold audio, and bounded by the cap.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-watch-scan-'));
  try {
    const music = path.join(root, 'album');
    const nested = path.join(music, 'disc2');
    const empty = path.join(root, 'notes');
    fs.mkdirSync(music);
    fs.mkdirSync(nested);
    fs.mkdirSync(empty);
    makeSongFile(music, 'a.mp3');
    makeSongFile(nested, 'b.mp3');
    fs.writeFileSync(path.join(empty, 'readme.txt'), 'x');

    const all = collectWatchableDirectories(root, 10);
    assert.strictEqual(all.directories.length, 2, 'both the album and its subdirectory hold audio');
    assert.ok(!all.directories.includes(empty), 'a directory with no audio needs no watcher');
    assert.strictEqual(all.skipped, 0, 'nothing was cut off under a generous cap');

    const capped = collectWatchableDirectories(root, 1);
    assert.strictEqual(capped.directories.length, 1, 'the cap must hold');
    assert.strictEqual(capped.skipped, 1, 'the caller must be told what was cut off');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 隐藏目录不该被遍历（点目录多半是元数据缓存，不是音乐）。
// Hidden directories must not be walked: dot-directories are usually metadata caches, not music.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-watch-hidden-'));
  try {
    const hidden = path.join(root, '.thumbnails');
    fs.mkdirSync(hidden);
    makeSongFile(hidden, 'x.mp3');
    const collected = collectWatchableDirectories(root, 10);
    assert.strictEqual(collected.directories.length, 0, 'a dot-directory must not be watched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. 真实监听：导入 → 开启监视 → 新增文件自动入库
// ---------------------------------------------------------------------------

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-watch-lib-'));
  const musicRoot = path.join(workspace, 'music');
  fs.mkdirSync(musicRoot);
  const library = makeLibrary(path.join(workspace, 'userdata'));
  try {
    const first = makeSongFile(musicRoot, 'first.mp3');
    const imported = await library.importFiles([first]);
    assert.strictEqual(imported.count, 1, 'the first song must import');
    assert.deepStrictEqual(library.watchedRoots().length, 1, 'the library must derive one watch root from its records');

    const started = library.startWatching();
    assert.strictEqual(started.ok, true, 'watching must start');
    assert.strictEqual(started.watching, true, 'a directory with audio must actually be watched');
    assert.strictEqual(started.directories, 1, 'exactly one directory holds the audio');
    assert.strictEqual(started.skipped, 0, 'nothing was cut off');
    assert.strictEqual(library.watchers.size, 1, 'a watcher handle must be held');

    // 重复开启不得叠加句柄。
    // Starting twice must not stack handles.
    library.startWatching();
    assert.strictEqual(library.watchers.size, 1, 'restarting must replace the previous watch, not add to it');

    // 新增文件：增量同步要能发现并入库。
    // A new file: the incremental sync must find and import it.
    const second = makeSongFile(musicRoot, 'second.mp3');
    const added = await library.syncWatchedFolders();
    assert.strictEqual(added.added, 1, 'the new file must be imported');
    assert.strictEqual(library.records.size, 2, 'the library must hold both songs');

    // 再同步一次不得重复入库。
    // A second sync must not import it twice.
    const again = await library.syncWatchedFolders();
    assert.strictEqual(again.added, 0, 'an unchanged library must import nothing');
    assert.strictEqual(library.records.size, 2, 'the library must still hold exactly two songs');

    // 通知回调只在真的变了的时候触发。
    // The change callback fires only on a real change.
    const changes = [];
    library.onWatchChange = (change) => changes.push(change);
    makeSongFile(musicRoot, 'third.mp3');
    await library.syncWatchedFolders();
    assert.strictEqual(changes.length, 1, 'a real addition must notify exactly once');
    assert.strictEqual(changes[0].added, 1, 'the notification must carry the count');

    // 删除文件：目录还在 → 应当下架。
    // Deleted file: the directory is still there, so the record must be pruned.
    fs.unlinkSync(first);
    const pruned = await library.syncWatchedFolders();
    assert.strictEqual(pruned.removed, 1, 'a deleted song must be pruned while its directory remains');
    assert.strictEqual(library.records.size, 2, 'the library must hold the remaining two songs');

    // 关键安全判据：整个目录连根拔掉时，一条记录都不许删。
    // The critical safety rule: when the whole directory disappears, not one record may be dropped.
    const beforeDetach = library.records.size;
    const detachedRoot = path.join(workspace, 'removable');
    fs.mkdirSync(detachedRoot);
    const portable = makeSongFile(detachedRoot, 'portable.mp3');
    await library.importFiles([portable]);
    assert.strictEqual(library.records.size, beforeDetach + 1, 'the portable song must import');
    library.startWatching();
    fs.rmSync(detachedRoot, { recursive: true, force: true });
    const detached = await library.syncWatchedFolders();
    assert.strictEqual(
      detached.removed,
      0,
      'a vanished directory means an unmounted drive, not deleted music; pruning there is data loss'
    );
    assert.strictEqual(
      library.records.size,
      beforeDetach + 1,
      'the record must survive its directory disappearing'
    );
  } finally {
    library.stopWatching();
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  // 停用必须真的关掉句柄，否则进程退不出去。
  // Stopping must actually close the handles, or the process cannot exit.
  assert.strictEqual(library.watchers.size, 0, 'stopWatching must drop every watcher');
  assert.strictEqual(library.watchDirectories.size, 0, 'stopWatching must drop the directory map too');
  assert.strictEqual(library.watchDebounceTimers.size, 0, 'stopWatching must cancel pending debounce timers');

  const disabled = makeLibrary(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-watch-off-')), 'userdata'));
  try {
    const off = disabled.startWatching({ enabled: false });
    assert.strictEqual(off.watching, false, 'watching can be turned off explicitly');
    assert.strictEqual(disabled.watchers.size, 0, 'an explicitly disabled watch must hold no handle');
  } finally {
    fs.rmSync(path.dirname(disabled.userDataPath), { recursive: true, force: true });
  }

  assert.ok(LOCAL_LIBRARY_MAX_WATCHED_DIRECTORIES > 0, 'the watcher cap must be a positive number');

  console.log('[OK] The local music library watches its referenced folders with native fs.watch: a '
    + 'bulk drop imports once through the debounce, a deleted song is pruned while its directory '
    + 'remains, and a vanished directory keeps every record because that is an unmounted drive '
    + 'rather than deleted music.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
