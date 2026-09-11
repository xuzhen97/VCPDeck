/** @file FRP 映射 REST API */
import { FrpService } from "./frp.service.js";
import { ClientGateway } from "../events/client.gateway.js";
export declare class FrpController {
    private readonly frpService;
    private readonly gateway;
    constructor(frpService: FrpService, gateway: ClientGateway);
    create(body: unknown): Promise<import("@vcpdeck/shared").FrpMappingInfo>;
    list(clientId?: string, page?: string, pageSize?: string): Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").FrpMappingInfo>>;
    get(id: string): Promise<import("@vcpdeck/shared").FrpMappingInfo>;
    delete(id: string, timeoutSeconds?: string): Promise<import("@vcpdeck/shared").FrpMappingInfo>;
}
