"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const control_js_1 = require("./control.js");
function makeHandlers() {
    return {
        prepare: vitest_1.vi.fn(),
        apply: vitest_1.vi.fn(),
    };
}
/** 测试辅助：读 control.json（带错误包装，满足静态检查） */
async function readControlFile(path) {
    try {
        return JSON.parse(await (0, promises_1.readFile)(path, "utf-8"));
    }
    catch (e) {
        throw new Error(`读 control.json 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
}
/** 测试辅助：向控制通道发 POST（带错误包装，满足静态检查） */
async function post(port, path, token, body) {
    try {
        return await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-launcher-token": token,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }
    catch (e) {
        throw new Error(`控制通道请求失败: ${e instanceof Error ? e.message : String(e)}`);
    }
}
(0, vitest_1.describe)("createControlServer", () => {
    let dir;
    let controlFile;
    let server;
    (0, vitest_1.beforeEach)(async () => {
        dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "control-"));
        controlFile = (0, node_path_1.join)(dir, "control.json");
    });
    (0, vitest_1.afterEach)(async () => {
        await server?.close().catch(() => undefined);
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)("启动后写 control.json（port/token/pid），并响应 /prepare", async () => {
        const handlers = makeHandlers();
        handlers.prepare.mockResolvedValue(undefined);
        server = await (0, control_js_1.createControlServer)({ handlers, controlFile });
        const control = await readControlFile(controlFile);
        (0, vitest_1.expect)(control).toMatchObject({
            port: vitest_1.expect.any(Number),
            token: vitest_1.expect.any(String),
            pid: vitest_1.expect.any(Number),
        });
        const res = await post(control.port, "/prepare", control.token, {
            version: "1.2.1",
            url: "/api/releases/1.2.1/file",
            sha256: "a".repeat(64),
        });
        (0, vitest_1.expect)(res.status).toBe(200);
        (0, vitest_1.expect)(handlers.prepare).toHaveBeenCalledWith({
            version: "1.2.1",
            url: "/api/releases/1.2.1/file",
            sha256: "a".repeat(64),
        });
    });
    (0, vitest_1.it)("token 错误返回 401，不调用 handler", async () => {
        const handlers = makeHandlers();
        server = await (0, control_js_1.createControlServer)({ handlers, controlFile });
        const control = await readControlFile(controlFile);
        const res = await post(control.port, "/prepare", "wrong-token", {});
        (0, vitest_1.expect)(res.status).toBe(401);
        (0, vitest_1.expect)(handlers.prepare).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("handler 抛错返回 500（安全 message）", async () => {
        const handlers = makeHandlers();
        handlers.prepare.mockRejectedValue(new Error("下载失败"));
        server = await (0, control_js_1.createControlServer)({ handlers, controlFile });
        const control = await readControlFile(controlFile);
        const res = await post(control.port, "/prepare", control.token, {
            version: "1.2.1",
            url: "/x",
            sha256: "a".repeat(64),
        });
        (0, vitest_1.expect)(res.status).toBe(500);
        (0, vitest_1.expect)(await res.text()).toContain("下载失败");
    });
    (0, vitest_1.it)("/apply 调用 handler；未知路径 404", async () => {
        const handlers = makeHandlers();
        handlers.apply.mockResolvedValue(undefined);
        server = await (0, control_js_1.createControlServer)({ handlers, controlFile });
        const control = await readControlFile(controlFile);
        const applyRes = await post(control.port, "/apply", control.token);
        (0, vitest_1.expect)(applyRes.status).toBe(200);
        (0, vitest_1.expect)(handlers.apply).toHaveBeenCalledTimes(1);
        const missRes = await post(control.port, "/nope", control.token);
        (0, vitest_1.expect)(missRes.status).toBe(404);
    });
});
(0, vitest_1.describe)("runPreStart", () => {
    (0, vitest_1.it)("无命令 → 直接跳过", async () => {
        const execImpl = vitest_1.vi.fn();
        await (0, control_js_1.runPreStart)(undefined, "/apps/1.2.1/server", execImpl);
        (0, vitest_1.expect)(execImpl).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("有命令 → 在构件目录以 shell 执行", async () => {
        const execImpl = vitest_1.vi.fn().mockResolvedValue({ stdout: "" });
        await (0, control_js_1.runPreStart)("prisma db push", "/apps/1.2.1/server", execImpl);
        (0, vitest_1.expect)(execImpl).toHaveBeenCalledWith("prisma db push", {
            cwd: "/apps/1.2.1/server",
            shell: true,
            timeout: 120_000,
        });
    });
    (0, vitest_1.it)("执行失败 → 抛错（含命令摘要）", async () => {
        const execImpl = vitest_1.vi.fn().mockRejectedValue(new Error("boom"));
        await (0, vitest_1.expect)((0, control_js_1.runPreStart)("prisma db push", "/apps/1.2.1/server", execImpl)).rejects.toThrow("preStart 失败");
    });
});
