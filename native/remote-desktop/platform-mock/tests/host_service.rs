//! Host 控制面：IPC 帧、严格请求路由、会话生命周期和状态上报。
//!
//! 这些测试只使用 `platform-mock`，不接触真实平台 API，也不建立真实网络连接。

use desktop_core::host::{
    decode_frame_bytes, encode_frame, encode_frame_body, FrameKind, HostFrame, HostRequest,
    HostService, MAX_IPC_FRAME_BYTES,
};
use desktop_core::session::AttachmentRole;
use platform_mock::MockBackend;
use serde_json::{json, Value};

fn host() -> HostService<MockBackend> {
    HostService::new(MockBackend::new(), "mock-0.1.0", "host-generation-1")
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

fn attach(host: &mut HostService<MockBackend>, attachment_id: &str, role: &str) -> bool {
    host.handle(request(
        "session.attach",
        Some(json!({ "attachmentId": attachment_id, "role": role })),
    ))
    .ok
}

#[test]
fn frame_round_trips_and_rejects_unknown_fields() {
    let frame = HostFrame {
        protocol_version: 1,
        generation_id: "gen-1".to_string(),
        kind: FrameKind::Request,
        payload: json!({ "action": "session.state" }),
    };
    let body = encode_frame_body(&frame).expect("encode");
    assert_eq!(decode_frame_bytes(&body).expect("decode"), frame);

    let framed = encode_frame(&frame).expect("frame");
    let length = u32::from_be_bytes([framed[0], framed[1], framed[2], framed[3]]) as usize;
    assert_eq!(length, body.len());

    let text = String::from_utf8(body).expect("utf8");
    let forged = format!("{}{}", text.trim_end_matches('}'), ",\"extra\":true}");
    assert!(decode_frame_bytes(forged.as_bytes()).is_err());
}

#[test]
fn frame_codec_rejects_oversized_and_non_utf8_frames() {
    let frame = HostFrame {
        protocol_version: 1,
        generation_id: "gen-1".to_string(),
        kind: FrameKind::State,
        payload: json!({ "blob": "x".repeat(MAX_IPC_FRAME_BYTES) }),
    };
    assert!(encode_frame_body(&frame).is_err());
    assert!(encode_frame(&frame).is_err());
    assert!(decode_frame_bytes(&[0xff, 0xfe, 0xfd]).is_err());
}

#[test]
fn prepare_returns_camel_case_displays_and_the_host_generation() {
    let mut host = host();
    let response = host.handle(request(
        "session.prepare",
        Some(json!({ "qualityProfile": "balanced", "clipboardMode": "off" })),
    ));
    assert!(response.ok, "{:?}", response.error);
    assert_eq!(response.host_generation, "host-generation-1");
    let result = response.result.expect("result");
    let displays = result["displays"].as_array().expect("displays");
    assert_eq!(displays.len(), 1);
    assert_eq!(displays[0]["id"], json!("mock-display-1"));
    assert_eq!(displays[0]["scalePercent"], json!(100));
    assert_eq!(displays[0]["virtual"], json!(false));
    assert!(displays[0].get("virtualDisplay").is_none());
}

#[test]
fn unknown_action_and_snake_case_payloads_are_rejected() {
    let mut host = host();
    let response = host.handle(request("session.teleport", None));
    assert!(!response.ok);
    assert_eq!(
        response.error.expect("error").code,
        "REMOTE_DESKTOP_PROTOCOL_MISMATCH"
    );

    let response = host.handle(request(
        "session.prepare",
        Some(json!({ "quality_profile": "balanced" })),
    ));
    assert!(!response.ok);

    let response = host.handle(request(
        "session.prepare",
        Some(json!({ "qualityProfile": "ultra" })),
    ));
    assert!(!response.ok);
}

#[test]
fn a_mismatched_protocol_version_is_rejected() {
    let mut host = host();
    let mut request = request("session.state", None);
    request.protocol_version = 2;
    let response = host.handle(request);
    assert!(!response.ok);
    assert_eq!(
        response.error.expect("error").code,
        "REMOTE_DESKTOP_PROTOCOL_MISMATCH"
    );
}

#[test]
fn attach_assigns_one_operator_and_then_viewers() {
    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);

    let operator = host.handle(request(
        "session.attach",
        Some(json!({ "attachmentId": "a1", "role": "operator" })),
    ));
    assert!(operator.ok, "{:?}", operator.error);
    assert_eq!(operator.result.expect("result")["role"], json!("operator"));

    let viewer = host.handle(request(
        "session.attach",
        Some(json!({ "attachmentId": "a2", "role": "viewer" })),
    ));
    assert!(viewer.ok);
    assert_eq!(viewer.result.expect("result")["role"], json!("viewer"));
    assert_eq!(
        host.role_of("session-1", "a1"),
        Some(AttachmentRole::Operator)
    );
    assert_eq!(
        host.role_of("session-1", "a2"),
        Some(AttachmentRole::Viewer)
    );
}

#[test]
fn the_fifth_attachment_is_rejected_with_the_attachment_limit_code() {
    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);
    assert!(attach(&mut host, "a1", "operator"));
    assert!(attach(&mut host, "a2", "viewer"));
    assert!(attach(&mut host, "a3", "viewer"));
    assert!(attach(&mut host, "a4", "viewer"));

    let denied = host.handle(request(
        "session.attach",
        Some(json!({ "attachmentId": "a5", "role": "viewer" })),
    ));
    assert!(!denied.ok);
    assert_eq!(
        denied.error.expect("error").code,
        "REMOTE_DESKTOP_ATTACHMENT_LIMIT"
    );
}

#[test]
fn requesting_viewer_first_is_rejected_instead_of_silently_granting_operator() {
    // Server 与 Host 不同步时（Server 认为自己是 viewer），Host 的第一个 attachment
    // 会成为 operator。默默提权是错误方向，必须回滚并拒绝。
    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);

    let denied = host.handle(request(
        "session.attach",
        Some(json!({ "attachmentId": "a1", "role": "viewer" })),
    ));
    assert!(!denied.ok);
    assert_eq!(
        denied.error.expect("error").code,
        "REMOTE_DESKTOP_PERMISSION_DENIED"
    );
    // 回滚必须彻底：不能留下已占用 operator 槽位的 attachment。
    assert_eq!(host.role_of("session-1", "a1"), None);
    assert!(host.challenge_for("a1").is_none());

    // 后续合法的 operator attach 仍然必须成功。
    assert!(attach(&mut host, "a1", "operator"));
    assert_eq!(
        host.role_of("session-1", "a1"),
        Some(AttachmentRole::Operator)
    );
}

#[test]
fn a_second_attachment_can_be_a_viewer_but_never_a_second_operator() {
    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);
    assert!(attach(&mut host, "a1", "operator"));
    assert!(attach(&mut host, "a2", "viewer"));
    assert_eq!(
        host.role_of("session-1", "a2"),
        Some(AttachmentRole::Viewer)
    );

    // Server 想要第二个 operator 也不行：控制权只能通过 takeover 获得。
    let denied = host.handle(request(
        "session.attach",
        Some(json!({ "attachmentId": "a3", "role": "operator" })),
    ));
    assert!(!denied.ok);
    assert_eq!(host.role_of("session-1", "a3"), None);
}

#[test]
fn attach_publishes_a_single_use_challenge_for_that_attachment() {
    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);
    assert!(attach(&mut host, "a1", "operator"));

    let challenge = host.challenge_for("a1").expect("challenge");
    assert_eq!(challenge.nonce.len(), 32);
    assert!(host.challenge_for("a2").is_none());
    assert!(!host.is_authenticated("a1"));
}

#[test]
fn detach_drops_the_operator_and_frees_the_slot() {
    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);
    assert!(attach(&mut host, "a1", "operator"));

    let detached = host.handle(request(
        "session.detach",
        Some(json!({ "attachmentId": "a1" })),
    ));
    assert!(detached.ok, "{:?}", detached.error);
    assert_eq!(host.role_of("session-1", "a1"), None);
    assert!(attach(&mut host, "a2", "operator"));
}

#[test]
fn freeze_input_releases_backend_inputs_and_resume_requires_the_operator() {
    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);
    assert!(attach(&mut host, "a1", "operator"));

    let frozen = host.handle(request(
        "session.freeze-input",
        Some(json!({ "attachmentId": "a1" })),
    ));
    assert!(frozen.ok, "{:?}", frozen.error);
    assert!(host.backend().release_count() >= 1);

    assert!(attach(&mut host, "a2", "viewer"));
    let denied = host.handle(request(
        "session.resume-input",
        Some(json!({ "attachmentId": "a2" })),
    ));
    assert!(!denied.ok);
    assert_eq!(
        denied.error.expect("error").code,
        "REMOTE_DESKTOP_PERMISSION_DENIED"
    );

    let resumed = host.handle(request(
        "session.resume-input",
        Some(json!({ "attachmentId": "a1" })),
    ));
    assert!(resumed.ok, "{:?}", resumed.error);
}

#[test]
fn state_report_marks_ready_then_connected_and_finally_closed() {
    let mut host = host();
    assert_eq!(host.state_report(None).status, "idle");

    assert!(host.handle(request("session.prepare", None)).ok);
    let ready = host.state_report(Some("session-1"));
    assert_eq!(ready.status, "ready");
    assert_eq!(ready.session_id.as_deref(), Some("session-1"));
    assert!(ready.capability.is_some());
    assert_eq!(ready.displays.as_ref().map(Vec::len), Some(1));

    assert!(attach(&mut host, "a1", "operator"));
    assert_eq!(host.state_report(Some("session-1")).status, "connected");

    assert!(host.handle(request("session.close", None)).ok);
    assert_eq!(host.state_report(Some("session-1")).status, "closed");
    assert_eq!(host.state_report(None).status, "idle");
}

#[test]
fn unknown_session_operations_fail_closed() {
    let mut host = host();
    let missing = host.handle(request("session.close", None));
    assert!(!missing.ok);
    assert_eq!(
        missing.error.expect("error").code,
        "REMOTE_DESKTOP_NO_ACTIVE_SESSION"
    );
}

#[test]
fn lease_expiry_reaps_the_frozen_session_and_releases_inputs() {
    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);
    assert!(attach(&mut host, "a1", "operator"));
    let releases_after_attach = host.backend().release_count();

    // freeze-input 会把租约时间回拨到失效点，下一次 reap 必须关闭会话。
    assert!(
        host.handle(request(
            "session.freeze-input",
            Some(json!({ "attachmentId": "a1" }))
        ))
        .ok
    );
    let reports = host.reap_expired();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].status, "closed");
    assert_eq!(host.state_report(Some("session-1")).status, "closed");
    assert!(host.backend().release_count() > releases_after_attach);
}

#[test]
fn display_selection_authority_is_the_control_session_and_requires_a_matching_confirm() {
    // 布局权威只存在于 attachment 的 ControlSession：pointer 消息就是按这个
    // generation 校验的。HostService 不再保存第二份布局状态。
    use desktop_core::webrtc::{ControlAction, ControlInput, ControlMessage};

    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);
    assert!(attach(&mut host, "a1", "operator"));

    let session = host.control_session("a1").expect("control session");
    let nonce = host.challenge_for("a1").expect("challenge").nonce;
    {
        let mut guard = session.lock().expect("lock");
        guard
            .handle(ControlMessage::ChallengeResponse {
                nonce,
                attachment_id: "a1".to_string(),
            })
            .expect("authenticate");
    }

    let before = session.lock().expect("lock").layout_generation();
    let action = session
        .lock()
        .expect("lock")
        .handle(ControlMessage::DisplaySelect {
            display_id: "mock-display-1".to_string(),
        })
        .expect("select");
    let ControlAction::DisplaySelected {
        display_id,
        layout_generation,
    } = action
    else {
        panic!("expected display selection");
    };
    assert_eq!(display_id, "mock-display-1");
    assert!(layout_generation > before);

    let press = || ControlMessage::Input {
        event: ControlInput::Key {
            key_code: 65,
            pressed: true,
        },
    };
    // 切换期间输入必须冻结。
    assert!(session.lock().expect("lock").handle(press()).is_err());
    // 旧 generation 的确认不能恢复输入。
    assert!(session
        .lock()
        .expect("lock")
        .handle(ControlMessage::LayoutConfirm {
            layout_generation: layout_generation - 1,
        })
        .is_ok());
    assert!(session.lock().expect("lock").handle(press()).is_err());
    // 匹配的确认才恢复输入。
    assert!(session
        .lock()
        .expect("lock")
        .handle(ControlMessage::LayoutConfirm { layout_generation })
        .is_ok());
    assert!(session.lock().expect("lock").handle(press()).is_ok());
}
#[test]
fn a_viewer_cannot_select_a_display() {
    use desktop_core::webrtc::ControlMessage;

    let mut host = host();
    assert!(host.handle(request("session.prepare", None)).ok);
    assert!(attach(&mut host, "a1", "operator"));
    assert!(attach(&mut host, "a2", "viewer"));

    let viewer = host.control_session("a2").expect("control session");
    let nonce = host.challenge_for("a2").expect("challenge").nonce;
    let mut guard = viewer.lock().expect("lock");
    guard
        .handle(ControlMessage::ChallengeResponse {
            nonce,
            attachment_id: "a2".to_string(),
        })
        .expect("authenticate");
    // 切换显示器会冻结整条会话的输入，Viewer 绝不得发起。
    assert!(guard
        .handle(ControlMessage::DisplaySelect {
            display_id: "mock-display-1".to_string(),
        })
        .is_err());
    assert_eq!(guard.layout_generation(), 0);
}
