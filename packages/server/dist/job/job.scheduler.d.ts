import { PrismaService } from "../prisma/prisma.service.js";
import type { DispatchPayload } from "@vcpdeck/shared";
import { ServerDrain } from "./server-drain.js";
export declare class JobScheduler {
    private readonly prisma;
    private readonly drain?;
    constructor(prisma: PrismaService, drain?: ServerDrain | undefined);
    tryDispatch(clientId: string): Promise<DispatchPayload | null>;
    onFinished(clientId: string): Promise<DispatchPayload | null>;
}
