"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const frp_socket_bridge_js_1 = require("./frp-socket-bridge.js");
const dispatcher_js_1 = require("./dispatcher.js");
const update_js_1 = require("./update.js");
const frpc_daemon_js_1 = require("./frpc-daemon.js");
// dispatcher 测试用：隔离 frpc-daemon 真实模块（避免 client-id 文件副作用与真实 spawn）。
vitest_1.vi.mock("./frpc-daemon.js", () => ({
    isFrpAvailable: () => true,
    getFrpRuntimeManager: vitest_1.vi.fn(),
    getFrpRuntimeState: vitest_1.vi.fn(),
    setFrpConnectionGeneration: vitest_1.vi.fn(),
    subscribeFrpRuntimeState: vitest_1.vi.fn(() => () => { }),
    handleFrpCreate: vitest_1.vi.fn(async () => { }),
    handleFrpDelete: vitest_1.vi.fn(async () => { }),
    handleFrpList: vitest_1.vi.fn(),
    handleFrpReconcile: vitest_1.vi.fn(async () => { }),
    shutdownFrpRuntime: vitest_1.vi.fn(async () => { }),
}));
function makeSocket() {
    const handlers = {};
    const emitted = [];
    return {
        connected: true,
        on: vitest_1.vi.fn((ev, fn) => {
            if (handlers[ev] === undefined)
                handlers[ev] = [];
            handlers[ev]?.push(fn);
        }),
        off: vitest_1.vi.fn((ev, fn) => {
            handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn);
        }),
        emit: vitest_1.vi.fn((ev, data, cb) => {
            emitted.push([ev, data, cb]);
        }),
        fire(ev, ...args) {
            for (const h of handlers[ev] ?? [])
                h(...args);
        },
        emitted,
    };
}
function fakeManager() {
    let generation = "";
    const report = (clientId) => ({
        clientId,
        connectionGeneration: generation,
        runtimeGeneration: 0,
        status: "stopped",
        processRunning: false,
        recoveryOwner: null,
        attempt: 0,
        frpsEndpoint: null,
        mappings: [],
    });
    return {
        reconcile: vitest_1.vi.fn(async () => ({
            connectionGeneration: generation,
            runtimeGeneration: 1,
            status: "running",
            loadedMappingIds: [],
        })),
        create: vitest_1.vi.fn(),
        delete: vitest_1.vi.fn(),
        list: () => ({ mappings: [] }),
        isAvailable: () => true,
        getStateReport: (clientId) => report(clientId),
        setConnectionGeneration: (value) => {
            generation = value;
        },
        subscribe: () => () => { },
        shutdown: vitest_1.vi.fn(async () => { }),
    };
}
function emitted(socket, event) {
    return socket.emitted.filter(([ev]) => ev === event).map(([, data]) => data);
}
// 文件级：避免 register 模块（经 frpc-daemon 链）读写 ~/.vcpdeck/client-id，并隔离 mock 调用计数。
(0, vitest_1.beforeEach)(() => {
    process.env.VCPDECK_CLIENT_ID = "test-client";
    vitest_1.vi.mocked(frpc_daemon_js_1.handleFrpReconcile).mockClear();
});
(0, vitest_1.afterEach)(() => {
    delete process.env.VCPDECK_CLIENT_ID;
    vitest_1.vi.useRealTimers();
});
(0, vitest_1.describe)("FRP socket 桥", () => {
    (0, vitest_1.it)("每次 REGISTER ack 生成新 connection generation 并上报安全快照", () => {
        const socket = makeSocket();
        const manager = fakeManager();
        const bridge = (0, frp_socket_bridge_js_1.attachFrpSocketBridge)(socket, {
            clientId: "c1",
            manager,
        });
        bridge.onConnected();
        socket.fire("ack", { event: shared_1.Events.REGISTER });
        const first = emitted(socket, shared_1.Events.FRP_STATE)[0];
        bridge.onConnected(); // 模拟重连
        socket.fire("ack", { event: shared_1.Events.REGISTER });
        const second = emitted(socket, shared_1.Events.FRP_STATE)[1];
        (0, vitest_1.expect)(first.connectionGeneration).not.toBe(second.connectionGeneration);
        (0, vitest_1.expect)(JSON.stringify(second)).not.toContain("authToken");
        (0, vitest_1.expect)(JSON.stringify(second)).not.toContain("frpc-combined.toml");
    });
    (0, vitest_1.it)("旧 Server 不发 FRP ack 时不从磁盘或空 registry 自恢复", () => {
        const socket = makeSocket();
        const manager = fakeManager();
        const bridge = (0, frp_socket_bridge_js_1.attachFrpSocketBridge)(socket, {
            clientId: "c1",
            manager,
        });
        bridge.onConnected();
        socket.fire("ack", { event: shared_1.Events.REGISTER });
        (0, vitest_1.expect)(manager.reconcile).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("严格忽略非法 ack 与旧 connection generation 的 ack", () => {
        const socket = makeSocket();
        const manager = fakeManager();
        const bridge = (0, frp_socket_bridge_js_1.attachFrpSocketBridge)(socket, {
            clientId: "c1",
            manager,
        });
        bridge.onConnected();
        socket.fire("ack", { event: shared_1.Events.REGISTER });
        const stateEmit = socket.emitted.find(([ev]) => ev === shared_1.Events.FRP_STATE);
        const ackCb = stateEmit[2];
        // 非法 ack（未知字段）静默忽略。
        (0, vitest_1.expect)(() => ackCb({ connectionGeneration: "x", accepted: true, action: "weird" })).not.toThrow();
        // 旧 connection generation 的 ack 忽略（manager 不因此触发恢复）。
        const stale = {
            connectionGeneration: "conn-old",
            accepted: true,
            action: "server-reconciling",
        };
        (0, vitest_1.expect)(() => ackCb(stale)).not.toThrow();
        // 新 Server 直发 FRP_STATE_ACK 事件也走同一严格解析。
        socket.fire(shared_1.Events.FRP_STATE_ACK, stale);
        (0, vitest_1.expect)(manager.reconcile).not.toHaveBeenCalled();
    });
});
(0, vitest_1.describe)("dispatcher frp.reconcile 路由", () => {
    (0, vitest_1.it)("dispatch({ type: 'frp.reconcile' }) 调用 handleFrpReconcile 一次", () => {
        const socket = makeSocket();
        (0, dispatcher_js_1.dispatch)({
            jobId: "job-reconcile",
            type: "frp.reconcile",
            payload: { connectionGeneration: "conn-1" },
        }, socket);
        (0, vitest_1.expect)(frpc_daemon_js_1.handleFrpReconcile).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(frpc_daemon_js_1.handleFrpReconcile).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ _jobId: "job-reconcile" }), vitest_1.expect.anything());
    });
    (0, vitest_1.it)("draining 期间 frp.reconcile 仍走现有 CLIENT_UPDATING 拒绝", () => {
        const updateSocket = makeSocket();
        (0, update_js_1.attachUpdateHandler)({
            socket: updateSocket,
            launcher: {
                prepareUpdate: async () => { },
                // apply 挂起：draining 保持 true，模拟 launcher 接管前的窗口。
                applyUpdate: () => new Promise(() => { }),
            },
            serverBase: "http://localhost:3001",
        });
        // 通过注册的 UPDATE_REQUEST handler 触发 draining。
        updateSocket.fire(shared_1.Events.UPDATE_REQUEST, {
            releaseVersion: "1.0.0",
            url: "/api/releases/1.0.0/file",
            sha256: "a".repeat(64),
        });
        const socket = makeSocket();
        (0, dispatcher_js_1.dispatch)({
            jobId: "job-reconcile-2",
            type: "frp.reconcile",
            payload: { connectionGeneration: "conn-1" },
        }, socket);
        const done = emitted(socket, shared_1.Events.JOB_DONE)[0];
        (0, vitest_1.expect)(done.error?.code).toBe("CLIENT_UPDATING");
        (0, vitest_1.expect)(frpc_daemon_js_1.handleFrpReconcile).not.toHaveBeenCalled();
    });
});
