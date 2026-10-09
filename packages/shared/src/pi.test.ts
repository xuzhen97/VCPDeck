import { isPiReadAction, isPiWorkerAction } from "./pi.js";
import { describe, expect, it } from "vitest";
import { JobStatus, JobType } from "./index.js";
import {
	PI_ERROR_CODES,
	PI_SESSION_JOB_PROTOCOL_VERSION,
	PI_SESSION_PROTOCOL_VERSION,
	isPiAgentIdle,
	isPiThinkingLevel,
	MAX_PI_IMAGES_PER_PROMPT,
	parsePiAgentState,
	parsePiEvent,
	parsePiRequest,
	parsePiResponse,
	parsePiSessionSnapshot,
	parsePiRunInfo,
	parsePiStateReport,
	type PiAgentState,
} from "./pi.js";

describe("Pi thinking levels", () => {
	it("只接受 Pi SDK 原生思考深度", () => {
		expect(isPiThinkingLevel("high")).toBe(true);
		expect(isPiThinkingLevel("auto")).toBe(false);
		expect(isPiThinkingLevel("unknown")).toBe(false);
	});
});

describe("isPiAgentIdle", () => {
	const base: PiAgentState = {
		status: "idle",
		streaming: false,
		prompting: false,
		compacting: false,
		thinkingLevel: "off",
		queuedMessages: { steering: [], followUp: [] },
	};
	it("四标志空闲且无扩展/排队才返回 true", () => {
		expect(isPiAgentIdle(base)).toBe(true);
	});
	it.each([
		["status running", { status: "running" }],
		["streaming", { streaming: true }],
		["prompting", { prompting: true }],
		["compacting", { compacting: true }],
		["waitingForExtensionInput", { waitingForExtensionInput: true }],
	] as const)("%s 不算空闲", (_name, patch) => {
		expect(isPiAgentIdle({ ...base, ...patch })).toBe(false);
	});
	it("pendingExtension 或排队 steering/followUp 不算空闲", () => {
		expect(
			isPiAgentIdle({
				...base,
				pendingExtension: {
					requestId: "u1",
					extensionId: "e",
					kind: "confirm",
				},
			}),
		).toBe(false);
		expect(
			isPiAgentIdle({
				...base,
				queuedMessages: { steering: ["s"], followUp: [] },
			}),
		).toBe(false);
		expect(
			isPiAgentIdle({
				...base,
				queuedMessages: { steering: [], followUp: ["f"] },
			}),
		).toBe(false);
	});
});

describe("Session Job 协议", () => {
	it("导出协议版本和 Job 枚举", () => {
		expect(JobType.AGENT_SESSION).toBe("agent.session");
		expect(JobStatus.IDLE).toBe("idle");
		expect(PI_SESSION_JOB_PROTOCOL_VERSION).toBe(3);
		expect(PI_ERROR_CODES).toContain("PI_STATE_PENDING");
	});
});

describe("parsePiRequest", () => {
	it("只允许空文本与有效图片组合，拒绝无内容 prompt", () => {
		const base = {
			requestId: "r1", action: "agent.prompt", cwdRef: { rootDir: "D:\\\\", relativePath: "repo" },
			sessionId: "s1", runId: "run1",
		};
		const image = { fileId: "f1", sha256: "sha", size: 42, mimeType: "image/png", url: "https://example.test/image" };
		const payload = { submissionId: "sub1", executionMode: "automatic" };
		expect(parsePiRequest({ ...base, payload: { ...payload, prompt: "", attachments: [image] } }).payload?.prompt).toBe("");
		expect(parsePiRequest({ ...base, payload: { ...payload, prompt: " \t", attachments: [image] } }).payload?.prompt).toBe(" \t");
		for (const prompt of ["", " \t"]) {
			for (const attachments of [undefined, []]) {
				expect(() => parsePiRequest({ ...base, payload: { ...payload, prompt, attachments } })).toThrow();
			}
		}
		expect(() => parsePiRequest({ ...base, payload: { ...payload, prompt: "", attachments: [{ ...image, size: 11 * 1024 * 1024 }] } })).toThrow();
	});

	it("允许独立 Run 使用独立 Prompt runId(v4)", () => {
		const request = parsePiRequest({
			requestId: "request-1",
			action: "agent.prompt",
			cwdRef: { rootDir: "D:\\", relativePath: "repo" },
			sessionId: "session-1",
			runId: "run-1",
			payload: { prompt: "hello", submissionId: "sub-1", executionMode: "supervised" },
		});
		expect(request.runId).toBe("run-1");
	});

	it("拒绝 Job 信封字段 jobId(v4)", () => {
		expect(() =>
			parsePiRequest({
				requestId: "request-1",
				action: "agent.prompt",
				cwdRef: { rootDir: "D:\\", relativePath: "repo" },
				sessionId: "session-1",
				jobId: "other-job",
				runId: "run-1",
				payload: { prompt: "hello", submissionId: "sub-1", executionMode: "supervised" },
			}),
		).toThrow(/jobId/);
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
				runId: "j1",
				evil: true,
			}),
		).toThrow();
	});

	it("拒绝缺失 requestId", () => {
		expect(() => parsePiRequest({ action: "agent.state" })).toThrow();
	});

	it("agent.prompt 要求严格且明确的执行模式", () => {
		const base = {
			requestId: "r1",
			action: "agent.prompt",
			cwdRef: { rootDir: "D:\\\\", relativePath: "repo" },
			sessionId: "s1",
			runId: "run1",
		};
		expect(
			parsePiRequest({
				...base,
				payload: {
					prompt: "hello",
					submissionId: "sub1",
					executionMode: "automatic",
				},
			}).payload?.executionMode,
		).toBe("automatic");
		for (const payload of [
			{ prompt: "hello", submissionId: "sub1", executionMode: "unsafe" },
			{ prompt: "hello", submissionId: "sub1" },
			{ prompt: "hello", submissionId: "sub1", executionMode: "auto", extra: true },
		]) {
			expect(() => parsePiRequest({ ...base, payload })).toThrow();
		}
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

	it.each([
		"agent.prompt",
		"agent.steer",
		"agent.followUp",
		"agent.abort",
		"agent.compact",
		"agent.abortCompact",
		"extension.respond",
	] as const)("拒绝 run-scoped action %s 缺完整关联 ID", (action) => {
		expect(() =>
			parsePiRequest({
				requestId: "r1",
				action,
				sessionId: "s1",
			}),
		).toThrow(/runId/);
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
				runId: "j1",
				payload: { prompt: "hi", submissionId: "sub-1", executionMode: "supervised", attachments },
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
				runId: "j1",
				payload: { prompt: "hi", submissionId: "sub-1", executionMode: "supervised", attachments },
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
				runId: "j1",
				payload: { prompt: "hi", submissionId: "sub-1", executionMode: "supervised", attachments },
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

	it("cwdRef.relativePath 允许空串（表示 root 自身）", () => {
		const request = parsePiRequest({
			requestId: "r1",
			action: "sessions.list",
			cwdRef: { rootDir: "D:\\", relativePath: "" },
		});
		expect(request.cwdRef).toEqual({ rootDir: "D:\\", relativePath: "" });
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
			runId: "run-1",
			event: { type: "agent_end", sessionId: "s1" },
		});
		expect(ev.event.type).toBe("agent_end");
	});

	it("agent_settled 带未知字段 aborted 时被严格 parser 拒绝", () => {
		// SDK 1.1.0 给 agent_settled 增加了 aborted；协议当前不含它，
		// 客户端投影不输出该字段，因此一旦出现就应被严格校验拦住。
		expect(() =>
			parsePiEvent({
				clientId: "c1",
				sessionId: "s1",
				runId: "run-1",
				event: { type: "agent_settled", sessionId: "s1", aborted: true },
			}),
		).toThrow();
	});

	it("接受并严格校验 extension_resolved", () => {
		const event = parsePiEvent({
			clientId: "client-1",
			sessionId: "session-1",
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
				runId: "run-1",
				event: { type: "agent_end", sessionId: "other-session" },
			}),
		).toThrow(/sessionId/);
	});

	it("拒绝非交互式 extension_request", () => {
		expect(() =>
			parsePiEvent({
				clientId: "c1",
				sessionId: "s1",
				runId: "r1",
				event: {
					type: "extension_request",
					sessionId: "s1",
					ui: { requestId: "ui", extensionId: "e", kind: "notify" },
				},
			}),
		).toThrow(/ui.kind/);
	});

	it("拒绝畸形事件专属字段和 Extension UI", () => {
		expect(() =>
			parsePiEvent({
				clientId: "c1",
				sessionId: "s1",
				runId: "r1",
				event: { type: "prompt_error", sessionId: "s1", code: "UNKNOWN", message: "bad" },
			}),
		).toThrow(/code/);
		expect(() =>
			parsePiEvent({
				clientId: "c1",
				sessionId: "s1",
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

	it("旧 Client 缺 runtimeRevision/configState 时按未就绪处理", () => {
		const report = parsePiStateReport({ clientId: "c1", runs: [] });
		expect(report.runtimeRevision).toBeNull();
		expect(report.configState).toBe("pending");
	});

	it("携带 runtimeRevision 与 configState 的报告被解析", () => {
		const report = parsePiStateReport({
			clientId: "c1",
			runs: [],
			runtimeRevision: "0123456789abcdef",
			configState: "ready",
		});
		expect(report).toMatchObject({
			runtimeRevision: "0123456789abcdef",
			configState: "ready",
		});
	});

	it("拒绝非法 configState 与非法 runtimeRevision", () => {
		expect(() =>
			parsePiStateReport({ clientId: "c1", runs: [], configState: "ok" }),
		).toThrow(/configState/);
		expect(() =>
			parsePiStateReport({ clientId: "c1", runs: [], runtimeRevision: "Z" }),
		).toThrow(/runtimeRevision/);
	});

	it("接受活动状态与无 projectKey 的终局摘要", () => {
		const report = parsePiStateReport({
			clientId: "c1",
			runs: [
				{
					runId: "run-1",
					sessionId: "s1",
					status: "running",
					projectKey: "a".repeat(64),
				},
				{ runId: "run-2", sessionId: "s2", status: "succeeded" },
				{ runId: "run-3", sessionId: "s3", status: "failed", errorCode: "PI_WORKER_EXITED" },
				{ runId: "run-4", sessionId: "s4", status: "aborted" },
			],
		});
		expect(report.runs.map((run) => run.status)).toEqual([
			"running",
			"succeeded",
			"failed",
			"aborted",
		]);
	});

	it("要求活动状态携带 projectKey", () => {
		for (const status of ["running", "waiting_input"]) {
			expect(() =>
				parsePiStateReport({
					clientId: "c1",
					runs: [{ runId: "r1", sessionId: "s1", status }],
				}),
			).toThrow(/projectKey/);
		}
	});

	it("拒绝未知 run 状态", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [
					{ runId: "j1", sessionId: "s1", status: "mystery" },
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
						runId: "j1",
						sessionId: "s1",
						status: "running",
						projectKey: "short",
					},
				],
			}),
		).toThrow();
	});

	it("拒绝 Job 信封字段 jobId(v4)", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [{ jobId: "j1", runId: "r1", sessionId: "s1", status: "running", projectKey: "a".repeat(64) }],
			}),
		).toThrow(/jobId/);
	});

	it("拒绝 runs 超过 1,000 项", () => {
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: Array.from({ length: 1001 }, (_, index) => ({
					runId: `r${index}`,
					sessionId: `s${index}`,
					status: "succeeded",
				})),
			}),
		).toThrow(/runs/);
	});
});

describe("Pi 动作门控分类", () => {
	it("每个 PiAction 必须且只能属于 read 或 worker 之一", () => {
		const actions: string[] = [
			"capability.get",
			"models.list",
			"project.resolve",
			"sessions.list",
			"session.get",
			"session.context",
			"session.entryContent",
			"session.new",
			"session.rename",
			"session.delete",
			"session.fork",
			"session.clone",
			"session.navigate",
			"agent.state",
			"agent.prompt",
			"agent.steer",
			"agent.followUp",
			"agent.abort",
			"agent.compact",
			"agent.abortCompact",
			"agent.commands",
			"agent.stats",
			"model.set",
			"thinking.set",
			"extension.respond",
		];
		for (const action of actions) {
			const read = isPiReadAction(action);
			const worker = isPiWorkerAction(action);
			expect(`${action}:${read}:${worker}`).toMatch(/:(true:false|false:true)$/);
		}
	});

	it("未分类动作不被悄悄放行（既非 read 也非 worker）", () => {
		expect(isPiReadAction("session.explode")).toBe(false);
		expect(isPiWorkerAction("session.explode")).toBe(false);
	});
});

// ── ADR-0041 Task 2:独立 Session/Run 契约(v4)──
describe("v4 独立 Session/Run 契约", () => {
	it("协议版本推进到 4", () => {
		expect(PI_SESSION_PROTOCOL_VERSION).toBe(4);
	});

	it("parsePiSessionSnapshot 严格校验并拒绝 Job 字段与伪造完成状态", () => {
		const validSession = {
			sessionId: "s1",
			status: "available",
			activeRun: null,
			ownerName: "User",
			isOwner: true,
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
		};
		expect(parsePiSessionSnapshot(validSession)).toMatchObject({ sessionId: "s1", status: "available" });
		expect(() => parsePiSessionSnapshot({ ...validSession, jobId: "s1" })).toThrow();
		expect(() => parsePiSessionSnapshot({ ...validSession, status: "done" })).toThrow();
		expect(() => parsePiSessionSnapshot({ ...validSession, status: "mystery" })).toThrow();
	});

	it("parsePiRunInfo 校验终态时间与错误码一致性", () => {
		const running = {
			runId: "r1", sessionId: "s1", status: "running", kind: "prompt",
			executionMode: "automatic", actorName: "User", source: "web",
			createdAt: "2026-10-08T00:00:00.000Z", acceptedAt: null, startedAt: null,
			finishedAt: null, errorCode: null,
		};
		expect(parsePiRunInfo(running)).toMatchObject({ runId: "r1", status: "running" });
		// 非终态不得携带 finishedAt
		expect(() => parsePiRunInfo({ ...running, finishedAt: "2026-10-08T01:00:00.000Z" })).toThrow();
		const failed = { ...running, status: "failed", finishedAt: "2026-10-08T01:00:00.000Z", errorCode: "PI_WORKER_EXITED" };
		expect(parsePiRunInfo(failed)).toMatchObject({ status: "failed", errorCode: "PI_WORKER_EXITED" });
		// 终态必须携带 finishedAt
		expect(() => parsePiRunInfo({ ...running, status: "failed" })).toThrow();
		// failed 必须带 errorCode
		expect(() => parsePiRunInfo({ ...failed, errorCode: null })).toThrow();
		// succeeded 不得带 errorCode
		expect(() => parsePiRunInfo({ ...failed, status: "succeeded" })).toThrow();
		expect(() => parsePiRunInfo({ ...running, kind: "mystery" })).toThrow();
	});

	it("v4 请求移除 jobId:旧字段拒绝,RUN_SCOPED 只要求 sessionId+runId", () => {
		const base = {
			requestId: "r1", action: "agent.abort", sessionId: "s1", runId: "run1",
		};
		expect(parsePiRequest(base)).toMatchObject({ sessionId: "s1", runId: "run1" });
		expect(() => parsePiRequest({ ...base, jobId: "s1" })).toThrow(/jobId/);
		expect(() => parsePiRequest({ ...base, runId: undefined, jobId: undefined })).toThrow();
	});

	it("v4 事件移除 jobId:旧形状拒绝", () => {
		const event = {
			clientId: "c1", sessionId: "s1", runId: "r1",
			event: { type: "agent_start", sessionId: "s1" },
		};
		expect(parsePiEvent(event)).toMatchObject({ sessionId: "s1", runId: "r1" });
		expect(() => parsePiEvent({ ...event, jobId: "s1" })).toThrow(/jobId/);
	});

	it("v4 状态报告终局摘要:succeeded/failed/aborted 且 failed 带安全错误码", () => {
		const report = parsePiStateReport({
			clientId: "c1",
			runs: [
				{ runId: "r1", sessionId: "s1", status: "running", projectKey: "a".repeat(64) },
				{ runId: "r2", sessionId: "s2", status: "succeeded" },
				{ runId: "r3", sessionId: "s3", status: "failed", errorCode: "PI_WORKER_EXITED" },
				{ runId: "r4", sessionId: "s4", status: "aborted" },
			],
		});
		expect(report.runs.map((run) => run.status)).toEqual(["running", "succeeded", "failed", "aborted"]);
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [{ runId: "r5", sessionId: "s5", status: "failed" }],
			}),
		).toThrow(/errorCode/);
		// 旧 jobId 字段拒绝
		expect(() =>
			parsePiStateReport({
				clientId: "c1",
				runs: [{ jobId: "s1", runId: "r1", sessionId: "s1", status: "running", projectKey: "a".repeat(64) }],
			}),
		).toThrow(/jobId/);
	});
});
