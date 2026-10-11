// ── 会话宿主协议类型与运行时校验 ──
// 本模块自包含，不 import 同包其他模块，供 Shared/Server/Client/SDK/Frontend 共用。
// 所有跨信任边界的会话宿主消息必须先经 parse* 函数校验，非法消息不得进入业务服务。

// ── 稳定错误码 ──
export const SESSION_HOST_ERROR_CODES = [
	"SESSION_HOST_PROTOCOL_INVALID",
	"SESSION_HOST_UNAVAILABLE",
	"SESSION_HOST_INSTANCE_NOT_FOUND",
	"SESSION_HOST_INSTANCE_CONFLICT",
	"SESSION_HOST_INSTANCE_LIMIT_REACHED",
	"SESSION_HOST_OUTPUT_BACKLOG_EXCEEDED",
	"SESSION_HOST_NOT_CONFIRMED",
	"SESSION_HOST_INTERRUPTED_BY_CLIENT_UPDATE",
] as const;
export type SessionHostErrorCode = (typeof SESSION_HOST_ERROR_CODES)[number];

/** 会话宿主的稳定错误对象。 */
export function sessionHostError(
	code: SessionHostErrorCode,
	message: string,
): { code: SessionHostErrorCode; message: string } {
	return { code, message };
}

/** 可安全出站的错误消息（截断且不回显正文）。 */
export function safeSessionHostErrorMessage(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value.slice(0, 200) : "Session host operation failed";
}

// ── 状态与类型 allowlist ──
export const SESSION_HOST_STATES = ["running", "stopped", "failed", "unknown"] as const;
export type SessionHostState = (typeof SESSION_HOST_STATES)[number];

export const SESSION_HOST_KINDS = ["pi", "dsh"] as const;
export type SessionHostKind = (typeof SESSION_HOST_KINDS)[number];

export function isSessionHostState(v: unknown): v is SessionHostState {
	return typeof v === "string" && (SESSION_HOST_STATES as readonly string[]).includes(v);
}

export function isSessionHostKind(v: unknown): v is SessionHostKind {
	return typeof v === "string" && (SESSION_HOST_KINDS as readonly string[]).includes(v);
}

// ── 数据形状 ──

/** 单个受管理环境实例的公开信息（不含 PID、路径或正文）。 */
export interface SessionHostInstanceInfo {
	instanceId: string;
	kind: SessionHostKind;
	state: SessionHostState;
	startedAt: string;
	lastSeq: number;
}

/**
 * 宿主状态报告。
 * `available: false` 表示宿主暂时无法确认状态；此时不得携带 hostId 或实例，
 * 调用方必须按「未确认」处理，不得解读为「实例都已停止」。
 */
export interface SessionHostStatusReport {
	available: boolean;
	hostId: string | null;
	instances: SessionHostInstanceInfo[];
}

// ── 协议异常 ──
export class SessionHostProtocolError extends Error {
	readonly code = "SESSION_HOST_PROTOCOL_INVALID" as const;
	constructor(message: string) {
		super(message);
		this.name = "SessionHostProtocolError";
	}
}

// ── 基础校验 helper ──
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertRecord(v: unknown, what: string): asserts v is Record<string, unknown> {
	if (!isRecord(v)) throw new SessionHostProtocolError(`${what} 必须是对象`);
}

function assertKeys(v: Record<string, unknown>, allowed: Set<string>, what: string): void {
	for (const key of Object.keys(v)) {
		if (!allowed.has(key)) throw new SessionHostProtocolError(`${what} 含未知字段 ${key}`);
	}
}

function assertString(v: unknown, what: string, maxLength?: number): asserts v is string {
	if (typeof v !== "string" || v.length === 0) throw new SessionHostProtocolError(`${what} 必须是非空字符串`);
	if (maxLength !== undefined && v.length > maxLength) {
		throw new SessionHostProtocolError(`${what} 超过 ${maxLength} 字符上限`);
	}
}

function assertNonNegativeInt(v: unknown, what: string): asserts v is number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new SessionHostProtocolError(`${what} 必须是非负整数`);
	}
}

function assertDate(v: unknown, what: string): asserts v is string {
	assertString(v, what, 64);
	if (Number.isNaN(Date.parse(v))) throw new SessionHostProtocolError(`${what} 不是合法日期`);
}

// ── 请求与报告解析 ──

/** 解析启动请求；只接受 operationId/kind/cwd，未知字段与未知 kind 一律拒绝。 */
export function parseSessionHostStartRequest(v: unknown): {
	operationId: string;
	kind: SessionHostKind;
	cwd: string;
} {
	assertRecord(v, "sessionHost.start");
	assertKeys(v, new Set(["operationId", "kind", "cwd"]), "sessionHost.start");
	assertString(v.operationId, "sessionHost.start.operationId", 128);
	if (!isSessionHostKind(v.kind)) throw new SessionHostProtocolError("sessionHost.start.kind 不受支持");
	assertString(v.cwd, "sessionHost.start.cwd", 1024);
	return { operationId: v.operationId, kind: v.kind, cwd: v.cwd };
}

/** 解析停止请求；只接受 instanceId。 */
export function parseSessionHostStopRequest(v: unknown): { instanceId: string } {
	assertRecord(v, "sessionHost.stop");
	assertKeys(v, new Set(["instanceId"]), "sessionHost.stop");
	assertString(v.instanceId, "sessionHost.stop.instanceId", 128);
	return { instanceId: v.instanceId };
}

/** 解析宿主状态报告；available 与 hostId/instances 必须自洽。 */
export function parseSessionHostStatusReport(v: unknown): SessionHostStatusReport {
	assertRecord(v, "sessionHost.report");
	assertKeys(v, new Set(["available", "hostId", "instances"]), "sessionHost.report");
	if (typeof v.available !== "boolean") throw new SessionHostProtocolError("sessionHost.report.available 必须是布尔");
	if (!Array.isArray(v.instances)) throw new SessionHostProtocolError("sessionHost.report.instances 必须是数组");

	if (!v.available) {
		if (v.hostId !== null) {
			throw new SessionHostProtocolError("sessionHost.report 不可用时 hostId 必须为 null");
		}
		if (v.instances.length !== 0) {
			throw new SessionHostProtocolError("sessionHost.report 不可用时不得携带实例");
		}
		return { available: false, hostId: null, instances: [] };
	}

	assertString(v.hostId, "sessionHost.report.hostId", 128);
	const instances = v.instances.map((item) => {
		assertRecord(item, "sessionHost.instance");
		assertKeys(
			item,
			new Set(["instanceId", "kind", "state", "startedAt", "lastSeq"]),
			"sessionHost.instance",
		);
		assertString(item.instanceId, "sessionHost.instance.instanceId", 128);
		if (!isSessionHostKind(item.kind)) throw new SessionHostProtocolError("sessionHost.instance.kind 不受支持");
		if (!isSessionHostState(item.state)) throw new SessionHostProtocolError("sessionHost.instance.state 不受支持");
		assertDate(item.startedAt, "sessionHost.instance.startedAt");
		assertNonNegativeInt(item.lastSeq, "sessionHost.instance.lastSeq");
		return {
			instanceId: item.instanceId,
			kind: item.kind,
			state: item.state,
			startedAt: item.startedAt,
			lastSeq: item.lastSeq,
		};
	});
	return { available: true, hostId: v.hostId, instances };
}
