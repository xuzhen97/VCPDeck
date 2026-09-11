import type { ConfigPaths } from "./config.js";
/** Pi 命令运行时依赖，测试可注入。 */
export interface PiCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    /** 警告/错误输出；测试可注入（默认 console.error）。 */
    error?: (message: string) => void;
    /** 运行状态轮询间隔；测试可缩短。 */
    pollIntervalMs?: number;
    /** REPL 输入流；测试可注入（默认 process.stdin）。 */
    input?: NodeJS.ReadableStream;
    /** REPL 输出流；测试可注入（默认 process.stdout）。 */
    output?: NodeJS.WritableStream;
}
/** 执行 Pi 命令组（models/sessions/new 只读；run/abort 驱动远端 Agent）。 */
export declare function runPiCommand(subcommand: string | undefined, argv: string[], context?: PiCommandContext): Promise<void>;
