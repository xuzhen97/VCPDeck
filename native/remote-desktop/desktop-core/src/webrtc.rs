use crate::clipboard::{ClipboardDirection, ClipboardError, ClipboardMode, ClipboardText};
use crate::input::InputRouter;
use crate::media::{InputEvent, PointerSample};
use crate::session::AttachmentRole;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataChannelKind {
    ControlReliable,
    PointerRealtime,
}

impl DataChannelKind {
    pub const fn label(self) -> &'static str {
        match self {
            Self::ControlReliable => "control-reliable",
            Self::PointerRealtime => "pointer-realtime",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DataChannelPolicy {
    pub ordered: bool,
    pub max_retransmits: Option<u16>,
}

impl DataChannelKind {
    pub const fn policy(self) -> DataChannelPolicy {
        match self {
            Self::ControlReliable => DataChannelPolicy {
                ordered: true,
                max_retransmits: None,
            },
            Self::PointerRealtime => DataChannelPolicy {
                ordered: false,
                max_retransmits: Some(0),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub nonce: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChallengeResponse {
    pub nonce: [u8; 32],
    pub attachment_id: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WebRtcError {
    #[error("attachment role cannot open input channel")]
    ViewerInputDenied,
    #[error("challenge response does not match")]
    ChallengeFailed,
    #[error("peer is not authenticated")]
    NotAuthenticated,
    #[error("peer connection is closed")]
    Closed,
    #[error("invalid control message")]
    InvalidControlMessage,
    #[error("control message exceeds the maximum size")]
    ControlMessageTooLarge,
    #[error("unsupported control action")]
    UnsupportedControlAction,
    #[error("data channel transport failed")]
    Transport,
    #[error("challenge response has already been used")]
    ChallengeAlreadyUsed,
    #[error("input is frozen")]
    InputFrozen,
    #[error("invalid pointer message")]
    InvalidPointerMessage,
    #[error("invalid clipboard message")]
    InvalidClipboardMessage,
    #[error("clipboard is disabled")]
    ClipboardDisabled,
    #[error("clipboard direction is not permitted")]
    ClipboardDirectionDenied,
    #[error("clipboard text exceeds the maximum size")]
    ClipboardTooLarge,
    #[error("pointer layout generation is stale")]
    StaleLayout,
    #[error("browser offer is not a valid SDP offer")]
    InvalidOffer,
    #[error("webrtc negotiation failed")]
    NegotiationFailed,
    #[error("a required data channel was not negotiated")]
    ChannelMissing,
}

#[derive(Debug, Clone)]
pub struct AttachmentAuthorization {
    attachment_id: Arc<str>,
    role: AttachmentRole,
    challenge: Challenge,
    authenticated: bool,
    closed: bool,
}

impl AttachmentAuthorization {
    pub fn new(attachment_id: impl Into<Arc<str>>, role: AttachmentRole, nonce: [u8; 32]) -> Self {
        Self {
            attachment_id: attachment_id.into(),
            role,
            challenge: Challenge { nonce },
            authenticated: false,
            closed: false,
        }
    }

    pub fn challenge(&self) -> &Challenge {
        &self.challenge
    }

    pub fn attachment_id(&self) -> &str {
        &self.attachment_id
    }

    pub fn is_authenticated(&self) -> bool {
        self.authenticated && !self.closed
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// 本 attachment 的角色。
    pub fn role(&self) -> AttachmentRole {
        self.role
    }

    pub fn authenticate(&mut self, response: ChallengeResponse) -> Result<(), WebRtcError> {
        if self.closed {
            return Err(WebRtcError::Closed);
        }
        if response.nonce != self.challenge.nonce
            || response.attachment_id != self.attachment_id.as_ref()
        {
            return Err(WebRtcError::ChallengeFailed);
        }
        self.authenticated = true;
        Ok(())
    }

    pub fn authorize_channel(
        &self,
        kind: DataChannelKind,
    ) -> Result<DataChannelPolicy, WebRtcError> {
        if self.closed {
            return Err(WebRtcError::Closed);
        }
        if !self.authenticated {
            return Err(WebRtcError::NotAuthenticated);
        }
        if kind == DataChannelKind::PointerRealtime && self.role != AttachmentRole::Operator {
            return Err(WebRtcError::ViewerInputDenied);
        }
        Ok(kind.policy())
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.authenticated = false;
    }
}

pub const MAX_CONTROL_MESSAGE_BYTES: usize = 64 * 1024;
pub const MAX_CLIPBOARD_MESSAGE_BYTES: usize = crate::clipboard::MAX_CLIPBOARD_BYTES + 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointerMessage {
    pub layout_generation: u64,
    pub x: u16,
    pub y: u16,
}

pub fn decode_pointer_message(bytes: &[u8]) -> Result<PointerMessage, WebRtcError> {
    if bytes.len() > MAX_CONTROL_MESSAGE_BYTES {
        return Err(WebRtcError::ControlMessageTooLarge);
    }
    serde_json::from_slice(bytes).map_err(|_| WebRtcError::InvalidPointerMessage)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ClipboardMessage {
    #[serde(rename = "browser-to-remote")]
    BrowserToRemote { text: String },
    #[serde(rename = "remote-to-browser")]
    RemoteToBrowser { text: String },
}

pub fn decode_clipboard_message(bytes: &[u8]) -> Result<ClipboardMessage, WebRtcError> {
    if bytes.len() > MAX_CLIPBOARD_MESSAGE_BYTES {
        return Err(WebRtcError::ControlMessageTooLarge);
    }
    let message: ClipboardMessage =
        serde_json::from_slice(bytes).map_err(|_| WebRtcError::InvalidClipboardMessage)?;
    let text = match &message {
        ClipboardMessage::BrowserToRemote { text } | ClipboardMessage::RemoteToBrowser { text } => {
            text
        }
    };
    if text.len() > crate::clipboard::MAX_CLIPBOARD_BYTES {
        return Err(WebRtcError::ClipboardTooLarge);
    }
    Ok(message)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ControlMessage {
    #[serde(rename = "challenge")]
    Challenge {
        nonce: [u8; 32],
        attachment_id: String,
    },
    #[serde(rename = "challenge-response")]
    ChallengeResponse {
        nonce: [u8; 32],
        attachment_id: String,
    },
    #[serde(rename = "input")]
    Input { event: ControlInput },
    #[serde(rename = "release-all")]
    ReleaseAll,
    /// 系统级 Secure Attention（Ctrl+Alt+Del），只能由平台 API 送达。
    #[serde(rename = "secure-attention")]
    SecureAttention,
    #[serde(rename = "display-select")]
    DisplaySelect {
        #[serde(rename = "displayId")]
        display_id: String,
    },
    #[serde(rename = "layout-confirm")]
    LayoutConfirm {
        #[serde(rename = "layoutGeneration")]
        layout_generation: u64,
    },
    /// Host → Browser：显示器切换后的新布局。
    ///
    /// Browser 只有在收到它之后才能恢复输入，因此缺少这条消息会让
    /// 显示器切换变成永久的输入冻结。
    #[serde(rename = "layout-update")]
    LayoutUpdate {
        #[serde(rename = "layoutGeneration")]
        layout_generation: u64,
        #[serde(rename = "displayId")]
        display_id: String,
        width: u32,
        height: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ControlInput {
    #[serde(rename = "pointer-move")]
    PointerMove { x: u16, y: u16 },
    #[serde(rename = "button")]
    Button { button: u8, pressed: bool },
    #[serde(rename = "wheel")]
    Wheel {
        #[serde(rename = "deltaX")]
        delta_x: i16,
        #[serde(rename = "deltaY")]
        delta_y: i16,
    },
    #[serde(rename = "key")]
    Key {
        #[serde(rename = "keyCode")]
        key_code: u32,
        pressed: bool,
    },
}

impl From<ControlInput> for InputEvent {
    fn from(value: ControlInput) -> Self {
        match value {
            ControlInput::PointerMove { x, y } => Self::PointerMove { x, y },
            ControlInput::Button { button, pressed } => Self::Button { button, pressed },
            ControlInput::Wheel { delta_x, delta_y } => Self::Wheel { delta_x, delta_y },
            ControlInput::Key { key_code, pressed } => Self::Key { key_code, pressed },
        }
    }
}

/// Host 对一条控制消息的处理结果。
///
/// 通过授权的动作必须携带“要应用的载荷”：若只返回 `InputAccepted`，
/// 事件本体就会在这里丢掉，平台永远收不到输入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlAction {
    Authenticated,
    InputAccepted(InputEvent),
    PointerAccepted(PointerSample),
    InputsReleased,
    DisplaySelected {
        display_id: String,
        /// Host 推进后的新 layout generation；Browser 必须用它确认。
        layout_generation: u64,
    },
    LayoutConfirmed {
        layout_generation: u64,
    },
    /// 请求平台发送 Secure Attention；实际送达由平台后端负责。
    SecureAttentionRequested,
}

/// `type` → 该消息允许出现的全部字段（含 `type` 自身）。
///
/// serde 对 internally-tagged enum 的 **unit 变体**（`release-all`、`secure-attention`）
/// 不会真正执行 `deny_unknown_fields`，因此必须在这里做键白名单校验，
/// 否则对端可以夹带字段越过“严格解析、fail closed”的边界。
fn allowed_control_keys(message_type: &str) -> Option<&'static [&'static str]> {
    match message_type {
        "challenge" => Some(&["type", "nonce", "attachment_id"]),
        "challenge-response" => Some(&["type", "nonce", "attachment_id"]),
        "input" => Some(&["type", "event"]),
        "release-all" => Some(&["type"]),
        "secure-attention" => Some(&["type"]),
        "display-select" => Some(&["type", "displayId"]),
        "layout-confirm" => Some(&["type", "layoutGeneration"]),
        "layout-update" => Some(&["type", "layoutGeneration", "displayId", "width", "height"]),
        _ => None,
    }
}

/// 在反序列化前校验原始 JSON 对象：必须是对象、`type` 合法、不得含未知字段。
fn validate_control_keys(value: &serde_json::Value) -> Result<(), WebRtcError> {
    let object = value
        .as_object()
        .ok_or(WebRtcError::InvalidControlMessage)?;
    let message_type = object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or(WebRtcError::InvalidControlMessage)?;
    let allowed = allowed_control_keys(message_type).ok_or(WebRtcError::InvalidControlMessage)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(WebRtcError::InvalidControlMessage);
    }
    Ok(())
}

pub fn decode_control_message(bytes: &[u8]) -> Result<ControlMessage, WebRtcError> {
    if bytes.len() > MAX_CONTROL_MESSAGE_BYTES {
        return Err(WebRtcError::ControlMessageTooLarge);
    }
    // 先按字节做一次严格键校验，再做类型化反序列化；两步都必须通过。
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| WebRtcError::InvalidControlMessage)?;
    validate_control_keys(&value)?;
    serde_json::from_value(value).map_err(|_| WebRtcError::InvalidControlMessage)
}

/// 可靠控制通道上的入站消息：控制指令或剪贴板。
///
/// 两者共用 `control-reliable` 通道，因此必须按 `type` 分流。若把剪贴板消息
/// 当作控制消息解析，一条剪贴板消息就会让整个控制循环（连同输入）终止。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundControlMessage {
    Control(ControlMessage),
    Clipboard(ClipboardMessage),
}

/// 按 `type` 把可靠通道上的原始帧分流为控制消息或剪贴板消息。
pub fn decode_inbound_control_message(bytes: &[u8]) -> Result<InboundControlMessage, WebRtcError> {
    if bytes.len() > MAX_CONTROL_MESSAGE_BYTES {
        return Err(WebRtcError::ControlMessageTooLarge);
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| WebRtcError::InvalidControlMessage)?;
    let message_type = value
        .as_object()
        .and_then(|object| object.get("type"))
        .and_then(serde_json::Value::as_str)
        .ok_or(WebRtcError::InvalidControlMessage)?;
    // 剪贴板方向由 Shared 定义为唯一两个值，其余一律按控制消息严格解析。
    if message_type == "browser-to-remote" || message_type == "remote-to-browser" {
        return decode_clipboard_message(bytes).map(InboundControlMessage::Clipboard);
    }
    decode_control_message(bytes).map(InboundControlMessage::Control)
}

pub fn respond_to_challenge(
    message: &ControlMessage,
    attachment_id: &str,
) -> Result<ControlMessage, WebRtcError> {
    match message {
        ControlMessage::Challenge {
            nonce,
            attachment_id: challenged_attachment,
        } if challenged_attachment == attachment_id => Ok(ControlMessage::ChallengeResponse {
            nonce: *nonce,
            attachment_id: attachment_id.to_string(),
        }),
        ControlMessage::Challenge { .. } => Err(WebRtcError::ChallengeFailed),
        _ => Err(WebRtcError::UnsupportedControlAction),
    }
}

#[derive(Debug)]
pub struct ControlSession {
    authorization: AttachmentAuthorization,
    input: InputRouter,
    clipboard_mode: ClipboardMode,
    /// 最近一次与 Browser 交换过的剪贴板文本，用于去重与回声抑制。
    last_clipboard: Option<String>,
}

impl ControlSession {
    /// 本 attachment 的 challenge。
    pub fn challenge(&self) -> &Challenge {
        self.authorization.challenge()
    }

    /// 是否已通过 challenge-response 认证。
    pub fn is_authenticated(&self) -> bool {
        self.authorization.is_authenticated()
    }

    /// 是否已关闭。
    pub fn is_closed(&self) -> bool {
        self.authorization.is_closed()
    }

    /// 本 attachment 的角色。
    pub fn role(&self) -> AttachmentRole {
        self.authorization.role()
    }

    /// 当前 layout generation。
    pub fn layout_generation(&self) -> u64 {
        self.input.layout_generation()
    }

    /// 开始一次显示器切换：推进 generation 并冻结输入，返回新 generation。
    ///
    /// 这是 Host 侧唯一的布局权威：pointer 消息就是按这个 generation 校验的，
    /// 因此下发给 Browser 的 `layout-update` 必须使用同一个值。
    pub fn begin_display_switch(&mut self) -> u64 {
        let next = self.input.layout_generation().wrapping_add(1);
        self.input.set_layout_generation(next);
        next
    }
    pub fn new(attachment_id: impl Into<Arc<str>>, role: AttachmentRole, nonce: [u8; 32]) -> Self {
        Self::new_with_clipboard(attachment_id, role, nonce, ClipboardMode::Off)
    }

    pub fn new_with_clipboard(
        attachment_id: impl Into<Arc<str>>,
        role: AttachmentRole,
        nonce: [u8; 32],
        clipboard_mode: ClipboardMode,
    ) -> Self {
        Self {
            authorization: AttachmentAuthorization::new(attachment_id, role, nonce),
            input: InputRouter::new(),
            clipboard_mode,
            last_clipboard: None,
        }
    }

    pub fn handle(&mut self, message: ControlMessage) -> Result<ControlAction, WebRtcError> {
        match message {
            ControlMessage::ChallengeResponse {
                nonce,
                attachment_id,
            } => {
                if self.authorization.authenticated {
                    return Err(WebRtcError::ChallengeAlreadyUsed);
                }
                self.authorization.authenticate(ChallengeResponse {
                    nonce,
                    attachment_id,
                })?;
                Ok(ControlAction::Authenticated)
            }
            ControlMessage::Input { event } => {
                if !self.authorization.authenticated {
                    return Err(WebRtcError::NotAuthenticated);
                }
                let role = self.authorization.role;
                let platform_event: InputEvent = event.into();
                self.input
                    .accept(role, platform_event.clone())
                    .map_err(|error| match error {
                        crate::media::MediaError::ViewerInputDenied => {
                            WebRtcError::ViewerInputDenied
                        }
                        crate::media::MediaError::InputFrozen => WebRtcError::InputFrozen,
                        _ => WebRtcError::InvalidControlMessage,
                    })?;
                Ok(ControlAction::InputAccepted(platform_event))
            }
            ControlMessage::ReleaseAll => {
                if !self.authorization.authenticated {
                    return Err(WebRtcError::NotAuthenticated);
                }
                self.input.release_all();
                Ok(ControlAction::InputsReleased)
            }
            ControlMessage::SecureAttention => {
                if !self.authorization.authenticated {
                    return Err(WebRtcError::NotAuthenticated);
                }
                // Ctrl+Alt+Del 是提权动作，Viewer 不得触发；它不注入输入，
                // 因此不受冻结限制（登录屏/锁屏切换期间仍需可用）。
                if self.authorization.role != AttachmentRole::Operator {
                    return Err(WebRtcError::ViewerInputDenied);
                }
                Ok(ControlAction::SecureAttentionRequested)
            }
            ControlMessage::DisplaySelect { display_id } => {
                if !self.authorization.authenticated {
                    return Err(WebRtcError::NotAuthenticated);
                }
                // 切换显示器会冻结整条会话的输入，只有 Operator 可以发起；
                // Viewer 不得改变操作者的显示目标。
                if self.authorization.role != AttachmentRole::Operator {
                    return Err(WebRtcError::ViewerInputDenied);
                }
                // 切换期间必须冻结输入，并推进 generation；旧 generation 的
                // pointer 输入在切换完成前一律拒绝。
                let layout_generation = self.begin_display_switch();
                Ok(ControlAction::DisplaySelected {
                    display_id,
                    layout_generation,
                })
            }
            ControlMessage::LayoutConfirm { layout_generation } => {
                if !self.authorization.authenticated {
                    return Err(WebRtcError::NotAuthenticated);
                }
                self.input.resume(layout_generation);
                Ok(ControlAction::LayoutConfirmed { layout_generation })
            }
            // Host → Browser 的布局广播由数据面循环发送，不是入站指令。
            ControlMessage::LayoutUpdate { .. } => Err(WebRtcError::UnsupportedControlAction),
            ControlMessage::Challenge { .. } => Err(WebRtcError::UnsupportedControlAction),
        }
    }

    pub fn handle_pointer(
        &mut self,
        message: PointerMessage,
    ) -> Result<ControlAction, WebRtcError> {
        if !self.authorization.authenticated {
            return Err(WebRtcError::NotAuthenticated);
        }
        let sample = crate::media::PointerSample {
            x: message.x,
            y: message.y,
        };
        self.input
            .accept_pointer(self.authorization.role, message.layout_generation, sample)
            .map_err(|error| match error {
                crate::media::MediaError::ViewerInputDenied => WebRtcError::ViewerInputDenied,
                crate::media::MediaError::InputFrozen => {
                    if message.layout_generation != self.input.layout_generation() {
                        WebRtcError::StaleLayout
                    } else {
                        WebRtcError::InputFrozen
                    }
                }
                _ => WebRtcError::InvalidPointerMessage,
            })?;
        Ok(ControlAction::PointerAccepted(sample))
    }

    pub fn handle_clipboard(
        &self,
        message: ClipboardMessage,
    ) -> Result<ClipboardText, WebRtcError> {
        if !self.authorization.authenticated {
            return Err(WebRtcError::NotAuthenticated);
        }
        let (direction, text) = match message {
            ClipboardMessage::BrowserToRemote { text } => {
                (ClipboardDirection::BrowserToRemote, text)
            }
            ClipboardMessage::RemoteToBrowser { .. } => {
                return Err(WebRtcError::UnsupportedControlAction)
            }
        };
        if self.authorization.role != AttachmentRole::Operator {
            return Err(WebRtcError::ViewerInputDenied);
        }
        self.validate_clipboard(direction, text)
    }

    pub fn prepare_clipboard_to_browser(
        &self,
        text: String,
    ) -> Result<ClipboardMessage, WebRtcError> {
        if !self.authorization.authenticated {
            return Err(WebRtcError::NotAuthenticated);
        }
        if self.authorization.role != AttachmentRole::Operator {
            return Err(WebRtcError::ViewerInputDenied);
        }
        let text = self
            .validate_clipboard(ClipboardDirection::RemoteToBrowser, text)?
            .text;
        Ok(ClipboardMessage::RemoteToBrowser { text })
    }

    /// 平台剪贴板变化时，决定是否需要向 Browser 推送。
    ///
    /// 返回 `None` 表示不推送：平台无文本、内容未变化、正是刚写入的回声、
    /// 或模式/角色/大小不允许。只有真正可推送时才记录，否则之后打开双向
    /// 模式时会把当前内容当成“已推送过”而永久漏掉。
    pub fn clipboard_to_browser(&mut self, text: Option<String>) -> Option<ClipboardMessage> {
        let text = text?;
        // 去重：未变化不重复推送；回声也在这里被拦住，避免无限往返。
        if self.last_clipboard.as_deref() == Some(text.as_str()) {
            return None;
        }
        let message = self.prepare_clipboard_to_browser(text.clone()).ok()?;
        self.last_clipboard = Some(text);
        Some(message)
    }

    /// 记录一段已由 Browser 写入平台的文本。
    ///
    /// 平台剪贴板随后会读到同一份内容；不记录就会把它当作新内容回声回 Browser。
    pub fn note_clipboard_written(&mut self, text: &str) {
        self.last_clipboard = Some(text.to_string());
    }

    fn validate_clipboard(
        &self,
        direction: ClipboardDirection,
        text: String,
    ) -> Result<ClipboardText, WebRtcError> {
        self.clipboard_mode
            .validate(self.authorization.role, direction, text)
            .map_err(|error| match error {
                ClipboardError::Disabled => WebRtcError::ClipboardDisabled,
                ClipboardError::DirectionDenied => WebRtcError::ClipboardDirectionDenied,
                ClipboardError::TooLarge | ClipboardError::InvalidUtf8 => {
                    WebRtcError::ClipboardTooLarge
                }
            })
    }

    pub fn input_mut(&mut self) -> &mut InputRouter {
        &mut self.input
    }

    pub fn resume_layout(&mut self, generation: u64) {
        self.input.resume(generation);
    }

    pub fn close(&mut self) {
        self.input.release_all();
        self.authorization.close();
    }
}

pub mod transport {
    use super::DataChannelKind;
    use crate::media::VideoCodec;
    use bytes::BytesMut;
    use rtc::media::Sample;
    use rtc::media_stream::MediaStreamTrack;
    use rtc::rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
    };
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    // 公开导出供 Desktop Host 编排层在签名中命名通道类型。
    pub use webrtc::data_channel::DataChannel;
    use webrtc::data_channel::{DataChannelEvent, RTCDataChannelInit};
    use webrtc::error::Result as WebRtcResult;
    use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
    use webrtc::media_stream::track_local::TrackLocal;
    use webrtc::media_stream::track_remote::TrackRemote;
    use webrtc::peer_connection::{
        register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
        PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceServer, Registry,
    };
    use webrtc::peer_connection::{
        RTCIceCandidateInit, RTCIceGatheringState, RTCPeerConnectionIceEvent, RTCSessionDescription,
    };
    use webrtc::rtp_transceiver::RtpSender;
    use webrtc::runtime::{channel, Runtime};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum TransportCodec {
        H264,
        Vp8,
    }

    impl From<VideoCodec> for TransportCodec {
        fn from(value: VideoCodec) -> Self {
            match value {
                VideoCodec::H264 => Self::H264,
                VideoCodec::Vp8 => Self::Vp8,
            }
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SignalingDescription {
        pub kind: String,
        pub sdp: String,
    }

    #[derive(Clone)]
    pub struct LoopbackHandler {
        data_channels: Arc<tokio::sync::Mutex<Vec<Arc<dyn DataChannel>>>>,
        remote_tracks: Arc<tokio::sync::Mutex<Vec<Arc<dyn TrackRemote>>>>,
        ice: webrtc::runtime::Sender<RTCPeerConnectionIceEvent>,
        gathering: webrtc::runtime::Sender<()>,
    }

    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for LoopbackHandler {
        async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
            let _ = self.ice.try_send(event);
        }

        async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
            if state == RTCIceGatheringState::Complete {
                let _ = self.gathering.try_send(());
            }
        }

        async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
            self.data_channels.lock().await.push(channel);
        }

        async fn on_track(&self, track: Arc<dyn TrackRemote>) {
            self.remote_tracks.lock().await.push(track);
        }
    }

    pub async fn send_control_message(
        channel: &Arc<dyn DataChannel>,
        message: &super::ControlMessage,
    ) -> Result<(), super::WebRtcError> {
        let encoded =
            serde_json::to_vec(message).map_err(|_| super::WebRtcError::InvalidControlMessage)?;
        if encoded.len() > super::MAX_CONTROL_MESSAGE_BYTES {
            return Err(super::WebRtcError::ControlMessageTooLarge);
        }
        channel
            .send(BytesMut::from(encoded.as_slice()))
            .await
            .map_err(|_| super::WebRtcError::Transport)
    }

    pub async fn receive_control_message(
        channel: &Arc<dyn DataChannel>,
    ) -> Result<super::ControlMessage, super::WebRtcError> {
        let raw = receive_control_raw(channel).await?;
        super::decode_control_message(&raw)
    }

    /// 读取可靠控制通道上的原始帧，不做任何类型假设。
    ///
    /// 调用方必须自行按 `type` 分流（控制指令或剪贴板），因为两者共用这条通道。
    pub async fn receive_control_raw(
        channel: &Arc<dyn DataChannel>,
    ) -> Result<Vec<u8>, super::WebRtcError> {
        loop {
            match channel.poll().await {
                Some(DataChannelEvent::OnMessage(message)) => return Ok(message.data.to_vec()),
                Some(DataChannelEvent::OnClose) | None => return Err(super::WebRtcError::Closed),
                Some(_) => {}
            }
        }
    }

    pub async fn send_pointer_message(
        channel: &Arc<dyn DataChannel>,
        message: &super::PointerMessage,
    ) -> Result<(), super::WebRtcError> {
        let encoded =
            serde_json::to_vec(message).map_err(|_| super::WebRtcError::InvalidPointerMessage)?;
        if encoded.len() > super::MAX_CONTROL_MESSAGE_BYTES {
            return Err(super::WebRtcError::ControlMessageTooLarge);
        }
        channel
            .send(BytesMut::from(encoded.as_slice()))
            .await
            .map_err(|_| super::WebRtcError::Transport)
    }

    pub async fn receive_pointer_message(
        channel: &Arc<dyn DataChannel>,
    ) -> Result<super::PointerMessage, super::WebRtcError> {
        loop {
            match channel.poll().await {
                Some(DataChannelEvent::OnMessage(message)) => {
                    return super::decode_pointer_message(&message.data)
                }
                Some(DataChannelEvent::OnClose) | None => return Err(super::WebRtcError::Closed),
                Some(_) => {}
            }
        }
    }

    pub async fn send_clipboard_message(
        channel: &Arc<dyn DataChannel>,
        message: &super::ClipboardMessage,
    ) -> Result<(), super::WebRtcError> {
        let encoded =
            serde_json::to_vec(message).map_err(|_| super::WebRtcError::InvalidClipboardMessage)?;
        if encoded.len() > super::MAX_CLIPBOARD_MESSAGE_BYTES {
            return Err(super::WebRtcError::ControlMessageTooLarge);
        }
        super::decode_clipboard_message(&encoded)?;
        channel
            .send(BytesMut::from(encoded.as_slice()))
            .await
            .map_err(|_| super::WebRtcError::Transport)
    }

    pub async fn receive_clipboard_message(
        channel: &Arc<dyn DataChannel>,
    ) -> Result<super::ClipboardMessage, super::WebRtcError> {
        loop {
            match channel.poll().await {
                Some(DataChannelEvent::OnMessage(message)) => {
                    return super::decode_clipboard_message(&message.data)
                }
                Some(DataChannelEvent::OnClose) | None => return Err(super::WebRtcError::Closed),
                Some(_) => {}
            }
        }
    }

    pub struct VideoTrack {
        pub track: Arc<TrackLocalStaticSample>,
        pub sender: Arc<dyn RtpSender>,
        payload_type: u8,
        ssrc: u32,
    }

    pub struct PeerTransport {
        pub connection: Arc<dyn PeerConnection>,
        pub runtime: Arc<dyn Runtime>,
        pub data_channels: Arc<tokio::sync::Mutex<Vec<Arc<dyn DataChannel>>>>,
        pub remote_tracks: Arc<tokio::sync::Mutex<Vec<Arc<dyn TrackRemote>>>>,
        pub ice: webrtc::runtime::Receiver<RTCPeerConnectionIceEvent>,
        gathering: webrtc::runtime::Receiver<()>,
    }

    impl PeerTransport {
        pub async fn new(stun_urls: Vec<String>) -> WebRtcResult<Self> {
            let runtime = Arc::new(webrtc::runtime::TokioRuntime) as Arc<dyn Runtime>;
            let (ice_tx, ice) = channel(64);
            let (gathering_tx, gathering) = channel(1);
            let data_channels = Arc::new(tokio::sync::Mutex::new(Vec::new()));
            let remote_tracks = Arc::new(tokio::sync::Mutex::new(Vec::new()));
            let mut media = MediaEngine::default();
            media.register_default_codecs()?;
            let registry: Registry = register_default_interceptors(Registry::new(), &mut media)?;
            let configuration = RTCConfigurationBuilder::new()
                .with_ice_servers(vec![RTCIceServer {
                    urls: stun_urls,
                    ..Default::default()
                }])
                .build();
            let handler = LoopbackHandler {
                data_channels: data_channels.clone(),
                remote_tracks: remote_tracks.clone(),
                ice: ice_tx,
                gathering: gathering_tx,
            };
            let connection = PeerConnectionBuilder::new()
                .with_configuration(configuration)
                .with_media_engine(media)
                .with_interceptor_registry(registry)
                .with_handler(Arc::new(handler))
                .with_runtime(runtime.clone())
                .with_udp_addrs(vec!["0.0.0.0:0"])
                .build()
                .await?;
            Ok(Self {
                connection: Arc::new(connection),
                runtime,
                data_channels,
                remote_tracks,
                ice,
                gathering,
            })
        }

        pub async fn create_offer(&self) -> WebRtcResult<RTCSessionDescription> {
            let offer = self.connection.create_offer(None).await?;
            self.connection.set_local_description(offer).await?;
            self.wait_for_gathering().await?;
            self.connection
                .local_description()
                .await
                .ok_or(webrtc::error::Error::ErrUnknownType)
        }

        pub async fn create_answer(&self) -> WebRtcResult<RTCSessionDescription> {
            let answer = self.connection.create_answer(None).await?;
            self.connection.set_local_description(answer).await?;
            self.wait_for_gathering().await?;
            self.connection
                .local_description()
                .await
                .ok_or(webrtc::error::Error::ErrUnknownType)
        }

        async fn wait_for_gathering(&self) -> WebRtcResult<()> {
            let mut gathering = self.gathering.clone();
            tokio::time::timeout(Duration::from_secs(5), gathering.recv())
                .await
                .map_err(|_| webrtc::error::Error::ErrUnknownType)?
                .ok_or(webrtc::error::Error::ErrUnknownType)
        }

        pub async fn set_remote_description(
            &self,
            description: &RTCSessionDescription,
        ) -> WebRtcResult<()> {
            self.connection
                .set_remote_description(description.clone())
                .await
        }

        /// 应用 Browser 的远端 ICE 候选。
        ///
        /// **必须把候选真的交给 PeerConnection**：只回 ack 的话，ICE 永远无法完成，
        ///  DataChannel 永远不开，`bind_channels` 会在超时后把整条连接销毁。
        pub async fn add_remote_candidate(
            &self,
            candidate: &str,
            sdp_mid: Option<String>,
            sdp_m_line_index: Option<u16>,
        ) -> WebRtcResult<()> {
            self.connection
                .add_ice_candidate(RTCIceCandidateInit {
                    candidate: candidate.to_string(),
                    sdp_mid,
                    sdp_mline_index: sdp_m_line_index,
                    ..Default::default()
                })
                .await
        }

        pub async fn next_data_channel(&self) -> Option<Arc<dyn DataChannel>> {
            for _ in 0..100 {
                if let Some(channel) = self.data_channels.lock().await.pop() {
                    return Some(channel);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            None
        }

        /// 非阻塞取出一条已到达的通道；没有则立即返回 `None`。
        ///
        /// 调用方持有 Host 运行时锁，因此这里**绝不允许等待**：能让通道打开的
        /// ICE 候选必须通过后续 IPC 请求进入，等待会把白己需要的输入挡在锁外。
        pub async fn try_next_data_channel(&self) -> Option<Arc<dyn DataChannel>> {
            self.data_channels.lock().await.pop()
        }

        pub async fn next_remote_track(&self) -> Option<Arc<dyn TrackRemote>> {
            for _ in 0..100 {
                if let Some(track) = self.remote_tracks.lock().await.pop() {
                    return Some(track);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            None
        }

        pub async fn add_video_track(&self, codec: TransportCodec) -> WebRtcResult<VideoTrack> {
            let (rtp_codec, payload_type) = match codec {
                TransportCodec::H264 => (
                    RTCRtpCodec {
                        mime_type: "video/H264".to_string(),
                        clock_rate: 90_000,
                        channels: 0,
                        sdp_fmtp_line:
                            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                                .to_string(),
                        rtcp_feedback: Vec::new(),
                    },
                    102,
                ),
                TransportCodec::Vp8 => (
                    RTCRtpCodec {
                        mime_type: "video/VP8".to_string(),
                        clock_rate: 90_000,
                        channels: 0,
                        sdp_fmtp_line: String::new(),
                        rtcp_feedback: Vec::new(),
                    },
                    96,
                ),
            };
            let track = Arc::new(TrackLocalStaticSample::new(
                Instant::now(),
                MediaStreamTrack::new(
                    "vcpdeck-stream".to_string(),
                    "vcpdeck-video".to_string(),
                    "vcpdeck-desktop".to_string(),
                    RtpCodecKind::Video,
                    vec![RTCRtpEncodingParameters {
                        rtp_coding_parameters: RTCRtpCodingParameters {
                            ssrc: Some(0x5643_5044),
                            ..Default::default()
                        },
                        codec: rtp_codec,
                        ..Default::default()
                    }],
                ),
            )?);
            let sender = self
                .connection
                .add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
                .await?;
            Ok(VideoTrack {
                track,
                sender,
                payload_type,
                ssrc: 0x5643_5044,
            })
        }

        pub async fn send_encoded_sample(
            &self,
            video: &VideoTrack,
            data: Vec<u8>,
            duration: Duration,
        ) -> WebRtcResult<()> {
            video
                .track
                .sample_writer(video.ssrc, video.payload_type)
                .write_sample(&Sample {
                    data: data.into(),
                    timestamp: Instant::now(),
                    duration,
                    packet_timestamp: 0,
                    prev_dropped_packets: 0,
                    prev_padding_packets: 0,
                })
                .await
        }

        pub async fn create_control_channel(&self) -> WebRtcResult<Arc<dyn DataChannel>> {
            self.connection
                .create_data_channel(
                    DataChannelKind::ControlReliable.label(),
                    Some(RTCDataChannelInit {
                        ordered: true,
                        ..Default::default()
                    }),
                )
                .await
        }

        pub async fn create_pointer_channel(&self) -> WebRtcResult<Arc<dyn DataChannel>> {
            self.connection
                .create_data_channel(
                    DataChannelKind::PointerRealtime.label(),
                    Some(RTCDataChannelInit {
                        ordered: false,
                        max_retransmits: Some(0),
                        ..Default::default()
                    }),
                )
                .await
        }

        pub async fn close(self) -> WebRtcResult<()> {
            self.connection.close().await
        }
    }

    /// Creates an encoded video track with the selected negotiated codec.
    pub fn sample_track(codec: TransportCodec) -> WebRtcResult<TrackLocalStaticSample> {
        let (rtp_codec, _) = match codec {
            TransportCodec::H264 => (
                RTCRtpCodec {
                    mime_type: "video/H264".to_string(),
                    clock_rate: 90_000,
                    channels: 0,
                    sdp_fmtp_line:
                        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                            .to_string(),
                    rtcp_feedback: Vec::new(),
                },
                102,
            ),
            TransportCodec::Vp8 => (
                RTCRtpCodec {
                    mime_type: "video/VP8".to_string(),
                    clock_rate: 90_000,
                    channels: 0,
                    sdp_fmtp_line: String::new(),
                    rtcp_feedback: Vec::new(),
                },
                96,
            ),
        };
        TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "vcpdeck-stream".to_string(),
                "vcpdeck-video".to_string(),
                "vcpdeck-desktop".to_string(),
                RtpCodecKind::Video,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(0x5643_5044),
                        ..Default::default()
                    },
                    codec: rtp_codec,
                    ..Default::default()
                }],
            ),
        )
    }
}
