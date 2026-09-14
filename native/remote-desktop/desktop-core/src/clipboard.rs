use crate::session::AttachmentRole;
use thiserror::Error;

pub const MAX_CLIPBOARD_BYTES: usize = 262_144;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardMode {
    Off,
    BrowserToRemote,
    Bidirectional,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardText {
    pub text: String,
}

impl ClipboardText {
    pub const MAX_BYTES: usize = MAX_CLIPBOARD_BYTES;

    pub fn new(text: String) -> Result<Self, ClipboardError> {
        if text.len() > MAX_CLIPBOARD_BYTES {
            return Err(ClipboardError::TooLarge);
        }
        Ok(Self { text })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ClipboardError {
    #[error("clipboard is disabled")]
    Disabled,
    #[error("clipboard direction is not permitted")]
    DirectionDenied,
    #[error("clipboard text exceeds the maximum size")]
    TooLarge,
    #[error("clipboard text must be valid UTF-8")]
    InvalidUtf8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardDirection {
    BrowserToRemote,
    RemoteToBrowser,
}

impl ClipboardMode {
    pub const fn allows(self, role: AttachmentRole, direction: ClipboardDirection) -> bool {
        matches!(
            (self, role, direction),
            (
                Self::BrowserToRemote,
                AttachmentRole::Operator,
                ClipboardDirection::BrowserToRemote,
            ) | (
                Self::Bidirectional,
                AttachmentRole::Operator,
                ClipboardDirection::BrowserToRemote,
            ) | (
                Self::Bidirectional,
                AttachmentRole::Operator,
                ClipboardDirection::RemoteToBrowser,
            )
        )
    }

    pub fn validate(
        self,
        role: AttachmentRole,
        direction: ClipboardDirection,
        text: String,
    ) -> Result<ClipboardText, ClipboardError> {
        if matches!(self, Self::Off) {
            return Err(ClipboardError::Disabled);
        }
        if !self.allows(role, direction) {
            return Err(ClipboardError::DirectionDenied);
        }
        ClipboardText::new(text)
    }
}
