import type { ConfigPaths } from "./config.js";
/** Storage 命令运行时依赖，测试可注入。 */
export interface StorageCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}
/** 执行 Storage 命令组（当前只读）。 */
export declare function runStorageCommand(subcommand: string | undefined, argv: string[], context?: StorageCommandContext): Promise<void>;
