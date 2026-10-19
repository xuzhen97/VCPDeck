import type { AcpAdapterEvent, AcpPermissionOutcome } from "./acp.js";

export const TASK_CLIENT_ACTIONS = [
	"start",
	"prompt",
	"cancel",
	"permission",
	"close",
] as const;
export type TaskClientAction = (typeof TASK_CLIENT_ACTIONS)[number];

interface TaskClientCommandBase {
	requestId: string;
	taskId: string;
	attemptId: string;
}

export type TaskClientCommand =
	| (TaskClientCommandBase & {
			action: "start";
			command: string;
			args: string[];
			cwd: string;
			prompt?: string;
	  })
	| (TaskClientCommandBase & { action: "prompt"; text: string })
	| (TaskClientCommandBase & { action: "cancel" })
	| (TaskClientCommandBase & {
			action: "permission";
			permissionRequestId: string;
			outcome: AcpPermissionOutcome;
	  })
	| (TaskClientCommandBase & { action: "close" });

export interface TaskCommandResult {
	requestId: string;
	ok: boolean;
	sessionId?: string;
	stopReason?: string;
	error?: { code: string; message: string };
}

export interface TaskClientEvent {
	taskId: string;
	attemptId: string;
	seq: number;
	event: AcpAdapterEvent;
}

export class TaskClientProtocolError extends Error {
	readonly code = "TASK_CLIENT_PROTOCOL_INVALID" as const;

	constructor(message: string) {
		super(message);
		this.name = "TaskClientProtocolError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(
	value: unknown,
	what: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new TaskClientProtocolError(`${what} 必须是对象`);
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	what: string,
): void {
	const set = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!set.has(key)) {
			throw new TaskClientProtocolError(`${what} 含未知字段 ${key}`);
		}
	}
}

function assertString(
	value: unknown,
	what: string,
	maxBytes = 4096,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TaskClientProtocolError(`${what} 必须是非空字符串`);
	}
	if (new TextEncoder().encode(value).byteLength > maxBytes) {
		throw new TaskClientProtocolError(`${what} 超过 ${maxBytes} 字节上限`);
	}
}

function assertSeq(value: unknown): asserts value is number {
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new TaskClientProtocolError("seq 必须是正整数");
	}
}

function assertBase(value: Record<string, unknown>): TaskClientCommandBase {
	assertString(value.requestId, "requestId", 128);
	assertString(value.taskId, "taskId", 128);
	assertString(value.attemptId, "attemptId", 128);
	return {
		requestId: value.requestId,
		taskId: value.taskId,
		attemptId: value.attemptId,
	};
}

/** 解析 Server → Client 的任务命令；未知 action/字段拒绝。 */
export function parseTaskClientCommand(value: unknown): TaskClientCommand {
	assertRecord(value, "task command");
	if (typeof value.action !== "string") {
		throw new TaskClientProtocolError("action 必须是字符串");
	}
	const action = value.action;
	switch (action) {
		case "start": {
			assertKeys(
				value,
				[
					"requestId",
					"action",
					"taskId",
					"attemptId",
					"command",
					"args",
					"cwd",
					"prompt",
				],
				"start",
			);
			const base = assertBase(value);
			assertString(value.command, "command", 1024);
			if (!Array.isArray(value.args)) {
				throw new TaskClientProtocolError("args 必须是数组");
			}
			const args = value.args.map((arg, index) => {
				assertString(arg, `args[${index}]`, 1024);
				return arg;
			});
			assertString(value.cwd, "cwd", 2048);
			if (value.prompt !== undefined) {
				assertString(value.prompt, "prompt", 256 * 1024);
			}
			return {
				...base,
				action: "start",
				command: value.command,
				args,
				cwd: value.cwd,
				...(value.prompt !== undefined ? { prompt: value.prompt } : {}),
			};
		}
		case "prompt": {
			assertKeys(
				value,
				["requestId", "action", "taskId", "attemptId", "text"],
				"prompt",
			);
			const base = assertBase(value);
			assertString(value.text, "text", 256 * 1024);
			return { ...base, action: "prompt", text: value.text };
		}
		case "cancel": {
			assertKeys(
				value,
				["requestId", "action", "taskId", "attemptId"],
				"cancel",
			);
			return { ...assertBase(value), action: "cancel" };
		}
		case "permission": {
			assertKeys(
				value,
				[
					"requestId",
					"action",
					"taskId",
					"attemptId",
					"permissionRequestId",
					"outcome",
				],
				"permission",
			);
			const base = assertBase(value);
			assertString(
				value.permissionRequestId,
				"permissionRequestId",
				128,
			);
			assertRecord(value.outcome, "outcome");
			assertKeys(value.outcome, ["outcome", "optionId"], "outcome");
			if (value.outcome.outcome === "selected") {
				assertString(value.outcome.optionId, "outcome.optionId", 128);
				return {
					...base,
					action: "permission",
					permissionRequestId: value.permissionRequestId,
					outcome: {
						outcome: "selected",
						optionId: value.outcome.optionId,
					},
				};
			}
			if (value.outcome.outcome === "cancelled") {
				return {
					...base,
					action: "permission",
					permissionRequestId: value.permissionRequestId,
					outcome: { outcome: "cancelled" },
				};
			}
			throw new TaskClientProtocolError("outcome.outcome 非法");
		}
		case "close": {
			assertKeys(
				value,
				["requestId", "action", "taskId", "attemptId"],
				"close",
			);
			return { ...assertBase(value), action: "close" };
		}
		default:
			throw new TaskClientProtocolError(`未知 action ${action}`);
	}
}

/** 解析 Client → Server 的标准化事件信封；正文变体由 ACP 投影保证。 */
export function parseTaskClientEvent(value: unknown): TaskClientEvent {
	assertRecord(value, "task event");
	assertKeys(value, ["taskId", "attemptId", "seq", "event"], "task event");
	assertString(value.taskId, "taskId", 128);
	assertString(value.attemptId, "attemptId", 128);
	assertSeq(value.seq);
	assertRecord(value.event, "event");
	assertString(value.event.type, "event.type", 64);
	return value as unknown as TaskClientEvent;
}

/** 解析 Client → Server 的命令结果。 */
export function parseTaskCommandResult(
	value: unknown,
): TaskCommandResult {
	assertRecord(value, "task command result");
	assertKeys(
		value,
		["requestId", "ok", "sessionId", "stopReason", "error"],
		"task command result",
	);
	assertString(value.requestId, "requestId", 128);
	if (typeof value.ok !== "boolean") {
		throw new TaskClientProtocolError("ok 必须是 boolean");
	}
	if (value.sessionId !== undefined) {
		assertString(value.sessionId, "sessionId", 128);
	}
	if (value.stopReason !== undefined) {
		assertString(value.stopReason, "stopReason", 64);
	}
	if (value.error !== undefined) {
		assertRecord(value.error, "error");
		assertKeys(value.error, ["code", "message"], "error");
		assertString(value.error.code, "error.code", 128);
		assertString(value.error.message, "error.message", 512);
	}
	return value as unknown as TaskCommandResult;
}
