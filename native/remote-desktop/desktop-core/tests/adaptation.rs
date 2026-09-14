use desktop_core::{PointerCoalescer, QualityProfile, VideoFrame};

#[test]
fn quality_profiles_are_bounded() {
    let low = QualityProfile::LowBandwidth.limits();
    let balanced = QualityProfile::Balanced.limits();
    let high = QualityProfile::HighQuality.limits();
    assert_eq!(
        (low.max_width, low.max_height, low.max_fps),
        (1920, 1080, 15)
    );
    assert_eq!(
        (balanced.max_width, balanced.max_height, balanced.max_fps),
        (2560, 1440, 30)
    );
    assert_eq!(
        (high.max_width, high.max_height, high.max_fps),
        (3840, 2160, 60)
    );
}

#[test]
fn oversized_frame_is_not_accepted_by_profile() {
    let frame = VideoFrame {
        sequence: 1,
        width: 3840,
        height: 2160,
        timestamp_ms: 0,
        key_frame: true,
        bytes: vec![],
    };
    assert!(!frame.within(QualityProfile::Balanced.limits()));
}

#[test]
fn pointer_coalescer_keeps_only_latest_sample() {
    let mut coalescer = PointerCoalescer::default();
    for value in 0..10_000 {
        coalescer.push(desktop_core::media::PointerSample {
            x: value.min(u16::MAX as usize) as u16,
            y: value.min(u16::MAX as usize) as u16,
        });
    }
    assert_eq!(coalescer.received(), 10_000);
    assert_eq!(coalescer.take_latest().unwrap().x, 9_999);
    assert!(coalescer.take_latest().is_none());
}
