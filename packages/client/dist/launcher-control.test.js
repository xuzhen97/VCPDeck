"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const launcher_control_js_1 = require("./launcher-control.js");
function okResponse() {
    return { ok: true, status: 200, text: async () => "ok" };
}
function errResponse(status, body) {
    return { ok: false, status, text: async () => body };
}
(0, vitest_1.describe)("ClientLauncher", () => {
    let dir;
    let controlFile;
    let fetchImpl;
    let launcher;
    (0, vitest_1.beforeEach)(async () => {
        dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "client-launcher-"));
        controlFile = (0, node_path_1.join)(dir, "control.json");
        await (0, promises_1.writeFile)(controlFile, JSON.stringify({ port: 43124, token: "client-token" }));
        fetchImpl = vitest_1.vi.fn();
        launcher = new launcher_control_js_1.ClientLauncher({ controlFile, fetchImpl });
    });
    (0, vitest_1.afterEach)(async () => {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)("prepareUpdate 读 control.json 并 POST /prepare（带 token）", async () => {
        fetchImpl.mockResolvedValue(okResponse());
        await launcher.prepareUpdate({
            version: "1.2.1",
            url: "http://server/api/releases/1.2.1/file",
            sha256: "a".repeat(64),
        });
        (0, vitest_1.expect)(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:43124/prepare", vitest_1.expect.objectContaining({
            method: "POST",
            headers: vitest_1.expect.objectContaining({
                "x-launcher-token": "client-token",
            }),
            body: vitest_1.expect.stringContaining('"version":"1.2.1"'),
        }));
    });
    (0, vitest_1.it)("prepare 非 2xx 抛错并携带响应摘要", async () => {
        fetchImpl.mockResolvedValue(errResponse(500, "校验失败"));
        await (0, vitest_1.expect)(launcher.prepareUpdate({
            version: "1.2.1",
            url: "http://x",
            sha256: "a".repeat(64),
        })).rejects.toThrow("校验失败");
    });
    (0, vitest_1.it)("control.json 缺失时抛错", async () => {
        const missing = new launcher_control_js_1.ClientLauncher({
            controlFile: (0, node_path_1.join)(dir, "none.json"),
            fetchImpl,
        });
        await (0, vitest_1.expect)(missing.prepareUpdate({
            version: "1.2.1",
            url: "http://x",
            sha256: "a".repeat(64),
        })).rejects.toThrow();
        (0, vitest_1.expect)(fetchImpl).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("applyUpdate：2xx 成功", async () => {
        fetchImpl.mockResolvedValue(okResponse());
        await (0, vitest_1.expect)(launcher.applyUpdate()).resolves.toBeUndefined();
    });
    (0, vitest_1.it)("applyUpdate：连接被 launcher 掐断（进程被停）视为成功", async () => {
        fetchImpl.mockRejectedValue(new TypeError("fetch failed"));
        await (0, vitest_1.expect)(launcher.applyUpdate()).resolves.toBeUndefined();
    });
    (0, vitest_1.it)("applyUpdate：普通 fetch failed 错误也视为 launcher 已接管", async () => {
        fetchImpl.mockRejectedValue({ message: "fetch failed" });
        await (0, vitest_1.expect)(launcher.applyUpdate()).resolves.toBeUndefined();
    });
    (0, vitest_1.it)("applyUpdate：非 2xx 抛错", async () => {
        fetchImpl.mockResolvedValue(errResponse(500, "切换失败"));
        await (0, vitest_1.expect)(launcher.applyUpdate()).rejects.toThrow("切换失败");
    });
});
