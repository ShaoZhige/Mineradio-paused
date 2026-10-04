# 洛雪自定义音源兼容 / LX Music custom sources

Mineradio 可以直接导入现有洛雪音乐桌面版（LX Music Desktop）的 `.js` 自定义音源脚本。
脚本不需要为 Mineradio 改写，即可为网易云（`wy`）与 QQ 音乐（`tx`）的搜索结果解析播放地址。

本功能只兼容洛雪的「自定义音源」子系统，不复制洛雪的搜索、账号、歌单、下载或界面。
Mineradio 继续负责搜索、账号、歌单、播放队列、歌词舞台和音频可视化。

兼容基线是洛雪音乐桌面版公开的自定义源协议：

- `globalThis.lx.version = '2.0.0'`
- `globalThis.lx.env = 'desktop'`
- 事件：`request`、`inited`、`updateAlert`
- 平台键：`kw`、`kg`、`tx`、`wy`、`mg`、`local`
- 动作：`musicUrl`；`local` 额外允许 `lyric`、`pic`
- 音质：`128k`、`320k`、`flac`、`flac24bit`

## 使用方式

标题栏的 **源** 按钮打开自定义音源面板：

1. 导入 `.js` 音源脚本（导入时会先在临时宿主里跑通初始化，失败不予保存）。
2. 点「启用」。同一时刻只有一个脚本处于活动状态。
3. 播放网易云或 QQ 歌曲时，活动脚本会成为这些歌曲的播放地址提供方。

列表允许保存多个脚本，随时可以「停用音源」回到内置解析。脚本文件存放在 Electron
`userData` 下的 `custom-sources/`，不在项目目录、Git 或安装包里。

## 架构

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `CustomSourceStore` | `desktop/custom-source/store.js` | 解析脚本头部元数据、保存脚本与启用状态、原子替换与损坏索引备份 |
| `LxSourceRuntime` | `desktop/custom-source/runtime.js` | 创建/销毁隔离渲染环境，代理 IPC 白名单通道，负责初始化和请求生命周期 |
| `CustomSourceManager` | `desktop/custom-source/manager.js` | 脚本生命周期、激活状态、播放地址解析与 `handled` 语义 |
| `music-info.js` | `desktop/custom-source/music-info.js` | Mineradio 歌曲对象 → 洛雪 `MusicInfo` |
| `protocol.js` | `desktop/custom-source/protocol.js` | 协议常量与纯函数（元数据解析、音质选择、响应校验、播放策略） |
| `redact.js` | `desktop/custom-source/redact.js` | 落盘前的敏感字段遮盖 |
| 解析路由 | `server.js` → `/api/custom-source/resolve` | 渲染进程到主进程宿主的唯一入口，负责取消传播 |
| 前端模块 | `public/js/modules/05-playback/20-custom-source.js` | 脚本清单管理界面，以及播放链路的接入点 |

脚本运行环境、HTTP 代理、脱敏与播放解析全部留在 Electron 主进程侧。渲染进程只负责
列脚本、转达用户意图，以及把当前歌曲交给宿主解析。

### 解析器注入必须跟着本地服务一起重来

`ensureLocalServerStarted()` 会清掉 `require.cache` 再重新 require `server.js`，拿到的是
**全新模块实例**，上面挂的 `customSourceResolver` 会一起消失。因此每一条「启动/重启本地
服务 → 加载主页面」的路径都必须在两者之间重新调用 `initializeCustomSourceManager()`：

```js
await ensureLocalServerStarted();
await initializeCustomSourceManager();   // 重新注入 resolver（幂等）
await loadMainWindowWithRetry(win);
```

目前有两条这样的路径：首次启动与主界面渲染进程崩溃恢复。漏掉后者的后果是**静默降级**
——内置音源照常播放，只有自定义音源不再返回地址，且不报错，非常难被发现。`startActive()`
自带幂等判断（同一个脚本已在运行就直接返回），所以重复调用不会重建脚本宿主。

`tests/custom-source-frontend-wiring.test.js` 与 `quick-check.js` 都对这两条路径做了
去注释后的结构断言，把它钉住了。

## 隔离与安全

脚本在专用、隐藏、沙箱化的 Electron 渲染环境运行：

- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webviewTag: false`
- 每次运行一个独立的内存 `partition`，与主窗口会话完全隔离
- 禁止窗口打开、导航、下载、权限申请
- 页面自带 CSP：`default-src 'none'; connect-src 'none'; img-src 'none'; style-src 'none'`
- 只通过专用 preload 暴露 `globalThis.lx`，preload 不向外递出 `ipcRenderer`
- 每条 IPC 都校验发送方 `webContents`，主窗口之外的渲染进程一律 `UNAUTHORIZED`

脚本因此读不到 Mineradio 的 DOM、账号 Cookie、用户歌单、本地文件、环境变量或系统命令。

`lx.request` 不自动附加 Mineradio 的任何平台 Cookie，也不继承播放器登录 Session；
宿主只转发脚本自己给出的请求头。请求与响应日志在写盘前遮盖 `Cookie`、`Set-Cookie`、
`Authorization`、`Proxy-Authorization`，以及名称包含 `token`、`secret`、`key`、`password`
等敏感头与值。

导入面板常驻显示风险提示：第三方脚本可以向网络发送歌曲信息，只应导入可信脚本。

## 播放行为

启用自定义音源后：

1. 判断活动脚本是否声明支持当前歌曲平台和目标音质。
2. 选择不高于用户目标、且脚本声明支持的最高音质。
3. 请求 `musicUrl`。
4. 校验 URL（必须是长度不超过 2048 的 HTTP/HTTPS 地址）后交给现有音频代理与播放器。
5. 歌词、进度、节奏分析、电影镜头和 3D 歌单架继续由播放器驱动，脚本不接触这些模块。

### `handled`：只接管脚本真正主张的歌曲

Mineradio 有五个平台（网易云 / QQ / 酷狗 / 汽水 / Spotify），而洛雪公开协议里只有
`wy`、`tx` 有对应的搜索来源，一个脚本通常也只声明其中一两个。因此解析结果带 `handled` 标记：

- 平台不认识、脚本没声明该平台、没声明 `musicUrl` 动作 → `handled: false`，**交回内置解析**。
- 脚本声明了平台但没有可用音质 → `handled: true, url: ''`，报 `quality_unsupported`（这是脚本自身的问题，不应静默降级）。
- 脚本返回地址 → `handled: true`，该地址生效。

这样启用一个只支持网易云的脚本，不会让酷狗和汽水歌曲一起变成不可播。

### 不与内置接口竞速

前端的内置平台分发整体位于 `if (!data)` 之内：自定义源返回结果（无论是成功还是明确的
失败）都不会再额外发起一次内置请求；返回 `null`（未启用 / 未声明该平台 / 超时 / 被取消）
时才走原来的内置链路。

`resolveAlbumGaplessPlaybackData` 是预加载与自动换源候选解析的唯一入口，因此专辑无缝衔接、
切歌预取和跨平台换源会自动沿用同一条策略。

脚本失败后进入 Mineradio 现有的自动换源流程：查找同名同歌手的另一平台歌曲，若活动脚本
支持该平台则再次通过脚本解析；只有所有平台都失败才提示播放失败。

切歌时前端会取消上一首尚未返回的脚本请求，过期响应不会覆盖当前歌曲。

### 不污染平台音质语义

脚本能给出的最高音质由脚本自己决定：

- 不会写入平台的运行时音质上限（否则停用脚本后平台仍被压在脚本的上限里）；
- 不会被表述成「网易云音质自动降级」；
- 生效时不会回退到内置的 QQ 复合音质重试。

## 歌曲对象映射

| Mineradio | 洛雪 |
| --- | --- |
| `netease` | `wy` |
| `qq` | `tx` |

适配后对象遵循洛雪当前 `MusicInfo` 结构（`id` / `name` / `singer` / `source` / `interval` /
`meta.songId` / `meta.albumName` / `meta.albumId` / `meta.picUrl` / `meta.qualitys`），
QQ 的 `meta` 额外含 `strMediaMid`、`id`、`albumMid`。为了兼容仍按旧文档读取平铺字段的存量
脚本，同时提供只读别名 `songmid`、`albumId`、`strMediaMid`、`copyrightId`、`hash`。

时长统一为 `mm:ss`；Mineradio 各平台混用毫秒与秒，适配器把大于 10000 的数值按毫秒处理。

## 错误处理

| 代码 | 含义 |
| --- | --- |
| `IMPORT_INVALID` | 脚本格式或元数据无效，或重复导入 |
| `INIT_TIMEOUT` | 10 秒内未发送 `inited` |
| `INIT_FAILED` | 初始化期间抛错 |
| `SOURCE_UNSUPPORTED` | 脚本未声明当前平台（交回内置解析） |
| `QUALITY_UNSUPPORTED` | 脚本声明了平台但没有可用音质 |
| `REQUEST_FAILED` / `REQUEST_CANCELLED` | 请求超时、失败或被切歌取消 |
| `INVALID_RESPONSE` | 返回类型、长度或协议无效 |
| `HTTP_FAILED` | `lx.request` 网络失败、URL 非法或响应过大 |
| `CUSTOM_SOURCE_LOAD_FAILED` | 地址取得成功但播放器无法加载，进入自动换源 |

后端只返回机器可读的代码，具体文案由前端词典决定（`public/locales/*.json` 的
`custom_source_*` 键），因此切换语言不需要改动后端。

## 已知边界

- 不保证失效、私有或依赖非标准 Node API 的脚本可运行。
- 不新增酷我、酷狗、咪咕搜索：只有 Mineradio 能生成对应平台歌曲信息后，才会向脚本请求这些平台的 URL。
- 不绕过会员权益、DRM、付费限制或平台授权。
- 用户脚本不进入快速补丁、Git 历史或安装包；打包版首次启动不存在任何预装脚本。

## 验证

| 层面 | 入口 |
| --- | --- |
| 协议 / 映射 / 仓库 / 脱敏 / 总控 / 运行时代理 | `tests/custom-source-*.test.js`，由 `scripts/run-ci-tests.js` 统一执行 |
| 真实 Electron 宿主契约（沙箱、crypto、buffer、zlib、HTTP 各形态） | `npm run test:custom-source-host` |
| 静态接线不变量 | `node scripts/quick-check.js` 的 `LX custom source guard` |
