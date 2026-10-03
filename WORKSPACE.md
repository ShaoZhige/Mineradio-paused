# Mineradio 维护版工作区

本工作区是 `ShaoZhige/Mineradio-paused` 的本地开发副本，用于构建、测试与发布自己的维护版本。
上游原项目 `XxHuberrr/Mineradio-paused` 已长期停更（最终版 2.2.0），本仓库为社区 PR 吸纳后的个人维护分支。

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| Node.js | 18 或更高（推荐 LTS） | **必备**，缺失时所有一键脚本在第一步就会退出 |
| Git | 任意较新版本 | 仅 `4-release.bat` 打 tag 与推送时需要 |
| 网络 | 需联网 | 首次 `npm install` 与打包时下载 Electron |

安装 Node.js（PowerShell 或 CMD 中执行，会弹一次 UAC 确认）：

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
```

装完请**重开一个命令行窗口**让 PATH 生效，再双击脚本使用。

## 一键脚本

| 脚本 | 作用 | 说明 |
|---|---|---|
| `0-setup.bat` | 环境准备 | 检查 Node/npm，`npm install` 安装依赖，并自动补装缺失的 Electron 运行时 |
| `1-run.bat` | 开发运行 | `npm start`，直接以开发模式启动软件 |
| `2-test.bat` | 测试环境 | `npm run test`（Node 回归测试）+ `npm run check:quick`（静态检查） |
| `3-build.bat` | 一键构建 | `npm run build:win` 产出 Windows 安装包，并执行 `check:package` 校验，完成后打开 `dist` |
| `4-release.bat` | 一键发布 | 打 tag 并推送，触发 GitHub Actions 自动构建并生成 Release |

> 脚本编码为 **GBK/ANSI + CRLF**，编辑时不要另存为 UTF-8 或 LF，原因见文末注意事项 9。

## 标准流程

```
首次：0-setup.bat  →  1-run.bat 验证能跑
改代码：1-run.bat 调试  →  2-test.bat 跑测试  →  3-build.bat 出安装包
正式发版：改 package.json 版本号  →  4-release.bat 打 tag  →  Actions 自动出 Release
```

## 产物位置

- 安装包：`dist\Mineradio-<版本>-Setup.exe`
- 免安装目录版：`npm run build:win:dir` → `dist\win-unpacked\`

## GitHub Actions（来自 PR #404）

推送到 `main` 或发 PR 时自动触发（云端运行，不需要本地装环境）：

| 类别 | workflow |
|---|---|
| 测试 | `ci.yml`（29 个 Node 测试）、`electron-integration.yml`、`scheduled-integration.yml` |
| 构建 | `windows-build.yml` |
| 发布 | `release.yml`（tag 触发，默认草稿）、`release-dry-run.yml`（手动预演） |
| 安全 | `codeql.yml`、`dependency-review.yml`、`npm-audit.yml`、`actions-security.yml`、`package-integrity.yml` |
| 质量 | `lint.yml`、`format.yml`、`coverage.yml`、`docs-check.yml` |
| 维护 | `dependabot.yml`、`labeler.yml`、`pr-governance.yml` |

## 与上游同步（后续吸纳原作者提交）

```bash
git remote add upstream https://github.com/XxHuberrr/Mineradio-paused.git   # 只需一次
git fetch upstream
git merge upstream/main        # 或在某个分支上 cherry-pick 需要的提交
```

吸纳其它未合并 PR（本仓库已验证可用的做法）：

```bash
curl -L -k https://github.com/XxHuberrr/Mineradio-paused/pull/<PR号>.patch | git am
```

若 patch 因上游代码演进对不上（上下文冲突），需手工对照 diff 改当前文件后按原作者信息提交。

## 注意事项

1. **首次构建会下载 Electron**（约百兆），耗时较长；之后有缓存会快很多。
2. **发布与自动更新已指向本 fork**：`package.json` 的 `build.publish` 与 `mineradio.update` 均为 `ShaoZhige/Mineradio-paused`。
3. **发布 workflow 已合并为一个**：`release.yml` 集版本校验、测试门禁、NSIS 构建、SHA-256 校验和、CHANGELOG 发布说明于一体，支持手动触发与可选 draft；原独立的 Windows 发布 workflow 已删除，不会再重复出 Release。`release-dry-run.yml` 仍可用于发布预演。
4. 本工作区的一键脚本（`*.bat`、`WORKSPACE.md`）为本地便利工具，默认**未纳入 git 版本管理**；如需随仓库一起保存，可自行 `git add` 提交。
5. **测试环境实测结果**：依赖装全、Electron 二进制就绪后，套件为 **51 通过 / 0 失败 / 共 51**（`npm run test`），静态检查 `npm run check:quick` 亦通过。
6. **Electron 二进制可能没下全**：`npm install` 有时会漏掉 Electron 运行时（网络原因），此时 `1-run.bat` / `3-build.bat` 会提示缺少 `node_modules\electron\dist\electron.exe`。`0-setup.bat` 会自动检测并补装；也可手动执行 `node node_modules/electron/install.js`，或先用国内镜像再重试：`set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
7. 未跑 `0-setup.bat` 前，涉及 `electron` / `music-metadata` 的测试会失败，属正常，先装依赖即可。
8. **发新版前先在 CHANGELOG 加一节**：`release.yml` 会从 `CHANGELOG.md` 抽取 `## v<版本号>` 段落作为发布说明，缺失会在 publish 阶段直接报错。改完 `package.json` 版本号后，记得在 `CHANGELOG.md` 顶部补一节。
9. **改动运行时默认值时，必须同步打包归档**：`quick-check.js` 会逐键比对 `public/js/modules/00-state/04-fx-defaults.js` 的 `fxDefaults` 与 `public/default-user-fx-archive.json` 的 `snapshot`（键集合 + 每个键的值），任何一处对不上都会 fail。同步时别忘了断言里那份 `expectedCapturedDefaults` 清单。上游 PR #439 就是漏了这一步，导致 `check:quick` 一直是红的。

## 一键脚本的维护约束（改动前务必先读）

这五条都是实际踩过的坑，脚本改动后请用 `cmd` 实跑一次再算完成。

1. **必须 CRLF 换行**。LF 换行的 `.bat` 会被 cmd 解析崩，报一串乱码的 `'xxx' 不是内部或外部命令`。`.gitattributes` 已加 `*.bat text eol=crlf` 防止回退。
2. **必须 GBK/ANSI 编码 + 开头 `chcp 936`**，不要存成 UTF-8。cmd 在 `chcp 65001` 下读含中文的 UTF-8 批处理会把行错误切分——行尾中文被当成独立命令执行（`'关闭本窗口。' is not recognized`），并让 `if errorlevel` 分支误判。UTF-8 带 BOM 更糟，BOM 会被并入第一条命令。用 VS Code 编辑时请把右下角编码切到 `GB2312`/`GBK` 保存。
3. **脚本里所有 npm 调用都要写 `call`**（`call npm run test`）。`npm` 是 `npm.cmd` 批处理封装，裸调用时它内部的 exit 会连带终止整个脚本，后续命令被静默跳过。
4. **发布 tag 只能是 `v<package.json 版本>`**，`release.yml` 的 validate 阶段会强校验；`4-release.bat` 因此不接受自定义 tag，并会先检查 `CHANGELOG.md` 是否已有对应章节，缺失时直接拦住，避免推到 CI 才失败。
5. **`quick-check.js` 里的 `spawnSync` 已固定 `stdio[0] = 'ignore'`**。Windows 上部分安全软件（如 360）会拦截 `spawnSync` 默认创建的匿名 stdin 管道，导致所有子进程 EBUSY、`node --check` 全报失败（文件其实没问题）。新增子进程调用请沿用同样的 stdin 处理。
