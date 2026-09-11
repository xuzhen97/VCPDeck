"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const updater_js_1 = require("./updater.js");
function makeDeps(overrides = {}) {
    return {
        versions: {
            exists: vitest_1.vi.fn().mockReturnValue(false),
            isPrepared: vitest_1.vi.fn().mockResolvedValue(false),
            removeVersion: vitest_1.vi.fn(),
            currentVersion: vitest_1.vi.fn(),
            switchTo: vitest_1.vi.fn(),
            versionDir: vitest_1.vi.fn((v) => `/apps/${v}`),
        },
        downloadZip: vitest_1.vi.fn(),
        verifySha256: vitest_1.vi.fn(),
        extractZip: vitest_1.vi.fn(),
        stopProcess: vitest_1.vi.fn(),
        startProcess: vitest_1.vi.fn(),
        probe: vitest_1.vi.fn(),
        onSuccessfulApply: vitest_1.vi.fn(async () => undefined),
        probeRetries: 3,
        artifact: "server",
        probeIntervalMs: 100,
        ...overrides,
    };
}
(0, vitest_1.describe)("Updater", () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.describe)("prepare", () => {
        (0, vitest_1.it)("下载 → 校验 → 解压 按序执行", async () => {
            const deps = makeDeps();
            deps.verifySha256.mockResolvedValue(true);
            const updater = new updater_js_1.Updater(deps);
            await updater.prepare({
                url: "http://server/api/releases/1.2.1/file",
                sha256: "a".repeat(64),
                version: "1.2.1",
            });
            (0, vitest_1.expect)(deps.downloadZip).toHaveBeenCalledWith("http://server/api/releases/1.2.1/file", vitest_1.expect.stringContaining("1.2.1"));
            (0, vitest_1.expect)(deps.extractZip).toHaveBeenCalledWith(vitest_1.expect.any(String), "/apps/1.2.1");
            // 顺序：下载先于校验，校验先于解压
            const order = [
                deps.downloadZip.mock.invocationCallOrder[0],
                deps.verifySha256.mock.invocationCallOrder[0],
                deps.extractZip.mock.invocationCallOrder[0],
            ];
            (0, vitest_1.expect)(order).toEqual([...order].sort((a, b) => a - b));
        });
        (0, vitest_1.it)("只有 Launcher payload 的版本目录不得幂等跳过", async () => {
            const deps = makeDeps();
            deps.versions.isPrepared.mockResolvedValue(false);
            deps.verifySha256.mockResolvedValue(true);
            const updater = new updater_js_1.Updater(deps);
            await updater.prepare({
                url: "http://server/release.zip",
                sha256: "a".repeat(64),
                version: "1.2.1",
            });
            (0, vitest_1.expect)(deps.versions.removeVersion).toHaveBeenCalledWith("1.2.1");
            (0, vitest_1.expect)(deps.downloadZip).toHaveBeenCalled();
            (0, vitest_1.expect)(deps.extractZip).toHaveBeenCalled();
        });
        (0, vitest_1.it)("完整 Server 版本目录幂等跳过", async () => {
            const deps = makeDeps({ artifact: "server" });
            deps.versions.isPrepared.mockResolvedValue(true);
            const updater = new updater_js_1.Updater(deps);
            await updater.prepare({
                url: "http://server/release.zip",
                sha256: "a".repeat(64),
                version: "1.2.1",
            });
            (0, vitest_1.expect)(deps.downloadZip).not.toHaveBeenCalled();
            (0, vitest_1.expect)(deps.versions.removeVersion).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("完整 Client 版本目录幂等跳过", async () => {
            const deps = makeDeps({ artifact: "client" });
            deps.versions.isPrepared.mockResolvedValue(true);
            const updater = new updater_js_1.Updater(deps);
            await updater.prepare({
                url: "http://server/release.zip",
                sha256: "a".repeat(64),
                version: "1.2.1",
            });
            (0, vitest_1.expect)(deps.downloadZip).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("sha256 不匹配 → 抛错且不解压", async () => {
            const deps = makeDeps();
            deps.verifySha256.mockResolvedValue(false);
            const updater = new updater_js_1.Updater(deps);
            await (0, vitest_1.expect)(updater.prepare({
                url: "http://x",
                sha256: "a".repeat(64),
                version: "1.2.1",
            })).rejects.toThrow("sha256");
            (0, vitest_1.expect)(deps.extractZip).not.toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)("prepare 阶段计时日志", () => {
        (0, vitest_1.it)("成功路径输出 下载/校验/解压/总耗时 各阶段日志", async () => {
            const logs = [];
            const spy = vitest_1.vi.spyOn(console, "log").mockImplementation((...a) => {
                logs.push(a.join(" "));
            });
            const deps = makeDeps();
            deps.verifySha256.mockResolvedValue(true);
            const updater = new updater_js_1.Updater(deps);
            await updater.prepare({
                url: "http://x",
                sha256: "a".repeat(64),
                version: "1.2.1",
            });
            spy.mockRestore();
            const text = logs.join("\n");
            (0, vitest_1.expect)(text).toContain("prepare 1.2.1");
            (0, vitest_1.expect)(text).toContain("下载");
            (0, vitest_1.expect)(text).toContain("校验");
            (0, vitest_1.expect)(text).toContain("解压");
            (0, vitest_1.expect)(text).toContain("总耗时");
        });
        (0, vitest_1.it)("幂等跳过时不产生阶段日志", async () => {
            const logs = [];
            const spy = vitest_1.vi.spyOn(console, "log").mockImplementation((...a) => {
                logs.push(a.join(" "));
            });
            const deps = makeDeps();
            deps.versions.isPrepared.mockResolvedValue(true);
            const updater = new updater_js_1.Updater(deps);
            await updater.prepare({ url: "http://x", sha256: "a".repeat(64), version: "1.2.1" });
            spy.mockRestore();
            (0, vitest_1.expect)(logs.join("\n")).not.toContain("下载");
        });
    });
    (0, vitest_1.describe)("apply", () => {
        (0, vitest_1.it)("成功路径：停旧 → 切换 → 启动 → 探活通过", async () => {
            const deps = makeDeps();
            deps.versions.currentVersion.mockResolvedValue("1.1.0");
            deps.probe.mockResolvedValue(true);
            const updater = new updater_js_1.Updater(deps);
            await updater.apply("1.2.1");
            (0, vitest_1.expect)(deps.stopProcess).toHaveBeenCalledTimes(1);
            (0, vitest_1.expect)(deps.versions.switchTo).toHaveBeenCalledWith("1.2.1");
            (0, vitest_1.expect)(deps.startProcess).toHaveBeenCalledTimes(1);
        });
        (0, vitest_1.it)("探活成功后通知成功切换版本和 previous", async () => {
            const deps = makeDeps();
            deps.versions.currentVersion.mockResolvedValue("1.1.0");
            deps.probe.mockResolvedValue(true);
            const updater = new updater_js_1.Updater(deps);
            await updater.apply("1.2.1");
            (0, vitest_1.expect)(deps.onSuccessfulApply).toHaveBeenCalledOnce();
            (0, vitest_1.expect)(deps.onSuccessfulApply).toHaveBeenCalledWith("1.2.1", "1.1.0");
        });
        (0, vitest_1.it)("探活失败 → 回退旧版本并重启，且不通知成功切换", async () => {
            const deps = makeDeps();
            deps.versions.currentVersion.mockResolvedValue("1.1.0");
            deps.probe.mockResolvedValue(false);
            const updater = new updater_js_1.Updater(deps);
            await (0, vitest_1.expect)(updater.apply("1.2.1")).rejects.toThrow("已回退");
            (0, vitest_1.expect)(deps.versions.switchTo).toHaveBeenNthCalledWith(1, "1.2.1");
            (0, vitest_1.expect)(deps.versions.switchTo).toHaveBeenNthCalledWith(2, "1.1.0");
            (0, vitest_1.expect)(deps.startProcess).toHaveBeenCalledTimes(2);
            (0, vitest_1.expect)(deps.onSuccessfulApply).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("保留回调失败只警告，不影响已健康切换的结果", async () => {
            const warn = vitest_1.vi.spyOn(console, "warn").mockImplementation(() => undefined);
            const deps = makeDeps();
            deps.versions.currentVersion.mockResolvedValue("1.1.0");
            deps.probe.mockResolvedValue(true);
            deps.onSuccessfulApply.mockRejectedValue(new Error("retention unavailable"));
            const updater = new updater_js_1.Updater(deps);
            await (0, vitest_1.expect)(updater.apply("1.2.1")).resolves.toBeUndefined();
            (0, vitest_1.expect)(warn).toHaveBeenCalledWith(vitest_1.expect.stringContaining("版本保留记录失败"));
            warn.mockRestore();
        });
        (0, vitest_1.it)("无旧版本（首装）→ 不回退", async () => {
            const deps = makeDeps();
            deps.versions.currentVersion.mockResolvedValue(null);
            deps.probe.mockResolvedValue(false);
            const updater = new updater_js_1.Updater(deps);
            await (0, vitest_1.expect)(updater.apply("1.2.1")).rejects.toThrow("健康检查失败");
            (0, vitest_1.expect)(deps.versions.switchTo).toHaveBeenCalledTimes(1);
        });
        (0, vitest_1.it)("探活重试：前两次失败第三次成功 → 视为健康", async () => {
            vitest_1.vi.useFakeTimers();
            const deps = makeDeps();
            deps.versions.currentVersion.mockResolvedValue("1.1.0");
            deps.probe
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            const updater = new updater_js_1.Updater(deps);
            const phase = updater.apply("1.2.1");
            await vitest_1.vi.advanceTimersByTimeAsync(300);
            await (0, vitest_1.expect)(phase).resolves.toBeUndefined();
            (0, vitest_1.expect)(deps.probe).toHaveBeenCalledTimes(3);
        });
    });
});
