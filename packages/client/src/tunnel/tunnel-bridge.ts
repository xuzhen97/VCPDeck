import {
	Events,
	P2P_TUNNEL_PROTOCOL_VERSION,
	parseTunnelBrowserSignal,
	parseTunnelClose,
	parseTunnelPrepare,
	type TunnelIceServer,
	type TunnelSignal,
} from "@vcpdeck/shared";

/** 回环 TCP 目标；bridge 固定 host 为 127.0.0.1，只透传端口。 */
export interface TunnelTcpTarget {
	host: string;
	port: number;
}
import type { Socket } from "socket.io-client";

/** DataChannel 分片大小：TCP→DataChannel 大 chunk 切分为最多 16 KiB 二进制消息。 */
const CHUNK_BYTES = 16 * 1024;
/** DataChannel 高水位：bufferedAmount ≥ 1 MiB 时暂停 TCP 读取。 */
const HIGH_WATER_BYTES = 1024 * 1024;
/** DataChannel 低水位：onbufferedamountlow 恢复 TCP（browser 侧阈值设为 256 KiB）。 */
const LOW_WATER_BYTES = 256 * 1024;
/** DataChannel→TCP 回压上限：pending 超过 1 MiB 关闭 Session，禁止丢包。 */
const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;

/** 最小 DataChannel 接口：与 Browser WebRTC 与 node-datachannel polyfill 对齐。 */
export interface TunnelDataChannel {
	send(data: Uint8Array): void;
	close(): void;
	readonly bufferedAmount: number;
	bufferedAmountLowThreshold: number;
	onopen: (() => void) | null;
	onmessage: ((event: { data: ArrayBuffer | Uint8Array }) => void) | null;
	onclose: (() => void) | null;
	onerror: ((event?: unknown) => void) | null;
	onbufferedamountlow: (() => void) | null;
}

/** 最小 answerer 端 PeerConnection 接口（Client 只应答，不发起 offer）。 */
export interface TunnelPeer {
	setRemoteDescription(desc: { type: "offer"; sdp: string }): Promise<void>;
	setLocalDescription(desc: { type: "answer"; sdp: string }): Promise<void>;
	createAnswer(): Promise<{ type: "answer"; sdp: string }>;
	addIceCandidate(candidate: { candidate: string; sdpMid: string }): Promise<void>;
	close(): void;
	ondatachannel: ((event: { channel: TunnelDataChannel }) => void) | null;
	onicecandidate: ((event: { candidate: { candidate: string; sdpMid: string } | null }) => void) | null;
}

/** 最小回环 TCP socket 接口（node:net.Socket 天然满足；测试注入 fake）。 */
export interface TunnelTcpSocket {
	write(data: Uint8Array, cb?: () => void): boolean;
	pause(): void;
	resume(): void;
	end(): void;
	destroy(): void;
	on(event: "data", cb: (chunk: Uint8Array) => void): unknown;
	on(event: "drain", cb: () => void): unknown;
	on(event: "error", cb: (err: { code?: string }) => void): unknown;
	on(event: "close", cb: () => void): unknown;
}

export interface TunnelBridgeDeps {
	clientId: string;
	/** 创建 answerer Peer；native 加载失败返回 null（不上报能力）。 */
	createPeer: (iceServers: TunnelIceServer[]) => TunnelPeer | null;
	/** 建立固定回环 TCP 连接；host 由 bridge 固定为 127.0.0.1。 */
	createTcp: (target: TunnelTcpTarget) => TunnelTcpSocket;
	/** 精确 emit 到 Server（socket lease）；生产绑定 socket.emit。 */
	emit: (event: string, payload: unknown) => void;
}

/** 可测试的 P2P 隧道桥：Session 生命周期 + 信令 + 回环 TCP 数据泵。 */
export interface TunnelBridge {
	receivePrepare(p: { sessionId: string; targetPort: number; iceServers: TunnelIceServer[] }): void;
	receiveSignal(signal: TunnelSignal): void;
	receiveClose(sessionId: string): void;
	dispose(): void;
	readonly protocolVersion: number;
}

interface Session {
	sessionId: string;
	targetPort: number;
	peer: TunnelPeer;
	remoteSet: boolean;
	queuedCandidates: { candidate: string; sdpMid: string }[];
	channel: TunnelDataChannel | null;
	tcp: TunnelTcpSocket | null;
	paused: boolean;
	outbacklog: number;
	closed: boolean;
	terminal: boolean;
}

function toBuffer(data: ArrayBuffer | Uint8Array): Buffer {
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function createTunnelBridge(deps: TunnelBridgeDeps): TunnelBridge {
	const sessions = new Map<string, Session>();

	function emitState(sessionId: string, state: "connected" | "failed" | "closed", code?: string): void {
		deps.emit(Events.TUNNEL_STATE, code ? { sessionId, state, code } : { sessionId, state });
	}

	function emitSignal(sessionId: string, signal: TunnelSignal): void {
		deps.emit(Events.TUNNEL_SIGNAL, signal);
	}

	function wireChannel(s: Session, channel: TunnelDataChannel): void {
		if (s.closed) {
			try {
				channel.close();
			} catch {
				// 忽略
			}
			return;
		}
		s.channel = channel;
		channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;

		let tcp: TunnelTcpSocket;
		try {
			// 固定回环目标：只允许连本机 targetPort，禁止任意主机或局域网扫描。
			tcp = deps.createTcp({ host: "127.0.0.1", port: s.targetPort });
		} catch {
			targetTerminated(s, "TUNNEL_TARGET_REFUSED");
			return;
		}
		s.tcp = tcp;

		channel.onopen = () => {
			if (!s.closed) emitState(s.sessionId, "connected");
		};
		channel.onclose = () => closeSession(s.sessionId);
		channel.onerror = () => fail(s.sessionId, "TUNNEL_DATA_ERROR");
		channel.onbufferedamountlow = () => {
			if (s.paused && s.tcp && !s.closed) {
				s.paused = false;
				s.tcp.resume();
			}
		};

		// DataChannel → TCP：write 返回 false 时累计回压，超限关闭（不丢包）。
		channel.onmessage = ({ data }) => {
			if (s.closed) return;
			const buf = toBuffer(data);
			console.log(`[cbr] dc→tcp ${buf.byteLength}B asc=${JSON.stringify(buf.toString().replace(/[^\x20-\x7e]/g, ".").slice(0, 12))}`);
			let ok: boolean;
			try {
				ok = tcp.write(buf);
			} catch {
				// TCP 已销毁：目标终止后的写失败属预期，仅停止接收；仅当目标未终止时才整体拆除
				if (!s.terminal) closeSession(s.sessionId);
				return;
			}
			if (!ok) s.outbacklog += buf.byteLength;
			if (s.outbacklog > BACKPRESSURE_LIMIT_BYTES) {
				fail(s.sessionId, "TUNNEL_BACKPRESSURE_LIMIT");
			}
		};

		// TCP → DataChannel：大 chunk 切 16 KiB；bufferedAmount 高水位暂停，低水位恢复。
		tcp.on("data", (chunk) => {
			if (s.closed || s.paused) return;
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			console.log(`[cbr] tcp→dc ${buf.length}B asc=${JSON.stringify(buf.toString().replace(/[^\x20-\x7e]/g, ".").slice(0, 12))}`);
			if (channel.bufferedAmount >= HIGH_WATER_BYTES) {
				s.paused = true;
				tcp.pause();
				return;
			}
			// 对端 DataChannel 可能在数据流传输中关闭（浏览器断开 / 会话被回收）；
			// send() 在已关闭通道上会同步抛错 → 捕获并清理，避免拖垮整个 Client 进程。
			try {
				for (let off = 0; off < buf.length; off += CHUNK_BYTES) {
					channel.send(buf.subarray(off, off + CHUNK_BYTES) as Uint8Array);
				}
			} catch {
				closeSession(s.sessionId);
			}
		});
		tcp.on("drain", () => {
			s.outbacklog = 0;
		});
		tcp.on("error", (err) => {
			const code = err?.code === "ECONNREFUSED" ? "TUNNEL_TARGET_REFUSED" : "TUNNEL_TCP_ERROR";
			targetTerminated(s, code);
		});
		tcp.on("close", () => targetTerminated(s));
	}

	function closeTarget(s: Session): void {
		try {
			s.tcp?.end();
			s.tcp?.destroy();
		} catch {
			// 忽略
		}
	}

	// 目标 TCP 终止（被拒绝 / 报错 / 目标主动关闭 / 回压）：
	// 只上报权威状态 + 拆目标 TCP；WebRTC 通道保留，由 Server 的 TUNNEL_CLOSE 统一关闭，
	// 确保 Browser 先拿到具体错误码（TUNNEL_STATE）再感知到通道拆除（否则快速失败端口时会竞态）。
	function targetTerminated(s: Session, code?: string): void {
		if (s.closed || s.terminal) return;
		s.terminal = true;
		if (code) emitState(s.sessionId, "failed", code);
		else emitState(s.sessionId, "closed");
		closeTarget(s);
	}

	function closeSession(sessionId: string): void {
		const s = sessions.get(sessionId);
		if (!s || s.closed) return;
		s.closed = true;
		try {
			s.peer.close();
		} catch {
			// 忽略
		}
		try {
			s.channel?.close();
		} catch {
			// 忽略
		}
		closeTarget(s);
		sessions.delete(sessionId);
	}

	// WebRTC 数据通道层面故障（通道自身错误）：整体拆除会话。
	function fail(sessionId: string, code: string): void {
		emitState(sessionId, "failed", code);
		closeSession(sessionId);
	}

	const bridge: TunnelBridge = {
		protocolVersion: P2P_TUNNEL_PROTOCOL_VERSION,
		receivePrepare(p) {
			const existing = sessions.get(p.sessionId);
			if (existing) closeSession(p.sessionId);
			const peer = deps.createPeer(p.iceServers);
			if (!peer) {
				// native 后端不可用：明确上报，不建立数据面。
				emitState(p.sessionId, "failed", "P2P_NATIVE_BACKEND_UNAVAILABLE");
				return;
			}
			const s: Session = {
				sessionId: p.sessionId,
				targetPort: p.targetPort,
				peer,
				remoteSet: false,
				queuedCandidates: [],
				channel: null,
				tcp: null,
				paused: false,
				outbacklog: 0,
				closed: false,
				terminal: false,
			};
			sessions.set(p.sessionId, s);
			peer.onicecandidate = (e) => {
				if (!s.closed && e.candidate) {
					emitSignal(p.sessionId, { sessionId: p.sessionId, candidate: e.candidate });
				}
			};
			peer.ondatachannel = (e) => wireChannel(s, e.channel);
		},

		receiveSignal(signal) {
			const s = sessions.get(signal.sessionId);
			if (!s || s.closed) return;
			if ("description" in signal) {
				// 客户端是 answerer：入站信令由 parseTunnelBrowserSignal(role=offer) 保证只能是 offer。
				const offer = signal.description as { type: "offer"; sdp: string };
				void s.peer
					.setRemoteDescription(offer)
					.then(async () => {
						s.remoteSet = true;
						const answer = await s.peer.createAnswer();
						await s.peer.setLocalDescription(answer);
						emitSignal(s.sessionId, { sessionId: s.sessionId, description: answer });
						for (const c of s.queuedCandidates) {
							try {
								await s.peer.addIceCandidate(c);
							} catch {
								// 单个 candidate 失败不中断
							}
						}
						s.queuedCandidates = [];
					})
					.catch(() => fail(s.sessionId, "TUNNEL_SIGNAL_FAILED"));
			} else {
				const c = signal.candidate;
				if (!s.remoteSet) {
					s.queuedCandidates.push(c);
					return;
				}
				void s.peer.addIceCandidate(c).catch(() => {
					// 单个 candidate 失败不中断
				});
			}
		},

		receiveClose(sessionId) {
			closeSession(sessionId);
		},

		dispose() {
			for (const id of [...sessions.keys()]) closeSession(id);
			sessions.clear();
		},
	};

	return bridge;
}

/**
 * 把 P2P 隧道桥挂到 /client socket：绑定 PREPARE/SIGNAL/CLOSE/disconnect。
 * 入站信令按 Browser 方向解析（Client 是 answerer）。返回 bridge 供 dispose。
 */
export function attachTunnelBridge(socket: Socket, deps: Omit<TunnelBridgeDeps, "emit">): TunnelBridge {
	const emit = (event: string, payload: unknown): void => {
		if (socket.connected) socket.emit(event, payload);
	};
	const bridge = createTunnelBridge({ ...deps, emit });

	socket.on(Events.TUNNEL_PREPARE, (raw: unknown) => {
		try {
			const p = parseTunnelPrepare(raw);
			if (p.clientId !== deps.clientId) return; // 身份绑定
			bridge.receivePrepare({ sessionId: p.sessionId, targetPort: p.targetPort, iceServers: p.iceServers });
		} catch {
			// 非法 payload 忽略
		}
	});

	socket.on(Events.TUNNEL_SIGNAL, (raw: unknown) => {
		try {
			bridge.receiveSignal(parseTunnelBrowserSignal(raw));
		} catch {
			// 非法 payload 忽略
		}
	});

	socket.on(Events.TUNNEL_CLOSE, (raw: unknown) => {
		try {
			bridge.receiveClose(parseTunnelClose(raw).sessionId);
		} catch {
			// 非法 payload 忽略
		}
	});

	socket.on("disconnect", () => bridge.dispose());

	return bridge;
}
