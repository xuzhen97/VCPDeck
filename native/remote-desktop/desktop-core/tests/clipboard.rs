use desktop_core::session::AttachmentRole;
use desktop_core::{ClipboardDirection, ClipboardError, ClipboardMode, ClipboardText};

#[test]
fn clipboard_modes_enforce_direction_and_operator_role() {
    let text = "hello".to_string();
    assert!(ClipboardMode::Off
        .validate(
            AttachmentRole::Operator,
            ClipboardDirection::BrowserToRemote,
            text.clone()
        )
        .is_err_and(|error| error == ClipboardError::Disabled));
    assert!(ClipboardMode::BrowserToRemote
        .validate(
            AttachmentRole::Viewer,
            ClipboardDirection::BrowserToRemote,
            text.clone()
        )
        .is_err_and(|error| error == ClipboardError::DirectionDenied));
    assert!(ClipboardMode::BrowserToRemote
        .validate(
            AttachmentRole::Operator,
            ClipboardDirection::BrowserToRemote,
            text.clone()
        )
        .is_ok());
    assert!(ClipboardMode::BrowserToRemote
        .validate(
            AttachmentRole::Operator,
            ClipboardDirection::RemoteToBrowser,
            text
        )
        .is_err_and(|error| error == ClipboardError::DirectionDenied));
}

#[test]
fn clipboard_text_has_a_byte_limit() {
    let too_large = "x".repeat(ClipboardText::MAX_BYTES + 1);
    assert_eq!(
        ClipboardText::new(too_large).unwrap_err(),
        ClipboardError::TooLarge
    );
}

#[test]
fn remote_clipboard_is_pushed_only_when_it_changes_and_the_mode_allows_it() {
    use desktop_core::webrtc::{ControlMessage, ControlSession};

    let mut bidirectional = ControlSession::new_with_clipboard(
        "a1",
        AttachmentRole::Operator,
        [3; 32],
        ClipboardMode::Bidirectional,
    );
    bidirectional
        .handle(ControlMessage::ChallengeResponse {
            nonce: [3; 32],
            attachment_id: "a1".to_string(),
        })
        .expect("authenticate");

    // 平台出现新文本时推送一次。
    let message = bidirectional
        .clipboard_to_browser(Some("copied on the host".to_string()))
        .expect("first push");
    assert_eq!(
        message,
        desktop_core::ClipboardMessage::RemoteToBrowser {
            text: "copied on the host".to_string()
        }
    );
    // 同一内容不得重复推送。
    assert!(bidirectional
        .clipboard_to_browser(Some("copied on the host".to_string()))
        .is_none());
    // 内容变化后再次推送。
    assert!(bidirectional
        .clipboard_to_browser(Some("second".to_string()))
        .is_some());
    // 平台无文本时不推送。
    assert!(bidirectional.clipboard_to_browser(None).is_none());
}

#[test]
fn clipboard_written_from_the_browser_is_never_echoed_back() {
    use desktop_core::webrtc::{ControlMessage, ControlSession};

    let mut session = ControlSession::new_with_clipboard(
        "a1",
        AttachmentRole::Operator,
        [4; 32],
        ClipboardMode::Bidirectional,
    );
    session
        .handle(ControlMessage::ChallengeResponse {
            nonce: [4; 32],
            attachment_id: "a1".to_string(),
        })
        .expect("authenticate");

    // Browser 发来的文本写入平台后，轮询会读到同一份内容。
    session
        .handle_clipboard(desktop_core::ClipboardMessage::BrowserToRemote {
            text: "from the browser".to_string(),
        })
        .expect("browser clipboard");
    session.note_clipboard_written("from the browser");

    // 必须识别为回声，不能回推给 Browser（否则会无限往返）。
    assert!(session
        .clipboard_to_browser(Some("from the browser".to_string()))
        .is_none());
}

#[test]
fn one_way_and_disabled_modes_never_push_remote_clipboard() {
    use desktop_core::webrtc::{ControlMessage, ControlSession};

    for (mode, label) in [
        (ClipboardMode::Off, "off"),
        (ClipboardMode::BrowserToRemote, "browser-to-remote"),
    ] {
        let mut session =
            ControlSession::new_with_clipboard("a1", AttachmentRole::Operator, [5; 32], mode);
        session
            .handle(ControlMessage::ChallengeResponse {
                nonce: [5; 32],
                attachment_id: "a1".to_string(),
            })
            .expect("authenticate");
        assert!(
            session
                .clipboard_to_browser(Some("host text".to_string()))
                .is_none(),
            "{label} 模式不得向 Browser 推送剪贴板"
        );
        // 模式不允许时不记录，之后才打开双向时仍能推送当前内容。
        assert!(session
            .clipboard_to_browser(Some("host text".to_string()))
            .is_none());
    }
}

#[test]
fn viewers_never_receive_remote_clipboard() {
    use desktop_core::webrtc::{ControlMessage, ControlSession};

    let mut viewer = ControlSession::new_with_clipboard(
        "v1",
        AttachmentRole::Viewer,
        [6; 32],
        ClipboardMode::Bidirectional,
    );
    viewer
        .handle(ControlMessage::ChallengeResponse {
            nonce: [6; 32],
            attachment_id: "v1".to_string(),
        })
        .expect("authenticate");
    // 剪贴板只对 Operator 开放，Viewer 不得收到远端剪贴板正文。
    assert!(viewer
        .clipboard_to_browser(Some("secret".to_string()))
        .is_none());
}

#[test]
fn oversized_remote_clipboard_is_not_pushed() {
    use desktop_core::webrtc::{ControlMessage, ControlSession};

    let mut session = ControlSession::new_with_clipboard(
        "a1",
        AttachmentRole::Operator,
        [7; 32],
        ClipboardMode::Bidirectional,
    );
    session
        .handle(ControlMessage::ChallengeResponse {
            nonce: [7; 32],
            attachment_id: "a1".to_string(),
        })
        .expect("authenticate");
    let oversized = "x".repeat(ClipboardText::MAX_BYTES + 1);
    assert!(session.clipboard_to_browser(Some(oversized)).is_none());
}
