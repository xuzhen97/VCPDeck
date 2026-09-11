"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.killProcessTree = killProcessTree;
const node_child_process_1 = require("node:child_process");
/** Windows：taskkill /PID <pid> /T /F（参数数组，非 shell 调用）。 */
function taskkill(pid) {
    return new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)("taskkill", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
        });
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
    });
}
/**
 * 终止进程树。
 * - POSIX：先 SIGTERM 进程组（-pid），兜底 kill(-pid, SIGKILL)；
 * - Windows：taskkill /T /F 结束进程树（ConPTY 关闭后仍可能残留子进程）。
 * 幂等：进程已退出时静默成功。
 */
async function killProcessTree(pid, env = {
    platform: process.platform,
    killGroupSignal: (p, sig) => process.kill(p, sig),
    runTaskkill: taskkill,
}) {
    if (env.platform === "win32") {
        await env.runTaskkill(pid);
        return;
    }
    try {
        env.killGroupSignal(-pid, "SIGTERM");
    }
    catch {
        /* 进程组不存在：尝试单进程 */
    }
    try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        env.killGroupSignal(-pid, "SIGKILL");
    }
    catch {
        /* 已退出 */
    }
}
