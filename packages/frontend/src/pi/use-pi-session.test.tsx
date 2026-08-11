import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePiSession } from "./use-pi-session.js";
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
		running: vi.fn(async () => []),
		agent: {
			newSession: vi.fn(async () => ({ sessionId: "s1", jobId: "s1" })),
			open: vi.fn(async (_clientId: string, sessionId: string) => ({
				job: {
					jobId: sessionId,
					sessionId,
					status: "idle",
					runId: null,
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
			complete: vi.fn(async (_clientId: string, sessionId: string) => ({
				jobId: sessionId,
				sessionId,
				status: "done",
				runId: null,
				ownerName: "User",
				isOwner: true,
			})),
			prompt: vi.fn(async () => ({
				jobId: "s1",
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
			eventsPath: (clientId: string, sessionId: string) =>
				`/api/clients/${clientId}/pi/agent/${sessionId}/events`,
		},
	} as unknown as Pick<PiApi, "sessions" | "agent" | "models"> &
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
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "done",
				runId: null,
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
		expect(result.current.state.status).toBe("done");
		expect(result.current.state.job?.status).toBe("done");
	});

	it("恢复 matching pendingExtension 并按 requestId 关闭", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValue({
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "waiting_input",
				runId: "j1",
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
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "waiting_input",
				runId: "j1",
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
		expect(result.current.state.job?.status).toBe("waiting_input");
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
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "idle",
				runId: null,
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

	it("error Job 不能发送", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "error",
				runId: null,
				ownerName: "User",
				isOwner: true,
				errorCode: "PI_WORKER_EXITED",
				errorMessage: "worker exited",
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

	it("complete 使用当前 runId 并采用返回 Job", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "running",
				runId: "run-1",
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
		await act(async () => result.current.actions.complete());
		expect(pi.agent.complete).toHaveBeenCalledWith("c1", "s1", "run-1");
		expect(result.current.state.status).toBe("done");
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
		expect(result.current.state.job?.status).toBe("running");
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
				job: {
					jobId: "s1",
					sessionId: "s1",
					status: "idle",
					runId: null,
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
				job: {
					jobId: "s2",
					sessionId: "s2",
					status: "running",
					runId: "j2",
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
			job: {
				jobId: "s1",
				runId: "j-active",
				sessionId: "s1",
				status: "running",
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
			job: {
				jobId: "s1",
				runId: "j-active",
				sessionId: "s1",
				status: "running",
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
							job: {
								jobId: "b",
								sessionId: "b",
								status: "done",
								runId: null,
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
			job: {
				jobId: "a",
				sessionId: "a",
				status: "error",
				runId: null,
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

		expect(result.current.state.job?.sessionId).toBe("b");
		expect(result.current.state.status).toBe("done");
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

	it("agentState 陈旧（Job 已 idle）时切换模型仍发送请求", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.open as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			job: {
				jobId: "s1",
				sessionId: "s1",
				status: "idle",
				runId: null,
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
		expect(result.current.state.job?.status).toBe("waiting_input");
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
		expect(result.current.state.job?.status).toBe("running");
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
		expect(result.current.state.job?.status).toBe("waiting_input");
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
});
