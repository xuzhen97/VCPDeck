/**
 * Remote Dev Session 的跨运行时契约。
 *
 * RDS 是独立会话域，不是 A2A Task、Job 或 TerminalSession。所有跨信任边界
 * 输入必须先经过本模块的严格 parser；未知字段与未知状态不得猜测。
 */
import type {
	AcpAdapterEvent,
	AcpPermissionOutcome,
} from "./acp.js";
import { parseAcpAdapterEvent } from "./acp.js";

export const REMOTE_DEV_STATES = [
	"starting",
	"active",
	"detached",
	"disconnected",
	"interrupted",
	"closing",
	"closed",
	"failed",
] as const;
export type RemoteDevState = (typeof REMOTE_DEV_STATES)[number];

/**
 * 已结束的 RDS 状态。
 *
 * 用于"是否还能操作/是否可续接"的判定：Server 与前端必须共用这一份，
 * 否则前端会给出点了必然失败（`RDS_RESUME_NOT_ALLOWED`）的入口。
 */
export const REMOTE_DEV_TERMINAL_STATES = [
	"closed",
	"failed",
	"interrupted",
] as const satisfies readonly RemoteDevState[];

export const REMOTE_DEV_AGENT_STATES = [
	"starting",
	"ready",
	"busy",
	"idle",
	"exited",
	"failed",
] as const;
export type RemoteDevAgentState = (typeof REMOTE_DEV_AGENT_STATES)[number];

export const REMOTE_DEV_ATTACHMENT_MODES = ["operator", "viewer"] as const;
export type RemoteDevAttachmentMode =
	(typeof REMOTE_DEV_ATTACHMENT_MODES)[number];

export const REMOTE_DEV_PORT_STATUSES = [
	"opening",
	"open",
	"failed",
	"closing",
	"closed",
] as const;
export type RemoteDevPortStatus = (typeof REMOTE_DEV_PORT_STATUSES)[number];

export const REMOTE_DEV_PORT_PROTOCOLS = ["tcp"] as const;
export type RemoteDevPortProtocol = (typeof REMOTE_DEV_PORT_PROTOCOLS)[number];

export const RDS_LIMITS = {
	maxSessionIdBytes: 128,
	maxLabelBytes: 80,
	maxWorkspaceBytes: 2048,
	maxPromptBytes: 256 * 1024,
	maxPortsPerSession: 8,
	minPort: 1024,
	maxPort: 65535,
	maxFrameBytes: 64 * 1024,
	maxReconnectTokenBytes: 512,
} as const;

export class RemoteDevProtocolError extends Error {
	readonly code = "RDS_PROTOCOL_INVALID" as const;

	constructor(message: string) {
		super(message);
		this.name = "RemoteDevProtocolError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
	return textEncoder.encode(value).length;
}

function assertRecord(
	value: unknown,
	what: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new RemoteDevProtocolError(`${what} 必须是对象`);
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	what: string,
): void {
	const set = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!set.has(key)) {
			throw new RemoteDevProtocolError(`${what} 含未知字段 ${key}`);
		}
	}
}

function assertString(
	value: unknown,
	what: string,
	maxBytes: number,
	allowEmpty = false,
): asserts value is string {
	if (typeof value !== "string") {
		throw new RemoteDevProtocolError(`${what} 必须是字符串`);
	}
	if (!allowEmpty && value.length === 0) {
		throw new RemoteDevProtocolError(`${what} 不能为空`);
	}
	if (byteLength(value) > maxBytes) {
		throw new RemoteDevProtocolError(`${what} 超过 ${maxBytes} 字节`);
	}
}

function optionalString(
	value: unknown,
	what: string,
	maxBytes: number,
): string | undefined {
	if (value === undefined) return undefined;
	assertString(value, what, maxBytes);
	return value;
}

function assertPort(value: unknown, what: string): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < RDS_LIMITS.minPort ||
		value > RDS_LIMITS.maxPort
	) {
		throw new RemoteDevProtocolError(
			`${what} 必须是 ${RDS_LIMITS.minPort}-${RDS_LIMITS.maxPort} 的整数`,
		);
	}
}

export interface RemoteDevSessionCreateRequest {
	clientId: string;
	agentPlacementId: string;
	workspaceRoot: string;
	label?: string;
	/** 续接来源：已终态、且带 acpSessionId 的 RDS 会话 id；缺省表示新建上下文。 */
	resumeFromSessionId?: string;
}

export interface RemoteDevSessionInfo {
	sessionId: string;
	clientId: string;
	agentPlacementId: string;
	workspaceRoot: string;
	label?: string;
	state: RemoteDevState;
	agentStatus: RemoteDevAgentState;
	generationId: string;
	createdAt: string;
	updatedAt: string;
	lastAttachedAt?: string;
	expiresAt?: string;
	closedAt?: string;
	closeReason?: string;
	cleanupStatus: "unknown" | "complete" | "partial" | "failed";
	/**
	 * ACP agent 侧会话标识；不透明，仅用于续接与排障，不是对话正文。
	 * 旧 Client 不上报时为缺省。
	 */
	acpSessionId?: string;
}

export interface RemoteDevPortCreateRequest {
	remotePort: number;
	label?: string;
}

export interface RemoteDevPortInfo {
	portId: string;
	sessionId: string;
	remotePort: number;
	protocol: RemoteDevPortProtocol;
	label?: string;
	status: RemoteDevPortStatus;
	createdAt: string;
	expiresAt?: string;
	closedAt?: string;
	lastErrorCode?: string;
}

export interface RemoteDevForwardToken {
	token: string;
	expiresAt: string;
}

export interface RemoteDevCommandResult {
	requestId: string;
	ok: boolean;
	sessionId?: string;
	generationId?: string;
	stopReason?: string;
	error?: { code: string; message: string };
}

export type RemoteDevClientCommand =
	| {
			action: "session.create";
			requestId: string;
			sessionId: string;
			agentPlacementId: string;
			workspaceRoot: string;
			workspaceRoots: string[];
			command: string;
			args: string[];
			cwd: string;
			/** 存在时要求 Client 走 ACP `session/resume` 续接该 ACP 会话。 */
			acpSessionId?: string;
	  }
	| {
			action: "session.close";
			requestId: string;
			sessionId: string;
			reason?: string;
	  }
	| {
			action: "agent.prompt";
			requestId: string;
			sessionId: string;
			text: string;
	  }
	| {
			action: "agent.cancel";
			requestId: string;
			sessionId: string;
	  }
	| {
			action: "agent.permission";
			requestId: string;
			sessionId: string;
			permissionRequestId: string;
			outcome: AcpPermissionOutcome;
	  };

export type RemoteDevClientEvent =
	| {
			type: "agent.event";
			sessionId: string;
			generationId: string;
			seq: number;
			event: AcpAdapterEvent;
	  }
	| {
			type: "agent.status";
			sessionId: string;
			generationId: string;
			status: RemoteDevAgentState;
	  }
	| {
			type: "session.ended";
			sessionId: string;
			generationId: string;
			reason: "closed" | "exited" | "error";
			code?: string;
	  };

export type RemoteDevBrowserEvent =
	| {
			type: "state";
			session: RemoteDevSessionInfo;
			ports: RemoteDevPortInfo[];
	  }
	| {
			type: "agent.event";
			sessionId: string;
			seq: number;
			event: AcpAdapterEvent;
	  }
	| { type: "port.state"; port: RemoteDevPortInfo }
	| { type: "closed"; sessionId: string; reason?: string }
	| { type: "error"; code: string; message: string };

export interface RemoteDevBrowserAttach {
	sessionId: string;
	reconnectToken?: string;
}

export interface RemoteDevBrowserPrompt {
	sessionId: string;
	text: string;
}

export interface RemoteDevBrowserCancel {
	sessionId: string;
}

export interface RemoteDevBrowserPermission {
	sessionId: string;
	requestId: string;
	optionId?: string;
}

export interface RemoteDevBrowserResync {
	sessionId: string;
	sinceSeq?: number;
}

export interface RemoteDevBrowserPortOpen {
	sessionId: string;
	remotePort: number;
	label?: string;
}

export interface RemoteDevBrowserPortClose {
	sessionId: string;
	portId: string;
}

/** 解析创建请求；workspaceRoot 只是待校验路径，不是授权本身。 */
export function parseRemoteDevSessionCreateRequest(
	value: unknown,
): RemoteDevSessionCreateRequest {
	assertRecord(value, "remote-dev create");
	assertKeys(
		value,
		["clientId", "agentPlacementId", "workspaceRoot", "label", "resumeFromSessionId"],
		"remote-dev create",
	);
	assertString(value.clientId, "clientId", 128);
	assertString(value.agentPlacementId, "agentPlacementId", 128);
	assertString(value.workspaceRoot, "workspaceRoot", RDS_LIMITS.maxWorkspaceBytes);
	const label = optionalString(value.label, "label", RDS_LIMITS.maxLabelBytes);
	const resumeFromSessionId = optionalString(
		value.resumeFromSessionId,
		"resumeFromSessionId",
		128,
	);
	return {
		clientId: value.clientId,
		agentPlacementId: value.agentPlacementId,
		workspaceRoot: value.workspaceRoot,
		...(label ? { label } : {}),
		...(resumeFromSessionId ? { resumeFromSessionId } : {}),
	};
}

/** Client → Server：创建成功后上报 ACP 侧会话标识（独立事件，不改动 rds:command-result）。 */
export interface RemoteDevAcpSessionReport {
	sessionId: string;
	generationId: string;
	acpSessionId: string;
}

/**
 * 解析 `rds:acp-session` 上报。
 *
 * 新事件而不是给 `rds:command-result` 加字段：旧 Server 对结果做严格解析，
 * 多一个字段会让整条结果被丢弃，创建会话会退化成超时。
 */
export function parseRemoteDevAcpSessionReport(
	value: unknown,
): RemoteDevAcpSessionReport {
	assertRecord(value, "rds:acp-session");
	assertKeys(
		value,
		["sessionId", "generationId", "acpSessionId"],
		"rds:acp-session",
	);
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	assertString(value.generationId, "generationId", RDS_LIMITS.maxSessionIdBytes);
	assertString(value.acpSessionId, "acpSessionId", RDS_LIMITS.maxSessionIdBytes);
	return {
		sessionId: value.sessionId,
		generationId: value.generationId,
		acpSessionId: value.acpSessionId,
	};
}

export function parseRemoteDevPortCreateRequest(
	value: unknown,
): RemoteDevPortCreateRequest {
	assertRecord(value, "remote-dev port create");
	assertKeys(value, ["remotePort", "label"], "remote-dev port create");
	assertPort(value.remotePort, "remotePort");
	const label = optionalString(value.label, "label", RDS_LIMITS.maxLabelBytes);
	return {
		remotePort: value.remotePort,
		...(label ? { label } : {}),
	};
}

export function parseRemoteDevBrowserAttach(
	value: unknown,
): RemoteDevBrowserAttach {
	assertRecord(value, "rds:attach");
	assertKeys(value, ["sessionId", "reconnectToken"], "rds:attach");
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	const reconnectToken = optionalString(
		value.reconnectToken,
		"reconnectToken",
		RDS_LIMITS.maxReconnectTokenBytes,
	);
	return {
		sessionId: value.sessionId,
		...(reconnectToken ? { reconnectToken } : {}),
	};
}

export function parseRemoteDevBrowserPrompt(
	value: unknown,
): RemoteDevBrowserPrompt {
	assertRecord(value, "rds:prompt");
	assertKeys(value, ["sessionId", "text"], "rds:prompt");
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	assertString(value.text, "text", RDS_LIMITS.maxPromptBytes);
	return { sessionId: value.sessionId, text: value.text };
}

export function parseRemoteDevBrowserCancel(
	value: unknown,
): RemoteDevBrowserCancel {
	assertRecord(value, "rds:cancel");
	assertKeys(value, ["sessionId"], "rds:cancel");
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	return { sessionId: value.sessionId };
}

export function parseRemoteDevBrowserDetach(
	value: unknown,
): RemoteDevBrowserCancel {
	assertRecord(value, "rds:detach");
	assertKeys(value, ["sessionId"], "rds:detach");
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	return { sessionId: value.sessionId };
}

export function parseRemoteDevBrowserPermission(
	value: unknown,
): RemoteDevBrowserPermission {
	assertRecord(value, "rds:permission");
	assertKeys(value, ["sessionId", "requestId", "optionId"], "rds:permission");
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	assertString(value.requestId, "requestId", RDS_LIMITS.maxSessionIdBytes);
	const optionId = optionalString(value.optionId, "optionId", 128);
	return {
		sessionId: value.sessionId,
		requestId: value.requestId,
		...(optionId ? { optionId } : {}),
	};
}

export function parseRemoteDevBrowserResync(
	value: unknown,
): RemoteDevBrowserResync {
	assertRecord(value, "rds:resync");
	assertKeys(value, ["sessionId", "sinceSeq"], "rds:resync");
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	if (value.sinceSeq !== undefined) {
		if (
			typeof value.sinceSeq !== "number" ||
			!Number.isInteger(value.sinceSeq) ||
			value.sinceSeq < 0
		) {
			throw new RemoteDevProtocolError("sinceSeq 必须是非负整数");
		}
	}
	return {
		sessionId: value.sessionId,
		...(value.sinceSeq !== undefined ? { sinceSeq: value.sinceSeq } : {}),
	};
}

export function parseRemoteDevBrowserPortOpen(
	value: unknown,
): RemoteDevBrowserPortOpen {
	assertRecord(value, "rds:port.open");
	assertKeys(value, ["sessionId", "remotePort", "label"], "rds:port.open");
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	assertPort(value.remotePort, "remotePort");
	const label = optionalString(value.label, "label", RDS_LIMITS.maxLabelBytes);
	return {
		sessionId: value.sessionId,
		remotePort: value.remotePort,
		...(label ? { label } : {}),
	};
}

export function parseRemoteDevBrowserPortClose(
	value: unknown,
): RemoteDevBrowserPortClose {
	assertRecord(value, "rds:port.close");
	assertKeys(value, ["sessionId", "portId"], "rds:port.close");
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	assertString(value.portId, "portId", RDS_LIMITS.maxSessionIdBytes);
	return { sessionId: value.sessionId, portId: value.portId };
}

/** 解析 Server → Client 的 RDS 命令；按 action 严格拒绝未知字段。 */
export function parseRemoteDevClientCommand(
	value: unknown,
): RemoteDevClientCommand {
	assertRecord(value, "rds:command");
	assertString(value.requestId, "requestId", RDS_LIMITS.maxSessionIdBytes);
	assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
	if (typeof value.action !== "string") {
		throw new RemoteDevProtocolError("rds:command.action 必须是字符串");
	}
	if (value.action === "session.create") {
		assertKeys(
			value,
			[
				"action",
				"requestId",
				"sessionId",
				"agentPlacementId",
				"workspaceRoot",
				"workspaceRoots",
				"command",
				"args",
				"cwd",
				"acpSessionId",
			],
			"rds:command.session.create",
		);
		assertString(value.agentPlacementId, "agentPlacementId", 128);
		assertString(
			value.workspaceRoot,
			"workspaceRoot",
			RDS_LIMITS.maxWorkspaceBytes,
		);
		assertString(value.command, "command", 1024);
		assertString(value.cwd, "cwd", RDS_LIMITS.maxWorkspaceBytes);
		const args = parseStringArray(value.args, "args", 64, 1024);
		const workspaceRoots = parseStringArray(
			value.workspaceRoots,
			"workspaceRoots",
			32,
			RDS_LIMITS.maxWorkspaceBytes,
		);
		if (workspaceRoots.length === 0) {
			throw new RemoteDevProtocolError("workspaceRoots 不能为空");
		}
		const acpSessionId = optionalString(
			value.acpSessionId,
			"acpSessionId",
			RDS_LIMITS.maxSessionIdBytes,
		);
		return {
			action: "session.create",
			requestId: value.requestId,
			sessionId: value.sessionId,
			agentPlacementId: value.agentPlacementId,
			workspaceRoot: value.workspaceRoot,
			workspaceRoots,
			command: value.command,
			args,
			cwd: value.cwd,
			...(acpSessionId ? { acpSessionId } : {}),
		};
	}
	if (value.action === "session.close") {
		assertKeys(
			value,
			["action", "requestId", "sessionId", "reason"],
			"rds:command.session.close",
		);
		const reason = optionalString(value.reason, "reason", 128);
		return {
			action: "session.close",
			requestId: value.requestId,
			sessionId: value.sessionId,
			...(reason ? { reason } : {}),
		};
	}
	if (value.action === "agent.prompt") {
		assertKeys(
			value,
			["action", "requestId", "sessionId", "text"],
			"rds:command.agent.prompt",
		);
		assertString(value.text, "text", RDS_LIMITS.maxPromptBytes);
		return {
			action: "agent.prompt",
			requestId: value.requestId,
			sessionId: value.sessionId,
			text: value.text,
		};
	}
	if (value.action === "agent.cancel") {
		assertKeys(
			value,
			["action", "requestId", "sessionId"],
			"rds:command.agent.cancel",
		);
		return {
			action: "agent.cancel",
			requestId: value.requestId,
			sessionId: value.sessionId,
		};
	}
	if (value.action === "agent.permission") {
		assertKeys(
			value,
			[
				"action",
				"requestId",
				"sessionId",
				"permissionRequestId",
				"outcome",
			],
			"rds:command.agent.permission",
		);
		assertString(
			value.permissionRequestId,
			"permissionRequestId",
			RDS_LIMITS.maxSessionIdBytes,
		);
		assertRecord(value.outcome, "outcome");
		if (value.outcome.outcome === "selected") {
			assertKeys(value.outcome, ["outcome", "optionId"], "outcome");
			assertString(value.outcome.optionId, "optionId", 128);
			return {
				action: "agent.permission",
				requestId: value.requestId,
				sessionId: value.sessionId,
				permissionRequestId: value.permissionRequestId,
				outcome: {
					outcome: "selected",
					optionId: value.outcome.optionId,
				},
			};
		}
		if (value.outcome.outcome === "cancelled") {
			assertKeys(value.outcome, ["outcome"], "outcome");
			return {
				action: "agent.permission",
				requestId: value.requestId,
				sessionId: value.sessionId,
				permissionRequestId: value.permissionRequestId,
				outcome: { outcome: "cancelled" },
			};
		}
		throw new RemoteDevProtocolError("permission outcome 非法");
	}
	throw new RemoteDevProtocolError(`未知 RDS action ${value.action}`);
}

export function parseRemoteDevCommandResult(
	value: unknown,
): RemoteDevCommandResult {
	assertRecord(value, "rds:command-result");
	assertKeys(
		value,
		["requestId", "ok", "sessionId", "generationId", "stopReason", "error"],
		"rds:command-result",
	);
	assertString(value.requestId, "requestId", RDS_LIMITS.maxSessionIdBytes);
	if (typeof value.ok !== "boolean") {
		throw new RemoteDevProtocolError("ok 必须是 boolean");
	}
	const sessionId = optionalString(
		value.sessionId,
		"sessionId",
		RDS_LIMITS.maxSessionIdBytes,
	);
	const generationId = optionalString(
		value.generationId,
		"generationId",
		RDS_LIMITS.maxSessionIdBytes,
	);
	const stopReason = optionalString(value.stopReason, "stopReason", 128);
	let error: RemoteDevCommandResult["error"];
	if (value.error !== undefined) {
		assertRecord(value.error, "error");
		assertKeys(value.error, ["code", "message"], "error");
		assertString(value.error.code, "error.code", 128);
		assertString(value.error.message, "error.message", 512);
		error = { code: value.error.code, message: value.error.message };
	}
	return {
		requestId: value.requestId,
		ok: value.ok,
		...(sessionId ? { sessionId } : {}),
		...(generationId ? { generationId } : {}),
		...(stopReason ? { stopReason } : {}),
		...(error ? { error } : {}),
	};
}

/** Client → Server 的归一化 ACP 事件信封；变体细节由 ACP Host 生成。 */
export function parseRemoteDevClientEvent(
	value: unknown,
): RemoteDevClientEvent {
	assertRecord(value, "rds:event");
	if (typeof value.type !== "string") {
		throw new RemoteDevProtocolError("rds:event.type 必须是字符串");
	}
	if (value.type === "agent.event") {
		assertKeys(
			value,
			["type", "sessionId", "generationId", "seq", "event"],
			"rds:event.agent.event",
		);
		assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
		assertString(value.generationId, "generationId", 128);
		if (
			typeof value.seq !== "number" ||
			!Number.isInteger(value.seq) ||
			value.seq < 0
		) {
			throw new RemoteDevProtocolError("seq 必须是非负整数");
		}
		assertRecord(value.event, "event");
		let event: AcpAdapterEvent;
		try {
			event = parseAcpAdapterEvent(value.event);
		} catch (cause) {
			throw new RemoteDevProtocolError(
				cause instanceof Error ? cause.message : "ACP event 非法",
			);
		}
		return {
			type: "agent.event",
			sessionId: value.sessionId,
			generationId: value.generationId,
			seq: value.seq,
			event,
		};
	}
	if (value.type === "agent.status") {
		assertKeys(
			value,
			["type", "sessionId", "generationId", "status"],
			"rds:event.agent.status",
		);
		assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
		assertString(value.generationId, "generationId", 128);
		if (
			typeof value.status !== "string" ||
			!REMOTE_DEV_AGENT_STATES.includes(
				value.status as (typeof REMOTE_DEV_AGENT_STATES)[number],
			)
		) {
			throw new RemoteDevProtocolError("未知 agent status");
		}
		return {
			type: "agent.status",
			sessionId: value.sessionId,
			generationId: value.generationId,
			status: value.status as RemoteDevAgentState,
		};
	}
	if (value.type === "session.ended") {
		assertKeys(
			value,
			["type", "sessionId", "generationId", "reason", "code"],
			"rds:event.session.ended",
		);
		assertString(value.sessionId, "sessionId", RDS_LIMITS.maxSessionIdBytes);
		assertString(value.generationId, "generationId", 128);
		if (
			value.reason !== "closed" &&
			value.reason !== "exited" &&
			value.reason !== "error"
		) {
			throw new RemoteDevProtocolError("未知 session ended reason");
		}
		const code = optionalString(value.code, "code", 128);
		return {
			type: "session.ended",
			sessionId: value.sessionId,
			generationId: value.generationId,
			reason: value.reason,
			...(code ? { code } : {}),
		};
	}
	throw new RemoteDevProtocolError(`未知 rds:event.type ${value.type}`);
}

function parseStringArray(
	value: unknown,
	what: string,
	maxItems: number,
	maxBytes: number,
): string[] {
	if (!Array.isArray(value)) {
		throw new RemoteDevProtocolError(`${what} 必须是数组`);
	}
	if (value.length > maxItems) {
		throw new RemoteDevProtocolError(`${what} 超过 ${maxItems} 项`);
	}
	return value.map((item, index) => {
		assertString(item, `${what}[${index}]`, maxBytes);
		return item;
	});
}
