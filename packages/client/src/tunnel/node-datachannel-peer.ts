import { P2P_TUNNEL_PROTOCOL_VERSION, type P2pTunnelCapabilityStatus, type TunnelIceServer } from "@vcpdeck/shared";
import type { TunnelDataChannel, TunnelPeer } from "./tunnel-bridge.js";

/**
 * 真实 native 适配器：封装 `node-datachannel/polyfill`，让 Client 侧 WebRTC API
 * 与 Browser 对齐（answerer 端）。polyfill 延迟加载，未构建/加载失败返回 null。
 * 本模块顶部不 import native，因此单元测试无需加载 native binding。
 */

type NativePeerConnection = {
	setRemoteDescription(d: unknown): Promise<void>;
	setLocalDescription(d: unknown): Promise<void>;
	createAnswer(): Promise<{ type?: string; sdp?: string } | null>;
	addIceCandidate(c: unknown): Promise<void>;
	close(): void;
};

type NativePolyfill = {
	RTCPeerConnection: new (config?: unknown) => NativePeerConnection;
};

// 用变量名引用 native 模块：tsc 不尝试解析其 d.ts（skipLibCheck 下也稳妥），运行时按字面量加载。
const NATIVE_POLYFILL_SPEC = "node-datachannel/polyfill";

let cached: NativePolyfill | null = null;
let loadPromise: Promise<NativePolyfill | null> | null = null;

/** 延迟加载 native polyfill；失败返回 null（可重试）。 */
function loadPolyfill(): Promise<NativePolyfill | null> {
	if (cached) return Promise.resolve(cached);
	if (!loadPromise) {
		loadPromise = import(NATIVE_POLYFILL_SPEC as string)
			.then((mod: unknown) => {
				const m = mod as { RTCPeerConnection?: unknown };
				if (typeof m.RTCPeerConnection === "function") {
					cached = { RTCPeerConnection: m.RTCPeerConnection as never };
					return cached;
				}
				return null;
			})
			.catch(() => null);
	}
	return loadPromise;
}

function currentPolyfill(): NativePolyfill | null {
	return cached;
}

/**
 * 探测 P2P native 后端可用性（加载失败 → available:false + 稳定 code）。
 * @returns 供 register 上报的能力摘要；仅含脱敏字段。
 */
export async function probeP2pBackend(): Promise<P2pTunnelCapabilityStatus> {
	const ok = await loadPolyfill();
	if (ok) {
		return { available: true, protocolVersion: P2P_TUNNEL_PROTOCOL_VERSION };
	}
	return {
		available: false,
		protocolVersion: P2P_TUNNEL_PROTOCOL_VERSION,
		code: "P2P_NATIVE_BACKEND_UNAVAILABLE",
	};
}

/**
 * 创建 answerer PeerConnection（native 未加载返回 null）。
 * 只连接固定回环目标；ICE 配置来自 Server 下发的短期凭据。
 */
export function createNodeDataChannelPeer(iceServers: TunnelIceServer[]): TunnelPeer | null {
	const polyfill = currentPolyfill();
	if (!polyfill) return null;

	// native 构造：iceServers 与 shared TunnelIceServer 结构一致（urls/username/credential）。
	const pc = new polyfill.RTCPeerConnection({ iceServers });

	const peer: TunnelPeer = {
		setRemoteDescription: (d) => pc.setRemoteDescription(d as never),
		setLocalDescription: (d) => pc.setLocalDescription(d as never),
		createAnswer: async () => {
			const a = (await pc.createAnswer()) as { type?: string; sdp?: string } | null;
			return { type: "answer", sdp: a?.sdp ?? "" };
		},
		addIceCandidate: async (c) => {
			await pc.addIceCandidate(c as never);
		},
		close: () => {
			try {
				pc.close();
			} catch {
				// 忽略
			}
		},
		ondatachannel: null,
		onicecandidate: null,
	};

	// native 事件 → adapter 回调：onicecandidate 转成 { candidate, sdpMid } 形状，过滤占位 candidate。
	const pcAny = pc as unknown as {
		ondatachannel: ((ev: { channel: unknown }) => void) | null;
		onicecandidate: ((ev: { candidate: { candidate?: string; sdpMid?: string | null } | null }) => void) | null;
	};
	pcAny.ondatachannel = (ev: { channel: unknown }) => {
		const handler = peer.ondatachannel;
		handler?.({ channel: ev.channel as TunnelDataChannel });
	};
	pcAny.onicecandidate = (ev: { candidate: { candidate?: string; sdpMid?: string | null } | null }) => {
		const raw = ev.candidate;
		const handler = peer.onicecandidate;
		if (handler && raw && typeof raw.candidate === "string" && raw.candidate.length > 0 && raw.candidate !== "candidate:") {
			handler({
				candidate: {
					candidate: raw.candidate,
					sdpMid: typeof raw.sdpMid === "string" ? raw.sdpMid : "",
				},
			});
		}
	};

	return peer;
}
