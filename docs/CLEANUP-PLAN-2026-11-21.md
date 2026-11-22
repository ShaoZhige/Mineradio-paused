# 清理与守卫精简 · 策划（2026-11-21）

> 状态：**执行中**。A 阶段已完成（2026-11-21 13:30），B~F 待做。本文只做计划与盘点，
> 至今未删除任何代码。
> 前置约定：先补日志 → 再做功能测试兜底 → 观测一段时间 → 才动清理。

---

## 0. 一句话结论

代码不是"太脏"，而是**守卫（静态断言类测试）占比过高**：189 个测试文件里 110 个是纯源码字符串断言，
`scripts/quick-check.js` 又有 8931 行 / 50 个检查项，并且其中 **重跑了一遍 `tests/` 里约 40 个文件**。
清理的重点应该是"把静态守卫降级为行为守卫"，而不是单纯删代码；死代码量不大（零引用候选 46 个）。

---

## 1. 现状基线

| 项 | 数值 |
|---|---|
| `public/js/modules` 模块 | 123 个文件 / 71,464 行（未登记进 loader：**0**） |
| 顶层函数（public + server + desktop + scripts） | 5,049 |
| 零引用候选函数 | **46** |
| 测试文件 | 189（865 个用例 / 35,320 行） |
| 其中：纯源码断言（`readFileSync` 且不执行被测代码） | **110** |
| 其中：vm / 真跑被测模块（行为型） | 41（mixed 44、behavioral 35） |
| 其中：只做 `.includes()` 的纯文本断言 | 5 |
| `scripts/quick-check.js` | 8,931 行 / 50 个 `check*` / ~966 处断言 |
| 生产代码里的防御式守卫 | `typeof X === 'function'` 806 处、空 `catch` 162 处 |
| 闸门 | `test:ci` 189/189、`check:quick` 全过（当前基线） |

---

## 2. 原则与红线

1. **顺序不可颠倒**：日志 → 功能测试 → 观测 → 清理 → 回归。清理阶段任何一批改动都必须能单独回滚。
2. **每批 ≤10 个文件**，改完立刻 `node --check` + `test:ci` + `check:quick`；红一条就停。
3. **不碰的东西**：`safeStorage` 凭据链路、`build/` 打包脚本、`NOTICE.md` / 许可证、发布动作。
4. **删除的唯一理由**是"零引用 + 无动态派发 + 有替代路径"，不是"看起来没用"。
5. **提交粒度**：一个阶段内的一批清理 = 一个提交单元；不混合守卫精简与功能改动。
6. 不擅自 `git push`、不改用户数据目录。

---

## 3. 阶段 A — 日志完善（先做这一块）

### A1 现状

| 文件 | 覆盖 |
|---|---|
| `userdata/app.log` | 主进程 `console.error/warn` 全量镜像（服务端 99 处错误路径自动留痕） |
| `userdata/renderer.log` | 渲染进程：未捕获异常、未处理 Promise 拒绝、AM 起播失败、歌单目录页失败、AM 登录态 |
| `userdata/apple-music.log` | companion 每次请求（operation/耗时/重试/错误/**playbackStage**）、实例拉起与更替、宿主诊断 |

### A2 缺口（本阶段要补）

| 区域 | 要补的事件 | 为什么 |
|---|---|---|
| 播放（非 AM） | `playback.local-failed`（url 解析/解码/DRM 失败）、`playback.switch-aborted` | "某些歌放不出来"目前无迹可循 |
| 队列 | `queue.hydrate-failed`、`queue.tail-empty` | 列表续页失败会静默停在半截 |
| 歌词 | `lyric.fetch-failed`（provider/原因）、`lyric.parse-empty` | 三个歌词样式的"没歌词"要能定位到源头 |
| 登录 | 每个平台的 `account.status`（loggedIn/error，不含 token） | 只有 AM 有；其它平台掉线查不到 |
| 自定义音源 | `source.script-error`、`source.resolve-failed` | 脚本宿主异常目前只在控制台 |
| 主进程窗口 | `window.state`（fullscreen/maximized/radius 变化） | 圆角/全屏这类"偶发"问题需要时间线 |
| 壁纸 | `wallpaper.start/stop/fail`（迁到统一模块或保留独立文件） | 已有独立日志，需与统一格式对齐口径 |

### A3 事件规范

- `logger.event('<scope>.<type>', { ...字段 })`，scope 用 `playback|queue|lyric|account|source|window|wallpaper|apple-music`。
- 字段只放**可枚举的短值**（id 用前 12 位、错误码用字符串枚举、耗时用 ms）。
- **脱敏红线**：不写 cookie / token / 完整 URL query / 用户目录绝对路径 / 歌曲名与歌词原文（隐私）。

### A4 容量

统一 512KB 滚动一份 `.1`；新增子系统各自一个文件（`playback.log` 等），避免 `app.log` 被刷爆。

### A5 验收

- 冒烟清单里每条失败路径都能在日志中找到**一条**对应记录；
- 日志写入不影响帧率（采样 60s，主线程无 >16ms 长任务由日志引起）；
- `tests/logging.test.js` 仍全绿，新增各 scope 的字段脱敏用例。

---

### A6 完成情况（2026-11-21）

| 事件 | 落点 | 状态 |
|---|---|---|
| `playback.start-failed` | `11-provider-fallback.js` 的 `handlePlaybackUnavailable`（所有平台共用） | ✅ 已实测落盘 |
| `queue.page-failed` | `03-podcast-playlist-loaders.js` 续页 catch | ✅ |
| `lyric.unavailable` / `lyric.fetch-failed` | `00-lyrics-fetch-parse.js`，区分 `no-lyric-upstream` 与 `parse-empty` | ✅ |
| `account.status`（5 个平台） | `02-login-status.js` 的 `noteAccountStatus()`，**仅变化时**写 | ✅ |
| `account.apple-music-status` | 上一轮已加 | ✅ |
| `source.list-failed` / `resolve-failed` / `init-skipped` | `20-custom-source.js` + `main.js` | ✅ |
| `window.state` | `04-desktop-overlay-fullscreen.js` 的 `applyState`，仅切换时 | ✅ |
| 壁纸 start/stop/fail | 已有独立日志文件，**暂不迁移**（避免破坏既有解析方） | ⏸ |

- 事件目录与脱敏红线：`docs/LOGGING.md`；守卫：`tests/logging-coverage.test.js`（7 条，含"日志里不许出现 token/cookie/URL"）。
- 实测：`ztest/logging-probe.js` 直接调 `handlePlaybackUnavailable()`，确认
  `{"scope":"playback","event":"start-failed","provider":"netease",…}` 真的落盘。

---

## 4. 阶段 B — 功能测试兜底（清理前的安全网）

### B1 冒烟清单（每项都要"真跑一遍并看日志"）

| 路径 | 验证点 | 现成工具 |
|---|---|---|
| 本地曲库播放 | 起播、切歌、单曲循环、列表循环、拖进度 | 手动 |
| Apple Music 播放 | 冷启动首曲、切歌、播完自动下一首、单曲循环 | `ztest/am-track-end-probe.js` 等 |
| 歌单目录 | 首次加载、重复打开（命中缓存）、曲目数补齐 | 手动 + 日志 |
| 歌单详情 | 首页 + 续页、队列水合 | 手动 |
| 登录 | AM 登录/掉线恢复、其它平台状态 | 手动 |
| 视觉 | 圆角 0/20/80/120、DIY 面板开关、右下角圆钮避让 | `ztest/diy-corner-avoid.js`、`ztest/fx-fab-toggle-probe.js` |
| 壁纸 | 启停、最小化、退出清理 | 手动 |
| 崩溃恢复 | 主窗口 reload 后自定义音源仍生效 | `tests/custom-source-frontend-wiring.test.js` |

### B1-a 已自动化验证（2026-11-21 13:40，QA 实例）

| 路径 | 探针 | 结果 |
|---|---|---|
| AM 拉起门禁（未登录不拉起 / 缓存登着补验 / TTL / force） | `ztest/am-spawn-gate-probe.js` | 4 项全 PASS |
| AM 播完自动切歌 + 单曲循环 + 中段暂停不误判 | `ztest/am-track-end-probe.js` | 3 项全对 |
| DIY 圆钮点击开关（含悬停抑制与解除） | `ztest/fx-fab-toggle-probe.js` | 7 步全对 |
| 右下角圆钮/隐藏按钮避让（R=20/80/120） | `ztest/diy-corner-avoid.js` | bite 全 0、inside 全 true |
| 渲染日志落盘（含真实失败入口） | `ztest/logging-probe.js` | `playback/start-failed` 已落盘 |

> ⚠️ 探针本身有时序坑：`am-spawn-gate-probe` 早期版本只等 `refreshAppleMusicLoginStatus`，
> 模块未全部加载时会 `normalizeAppleMusicLoginStatus is not defined`（假故障）。已改成同时等两个。

### B2 通过标准

上述每条路径至少**跑通一次并留下日志**，把结果记进 `docs/CLEANUP-PLAN` 的附录（一次即可，不要求自动化）。

---

## 5. 阶段 C — 观测窗口

- 时长：**1~3 天**正常使用，不刻意构造。
- 产出：从日志里汇总"真实出现过 ≥2 次"的错误事件，形成"值得修的清单"。
- 价值：清理时如果删错了，观测期的日志能第一时间暴露（比等用户报障快）。

---

## 6. 阶段 D — 死代码清理

### D1 零引用候选（46 个，静态扫描：`grep` 全仓仅剩定义处）

| 分组 | 数量 | 代表 | 风险 |
|---|---|---|---|
| `desktop/main.js` | 6 | `prepareWallpaperEngineRendererCapture`、`ensureDesktopShortcut`、`toggleFullDesktopModeInteraction` | 中（IPC/窗口链路，需确认无 `ipcMain.handle` 字符串引用） |
| `server/server.js` | 4 | `fetchWeatherPlaylistSongs`、`tagWeatherPoolSongs`、`filterLikelyPlayableWeatherSongs`、`isLowSignalPodcastItem` | 低（成簇死代码，一起删） |
| 其它 server | 3 | `kugou-api.kugouCookieNickname`、`qishui-api.requestJsonWithMeta`、`extractReleaseDownloadPage` | 低 |
| `07-fx/02-accent-background-controls.js` | 6 | `setCustomBackgroundOpacity`、`setWindowBackgroundOpacity`、`setBackgroundGlassOpacity`、`setCustomBackgroundCrop`、`resetCustomBackgroundCrop`、`setSonicWorkshopColorMode` | **中高**（旧的逐项 setter，可能只剩滑块绑定残留，需确认没有 `oninput="..."` 引用） |
| `05-playback/06-track-detail-lyrics-actions.js` | 4 | `collectAlbumDetailSong`、`collectArtistDetailSong`、`submitDetailComment`、`refreshStageLyricVisualOptions` | 中（详情页功能，先手测再删） |
| `08-account` | 5 | `showUserModal`、`connectLoginProvider`、`requestDualLoginMode`、`readLoginWorkflowConnections`、`parseSpotifyConfigInput` | **高**（登录 UI 链路，必须逐个确认是否被内联 `onclick` 或工作流调用） |
| `06-lyrics` | 4 | `pruneLyricFallbackCaches`、`queuePanelVisibleLimit`、`playlistQueuePageUrl`、`retryPlaylistQueueHydration` | 低 |
| 其它 public | 8 | `openHomeThirdCard`、`searchIntentPrefersQQ`、`removeCustomLyricFont`、`particleBudgetCurrentScale` … | 低~中 |
| `scripts/` | 3 | `quick-check.runSpotifyApiResilienceRegressionCheck`、`check-wallpaper-engine-runtime.overwritePackageScene` | **发现：guard 未接上（见 E1）** |
| `04-shelf` 死守卫 | 7 处 | `setShelfHoverTabVisible`（函数不存在，见 D4） | 功能已失效，需先判定 |

### D2 判定三步（每个候选都要走完）

1. **静态**：全仓 `grep -w <name>`（含 `tests/`、`ztest/`、`index.html`、`scripts/`）仅命中定义处；
2. **动态派发**：确认没有 `window[name]` / `dataset` / 内联 `onclick="name("` / 字符串拼名调用；
3. **功能**：相关冒烟路径跑一遍（D 阶段在 B 之后，安全网已就位）。

### D3 文件级候选

- `public/js/modules` 未登记进 `index-loader.modulePaths` 的文件（现由 `check:quick` 兜，先跑一遍确认结果为空）；
- `scripts/` 下无人引用的脚本（`check-wallpaper-engine-runtime.js` 是否仍被 `package.json` / CI 调用）；
- 确认标准：`grep -rn "<文件名>" --exclude-dir=node_modules` 只有自身。

### D4 "不存在的函数"扫描（已跑，有结果）

做法：抽出全部 `typeof X === 'function'` 的目标名（去重后 **400** 个），与"已定义函数名"求差。

| 结果 | 数量 | 处置 |
|---|---|---|
| 浏览器内置 / 函数形参（误报） | 10 | 忽略（`requestAnimationFrame`、`AbortController`、`done`、`fn` …） |
| **真的不存在** | **1 个函数，7 处调用** | **`setShelfHoverTabVisible`** |

🔴 `setShelfHoverTabVisible` 在 `04-shelf/00-layout-hover.js`（5 处）和
`07-fx/07-bindings-shelf-immersive.js`（2 处）被 `typeof … === 'function'` 守卫着，
但**全仓没有定义**——也就是说这 7 条"把侧架悬停页签收起来"的路径从来没执行过。
它不是"要删的死代码"，而是**功能已经失效却没人发现**：先确认侧架悬停页签现在到底靠什么收起，
再决定是补回函数还是删掉这 7 处守卫（顺便验证侧架交互没坏）。

> 结论：这类扫描值得做成例行检查（每次清理跑一次），因为它能抓出"守卫本身在骗人"的情况。

### D-1 执行结果（2026-11-21 14:05，已过闸门）

删除 7 个零引用函数（server/scripts），共 90 行：

| 文件 | 函数 | 行数 |
|---|---|---|
| `server/server.js` | `extractReleaseDownloadPage` / `isLowSignalPodcastItem` / `tagWeatherPoolSongs` / `fetchWeatherPlaylistSongs` / `filterLikelyPlayableWeatherSongs` | 60 |
| `server/server.js` | `lowSignalText`（删完上面那批后连带变死） | 3 |
| `server/kugou-api.js` | `kugouCookieNickname` | 4 |
| `server/qishui-api.js` | `requestJsonWithMeta` | 15 |
| `scripts/check-wallpaper-engine-runtime.js` | `overwritePackageScene` | 15 |

⚠️ **踩到一处隐性耦合**：`tests/update-external-only.test.js` 用 `serverFunctionSource('extractReleaseDownloadPages', 'extractReleaseDownloadPage')`
的**第二个参数当切片结束标记** —— 死函数被当成了分隔符，删掉测试就红。已把结束标记改成其后一个真实函数
`normalizeManifestUpdateInfo`。这类"测试依赖死代码位置"的耦合以后要留意。

### D-2 执行结果（2026-11-21 14:45）

删除 7 个零引用函数（public，共 67 行）：

| 文件 | 函数 |
|---|---|
| `00-state/12-particle-budget.js` | `particleBudgetCurrentScale` |
| `02-visual/10-lyrics-mask-textures.js` | `makeLyricReadabilityTexture` |
| `05-playback/07-search.js` | `searchIntentPrefersQQ` |
| `06-lyrics/00-lyrics-fetch-parse.js` | `pruneLyricFallbackCaches` |
| `06-lyrics/02-playlist-detail.js` | `queuePanelVisibleLimit` |
| `06-lyrics/03-podcast-playlist-loaders.js` | `playlistQueuePageUrl` |
| `07-fx/03-cover-picker-fonts.js` | `removeCustomLyricFont` |

**三处测试耦合（都已修）：**
1. `apple-music-left-platforms.test.js` —— 又把死函数当**切片结束标记**（和 D-1 同一坑）；
2. `netease-cloud-lyric-fallback.test.js` —— 把 `pruneLyricFallbackCaches` 放进 vm 的待加载函数表；
3. 🔴 `scripts/checks/provider.cjs` 里 **两条守卫断言的是死代码内部实现**
   （`playlistTracksEndpoint(source.provider` 只出现在已删的 `playlistQueuePageUrl` 里）。这类守卫
   保护的是"没人调用的函数"，属于最没价值的一种 —— 已改为断言真正在跑的
   `fetchPlaylistTracksPage(source.provider`。

> 每删一个"零引用"函数，都要顺手 grep 一遍 `tests/` 与 `scripts/checks/`：**死代码经常被当成锚点**。

### D-3 执行结果（2026-11-21 15:20）

删 5 个（26 行）：`loadHomePlatformQishuiRecommendations`、`openHomeThirdCard`、
`refreshStageLyricVisualOptions`、`albumGaplessCurrentTailQuiet`、`queuePanelListKey`。

**✅ `08-account` 已定论（用户确认"面板要"）**：

- `showUserModal` **不是死代码，是入口丢了** —— 已把 `onUserBtnClick()` 改成
  "已登录 → `showUserModal()`（账号/VIP 面板）；未登录 → `showLoginModal()`"。
- 实测（`ztest/user-modal-entry.js`）：未登录 → login 弹窗；已登录 → `#user-modal` 打开、
  名字/头像已填、关闭按钮有效（`closeGsapModal` 有动画，要等 ~700ms 再看）。
- 回归守卫：`tests/account-panel-entry.test.js`（含"面板标记与内部按钮仍在"）。
- 顺带证明：**"零引用"不等于死代码，也可能是入口被删** —— 这条以后写进扫描报告的抬头。

其余 5 个（`connectLoginProvider` / `parseSpotifyConfigInput` / `requestDualLoginMode` /
`readLoginWorkflowConnections` / `writeQQPlaybackVipEvidence`）继续**暂缓**：
`connectLoginProvider` 与 `selectLoginProviderNode` 仍是孤立对，可能同属另一条丢失的链路。

> ⛔ 另暂缓：`18-cuefield-automix-integration.js` 的 `cuefieldRunEqualPowerCrossfade` /
> `cuefieldWaitForMediaTime`（合计 100+ 行，属 automix 未接完的实现）。

---

### D-4 逐条审查结论（2026-11-21 16:20）

| 函数 | 判定 | 依据 |
|---|---|---|
| `parentKeyPath`（windows-game-mode） | ✅ 删 | 3 行路径拼接助手，同文件内联构造，无任何引用 |
| `updateDesktopIconLockControl`（10-shell） | ✅ 删 | 只是 `updateDesktopModeControl` 的别名，后者是活路径 |
| `connectLoginProvider`（08-account） | ✅ 删 | 3 行包装；真正被 `index.html` 的 `onclick="selectLoginProviderNode('xx')"` 调的是**另一个**函数 |
| `requestDualLoginMode`（08-account） | ✅ 删 | 只是 `enableDualAccountView` 的别名（"我两个都要"走后者） |
| `toggleFullDesktopModeInteraction`（main） | ✅ 删 | 渲染端 `toggleDesktopInteraction` 热键已改为切 `wallpaperMode`，不再走这条 IPC；`toggleInteractive` 随之无人调用 |
| `getCurrentFxAutosavePath`（main） | ⏸ 备案 | **有守卫**（`tests/refactor-guardrails.test.js` 断言它存在）；删了要改守卫，收益为零 |
| `ensureDesktopShortcut` / `shouldEnsureDesktopShortcut`（main） | 🔧 **恢复 + 补调用** | 差点误删。它是 **opt-in 桌面快捷方式**（`MINERADIO_CREATE_DESKTOP_SHORTCUT=1`），`package.json` 有 `createDesktopShortcut:false`、守卫也盯着"桌面唯一写入路径"，但**从来没有调用点** —— 功能写了没生效。已在 `app.whenReady()` 里接线（默认 skipped，不写桌面） |
| 壁纸采集 3 个（`isTransient…` / `reset…ForRetry` / `prepare…`） | ⏸ 备案 | 采集流程本身仍是活的（渲染端仍抛 `WALLPAPER_CAPTURE_*`），重试/准备这条支线没接完 |
| cuefield 2 个 | ⏸ 备案 | automix 未接完的实现（100+ 行） |
| 08-account 3 个（`parseSpotifyConfigInput` / `readLoginWorkflowConnections` / `writeQQPlaybackVipEvidence`） | ⏸ 备案 | 登录 UI 可能仍留入口；面板入口刚修好，先观察 |

**工具已升级**：新增 `scripts/dead-code-allowlist.json`，扫描输出变成
「真死 N / 已备案保留 M / 只被语言包 onclick 调用 K」，每条备案必须写理由。
现在：**真死 0 / 备案 9 / 语言包 4**。

### D5 分批

| 批次 | 内容 | 验收 |
|---|---|---|
| D-1 | scripts + server 死代码（低风险，约 10 个） | 闸门 + 服务端冒烟 |
| D-2 | public 低风险 8 个 | 闸门 |
| D-3 | `07-fx` 旧 setter 6 个 | 闸门 + 手动拉滑块 |
| D-4 | `08-account` 5 个 | 闸门 + 登录冒烟（**可能要保留，先判定再删**） |
| D-5 | `desktop/main.js` 6 个 | 闸门 + 打包后手测（dev 版不能验凭据） |

---

## 7. 阶段 E — 守卫精简

### E1 为什么"太多"

| 现象 | 数据 | 后果 |
|---|---|---|
| 静态源码断言占比高 | 110/189 文件 | 改实现（等价写法）就红；抓不到真 bug |
| `check:quick` 巨型单文件 | 8,931 行 / 50 项 | 改一行要读半天；漏改就静默失效 |
| 两道闸门重复 | `quick-check` 重跑 `tests/` 里 **40 个**文件 | 同一用例两处维护，测试改名就断 |
| 已有"挂了但没接上"的守卫 | `runSpotifyApiResilienceRegressionCheck` 定义后**从未被调用** | 给假的安全感 |

### E2 三级分类与处置

| 级别 | 判据 | 处置 |
|---|---|---|
| **A 行为型**（vm / require / 真跑） | 断言的是"跑出来的结果" | **全部保留**，这是回归网 |
| **B 契约型**（键集合、模块登记、默认值漂移、i18n 四语一致） | 断言的是"结构性契约"，改实现也必须遵守 | 保留，但**合并同类**（例如把散落的 i18n 检查收进 1 个文件） |
| **C 文本型**（`src.includes('...')`） | 断言的是"某段源码字符串还在" | 按四问逐条判定，多数降级为行为断言或删除 |

### E3 四问判据（针对 C 类，必须四问都"是"才保留）

1. 如果换成等价实现（变量改名、拆函数、同义写法），它会不会**误报**？会 → 扣分。
2. 它能不能抓到**真实历史 bug**（有据可查）？不能 → 扣分。
3. 有没有**行为型测试**已覆盖同一件事？有 → 删。
4. 删掉后**最坏后果**是什么？如果是"界面少个按钮且没人发现" → 保留。

> 经验值：C 类里约 **六成**只能防"被顺手删掉"，这类用**一次性的代码评审 + 台账**替代更划算。

### E4 台账（新增文件）

`docs/GUARD-LEDGER.md`：每条守卫一行 —— 级别 / 保护的具体故障 / 误报条件 / 最后判定人。
新加守卫必须先登记，否则 `check:quick` 的"守卫纪律"检查直接红（这条本身是 B 级契约）。

### E-3 结论（2026-11-21 15:25）：守卫不缺，缺的是台账

对 5 个"纯 `.includes()`"文件逐个过四问 → **没有一个是纯冗余**，它们编码的都是契约：
桌面锁定后 UI 不得响应鼠标、预设 id 必须与 CSS/JS 一致、退出路径、歌词接线、已移除平台不得复活。
删掉只会丢掉真实保护，所以 **E-3 改为"生成台账"**：

- `node scripts/guard-ledger.js` → `docs/GUARD-LEDGER.md`（自动分类 + 每条断言规模）
- 现状：190 个文件里 **A 行为型 33 / B 契约+行为 94 / B 契约型 24 / C 纯文本 39（708 条）**
- 规矩：新增守卫先在台账里有出处；C 类只在"行为型已覆盖同一件事"时才删（目前没有这种情况）。
- ⚠️ 自省：我自己新写的 `apple-music-track-end.test.js` 也是 C 类（17 条源码断言）——
  行为难驱动时，人都会退化成读源码。这说明 C 类不是"懒"，而是"驱动成本高"的产物。

### E6 执行结果（2026-11-21 14:00）

| 项 | 计划 | 实际 | 结论 |
|---|---|---|---|
| E-2 去掉对 `tests/` 的重跑 | 24 个 `run*` 函数 + 调用 | **已删**：24 个函数（375 行）+ 23 行调用，8,931 → **8,533 行** | ✅ `check:quick` **~60s → 18s**，`test:ci` 仍全跑这些用例 |
| E-1 拆成 `scripts/checks/*.cjs` | 纯搬家 | **完成**（装了 `acorn` 当 devDependency） | ✅ `quick-check.js` 8,533 → **92 行**，检查本体进 `scripts/checks/`（env 2,110 + 五个分组 6,548 行）。**输出逐字一致**（除一处 4.38→4.52ms 的性能数字）。`fail(` 计数 **919 = 919**。 |
| ② `runSpotifyApiResilienceRegressionCheck` 从未被调用 | 接回去 | 该函数已随 E-2 删除；覆盖由 `tests/spotify-api-resilience.test.js`（test:ci 会跑）承担 | ✅ 覆盖率未丢，且不再有"假守卫" |

**E-1 落地细节（2026-11-21 14:30）**

- 用 `acorn`（ES latest）取顶层 `FunctionDeclaration` 的精确 range，不再猜 `}`。
- `main()` **正文逐行改写**：只把 `checkXxx();` 换成 `CHECKS['checkXxx']();`，其余（`App root` 打印、
  `runNodeSyntaxCheck`、`parseCombinedIndexModules`、`scanForbiddenMarkers`、`--electron` 分支）一字不动 ——
  所以执行顺序天然与拆分前一致。
- 两个坑：
  1. 组内 `require('./check-resource-budget')` 搬家后要变 `../`（脚本里做了正则改写）；
  2. 两个测试用**源码文本**断言 quick-check 的接线（`startup-qa-userdata-isolation` /
     `wallpaper-engine-window-close-recovery`），拆分后要读「编排器 + checks/*.cjs」整包，否则误报。
- 验证方式：拆分前后各跑一次 `node scripts/quick-check.js` 并 `diff` 输出（过滤 `duration_ms`），
  只剩一处性能测量差异。

> ⚠️ 备份教训：`/tmp` 在 Git Bash 与 Node 里解析不同（Node 看到的是 `E://tmp`）。回滚时差点用**过期的备份**把已完成的 E-2 一起撤掉。以后备份放仓库内 `.qc-backup.js` 并立刻验证。

---

### E5 具体动作

1. `quick-check.js` 拆分为 `scripts/checks/*.cjs`（每项一个文件），主入口只做编排 —— **不改任何断言内容**，纯搬家，风险最低，先做。
2. 删掉 `quick-check` 里对 `tests/` 的 40 次重跑（`test:ci` 已经全跑），只保留它**独有**的静态契约检查 → 预计减少约 1,500~2,000 行、`check:quick` 也更快。
3. 5 个纯 `.includes()` 测试文件逐个过四问。
4. 把已失效的 `runSpotifyApiResilienceRegressionCheck` **接回去**（它保护的是 Spotify 401/限流，属于真需求）。

---

## 8. 阶段 F — 回归与收尾

- 全量：`test:ci` + `check:quick` +（需要时）`check:package`；
- 冒烟清单再跑一遍（B1）；
- 日志抽样 24 小时无新增异常；
- 输出一份"改了什么/删了什么/守卫台账"的收尾说明。

---

## 9. 风险与回滚

| 风险 | 对策 |
|---|---|
| 删了"看似没用但被内联调用"的函数 | D2 三步判定 + 分批 + 每批单独提交可回滚 |
| 静态守卫删多了，真 bug 漏到线上 | 先补 A 阶段日志，观测期兜底；C 类只删"行为型已覆盖"或"纯装饰"的 |
| `quick-check` 拆文件时漏搬断言 | 搬家前后对比断言条数（当前 ~966 处），必须一条不少 |
| dev 版验证窗口/凭据问题 | 涉及 `safeStorage` 的一律打包后再验 |

---

## 10. 执行顺序

| 顺序 | 阶段 | 产出 | 备注 |
|---|---|---|---|
| 1 | A 日志完善 | 多个 `.log` + 事件规范 | 先做，后面全靠它 |
| 2 | B 功能冒烟 | 一份实测记录 | 不通过就不进 D |
| 3 | C 观测 | 真实错误清单 | 1~3 天 |
| 4 | E-1 搬家 + E-2 去重 | `scripts/checks/*` | 与 D 并行也不冲突 |
| 5 | D-1…D-5 死代码 | 5 个批次 | 每批一个提交单元 |
| 6 | E-3/4/5 守卫判定 | `GUARD-LEDGER.md` | 与 D 穿插 |
| 7 | F 回归 | 收尾说明 | |

**建议第一批先做 `E-1`（quick-check 搬家）+ `E-2`（去掉对 tests 的重跑）**：收益最大、风险最低，
而且能让后面每次跑闸门都更快，等于给整个清理过程提速。
