//! 视频编码抽象。
//!
//! ## 为什么编码器不放进 `DesktopBackend`
//!
//! 平台编码器通常持有**有套间归属的资源**（Windows 上是 Media Foundation 的
//! `IMFTransform`，内含 `NonNull<c_void>`）。这类对象**不是 `Send`/`Sync`**，
//! 而 `DesktopBackend` 要求两者，因此把编码器塞进后端会直接编译失败。
//!
//! ## 正确形态：工厂（`Send + Sync`）+ 线程独享实例
//!
//! - [`EncoderFactory`] 只持配置，不持平台资源，所以可以放进共享运行时；
//! - [`VideoEncoder`] 由**媒体循环线程独占**：在该线程上创建、在该线程上使用、
//!   在该线程上释放。媒体循环因此必须跑在独占线程（`current_thread` 运行时）上，
//!   否则 tokio 会在 await 点把任务迁到别的线程，破坏套间归属假设。

use crate::media::{CapturedFrame, VideoFrame};
use crate::session::DesktopError;

/// 有状态的视频编码器；由一个线程独占使用。
pub trait VideoEncoder {
    /// 编码一帧。
    ///
    /// 返回 `Ok(None)` 表示编码器仍在预热（如 lookahead 未满）而尚无输出——
    /// 这不是错误。尺寸与创建时不一致时必须返回错误，由调用方重建编码器。
    fn encode(
        &mut self,
        frame: &CapturedFrame,
        sequence: u64,
        key_frame: bool,
    ) -> Result<Option<VideoFrame>, DesktopError>;
}

/// 编码器工厂；只持配置，因此可以放进共享运行时。
pub trait EncoderFactory: Send + Sync {
    /// 为给定尺寸创建一个编码器；必须在**调用方自己的线程**上创建。
    fn create(&self, width: u32, height: u32) -> Result<Box<dyn VideoEncoder>, DesktopError>;

    /// 该工厂能产出的编解码格式名，用于能力上报（如 `["H264"]`）。
    fn codecs(&self) -> Vec<String>;
}
