export const VERSION = "0.0.0";

// ── 远程 Pi 协议 ──
export * from "./pi.js";

// ── 交互式终端协议 ──
export * from "./terminal.js";
import type { TerminalCapabilityStatus } from "./terminal.js";
import type { PiCapabilityStatus } from "./pi.js";
// 显式 re-export 常用类型（部分工具链不解析 export * 通配转发）
export type {
	PiAgentState,
	PiAttachmentDescriptor,
	PiCapabilityStatus,
	PiClientEvent,
	PiCwdRef,
	PiErrorCode,
	PiEvent,
	PiExtensionUiRequest,
	PiImagePlaceholder,
	PiMessage,
	PiMessageContent,
	PiPromptAccepted,
	PiProjectKey,
	PiRequest,
	PiResponse,
	PiRunSummary,
	PiSessionCreated,
	PiSessionJobSnapshot,
	PiSessionJobStatus,
	PiSessionOpenResult,
	PiStateAck,
	PiSessionContextPage,
	PiSessionDetail,
	PiSessionInfo,
	PiSessionTreeNode,
	PiStateReport,
	PiTextContent,
	PiThinkingLevel,
	PiThinkingPlaceholder,
	PiToolCallContent,
	PiModelInfo,
} from "./pi.js";
export {
	PI_ERROR_CODES,
	PI_SESSION_JOB_PROTOCOL_VERSION,
	PI_THINKING_LEVELS,
	isPiAgentIdle,
	isPiThinkingLevel,
	parsePiAgentState,
	safePiErrorMessage,
} from "./pi.js";

// ── Event names ──
export const Events = {
	REGISTER: "register",
	HEARTBEAT: "heartbeat",
	JOB_DISPATCH: "job:dispatch",
	JOB_STDOUT: "job:stdout",
	JOB_STDERR: "job:stderr",
	JOB_DONE: "job:done",
	JOB_PROGRESS: "job:progress",
	JOB_CANCEL: "job:cancel",
	JOB_CANCELLED: "job:cancelled",
	JOB_CANCEL_FAILED: "job:cancel-failed",
	JOB_UPDATE: "job:update",
	STATUS_REPORT: "status:report",
	PI_REQUEST: "pi:request",
	PI_RESPONSE: "pi:response",
	PI_EVENT: "pi:event",
	PI_STATE: "pi:state",
	TERMINAL_REQUEST: "terminal:request",
	TERMINAL_RESPONSE: "terminal:response",
	TERMINAL_OUTPUT: "terminal:output",
	TERMINAL_EXIT: "terminal:exit",
	TERMINAL_STATE: "terminal:state",
	TERMINAL_ATTACH: "terminal:attach",
	TERMINAL_DETACH: "terminal:detach",
	TERMINAL_INPUT: "terminal:input",
	TERMINAL_RESIZE: "terminal:resize",
	TERMINAL_TAKEOVER: "terminal:takeover",
	TERMINAL_ACK_OUTPUT: "terminal:ack-output",
	TERMINAL_RESYNC: "terminal:resync",
	TERMINAL_ATTACHED: "terminal:attached",
	TERMINAL_SNAPSHOT: "terminal:snapshot",
	TERMINAL_CONTROL: "terminal:control",
	TERMINAL_SESSION_STATE: "terminal:session-state",
	TERMINAL_RESYNC_REQUIRED: "terminal:resync-required",
	TERMINAL_ERROR: "terminal:error",
} as const;

// ── Job type ──
export enum JobType {
	EXEC = "exec",
	FILE_LIST = "file.list",
	FILE_STAT = "file.stat",
	FILE_READ_TEXT = "file.readText",
	FILE_WRITE_TEXT = "file.writeText",
	FILE_MKDIR = "file.mkdir",
	FILE_DELETE = "file.delete",
	FILE_MOVE = "file.move",
	FILE_EXPORT = "file.export",
	FILE_IMPORT = "file.import",
	AGENT_RUN = "agent.run",
	AGENT_SESSION = "agent.session",
	FRP_CREATE = "frp.create",
	FRP_DELETE = "frp.delete",
	FRP_LIST = "frp.list",
	FILE_ROOTS = "file.roots",
}

// ── Job status ──
export enum JobStatus {
	IDLE = "idle",
	PENDING = "pending",
	RUNNING = "running",
	WAITING_INPUT = "waiting_input",
	DONE = "done",
	ERROR = "error",
	DISCONNECTED = "disconnected",
	CANCELLED = "cancelled",
}

// ── Register / Heartbeat ──
export interface MachineRegister {
	clientId: string;
	hostname: string;
	os: string;
	cpuModel: string;
	totalMemMB: number;
	clientVersion: string;
	capabilities: string[];
	/** 可选：Client Pi 能力探测结果摘要（旧 Client 缺省） */
	capabilityDetails?: { pi?: PiCapabilityStatus; terminal?: TerminalCapabilityStatus };
}

/** 单盘容量与占用率（容量与使用率来自同一次 statfs） */
export interface DiskInfo {
	name: string; // Windows: "C:" / "D:"；Linux: 挂载点 "/"、"/home"
	totalMB: number; // MiB（bytes ÷ 1024²，与 totalMemMB 同口径）
	usedPercent: number; // 0-100
}

export interface Heartbeat {
	clientId: string;
	cpuPercent: number;
	memPercent: number;
	disks: DiskInfo[];
	runningJobs: string[];
	uptime: number;
}

// ── Job payloads ──
// ── Exec job dispatch（Server → Client） ──
export type ExecJobDispatch =
	| {
			jobId: string;
			type: "exec";
			mode: "command";
			command: string;
			cwd?: string;
			timeout?: number;
	  }
	| {
			jobId: string;
			type: "exec";
			mode: "script";
			executable: string;
			args: string[];
			script: string;
			cwd?: string;
			timeout?: number;
	  };

// ── Job dispatch（Server → Client，判别联合） ──
export type JobDispatch =
	| ExecJobDispatch
	| {
			jobId: string;
			type: string;
			payload: Record<string, unknown>;
			timeout?: number;
	  };

export interface JobOutput {
	jobId: string;
	text: string;
}

// ── Exec job done（Client → Server） ──
export type ExecJobDone =
	| {
			jobId: string;
			type: "exec";
			exitCode: number;
			stdout?: string;
			stderr?: string;
	  }
	| {
			jobId: string;
			type: "exec";
			error: JobError;
	  };

// ── Job done（Client → Server，判别联合） ──
export type JobDone =
	| ExecJobDone
	| { jobId: string; type: string; result: Record<string, unknown> }
	| { jobId: string; type: string; error: JobError };

export interface JobUpdate {
	jobId: string;
	type: string;
	status: JobStatus;
	result?: Record<string, unknown>;
	errorCode?: string;
	errorMessage?: string;
}

export interface JobCancel {
	jobId: string;
}

export interface JobCancelled {
	jobId: string;
}

export interface JobCancelFailed {
	jobId: string;
	reason: string;
}

export interface JobCreate {
	clientId: string;
	type: string;
	payload: Record<string, unknown>;
	timeout?: number;
}

export interface JobCreateResult {
	jobId: string;
	status: JobStatus;
	type: string;
}

// ── Dispatch result (internal, returned by scheduler) ──
export interface DispatchPayload {
	jobId: string;
	clientId: string;
	type: string;
	payload: Record<string, unknown>;
	timeout?: number;
}

// ── Status report (reconnect) ──
export interface JobStatusReport {
	jobId: string;
	status: "running" | "waiting_input" | "done" | "error";
	exitCode: number | null;
}

export interface StatusReport {
	clientId: string;
	jobs: JobStatusReport[];
}

// ── Client info (REST response) ──
export interface ClientInfo {
	clientId: string;
	hostname: string;
	os: string;
	cpuModel: string;
	totalMemMB: number;
	clientVersion: string;
	capabilities: string[];
	/** 解析后的能力摘要（pi/terminal；无探测/损坏时为 {}） */
	capabilityDetails: { pi?: PiCapabilityStatus; terminal?: TerminalCapabilityStatus };
	online: boolean;
	cpuPercent: number | null;
	memPercent: number | null;
	disks: DiskInfo[];
	lastHeartbeatAt: string | null;
}

// ── Job info (REST response) ──
/** Job 传输段进度：浏览器上传或 Client 导入阶段已传输字节 / 总字节 */
export interface JobProgress {
	loaded: number;
	total: number;
}

export interface JobInfo {
	jobId: string;
	clientId: string;
	clientName: string | null;
	type: string;
	status: JobStatus;
	payload: Record<string, unknown>;
	result: Record<string, unknown> | null;
	/** 传输段进度（Storage 上传或 Client 导入时上报，无则 null） */
	progress: JobProgress | null;
	errorCode: string | null;
	errorMessage: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	createdByIdentityId: string | null;
	createdByName: string | null;
	createdVia: string | null;
}

// ── Job error ──
export interface JobError {
	code: string;
	message: string;
}

// ── FileRef ──
export interface FileRef {
	id: string; // DB File 表主键
	key: string; // Storage 对象路径
	url: string; // 预签名 URL（local）；外部直连 URL（alibaba，direct=true）
	method: "GET" | "PUT";
	expiresAt: number;
	headers?: Record<string, string>;
	direct?: boolean; // true = 外部直连 URL（阿里云），Client 不做同源限制
}

// ── UploadTarget ──
// local：Server 签名 URL 中转；alibaba：OSS 分片直传（预签名 URL 列表）
export type UploadTarget =
	| { kind: "proxy"; url: string; expiresAt: number }
	| {
			kind: "direct";
			fileId: string;
			uploadId: string;
			partSize: number;
			parts: Array<{ partNumber: number; url: string }>;
	  };

export interface FileUploadSessionCreate {
	clientId: string;
	rootDir: string;
	targetPath: string;
	filename: string;
	size: number;
	mimeType?: string;
	overwrite?: boolean;
}

export interface FileUploadSession {
	jobId: string;
	fileId: string;
	status: JobStatus;
	upload: UploadTarget;
}

// ── 导出直传会话（client 协商） ──
export interface FileExportSessionCreate {
	jobId: string;
	size: number;
}

export interface FileExportSession {
	fileId: string;
	uploadId: string;
	partSize: number;
	parts: Array<{ partNumber: number; url: string }>;
}

// ── File job payload ──
export interface FileListPayload {
	path: string;
	rootDir: string;
}
export interface FileStatPayload {
	path: string;
	rootDir: string;
}
export interface FileReadTextPayload {
	path: string;
	rootDir: string;
	maxBytes?: number;
}
export interface FileWriteTextPayload {
	path: string;
	rootDir: string;
	content: string;
}
export interface FileMkdirPayload {
	path: string;
	rootDir: string;
}
export interface FileDeletePayload {
	path: string;
	rootDir: string;
	recursive?: boolean;
}
export interface FileMovePayload {
	source: string;
	destination: string;
	rootDir: string;
	overwrite?: boolean;
}
export interface FileExportPayload {
	path: string;
	rootDir: string;
	uploadRef: FileRef;
}
export interface FileImportPayload {
	targetPath: string;
	rootDir: string;
	downloadRef: FileRef;
	size: number;
	overwrite?: boolean;
}

// ── File roots result ──
export interface FileRootsResult {
	roots: string[];
}

// ── File job result ──
export interface FileListResult {
	entries: {
		name: string;
		kind: "file" | "dir";
		size: number;
		mtime: string;
	}[];
}
export interface FileStatResult {
	name: string;
	kind: "file" | "dir";
	size: number;
	mtime: string;
}
export interface FileReadTextResult {
	content: string;
	size: number;
}
export interface FileChangeResult {
	path: string;
}
export interface FileTransferResult {
	fileId: string;
	key: string;
	size: number;
	sha256: string;
}

// ── File 稳定错误码 ──
export const FileErrorCode = {
	PATH_NOT_FOUND: "PATH_NOT_FOUND",
	PATH_NOT_ALLOWED: "PATH_NOT_ALLOWED",
	PATH_CONFLICT: "PATH_CONFLICT",
	IO_ERROR: "IO_ERROR",
	SIZE_EXCEEDED: "SIZE_EXCEEDED",
	SHA256_MISMATCH: "SHA256_MISMATCH",
} as const;
export type FileErrorCode = (typeof FileErrorCode)[keyof typeof FileErrorCode];

// ── 认证 ──

export interface ActorContext {
	identityId: string;
	displayName: string;
	isAdmin: boolean;
	credentialId: string | null;
	sessionId: string | null;
	source: "web" | "cli";
	requestId: string;
}

export const AuthErrorCode = {
	AUTH_REQUIRED: "AUTH_REQUIRED",
	AUTH_INVALID: "AUTH_INVALID",
	AUTH_EXPIRED: "AUTH_EXPIRED",
	AUTH_REVOKED: "AUTH_REVOKED",
	IDENTITY_DISABLED: "IDENTITY_DISABLED",
	FORBIDDEN: "FORBIDDEN",
} as const;

export interface LoginRequest {
	username: string;
	password: string;
}

export interface LoginResponse {
	identity: {
		id: string;
		username: string;
		displayName: string;
		isAdmin: boolean;
	};
}

export interface IdentityInfo {
	id: string;
	username: string;
	displayName: string;
	isAdmin: boolean;
	disabledAt: string | null;
	createdAt: string;
}

export interface CreateIdentityRequest {
	username: string;
	password: string;
	displayName: string;
}

export interface UpdateMeRequest {
	username?: string;
	password?: string;
	currentPassword: string;
}

export interface CreateTokenRequest {
	label: string;
}

export interface TokenInfo {
	id: string;
	label: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
	createdAt: string;
}

export interface CreateTokenResponse {
	id: string;
	token: string;
	label: string;
}

// ── 存储后端类型 ──
export const StorageProviderKind = {
	LOCAL: "local",
} as const;
export type StorageProviderKind =
	(typeof StorageProviderKind)[keyof typeof StorageProviderKind];

// ── FRP 端口映射 ──

export const FrpJobType = {
	FRP_CREATE: "frp.create",
	FRP_DELETE: "frp.delete",
	FRP_LIST: "frp.list",
} as const;
export type FrpJobType = (typeof FrpJobType)[keyof typeof FrpJobType];

/** frp.create payload（Server → Client） */
export interface FrpCreatePayload {
	mappingId: string;
	name: string;
	proxyType: "tcp" | "http" | "https";
	localIp: string;
	localPort: number;
	remotePort: number;
	customDomain?: string;
	frpsInfo: {
		serverAddr: string;
		serverPort: number;
		authToken: string;
	};
}

/** frp.delete payload（Server → Client） */
export interface FrpDeletePayload {
	mappingId: string;
	name: string;
}

/** frp.create / frp.delete 的 JOB_DONE 结果 */
export interface FrpCreateResult {
	mappingId: string;
	status: "active" | "error";
}

export interface FrpDeleteResult {
	mappingId: string;
	deleted: boolean;
}

/** frp.list 的 JOB_DONE 结果 */
export interface FrpListResult {
	mappings: {
		id: string;
		name: string;
		proxyType: string;
		localPort: number;
		remotePort: number | null;
		status: string;
	}[];
}

/** REST API 返回的映射信息 */
export interface FrpMappingInfo {
	id: string;
	clientId: string;
	name: string;
	proxyType: string;
	localIp: string;
	localPort: number;
	remotePort: number | null;
	customDomain: string | null;
	status: string;
	publicUrl: string | null;
	createdAt: string;
	updatedAt: string;
}

/** 通用分页包装 */
export interface PaginatedResult<T> {
	data: T[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

/** 创建映射 REST 请求体 */
export interface FrpMappingCreateRequest {
	clientId: string;
	name: string;
	proxyType: "tcp" | "http" | "https";
	localIp?: string;
	localPort: number;
	remotePort?: number;
	customDomain?: string;
	frpsInstanceId?: string;
}

// ── FRP 实例配置 ──

/** DB 中存储的 frps 实例信息（REST 返回） */
export interface FrpsInstanceInfo {
	id: string;
	name: string;
	serverAddr: string;
	serverPort: number;
	authToken: string;
	dashboardScheme: string;
	dashboardHost: string | null;
	dashboardPort: number;
	dashboardUser: string;
	dashboardPassword: string;
	portRangeStart: number;
	portRangeEnd: number;
	isDefault: boolean;
	createdAt: string;
	updatedAt: string;
}

/** 创建 frps 实例请求体 */
export interface FrpsInstanceCreateRequest {
	name: string;
	serverAddr: string;
	serverPort?: number;
	authToken?: string;
	dashboardScheme?: "http" | "https";
	dashboardHost?: string;
	dashboardPort?: number;
	dashboardUser?: string;
	dashboardPassword?: string;
	portRangeStart?: number;
	portRangeEnd?: number;
	isDefault?: boolean;
}

/** 更新 frps 实例请求体（所有字段可选） */
export interface FrpsInstanceUpdateRequest {
	name?: string;
	serverAddr?: string;
	serverPort?: number;
	authToken?: string;
	dashboardScheme?: "http" | "https";
	dashboardHost?: string | null;
	dashboardPort?: number;
	dashboardUser?: string;
	dashboardPassword?: string;
	portRangeStart?: number;
	portRangeEnd?: number;
	isDefault?: boolean;
}

/** 健康检查返回体 */
export interface ProbeResult {
	ok: boolean;
	tcpReachable: boolean;
	tcpLatencyMs: number;
	dashboardReachable: boolean;
	authValid: boolean;
	serverInfo?: { version: string };
	error?: string;
	proxies: {
		total: number;
		byType: { tcp: number; http: number; https: number };
		list: { name: string; proxyType: string; remotePort: number | null }[];
		usedPorts: number[];
	} | null;
}
