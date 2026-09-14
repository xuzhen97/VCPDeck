//! 验证「已授权的控制动作真正落到平台后端」这一跳。
//!
//! 这是 Host 输入链路的最后一跳：`ControlSession::handle` 只做授权与状态校验，
//! 必须由 dispatch 把动作映射为平台调用，否则输入永远不会到达操作系统。

use desktop_core::dispatch::apply_control_action;
use desktop_core::media::InputEvent;
use desktop_core::webrtc::ControlAction;
use platform_mock::MockBackend;

#[test]
fn keyboard_button_and_wheel_input_reach_the_backend() {
    let backend = MockBackend::new();
    for event in [
        InputEvent::Key {
            key_code: 65,
            pressed: true,
        },
        InputEvent::Button {
            button: 0,
            pressed: true,
        },
        InputEvent::Wheel {
            delta_x: 0,
            delta_y: -12,
        },
    ] {
        apply_control_action(&backend, &ControlAction::InputAccepted(event.clone()))
            .expect("input dispatch");
    }
    assert_eq!(
        backend.injected_inputs(),
        vec![
            InputEvent::Key {
                key_code: 65,
                pressed: true
            },
            InputEvent::Button {
                button: 0,
                pressed: true
            },
            InputEvent::Wheel {
                delta_x: 0,
                delta_y: -12
            },
        ]
    );
}

#[test]
fn pointer_moves_reach_the_backend_with_the_validated_sample() {
    let backend = MockBackend::new();
    apply_control_action(
        &backend,
        &ControlAction::PointerAccepted(desktop_core::media::PointerSample { x: 10, y: 20 }),
    )
    .expect("pointer dispatch");
    assert_eq!(
        backend.injected_inputs(),
        vec![InputEvent::PointerMove { x: 10, y: 20 }]
    );
}

#[test]
fn release_all_reaches_the_backend() {
    let backend = MockBackend::new();
    apply_control_action(&backend, &ControlAction::InputsReleased).expect("release dispatch");
    assert_eq!(backend.release_count(), 1);
    assert_eq!(backend.injected_inputs(), vec![InputEvent::ReleaseAll]);
}

#[test]
fn secure_attention_reaches_the_backend() {
    let backend = MockBackend::new();
    apply_control_action(&backend, &ControlAction::SecureAttentionRequested)
        .expect("secure attention dispatch");
    assert_eq!(backend.secure_attention_count(), 1);
}

#[test]
fn display_selection_reaches_the_backend() {
    let backend = MockBackend::new();
    apply_control_action(
        &backend,
        &ControlAction::DisplaySelected {
            display_id: "mock-display-1".to_string(),
            layout_generation: 1,
        },
    )
    .expect("display dispatch");
    assert_eq!(
        backend.selected_display().as_deref(),
        Some("mock-display-1")
    );
}

#[test]
fn unknown_display_selection_fails_closed_instead_of_silently_succeeding() {
    let backend = MockBackend::new();
    // 选择不存在的显示器必须报错，不能假装切成功。
    assert!(apply_control_action(
        &backend,
        &ControlAction::DisplaySelected {
            display_id: "does-not-exist".to_string(),
            layout_generation: 1,
        },
    )
    .is_err());
    assert_eq!(backend.selected_display(), None);
}

#[test]
fn pure_state_actions_have_no_platform_side_effects() {
    let backend = MockBackend::new();
    for action in [
        ControlAction::Authenticated,
        ControlAction::LayoutConfirmed {
            layout_generation: 7,
        },
    ] {
        apply_control_action(&backend, &action).expect("state action");
    }
    assert!(backend.injected_inputs().is_empty());
    assert_eq!(backend.release_count(), 0);
    assert_eq!(backend.secure_attention_count(), 0);
}

#[test]
fn an_unavailable_backend_rejects_input_and_secure_attention() {
    let backend = MockBackend::unavailable("REMOTE_DESKTOP_UNSUPPORTED");
    // 生产默认后端不得假装能注入输入或发送 SAS。
    assert!(apply_control_action(
        &backend,
        &ControlAction::InputAccepted(InputEvent::Key {
            key_code: 65,
            pressed: true
        }),
    )
    .is_err());
    assert!(apply_control_action(&backend, &ControlAction::SecureAttentionRequested).is_err());
    assert!(backend.injected_inputs().is_empty());
    assert_eq!(backend.secure_attention_count(), 0);
}
