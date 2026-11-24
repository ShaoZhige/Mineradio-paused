# Mineradio → Tauri 重写方案（2026-11-24）

> 目标：**`public/` 现有 107,547 行 HTML/CSS/JS 逐字节保留**，其余（Electron 主进程、Node 服务、脚本、测试驱动、原生 Windows 助手）全部用 Rust 实现，采用 Tauri 2.x 标准形态。
> 本文是方案与盘点，不是施工记录；动手前先看完 §0 的四个待定决策。
> 基线：Electron 架构终版 v3.3.0（HEAD 随结档提交更新），Electron 45 + electron-builder 26，四道闸门全绿。

---

## 0. 四个必须先拍板的决策

| # | 决策 | 推荐 | 理由 |
|---|---|---|---|
| D1 | 新代码放在哪 | **同一仓库开 `tauri-rewrite` 分支**，`main` 冻结在 v3.3.0（Electron 终版） | 保留历史与发布链路；两套 shell 可长期并行对照；不新建仓库避免资产二次拷贝 |
| D2 | "其余全部 Rust" 的边界 | **v1 允许 C# Apple Music 伴侣与 `cuefield/` 作为独立外部进程**，其余全 Rust | 两者分别是 WebView2 宿主与独立 JS 子项目，硬塞进 Rust 会拖垮主线；先保证主链路可用，v2 再收编 |
| D3 | 已加密凭据怎么办 | **强制重新登录**，不迁移 | 现有 `.credential-key` 是 Electron `safeStorage`（Windows 上按应用身份绑定的 DPAPI），Tauri 新应用身份解不开；强行迁移等于把主密钥导出来，风险远大于让用户重登一次 |
| D4 | 目标平台 | **v1 仅 Windows x64** | 现有壁纸 / DWM / HID / 完整桌面模式全是 Windows 专属；跨平台要先砍功能，属于另一个项目 |

> 这四条任一条改判，§3 的分层与 §5 的阶段都要重排。

---

## 1. 实测基线（不是估计）

### 1.1 保留区：`public/`（107,547 行，逐字节不动）

| 类型 | 行数 | 文件数 | 说明 |
|---|---:|---:|---|
| JS | 83,097 | 133 | 其中 `js/modules/` 124 文件 / 73,621 行 |
| CSS | 20,591 | 19 | |
| HTML | 3,859 | 3 | `index.html` / `desktop-lyrics.html` / 其它 |
| **合计** | **107,547** | **155** | 与用户所说「10.7 万行」一致 |

静态资源：`vendor/` 13 MB（three.js r128、gsap、music-tempo、结巴词典）、`assets/` 1 MB、`locales/` 1.3 MB（7 语言）。
`index.html` 只引用 `vendor/*` 与 `js/*` 的相对路径，**没有任何 `node_modules` 引用** → 静态资源可直接由任何 HTTP 服务器托管。

### 1.2 替换区（约 114,000 行 JS）

| 目录 | 行数 | 文件数 | Rust 中的对应物 |
|---|---:|---:|---|
| `desktop/` | 30,670 | 60 | Tauri 窗口/命令 + `windows-rs` 原生模块 |
| `server/` | 22,350 | 24 | axum 路由 + 平台适配器 crate |
| `scripts/` | 17,423 | 30 | Rust 测试 + CI 脚本（大幅缩减） |
| `tests/` | 36,906 | 204 | Rust 单测 + 契约测试（几乎全部重写） |
| `cuefield/` | 6,683 | 19 | 见 D2，v1 保留为外部进程 |

### 1.3 必须复刻的对外契约（这是重写的真正工作量）

| 契约面 | 数量 | 位置 | 备注 |
|---|---:|---|---|
| `window.desktopWindow.*` 方法 | **116** | `desktop/preload.js` 的 `contextBridge` | 前端 152 处调用 |
| `ipcMain.handle/on` 通道 | **121** | `desktop/` 各文件 | 与上面不是一一对应 |
| `/api/*` 路由（服务端） | **125** | `server/server.js` | |
| `/api/*` 字面量（前端） | **106** | `public/js/` | |
| 同步桥方法 | **2** | `preload.js:165-166` | `readCurrentFxAutosaveSync` / `saveCurrentFxAutosaveSync` |
| 事件订阅型方法 | ~12 | `onXxx(callback)` 形态 | 需映射到 Tauri `listen` |
| 平台适配器 | 6 | netease / qq / kugou / qishui / spotify / applemusic | 含签名、加密、OAuth、权益判断 |
| 原生助手 | 4 类 | DWM 底座（C# 内嵌）、PowerShell 抓帧、HID、Apple Music C# 伴侣 | 全部要重写或外置 |

---

## 2. 为什么"原样保留 public/"是可行的

前端只通过三条通道接触后端，这三条都能在 Rust 侧无损复刻：

1. **`fetch('/api/...')`（相对路径，同源）** → 由 Rust 内嵌 HTTP 服务器同时托管静态资源与 `/api` 路由，前端 URL 一个字都不用改。
2. **`window.desktopWindow.*`（116 方法）** → 用 Tauri `initialization_script` 注入一个 shim（**放在 `src-tauri/`，不动 public/**），把每个方法映射到 `invoke()` 或 Tauri 事件。前端看到的对象形状完全一致。
3. **浏览器原生能力**（localStorage、WebAudio、Web Worker、`three.js`、`gsap`）→ WebView2 完全支持，与 backend 无关。

没有 WebSocket / EventSource；没有前端直连 `node_modules`。这是最有利的一点。

### 2.1 HTTP 服务器选型（关键）

Tauri 官方 `tauri-plugin-localhost` **只能托管静态资源**：它的 `on_request` 钩子仅能改响应头，不能为 `/api/*` 提供自定义路由。因此：

- ✅ **采用自研 Rust HTTP 服务器（axum + hyper）**，绑定 `127.0.0.1:<port>`，同时服务：
  - `GET /*` → `public/` 静态文件（含正确的 MIME、缓存头、`Cache-Control`）
  - `/api/*` → Rust 路由处理器
- Webview 窗口加载 `http://127.0.0.1:<port>/?startupAttempt=...`，与今天的拓扑一模一样。
- 收益：`public/` 零改动；相对路径自然工作；音频 Range 请求、二进制封面、流式响应都保持原语义。
- 代价：不是"纯 invoke 派"的 Tauri 写法，但仍是标准 Tauri 形态（Rust 后端 + 系统 WebView2 + Tauri 窗口管理）。用 invoke 重写 106 个 fetch 调用反而会破坏 `public/` 不变的前提。

### 2.2 两个同步方法怎么处理

Tauri 的 `invoke` 全是异步，而前端有 2 处 `sendSync`。两个选择：

- **首选**：注入的 shim 里用**同步 `XMLHttpRequest`** 打到本地 HTTP 服务器的 `/internal/fx-autosave/*`。同源本地服务器下同步 XHR 可用，语义与 `sendSync` 等价，public/ 无需改动。
- 备选：从 shim 中省略这两个方法 —— 前端有 `typeof bridge.readCurrentFxAutosaveSync !== 'function'` 守卫，会退回内存态，但视觉设置 autosave 持久化会失效。**仅在同步 XHR 被 WebView2 限制时才用此退路。**

其余属性型桥：`isDesktop: true` 直接写死；`systemRelease` 在生成 shim 时由 Rust 填入 `std::env` / `GetVersionEx` 结果（Win11 判定依赖 build >= 22000）。

---

## 3. Rust 目标目录结构

```
Mineradio-paused-main/
├── public/                     # 🔒 逐字节保留，加哈希守卫
├── src-tauri/
│   ├── Cargo.toml              # tauri 2.12.x（MSRV 1.90）、axum、windows、reqwest...
│   ├── tauri.conf.json         # frontendDist 不用；外部 URL 指向内嵌服务器
│   ├── capabilities/
│   │   └── default.toml        #  deny-by-default，逐项授权
│   ├── build.rs
│   ├── icons/
│   └── src/
│       ├── main.rs             # tauri::Builder::default() 入口
│       ├── lib.rs              # 组装各模块
│       ├── server/
│       │   ├── mod.rs          # axum Router，静态资源 + /api
│       │   ├── static_files.rs # public/ 托管（含 Range / MIME / 缓存头）
│       │   └── api/            # 125 条路由，按域拆文件
│       ├── providers/          # 6 平台适配器（netease/qq/kugou/qishui/spotify/applemusic）
│       ├── commands/           # 116 个 desktopWindow 方法对应的 #[tauri::command]
│       ├── events/             # ~12 个 onXxx → tauri::Emitter
│       ├── bridge/
│       │   └── shim.js         # 注入脚本：定义 window.desktopWindow（不在 public/）
│       ├── native/             # windows-rs：窗口、DWM、壁纸、HID、游戏模式、桌面图标
│       ├── storage/            # 设置、fx 存档、内置歌单、缓存、本地曲库索引
│       ├── crypto/             # 新凭据方案（DPAPI / Credential Manager）
│       └── logging/            # 沿用 docs/LOGGING.md 的事件格式与脱敏红线
├── apple-music-companion/      # D2：v1 保留 C# 外部进程
├── cuefield/                   # D2：v1 保留 JS 外部进程
└── docs/
    ├── TAURI-REWRITE-PLAN.md   # 本文
    └── API-CONTRACT.md         # Phase 1 生成的 125 路由 + 116 方法对照表
```

`Cargo.toml` 起步依赖（版本在 Phase 0 锁死并写进 `Cargo.lock`）：
`tauri = "2.12"`、`tauri-plugin-*`（shell/dialog/fs/updater）、`axum`、`tokio`、`serde{,_json}`、`reqwest`（rustls-tls）、`windows`、`tracing`、`aes-gcm`/`sha2`（凭据与签名）、`rusqlite`（可选，本地曲库索引）。

---

## 4. 四个高风险点（决定成败，先说清楚）

| 风险 | 现状 | 处置 | 验收标准 |
|---|---|---|---|
| **R1 凭据不可迁移** | `.credential-key` 是 Electron 应用身份绑定的 DPAPI；Tauri 解不开 | 按 D3 强制重登；应用启动检测旧目录，提示"需要重新登录"，**绝不尝试导入旧 key** | 新用户 6 平台登录全通；旧用户重登后设置/fx 存档仍在 |
| **R2 WebView2 ≠ Chromium** | 现在跑 Electron 45 / Chromium；Tauri 用系统 WebView2（同 Chromium 内核但版本随系统） | Phase 1 先做"能渲染"冒烟；把 three.js 着色器、backdrop-filter、WebAudio、桌面歌词透明窗列为必测清单 | 截图逐页对照；粒子/歌词/3D 书架/玻璃效果无白屏无黑块 |
| **R3 测试网几乎全废** | 194 个测试里绝大多数是断言 `.js` 源码字符串（`docs/GUARD-LEDGER.md`：C 类 715 条、B 类 3,187 条） | 重写为 Rust 单测 + **契约测试**（录制的 `/api` 请求/响应对）；保留少量针对 public/ 哈希与 DOM 结构的守卫 | 契约测试覆盖 Top 30 高频 API；public/ 哈希守卫常绿 |
| **R4 原生能力缺失** | DWM 底座是 C# 内嵌字符串；抓帧是 PowerShell；HID 走 node-hid | 用 `windows-rs` 逐项重写；DWM 缩略图、SetWindowPos、WinEventHook、HID 报告都要 Windows API 直调 | Win11 黑窗不回归；壁纸启停/拖动/玻璃采样与 v3.3.0 行为一致 |

补充风险：
- **安装器**：`build/installer.nsh` 985 行（7 语言选择、目录校验、快捷方式）需移植到 Tauri 的 NSIS/WiX 模板；这是发布链路的硬依赖，别留到最后。
- **更新**：现有 GitHub Releases + 多镜像逻辑要换成 `tauri-plugin-updater`，签名密钥要新生成（与旧安装包不通用）。
- **许可证**：`public/` 里两个 AGPL 模块（流光/商籁）原样保留即可；Rust 新代码继续 GPL-3.0，需更新 `NOTICE.md` 的依赖清单（Tauri/axum 等引入新许可证）。

---

## 5. 分阶段实施（每阶段单独可回滚）

| 阶段 | 内容 | 产出 / 验收 |
|---|---|---|
| **P0 准备** | 装 Rust 1.90+ / MSVC Build Tools / Tauri CLI；开分支；锁依赖版本；写 `API-CONTRACT.md`（从现有代码自动导出 125 路由 + 116 方法 + 事件） | `cargo build` 能出空壳；契约清单评审通过 |
| **P1 骨架** | axum 托管 `public/` + 空 `/api` 桩；Tauri 窗口加载本地 URL；注入 shim 定义全部 116 方法（先返回默认值） | **首页能完整渲染**，无 404；public/ 哈希守卫上线 |
| **P2 API  parity** | 按域移植 125 路由：先 `app/version`、`cover`、`audio`、`lyric`、`search`，再 6 平台适配器，最后更新/自定义音源 | 契约测试 Top 30 全过；搜索/播放/歌词三条主链路在 Tauri 里跑通 |
| **P3 桥 parity** | 116 个 `#[tauri::command]` + 事件；同步 XHR 解决 2 个 sync 方法；窗口控制、菜单、文件对话框 | 前端不再有 "非桌面环境" 报错；登录、歌单、本地曲库可用 |
| **P4 原生** | windows-rs 重写窗口圆角/全屏/桌面歌词/壁纸/DWM/HID/游戏模式/桌面图标 | R4 验收标准全过；Win10/Win11 双系统冒烟 |
| **P5 发布** | 安装器（7 语言）、updater 签名、CI（14 个 workflow 迁移）、`NOTICE.md`、README 口径 | 产出可安装的 Setup.exe；自动更新走通 |
| **P6 切换** | 双 shell 并行 QA 2 周；确认无回归后 `main` 切到 Tauri；Electron 代码归档 | 正式版发版；旧 tag 保留可回滚 |

**每阶段硬闸门**：`cargo test` + `cargo clippy -- -D warnings` + `npm run check:quick`（在旧分支跑，确保 public/ 契约没被破坏）+ public/ 哈希比对。任何一条红就停。

### 建议的第一刀（P1 的最小验证）

不要一上来移植业务。先做一个 200 行的"能跑的壳"：
1. axum 服务 `public/` 静态文件；
2. Tauri 窗口指向它；
3. 注入 shim，`isDesktop=true`、`systemRelease` 填好、116 个方法返回 `{ok:false,reason:'NOT_IMPLEMENTED'}`；
4. 截图对照首页。

如果这一步首页渲染不出来（three.js / 字体 / CSP 问题），后面全部无意义 —— 这是最早的止损点。

---

## 6. 当前工作区状态（2026-11-24 清理结果）

| 项 | 状态 |
|---|---|
| Git HEAD | Electron 架构终版 v3.3.0（结档提交）；`main` 与 origin 同步 |
| 工作区 | 结档后干净 |
| DWM 修复与诊断 | 原 stash 内容已 pop 并纳入 v3.3.0 一起发布；`ztest/electron-baseline-backup/` 仍留有 patch + 测试副本作历史备份 |
| 删除 | `qa/.tmp/`（93 MB，gitignored 的 QA 截图 + 隔离 userdata），无生产数据 |
| 保留未动 | `userdata/`（含 `.credential-key` 与 696 MB 数据）、`ztest/`（含 token-backup）、`build/.dotnet`（727 MB 本地工具链）、`dist/`（960 MB 安装包）、父目录 `releases/`（368 MB 归档） |
| Rust 工具链 | **未安装**（`cargo`/`rustc`/`rustup` 均 command not found）→ P0 第一件事 |
| 磁盘 | E: 64 GB，已用 44 GB，剩 21 GB（够用，但别再堆大文件） |

---

## 7. 文档校准清单（本次已做 / 待做）

- ✅ 新建本文，作为重写唯一入口。
- ✅ `docs/ARCHITECTURE.md` 头部已改为终版实测数字，并标注"Electron 时代架构（v3.3.0 冻结），新方向见本文"。
- ✅ `README.md` 开发段落已加"重写方向"提示（不承诺时间）。
- ⏸ `docs/HANDOFF*.md` 是会话快照，保持原样不改写；新会话先读 `docs/ARCHITECTURE.md` + 本文。
- ⏸ Phase 1 后新增 `docs/API-CONTRACT.md`（自动生成的路由/方法对照表）。
- ⏸ 发版前更新 `NOTICE.md`（新增 Rust crates 的许可证）。
