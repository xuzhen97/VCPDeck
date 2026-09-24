import { describe, expect, it } from "vitest";
import {
	PI_WORKER_ACTIONS,
	assertSourceName,
	isPiWorkerAction,
	parsePiImportListResponse,
	parsePiImportPreviewResponse,
	parsePiImportRunRequest,
	parsePiImportRunResponse,
	parsePiRequest,
} from "./pi.js";

const summary = {
	sourceName: "2026-09-01_s1.jsonl",
	sourceLabel: "--d--proj--/2026-09-01_s1.jsonl",
	startedAt: "2026-09-01T00:00:00.000Z",
	entryCount: 2,
	cwd: "/proj/a",
	imported: false,
	cwdNotAllowed: false,
	unreadable: false,
};

describe("列表响应上限与 run 批量上限分离", () => {
	it("列表响应可超 50（真实源可达数百个会话）", () => {
		const sessions = Array.from({ length: 60 }, (_, i) => ({
			...summary,
			sourceName: `2026-09-01_s${i}.jsonl`,
		}));
		const r = parsePiImportListResponse({ sourceRoot: "/x", sessions });
		expect(r.sessions).toHaveLength(60);
	});

	it("列表响应超过 MAX_IMPORT_LIST_SESSIONS 仍被拒（安全上限）", () => {
		const sessions = Array.from({ length: 2001 }, (_, i) => ({
			...summary,
			sourceName: `2026-09-01_s${i}.jsonl`,
		}));
		expect(() =>
			parsePiImportListResponse({ sourceRoot: "/x", sessions }),
		).toThrow(/数量不能超过/);
	});
});

describe("assertSourceName（防路径逃逸的唯一入口）", () => {
	it("拒绝路径逃逸（/、\\、..、.、NUL、空、超长）", () => {
		for (const bad of [
			"a/b.jsonl",
			"a\\b.jsonl",
			"..",
			".",
			"..\\x",
			"a\u0000b",
			"",
			"x".repeat(256),
		]) {
			expect(() => assertSourceName(bad), `应拒绝: ${JSON.stringify(bad)}`).toThrow();
		}
		expect(assertSourceName("2026-09-01_s1.jsonl")).toBe("2026-09-01_s1.jsonl");
	});
});

describe("parsePiImportListResponse", () => {
	it("接受合法摘要列表", () => {
		const parsed = parsePiImportListResponse({
			sourceRoot: "/home/u/.pi/agent/sessions",
			sessions: [summary],
		});
		expect(parsed.sessions).toHaveLength(1);
		expect(parsed.sessions[0]?.entryCount).toBe(2);
	});

	it("允许空列表（源根无会话）", () => {
		expect(
			parsePiImportListResponse({ sourceRoot: "/home/u/.pi/agent/sessions", sessions: [] })
				.sessions,
		).toEqual([]);
	});

	it("摘要字段白名单：未知字段拒绝", () => {
		expect(() =>
			parsePiImportListResponse({
				sourceRoot: "/x",
				sessions: [{ ...summary, body: "leak" }],
			}),
		).toThrow(/未知字段/);
		expect(() =>
			parsePiImportListResponse({
				sourceRoot: "/x",
				sessions: [],
				extra: 1,
			}),
		).toThrow(/未知字段/);
	});

	it("sourceLabel 必须是相对路径（拒绝绝对/.. /反斜杠）", () => {
		for (const bad of ["/etc/passwd", "../x.jsonl", "a\\b.jsonl", ""]) {
			expect(() =>
				parsePiImportListResponse({
					sourceRoot: "/x",
					sessions: [{ ...summary, sourceLabel: bad }],
				}),
				`应拒绝 label: ${bad}`,
			).toThrow();
		}
	});

	it("startedAt 非法日期与非法 sourceName 拒绝", () => {
		expect(() =>
			parsePiImportListResponse({
				sourceRoot: "/x",
				sessions: [{ ...summary, startedAt: "not-a-date" }],
			}),
		).toThrow(/startedAt/);
		expect(() =>
			parsePiImportListResponse({
				sourceRoot: "/x",
				sessions: [{ ...summary, sourceName: "a/b.jsonl" }],
			}),
		).toThrow(/逃逸|sourceName/);
	});
});

describe("parsePiImportPreviewResponse", () => {
	it("接受 80 code point 内的截断文本", () => {
		expect(
			parsePiImportPreviewResponse({
				sourceName: "a.jsonl",
				previewText: "x".repeat(80),
				truncated: true,
			}),
		).toMatchObject({ truncated: true });
	});

	it("超过 80 code point 直接拒绝（防截断失败时泄漏全文）", () => {
		expect(() =>
			parsePiImportPreviewResponse({
				sourceName: "a.jsonl",
				previewText: "x".repeat(81),
				truncated: false,
			}),
		).toThrow(/80|截断/);
	});

	it("truncated 必须是布尔；未知字段拒绝", () => {
		expect(() =>
			parsePiImportPreviewResponse({
				sourceName: "a.jsonl",
				previewText: "x",
				truncated: "yes",
			}),
		).toThrow();
		expect(() =>
			parsePiImportPreviewResponse({
				sourceName: "a.jsonl",
				previewText: "x",
				truncated: false,
				role: "user",
			}),
		).toThrow(/未知字段/);
	});
});

describe("parsePiImportRunRequest", () => {
	it("接受 1–50 个并去重（保序）", () => {
		expect(
			parsePiImportRunRequest({ sourceNames: ["a.jsonl", "b.jsonl"] }).sourceNames,
		).toEqual(["a.jsonl", "b.jsonl"]);
		expect(
			parsePiImportRunRequest({ sourceNames: ["a.jsonl", "a.jsonl"] }).sourceNames,
		).toEqual(["a.jsonl"]);
	});

	it("空列表与超 50 拒绝", () => {
		expect(() => parsePiImportRunRequest({ sourceNames: [] })).toThrow();
		expect(() =>
			parsePiImportRunRequest({
				sourceNames: Array.from({ length: 51 }, (_, i) => `n${i}.jsonl`),
			}),
		).toThrow(/数量|50/);
	});

	it("任一非法标识整请求拒绝", () => {
		expect(() => parsePiImportRunRequest({ sourceNames: ["a/b"] })).toThrow(/逃逸/);
		expect(() =>
			parsePiImportRunRequest({ sourceNames: ["ok.jsonl", ".."] }),
		).toThrow();
	});
});

describe("parsePiImportRunResponse", () => {
	it("逐条结果：状态与稳定 reasonCode", () => {
		expect(
			parsePiImportRunResponse({
				results: [
					{ sourceName: "a.jsonl", status: "imported" },
					{ sourceName: "b.jsonl", status: "alreadyImported" },
					{
						sourceName: "c.jsonl",
						status: "rejected",
						reasonCode: "PI_PROJECT_NOT_ALLOWED",
					},
				],
			}).results,
		).toHaveLength(3);
	});

	it("reasonCode 仅允许三个稳定码；未知字段拒绝", () => {
		expect(() =>
			parsePiImportRunResponse({
				results: [
					{
						sourceName: "a.jsonl",
						status: "rejected",
						reasonCode: "PI_BUNDLE_UNAVAILABLE",
					},
				],
			}),
		).toThrow(/reasonCode/);
		expect(() =>
			parsePiImportRunResponse({ results: [], total: 1 }),
		).toThrow(/未知字段/);
	});
});

describe("三个动作的门控与请求 envelope", () => {
	it("三个动作都归入 PI_WORKER_ACTIONS（ready 门控）", () => {
		for (const action of ["session.import.list", "session.import.preview", "session.import.run"] as const) {
			expect(isPiWorkerAction(action)).toBe(true);
			expect(PI_WORKER_ACTIONS).toContain(action);
		}
	});

	it("无 sessionId/jobId/runId 的请求可通过 envelope 解析（非 run 作用域）", () => {
		expect(
			parsePiRequest({ requestId: "r1", action: "session.import.list" }).action,
		).toBe("session.import.list");
		expect(
			parsePiRequest({
				requestId: "r2",
				action: "session.import.run",
				payload: { sourceNames: ["a.jsonl"] },
			}).payload,
		).toEqual({ sourceNames: ["a.jsonl"] });
	});

	it("envelope 层拒绝非法 payload：preview/run 的标识、list 的多余参数", () => {
		expect(() =>
			parsePiRequest({
				requestId: "r3",
				action: "session.import.preview",
				payload: { sourceName: "../x" },
			}),
		).toThrow(/逃逸/);
		expect(() =>
			parsePiRequest({
				requestId: "r4",
				action: "session.import.run",
				payload: { sourceNames: ["a/b"] },
			}),
		).toThrow(/逃逸/);
		expect(() =>
			parsePiRequest({
				requestId: "r5",
				action: "session.import.list",
				payload: { sourceName: "x.jsonl" },
			}),
		).toThrow(/未知字段|payload/);
	});
});
