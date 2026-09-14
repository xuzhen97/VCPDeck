use crate::media::{CapturedFrame, InputEvent};
use crate::protocol::{CapabilityStatus, DisplayInfo};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use zeroize::Zeroizing;

pub type SessionId = String;

pub const MAX_ATTACHMENTS: usize = 4;
pub const LEASE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Preparing,
    Ready,
    Connected,
    Frozen,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentRole {
    Operator,
    Viewer,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DesktopError {
    #[error("desktop backend unavailable")]
    BackendUnavailable,
    #[error("session already exists")]
    SessionExists,
    #[error("session not found")]
    SessionNotFound,
    #[error("session is closed")]
    SessionClosed,
    #[error("attachment limit reached")]
    AttachmentLimit,
    #[error("operator already assigned")]
    OperatorTaken,
    #[error("invalid transition")]
    InvalidTransition,
    #[error("attachment not found")]
    AttachmentNotFound,
    #[error("operation not supported by this platform backend")]
    Unsupported,
    #[error("display not found")]
    DisplayNotFound,
}

pub trait DesktopBackend: Send + Sync {
    fn capabilities(&self) -> Result<CapabilityStatus, DesktopError>;
    fn displays(&self) -> Result<Vec<DisplayInfo>, DesktopError>;
    fn release_all_inputs(&self) -> Result<(), DesktopError>;
    /// 向活动桌面注入一个已归一化的输入事件。
    ///
    /// 平台不支持时必须返回 `DesktopError::Unsupported`，绝不静默成功：
    /// 静默成功会让 Browser 以为输入已送达而用户毫无反馈。
    fn inject_input(&self, event: &InputEvent) -> Result<(), DesktopError>;
    /// 请求平台发送 Secure Attention Sequence（Ctrl+Alt+Del）。
    fn secure_attention(&self) -> Result<(), DesktopError>;
    /// 切换后续捕获与输入的目标显示器；未知 ID 必须返回 `DisplayNotFound`。
    fn select_display(&self, display_id: &str) -> Result<(), DesktopError>;
    /// 把 Browser 发来的纯文本写入远端系统剪贴板。
    ///
    /// 调用方必须先完成 `clipboardMode` 与角色校验；平台不支持时返回
    /// `DesktopError::Unsupported`，不得静默成功。
    fn write_clipboard_text(&self, text: &str) -> Result<(), DesktopError>;
    /// 读取远端系统剪贴板的纯文本；无文本时返回 `None`。
    ///
    /// 调用方按固定间隔轮询并对结果去重；平台不支持时返回 `Unsupported`。
    fn read_clipboard_text(&self) -> Result<Option<String>, DesktopError>;
    /// 捕获目标显示器的一帧 BGRA 原始像素。
    ///
    /// `display_id` 为 `None` 时捕获主显示器。平台不支持或捕获失败时必须返回
    /// 错误：返回合成分辨率的空白帧会让上层以为画面在流动。
    fn capture_frame(&self, display_id: Option<&str>) -> Result<CapturedFrame, DesktopError>;
}

#[derive(Debug)]
struct Attachment {
    role: AttachmentRole,
    reconnect_secret: Zeroizing<String>,
    last_seen: Instant,
}

#[derive(Debug)]
struct Session {
    state: SessionState,
    attachments: HashMap<String, Attachment>,
    operator: Option<String>,
    last_activity: Instant,
}

pub struct SessionManager<B: DesktopBackend> {
    backend: Arc<B>,
    sessions: HashMap<SessionId, Session>,
}

impl<B: DesktopBackend> SessionManager<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend: Arc::new(backend),
            sessions: HashMap::new(),
        }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    /// 共享所有权的后端句柄；供长时运行的控制循环任务使用。
    pub fn backend_arc(&self) -> Arc<B> {
        Arc::clone(&self.backend)
    }

    pub fn create(&mut self, session_id: SessionId) -> Result<(), DesktopError> {
        if self.sessions.contains_key(&session_id) {
            return Err(DesktopError::SessionExists);
        }
        self.backend.capabilities()?;
        self.backend.displays()?;
        self.sessions.insert(
            session_id,
            Session {
                state: SessionState::Ready,
                attachments: HashMap::new(),
                operator: None,
                last_activity: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn state(&self, session_id: &str) -> Option<SessionState> {
        self.sessions.get(session_id).map(|session| session.state)
    }

    pub fn attachment_count(&self, session_id: &str) -> Result<usize, DesktopError> {
        Ok(self
            .sessions
            .get(session_id)
            .ok_or(DesktopError::SessionNotFound)?
            .attachments
            .len())
    }

    pub fn role_of(
        &self,
        session_id: &str,
        attachment_id: &str,
    ) -> Result<AttachmentRole, DesktopError> {
        Ok(self
            .sessions
            .get(session_id)
            .ok_or(DesktopError::SessionNotFound)?
            .attachments
            .get(attachment_id)
            .ok_or(DesktopError::AttachmentNotFound)?
            .role)
    }

    /// 返回会话当前的全部 attachment ID；用于在会话关闭时释放授权。
    pub fn attachment_ids(&self, session_id: &str) -> Vec<String> {
        self.sessions
            .get(session_id)
            .map(|session| session.attachments.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn attach(
        &mut self,
        session_id: &str,
        attachment_id: String,
        secret: String,
    ) -> Result<AttachmentRole, DesktopError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DesktopError::SessionNotFound)?;
        if session.state == SessionState::Closed {
            return Err(DesktopError::SessionClosed);
        }
        if session.attachments.len() >= MAX_ATTACHMENTS {
            return Err(DesktopError::AttachmentLimit);
        }
        let role = if session.operator.is_none() {
            session.operator = Some(attachment_id.clone());
            AttachmentRole::Operator
        } else {
            AttachmentRole::Viewer
        };
        session.attachments.insert(
            attachment_id,
            Attachment {
                role,
                reconnect_secret: Zeroizing::new(secret),
                last_seen: Instant::now(),
            },
        );
        session.state = SessionState::Connected;
        session.last_activity = Instant::now();
        Ok(role)
    }

    pub fn verify_secret(
        &self,
        session_id: &str,
        attachment_id: &str,
        secret: &str,
    ) -> Result<bool, DesktopError> {
        let attachment = self
            .sessions
            .get(session_id)
            .ok_or(DesktopError::SessionNotFound)?
            .attachments
            .get(attachment_id)
            .ok_or(DesktopError::AttachmentNotFound)?;
        Ok(attachment.reconnect_secret.as_str() == secret)
    }

    pub fn touch(&mut self, session_id: &str, attachment_id: &str) -> Result<(), DesktopError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DesktopError::SessionNotFound)?;
        let attachment = session
            .attachments
            .get_mut(attachment_id)
            .ok_or(DesktopError::AttachmentNotFound)?;
        attachment.last_seen = Instant::now();
        session.last_activity = Instant::now();
        Ok(())
    }

    pub fn freeze(&mut self, session_id: &str) -> Result<(), DesktopError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DesktopError::SessionNotFound)?;
        if session.state == SessionState::Closed {
            return Err(DesktopError::SessionClosed);
        }
        self.backend.release_all_inputs()?;
        session.state = SessionState::Frozen;
        session.last_activity = Instant::now() - LEASE_TIMEOUT;
        Ok(())
    }

    /// 解除冻结并刷新租约；仅由 Server 在确认 operator 后调用。
    pub fn resume(&mut self, session_id: &str) -> Result<(), DesktopError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DesktopError::SessionNotFound)?;
        match session.state {
            SessionState::Closed => return Err(DesktopError::SessionClosed),
            SessionState::Ready => return Err(DesktopError::InvalidTransition),
            _ => {}
        }
        session.state = SessionState::Connected;
        session.last_activity = Instant::now();
        Ok(())
    }

    /// 移除一个 attachment；operator 断开时释放控制权但不关闭会话。
    pub fn detach(&mut self, session_id: &str, attachment_id: &str) -> Result<(), DesktopError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DesktopError::SessionNotFound)?;
        if session.attachments.remove(attachment_id).is_none() {
            return Err(DesktopError::AttachmentNotFound);
        }
        if session.operator.as_deref() == Some(attachment_id) {
            session.operator = None;
        }
        if session.attachments.is_empty() && session.state != SessionState::Closed {
            session.state = SessionState::Ready;
        }
        session.last_activity = Instant::now();
        Ok(())
    }

    pub fn close(&mut self, session_id: &str) -> Result<(), DesktopError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DesktopError::SessionNotFound)?;
        self.backend.release_all_inputs()?;
        session.state = SessionState::Closed;
        session.attachments.clear();
        session.operator = None;
        Ok(())
    }

    pub fn reap_expired(&mut self) -> Result<usize, DesktopError> {
        let now = Instant::now();
        let expired: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session.state != SessionState::Closed
                    && now.duration_since(session.last_activity) >= LEASE_TIMEOUT
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            self.close(id)?;
        }
        Ok(expired.len())
    }
}
