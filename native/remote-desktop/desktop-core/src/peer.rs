//! Host 侧 WebRTC 协商与 attachment 数据面。
//!
//! 生产拓扑中 **Browser 是 offerer**：
//! 1. Browser 创建 `control-reliable`（有序可靠）与 `pointer-realtime`（无序、零重传）
//!    两条 DataChannel，并添加 `recvonly` 视频 transceiver，然后发出 offer；
//! 2. Host 设置远端 offer，把视频轨道挂到 Browser 已声明的 transceiver 上，产出 answer；
//! 3. Host 通过 `ondatachannel` 收取通道，并按 **label** 绑定，不依赖到达顺序。
//!
//! DataChannel 必须由 offerer 声明：若 Browser 不创建通道，answer 里就不会有
//! `m=application` 段，Host 单方面创建的通道永远无法完成协商。

use crate::session::AttachmentRole;
use crate::webrtc::transport::{PeerTransport, TransportCodec, VideoTrack};
use crate::webrtc::{Challenge, ControlMessage, DataChannelKind, WebRtcError};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use webrtc::data_channel::DataChannel;
use webrtc::peer_connection::RTCSessionDescription;

/// 等待 Browser 通道到达的默认上限。
pub const CHANNEL_BIND_TIMEOUT: Duration = Duration::from_secs(5);

const CONTROL_LABEL: &str = "control-reliable";
const POINTER_LABEL: &str = "pointer-realtime";

/// 一个 attachment 的实时数据面。
pub struct AttachmentPeer {
    pub role: AttachmentRole,
    pub transport: PeerTransport,
    channels: HashMap<&'static str, Arc<dyn DataChannel>>,
    /// 该 attachment 的视频轨道。
    ///
    /// 必须保存下来：媒体循环要靠它把同一段编码数据广播给每个 attachment；
    /// 之前 add_video_track 的返回值被丢弃，导致数据面根本无从发送。
    video: VideoTrack,
}

impl AttachmentPeer {
    /// 按协议 label 取通道；未绑定或角色不允许时返回 `None`。
    pub fn channel(&self, kind: DataChannelKind) -> Option<&Arc<dyn DataChannel>> {
        if !self.requires(kind) {
            return None;
        }
        self.channels.get(kind.label())
    }

    /// 已绑定的通道 label，便于诊断。
    pub fn channel_labels(&self) -> Vec<&'static str> {
        let mut labels: Vec<&'static str> = self.channels.keys().copied().collect();
        labels.sort_unstable();
        labels
    }

    /// 该角色是否允许使用该通道。
    pub fn requires(&self, kind: DataChannelKind) -> bool {
        match kind {
            DataChannelKind::ControlReliable => true,
            DataChannelKind::PointerRealtime => self.role == AttachmentRole::Operator,
        }
    }

    /// 把一个 Browser 的远端 ICE 候选交给本 attachment 的 PeerConnection。
    pub async fn add_remote_candidate(
        &self,
        candidate: &str,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    ) -> Result<(), WebRtcError> {
        self.transport
            .add_remote_candidate(candidate, sdp_mid, sdp_m_line_index)
            .await
            .map_err(|_| WebRtcError::NegotiationFailed)
    }

    /// 必须绑定的通道 label。
    fn required_labels(&self) -> &'static [&'static str] {
        match self.role {
            AttachmentRole::Operator => &[CONTROL_LABEL, POINTER_LABEL],
            AttachmentRole::Viewer => &[CONTROL_LABEL],
        }
    }

    /// 尚未绑定的必需通道；空表示绑定完成。
    fn missing_required(&self) -> Vec<&'static str> {
        self.required_labels()
            .iter()
            .filter(|label| !self.channels.contains_key(**label))
            .copied()
            .collect()
    }

    fn bind(&mut self, channel: Arc<dyn DataChannel>, label: &'static str) {
        // 同 label 重复到达时保留先到的通道，避免半途替换导致状态错乱。
        self.channels.entry(label).or_insert(channel);
    }
}

/// 管理每个 attachment 的 PeerConnection 生命周期。
pub struct PeerManager {
    peers: HashMap<String, AttachmentPeer>,
    codec: TransportCodec,
    stun_urls: Vec<String>,
}

impl PeerManager {
    pub fn new(codec: TransportCodec, stun_urls: Vec<String>) -> Self {
        Self {
            peers: HashMap::new(),
            codec,
            stun_urls,
        }
    }

    pub fn codec(&self) -> TransportCodec {
        self.codec
    }

    pub fn has(&self, attachment_id: &str) -> bool {
        self.peers.contains_key(attachment_id)
    }

    /// 把 Browser 的 ICE 候选应用到对应 attachment 的 PeerConnection。
    ///
    /// 只确认"peer 存在"而不应用候选，会让 ICE 永远停在 checking：
    /// 对端拿不到本端候选、本端也不认对端候选，DataChannel 永远不会打开。
    pub async fn add_ice_candidate(
        &self,
        attachment_id: &str,
        candidate: &str,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    ) -> Result<(), WebRtcError> {
        let peer = self.peers.get(attachment_id).ok_or(WebRtcError::Closed)?;
        peer.add_remote_candidate(candidate, sdp_mid, sdp_m_line_index)
            .await
    }

    pub fn len(&self) -> usize {
        self.peers.len()
    }

    /// 当前已知的 attachment ID；用于诊断信令顺序问题。
    pub fn attachment_ids(&self) -> Vec<String> {
        self.peers.keys().cloned().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    pub fn peer(&self, attachment_id: &str) -> Option<&AttachmentPeer> {
        self.peers.get(attachment_id)
    }

    /// Host 作为 answerer 接受 Browser offer，返回 answer SDP。
    ///
    /// 重复 offer 会先释放旧连接，避免同一 attachment 残留两条 PeerConnection。
    pub async fn accept_offer(
        &mut self,
        attachment_id: &str,
        role: AttachmentRole,
        offer_sdp: &str,
    ) -> Result<String, WebRtcError> {
        if offer_sdp.trim().is_empty() {
            return Err(WebRtcError::InvalidOffer);
        }
        if self.peers.contains_key(attachment_id) {
            self.close(attachment_id).await?;
        }
        let offer = RTCSessionDescription::offer(offer_sdp.to_string())
            .map_err(|_| WebRtcError::InvalidOffer)?;
        let transport = PeerTransport::new(self.stun_urls.clone())
            .await
            .map_err(|_| WebRtcError::NegotiationFailed)?;
        transport
            .set_remote_description(&offer)
            .await
            .map_err(|_| WebRtcError::NegotiationFailed)?;
        // 视频轨道必须挂到 Browser offer 已声明的 recvonly 视频 m-line 上。
        let video = transport
            .add_video_track(self.codec)
            .await
            .map_err(|_| WebRtcError::NegotiationFailed)?;
        let answer = transport
            .create_answer()
            .await
            .map_err(|_| WebRtcError::NegotiationFailed)?;
        if answer.sdp.trim().is_empty() {
            return Err(WebRtcError::NegotiationFailed);
        }
        self.peers.insert(
            attachment_id.to_string(),
            AttachmentPeer {
                role,
                transport,
                channels: HashMap::new(),
                video,
            },
        );
        Ok(answer.sdp)
    }

    /// 有界等待并按 label 绑定 Browser 创建的通道。
    ///
    /// 以「必需 label 是否齐全」而不是「已绑定数量」作为完成条件：通道到达顺序不确定，
    /// 用数量判断会把只到达 `pointer-realtime` 的半成品当成绑定成功。
    /// 角色不允许的通道（Viewer 的指针通道）直接忽略，从不绑定。
    ///
    /// **会阻塞到超时**，而调用方通常持有 Host 运行时锁。生产数据面路径必须用
    /// [`PeerManager::bind_available`]；本方法仅供测试与非持锁路径使用。
    pub async fn bind_channels(
        &mut self,
        attachment_id: &str,
        timeout: Duration,
    ) -> Result<(), WebRtcError> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let peer = self.peers.get(attachment_id).ok_or(WebRtcError::Closed)?;
                if peer.missing_required().is_empty() {
                    return Ok(());
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let received = {
                let peer = self.peers.get(attachment_id).ok_or(WebRtcError::Closed)?;
                tokio::time::timeout(remaining, peer.transport.next_data_channel())
                    .await
                    .ok()
                    .flatten()
            };
            let Some(channel) = received else {
                break;
            };
            let Ok(label) = channel.label().await else {
                continue;
            };
            // 未知 label 一律忽略，不猜测用途。
            let kind = match label.as_str() {
                CONTROL_LABEL => DataChannelKind::ControlReliable,
                POINTER_LABEL => DataChannelKind::PointerRealtime,
                _ => continue,
            };
            let peer = self
                .peers
                .get_mut(attachment_id)
                .ok_or(WebRtcError::Closed)?;
            if !peer.requires(kind) {
                continue;
            }
            peer.bind(channel, kind.label());
        }

        let peer = self.peers.get(attachment_id).ok_or(WebRtcError::Closed)?;
        if !peer.missing_required().is_empty() {
            return Err(WebRtcError::ChannelMissing);
        }
        Ok(())
    }

    /// 非阻塞地把**当前已到达**的通道全部绑定；返回必需通道是否已齐全。
    ///
    /// 调用方持有 Host 运行时锁，因此**绝不能在这里等待**：能让 DataChannel 打开的
    /// ICE 候选必须通过后续 IPC 请求进入，在锁内等待会把自己需要的输入挡在锁外，
    /// 形成“等通道打开，却拒收能让通道打开的候选”的自锁。
    pub async fn bind_available(&mut self, attachment_id: &str) -> Result<bool, WebRtcError> {
        loop {
            let channel = {
                let peer = self.peers.get(attachment_id).ok_or(WebRtcError::Closed)?;
                peer.transport.try_next_data_channel().await
            };
            let Some(channel) = channel else {
                break;
            };
            let Ok(label) = channel.label().await else {
                continue;
            };
            // 未知 label 一律忽略，不猜测用途。
            let kind = match label.as_str() {
                CONTROL_LABEL => DataChannelKind::ControlReliable,
                POINTER_LABEL => DataChannelKind::PointerRealtime,
                _ => continue,
            };
            let peer = self
                .peers
                .get_mut(attachment_id)
                .ok_or(WebRtcError::Closed)?;
            if !peer.requires(kind) {
                continue;
            }
            peer.bind(channel, kind.label());
        }
        let peer = self.peers.get(attachment_id).ok_or(WebRtcError::Closed)?;
        Ok(peer.missing_required().is_empty())
    }

    /// 向所有已建立视频轨道的 attachment 广播同一段已编码数据。
    ///
    /// **一次编码、多路扇出**：编码是昂贵的，不能按 attachment 重复编码。
    /// 返回成功发送的 attachment 数量。
    pub async fn broadcast_sample(&self, data: &[u8], duration: std::time::Duration) -> usize {
        let mut sent = 0usize;
        for peer in self.peers.values() {
            // 每个 attachment 有独立 PeerConnection 与轨道，需要各自的字节拷贝。
            if peer
                .transport
                .send_encoded_sample(&peer.video, data.to_vec(), duration)
                .await
                .is_ok()
            {
                sent += 1;
            }
        }
        sent
    }

    /// 已建立视频轨道的 attachment 数量（供诊断与测试）。
    pub fn video_attachment_count(&self) -> usize {
        self.peers.len()
    }

    /// 向 Browser 发送 attachment challenge。
    pub async fn send_challenge(
        &self,
        attachment_id: &str,
        challenge: &Challenge,
    ) -> Result<(), WebRtcError> {
        let peer = self.peers.get(attachment_id).ok_or(WebRtcError::Closed)?;
        let control = peer
            .channel(DataChannelKind::ControlReliable)
            .ok_or(WebRtcError::ChannelMissing)?;
        let message = ControlMessage::Challenge {
            nonce: challenge.nonce,
            attachment_id: attachment_id.to_string(),
        };
        crate::webrtc::transport::send_control_message(control, &message).await
    }

    /// 释放单个 attachment 的连接；不存在时视为已释放。
    pub async fn close(&mut self, attachment_id: &str) -> Result<(), WebRtcError> {
        let Some(peer) = self.peers.remove(attachment_id) else {
            return Ok(());
        };
        peer.transport
            .close()
            .await
            .map_err(|_| WebRtcError::Transport)
    }

    /// 释放全部 attachment；用于会话关闭或 Host 退出。
    pub async fn close_all(&mut self) {
        for (_, peer) in self.peers.drain() {
            let _ = peer.transport.close().await;
        }
    }
}
