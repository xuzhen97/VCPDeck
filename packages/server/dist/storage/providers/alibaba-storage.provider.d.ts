import { Readable } from "node:stream";
/** 直传分片大小（与现有 uploadToKey 的分片逻辑一致） */
export declare const ALIBABA_PART_SIZE: number;
import { type StorageProvider, type FileMeta, type FileEntry } from "./storage-provider.interface.js";
/** 刷新后需要持久化的 token 字段 */
export interface TokenPersistence {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
}
export declare class AlibabaStorageProvider implements StorageProvider {
    private readonly logger;
    private readonly signSecret;
    private runtime;
    private persistTokens?;
    constructor(config?: Record<string, unknown>);
    /** 懒加载 driveId（首次调用时获取） */
    private ensureReady;
    /** 注册 token 刷新后的持久化回调（写回 DB，保证重启后不丢失） */
    setTokenPersistence(fn: (tokens: TokenPersistence) => Promise<void>): void;
    private makeClient;
    /** 刷新 access_token */
    private refreshAccessToken;
    /** 创建直传上传会话，返回各分片预签名 URL */
    createDirectUpload(size: number, name: string): Promise<{
        fileId: string;
        uploadId: string;
        partSize: number;
        parts: Array<{
            partNumber: number;
            url: string;
        }>;
    }>;
    /** 续期指定分片的上传 URL */
    refreshPartUrls(fileId: string, uploadId: string, partNumbers: number[]): Promise<Array<{
        partNumber: number;
        url: string;
    }>>;
    /** 完成直传（合并分片） */
    completeDirectUpload(fileId: string, uploadId: string): Promise<void>;
    /** 获取外部下载 URL（临时，约 15 分钟） */
    getExternalDownloadUrl(fileId: string): Promise<{
        url: string;
        expiresAt: number;
    }>;
    /** StorageProvider 直连下载 URL（ADR-0016：目标机直连网盘下载） */
    getDirectDownloadUrl(key: string): Promise<{
        url: string;
        expiresAt: number;
    } | null>;
    upload(stream: Readable, meta: FileMeta): Promise<FileEntry>;
    uploadToKey(stream: Readable, meta: FileMeta, _key: string): Promise<FileEntry>;
    download(key: string): Promise<{
        stream: Readable;
        meta: FileEntry;
    }>;
    delete(key: string): Promise<void>;
    signDownloadUrl(key: string, expiresInSeconds: number): string;
    signUploadUrl(key: string, expiresInSeconds: number): string;
    verifyDownloadSignature(key: string, expiresAt: number, sig: string): boolean;
    verifyUploadSignature(key: string, expiresAt: number, sig: string): boolean;
    private sign;
    private resolvePartSize;
}
