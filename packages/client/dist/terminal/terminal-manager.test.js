"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const terminal_manager_js_1 = require("./terminal-manager.js");
const shared_1 = require("@vcpdeck/shared");
// ── fake PTY ──
let ptyCounter = 0;
class FakePty {
    pid = 5000 + ptyCounter++;
    writes = [];
    resizes = [];
    killed = false;
    exited = false;
    dataCbs = [];
    exitCbs = [];
    write(d) {
        this.writes.push(d);
    }
    resize(cols, rows) {
        this.resizes.push([cols, rows]);
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
        this.exited = true;
        for (const cb of this.exitCbs)
            cb(code);
    }
}
function makeShells() {
    return [
        { id: "pwsh", label: "pwsh", kind: "pwsh", executable: "C:\\pwsh.exe", args: ["-NoLogo"], isDefault: true },
        { id: "bash", label: "bash", kind: "bash", executable: "/usr/bin/bash", args: [], isDefault: false },
    ];
}
function makeHarness(overrides = {}) {
    const spawned = [];
    const outputs = [];
    const ended = [];
    const killedTrees = [];
    const manager = (0, terminal_manager_js_1.createTerminalManager)({
        shells: makeShells(),
        cwd: "/home/dev",
        generationId: "g1",
        onOutput: (chunk) => outputs.push(chunk),
        onSessionEnded: (info) => ended.push(info),
        spawnPty: (opts) => {
            const pty = new FakePty();
            pty.resizes.push([opts.cols, opts.rows]);
            spawned.push(pty);
            return pty;
        },
        killTree: async (pid) => {
            killedTrees.push(pid);
        },
        ...overrides,
    });
    return { manager, spawned, outputs, ended, killedTrees };
}
(0, vitest_1.beforeEach)(() => {
    vitest_1.vi.useFakeTimers();
});
(0, vitest_1.afterEach)(() => {
    vitest_1.vi.useRealTimers();
});
(0, vitest_1.describe)("create", () => {
    (0, vitest_1.it)("按 shellId 创建 PTY，携带固定 args/cwd/env，并设置初始尺寸", async () => {
        const h = makeHarness();
        const result = await h.manager.create({ shellId: "pwsh", cols: 120, rows: 30 });
        (0, vitest_1.expect)(result.sessionId).toBeTruthy();
        const pty = h.spawned[0];
        (0, vitest_1.expect)(pty).toBeTruthy();
        (0, vitest_1.expect)(pty.resizes[0]).toEqual([120, 30]);
    });
    (0, vitest_1.it)("拒绝未知 shellId（TERMINAL_SHELL_NOT_AVAILABLE）", async () => {
        const h = makeHarness();
        await (0, vitest_1.expect)(h.manager.create({ shellId: "fish", cols: 80, rows: 24 })).rejects.toMatchObject({
            code: "TERMINAL_SHELL_NOT_AVAILABLE",
        });
    });
    (0, vitest_1.it)("spawn 失败映射为 TERMINAL_PTY_SPAWN_FAILED", async () => {
        const h = makeHarness({
            spawnPty: () => {
                throw new Error("spawn ENOENT");
            },
        });
        await (0, vitest_1.expect)(h.manager.create({ shellId: "bash", cols: 80, rows: 24 })).rejects.toMatchObject({
            code: "TERMINAL_PTY_SPAWN_FAILED",
        });
    });
    (0, vitest_1.it)("第 6 个活跃会话被拒绝，终态后释放名额", async () => {
        const h = makeHarness();
        const ids = [];
        for (let i = 0; i < shared_1.TerminalLimits.maxSessionsPerClient; i++) {
            const r = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
            ids.push(r.sessionId);
        }
        await (0, vitest_1.expect)(h.manager.create({ shellId: "bash", cols: 80, rows: 24 })).rejects.toMatchObject({
            code: "TERMINAL_SESSION_LIMIT_REACHED",
        });
        // 终态（exit）释放名额
        h.spawned[0]?.emitExit(0);
        const r = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        (0, vitest_1.expect)(r.sessionId).toBeTruthy();
        (0, vitest_1.expect)(ids).toHaveLength(5);
    });
});
(0, vitest_1.describe)("input / resize", () => {
    (0, vitest_1.it)("input 原样写入 PTY；超限按 UTF-8 字节拒绝", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        await h.manager.input(sessionId, "ls -la\r");
        (0, vitest_1.expect)(h.spawned[0]?.writes).toEqual(["ls -la\r"]);
        await (0, vitest_1.expect)(h.manager.input(sessionId, "x".repeat(shared_1.TerminalLimits.maxInputBytes + 1))).rejects.toMatchObject({ code: "TERMINAL_INPUT_TOO_LARGE" });
    });
    (0, vitest_1.it)("resize 调用 PTY 并校验尺寸", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        await h.manager.resize(sessionId, 100, 40);
        (0, vitest_1.expect)(h.spawned[0]?.resizes).toContainEqual([100, 40]);
        await (0, vitest_1.expect)(h.manager.resize(sessionId, 5, 2)).rejects.toMatchObject({
            code: "TERMINAL_PROTOCOL_INVALID",
        });
    });
    (0, vitest_1.it)("未知 session 的 input/resize 返回 TERMINAL_SESSION_NOT_FOUND", async () => {
        const h = makeHarness();
        await (0, vitest_1.expect)(h.manager.input("nope", "x")).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
        await (0, vitest_1.expect)(h.manager.resize("nope", 80, 24)).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
    });
});
(0, vitest_1.describe)("输出 seq / 切分 / 批量", () => {
    (0, vitest_1.it)("输出产生严格单调 seq；小块按 flush 窗口合并", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const pty = h.spawned[0];
        pty.emitData("a");
        pty.emitData("b");
        (0, vitest_1.expect)(h.outputs).toHaveLength(0); // 窗口未到
        await vitest_1.vi.advanceTimersByTimeAsync(20);
        (0, vitest_1.expect)(h.outputs).toHaveLength(1);
        (0, vitest_1.expect)(h.outputs[0]).toEqual({ sessionId, seq: 1, data: "ab" });
    });
    (0, vitest_1.it)("超过 64 KiB 的块被切分且 seq 递增", async () => {
        const h = makeHarness();
        await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const big = "x".repeat(shared_1.TerminalLimits.maxOutputChunkBytes + 10);
        h.spawned[0]?.emitData(big);
        await vitest_1.vi.advanceTimersByTimeAsync(20);
        (0, vitest_1.expect)(h.outputs.length).toBeGreaterThanOrEqual(2);
        (0, vitest_1.expect)(h.outputs[0]?.seq).toBe(1);
        (0, vitest_1.expect)(h.outputs[1]?.seq).toBe(2);
        (0, vitest_1.expect)(h.outputs[0]?.data).toHaveLength(shared_1.TerminalLimits.maxOutputChunkBytes);
    });
    (0, vitest_1.it)("空输出不产生 chunk", async () => {
        const h = makeHarness();
        await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        h.spawned[0]?.emitData("");
        await vitest_1.vi.advanceTimersByTimeAsync(20);
        (0, vitest_1.expect)(h.outputs).toHaveLength(0);
    });
});
(0, vitest_1.describe)("detach / attach / 30 分钟过期", () => {
    (0, vitest_1.it)("最后 detach 后 29:59 不关闭，30:00 自动过期并清理", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const pty = h.spawned[0];
        await h.manager.detach(sessionId);
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.detachedTtlMs - 1000);
        (0, vitest_1.expect)(pty.killed).toBe(false);
        await vitest_1.vi.advanceTimersByTimeAsync(2000);
        (0, vitest_1.expect)(pty.killed).toBe(true);
        (0, vitest_1.expect)(h.killedTrees).toContain(pty.pid);
        (0, vitest_1.expect)(h.ended).toContainEqual(vitest_1.expect.objectContaining({ sessionId, reason: "expired" }));
    });
    (0, vitest_1.it)("30 分钟内 reattach 取消过期计时", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const pty = h.spawned[0];
        await h.manager.detach(sessionId);
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.detachedTtlMs - 1000);
        await h.manager.attach(sessionId);
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.detachedTtlMs);
        (0, vitest_1.expect)(pty.killed).toBe(false);
    });
    (0, vitest_1.it)("Server 断线：live 会话进入 detached 计时但不立即 kill，重连 attach 恢复", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const pty = h.spawned[0];
        h.manager.handleServerDisconnect();
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.detachedTtlMs - 1000);
        (0, vitest_1.expect)(pty.killed).toBe(false);
        await h.manager.attach(sessionId);
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.detachedTtlMs);
        (0, vitest_1.expect)(pty.killed).toBe(false);
    });
});
(0, vitest_1.describe)("终态竞态与幂等", () => {
    (0, vitest_1.it)("close 幂等：重复 close 只 settle 一次", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const pty = h.spawned[0];
        await h.manager.close(sessionId, "closed");
        await h.manager.close(sessionId, "closed");
        (0, vitest_1.expect)(pty.killed).toBe(true);
        (0, vitest_1.expect)(h.ended.filter((e) => e.sessionId === sessionId)).toHaveLength(1);
        (0, vitest_1.expect)(h.ended[0]).toEqual({ sessionId, reason: "closed" });
    });
    (0, vitest_1.it)("exit 与 close 竞态：先到者胜，后到者忽略", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const pty = h.spawned[0];
        pty.emitExit(0);
        await h.manager.close(sessionId, "closed");
        (0, vitest_1.expect)(h.ended).toEqual([{ sessionId, reason: "exited", exitCode: 0 }]);
    });
    (0, vitest_1.it)("expiry 与 close 竞态：只产生一个终态", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const pty = h.spawned[0];
        await h.manager.detach(sessionId);
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.detachedTtlMs + 1000);
        await h.manager.close(sessionId, "closed");
        (0, vitest_1.expect)(h.ended.filter((e) => e.sessionId === sessionId)).toHaveLength(1);
        (0, vitest_1.expect)(h.ended[0]?.reason).toBe("expired");
    });
    (0, vitest_1.it)("过期后迟到输出不再产生 chunk", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        await h.manager.detach(sessionId);
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.detachedTtlMs + 1000);
        const before = h.outputs.length;
        h.spawned[0]?.emitData("late");
        await vitest_1.vi.advanceTimersByTimeAsync(30);
        (0, vitest_1.expect)(h.outputs.length).toBe(before);
    });
});
(0, vitest_1.describe)("headless 快照集成", () => {
    (0, vitest_1.it)("output 同时写入快照器；getSnapshot 与 output seq 一致", async () => {
        const snapshots = [];
        let snapSeq = 0;
        const h = makeHarness({
            createSnapshotter: () => ({
                write: (data, cb) => {
                    snapshots.push(data);
                    snapSeq += 1;
                    cb?.();
                },
                resize: () => undefined,
                snapshot: async () => ({
                    snapshot: snapshots.join(""),
                    snapshotSeq: snapSeq,
                    cols: 80,
                    rows: 24,
                    historyTruncated: false,
                }),
                dispose: () => undefined,
            }),
        });
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        h.spawned[0]?.emitData("hello");
        await vitest_1.vi.advanceTimersByTimeAsync(30);
        (0, vitest_1.expect)(snapshots).toEqual(["hello"]);
        (0, vitest_1.expect)(h.outputs[0]?.data).toBe("hello");
        const snap = await h.manager.getSnapshot(sessionId);
        (0, vitest_1.expect)(snap.snapshotSeq).toBe(1);
        (0, vitest_1.expect)(snap.snapshot).toBe("hello");
    });
    (0, vitest_1.it)("resize 同步到快照器", async () => {
        const resizes = [];
        const h = makeHarness({
            createSnapshotter: () => ({
                write: (_d, cb) => cb?.(),
                resize: (c, r) => void resizes.push([c, r]),
                snapshot: async () => ({
                    snapshot: "",
                    snapshotSeq: 0,
                    cols: 80,
                    rows: 24,
                    historyTruncated: false,
                }),
                dispose: () => undefined,
            }),
        });
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        await h.manager.resize(sessionId, 100, 40);
        (0, vitest_1.expect)(resizes).toContainEqual([100, 40]);
    });
    (0, vitest_1.it)("关闭后快照请求返回 TERMINAL_SESSION_NOT_FOUND", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        h.spawned[0]?.emitExit(0);
        await (0, vitest_1.expect)(h.manager.getSnapshot(sessionId)).rejects.toMatchObject({
            code: "TERMINAL_SESSION_NOT_FOUND",
        });
    });
});
(0, vitest_1.describe)("shutdown 与 state report", () => {
    (0, vitest_1.it)("shutdown 关闭所有活跃 PTY", async () => {
        const h = makeHarness();
        await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        await h.manager.shutdown();
        for (const pty of h.spawned)
            (0, vitest_1.expect)(pty.killed).toBe(true);
    });
    (0, vitest_1.it)("state report 携带 generationId 与 session 摘要，不含敏感字段", async () => {
        const h = makeHarness();
        await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        const report = h.manager.getStateReport();
        (0, vitest_1.expect)(report.generationId).toBe("g1");
        (0, vitest_1.expect)(report.sessions).toHaveLength(2);
        const json = JSON.stringify(report);
        (0, vitest_1.expect)(json).not.toContain("/home/dev");
        (0, vitest_1.expect)(json).not.toContain("cwd");
        (0, vitest_1.expect)(json).not.toContain("env");
        (0, vitest_1.expect)(report.sessions[0]?.status).toBe("active");
    });
    (0, vitest_1.it)("detach 后 state report 标记 detached 并带 expiresAt", async () => {
        const h = makeHarness();
        const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
        await h.manager.detach(sessionId);
        const report = h.manager.getStateReport();
        (0, vitest_1.expect)(report.sessions[0]?.status).toBe("detached");
        (0, vitest_1.expect)(report.sessions[0]?.detachedAt).toBeTruthy();
        (0, vitest_1.expect)(report.sessions[0]?.expiresAt).toBeTruthy();
    });
});
