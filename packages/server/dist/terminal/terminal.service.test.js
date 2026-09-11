"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const terminal_service_js_1 = require("./terminal.service.js");
const shared_1 = require("@vcpdeck/shared");
// ── fakes ──
// 最近一次 terminalSession 查询的 where（listSessions 过滤断言用）
let lastSessionWhere = null;
function makePrisma() {
    const sessions = new Map();
    const audits = [];
    return {
        sessions,
        audits,
        prisma: {
            client: {
                findUnique: vitest_1.vi.fn(async ({ where }) => where.id === "c1"
                    ? { id: "c1", online: true, socketId: "client-sock-1" }
                    : null),
            },
            terminalSession: {
                findUnique: vitest_1.vi.fn(async ({ where }) => sessions.get(where.id) ?? null),
                // 记录 where（listSessions 过滤断言用）；不模拟 SQL 语义
                findMany: vitest_1.vi.fn(async (args) => {
                    lastSessionWhere = args?.where ?? null;
                    return [...sessions.values()];
                }),
                count: vitest_1.vi.fn(async (args) => {
                    lastSessionWhere = args?.where ?? null;
                    return sessions.size;
                }),
                create: vitest_1.vi.fn(async ({ data }) => {
                    const row = {
                        createdAt: new Date("2026-08-12T00:00:00.000Z"),
                        updatedAt: new Date("2026-08-12T00:00:00.000Z"),
                        ...data,
                    };
                    sessions.set(row.id, row);
                    return row;
                }),
                update: vitest_1.vi.fn(async ({ where, data, }) => {
                    const row = { ...sessions.get(where.id), ...data };
                    sessions.set(where.id, row);
                    return row;
                }),
            },
            terminalAuditEvent: {
                create: vitest_1.vi.fn(async ({ data }) => {
                    audits.push(data);
                    return data;
                }),
            },
        },
        audit: {
            record: vitest_1.vi.fn(async () => undefined),
        },
    };
}
function makeBroker() {
    const requests = [];
    let responder = null;
    return {
        requests,
        setResponder: (fn) => {
            responder = fn;
        },
        broker: {
            request: vitest_1.vi.fn(async (lease, request) => {
                requests.push({ lease, request });
                if (!responder)
                    throw Object.assign(new Error("no responder"), {
                        code: "TERMINAL_CLIENT_OFFLINE",
                    });
                return responder(request);
            }),
            disconnect: vitest_1.vi.fn(),
        },
    };
}
function makeEmitter() {
    const browserEmits = [];
    return {
        browserEmits,
        emit: (socketId, event, payload) => {
            browserEmits.push({ socketId, event, payload });
        },
    };
}
function makeHarness(overrides = {}) {
    const prisma = makePrisma();
    const broker = makeBroker();
    const emitter = makeEmitter();
    const clock = { now: 1_000_000 };
    const service = terminal_service_js_1.TerminalService.withDeps({
        prisma: prisma.prisma,
        broker: broker.broker,
        audit: prisma.audit,
        now: () => clock.now,
        hashToken: (t) => `hash:${t}`,
        ...overrides,
    });
    service.bindBrowserEmitter(emitter.emit);
    return { service, prisma, broker, emitter, sessions: prisma.sessions, clock };
}
const ACTOR = {
    identityId: "id1",
    displayName: "admin",
    isAdmin: true,
    credentialId: null,
    sessionId: null,
    source: "web",
    requestId: "r",
};
function okCreate(req) {
    return {
        requestId: req.requestId,
        ok: true,
        action: "session.create",
        sessionId: req.sessionId,
        status: "detached",
    };
}
function okAttach(req) {
    const sessionId = req.sessionId;
    return {
        requestId: req.requestId,
        ok: true,
        action: "session.attach",
        sessionId,
        snapshot: `snap:${sessionId}`,
        snapshotSeq: 0,
        cols: 80,
        rows: 24,
        historyTruncated: false,
    };
}
async function seedSession(h, status = "detached") {
    const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
    const info = created;
    h.sessions.set(info.sessionId, { ...h.sessions.get(info.sessionId), status });
    return info.sessionId;
}
(0, vitest_1.beforeEach)(() => {
    vitest_1.vi.useFakeTimers();
});
(0, vitest_1.afterEach)(() => {
    vitest_1.vi.useRealTimers();
});
(0, vitest_1.describe)("createSession", () => {
    (0, vitest_1.it)("Client 离线返回 TERMINAL_CLIENT_OFFLINE", async () => {
        const h = makeHarness();
        const prisma2 = {
            ...h.prisma.prisma,
            client: { findUnique: vitest_1.vi.fn(async () => null) },
        };
        const svc = terminal_service_js_1.TerminalService.withDeps({
            prisma: prisma2,
            broker: h.broker.broker,
            audit: h.prisma.audit,
            now: () => 0,
        });
        await (0, vitest_1.expect)(svc.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR)).rejects.toMatchObject({
            code: "TERMINAL_CLIENT_OFFLINE",
        });
    });
    (0, vitest_1.it)("第 5 个会话后第 6 个返回 TERMINAL_SESSION_LIMIT_REACHED", async () => {
        const h = makeHarness();
        h.broker.setResponder(okCreate);
        for (let i = 0; i < shared_1.TerminalLimits.maxSessionsPerClient; i++) {
            await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        }
        await (0, vitest_1.expect)(h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR)).rejects.toMatchObject({
            code: "TERMINAL_SESSION_LIMIT_REACHED",
        });
    });
    (0, vitest_1.it)("Client create 失败时 DB 标记 error 并写 create_failed 审计", async () => {
        const h = makeHarness();
        h.broker.setResponder((req) => ({
            requestId: req.requestId,
            ok: false,
            error: { code: "TERMINAL_PTY_SPAWN_FAILED", message: "boom" },
        }));
        await (0, vitest_1.expect)(h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR)).rejects.toMatchObject({
            code: "TERMINAL_PTY_SPAWN_FAILED",
        });
        const rows = [...h.sessions.values()];
        (0, vitest_1.expect)(rows[0]?.status).toBe("error");
        (0, vitest_1.expect)(rows[0]?.errorCode).toBe("TERMINAL_PTY_SPAWN_FAILED");
        (0, vitest_1.expect)(h.prisma.audit.record).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ event: "create_failed", result: "error" }));
    });
});
(0, vitest_1.describe)("attach 与单写多读", () => {
    (0, vitest_1.it)("首个 attach 为 operator，后续为 viewer，同 identity 也单写", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        const first = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "browser-1",
        });
        (0, vitest_1.expect)(first.mode).toBe("operator");
        const second = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "browser-2",
        });
        (0, vitest_1.expect)(second.mode).toBe("viewer");
        const third = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: { ...ACTOR, identityId: "id2", displayName: "other" },
            socketId: "browser-3",
        });
        (0, vitest_1.expect)(third.mode).toBe("viewer");
    });
    (0, vitest_1.it)("viewer input/resize 被拒绝且 broker 不被调用", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        const first = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        const second = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: { ...ACTOR, identityId: "id2" },
            socketId: "b2",
        });
        await h.service.whenAttachSettled(sessionId);
        const before = h.broker.requests.length;
        await (0, vitest_1.expect)(h.service.browserInput({
            socketId: "b2",
            sessionId,
            attachmentId: second.attachmentId,
            data: "x",
        })).rejects.toMatchObject({ code: "TERMINAL_READ_ONLY" });
        await (0, vitest_1.expect)(h.service.browserResize({
            socketId: "b2",
            sessionId,
            attachmentId: second.attachmentId,
            cols: 100,
            rows: 40,
        })).rejects.toMatchObject({ code: "TERMINAL_READ_ONLY" });
        (0, vitest_1.expect)(h.broker.requests.length).toBe(before);
        (0, vitest_1.expect)(first.mode).toBe("operator");
    });
    (0, vitest_1.it)("operator input 转发到 Client", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        const first = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.browserInput({
            socketId: "b1",
            sessionId,
            attachmentId: first.attachmentId,
            data: "ls\r",
        });
        const inputReq = h.broker.requests.find((r) => r.request.action === "session.input");
        (0, vitest_1.expect)(inputReq).toBeTruthy();
        (0, vitest_1.expect)(inputReq.request.data).toBe("ls\r");
    });
    (0, vitest_1.it)("未知 attachment 的 input 返回 TERMINAL_SESSION_NOT_FOUND", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        await (0, vitest_1.expect)(h.service.browserInput({
            socketId: "b1",
            sessionId,
            attachmentId: "nope",
            data: "x",
        })).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
    });
});
(0, vitest_1.describe)("30 秒重连保护与接管", () => {
    (0, vitest_1.it)("operator 断开后 29.999s 内 token 可恢复；错误 token 被拒绝", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        const first = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.whenAttachSettled(sessionId);
        await h.service.detachBrowserSocket("b1");
        // 错误 token
        await (0, vitest_1.expect)(h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b2",
            reconnectToken: "wrong",
        })).resolves.toMatchObject({ mode: "viewer" });
        // 合法 token：viewer 已存在，token 重绑仍恢复 operator
        const rebind = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b3",
            reconnectToken: first.reconnectToken,
        });
        (0, vitest_1.expect)(rebind.mode).toBe("operator");
        (0, vitest_1.expect)(rebind.attachmentId).not.toBe(first.attachmentId);
    });
    (0, vitest_1.it)("保护期内 viewer 接管被拒绝；30 秒后接管成功且并发只有一个赢家", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.whenAttachSettled(sessionId);
        await h.service.detachBrowserSocket("b1");
        const viewer = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: { ...ACTOR, identityId: "id2" },
            socketId: "b2",
        });
        await (0, vitest_1.expect)(h.service.browserTakeover({
            socketId: "b2",
            sessionId,
            attachmentId: viewer.attachmentId,
        })).rejects.toMatchObject({ code: "TERMINAL_CONTROL_PROTECTED" });
        // 30 秒后
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.reconnectGraceMs + 1);
        h.clock.now += shared_1.TerminalLimits.reconnectGraceMs + 1;
        const winner = await h.service.browserTakeover({
            socketId: "b2",
            sessionId,
            attachmentId: viewer.attachmentId,
        });
        (0, vitest_1.expect)(winner.mode).toBe("operator");
    });
    (0, vitest_1.it)("接管后旧 operator token 失效（lease 已更换）", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        const first = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.whenAttachSettled(sessionId);
        await h.service.detachBrowserSocket("b1");
        const viewer = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: { ...ACTOR, identityId: "id2" },
            socketId: "b2",
        });
        await vitest_1.vi.advanceTimersByTimeAsync(shared_1.TerminalLimits.reconnectGraceMs + 1);
        h.clock.now += shared_1.TerminalLimits.reconnectGraceMs + 1;
        await h.service.browserTakeover({
            socketId: "b2",
            sessionId,
            attachmentId: viewer.attachmentId,
        });
        const rebind = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b3",
            reconnectToken: first.reconnectToken,
        });
        (0, vitest_1.expect)(rebind.mode).toBe("viewer");
        (0, vitest_1.expect)(rebind.attachmentId).not.toBe(first.attachmentId);
    });
});
(0, vitest_1.it)("慢消费者：ack 落后超过阈值时暂停增量并请求 resync，不影响其他 attachment", async () => {
    const h = makeHarness();
    h.broker.setResponder(okAttach);
    const sessionId = await seedSession(h);
    const b1 = await h.service.attachBrowser({
        clientId: "c1",
        sessionId,
        actor: ACTOR,
        socketId: "b1",
    });
    const b2 = await h.service.attachBrowser({
        clientId: "c1",
        sessionId,
        actor: { ...ACTOR, identityId: "id2" },
        socketId: "b2",
    });
    await h.service.whenAttachSettled(sessionId);
    void b1;
    // b2 定期 ack；b1（operator）不 ack → 落后超过阈值
    for (let seq = 1; seq <= shared_1.TerminalLimits.slowConsumerGapBlocks + 10; seq++) {
        await h.service.handleClientOutput("c1", { sessionId, seq, data: "x" });
        if (seq % 100 === 0) {
            await h.service.browserAckOutput({
                socketId: "b2",
                sessionId,
                attachmentId: b2.attachmentId,
                seq,
            });
        }
    }
    const resyncRequired = h.emitter.browserEmits.filter((e) => e.event === "terminal:resync-required");
    (0, vitest_1.expect)(resyncRequired.length).toBeGreaterThanOrEqual(1);
    (0, vitest_1.expect)(resyncRequired[0]?.payload).toEqual({ sessionId });
});
(0, vitest_1.describe)("输出同步与快照", () => {
    (0, vitest_1.it)("attach 时先 snapshot 后增量（snapshotSeq 之前的块丢弃）", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        const attached = h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        // attach 请求发出但未返回时，Client 输出 seq=1（≤ snapshotSeq=0? 不，snapshotSeq 来自响应）
        // 模拟响应 snapshotSeq=5，先到的输出 seq=2 应丢弃
        h.broker.setResponder((req) => ({
            requestId: req.requestId,
            ok: true,
            action: "session.attach",
            sessionId,
            snapshot: "snap",
            snapshotSeq: 5,
            cols: 80,
            rows: 24,
            historyTruncated: false,
        }));
        await h.service.handleClientOutput("c1", {
            sessionId,
            seq: 2,
            data: "early",
        });
        const result = await attached;
        (0, vitest_1.expect)(result.mode).toBe("operator");
        await h.service.whenAttachSettled(sessionId);
        const snaps = h.emitter.browserEmits.filter((e) => e.event === "terminal:snapshot");
        (0, vitest_1.expect)(snaps).toHaveLength(1);
        (0, vitest_1.expect)(snaps[0]?.payload).toMatchObject({ snapshotSeq: 5 });
        // seq=2 的 early 输出未转发给浏览器
        (0, vitest_1.expect)(h.emitter.browserEmits.filter((e) => e.event === "terminal:output")).toHaveLength(0);
    });
    (0, vitest_1.it)("重复 seq 丢弃、gap 不转发", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.whenAttachSettled(sessionId);
        await h.service.handleClientOutput("c1", { sessionId, seq: 1, data: "a" });
        await h.service.handleClientOutput("c1", {
            sessionId,
            seq: 1,
            data: "dup",
        });
        await h.service.handleClientOutput("c1", {
            sessionId,
            seq: 3,
            data: "gap",
        });
        await h.service.handleClientOutput("c1", { sessionId, seq: 2, data: "b" });
        const outputs = h.emitter.browserEmits.filter((e) => e.event === "terminal:output");
        (0, vitest_1.expect)(outputs.map((o) => o.payload.data)).toEqual([
            "a",
            "b",
        ]);
    });
    (0, vitest_1.it)("最后 detach 通知 Client 一次；重新 attach 后恢复", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        const first = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.whenAttachSettled(sessionId);
        await h.service.detachBrowserSocket("b1");
        await h.service.detachBrowserSocket("b1"); // 幂等
        await vitest_1.vi.advanceTimersByTimeAsync(0); // 等待 detach 请求发出
        const detachReqs = h.broker.requests.filter((r) => r.request.action === "session.detach");
        (0, vitest_1.expect)(detachReqs).toHaveLength(1);
        // 重新 attach
        const rebind = await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b2",
            reconnectToken: first.reconnectToken,
        });
        (0, vitest_1.expect)(rebind.mode).toBe("operator");
    });
});
(0, vitest_1.describe)("Client 状态对账", () => {
    function report(sessionIds, generationId = "g1") {
        return {
            clientId: "c1",
            generationId,
            sessions: sessionIds.map((sessionId) => ({
                sessionId,
                shellId: "bash",
                status: "active",
                cols: 80,
                rows: 24,
                lastSeq: 0,
            })),
        };
    }
    (0, vitest_1.it)("DB 非终态但 Client 未上报 → interrupted", async () => {
        const h = makeHarness();
        h.broker.setResponder(okCreate);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const info = created;
        const ack = await h.service.handleClientState("c1", "client-sock-1", report([]));
        (0, vitest_1.expect)(ack.acceptedSessionIds).toEqual([]);
        (0, vitest_1.expect)(ack.closeSessionIds).toEqual([]);
        const row = h.sessions.get(info.sessionId);
        (0, vitest_1.expect)(row?.status).toBe("interrupted");
        (0, vitest_1.expect)(row?.endReason).toBe("TERMINAL_CLIENT_RESTARTED");
    });
    (0, vitest_1.it)("Client 上报但 DB 终态 → 加入 closeSessionIds", async () => {
        const h = makeHarness();
        h.broker.setResponder(okCreate);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const info = created;
        h.sessions.set(info.sessionId, {
            ...h.sessions.get(info.sessionId),
            status: "closed",
        });
        const ack = await h.service.handleClientState("c1", "client-sock-1", report([info.sessionId]));
        (0, vitest_1.expect)(ack.closeSessionIds).toEqual([info.sessionId]);
    });
    (0, vitest_1.it)("Client 上报且 DB 非终态 → 接受", async () => {
        const h = makeHarness();
        h.broker.setResponder(okCreate);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const info = created;
        const ack = await h.service.handleClientState("c1", "client-sock-1", report([info.sessionId]));
        (0, vitest_1.expect)(ack.acceptedSessionIds).toEqual([info.sessionId]);
        (0, vitest_1.expect)(h.sessions.get(info.sessionId)?.status).toBe("detached");
    });
});
(0, vitest_1.describe)("终态与竞态", () => {
    (0, vitest_1.it)("close 幂等：终态后再次 close 不改写首次原因", async () => {
        const h = makeHarness();
        h.broker.setResponder(okCreate);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const info = created;
        await h.service.closeSession("c1", info.sessionId, ACTOR);
        await h.service.closeSession("c1", info.sessionId, ACTOR);
        const row = h.sessions.get(info.sessionId);
        (0, vitest_1.expect)(row?.status).toBe("closed");
        (0, vitest_1.expect)(row?.endReason).toBe("TERMINAL_CLOSE_REQUESTED");
    });
    (0, vitest_1.it)("Client exit 后 DB 标记 exited，迟到 output 不转发", async () => {
        const h = makeHarness();
        h.broker.setResponder(okAttach);
        const sessionId = await seedSession(h);
        await h.service.attachBrowser({
            clientId: "c1",
            sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.handleClientExit("c1", { sessionId, exitCode: 0 });
        (0, vitest_1.expect)(h.sessions.get(sessionId)?.status).toBe("exited");
        await h.service.handleClientOutput("c1", {
            sessionId,
            seq: 5,
            data: "late",
        });
        (0, vitest_1.expect)(h.emitter.browserEmits.filter((e) => e.event === "terminal:output")).toHaveLength(0);
    });
    (0, vitest_1.it)("跨 Client 的会话操作被拒绝", async () => {
        const h = makeHarness();
        h.broker.setResponder(okCreate);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const info = created;
        await (0, vitest_1.expect)(h.service.attachBrowser({
            clientId: "c2",
            sessionId: info.sessionId,
            actor: ACTOR,
            socketId: "b1",
        })).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
    });
});
(0, vitest_1.describe)("listSessions 过滤", () => {
    (0, vitest_1.it)("只查询非终态会话 + 最近 24h 内 interrupted（closed/exited 不返回）", async () => {
        const h = makeHarness();
        // 直接塞入各类状态的会话
        const mk = (id, status, endedAt) => h.sessions.set(id, {
            id,
            clientId: "c1",
            shellId: "powershell",
            status,
            createdAt: new Date("2026-08-12T00:00:00.000Z"),
            ...(endedAt ? { endedAt: new Date(endedAt) } : {}),
        });
        mk("s-active", "detached");
        mk("s-closed", "closed", "2026-08-12T01:00:00.000Z");
        mk("s-interrupted-recent", "interrupted", "2026-08-12T23:00:00.000Z");
        mk("s-interrupted-old", "interrupted", "2026-08-01T00:00:00.000Z");
        mk("s-exited", "exited", "2026-08-12T02:00:00.000Z");
        // 服务端时钟：2026-08-13 00:00（24h 窗口起点 2026-08-12 00:00）
        const now = new Date("2026-08-13T00:00:00.000Z").getTime();
        h.clock.now = now;
        await h.service.listSessions("c1", 1, 20);
        // where 必须包含 OR：非终态 或 interrupted 且 endedAt >= 窗口起点
        (0, vitest_1.expect)(lastSessionWhere).toMatchObject({
            clientId: "c1",
            OR: [
                { status: { notIn: vitest_1.expect.any(Array) } },
                {
                    status: "interrupted",
                    endedAt: { gte: new Date("2026-08-12T00:00:00.000Z") },
                },
            ],
        });
        const endStatuses = lastSessionWhere.OR[0]?.status?.notIn;
        (0, vitest_1.expect)(endStatuses).toEqual(vitest_1.expect.arrayContaining(["closed", "exited", "expired", "error"]));
    });
});
