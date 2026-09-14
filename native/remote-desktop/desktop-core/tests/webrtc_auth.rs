use desktop_core::session::AttachmentRole;
use desktop_core::{
    decode_clipboard_message, decode_control_message, respond_to_challenge,
    AttachmentAuthorization, ChallengeResponse, ClipboardMode, ClipboardText, ControlAction,
    ControlInput, ControlMessage, ControlSession, DataChannelKind, InputEvent, PointerMessage,
    WebRtcError,
};

#[test]
fn unauthenticated_attachment_cannot_open_control_channel() {
    let auth = AttachmentAuthorization::new("a1", AttachmentRole::Operator, [7; 32]);
    assert_eq!(
        auth.authorize_channel(DataChannelKind::ControlReliable),
        Err(WebRtcError::NotAuthenticated)
    );
}

#[test]
fn challenge_is_single_attachment_and_role_gated() {
    let mut auth = AttachmentAuthorization::new("a1", AttachmentRole::Operator, [7; 32]);
    assert_eq!(
        auth.authenticate(ChallengeResponse {
            nonce: [8; 32],
            attachment_id: "a1".to_string(),
        }),
        Err(WebRtcError::ChallengeFailed)
    );
    auth.authenticate(ChallengeResponse {
        nonce: [7; 32],
        attachment_id: "a1".to_string(),
    })
    .unwrap();
    assert_eq!(
        auth.authorize_channel(DataChannelKind::ControlReliable)
            .unwrap(),
        DataChannelKind::ControlReliable.policy()
    );
    assert_eq!(
        DataChannelKind::PointerRealtime.policy(),
        desktop_core::DataChannelPolicy {
            ordered: false,
            max_retransmits: Some(0)
        }
    );
}

#[test]
fn viewer_can_authenticate_but_cannot_open_pointer_channel() {
    let mut auth = AttachmentAuthorization::new("viewer", AttachmentRole::Viewer, [9; 32]);
    auth.authenticate(ChallengeResponse {
        nonce: [9; 32],
        attachment_id: "viewer".to_string(),
    })
    .unwrap();
    assert_eq!(
        auth.authorize_channel(DataChannelKind::PointerRealtime),
        Err(WebRtcError::ViewerInputDenied)
    );
}

#[test]
fn control_messages_are_strict_and_challenge_response_is_attachment_bound() {
    let challenge = ControlMessage::Challenge {
        nonce: [3; 32],
        attachment_id: "operator-1".to_string(),
    };
    let encoded = serde_json::to_vec(&challenge).unwrap();
    assert_eq!(decode_control_message(&encoded).unwrap(), challenge);
    assert_eq!(
        respond_to_challenge(&challenge, "viewer-1"),
        Err(WebRtcError::ChallengeFailed)
    );
    assert_eq!(
        respond_to_challenge(&challenge, "operator-1").unwrap(),
        ControlMessage::ChallengeResponse {
            nonce: [3; 32],
            attachment_id: "operator-1".to_string(),
        }
    );

    let invalid = br#"{"type":"input","event":{"kind":"pointer-move","x":1,"y":2},"forged":true}"#;
    assert_eq!(
        decode_control_message(invalid),
        Err(WebRtcError::InvalidControlMessage)
    );
}

#[test]
fn pointer_message_is_strictly_decoded_and_layout_bound() {
    let pointer = PointerMessage {
        layout_generation: 7,
        x: 600,
        y: 400,
    };
    let encoded = serde_json::to_vec(&pointer).unwrap();
    assert_eq!(
        desktop_core::decode_pointer_message(&encoded).unwrap(),
        pointer
    );
    assert_eq!(
        desktop_core::decode_pointer_message(
            br#"{"layoutGeneration":7,"x":600,"y":400,"forged":true}"#
        ),
        Err(WebRtcError::InvalidPointerMessage)
    );

    let mut viewer = ControlSession::new("viewer-1", AttachmentRole::Viewer, [7; 32]);
    viewer
        .handle(ControlMessage::ChallengeResponse {
            nonce: [7; 32],
            attachment_id: "viewer-1".to_string(),
        })
        .unwrap();
    assert_eq!(
        viewer.handle_pointer(pointer),
        Err(WebRtcError::ViewerInputDenied)
    );

    let mut operator = ControlSession::new("operator-1", AttachmentRole::Operator, [8; 32]);
    operator
        .handle(ControlMessage::ChallengeResponse {
            nonce: [8; 32],
            attachment_id: "operator-1".to_string(),
        })
        .unwrap();
    operator.input_mut().set_layout_generation(8);
    assert_eq!(
        operator.handle_pointer(PointerMessage {
            layout_generation: 7,
            x: 1,
            y: 2,
        }),
        Err(WebRtcError::StaleLayout)
    );
}

#[test]
fn clipboard_messages_are_strictly_decoded_and_role_gated() {
    let message = desktop_core::ClipboardMessage::BrowserToRemote {
        text: "hello".to_string(),
    };
    let encoded = serde_json::to_vec(&message).unwrap();
    assert_eq!(decode_clipboard_message(&encoded).unwrap(), message);
    assert_eq!(
        decode_clipboard_message(br#"{"type":"browser-to-remote","text":"hello","forged":true}"#),
        Err(WebRtcError::InvalidClipboardMessage)
    );

    let mut operator = ControlSession::new_with_clipboard(
        "operator-1",
        AttachmentRole::Operator,
        [10; 32],
        ClipboardMode::Bidirectional,
    );
    operator
        .handle(ControlMessage::ChallengeResponse {
            nonce: [10; 32],
            attachment_id: "operator-1".to_string(),
        })
        .unwrap();
    assert_eq!(
        operator.handle_clipboard(message),
        Ok(ClipboardText::new("hello".to_string()).unwrap())
    );
    assert_eq!(
        operator.handle_clipboard(desktop_core::ClipboardMessage::RemoteToBrowser {
            text: "remote".to_string(),
        }),
        Err(WebRtcError::UnsupportedControlAction)
    );

    let mut viewer = ControlSession::new_with_clipboard(
        "viewer-1",
        AttachmentRole::Viewer,
        [11; 32],
        ClipboardMode::Bidirectional,
    );
    viewer
        .handle(ControlMessage::ChallengeResponse {
            nonce: [11; 32],
            attachment_id: "viewer-1".to_string(),
        })
        .unwrap();
    assert_eq!(
        viewer.handle_clipboard(desktop_core::ClipboardMessage::BrowserToRemote {
            text: "forbidden".to_string(),
        }),
        Err(WebRtcError::ViewerInputDenied)
    );

    let mut disabled = ControlSession::new("operator-2", AttachmentRole::Operator, [12; 32]);
    disabled
        .handle(ControlMessage::ChallengeResponse {
            nonce: [12; 32],
            attachment_id: "operator-2".to_string(),
        })
        .unwrap();
    assert_eq!(
        disabled.handle_clipboard(desktop_core::ClipboardMessage::BrowserToRemote {
            text: "disabled".to_string(),
        }),
        Err(WebRtcError::ClipboardDisabled)
    );

    let too_large = format!(
        "{{\"type\":\"browser-to-remote\",\"text\":\"{}\"}}",
        "x".repeat(262_145)
    );
    assert_eq!(
        decode_clipboard_message(too_large.as_bytes()),
        Err(WebRtcError::ClipboardTooLarge)
    );
}

#[test]
fn display_selection_freezes_until_matching_layout_confirmation() {
    let mut session = ControlSession::new("operator-1", AttachmentRole::Operator, [13; 32]);
    session
        .handle(ControlMessage::ChallengeResponse {
            nonce: [13; 32],
            attachment_id: "operator-1".to_string(),
        })
        .unwrap();
    session.input_mut().set_layout_generation(8);
    assert_eq!(
        session.handle(ControlMessage::DisplaySelect {
            display_id: "display-2".to_string(),
        }),
        Ok(ControlAction::DisplaySelected {
            display_id: "display-2".to_string(),
            // 切换必须推进 generation（8 → 9），旧 generation 的输入随即失效。
            layout_generation: 9,
        })
    );
    assert_eq!(
        desktop_core::decode_control_message(
            br#"{"type":"display-select","displayId":"display-2"}"#,
        )
        .unwrap(),
        ControlMessage::DisplaySelect {
            display_id: "display-2".to_string(),
        }
    );
    assert_eq!(
        desktop_core::decode_control_message(br#"{"type":"layout-confirm","layout_generation":8}"#,),
        Err(WebRtcError::InvalidControlMessage)
    );
    assert_eq!(
        session.handle(ControlMessage::LayoutConfirm {
            layout_generation: 7,
        }),
        Ok(ControlAction::LayoutConfirmed {
            layout_generation: 7,
        })
    );
    assert_eq!(
        session.handle(ControlMessage::Input {
            event: ControlInput::PointerMove { x: 1, y: 2 },
        }),
        Err(WebRtcError::InputFrozen)
    );
    // Browser 必须确认切换后拿到的新 generation，而不能拿切换前的旧值。
    assert_eq!(
        session.handle(ControlMessage::LayoutConfirm {
            layout_generation: 9,
        }),
        Ok(ControlAction::LayoutConfirmed {
            layout_generation: 9,
        })
    );
    assert_eq!(
        session.handle(ControlMessage::Input {
            event: ControlInput::PointerMove { x: 3, y: 4 },
        }),
        // 动作必须携带事件本体，否则平台收不到输入。
        Ok(ControlAction::InputAccepted(InputEvent::PointerMove {
            x: 3,
            y: 4,
        }))
    );
}

#[test]
fn challenge_response_is_single_use_and_frozen_input_is_rejected() {
    let mut session = ControlSession::new("operator-1", AttachmentRole::Operator, [6; 32]);
    let response = ControlMessage::ChallengeResponse {
        nonce: [6; 32],
        attachment_id: "operator-1".to_string(),
    };
    assert_eq!(
        session.handle(response.clone()),
        Ok(ControlAction::Authenticated)
    );
    assert_eq!(
        session.handle(response),
        Err(WebRtcError::ChallengeAlreadyUsed)
    );
    session.input_mut().freeze();
    assert_eq!(
        session.handle(ControlMessage::Input {
            event: ControlInput::PointerMove { x: 1, y: 2 },
        }),
        Err(WebRtcError::InputFrozen)
    );
}

#[test]
fn control_session_requires_authentication_and_routes_only_operator_input() {
    let mut operator = ControlSession::new("operator-1", AttachmentRole::Operator, [4; 32]);
    assert_eq!(
        operator.handle(ControlMessage::Input {
            event: ControlInput::PointerMove { x: 10, y: 20 },
        }),
        Err(WebRtcError::NotAuthenticated)
    );
    assert_eq!(
        operator.handle(ControlMessage::ChallengeResponse {
            nonce: [4; 32],
            attachment_id: "operator-1".to_string(),
        }),
        Ok(ControlAction::Authenticated)
    );
    assert_eq!(
        operator.handle(ControlMessage::Input {
            event: ControlInput::PointerMove { x: 10, y: 20 },
        }),
        Ok(ControlAction::InputAccepted(InputEvent::PointerMove {
            x: 10,
            y: 20,
        }))
    );
    assert_eq!(operator.input_mut().next_pointer().unwrap().x, 10);

    let mut viewer = ControlSession::new("viewer-1", AttachmentRole::Viewer, [5; 32]);
    viewer
        .handle(ControlMessage::ChallengeResponse {
            nonce: [5; 32],
            attachment_id: "viewer-1".to_string(),
        })
        .unwrap();
    assert_eq!(
        viewer.handle(ControlMessage::Input {
            event: ControlInput::PointerMove { x: 30, y: 40 },
        }),
        Err(WebRtcError::ViewerInputDenied)
    );
}

#[test]
fn wheel_and_key_control_input_use_camel_case_wire_fields() {
    let message = br#"{"type":"input","event":{"kind":"wheel","deltaX":4,"deltaY":-12}}"#;
    let decoded = desktop_core::decode_control_message(message).unwrap();
    assert_eq!(
        decoded,
        ControlMessage::Input {
            event: ControlInput::Wheel {
                delta_x: 4,
                delta_y: -12,
            },
        }
    );
    assert_eq!(
        serde_json::to_string(&decoded).unwrap(),
        r#"{"type":"input","event":{"kind":"wheel","deltaX":4,"deltaY":-12}}"#
    );
    assert_eq!(
        desktop_core::decode_control_message(
            br#"{"type":"input","event":{"kind":"key","keyCode":65,"pressed":true}}"#
        )
        .unwrap(),
        ControlMessage::Input {
            event: ControlInput::Key {
                key_code: 65,
                pressed: true,
            },
        }
    );
    assert_eq!(
        serde_json::to_string(&ControlMessage::Input {
            event: ControlInput::Key {
                key_code: 65,
                pressed: true,
            },
        })
        .unwrap(),
        r#"{"type":"input","event":{"kind":"key","keyCode":65,"pressed":true}}"#
    );
    assert_eq!(
        desktop_core::decode_control_message(
            br#"{"type":"input","event":{"kind":"wheel","delta_x":4,"delta_y":-12}}"#
        ),
        Err(WebRtcError::InvalidControlMessage)
    );
}

#[test]
fn secure_attention_requires_operator_and_ignores_freeze() {
    let mut session = ControlSession::new("operator-1", AttachmentRole::Operator, [21; 32]);
    // 未认证前不得请求 Secure Attention。
    assert_eq!(
        session.handle(ControlMessage::SecureAttention),
        Err(WebRtcError::NotAuthenticated)
    );
    session
        .handle(ControlMessage::ChallengeResponse {
            nonce: [21; 32],
            attachment_id: "operator-1".to_string(),
        })
        .unwrap();
    // 冻结（登录屏/锁屏切换）期间仍然可用：它不是输入注入。
    session.input_mut().set_layout_generation(4);
    assert_eq!(
        session.handle(ControlMessage::DisplaySelect {
            display_id: "display-2".to_string(),
        }),
        Ok(ControlAction::DisplaySelected {
            display_id: "display-2".to_string(),
            layout_generation: 5,
        })
    );
    assert_eq!(
        session.handle(ControlMessage::SecureAttention),
        Ok(ControlAction::SecureAttentionRequested)
    );
    // 解码路径必须与 Shared 一致：只有裸 {type} 才合法。
    assert_eq!(
        desktop_core::decode_control_message(br#"{"type":"secure-attention"}"#).unwrap(),
        ControlMessage::SecureAttention
    );
}

#[test]
fn viewers_cannot_request_secure_attention() {
    let mut session = ControlSession::new("viewer-1", AttachmentRole::Viewer, [22; 32]);
    session
        .handle(ControlMessage::ChallengeResponse {
            nonce: [22; 32],
            attachment_id: "viewer-1".to_string(),
        })
        .unwrap();
    // Ctrl+Alt+Del 是提权动作，Viewer 绝不能触发。
    assert_eq!(
        session.handle(ControlMessage::SecureAttention),
        Err(WebRtcError::ViewerInputDenied)
    );
}
