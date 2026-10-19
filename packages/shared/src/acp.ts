// ── ACP v1 适配器事件（VCPDeck 内部投影） ──
// ACP 原始 JSON 不进入 Server/浏览器；Client 把 session/update 与
// session/request_permission 归一化为本模块事件。未知 update variant 返回
// null（保持会话），已知 variant 的非法载荷则抛错（防止半解析状态）。

export const ACP_ADAPTER_EVENT_TYPES = [
	"agent.message.delta",
	"agent.thought.delta",
	"tool.started",
	"tool.updated",
	"plan.updated",
	"usage.updated",
	"permission.requested",
	"permission.resolved",
	"session.ended",
] as const;
export type AcpAdapterEventType = (typeof ACP_ADAPTER_EVENT_TYPES)[number];

export interface AcpToolLocation {
	path: string;
	line?: number;
}

export interface AcpPlanEntry {
	content: string;
	priority?: string;
	status?: string;
}

export interface AcpPermissionOption {
	optionId: string;
	name: string;
	kind: string;
}

export interface AcpPermissionRequest {
	requestId: string;
	sessionId: string;
	toolCallId: string;
	title?: string;
	options: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
	| { outcome: "selected"; optionId: string }
	| { outcome: "cancelled" };

export type AcpAdapterEvent =
	| { type: "agent.message.delta"; messageId: string; text: string }
	| { type: "agent.thought.delta"; text: string }
	| {
			type: "tool.started";
			toolCallId: string;
			title: string;
			kind?: string;
			status?: string;
			locations?: AcpToolLocation[];
	  }
	| {
			type: "tool.updated";
			toolCallId: string;
			status?: string;
			title?: string;
			content?: string;
	  }
	| { type: "plan.updated"; entries: AcpPlanEntry[] }
	| {
			type: "usage.updated";
			used: number;
			size: number;
			cost?: { amount: number; currency: string };
	  }
	| {
			type: "permission.requested";
			requestId: string;
			toolCallId: string;
			title?: string;
			options: AcpPermissionOption[];
	  }
	| {
			type: "permission.resolved";
			requestId: string;
			optionId?: string;
			outcome: "selected" | "cancelled";
	  }
	| {
			type: "session.ended";
			reason: "exited" | "closed" | "error";
			code?: number;
	  };

export class AcpProtocolError extends Error {
	readonly code = "ACP_PROTOCOL_INVALID" as const;

	constructor(message: string) {
		super(message);
		this.name = "AcpProtocolError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(
	value: unknown,
	what: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new AcpProtocolError(`${what} 必须是对象`);
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	what: string,
): void {
	const set = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!set.has(key)) {
			throw new AcpProtocolError(`${what} 含未知字段 ${key}`);
		}
	}
}

function assertString(
	value: unknown,
	what: string,
	allowEmpty = false,
): asserts value is string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new AcpProtocolError(`${what} 必须是字符串`);
	}
}

function optionalString(
	value: unknown,
	what: string,
): string | undefined {
	if (value === undefined) return undefined;
	assertString(value, what);
	return value;
}

function textContent(value: unknown, what: string): string {
	assertRecord(value, what);
	assertKeys(value, ["type", "text"], what);
	if (value.type !== "text") {
		throw new AcpProtocolError(`${what}.type 必须为 text`);
	}
	assertString(value.text, `${what}.text`, true);
	return value.text;
}

function parseLocations(value: unknown): AcpToolLocation[] {
	if (!Array.isArray(value)) {
		throw new AcpProtocolError("locations 必须是数组");
	}
	return value.map((item, index) => {
		assertRecord(item, `locations[${index}]`);
		assertKeys(item, ["path", "line"], `locations[${index}]`);
		assertString(item.path, `locations[${index}].path`);
		if (
			item.line !== undefined &&
			(typeof item.line !== "number" ||
				!Number.isInteger(item.line) ||
				item.line < 0)
		) {
			throw new AcpProtocolError(`locations[${index}].line 必须是非负整数`);
		}
		return {
			path: item.path,
			...(item.line !== undefined ? { line: item.line } : {}),
		};
	});
}

function parseToolCall(value: Record<string, unknown>): AcpAdapterEvent {
	assertString(value.toolCallId, "toolCallId");
	assertString(value.title, "title");
	const event: Extract<AcpAdapterEvent, { type: "tool.started" }> = {
		type: "tool.started",
		toolCallId: value.toolCallId,
		title: value.title,
	};
	const kind = optionalString(value.kind, "kind");
	const status = optionalString(value.status, "status");
	if (kind !== undefined) event.kind = kind;
	if (status !== undefined) event.status = status;
	if (value.locations !== undefined) {
		event.locations = parseLocations(value.locations);
	}
	return event;
}

function parseToolUpdate(value: Record<string, unknown>): AcpAdapterEvent {
	assertString(value.toolCallId, "toolCallId");
	const event: Extract<AcpAdapterEvent, { type: "tool.updated" }> = {
		type: "tool.updated",
		toolCallId: value.toolCallId,
	};
	const status = optionalString(value.status, "status");
	const title = optionalString(value.title, "title");
	if (status !== undefined) event.status = status;
	if (title !== undefined) event.title = title;
	if (value.content !== undefined) {
		if (!Array.isArray(value.content)) {
			throw new AcpProtocolError("content 必须是数组");
		}
		const texts: string[] = [];
		for (const [index, block] of value.content.entries()) {
			assertRecord(block, `content[${index}]`);
			if (block.type === "content") {
				assertRecord(block.content, `content[${index}].content`);
				texts.push(
					textContent(
						block.content,
						`content[${index}].content`,
					),
				);
			}
		}
		if (texts.length > 0) event.content = texts.join("");
	}
	return event;
}

function parsePlan(value: Record<string, unknown>): AcpAdapterEvent {
	if (!Array.isArray(value.entries)) {
		throw new AcpProtocolError("plan.entries 必须是数组");
	}
	const entries = value.entries.map((entry, index) => {
		assertRecord(entry, `plan.entries[${index}]`);
		assertKeys(
			entry,
			["content", "priority", "status"],
			`plan.entries[${index}]`,
		);
		assertString(entry.content, `plan.entries[${index}].content`);
		const result: AcpPlanEntry = { content: entry.content };
		const priority = optionalString(
			entry.priority,
			`plan.entries[${index}].priority`,
		);
		const status = optionalString(
			entry.status,
			`plan.entries[${index}].status`,
		);
		if (priority !== undefined) result.priority = priority;
		if (status !== undefined) result.status = status;
		return result;
	});
	return { type: "plan.updated", entries };
}

function parseUsage(value: Record<string, unknown>): AcpAdapterEvent {
	if (
		typeof value.used !== "number" ||
		!Number.isInteger(value.used) ||
		value.used < 0 ||
		typeof value.size !== "number" ||
		!Number.isInteger(value.size) ||
		value.size < 0
	) {
		throw new AcpProtocolError("usage.used/size 必须是非负整数");
	}
	const event: Extract<AcpAdapterEvent, { type: "usage.updated" }> = {
		type: "usage.updated",
		used: value.used,
		size: value.size,
	};
	if (value.cost !== undefined) {
		assertRecord(value.cost, "usage.cost");
		assertKeys(value.cost, ["amount", "currency"], "usage.cost");
		if (
			typeof value.cost.amount !== "number" ||
			!Number.isFinite(value.cost.amount)
		) {
			throw new AcpProtocolError("usage.cost.amount 必须是数字");
		}
		assertString(value.cost.currency, "usage.cost.currency");
		event.cost = {
			amount: value.cost.amount,
			currency: value.cost.currency,
		};
	}
	return event;
}

/**
 * 解析 ACP session/update。
 * - 未知 sessionUpdate variant 返回 null，调用方必须忽略并保持会话；
 * - 已知 variant 的非法载荷抛 AcpProtocolError；
 * - 非对象/缺少 sessionUpdate 抛错。
 */
export function parseAcpSessionUpdate(
	value: unknown,
): AcpAdapterEvent | null {
	assertRecord(value, "session/update");
	if (typeof value.sessionUpdate !== "string") {
		throw new AcpProtocolError("sessionUpdate 必须是字符串");
	}
	switch (value.sessionUpdate) {
		case "agent_message_chunk": {
			assertString(value.messageId, "messageId");
			return {
				type: "agent.message.delta",
				messageId: value.messageId,
				text: textContent(value.content, "content"),
			};
		}
		case "agent_thought_chunk":
			return {
				type: "agent.thought.delta",
				text: textContent(value.content, "content"),
			};
		case "tool_call":
			return parseToolCall(value);
		case "tool_call_update":
			return parseToolUpdate(value);
		case "plan":
			return parsePlan(value);
		case "usage_update":
			return parseUsage(value);
		default:
			// user_message_chunk/available_commands_update/current_mode_update/
			// config_option_update/session_info_update/notice/compaction_* 以及未来
			// variant 不属于 v1 投影；忽略，不影响会话。
			return null;
	}
}

/** 解析 Client → Server 已归一化的 ACP 事件；未知字段与非法载荷一律拒绝。 */
export function parseAcpAdapterEvent(value: unknown): AcpAdapterEvent {
	assertRecord(value, "acp event");
	assertString(value.type, "acp event.type");
	switch (value.type) {
		case "agent.message.delta":
			assertKeys(value, ["type", "messageId", "text"], "agent.message.delta");
			assertString(value.messageId, "messageId");
			assertString(value.text, "text", true);
			return { type: "agent.message.delta", messageId: value.messageId, text: value.text };
		case "agent.thought.delta":
			assertKeys(value, ["type", "text"], "agent.thought.delta");
			assertString(value.text, "text", true);
			return { type: "agent.thought.delta", text: value.text };
		case "tool.started": {
			assertKeys(
				value,
				["type", "toolCallId", "title", "kind", "status", "locations"],
				"tool.started",
			);
			assertString(value.toolCallId, "toolCallId");
			assertString(value.title, "title");
			const event: Extract<AcpAdapterEvent, { type: "tool.started" }> = {
				type: "tool.started",
				toolCallId: value.toolCallId,
				title: value.title,
			};
			const kind = optionalString(value.kind, "kind");
			const status = optionalString(value.status, "status");
			if (kind !== undefined) event.kind = kind;
			if (status !== undefined) event.status = status;
			if (value.locations !== undefined) {
				event.locations = parseLocations(value.locations);
			}
			return event;
		}
		case "tool.updated": {
			assertKeys(
				value,
				["type", "toolCallId", "status", "title", "content"],
				"tool.updated",
			);
			assertString(value.toolCallId, "toolCallId");
			const event: Extract<AcpAdapterEvent, { type: "tool.updated" }> = {
				type: "tool.updated",
				toolCallId: value.toolCallId,
			};
			const status = optionalString(value.status, "status");
			const title = optionalString(value.title, "title");
			if (status !== undefined) event.status = status;
			if (title !== undefined) event.title = title;
			if (value.content !== undefined) {
				assertString(value.content, "content", true);
				event.content = value.content;
			}
			return event;
		}
		case "plan.updated": {
			assertKeys(value, ["type", "entries"], "plan.updated");
			if (!Array.isArray(value.entries)) {
				throw new AcpProtocolError("plan.entries 必须是数组");
			}
			const entries = value.entries.map((entry, index) => {
				assertRecord(entry, `plan.entries[${index}]`);
				assertKeys(
					entry,
					["content", "priority", "status"],
					`plan.entries[${index}]`,
				);
				assertString(entry.content, `plan.entries[${index}].content`);
				const item: AcpPlanEntry = { content: entry.content };
				const priority = optionalString(
					entry.priority,
					`plan.entries[${index}].priority`,
				);
				const status = optionalString(
					entry.status,
					`plan.entries[${index}].status`,
				);
				if (priority !== undefined) item.priority = priority;
				if (status !== undefined) item.status = status;
				return item;
			});
			return { type: "plan.updated", entries };
		}
		case "usage.updated": {
			assertKeys(value, ["type", "used", "size", "cost"], "usage.updated");
			if (
				typeof value.used !== "number" ||
				!Number.isInteger(value.used) ||
				value.used < 0 ||
				typeof value.size !== "number" ||
				!Number.isInteger(value.size) ||
				value.size < 0
			) {
				throw new AcpProtocolError("usage.used/size 必须是非负整数");
			}
			const event: Extract<AcpAdapterEvent, { type: "usage.updated" }> = {
				type: "usage.updated",
				used: value.used,
				size: value.size,
			};
			if (value.cost !== undefined) {
				assertRecord(value.cost, "usage.cost");
				assertKeys(value.cost, ["amount", "currency"], "usage.cost");
				if (
					typeof value.cost.amount !== "number" ||
					!Number.isFinite(value.cost.amount)
				) {
					throw new AcpProtocolError("usage.cost.amount 必须是数字");
				}
				assertString(value.cost.currency, "usage.cost.currency");
				event.cost = { amount: value.cost.amount, currency: value.cost.currency };
			}
			return event;
		}
		case "permission.requested": {
			assertKeys(
				value,
				["type", "requestId", "toolCallId", "title", "options"],
				"permission.requested",
			);
			assertString(value.requestId, "requestId");
			assertString(value.toolCallId, "toolCallId");
			const title = optionalString(value.title, "title");
			if (!Array.isArray(value.options) || value.options.length === 0) {
				throw new AcpProtocolError("permission.options 必须是非空数组");
			}
			const options = value.options.map((option, index) => {
				assertRecord(option, `options[${index}]`);
				assertKeys(option, ["optionId", "name", "kind"], `options[${index}]`);
				assertString(option.optionId, `options[${index}].optionId`);
				assertString(option.name, `options[${index}].name`);
				assertString(option.kind, `options[${index}].kind`);
				return {
					optionId: option.optionId,
					name: option.name,
					kind: option.kind,
				};
			});
			return {
				type: "permission.requested",
				requestId: value.requestId,
				toolCallId: value.toolCallId,
				...(title !== undefined ? { title } : {}),
				options,
			};
		}
		case "permission.resolved": {
			assertKeys(
				value,
				["type", "requestId", "optionId", "outcome"],
				"permission.resolved",
			);
			assertString(value.requestId, "requestId");
			if (value.outcome === "selected") {
				assertString(value.optionId, "optionId");
				return {
					type: "permission.resolved",
					requestId: value.requestId,
					optionId: value.optionId,
					outcome: "selected",
				};
			}
			if (value.outcome === "cancelled") {
				if (value.optionId !== undefined) {
					throw new AcpProtocolError("cancelled 不能带 optionId");
				}
				return {
					type: "permission.resolved",
					requestId: value.requestId,
					outcome: "cancelled",
				};
			}
			throw new AcpProtocolError("permission.resolved.outcome 非法");
		}
		case "session.ended": {
			assertKeys(value, ["type", "reason", "code"], "session.ended");
			if (
				value.reason !== "exited" &&
				value.reason !== "closed" &&
				value.reason !== "error"
			) {
				throw new AcpProtocolError("session.ended.reason 非法");
			}
			if (
				value.code !== undefined &&
				(typeof value.code !== "number" ||
					!Number.isInteger(value.code) ||
					value.code < 0)
			) {
				throw new AcpProtocolError("session.ended.code 必须是非负整数");
			}
			return {
				type: "session.ended",
				reason: value.reason,
				...(value.code !== undefined ? { code: value.code } : {}),
			};
		}
		default:
			throw new AcpProtocolError(`未知 ACP event ${value.type}`);
	}
}

/** 解析 ACP session/request_permission 的 params。 */
export function parseAcpPermissionRequest(
	value: unknown,
	requestId: string,
): AcpPermissionRequest {
	assertRecord(value, "session/request_permission params");
	assertKeys(value, ["sessionId", "toolCall", "options"], "params");
	assertString(value.sessionId, "sessionId");
	assertRecord(value.toolCall, "toolCall");
	assertString(value.toolCall.toolCallId, "toolCall.toolCallId");
	const title = optionalString(value.toolCall.title, "toolCall.title");
	if (!Array.isArray(value.options) || value.options.length === 0) {
		throw new AcpProtocolError("options 必须是非空数组");
	}
	const options = value.options.map((option, index) => {
		assertRecord(option, `options[${index}]`);
		assertKeys(
			option,
			["optionId", "name", "kind"],
			`options[${index}]`,
		);
		assertString(option.optionId, `options[${index}].optionId`);
		assertString(option.name, `options[${index}].name`);
		assertString(option.kind, `options[${index}].kind`);
		return {
			optionId: option.optionId,
			name: option.name,
			kind: option.kind,
		};
	});
	return {
		requestId,
		sessionId: value.sessionId,
		toolCallId: value.toolCall.toolCallId,
		...(title !== undefined ? { title } : {}),
		options,
	};
}

/** 解析 session/prompt 的 result.stopReason。 */
export function parseAcpPromptResult(
	value: unknown,
): { stopReason: string } {
	assertRecord(value, "session/prompt result");
	assertString(value.stopReason, "stopReason");
	return { stopReason: value.stopReason };
}
