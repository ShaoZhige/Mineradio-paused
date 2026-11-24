# Mineradio 重写方案 v2（2026-11-24）— Tauri 2 + Rust

> 本文**取代** `docs/TAURI-REWRITE-PLAN.md`（v1，同日）。v1 保留为第一版决策记录，不再维护。
> 与 v1 的差别：
> 1. 所有数字**重新复核**（v1 的数字基本准确，两处需更正，见 §2.5）；
> 2. 把 **rust-anything 定为 P2 的排序器与验证器**（§6，含具体命令与试点方案）；
> 3. 补上 v1 没回答的问题：文件拖入路径、WebView2 运行时分发、CI 14 条流水线映射、许可扫描、本地端口硬化、napi 桥在 Electron 里的 ABI 验证；
> 4. 每个阶段加了**止损条件**（什么情况停下来重估，而不是硬推）。

---

## 0. 一页看懂

| 项 | 内容 |
|---|---|
| **目标** | `public/` 107,547 行**逐字节保留**；Electron 主进程、Node 服务、脚本、测试驱动、原生 Windows 助手全部换成 Rust + Tauri 2 |
| **不动的** | `public/`（155 文件）、`cuefield/`（JS 外部进程）、Apple Music C# companion（外部进程） |
| **换掉的** | `desktop/` 30,670 行、`server/` 22,350 行、`scripts/` 17,423 行、`tests/` 36,906 行 |
| **路线** | 单仓库开 `tauri-rewrite` 分支，`main` 冻结在 v3.3.0；双壳并行，P6 才切 |
| **关键工具** | 查顺序用 `rust-anything analyze`；证明行为一致用 `record → diff → gate`；过渡期真机比对用 `shadow` |
| **最大风险** | 凭据不可迁移（R1）、WebView2 ≠ Chromium（R2）、测试网几乎全废（R3）、原生能力重写（R4）、桌面模式/壁纸宿主（R5） |
| **第一刀** | P1 的 400 行壳：axum 托管 `public/` + 空 `/api` + Tauri 窗口 + shim → **首页能渲染**。渲染不出来，后面全部无意义 |
| **第二刀（工具选型）** | 拿 `server/` 一个纯函数模块跑通 `analyze → record → bridge → diff → gate`，并确认 `.node` 能在 Electron 里 require。一天内能判死 |

---

## 1. 决策记录

| # | 决策 | 选择 | 理由 | 改判代价 |
|---|---|---|---|---|
| **D1** | 新代码放哪 | 同仓库开 `tauri-rewrite` 分支，`main` 冻结 v3.3.0 | 保留历史与 release 链路；两套 shell 长期并行对照；不新建仓库避免资产二次拷贝 | 低（只影响分支策略） |
| **D2** | "其余全部 Rust"的边界 | v1 允许 **Apple Music C# companion** 与 **`cuefield/`** 作独立外部进程 | 一个是 WebView2 宿主（4,000+ 行 C#），一个是独立 JS 子项目（19 文件 6,683 行）；硬塞进 Rust 会拖垮主线 | 中（会多 6,683 行 + C# 宿主工作） |
| **D3** | 已加密凭据怎么办 | **强制重新登录，不迁移** | 现 `.credential-key` 是 Electron `safeStorage`（Windows 上按应用身份绑定的 DPAPI），Tauri 新身份解不开；强行迁移＝把主密钥导出来 | 高（用户需重登 6 平台，但设置/歌单不受影响） |
| **D4** | 目标平台 | **v1 仅 Windows x64** | 壁纸/DWM/HID/桌面模式全是 Windows 专属；跨平台要先砍功能，是另一个项目 | 高（几乎等于重做一遍） |
| **D5** | rust-anything 的定位 | **只做"排序 + 验证"**；交付物是 Rust crate，napi 桥是**脚手架**，P6 删除 | 它的桥让原语言进程继续活着 —— 与 Tauri 目标相反。但它的 `record/diff/gate` 正好补上 R3 的窟窿 | 低（随时可退出，产物是普通 crate） |
| **D6** | 切换策略 | 双壳并行 QA，P6 才把 `main` 切到 Tauri；Electron 代码归档不删 | 出问题能立刻回滚到 v3.3.0 | 低 |

> D1~D4 任一条改判，§4 的 crate 划分与 §7 的阶段都要重排。D5 改判只影响 §6。

---

## 2. 实测基线（2026-11-24 复核，非估计）

### 2.1 仓库状态

| 项 | 值 |
|---|---|
| HEAD | `7c493f0` `chore: 发布 v3.3.0（Electron 架构终版结档）` |
| tag | `v3.3.0`（annotated） |
| 工作区 | 干净（`git status` 无输出） |
| `package.json` version | `3.3.0` |
| 生产依赖 | 6 个：`gsap` `mpg123-decoder` `music-metadata` `NeteaseCloudMusicApi` `node-hid` `qrcode` |
| 开发依赖 | 4 个 |

### 2.2 保留区：`public/`

| 类型 | 行数 | 文件数 |
|---|---:|---:|
| JS | 83,097 | 133 |
| CSS | 20,591 | 19 |
| HTML | 3,859 | 3 |
| **合计（代码）** | **107,547** | **155** |
| **含 vendor/assets/locales 的全量** | — | **169**（18.94 MB，`docs/PUBLIC-HASHES.txt` 的基线） |

静态资源：`vendor/` 13 MB（three.js r128、gsap、music-tempo、结巴词典）、`assets/` 1 MB、`locales/` 1.3 MB（7 语言）。
`index.html` 只引用相对路径的 `vendor/*` 与 `js/*`，**没有任何 `node_modules` 引用** → 任何 HTTP 服务器都能托管。

### 2.3 替换区

| 目录 | 行数 | 文件数 | 构成 |
|---|---:|---:|---|
| `desktop/` | 30,670 | 60 | 49 `.js` + 11 `.cjs`；三大文件：`wallpaper-engine-runtime.js`（322 KB）、`main.js`（285 KB）、`full-desktop-mode-runtime.js`（106 KB） |
| `server/` | 22,350 | 24 | 全部 `.js`；`server.js` 单文件用 `http.createServer` 手写 125 条路由 |
| `scripts/` | 17,423 | 30 | 24 `.js` + 6 `.cjs`（另含 4 `.ps1`） |
| `tests/` | 36,906 | 204 | 全部 `.js`，绝大多数断言 `.js` 源码字符串 |
| `cuefield/` | 6,683 | 19 | D2：v1 保留为外部进程 |

### 2.4 工具链与环境

| 项 | 状态 |
|---|---|
| Node / npm | v22.22.2 / 10.9.7 |
| Rust | ✅ **已装**：1.100.0 stable-x86_64-pc-windows-msvc + clippy/rustfmt/llvm-tools；MSVC 2022 在 `E:\VS2022BuildTools`；`tauri info` 全绿（2026-11-24） |
| `userdata/` | 697 MB（含 `.credential-key`），目录里有 `built-in-playlists.json`、`current-fx-autosave.json`、`local-music-library.json`、`custom-sources/`、`logs/`、`cache/`、`exports/`、`startup-state.json`、`login-easter-egg.json` |
| 磁盘 | E: 64 GB，剩 **17 GB**（MSVC 占 3.4 GB）；⚠️ **C: 只剩 3.7 GB**（VS 安装器 + Win SDK + 1.3 GB 包缓存都在 C:）。`cargo build` 的 `target/` 会很大，务必确认 `CARGO_TARGET_DIR` 在 E:（默认就在项目内，没问题）；C 盘紧张时先清 `C:\ProgramData\Microsoft\VisualStudio\Packages` |
| CI | `.github/workflows/` 共 **14** 条 |

### 2.5 数字复核结论（v1 需要更正的两处）

| 项 | v1 写的 | 实测 | 处理 |
|---|---|---|---|
| `build/installer.nsh` | 985 行 | **1,222 行**，含**自定义语言选择页**（7 语言：`zh_cn` `zh_tw` `zh_hk` `en_us` `es_es` `ja_jp` `ru_ru`），写 `.installer-language` 标记文件供 `getInstallerLanguage` 读取 | §9.1 按 1,222 行重估，且明确"自定义页"必须换模板，不是加钩子 |
| `scripts/` | 30 文件 / 17,423 行 | 30 文件确认（24 `.js` + 6 `.cjs`），行数吻合 | 无 |

其余（107,547 / 155、125 路由、116 方法、60 文件、14 workflow）**全部复核通过**。

---

## 3. 契约盘点（这才是重写的真实工作量）

### 3.1 服务端 125 条 `/api/*`（按一级域）

| 域 | 条数 | 备注 |
|---|---:|---|
| `spotify` | 28 | 走 `server/spotify-cdp{,-bridge}.js`，**CDP 控制 Spotify 桌面客户端**，需 WebSocket |
| `qishui` | 20 | 汽水音乐；登录需要 `BrowserWindow` + `qrcode`（当前顶层 `require('electron')`） |
| `kugou` | 12 | 含签名/加密 |
| `qq` | 11 | 含 VIP 权益判断 |
| `podcast` | 7 | |
| `apple-music` | 6 | 转发给 C# companion |
| `update` | 5 | 多镜像 + 版本比对 |
| `song` | 5 | |
| `login` | 5 | 网易云扫码 |
| `playlist` | 4 | |
| `album` | 3 | |
| `weather` / `listen` / `cuefield` / `beatmap` | 各 2 | |
| `app` / `audio` / `cover` / `lyric` / `search` / `user` / `platform` / `logout` / `discover` / `custom-source` / `artist` | 各 1 | |
| **合计** | **125** | 唯一字面量数，已核实 |

前端 `public/js/` 里的 `/api/*` 字面量 106 条（v1 统计，P0 用脚本复核）。

### 3.2 桥 `window.desktopWindow.*` 116 个（按域）

| 域 | 方法 | 说明 |
|---|---|---|
| 窗口控制 | `minimize` `restore` `toggleMaximize` `toggleFullscreen` `exitFullscreenWindowed` `getState` `setWindowCornerRadius` `close` `get/setCloseBehavior` | 圆角走 `send`（单向） |
| 系统/内存 | `getGpuDiagnostics` `getMemorySnapshot` `getAppMemoryMetrics` `configureMemoryReduct` `trimAppMemory` `purgeSystemMemory` | |
| 缓存 | `getCacheSettings` `chooseCacheDirectory` `setCacheSettings` `readLyricCache` `writeLyricCache` | |
| 壁纸引擎 | `listWallpaperEngineProjects` `getWallpaperEngineProjectDetails` `openWallpaperEngineProjectDetails` `chooseWallpaperEngineDirectory` `chooseWallpaperEngineProjectFile` `removeWallpaperEngineDirectory` `getWallpaperEngineRuntimeStatus` `warmupWallpaperEngineRuntime` `startWallpaperEngineScene` `stopWallpaperEngineScene` `reportWallpaperEngineCaptureResult` `prepareWallpaperEngineGlassCapture` `activateWallpaperEngineDwmSurface` `hideWallpaperEngineDwmSurface` `updateWallpaperEngineGlassSurface` `updateWallpaperEngineVisualSettings` `reportWallpaperEnginePointerActivity` | 最重的一块，17 个 |
| 游戏模式 | `getWindowsGameModeStatus` `enableWindowsGameMode` `disableWindowsGameMode` | |
| 本地曲库 / 内置歌单 | `listLocalMusicLibrary` `readLocalMusicLyric` `importLocalMusicFiles` `listBuiltInPlaylists` `readBuiltInPlaylist` `createBuiltInPlaylist` `renameBuiltInPlaylist` `deleteBuiltInPlaylist` `addBuiltInPlaylistTrack` `addBuiltInPlaylistTracks` `removeBuiltInPlaylistTrack` `reorderBuiltInPlaylistTrack` | |
| 导入导出 | `exportPlaylistFile` `importPlaylistFile` `exportJson*` `importJson*` `exportLoginCookie` | |
| 登录 | `openNeteaseMusicLogin` `clearNeteaseMusicLogin` `openQQMusicLogin` `clearQQMusicLogin` `openKugouMusicLogin` `clearKugouMusicLogin` `openSpotifyMusicLogin` `openSpotifyAuthUrl` `verifySpotifyMusicSetup` `clearSpotifyMusicLogin` `clearQishuiMusicLogin` `getLoginEasterEggStatus` `unlockLoginEasterEgg` `resetLoginEasterEgg` | |
| Apple Music | `appleMusicRequest` | 转发 companion |
| 桌面模式 | `setDesktopLyricsEnabled` `updateDesktopLyrics` `setWallpaperMode` `updateWallpaperMode` `getWallpaperModeStatus` `requestGestureCameraPermission` `updateDesktopIcon*` `setDesktopSoftwareLocked` `setDesktopIconsVisible` `requestDesktopKeyboardFocus` `updateDesktopPointerRoute` `setDesktopControllerZone` | |
| 自定义音源 | `listCustomSources` `importCustomSource` `replaceCustomSource` `activateCustomSource` `deactivateCustomSource` `removeCustomSource` `setCustomSourceUpdateAlert` | |
| 其它 | `isDesktop` `systemRelease` `setLocale` `getInstallerLanguage` `logEvent` `copyText` `readText` `configureGlobalHotkeys` `openUpdatePage` `restartApp` `halo` | |
| 事件订阅 `onXxx(cb)` | **10** | 实测清单（`docs/API-CONTRACT.json#events`）：`desktop-window-state`、`mineradio-custom-source-status`、`mineradio-desktop-lyrics-enabled-state`、`mineradio-desktop-lyrics-lock-state`、`mineradio-full-desktop-controller-hover`、`mineradio-global-hotkey`、`mineradio-local-library-changed`、`mineradio-wallpaper-engine-host-bounds-changed`、`mineradio-wallpaper-runtime-state`、`spotify-music-oauth-url` |
| **同步方法** | **2** | `readCurrentFxAutosaveSync` / `saveCurrentFxAutosaveSync`（`preload.js:165-166`，`ipcRenderer.sendSync`）。🔴 Tauri 的 `invoke` 只有异步形态 → 这两个必须靠"启动预读进内存 + 写时异步落盘"伪造同步语义，是 P3 的单独一条 |

**`halo` 是命名空间不是方法**：它一层里有 15 个子方法（`halo.getConfig` … `halo.manualHold`），所以
`desktopWindow` 顶层键 **116**、摊平后是 **130** 项（91+2 invoke、18 send、2 sendSync、10 event、2 clipboard、3 本地、2 常量）。shim 必须把 `halo` 原样作为对象挂上去，前端写的是 `desktopWindow.halo.xxx`。

### 3.3 原生能力清单（windows-rs 要重写的）

| 能力 | 现状实现 | 目标 |
|---|---|---|
| 窗口圆角 / 全屏切换 | Electron `BrowserWindow` + 自绘 | `SetWindowRgn` / `DwmSetWindowAttribute` |
| DWM 缩略图底座 | **C# 源码内嵌字符串**，运行时编译 | `DwmRegisterThumbnail` + `SetWindowPos` |
| 壁纸启停 / 拖动跟手 | `wallpaper-engine-capture-worker.js` + `wallpaper-engine-capture-loop.ps1` | 进程宿主 + WGC 抓帧 IPC |
| Halo PixelBar | `node-hid` | `windows` crate HID（`SetupDi*` + `WriteFile`） |
| 游戏模式 | `windows-game-mode.js`（PowerShell/注册表） | 注册表直调 |
| 桌面图标层 | `desktop-native-icon-layer-runtime.js`（56 KB） | Win32 窗口层级 + `WinEventHook` |
| 完整桌面模式 | `full-desktop-mode-runtime.js`（106 KB） | 同上，最大单体风险 |
| 全局中键 / 热键 | `global-middle-click-poller.js` + `globalShortcut` | 低级鼠标钩子 / `RegisterHotKey` |

### 3.4 外部进程 3 个

| 进程 | 形态 | v1 处置 |
|---|---|---|
| Apple Music companion | C#（`build/apple-music-native/`），WebView2 宿主，JSON 行协议 | 保留，Rust 侧按现有握手协议通信 |
| `cuefield/` | 独立 JS 子项目（6,683 行），`/api/cuefield/*` 两条路由 | 保留，Node 子进程 |
| Wallpaper Engine | 用户自己的 `wallpaper64.exe` + WE 工程目录 | 保留，Rust 只做宿主与配置读写 |

### 3.5 契约冻结机制（新增，v1 没有）— ✅ 已落地

两份可复算的"契约基线"，任何阶段红一条就停（第三份 GUARD-LEDGER 只在文档层退役，不参与计算）：

| 产物 | 生成脚本 | 实测内容 | CI 闸门 |
|---|---|---|---|
| **`docs/API-CONTRACT.json`** | `scripts/contract-extract.js` | 125 路由（26 个域）/ 116 桥顶层键 / 130 摊平项 / 10 事件 / 前端 103 条 `/api/` 字面量全部命中（0 悬空）/ `portOrder` 19 项 | `npm run contract:check` |
| **`docs/PUBLIC-HASHES.txt`** | `scripts/public-hashes.js` | 169 个文件 / 18.94 MB 的 sha256（`sha256sum -c` 可直接验） | `npm run hash:check` |
| `docs/GUARD-LEDGER.md` | — | C 类 715 / B 类 3,187 条源码字符串断言，Rust 侧无对应物 | 只读参考，不维护 |

两条设计约束（踩过才知道）：

1. **产物必须确定性**：所有数组排序、不含时间戳，`--check` 才能做「重新生成 == 文件逐字节相同」的比对。
   `portOrder` / `portOrderSource` 属于外部注入字段，重新生成时**原样保留**（`EXTERNAL_FIELDS`），否则每次 `--check` 都会把自己擦掉。
2. **脚本不能放 `ztest/`**：那个目录整体在 `.gitignore` 里，CI 拿不到。落在 `scripts/`，
   两个都带 `--check`（不一致时打印"改动了哪个文件/哪个路由"并退出 1），已接进 `ci.yml` 的 `test-node` 作业。
3. 重写期间给 `public/` 的摩擦是有意的：改了前端就必须 `npm run hash:public` 重新立基线并在提交里写原因。

---

## 4. 目标架构

### 4.1 目录

```
Mineradio-paused-main/
├── Cargo.toml                     # Cargo workspace（v1 没有，见 4.4）
├── Cargo.lock                     # 二进制项目，锁进仓库
├── public/                        # 🔒 逐字节保留 + 哈希守卫
├── src-tauri/                     # 壳：开窗、注入 shim、编排生命周期（✅ P1 已有）
│   ├── Cargo.toml
│   ├── tauri.conf.json            # frontendDist 指向 placeholder/（不嵌入 19 MB 前端）
│   ├── capabilities/default.toml  # deny-by-default，逐项授权（P3 才开始需要）
│   ├── build.rs
│   ├── icons/icon.ico             # 复用 build/icon.ico
│   ├── placeholder/index.html     # 只为满足 frontendDist，窗口不从 asset 协议加载
│   └── src/
│       ├── main.rs                # tauri::Builder + 窗口 + 注入脚本
│       ├── sysinfo.rs             # systemRelease（RtlGetVersion，不能用 GetVersionExW）
│       ├── shell/                 # P3：托盘、热键、单实例、退出编排
│       ├── commands/              # P3：116 个 #[tauri::command]，按域拆文件
│       ├── events/                # P3：onXxx → tauri::Emitter
│       └── bridge/                # shim.js（脚本生成）+ 占位符注入
├── crates/
│   ├── mineradio-server/          # ✅ P1 已有：axum 装配（静态 + /api 桩 + /internal），不依赖 tauri
│   ├── mineradio-core/            # P2：纯逻辑，无 tauri、无网络语义，可单测（rust-anything 主战场）
│   ├── mineradio-providers/       # P2：6 平台适配器：netease/qq/kugou/qishui/spotify/applemusic
│   ├── mineradio-store/           # P2：设置、fx 存档、内置歌单、曲库索引、缓存、凭据
│   ├── mineradio-native/          # P4：windows-rs：窗口/DWM/壁纸/HID/游戏模式/桌面图标
│   └── mineradio-log/             # P2：按 docs/LOGGING.md 的 JSONL 事件与脱敏
├── apple-music-companion/         # D2：C# 外部进程（现有 build/apple-music-native）
├── cuefield/                      # D2：JS 外部进程
└── docs/
    ├── REWRITE-PLAN.md            # 本文
    ├── API-CONTRACT.json          # P0 生成
    └── PUBLIC-HASHES.txt          # P0 生成
```

**相对 4.1 原文的一处调整**：axum 装配没有放在 `src-tauri/src/server/`，而是独立成
`crates/mineradio-server`。理由和 4.2 的约束一致 —— 放进 `src-tauri` 就绑死了 tauri 依赖，
而"静态托管 + `/api`"这件事恰好是唯一能在无 GUI 环境下被 curl 全量验证的部分（P1 的第一道风险）。
现在它既能被 `src-tauri` 调，也能 `cargo run -p mineradio-server` 单跑、`cargo test` 单测。

### 4.2 crate 划分（为什么不是 v1 的单一 `src-tauri/src/*`）

| crate | 依赖 tauri? | 依赖网络? | 谁调它 | 能否被 rust-anything 桥 |
|---|---|---|---|---|
| `mineradio-core` | ❌ | ❌ | 全部 | ✅ 最适合（纯函数、易录制） |
| `mineradio-providers` | ❌ | ✅ | `mineradio-core` / axum | ⚠️ 只在注入 HTTP 客户端后可录 |
| `mineradio-store` | ❌ | ❌ | axum / commands | ✅（文件 IO 用例） |
| `mineradio-native` | ❌ | ❌ | commands | ❌（录不到 Win32 行为） |
| `mineradio-log` | ❌ | ❌ | 全部 | ✅（序列化/脱敏规则） |
| `src-tauri` | ✅ | ✅ | 系统 | ❌（壳，不搬业务） |

**关键约束：业务 crate 一律不依赖 `tauri`。** 这样它们能独立 `cargo test`、能被 napi 桥接进 Electron 做灰度、也能被 axum 直接调 —— 三用途一套代码。

### 4.3 一次 `/api` 请求的生命周期

```
WebView2 (public/js fetch('/api/search'))
  → axum Router (127.0.0.1:<随机端口>)
    → handlers/search.rs        参数校验、错误码映射（保持现有 JSON 形状）
      → mineradio-providers::qq::search()   网络/签名
        → mineradio-core::sign::qq()        纯函数（录制点）
      ← ProviderError → HTTP status + {ok:false,error}
  ← 响应原样返回，字段名/嵌套层级与 v3.3.0 一致
```

前端一个字都不用改，因为它只认"相对路径 + JSON 形状"。

### 4.4 与 v1 的架构差异

| 点 | v1 | v2 | 原因 |
|---|---|---|---|
| crate 组织 | 全部塞 `src-tauri/src/*` | 根 workspace + 5 个独立 crate | rust-anything 产出的是独立 crate；workspace 让它成为一等公民，`cargo test -p` 可独立跑 |
| 静态托管 | `self` 自研 axum | 同（保留） | Tauri 官方 `tauri-plugin-localhost` 只能托管静态资源，`on_request` 只能改响应头，给不了 125 条自定义路由 |
| 前端通信 | HTTP 保留 106 处 fetch | 同（保留） | 用 invoke 重写会破坏 `public/` 不变的前提，且 106 处调用要逐个改前端 |
| 凭据 | 只说"强制重登" | 补：Credential Manager 具体条目名 + portable 降级 | §5.3 |
| 文件拖入 | 未提 | 补：`webUtils.getPathForFile` 的替代方案 | §5.2.5，这是真实断点 |
| 阶段闸门 | 4 道 | 5 道（加 `rust-anything gate` + 契约快照） | R3 |

---

## 5. 六个技术专题（每节给结论，不留"待研究"）

### 5.1 静态托管 + `/api` 单源

**结论：自研 axum，绑 `127.0.0.1`，随机端口，同时服务静态与 API。**

- 端口选择：沿用现有逻辑（探测可用端口），窗口 URL 保持
  `http://127.0.0.1:<port>/?startupAttempt=<n>&startupAt=<ts>` —— 前端有基于这两个参数的缓存击穿逻辑，**必须保真**。
- 静态：`GET /*` → `public/`，需实现 `Content-Type`（含 `.mjs` `.woff2` `.json`）、`Content-Length`、`Accept-Ranges: bytes`（音频拖动必需）、`Cache-Control`（`vendor/*` 长缓存 + hash/`?v=` 击穿）。
- CSP：由我们自己的响应头控制（不走 Tauri asset 协议），保持与 v3.3.0 一致的白名单，避免 three.js 着色器/`blob:` worker 被拦。
- `/internal/*`：只给 shim 用（两个同步方法），见 5.2.4。
- **硬化（新增，前端无感）**：
  - 只绑 `127.0.0.1`，不绑 `0.0.0.0`；
  - 校验 `Sec-Fetch-Site`：`cross-site` 一律 403（防止网页用 `<img>`/`fetch` 打本地端口）；
  - 校验 `Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（防 DNS rebinding）；
  - `/internal/*` 额外要求一次性 token（由 shim 在页面加载时从 URL 参数取，再放 `X-MR-Internal` 头）—— 这些都在 shim 里做，`public/` 不动。

### 5.2 桥 shim（116 方法）

**结论：`initialization_script` 注入一个 `src-tauri/src/bridge/shim.js`，逐方法映射到 `invoke()`。**

必须处理的六件事：

1. **注入时机**：`WebviewWindowBuilder::initialization_script()`，在页面脚本之前执行。**每个 webview 都要注入**：主窗口、桌面歌词窗（透明）、`startup.html` 启动壳。
2. **属性型**：`isDesktop: true` 硬编码；`systemRelease` 在生成 shim 时由 Rust 填入 —— **用 `RtlGetVersion`，不要用 `GetVersionExW`**（无 manifest 时后者谎报 6.2 / build 9200，本机已实测；Win11 判定依赖真实 build ≥ 22000）。
3. **事件型**：`onXxx(cb)` → `listen('mr:xxx', e => cb(e.payload))`，返回 `unlisten` 函数（前端有调用方，**不能返回 undefined**）。
4. **两个同步方法**：`readCurrentFxAutosaveSync` / `saveCurrentFxAutosaveSync` 用**同步 `XMLHttpRequest`** 打到 `/internal/fx-autosave/*`。同源本地 HTTP 下可用，语义等价。**备选**：省略这两个方法 —— 前端有 `typeof !== 'function'` 守卫，会退回内存态，但视觉设置持久化失效。**仅在同步 XHR 被 WebView2 限制时使用**。
5. **文件拖入路径（v1 漏掉的真实断点）**：
   `preload.js:83-99` 的 `importLocalMusicFiles(files)` 用 `webUtils.getPathForFile(file)` 把 `File` 换成磁盘路径，再交给主进程授权导入。**WebView2 里 `File` 没有路径，也没有 `webUtils`。** 处置：
   - shim 注册 Tauri `onDragDropEvent`，把每次 drop 的绝对路径压进队列（按文件名 + 序号匹配）；
   - `importLocalMusicFiles(files)` 被调用时从队列取对应路径，走原授权流程；
   - 队列空（例如 `<input type=file>` 路径）→ 降级调 `tauri-plugin-dialog` 让用户重选目录。
   - 验收：拖一个文件夹进窗口，能导入、能播、重启后还在。
6. **剪贴板**：现有代码已按 W3C 异步形态写（`await clipboard.writeText`），映射到 `tauri-plugin-clipboard-manager` 即可，无需改前端。

### 5.3 凭据（D3 落地）

**结论：新方案 = Windows Credential Manager，条目名 `Mineradio/<provider>`，值为 JSON blob；portable 模式降级为 DPAPI 加密文件。**

| 项 | 方案 |
|---|---|
| 存储 | `CredWriteW` / `CredReadW`（`CRED_TYPE_GENERIC`, `CRED_PERSIST_LOCAL_MACHINE`），用户名 `mineradio` |
| 覆盖 | `netease.cookie` / `qishui` / `kugou` / `qq` / `spotify.token` / `spotify.credentials` / `applemusic.session` |
| portable | 检测到便携目录 → 用 `CryptProtectData`（附加熵 `mineradio-v1`）写 `userdata/.credentials.bin`，等价于旧行为 |
| 旧 key 检测 | 启动时若发现 `userdata/.credential-key` 存在且解不开：**绝不尝试导入**，只写一条 `account` scope 日志 + 前端提示"需要重新登录" |
| 迁移 | 不迁移。用户重登后，`settings.json` / `built-in-playlists.json` / `current-fx-autosave.json` / 曲库索引**原样保留**（这些是明文 JSON，与凭据无关） |
| 🔴 红线 | 开发期用 `node_modules/.bin/electron` 或 `cargo run` 指向**生产 userdata** 会让旧 `prepareMasterKeyAsync` 静默重生成主密钥、把全部 `MR1` 凭据作废。任何调试一律用 `--user-data-dir` 指向临时目录 |

### 5.4 原生层（windows-rs）

按 §3.3 的表逐项重写，每项都有**可观测验收**，不验收"看起来对"：

| 能力 | 关键 API | 验收 |
|---|---|---|
| 圆角/全屏 | `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE)`、`SetWindowPos` | Win11 圆角在、Win10 直角不崩；全屏切换无黑边 |
| DWM 缩略图底座 | `DwmRegisterThumbnail` / `DwmUpdateThumbnailProperties` | 壁纸在窗口后面跟随，最小化/托盘/退出即全停，无残留窗 |
| 壁纸拖动跟手 | `WM_WINDOWPOSCHANGED` 钩子 + 缩略图属性更新（差值同步） | 拖 200 px 无撕裂、无滞后帧 |
| HID（Halo） | `SetupDiGetClassDevs` + `CreateFile` + `WriteFile` | 歌词同步到设备，拔插后自动重连 |
| 游戏模式 | 注册表 `HKCU\...\GameDVR` 开关 | 开/关后系统设置页状态一致 |
| 桌面图标层 | 分层窗口 + `SetWindowLongPtr` + `WinEventHook` | 图标可选中、可拖、不遮挡其它窗口 |
| 完整桌面模式 | 同上 + 壁纸作为桌面底图 | 切换进/出无残留、Explorer 不受损 |

### 5.5 外部进程协议

- **Apple Music companion**：保持现有 JSON 行协议（`companionRequests.cjs` 里的 `operation` 集合即契约）。Rust 侧用 `tokio::process::Command` + `BufReader` 逐行读写，超时/重试与 v3.3.0 对齐（现有有 `am-start-retry` 一次重试的语义，别丢）。
- **cuefield**：`/api/cuefield/feedback` 与 `/api/cuefield/transition` 两条路由转发到 Node 子进程，保持 stdio JSON。
- **Wallpaper Engine**：只读写用户 WE 的 `config.json`（`wproperties` 跟随）+ 启停 `wallpaper64.exe`，不修改用户工程。

### 5.6 存储与日志

- `userdata/` **布局一字不改**（同名同结构），这样 D3 只影响凭据，其余用户数据零迁移。
- 日志按 `docs/LOGGING.md`：JSON Lines、`{at,level,scope,event,...}`、512 KB 滚动一份 `.1`、`scope` 固定枚举、**脱敏红线**（cookie/token/密码/完整 URL/歌词原文/绝对路径/昵称头像一律不写）。Rust 侧实现 `mineradio-log` crate，字段校验写成单测。

---

## 6. rust-anything 怎么用（本章是 v2 新增的核心）

### 6.1 它是什么 / 不是什么

- **是**：`record`（跑原代码、生成边界用例、存 `cases.jsonl`）→ 你/agent 写 Rust → `diff`（回放比对）→ `gate`（fmt/clippy/test/unsafe 审计/"没有未移植项"）的**证明链**，外加 `bridge`（napi-rs / wasm-bindgen 等）让原语言继续调 Rust。
- **不是**：代码翻译器；也不是"把 Electron 换成 Tauri"的工具。它的桥让**原语言进程继续存在** —— 这与 Tauri 目标相反。

**所以用法只有一句：把它当尺子，不当锤子。**

### 6.2 三种姿势

| 姿势 | 命令 | 用在哪 | 风险 |
|---|---|---|---|
| **排序**（零风险） | `rust-anything analyze server/`、`rust-anything analyze crates/` | P0 决定"先搬哪几个模块"；看它给的风险表（字符串偏移、正则、动态类型、`Map` 顺序、异步） | 无（只读源码） |
| **证明**（主战场） | `record` → 写 Rust → `diff` → `gate` | `server/` 与 `crates/mineradio-core` 的纯逻辑 | 会真跑原代码（见 6.7） |
| **灰度**（过渡期） | `shadow`，`RUST_ANYTHING_MODE=old\|shadow\|new` | Electron 还在跑时，同一路径跑两份、返回旧结果、记录差异 | 需要 napi 桥可用（见 6.6） |

### 6.3 录制分级（决定什么该录，什么不该录）

| 级 | 对象 | 例子 | 处置 |
|---|---|---|---|
| **A 纯函数** | 无 IO、无时钟、无随机 | 各平台签名/加密、URL 组装、歌词解析、歌单树扁平化、`Mineradio` 的 `sanitize()` | ✅ **全录**，这是 rust-anything 最擅长的 |
| **B 确定性 IO** | 只读本地文件/参数固定 | `built-in-playlists` 读取、fx autosave 读写、`app/version`、`cover` 代理的头部、`lyric` 缓存命中 | ✅ 录，用临时目录 fixture |
| **C 活网络** | 打上游、有时效签名、结果随时间变 | `search`、`song/url`（会过期）、`spotify/*`（CDP 依赖外部客户端）、`qishui` 扫码 | ❌ **不录字节级**。改用**结构断言**（status + 字段形状 + 错误码），或录"上游响应样本 → 本地回放"。`record` 只对同一台机器两次运行做 diff，管不了"一周后上游变了" |

> 这条分级是本章最重要的一句：**把录制集中在 A 级，B 级少量，C 级换成契约快照**。否则你会得到一堆一周后就红的用例，然后开始怀疑工具，最后把它删掉。

### 6.4 落地步骤（以 `server/kugou-api.js` 为例）

```bash
# 0) 装工具（Node 22 已就绪；不需要先装 Rust 才能 analyze）
npm i -g rust-anything

# 1) 计划：哪些函数能桥、哪些留在 JS、按什么波次搬
rust-anything analyze server/

# 2) 生成 crate + 桥（把纯函数摘出来，JS 侧 API 不变）
rust-anything bridge server/ server/kugou-api.js --batch

# 3) 录制：生成的边界用例 + 语义陷阱 + 你给的真实输入
rust-anything record <crate> --inputs ztest/ra/kugou-samples.jsonl

# 4) 让 agent（或你自己）按 crate 的 TASK/说明把函数写成 Rust
#    产物落 crates/mineradio-core/src/... 或 crates/mineradio-providers/src/...

# 5) 比对 → 不一致就改，直到全绿
rust-anything diff <crate>

# 6) 补洞：用新种子找录制漏掉的路径，把有价值的用例 --keep 回去
rust-anything fuzz <crate> --time 60 --keep

# 7) 收尾闸门：fmt + clippy -D warnings + 测试 + unsafe 审计 + 无未移植项
rust-anything gate <crate>

# 8) 可选：性能账（写进 release notes 用）
rust-anything bench <crate>
rust-anything report
```

**产物落位约定**（避免工具产物和产品代码打架）：

| 工具产物 | 位置 | 是否提交 |
|---|---|---|
| 生成的 crate 骨架、`cases.jsonl`、`recorded-from.json` | `ztest/rust-anything/<unit>/` | ✅ 提交（用例就是回归资产） |
| 最终 Rust 源码 | `crates/mineradio-core` / `mineradio-providers` | ✅ 提交 |
| napi 桥产物（`*.node`、`index.cjs`） | `ztest/rust-anything/<unit>/dist/` | ❌ gitignore（脚手架） |
| `.rust-anything.bak` | 由 `setup` 生成 | ❌ gitignore |

### 6.5 与 Tauri 的接缝（最关键的一段）

**napi 桥的寿命 = 到 P6 为止。crate 是永久资产。**

```
P2/P3 阶段：Electron(旧 server) --napi--> Rust crate   ← 用 diff/shadow 证明一致
P2/P3 阶段：axum(Rust) -----------------> Rust crate   ← 同一个 crate，无桥
P6 阶段    ：删掉 napi 桥、删掉 Electron，crate 原样留下
```

具体做法：
- `bridge` 生成的 crate **不放在 `ztest/`**，而是直接生成到 `crates/mineradio-core`（或先 `ztest/` 验证再提升）；
- axum handler 只做三件事：取参、调 crate、映射错误码 —— **业务逻辑一行都不许写在 handler 里**，否则录制覆盖不到；
- `gate` 要求"没有未移植项"，对故意留在 JS 的函数用 `--keep "name: reason"` 显式声明，理由写进 `docs/API-CONTRACT.json`。

### 6.6 试点（一天内判死活，别拖到 P2 中段）

按顺序做四件事，任一失败就降级方案（见 6.8）：

1. `rust-anything analyze server/` 能出计划表 → 说明它能读懂这套代码结构（含 `require('NeteaseCloudMusicApi')` 这类 npm 依赖）。
2. 挑一个**纯函数**模块（`server/qq-vip-api.js` 的权益判定 或 `kugou` 签名）跑通 `bridge → record → diff` → 说明录制链能跑。
3. 把 `.node` 在 **Electron 45 主进程**里 `require` 一次 → napi-rs 走 Node-API（ABI 稳定），理论上不用重编；但本仓库有 `node-hid` 需按 Electron ABI 重编的先例（`asarUnpack`），**必须实测**。
4. `gate` 能在该 crate 上通过 → 说明能进 CI。

### 6.7 卫生红线（不做这几条会出事）

1. **`record` 会真跑原代码、真发网络请求、真写文件。** 只能在**仓库副本 + 空 `userdata` + 假凭据 + 代理指向 mock** 下跑。绝不允许指向生产 `userdata`（会触发 §5.3 的主密钥覆写事故）。
2. `app record`/`app replay` 的 `--effects http,smtp` 会记录对外请求 —— 网易云/Spotify 的 token 可能落进 `cases.jsonl`。提交前必须 `grep` 一遍 token 形状，或用 `scripts/check-secrets.sh` 同类逻辑过滤。
3. 上游代码一改，`recorded-from.json` 指纹变化 → `diff` 报警、`gate` 失败。这是**特性不是 bug**，别绕过；重录即可。
4. 工具是单人维护的活跃项目（v4.0.0，MIT）。**不把它的运行时写进产品依赖**；只在 `devDependencies`/CI 里出现。哪天它停更，我们损失的是"重录脚本"，不是产品。

### 6.8 万一不可用（退路，提前写好）

| 失败点 | 退路 |
|---|---|
| `analyze` 读不懂（`require` 动态路径、`eval`） | 手工排顺序（§7 P2 已给顺序） |
| `record` 跑不起来（模块顶层就要 electron） | 用 `ztest/electron-stub.js` 做 `require('electron')` 桩，或退到纯函数级手工 fixture |
| `.node` 在 Electron 里崩 | 放弃 `shadow` 灰度，只保留"crate + Rust 单测 + 契约快照" |
| `gate` 太严（`clippy -D warnings` 与既有风格冲突） | 只在 `crates/*` 上跑，`src-tauri` 用项目自己的 lint 配置 |
| 工具完全不可用 | **自建最小录制**：`ztest/contract/` 里存 `/api` 请求/响应样本（`{req, res}` JSONL），Rust 侧 `cargo test` 回放。功能是 rust-anything 的子集，但零依赖 |

---

## 7. 阶段 P0~P6

**每阶段五道闸门**（全绿才算完成）：

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
npm run contract:check      # 从 P0 起，已接进 ci.yml
npm run hash:check          # public/ 逐字节不动，已接进 ci.yml
# rust-anything gate <crate>          # P2 起
```

| 阶段 | 目标 | 主要交付物 | 止损条件（触发即停下来重估，不硬推） |
|---|---|---|---|
| **P0 准备** | 工具链 + 契约冻结 | Rust ≥ 1.90（Tauri 2.12 的 MSRV）+ MSVC Build Tools + Tauri CLI；`tauri-rewrite` 分支；`API-CONTRACT.json`；`PUBLIC-HASHES.txt`；`analyze` 排序表；v3.3.0 四道闸门基线数字 | Rust 装不上/CI 无法缓存 → 先解决环境，别开写 |
| **P1 壳** | **首页能渲染** | axum 静态 + 空 `/api` 桩 + `/internal`；Tauri 窗口指向 `127.0.0.1`；shim 116 方法返回 `{ok:false,reason:'NOT_IMPLEMENTED'}`；`isDesktop`/`systemRelease` 正确 | **three.js 白屏 / 字体缺失 / CSP 拦截 / WebAudio 静默失败** 任一不解 → 立即评估"是否换 WebView 方案"，这是全局止损点 |
| **P2 服务端 parity** | 按文件搬（不是按路由搬，`server.js` 自己就 6,957 行） | `mineradio-providers` + axum handlers + `cases.jsonl` 回归集；起点见 7.1.1 | A 级录制 < 60% 通过且改不动 → 降级为契约快照，继续但记录缺口 |
| **P3 桥 parity** | 116 方法可用 | `commands/` + `events/` + 文件拖入路径方案；同步 XHR 打通 | 同步 XHR 被禁 → 走 5.2.4 备选（丢 fx 持久化），并记录为已知回归 |
| **P4 原生 parity** | Windows 行为一致 | `mineradio-native` + 桌面模式 + 壁纸宿主 | 完整桌面模式无法在 2 周内稳定 → 把该功能标灰、v1 不带它发（需用户拍板） |
| **P5 发布链** | 能装能升 | NSIS 自定义模板（7 语言页）、`tauri-plugin-updater` 新密钥、CI 矩阵、`NOTICE.md` | updater 签名/多镜像不通 → 先做手动下载更新，自动更新延后 |
| **P6 切换** | 正式版 | 双壳并行 QA，`main` 切 Tauri，Electron 归档 tag | 出现 P4 级回归 → 回滚到 v3.3.0，修完再切 |

### 7.1 P0 立刻可执行（8 条）

> ✅ **2026-11-24 已装好**：Rust 1.100.0（stable-x86_64-pc-windows-msvc）、rustup 1.29.3、MSVC Build Tools 2022
> 17.14.45（`E:\VS2022BuildTools`）+ Windows SDK 10.0.26100、tauri-cli 2.12.6、rust-anything 4.0.0、
> cargo-deny 0.22.0、tauri-driver 2.1.0；WebView2 157.0.4341.60 系统自带。
> `tauri info` 全绿；`cargo build` 调 Win32 API 的二进制链接运行通过。重装细节见 `memory/topics/tauri-rewrite-toolchain.md`。
> 下面 1~3 条留作换机/重装时的参考。

1. 装 Rust：`static.rust-lang.org` 下载 rustup-init（12 MB，约 100 KB/s），再用
   `RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static` 拉工具链；`rustup component add llvm-tools-preview`
2. 装 VS Build Tools（**需要管理员**）：`winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --norestart --installPath E:\VS2022BuildTools --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`；
   ⚠️ 提权时 `-ArgumentList` 必须传**单个字符串**，传数组会把 `--override` 拆坏
3. `npm i -g @tauri-apps/cli@^2 rust-anything cargo-deny tauri-driver`（npm 那两行走 `registry.npmmirror.com`）
4. ✅ `NODE_OPTIONS="" npm run test:ci` → **194 passed / 0 failed / 61s**（v3.3.0 基线，比 v3.1.0 的 180 多了 14 条商籁与前端断言）
5. ✅ `git switch -c tauri-rewrite` + 远端分支已建（`origin/tauri-rewrite`）
6. ✅ `scripts/contract-extract.js` → **`docs/API-CONTRACT.json`**：
   **125 路由 / 116 桥顶层键 / 130 摊平桥项 / 10 事件**（原方案写"~12 事件"是估的，实测 10）。
   同时校验前端：`public/js` 的 103 条 `/api/` 字面量**全部**能对上路由，0 条悬空。
7. ✅ `scripts/public-hashes.js` → **`docs/PUBLIC-HASHES.txt`**：**169 个文件 / 18.94 MB**
   （方案里的 155 是 `.js/.css/.html` 子集；这里含 `public/vendor/` 的 gif、bin、json）。
8. ✅ `rust-anything analyze server/ --json` → 19 个单元的 wave/readiness 排序已写入
   `docs/API-CONTRACT.json` 的 `portOrder`（`portOrderSource` 记录工具版本 4.0.0）。

> 两个脚本没放 `ztest/`：**`ztest/` 整个被 `.gitignore` 忽略**，放那儿 CI 拿不到。
> 落在 `scripts/contract-extract.js` / `scripts/public-hashes.js`，各带 `--check` 模式，
> 已经接进 `.github/workflows/ci.yml`（`npm run contract:check` / `npm run hash:check`）。

#### 7.1.1 `analyze` 给出的搬运顺序（实测，非拍脑袋）

| # | 单元 | LOC | wave | readiness | 结论 |
|---|---|---|---|---|---|
| 1 | `static-assets.js` | 89 | 0 | 96 | **ready**，纯 MIME/路径拼接，第一块下手的对象 |
| 2 | `spotify-cdp-bridge.js` | 238 | 0 | 92 | ready |
| 3 | `qishui-audio-decryptor/` | 333 | 0 | 81 | ready（解密是纯算法，录得最干净） |
| 4 | `apple-music-lyrics.js` | 233 | 0 | 68 | ready |
| 5 | `qq-vip-api.js` | 753 | 0 | 59 | ready |
| 6 | `qishui-client-bridge.js` | 651 | 0 | 42 | **blocked**：字符串下标 10 处 + 正则方言 3 处 + 动态代码 1 处 |
| 7 | `spotify-partner.js` | 551 | 0 | 40 | caution |
| 8 | `qishui-auth-v6.js` | 574 | 0 | 38 | caution |
| 9 | `dj-analyzer.js` | 813 | 0 | 37 | caution（Float 运算，逐位比对会翻车，见 6.3） |
| 10 | `kugou-api.js` | 2,166 | 0 | 0 | caution（签名/加密密集） |
| 11 | `qishui-auth-v6/` | 279 | 0 | 0 | **keep-in-js**：它是渲染层 UI，工具自己判定不该搬 |
| 12 | `dj-worker.js` | 64 | 1 | 87 | ready |
| 13 | `dj-analyzer-host.js` | 138 | 1 | 85 | ready（依赖 `utilityProcess`，Rust 侧直接走 rayon 线程池） |
| 14 | `qishui-qr-login.js` | 169 | 1 | 82 | ready |
| 15 | `apple-music-api.js` | 386 | 1 | 61 | ready |
| 16 | `spotify-cdp.js` | 692 | 1 | 45 | caution |
| 17 | `qishui-api.js` | 3,702 | 1 | 0 | caution（最大单体之一） |
| 18 | `spotify-api.js` | 2,439 | 1 | 0 | caution |
| 19 | `server.js` | 6,957 | 2 | 0 | caution（分发层，最后搬） |

**与方案第 3 章的差异**：`server.js` 自己就是最大的一块（6,957 行），说明"先搬 Top30 路由"这个切法不对 ——
路由的处理体大量内联在 `server.js` 里，按文件切比按路由切更合理。P2 的第一刀改成
**`static-assets.js` → `qishui-audio-decryptor` → `apple-music-lyrics` → `qq-vip-api`** 这四块。


### 7.2 P1 的"第一刀"（唯一目标：证明能渲染）

不要一上来搬业务。写 400 行以内的壳：

1. axum 起 `127.0.0.1:0`（系统分配），打印实际端口；
2. 静态服务 `public/`，`index.html` 能 200；
3. Tauri 窗口 `url` 指向 `http://127.0.0.1:<port>/?startupAttempt=1`；
4. shim 注入 `window.desktopWindow`，116 方法统一返回 `NOT_IMPLEMENTED`；
5. 截图对照：首页、歌单面板、桌面歌词窗（透明 + 无边框）。

**这一步渲染不出来，后面全部无意义。** 具体看四个点：`three.js` 着色器编译、`backdrop-filter` 玻璃效果、`@font-face` 本地字体、WebAudio 初始化。

#### P1 进度（2026-11-24）

| # | 项 | 状态 |
|---|---|---|
| 1 | axum 绑 `127.0.0.1:0`、打印实际端口 | ✅ `crates/mineradio-server`，`ServerHandle::url()` |
| 2 | 静态 `public/` 能 200 | ✅ 实测：`index.html` 200（182,287 B）、它直引的 **23** 个本地资源全 200、`index-loader` 引的 **124** 个模块全 200 |
| 3 | 窗口 url 指向本地服务 | ✅ `src-tauri/src/main.rs`（`?startupAttempt=1`） |
| 4 | shim 注入 116 方法返回 `NOT_IMPLEMENTED` | ✅ 由 `scripts/gen-shim.js` 生成，顶层键 **116**、桥项 **130**、`npm run shim:check` 进 CI |
| 5 | 截图对照 | ⏳ 需要开窗肉眼确认（three.js / 玻璃 / 字体 / WebAudio） |

P1 比原计划多做的两件事（都有明确理由）：

- **`/api` 桩返回 501 + JSON 而不是 404**：前端大量代码是 `fetch(...).then(r => r.json())` 再按字段分支，
  404 会变成"接口不存在"的假象，501 + `{ok:false, reason:'NOT_IMPLEMENTED', path}` 才能让它走自己的错误分支。
- **Host / `Sec-Fetch-Site` / `/internal` token 三道守卫**：Electron 时代"只有自家窗口会访问这个端口"是隐式成立的，
  换成 WebView2 + 本地 HTTP 后任何本机网页都能敲，必须显式挡住。

已知风险（都在开窗那一刻才暴露）：`public/index.html` 直连 `https://fonts.googleapis.com`，
断网时字体回退会改变排版观感，别误判成"样式坏了"。

---

## 8. 测试策略

四层，各管一段，不重叠：

| 层 | 内容 | 数量目标 | 跑在哪 |
|---|---|---|---|
| **L1 录制用例** | `cases.jsonl`（A/B 级）+ 契约快照（C 级） | A 级模块 100% 覆盖；Top 30 路由有快照 | `cargo test -p` / `rust-anything diff` |
| **L2 Rust 单测** | crate 内部逻辑、错误分支、脱敏规则 | 每个 pub fn 至少 1 条 | `cargo test --workspace` |
| **L3 契约守卫** | `public/` sha256 + `/api` 字面量双向比对 + `desktopWindow` 方法数 = 116 | 3 条脚本 | CI |
| **L4 e2e 冒烟** | 启动 → 搜索 → 播放 → 歌词 → 桌面歌词 → 壁纸 → 退出 | 1 条主链 + 3 条分支 | `tauri-driver` + msedgedriver（Windows） |

**明确放弃**：把 204 个源码字符串断言移植成 Rust。它们在 Electron 侧防的是"有人手滑改了 `.js`"，Rust 侧换语言后前提消失，重新写等于复制噪音。`docs/GUARD-LEDGER.md` 转只读。

---

## 9. 构建与发布

### 9.1 安装器（最容易被低估的一块）

现状：`build/installer.nsh` **1,222 行**，含**自定义语言选择页**（7 语言：简中/繁中/港繁/英/西/日/俄），选中后写 `userdata/.installer-language`，主进程 `getInstallerLanguage()` 读取并决定首启语言。

Tauri 的 NSIS 由 Handlebars 模板生成。**加钩子（`NSIS_HOOK_PREINSTALL`）改不了页面结构** —— 要保留这个语言页，必须：

| 做法 | 说明 |
|---|---|
| `bundle.windows.nsis.template` → 自定义 `installer.nsi` | 复制 Tauri 默认模板，在欢迎页前插入语言选择页（`nsDialogs`），其余逻辑照抄 |
| 复用现有 `installer.nsh` 的业务逻辑 | 目录校验、快捷方式、卸载保留 userdata 等，逐段搬进自定义模板 |
| 7 语言字符串 | Tauri 自带 `SimpChinese/TradChinese/English/Spanish/Japanese/Russian`，但 `zh_TW` 与 `zh_HK` 需自定义 `LangString` |

验收：安装包在 7 种语言下都能选、装完首启语言正确、卸载不删 `userdata`。

### 9.2 WebView2 运行时

`bundle.windows.webviewInstallMode`：

| 模式 | 适用 | 建议 |
|---|---|---|
| `downloadBootstrapper`（默认） | 有网环境 | 体积最小，但国内网络下载 `msedgewebview2` 可能失败 |
| `embedBootstrapper` | 有网、怕下载失败 | ⏩ **推荐**：引导程序内嵌，约 +1.8 MB |
| `offlineInstaller` | 完全离线 | +约 130 MB，安装包翻倍 |
| `fixedRuntime` | 需锁定内核版本 | 体积最大，但能规避"用户系统 WebView2 太旧" |

Win11 自带 WebView2；Win10 绝大多数有。v1 目标 Win x64 → 用 `embedBootstrapper` + 安装失败时给明确提示（别静默退出）。

### 9.3 更新

- `tauri-plugin-updater`，Ed25519 密钥**新生成**（与旧 electron-builder 签名不通用）。
- 发布物：`latest.json`（不是 `latest.yml`）+ `.nsis.zip` + `.sig`。现有 `archive-release` / `verify-package` / `SHA256SUMS` 脚本要改写。
- 多镜像：`plugins.updater.endpoints` 支持数组，保留现有镜像顺序与回退。

### 9.4 CI 14 条流水线映射

| 现有 workflow | 处置 |
|---|---|
| `ci.yml` | 改：`npm test` → `cargo test --workspace` + `npm run check:quick`（旧分支跑） |
| `windows-build.yml` | 改：`electron-builder` → `tauri build` |
| `release.yml` | 改：`latest.yml` → `latest.json` + 签名 |
| `release-dry-run.yml` | 改：同上，只构建不发布 |
| `electron-integration.yml` | 删 → 由 L4 e2e 替代 |
| `qa.yml` | 保留（QA 脚本仍在旧分支跑） |
| `codeql.yml` | 改：加 `rust` 语言 |
| `npm-audit.yml` | 保留（`public/` 仍有 vendor 依赖）+ 新增 `cargo-deny` |
| `dependency-review.yml` | 保留 |
| `package-integrity.yml` | 改写为产物校验 |
| `pr-governance.yml` `actions-security.yml` `coverage.yml` `scheduled-integration.yml` | 基本保留，`coverage` 换 `cargo-llvm-cov` |

### 9.5 许可

- 产品仍是 **GPL-3.0-or-later**；`public/` 里两个 AGPL 模块（流光/商籁）原样保留，靠 GPLv3 §13 组合 —— **不许再写 "clean-room"**（见用户级记忆与本仓库 `NOTICE.md`）。
- 新增 `cargo-deny`：`licenses` 白名单 + `bans` 重复版本 + `advisories`。
- `NOTICE.md` 增补 Rust 依赖清单（Tauri/axum/tokio/windows 等）。

---

## 10. 风险登记册

| # | 风险 | 影响 | 处置 | 验收 |
|---|---|---|---|---|
| **R1** | 凭据不可迁移 | 用户需重登 6 平台 | D3：检测旧 key，只提示不导入 | 新装 6 平台全通；旧用户重登后设置/歌单/曲库都在 |
| **R2** | WebView2 ≠ Chromium | 白屏/特效失效/音频异常 | P1 先做渲染冒烟；把 three.js、backdrop-filter、WebAudio、透明歌词窗列为必测 | 截图逐页对照 v3.3.0 |
| **R3** | 测试网几乎全废 | 回归无网 | L1 录制 + L3 契约守卫 | A 级模块录制全覆盖；Top 30 路由有快照 |
| **R4** | 原生能力缺失 | 圆角/DWM/HID 回归 | windows-rs 逐项重写，每项有可观测验收 | §5.4 表逐行过 |
| **R5** | 完整桌面模式（106 KB 单体）| 切进/切出残留、Explorer 异常 | 单独一个子阶段，先做最小可用（图标层 + 壁纸底图），不做花活 | 进出 20 次无残留进程/窗口 |
| **R6** | 文件拖入路径拿不到 | 本地曲库导入失效 | `onDragDropEvent` 队列 + 对话框降级 | 拖文件夹能导入能播 |
| **R7** | 安装器自定义页迁移 | 装完语言错/装不上 | 自定义 NSIS 模板（§9.1） | 7 语言安装矩阵 |
| **R8** | napi 桥在 Electron 里 ABI 不兼容 | `shadow` 灰度不可用 | 试点第 3 步实测；不行就放弃灰度 | `.node` 能被 Electron 45 require |
| **R9** | rust-anything 停更/不适用 | 少一把尺子 | 产物是普通 crate；退路见 6.8 | 去掉工具后 `cargo test` 仍全绿 |

---

## 11. v1 验收清单（DoD）

- [ ] `tauri build` 产出 `Mineradio-<ver>-Setup.exe`，7 语言可选，装完能启动
- [ ] `public/` sha256 与 v3.3.0 完全一致（0 处改动）
- [ ] 125 条 `/api` 路由全部有 Rust 实现，Top 30 有契约快照且全绿
- [ ] 116 个 `desktopWindow` 方法全部可用，前端控制台零 "非桌面环境" 报错
- [ ] 6 平台登录（网易云/QQ/酷狗/汽水/Spotify/AM）全通；旧用户重登后数据不丢
- [ ] 桌面歌词窗透明、无边框、可拖动、歌词跟随
- [ ] 壁纸引擎：列表、启停、拖动跟手、最小化即停、退出无残留
- [ ] 本地曲库：拖入文件夹 → 导入 → 播放 → 重启仍在
- [ ] 圆角/全屏/最大化在 Win10 与 Win11 均正常
- [ ] 自动更新能从这里一版升到下一版（含镜像回退）
- [ ] `cargo test --workspace` + `clippy -D warnings` + `cargo-deny` + L3 契约守卫全绿
- [ ] `NOTICE.md` / `docs/THIRD_PARTY_PORTS.md` 更新完毕
- [ ] Electron 代码归档在 tag `v3.3.0-electron-final`，可一键回滚

---

## 附录 A：125 路由清单（按域，P2 搬运顺序）

`app` → `cover` / `audio` → `lyric` → `search` → `song` → `album` → `artist` → `playlist` → `user` → `login`(网易云) → `qq` → `kugou` → `podcast` → `discover` → `weather` → `listen` → `beatmap` → `custom-source` → `cuefield` → `update` → `apple-music` → `qishui`（需 WebView2 扫码）→ `spotify`（CDP，最后）

理由：前 6 组是纯转发/纯解析，最容易验证；最后两组依赖外部客户端，风险最高。

## 附录 B：116 方法分组（P3 搬运顺序）

窗口/系统 → 缓存 → 本地曲库/内置歌单 → 导入导出 → 登录 → 自定义音源 → 更新 → Apple Music → 游戏模式 → 桌面模式/图标 → 壁纸引擎（最重，最后）

## 附录 C：生产依赖替换对照

| 现依赖 | 用途 | Rust 替代 |
|---|---|---|
| `NeteaseCloudMusicApi` | 网易云 weapi/eapi 全套 | 自实现：`aes` + `rsa` + `reqwest`，按 API 逐个对拍 |
| `music-metadata` | 本地曲库读标签 | `lofty` |
| `mpg123-decoder` | `dj-analyzer` 解 MP3 做节奏分析 | `symphonia`（mp3 feature）或 `minimp3` |
| `node-hid` | Halo PixelBar | `windows` crate HID API |
| `qrcode` | 汽水登录二维码 | `qrcode` crate |
| `gsap` | 前端动画 | 不动（`public/vendor/`） |

## 附录 D：P0 一次性脚本产物

| 脚本 | 产物 | 校验方式 |
|---|---|---|
| `ztest/extract-contract.js` | `docs/API-CONTRACT.json` | CI 比对 `public/js` 字面量集合 == 契约集合 |
| `ztest/hash-public.js` | `docs/PUBLIC-HASHES.txt` | `sha256sum -c` |
| `ztest/ra/kugou-samples.jsonl` 等 | 录制输入样本 | 人工审阅（不含 token） |
