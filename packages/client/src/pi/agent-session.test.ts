import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiAgentSessionWrapperImpl } from "./agent-session.js";

type Listener = (event: AgentSessionEvent) => void;

class FakeInner {
	sessionId = "s1";
	sessionFile = "/tmp/sessions/s1.jsonl";
	isStreaming = false;
	isCompacting = false;
	model: { provider: string; id: string } | undefined = { provider: "p", id: "m1" };
	modelRuntime = {
		getAvailable: vi.fn(async () => [{ provider: "p", id: "m1" }]),
		getModel: vi.fn((_provider: string, _modelId: string) => ({ provider: "p", id: "m1" })),
	};
	sessionManager = {
		getCwd: () => "/tmp/project",
		getSessionDir: () => "/tmp/sessions",
		isPersisted: () => true,
		getSessionFile: () => "/tmp/sessions/s1.jsonl",
		getEntry: () => null,
		getLeafId: () => "m1",
		createBranchedSession: vi.fn(() => undefined),
		newSession: vi.fn(),
	};
	settingsManager = { getEnabledModels: () => undefined };
	agent = { state: { thinkingLevel: "off" } };
	promptTemplates: unknown[] = [];
	resourceLoader = { getSkills: () => ({ skills: [] }) };
	extensionRunner = {
		getRegisteredCommands: () => [],
		setUIContext: vi.fn((ctx: unknown) => {
			this.uiContext = ctx as Record<string, unknown>;
		}),
		emit: vi.fn(async () => {}),
	};
	uiContext: Record<string, unknown> | null = null;
	dispose = vi.fn();
	private listener: Listener | null = null;
	private promptResolve: (() => void) | null = null;
	private promptReject: ((err: Error) => void) | null = null;
	promptCalls = 0;

	prompt = vi.fn(
		() =>
			new Promise<void>((resolve, reject) => {
				this.promptCalls++;
				this.promptResolve = resolve;
				this.promptReject = reject;
			}),
	);
	abort = vi.fn(async () => {});
	steer = vi.fn(async () => {});
	followUp = vi.fn(async () => {});
	compact = vi.fn(async () => ({}));
	abortCompaction = vi.fn();
	setThinkingLevel = vi.fn();
	setModel = vi.fn(async () => {});
	setSessionName = vi.fn();
	navigateTree = vi.fn(async () => ({ cancelled: false }));
	getSessionStats = vi.fn(() => ({ totalMessages: 2 }));
	getSteeringMessages = () => [];
	getFollowUpMessages = () => [];
	getContextUsage = () => undefined;
	pendingMessageCount = 0;

	subscribe = (listener: Listener) => {
		this.listener = listener;
		return () => {
			this.listener = null;
		};
	};

	emit(event: AgentSessionEvent): void {
		this.listener?.(event);
	}

	resolvePrompt(): void {
		this.promptResolve?.();
	}

	rejectPrompt(err: Error): void {
		this.promptReject?.(err);
	}
}

function makeWrapper() {
	const inner = new FakeInner();
	const wrapper = new PiAgentSessionWrapperImpl(inner as unknown as AgentSession);
	wrapper.start();
	return { inner, wrapper };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("PiAgentSessionWrapperImpl", () => {
	it("prompt fire-and-forget：resolve 后发 prompt_done", async () => {
		const { inner, wrapper } = makeWrapper();
		const events: string[] = [];
		wrapper.onEvent((e) => events.push(e.type));

		await wrapper.send("agent.prompt", { prompt: "hi" });
		expect(inner.prompt).toHaveBeenCalledWith("hi", expect.objectContaining({ source: "rpc" }));
		inner.resolvePrompt();
		await Promise.resolve();
		expect(events).toContain("prompt_done");
		expect(wrapper.isRunning()).toBe(false);
	});

	it("prompt 失败发 prompt_error", async () => {
		const { inner, wrapper } = makeWrapper();
		const events: string[] = [];
		wrapper.onEvent((e) => events.push(e.type));

		await wrapper.send("agent.prompt", { prompt: "boom" });
		inner.rejectPrompt(new Error("provider down"));
		await vi.waitFor(() => expect(events).toContain("prompt_error"));
	});

	it("agent_end 只是阶段事件，不销毁 wrapper", () => {
		const { inner, wrapper } = makeWrapper();
		const events: string[] = [];
		wrapper.onEvent((e) => events.push(e.type));

		inner.emit({ type: "agent_end" } as AgentSessionEvent);
		expect(events).toContain("agent_end");
		expect(wrapper.isAlive()).toBe(true);
	});

	it("Extension confirm：事件转发 + Owner 响应解决", async () => {
		const { inner, wrapper } = makeWrapper();
		await vi.waitFor(() => expect(inner.uiContext).not.toBeNull());
		const events: unknown[] = [];
		wrapper.onEvent((e) => events.push(e));

		const ui = inner.uiContext as {
			confirm: (title: string, message: string, opts?: unknown) => Promise<unknown>;
		};
		const promise = ui.confirm("Trust?", "Load extensions?");
		await Promise.resolve();

		const req = events.find(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				(e as { type: string }).type === "extension_request",
		) as { ui?: { requestId: string; kind: string } };
		expect(req?.ui?.kind).toBe("confirm");

		await wrapper.send("extension.respond", {
			requestId: req?.ui?.requestId,
			confirmed: true,
		});
		await expect(promise).resolves.toBe(true);
	});

	it("Extension dialog 缺省 30 分钟 timeout 写入事件", async () => {
		const { inner, wrapper } = makeWrapper();
		await vi.waitFor(() => expect(inner.uiContext).not.toBeNull());
		const events: unknown[] = [];
		wrapper.onEvent((e) => events.push(e));

		const ui = inner.uiContext as { select: (title: string, options: string[]) => Promise<unknown> };
		void ui.select("Pick", ["a", "b"]);
		await Promise.resolve();

		const req = events.find(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				(e as { type: string }).type === "extension_request",
		) as { ui?: { kind: string; timeoutMs: number } };
		expect(req?.ui?.kind).toBe("select");
		expect(req?.ui?.timeoutMs).toBe(30 * 60 * 1000);
	});

	it("custom() 返回 undefined 并发 warning notify", async () => {
		const { inner, wrapper } = makeWrapper();
		await vi.waitFor(() => expect(inner.uiContext).not.toBeNull());
		const events: unknown[] = [];
		wrapper.onEvent((e) => events.push(e));

		const ui = inner.uiContext as { custom: () => Promise<unknown> };
		await expect(ui.custom()).resolves.toBeUndefined();

		const req = events.find(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				(e as { type: string }).type === "extension_request",
		) as { ui?: { kind: string } };
		expect(req?.ui?.kind).toBe("notify");
	});

	it("model.set 不在交集返回 PI_MODEL_NOT_FOUND", async () => {
		const { wrapper } = makeWrapper();
		const result = await wrapper.send("model.set", { provider: "x", modelId: "nope" });
		expect(result).toMatchObject({ ok: false, error: { code: "PI_MODEL_NOT_FOUND" } });
	});

	it("get_state 在等待 Extension input 时映射 waiting_for_extension_input", async () => {
		const { inner, wrapper } = makeWrapper();
		await vi.waitFor(() => expect(inner.uiContext).not.toBeNull());
		const ui = inner.uiContext as { input: (title: string) => Promise<unknown> };
		void ui.input("Name?");
		await Promise.resolve();

		const state = wrapper.getState();
		expect(state.status).toBe("waiting_for_extension_input");
		expect(state.waitingForExtensionInput).toBe(true);
	});

	it("compact 调用 inner.compact", async () => {
		const { inner, wrapper } = makeWrapper();
		await wrapper.send("agent.compact", { customInstructions: "summarize" });
		expect(inner.compact).toHaveBeenCalledWith("summarize");
	});

	it("shutdown 先发 session_shutdown 再 dispose", async () => {
		const { inner, wrapper } = makeWrapper();
		await wrapper.shutdown();
		expect(inner.extensionRunner.emit).toHaveBeenCalledWith({
			type: "session_shutdown",
			reason: "quit",
		});
		expect(inner.dispose).toHaveBeenCalled();
		expect(wrapper.isAlive()).toBe(false);
	});

	it("空闲 10 分钟优雅关闭", async () => {
		vi.useFakeTimers();
		const { inner, wrapper } = makeWrapper();
		vi.advanceTimersByTime(10 * 60 * 1000 + 100);
		await vi.waitFor(() => expect(wrapper.isAlive()).toBe(false));
		expect(inner.dispose).toHaveBeenCalled();
	});
});
