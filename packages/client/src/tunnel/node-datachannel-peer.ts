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

/** node-datachannel 原生 ICE server 结构；凭据为独立字段，不经过 URL 拼接。 */
export interface NativeIceServer {
	hostname: string;
	port: number;
	username?: string;
	password?: string;
	relayType?: "TurnUdp" | "TurnTcp" | "TurnTls";
}

type NativeModule = {
	PeerConnection: new (name: string, config: { iceServers: NativeIceServer[] }) => unknown;
};

// 用变量名引用 native 模块：tsc 不尝试解析其 d.ts（skipLibCheck 下也稳妥），运行时按字面量加载。
const NATIVE_POLYFILL_SPEC = "node-datachannel/polyfill";
const NATIVE_MODULE_SPEC = "node-datachannel";

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

let cachedNative: NativeModule | null = null;
let nativeLoadPromise: Promise<NativeModule | null> | null = null;

/** 延迟加载原生模块（用于自行构造 PeerConnection）；失败返回 null（可重试）。 */
function loadNative(): Promise<NativeModule | null> {
	if (cachedNative) return Promise.resolve(cachedNative);
	if (!nativeLoadPromise) {
		nativeLoadPromise = import(NATIVE_MODULE_SPEC as string)
			.then((mod: unknown) => {
				const m = mod as { PeerConnection?: unknown };
				if (typeof m.PeerConnection === "function") {
					cachedNative = { PeerConnection: m.PeerConnection as never };
					return cachedNative;
				}
				return null;
			})
			.catch(() => null);
	}
	return nativeLoadPromise;
}

function currentNative(): NativeModule | null {
	return cachedNative;
}

/** 解析后的 ICE URL；scheme 已小写，transport 来自 `?transport=` 查询参数。 */
interface ParsedIceUrl {
	scheme: "stun" | "stuns" | "turn" | "turns";
	hostname: string;
	port: number;
	transport: string | null;
}

const ICE_SCHEMES = ["stun", "stuns", "turn", "turns"] as const;

/**
 * 解析 `stun:host:port` / `turn:host:port?transport=udp|tcp` 形态的 ICE URL。
 * 形状不合法或无法解析时返回 null（不做宽松猜测）。
 */
function parseIceUrl(url: string): ParsedIceUrl | null {
	const sep = url.indexOf(":");
	if (sep <= 0) return null;
	const scheme = url.slice(0, sep).toLowerCase();
	if (!(ICE_SCHEMES as readonly string[]).includes(scheme)) return null;
	const rest = url.slice(sep + 1);
	const queryAt = rest.indexOf("?");
	const authority = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
	const query = queryAt >= 0 ? rest.slice(queryAt + 1) : "";

	let hostname = "";
	let portText = "";
	if (authority.startsWith("[")) {
		// IPv6 字面量：[::1]:3478
		const end = authority.indexOf("]");
		if (end < 0) return null;
		hostname = authority.slice(1, end);
		const after = authority.slice(end + 1);
		if (!after.startsWith(":")) return null;
		portText = after.slice(1);
	} else {
		const lastColon = authority.lastIndexOf(":");
		if (lastColon <= 0) return null;
		hostname = authority.slice(0, lastColon);
		portText = authority.slice(lastColon + 1);
	}
	if (hostname.length === 0) return null;
	if (!/^\d+$/.test(portText)) return null;
	const port = Number(portText);
	if (port < 1 || port > 65535) return null;

	let transport: string | null = null;
	for (const part of query.split("&")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		if (part.slice(0, eq).toLowerCase() === "transport") {
			transport = part.slice(eq + 1).toLowerCase();
		}
	}
	return { scheme: scheme as ParsedIceUrl["scheme"], hostname, port, transport };
}

/** `turns` 走 TLS；`turn` 默认 UDP，`?transport=tcp` 走 TCP。 */
function relayTypeOf(
	scheme: ParsedIceUrl["scheme"],
	transport: string | null,
): NativeIceServer["relayType"] {
	if (scheme === "turns") return "TurnTls";
	return transport === "tcp" ? "TurnTcp" : "TurnUdp";
}

/**
 * 把 shared 的 ICE server 转成 node-datachannel 原生结构。
 *
 * 不能交给 `node-datachannel/polyfill` 自行转换：它把凭据拼成
 * `turn:<username>:<credential>@host:port` 的 URL，而 coturn REST 的用户名本身含冒号
 * （`<expiry>:<sessionId>`），libdatachannel 解析 userinfo 时在第一个冒号处切开，导致上报
 * 给 TURN 的用户名被截断，MESSAGE-INTEGRITY 校验失败（401，客户端拿不到 relay 候选）。
 * 结构化字段不经过 URL 解析，用户名原样下发。
 */
export function toNativeIceServers(iceServers: TunnelIceServer[]): NativeIceServer[] {
	const out: NativeIceServer[] = [];
	for (const server of iceServers) {
		for (const url of server.urls) {
			const parsed = parseIceUrl(url);
			if (!parsed) continue;
			if (parsed.scheme === "stun" || parsed.scheme === "stuns") {
				out.push({ hostname: parsed.hostname, port: parsed.port });
				continue;
			}
			// TURN 必须有凭据，缺凭据不下发（不猜测，也不匿名连中继）。
			if (!server.username || !server.credential) continue;
			out.push({
				hostname: parsed.hostname,
				port: parsed.port,
				username: server.username,
				password: server.credential,
				relayType: relayTypeOf(parsed.scheme, parsed.transport),
			});
		}
	}
	return out;
}

/**
 * 探测 P2P native 后端可用性（加载失败 → available:false + 稳定 code）。
 * @returns 供 register 上报的能力摘要；仅含脱敏字段。
 */
export async function probeP2pBackend(): Promise<P2pTunnelCapabilityStatus> {
	const [polyfill, native] = await Promise.all([loadPolyfill(), loadNative()]);
	if (polyfill && native) {
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
	const native = currentNative();
	if (!polyfill || !native) return null;

	// 自行构造原生 PeerConnection 并以 peerConnection 注入 polyfill：绕开 polyfill 的 URL 拼接
	// （见 toNativeIceServers），同时保留 polyfill 的 WebRTC 形状 API 与事件转发。
	const nativePeer = new native.PeerConnection(`vcpdeck-${Math.random().toString(36).slice(2, 9)}`, {
		iceServers: toNativeIceServers(iceServers),
	});
	const pc = new polyfill.RTCPeerConnection({ peerConnection: nativePeer, iceServers });

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
