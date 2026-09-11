import type { JobInfo } from "@vcpdeck/shared";
import { type VcpDeckClient } from "@vcpdeck/sdk";
import type { ConfigPaths } from "./config.js";
/** Jobs 命令运行时依赖，测试可注入。 */
export interface JobsCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    error?: (message: string) => void;
    /** 终态轮询间隔；测试可缩短。 */
    pollIntervalMs?: number;
}
/** 执行 Jobs 命令组（list/get 只读；run/cancel 为写操作）。 */
export declare function runJobsCommand(subcommand: string | undefined, argv: string[], context?: JobsCommandContext): Promise<void>;
/** 轮询 Job 直到终态或超时；仅重试安全 GET，容忍 Server 重启短暂不可达。 */
export declare function waitForTerminalJob(client: VcpDeckClient, jobId: string, timeoutSeconds: number, log: (message: string) => void, pollIntervalMs: number): Promise<JobInfo>;
