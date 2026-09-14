#![forbid(unsafe_code)]
//! Desktop Host 进程实现。
//!
//! 拆成 lib + bin 是为了让 IPC 传输与控制面接线可以被集成测试直接驱动，
//! 而不必先安装系统服务或占用固定端点。
//!
//! 平台后端（Windows / X11 / GNOME / KDE）尚未接入，因此默认服务诚实上报不可用能力；
//! 在没有真实捕获与输入实现之前，Host 不得让上层误以为远程桌面可用。

pub mod runtime;
pub mod transport;

use desktop_core::encoder::EncoderFactory;
use desktop_core::host::{FrameKind, HostFrame, HostRequest, HostService};
use desktop_core::session::DesktopBackend;
use desktop_core::webrtc::transport::TransportCodec;
use platform_mock::MockBackend;
use runtime::HostRuntime;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

/// Windows Named Pipe 端点；与 TypeScript `defaultDesktopHostIpcEndpoint()` 一致。
pub const WINDOWS_ENDPOINT: &str = r"\\.\pipe\vcpdeck-desktop-host";
/// Linux Unix domain socket 端点；与 TypeScript `defaultDesktopHostIpcEndpoint()` 一致。
pub const LINUX_ENDPOINT: &str = "/run/vcpdeck/desktop-host.sock";
const ENV_ENDPOINT: &str = "VCPDECK_DESKTOP_HOST_ENDPOINT";
const ENV_GENERATION: &str = "VCPDECK_DESKTOP_HOST_GENERATION";
const ENV_STUN_URLS: &str = "VCPDECK_DESKTOP_HOST_STUN_URLS";

fn env_or(default: &str, key: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// 解析本次进程应监听的端点；环境变量优先于平台默认值。
pub fn endpoint_from_env() -> String {
    let default = if cfg!(windows) {
        WINDOWS_ENDPOINT
    } else {
        LINUX_ENDPOINT
    };
    env_or(default, ENV_ENDPOINT)
}

/// Host 自己的 generation；Server/Client 用它识别进程重启后的状态漂移。
pub fn host_generation() -> String {
    let fallback = format!(
        "host-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
    );
    env_or(&fallback, ENV_GENERATION)
}

/// 用给定后端构造 Host 服务。
pub fn build_service_with<B: DesktopBackend>(
    backend: B,
    host_version: &str,
    generation: impl Into<String>,
) -> HostService<B> {
    HostService::new(backend, host_version, generation)
}

/// 生产使用；平台后端接入前能力必须为不可用。
pub fn build_service() -> HostService<MockBackend> {
    eprintln!("[desktop-host] platform backend pending: reporting unavailable capability");
    build_service_with(
        MockBackend::unavailable("REMOTE_DESKTOP_UNSUPPORTED"),
        env!("CARGO_PKG_VERSION"),
        host_generation(),
    )
}

/// 读取 Host 侧 STUN 地址（逗号分隔）。
///
/// 默认为空：单机与局域网场景只需 host candidate。上公网/跨 NAT 时由部署侧
/// 通过环境变量提供，Host 不自行发现。
pub fn stun_urls_from_env() -> Vec<String> {
    std::env::var(ENV_STUN_URLS)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

/// 读取一帧；返回 `None` 表示对端正常关闭。
pub async fn read_frame_async<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > desktop_core::host::MAX_IPC_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(body))
}

/// 写出一帧（含 4 字节网络序长度前缀）。
pub async fn write_frame_async<W: AsyncWrite + Unpin>(
    writer: &mut W,
    body: &[u8],
) -> std::io::Result<()> {
    if body.len() > desktop_core::host::MAX_IPC_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    writer.write_all(&(body.len() as u32).to_be_bytes()).await?;
    writer.write_all(body).await?;
    writer.flush().await
}

/// 编码一帧（含 4 字节长度前缀）。
pub fn encode_framed(kind: FrameKind, generation_id: &str, payload: Value) -> Option<Vec<u8>> {
    desktop_core::host::encode_frame(&frame_for(kind, generation_id, payload)).ok()
}

/// 编码一帧 body（不含长度前缀）；写入流时由 `write_frame_async` 加前缀。
fn encode_body(kind: FrameKind, generation_id: &str, payload: Value) -> Option<Vec<u8>> {
    desktop_core::host::encode_frame_body(&frame_for(kind, generation_id, payload)).ok()
}

fn frame_for(kind: FrameKind, generation_id: &str, payload: Value) -> HostFrame {
    HostFrame {
        protocol_version: 1,
        generation_id: generation_id.to_string(),
        kind,
        payload,
    }
}

/// 服务一条连接：请求 → 响应 → 当前状态报告。
///
/// 必须驱动 [`HostRuntime`] 而不是裸 [`HostService`]：`session.signal` 的真实
/// SDP 协商、通道绑定与 challenge 下发都在运行态里。只调 `HostService::handle`
/// 会让 `session.signal` 返回空响应，Browser 永远拿不到 answer。
///
/// 信封 generation 由 Client 生成，Host 必须原样回显；不匹配的帧直接终止连接。
pub async fn serve_connection<S, B>(stream: S, runtime: Arc<Mutex<HostRuntime<B>>>)
where
    S: AsyncRead + AsyncWrite + Unpin,
    B: DesktopBackend + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut last_generation: Option<String> = None;
    loop {
        let body = match read_frame_async(&mut reader).await {
            Ok(Some(body)) => body,
            Ok(None) | Err(_) => break,
        };
        let Ok(frame) = desktop_core::host::decode_frame_bytes(&body) else {
            break;
        };
        if frame.kind != FrameKind::Request {
            break;
        }
        let generation_id = frame.generation_id.clone();
        last_generation = Some(generation_id.clone());

        let Ok(request) = serde_json::from_value::<HostRequest>(frame.payload) else {
            break;
        };
        let session_id = request.session_id.clone();
        let (response, report) = {
            let mut runtime = runtime.lock().await;
            let response = runtime.handle(request).await;
            let report = runtime.service().state_report(Some(&session_id));
            (response, report)
        };

        if !emit(&mut writer, FrameKind::Response, &generation_id, &response).await {
            break;
        }
        if !emit(&mut writer, FrameKind::State, &generation_id, &report).await {
            break;
        }

        // 必须在 answer 写出之后才做通道绑定与 challenge 下发：Browser 只有拿到
        // answer 才会完成 DTLS 并打开通道，在响应路径上等待会自我死锁。
        // 放到后台任务里，避免占用锁并阻塞后续 IPC 请求。
        let pending = Arc::clone(&runtime);
        tokio::spawn(async move {
            let mut runtime = pending.lock().await;
            let _ = runtime.pump().await;
        });
    }
    if let Some(generation_id) = last_generation {
        eprintln!("[desktop-host] connection closed (generation={generation_id})");
    }
}

async fn emit<W, T>(writer: &mut W, kind: FrameKind, generation_id: &str, payload: &T) -> bool
where
    W: AsyncWrite + Unpin,
    T: serde::Serialize,
{
    let Ok(value) = serde_json::to_value(payload) else {
        return false;
    };
    // 只编码 body：长度前缀由 write_frame_async 统一添加，避免重复分帧。
    let Some(body) = encode_body(kind, generation_id, value) else {
        return false;
    };
    write_frame_async(writer, &body).await.is_ok()
}

/// 用给定后端构造 Host 运行态（生产入口使用）。
pub fn build_runtime_with<B: DesktopBackend + 'static>(
    backend: B,
    host_version: &str,
    generation: impl Into<String>,
) -> Arc<Mutex<HostRuntime<B>>> {
    build_runtime_with_factory(backend, host_version, generation, None)
}

/// 同 [`build_runtime_with`]，但可注入编码器工厂（媒体循环需要）。
pub fn build_runtime_with_factory<B: DesktopBackend + 'static>(
    backend: B,
    host_version: &str,
    generation: impl Into<String>,
    encoder_factory: Option<Arc<dyn EncoderFactory>>,
) -> Arc<Mutex<HostRuntime<B>>> {
    let service = HostService::new(backend, host_version, generation);
    let runtime = HostRuntime::new(service, TransportCodec::Vp8, stun_urls_from_env());
    let runtime = match encoder_factory {
        Some(factory) => runtime.with_encoder_factory(factory),
        None => runtime,
    };
    Arc::new(Mutex::new(runtime))
}

/// 生产使用；平台后端接入前能力必须为不可用。
pub fn build_runtime() -> Arc<Mutex<HostRuntime<MockBackend>>> {
    eprintln!("[desktop-host] platform backend pending: reporting unavailable capability");
    build_runtime_with(
        MockBackend::unavailable("REMOTE_DESKTOP_UNSUPPORTED"),
        env!("CARGO_PKG_VERSION"),
        host_generation(),
    )
}

/// Windows 生产运行态：使用真实 Win32 后端（显示器枚举/输入/剪贴板）。
///
/// 捕获与编码器尚未接入，因此能力仍会诚实收敛为 `available = false`；
/// 但显示器拓扑与输入已经走真实平台路径，而不是 mock。
#[cfg(windows)]
pub fn build_runtime_windows() -> Arc<Mutex<HostRuntime<platform_windows::WindowsBackend>>> {
    build_runtime_with_factory(
        platform_windows::WindowsBackend::new(),
        env!("CARGO_PKG_VERSION"),
        host_generation(),
        Some(Arc::new(
            platform_windows::encoder::WindowsEncoderFactory::default(),
        )),
    )
}

/// 运行 Host：监听本机 IPC 端点直到收到关闭信号。
pub async fn run() -> std::io::Result<()> {
    let endpoint = endpoint_from_env();
    #[cfg(windows)]
    let runtime = build_runtime_windows();
    #[cfg(not(windows))]
    let runtime = build_runtime();
    let shutdown = Arc::new(AtomicBool::new(false));

    {
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                shutdown.store(true, Ordering::SeqCst);
            }
        });
    }

    eprintln!("[desktop-host] listening on {endpoint}");
    let handler = {
        let runtime = runtime.clone();
        move |stream| {
            let runtime = runtime.clone();
            async move { serve_connection(stream, runtime).await }
        }
    };
    transport::serve(&endpoint, handler, shutdown).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_report_serializes_with_camel_case_wire_fields() {
        let service = build_service();
        let report = service.state_report(None);
        let value = serde_json::to_value(&report).expect("serialize");
        assert_eq!(value["protocolVersion"], 1);
        assert!(value["hostGeneration"].is_string());
        assert_eq!(value["status"], "idle");
        assert_eq!(value["capability"]["available"], false);
        assert_eq!(value["capability"]["protocolVersion"], 1);
        assert!(value["capability"]["supportedCodecs"].is_array());
        assert!(value["capability"].get("protocol_version").is_none());
    }

    #[test]
    fn host_frame_encoding_round_trips_through_the_shared_codec() {
        let encoded = encode_framed(
            FrameKind::State,
            "gen-1",
            serde_json::json!({ "status": "idle" }),
        )
        .expect("encode");
        let length = u32::from_be_bytes([encoded[0], encoded[1], encoded[2], encoded[3]]) as usize;
        assert_eq!(encoded.len(), 4 + length);
        let decoded = desktop_core::host::decode_frame_bytes(&encoded[4..]).expect("decode");
        assert_eq!(decoded.kind, FrameKind::State);
        assert_eq!(decoded.generation_id, "gen-1");
    }

    #[test]
    fn frame_bodies_and_framed_frames_are_not_double_prefixed() {
        // `emit` 只写 body，`write_frame_async` 加前缀；两者混用时必须只有一个前缀。
        let body = encode_body(
            FrameKind::Response,
            "gen-1",
            serde_json::json!({ "ok": true }),
        )
        .expect("body");
        assert_eq!(body[0], b'{');
        let framed = encode_framed(
            FrameKind::Response,
            "gen-1",
            serde_json::json!({ "ok": true }),
        )
        .expect("framed");
        let length = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
        assert_eq!(length, body.len());
        assert_eq!(&framed[4..], body.as_slice());
    }

    #[test]
    fn a_capability_report_never_claims_availability_without_a_backend() {
        let service = build_service();
        let capability = service.state_report(None).capability.expect("capability");
        assert!(!capability.available);
        assert!(!capability.capture);
        assert_eq!(
            capability.diagnostic_code.as_deref(),
            Some("REMOTE_DESKTOP_UNSUPPORTED")
        );
    }

    #[test]
    fn the_endpoint_defaults_match_the_typescript_client_expectations() {
        // 不依赖环境变量时的平台默认值必须与 Client 的 endpoint 选择器逐字一致。
        std::env::remove_var(ENV_ENDPOINT);
        let endpoint = endpoint_from_env();
        if cfg!(windows) {
            assert_eq!(endpoint, WINDOWS_ENDPOINT);
            assert_eq!(endpoint, r"\\.\pipe\vcpdeck-desktop-host");
        } else {
            assert_eq!(endpoint, LINUX_ENDPOINT);
            assert_eq!(endpoint, "/run/vcpdeck/desktop-host.sock");
        }
    }
}
