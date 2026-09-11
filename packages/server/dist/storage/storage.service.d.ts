import { type OnModuleInit } from "@nestjs/common";
import { type Readable } from "node:stream";
import type { StorageProvider, FileMeta, FileEntry } from "./providers/storage-provider.interface.js";
import { PrismaService } from "../prisma/prisma.service.js";
export declare class StorageService implements OnModuleInit {
    private readonly prisma;
    private readonly logger;
    private provider;
    private pendingUploads;
    /** key = File 行主键（dbFileId） */
    private directUploadSessions;
    constructor(prisma: PrismaService);
    onModuleInit(): Promise<void>;
    /** 读取 DB 配置，初始化 provider */
    loadProvider(): Promise<void>;
    /** 运行时切换后端（管理面板调用） */
    reload(): Promise<void>;
    getProvider(): StorageProvider;
    /** 获取支持直传的阿里云 provider（功能检测，便于测试 mock） */
    private requireDirectProvider;
    /** 为 Release 创建外部 Provider 直传会话（ADR-0019）。 */
    createReleaseDirectUpload(size: number, name: string): Promise<{
        fileId: string;
        uploadId: string;
        partSize: number;
        parts: Array<{
            partNumber: number;
            url: string;
        }>;
    }>;
    /** 刷新 Release 直传会话的指定分片 URL。 */
    refreshReleaseDirectUploadParts(fileId: string, uploadId: string, partNumbers: number[]): Promise<Array<{
        partNumber: number;
        url: string;
    }>>;
    /** 完成 Release 直传并由 Provider 合并分片。 */
    completeReleaseDirectUpload(fileId: string, uploadId: string): Promise<void>;
    /** 返回当前激活 Provider 的稳定标识。 */
    currentKind(): "local" | "alibaba";
    /** 是否支持目标机直连下载（ADR-0016：字节不经过 Server） */
    supportsDirectDownload(): boolean;
    /** 换取直连下载 URL（临时有效）；不支持直连返回 null */
    getDirectDownloadUrl(key: string): Promise<{
        url: string;
        expiresAt: number;
    } | null>;
    /** 服务端直传存储（ADR-0016：发布构件转存外部后端） */
    uploadStream(stream: Readable, meta: FileMeta): Promise<FileEntry>;
    /** 签发上传令牌，返回 FileRef */
    createUploadToken(meta: FileMeta, ttlSeconds?: number): Promise<{
        url: string;
        expiresAt: number;
    }>;
    /** 签发下载令牌（内部/管理面板调用）；alibaba 后端返回阿里云临时外部 URL */
    createDownloadToken(key: string, ttlSeconds?: number): Promise<{
        url: string;
        expiresAt: number;
    }>;
    /** 创建直传上传会话（上传方向：浏览器→远程），并把 File 行 key 更新为阿里云 fileId */
    createDirectUploadSession(size: number, name: string, dbFileId: string): Promise<{
        fileId: string;
        uploadId: string;
        partSize: number;
        parts: Array<{
            partNumber: number;
            url: string;
        }>;
    }>;
    /** 完成上传方向直传：校验字节数、合并分片、File 置 completed */
    completeDirectUploadSession(dbFileId: string, uploadedBytes: number): Promise<void>;
    /** 创建导出直传会话（导出方向：远程→浏览器，Client stat 后协商） */
    createExportSession(jobId: string, size: number): Promise<{
        fileId: string;
        uploadId: string;
        partSize: number;
        parts: Array<{
            partNumber: number;
            url: string;
        }>;
    }>;
    /** 完成导出直传：校验字节数、合并分片、File 置 completed，返回真实 key */
    completeExportUpload(jobId: string, uploadedBytes: number): Promise<{
        key: string;
    }>;
    /** 续期直传会话指定分片的上传 URL */
    refreshDirectPartUrls(jobId: string, partNumbers: number[]): Promise<Array<{
        partNumber: number;
        url: string;
    }>>;
    /** 直传进度上报：写入 job.progress（total 取 File.size） */
    updateUploadProgress(jobId: string, loaded: number): Promise<void>;
    /** 接收文件流并存储 */
    receiveUpload(key: string, stream: Readable, expiresAt: number, sig: string): Promise<FileEntry>;
    private updateJobProgress;
    private markUploadJobError;
    /** 验证下载签名并返回文件流 + 元数据 */
    downloadVerified(key: string, expiresAt: number, sig: string): Promise<{
        stream: Readable;
        meta: FileEntry;
    }>;
    /** 从 DB File 记录解析真实文件名（阿里云盘后端 key 为 fileId，无文件名语义） */
    resolveFilename(key: string): Promise<string | null>;
    /** 删除文件 */
    delete(key: string): Promise<void>;
    /** 获取当前激活后端的安全摘要，不返回 provider 原始配置。 */
    getBackendConfig(): Promise<{
        kind: "local" | "alibaba";
        updatedAt: string | null;
    }>;
    /** 更新存储后端配置并热切换 */
    updateBackendConfig(body: {
        kind?: string;
        config?: Record<string, unknown>;
    }): Promise<void>;
}
