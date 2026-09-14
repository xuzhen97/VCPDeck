#![forbid(unsafe_code)]
//! Desktop Host 进程入口；实现全部位于 `desktop_host` lib。

fn main() -> std::io::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(desktop_host::run())
}
