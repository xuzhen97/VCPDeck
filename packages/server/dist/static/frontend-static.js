"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveFrontendDir = resolveFrontendDir;
exports.createFrontendFallback = createFrontendFallback;
/**
 * Frontend 静态资源同源托管（SPA 单包交付，见 ADR-0013）：
 *  - 发布构件中 Frontend 构建产物位于 <server>/public；
 *  - monorepo 开发/构建产物回退到 packages/frontend/dist；
 *  - 找不到构建产物时 Server 仅提供 API（开发环境由 Vite 提供），不阻断启动。
 */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/** 非 Frontend 前缀：REST 与 /client、/app 两个 Socket.IO 命名空间。 */
const API_PREFIX_RE = /^\/(api|client|app)(\/|$)/;
/** 静态根目录候选（按顺序取第一个含 index.html 的）。
 * 编译形态不同 __dirname 深度不同：tsc 产出 dist/static/，tsx 开发为 src/static/，
 * esbuild 单文件 bundle 为 dist/，统一用候选列表兜住。 */
function resolveFrontendDir() {
    const candidates = [
        (0, node_path_1.join)(__dirname, "..", "public"), // <server>/public（bundle / 单层产物）
        (0, node_path_1.join)(__dirname, "..", "..", "public"), // <server>/public（tsc / tsx 静态模块）
        (0, node_path_1.join)(__dirname, "..", "..", "frontend", "dist"), // monorepo（bundle）
        (0, node_path_1.join)(__dirname, "..", "..", "..", "frontend", "dist"), // monorepo（tsc / tsx）
    ];
    return candidates.find((dir) => (0, node_fs_1.existsSync)((0, node_path_1.join)(dir, "index.html"))) ?? null;
}
/**
 * SPA 回退中间件：非 /api /client /app 前缀的 HTML GET/HEAD 请求返回
 * index.html（react-router 前端路由）；其余请求交给下一处理器，
 * 保持 REST 404 JSON 与 Socket.IO 行为不变。
 */
function createFrontendFallback(publicDir) {
    const indexHtml = (0, node_path_1.join)(publicDir, "index.html");
    return (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
            next();
            return;
        }
        if (!req.accepts("html")) {
            next();
            return;
        }
        if (API_PREFIX_RE.test(req.path)) {
            next();
            return;
        }
        res.sendFile(indexHtml);
    };
}
