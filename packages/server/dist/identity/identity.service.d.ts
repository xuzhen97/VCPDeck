import { PrismaService } from "../prisma/prisma.service.js";
import type { IdentityInfo } from "@vcpdeck/shared";
export declare class IdentityService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    create(username: string, password: string, displayName: string): Promise<IdentityInfo>;
    list(): Promise<IdentityInfo[]>;
    disable(id: string): Promise<void>;
    enable(id: string): Promise<void>;
}
