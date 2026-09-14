//! 控制面信号桥：`session.signal` → 真实 WebRTC answer → challenge 下发。
//!
//! 这里使用真实 PeerConnection（本地 host candidate，不依赖网络或硬件），
//! 验证 Host 运行态把 IPC 请求与 WebRTC 协商接起来的完整路径。

use desktop_core::host::HostRequest;
use desktop_core::session::AttachmentRole;
use desktop_core::webrtc::transport::{receive_control_message, PeerTransport, TransportCodec};
use desktop_core::webrtc::ControlMessage;
use desktop_host::build_service_with;
use desktop_host::runtime::{ChallengeOutcome, HostRuntime, MediaOutcome};
use platform_mock::MockBackend;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};
use serde_json::{json, Value};
use std::time::Duration;

const BIND_TIMEOUT: Duration = Duration::from_secs(5);

/// 反复 pump 直到通道绑定有了结论。
///
/// 生产路径里 `pump` 是**非阻塞**的：它在 `session.signal` 响应写出后被后台任务调用，
/// 通道未齐就放回队列，靠后续 IPC 请求（每个 ICE 候选都算一次）继续推进——在锁内等待
/// 会把能让通道打开的 ICE 候选挡在锁外。测试没有后续请求，因此在这里显式重试。
async fn pump_until_settled(runtime: &mut HostRuntime<MockBackend>) -> Vec<ChallengeOutcome> {
    let deadline = tokio::time::Instant::now() + BIND_TIMEOUT;
    loop {
        let outcomes = runtime.pump().await;
        let settled = !outcomes.contains(&ChallengeOutcome::WarmingUp);
        if settled || tokio::time::Instant::now() >= deadline {
            return outcomes;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn runtime() -> HostRuntime<MockBackend> {
    let service = build_service_with(MockBackend::new(), "mock-0.1.0", "host-generation-1");
    HostRuntime::new(service, TransportCodec::Vp8, Vec::new()).with_bind_timeout(BIND_TIMEOUT)
}

fn request(action: &str, payload: Option<Value>) -> HostRequest {
    HostRequest {
        request_id: format!("rdc-{action}"),
        protocol_version: 1,
        action: action.to_string(),
        session_id: "session-1".to_string(),
        host_generation: None,
        payload,
    }
}

fn signal_request(attachment_id: &str, signal: Value) -> HostRequest {
    request(
        "session.signal",
        Some(json!({ "attachmentId": attachment_id, "signal": signal })),
    )
}

/// Browser 侧连接；与 `createRemoteDesktopPeer()` 行为一致。
struct Browser {
    transport: PeerTransport,
    control: std::sync::Arc<dyn webrtc::data_channel::DataChannel>,
}

impl Browser {
    async fn connect() -> (Self, String) {
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
        let control = transport
            .create_control_channel()
            .await
            .expect("control channel");
        transport
            .create_pointer_channel()
            .await
            .expect("pointer channel");
        let offer = transport.create_offer().await.expect("offer");
        (Self { transport, control }, offer.sdp)
    }

    async fn accept_answer(&self, sdp: &str) {
        let answer = webrtc::peer_connection::RTCSessionDescription::answer(sdp.to_string())
            .expect("answer parses");
        self.transport
            .set_remote_description(&answer)
            .await
            .expect("accept answer");
    }

    async fn close(self) {
        let _ = self.transport.close().await;
    }
}

/// 准备一个已 prepare、已 attach 的 Host，并返回 Browser 侧连接与 offer。
///
/// Viewer 必须是会话里的第二个 attachment：Host 总是把第一个 attachment 判定为
/// operator，申请 viewer 却会拿到 operator 的组合会被 Host 拒绝（fail closed）。
async fn prepared_attachment(
    runtime: &mut HostRuntime<MockBackend>,
    attachment_id: &str,
    role: &str,
) -> (Browser, String) {
    let prepared = runtime.handle(request("session.prepare", None)).await;
    assert!(prepared.ok, "{:?}", prepared.error);
    if role == "viewer" {
        let operator = runtime
            .handle(request(
                "session.attach",
                Some(json!({ "attachmentId": "operator-holder", "role": "operator" })),
            ))
            .await;
        assert!(operator.ok, "{:?}", operator.error);
    }
    let attached = runtime
        .handle(request(
            "session.attach",
            Some(json!({ "attachmentId": attachment_id, "role": role })),
        ))
        .await;
    assert!(attached.ok, "{:?}", attached.error);
    Browser::connect().await
}

#[tokio::test]
async fn requesting_viewer_for_the_first_attachment_is_rejected_over_ipc() {
    // Server 与 Host 角色不同步时不得默默提权：第一个 attachment 永远是 operator。
    let mut runtime = runtime();
    let prepared = runtime.handle(request("session.prepare", None)).await;
    assert!(prepared.ok);

    let denied = runtime
        .handle(request(
            "session.attach",
            Some(json!({ "attachmentId": "a1", "role": "viewer" })),
        ))
        .await;
    assert!(!denied.ok);
    assert_eq!(
        denied.error.expect("error").code,
        "REMOTE_DESKTOP_PERMISSION_DENIED"
    );
    assert_eq!(runtime.service().role_of("session-1", "a1"), None);
    runtime.release_all().await;
}

#[tokio::test]
async fn an_offer_returns_a_real_answer_and_queues_the_challenge() {
    let mut runtime = runtime();
    let (browser, offer_sdp) = prepared_attachment(&mut runtime, "a1", "operator").await;

    let response = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "offer", "sdp": offer_sdp }),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let answer = response.result.expect("result")["signal"].clone();
    assert_eq!(answer["kind"], "answer");
    let sdp = answer["sdp"].as_str().expect("sdp");
    assert!(sdp.contains("m=video"), "{sdp}");
    assert!(sdp.contains("a=sendonly"), "{sdp}");
    assert!(sdp.contains("m=application"), "{sdp}");
    // answer 必须携带 ICE 候选：Host 不对自身候选做 trickle（ICE 请求只处理
    // *来自* Browser 的候选），所以没有候选的 answer 意味着 Browser 永远连不上。
    assert!(
        sdp.contains("a=candidate"),
        "answer 缺少 ICE 候选，Browser 将永远无法完成 ICE:\n{sdp}"
    );

    // answer 必须在通道绑定之前返回；challenge 通过 pump 完成。
    assert_eq!(runtime.pending_count(), 1);
    assert!(!runtime.has_control_channel("a1"));

    browser.accept_answer(sdp).await;
    let outcomes = pump_until_settled(&mut runtime).await;
    assert_eq!(outcomes, vec![ChallengeOutcome::Sent]);
    assert!(runtime.has_control_channel("a1"));
    assert_eq!(
        runtime.channel_labels("a1"),
        vec!["control-reliable", "pointer-realtime"]
    );
    assert_eq!(runtime.control_session_count(), 1);

    let message = tokio::time::timeout(BIND_TIMEOUT, receive_control_message(&browser.control))
        .await
        .expect("challenge timeout")
        .expect("challenge");
    match message {
        ControlMessage::Challenge {
            nonce,
            attachment_id,
        } => {
            assert_eq!(nonce.len(), 32);
            assert_eq!(attachment_id, "a1");
            // Host 侧授权对象必须与下发的 nonce 一致。
            let sent = runtime
                .service()
                .challenge_for("a1")
                .expect("challenge")
                .nonce;
            assert_eq!(nonce, sent);
        }
        other => panic!("expected challenge, got {other:?}"),
    }

    runtime.release_all().await;
    browser.close().await;
}

#[tokio::test]
async fn an_sdp_answer_is_rejected_because_the_host_is_the_answerer() {
    let mut runtime = runtime();
    let (browser, _offer) = prepared_attachment(&mut runtime, "a1", "operator").await;

    let response = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "answer", "sdp": "v=0\r\n" }),
        ))
        .await;
    assert!(!response.ok);
    assert_eq!(
        response.error.expect("error").code,
        "REMOTE_DESKTOP_PROTOCOL_MISMATCH"
    );
    runtime.release_all().await;
    browser.close().await;
}

#[tokio::test]
async fn signaling_for_an_unknown_attachment_is_rejected() {
    let mut runtime = runtime();
    let prepared = runtime.handle(request("session.prepare", None)).await;
    assert!(prepared.ok);

    let response = runtime
        .handle(signal_request(
            "missing",
            json!({ "kind": "offer", "sdp": "v=0\r\n" }),
        ))
        .await;
    assert!(!response.ok);
    assert_eq!(
        response.error.expect("error").code,
        "REMOTE_DESKTOP_NO_ACTIVE_SESSION"
    );
    runtime.release_all().await;
}

#[tokio::test]
async fn a_malformed_signal_payload_is_rejected() {
    let mut runtime = runtime();
    let (browser, offer_sdp) = prepared_attachment(&mut runtime, "a1", "operator").await;

    // snake_case 字段必须被拒绝。
    let bad = runtime
        .handle(request(
            "session.signal",
            Some(json!({ "attachment_id": "a1", "signal": { "kind": "offer", "sdp": offer_sdp } })),
        ))
        .await;
    assert!(!bad.ok);
    assert_eq!(
        bad.error.expect("error").code,
        "REMOTE_DESKTOP_PROTOCOL_MISMATCH"
    );

    let unknown = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "candidate", "candidate": "x" }),
        ))
        .await;
    assert!(!unknown.ok);
    runtime.release_all().await;
    browser.close().await;
}

#[tokio::test]
async fn an_empty_offer_is_rejected_without_creating_a_peer() {
    let mut runtime = runtime();
    let (browser, _offer) = prepared_attachment(&mut runtime, "a1", "operator").await;

    let response = runtime
        .handle(signal_request("a1", json!({ "kind": "offer", "sdp": "" })))
        .await;
    assert!(!response.ok);
    assert_eq!(
        response.error.expect("error").code,
        "REMOTE_DESKTOP_PROTOCOL_MISMATCH"
    );
    assert_eq!(runtime.pending_count(), 0);
    assert_eq!(runtime.peers().len(), 0);
    runtime.release_all().await;
    browser.close().await;
}

#[tokio::test]
async fn ice_frames_are_accepted_only_after_a_peer_exists() {
    let mut runtime = runtime();
    let (browser, offer_sdp) = prepared_attachment(&mut runtime, "a1", "operator").await;

    let before = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "ice", "candidate": "candidate:1 1 udp 1 192.0.2.1 1 typ host" }),
        ))
        .await;
    assert!(!before.ok);
    assert_eq!(
        before.error.expect("error").code,
        "REMOTE_DESKTOP_ICE_FAILED"
    );

    assert!(
        runtime
            .handle(signal_request(
                "a1",
                json!({ "kind": "offer", "sdp": offer_sdp })
            ))
            .await
            .ok
    );
    let after = runtime
        .handle(signal_request("a1", json!({ "kind": "ice-complete" })))
        .await;
    assert!(after.ok, "{:?}", after.error);
    runtime.release_all().await;
    browser.close().await;
}

#[tokio::test]
async fn a_viewer_attachment_binds_only_the_control_channel_through_the_signal_path() {
    let mut runtime = runtime();
    let (browser, offer_sdp) = prepared_attachment(&mut runtime, "a1", "viewer").await;

    let response = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "offer", "sdp": offer_sdp }),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let sdp = response.result.expect("result")["signal"]["sdp"]
        .as_str()
        .expect("sdp")
        .to_string();
    browser.accept_answer(&sdp).await;

    assert_eq!(
        pump_until_settled(&mut runtime).await,
        vec![ChallengeOutcome::Sent]
    );
    // Viewer 只能拿到控制通道；即使 Browser 声明了指针通道也不绑定。
    assert_eq!(runtime.channel_labels("a1"), vec!["control-reliable"]);
    // 授权现在只存在于 HostService，因此计数包含会话里全部 attachment：
    // 占位 operator 与本次 viewer。
    assert_eq!(runtime.control_session_count(), 2);
    assert_eq!(
        runtime.service().role_of("session-1", "a1"),
        Some(AttachmentRole::Viewer)
    );
    runtime.release_all().await;
    browser.close().await;
}

#[tokio::test]
async fn releasing_an_attachment_drops_its_control_session_channels_and_pending_work() {
    let mut runtime = runtime();
    let (browser, offer_sdp) = prepared_attachment(&mut runtime, "a1", "operator").await;
    assert!(
        runtime
            .handle(signal_request(
                "a1",
                json!({ "kind": "offer", "sdp": offer_sdp })
            ))
            .await
            .ok
    );
    assert_eq!(runtime.pending_count(), 1);

    runtime.release("a1").await;
    assert_eq!(runtime.control_session_count(), 0);
    // 释放必须同时丢弃待办，避免后续 pump 去操作已不存在的连接。
    assert_eq!(runtime.pending_count(), 0);
    assert!(runtime.peers().peer("a1").is_none());
    assert_eq!(pump_until_settled(&mut runtime).await, Vec::new());
    runtime.release_all().await;
    browser.close().await;
}

#[tokio::test]
async fn a_missing_pointer_channel_closes_the_peer_instead_of_degrading() {
    let mut runtime = runtime();
    let prepared = runtime.handle(request("session.prepare", None)).await;
    assert!(prepared.ok);
    let attached = runtime
        .handle(request(
            "session.attach",
            Some(json!({ "attachmentId": "a1", "role": "operator" })),
        ))
        .await;
    assert!(attached.ok);

    // Browser 只创建控制通道：Operator 要求两条，必须 fail closed。
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
    let offer = transport.create_offer().await.expect("offer");

    let response = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "offer", "sdp": offer.sdp }),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let sdp = response.result.expect("result")["signal"]["sdp"]
        .as_str()
        .expect("sdp")
        .to_string();
    let answer = webrtc::peer_connection::RTCSessionDescription::answer(sdp).expect("answer");
    transport
        .set_remote_description(&answer)
        .await
        .expect("accept answer");

    let outcomes = pump_until_settled(&mut runtime).await;
    assert_eq!(outcomes, vec![ChallengeOutcome::ChannelMissing]);
    // 缺通道必须释放连接，不能留下可用一半的状态。
    assert!(!runtime.has_control_channel("a1"));
    assert_eq!(runtime.control_session_count(), 0);
    runtime.release_all().await;
    let _ = transport.close().await;
}

/// 输入链路的最后一跳：Browser 控制通道 → ControlSession → 平台后端。
///
/// 缺少通道读取任务时，challenge-response 与后续输入都不会被读出，
/// Browser 会一直停在未认证状态，平台也永远收不到输入。
#[tokio::test]
async fn operator_input_from_the_browser_reaches_the_platform_backend() {
    use desktop_core::webrtc::transport::send_control_message;
    use desktop_core::webrtc::ControlInput;

    let mut runtime = runtime();
    let (browser, offer_sdp) = prepared_attachment(&mut runtime, "a1", "operator").await;
    let response = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "offer", "sdp": offer_sdp }),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let sdp = response.result.expect("result")["signal"]["sdp"]
        .as_str()
        .expect("sdp")
        .to_string();
    browser.accept_answer(&sdp).await;
    assert_eq!(
        pump_until_settled(&mut runtime).await,
        vec![ChallengeOutcome::Sent]
    );

    // Host 下发 challenge；Browser 必须回应后才会被接受输入。
    let challenge = tokio::time::timeout(BIND_TIMEOUT, receive_control_message(&browser.control))
        .await
        .expect("challenge timeout")
        .expect("challenge");
    let ControlMessage::Challenge {
        nonce,
        attachment_id,
    } = challenge
    else {
        panic!("expected challenge");
    };
    send_control_message(
        &browser.control,
        &ControlMessage::ChallengeResponse {
            nonce,
            attachment_id,
        },
    )
    .await
    .expect("challenge response");

    // 认证 + 输入都要被后台任务读出并应用。
    send_control_message(
        &browser.control,
        &ControlMessage::Input {
            event: ControlInput::Key {
                key_code: 65,
                pressed: true,
            },
        },
    )
    .await
    .expect("key input");

    let backend = runtime.service().backend();
    let deadline = tokio::time::Instant::now() + BIND_TIMEOUT;
    while backend.injected_inputs().is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        backend.injected_inputs(),
        vec![desktop_core::media::InputEvent::Key {
            key_code: 65,
            pressed: true
        }],
        "平台后端必须真正收到键盘输入"
    );
    assert!(runtime.service().is_authenticated("a1"));

    runtime.release_all().await;
    browser.close().await;
}

/// 未认证的 Browser 直接发输入必须被拒绝，且不会到达平台。
#[tokio::test]
async fn unauthenticated_input_never_reaches_the_platform_backend() {
    use desktop_core::webrtc::transport::send_control_message;
    use desktop_core::webrtc::ControlInput;

    let mut runtime = runtime();
    let (browser, offer_sdp) = prepared_attachment(&mut runtime, "a1", "operator").await;
    let response = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "offer", "sdp": offer_sdp }),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let sdp = response.result.expect("result")["signal"]["sdp"]
        .as_str()
        .expect("sdp")
        .to_string();
    browser.accept_answer(&sdp).await;
    assert_eq!(
        pump_until_settled(&mut runtime).await,
        vec![ChallengeOutcome::Sent]
    );

    // 不回应 challenge，直接发输入。
    send_control_message(
        &browser.control,
        &ControlMessage::Input {
            event: ControlInput::Key {
                key_code: 66,
                pressed: true,
            },
        },
    )
    .await
    .expect("key input");

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        runtime.service().backend().injected_inputs().is_empty(),
        "未认证输入绝不能到达平台"
    );
    assert!(!runtime.service().is_authenticated("a1"));

    runtime.release_all().await;
    browser.close().await;
}

/// 完成 prepare + attach + 真实协商 + challenge-response，返回已认证的 Browser。
async fn authenticated_operator(
    mut runtime: &mut HostRuntime<MockBackend>,
    prepare_payload: Option<Value>,
) -> Browser {
    use desktop_core::webrtc::transport::send_control_message;

    let prepared = runtime
        .handle(request("session.prepare", prepare_payload))
        .await;
    assert!(prepared.ok, "{:?}", prepared.error);
    let attached = runtime
        .handle(request(
            "session.attach",
            Some(json!({ "attachmentId": "a1", "role": "operator" })),
        ))
        .await;
    assert!(attached.ok, "{:?}", attached.error);

    let (browser, offer_sdp) = Browser::connect().await;
    let response = runtime
        .handle(signal_request(
            "a1",
            json!({ "kind": "offer", "sdp": offer_sdp }),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let sdp = response.result.expect("result")["signal"]["sdp"]
        .as_str()
        .expect("sdp")
        .to_string();
    browser.accept_answer(&sdp).await;
    assert_eq!(
        pump_until_settled(runtime).await,
        vec![ChallengeOutcome::Sent]
    );

    let challenge = tokio::time::timeout(BIND_TIMEOUT, receive_control_message(&browser.control))
        .await
        .expect("challenge timeout")
        .expect("challenge");
    let ControlMessage::Challenge {
        nonce,
        attachment_id,
    } = challenge
    else {
        panic!("expected challenge");
    };
    send_control_message(
        &browser.control,
        &ControlMessage::ChallengeResponse {
            nonce,
            attachment_id,
        },
    )
    .await
    .expect("challenge response");
    browser
}

/// 等待某个条件在超时内成立，避免用固定 sleep 造成脆弱测试。
async fn wait_for(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + BIND_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if condition() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    condition()
}

/// 显示器切换必须把新的 layout 广播给 Browser，否则输入会永久冻结。
#[tokio::test]
async fn display_switch_broadcasts_layout_update_and_resumes_input() {
    use desktop_core::webrtc::transport::send_control_message;
    use desktop_core::webrtc::ControlInput;

    let mut runtime = runtime();
    let browser = authenticated_operator(&mut runtime, None).await;

    send_control_message(
        &browser.control,
        &ControlMessage::DisplaySelect {
            display_id: "mock-display-1".to_string(),
        },
    )
    .await
    .expect("display select");

    // Browser 必须收到 layout-update，否则会一直等一个不会来的确认目标。
    let update = tokio::time::timeout(BIND_TIMEOUT, receive_control_message(&browser.control))
        .await
        .expect("layout-update timeout")
        .expect("layout-update");
    let ControlMessage::LayoutUpdate {
        layout_generation,
        display_id,
        width,
        height,
    } = update
    else {
        panic!("expected layout-update, got {update:?}");
    };
    assert_eq!(display_id, "mock-display-1");
    assert!(layout_generation >= 1);
    assert_eq!((width, height), (1920, 1080));
    // 平台必须真正切换了捕获目标。
    let backend = runtime.service().backend();
    assert!(wait_for(|| backend.selected_display().as_deref() == Some("mock-display-1")).await);

    // 确认新 generation 后输入必须恢复可用。
    send_control_message(
        &browser.control,
        &ControlMessage::LayoutConfirm { layout_generation },
    )
    .await
    .expect("layout confirm");
    send_control_message(
        &browser.control,
        &ControlMessage::Input {
            event: ControlInput::Key {
                key_code: 66,
                pressed: true,
            },
        },
    )
    .await
    .expect("key input");
    assert!(
        wait_for(|| backend.injected_inputs().iter().any(|event| matches!(
            event,
            desktop_core::media::InputEvent::Key { key_code: 66, .. }
        )))
        .await,
        "确认布局后输入必须恢复并到达平台"
    );

    runtime.release_all().await;
    browser.close().await;
}

/// 剪贴板与控制消息共用可靠通道；剪贴板消息绝不能终止控制循环。
#[tokio::test]
async fn clipboard_on_the_control_channel_reaches_the_platform_without_killing_the_loop() {
    use desktop_core::webrtc::transport::send_control_message;
    use desktop_core::webrtc::ControlInput;

    let mut runtime = runtime();
    let browser = authenticated_operator(
        &mut runtime,
        Some(json!({ "clipboardMode": "browser-to-remote" })),
    )
    .await;

    // 剪贴板消息与控制消息走同一条通道，但类型不同。
    desktop_core::webrtc::transport::send_clipboard_message(
        &browser.control,
        &desktop_core::ClipboardMessage::BrowserToRemote {
            text: "clipboard payload".to_string(),
        },
    )
    .await
    .expect("clipboard message");

    let backend = runtime.service().backend();
    assert!(
        wait_for(|| backend.platform_clipboard().as_deref() == Some("clipboard payload")).await,
        "剪贴板文本必须写入平台"
    );

    // 关键断言：剪贴板消息之后控制循环仍然存活，输入继续被处理。
    send_control_message(
        &browser.control,
        &ControlMessage::Input {
            event: ControlInput::Key {
                key_code: 67,
                pressed: true,
            },
        },
    )
    .await
    .expect("key input");
    assert!(
        wait_for(|| backend.injected_inputs().iter().any(|event| matches!(
            event,
            desktop_core::media::InputEvent::Key { key_code: 67, .. }
        )))
        .await,
        "剪贴板消息不得终止控制循环"
    );

    runtime.release_all().await;
    browser.close().await;
}

/// 远端本机复制的文本必须推送给 Browser，且只在内容变化时推送一次。
#[tokio::test]
async fn host_clipboard_changes_are_pushed_to_the_browser_exactly_once() {
    use desktop_core::webrtc::transport::receive_clipboard_message;

    let mut runtime = runtime().with_clipboard_interval(Duration::from_millis(20));
    let browser = authenticated_operator(
        &mut runtime,
        Some(json!({ "clipboardMode": "bidirectional" })),
    )
    .await;
    let backend = runtime.service().backend();

    // 模拟远端本机复制了一段文本。
    backend.set_platform_clipboard(Some("copied on the host"));

    let pushed = tokio::time::timeout(BIND_TIMEOUT, receive_clipboard_message(&browser.control))
        .await
        .expect("push timeout")
        .expect("push");
    assert_eq!(
        pushed,
        desktop_core::ClipboardMessage::RemoteToBrowser {
            text: "copied on the host".to_string()
        }
    );

    // 内容未变化时不得重复推送（去重）。
    assert!(
        tokio::time::timeout(
            Duration::from_millis(200),
            receive_clipboard_message(&browser.control)
        )
        .await
        .is_err(),
        "未变化的剪贴板不得重复推送"
    );

    runtime.release_all().await;
    browser.close().await;
}

/// Browser 写入平台的文本不得被轮询读回并回声给 Browser。
#[tokio::test]
async fn browser_clipboard_is_never_echoed_back_by_the_clipboard_poll() {
    use desktop_core::webrtc::transport::receive_clipboard_message;

    let mut runtime = runtime().with_clipboard_interval(Duration::from_millis(20));
    let browser = authenticated_operator(
        &mut runtime,
        Some(json!({ "clipboardMode": "bidirectional" })),
    )
    .await;
    let backend = runtime.service().backend();

    desktop_core::webrtc::transport::send_clipboard_message(
        &browser.control,
        &desktop_core::ClipboardMessage::BrowserToRemote {
            text: "from the browser".to_string(),
        },
    )
    .await
    .expect("clipboard message");
    assert!(wait_for(|| backend.platform_clipboard().as_deref() == Some("from the browser")).await);

    // 轮询会读到同一份文本；识别为回声而不是回推，否则会无限往返。
    assert!(
        tokio::time::timeout(
            Duration::from_millis(300),
            receive_clipboard_message(&browser.control)
        )
        .await
        .is_err(),
        "写入平台的文本不得回声回 Browser"
    );

    runtime.release_all().await;
    browser.close().await;
}

/// 媒体循环必须把编码后的帧真正送给已连接的 attachment。
#[tokio::test]
async fn media_loop_sends_encoded_frames_to_attached_viewers() {
    let mut runtime = runtime().with_encoder_factory(std::sync::Arc::new(
        platform_mock::encoder::MockEncoderFactory { warmup: 1 },
    ));
    let browser = authenticated_operator(&mut runtime, None).await;

    let mut encoder = None;
    let mut delivered = 0usize;
    // 预热期会返回 WarmingUp；继续喂拍即可产出。
    for _ in 0..6 {
        if let MediaOutcome::Sent(count) = runtime.pump_media(&mut encoder).await {
            delivered = count;
            break;
        }
    }
    assert_eq!(delivered, 1, "媒体循环必须向已连接的 attachment 发送编码帧");

    runtime.release_all().await;
    browser.close().await;
}

/// 没有 viewer 时不得捕获（省掉无谓的屏幕拷贝与编码开销）。
#[tokio::test]
async fn media_loop_skips_capture_when_nobody_is_watching() {
    let mut runtime = runtime().with_encoder_factory(std::sync::Arc::new(
        platform_mock::encoder::MockEncoderFactory { warmup: 0 },
    ));
    let mut encoder = None;
    assert_eq!(
        runtime.pump_media(&mut encoder).await,
        MediaOutcome::NoViewer
    );
}

/// 未注入编码器工厂时必须如实报 NoEncoder，而不是静默什么都不做。
#[tokio::test]
async fn media_loop_reports_missing_encoder_instead_of_going_silent() {
    let mut runtime = runtime();
    let browser = authenticated_operator(&mut runtime, None).await;
    let mut encoder = None;
    assert_eq!(
        runtime.pump_media(&mut encoder).await,
        MediaOutcome::NoEncoder
    );
    runtime.release_all().await;
    browser.close().await;
}
