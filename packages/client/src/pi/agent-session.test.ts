import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentSession,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { parsePiAgentState } from "@vcpdeck/shared";
import type { PiClientEvent, PiThinkingLevel } from "@vcpdeck/shared";
import { PiAgentSessionWrapperImpl } from "./agent-session.js";

type Listener = (event: AgentSessionEvent) => void;

class FakeInner {
	sessionId = "s1";
	sessionFile = "/tmp/sessions/s1.jsonl";
	isStreaming = false;
	isCompacting = false;
	thinkingLevel: PiThinkingLevel = "off";
	model: { provider: string; id: string } | undefined = {
		provider: "p",
		id: "m1",
	};
	modelRuntime = {
		getAvailable: vi.fn(async () => [{ provider: "p", id: "m1" }]),
		getModel: vi.fn((_provider: string, _modelId: string) => ({
			provider: "p",
			id: "m1",
		})),
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
		getCommand: (name: string) =>
			name === "fixture_ok" ? { invocationName: name } : undefined,
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

	/** 仅为 agent.command 路径：按注册名查询（未注册返回 undefined）。 */
	getCommand = vi.fn((name: string) =>
		name === "fixture_ok" ? { invocationName: name } : undefined,
	);

	/** 命令处理器返回后还要等权威空闲；本测试用可控 deferred 观察结算闸门。 */
	waitForIdleCalls = 0;
	private idleResolve: (() => void) | null = null;
	waitForIdle = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				this.waitForIdleCalls++;
				this.idleResolve = resolve;
			}),
	);

	resolveIdle(): void {
		this.idleResolve?.();
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
	const wrapper = new PiAgentSessionWrapperImpl(
		inner as unknown as AgentSession,
	);
	wrapper.start();
	return { inner, wrapper };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("agent.command（扩展命令）", () => {
it("未注册的调用名不触发任何 Prompt，返回稳定错误码", async () => {
const { inner, wrapper } = makeWrapper();

const result = (await wrapper.send("agent.command", {
name: "fixture_missing",
args: "",
})) as { ok: boolean; error?: { code: string } };

expect(result).toMatchObject({
ok: false,
error: { code: "PI_EXTENSION_COMMAND_NOT_FOUND" },
});
// 关键：不得回退为普通模型请求（真实 SDK 下那会变成缺凭据的模型调用）。
expect(inner.prompt).not.toHaveBeenCalled();
expect(wrapper.isRunning()).toBe(false);
});

it("已注册命令：waitForIdle 前不算完成，也不把 agent_settled 当终态", async () => {
const { inner, wrapper } = makeWrapper();
const events: string[] = [];
wrapper.onEvent((e) => events.push(e.type));

await wrapper.send("agent.command", { name: "fixture_ok", args: "a b" });
expect(inner.prompt).toHaveBeenCalledWith(
"/fixture_ok a b",
expect.objectContaining({ source: "rpc" }),
);
// 处理器仍在执行期间必须视为运行中（否则项目锁会被提前释放）。
expect(wrapper.isRunning()).toBe(true);

// 命令自己启动的 Agent 工作结束会发 agent_settled；
// 但命令尚未完成，不得据此对外宣称完成。
inner.resolvePrompt();
inner.emit({ type: "agent_settled" });
await Promise.resolve();
expect(events).not.toContain("prompt_done");
expect(wrapper.isRunning()).toBe(true);

inner.resolveIdle();
await Promise.resolve();
await Promise.resolve();
expect(events).toContain("prompt_done");
expect(wrapper.isRunning()).toBe(false);
});

it("命令抛错时发 prompt_error 并解除运行态", async () => {
const { inner, wrapper } = makeWrapper();
const events: string[] = [];
wrapper.onEvent((e) => events.push(e.type));

await wrapper.send("agent.command", { name: "fixture_ok", args: "" });
inner.rejectPrompt(new Error("handler failed"));
await Promise.resolve();
await Promise.resolve();

expect(events).toContain("prompt_error");
expect(wrapper.isRunning()).toBe(false);
});
});

describe("PiAgentSessionWrapperImpl", () => {
	it("prompt fire-and-forget：resolve 后发 prompt_done", async () => {
		const { inner, wrapper } = makeWrapper();
		const events: string[] = [];
		wrapper.onEvent((e) => events.push(e.type));

		await wrapper.send("agent.prompt", { prompt: "hi" });
		expect(inner.prompt).toHaveBeenCalledWith(
			"hi",
			expect.objectContaining({ source: "rpc" }),
		);
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
			confirm: (
				title: string,
				message: string,
				opts?: unknown,
			) => Promise<unknown>;
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

		const ui = inner.uiContext as {
			select: (title: string, options: string[]) => Promise<unknown>;
		};
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

	it("agent.state 暴露当前活动 Extension 摘要", () => {
		const { inner, wrapper } = makeWrapper();
		void (inner.uiContext!.confirm as Function)("确认", "继续吗？");
		expect(wrapper.getState().pendingExtension).toMatchObject({
			kind: "confirm",
			title: "确认",
			message: "继续吗？",
		});
	});

	it("回答后发出 answered 并清空状态", async () => {
		const { inner, wrapper } = makeWrapper();
		const events: PiClientEvent[] = [];
		wrapper.onEvent((event) => events.push(event));
		const promise = (inner.uiContext!.input as Function)("输入", "内容");
		const requestId = wrapper.getState().pendingExtension!.requestId;
		await wrapper.send("extension.respond", { requestId, value: "answer" });
		await expect(promise).resolves.toBe("answer");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "extension_resolved",
				requestId,
				reason: "answered",
				hasPending: false,
			}),
		);
		expect(wrapper.getState().pendingExtension).toBeUndefined();
	});

	it("pendingExtension 可通过 parsePiAgentState 严格校验（extensionId 非空）", async () => {
		const { inner, wrapper } = makeWrapper();
		await vi.waitFor(() => expect(inner.uiContext).not.toBeNull());
		void (inner.uiContext!.confirm as Function)("Trust?", "继续吗？");
		await vi.waitFor(() =>
			expect(wrapper.getState().pendingExtension).toBeDefined(),
		);
		expect(() => parsePiAgentState(wrapper.getState())).not.toThrow();
		const requestId = wrapper.getState().pendingExtension!.requestId;
		await wrapper.send("extension.respond", { requestId, value: true });
		expect(wrapper.getState().pendingExtension).toBeUndefined();
	});

	it("超时发出 timeout", async () => {
		vi.useFakeTimers();
		const { inner, wrapper } = makeWrapper();
		const events: PiClientEvent[] = [];
		wrapper.onEvent((event) => events.push(event));
		const promise = (inner.uiContext!.input as Function)("输入", "内容", {
			timeout: 25,
		});
		await vi.advanceTimersByTimeAsync(25);
		await expect(promise).resolves.toBeUndefined();
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "extension_resolved",
				reason: "timeout",
				hasPending: false,
			}),
		);
	});

	it("并发请求串行展示，解决一个后仍保持 pending", async () => {
		const { inner, wrapper } = makeWrapper();
		const events: PiClientEvent[] = [];
		wrapper.onEvent((event) => events.push(event));
		const first = (inner.uiContext!.confirm as Function)("第一项", "A");
		const second = (inner.uiContext!.input as Function)("第二项", "B");
		const firstId = wrapper.getState().pendingExtension!.requestId;
		await wrapper.send("extension.respond", {
			requestId: firstId,
			confirmed: true,
		});
		await expect(first).resolves.toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "extension_resolved",
				requestId: firstId,
				hasPending: true,
			}),
		);
		expect(wrapper.getState().pendingExtension).toMatchObject({
			title: "第二项",
		});
		expect(second).toBeInstanceOf(Promise);
	});

	it("abort 只关闭已展示请求并清除排队请求", async () => {
		const { inner, wrapper } = makeWrapper();
		const events: PiClientEvent[] = [];
		wrapper.onEvent((event) => events.push(event));
		void (inner.uiContext!.confirm as Function)("第一项", "A");
		void (inner.uiContext!.input as Function)("第二项", "B");
		const displayedId = wrapper.getState().pendingExtension!.requestId;
		await wrapper.send("agent.abort");
		expect(inner.abort).toHaveBeenCalledOnce();
		expect(
			events.filter((event) => event.type === "extension_resolved"),
		).toEqual([
			expect.objectContaining({
				requestId: displayedId,
				reason: "cancelled",
				hasPending: false,
			}),
		]);
		expect(wrapper.getState().pendingExtension).toBeUndefined();
		expect(wrapper.getState().status).toBe("idle");
	});

	it("abort 等待 streaming 停止，5 秒后返回 PI_REQUEST_TIMEOUT", async () => {
		vi.useFakeTimers();
		const { inner, wrapper } = makeWrapper();
		inner.isStreaming = true;

		const result = expect(wrapper.send("agent.abort")).rejects.toMatchObject({
			code: "PI_REQUEST_TIMEOUT",
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await result;
	});

	it("abort 等待期间 streaming 收敛则成功", async () => {
		vi.useFakeTimers();
		const { inner, wrapper } = makeWrapper();
		inner.isStreaming = true;

		const result = wrapper.send("agent.abort");
		await vi.advanceTimersByTimeAsync(4_975);
		inner.isStreaming = false;
		await vi.advanceTimersByTimeAsync(25);
		await expect(result).resolves.toBeNull();
	});

	it("abort 首次失败仍取消 pending UI，第二次会重试底层 abort", async () => {
		const { inner, wrapper } = makeWrapper();
		const trust = (inner.uiContext!.confirm as Function)(
			"Project Trust",
			"信任？",
		);
		inner.abort.mockRejectedValueOnce(new Error("abort failed"));

		await expect(wrapper.send("agent.abort")).rejects.toThrow("abort failed");
		await expect(trust).resolves.toBe(false);
		expect(wrapper.getState().pendingExtension).toBeUndefined();

		await expect(wrapper.send("agent.abort")).resolves.toBeNull();
		expect(inner.abort).toHaveBeenCalledTimes(2);
	});

	it("destroy 只为活动请求发一次 cancelled，排队请求静默解决", async () => {
		const { inner, wrapper } = makeWrapper();
		const events: PiClientEvent[] = [];
		wrapper.onEvent((event) => events.push(event));
		const active = (inner.uiContext!.confirm as Function)("第一项", "A");
		const queued = (inner.uiContext!.input as Function)("第二项", "B");
		const activeId = wrapper.getState().pendingExtension!.requestId;

		wrapper.destroy();

		await expect(active).resolves.toBe(false);
		await expect(queued).resolves.toBeUndefined();
		expect(
			events.filter((event) => event.type === "extension_resolved"),
		).toEqual([
			expect.objectContaining({
				requestId: activeId,
				reason: "cancelled",
				hasPending: false,
			}),
		]);
		expect(
			events.filter((event) => event.type === "extension_request"),
		).toHaveLength(1);
	});

	it("answered 后重复响应不重复发 extension_resolved", async () => {
		const { inner, wrapper } = makeWrapper();
		const events: PiClientEvent[] = [];
		wrapper.onEvent((event) => events.push(event));
		const answer = (inner.uiContext!.input as Function)("输入", "内容");
		const requestId = wrapper.getState().pendingExtension!.requestId;

		await wrapper.send("extension.respond", { requestId, value: "first" });
		await wrapper.send("extension.respond", { requestId, value: "second" });

		await expect(answer).resolves.toBe("first");
		expect(
			events.filter(
				(event) =>
					event.type === "extension_resolved" && event.requestId === requestId,
			),
		).toHaveLength(1);
	});

	it("model.set 不在交集返回 PI_MODEL_NOT_FOUND", async () => {
		const { wrapper } = makeWrapper();
		const result = await wrapper.send("model.set", {
			provider: "x",
			modelId: "nope",
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "PI_MODEL_NOT_FOUND" },
		});
	});

	it("agent.state 返回当前 thinking level", () => {
		const { inner, wrapper } = makeWrapper();
		inner.thinkingLevel = "high";
		expect(wrapper.getState().thinkingLevel).toBe("high");
	});

	it("thinking.set 校验原生 level 后调用 SDK", async () => {
		const { inner, wrapper } = makeWrapper();
		await wrapper.send("thinking.set", { level: "high" });
		expect(inner.setThinkingLevel).toHaveBeenCalledWith("high");
		const result = await wrapper.send("thinking.set", { level: "auto" });
		expect(result).toMatchObject({
			ok: false,
			error: { code: "PI_PROTOCOL_INVALID" },
		});
		expect(inner.setThinkingLevel).toHaveBeenCalledTimes(1);
	});

	it("get_state 在等待 Extension input 时映射 waiting_for_extension_input", async () => {
		const { inner, wrapper } = makeWrapper();
		await vi.waitFor(() => expect(inner.uiContext).not.toBeNull());
		const ui = inner.uiContext as {
			input: (title: string) => Promise<unknown>;
		};
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
