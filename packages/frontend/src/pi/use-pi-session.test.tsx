import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePiSession, type PiSendResult } from "./use-pi-session.js";
import type { PiApi } from "@vcpdeck/sdk";

class MockEventSource {
	static instances: MockEventSource[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	readyState = MockEventSource.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(
		public url: string,
		public options?: unknown,
	) {
		MockEventSource.instances.push(this);
		// 模拟真实连接成功（异步 open）
		queueMicrotask(() => {
			if (this.closed) return;
			this.readyState = MockEventSource.OPEN;
			this.onopen?.();
		});
	}
	close() {
		this.closed = true;
		this.readyState = MockEventSource.CLOSED;
	}
}

function last(): MockEventSource {
	return MockEventSource.instances.at(-1)!;
}

function emit(data: unknown): void {
	last().onmessage?.({ data: JSON.stringify(data) });
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const CWD = { rootDir: "D:\\", relativePath: "repo" };

function makePi() {
	return {
		sessions: {
			list: vi.fn(async () => ({ sessions: [] })),
			get: vi.fn(async () => ({
				info: { id: "s1", name: "s" },
				tree: [],
				activeLeafId: null,
			})),
			context: vi.fn(async () => ({
				messages: [
					{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
				],
				nextCursor: null,
			})),
			entryContent: vi.fn(),
			rename: vi.fn(async () => ({})),
			delete: vi.fn(async () => ({})),
			fork: vi.fn(async () => ({ sessionId: "forked" })),
			clone: vi.fn(async () => ({ sessionId: "cloned" })),
			navigate: vi.fn(async () => ({})),
		},
		models: vi.fn(async () => [
			{ provider: "p", modelId: "m1" },
			{ provider: "p", modelId: "m2" },
		]),
		sessionsControl: {
			snapshot: vi.fn(async () => ({
				sessionId: "s1",
				status: "available",
				activeRun: null,
				executionModeOverride: null,
				effectiveExecutionMode: "supervised",
				executionModeNeedsConfirmation: false,
				ownerName: "User",
				isOwner: true,
			})),
			run: vi.fn(),
			archive: vi.fn(async () => ({
				sessionId: "s1",
				status: "archived",
				activeRun: null,
				executionModeOverride: null,
				effectiveExecutionMode: "supervised",
				executionModeNeedsConfirmation: false,
				ownerName: "User",
				isOwner: true,
			})),
			restore: vi.fn(),
			runs: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
			audit: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 })),
		},
		running: vi.fn(async () => []),
		agent: {
			newSession: vi.fn(async () => ({ sessionId: "s1", jobId: "s1" })),
			open: vi.fn(async (_clientId: string, sessionId: string) => ({
				snapshot: {
				sessionId: "s1",
				status: "available",
				activeRun: null,
				executionModeOverride: null,
				effectiveExecutionMode: "supervised",
				executionModeNeedsConfirmation: false,
				ownerName: "User",
				isOwner: true,
				},
				agentState: {
					status: "idle",
					streaming: false,
					prompting: false,
					compacting: false,
					thinkingLevel: "off",
					model: { provider: "p", modelId: "m1" },
					queuedMessages: { steering: [], followUp: [] },
				},
			})),
			state: vi.fn(async () => ({
				status: "idle",
				streaming: false,
				prompting: false,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			})),
			prompt: vi.fn(async () => ({
				runId: "j1",
				sessionId: "s1",
			})),
			steer: vi.fn(async () => ({})),
			followUp: vi.fn(async () => ({})),
			abort: vi.fn(async () => ({})),
			compact: vi.fn(async () => ({})),
			abortCompact: vi.fn(async () => ({})),
			setModel: vi.fn(async () => ({})),
			setThinking: vi.fn(async () => ({})),
			extensionResponse: vi.fn(async () => ({})),
			executeCommand: vi.fn(async () => ({})),
			commands: vi.fn(async () => ({
				runtimeInstanceId: "spec-1",
				runtimeRevision: "rev-1",
				commands: [{ name: "fixture_ok", description: "就绪探针" }],
			})),
			extensionUi: vi.fn(async () => ({
				runtimeInstanceId: "spec-1",
				runtimeRevision: "rev-1",
				sequence: 0,
				title: null,
				statuses: [],
				widgets: [],
			})),
			eventsPath: (clientId: string, sessionId: string) =>
				`/api/clients/${clientId}/pi/agent/${sessionId}/events`,
		},
	} as unknown as Pick<PiApi, "sessions" | "sessionsControl" | "agent" | "models"> &
		Partial<Pick<PiApi, "running">>;
}

afterEach(() => {
	vi.unstubAllGlobals();
	MockEventSource.instances = [];
	vi.restoreAllMocks();
});

describe("usePiSession", () => {
	it("open 以 Session Job 为权威且不查询 running", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: null,
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "User",
			isOwner: true,
			},
			agentState: {
				status: "idle",
				streaming: false,
				prompting: false,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => result.current.actions.openSession("c1", "s1", CWD));

		expect(pi.agent.open).toHaveBeenCalledWith("c1", "s1", CWD);
		expect(pi.running).not.toHaveBeenCalled();
		expect(result.current.state.status).toBe("idle");
		expect(result.current.state.snapshot?.status).toBe("available");
	});

	it("恢复 matching pendingExtension 并按 requestId 关闭", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "j1",
				sessionId: "s1",
				status: "waiting_input",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "User",
			isOwner: true,
			},
			agentState: {
				status: "waiting_for_extension_input",
				streaming: false,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
				pendingExtension: {
					requestId: "u1",
					extensionId: "trust",
					kind: "confirm",
					message: "trust?",
				},
			},
		});
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));
		expect(result.current.state.pendingExtension?.requestId).toBe("u1");

		act(() =>
			emit({
				type: "extension_resolved",
				sessionId: "s1",
				runId: "j1",
				requestId: "old",
				reason: "answered",
				hasPending: true,
			}),
		);
		expect(result.current.state.pendingExtension?.requestId).toBe("u1");
		act(() =>
			emit({
				type: "extension_resolved",
				sessionId: "s1",
				runId: "j1",
				requestId: "u1",
				reason: "answered",
				hasPending: false,
			}),
		);
		expect(result.current.state.pendingExtension).toBeNull();
	});

	it("extension_resolved hasPending=true 保持 waiting_input", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "j1",
				sessionId: "s1",
				status: "waiting_input",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "User",
			isOwner: true,
			},
			agentState: {
				status: "waiting_for_extension_input",
				streaming: false,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
				pendingExtension: {
					requestId: "u1",
					extensionId: "trust",
					kind: "confirm",
					message: "trust?",
				},
			},
		});
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));
		expect(result.current.state.status).toBe("waiting_input");

		act(() =>
			emit({
				type: "extension_resolved",
				sessionId: "s1",
				runId: "j1",
				requestId: "u1",
				reason: "answered",
				hasPending: true,
			}),
		);
		expect(result.current.state.status).toBe("waiting_input");
		expect(result.current.state.snapshot?.activeRun?.status).toBe("waiting_input");
		expect(result.current.state.pendingExtension).toBeNull();

		act(() =>
			emit({
				type: "extension_request",
				sessionId: "s1",
				runId: "j1",
				ui: {
					requestId: "u2",
					extensionId: "e",
					kind: "input",
					message: "next",
				},
			}),
		);
		expect(result.current.state.status).toBe("waiting_input");
		act(() =>
			emit({
				type: "extension_resolved",
				sessionId: "s1",
				runId: "j1",
				requestId: "u2",
				reason: "answered",
				hasPending: false,
			}),
		);
		expect(result.current.state.status).toBe("running");
	});

	it("Observer 不能发送", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: null,
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "Other",
			isOwner: false,
			},
			agentState: {
				status: "idle",
				streaming: false,
				prompting: false,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));
		await act(async () => result.current.actions.send({ prompt: "no" }));
		expect(pi.agent.prompt).not.toHaveBeenCalled();
	});

	it("活跃 Run 未结算时不能发送", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "run-1",
				sessionId: "s1",
				status: "running",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "User",
			isOwner: true,
			},
			agentState: {
				status: "idle",
				streaming: false,
				prompting: false,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));
		await act(async () => result.current.actions.send({ prompt: "no" }));
		expect(pi.agent.prompt).not.toHaveBeenCalled();
	});

	it("archive 归档会话并采用返回快照", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "run-1",
				sessionId: "s1",
				status: "running",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "User",
			isOwner: true,
			},
			agentState: {
				status: "running",
				streaming: true,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));
		// ADR-0041:complete 已移除,整理会话走归档;归档不结算当前 Run。
		await act(async () => result.current.actions.archive());
		expect(pi.sessionsControl.archive).toHaveBeenCalledWith("c1", "s1");
		expect(result.current.state.snapshot?.status).toBe("archived");
	});
	it("createSession → stream ready → prompt（两阶段）", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		let sessionId = "";
		await act(async () => {
			sessionId = await result.current.actions.createSession("c1", CWD);
		});
		expect(sessionId).toBe("s1");
		expect(last().url).toContain("/api/clients/c1/pi/agent/s1/events");
		expect(pi.sessions.context).toHaveBeenCalled();

		await act(async () => {
			await result.current.actions.send({ prompt: "hello" });
		});
		expect(pi.agent.prompt).toHaveBeenCalledWith(
			"c1",
			"s1",
			CWD,
			expect.objectContaining({
				prompt: "hello",
				submissionId: expect.any(String),
			}),
		);
		expect(result.current.state.runId).toBe("j1");
	});

	it("prompt_error 结束运行态并展示错误（不卡运行中）", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "hello" });
		});
		act(() => {
			emit({ type: "agent_start", sessionId: "s1", runId: "j1" });
		});
		expect(result.current.state.status).toBe("running");
		act(() => {
			emit({
				type: "prompt_error",
				sessionId: "s1",
				runId: "j1",
				code: "PI_RUNTIME_UNAVAILABLE",
				message: "Pi runtime is unavailable",
			});
		});
		expect(result.current.state.status).toBe("idle");
		expect(result.current.state.runId).toBeNull();
		expect(result.current.state.error).toContain("runtime");
	});

	it("openSession 的 open 失败落入 state.error（不向调用方抛出）", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("Pi protocol input was invalid"),
		);
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => {
			await expect(
				result.current.actions.openSession("c1", "s1", CWD),
			).resolves.toBeUndefined();
		});
		expect(result.current.state.error).toContain("invalid");
		expect(result.current.state.status).not.toBe("loading");
	});

	it("实时 thinking 文本进入当前 Session 内存状态", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
			await result.current.actions.send({ prompt: "hi" });
		});
		act(() => {
			emit({
				type: "thinking_progress",
				sessionId: "s1",
				runId: "j1",
				stage: "start",
			});
			emit({
				type: "thinking_progress",
				sessionId: "s1",
				runId: "j1",
				stage: "delta",
				text: "先查看项目结构",
			});
			emit({
				type: "thinking_progress",
				sessionId: "s1",
				runId: "j1",
				stage: "end",
				text: "先查看项目结构",
				durationMs: 1234,
			});
		});

		expect(result.current.state.thinkingText).toBe("先查看项目结构");
		expect(result.current.state.thinkingDurationMs).toBe(1234);
	});

	it("agent_settled 后保留实时 thinking（折叠为摘要，不消失）", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
			await result.current.actions.send({ prompt: "hi" });
		});
		act(() => {
			emit({ type: "agent_start", sessionId: "s1", runId: "j1" });
			emit({
				type: "thinking_progress",
				sessionId: "s1",
				runId: "j1",
				stage: "start",
			});
			emit({
				type: "thinking_progress",
				sessionId: "s1",
				runId: "j1",
				stage: "delta",
				text: "先查看项目结构",
			});
		});
		expect(result.current.state.thinkingText).toBe("先查看项目结构");

		act(() => {
			emit({ type: "agent_settled", sessionId: "s1" });
		});

		expect(result.current.state.status).toBe("idle");
		// 用户要求“能看到思考”，因此结算后保留摘要（位置已在回合内部，不再是顶部残影）
		expect(result.current.state.thinkingText).toBe("先查看项目结构");
	});

	it("prompt_error 后也保留实时 thinking", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
			await result.current.actions.send({ prompt: "hi" });
		});
		act(() => {
			emit({ type: "agent_start", sessionId: "s1", runId: "j1" });
			emit({
				type: "thinking_progress",
				sessionId: "s1",
				runId: "j1",
				stage: "delta",
				text: "思考到一半就失败了",
			});
		});
		expect(result.current.state.thinkingText).toBe("思考到一半就失败了");

		act(() => {
			emit({
				type: "prompt_error",
				sessionId: "s1",
				runId: "j1",
				code: "PI_RUNTIME_UNAVAILABLE",
				message: "Pi runtime is unavailable",
			});
		});

		expect(result.current.state.status).toBe("idle");
		expect(result.current.state.thinkingText).toBe("思考到一半就失败了");
	});

	it("run_created 在 POST 前绑定 runId", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		// 延迟 prompt 响应，让 run_created 先到
		let resolvePrompt!: (v: unknown) => void;
		(pi.agent.prompt as ReturnType<typeof vi.fn>).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvePrompt = resolve;
				}),
		);
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		const sendPromise = result.current.actions.send({ prompt: "hi" });
		await waitFor(() =>
			expect(
				(pi.agent.prompt as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBe(1),
		);

		// 捕获 submissionId 并注入 run_created
		const call = (pi.agent.prompt as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[3] as {
			submissionId: string;
		};
		act(() => {
			emit({
				type: "run_created",
				sessionId: "s1",
				submissionId: call.submissionId,
				runId: "j1",
			});
		});
		expect(result.current.state.runId).toBe("j1");
		expect(result.current.state.status).toBe("running");

		await act(async () => {
			resolvePrompt({ jobId: "j1", runId: "j1", sessionId: "s1" });
			await sendPromise;
		});
	});

	it("旧 run 事件被丢弃", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "hi" });
		});
		// 当前 run 是 j1；注入旧 run j0 的 agent_start
		act(() => {
			emit({ type: "agent_start", sessionId: "s1", runId: "j0" });
		});
		// 不匹配 activeRunId → 状态不变（仍 running）
		expect(result.current.state.status).toBe("running");
	});

	it("agent_end 非终态：进入 grace 而非关闭", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "hi" });
		});

		act(() => {
			emit({ type: "agent_end", sessionId: "s1", runId: "j1" });
		});
		// 事件流未被关闭
		expect(last().closed).toBe(false);
		// grace 到期后对账（历史被重新读取）
		await act(async () => {
			await new Promise((r) => setTimeout(r, 700));
		});
		expect(pi.sessions.context).toHaveBeenCalled();
	});

	it("grace 内 Prompt 失败时恢复旧 run 并阻止连续发送", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.prompt as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ jobId: "s1", runId: "j1", sessionId: "s1" })
			.mockRejectedValueOnce(new Error("network failed"));
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => result.current.actions.createSession("c1", CWD));
		await act(async () => result.current.actions.send({ prompt: "first" }));
		act(() => emit({ type: "prompt_done", sessionId: "s1", runId: "j1" }));

		await act(async () => result.current.actions.send({ prompt: "second" }));

		expect(result.current.state.status).toBe("running");
		expect(result.current.state.runId).toBe("j1");
		expect(result.current.state.error).toBe("network failed");

		await act(async () => result.current.actions.send({ prompt: "third" }));
		expect(pi.agent.prompt).toHaveBeenCalledTimes(2);
	});

	it("agent_settled 收敛为空闲并允许下一回合绑定新 run", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.prompt as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ jobId: "s1", runId: "j1", sessionId: "s1" })
			.mockResolvedValueOnce({ jobId: "j2", runId: "j2", sessionId: "s1" });
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "first" });
		});
		act(() => {
			last().onmessage?.({
				data: JSON.stringify({
					clientId: "c1",
					jobId: "j1",
					runId: "j1",
					event: { type: "prompt_done", sessionId: "s1" },
				}),
			});
		});
		expect(result.current.state.status).toBe("running");
		expect(result.current.state.runId).toBe("j1");

		act(() => {
			last().onmessage?.({
				data: JSON.stringify({
					clientId: "c1",
					jobId: "j1",
					runId: "j1",
					event: { type: "agent_settled", sessionId: "s1" },
				}),
			});
		});
		expect(result.current.state.status).toBe("idle");
		expect(result.current.state.runId).toBeNull();

		act(() => {
			emit({ type: "agent_start", sessionId: "s1", runId: "j1" });
		});
		expect(result.current.state.status).toBe("idle");

		await act(async () => {
			await result.current.actions.send({ prompt: "second" });
		});
		expect(result.current.state.runId).toBe("j2");
	});

	it("旧 Session 的 abort 完成不覆盖新 Session 状态", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const abortRequest = deferred<unknown>();
		(pi.agent.open as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				snapshot: {
				sessionId: "s1",
				status: "available",
				activeRun: null,
				executionModeOverride: null,
				effectiveExecutionMode: "supervised",
				executionModeNeedsConfirmation: false,
				ownerName: "User",
				isOwner: true,
				},
				agentState: {
					status: "idle",
					streaming: false,
					prompting: false,
					compacting: false,
					thinkingLevel: "off",
					model: { provider: "p", modelId: "m1" },
					queuedMessages: { steering: [], followUp: [] },
				},
			})
			.mockResolvedValue({
				snapshot: {
				sessionId: "s1",
				status: "available",
				activeRun: {
					runId: "j2",
					sessionId: "s1",
					status: "running",
					kind: "prompt",
					executionMode: "supervised",
					actorName: "User",
					source: "web",
					createdAt: "2026-10-08T00:00:00.000Z",
					acceptedAt: "2026-10-08T00:00:01.000Z",
					startedAt: "2026-10-08T00:00:01.000Z",
					finishedAt: null,
					errorCode: null,
				},
				executionModeOverride: null,
				effectiveExecutionMode: "supervised",
				executionModeNeedsConfirmation: false,
				ownerName: "User",
				isOwner: true,
				},
				agentState: {
					status: "running",
					streaming: true,
					prompting: true,
					compacting: false,
					thinkingLevel: "off",
					model: { provider: "p", modelId: "m1" },
					queuedMessages: { steering: [], followUp: [] },
				},
			});
		(pi.agent.abort as ReturnType<typeof vi.fn>).mockImplementation(
			() => abortRequest.promise,
		);
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
			await result.current.actions.send({ prompt: "first" });
		});
		const abortPromise = result.current.actions.abort();
		await act(async () => {
			await result.current.actions.openSession("c1", "s2", CWD);
		});
		abortRequest.resolve({});
		await act(async () => {
			await abortPromise;
		});

		expect(result.current.state.status).toBe("running");
	});

	it("打开仍在运行的 Session 绑定活动 runId", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "j-active",
				sessionId: "s1",
				status: "running",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "User",
			isOwner: true,
			},
			agentState: {
				status: "running",
				streaming: true,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.openSession("c1", "s1", CWD);
			await result.current.actions.abort();
		});

		expect(pi.agent.abort).toHaveBeenCalledWith("c1", "s1", "j-active");
	});

	it("打开仍在运行的 Session 采用权威 agent state", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
			snapshot: {
			sessionId: "s1",
			status: "available",
			activeRun: {
				runId: "j-active",
				sessionId: "s1",
				status: "running",
				kind: "prompt",
				executionMode: "supervised",
				actorName: "User",
				source: "web",
				createdAt: "2026-10-08T00:00:00.000Z",
				acceptedAt: "2026-10-08T00:00:01.000Z",
				startedAt: "2026-10-08T00:00:01.000Z",
				finishedAt: null,
				errorCode: null,
			},
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "User",
			isOwner: true,
			},
			agentState: {
				status: "running",
				streaming: true,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.openSession("c1", "s1", CWD);
		});

		expect(result.current.state.status).toBe("running");
	});

	it("旧 /open 结果不覆盖新 Session", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const firstOpenResult = deferred<unknown>();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockImplementation(
			(_clientId: string, sessionId: string) =>
				sessionId === "a"
					? firstOpenResult.promise
					: Promise.resolve({
							snapshot: {
							sessionId: "b",
							status: "available",
							activeRun: null,
							executionModeOverride: null,
							effectiveExecutionMode: "supervised",
							executionModeNeedsConfirmation: false,
							ownerName: "User",
							isOwner: true,
							},
							agentState: {
								status: "idle",
								streaming: false,
								prompting: false,
								compacting: false,
								thinkingLevel: "off",
								model: { provider: "p", modelId: "m1" },
								queuedMessages: { steering: [], followUp: [] },
							},
						}),
		);
		const { result } = renderHook(() => usePiSession(pi));

		const firstOpen = result.current.actions.openSession("c1", "a", CWD);
		await waitFor(() => expect(pi.agent.open).toHaveBeenCalledTimes(1));
		await act(async () => result.current.actions.openSession("c1", "b", CWD));
		firstOpenResult.resolve({
			snapshot: {
			sessionId: "a",
			status: "available",
			activeRun: null,
			executionModeOverride: null,
			effectiveExecutionMode: "supervised",
			executionModeNeedsConfirmation: false,
			ownerName: "User",
			isOwner: true,
			},
			agentState: {
				status: "idle",
				streaming: false,
				prompting: false,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		await act(async () => firstOpen);

		expect(result.current.state.snapshot?.sessionId).toBe("b");
		expect(result.current.state.status).toBe("idle");
	});

	it("快速切换 Session 时旧请求结果不覆盖新 Session", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const firstContext = deferred<unknown>();
		const secondContext = deferred<unknown>();
		(pi.sessions.context as ReturnType<typeof vi.fn>).mockImplementation(
			(_clientId: string, sessionId: string) =>
				sessionId === "a" ? firstContext.promise : secondContext.promise,
		);
		const { result } = renderHook(() => usePiSession(pi));

		const firstOpen = result.current.actions.openSession("c1", "a", CWD);
		await waitFor(() => expect(pi.sessions.context).toHaveBeenCalledTimes(1));

		const secondOpen = result.current.actions.openSession("c1", "b", CWD);
		await waitFor(() => expect(pi.sessions.context).toHaveBeenCalledTimes(2));
		await act(async () => {
			secondContext.resolve({
				messages: [{ id: "b", role: "user", content: [] }],
				nextCursor: null,
			});
			await secondOpen;
		});
		firstContext.resolve({
			messages: [{ id: "a", role: "user", content: [] }],
			nextCursor: null,
		});
		await act(async () => {
			await firstOpen;
		});

		expect(result.current.state.messages).toEqual([
			{ id: "b", role: "user", content: [] },
		]);
	});

	it("旧 SSE 流事件不污染新 Session", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.openSession("c1", "a", CWD);
		});
		const oldStream = MockEventSource.instances[0];
		await act(async () => {
			await result.current.actions.openSession("c1", "b", CWD);
		});
		oldStream.onmessage?.({
			data: JSON.stringify({ type: "agent_start", sessionId: "a" }),
		});

		expect(result.current.state.status).toBe("idle");
	});

	it("打开 Session 加载模型并显示当前 thinking level", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.openSession("c1", "s1", CWD);
		});

		expect(result.current.state.models).toEqual([
			{ provider: "p", modelId: "m1" },
			{ provider: "p", modelId: "m2" },
		]);
		expect(result.current.state.agentState?.thinkingLevel).toBe("off");
		expect(result.current.state.thinkingSelection).toBe("off");
	});

	it("切换模型和 thinking level，auto 不发送 setThinking", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));

		await act(async () => result.current.actions.setModel("p", "m2"));
		await act(async () => result.current.actions.setThinking("high"));
		await act(async () => result.current.actions.setThinking("auto"));

		expect(pi.agent.setModel).toHaveBeenCalledWith("c1", "s1", CWD, "p", "m2");
		expect(pi.agent.setThinking).toHaveBeenCalledTimes(1);
		expect(pi.agent.setThinking).toHaveBeenCalledWith("c1", "s1", CWD, "high");
		expect(result.current.state.thinkingSelection).toBe("auto");
	});

	it("agentState 陈旧(无活跃 Run)时切换模型仍发送请求", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			snapshot: {
				sessionId: "s1",
				status: "available",
				activeRun: null,
				executionModeOverride: null,
				effectiveExecutionMode: "supervised",
				executionModeNeedsConfirmation: false,
				ownerName: "User",
				isOwner: true,
			},
			// 陈旧的 agentState：SDK 状态仍是 running，但 Job 权威为 idle。
			agentState: {
				status: "running",
				streaming: true,
				prompting: true,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			},
		});
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));

		await act(async () => result.current.actions.setModel("p", "m2"));
		expect(pi.agent.setModel).toHaveBeenCalledWith("c1", "s1", CWD, "p", "m2");
	});

	it("切换失败保留旧选择并显示错误", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.setModel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("busy"),
		);
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));

		await act(async () => {
			await expect(result.current.actions.setModel("p", "m2")).rejects.toThrow(
				"busy",
			);
		});
		expect(result.current.state.agentState?.model).toEqual({
			provider: "p",
			modelId: "m1",
		});
		expect(result.current.state.error).toBe("busy");
	});

	it("运行中不调用模型或 thinking 切换", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));
		act(() => emit({ type: "agent_start", sessionId: "s1" }));

		await act(async () => result.current.actions.setModel("p", "m2"));
		await act(async () => result.current.actions.setThinking("high"));

		expect(pi.agent.setModel).not.toHaveBeenCalled();
		expect(pi.agent.setThinking).not.toHaveBeenCalled();
	});

	it("notify 扩展事件不显示交互弹框", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "hi" });
		});
		act(() => {
			emit({
				type: "extension_request",
				sessionId: "s1",
				runId: "j1",
				ui: {
					requestId: "u-notify",
					extensionId: "e",
					kind: "notify",
					message: "info: Agent finished its current task.",
				},
			});
		});

		expect(result.current.state.pendingExtension).toBeNull();
		expect(result.current.state.status).toBe("running");
	});

	it("send 前未打开会话时报错", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.send({ prompt: "hi" });
		});
		expect(result.current.state.error).toBe("尚未打开会话");
	});

	it("prompt 失败保留空 Session 并可重试", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("delivery failed"),
		);
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "hi" });
		});
		expect(result.current.state.error).toBe("delivery failed");
		expect(result.current.state.status).toBe("idle");

		// 可重试
		await act(async () => {
			await result.current.actions.send({ prompt: "again" });
		});
		expect(result.current.state.runId).toBe("j1");
	});

	it("settlement grace 中可以立即发送下一条", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.prompt as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ jobId: "s1", runId: "j1", sessionId: "s1" })
			.mockResolvedValueOnce({ jobId: "s1", runId: "j2", sessionId: "s1" });
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.createSession("c1", CWD));
		await act(async () => result.current.actions.send({ prompt: "first" }));
		act(() => emit({ type: "prompt_done", sessionId: "s1", runId: "j1" }));
		await act(async () => result.current.actions.send({ prompt: "second" }));
		expect(pi.agent.prompt).toHaveBeenCalledTimes(2);
		expect(result.current.state.runId).toBe("j2");
	});

	it("extension_request 进入 waiting_input，回答后恢复 running", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "hi" });
		});

		act(() => {
			emit({
				type: "extension_request",
				sessionId: "s1",
				runId: "j1",
				ui: {
					requestId: "u1",
					extensionId: "e",
					kind: "confirm",
					message: "trust?",
				},
			});
		});
		expect(result.current.state.status).toBe("waiting_input");
		expect(result.current.state.pendingExtension?.requestId).toBe("u1");

		await act(async () => {
			await result.current.actions.extensionResponse("u1", undefined, true);
		});
		expect(pi.agent.extensionResponse).toHaveBeenCalledWith(
			"c1",
			"s1",
			"j1",
			expect.objectContaining({ requestId: "u1", confirmed: true }),
		);
		await waitFor(() => expect(result.current.state.status).toBe("running"));
	});

	it("旧 Extension 响应完成后保留期间收到的新弹框", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const response = deferred<unknown>();
		(pi.agent.extensionResponse as ReturnType<typeof vi.fn>).mockImplementation(
			() => response.promise,
		);
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.createSession("c1", CWD));
		await act(async () => result.current.actions.send({ prompt: "hi" }));
		act(() =>
			emit({
				type: "extension_request",
				sessionId: "s1",
				runId: "j1",
				ui: {
					requestId: "u1",
					extensionId: "e",
					kind: "input",
					message: "first",
				},
			}),
		);

		const firstResponse = result.current.actions.extensionResponse(
			"u1",
			"answer",
		);
		await waitFor(() =>
			expect(pi.agent.extensionResponse).toHaveBeenCalledOnce(),
		);
		act(() =>
			emit({
				type: "extension_request",
				sessionId: "s1",
				runId: "j1",
				ui: {
					requestId: "u2",
					extensionId: "e",
					kind: "confirm",
					message: "second",
				},
			}),
		);
		response.resolve({});
		await act(async () => firstResponse);

		expect(result.current.state.pendingExtension?.requestId).toBe("u2");
		expect(result.current.state.status).toBe("waiting_input");
	});

	it("extensionResponse cancelled:true 转发 cancelled 参数", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "hi" });
		});
		act(() => {
			emit({
				type: "extension_request",
				sessionId: "s1",
				runId: "j1",
				ui: {
					requestId: "u1",
					extensionId: "e",
					kind: "input",
					message: "name?",
				},
			});
		});

		await act(async () => {
			await result.current.actions.extensionResponse(
				"u1",
				undefined,
				undefined,
				true,
			);
		});
		expect(pi.agent.extensionResponse).toHaveBeenCalledWith(
			"c1",
			"s1",
			"j1",
			expect.objectContaining({ requestId: "u1", cancelled: true }),
		);
		await waitFor(() => expect(result.current.state.status).toBe("running"));
	});

	it("loadMore 追加更早历史并更新游标", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const ctx = pi.sessions.context as ReturnType<typeof vi.fn>;
		ctx.mockResolvedValueOnce({
			messages: [
				{ id: "m2", role: "user", content: [] },
				{ id: "m3", role: "user", content: [] },
			],
			nextCursor: "m1",
		});
		ctx.mockResolvedValueOnce({
			messages: [{ id: "m1", role: "user", content: [] }],
			nextCursor: null,
		});
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));

		expect(result.current.state.messages.map((m) => m.id)).toEqual([
			"m2",
			"m3",
		]);
		expect(result.current.state.hasMore).toBe(true);

		await act(async () => result.current.actions.loadMore());

		expect(ctx).toHaveBeenLastCalledWith("c1", "s1", CWD, { cursor: "m1" });
		expect(result.current.state.messages.map((m) => m.id)).toEqual([
			"m1",
			"m2",
			"m3",
		]);
		expect(result.current.state.hasMore).toBe(false);
		expect(result.current.state.nextCursor).toBeNull();
	});

	it("loadMore 后对账不丢弃已加载的更早历史", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		const ctx = pi.sessions.context as ReturnType<typeof vi.fn>;
		ctx.mockResolvedValueOnce({
			messages: [
				{ id: "m2", role: "user", content: [] },
				{ id: "m3", role: "user", content: [] },
			],
			nextCursor: "m1",
		});
		ctx.mockResolvedValueOnce({
			messages: [{ id: "m1", role: "user", content: [] }],
			nextCursor: null,
		});
		// 对账：最新窗口出现新消息 m4
		ctx.mockResolvedValueOnce({
			messages: [
				{ id: "m2", role: "user", content: [] },
				{ id: "m3", role: "user", content: [] },
				{ id: "m4", role: "user", content: [] },
			],
			nextCursor: "m1",
		});
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));
		await act(async () => result.current.actions.loadMore());
		expect(result.current.state.hasMore).toBe(false);

		// agent_settled 触发 reloadHistory + refreshState
		await act(async () => {
			emit({ type: "agent_settled", sessionId: "s1" });
		});
		await waitFor(() => expect(ctx).toHaveBeenCalledTimes(3));

		// 已加载的更早历史保留，最新窗口更新为含 m4
		expect(result.current.state.messages.map((m) => m.id)).toEqual([
			"m1",
			"m2",
			"m3",
			"m4",
		]);
		// hasMore 不被对账重置回 true
		expect(result.current.state.hasMore).toBe(false);
	});

	describe("扩展命令与持续 UI 状态", () => {
		it("开流后拉取命令清单与 UI 快照", async () => {
			const pi = makePi();
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));

			await waitFor(() =>
				expect(pi.agent.commands).toHaveBeenCalledWith("c1", "s1", CWD),
			);
			await waitFor(() =>
				expect(pi.agent.extensionUi).toHaveBeenCalledWith("c1", "s1", CWD),
			);
			expect(result.current.state.commands?.commands[0]?.name).toBe("fixture_ok");
			expect(result.current.state.extensionUi?.runtimeRevision).toBe("rev-1");
		});

		it("同换代但 sequence 更旧的快照被拒绝，不回滚状态", async () => {
			const pi = makePi();
			const ui = pi.agent.extensionUi as ReturnType<typeof vi.fn>;
			ui.mockResolvedValue({
				runtimeInstanceId: "spec-1",
				runtimeRevision: "rev-1",
				sequence: 5,
				title: "新状态",
				statuses: [],
				widgets: [],
			});
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));
			await waitFor(() =>
				expect(result.current.state.extensionUi?.title).toBe("新状态"),
			);

			// 迟到的旧快照不得覆盖新状态（ADR-0040 决策 4）。
			ui.mockResolvedValue({
				runtimeInstanceId: "spec-1",
				runtimeRevision: "rev-1",
				sequence: 2,
				title: "旧状态",
				statuses: [],
				widgets: [],
			});
			await act(async () => {
				await result.current.actions.refreshExtensionUi();
			});
			expect(result.current.state.extensionUi?.title).toBe("新状态");
		});

		it("换代后的权威快照可以替换同换代旧值", async () => {
			const pi = makePi();
			const ui = pi.agent.extensionUi as ReturnType<typeof vi.fn>;
			ui.mockResolvedValue({
				runtimeInstanceId: "spec-1",
				runtimeRevision: "rev-1",
				sequence: 5,
				title: "旧换代",
				statuses: [],
				widgets: [],
			});
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));
			await waitFor(() =>
				expect(result.current.state.extensionUi?.title).toBe("旧换代"),
			);

			ui.mockResolvedValue({
				runtimeInstanceId: "spec-2",
				runtimeRevision: "rev-2",
				sequence: 0,
				title: "新换代",
				statuses: [],
				widgets: [],
			});
			await act(async () => {
				await result.current.actions.refreshExtensionUi();
			});
			expect(result.current.state.extensionUi?.title).toBe("新换代");
		});

		it("快照拉取失败不得用空值覆盖已有状态", async () => {
			const pi = makePi();
			const ui = pi.agent.extensionUi as ReturnType<typeof vi.fn>;
			ui.mockResolvedValue({
				runtimeInstanceId: "spec-1",
				runtimeRevision: "rev-1",
				sequence: 5,
				title: "保留",
				statuses: [],
				widgets: [],
			});
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));
			await waitFor(() =>
				expect(result.current.state.extensionUi?.title).toBe("保留"),
			);

			// 失败时绝不能用空快照覆写（否则重连抖动会让界面清空）。
			ui.mockRejectedValue(new Error("offline"));
			await act(async () => {
				await result.current.actions.refreshExtensionUi();
			});
			expect(result.current.state.extensionUi?.title).toBe("保留");
		});

		it("command() 走 executeCommand（不传 runId），绝不当作普通 Prompt 发出", async () => {
			const pi = makePi();
			(pi.agent.executeCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
				jobId: "s1",
				runId: "run-1",
				sessionId: "s1",
			});
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));

			await act(async () => {
				await result.current.actions.command("fixture_ok", "a b");
			});

			// Run 由 Server 接纳：前端不得自带 runId。
			expect(pi.agent.executeCommand).toHaveBeenCalledWith(
				"c1",
				"s1",
				CWD,
				expect.any(String),
				"fixture_ok",
				"a b",
			);
			expect(pi.agent.prompt).not.toHaveBeenCalled();
			// 接纳后绑定 run，后续事件才能对上。
			expect(result.current.state.runId).toBe("run-1");
		});

		it("command() 被拒时返回 rejected，调用方应保留草稿", async () => {
			const pi = makePi();
			(pi.agent.executeCommand as ReturnType<typeof vi.fn>).mockRejectedValue(
				Object.assign(new Error("Unknown Pi command"), {
					code: "PI_EXTENSION_COMMAND_NOT_FOUND",
				}),
			);
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));

			let outcome: PiSendResult | null = null;
			await act(async () => {
				outcome = await result.current.actions.command("nope", "");
			});

			expect(outcome).toBe("rejected");
			expect(pi.agent.prompt).not.toHaveBeenCalled();
			// 失败不得留下假 running。
			expect(result.current.state.status).toBe("idle");
			expect(result.current.state.error).toContain("Unknown Pi command");
		});

		it("运行中不执行斜杠命令", async () => {
			const pi = makePi();
			(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				snapshot: {
				sessionId: "s1",
				status: "available",
				activeRun: {
					runId: "run-1",
					sessionId: "s1",
					status: "running",
					kind: "prompt",
					executionMode: "supervised",
					actorName: "User",
					source: "web",
					createdAt: "2026-10-08T00:00:00.000Z",
					acceptedAt: "2026-10-08T00:00:01.000Z",
					startedAt: "2026-10-08T00:00:01.000Z",
					finishedAt: null,
					errorCode: null,
				},
				executionModeOverride: null,
				effectiveExecutionMode: "supervised",
				executionModeNeedsConfirmation: false,
				ownerName: "User",
				isOwner: true,
				},
				agentState: {
					status: "running",
					streaming: true,
					prompting: true,
					compacting: false,
					thinkingLevel: "off",
					model: { provider: "p", modelId: "m1" },
					queuedMessages: { steering: [], followUp: [] },
				},
			});
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));

			let outcome: PiSendResult | null = null;
			await act(async () => {
				outcome = await result.current.actions.command("fixture_ok", "");
			});

			expect(outcome).toBe("rejected");
			expect(pi.agent.executeCommand).not.toHaveBeenCalled();
		});

		it("reset 清空命令、UI 与待应用编辑填充", async () => {
			const pi = makePi();
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));
			await waitFor(() => expect(result.current.state.commands).not.toBeNull());

			act(() => result.current.actions.reset());

			expect(result.current.state.commands).toBeNull();
			expect(result.current.state.extensionUi).toBeNull();
			expect(result.current.state.editorRequest).toBeNull();
		});

		it("重连后重新拉取命令与 UI 快照（onConnected）", async () => {
			const pi = makePi();
			const ui = pi.agent.extensionUi as ReturnType<typeof vi.fn>;
			ui.mockResolvedValue({
				runtimeInstanceId: "spec-1",
				runtimeRevision: "rev-1",
				sequence: 0,
				title: null,
				statuses: [],
				widgets: [],
			});
			vi.stubGlobal("EventSource", MockEventSource);
			const { result } = renderHook(() => usePiSession(pi));
			await act(async () => result.current.actions.openSession("c1", "s1", CWD));
			const callsAfterOpen = ui.mock.calls.length;

			// 模拟 EventSource 自动重连：重新触发 onopen。
			await act(async () => {
				last().onopen?.();
			});
			await waitFor(() =>
				expect(ui.mock.calls.length).toBeGreaterThan(callsAfterOpen),
			);
			// 重连后同样拉命令清单。
			expect(
				(pi.agent.commands as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBeGreaterThan(0);
		});
	});
});
