// ── 交互式终端协议类型与运行时校验 ──
// 本模块自包含，不 import 同包其他模块，供 Shared/Server/Client/SDK/Frontend 共用。
// 所有跨信任边界的终端消息必须先经 parse* 函数校验，非法消息不得进入业务服务。

// ── 稳定错误码 ──
export const TERMINAL_ERROR_CODES = [
	"TERMINAL_CLIENT_OFFLINE",
	"TERMINAL_UNSUPPORTED",
	"TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
	"TERMINAL_SESSION_NOT_FOUND",
	"TERMINAL_SESSION_LIMIT_REACHED",
	"TERMINAL_SHELL_NOT_AVAILABLE",
	"TERMINAL_SESSION_ENDED",
	"TERMINAL_READ_ONLY",
	"TERMINAL_CONTROL_PROTECTED",
	"TERMINAL_CONTROL_CONFLICT",
	"TERMINAL_PTY_SPAWN_FAILED",
	"TERMINAL_PTY_IO_FAILED",
	"TERMINAL_SNAPSHOT_FAILED",
	"TERMINAL_RESYNC_REQUIRED",
	"TERMINAL_CLIENT_RESTARTED",
	"TERMINAL_REQUEST_TIMEOUT",
	"TERMINAL_INPUT_TOO_LARGE",
	"TERMINAL_RATE_LIMITED",
	"TERMINAL_PROTOCOL_INVALID",
] as const;
export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];

/** 构造稳定终端错误对象。 */
export function terminalErrorCode(
	code: TerminalErrorCode,
	message: string,
): { code: TerminalErrorCode; message: string } {
	return { code, message };
}

/** 可安全出站的终端错误消息（截断且不回显正文）。 */
export function safeTerminalErrorMessage(value: unknown): string {
	return typeof value === "string" && value.length > 0
		? value.slice(0, 200)
		: "Terminal operation failed";
}

// ── 状态与审计 allowlist ──
export const TERMINAL_SESSION_STATUSES = [
	"starting",
	"active",
	"detached",
	"exited",
	"interrupted",
	"expired",
	"closed",
	"error",
] as const;
export type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number];

export const TERMINAL_AUDIT_EVENTS = [
	"created",
	"create_failed",
	"attached",
	"detached",
	"takeover",
	"closed",
	"expired",
	"exited",
	"interrupted",
] as const;
export type TerminalAuditEventName = (typeof TERMINAL_AUDIT_EVENTS)[number];

export function isTerminalSessionStatus(
	v: unknown,
): v is TerminalSessionStatus {
	return (
		typeof v === "string" &&
		(TERMINAL_SESSION_STATUSES as readonly string[]).includes(v)
	);
}

export function isTerminalAuditEventName(
	v: unknown,
): v is TerminalAuditEventName {
	return (
		typeof v === "string" &&
		(TERMINAL_AUDIT_EVENTS as readonly string[]).includes(v)
	);
}

// ── 边界常量（与设计文档 12.1 一致） ──
export const TerminalLimits = {
	maxSessionsPerClient: 5,
	reconnectGraceMs: 30_000,
	detachedTtlMs: 30 * 60_000,
	maxInputBytes: 64 * 1024,
	maxOutputChunkBytes: 64 * 1024,
	maxSnapshotBytes: 8 * 1024 * 1024,
	syncBacklogBytes: 2 * 1024 * 1024,
	scrollbackLines: 2_000,
	/** 慢消费者：live 状态下 ack 落后超过该块数即标记 resync */
	slowConsumerGapBlocks: 512,
	minCols: 20,
	maxCols: 500,
	minRows: 5,
	maxRows: 300,
	maxStateSessions: 5,
} as const;

/** 按 UTF-8 字节长度计算字符串大小（终端输入/输出限制按字节计）。 */
export function utf8ByteLength(value: string): number {
	// TextEncoder 浏览器/Node 通用；Buffer.byteLength 在浏览器不可用
	return new TextEncoder().encode(value).byteLength;
}

/** 校验终端尺寸是否在协议允许范围内。 */
export function isValidTerminalSize(cols: number, rows: number): boolean {
	return (
		Number.isInteger(cols) &&
		Number.isInteger(rows) &&
		cols >= TerminalLimits.minCols &&
		cols <= TerminalLimits.maxCols &&
		rows >= TerminalLimits.minRows &&
		rows <= TerminalLimits.maxRows
	);
}

// ── 协议异常 ──
export class TerminalProtocolError extends Error {
	readonly code = "TERMINAL_PROTOCOL_INVALID" as const;
	constructor(message: string) {
		super(message);
		this.name = "TerminalProtocolError";
	}
}

// ── 基础校验 helper ──
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertRecord(
	v: unknown,
	what: string,
): asserts v is Record<string, unknown> {
	if (!isRecord(v)) throw new TerminalProtocolError(`${what} 必须是对象`);
}

function assertKeys(
	v: Record<string, unknown>,
	allowed: Set<string>,
	what: string,
): void {
	for (const key of Object.keys(v)) {
		if (!allowed.has(key))
			throw new TerminalProtocolError(`${what} 含未知字段 ${key}`);
	}
}

function assertString(
	v: unknown,
	what: string,
	maxBytes?: number,
): asserts v is string {
	if (typeof v !== "string" || v.length === 0)
		throw new TerminalProtocolError(`${what} 必须是非空字符串`);
	if (maxBytes !== undefined && utf8ByteLength(v) > maxBytes)
		throw new TerminalProtocolError(`${what} 超过 ${maxBytes} 字节上限`);
}

function assertOptionalString(
	v: unknown,
	what: string,
	maxBytes: number,
): void {
	if (v !== undefined) assertString(v, what, maxBytes);
}

function assertSessionId(v: unknown): asserts v is string {
	assertString(v, "sessionId", 128);
}

function assertRequestId(v: unknown): asserts v is string {
	assertString(v, "requestId", 128);
}

function assertErrorCode(
	v: unknown,
	what: string,
): asserts v is TerminalErrorCode {
	assertString(v, what);
	if (!(TERMINAL_ERROR_CODES as readonly string[]).includes(v))
		throw new TerminalProtocolError(`${what} 不在 allowlist`);
}

function assertTerminalSize(v: Record<string, unknown>, what: string): void {
	const cols = v.cols;
	const rows = v.rows;
	if (
		typeof cols !== "number" ||
		typeof rows !== "number" ||
		!isValidTerminalSize(cols, rows)
	) {
		throw new TerminalProtocolError(`${what} 尺寸非法`);
	}
}

function assertDate(v: unknown, what: string): asserts v is string {
	assertString(v, what, 64);
	if (Number.isNaN(Date.parse(v)))
		throw new TerminalProtocolError(`${what} 不是合法日期`);
}

function assertOptionalDate(v: unknown, what: string): void {
	if (v !== undefined) assertDate(v, what);
}

// ── Capability ──

/** Client 终端能力摘要（注册时随 capabilityDetails 上报，不含路径）。 */
export interface TerminalCapabilityStatus {
	available: boolean;
	backend?: "conpty" | "pty";
	code?: TerminalErrorCode;
	message?: string;
}

export function parseTerminalCapabilityStatus(
	v: unknown,
): TerminalCapabilityStatus {
	assertRecord(v, "capabilityDetails.terminal");
	assertKeys(
		v,
		new Set(["available", "backend", "code", "message"]),
		"capabilityDetails.terminal",
	);
	if (typeof v.available !== "boolean")
		throw new TerminalProtocolError(
			"capabilityDetails.terminal.available 必须是布尔",
		);
	if (
		v.backend !== undefined &&
		v.backend !== "conpty" &&
		v.backend !== "pty"
	) {
		throw new TerminalProtocolError(
			"capabilityDetails.terminal.backend 不受支持",
		);
	}
	if (v.code !== undefined)
		assertErrorCode(v.code, "capabilityDetails.terminal.code");
	if (v.message !== undefined)
		assertString(v.message, "capabilityDetails.terminal.message", 200);
	return v as unknown as TerminalCapabilityStatus;
}

// ── Shell ──

/** Shell 信息（REST 返回，只含安全 ID/label/kind，不含可执行文件路径）。 */
export interface TerminalShellInfo {
	id: string;
	label: string;
	kind: "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "sh" | "other";
	isDefault: boolean;
}

export const TERMINAL_SHELL_KINDS = [
	"pwsh",
	"powershell",
	"cmd",
	"bash",
	"zsh",
	"sh",
	"other",
] as const;
export type TerminalShellKind = (typeof TERMINAL_SHELL_KINDS)[number];

export function parseTerminalShellInfo(v: unknown): TerminalShellInfo {
	assertRecord(v, "shell");
	assertKeys(v, new Set(["id", "label", "kind", "isDefault"]), "shell");
	assertString(v.id, "shell.id", 64);
	assertString(v.label, "shell.label", 64);
	if (
		typeof v.kind !== "string" ||
		!(TERMINAL_SHELL_KINDS as readonly string[]).includes(v.kind)
	) {
		throw new TerminalProtocolError("shell.kind 不受支持");
	}
	if (typeof v.isDefault !== "boolean")
		throw new TerminalProtocolError("shell.isDefault 必须是布尔");
	return v as unknown as TerminalShellInfo;
}

// ── Session（REST 信息） ──

/** 终端会话信息（REST 返回；不含终端正文与内部字段）。 */
export interface TerminalSessionInfo {
	sessionId: string;
	clientId: string;
	shellId: string;
	shellLabel: string;
	status: TerminalSessionStatus;
	cols: number;
	rows: number;
	createdByIdentityId: string | null;
	createdByName: string | null;
	createdAt: string;
	lastAttachedAt: string | null;
	detachedAt: string | null;
	expiresAt: string | null;
	endedAt: string | null;
	endReason: string | null;
	errorCode: string | null;
}

export function parseTerminalSessionInfo(v: unknown): TerminalSessionInfo {
	assertRecord(v, "session");
	assertKeys(
		v,
		new Set([
			"sessionId",
			"clientId",
			"shellId",
			"shellLabel",
			"status",
			"cols",
			"rows",
			"createdByIdentityId",
			"createdByName",
			"createdAt",
			"lastAttachedAt",
			"detachedAt",
			"expiresAt",
			"endedAt",
			"endReason",
			"errorCode",
		]),
		"session",
	);
	const r = v as Record<string, unknown>;
	assertSessionId(r.sessionId);
	assertString(r.clientId, "clientId", 128);
	assertString(r.shellId, "shellId", 64);
	assertString(r.shellLabel, "shellLabel", 64);
	if (!isTerminalSessionStatus(r.status))
		throw new TerminalProtocolError("session.status 不受支持");
	assertTerminalSize(r, "session");
	for (const key of ["createdByIdentityId", "createdByName"] as const) {
		if (r[key] !== null) assertOptionalString(r[key], key, 128);
	}
	assertDate(r.createdAt, "createdAt");
	for (const key of [
		"lastAttachedAt",
		"detachedAt",
		"expiresAt",
		"endedAt",
	] as const) {
		if (r[key] !== null) assertOptionalDate(r[key], key);
	}
	for (const key of ["endReason", "errorCode"] as const) {
		if (r[key] !== null) assertOptionalString(r[key], key, 200);
	}
	return v as unknown as TerminalSessionInfo;
}

// ── Audit ──

/** 终端审计条目（REST 返回；不含输入输出、token 或本地路径）。 */
export interface TerminalAuditInfo {
	id: string;
	sessionId: string;
	clientId: string;
	event: TerminalAuditEventName;
	identityId: string | null;
	actorName: string | null;
	source: string | null;
	result: "ok" | "error";
	reason: string | null;
	createdAt: string;
}

export function parseTerminalAuditInfo(v: unknown): TerminalAuditInfo {
	assertRecord(v, "audit");
	assertKeys(
		v,
		new Set([
			"id",
			"sessionId",
			"clientId",
			"event",
			"identityId",
			"actorName",
			"source",
			"result",
			"reason",
			"createdAt",
		]),
		"audit",
	);
	assertString(v.id, "audit.id", 128);
	assertSessionId(v.sessionId);
	assertString(v.clientId, "clientId", 128);
	if (!isTerminalAuditEventName(v.event))
		throw new TerminalProtocolError("audit.event 不受支持");
	for (const key of ["identityId", "actorName", "source"] as const) {
		if (v[key] !== null) assertOptionalString(v[key], key, 128);
	}
	if (v.result !== "ok" && v.result !== "error")
		throw new TerminalProtocolError("audit.result 不受支持");
	if (v.reason !== null) assertOptionalString(v.reason, "audit.reason", 200);
	assertDate(v.createdAt, "createdAt");
	return v as unknown as TerminalAuditInfo;
}

// ── REST 创建请求 ──

/** 终端创建请求（REST body；禁止 executable/args/cwd/env）。 */
export interface TerminalSessionCreateRequest {
	shellId: string;
	cols: number;
	rows: number;
}

export function parseTerminalSessionCreateRequest(
	v: unknown,
): TerminalSessionCreateRequest {
	assertRecord(v, "create");
	assertKeys(v, new Set(["shellId", "cols", "rows"]), "create");
	assertString(v.shellId, "shellId", 64);
	if (
		typeof v.cols !== "number" ||
		typeof v.rows !== "number" ||
		!isValidTerminalSize(v.cols, v.rows)
	) {
		throw new TerminalProtocolError("create 尺寸非法");
	}
	return v as unknown as TerminalSessionCreateRequest;
}

// ── Client 侧请求（Server → Client） ──

export type TerminalClientActionName =
	| "shells.list"
	| "session.create"
	| "session.attach"
	| "session.detach"
	| "session.input"
	| "session.resize"
	| "session.snapshot"
	| "session.close";

/** Server → Client 终端动作（判别联合）。 */
export type TerminalClientRequest =
	| { requestId: string; action: "shells.list" }
	| {
			requestId: string;
			action: "session.create";
			sessionId: string;
			shellId: string;
			cols: number;
			rows: number;
	  }
	| { requestId: string; action: "session.attach"; sessionId: string }
	| { requestId: string; action: "session.detach"; sessionId: string }
	| {
			requestId: string;
			action: "session.input";
			sessionId: string;
			data: string;
	  }
	| {
			requestId: string;
			action: "session.resize";
			sessionId: string;
			cols: number;
			rows: number;
	  }
	| { requestId: string; action: "session.snapshot"; sessionId: string }
	| {
			requestId: string;
			action: "session.close";
			sessionId: string;
			reason: "closed" | "expired";
	  };

const CLIENT_REQUEST_KEYS: Record<TerminalClientActionName, Set<string>> = {
	"shells.list": new Set(["requestId", "action"]),
	"session.create": new Set([
		"requestId",
		"action",
		"sessionId",
		"shellId",
		"cols",
		"rows",
	]),
	"session.attach": new Set(["requestId", "action", "sessionId"]),
	"session.detach": new Set(["requestId", "action", "sessionId"]),
	"session.input": new Set(["requestId", "action", "sessionId", "data"]),
	"session.resize": new Set([
		"requestId",
		"action",
		"sessionId",
		"cols",
		"rows",
	]),
	"session.snapshot": new Set(["requestId", "action", "sessionId"]),
	"session.close": new Set(["requestId", "action", "sessionId", "reason"]),
};

/** 解析 Server → Client 终端请求；非法请求抛 TerminalProtocolError。 */
export function parseTerminalClientRequest(v: unknown): TerminalClientRequest {
	assertRecord(v, "request");
	assertRequestId(v.requestId);
	if (typeof v.action !== "string" || !(v.action in CLIENT_REQUEST_KEYS)) {
		throw new TerminalProtocolError(`未知 action ${String(v.action)}`);
	}
	const action = v.action as TerminalClientActionName;
	assertKeys(v, CLIENT_REQUEST_KEYS[action], `request.${action}`);
	switch (action) {
		case "shells.list":
			return v as unknown as TerminalClientRequest;
		case "session.create":
			assertSessionId(v.sessionId);
			assertString(v.shellId, "shellId", 64);
			assertTerminalSize(v, "create");
			break;
		case "session.attach":
		case "session.detach":
		case "session.snapshot":
			assertSessionId(v.sessionId);
			break;
		case "session.input": {
			assertSessionId(v.sessionId);
			assertString(v.data, "data", TerminalLimits.maxInputBytes);
			break;
		}
		case "session.resize":
			assertSessionId(v.sessionId);
			assertTerminalSize(v, "resize");
			break;
		case "session.close": {
			assertSessionId(v.sessionId);
			if (v.reason !== "closed" && v.reason !== "expired")
				throw new TerminalProtocolError("close.reason 不受支持");
			break;
		}
	}
	return v as unknown as TerminalClientRequest;
}

// ── Client 侧响应（Client → Server） ──

/** Client → Server 终端动作响应（判别联合；错误为稳定错误码）。 */
export type TerminalClientResponse =
	| {
			requestId: string;
			ok: true;
			action: "shells.list";
			shells: TerminalShellInfo[];
	  }
	| {
			requestId: string;
			ok: true;
			action: "session.create";
			sessionId: string;
			status: "active" | "detached";
	  }
	| {
			requestId: string;
			ok: true;
			action: "session.attach" | "session.snapshot";
			sessionId: string;
			snapshot: string;
			snapshotSeq: number;
			cols: number;
			rows: number;
			historyTruncated: boolean;
	  }
	| { requestId: string; ok: true; action: "session.detach"; sessionId: string }
	| { requestId: string; ok: true; action: "session.input"; sessionId: string }
	| {
			requestId: string;
			ok: true;
			action: "session.resize";
			sessionId: string;
			cols: number;
			rows: number;
	  }
	| {
			requestId: string;
			ok: true;
			action: "session.close";
			sessionId: string;
			status: "closed";
	  }
	| {
			requestId: string;
			ok: false;
			action?: never;
			error: { code: TerminalErrorCode; message: string };
	  };

/** 解析 Client → Server 终端响应；非法响应抛 TerminalProtocolError。 */
export function parseTerminalClientResponse(
	v: unknown,
): TerminalClientResponse {
	assertRecord(v, "response");
	assertRequestId(v.requestId);
	if (typeof v.ok !== "boolean")
		throw new TerminalProtocolError("response.ok 必须是布尔");
	if (v.ok === false) {
		assertKeys(v, new Set(["requestId", "ok", "error"]), "response");
		assertRecord(v.error, "response.error");
		assertKeys(v.error, new Set(["code", "message"]), "response.error");
		assertErrorCode(v.error.code, "response.error.code");
		assertString(v.error.message, "response.error.message", 200);
		return v as unknown as TerminalClientResponse;
	}
	if (typeof v.action !== "string")
		throw new TerminalProtocolError("response.action 必须是字符串");
	switch (v.action) {
		case "shells.list": {
			assertKeys(
				v,
				new Set(["requestId", "ok", "action", "shells"]),
				"response",
			);
			if (!Array.isArray(v.shells) || v.shells.length > 10)
				throw new TerminalProtocolError("response.shells 必须是数组");
			for (const shell of v.shells) parseTerminalShellInfo(shell);
			return v as unknown as TerminalClientResponse;
		}
		case "session.create": {
			assertKeys(
				v,
				new Set(["requestId", "ok", "action", "sessionId", "status"]),
				"response",
			);
			assertSessionId(v.sessionId);
			if (v.status !== "active" && v.status !== "detached")
				throw new TerminalProtocolError("create.status 不受支持");
			return v as unknown as TerminalClientResponse;
		}
		case "session.attach":
		case "session.snapshot": {
			assertKeys(
				v,
				new Set([
					"requestId",
					"ok",
					"action",
					"sessionId",
					"snapshot",
					"snapshotSeq",
					"cols",
					"rows",
					"historyTruncated",
				]),
				"response",
			);
			assertSessionId(v.sessionId);
			assertString(
				v.snapshot as unknown,
				"snapshot",
				TerminalLimits.maxSnapshotBytes,
			);
			if (
				typeof v.snapshotSeq !== "number" ||
				!Number.isInteger(v.snapshotSeq) ||
				v.snapshotSeq < 0
			) {
				throw new TerminalProtocolError("snapshotSeq 必须是正整数");
			}
			assertTerminalSize(v, "response");
			if (typeof v.historyTruncated !== "boolean")
				throw new TerminalProtocolError("historyTruncated 必须是布尔");
			return v as unknown as TerminalClientResponse;
		}
		case "session.detach":
		case "session.input": {
			assertKeys(
				v,
				new Set(["requestId", "ok", "action", "sessionId"]),
				"response",
			);
			assertSessionId(v.sessionId);
			return v as unknown as TerminalClientResponse;
		}
		case "session.resize": {
			assertKeys(
				v,
				new Set(["requestId", "ok", "action", "sessionId", "cols", "rows"]),
				"response",
			);
			assertSessionId(v.sessionId);
			assertTerminalSize(v, "response");
			return v as unknown as TerminalClientResponse;
		}
		case "session.close": {
			assertKeys(
				v,
				new Set(["requestId", "ok", "action", "sessionId", "status"]),
				"response",
			);
			assertSessionId(v.sessionId);
			if (v.status !== "closed")
				throw new TerminalProtocolError("close.status 不受支持");
			return v as unknown as TerminalClientResponse;
		}
		default:
			throw new TerminalProtocolError(`未知 action ${String(v.action)}`);
	}
}

// ── 输出块 ──

/** Client → Server 终端输出块（seq 单调递增）。 */
export interface TerminalOutputChunk {
	sessionId: string;
	seq: number;
	data: string;
}

/** 解析终端输出块；非法块抛 TerminalProtocolError。 */
export function parseTerminalOutputChunk(v: unknown): TerminalOutputChunk {
	assertRecord(v, "chunk");
	assertKeys(v, new Set(["sessionId", "seq", "data"]), "chunk");
	assertSessionId(v.sessionId);
	if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 1) {
		throw new TerminalProtocolError("chunk.seq 必须是正整数");
	}
	assertString(v.data, "data", TerminalLimits.maxOutputChunkBytes);
	return v as unknown as TerminalOutputChunk;
}

// ── 退出报告 ──

/** Client → Server Shell 自行退出报告。 */
export interface TerminalExitReport {
	sessionId: string;
	exitCode: number;
}

/** 解析 Shell 退出报告；非法报告抛 TerminalProtocolError。 */
export function parseTerminalExitReport(v: unknown): TerminalExitReport {
	assertRecord(v, "exit");
	assertKeys(v, new Set(["sessionId", "exitCode"]), "exit");
	assertSessionId(v.sessionId);
	if (typeof v.exitCode !== "number" || !Number.isInteger(v.exitCode)) {
		throw new TerminalProtocolError("exit.exitCode 必须是整数");
	}
	return v as unknown as TerminalExitReport;
}

// ── 状态对账报告 ──

/** Client → Server 终端状态对账条目。 */
export interface TerminalStateSession {
	sessionId: string;
	shellId: string;
	status: "active" | "detached";
	cols: number;
	rows: number;
	lastSeq: number;
	detachedAt?: string;
	expiresAt?: string;
}

/** Client → Server 终端状态对账报告（不含 cwd/env/executable/输出）。 */
export interface TerminalStateReport {
	clientId: string;
	generationId: string;
	sessions: TerminalStateSession[];
}

/** Server → Client 状态对账 ack。 */
export interface TerminalStateAck {
	acceptedSessionIds: string[];
	closeSessionIds: string[];
}

/** 解析 Client → Server 状态报告；非法报告抛 TerminalProtocolError。 */
export function parseTerminalStateReport(v: unknown): TerminalStateReport {
	assertRecord(v, "state");
	assertKeys(v, new Set(["clientId", "generationId", "sessions"]), "state");
	assertString(v.clientId, "clientId", 128);
	assertString(v.generationId, "generationId", 128);
	if (
		!Array.isArray(v.sessions) ||
		v.sessions.length > TerminalLimits.maxStateSessions
	) {
		throw new TerminalProtocolError("state.sessions 数量超过上限");
	}
	const seen = new Set<string>();
	for (const raw of v.sessions) {
		assertRecord(raw, "state.sessions[]");
		assertKeys(
			raw,
			new Set([
				"sessionId",
				"shellId",
				"status",
				"cols",
				"rows",
				"lastSeq",
				"detachedAt",
				"expiresAt",
			]),
			"state.sessions[]",
		);
		assertSessionId(raw.sessionId);
		if (seen.has(raw.sessionId))
			throw new TerminalProtocolError("state.sessions 含重复 sessionId");
		seen.add(raw.sessionId);
		assertString(raw.shellId, "shellId", 64);
		if (raw.status !== "active" && raw.status !== "detached") {
			throw new TerminalProtocolError("state.sessions[].status 不受支持");
		}
		assertTerminalSize(raw, "state.sessions[]");
		if (
			typeof raw.lastSeq !== "number" ||
			!Number.isInteger(raw.lastSeq) ||
			raw.lastSeq < 0
		) {
			throw new TerminalProtocolError("state.sessions[].lastSeq 必须是正整数");
		}
		assertOptionalDate(raw.detachedAt, "state.sessions[].detachedAt");
		assertOptionalDate(raw.expiresAt, "state.sessions[].expiresAt");
	}
	return v as unknown as TerminalStateReport;
}

/** 解析 Server → Client 状态 ack；非法 ack 抛 TerminalProtocolError。 */
export function parseTerminalStateAck(v: unknown): TerminalStateAck {
	assertRecord(v, "ack");
	assertKeys(v, new Set(["acceptedSessionIds", "closeSessionIds"]), "ack");
	for (const key of ["acceptedSessionIds", "closeSessionIds"] as const) {
		if (!Array.isArray(v[key]))
			throw new TerminalProtocolError(`ack.${key} 必须是数组`);
		for (const id of v[key] as unknown[]) {
			if (typeof id !== "string" || id.length === 0 || id.length > 128) {
				throw new TerminalProtocolError(`ack.${key} 必须是非空字符串`);
			}
		}
	}
	return v as unknown as TerminalStateAck;
}

// ── 浏览器 → Server 消息 ──

/** 浏览器 attach 请求。 */
export interface TerminalBrowserAttach {
	sessionId: string;
	reconnectToken?: string;
}

export function parseTerminalBrowserAttach(v: unknown): TerminalBrowserAttach {
	assertRecord(v, "attach");
	assertKeys(v, new Set(["sessionId", "reconnectToken"]), "attach");
	assertSessionId(v.sessionId);
	if (v.reconnectToken !== undefined)
		assertString(v.reconnectToken, "reconnectToken", 128);
	return v as unknown as TerminalBrowserAttach;
}

/** 浏览器 input 请求。 */
export interface TerminalBrowserInput {
	sessionId: string;
	attachmentId: string;
	data: string;
}

export function parseTerminalBrowserInput(v: unknown): TerminalBrowserInput {
	assertRecord(v, "input");
	assertKeys(v, new Set(["sessionId", "attachmentId", "data"]), "input");
	assertSessionId(v.sessionId);
	assertString(v.attachmentId, "attachmentId", 128);
	assertString(v.data, "data", TerminalLimits.maxInputBytes);
	return v as unknown as TerminalBrowserInput;
}

/** 浏览器 resize 请求。 */
export interface TerminalBrowserResize {
	sessionId: string;
	attachmentId: string;
	cols: number;
	rows: number;
}

export function parseTerminalBrowserResize(v: unknown): TerminalBrowserResize {
	assertRecord(v, "resize");
	assertKeys(
		v,
		new Set(["sessionId", "attachmentId", "cols", "rows"]),
		"resize",
	);
	assertSessionId(v.sessionId);
	assertString(v.attachmentId, "attachmentId", 128);
	assertTerminalSize(v, "resize");
	return v as unknown as TerminalBrowserResize;
}

/** 浏览器接管请求。 */
export interface TerminalBrowserTakeover {
	sessionId: string;
	attachmentId: string;
}

export function parseTerminalBrowserTakeover(
	v: unknown,
): TerminalBrowserTakeover {
	assertRecord(v, "takeover");
	assertKeys(v, new Set(["sessionId", "attachmentId"]), "takeover");
	assertSessionId(v.sessionId);
	assertString(v.attachmentId, "attachmentId", 128);
	return v as unknown as TerminalBrowserTakeover;
}

/** 浏览器 detach 请求。 */
export interface TerminalBrowserDetach {
	sessionId: string;
	attachmentId: string;
}

export function parseTerminalBrowserDetach(v: unknown): TerminalBrowserDetach {
	assertRecord(v, "detach");
	assertKeys(v, new Set(["sessionId", "attachmentId"]), "detach");
	assertSessionId(v.sessionId);
	assertString(v.attachmentId, "attachmentId", 128);
	return v as unknown as TerminalBrowserDetach;
}

/** 浏览器输出 ack（慢消费者检测）。 */
export interface TerminalBrowserAckOutput {
	sessionId: string;
	attachmentId: string;
	seq: number;
}

export function parseTerminalBrowserAckOutput(
	v: unknown,
): TerminalBrowserAckOutput {
	assertRecord(v, "ack-output");
	assertKeys(v, new Set(["sessionId", "attachmentId", "seq"]), "ack-output");
	assertSessionId(v.sessionId);
	assertString(v.attachmentId, "attachmentId", 128);
	if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) {
		throw new TerminalProtocolError("ack-output.seq 必须是正整数");
	}
	return v as unknown as TerminalBrowserAckOutput;
}

/** 浏览器 resync 请求。 */
export interface TerminalBrowserResync {
	sessionId: string;
	attachmentId: string;
}

export function parseTerminalBrowserResync(v: unknown): TerminalBrowserResync {
	assertRecord(v, "resync");
	assertKeys(v, new Set(["sessionId", "attachmentId"]), "resync");
	assertSessionId(v.sessionId);
	assertString(v.attachmentId, "attachmentId", 128);
	return v as unknown as TerminalBrowserResync;
}

// ── Server → 浏览器 消息 ──

/** attach 成功响应。 */
export interface TerminalBrowserAttached {
	sessionId: string;
	attachmentId: string;
	reconnectToken: string;
	mode: "operator" | "viewer";
	controlProtectedUntil: string | null;
}

export function parseTerminalBrowserAttached(
	v: unknown,
): TerminalBrowserAttached {
	assertRecord(v, "attached");
	assertKeys(
		v,
		new Set([
			"sessionId",
			"attachmentId",
			"reconnectToken",
			"mode",
			"controlProtectedUntil",
		]),
		"attached",
	);
	assertSessionId(v.sessionId);
	assertString(v.attachmentId, "attachmentId", 128);
	assertString(v.reconnectToken, "reconnectToken", 128);
	if (v.mode !== "operator" && v.mode !== "viewer")
		throw new TerminalProtocolError("attached.mode 不受支持");
	if (v.controlProtectedUntil !== null)
		assertOptionalDate(v.controlProtectedUntil, "controlProtectedUntil");
	return v as unknown as TerminalBrowserAttached;
}

/** 终端快照（attach/resync 恢复画面）。 */
export interface TerminalSnapshotMessage {
	sessionId: string;
	snapshot: string;
	snapshotSeq: number;
	cols: number;
	rows: number;
	historyTruncated: boolean;
}

export function parseTerminalSnapshotMessage(
	v: unknown,
): TerminalSnapshotMessage {
	assertRecord(v, "snapshot");
	assertKeys(
		v,
		new Set([
			"sessionId",
			"snapshot",
			"snapshotSeq",
			"cols",
			"rows",
			"historyTruncated",
		]),
		"snapshot",
	);
	assertSessionId(v.sessionId);
	assertString(v.snapshot, "snapshot", TerminalLimits.maxSnapshotBytes);
	if (
		typeof v.snapshotSeq !== "number" ||
		!Number.isInteger(v.snapshotSeq) ||
		v.snapshotSeq < 0
	) {
		throw new TerminalProtocolError("snapshot.snapshotSeq 必须是正整数");
	}
	assertTerminalSize(v, "snapshot");
	if (typeof v.historyTruncated !== "boolean")
		throw new TerminalProtocolError("snapshot.historyTruncated 必须是布尔");
	return v as unknown as TerminalSnapshotMessage;
}

/** 控制权状态广播。 */
export interface TerminalControlState {
	sessionId: string;
	mode: "operator" | "viewer";
	operatorName: string | null;
	controlProtectedUntil: string | null;
	canTakeover: boolean;
}

export function parseTerminalControlState(v: unknown): TerminalControlState {
	assertRecord(v, "control");
	assertKeys(
		v,
		new Set([
			"sessionId",
			"mode",
			"operatorName",
			"controlProtectedUntil",
			"canTakeover",
		]),
		"control",
	);
	assertSessionId(v.sessionId);
	if (v.mode !== "operator" && v.mode !== "viewer")
		throw new TerminalProtocolError("control.mode 不受支持");
	if (v.operatorName !== null)
		assertOptionalString(v.operatorName, "operatorName", 128);
	if (v.controlProtectedUntil !== null)
		assertOptionalDate(v.controlProtectedUntil, "controlProtectedUntil");
	if (typeof v.canTakeover !== "boolean")
		throw new TerminalProtocolError("control.canTakeover 必须是布尔");
	return v as unknown as TerminalControlState;
}

/** 会话状态推送。 */
export interface TerminalSessionStateMessage {
	sessionId: string;
	status: TerminalSessionStatus;
	reason?: string;
}

export function parseTerminalSessionStateMessage(
	v: unknown,
): TerminalSessionStateMessage {
	assertRecord(v, "state-message");
	assertKeys(v, new Set(["sessionId", "status", "reason"]), "state-message");
	assertSessionId(v.sessionId);
	if (!isTerminalSessionStatus(v.status))
		throw new TerminalProtocolError("state-message.status 不受支持");
	if (v.reason !== undefined) assertString(v.reason, "reason", 200);
	return v as unknown as TerminalSessionStateMessage;
}

/** 终端稳定错误消息。 */
export interface TerminalErrorMessage {
	sessionId: string;
	code: TerminalErrorCode;
	message: string;
}

export function parseTerminalError(v: unknown): TerminalErrorMessage {
	assertRecord(v, "error");
	assertKeys(v, new Set(["sessionId", "code", "message"]), "error");
	assertString(v.sessionId, "sessionId", 128);
	assertErrorCode(v.code, "error.code");
	assertString(v.message, "message", 200);
	return v as unknown as TerminalErrorMessage;
}

/** 通用 ack 判别联合（Socket.IO ack / REST 错误体）。 */
export type TerminalAck<T> =
	| { ok: true; data: T }
	| { ok: false; error: { code: TerminalErrorCode; message: string } };
