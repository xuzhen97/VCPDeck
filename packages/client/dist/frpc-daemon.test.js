"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const spawned = [];
const spawnMock = vitest_1.vi.fn(() => {
    const child = new FakeChild();
    spawned.push(child);
    return child;
});
vitest_1.vi.mock("node:child_process", () => ({ spawn: spawnMock }));
class FakeChild extends node_events_1.EventEmitter {
    stderr = new node_events_1.EventEmitter();
    kill = vitest_1.vi.fn(() => true);
}
function socket() {
    return { emit: vitest_1.vi.fn() };
}
const frpsInfo = {
    serverAddr: "frps.example.com",
    serverPort: 7000,
    authToken: "token",
};
let root = "";
(0, vitest_1.beforeEach)(async () => {
    vitest_1.vi.resetModules();
    spawnMock.mockClear();
    spawned.length = 0;
    root = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "vcpdeck-frpc-"));
    const executable = (0, node_path_1.join)(root, "frpc.exe");
    (0, node_fs_1.writeFileSync)(executable, "test");
    process.env.VCPDECK_FRPC_PATH = executable;
    process.env.VCPDECK_FRPC_WORK_DIR = root;
    // 固定 CLIENT_ID，避免 register 模块在测试中读写 ~/.vcpdeck/client-id。
    process.env.VCPDECK_CLIENT_ID = "test-client";
});
(0, vitest_1.afterEach)(() => {
    delete process.env.VCPDECK_FRPC_PATH;
    delete process.env.VCPDECK_FRPC_WORK_DIR;
    delete process.env.VCPDECK_CLIENT_ID;
    (0, node_fs_1.rmSync)(root, { recursive: true, force: true });
});
(0, vitest_1.describe)("frpc daemon 原子更新", () => {
    (0, vitest_1.it)("create spawn 失败时撤销 registry 并回报安全错误", async () => {
        const { handleFrpCreate, handleFrpList } = await import("./frpc-daemon.js");
        const target = socket();
        const promise = handleFrpCreate({
            _jobId: "create-1",
            mappingId: "fm_1",
            name: "tcp-1919",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
            remotePort: 20000,
            frpsInfo,
        }, target);
        spawned[0]?.emit("error", new Error("C:/secret/path/frpc failed"));
        await promise;
        (0, vitest_1.expect)(target.emit).toHaveBeenCalledWith("job:done", vitest_1.expect.objectContaining({
            error: {
                code: "FRPC_START_FAILED",
                message: "frpc 启动失败",
            },
        }));
        const list = socket();
        handleFrpList({ _jobId: "list-1" }, list);
        (0, vitest_1.expect)(list.emit).toHaveBeenCalledWith("job:done", vitest_1.expect.objectContaining({ result: { mappings: [] } }));
    });
    (0, vitest_1.it)("新增第二个 proxy 启动失败时恢复旧 frpc", async () => {
        const { handleFrpCreate, handleFrpList } = await import("./frpc-daemon.js");
        const first = handleFrpCreate({
            _jobId: "create-1",
            mappingId: "fm_1",
            name: "tcp-1919",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
            remotePort: 20000,
            frpsInfo,
        }, socket());
        spawned.at(-1)?.emit("spawn");
        await first;
        const target = socket();
        const second = handleFrpCreate({
            _jobId: "create-2",
            mappingId: "fm_2",
            name: "tcp-2020",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 2020,
            remotePort: 20001,
            frpsInfo,
        }, target);
        spawned.at(-1)?.emit("error", new Error("restart failed"));
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(spawnMock).toHaveBeenCalledTimes(3));
        spawned.at(-1)?.emit("spawn");
        await second;
        const list = socket();
        handleFrpList({ _jobId: "list" }, list);
        (0, vitest_1.expect)(list.emit).toHaveBeenCalledWith("job:done", vitest_1.expect.objectContaining({
            result: {
                mappings: [vitest_1.expect.objectContaining({ id: "fm_1", status: "active" })],
            },
        }));
    });
    (0, vitest_1.it)("delete 重启失败时恢复被删除的 registry 并回报错误", async () => {
        const { handleFrpCreate, handleFrpDelete, handleFrpList } = await import("./frpc-daemon.js");
        for (const [mappingId, name, port] of [
            ["fm_1", "tcp-1919", 1919],
            ["fm_2", "tcp-2020", 2020],
        ]) {
            const promise = handleFrpCreate({
                _jobId: `create-${mappingId}`,
                mappingId,
                name,
                proxyType: "tcp",
                localIp: "127.0.0.1",
                localPort: port,
                remotePort: 20000 + port,
                frpsInfo,
            }, socket());
            spawned.at(-1)?.emit("spawn");
            await promise;
        }
        const target = socket();
        const deletion = handleFrpDelete({ _jobId: "delete-1", mappingId: "fm_1", name: "tcp-1919" }, target);
        spawned.at(-1)?.emit("error", new Error("restart failed"));
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(spawnMock).toHaveBeenCalledTimes(4));
        spawned.at(-1)?.emit("spawn");
        await deletion;
        (0, vitest_1.expect)(target.emit).toHaveBeenCalledWith("job:done", vitest_1.expect.objectContaining({
            error: { code: "FRPC_START_FAILED", message: "frpc 启动失败" },
        }));
        // 失败后恢复旧 registry 并再次启动原配置。
        const list = socket();
        handleFrpList({ _jobId: "list-1" }, list);
        (0, vitest_1.expect)(list.emit).toHaveBeenCalledWith("job:done", vitest_1.expect.objectContaining({
            result: {
                mappings: vitest_1.expect.arrayContaining([
                    vitest_1.expect.objectContaining({ id: "fm_1" }),
                    vitest_1.expect.objectContaining({ id: "fm_2" }),
                ]),
            },
        }));
    });
    (0, vitest_1.it)("reconcile 成功回报安全 result，不含 authToken", async () => {
        const { handleFrpReconcile } = await import("./frpc-daemon.js");
        const target = socket();
        const promise = handleFrpReconcile({
            _jobId: "reconcile-1",
            connectionGeneration: "conn-1",
            expectedRuntimeGeneration: 1,
            attempt: 0,
            timeoutSeconds: 30,
            frpsInfo,
            mappings: [
                {
                    mappingId: "fm_1",
                    name: "tcp-1919",
                    proxyType: "tcp",
                    localIp: "127.0.0.1",
                    localPort: 1919,
                    remotePort: 20000,
                    customDomain: null,
                },
            ],
            preservedMappings: [],
        }, target);
        spawned.at(-1)?.emit("spawn");
        await promise;
        const done = target.emit.mock.calls.find((call) => call[0] === "job:done")?.[1];
        (0, vitest_1.expect)(done.result).toMatchObject({
            status: "running",
            loadedMappingIds: ["fm_1"],
        });
        (0, vitest_1.expect)(JSON.stringify(done.result)).not.toContain("token");
        (0, vitest_1.expect)(JSON.stringify(done.result)).not.toContain("authToken");
    });
    (0, vitest_1.it)("reconcile payload 含未知字段时回报 FRP_RUNTIME_STATE_INVALID", async () => {
        const { handleFrpReconcile } = await import("./frpc-daemon.js");
        const target = socket();
        await handleFrpReconcile({
            _jobId: "reconcile-2",
            connectionGeneration: "conn-1",
            expectedRuntimeGeneration: 1,
            attempt: 0,
            timeoutSeconds: 30,
            frpsInfo,
            mappings: [],
            preservedMappings: [],
            extraField: "nope",
        }, target);
        (0, vitest_1.expect)(target.emit).toHaveBeenCalledWith("job:done", vitest_1.expect.objectContaining({
            error: vitest_1.expect.objectContaining({ code: "FRP_RUNTIME_STATE_INVALID" }),
        }));
    });
    (0, vitest_1.it)("旧 connection generation 的 reconcile 被 FRP_RUNTIME_GENERATION_STALE 拒绝", async () => {
        const { handleFrpReconcile, setFrpConnectionGeneration } = await import("./frpc-daemon.js");
        setFrpConnectionGeneration("conn-1");
        const mapping = {
            mappingId: "fm_1",
            name: "tcp-1919",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
            remotePort: 20000,
            customDomain: null,
        };
        const base = {
            expectedRuntimeGeneration: 1,
            attempt: 0,
            timeoutSeconds: 30,
            frpsInfo,
            mappings: [mapping],
            preservedMappings: [],
        };
        const first = socket();
        const firstDone = handleFrpReconcile({ _jobId: "r-1", connectionGeneration: "conn-1", ...base }, first);
        spawned.at(-1)?.emit("spawn");
        await firstDone;
        const stale = socket();
        const staleDone = handleFrpReconcile({ _jobId: "r-2", connectionGeneration: "conn-old", ...base }, stale);
        await staleDone;
        (0, vitest_1.expect)(stale.emit).toHaveBeenCalledWith("job:done", vitest_1.expect.objectContaining({
            error: vitest_1.expect.objectContaining({ code: "FRP_RUNTIME_GENERATION_STALE" }),
        }));
        (0, vitest_1.expect)(first.emit).toHaveBeenCalledWith("job:done", vitest_1.expect.objectContaining({ result: vitest_1.expect.objectContaining({ status: "running" }) }));
    });
});
