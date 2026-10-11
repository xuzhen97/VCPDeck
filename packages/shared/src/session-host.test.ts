import { describe, expect, it } from "vitest";
import {
	SESSION_HOST_ERROR_CODES,
	SESSION_HOST_STATES,
	isSessionHostState,
	parseSessionHostStartRequest,
	parseSessionHostStatusReport,
	parseSessionHostStopRequest,
} from "./session-host.js";

describe("session host 严格解析", () => {
	it("拒绝未知字段", () => {
		expect(() =>
			parseSessionHostStartRequest({ operationId: "o", kind: "pi", cwd: "/w", extra: 1 }),
		).toThrow();
	});

	it("拒绝未知 kind", () => {
		expect(() => parseSessionHostStartRequest({ operationId: "o", kind: "node", cwd: "/w" })).toThrow();
	});

	it("拒绝空 operationId 与空 cwd", () => {
		expect(() => parseSessionHostStartRequest({ operationId: "", kind: "pi", cwd: "/w" })).toThrow();
		expect(() => parseSessionHostStartRequest({ operationId: "o", kind: "pi", cwd: "" })).toThrow();
	});

	it("接受合法 start 请求", () => {
		expect(parseSessionHostStartRequest({ operationId: "o", kind: "dsh", cwd: "/w" })).toEqual({
			operationId: "o",
			kind: "dsh",
			cwd: "/w",
		});
	});

	it("拒绝未知 state", () => {
		expect(() =>
			parseSessionHostStatusReport({
				available: true,
				hostId: "h",
				instances: [{ instanceId: "i", kind: "pi", state: "zombie", startedAt: "2026-01-01T00:00:00Z", lastSeq: 0 }],
			}),
		).toThrow();
	});

	it("available:false 时不得携带 hostId 或实例", () => {
		expect(() => parseSessionHostStatusReport({ available: false, hostId: "h", instances: [] })).toThrow();
		expect(() =>
			parseSessionHostStatusReport({
				available: false,
				hostId: null,
				instances: [{ instanceId: "i", kind: "pi", state: "running", startedAt: "2026-01-01T00:00:00Z", lastSeq: 0 }],
			}),
		).toThrow();
	});

	it("接受合法报告", () => {
		expect(parseSessionHostStatusReport({ available: true, hostId: "h", instances: [] }).instances).toEqual([]);
		expect(parseSessionHostStatusReport({ available: false, hostId: null, instances: [] }).available).toBe(false);
	});

	it("lastSeq 只接受非负整数", () => {
		const base = { available: true as const, hostId: "h" };
		expect(() =>
			parseSessionHostStatusReport({
				...base,
				instances: [{ instanceId: "i", kind: "pi", state: "running", startedAt: "2026-01-01T00:00:00Z", lastSeq: -1 }],
			}),
		).toThrow();
		expect(() =>
			parseSessionHostStatusReport({
				...base,
				instances: [{ instanceId: "i", kind: "pi", state: "running", startedAt: "2026-01-01T00:00:00Z", lastSeq: 1.5 }],
			}),
		).toThrow();
	});

	it("stop 请求只接受 instanceId", () => {
		expect(parseSessionHostStopRequest({ instanceId: "i" })).toEqual({ instanceId: "i" });
		expect(() => parseSessionHostStopRequest({ instanceId: "i", force: true })).toThrow();
	});

	it("状态枚举与错误码均为冻结 allowlist", () => {
		expect([...SESSION_HOST_STATES]).toEqual(["running", "stopped", "failed", "unknown"]);
		expect(isSessionHostState("unknown")).toBe(true);
		expect(isSessionHostState("zombie")).toBe(false);
		expect(SESSION_HOST_ERROR_CODES).toContain("SESSION_HOST_INTERRUPTED_BY_CLIENT_UPDATE");
		expect(SESSION_HOST_ERROR_CODES).toContain("SESSION_HOST_OUTPUT_BACKLOG_EXCEEDED");
	});
});
