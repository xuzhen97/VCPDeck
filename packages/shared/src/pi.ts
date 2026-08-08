// ── 远程 Pi 协议类型与运行时校验 ──
// 本模块自包含，不 import 同包其他模块，供 Shared/Server/Client/SDK/Frontend 共用。

// ── 稳定错误码 ──
export type PiErrorCode =
	| "PI_PROTOCOL_INVALID"
	| "PI_CLIENT_UNSUPPORTED"
	| "PI_NODE_UNSUPPORTED"
	| "PI_BASH_NOT_FOUND"
	| "PI_RUNTIME_UNAVAILABLE"
	| "PI_AUTH_UNAVAILABLE"
	| "PI_MODEL_NOT_FOUND"
	| "PI_PROJECT_NOT_ALLOWED"
	| "PI_SESSION_NOT_FOUND"
	| "PI_PROJECT_BUSY"
	| "PI_CONTROL_FORBIDDEN"
	| "PI_CLIENT_DISCONNECTED"
	| "PI_WORKER_EXITED"
	| "PI_CLIENT_RESTARTED"
	| "PI_IMAGE_INVALID"
	| "PI_IMAGE_TOO_LARGE"
	| "PI_REQUEST_TIMEOUT";

/** 项目目录引用：由 Files roots 选定，Client 负责 canonicalize 后再使用 */
export interface PiCwdRef {
	rootDir: string;
	relativePath: string;
}

/**
 * 项目不透明 key：Client 用进程级随机 secret 对 canonical cwd 计算 HMAC-SHA-256。
 * 只用于 Server 内存锁与 state reconcile，不含/不返回 cwd，不写 Job/日志/数据库。
 */
export type PiProjectKey = string;

export const PI_PROJECT_KEY_LENGTH = 64;

/** Client Pi 能力状态：探测结果的安全摘要 */
export type PiCapabilityStatus =
	| {
			available: true;
			sdkVersion: string;
			nodeVersion: string;
			shellKind: "configured" | "git-bash" | "path" | "system";
	  }
	| {
			available: false;
			code:
				| "PI_CLIENT_UNSUPPORTED"
				| "PI_NODE_UNSUPPORTED"
				| "PI_BASH_NOT_FOUND"
				| "PI_RUNTIME_UNAVAILABLE"
				| "PI_AUTH_UNAVAILABLE";
			message: string;
			nodeVersion?: string;
	  };

/** Pi 动作：Server → Client 请求的动作 */
export type PiAction =
	| "capability.get"
	| "models.list"
	| "project.resolve"
	| "sessions.list"
	| "session.get"
	| "session.context"
	| "session.entryContent"
	| "session.new"
	| "session.rename"
	| "session.delete"
	| "session.fork"
	| "session.clone"
	| "session.navigate"
	| "agent.state"
	| "agent.prompt"
	| "agent.steer"
	| "agent.followUp"
	| "agent.abort"
	| "agent.compact"
	| "agent.abortCompact"
	| "agent.commands"
	| "agent.stats"
	| "model.set"
	| "thinking.set"
	| "extension.respond";

/** Server → Client 请求（cwdRef 只用于当次远程校验，不复制到 Job） */
export interface PiRequest {
	requestId: string;
	action: PiAction;
	cwdRef?: PiCwdRef;
	sessionId?: string;
	jobId?: string;
	runId?: string;
	payload?: Record<string, unknown>;
}

/** Client → Server 响应 */
export type PiResponse =
	| { requestId: string; ok: true; data?: unknown }
	| {
			requestId: string;
			ok: false;
			error: { code: PiErrorCode; message: string };
	  };

/** 图片数量/大小上限（与 Pi Web 一致，单位字节） */
export const MAX_PI_IMAGES_PER_PROMPT = 10;
export const MAX_PI_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PI_IMAGES_TOTAL_BYTES = 100 * 1024 * 1024;
export const PI_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** prompt 附件描述符（transient，不进 Job/日志） */
export interface PiAttachmentDescriptor {
	fileId: string;
	sha256: string;
	size: number;
	mimeType: string;
	/** 短期下载 URL（transient，不进 Job/日志） */
	url: string;
}

/** prompt 被接受后的权威响应（SSE 断线 fallback 使用） */
export interface PiPromptAccepted {
	jobId: string;
	runId: string;
	sessionId: string;
}

/** 临时附件引用（short-lived，不进 Job/日志） */
export interface PiAttachmentRef {
	fileId: string;
	sha256: string;
	size: number;
	mimeType: string;
	url: string;
	expiresAt: number;
}

/** 投影后的 Agent 事件（Client → Server 包装） */
export interface PiEvent {
	clientId: string;
	sessionId: string;
	jobId: string;
	runId: string;
	event: PiClientEvent;
}

/** 允许进入实时通道的裁剪事件（正文限制在投影层执行） */
export type PiClientEvent =
	| { type: "connected"; sessionId: string }
	| { type: "history_changed"; sessionId: string }
	| { type: "agent_start"; sessionId: string }
	| { type: "agent_end"; sessionId: string }
	| { type: "prompt_done"; sessionId: string }
	| { type: "prompt_error"; sessionId: string; code: PiErrorCode; message: string }
	| { type: "agent_settled"; sessionId: string }
	| { type: "thinking_progress"; sessionId: string; stage: string; durationMs?: number }
	| { type: "extension_request"; sessionId: string; ui: PiExtensionUiRequest }
	| { type: "message_update"; sessionId: string; text?: string; role?: string }
	| { type: "run_created"; sessionId: string; submissionId: string; runId: string }
	| { type: "usage_update"; sessionId: string; usage: Record<string, unknown> }
	| { type: "status_update"; sessionId: string; status: string };

/** 标准 Extension UI 请求（首版只支持对话式） */
export interface PiExtensionUiRequest {
	requestId: string;
	extensionId: string;
	kind:
		| "select"
		| "confirm"
		| "input"
		| "editor"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text";
	title?: string;
	message?: string;
	options?: string[];
	timeoutMs?: number;
}

/** 活动/终态 run 摘要（PI_STATE，不含 cwd/path/prompt） */
export interface PiRunSummary {
	jobId: string;
	runId: string;
	sessionId: string;
	status: "running" | "waiting_input" | "done" | "error";
	projectKey?: PiProjectKey;
}

/** Client 重连/注册时的运行状态报告 */
export interface PiStateReport {
	clientId: string;
	runs: PiRunSummary[];
}

// ── 裁剪后的 Session/消息类型（历史响应，不暴露 JSONL 路径） ──

export interface PiTextContent {
	type: "text";
	text: string;
}

export interface PiImagePlaceholder {
	type: "image";
	deferred: true;
	mimeType: string;
	entryId: string;
	blockIndex: number;
}

/** thinking 正文占位：正文永不离开远程 Session JSONL */
export interface PiThinkingPlaceholder {
	type: "thinking";
	deferred: true;
	durationMs?: number;
}

export interface PiToolCallContent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export type PiMessageContent =
	| PiTextContent
	| PiImagePlaceholder
	| PiThinkingPlaceholder
	| PiToolCallContent;

export interface PiUserMessage {
	id: string;
	role: "user";
	content: (PiTextContent | PiImagePlaceholder)[];
}

export interface PiAssistantMessage {
	id: string;
	role: "assistant";
	content: PiMessageContent[];
}

export interface PiToolResultMessage {
	id: string;
	role: "tool_result";
	toolCallId: string;
	content: PiTextContent[];
}

export interface PiCustomMessage {
	id: string;
	role: "custom";
	kind: string;
}

export type PiMessage =
	| PiUserMessage
	| PiAssistantMessage
	| PiToolResultMessage
	| PiCustomMessage;

/** Session 列表条目（不含 JSONL 绝对路径） */
export interface PiSessionInfo {
	id: string;
	name: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string | null;
	parentSessionId: string | null;
	running: boolean;
}

/** Session 详情（metadata + 投影后的分支树） */
export interface PiSessionDetail {
	info: PiSessionInfo;
	tree: PiSessionTreeNode[];
	activeLeafId: string | null;
}

export interface PiSessionTreeNode {
	id: string;
	name: string;
	messageCount: number;
	running: boolean;
	children: PiSessionTreeNode[];
}

/** 历史分页：entry cursor，默认最新窗口 */
export interface PiSessionContextPage {
	messages: PiMessage[];
	nextCursor: string | null;
}

/** Pi SDK 支持的思考深度（Frontend 的 auto 不属于协议值） */
export const PI_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/** 当前可选模型的安全摘要 */
export interface PiModelInfo {
	provider: string;
	modelId: string;
}

/** 判断值是否为 Pi SDK 支持的思考深度 */
export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
	return typeof value === "string" &&
		(PI_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Agent 状态快照（settlement check 使用） */
export interface PiAgentState {
	status: "idle" | "running" | "compacting" | "waiting_for_extension_input";
	streaming: boolean;
	prompting: boolean;
	compacting: boolean;
	thinkingLevel: PiThinkingLevel;
	queuedMessages: {
		steering: unknown[];
		followUp: unknown[];
	};
	model?: PiModelInfo;
	waitingForExtensionInput?: boolean;
}

// ── 运行时校验（trust boundary parsers） ──

/** 协议解析错误：Server/Client 在信任边界使用 payload 前调用 */
export class PiProtocolError extends Error {
	readonly code = "PI_PROTOCOL_INVALID";
	constructor(message: string) {
		super(message);
		this.name = "PiProtocolError";
	}
}

const ACTIONS: ReadonlySet<string> = new Set<PiAction>([
	"capability.get",
	"models.list",
	"project.resolve",
	"sessions.list",
	"session.get",
	"session.context",
	"session.entryContent",
	"session.new",
	"session.rename",
	"session.delete",
	"session.fork",
	"session.clone",
	"session.navigate",
	"agent.state",
	"agent.prompt",
	"agent.steer",
	"agent.followUp",
	"agent.abort",
	"agent.compact",
	"agent.abortCompact",
	"agent.commands",
	"agent.stats",
	"model.set",
	"thinking.set",
	"extension.respond",
]);

const REQUEST_KEYS = new Set([
	"requestId",
	"action",
	"cwdRef",
	"sessionId",
	"jobId",
	"runId",
	"payload",
]);

const EVENT_TYPES: ReadonlySet<string> = new Set<PiClientEvent["type"]>([
	"connected",
	"history_changed",
	"agent_start",
	"agent_end",
	"prompt_done",
	"prompt_error",
	"agent_settled",
	"thinking_progress",
	"extension_request",
	"message_update",
	"run_created",
	"usage_update",
	"status_update",
]);

const RUN_STATUSES: ReadonlySet<string> = new Set(["running", "waiting_input", "done", "error"]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertRecord(v: unknown, what: string): asserts v is Record<string, unknown> {
	if (!isRecord(v)) throw new PiProtocolError(`${what} 必须是对象`);
}

function assertKeys(v: Record<string, unknown>, allowed: Set<string>, what: string): void {
	for (const key of Object.keys(v)) {
		if (!allowed.has(key)) throw new PiProtocolError(`${what} 含未知字段 ${key}`);
	}
}

function assertString(v: unknown, what: string): asserts v is string {
	if (typeof v !== "string" || v.length === 0) throw new PiProtocolError(`${what} 必须是非空字符串`);
}

function assertIdPair(jobId: unknown, runId: unknown): void {
	if (jobId !== undefined && runId !== undefined && jobId !== runId) {
		throw new PiProtocolError("runId 必须等于 jobId");
	}
}

function parseCwdRef(v: unknown): PiCwdRef {
	assertRecord(v, "cwdRef");
	assertString(v.rootDir, "cwdRef.rootDir");
	assertString(v.relativePath, "cwdRef.relativePath");
	return { rootDir: v.rootDir, relativePath: v.relativePath };
}

function parseAttachments(v: unknown): PiAttachmentDescriptor[] {
	if (!Array.isArray(v)) throw new PiProtocolError("payload.attachments 必须是数组");
	if (v.length > MAX_PI_IMAGES_PER_PROMPT) {
		throw new PiProtocolError(`图片数量超过上限 ${MAX_PI_IMAGES_PER_PROMPT}`);
	}
	let total = 0;
	const out: PiAttachmentDescriptor[] = [];
	for (const item of v) {
		assertRecord(item, "attachment");
		assertString(item.fileId, "attachment.fileId");
		assertString(item.sha256, "attachment.sha256");
		if (typeof item.size !== "number" || !Number.isFinite(item.size)) {
			throw new PiProtocolError("attachment.size 必须是数字");
		}
		assertString(item.mimeType, "attachment.mimeType");
		if (item.size > MAX_PI_IMAGE_BYTES) {
			throw new PiProtocolError(`单张图片超过上限 ${MAX_PI_IMAGE_BYTES} 字节`);
		}
		total += item.size;
		if (total > MAX_PI_IMAGES_TOTAL_BYTES) {
			throw new PiProtocolError(`图片总量超过上限 ${MAX_PI_IMAGES_TOTAL_BYTES} 字节`);
		}
		out.push({
			fileId: item.fileId,
			sha256: item.sha256,
			size: item.size,
			mimeType: item.mimeType,
			url: typeof item.url === "string" ? item.url : "",
		});
	}
	return out;
}

/** 校验 Server → Client 请求（Client Socket 收到后必须先调用） */
export function parsePiRequest(input: unknown): PiRequest {
	assertRecord(input, "PiRequest");
	assertKeys(input, REQUEST_KEYS, "PiRequest");
	assertString(input.requestId, "requestId");
	assertString(input.action, "action");
	if (!ACTIONS.has(input.action)) throw new PiProtocolError(`未知 action ${String(input.action)}`);
	assertIdPair(input.jobId, input.runId);

	if (input.cwdRef !== undefined) input.cwdRef = parseCwdRef(input.cwdRef);
	if (input.sessionId !== undefined) assertString(input.sessionId, "sessionId");

	// prompt 必须携带完整关联 ID
	if (input.action === "agent.prompt") {
		if (input.sessionId === undefined) throw new PiProtocolError("agent.prompt 缺 sessionId");
		if (input.jobId === undefined) throw new PiProtocolError("agent.prompt 缺 jobId");
		if (input.runId === undefined) throw new PiProtocolError("agent.prompt 缺 runId");
		if (input.cwdRef === undefined) throw new PiProtocolError("agent.prompt 缺 cwdRef");
	}

	if (input.payload !== undefined) {
		assertRecord(input.payload, "payload");
		if (input.payload.attachments !== undefined) {
			input.payload.attachments = parseAttachments(input.payload.attachments);
		}
	}
	return input as unknown as PiRequest;
}

/** 校验 Client → Server 响应（Server Gateway 收到后必须先调用） */
export function parsePiResponse(input: unknown): PiResponse {
	assertRecord(input, "PiResponse");
	assertKeys(input, new Set(["requestId", "ok", "data", "error"]), "PiResponse");
	assertString(input.requestId, "requestId");
	if (input.ok !== true && input.ok !== false) throw new PiProtocolError("ok 必须是布尔");
	if (input.ok === true) {
		return { requestId: input.requestId, ok: true, data: input.data };
	}
	assertRecord(input.error, "error");
	assertString(input.error.code, "error.code");
	assertString(input.error.message, "error.message");
	return {
		requestId: input.requestId,
		ok: false,
		error: { code: input.error.code as PiErrorCode, message: input.error.message },
	};
}

const EVENT_KEYS = new Set(["clientId", "sessionId", "jobId", "runId", "event"]);

/** 校验 Client → Server 事件包装（Server Gateway 收到后必须先调用） */
export function parsePiEvent(input: unknown): PiEvent {
	assertRecord(input, "PiEvent");
	assertKeys(input, EVENT_KEYS, "PiEvent");
	assertString(input.clientId, "clientId");
	assertString(input.sessionId, "sessionId");
	assertString(input.jobId, "jobId");
	assertString(input.runId, "runId");
	assertIdPair(input.jobId, input.runId);
	assertRecord(input.event, "event");
	assertString(input.event.type, "event.type");
	if (!EVENT_TYPES.has(input.event.type)) {
		throw new PiProtocolError(`未知 event 类型 ${String(input.event.type)}`);
	}
	return input as unknown as PiEvent;
}

const STATE_KEYS = new Set(["clientId", "runs"]);

/** 校验 Client 运行状态报告（注册/重连时） */
export function parsePiStateReport(input: unknown): PiStateReport {
	assertRecord(input, "PiStateReport");
	assertKeys(input, STATE_KEYS, "PiStateReport");
	assertString(input.clientId, "clientId");
	if (!Array.isArray(input.runs)) throw new PiProtocolError("runs 必须是数组");
	const runs: PiRunSummary[] = [];
	for (const item of input.runs) {
		assertRecord(item, "run");
		assertString(item.jobId, "run.jobId");
		assertString(item.runId, "run.runId");
		assertString(item.sessionId, "run.sessionId");
		assertIdPair(item.jobId, item.runId);
		assertString(item.status, "run.status");
		if (!RUN_STATUSES.has(item.status)) {
			throw new PiProtocolError(`未知 run 状态 ${String(item.status)}`);
		}
		if (item.projectKey !== undefined) {
			assertString(item.projectKey, "run.projectKey");
			if (item.projectKey.length !== PI_PROJECT_KEY_LENGTH) {
				throw new PiProtocolError("projectKey 长度必须为 64");
			}
		}
		runs.push({
			jobId: item.jobId,
			runId: item.runId,
			sessionId: item.sessionId,
			status: item.status as PiRunSummary["status"],
			projectKey: item.projectKey,
		});
	}
	return { clientId: input.clientId, runs };
}
