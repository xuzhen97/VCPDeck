import { IdentityService } from "./identity.service.js";
import type { ActorContext, CreateIdentityRequest, IdentityInfo } from "@vcpdeck/shared";
export declare class IdentityController {
    private readonly identityService;
    constructor(identityService: IdentityService);
    private checkAdmin;
    list(actor: ActorContext): Promise<IdentityInfo[]>;
    create(actor: ActorContext, body: CreateIdentityRequest): Promise<IdentityInfo>;
    disable(actor: ActorContext, id: string): Promise<{
        ok: boolean;
    }>;
    enable(actor: ActorContext, id: string): Promise<{
        ok: boolean;
    }>;
}
