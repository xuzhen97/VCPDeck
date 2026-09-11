"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const process_tree_js_1 = require("./process-tree.js");
(0, vitest_1.describe)("killProcessTree（Windows）", () => {
    (0, vitest_1.it)("以参数数组调用 taskkill /T /F", async () => {
        let called = false;
        const env = {
            platform: "win32",
            killGroupSignal: () => true,
            runTaskkill: async (pid) => {
                called = true;
                (0, vitest_1.expect)(pid).toBe(1234);
                return 0;
            },
        };
        await (0, process_tree_js_1.killProcessTree)(1234, env);
        (0, vitest_1.expect)(called).toBe(true);
    });
});
(0, vitest_1.describe)("killProcessTree（POSIX）", () => {
    (0, vitest_1.it)("先 SIGTERM 进程组再 SIGKILL 兜底", async () => {
        const signals = [];
        const env = {
            platform: "linux",
            killGroupSignal: (pid, sig) => {
                signals.push([pid, sig]);
                return true;
            },
            runTaskkill: async () => 0,
        };
        await (0, process_tree_js_1.killProcessTree)(999, env);
        (0, vitest_1.expect)(signals).toEqual([
            [-999, "SIGTERM"],
            [-999, "SIGKILL"],
        ]);
    });
    (0, vitest_1.it)("进程组已退出时静默成功", async () => {
        const env = {
            platform: "linux",
            killGroupSignal: () => {
                throw new Error("ESRCH");
            },
            runTaskkill: async () => 0,
        };
        await (0, vitest_1.expect)((0, process_tree_js_1.killProcessTree)(999, env)).resolves.toBeUndefined();
    });
    (0, vitest_1.it)("使用真实 setTimeout 时不会抛出（集成冒烟）", async () => {
        vitest_1.vi.useRealTimers();
        const env = {
            platform: "linux",
            killGroupSignal: () => true,
            runTaskkill: async () => 0,
        };
        await (0, vitest_1.expect)((0, process_tree_js_1.killProcessTree)(999, env)).resolves.toBeUndefined();
    });
});
