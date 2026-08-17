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

const FRONTEND_ORIGIN =
	process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";
const CORS_ORIGIN = process.env.VCPDECK_CORS_ORIGIN || "http://localhost:5173";

/** 兼容 cors 包 origin 回调与 Node IncomingMessage 的最小请求形状。 */
export interface CorsRequest {
	headers?: Record<string, string | string[] | undefined>;
	connection?: { encrypted?: boolean };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/** Engine 请求 cors 判定：无 Origin（非浏览器）、显式配置跨源或同源放行。 */
export function isFrontendOriginAllowed(
	rawOrigin: string | string[] | undefined,
	req: CorsRequest,
): boolean {
	const origin = firstHeader(rawOrigin);
	if (!origin) return true; // 非浏览器客户端（Client SDK / CLI token）
	if (origin === FRONTEND_ORIGIN || origin === CORS_ORIGIN) return true;
	const host = firstHeader(req.headers?.host);
	const scheme = req.connection?.encrypted ? "https" : "http";
	// 同源：页面由本 Server 提供（浏览器只会在真实访问本 Server 时发这个 Origin）
	return typeof host === "string" && origin === `${scheme}://${host}`;
}

export class FrontendOriginIoAdapter extends IoAdapter {
	createIOServer(port: number, options?: ServerOptions): Server {
		const existingCors = (options?.cors ?? {}) as Record<string, unknown>;
		const nextOptions = {
			...options,
			cors: (
				req: CorsRequest,
				cb: (err: Error | null, cors?: unknown) => void,
			) => {
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
