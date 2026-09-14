// ── Remote Desktop v1 跨运行时协议 ──
// 本模块只包含协议类型、边界和运行时校验，不依赖 Server、Client 或 WebRTC 实现。

export const REMOTE_DESKTOP_PROTOCOL_VERSION = 1 as const;

const QUALITY_PROFILES = new Set<RemoteDesktopQualityProfile>([
	"low-bandwidth",
	"balanced",
	"high-quality",
]);
const CLIPBOARD_MODES = new Set<RemoteDesktopClipboardMode>([
	"off",
	"browser-to-remote",
	"bidirectional",
]);

export const RemoteDesktopLimits = {
	maxAttachments: 4,
	reconnectGraceMs: 30_000,
	detachedTtlMs: 300_000,
	leaseTimeoutMs: 30_000,
	maxSignalBytes: 262_144,
	maxSignalBytesPerAttachment: 1_048_576,
	maxIceCandidates: 256,
	maxClipboardBytes: 262_144,
	maxClipboardMessagesPerMinute: 30,
	maxSignalMessagesPerSecond: 30,
	maxIpcFrameBytes: 1_048_576,
} as const;

export const REMOTE_DESKTOP_ERROR_CODES = [
	"REMOTE_DESKTOP_UNSUPPORTED",
	"REMOTE_DESKTOP_HOST_OFFLINE",
	"REMOTE_DESKTOP_PROTOCOL_MISMATCH",
	"REMOTE_DESKTOP_PERMISSION_DENIED",
	"REMOTE_DESKTOP_NO_ACTIVE_SESSION",
	"REMOTE_DESKTOP_NO_DISPLAY",
	"REMOTE_DESKTOP_CAPTURE_FAILED",
	"REMOTE_DESKTOP_INPUT_UNAVAILABLE",
	"REMOTE_DESKTOP_ENCODER_UNAVAILABLE",
	"REMOTE_DESKTOP_VIRTUAL_DISPLAY_FAILED",
	"REMOTE_DESKTOP_SIGNAL_LIMIT",
	"REMOTE_DESKTOP_ICE_FAILED",
	"REMOTE_DESKTOP_AUTH_FAILED",
	"REMOTE_DESKTOP_LEASE_EXPIRED",
	"REMOTE_DESKTOP_INPUT_FROZEN",
	"REMOTE_DESKTOP_SESSION_LIMIT",
	"REMOTE_DESKTOP_ATTACHMENT_LIMIT",
	"REMOTE_DESKTOP_DISPLAY_CHANGED",
	"REMOTE_DESKTOP_TAKEOVER_CONFLICT",
	"REMOTE_DESKTOP_MIGRATION_FAILED",
] as const;
export type RemoteDesktopErrorCode = (typeof REMOTE_DESKTOP_ERROR_CODES)[number];

export const REMOTE_DESKTOP_SESSION_STATUSES = [
	"creating",
	"ready",
	"connecting",
	"connected",
	"detached",
	"closed",
	"interrupted",
	"error",
] as const;
export type RemoteDesktopSessionStatus = (typeof REMOTE_DESKTOP_SESSION_STATUSES)[number];

export const REMOTE_DESKTOP_ATTACHMENT_STATUSES = [
	"attaching",
	"connected",
	"detached",
	"closed",
] as const;
export type RemoteDesktopAttachmentStatus =
	(typeof REMOTE_DESKTOP_ATTACHMENT_STATUSES)[number];

export const REMOTE_DESKTOP_AUDIT_EVENTS = [
	"session.created",
	"attachment.connected",
	"operator.acquired",
	"operator.reconnected",
	"operator.taken_over",
	"clipboard.mode_changed",
	"display.changed",
	"connection.direct",
	"connection.relay",
	"session.closed",
	"session.interrupted",
	"session.error",
] as const;
export type RemoteDesktopAuditEventName = (typeof REMOTE_DESKTOP_AUDIT_EVENTS)[number];

export type RemoteDesktopRole = "operator" | "viewer";
export type RemoteDesktopQualityProfile = "low-bandwidth" | "balanced" | "high-quality";
export type RemoteDesktopClipboardMode = "off" | "browser-to-remote" | "bidirectional";

export type RemoteDesktopControlInput =
	| { kind: "pointer-move"; x: number; y: number }
	| { kind: "button"; button: number; pressed: boolean }
	| { kind: "wheel"; deltaX: number; deltaY: number }
	| { kind: "key"; keyCode: number; pressed: boolean };

export type RemoteDesktopControlMessage =
	| { type: "input"; event: RemoteDesktopControlInput }
	| { type: "release-all" }
	| { type: "secure-attention" }
	| { type: "display-select"; displayId: string }
	| { type: "layout-confirm"; layoutGeneration: number };

export type RemoteDesktopHostControlMessage = {
	type: "layout-update";
	layoutGeneration: number;
	displayId: string;
	width: number;
	height: number;
};

export type RemoteDesktopClipboardMessage = {
	type: "browser-to-remote" | "remote-to-browser";
	text: string;
};
export type RemoteDesktopIcePolicy = "p2p-only" | "relay-allowed";
export type RemoteDesktopCodec = "H264" | "VP8";
export type RemoteDesktopBackend =
	| "windows"
	| "x11"
	| "gnome-wayland"
	| "kde-wayland"
	| "unknown";

export interface RemoteDesktopError {
	code: RemoteDesktopErrorCode;
	message: string;
}

export class RemoteDesktopProtocolError extends Error {
	readonly code = "REMOTE_DESKTOP_PROTOCOL_MISMATCH" as const;

	constructor(message: string) {
		super(message);
		this.name = "RemoteDesktopProtocolError";
	}
}

/** SDP/ICE 信令；Server 只校验形状和边界，不解析媒体正文。 */
export type RemoteDesktopSignal =
	| { kind: "offer"; sdp: string }
	| { kind: "answer"; sdp: string }
	| {
				kind: "ice";
				candidate: string;
				sdpMid?: string;
				sdpMLineIndex?: number;
		  }
	| { kind: "ice-complete" };

export interface RemoteDesktopDisplayInfo {
	id: string;
	label: string;
	width: number;
	height: number;
	physical: boolean;
	virtual: boolean;
	primary: boolean;
	rotation: 0 | 90 | 180 | 270;
	scalePercent: number;
}

export interface RemoteDesktopCapabilityStatus {
	protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
	hostVersion: string;
	available: boolean;
	backend: RemoteDesktopBackend;
	displayManager?: string;
	compositor?: string;
	capture: boolean;
	pointer: boolean;
	keyboard: boolean;
	clipboardText: boolean;
	loginScreen: boolean;
	lockScreen: boolean;
	/** 是否支持平台级 Secure Attention（Ctrl+Alt+Del），只能由平台 API 送达。 */
	secureAttention: boolean;
	physicalDisplay: boolean;
	virtualDisplay: boolean;
	headless: boolean;
	hardwareEncoders: string[];
	supportedCodecs: RemoteDesktopCodec[];
	diagnosticCode?: RemoteDesktopErrorCode;
}

export interface RemoteDesktopSessionCreateRequest {
	qualityProfile?: RemoteDesktopQualityProfile;
	clipboardMode?: RemoteDesktopClipboardMode;
}

export interface RemoteDesktopSessionInfo {
	id: string;
	clientId: string;
	createdByIdentityId: string;
	createdByName: string;
	status: RemoteDesktopSessionStatus;
	selectedDisplayId: string | null;
	displays: RemoteDesktopDisplayInfo[];
	qualityProfile: RemoteDesktopQualityProfile;
	clipboardMode: RemoteDesktopClipboardMode;
	protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
	hostGeneration: string | null;
	createdAt: string;
	connectedAt: string | null;
	detachedAt: string | null;
	endedAt: string | null;
	safeErrorCode: RemoteDesktopErrorCode | null;
	safeErrorMessage: string | null;
}

export interface RemoteDesktopAttachmentInfo {
	id: string;
	sessionId: string;
	role: RemoteDesktopRole;
	status: RemoteDesktopAttachmentStatus;
	connectedAt: string | null;
	detachedAt: string | null;
	controlProtectedUntil: string | null;
}

export interface RemoteDesktopAuditInfo {
	id: string;
	sessionId: string;
	clientId: string;
	event: RemoteDesktopAuditEventName;
	identityId: string | null;
	actorName: string | null;
	attachmentId: string | null;
	role: RemoteDesktopRole | null;
	result: "ok" | "error";
	reason: string | null;
	createdAt: string;
}

export interface RemoteDesktopBrowserAttach {
	sessionId: string;
	reconnectToken?: string;
}

export interface RemoteDesktopBrowserDetach {
	sessionId: string;
	attachmentId: string;
}

export interface RemoteDesktopBrowserSignal {
	sessionId: string;
	attachmentId: string;
	signal: RemoteDesktopSignal;
}

export interface RemoteDesktopBrowserTakeover {
	sessionId: string;
	attachmentId: string;
}

export interface RemoteDesktopControlState {
	sessionId: string;
	attachmentId: string;
	role: RemoteDesktopRole;
	operatorName: string | null;
	controlProtectedUntil: string | null;
	canTakeover: boolean;
}

export type RemoteDesktopAck<T> =
	| { ok: true; data: T }
	| { ok: false; error: RemoteDesktopError };

export interface RemoteDesktopBrowserAttached {
	sessionId: string;
	attachmentId: string;
	role: RemoteDesktopRole;
	reconnectToken: string;
	controlProtectedUntil: string | null;
	iceConfig: RemoteDesktopIceConfig;
}

export interface RemoteDesktopIceServer {
	urls: string | string[];
	username?: string;
	credential?: string;
}

export interface RemoteDesktopIceConfig {
	policy: RemoteDesktopIcePolicy;
	iceServers: RemoteDesktopIceServer[];
	expiresAt: string | null;
}

export interface RemoteDesktopClientRequest {
	requestId: string;
	protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
	action:
		| "session.prepare"
		| "session.close"
		| "session.freeze-input"
		| "session.resume-input"
		| "session.attach"
		| "session.detach"
		| "session.signal"
		| "session.state";
	sessionId: string;
	hostGeneration?: string;
		payload?: Record<string, unknown>;
}

export interface RemoteDesktopClientResponse {
	requestId: string;
	protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
	hostGeneration: string;
	ok: boolean;
	result?: Record<string, unknown>;
	error?: RemoteDesktopError;
}

export interface RemoteDesktopStateReport {
	protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
	hostGeneration: string;
	sessionId: string | null;
	status: "idle" | "preparing" | "ready" | "connected" | "frozen" | "closed" | "error";
	capability?: RemoteDesktopCapabilityStatus;
	displays?: RemoteDesktopDisplayInfo[];
	safeErrorCode?: RemoteDesktopErrorCode;
}

export interface RemoteDesktopStateAck {
	accepted: boolean;
	action: "none" | "interrupted" | "close" | "reconcile";
}

const REMOTE_DESKTOP_CLIENT_ACTIONS = [
	"session.prepare",
	"session.close",
	"session.freeze-input",
	"session.resume-input",
	"session.attach",
	"session.detach",
	"session.signal",
	"session.state",
] as const;

type RemoteDesktopClientAction = (typeof REMOTE_DESKTOP_CLIENT_ACTIONS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new RemoteDesktopProtocolError(`${field} 必须是对象`);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new RemoteDesktopProtocolError(`${field} 含未知字段 ${key}`);
		}
	}
}

function assertString(value: unknown, field: string, maxBytes: number): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new RemoteDesktopProtocolError(`${field} 必须是非空字符串`);
	}
	if (new TextEncoder().encode(value).byteLength > maxBytes) {
		throw new RemoteDesktopProtocolError(`${field} 超过 ${maxBytes} 字节上限`);
	}
}

function assertOptionalString(value: unknown, field: string, maxBytes: number): void {
	if (value !== undefined) assertString(value, field, maxBytes);
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
	if (typeof value !== "boolean") throw new RemoteDesktopProtocolError(`${field} 必须是布尔值`);
}

function assertInteger(value: unknown, field: string, min: number, max: number): asserts value is number {
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new RemoteDesktopProtocolError(`${field} 必须是 ${min}-${max} 的整数`);
	}
}

const REMOTE_DESKTOP_CONTROL_INPUT_KINDS = new Set([
	"pointer-move",
	"button",
	"wheel",
	"key",
]);

/** 严格解析 Browser → Desktop Host 的可靠控制消息，统一使用 camelCase 字段。 */
export function parseRemoteDesktopControlMessage(value: unknown): RemoteDesktopControlMessage {
	assertRecord(value, "remoteDesktop control");
	if (value.type === "display-select") {
		assertKeys(value, ["type", "displayId"], "remoteDesktop control");
		assertString(value.displayId, "remoteDesktop control.displayId", 128);
		return { type: "display-select", displayId: value.displayId };
	}
	if (value.type === "layout-confirm") {
		assertKeys(value, ["type", "layoutGeneration"], "remoteDesktop control");
		assertInteger(value.layoutGeneration, "remoteDesktop control.layoutGeneration", 0, Number.MAX_SAFE_INTEGER);
		return { type: "layout-confirm", layoutGeneration: value.layoutGeneration };
	}
	assertKeys(value, ["type", "event"], "remoteDesktop control");
	if (value.type === "release-all") {
		assertKeys(value, ["type"], "remoteDesktop control");
		return { type: "release-all" };
	}
	// Ctrl+Alt+Del 是系统级 Secure Attention Sequence，无法用普通按键注入送达，
	// 只能由 Host 调用平台 API；因此它是一条独立消息，而不是 keyCode 组合。
	if (value.type === "secure-attention") {
		assertKeys(value, ["type"], "remoteDesktop control");
		return { type: "secure-attention" };
	}
	if (value.type !== "input") {
		throw new RemoteDesktopProtocolError("remoteDesktop control.type 不受支持");
	}
	assertRecord(value.event, "remoteDesktop control.event");
	assertString(value.event.kind, "remoteDesktop control.event.kind", 32);
	if (!REMOTE_DESKTOP_CONTROL_INPUT_KINDS.has(value.event.kind)) {
		throw new RemoteDesktopProtocolError("remoteDesktop control.event.kind 不受支持");
	}
	if (value.event.kind === "pointer-move") {
		assertKeys(value.event, ["kind", "x", "y"], "remoteDesktop control.event");
		assertInteger(value.event.x, "remoteDesktop control.event.x", 0, 65_535);
		assertInteger(value.event.y, "remoteDesktop control.event.y", 0, 65_535);
		return { type: "input", event: { kind: "pointer-move", x: value.event.x, y: value.event.y } };
	}
	if (value.event.kind === "button") {
		assertKeys(value.event, ["kind", "button", "pressed"], "remoteDesktop control.event");
		assertInteger(value.event.button, "remoteDesktop control.event.button", 0, 7);
		assertBoolean(value.event.pressed, "remoteDesktop control.event.pressed");
		return { type: "input", event: { kind: "button", button: value.event.button, pressed: value.event.pressed } };
	}
	if (value.event.kind === "wheel") {
		assertKeys(value.event, ["kind", "deltaX", "deltaY"], "remoteDesktop control.event");
		assertInteger(value.event.deltaX, "remoteDesktop control.event.deltaX", -32_767, 32_767);
		assertInteger(value.event.deltaY, "remoteDesktop control.event.deltaY", -32_767, 32_767);
		return { type: "input", event: { kind: "wheel", deltaX: value.event.deltaX, deltaY: value.event.deltaY } };
	}
	assertKeys(value.event, ["kind", "keyCode", "pressed"], "remoteDesktop control.event");
	assertInteger(value.event.keyCode, "remoteDesktop control.event.keyCode", 1, 0x10ffff);
	assertBoolean(value.event.pressed, "remoteDesktop control.event.pressed");
	return { type: "input", event: { kind: "key", keyCode: value.event.keyCode, pressed: value.event.pressed } };
}

/** 严格解析 Desktop Host → Browser 的布局更新消息。 */
export function parseRemoteDesktopHostControlMessage(value: unknown): RemoteDesktopHostControlMessage {
	assertRecord(value, "remoteDesktop host control");
	assertKeys(value, ["type", "layoutGeneration", "displayId", "width", "height"], "remoteDesktop host control");
	if (value.type !== "layout-update") {
		throw new RemoteDesktopProtocolError("remoteDesktop host control.type 不受支持");
	}
	assertInteger(value.layoutGeneration, "remoteDesktop host control.layoutGeneration", 0, Number.MAX_SAFE_INTEGER);
	assertString(value.displayId, "remoteDesktop host control.displayId", 128);
	assertInteger(value.width, "remoteDesktop host control.width", 1, 16_384);
	assertInteger(value.height, "remoteDesktop host control.height", 1, 16_384);
	return {
		type: "layout-update",
		layoutGeneration: value.layoutGeneration,
		displayId: value.displayId,
		width: value.width,
		height: value.height,
	};
}

/** 严格解析 Remote Desktop 的纯文本剪贴板消息。 */
export function parseRemoteDesktopClipboardMessage(value: unknown): RemoteDesktopClipboardMessage {
	assertRecord(value, "remoteDesktop clipboard");
	assertKeys(value, ["type", "text"], "remoteDesktop clipboard");
	if (value.type !== "browser-to-remote" && value.type !== "remote-to-browser") {
		throw new RemoteDesktopProtocolError("remoteDesktop clipboard.type 不受支持");
	}
	assertString(value.text, "remoteDesktop clipboard.text", RemoteDesktopLimits.maxClipboardBytes);
	return { type: value.type, text: value.text };
}

function parseRemoteDesktopDisplay(value: unknown, index: number): RemoteDesktopDisplayInfo {
	assertRecord(value, `displays[${index}]`);
	assertKeys(value, ["id", "label", "width", "height", "physical", "virtual", "primary", "rotation", "scalePercent"], `displays[${index}]`);
	assertString(value.id, `displays[${index}].id`, 128);
	assertString(value.label, `displays[${index}].label`, 128);
	assertInteger(value.width, `displays[${index}].width`, 1, 16_384);
	assertInteger(value.height, `displays[${index}].height`, 1, 16_384);
	assertBoolean(value.physical, `displays[${index}].physical`);
	assertBoolean(value.virtual, `displays[${index}].virtual`);
	assertBoolean(value.primary, `displays[${index}].primary`);
	assertInteger(value.rotation, `displays[${index}].rotation`, 0, 270);
	if (![0, 90, 180, 270].includes(value.rotation)) {
		throw new RemoteDesktopProtocolError(`displays[${index}].rotation 无效`);
	}
	assertInteger(value.scalePercent, `displays[${index}].scalePercent`, 50, 400);
	if (value.physical && value.virtual) {
		throw new RemoteDesktopProtocolError(`displays[${index}] 不能同时为 physical 和 virtual`);
	}
	const rotation: 0 | 90 | 180 | 270 =
		value.rotation === 0 ? 0 : value.rotation === 90 ? 90 : value.rotation === 180 ? 180 : 270;
	return {
		id: value.id,
		label: value.label,
		width: value.width,
		height: value.height,
		physical: value.physical,
		virtual: value.virtual,
		primary: value.primary,
		rotation,
		scalePercent: value.scalePercent,
	};
}

function assertStringArray(value: unknown, field: string, maxItems: number): asserts value is string[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new RemoteDesktopProtocolError(`${field} 必须是长度不超过 ${maxItems} 的数组`);
	}
	for (const [index, item] of value.entries()) {
		assertString(item, `${field}[${index}]`, 128);
	}
}

export function isRemoteDesktopErrorCode(value: unknown): value is RemoteDesktopErrorCode {
	return typeof value === "string" && (REMOTE_DESKTOP_ERROR_CODES as readonly string[]).includes(value);
}

export function isRemoteDesktopSessionStatus(value: unknown): value is RemoteDesktopSessionStatus {
	return typeof value === "string" &&
		(REMOTE_DESKTOP_SESSION_STATUSES as readonly string[]).includes(value);
}

export function isRemoteDesktopAuditEventName(value: unknown): value is RemoteDesktopAuditEventName {
	return typeof value === "string" &&
		(REMOTE_DESKTOP_AUDIT_EVENTS as readonly string[]).includes(value);
}

/** 严格解析 SDP/ICE 信令。 */
export function parseRemoteDesktopSignal(value: unknown): RemoteDesktopSignal {
	assertRecord(value, "signal");
	if (value.kind === "offer" || value.kind === "answer") {
		assertKeys(value, ["kind", "sdp"], "signal");
		assertString(value.sdp, "signal.sdp", RemoteDesktopLimits.maxSignalBytes);
		return { kind: value.kind, sdp: value.sdp };
	}
	if (value.kind === "ice") {
		assertKeys(value, ["kind", "candidate", "sdpMid", "sdpMLineIndex"], "signal");
		assertString(value.candidate, "signal.candidate", RemoteDesktopLimits.maxSignalBytes);
		assertOptionalString(value.sdpMid, "signal.sdpMid", 128);
		if (value.sdpMLineIndex !== undefined) {
			assertInteger(value.sdpMLineIndex, "signal.sdpMLineIndex", 0, 255);
		}
		const sdpMid = value.sdpMid;
		const sdpMLineIndex = value.sdpMLineIndex;
		return {
			kind: "ice",
			candidate: value.candidate,
			...(typeof sdpMid === "string" ? { sdpMid } : {}),
			...(typeof sdpMLineIndex === "number" ? { sdpMLineIndex } : {}),
		};
	}
	if (value.kind === "ice-complete") {
		assertKeys(value, ["kind"], "signal");
		return { kind: "ice-complete" };
	}
	throw new RemoteDesktopProtocolError("signal.kind 不受支持");
}

/** 严格解析 Desktop Host capability，并校验字段间语义一致性。 */
export function parseRemoteDesktopCapabilityStatus(value: unknown): RemoteDesktopCapabilityStatus {
	assertRecord(value, "remoteDesktop capability");
	assertKeys(
		value,
		[
			"protocolVersion",
			"hostVersion",
			"available",
			"backend",
			"displayManager",
			"compositor",
			"capture",
			"pointer",
			"keyboard",
			"clipboardText",
			"loginScreen",
			"lockScreen",
			"secureAttention",
			"physicalDisplay",
			"virtualDisplay",
			"headless",
			"hardwareEncoders",
			"supportedCodecs",
			"diagnosticCode",
		],
		"remoteDesktop capability",
	);
	if (value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION) {
		throw new RemoteDesktopProtocolError("remoteDesktop.protocolVersion 不匹配");
	}
	assertString(value.hostVersion, "remoteDesktop.hostVersion", 64);
	assertBoolean(value.available, "remoteDesktop.available");
	if (!(["windows", "x11", "gnome-wayland", "kde-wayland", "unknown"] as const).includes(value.backend as RemoteDesktopBackend)) {
		throw new RemoteDesktopProtocolError("remoteDesktop.backend 不受支持");
	}
	for (const field of [
		"capture",
		"pointer",
		"keyboard",
		"clipboardText",
		"loginScreen",
		"lockScreen",
		"physicalDisplay",
		"virtualDisplay",
		"headless",
	] as const) {
		assertBoolean(value[field], `remoteDesktop.${field}`);
	}
	// 旧 Host 不声明该字段时一律按“不支持”处理，绝不默认放行。
	if (value.secureAttention !== undefined) {
		assertBoolean(value.secureAttention, "remoteDesktop.secureAttention");
	}
	value.secureAttention = value.secureAttention === true;
	assertOptionalString(value.displayManager, "remoteDesktop.displayManager", 128);
	assertOptionalString(value.compositor, "remoteDesktop.compositor", 128);
	assertStringArray(value.hardwareEncoders, "remoteDesktop.hardwareEncoders", 32);
	if (!Array.isArray(value.supportedCodecs) || value.supportedCodecs.some((codec) => codec !== "H264" && codec !== "VP8")) {
		throw new RemoteDesktopProtocolError("remoteDesktop.supportedCodecs 不受支持");
	}
	if (value.diagnosticCode !== undefined && !isRemoteDesktopErrorCode(value.diagnosticCode)) {
		throw new RemoteDesktopProtocolError("remoteDesktop.diagnosticCode 不受支持");
	}
	if (value.headless && !value.physicalDisplay && !value.virtualDisplay) {
		throw new RemoteDesktopProtocolError("headless 必须有物理或虚拟显示输出");
	}
	if (value.available && (!value.capture || !value.pointer || !value.keyboard || value.supportedCodecs.length === 0)) {
		throw new RemoteDesktopProtocolError("available capability 缺少捕获、输入或编码能力");
	}
	// SAFETY: all fields were checked above and the discriminated values were narrowed by the parser.
	return value as unknown as RemoteDesktopCapabilityStatus;
}

/** 严格解析 REST 创建请求；缺省值由 Server 侧按协议默认。 */
export function parseRemoteDesktopSessionCreateRequest(
	value: unknown,
): RemoteDesktopSessionCreateRequest {
	assertRecord(value, "remoteDesktop create");
	assertKeys(value, ["qualityProfile", "clipboardMode"], "remoteDesktop create");
	if (
		value.qualityProfile !== undefined &&
		!QUALITY_PROFILES.has(value.qualityProfile as RemoteDesktopQualityProfile)
	) {
		throw new RemoteDesktopProtocolError("qualityProfile 不受支持");
	}
	if (
		value.clipboardMode !== undefined &&
		!CLIPBOARD_MODES.has(value.clipboardMode as RemoteDesktopClipboardMode)
	) {
		throw new RemoteDesktopProtocolError("clipboardMode 不受支持");
	}
	return {
		...(typeof value.qualityProfile === "string"
			? { qualityProfile: value.qualityProfile as RemoteDesktopQualityProfile }
			: {}),
		...(typeof value.clipboardMode === "string"
			? { clipboardMode: value.clipboardMode as RemoteDesktopClipboardMode }
			: {}),
	};
}

/** 严格解析 Server → Client 的控制面请求。 */
export function parseRemoteDesktopClientRequest(
	value: unknown,
): RemoteDesktopClientRequest {
	assertRecord(value, "remoteDesktop client request");
	assertKeys(
		value,
		["requestId", "protocolVersion", "action", "sessionId", "hostGeneration", "payload"],
		"remoteDesktop client request",
	);
	assertString(value.requestId, "requestId", 128);
	if (value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION) {
		throw new RemoteDesktopProtocolError("client request.protocolVersion 不匹配");
	}
	if (!(REMOTE_DESKTOP_CLIENT_ACTIONS as readonly string[]).includes(value.action as string)) {
		throw new RemoteDesktopProtocolError("client request.action 不受支持");
	}
	assertString(value.sessionId, "sessionId", 128);
	assertOptionalString(value.hostGeneration, "hostGeneration", 128);
	if (value.payload !== undefined) {
		assertRecord(value.payload, "client request.payload");
		if (new TextEncoder().encode(JSON.stringify(value.payload)).byteLength > RemoteDesktopLimits.maxIpcFrameBytes) {
			throw new RemoteDesktopProtocolError("client request.payload 超过字节上限");
		}
	}
	const hostGeneration = value.hostGeneration;
	const payload = value.payload;
	return {
		requestId: value.requestId,
		protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
		action: value.action as RemoteDesktopClientAction,
		sessionId: value.sessionId,
		...(typeof hostGeneration === "string" ? { hostGeneration } : {}),
		...(isRecord(payload) ? { payload } : {}),
	};
}

/** 严格解析 Client → Server 的控制面响应。 */
export function parseRemoteDesktopClientResponse(
	value: unknown,
): RemoteDesktopClientResponse {
	assertRecord(value, "remoteDesktop client response");
	assertKeys(
		value,
		["requestId", "protocolVersion", "hostGeneration", "ok", "result", "error"],
		"remoteDesktop client response",
	);
	assertString(value.requestId, "requestId", 128);
	if (value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION) {
		throw new RemoteDesktopProtocolError("client response.protocolVersion 不匹配");
	}
	assertString(value.hostGeneration, "hostGeneration", 128);
	assertBoolean(value.ok, "client response.ok");
	if (value.result !== undefined) assertRecord(value.result, "client response.result");
	if (value.error !== undefined) {
		assertRecord(value.error, "client response.error");
		assertKeys(value.error, ["code", "message"], "client response.error");
		if (!isRemoteDesktopErrorCode(value.error.code)) {
			throw new RemoteDesktopProtocolError("client response.error.code 不受支持");
		}
		assertString(value.error.message, "client response.error.message", 200);
	}
	if (value.ok && value.error !== undefined) {
		throw new RemoteDesktopProtocolError("成功 response 不能包含 error");
	}
	if (!value.ok && value.error === undefined) {
		throw new RemoteDesktopProtocolError("失败 response 必须包含 error");
	}
	const result = value.result;
	const error = value.error;
	return {
		requestId: value.requestId,
		protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
		hostGeneration: value.hostGeneration,
		ok: value.ok,
		...(isRecord(result) ? { result } : {}),
		...(isRecord(error)
			? {
					error: {
						code: error.code as RemoteDesktopErrorCode,
						message: error.message as string,
					},
				}
			: {}),
	};
}

/** 严格解析 Client → Server 的 Host 状态报告。 */
export function parseRemoteDesktopStateReport(value: unknown): RemoteDesktopStateReport {
	assertRecord(value, "remoteDesktop state report");
	assertKeys(
		value,
		["protocolVersion", "hostGeneration", "sessionId", "status", "capability", "displays", "safeErrorCode"],
		"remoteDesktop state report",
	);
	if (value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION) {
		throw new RemoteDesktopProtocolError("state report.protocolVersion 不匹配");
	}
	assertString(value.hostGeneration, "state report.hostGeneration", 128);
	if (value.sessionId !== null && value.sessionId !== undefined) {
		assertString(value.sessionId, "state report.sessionId", 128);
	}
	if (!(typeof value.status === "string" && ["idle", "preparing", "ready", "connected", "frozen", "closed", "error"].includes(value.status))) {
		throw new RemoteDesktopProtocolError("state report.status 不受支持");
	}
	if (value.capability !== undefined) parseRemoteDesktopCapabilityStatus(value.capability);
	if (value.displays !== undefined) {
		if (!Array.isArray(value.displays) || value.displays.length > 16) {
			throw new RemoteDesktopProtocolError("state report.displays 无效");
		}
		for (const [index, display] of value.displays.entries()) parseRemoteDesktopDisplay(display, index);
	}
	if (value.safeErrorCode !== undefined && !isRemoteDesktopErrorCode(value.safeErrorCode)) {
		throw new RemoteDesktopProtocolError("state report.safeErrorCode 不受支持");
	}
	const sessionId = value.sessionId;
	const capability = value.capability;
	const displays = value.displays;
	const safeErrorCode = value.safeErrorCode;
	return {
		protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
		hostGeneration: value.hostGeneration,
		sessionId: sessionId === undefined ? null : sessionId,
		status: value.status as RemoteDesktopStateReport["status"],
		...(isRecord(capability)
			? {
					// SAFETY: capability was fully validated by parseRemoteDesktopCapabilityStatus above.
					capability: capability as unknown as RemoteDesktopCapabilityStatus,
				}
			: {}),
		...(Array.isArray(displays)
			? {
					// SAFETY: each display was fully validated by parseRemoteDesktopDisplay above.
					displays: displays as unknown as RemoteDesktopDisplayInfo[],
				}
			: {}),
		...(typeof safeErrorCode === "string" ? { safeErrorCode: safeErrorCode as RemoteDesktopErrorCode } : {}),
	};
}

function parseRemoteDesktopIceConfig(value: unknown): RemoteDesktopIceConfig {
	assertRecord(value, "remoteDesktop iceConfig");
	assertKeys(value, ["policy", "iceServers", "expiresAt"], "remoteDesktop iceConfig");
	if (value.policy !== "p2p-only" && value.policy !== "relay-allowed") {
		throw new RemoteDesktopProtocolError("iceConfig.policy 不受支持");
	}
	if (!Array.isArray(value.iceServers) || value.iceServers.length > 8) {
		throw new RemoteDesktopProtocolError("iceConfig.iceServers 无效");
	}
	for (const [index, server] of value.iceServers.entries()) {
		assertRecord(server, `iceConfig.iceServers[${index}]`);
		assertKeys(server, ["urls", "username", "credential"], `iceConfig.iceServers[${index}]`);
		if (typeof server.urls !== "string" && !(Array.isArray(server.urls) && server.urls.every((url) => typeof url === "string"))) {
			throw new RemoteDesktopProtocolError(`iceConfig.iceServers[${index}].urls 无效`);
		}
		if (Array.isArray(server.urls) && server.urls.length > 8) {
			throw new RemoteDesktopProtocolError(`iceConfig.iceServers[${index}].urls 超限`);
		}
		assertOptionalString(server.username, `iceConfig.iceServers[${index}].username`, 128);
		assertOptionalString(server.credential, `iceConfig.iceServers[${index}].credential`, 512);
	}
	if (value.expiresAt !== null && value.expiresAt !== undefined) {
		assertString(value.expiresAt, "iceConfig.expiresAt", 64);
		if (Number.isNaN(Date.parse(value.expiresAt))) {
			throw new RemoteDesktopProtocolError("iceConfig.expiresAt 无效");
		}
	}
	return {
		policy: value.policy,
		iceServers: value.iceServers as RemoteDesktopIceServer[],
		expiresAt: value.expiresAt === undefined ? null : value.expiresAt,
	};
}

/** 严格解析 Server 返回的 Browser attachment。 */
export function parseRemoteDesktopBrowserAttached(value: unknown): RemoteDesktopBrowserAttached {
	assertRecord(value, "remoteDesktop attached");
	assertKeys(value, ["sessionId", "attachmentId", "role", "reconnectToken", "controlProtectedUntil", "iceConfig"], "remoteDesktop attached");
	assertString(value.sessionId, "attached.sessionId", 128);
	assertString(value.attachmentId, "attached.attachmentId", 128);
	if (value.role !== "operator" && value.role !== "viewer") {
		throw new RemoteDesktopProtocolError("attached.role 不受支持");
	}
	assertString(value.reconnectToken, "attached.reconnectToken", 512);
	if (value.controlProtectedUntil !== null && value.controlProtectedUntil !== undefined) {
		assertString(value.controlProtectedUntil, "attached.controlProtectedUntil", 64);
	}
	const controlProtectedUntil = value.controlProtectedUntil === undefined ? null : value.controlProtectedUntil;
	return {
		sessionId: value.sessionId,
		attachmentId: value.attachmentId,
		role: value.role,
		reconnectToken: value.reconnectToken,
		controlProtectedUntil,
		iceConfig: parseRemoteDesktopIceConfig(value.iceConfig),
	};
}

/** 严格解析 Browser → Server 的 attach 请求。 */
export function parseRemoteDesktopBrowserAttach(value: unknown): RemoteDesktopBrowserAttach {
	assertRecord(value, "remoteDesktop attach");
	assertKeys(value, ["sessionId", "reconnectToken"], "remoteDesktop attach");
	assertString(value.sessionId, "sessionId", 128);
	assertOptionalString(value.reconnectToken, "reconnectToken", 512);
	const reconnectToken = value.reconnectToken;
	return {
		sessionId: value.sessionId,
		...(typeof reconnectToken === "string" ? { reconnectToken } : {}),
	};
}

/** 严格解析 Browser → Server 的 detach 请求。 */
export function parseRemoteDesktopBrowserDetach(value: unknown): RemoteDesktopBrowserDetach {
	assertRecord(value, "remoteDesktop detach");
	assertKeys(value, ["sessionId", "attachmentId"], "remoteDesktop detach");
	assertString(value.sessionId, "sessionId", 128);
	assertString(value.attachmentId, "attachmentId", 128);
	return { sessionId: value.sessionId, attachmentId: value.attachmentId };
}

/** 严格解析 Browser → Server 的信令请求。 */
export function parseRemoteDesktopBrowserSignal(value: unknown): RemoteDesktopBrowserSignal {
	assertRecord(value, "remoteDesktop signal");
	assertKeys(value, ["sessionId", "attachmentId", "signal"], "remoteDesktop signal");
	assertString(value.sessionId, "sessionId", 128);
	assertString(value.attachmentId, "attachmentId", 128);
	return {
		sessionId: value.sessionId,
		attachmentId: value.attachmentId,
		signal: parseRemoteDesktopSignal(value.signal),
	};
}

/** 严格解析 Browser → Server 的接管请求。 */
export function parseRemoteDesktopBrowserTakeover(value: unknown): RemoteDesktopBrowserTakeover {
	assertRecord(value, "remoteDesktop takeover");
	assertKeys(value, ["sessionId", "attachmentId"], "remoteDesktop takeover");
	assertString(value.sessionId, "sessionId", 128);
	assertString(value.attachmentId, "attachmentId", 128);
	return { sessionId: value.sessionId, attachmentId: value.attachmentId };
}

/** 安全化错误文本，禁止把底层路径、驱动错误或协议正文返回给 Browser。 */
export function safeRemoteDesktopErrorMessage(value: unknown): string {
	return typeof value === "string" && value.length > 0
		? value.slice(0, 200)
		: "Remote Desktop operation failed";
}
