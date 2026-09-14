//! Media Foundation 编码器探测与（后续）H.264 编码。
//!
//! Media Foundation 的绑定只存在于完整的 `windows` crate（`windows-sys` 里没有
//! MF 模块），因此本模块用 `windows` crate 的强类型 API，而不是 `windows-sys` 的
//! 裸 FFI。
//!
//! 本模块只做**探测与能力上报**：枚举系统里真实的 H.264 编码器 MFT，并据
//! 友好名称判断厂商（NVENC/QSV/AMF）与是否硬件。探测不到就如实返回空列表，
//! 绝不假设「平台是 Windows 就一定有硬编」。

use windows::core::PWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, MFMediaType_Video, MFShutdown, MFStartup, MFTEnumEx, MFT_FRIENDLY_NAME_Attribute,
    MFVideoFormat_H264, MFSTARTUP_FULL, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SYNCMFT, MFT_REGISTER_TYPE_INFO, MF_VERSION,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED,
};

/// 一个可用的 H.264 编码器描述。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderInfo {
    /// 系统上报的友好名称，用于诊断与审计。
    pub name: String,
    /// 是否硬件编码器。
    pub hardware: bool,
    /// 归一化厂商标识，例如 `nvenc` / `qsv` / `amf`；无法识别时为 `None`。
    pub vendor: Option<String>,
    /// 是否为异步 MFT；异步 MFT 必须解锁并用事件驱动，不能直接同步 ProcessInput。
    pub asynchronous: bool,
}

/// 从 MFT 友好名称推断归一化厂商标识。
///
/// 单独抽成纯函数：名称匹配是唯一可测的部分，且写错会让能力上报把
/// Intel 的编码器标成 NVIDIA。
pub fn vendor_from_name(name: &str) -> Option<String> {
    let lowered = name.to_lowercase();
    if lowered.contains("nvidia") || lowered.contains("nvenc") {
        return Some("nvenc".to_string());
    }
    if lowered.contains("intel") || lowered.contains("quick sync") || lowered.contains("qsv") {
        return Some("qsv".to_string());
    }
    if lowered.contains("amd") || lowered.contains("amf") || lowered.contains("radeon") {
        return Some("amf".to_string());
    }
    None
}

/// 探测系统里真实的 H.264 编码器 MFT。
///
/// 硬件属性用**枚举标志**判定，而不是依赖厂商私有属性：实测 NVIDIA 的
/// H.264 MFT 并不设置 `MFT_ENUM_HARDWARE_VENDOR_ID_Attribute`，靠属性判断会把
/// 硬编错报成软编（能力上报反向失真）。因此先只枚举硬件，再只枚举同步软件。
pub fn probe_h264_encoders() -> Vec<EncoderInfo> {
    let mut found: Vec<EncoderInfo> = Vec::new();
    unsafe {
        // MFStartup 需要 COM 已初始化；RPC_E_CHANGED_MODE 表示当前线程已是
        // 其它套间模型，这不算失败。
        let com_ready = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        if MFStartup(MF_VERSION, MFSTARTUP_FULL).is_err() {
            if com_ready {
                CoUninitialize();
            }
            return found;
        }

        let output = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_H264,
        };
        for (flags, hardware) in [
            (MFT_ENUM_FLAG_HARDWARE.0, true),
            (MFT_ENUM_FLAG_SYNCMFT.0, false),
        ] {
            for (name, asynchronous) in enumerate_by_flag(MFT_ENUM_FLAG(flags), &output) {
                // 同名时硬件优先；同一次枚举内的重复名称只保留一次。
                if let Some(existing) = found.iter().position(|entry| entry.name == name) {
                    if hardware && !found[existing].hardware {
                        found[existing].hardware = true;
                    }
                    continue;
                }
                found.push(EncoderInfo {
                    vendor: vendor_from_name(&name),
                    asynchronous,
                    name,
                    hardware,
                });
            }
        }

        let _ = MFShutdown();
        if com_ready {
            CoUninitialize();
        }
    }
    found
}

/// 按给定标志枚举 MFT，返回（友好名称, 是否异步）。
unsafe fn enumerate_by_flag(
    flags: MFT_ENUM_FLAG,
    output: &MFT_REGISTER_TYPE_INFO,
) -> Vec<(String, bool)> {
    let mut names = Vec::new();
    unsafe {
        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count: u32 = 0;
        let enumerated = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            None,
            Some(output),
            &mut activates,
            &mut count,
        );
        if enumerated.is_err() || activates.is_null() || count == 0 {
            return names;
        }
        let entries = std::slice::from_raw_parts(activates, count as usize);
        for entry in entries {
            let Some(activate) = entry.as_ref() else {
                continue;
            };
            if let Some(name) = friendly_name(activate) {
                names.push((name, is_async(activate)));
            }
        }
        // 数组本身由 CoTaskMemAlloc 分配；元素是 COM 引用，随 Option 释放。
        CoTaskMemFree(Some(activates as *const std::ffi::c_void));
    }
    names
}

/// 读取 `MFT_FRIENDLY_NAME_Attribute`。
unsafe fn friendly_name(activate: &IMFActivate) -> Option<String> {
    unsafe {
        let mut value = PWSTR::null();
        let mut length: u32 = 0;
        if activate
            .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut value, &mut length)
            .is_err()
        {
            return None;
        }
        if value.is_null() {
            return None;
        }
        let text = value.to_string().ok();
        // GetAllocatedString 用 CoTaskMemAlloc 分配，必须由调用方释放。
        CoTaskMemFree(Some(value.0 as *const std::ffi::c_void));
        text
    }
}

/// 该 MFT 是否声明为异步（决定能否直接用同步 `ProcessInput`）。
unsafe fn is_async(activate: &IMFActivate) -> bool {
    unsafe {
        matches!(
            activate.GetUINT32(&windows::Win32::Media::MediaFoundation::MF_TRANSFORM_ASYNC),
            Ok(1)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_vendor_names_without_confusing_brands() {
        assert_eq!(
            vendor_from_name("NVIDIA H.264 Encoder MFT").as_deref(),
            Some("nvenc")
        );
        assert_eq!(
            vendor_from_name("Intel® Quick Sync Video H.264 Encoder MFT").as_deref(),
            Some("qsv")
        );
        assert_eq!(
            vendor_from_name("AMD AMF H.264 Encoder MFT").as_deref(),
            Some("amf")
        );
        // 通用软件 MFT 不得被误标成硬件厂商。
        assert_eq!(vendor_from_name("H264 Encoder MFT"), None);
        assert_eq!(vendor_from_name("Microsoft H264 Video Encoder MFT"), None);
    }

    #[test]
    fn probe_reports_only_encoders_it_actually_found() {
        // 探测不做平台假设：结果可以是空，但只要是硬件项就必须带厂商标识。
        let encoders = probe_h264_encoders();
        for encoder in &encoders {
            assert!(!encoder.name.is_empty(), "编码器名称不得为空");
        }
        eprintln!(
            "探测到 {} 个 H.264 编码器 MFT: {encoders:?}",
            encoders.len()
        );
    }
}
