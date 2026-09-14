import type {
	RemoteDesktopBrowserAttached,
	RemoteDesktopSignal,
} from "@vcpdeck/shared";
import {
	clearReconnectToken,
	loadReconnectToken,
	saveReconnectToken,
} from "./remote-desktop-reconnect.js";
import {
	summarizeConnectionStats,
	type RemoteDesktopConnectionStats,
} from "./remote-desktop-stats.js";
import type { RemoteDesktopSocket } from "./remote-desktop-socket.js";

export interface RemoteDesktopChannels {
	control: RTCDataChannel | null;
	pointer: RTCDataChannel | null;
}

/** 恢复窗口：与 Server 的 operator 保护期一致。 */
export const RECONNECT_WINDOW_MS = 30_000;

/** 恢复窗口内 attach 失败后的重试间隔。 */
export const RECONNECT_RETRY_MS = 1_000;

/** 恢复窗口耗尽后的稳定错误码。 */
export const RECONNECT_TIMEOUT_CODE = "REMOTE_DESKTOP_RECONNECT_TIMEOUT";

export type RemoteDesktopConnectionPhase =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "failed"
	| "closed";

export interface RemoteDesktopConnectionState {
	phase: RemoteDesktopConnectionPhase;
	/** 恢复尝试次数；`connected` 时归零。 */
	attempt: number;
	/** 恢复窗口截止时间（epoch ms）；仅 `reconnecting` 时有值。 */
	deadline: number | null;
	/** `failed` 时的稳定错误码。 */
	code: string | null;
}

export interface RemoteDesktopPeer {
	connect(sessionId: string, reconnectToken?: string): Promise<RemoteDesktopBrowserAttached>;
	state(): RemoteDesktopConnectionState;
	onStateChange(callback: (state: RemoteDesktopConnectionState) => void): () => void;
	channels(): RemoteDesktopChannels;
	onChannels(callback: (channels: RemoteDesktopChannels) => void): () => void;
	onTrack(callback: (event: RTCTrackEvent) => void): () => void;
	onControlMessage(callback: (message: unknown) => void): () => void;
	sendControl(message: unknown): void;
	sendPointer(message: unknown): void;
	/** 读取当前连接的真实路径与延迟；无连接或解析失败时返回 `null`。 */
	stats(): Promise<RemoteDesktopConnectionStats | null>;
	/**
	 * 恢复失败后由操作者显式重试：丢弃旧连接，重新 attach 并重新协商。
	 *
	 * 不能只让用户关闭面板重建——那会丢掉 Session 与已建立的上下文。
	 */
	retry(): Promise<RemoteDesktopBrowserAttached>;
	close(): Promise<void>;
}

function toRtcDescription(signal: RemoteDesktopSignal): RTCSessionDescriptionInit | null {
	if (signal.kind === "answer") return { type: "answer", sdp: signal.sdp };
	return null;
}

function toSignal(description: RTCSessionDescription | RTCSessionDescriptionInit): RemoteDesktopSignal {
	if (description.type !== "offer" && description.type !== "answer") {
		throw new Error("Unsupported WebRTC description");
	}
	return { kind: description.type, sdp: description.sdp ?? "" };
}

function requireOpen(channel: RTCDataChannel | null): RTCDataChannel {
	if (!channel || channel.readyState !== "open") throw new Error("Remote Desktop channel is not open");
	return channel;
}

/** Browser WebRTC attachment；信令保持在已认证的 App Socket，媒体不经过 Server。 */
export function createRemoteDesktopPeer(
	socket: RemoteDesktopSocket,
	createConnection?: (configuration?: RTCConfiguration) => RTCPeerConnection,
): RemoteDesktopPeer {
	const create = createConnection ?? ((configuration?: RTCConfiguration) => {
			const peerConnectionConstructor =
				typeof window !== "undefined" ? window.RTCPeerConnection : undefined;
			if (!peerConnectionConstructor) throw new Error("WebRTC is unavailable in this browser");
			return new peerConnectionConstructor(configuration);
		});
	let connection: RTCPeerConnection | null = null;
	let sessionId: string | null = null;
	let attached: RemoteDesktopBrowserAttached | null = null;
	let control: RTCDataChannel | null = null;
	let pointer: RTCDataChannel | null = null;
	let removeSignal: (() => void) | null = null;
	let removeConnectionChange: (() => void) | null = null;
	let trackListeners = new Set<(event: RTCTrackEvent) => void>();
	let channelListeners = new Set<(channels: RemoteDesktopChannels) => void>();
	let controlMessageListeners = new Set<(message: unknown) => void>();
	const stateListeners = new Set<(state: RemoteDesktopConnectionState) => void>();
	let connectPromise: Promise<RemoteDesktopBrowserAttached> | null = null;
	let pendingCandidates: RTCIceCandidateInit[] = [];
	let state: RemoteDesktopConnectionState = {
		phase: "connecting",
		attempt: 0,
		deadline: null,
		code: null,
	};
	/** 恢复材料的当前值；每次 attach 都会拿到新的单次材料。 */
	let currentReconnectToken: string | null = null;
	let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** 防止 socket connect 事件与重试定时器并发发起两次 attach。 */
	let attachInFlight = false;
	let closed = false;

	const setState = (next: Partial<RemoteDesktopConnectionState>) => {
		state = { ...state, ...next };
		for (const listener of stateListeners) {
			try {
				listener(state);
			} catch {
				// 状态观察者不得影响连接生命周期。
			}
		}
	};

	const clearTimers = () => {
		if (deadlineTimer !== null) clearTimeout(deadlineTimer);
		if (retryTimer !== null) clearTimeout(retryTimer);
		deadlineTimer = null;
		retryTimer = null;
	};

	const notifyChannels = () => {
		for (const listener of channelListeners) listener({ control, pointer });
	};

	/**
	 * 关闭当前 PeerConnection 但保留监听与 attachment 语义。
	 *
	 * 重连必须建立全新的连接与新的单次认证材料：复用已断的 PeerConnection
	 * 既无法恢复 SCTP，也会让 Host 侧停留在旧 attachment 上。
	 */
	const teardownConnection = () => {
		const currentConnection = connection;
		const currentControl = control;
		const currentPointer = pointer;
		connection = null;
		control = null;
		pointer = null;
		pendingCandidates = [];
		try {
			currentControl?.close();
			currentPointer?.close();
		} catch {
			// 关闭已断开的通道是幂等的。
		}
		// 必须真正关闭 PeerConnection：只丢弃引用会留下仍在收集 ICE、
		// 持有编码器与连接的僵尸对象。
		try {
			currentConnection?.close();
		} catch {
			// 关闭已失败的连接是幂等的。
		}
		notifyChannels();
	};

	const sendSignal = async (targetSessionId: string, signal: RemoteDesktopSignal) => {
		if (!attached) throw new Error("Remote Desktop is not attached");
		try {
			await socket.signal(targetSessionId, attached.attachmentId, signal);
		} catch (error) {
			// 静默吞掉信令失败会让“answer 永远不来”这类问题完全不可见。
			console.error(
				`[vcpdeck] 远程桌面信令 ${signal.kind} 失败：${(error as { code?: string }).code ?? ""} ${(error as Error).message}`,
			);
			throw error;
		}
	};

	const handleControlMessage = (event: MessageEvent) => {
		if (!attached || !control || typeof event.data !== "string") return;
		try {
			const message = JSON.parse(event.data) as {
				type?: string;
				nonce?: unknown;
				attachment_id?: unknown;
			};
			for (const listener of controlMessageListeners) {
				try {
					listener(message);
				} catch {
					// A control observer must not break challenge-response handling.
				}
			}
			const nonce = message.nonce;
			if (
				message.type === "challenge" &&
				message.attachment_id === attached.attachmentId &&
				Array.isArray(nonce) &&
				nonce.length === 32 &&
				nonce.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
			) {
				control.send(
					JSON.stringify({
						type: "challenge-response",
						nonce,
						attachment_id: attached.attachmentId,
					}),
				);
			}
		} catch {
			// Ignore malformed Host messages; the Rust Host remains the authorization authority.
		}
	};

	const handleSignal = (message: {
		sessionId: string;
		attachmentId: string;
		signal: RemoteDesktopSignal;
	}) => {
		if (!attached || message.sessionId !== attached.sessionId || message.attachmentId !== attached.attachmentId) return;
		if (message.signal.kind === "ice") {
			const candidate = {
				candidate: message.signal.candidate,
				sdpMid: message.signal.sdpMid,
				sdpMLineIndex: message.signal.sdpMLineIndex,
			};
			if (!connection?.remoteDescription) {
				pendingCandidates.push(candidate);
				return;
			}
			void connection.addIceCandidate(candidate);
			return;
		}
		const description = toRtcDescription(message.signal);
		if (!description || !connection) return;
		void connection
			.setRemoteDescription(description)
			.then(async () => {
				const candidates = pendingCandidates;
				pendingCandidates = [];
				for (const candidate of candidates) await connection?.addIceCandidate(candidate);
			})
			.catch((error: unknown) => {
				// 静默吞掉失败会让 PeerConnection 永远停在 have-local-offer：
				// 既没有 answer，也没有任何可观测的错误。
				console.error(
					`[vcpdeck] 应用远端 ${description.type} 失败：${(error as Error).message}`,
				);
			});
	};

	const markConnected = () => {
		if (closed || state.phase === "connected") return;
		clearTimers();
		setState({ phase: "connected", attempt: 0, deadline: null, code: null });
	};

	/** 建立（或重建）一次 attachment 与它的 PeerConnection。 */
	const startSession = async (targetSessionId: string, token?: string) => {
		attached = await socket.attach(targetSessionId, token);
		sessionId = targetSessionId;
		currentReconnectToken = attached.reconnectToken ?? null;
		// 恢复材料只在内存与 sessionStorage 中；Server 只保存哈希。
		if (currentReconnectToken) saveReconnectToken(targetSessionId, currentReconnectToken);
		connection = create({
			iceServers: attached.iceConfig.iceServers,
		});
		// 临时诊断：把连接暴露到 window，便于在浏览器里直接读取
		// ICE 状态、候选对与 SDP 协商结果。
		connection.addTransceiver("video", { direction: "recvonly" });
		// Browser 是 offerer：DataChannel 必须由 offer 方创建，
		// 否则 offer 不会有 m=application 段，Host 侧永远无法完成通道协商。
		control = connection.createDataChannel("control-reliable", { ordered: true });
		control.onmessage = handleControlMessage;
		control.onopen = () => markConnected();
		pointer = connection.createDataChannel("pointer-realtime", {
			ordered: false,
			maxRetransmits: 0,
		});
		pointer.onopen = () => markConnected();
		notifyChannels();
		// 保留 ondatachannel：若 Host 后续主动开通道，仍按 label 绑定。
		connection.ondatachannel = (event) => {
			if (event.channel.label === "control-reliable") {
				control = event.channel;
				control.onmessage = handleControlMessage;
				control.onopen = () => markConnected();
			}
			if (event.channel.label === "pointer-realtime") {
				pointer = event.channel;
				pointer.onopen = () => markConnected();
			}
			notifyChannels();
		};
		connection.ontrack = (event) => {
			for (const listener of trackListeners) listener(event);
		};
		connection.onicecandidate = (event) => {
			if (!event.candidate) {
				void sendSignal(targetSessionId, { kind: "ice-complete" });
				return;
			}
			void sendSignal(targetSessionId, {
				kind: "ice",
				candidate: event.candidate.candidate,
				sdpMid: event.candidate.sdpMid ?? undefined,
				sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
			});
		};
		connection.onconnectionstatechange = () => {
			// 只把 `failed` 当作失败。`disconnected` 在 ICE 连通性检查期间是**瞬时**状态，
			// 规范设计上由 ICE 自行恢复；把它当失败会立即重新 attach，
			// 形成重连风暴并耗尽恢复窗口，反而把一次本可成功的连接判成 failed。
			if (connection && connection.connectionState === "failed") {
				// socket 还在，可以立即重新 attach。
				beginReconnect(true);
			}
		};
		const offer = await connection.createOffer();
		await connection.setLocalDescription(offer);
		await sendSignal(targetSessionId, toSignal(offer));
		return attached;
	};

	const scheduleDeadline = () => {
		if (deadlineTimer !== null) clearTimeout(deadlineTimer);
		const remaining = (state.deadline ?? 0) - Date.now();
		deadlineTimer = setTimeout(() => {
			if (state.phase === "reconnecting") {
				setState({ phase: "failed", code: RECONNECT_TIMEOUT_CODE, deadline: null });
			}
		}, Math.max(0, remaining));
	};

	const attemptReconnect = async () => {
		if (closed || state.phase !== "reconnecting" || !sessionId) return;
		// 并发发起两次 attach 会拿到两个 attachment，并让其中一个永远无人使用。
		if (attachInFlight) return;
		if ((state.deadline ?? 0) <= Date.now()) {
			setState({ phase: "failed", code: RECONNECT_TIMEOUT_CODE, deadline: null });
			return;
		}
		attachInFlight = true;
		try {
			await startSession(sessionId, currentReconnectToken ?? undefined);
		} catch {
			if (closed || state.phase !== "reconnecting") return;
			// 窗口内继续重试；窗口耗尽由 deadline 定时器统一判定。
			retryTimer = setTimeout(() => void attemptReconnect(), RECONNECT_RETRY_MS);
		} finally {
			attachInFlight = false;
		}
	};

	/**
	 * 进入恢复流程：丢弃旧连接，只保留监听与最后一帧画面。
	 *
	 * `immediate` 区分两种触发：socket 断开时必须等 `connect` 事件再重试，
	 * 而 ICE 失败时 socket 仍然可用，可以（也应该）立即重新 attach。
	 */
	const beginReconnect = (immediate: boolean) => {
		if (closed || state.phase === "closed" || state.phase === "failed") return;
		if (state.phase === "reconnecting") return;
		teardownConnection();
		setState({
			phase: "reconnecting",
			attempt: state.attempt + 1,
			deadline: Date.now() + RECONNECT_WINDOW_MS,
			code: null,
		});
		scheduleDeadline();
		if (immediate && socket.isConnected()) void attemptReconnect();
	};

	const connect = (requestedSessionId: string, reconnectToken?: string) => {		if (connectPromise) return connectPromise;
		closed = false;
		sessionId = requestedSessionId;
		setState({ phase: "connecting", attempt: 0, deadline: null, code: null });
		const token = reconnectToken ?? loadReconnectToken(requestedSessionId) ?? undefined;
		connectPromise = startSession(requestedSessionId, token)
			.then((result) => {
				removeSignal = socket.onSignal(handleSignal);
				removeConnectionChange = socket.onConnectionChange((connected) => {
					if (closed) return;
					if (connected) {
						if (state.phase === "reconnecting") void attemptReconnect();
					} else {
						beginReconnect(false);
					}
				});
				return result;
			})
			.catch((error) => {
				connectPromise = null;
				sessionId = null;
				throw error;
			});
		return connectPromise;
	};

	return {
		connect,
		state: () => state,
		onStateChange: (callback) => {
			stateListeners.add(callback);
			return () => stateListeners.delete(callback);
		},
		channels: () => ({ control, pointer }),
		onChannels: (callback) => {
			channelListeners.add(callback);
			return () => channelListeners.delete(callback);
		},
		onTrack: (callback) => {
			trackListeners.add(callback);
			return () => trackListeners.delete(callback);
		},
		onControlMessage: (callback) => {
			controlMessageListeners.add(callback);
			return () => controlMessageListeners.delete(callback);
		},
		sendControl: (message) => {
			requireOpen(control).send(JSON.stringify(message));
		},
		sendPointer: (message) => {
			requireOpen(pointer).send(JSON.stringify(message));
		},
		stats: async () => {
			if (!connection) return null;
			try {
				const report = await connection.getStats();
				return summarizeConnectionStats(report.values());
			} catch {
				// 统计失败不能让界面报错，也不能凭空编造路径。
				return null;
			}
		},
		retry: async () => {
			if (closed) throw new Error("Remote Desktop session is closed");
			if (!sessionId) throw new Error("Remote Desktop is not attached");
			// 复用旧连接毫无意义：断开的 PeerConnection 无法恢复 SCTP。
			teardownConnection();
			clearTimers();
			setState({ phase: "connecting", attempt: 0, deadline: null, code: null });
			return startSession(sessionId, currentReconnectToken ?? undefined);
		},
		close: async () => {
			closed = true;
			clearTimers();
			if (sessionId) clearReconnectToken(sessionId);
			removeSignal?.();
			removeSignal = null;
			removeConnectionChange?.();
			removeConnectionChange = null;
			const currentConnection = connection;
			const currentAttachment = attached;
			const currentSession = sessionId;
			connection = null;
			attached = null;
			control = null;
			pointer = null;
			trackListeners = new Set();
			connectPromise = null;
			sessionId = null;
			pendingCandidates = [];
			channelListeners = new Set();
			controlMessageListeners = new Set();
			currentReconnectToken = null;
			setState({ phase: "closed", attempt: 0, deadline: null, code: null });
			currentConnection?.close();
			if (currentAttachment && currentSession) await socket.detach(currentSession, currentAttachment.attachmentId);
		},
	};
}
