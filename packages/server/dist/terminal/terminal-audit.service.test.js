"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const terminal_audit_service_js_1 = require("./terminal-audit.service.js");
function makePrisma() {
    const create = vitest_1.vi.fn();
    const findMany = vitest_1.vi.fn();
    const count = vitest_1.vi.fn();
    return {
        terminalAuditEvent: { create, findMany, count },
    };
}
(0, vitest_1.describe)("TerminalAuditService", () => {
    (0, vitest_1.it)("记录批准事件并只写入窄字段（输入对象中的正文/路径/token 不进 DB）", async () => {
        const prisma = makePrisma();
        const service = new terminal_audit_service_js_1.TerminalAuditService(prisma);
        await service.record({
            sessionId: "s1",
            clientId: "c1",
            event: "created",
            identityId: "id1",
            actorName: "admin",
            source: "web",
            result: "ok",
            reason: undefined,
            // 恶意附加字段（不应进入 DB）
            // @ts-expect-error 附加字段在类型上不允许
            secretInput: "TOP_SECRET",
        });
        const data = prisma.terminalAuditEvent.create.mock.calls[0]?.[0]?.data;
        (0, vitest_1.expect)(data).toEqual({
            id: vitest_1.expect.any(String),
            sessionId: "s1",
            clientId: "c1",
            event: "created",
            identityId: "id1",
            actorName: "admin",
            source: "web",
            result: "ok",
            reason: null,
        });
        (0, vitest_1.expect)(JSON.stringify(data)).not.toContain("TOP_SECRET");
    });
    (0, vitest_1.it)("未知 event 被拒绝（allowlist）", async () => {
        const prisma = makePrisma();
        const service = new terminal_audit_service_js_1.TerminalAuditService(prisma);
        await (0, vitest_1.expect)(service.record({
            sessionId: "s1",
            clientId: "c1",
            event: "keystroke_logged",
            identityId: null,
            actorName: null,
            source: null,
            result: "ok",
        })).rejects.toThrow();
        (0, vitest_1.expect)(prisma.terminalAuditEvent.create).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("reason 只保存稳定 code 或 allowlist 文案", async () => {
        const prisma = makePrisma();
        const service = new terminal_audit_service_js_1.TerminalAuditService(prisma);
        await service.record({
            sessionId: "s1",
            clientId: "c1",
            event: "create_failed",
            identityId: null,
            actorName: null,
            source: null,
            result: "error",
            reason: "TERMINAL_PTY_SPAWN_FAILED",
        });
        const data = prisma.terminalAuditEvent.create.mock.calls[0]?.[0]?.data;
        (0, vitest_1.expect)(data.reason).toBe("TERMINAL_PTY_SPAWN_FAILED");
    });
    (0, vitest_1.it)("列表使用 findMany + count 并发、createdAt desc、skip/take 和统一分页", async () => {
        const prisma = makePrisma();
        prisma.terminalAuditEvent.findMany.mockResolvedValue([
            { id: "a1", sessionId: "s1", clientId: "c1", event: "created", identityId: null, actorName: null, source: null, result: "ok", reason: null, createdAt: new Date("2026-08-12T00:00:00.000Z") },
        ]);
        prisma.terminalAuditEvent.count.mockResolvedValue(1);
        const service = new terminal_audit_service_js_1.TerminalAuditService(prisma);
        const result = await service.list({ sessionId: "s1", clientId: "c1" }, 1, 20);
        (0, vitest_1.expect)(result.total).toBe(1);
        (0, vitest_1.expect)(result.page).toBe(1);
        (0, vitest_1.expect)(result.pageSize).toBe(20);
        (0, vitest_1.expect)(result.totalPages).toBe(1);
        (0, vitest_1.expect)(result.data[0]?.event).toBe("created");
        (0, vitest_1.expect)(prisma.terminalAuditEvent.findMany).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            where: { sessionId: "s1", clientId: "c1" },
            orderBy: { createdAt: "desc" },
            skip: 0,
            take: 20,
        }));
    });
    (0, vitest_1.it)("列表响应不包含正文类字段", async () => {
        const prisma = makePrisma();
        prisma.terminalAuditEvent.findMany.mockResolvedValue([
            { id: "a1", sessionId: "s1", clientId: "c1", event: "attached", identityId: null, actorName: null, source: null, result: "ok", reason: null, createdAt: new Date("2026-08-12T00:00:00.000Z") },
        ]);
        prisma.terminalAuditEvent.count.mockResolvedValue(1);
        const service = new terminal_audit_service_js_1.TerminalAuditService(prisma);
        const json = JSON.stringify(await service.list({ sessionId: "s1" }, 1, 20));
        for (const key of ["output", "snapshot", "token", "path", "env", "stack"]) {
            (0, vitest_1.expect)(json).not.toContain(key);
        }
    });
});
