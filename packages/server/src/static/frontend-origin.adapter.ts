/**
 * socket.io 同源 CORS 适配器（ADR-0013）：
 * Nest 的 namespace 级 cors 装饰器在 Engine 层只会取第一个网关的配置，
 * 同源单包模式下（页面与 API 同源 :3001，Origin 为 http://<host>:3001）
 * /app 会被 CORS 拒绝。本适配器把 socket.io Server 级 cors 改为函数形式，
 * 在每个 Engine 请求上拿到完整 req，判定委托给 trusted-origins 的唯一策略：
 * 无 Origin（Node/CLI 客户端）、显式配置跨源或同源放行，其余跨源被拒绝
 * （/app 走 Cookie 会话，防 CSWSH）。
 */
import { IoAdapter } from "@nestjs/platform-socket.io";
import type { Server, ServerOptions } from "socket.io";
import {
	type CorsRequest,
	firstHeaderValue,
	isTrustedOrigin,
} from "../auth/trusted-origins.js";

export class FrontendOriginIoAdapter extends IoAdapter {
	createIOServer(port: number, options?: ServerOptions): Server {
		const existingCors = (options?.cors ?? {}) as Record<string, unknown>;
		const nextOptions = {
			...options,
			cors: (
				req: CorsRequest,
				cb: (err: Error | null, cors?: unknown) => void,
			) => {
				const origin = firstHeaderValue(req.headers?.origin);
				cb(null, {
					...existingCors,
					origin: isTrustedOrigin(req.headers?.origin, req)
						? (origin ?? true)
						: false,
					credentials: true,
				});
			},
		};
		return super.createIOServer(port, nextOptions);
	}
}
