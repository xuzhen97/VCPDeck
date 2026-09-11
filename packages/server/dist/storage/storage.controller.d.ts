import type { Request, Response } from "express";
import { StorageService } from "./storage.service.js";
export declare class StorageController {
    private readonly storageService;
    constructor(storageService: StorageService);
    /** 签发上传令牌 */
    createUploadToken(body: {
        jobId: string;
        clientId: string;
        filename: string;
        size: number;
        mimeType?: string;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        expiresAt: number;
    }>;
    /** 签发下载令牌 */
    createDownloadToken(body: {
        key: string;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        expiresAt: number;
    }>;
    /** 受鉴权的稳定下载入口；每次请求实时签发后端 URL */
    redirectDownload(key: string, res: Response): Promise<void>;
    /** 接收文件上传（预签名 URL） */
    receiveUpload(key: string, expires: string, sig: string, req: Request): Promise<{
        key: string;
        size: number;
    }>;
    /** 下载文件（预签名 URL） */
    download(key: string, expires: string, sig: string, res: Response): Promise<void>;
    /** 查看当前存储后端配置 */
    getConfig(): Promise<{
        kind: "local" | "alibaba";
        updatedAt: string | null;
    }>;
    /** 切换存储后端 */
    updateConfig(body: {
        kind?: string;
        config?: Record<string, unknown>;
    }): Promise<{
        kind: "local" | "alibaba";
        updatedAt: string | null;
    }>;
}
