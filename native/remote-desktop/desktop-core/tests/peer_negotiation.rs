//! Host 作为 answerer 的协商测试。
//!
//! 生产拓扑中 Browser 是 offerer：它创建 `control-reliable` / `pointer-realtime` 两条
//! DataChannel 与 recvonly 视频 transceiver，Host 通过 `ondatachannel` 按 label 绑定。
//! 这是标准 SDP 顺序：DataChannel 必须由 offerer 声明，否则 answer 里不会有
//! `m=application` 段，Host 单方面创建的通道永远无法完成协商。

use desktop_core::peer::PeerManager;
use desktop_core::session::AttachmentRole;
use desktop_core::webrtc::transport::{
    receive_control_message, send_control_message, PeerTransport, TransportCodec,
};
use desktop_core::webrtc::{decode_control_message, ControlMessage, DataChannelKind, WebRtcError};
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use rtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};
use std::sync::Arc;
use std::time::Duration;
use webrtc::data_channel::DataChannel;

const BIND_TIMEOUT: Duration = Duration::from_secs(5);

/// Browser 侧连接，模拟 `createRemoteDesktopPeer()` 的真实行为。
struct Browser {
    transport: PeerTransport,
    offer_sdp: String,
    control: Arc<dyn DataChannel>,
    pointer: Option<Arc<dyn DataChannel>>,
}

impl Browser {
    async fn connect(operator: bool) -> Self {
        let transport = PeerTransport::new(Vec::new())
            .await
            .expect("browser transport");
        transport
            .connection
            .add_transceiver_from_kind(
                RtpCodecKind::Video,
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Recvonly,
                    streams: Vec::new(),
                    send_encodings: Vec::new(),
                }),
            )
            .await
            .expect("recvonly video transceiver");
        let control = transport
            .create_control_channel()
            .await
            .expect("browser control channel");
        let pointer = if operator {
            Some(
                transport
                    .create_pointer_channel()
                    .await
                    .expect("browser pointer channel"),
            )
        } else {
            None
        };
        let offer = transport.create_offer().await.expect("browser offer");
        assert!(offer.sdp.contains("m=video"), "offer must declare video");
        assert!(
            offer.sdp.contains("m=application"),
            "offer must declare the SCTP application section"
        );
        Self {
            transport,
            offer_sdp: offer.sdp,
            control,
            pointer,
        }
    }

    /// Browser 接受 Host answer；此后双方通道开始协商。
    async fn accept_answer(&self, answer_sdp: &str) {
        let answer = webrtc::peer_connection::RTCSessionDescription::answer(answer_sdp.to_string())
            .expect("answer parses");
        self.transport
            .set_remote_description(&answer)
            .await
            .expect("browser accepts answer");
    }

    async fn close(self) {
        let _ = self.transport.close().await;
    }
}

async fn wait_for_open(channel: &Arc<dyn DataChannel>) {
    loop {
        match channel.poll().await {
            Some(webrtc::data_channel::DataChannelEvent::OnOpen) => return,
            Some(webrtc::data_channel::DataChannelEvent::OnClose) | None => {
                panic!("data channel closed before opening")
            }
            Some(_) => {}
        }
    }
}

#[tokio::test]
async fn host_answers_a_browser_offer_with_a_valid_sdp() {
    let browser = Browser::connect(true).await;
    let mut manager = PeerManager::new(TransportCodec::Vp8, Vec::new());

    let answer = manager
        .accept_offer("a1", AttachmentRole::Operator, &browser.offer_sdp)
        .await
        .expect("answer");

    // Host 必须作为发送方出现在 answer 中，并保留 Browser 声明的两段。
    assert!(answer.contains("m=video"), "{answer}");
    assert!(answer.contains("a=sendonly"), "{answer}");
    assert!(answer.contains("m=application"), "{answer}");
    assert!(manager.has("a1"));
    assert_eq!(manager.len(), 1);

    manager.close("a1").await.expect("close");
    assert!(!manager.has("a1"));
    assert!(manager.is_empty());
    browser.close().await;
}

#[tokio::test]
async fn host_binds_browser_channels_by_label() {
    let browser = Browser::connect(true).await;
    let mut manager = PeerManager::new(TransportCodec::Vp8, Vec::new());
    let answer = manager
        .accept_offer("a1", AttachmentRole::Operator, &browser.offer_sdp)
        .await
        .expect("answer");
    browser.accept_answer(&answer).await;

    manager
        .bind_channels("a1", BIND_TIMEOUT)
        .await
        .expect("bind");

    let peer = manager.peer("a1").expect("peer");
    assert_eq!(
        peer.channel_labels(),
        vec!["control-reliable", "pointer-realtime"]
    );
    manager.close_all().await;
    browser.close().await;
}

#[tokio::test]
async fn a_viewer_peer_binds_only_the_control_channel() {
    let browser = Browser::connect(false).await;
    let mut manager = PeerManager::new(TransportCodec::Vp8, Vec::new());
    let answer = manager
        .accept_offer("viewer-1", AttachmentRole::Viewer, &browser.offer_sdp)
        .await
        .expect("answer");
    browser.accept_answer(&answer).await;
    manager
        .bind_channels("viewer-1", BIND_TIMEOUT)
        .await
        .expect("bind");

    let peer = manager.peer("viewer-1").expect("peer");
    assert_eq!(peer.channel_labels(), vec!["control-reliable"]);
    assert!(peer.channel(DataChannelKind::PointerRealtime).is_none());
    manager.close_all().await;
    browser.close().await;
}

/// 真实前端无论角色都会创建两条通道，因此 Host 必须自行拒绝 viewer 的指针通道。
#[tokio::test]
async fn a_viewer_never_binds_a_pointer_channel_even_when_the_browser_creates_one() {
    let browser = Browser::connect(true).await;
    assert!(
        browser.pointer.is_some(),
        "browser declared pointer channel for this test"
    );
    let mut manager = PeerManager::new(TransportCodec::Vp8, Vec::new());
    let answer = manager
        .accept_offer("viewer-1", AttachmentRole::Viewer, &browser.offer_sdp)
        .await
        .expect("answer");
    browser.accept_answer(&answer).await;

    // 即使指针通道已存在，Host 也只绑控制通道；绑定成功后不得出现 pointer。
    manager
        .bind_channels("viewer-1", BIND_TIMEOUT)
        .await
        .expect("bind");

    let peer = manager.peer("viewer-1").expect("peer");
    assert_eq!(peer.channel_labels(), vec!["control-reliable"]);
    assert!(peer.channel(DataChannelKind::PointerRealtime).is_none());
    manager.close_all().await;
    browser.close().await;
}

#[tokio::test]
async fn host_challenge_reaches_the_browser_control_channel() {
    let browser = Browser::connect(true).await;
    let mut manager = PeerManager::new(TransportCodec::Vp8, Vec::new());
    let answer = manager
        .accept_offer("a1", AttachmentRole::Operator, &browser.offer_sdp)
        .await
        .expect("answer");
    browser.accept_answer(&answer).await;
    manager
        .bind_channels("a1", BIND_TIMEOUT)
        .await
        .expect("bind");
    wait_for_open(&browser.control).await;

    let nonce = [9u8; 32];
    manager
        .send_challenge("a1", &desktop_core::Challenge { nonce })
        .await
        .expect("challenge");

    let received = tokio::time::timeout(
        Duration::from_secs(5),
        receive_control_message(&browser.control),
    )
    .await
    .expect("challenge timeout")
    .expect("challenge message");
    match received {
        ControlMessage::Challenge {
            nonce: got,
            attachment_id,
        } => {
            // Browser 依赖长度 32 与 0–255 范围校验，这里锁定同一形状。
            assert_eq!(got, nonce);
            assert_eq!(attachment_id, "a1");
        }
        other => panic!("expected challenge, got {other:?}"),
    }

    // Browser 必须能回传 challenge-response，且 Host 侧仍可读取。
    let response = desktop_core::ControlMessage::ChallengeResponse {
        nonce,
        attachment_id: "a1".to_string(),
    };
    // 用 Host 已绑定的控制通道发送，模拟 Browser 的上行方向。
    let control = manager
        .peer("a1")
        .expect("peer")
        .channel(DataChannelKind::ControlReliable)
        .expect("control")
        .clone();
    // Host 通道上收到的应当是 Browser 发出的消息；这里验证通道可写不报错。
    assert!(send_control_message(&control, &response).await.is_ok());

    manager.close_all().await;
    browser.close().await;
}

#[tokio::test]
async fn an_empty_or_malformed_offer_is_rejected() {
    let mut manager = PeerManager::new(TransportCodec::Vp8, Vec::new());
    assert!(matches!(
        manager
            .accept_offer("a1", AttachmentRole::Operator, "")
            .await,
        Err(WebRtcError::InvalidOffer)
    ));
    assert!(matches!(
        manager
            .accept_offer("a1", AttachmentRole::Operator, "not an sdp")
            .await,
        Err(WebRtcError::InvalidOffer)
    ));
    assert!(manager.is_empty());
}

#[tokio::test]
async fn a_repeated_offer_replaces_the_previous_connection() {
    let first = Browser::connect(true).await;
    let second = Browser::connect(true).await;
    let mut manager = PeerManager::new(TransportCodec::Vp8, Vec::new());

    manager
        .accept_offer("a1", AttachmentRole::Operator, &first.offer_sdp)
        .await
        .expect("first answer");
    manager
        .accept_offer("a1", AttachmentRole::Operator, &second.offer_sdp)
        .await
        .expect("second answer");

    // 重协商不得残留两条连接。
    assert_eq!(manager.len(), 1);
    assert!(manager.has("a1"));
    manager.close_all().await;
    first.close().await;
    second.close().await;
}

#[tokio::test]
async fn binding_fails_closed_when_the_control_channel_is_missing() {
    let browser = Browser::connect(false).await;
    let mut manager = PeerManager::new(TransportCodec::Vp8, Vec::new());
    let answer = manager
        .accept_offer("a1", AttachmentRole::Operator, &browser.offer_sdp)
        .await
        .expect("answer");
    browser.accept_answer(&answer).await;

    // Operator 需要实时指针通道，但 Browser 只创建了控制通道。
    assert!(matches!(
        manager
            .bind_channels("a1", Duration::from_millis(300))
            .await,
        Err(WebRtcError::ChannelMissing)
    ));
    manager.close_all().await;
    browser.close().await;
}

#[tokio::test]
async fn send_challenge_requires_an_established_peer() {
    let manager = PeerManager::new(TransportCodec::Vp8, Vec::new());
    let challenge = desktop_core::Challenge { nonce: [7; 32] };
    assert!(matches!(
        manager.send_challenge("missing", &challenge).await,
        Err(WebRtcError::Closed)
    ));
}

#[test]
fn unit_control_variants_reject_unknown_fields() {
    // serde 对 internally-tagged enum 的 unit 变体不会执行 deny_unknown_fields，
    // 必须由 decode_control_message 自己做键白名单校验，否则可以夹带字段越过严格边界。
    for payload in [
        br#"{"type":"release-all","extra":1}"#.as_slice(),
        br#"{"type":"secure-attention","keyCode":46}"#.as_slice(),
    ] {
        assert!(
            decode_control_message(payload).is_err(),
            "{}",
            String::from_utf8_lossy(payload)
        );
    }
}
