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

const CWD = { rootDir: "D:\\", relativePath: "repo" };

function makePi() {
	return {
		sessions: {
			list: vi.fn(async () => ({ sessions: [] })),
			get: vi.fn(async () => ({ info: { id: "s1", name: "s" }, tree: [], activeLeafId: null })),
			context: vi.fn(async () => ({
				messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
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
		agent: {
			newSession: vi.fn(async () => ({ sessionId: "s1" })),
			state: vi.fn(async () => ({
				status: "idle",
				streaming: false,
				prompting: false,
				compacting: false,
				thinkingLevel: "off",
				model: { provider: "p", modelId: "m1" },
				queuedMessages: { steering: [], followUp: [] },
			})),

			prompt: vi.fn(async () => ({ jobId: "j1", runId: "j1", sessionId: "s1" })),
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
	} as unknown as Pick<PiApi, "sessions" | "agent" | "models">;
}

afterEach(() => {
	vi.unstubAllGlobals();
	MockEventSource.instances = [];
	vi.restoreAllMocks();
});

describe("usePiSession", () => {
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
			expect.objectContaining({ prompt: "hello", submissionId: expect.any(String) }),
		);
		expect(result.current.state.runId).toBe("j1");
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
			expect((pi.agent.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
		);

		// 捕获 submissionId 并注入 run_created
		const call = (pi.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as {
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

	it("切换失败保留旧选择并显示错误", async () => {
		vi.stubGlobal("EventSource", MockEventSource);
		const pi = makePi();
		(pi.agent.setModel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("busy"));
		const { result } = renderHook(() => usePiSession(pi));
		await act(async () => result.current.actions.openSession("c1", "s1", CWD));

		await act(async () => {
			await expect(result.current.actions.setModel("p", "m2")).rejects.toThrow("busy");
		});
		expect(result.current.state.agentState?.model).toEqual({ provider: "p", modelId: "m1" });
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
				ui: { requestId: "u1", extensionId: "e", kind: "confirm", message: "trust?" },
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
});
