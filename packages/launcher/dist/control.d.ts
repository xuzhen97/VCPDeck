import { execFile } from "node:child_process";
declare const execFileAsync: typeof execFile.__promisify__;
export interface ControlHandlers {
    prepare(input: {
        version: string;
        url: string;
        sha256: string;
    }): Promise<void>;
    apply(): Promise<void>;
}
export interface ControlServerOptions {
    handlers: ControlHandlers;
    /** control.json 路径 */
    controlFile: string;
    token?: string;
    log?: (msg: string) => void;
}
export interface ControlServerHandle {
    port: number;
    token: string;
    close(): Promise<void>;
}
/** 启动控制通道 HTTP 服务并写 control.json */
export declare function createControlServer(options: ControlServerOptions): Promise<ControlServerHandle>;
/**
 * preStart 钩子：切换版本前在构件目录执行（如 prisma db push）。
 * 命令为空时跳过；失败抛错（含命令摘要，不含输出细节）。
 */
export declare function runPreStart(cmd: string | undefined, cwd: string, execImpl?: typeof execFileAsync): Promise<void>;
export {};
