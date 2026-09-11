import type { ConfigPaths } from "./config.js";
/** Clients 命令运行时依赖，测试可注入。 */
export interface ClientsCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}
/** 执行 Clients 命令组（当前只读）。 */
export declare function runClientsCommand(subcommand: string | undefined, argv: string[], context?: ClientsCommandContext): Promise<void>;
