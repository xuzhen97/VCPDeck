import type { NextFunction, Request, Response } from "express";
/** 静态根目录候选（按顺序取第一个含 index.html 的）。
 * 编译形态不同 __dirname 深度不同：tsc 产出 dist/static/，tsx 开发为 src/static/，
 * esbuild 单文件 bundle 为 dist/，统一用候选列表兜住。 */
export declare function resolveFrontendDir(): string | null;
/**
 * SPA 回退中间件：非 /api /client /app 前缀的 HTML GET/HEAD 请求返回
 * index.html（react-router 前端路由）；其余请求交给下一处理器，
 * 保持 REST 404 JSON 与 Socket.IO 行为不变。
 */
export declare function createFrontendFallback(publicDir: string): (req: Request, res: Response, next: NextFunction) => void;
