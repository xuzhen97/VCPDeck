"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FrontendOriginIoAdapter = void 0;
exports.isFrontendOriginAllowed = isFrontendOriginAllowed;
/**
 * socket.io 同源 CORS 适配器（ADR-0013）：
 * Nest 的 namespace 级 cors 装饰器在 Engine 层只会取第一个网关的配置，
 * 同源单包模式下（页面与 API 同源 :3001，Origin 为 http://<host>:3001）
 * /app 会被 CORS 拒绝。本适配器把 socket.io Server 级 cors 改为函数形式，
 * 在每个 Engine 请求上拿到完整 req，实现「无 Origin（Node/CLI 客户端）、
 * 显式配置跨源或同源」放行，其余跨源被拒绝（/app 走 Cookie 会话，防 CSWSH）。
 */
const platform_socket_io_1 = require("@nestjs/platform-socket.io");
const FRONTEND_ORIGIN = process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";
const CORS_ORIGIN = process.env.VCPDECK_CORS_ORIGIN || "http://localhost:5173";
function firstHeader(value) {
    return Array.isArray(value) ? value[0] : value;
}
/** Engine 请求 cors 判定：无 Origin（非浏览器）、显式配置跨源或同源放行。 */
function isFrontendOriginAllowed(rawOrigin, req) {
    const origin = firstHeader(rawOrigin);
    if (!origin)
        return true; // 非浏览器客户端（Client SDK / CLI token）
    if (origin === FRONTEND_ORIGIN || origin === CORS_ORIGIN)
        return true;
    const host = firstHeader(req.headers?.host);
    const scheme = req.connection?.encrypted ? "https" : "http";
    // 同源：页面由本 Server 提供（浏览器只会在真实访问本 Server 时发这个 Origin）
    return typeof host === "string" && origin === `${scheme}://${host}`;
}
class FrontendOriginIoAdapter extends platform_socket_io_1.IoAdapter {
    createIOServer(port, options) {
        const existingCors = (options?.cors ?? {});
        const nextOptions = {
            ...options,
            cors: (req, cb) => {
                const origin = firstHeader(req.headers?.origin);
                cb(null, {
                    ...existingCors,
                    origin: isFrontendOriginAllowed(req.headers?.origin, req)
                        ? (origin ?? true)
                        : false,
                    credentials: true,
                });
            },
        };
        return super.createIOServer(port, nextOptions);
    }
}
exports.FrontendOriginIoAdapter = FrontendOriginIoAdapter;
