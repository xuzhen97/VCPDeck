import { type ConfigPaths } from "./config.js";
export interface EnvCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}
/** 执行环境配置命令。 */
export declare function runEnvCommand(subcommand: string | undefined, argv: string[], context?: EnvCommandContext): Promise<void>;
