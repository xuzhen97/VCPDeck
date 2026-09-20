// ── P2P TCP Tunnel 协议（ADR-0026）：浏览器 ↔ Client 的 WebRTC DataChannel 回环 TCP 隧道 ──

/** 当前 P2P 隧道协议版本；仅当 Client 与 Server 均声明 v1 时能力可用。 */
export const P2P_TUNNEL_PROTOCOL_VERSION = 1 as const;

/** 隧道相关的固定安全边界（字节 / 毫秒），跨运行时统一引用。 */
export const TunnelLimits = {
	maxSdpBytes: 128 * 1024,
	maxCandidateBytes: 8 * 1024,
	maxCandidateMidBytes: 64,
	maxIceUrlBytes: 512,
	maxIceUrlsPerList: 8,
	maxUsernameBytes: 255,
	maxCredentialBytes: 255,
	maxRealmBytes: 255,
	maxSessionIdBytes: 128,
	maxClientIdBytes: 128,
	attachTimeoutMs: 60_000,
	sessionTtlMs: 24 * 60 * 60 * 1000,
	httpResponseBytes: 1024 * 1024,
	httpTimeoutMs: 15_000,
	httpPathBytes: 2048,
} as const;

const STUN_SCHEMES = ["stun", "stuns"] as const;
const TURN_SCHEMES = ["turn", "turns"] as const;

// ── 内部解析辅助 ──

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
	value: unknown,
	field: string,
	maxLength: number,
	minLength = 1,
): string {
	if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
		throw new Error(`${field} 必须为长度 ${minLength}-${maxLength} 的字符串`);
	}
	return value;
}

function requirePort(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
		throw new Error(`${field} 必须是 1–65535 的整数`);
	}
	return value as number;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${field} 必须是布尔值`);
	}
	return value;
}

function assertKeys(input: Record<string, unknown>, allowed: string[], field: string): void {
	for (const key of Object.keys(input)) {
		if (!allowed.includes(key)) {
			throw new Error(`${field} 含未知字段 ${key}`);
		}
	}
}

function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** 严格校验单条 STUN/TURN URL：scheme 白名单、无 userinfo、无控制字符、长度上限。 */
function requireIceUrl(
	value: unknown,
	field: string,
	allowedSchemes: readonly string[],
): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > TunnelLimits.maxIceUrlBytes
	) {
		throw new Error(`${field} 必须为长度 1-${TunnelLimits.maxIceUrlBytes} 的字符串`);
	}
	if (hasControlChar(value)) {
		throw new Error(`${field} 含控制字符`);
	}
	const sep = value.indexOf(":");
	if (sep <= 0) {
		throw new Error(`${field} scheme 无效`);
	}
	const scheme = value.slice(0, sep);
	if (!allowedSchemes.includes(scheme)) {
		throw new Error(`${field} scheme 必须为 ${allowedSchemes.join("/")}`);
	}
	if (value.includes("@")) {
		throw new Error(`${field} 含用户信息`);
	}
	return value;
}

function parseIceUrlList(
	value: unknown,
	field: string,
	allowedSchemes: readonly string[],
	minLength = 0,
): string[] {
	if (
		!Array.isArray(value) ||
		value.length < minLength ||
		value.length > TunnelLimits.maxIceUrlsPerList
	) {
		throw new Error(`${field} 必须为长度 ${minLength}-${TunnelLimits.maxIceUrlsPerList} 的数组`);
	}
	return value.map((item, i) => requireIceUrl(item, `${field}[${i}]`, allowedSchemes));
}

// ── 类型 ──

/** 单个 ICE 服务器；username/credential 仅在 TURN 时存在（短期凭据）。 */
export interface TunnelIceServer {
	urls: string[];
	username?: string;
	credential?: string;
}

/** 创建临时隧道 Session 的公共请求；host 不进入协议，Client 固定连 127.0.0.1。 */
export interface TunnelSessionCreateRequest {
	clientId: string;
	targetPort: number;
}

/** 创建成功后 Server 返回给 Browser 的 Session 摘要（短期凭据，禁止缓存）。 */
export interface TunnelSessionCreated {
	sessionId: string;
	clientId: string;
	targetPort: number;
	/** Browser 必须在此 ISO 时间前 attach，否则 Session 失效。 */
	attachDeadline: string;
	iceServers: TunnelIceServer[];
}

/** 脱敏后的 ICE/coturn 配置摘要（不含 shared secret 内容）。 */
export interface TunnelConfigInfo {
	stunUrls: string[];
	turnUrls: string[];
	realm: string;
	turnSecretConfigured: boolean;
	updatedAt: string | null;
}

/** 配置更新请求；只接受非秘密字段，secret 由 VCPDECK_TURN_SECRET_FILE 提供。 */
export interface TunnelConfigUpdate {
	stunUrls: string[];
	turnUrls: string[];
	realm: string;
}

/** Browser → Server（/app）：请求把当前 Browser socket 绑定到 Session。 */
export interface TunnelBrowserAttach {
	sessionId: string;
}

/** Server → Client（/client）：为 Session 准备 PeerConnection 与目标端口。 */
export interface TunnelPrepare {
	sessionId: string;
	clientId: string;
	targetPort: number;
	iceServers: TunnelIceServer[];
}

/** SDP 描述；方向（offer/answer）由发送方角色决定。 */
export interface TunnelSdpDescription {
	type: "offer" | "answer";
	sdp: string;
}

/** 单个 trickle ICE candidate。 */
export interface TunnelIceCandidate {
	candidate: string;
	sdpMid: string;
}

/** 信令消息：description 与 candidate 二选一，均携带 sessionId。 */
export type TunnelSignal =
	| { sessionId: string; description: TunnelSdpDescription }
	| { sessionId: string; candidate: TunnelIceCandidate };

/** Client → Server（/client）：上报 Session 数据面状态。 */
export interface TunnelClientState {
	sessionId: string;
	state: "connected" | "failed" | "closed";
	code?: string;
}

/** 任一侧 → Server（/app 或 /client）：请求关闭 Session（幂等）。 */
export interface TunnelClose {
	sessionId: string;
}

/** Client 上报的 P2P 隧道能力摘要。 */
export interface P2pTunnelCapabilityStatus {
	available: boolean;
	protocolVersion: typeof P2P_TUNNEL_PROTOCOL_VERSION;
	code?: "P2P_NATIVE_BACKEND_UNAVAILABLE";
}

// ── 严格 parser ──

/** 严格解析 ICE 服务器。 */
export function parseTunnelIceServer(value: unknown): TunnelIceServer {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("iceServer 必须为对象");
	assertKeys(input, ["urls", "username", "credential"], "iceServer");
	const result: TunnelIceServer = {
		urls: parseIceUrlList(input.urls, "urls", [...STUN_SCHEMES, ...TURN_SCHEMES], 1),
	};
	if (input.username !== undefined) {
		result.username = requireString(input.username, "username", TunnelLimits.maxUsernameBytes);
	}
	if (input.credential !== undefined) {
		result.credential = requireString(
			input.credential,
			"credential",
			TunnelLimits.maxCredentialBytes,
		);
	}
	return result;
}

function parseIceServers(value: unknown, field: string): TunnelIceServer[] {
	if (!Array.isArray(value) || value.length > TunnelLimits.maxIceUrlsPerList) {
		throw new Error(`${field} 必须为长度 0-${TunnelLimits.maxIceUrlsPerList} 的数组`);
	}
	return value.map((item) => parseTunnelIceServer(item));
}

/** 严格解析创建请求：仅 clientId + targetPort。 */
export function parseTunnelSessionCreateRequest(
	value: unknown,
): TunnelSessionCreateRequest {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("createRequest 必须为对象");
	assertKeys(input, ["clientId", "targetPort"], "createRequest");
	return {
		clientId: requireString(input.clientId, "clientId", TunnelLimits.maxClientIdBytes),
		targetPort: requirePort(input.targetPort, "targetPort"),
	};
}

function requireIsoTimestamp(value: unknown, field: string): string {
	const s = requireString(value, field, 64);
	if (Number.isNaN(Date.parse(s))) {
		throw new Error(`${field} 必须为合法 ISO 时间戳`);
	}
	return s;
}

/** 严格解析创建成功响应。 */
export function parseTunnelSessionCreated(value: unknown): TunnelSessionCreated {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("sessionCreated 必须为对象");
	assertKeys(input, ["sessionId", "clientId", "targetPort", "attachDeadline", "iceServers"], "sessionCreated");
	return {
		sessionId: requireString(input.sessionId, "sessionId", TunnelLimits.maxSessionIdBytes),
		clientId: requireString(input.clientId, "clientId", TunnelLimits.maxClientIdBytes),
		targetPort: requirePort(input.targetPort, "targetPort"),
		attachDeadline: requireIsoTimestamp(input.attachDeadline, "attachDeadline"),
		iceServers: parseIceServers(input.iceServers, "iceServers"),
	};
}

/** 严格解析配置摘要（脱敏，无 secret 内容）。 */
export function parseTunnelConfigInfo(value: unknown): TunnelConfigInfo {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("configInfo 必须为对象");
	assertKeys(input, ["stunUrls", "turnUrls", "realm", "turnSecretConfigured", "updatedAt"], "configInfo");
	return {
		stunUrls: parseIceUrlList(input.stunUrls, "stunUrls", STUN_SCHEMES),
		turnUrls: parseIceUrlList(input.turnUrls, "turnUrls", TURN_SCHEMES),
		realm: requireString(input.realm, "realm", TunnelLimits.maxRealmBytes, 0),
		turnSecretConfigured: requireBoolean(input.turnSecretConfigured, "turnSecretConfigured"),
		updatedAt:
			input.updatedAt === null
				? null
				: requireIsoTimestamp(input.updatedAt, "updatedAt"),
	};
}

/** 严格解析配置更新请求（非秘密）。 */
export function parseTunnelConfigUpdate(value: unknown): TunnelConfigUpdate {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("configUpdate 必须为对象");
	assertKeys(input, ["stunUrls", "turnUrls", "realm"], "configUpdate");
	return {
		stunUrls: parseIceUrlList(input.stunUrls, "stunUrls", STUN_SCHEMES),
		turnUrls: parseIceUrlList(input.turnUrls, "turnUrls", TURN_SCHEMES),
		realm: requireString(input.realm, "realm", TunnelLimits.maxRealmBytes, 0),
	};
}

/** 严格解析 Browser 绑定消息。 */
export function parseTunnelBrowserAttach(value: unknown): TunnelBrowserAttach {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("browserAttach 必须为对象");
	assertKeys(input, ["sessionId"], "browserAttach");
	return {
		sessionId: requireString(input.sessionId, "sessionId", TunnelLimits.maxSessionIdBytes),
	};
}

/** 严格解析 Server → Client 的 prepare 消息。 */
export function parseTunnelPrepare(value: unknown): TunnelPrepare {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("prepare 必须为对象");
	assertKeys(input, ["sessionId", "clientId", "targetPort", "iceServers"], "prepare");
	return {
		sessionId: requireString(input.sessionId, "sessionId", TunnelLimits.maxSessionIdBytes),
		clientId: requireString(input.clientId, "clientId", TunnelLimits.maxClientIdBytes),
		targetPort: requirePort(input.targetPort, "targetPort"),
		iceServers: parseIceServers(input.iceServers, "iceServers"),
	};
}

function parseDescription(
	value: unknown,
	field: string,
	role: "offer" | "answer",
): TunnelSdpDescription {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error(`${field} 必须为对象`);
	assertKeys(input, ["type", "sdp"], field);
	const type = input.type;
	if (type !== "offer" && type !== "answer") {
		throw new Error(`${field}.type 必须为 offer 或 answer`);
	}
	if (type !== role) {
		throw new Error(`${field}.type 必须为 ${role}`);
	}
	return {
		type,
		sdp: requireString(
			input.sdp,
			`${field}.sdp`,
			TunnelLimits.maxSdpBytes,
		),
	};
}

function parseCandidate(value: unknown, field: string): TunnelIceCandidate {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error(`${field} 必须为对象`);
	assertKeys(input, ["candidate", "sdpMid"], field);
	return {
		candidate: requireString(
			input.candidate,
			`${field}.candidate`,
			TunnelLimits.maxCandidateBytes,
		),
		sdpMid: requireString(
			input.sdpMid,
			`${field}.sdpMid`,
			TunnelLimits.maxCandidateMidBytes,
		),
	};
}

function parseSignal(value: unknown, role: "offer" | "answer"): TunnelSignal {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("signal 必须为对象");
	assertKeys(input, ["sessionId", "description", "candidate"], "signal");
	const sessionId = requireString(input.sessionId, "sessionId", TunnelLimits.maxSessionIdBytes);
	const hasDescription = input.description !== undefined;
	const hasCandidate = input.candidate !== undefined;
	if (hasDescription === hasCandidate) {
		throw new Error("signal 必须且只能含 description 或 candidate 之一");
	}
	if (hasDescription) {
		return { sessionId, description: parseDescription(input.description, "description", role) };
	}
	return { sessionId, candidate: parseCandidate(input.candidate, "candidate") };
}

/** 严格解析 Browser → Server 信令（只能发 offer 或 candidate）。 */
export function parseTunnelBrowserSignal(value: unknown): TunnelSignal {
	return parseSignal(value, "offer");
}

/** 严格解析 Client → Server 信令（只能发 answer 或 candidate）。 */
export function parseTunnelClientSignal(value: unknown): TunnelSignal {
	return parseSignal(value, "answer");
}

/** 严格解析 Client → Server 状态上报。 */
export function parseTunnelClientState(value: unknown): TunnelClientState {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("clientState 必须为对象");
	assertKeys(input, ["sessionId", "state", "code"], "clientState");
	const state = input.state;
	if (state !== "connected" && state !== "failed" && state !== "closed") {
		throw new Error("state 必须为 connected、failed 或 closed");
	}
	const result: TunnelClientState = {
		sessionId: requireString(input.sessionId, "sessionId", TunnelLimits.maxSessionIdBytes),
		state,
	};
	if (input.code !== undefined) {
		result.code = requireString(input.code, "code", 128);
	}
	return result;
}

/** 严格解析关闭消息。 */
export function parseTunnelClose(value: unknown): TunnelClose {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("close 必须为对象");
	assertKeys(input, ["sessionId"], "close");
	return {
		sessionId: requireString(input.sessionId, "sessionId", TunnelLimits.maxSessionIdBytes),
	};
}

/** 严格解析 Client 上报的 P2P 隧道能力摘要。 */
export function parseP2pTunnelCapabilityStatus(value: unknown): P2pTunnelCapabilityStatus {
	const input = isRecord(value) ? value : null;
	if (!input) throw new Error("p2pTunnel 必须为对象");
	assertKeys(input, ["available", "protocolVersion", "code"], "p2pTunnel");
	const available = requireBoolean(input.available, "available");
	if (input.protocolVersion !== P2P_TUNNEL_PROTOCOL_VERSION) {
		throw new Error("protocolVersion 必须是 1");
	}
	const result: P2pTunnelCapabilityStatus = {
		available,
		protocolVersion: P2P_TUNNEL_PROTOCOL_VERSION,
	};
	if (input.code !== undefined) {
		if (input.code !== "P2P_NATIVE_BACKEND_UNAVAILABLE") {
			throw new Error("code 必须是 P2P_NATIVE_BACKEND_UNAVAILABLE");
		}
		result.code = "P2P_NATIVE_BACKEND_UNAVAILABLE";
	}
	return result;
}
