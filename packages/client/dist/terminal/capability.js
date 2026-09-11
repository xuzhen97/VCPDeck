"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeTerminalCapability = probeTerminalCapability;
exports.createTerminalCapabilityEnv = createTerminalCapabilityEnv;
/**
 * 延迟探测 node-pty 后端。
 * - 动态 import：加载失败只禁用终端能力，不影响 exec/files/FRP/Pi；
 * - 错误消息安全化：不包含本地路径或 stack。
 */
async function probeTerminalCapability(env = createTerminalCapabilityEnv()) {
    let loaded = null;
    try {
        loaded = await env.loadPty();
    }
    catch {
        loaded = null;
    }
    if (!loaded || typeof loaded.spawn !== "function") {
        return {
            available: false,
            code: "TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
            message: "Terminal PTY backend unavailable",
        };
    }
    return {
        available: true,
        backend: env.platform === "win32" ? "conpty" : "pty",
    };
}
/** 生成真实探测环境（node-pty 动态 import）。 */
function createTerminalCapabilityEnv() {
    return {
        platform: process.platform,
        loadPty: async () => {
            const mod = await import("@lydell/node-pty");
            return { spawn: mod.spawn };
        },
    };
}
