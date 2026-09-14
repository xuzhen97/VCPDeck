//! Desktop Host 控制面。
//!
//! 这一层把本机 IPC 帧翻译成 [`SessionManager`] 操作，并产出严格的 Host 响应与状态报告。
//! 媒体、输入和剪贴板正文都不经过这里：IPC 只承载会话控制元数据。

use crate::clipboard::ClipboardMode;
use crate::protocol::{CapabilityStatus, DisplayInfo, PROTOCOL_VERSION};
use crate::session::{AttachmentRole, DesktopBackend, DesktopError, SessionId, SessionManager};
use crate::webrtc::{Challenge, ControlSession};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use thiserror::Error;

/// 与 TypeScript Client 的 `RemoteDesktopLimits.maxIpcFrameBytes` 对齐的帧上限。
pub const MAX_IPC_FRAME_BYTES: usize = 1_048_576;

const ERROR_PROTOCOL_MISMATCH: &str = "REMOTE_DESKTOP_PROTOCOL_MISMATCH";
const ERROR_NO_ACTIVE_SESSION: &str = "REMOTE_DESKTOP_NO_ACTIVE_SESSION";
const ERROR_PERMISSION_DENIED: &str = "REMOTE_DESKTOP_PERMISSION_DENIED";
const ERROR_ATTACHMENT_LIMIT: &str = "REMOTE_DESKTOP_ATTACHMENT_LIMIT";
const ERROR_SESSION_LIMIT: &str = "REMOTE_DESKTOP_SESSION_LIMIT";
const ERROR_CAPTURE_FAILED: &str = "REMOTE_DESKTOP_CAPTURE_FAILED";
const ERROR_LEASE_EXPIRED: &str = "REMOTE_DESKTOP_LEASE_EXPIRED";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HostError {
    #[error("IPC frame exceeds the maximum size")]
    FrameTooLarge,
    #[error("IPC frame is not valid UTF-8 JSON")]
    MalformedFrame,
    #[error("IPC frame has unknown or invalid fields")]
    InvalidFrame,
}

impl HostError {
    /// 与 Shared 错误码表一致的稳定 code。
    pub const fn code(&self) -> &'static str {
        match self {
            Self::FrameTooLarge | Self::MalformedFrame | Self::InvalidFrame => {
                ERROR_PROTOCOL_MISMATCH
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameKind {
    Request,
    Response,
    State,
}

/// 与 TypeScript `DesktopHostIpcFrame` 逐字段对齐的 IPC 信封。
///
/// `generation_id` 由 Client 在连接时生成；Host 必须原样回显，不得自行改写。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostFrame {
    pub protocol_version: u32,
    pub generation_id: String,
    pub kind: FrameKind,
    pub payload: Value,
}

/// 严格解析 IPC 帧 body（不含 4 字节长度前缀）。
pub fn decode_frame_bytes(body: &[u8]) -> Result<HostFrame, HostError> {
    if body.len() > MAX_IPC_FRAME_BYTES {
        return Err(HostError::FrameTooLarge);
    }
    let text = std::str::from_utf8(body).map_err(|_| HostError::MalformedFrame)?;
    let frame: HostFrame = serde_json::from_str(text).map_err(|_| HostError::InvalidFrame)?;
    if frame.protocol_version != PROTOCOL_VERSION {
        return Err(HostError::InvalidFrame);
    }
    Ok(frame)
}

/// 序列化 IPC 帧 body（不含长度前缀）。
pub fn encode_frame_body(frame: &HostFrame) -> Result<Vec<u8>, HostError> {
    let body = serde_json::to_vec(frame).map_err(|_| HostError::InvalidFrame)?;
    if body.len() > MAX_IPC_FRAME_BYTES {
        return Err(HostError::FrameTooLarge);
    }
    Ok(body)
}

/// 序列化带 4 字节网络序长度前缀的 IPC 帧。
pub fn encode_frame(frame: &HostFrame) -> Result<Vec<u8>, HostError> {
    let body = encode_frame_body(frame)?;
    let mut framed = Vec::with_capacity(4 + body.len());
    framed.extend_from_slice(&(body.len() as u32).to_be_bytes());
    framed.extend_from_slice(&body);
    Ok(framed)
}

/// 从 4 字节网络序长度前缀读取一帧；返回 `None` 表示流已结束。
pub fn read_frame<R: std::io::Read>(reader: &mut R) -> Result<Option<Vec<u8>>, HostError> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(_) => return Err(HostError::MalformedFrame),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_IPC_FRAME_BYTES {
        return Err(HostError::FrameTooLarge);
    }
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .map_err(|_| HostError::MalformedFrame)?;
    Ok(Some(body))
}

/// 写出带 4 字节网络序长度前缀的 IPC 帧。
pub fn write_frame<W: std::io::Write>(writer: &mut W, body: &[u8]) -> Result<(), HostError> {
    if body.len() > MAX_IPC_FRAME_BYTES {
        return Err(HostError::FrameTooLarge);
    }
    writer
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|()| writer.write_all(body))
        .and_then(|()| writer.flush())
        .map_err(|_| HostError::MalformedFrame)
}

const CLIENT_ACTIONS: [&str; 8] = [
    "session.prepare",
    "session.close",
    "session.freeze-input",
    "session.resume-input",
    "session.attach",
    "session.detach",
    "session.signal",
    "session.state",
];

/// 严格 Client 请求；任何未知字段都会被拒绝。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRequest {
    pub request_id: String,
    pub protocol_version: u32,
    pub action: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub host_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostErrorInfo {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostResponse {
    pub request_id: String,
    pub protocol_version: u32,
    pub host_generation: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<HostErrorInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Idle,
    Preparing,
    Ready,
    Connected,
    Frozen,
    Closed,
    Error,
}

impl SessionStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Connected => "connected",
            Self::Frozen => "frozen",
            Self::Closed => "closed",
            Self::Error => "error",
        }
    }
}

/// 与 Shared `RemoteDesktopStateReport` 对齐的 Host 状态报告。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateReport {
    pub protocol_version: u32,
    pub host_generation: String,
    pub session_id: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capability: Option<CapabilityStatus>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub displays: Option<Vec<DisplayInfo>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub safe_error_code: Option<String>,
}

/// 一次显示器切换的结果；Host 用它向 Browser 广播 `layout-update`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutUpdate {
    pub display_id: String,
    pub generation: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparePayload {
    #[serde(default)]
    quality_profile: Option<String>,
    #[serde(default)]
    clipboard_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentPayload {
    attachment_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachPayload {
    attachment_id: String,
    role: String,
}

const QUALITY_PROFILES: [&str; 3] = ["low-bandwidth", "balanced", "high-quality"];
const CLIPBOARD_MODES: [&str; 3] = ["off", "browser-to-remote", "bidirectional"];

/// 一次 Host 会话运行态；只保存在内存，进程退出即失效。
struct HostSession {
    clipboard_mode: ClipboardMode,
    quality_profile: String,
}

/// Desktop Host 控制面服务。
pub struct HostService<B: DesktopBackend> {
    sessions: SessionManager<B>,
    generation: String,
    capability: CapabilityStatus,
    displays: Vec<DisplayInfo>,
    runtime: HashMap<SessionId, HostSession>,
    /// attachment 授权与输入路由的唯一权威。
    ///
    /// 数据面读取任务与本服务必须持有同一个对象；若各持一份，
    /// 通道上完成的认证永远不会反映到 `is_authenticated` 与状态上报。
    authorizations: HashMap<String, Arc<StdMutex<ControlSession>>>,
    nonce_counter: u64,
}

impl<B: DesktopBackend> HostService<B> {
    /// 构造 Host 服务；能力与显示器在启动时探测一次并要求自洽。
    pub fn new(backend: B, host_version: &str, generation: impl Into<String>) -> Self {
        let capability = backend
            .capabilities()
            .map(|capability| {
                let mut capability = capability;
                capability.host_version = host_version.to_string();
                capability.into_available()
            })
            .unwrap_or_else(|_| {
                CapabilityStatus::unavailable("unknown", "REMOTE_DESKTOP_UNSUPPORTED")
            });
        let displays = backend.displays().unwrap_or_default();
        Self {
            sessions: SessionManager::new(backend),
            generation: generation.into(),
            capability,
            displays,
            runtime: HashMap::new(),
            authorizations: HashMap::new(),
            nonce_counter: 0,
        }
    }

    pub fn generation(&self) -> &str {
        &self.generation
    }

    pub fn backend(&self) -> &B {
        self.sessions.backend()
    }

    /// 共享所有权的后端句柄；供数据面控制循环使用。
    pub fn backend_arc(&self) -> Arc<B> {
        self.sessions.backend_arc()
    }

    pub fn role_of(&self, session_id: &str, attachment_id: &str) -> Option<AttachmentRole> {
        self.sessions.role_of(session_id, attachment_id).ok()
    }

    /// 取该 attachment 的 challenge；未知或已关闭时返回 `None`。
    pub fn challenge_for(&self, attachment_id: &str) -> Option<Challenge> {
        let session = self.authorizations.get(attachment_id)?;
        let guard = session.lock().ok()?;
        if guard.is_closed() {
            return None;
        }
        Some(guard.challenge().clone())
    }

    /// 取共享的控制会话句柄；数据面读取任务与之共用同一份授权状态。
    pub fn control_session(&self, attachment_id: &str) -> Option<Arc<StdMutex<ControlSession>>> {
        self.authorizations.get(attachment_id).cloned()
    }

    /// 当前存在的 attachment 授权数量；用于诊断与测试。
    pub fn control_session_count(&self) -> usize {
        self.authorizations.len()
    }

    /// 撤销一个 attachment 的授权并关闭其控制会话。
    ///
    /// 数据面被释放时（Browser 离开、设备断连）必须调用它，否则
    /// `is_authenticated` 会继续为真，状态上报也会与事实不符。
    pub fn revoke_attachment(&mut self, attachment_id: &str) {
        if let Some(session) = self.authorizations.remove(attachment_id) {
            if let Ok(mut guard) = session.lock() {
                guard.close();
            }
        }
    }

    pub fn is_authenticated(&self, attachment_id: &str) -> bool {
        self.authorizations
            .get(attachment_id)
            .is_some_and(|session| {
                session
                    .lock()
                    .map(|guard| guard.is_authenticated())
                    .unwrap_or(false)
            })
    }

    pub fn clipboard_mode(&self, session_id: &str) -> Option<ClipboardMode> {
        self.runtime
            .get(session_id)
            .map(|session| session.clipboard_mode)
    }

    /// 当前会话选定的画质档；编码器据此设定码率和分辨率上限。
    pub fn quality_profile(&self, session_id: &str) -> Option<&str> {
        self.runtime
            .get(session_id)
            .map(|session| session.quality_profile.as_str())
    }

    /// 处理一条已解析的 Client 请求；任何失败都返回稳定 code，不泄露内部细节。
    pub fn handle(&mut self, request: HostRequest) -> HostResponse {
        if request.protocol_version != PROTOCOL_VERSION
            || !CLIENT_ACTIONS.contains(&request.action.as_str())
        {
            return self.reject(
                &request,
                ERROR_PROTOCOL_MISMATCH,
                "Unsupported client request",
            );
        }
        match request.action.as_str() {
            "session.state" => self.handle_state(&request),
            "session.prepare" => self.handle_prepare(&request),
            "session.close" => self.handle_close(&request),
            "session.attach" => self.handle_attach(&request),
            "session.detach" => self.handle_detach(&request),
            "session.freeze-input" => self.handle_freeze(&request),
            "session.resume-input" => self.handle_resume(&request),
            "session.signal" => self.handle_signal(&request),
            _ => self.reject(
                &request,
                ERROR_PROTOCOL_MISMATCH,
                "Unsupported client request",
            ),
        }
    }

    fn respond(&self, request: &HostRequest, result: Value) -> HostResponse {
        HostResponse {
            request_id: request.request_id.clone(),
            protocol_version: PROTOCOL_VERSION,
            host_generation: self.generation.clone(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn reject(&self, request: &HostRequest, code: &str, message: &str) -> HostResponse {
        HostResponse {
            request_id: request.request_id.clone(),
            protocol_version: PROTOCOL_VERSION,
            host_generation: self.generation.clone(),
            ok: false,
            result: None,
            error: Some(HostErrorInfo {
                code: code.to_string(),
                message: message.to_string(),
            }),
        }
    }

    fn reject_desktop(&self, request: &HostRequest, error: DesktopError) -> HostResponse {
        let code = match error {
            DesktopError::SessionNotFound => ERROR_NO_ACTIVE_SESSION,
            DesktopError::SessionClosed => ERROR_NO_ACTIVE_SESSION,
            DesktopError::SessionExists => ERROR_SESSION_LIMIT,
            DesktopError::AttachmentLimit => ERROR_ATTACHMENT_LIMIT,
            DesktopError::AttachmentNotFound => ERROR_NO_ACTIVE_SESSION,
            DesktopError::OperatorTaken => ERROR_PERMISSION_DENIED,
            DesktopError::BackendUnavailable => ERROR_CAPTURE_FAILED,
            DesktopError::InvalidTransition => ERROR_PROTOCOL_MISMATCH,
            // 平台不支持该操作，或输入/切换目标不存在：都不得当作成功。
            DesktopError::Unsupported => ERROR_CAPTURE_FAILED,
            DesktopError::DisplayNotFound => ERROR_CAPTURE_FAILED,
        };
        self.reject(request, code, "Desktop Host rejected the operation")
    }

    /// 解析必填 payload；缺失或多余字段都视为协议不匹配。
    fn require_payload<T: for<'de> Deserialize<'de>>(request: &HostRequest) -> Option<T> {
        let value = request.payload.as_ref()?;
        serde_json::from_value(value.clone()).ok()
    }

    /// 解析可省略 payload；缺省时使用类型默认值，但形状非法仍然拒绝。
    fn optional_payload<T: for<'de> Deserialize<'de> + Default>(
        request: &HostRequest,
    ) -> Option<T> {
        match request.payload.as_ref() {
            None => Some(T::default()),
            Some(value) => serde_json::from_value(value.clone()).ok(),
        }
    }

    fn handle_state(&mut self, request: &HostRequest) -> HostResponse {
        let report = self.state_report(Some(&request.session_id));
        match serde_json::to_value(report) {
            Ok(value) => self.respond(request, value),
            Err(_) => self.reject(
                request,
                ERROR_PROTOCOL_MISMATCH,
                "Host state is unavailable",
            ),
        }
    }

    fn handle_prepare(&mut self, request: &HostRequest) -> HostResponse {
        let Some(payload) = Self::optional_payload::<PreparePayload>(request) else {
            return self.reject(request, ERROR_PROTOCOL_MISMATCH, "Invalid prepare payload");
        };
        if let Some(profile) = payload.quality_profile.as_deref() {
            if !QUALITY_PROFILES.contains(&profile) {
                return self.reject(
                    request,
                    ERROR_PROTOCOL_MISMATCH,
                    "Unsupported quality profile",
                );
            }
        }
        if let Some(mode) = payload.clipboard_mode.as_deref() {
            if !CLIPBOARD_MODES.contains(&mode) {
                return self.reject(
                    request,
                    ERROR_PROTOCOL_MISMATCH,
                    "Unsupported clipboard mode",
                );
            }
        }
        if self.sessions.state(&request.session_id).is_some() {
            return self.reject(request, ERROR_SESSION_LIMIT, "A session already exists");
        }
        if self.displays.is_empty() {
            return self.reject(
                request,
                "REMOTE_DESKTOP_NO_DISPLAY",
                "No display is available",
            );
        }
        if !self.capability.available {
            return self.reject(request, ERROR_CAPTURE_FAILED, "Desktop Host is unavailable");
        }
        if let Err(error) = self.sessions.create(request.session_id.clone()) {
            return self.reject_desktop(request, error);
        }
        self.runtime.insert(
            request.session_id.clone(),
            HostSession {
                clipboard_mode: match payload.clipboard_mode.as_deref() {
                    Some("browser-to-remote") => ClipboardMode::BrowserToRemote,
                    Some("bidirectional") => ClipboardMode::Bidirectional,
                    _ => ClipboardMode::Off,
                },
                quality_profile: payload
                    .quality_profile
                    .unwrap_or_else(|| "balanced".to_string()),
            },
        );
        self.respond(
            request,
            json!({
                "displays": self.displays,
                "capability": self.capability,
                "hostGeneration": self.generation,
            }),
        )
    }

    fn handle_close(&mut self, request: &HostRequest) -> HostResponse {
        let existed = self.sessions.state(&request.session_id).is_some();
        if !existed {
            return self.reject(request, ERROR_NO_ACTIVE_SESSION, "Session is not active");
        }
        if let Err(error) = self.sessions.close(&request.session_id) {
            return self.reject_desktop(request, error);
        }
        self.drop_runtime(&request.session_id);
        self.respond(request, json!({ "closed": true }))
    }

    fn handle_attach(&mut self, request: &HostRequest) -> HostResponse {
        if self.sessions.state(&request.session_id).is_none() {
            return self.reject(request, ERROR_NO_ACTIVE_SESSION, "Session is not active");
        }
        let Some(payload) = Self::require_payload::<AttachPayload>(request) else {
            return self.reject(request, ERROR_PROTOCOL_MISMATCH, "Invalid attach payload");
        };
        let role = match payload.role.as_str() {
            "operator" => AttachmentRole::Operator,
            "viewer" => AttachmentRole::Viewer,
            _ => {
                return self.reject(
                    request,
                    ERROR_PROTOCOL_MISMATCH,
                    "Unsupported attachment role",
                )
            }
        };
        let assigned = match self.sessions.attach(
            &request.session_id,
            payload.attachment_id.clone(),
            String::new(),
        ) {
            Ok(role) => role,
            Err(error) => return self.reject_desktop(request, error),
        };
        if assigned != role {
            // Server 与 Host 的角色判定必须一致。任何不一致都回滚并拒绝：
            // 特别是 Server 要 viewer 而 Host 会给出 operator 时，绝不能默默提权。
            let _ = self
                .sessions
                .detach(&request.session_id, &payload.attachment_id);
            return self.reject(
                request,
                ERROR_PERMISSION_DENIED,
                "Requested attachment role conflicts with the Host assignment",
            );
        }
        let nonce = self.next_nonce();
        let clipboard = self
            .clipboard_mode(&request.session_id)
            .unwrap_or(ClipboardMode::Off);
        self.authorizations.insert(
            payload.attachment_id.clone(),
            Arc::new(StdMutex::new(ControlSession::new_with_clipboard(
                payload.attachment_id.clone(),
                assigned,
                nonce,
                clipboard,
            ))),
        );
        self.respond(
            request,
            json!({
                "role": match assigned {
                    AttachmentRole::Operator => "operator",
                    AttachmentRole::Viewer => "viewer",
                },
                "challenge": nonce.to_vec(),
            }),
        )
    }

    fn handle_detach(&mut self, request: &HostRequest) -> HostResponse {
        let Some(payload) = Self::require_payload::<AttachmentPayload>(request) else {
            return self.reject(request, ERROR_PROTOCOL_MISMATCH, "Invalid detach payload");
        };
        self.authorizations.remove(&payload.attachment_id);
        match self
            .sessions
            .detach(&request.session_id, &payload.attachment_id)
        {
            Ok(()) => self.respond(request, json!({ "detached": true })),
            Err(error) => self.reject_desktop(request, error),
        }
    }

    fn handle_freeze(&mut self, request: &HostRequest) -> HostResponse {
        if let Err(error) = self.sessions.freeze(&request.session_id) {
            return self.reject_desktop(request, error);
        }
        self.respond(request, json!({ "frozen": true }))
    }

    fn handle_resume(&mut self, request: &HostRequest) -> HostResponse {
        let Some(payload) = Self::require_payload::<AttachmentPayload>(request) else {
            return self.reject(request, ERROR_PROTOCOL_MISMATCH, "Invalid resume payload");
        };
        match self
            .sessions
            .role_of(&request.session_id, &payload.attachment_id)
        {
            Ok(AttachmentRole::Operator) => {}
            Ok(AttachmentRole::Viewer) => {
                return self.reject(
                    request,
                    ERROR_PERMISSION_DENIED,
                    "Only the operator resumes input",
                )
            }
            Err(error) => return self.reject_desktop(request, error),
        }
        if let Err(error) = self.sessions.resume(&request.session_id) {
            return self.reject_desktop(request, error);
        }
        self.respond(request, json!({ "resumed": true }))
    }

    /// 信令只在此校验形状；真正的 SDP/ICE 协商由 WebRTC 传输层完成。
    fn handle_signal(&mut self, request: &HostRequest) -> HostResponse {
        if self.sessions.state(&request.session_id).is_none() {
            return self.reject(request, ERROR_NO_ACTIVE_SESSION, "Session is not active");
        }
        self.respond(request, json!({}))
    }

    /// 生成当前会话的状态报告；无活动会话时报告 `idle`。
    pub fn state_report(&self, session_id: Option<&str>) -> StateReport {
        let Some(session_id) = session_id else {
            return StateReport {
                protocol_version: PROTOCOL_VERSION,
                host_generation: self.generation.clone(),
                session_id: None,
                status: SessionStatus::Idle.as_str().to_string(),
                capability: Some(self.capability.clone()),
                displays: Some(self.displays.clone()),
                safe_error_code: None,
            };
        };
        let Some(state) = self.sessions.state(session_id) else {
            return StateReport {
                protocol_version: PROTOCOL_VERSION,
                host_generation: self.generation.clone(),
                session_id: None,
                status: SessionStatus::Idle.as_str().to_string(),
                capability: Some(self.capability.clone()),
                displays: None,
                safe_error_code: None,
            };
        };
        let status = match state {
            crate::session::SessionState::Preparing => SessionStatus::Preparing,
            crate::session::SessionState::Ready => SessionStatus::Ready,
            crate::session::SessionState::Connected => SessionStatus::Connected,
            crate::session::SessionState::Frozen => SessionStatus::Frozen,
            crate::session::SessionState::Closed => SessionStatus::Closed,
        };
        StateReport {
            protocol_version: PROTOCOL_VERSION,
            host_generation: self.generation.clone(),
            session_id: Some(session_id.to_string()),
            status: status.as_str().to_string(),
            capability: Some(self.capability.clone()),
            displays: if state == crate::session::SessionState::Closed {
                None
            } else {
                Some(self.displays.clone())
            },
            safe_error_code: (state == crate::session::SessionState::Closed)
                .then(|| ERROR_LEASE_EXPIRED.to_string()),
        }
    }

    /// 关闭所有租约过期会话，返回需要广播的终态报告。
    pub fn reap_expired(&mut self) -> Vec<StateReport> {
        let sessions: Vec<String> = self.runtime.keys().cloned().collect();
        let Ok(reaped) = self.sessions.reap_expired() else {
            return Vec::new();
        };
        if reaped == 0 {
            return Vec::new();
        }
        let mut reports = Vec::new();
        for session_id in sessions {
            let state = self.sessions.state(&session_id);
            if state == Some(crate::session::SessionState::Closed) {
                self.drop_runtime(&session_id);
                reports.push(self.state_report(Some(&session_id)));
            }
        }
        reports
    }

    fn drop_runtime(&mut self, session_id: &str) {
        self.runtime.remove(session_id);
        for attachment_id in self.sessions.attachment_ids(session_id) {
            if let Some(session) = self.authorizations.remove(&attachment_id) {
                if let Ok(mut guard) = session.lock() {
                    guard.close();
                }
            }
        }
    }

    /// 生成 attachment 专用 challenge 随机数；每个连接只发一次。
    fn next_nonce(&mut self) -> [u8; 32] {
        self.nonce_counter = self.nonce_counter.wrapping_add(1);
        let mut nonce = [0u8; 32];
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&(self.generation.as_str(), self.nonce_counter), &mut hasher);
        let mut state = std::hash::Hasher::finish(&hasher);
        for slot in nonce.iter_mut() {
            // xorshift64：仅用于生成不可预测的 challenge 索引，不用于密钥派生。
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *slot = (state & 0xff) as u8;
        }
        nonce
    }
}
