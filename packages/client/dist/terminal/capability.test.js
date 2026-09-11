"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const capability_js_1 = require("./capability.js");
(0, vitest_1.describe)("probeTerminalCapability", () => {
    (0, vitest_1.it)("node-pty 可加载时声明 backend=conpty（Windows）", async () => {
        const env = {
            platform: "win32",
            loadPty: async () => ({ spawn: () => ({}) }),
        };
        const status = await (0, capability_js_1.probeTerminalCapability)(env);
        (0, vitest_1.expect)(status.available).toBe(true);
        (0, vitest_1.expect)(status.backend).toBe("conpty");
        (0, vitest_1.expect)(status.code).toBeUndefined();
    });
    (0, vitest_1.it)("node-pty 可加载时声明 backend=pty（Linux）", async () => {
        const env = {
            platform: "linux",
            loadPty: async () => ({ spawn: () => ({}) }),
        };
        const status = await (0, capability_js_1.probeTerminalCapability)(env);
        (0, vitest_1.expect)(status.available).toBe(true);
        (0, vitest_1.expect)(status.backend).toBe("pty");
    });
    (0, vitest_1.it)("动态 import 失败返回稳定错误且不抛异常", async () => {
        const env = {
            platform: "win32",
            loadPty: async () => {
                throw new Error("Cannot find module 'node-pty'");
            },
        };
        const status = await (0, capability_js_1.probeTerminalCapability)(env);
        (0, vitest_1.expect)(status.available).toBe(false);
        (0, vitest_1.expect)(status.code).toBe("TERMINAL_NATIVE_BACKEND_UNAVAILABLE");
    });
    (0, vitest_1.it)("模块缺少 spawn 时视为不可用", async () => {
        const env = {
            platform: "win32",
            loadPty: async () => null,
        };
        const status = await (0, capability_js_1.probeTerminalCapability)(env);
        (0, vitest_1.expect)(status.available).toBe(false);
        (0, vitest_1.expect)(status.code).toBe("TERMINAL_NATIVE_BACKEND_UNAVAILABLE");
    });
    (0, vitest_1.it)("错误消息不包含本地路径或 stack", async () => {
        const env = {
            platform: "win32",
            loadPty: async () => {
                throw new Error("D:\\secret\\node-pty.node load failed at line 42");
            },
        };
        const status = await (0, capability_js_1.probeTerminalCapability)(env);
        (0, vitest_1.expect)(status.message ?? "").not.toContain("D:\\");
        (0, vitest_1.expect)(status.message ?? "").not.toContain("secret");
        (0, vitest_1.expect)(status.message ?? "").not.toContain("line 42");
    });
});
