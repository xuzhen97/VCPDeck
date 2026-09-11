import type { ConfigPaths } from "./config.js";
/** attach 数据面 socket 的最小接口；测试可注入替身。 */
export interface AttachSocket {
    on(event: string, listener: (payload: unknown) => void): void;
    emit(event: string, payload?: unknown, ack?: (response: unknown) => void): void;
    disconnect(): void;
}
export type SocketFactory = (url: string, auth: Record<string, unknown>) => AttachSocket;
/** Terminal 命令运行时依赖，测试可注入。 */
export interface TerminalCommandContext {
    paths?: ConfigPaths;
    processEnv?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    /** attach 数据面 socket 工厂与终端流；测试可注入。 */
    socketFactory?: SocketFactory;
    input?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream & {
        columns?: number;
        rows?: number;
    };
}
/** 执行 Terminal 命令组：shells/list 只读；close 写操作。 */
export declare function runTerminalCommand(subcommand: string | undefined, argv: string[], context?: TerminalCommandContext): Promise<void>;
/** 重连令牌本地存储路径（与全局配置同目录）。 */
export declare function reconnectStorePath(context: TerminalCommandContext): string;
/** 读取会话重连令牌；文件缺失或损坏时返回 undefined。 */
export declare function loadReconnectToken(storePath: string, sessionId: string): Promise<string | undefined>;
/** 保存/更新会话重连令牌。 */
export declare function saveReconnectToken(storePath: string, sessionId: string, token: string): Promise<void>;
/** 会话结束后移除重连令牌。 */
export declare function removeReconnectToken(storePath: string, sessionId: string): Promise<void>;
