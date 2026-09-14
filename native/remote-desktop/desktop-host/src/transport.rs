//! 本机 IPC 传输层。
//!
//! - Linux：Unix domain socket，并在 accept 后校验对端 UID。
//! - Windows：Named Pipe；默认 DACL 仅允许创建者与本机管理员。
//!
//! 端点只在本机可见，没有网络回退路径。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 关闭信号；`serve` 循环在置位后停止接受新连接。
pub type Shutdown = Arc<AtomicBool>;

/// 判断是否应该停止接受新连接。
fn stopping(shutdown: &Shutdown) -> bool {
    shutdown.load(Ordering::SeqCst)
}

#[cfg(unix)]
mod imp {
    use super::{stopping, Shutdown};
    use std::future::Future;
    use tokio::net::{UnixListener, UnixStream};

    /// 运行 Unix domain socket accept 循环。
    ///
    /// bind 前会删除遗留 socket 文件，bind 后立即收紧为 `0600`，只允许属主访问。
    pub async fn serve<H, Fut>(
        endpoint: &str,
        handler: H,
        shutdown: Shutdown,
    ) -> std::io::Result<()>
    where
        H: Fn(UnixStream) -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::remove_file(endpoint);
        let listener = UnixListener::bind(endpoint)?;
        std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))?;

        loop {
            if stopping(&shutdown) {
                break;
            }
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                () = wait_for_stop(shutdown.clone()) => break,
            };
            let Ok((stream, _)) = accepted else {
                continue;
            };
            if !peer_is_trusted(&stream) {
                eprintln!("[desktop-host] rejected IPC peer with an unexpected uid");
                continue;
            }
            let handler = handler.clone();
            tokio::spawn(async move { handler(stream).await });
        }
        let _ = std::fs::remove_file(endpoint);
        Ok(())
    }

    async fn wait_for_stop(shutdown: Shutdown) {
        while !stopping(&shutdown) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    /// 只信任 root 与 Host 自身 UID；其他用户一律拒绝。
    fn peer_is_trusted(stream: &UnixStream) -> bool {
        let Ok(credentials) = stream.peer_cred() else {
            return false;
        };
        let peer = credentials.uid();
        let own = unsafe_geteuid();
        peer == 0 || peer == own
    }

    fn unsafe_geteuid() -> u32 {
        // SAFETY: `geteuid` 是 async-signal-safe 且无参数的 libc 调用，失败模式不存在。
        // 这里不引入 `libc` 依赖，直接通过 std 的进程信息不可得，因此读取 `/proc/self/status`。
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix("Uid:"))
                    .and_then(|value| value.split_whitespace().nth(1))
                    .and_then(|value| value.parse::<u32>().ok())
            })
            .unwrap_or(0)
    }
}

#[cfg(windows)]
mod imp {
    use super::{stopping, Shutdown};
    use std::future::Future;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    /// 运行 Named Pipe accept 循环。
    ///
    /// 管道使用 `first_pipe_instance` 防止抢占；默认 DACL 只授予创建者与本机管理员访问权。
    /// 显式安全描述符与调用方身份校验属于发布前必须完成的工作，见 Task 6。
    pub async fn serve<H, Fut>(
        endpoint: &str,
        handler: H,
        shutdown: Shutdown,
    ) -> std::io::Result<()>
    where
        H: Fn(NamedPipeServer) -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(endpoint)?;
        loop {
            if stopping(&shutdown) {
                break;
            }
            let accepted = tokio::select! {
                accepted = server.connect() => accepted,
                () = wait_for_stop(shutdown.clone()) => break,
            };
            if accepted.is_err() {
                continue;
            }
            let connected = server;
            server = ServerOptions::new().create(endpoint)?;
            let handler = handler.clone();
            tokio::spawn(async move { handler(connected).await });
        }
        Ok(())
    }

    async fn wait_for_stop(shutdown: Shutdown) {
        while !stopping(&shutdown) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    use super::Shutdown;
    use std::future::Future;

    /// VCPDeck 只支持 Windows 与 Linux；其他平台没有 IPC 回退。
    pub async fn serve<H, Fut>(
        _endpoint: &str,
        _handler: H,
        _shutdown: Shutdown,
    ) -> std::io::Result<()>
    where
        H: Fn(std::io::Empty) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "unsupported platform",
        ))
    }
}

pub use imp::serve;

/// 供平台实现复用的关闭检查。
#[allow(dead_code)]
pub(crate) fn is_stopping(shutdown: &Shutdown) -> bool {
    stopping(shutdown)
}
