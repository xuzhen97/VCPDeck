//! Windows 平台后端。
//!
//! 本 crate 只负责「把桌面操作的平台细节落到 Win32」：显示器枚举、输入注入、
//! 剪贴板读写与能力探测。会话、授权、布局 generation 与 WebRTC 都在
//! `desktop-core` / `desktop-host`，不在这里重复实现。
//!
//! **诚实上报原则**：任何尚未真实实现的能力都必须报 `false`。捕获与编码器
//! 尚未接入时，能力摘要必须保持 `available = false`，绝不能因为「平台是
//! Windows」就假定可用——上层会据此展示入口并允许创建会话。

#![deny(unsafe_code)]

use desktop_core::media::{CapturedFrame, InputEvent};
use desktop_core::protocol::{CapabilityStatus, DisplayInfo};
use desktop_core::session::{DesktopBackend, DesktopError};

// Win32 FFI 必须逐模块显式开启 `unsafe`：crate 其余部分仍然是 deny。
// 用 `deny` 而非 `forbid`，因为 `forbid` 无法被内部 `allow` 覆盖。
#[allow(unsafe_code)]
#[cfg(windows)]
mod win;

// Media Foundation 编码器探测：绑定来自 `windows` crate。
#[allow(unsafe_code)]
#[cfg(windows)]
mod mf;

// Media Foundation H.264 编码器（同步路径）。
//
// 已接入生产：desktop-host 通过 WindowsEncoderFactory 把它交给媒体循环，
// 媒体循环在独占线程上创建与使用（COM 套间归属）。
#[allow(unsafe_code)]
#[cfg(windows)]
pub mod encoder;

/// 未接入真实捕获实现时的稳定诊断码。
pub const ENCODER_UNAVAILABLE: &str = "REMOTE_DESKTOP_ENCODER_UNAVAILABLE";
/// 真实探测到无法捕获时的稳定诊断码。
pub const CAPTURE_UNAVAILABLE: &str = "REMOTE_DESKTOP_CAPTURE_UNAVAILABLE";
/// 会话辅助不可用（登录屏/锁屏路径尚未接入）。
pub const SESSION_HELPER_UNAVAILABLE: &str = "REMOTE_DESKTOP_SESSION_HELPER_UNAVAILABLE";

/// Windows 桌面后端。
pub struct WindowsBackend {
    /// 显示器几何；保留 left/top 才能在多显示器下把归一化坐标映射到正确屏幕。
    #[cfg(windows)]
    monitors: Vec<win::MonitorRect>,
    displays: Vec<DisplayInfo>,
    selected_display: std::sync::Mutex<Option<String>>,
    /// 捕获探测结果；启动时真跑一次 BitBlt 决定。
    capture_probed: bool,
    /// 真实探测到的 H.264 编码器 MFT。
    #[cfg(windows)]
    encoders: Vec<mf::EncoderInfo>,
    /// 是否真的成功配置出过一个编码器（决定能否上报 H264）。
    encoder_probed: bool,
}

impl WindowsBackend {
    /// 探测当前平台能力并构造后端。
    ///
    /// 探测失败不影响构造：能力摘要会如实反映「探测到什么」，而不是直接报错。
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            let monitors = win::probe_monitors();
            let displays = win::displays_from_monitors(&monitors);
            // 真跑一次捕获：只有能拿到帧才敢报 capture = true。
            let capture_probed = win::capture_frame(&monitors, None).is_ok();
            let encoders = mf::probe_h264_encoders();
            // 真配置一次编码器：探测到编码器 MFT ≠ 能用它编码，只有配置成功
            // 才敢把 H264 写进 supportedCodecs。
            let encoder_probed = encoder::H264Encoder::new(320, 240, 1_000, 30).is_ok();
            Self {
                monitors,
                displays,
                selected_display: std::sync::Mutex::new(None),
                capture_probed,
                encoders,
                encoder_probed,
            }
        }
        #[cfg(not(windows))]
        {
            Self {
                displays: Vec::new(),
                selected_display: std::sync::Mutex::new(None),
                capture_probed: false,
                encoder_probed: false,
            }
        }
    }

    /// 真正可用的硬件编码器厂商列表（已去重、排序）。
    fn hardware_encoders(&self) -> Vec<String> {
        #[cfg(windows)]
        {
            let mut vendors: Vec<String> = self
                .encoders
                .iter()
                .filter(|encoder| encoder.hardware)
                .filter_map(|encoder| encoder.vendor.clone())
                .collect();
            vendors.sort();
            vendors.dedup();
            vendors
        }
        #[cfg(not(windows))]
        {
            Vec::new()
        }
    }

    /// 生成能力摘要。捕获与编码器未接入时保持不可用。
    pub fn capability(&self) -> CapabilityStatus {
        let physical = !self.displays.is_empty();
        let mut capability =
            CapabilityStatus::new("windows", env!("CARGO_PKG_VERSION"), false, true, true);
        capability.clipboard_text = true;
        capability.physical_display = physical;
        capability.virtual_display = false;
        capability.headless = false;
        // 捕获能力必须**实际探测**：真跑一次 BitBlt 才知道在会话 0、锁屏或
        // 受保护内容下是否可行。未探测到就不报，绝不假设。
        capability.capture = self.capture_probed;
        // 硬件编码器来自真实 MFT 探测，而不是写死。
        capability.hardware_encoders = self.hardware_encoders();
        // 只有真的配置成功过编码器才上报 H264；`into_available()` 会
        // 要求 capture + pointer + keyboard + 非空 codecs 同时成立才给 available。
        capability.supported_codecs = if self.encoder_probed {
            vec!["H264".to_string()]
        } else {
            Vec::new()
        };
        // available 必须由子能力**重新推导**：构造时 capture 尚未探测（为 false），
        // 若沿用那一刻算出的 available，探测成功后就会出现
        // “capture/pointer/keyboard 全真、codecs 非空，但 available 仍为 false”
        // 的不自洽状态——功能可用却对上层报告不可用。
        capability.available = capability.capture
            && capability.pointer
            && capability.keyboard
            && !capability.supported_codecs.is_empty();
        capability.diagnostic_code = if capability.available {
            None
        } else if capability.supported_codecs.is_empty() {
            Some(ENCODER_UNAVAILABLE.to_string())
        } else {
            Some(CAPTURE_UNAVAILABLE.to_string())
        };
        capability.into_available()
    }
}

impl Default for WindowsBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl DesktopBackend for WindowsBackend {
    fn capabilities(&self) -> Result<CapabilityStatus, DesktopError> {
        Ok(self.capability())
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, DesktopError> {
        if self.displays.is_empty() {
            return Err(DesktopError::Unsupported);
        }
        Ok(self.displays.clone())
    }

    fn release_all_inputs(&self) -> Result<(), DesktopError> {
        #[cfg(windows)]
        {
            win::release_all_inputs()
        }
        #[cfg(not(windows))]
        {
            Err(DesktopError::Unsupported)
        }
    }

    fn inject_input(&self, event: &InputEvent) -> Result<(), DesktopError> {
        #[cfg(windows)]
        {
            let selected = self
                .selected_display
                .lock()
                .ok()
                .and_then(|guard| guard.clone());
            win::inject_input(&self.monitors, selected.as_deref(), event)
        }
        #[cfg(not(windows))]
        {
            let _ = event;
            Err(DesktopError::Unsupported)
        }
    }

    fn secure_attention(&self) -> Result<(), DesktopError> {
        // 能力驱动：真实探测通过之前绝不实现，也不上报支持。
        Err(DesktopError::Unsupported)
    }

    fn select_display(&self, display_id: &str) -> Result<(), DesktopError> {
        if !self.displays.iter().any(|display| display.id == display_id) {
            return Err(DesktopError::DisplayNotFound);
        }
        *self
            .selected_display
            .lock()
            .map_err(|_| DesktopError::Unsupported)? = Some(display_id.to_string());
        Ok(())
    }

    fn write_clipboard_text(&self, text: &str) -> Result<(), DesktopError> {
        #[cfg(windows)]
        {
            win::write_clipboard_text(text)
        }
        #[cfg(not(windows))]
        {
            let _ = text;
            Err(DesktopError::Unsupported)
        }
    }

    fn read_clipboard_text(&self) -> Result<Option<String>, DesktopError> {
        #[cfg(windows)]
        {
            win::read_clipboard_text()
        }
        #[cfg(not(windows))]
        {
            Err(DesktopError::Unsupported)
        }
    }

    fn capture_frame(&self, display_id: Option<&str>) -> Result<CapturedFrame, DesktopError> {
        #[cfg(windows)]
        {
            // `None` 表示“用当前选中的显示器”，而不是永远主屏：
            // 操作者通过 display-select 选过屏幕后，捕获必须跟着切过去，
            // 否则远端看到的与操作的会不是同一块屏幕。
            let selected = self
                .selected_display
                .lock()
                .ok()
                .and_then(|guard| guard.clone());
            let target = display_id.map(str::to_string).or(selected);
            win::capture_frame(&self.monitors, target.as_deref())
        }
        #[cfg(not(windows))]
        {
            let _ = display_id;
            Err(DesktopError::Unsupported)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_is_self_consistent_with_real_probes() {
        // 这个断言是**不变量**，而不是某个时刻的状态：无论本机能否编码，
        // available 都必须与各子能力自洽，不能因为"平台是 Windows"就置真。
        let backend = WindowsBackend::new();
        let capability = backend.capabilities().expect("capability");
        let expected_available = capability.capture
            && capability.pointer
            && capability.keyboard
            && !capability.supported_codecs.is_empty();
        assert_eq!(
            capability.available, expected_available,
            "available 必须与子能力自洽: {capability:?}"
        );
        // 未真实探测通过的能力一律不得上报。
        assert!(!capability.secure_attention, "SAS 未探测前不得上报");
        // 编码格式只在真的配置成功过编码器时才上报。
        assert_eq!(
            !capability.supported_codecs.is_empty(),
            backend.encoder_probed,
            "supportedCodecs 必须等于编码器真实探测结果"
        );
        assert_eq!(capability.backend, "windows");
    }

    #[cfg(windows)]
    #[test]
    fn capture_capability_matches_a_real_capture_attempt() {
        // capture 必须是真实探测的结果，而不是写死的常量。
        let backend = WindowsBackend::new();
        let capability = backend.capabilities().expect("capability");
        assert_eq!(capability.capture, backend.capture_frame(None).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn captures_a_frame_matching_the_primary_monitor() {
        let backend = WindowsBackend::new();
        let displays = backend.displays().expect("displays");
        let primary = displays
            .iter()
            .find(|display| display.primary)
            .expect("primary display");
        let frame = {
            // 捕获实时桌面可能瞬时失败（桌面正在重绘、锁屏切换等），
            // 单次尝试会变成脆弱测试；做有限次重试后仍失败才算真失败。
            let mut captured = backend.capture_frame(None);
            for _ in 0..10 {
                if captured.is_ok() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
                captured = backend.capture_frame(None);
            }
            captured.expect("capture")
        };
        assert_eq!(frame.width, primary.width);
        assert_eq!(frame.height, primary.height);
        assert_eq!(
            frame.pixels.len(),
            primary.width as usize * primary.height as usize * 4
        );
        // 真跑 BitBlt 就一定拿到真实像素；全黑通常意味着捕获被拦截。
        assert!(
            frame.pixels.iter().any(|byte| *byte != 0),
            "捕获帧全黑，BitBlt 可能未真正生效"
        );
        // I420 尺寸必须符合 YUV420 公式（色度按 ceil(w/2)*ceil(h/2)）。
        let i420 = frame.to_i420();
        let luma = primary.width as usize * primary.height as usize;
        let chroma = primary.width.div_ceil(2) as usize * primary.height.div_ceil(2) as usize;
        assert_eq!(i420.len(), luma + chroma * 2);
    }

    #[cfg(windows)]
    #[test]
    fn capture_of_an_unknown_display_fails_closed() {
        // 不得因为“找不到就捕获主屏”而静默返回错误屏幕的画面。
        let backend = WindowsBackend::new();
        assert!(backend.capture_frame(Some("no-such-display")).is_err());
    }

    #[test]
    fn secure_attention_and_unknown_display_fail_closed() {
        let backend = WindowsBackend::new();
        assert!(backend.secure_attention().is_err());
        assert!(backend.select_display("no-such-display").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn enumerates_at_least_one_display_with_sane_geometry() {
        let backend = WindowsBackend::new();
        let displays = backend.displays().expect("displays");
        assert!(!displays.is_empty(), "本机应至少有一个显示器");
        assert_eq!(
            displays.iter().filter(|display| display.primary).count(),
            1,
            "必须恰好有一个主显示器"
        );
        for display in &displays {
            assert!(display.width > 0 && display.height > 0, "{display:?}");
            assert!(display.scale_percent > 0, "{display:?}");
            assert!(
                display.id.starts_with(r"\\"),
                "id 应来自设备名: {display:?}"
            );
        }
    }
}

#[cfg(all(test, windows))]
mod media_pipeline_tests {
    use super::*;
    use desktop_core::encoder::EncoderFactory;

    /// 真实平台媒体路径：真实捕获 → 真实 Media Foundation 编码。
    ///
    /// 这是本机的端到端媒体验证，不使用 mock 编码器。
    #[test]
    fn real_capture_feeds_the_encoder_and_produces_h264() {
        let backend = WindowsBackend::new();
        let capability = backend.capabilities().expect("capability");
        eprintln!(
            "[media] available={} capture={} codecs={:?} hardware={:?}",
            capability.available,
            capability.capture,
            capability.supported_codecs,
            capability.hardware_encoders
        );

        let frame = {
            let mut captured = backend.capture_frame(None);
            for _ in 0..10 {
                if captured.is_ok() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
                captured = backend.capture_frame(None);
            }
            captured.expect("capture")
        };
        eprintln!("[media] captured {}x{}", frame.width, frame.height);

        let factory = encoder::WindowsEncoderFactory::default();
        let mut encoder = factory.create(frame.width, frame.height).expect("encoder");

        // 真实编码器有 lookahead，需要持续喂帧。
        let mut total = 0usize;
        let mut first_at = None;
        for sequence in 0..60u64 {
            match encoder.encode(&frame, sequence, sequence == 0) {
                Ok(Some(encoded)) => {
                    if first_at.is_none() {
                        first_at = Some(sequence);
                    }
                    total += encoded.bytes.len();
                }
                Ok(None) => {}
                Err(error) => panic!("编码失败: {error:?}"),
            }
        }
        eprintln!("[media] 首次产出帧号={first_at:?} 累计 {total} 字节");
        assert!(total > 0, "真实平台路径必须产出 H.264 码流");
        assert_eq!(factory.codecs(), vec!["H264".to_string()]);

        // **延迟回归护栏**：未配置低延迟时该编码器有约 16 帧 lookahead
        // （@30fps≈0.53s，对远控不可接受）；配置 CODECAPI_AVLowLatencyMode 等
        // 属性后实测首帧即产出。若未来丢掉这些设置，本断言会立刻失败，
        // 而不是让 0.5s 延迟静默回来。
        let first = first_at.expect("必须至少产出一帧");
        assert!(
            first <= 2,
            "低延迟配置疑似失效：首次产出在第 {first} 帧（曾实测无配置时为 16 帧）"
        );
    }
}
