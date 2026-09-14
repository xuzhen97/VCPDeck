//! Host 运行态：把控制面 IPC 请求与真实 WebRTC 协商接在一起。
//!
//! 分工：
//! - [`HostService`] 负责会话生命周期、attachment 角色和布局 generation（同步、可测试）；
//! - [`PeerManager`] 负责 SDP/ICE 与 DataChannel（异步）；
//! - `HostRuntime` 只做编排，并把「需要通道就绪后才能做」的工作放进待办队列。
//!
//! 关键顺序约束：answer 必须在通道绑定之前返回给 Browser。Browser 只有拿到 answer
//! 才会完成 DTLS 并打开通道，因此绑定与 challenge 下发不能阻塞在 `session.signal`
//! 的响应路径上，否则会自我死锁。

use desktop_core::clipboard::ClipboardMode;
use desktop_core::dispatch::apply_control_action;
use desktop_core::encoder::{EncoderFactory, VideoEncoder};
use desktop_core::host::{HostErrorInfo, HostRequest, HostResponse, HostService};
use desktop_core::peer::{PeerManager, CHANNEL_BIND_TIMEOUT};
use desktop_core::protocol::Signal;
use desktop_core::session::{AttachmentRole, DesktopBackend};
use desktop_core::webrtc::transport::{
    receive_control_raw, receive_pointer_message, send_clipboard_message, send_control_message,
    TransportCodec,
};
use desktop_core::webrtc::{
    decode_inbound_control_message, ControlAction, ControlMessage, ControlSession, DataChannelKind,
    InboundControlMessage, WebRtcError,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Mutex;

const ERROR_PROTOCOL_MISMATCH: &str = "REMOTE_DESKTOP_PROTOCOL_MISMATCH";
const ERROR_NO_ACTIVE_SESSION: &str = "REMOTE_DESKTOP_NO_ACTIVE_SESSION";
const ERROR_ICE_FAILED: &str = "REMOTE_DESKTOP_ICE_FAILED";

/// 平台剪贴板的轮询间隔。
///
/// 平台侧没有统一的变化通知接口（Windows 需窗口消息，X11/Wayland 各不相同），
/// 因此采用有界轮询并靠内容去重避免重复推送。
pub const CLIPBOARD_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// `session.signal` 的 payload：与 Server 下发的形状一致。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignalPayload {
    attachment_id: String,
    signal: Signal,
}

/// 一次需要等通道就绪才能完成的 attachment 初始化。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingChallenge {
    pub session_id: String,
    pub attachment_id: String,
    pub role: AttachmentRole,
    /// 通道绑定的绝对截止时刻；超过它才允许拆掉连接。
    pub deadline: Instant,
}

/// 一次媒体节拍的结果，用于诊断与测试。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaOutcome {
    /// 没有已建立视频轨道的 attachment，无需捕获。
    NoViewer,
    /// 未注入编码器工厂。
    NoEncoder,
    /// 捕获或编码失败。
    Failed,
    /// 编码器仍在预热（lookahead 未满），本拍无输出。
    WarmingUp,
    /// 已向 N 个 attachment 广播编码数据。
    Sent(usize),
}

/// 一次 `pump()` 的结果，用于诊断和状态上报。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChallengeOutcome {
    /// challenge 已下发。
    Sent,
    /// 通道尚未齐全但仍在期限内，已放回队列等下一次 pump 重试。
    WarmingUp,
    /// 通道未在超时内就绪。
    ChannelMissing,
    /// attachment 或会话已不存在。
    Gone,
    /// 发送失败。
    Failed,
}

pub struct HostRuntime<B: DesktopBackend> {
    service: HostService<B>,
    peers: PeerManager,
    pending: VecDeque<PendingChallenge>,
    /// 每个 attachment 正在运行的通道读取任务，release 时必须中止。
    control_tasks: HashMap<String, Vec<tokio::task::JoinHandle<()>>>,
    bind_timeout: Duration,
    clipboard_interval: Duration,
    /// 编码器工厂（Send+Sync，只持配置）；编码器实例本身由媒体循环线程独占。
    encoder_factory: Option<Arc<dyn EncoderFactory>>,
    /// 媒体节拍序号，用于编码时间戳与关键帧请求。
    media_sequence: u64,
    /// 媒体帧率，用于计算每帧时长。
    media_fps: u32,
}

impl<B: DesktopBackend + 'static> HostRuntime<B> {
    pub fn new(service: HostService<B>, codec: TransportCodec, stun_urls: Vec<String>) -> Self {
        Self {
            service,
            peers: PeerManager::new(codec, stun_urls),
            pending: VecDeque::new(),
            control_tasks: HashMap::new(),
            bind_timeout: CHANNEL_BIND_TIMEOUT,
            clipboard_interval: CLIPBOARD_POLL_INTERVAL,
            encoder_factory: None,
            media_sequence: 0,
            media_fps: 30,
        }
    }

    /// 覆盖通道绑定等待上限；测试用它避免长时间等待。
    pub fn with_bind_timeout(mut self, timeout: Duration) -> Self {
        self.bind_timeout = timeout;
        self
    }

    /// 覆盖剪贴板轮询间隔；测试用它避免长时间等待。
    pub fn with_clipboard_interval(mut self, interval: Duration) -> Self {
        self.clipboard_interval = interval;
        self
    }

    pub fn service(&self) -> &HostService<B> {
        &self.service
    }

    pub fn peers(&self) -> &PeerManager {
        &self.peers
    }

    /// 取共享的控制会话句柄；调用方需自行加锁。
    ///
    /// 它来自 [`HostService`]，与 `is_authenticated`、状态上报共用同一份授权状态。
    pub fn control_session(&self, attachment_id: &str) -> Option<Arc<StdMutex<ControlSession>>> {
        self.service.control_session(attachment_id)
    }

    pub fn control_session_count(&self) -> usize {
        self.service.control_session_count()
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// 处理一条控制面请求。
    ///
    /// 除 `session.signal` 外全部委托给同步的 [`HostService`]；
    /// offer 会额外入队一次「绑定通道并下发 challenge」的待办。
    pub async fn handle(&mut self, request: HostRequest) -> HostResponse {
        if request.action != "session.signal" {
            let response = self.service.handle(request);
            return response;
        }
        self.handle_signal(request).await
    }

    async fn handle_signal(&mut self, request: HostRequest) -> HostResponse {
        let Some(payload) = request
            .payload
            .as_ref()
            .and_then(|value| serde_json::from_value::<SignalPayload>(value.clone()).ok())
        else {
            return self.reject(&request, ERROR_PROTOCOL_MISMATCH, "Invalid signal payload");
        };
        let Some(role) = self
            .service
            .role_of(&request.session_id, &payload.attachment_id)
        else {
            return self.reject(
                &request,
                ERROR_NO_ACTIVE_SESSION,
                "Attachment is not active",
            );
        };

        match payload.signal {
            Signal::Offer { sdp } => {
                let answer = match self
                    .peers
                    .accept_offer(&payload.attachment_id, role, &sdp)
                    .await
                {
                    Ok(answer) => answer,
                    Err(WebRtcError::InvalidOffer) => {
                        return self.reject(&request, ERROR_PROTOCOL_MISMATCH, "Invalid SDP offer")
                    }
                    Err(_) => return self.reject(&request, ERROR_ICE_FAILED, "Negotiation failed"),
                };
                // 通道只能在 Browser 收到 answer 后才会打开；这里只登记待办。
                // 截止时刻在此设定：ICE 候选要经过后续 IPC 请求才能到达，
                // 因此不能在请求路径上等待，只能靠重试推进。
                self.pending.push_back(PendingChallenge {
                    session_id: request.session_id.clone(),
                    attachment_id: payload.attachment_id.clone(),
                    role,
                    deadline: Instant::now() + self.bind_timeout,
                });
                self.ok(
                    &request,
                    json!({ "signal": { "kind": "answer", "sdp": answer } }),
                )
            }
            Signal::Ice {
                candidate,
                sdp_mid,
                sdp_m_line_index,
            } => {
                // 候选必须真正交给 PeerConnection：只回 ack 会让 ICE 停在 checking，
                // DataChannel 永远不开，最终被 bind_channels 超时销毁整条连接。
                if self
                    .peers
                    .add_ice_candidate(
                        &payload.attachment_id,
                        &candidate,
                        sdp_mid,
                        sdp_m_line_index,
                    )
                    .await
                    .is_err()
                {
                    return self.reject(
                        &request,
                        ERROR_ICE_FAILED,
                        "Attachment has no peer connection",
                    );
                }
                self.ok(&request, json!({}))
            }
            // 结束标记无需应用候选；缺 peer 说明信令顺序异常，仍按失败处理。
            Signal::IceComplete => {
                if !self.peers.has(&payload.attachment_id) {
                    return self.reject(
                        &request,
                        ERROR_ICE_FAILED,
                        "Attachment has no peer connection",
                    );
                }
                self.ok(&request, json!({}))
            }
            Signal::Answer { .. } => {
                // Host 固定为 answerer：收到 answer 说明方向错误，必须拒绝。
                self.reject(
                    &request,
                    ERROR_PROTOCOL_MISMATCH,
                    "Host must not receive an SDP answer",
                )
            }
        }
    }

    /// 完成所有待办的通道绑定与 challenge 下发。
    ///
    /// 调用方应在写出 `session.signal` 响应之后调用，避免阻塞 answer 的送达。
    pub async fn pump(&mut self) -> Vec<ChallengeOutcome> {
        let mut outcomes = Vec::new();
        // 只处理进入本次调用时已排队的项：complete_pending 会把“未到期”的项
        // 放回队列，直接 `while pop_front` 会在这里空转。
        let batch: Vec<PendingChallenge> = self.pending.drain(..).collect();
        for pending in batch {
            outcomes.push(self.complete_pending(pending).await);
        }
        outcomes
    }

    async fn complete_pending(&mut self, pending: PendingChallenge) -> ChallengeOutcome {
        if !self.peers.has(&pending.attachment_id) {
            self.service.revoke_attachment(&pending.attachment_id);
            return ChallengeOutcome::Gone;
        }
        // 非阻塞尝试绑定：调用方持有 Host 运行时锁，而在锁内等待就会把
        // “能让通道打开的 ICE 候选”（它们必须经由后续 IPC 请求进入）挡在锁外。
        match self.peers.bind_available(&pending.attachment_id).await {
            Ok(true) => {}
            Ok(false) => {
                // 通道还没到齐：只要没到期就放回队列，等下一次 pump 再试。
                // 每个 ICE 候选请求都会触发一次 pump，重试因此自然推进。
                if Instant::now() < pending.deadline {
                    self.pending.push_back(pending);
                    return ChallengeOutcome::WarmingUp;
                }
                // 真正超时：释放连接并撤销授权，不留下没有数据面的 attachment。
                let _ = self.peers.close(&pending.attachment_id).await;
                self.service.revoke_attachment(&pending.attachment_id);
                return ChallengeOutcome::ChannelMissing;
            }
            Err(_) => {
                self.service.revoke_attachment(&pending.attachment_id);
                return ChallengeOutcome::Gone;
            }
        }
        // 授权对象必须存在；缺失说明会话已关闭。
        let Some(session) = self.service.control_session(&pending.attachment_id) else {
            let _ = self.peers.close(&pending.attachment_id).await;
            return ChallengeOutcome::Gone;
        };
        // challenge 必须先于读取任务下发：Browser 只有收到它才会回应，
        // 否则后台任务会一直等一个永远不会来的 challenge-response。
        let Some(challenge) = self.service.challenge_for(&pending.attachment_id) else {
            let _ = self.peers.close(&pending.attachment_id).await;
            self.service.revoke_attachment(&pending.attachment_id);
            return ChallengeOutcome::Gone;
        };
        if self
            .peers
            .send_challenge(&pending.attachment_id, &challenge)
            .await
            .is_err()
        {
            return ChallengeOutcome::Failed;
        }
        // 通道已就绪、challenge 已下发，现在启动真正的数据面读取任务。
        // 没有这一步，Browser 的输入永远不会被读出来，更不会到达平台。
        self.spawn_channel_loops(
            &pending.session_id,
            &pending.attachment_id,
            pending.role,
            session,
        );
        ChallengeOutcome::Sent
    }

    /// 为已就绪的 attachment 启动控制（与 Operator 的指针、双向剪贴板）读取循环。
    fn spawn_channel_loops(
        &mut self,
        session_id: &str,
        attachment_id: &str,
        role: AttachmentRole,
        session: Arc<StdMutex<ControlSession>>,
    ) {
        let mut handles = Vec::new();
        let backend = self.service.backend_arc();
        if let Some(control) = self
            .peers
            .peer(attachment_id)
            .and_then(|peer| peer.channel(DataChannelKind::ControlReliable))
            .cloned()
        {
            handles.push(tokio::spawn(control_loop(
                control,
                Arc::clone(&session),
                Arc::clone(&backend),
            )));
        }
        // Viewer 没有指针通道（`channel()` 对角色不允许的通道返回 None），
        // 即使 Browser 擅自创建也不会被读取。
        if role == AttachmentRole::Operator {
            if let Some(pointer) = self
                .peers
                .peer(attachment_id)
                .and_then(|peer| peer.channel(DataChannelKind::PointerRealtime))
                .cloned()
            {
                handles.push(tokio::spawn(pointer_loop(pointer, Arc::clone(&session))));
            }
            // 只有双向模式才会把远端剪贴板推给 Browser；其余模式不轮询，
            // 避免无意义地反复读取平台剪贴板。
            if self.service.clipboard_mode(session_id) == Some(ClipboardMode::Bidirectional) {
                if let Some(control) = self
                    .peers
                    .peer(attachment_id)
                    .and_then(|peer| peer.channel(DataChannelKind::ControlReliable))
                    .cloned()
                {
                    handles.push(tokio::spawn(clipboard_loop(
                        control,
                        session,
                        backend,
                        self.clipboard_interval,
                    )));
                }
            }
        }
        self.control_tasks
            .insert(attachment_id.to_string(), handles);
    }

    /// 释放一个 attachment 的数据面与控制会话。
    pub async fn release(&mut self, attachment_id: &str) {
        // 先中止读取任务，再关闭通道：否则任务会在已关闭的通道上反复重试。
        if let Some(handles) = self.control_tasks.remove(attachment_id) {
            for handle in handles {
                handle.abort();
            }
        }
        // 授权只在 HostService 中保存一份，释放数据面时必须一并撤销。
        self.service.revoke_attachment(attachment_id);
        self.pending
            .retain(|pending| pending.attachment_id != attachment_id);
        let _ = self.peers.close(attachment_id).await;
    }

    /// 释放全部数据面；用于会话关闭或 Host 退出。
    pub async fn release_all(&mut self) {
        for (_, handles) in self.control_tasks.drain() {
            for handle in handles {
                handle.abort();
            }
        }
        self.pending.clear();
        self.peers.close_all().await;
    }

    /// 注入编码器工厂；未注入时媒体循环不会产出任何帧。
    pub fn with_encoder_factory(mut self, factory: Arc<dyn EncoderFactory>) -> Self {
        self.encoder_factory = Some(factory);
        self
    }

    /// 执行一次媒体节拍：捕获 → 编码 → 广播。
    ///
    /// 编码器由**调用方**持有（`&mut Option<Box<dyn VideoEncoder>>`）：平台编码器
    /// 通常不是 Send/Sync（COM 套间归属），不能存进本结构经共享 Mutex 传递。
    /// 因此媒体循环必须在独占线程上运行，并把编码器留在线程局部变量里。
    pub async fn pump_media(
        &mut self,
        encoder: &mut Option<Box<dyn VideoEncoder>>,
    ) -> MediaOutcome {
        if self.peers.video_attachment_count() == 0 {
            return MediaOutcome::NoViewer;
        }
        let Ok(frame) = self.service.backend().capture_frame(None) else {
            return MediaOutcome::Failed;
        };
        if encoder.is_none() {
            let Some(factory) = self.encoder_factory.as_ref() else {
                return MediaOutcome::NoEncoder;
            };
            match factory.create(frame.width, frame.height) {
                Ok(created) => *encoder = Some(created),
                Err(_) => return MediaOutcome::Failed,
            }
        }
        self.media_sequence = self.media_sequence.wrapping_add(1);
        let sequence = self.media_sequence;
        let Some(active) = encoder.as_mut() else {
            return MediaOutcome::Failed;
        };
        // 首帧请求关键帧，让新加入的 viewer 尽快看到画面。
        let want_key_frame = sequence <= 1;
        match active.encode(&frame, sequence, want_key_frame) {
            Ok(Some(encoded)) => {
                let duration = Duration::from_millis(1000 / u64::from(self.media_fps.max(1)));
                let sent = self.peers.broadcast_sample(&encoded.bytes, duration).await;
                if sent == 0 {
                    MediaOutcome::Failed
                } else {
                    MediaOutcome::Sent(sent)
                }
            }
            // 预热期（lookahead 未满）：不是错误。
            Ok(None) => MediaOutcome::WarmingUp,
            Err(_) => {
                // 编码失败（含尺寸变化）：丢弃编码器，下一拍按新尺寸重建。
                *encoder = None;
                MediaOutcome::Failed
            }
        }
    }

    /// 已绑定的通道标签；用于诊断。
    pub fn channel_labels(&self, attachment_id: &str) -> Vec<&'static str> {
        self.peers
            .peer(attachment_id)
            .map(|peer| peer.channel_labels())
            .unwrap_or_default()
    }

    /// attachment 的控制通道是否已就绪。
    pub fn has_control_channel(&self, attachment_id: &str) -> bool {
        self.peers
            .peer(attachment_id)
            .map(|peer| peer.channel(DataChannelKind::ControlReliable).is_some())
            .unwrap_or(false)
    }

    fn ok(&self, request: &HostRequest, result: serde_json::Value) -> HostResponse {
        self.service_response(request, true, Some(result), None)
    }

    fn reject(&self, request: &HostRequest, code: &str, message: &str) -> HostResponse {
        self.service_response(
            request,
            false,
            None,
            Some(desktop_core::host::HostErrorInfo {
                code: code.to_string(),
                message: message.to_string(),
            }),
        )
    }

    fn service_response(
        &self,
        request: &HostRequest,
        ok: bool,
        result: Option<serde_json::Value>,
        error: Option<HostErrorInfo>,
    ) -> HostResponse {
        HostResponse {
            request_id: request.request_id.clone(),
            protocol_version: 1,
            host_generation: self.service.generation().to_string(),
            ok,
            result,
            error,
        }
    }
}

/// 在**独占线程**上运行媒体循环。
///
/// 必须独占线程：平台编码器持有有套间归属的资源（Windows 上是 Media Foundation
/// 的 COM 对象），而 tokio 的多线程运行时会在 await 点把任务迁到别的线程，
/// 那会破坏套间归属。这里用 `current_thread` 运行时，保证编码器始终在
/// **同一线程**上创建、使用与释放；线程之间共享的只有 Send+Sync 的工厂。
pub fn spawn_media_loop<B: DesktopBackend + 'static>(
    runtime: Arc<Mutex<HostRuntime<B>>>,
    interval: Duration,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let Ok(worker) = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
        else {
            return;
        };
        worker.block_on(async move {
            // 编码器是线程局部变量：绝不跨线程，也不放进共享运行时。
            let mut encoder: Option<Box<dyn VideoEncoder>> = None;
            loop {
                tokio::time::sleep(interval).await;
                let mut guard = runtime.lock().await;
                let _ = guard.pump_media(&mut encoder).await;
            }
        });
    })
}

/// 控制通道读取循环：把 Browser 的控制消息应用到平台后端。
///
/// 这个循环是输入链路的最后一跳。缺少它时 `ControlSession` 永远收不到
/// `challenge-response`，Browser 会一直停在未认证状态，输入也不会到达操作系统。
///
/// 任何协议错误、鉴权失败或平台拒绝都终止循环并关闭该 attachment 的数据面：
/// 半认证或半冻结的状态不能继续接受输入。
async fn control_loop<B: DesktopBackend + 'static>(
    control: Arc<dyn desktop_core::webrtc::transport::DataChannel>,
    session: Arc<StdMutex<ControlSession>>,
    backend: Arc<B>,
) {
    loop {
        // 必须读取原始帧再按 type 分流：剪贴板消息与控制消息共用这条通道，
        // 把剪贴板当控制消息解析会让整个控制循环（连同输入）终止。
        let raw = match receive_control_raw(&control).await {
            Ok(raw) => raw,
            // 通道关闭：结束循环。
            Err(_) => break,
        };
        let Ok(inbound) = decode_inbound_control_message(&raw) else {
            // 载荷非法或未知 type：fail closed。
            break;
        };
        match inbound {
            InboundControlMessage::Clipboard(message) => {
                let text = {
                    let Ok(guard) = session.lock() else { break };
                    match guard.handle_clipboard(message) {
                        Ok(text) => text,
                        Err(_) => break,
                    }
                };
                // 模式与角色已在 ControlSession 内校验；平台拒绝同样 fail closed。
                if backend.write_clipboard_text(&text.text).is_err() {
                    break;
                }
                // 必须记录写入内容：否则剪贴板轮询会读到同一份文本并回推给
                // Browser，形成无限往返。
                if let Ok(mut guard) = session.lock() {
                    guard.note_clipboard_written(&text.text);
                }
            }
            InboundControlMessage::Control(message) => {
                // 锁只在同步的 handle/apply 期间持有，不会跨 await 点。
                let action = {
                    let Ok(mut guard) = session.lock() else { break };
                    match guard.handle(message) {
                        Ok(action) => action,
                        Err(_) => break,
                    }
                };
                // 平台应用失败（不支持、显示器不存在等）同样 fail closed。
                if apply_control_action(backend.as_ref(), &action).is_err() {
                    break;
                }
                // 平台已切换捕获目标后，必须把新布局广播给 Browser；
                // 否则 Browser 会一直等一个永远不会来的 layout-update 而永久冻结输入。
                if let ControlAction::DisplaySelected {
                    display_id,
                    layout_generation,
                } = &action
                {
                    let Some(display) = backend
                        .displays()
                        .unwrap_or_default()
                        .into_iter()
                        .find(|display| &display.id == display_id)
                    else {
                        break;
                    };
                    let update = ControlMessage::LayoutUpdate {
                        layout_generation: *layout_generation,
                        display_id: display.id.clone(),
                        width: display.width,
                        height: display.height,
                    };
                    if send_control_message(&control, &update).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
}

/// 指针通道读取循环；只有 Operator 会获得这条通道。
///
/// 指针走独立任务，避免高频移动被控制通道上的其他消息阻塞。
async fn pointer_loop(
    pointer: Arc<dyn desktop_core::webrtc::transport::DataChannel>,
    session: Arc<StdMutex<ControlSession>>,
) {
    loop {
        let message = match receive_pointer_message(&pointer).await {
            Ok(message) => message,
            Err(_) => break,
        };
        let Ok(mut guard) = session.lock() else { break };
        if guard.handle_pointer(message).is_err() {
            break;
        }
    }
}

/// 剪贴板轮询循环：把远端本机复制的内容推送给 Browser。
///
/// 平台侧没有统一的变化通知，因此按固定间隔轮询并依靠 `ControlSession` 的内容
/// 去重；`clipboard_to_browser` 同时负责模式、角色与大小校验，以及抑制
/// “Browser 写入平台 → 轮询读回 → 又推给 Browser”的回声往返。
async fn clipboard_loop<B: DesktopBackend + 'static>(
    control: Arc<dyn desktop_core::webrtc::transport::DataChannel>,
    session: Arc<StdMutex<ControlSession>>,
    backend: Arc<B>,
    interval: Duration,
) {
    loop {
        tokio::time::sleep(interval).await;
        let Ok(current) = backend.read_clipboard_text() else {
            // 平台不支持或读取失败：停止轮询，不做无意义的反复失败。
            break;
        };
        let message = {
            let Ok(mut guard) = session.lock() else { break };
            guard.clipboard_to_browser(current)
        };
        if let Some(message) = message {
            if send_clipboard_message(&control, &message).await.is_err() {
                break;
            }
        }
    }
}
