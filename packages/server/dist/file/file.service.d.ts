import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { FileMeta } from "../storage/providers/storage-provider.interface.js";
export interface CreatePendingResult {
    fileId: string;
    key: string;
    uploadUrl: string;
    expiresAt: number;
}
export interface DownloadInfo {
    downloadUrl: string;
    size: number;
    sha256: string;
}
export declare class FileService {
    private readonly prisma;
    private readonly storage;
    constructor(prisma: PrismaService, storage: StorageService);
    /** 创建 pending File 记录 + 签发上传令牌 */
    createPending(jobId: string | undefined, clientId: string, meta: Omit<FileMeta, "key">, options?: {
        expiresAt?: Date;
        purpose?: string;
    }): Promise<CreatePendingResult>;
    /** 确认上传完成，保留上传阶段持久化的真实 key 并写入 sha256 */
    confirmUpload(fileId: string, sha256: string): Promise<{
        key: string;
        size: number;
    }>;
    /** 为已完成的 File 签发下载令牌 */
    createDownloadToken(fileId: string): Promise<DownloadInfo>;
    /** 查询已过期且未被有效分享保护的文件。 */
    getExpiredFiles(): Promise<{
        id: string;
        key: string;
    }[]>;
    /** 删除 File 记录和 Storage 对象，先通过 deleting 状态认领。 */
    delete(fileId: string): Promise<void>;
    /** 按 Storage key 查询已登记 File。 */
    findByKey(key: string): Promise<{
        id: string;
        key: string;
        jobId: string | null;
        clientId: string;
        filename: string;
        mimeType: string | null;
        size: number;
        sha256: string;
        status: string;
        storageKind: string;
        expiresAt: Date | null;
        createdAt: Date;
        purpose: string;
    } | null>;
    /** 按 ID 查询 */
    findById(fileId: string): Promise<{
        id: string;
        key: string;
        jobId: string | null;
        clientId: string;
        filename: string;
        mimeType: string | null;
        size: number;
        sha256: string;
        status: string;
        storageKind: string;
        expiresAt: Date | null;
        createdAt: Date;
        purpose: string;
    } | null>;
}
