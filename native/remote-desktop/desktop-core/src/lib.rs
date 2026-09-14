#![forbid(unsafe_code)]

pub mod clipboard;
pub mod dispatch;
pub mod encoder;
pub mod host;
pub mod input;
pub mod media;
pub mod peer;
pub mod protocol;
pub mod session;
pub mod webrtc;

pub use clipboard::{ClipboardDirection, ClipboardError, ClipboardMode, ClipboardText};
pub use host::{
    decode_frame_bytes, encode_frame, encode_frame_body, read_frame, write_frame, FrameKind,
    HostError, HostErrorInfo, HostFrame, HostRequest, HostResponse, HostService, LayoutUpdate,
    SessionStatus, StateReport, MAX_IPC_FRAME_BYTES,
};
pub use input::InputRouter;
pub use media::{
    InputEvent, InputGate, MediaError, PointerCoalescer, QualityProfile, VideoCodec, VideoFrame,
};
pub use peer::{AttachmentPeer, PeerManager};
pub use protocol::{parse_signal_fixture, CapabilityStatus, DisplayInfo, ProtocolError, Signal};
pub use session::{
    AttachmentRole, DesktopBackend, DesktopError, SessionId, SessionManager, SessionState,
};
pub use webrtc::{
    decode_clipboard_message, decode_control_message, decode_pointer_message, respond_to_challenge,
    AttachmentAuthorization, Challenge, ChallengeResponse, ClipboardMessage, ControlAction,
    ControlInput, ControlMessage, ControlSession, DataChannelKind, DataChannelPolicy,
    PointerMessage, WebRtcError, MAX_CLIPBOARD_MESSAGE_BYTES,
};
