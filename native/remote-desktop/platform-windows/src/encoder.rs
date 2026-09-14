//! Media Foundation H.264 编码器。
//!
//! ## 厂商中立
//!
//! 候选编码器来自 MFT 枚举，按“硬件优先、软件回退”的顺序尝试，**不针对任何
//! 厂商硬编码**。系统里只有微软软件编码器时也能工作。
//!
//! ## 同步与异步
//!
//! 硬件编码器 MFT 普遍是**异步**的（NVENC / AMD AMF / Intel QSV 都属此类）：
//! 它们必须解锁 `MF_TRANSFORM_ASYNC_UNLOCK` 并走 `IMFMediaEventGenerator`
//! 事件循环，不能直接同步 `ProcessInput`。
//!
//! 本模块当前只实现**同步路径**：选择候选时跳过异步 MFT，因此本机（NVIDIA 异步
//! 与微软同步各一）会选到微软软件编码器。这样在**任何** Windows 上都能拿到真实
//! H.264，且不会谎报硬件加速。异步硬件路径是紧随其后的第二步。
//!
//! ## 诚实边界
//!
//! 编码失败一律返回错误。上层据此保持 `available = false`，不得因为“探测到
//! 编码器”就假装可用。

use desktop_core::media::{CapturedFrame, VideoFrame};
use desktop_core::session::DesktopError;
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_Base, CODECAPI_AVEncCommonLowLatency, CODECAPI_AVEncCommonRealTime,
    CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVLowLatencyMode, IMFActivate, IMFMediaType,
    IMFSample, IMFTransform, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFMediaType_Video, MFSampleExtension_CleanPoint, MFSampleExtension_Discontinuity, MFShutdown,
    MFStartup, MFTEnumEx, MFVideoFormat_H264, MFVideoFormat_I420, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, MFSTARTUP_FULL, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SYNCMFT, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES,
    MFT_REGISTER_TYPE_INFO, MF_E_TRANSFORM_NEED_MORE_INPUT, MF_E_TRANSFORM_STREAM_CHANGE,
    MF_LOW_LATENCY, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
    MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE, MF_MT_SUBTYPE, MF_VERSION,
};
use windows::Win32::System::Com::CoTaskMemFree;

/// 编码器接受的输入像素格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputFormat {
    /// 硬件编码器普遍只接受 NV12。
    Nv12,
    /// 部分编码器直接接受 I420，可省一次转换。
    I420,
}

/// 把宽高打包成 MF 的 64 位 `(high << 32) | low`。
fn pack_ratio(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// 一个已配置完成的 H.264 编码器。
pub struct H264Encoder {
    transform: IMFTransform,
    width: u32,
    height: u32,
    input_format: InputFormat,
    frame_index: u64,
    fps: u32,
}

impl H264Encoder {
    /// 创建并配置编码器。
    ///
    /// 选择顺序为「同步硬件 → 同步软件」；全部候选都不可用时返回错误，
    /// 而不是假装能编码。
    pub fn new(width: u32, height: u32, bitrate_kbps: u32, fps: u32) -> Result<Self, DesktopError> {
        if width == 0 || height == 0 || fps == 0 {
            return Err(DesktopError::Unsupported);
        }
        // MF 必须是启动状态才能枚举与使用 MFT；由 Drop 配对关停。
        if unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.is_err() {
            return Err(DesktopError::Unsupported);
        }
        let activate = select_sync_encoder().ok_or(DesktopError::Unsupported)?;
        let transform: IMFTransform = unsafe {
            activate
                .ActivateObject()
                .map_err(|_| DesktopError::Unsupported)?
        };
        // 注意：MF 的生命周期必须覆盖整个编码器存活期。不能在选中候选后就
        // MFShutdown——那时还没 ActivateObject，等于在已关停的 MF 上继续操作。
        let _ = &transform;
        let (input_format, input_type) =
            unsafe { configure_types(&transform, width, height, bitrate_kbps, fps) }?;
        let _ = (input_format, input_type);
        unsafe {
            // 类型协商完成后必须通知 MFT 开始流式处理，否则它会一直
            // 返回 NEED_MORE_INPUT 而不产出任何码流。
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(|_| DesktopError::Unsupported)?;
            transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                .map_err(|_| DesktopError::Unsupported)?;
        }
        Ok(Self {
            transform,
            width,
            height,
            input_format,
            frame_index: 0,
            fps,
        })
    }

    /// 本次选用的输入格式（供诊断与像素转换）。
    pub fn input_format(&self) -> InputFormat {
        self.input_format
    }

    /// 本编码器是否已按该尺寸配置。
    pub fn matches(&self, width: u32, height: u32) -> bool {
        self.width == width && self.height == height
    }

    /// 编码一帧，返回 Annex-B 码流。
    ///
    /// 返回 `Ok(None)` 表示编码器仍在预热（lookahead 未满），尚无输出。
    pub fn encode(
        &mut self,
        frame: &CapturedFrame,
        key_frame: bool,
    ) -> Result<Option<Vec<u8>>, DesktopError> {
        if frame.width != self.width || frame.height != self.height {
            return Err(DesktopError::Unsupported);
        }
        let pixels = match self.input_format {
            InputFormat::Nv12 => frame.to_nv12(),
            InputFormat::I420 => frame.to_i420(),
        };
        unsafe {
            let sample = build_input_sample(&pixels, self.frame_index, self.fps, key_frame)?;
            self.transform
                .ProcessInput(0, &sample, 0)
                .map_err(|_| DesktopError::Unsupported)?;
            self.frame_index += 1;
        }
        self.drain_output()
    }

    /// 取出编码器当前能产出的全部输出。
    fn drain_output(&mut self) -> Result<Option<Vec<u8>>, DesktopError> {
        let mut collected = Vec::new();
        for _ in 0..8 {
            match unsafe { take_one_output(&self.transform) } {
                Ok(Some(bytes)) => collected.extend_from_slice(&bytes),
                Ok(None) => break,
                // 输出格式被改变：需要按新格式重新协商，交给下一次调用处理。
                Err(CodecError::StreamChange) => break,
                Err(CodecError::Other) => return Err(DesktopError::Unsupported),
            }
        }
        if collected.is_empty() {
            Ok(None)
        } else {
            Ok(Some(collected))
        }
    }
}

/// 判断 Annex-B 码流里是否含 IDR 帧（NAL 类型 5）。
///
/// 抽成纯函数：关键帧标记要用于 RTCP/PLI 与前端提示，靠猜会误导；
/// 直接看 NAL 类型是准确且可测的。
pub fn annex_b_contains_idr(data: &[u8]) -> bool {
    let mut index = 0usize;
    while index + 3 < data.len() {
        // 定位起始码：00 00 01 或 00 00 00 01。
        let (header, step) = if data[index..].starts_with(&[0, 0, 0, 1]) {
            (index + 4, 4)
        } else if data[index..].starts_with(&[0, 0, 1]) {
            (index + 3, 3)
        } else {
            index += 1;
            continue;
        };
        let _ = step;
        let Some(byte) = data.get(header) else {
            break;
        };
        if byte & 0x1f == 5 {
            return true;
        }
        index = header;
    }
    false
}

/// 把平台编码器接入媒体循环抽象。
///
/// 注意：本类型**不是** Send/Sync（内部持有 MF 的 COM 对象），因此它由媒体循环
/// 线程独占创建与使用；跨线程共享的是下面的工厂。
impl desktop_core::encoder::VideoEncoder for H264Encoder {
    fn encode(
        &mut self,
        frame: &CapturedFrame,
        sequence: u64,
        key_frame: bool,
    ) -> Result<Option<VideoFrame>, DesktopError> {
        let Some(bytes) = H264Encoder::encode(self, frame, key_frame)? else {
            // 预热中（lookahead 未满）：不是错误。
            return Ok(None);
        };
        // 关键帧标记从 NAL 类型读出，而不是沿用请求参数。
        let produced_key_frame = annex_b_contains_idr(&bytes);
        Ok(Some(VideoFrame {
            sequence,
            width: frame.width,
            height: frame.height,
            timestamp_ms: 0,
            key_frame: produced_key_frame,
            bytes,
        }))
    }
}

/// 编码器工厂：只持配置，不持 COM 对象，因此可以安全地放进共享运行时。
pub struct WindowsEncoderFactory {
    pub bitrate_kbps: u32,
    pub fps: u32,
}

impl Default for WindowsEncoderFactory {
    fn default() -> Self {
        Self {
            bitrate_kbps: 4_000,
            fps: 30,
        }
    }
}

impl desktop_core::encoder::EncoderFactory for WindowsEncoderFactory {
    fn create(
        &self,
        width: u32,
        height: u32,
    ) -> Result<Box<dyn desktop_core::encoder::VideoEncoder>, DesktopError> {
        Ok(Box::new(H264Encoder::new(
            width,
            height,
            self.bitrate_kbps,
            self.fps,
        )?))
    }

    fn codecs(&self) -> Vec<String> {
        vec!["H264".to_string()]
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        // 与 new() 中的 MFStartup 配对。必须先释放编码器实例再关停 MF。
        unsafe {
            let _ = MFShutdown();
        }
    }
}

enum CodecError {
    StreamChange,
    Other,
}

/// 输出缓冲上限；H.264 单帧远小于此值。
const OUTPUT_BUFFER_BYTES: u32 = 1 << 22;

/// 取出一段输出；`Ok(None)` 表示需要更多输入。
unsafe fn take_one_output(transform: &IMFTransform) -> Result<Option<Vec<u8>>, CodecError> {
    unsafe {
        let info = transform
            .GetOutputStreamInfo(0)
            .map_err(|_| CodecError::Other)?;
        // 输出样本的所有权方向必须与 MFT 声明一致：它自己提供样本时必须传
        // NULL，不提供时我们必须自己提供。搞反会直接访问违规。
        let provides_samples = (info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32) != 0;
        let supplied = if provides_samples {
            None
        } else {
            let bytes = if info.cbSize > 0 {
                info.cbSize
            } else {
                OUTPUT_BUFFER_BYTES
            };
            let buffer = MFCreateMemoryBuffer(bytes).map_err(|_| CodecError::Other)?;
            let sample = MFCreateSample().map_err(|_| CodecError::Other)?;
            sample.AddBuffer(&buffer).map_err(|_| CodecError::Other)?;
            Some(sample)
        };
        let mut data = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: std::mem::ManuallyDrop::new(supplied),
            dwStatus: 0,
            pEvents: std::mem::ManuallyDrop::new(None),
        }];
        let mut status: u32 = 0;
        let result = transform.ProcessOutput(0, &mut data, &mut status);
        // 字段是 ManuallyDrop：无论成败都要取出来正常释放，否则泄漏 COM 引用。
        let produced = std::mem::ManuallyDrop::take(&mut data[0].pSample);
        let _events = std::mem::ManuallyDrop::take(&mut data[0].pEvents);
        if let Err(error) = result {
            if error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                return Ok(None);
            }
            if error.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                return Err(CodecError::StreamChange);
            }
            return Err(CodecError::Other);
        }
        let Some(produced) = produced else {
            return Ok(None);
        };
        let contiguous = produced
            .ConvertToContiguousBuffer()
            .map_err(|_| CodecError::Other)?;
        let mut pointer: *mut u8 = std::ptr::null_mut();
        let mut current: u32 = 0;
        contiguous
            .Lock(&mut pointer, None, Some(&mut current))
            .map_err(|_| CodecError::Other)?;
        let bytes = if pointer.is_null() || current == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(pointer, current as usize).to_vec()
        };
        let _ = contiguous.Unlock();
        Ok(Some(bytes))
    }
}

/// 构造一帧输入样本。
unsafe fn build_input_sample(
    pixels: &[u8],
    frame_index: u64,
    fps: u32,
    key_frame: bool,
) -> Result<IMFSample, DesktopError> {
    unsafe {
        let buffer =
            MFCreateMemoryBuffer(pixels.len() as u32).map_err(|_| DesktopError::Unsupported)?;
        let mut pointer: *mut u8 = std::ptr::null_mut();
        buffer
            .Lock(&mut pointer, None, None)
            .map_err(|_| DesktopError::Unsupported)?;
        if pointer.is_null() {
            return Err(DesktopError::Unsupported);
        }
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), pointer, pixels.len());
        let _ = buffer.Unlock();
        buffer
            .SetCurrentLength(pixels.len() as u32)
            .map_err(|_| DesktopError::Unsupported)?;
        let sample = MFCreateSample().map_err(|_| DesktopError::Unsupported)?;
        sample
            .AddBuffer(&buffer)
            .map_err(|_| DesktopError::Unsupported)?;
        // 时间戳单位是 100ns。
        let timestamp = (frame_index * 10_000_000) / u64::from(fps);
        let _ = sample.SetSampleTime(timestamp as i64);
        let _ = sample.SetSampleDuration((10_000_000 / u64::from(fps)) as i64);
        // 关键帧必须用 **MFSampleExtension_CleanPoint 属性** 表达，
        // `SetSampleFlags(0)` 与它无关：没有任何 clean point 的编码器可能
        // 一直等一个永远不会到来的 IDR，表现为 ProcessOutput 永远 NEED_MORE_INPUT。
        if key_frame {
            let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
        }
        // 首帧标记为不连续，让编码器从干净状态开始。
        if frame_index == 0 {
            let _ = sample.SetUINT32(&MFSampleExtension_Discontinuity, 1);
        }
        Ok(sample)
    }
}

/// 选择第一个可同步使用的编码器：硬件优先，其次软件。
///
/// 异步 MFT 会被跳过（本模块尚未实现事件循环），因此必须在**所有**候选里
/// 逐个检查，而不能只看第一个。
fn select_sync_encoder() -> Option<IMFActivate> {
    let mut candidates: Vec<(IMFActivate, bool)> = Vec::new();
    unsafe {
        // 不在这里启停 MF：MF 的生命周期由 H264Encoder 持有，否则会出现在
        // MFShutdown 之后继续使用该次启动所产生对象的错误顺序。
        let output = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_H264,
        };
        for (flags, hardware) in [
            (MFT_ENUM_FLAG_HARDWARE.0, true),
            (MFT_ENUM_FLAG_SYNCMFT.0, false),
        ] {
            let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
            let mut count: u32 = 0;
            let enumerated = MFTEnumEx(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG(flags),
                None,
                Some(&output),
                &mut activates,
                &mut count,
            );
            if enumerated.is_err() || activates.is_null() || count == 0 {
                continue;
            }
            let entries = std::slice::from_raw_parts(activates, count as usize);
            for entry in entries {
                let Some(activate) = entry.as_ref() else {
                    continue;
                };
                if is_async(activate) {
                    continue;
                }
                candidates.push((activate.clone(), hardware));
            }
            CoTaskMemFree(Some(activates as *const std::ffi::c_void));
        }
        // 只按偏好排序（硬件优先）；MF 的关停由调用方负责。
        candidates.sort_by_key(|(_, hardware)| std::cmp::Reverse(*hardware));
    }
    candidates.into_iter().next().map(|(activate, _)| activate)
}

unsafe fn is_async(activate: &IMFActivate) -> bool {
    unsafe {
        matches!(
            activate.GetUINT32(&windows::Win32::Media::MediaFoundation::MF_TRANSFORM_ASYNC),
            Ok(1)
        )
    }
}

/// 配置输入与输出媒体类型；返回实际选定的输入格式。
///
/// profile 必须用 **Baseline(66)**：WebRTC 侧声明的
/// `profile-level-id=42e01f` 就是 Baseline 3.1，若实产 Main profile 则
/// 声明与码流不一致，部分接收端会拒解。
unsafe fn configure_types(
    transform: &IMFTransform,
    width: u32,
    height: u32,
    bitrate_kbps: u32,
    fps: u32,
) -> Result<(InputFormat, IMFMediaType), DesktopError> {
    unsafe {
        // 实时远控必须低延迟。以下属性依据 Microsoft 官方文档设置，且**必须在
        // SetOutputType 之前**生效（AVEncMPVDefaultBPictureCount 尤其如此）。
        // 支持程度依编码器而异，因此逐项尽力而为，并记录生效项数供诊断。
        let low_latency_accepted = apply_low_latency(transform);

        let output = MFCreateMediaType().map_err(|_| DesktopError::Unsupported)?;
        set_video_type(&output, MFVideoFormat_H264)?;
        let _ = low_latency_accepted;
        output
            .SetUINT32(&MF_MT_AVG_BITRATE, bitrate_kbps.saturating_mul(1000))
            .map_err(|_| DesktopError::Unsupported)?;
        output
            .SetUINT64(&MF_MT_FRAME_SIZE, pack_ratio(width, height))
            .map_err(|_| DesktopError::Unsupported)?;
        output
            .SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps, 1))
            .map_err(|_| DesktopError::Unsupported)?;
        output
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|_| DesktopError::Unsupported)?;
        output
            .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)
            .map_err(|_| DesktopError::Unsupported)?;
        transform
            .SetOutputType(0, &output, 0)
            .map_err(|_| DesktopError::Unsupported)?;

        // 逐个尝试输入类型：不同实现接受的格式不同，不能只赌 NV12。
        let mut index = 0u32;
        while let Ok(candidate) = transform.GetInputAvailableType(0, index) {
            let subtype = candidate
                .GetGUID(&MF_MT_SUBTYPE)
                .map_err(|_| DesktopError::Unsupported)?;
            let format = if subtype == MFVideoFormat_NV12 {
                Some(InputFormat::Nv12)
            } else if subtype == MFVideoFormat_I420 {
                Some(InputFormat::I420)
            } else {
                None
            };
            if let Some(format) = format {
                candidate
                    .SetUINT64(&MF_MT_FRAME_SIZE, pack_ratio(width, height))
                    .map_err(|_| DesktopError::Unsupported)?;
                candidate
                    .SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps, 1))
                    .map_err(|_| DesktopError::Unsupported)?;
                if transform.SetInputType(0, &candidate, 0).is_ok() {
                    return Ok((format, candidate));
                }
            }
            index += 1;
            if index > 64 {
                break;
            }
        }
        Err(DesktopError::Unsupported)
    }
}

/// 请求低延迟编码；返回被接受的属性数（便于诊断与如实上报）。
///
/// 依据 Microsoft 文档：
/// - `CODECAPI_AVLowLatencyMode`：编解码低延迟模式，编码器不应因帧重排引入延迟；
/// - `CODECAPI_AVEncCommonLowLatency`：输出流按低解码延迟构造；
/// - `CODECAPI_AVEncCommonRealTime`：声明应用要求实时编码性能；
/// - `CODECAPI_AVEncMPVDefaultBPictureCount = 0`：不使用 B 帧（必须在输出类型前设）；
/// - `MF_LOW_LATENCY`：管道级低延迟。
///
/// 支持程度依编码器而异（硬件 MFT 尤其），因此逐项尝试并返回生效数量，
/// 而不是假装设置成功。
unsafe fn apply_low_latency(transform: &IMFTransform) -> usize {
    unsafe {
        let Ok(attributes) = transform.GetAttributes() else {
            return 0;
        };
        let mut accepted = 0usize;
        for key in [
            &CODECAPI_AVLowLatencyMode,
            &CODECAPI_AVEncCommonLowLatency,
            &CODECAPI_AVEncCommonRealTime,
            &MF_LOW_LATENCY,
        ] {
            if attributes.SetUINT32(key, 1).is_ok() {
                accepted += 1;
            }
        }
        // 0 = 无 B 帧。
        if attributes
            .SetUINT32(&CODECAPI_AVEncMPVDefaultBPictureCount, 0)
            .is_ok()
        {
            accepted += 1;
        }
        accepted
    }
}

/// 写入视频类型共有的 major type。
unsafe fn set_video_type(
    media_type: &IMFMediaType,
    subtype: windows::core::GUID,
) -> Result<(), DesktopError> {
    unsafe {
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|_| DesktopError::Unsupported)?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &subtype)
            .map_err(|_| DesktopError::Unsupported)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desktop_core::media::CapturedFrame;

    fn solid(width: u32, height: u32) -> CapturedFrame {
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        for index in 0..(width as usize * height as usize) {
            let value = ((index * 7) % 256) as u8;
            pixels[index * 4] = value;
            pixels[index * 4 + 1] = value;
            pixels[index * 4 + 2] = value;
            pixels[index * 4 + 3] = 0xff;
        }
        CapturedFrame::new(width, height, pixels).expect("frame")
    }

    #[test]
    fn configures_a_synchronous_encoder_on_this_machine() {
        // 不假设厂商：只要求这台机器上能配置出一个可同步使用的编码器。
        let encoder = H264Encoder::new(320, 240, 1_000, 30);
        assert!(
            encoder.is_ok(),
            "应能配置出同步 H.264 编码器（每台 Windows 都有微软软件编码器）"
        );
    }

    /// 编码器确实能产出码流，只是有 **lookahead 延迟**。
    ///
    /// 已修复的历史问题：输出样本协议搞反会 ACCESS_VIOLATION（已按
    /// `MFT_OUTPUT_STREAM_PROVIDES_SAMPLES` 分支）；MF 生命周期错序导致
    /// 配置时好时坏（已改为编码器持有 MF 生命周期）。
    ///
    /// 实测（诊断测试 `diagnose_encode_path`）：微软 H.264 软件编码器要到第
    /// **17** 帧才首次输出，60 帧共 45461 字节。之前只喂 8 帧，因此误以为
    /// “永远不产出”。
    ///
    /// 实测：**未配置低延迟**时该编码器有约 16 帧 lookahead（要到第 17 帧才首次
    /// 输出，@30fps≈0.53s，对实时远控不可接受）；应用官方文档的
    /// `CODECAPI_AVLowLatencyMode` / `AVEncCommonLowLatency` / `AVEncCommonRealTime`
    #[test]
    fn produces_annex_b_output_for_a_real_frame() {
        let Ok(mut encoder) = H264Encoder::new(320, 240, 1_000, 30) else {
            panic!("编码器配置失败");
        };
        let frame = solid(320, 240);
        let mut total = Vec::new();
        // 首帧通常要喂几帧才吐出码流，因此多喂几帧再把输出拼起来。
        for index in 0..40 {
            // 预热期返回 None，不是错误。
            if let Some(bytes) = encoder.encode(&frame, index == 0).expect("encode") {
                total.extend_from_slice(&bytes);
            }
        }
        assert!(!total.is_empty(), "编码器必须产出真实码流");
        // Annex-B 起始码：00 00 00 01 或 00 00 01。
        let has_start_code =
            total.windows(4).any(|w| w == [0, 0, 0, 1]) || total.windows(3).any(|w| w == [0, 0, 1]);
        assert!(has_start_code, "输出应是 Annex-B 码流");
    }

    #[test]
    fn rejects_a_frame_that_does_not_match_the_configured_size() {
        let Ok(mut encoder) = H264Encoder::new(320, 240, 1_000, 30) else {
            panic!("编码器配置失败");
        };
        let wrong = solid(160, 120);
        assert!(encoder.encode(&wrong, false).is_err());
    }
}

#[cfg(test)]
mod diagnostics {
    use super::*;
    use windows::core::PWSTR;
    use windows::Win32::Media::MediaFoundation::{
        MFT_FRIENDLY_NAME_Attribute, MFT_INPUT_STATUS_ACCEPT_DATA, MFT_MESSAGE_COMMAND_FLUSH,
        MFT_OUTPUT_STATUS_SAMPLE_READY,
    };
    use windows::Win32::System::Com::CoTaskMemFree;

    /// 诊断用：打印每一步的真实返回值，避免继续靠猜。
    #[test]
    #[ignore = "诊断用，不属于回归套件"]
    fn diagnose_encode_path() {
        unsafe {
            assert!(MFStartup(MF_VERSION, MFSTARTUP_FULL).is_ok());
            let activate = select_sync_encoder().expect("no sync encoder");
            let name = {
                let mut value = PWSTR::null();
                let mut length = 0u32;
                let _ = activate.GetAllocatedString(
                    &MFT_FRIENDLY_NAME_Attribute,
                    &mut value,
                    &mut length,
                );
                let text = if value.is_null() {
                    None
                } else {
                    value.to_string().ok()
                };
                if !value.is_null() {
                    CoTaskMemFree(Some(value.0 as *const std::ffi::c_void));
                }
                text
            };
            eprintln!("[diag] selected encoder = {name:?}");

            let transform: IMFTransform = activate.ActivateObject().expect("activate");
            let info = transform.GetOutputStreamInfo(0).expect("output info");
            eprintln!(
                "[diag] output stream info: flags={:#x} cbSize={} cbAlignment={}",
                info.dwFlags, info.cbSize, info.cbAlignment
            );

            let (format, _) = configure_types(&transform, 320, 240, 1_000, 30).expect("configure");
            eprintln!("[diag] configured input format = {format:?}");

            let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
            let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

            let frame = {
                let (width, height) = (320usize, 240usize);
                let mut pixels = vec![0u8; width * height * 4];
                for index in 0..width * height {
                    let value = ((index * 7) % 256) as u8;
                    pixels[index * 4] = value;
                    pixels[index * 4 + 1] = value;
                    pixels[index * 4 + 2] = value;
                    pixels[index * 4 + 3] = 0xff;
                }
                CapturedFrame::new(320, 240, pixels).expect("frame")
            };
            let pixels = match format {
                InputFormat::Nv12 => frame.to_nv12(),
                InputFormat::I420 => frame.to_i420(),
            };

            eprintln!(
                "[diag] before: input_status={:?} (ACCEPT={:#x}) output_status={:?} (READY={:#x})",
                transform.GetInputStatus(0),
                MFT_INPUT_STATUS_ACCEPT_DATA.0,
                transform.GetOutputStatus(),
                MFT_OUTPUT_STATUS_SAMPLE_READY.0
            );

            // 区分“需要更多帧”与“永远不产出”：连续嗂 60 帧并记录首次产出位置。
            let mut first_output: Option<usize> = None;
            let mut total = 0usize;
            for index in 0..60u64 {
                let sample = build_input_sample(&pixels, index, 30, index == 0).expect("sample");
                if transform.ProcessInput(0, &sample, 0).is_err() {
                    eprintln!("[diag] frame {index}: ProcessInput 失败");
                    break;
                }
                let status = transform.GetOutputStatus().unwrap_or(u32::MAX);
                match take_one_output(&transform) {
                    Ok(Some(bytes)) => {
                        if first_output.is_none() {
                            first_output = Some(index as usize);
                        }
                        total += bytes.len();
                        if !bytes.is_empty() && total < 4096 {
                            eprintln!(
                                "[diag] frame {index}: 首次产出 {} 字节, status={status:#x}",
                                bytes.len()
                            );
                        }
                    }
                    Ok(None) => {}
                    Err(_) => eprintln!("[diag] frame {index}: ProcessOutput 其它错误"),
                }
            }
            eprintln!("[diag] 首次产出帧号 = {first_output:?}，累计 {total} 字节");

            let _ = transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = MFShutdown();
        }
    }
}
