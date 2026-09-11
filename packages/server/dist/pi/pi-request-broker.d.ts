import type { PiRequest, PiResponse } from "@vcpdeck/shared";
export declare const PI_REQUEST_TIMEOUT_MS = 15000;
export interface PiGenerationLease {
    clientId: string;
    socketId: string;
}
/**
 * Pi 请求代理：把 REST 请求通过 Socket.IO 发到目标 Client，以 requestId 关联响应。
 * - 不记录 request payload 正文；
 * - socket 断线时只失败该连接的 pending；
 * - 只接受来自原 lease socket 的响应（防串线）。
 */
export declare class PiRequestBroker {
    private emitter;
    private readonly pending;
    /** Gateway afterInit 时绑定 emitter（避免循环依赖） */
    bindEmitter(fn: (socketId: string, request: PiRequest) => void): void;
    request(lease: PiGenerationLease, request: PiRequest, timeoutMs?: number): Promise<PiResponse>;
    /** Client 响应：校验来源 socketId 后 resolve */
    resolve(socketId: string, response: PiResponse): void;
    /** socket 断线：只失败该连接的 pending request */
    disconnect(socketId: string): void;
}
