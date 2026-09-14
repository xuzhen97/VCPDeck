use crate::session::AttachmentRole;
use thiserror::Error;

pub const MAX_VIDEO_WIDTH: u32 = 3_840;
pub const MAX_VIDEO_HEIGHT: u32 = 2_160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    Vp8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualityProfile {
    LowBandwidth,
    Balanced,
    HighQuality,
}

impl QualityProfile {
    pub const fn limits(self) -> VideoLimits {
        match self {
            Self::LowBandwidth => VideoLimits {
                max_width: 1_920,
                max_height: 1_080,
                max_fps: 15,
                target_bitrate_kbps: 2_000,
            },
            Self::Balanced => VideoLimits {
                max_width: 2_560,
                max_height: 1_440,
                max_fps: 30,
                target_bitrate_kbps: 4_000,
            },
            Self::HighQuality => VideoLimits {
                max_width: MAX_VIDEO_WIDTH,
                max_height: MAX_VIDEO_HEIGHT,
                max_fps: 60,
                target_bitrate_kbps: 8_000,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u16,
    pub target_bitrate_kbps: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoFrame {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub timestamp_ms: u64,
    pub key_frame: bool,
    pub bytes: Vec<u8>,
}

impl VideoFrame {
    pub fn within(&self, limits: VideoLimits) -> bool {
        self.width > 0
            && self.height > 0
            && self.width <= limits.max_width
            && self.height <= limits.max_height
    }
}

/// 平台捕获到的一帧原始像素（BGRA8，行优先，无行间填充）。
///
/// 后端只负责「把屏幕像素拿出来」，不做色彩空间转换与编码：转 I420 与编码
/// 属于媒体层，拆开后可以脱离真实屏幕做确定性测试。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    /// BGRA8 像素；长度必须严格等于 `width * height * 4`。
    pub pixels: Vec<u8>,
}

impl CapturedFrame {
    /// 构造一帧，并校验缓冲区大小与尺寸一致。
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> Result<Self, MediaError> {
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(MediaError::InvalidFrameBuffer)?;
        if width == 0 || height == 0 || pixels.len() != expected {
            return Err(MediaError::InvalidFrameBuffer);
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    /// 转换为 I420（YUV420 planar，BT.601 limited range）。
    ///
    /// 编码器需要 I420；这一步是纯计算，不依赖平台。
    /// 色度按 2×2 均值下采样，宽高为奇数时多余的一行/列不参与色度计算。
    pub fn to_i420(&self) -> Vec<u8> {
        let width = self.width as usize;
        let height = self.height as usize;
        let luma = width * height;
        let chroma_width = width.div_ceil(2);
        let chroma_height = height.div_ceil(2);
        let chroma = chroma_width * chroma_height;
        let mut out = vec![0u8; luma + chroma * 2];
        let (y_plane, rest) = out.split_at_mut(luma);
        let (u_plane, v_plane) = rest.split_at_mut(chroma);

        for row in 0..height {
            for column in 0..width {
                let offset = (row * width + column) * 4;
                let b = self.pixels[offset] as i32;
                let g = self.pixels[offset + 1] as i32;
                let r = self.pixels[offset + 2] as i32;
                y_plane[row * width + column] =
                    clamp_u8(16 + ((66 * r + 129 * g + 25 * b + 128) >> 8));
            }
        }

        for row in (0..height).step_by(2) {
            for column in (0..width).step_by(2) {
                // 2×2 均值；越界时只取实际存在的像素。
                let mut sum_r = 0i32;
                let mut sum_g = 0i32;
                let mut sum_b = 0i32;
                let mut count = 0i32;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let (y, x) = (row + dy, column + dx);
                        if y >= height || x >= width {
                            continue;
                        }
                        let offset = (y * width + x) * 4;
                        sum_b += self.pixels[offset] as i32;
                        sum_g += self.pixels[offset + 1] as i32;
                        sum_r += self.pixels[offset + 2] as i32;
                        count += 1;
                    }
                }
                if count == 0 {
                    continue;
                }
                let r = sum_r / count;
                let g = sum_g / count;
                let b = sum_b / count;
                let index = (row / 2) * chroma_width + column / 2;
                u_plane[index] = clamp_u8(128 + ((-38 * r - 74 * g + 112 * b + 128) >> 8));
                v_plane[index] = clamp_u8(128 + ((112 * r - 94 * g - 18 * b + 128) >> 8));
            }
        }
        out
    }
}

fn clamp_u8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

impl CapturedFrame {
    /// 转换为 NV12（Y 平面 + 交错 UV 平面，BT.601 limited range）。
    ///
    /// 硬件编码器（NVENC/QSV/AMF）普遍只接受 NV12，因此这是硬编路径的必需转换。
    /// 宽高为奇数时色度按 ceil 下采样：即使编码器可能拒绝奇尺寸，也不在这里
    /// 静默截断像素。
    pub fn to_nv12(&self) -> Vec<u8> {
        let i420 = self.to_i420();
        let width = self.width as usize;
        let height = self.height as usize;
        let luma = width * height;
        let chroma_width = width.div_ceil(2);
        let chroma_height = height.div_ceil(2);
        let chroma = chroma_width * chroma_height;
        let mut out = Vec::with_capacity(luma + chroma * 2);
        out.extend_from_slice(&i420[..luma]);
        let u_plane = &i420[luma..luma + chroma];
        let v_plane = &i420[luma + chroma..];
        // NV12 的 UV 平面上每个色度像素是 (U, V) 交错。
        for index in 0..chroma {
            out.push(u_plane[index]);
            out.push(v_plane[index]);
        }
        out
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MediaError {
    #[error("video frame exceeds profile limits")]
    FrameExceedsLimits,
    #[error("viewer attachments cannot send control input")]
    ViewerInputDenied,
    #[error("input is frozen")]
    InputFrozen,
    #[error("captured frame buffer is inconsistent with its size")]
    InvalidFrameBuffer,
    #[error("unsupported input event")]
    UnsupportedInput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    PointerMove { x: u16, y: u16 },
    Button { button: u8, pressed: bool },
    Wheel { delta_x: i16, delta_y: i16 },
    Key { key_code: u32, pressed: bool },
    ReleaseAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputGate {
    role: AttachmentRole,
    frozen: bool,
}

impl InputGate {
    pub const fn new(role: AttachmentRole) -> Self {
        Self {
            role,
            frozen: false,
        }
    }

    pub const fn freeze(mut self) -> Self {
        self.frozen = true;
        self
    }

    pub const fn role(&self) -> AttachmentRole {
        self.role
    }

    pub fn accept(&self, event: &InputEvent) -> Result<(), MediaError> {
        if self.frozen {
            return Err(MediaError::InputFrozen);
        }
        if self.role != AttachmentRole::Operator {
            return Err(MediaError::ViewerInputDenied);
        }
        if matches!(event, InputEvent::ReleaseAll) {
            return Ok(());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointerSample {
    pub x: u16,
    pub y: u16,
}

#[derive(Debug, Default)]
pub struct PointerCoalescer {
    latest: Option<PointerSample>,
    received: usize,
}

impl PointerCoalescer {
    pub const fn new() -> Self {
        Self {
            latest: None,
            received: 0,
        }
    }

    pub fn push(&mut self, sample: PointerSample) {
        self.latest = Some(sample);
        self.received += 1;
    }

    pub fn take_latest(&mut self) -> Option<PointerSample> {
        self.latest.take()
    }

    pub fn received(&self) -> usize {
        self.received
    }
}
