import type { ActorContext, CreateStorageShareRequest, CreateStorageShareResult, PaginatedResult, StorageShareInfo, StorageShareStatus } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "./storage.service.js";
type StorageShareRow = {
    id: string;
    tokenHash: string;
    fileId: string | null;
    filename: string;
    mimeType: string | null;
    storageKind: string;
    createdByIdentityId: string | null;
    createdByName: string | null;
    createdVia: string | null;
    createdAt: Date;
    revokedAt: Date | null;
    revokedByIdentityId: string | null;
    invalidatedAt: Date | null;
    invalidReason: string | null;
    file?: {
        id: string;
        key: string;
        filename: string;
        mimeType: string | null;
        size: number;
        status: string;
        storageKind: string;
    } | null;
};
/** 根据文件名返回固定的图片 MIME；不信任上传 MIME。 */
export declare function previewMime(filename: string): string | null;
export declare class StorageShareService {
    private readonly prisma;
    private readonly storage;
    constructor(prisma: PrismaService, storage: StorageService);
    /** 创建独立的长期公开分享；数据库只保存 Token 哈希。 */
    create(request: CreateStorageShareRequest, actor: ActorContext): Promise<CreateStorageShareResult>;
    /** 分页查询分享管理信息。 */
    list(options?: {
        fileId?: string;
        status?: StorageShareStatus;
        page?: number;
        pageSize?: number;
    }): Promise<PaginatedResult<StorageShareInfo>>;
    /** 查询单条分享，不恢复公开路径。 */
    get(id: string): Promise<StorageShareInfo>;
    /** 幂等软撤销分享。 */
    revoke(id: string, actor: ActorContext): Promise<StorageShareInfo>;
    /** 查询 File 是否仍被有效分享保护。 */
    hasActiveShares(fileId: string): Promise<boolean>;
    /** 按公开 Token 哈希查找内部分享记录。 */
    resolvePublic(token: string): Promise<StorageShareRow>;
    /** 标记 Provider 已确认永久缺失的分享。 */
    markInvalid(id: string, reason: string): Promise<void>;
    /** 将数据库行映射为不含 Token 的管理 DTO。 */
    toInfo(row: StorageShareRow): StorageShareInfo;
    private isUniqueError;
}
export {};
