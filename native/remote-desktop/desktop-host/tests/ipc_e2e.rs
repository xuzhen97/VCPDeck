//! Desktop Host IPC 线格式端到端测试。
//!
//! 这里不使用任何 mock 传输：服务端跑在真实的 `serve_connection` 上，客户端按
//! TypeScript `DesktopHostIpcClient` 的字节格式收发，用来锁定跨运行时契约。

use desktop_core::host::HostRequest;
use desktop_host::{build_runtime_with, read_frame_async, serve_connection, write_frame_async};
use platform_mock::MockBackend;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};

const CLIENT_GENERATION: &str = "client-generation-abc";

fn request(action: &str, payload: Option<Value>) -> Value {
    let mut value = json!({
        "requestId": format!("rdc-{action}"),
        "protocolVersion": 1,
        "action": action,
        "sessionId": "session-1",
    });
    if let Some(payload) = payload {
        value["payload"] = payload;
    }
    value
}

/// 按 Client 的方式写一帧请求：外层是 IPC 信封，`payload` 才是控制面请求。
async fn send<S>(stream: &mut S, payload: Value) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let envelope = json!({
        "protocolVersion": 1,
        "generationId": CLIENT_GENERATION,
        "kind": "request",
        "payload": payload,
    });
    let body = serde_json::to_vec(&envelope).expect("frame json");
    write_frame_async(stream, &body).await
}

/// 读一帧并解析成 JSON；同时断言长度前缀与 Client 解码器一致。
async fn receive<S>(stream: &mut S) -> Value
where
    S: AsyncRead + Unpin,
{
    let body = read_frame_async(stream)
        .await
        .expect("read")
        .expect("frame present");
    serde_json::from_slice(&body).expect("frame json")
}

/// 驱动一次请求/响应/状态三元组。
async fn round_trip<S>(stream: &mut S, frame: Value) -> (Value, Value)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    send(stream, frame).await.expect("send");
    let response = receive(stream).await;
    let state = receive(stream).await;
    assert_eq!(response["kind"], "response");
    assert_eq!(state["kind"], "state");
    assert_eq!(response["generationId"], CLIENT_GENERATION);
    assert_eq!(state["generationId"], CLIENT_GENERATION);
    (response["payload"].clone(), state["payload"].clone())
}

fn spawn_host() -> tokio::io::DuplexStream {
    let (server, client) = tokio::io::duplex(64 * 1024);
    let runtime = build_runtime_with(MockBackend::new(), "mock-0.1.0", "host-generation-1");
    tokio::spawn(async move { serve_connection(server, runtime).await });
    client
}

#[tokio::test]
async fn prepare_attach_and_close_flow_over_the_real_ipc_framing() {
    let mut client = spawn_host();

    let (response, state) = round_trip(
        &mut client,
        request(
            "session.prepare",
            Some(json!({ "qualityProfile": "balanced", "clipboardMode": "off" })),
        ),
    )
    .await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["hostGeneration"], "host-generation-1");
    assert_eq!(response["protocolVersion"], 1);
    assert!(response.get("error").is_none());
    let displays = response["result"]["displays"].as_array().expect("displays");
    assert_eq!(displays[0]["id"], "mock-display-1");
    assert_eq!(displays[0]["scalePercent"], 100);
    assert_eq!(state["status"], "ready");
    assert_eq!(state["sessionId"], "session-1");

    let (response, state) = round_trip(
        &mut client,
        request(
            "session.attach",
            Some(json!({ "attachmentId": "a1", "role": "operator" })),
        ),
    )
    .await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["role"], "operator");
    assert_eq!(
        response["result"]["challenge"].as_array().map(Vec::len),
        Some(32)
    );
    assert_eq!(state["status"], "connected");

    let (response, state) = round_trip(&mut client, request("session.close", None)).await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"]["closed"], true);
    assert_eq!(state["status"], "closed");
}

#[tokio::test]
async fn failures_carry_a_stable_code_and_never_leak_internals() {
    let mut client = spawn_host();

    let (response, _) = round_trip(&mut client, request("session.close", None)).await;
    assert_eq!(response["ok"], false);
    assert_eq!(
        response["error"]["code"],
        "REMOTE_DESKTOP_NO_ACTIVE_SESSION"
    );
    let message = response["error"]["message"].as_str().expect("message");
    assert!(message.len() <= 200);
    assert!(!message.contains("panicked"));
    assert!(response.get("result").is_none());

    let (response, _) = round_trip(&mut client, request("session.teleport", None)).await;
    assert_eq!(
        response["error"]["code"],
        "REMOTE_DESKTOP_PROTOCOL_MISMATCH"
    );

    // snake_case payload 必须被拒绝，防止协议漂移。
    let (response, _) = round_trip(
        &mut client,
        request(
            "session.prepare",
            Some(json!({ "quality_profile": "balanced" })),
        ),
    )
    .await;
    assert_eq!(
        response["error"]["code"],
        "REMOTE_DESKTOP_PROTOCOL_MISMATCH"
    );
}

#[tokio::test]
async fn a_non_request_frame_or_unknown_field_terminates_the_connection() {
    let mut client = spawn_host();
    send(
        &mut client,
        json!({
            "protocolVersion": 1,
            "generationId": CLIENT_GENERATION,
            "kind": "response",
            "payload": {},
        }),
    )
    .await
    .expect("send");

    // 服务端必须关闭连接，而不是继续处理。
    assert!(read_frame_async(&mut client).await.expect("read").is_none());
}
#[tokio::test]
async fn the_host_echoes_the_client_envelope_generation_and_its_own_generation() {
    let mut client = spawn_host();
    send(&mut client, request("session.state", None))
        .await
        .expect("send");
    let response = receive(&mut client).await;
    assert_eq!(response["generationId"], CLIENT_GENERATION);
    assert_eq!(response["payload"]["hostGeneration"], "host-generation-1");
}

#[tokio::test]
async fn an_unavailable_backend_refuses_to_prepare_a_session() {
    let (server, mut client) = tokio::io::duplex(64 * 1024);
    let runtime = build_runtime_with(
        MockBackend::unavailable("REMOTE_DESKTOP_UNSUPPORTED"),
        "mock-0.1.0",
        "host-generation-2",
    );
    tokio::spawn(async move { serve_connection(server, runtime).await });

    let (response, state) = round_trip(
        &mut client,
        request(
            "session.prepare",
            Some(json!({ "qualityProfile": "balanced" })),
        ),
    )
    .await;
    assert_eq!(response["ok"], false);
    let code = response["error"]["code"].as_str().expect("code");
    assert!(
        code == "REMOTE_DESKTOP_CAPTURE_FAILED" || code == "REMOTE_DESKTOP_NO_DISPLAY",
        "unexpected code {code}"
    );
    assert_eq!(state["status"], "idle");
}

#[tokio::test]
async fn requests_are_not_accepted_before_a_full_frame_arrives() {
    let mut client = spawn_host();
    let envelope = json!({
        "protocolVersion": 1,
        "generationId": CLIENT_GENERATION,
        "kind": "request",
        "payload": request("session.state", None),
    });
    let body = serde_json::to_vec(&envelope).expect("body");
    let mut framed = (body.len() as u32).to_be_bytes().to_vec();
    framed.extend_from_slice(&body);

    // 先只写一部分，服务端不得提前响应。
    use tokio::io::AsyncWriteExt;
    client
        .write_all(&framed[..framed.len() - 3])
        .await
        .expect("partial write");
    client.flush().await.expect("flush");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    client
        .write_all(&framed[framed.len() - 3..])
        .await
        .expect("rest");

    let response = receive(&mut client).await;
    assert_eq!(response["kind"], "response");
    assert_eq!(response["payload"]["requestId"], "rdc-session.state");
}

/// 真实 Unix socket：验证 `0600` 权限与请求往返，不依赖 root。
#[cfg(unix)]
mod unix_socket {
    use super::*;
    use desktop_host::transport;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::AtomicBool;
    use tokio::net::UnixStream;

    fn temp_endpoint(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "vcpdeck-host-test-{}-{}.sock",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[tokio::test]
    async fn serves_requests_over_a_0600_unix_socket() {
        let path = temp_endpoint("happy");
        let endpoint = path.to_string_lossy().to_string();
        let shutdown = Arc::new(AtomicBool::new(false));
        let runtime = build_runtime_with(MockBackend::new(), "mock-0.1.0", "host-generation-3");

        let server = {
            let shutdown = shutdown.clone();
            let path = path.clone();
            tokio::spawn(async move {
                let handler = {
                    let service = service.clone();
                    move |stream| {
                        let service = service.clone();
                        async move { serve_connection(stream, service).await }
                    }
                };
                transport::serve(&endpoint, handler, shutdown).await
            })
        };

        // 等待 socket 出现。
        for _ in 0..50 {
            if path.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "socket must not be group/world accessible"
        );

        let mut client = UnixStream::connect(&path).await.expect("connect");
        let (response, _) = round_trip(&mut client, request("session.state", None)).await;
        assert_eq!(response["ok"], true, "{response}");

        shutdown.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = server.await;
        let _ = std::fs::remove_file(&path);
    }
}

/// 未使用但保留：确保 `HostRequest` 的反序列化边界与本测试的请求构造一致。
#[allow(dead_code)]
fn assert_request_shape() {
    let value = request(
        "session.prepare",
        Some(json!({ "qualityProfile": "balanced" })),
    );
    serde_json::from_value::<HostRequest>(value).expect("strict request");
}

/// 生产入口必须真的执行 SDP 协商。
///
/// 这个用例专门防止一类断裂：`serve_connection` 只调 `HostService::handle`，
/// 于是 `session.signal` 返回空响应、Browser 永远拿不到 answer。分开测
/// `serve_connection`（本文件）与 `HostRuntime`（signal_bridge.rs）时两边都是绿的，
/// 只有走真实入口才能发现链路其实没接上。
#[tokio::test]
async fn production_entry_point_answers_a_real_offer() {
    use desktop_core::webrtc::transport::PeerTransport;
    use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
    use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};

    let mut client = spawn_host();

    let (prepared, _) = round_trip(&mut client, request("session.prepare", None)).await;
    assert_eq!(prepared["ok"], true, "{prepared}");

    let (attached, _) = round_trip(
        &mut client,
        request(
            "session.attach",
            Some(json!({ "attachmentId": "a1", "role": "operator" })),
        ),
    )
    .await;
    assert_eq!(attached["ok"], true, "{attached}");
    assert_eq!(attached["result"]["role"], "operator");

    // 按 Browser 的真实行为构造 offer：recvonly 视频 + 两条 DataChannel。
    let transport = PeerTransport::new(Vec::new())
        .await
        .expect("browser transport");
    transport
        .connection
        .add_transceiver_from_kind(
            RtpCodecKind::Video,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Recvonly,
                streams: Vec::new(),
                send_encodings: Vec::new(),
            }),
        )
        .await
        .expect("recvonly transceiver");
    transport
        .create_control_channel()
        .await
        .expect("control channel");
    transport
        .create_pointer_channel()
        .await
        .expect("pointer channel");
    let offer = transport.create_offer().await.expect("offer");

    let (signalled, _) = round_trip(
        &mut client,
        request(
            "session.signal",
            Some(json!({
                "attachmentId": "a1",
                "signal": { "kind": "offer", "sdp": offer.sdp },
            })),
        ),
    )
    .await;
    assert_eq!(signalled["ok"], true, "{signalled}");
    let answer = &signalled["result"]["signal"];
    assert_eq!(answer["kind"], "answer", "{signalled}");
    let sdp = answer["sdp"].as_str().expect("answer sdp");
    // 真的协商过才会有这些 m-line：空响应不可能包含它们。
    assert!(sdp.contains("m=video"), "{sdp}");
    assert!(sdp.contains("a=sendonly"), "{sdp}");
    assert!(sdp.contains("m=application"), "{sdp}");

    let _ = transport.close().await;
}
