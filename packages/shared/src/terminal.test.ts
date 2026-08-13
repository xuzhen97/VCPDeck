import { describe, expect, it } from "vitest";
import {
	TerminalLimits,
	TERMINAL_ERROR_CODES,
	TERMINAL_AUDIT_EVENTS,
	TERMINAL_SESSION_STATUSES,
	parseTerminalClientRequest,
	parseTerminalClientResponse,
	parseTerminalOutputChunk,
	parseTerminalExitReport,
	parseTerminalStateReport,
	parseTerminalStateAck,
	parseTerminalSessionCreateRequest,
	parseTerminalBrowserAttach,
	parseTerminalBrowserInput,
	parseTerminalBrowserResize,
	parseTerminalBrowserTakeover,
	parseTerminalBrowserDetach,
	parseTerminalBrowserAckOutput,
	parseTerminalBrowserResync,
	parseTerminalSnapshotMessage,
	parseTerminalControlState,
	parseTerminalSessionStateMessage,
	parseTerminalError,
	utf8ByteLength,
	isValidTerminalSize,
	isTerminalSessionStatus,
	isTerminalAuditEventName,
	terminalErrorCode,
} from "./terminal.js";

const TERMINAL_PROTOCOL_INVALID = "TERMINAL_PROTOCOL_INVALID";

function expectProtocolError(fn: () => unknown, needle?: string) {
	try {
		fn();
		throw new Error("expected throw");
	} catch (e: unknown) {
		const code = (e as { code?: unknown }).code;
		expect(code).toBe(TERMINAL_PROTOCOL_INVALID);
		if (needle) {
			const message = (e as { message?: unknown }).message;
			expect(typeof message).toBe("string");
			expect((message as string).includes(needle)).toBe(true);
		}
	}
}

describe("TerminalLimits 常量", () => {
	it("覆盖设计约束", () => {
		expect(TerminalLimits.maxSessionsPerClient).toBe(5);
		expect(TerminalLimits.reconnectGraceMs).toBe(30_000);
		expect(TerminalLimits.detachedTtlMs).toBe(30 * 60_000);
		expect(TerminalLimits.maxInputBytes).toBe(64 * 1024);
		expect(TerminalLimits.maxOutputChunkBytes).toBe(64 * 1024);
		expect(TerminalLimits.maxSnapshotBytes).toBe(8 * 1024 * 1024);
		expect(TerminalLimits.syncBacklogBytes).toBe(2 * 1024 * 1024);
		expect(TerminalLimits.scrollbackLines).toBe(2_000);
		expect(TerminalLimits.minCols).toBe(20);
		expect(TerminalLimits.maxCols).toBe(500);
		expect(TerminalLimits.minRows).toBe(5);
		expect(TerminalLimits.maxRows).toBe(300);
	});

	it("错误码包含设计约定的稳定错误码", () => {
		for (const code of [
			"TERMINAL_CLIENT_OFFLINE",
			"TERMINAL_UNSUPPORTED",
			"TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
			"TERMINAL_SESSION_NOT_FOUND",
			"TERMINAL_SESSION_LIMIT_REACHED",
			"TERMINAL_SHELL_NOT_AVAILABLE",
			"TERMINAL_SESSION_ENDED",
			"TERMINAL_READ_ONLY",
			"TERMINAL_CONTROL_PROTECTED",
			"TERMINAL_CONTROL_CONFLICT",
			"TERMINAL_PTY_SPAWN_FAILED",
			"TERMINAL_PTY_IO_FAILED",
			"TERMINAL_SNAPSHOT_FAILED",
			"TERMINAL_RESYNC_REQUIRED",
			"TERMINAL_CLIENT_RESTARTED",
			"TERMINAL_REQUEST_TIMEOUT",
			"TERMINAL_INPUT_TOO_LARGE",
			"TERMINAL_RATE_LIMITED",
			"TERMINAL_PROTOCOL_INVALID",
		]) {
			expect(TERMINAL_ERROR_CODES).toContain(code);
		}
	});

	it("状态与审计事件 allowlist 完整", () => {
		expect(TERMINAL_SESSION_STATUSES).toEqual([
			"starting",
			"active",
			"detached",
			"exited",
			"interrupted",
			"expired",
			"closed",
			"error",
		]);
		expect(TERMINAL_AUDIT_EVENTS).toEqual([
			"created",
			"create_failed",
			"attached",
			"detached",
			"takeover",
			"closed",
			"expired",
			"exited",
			"interrupted",
		]);
	});
});

describe("utf8ByteLength 与尺寸校验", () => {
	it("按 UTF-8 字节而非 JS 字符计数", () => {
		expect(utf8ByteLength("abc")).toBe(3);
		expect(utf8ByteLength("中文")).toBe(6);
		expect(utf8ByteLength("💩")).toBe(4);
		expect(utf8ByteLength("")).toBe(0);
	});

	it("尺寸边界：20..500 列、5..300 行", () => {
		expect(isValidTerminalSize(20, 5)).toBe(true);
		expect(isValidTerminalSize(500, 300)).toBe(true);
		expect(isValidTerminalSize(19, 5)).toBe(false);
		expect(isValidTerminalSize(501, 5)).toBe(false);
		expect(isValidTerminalSize(80, 4)).toBe(false);
		expect(isValidTerminalSize(80, 301)).toBe(false);
		expect(isValidTerminalSize(80.5, 24)).toBe(false);
		expect(isValidTerminalSize(NaN, 24)).toBe(false);
		expect(isValidTerminalSize(80, Infinity)).toBe(false);
	});
});

describe("parseTerminalClientRequest", () => {
	it("解析合法 create 请求并保留判别字段", () => {
		const parsed = parseTerminalClientRequest({
			requestId: "r1",
			action: "session.create",
			sessionId: "s1",
			shellId: "pwsh",
			cols: 120,
			rows: 30,
		});
		expect(parsed).toEqual({
			requestId: "r1",
			action: "session.create",
			sessionId: "s1",
			shellId: "pwsh",
			cols: 120,
			rows: 30,
		});
	});

	it("解析合法 shells.list / input / snapshot / close 请求", () => {
		expect(parseTerminalClientRequest({ requestId: "r", action: "shells.list" }).action).toBe("shells.list");
		const input = parseTerminalClientRequest({
			requestId: "r",
			action: "session.input",
			sessionId: "s1",
			data: "\x03ls\r",
		});
		expect(input.action).toBe("session.input");
		if (input.action !== "session.input") throw new Error("narrow");
		expect(input.data).toBe("\x03ls\r");
		const close = parseTerminalClientRequest({
			requestId: "r",
			action: "session.close",
			sessionId: "s1",
			reason: "expired",
		});
		expect(close.action).toBe("session.close");
		if (close.action !== "session.close") throw new Error("narrow");
		expect(close.reason).toBe("expired");
	});

	it("拒绝未知 action", () => {
		expectProtocolError(() =>
			parseTerminalClientRequest({ requestId: "r", action: "session.hack" }),
		);
	});

	it("拒绝额外顶层字段", () => {
		expectProtocolError(() =>
			parseTerminalClientRequest({
				requestId: "r",
				action: "shells.list",
				executable: "C:\\evil.exe",
			}),
		);
		expectProtocolError(() =>
			parseTerminalClientRequest({
				requestId: "r",
				action: "session.create",
				sessionId: "s1",
				shellId: "pwsh",
				cols: 80,
				rows: 24,
				cwd: "/tmp",
			}),
		);
	});

	it("拒绝空 sessionId / 非字符串 requestId", () => {
		expectProtocolError(() =>
			parseTerminalClientRequest({ requestId: "r", action: "session.input", sessionId: "", data: "x" }),
		);
		expectProtocolError(() =>
			parseTerminalClientRequest({ requestId: 7, action: "shells.list" }),
		);
	});

	it("拒绝超限 input（UTF-8 字节）", () => {
		const big = "a".repeat(TerminalLimits.maxInputBytes + 1);
		expectProtocolError(() =>
			parseTerminalClientRequest({ requestId: "r", action: "session.input", sessionId: "s1", data: big }),
		);
		// 中文按字节计数：3 字节/字
		const cn = "中".repeat(Math.ceil(TerminalLimits.maxInputBytes / 3) + 1);
		expectProtocolError(() =>
			parseTerminalClientRequest({ requestId: "r", action: "session.input", sessionId: "s1", data: cn }),
		);
	});

	it("拒绝非法尺寸（小数/越界）", () => {
		expectProtocolError(() =>
			parseTerminalClientRequest({
				requestId: "r",
				action: "session.create",
				sessionId: "s1",
				shellId: "pwsh",
				cols: 80.5,
				rows: 24,
			}),
		);
		expectProtocolError(() =>
			parseTerminalClientRequest({
				requestId: "r",
				action: "session.resize",
				sessionId: "s1",
				cols: 9999,
				rows: 24,
			}),
		);
	});

	it("拒绝非法 close reason", () => {
		expectProtocolError(() =>
			parseTerminalClientRequest({
				requestId: "r",
				action: "session.close",
				sessionId: "s1",
				reason: "explode",
			}),
		);
	});

	it("失败消息不回显原始 data", () => {
		const secret = "TOP_SECRET_DATA_XYZ";
		try {
			parseTerminalClientRequest({
				requestId: "r",
				action: "session.input",
				sessionId: "s1",
				data: secret + "x".repeat(TerminalLimits.maxInputBytes),
			});
			throw new Error("expected throw");
		} catch (e: unknown) {
			const message = (e as { message: string }).message;
			expect(message.includes(secret)).toBe(false);
		}
	});
});

describe("parseTerminalClientResponse", () => {
	it("解析合法 snapshot 响应", () => {
		const parsed = parseTerminalClientResponse({
			requestId: "r1",
			ok: true,
			action: "session.snapshot",
			sessionId: "s1",
			snapshot: "\x1b[31mhi",
			snapshotSeq: 42,
			cols: 120,
			rows: 30,
			historyTruncated: false,
		});
		if (parsed.action !== "session.snapshot") throw new Error("narrow");
		expect(parsed.action).toBe("session.snapshot");
		expect(parsed.snapshotSeq).toBe(42);
		expect(parsed.snapshot).toBe("\x1b[31mhi");
	});

	it("解析合法错误响应", () => {
		const parsed = parseTerminalClientResponse({
			requestId: "r1",
			ok: false,
			error: { code: "TERMINAL_PTY_SPAWN_FAILED", message: "spawn failed" },
		});
		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("narrow");
		expect(parsed.error.code).toBe("TERMINAL_PTY_SPAWN_FAILED");
	});

	it("拒绝非法错误码、超限 snapshot、缺失判别字段", () => {
		expectProtocolError(() =>
			parseTerminalClientResponse({
				requestId: "r1",
				ok: false,
				error: { code: "EVERYTHING_IS_FINE", message: "x" },
			}),
		);
		expectProtocolError(() =>
			parseTerminalClientResponse({
				requestId: "r1",
				ok: true,
				action: "session.snapshot",
				sessionId: "s1",
				snapshot: "x".repeat(TerminalLimits.maxSnapshotBytes + 1),
				snapshotSeq: 1,
				cols: 80,
				rows: 24,
				historyTruncated: false,
			}),
		);
		expectProtocolError(() =>
			parseTerminalClientResponse({ requestId: "r1", ok: true, action: "session.detach" }),
		);
	});
});

describe("parseTerminalOutputChunk", () => {
	it("解析合法块并保留 seq", () => {
		const parsed = parseTerminalOutputChunk({ sessionId: "s1", seq: 7, data: "ok" });
		expect(parsed.seq).toBe(7);
	});

	it("拒绝负 seq、NaN、空块、超限块和额外字段", () => {
		expectProtocolError(() => parseTerminalOutputChunk({ sessionId: "s1", seq: -1, data: "x" }));
		expectProtocolError(() => parseTerminalOutputChunk({ sessionId: "s1", seq: NaN, data: "x" }));
		expectProtocolError(() => parseTerminalOutputChunk({ sessionId: "s1", seq: 1, data: "" }));
		expectProtocolError(() =>
			parseTerminalOutputChunk({
				sessionId: "s1",
				seq: 1,
				data: "x".repeat(TerminalLimits.maxOutputChunkBytes + 1),
			}),
		);
		expectProtocolError(() =>
			parseTerminalOutputChunk({ sessionId: "s1", seq: 1, data: "x", cwd: "/tmp" }),
		);
	});
});

describe("parseTerminalExitReport", () => {
	it("解析合法退出报告", () => {
		expect(parseTerminalExitReport({ sessionId: "s1", exitCode: 0 }).exitCode).toBe(0);
		expect(parseTerminalExitReport({ sessionId: "s1", exitCode: -1073741510 }).exitCode).toBe(-1073741510);
	});

	it("拒绝非整数 exitCode 和额外字段", () => {
		expectProtocolError(() => parseTerminalExitReport({ sessionId: "s1", exitCode: 1.5 }));
		expectProtocolError(() => parseTerminalExitReport({ sessionId: "s1", exitCode: NaN }));
		expectProtocolError(() => parseTerminalExitReport({ sessionId: "s1", exitCode: 0, reason: "x" }));
	});
});

describe("parseTerminalStateReport", () => {
	const base = {
		clientId: "c1",
		generationId: "g1",
		sessions: [
			{ sessionId: "s1", shellId: "pwsh", status: "active", cols: 120, rows: 30, lastSeq: 10 },
		],
	};

	it("解析合法报告", () => {
		const parsed = parseTerminalStateReport(base);
		expect(parsed.clientId).toBe("c1");
		expect(parsed.sessions[0].status).toBe("active");
	});

	it("解析带 detachedAt/expiresAt 的报告", () => {
		const parsed = parseTerminalStateReport({
			...base,
			sessions: [
				{
					...base.sessions[0],
					status: "detached",
					detachedAt: "2026-08-12T00:00:00.000Z",
					expiresAt: "2026-08-12T00:30:00.000Z",
				},
			],
		});
		expect(parsed.sessions[0].detachedAt).toBeTruthy();
	});

	it("拒绝错误 clientId 类型、重复 sessionId、非法日期", () => {
		expectProtocolError(() => parseTerminalStateReport({ ...base, clientId: 42 }));
		expectProtocolError(() =>
			parseTerminalStateReport({
				...base,
				sessions: [base.sessions[0], { ...base.sessions[0] }],
			}),
		);
		expectProtocolError(() =>
			parseTerminalStateReport({
				...base,
				sessions: [{ ...base.sessions[0], detachedAt: "not-a-date" }],
			}),
		);
	});

	it("拒绝非法状态、非法尺寸、会话数超限", () => {
		expectProtocolError(() =>
			parseTerminalStateReport({
				...base,
				sessions: [{ ...base.sessions[0], status: "zombie" }],
			}),
		);
		expectProtocolError(() =>
			parseTerminalStateReport({
				...base,
				sessions: [{ ...base.sessions[0], cols: 3 }],
			}),
		);
		const tooMany = Array.from({ length: TerminalLimits.maxSessionsPerClient + 1 }, (_, i) => ({
			...base.sessions[0],
			sessionId: `s${i}`,
		}));
		expectProtocolError(() => parseTerminalStateReport({ ...base, sessions: tooMany }));
	});
});

describe("parseTerminalStateAck", () => {
	it("解析合法 ack 并应用默认值", () => {
		const parsed = parseTerminalStateAck({ acceptedSessionIds: ["s1"], closeSessionIds: [] });
		expect(parsed.acceptedSessionIds).toEqual(["s1"]);
	});

	it("拒绝非法字段", () => {
		expectProtocolError(() => parseTerminalStateAck({ acceptedSessionIds: [7] }));
		expectProtocolError(() => parseTerminalStateAck({ acceptedSessionIds: [], closeSessionIds: [], extra: 1 }));
	});
});

describe("parseTerminalSessionCreateRequest（REST）", () => {
	it("解析合法请求", () => {
		expect(parseTerminalSessionCreateRequest({ shellId: "bash", cols: 120, rows: 30 })).toEqual({
			shellId: "bash",
			cols: 120,
			rows: 30,
		});
	});

	it("拒绝 executable/args/cwd/env 字段", () => {
		expectProtocolError(() =>
			parseTerminalSessionCreateRequest({ shellId: "bash", cols: 80, rows: 24, executable: "/bin/sh" }),
		);
		expectProtocolError(() =>
			parseTerminalSessionCreateRequest({ shellId: "bash", cols: 80, rows: 24, args: ["--login"] }),
		);
		expectProtocolError(() =>
			parseTerminalSessionCreateRequest({ shellId: "bash", cols: 80, rows: 24, cwd: "/root" }),
		);
		expectProtocolError(() =>
			parseTerminalSessionCreateRequest({ shellId: "bash", cols: 80, rows: 24, env: { FOO: "1" } }),
		);
	});

	it("拒绝缺字段和非法尺寸", () => {
		expectProtocolError(() => parseTerminalSessionCreateRequest({ cols: 80, rows: 24 }));
		expectProtocolError(() => parseTerminalSessionCreateRequest({ shellId: "bash", cols: 80 }));
		expectProtocolError(() => parseTerminalSessionCreateRequest({ shellId: "bash", cols: 80.5, rows: 24 }));
	});
});

describe("浏览器消息 parser", () => {
	it("解析合法 attach（含/不含 reconnectToken）", () => {
		expect(parseTerminalBrowserAttach({ sessionId: "s1" }).reconnectToken).toBeUndefined();
		expect(
			parseTerminalBrowserAttach({ sessionId: "s1", reconnectToken: "tok" }).reconnectToken,
		).toBe("tok");
		expectProtocolError(() =>
			parseTerminalBrowserAttach({ sessionId: "s1", reconnectToken: "" }),
		);
	});

	it("解析合法 input/resize/takeover/detach/ack/resync", () => {
		expect(parseTerminalBrowserInput({ sessionId: "s1", attachmentId: "a1", data: "x" }).data).toBe("x");
		expect(parseTerminalBrowserResize({ sessionId: "s1", attachmentId: "a1", cols: 100, rows: 40 })).toEqual({
			sessionId: "s1",
			attachmentId: "a1",
			cols: 100,
			rows: 40,
		});
		expect(parseTerminalBrowserTakeover({ sessionId: "s1", attachmentId: "a1" }).attachmentId).toBe("a1");
		expect(parseTerminalBrowserDetach({ sessionId: "s1", attachmentId: "a1" }).sessionId).toBe("s1");
		expect(parseTerminalBrowserAckOutput({ sessionId: "s1", attachmentId: "a1", seq: 5 }).seq).toBe(5);
		expect(parseTerminalBrowserResync({ sessionId: "s1", attachmentId: "a1" }).attachmentId).toBe("a1");
	});

	it("拒绝越权字段和非法 input 尺寸", () => {
		expectProtocolError(() =>
			parseTerminalBrowserInput({ sessionId: "s1", attachmentId: "a1", data: "x", token: "t" }),
		);
		expectProtocolError(() =>
			parseTerminalBrowserInput({ sessionId: "s1", attachmentId: "a1", data: "" }),
		);
		expectProtocolError(() =>
			parseTerminalBrowserInput({
				sessionId: "s1",
				attachmentId: "a1",
				data: "x".repeat(TerminalLimits.maxInputBytes + 1),
			}),
		);
		expectProtocolError(() =>
			parseTerminalBrowserResize({ sessionId: "s1", attachmentId: "a1", cols: 10, rows: 40 }),
		);
		expectProtocolError(() =>
			parseTerminalBrowserAckOutput({ sessionId: "s1", attachmentId: "a1", seq: -1 }),
		);
	});
});

describe("Server → Browser 消息 parser", () => {
	it("解析合法 snapshot/control/state/error", () => {
		expect(
			parseTerminalSnapshotMessage({
				sessionId: "s1",
				snapshot: "x",
				snapshotSeq: 3,
				cols: 80,
				rows: 24,
				historyTruncated: true,
			}).historyTruncated,
		).toBe(true);
		expect(
			parseTerminalControlState({
				sessionId: "s1",
				mode: "operator",
				operatorName: "admin",
				controlProtectedUntil: null,
				canTakeover: false,
			}).mode,
		).toBe("operator");
		expect(
			parseTerminalSessionStateMessage({ sessionId: "s1", status: "interrupted", reason: "restarted" }).status,
		).toBe("interrupted");
		expect(parseTerminalError({ code: "TERMINAL_READ_ONLY", message: "readonly" }).code).toBe(
			"TERMINAL_READ_ONLY",
		);
	});

	it("拒绝非法模式/状态/错误码", () => {
		expectProtocolError(() =>
			parseTerminalControlState({
				sessionId: "s1",
				mode: "superuser",
				operatorName: null,
				controlProtectedUntil: null,
				canTakeover: false,
			}),
		);
		expectProtocolError(() =>
			parseTerminalSessionStateMessage({ sessionId: "s1", status: "frozen" }),
		);
		expectProtocolError(() => parseTerminalError({ code: "WHATEVER", message: "x" }));
	});
});

describe("terminalErrorCode 帮助函数", () => {
	it("返回稳定错误对象", () => {
		const err = terminalErrorCode("TERMINAL_READ_ONLY", "readonly");
		expect(err.code).toBe("TERMINAL_READ_ONLY");
		expect(err.message).toBe("readonly");
	});

	it("类型守卫正确", () => {
		expect(isTerminalSessionStatus("active")).toBe(true);
		expect(isTerminalSessionStatus("nope")).toBe(false);
		expect(isTerminalAuditEventName("takeover")).toBe(true);
		expect(isTerminalAuditEventName("nope")).toBe(false);
	});
});
