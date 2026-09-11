/**
 * socket.io 同源 CORS 适配器（ADR-0013）：
 * Nest 的 namespace 级 cors 装饰器在 Engine 层只会取第一个网关的配置，
 * 同源单包模式下（页面与 API 同源 :3001，Origin 为 http://<host>:3001）
 * /app 会被 CORS 拒绝。本适配器把 socket.io Server 级 cors 改为函数形式，
 * 在每个 Engine 请求上拿到完整 req，实现「无 Origin（Node/CLI 客户端）、
 * 显式配置跨源或同源」放行，其余跨源被拒绝（/app 走 Cookie 会话，防 CSWSH）。
 */
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { Server, ServerOptions } from "socket.io";
/** 兼容 cors 包 origin 回调与 Node IncomingMessage 的最小请求形状。 */
export interface CorsRequest {
    headers?: Record<string, string | string[] | undefined>;
    connection?: {
        encrypted?: boolean;
    };
}
/** Engine 请求 cors 判定：无 Origin（非浏览器）、显式配置跨源或同源放行。 */
export declare function isFrontendOriginAllowed(rawOrigin: string | string[] | undefined, req: CorsRequest): boolean;
export declare class FrontendOriginIoAdapter extends IoAdapter {
    createIOServer(port: number, options?: ServerOptions): Server;
}
