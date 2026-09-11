import { type ConfigPaths } from "./config.js";
/** 环境选择来源。 */
export type EnvironmentSource = {
    type: "direct";
} | {
    type: "flag";
    name: string;
} | {
    type: "environment-variable";
    name: string;
} | {
    type: "project";
    name: string;
    path: string;
} | {
    type: "global-default";
    name: string;
    path: string;
};
/** 不含秘密值的认证摘要。 */
type ResolvedAuthSummary = {
    type: "password";
    username: string;
    credentialEnv: string;
} | {
    type: "bearer";
    credentialEnv: string;
};
/** 不含秘密值的环境解析摘要。 */
export interface ResolvedEnvironmentSummary {
    name: string | null;
    server: string;
    auth: ResolvedAuthSummary;
    source: EnvironmentSource;
}
/** 业务命令使用的环境；秘密只在本进程内存中。 */
export type ResolvedEnvironment = ResolvedEnvironmentSummary & {
    credentials?: {
        type: "password";
        username: string;
        password: string;
    } | {
        type: "bearer";
        token: string;
    };
};
/** 环境解析输入。 */
export interface ResolveEnvironmentOptions {
    environment?: string;
    server?: string;
    username?: string;
    password?: string;
    requireCredentials?: boolean;
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
}
/**
 * 解析顺序：--server 直连；否则 --env → VCPDECK_ENVIRONMENT → 最近项目配置 → 全局默认。
 * 项目配置损坏或引用不存在环境时 fail closed，不回退到全局默认。
 */
export declare function resolveEnvironment(options?: ResolveEnvironmentOptions): Promise<ResolvedEnvironment>;
/** 返回不含秘密值的多行环境摘要。 */
export declare function formatEnvironmentSummary(environment: ResolvedEnvironmentSummary): string;
export {};
