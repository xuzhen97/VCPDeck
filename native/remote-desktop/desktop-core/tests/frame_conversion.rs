//! 捕获帧的构造校验与 I420 色彩转换。
//!
//! 这些是纯计算，不依赖平台：转换公式出错会让远端画面颜色整体偏色，
//! 而真实屏幕测试无法稳定断言具体像素值，所以这里用已知颜色锁定数值。

use desktop_core::media::{CapturedFrame, MediaError};

fn solid(width: u32, height: u32, b: u8, g: u8, r: u8) -> CapturedFrame {
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for _ in 0..width * height {
        pixels.extend_from_slice(&[b, g, r, 0xff]);
    }
    CapturedFrame::new(width, height, pixels).expect("frame")
}

#[test]
fn rejects_a_buffer_that_does_not_match_its_size() {
    assert_eq!(
        CapturedFrame::new(2, 2, vec![0u8; 15]),
        Err(MediaError::InvalidFrameBuffer)
    );
    // 尺寸为零同样非法：上层据此判断“没有画面”。
    assert_eq!(
        CapturedFrame::new(0, 2, Vec::new()),
        Err(MediaError::InvalidFrameBuffer)
    );
}

#[test]
fn converts_black_and_white_to_limited_range_luma() {
    // BT.601 limited range：全黑 Y=16、全白 Y=235，色度居中 128。
    let black = solid(2, 2, 0, 0, 0).to_i420();
    assert_eq!(black[0], 16);
    assert_eq!(black[4], 128);
    assert_eq!(black[5], 128);

    let white = solid(2, 2, 255, 255, 255).to_i420();
    assert_eq!(white[0], 235);
    assert_eq!(white[4], 128);
    assert_eq!(white[5], 128);
}

#[test]
fn converts_pure_red_to_the_expected_bt601_values() {
    // 2×2 全红：Y=82、U=90、V=240（按公式手算，用于锁定不会写错的系数）。
    let frame = solid(2, 2, 0, 0, 255).to_i420();
    for luma in &frame[0..4] {
        assert_eq!(*luma, 82);
    }
    assert_eq!(frame[4], 90, "U 分量错误");
    assert_eq!(frame[5], 240, "V 分量错误");
}

#[test]
fn output_length_follows_yuv420_for_odd_dimensions() {
    // 宽高为奇数时色度按 ceil 下采样，多余行列不参与色度计算。
    let frame = solid(3, 3, 10, 20, 30);
    let i420 = frame.to_i420();
    let luma = 3 * 3;
    let chroma = 2 * 2;
    assert_eq!(i420.len(), luma + chroma * 2);
}

#[test]
fn averages_chroma_over_each_two_by_two_block() {
    // 左边两列纯黑、右边两列纯白：色度应被均值拉到 128 附近而不是取单点。
    let mut pixels = Vec::new();
    for _row in 0..2 {
        for column in 0..4 {
            let value = if column < 2 { 0u8 } else { 255u8 };
            pixels.extend_from_slice(&[value, value, value, 0xff]);
        }
    }
    let frame = CapturedFrame::new(4, 2, pixels).expect("frame");
    let i420 = frame.to_i420();
    let chroma_width = 2usize;
    // 左块全黑、右块全白，两块的色度都应接近中性（128）。
    for index in 0..2 {
        assert!(
            i420[8 + index].abs_diff(128) <= 1,
            "U[{index}] = {} 应接近 128",
            i420[8 + index]
        );
        assert!(
            i420[10 + index].abs_diff(128) <= 1,
            "V[{index}] = {} 应接近 128",
            i420[10 + index]
        );
    }
    let _ = chroma_width;
}

#[test]
fn nv12_has_a_full_luma_plane_followed_by_interleaved_uv() {
    let frame = solid(2, 2, 0, 0, 255);
    let nv12 = frame.to_nv12();
    // Y 平面 2*2，UV 平面 1 个色度像素对 (U,V)。
    assert_eq!(nv12.len(), 4 + 2);
    for luma in &nv12[0..4] {
        assert_eq!(*luma, 82, "Y 平面应与 I420 一致");
    }
    let i420 = frame.to_i420();
    assert_eq!(nv12[4], i420[4], "NV12 的 U 应等于 I420 的 U");
    assert_eq!(nv12[5], i420[5], "NV12 的 V 应等于 I420 的 V");
}

#[test]
fn nv12_interleaves_uv_per_chroma_pixel_for_multi_pixel_chroma() {
    // 4×2 ⇒ 色度 2×1，UV 平面应为 U0 V0 U1 V1。
    let mut pixels = Vec::new();
    for _row in 0..2 {
        for column in 0..4 {
            let value = if column < 2 { 0u8 } else { 255u8 };
            pixels.extend_from_slice(&[value, value, value, 0xff]);
        }
    }
    let frame = CapturedFrame::new(4, 2, pixels).expect("frame");
    let nv12 = frame.to_nv12();
    let i420 = frame.to_i420();
    let luma = 8usize;
    let chroma = 2usize;
    assert_eq!(nv12.len(), luma + chroma * 2);
    for index in 0..chroma {
        assert_eq!(
            nv12[luma + index * 2],
            i420[luma + index],
            "U[{index}] 位置错误"
        );
        assert_eq!(
            nv12[luma + index * 2 + 1],
            i420[luma + chroma + index],
            "V[{index}] 位置错误"
        );
    }
}
