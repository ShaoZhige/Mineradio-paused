# 播放链路术语契约

> 这份文件定义**本仓库**播放链路的说法，以及每条说法落到哪个实体上。
> 它不是架构介绍，是给「要改播放、要评审播放、要判断某个不变量是否成立」的人用的对照表。
>
> 写完于 2026-11-03。以后改播放链路的结构，请同步改这里；否则下一个人的心智模型会和代码脱节。

---

## 1. 我们实际的拓扑（先看这个，再看名词）

**生产播放路径是「单媒体元素 + 世代令牌 + 淡变」，不是双甲板。**

```
用户点播放
  → 取播放地址（provider / custom source / 本地库）
  → trackSwitchToken++（作废所有在飞的旧回调）
  → primary audio.src 换地址
  → preparePlaybackFadeIn() → startPlaybackFadeIn()
  → loadedmetadata / canplay 回调先比对 token，再落位置
```

- **primary audio**：`public/js/modules/05-playback/08-audio-graph-controls.js` 里的 `audio`，全流程只有一个。
  `13-playback-start-audio.js` 在重建时会重新 `new Audio()`，但语义上仍是「唯一主体」。
- **mirror audio**：`00-api-quality-output.js` 的 `new Audio()` + `setSinkId`，只做**输出复制**，
  不承载媒体时钟、不参与播放状态判断。
- **临时 audio**：`13-playback-start-audio.js` 里预加载用的 `new Audio()`，以及 cuefield 过渡用的实例，
  生命周期只覆盖一次预载/一次过渡。
- **A/B 双甲板**：只在 **cuefield AutoMix** 的时间线里出现（`action.deck === 'A' | 'B'`），
  不是通用播放路径的一部分。

---

## 2. 名词表

| 术语 | 代码里的实体 | 含义 | 不要用 |
|---|---|---|---|
| **播放世代** | `trackSwitchToken` | 每次切歌自增的世代号。任何异步回调（`loadedmetadata` / `canplay` / `setTimeout`）在动手前必须比对它，不一致就放弃 | 「requestId」「epoch」 |
| **音频主体** | `audio`（`08-audio-graph-controls.js`） | 唯一承载媒体时钟的元素 | 「player」「deck」 |
| **镜像输出** | `audio = new Audio()` + `mirror.setSinkId()`（`00-api-quality-output.js`） | 把同一路音频复制到副设备，纯输出侧 | 「第二播放器」 |
| **淡变代次** | `audioFadeSerial` + `clearAudioFadeTimers()` | 新淡变作废旧定时器的串行保护 | 「fade id」 |
| **专辑无缝** | `albumGaplessState`（`00-state/00-core-stores.js`）、`tagAlbumSongsForGapless()`、`resolveAlbumGaplessPlaybackData()` | 同 provider + 同专辑 + 同封面才成立的无缝衔接，逐曲可开关 | 「gapless 全局开关」 |
| **过渡时间线** | `16-cuefield-automix-core.js` 的 action 列表 | cuefield 导出的、带时间戳的播放/音量动作序列 | 「播放指令队列」 |
| **甲板 A / B** | 时间线里的 `action.deck` | **仅** cuefield 过渡使用的两个虚拟唱盘 | 「主/备播放器」 |
| **过渡桥** | `cuefield/bridge-planner.js`、`17a-cuefield-bridge-engine.js` | 两首歌之间那段被塑形的桥接 | 「交叉淡化」 |
| **音源回退** | `11-provider-fallback.js`（函数见该模块） | 主源拿不到地址时按优先级换源 | 「重试」 |
| **自定义音源** | `20-custom-source.js` + `desktop/custom-source/**` | 洛雪兼容的 `.js` 音源脚本，见 `docs/LX_CUSTOM_SOURCE.md` | 「插件」 |

---

## 3. 不变量（改代码时按这几条自查）

1. **单主体**：任一时刻只有一个 `audio` 在推进媒体时钟。mirror 与预加载实例都不得被当成「当前播放」。
2. **世代优先**：任何延迟回调都要先 `token === trackSwitchToken` 再干活。
   绕过它的表现是「切歌后上一首的回调把进度条拽回去」，不会报错。
3. **淡变串行**：进入新的淡变前必须 `clearAudioFadeTimers()` 并递增 `audioFadeSerial`，
   否则两条淡变会互相踩，音量忽大忽小。
4. **无缝的判据是身份，不是意图**：`tagAlbumSongsForGapless()` 打的标记就是判据；
   不要用「两首歌听起来像同一张专辑」去推断。
5. **镜像不改状态**：mirror 的 `setSinkId` 失败只影响那一路输出，不得把 `playing` 置为 false。
6. **失败保留现场**：换源/失败时不清空队列与当前索引，否则「重试」会变成「从头再来」。

---

## 4. 与「双甲板 + pending/committed owner」模型的差异（别照搬）

参考实现（Tauri 重写版）用的是另一套：两个长寿命 deck、pending owner 与 committed owner 分离、
prepared handoff 一次性转移所有权。那套模型适合「先预载再提交」的重写，理由是在双 deck 上做无缝衔接。

**我们的代码不是那样**，直接套用会产生两个误判：

- 把 mirror 或预加载实例当成「pending deck」，进而认为存在 pending/committed 分离 —— 不存在；
- 认为切歌有「prepared handoff 的提交点」—— 实际提交点是 `trackSwitchToken` 的比对，不是所有权转移。

如果要往那个方向重构，那是一次架构变更，不属于「对齐术语」。在这之前，
**讨论播放问题请用第 2 节的词**。

---

## 5. 文件对照

| 文件 | 管什么 |
|---|---|
| `05-playback/08-audio-graph-controls.js` | primary audio、AudioContext/MediaElementSource、淡变定时器、媒体会话 |
| `05-playback/12-playback-switch-core.js` | 切歌期的暂停/恢复位置、失败文案归类（不含切歌主流程） |
| `05-playback/13-playback-start-audio.js` | 切歌主流程：取址、token、预载、落位、自动续播 |
| `05-playback/11-provider-fallback.js` | 音源回退与地址解析策略 |
| `05-playback/16-cuefield-automix-core.js` | 时间线数据结构与 A/B 甲板动作 |
| `05-playback/17-cuefield-timeline-executor.js` | 时间线执行 |
| `05-playback/17a-cuefield-bridge-engine.js` | 过渡桥 |
| `05-playback/18-cuefield-automix-integration.js` | 与播放状态的接线 |
| `cuefield/` | 规划器与过渡证据（recipe / window / bridge / transition） |

---

## 6. 怎么验

```powershell
node scripts/run-ci-tests.js      # 全量；播放相关至少覆盖下面这些
node scripts/check:quick.js       # 守卫（含资源预算）
```

播放相关用例：`playback-audio-graph-recovery` / `playback-single-repeat-loop` /
`playback-source-fallback-transaction` / `preferred-source-order` / `qishui-seo-playback-fallback` /
`cuefield-mineradio-integration` / `cuefield-transition-runtime`。

> 资源有界性（每帧开销、虚拟窗口、体积基线）不在本文范围，见
> `scripts/check-resource-budget.js` 与 `npm run check:budget`。
