#![forbid(unsafe_code)]

pub mod encoder;

use desktop_core::media::{CapturedFrame, InputEvent};
use desktop_core::protocol::{CapabilityStatus, DisplayInfo};
use desktop_core::session::{DesktopBackend, DesktopError};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

/// 可重复驱动的无平台后端，用于验证 Host 的能力、布局和输入释放语义。
#[derive(Debug)]
pub struct MockBackend {
    capability: CapabilityStatus,
    displays: Vec<DisplayInfo>,
    release_count: AtomicUsize,
    layout_generation: AtomicU64,
    injected: Mutex<Vec<InputEvent>>,
    secure_attention_count: AtomicUsize,
    selected_display: Mutex<Option<String>>,
    platform_clipboard: Mutex<Option<String>>,
    /// 后端是否真的能捕获与注入；`unavailable()` 后端必须为 false。
    input_supported: bool,
    capture_supported: bool,
}

impl MockBackend {
    /// 能力完整可用的测试后端；仅用于测试与 mock 场景。
    pub fn new() -> Self {
        Self {
            capability: CapabilityStatus {
                clipboard_text: true,
                login_screen: true,
                lock_screen: true,
                // 测试后端声明完整平台能力，才能驱动 Secure Attention 路径。
                secure_attention: true,
                physical_display: true,
                virtual_display: true,
                headless: true,
                hardware_encoders: vec!["mock".to_string()],
                supported_codecs: vec!["VP8".to_string(), "H264".to_string()],
                ..CapabilityStatus::new("unknown", "mock-0.1.0", true, true, true)
            },
            displays: vec![DisplayInfo {
                id: "mock-display-1".to_string(),
                label: "Mock Display".to_string(),
                width: 1920,
                height: 1080,
                physical: true,
                virtual_display: false,
                primary: true,
                rotation: 0,
                scale_percent: 100,
            }],
            release_count: AtomicUsize::new(0),
            layout_generation: AtomicU64::new(1),
            injected: Mutex::new(Vec::new()),
            secure_attention_count: AtomicUsize::new(0),
            selected_display: Mutex::new(None),
            platform_clipboard: Mutex::new(None),
            input_supported: true,
            capture_supported: true,
        }
    }

    /// 诚实上报“平台后端未接入”的后端。
    ///
    /// `desktop-host` 在真实平台 crate 落地前使用它：能力必须为 `available = false`，
    /// 否则会在没有捕获能力的情况下假装可用。
    pub fn unavailable(diagnostic_code: &str) -> Self {
        let mut backend = Self::new();
        backend.capability = CapabilityStatus::unavailable("unknown", diagnostic_code);
        backend.displays.clear();
        backend.input_supported = false;
        backend.capture_supported = false;
        backend
    }

    pub fn release_count(&self) -> usize {
        self.release_count.load(Ordering::SeqCst)
    }

    /// 平台实际收到的输入事件序列，按调用顺序。
    pub fn injected_inputs(&self) -> Vec<InputEvent> {
        self.injected.lock().expect("injected").clone()
    }

    pub fn secure_attention_count(&self) -> usize {
        self.secure_attention_count.load(Ordering::SeqCst)
    }

    pub fn selected_display(&self) -> Option<String> {
        self.selected_display.lock().expect("selected").clone()
    }

    /// 平台侧剪贴板文本；只有通过模式与角色校验的写入才会出现。
    pub fn platform_clipboard(&self) -> Option<String> {
        self.platform_clipboard.lock().expect("clipboard").clone()
    }

    /// 模拟远端本机复制了一段文本，用于驱动 Host → Browser 的剪贴板推送。
    pub fn set_platform_clipboard(&self, text: Option<&str>) {
        *self.platform_clipboard.lock().expect("clipboard") = text.map(str::to_string);
    }

    pub fn layout_generation(&self) -> u64 {
        self.layout_generation.load(Ordering::SeqCst)
    }

    pub fn bump_layout_generation(&self) -> u64 {
        self.layout_generation.fetch_add(1, Ordering::SeqCst) + 1
    }
}

impl Default for MockBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl DesktopBackend for MockBackend {
    fn capabilities(&self) -> Result<CapabilityStatus, DesktopError> {
        Ok(self.capability.clone())
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, DesktopError> {
        Ok(self.displays.clone())
    }

    fn release_all_inputs(&self) -> Result<(), DesktopError> {
        self.release_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn inject_input(&self, event: &InputEvent) -> Result<(), DesktopError> {
        if !self.input_supported {
            return Err(DesktopError::Unsupported);
        }
        self.injected.lock().expect("injected").push(event.clone());
        Ok(())
    }

    fn secure_attention(&self) -> Result<(), DesktopError> {
        if !self.capability.secure_attention {
            return Err(DesktopError::Unsupported);
        }
        self.secure_attention_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn select_display(&self, display_id: &str) -> Result<(), DesktopError> {
        if !self.displays.iter().any(|display| display.id == display_id) {
            return Err(DesktopError::DisplayNotFound);
        }
        *self.selected_display.lock().expect("selected") = Some(display_id.to_string());
        Ok(())
    }

    fn write_clipboard_text(&self, text: &str) -> Result<(), DesktopError> {
        if !self.capability.clipboard_text {
            return Err(DesktopError::Unsupported);
        }
        *self.platform_clipboard.lock().expect("clipboard") = Some(text.to_string());
        Ok(())
    }

    fn read_clipboard_text(&self) -> Result<Option<String>, DesktopError> {
        if !self.capability.clipboard_text {
            return Err(DesktopError::Unsupported);
        }
        Ok(self.platform_clipboard.lock().expect("clipboard").clone())
    }

    fn capture_frame(&self, display_id: Option<&str>) -> Result<CapturedFrame, DesktopError> {
        if !self.capture_supported {
            return Err(DesktopError::Unsupported);
        }
        let display = match display_id {
            Some(id) => self
                .displays
                .iter()
                .find(|display| display.id == id)
                .ok_or(DesktopError::DisplayNotFound)?,
            None => self.displays.first().ok_or(DesktopError::DisplayNotFound)?,
        };
        // 合成一帧确定性图案：只用于验证尺寸与像素传递链路，
        // 不代表真实屏幕内容，也不让测试冒充平台捕获。
        let width = display.width as usize;
        let height = display.height as usize;
        let mut pixels = vec![0u8; width * height * 4];
        for index in 0..width * height {
            pixels[index * 4] = (index % width) as u8;
            pixels[index * 4 + 1] = (index / width) as u8;
            pixels[index * 4 + 2] = 0x40;
            pixels[index * 4 + 3] = 0xff;
        }
        CapturedFrame::new(display.width, display.height, pixels)
            .map_err(|_| DesktopError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::MockBackend;
    use desktop_core::session::{DesktopBackend, SessionManager, SessionState};

    #[test]
    fn reports_safe_headless_capability_and_stable_layout_generation() {
        let backend = MockBackend::new();
        let capability = backend.capabilities().expect("capability");
        assert!(capability.available);
        assert!(capability.headless);
        assert_eq!(backend.layout_generation(), 1);
        assert_eq!(backend.bump_layout_generation(), 2);
    }

    #[test]
    fn unavailable_backend_reports_a_stable_diagnostic_and_no_displays() {
        let backend = MockBackend::unavailable("REMOTE_DESKTOP_UNSUPPORTED");
        let capability = backend.capabilities().expect("capability");
        assert!(!capability.available);
        assert!(!capability.capture);
        assert_eq!(
            capability.diagnostic_code.as_deref(),
            Some("REMOTE_DESKTOP_UNSUPPORTED")
        );
        assert!(backend.displays().expect("displays").is_empty());
    }

    #[test]
    fn session_close_releases_inputs_through_backend_contract() {
        let backend = MockBackend::new();
        let mut manager = SessionManager::new(backend);
        manager.create("mock-session".to_string()).expect("create");
        manager
            .attach("mock-session", "operator".to_string(), "secret".to_string())
            .expect("attach");
        manager.close("mock-session").expect("close");
        assert_eq!(manager.state("mock-session"), Some(SessionState::Closed));
        assert_eq!(manager.backend().release_count(), 1);
    }
}
