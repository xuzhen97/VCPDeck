import type { Socket } from "socket.io-client";
/** 路径安全校验 + 规范化 */
export declare function resolveSafePath(rootDir: string, userPath: string): Promise<string>;
/** 处理轻量 fs 操作 */
export declare function handleFileOp(job: {
    jobId: string;
    type: string;
    payload: Record<string, unknown>;
    timeout?: number;
}, socket: Socket): Promise<void>;
