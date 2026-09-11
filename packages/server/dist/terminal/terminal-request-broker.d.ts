import type { TerminalClientRequest, TerminalClientResponse } from "@vcpdeck/shared";
export declare const TERMINAL_REQUEST_TIMEOUT_MS = 15000;
export interface TerminalLease {
    clientId: string;
    socketId: string;
}
/**
 * 终端请求代理：把 REST/浏览器请求通过 Socket.IO 发到目标 Client，以 requestId 关联响应。
 * - 不记录 request payload 正文；
 * - socket 断线时只失败该连接的 pending；
 * - 只接受来自原 lease socket 的响应（防串线）；
 * - 未绑定 emitter 视为 Client 离线。
 */
export declare class TerminalRequestBroker {
    private emitter;
    private readonly pending;
    /** Gateway afterInit 时绑定 emitter（避免循环依赖）。 */
    bindEmitter(fn: (socketId: string, request: TerminalClientRequest) => void): void;
    request(lease: TerminalLease, request: TerminalClientRequest, timeoutMs?: number): Promise<TerminalClientResponse>;
    /** Client 响应：校验来源 socketId 后 resolve（响应正文校验由上层负责）。 */
    resolve(socketId: string, response: TerminalClientResponse): void;
    /** socket 断线：只失败该连接的 pending request。 */
    disconnect(socketId: string): void;
}
