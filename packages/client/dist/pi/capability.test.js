"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const capability_js_1 = require("./capability.js");
function fakeEnv(overrides = {}) {
    return {
        nodeVersion: "22.19.0",
        platform: "win32",
        homedir: "C:\\Users\\test",
        readSettingsShellPath: async () => null,
        existsGitBash: async () => false,
        findBashInPath: async () => false,
        forkProbeWorker: async () => ({
            sdkVersion: "0.84.0",
            modelCount: 2,
            error: null,
        }),
        readAgentDir: async () => true,
        ...overrides,
    };
}
(0, vitest_1.describe)("probePiCapability", () => {
    (0, vitest_1.it)("Windows 全满足时返回 available + git-bash 来源", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({
            existsGitBash: async () => true,
        }));
        (0, vitest_1.expect)(result).toMatchObject({
            available: true,
            sdkVersion: "0.84.0",
            nodeVersion: "22.19.0",
            shellKind: "git-bash",
            sessionJobProtocolVersion: 1,
        });
    });
    (0, vitest_1.it)("配置 shellPath 优先于 Git Bash", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({
            readSettingsShellPath: async () => "C:\\tools\\bash.exe",
            existsGitBash: async () => true,
        }));
        (0, vitest_1.expect)(result).toMatchObject({ available: true, shellKind: "configured" });
    });
    (0, vitest_1.it)("PATH bash 作为最后来源", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({ findBashInPath: async () => true }));
        (0, vitest_1.expect)(result).toMatchObject({ available: true, shellKind: "path" });
    });
    (0, vitest_1.it)("Linux 使用 system bash（bash 在 PATH）", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({
            platform: "linux",
            existsGitBash: async () => true,
            findBashInPath: async () => true,
        }));
        (0, vitest_1.expect)(result).toMatchObject({ available: true, shellKind: "system" });
    });
    (0, vitest_1.it)("Linux 无 bash 返回 PI_BASH_NOT_FOUND", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({
            platform: "linux",
            existsGitBash: async () => true,
            findBashInPath: async () => false,
        }));
        (0, vitest_1.expect)(result).toMatchObject({
            available: false,
            code: "PI_BASH_NOT_FOUND",
        });
    });
    (0, vitest_1.it)("Node 过旧返回 PI_NODE_UNSUPPORTED", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({ nodeVersion: "22.18.99" }));
        (0, vitest_1.expect)(result).toMatchObject({
            available: false,
            code: "PI_NODE_UNSUPPORTED",
            nodeVersion: "22.18.99",
        });
    });
    (0, vitest_1.it)("Windows 找不到 Bash 返回 PI_BASH_NOT_FOUND", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({}));
        (0, vitest_1.expect)(result).toMatchObject({
            available: false,
            code: "PI_BASH_NOT_FOUND",
        });
        (0, vitest_1.expect)(result).not.toHaveProperty("sessionJobProtocolVersion");
    });
    (0, vitest_1.it)("Worker 失败返回 PI_RUNTIME_UNAVAILABLE", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({
            existsGitBash: async () => true,
            forkProbeWorker: async () => ({
                sdkVersion: "",
                modelCount: 0,
                error: { code: "PI_RUNTIME_UNAVAILABLE", message: "sdk load failed" },
            }),
        }));
        (0, vitest_1.expect)(result).toMatchObject({
            available: false,
            code: "PI_RUNTIME_UNAVAILABLE",
        });
    });
    (0, vitest_1.it)("无已认证模型返回 PI_AUTH_UNAVAILABLE", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({
            existsGitBash: async () => true,
            forkProbeWorker: async () => ({
                sdkVersion: "0.84.0",
                modelCount: 0,
                error: null,
            }),
        }));
        (0, vitest_1.expect)(result).toMatchObject({
            available: false,
            code: "PI_AUTH_UNAVAILABLE",
        });
    });
    (0, vitest_1.it)("Agent 目录不可读返回 PI_RUNTIME_UNAVAILABLE", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({
            existsGitBash: async () => true,
            readAgentDir: async () => false,
        }));
        (0, vitest_1.expect)(result).toMatchObject({
            available: false,
            code: "PI_RUNTIME_UNAVAILABLE",
        });
    });
    (0, vitest_1.it)("结果不包含路径或凭据", async () => {
        const result = await (0, capability_js_1.probePiCapability)(fakeEnv({
            existsGitBash: async () => true,
            readSettingsShellPath: async () => "C:\\Users\\test\\AppData\\Roaming\\npm\\bash.exe",
        }));
        (0, vitest_1.expect)(JSON.stringify(result)).not.toContain("Users");
        (0, vitest_1.expect)(JSON.stringify(result)).not.toContain("AppData");
    });
});
