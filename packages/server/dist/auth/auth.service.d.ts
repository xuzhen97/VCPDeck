import { PrismaService } from "../prisma/prisma.service.js";
import type { ActorContext, TokenInfo, CreateTokenResponse } from "@vcpdeck/shared";
export declare class AuthService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    login(username: string, password: string): Promise<{
        sessionToken: string;
        identity: {
            id: string;
            username: string;
            displayName: string;
            isAdmin: boolean;
        };
    }>;
    logout(actor: ActorContext): Promise<void>;
    getMe(actor: ActorContext): Promise<{
        id: string;
        username: string;
        displayName: string;
        isAdmin: boolean;
        disabledAt: string | null;
        createdAt: string;
    }>;
    updateMe(actor: ActorContext, data: {
        username?: string;
        password?: string;
        currentPassword: string;
    }): Promise<void>;
    createToken(actor: ActorContext, label: string): Promise<CreateTokenResponse>;
    listTokens(actor: ActorContext): Promise<TokenInfo[]>;
    revokeToken(actor: ActorContext, credentialId: string): Promise<void>;
}
