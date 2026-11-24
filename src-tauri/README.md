# src-tauri

Mineradio 的 Tauri 外壳（P1 阶段）。设计取舍见 `docs/REWRITE-PLAN.md`。

## 它做什么

1. 用 `crates/mineradio-server` 在 `127.0.0.1` 上起一个随机端口的 HTTP 服务（静态 `public/` + `/api` 桩 + `/internal`）
2. 开一个窗口，`url` 指向 `http://127.0.0.1:<port>/?startupAttempt=1`
3. 在页面脚本执行**之前**注入 `window.desktopWindow`（`src/bridge/shim.js`，由契约生成）

## 它故意不做什么

- **不内嵌 `public/`**：`tauri.conf.json` 的 `frontendDist` 指向 `placeholder/`。指向 `../public` 会让
  19 MB 前端塞进 exe、每次编译多花一大截，而窗口根本不从 asset 协议加载。P5 做发布链时再决定。
- **不注册 `#[tauri::command]`**：P1 的桥全是占位实现，一律返回 `NOT_IMPLEMENTED`。
  P3 才逐个换成真命令，届时 `window.__mineradioBridge.calls` 就是"哪些方法被真正调用过"的清单。

## 常用命令

```bash
# 只验静态链路（不开窗）：curl 打 index.html 与它引用的全部资源
cargo run -p mineradio-server -- --port 18765

# 开窗，看能不能渲染
cargo run -p mineradio-desktop

# 桥的生成与校验（契约一变必须重新生成）
npm run shim:gen
npm run shim:check
```

## 已知的 P1 风险点

`public/index.html` 直连 `https://fonts.googleapis.com`。断网或被墙时字体会回退，
不影响渲染但会改变排版观感 —— 判断"首页是否正常"时要意识到这一条。
