import { type FrpMappingCreateRequest, type FrpMappingInfo, FrpsInstanceCreateRequest, FrpsInstanceUpdateRequest, FrpsInstanceInfo, PaginatedResult, ProbeResult } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
import type { WaitJobOptions, createJobsApi } from "./jobs.js";
export interface WaitFrpOptions extends WaitJobOptions {
    timeoutSeconds?: number;
}
/** FRP 完整操作失败。 */
export declare class FrpOperationError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** 创建 FRP REST API。 */
export declare function createFrpApi(client: Pick<VcpDeckClient, "request">, jobs?: ReturnType<typeof createJobsApi>): {
    list: (options?: {
        clientId?: string;
        page?: number;
        pageSize?: number;
    }, signal?: AbortSignal) => Promise<PaginatedResult<FrpMappingInfo>>;
    get: (id: string, signal?: AbortSignal) => Promise<FrpMappingInfo>;
    create: (input: FrpMappingCreateRequest, signal?: AbortSignal) => Promise<FrpMappingInfo>;
    createAndWait(input: FrpMappingCreateRequest, options?: WaitFrpOptions): Promise<FrpMappingInfo>;
    delete: (id: string, optionsOrSignal?: WaitFrpOptions | AbortSignal) => Promise<FrpMappingInfo>;
    deleteAndWait(id: string, options?: WaitFrpOptions): Promise<{
        id: string;
        deleted: true;
    }>;
    instances: {
        list: (options?: {
            page?: number;
            pageSize?: number;
        }, signal?: AbortSignal) => Promise<PaginatedResult<FrpsInstanceInfo>>;
        get: (id: string, signal?: AbortSignal) => Promise<FrpsInstanceInfo>;
        create: (input: FrpsInstanceCreateRequest, signal?: AbortSignal) => Promise<FrpsInstanceInfo>;
        update: (id: string, input: FrpsInstanceUpdateRequest, signal?: AbortSignal) => Promise<FrpsInstanceInfo>;
        delete: (id: string, signal?: AbortSignal) => Promise<{
            id: string;
            deleted: true;
        }>;
        probe: (id: string, signal?: AbortSignal) => Promise<ProbeResult>;
        setDefault: (id: string, signal?: AbortSignal) => Promise<FrpsInstanceInfo>;
    };
};
