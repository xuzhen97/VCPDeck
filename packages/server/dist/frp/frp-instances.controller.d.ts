/** @file FRP 实例配置 REST API */
import { FrpsInstancesService } from "./frp-instances.service.js";
import type { FrpsInstanceCreateRequest, FrpsInstanceUpdateRequest } from "@vcpdeck/shared";
export declare class FrpsInstancesController {
    private readonly instancesService;
    constructor(instancesService: FrpsInstancesService);
    create(body: FrpsInstanceCreateRequest): Promise<import("@vcpdeck/shared").FrpsInstanceInfo>;
    list(page?: string, pageSize?: string): Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").FrpsInstanceInfo>>;
    get(id: string): Promise<import("@vcpdeck/shared").FrpsInstanceInfo>;
    update(id: string, body: FrpsInstanceUpdateRequest): Promise<import("@vcpdeck/shared").FrpsInstanceInfo>;
    delete(id: string): Promise<{
        id: string;
        deleted: boolean;
    }>;
    probe(id: string): Promise<import("@vcpdeck/shared").ProbeResult>;
    setDefault(id: string): Promise<import("@vcpdeck/shared").FrpsInstanceInfo>;
}
