"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const update_js_1 = require("./update.js");
const dispatcher_js_1 = require("./dispatcher.js");
function makeSocket() {
    const handlers = new Map();
    const emitted = [];
    return {
        handlers,
        emitted,
        on: vitest_1.vi.fn((ev, fn) => {
            handlers.set(ev, fn);
        }),
        off: vitest_1.vi.fn((ev) => {
            handlers.delete(ev);
        }),
        emit: vitest_1.vi.fn((ev, data) => {
            emitted.push([ev, data]);
        }),
    };
}
function makeLauncher() {
    return {
        prepareUpdate: vitest_1.vi.fn(),
        applyUpdate: vitest_1.vi.fn(),
    };
}
const REQ = {
    releaseVersion: "1.2.1",
    url: "/api/releases/1.2.1/file",
    sha256: "a".repeat(64),
};
function fireUpdateRequest(socket) {
    const handler = socket.handlers.get(shared_1.Events.UPDATE_REQUEST);
    if (!handler)
        throw new Error("UPDATE_REQUEST 未注册");
    handler(REQ);
}
function lastEmit(socket, event) {
    return socket.emitted.filter(([e]) => e === event).at(-1)?.[1];
}
(0, vitest_1.describe)("客户端优雅停机（update.ts）", () => {
    let socket;
    let launcher;
    let runningJobs;
    (0, vitest_1.beforeEach)(() => {
        socket = makeSocket();
        launcher = makeLauncher();
        runningJobs = [];
        launcher.prepareUpdate.mockResolvedValue(undefined);
        launcher.applyUpdate.mockResolvedValue(undefined);
        (0, update_js_1.attachUpdateHandler)({
            socket: socket,
            launcher: launcher,
            serverBase: "http://localhost:3001",
            getRunningJobIds: () => runningJobs,
            pollIntervalMs: 50,
        });
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("完整流程：prepare（完整 URL）→ 等 job 清空 → READY → apply", async () => {
        runningJobs = ["job-1"];
        const phase = new Promise((resolve) => {
            const interval = setInterval(() => {
                const ready = lastEmit(socket, shared_1.Events.UPDATE_READY);
                if (ready) {
                    clearInterval(interval);
                    resolve();
                }
            }, 10);
        });
        fireUpdateRequest(socket);
        // job 完成后流程继续
        setTimeout(() => {
            runningJobs = [];
        }, 100);
        await phase;
        (0, vitest_1.expect)(launcher.prepareUpdate).toHaveBeenCalledWith({
            version: "1.2.1",
            url: "http://localhost:3001/api/releases/1.2.1/file",
            sha256: "a".repeat(64),
        });
        (0, vitest_1.expect)(lastEmit(socket, shared_1.Events.UPDATE_READY)).toMatchObject({
            clientId: vitest_1.expect.any(String),
            releaseVersion: "1.2.1",
        });
        (0, vitest_1.expect)(launcher.applyUpdate).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("beforeApply 顺序：prepare → drain → update:ready → beforeApply → apply", async () => {
        const order = [];
        launcher.prepareUpdate.mockImplementation(async () => {
            order.push("prepare");
        });
        launcher.applyUpdate.mockImplementation(async () => {
            order.push("apply");
        });
        // 重新 attach（Map 覆盖旧注册），注入 beforeApply 钩子。
        (0, update_js_1.attachUpdateHandler)({
            socket: socket,
            launcher: launcher,
            serverBase: "http://localhost:3001",
            getRunningJobIds: () => [],
            beforeApply: async () => {
                order.push(`ready=${String(lastEmit(socket, shared_1.Events.UPDATE_READY) !== undefined)}`);
                order.push("beforeApply");
            },
        });
        fireUpdateRequest(socket);
        await vitest_1.vi.waitFor(() => {
            (0, vitest_1.expect)(launcher.applyUpdate).toHaveBeenCalledTimes(1);
        });
        (0, vitest_1.expect)(order).toEqual(["prepare", "ready=true", "beforeApply", "apply"]);
    });
    (0, vitest_1.it)("prepare 失败 → UPDATE_FAILED 且不发 READY", async () => {
        launcher.prepareUpdate.mockRejectedValue(new Error("校验失败"));
        fireUpdateRequest(socket);
        await vitest_1.vi.waitFor(() => {
            (0, vitest_1.expect)(lastEmit(socket, shared_1.Events.UPDATE_FAILED)).toBeTruthy();
        });
        (0, vitest_1.expect)(lastEmit(socket, shared_1.Events.UPDATE_FAILED)).toMatchObject({
            releaseVersion: "1.2.1",
            reason: vitest_1.expect.stringContaining("校验失败"),
        });
        (0, vitest_1.expect)(lastEmit(socket, shared_1.Events.UPDATE_READY)).toBeUndefined();
        (0, vitest_1.expect)((0, update_js_1.isDraining)()).toBe(false);
    });
    (0, vitest_1.it)("等待超时 → 强制继续（仍发 READY 并 apply）", async () => {
        vitest_1.vi.useFakeTimers();
        runningJobs = ["job-1"]; // 一直不完成
        fireUpdateRequest(socket);
        // 默认超时 10 分钟；这里推进超过超时上限
        await vitest_1.vi.advanceTimersByTimeAsync(11 * 60 * 1000);
        (0, vitest_1.expect)(lastEmit(socket, shared_1.Events.UPDATE_READY)).toBeTruthy();
        (0, vitest_1.expect)(launcher.applyUpdate).toHaveBeenCalled();
    });
    (0, vitest_1.it)("draining 期间重复 update:request 只处理一次", async () => {
        vitest_1.vi.useFakeTimers();
        runningJobs = ["job-1"];
        fireUpdateRequest(socket);
        fireUpdateRequest(socket);
        (0, vitest_1.expect)(launcher.prepareUpdate).toHaveBeenCalledTimes(1);
        await vitest_1.vi.advanceTimersByTimeAsync(11 * 60 * 1000);
        (0, vitest_1.expect)(launcher.applyUpdate).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("apply 返回后不再上报失败（终局以重连注册版本为准）", async () => {
        launcher.applyUpdate.mockResolvedValue(undefined);
        fireUpdateRequest(socket);
        await vitest_1.vi.waitFor(() => {
            (0, vitest_1.expect)((0, update_js_1.isDraining)()).toBe(false);
        });
        (0, vitest_1.expect)(launcher.applyUpdate).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(lastEmit(socket, shared_1.Events.UPDATE_FAILED)).toBeUndefined();
    });
    (0, vitest_1.it)("draining 期间 dispatch 拒绝新任务（CLIENT_UPDATING）", async () => {
        vitest_1.vi.useFakeTimers();
        runningJobs = ["job-1"];
        fireUpdateRequest(socket);
        await vitest_1.vi.advanceTimersByTimeAsync(10);
        (0, dispatcher_js_1.dispatch)({
            jobId: "job-new",
            type: "exec",
            mode: "command",
            command: "echo hi",
        }, socket);
        const done = lastEmit(socket, shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(done).toMatchObject({
            jobId: "job-new",
            error: { code: "CLIENT_UPDATING" },
        });
        await vitest_1.vi.advanceTimersByTimeAsync(11 * 60 * 1000);
        (0, vitest_1.expect)((0, update_js_1.isDraining)()).toBe(false);
    });
});
