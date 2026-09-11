import type { PaginatedResult, ReleaseCleanupPreview, ReleaseCleanupRunResult, ReleaseInfo, ReleasePlatform, ReleaseUploadCreateInput, ReleaseUploadPart, ReleaseUploadSession } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
/** 服务端状态信息（GET /api/status） */
export interface ServerStatus {
    serverVersion: string;
    activeRelease: ReleaseInfo | null;
}
/** Release archive 上传参数；调用方负责计算 SHA-256。 */
export interface ReleaseUploadInput {
    version: string;
    platform: ReleasePlatform;
    sha256: string;
    archive: BodyInit;
    contentType?: string;
    /** Node.js Readable 等流式 body 需要设置为 half。 */
    duplex?: "half";
}
/** 创建发版 REST API。 */
export declare function createReleasesApi(client: Pick<VcpDeckClient, "request" | "requestRaw">): {
    list: (options?: {
        page?: number;
        pageSize?: number;
    }, signal?: AbortSignal) => Promise<PaginatedResult<ReleaseInfo>>;
    createUploadSession: (input: ReleaseUploadCreateInput, signal?: AbortSignal) => Promise<ReleaseUploadSession>;
    refreshUploadParts: (sessionId: string, partNumbers: number[], signal?: AbortSignal) => Promise<{
        parts: ReleaseUploadPart[];
    }>;
    completeUploadSession: (sessionId: string, uploadedBytes: number, signal?: AbortSignal) => Promise<{
        release: ReleaseInfo;
    }>;
    /** Local 后端及旧 Server 引导使用的 legacy raw 上传。 */
    upload: (input: ReleaseUploadInput, signal?: AbortSignal) => Promise<{
        release: ReleaseInfo;
    }>;
    cleanupPreview: (signal?: AbortSignal) => Promise<ReleaseCleanupPreview>;
    cleanupRun: (signal?: AbortSignal) => Promise<ReleaseCleanupRunResult>;
    status: (signal?: AbortSignal) => Promise<ServerStatus>;
};
