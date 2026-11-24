// 发布版不要弹控制台窗口；debug 版保留，方便看服务器 URL 和错误。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Mineradio 的 Tauri 外壳（P1）。
//!
//! 三件事，做完就交给前端：
//! 1. 起本地服务（`mineradio-server`，绑 127.0.0.1 随机端口）
//! 2. 开窗口指向 `http://127.0.0.1:<port>/?startupAttempt=1`
//! 3. 在页面脚本跑起来之前注入 `window.desktopWindow`（占位实现）
//!
//! 刻意不做的事：不内嵌 `public/`、不用 `devUrl`、不注册任何 `#[tauri::command]`。
//! 前端仍然是"只认 HTTP"的那一份代码，逐字节没改。

mod bridge;
mod sysinfo;

use std::path::PathBuf;

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

/// 打包后 `public/` 与 exe 同级（或 resources/ 下）；开发时退回仓库目录。
fn locate_public_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [dir.join("public"), dir.join("resources").join("public")] {
                if candidate.is_dir() {
                    return candidate;
                }
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("public")
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("创建 tokio 运行时失败");

    let public_dir = locate_public_dir();
    let server = match runtime.block_on(mineradio_server::start(public_dir.clone())) {
        Ok(server) => server,
        Err(err) => {
            eprintln!(
                "[mineradio] 本地服务启动失败：{err}（public = {}）",
                public_dir.display()
            );
            panic!("本地服务启动失败：{err}");
        }
    };

    let url = format!("{}/?startupAttempt=1", server.url());
    let shim = bridge::shim_for(server.addr.port(), &sysinfo::system_release());
    println!(
        "[mineradio] 本地服务 {url}（systemRelease={}）",
        sysinfo::system_release()
    );

    let mut server = Some(server);

    tauri::Builder::default()
        .setup(move |app| {
            let parsed = url
                .parse()
                .unwrap_or_else(|err| panic!("本地服务 URL 非法（{url}）：{err}"));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Mineradio")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .initialization_script(&shim)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(move |_app, event| {
            if let RunEvent::Exit = event {
                if let Some(handle) = server.take() {
                    runtime.block_on(handle.shutdown());
                }
            }
        });
}
