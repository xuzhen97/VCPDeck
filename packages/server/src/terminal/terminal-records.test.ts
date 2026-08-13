import { describe, expect, it } from "vitest";
import {
	toTerminalSessionInfo,
	toTerminalAuditInfo,
	type TerminalSessionRecord,
	type TerminalAuditRecord,
} from "./terminal-records.js";

function sessionRecord(overrides: Partial<TerminalSessionRecord> = {}): TerminalSessionRecord {
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

function auditRecord(overrides: Partial<TerminalAuditRecord> = {}): TerminalAuditRecord {
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

describe("toTerminalSessionInfo", () => {
	it("映射全部批准字段为 ISO 字符串", () => {
		const info = toTerminalSessionInfo(sessionRecord());
		expect(info).toEqual({
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

	it("终态会话保留首次终态原因", () => {
		const info = toTerminalSessionInfo(
			sessionRecord({
				status: "interrupted",
				endedAt: new Date("2026-08-12T00:10:00.000Z"),
				endReason: "TERMINAL_CLIENT_RESTARTED",
			}),
		);
		expect(info.status).toBe("interrupted");
		expect(info.endedAt).toBe("2026-08-12T00:10:00.000Z");
		expect(info.endReason).toBe("TERMINAL_CLIENT_RESTARTED");
	});

	it("不输出任何内部字段（无正文/路径/token）", () => {
		const info = toTerminalSessionInfo(sessionRecord()) as unknown as Record<string, unknown>;
		for (const key of Object.keys(info)) {
			expect(["snapshot", "output", "input", "token", "executable", "cwd", "env", "stack"]).not.toContain(key);
		}
	});
});

describe("toTerminalAuditInfo", () => {
	it("映射审计字段", () => {
		expect(toTerminalAuditInfo(auditRecord())).toEqual({
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

	it("映射失败审计的 result/reason", () => {
		const info = toTerminalAuditInfo(
			auditRecord({ event: "create_failed", result: "error", reason: "TERMINAL_PTY_SPAWN_FAILED" }),
		);
		expect(info.result).toBe("error");
		expect(info.reason).toBe("TERMINAL_PTY_SPAWN_FAILED");
	});

	it("不输出正文类字段", () => {
		const info = toTerminalAuditInfo(auditRecord()) as unknown as Record<string, unknown>;
		for (const key of Object.keys(info)) {
			expect(["data", "output", "snapshot", "token", "path", "env", "stack"]).not.toContain(key);
		}
	});
});
