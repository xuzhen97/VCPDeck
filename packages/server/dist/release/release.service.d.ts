import { ReleaseStatus, type PaginatedResult, type ReleaseClientEntry, type ReleaseClientState, type ReleaseInfo, type ReleasePlatform, type ReleaseArchiveAvailableInfo, type ReleaseArchiveDeletingInfo, type ReleaseArchiveInfo, type ReleaseArchiveStorage } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
/** release 领域错误：code 稳定，message 安全（不含文件内容/密钥） */
export declare class ReleaseError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export type ReleaseArchiveStorageRecord = ReleaseArchiveStorage & {
    /** Server 内部 Provider 对象 key；不得进入 API 响应。 */
    key: string;
};
export type ServerReleaseArchiveInfo = (Omit<ReleaseArchiveAvailableInfo, "storage"> & {
    storage?: ReleaseArchiveStorageRecord;
}) | (Omit<ReleaseArchiveDeletingInfo, "storage"> & {
    storage?: ReleaseArchiveStorageRecord;
}) | Extract<ReleaseArchiveInfo, {
    availability: "cleaned";
}>;
export type ServerReleaseInfo = Omit<ReleaseInfo, "archives"> & {
    archives: Partial<Record<ReleasePlatform, ServerReleaseArchiveInfo>>;
};
export interface CreateReleaseInput {
    version: string;
    /** 平台 -> 构件信息（首次上传至少含一个平台，另一个平台经 addArchive 补充） */
    archives: Record<string, ServerReleaseArchiveInfo>;
    /** 上传者（由 AuthGuard 注入） */
    createdByName?: string;
    createdVia?: string;
}
interface ReleaseDbRow {
    version: string;
    archives: string;
    status: string;
    errorMessage: string | null;
    createdByName: string | null;
    createdVia: string | null;
    clientStates: string;
    createdAt: Date;
    updatedAt: Date;
}
/** 将 Server 内部 Release 投影为不含 Provider key 的公开对象。 */
export declare function toPublicReleaseInfo(info: ServerReleaseInfo): ReleaseInfo;
/** DB 行 → API 形态（archives/clientStates 解析为对象，日期转 ISO 字符串）。 */
export declare function toReleaseInfo(row: ReleaseDbRow): ReleaseInfo;
export declare class ReleaseService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    /** 上传后登记 release（版本重复抛 RELEASE_DUPLICATE_VERSION） */
    create(input: CreateReleaseInput): Promise<ReleaseInfo>;
    /**
     * 补充单个平台的构件（第二次上传）。已存在同平台构件或 release 不存在时抛错。
     * 返回更新后的 release。
     */
    addArchive(version: string, platform: ReleasePlatform, archive: ServerReleaseArchiveInfo): Promise<ReleaseInfo>;
    /** release 是否已包含全部支持平台的构件（补齐后才允许触发更新） */
    hasAllArchives(release: ReleaseInfo): boolean;
    /** 分页列表（遵循 AGENTS.md 分页规范） */
    list(page?: number, pageSize?: number): Promise<PaginatedResult<ReleaseInfo>>;
    findByVersion(version: string): Promise<ReleaseInfo | null>;
    /** Server 内部读取 Release；仅供下载/清理/直传登记使用，不可直接返回 API。 */
    findByVersionWithStorage(version: string): Promise<ServerReleaseInfo | null>;
    /** 返回清理策略使用的全部公开 Release；具体删除时再通过 CAS 读取内部 key。 */
    listForCleanup(): Promise<ReleaseInfo[]>;
    /** 以 archive JSON 做条件更新，声明一个 archive 进入 deleting。 */
    claimArchiveForCleanup(version: string, platform: ReleasePlatform): Promise<{
        sha256: string;
        size: number;
        fileName: string;
        availability: "deleting";
        storage?: ReleaseArchiveStorageRecord;
    } | null>;
    /** 以 archive JSON 做条件更新，完成正文删除并保留审计摘要。 */
    finishArchiveCleanup(version: string, platform: ReleasePlatform, cleanedAt: string): Promise<boolean>;
    /** 清理失败时将当前 archive 恢复为可重试的 available。 */
    restoreArchiveAfterCleanup(version: string, platform: ReleasePlatform): Promise<boolean>;
    /**
     * 状态流转（原子）：先校验当前状态允许流转，再按 version+status 条件更新，
     * 条件更新条数为 0 视为并发修改/非法流转。
     */
    transitionStatus(version: string, to: ReleaseStatus, errorMessage?: string): Promise<void>;
    /**
     * 记录单个客户端在 release 中的更新状态（含失败原因与时间戳，审计用）。
     * 返回合并后的完整状态表。
     */
    markClientState(version: string, clientId: string, state: ReleaseClientState, reason?: string): Promise<Record<string, ReleaseClientEntry>>;
    /** 置为 failed（附安全错误摘要） */
    markFailed(version: string, errorMessage: string): Promise<void>;
    /** 当前活动目标版本：最近一条具有双平台可用构件的 updating_clients/done release。 */
    getLatestActiveTarget(): Promise<ReleaseInfo | null>;
    /** 进行中的 release：updating_server / updating_clients（编排器忙检查与启动恢复用） */
    getActiveRelease(): Promise<ReleaseInfo | null>;
    /** 流式计算文件 sha256 并与期望值比对（文件不存在/读失败返回 false） */
    verifyZipSha256(filePath: string, expected: string): Promise<boolean>;
}
export {};
