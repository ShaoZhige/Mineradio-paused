//! 无头验证入口：`cargo run -p mineradio-server [-- --port N] [--public DIR] [--token]`
//!
//! 存在的理由：P1 的第一道风险是"静态链路能不能把 `public/` 正确发出去"，
//! 这件事不需要 GUI 就能验（curl 打 index.html 和它引用的每个资源）。
//! 第二个风险"WebView2 能不能渲染 three.js / 玻璃效果"才必须开窗。

use std::path::PathBuf;

use mineradio_server::{default_public_dir, start_with_port};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut public_dir = default_public_dir();
    let mut print_token = false;
    let mut port: u16 = 0;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--public" => {
                if let Some(v) = args.next() {
                    public_dir = PathBuf::from(v);
                }
            }
            "--port" => {
                if let Some(v) = args.next() {
                    port = v
                        .parse::<u16>()
                        .map_err(|_| anyhow::anyhow!("端口不是数字：{v}"))?;
                }
            }
            "--token" => print_token = true,
            "-h" | "--help" => {
                println!("用法: mineradio-server [--public DIR] [--port N] [--token]");
                return Ok(());
            }
            other => anyhow::bail!("未知参数：{other}"),
        }
    }

    let handle = start_with_port(port, public_dir).await?;

    println!("listening http://127.0.0.1:{}", handle.addr.port());
    if print_token {
        println!("internal token {}", handle.token);
    }
    println!("按 Ctrl+C 退出");

    tokio::signal::ctrl_c().await?;
    handle.shutdown().await;
    Ok(())
}
