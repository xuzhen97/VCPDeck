import type { ConfigPaths } from "./config.js";
export interface ReleaseCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    pollIntervalMs?: number;
    requestTimeoutMs?: number;
    /** Release 直传 Provider 时使用；测试可注入。 */
    directFetch?: typeof globalThis.fetch;
    /** 分片重试退避；测试可缩短。 */
    directRetryDelayMs?: number;
}
/** 执行 Release 命令组。 */
export declare function runReleaseCommand(subcommand: string | undefined, argv: string[], context?: ReleaseCommandContext): Promise<void>;
