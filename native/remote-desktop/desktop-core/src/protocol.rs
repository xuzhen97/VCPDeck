use crate::webrtc::{decode_clipboard_message, decode_control_message};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("unsupported protocol message")]
    Unsupported,
    #[error("unknown field or invalid shape")]
    InvalidShape,
}

/// 与 `@vcpdeck/shared` 的 `RemoteDesktopDisplayInfo` 逐字段对齐的显示器描述。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub physical: bool,
    #[serde(rename = "virtual")]
    pub virtual_display: bool,
    pub primary: bool,
    pub rotation: u16,
    pub scale_percent: u16,
}

/// 与 `@vcpdeck/shared` 的 `RemoteDesktopCapabilityStatus` 逐字段对齐的能力摘要。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapabilityStatus {
    pub protocol_version: u32,
    pub host_version: String,
    pub available: bool,
    pub backend: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_manager: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub compositor: Option<String>,
    pub capture: bool,
    pub pointer: bool,
    pub keyboard: bool,
    pub clipboard_text: bool,
    pub login_screen: bool,
    pub lock_screen: bool,
    /// 是否支持平台级 Secure Attention（Ctrl+Alt+Del）。
    /// 旧 Host 不声明该字段时按“不支持”处理，与 Shared 的 fail-closed 默认一致。
    #[serde(default)]
    pub secure_attention: bool,
    pub physical_display: bool,
    pub virtual_display: bool,
    pub headless: bool,
    pub hardware_encoders: Vec<String>,
    pub supported_codecs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub diagnostic_code: Option<String>,
}

const BACKENDS: [&str; 5] = ["windows", "x11", "gnome-wayland", "kde-wayland", "unknown"];
const CODECS: [&str; 2] = ["H264", "VP8"];

impl CapabilityStatus {
    /// 构造一个安全的“不可用”能力摘要；用于探测失败时上报稳定诊断码。
    pub fn unavailable(backend: &str, diagnostic_code: &str) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            host_version: "unavailable".to_string(),
            available: false,
            backend: backend.to_string(),
            display_manager: None,
            compositor: None,
            capture: false,
            pointer: false,
            keyboard: false,
            clipboard_text: false,
            login_screen: false,
            lock_screen: false,
            secure_attention: false,
            physical_display: false,
            virtual_display: false,
            headless: false,
            hardware_encoders: Vec::new(),
            supported_codecs: vec!["VP8".to_string()],
            diagnostic_code: Some(diagnostic_code.to_string()),
        }
    }

    /// 平台后端构造完整能力摘要的便捷入口。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        backend: &str,
        host_version: &str,
        capture: bool,
        pointer: bool,
        keyboard: bool,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            host_version: host_version.to_string(),
            available: capture && pointer && keyboard,
            backend: backend.to_string(),
            display_manager: None,
            compositor: None,
            capture,
            pointer,
            keyboard,
            clipboard_text: false,
            login_screen: false,
            lock_screen: false,
            secure_attention: false,
            physical_display: false,
            virtual_display: false,
            headless: false,
            hardware_encoders: Vec::new(),
            supported_codecs: vec!["VP8".to_string()],
            diagnostic_code: None,
        }
    }

    /// 声明平台 Secure Attention（Ctrl+Alt+Del）支持。
    ///
    /// 必须由平台后端在真实探测通过后显式开启；构造器的默认值永远是 `false`，
    /// 因为无法用普通按键注入送达 SAS，谎报能力会让 Browser 展示无效按钮。
    pub fn with_secure_attention(mut self, supported: bool) -> Self {
        self.secure_attention = supported;
        self
    }

    /// 仅当能力完整自洽时对外宣告 available；否则返回稳定诊断码。
    pub fn into_available(mut self) -> Self {
        if self.available && (!self.capture || !self.pointer || !self.keyboard) {
            self.available = false;
        }
        if self.available && self.supported_codecs.is_empty() {
            self.available = false;
        }
        if self.headless && !self.physical_display && !self.virtual_display {
            self.available = false;
        }
        // 未捕获或未输入就声称支持 Secure Attention 是自相矛盾的。
        if self.secure_attention && (!self.capture || !self.keyboard) {
            self.secure_attention = false;
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Signal {
    #[serde(rename = "offer")]
    Offer { sdp: String },
    #[serde(rename = "answer")]
    Answer { sdp: String },
    #[serde(rename = "ice")]
    Ice {
        candidate: String,
        #[serde(rename = "sdpMid")]
        sdp_mid: Option<String>,
        #[serde(rename = "sdpMLineIndex")]
        sdp_m_line_index: Option<u16>,
    },
    #[serde(rename = "ice-complete")]
    IceComplete,
}

fn parse_signal(value: &Value) -> Result<Signal, ProtocolError> {
    serde_json::from_value(value.clone()).map_err(|_| ProtocolError::InvalidShape)
}

fn parse_capability(value: &Value) -> Result<CapabilityStatus, ProtocolError> {
    let capability: CapabilityStatus =
        serde_json::from_value(value.clone()).map_err(|_| ProtocolError::InvalidShape)?;
    if capability.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::Unsupported);
    }
    if !BACKENDS.contains(&capability.backend.as_str()) {
        return Err(ProtocolError::InvalidShape);
    }
    if capability.host_version.is_empty() || capability.host_version.len() > 64 {
        return Err(ProtocolError::InvalidShape);
    }
    if capability.supported_codecs.is_empty()
        || capability
            .supported_codecs
            .iter()
            .any(|codec| !CODECS.contains(&codec.as_str()))
    {
        return Err(ProtocolError::InvalidShape);
    }
    if capability.available && (!capability.capture || !capability.pointer || !capability.keyboard)
    {
        return Err(ProtocolError::InvalidShape);
    }
    if capability.headless && !capability.physical_display && !capability.virtual_display {
        return Err(ProtocolError::InvalidShape);
    }
    Ok(capability)
}

/// Parses the fixture's supported protocol cases using the same strict shape rules as the Host.
pub fn parse_fixture(kind: &str, value: &Value) -> Result<(), ProtocolError> {
    match kind {
        "signal" => parse_signal(value).map(|_| ()),
        "capability" => parse_capability(value).map(|_| ()),
        "control" => serde_json::to_vec(value)
            .ok()
            .and_then(|bytes| decode_control_message(&bytes).ok())
            .map(|_| ())
            .ok_or(ProtocolError::InvalidShape),
        "clipboard" => serde_json::to_vec(value)
            .ok()
            .and_then(|bytes| decode_clipboard_message(&bytes).ok())
            .map(|_| ())
            .ok_or(ProtocolError::InvalidShape),
        _ => Err(ProtocolError::Unsupported),
    }
}

/// Backwards-compatible helper used by the focused parity test.
pub fn parse_signal_fixture(value: &Value) -> Result<Signal, ProtocolError> {
    parse_signal(value)
}
