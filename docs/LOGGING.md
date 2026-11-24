# 日志约定与事件目录（2026-11-21，2026-11-24 补 Rust 侧）

> 实现：`desktop/logging.cjs`（Electron 主进程）+ `public/js/modules/00-state/00c-log-client.js`（渲染进程）
> + `crates/mineradio-log`（Tauri/Rust 侧，逐字段对齐前两者）。
> 格式：JSON Lines，一行一个事件，文件在 `userdata/` 下，512KB 滚动一份 `.1`。

## 1. 命名规范

```
{ at, level, scope, event, ...字段 }
```

- `scope`：子系统，固定取值 —— `playback | queue | lyric | account | source | window | apple-music | app | renderer | playlist`
- `event`：`动作-结果`，小写连字符，如 `start-failed`、`page-failed`、`status`
- 字段：只要**可枚举的短值**（id 前 40 字符、错误码、耗时 ms、数量）
- 级别：`info` 正常落定；`warn` 可恢复的失败；`error` 用户可见的失败

## 2. 🔴 脱敏红线（硬性）

**禁止写入**：cookie / token / 密码 / 完整 URL 与 query / 歌词原文与歌曲名 / 用户目录绝对路径 / 昵称与头像地址。
需要关联时用 **id 前 40 字符**或哈希。渲染进程来的对象由 `sanitize()` 二次兜底（限深 2、限长 400、限 20 键）。

**Rust 侧（`crates/mineradio-log`）把这条从"自觉"改成了"强制"**，落盘前按规则自动删：

| 规则 | 效果 |
|---|---|
| 键名归一化（去非字母数字 + 小写）后等于或以敏感词结尾 | 整个值 → `[redacted]`（覆盖 `cookie` / `accessToken` / `X-Auth-Token` / `refresh_token` / `spade_a`） |
| 值是一个 URL | 只留 `scheme://host[:port]`，路径与 query 全砍 |
| 值含绝对路径（含嵌在消息里的） | 只留文件名：`…\app.log` |
| `Bearer xxx` / JWT / ≥64 字符的 hex、base64 块 | `Bearer [redacted]` / `[jwt]` / `[blob]` |

顺序是**先 `sanitize` 再脱敏**：裁剪会把第 2 层以下折叠成 `[object]`、把串截到 400 字符，
所以第 401 个字符之后的东西（如果有）根本进不了脱敏环节。

## 3. 事件目录

| scope | event | 触发点 | 关键字段 | 级别 |
|---|---|---|---|---|
| `playback` | `start-failed` | `handlePlaybackUnavailable()`（所有平台的起播失败总入口） | provider / songId / error / status / category | error |
| `playback` | `am-warm` | AM 起播前预热宿主 | ok / elapsedMs | info / warn |
| `playback` | `am-start-failed` | AM `playSong` 返回失败 | catalogId / error / stage / resumeAt | error |
| `playback` | `am-start-retry` | AM 播放器未就绪时重试一次 | stage / catalogId | warn |
| `playback` | `am-start-rejected` | 拿不到 catalogId（库 id 换不到） | songId / libraryId / provider / reason | error |
| `queue` | `page-failed` | `hydratePlaylistQueueNextPage()` 续页失败 | provider / playlistId / offset / reason / message | warn |
| `lyric` | `unavailable` | 歌词接口答了但没有可用行 | provider / songId / reason(`no-lyric-upstream`\|`parse-empty`) | warn |
| `lyric` | `fetch-failed` | 歌词请求异常 | provider / songId / message | warn |
| `account` | `status` | 五个平台的登录态**变化**（非每次轮询） | provider / loggedIn / error / stale | info / warn |
| `account` | `apple-music-status` | AM 会话落定（含 storefront） | loggedIn / error / storefront | info / warn |
| `source` | `list-failed` | 自定义音源清单读取失败 | message | warn |
| `source` | `resolve-failed` | 脚本解析某首歌失败 | message | warn |
| `source` | `init-skipped` | 主进程脚本宿主初始化被跳过 | message | warn |
| `window` | `state` | 全屏 / 最大化切换（仅变化时） | fullscreen / maximized / wallpaper | info |
| `window` | `error` / `unhandledrejection` | 渲染进程未捕获异常 | message / source / line | error |
| `playlist` | `catalog-page-failed` | 歌单目录某平台某页失败 | provider / message | warn |
| `apple-music` | `spawn` / `handshake-timeout` / `host` | companion 生命周期 | code | info |
| `apple-music` | `request` | 每次 companion 请求结算 | operation / elapsedMs / attempts / ok / error / stage | info / error |
| `app` | `console` | 主进程 `console.error/warn` 镜像 | channel / message | warn / error |
| `app` | `server-start` / `server-stop` | 本地 HTTP 服务生命周期（Rust） | port | info |
| `app` | `server-start-failed` | 服务起不来（`public/` 缺失、端口占用） | message | error |
| `app` | `guard-rejected` | 请求被 Host / 跨站 / token 守卫拒掉 | reason(`bad-host`\|`cross-site`\|`bad-token`) / path | warn |
| `app` | `api-not-implemented` | `/api/*` 落到占位桩（**debug 级**，默认不落盘；调低级别就是"还差哪些接口"的清单） | path / method | debug |

## 3.1 两处待统一的迁移债

- `desktop/apple-music/companionClient.cjs` 写的是 `{type: 'spawn' | 'request' | 'host'}`，不是本目录约定的
  `event`。Rust 侧已统一成 `event`，Electron 侧未改（等整体切走后再动，避免同一份日志两种字段名混着看）。
- §1 的 scope 清单原本漏了 `playlist`，但事件目录里有 `playlist`/`catalog-page-failed`。已按"事件目录为准"补进枚举。

## 3.2 Rust 侧与 JS 侧的行为差异

| 项 | JS | Rust |
|---|---|---|
| 滚动 | Windows 上 `rename` 覆盖 `.1` 必失败，退化成删掉当前日志 | 先删 `.1` 再改名，真滚动 |
| 字段顺序 | 插入顺序 | 字典序 |
| 保留键 | 调用方可覆写 `at/level/scope/event` | 一律忽略 |
| 事件名 | 原样落盘 | 归一化成小写连字符 |
| `at` | `toISOString()` | 同格式，自己算（`civil_from_days`），有测试对着 Node 钉住 |

## 4. 查看方式

```bash
# 只看失败
grep -h '"level":"error"' userdata/*.log

# 某个子系统的最近 20 条
grep -h '"scope":"playback"' userdata/renderer.log | tail -20

# 统计错误类型
grep -ho '"event":"[^"]*"' userdata/renderer.log | sort | uniq -c | sort -rn
```

## 5. 新增日志点的规矩

1. 先确认**有真实的失败分支**（catch / 明确的失败返回），不给"正常路径"加日志；
2. 只在**状态变化**时记（登录态、窗口态），轮询类一律比较前后值；
3. 一个失败分支只记**一次**，不要在多层重复记同一条；
4. 字段遵守第 2 节的脱敏红线；
5. 加完在 `tests/` 里补一条守卫，防止以后被顺手删掉。
