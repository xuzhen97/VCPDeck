// ── A2A v1.0 对外契约（VCPDeck 子集） ──
// 外部 wire 使用 TASK_STATE_* 与 status.state；内部持久化状态使用小写
// TaskLifecycleState。两者只能通过 toA2aTaskState/fromA2aTaskState 转换。
// 所有跨信任边界输入必须先经过本模块的 parse* 函数。

export const A2A_TASK_STATES = [
	"TASK_STATE_SUBMITTED",
	"TASK_STATE_WORKING",
	"TASK_STATE_INPUT_REQUIRED",
	"TASK_STATE_AUTH_REQUIRED",
	"TASK_STATE_COMPLETED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_REJECTED",
	"TASK_STATE_FAILED",
] as const;
export type A2aTaskState = (typeof A2A_TASK_STATES)[number];

/** 内部持久化状态；不得直接出现在 A2A 响应中。 */
export const TASK_LIFECYCLE_STATES = [
	"submitted",
	"working",
	"input-required",
	"auth-required",
	"completed",
	"canceled",
	"rejected",
	"failed",
] as const;
export type TaskLifecycleState = (typeof TASK_LIFECYCLE_STATES)[number];

const TO_A2A_STATE: Record<TaskLifecycleState, A2aTaskState> = {
	submitted: "TASK_STATE_SUBMITTED",
	working: "TASK_STATE_WORKING",
	"input-required": "TASK_STATE_INPUT_REQUIRED",
	"auth-required": "TASK_STATE_AUTH_REQUIRED",
	completed: "TASK_STATE_COMPLETED",
	canceled: "TASK_STATE_CANCELED",
	rejected: "TASK_STATE_REJECTED",
	failed: "TASK_STATE_FAILED",
};

const FROM_A2A_STATE: Record<A2aTaskState, TaskLifecycleState> = {
	TASK_STATE_SUBMITTED: "submitted",
	TASK_STATE_WORKING: "working",
	TASK_STATE_INPUT_REQUIRED: "input-required",
	TASK_STATE_AUTH_REQUIRED: "auth-required",
	TASK_STATE_COMPLETED: "completed",
	TASK_STATE_CANCELED: "canceled",
	TASK_STATE_REJECTED: "rejected",
	TASK_STATE_FAILED: "failed",
};

export function toA2aTaskState(state: TaskLifecycleState): A2aTaskState {
	return TO_A2A_STATE[state];
}

export function fromA2aTaskState(state: A2aTaskState): TaskLifecycleState {
	return FROM_A2A_STATE[state];
}

export function isA2aTaskState(value: unknown): value is A2aTaskState {
	return (
		typeof value === "string" &&
		(A2A_TASK_STATES as readonly string[]).includes(value)
	);
}

export const ACP_PERMISSION_EXTENSION_URI =
	"https://vcpdeck.dev/a2a/extensions/acp-permission/v1";

export const A2A_LIMITS = {
	maxMessageBytes: 64 * 1024,
	maxTextParts: 32,
	maxMessageIdBytes: 128,
	maxTaskIdBytes: 128,
	maxContextIdBytes: 128,
	maxAgentIdBytes: 128,
	maxIntentBytes: 4096,
	maxCriteria: 32,
	maxCriterionBytes: 1024,
	maxConstraintItems: 64,
	maxConstraintBytes: 1024,
	maxPermissionIdBytes: 128,
	maxHistoryLength: 1000,
	maxPageSize: 100,
	maxPageTokenBytes: 512,
} as const;

export class A2aProtocolError extends Error {
	readonly code = "A2A_PROTOCOL_INVALID" as const;

	constructor(
		message: string,
		readonly rpcCode: number = -32600,
	) {
		super(message);
		this.name = "A2aProtocolError";
	}
}

export interface A2aTextPart {
	text: string;
}

export interface A2aMessage {
	messageId: string;
	role: "user" | "agent";
	parts: A2aTextPart[];
	contextId?: string;
	taskId?: string;
}

export interface A2aTaskConstraints {
	allowedPaths?: string[];
	allowedCommands?: string[];
	requiredArtifacts?: string[];
}

export interface A2aPermissionExtension {
	requestId: string;
	optionId: string;
}

export interface A2aSendMessageMetadata {
	agentId?: string;
	intent?: string;
	acceptanceCriteria?: string[];
	constraints?: A2aTaskConstraints;
	/** 只允许 ACP_PERMISSION_EXTENSION_URI；未知扩展拒绝。 */
	extensions?: Record<string, unknown>;
}

export interface A2aSendMessageParams {
	message: A2aMessage;
	configuration?: {
		returnImmediately?: boolean;
		historyLength?: number;
	};
	metadata?: A2aSendMessageMetadata;
}

export interface A2aGetTaskParams {
	id: string;
	historyLength?: number;
}

export interface A2aListTasksParams {
	contextId?: string;
	status?: A2aTaskState;
	pageSize?: number;
	pageToken?: string;
	historyLength?: number;
	includeArtifacts?: boolean;
}

export interface A2aCancelTaskParams {
	id: string;
}

export interface A2aTaskStatus {
	state: A2aTaskState;
	timestamp?: string;
	message?: A2aMessage;
}

export interface A2aArtifactRef {
	id: string;
	name: string;
	mimeType: string;
	uri: string;
	sha256?: string;
	size?: number;
}

export interface A2aTaskMetadata {
	vcpdeck: {
		agentId: string;
		intent: string;
		acceptanceCriteria: string[];
		constraints: A2aTaskConstraints;
		createdAt: string;
		updatedAt: string;
		verdict?: "aligned" | "drifted" | "failed" | null;
	};
}

export interface A2aTask {
	id: string;
	contextId: string;
	status: A2aTaskStatus;
	artifacts: A2aArtifactRef[];
	metadata?: A2aTaskMetadata;
}

/** 内部 Task 投影；只允许出现在 Server/SDK 内部，不得直接作为 A2A 响应。 */
export interface TaskInfo {
	id: string;
	contextId: string;
	state: TaskLifecycleState;
	agentId: string;
	agentPlacementId?: string;
	intent: string;
	acceptanceCriteria: string[];
	constraints: A2aTaskConstraints;
	artifacts: A2aArtifactRef[];
	createdAt: string;
	updatedAt: string;
	verdict?: "aligned" | "drifted" | "failed" | null;
	error?: { code: string; message: string };
}

export function toA2aTask(info: TaskInfo): A2aTask {
	return {
		id: info.id,
		contextId: info.contextId,
		status: {
			state: toA2aTaskState(info.state),
			timestamp: info.updatedAt,
		},
		artifacts: info.artifacts,
		metadata: {
			vcpdeck: {
				agentId: info.agentId,
				intent: info.intent,
				acceptanceCriteria: info.acceptanceCriteria,
				constraints: info.constraints,
				createdAt: info.createdAt,
				updatedAt: info.updatedAt,
				verdict: info.verdict ?? null,
			},
		},
	};
}

export interface A2aAgentInterface {
	url: string;
	protocolBinding: "JSONRPC";
	protocolVersion: "1.0";
}

export interface A2aAgentSkill {
	id: string;
	name: string;
	description: string;
	tags: string[];
}

export interface A2aAgentCard {
	name: string;
	description: string;
	version: string;
	supportedInterfaces: A2aAgentInterface[];
	capabilities: {
		streaming: false;
		pushNotifications: false;
		extensions?: Array<{
			uri: string;
			description: string;
			required: boolean;
		}>;
	};
	defaultInputModes: ["text/plain"];
	defaultOutputModes: ["text/plain"];
	skills: A2aAgentSkill[];
}

export interface A2aListTasksResult {
	tasks: A2aTask[];
	nextPageToken: string;
	pageSize: number;
	totalSize: number;
}

export type A2aJsonRpcRequest =
	| {
			jsonrpc: "2.0";
			id: string | number;
			method: "SendMessage";
			params: A2aSendMessageParams;
	  }
	| {
			jsonrpc: "2.0";
			id: string | number;
			method: "GetTask";
			params: A2aGetTaskParams;
	  }
	| {
			jsonrpc: "2.0";
			id: string | number;
			method: "ListTasks";
			params: A2aListTasksParams;
	  }
	| {
			jsonrpc: "2.0";
			id: string | number;
			method: "CancelTask";
			params: A2aCancelTaskParams;
	  };

export type A2aJsonRpcResponse =
	| {
			jsonrpc: "2.0";
			id: string | number;
			result: unknown;
	  }
	| {
			jsonrpc: "2.0";
			id: string | number | null;
			error: {
				code: number;
				message: string;
				data?: unknown;
			};
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(
	value: unknown,
	what: string,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new A2aProtocolError(`${what} 必须是对象`);
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	what: string,
): void {
	const set = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!set.has(key)) {
			throw new A2aProtocolError(`${what} 含未知字段 ${key}`);
		}
	}
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function assertString(
	value: unknown,
	what: string,
	maxBytes: number,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new A2aProtocolError(`${what} 必须是非空字符串`);
	}
	if (utf8ByteLength(value) > maxBytes) {
		throw new A2aProtocolError(`${what} 超过 ${maxBytes} 字节上限`);
	}
}

function assertOptionalString(
	value: unknown,
	what: string,
	maxBytes: number,
): void {
	if (value !== undefined) assertString(value, what, maxBytes);
}

function assertBoolean(value: unknown, what: string): asserts value is boolean {
	if (typeof value !== "boolean") {
		throw new A2aProtocolError(`${what} 必须是 boolean`);
	}
}

function assertInteger(
	value: unknown,
	what: string,
	min: number,
	max: number,
): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	) {
		throw new A2aProtocolError(`${what} 必须是 ${min}-${max} 的整数`);
	}
}

function parseStringArray(
	value: unknown,
	what: string,
	maxItems: number,
	maxItemBytes: number,
): string[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new A2aProtocolError(`${what} 必须是不超过 ${maxItems} 项的数组`);
	}
	return value.map((item, index) => {
		assertString(item, `${what}[${index}]`, maxItemBytes);
		return item;
	});
}

function parseConstraints(value: unknown): A2aTaskConstraints {
	assertRecord(value, "constraints");
	assertKeys(
		value,
		["allowedPaths", "allowedCommands", "requiredArtifacts"],
		"constraints",
	);
	const result: A2aTaskConstraints = {};
	if (value.allowedPaths !== undefined) {
		result.allowedPaths = parseStringArray(
			value.allowedPaths,
			"constraints.allowedPaths",
			A2A_LIMITS.maxConstraintItems,
			A2A_LIMITS.maxConstraintBytes,
		);
	}
	if (value.allowedCommands !== undefined) {
		result.allowedCommands = parseStringArray(
			value.allowedCommands,
			"constraints.allowedCommands",
			A2A_LIMITS.maxConstraintItems,
			A2A_LIMITS.maxConstraintBytes,
		);
	}
	if (value.requiredArtifacts !== undefined) {
		result.requiredArtifacts = parseStringArray(
			value.requiredArtifacts,
			"constraints.requiredArtifacts",
			A2A_LIMITS.maxConstraintItems,
			A2A_LIMITS.maxConstraintBytes,
		);
	}
	return result;
}

function parsePermissionExtension(value: unknown): A2aPermissionExtension {
	assertRecord(value, "extensions.permission");
	assertKeys(value, ["requestId", "optionId"], "extensions.permission");
	assertString(
		value.requestId,
		"extensions.permission.requestId",
		A2A_LIMITS.maxPermissionIdBytes,
	);
	assertString(
		value.optionId,
		"extensions.permission.optionId",
		A2A_LIMITS.maxPermissionIdBytes,
	);
	return { requestId: value.requestId, optionId: value.optionId };
}

function parseExtensions(
	value: unknown,
): Record<string, unknown> {
	assertRecord(value, "metadata.extensions");
	assertKeys(value, [ACP_PERMISSION_EXTENSION_URI], "metadata.extensions");
	const result: Record<string, unknown> = {};
	if (value[ACP_PERMISSION_EXTENSION_URI] !== undefined) {
		result[ACP_PERMISSION_EXTENSION_URI] = parsePermissionExtension(
			value[ACP_PERMISSION_EXTENSION_URI],
		);
	}
	return result;
}

function parseMetadata(value: unknown): A2aSendMessageMetadata {
	assertRecord(value, "metadata");
	assertKeys(
		value,
		[
			"agentId",
			"intent",
			"acceptanceCriteria",
			"constraints",
			"extensions",
		],
		"metadata",
	);
	const result: A2aSendMessageMetadata = {};
	if (value.agentId !== undefined) {
		assertString(value.agentId, "metadata.agentId", A2A_LIMITS.maxAgentIdBytes);
		result.agentId = value.agentId;
	}
	if (value.intent !== undefined) {
		assertString(value.intent, "metadata.intent", A2A_LIMITS.maxIntentBytes);
		result.intent = value.intent;
	}
	if (value.acceptanceCriteria !== undefined) {
		result.acceptanceCriteria = parseStringArray(
			value.acceptanceCriteria,
			"metadata.acceptanceCriteria",
			A2A_LIMITS.maxCriteria,
			A2A_LIMITS.maxCriterionBytes,
		);
	}
	if (value.constraints !== undefined) {
		result.constraints = parseConstraints(value.constraints);
	}
	if (value.extensions !== undefined) {
		result.extensions = parseExtensions(value.extensions);
	}
	return result;
}

function parseMessage(value: unknown): A2aMessage {
	assertRecord(value, "message");
	assertKeys(
		value,
		["messageId", "role", "parts", "contextId", "taskId"],
		"message",
	);
	assertString(value.messageId, "message.messageId", A2A_LIMITS.maxMessageIdBytes);
	if (value.role !== "user" && value.role !== "agent") {
		throw new A2aProtocolError("message.role 必须是 user 或 agent");
	}
	if (
		!Array.isArray(value.parts) ||
		value.parts.length === 0 ||
		value.parts.length > A2A_LIMITS.maxTextParts
	) {
		throw new A2aProtocolError(
			`message.parts 必须是 1-${A2A_LIMITS.maxTextParts} 项数组`,
		);
	}
	let totalBytes = 0;
	const parts = value.parts.map((part, index) => {
		assertRecord(part, `message.parts[${index}]`);
		assertKeys(part, ["text"], `message.parts[${index}]`);
		assertString(
			part.text,
			`message.parts[${index}].text`,
			A2A_LIMITS.maxMessageBytes,
		);
		totalBytes += utf8ByteLength(part.text);
		return { text: part.text };
	});
	if (totalBytes > A2A_LIMITS.maxMessageBytes) {
		throw new A2aProtocolError(
			`message.parts 总长度超过 ${A2A_LIMITS.maxMessageBytes} 字节上限`,
		);
	}
	assertOptionalString(
		value.contextId,
		"message.contextId",
		A2A_LIMITS.maxContextIdBytes,
	);
	assertOptionalString(
		value.taskId,
		"message.taskId",
		A2A_LIMITS.maxTaskIdBytes,
	);
	const contextId = value.contextId as string | undefined;
	const taskId = value.taskId as string | undefined;
	return {
		messageId: value.messageId,
		role: value.role,
		parts,
		...(contextId !== undefined ? { contextId } : {}),
		...(taskId !== undefined ? { taskId } : {}),
	};
}

function parseConfiguration(
	value: unknown,
): NonNullable<A2aSendMessageParams["configuration"]> {
	assertRecord(value, "configuration");
	assertKeys(value, ["returnImmediately", "historyLength"], "configuration");
	const result: NonNullable<A2aSendMessageParams["configuration"]> = {};
	if (value.returnImmediately !== undefined) {
		assertBoolean(value.returnImmediately, "configuration.returnImmediately");
		result.returnImmediately = value.returnImmediately;
	}
	if (value.historyLength !== undefined) {
		assertInteger(
			value.historyLength,
			"configuration.historyLength",
			0,
			A2A_LIMITS.maxHistoryLength,
		);
		result.historyLength = value.historyLength;
	}
	return result;
}

function parseSendMessageParams(value: unknown): A2aSendMessageParams {
	assertRecord(value, "params");
	assertKeys(value, ["message", "configuration", "metadata"], "params");
	const result: A2aSendMessageParams = {
		message: parseMessage(value.message),
	};
	if (value.configuration !== undefined) {
		result.configuration = parseConfiguration(value.configuration);
	}
	if (value.metadata !== undefined) {
		result.metadata = parseMetadata(value.metadata);
	}
	return result;
}

function parseGetTaskParams(value: unknown): A2aGetTaskParams {
	assertRecord(value, "params");
	assertKeys(value, ["id", "historyLength"], "params");
	assertString(value.id, "params.id", A2A_LIMITS.maxTaskIdBytes);
	const result: A2aGetTaskParams = { id: value.id };
	if (value.historyLength !== undefined) {
		assertInteger(
			value.historyLength,
			"params.historyLength",
			0,
			A2A_LIMITS.maxHistoryLength,
		);
		result.historyLength = value.historyLength;
	}
	return result;
}

function parseListTasksParams(value: unknown): A2aListTasksParams {
	assertRecord(value, "params");
	assertKeys(
		value,
		[
			"contextId",
			"status",
			"pageSize",
			"pageToken",
			"historyLength",
			"includeArtifacts",
		],
		"params",
	);
	const result: A2aListTasksParams = {};
	if (value.contextId !== undefined) {
		assertString(
			value.contextId,
			"params.contextId",
			A2A_LIMITS.maxContextIdBytes,
		);
		result.contextId = value.contextId;
	}
	if (value.status !== undefined) {
		if (!isA2aTaskState(value.status)) {
			throw new A2aProtocolError("params.status 非法");
		}
		result.status = value.status;
	}
	if (value.pageSize !== undefined) {
		assertInteger(value.pageSize, "params.pageSize", 1, A2A_LIMITS.maxPageSize);
		result.pageSize = value.pageSize;
	}
	if (value.pageToken !== undefined) {
		assertString(
			value.pageToken,
			"params.pageToken",
			A2A_LIMITS.maxPageTokenBytes,
		);
		result.pageToken = value.pageToken;
	}
	if (value.historyLength !== undefined) {
		assertInteger(
			value.historyLength,
			"params.historyLength",
			0,
			A2A_LIMITS.maxHistoryLength,
		);
		result.historyLength = value.historyLength;
	}
	if (value.includeArtifacts !== undefined) {
		assertBoolean(value.includeArtifacts, "params.includeArtifacts");
		result.includeArtifacts = value.includeArtifacts;
	}
	return result;
}

function parseCancelTaskParams(value: unknown): A2aCancelTaskParams {
	assertRecord(value, "params");
	assertKeys(value, ["id"], "params");
	assertString(value.id, "params.id", A2A_LIMITS.maxTaskIdBytes);
	return { id: value.id };
}

/** 解析 A2A JSON-RPC 请求；未知方法、未知字段和超限输入一律拒绝。 */
export function parseA2aJsonRpcRequest(value: unknown): A2aJsonRpcRequest {
	assertRecord(value, "request");
	assertKeys(value, ["jsonrpc", "id", "method", "params"], "request");
	if (value.jsonrpc !== "2.0") {
		throw new A2aProtocolError("jsonrpc 必须是 2.0");
	}
	if (typeof value.id !== "string" && typeof value.id !== "number") {
		throw new A2aProtocolError("id 必须是 string 或 number");
	}
	if (typeof value.id === "string" && value.id.length === 0) {
		throw new A2aProtocolError("id 不得为空字符串");
	}
	if (typeof value.id === "number" && !Number.isFinite(value.id)) {
		throw new A2aProtocolError("id 必须是有限数字");
	}
	switch (value.method) {
		case "SendMessage":
			return {
				jsonrpc: "2.0",
				id: value.id,
				method: "SendMessage",
				params: parseSendMessageParams(value.params),
			};
		case "GetTask":
			return {
				jsonrpc: "2.0",
				id: value.id,
				method: "GetTask",
				params: parseGetTaskParams(value.params),
			};
		case "ListTasks":
			return {
				jsonrpc: "2.0",
				id: value.id,
				method: "ListTasks",
				params: parseListTasksParams(value.params),
			};
		case "CancelTask":
			return {
				jsonrpc: "2.0",
				id: value.id,
				method: "CancelTask",
				params: parseCancelTaskParams(value.params),
			};
		default:
			throw new A2aProtocolError(
				`未知 method ${String((value as { method?: unknown }).method)}`,
				-32601,
			);
	}
}

// ── Agent Registry（ADR-0057）──
// 这是操作者维护的 placement 契约；A2A 对外只投影 Agent Card，不暴露
// clientId/command/args/cwd。

export const AGENT_ADAPTERS = ["acp", "cli"] as const;
export type AgentAdapter = (typeof AGENT_ADAPTERS)[number];

export interface AgentPlacementInput {
	agentId: string;
	name: string;
	adapter: AgentAdapter;
	clientId: string;
	command: string;
	args: string[];
	cwd: string;
	workspaceRoots: string[];
	skills?: string[];
	enabled?: boolean;
}

export interface AgentPlacementInfo {
	id: string;
	agentId: string;
	name: string;
	adapter: AgentAdapter;
	clientId: string;
	workspaceRoots: string[];
	skills: string[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ResolvedAgentPlacement {
	id: string;
	agentId: string;
	adapter: AgentAdapter;
	clientId: string;
	command: string;
	args: string[];
	cwd: string;
	workspaceRoots: string[];
	skills: string[];
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseAgentArgs(value: unknown): string[] {
	return parseStringArray(value, "args", 64, 1024);
}

function parseAgentWorkspaceRoots(value: unknown): string[] {
	return parseStringArray(value, "workspaceRoots", 32, 2048);
}

function parseAgentSkills(value: unknown): string[] {
	return parseStringArray(value, "skills", 32, 128);
}

function parseAgentAdapter(value: unknown): AgentAdapter {
	if (value !== "acp" && value !== "cli") {
		throw new A2aProtocolError("adapter 必须是 acp 或 cli");
	}
	return value;
}

/** 解析操作者创建 placement 的输入；未知字段与非法路径一律拒绝。 */
export function parseAgentPlacementInput(
	value: unknown,
): AgentPlacementInput {
	assertRecord(value, "agent placement");
	assertKeys(
		value,
		[
			"agentId",
			"name",
			"adapter",
			"clientId",
			"command",
			"args",
			"cwd",
			"workspaceRoots",
			"skills",
			"enabled",
		],
		"agent placement",
	);
	assertString(value.agentId, "agentId", 64);
	if (!AGENT_ID_PATTERN.test(value.agentId)) {
		throw new A2aProtocolError("agentId 必须是小写 slug");
	}
	assertString(value.name, "name", 128);
	const adapter = parseAgentAdapter(value.adapter);
	assertString(value.clientId, "clientId", 128);
	assertString(value.command, "command", 1024);
	const args = parseAgentArgs(value.args);
	assertString(value.cwd, "cwd", 2048);
	const workspaceRoots = parseAgentWorkspaceRoots(value.workspaceRoots);
	const result: AgentPlacementInput = {
		agentId: value.agentId,
		name: value.name,
		adapter,
		clientId: value.clientId,
		command: value.command,
		args,
		cwd: value.cwd,
		workspaceRoots,
	};
	if (value.skills !== undefined) {
		result.skills = parseAgentSkills(value.skills);
	}
	if (value.enabled !== undefined) {
		assertBoolean(value.enabled, "enabled");
		result.enabled = value.enabled;
	}
	return result;
}

export type AgentPlacementUpdate = Partial<
	Pick<
		AgentPlacementInput,
		| "name"
		| "adapter"
		| "command"
		| "args"
		| "cwd"
		| "workspaceRoots"
		| "skills"
		| "enabled"
	>
>;

/** 解析 placement 更新；至少一个字段，agentId/clientId 不允许修改。 */
export function parseAgentPlacementUpdate(
	value: unknown,
): AgentPlacementUpdate {
	assertRecord(value, "agent placement update");
	assertKeys(
		value,
		[
			"name",
			"adapter",
			"command",
			"args",
			"cwd",
			"workspaceRoots",
			"skills",
			"enabled",
		],
		"agent placement update",
	);
	if (Object.keys(value).length === 0) {
		throw new A2aProtocolError("placement update 不得为空");
	}
	const result: AgentPlacementUpdate = {};
	if (value.name !== undefined) {
		assertString(value.name, "name", 128);
		result.name = value.name;
	}
	if (value.adapter !== undefined) {
		result.adapter = parseAgentAdapter(value.adapter);
	}
	if (value.command !== undefined) {
		assertString(value.command, "command", 1024);
		result.command = value.command;
	}
	if (value.args !== undefined) {
		result.args = parseAgentArgs(value.args);
	}
	if (value.cwd !== undefined) {
		assertString(value.cwd, "cwd", 2048);
		result.cwd = value.cwd;
	}
	if (value.workspaceRoots !== undefined) {
		result.workspaceRoots = parseAgentWorkspaceRoots(value.workspaceRoots);
	}
	if (value.skills !== undefined) {
		result.skills = parseAgentSkills(value.skills);
	}
	if (value.enabled !== undefined) {
		assertBoolean(value.enabled, "enabled");
		result.enabled = value.enabled;
	}
	return result;
}
