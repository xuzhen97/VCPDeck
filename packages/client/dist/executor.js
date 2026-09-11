"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeExec = executeExec;
exports.killJob = killJob;
exports.getRunningJobIds = getRunningJobIds;
exports.getStatusReport = getStatusReport;
const node_child_process_1 = require("node:child_process");
const process_tree_js_1 = require("./terminal/process-tree.js");
const shared_1 = require("@vcpdeck/shared");
const activeJobs = new Map();
/** 幂等终态：只执行一次 action */
function settle(jobId, action) {
    const active = activeJobs.get(jobId);
    if (!active)
        return; // 已终态，忽略
    if (active.timeoutTimer)
        clearTimeout(active.timeoutTimer);
    activeJobs.delete(jobId);
    action();
}
function executeExec(job, socket) {
    let child;
    let stdoutBuf = "";
    let stderrBuf = "";
    if (job.mode === "command") {
        // Windows cmd 默认输出 GBK，先切到 UTF-8 代码页
        const cmd = process.platform === "win32"
            ? `chcp 65001 > nul && ${job.command}`
            : job.command;
        child = (0, node_child_process_1.spawn)(cmd, {
            shell: true,
            cwd: job.cwd,
            detached: process.platform !== "win32",
            windowsHide: true,
        });
    }
    else {
        child = (0, node_child_process_1.spawn)(job.executable, job.args, {
            shell: false,
            cwd: job.cwd,
            detached: process.platform !== "win32",
            windowsHide: true,
        });
    }
    // ── 注册 activeJob ──
    const active = {
        jobId: job.jobId,
        process: child,
        startTime: Date.now(),
    };
    activeJobs.set(job.jobId, active);
    if (job.timeout !== undefined) {
        active.timeoutTimer = setTimeout(() => {
            const current = activeJobs.get(job.jobId);
            if (!current ||
                current.cancelling ||
                current.process.exitCode !== null ||
                current.process.signalCode !== null)
                return;
            current.timedOut = true;
            void terminateActiveJob(current);
        }, job.timeout);
    }
    // ── stdout ──
    child.stdout?.on("data", (data) => {
        const text = data.toString();
        stdoutBuf += text;
        socket.emit(shared_1.Events.JOB_STDOUT, {
            jobId: job.jobId,
            text,
        });
    });
    // ── stderr ──
    child.stderr?.on("data", (data) => {
        const text = data.toString();
        stderrBuf += text;
        socket.emit(shared_1.Events.JOB_STDERR, {
            jobId: job.jobId,
            text,
        });
    });
    // ── close（幂等） ──
    child.on("close", (code, signal) => {
        // 先捕获终止原因，settle 会删除 map 条目
        const current = activeJobs.get(job.jobId);
        const wasCancelling = current?.cancelling ?? false;
        const timedOut = current?.timedOut ?? false;
        settle(job.jobId, () => {
            if (timedOut) {
                socket.emit(shared_1.Events.JOB_DONE, {
                    jobId: job.jobId,
                    type: "exec",
                    error: {
                        code: "EXEC_TIMEOUT",
                        message: `Execution timed out after ${job.timeout} ms`,
                    },
                    stdout: stdoutBuf || undefined,
                    stderr: stderrBuf || undefined,
                });
                return;
            }
            if (wasCancelling) {
                socket.emit(shared_1.Events.JOB_CANCELLED, {
                    jobId: job.jobId,
                });
                return;
            }
            if (code === null) {
                socket.emit(shared_1.Events.JOB_DONE, {
                    jobId: job.jobId,
                    type: "exec",
                    error: {
                        code: "EXEC_SIGNALLED",
                        message: `Process terminated by ${signal ?? "an unknown signal"}`,
                    },
                    stdout: stdoutBuf || undefined,
                    stderr: stderrBuf || undefined,
                });
                return;
            }
            socket.emit(shared_1.Events.JOB_DONE, {
                jobId: job.jobId,
                type: "exec",
                exitCode: code,
                stdout: stdoutBuf || undefined,
                stderr: stderrBuf || undefined,
            });
        });
    });
    // ── spawn error（幂等） ──
    child.on("error", (err) => {
        settle(job.jobId, () => {
            socket.emit(shared_1.Events.JOB_DONE, {
                jobId: job.jobId,
                type: "exec",
                error: {
                    code: "EXEC_SPAWN_FAILED",
                    message: safeSpawnErrorMessage(err.message),
                },
            });
        });
    });
    // ── script 模式：写 stdin ──
    if (job.mode === "script") {
        child.stdin?.on("error", () => {
            const current = activeJobs.get(job.jobId);
            settle(job.jobId, () => {
                if (current)
                    void terminateActiveJob(current);
                socket.emit(shared_1.Events.JOB_DONE, {
                    jobId: job.jobId,
                    type: "exec",
                    error: {
                        code: "EXEC_STDIN_FAILED",
                        message: "Failed to write script to stdin",
                    },
                });
            });
        });
        child.stdin?.end(job.script, "utf8");
    }
}
/** 终止 Job 进程树；平台树清理失败时至少终止直接子进程。 */
async function terminateActiveJob(active) {
    if (active.process.exitCode !== null ||
        active.process.signalCode !== null)
        return;
    const pid = active.process.pid;
    if (pid)
        await (0, process_tree_js_1.killProcessTree)(pid);
    if (active.process.exitCode === null) {
        try {
            active.process.kill("SIGKILL");
        }
        catch {
            /* 已退出 */
        }
    }
}
/** 去除 spawn error 中的明显本地路径 */
function safeSpawnErrorMessage(msg) {
    return msg
        .replace(/[A-Za-z]:\\[^\s"]*/g, "<path>")
        .replace(/\/[^\s"]*/g, "<path>");
}
function killJob(jobId, socket) {
    const active = activeJobs.get(jobId);
    if (!active) {
        socket.emit(shared_1.Events.JOB_CANCEL_FAILED, {
            jobId,
            reason: "Job not found",
        });
        return;
    }
    if (!active.timedOut)
        active.cancelling = true;
    if (active.timeoutTimer) {
        clearTimeout(active.timeoutTimer);
        active.timeoutTimer = undefined;
    }
    void terminateActiveJob(active).catch((error) => {
        socket.emit(shared_1.Events.JOB_CANCEL_FAILED, {
            jobId,
            reason: error instanceof Error
                ? safeSpawnErrorMessage(error.message)
                : "Cancellation failed",
        });
    });
}
function getRunningJobIds() {
    return [...activeJobs.keys()];
}
function getStatusReport() {
    return [...activeJobs.values()].map((job) => ({
        jobId: job.jobId,
        status: job.process.exitCode === null
            ? "running"
            : job.process.exitCode === 0
                ? "done"
                : "error",
        exitCode: job.process.exitCode,
    }));
}
