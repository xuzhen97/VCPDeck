import type { VcpDeckClient } from "./client.js";
/** 阿里云盘授权远端校验结果；不包含访问凭证。 */
export interface AliyunDriveVerification {
    valid: boolean;
    checkedAt: string;
    driveId?: string;
    reason?: "not_configured" | "not_authorized" | "expired" | "revoked" | "forbidden" | "unreachable";
}
/** 阿里云盘安全状态；不包含访问凭证。 */
export interface AliyunDriveStatus {
    configured: boolean;
    authorized: boolean;
    hasAuth: boolean;
    isExpired: boolean;
    clientId?: string;
    openapiBase: string;
    transferFolder: string;
    driveId?: string;
    expiresAt?: number;
}
/** 阿里云盘公开配置输入。 */
export interface AliyunDriveConfigInput {
    clientId: string;
    clientSecret?: string | null;
    openapiBase?: string;
    transferFolder?: string;
}
/** 创建阿里云盘 OAuth API。 */
export declare function createAliyunDriveApi(client: Pick<VcpDeckClient, "request">): {
    verify: (signal?: AbortSignal) => Promise<AliyunDriveVerification>;
    status: (signal?: AbortSignal) => Promise<AliyunDriveStatus>;
    configure: (input: AliyunDriveConfigInput, signal?: AbortSignal) => Promise<Omit<AliyunDriveConfigInput, "clientSecret">>;
    startOAuth: (signal?: AbortSignal) => Promise<{
        state: string;
        authorizationUrl: string;
        expiresAt: number;
    }>;
    completeOAuth: (input: {
        state: string;
        code: string;
    }, signal?: AbortSignal) => Promise<{
        authorized: true;
        expiresAt: number;
    }>;
    revoke: (signal?: AbortSignal) => Promise<{
        revoked: true;
    }>;
};
