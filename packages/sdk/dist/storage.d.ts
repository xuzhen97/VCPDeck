import type { VcpDeckClient } from "./client.js";
/** Storage 可用后端。 */
export type StorageBackendKind = "local" | "alibaba";
/** 当前激活 Storage 后端的安全摘要。 */
export interface StorageBackendStatus {
    kind: StorageBackendKind;
    updatedAt: string | null;
}
/** Storage 签名 URL。 */
export interface StorageToken {
    url: string;
    expiresAt: number;
}
/** Storage 上传 URL 请求。 */
export interface StorageUploadTokenRequest {
    jobId: string;
    clientId: string;
    filename: string;
    size: number;
    mimeType?: string;
    ttlSeconds?: number;
}
/** 创建 Storage API；有意不暴露原始配置读取。 */
export declare function createStorageApi(client: Pick<VcpDeckClient, "request">): {
    getBackendConfig: (signal?: AbortSignal) => Promise<StorageBackendStatus>;
    createUploadToken: (input: StorageUploadTokenRequest, signal?: AbortSignal) => Promise<StorageToken>;
    /** 构造受鉴权的稳定下载地址；不提前签发临时 URL。 */
    downloadUrl: (key: string) => string;
    createDownloadToken: (input: {
        key: string;
        ttlSeconds?: number;
    }, signal?: AbortSignal) => Promise<StorageToken>;
    delete: (key: string, signal?: AbortSignal) => Promise<{
        ok: true;
    }>;
    setBackend: (input: {
        kind: StorageBackendKind;
    }, signal?: AbortSignal) => Promise<StorageBackendStatus>;
};
