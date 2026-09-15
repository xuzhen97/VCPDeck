import {
	Events,
	parseTunnelClientSignal,
	parseTunnelClientState,
	parseTunnelClose,
	type TunnelSessionCreated,
} from "@vcpdeck/shared";
import type { Socket } from "socket.io-client";

/** 已选 ICE 路径类型（脱敏，不暴露 address/ip）。 */
export type TunnelPath = "direct" | "relay" | "unknown";

/** 已建立的浏览器 P2P 隧道：可靠有序 DataChannel + Peer + 路径识别 + 关闭。 */
export interface BrowserTunnel {
	channel: RTCDataChannel;
	peer: RTCPeerConnection;
	selectedPath: () => Promise<TunnelPath>;
	close: () => Promise<void>;
}

export interface OpenBrowserTunnelOptions {
	socket: Socket;
	session: TunnelSessionCreated;
	relayOnly: boolean;
	/** 注入用于测试；默认用浏览器 RTCPeerConnection。 */
	createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
	/** open 超时（默认 15s）。 */
	openTimeoutMs?: number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const CHANNEL_LABEL = "vcpdeck-tcp";

/**
 * 建立浏览器端 P2P 隧道：attach → 创建可靠有序 DataChannel → 发送 offer/trickle candidate
 * → 应用 answer（answer 前收到的 candidate 排队）→ 等待 channel open（超时/失败清理）。
 * 只处理当前 sessionId；close() 移除所有 socket listener 并关闭 channel/peer。
 */
export async function openBrowserTunnel(options: OpenBrowserTunnelOptions): Promise<BrowserTunnel> {
	const { socket, session, relayOnly } = options;
	const createPeer = options.createPeer ?? ((cfg: RTCConfiguration) => new RTCPeerConnection(cfg));

	const handlers: Array<{ event: string; handler: (...a: unknown[]) => void }> = [];
	const on = (event: string, handler: (...a: unknown[]) => void): void => {
		socket.on(event as never, handler as never);
		handlers.push({ event, handler: handler as never });
	};
	const removeListeners = (): void => {
		for (const { event, handler } of handlers) socket.off(event as never, handler as never);
	};

	const peer = createPeer({
		iceServers: session.iceServers,
		iceTransportPolicy: relayOnly ? "relay" : "all",
	});
	const channel = peer.createDataChannel(CHANNEL_LABEL, { ordered: true });

	let closed = false;
	let opened = false;
	const teardown = (): void => {
		removeListeners();
		try {
			channel.close();
		} catch {
			/* 忽略 */
		}
		try {
			peer.close();
		} catch {
			/* 忽略 */
		}
	};
	const cleanup = (): void => {
		if (closed) return;
		closed = true;
		teardown();
		if (!opened) openReject(Object.assign(new Error("隧道已关闭"), { code: "TUNNEL_CLOSED" }));
	};

	let openResolve = (): void => {};
	let openReject = (_e: unknown): void => {};
	const open = new Promise<void>((resolve, reject) => {
		openResolve = resolve;
		openReject = (e: unknown) => reject(e as never);
	});

	// 本端 trickle candidate → Server（过滤占位 candidate）
	peer.onicecandidate = (e) => {
		const raw = e.candidate as { candidate?: string; sdpMid?: string | null; toJSON?: () => unknown } | null;
		if (!raw) return;
		let candidate = "";
		let sdpMid = "";
		if (typeof raw.toJSON === "function") {
			const init = raw.toJSON() as { candidate?: string; sdpMid?: string | null };
			candidate = init.candidate ?? "";
			sdpMid = typeof init.sdpMid === "string" ? init.sdpMid : "";
		} else {
			candidate = raw.candidate ?? "";
			sdpMid = typeof raw.sdpMid === "string" ? raw.sdpMid : "";
		}
		if (candidate && candidate !== "candidate:") {
			socket.emit(Events.TUNNEL_SIGNAL, {
				sessionId: session.sessionId,
				candidate: { candidate, sdpMid },
			});
		}
	};

	// Server → 本端信令：answer 应用后补发排队 candidate；远端 candidate 早于 answer 时暂存。
	let remoteSet = false;
	const queuedCandidates: { candidate: string; sdpMid: string }[] = [];
	on(Events.TUNNEL_SIGNAL, (raw) => {
		let signal;
		try {
			signal = parseTunnelClientSignal(raw);
		} catch {
			return;
		}
		if (signal.sessionId !== session.sessionId || closed) return;
		if ("description" in signal) {
			if (signal.description.type !== "answer") return; // 本端是 offerer
			void peer
				.setRemoteDescription(signal.description as RTCSessionDescriptionInit)
				.then(async () => {
					remoteSet = true;
					for (const c of queuedCandidates) {
						try {
							await peer.addIceCandidate(c as RTCIceCandidateInit);
						} catch {
							/* 忽略单个失败 */
						}
					}
					queuedCandidates.length = 0;
				})
				.catch(() => {
					/* 忽略 */
				});
		} else {
			const c = signal.candidate;
			if (remoteSet) {
				void peer.addIceCandidate(c as RTCIceCandidateInit).catch(() => {
					/* 忽略单个失败 */
				});
			} else {
				queuedCandidates.push(c);
			}
		}
	});

	// Server → 本端状态/关闭（幂等清理）
	on(Events.TUNNEL_STATE, (raw) => {
		let state;
		try {
			state = parseTunnelClientState(raw);
		} catch {
			return;
		}
		if (state.sessionId !== session.sessionId) return;
		if (state.state === "failed" || state.state === "closed") cleanup();
	});
	on(Events.TUNNEL_CLOSE, (raw) => {
		let c;
		try {
			c = parseTunnelClose(raw);
		} catch {
			return;
		}
		if (c.sessionId === session.sessionId) cleanup();
	});
	on("disconnect", () => cleanup());

	// attach（不阻塞 open；ack 失败则清理并拒绝）
	socket.emit(Events.TUNNEL_ATTACH, { sessionId: session.sessionId }, (rawAck?: unknown) => {
		const ack = rawAck as { ok?: boolean; error?: { code?: string } } | undefined;
		if (ack && ack.ok === false && !closed) {
			closed = true;
			teardown();
			openReject(Object.assign(new Error("attach 被拒绝"), { code: ack.error?.code ?? "TUNNEL_ATTACH_FAILED" }));
		}
	});

	// DataChannel open / error
	channel.onopen = () => {
		if (!closed) {
			opened = true;
			openResolve();
		}
	};
	channel.onerror = () => {
		if (!closed) {
			cleanup();
			openReject(Object.assign(new Error("数据通道错误"), { code: "TUNNEL_DATA_ERROR" }));
		}
	};
	const openTimer = setTimeout(() => {
		if (!closed) {
			cleanup();
			openReject(Object.assign(new Error("隧道 open 超时"), { code: "TUNNEL_OPEN_TIMEOUT" }));
		}
	}, options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
	((openTimer as unknown) as { unref?: () => void }).unref?.();

	// 发送 offer
	const offer = (await peer.createOffer()) as { sdp?: string; type?: string };
	await peer.setLocalDescription(offer as RTCSessionDescriptionInit);
	socket.emit(Events.TUNNEL_SIGNAL, {
		sessionId: session.sessionId,
		description: { type: "offer", sdp: offer.sdp ?? "" },
	});

	await open;
	clearTimeout(openTimer);

	return {
		channel,
		peer,
		selectedPath: () => classifySelectedPath(peer),
		close: async () => {
			clearTimeout(openTimer);
			cleanup();
		},
	};
}

/** 遍历 getStats 的 selected candidate-pair，按 candidateType 分类路径；无法确认返回 unknown。 */
export async function classifySelectedPath(input: unknown): Promise<TunnelPath> {
	let stats: unknown;
	const maybePeer = input as { getStats?: () => Promise<unknown> } | null;
	if (maybePeer && typeof maybePeer.getStats === "function") {
		try {
			stats = await maybePeer.getStats();
		} catch {
			return "unknown";
		}
	} else {
		stats = input;
	}

	const reports = collectReports(stats);
	const pair = reports.find((r) => r.type === "candidate-pair" && (r.state === "succeeded" || r.nominated === true));
	if (!pair) return "unknown";
	const local = reports.find((r) => r.id === pair.localCandidateId);
	const remote = reports.find((r) => r.id === pair.remoteCandidateId);
	const types = [local?.candidateType, remote?.candidateType].filter((t): t is string => typeof t === "string");
	if (types.includes("relay")) return "relay";
	if (types.some((t) => t === "host" || t === "srflx" || t === "prflx")) return "direct";
	return "unknown";
}

function collectReports(stats: unknown): Array<Record<string, unknown>> {
	if (stats instanceof Map) return [...stats.values()] as Array<Record<string, unknown>>;
	if (stats && typeof stats === "object") return Object.values(stats as Record<string, unknown>) as Array<Record<string, unknown>>;
	return [];
}
