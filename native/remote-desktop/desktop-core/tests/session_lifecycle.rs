use desktop_core::protocol::{CapabilityStatus, DisplayInfo};
use desktop_core::session::{DesktopBackend, DesktopError, SessionManager, SessionState};
use std::sync::atomic::{AtomicUsize, Ordering};

struct TestBackend {
    releases: AtomicUsize,
}

impl DesktopBackend for TestBackend {
    fn capabilities(&self) -> Result<CapabilityStatus, DesktopError> {
        Ok(CapabilityStatus {
            physical_display: true,
            ..CapabilityStatus::new("unknown", "test", true, true, true)
        })
    }
    fn displays(&self) -> Result<Vec<DisplayInfo>, DesktopError> {
        Ok(vec![DisplayInfo {
            id: "display-1".into(),
            label: "Test".into(),
            width: 1280,
            height: 720,
            physical: true,
            virtual_display: false,
            primary: true,
            rotation: 0,
            scale_percent: 100,
        }])
    }
    fn release_all_inputs(&self) -> Result<(), DesktopError> {
        self.releases.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn inject_input(&self, _event: &desktop_core::media::InputEvent) -> Result<(), DesktopError> {
        Ok(())
    }
    fn secure_attention(&self) -> Result<(), DesktopError> {
        Err(DesktopError::Unsupported)
    }
    fn select_display(&self, display_id: &str) -> Result<(), DesktopError> {
        if display_id == "display-1" {
            Ok(())
        } else {
            Err(DesktopError::DisplayNotFound)
        }
    }
    fn write_clipboard_text(&self, _text: &str) -> Result<(), DesktopError> {
        Err(DesktopError::Unsupported)
    }
    fn read_clipboard_text(&self) -> Result<Option<String>, DesktopError> {
        Err(DesktopError::Unsupported)
    }
    fn capture_frame(
        &self,
        _display_id: Option<&str>,
    ) -> Result<desktop_core::media::CapturedFrame, DesktopError> {
        Err(DesktopError::Unsupported)
    }
}

#[test]
fn creates_one_operator_and_three_viewers_then_rejects_the_fifth() {
    let backend = TestBackend {
        releases: AtomicUsize::new(0),
    };
    let mut manager = SessionManager::new(backend);
    manager.create("s1".into()).unwrap();
    assert_eq!(
        format!(
            "{:?}",
            manager.attach("s1", "a1".into(), "secret".into()).unwrap()
        ),
        "Operator"
    );
    for id in ["a2", "a3", "a4"] {
        manager.attach("s1", id.into(), "secret".into()).unwrap();
    }
    assert_eq!(
        manager.attach("s1", "a5".into(), "secret".into()),
        Err(DesktopError::AttachmentLimit)
    );
    assert_eq!(manager.state("s1"), Some(SessionState::Connected));
}

#[test]
fn close_releases_all_inputs_and_is_terminal() {
    let backend = TestBackend {
        releases: AtomicUsize::new(0),
    };
    let mut manager = SessionManager::new(backend);
    manager.create("s1".into()).unwrap();
    manager.attach("s1", "a1".into(), "secret".into()).unwrap();
    manager.close("s1").unwrap();
    assert_eq!(manager.state("s1"), Some(SessionState::Closed));
    assert_eq!(manager.backend().releases.load(Ordering::SeqCst), 1);
}
