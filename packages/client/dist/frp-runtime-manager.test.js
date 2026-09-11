"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_events_1 = require("node:events");
const vitest_1 = require("vitest");
const frp_runtime_manager_js_1 = require("./frp-runtime-manager.js");
class FakeChild extends node_events_1.EventEmitter {
    stderr = new node_events_1.EventEmitter();
    kill = vitest_1.vi.fn(() => true);
}
const children = [];
const spawnMock = vitest_1.vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
});
const writeConfigMock = vitest_1.vi.fn();
const stateSpy = vitest_1.vi.fn();
const logSpy = vitest_1.vi.fn();
function makePayload(mappings, overrides = {}) {
    return {
        connectionGeneration: "conn-1",
        expectedRuntimeGeneration: 1,
        attempt: 0,
        timeoutSeconds: 30,
        frpsInfo: { serverAddr: "frps.example.com", serverPort: 7000, authToken: "secret" },
        mappings,
        preservedMappings: [],
        ...overrides,
    };
}
const mappingOne = {
    mappingId: "fm_1",
    name: "tcp-1919",
    proxyType: "tcp",
    localIp: "127.0.0.1",
    localPort: 1919,
    remotePort: 20000,
    customDomain: null,
};
const mappingTwo = {
    mappingId: "fm_2",
    name: "tcp-2020",
    proxyType: "tcp",
    localIp: "127.0.0.1",
    localPort: 2020,
    remotePort: 20001,
    customDomain: null,
};
function createManager() {
    return (0, frp_runtime_manager_js_1.createFrpRuntimeManager)({
        resolveExecutable: () => "/tmp/frpc",
        workDir: "/tmp/frp",
        spawn: spawnMock,
        writeConfigAtomically: writeConfigMock,
        delays: [0, 5_000, 30_000],
        onState: stateSpy,
        log: logSpy,
    });
}
(0, vitest_1.describe)("FrpRuntimeManager", () => {
    (0, vitest_1.beforeEach)(() => {
        children.length = 0;
        spawnMock.mockClear();
        writeConfigMock.mockClear();
        stateSpy.mockClear();
        logSpy.mockClear();
    });
    (0, vitest_1.it)("批量 reconcile 只写一次完整配置并只 spawn 一次", async () => {
        const manager = createManager();
        const payload = makePayload([mappingOne, mappingTwo]);
        const applied = manager.reconcile(payload);
        children.at(-1)?.emit("spawn");
        await (0, vitest_1.expect)(applied).resolves.toMatchObject({
            runtimeGeneration: 1,
            status: "running",
            loadedMappingIds: ["fm_1", "fm_2"],
        });
        (0, vitest_1.expect)(writeConfigMock).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(spawnMock).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("计划内替换不启动异常重试，旧 child exit 不清空新 child", async () => {
        const manager = createManager();
        const p1 = makePayload([mappingOne]);
        const first = manager.reconcile(p1);
        children.at(-1)?.emit("spawn");
        await first;
        const p2 = makePayload([mappingOne, mappingTwo]);
        const replacing = manager.reconcile(p2);
        children.at(-1)?.emit("spawn");
        await replacing;
        children[0].emit("exit", 0, "SIGTERM");
        (0, vitest_1.expect)(manager.getStateReport("c1").status).toBe("running");
        (0, vitest_1.expect)(spawnMock).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)("在线 frpc 异常退出由 Client 独占立即/5s/30s 三次重启", async () => {
        vitest_1.vi.useFakeTimers();
        const manager = createManager();
        const p1 = makePayload([mappingOne]);
        const first = manager.reconcile(p1);
        children.at(-1)?.emit("spawn");
        await first;
        children[0].emit("exit", 1, null);
        await vitest_1.vi.advanceTimersByTimeAsync(0);
        (0, vitest_1.expect)(spawnMock).toHaveBeenCalledTimes(2);
        children[1].emit("error", new Error("first"));
        await vitest_1.vi.advanceTimersByTimeAsync(5_000);
        children[2].emit("error", new Error("second"));
        await vitest_1.vi.advanceTimersByTimeAsync(30_000);
        children[3].emit("error", new Error("third"));
        await vitest_1.vi.runAllTimersAsync();
        (0, vitest_1.expect)(manager.getStateReport("c1")).toMatchObject({
            status: "failed",
            recoveryOwner: "client",
            attempt: 2,
        });
        (0, vitest_1.expect)(spawnMock).toHaveBeenCalledTimes(4);
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("reconcile 本地失败后恢复旧 registry/config", async () => {
        const manager = createManager();
        const p1 = makePayload([mappingOne]);
        const first = manager.reconcile(p1);
        children.at(-1)?.emit("spawn");
        await first;
        const p2 = makePayload([mappingOne, mappingTwo]);
        const failing = manager.reconcile(p2);
        children.at(-1)?.emit("error", new Error("spawn failed"));
        await (0, vitest_1.expect)(failing).rejects.toThrow();
        const list = manager.list();
        (0, vitest_1.expect)(list.mappings).toHaveLength(1);
        (0, vitest_1.expect)(list.mappings[0].id).toBe("fm_1");
    }, 10_000);
    (0, vitest_1.it)("shutdown 取消 timer", async () => {
        vitest_1.vi.useFakeTimers();
        const manager = createManager();
        const p1 = makePayload([mappingOne]);
        const first = manager.reconcile(p1);
        children.at(-1)?.emit("spawn");
        await first;
        children[0].emit("exit", 1, null);
        await vitest_1.vi.advanceTimersByTimeAsync(0);
        await manager.shutdown();
        await vitest_1.vi.runAllTimersAsync();
        (0, vitest_1.expect)(spawnMock).toHaveBeenCalledTimes(2);
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("state report 不含 authToken/TOML/stderr", async () => {
        const manager = createManager();
        const p1 = makePayload([mappingOne]);
        const first = manager.reconcile(p1);
        children.at(-1)?.emit("spawn");
        await first;
        const report = manager.getStateReport("c1");
        const json = JSON.stringify(report);
        (0, vitest_1.expect)(json).not.toContain("secret");
        (0, vitest_1.expect)(json).not.toContain("authToken");
        (0, vitest_1.expect)(json).not.toContain("auth.token");
    });
    (0, vitest_1.it)("不同 connection generation 的 payload 被 FRP_RUNTIME_GENERATION_STALE 拒绝", async () => {
        const manager = createManager();
        const p1 = makePayload([mappingOne]);
        const first = manager.reconcile(p1);
        children.at(-1)?.emit("spawn");
        await first;
        const stale = manager.reconcile(makePayload([mappingOne], { connectionGeneration: "conn-old" }));
        await (0, vitest_1.expect)(stale).rejects.toThrow(/STALE|stale|generation/i);
    }, 10_000);
});
