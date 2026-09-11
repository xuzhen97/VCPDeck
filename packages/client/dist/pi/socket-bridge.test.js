"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const index_js_1 = require("../index.js");
const supervisor_js_1 = require("./supervisor.js");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
let roots = [];
let seq = 0;
(0, vitest_1.afterEach)(async () => {
    vitest_1.vi.useRealTimers();
    vitest_1.vi.restoreAllMocks();
    await Promise.all(roots.map((r) => (0, promises_1.rm)(r, { recursive: true, force: true })));
    roots = [];
});
function fakeSocket() {
    const listeners = new Map();
    const emitCalls = [];
    const socket = {
        connected: true,
        disconnect: vitest_1.vi.fn(() => {
            socket.connected = false;
            return socket;
        }),
        connect: vitest_1.vi.fn(() => socket),
        on: (event, cb) => {
            const list = listeners.get(event) ?? [];
            list.push(cb);
            listeners.set(event, list);
            return socket;
        },
        emit: (event, ...args) => {
            emitCalls.push({ event, args });
            return socket;
        },
    };
    return { socket, emitCalls, listeners };
}
function makeFakeHandle() {
    const msgListeners = [];
    const emitMessage = (msg) => {
        for (const l of msgListeners)
            l(msg);
    };
    return {
        handle: {
            send: (msg) => {
                // 自动应答：收到请求立即 ok
                if (typeof msg === "object" &&
                    msg !== null &&
                    msg.type === "request") {
                    const requestId = msg.request
                        .requestId;
                    queueMicrotask(() => {
                        emitMessage({
                            type: "response",
                            requestId,
                            ok: true,
                            data: {},
                        });
                    });
                }
            },
            onMessage: (l) => {
                msgListeners.push(l);
                return () => { };
            },
            onExit: () => () => { },
            kill: () => { },
        },
        emitMessage,
    };
}
async function makeDeps(overrides = {}) {
    const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-bridge-${++seq}-`));
    await (0, promises_1.mkdir)((0, node_path_1.join)(root, "proj"), { recursive: true });
    roots.push(root);
    const { handle, emitMessage } = makeFakeHandle();
    const supervisor = (0, supervisor_js_1.createPiSupervisor)({
        clientId: "c1",
        rootsProvider: async () => [root],
        forkWorker: () => handle,
    });
    const status = {
        available: true,
        sdkVersion: "0.84.0",
        nodeVersion: "22.19.0",
        shellKind: "git-bash",
    };
    return {
        emitMessage,
        deps: {
            clientId: "c1",
            supervisor,
            getPiStatus: async () => status,
            getTerminalStatus: async () => ({
                available: false,
                code: "TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
            }),
            // Windows 夹具：不报告运行时安全摘要（未报告，不推断）。
            getRuntimeSecurity: async () => undefined,
            getRegister: (piStatus, terminalStatus, runtimeSecurity) => ({
                clientId: "c1",
                hostname: "host",
                os: "win32",
                cpuModel: "cpu",
                totalMemMB: 1,
                clientVersion: "1",
                capabilities: piStatus?.available ? ["agent.pi"] : [],
                ...(piStatus ? { capabilityDetails: { pi: piStatus } } : {}),
                ...(runtimeSecurity?.privileged
                    ? { capabilityDetails: { privileged: runtimeSecurity.privileged } }
                    : {}),
                ...(runtimeSecurity?.installation
                    ? { installation: runtimeSecurity.installation }
                    : {}),
            }),
            getStatusReport: () => ({ clientId: "c1", jobs: [] }),
            ...overrides,
        },
    };
}
(0, vitest_1.describe)("attachPiBridge", () => {
    (0, vitest_1.it)("PI_REQUEST 经 parse 后交给 supervisor 并回 PI_RESPONSE", async () => {
        const { socket, emitCalls, listeners } = fakeSocket();
        const { deps } = await makeDeps();
        (0, index_js_1.attachPiBridge)(socket, deps);
        fire(listeners, shared_1.Events.PI_REQUEST, {
            requestId: "r1",
            action: "sessions.list",
            cwdRef: { rootDir: roots[0], relativePath: "proj" },
        });
        await vitest_1.vi.waitFor(() => {
            const res = emitCalls.find((c) => c.event === shared_1.Events.PI_RESPONSE);
            (0, vitest_1.expect)(res).toBeDefined();
        });
        const res = emitCalls.find((c) => c.event === shared_1.Events.PI_RESPONSE)
            ?.args[0];
        (0, vitest_1.expect)(res.requestId).toBe("r1");
        (0, vitest_1.expect)(res.ok).toBe(true);
    });
    (0, vitest_1.it)("非法 PI_REQUEST 返回 PI_PROTOCOL_INVALID", async () => {
        const { socket, emitCalls, listeners } = fakeSocket();
        const { deps } = await makeDeps();
        (0, index_js_1.attachPiBridge)(socket, deps);
        fire(listeners, shared_1.Events.PI_REQUEST, { action: "agent.unknown" });
        await vitest_1.vi.waitFor(() => {
            const res = emitCalls.find((c) => c.event === shared_1.Events.PI_RESPONSE);
            (0, vitest_1.expect)(res).toBeDefined();
        });
        const res = emitCalls.find((c) => c.event === shared_1.Events.PI_RESPONSE)
            ?.args[0];
        (0, vitest_1.expect)(res.ok).toBe(false);
        (0, vitest_1.expect)(res.error.code).toBe("PI_PROTOCOL_INVALID");
    });
    (0, vitest_1.it)("supervisor 事件经 worker 链路转发为 PI_EVENT", async () => {
        const { socket, emitCalls } = fakeSocket();
        const { deps, emitMessage } = await makeDeps();
        (0, index_js_1.attachPiBridge)(socket, deps);
        // 建立活动回合（fake worker 自动响应）
        const result = await deps.supervisor.request({
            requestId: "r2",
            action: "agent.prompt",
            cwdRef: { rootDir: roots[0], relativePath: "proj" },
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            payload: { prompt: "hi" },
        });
        (0, vitest_1.expect)(result).toMatchObject({ ok: true });
        emitMessage({
            type: "event",
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            event: { type: "agent_end", sessionId: "s1" },
        });
        const ev = emitCalls.find((c) => c.event === shared_1.Events.PI_EVENT)?.args[0];
        (0, vitest_1.expect)(ev).toBeDefined();
        (0, vitest_1.expect)(ev.clientId).toBe("c1");
        (0, vitest_1.expect)(ev.event.type).toBe("agent_end");
    });
    (0, vitest_1.it)("REGISTER ack 后发送 STATUS_REPORT 与 PI_STATE，PI_STATE ack 清理 terminal", async () => {
        const { socket, emitCalls } = fakeSocket();
        const { deps, emitMessage } = await makeDeps();
        const bridge = (0, index_js_1.attachPiBridge)(socket, deps);
        // 先产生一个 terminal（活动回合 + agent_settled）
        const result = await deps.supervisor.request({
            requestId: "r3",
            action: "agent.prompt",
            cwdRef: { rootDir: roots[0], relativePath: "proj" },
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            payload: { prompt: "hi" },
        });
        (0, vitest_1.expect)(result).toMatchObject({ ok: true });
        emitMessage({
            type: "event",
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            event: { type: "agent_settled", sessionId: "s1" },
        });
        (0, vitest_1.expect)(deps.supervisor.getStateReport().runs.some((r) => r.jobId === "j1")).toBe(true);
        // 触发注册完成
        await bridge.onConnected();
        const registerCall = emitCalls.find((c) => c.event === shared_1.Events.REGISTER);
        (0, vitest_1.expect)(registerCall).toBeDefined();
        const registerPayload = registerCall?.args[0];
        (0, vitest_1.expect)(registerPayload.capabilities).toContain("agent.pi");
        // 调用 REGISTER 的 ack callback
        const registerAck = registerCall?.args[1];
        registerAck();
        const statusCall = emitCalls.find((c) => c.event === shared_1.Events.STATUS_REPORT);
        (0, vitest_1.expect)(statusCall).toBeDefined();
        const stateCall = emitCalls.find((c) => c.event === shared_1.Events.PI_STATE);
        (0, vitest_1.expect)(stateCall).toBeDefined();
        const statePayload = stateCall?.args[0];
        (0, vitest_1.expect)(statePayload.runs.some((r) => r.jobId === "j1")).toBe(true);
        // 调用 PI_STATE 的 ack → terminal 清理
        const stateAck = stateCall?.args[1];
        stateAck({ acceptedRunIds: ["j1"] });
        (0, vitest_1.expect)(deps.supervisor.getStateReport().runs.some((r) => r.jobId === "j1")).toBe(false);
    });
    (0, vitest_1.it)("每次 reconnect 的 REGISTER ack 都重新发送 PI_STATE", async () => {
        const { socket, emitCalls } = fakeSocket();
        const { deps } = await makeDeps();
        const bridge = (0, index_js_1.attachPiBridge)(socket, deps);
        await bridge.onConnected();
        emitCalls.filter((call) => call.event === shared_1.Events.REGISTER)[0]
            .args[1]();
        await bridge.onConnected();
        emitCalls.filter((call) => call.event === shared_1.Events.REGISTER)[1]
            .args[1]();
        (0, vitest_1.expect)(emitCalls.filter((call) => call.event === shared_1.Events.PI_STATE)).toHaveLength(2);
    });
    (0, vitest_1.it)("closed abort 首次失败后重试成功并再次报告 PI_STATE", async () => {
        vitest_1.vi.useFakeTimers();
        const { socket, emitCalls } = fakeSocket();
        const { deps } = await makeDeps();
        vitest_1.vi.spyOn(deps.supervisor, "applyStateAck")
            .mockResolvedValueOnce({ allClosed: false })
            .mockResolvedValueOnce({ allClosed: true });
        const bridge = (0, index_js_1.attachPiBridge)(socket, deps);
        await bridge.onConnected();
        emitCalls.find((call) => call.event === shared_1.Events.REGISTER)
            .args[1]();
        const firstAck = emitCalls.filter((call) => call.event === shared_1.Events.PI_STATE)[0].args[1];
        await firstAck({
            acceptedRunIds: [],
            closedRunIds: ["run-1"],
            reportAgain: true,
        });
        await vitest_1.vi.advanceTimersByTimeAsync(100);
        const secondAck = emitCalls.filter((call) => call.event === shared_1.Events.PI_STATE)[1].args[1];
        await secondAck({
            acceptedRunIds: [],
            closedRunIds: ["run-1"],
            reportAgain: true,
        });
        (0, vitest_1.expect)(deps.supervisor.applyStateAck).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(emitCalls.filter((call) => call.event === shared_1.Events.PI_STATE)).toHaveLength(3);
        (0, vitest_1.expect)(socket.disconnect).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("closed abort 重试耗尽后 disconnect 并显式 connect", async () => {
        vitest_1.vi.useFakeTimers();
        const { socket, emitCalls } = fakeSocket();
        const { deps } = await makeDeps();
        vitest_1.vi.spyOn(deps.supervisor, "applyStateAck").mockResolvedValue({
            allClosed: false,
        });
        const bridge = (0, index_js_1.attachPiBridge)(socket, deps);
        await bridge.onConnected();
        emitCalls.find((call) => call.event === shared_1.Events.REGISTER)
            .args[1]();
        for (let attempt = 0; attempt < 3; attempt++) {
            const ack = emitCalls.filter((call) => call.event === shared_1.Events.PI_STATE)[attempt].args[1];
            await ack({
                acceptedRunIds: [],
                closedRunIds: ["run-1"],
                reportAgain: true,
            });
            await vitest_1.vi.advanceTimersByTimeAsync(100);
        }
        (0, vitest_1.expect)(socket.disconnect).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(socket.connect).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("旧 generation reconnect timer 不扰动新代次", async () => {
        vitest_1.vi.useFakeTimers();
        const { socket, emitCalls } = fakeSocket();
        const { deps } = await makeDeps();
        vitest_1.vi.spyOn(deps.supervisor, "applyStateAck").mockResolvedValue({
            allClosed: false,
        });
        const bridge = (0, index_js_1.attachPiBridge)(socket, deps);
        await bridge.onConnected();
        emitCalls.find((call) => call.event === shared_1.Events.REGISTER)
            .args[1]();
        for (let attempt = 0; attempt < 3; attempt++) {
            const ack = emitCalls.filter((call) => call.event === shared_1.Events.PI_STATE)[attempt].args[1];
            await ack({
                acceptedRunIds: [],
                closedRunIds: ["run-1"],
                reportAgain: true,
            });
            if (attempt < 2)
                await vitest_1.vi.advanceTimersByTimeAsync(100);
        }
        await bridge.onConnected();
        await vitest_1.vi.advanceTimersByTimeAsync(100);
        (0, vitest_1.expect)(socket.connect).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("同 generation 已连接时 reconnect timer 不重复连接", async () => {
        vitest_1.vi.useFakeTimers();
        const { socket, emitCalls } = fakeSocket();
        const { deps } = await makeDeps();
        vitest_1.vi.spyOn(deps.supervisor, "applyStateAck").mockResolvedValue({
            allClosed: false,
        });
        const bridge = (0, index_js_1.attachPiBridge)(socket, deps);
        await bridge.onConnected();
        emitCalls.find((call) => call.event === shared_1.Events.REGISTER)
            .args[1]();
        for (let attempt = 0; attempt < 3; attempt++) {
            const ack = emitCalls.filter((call) => call.event === shared_1.Events.PI_STATE)[attempt].args[1];
            await ack({
                acceptedRunIds: [],
                closedRunIds: ["run-1"],
                reportAgain: true,
            });
            if (attempt < 2)
                await vitest_1.vi.advanceTimersByTimeAsync(100);
        }
        socket.connected = true;
        await vitest_1.vi.advanceTimersByTimeAsync(100);
        (0, vitest_1.expect)(socket.connect).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("旧 Server 'ack' event 也能触发注册后流程", async () => {
        const { socket, emitCalls, listeners } = fakeSocket();
        const { deps } = await makeDeps();
        const bridge = (0, index_js_1.attachPiBridge)(socket, deps);
        await bridge.onConnected();
        fire(listeners, "ack", { event: shared_1.Events.REGISTER });
        (0, vitest_1.expect)(emitCalls.some((c) => c.event === shared_1.Events.STATUS_REPORT)).toBe(true);
        (0, vitest_1.expect)(emitCalls.some((c) => c.event === shared_1.Events.PI_STATE)).toBe(true);
    });
});
function fire(listeners, event, ...args) {
    for (const cb of listeners.get(event) ?? [])
        cb(...args);
}
