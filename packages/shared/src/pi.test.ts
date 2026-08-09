import { describe, expect, it } from "vitest";
import { JobStatus, JobType } from "./index.js";
import {
	PI_ERROR_CODES,
	PI_SESSION_JOB_PROTOCOL_VERSION,
	isPiThinkingLevel,
	MAX_PI_IMAGES_PER_PROMPT,
	parsePiAgentState,
	parsePiEvent,
	parsePiRequest,
	parsePiResponse,
	parsePiStateReport,
} from "./pi.js";

describe("Pi thinking levels", () => {
	it("只接受 Pi SDK 原生思考深度", () => {
		expect(isPiThinkingLevel("high")).toBe(true);
		expect(isPiThinkingLevel("auto")).toBe(false);
		expect(isPiThinkingLevel("unknown")).toBe(false);
	});
});

describe("Session Job 协议", () => {
	it("导出协议版本和 Job 枚举", () => {
		expect(JobType.AGENT_SESSION).toBe("agent.session");
		expect(JobStatus.IDLE).toBe("idle");
		expect(PI_SESSION_JOB_PROTOCOL_VERSION).toBe(1);
		expect(PI_ERROR_CODES).toContain("PI_STATE_PENDING");
	});
});

describe("parsePiRequest", () => {
	it("允许 Session Job 使用独立 Prompt runId", () => {
		const request = parsePiRequest({
			requestId: "request-1",
			action: "agent.prompt",
			cwdRef: { rootDir: "D:\\", relativePath: "repo" },
			sessionId: "session-1",
			jobId: "session-1",
			runId: "run-1",
			payload: { prompt: "hello" },
		});
		expect(request.jobId).toBe("session-1");
		expect(request.runId).toBe("run-1");
	});

	it("拒绝 jobId 与 sessionId 不一致", () => {
		expect(() =>
			parsePiRequest({
				requestId: "request-1",
				action: "agent.prompt",
				cwdRef: { rootDir: "D:\\", relativePath: "repo" },
				sessionId: "session-1",
				jobId: "other-job",
				runId: "run-1",
				payload: { prompt: "hello" },
			}),
		).toThrow(/jobId.*sessionId/);
	});

	it("拒绝未知 action", () => {
		expect(() =>
			parsePiRequest({ requestId: "r1", action: "agent.unknown" }),
		).toThrow();
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
			parsePiRequest({
				requestId: "r1",
				action: "agent.prompt",
				sessionId: "s1",
			}),
		).toThrow();
	});


	it("拒绝图片数量超限的 prompt", () => {
		const attachments = Array.from(
			{ length: MAX_PI_IMAGES_PER_PROMPT + 1 },
			() => ({
				fileId: "f",
				sha256: "a".repeat(64),
				size: 1024,
				mimeType: "image/png",
			}),
		);
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
		const attachments = Array.from(
			{ length: MAX_PI_IMAGES_PER_PROMPT },
			() => ({
				fileId: "f",
				sha256: "a".repeat(64),
				size: 11 * 1024 * 1024,
				mimeType: "image/png",
			}),
		);
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

describe("parsePiAgentState", () => {
	const state = {
		status: "waiting_for_extension_input",
		streaming: false,
		prompting: true,
		compacting: false,
		thinkingLevel: "off",
		queuedMessages: { steering: [], followUp: [] },
	};

	it("严格解析 pendingExtension", () => {
		expect(
			parsePiAgentState({
				...state,
				pendingExtension: {
					requestId: "ui-1",
					extensionId: "project-trust",
					kind: "confirm",
					title: "Project Trust",
					message: "是否信任？",
				},
			}).pendingExtension?.requestId,
		).toBe("ui-1");
	});

	it("拒绝畸形 Agent State 和非交互 pending kind", () => {
		expect(() => parsePiAgentState({ ...state, streaming: "yes" })).toThrow(
			/streaming/,
		);
		expect(() =>
			parsePiAgentState({
				...state,
				pendingExtension: {
					requestId: "ui-1",
					extensionId: "e",
					kind: "notify",
				},
			}),
		).toThrow(/pendingExtension.kind/);
	});
});

describe("parsePiResponse", () => {
	it("接受 ok 响应", () => {
		const res = parsePiResponse({ requestId: "r1", ok: true, data: { ok: 1 } });
		expect(res.ok).toBe(true);
	});

	it("拒绝未知字段", () => {
		expect(() =>
			parsePiResponse({ requestId: "r1", ok: true, evil: 1 }),
		).toThrow();
	});

	it("拒绝错误响应缺字段、未知 code 和超长 message", () => {
		expect(() => parsePiResponse({ requestId: "r1", ok: false })).toThrow();
		expect(() =>
			parsePiResponse({ requestId: "r1", ok: false, error: { code: "X" } }),
		).toThrow();
		expect(() =>
			parsePiResponse({
				requestId: "r1",
				ok: false,
				error: { code: "UNKNOWN", message: "bad" },
			}),
		).toThrow(/error.code/);
		expect(() =>
			parsePiResponse({
				requestId: "r1",
				ok: false,
				error: { code: "PI_PROTOCOL_INVALID", message: "x".repeat(4097) },
			}),
		).toThrow(/error.message/);
	});
});

describe("parsePiEvent", () => {
	it("接受合法事件包装", () => {
		const ev = parsePiEvent({
			clientId: "c1",
			sessionId: "s1",
			jobId: "s1",
			runId: "run-1",
			event: { type: "agent_end", sessionId: "s1" },
		});
		expect(ev.event.type).toBe("agent_end");
	});

	it("接受并严格校验 extension_resolved", () => {
		const event = parsePiEvent({
			clientId: "client-1",
			sessionId: "session-1",
			jobId: "session-1",
			runId: "run-1",
			event: {
				type: "extension_resolved",
				sessionId: "session-1",
				requestId: "ui-1",
				reason: "timeout",
				hasPending: false,
			},
		});
		expect(event.event.type).toBe("extension_resolved");
		expect(() =>
			parsePiEvent({
				clientId: "client-1",
				sessionId: "session-1",
				jobId: "session-1",
				runId: "run-1",
				event: {
					type: "extension_resolved",
					sessionId: "session-1",
					requestId: "ui-1",
					reason: "unknown",
					hasPending: false,
				},
			}),
		).toThrow(/reason/);
	});

	it("拒绝外层与内层 sessionId 不一致", () => {
		expect(() =>
			parsePiEvent({
				clientId: "client-1",
				sessionId: "session-1",
				jobId: "session-1",
				runId: "run-1",
				event: { type: "agent_end", sessionId: "other-session" },
			}),
		).toThrow(/sessionId/);
	});

	it("拒绝畸形事件专属字段和 Extension UI", () => {
		expect(() =>
			parsePiEvent({
				clientId: "c1",
				sessionId: "s1",
				jobId: "s1",
				runId: "r1",
				event: { type: "prompt_error", sessionId: "s1", code: "UNKNOWN", message: "bad" },
			}),
		).toThrow(/code/);
		expect(() =>
			parsePiEvent({
				clientId: "c1",
				sessionId: "s1",
				jobId: "s1",
				runId: "r1",
				event: {
					type: "extension_request",
					sessionId: "s1",
					ui: { requestId: "ui", extensionId: "e", kind: "bad" },
				},
			}),
		).toThrow(/ui.kind/);
	});

	it("限制 thinking_progress 单次正文大小", () => {
		const ev = parsePiEvent({
			clientId: "c1",
			sessionId: "s1",
			jobId: "s1",
			runId: "run-1",
			event: {
				type: "thinking_progress",
				sessionId: "s1",
				stage: "delta",
				text: "x".repeat(16_385),
			},
		});
		expect((ev.event as { text?: string }).text?.length).toBeLessThanOrEqual(
			16_384,
		);
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

	it("接受活动状态、独立 runId 和无 projectKey 的 idle/error", () => {
		const report = parsePiStateReport({
			clientId: "c1",
			runs: [
				{
					jobId: "s1",
					runId: "run-1",
					sessionId: "s1",
					status: "running",
					projectKey: "a".repeat(64),
				},
				{ jobId: "s2", runId: "run-2", sessionId: "s2", status: "idle" },
				{ jobId: "s3", runId: "run-3", sessionId: "s3", status: "error" },
			],
		});
		expect(report.runs.map((run) => run.status)).toEqual([
			"running",
			"idle",
			"error",
		]);
	});

	it("要求活动状态携带 projectKey", () => {
		for (const status of ["running", "waiting_input"]) {
			expect(() =>
				parsePiStateReport({
					clientId: "c1",
					runs: [{ jobId: "s1", runId: "r1", sessionId: "s1", status }],
				}),
			).toThrow(/projectKey/);
		}
	});

	it("拒绝未知 run 状态", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [
					{ jobId: "j1", runId: "j1", sessionId: "s1", status: "mystery" },
				],
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

	it("拒绝 jobId 与 sessionId 不一致", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [{ jobId: "j1", runId: "r1", sessionId: "s1", status: "done" }],
			}),
		).toThrow(/jobId.*sessionId/);
	});

	it("拒绝 runs 超过 1,000 项", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: Array.from({ length: 1001 }, (_, index) => ({
					jobId: `s${index}`,
					runId: `r${index}`,
					sessionId: `s${index}`,
					status: "idle",
				})),
			}),
		).toThrow(/runs/);
	});
});
