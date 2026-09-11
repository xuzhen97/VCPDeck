import type { ConfigPaths } from "./config.js";
/** Files 命令运行时依赖，测试可注入。 */
export interface FilesCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    /** 终态轮询间隔；测试可缩短。 */
    pollIntervalMs?: number;
    /** 分片直传 Provider 与签名 URL 拉取时使用；测试可注入。 */
    directFetch?: typeof globalThis.fetch;
}
/** 执行 Files 命令组（当前只读：roots/list/stat/read）。 */
export declare function runFilesCommand(subcommand: string | undefined, argv: string[], context?: FilesCommandContext): Promise<void>;
