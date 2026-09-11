import type { ServerShutdownNotice, UpdateRequest } from "@vcpdeck/shared";
import { ClientService } from "../client/client.service.js";
import type { ClientUpdateChannel } from "./release.orchestrator.js";
export interface UpdateEmitters {
    sendUpdateRequest: (clientId: string, req: UpdateRequest) => void;
    broadcastShutdown: (notice: ServerShutdownNotice) => void;
}
export declare class GatewayUpdateChannel implements ClientUpdateChannel {
    private readonly clients;
    private emitters;
    constructor(clients: ClientService);
    /** 由 ClientGateway.afterInit 调用，绑定真实发送通道 */
    bindEmitters(emitters: UpdateEmitters): void;
    listOnlineClients(): Promise<Array<{
        clientId: string;
        clientVersion: string;
        os: string;
    }>>;
    sendUpdateRequest(clientId: string, req: UpdateRequest): void;
    broadcastShutdown(notice: ServerShutdownNotice): void;
}
