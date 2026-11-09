'use strict';

// Cache-directory settings: one JSON file under userData plus the derived
// lyrics/chromium/beatmap/native paths. Chromium lives on `sessionData` so
// changing the cache root can never log an account out.
function createCacheSettingsManager({
  app,
  fs,
  path,
  crypto,
  appName,
  settingsFile,
  stableUserDataPath,
  nativeHelperTempPath,
  lyricCacheMaxBytes,
}) {
  let settings = null;

  function configPath() {
    return path.join(app.getPath('userData'), settingsFile);
  }

  function defaultRootPath() {
    // 缓存根固定在软件目录内的用户数据下，不再往任何盘符根目录建 MineradioCache。
    // The cache root always lives inside the app's own user data; never at a drive root.
    return path.join(app.getPath('userData'), 'cache');
  }

  function normalizeRootPath(value) {
    const fallback = defaultRootPath();
    const candidate = String(value || '').trim();
    if (!candidate) return fallback;
    try {
      return path.resolve(candidate);
    } catch (_) {
      return fallback;
    }
  }

  function normalize(value) {
    const rootPath = normalizeRootPath(value && value.rootPath);
    return {
      version: 1,
      rootPath,
      lyricsPath: path.join(rootPath, 'lyrics'),
      chromiumPath: path.join(rootPath, 'chromium'),
      beatmapsPath: path.join(rootPath, 'beatmaps'),
      nativePath: path.join(rootPath, 'native-helper-temp'),
    };
  }

  function chromiumSessionDataPath(value) {
    const chromiumRoot = value && value.chromiumPath
      ? value.chromiumPath
      : normalize(null).chromiumPath;
    return path.join(chromiumRoot, appName);
  }

  function read() {
    try {
      const file = configPath();
      const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      return normalize(parsed);
    } catch (error) {
      console.warn('[CacheSettings] read failed:', error.message);
      return normalize(null);
    }
  }

  function write(next) {
    const normalized = normalize(next);
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(tempFile, file);
    return normalized;
  }

  function ensureDirectories(next) {
    const normalized = normalize(next);
    try {
      fs.mkdirSync(normalized.lyricsPath, { recursive: true });
      fs.mkdirSync(normalized.chromiumPath, { recursive: true });
      fs.mkdirSync(chromiumSessionDataPath(normalized), { recursive: true });
      fs.mkdirSync(normalized.beatmapsPath, { recursive: true });
      fs.mkdirSync(normalized.nativePath, { recursive: true });
      return normalized;
    } catch (error) {
      // A removed, sleeping, or temporarily inaccessible custom drive must not
      // prevent Electron from reaching app.ready and showing a window. Keep the
      // saved preference intact and use a stable per-run fallback under userData.
      const fallback = normalize({ rootPath: path.join(stableUserDataPath, 'cache-fallback') });
      console.warn('[CacheSettings] cache root unavailable, using startup fallback:', error.message);
      fs.mkdirSync(fallback.lyricsPath, { recursive: true });
      fs.mkdirSync(fallback.chromiumPath, { recursive: true });
      fs.mkdirSync(chromiumSessionDataPath(fallback), { recursive: true });
      fs.mkdirSync(fallback.beatmapsPath, { recursive: true });
      fs.mkdirSync(fallback.nativePath, { recursive: true });
      return fallback;
    }
  }

  function init() {
    settings = ensureDirectories(read());
    return settings;
  }

  function get() {
    return settings || normalize(null);
  }

  function setRootPath(nextRoot) {
    const root = normalizeRootPath(nextRoot);
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    settings = ensureDirectories(write({ rootPath: root }));
    return settings;
  }

  async function directoryUsageBytes(directory) {
    let total = 0;
    async function walk(current) {
      let entries = [];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch (_) {
        return;
      }
      await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(current, entry.name);
        try {
          if (entry.isDirectory()) return walk(entryPath);
          if (entry.isFile()) {
            const stat = await fs.promises.stat(entryPath);
            total += Math.max(0, Number(stat.size) || 0);
          }
        } catch (_) { }
      }));
    }
    await walk(directory);
    return total;
  }

  async function snapshot() {
    const current = normalize(get());
    const currentChromiumPath = app.getPath('sessionData');
    const desiredChromiumPath = chromiumSessionDataPath(current);
    const activeBeatmapsPath = process.env.MINERADIO_BEAT_CACHE_DIR || current.beatmapsPath;
    const activeNativePath = nativeHelperTempPath();
    const wallpaperEnginePath = path.join(current.nativePath, 'wallpaper-engine-muted-package-cache');
    const activeWallpaperEnginePath = path.join(activeNativePath, 'wallpaper-engine-muted-package-cache');
    const [lyricsBytes, chromiumBytes, beatmapsBytes, wallpaperEngineBytes, userDataBytes] = await Promise.all([
      directoryUsageBytes(current.lyricsPath),
      directoryUsageBytes(currentChromiumPath),
      directoryUsageBytes(activeBeatmapsPath),
      directoryUsageBytes(activeWallpaperEnginePath),
      directoryUsageBytes(app.getPath('userData')),
    ]);
    const chromiumRestartRequired = path.resolve(desiredChromiumPath) !== path.resolve(currentChromiumPath);
    const beatmapsRestartRequired = path.resolve(current.beatmapsPath) !== path.resolve(activeBeatmapsPath);
    const nativeRestartRequired = path.resolve(current.nativePath) !== path.resolve(activeNativePath);
    return {
      ok: true,
      settings: {
        rootPath: current.rootPath,
        lyricsPath: current.lyricsPath,
        chromiumPath: current.chromiumPath,
        activeChromiumPath: currentChromiumPath,
        beatmapsPath: current.beatmapsPath,
        activeBeatmapsPath,
        nativePath: current.nativePath,
        activeNativePath,
        wallpaperEnginePath,
        activeWallpaperEnginePath,
        userDataPath: app.getPath('userData'),
        restartRequired: chromiumRestartRequired || beatmapsRestartRequired || nativeRestartRequired,
      },
      usage: {
        lyricsBytes,
        chromiumBytes,
        beatmapsBytes,
        wallpaperEngineBytes,
        userDataBytes,
        totalManagedBytes: lyricsBytes + chromiumBytes + beatmapsBytes + wallpaperEngineBytes,
      },
    };
  }

  function lyricCacheFilePath(key) {
    const digest = crypto.createHash('sha256').update(String(key || '')).digest('hex');
    return path.join(get().lyricsPath, `${digest}.json`);
  }

  async function pruneLyricCache() {
    let entries = [];
    try {
      entries = await fs.promises.readdir(get().lyricsPath, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/i.test(entry.name)) continue;
      const file = path.join(get().lyricsPath, entry.name);
      try {
        const stat = await fs.promises.stat(file);
        files.push({ file, size: Math.max(0, Number(stat.size) || 0), time: Number(stat.mtimeMs) || 0 });
      } catch (_) { }
    }
    let total = files.reduce((sum, item) => sum + item.size, 0);
    files.sort((a, b) => a.time - b.time);
    for (const item of files) {
      if (total <= lyricCacheMaxBytes) break;
      try {
        await fs.promises.unlink(item.file);
        total -= item.size;
      } catch (_) { }
    }
  }

  return {
    configPath,
    defaultRootPath,
    normalizeRootPath,
    normalize,
    chromiumSessionDataPath,
    read,
    write,
    ensureDirectories,
    init,
    get,
    setRootPath,
    directoryUsageBytes,
    snapshot,
    lyricCacheFilePath,
    pruneLyricCache,
  };
}

module.exports = { createCacheSettingsManager };
