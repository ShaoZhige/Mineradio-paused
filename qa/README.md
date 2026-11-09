# QA

仓库内的自动化冒烟，和 `ztest/`（本地手工/截图脚本，不入库）分开。

- `npm run qa:lyrics`：流光歌词 CDP 冒烟。隐藏启动 Electron，注入六词歌词，断言渲染、逐词状态、动效、颜色与辉光开关；失败退出码非 0。CI 由 `.github/workflows/qa.yml` 在 windows-latest 上执行。
- `npm run qa:desktop`：桌面模式 CDP 冒烟。隐藏启动 Electron，开启全屏覆盖层，断言 `phase=interactive`、`overlayMode=true`、窗口覆盖工作区，再关闭并确认 `phase=disabled`。需要真实 Windows 桌面（Explorer/Progman）；无交互桌面时会输出 SKIP 并退出 0，但只有设置 `MINERADIO_QA_ALLOW_SKIP=1` 才允许跳过，CI 里显式开启。
- 锁定/点击穿透/图标显隐仍依赖真实鼠标注入，留在 `ztest/check-overlay-lock-click.js` 手工执行；这类交互不适合直接进 CI。
