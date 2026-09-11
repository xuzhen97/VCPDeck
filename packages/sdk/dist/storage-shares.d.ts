import type { CreateStorageShareRequest, CreateStorageShareResult, PaginatedResult, StorageShareInfo, StorageShareStatus } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
/** Storage Share 认证管理 API。 */
export declare function createStorageSharesApi(client: Pick<VcpDeckClient, "request">): {
    create: (input: CreateStorageShareRequest, signal?: AbortSignal) => Promise<CreateStorageShareResult>;
    list: (options?: {
        fileId?: string;
        status?: StorageShareStatus;
        page?: number;
        pageSize?: number;
    }, signal?: AbortSignal) => Promise<PaginatedResult<StorageShareInfo>>;
    get: (id: string, signal?: AbortSignal) => Promise<StorageShareInfo>;
    revoke: (id: string, signal?: AbortSignal) => Promise<StorageShareInfo>;
};
