# QA

仓库内的自动化冒烟，和 `ztest/`（本地手工/截图脚本，不入库）分开。

- `npm run qa:lyrics`：流光歌词 CDP 冒烟。隐藏启动 Electron，注入六词歌词，断言渲染、逐词状态、动效、颜色与辉光开关；失败退出码非 0。CI 由 `.github/workflows/qa.yml` 在 windows-latest 上执行。
- 桌面模式 QA（锁定/点击穿透/图标显隐）仍依赖真实桌面与鼠标注入，暂留在 `ztest/check-overlay-lock-click.js` 手工执行；收编进 CI 需要单独的交互式 runner，Phase 3 继续。
