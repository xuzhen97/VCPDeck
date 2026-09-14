//! 可重复驱动的假编码器，用于验证媒体循环而不依赖真实平台编码器。
//!
//! 它产出**结构上像 H.264 的确定性字节**（Annex-B 起始码 + IDR NAL），因此
//! 测试可以验证扇出、关键帧标记与预热行为，而不必依赖硬件或系统编码器。
//! 它绝不代表真实编码质量，也不得被当作能力上报依据。

use desktop_core::encoder::{EncoderFactory, VideoEncoder};
use desktop_core::media::{CapturedFrame, VideoFrame};
use desktop_core::session::DesktopError;

/// 预热帧数：前 N 帧不产出，用于验证“预热中返回 None 不是错误”。
pub const DEFAULT_WARMUP_FRAMES: usize = 2;

pub struct MockEncoder {
    width: u32,
    height: u32,
    produced: usize,
    warmup: usize,
}

impl MockEncoder {
    pub fn new(width: u32, height: u32, warmup: usize) -> Self {
        Self {
            width,
            height,
            produced: 0,
            warmup,
        }
    }
}

impl VideoEncoder for MockEncoder {
    fn encode(
        &mut self,
        frame: &CapturedFrame,
        sequence: u64,
        _key_frame: bool,
    ) -> Result<Option<VideoFrame>, DesktopError> {
        if frame.width != self.width || frame.height != self.height {
            return Err(DesktopError::Unsupported);
        }
        if self.produced < self.warmup {
            self.produced += 1;
            return Ok(None);
        }
        // 起始码 00 00 00 01 + NAL 头 0x65（nal_ref_idc=3, type=5 ⇒ IDR）。
        let mut bytes = vec![0u8, 0, 0, 1, 0x65];
        // 带上序号，便于测试断言“每个 attachment 都收到同一段数据”。
        bytes.extend_from_slice(&sequence.to_be_bytes());
        bytes.extend_from_slice(&(self.width as u16).to_be_bytes());
        Ok(Some(VideoFrame {
            sequence,
            width: self.width,
            height: self.height,
            timestamp_ms: sequence * 33,
            key_frame: true,
            bytes,
        }))
    }
}

#[derive(Default)]
pub struct MockEncoderFactory {
    pub warmup: usize,
}

impl EncoderFactory for MockEncoderFactory {
    fn create(&self, width: u32, height: u32) -> Result<Box<dyn VideoEncoder>, DesktopError> {
        Ok(Box::new(MockEncoder::new(width, height, self.warmup)))
    }

    fn codecs(&self) -> Vec<String> {
        vec!["VP8".to_string()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32) -> CapturedFrame {
        CapturedFrame::new(
            width,
            height,
            vec![0u8; width as usize * height as usize * 4],
        )
        .expect("frame")
    }

    #[test]
    fn returns_none_during_warmup_and_bytes_after() {
        let mut encoder = MockEncoder::new(4, 4, 2);
        assert!(encoder
            .encode(&frame(4, 4), 0, true)
            .expect("encode")
            .is_none());
        assert!(encoder
            .encode(&frame(4, 4), 1, true)
            .expect("encode")
            .is_none());
        let produced = encoder.encode(&frame(4, 4), 2, true).expect("encode");
        let produced = produced.expect("第三帧应产出");
        assert_eq!(
            &produced.bytes[..5],
            &[0, 0, 0, 1, 0x65],
            "应是 Annex-B IDR"
        );
        assert!(produced.key_frame);
        assert_eq!(produced.sequence, 2);
    }

    #[test]
    fn rejects_a_frame_of_the_wrong_size() {
        let mut encoder = MockEncoder::new(4, 4, 0);
        assert!(encoder.encode(&frame(8, 8), 0, false).is_err());
    }

    #[test]
    fn factory_reports_its_codec() {
        assert_eq!(
            MockEncoderFactory::default().codecs(),
            vec!["VP8".to_string()]
        );
    }
}
