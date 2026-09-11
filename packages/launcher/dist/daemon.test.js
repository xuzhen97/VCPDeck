"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const daemon_js_1 = require("./daemon.js");
const daemon_js_2 = require("./daemon.js");
const tempDirs = [];
async function tempZipPath() {
    const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "launcher-download-"));
    tempDirs.push(dir);
    return (0, node_path_1.join)(dir, "x.zip");
}
(0, vitest_1.describe)("Daemon 版本保留生命周期", () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    function makeRetention() {
        return {
            initialize: vitest_1.vi.fn().mockResolvedValue(undefined),
            recordSuccessful: vitest_1.vi.fn().mockResolvedValue(true),
            cleanup: vitest_1.vi.fn().mockResolvedValue({
                removed: [],
                failed: [],
                disabled: false,
            }),
        };
    }
    function internals(daemon) {
        return daemon;
    }
    (0, vitest_1.it)("启动 current 后初始化，并在稳定延时后执行补扫", async () => {
        vitest_1.vi.useFakeTimers();
        const retention = makeRetention();
        const daemon = new daemon_js_1.Daemon({
            appDir: "/tmp/vcpdeck-launcher-test",
            artifact: "client",
            retention,
        });
        const methods = internals(daemon);
        await methods.initializeRetention();
        methods.scheduleRetentionStartupCleanup();
        await vitest_1.vi.advanceTimersByTimeAsync(29_999);
        (0, vitest_1.expect)(retention.cleanup).not.toHaveBeenCalled();
        await vitest_1.vi.advanceTimersByTimeAsync(1);
        (0, vitest_1.expect)(retention.cleanup).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(retention.cleanup).toHaveBeenCalledWith(undefined);
    });
    (0, vitest_1.it)("启动补扫执行时保护尚未 apply 的 pending target", async () => {
        vitest_1.vi.useFakeTimers();
        const retention = makeRetention();
        const daemon = new daemon_js_1.Daemon({
            appDir: "/tmp/vcpdeck-launcher-test",
            artifact: "client",
            retention,
        });
        const methods = internals(daemon);
        methods.pendingVersion = "1.3.0";
        methods.scheduleRetentionStartupCleanup();
        await vitest_1.vi.advanceTimersByTimeAsync(30_000);
        (0, vitest_1.expect)(retention.cleanup).toHaveBeenCalledWith(new Set(["1.3.0"]));
    });
    (0, vitest_1.it)("成功 apply 记录 target，并保护 target 与 previous", async () => {
        const retention = makeRetention();
        const daemon = new daemon_js_1.Daemon({
            appDir: "/tmp/vcpdeck-launcher-test",
            artifact: "client",
            retention,
        });
        await internals(daemon).onSuccessfulApply("1.3.0", "1.2.0");
        (0, vitest_1.expect)(retention.recordSuccessful).toHaveBeenCalledWith("1.3.0");
        (0, vitest_1.expect)(retention.cleanup).toHaveBeenCalledWith(new Set(["1.3.0", "1.2.0"]));
    });
    (0, vitest_1.it)("shutdown 前取消尚未执行的启动补扫", async () => {
        vitest_1.vi.useFakeTimers();
        const retention = makeRetention();
        const daemon = new daemon_js_1.Daemon({
            appDir: "/tmp/vcpdeck-launcher-test",
            artifact: "client",
            retention,
        });
        const methods = internals(daemon);
        methods.scheduleRetentionStartupCleanup();
        methods.cancelRetentionStartupCleanup();
        await vitest_1.vi.advanceTimersByTimeAsync(30_000);
        (0, vitest_1.expect)(retention.cleanup).not.toHaveBeenCalled();
    });
});
(0, vitest_1.describe)("downloadWithRetry", () => {
    (0, vitest_1.afterEach)(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => (0, promises_1.rm)(dir, { recursive: true, force: true })));
    });
    (0, vitest_1.it)("下载收到 502 后重新请求更新入口并成功", async () => {
        const fetchImpl = vitest_1.vi
            .fn()
            .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
            .mockResolvedValueOnce(new Response("zip", { status: 200 }));
        const dest = await tempZipPath();
        await (0, daemon_js_2.downloadWithRetry)("http://server/api/releases/1.2.1/file", dest, fetchImpl, async () => { });
        (0, vitest_1.expect)(fetchImpl).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(await (0, promises_1.readFile)(dest, "utf8")).toBe("zip");
    });
    (0, vitest_1.it)("下载网络异常后重试并成功", async () => {
        const fetchImpl = vitest_1.vi
            .fn()
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValueOnce(new Response("zip", { status: 200 }));
        const dest = await tempZipPath();
        await (0, daemon_js_2.downloadWithRetry)("http://server/api/releases/1.2.1/file", dest, fetchImpl, async () => { });
        (0, vitest_1.expect)(fetchImpl).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(await (0, promises_1.readFile)(dest, "utf8")).toBe("zip");
    });
    (0, vitest_1.it)("下载收到 404 不重试", async () => {
        const fetchImpl = vitest_1.vi
            .fn()
            .mockResolvedValue(new Response("missing", { status: 404 }));
        const dest = await tempZipPath();
        await (0, vitest_1.expect)((0, daemon_js_2.downloadWithRetry)("http://server/api/releases/1.2.1/file", dest, fetchImpl, async () => { })).rejects.toThrow("HTTP 404");
        (0, vitest_1.expect)(fetchImpl).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("连续网络异常达到三次上限后失败", async () => {
        const fetchImpl = vitest_1.vi.fn().mockRejectedValue(new TypeError("fetch failed"));
        const dest = await tempZipPath();
        await (0, vitest_1.expect)((0, daemon_js_2.downloadWithRetry)("http://server/api/releases/1.2.1/file", dest, fetchImpl, async () => { })).rejects.toThrow("下载失败: 网络错误");
        (0, vitest_1.expect)(fetchImpl).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)("成功响应写盘失败时不重试", async () => {
        const fetchImpl = vitest_1.vi.fn().mockResolvedValue(new Response("zip", { status: 200 }));
        const dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "launcher-download-"));
        tempDirs.push(dir);
        const dest = (0, node_path_1.join)(dir, "missing", "x.zip");
        await (0, vitest_1.expect)((0, daemon_js_2.downloadWithRetry)("http://server/api/releases/1.2.1/file", dest, fetchImpl, async () => { })).rejects.toThrow();
        (0, vitest_1.expect)(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
