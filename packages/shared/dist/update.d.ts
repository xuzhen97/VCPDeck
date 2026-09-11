/** 更新包 manifest（打包时生成，随 archive 携带） */
export interface UpdateManifest {
    version: string;
    /** 所需 Node 版本约束（如 ">=24"），launcher ensure-node 使用 */
    nodeVersion: string;
    /** launcher 最低兼容版本（当前字段预留，尚未执行校验） */
    launcherMinVersion: string;
    /** 随发布包提供的稳定 Launcher 入口；首次安装时复制到 app-dir 外部路径 */
    launcher?: {
        dir: string;
        entry: string;
    };
    /** archive 整体 sha256（当前 manifest 内留空，权威值存于 Release 并随更新请求下发） */
    sha256: string;
    artifacts: {
        server?: {
            dir: string;
            entry: string;
            /** 启动前钩子，如 "prisma db push" */
            preStart?: string;
        };
        client?: {
            dir: string;
            entry: string;
        };
    };
}
/** 服务端 → 客户端：请求更新（含下载地址与校验值） */
export interface UpdateRequest {
    releaseVersion: string;
    /** 更新包下载 URL（客户端 launcher 使用） */
    url: string;
    sha256: string;
    /** 优雅停机等待上限（ms），缺省 10 分钟 */
    timeoutMs?: number;
}
/** 客户端 → 服务端：优雅停机完成，launcher 即将接管 */
export interface UpdateReady {
    clientId: string;
    releaseVersion: string;
}
/** 客户端 → 服务端：更新失败（原因仅安全摘要，不含文件内容） */
export interface UpdateFailed {
    clientId: string;
    releaseVersion: string;
    reason: string;
}
/** 服务端 → 广播：服务端即将重启（客户端保持运行，稍后自动重连） */
export interface ServerShutdownNotice {
    expectedVersion?: string;
    reconnectDelayMs?: number;
}
/** Release 状态机：uploaded → updating_server → updating_clients → done/failed */
export declare enum ReleaseStatus {
    UPLOADED = "uploaded",
    UPDATING_SERVER = "updating_server",
    UPDATING_CLIENTS = "updating_clients",
    DONE = "done",
    FAILED = "failed"
}
/** 单客户端在某个 release 中的更新状态 */
export declare enum ReleaseClientState {
    PENDING = "pending",
    UPDATING = "updating",
    DONE = "done",
    FAILED = "failed"
}
/** 单客户端更新条目（含失败原因与时间戳，审计用） */
export interface ReleaseClientEntry {
    state: ReleaseClientState;
    /** 失败原因摘要（仅 failed 时非空，安全脱敏） */
    reason?: string;
    /** 最后状态变更时间（ISO 字符串） */
    at: string;
}
/** 发布包支持的目标平台（打包脚本产出对应的分发 zip） */
export type ReleasePlatform = "win-x64" | "linux-x64";
/** Release 上传会话稳定错误码。 */
export declare const ReleaseUploadErrorCode: {
    readonly DIRECT_UPLOAD_REQUIRED: "RELEASE_DIRECT_UPLOAD_REQUIRED";
    readonly SESSION_NOT_FOUND: "RELEASE_UPLOAD_SESSION_NOT_FOUND";
    readonly SESSION_EXPIRED: "RELEASE_UPLOAD_SESSION_EXPIRED";
    readonly SESSION_CONFLICT: "RELEASE_UPLOAD_SESSION_CONFLICT";
    readonly SIZE_MISMATCH: "RELEASE_UPLOAD_SIZE_MISMATCH";
    readonly PROVIDER_FAILED: "RELEASE_UPLOAD_PROVIDER_FAILED";
};
/** 创建 Release 上传会话的严格输入。 */
export interface ReleaseUploadCreateInput {
    version: string;
    platform: ReleasePlatform;
    sha256: string;
    size: number;
}
/** 外部 Provider 的单个直传分片。 */
export interface ReleaseUploadPart {
    partNumber: number;
    url: string;
}
/** Release 上传会话协商结果。 */
export type ReleaseUploadSession = {
    mode: "server";
} | {
    mode: "existing";
    release: ReleaseInfo;
} | {
    mode: "direct";
    sessionId: string;
    partSize: number;
    parts: ReleaseUploadPart[];
    expiresAt: string;
};
/** 严格解析 Release 上传会话创建输入。 */
export declare function parseReleaseUploadCreateInput(value: unknown): ReleaseUploadCreateInput;
/** 严格解析需要刷新的分片编号。 */
export declare function parseReleaseUploadPartRefresh(value: unknown): {
    partNumbers: number[];
};
/** 严格解析 Release 直传完成输入。 */
export declare function parseReleaseUploadComplete(value: unknown): {
    uploadedBytes: number;
};
/** 可用发布构件（旧记录允许缺失 availability）。 */
export type ReleaseArchiveAvailableInfo = ReleaseArchiveBase & {
    /** 旧 Release JSON 缺失该字段时按 available 兼容解析。 */
    availability?: "available";
    /** 外部存储直连信息（ADR-0019；Local 后端无此字段） */
    storage?: ReleaseArchiveStorage;
};
/** 正在清理的发布构件。 */
export type ReleaseArchiveDeletingInfo = ReleaseArchiveBase & {
    availability: "deleting";
    /** 对外仅保留后端摘要；Server 内部记录另行保留定位信息用于重启恢复。 */
    storage?: ReleaseArchiveStorage;
};
/** 单个平台的发布构件信息（校验值、体积与生命周期）。 */
export type ReleaseArchiveInfo = ReleaseArchiveAvailableInfo | ReleaseArchiveDeletingInfo | (ReleaseArchiveBase & {
    availability: "cleaned";
    /** 清理态禁止保留实际对象定位信息。 */
    storage?: never;
    /** 清理后保留的非敏感存储摘要，不包含对象 key。 */
    storageSummary?: ReleaseArchiveStorageSummary;
    cleanedAt: string;
    cleanupReason: ReleaseCleanupReason;
});
interface ReleaseArchiveBase {
    sha256: string;
    size: number;
    fileName: string;
}
/** 发布构件存储信息（ADR-0019：外部存储上传/下载双向直连）。
 * Local 后端无此字段；目标机经统一入口 302 直连存储下载。 */
export interface ReleaseArchiveStorage {
    /** 存储后端 kind（local / alibaba 等）；不包含 Provider 对象 key */
    provider: string;
    /** 分发模式：direct = 目标机经统一入口 302 直连存储 */
    mode: "direct";
}
/** 清理后保留的发布构件存储摘要。 */
export interface ReleaseArchiveStorageSummary {
    /** 原存储后端 kind */
    provider: string;
    /** 原分发模式 */
    mode: "direct";
}
/** 发布构件生命周期状态。 */
export type ReleaseArchiveAvailability = "available" | "deleting" | "cleaned";
/** 发布构件清理原因。 */
export type ReleaseCleanupReason = "retention_policy";
/** 只有正文仍可用的构件才可参与下载、编排、安装和补更。 */
export declare function isReleaseArchiveAvailable(archive: ReleaseArchiveInfo | undefined): archive is ReleaseArchiveAvailableInfo;
/** Release 清理固定策略。 */
export interface ReleaseCleanupPolicy {
    successfulReleaseCount: 3;
    minimumAgeDays: 30;
    uploadSessionGraceHours: 24;
}
/** Release 清理预览中的归档候选。 */
export interface ReleaseCleanupArchiveCandidate {
    version: string;
    status: ReleaseStatus;
    archives: Array<{
        platform: ReleasePlatform;
        bytes: number;
        providerState: "ready" | "provider_unavailable";
    }>;
    bytes: number;
    reason: "retention_policy";
}
/** Release 清理预览结果。 */
export interface ReleaseCleanupPreview {
    policy: ReleaseCleanupPolicy;
    candidates: ReleaseCleanupArchiveCandidate[];
    expiredUploadSessions: {
        count: number;
        bytes: number;
    };
    estimatedReclaimableBytes: number;
}
/** Release 清理执行中的安全问题摘要。 */
export interface ReleaseCleanupIssue {
    version?: string;
    platform?: ReleasePlatform;
    code: string;
}
/** Release 清理执行结果。 */
export interface ReleaseCleanupRunResult {
    startedAt: string;
    finishedAt: string;
    cleanedItems: number;
    cleanedBytes: number;
    alreadyMissing: number;
    failed: number;
    skipped: number;
    providerUnavailable: number;
    retryable: boolean;
    issues: ReleaseCleanupIssue[];
}
/** 由客户端注册的 os 字符串（如 "win32 10.0.26200"）映射到发布平台，未知平台返回 null */
export declare function platformFromOs(os: string | undefined | null): ReleasePlatform | null;
/** release 列表项（REST 返回） */
export interface ReleaseInfo {
    version: string;
    /** 平台 -> 构件信息（上传两个平台后完整；缺失平台的目标机无法更新） */
    archives: Partial<Record<ReleasePlatform, ReleaseArchiveInfo>>;
    status: ReleaseStatus;
    errorMessage?: string | null;
    /** 发版操作者（上传者身份；由 AuthGuard 注入） */
    createdByName?: string | null;
    createdVia?: string | null;
    createdAt: string;
    updatedAt: string;
    /** clientId -> 更新条目（JSON 字符串在 DB，API 层解析为对象） */
    clientStates: Record<string, ReleaseClientEntry>;
}
export {};
