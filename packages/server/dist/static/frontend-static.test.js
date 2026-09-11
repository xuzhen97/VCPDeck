"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_path_1 = require("node:path");
const frontend_static_js_1 = require("./frontend-static.js");
/** 造一个最小请求/响应；sendFile 用 vi.fn 接管。 */
function run(req) {
    const res = { sendFile: vitest_1.vi.fn() };
    const next = vitest_1.vi.fn();
    (0, frontend_static_js_1.createFrontendFallback)("C:/vcpdeck/public")(req, res, next);
    return { sendFile: res.sendFile, next };
}
(0, vitest_1.describe)("createFrontendFallback", () => {
    (0, vitest_1.it)("HTML GET 根路径回退到 index.html", () => {
        const { sendFile, next } = run({
            method: "GET",
            path: "/",
            accepts: () => "html",
        });
        (0, vitest_1.expect)(sendFile).toHaveBeenCalledWith((0, node_path_1.join)("C:/vcpdeck/public", "index.html"));
        (0, vitest_1.expect)(next).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("HTML GET 前端路由（SPA history 模式）回退到 index.html", () => {
        const { sendFile } = run({
            method: "GET",
            path: "/clients/node-1",
            accepts: () => "html",
        });
        (0, vitest_1.expect)(sendFile).toHaveBeenCalledTimes(1);
    });
    vitest_1.it.each([["/api/status"], ["/client/?EIO=4&transport=polling"], ["/app/?EIO=4"]])("%s 不拦截，交给下一处理器", (path) => {
        const { sendFile, next } = run({
            method: "GET",
            path,
            accepts: () => "html",
        });
        (0, vitest_1.expect)(sendFile).not.toHaveBeenCalled();
        (0, vitest_1.expect)(next).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("非 HTML 请求（静态资源）不拦截", () => {
        const { sendFile, next } = run({
            method: "GET",
            path: "/assets/index-abc123.js",
            accepts: () => false,
        });
        (0, vitest_1.expect)(sendFile).not.toHaveBeenCalled();
        (0, vitest_1.expect)(next).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("非 GET/HEAD 请求不拦截", () => {
        const { sendFile, next } = run({
            method: "POST",
            path: "/api/jobs",
            accepts: () => "html",
        });
        (0, vitest_1.expect)(sendFile).not.toHaveBeenCalled();
        (0, vitest_1.expect)(next).toHaveBeenCalledTimes(1);
    });
});
