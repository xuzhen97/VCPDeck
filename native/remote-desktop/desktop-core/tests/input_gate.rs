use desktop_core::media::{InputEvent, InputGate};
use desktop_core::session::AttachmentRole;

#[test]
fn viewer_cannot_inject_input() {
    let gate = InputGate::new(AttachmentRole::Viewer);
    assert_eq!(
        gate.accept(&InputEvent::PointerMove { x: 10, y: 20 }),
        Err(desktop_core::MediaError::ViewerInputDenied)
    );
}

#[test]
fn frozen_operator_cannot_inject_input() {
    let gate = InputGate::new(AttachmentRole::Operator).freeze();
    assert_eq!(
        gate.accept(&InputEvent::ReleaseAll),
        Err(desktop_core::MediaError::InputFrozen)
    );
}
