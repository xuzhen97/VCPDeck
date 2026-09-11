import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "./storage.service.js";
export declare class AliyunDriveController {
    private readonly prisma;
    private readonly storage;
    private readonly logger;
    private oauthSessions;
    constructor(prisma: PrismaService, storage: StorageService);
    /** 获取当前配置和授权状态 */
    getStatus(): Promise<{
        configured: boolean;
        authorized: boolean;
        hasAuth: boolean;
        isExpired: boolean;
        clientId: string | undefined;
        openapiBase: string;
        transferFolder: string;
        driveId: string | undefined;
        expiresAt: number | undefined;
    }>;
    /** 通过阿里云盘 OpenAPI 验证当前授权是否仍可用。 */
    verify(): Promise<{
        valid: boolean;
        checkedAt: string;
        driveId: string;
        reason?: undefined;
    } | {
        driveId?: undefined;
        valid: boolean;
        checkedAt: string;
        reason: string;
    }>;
    /** 保存配置 */
    saveConfig(body: {
        clientId: string;
        clientSecret?: string | null;
        openapiBase?: string;
        transferFolder?: string;
    }): Promise<{
        clientId: string;
        refreshToken?: string;
        accessToken?: string;
        expiresAt?: number;
        driveId?: string;
        transferFolder?: string;
        openapiBase?: string;
        signSecret?: string;
    }>;
    /** 启动 OAuth PKCE 授权流程 */
    startOAuth(): Promise<{
        state: string;
        authorizationUrl: string;
        expiresAt: number;
    }>;
    /** 完成 OAuth 授权（用 code 换取 token） */
    completeOAuth(body: {
        state: string;
        code: string;
    }): Promise<{
        authorized: boolean;
        expiresAt: number | undefined;
    }>;
    /** 撤销授权（清除 token） */
    revoke(): Promise<{
        revoked: boolean;
    }>;
    private getConfig;
    private refreshAccessToken;
    private writeConfig;
}
