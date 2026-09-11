"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const protocol_bridge_js_1 = require("./protocol-bridge.js");
const terminal_manager_js_1 = require("./terminal-manager.js");
class FakePty {
    pid = 6000 + counter++;
    writes = [];
    resized = [];
    killed = false;
    dataCbs = [];
    exitCbs = [];
    write(d) {
        this.writes.push(d);
    }
    resize(c, r) {
        this.resized.push([c, r]);
    }
    kill() {
        this.killed = true;
    }
    onData(cb) {
        this.dataCbs.push(cb);
    }
    onExit(cb) {
        this.exitCbs.push(cb);
    }
    emitData(d) {
        for (const cb of this.dataCbs)
            cb(d);
    }
    emitExit(code) {
        for (const cb of this.exitCbs)
            cb(code);
    }
}
let counter = 0;
function fakeSocket() {
    const listeners = new Map();
    const emitCalls = [];
    const responseResolvers = [];
    const socket = {
        connected: true,
        on: (event, cb) => {
            const list = listeners.get(event) ?? [];
            list.push(cb);
            listeners.set(event, list);
            return socket;
        },
        emit: (event, ...args) => {
            emitCalls.push({ event, args });
            if (event === shared_1.Events.TERMINAL_RESPONSE) {
                const resolvers = responseResolvers.splice(0);
                for (const resolve of resolvers)
                    resolve(args[0]);
            }
            return socket;
        },
    };
    return { socket, emitCalls, listeners, responseResolvers };
}
function makeHarness() {
    const spawned = [];
    const { socket, emitCalls, listeners, responseResolvers } = fakeSocket();
    const manager = (0, terminal_manager_js_1.createTerminalManager)({
        shells: [
            {
                id: "bash",
                label: "bash",
                kind: "bash",
                executable: "/usr/bin/bash",
                args: [],
                isDefault: true,
            },
        ],
        cwd: "/home/dev",
        generationId: "gen-1",
        onOutput: () => undefined,
        onSessionEnded: () => undefined,
        spawnPty: (opts) => {
            const pty = new FakePty();
            pty.resized.push([opts.cols, opts.rows]);
            spawned.push(pty);
            return pty;
        },
        killTree: async () => undefined,
    });
    (0, protocol_bridge_js_1.attachTerminalBridge)(socket, { clientId: "c1", manager });
    (0, protocol_bridge_js_1.wireManagerToSocket)(socket, manager);
    const request = (req) => new Promise((resolve) => {
        responseResolvers.push(resolve);
        for (const cb of listeners.get(shared_1.Events.TERMINAL_REQUEST) ?? []) {
            cb(req);
        }
    });
    const registered = () => {
        for (const cb of listeners.get("ack") ?? []) {
            cb({ event: shared_1.Events.REGISTER });
        }
    };
    return { manager, spawned, socket, emitCalls, listeners, request, registered };
}
function emitted(h, event) {
    return h.emitCalls.filter((c) => c.event === event).map((c) => c.args[0]);
}
(0, vitest_1.beforeEach)(() => {
    vitest_1.vi.useFakeTimers();
    counter = 0;
});
(0, vitest_1.afterEach)(() => {
    vitest_1.vi.useRealTimers();
});
(0, vitest_1.describe)("terminal request/response", () => {
    (0, vitest_1.it)("非法请求返回 TERMINAL_PROTOCOL_INVALID 且不触碰 Manager", async () => {
        const h = makeHarness();
        const resp = await h.request({ requestId: "r1", action: "session.hack" });
        (0, vitest_1.expect)(resp).toBeDefined();
        if (resp?.ok)
            throw new Error("expected error");
        (0, vitest_1.expect)(resp?.error.code).toBe("TERMINAL_PROTOCOL_INVALID");
        (0, vitest_1.expect)(h.spawned).toHaveLength(0);
    });
    (0, vitest_1.it)("shells.list 返回安全 DTO", async () => {
        const h = makeHarness();
        const resp = await h.request({ requestId: "r1", action: "shells.list" });
        if (!resp || !resp.ok)
            throw new Error("expected ok");
        if (resp.action !== "shells.list")
            throw new Error("narrow");
        (0, vitest_1.expect)(resp.shells[0]).toEqual({ id: "bash", label: "bash", kind: "bash", isDefault: true });
        (0, vitest_1.expect)(JSON.stringify(resp)).not.toContain("/usr/bin/bash");
    });
    (0, vitest_1.it)("create → input → resize → snapshot → close 完整链路", async () => {
        const h = makeHarness();
        const created = await h.request({
            requestId: "r1",
            action: "session.create",
            sessionId: "s1",
            shellId: "bash",
            cols: 80,
            rows: 24,
        });
        (0, vitest_1.expect)(created?.ok).toBe(true);
        (0, vitest_1.expect)(h.spawned).toHaveLength(1);
        await h.request({ requestId: "r2", action: "session.input", sessionId: "s1", data: "ls\r" });
        (0, vitest_1.expect)(h.spawned[0]?.writes).toEqual(["ls\r"]);
        await h.request({ requestId: "r3", action: "session.resize", sessionId: "s1", cols: 100, rows: 40 });
        (0, vitest_1.expect)(h.spawned[0]?.resized).toContainEqual([100, 40]);
        // 输出：快照 + 输出事件
        h.spawned[0]?.emitData("hello");
        await vitest_1.vi.advanceTimersByTimeAsync(30);
        (0, vitest_1.expect)(emitted(h, shared_1.Events.TERMINAL_OUTPUT)).toHaveLength(1);
        const snap = await h.request({ requestId: "r4", action: "session.snapshot", sessionId: "s1" });
        (0, vitest_1.expect)(snap?.ok).toBe(true);
        if (!snap?.ok)
            throw new Error("expected ok");
        if (snap.action !== "session.snapshot")
            throw new Error("narrow");
        (0, vitest_1.expect)(snap.snapshotSeq).toBe(1);
        (0, vitest_1.expect)(snap.snapshot).toContain("hello");
        const closed = await h.request({ requestId: "r5", action: "session.close", sessionId: "s1", reason: "closed" });
        (0, vitest_1.expect)(closed?.ok).toBe(true);
        (0, vitest_1.expect)(h.spawned[0]?.killed).toBe(true);
    });
    (0, vitest_1.it)("shell 不存在时 create 返回 TERMINAL_SHELL_NOT_AVAILABLE", async () => {
        const h = makeHarness();
        const resp = await h.request({
            requestId: "r1",
            action: "session.create",
            sessionId: "s1",
            shellId: "fish",
            cols: 80,
            rows: 24,
        });
        (0, vitest_1.expect)(resp?.ok).toBe(false);
        if (resp?.ok || !resp)
            throw new Error("expected error");
        (0, vitest_1.expect)(resp.error.code).toBe("TERMINAL_SHELL_NOT_AVAILABLE");
    });
    (0, vitest_1.it)("manager 抛出的未知错误映射为安全错误", async () => {
        const h = makeHarness();
        const resp = await h.request({ requestId: "r1", action: "session.input", sessionId: "nope", data: "x" });
        (0, vitest_1.expect)(resp?.ok).toBe(false);
        if (resp?.ok || !resp)
            throw new Error("expected error");
        (0, vitest_1.expect)(resp.error.code).toBe("TERMINAL_SESSION_NOT_FOUND");
        (0, vitest_1.expect)(resp.error.message).not.toContain("/home/dev");
    });
});
(0, vitest_1.describe)("输出与退出事件", () => {
    (0, vitest_1.it)("PTY 输出经 flush 窗口发送 TERMINAL_OUTPUT", async () => {
        const h = makeHarness();
        await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
        h.spawned[0]?.emitData("ab");
        await vitest_1.vi.advanceTimersByTimeAsync(30);
        const outputs = emitted(h, shared_1.Events.TERMINAL_OUTPUT);
        (0, vitest_1.expect)(outputs).toEqual([{ sessionId: "s1", seq: 1, data: "ab" }]);
    });
    (0, vitest_1.it)("Shell 自行退出发送 TERMINAL_EXIT", async () => {
        const h = makeHarness();
        await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
        h.spawned[0]?.emitExit(0);
        const exits = emitted(h, shared_1.Events.TERMINAL_EXIT);
        (0, vitest_1.expect)(exits).toEqual([{ sessionId: "s1", exitCode: 0 }]);
    });
    (0, vitest_1.it)("关闭后输出不再发送", async () => {
        const h = makeHarness();
        await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
        await h.request({ requestId: "r2", action: "session.close", sessionId: "s1", reason: "closed" });
        h.spawned[0]?.emitData("late");
        await vitest_1.vi.advanceTimersByTimeAsync(30);
        (0, vitest_1.expect)(emitted(h, shared_1.Events.TERMINAL_OUTPUT)).toHaveLength(0);
    });
});
(0, vitest_1.describe)("状态对账", () => {
    (0, vitest_1.it)("REGISTER ack 后发送 TERMINAL_STATE 且带 generationId", async () => {
        const h = makeHarness();
        await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
        h.registered();
        const states = emitted(h, shared_1.Events.TERMINAL_STATE);
        (0, vitest_1.expect)(states).toHaveLength(1);
        (0, vitest_1.expect)(states[0].generationId).toBe("gen-1");
        (0, vitest_1.expect)(states[0].clientId).toBe("c1");
        (0, vitest_1.expect)(states[0].sessions).toHaveLength(1);
        (0, vitest_1.expect)(JSON.stringify(states[0])).not.toContain("/home/dev");
        (0, vitest_1.expect)(JSON.stringify(states[0])).not.toContain("env");
    });
    (0, vitest_1.it)("state ack 的 closeSessionIds 关闭孤儿 PTY", async () => {
        const h = makeHarness();
        await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
        h.registered();
        const stateCall = h.emitCalls.find((c) => c.event === shared_1.Events.TERMINAL_STATE);
        (0, vitest_1.expect)(stateCall).toBeTruthy();
        const ackCb = stateCall?.args[1];
        ackCb({ acceptedSessionIds: [], closeSessionIds: ["s1"] });
        await vitest_1.vi.advanceTimersByTimeAsync(10);
        (0, vitest_1.expect)(h.spawned[0]?.killed).toBe(true);
    });
    (0, vitest_1.it)("非法 state ack 被忽略", async () => {
        const h = makeHarness();
        await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
        h.registered();
        const stateCall = h.emitCalls.find((c) => c.event === shared_1.Events.TERMINAL_STATE);
        const ackCb = stateCall?.args[1];
        ackCb({ acceptedSessionIds: [7], closeSessionIds: [] }); // 非法 → 忽略
        await vitest_1.vi.advanceTimersByTimeAsync(10);
        (0, vitest_1.expect)(h.spawned[0]?.killed).toBe(false);
    });
});
(0, vitest_1.describe)("断线处理", () => {
    (0, vitest_1.it)("socket 断线调用 handleServerDisconnect 且不 kill PTY", async () => {
        const h = makeHarness();
        await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
        for (const cb of h.listeners.get("disconnect") ?? []) {
            cb("transport close");
        }
        await vitest_1.vi.advanceTimersByTimeAsync(1000);
        (0, vitest_1.expect)(h.spawned[0]?.killed).toBe(false);
        // 30 分钟到期后才清理
        await vitest_1.vi.advanceTimersByTimeAsync(30 * 60_000);
        (0, vitest_1.expect)(h.spawned[0]?.killed).toBe(true);
    });
});
