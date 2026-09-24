// ── 远程 Pi 协议类型与运行时校验 ──
// 本模块自包含，不 import 同包其他模块，供 Shared/Server/Client/SDK/Frontend 共用。

// ── 稳定错误码 ──
export const PI_ERROR_CODES = [
	"PI_PROTOCOL_INVALID",
	"PI_CLIENT_UNSUPPORTED",
	"PI_NODE_UNSUPPORTED",
	"PI_BASH_NOT_FOUND",
	"PI_RUNTIME_UNAVAILABLE",
	"PI_AUTH_UNAVAILABLE",
	"PI_MODEL_NOT_FOUND",
	"PI_PROJECT_NOT_ALLOWED",
	"PI_SESSION_NOT_FOUND",
	"PI_PROJECT_BUSY",
	"PI_CONTROL_FORBIDDEN",
	"PI_CLIENT_DISCONNECTED",
	"PI_WORKER_EXITED",
	"PI_CLIENT_RESTARTED",
	"PI_IMAGE_INVALID",
	"PI_IMAGE_TOO_LARGE",
	"PI_REQUEST_TIMEOUT",
	"PI_STATE_PENDING",
	"PI_CONFIG_UNAVAILABLE",
	"PI_CREDENTIAL_UNAVAILABLE",
	"PI_RUNTIME_SPEC_INCOMPATIBLE",
	"PI_PROVIDER_VALIDATION_FAILED",
	"PI_BUNDLE_UNAVAILABLE",
	"PI_POLICY_UNAVAILABLE",
	"PI_TOOL_POLICY_DENIED",
	"PI_TOOL_POLICY_REJECTED",
] as const;

export type PiErrorCode = (typeof PI_ERROR_CODES)[number];

/** Session Job 协议版本；Server 与新 Client 必须精确匹配。 */
export const PI_SESSION_JOB_PROTOCOL_VERSION = 1;

/**
 * PiRuntimeSpec 协议版本。
 * 只随「Client 是否真正执行该字段」演进：Client 不得接受自己无法施加的策略字段
 * （ADR-0029 决策 10）。
 */
/** v1 parser 的固定版本；v2 使用 Provider 显式配置。 */
export const PI_RUNTIME_SPEC_V1_PROTOCOL_VERSION = 1;
/**
 * 当前 RuntimeSpec 协议版本。
 * v4 在 v3 之上强制携带 `toolExecutionMode`（ADR-0033）；Server/Client 必须精确相等，
 * 版本错位时 Pi 不可用而不是回退到旧语义。
 */
export const PI_RUNTIME_SPEC_PROTOCOL_VERSION = 4;

/** Bundle manifest 协议版本（docs/adr/0030 决策 1）。 */
export const PI_BUNDLE_PROTOCOL_VERSION = 1;

// ── 工具策略（docs/adr/0030 决策 2）──
// pi.ts 必须自包含（不 import 同包其他模块），因此策略目录与解析器定义在这里。

/** 策略桶顺序（解析与展示共用） */
export const PI_TOOL_POLICY_BUCKETS = ["allow", "confirm", "deny"] as const;

export type PiToolPolicyBucket = (typeof PI_TOOL_POLICY_BUCKETS)[number];

/** SDK 0.86.0 内置工具名（`ToolCallEvent` 联合成员）；`powershell` 仅在 Windows 目标机存在。 */
export const PI_BUILTIN_TOOL_IDS = [
	"bash",
	"powershell",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

export type PiBuiltinToolId = (typeof PI_BUILTIN_TOOL_IDS)[number];

/** 工具策略三桶；未出现在任何桶的工具一律不可用（默认拒绝）。 */
export interface PiToolPolicy {
	allow: string[];
	confirm: string[];
	deny: string[];
}

/**
 * Profile 级工具执行模式（ADR-0033）。
 *
 * - `approval`：执行策略允许的能力，`confirm` 每次调用请求人工批准；
 * - `auto`：执行策略允许的能力，`confirm` 不再请求批准；
 * - `yolo`：跳过 Tool Policy 三桶判定，只按当前 Runtime 实际注册/加载的工具执行。
 */
export const PI_TOOL_EXECUTION_MODES = ["approval", "auto", "yolo"] as const;

export type PiToolExecutionMode = (typeof PI_TOOL_EXECUTION_MODES)[number];

/** 判断值是否为受支持的工具执行模式；未知值一律拒绝（不猜默认值）。 */
export function isPiToolExecutionMode(
	value: unknown,
): value is PiToolExecutionMode {
	return (
		typeof value === "string" &&
		(PI_TOOL_EXECUTION_MODES as readonly string[]).includes(value)
	);
}

/** 空策略：等于「所有工具都不可用」，用于未配置策略的历史 Profile。 */
export function emptyPiToolPolicy(): PiToolPolicy {
	return { allow: [], confirm: [], deny: [] };
}

/**
 * 严格解析工具策略：精确三键、桶内去重、跨桶互斥、成员必须属于工具目录。
 * 授权边界不接受宽松输入，任何不满足项都抛 `PiProtocolError`。
 */
export function parsePiToolPolicy(value: unknown, what = "toolPolicy"): PiToolPolicy {
	assertRecord(value, what);
	assertKeys(value, new Set(PI_TOOL_POLICY_BUCKETS), what);

	const seen = new Map<string, PiToolPolicyBucket>();
	const parsed: PiToolPolicy = { allow: [], confirm: [], deny: [] };

	for (const bucket of PI_TOOL_POLICY_BUCKETS) {
		const list = value[bucket];
		if (!Array.isArray(list)) {
			throw new PiProtocolError(`${what}.${bucket} 必须是数组`);
		}
		for (const item of list) {
			if (typeof item !== "string") {
				throw new PiProtocolError(`${what}.${bucket} 只能包含字符串`);
			}
			if (!(PI_BUILTIN_TOOL_IDS as readonly string[]).includes(item)) {
				throw new PiProtocolError(`${what}.${bucket} 含未知工具 ${item}`);
			}
			const previous = seen.get(item);
			if (previous === bucket) {
				throw new PiProtocolError(`${what}.${bucket} 重复工具 ${item}`);
			}
			if (previous) {
				throw new PiProtocolError(
					`${what} 的 ${previous} 与 ${bucket} 必须互斥：${item}`,
				);
			}
			seen.set(item, bucket);
			parsed[bucket].push(item);
		}
	}

	return parsed;
}

/** Bundle 能力上报（Client → Server）：只含资源 ID，不含文件内容。 */
export interface PiBundleCapability {
	protocolVersion: number;
	bundleVersion: string;
	piSdkVersion: string;
	resourceIds: string[];
}

// ── 旧 Session 显式导入（ADR-0031；设计 §21.3）──

/** 导入逐条状态。 */
export type PiImportItemStatus = "imported" | "alreadyImported" | "rejected";

/** 导入被拒绝时的稳定原因码（零新增错误码）。 */
export const PI_IMPORT_REASON_CODES = [
	"PI_PROJECT_NOT_ALLOWED",
	"PI_SESSION_NOT_FOUND",
	"PI_CONFIG_UNAVAILABLE",
] as const;

export type PiImportReasonCode = (typeof PI_IMPORT_REASON_CODES)[number];

/** 会话元数据摘要：不含正文，不含源文件绝对路径。 */
export interface PiImportSessionSummary {
	sourceName: string;
	sourceLabel: string;
	startedAt: string | null;
	entryCount: number;
	cwd: string | null;
	imported: boolean;
	cwdNotAllowed: boolean;
	unreadable: boolean;
}

export interface PiImportListResponse {
	sourceRoot: string;
	sessions: PiImportSessionSummary[];
}

/** 预览正文上限（按 Unicode code point；超限即拒绝，防截断失败泄漏全文）。 */
export const MAX_PREVIEW_CODE_POINTS = 80;

export interface PiImportPreviewResponse {
	sourceName: string;
	previewText: string;
	truncated: boolean;
}

export interface PiImportRunRequest {
	sourceNames: string[];
}

export interface PiImportRunResult {
	sourceName: string;
	status: PiImportItemStatus;
	reasonCode?: PiImportReasonCode;
}

export interface PiImportRunResponse {
	results: PiImportRunResult[];
}

/** 单次导入的源数量上限（run 请求与响应共用，批量导入语义）。 */
export const MAX_IMPORT_SOURCE_NAMES = 50;

/**
 * 列表响应的会话条数上限（协议安全上限）。
 * 与 run 批量上限分离：真实源根可达数百个会话（实测 921），列表必须能全部返回。
 */
export const MAX_IMPORT_LIST_SESSIONS = 2000;

/** 导入源标识长度上限。 */
const MAX_SOURCE_NAME_LENGTH = 255;

/**
 * 校验导入源标识：**纯文件名**（禁 `/`、`\`、NUL，禁 `.` 与 `..`）。
 * 这是防止「把任意目录当源读取」的唯一入口（ADR-0031 决策 2）。
 */
export function assertSourceName(value: unknown, what = "sourceName"): string {
	assertString(value, what, MAX_SOURCE_NAME_LENGTH);
	if (value === "." || value === "..") {
		throw new PiProtocolError(`${what} 不得为 . 或 ..`);
	}
	if (value.includes("/") || value.includes("\\") || value.includes("\u0000")) {
		throw new PiProtocolError(`${what} 含路径逃逸字符`);
	}
	return value;
}

/** 相对源根的展示路径：正斜杠分隔、非绝对、无逃逸片段（与 Bundle manifest 的 path 同构规则）。 */
function assertRelativeLabel(value: unknown, what: string): string {
	assertString(value, what, MAX_SPEC_STRING);
	if (value.startsWith("/") || value.includes("\\")) {
		throw new PiProtocolError(`${what} 必须是以正斜杠分隔的相对路径`);
	}
	for (const segment of value.split("/")) {
		if (segment.length === 0 || segment === "." || segment === "..") {
			throw new PiProtocolError(`${what} 含逃逸或空路径片段`);
		}
	}
	return value;
}

function parseOptionalIsoDate(value: unknown, what: string): string | null {
	if (value === null || value === undefined) return null;
	assertString(value, what, MAX_SPEC_STRING);
	if (Number.isNaN(Date.parse(value))) {
		throw new PiProtocolError(`${what} 不是可解析时间`);
	}
	return value;
}

function parseOptionalPath(value: unknown, what: string): string | null {
	if (value === null || value === undefined) return null;
	assertString(value, what, MAX_SPEC_STRING);
	return value;
}

function parseImportBool(value: unknown, what: string): boolean {
	if (value !== true && value !== false) {
		throw new PiProtocolError(`${what} 必须是布尔`);
	}
	return value;
}

const IMPORT_SUMMARY_KEYS = new Set([
	"sourceName",
	"sourceLabel",
	"startedAt",
	"entryCount",
	"cwd",
	"imported",
	"cwdNotAllowed",
	"unreadable",
]);
const IMPORT_LIST_KEYS = new Set(["sourceRoot", "sessions"]);
const IMPORT_PREVIEW_KEYS = new Set(["sourceName", "previewText", "truncated"]);
const IMPORT_RUN_REQUEST_KEYS = new Set(["sourceNames"]);
const IMPORT_RUN_RESPONSE_KEYS = new Set(["results"]);
const IMPORT_RUN_RESULT_KEYS = new Set(["sourceName", "status", "reasonCode"]);
const IMPORT_ITEM_STATUSES = new Set<string>([
	"imported",
	"alreadyImported",
	"rejected",
]);
const IMPORT_REASON_CODE_SET = new Set<string>(PI_IMPORT_REASON_CODES);

/** 严格解析导入列表响应（Server 出口必须调用；未知字段拒绝）。 */
export function parsePiImportListResponse(value: unknown): PiImportListResponse {
	assertRecord(value, "PiImportListResponse");
	assertKeys(value, IMPORT_LIST_KEYS, "PiImportListResponse");
	assertString(value.sourceRoot, "sourceRoot", MAX_SPEC_STRING);
	if (!Array.isArray(value.sessions)) {
		throw new PiProtocolError("sessions 必须是数组");
	}
	if (value.sessions.length > MAX_IMPORT_LIST_SESSIONS) {
		throw new PiProtocolError(
			`sessions 数量不能超过 ${MAX_IMPORT_LIST_SESSIONS}`,
		);
	}
	const sessions = value.sessions.map((raw: unknown, index: number) => {
		const what = `sessions[${index}]`;
		assertRecord(raw, what);
		assertKeys(raw, IMPORT_SUMMARY_KEYS, what);
		return {
			sourceName: assertSourceName(raw.sourceName, `${what}.sourceName`),
			sourceLabel: assertRelativeLabel(raw.sourceLabel, `${what}.sourceLabel`),
			startedAt: parseOptionalIsoDate(raw.startedAt, `${what}.startedAt`),
			entryCount: parseImportEntryCount(raw.entryCount, `${what}.entryCount`),
			cwd: parseOptionalPath(raw.cwd, `${what}.cwd`),
			imported: parseImportBool(raw.imported, `${what}.imported`),
			cwdNotAllowed: parseImportBool(
				raw.cwdNotAllowed,
				`${what}.cwdNotAllowed`,
			),
			unreadable: parseImportBool(raw.unreadable, `${what}.unreadable`),
		};
	});
	return { sourceRoot: value.sourceRoot, sessions };
}

function parseImportEntryCount(value: unknown, what: string): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 1_000_000
	) {
		throw new PiProtocolError(`${what} 必须是非负整数`);
	}
	return value;
}

/** 严格解析预览响应：`previewText` 必须已按 code point 截到 80。 */
export function parsePiImportPreviewResponse(
	value: unknown,
): PiImportPreviewResponse {
	assertRecord(value, "PiImportPreviewResponse");
	assertKeys(value, IMPORT_PREVIEW_KEYS, "PiImportPreviewResponse");
	const sourceName = assertSourceName(value.sourceName, "sourceName");
	assertString(value.previewText, "previewText", MAX_SPEC_STRING);
	if ([...value.previewText].length > MAX_PREVIEW_CODE_POINTS) {
		throw new PiProtocolError(
			`previewText 超过 ${MAX_PREVIEW_CODE_POINTS} 个字符（必须先截断）`,
		);
	}
	return {
		sourceName,
		previewText: value.previewText,
		truncated: parseImportBool(value.truncated, "truncated"),
	};
}

/** 严格解析导入请求：1–50 个纯文件名、去重保序、任一非法即整请求拒绝。 */
export function parsePiImportRunRequest(value: unknown): PiImportRunRequest {
	assertRecord(value, "PiImportRunRequest");
	assertKeys(value, IMPORT_RUN_REQUEST_KEYS, "PiImportRunRequest");
	const rawNames: unknown = value.sourceNames;
	if (!Array.isArray(rawNames)) {
		throw new PiProtocolError("sourceNames 必须是数组");
	}
	if (rawNames.length === 0) {
		throw new PiProtocolError("sourceNames 不能为空");
	}
	if (rawNames.length > MAX_IMPORT_SOURCE_NAMES) {
		throw new PiProtocolError(
			`sourceNames 数量不能超过 ${MAX_IMPORT_SOURCE_NAMES}`,
		);
	}
	const names = rawNames.map((_: unknown, index: number) =>
		assertSourceName(rawNames[index], `sourceNames[${index}]`),
	);
	return { sourceNames: [...new Set(names)] };
}

/** 严格解析逐条导入结果；`reasonCode` 仅限三个稳定码。 */
export function parsePiImportRunResponse(value: unknown): PiImportRunResponse {
	assertRecord(value, "PiImportRunResponse");
	assertKeys(value, IMPORT_RUN_RESPONSE_KEYS, "PiImportRunResponse");
	if (!Array.isArray(value.results)) {
		throw new PiProtocolError("results 必须是数组");
	}
	if (value.results.length > MAX_IMPORT_SOURCE_NAMES) {
		throw new PiProtocolError(
			`results 数量不能超过 ${MAX_IMPORT_SOURCE_NAMES}`,
		);
	}
	const results = value.results.map((raw: unknown, index: number) => {
		const what = `results[${index}]`;
		assertRecord(raw, what);
		assertKeys(raw, IMPORT_RUN_RESULT_KEYS, what);
		const sourceName = assertSourceName(raw.sourceName, `${what}.sourceName`);
		if (typeof raw.status !== "string" || !IMPORT_ITEM_STATUSES.has(raw.status)) {
			throw new PiProtocolError(`${what}.status 不受支持`);
		}
		if (raw.reasonCode !== undefined) {
			if (
				typeof raw.reasonCode !== "string" ||
				!IMPORT_REASON_CODE_SET.has(raw.reasonCode)
			) {
				throw new PiProtocolError(`${what}.reasonCode 只能是三个稳定码之一`);
			}
			return {
				sourceName,
				status: raw.status as PiImportItemStatus,
				reasonCode: raw.reasonCode as PiImportReasonCode,
			};
		}
		return {
			sourceName,
			status: raw.status as PiImportItemStatus,
		};
	});
	return { results };
}

export type PiSessionJobStatus =
	| "idle"
	| "pending"
	| "running"
	| "waiting_input"
	| "done"
	| "disconnected"
	| "error"
	| "cancelled";

export interface PiSessionJobSnapshot {
	jobId: string;
	sessionId: string;
	status: PiSessionJobStatus;
	runId: string | null;
	ownerName: string | null;
	isOwner: boolean;
	errorCode?: PiErrorCode;
	errorMessage?: string;
}

export interface PiSessionCreated {
	sessionId: string;
	jobId: string;
}

export interface PiSessionOpenResult {
	job: PiSessionJobSnapshot;
	agentState: PiAgentState;
}

export interface PiStateAck {
	acceptedRunIds: string[];
	closedRunIds: string[];
	reportAgain: boolean;
}

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

/** Pi 配置状态：决定是否允许需要 Worker 的业务动作。 */
export type PiConfigState = "pending" | "ready" | "incompatible" | "stale";

/** 模型引用（不含凭据）。 */
export interface PiModelRef {
	provider: string;
	modelId: string;
	maxThinkingLevel?: string;
}


export type PiProviderProtocol =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

/** Pi SDK 注册 Provider 所需的非秘密模型元数据。 */
export interface PiProviderModelInfo {
	id: string;
	name: string;
	api?: PiProviderProtocol;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	compat?: Record<string, boolean | string | number>;
}

/** 模型元数据来源：Client 侧 Pi 内置目录解析，或 Server 显式配置。 */
export type PiModelMetadataSource = "catalog" | "explicit";

/**
 * 由 Pi 内置目录提供元数据的模型。
 *
 * Server 只保存 modelId 与展示名，元数据由 Client 用自身 SDK 的模型目录解析，
 * 因此不会丢失内置目录的 baseUrl / compat / thinkingLevelMap / promptCache 与真实成本。
 */
export interface PiCatalogModel {
	id: string;
	name: string;
	metadataSource: "catalog";
}

/** 显式元数据模型：内置目录没有的自定义端点必须使用此来源。 */
export interface PiExplicitModel {
	id: string;
	name: string;
	metadataSource: "explicit";
	metadata: PiProviderModelInfo;
}

/** Provider 模型条目：来源判别联合，禁止「半真半假」的部分元数据。 */
export type PiProviderModel = PiCatalogModel | PiExplicitModel;

/**
 * Server 对某 Client 某时刻的不可变运行快照（不含 Secret）。
 *
 * 字段集合只随「Client 是否真正执行该字段」演进；未知字段与未知 schemaVersion
 * 必须被 Client 拒绝（ADR-0029 决策 10）。
 */
export interface PiRuntimeSpecV1 {
	schemaVersion: number;
	specId: string;
	profileId: string;
	profileRevision: number;
	modelPolicy: {
		defaultModel: { provider: string; modelId: string };
		allowedModels: PiModelRef[];
		defaultThinkingLevel: string;
	};
	runtimeRevision: string;
}

/** 敏感：只允许存在于运行内存，不得落盘、入日志或进 API 响应。 */
export interface PiCredentialLeaseEntry {
	provider: string;
	apiKey: string;
}

export interface PiCredentialLease {
	issuedAt: string;
	entries: PiCredentialLeaseEntry[];
}

export interface PiRuntimeProviderSpec {
	providerId: string;
	name: string;
	protocol: PiProviderProtocol;
	baseUrl?: string;
	headers: Record<string, string>;
	models: PiProviderModel[];
}

export interface PiRuntimeSpecV3 {
	schemaVersion: 3;
	specId: string;
	profileId: string;
	profileRevision: number;
	providers: PiRuntimeProviderSpec[];
	modelPolicy: {
		defaultModel: { provider: string; modelId: string };
		allowedModels: PiModelRef[];
		defaultThinkingLevel: string;
	};
	/** 工具策略：未出现在任何桶的工具默认拒绝。 */
	toolPolicy: PiToolPolicy;
	/** 存在当且仅当 Profile 需要 Bundle 资源。 */
	requiredBundle?: {
		protocolVersion: number;
		bundleVersion: string;
		resourceIds: string[];
	};
	runtimeRevision: string;
}

export interface PiCredentialLeaseEntryV2 {
	providerId: string;
	apiKey: string;
}

export interface PiCredentialLeaseV2 {
	issuedAt: string;
	entries: PiCredentialLeaseEntryV2[];
}

export interface PiRuntimeSpecMessageV3 {
	spec: PiRuntimeSpecV3;
	credentials: PiCredentialLeaseV2;
}

/**
 * RuntimeSpec v4：在 v3 基础上强制携带 Profile 级工具执行模式（ADR-0033）。
 * 模式会改变 Client 实际执行工具的行为，因此不能作为 v3 的可选字段下发。
 */
export interface PiRuntimeSpecV4 {
	schemaVersion: 4;
	specId: string;
	profileId: string;
	profileRevision: number;
	providers: PiRuntimeProviderSpec[];
	modelPolicy: {
		defaultModel: { provider: string; modelId: string };
		allowedModels: PiModelRef[];
		defaultThinkingLevel: string;
	};
	/** 工具策略：未出现在任何桶的工具默认拒绝。 */
	toolPolicy: PiToolPolicy;
	/** 工具执行模式：决定 Tool Policy 如何被执行。 */
	toolExecutionMode: PiToolExecutionMode;
	/** 存在当且仅当 Profile 需要 Bundle 资源。 */
	requiredBundle?: {
		protocolVersion: number;
		bundleVersion: string;
		resourceIds: string[];
	};
	runtimeRevision: string;
}

export interface PiRuntimeSpecMessageV4 {
	spec: PiRuntimeSpecV4;
	credentials: PiCredentialLeaseV2;
}

/** Server → Client（Events.PI_RUNTIME_SPEC） */
export interface PiRuntimeSpecMessage {
	spec: PiRuntimeSpecV1;
	credentials: PiCredentialLease;
}

/** Client → Server（Events.PI_RUNTIME_ACK） */
export interface PiRuntimeAck {
	clientId: string;
	specId: string | null;
	runtimeRevision: string | null;
	configState: PiConfigState;
	reasonCode?: PiErrorCode;
	resolvedModels?: PiModelRef[];
	unavailableModels?: Array<{
		provider: string;
		modelId: string;
		reason: string;
	}>;
	activeRuntimeRevision?: string | null;
}

/**
 * Client 侧 Pi 模型目录能力摘要：只上报内置 Provider ID，不上报模型元数据。
 *
 * 用途仅为让 Server 在模型发现时建议 metadataSource；不构成配置权威。
 */
export interface PiModelCatalogStatus {
	sdkVersion: string;
	providerIds: string[];
}

/** Client Pi 能力状态：探测结果的安全摘要 */
export type PiCapabilityStatus =
	| {
			available: true;
			sdkVersion: string;
			nodeVersion: string;
			shellKind: "configured" | "git-bash" | "path" | "system";
			/** 旧 Client 缺省；新 Client 固定上报当前版本。 */
			sessionJobProtocolVersion?: number;
			/** 缺失 = 旧 Client，不支持隔离运行时（设计 §22）。 */
			runtimeSpecProtocolVersion?: number;
			/** 新 Client 固定上报 server-authoritative。 */
			configMode?: "server-authoritative";
			/** 缺失 = 未上报内置模型目录，Server 无法建议来源。 */
			modelCatalog?: PiModelCatalogStatus;
			/** 缺失 = 无可用 Bundle（未找到、校验失败或 SDK 版本不符）。 */
			bundle?: PiBundleCapability;
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
	| "extension.respond"
	| "session.import.list"
	| "session.import.preview"
	| "session.import.run";

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
export const PI_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

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
	| {
			type: "prompt_error";
			sessionId: string;
			code: PiErrorCode;
			message: string;
	  }
	| { type: "agent_settled"; sessionId: string }
	| {
			type: "thinking_progress";
			sessionId: string;
			stage: string;
			text?: string;
			durationMs?: number;
	  }
	| { type: "extension_request"; sessionId: string; ui: PiExtensionUiRequest }
	| {
			type: "extension_resolved";
			sessionId: string;
			requestId: string;
			reason: "answered" | "cancelled" | "timeout";
			hasPending: boolean;
	  }
	| { type: "message_update"; sessionId: string; text?: string; role?: string }
	| {
			type: "run_created";
			sessionId: string;
			submissionId: string;
			runId: string;
	  }
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
	status: "running" | "waiting_input" | "idle" | "done" | "error";
	projectKey?: PiProjectKey;
}

/** Client 重连/注册时的运行状态报告 */
export interface PiStateReport {
	clientId: string;
	runs: PiRunSummary[];
	/** 当前 desired runtimeRevision；旧 Client 不上报时为 null。 */
	runtimeRevision: string | null;
	/** 旧 Client 不上报时为 pending（等价未就绪，拒绝 WORKER_ACTIONS）。 */
	configState: PiConfigState;
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
	/** 当前回合实时思考正文；历史 Session 不填充。 */
	text?: string;
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
	return (
		typeof value === "string" &&
		(PI_THINKING_LEVELS as readonly string[]).includes(value)
	);
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
	pendingExtension?: PiExtensionUiRequest;
}

/** 严格空闲判定：四标志空闲 + 无排队 Extension + 无等待输入 + steering/followUp 队列空。 */
export function isPiAgentIdle(state: PiAgentState): boolean {
	return (
		state.status === "idle" &&
		state.streaming === false &&
		state.prompting === false &&
		state.compacting === false &&
		state.pendingExtension === undefined &&
		state.waitingForExtensionInput !== true &&
		state.queuedMessages.steering.length === 0 &&
		state.queuedMessages.followUp.length === 0
	);
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
	"session.import.list",
	"session.import.preview",
	"session.import.run",
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

const RUN_SCOPED_ACTIONS: ReadonlySet<PiAction> = new Set([
	"agent.prompt",
	"agent.steer",
	"agent.followUp",
	"agent.abort",
	"agent.compact",
	"agent.abortCompact",
	"extension.respond",
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
	"extension_resolved",
	"message_update",
	"run_created",
	"usage_update",
	"status_update",
]);

const RUN_STATUSES: ReadonlySet<string> = new Set([
	"running",
	"waiting_input",
	"idle",
	"done",
	"error",
]);
const ERROR_CODES: ReadonlySet<string> = new Set(PI_ERROR_CODES);
const EXTENSION_UI_KINDS = new Set([
	"select",
	"confirm",
	"input",
	"editor",
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
]);
const INTERACTIVE_EXTENSION_UI_KINDS = new Set([
	"select",
	"confirm",
	"input",
	"editor",
]);
const AGENT_STATUSES = new Set([
	"idle",
	"running",
	"compacting",
	"waiting_for_extension_input",
]);
const MAX_TEXT_CHARS = 16_384;
const MAX_ERROR_MESSAGE_CHARS = 4_096;
const MAX_OPTION_CHARS = 4_096;
const MAX_EXTENSION_OPTIONS = 100;
const MAX_QUEUE_ITEMS = 1_000;
const MAX_STATE_RUNS = 1_000;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertRecord(
	v: unknown,
	what: string,
): asserts v is Record<string, unknown> {
	if (!isRecord(v)) throw new PiProtocolError(`${what} 必须是对象`);
}

function assertKeys(
	v: Record<string, unknown>,
	allowed: Set<string>,
	what: string,
): void {
	for (const key of Object.keys(v)) {
		if (!allowed.has(key))
			throw new PiProtocolError(`${what} 含未知字段 ${key}`);
	}
}

function assertString(
	v: unknown,
	what: string,
	maxLength?: number,
): asserts v is string {
	if (typeof v !== "string" || v.length === 0)
		throw new PiProtocolError(`${what} 必须是非空字符串`);
	if (maxLength !== undefined && v.length > maxLength)
		throw new PiProtocolError(`${what} 长度超过上限 ${maxLength}`);
}

function assertOptionalString(v: unknown, what: string, maxLength: number): void {
	if (v !== undefined) assertString(v, what, maxLength);
}

function assertSessionJobPair(sessionId: unknown, jobId: unknown): void {
	if (sessionId !== undefined && jobId !== undefined && sessionId !== jobId) {
		throw new PiProtocolError("jobId 必须等于 sessionId");
	}
}

function assertErrorCode(v: unknown, what: string): asserts v is PiErrorCode {
	assertString(v, what);
	if (!ERROR_CODES.has(v)) throw new PiProtocolError(`${what} 不在 allowlist`);
}

/** 返回可安全出站的 Pi 错误消息，避免泄露任意对象内容。 */
export function safePiErrorMessage(value: unknown): string {
	return typeof value === "string" && value.length > 0
		? value.slice(0, MAX_ERROR_MESSAGE_CHARS)
		: "Pi request failed";
}

function parseExtensionUi(
	value: unknown,
	what: string,
	interactiveOnly = false,
): PiExtensionUiRequest {
	assertRecord(value, what);
	assertKeys(
		value,
		new Set([
			"requestId",
			"extensionId",
			"kind",
			"title",
			"message",
			"options",
			"timeoutMs",
		]),
		what,
	);
	assertString(value.requestId, `${what}.requestId`, MAX_TEXT_CHARS);
	assertString(value.extensionId, `${what}.extensionId`, MAX_TEXT_CHARS);
	assertString(value.kind, `${what}.kind`);
	const kinds = interactiveOnly
		? INTERACTIVE_EXTENSION_UI_KINDS
		: EXTENSION_UI_KINDS;
	if (!kinds.has(value.kind))
		throw new PiProtocolError(`${what}.kind 不受支持`);
	assertOptionalString(value.title, `${what}.title`, MAX_TEXT_CHARS);
	assertOptionalString(value.message, `${what}.message`, MAX_TEXT_CHARS);
	if (value.options !== undefined) {
		if (!Array.isArray(value.options))
			throw new PiProtocolError(`${what}.options 必须是数组`);
		if (value.options.length > MAX_EXTENSION_OPTIONS)
			throw new PiProtocolError(`${what}.options 数量超过上限`);
		for (const option of value.options)
			assertString(option, `${what}.options 项`, MAX_OPTION_CHARS);
	}
	if (
		value.timeoutMs !== undefined &&
		(typeof value.timeoutMs !== "number" ||
			!Number.isFinite(value.timeoutMs) ||
			value.timeoutMs < 0)
	) {
		throw new PiProtocolError(`${what}.timeoutMs 必须是非负数字`);
	}
	return value as unknown as PiExtensionUiRequest;
}

function parseCwdRef(v: unknown): PiCwdRef {
	assertRecord(v, "cwdRef");
	assertString(v.rootDir, "cwdRef.rootDir");
	// relativePath 允许空串：空串表示「root 自身」（前端项目根/盘符根即用该表示，
	// 客户端 resolve(root, "") 即 root）。要求非空会让选盘符根时所有 Pi 请求 400。
	if (typeof v.relativePath !== "string") {
		throw new PiProtocolError("cwdRef.relativePath 必须是字符串");
	}
	return { rootDir: v.rootDir, relativePath: v.relativePath };
}

function parseAttachments(v: unknown): PiAttachmentDescriptor[] {
	if (!Array.isArray(v))
		throw new PiProtocolError("payload.attachments 必须是数组");
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
			throw new PiProtocolError(
				`图片总量超过上限 ${MAX_PI_IMAGES_TOTAL_BYTES} 字节`,
			);
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
	if (!ACTIONS.has(input.action))
		throw new PiProtocolError(`未知 action ${String(input.action)}`);
	assertSessionJobPair(input.sessionId, input.jobId);

	if (input.cwdRef !== undefined) input.cwdRef = parseCwdRef(input.cwdRef);
	if (input.sessionId !== undefined) assertString(input.sessionId, "sessionId");
	if (input.jobId !== undefined) assertString(input.jobId, "jobId");
	if (input.runId !== undefined) assertString(input.runId, "runId");

	if (RUN_SCOPED_ACTIONS.has(input.action as PiAction)) {
		if (input.sessionId === undefined)
			throw new PiProtocolError(`${input.action} 缺 sessionId`);
		if (input.jobId === undefined)
			throw new PiProtocolError(`${input.action} 缺 jobId`);
		if (input.runId === undefined)
			throw new PiProtocolError(`${input.action} 缺 runId`);
	}
	if (input.action === "agent.prompt" && input.cwdRef === undefined)
		throw new PiProtocolError("agent.prompt 缺 cwdRef");

	// 旧 Session 显式导入：payload 在 envelope 层严格校验（跨信任边界，ADR-0031）。
	if (input.action === "session.import.list") {
		if (input.payload !== undefined) {
			assertRecord(input.payload, "payload");
			assertKeys(input.payload, new Set(), "payload");
		}
	} else if (input.action === "session.import.preview") {
		if (input.payload === undefined)
			throw new PiProtocolError("session.import.preview 缺 payload");
		assertRecord(input.payload, "payload");
		assertKeys(input.payload, new Set(["sourceName"]), "payload");
		input.payload = {
			sourceName: assertSourceName(input.payload.sourceName, "payload.sourceName"),
		};
	} else if (input.action === "session.import.run") {
		if (input.payload === undefined)
			throw new PiProtocolError("session.import.run 缺 payload");
		input.payload = parsePiImportRunRequest(input.payload);
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
	assertKeys(
		input,
		new Set(["requestId", "ok", "data", "error"]),
		"PiResponse",
	);
	assertString(input.requestId, "requestId");
	if (input.ok !== true && input.ok !== false)
		throw new PiProtocolError("ok 必须是布尔");
	if (input.ok === true) {
		return { requestId: input.requestId, ok: true, data: input.data };
	}
	assertRecord(input.error, "error");
	assertKeys(input.error, new Set(["code", "message"]), "error");
	assertErrorCode(input.error.code, "error.code");
	assertString(input.error.message, "error.message", MAX_ERROR_MESSAGE_CHARS);
	return {
		requestId: input.requestId,
		ok: false,
		error: {
			code: input.error.code as PiErrorCode,
			message: input.error.message,
		},
	};
}

const MAX_THINKING_TEXT_CHARS = 16_384;

/** 严格校验 Agent 状态快照。 */
export function parsePiAgentState(input: unknown): PiAgentState {
	assertRecord(input, "PiAgentState");
	assertKeys(
		input,
		new Set([
			"status",
			"streaming",
			"prompting",
			"compacting",
			"thinkingLevel",
			"queuedMessages",
			"model",
			"waitingForExtensionInput",
			"pendingExtension",
		]),
		"PiAgentState",
	);
	assertString(input.status, "status");
	if (!AGENT_STATUSES.has(input.status))
		throw new PiProtocolError("status 不受支持");
	for (const key of ["streaming", "prompting", "compacting"] as const) {
		if (typeof input[key] !== "boolean")
			throw new PiProtocolError(`${key} 必须是布尔`);
	}
	if (!isPiThinkingLevel(input.thinkingLevel))
		throw new PiProtocolError("thinkingLevel 不受支持");
	assertRecord(input.queuedMessages, "queuedMessages");
	assertKeys(
		input.queuedMessages,
		new Set(["steering", "followUp"]),
		"queuedMessages",
	);
	for (const key of ["steering", "followUp"] as const) {
		const queue = input.queuedMessages[key];
		if (!Array.isArray(queue))
			throw new PiProtocolError(`queuedMessages.${key} 必须是数组`);
		if (queue.length > MAX_QUEUE_ITEMS)
			throw new PiProtocolError(`queuedMessages.${key} 数量超过上限`);
	}
	if (input.model !== undefined) {
		assertRecord(input.model, "model");
		assertKeys(input.model, new Set(["provider", "modelId"]), "model");
		assertString(input.model.provider, "model.provider", MAX_TEXT_CHARS);
		assertString(input.model.modelId, "model.modelId", MAX_TEXT_CHARS);
	}
	if (
		input.waitingForExtensionInput !== undefined &&
		typeof input.waitingForExtensionInput !== "boolean"
	) {
		throw new PiProtocolError("waitingForExtensionInput 必须是布尔");
	}
	if (input.pendingExtension !== undefined)
		input.pendingExtension = parseExtensionUi(
			input.pendingExtension,
			"pendingExtension",
			true,
		);
	return input as unknown as PiAgentState;
}

const EVENT_KEYS = new Set([
	"clientId",
	"sessionId",
	"jobId",
	"runId",
	"event",
]);

/** 校验 Client → Server 事件包装（Server Gateway 收到后必须先调用） */
export function parsePiEvent(input: unknown): PiEvent {
	assertRecord(input, "PiEvent");
	assertKeys(input, EVENT_KEYS, "PiEvent");
	assertString(input.clientId, "clientId");
	assertString(input.sessionId, "sessionId");
	assertString(input.jobId, "jobId");
	assertString(input.runId, "runId");
	assertSessionJobPair(input.sessionId, input.jobId);
	assertRecord(input.event, "event");
	assertString(input.event.type, "event.type");
	if (!EVENT_TYPES.has(input.event.type))
		throw new PiProtocolError(`未知 event 类型 ${String(input.event.type)}`);
	assertString(input.event.sessionId, "event.sessionId");
	if (input.event.sessionId !== input.sessionId)
		throw new PiProtocolError("event.sessionId 必须等于外层 sessionId");

	const common = ["type", "sessionId"];
	switch (input.event.type) {
		case "connected":
		case "history_changed":
		case "agent_start":
		case "agent_end":
		case "prompt_done":
		case "agent_settled":
			assertKeys(input.event, new Set(common), "event");
			break;
		case "prompt_error":
			assertKeys(input.event, new Set([...common, "code", "message"]), "event");
			assertErrorCode(input.event.code, "event.code");
			assertString(input.event.message, "event.message", MAX_ERROR_MESSAGE_CHARS);
			break;
		case "thinking_progress":
			assertKeys(
				input.event,
				new Set([...common, "stage", "text", "durationMs"]),
				"event",
			);
			assertString(input.event.stage, "event.stage", MAX_TEXT_CHARS);
			if (input.event.text !== undefined) {
				assertString(input.event.text, "event.text");
				input.event.text = input.event.text.slice(0, MAX_THINKING_TEXT_CHARS);
			}
			if (
				input.event.durationMs !== undefined &&
				(typeof input.event.durationMs !== "number" ||
					!Number.isFinite(input.event.durationMs) ||
					input.event.durationMs < 0)
			)
				throw new PiProtocolError("event.durationMs 必须是非负数字");
			break;
		case "extension_request":
			assertKeys(input.event, new Set([...common, "ui"]), "event");
			input.event.ui = parseExtensionUi(input.event.ui, "event.ui", true);
			break;
		case "extension_resolved":
			assertKeys(
				input.event,
				new Set([...common, "requestId", "reason", "hasPending"]),
				"event",
			);
			assertString(input.event.requestId, "event.requestId", MAX_TEXT_CHARS);
			if (
				input.event.reason !== "answered" &&
				input.event.reason !== "cancelled" &&
				input.event.reason !== "timeout"
			)
				throw new PiProtocolError("event.reason 不受支持");
			if (typeof input.event.hasPending !== "boolean")
				throw new PiProtocolError("event.hasPending 必须是布尔");
			break;
		case "message_update":
			assertKeys(input.event, new Set([...common, "text", "role"]), "event");
			assertOptionalString(input.event.text, "event.text", MAX_TEXT_CHARS);
			assertOptionalString(input.event.role, "event.role", MAX_TEXT_CHARS);
			break;
		case "run_created":
			assertKeys(
				input.event,
				new Set([...common, "submissionId", "runId"]),
				"event",
			);
			assertString(input.event.submissionId, "event.submissionId", MAX_TEXT_CHARS);
			assertString(input.event.runId, "event.runId", MAX_TEXT_CHARS);
			break;
		case "usage_update":
			assertKeys(input.event, new Set([...common, "usage"]), "event");
			assertRecord(input.event.usage, "event.usage");
			break;
		case "status_update":
			assertKeys(input.event, new Set([...common, "status"]), "event");
			assertString(input.event.status, "event.status", MAX_TEXT_CHARS);
			break;
	}
	return input as unknown as PiEvent;
}

const STATE_KEYS = new Set([
	"clientId",
	"runs",
	"runtimeRevision",
	"configState",
]);

/** 校验 Client 运行状态报告（注册/重连时） */
export function parsePiStateReport(input: unknown): PiStateReport {
	assertRecord(input, "PiStateReport");
	assertKeys(input, STATE_KEYS, "PiStateReport");
	assertString(input.clientId, "clientId");
	if (!Array.isArray(input.runs)) throw new PiProtocolError("runs 必须是数组");
	if (input.runs.length > MAX_STATE_RUNS)
		throw new PiProtocolError("runs 数量超过上限 1000");
	const runs: PiRunSummary[] = [];
	for (const item of input.runs) {
		assertRecord(item, "run");
		assertKeys(
			item,
			new Set(["jobId", "runId", "sessionId", "status", "projectKey"]),
			"run",
		);
		assertString(item.jobId, "run.jobId");
		assertString(item.runId, "run.runId");
		assertString(item.sessionId, "run.sessionId");
		assertSessionJobPair(item.sessionId, item.jobId);
		assertString(item.status, "run.status");
		if (!RUN_STATUSES.has(item.status)) {
			throw new PiProtocolError(`未知 run 状态 ${String(item.status)}`);
		}
		if (item.status === "running" || item.status === "waiting_input") {
			assertString(item.projectKey, "run.projectKey");
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
	return { clientId: input.clientId, runs, ...parseReportRuntimeState(input) };
}

/** 解析 PI_STATE 的 runtimeRevision/configState（旧 Client 缺省时视为未就绪）。 */
function parseReportRuntimeState(input: Record<string, unknown>): {
	runtimeRevision: string | null;
	configState: PiConfigState;
} {
	let runtimeRevision: string | null = null;
	if (input.runtimeRevision !== undefined && input.runtimeRevision !== null) {
		runtimeRevision = requireRuntimeRevision(
			input.runtimeRevision,
			"runtimeRevision",
		);
	}
	let configState: PiConfigState = "pending";
	if (input.configState !== undefined) {
		if (
			typeof input.configState !== "string" ||
			!CONFIG_STATES.has(input.configState)
		) {
			throw new PiProtocolError(
				"configState 必须为 pending/ready/incompatible/stale",
			);
		}
		configState = input.configState as PiConfigState;
	}
	return { runtimeRevision, configState };
}

// ── PiRuntimeSpec / CredentialLease / ACK 严格解析 ──
// 未知字段与未知 schemaVersion 一律拒绝：Client 不得接受自己无法施加的策略字段
// （ADR-0029 决策 10）。所有 PiRuntimeSpec 输入都必须经此解析，禁止宽松透传。

const SPEC_KEYS = new Set([
	"schemaVersion",
	"specId",
	"profileId",
	"profileRevision",
	"modelPolicy",
	"runtimeRevision",
]);
const MODEL_POLICY_KEYS = new Set([
	"defaultModel",
	"allowedModels",
	"defaultThinkingLevel",
]);
const MODEL_REF_KEYS = new Set(["provider", "modelId", "maxThinkingLevel"]);
const LEASE_KEYS = new Set(["issuedAt", "entries"]);
const LEASE_ENTRY_KEYS = new Set(["provider", "apiKey"]);
const ACK_KEYS = new Set([
	"clientId",
	"specId",
	"runtimeRevision",
	"configState",
	"reasonCode",
	"resolvedModels",
	"unavailableModels",
	"activeRuntimeRevision",
]);
const UNAVAILABLE_MODEL_KEYS = new Set(["provider", "modelId", "reason"]);
const CONFIG_STATES: ReadonlySet<string> = new Set([
	"pending",
	"ready",
	"incompatible",
	"stale",
]);

const MAX_ALLOWED_MODELS = 64;
const MAX_LEASE_ENTRIES = 16;
const MAX_PROVIDER_MODELS = 256;
const MAX_API_KEY_LENGTH = 4096;
const MAX_SPEC_STRING = 256;
const RUNTIME_REVISION_PATTERN = /^[0-9a-f]{16}$/;
const PROVIDER_PROTOCOLS: ReadonlySet<string> = new Set([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

function requireRuntimeRevision(v: unknown, what: string): string {
	assertString(v, what, MAX_SPEC_STRING);
	if (!RUNTIME_REVISION_PATTERN.test(v)) {
		throw new PiProtocolError(`${what} 必须为 16 位小写 hex`);
	}
	return v;
}

function requirePositiveInt(v: unknown, what: string): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
		throw new PiProtocolError(`${what} 必须为正整数`);
	}
	return v;
}

function parsePiModelRef(value: unknown, label: string): PiModelRef {
	assertRecord(value, label);
	assertKeys(value, MODEL_REF_KEYS, label);
	assertString(value.provider, `${label}.provider`, MAX_SPEC_STRING);
	assertString(value.modelId, `${label}.modelId`, MAX_SPEC_STRING);
	const ref: PiModelRef = {
		provider: value.provider,
		modelId: value.modelId,
	};
	if (value.maxThinkingLevel !== undefined) {
		assertString(
			value.maxThinkingLevel,
			`${label}.maxThinkingLevel`,
			MAX_SPEC_STRING,
		);
		if (!isPiThinkingLevel(value.maxThinkingLevel)) {
			throw new PiProtocolError(`${label}.maxThinkingLevel 非法`);
		}
		ref.maxThinkingLevel = value.maxThinkingLevel;
	}
	return ref;
}

/** 严格解析 PiRuntimeSpecV1；未知字段、未知 schemaVersion、非法 revision 均抛出。 */
export function parsePiRuntimeSpecV1(value: unknown): PiRuntimeSpecV1 {
	assertRecord(value, "PiRuntimeSpecV1");
	assertKeys(value, SPEC_KEYS, "PiRuntimeSpecV1");
	if (value.schemaVersion !== PI_RUNTIME_SPEC_V1_PROTOCOL_VERSION) {
		throw new PiProtocolError(
			`PiRuntimeSpecV1 schemaVersion 不支持: ${String(value.schemaVersion)}`,
		);
	}
	assertString(value.specId, "specId", MAX_SPEC_STRING);
	assertString(value.profileId, "profileId", MAX_SPEC_STRING);
	const runtimeRevision = requireRuntimeRevision(
		value.runtimeRevision,
		"runtimeRevision",
	);
	const profileRevision = requirePositiveInt(
		value.profileRevision,
		"profileRevision",
	);

	const policy = value.modelPolicy;
	assertRecord(policy, "modelPolicy");
	assertKeys(policy, MODEL_POLICY_KEYS, "modelPolicy");
	const defaultModelRaw = policy.defaultModel;
	assertRecord(defaultModelRaw, "modelPolicy.defaultModel");
	assertKeys(defaultModelRaw, MODEL_REF_KEYS, "modelPolicy.defaultModel");
	const defaultModelRef = parsePiModelRef(
		defaultModelRaw,
		"modelPolicy.defaultModel",
	);
	if (defaultModelRef.maxThinkingLevel !== undefined) {
		throw new PiProtocolError("modelPolicy.defaultModel 不接受 maxThinkingLevel");
	}
	if (
		!Array.isArray(policy.allowedModels) ||
		policy.allowedModels.length === 0 ||
		policy.allowedModels.length > MAX_ALLOWED_MODELS
	) {
		throw new PiProtocolError(
			`allowedModels 数量必须在 1-${MAX_ALLOWED_MODELS} 之间`,
		);
	}
	const allowedModels = policy.allowedModels.map((item, index) =>
		parsePiModelRef(item, `allowedModels[${index}]`),
	);
	if (
		new Set(allowedModels.map((m) => `${m.provider}/${m.modelId}`)).size !==
		allowedModels.length
	) {
		throw new PiProtocolError("allowedModels 存在重复项");
	}
	assertString(
		policy.defaultThinkingLevel,
		"modelPolicy.defaultThinkingLevel",
		MAX_SPEC_STRING,
	);
	if (!isPiThinkingLevel(policy.defaultThinkingLevel)) {
		throw new PiProtocolError("modelPolicy.defaultThinkingLevel 非法");
	}

	return {
		schemaVersion: PI_RUNTIME_SPEC_V1_PROTOCOL_VERSION,
		specId: value.specId,
		profileId: value.profileId,
		profileRevision,
		modelPolicy: {
			defaultModel: {
				provider: defaultModelRef.provider,
				modelId: defaultModelRef.modelId,
			},
			allowedModels,
			defaultThinkingLevel: policy.defaultThinkingLevel,
		},
		runtimeRevision,
	};
}

/** 严格解析 Server → Client 的 RuntimeSpec envelope；未知顶层字段一律拒绝。 */
export function parsePiRuntimeSpecMessage(value: unknown): PiRuntimeSpecMessage {
	assertRecord(value, "PiRuntimeSpecMessage");
	assertKeys(value, new Set(["spec", "credentials"]), "PiRuntimeSpecMessage");
	return {
		spec: parsePiRuntimeSpecV1(value.spec),
		credentials: parsePiCredentialLease(value.credentials),
	};
}

/** 严格解析显式模型元数据；Server 读取持久化配置时同样复用本解析器。 */
export function parsePiModelMetadata(value: unknown, label: string): PiProviderModelInfo {
	assertRecord(value, label);
	assertKeys(value, new Set(["id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat"]), label);
	assertString(value.id, `${label}.id`, MAX_SPEC_STRING);
	assertString(value.name, `${label}.name`, MAX_SPEC_STRING);
	if (value.api !== undefined && !PROVIDER_PROTOCOLS.has(value.api as PiProviderProtocol)) throw new PiProtocolError(`${label}.api 不受支持`);
	if (typeof value.reasoning !== "boolean") throw new PiProtocolError(`${label}.reasoning 必须是布尔`);
	if (!Array.isArray(value.input) || value.input.length === 0 || value.input.some((item) => item !== "text" && item !== "image")) throw new PiProtocolError(`${label}.input 非法`);
	if (typeof value.contextWindow !== "number" || !Number.isInteger(value.contextWindow) || value.contextWindow < 1) throw new PiProtocolError(`${label}.contextWindow 非法`);
	if (typeof value.maxTokens !== "number" || !Number.isInteger(value.maxTokens) || value.maxTokens < 1) throw new PiProtocolError(`${label}.maxTokens 非法`);
	assertRecord(value.cost, `${label}.cost`);
	assertKeys(value.cost, new Set(["input", "output", "cacheRead", "cacheWrite"]), `${label}.cost`);
	const cost = {} as PiProviderModelInfo["cost"];
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const raw = value.cost[key];
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) throw new PiProtocolError(`${label}.cost.${key} 非法`);
		cost[key] = raw;
	}
	if (value.compat !== undefined) assertRecord(value.compat, `${label}.compat`);
	return {
		id: value.id,
		name: value.name,
		...(value.api !== undefined ? { api: value.api as PiProviderProtocol } : {}),
		reasoning: value.reasoning,
		input: [...value.input] as Array<"text" | "image">,
		contextWindow: value.contextWindow,
		maxTokens: value.maxTokens,
		cost,
		...(value.compat !== undefined ? { compat: value.compat as PiProviderModelInfo["compat"] } : {}),
	};
}

/**
 * 严格解析 v2 Provider 模型条目。
 *
 * catalog 条目不得携带 metadata（多余键即拒绝），explicit 条目必须携带且 id 一致；
 * 未知 metadataSource 一律拒绝。
 */
function parsePiProviderModel(value: unknown, label: string): PiProviderModel {
	assertRecord(value, label);
	assertKeys(value, new Set(["id", "name", "metadataSource", "metadata"]), label);
	assertString(value.id, `${label}.id`, MAX_SPEC_STRING);
	assertString(value.name, `${label}.name`, MAX_SPEC_STRING);
	if (value.metadataSource === "catalog") {
		if (value.metadata !== undefined) throw new PiProtocolError(`${label} catalog 模型不得携带 metadata`);
		return { id: value.id, name: value.name, metadataSource: "catalog" };
	}
	if (value.metadataSource !== "explicit") throw new PiProtocolError(`${label}.metadataSource 不受支持`);
	const metadata = parsePiModelMetadata(value.metadata, `${label}.metadata`);
	if (metadata.id !== value.id) throw new PiProtocolError(`${label}.metadata.id 与 id 不一致`);
	return { id: value.id, name: value.name, metadataSource: "explicit", metadata };
}

/** requiredBundle.resourceIds 数量上限 */
const MAX_BUNDLE_RESOURCE_IDS = 64;

/** 严格解析 v3 的 `requiredBundle`。 */
function parsePiRequiredBundle(value: unknown): NonNullable<PiRuntimeSpecV3["requiredBundle"]> {
	assertRecord(value, "requiredBundle");
	assertKeys(
		value,
		new Set(["protocolVersion", "bundleVersion", "resourceIds"]),
		"requiredBundle",
	);
	if (value.protocolVersion !== PI_BUNDLE_PROTOCOL_VERSION) {
		throw new PiProtocolError(
			`requiredBundle.protocolVersion 不支持：${String(value.protocolVersion)}`,
		);
	}
	assertString(value.bundleVersion, "requiredBundle.bundleVersion", MAX_SPEC_STRING);
	if (
		!Array.isArray(value.resourceIds) ||
		value.resourceIds.length === 0 ||
		value.resourceIds.length > MAX_BUNDLE_RESOURCE_IDS
	) {
		throw new PiProtocolError("requiredBundle.resourceIds 数量非法");
	}
	const resourceIds: string[] = [];
	for (const [index, item] of value.resourceIds.entries()) {
		assertString(item, `requiredBundle.resourceIds[${index}]`, MAX_SPEC_STRING);
		resourceIds.push(item);
	}
	if (new Set(resourceIds).size !== resourceIds.length) {
		throw new PiProtocolError("requiredBundle.resourceIds 存在重复项");
	}
	return {
		protocolVersion: PI_BUNDLE_PROTOCOL_VERSION,
		bundleVersion: value.bundleVersion,
		resourceIds,
	};
}

/** 严格解析 RuntimeSpec v3。 */
export function parsePiRuntimeSpecV3(value: unknown): PiRuntimeSpecV3 {
	assertRecord(value, "PiRuntimeSpecV3");
	assertKeys(value, new Set(["schemaVersion", "specId", "profileId", "profileRevision", "providers", "modelPolicy", "toolPolicy", "requiredBundle", "runtimeRevision"]), "PiRuntimeSpecV3");
	if (value.schemaVersion !== 3) throw new PiProtocolError(`PiRuntimeSpecV3 schemaVersion 不支持: ${String(value.schemaVersion)}`);
	if (!("toolPolicy" in value)) throw new PiProtocolError("PiRuntimeSpecV3 缺少字段 toolPolicy");
	assertString(value.specId, "specId", MAX_SPEC_STRING);
	assertString(value.profileId, "profileId", MAX_SPEC_STRING);
	const profileRevision = requirePositiveInt(value.profileRevision, "profileRevision");
	const runtimeRevision = requireRuntimeRevision(value.runtimeRevision, "runtimeRevision");
	if (!Array.isArray(value.providers) || value.providers.length === 0 || value.providers.length > MAX_LEASE_ENTRIES) throw new PiProtocolError("providers 数量非法");
	const providerIds = new Set<string>();
	const providers: PiRuntimeProviderSpec[] = value.providers.map((raw, index) => {
		const label = `providers[${index}]`;
		assertRecord(raw, label);
		assertKeys(raw, new Set(["providerId", "name", "protocol", "baseUrl", "headers", "models"]), label);
		assertString(raw.providerId, `${label}.providerId`, MAX_SPEC_STRING);
		if (providerIds.has(raw.providerId)) throw new PiProtocolError("providers 存在重复 providerId");
		providerIds.add(raw.providerId);
		assertString(raw.name, `${label}.name`, MAX_SPEC_STRING);
		if (!PROVIDER_PROTOCOLS.has(raw.protocol as PiProviderProtocol)) throw new PiProtocolError(`${label}.protocol 不受支持`);
		if (raw.baseUrl !== undefined) {
			assertString(raw.baseUrl, `${label}.baseUrl`, MAX_SPEC_STRING * 8);
			try { const url = new URL(raw.baseUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); } catch { throw new PiProtocolError(`${label}.baseUrl 非法`); }
		}
		assertRecord(raw.headers, `${label}.headers`);
		for (const [header, headerValue] of Object.entries(raw.headers)) {
			if (/authorization|x-api-key|api-key|token|secret|password/i.test(header)) throw new PiProtocolError(`${label}.headers 含秘密字段`);
			assertString(headerValue, `${label}.headers.${header}`, MAX_API_KEY_LENGTH);
		}
		if (!Array.isArray(raw.models) || raw.models.length === 0 || raw.models.length > MAX_PROVIDER_MODELS) throw new PiProtocolError(`${label}.models 数量非法`);
		const modelIds = new Set<string>();
		const models = raw.models.map((model, modelIndex) => {
			const parsed = parsePiProviderModel(model, `${label}.models[${modelIndex}]`);
			if (modelIds.has(parsed.id)) throw new PiProtocolError(`${label}.models 存在重复项`);
			modelIds.add(parsed.id);
			return parsed;
		});
		return { providerId: raw.providerId, name: raw.name, protocol: raw.protocol as PiProviderProtocol, ...(raw.baseUrl !== undefined ? { baseUrl: raw.baseUrl } : {}), headers: { ...raw.headers } as Record<string, string>, models };
	});
	assertRecord(value.modelPolicy, "modelPolicy");
	assertKeys(value.modelPolicy, MODEL_POLICY_KEYS, "modelPolicy");
	const defaultModel = parsePiModelRef(value.modelPolicy.defaultModel, "modelPolicy.defaultModel");
	if (defaultModel.maxThinkingLevel !== undefined) throw new PiProtocolError("defaultModel 不接受 maxThinkingLevel");
	if (!Array.isArray(value.modelPolicy.allowedModels) || value.modelPolicy.allowedModels.length === 0 || value.modelPolicy.allowedModels.length > MAX_ALLOWED_MODELS) throw new PiProtocolError("allowedModels 数量非法");
	const allowedModels = value.modelPolicy.allowedModels.map((item, index) => parsePiModelRef(item, `allowedModels[${index}]`));
	if (new Set(allowedModels.map((model) => `${model.provider}/${model.modelId}`)).size !== allowedModels.length) throw new PiProtocolError("allowedModels 存在重复项");
	const catalog = new Set(providers.flatMap((provider) => provider.models.map((model) => `${provider.providerId}/${model.id}`)));
	for (const model of [defaultModel, ...allowedModels]) if (!catalog.has(`${model.provider}/${model.modelId}`)) throw new PiProtocolError(`模型 ${model.provider}/${model.modelId} 不在 Provider 目录`);
	assertString(value.modelPolicy.defaultThinkingLevel, "modelPolicy.defaultThinkingLevel", MAX_SPEC_STRING);
	if (!isPiThinkingLevel(value.modelPolicy.defaultThinkingLevel)) throw new PiProtocolError("modelPolicy.defaultThinkingLevel 非法");
	const toolPolicy = parsePiToolPolicy(value.toolPolicy);
	const requiredBundle =
		value.requiredBundle === undefined
			? undefined
			: parsePiRequiredBundle(value.requiredBundle);
	return { schemaVersion: 3, specId: value.specId, profileId: value.profileId, profileRevision, providers, modelPolicy: { defaultModel: { provider: defaultModel.provider, modelId: defaultModel.modelId }, allowedModels, defaultThinkingLevel: value.modelPolicy.defaultThinkingLevel }, toolPolicy, ...(requiredBundle ? { requiredBundle } : {}), runtimeRevision };
}

/** v4 顶层字段集合（v3 字段 + toolExecutionMode）。 */
const SPEC_V4_KEYS = new Set([
	"schemaVersion",
	"specId",
	"profileId",
	"profileRevision",
	"providers",
	"modelPolicy",
	"toolPolicy",
	"toolExecutionMode",
	"requiredBundle",
	"runtimeRevision",
]);

/**
 * 严格解析 RuntimeSpec v4。
 *
 * v4 = v3 的严格校验 + 必填且合法的 `toolExecutionMode`；因此这里先独立校验 v4 顶层键
 * 与模式，再复用 v3 的 Provider/模型/策略/Bundle 校验，避免两套规则分叉。
 * 缺失、非法模式或旧 schemaVersion 一律拒绝，不理会默认值。
 */
export function parsePiRuntimeSpecV4(value: unknown): PiRuntimeSpecV4 {
	assertRecord(value, "PiRuntimeSpecV4");
	assertKeys(value, SPEC_V4_KEYS, "PiRuntimeSpecV4");
	if (value.schemaVersion !== PI_RUNTIME_SPEC_PROTOCOL_VERSION) {
		throw new PiProtocolError(
			`PiRuntimeSpecV4 schemaVersion 不支持: ${String(value.schemaVersion)}`,
		);
	}
	if (!("toolExecutionMode" in value)) {
		throw new PiProtocolError("PiRuntimeSpecV4 缺少字段 toolExecutionMode");
	}
	if (!isPiToolExecutionMode(value.toolExecutionMode)) {
		throw new PiProtocolError(
			`PiRuntimeSpecV4 toolExecutionMode 不支持: ${String(value.toolExecutionMode)}`,
		);
	}
	const { toolExecutionMode, ...v3Shape } = value;
	const base = parsePiRuntimeSpecV3({ ...v3Shape, schemaVersion: 3 });
	return { ...base, schemaVersion: 4, toolExecutionMode };
}

/** 严格解析 v2 凭据 lease。 */
export function parsePiCredentialLeaseV2(value: unknown): PiCredentialLeaseV2 {
	assertRecord(value, "PiCredentialLeaseV2");
	assertKeys(value, LEASE_KEYS, "PiCredentialLeaseV2");
	assertString(value.issuedAt, "issuedAt", MAX_SPEC_STRING);
	if (Number.isNaN(Date.parse(value.issuedAt))) throw new PiProtocolError("issuedAt 必须是可解析的时间字符串");
	if (!Array.isArray(value.entries) || value.entries.length > MAX_LEASE_ENTRIES) throw new PiProtocolError("credentials.entries 数量非法");
	const ids = new Set<string>();
	const entries = value.entries.map((item, index) => {
		const label = `entries[${index}]`;
		assertRecord(item, label);
		assertKeys(item, new Set(["providerId", "apiKey"]), label);
		assertString(item.providerId, `${label}.providerId`, MAX_SPEC_STRING);
		if (ids.has(item.providerId)) throw new PiProtocolError("credentials.entries 存在重复 providerId");
		ids.add(item.providerId);
		assertString(item.apiKey, `${label}.apiKey`, MAX_API_KEY_LENGTH);
		return { providerId: item.providerId, apiKey: item.apiKey };
	});
	return { issuedAt: value.issuedAt, entries };
}

/** 严格解析 v3 RuntimeSpec envelope，并校验 lease/provider 完全匹配。 */
export function parsePiRuntimeSpecMessageV3(value: unknown): PiRuntimeSpecMessageV3 {
	assertRecord(value, "PiRuntimeSpecMessageV3");
	assertKeys(value, new Set(["spec", "credentials"]), "PiRuntimeSpecMessageV3");
	const spec = parsePiRuntimeSpecV3(value.spec);
	const credentials = parsePiCredentialLeaseV2(value.credentials);
	const providers = new Set(spec.providers.map((provider) => provider.providerId));
	if (providers.size !== credentials.entries.length || credentials.entries.some((entry) => !providers.has(entry.providerId))) throw new PiProtocolError("credentials 与 providers 不匹配");
	return { spec, credentials };
}

/** 严格解析 v4 RuntimeSpec envelope，并校验 lease/provider 完全匹配。 */
export function parsePiRuntimeSpecMessageV4(value: unknown): PiRuntimeSpecMessageV4 {
	assertRecord(value, "PiRuntimeSpecMessageV4");
	assertKeys(value, new Set(["spec", "credentials"]), "PiRuntimeSpecMessageV4");
	const spec = parsePiRuntimeSpecV4(value.spec);
	const credentials = parsePiCredentialLeaseV2(value.credentials);
	const providers = new Set(spec.providers.map((provider) => provider.providerId));
	if (providers.size !== credentials.entries.length || credentials.entries.some((entry) => !providers.has(entry.providerId))) throw new PiProtocolError("credentials 与 providers 不匹配");
	return { spec, credentials };
}

/** 严格解析 Client → Server 的 v1 凭据 lease。 */
export function parsePiCredentialLease(value: unknown): PiCredentialLease {
	assertRecord(value, "PiCredentialLease");
	assertKeys(value, LEASE_KEYS, "PiCredentialLease");
	assertString(value.issuedAt, "issuedAt", MAX_SPEC_STRING);
	if (Number.isNaN(Date.parse(value.issuedAt))) throw new PiProtocolError("issuedAt 必须是可解析的时间字符串");
	if (!Array.isArray(value.entries) || value.entries.length > MAX_LEASE_ENTRIES) throw new PiProtocolError(`credentials.entries 数量不得大于 ${MAX_LEASE_ENTRIES}`);
	const entries = value.entries.map((item, index) => {
		const label = `entries[${index}]`;
		assertRecord(item, label);
		assertKeys(item, LEASE_ENTRY_KEYS, label);
		assertString(item.provider, `${label}.provider`, MAX_SPEC_STRING);
		assertString(item.apiKey, `${label}.apiKey`, MAX_API_KEY_LENGTH);
		return { provider: item.provider, apiKey: item.apiKey };
	});
	return { issuedAt: value.issuedAt, entries };
}


/** 严格解析 Client 回执；不得携带任何 Secret。 */
export function parsePiRuntimeAck(value: unknown): PiRuntimeAck {
	assertRecord(value, "PiRuntimeAck");
	assertKeys(value, ACK_KEYS, "PiRuntimeAck");
	assertString(value.clientId, "clientId", MAX_SPEC_STRING);
	const specId =
		value.specId === null
			? null
			: (() => {
					assertString(value.specId, "specId", MAX_SPEC_STRING);
					return value.specId;
				})();
	const runtimeRevision =
		value.runtimeRevision === null
			? null
			: requireRuntimeRevision(value.runtimeRevision, "runtimeRevision");
	if (
		typeof value.configState !== "string" ||
		!CONFIG_STATES.has(value.configState)
	) {
		throw new PiProtocolError("configState 必须为 pending/ready/incompatible/stale");
	}
	const ack: PiRuntimeAck = {
		clientId: value.clientId,
		specId,
		runtimeRevision,
		configState: value.configState as PiConfigState,
	};
	if (value.reasonCode !== undefined) {
		if (
			typeof value.reasonCode !== "string" ||
			!ERROR_CODES.has(value.reasonCode)
		) {
			throw new PiProtocolError("reasonCode 必须为已知错误码");
		}
		ack.reasonCode = value.reasonCode as PiErrorCode;
	}
	if (value.resolvedModels !== undefined) {
		if (
			!Array.isArray(value.resolvedModels) ||
			value.resolvedModels.length > MAX_ALLOWED_MODELS
		) {
			throw new PiProtocolError("resolvedModels 必须为有界数组");
		}
		ack.resolvedModels = value.resolvedModels.map((item, index) =>
			parsePiModelRef(item, `resolvedModels[${index}]`),
		);
	}
	if (value.unavailableModels !== undefined) {
		if (
			!Array.isArray(value.unavailableModels) ||
			value.unavailableModels.length > MAX_ALLOWED_MODELS
		) {
			throw new PiProtocolError("unavailableModels 必须为有界数组");
		}
		ack.unavailableModels = value.unavailableModels.map((item, index) => {
			const label = `unavailableModels[${index}]`;
			assertRecord(item, label);
			assertKeys(item, UNAVAILABLE_MODEL_KEYS, label);
			assertString(item.provider, `${label}.provider`, MAX_SPEC_STRING);
			assertString(item.modelId, `${label}.modelId`, MAX_SPEC_STRING);
			assertString(item.reason, `${label}.reason`, MAX_SPEC_STRING);
			return {
				provider: item.provider,
				modelId: item.modelId,
				reason: item.reason,
			};
		});
	}
	if (value.activeRuntimeRevision !== undefined) {
		ack.activeRuntimeRevision =
			value.activeRuntimeRevision === null
				? null
				: requireRuntimeRevision(
						value.activeRuntimeRevision,
						"activeRuntimeRevision",
					);
	}
	return ack;
}

// ── Pi 动作门控分类（Server 与 Client 共用，设计 §7.5） ──
// RuntimeSpec 未 ready 时：READ_ACTIONS 仍可用，WORKER_ACTIONS 必须拒绝
// （PI_CONFIG_UNAVAILABLE），且不得 fork Worker。

/** 不依赖 AgentSession 即可完成的动作。 */
export const PI_READ_ACTIONS = [
	"capability.get",
	"project.resolve",
	"sessions.list",
	"session.get",
	"session.context",
	"session.entryContent",
	"agent.state",
	"agent.stats",
	"agent.commands",
	"models.list",
] as const;

/** 需要活跃 Pi Worker 的动作。 */
export const PI_WORKER_ACTIONS = [
	"session.new",
	"session.rename",
	"session.delete",
	"session.fork",
	"session.clone",
	"session.navigate",
	"agent.prompt",
	"agent.steer",
	"agent.followUp",
	"agent.abort",
	"agent.compact",
	"agent.abortCompact",
	"model.set",
	"thinking.set",
	"extension.respond",
	"session.import.list",
	"session.import.preview",
	"session.import.run",
] as const;

const PI_READ_ACTION_SET: ReadonlySet<string> = new Set(PI_READ_ACTIONS);
const PI_WORKER_ACTION_SET: ReadonlySet<string> = new Set(PI_WORKER_ACTIONS);

/** 是否需要 RuntimeSpec ready 才能执行。 */
export function isPiWorkerAction(action: string): boolean {
	return PI_WORKER_ACTION_SET.has(action);
}

/** 是否属于未就绪时也允许的只读动作。 */
export function isPiReadAction(action: string): boolean {
	return PI_READ_ACTION_SET.has(action);
}
