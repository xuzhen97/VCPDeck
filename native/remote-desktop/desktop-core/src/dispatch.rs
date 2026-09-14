//! 把已授权的控制动作映射为平台后端调用。
//!
//! `ControlSession::handle` 只负责授权、冻结与 generation 校验；真正的副作用
//! （注入输入、发 Secure Attention、切换显示器）必须经过这里落到平台后端。
//! 这一跳是必须存在的：如果只停在 `ControlAction`，输入永远不会到达操作系统。

use crate::media::InputEvent;
use crate::session::{DesktopBackend, DesktopError};
use crate::webrtc::ControlAction;

/// 应用一个已通过授权校验的控制动作。
///
/// 无副作用的纯状态动作（鉴权成功、布局确认）返回 `Ok(())`。
/// 平台不支持或目标不存在时返回错误，由调用方决定断连或上报，绝不静默降级。
pub fn apply_control_action<B: DesktopBackend>(
    backend: &B,
    action: &ControlAction,
) -> Result<(), DesktopError> {
    match action {
        // 鉴权与布局确认只改变 Host 内部状态，没有平台副作用。
        ControlAction::Authenticated | ControlAction::LayoutConfirmed { .. } => Ok(()),
        ControlAction::InputAccepted(event) => backend.inject_input(event),
        ControlAction::PointerAccepted(sample) => backend.inject_input(&InputEvent::PointerMove {
            x: sample.x,
            y: sample.y,
        }),
        ControlAction::InputsReleased => {
            backend.release_all_inputs()?;
            backend.inject_input(&InputEvent::ReleaseAll)
        }
        ControlAction::DisplaySelected { display_id, .. } => backend.select_display(display_id),
        ControlAction::SecureAttentionRequested => backend.secure_attention(),
    }
}
