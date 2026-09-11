import type { ActorContext, CreateStorageShareRequest } from "@vcpdeck/shared";
import { StorageShareService } from "./storage-share.service.js";
export declare class StorageShareController {
    private readonly service;
    constructor(service: StorageShareService);
    create(body: CreateStorageShareRequest, actor: ActorContext): Promise<import("@vcpdeck/shared").CreateStorageShareResult>;
    list(fileId?: string, status?: string, page?: string, pageSize?: string): Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").StorageShareInfo>>;
    get(id: string): Promise<import("@vcpdeck/shared").StorageShareInfo>;
    revoke(id: string, actor: ActorContext): Promise<import("@vcpdeck/shared").StorageShareInfo>;
}
