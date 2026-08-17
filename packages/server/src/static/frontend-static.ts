/**
 * Frontend 静态资源同源托管（SPA 单包交付，见 ADR-0013）：
 *  - 发布构件中 Frontend 构建产物位于 <server>/public；
 *  - monorepo 开发/构建产物回退到 packages/frontend/dist；
 *  - 找不到构建产物时 Server 仅提供 API（开发环境由 Vite 提供），不阻断启动。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";

/** 非 Frontend 前缀：REST 与 /client、/app 两个 Socket.IO 命名空间。 */
const API_PREFIX_RE = /^\/(api|client|app)(\/|$)/;

/** 静态根目录候选（按顺序取第一个含 index.html 的）。
 * 编译形态不同 __dirname 深度不同：tsc 产出 dist/static/，tsx 开发为 src/static/，
 * esbuild 单文件 bundle 为 dist/，统一用候选列表兜住。 */
export function resolveFrontendDir(): string | null {
	const candidates = [
		join(__dirname, "..", "public"), // <server>/public（bundle / 单层产物）
		join(__dirname, "..", "..", "public"), // <server>/public（tsc / tsx 静态模块）
		join(__dirname, "..", "..", "frontend", "dist"), // monorepo（bundle）
		join(__dirname, "..", "..", "..", "frontend", "dist"), // monorepo（tsc / tsx）
	];
	return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

/**
 * SPA 回退中间件：非 /api /client /app 前缀的 HTML GET/HEAD 请求返回
 * index.html（react-router 前端路由）；其余请求交给下一处理器，
 * 保持 REST 404 JSON 与 Socket.IO 行为不变。
 */
export function createFrontendFallback(publicDir: string) {
	const indexHtml = join(publicDir, "index.html");
	return (req: Request, res: Response, next: NextFunction): void => {
		if (req.method !== "GET" && req.method !== "HEAD") return next();
		if (!req.accepts("html")) return next();
		if (API_PREFIX_RE.test(req.path)) return next();
		res.sendFile(indexHtml);
	};
}
