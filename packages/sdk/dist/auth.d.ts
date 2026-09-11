import type { CreateIdentityRequest, CreateTokenRequest, CreateTokenResponse, IdentityInfo, LoginRequest, LoginResponse, TokenInfo, UpdateMeRequest } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
/** Node.js 登录后可显式携带的 Cookie 会话。 */
export interface LoginSession {
    login: LoginResponse;
    cookie: string;
}
/** 创建认证与个人凭证 API。 */
export declare function createAuthApi(client: Pick<VcpDeckClient, "request" | "requestRaw">): {
    login: (input: LoginRequest, signal?: AbortSignal) => Promise<LoginResponse>;
    /** 登录并提取 Cookie；仅供不会自动维护 Cookie 的 Node.js 调用方。 */
    loginSession: (input: LoginRequest, signal?: AbortSignal) => Promise<LoginSession>;
    logout: (signal?: AbortSignal) => Promise<{
        ok: true;
    }>;
    me: (signal?: AbortSignal) => Promise<IdentityInfo>;
    updateMe: (input: UpdateMeRequest, signal?: AbortSignal) => Promise<{
        ok: true;
    }>;
    tokens: {
        list: (signal?: AbortSignal) => Promise<TokenInfo[]>;
        create: (input: CreateTokenRequest, signal?: AbortSignal) => Promise<CreateTokenResponse>;
        revoke: (id: string, signal?: AbortSignal) => Promise<{
            ok: true;
        }>;
    };
};
/** 创建管理员身份 API。 */
export declare function createIdentitiesApi(client: Pick<VcpDeckClient, "request">): {
    list: (signal?: AbortSignal) => Promise<IdentityInfo[]>;
    create: (input: CreateIdentityRequest, signal?: AbortSignal) => Promise<IdentityInfo>;
    disable: (id: string, signal?: AbortSignal) => Promise<{
        ok: true;
    }>;
    enable: (id: string, signal?: AbortSignal) => Promise<{
        ok: true;
    }>;
};
