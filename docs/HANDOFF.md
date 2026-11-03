# Mineradio 项目交接文档

> 维护版本仓库：`ShaoZhige/Mineradio-paused` · 本地路径 `E:\Mineradio-paused-main\Mineradio-paused-main`
> 当前版本：**2.7.0**（tag `4f2b716`，2026-11-01）· 技术栈：**Electron 45 + 零构建 classic script**

这份文档写给「刚接手这个项目的人」。它不重复 README 的产品介绍，而是讲清楚**代码怎么组织、怎么跑起来、怎么改、怎么发版，以及哪些坑已经踩过**。

---

## 1. 一句话定位

Mineradio 是一款 Windows 桌面沉浸式音乐播放器，把搜索播放、歌词舞台、粒子视觉、3D 歌单架、完整桌面模式组合在一起。本仓库是上游 `XxHuberrr/Mineradio`（已长期停更）的**维护延续版本**，持续整合社区 PR 与修复。**GPL-3.0** 授权，多语言（中文 / English / 日本語 / Русский）。

核心设计哲学：**零构建**——前端不打包、不转译，全靠 `classic <script>` 分文件注入。这是刻意选择，不要为了「现代化」把它改掉。

---

## 2. 目录结构

```
Mineradio-paused-main/
├── desktop/                    # Electron 主进程（Node 侧）
│   ├── main.js                 # 主进程入口，7254 行，窗口/生命周期/IPC/WE 壁纸编排
│   ├── preload.js              # 渲染层桥接（contextBridge）
│   ├── wallpaper-engine-*.js   # Wallpaper Engine 壁纸引擎集成（library/runtime/user-properties）
│   ├── full-desktop-mode-*.js  # 完整桌面模式
│   ├── halo-*.js               # Halo PixelBar 硬件（HID）与歌词同步
│   ├── local-music-library.js  # 本地音乐库（索引/监听）
│   ├── credential-crypto.js    # 凭证加密（safeStorage + AES-256-GCM）
│   ├── playlist-transfer.js    # 歌单文件导入/导出
│   ├── login-easter-egg-gate.js # 「世界和平」彩蛋门
│   └── custom-source/          # 洛雪音乐自定义音源（LX Music .js）
├── server/                     # 后端 API（被 main.js require 进同一进程，非独立服务）
│   ├── server.js               # 核心 HTTP 路由 + 网易云/QQ 聚合，6908 行
│   ├── kugou-api.js / qishui-api.js / spotify-api.js / qq-vip-api.js
│   ├── qishui-auth-v6/         # 汽水音乐认证（含音频解密）
│   └── dj-analyzer*.js         # DJ 节奏分析（worker）
├── public/                     # 前端（零构建）
│   ├── index.html              # 单页入口
│   ├── css/index.css           # 全部样式（巨型单文件）
│   ├── js/index-loader.js      # ★ 模块注入顺序表（见 §5）
│   └── js/modules/             # 分模块前端逻辑（见 §6）
├── cuefield/                   # Cuefield 自动混音（独立模块）
├── scripts/                    # 闸门与校验脚本（见 §7）
├── tests/                      # 测试（node:test，130+ 文件）
├── build/                      # NSIS 安装器、磁贴资源
├── docs/                       # 文档 + 更新清单
├── .github/workflows/          # 13 个 CI 工作流
├── 0-setup.bat … 4-release.bat # 开发/测试/构建/提交的引导脚本
└── .workbuddy/memory/          # ★ 项目记忆（红线与踩坑记录，见 §9）
```

---

## 3. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Electron 45 | 主进程 + 渲染进程 |
| 前端 | 无框架 classic script | `public/js/modules` 分文件注入，无 import/export |
| 音乐 API | `NeteaseCloudMusicApi` + 自研多源聚合 | server 进程内直连，无 sidecar |
| 视觉 | GSAP + 自绘 Canvas/WebGL | 歌词舞台、粒子、3D 歌单架 |
| 数据 | localStorage（前端）+ JSON 文件（后端） | 凭证现已加密落盘 |
| 更新 | electron-builder + GitHub Releases + 网盘 | 客户端内只打开下载页，不自动更新 |

**生产依赖只有 6 个**：`gsap`、`mpg123-decoder`、`music-metadata`、`NeteaseCloudMusicApi`、`node-hid`、`qrcode`。依赖已压到极简，动依赖要谨慎（见 §7 依赖审计）。

---

## 4. 进程架构

关键点：**server 不是独立进程**。`main.js` 里通过 `require(serverModulePath)` 把 `server/server.js` 加载进**同一个 Electron 主进程**。

```js
// main.js 约 6365 行
async function ensureLocalServerStarted() {
  configureLocalServerEnvironment(port);
  migrateLegacyAuthStorage();
  migratePlainCredentialsToEncrypted(); // 明文凭证 → 密文，必须在 require(server.js) 之前
  const serverModulePath = path.join(__dirname, '..', 'server', 'server.js');
  delete require.cache[require.resolve(serverModulePath)];
  localServer = require(serverModulePath); // 同进程，无 IPC 边界
}
```

这意味着：
- `server.js` 能直接访问主进程的 `safeStorage`（凭证加密依赖这点，见 §8）。
- 改 server 逻辑不需要考虑跨进程通信，但**改完要重启整个应用**（没有热重载）。

---

## 5. 前端加载模型（改前端前必读）

前端是**零构建 + 分文件注入**。`public/js/index-loader.js` 是唯一的模块注册表。

**核心规则：**

1. 每个模块是一个独立的 `<script src>`，按 `modulePaths` 数组顺序注入，`el.async = false` 保序。
2. 顶层 `function`/`var` 落在**同一个全局作用域**，模块间靠名字互相看见；同名会**静默覆盖**（`startup-bundle-execution` 守卫拦这个）。
3. **没有跨文件函数提升**：A 文件顶层直接调 B 文件里后面才声明的函数 = `ReferenceError`。要延迟调用用 `window.__mineradioDefer(fn)`。
4. **新增模块必须登记到 `modulePaths`**，否则不报错、不红测试，只是永不加载（`check:quick` 的登记守卫会拦）。
5. 顺序敏感，既有约定：i18n(13/14/15) → `00-core-stores` → `00b-local-readers` → `05a-fx-save-read` → 消费者。

**惰性加载**：`07-fx/03-wallpaper-engine-library.js`（2705 行，最重的单模块）在 `lazyModulePaths` 里，首次真正用到才注入，避免所有用户为壁纸付启动成本。

---

## 6. 前端模块地图（`public/js/modules/`）

| 目录 | 职责 |
|---|---|
| `00-state/` | 核心状态、偏好、i18n、性能状态、provider 注册表 |
| `01-scene/` | 渲染质量、轨道相机、节奏相机、电影镜头 |
| `02-visual/` | 歌词舞台视觉：粒子、星河、着色器、网格、蒙版 |
| `03-beat/` | 节拍分析、DJ/播客节奏、本地节拍缓存 |
| `04-shelf/` | 3D 歌单架：布局、卡片交互、键盘相机 |
| `05-playback/` | 播放核心：搜索、队列、音源回退、媒体会话、cuefield |
| `06-lyrics/` | 歌词抓取解析、歌单面板、详情、多选、文件分享 |
| `07-fx/` | 视觉预设、颜色控制、热键、缓存设置、控制台 |
| `08-account/` | 登录（汽水/Spotify）、彩蛋门、退出、启动引导 |
| `09-*` | 待机 toast、提示弹窗 |
| `10-shell/` | 手势、视口、拖拽上传、启动绑定 |
| `11-main-loop.js` | 主循环 |

---

## 7. 开发工作流与四道闸门

**改完任何东西，至少跑 `test:ci` + `check:quick`。涉及依赖再跑 `audit:prod`，涉及打包再跑 `check:package`。**

```bash
# ⚠️ 本机必须清掉这两个环境变量（见 §10 假故障）
NODE_OPTIONS="" npm run test:ci        # 全量测试（基线 117+ passed）
NODE_OPTIONS="" npm run check:quick    # 快速守卫（含模块登记、版本一致性等）
NODE_OPTIONS="" npm run audit:prod     # 生产依赖安全审计
NODE_OPTIONS="" npm run check:package  # 打包产物校验（需先建目录版）
```

`check:package` 需要先构建目录版：

```bash
NODE_OPTIONS="" npx electron-builder --win dir \
  -c.electronDist="E:/Mineradio-paused-main/Mineradio-paused-main/node_modules/electron/dist"
```

> 注意：`ELECTRON_OVERRIDE_DIST_PATH` 对 electron-builder **不生效**，必须用 `-c.electronDist`。

---

## 8. 凭证加密（2026-11 新增）

**8 个凭证文件已加密落盘**：`.cookie` / `.qq-cookie` / `.kugou-cookie` / `.qishui-cookie` / `.qishui-token` / `.qishui-qr-login.json` / `.spotify-token.json` / `.spotify-credentials.json`。

- 方案：**AES-256-GCM + safeStorage(DPAPI)** 双层结构，借鉴上游 Tauri 版思路。
- 内层 AES-256-GCM 加密数据（认证加密，篡改即抛错）；外层随机主密钥用 `safeStorage`（DPAPI）加密落盘 `.credential-key`。
- 核心模块 `desktop/credential-crypto.js`，提供 `encryptCredential` / `decryptCredential` / `encryptJson` / `decryptJson`。
- **safeStorage 不可用时自动降级明文**（纯 Node 测试环境），凭证永远能读写。
- 读时兼容明文（旧文件过渡期），写时一律加密。
- 迁移在 `main.js` 的 `migratePlainCredentialsToEncrypted()`，`require(server.js)` 之前执行。

---

## 9. 项目记忆（`.workbuddy/memory/`）

这是项目自带的「踩坑记录」，按主题分文件。**动到对应模块前先读对应 topic**，能少踩 90% 的坑：

| 文件 | 什么时候必读 |
|---|---|
| `topics/loading-and-local-env.md` | 改 `public/js/modules`、新增模块、改 `index-loader.js`；遇到「不报错但功能没了」「启动即退出」 |
| `topics/playlist-panel.md` | 动 `#playlist-panel`、虚拟列表、歌单目录状态行、平台切换器 |
| `topics/ui-console-and-visuals.md` | 往 `#fx-panel` 加控件、改滚动条、调 `#beat-chip`、加视觉预设 |
| `topics/build-release.md` | 改依赖、发版、改安装器、改磁贴、截 NSIS 页面 |
| `topics/runtime-and-hardware.md` | DJ 节奏分析、Halo PixelBar、性能档位、WE 壁纸启停、壁纸属性跟随 |
| `topics/login.md` | 汽水扫码、Spotify 授权、世界和平彩蛋门与解锁动画 |
| `topics/css-and-deadcode.md` | 批量删 CSS、删「看起来没人用」的类名、写动画 |

`MEMORY.md` 是索引，`2026-*.md` 是每日流水（append-only）。

---

## 10. 本机环境陷阱（极易误判）

这台开发机的 shell 注入了两个会打乱 Node/Electron 的环境变量：

1. **`NODE_OPTIONS=--require ".../node-language-shim.cjs"`**（safe-delete 拦截 shim）：会让 `npm ci` 整单回滚、让 electron-builder 清理旧 `dist` 时**静默卡死**。
2. **`ELECTRON_RUN_AS_NODE=1`**：Electron 按纯 Node 跑，**应用一启动就退出（exit 0，无窗口）**。

处理：所有 npm/electron 命令前加 `NODE_OPTIONS=""`，启动 Electron 前 `env -u ELECTRON_RUN_AS_NODE`；写 `.bat` 时开头 `set "NODE_OPTIONS="` + `set "ELECTRON_RUN_AS_NODE="`。

其它常见假故障：
- `MINERADIO_STARTUP_QA_USER_DATA` 只在 `MINERADIO_STARTUP_QA_HIDDEN=1` 时被采纳，否则静默退回默认 `userdata/` 并争单实例锁。
- 后台起 Electron 别接 `| head -N`（SIGPIPE 带走进程），用 `| tail -N`。
- 本机 `prefers-reduced-motion` 恒真 → 写动画时 reduce 分支必须「去位移、保留淡变」，不能压时长。

---

## 11. 三条红线（不可违反）

1. 🔴 **禁止强杀进程**：`taskkill /F` 绕过 `before-quit`，WE 窗口会留在桌面。按**可执行文件路径**过滤（正式版在 `D:\Mineradio`），用 `CloseMainWindow()` 等自退；调试实例用 `desktopWindow.setCloseBehavior('exit')` + `close()`。
2. 🔴 **不擅自 `git push`、不擅自对外发消息**（issue/PR/邮件）：本地 commit 可以，推与发声等用户明说。
3. 🔴 **临时脚本放 `ztest/`，不放仓库根**（`server-module-relocation` 断言根目录无 `.js`）。

---

## 12. 发版流程

**发版动 5 个文件**：`package.json`、`package-lock.json`（两处，注意 `mime` 那条 `2.6.0` 是依赖版本别动）、`README.md` 第 41 行「当前版本」、`docs/update/latest.yml`（version + releaseDate）、`CHANGELOG.md`。

完整步骤：

1. 改上述 5 处版本号，`CHANGELOG.md` 顶部加 `## vX.Y.Z` 段（标题独占一行，段内不能出现 `## `）。
2. 跑四道闸门（§7）。
3. 提交 + 打 annotated tag：`git tag -a vX.Y.Z -m "vX.Y.Z"`。
4. 推送 commit + tag → 触发 `release.yml`（校验 tag↔版本 → 回归测试 → Windows 构建 → 用 CHANGELOG 截段生成发布说明 → 发 Release）。
5. 本地出包（传网盘用）：`npm run build:win -- -c.electronDist=...`（约 103s）→ `npm run archive:release` 归档到 `releases\vX.Y.Z\`。

**截段自测**（最容易踩，工作区 CRLF 会让 `$0 ==` 失配，必须从 `git show` 取）：

```bash
git show HEAD:CHANGELOG.md | awk -v section="## v2.7.0" '$0 == section'
```

CHANGELOG 格式（用户硬性要求）：扁平无序列表，不分节、不加小标题、不编号、不做表格，每条 `- ` 一句话，句末中文句号。写之前先读最新版 CHANGELOG 确认格式没变。

---

## 13. 已知技术债 / 未做项

| 项 | 状态 | 说明 |
|---|---|---|
| WE 壁纸掉帧节流 | 不做 | 用户判定无感 |
| 歌单导出带封面 | 不做 | 用户明确不要，导出只带曲目 |
| Spotify 授权（issue #1） | 上游硬门槛 | 非本版引入 |
| WE 壁纸属性跟随 | 已做 | 但只在壁纸启动时读一次，运行中不跟随 |

---

## 14. 快速上手清单

1. 装依赖：`0-setup.bat`（或手动 `NODE_OPTIONS="" npm ci`）。
2. 跑起来：`1-run.bat`（或 `env -u ELECTRON_RUN_AS_NODE npx electron .`）。
3. 跑测试：`2-test.bat`（或 `NODE_OPTIONS="" npm run test:ci`）。
4. 改前端 → 先读 `topics/loading-and-local-env.md`，新模块记得登记 `index-loader.js`。
5. 改完 → 跑 `test:ci` + `check:quick`。
6. 发版 → 读 `topics/build-release.md`。
