# Mineradio（维护延续版 / Maintained Fork）

> **本仓库定位：上游维护版本 + 社区 PR 整合改进版**
>
> 本仓库是 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 的**维护延续版本**。上游原作者已宣布项目**长期停更**，本仓库在沿用上游全部代码与设计的前提下，持续整合社区提交的 Pull Request 与改进（缺陷修复、平台接口修复、多语言国际化、视觉与性能优化等），并跟随社区反馈持续迭代。
>
> 如果你仍在使用上游原版，建议迁移到本维护版以获得持续的修复与改进。

![Mineradio 暗场启动页](./docs/assets/readme/cinema-beat-smoke.png)

Mineradio 是一款 Windows 桌面沉浸式音乐播放器，把搜索播放、歌词舞台、粒子视觉、3D 歌单架和完整桌面模式组合成一个更接近现场感的私人音乐空间。

## 与上游的关系

- **上游**：[XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) —— 由 XxHuberrr 主要设计与打造，当前处于**长期停更**状态（最后正式版 2.2.0）。
- **本仓库（ShaoZhige/Mineradio-paused）**：上游的**维护版本**。在保留上游功能、视觉与交互的基础上，整合来自社区的 PR 与改进，修复已知问题并补充新能力，是社区驱动的延续开发分支。
- **许可**：本仓库与上游一致采用 **GPL-3.0** 授权（见 [LICENSE](./LICENSE)）。上游原作者的全部版权与署名均予以保留；本仓库新增与修改部分的版权归相应贡献者所有。

## 立即下载 Windows 安装包

> 本维护版通过 GitHub Releases 与阿里云盘分发；国内用户推荐用阿里云盘直链（下载不限速）。

| 下载入口 | 说明 | 链接 |
| --- | --- | --- |
| 阿里云盘（国内推荐） | 国内直链、下载不限速 | [点此下载](https://www.alipan.com/s/36YiXCzvuKt) |
| GitHub Release | 版本说明、源码与安装包 | [查看 Mineradio Releases](https://github.com/ShaoZhige/Mineradio-paused/releases) |

安装时只需要下载并运行 `Mineradio-<版本>-Setup.exe`。不要把 `.blockmap`、`latest.yml` 或 `win-unpacked` 当成正式安装包。

## 下载或安装被拦截怎么办

小众 Electron 桌面软件、未签名安装包有时会被浏览器、Windows Defender 或 SmartScreen 提示风险。请先确认安装包来自本仓库的 Release 入口，文件名形如 `Mineradio-<版本>-Setup.exe`。

1. 浏览器下载栏提示风险时，打开下载列表，点这条下载右侧的 `...` 三个点，选择 `保留` / `仍要保留` / `显示更多` 后继续保留。
2. Windows SmartScreen 弹出蓝色拦截窗口时，点 `更多信息`，再点 `仍要运行`。
3. 如果杀毒软件明确显示木马、高危或已经隔离，不要强行运行；删除该文件后重新从 Release 入口下载，仍然异常请带截图反馈。

## 当前版本

当前版本：`2.5.1`

状态：本维护版的持续迭代版本，在整合社区改进的同时修复上游遗留问题。

> 安全提示：上游 `v2.2.0` 及更早旧安装包已不再积极维护。建议使用本仓库提供的最新 Release。

## 核心特性

- 首页包含每日推荐、平台推荐、继续听、听歌画像和我的歌单入口
- 完整桌面模式保留播放器、主页、歌单和桌面交互
- 支持本地 MP4 与 Wallpaper Engine 视觉内容
- 播放后切换到 Emily / 默认播放态视觉，歌词舞台与粒子舞台同步工作
- 基于节奏的电影镜头视觉系统
- 面向长播客和 DJ 曲目的专属视觉模式
- 歌词舞台、自定义歌词、歌词位置与视觉控制
- 自定义专辑封面上传与裁剪
- 右键唤起 3D 歌单架，支持歌单队列浏览
- 网易云音乐账号、搜索、歌单、播客等体验接入
- QQ 音乐搜索、登录态与音源补充接入
- 支持导入洛雪音乐桌面版（LX Music Desktop）的 `.js` 自定义音源，为自己的网易云 / QQ 搜索结果解析播放地址
- GitHub Releases 更新检测与下载入口
- 首次启动内置「默认测试」视觉用户存档，软件内默认视觉参数与该存档一致
- **多语言界面**：中文 / English / 日本語 / Русский 四语完整本地化

## 使用说明

Windows 用户可以从本仓库的 Release 入口或[阿里云盘直链](https://www.alipan.com/s/36YiXCzvuKt)下载安装包。

正式分发以 `Mineradio-<版本>-Setup.exe` 为准，不建议直接使用 `win-unpacked` 目录。安装包会创建桌面快捷方式。

已经安装过旧版本的用户可直接运行新版本 `Mineradio-<版本>-Setup.exe` 完成更新。软件内更新入口只会打开浏览器下载页，不会在客户端内下载或应用补丁。

## 开发运行

```bash
npm install
npm start
npm run build:win
```

桌面版入口由 Electron 主进程加载本地服务。`npm run build:win` 会生成 Windows NSIS 安装包，产物位于 `dist/`。

## 更新机制

Mineradio 会请求 GitHub Releases latest 检测新版本。远端版本高于本地版本时，应用内更新入口会展示 Release 内容，并通过系统浏览器打开下载入口。

本地验证更新链路时，可以通过 `MINERADIO_UPDATE_MANIFEST` 指向一个本地 manifest JSON 或 HTTP 地址来模拟线上 Release。

## 第三方音乐平台说明

Mineradio 不是网易云音乐、QQ 音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。

项目中的第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。项目不会提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。

### 洛雪自定义音源

标题栏的「源」入口可以导入洛雪音乐桌面版的 `.js` 自定义音源脚本，为网易云与 QQ 搜索结果解析播放地址。这是**用户自行提供**的第三方脚本能力：

- 仓库与安装包内不包含任何音源脚本，也不随更新分发；脚本只保存在本机用户数据目录。
- 脚本在独立沙箱渲染环境中运行，读不到 Mineradio 的账号 Cookie、用户歌单、本地文件和 DOM。
- 脚本可以向网络发送它收到的歌曲信息，因此只应导入你信任的脚本。
- 该项目本身不提供、也不内置任何绕过付费、绕过会员或破解音质的能力。

实现与边界详见 [docs/LX_CUSTOM_SOURCE.md](./docs/LX_CUSTOM_SOURCE.md)。

## 用户数据与隐私

登录 Cookie、搜索历史、自定义封面、自定义歌词、节奏分析缓存等数据只应保存在本机用户数据目录或浏览器本地存储中，不应提交到仓库。

更多说明见 [PRIVACY.md](./PRIVACY.md)。

## 致谢

Mineradio 由 XxHuberrr 主要设计与打造。emily 作为早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此感谢。

同时感谢小天才e宝、应春日、锋将军、軌跡、林中、骊、风痕、花椰菜🥦在早期体验、测试反馈和发布准备中的帮助。

本维护版的持续改进也离不开社区提交的 Pull Request 与反馈，在此一并致谢。

## 版权与授权

Copyright (C) 2026 XxHuberrr 及 Mineradio-paused 贡献者。

本仓库是 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 的维护延续版本，在沿用上游代码与设计的前提下整合社区 PR 与改进。上游原作者的全部版权与署名均予以保留；本仓库新增与修改部分的版权归相应贡献者所有。

本项目采用 **GPL-3.0** 授权（与上游一致）。详见 [LICENSE](./LICENSE)。

MR Logo、Mineradio 名称、界面视觉设计与原创视觉表达归上游原作者所有；第三方依赖和第三方服务分别遵循其各自授权与服务条款。
