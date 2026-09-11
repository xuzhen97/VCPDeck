"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const executor_js_1 = require("./executor.js");
(0, vitest_1.describe)("executeExec", () => {
    (0, vitest_1.it)("超时终止命令进程树并上报 EXEC_TIMEOUT，而不是伪造 exitCode 1", async () => {
        const done = new Promise((resolve) => {
            const socket = {
                emit: vitest_1.vi.fn((event, data) => {
                    if (event === shared_1.Events.JOB_DONE)
                        resolve(data);
                }),
            };
            (0, executor_js_1.executeExec)({
                jobId: "timeout-job",
                mode: "command",
                command: 'node -e "console.log(\'READY\'); setInterval(() => {}, 1000)"',
                timeout: 500,
            }, socket);
        });
        await (0, vitest_1.expect)(done).resolves.toMatchObject({
            jobId: "timeout-job",
            type: "exec",
            error: {
                code: "EXEC_TIMEOUT",
                message: "Execution timed out after 500 ms",
            },
            stdout: vitest_1.expect.stringContaining("READY"),
        });
    }, 10_000);
    (0, vitest_1.it)("用户取消终止命令进程树并上报 cancelled", async () => {
        const cancelled = new Promise((resolve) => {
            const socket = {
                emit: vitest_1.vi.fn((event, data) => {
                    if (event === shared_1.Events.JOB_STDOUT && "text" in data) {
                        (0, executor_js_1.killJob)("cancel-job", socket);
                    }
                    if (event === shared_1.Events.JOB_CANCELLED)
                        resolve(data);
                }),
            };
            (0, executor_js_1.executeExec)({
                jobId: "cancel-job",
                mode: "command",
                command: 'node -e "console.log(\'READY\'); setInterval(() => {}, 1000)"',
            }, socket);
        });
        await (0, vitest_1.expect)(cancelled).resolves.toMatchObject({ jobId: "cancel-job" });
    }, 10_000);
});
