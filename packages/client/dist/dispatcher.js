"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatch = dispatch;
const shared_1 = require("@vcpdeck/shared");
const executor_js_1 = require("./executor.js");
const file_handler_js_1 = require("./file-handler.js");
const transfer_handler_js_1 = require("./transfer-handler.js");
const update_js_1 = require("./update.js");
const frpc_daemon_js_1 = require("./frpc-daemon.js");
function dispatch(job, socket) {
    // 优雅停机守卫：更新期间拒绝新任务（服务端不再派活，双重保险）
    if ((0, update_js_1.isDraining)()) {
        socket.emit(shared_1.Events.JOB_DONE, {
            jobId: job.jobId,
            type: job.type,
            error: {
                code: "CLIENT_UPDATING",
                message: "客户端正在更新，拒绝新任务",
            },
        });
        return;
    }
    switch (job.type) {
        case "exec": {
            const execJob = job;
            if (execJob.mode === "script") {
                return (0, executor_js_1.executeExec)({
                    jobId: execJob.jobId,
                    mode: "script",
                    executable: execJob.executable,
                    args: execJob.args,
                    script: execJob.script,
                    cwd: execJob.cwd,
                    timeout: execJob.timeout,
                }, socket);
            }
            // command 模式（默认）
            return (0, executor_js_1.executeExec)({
                jobId: execJob.jobId,
                mode: "command",
                command: execJob.command,
                cwd: execJob.cwd,
                timeout: execJob.timeout,
            }, socket);
        }
        case "file.list":
        case "file.stat":
        case "file.readText":
        case "file.writeText":
        case "file.mkdir":
        case "file.delete":
        case "file.move":
        case "file.roots":
            return (0, file_handler_js_1.handleFileOp)({
                jobId: job.jobId,
                type: job.type,
                payload: job.payload ?? {},
            }, socket);
        case "file.export":
        case "file.import":
            return (0, transfer_handler_js_1.handleTransfer)({
                jobId: job.jobId,
                type: job.type,
                payload: job.payload ?? {},
            }, socket);
        case "frp.create":
            return (0, frpc_daemon_js_1.handleFrpCreate)({ ...job.payload, _jobId: job.jobId }, socket);
        case "frp.delete":
            return (0, frpc_daemon_js_1.handleFrpDelete)({ ...job.payload, _jobId: job.jobId }, socket);
        case "frp.list":
            return (0, frpc_daemon_js_1.handleFrpList)({ _jobId: job.jobId }, socket);
        case "frp.reconcile":
            return (0, frpc_daemon_js_1.handleFrpReconcile)({ ...job.payload, _jobId: job.jobId }, socket);
        case "agent.run":
            throw new Error(`Job type "${job.type}" not yet implemented`);
        default:
            throw new Error(`Unknown job type: ${job.type}`);
    }
}
