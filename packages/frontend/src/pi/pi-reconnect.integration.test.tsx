import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePiSession } from "./use-pi-session.js";
import type { PiApi } from "@vcpdeck/sdk";

/** 可手动控制连接状态的 EventSource（重连场景） */
class ReconnectEventSource {
	static instances: ReconnectEventSource[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	readyState = ReconnectEventSource.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(
		public url: string,
		public options?: unknown,
	) {
		ReconnectEventSource.instances.push(this);
		// 模拟真实连接成功（异步 open）；断线场景用 fail() 手动触发
		queueMicrotask(() => {
			if (this.closed) return;
			this.readyState = ReconnectEventSource.OPEN;
			this.onopen?.();
		});
	}
	close() {
		this.closed = true;
		this.readyState = ReconnectEventSource.CLOSED;
	}
	open() {
		this.readyState = ReconnectEventSource.OPEN;
		this.onopen?.();
	}
	fail() {
		this.readyState = ReconnectEventSource.CLOSED;
		this.onerror?.();
	}
}

function last(): ReconnectEventSource {
	return ReconnectEventSource.instances.at(-1)!;
}

function emit(data: unknown): void {
	last().onmessage?.({ data: JSON.stringify(data) });
}

const CWD = { rootDir: "D:\\", relativePath: "repo" };

function makePi() {
	return {
		sessions: {
			list: vi.fn(async () => ({ sessions: [] })),
			get: vi.fn(async () => ({ info: { id: "s1", name: "s", firstMessage: "hi" }, tree: [], activeLeafId: null })),
			context: vi.fn(async () => ({
				messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
				nextCursor: null,
			})),
			entryContent: vi.fn(),
			rename: vi.fn(),
			delete: vi.fn(),
			fork: vi.fn(),
			clone: vi.fn(),
			navigate: vi.fn(),
		},
		models: vi.fn(async () => [{ provider: "p", modelId: "m1" }]),
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
			steer: vi.fn(),
			followUp: vi.fn(),
			abort: vi.fn(),
			compact: vi.fn(),
			abortCompact: vi.fn(),
			setModel: vi.fn(),
			setThinking: vi.fn(),
			extensionResponse: vi.fn(),
			eventsPath: (clientId: string, sessionId: string) =>
				`/api/clients/${clientId}/pi/agent/${sessionId}/events`,
		},
	} as unknown as Pick<PiApi, "sessions" | "agent" | "models">;
}

afterEach(() => {
	vi.unstubAllGlobals();
	ReconnectEventSource.instances = [];
	vi.restoreAllMocks();
});

describe("usePiSession 重连集成", () => {
	it("SSE 断线（onFatal）后状态降级，重新 open 恢复", async () => {
		vi.stubGlobal("EventSource", ReconnectEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});

		// 连接失败 → 状态 idle + 错误提示
		act(() => {
			last().fail();
		});
		expect(result.current.state.status).toBe("idle");
		expect(result.current.state.error).toContain("连接已断开");

		// 重新 openSession 恢复（模拟用户重试）
		await act(async () => {
			await result.current.actions.openSession("c1", "s1", CWD);
		});
		expect(result.current.state.status).toBe("idle");
		expect(result.current.state.error).toBeNull();
	});

	it("断线后重新 prompt 走完整两阶段", async () => {
		vi.stubGlobal("EventSource", ReconnectEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		act(() => {
			last().fail();
		});

		// 重连 + prompt
		await act(async () => {
			await result.current.actions.openSession("c1", "s1", CWD);
		});
		await act(async () => {
			await result.current.actions.send({ prompt: "retry" });
		});
		expect(pi.agent.prompt).toHaveBeenCalledTimes(1);
		expect(result.current.state.runId).toBe("j1");
	});

	it("Extension waiting 与 Owner 回答恢复（端到端）", async () => {
		vi.stubGlobal("EventSource", ReconnectEventSource);
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
				ui: { requestId: "u1", extensionId: "e", kind: "input", message: "name?" },
			});
		});
		expect(result.current.state.status).toBe("waiting_input");

		await act(async () => {
			await result.current.actions.extensionResponse("u1", "my-name");
		});
		expect(pi.agent.extensionResponse).toHaveBeenCalledWith(
			"c1",
			"s1",
			"j1",
			expect.objectContaining({ requestId: "u1", value: "my-name" }),
		);
		await waitFor(() => expect(result.current.state.status).toBe("running"));
	});

	it("branch navigation 通过 sessions.navigate 转发", async () => {
		vi.stubGlobal("EventSource", ReconnectEventSource);
		const pi = makePi();
		const { result } = renderHook(() => usePiSession(pi));

		await act(async () => {
			await result.current.actions.createSession("c1", CWD);
		});
		await act(async () => {
			await result.current.actions.navigate("branch-1");
		});
		expect(pi.sessions.navigate).toHaveBeenCalledWith("c1", "s1", CWD, "branch-1");
	});
});
