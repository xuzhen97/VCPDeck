import { describe, expect, it } from "vitest";
import {
	parsePiEvent,
	parsePiRequest,
	parsePiResponse,
	parsePiStateReport,
	MAX_PI_IMAGES_PER_PROMPT,
} from "./pi.js";

describe("parsePiRequest", () => {
	it("接受合法的 agent.prompt 请求", () => {
		const req = parsePiRequest({
			requestId: "r1",
			action: "agent.prompt",
			cwdRef: { rootDir: "D:\\", relativePath: "repo" },
			sessionId: "s1",
			jobId: "j1",
			runId: "j1",
			payload: { prompt: "hi", attachments: [] },
		});
		expect(req.action).toBe("agent.prompt");
		expect(req.runId).toBe("j1");
	});

	it("拒绝未知 action", () => {
		expect(() => parsePiRequest({ requestId: "r1", action: "agent.unknown" })).toThrow();
	});

	it("拒绝未知顶层字段", () => {
		expect(() =>
			parsePiRequest({
				requestId: "r1",
				action: "agent.state",
				sessionId: "s1",
				jobId: "j1",
				runId: "j1",
				evil: true,
			}),
		).toThrow();
	});

	it("拒绝缺失 requestId", () => {
		expect(() => parsePiRequest({ action: "agent.state" })).toThrow();
	});

	it("拒绝 prompt 缺 session/job/run 关联 ID", () => {
		expect(() =>
			parsePiRequest({ requestId: "r1", action: "agent.prompt" }),
		).toThrow();
		expect(() =>
			parsePiRequest({ requestId: "r1", action: "agent.prompt", sessionId: "s1" }),
		).toThrow();
	});

	it("拒绝 runId 与 jobId 不一致", () => {
		expect(() =>
			parsePiRequest({
				requestId: "r1",
				action: "agent.prompt",
				sessionId: "s1",
				jobId: "j1",
				runId: "j2",
			}),
		).toThrow();
	});

	it("拒绝图片数量超限的 prompt", () => {
		const attachments = Array.from({ length: MAX_PI_IMAGES_PER_PROMPT + 1 }, () => ({
			fileId: "f",
			sha256: "a".repeat(64),
			size: 1024,
			mimeType: "image/png",
		}));
		expect(() =>
			parsePiRequest({
				requestId: "r1",
				action: "agent.prompt",
				sessionId: "s1",
				jobId: "j1",
				runId: "j1",
				payload: { prompt: "hi", attachments },
			}),
		).toThrow();
	});

	it("拒绝单图超限的 prompt", () => {
		const attachments = [
			{
				fileId: "f",
				sha256: "a".repeat(64),
				size: 11 * 1024 * 1024,
				mimeType: "image/png",
			},
		];
		expect(() =>
			parsePiRequest({
				requestId: "r1",
				action: "agent.prompt",
				sessionId: "s1",
				jobId: "j1",
				runId: "j1",
				payload: { prompt: "hi", attachments },
			}),
		).toThrow();
	});

	it("拒绝总量超限的 prompt", () => {
		const attachments = Array.from({ length: MAX_PI_IMAGES_PER_PROMPT }, () => ({
			fileId: "f",
			sha256: "a".repeat(64),
			size: 11 * 1024 * 1024,
			mimeType: "image/png",
		}));
		expect(() =>
			parsePiRequest({
				requestId: "r1",
				action: "agent.prompt",
				sessionId: "s1",
				jobId: "j1",
				runId: "j1",
				payload: { prompt: "hi", attachments },
			}),
		).toThrow();
	});

	it("拒绝畸形 cwdRef", () => {
		expect(() =>
			parsePiRequest({
				requestId: "r1",
				action: "sessions.list",
				cwdRef: { rootDir: 42, relativePath: "repo" },
			}),
		).toThrow();
	});
});

describe("parsePiResponse", () => {
	it("接受 ok 响应", () => {
		const res = parsePiResponse({ requestId: "r1", ok: true, data: { ok: 1 } });
		expect(res.ok).toBe(true);
	});

	it("拒绝未知字段", () => {
		expect(() => parsePiResponse({ requestId: "r1", ok: true, evil: 1 })).toThrow();
	});

	it("拒绝错误响应缺 code/message", () => {
		expect(() => parsePiResponse({ requestId: "r1", ok: false })).toThrow();
		expect(() =>
			parsePiResponse({ requestId: "r1", ok: false, error: { code: "X" } }),
		).toThrow();
	});
});

describe("parsePiEvent", () => {
	it("接受合法事件包装", () => {
		const ev = parsePiEvent({
			clientId: "c1",
			sessionId: "s1",
			jobId: "j1",
			runId: "j1",
			event: { type: "agent_end" },
		});
		expect(ev.event.type).toBe("agent_end");
	});

	it("拒绝 jobId/runId 不一致", () => {
		expect(() =>
			parsePiEvent({
				clientId: "c1",
				sessionId: "s1",
				jobId: "j1",
				runId: "j2",
				event: { type: "agent_end" },
			}),
		).toThrow();
	});

	it("拒绝未知 event 类型", () => {
		expect(() =>
			parsePiEvent({
				clientId: "c1",
				sessionId: "s1",
				jobId: "j1",
				runId: "j1",
				event: { type: "totally_unknown" },
			}),
		).toThrow();
	});

	it("拒绝缺失关联 ID", () => {
		expect(() =>
			parsePiEvent({ clientId: "c1", event: { type: "agent_end" } }),
		).toThrow();
	});
});

describe("parsePiStateReport", () => {
	it("接受空报告", () => {
		const report = parsePiStateReport({ clientId: "c1", runs: [] });
		expect(report.runs).toEqual([]);
	});

	it("接受合法 run 摘要", () => {
		const report = parsePiStateReport({
			clientId: "c1",
			runs: [
				{
					jobId: "j1",
					runId: "j1",
					sessionId: "s1",
					status: "running",
					projectKey: "a".repeat(64),
				},
			],
		});
		expect(report.runs[0]?.status).toBe("running");
	});

	it("拒绝未知 run 状态", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [{ jobId: "j1", runId: "j1", sessionId: "s1", status: "mystery" }],
			}),
		).toThrow();
	});

	it("拒绝非法 projectKey 长度", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [
					{
						jobId: "j1",
						runId: "j1",
						sessionId: "s1",
						status: "running",
						projectKey: "short",
					},
				],
			}),
		).toThrow();
	});

	it("拒绝 runId 与 jobId 不一致", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [{ jobId: "j1", runId: "j2", sessionId: "s1", status: "done" }],
			}),
		).toThrow();
	});
});
