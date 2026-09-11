import type { ConfigPaths } from "./config.js";
/** FRP 命令运行时依赖，测试可注入。 */
export interface FrpCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    /** Job 轮询间隔；测试可缩短。 */
    pollIntervalMs?: number;
}
/** 执行 FRP 命令组（当前只读）。 */
export declare function runFrpCommand(subcommand: string | undefined, argv: string[], context?: FrpCommandContext): Promise<void>;
