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
	/** 数据面失败原因码（打开后）；无失败为 null。供调用方取具体错误。 */
	failureCode: string | null;
	selectedPath: () => Promise<TunnelPath>;
	close: () => Promise<void>;
}

export interface OpenBrowserTunnelOptions {
	socket: Socket;
	session: TunnelSessionCreated;
	/** 强制 TURN 中继；默认 false（直连优先、允许中继兜底）。 */
	relayOnly?: boolean;
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
	const { socket, session } = options;
	const relayOnly = options.relayOnly ?? false;
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

	let closed = false; // 传输通道（channel/peer）已拆除
	let settled = false; // open 已 resolve/reject → 摘除 socket 监听
	let opened = false;
	let failureCode: string | null = null; // 权威失败码（Server TUNNEL_STATE 优先），粘滞可被覆盖
	const finalizeTransport = (): void => {
		if (closed) return;
		closed = true;
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
	const detach = (): void => {
		if (!settled) {
			settled = true;
			removeListeners();
		}
	};
	// 权威终止：由 Server 的 TUNNEL_STATE/TUNNEL_CLOSE 决定最终错误码；本地通道错误不抢先判定，
	// 避免快速失败目标端口时本地 onerror 抢在 TUNNEL_STATE 之前把错误码定成通用 TUNNEL_CLOSED。
	const settleFailure = (code?: string): void => {
		if (code) failureCode = code;
		finalizeTransport();
		detach();
		if (!opened) openReject(Object.assign(new Error("隧道关闭/失败"), { code: failureCode ?? "TUNNEL_CLOSED" }));
	};

	let openResolve = (): void => {};
	let openReject = (_e: unknown): void => {};
	const open = new Promise<void>((resolve, reject) => {
		openResolve = resolve;
		openReject = (e: unknown) => reject(e as never);
	});

	// [tdiag] 临时：观察 ICE/连接状态定位 P2P 是否建立
	peer.onconnectionstatechange = () => console.log(`[tdiag] connectionstate=${peer.connectionState}`);
	peer.oniceconnectionstatechange = () => console.log(`[tdiag] ice=${peer.iceConnectionState} iceGathering=${peer.iceGatheringState}`);
	peer.onicegatheringstatechange = () => console.log(`[tdiag] iceGathering=${peer.iceGatheringState}`);

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

	// Server → 本端权威状态/关闭
	on(Events.TUNNEL_STATE, (raw) => {
		let state;
		try {
			state = parseTunnelClientState(raw);
		} catch {
			return;
		}
		if (state.sessionId !== session.sessionId) return;
		if (state.state === "failed" || state.state === "closed") settleFailure(state.code);
	});
	on(Events.TUNNEL_CLOSE, (raw) => {
		let c;
		try {
			c = parseTunnelClose(raw);
		} catch {
			return;
		}
		if (c.sessionId === session.sessionId) settleFailure();
	});
	on("disconnect", () => settleFailure());

	// attach（不阻塞 open；ack 失败则清理并拒绝）
	socket.emit(Events.TUNNEL_ATTACH, { sessionId: session.sessionId }, (rawAck?: unknown) => {
		const ack = rawAck as { ok?: boolean; error?: { code?: string } } | undefined;
		if (ack && ack.ok === false && !settled) {
			failureCode = ack.error?.code ?? null;
			finalizeTransport();
			detach();
			openReject(Object.assign(new Error("attach 被拒绝"), { code: ack.error?.code ?? "TUNNEL_ATTACH_FAILED" }));
		}
	});

	// DataChannel open / error
	// open 成功不摘除权威监听：通道建立后目标 TCP 仍可能失效，需保留 TUNNEL_STATE/TUNNEL_CLOSE
	// 以便拿到具体错误码（否则快速失败端口时会在 onopen 后丢失 Server 上报的 code）。
	channel.onopen = () => {
		if (!opened && !settled) {
			opened = true;
			openResolve();
		}
	};
	// 本地通道错误/断开：只拆传输通道，不判定最终错误码——等 Server 权威 TUNNEL_STATE 或 open 超时。
	channel.onerror = () => {
		finalizeTransport();
	};
	const openTimer = setTimeout(() => {
		if (!settled) {
			finalizeTransport();
			detach();
			if (!opened) openReject(Object.assign(new Error("隧道 open 超时"), { code: failureCode ?? "TUNNEL_OPEN_TIMEOUT" }));
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
		// 读取时取当前值；权威 TUNNEL_STATE failed 会在 settleFailure 内写入具体 code
		get failureCode() {
			return failureCode;
		},
		selectedPath: () => classifySelectedPath(peer),
		close: async () => {
			clearTimeout(openTimer);
			finalizeTransport();
			detach();
			if (!opened) openReject(Object.assign(new Error("隧道已关闭"), { code: failureCode ?? "TUNNEL_CLOSED" }));
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
	if (!pair) { console.log(`[dt] classify -> unknown (no pair)`); return "unknown"; }
	const local = reports.find((r) => r.id === pair.localCandidateId);
	const remote = reports.find((r) => r.id === pair.remoteCandidateId);
	const types = [local?.candidateType, remote?.candidateType].filter((t): t is string => typeof t === "string");
	if (types.includes("relay")) return "relay";
	if (types.some((t) => t === "host" || t === "srflx" || t === "prflx")) return "direct";
	return "unknown";
}

function collectReports(stats: unknown): Array<Record<string, unknown>> {
	// 注意：getStats() 返回的 Map 可能来自跨 realm，`instanceof Map` 不可靠；
	// 改用结构化探测（存在 .values() 即视为 Map 迭代对象），兼容 Map 与普通对象两种形态。
	const s = stats as { values?: () => IterableIterator<unknown> } | null;
	if (s && typeof s.values === "function") {
		return [...s.values()] as Array<Record<string, unknown>>;
	}
	if (stats && typeof stats === "object") return Object.values(stats as Record<string, unknown>) as Array<Record<string, unknown>>;
	return [];
}
