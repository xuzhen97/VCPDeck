use desktop_core::media::PointerSample;
use desktop_core::session::AttachmentRole;
use desktop_core::webrtc::transport::{
    receive_clipboard_message, receive_control_message, receive_pointer_message,
    send_clipboard_message, send_control_message, send_pointer_message, PeerTransport,
    TransportCodec,
};
use desktop_core::{
    respond_to_challenge, ControlAction, ControlInput, ControlMessage, ControlSession, InputEvent,
    InputGate, PointerCoalescer, PointerMessage, QualityProfile, VideoFrame,
};
use std::time::Duration;

#[test]
fn viewer_receives_bounded_frame_but_cannot_inject_input() {
    let frame = VideoFrame {
        sequence: 1,
        width: 1280,
        height: 720,
        timestamp_ms: 1,
        key_frame: true,
        bytes: vec![0, 1, 2],
    };
    assert!(frame.within(QualityProfile::Balanced.limits()));
    assert_eq!(
        InputGate::new(AttachmentRole::Viewer).accept(&InputEvent::ReleaseAll),
        Err(desktop_core::MediaError::ViewerInputDenied)
    );
}

#[test]
fn pointer_backlog_is_coalesced_to_latest_position() {
    let mut pointer = PointerCoalescer::default();
    for _ in 0..10_000 {
        pointer.push(desktop_core::media::PointerSample {
            x: u16::MAX,
            y: u16::MAX,
        });
    }
    assert_eq!(
        pointer.take_latest(),
        Some(desktop_core::media::PointerSample {
            x: u16::MAX,
            y: u16::MAX,
        })
    );
    assert!(pointer.take_latest().is_none());
}

#[test]
fn real_loopback_delivers_control_and_video_packets() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    runtime.block_on(async {
        let host = PeerTransport::new(Vec::new())
            .await
            .expect("host transport");
        let browser = PeerTransport::new(Vec::new())
            .await
            .expect("browser transport");
        let control = host
            .create_control_channel()
            .await
            .expect("control channel");
        let pointer = host
            .create_pointer_channel()
            .await
            .expect("pointer channel");

        let offer = host.create_offer().await.expect("offer");
        browser
            .set_remote_description(&offer)
            .await
            .expect("browser accepts offer");
        let answer = browser.create_answer().await.expect("answer");
        host.set_remote_description(&answer)
            .await
            .expect("host accepts answer");

        let browser_first =
            tokio::time::timeout(Duration::from_secs(5), browser.next_data_channel())
                .await
                .expect("browser data channel timeout")
                .expect("browser data channel");
        let browser_second =
            tokio::time::timeout(Duration::from_secs(5), browser.next_data_channel())
                .await
                .expect("second browser data channel timeout")
                .expect("second browser data channel");
        let first_label = browser_first.label().await.expect("first channel label");
        let second_label = browser_second.label().await.expect("second channel label");
        let (browser_control, browser_pointer) = if first_label == "control-reliable" {
            (browser_first, browser_second)
        } else if second_label == "control-reliable" {
            (browser_second, browser_first)
        } else {
            panic!("expected control-reliable channel, got {first_label} and {second_label}");
        };
        wait_for_open(&control).await;
        wait_for_open(&pointer).await;
        wait_for_open(&browser_control).await;
        wait_for_open(&browser_pointer).await;
        let mut host_session = ControlSession::new_with_clipboard(
            "operator-1",
            desktop_core::AttachmentRole::Operator,
            [8; 32],
            desktop_core::ClipboardMode::Bidirectional,
        );
        send_control_message(
            &control,
            &ControlMessage::Challenge {
                nonce: [8; 32],
                attachment_id: "operator-1".to_string(),
            },
        )
        .await
        .expect("challenge message");
        let challenge = receive_control_message(&browser_control)
            .await
            .expect("challenge");
        let response = respond_to_challenge(&challenge, "operator-1").expect("challenge response");
        send_control_message(&browser_control, &response)
            .await
            .expect("challenge response message");
        let response = receive_control_message(&control)
            .await
            .expect("host response");
        assert_eq!(
            host_session.handle(response),
            Ok(ControlAction::Authenticated)
        );

        send_control_message(
            &browser_control,
            &ControlMessage::Input {
                event: ControlInput::PointerMove { x: 600, y: 400 },
            },
        )
        .await
        .expect("input message");
        let input = receive_control_message(&control).await.expect("input");
        assert_eq!(
            host_session.handle(input),
            Ok(ControlAction::InputAccepted(InputEvent::PointerMove {
                x: 600,
                y: 400,
            }))
        );
        assert_eq!(host_session.input_mut().next_pointer().unwrap().x, 600);

        send_pointer_message(
            &browser_pointer,
            &PointerMessage {
                layout_generation: 0,
                x: 601,
                y: 401,
            },
        )
        .await
        .expect("pointer message");
        let pointer_message = receive_pointer_message(&pointer).await.expect("pointer");
        assert_eq!(
            host_session.handle_pointer(pointer_message),
            Ok(ControlAction::PointerAccepted(PointerSample {
                x: 601,
                y: 401,
            }))
        );
        assert_eq!(host_session.input_mut().next_pointer().unwrap().x, 601);

        let clipboard_message = desktop_core::ClipboardMessage::BrowserToRemote {
            text: "copied text".to_string(),
        };
        send_clipboard_message(&browser_control, &clipboard_message)
            .await
            .expect("clipboard message");
        let received_clipboard = receive_clipboard_message(&control)
            .await
            .expect("received clipboard message");
        assert_eq!(received_clipboard, clipboard_message);
        assert_eq!(
            host_session.handle_clipboard(received_clipboard),
            Ok(desktop_core::ClipboardText::new("copied text".to_string()).unwrap())
        );

        let track = host
            .add_video_track(TransportCodec::Vp8)
            .await
            .expect("video track");
        let offer = host.create_offer().await.expect("video offer");
        browser
            .set_remote_description(&offer)
            .await
            .expect("browser accepts video offer");
        let answer = browser.create_answer().await.expect("video answer");
        host.set_remote_description(&answer)
            .await
            .expect("host accepts video answer");

        host.send_encoded_sample(&track, vec![0x10, 0x20, 0x30], Duration::from_millis(33))
            .await
            .expect("encoded sample");
        let browser_track =
            tokio::time::timeout(Duration::from_secs(5), browser.next_remote_track())
                .await
                .expect("browser track timeout")
                .expect("browser track");
        assert!(next_rtp_packet(&browser_track).await);

        host.close().await.expect("close host");
        browser.close().await.expect("close browser");
    });
}

async fn wait_for_open(channel: &std::sync::Arc<dyn webrtc::data_channel::DataChannel>) {
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

async fn next_rtp_packet(
    track: &std::sync::Arc<dyn webrtc::media_stream::track_remote::TrackRemote>,
) -> bool {
    loop {
        match track.poll().await {
            Some(webrtc::media_stream::track_remote::TrackRemoteEvent::OnRtpPacket(_)) => {
                return true
            }
            Some(webrtc::media_stream::track_remote::TrackRemoteEvent::OnEnded) | None => {
                return false
            }
            Some(_) => {}
        }
    }
}
