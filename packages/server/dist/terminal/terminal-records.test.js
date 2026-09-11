"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const terminal_records_js_1 = require("./terminal-records.js");
function sessionRecord(overrides = {}) {
    return {
        id: "s1",
        clientId: "c1",
        shellId: "pwsh",
        shellLabel: "PowerShell 7",
        status: "active",
        cols: 120,
        rows: 30,
        createdByIdentityId: "id1",
        createdByName: "admin",
        createdAt: new Date("2026-08-12T00:00:00.000Z"),
        lastAttachedAt: new Date("2026-08-12T00:00:05.000Z"),
        detachedAt: null,
        expiresAt: null,
        endedAt: null,
        endReason: null,
        errorCode: null,
        ...overrides,
    };
}
function auditRecord(overrides = {}) {
    return {
        id: "a1",
        sessionId: "s1",
        clientId: "c1",
        event: "created",
        identityId: "id1",
        actorName: "admin",
        source: "web",
        result: "ok",
        reason: null,
        createdAt: new Date("2026-08-12T00:00:00.000Z"),
        ...overrides,
    };
}
(0, vitest_1.describe)("toTerminalSessionInfo", () => {
    (0, vitest_1.it)("映射全部批准字段为 ISO 字符串", () => {
        const info = (0, terminal_records_js_1.toTerminalSessionInfo)(sessionRecord());
        (0, vitest_1.expect)(info).toEqual({
            sessionId: "s1",
            clientId: "c1",
            shellId: "pwsh",
            shellLabel: "PowerShell 7",
            status: "active",
            cols: 120,
            rows: 30,
            createdByIdentityId: "id1",
            createdByName: "admin",
            createdAt: "2026-08-12T00:00:00.000Z",
            lastAttachedAt: "2026-08-12T00:00:05.000Z",
            detachedAt: null,
            expiresAt: null,
            endedAt: null,
            endReason: null,
            errorCode: null,
        });
    });
    (0, vitest_1.it)("终态会话保留首次终态原因", () => {
        const info = (0, terminal_records_js_1.toTerminalSessionInfo)(sessionRecord({
            status: "interrupted",
            endedAt: new Date("2026-08-12T00:10:00.000Z"),
            endReason: "TERMINAL_CLIENT_RESTARTED",
        }));
        (0, vitest_1.expect)(info.status).toBe("interrupted");
        (0, vitest_1.expect)(info.endedAt).toBe("2026-08-12T00:10:00.000Z");
        (0, vitest_1.expect)(info.endReason).toBe("TERMINAL_CLIENT_RESTARTED");
    });
    (0, vitest_1.it)("不输出任何内部字段（无正文/路径/token）", () => {
        const info = (0, terminal_records_js_1.toTerminalSessionInfo)(sessionRecord());
        for (const key of Object.keys(info)) {
            (0, vitest_1.expect)(["snapshot", "output", "input", "token", "executable", "cwd", "env", "stack"]).not.toContain(key);
        }
    });
});
(0, vitest_1.describe)("toTerminalAuditInfo", () => {
    (0, vitest_1.it)("映射审计字段", () => {
        (0, vitest_1.expect)((0, terminal_records_js_1.toTerminalAuditInfo)(auditRecord())).toEqual({
            id: "a1",
            sessionId: "s1",
            clientId: "c1",
            event: "created",
            identityId: "id1",
            actorName: "admin",
            source: "web",
            result: "ok",
            reason: null,
            createdAt: "2026-08-12T00:00:00.000Z",
        });
    });
    (0, vitest_1.it)("映射失败审计的 result/reason", () => {
        const info = (0, terminal_records_js_1.toTerminalAuditInfo)(auditRecord({ event: "create_failed", result: "error", reason: "TERMINAL_PTY_SPAWN_FAILED" }));
        (0, vitest_1.expect)(info.result).toBe("error");
        (0, vitest_1.expect)(info.reason).toBe("TERMINAL_PTY_SPAWN_FAILED");
    });
    (0, vitest_1.it)("不输出正文类字段", () => {
        const info = (0, terminal_records_js_1.toTerminalAuditInfo)(auditRecord());
        for (const key of Object.keys(info)) {
            (0, vitest_1.expect)(["data", "output", "snapshot", "token", "path", "env", "stack"]).not.toContain(key);
        }
    });
});
