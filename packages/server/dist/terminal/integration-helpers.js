"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeMemoryPrisma = makeMemoryPrisma;
exports.makeFakeClient = makeFakeClient;
const vitest_1 = require("vitest");
/** 内存 Prisma（client + terminalSession + terminalAuditEvent）。 */
function makeMemoryPrisma() {
    const clients = new Map();
    const sessions = new Map();
    const audits = [];
    const now = () => new Date("2026-08-12T00:00:00.000Z");
    const withDefaults = (data) => ({
        createdAt: now(),
        updatedAt: now(),
        status: "starting",
        ...data,
    });
    return {
        clients,
        sessions,
        audits,
        prisma: {
            client: {
                findUnique: vitest_1.vi.fn(async ({ where }) => clients.get(where.id) ?? null),
            },
            terminalSession: {
                findUnique: vitest_1.vi.fn(async ({ where }) => sessions.get(where.id) ?? null),
                findMany: vitest_1.vi.fn(async ({ where } = {}) => {
                    if (!where)
                        return [...sessions.values()];
                    return [...sessions.values()].filter((s) => Object.entries(where).every(([k, v]) => {
                        if (k === "status" && typeof v === "object" && v !== null) {
                            const notIn = v.notIn;
                            if (notIn)
                                return !notIn.includes(s.status);
                        }
                        return s[k] === v;
                    }));
                }),
                count: vitest_1.vi.fn(async ({ where } = {}) => {
                    if (!where)
                        return sessions.size;
                    let total = 0;
                    for (const s of sessions.values()) {
                        let ok = true;
                        for (const [k, v] of Object.entries(where)) {
                            if (k === "status" && typeof v === "object" && v !== null) {
                                const notIn = v.notIn;
                                if (notIn && notIn.includes(s.status))
                                    ok = false;
                                continue;
                            }
                            if (s[k] !== v)
                                ok = false;
                        }
                        if (ok)
                            total += 1;
                    }
                    return total;
                }),
                create: vitest_1.vi.fn(async ({ data }) => {
                    const row = withDefaults(data);
                    sessions.set(row.id, row);
                    return row;
                }),
                update: vitest_1.vi.fn(async ({ where, data }) => {
                    const row = { ...(sessions.get(where.id) ?? {}), ...data, updatedAt: now() };
                    sessions.set(where.id, row);
                    return row;
                }),
            },
            terminalAuditEvent: {
                create: vitest_1.vi.fn(async ({ data }) => {
                    audits.push({ ...data, createdAt: now() });
                    return data;
                }),
                findMany: vitest_1.vi.fn(async () => []),
                count: vitest_1.vi.fn(async () => 0),
            },
        },
        audit: {
            record: vitest_1.vi.fn(async () => undefined),
        },
    };
}
/** fake Client：模拟 Client 桥（shells/create/attach/input/resize/close + 输出）。 */
function makeFakeClient() {
    const ptys = new Map();
    const receivedInput = [];
    let onOutput = null;
    let onClientResponse = null;
    const broker = new (class {
        emitter = null;
        pending = new Map();
        bindEmitter(fn) {
            this.emitter = fn;
        }
        request(lease, request) {
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    this.pending.delete(request.requestId);
                    resolve({ requestId: request.requestId, ok: false, error: { code: "TERMINAL_REQUEST_TIMEOUT", message: "timeout" } });
                }, 3000);
                this.pending.set(request.requestId, { socketId: lease.socketId, resolve, timer });
                this.emitter?.(lease.socketId, request);
            });
        }
        resolve(socketId, response) {
            const p = this.pending.get(response.requestId);
            if (!p || p.socketId !== socketId)
                return;
            clearTimeout(p.timer);
            this.pending.delete(response.requestId);
            p.resolve(response);
        }
    })();
    const routes = new Map();
    broker.bindEmitter((socketId, request) => {
        void routes.get(socketId)?.(request).then((response) => {
            broker.resolve(socketId, response);
            onClientResponse?.(socketId, response);
        });
    });
    return {
        broker,
        ptys,
        receivedInput,
        bindClientSocket: (socketId) => {
            routes.set(socketId, async (request) => {
                switch (request.action) {
                    case "shells.list":
                        return { requestId: request.requestId, ok: true, action: "shells.list", shells: [{ id: "bash", label: "bash", kind: "bash", isDefault: true }] };
                    case "session.create": {
                        ptys.set(request.sessionId, { seq: 0, cols: request.cols, rows: request.rows });
                        return { requestId: request.requestId, ok: true, action: "session.create", sessionId: request.sessionId, status: "detached" };
                    }
                    case "session.attach": {
                        const pty = ptys.get(request.sessionId);
                        return {
                            requestId: request.requestId,
                            ok: true,
                            action: "session.attach",
                            sessionId: request.sessionId,
                            snapshot: `SNAP:${request.sessionId}`,
                            snapshotSeq: pty?.seq ?? 0,
                            cols: pty?.cols ?? 80,
                            rows: pty?.rows ?? 24,
                            historyTruncated: false,
                        };
                    }
                    case "session.input": {
                        receivedInput.push({ sessionId: request.sessionId, data: request.data });
                        onOutput?.(request.sessionId, `echo:${request.data}`);
                        return { requestId: request.requestId, ok: true, action: "session.input", sessionId: request.sessionId };
                    }
                    case "session.resize": {
                        const pty = ptys.get(request.sessionId);
                        if (pty) {
                            pty.cols = request.cols;
                            pty.rows = request.rows;
                        }
                        return { requestId: request.requestId, ok: true, action: "session.resize", sessionId: request.sessionId, cols: request.cols, rows: request.rows };
                    }
                    case "session.detach":
                        return { requestId: request.requestId, ok: true, action: "session.detach", sessionId: request.sessionId };
                    case "session.snapshot": {
                        const pty = ptys.get(request.sessionId);
                        return {
                            requestId: request.requestId,
                            ok: true,
                            action: "session.snapshot",
                            sessionId: request.sessionId,
                            snapshot: "SNAP",
                            snapshotSeq: pty?.seq ?? 0,
                            cols: pty?.cols ?? 80,
                            rows: pty?.rows ?? 24,
                            historyTruncated: false,
                        };
                    }
                    case "session.close": {
                        ptys.delete(request.sessionId);
                        return { requestId: request.requestId, ok: true, action: "session.close", sessionId: request.sessionId, status: "closed" };
                    }
                }
            });
        },
        setOnOutput: (fn) => {
            onOutput = fn;
        },
        setOnClientResponse: (fn) => {
            onClientResponse = fn;
        },
    };
}
