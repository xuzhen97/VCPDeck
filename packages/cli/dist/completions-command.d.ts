import type { ConfigPaths } from "./config.js";
/** 补全命令运行时依赖，测试可注入。 */
export interface CompletionsCommandContext {
    log?: (message: string) => void;
    paths?: ConfigPaths;
}
/** 执行 completions 命令组：bash/powershell 两种 flavor。 */
export declare function runCompletionsCommand(subcommand: string | undefined, context?: CompletionsCommandContext): Promise<void>;
