export { VERSION } from "./version.js";
export { ClientInstallerErrorCode, parseClientInstallerConfigUpdate, parseClientInstallerNameUpdate, parseClientInstallerPlatform, } from "./client-installer.js";
export type { ClientInstallerBootstrap, ClientInstallerClientStatus, ClientInstallerConfigInfo, ClientInstallerErrorCode as ClientInstallerErrorCodeType, ClientInstallerPlatform, ClientInstallerPlatformStatus, ClientInstallerPreflight, } from "./client-installer.js";
export * from "./update.js";
export * from "./pi.js";
export * from "./terminal.js";
import type { TerminalCapabilityStatus } from "./terminal.js";
import type { PiCapabilityStatus } from "./pi.js";
import type { FrpCapabilityStatus } from "./frp-runtime.js";
export type { PiAgentState, PiAttachmentDescriptor, PiCapabilityStatus, PiClientEvent, PiCwdRef, PiErrorCode, PiEvent, PiExtensionUiRequest, PiImagePlaceholder, PiMessage, PiMessageContent, PiPromptAccepted, PiProjectKey, PiRequest, PiResponse, PiRunSummary, PiSessionCreated, PiSessionJobSnapshot, PiSessionJobStatus, PiSessionOpenResult, PiStateAck, PiSessionContextPage, PiSessionDetail, PiSessionInfo, PiSessionTreeNode, PiStateReport, PiTextContent, PiThinkingLevel, PiThinkingPlaceholder, PiToolCallContent, PiModelInfo, } from "./pi.js";
export type { ReleaseArchiveAvailableInfo, ReleaseArchiveDeletingInfo, ReleaseArchiveInfo, ReleaseArchiveStorage, ReleaseArchiveStorageSummary, ReleaseArchiveAvailability, ReleaseCleanupArchiveCandidate, ReleaseCleanupIssue, ReleaseCleanupPolicy, ReleaseCleanupPreview, ReleaseCleanupReason, ReleaseCleanupRunResult, ReleaseClientEntry, ReleaseInfo, ReleasePlatform, ReleaseUploadCreateInput, ReleaseUploadPart, ReleaseUploadSession, ServerShutdownNotice, UpdateFailed, UpdateManifest, UpdateReady, UpdateRequest, } from "./update.js";
export { ReleaseClientState, ReleaseStatus, ReleaseUploadErrorCode, parseReleaseUploadComplete, parseReleaseUploadCreateInput, parseReleaseUploadPartRefresh, platformFromOs, isReleaseArchiveAvailable, } from "./update.js";
export { PI_ERROR_CODES, PI_SESSION_JOB_PROTOCOL_VERSION, PI_THINKING_LEVELS, isPiAgentIdle, isPiThinkingLevel, parsePiAgentState, safePiErrorMessage, } from "./pi.js";
export declare const Events: {
    readonly REGISTER: "register";
    readonly HEARTBEAT: "heartbeat";
    readonly JOB_DISPATCH: "job:dispatch";
    readonly JOB_STDOUT: "job:stdout";
    readonly JOB_STDERR: "job:stderr";
    readonly JOB_DONE: "job:done";
    readonly JOB_PROGRESS: "job:progress";
    readonly JOB_CANCEL: "job:cancel";
    readonly JOB_CANCELLED: "job:cancelled";
    readonly JOB_CANCEL_FAILED: "job:cancel-failed";
    readonly JOB_UPDATE: "job:update";
    readonly STATUS_REPORT: "status:report";
    readonly PI_REQUEST: "pi:request";
    readonly PI_RESPONSE: "pi:response";
    readonly PI_EVENT: "pi:event";
    readonly PI_STATE: "pi:state";
    readonly TERMINAL_REQUEST: "terminal:request";
    readonly TERMINAL_RESPONSE: "terminal:response";
    readonly TERMINAL_OUTPUT: "terminal:output";
    readonly TERMINAL_EXIT: "terminal:exit";
    readonly TERMINAL_STATE: "terminal:state";
    readonly TERMINAL_ATTACH: "terminal:attach";
    readonly TERMINAL_DETACH: "terminal:detach";
    readonly TERMINAL_INPUT: "terminal:input";
    readonly TERMINAL_RESIZE: "terminal:resize";
    readonly TERMINAL_TAKEOVER: "terminal:takeover";
    readonly TERMINAL_ACK_OUTPUT: "terminal:ack-output";
    readonly TERMINAL_RESYNC: "terminal:resync";
    readonly TERMINAL_ATTACHED: "terminal:attached";
    readonly TERMINAL_SNAPSHOT: "terminal:snapshot";
    readonly TERMINAL_CONTROL: "terminal:control";
    readonly TERMINAL_SESSION_STATE: "terminal:session-state";
    readonly TERMINAL_RESYNC_REQUIRED: "terminal:resync-required";
    readonly TERMINAL_ERROR: "terminal:error";
    readonly UPDATE_REQUEST: "update:request";
    readonly UPDATE_READY: "update:ready";
    readonly UPDATE_FAILED: "update:failed";
    readonly SERVER_SHUTDOWN: "server:shutdown";
    readonly FRP_STATE: "frp:state";
    readonly FRP_STATE_ACK: "frp:state-ack";
};
export declare enum JobType {
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
    FRP_RECONCILE = "frp.reconcile",
    FILE_ROOTS = "file.roots"
}
export declare enum JobStatus {
    IDLE = "idle",
    PENDING = "pending",
    RUNNING = "running",
    WAITING_INPUT = "waiting_input",
    DONE = "done",
    ERROR = "error",
    DISCONNECTED = "disconnected",
    CANCELLED = "cancelled"
}
import { MachineInstallationMode, PrivilegedCapabilityMode, parseMachineInstallation, parseMachineRegister, parsePrivilegedCapabilityStatus } from "./machine-register.js";
import type { MachineInstallationStatus, MachineRegister, PrivilegedCapabilityStatus } from "./machine-register.js";
export { MachineInstallationMode, PrivilegedCapabilityMode, parseMachineInstallation, parseMachineRegister, parsePrivilegedCapabilityStatus, type MachineInstallationStatus, type MachineRegister, type PrivilegedCapabilityStatus, };
/** 单盘容量与占用率（容量与使用率来自同一次 statfs） */
export interface DiskInfo {
    name: string;
    totalMB: number;
    usedPercent: number;
}
export interface Heartbeat {
    clientId: string;
    cpuPercent: number;
    memPercent: number;
    disks: DiskInfo[];
    runningJobs: string[];
    uptime: number;
}
export type ExecJobDispatch = {
    jobId: string;
    type: "exec";
    mode: "command";
    command: string;
    cwd?: string;
    timeout?: number;
} | {
    jobId: string;
    type: "exec";
    mode: "script";
    executable: string;
    args: string[];
    script: string;
    cwd?: string;
    timeout?: number;
};
export type JobDispatch = ExecJobDispatch | {
    jobId: string;
    type: string;
    payload: Record<string, unknown>;
    timeout?: number;
};
export interface JobOutput {
    jobId: string;
    text: string;
}
export type ExecJobDone = {
    jobId: string;
    type: "exec";
    exitCode: number;
    stdout?: string;
    stderr?: string;
} | {
    jobId: string;
    type: "exec";
    error: JobError;
    stdout?: string;
    stderr?: string;
};
export type JobDone = ExecJobDone | {
    jobId: string;
    type: string;
    result: Record<string, unknown>;
} | {
    jobId: string;
    type: string;
    error: JobError;
};
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
export interface DispatchPayload {
    jobId: string;
    clientId: string;
    type: string;
    payload: Record<string, unknown>;
    timeout?: number;
}
export interface JobStatusReport {
    jobId: string;
    status: "running" | "waiting_input" | "done" | "error";
    exitCode: number | null;
}
export interface StatusReport {
    clientId: string;
    jobs: JobStatusReport[];
}
export interface ClientInfo {
    clientId: string;
    /** 别名：默认取 hostname（重名自动加后缀），可由服务端修改；后续 CLI 寻址依据 */
    name: string;
    hostname: string;
    os: string;
    cpuModel: string;
    totalMemMB: number;
    clientVersion: string;
    capabilities: string[];
    /** 解析后的能力摘要（pi/terminal/frp/privileged；无探测/损坏时为 {}） */
    capabilityDetails: {
        pi?: PiCapabilityStatus;
        terminal?: TerminalCapabilityStatus;
        frp?: FrpCapabilityStatus;
        /** 可选：非交互特权能力摘要（旧 Client 缺省） */
        privileged?: PrivilegedCapabilityStatus;
    };
    /** 可选：安装模式摘要（旧 Client 缺省表示未报告，不推断为任何模式） */
    installation?: MachineInstallationStatus;
    online: boolean;
    cpuPercent: number | null;
    memPercent: number | null;
    disks: DiskInfo[];
    lastHeartbeatAt: string | null;
}
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
    /** 远端进程超时（毫秒）；旧 Server 可能省略。 */
    timeout?: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    createdByIdentityId: string | null;
    createdByName: string | null;
    createdVia: string | null;
}
export interface JobError {
    code: string;
    message: string;
}
export interface FileRef {
    id: string;
    key: string;
    url: string;
    method: "GET" | "PUT";
    expiresAt: number;
    headers?: Record<string, string>;
    direct?: boolean;
}
export type UploadTarget = {
    kind: "proxy";
    url: string;
    expiresAt: number;
} | {
    kind: "direct";
    fileId: string;
    uploadId: string;
    partSize: number;
    parts: Array<{
        partNumber: number;
        url: string;
    }>;
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
export interface FileExportSessionCreate {
    jobId: string;
    size: number;
}
export interface FileExportSession {
    fileId: string;
    uploadId: string;
    partSize: number;
    parts: Array<{
        partNumber: number;
        url: string;
    }>;
}
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
export interface FileRootsResult {
    roots: string[];
}
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
export declare const FileErrorCode: {
    readonly PATH_NOT_FOUND: "PATH_NOT_FOUND";
    readonly PATH_NOT_ALLOWED: "PATH_NOT_ALLOWED";
    readonly PATH_CONFLICT: "PATH_CONFLICT";
    readonly IO_ERROR: "IO_ERROR";
    readonly SIZE_EXCEEDED: "SIZE_EXCEEDED";
    readonly SHA256_MISMATCH: "SHA256_MISMATCH";
};
export type FileErrorCode = (typeof FileErrorCode)[keyof typeof FileErrorCode];
export interface ActorContext {
    identityId: string;
    displayName: string;
    isAdmin: boolean;
    credentialId: string | null;
    sessionId: string | null;
    source: "web" | "cli";
    requestId: string;
}
export declare const AuthErrorCode: {
    readonly AUTH_REQUIRED: "AUTH_REQUIRED";
    readonly AUTH_INVALID: "AUTH_INVALID";
    readonly AUTH_EXPIRED: "AUTH_EXPIRED";
    readonly AUTH_REVOKED: "AUTH_REVOKED";
    readonly IDENTITY_DISABLED: "IDENTITY_DISABLED";
    readonly FORBIDDEN: "FORBIDDEN";
};
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
export declare const StorageProviderKind: {
    readonly LOCAL: "local";
};
export type StorageProviderKind = (typeof StorageProviderKind)[keyof typeof StorageProviderKind];
/** FRP 映射控制面状态。 */
export declare const FRP_MAPPING_STATUSES: readonly ["provisioning", "active", "inactive", "deleting", "error", "reconciling"];
export type FrpMappingStatus = (typeof FRP_MAPPING_STATUSES)[number];
/** FRP 写操作稳定错误码。 */
export declare const FRP_ERROR_CODES: readonly ["FRPS_DASHBOARD_REQUIRED", "FRPS_DASHBOARD_UNREACHABLE", "FRPS_DASHBOARD_AUTH_FAILED", "FRP_PROXY_NAME_CONFLICT", "FRP_PROXY_CONFIRM_TIMEOUT", "FRP_PROXY_REMOVE_TIMEOUT", "FRP_ROLLBACK_FAILED", "FRPC_NOT_FOUND", "FRPC_START_FAILED", "FRPC_STOP_FAILED", "FRP_RECONCILE_BUSY", "FRP_RECONCILE_FAILED", "FRP_RUNTIME_GENERATION_STALE", "FRP_RUNTIME_STATE_INVALID", "FRP_RECONCILE_TIMEOUT", "FRP_CLIENT_NOT_FOUND", "FRP_CLIENT_OFFLINE", "FRP_CLIENT_NO_FRP_CAPABILITY"];
export type FrpErrorCode = (typeof FRP_ERROR_CODES)[number];
/** FRP 信任边界输入错误。 */
export declare class FrpProtocolError extends Error {
    constructor(message: string);
}
export declare const FrpJobType: {
    readonly FRP_CREATE: "frp.create";
    readonly FRP_DELETE: "frp.delete";
    readonly FRP_LIST: "frp.list";
    readonly FRP_RECONCILE: "frp.reconcile";
};
export type FrpJobType = (typeof FrpJobType)[keyof typeof FrpJobType];
/** frp.create payload（Server → Client） */
export interface FrpCreatePayload {
    mappingId: string;
    name: string;
    proxyType: "tcp" | "http" | "https";
    localIp: string;
    localPort: number;
    remotePort?: number;
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
    /** 创建确认失败时，关联等待回滚结果的原始 create Job。 */
    rollbackOfJobId?: string;
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
/** REST API 返回的映射信息。 */
export interface FrpMappingInfo {
    id: string;
    clientId: string;
    frpsInstanceId: string | null;
    name: string;
    proxyType: "tcp" | "http" | "https";
    localIp: string;
    localPort: number;
    remotePort: number | null;
    customDomain: string | null;
    status: FrpMappingStatus;
    publicUrl: string | null;
    operationJobId: string | null;
    errorCode: FrpErrorCode | null;
    errorMessage: string | null;
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
/** Storage 分享状态。 */
export type StorageShareStatus = "active" | "revoked" | "invalid";
/** Storage 分享管理信息；不包含 Token 或 Provider URL。 */
export interface StorageShareInfo {
    id: string;
    fileId: string | null;
    filename: string;
    mimeType: string | null;
    storageKind: string;
    status: StorageShareStatus;
    previewable: boolean;
    createdByIdentityId: string | null;
    createdByName: string | null;
    createdVia: string | null;
    createdAt: string;
    revokedAt: string | null;
    revokedByIdentityId: string | null;
    invalidatedAt: string | null;
    invalidReason: string | null;
}
/** 创建 Storage 分享请求。 */
export interface CreateStorageShareRequest {
    fileId: string;
}
/** 创建 Storage 分享结果；sharePath 只在创建响应返回。 */
export interface CreateStorageShareResult extends StorageShareInfo {
    sharePath: string;
}
/** Storage 分享相关稳定错误码。 */
export declare const StorageShareErrorCode: {
    readonly FILE_NOT_SHAREABLE: "FILE_NOT_SHAREABLE";
    readonly STORAGE_PROVIDER_MISMATCH: "STORAGE_PROVIDER_MISMATCH";
    readonly STORAGE_SHARE_NOT_FOUND: "STORAGE_SHARE_NOT_FOUND";
    readonly FILE_HAS_ACTIVE_SHARES: "FILE_HAS_ACTIVE_SHARES";
};
export type StorageShareErrorCode = (typeof StorageShareErrorCode)[keyof typeof StorageShareErrorCode];
/** 创建映射 REST 请求体。 */
export interface FrpMappingCreateRequest {
    clientId: string;
    name?: string;
    proxyType: "tcp" | "http" | "https";
    localIp?: string;
    localPort: number;
    remotePort?: number;
    customDomain?: string;
    frpsInstanceId?: string;
    timeoutSeconds?: number;
}
/** 解析 FRP Dashboard 确认时限，默认 30 秒。 */
export declare function parseFrpOperationTimeout(value: unknown): number;
/** 严格解析创建映射 REST 请求。 */
export declare function parseFrpMappingCreateRequest(value: unknown): FrpMappingCreateRequest & {
    localIp: string;
    timeoutSeconds: number;
};
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
    serverInfo?: {
        version: string;
    };
    error?: string;
    proxies: {
        total: number;
        byType: {
            tcp: number;
            http: number;
            https: number;
        };
        /** status: online = FRPS 已建立隧道；offline = 残留条目（frpc 已断开，尚未从列表移除） */
        list: {
            name: string;
            proxyType: string;
            remotePort: number | null;
            status: "online" | "offline";
        }[];
        usedPorts: number[];
    } | null;
}
export { FRP_RECONCILE_PROTOCOL_VERSION, parseFrpCapabilityStatus, parseFrpReconcilePayload, parseFrpReconcileResult, parseFrpRuntimeStateAck, parseFrpRuntimeStateReport, } from "./frp-runtime.js";
export type { FrpCapabilityStatus, FrpReconcilePayload, FrpReconcileResult, FrpRecoveryOwner, FrpRuntimeMappingSnapshot, FrpRuntimeStateAck, FrpRuntimeStateReport, FrpRuntimeStatus, } from "./frp-runtime.js";
