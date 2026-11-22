# 日志约定与事件目录（2026-11-21）

> 实现：`desktop/logging.cjs`（主进程）+ `public/js/modules/00-state/00c-log-client.js`（渲染进程）。
> 格式：JSON Lines，一行一个事件，文件在 `userdata/` 下，512KB 滚动一份 `.1`。

## 1. 命名规范

```
{ at, level, scope, event, ...字段 }
```

- `scope`：子系统，固定取值 —— `playback | queue | lyric | account | source | window | apple-music | app | renderer`
- `event`：`动作-结果`，小写连字符，如 `start-failed`、`page-failed`、`status`
- 字段：只要**可枚举的短值**（id 前 40 字符、错误码、耗时 ms、数量）
- 级别：`info` 正常落定；`warn` 可恢复的失败；`error` 用户可见的失败

## 2. 🔴 脱敏红线（硬性）

**禁止写入**：cookie / token / 密码 / 完整 URL 与 query / 歌词原文与歌曲名 / 用户目录绝对路径 / 昵称与头像地址。
需要关联时用 **id 前 40 字符**或哈希。渲染进程来的对象由 `sanitize()` 二次兜底（限深 2、限长 400、限 20 键）。

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
